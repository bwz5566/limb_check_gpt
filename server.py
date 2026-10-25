#!/usr/bin/env python3
"""Run: python3 server.py [--env development|test|production] [--port 8000]."""
import argparse
import sys
from backend.config import load_config
from backend.http import create_server


def main():
    parser = argparse.ArgumentParser(description="肢体检测验证工作台（本机版）")
    parser.add_argument("--env", default="development", choices=["development", "test", "production"])
    parser.add_argument("--port", type=int)
    args = parser.parse_args()
    try:
        config = load_config(args.env)
        if args.port is not None:
            if not 1 <= args.port <= 65535:
                raise ValueError("端口须为 1–65535")
            config["port"] = args.port
        server = create_server(config)
    except (ValueError, OSError) as exc:
        print(f"启动失败：{exc}", file=sys.stderr)
        return 1
    print(f"肢体检测验证工作台：http://localhost:{server.server_port}", flush=True)
    print(f"环境：{args.env}；模型复核：{'开启' if config['vlm']['enabled'] else '关闭'}；Ctrl+C 停止", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
