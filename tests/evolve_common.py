"""Local-only helpers for beta7 evolution forensics. No production writes."""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import sqlite3
import tempfile
from typing import Any, Iterable

DEFAULT_CONFIG = Path.home() / "Library/Application Support/SharedAgentMemory/config.json"
DEFAULT_OUTPUT = Path(".local/evolve-v1")


def load_config(path: str | os.PathLike[str] = DEFAULT_CONFIG) -> dict[str, Any]:
    config_path = Path(path).expanduser().resolve()
    with config_path.open(encoding="utf-8") as handle:
        config = json.load(handle)
    database = Path(config["database"]).expanduser().resolve()
    if not database.is_file():
        raise FileNotFoundError(f"Memory database not found: {database}")
    config["database"] = str(database)
    config["model_dir"] = str(Path(config["model_dir"]).expanduser().resolve())
    return config


def sha256(path: str | os.PathLike[str]) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def file_fingerprint(path: str | os.PathLike[str]) -> dict[str, Any]:
    target = Path(path)
    if not target.exists():
        return {"exists": False}
    stat = target.stat()
    return {"exists": True, "bytes": stat.st_size, "mtime_ns": stat.st_mtime_ns,
            "sha256": sha256(target)}


def snapshot_database(config: dict[str, Any], root: str | os.PathLike[str] | None = None) -> tuple[Path, Path]:
    """Take a consistent SQLite backup through a read-only source connection."""
    snapshot_root = Path(root) if root else Path(tempfile.mkdtemp(prefix="memory_test_snapshot-"))
    snapshot_root.mkdir(parents=True, exist_ok=True)
    if snapshot_root.resolve() in {Path(tempfile.gettempdir()), Path.home(), Path("/")}:
        raise ValueError("Snapshot root must be a dedicated directory")
    destination = snapshot_root / "memory.db"
    if destination.exists():
        raise FileExistsError(f"Refusing to overwrite snapshot: {destination}")
    source_path = Path(config["database"]).resolve()
    source = sqlite3.connect(f"file:{source_path}?mode=ro", uri=True)
    try:
        source.execute("PRAGMA query_only=ON")
        target = sqlite3.connect(destination)
        try:
            source.backup(target)
        finally:
            target.close()
    finally:
        source.close()
    copy = dict(config)
    copy["database"] = str(destination.resolve())
    copy["operations"] = ["recall"]
    copy["connection_id"] = "evolve-read-only-benchmark"
    copy["diagnostics"] = False
    config_path = snapshot_root / "config.json"
    config_path.write_text(json.dumps(copy, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(config_path, 0o600)
    return destination.resolve(), config_path.resolve()


def read_snapshot(path: str | os.PathLike[str]) -> sqlite3.Connection:
    resolved = Path(path).resolve()
    connection = sqlite3.connect(f"file:{resolved}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    return connection


def percentile(values: Iterable[float], probability: float) -> float | None:
    ordered = sorted(float(value) for value in values)
    if not ordered:
        return None
    index = min(len(ordered) - 1, max(0, math.ceil(probability * len(ordered)) - 1))
    return round(ordered[index], 3)


def distribution(values: Iterable[float]) -> dict[str, float | int | None]:
    materialized = list(values)
    return {"count": len(materialized), "p50": percentile(materialized, .50),
            "p90": percentile(materialized, .90), "p95": percentile(materialized, .95),
            "p99": percentile(materialized, .99),
            "max": round(max(materialized), 3) if materialized else None}


def utf16_length(text: str) -> int:
    return len(text.encode("utf-16-le")) // 2


def estimated_tokens(value: str | bytes) -> int:
    size = len(value) if isinstance(value, bytes) else len(value.encode("utf-8"))
    return math.ceil(size / 3)


def write_report(path: str | os.PathLike[str], report: dict[str, Any]) -> Path:
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".tmp")
    temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.chmod(temporary, 0o600)
    temporary.replace(destination)
    return destination
