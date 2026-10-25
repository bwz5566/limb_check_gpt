#!/usr/bin/env python3
"""Consistent SQLite backup, including evidence and annotation history."""
import argparse
import sqlite3
import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from backend.config import load_config
parser = argparse.ArgumentParser()
parser.add_argument('--env', default='development', choices=['development','test','production'])
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
source = ROOT / load_config(args.env)['data_dir'] / 'workbench.sqlite3'
if not source.exists(): parser.error('数据库不存在')
if args.output.exists(): parser.error('目标已存在，请使用新的备份文件名')
args.output.parent.mkdir(parents=True, exist_ok=True)
with sqlite3.connect(source) as src, sqlite3.connect(args.output) as dst: src.backup(dst)
print(f'已备份至 {args.output}；包含证据和人工标签，请按原数据权限保管。')
