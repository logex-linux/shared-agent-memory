"""Explicit installation step. Runtime never downloads models."""
import hashlib
import json
import pathlib
import sys
import urllib.request

repo = 'Xenova/bge-small-zh-v1.5'
revision = '75c43b069aac4d136ba6bc1122f995fedcfd2781'
root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '.local/models/bge-small-zh-v1.5').resolve()
files = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'onnx/model.onnx', 'onnx/model_quantized.onnx']
manifest = {'repo': repo, 'revision': revision, 'reference_repo': 'BAAI/bge-small-zh-v1.5', 'reference_revision': '7999e1d3359715c523056ef9478215996d62a620', 'files': {}}
expected = json.loads((pathlib.Path(__file__).resolve().parent.parent / 'docs/model-manifest.json').read_text())
for name in files:
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(f'https://huggingface.co/{repo}/resolve/{revision}/{name}', headers={'User-Agent': 'SharedAgentMemory/0.1'})
    with urllib.request.urlopen(request, timeout=120) as response, open(str(path) + '.part', 'wb') as target:
        while block := response.read(1024 * 1024):
            target.write(block)
    partial = pathlib.Path(str(path) + '.part')
    digest = hashlib.sha256(partial.read_bytes()).hexdigest()
    if digest != expected['files'][name]:
        partial.unlink()
        raise RuntimeError(f'Model hash mismatch: {name}')
    partial.rename(path)
    manifest['files'][name] = digest
    print(name, path.stat().st_size, flush=True)
(root / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
