#!/usr/bin/env python3
"""Offline evaluation of saved DB or API-exported manifest.jsonl."""
import argparse
import json
import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from backend.config import load_config
from backend.evaluation import evaluate
from backend.store import Store

parser = argparse.ArgumentParser(description='计算已标注样本指标；模拟样本自动排除')
parser.add_argument('--env', choices=['development','test','production'], default='development')
parser.add_argument('--manifest', type=Path)
parser.add_argument('--dataset', default='')
parser.add_argument('--rule-version', default='')
parser.add_argument('--engine', default='')
parser.add_argument('--output', type=Path)
args = parser.parse_args()
if args.manifest:
    rows = []
    for line in args.manifest.read_text(encoding='utf-8').splitlines():
        if line.strip():
            item = json.loads(line); rows.append({'report': item, 'annotation': item.get('annotation')})
else:
    config = load_config(args.env)
    path = ROOT / config['data_dir'] / 'workbench.sqlite3'
    if not path.exists(): parser.error('尚无数据库，请先保存报告并标注')
    rows = Store(path).evaluation_rows()
result = evaluate(rows, dataset=args.dataset, rule_version=args.rule_version, engine=args.engine)
text = json.dumps(result, ensure_ascii=False, indent=2)
if args.output:
    args.output.parent.mkdir(parents=True, exist_ok=True); args.output.write_text(text+'\n', encoding='utf-8')
print(text)
