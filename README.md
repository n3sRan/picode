# picode

`picode` 是一个从零实现的 TypeScript Coding Agent。当前仓库处于 Phase 1：已完成项目脚手架、配置解析、密钥脱敏、基础 CLI 参数校验和 LLM 内部协议/provider 抽象；Agent Loop 与本地工具将在后续阶段实现。

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

## CLI

构建后可运行：

```bash
node dist/cli.js --cwd /path/to/workspace "task"
```

当前 CLI 仍仅验证启动目录和 `--cwd`，尚未执行完整任务。
