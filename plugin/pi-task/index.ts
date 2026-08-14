import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CONCURRENCY_TEMPLATE = `タスク実行上の必須要件
- このタスクの中で並列処理できる部分は、すべて子タスクに分割し、サブエージェントへ並行して委譲しなければならない。
- 各子タスクの境界（担当領域・入出力・完了条件）は明確にし、出力形式を定めること。
- ファイルの書き込みを伴うタスクは、変更対象ファイルを明記し、複数のエージェントが同じファイルを同時に書き換えないようにすること。
- 並列処理に使えるサブエージェントがあれば、Agent ツール（および必要に応じて get_subagent_result / steer_subagent）を積極的に使用し、全子タスクを並行実行すること。
- 並列できない部分（単一の前提・順序依存ステップ）は無理に分割せず、正しい順序で順次実行すること。
- 全子タスクの完了後、最終結果を統合し、一貫性・漏れ・競合を検証してから成果物としてまとめること。`;

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("task", {
    description: "Decompose a requirement into parallel sub-agents and integrate the results: /task <requirement>",
    getArgumentCompletions: () => null,
    async handler(args: string, ctx) {
      const requirement = args.trim();
      if (!requirement) {
        ctx.ui.notify("Please provide a requirement: /task <requirement>", "warning");
        return;
      }
      try {
        const { getSubagentsService } = await import("@gotgenes/pi-subagents");
        const service = getSubagentsService();
        if (!service) {
          ctx.ui.notify("Sub-agent service is not available yet; the task will still run via the Agent tool if it is active.", "warning");
        }
      } catch {
        ctx.ui.notify("Sub-agent service is not loaded; parallel delegation may be unavailable.", "warning");
      }
      const prompt = [
        `[タスク] ${requirement}`,
        "",
        `[実行規則] ${CONCURRENCY_TEMPLATE}`,
        "",
        "要件を満たす成果物を出力せよ。",
      ].join("\n");
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    },
  });
}