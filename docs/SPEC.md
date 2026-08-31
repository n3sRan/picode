# picode 产品规格

## 1. 文档状态

- 状态：已确认
- 产品名称与 CLI 命令：`picode`
- 开发仓库：当前 Git 仓库根目录
- 目标平台：macOS/Linux，Node.js 22+

本文定义截止日前必须完成的 MVP。最终两分钟演示题目和主要卖点在实现稳定后决定。

## 2. 产品目标

`picode` 是一个从零实现的终端 Coding Agent。用户给出编程任务后，它通过 OpenAI-compatible Chat Completions 网关调用模型，由模型选择本地工具；程序验证参数、取得必要授权、执行工具并回填结果，直到模型显式调用 `finish` 或系统以明确原因终止。

优先级：

1. Agent Loop 正确且可解释；
2. 工具参数与工作区边界可靠；
3. 命令执行必须由用户控制；
4. 会话可基本恢复；
5. 行为可以确定性测试。

## 3. MVP 范围

### 3.1 必须支持

- 交互式 CLI 和单任务 CLI。
- 当前目录作为默认工作区，支持 `--cwd`。
- 流式 assistant 文本和原生 function tool calling。
- 本地参数校验与严格串行工具执行。
- 文件工具限制在工作区和会话临时目录。
- 每条 shell 命令逐次审批。
- 最大请求数、超时、重复调用、连续错误和 Ctrl+C 中断。
- 显式 `finish` 成功协议。
- 会话新建、列出、恢复和原子快照。
- `usage.prompt_tokens` 记录及简单上下文上限保护。
- 确定性测试和隔离目录中的真实 API E2E。

### 3.2 当前不做

- Web UI、IDE 插件、浏览器、MCP、子 Agent、多模态。
- OpenAI-compatible Chat Completions 以外的协议。
- Agent 框架、服务端文件工具或服务端代码执行。
- Git 专用工具、撤销、自动提交、并行工具。
- 工作区外文件工具访问。
- 会话重命名、删除。
- 高级 glob/regex 搜索。
- 细粒度命令语法和风险分析。
- append-only 审计日志、复杂崩溃事件重放。
- 自动上下文压缩和完整 token 校准系统。
- 容器或操作系统级沙箱、Windows 支持。

### 3.3 可选增强

只有在所有 MVP 验收项完成后才能考虑：

1. `/rename`、`/delete`；
2. 工作区外只读审批；
3. 搜索 glob/regex；
4. 更细的命令风险分类；
5. append-only event log 和精细崩溃重放；
6. usage 锚点、增量估算与自动 compaction。

可选增强不得改变 MVP 的公开运行方式或延误测试和演示。

## 4. CLI

### 4.1 启动

- `picode`：进入交互模式；有最近会话则恢复，否则新建。
- `picode "<task>"`：创建新会话并执行一个任务，完成后退出。
- `picode --cwd <path>`：以指定的现有目录为工作区。
- `picode --cwd <path> "<task>"`：在指定目录执行单任务。

工作区启动时转换为 canonical path。若标准输入不是 TTY，需要审批的工具默认拒绝，不能隐式批准。

### 4.2 交互命令

- `/new [name]`
- `/sessions`
- `/resume <id>`
- `/exit`

只有 Agent 空闲或当前任务已终止时才能切换会话。会话 ID 使用 UUID，CLI 可接受无歧义短前缀。

### 4.3 任务终态与退出码

- `completed` / `0`：`finish.status=success`
- `partial` / `2`：`finish.status=partial`
- `failed` / `3`：`finish.status=failure`、协议错误上限或不可恢复错误
- `limit_reached` / `4`：步数、时间、重复调用或上下文限制
- `aborted` / `130`：用户中断

终态结束一次用户任务，不关闭交互式 CLI。用户继续输入时在同一 session 中创建新的任务段，并重置逐任务计数。

## 5. LLM 网关

### 5.1 最低契约

网关必须支持：

- OpenAI-compatible `POST /chat/completions`；
- Bearer Token；
- SSE streaming；
- `tools`、`tool_choice`、assistant `tool_calls`；
- role 为 `tool` 的结果消息；
- `stream_options.include_usage=true`。

工具调用协议不兼容时明确失败，不增加其他厂商格式适配。usage 缺失时允许降级估算并显示一次警告。

### 5.2 SDK 边界

使用官方 `openai` JavaScript/TypeScript SDK和自定义 `baseURL`。SDK负责 HTTP、认证、SSE 解码、流式聚合和取消。

`picode` 自己负责：

- 内部消息转换；
- Agent Loop 和状态；
- tool-call 语义及参数校验；
- 本地工具和审批；
- 限制、上下文保护和会话快照。

不得使用 SDK的自动工具执行或 Agent runner 代替这些逻辑。

