#!/usr/bin/env python3
"""Verify the offline asset bundle without loading model inference."""
import hashlib
import json
import sqlite3
import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from backend.config import load_config


def main():
    failures = []
    print(f"Python {sys.version.split()[0]}; SQLite {sqlite3.sqlite_version}")
    if sys.version_info < (3, 10): failures.append("需要 Python 3.10+")
    for environment in ("development", "test", "production"):
        try: load_config(environment); print(f"配置 {environment}: OK")
        except Exception as exc: failures.append(f"配置 {environment}: {exc}")
    manifest = json.loads((ROOT / 'config/assets.json').read_text(encoding='utf-8'))
    for asset in manifest['assets']:
        path = ROOT / asset['path']
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != asset['sha256']:
            failures.append(f"文件缺失或 SHA-256 不匹配: {asset['path']}")
        else: print(f"模型/运行库 OK: {asset['path']}")
    if failures:
        print('\n'.join(failures), file=sys.stderr); return 1
    print('文件与配置检查通过；实际推理请在浏览器加载模型并运行空白画面自检。')
    return 0


if __name__ == '__main__': raise SystemExit(main())
