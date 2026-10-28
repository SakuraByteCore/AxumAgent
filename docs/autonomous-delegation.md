# 默认自主委派：策略与宿主契约

普通请求不需要 `/dispatch` 或指定拆分。pi-agent 在 `before_agent_start` 读取当前 dispatch_agent 可用性，向主模型注入默认交付策略：独立工作积极并行，小任务直接执行；明确文件所有权和依赖接口，父代理同时推进关键路径、及时整合已完成结果，统一验证。

这不是确定性的宿主任务规划器。是否拆分、如何选任务仍依赖模型遵循系统策略；宿主负责实际工具路径、权限检查、互斥、名额和生命周期，不能将提示词测试描述为模型效果保证。

`/quick` 默认仅减少过程说明，不隐式设置五分钟 deadline，不关闭并行。显式 duration 仍保留执行预算。wait 的观察超时不会取消 child；真实执行 deadline、失败、关闭和 shutdown 语义保留。

## 唯一模型派发入口

创建子代理只暴露 `dispatch_agent`。`manage_agent` 保留等待、状态、取消、关闭和同一 child 续跑，不创建替代派发通道。显式用户 slash 快捷命令保留，默认普通目标仍自动按需拆分，并不要求用户手动拆分。旧 `pi-subagents` 包及其 supervisor、worker/别名入口从注册和加载路径禁用；旧配置按加载视图兼容过滤，不覆盖用户自定义文件。此契约不是防恶意插件执行任意代码的 OS sandbox。

## SDK 能力证据

发布的 bundled Pi 为 0.99.2。`ExtensionToolContext.executeTool()` 会进入父 session 的 validation、tool_call/tool_result hooks 和权限检查；不是复制父审批配置，也不是调用裸 builtin executor。pi-companion 的 watcher 本身仅 advisory，并不充当审批器；若父安装真正审批 handler，桥接调用同样必须经过该 handler。

旧版 SDK 或 slash command context 没有该执行桥，不能凭父工具名称或信任标记给 child 开写权限。能力不支持时必须明确失败，不能静默声称实现了可写委派。工具桥也不是 OS sandbox；读取工具本身不限制到项目目录。

## 对照 Codex

Codex 源码对照固定于 `26ad281fd1ca712e4f0c7920a6273cf18c961b8a`，详见 subagent-contract.md。Axum 复用既有 pi-agent，不模拟 Codex 的 cold residency、权限 profile 或无限深度身份树。worker 不得继续递归派发。