### 5.3 配置

| 变量 | 必需 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `PICODE_API_KEY` | 是 | 无 | 不得记录或传给子进程 |
| `PICODE_BASE_URL` | 否 | `https://api.openai.com/v1` | API 根地址 |
| `PICODE_MODEL` | 是 | 无 | 网关模型标识 |
| `PICODE_CONTEXT_WINDOW` | 否 | `128000` | 正整数；按实际模型配置 |

优先级为 `进程环境变量 > 启动目录中的 .env > 代码默认值`。只解析这四个键，不把 `.env` 的其他内容注入环境。请求最大输出默认值为代码常量 `16384`，单次请求超时 120 秒。

## 6. Agent Loop

### 6.1 状态

运行态：

- `idle`
- `preparing_context`
- `streaming`
- `validating_tools`
- `awaiting_approval`
- `executing_tool`
- `recording_results`

终态：`completed | partial | failed | aborted | limit_reached`。

### 6.2 循环

1. 保存 user message。
2. 检查任务限制和上下文上限。
3. 流式调用 LLM并展示文本。
4. 聚合完整 assistant message、tool calls、finish reason 和 usage。
5. 对整批 tool calls 做本地预验证。
6. 任一调用非法时整批不执行，为错误调用生成具体错误，为其他调用生成 `batch_rejected`。
7. 合法批次严格串行执行，需要审批时暂停活跃计时。
8. 为每个 tool-call ID 保存对应 tool result。
9. 普通工具完成后把结果发送给下一轮模型；合法 `finish` 写入结果后进入终态。

系统提示要求模型在每个用户请求的最终响应中调用一次 `finish`。普通问答可以在同一响应中输出文本并调用 `finish`，因此不需要额外的 LLM 回合。模型只输出纯文本而未调用工具时，系统追加协议提醒并继续；连续 3 次仍未调用 `finish` 则失败。

### 6.3 `finish`

`finish` 必须是该次响应唯一的 tool call；普通问答的文本可以和这个 tool call 同时返回：

- `status`（必填）：`success | partial | failure`
- `summary`（可选）：完成摘要；省略时由运行时按状态补默认摘要
- `verification`（可选）：验证说明；省略时记录为未提供验证说明
- `remainingIssues`（可选）：遗留问题；省略时按空字符串处理

合法 `finish` 也必须生成 `accepted` tool result，以保证后续会话历史仍满足 Chat Completions 的 tool-call/result 配对要求。

### 6.4 限制

- 每个用户任务最多 50 次 LLM 请求。
- Agent 活跃时间最多 10 分钟，不包含等待审批时间。
- 单次 LLM 请求最多 120 秒。
- 单条命令最多 60 秒。
- 连续工具错误达到 3 次终止；成功工具结果重置计数。
- 相同工具名和规范化参数连续出现第 3 次时，在执行前终止。
- 用户拒绝审批不计工具错误，但仍参与重复调用检测。
- Ctrl+C 取消当前请求或命令并进入 `aborted`。

## 7. 工具

所有工具对模型提供 JSON Schema，并在执行前使用本地 validator 再次检查；未知字段默认拒绝。

### `list_files`

- 输入：`path`，可选 `recursive` 和 `maxDepth`。
- 仅限允许根目录，设置条目数、深度和输出大小上限。

### `search_files`

- 输入：`query`，可选 `path` 和大小写选项。
- MVP 只做文字搜索，不提供 glob/regex。
- 输出文件、行号和匹配行，并设置数量上限。

### `read_file`

- 输入：`path`，可选 1-based `startLine`、`endLine`。
- 只读 UTF-8 文本；二进制或超大文件给出明确错误/截断信息。

### `write_file`

- 输入：`path`、`content`。
- 可新建父目录并完整覆盖文件。
- 仅允许 workspace 或 session tmp，不提供备份或撤销。

### `edit_file`

- 输入：`path`、`oldText`、`newText`。
- `oldText` 必须恰好匹配一次。
- 使用同目录临时文件和原子替换，避免半写。

### `run_command`

- 输入：`command`。
- 从 workspace root 启动，严格串行。
- 每次展示完整命令、cwd、超时和通用高风险提示，由用户逐次批准。
- 可用简单关键词额外提示明显网络命令，但不实现完整 shell 分析。
- 返回 stdout、stderr、exit code、signal、耗时和截断状态。
- 大输出写入 session tmp，模型只接收截断摘要。
- 子进程以当前用户权限运行，可能访问网络和工作区外路径；这不是沙箱。
- 子进程环境移除 `PICODE_API_KEY` 等本项目敏感值。

### `finish`

控制工具，不执行外部副作用；契约见 6.3。

## 8. 路径与安全

### 8.1 允许根目录

- canonical workspace root；
- `/tmp/picode-<session-id>/`。

