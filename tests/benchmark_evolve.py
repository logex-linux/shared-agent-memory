#!/usr/bin/env python3
"""Run real-log replay against beta7 on a disposable production DB snapshot."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict, deque
from datetime import datetime, timezone
from difflib import SequenceMatcher
import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import tempfile
import threading
import time
from typing import Any

from evolve_common import (DEFAULT_CONFIG, DEFAULT_OUTPUT, distribution, estimated_tokens,
                           file_fingerprint, load_config, read_snapshot,
                           sha256, snapshot_database, write_report)


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--cases", default=str(DEFAULT_OUTPUT / "replay-cases-reviewed.json"))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT / "baseline-beta7.json"))
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--warmup", type=int, default=1)
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--detail", choices=("full", "compact"), default=None)
    parser.add_argument("--skip-build", action="store_true")
    parser.add_argument("--keep-snapshot", action="store_true")
    return parser.parse_args()


def resolve_node_binary(config: dict[str, Any], config_path: str | os.PathLike[str]) -> str:
    env_node = os.environ.get("SAM_NODE_BINARY")
    if env_node and Path(env_node).is_file():
        return env_node
    manifest_candidates = [config.get("installation_manifest"), str(Path(config_path).expanduser().resolve().with_name("installation.json"))]
    for candidate in manifest_candidates:
        if not candidate:
            continue
        path = Path(candidate)
        if path.is_file():
            try:
                node_path = json.loads(path.read_text(encoding="utf-8")).get("node")
                if node_path and Path(node_path).is_file():
                    return node_path
            except (OSError, json.JSONDecodeError):
                pass
    return shutil.which("node") or "node"


class McpClient:
    """Minimal newline JSON-RPC client; avoids adding a Python MCP dependency."""
    def __init__(self, config: Path, cwd: Path, node_binary: str = "node"):
        env = dict(os.environ, SHARED_MEMORY_CONFIG=str(config))
        self.process = subprocess.Popen([node_binary, "dist/mcp/server.js"], cwd=cwd, env=env,
                                        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, text=True, bufsize=1)
        self.errors = deque(maxlen=100)
        self.stderr_thread = threading.Thread(target=self._drain_stderr, daemon=True)
        self.stderr_thread.start()
        self.next_id = 0
        self.call("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                                 "clientInfo": {"name": "evolve-benchmark", "version": "1"}})
        self.process.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        self.process.stdin.flush()

    def _drain_stderr(self) -> None:
        for line in self.process.stderr:
            self.errors.append(line.rstrip())

    def call(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self.next_id += 1
        request_id = self.next_id
        message = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
        self.process.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
        self.process.stdin.flush()
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            ready, _, _ = select.select([self.process.stdout], [], [], max(0, deadline - time.monotonic()))
            if not ready:
                break
            line = self.process.stdout.readline()
            if not line:
                break
            response = json.loads(line)
            if response.get("id") == request_id:
                if "error" in response:
                    raise RuntimeError(response["error"])
                return response.get("result", {})
        details = " | ".join(self.errors)[-3000:]
        raise TimeoutError(f"MCP {method} timed out or exited (code={self.process.poll()}): {details}")

    def recall(self, request: dict[str, Any]) -> dict[str, Any]:
        result = self.call("tools/call", {"name": "memory_recall", "arguments": request})
        if result.get("isError"):
            text = next((entry.get("text", "") for entry in result.get("content", [])), "{}")
            raise RuntimeError(json.loads(text))
        for entry in result.get("content", []):
            text = entry.get("text")
            if text:
                return json.loads(text)
        raise RuntimeError("memory_recall returned no text payload")

    def close(self) -> None:
        if self.process.poll() is not None:
            return
        try:
            self.process.terminate()
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)
        finally:
            self.stderr_thread.join(timeout=1)


def normalized(value: str) -> str:
    return " ".join(value.split()).casefold()


def duplicate_pairs(items: list[dict[str, Any]]) -> int:
    pairs = 0
    for index, left in enumerate(items):
        left_text = normalized(str(left.get("content", "")))
        if not left_text:
            continue
        for right in items[index + 1:]:
            right_text = normalized(str(right.get("content", "")))
            if right_text and (left_text == right_text or SequenceMatcher(None, left_text, right_text).ratio() >= .88):
                pairs += 1
    return pairs


def source_fingerprint(root: Path) -> str:
    import hashlib
    digest = hashlib.sha256()
    for path in sorted((root / "src").rglob("*.ts")):
        digest.update(str(path.relative_to(root)).encode())
        digest.update(path.read_bytes())
    for name in ("package.json", "package-lock.json"):
        digest.update(name.encode())
        digest.update((root / name).read_bytes())
    return digest.hexdigest()


def compact_observation(case: dict, response: dict, gold: set[str], wall_ms: float) -> dict:
    items = response.get("items", [])
    diagnostics = response.get("diagnostics", {})
    content_tokens = sum(estimated_tokens(str(item.get("content", ""))) for item in items)
    gold_tokens = sum(estimated_tokens(str(item.get("content", ""))) for item in items if item.get("id") in gold)
    seen_sources, duplicate_source_tokens = set(), 0
    source_field_tokens, envelope_field_tokens = Counter(), Counter()
    for item in items:
        for key, value in item.items():
            if key not in ("content", "sources"):
                envelope_field_tokens[key] += estimated_tokens(json.dumps({key: value}, ensure_ascii=False))
        for source in item.get("sources", []):
            for key, value in source.items():
                source_field_tokens[key] += estimated_tokens(json.dumps({key: value}, ensure_ascii=False))
            location = {key: value for key, value in source.items() if key != "checked_at"}
            serialized = json.dumps(location, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            if serialized in seen_sources:
                duplicate_source_tokens += estimated_tokens(serialized)
            seen_sources.add(serialized)
    source_tokens = sum(estimated_tokens(json.dumps(item.get("sources", []), ensure_ascii=False)) for item in items)
    return {"case_id": case["case_id"], "query": case["query"], "wall_ms": wall_ms,
            "core_ms": diagnostics.get("elapsed_ms"), "stages_ms": diagnostics.get("stages_ms", {}),
            "estimated_tokens": diagnostics.get("content_estimated_tokens") or estimated_tokens(json.dumps(response, ensure_ascii=False)),
            "content_tokens": content_tokens, "gold_content_tokens": gold_tokens,
            "source_tokens": source_tokens, "duplicate_source_tokens": duplicate_source_tokens,
            "source_field_tokens": dict(source_field_tokens), "envelope_field_tokens": dict(envelope_field_tokens),
            "response_bytes": diagnostics.get("response_bytes") or len(json.dumps(response, ensure_ascii=False).encode()),
            "candidate_ids": diagnostics.get("candidate_ids"), "candidates_ranked": diagnostics.get("candidates_ranked"),
            "ranking_chunk_rows_read": diagnostics.get("ranking_chunk_rows_read"),
            "vector_rows_returned": diagnostics.get("vector_rows_returned"),
            "duplicate_pairs": duplicate_pairs(items), "evidence_status": response.get("evidence_status"),
            "page_support": response.get("retrieval", {}).get("page_support"),
            "warnings": response.get("warnings", []), "full_body_reads": diagnostics.get("full_body_records_read"),
            "items": [{"id": item.get("id"), "revision": item.get("revision"), "title": item.get("title"),
                       "evidence_strength": item.get("evidence_strength"), "support": item.get("support"),
                       "recall_reason": item.get("recall_reason"), "content_tokens": estimated_tokens(str(item.get("content", "")))}
                      for item in items]}


def ratio(numerator: float, denominator: float) -> float | None:
    return round(numerator / denominator, 6) if denominator else None


def main() -> None:
    args = arguments()
    if args.rounds < 1 or args.warmup < 0 or not 1 <= args.top_k <= 10:
        raise ValueError("rounds >= 1, warmup >= 0 and 1 <= top-k <= 10 required")
    root = Path(__file__).resolve().parents[1]
    case_document = json.loads(Path(args.cases).read_text(encoding="utf-8"))
    cases = case_document["cases"] if isinstance(case_document, dict) else case_document
    if not 20 <= len(cases) <= 50:
        raise ValueError(f"Expected 20–50 replay cases, got {len(cases)}")
    if not args.skip_build:
        subprocess.run(["npm", "run", "build"], cwd=root, check=True)
    package = json.loads((root / "package.json").read_text(encoding="utf-8"))
    git_head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    core_diff = subprocess.run(["git", "diff", "--quiet", "HEAD", "--", "src", "package.json", "package-lock.json"], cwd=root).returncode
    config = load_config(args.config)
    production = Path(config["database"])
    watched = [production, Path(str(production) + "-wal")]
    before = {str(path): file_fingerprint(path) for path in watched}
    snapshot_root = Path(tempfile.mkdtemp(prefix="memory_test_snapshot-"))
    database, snapshot_config = snapshot_database(config, snapshot_root)
    connection = read_snapshot(database)
    active_rows = connection.execute("SELECT id,project_id,scope FROM memories WHERE status='active'").fetchall()
    active_ids = {row["id"] for row in active_rows}
    ownership = {row["id"]: (row["project_id"], row["scope"]) for row in active_rows}
    schema_version = connection.execute("PRAGMA user_version").fetchone()[0]
    connection.close()
    observations = defaultdict(list)
    errors = []
    node_binary = resolve_node_binary(config, args.config)
    client = McpClient(snapshot_config, root, node_binary)
    try:
        for iteration in range(args.warmup + args.rounds):
            measured = iteration >= args.warmup
            for case in cases:
                request = dict(case["request"], debug=True)
                if args.detail:
                    request["detail"] = args.detail
                started = time.perf_counter()
                try:
                    response = client.recall(request)
                    wall_ms = (time.perf_counter() - started) * 1000
                except Exception as error:  # Keep the full cohort running; errors are release-gate data.
                    wall_ms = (time.perf_counter() - started) * 1000
                    if measured:
                        errors.append({"case_id": case["case_id"], "iteration": iteration - args.warmup,
                                       "wall_ms": wall_ms, "error": str(error)[:2000]})
                    continue
                if measured:
                    gold = set(case.get("relevant_ids", [])) if case.get("annotation_status") == "reviewed" else set(case.get("silver_relevant_ids", [])) | set(case.get("reformulation_gold_ids", []))
                    observation = compact_observation(case, response, gold, wall_ms)
                    observation["iteration"] = iteration - args.warmup
                    observations[case["case_id"]].append(observation)
    finally:
        client.close()

    all_observations = [observation for values in observations.values() for observation in values]
    gold_by_case = {case["case_id"]: set(case.get("relevant_ids", [])) if case.get("annotation_status") == "reviewed"
                    else set(case.get("silver_relevant_ids", [])) | set(case.get("reformulation_gold_ids", [])) for case in cases}
    quality, reciprocal_rank = Counter(), Counter()
    stage_values, warning_counts, evidence_counts = defaultdict(list), Counter(), Counter()
    token_efficiency = Counter()
    case_results = []
    for case in cases:
        case_id = case["case_id"]
        mode = "reviewed" if case.get("annotation_status") == "reviewed" else "silver"
        gold = gold_by_case[case_id]
        available_gold = gold & active_ids
        scope_excluded_gold = set(case.get("scope_excluded_gold_ids", []))
        if case["request"].get("project_id") and not case["request"].get("include_global", False):
            in_scope = {memory_id for memory_id in available_gold
                        if ownership[memory_id] == (case["request"]["project_id"], "project")}
            scope_excluded_gold |= available_gold - in_scope
            available_gold = in_scope
        available_gold -= scope_excluded_gold
        for observation in observations[case_id]:
            top_items = observation["items"][:args.top_k]
            top_ids = {item["id"] for item in top_items}
            hits = available_gold & top_ids
            evidence_counts[observation["evidence_status"]] += 1
            warning_counts.update(observation["warnings"])
            for stage, value in observation["stages_ms"].items():
                if isinstance(value, (int, float)):
                    stage_values[stage].append(value)
            if available_gold:
                quality[f"{mode}_gold_observations"] += 1
                quality[f"{mode}_hit"] += bool(hits)
                quality[f"{mode}_recall_numerator"] += len(hits)
                quality[f"{mode}_recall_denominator"] += len(available_gold)
                quality[f"{mode}_supported_gold"] += any(item["id"] in available_gold and item.get("evidence_strength") == "supported" for item in top_items)
                quality[f"{mode}_related_but_insufficient"] += bool(hits) and observation["evidence_status"] == "insufficient"
                rank = next((index for index, item in enumerate(observation["items"], 1) if item["id"] in available_gold), 0)
                reciprocal_rank[mode] += 1 / rank if rank else 0
                token_efficiency[f"{mode}_gold"] += observation["gold_content_tokens"]
                token_efficiency[f"{mode}_total"] += observation["content_tokens"]
                token_efficiency[f"{mode}_response_total"] += observation["estimated_tokens"]
                if mode == "silver" and case.get("reformulation_gold_ids"):
                    quality["reformulation_observations"] += 1
                    quality["reformulation_hits"] += bool(set(case["reformulation_gold_ids"]) & top_ids)
            if case.get("expected_no_evidence"):
                quality["no_evidence_observations"] += 1
                quality["no_evidence_abstained"] += observation["evidence_status"] == "insufficient"
                quality["no_evidence_items_returned"] += len(observation["items"])
            if case.get("irrelevant_ids"):
                quality["noise_observations"] += 1
            known_irrelevant = set(case.get("irrelevant_ids", [])) & top_ids
            quality["noise_free"] += bool(case.get("irrelevant_ids")) and not known_irrelevant
            quality["known_irrelevant_returns"] += len(known_irrelevant)
            supported_noise = {item["id"] for item in top_items if item["id"] in known_irrelevant and item.get("evidence_strength") == "supported"}
            quality["known_supported_irrelevant_returns"] += len(supported_noise)
            quality["supported_noise_free"] += bool(case.get("irrelevant_ids")) and not supported_noise
            if case.get("complete_judgments"):
                quality["reviewed_items"] += len(top_items)
                quality["reviewed_relevant"] += len(available_gold & top_ids)
        case_results.append({"case_id": case_id, "query": case["query"],
                             "annotation_status": case.get("annotation_status"),
                             "expected_no_evidence": case.get("expected_no_evidence", False),
                             "selection_reasons": case.get("selection_reasons"),
                             "gold_ids": sorted(gold), "available_gold_ids": sorted(available_gold),
                             "known_irrelevant_ids": case.get("irrelevant_ids", []),
                             "scope_excluded_gold_ids": sorted(scope_excluded_gold),
                             "missing_gold_ids": sorted(gold - active_ids - scope_excluded_gold),
                             "observations": observations[case_id]})
    success_count = len(all_observations)
    call_count = success_count + len(errors)
    source_field_totals, envelope_field_totals = Counter(), Counter()
    for observation in all_observations:
        source_field_totals.update(observation["source_field_tokens"])
        envelope_field_totals.update(observation["envelope_field_tokens"])
    metrics = {
        "requests": call_count, "successful_requests": success_count, "failed_requests": len(errors),
        "error_rate": ratio(len(errors), call_count),
        "silver_labeled_cases": sum(case.get("annotation_status") != "reviewed" and bool(gold_by_case[case["case_id"]]) for case in cases),
        "reviewed_cases": sum(case.get("annotation_status") == "reviewed" for case in cases),
        "expected_no_evidence_cases": sum(bool(case.get("expected_no_evidence")) for case in cases),
        "reviewed_hit_at_k": ratio(quality["reviewed_hit"], quality["reviewed_gold_observations"]),
        "reviewed_recall_at_k": ratio(quality["reviewed_recall_numerator"], quality["reviewed_recall_denominator"]),
        "reviewed_supported_gold_rate": ratio(quality["reviewed_supported_gold"], quality["reviewed_gold_observations"]),
        "reviewed_mrr": ratio(reciprocal_rank["reviewed"], quality["reviewed_gold_observations"]),
        "reviewed_related_but_insufficient_rate": ratio(quality["reviewed_related_but_insufficient"], quality["reviewed_gold_observations"]),
        "expected_no_evidence_abstention_rate": ratio(quality["no_evidence_abstained"], quality["no_evidence_observations"]),
        "expected_no_evidence_items_returned": quality["no_evidence_items_returned"],
        "silver_hit_at_k": ratio(quality["silver_hit"], quality["silver_gold_observations"]),
        "silver_recall_at_k": ratio(quality["silver_recall_numerator"], quality["silver_recall_denominator"]),
        "silver_supported_gold_rate": ratio(quality["silver_supported_gold"], quality["silver_gold_observations"]),
        "silver_mrr": ratio(reciprocal_rank["silver"], quality["silver_gold_observations"]),
        "silver_reformulation_recovery_at_k": ratio(quality["reformulation_hits"], quality["reformulation_observations"]),
        "reviewed_precision_at_k": ratio(quality["reviewed_relevant"], quality["reviewed_items"]),
        "known_irrelevant_returns_at_k": quality["known_irrelevant_returns"],
        "known_supported_irrelevant_returns_at_k": quality["known_supported_irrelevant_returns"],
        "known_noise_free_rate": ratio(quality["noise_free"], quality["noise_observations"]),
        "known_supported_noise_free_rate": ratio(quality["supported_noise_free"], quality["noise_observations"]),
        "source_field_estimated_tokens": dict(source_field_totals.most_common()),
        "envelope_field_estimated_tokens": dict(envelope_field_totals.most_common()),
        "reviewed_gold_content_token_share": ratio(token_efficiency["reviewed_gold"], token_efficiency["reviewed_total"]),
        "reviewed_gold_response_token_share": ratio(token_efficiency["reviewed_gold"], token_efficiency["reviewed_response_total"]),
        "content_response_token_share": ratio(sum(observation["content_tokens"] for observation in all_observations), sum(observation["estimated_tokens"] for observation in all_observations)),
        "source_estimated_tokens": distribution(observation["source_tokens"] for observation in all_observations),
        "duplicate_source_estimated_tokens": sum(observation["duplicate_source_tokens"] for observation in all_observations),
        "non_content_estimated_tokens": distribution(max(0, observation["estimated_tokens"] - observation["content_tokens"]) for observation in all_observations),
        "duplicate_item_pairs": sum(observation["duplicate_pairs"] for observation in all_observations),
        "duplicate_free_response_rate": ratio(sum(not observation["duplicate_pairs"] for observation in all_observations), success_count),
        "wall_latency_ms": distribution(observation["wall_ms"] for observation in all_observations),
        "core_latency_ms": distribution(observation["core_ms"] for observation in all_observations if observation["core_ms"] is not None),
        "stage_latency_ms": {stage: distribution(values) for stage, values in sorted(stage_values.items())},
        "response_estimated_tokens": distribution(observation["estimated_tokens"] for observation in all_observations),
        "content_estimated_tokens": distribution(observation["content_tokens"] for observation in all_observations),
        "response_bytes": distribution(observation["response_bytes"] for observation in all_observations),
        "candidate_ids": distribution(observation["candidate_ids"] for observation in all_observations if observation["candidate_ids"] is not None),
        "candidates_ranked": distribution(observation["candidates_ranked"] for observation in all_observations if observation["candidates_ranked"] is not None),
        "ranking_chunk_rows_read": distribution(observation["ranking_chunk_rows_read"] for observation in all_observations if observation["ranking_chunk_rows_read"] is not None),
        "vector_rows_returned": distribution(observation["vector_rows_returned"] for observation in all_observations if observation["vector_rows_returned"] is not None),
        "ordinary_full_body_reads": sum(observation["full_body_reads"] or 0 for observation in all_observations),
        "evidence_status": dict(evidence_counts), "warnings": dict(warning_counts)}
    after = {str(path): file_fingerprint(path) for path in watched}
    report = {
        "format": "shared-agent-memory/evolve-benchmark-v1", "generated_at": datetime.now(timezone.utc).isoformat(),
        "runtime": {"package_version": package["version"], "git_head": git_head,
                    "core_diff_from_head": core_diff != 0, "source_fingerprint": source_fingerprint(root),
                    "node": subprocess.check_output(["node", "--version"], text=True).strip(),
                    "rounds": args.rounds, "warmup_rounds": args.warmup, "top_k": args.top_k,
                    "detail": args.detail or "default(full)"},
        "label_policy": {"default": "Use human-reviewed non-exhaustive relevant_ids when available; unlabeled items are not automatically negative",
                         "silver": "Historical direct items + later reformulation direct IDs are retained only for comparison, never presented as accuracy",
                         "precision": "reviewed_precision_at_k is computed only when complete_judgments=true",
                         "known_irrelevant": "irrelevant_ids contributes known-noise hits and a noise-free rate"},
        "dataset": {"cases_file": str(Path(args.cases).resolve()), "case_count": len(cases), "schema_version": schema_version,
                    "snapshot_sha256": sha256(database), "active_records": len(active_ids)},
        "source_protection": {"mode": "read-only SQLite backup and recall-only snapshot config",
                              "before": before, "after": after, "unchanged_during_benchmark": before == after},
        "metrics": metrics, "errors": errors, "cases": case_results}
    if args.keep_snapshot:
        report["dataset"]["snapshot_path"] = str(database)
    else:
        shutil.rmtree(snapshot_root)
        report["dataset"]["snapshot_removed"] = True
    destination = write_report(args.output, report)
    print(json.dumps({"output": str(destination), "package_version": package["version"],
                      "core_diff_from_head": core_diff != 0, "source_unchanged": before == after,
                      "metrics": metrics}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
