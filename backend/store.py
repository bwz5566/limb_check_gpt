"""SQLite persistence. Each request owns a connection; no raw video is stored."""
import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from .validation import validate_annotation, validate_report


def utc_now():
    return datetime.now(timezone.utc).isoformat()


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS reports (
                    id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL,
                    run_id TEXT UNIQUE NOT NULL);
                CREATE TABLE IF NOT EXISTS annotations (
                    report_id TEXT PRIMARY KEY REFERENCES reports(id), payload TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS annotation_history (
                    id INTEGER PRIMARY KEY, report_id TEXT NOT NULL, at TEXT NOT NULL, payload TEXT NOT NULL);
                PRAGMA user_version=1;
            """)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    def save(self, report):
        validate_report(report)
        with self.connect() as db:
            identity = str(uuid.uuid4())
            db.execute("INSERT INTO reports VALUES (?,?,?,?) ON CONFLICT(run_id) DO NOTHING", (identity, utc_now(), json.dumps(report, ensure_ascii=False), report["run_id"]))
            return db.execute("SELECT id FROM reports WHERE run_id=?", (report["run_id"],)).fetchone()["id"]

    def get(self, identity):
        with self.connect() as db:
            row = db.execute("SELECT * FROM reports WHERE id=?", (identity,)).fetchone()
            annotation = db.execute("SELECT payload FROM annotations WHERE report_id=?", (identity,)).fetchone()
        if not row:
            return None
        return {"id": identity, "report": json.loads(row["payload"]),
                "annotation": json.loads(annotation[0]) if annotation else None}

    def list(self, limit=100, offset=0):
        with self.connect() as db:
            total = db.execute("SELECT COUNT(*) FROM reports").fetchone()[0]
            rows = db.execute("SELECT r.id,r.created_at,r.payload,a.payload AS annotation FROM reports r LEFT JOIN annotations a ON a.report_id=r.id ORDER BY r.created_at DESC LIMIT ? OFFSET ?", (limit, offset)).fetchall()
        items = []
        for row in rows:
            report = json.loads(row["payload"])
            items.append({"id": row["id"], "saved_at": row["created_at"],
                          **{k: report.get(k) for k in ("sample_name", "source", "checks", "engine", "rule_version", "synthetic")},
                          "annotation": json.loads(row["annotation"]) if row["annotation"] else None})
        return {"total": total, "items": items, "limit": limit, "offset": offset}

    def annotate(self, identity, data):
        validate_annotation(data)
        with self.connect() as db:
            if not db.execute("SELECT 1 FROM reports WHERE id=?", (identity,)).fetchone():
                raise KeyError(identity)
            payload = json.dumps({**data, "at": utc_now()}, ensure_ascii=False)
            db.execute("INSERT INTO annotations VALUES (?,?) ON CONFLICT(report_id) DO UPDATE SET payload=excluded.payload", (identity, payload))
            db.execute("INSERT INTO annotation_history(report_id,at,payload) VALUES (?,?,?)", (identity, utc_now(), payload))

    def evaluation_rows(self):
        with self.connect() as db:
            rows = db.execute("SELECT r.id,r.payload,a.payload AS annotation FROM reports r LEFT JOIN annotations a ON a.report_id=r.id").fetchall()
        return [{"id": r["id"], "report": json.loads(r["payload"]), "annotation": json.loads(r["annotation"]) if r["annotation"] else None} for r in rows]
