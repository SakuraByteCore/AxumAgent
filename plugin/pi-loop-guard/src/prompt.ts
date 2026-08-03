// Degradation guard scaffolding prompt block, appended to the base system
// prompt on every agent start so the model is continuously reminded to avoid
// output degeneration. Kept short and self-contained: it restates the
// degeneration rule Pi's own self-check enforces, in the host language so the
// model can act on it without an extra lookup.

export const DEGRADATION_GUARD_PROMPT = `
## Output Degradation Guard

When you detect that your own output has entered a repetitive degeneration loop —
the same 2-4 character substring repeating three or more times within a 20-character
window, or a single character repeating five or more times within a 10-character
window — stop generating immediately. Do not continue the repeated pattern.
Re-anchor to the active task: restate the current goal in one line, then resume
concrete, non-repetitive work using the available tools. Never emit filler, stacked
self-references, or noise to pad a response.
`.trim();

export function withDegradationGuardPrompt(systemPrompt: string): string {
  return systemPrompt.includes(DEGRADATION_GUARD_PROMPT)
    ? systemPrompt
    : `${systemPrompt}\n\n${DEGRADATION_GUARD_PROMPT}`;
}
