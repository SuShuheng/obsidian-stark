# Stark 1.0.2

Stark 1.0.2 增加可配置的聊天打开位置，完善 Obsidian 新标签页挂载，并修复移动端
Skills 与底部导航栏遮挡问题。

## 新增

- “常规 → 默认聊天打开位置”可在右侧栏与主编辑区标签页之间切换。
- 命令面板和功能区菜单继续提供“在侧边栏打开聊天”和“在新标签页打开聊天”两个独立入口。
- “代理 → 移动端 Skills 镜像”可把 `.agents/skills` 同步到移动端可读取的 `Stark Skills`。

## 改进

- 新标签页先通过 `setViewState` 挂载；若个别 Obsidian 版本仍显示空白标签页，则使用真实聊天视图兜底。
- 已打开的主区域聊天标签页会被复用，不重复创建。
- 桌面端扫描 Skills 时自动维护移动端可见镜像，并保留嵌套资源文件。
- 手机端主区域标签页为 Obsidian 悬浮导航栏和底部安全区预留空间，聊天输入框不再被遮挡。

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
- `stark-1.0.2.zip`

BRAT 安装仓库：`SuShuheng/obsidian-stark`

## 验证

- `npm test`：1022 项，1021 项通过，1 项因当前 Windows 环境未安装 OpenSSL 跳过。
- `npm run typecheck`：通过。
- `npm run svelte-check`：0 错误、0 警告。
- `npm run build`：通过。
