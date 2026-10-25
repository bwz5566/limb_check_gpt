# 扩展与需求迭代

## 先固定验收场景

每个新需求记录：目标用户、输入条件、输出字段、无数据/失败时行为、人工复核路径、需要哪些样本、怎样量化验收。不要把“接入某个模型”当作“效果达标”。

推荐一个需求一个分支，先增加契约或失败复现测试，再改实现，最后更新版本与文档。`python3 scripts/verify.py` 必须通过。对模型/阈值变化还要跑固定真实验证集。

## 修改阈值

1. 编辑 `config/rules.json`，保持 JSON 合法。
2. 修改 `version`，例如 `rules-1.0.1`。
3. 重启服务器、刷新浏览器、重新加载模型。
4. 同一批验证样本重新分析、保存，按版本分别评测。

字段包括：可见度、手部分类分数、肢段比例、指长比例、指甲色差、亮度、最小手掌像素尺寸、动作保持/超时、推理间隔、视频抽帧。它们是工程初值，不是已验证的业务标准。

## 替换浏览器视觉模型

新增一个 adapter 并加入 `engine.js` 的 `engines` 注册表，再由 app 选择。接口：

```js
class NewEngine {
  id = 'my-engine-v1';
  async init(delegate) { return { engine: this.id, pose: 'CPU', hand: 'CPU' }; }
  analyze(source, options) {
    // source 是已解码的 Canvas / Image / Video，options.nails 表示手背输入前提。
    return { checks, detail, poses, hands, latency_ms };
  }
  draw(canvas, frame) {}  // 输入图像与关键点叠加
  snapshot() {}           // 返回 JPEG/PNG data URL（单张 <= 2 MB）
  close() {}              // 释放模型资源
}
```

`poses` 为人体关键点数组的数组，当前流程使用 MediaPipe 33 点索引；`hands` 为 `{points, side, score}`，手部是 21 点。每个点 `{x,y,nx,ny,v}`：像素坐标、归一化坐标、可见度。替换模型若索引不同，必须先映射；不允许直接把 RTMW 133 点当作 MediaPipe 33 点。

如果仅替换推理底座，继续调用 `analyzeFrame()` 复用规则。若替换检测任务，输出仍要遵守六项 `checks` 状态契约。新引擎 id 必须带版本；更新模型文件、来源、许可和 `config/assets.json` SHA-256。

## 新增动作 / 流程

1. 在 `workflow.js` 增加动作 ID、标题和判定分支。
2. 把 ID 放入 `PROFILES` 的步骤序列。
3. 决定它是全身还是手部步骤，并更新 `isHandStep` 和 `app.js` 的结构评估遮罩。
4. 确定是否需要前置基准；缺少基准必须提示或超时，不得直接成功。
5. 测试连续保持、瞬时匹配、遮挡打断、超时、跳过、中断。
6. 如果需要多阶段动作（如对捏），显式维护阶段，不要每一帧都累计成功次数。

当前未实现精细对捏；后续可独立新增，不会影响存储与评测契约。

## 替换视觉大模型服务

若接口支持 `POST /chat/completions` 和 `image_url`，修改对应环境 local 配置即可；API key 不进入浏览器。没有鉴权的私有服务可以留空。

若协议不同，在 `backend/vlm.py` 增加适配器，保持返回 `{checks, model, prompt_version, latency_ms, effect_validated}`。更新模型后用固定样本检验 JSON 合法率、低置信度行为、耗时、各项覆盖率。禁止失败时填入“正常”的默认值。

## 新增检测项

这属于契约变更，需同步：

1. `backend/config.py` 的 CHECKS、`web/src/domain.js` 的 CHECKS。
2. 对应规则或模型输出、未评估默认值、标注界面。
3. 模型提示词及输出校验、评测统计。
4. API/报告 schema 版本，旧报告读取兼容或迁移。
5. 示例数据、测试、文档和真实验证集。

不要只在 UI 加一个字段：旧数据、导出、统计、无模型时的行为都需要处理。

## 演进到服务端部署

真实并发和跨设备需求确定后，再建设服务端推理与媒体传输。可保留 JSON 报告和标签模型，将 Store 替换为数据库/对象存储，HTTP 层换成业务框架，媒体接入独立服务。公网前补齐账号、角色、授权、TLS、审计、隔离、配额和运维监控；浏览器推理结果不能作为可信最终证据。

当前代码没有预置空的 GPU worker、训练脚本或 Kubernetes 模板，避免无法启动的占位工程被误认为已交付能力。
