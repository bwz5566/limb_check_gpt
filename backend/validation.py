"""Validate untrusted browser reports before storage or evaluation."""
import base64
import binascii
import math
from .config import CHECKS, STATUSES


def image_data(value):
    if not isinstance(value, str) or len(value) > 2_800_000:
        raise ValueError("证据图片须为不超过 2 MB 的 PNG/JPEG")
    prefixes = {"data:image/jpeg;base64,": b"\xff\xd8\xff", "data:image/png;base64,": b"\x89PNG\r\n\x1a\n"}
    for prefix, signature in prefixes.items():
        if value.startswith(prefix):
            try:
                raw = base64.b64decode(value[len(prefix):], validate=True)
            except (ValueError, binascii.Error) as exc:
                raise ValueError("图片 Base64 无效") from exc
            if not raw.startswith(signature) or len(raw) > 2_000_000:
                raise ValueError("图片类型或大小无效")
            return value
    raise ValueError("仅接受内嵌 PNG/JPEG；不接受远程图片 URL")


def validate_checks(checks):
    if not isinstance(checks, dict) or set(checks) != set(CHECKS):
        raise ValueError("checks 必须包含且仅包含六个检测项")
    for key, check in checks.items():
        if not isinstance(check, dict) or check.get("status") not in STATUSES:
            raise ValueError(f"{key} 的 status 无效")
        if not isinstance(check.get("reason"), str) or len(check["reason"]) > 2000:
            raise ValueError(f"{key} 的 reason 无效")
    return checks


def validate_report(report):
    if not isinstance(report, dict) or report.get("schema_version") != "1.0":
        raise ValueError("需要 schema_version=1.0 的报告")
    if report.get("source") not in ("camera", "image", "video", "synthetic"):
        raise ValueError("未知 source")
    if not isinstance(report.get("sample_name"), str) or not 1 <= len(report["sample_name"]) <= 240:
        raise ValueError("sample_name 须为 1–240 个字符")
    validate_checks(report.get("checks"))
    for key in ("engine", "rule_version", "created_at", "run_id"):
        if not isinstance(report.get(key), str) or not report[key] or len(report[key]) > 240:
            raise ValueError(f"缺少有效 {key}")
    latency = report.get("latency_ms")
    if isinstance(latency, bool) or not isinstance(latency, (int, float)) or not math.isfinite(latency) or latency < 0:
        raise ValueError("latency_ms 无效")
    evidence = report.get("evidence", [])
    if not isinstance(evidence, list) or len(evidence) > 6:
        raise ValueError("每份报告最多 6 张证据图片")
    for item in evidence:
        if not isinstance(item, dict) or not isinstance(item.get("label"), str):
            raise ValueError("证据格式无效")
        image_data(item.get("image"))
    if not isinstance(report.get("synthetic", False), bool):
        raise ValueError("synthetic 须为布尔值")
    for key, maximum in (("frames", 120), ("steps", 40), ("limitations", 40)):
        values = report.setdefault(key, [])
        if not isinstance(values, list) or len(values) > maximum:
            raise ValueError(f"{key} 须为不超过 {maximum} 项的数组")
    if any(not isinstance(v, str) for v in report["limitations"]):
        raise ValueError("limitations 项须为文本")
    for step in report["steps"]:
        if not isinstance(step, dict) or not isinstance(step.get("title"), str) or step.get("status") not in ("completed", "timeout", "skipped", "interrupted"):
            raise ValueError("动作步骤无效")
        if not isinstance(step.get("duration_ms"), (float, int)) or step["duration_ms"] < 0:
            raise ValueError("动作耗时无效")
    return report


def validate_annotation(data):
    if not isinstance(data, dict) or not isinstance(data.get("labels"), dict):
        raise ValueError("缺少 labels")
    if not data["labels"] or not set(data["labels"]).issubset(CHECKS):
        raise ValueError("标签检测项无效")
    if any(x not in STATUSES for x in data["labels"].values()):
        raise ValueError("标签值无效")
    for key in ("reviewer", "note", "dataset", "subject_id"):
        if not isinstance(data.get(key, ""), str) or len(data.get(key, "")) > 2000:
            raise ValueError(f"{key} 无效")
    if not data.get("reviewer", "").strip():
        raise ValueError("请填写标注人")
    return data
