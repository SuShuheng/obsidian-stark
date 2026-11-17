# Stark 1.0.0 Preview

Stark 的首个公开预览版本，面向 Obsidian 桌面端和移动端。

## 主要功能

- 使用 ChatGPT 账号登录，通过 OpenAI Responses/Codex 流式协议进行对话。
- 读取、搜索、创建和编辑 Markdown 笔记，支持 Canvas、元数据、链接、网页读取与 MCP 工具。
- 聊天内直接切换模型和思考强度，只显示当前模型目录支持的档位。
- 连续工具调用聚合为一条可展开的活动摘要，完成后自动收起。
- 八页设置界面，支持自动、简体中文和 English。
- 模型启用管理、逐模型上下文覆盖和百分比上下文压缩。
- 工具启用与“直接执行/用户批准”权限管理。
- 扫描 Vault 根目录 `.agents/skills` 中的 Skills。
- 桌面端支持系统代理、手动 HTTP 代理和直连流式传输；移动端跟随系统网络。
- 实时语音模式与麦克风静音状态图标。
- 聊天历史、停止/继续、重新生成、文件更改撤销和上下文压缩。

## 已知限制

- 当前 UI 只提供 ChatGPT 账号登录路径。
- `reasoning.summary` 是否出现取决于 ChatGPT/Codex 后端是否为当前模型返回可读摘要；
  后端只返回加密 reasoning 时，Stark 不会伪造摘要。
- 部分移动 WebView 不允许增量 SSE，此时回答会在完整接收后一次性显示。
- 本版本为 GitHub Preview Release，建议通过启用了 pre-releases 的 BRAT 安装。

## 安装

BRAT 仓库地址：

```text
SuShuheng/obsidian-stark
```

Release 资产：

- `main.js`
- `manifest.json`
- `styles.css`
- `stark-1.0.0.zip`

最低 Obsidian 版本：`1.11.4`。
