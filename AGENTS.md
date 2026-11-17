# Repository instructions

## 项目定位

这是 Obsidian 插件 **Stark**。它基于 MIT 许可的 Chatting with AI 0.12.0，
但使用独立插件身份和发布版本。

## 必须保持

- `manifest.json` 的插件 ID 必须保持为 `stark`。
- 工作区视图类型必须保持全局唯一，当前为 `stark-view`。
- 不得删除或弱化 `LICENSE` 中的原始版权声明。
- 引用上游代码或行为时同步维护 `UPSTREAM.md`。
- 密钥只能使用 Obsidian `SecretStorage`；不得写入 `data.json`、测试夹具或日志。
- `raw/`、`main.js`、`data.json`、`debug.log` 是本地产物，不提交。

## 常用命令

```powershell
npm ci
npm test
npm run typecheck
npm run svelte-check
npm run build
```

只修改 `src/`、`test/`、配置或文档，不直接编辑生成的 `main.js`。

## 代码约定

- TypeScript 保持 `strict` 通过，不使用无理由的 `any`。
- Svelte 使用项目的 Svelte 5 写法，组件样式尽量局部化。
- 面向用户的新文本优先使用清晰、简洁的中英文均可的表述；代码标识与 API 字段保持英文。
- 修改插件 ID、视图类型、持久化路径或 SecretStorage key 时，必须提供迁移策略并更新测试。
- 修改 ChatGPT OAuth、模型目录或流式请求相关代码时，至少运行完整 `npm test`。

## 设计流程

新产品行为先记录到 `docs/DESIGN.md`，明确目标、交互、数据影响和验收条件，
再进入实现。不要为尚未确认的定制项提前扩展架构。
