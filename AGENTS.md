# picode 项目指南

## 项目背景

本仓库实现一个从零构建的 TypeScript Coding Agent，包名和命令名均为 `picode`。项目用于软件工程专业推免项目，目标是证明作者理解并亲自实现 Agent Loop、上下文与会话、本地工具、权限边界、终止条件和错误处理，而不是在现成 Agent 产品或 Agent 框架上封装界面。

题目允许使用模型厂商 API 客户端库和模型原生 tool calling，但禁止使用 LangChain、LlamaIndex、OpenAI Agents SDK、Claude Agent SDK、AutoGen、CrewAI 等 Agent 框架，也禁止依赖服务端托管的文件或代码执行工具。

## 设计来源

本项目参考了 [pi-from-scratch](https://github.com/SaladDay/pi-from-scratch) 对 Coding Agent 核心数据流的拆解，但所有核心模块均根据本项目规格重新设计和实现。主要扩展包括工具参数验证、路径策略、命令审批、显式终止协议、会话恢复、上下文计量和可回退的上下文压缩。

## 当前 MVP 范围

- TypeScript、ESM、Node.js 22+，目标平台为 macOS/Linux。
- 交互式 CLI 与 `picode "任务"` 单任务模式。
- 默认以启动时的 cwd 为工作区，支持 `picode --cwd <path>`。
- 仅接入 OpenAI-compatible `/chat/completions`：Bearer Token、SSE streaming、原生 `tools/tool_calls`。
- 使用官方 `openai` JavaScript/TypeScript SDK处理 HTTP、SSE 和流式聚合；Agent Loop 和本地工具仍由本项目实现。
- 工具：`list_files`、`search_files`、`read_file`、`write_file`、`edit_file`、`run_command`、`finish`。
- 严格串行工具执行。
- 工作区路径边界与逐命令审批。
- 基本多会话：新建、列出、恢复。
- 原子会话快照、usage 记录、上下文计量和上下文上限保护。
- 显式 `/compact` 压缩，以及默认关闭、可配置阈值的自动压缩。
- 终端 verbose 控制：`--verbose`、`/verbose` 和 `/verbose off`，以及始终显示的独立 `[context]` 信息。
- 确定性测试与一个显式运行的真实 API E2E。

## 当前 MVP 明确不做

- Web UI、IDE 插件、浏览器、MCP、子 Agent、多模态。
- 其他模型协议、Git 专用工具、文件撤销、并行工具调用。
- 容器级或操作系统级强沙箱。
- 工作区外文件工具访问，包括只读访问。
- 会话重命名和删除。
- 高级 glob/regex 搜索。
- 精细化 shell 命令风险解析。
- append-only 审计事件日志和复杂事件重放。
- 完整混合 token 校准。

这些能力只可在 MVP 全部验收且时间允许时作为可选增强，不得阻塞核心交付。

## 终端详细度控制（已实现）

- 终端详细度默认关闭，可由启动参数 `--verbose` 或交互命令 `/verbose` 开启，并由 `/verbose off` 关闭。
- verbose 状态只在当前进程内生效，不写入 session；`--verbose` 同时适用于交互模式和单任务模式。
- verbose 开启时保持完整的 tool、tool result 和每轮 usage 输出；关闭时普通工具压缩为包含工具名和执行结果状态的一行，隐藏 call ID、参数和返回值，并隐藏每次请求的 `[usage]`。
- finish 在 verbose 关闭时隐藏自身的 tool/tool result，只保留最终状态；verbose 开启时保持完整输出。
- finish 终态后的上下文计量以独立的 `[context]` 信息输出，位于状态行之后，且无论 verbose 是否开启都显示。

## 会话启动与历史回放（已确认，尚未实现）

- `picode` 启动时默认创建新 session；`picode "任务"` 也在新 session 中执行任务。
- `picode --resume` 恢复当前 workspace 最近更新的 session；`picode --resume <id>` 恢复指定 session。`--resume` 不与任务文本组合使用；没有可恢复 session 时直接报错退出。
- 交互命令 `/resume <id>` 恢复指定 session，并将历史消息输出一次；`/resume` 仍要求提供 ID 或无歧义前缀。
- 历史回放只展示快照中可重建的 user、assistant 和 tool 消息，隐藏 system 消息；tool、finish 和 assistant 文本遵循当前 verbose/非 verbose 展示规则。
- 历史回放不补造旧的每轮 `[usage]` 或 `[context]` 信息，也不执行历史工具；session 不增加 event log。

## 不可破坏的设计约束

1. Agent Loop 必须由本项目显式实现，状态、错误和终止原因必须可观察、可测试。
2. 正常完成必须由模型调用唯一的 `finish` 工具；纯文本停止不等于任务成功。
3. 每个用户任务默认最多 30 次 LLM 请求（可由 `PICODE_MAX_LLM_REQUESTS` 配置）、10 分钟 Agent 活跃时间；单次模型请求 120 秒、单条命令 60 秒。
4. 连续 3 次工具错误，或第 3 次出现完全相同的连续工具调用时终止；重复调用的第 3 次不得执行。
5. 所有 tool arguments 必须在本地验证。任一调用预验证失败时整批不执行，并为每个 tool-call ID 补齐结果。
6. 工具严格串行执行；`finish` 也必须先写入对应 tool result 再进入终态。
7. 文件工具只允许访问 canonical workspace 和本会话临时目录 `/tmp/picode-<session-id>/`。
8. 路径检查必须处理 `..`、绝对路径和符号链接逃逸，不能只做字符串前缀判断。
9. 每条 shell 命令必须逐次审批。审批后的命令以当前用户权限运行，可能访问网络或修改工作区外内容；这不是沙箱。
10. `.env`、`.env.*` 不得被文件工具读取、搜索或发送给模型；`.env.example` 例外。
11. `PICODE_API_KEY` 不得进入日志、快照、测试 fixture、README 或视频；子进程环境必须移除该值，输出必须脱敏。
12. 崩溃后不得自动重放未确认完成的工具调用。基本恢复只加载最近安全快照并向用户提示未知副作用。

## 配置约束

仅支持：

- `PICODE_API_KEY`
- `PICODE_BASE_URL`
- `PICODE_MODEL`
- `PICODE_CONTEXT_WINDOW`
- `PICODE_MAX_OUTPUT_TOKENS`
- `PICODE_MAX_LLM_REQUESTS`
- `PICODE_AUTO_COMPACT`
- `PICODE_AUTO_COMPACT_THRESHOLD`

优先级为 `进程环境变量 > 启动目录中的 .env > 代码默认值`。只读取这八个键，不把 `.env` 全量注入环境。`PICODE_MODEL` 缺省为 `gpt-5.6`，`PICODE_CONTEXT_WINDOW` 缺省为 `1000000`，`PICODE_MAX_OUTPUT_TOKENS` 缺省为 `128000`，`PICODE_MAX_LLM_REQUESTS` 缺省为 `30`，`PICODE_AUTO_COMPACT` 缺省为 `false`，`PICODE_AUTO_COMPACT_THRESHOLD` 缺省为 `0.8`。仓库提交 `.env.example`，并忽略 `.env` 和会话数据。

每个主请求启用 `stream_options.include_usage` 并记录 `usage.prompt_tokens`。自动压缩默认关闭；关闭时下一次请求前仅用最近一次 prompt usage 加新增消息的保守估算做上限保护，usage 缺失时降级为完整上下文估算并显示警告。开启自动压缩后，只在普通请求前达到独立阈值时调用无工具摘要请求，失败或无进展时回退到原有 hard stop。

## 会话约束

会话数据保存在用户目录 `~/.picode/projects/<workspace-hash>/`，不得污染目标仓库。MVP 使用原子 JSON 快照保存消息、usage、任务状态和待确认副作用标记，不实现独立 append-only event log。

如果进程在工具执行期间退出，恢复时必须警告“上次副作用状态未知”，不得自动再次执行该工具。复杂事件重建留作可选增强。

## 开发与验证流程

- 初次实现前必须确认 `docs/SPEC.md`、`docs/ARCHITECTURE.md` 和 `docs/PLAN.md`；当前用户确认已完成，可从 Phase 0 开始。
- 开发仓库是当前 Git 仓库根目录。
- 真实 E2E 应在仓库外的 `<repo-parent>/demo` 或同级临时演示目录运行。
- 不得在开发仓库或参考项目中产生演示任务文件。
- 完整 E2E 必须通过本地打包并安装后的 `picode` bin 入口运行，不能直接调用内部模块。
- 每新增一批测试文件后，必须向用户解释测试目标、覆盖场景、关键断言、未覆盖风险和运行方式。
- 真实 API 测试必须显式运行；缺少凭据时安全跳过。

## MVP 完成标准

- 构建、类型检查和确定性测试全部通过。
- 隔离 demo 可从打包后的 `picode` 入口完成真实的读、改、命令验证和 `finish` 流程。
- 参数错误、路径逃逸、权限拒绝、重复调用、超时和中断均有明确行为。
- 会话可保存和恢复，未确认副作用不会被自动重放。
- 文档与行为一致，不把审批或风险提示描述为强沙箱。
