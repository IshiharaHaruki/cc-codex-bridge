# cc-codex-bridge (MVP)

最小的本地 web 应用，打通 **Claude Agent SDK** 与 **Codex app-server**，双向、用户触发。

```
浏览器 ──POST /api/ask {agent, prompt}──> NDJSON 事件流
  agent="claude" → 跑 Claude；Claude 可调 codex_delegate  (CC → Codex)
  agent="codex"  → 跑 Codex；Codex 可调 ask_claude        (Codex → CC)
```

## 前置条件

- Node 18+（实测 24）
- **`codex` CLI 已安装并登录**：`npm i -g @openai/codex && codex login`
  - codex 既是运行依赖（本 app 会 spawn 它），也用于生成协议类型（见下）。
- Claude 已登录（Claude 订阅 oauth，或设 `ANTHROPIC_API_KEY`）

## 运行

```bash
npm install
npm run dev          # 默认 http://localhost:4399
```

打开 http://localhost:4399，选 agent、输入任务、发送。两边的 `cwd` 默认是本仓库的上级目录。

> `npm run dev` 会先跑 `predev` 守卫：若 `src/codex-protocol/` 不存在，自动执行 `npm run codex:protocol` 生成。所以首次直接 `npm run dev` 即可，无需手动生成。

## Codex 协议类型（生成代码，不入库）

`src/codex-protocol/`（约 600 个 `.ts`）是由 codex 生成的 app-server 协议类型，**已被 `.gitignore` 排除，不在仓库里**——它们是生成产物，且与你本机的 codex 版本严格对应。

- 这些类型是 **`import type`（纯类型）**：跑 app（tsx）时类型被擦除，运行时一个都不需要；它们只在 `tsc` 类型检查时有用。
- 首次运行 / clone 后，由 `predev`、`pretypecheck` 守卫自动生成，或手动：
  ```bash
  npm run codex:protocol      # = codex app-server generate-ts --out src/codex-protocol --experimental
  ```
- **升级 codex 后**重新生成一次，类型若与新版协议不符，`npm run typecheck` 会立刻报出来。

## 类型检查

```bash
npm run typecheck    # 缺类型会先自动生成，再跑 tsc --noEmit
```

## 工作原理

| 文件 | 作用 |
|---|---|
| `src/codex-client.ts` | spawn `codex app-server`，JSON-RPC over stdio，驱动 thread/turn，流式 `agentMessage`；通过 `dynamicTools` + `item/tool/call` 回调把 Codex 的工具调用 dispatch 到本地（即 `ask_claude`）。改编自 boop-agent（Apache-2.0）。 |
| `src/claude-runtime.ts` | `query()` 封装；`withCodexTool` 时注入 in-process `codex_delegate` 工具（CC→Codex）。 |
| `src/server.ts` | http 服务 + NDJSON 流；Codex 侧注入 `ask_claude` dynamic tool（Codex→CC）。 |
| `src/codex-protocol/` | `codex app-server generate-ts` 生成的协议类型（**生成代码，不入库**，见上节；勿手改）。 |
| `public/index.html` | 极简单页 UI。 |

## 配置

- 端口：`PORT=4399`
- 工作目录：`BRIDGE_CWD=/abs/path`
- **沙箱**：MVP 默认 Codex `read-only`（可审查/分析/回答，不改文件）。要让 Codex 真正改代码，把 `src/server.ts` 与 `src/claude-runtime.ts` 里的 `sandbox` 改成 `"workspace-write"`。
- **Auth（环境变量驱动，设了就用 API，没设用订阅）**：
  - `ANTHROPIC_API_KEY=sk-ant-...` → Claude 走 API 计费（否则用 Claude 订阅 oauth）
  - `OPENAI_API_KEY=sk-...` → Codex 走 API 计费（否则用 ChatGPT 订阅；客户端会自动加 `-c preferred_auth_method="apikey"` 强制生效）

## 已知点

- 需 `@anthropic-ai/claude-agent-sdk@^0.3`（0.1.x 有 in-process MCP 工具多轮 `tool_use ids must be unique` 的 bug，需 zod v4）。
- 互调为请求-响应模式；若要两 agent 多轮自主对话，需加 busy-guard / steer / interrupt（参考 quilin-ai/agent-bridge）。
- 每次 Codex 调用都 spawn 一个新的 app-server（一次性）。要更低延迟可改成常驻连接。
