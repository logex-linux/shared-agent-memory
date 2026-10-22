# Third-party sources

This repository contains the project's source and model hash manifest, not vendored dependency code or model weights. Install dependencies through the committed lockfile; download models explicitly through the installer.

| Component | Upstream | License reported by installed package metadata |
|---|---|---|
| Transformers.js | https://github.com/huggingface/transformers.js | Apache-2.0 |
| MCP TypeScript SDK | https://github.com/modelcontextprotocol/typescript-sdk | MIT |
| sqlite-vec | https://github.com/asg017/sqlite-vec | MIT OR Apache |
| Zod | https://github.com/colinhacks/zod | MIT |

The model downloader uses `Xenova/bge-small-zh-v1.5` at revision `75c43b069aac4d136ba6bc1122f995fedcfd2781`, with the original reference `BAAI/bge-small-zh-v1.5` at revision `7999e1d3359715c523056ef9478215996d62a620`. Artifact hashes are recorded in [docs/model-manifest.json](docs/model-manifest.json). Consult the respective upstream model repositories for their licensing terms:

- https://huggingface.co/Xenova/bge-small-zh-v1.5
- https://huggingface.co/BAAI/bge-small-zh-v1.5

Transitive packages, including the ONNX runtime, retain their own upstream notices. The project's MIT license does not replace third-party licenses.
