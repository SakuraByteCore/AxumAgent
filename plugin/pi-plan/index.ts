import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PLAN_FIRST_TEMPLATE = `Research the requirement quickly and re-confirm the plan. Let's discuss the approach first — do not generate any code until I ask you to.`;

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("plan", {
    description: "Plan first: research the requirement, re-confirm the approach, and discuss before writing code: /plan <requirement>",
    getArgumentCompletions: () => null,
    async handler(args: string, ctx) {
      const requirement = args.trim();
      if (!requirement) {
        ctx.ui.notify("Please provide a requirement: /plan <requirement>", "warning");
        return;
      }
      const prompt = [
        `[Requirement] ${requirement}`,
        "",
        `[Instructions] ${PLAN_FIRST_TEMPLATE}`,
      ].join("\n");
      pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    },
  });
}
