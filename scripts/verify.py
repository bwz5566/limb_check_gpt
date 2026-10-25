#!/usr/bin/env python3
"""Run required software checks; Node is needed only for frontend unit tests."""
import shutil
import subprocess
import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
commands = [[sys.executable, 'scripts/doctor.py'], [sys.executable, '-m', 'unittest', 'discover', '-s', 'tests', '-v']]
if not shutil.which('node'):
    print('完整开发自检需要 Node.js 20+；日常运行服务器不需要 Node。', file=sys.stderr)
    raise SystemExit(1)
commands.append(['node', '--test', *[str(p.relative_to(ROOT)) for p in sorted((ROOT/'tests').glob('*.test.js'))]])
for command in commands:
    print('运行:', ' '.join(command), flush=True)
    result = subprocess.run(command, cwd=ROOT)
    if result.returncode: raise SystemExit(result.returncode)
print('软件自检通过；这不代表真实场景检测准确率已验证。')
