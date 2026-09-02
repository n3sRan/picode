# picode

`picode` 是一个从零实现的 TypeScript Coding Agent。它通过 OpenAI-compatible Chat Completions API 理解编程任务，由模型选择本地工具完成文件浏览、修改和命令验证；工具参数、路径边界、审批和任务终止都由本地运行时控制。

项目使用官方 `openai` JavaScript/TypeScript SDK 处理 HTTP、SSE 和流式响应聚合，但不使用 LangChain、OpenAI Agents SDK 等 Agent 框架。

## 特性

- OpenAI-compatible Chat Completions、SSE streaming 和原生 tool calling。
- 严格串行的 Agent Loop，以及唯一的 `finish` 完成协议。
- `finish` 终态显示当前上下文估算 token 数和窗口占用比例。
- 交互模式支持显式 `/compact`；自动压缩默认关闭，可按窗口比例阈值开启。
- 本地 JSON Schema 参数校验、工具错误处理、重复调用检测和任务限制。
- 工作区路径策略、符号链接边界检查、`.env` 文件保护和输出脱敏。
- 每条 shell 命令逐次审批；命令以当前用户权限运行。
- 原子 session 快照、pending tool 恢复和 CLI 交互模式。
- 可替换的 scripted provider、审批 broker 和 shell runner，便于确定性测试。

## 环境要求

- Node.js 22 或更高版本
- macOS 或 Linux
- 一个支持 Chat Completions、streaming 和 tools/tool_calls 的 OpenAI-compatible 网关

## 快速开始

在仓库根目录安装依赖、构建并配置 API Key：

```bash
npm install
npm run build
cp .env.example .env
```

编辑 `.env` 填入 `PICODE_API_KEY`，然后执行一次任务：

```bash
node dist/cli.js --cwd /path/to/workspace "修复测试失败并运行验证"
```

不带任务参数会进入交互模式：

```bash
node dist/cli.js --cwd /path/to/workspace
```

也可以将本地构建注册为 `picode` 命令：

```bash
npm link
picode --cwd /path/to/workspace "检查并修复这个项目"
```

查看命令帮助：

```bash
picode --help
```

## 配置

配置优先级为：进程环境变量 > 启动目录中的 `.env` > 代码默认值。程序只读取以下八个配置项，不会把 `.env` 的其他内容注入子进程环境。

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `PICODE_API_KEY` | 是 | 无 | API Bearer Token；不会写入 session 或传给子进程 |
| `PICODE_BASE_URL` | 否 | `https://api.openai.com/v1` | OpenAI-compatible API 根地址 |
| `PICODE_MODEL` | 否 | `gpt-5.6` | 网关使用的模型标识 |
| `PICODE_CONTEXT_WINDOW` | 否 | `1000000` | 上下文窗口大小 |
| `PICODE_MAX_OUTPUT_TOKENS` | 否 | `128000` | 单次模型请求的最大输出长度 |
| `PICODE_MAX_LLM_REQUESTS` | 否 | `30` | 每个任务允许的最大模型请求数 |
| `PICODE_AUTO_COMPACT` | 否 | `false` | 是否在普通 LLM 请求前自动压缩上下文 |
| `PICODE_AUTO_COMPACT_THRESHOLD` | 否 | `0.8` | 自动压缩触发比例；必须小于 0.9 |

`.env.example` 中提供了可直接复制的模板。进程环境变量适合 CI 或临时覆盖配置。

## CLI 用法

```text
picode [--cwd <path>] [--verbose] [<task>]
```

- `picode`：进入交互模式；存在最近 session 时恢复，否则创建新 session。
- `picode "<task>"`：创建新 session，执行单个任务并以终态退出码结束。
- `--cwd <path>`：指定一个已存在的工作区目录。
- `--verbose`：启动时开启当前进程的完整工具、usage 和 finish 输出。

交互模式支持：

| 命令 | 作用 |
| --- | --- |
| `/new [name]` | 创建并切换到新 session |
| `/sessions` | 列出当前工作区的 session |
| `/resume <id>` | 按完整 ID 或无歧义前缀恢复 session |
| `/compact` | 用一次无工具摘要请求整理安全的历史上下文 |
| `/verbose` | 开启当前进程的详细终端输出 |
| `/verbose off` | 关闭当前进程的详细终端输出 |
| `/exit` | 退出交互模式 |

终端输出详细度默认关闭。启动时使用 `--verbose` 或交互中输入 `/verbose` 开启完整输出，使用 `/verbose off` 关闭。关闭时普通工具只在完成后显示工具名和执行状态的一行，finish 只显示最终状态；每轮 `[usage]` 隐藏，但 finish 后的独立 `[context]` 信息始终显示。该开关只在当前进程内生效，不写入 session。

单任务模式的退出码：

| 退出码 | 含义 |
| --- | --- |
| `0` | `finish(status=success)`，任务完成 |
| `2` | `finish(status=partial)`，部分完成 |
| `3` | 失败、协议错误或不可恢复错误 |
| `4` | 请求数、活跃时间、重复调用或上下文限制 |
| `130` | 用户中断 |

## 内置工具

| 工具 | 用途 |
| --- | --- |
| `list_files` | 列出工作区或 session 临时目录中的文件 |
| `search_files` | 搜索文本，支持文件数和总字节预算 |
| `read_file` | 读取 UTF-8 文件或指定行范围 |
| `write_file` | 新建或覆盖文件，使用原子写入 |
| `edit_file` | 对唯一匹配的文本执行原子替换 |
| `run_command` | 经用户逐次审批后运行 shell 命令 |
| `finish` | 报告任务成功、部分完成或失败，并结束当前任务 |

正常完成必须由模型调用唯一的 `finish` 工具；仅输出文本不会被视为成功完成。

## 安全边界与数据存储

- 文件工具只允许访问 canonical workspace 和当前 session 临时目录 `/tmp/picode-<session-id>/`。
- `.env` 和 `.env.*` 默认禁止被文件工具读取、搜索或修改；`.env.example` 例外。
- `run_command` 每次都需要审批。审批后的命令继承当前用户环境，仅移除 `PICODE_*` 和 `OPENAI_API_KEY`，并以当前用户权限运行；它不是操作系统级沙箱，可能访问网络和工作区外路径。
- API Key 在 UI、错误、工具输出和 session 快照中会被脱敏。
- session 保存在 `~/.picode/projects/<workspace-hash>/`，不写入目标仓库。工具执行前会保存 pending marker；进程异常退出后只提示副作用状态未知，不会自动重放未确认的工具调用。

## 开发与测试

```bash
npm run build
npm run typecheck
npm test
```

默认测试套件只使用 fake provider、临时目录和安全的测试 runner，不访问网络。真实 API 流程应在仓库外的隔离 demo 中，通过打包后的 `picode` bin 入口显式运行；该流程已人工验证，但由于模型输出具有不确定性，不纳入默认自动化测试。

更多设计约束和模块说明见：

- [产品规格](docs/SPEC.md)
- [架构说明](docs/ARCHITECTURE.md)
- [实施计划](docs/PLAN.md)

## 当前限制

- 只支持 OpenAI-compatible Chat Completions，不支持其他模型协议。
- 不提供 Web UI、IDE 插件、MCP、子 Agent、并行工具或 Windows 支持。
- 自动压缩默认关闭；上下文保护使用保守估算，并不等同于 tokenizer 计算。
- shell 审批是用户确认机制，不是容器或操作系统级沙箱。

## License

MIT
