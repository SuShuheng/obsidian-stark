# Stark

Stark 是一个面向 Obsidian 的跨平台智能体助手：通过 ChatGPT 账号登录，直接读取、
搜索、编辑和创建笔记，并在对话中展示模型调用工具的执行过程。它基于
[Chatting with AI](https://github.com/o1xhack/obsidian-chatting) 的 MIT 许可代码独立维护。

当前正式版本为 **1.0.2**：

- 插件 ID：`stark`
- 插件名称：`Stark`
- Obsidian 视图类型：`stark-view`
- 最低 Obsidian 版本：`1.11.4`
- 平台：桌面端与移动端
- 上游基线：**Chatting with AI 0.12.0**

当前定制批次包括：

- 聊天输入框内直接切换模型与推理强度；滑杆只展示当前模型支持的档位，模型列表使用独立分组选择页，桌面与手机共用同一交互。
- 仅保留 ChatGPT 账号登录，旧配置启动时自动迁移到该路径。
- 设置页拆分为常规、模型、聊天、知识库、代理、语音、数据与诊断、关于八页。
- 模型列表只来自 ChatGPT 账号的模型目录，可在设置中启用/停用；每个模型可单独覆盖上下文窗口并恢复 API 默认值，显示使用 `K`/`M`。
- “代理”页管理工具默认权限、逐工具启用/权限覆盖和 `.agents/skills` 中的 Skills。
- 移动端无法读取隐藏的 `.agents/skills` 时，会自动回退到可见的 `Stark Skills` 镜像；桌面端扫描时会自动复制，也可在“代理”页手动强制同步。
- “关于”页显示版本、作者和仓库，并支持手动检查 GitHub Release。
- 支持自动、简体中文、English 三种语言选项；自动模式跟随 Obsidian。
- 桌面端流式请求支持系统代理、手动 HTTP 代理和直连；移动端使用 Obsidian/设备的系统网络，不提供手动代理覆盖。
- 连续工具调用会收拢为一条活动摘要；运行中显示当前动作与参数，完成后按“命令、搜索、读取、编辑”等类别聚合，并可展开查看详情。
- 语音模式支持按住说话和免手持模式；麦克风关闭时显示带红色斜杠的麦克风图标。
- 网络断流或临时连接失败最多自动重试 5 次；HTTP 400 等不可恢复错误会立即停止，避免无效重试。
- 聊天既可在右侧栏打开，也可通过命令或页面菜单在主编辑区的新标签页打开；可在“常规 → 默认聊天打开位置”选择功能区图标和“打开聊天”命令的默认入口，两种视图会复用同一个聊天状态。手机端主区域标签页会为底部悬浮导航栏和安全区预留空间，输入框不会被遮挡。

产品记录见 [docs/DESIGN.md](docs/DESIGN.md)。

### V1.0.2 更新

- 新增“默认聊天打开位置”：功能区图标和“打开聊天”命令可在右侧栏与主编辑区标签页之间切换。
- 修复部分 Obsidian 版本中新标签页只显示空白页的问题，并在标签页已存在时复用原聊天视图。
- 完善移动端 Skills：隐藏的 `.agents/skills` 不可读时自动使用可见的 `Stark Skills` 镜像，桌面端可自动或手动同步。
- 修复手机端主编辑区聊天输入框被底部悬浮导航栏遮挡的问题。

## 安装

### 通过 BRAT 安装

1. 在 Obsidian 中安装并启用 **BRAT**。
2. 打开 BRAT，选择 **Add Beta plugin**。
3. 输入仓库地址：

   ```text
   SuShuheng/obsidian-stark
   ```

4. 安装 `1.0.2` 正式版（BRAT 默认即可显示正式 Release）。
5. 在 Obsidian 的“社区插件”中启用 **Stark**。

### 手动安装

从 [GitHub Releases](https://github.com/SuShuheng/obsidian-stark/releases) 下载：

- `main.js`
- `manifest.json`
- `styles.css`

将三个文件放入：

```text
<Vault>/.obsidian/plugins/stark/
```

重启 Obsidian，并在“社区插件”中启用 **Stark**。也可以直接下载
`stark-1.0.2.zip`，解压后放入同一目录。

## 首次使用

1. 打开 Stark 设置页的“常规”。
2. 点击 **Connect ChatGPT**，使用 ChatGPT 账号完成登录。
3. 在“模型”页刷新模型目录，选择要展示在聊天中的模型。
4. 打开右侧栏的 Stark 聊天视图。
5. 在输入框底部切换模型和思考强度，然后开始对话。

聊天中的模型列表只来自 ChatGPT 账号当前可用的模型目录。每个模型可以单独启用、
停用、设置上下文窗口并恢复 API 默认值；聊天中只展示已启用的模型。

## 聊天与代理能力

- 模型可以直接读取当前笔记、搜索 Vault、读取元数据、编辑 Markdown、处理 Canvas、浏览网页和调用已启用工具。
- 写入类工具默认直接执行；可在“代理”页按工具切换为“用户批准”。
- 工具被停用后不会再发送给模型；历史记录中的旧调用也会被拒绝，不产生副作用。
- 连续工具调用显示为一条活动行，例如：

  ```text
  正在搜索代码 · **/README*
  执行了命令，已搜索代码，已读取文件
  ```

- 点击活动行可展开参数、结果和错误详情；完成后的活动行会自动收起。
- 支持聊天历史、重命名、删除、上下文压缩、撤销文件更改、重新生成和停止任务。

## Skills

默认 Skills 目录是 Vault 根目录下的 `.agents/skills`。每个技能是独立子目录，
其中必须包含 `SKILL.md`：

```text
.agents/skills/
  source-command-su/
    SKILL.md
  another-skill/
    SKILL.md
```

Stark 会通过 Obsidian 的底层 Vault adapter 扫描隐藏的 `.agents` 目录。只有启用的
技能会进入系统提示、`/` 候选和 `use_skill`；也可以在“代理”页修改目录、重新扫描、
打开或新建技能。

## ChatGPT 协议、流式输出与摘要

- ChatGPT 登录路径使用 OpenAI Responses/Codex 流式事件协议，请求始终为
  `stream: true`。
- 桌面端优先通过 Node HTTPS 或 HTTP `CONNECT` 代理接收增量 SSE；移动端优先使用
  Obsidian/WebView 的原生网络栈。无法增量读取时会回退到整段 `requestUrl()`。
- 回答文本在增量到达时更新，并使用节流避免每个 token 都重绘 Markdown。
- Stark 兼容并展示 `reasoning.summary`、`reasoning_summary_text.delta` 和完成态的
  reasoning item summary，但不会展示原始隐藏思维链。
- ChatGPT/Codex 后端并不保证每次返回可读摘要；如果后端只返回加密 reasoning，
  Stark 不会用工具日志伪造 `reasoning.summary`。可见的工具执行过程由活动组单独展示。

## 开发环境

要求：

- Node.js 22（见 `.nvmrc`）
- npm 11+
- Obsidian 1.11.4+

安装与验证：

```powershell
npm ci
npm test
npm run typecheck
npm run svelte-check
npm run build
```

开发监听：

```powershell
npm run dev
```

将仓库链接到一个测试 Vault。Windows 可使用目录联接：

```powershell
New-Item -ItemType Junction `
  -Path "D:\Notes\.obsidian\plugins\stark" `
  -Target "D:\GitHub\obsidian-stark"
```

然后在 Obsidian 的社区插件中启用 **Stark**。构建产物 `main.js` 已在
`.gitignore` 中，发布时再生成。

## 代码结构

```text
src/
  main.ts             插件生命周期、命令、持久化与设置入口
  agent/              代理循环、历史、压缩、提示词、Skills、用量
  api/                ChatGPT OAuth、Responses 流式协议、模型目录、MCP
  auth/               ChatGPT 登录、令牌存储与刷新
  tools/              笔记、Canvas、链接、元数据、文件与撤销工具
  ui/                 Obsidian 视图和 Svelte 聊天界面
  voice/              实时语音会话与协议
  platform/           移动端、生命周期与屏幕唤醒适配
test/                 Node 离线回归测试和手动 QA 脚本
styles.css            插件全局样式
raw/                  上游 0.12.0 构建基线，仅本地保留且不提交
```

## 网络与流式输出

- **桌面端**：在“常规 → 网络与流式输出”可选择系统代理、手动 HTTP 代理或直连。手动代理会通过 HTTP `CONNECT` 建立 ChatGPT 流式隧道；隧道建立失败时仍会回退到 Obsidian 的 `requestUrl()`。为避免把代理凭据写入 `data.json`，手动代理 URL 不接受用户名/密码，认证代理请配置为系统代理。
- **移动端**：始终遵循 Obsidian/设备的系统网络设置，插件设置页不会把手动桌面代理应用到手机。
- ChatGPT 账号接口在部分移动 WebView 中不允许增量 SSE，此时请求会通过原生 `requestUrl()` 整段接收；回答仍能正常完成，但只能在结束时一次性显示。桌面端和允许流式的移动环境会逐段显示。
- `reasoning.summary` 是否出现取决于 ChatGPT 后端为当前模型返回的内容；当前模型目录默认可能只返回加密 reasoning。

## Agent、Skills 与模型

- 工具默认权限为“直接执行”；可在“代理”页逐工具切换为“用户批准”，批准前不会执行写入类工具。
- 禁用工具不会发送给模型；旧聊天历史中的调用会被拒绝且不产生副作用。
- 默认 Skills 目录是 Vault 根目录的 `.agents/skills`，每个技能一个子目录和 `SKILL.md`。只有启用的技能进入系统提示、`/` 候选和 `use_skill`。
- Obsidian 移动端及 Obsidian Sync 不保证访问或同步 `.agents` 等隐藏目录。桌面端扫描 Skills 时会自动把当前技能复制到可见的 `Stark Skills`；“代理 → 移动端 Skills 镜像”可手动强制刷新。移动端在主目录不可用时会自动读取该镜像。
- 当前模型不能被关闭；目录刷新后若当前模型消失，会自动切换到目录中第一个启用模型。

## 打包与发布

生产构建：

```powershell
npm run build
```

发布资产为：

```text
main.js
manifest.json
styles.css
stark-1.0.2.zip
```

GitHub Release 使用与 `manifest.json` 相同的版本号标签（本版本为 `1.0.2`）。
BRAT 读取这些资产安装插件；预览版需要在 BRAT 中启用 pre-releases。

## 安全约定

- API Key、ChatGPT OAuth 凭据和 MCP Token 只写入 Obsidian `SecretStorage`。
- 不得把 `data.json`、调试日志、令牌或 Vault 内容提交到仓库。
- `raw/` 是本地对照材料，可能包含个人设置，已加入 `.gitignore`。
- 修改网络请求中的兼容性标识前，先验证 ChatGPT 账户登录与对话链路。

## 来源与许可

本项目沿用了 Chatting with AI 的 MIT 许可代码。原始版权声明保留在
[LICENSE](LICENSE)，导入基线、改动和暂留兼容标识见 [UPSTREAM.md](UPSTREAM.md)。

Stark 与 Yuxiao (o1xhack) 无隶属关系，也不代表上游项目。
