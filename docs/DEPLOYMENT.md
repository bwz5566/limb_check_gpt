# 配置、运行与部署

## 本机环境

Python 3.10+；Chrome / Edge；磁盘留出模型、证据和备份空间。运行库及模型约数十 MB，随普通 Git 克隆提供，不使用 Git LFS 指针。基础流程无 CDN 请求。

```bash
python3 scripts/doctor.py
python3 server.py
```

macOS/Linux 用 python3；Windows 推荐 `py -3`。启动脚本不会自动安装软件，也不会改系统设置。

## 三环境配置

| 环境 | 模板 | 默认端口 | 数据 |
| --- | --- | --- | --- |
| 开发 | config/development.json | 8000 | data/development |
| 测试 | config/test.json | 8001 | data/test |
| 生产 | config/production.json | 8080 | data/production |

覆盖文件为对应 `<environment>.local.json`。顶层字段覆盖；vlm 等一层对象按键合并。密钥按用户要求明文保存在环境专用 local 配置中，不放聊天、前端源码或报告。Git 忽略 `config/*.local.json`，提交前仍应检查 diff。仓库中的模板不含真实密钥。

```json
{
  "port": 8000,
  "vlm": {
    "enabled": false,
    "base_url": "http://127.0.0.1:11434/v1",
    "model": "",
    "api_key": "",
    "timeout_seconds": 45
  }
}
```

`data_dir` 相对仓库根目录解析。`--port` 命令行优先于配置。规则从 `config/rules.json` 读取并写入报告快照。配置修改后需重启，浏览器需刷新。

## 大模型接入

已有服务必须支持图片的 chat/completions 协议。base_url 应截止到 `/v1` 等 API 根路径，不包含 `/chat/completions`。私有服务可使用内网地址；无鉴权可留空 api_key。有鉴权则填写该服务要求的值。

模型服务由用户自行提供，本项目不启动 Qwen/vLLM/Ollama。首次接入先使用授权测试图检查接口返回，不要直接用真实受试者数据试错。服务输出格式与六项状态定义见 API 文档。复核失败保留本地报告，模型密钥和上游原始错误不回传浏览器。

## 存储与备份

SQLite 开启 WAL，报告、证据和标注在一个数据库中。单用户少量验证可直接使用；大量图片会增加数据库体积。程序没有批量删除功能，不会自动清理文件。

推荐使用 SQLite backup 接口，避免服务运行时只复制主文件遗漏 WAL：

```bash
python3 scripts/backup.py --env production --output output/production-backup-001.sqlite3
```

恢复前停止服务，先备份现有环境，再由管理员把备份放到目标环境的 `workbench.sqlite3`。不要随意合并不同版本的数据库。备份含图片，与原数据具有同等访问要求。

## 网络与安全边界

当前仅监听 127.0.0.1/localhost。生产环境也相同，不支持把 host 改成 0.0.0.0。无登录、无多用户角色、无完整访问审计，因此不提供“直接公网部署”的配置。

远程手机采集需要 HTTPS、身份/授权、会话隔离与网络架构，属于下一阶段。不要以隧道转发绕过本机边界当成生产方案。

静态服务只提供 web 目录，不提供 config、data、backend、.git。写请求有 CSRF token 与 Origin 检查，报告大小和图片格式受限。这些措施不等同于认证体系。

## 软件升级

1. 停止服务并备份数据库与 local 配置。
2. 获取代码变更，阅读 CHANGELOG 和数据迁移说明。
3. 运行 doctor 和 verify。
4. 在 test 环境运行固定样本回归，确认效果没有未经批准的退化。
5. 再更新实际使用环境；记录模型、规则、提示词版本。

不提供自动覆写配置或自动删除数据的升级脚本。
