# Stark 1.0.1

Stark 1.0.1 是首次正式版更新，重点改善网络不稳定时的恢复能力，并增加主编辑区标签页入口。

## 新增

- 支持通过“在新标签页打开聊天”命令和功能区菜单，在 Obsidian 主编辑区打开 Stark。
- 主区域聊天标签页会被复用，重复执行命令不会创建多个相同标签页。
- 设置、模型、语言、用量和附件状态更新会同步到已打开的聊天视图。

## 改进

- 网络断流、临时传输失败及可恢复的 5xx/408 错误最多自动重试 5 次。
- ChatGPT OAuth 的临时传输失败使用相同的恢复策略。
- HTTP 400、401/403 等不可恢复错误不会进入网络重试循环。
- 可能已经触发远端工具副作用的请求不自动重发，避免重复执行。
- 修正 ChatGPT 400 错误中仍建议切换到已移除 OpenAI API Key 的过时文案。

## 兼容性

- 插件 ID：`stark`
- 视图类型：`stark-view`
- 最低 Obsidian 版本：`1.11.4`
- 平台：桌面端与移动端
- 模型接入：ChatGPT Auth

## 安装资产

- `main.js`
- `manifest.json`
- `styles.css`
- `stark-1.0.1.zip`

BRAT 安装仓库：`SuShuheng/obsidian-stark`

## 验证

- `npm test`：1017 项，1016 项通过，1 项因当前 Windows 环境未安装 OpenSSL 跳过。
- `npm run typecheck`：通过。
- `npm run svelte-check`：0 错误、0 警告。
- `npm run build`：通过。
