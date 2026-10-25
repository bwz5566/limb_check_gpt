"""Loopback-only HTTP API and allowlisted web root."""
import csv
import io
import json
import mimetypes
import secrets
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit
from .config import ROOT, public_config
from .evaluation import evaluate
from .store import Store
from .vlm import review


def create_server(config, port=None, data_path=None):
    store = Store(data_path or ROOT / config["data_dir"] / "workbench.sqlite3")
    token = secrets.token_urlsafe(32)
    web_root = (ROOT / "web").resolve()

    class Handler(BaseHTTPRequestHandler):
        server_version = "LimbWorkbench/0.1"

        def setup(self):
            super().setup()
            self.connection.settimeout(75)

        def send_bytes(self, status, body, content_type="application/json; charset=utf-8", extra=None):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'")
            for key, value in (extra or {}).items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(body)

        def send_json(self, status, obj):
            self.send_bytes(status, json.dumps(obj, ensure_ascii=False, allow_nan=False).encode("utf-8"))

        def allowed_host(self):
            return self.headers.get("Host") in (f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}")

        def do_GET(self):
            if not self.allowed_host():
                return self.send_json(403, {"error": "仅允许本机地址访问"})
            url = urlsplit(self.path)
            path = unquote(url.path)
            query = parse_qs(url.query)
            try:
                if path == "/api/health":
                    return self.send_json(200, {"status": "ok", "version": "0.1.0"})
                if path == "/api/config":
                    return self.send_json(200, {**public_config(config), "csrf_token": token})
                if path == "/api/reports":
                    limit = max(1, min(100, int(query.get("limit", [100])[0])))
                    offset = max(0, int(query.get("offset", [0])[0]))
                    return self.send_json(200, store.list(limit, offset))
                if path == "/api/evaluation":
                    return self.send_json(200, evaluate(store.evaluation_rows(), **{k: query.get(k, [""])[0] for k in ("dataset", "rule_version", "engine")}))
                if path == "/api/export/manifest":
                    rows = store.evaluation_rows()
                    body = "\n".join(json.dumps({"id": r["id"], "sample_name": r["report"]["sample_name"], "source": r["report"]["source"], "run_id": r["report"]["run_id"], "engine": r["report"]["engine"], "rule_version": r["report"]["rule_version"], "checks": r["report"]["checks"], "annotation": r["annotation"], "synthetic": r["report"].get("synthetic", False)}, ensure_ascii=False) for r in rows)
                    return self.send_bytes(200, body.encode(), "application/x-ndjson", {"Content-Disposition": 'attachment; filename="manifest.jsonl"'})
                if path == "/api/export/csv":
                    buffer = io.StringIO(newline="")
                    writer = csv.writer(buffer)
                    writer.writerow(["id", "sample_name", "check", "prediction", "label", "engine", "rule_version"])
                    for row in store.evaluation_rows():
                        r = row["report"]
                        for k, v in r["checks"].items():
                            values = [row["id"], r["sample_name"], k, v["status"], (row["annotation"] or {}).get("labels", {}).get(k, ""), r["engine"], r["rule_version"]]
                            writer.writerow(["'" + x if isinstance(x, str) and x.startswith(("=", "+", "-", "@", "\t", "\r")) else x for x in values])
                    return self.send_bytes(200, ("\ufeff" + buffer.getvalue()).encode(), "text/csv; charset=utf-8", {"Content-Disposition": 'attachment; filename="results.csv"'})
                if path.startswith("/api/reports/"):
                    row = store.get(path.removeprefix("/api/reports/"))
                    return self.send_json(200 if row else 404, row or {"error": "报告不存在"})
                if path.startswith("/api/"):
                    return self.send_json(404, {"error": "接口不存在"})
                target = (web_root / (path.lstrip("/") or "index.html")).resolve()
                if not target.is_relative_to(web_root) or not target.is_file() or any(x.startswith(".") for x in target.relative_to(web_root).parts):
                    return self.send_json(404, {"error": "文件不存在"})
                mime = {".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm", ".task": "application/octet-stream"}.get(target.suffix) or mimetypes.guess_type(target)[0] or "application/octet-stream"
                return self.send_bytes(200, target.read_bytes(), mime)
            except (ValueError, TypeError):
                self.send_json(400, {"error": "请求参数无效"})

        def do_POST(self):
            if not self.allowed_host() or self.headers.get("X-CSRF-Token") != token:
                return self.send_json(403, {"error": "请求校验失败，请刷新页面"})
            origin = self.headers.get("Origin")
            if origin and origin not in (f"http://127.0.0.1:{self.server.server_port}", f"http://localhost:{self.server.server_port}"):
                return self.send_json(403, {"error": "不允许跨站请求"})
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= config["max_request_bytes"]:
                    return self.send_json(413, {"error": "请求为空或超过大小限制"})
                if self.headers.get_content_type() != "application/json":
                    return self.send_json(415, {"error": "需要 application/json"})
                data = json.loads(self.rfile.read(length), parse_constant=lambda x: (_ for _ in ()).throw(ValueError("禁止 NaN/Infinity")))
                if not isinstance(data, dict):
                    raise ValueError("请求须为 JSON 对象")
                path = urlsplit(self.path).path
                if path == "/api/reports":
                    if data.get("consent") is not True:
                        raise ValueError("保存报告前需要授权")
                    return self.send_json(201, {"id": store.save(data.get("report"))})
                if path.startswith("/api/reports/") and path.endswith("/annotation"):
                    identity = path[len("/api/reports/"):-len("/annotation")]
                    store.annotate(identity, data)
                    return self.send_json(200, {"ok": True})
                if path == "/api/review":
                    return self.send_json(200, review(config, data))
                return self.send_json(404, {"error": "接口不存在"})
            except (ValueError, TypeError, UnicodeDecodeError) as exc:
                self.send_json(400, {"error": str(exc)[:300]})
            except KeyError:
                self.send_json(404, {"error": "报告不存在"})
            except RuntimeError as exc:
                self.send_json(502, {"error": str(exc)[:300]})
            except Exception:
                self.send_json(500, {"error": "服务内部错误，请查看本地运行环境"})

        def log_message(self, fmt, *args):
            # Do not log report contents, model credentials or evidence.
            if args and str(args[1] if len(args) > 1 else "").startswith(("4", "5")):
                super().log_message(fmt, *args)

    return ThreadingHTTPServer((config["host"], config["port"] if port is None else port), Handler)
