#!/usr/bin/env python3
"""Read-only forensic probe for a consistent copy of the production memory DB."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
from difflib import SequenceMatcher
import json
from pathlib import Path
import re
import shutil
import sqlite3
import struct
import tempfile

from evolve_common import (DEFAULT_CONFIG, DEFAULT_OUTPUT, distribution, file_fingerprint,
                           load_config, read_snapshot, sha256, snapshot_database,
                           utf16_length, write_report)

REQUIRED = ("project_id", "scope", "kind", "title", "content", "tags", "sources",
            "verification", "valid_for", "author_client", "author_session", "derived_from")
OPTIONAL = ("subject_id", "context_key", "memory_form", "decision_state", "lifecycle",
            "valid_time", "episode", "consolidation")


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT / "data-probe.json"))
    parser.add_argument("--snapshot-root", help="Dedicated empty directory; default is an auto-removed /tmp directory")
    parser.add_argument("--stale-days", type=int, default=90)
    return parser.parse_args()


def timestamp(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.replace(tzinfo=parsed.tzinfo or timezone.utc).astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


def normalized(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().casefold()


def missing_required(record: dict, key: str) -> bool:
    if key not in record:
        return True
    value = record[key]
    if key == "project_id":
        return record.get("scope") == "project" and not value
    if key in ("tags", "derived_from", "valid_for"):
        return not isinstance(value, list if key != "valid_for" else dict)
    if key == "sources":
        return not isinstance(value, list) or not value
    return value is None or isinstance(value, str) and not value.strip()


def metadata_defects(record: dict) -> list[str]:
    defects = [key for key in REQUIRED if missing_required(record, key)]
    verification = record.get("verification") if isinstance(record.get("verification"), dict) else {}
    defects.extend("verification." + key for key in ("method", "summary", "status", "basis")
                   if not verification.get(key))
    return defects


def shingles(value: str, size: int = 3) -> set[str]:
    text = re.sub(r"\W+", "", value, flags=re.UNICODE)
    return {text[index:index + size] for index in range(max(0, len(text) - size + 1))}


def count(connection, table: str) -> int:
    return connection.execute(f"SELECT count(*) FROM {table}").fetchone()[0]


def load_active_vectors(connection: sqlite3.Connection, current_chunk_map: dict[int, str]) -> dict[int, tuple[str, tuple[float, ...]]]:
    table_names = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if not {"memory_vec_rowids", "memory_vec_vector_chunks00"}.issubset(table_names):
        return {}
    blobs = dict(connection.execute("SELECT rowid, vectors FROM memory_vec_vector_chunks00").fetchall())
    vecs: dict[int, tuple[str, tuple[float, ...]]] = {}
    for rowid, _, vcid, voff in connection.execute("SELECT rowid, id, chunk_id, chunk_offset FROM memory_vec_rowids"):
        if rowid in current_chunk_map and vcid in blobs:
            start = voff * 512 * 4
            blob = blobs[vcid]
            if start + 2048 <= len(blob):
                vecs[rowid] = (current_chunk_map[rowid], struct.unpack("<512f", blob[start:start + 2048]))
    return vecs


def analyze_vectors(vecs: dict[int, tuple[str, tuple[float, ...]]], meta_by_id: dict[str, dict]) -> dict:
    best_all: dict[tuple[str, str], float] = {}
    best_native: dict[tuple[str, str], float] = {}
    items = list(vecs.items())
    for i in range(len(items)):
        _, (mid1, v1) = items[i]
        is_hist1 = meta_by_id[mid1]["is_historical_import"]
        for j in range(i + 1, len(items)):
            _, (mid2, v2) = items[j]
            if mid1 == mid2:
                continue
            is_hist2 = meta_by_id[mid2]["is_historical_import"]
            both_hist = is_hist1 and is_hist2
            sim = sum(a * b for a, b in zip(v1, v2))
            if sim >= 0.88:
                pair = tuple(sorted((mid1, mid2)))
                if sim > best_all.get(pair, 0.0):
                    best_all[pair] = sim
            if not both_hist and sim >= 0.85:
                pair = tuple(sorted((mid1, mid2)))
                if sim > best_native.get(pair, 0.0):
                    best_native[pair] = sim

    codex_hist_pairs = sum(
        1 for (m1, m2) in best_all if meta_by_id[m1]["is_historical_import"] and meta_by_id[m2]["is_historical_import"]
    )
    native_mixed_ge_88 = sum(
        1 for (m1, m2) in best_all if not (meta_by_id[m1]["is_historical_import"] and meta_by_id[m2]["is_historical_import"])
    )
    native_top25 = []
    for (m1, m2), sim in sorted(best_native.items(), key=lambda x: (-x[1], x[0]))[:25]:
        native_top25.append({
            "a": m1,
            "b": m2,
            "a_title": meta_by_id[m1]["title"],
            "b_title": meta_by_id[m2]["title"],
            "cosine": round(sim, 4),
            "same_scope": meta_by_id[m1]["scope_key"] == meta_by_id[m2]["scope_key"],
            "both_native": (not meta_by_id[m1]["is_historical_import"]) and (not meta_by_id[m2]["is_historical_import"]),
        })
    return {
        "active_chunk_vectors_loaded": len(vecs),
        "pairs_cosine_ge_0_88": len(best_all),
        "codex_historical_pairs_ge_0_88": codex_hist_pairs,
        "native_or_mixed_pairs_ge_0_88": native_mixed_ge_88,
        "native_or_mixed_pairs_ge_0_85": len(best_native),
        "native_or_mixed_top25": native_top25,
    }


def main() -> None:
    args = arguments()
    config = load_config(args.config)
    source = Path(config["database"])
    watched = [source, Path(str(source) + "-wal")]
    before = {str(path): file_fingerprint(path) for path in watched}
    temporary_root = args.snapshot_root is None
    snapshot_root = Path(args.snapshot_root) if args.snapshot_root else Path(tempfile.mkdtemp(prefix="memory_test_snapshot-"))
    database, _ = snapshot_database(config, snapshot_root)
    now = datetime.now(timezone.utc)
    try:
        connection = read_snapshot(database)
        rows = connection.execute("SELECT * FROM memories ORDER BY created_at,id").fetchall()
        active = [row for row in rows if row["status"] == "active"]
        active_ids = {row["id"] for row in active}
        records, invalid_bodies = {}, []
        for row in rows:
            try:
                records[row["id"]] = json.loads(row["body"])
            except (json.JSONDecodeError, TypeError):
                invalid_bodies.append(row["id"])
        chunk_rows = connection.execute("SELECT * FROM memory_chunks").fetchall()
        current_revisions = {row["id"]: row["revision"] for row in active}
        current_chunks = [row for row in chunk_rows if row["memory_id"] in active_ids
                          and row["revision"] == current_revisions[row["memory_id"]]]
        missing = Counter()
        optional = Counter()
        source_counts, verification_status, verification_basis = Counter(), Counter(), Counter()
        stale, expired, historical = [], [], []
        parsed_active = []
        for row in active:
            record = records.get(row["id"], {})
            parsed_active.append((row, record))
            for key in metadata_defects(record):
                missing[key] += 1
            for key in OPTIONAL:
                if record.get(key) not in (None, "", [], {}):
                    optional[key] += 1
            verification = record.get("verification", {})
            verification_status[verification.get("status", "missing")] += 1
            verification_basis[verification.get("basis", "missing")] += 1
            for source_record in record.get("sources", []):
                source_counts[source_record.get("source_type", "missing")] += 1
            checked = [timestamp(source_record.get("checked_at")) for source_record in record.get("sources", [])]
            checked = [value for value in checked if value]
            latest_check = max(checked) if checked else timestamp(row["verified_at"])
            if latest_check and (now - latest_check).days >= args.stale_days:
                stale.append({"memory_id": row["id"], "revision": row["revision"],
                              "title": record.get("title"), "last_source_check": latest_check.isoformat(),
                              "verification": verification.get("status")})
            expires_at = timestamp(record.get("valid_for", {}).get("expires_at"))
            if expires_at and expires_at <= now:
                expired.append(row["id"])
            valid_to = timestamp((record.get("valid_time") or {}).get("valid_to"))
            if record.get("lifecycle") == "historical" or valid_to and valid_to <= now:
                historical.append(row["id"])

        exact_groups = defaultdict(list)
        signatures = []
        for row, record in parsed_active:
            title, content = record.get("title", ""), record.get("content", "")
            key = (row["project_id"], row["scope"], record.get("kind"), normalized(title), normalized(content))
            exact_groups[key].append(row["id"])
            signatures.append((row, record, normalized(title + " " + content), shingles(title + " " + content)))
        duplicates = [ids for ids in exact_groups.values() if len(ids) > 1]
        exact_ids = {memory_id for group in duplicates for memory_id in group}
        near_pairs = []
        for index, (left_row, left, left_text, left_shingles) in enumerate(signatures):
            if len(left_text) < 40:
                continue
            for right_row, right, right_text, right_shingles in signatures[index + 1:]:
                if len(right_text) < 40 or not left_shingles or not right_shingles:
                    continue
                union = left_shingles | right_shingles
                jaccard = len(left_shingles & right_shingles) / len(union)
                if jaccard < .60:
                    continue
                ratio = SequenceMatcher(None, left_text, right_text, autojunk=False).ratio()
                if ratio < .88:
                    continue
                near_pairs.append({"a": left_row["id"], "b": right_row["id"],
                                   "a_title": left.get("title"), "b_title": right.get("title"),
                                   "similarity": round(ratio, 4), "trigram_jaccard": round(jaccard, 4),
                                   "same_scope": left_row["project_id"] == right_row["project_id"]
                                   and left_row["scope"] == right_row["scope"],
                                   "exact_text": left_text == right_text})
        near_pairs.sort(key=lambda pair: (-pair["similarity"], pair["a"], pair["b"]))
        table_names = {row[0] for row in connection.execute("SELECT name FROM sqlite_master")}
        table_counts = {table: count(connection, table) for table in
                        ("memories", "memory_chunks", "memory_versions", "proposals", "events",
                         "tombstones", "retired_memories", "learning_events", "association_edges")
                        if table in table_names}
        try:
            quick_check = connection.execute("PRAGMA quick_check").fetchone()[0]
        except sqlite3.Error as error:  # vec0 availability differs in Python; report, never repair.
            quick_check = f"unavailable: {error}"
        chunk_lengths = [utf16_length(row["text"]) for row in current_chunks]
        chunks_per_memory = Counter(row["memory_id"] for row in current_chunks)

        meta_by_id = {}
        header_stubs = []
        midword_fragments = []
        implicit_supersede = []
        by_title = defaultdict(list)
        supersede_re = re.compile(r"本条更新此前|更新此前|取代.{0,15}旧|替代此前|不再保留")
        for row, record in parsed_active:
            rid = row["id"]
            tags = record.get("tags") or []
            title = str(record.get("title") or "")
            content = str(record.get("content") or "")
            is_hist = ("codex-memory" in tags) or ("historical-source" in tags)
            meta_by_id[rid] = {
                "title": title,
                "is_historical_import": is_hist,
                "scope_key": (row["project_id"], row["scope"]),
            }
            by_title[(row["project_id"], row["scope"], normalized(title))].append(rid)
            if is_hist:
                if "rollout_path:" in content and len(content) < 350:
                    header_stubs.append({"memory_id": rid, "title": title, "content_length": len(content)})
                lines = [ln for ln in content.splitlines() if ln.strip() and not ln.startswith("[Codex 历史记忆")]
                if lines and re.match(r"^[a-z]{1,4}\s", lines[0]):
                    midword_fragments.append({"memory_id": rid, "title": title, "first_line": lines[0][:80]})
            if supersede_re.search(content):
                implicit_supersede.append({
                    "memory_id": rid,
                    "revision": row["revision"],
                    "title": title,
                    "lifecycle": record.get("lifecycle"),
                    "subject_id": record.get("subject_id"),
                    "context_key": record.get("context_key"),
                    "excerpt": content[:180],
                })

        current_chunk_map = {row["id"]: row["memory_id"] for row in current_chunks}
        vecs = load_active_vectors(connection, current_chunk_map)
        vector_near_pairs = analyze_vectors(vecs, meta_by_id)
        duplicate_exact_titles = [
            {"title": meta_by_id[ids[0]]["title"], "ids": ids}
            for (_, _, _), ids in by_title.items() if len(ids) > 1
        ]
        historical_import_audit = {
            "codex_historical_records": sum(1 for m in meta_by_id.values() if m["is_historical_import"]),
            "share_of_active": round(sum(1 for m in meta_by_id.values() if m["is_historical_import"]) / max(1, len(parsed_active)), 4),
            "header_stub_count": len(header_stubs),
            "header_stub_samples": header_stubs[:10],
            "midword_fragment_count": len(midword_fragments),
            "midword_fragment_samples": midword_fragments[:10],
        }
        implicit_supersession_candidates = {
            "subject_id_present": optional["subject_id"],
            "subject_id_coverage": round(optional["subject_id"] / max(1, len(parsed_active)), 4),
            "context_key_present": optional["context_key"],
            "context_key_coverage": round(optional["context_key"] / max(1, len(parsed_active)), 4),
            "duplicate_exact_title_groups": duplicate_exact_titles,
            "explicit_update_wording_count": len(implicit_supersede),
            "explicit_update_wording_records": implicit_supersede,
        }

        report = {
            "format": "shared-agent-memory/evolve-data-probe-v1",
            "generated_at": now.isoformat(),
            "schema_version": connection.execute("PRAGMA user_version").fetchone()[0],
            "quick_check": quick_check,
            "source_protection": {"mode": "SQLite backup through mode=ro source; all analysis on snapshot",
                                  "before": before},
            "snapshot": {"path": str(database), "sha256": sha256(database)},
            "summary": {
                "records_total": len(rows), "records_active": len(active),
                "records_inactive": len(rows) - len(active), "chunks_total": len(chunk_rows),
                "chunks_active_current_revision": len(current_chunks),
                "multi_chunk_active_records": sum(size > 1 for size in chunks_per_memory.values()),
                "invalid_body_json": len(invalid_bodies),
                "required_metadata_incomplete_records": sum(bool(metadata_defects(record)) for _, record in parsed_active),
                "exact_duplicate_groups": len(duplicates),
                "exact_duplicate_redundant_records": sum(len(group) - 1 for group in duplicates),
                "near_duplicate_pairs": len(near_pairs),
                "stale_review_candidates": len(stale),
                "active_expired_records": len(expired), "active_historical_records": len(historical)},
            "table_counts": table_counts,
            "chunk_utf16_length": distribution(chunk_lengths),
            "chunk_token_count": distribution([row["tokens"] for row in current_chunks]),
            "record_content_utf16_length": distribution(utf16_length(record.get("content", "")) for _, record in parsed_active),
            "metadata": {"required_missing": dict(missing), "optional_present": dict(optional),
                         "source_types": dict(source_counts), "verification_status": dict(verification_status),
                         "verification_basis": dict(verification_basis),
                         "records_without_source_hash": sum(not any(source.get("source_hash") for source in record.get("sources", []))
                                                              for _, record in parsed_active)},
            "duplicate_candidates": {"exact_groups": duplicates, "near_pairs": near_pairs[:100],
                                     "near_pair_ids_truncated": len(near_pairs) > 100,
                                     "exact_duplicate_record_ids": sorted(exact_ids)},
            "vector_near_pairs": vector_near_pairs,
            "historical_import_audit": historical_import_audit,
            "implicit_supersession_candidates": implicit_supersession_candidates,
            "zombie_review": {"definition": f"active records whose latest source check is at least {args.stale_days} days old; review, never auto-delete",
                              "stale_candidates": stale, "expired_ids": expired, "historical_ids": historical,
                              "inactive_ids": [row["id"] for row in rows if row["status"] != "active"]},
            "samples": [{"memory_id": row["id"], "revision": row["revision"],
                         "title": record.get("title"), "content_utf16_length": utf16_length(record.get("content", "")),
                         "tags": record.get("tags", []), "sources": len(record.get("sources", []))}
                        for row, record in parsed_active[::max(1, len(parsed_active) // 12)][:12]]
        }
        connection.close()
    finally:
        after = {str(path): file_fingerprint(path) for path in watched}
        report["source_protection"]["after"] = after
        report["source_protection"]["unchanged_during_probe"] = before == after
        destination = write_report(args.output, report)
        if temporary_root:
            shutil.rmtree(snapshot_root)
            report["snapshot"]["removed_after_probe"] = True
            write_report(destination, report)
    print(json.dumps({"output": str(destination), "summary": report["summary"],
                      "source_unchanged": before == after}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
