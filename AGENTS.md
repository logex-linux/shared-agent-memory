# Development

Use Node 24.18.0 (`.nvmrc`) and the committed lockfile. Run `npm run build` and `npm test` after core changes. Tests require the explicitly downloaded model in `.local/models/bge-small-zh-v1.5` and use disposable databases.

`src/core/` is the shared implementation for both CLI and MCP. Preserve revision checks, idempotent write receipts, scope filtering, source metadata, and explicit degradation behavior when changing retrieval or writes.

Keep databases, model weights, credentials, local configuration, generated client settings and test reports out of Git. Use synthetic fixtures in tests and examples. Do not add harness-specific auto-approval or automatic memory writes.
