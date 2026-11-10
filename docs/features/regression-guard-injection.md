# 统一禁止回归条款注入

## 变更说明
- 主会话、`/plan`、`/build`、`/agent -P`、`dispatch_agent` 与普通子代理任务统一追加禁止回归条款。
- 用户自定义 `~/.pi/agent/plan-prompt.md` 仍然有效，条款追加在模板结果之后。
- 代码修改类方案禁止写“无”，必须给出风险点、验证方法与恢复方案。

## 问题
- 不同入口的提示词各自演化，回归约束容易遗漏。
- 计划模板可能允许“无”跳过回归防御描述。

## 原因
- 主提示词、计划提示词与子代理任务由不同模块构建，缺少统一注入点。

## 修改点
- 新增 `plugin/pi-companion/regression-guard.ts` 与 `plugin/pi-agent/regression-guard.ts`，两份条款字节一致。
- `pi-companion` 在 `before_agent_start` 追加主会话条款；`/plan`、`/build` 模板与内置回退均追加条款。
- `pi-agent` 的自治策略、计划提示词、普通任务与 `dispatch_agent` 参数均追加同一条款。
- 计划契约中代码修改类方案禁止写“无”。
- `pi-companion/package.json` 将新模块纳入发布文件。

## 预期结果
- 任意代码修改入口都携带：不得破坏已有功能、执行受影响既有测试、禁止删除或弱化断言、失败先修复、并给出风险点/验证方法/恢复方案。
- 定向测试、`npm run build` 与 `git diff --check` 通过。
