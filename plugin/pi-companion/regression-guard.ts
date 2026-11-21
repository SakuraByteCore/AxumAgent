export const REGRESSION_GUARD_CLAUSE = "【禁止回归】若本次任务涉及代码修改：不得破坏已有功能；必须执行受影响范围既有测试；禁止删除或弱化原有断言；失败先修复再交付；并给出风险点、验证方法与恢复方案。";
export const DISPATCH_AGENT_GUARD_CLAUSE = "【禁止委派】禁止调用 dispatch_agent 的 backend=\"controlled-pi\"；省略 backend 也视为 controlled-pi，禁止调用。任务由主线程直接完成，不得改用其他工具、别名或外部进程绕过。";

export function appendRegressionGuard(text: string): string {
	for (const clause of [REGRESSION_GUARD_CLAUSE, DISPATCH_AGENT_GUARD_CLAUSE]) {
		if (!text.includes(clause)) text += `\n\n${clause}`;
	}
	return text;
}
