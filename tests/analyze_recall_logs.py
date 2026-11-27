#!/usr/bin/env python3
"""Extract shared-agent-memory calls from Codex/StepCode/Antigravity logs and quantify failure proxies."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime
from difflib import SequenceMatcher
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
from typing import Any, Iterable

from evolve_common import DEFAULT_OUTPUT, distribution, estimated_tokens, write_report

# Imports are deliberately stdlib-only; raw records remain in ignored .local reports.
def normalized(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().casefold()


def arguments() -> argparse.Namespace:
    home = Path.home()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--log-root", action="append", dest="roots",
                        default=[str(home / ".codex/sessions"),
                                 str(home / ".codex/archived_sessions"),
                                 str(home / ".stepcode/agent/sessions")])
    parser.add_argument("--antigravity-root", default=str(home / ".gemini/antigravity/brain"))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT / "log-analysis.json"))
    parser.add_argument("--cases-output", default=str(DEFAULT_OUTPUT / "replay-cases.json"))
    parser.add_argument("--case-count", type=int, default=32)
    parser.add_argument("--exclude-session", action="append", default=[])
    return parser.parse_args()


def json_payload(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        if "items" in value and ("generation" in value or "retrieval_mode" in value):
            return value
        for key in ("Ok", "structuredContent", "result", "output"):
            if key in value and (found := json_payload(value[key])):
                return found
        if "text" in value and (found := json_payload(value["text"])):
            return found
        content = value.get("content")
        if isinstance(content, list):
            for entry in content:
                if isinstance(entry, dict) and (found := json_payload(entry.get("text"))):
                    return found
    if isinstance(value, str) and value.lstrip().startswith("{"):
        try:
            return json_payload(json.loads(value))
        except json.JSONDecodeError:
            return None
    if isinstance(value, list):
        for entry in value:
            if found := json_payload(entry):
                return found
    return None


def milliseconds(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        return float(value) * 1000 if value < 10 else float(value)
    if isinstance(value, dict):
        if "milliseconds" in value:
            return float(value["milliseconds"])
        if "secs" in value:
            return float(value["secs"]) * 1000 + float(value.get("nanos", 0)) / 1_000_000
        if "ms" in value:
            return float(value["ms"])
    return None


def wall_ms(start: str | None, end: str | None) -> float | None:
    try:
        return (datetime.fromisoformat(end.replace("Z", "+00:00")) -
                datetime.fromisoformat(start.replace("Z", "+00:00"))).total_seconds() * 1000
    except (AttributeError, TypeError, ValueError):
        return None


def message_text(message: Any) -> str:
    if not isinstance(message, dict):
        return ""
    parts = []
    for entry in message.get("content", []):
        if isinstance(entry, dict) and entry.get("type") in ("input_text", "text", "output_text"):
            parts.append(str(entry.get("text", "")))
    return "\n".join(parts)


def iter_lines(path: Path, zstd_skipped: list[int]) -> Iterable[str]:
    if path.suffix == ".zst":
        if not shutil.which("zstd"):
            zstd_skipped[0] += 1
            return ()
        proc = subprocess.run(["zstd", "-dc", str(path)], capture_output=True, text=True, errors="replace")
        if proc.returncode != 0:
            return ()
        return proc.stdout.splitlines()
    return path.open(encoding="utf-8", errors="replace")


def has_tool_error(value: Any) -> bool:
    if isinstance(value, dict):
        if "Err" in value or value.get("isError") is True:
            return True
        if "error" in value:
            return True
        for key in ("Ok", "structuredContent", "result", "output", "content"):
            if key in value and has_tool_error(value[key]):
                return True
        if "text" in value and has_tool_error(value["text"]):
            return True
        return False
    if isinstance(value, list):
        return any(has_tool_error(entry) for entry in value)
    if isinstance(value, str):
        stripped = value.lstrip()
        if stripped.startswith("{"):
            try:
                return has_tool_error(json.loads(stripped))
            except json.JSONDecodeError:
                pass
        return stripped.startswith(("MCP error", "Validation failed", "ERR:")) or '"error":' in stripped
    return False


def normalize_tool_name(name: Any) -> str | None:
    text = str(name or "").strip().strip('"')
    match = re.search(r"(?:^|__)memory_([a-z0-9_]+)$", text)
    if not match:
        return None
    return "memory_" + match.group(1)


def parse_file(path: Path, zstd_skipped: list[int]) -> tuple[list[dict], list[dict], int, bool, list[tuple[str, bool]]]:
    calls, users, pending, tool_events, pending_tools = [], [], {}, [], {}
    malformed, skip = 0, False
    objective_marker = "自进化迭代为一个高可用、高性能的生产级候选版本"
    for line_number, line in enumerate(iter_lines(path, zstd_skipped), 1):
        if objective_marker in line:
            skip = True
        try:
            root = json.loads(line)
        except json.JSONDecodeError:
            malformed += 1
            continue
        timestamp = root.get("timestamp")
        payload = root.get("payload", {})
        item = payload.get("item", {}) if isinstance(payload, dict) else {}
        if item.get("type") == "McpToolCall":
            tool_name = normalize_tool_name(item.get("tool"))
            if tool_name:
                tool_events.append((tool_name, has_tool_error(item.get("result"))))
            if item.get("tool") == "memory_recall":
                calls.append({"call_id": item.get("id"), "session": str(path), "line": line_number,
                              "timestamp": timestamp, "request": item.get("arguments", {}),
                              "response": json_payload(item.get("result")), "raw_error": item.get("result") if not json_payload(item.get("result")) else None,
                              "duration_ms": milliseconds(item.get("duration"))})
        if payload.get("type") == "message" and payload.get("role") == "user":
            text = message_text(payload)
            if text and not text.startswith("# AGENTS.md instructions"):
                users.append({"timestamp": timestamp, "text": text})
        message = root.get("message", {})
        if root.get("type") != "message" or not isinstance(message, dict):
            continue
        content = message.get("content", [])
        if message.get("role") == "user":
            text = message_text(message)
            if text:
                users.append({"timestamp": timestamp, "text": text})
        for entry in content if isinstance(content, list) else []:
            if not isinstance(entry, dict):
                continue
            if entry.get("type") == "toolCall":
                tool_name = normalize_tool_name(entry.get("name"))
                if tool_name and entry.get("id"):
                    pending_tools[entry.get("id")] = tool_name
            if entry.get("type") == "toolCall" and str(entry.get("name", "")).endswith("memory_recall"):
                call = {"call_id": entry.get("id"), "session": str(path), "line": line_number,
                        "timestamp": timestamp, "request": entry.get("arguments", {}),
                        "response": None, "duration_ms": None}
                calls.append(call)
                pending[entry.get("id")] = call
        if message.get("role") == "toolResult":
            tool_name = pending_tools.pop(message.get("toolCallId"), None) or normalize_tool_name(message.get("toolName"))
            if tool_name:
                tool_events.append((tool_name, bool(message.get("isError")) or has_tool_error(message.get("content"))))
        if message.get("role") == "toolResult" and str(message.get("toolName", "")).endswith("memory_recall"):
            call = pending.get(message.get("toolCallId"))
            if call:
                call["response"] = json_payload(message.get("content"))
                call["duration_ms"] = wall_ms(call["timestamp"], timestamp)
    return ([] if skip else calls), users, malformed, skip, ([] if skip else tool_events)


def parse_antigravity_transcript(path: Path) -> tuple[int, list[tuple[str, bool]]]:
    malformed, events = 0, []
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return 0, []
    parsed: list[dict[str, Any] | None] = []
    for line in lines:
        try:
            parsed.append(json.loads(line))
        except json.JSONDecodeError:
            malformed += 1
            parsed.append(None)
    for index, obj in enumerate(parsed):
        if not isinstance(obj, dict):
            continue
        for call in obj.get("tool_calls") or []:
            if not isinstance(call, dict) or call.get("name") != "call_mcp_tool":
                continue
            args = call.get("args") or {}
            if "shared_memory" not in str(args.get("ServerName", "")):
                continue
            tool_name = normalize_tool_name(args.get("ToolName"))
            if not tool_name:
                continue
            is_err = False
            for follow in parsed[index + 1:index + 12]:
                if not isinstance(follow, dict) or follow.get("type") != "GENERIC":
                    continue
                if follow.get("status") == "ERROR" or has_tool_error(follow.get("error") or follow.get("content")):
                    is_err = True
                    break
                if tool_name in str(follow.get("content", "")) or "items" in str(follow.get("content", "")) or "proposal_id" in str(follow.get("content", "")):
                    break
            events.append((tool_name, is_err))
    return malformed, events


def parse_time(value: str | None) -> float | None:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (AttributeError, TypeError, ValueError):
        return None


def bigrams(value: str) -> set[str]:
    text = re.sub(r"\W+", "", value, flags=re.UNICODE).casefold()
    return {text[index:index + 2] for index in range(max(0, len(text) - 1))}


def item_view(item: dict, include_content: bool = False) -> dict:
    view = {"memory_id": item.get("id"), "revision": item.get("revision"),
            "title": item.get("title"), "evidence_strength": item.get("evidence_strength"),
            "support": item.get("support"), "recall_reason": item.get("recall_reason"),
            "applicability": item.get("applicability")}
    if include_content:
        view["content"] = item.get("content", "")[:500]
        view["sources"] = item.get("sources", [])
    return view


def call_stats(call: dict, following_user: str = "") -> dict:
    response = call.get("response") or {}
    items = response.get("items", [])
    diagnostics = response.get("diagnostics", {})
    serialized = json.dumps(response, ensure_ascii=False, separators=(",", ":")) if response else ""
    token_count = diagnostics.get("content_estimated_tokens") or (estimated_tokens(serialized) if response else 0)
    contents = [str(item.get("content", "")) for item in items]
    duplicate_pairs = []
    for index, left in enumerate(contents):
        for right_index, right in enumerate(contents[index + 1:], index + 1):
            left_normal, right_normal = normalized(left), normalized(right)
            if not left_normal or not right_normal:
                continue
            ratio = 1.0 if left_normal == right_normal else SequenceMatcher(None, left_normal, right_normal).ratio()
            if ratio >= .88:
                duplicate_pairs.append((index, right_index, round(ratio, 4)))
    core_ms = diagnostics.get("elapsed_ms")
    direct = [item for item in items if item.get("support", {}).get("level") == "direct"
              or not item.get("support") and item.get("evidence_strength") == "supported"]
    negative = bool(re.search(r"不相关|不是我|不是要问|找错|召回错|漏召回|漏掉|没有(?:找到|搜到)|没找到|irrelevant|wrong result|not what i", following_user, re.I))
    query = str(call.get("request", {}).get("query", ""))
    grounding = []
    for item in direct if query else []:
        query_grams = bigrams(query)
        text_grams = bigrams(str(item.get("title", "")) + " " + str(item.get("content", "")))
        coverage = len(query_grams & text_grams) / max(1, len(query_grams))
        if coverage < .05:
            grounding.append(item.get("id"))
    return {"items": items, "direct": direct, "diagnostics": diagnostics,
            "core_ms": float(core_ms) if core_ms is not None else None,
            "stages_ms": diagnostics.get("stages_ms", {}), "estimated_tokens": token_count,
            "content_tokens": sum(estimated_tokens(content) for content in contents),
            "duplicate_pairs": duplicate_pairs, "negative_feedback": negative,
            "low_grounding_direct_ids": grounding, "following_user": following_user[:500]}


def reformulation_candidates(calls: list[dict], stats: dict[int, dict]) -> list[dict]:
    groups = defaultdict(list)
    for index, call in enumerate(calls):
        if call.get("request", {}).get("query"):
            groups[call["session"]].append((parse_time(call.get("timestamp")) or 0, call["line"], index))
    found = []
    for entries in groups.values():
        entries.sort()
        for position, (_, _, index) in enumerate(entries):
            before = calls[index]
            before_stats = stats[index]
            if before_stats["direct"] or not before.get("response"):
                continue
            for _, _, next_index in entries[position + 1:position + 4]:
                after = calls[next_index]
                elapsed = (parse_time(after.get("timestamp")) or 0) - (parse_time(before.get("timestamp")) or 0)
                if elapsed < 0 or elapsed > 1800:
                    continue
                left, right = bigrams(before["request"]["query"]), bigrams(after["request"]["query"])
                similarity = len(left & right) / max(1, len(left | right))
                if similarity >= .08 and stats[next_index]["direct"]:
                    found.append({"before_call": index, "after_call": next_index,
                                  "query_similarity": round(similarity, 4), "after_direct_ids": [item.get("id") for item in stats[next_index]["direct"]]})
                    break
    return found


def compact_call(index: int, call: dict, stats: dict, include_content: bool = False) -> dict:
    response = call.get("response") or {}
    return {"call_index": index, "session": call["session"], "line": call["line"],
            "timestamp": call.get("timestamp"), "request": call.get("request", {}),
            "evidence_status": response.get("evidence_status"), "warnings": response.get("warnings", []),
            "core_ms": stats["core_ms"], "stages_ms": stats["stages_ms"],
            "estimated_tokens": stats["estimated_tokens"], "duplicate_pairs": stats["duplicate_pairs"],
            "negative_feedback": stats["negative_feedback"], "following_user": stats["following_user"],
            "items": [item_view(item, include_content) for item in stats["items"]]}


def select_cases(calls: list[dict], stats: dict[int, dict], limit: int, reformulations: list[dict]) -> list[dict]:
    groups = defaultdict(list)
    for index, call in enumerate(calls):
        query = call.get("request", {}).get("query")
        if query and call.get("response"):
            groups[normalized(query)].append(index)
    failed_before = {entry["before_call"] for entry in reformulations}
    reformulation_gold = defaultdict(set)
    for entry in reformulations:
        reformulation_gold[entry["before_call"]].update(entry["after_direct_ids"])
    ranked = []
    for indexes in groups.values():
        latest = max(indexes, key=lambda index: (calls[index].get("timestamp") or "", index))
        best = max(indexes, key=lambda index: (bool(stats[index]["stages_ms"]), stats[index]["core_ms"] or 0))
        chosen = best if stats[best]["stages_ms"] else latest
        reasons = []
        if len(indexes) > 1:
            reasons.append("frequent")
        if any(stats[index]["negative_feedback"] for index in indexes):
            reasons.append("user_correction")
        if any(index in failed_before for index in indexes):
            reasons.append("reformulation_hit")
        if any(stats[index]["duplicate_pairs"] for index in indexes):
            reasons.append("duplicate_payload")
        if any(not stats[index]["direct"] for index in indexes):
            reasons.append("no_direct_evidence")
        if any(stats[index]["low_grounding_direct_ids"] for index in indexes):
            reasons.append("grounding_review")
        score = min(len(indexes), 5) * 3 + 30 * ("user_correction" in reasons) + 20 * ("reformulation_hit" in reasons)
        score += 8 * ("duplicate_payload" in reasons) + 5 * ("no_direct_evidence" in reasons)
        score += min(10, (stats[chosen]["core_ms"] or 0) / 50)
        ranked.append((score, chosen, indexes, reasons))
    ranked.sort(key=lambda entry: (-entry[0], normalized(calls[entry[1]]["request"]["query"])))
    selected, seen = [], set()

    def add(entry):
        if entry[1] not in seen and len(selected) < limit:
            selected.append(entry)
            seen.add(entry[1])

    failure = [entry for entry in ranked if {"reformulation_hit", "user_correction", "duplicate_payload"} & set(entry[3])]
    frequent = [entry for entry in ranked if "frequent" in entry[3]]
    positive = [entry for entry in ranked if stats[entry[1]]["direct"]]
    empty = [entry for entry in ranked if not stats[entry[1]]["items"]]
    for pool, quota in ((failure, limit // 4), (frequent, limit // 4), (positive, limit // 4), (empty, max(1, limit // 16))):
        for entry in pool:
            if len([item for item in selected if item in pool]) >= quota:
                break
            add(entry)
    for entry in positive:
        if sum(bool(stats[item[1]]["direct"]) for item in selected) >= limit // 2:
            break
        add(entry)
    for entry in ranked:
        add(entry)
    cases = []
    allowed = ("query", "mode", "view", "detail", "limit", "token_budget", "max_bytes", "project_id",
               "include_global", "context", "exact_only", "decision_state", "subject_id",
               "context_key", "include_history", "as_of", "graph")
    for score, chosen, indexes, reasons in selected:
        call, stat = calls[chosen], stats[chosen]
        request = {key: value for key in allowed if (value := call["request"].get(key)) is not None}
        query = request["query"]
        cases.append({"case_id": hashlib.sha256(normalized(query).encode()).hexdigest()[:16],
                      "query": query, "request": request, "occurrences": len(indexes),
                      "selection_reasons": reasons or ["representative"], "selection_score": round(score, 3),
                      "annotation_status": "unreviewed", "relevant_ids": [], "irrelevant_ids": [],
                      "silver_relevant_ids": [item.get("id") for item in stat["direct"]],
                      "reformulation_gold_ids": sorted({gold for index in indexes for gold in reformulation_gold[index]}),
                      "historical": compact_call(chosen, call, stat, include_content=True)})
    return cases


def main() -> None:
    args = arguments()
    if not 20 <= args.case_count <= 50:
        raise ValueError("--case-count must be between 20 and 50")
    paths = sorted({path for root in args.roots for pattern in ("*.jsonl", "*.jsonl.zst")
                    for path in Path(root).expanduser().rglob(pattern)
                    if not any(session in str(path) for session in args.exclude_session)})
    calls, malformed, skipped, users_by_session = [], 0, 0, defaultdict(list)
    tool_events: list[tuple[str, bool]] = []
    zstd_skipped = [0]
    for path in paths:
        parsed, users, bad, skip, events = parse_file(path, zstd_skipped)
        calls.extend(parsed)
        tool_events.extend(events)
        users_by_session[str(path)].extend(users)
        malformed += bad
        skipped += int(skip)
    ag_root = Path(args.antigravity_root).expanduser()
    ag_paths = sorted(ag_root.glob("*/.system_generated/logs/transcript.jsonl")) if ag_root.is_dir() else []
    for ag_path in ag_paths:
        if any(session in str(ag_path) for session in args.exclude_session):
            continue
        bad, events = parse_antigravity_transcript(ag_path)
        malformed += bad
        tool_events.extend(events)
    tool_counts: dict[str, dict[str, int]] = {}
    for tool_name, is_err in tool_events:
        bucket = tool_counts.setdefault(tool_name, {"calls": 0, "errors": 0})
        bucket["calls"] += 1
        if is_err:
            bucket["errors"] += 1
    calls.sort(key=lambda call: (call.get("timestamp") or "", call["session"], call["line"]))
    stats = {}
    for index, call in enumerate(calls):
        users = users_by_session[call["session"]]
        called_at = parse_time(call.get("timestamp"))
        following = ""
        if called_at is not None:
            future = [(parse_time(user.get("timestamp")) or 0, user["text"]) for user in users]
            future = [(at, text) for at, text in future if 0 <= at - called_at <= 3600]
            if future:
                following = min(future)[1]
        stats[index] = call_stats(call, following)
    reformulations = reformulation_candidates(calls, stats)
    fp_indexes = {index for index, stat in stats.items()
                  if stat["direct"] and (stat["negative_feedback"] or stat["low_grounding_direct_ids"])}
    fn_indexes = {entry["before_call"] for entry in reformulations}
    fn_indexes.update(index for index, stat in stats.items() if stat["negative_feedback"] and not stat["direct"])
    token_indexes = {index for index, stat in stats.items()
                     if stat["estimated_tokens"] > 2000 or stat["duplicate_pairs"] or len(stat["items"]) > 8}
    token_indexes = sorted(token_indexes, key=lambda index: (not bool(stats[index]["duplicate_pairs"]),
                           -stats[index]["estimated_tokens"], index))
    latency_indexes = sorted((index for index, stat in stats.items() if stat["core_ms"] is not None),
                             key=lambda index: stats[index]["core_ms"], reverse=True)[:20]
    stage_values = defaultdict(list)
    for stat in stats.values():
        for stage, value in stat["stages_ms"].items():
            if isinstance(value, (int, float)):
                stage_values[stage].append(value)
    responses = [call.get("response") for call in calls if call.get("response")]
    counter = lambda key: dict(Counter(str((response or {}).get(key)) for response in responses))
    warning_counts = Counter(warning for response in responses for warning in response.get("warnings", []))
    query_calls = [index for index, call in enumerate(calls) if call.get("request", {}).get("query")]
    query_responses = [calls[index]["response"] for index in query_calls if calls[index].get("response")]
    query_warning_counts = Counter(warning for response in query_responses for warning in response.get("warnings", []))
    request_kinds = Counter("query" if call.get("request", {}).get("query") else
                            "cursor" if call.get("request", {}).get("cursor") else
                            "versions" if call.get("request", {}).get("versions") else
                            "ids" if call.get("request", {}).get("ids") else "unknown" for call in calls)
    report = {
        "format": "shared-agent-memory/evolve-log-analysis-v1",
        "files": {"discovered": len(paths), "zst_files": sum(1 for p in paths if p.suffix == ".zst"),
                  "zst_skipped": zstd_skipped[0], "antigravity_transcripts": len(ag_paths),
                  "excluded_current_objective": skipped, "malformed_lines": malformed},
        "tool_summary": {"total_calls": len(tool_events), "total_errors": sum(1 for _, err in tool_events if err),
                         "by_tool": dict(sorted(tool_counts.items()))},
        "summary": {"calls": len(calls), "query_calls": len(query_calls), "responses": len(responses),
                    "errors_or_incomplete": len(calls) - len(responses), "request_kinds": dict(request_kinds),
                    "query_responses": len(query_responses),
                    "unique_queries": len({normalized(calls[index]["request"]["query"]) for index in query_calls}),
                    "empty_or_insufficient": sum(response.get("evidence_status") == "insufficient" or not response.get("items") for response in responses),
                    "responses_with_duplicates": sum(bool(stats[index]["duplicate_pairs"]) for index in range(len(calls))),
                    "duplicate_item_pairs": sum(len(stat["duplicate_pairs"]) for stat in stats.values()),
                    "false_positive_review_candidates": len(fp_indexes),
                    "false_negative_review_candidates": len(fn_indexes),
                    "reformulation_hit_pairs": len(reformulations)},
        "evidence_status": counter("evidence_status"), "retrieval_mode": counter("retrieval_mode"),
        "warnings": dict(warning_counts), "query_warnings": dict(query_warning_counts),
        "query_response_estimated_tokens": distribution(stats[index]["estimated_tokens"] for index in query_calls if calls[index].get("response")),
        "core_elapsed_ms": distribution(stat["core_ms"] for stat in stats.values() if stat["core_ms"] is not None),
        "observed_call_duration_ms": distribution(call["duration_ms"] for call in calls if call["duration_ms"] is not None and call["duration_ms"] >= 0),
        "stage_elapsed_ms": {stage: distribution(values) for stage, values in sorted(stage_values.items())},
        "response_estimated_tokens": distribution(stats[index]["estimated_tokens"] for index, call in enumerate(calls) if call.get("response")),
        "bad_cases": {
            "false_positive_review": [compact_call(index, calls[index], stats[index]) for index in sorted(fp_indexes)[:50]],
            "false_negative_review": [compact_call(index, calls[index], stats[index]) for index in sorted(fn_indexes)[:50]],
            "reformulations": reformulations,
            "token_and_duplicates": [compact_call(index, calls[index], stats[index]) for index in token_indexes[:50]],
            "latency_outliers": [compact_call(index, calls[index], stats[index]) for index in latency_indexes]},
        "method_limits": ["Historical support labels are not independent relevance truth.",
                          "User corrections and reformulation pairs are candidates requiring review, not automatic FP/FN labels.",
                          "Call wall time can include client scheduling; core stage timings exist only for debug responses.",
                          "Raw memories and queries are retained only in ignored local reports."]}
    cases = select_cases(calls, stats, args.case_count, reformulations)
    case_report = {"format": "shared-agent-memory/evolve-replay-cases-v1", "case_count": len(cases),
                   "annotation_guide": "Set annotation_status=reviewed; fill relevant_ids and known irrelevant_ids from current snapshot. silver_relevant_ids are historical labels only.",
                   "cases": cases}
    write_report(args.output, report)
    write_report(args.cases_output, case_report)
    print(json.dumps({"output": args.output, "cases_output": args.cases_output,
                      "summary": report["summary"], "selected_cases": len(cases)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
