# picode

`picode` 是一个从零实现的 TypeScript Coding Agent。当前仓库已完成 Phase 3 核心：项目脚手架、配置解析、密钥脱敏、LLM 内部协议/provider 抽象、工具参数校验、路径边界、文件工具、命令审批、显式 Agent Loop、终止限制、上下文预算保护和 `finish` 契约；会话与完整 CLI 入口将在后续阶段接入。

## 环境

- Node.js 22+
- OpenAI-compatible Chat Completions 网关

复制 `.env.example` 为 `.env`，填写 `PICODE_API_KEY` 和 `PICODE_MODEL`。配置只读取以下四个键：

- `PICODE_API_KEY`
- `PICODE_BASE_URL`（默认 `https://api.openai.com/v1`）
- `PICODE_MODEL`
- `PICODE_CONTEXT_WINDOW`（默认 `128000`）

进程环境变量优先于启动目录中的 `.env`。`.env` 不会被提交，也不会被完整注入子进程环境。

## 开发命令

```bash
npm install
npm run build
npm run typecheck
npm test
```

官方 `openai` JavaScript SDK 已固定为 `4.104.0`。Phase 1 provider 使用 Chat Completions streaming API，并启用 `stream_options.include_usage`；HTTP 和 SSE 解码由 SDK 负责，provider 对 typed chunks 做最小聚合和协议校验，Agent Loop 仍由本项目实现。

Phase 2 的文件工具只访问 canonical workspace 和当前 session 的 `/tmp/picode-<session-id>/`；`.env`/`.env.*` 受保护（`.env.example` 除外）。`run_command` 每次都要经过审批，获批后以当前用户权限运行，不构成操作系统级沙箱；子进程不会继承 `PICODE_*` 或 `OPENAI_API_KEY`。

Phase 3 的 `AgentLoop` 显式推进 context check → LLM → tool-call 预验证 → 严格串行工具执行 → result feedback，要求模型通过唯一的 `finish` 工具结束任务，并执行请求数、活跃时间、连续错误、重复调用、取消和上下文预算限制。审批等待不计入活跃时间，工具批次在执行前整体校验。

## CLI

构建后可运行：

```bash
node dist/cli.js --cwd /path/to/workspace "task"
```

当前 CLI 仍仅验证启动目录和 `--cwd`；会话、交互式入口与 AgentLoop 的完整任务接线将在后续阶段接入。
