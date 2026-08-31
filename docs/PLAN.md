# picode 实施计划

## 1. 状态与原则

- 当前状态：Phase 0-5 已完成，Phase 6 进行中（CLI UI 重构已完成）。
- 优先完成可解释、可测试的 MVP，不以生产级完整性为目标。
- 每个阶段都必须保持可构建、可测试。
- 可选增强只能在全部 MVP 验收通过后开始。

## 2. 里程碑

| 阶段 | 目标 | 验收出口 |
| --- | --- | --- |
| M0 | 项目脚手架与配置 | 构建、类型检查和基础配置测试可运行（已完成） |
| M1 | LLM Adapter 与内部协议 | 模拟流可产生文本、tool calls、usage 和结束原因（已完成） |
| M2 | 文件工具、路径边界与命令审批 | 七个工具完成，参数和路径安全测试通过（已完成） |
| M3 | Agent Loop 与终止条件 | fake model 可完成串行读、改、命令验证和 `finish`（已提交） |
| M4 | 基本会话持久化与 CLI | 会话可新建、列出、恢复；单任务与交互入口可用（已提交） |
| M5 | 全量验证与隔离 E2E | 本地 tarball 可在仓库外 demo 从 `picode` bin 完成真实任务（已完成） |
| M6 | 文档、演示与提交检查 | 行为与文档一致，演示方案和提交物就绪 |

若进度落后，优先削减 UI 装饰和便利功能，不削减 Loop、参数校验、路径边界、命令审批、终止限制、基本持久化和确定性测试。

## 3. Phase 0：脚手架与配置

状态：已完成。

前置条件：已完成用户对 `AGENTS.md`、`SPEC.md`、`ARCHITECTURE.md` 和本计划的确认。

任务：

1. 初始化 `package.json`、TypeScript ESM、Node 22 engine 和 `picode` bin。
2. 配置 TypeScript strict、Vitest、build、typecheck 和 test scripts。
3. 添加 `.gitignore`、`.env.example` 和最小开发 README。
4. 固定官方 `openai` SDK版本，确认 Chat Completions streaming aggregation API。
5. 实现配置解析和 secret redaction。

测试批次 A：

- 环境变量高于启动目录 `.env`。
- 只读取四个 `PICODE_*` 键。
- 缺少 API Key/model 时在请求前失败。
- API Key 不出现在错误和输出中。
- 非法 `--cwd` 明确失败。

出口：build、typecheck 和测试通过，不访问真实 API（已通过）。

## 4. Phase 1：LLM Adapter

状态：已提交。

任务：

1. 定义内部 message、tool call、usage、event 和 error 类型。
2. 定义 `LlmProvider` 及 scripted fake。
3. 实现内部消息与 Chat Completions 消息的转换。
4. 实现 `OpenAIChatProvider`：base URL、Bearer、stream、tools、usage、AbortSignal 和 120 秒超时。
5. 使用 SDK聚合响应，不自行实现 HTTP/SSE parser。
6. 归一化缺失 usage、协议错误、远端错误和取消。

测试批次 B：

- 纯文本流、多 tool calls、完整 arguments、finish reason。
- usage 存在与缺失。
- 重复/空 tool-call ID、无效 arguments、矛盾 finish reason。
- 超时、取消、认证和网络错误。
- assistant/tool message round-trip。

出口：mocked SDK和 fake provider 都能产生稳定内部结果（已通过）。

## 5. Phase 2：工具与安全边界

状态：已提交。

任务：

1. 实现 tool registry、JSON Schema 和本地 validators。
2. 实现 PathPolicy、protected file 规则和 session tmp。
3. 实现 `list_files`、`search_files`、`read_file`。
4. 实现原子 `write_file` 和唯一匹配 `edit_file`。
5. 实现 ApprovalBroker 接口及 CLI/test 版本。
6. 实现 `run_command`：逐次审批、timeout、abort、输出截断和敏感环境过滤。
7. 实现控制型 `finish` validator。

测试批次 C：文件与路径

- 工作区内正常读写、行范围、文本搜索和输出上限。
- `..`、相似前缀、绝对路径和符号链接逃逸。
- 新目标父目录 realpath、session tmp、工作区外拒绝。
- `.env`/`.env.*` 禁止，`.env.example` 允许。
- edit 匹配 0/1/多次和原子写入失败。

测试批次 D：命令与审批

- 每条命令请求审批；允许、拒绝、non-TTY 拒绝。
- 60 秒 timeout、abort、非零退出和 stdout/stderr。
- 大输出写入 session tmp，模型只收到摘要。
- 子进程看不到 `PICODE_API_KEY`。
- 明显网络命令可以额外提示，但不宣称被阻断。

出口：文件工具无法越过允许根目录，shell 未经审批无法运行。

## 6. Phase 3：Agent Loop

状态：已提交。

任务：

