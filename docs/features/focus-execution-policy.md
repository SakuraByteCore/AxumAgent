# 反表演执行策略块（focus-execution-policy）技术变更说明

### 问题
执行类任务中模型把大量轮次与 token 花在"表演执行过程"（开场白、预告动作、复述指令/工具输出、仪式性总结），决策与可检查结果的占比过低。

### 原因
- 事实观测：仓库已有托管策略块通道——`src/default-system-prompt.js` 定义带 HTML 注释标记的策略文本，`bin/axum.js` 启动时经 `ensure*Policy` 幂等 upsert 到 `~/.pi/agent/APPEND_SYSTEM.md`（并行批处理策略为无条件挂载先例）。
- 推论：反表演约束属于全会话行为基线（与 parallel 策略同级），复用既有通道即可，无需新机制。

### 修改点
1. `src/default-system-prompt.js`
   - 新增 `FOCUS_POLICY_BEGIN/END`（`<!-- axum:focus-execution-policy v1 -->`）与 `FOCUS_EXECUTION_POLICY` 文本：Never 段硬禁开场寒暄/动作预告/复述参数与输出/仪式性总结/中途请求许可；Always 段白名单放行结论先行、工具结果即执行记录、失败即报、直接提问完整作答；Progress 段有 todo 工具时进度只走面板，无 todo 工具时允许单行进度。
   - 新增 `ensureFocusExecutionPolicy`（复用 `ensureManagedPolicyBlock`，幂等 + mode 600）。
2. `bin/axum.js`：`runPi` 中在 parallel 策略之后无条件调用 `ensureFocusExecutionPolicy(bundledPiOptions)`（全会话生效，含 safe）。
3. `test/default-system-prompt.test.js`：新增两用例（创建/幂等/600 权限、升级仅替换自身块且保留用户内容）；共存用例扩展断言 focus 块独立 upsert。

### 预期结果
- 启动 axum 任意会话时 APPEND_SYSTEM.md 幂等注入 focus 块，用户自留段落不受影响；重复启动零写入。
- 验证：`node --test test/default-system-prompt.test.js` 12/12；`npm test` 全量 504/504 通过（事实观测）；`node --check bin/axum.js src/default-system-prompt.js` 通过。
- 实施坑位记录：策略文本内反引号须转义（`` \`todo\` ``），否则截断模板字面量（已在首轮测试暴露并修正）。
