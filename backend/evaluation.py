"""Explicit denominators: abstentions never count as correct predictions."""
from .config import CHECKS


def ratio(a, b):
    return round(a / b, 4) if b else None


def evaluate(rows, dataset="", rule_version="", engine=""):
    selected = [r for r in rows if not r["report"].get("synthetic") and r["report"]["source"] != "synthetic"
                and (not dataset or (r.get("annotation") or {}).get("dataset") == dataset)
                and (not rule_version or r["report"].get("rule_version") == rule_version)
                and (not engine or r["report"].get("engine") == engine)]
    results = {}
    for key in CHECKS:
        counts = dict(tp=0, tn=0, fp=0, fn=0, abstained=0, unlabelled=0, excluded_label=0, positives=0, negatives=0)
        for row in selected:
            label = (row.get("annotation") or {}).get("labels", {}).get(key)
            pred = row["report"]["checks"][key]["status"]
            if label is None:
                counts["unlabelled"] += 1
                continue
            if label not in ("flag", "clear"):
                counts["excluded_label"] += 1
                continue
            counts["positives" if label == "flag" else "negatives"] += 1
            if pred not in ("flag", "clear"):
                counts["abstained"] += 1
                continue
            counts[{("flag", "flag"): "tp", ("clear", "clear"): "tn", ("clear", "flag"): "fp", ("flag", "clear"): "fn"}[(label, pred)]] += 1
        labelled = counts["positives"] + counts["negatives"]
        decided = labelled - counts["abstained"]
        results[key] = {**counts, "labelled": labelled, "decided": decided,
                        "coverage": ratio(decided, labelled), "accuracy_decided": ratio(counts["tp"] + counts["tn"], decided),
                        "recall_decided": ratio(counts["tp"], counts["tp"] + counts["fn"]),
                        "detection_rate_all_positive": ratio(counts["tp"], counts["positives"]),
                        "false_positive_rate_decided": ratio(counts["fp"], counts["fp"] + counts["tn"])}
    groups = sorted({(r["report"].get("engine", ""), r["report"].get("rule_version", "")) for r in selected})
    return {"samples": len(selected), "checks": results, "versions": groups,
            "mixed_versions": len(groups) > 1,
            "filters": {"dataset": dataset, "rule_version": rule_version, "engine": engine},
            "note": "仅评估人工标注样本；模拟样本排除。无法判断单独统计，空分母为 null。clear 表示规则未发现疑点，不代表医学或招聘结论。"}
