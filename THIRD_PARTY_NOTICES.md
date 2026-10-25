# 第三方资源与来源

## MediaPipe 运行库与模型

资源来自用户提供的 `limb-check-handoff/limb-check-demo/vendor` 与 `models`，原样复制到 `web/`。没有在本工程中重新训练模型。

- 项目：https://github.com/google-ai-edge/mediapipe
- 人体模型说明：https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker
- 手部模型说明：https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker
- MediaPipe 源码许可：Apache-2.0，副本在 `web/vendor/LICENSE.mediapipe`。
- 模型资产与分发条款应按上述官方模型页面及其下载资源核对；不要将软件源码许可自动推定为所有模型/数据集的授权。

原始交接包没有标明 npm SDK 精确版本；本工程不猜测其 semver。用 `config/assets.json` 的字节数和 SHA-256 固定当前实物版本。`scripts/doctor.py` 校验这些资源是否完整。更换资源需要更新来源、许可和哈希，重新跑浏览器推理及效果回归。

## 第一方工程

本次整理的服务端、界面、规则模块、测试与文档为此仓库的工程交付。公开开源许可证由仓库所有者另行决定；未擅自为第一方代码指定 MIT/Apache 授权。

## 测试样本

`samples/blank.png` 和 `samples/blank.mp4` 是程序生成的纯灰色图片与视频，不含个人或第三方图像。用于管线验证，不是人体识别效果数据。
