import base64
import copy
import json
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from backend.config import CHECKS, load_config, public_config
from backend.evaluation import evaluate
from backend.http import create_server
from backend.store import Store
from backend.validation import validate_report, image_data
from backend.vlm import parse_output


def report(run_id="sample-1", status="clear"):
    return {"schema_version": "1.0", "run_id": run_id, "source": "image", "sample_name": "sample.png", "created_at": "2026-10-25T00:00:00Z", "engine": "test-engine", "rule_version": "test-rules", "latency_ms": 20, "checks": {k: {"status": status, "reason": "test"} for k in CHECKS}, "evidence": [], "frames": []}


class EvaluationTests(unittest.TestCase):
    def test_abstention_is_not_accuracy_and_positive_denominator_includes_it(self):
        rows = []
        for i, (actual, predicted) in enumerate([("flag", "flag"), ("flag", "clear"), ("flag", "uncertain"), ("clear", "clear"), ("clear", "flag")]):
            rows.append({"report": report(str(i), predicted), "annotation": {"labels": {"fingers": actual}}})
        result = evaluate(rows)["checks"]["fingers"]
        self.assertEqual([result[k] for k in ("tp", "tn", "fp", "fn", "abstained")], [1, 1, 1, 1, 1])
        self.assertEqual(result["coverage"], .8)
        self.assertEqual(result["accuracy_decided"], .5)
        self.assertEqual(result["detection_rate_all_positive"], .3333)

    def test_empty_and_synthetic_are_not_perfect_accuracy(self):
        self.assertIsNone(evaluate([])["checks"]["fingers"]["accuracy_decided"])
        r = report(); r["synthetic"] = True
        self.assertEqual(evaluate([{"report": r, "annotation": {"labels": {"fingers": "clear"}}}])["samples"], 0)

    def test_filters_and_mixed_versions(self):
        a, b = report("a"), report("b"); b["rule_version"] = "v2"
        rows = [{"report": x, "annotation": {"dataset": "validation", "labels": {"fingers": "clear"}}} for x in [a, b]]
        self.assertTrue(evaluate(rows)["mixed_versions"])
        self.assertEqual(evaluate(rows, rule_version="v2")["samples"], 1)
        self.assertEqual(evaluate(rows, dataset="train")["samples"], 0)


class StoreTests(unittest.TestCase):
    def test_concurrent_duplicate_saves_are_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp) / 'db.sqlite3')
            with ThreadPoolExecutor(max_workers=12) as pool:
                ids = list(pool.map(lambda _: store.save(report('same-run')), range(24)))
            self.assertEqual(len(set(ids)), 1)
            self.assertEqual(store.list()['total'], 1)

    def test_connection_is_closed_after_context_for_windows_file_locks(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp) / 'db.sqlite3')
            with store.connect() as db:
                db.execute('SELECT 1')
            with self.assertRaises(sqlite3.ProgrammingError):
                db.execute('SELECT 1')

    def test_report_collections_must_be_renderable(self):
        for change in [{"frames": "not-an-array"}, {"steps": {}}, {"limitations": [3]}, {"synthetic": "false"}]:
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_report({**report(), **change})

    def test_persistence_idempotency_and_annotation_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "test.sqlite3"
            store = Store(path); identity = store.save(report())
            self.assertEqual(store.save(report()), identity)
            self.assertEqual(Store(path).get(identity)["report"]["run_id"], "sample-1")
            for label in ["flag", "clear"]:
                store.annotate(identity, {"reviewer": "tester", "labels": {"fingers": label}})
            self.assertEqual(store.get(identity)["annotation"]["labels"]["fingers"], "clear")
            with store.connect() as db:
                self.assertEqual(db.execute("SELECT COUNT(*) FROM annotation_history").fetchone()[0], 2)
            self.assertEqual(store.list()["total"], 1)

    def test_reject_unknown_or_missing_checks_and_nonfinite_latency(self):
        for change in [{"checks": {}}, {"latency_ms": float("nan")}, {"source": "unknown"}]:
            with self.subTest(change=change), self.assertRaises(ValueError): validate_report({**report(), **change})

    def test_image_rejects_urls_svg_and_invalid_payload(self):
        for value in ["https://example.com/image.jpg", "data:image/svg+xml;base64,AAA=", "data:image/png;base64,invalid"]:
            with self.subTest(value=value), self.assertRaises(ValueError): image_data(value)


