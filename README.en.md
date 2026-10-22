# Shared Agent Memory

[中文文档](README.md) · [MIT license](LICENSE)

A local shared-memory service for AI agents on the same machine. It exposes a standard MCP STDIO server and CLI backed by one SQLite database, with local embeddings, keyword retrieval, versioned records and traceable sources.

Agents search the whole library with task-specific queries, receive relevant excerpts, then expand selected records by ID. Project IDs are optional search filters, not a required preselection of task memories. Integrate the server into your own agent harness.

## Quick start

Requires Node.js **24.18.0**, npm, Python 3 and Git. Paths target macOS/Linux. The bundled model manifest selects the Chinese-oriented `bge-small-zh-v1.5` model: CPU, FP32, 512 dimensions, CLS pooling and L2 normalization.

```sh
git clone https://github.com/logex-linux/shared-agent-memory.git ~/.agents/shared-agent-memory
cd ~/.agents/shared-agent-memory
nvm install
nvm use
npm ci
npm run build
npm run model:download
npm run setup -- --project /absolute/path/to/your-work-project
```

Use an existing matching Node installation if you do not use nvm. The model download is explicit, revision-pinned and SHA-256 verified. Runtime downloads are disabled.

Setup creates an empty database and configuration in `~/.local/share/shared-agent-memory/`, plus role-specific client templates under `client-configs/read-only/`, `project-rw/`, and `admin/`. Setup requires an explicit real work-project path; the service directory is separate. It refuses to overwrite an existing configuration and never edits client settings. Use `--root /absolute/data/path` to change the data directory.

## MCP

Use the generated template, or replace the absolute paths in [examples/mcp.json](examples/mcp.json). All clients should point to the same config and database. Client-specific configuration and approval rules belong to the harness.

Daily agents use `config.json`: recall only, with whole-library search. `project.config.json` grants writes within the selected project; `admin.config.json` grants global management and review. Only enabled tools are exposed. Server-side permission checks do not infer human authorization from a prompt.

Available tools:

| Tool | Purpose |
|---|---|
| `memory_recall` | Search relevant excerpts or expand records by ID |
| `memory_propose` | Save an unpublished candidate |
| `memory_commit` | Atomically publish a candidate and its indexes |
| `memory_forget` | Erase a record, dependent bodies and managed copies |

```json
{"query":"What should I check when screen-recording permission breaks after rebuilding?","limit":3}
```

The default setup enables all registered projects and global records. Omit `project_id` to search across projects; provide it to narrow results. A project-filtered query excludes global records unless `include_global: true` is set.

Use `{"ids":["a-real-memory-id"]}` to read selected full records. The example placeholder must be replaced with a returned UUID. Results include sources, revisions and applicability. Identifier matches provide a finite ranking boost; set `exact_only: true` for strict identifier filtering. Vector similarity expresses relevance, not factual certainty. Verification defaults to `unverified`; `verified` requires privileged review with evidence, while `disputed` preserves disagreements. The server records configuration identity separately from self-reported author labels. The default model is optimized for Chinese; evaluate other languages for your workload.

To save, propose then commit. A new record uses revision 0; updates require the current revision and retain the memory ID. Write only with the user's authorization. See [protocol](docs/protocol.md) for complete payloads.

## CLI and tests

```sh
export SHARED_MEMORY_CONFIG="$HOME/.local/share/shared-agent-memory/config.json"
npm run cli -- inspect --config "$HOME/.local/share/shared-agent-memory/admin.config.json"
npm run cli -- check --config "$HOME/.local/share/shared-agent-memory/admin.config.json"
npm run cli -- recall --input examples/recall.json
npm test
```

The MCP server and CLI share the same core. Tests use synthetic data and temporary databases; they cover semantic retrieval, SDK STDIO calls, lifecycle operations, four-process concurrent writes, revision races and SIGKILL recovery. Generated reports remain untracked under `test-results/`.

This is a same-host local service, not OS-level isolation between hostile processes. Retrieved excerpts enter the connected agent's model context. Forgetting cannot retract prior chat context or erase unmanaged backups and system snapshots. See [operations](docs/operations.md).

Source code is MIT-licensed. Dependencies and model artifacts retain their upstream licenses; weights and personal memories are not included. See [third-party notices](THIRD_PARTY_NOTICES.md).

See [scale measurements](docs/scale-benchmark.md) and [0.2.0 repair notes](docs/repairs-0.2.0.md) for regression coverage, restore requirements and permission changes.

## On-demand retrieval (0.3.0)

Schema 5 uses scoped cosine KNN, chunk FTS and indexed identifiers before loading selected metadata and hit excerpts. Ordinary recall reads no full memory bodies. ID expansion remains explicit. `token_budget` can reduce the configured `response_token_budget` (default 6000 estimated tokens, UTF-8 JSON bytes / 3 rounded up); 32,000 payload bytes and 5,000 content characters remain hard caps. Diagnostics distinguish returned vector rows from unobservable internal scans. See the [architecture, migration and A/B report](docs/retrieval-architecture.md).