文件工具访问其他路径一律拒绝，MVP 不提供工作区外审批。

现有路径通过 `realpath` 检查。新路径解析最近存在父目录的真实路径后再校验目标。比较使用路径分段语义，防止 `..`、相似前缀和符号链接逃逸。写入前再次检查目标。

### 8.2 Protected files

`.env`、`.env.*` 禁止被 list/search/read/write/edit 工具访问，`.env.example` 例外。配置加载器只读取允许的 `PICODE_*` 键。

### 8.3 凭据与 shell

- API Key 不写入 session、错误、工具输出或 UI。
- 所有输出在展示和持久化前执行实际 key 脱敏。
- shell 每次审批，但审批后拥有当前用户权限，可能绕过文件工具边界。
- 网络提示是提醒，不是网络隔离。

## 9. 上下文保护

MVP 不自动压缩上下文，只实现简单预算保护：

1. 每个请求启用 `include_usage` 并记录最近一次 `usage.prompt_tokens`。
2. 下一请求前，对该响应之后新增的 assistant/tool/user 内容做保守字符估算。
3. `最近 prompt_tokens + 新增估算` 达到 context window 的 75% 时显示警告。
4. 达到 90% 时不再发送请求，进入 `limit_reached`，提示用户创建新会话。
5. usage 缺失时对当前完整 context 做保守估算，并显示一次降级警告。

该机制只防止明显超限，不宣称等价于模型 tokenizer。自动 compaction 和更完整的 usage 锚点管理属于可选增强。

## 10. 基本会话持久化

会话保存在：

`~/.picode/projects/<sha256(canonical-workspace)>/sessions/<session-id>.json`

快照至少包含：

- session ID、名称、workspace、创建/更新时间；
- 完整模型消息；
- 最近 usage 与任务终态；
- 逐任务限制计数；
- 可选的 pending tool 标记。

写入采用同目录临时文件加 rename，避免半写 JSON。MVP 不实现独立 event log。

执行可能产生副作用的工具前写入 pending 标记，得到结果后清除并更新快照。若启动时发现 pending 标记，显示“上次工具结果未知”，不自动重放；用户可以恢复会话并要求 Agent先检查现状，或创建新会话。MVP 不从事件流精确重建崩溃现场。

## 11. 错误与可观察性

- 配置错误必须在网络请求前失败。
- API、格式和工具错误映射为稳定内部错误类型。
- 被跳过、拒绝或中断的 tool call 也必须有对应结果。
- 终端显示 session、workspace、流式文本、工具调用、审批、结果摘要、usage 和最终终止原因；不同事件类型必须有独立标签或区块，不能全部使用同一种普通文本格式。
- 不默认显示完整请求体、完整 session 快照或凭据。

### 11.1 CLI 输出

- assistant 流式文本以 `[assistant]` 区块开始，并在下一类事件前结束当前文本区块。
- 工具调用显示工具名、call ID 和经过脱敏的参数摘要；工具结果显示工具名、状态、call ID 和结果摘要。
- 审批请求和审批结果单独显示；实际审批输入仍由 Approval Broker 独占。
- usage 至少显示当前请求序号和已返回的 `prompt_tokens`；存在时显示 `completion_tokens` 和 `total_tokens`。
- TTY 输出可以使用 ANSI 语义颜色；非 TTY 输出必须不包含 ANSI 控制序列并保持稳定文本格式。
- 超长参数、命令和结果摘要在展示层截断，不能改变发送给模型或保存到 session 的内容。

## 12. 验收测试

### 确定性测试

- 配置优先级、缺失值和脱敏。
- SDK流的文本、tool calls、usage、取消和错误归一化。
- 所有工具的成功、无效参数、截断、超时和中断。
- 路径 `..`、相似前缀、绝对路径、符号链接和 protected files。
- 命令批准、拒绝、non-TTY 拒绝和敏感环境过滤。
- Agent Loop 串行性、finish、错误上限、重复调用、步数和 Ctrl+C。
- session 原子保存/恢复、损坏 JSON 和 pending tool 警告。
- usage 记录、75% 警告、90% 停止和缺失 usage 降级。
- CLI slash commands 和单任务退出码。

### 真实 E2E

- 显式配置 API 后运行，默认测试套件不访问网络。
- 构建并 `npm pack`，在仓库外 `<repo-parent>/demo` 安装本地 tarball。
- 从安装后的 `picode` bin 入口开始，完成一次读、改、命令验证和 `finish`。
- 不在开发仓库或参考项目中产生演示任务文件。

每新增一批测试文件后，都要向用户解释测试目标、覆盖场景、关键断言、未覆盖风险和运行方式。

## 13. 延后决定

- 最终视频任务；
- 视频主要展示点；
- 对外差异化卖点；
- 是否实现任一可选增强。
