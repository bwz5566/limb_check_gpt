"""Optional OpenAI-compatible image reviewer; configuration stays server-side."""
import json
import time
import urllib.error
import urllib.request
from urllib.parse import urlparse
from .config import CHECKS, STATUSES
from .validation import image_data

PROMPT_VERSION = "observations-v1"


def parse_output(text, requested):
    text = text.strip()
    if text.startswith("```") and text.endswith("```"):
        text = "\n".join(text.splitlines()[1:-1])
    result = json.loads(text)
    if not isinstance(result, dict) or set(result.get("checks", {})) != set(requested):
        raise ValueError("模型返回的检查项与请求不一致")
    for key, item in result["checks"].items():
        if not isinstance(item, dict) or item.get("status") not in STATUSES:
            raise ValueError("模型状态无效")
        if not isinstance(item.get("reason"), str) or len(item["reason"]) > 2000:
            raise ValueError("模型理由无效")
        confidence = item.get("confidence")
        if isinstance(confidence, bool) or not isinstance(confidence, (int, float)) or not 0 <= confidence <= 1:
            raise ValueError("模型置信度无效")
        if confidence < 0.8 and item["status"] in ("clear", "flag"):
            item["status"] = "uncertain"
            item["reason"] = "低置信度，需人工复核。" + item["reason"]
    return {"checks": {key: {field: item[field] for field in ("status", "reason", "confidence")} for key, item in result["checks"].items()}}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("模型接口重定向被拒绝，请配置最终接口地址")


def review(config, request):
    settings = config["vlm"]
    if not settings["enabled"]:
        raise ValueError("未启用视觉模型；请配置本环境的 local.json 并重启")
    if request.get("consent") is not True:
        raise ValueError("发送图片前需要明确授权")
    requested = request.get("checks")
    if not isinstance(requested, list) or not requested or len(requested) != len(set(requested)) or not set(requested).issubset(CHECKS):
        raise ValueError("检查项无效")
    images = request.get("images")
    if not isinstance(images, list) or not 1 <= len(images) <= 3:
        raise ValueError("每次复核需要 1–3 张图片")
    for image in images:
        image_data(image)
    parsed = urlparse(settings["base_url"])
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("模型 base_url 无效")
    prompt = (
        "你是图像观察助手，只记录可见证据，不做医学诊断或招聘决定。不要猜测被遮挡部分；"
        "不能确认时必须 uncertain；不在画面内或不能评估时 not_assessed。"
        "limbs 指可见四肢结构疑点；fingers 指可见手指缺失或短缩疑点；nails 指甲油、甲片；"
        "tattoo 指可见纹身；scar 指可见疤痕；hair 指疑似染发。外观项只记录，不评价适岗性。"
        "不得推断年龄、民族、性别或其他未请求属性。仅输出 JSON："
        '{"checks":{"检测项":{"status":"clear|flag|uncertain|not_assessed","reason":"简短可见证据","confidence":0.0}}}。'
        "checks 必须且只能包含：" + ",".join(requested) + "。clear 仅表示图中未见相应疑点，不能证明身体完整。"
    )
    content = [{"type": "text", "text": prompt}] + [{"type": "image_url", "image_url": {"url": x}} for x in images]
    payload = {"model": settings["model"], "temperature": 0, "max_tokens": 1600,
               "messages": [{"role": "user", "content": content}]}
    headers = {"Content-Type": "application/json"}
    if settings["api_key"]:
        headers["Authorization"] = "Bearer " + settings["api_key"]
    upstream = urllib.request.Request(settings["base_url"].rstrip("/") + "/chat/completions", data=json.dumps(payload).encode(), headers=headers)
    start = time.perf_counter()
    try:
        with urllib.request.build_opener(NoRedirect).open(upstream, timeout=settings["timeout_seconds"]) as response:
            raw = response.read(1_000_001)
        if len(raw) > 1_000_000:
            raise ValueError("模型返回内容过大")
        text = json.loads(raw)["choices"][0]["message"]["content"]
        if not isinstance(text, str):
            raise ValueError("模型 content 必须为 JSON 文本")
        output = parse_output(text, requested)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"模型服务 HTTP {exc.code}；检查接口、模型名及鉴权配置") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise RuntimeError("模型连接失败或超时；请检查服务可达性") from exc
    except (KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
        raise RuntimeError("模型响应不符合约定 JSON，需人工复核") from exc
    return {**output, "model": settings["model"], "prompt_version": PROMPT_VERSION,
            "latency_ms": round((time.perf_counter() - start) * 1000), "effect_validated": False}
