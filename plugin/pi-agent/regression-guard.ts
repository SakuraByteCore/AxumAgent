// Mirrors plugin/pi-companion/regression-guard.ts because pi-agent is packaged independently.
export const REGRESSION_GUARD_CLAUSE = "【禁止回归】若本次任务涉及代码修改：不得破坏已有功能；必须执行受影响范围既有测试；禁止删除或弱化原有断言；失败先修复再交付；并给出风险点、验证方法与恢复方案。";

export function appendRegressionGuard(text: string): string {
	if (text.includes(REGRESSION_GUARD_CLAUSE)) return text;
	return `${text}\n\n${REGRESSION_GUARD_CLAUSE}`;
}