class VLMTests(unittest.TestCase):
    def test_output_must_not_contain_untrusted_extra_fields(self):
        value = {"checks": {"fingers": {"status": "clear", "reason": "test", "confidence": .9, "unrequested_attribute": "ignore"}}, "extra": "ignore"}
        parsed = parse_output(json.dumps(value), ["fingers"])
        self.assertNotIn("extra", parsed)
        self.assertNotIn("unrequested_attribute", parsed["checks"]["fingers"])

    def test_strict_schema_low_confidence_and_code_fence(self):
        text = json.dumps({"checks": {"fingers": {"status": "clear", "reason": "visible", "confidence": .4}}})
        self.assertEqual(parse_output(f"```json\n{text}\n```", ["fingers"])["checks"]["fingers"]["status"], "uncertain")
        with self.assertRaises(ValueError): parse_output(text, ["nails"])
        with self.assertRaises(ValueError): parse_output('{"checks":{"fingers":{"status":"pass","reason":"a","confidence":1}}}', ["fingers"])

    def test_secrets_not_in_public_config(self):
        config = load_config(); config["vlm"]["api_key"] = "fake-test-secret"
        self.assertNotIn("fake-test-secret", json.dumps(public_config(config)))
        self.assertNotIn("base_url", json.dumps(public_config(config)))


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.server = create_server(load_config("test"), port=0, data_path=Path(cls.tmp.name) / "db.sqlite3")
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True); cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"
        with urllib.request.urlopen(cls.base + "/api/config") as response: cls.token = json.load(response)["csrf_token"]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join(); cls.tmp.cleanup()

    def request(self, path, data=None, headers=None):
        payload = json.dumps(data).encode() if data is not None else None
        req = urllib.request.Request(self.base + path, data=payload, headers={"Content-Type": "application/json", "X-CSRF-Token": self.token, **(headers or {})})
        try:
            response = urllib.request.urlopen(req)
        except urllib.error.HTTPError as error: response = error
        with response: return response.status, response.read()

    def test_full_report_annotation_evaluation_export(self):
        status, body = self.request('/api/reports', {"consent": True, "report": report("http-flow")})
        self.assertEqual(status, 201); identity = json.loads(body)["id"]
        self.assertEqual(self.request(f'/api/reports/{identity}/annotation', {"reviewer": "tester", "dataset": "http", "labels": {"fingers": "clear"}})[0], 200)
        status, body = self.request('/api/evaluation?dataset=http')
        self.assertEqual(json.loads(body)["checks"]["fingers"]["tn"], 1)
        self.assertIn(b'http-flow', self.request('/api/export/manifest')[1])
        self.assertEqual(self.request('/api/export/csv')[0], 200)

    def test_private_files_and_traversal_not_served(self):
        for path in ['/config/development.json', '/../config/development.json', '/%2e%2e/config/development.json', '/backend/http.py', '/.git/config']:
            with self.subTest(path=path): self.assertEqual(self.request(path)[0], 404)

    def test_csrf_origin_host_and_consent(self):
        payload = {"report": report("invalid")}
        self.assertEqual(self.request('/api/reports', payload, {"X-CSRF-Token": "wrong"})[0], 403)
        self.assertEqual(self.request('/api/reports', payload, {"Origin": "https://evil.example"})[0], 403)
        self.assertEqual(self.request('/api/config', headers={"Host": "evil.example"})[0], 403)
        self.assertEqual(self.request('/api/reports', payload)[0], 400)

    def test_static_wasm_and_model_files(self):
        for path in ['/', '/src/app.js', '/vendor/wasm/vision_wasm_internal.wasm', '/models/hand_landmarker.task']:
            with self.subTest(path=path): self.assertEqual(self.request(path)[0], 200)

    def test_disabled_vlm_does_not_call_network(self):
        self.assertEqual(self.request('/api/review', {"consent": True, "checks": ["fingers"], "images": []})[0], 400)


if __name__ == '__main__': unittest.main()
