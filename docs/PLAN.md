# picode 实施计划

## 1. 状态与原则

- 当前状态：Phase 0-5 已完成，Phase 6 进行中（限制与文件搜索边界、基础结构清理、LLM 运行参数配置、取消/超时处理、批次调用关联、macOS 大小写路径保护和恢复/限制回归测试已完成，下一批待定）。
- Phase 7 已开始：批次 H（`finish` 后上下文计量）、I（显式 `/compact`）和 J（默认关闭的自动压缩）已完成，下一步进行全量回归与隔离演示复核。
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
| M5 | 全量验证与隔离 E2E | 本地 tarball 可在仓库外 demo 从 `picode` bin 完成真实任务（已由用户手动验证） |
| M6 | 文档、演示与提交检查 | 行为与文档一致，演示方案和提交物就绪 |
| M7 | 上下文可观测性与压缩 | `finish` 终态显示当前上下文（已完成）；`/compact` 可安全整理 session；可选自动压缩在阈值前触发且关闭时行为不变 |

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
- 只读取八个 `PICODE_*` 键，并支持模型、上下文窗口、单次输出长度、任务请求上限、自动压缩开关和阈值的默认值与覆盖。
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
- `search_files` 文件数/总字节预算、取消和不完整扫描标记。
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
5. 实现默认 30 次请求（可按任务配置）、10 分钟活跃时间、连续错误、无 finish 和重复调用限制。
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

状态：已完成（真实流程已由用户手动验证）。

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

真实 API 流程已由用户在仓库外隔离 demo 中，通过打包后的 `picode` bin 入口手动完成读、改、命令验证和 `finish`。由于模型输出具有不确定性，该流程不纳入默认自动化测试；需要复核时仍必须显式运行，缺少凭据时安全跳过。至少连续两次完成同一任务，才把它列为视频候选。

出口：开发仓库和参考项目中没有演示任务产物；全流程从打包后的 bin 入口完成（已通过）。

## 9. Phase 6：加固与提交准备

状态：进行中（CLI UI 重构、限制与文件搜索边界、基础结构清理、LLM 运行参数配置、取消/超时处理、批次调用关联、macOS 大小写路径保护，以及符号链接和崩溃恢复回归测试已完成；等待下一批加固工作）。

CLI UI 重构出口：事件类型有清晰的终端分组；TTY 使用 ANSI 语义颜色，非 TTY 保持无颜色的稳定文本；assistant 流式文本、工具调用/结果、审批、usage、warning 和终态均有独立展示；renderer 可通过确定性测试验证。

任务：

1. 确认 build、typecheck 和确定性测试通过；真实 API 流程以仓库外隔离 demo 的显式手动 smoke run 复核，不作为默认自动化测试。
2. 检查仓库是否含凭据、session、demo 产物或大文件。
3. 更新项目 README并准备符合字数限制的提交说明。
4. 根据 E2E 稳定性确定视频任务和一个主要卖点。
5. 录制并检查视频时长、格式和大小。
6. 核对公开仓库、提交历史和最终压缩包。

## 10. Phase 7：上下文可观测性与压缩

状态：进行中（批次 H、I、J 已完成；SPEC、ARCHITECTURE 和本计划已同步，批次 K 待执行）。

目标是在不破坏现有 `finish`、请求上限、session 恢复和工具安全边界的前提下，增加可解释的上下文度量和可回退的压缩能力。实现顺序固定为“度量 → 显式压缩 → 自动压缩 → 回归和演示”，每一步都先保持 build、typecheck 和确定性测试可通过。

### 10.1 设计冻结项

1. `finish` 路径：先追加 accepted tool result 和安全 checkpoint，再计算当前消息 + tool schema 的上下文估算；最后将 token 数和窗口百分比放到 `[completed]`、`[partial]` 或 `[failed]` 终态块末尾。不发送额外 LLM 请求。
2. BudgetTracker：保留现有真实 `prompt_tokens` anchor + 新增内容估算；usage 缺失、session 恢复或压缩后重新从 fallback 估算，并标记来源。
3. ContextCompactor：摘要请求不带工具、不执行本地副作用、不要求 `finish`；只裁剪完整消息组，保留 system message、当前任务和必要的最近 tool call/result 配对；压缩失败不替换原消息。
4. `/compact`：仅交互模式、仅 idle/终态可用；自动开关关闭时依然有效；无可压缩消息返回 no-op；成功后原子保存并使旧 usage anchor 失效。
5. 自动压缩：新增 `PICODE_AUTO_COMPACT=false` 和 `PICODE_AUTO_COMPACT_THRESHOLD=0.8`；只在普通请求前的 `preparing_context` 阶段触发。关闭时严格回归 75% warning、90% stop；开启后压缩无进展不得无限重试。
6. 限制和恢复：自动摘要请求消耗当前任务一个 LLM request slot，并受现有取消、活跃时间和 120 秒超时约束；显式命令是独立的一次压缩操作。摘要请求期间退出时保留旧快照，不自动重放。