1. 实现状态机和事件流。
2. 实现 context check → LLM → validation → serial tools → result feedback。
3. 实现整批预验证和 tool-call/result 一一配对。
4. 实现 `finish` 唯一调用及三种结果状态。
5. 实现 50 次请求、10 分钟活跃时间、连续错误、无 finish 和重复调用限制。
6. 实现 Ctrl+C、LLM timeout、command timeout 和 skipped tool results。
7. 实现简单 BudgetTracker：记录 usage、75% 警告、90% 停止和缺失 usage 降级。

测试批次 E：

- 纯文本提醒后继续，第三次无 finish 失败。
- 单工具和多工具严格串行。
- 任一无效调用导致整批无副作用拒绝，并补齐全部结果。
- `finish` success/partial/failure、accepted result 和混合调用拒绝。
- 工具错误计数、重复调用执行前终止、步数和活跃时间限制。
- 审批等待不计活跃时间，审批拒绝不计工具错误。
- 75% usage warning、90% stop 和缺失 usage fallback。

出口：scripted fake provider 能确定性完成“读文件 → 编辑 → 运行命令 → finish”（已通过）。

## 7. Phase 4：会话与 CLI

状态：已提交。

任务：

1. 实现 workspace hash 和原子 session JSON store。
2. 实现 `/new`、`/sessions`、`/resume`、`/exit`。
3. 工具执行前写 pending marker，完成后清除。
4. 恢复 pending session 时警告未知副作用，绝不自动重放。
5. 使用 `readline` 组合 Runtime、Provider、Tools、Store 和 ApprovalBroker。
6. 实现流式显示、busy 状态、审批输入独占、usage warning 和退出码。

测试批次 F：持久化

- workspace 之间隔离，多 session 新建、列出和恢复。
- session 原子替换和损坏 JSON 错误。
- pending tool 恢复警告且不执行工具。
- session 中不保存 API Key。

测试批次 G：CLI

- slash commands、短 ID 和 busy 时拒绝切换。
- 审批回答不被当作 user message。
- 单任务各终态退出码。
- Ctrl+C 在空闲和运行状态的行为。
- UI 输出脱敏。

出口：构建后的 bin 能用 fake provider 在临时项目完成全流程（已通过）。

## 8. Phase 5：真实 API 与隔离 E2E

状态：已完成。

准备：

1. 在当前仓库构建并执行 `npm pack`。
2. 在仓库外创建 `<repo-parent>/demo` 或同级隔离演示目录。
3. 在 demo 中安装本地 tarball，从安装后的 `picode` bin 启动。
4. 通过环境变量或未提交的 `.env` 配置真实网关。

E2E 流程：

1. demo 中准备一个小型、测试失败的 TypeScript 项目。
2. Agent 使用 list/search/read 定位问题。
3. Agent 使用 edit/write 修改代码。
4. Agent申请并获批运行测试。
5. 测试通过后调用 `finish(status=success)`。
6. 重启 CLI，验证会话可列出和恢复。

真实 API 测试必须显式运行；缺少凭据时安全跳过。至少连续两次完成同一任务，才把它列为视频候选。

出口：开发仓库和参考项目中没有演示任务产物；全流程从打包后的 bin 入口完成（已通过）。

## 9. Phase 6：加固与提交准备

状态：进行中（当前子任务：CLI UI 重构已完成）。

CLI UI 重构出口：事件类型有清晰的终端分组；TTY 使用 ANSI 语义颜色，非 TTY 保持无颜色的稳定文本；assistant 流式文本、工具调用/结果、审批、usage、warning 和终态均有独立展示；renderer 可通过确定性测试验证。

任务：

1. 运行 build、typecheck、确定性测试和隔离 E2E。
2. 检查仓库是否含凭据、session、demo 产物或大文件。
3. 更新项目 README并准备符合字数限制的提交说明。
4. 根据 E2E 稳定性确定视频任务和一个主要卖点。
5. 录制并检查视频时长、格式和大小。
6. 核对公开仓库、提交历史和最终压缩包。

## 10. 可选增强门

只有以下条件全部满足后才评估增强：

- M0–M5 全部出口通过；
- 核心 E2E 已连续成功；
- 没有影响安全或恢复的已知高优先级缺陷；
- 用户明确同意增加范围。

增强候选按优先级：

1. append-only event log；
2. usage 锚点和自动 compaction；
3. 工作区外只读审批；
4. 会话 rename/delete；
5. 高级搜索和命令风险分析。

不要为了实现增强改变已验证的核心路径。

## 11. 测试解释要求

每新增一批测试文件后，向用户说明：

1. 新增文件和对应模块；
2. 主要成功与失败路径；
3. 关键断言为什么能证明目标行为；
4. 使用 fake、临时目录还是真实 API；
5. 运行命令和结果；
6. 尚未覆盖的风险。

## 12. 用户确认门（已通过）

用户确认前，不创建 `src/` 实现、不安装依赖、不创建 demo、不运行真实 API。当前已完成用户确认，可从 Phase 0 开始。
