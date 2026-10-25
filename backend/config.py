"""Configuration files are private; only public_config reaches the browser."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VERSION = "0.1.0"
CHECKS = ("limbs", "fingers", "nails", "tattoo", "scar", "hair")
STATUSES = ("clear", "flag", "uncertain", "not_assessed")


def load_config(environment="development", root=ROOT):
    if environment not in ("development", "test", "production"):
        raise ValueError("环境只能为 development、test、production")
    path = root / "config" / f"{environment}.json"
    config = json.loads(path.read_text(encoding="utf-8"))
    local = root / "config" / f"{environment}.local.json"
    if local.exists():
        override = json.loads(local.read_text(encoding="utf-8"))
        for key, value in override.items():
            if isinstance(value, dict) and isinstance(config.get(key), dict):
                config[key].update(value)
            else:
                config[key] = value
    config["environment"] = environment
    config["rules"] = json.loads((root / "config/rules.json").read_text(encoding="utf-8"))
    if config["host"] not in ("127.0.0.1", "localhost"):
        raise ValueError("当前版本仅支持本机回环地址；不要直接暴露到公网")
    if not isinstance(config["port"], int) or not 1 <= config["port"] <= 65535:
        raise ValueError("port 必须在 1–65535 之间")
    return config


def public_config(config):
    vlm = config["vlm"]
    return {"version": VERSION, "environment": config["environment"],
            "rules": config["rules"], "checks": list(CHECKS),
            "vlm": {"enabled": vlm["enabled"], "model": vlm["model"] if vlm["enabled"] else None},
            "limits": {"request_bytes": config["max_request_bytes"]}}