### 10.2 实现批次

批次 H：完成度量和终态展示（已完成）。

- 已扩展 BudgetTracker 的当前上下文计算接口和 `AgentRunResult`/事件数据；
- 已在 finish tool result 写入后计算度量，并让 renderer 将其作为终态末尾详情；
- 已覆盖 usage anchor、fallback、tool schema、finish result、终态顺序和“不得增加请求”的行为；
- 已运行 `npm run build`、`npm run typecheck` 和 `npm test`；批次 H 当时 82 个测试通过，当前全量回归为 97 个测试通过。

批次 I：ContextCompactor 与显式 `/compact`（已完成）。

- 实现摘要请求适配、摘要文本校验、脱敏和安全消息边界；
- 扩展 CLI command、TerminalApp 路由和 compact 结果展示；
- 覆盖空闲成功、busy 拒绝、无可压缩内容、摘要失败、取消、脱敏、保存失败和 session 快照读取；
- 重点断言旧消息不会产生孤立 tool result，system/current task 不会误删，失败不会污染原 session。

批次 J：自动压缩和配置（已完成）。

- 扩展配置 allowlist、`.env`/进程环境优先级、布尔值和比例校验，并补齐 `.env.example`、README 和帮助文本；
- 在 `preparing_context` 接入阈值判断、`compacting_context` 状态、重新预算和 hard-stop 回退；
- 覆盖默认关闭回归、80% 默认阈值、自定义阈值、请求额度不足、取消、无进展和压缩失败后的回退；120 秒超时沿用统一 LLM provider 超时测试；
- 重点断言自动摘要不会在工具执行中触发，不会跳过 90% stop，也不会形成重复压缩循环。

批次 K：端到端和视频候选复核。

- 使用 fake provider 在临时目录完成完整显式压缩流程和自动压缩流程；
- 构建并 `npm pack`，在仓库外隔离 demo 中从安装后的 `picode` bin 运行，确认 session 保存/恢复和终态输出；
- 真实 API 仍只做显式人工 smoke run，凭据缺失时安全跳过默认测试；
- 视频优先展示稳定可复现的 `/compact`、压缩前后占用和 `finish` 末尾计量，自动压缩作为可选补充镜头。

### 10.3 Phase 7 出口

- build、typecheck、全量确定性测试通过；
- 接受的 `finish` result、上下文度量和终态事件顺序可测试、可观察；
- `/compact` 在自动关闭时仍可用，成功/失败/取消均有明确输出且不破坏消息配对；
- `PICODE_AUTO_COMPACT=false` 与原 75%/90% 预算行为一致；开启后在阈值处有限压缩、失败回退，不绕过任务限制；
- 压缩后的 session 能原子恢复，摘要和输出不会泄露 API Key；
- 隔离 demo 可以从打包后的 bin 展示读、改、验证、压缩、恢复和 `finish`，且开发仓库无演示产物（批次 K 待复核）。

## 11. 可选增强门

只有以下条件全部满足后才评估增强：

- M0–M5 全部出口通过；
- 核心 E2E 已连续成功；
- 没有影响安全或恢复的已知高优先级缺陷；
- 用户明确同意增加范围。

上下文计量与压缩已经由用户明确纳入 Phase 7，不再重复作为待评估增强。

增强候选按优先级：

1. append-only event log；
2. 工作区外只读审批；
3. 会话 rename/delete；
4. 高级搜索和命令风险分析。

不要为了实现增强改变已验证的核心路径。

## 12. 测试解释要求

每新增一批测试文件后，向用户说明：

1. 新增文件和对应模块；
2. 主要成功与失败路径；
3. 关键断言为什么能证明目标行为；
4. 使用 fake、临时目录还是真实 API；
5. 运行命令和结果；
6. 尚未覆盖的风险。

## 13. 用户确认门（已通过）

用户确认前，不创建 `src/` 实现、不安装依赖、不创建 demo、不运行真实 API。当前已完成用户确认，可从 Phase 0 开始。
