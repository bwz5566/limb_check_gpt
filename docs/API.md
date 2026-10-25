# API 与报告契约（v0.1.0）

服务仅面向本机，默认地址 `http://localhost:8000`。成功和错误均使用 JSON（静态文件/导出除外）。写操作须携带 `Content-Type: application/json` 与从 `/api/config` 获取的 `X-CSRF-Token`。本机程序可以不带 Origin；浏览器 Origin 必须匹配本机服务。

## 接口

| 方法 | 路径 | 输入 / 返回 |
| --- | --- | --- |
| GET | `/api/health` | `{status:"ok",version}`；检查服务进程，不表示模型已加载 |
| GET | `/api/config` | 版本、环境、规则、模型开关、限制、CSRF token；不返回密钥和上游地址 |
| POST | `/api/reports` | `{consent:true,report}` → `201 {id}`；run_id 幂等 |
| GET | `/api/reports?limit=20&offset=0` | total、items、limit、offset；limit 最大 100 |
| GET | `/api/reports/{id}` | `{id,report,annotation}`，不存在 404 |
| POST | `/api/reports/{id}/annotation` | labels、reviewer、dataset、subject_id、note；更新标签并追加历史 |
| GET | `/api/evaluation` | 支持 dataset、rule_version、engine 精确筛选 |
| GET | `/api/export/csv` | 一行一个报告检测项；CSV 公式前缀转义 |
| GET | `/api/export/manifest` | JSONL 清单，不含图片与逐帧数据；可供离线评测 |
| POST | `/api/review` | `{consent:true,checks:[...],images:[dataURL...]}` → 模型观察结果 |

## 报告对象

`schema_version` 当前为 `1.0`。六个检查项必须齐全，未运行项用 not_assessed，不能省略或填正常。

```json
{
  "schema_version": "1.0",
  "run_id": "每次分析唯一 ID",
  "created_at": "2026-10-25T00:00:00.000Z",
  "source": "image",
  "sample_name": "sample.png",
  "engine": "mediapipe-bundled-1",
  "rule_version": "rules-1.0.0",
  "rules": {},
  "synthetic": false,
  "checks": {
    "limbs": {"status":"uncertain","reason":"部分关节不可见"},
    "fingers": {"status":"flag","reason":"长度比例触发阈值"},
    "nails": {"status":"not_assessed","reason":"没有手背输入"},
    "tattoo": {"status":"not_assessed","reason":"未接入模型"},
    "scar": {"status":"not_assessed","reason":"未接入模型"},
    "hair": {"status":"not_assessed","reason":"未接入模型"}
  },
  "frames": [],
  "steps": [],
  "evidence": [],
  "latency_ms": 0,
  "effect_validated": false,
  "limitations": []
}
```

source：camera / image / video / synthetic。checks.status：clear / flag / uncertain / not_assessed。latency_ms 是平均单帧检测耗时，不是整个会话耗时；视频时间点在 frames[].time_seconds；动作时长在 steps[].duration_ms。

证据 `{label,image}`，image 仅允许 PNG/JPEG Base64 data URL，每张原始字节不超过 2 MB，每份最多 6 张。POST 请求总大小默认最多 16,000,000 bytes。原视频不接受上传。

视觉复核产生新 run_id、parent_run_id、local_checks、review；已保存报告不修改。相同 run_id 重复提交返回已有 ID，不覆盖原内容。因此修改报告后必须使用新的 run_id。

## 标注

```json
{
  "labels":{"fingers":"flag","limbs":"clear"},
  "reviewer":"reviewer-01",
  "dataset":"validation-v1",
  "subject_id":"participant-001",
  "note":"人工查看原始样本后的依据"
}
```

标签可以只包含已检查的项目。clear/flag 进入二分类指标；uncertain/not_assessed 不作为确定真值。标注人必填，避免无来源标签。历史在 SQLite `annotation_history` 中留存，当前界面展示最新版本。

## 视觉模型

上游请求使用固定服务端提示词，`temperature=0`，最多三张证据。返回要求：

```json
{"checks":{"fingers":{"status":"uncertain","reason":"指尖遮挡","confidence":0.6}}}
```

checks 的键必须与请求完全一致；状态和置信度范围严格校验。低于 0.8 的 clear/flag 转 uncertain。模型支持的 JSON fenced code block 可去除围栏；不从任意文本里贪婪提取 JSON。接口重定向被拒绝，避免把鉴权发送到意外目标。

## 错误

- 400：非法 JSON、字段、未授权保存/发送、未启用模型、模型结构无效。
- 403：Host、CSRF 或 Origin 不匹配。
- 404：报告、静态文件或接口不存在。
- 413：请求为空或超限；415：Content-Type 不正确。
- 502：上游连接失败、超时或响应协议错误。
- 500：本地内部失败；不会把密钥、数据库内容或上游原始响应回显到浏览器。

对于非浏览器客户端，先请求 config 获取 token，再 POST；不要把 CSRF token 当作身份认证。这些接口只适用于单机工作台。
