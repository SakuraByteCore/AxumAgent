# Codex 子代理契约核实（只读）

基线：openai/codex `26ad281fd1ca712e4f0c7920a6273cf18c961b8a`。独立浅 clone 已实际 `git rev-parse HEAD` 核对，工作树 clean。未运行 Codex 仓库脚本或测试。以下路径均相对 Codex 仓库；源码阅读结论，不冒充运行验证。

## 1. 两代接口不能混用

- V1 命名空间 `multi_agent_v1`：`spawn_agent`, `send_input`, `wait_agent`, `close_agent`, `resume_agent`。见 `codex-rs/core/src/tools/handlers/multi_agents_spec.rs:14`、`multi_agents.rs:77-86`。
- V2 原生 handler：`spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, `list_agents`，实际外层 namespace 可配置，默认 `collaboration`（`config/mod.rs:265`）。**没有 V2 send_input/close/resume 对等工具**；不要把 V1 方法直接当 V2 契约。见 `tools/handlers/multi_agents_v2.rs:28-40`。
- V1 spawn：message/items 二选一且非空；agent_type/model/reasoning_effort 可选；fork_context 默认 false。返回 agent_id/nickname。`tools/handlers/multi_agents/spawn.rs:55-226`、`multi_agents_common.rs:170-198`。
- V2 spawn：message 与 task_name 必填，名字组合为父 canonical path 的子路径；返回 task_name（配置允许时加 nickname），不保证返回 UUID。fork_turns 默认 all；none 表示全新；历史正整数兼容输入也表示全部历史，不是最近 N turn；显式 fork_context 即使 false 也报不支持。`tools/handlers/multi_agents_v2/spawn.rs:195-240`、`thread_spawn.rs:131-175`。
- V1 send_input：target UUID；默认 interrupt=false，入队；true 先发 Op::Interrupt 再提交新输入；返回 submission_id 只是接收凭据。已完成但未关闭的线程可继续用；无需先 resume。`multi_agents/send_input.rs:51-134,148-160`。
- V2 send_message 为 QueueOnly：不会启动 idle agent 的新 turn；followup_task 为 TriggerTurn：idle 时启动，running 时采样消息边界或当前工具完成后交付，**不是强制取消当前任务**；followup 不可指向 root。成功表示 accepted 而非模型已读，成功工具输出为空文本。`multi_agents_spec.rs:222-257`、`multi_agents_v2/message_tool.rs:45-117`、`agent/api.rs:34-70`。

## 2. 深度与名额

- 默认 V1 max_depth=1，root 深度0，child=parent+1，仅 depth>max 拒绝；spawn/resume 均检查，达到上限后 V1 collaboration tools 不再暴露。`config/mod.rs:270`、`agent/registry.rs:80-95`、`multi_agents/spawn.rs:74-81`、`resume_agent.rs:55-61`、`tools/spec_plan.rs:734-747`。
- **V2 忽略 agents.max_depth**。其 native spawn 仍记录 depth，但没有 V1 上限检查；V2 子节点能否看到 native tools 还受模型 multi_agent_version 与 disable_native_tools 控制。`codex-rs/config/src/config_toml.rs:775` 明确注释 Ignored by V2；`thread_spawn.rs:160-175`、`tools/spec_plan.rs:741-746`。
- V1 默认6个 spawned thread（不含 root），在同一 registry 共享，不是每个父亲各6个；原子 reserve，completed 本身不释放注册名额，close/shutdown 才 release。`config/mod.rs:260,1702-1715`、`agent/registry.rs:97-126,338-352`、`agent/control/legacy.rs:8-45`。
- V2 默认 max_concurrent_threads_per_session=4，含 root，因此 child residency/execution 上限通常3。不是整个历史只能创建3个身份。新 spawn 的 registry reservation 不设上限；resident 槽满时可淘汰 idle child、保存状态，之后按需 reload。`config/mod.rs:261,1707-1711`、`agent/control/spawn.rs:638-668`、`agent/control/residency.rs:145-157,187-220`。
- V2 还单独计 running turns：root/non-V2 不受该 execution guard 约束；guard drop 释放 active。**capacity check 与计数不是原子预留**，源码 API 明示其 advisory 性质；实现对照不要误称严格 semaphore。`agent/api.rs:122-138`、`agent/control/execution.rs:25-92`。
- 可淘汰状态 PendingInit/Completed/Errored/Interrupted，但必须无 active_turn、无 durable sleep、无 trigger-turn mailbox；淘汰不是业务完成或显式 close。`agent/control/residency.rs:323-337`。

## 3. 权限继承不是 clone 一份静态 config

- 子 config 从父有效配置起，重新应用调用 step 捕获的 model/reasoning；继承 live provider、developer instructions、cwd、approval policy、approvals_reviewer、permission-profile session snapshot。role/model overlay 后**再次覆盖运行时审批/权限/cwd**，role 不能靠静态配置替换父当下的这些权限。`agent/child_config.rs:54-101,111-170,176-201`。
- V1 full history fork 不允许显式 agent_type；V2 full fork 可显式 role。默认模型还可能被 agents.default_subagent_model/reasoning 覆盖，不能简单写成永远等于父模型。`child_config.rs:64-81,172-178,209-220`。
- V2 cold reload 通过 live immediate parent 当前授权恢复，而不是信任发消息的任意 sender 或历史 child 权限。role 重套后恢复父实时审批/cwd/profile；cached local environment 权限与当前 owner authority 求交；remote executor 权限发生变化时报错，不能偷偷扩大。`agent/control/spawn.rs:317-366,380-495`；`agent/api.rs:80-85`。
- exec policy manager 仅在 child_uses_parent_exec_policy 判定兼容时复用；不是无条件继承所有历史批准。`agent/control.rs:679-692`。

## 4. 取消边界

- 父 turn 的 interrupt/abort_all_tasks 取消该 session active task，清理该 active turn pending inputs/approvals；**不等于树 shutdown，不自动撤销已 accepted 子任务**。`tasks/mod.rs:573-601`；最强直接契约 `agent/api.rs:55-59`：spawn future 返回 acceptance receipt 后 caller cancellation 不 retract accepted child。
- spawn 未完成验收时由 PendingSpawn RAII 持有 provisional child；future 被 drop/cancel 后异步 shutdown、discard persistence、标记 spawn edge Closed；验收成功 disarm 后不再如此。`agent/control/spawn_guard.rs:1-119`。这意味着父取消发生在 acceptance 前后语义不同，不应笼统描述为所有子任务跟着取消。
- V2 interrupt_agent 仅中断目标当前 task，不 close 身份、不递归中断后代；root/self 拒绝；known unloaded/dead runtime 视为成功且不 reload；返回处理前 snapshot（unloaded 在工具层映射 NotFound）。`agent/control/interrupt.rs:1-63`、`multi_agents_v2/interrupt_agent.rs:54-96`。
- V1 close_agent 明确持久化目标 Closed，并 shutdown 目标与内存 spawn tree 可达 live descendants，移除线程/邮箱、释放 registry；不是简单 cancel turn。对已知 unloaded 目标也可关闭。返回 previous_status，不是 shutdown 已后状态。`agent/control/legacy.rs:47-128`、`multi_agents/close_agent.rs:65-114`。
- V1 resume_agent 基于调用 turn 的当前 resume config/source 恢复既有 UUID；仍检查深度和名额；不是新任务输入，后续 send_input 才给任务。`multi_agents/resume_agent.rs:47-139`、`agent/control/spawn.rs:1032-1036`。
- 整个 agent tree shutdown 另有生命周期 fence/token/member tracking，阻止新 start 并等待 teardown；与 turn interrupt 区分。`agent/control/runtime.rs:278-305`、`thread_manager/shutdown.rs`。
- 当前 main 已无 spawn_agents_on_csv/agent-job 批次工具实现；`agents.job_max_runtime_seconds` 只保留反序列化兼容且明确 no-op。不可照旧版本宣称“批次取消/每项默认deadline”。`codex-rs/config/src/config_toml.rs:781-783`、`core/src/config/config_tests.rs:9924-9942`；当前 core handlers 注册无 csv/job 工具。自建 Promise.all 批次的 cancel 必须由 AxumAgent 定义，Codex 该原生 surface 不提供统一 batch cancellation contract。

## 5. completion 后继续与通知

- Completed 是 turn 状态，不是线程死亡；下一 send_input/followup 可再次 Running。V2 terminal result 发给 immediate parent 是 QueueOnly/trigger_turn=false，不自动启动 idle parent；activity 可发给发起这次 followup 的 initiator。报告 best-effort，非去重/持久 exactly-once 保证。`agent/status.rs:8-24`、`agent/control/completion.rs:39-79,105-160`、`agent/api.rs:147-153`。
- V1 watcher 仅处理首次 final；V2 路由采用每个 terminal turn 的 result 路径。不能把 watcher 视作所有后续 turn 的唯一完成机制。`agent/control.rs:440-505`、`agent/control/completion.rs`。
- 注意 **Interrupted 不是 is_final**：is_final 排除 PendingInit/Running/Interrupted。所以 interrupt 后 V1 wait 不保证立刻返回 final（可能超时）。`agent/status.rs:26-31`。

## 6. wait timeout 不是 task deadline

- V1 wait_agent(targets, timeout_ms)：默认30,000ms，正数下限10,000ms、上限3,600,000ms，超范围正数 clamp；<=0 报错。多个 target 等任意 final，已 final 的立即返回；返回已观察 final map 与 timed_out，timeout 无 final 时空 map；不会 cancel 子任务。`multi_agents_common.rs:21-25`、`config/mod.rs:262-269`、`multi_agents/wait.rs:101-113,135-226`。
- V2 wait_agent 只有 timeout_ms、**没有 target 列表，也不返回最终内容**，等当前 session mailbox activity（包括 messages/final notification）或 steered user input；有 pending activity 立即返回。默认30,000ms/min10,000/max3,600,000，三者可配置；低于min（含非正数）clamp 并文本告知，高于max报错（不是V1 clamp）。返回 message/timed_out。`multi_agents_v2/wait.rs:52-69,137-177,218-247`。
- 两者只限制本次 wait 的观测时长，源码 deadline 是本地 timeout_at，没有传给 spawn 或 child runtime；取消 wait 不等于取消 task。当前 spawn 参数及 SpawnRequest 没有 task deadline；旧 job runtime 配置已 no-op。若 AxumAgent 需要 wall-clock task deadline，必须单独设计并显式暴露，不能把 wait timeout 重用成 deadline。

## 实现对照要点

应分开建模 AgentIdentity/loaded residency/active turn/accepted delivery/terminal turn/explicit Closed；区分 queue-only、trigger-turn、interrupt、tree-shutdown；父 cancel 的 provisional 与 accepted 边界要保留。不要把 V2 unlimited identity + bounded running/resident 错写成 V1 open-thread cap，也不要把 V2 max_depth、旧 CSV deadline 或 wait(ids) 从历史版本搬进当前契约。

## AxumAgent 本次适配边界

plugin/pi-agent 使用同宿主 Pi SDK 内存 session，不复制 Codex 持久化/residency 系统。本次新增 manage_agent 和批次账本，wait 超时不取消，send 是 trigger-turn/stream steer；interrupt 只终止单路当前 turn，close 明确释放本地 child。六个 pending/running 名额属于 Axum 自定义执行上限，不声称等同 V1 注册线程名额或 V2 residency。回传仍按 squash=true 主动唤醒（保留 Axum 兼容行为，不冒称 V2 queue-only）。普通 ExtensionContext 无审批策略导出；bundled SDK 0.99.2 的工具上下文 executeTool 已用于父真实工具链桥接，writeScope 和显式 testCommands 受父实时工具/审批检查，旧 SDK 与无桥命令仍 fail closed 到 read/search。shell 非路径沙箱，custom 与递归禁用；与 Codex 权限 profile/隔离及 V2 可无限层身份不等价。硬 deadline 为 Axum 显式扩展，绝不是 Codex wait timeout。内存 continuation 只在同进程保留期内可用；进程重启后不提供冷恢复。
