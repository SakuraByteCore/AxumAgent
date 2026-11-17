// Shared visual tokens for the session model workspace.
export const agentUiStyle = `
:root {
  color-scheme: light dark;
  --background: oklch(1 0 0);
  --foreground: oklch(.205 0 0);
  --sidebar: oklch(.985 0 0);
  --border: oklch(.92 0 0);
  --muted: oklch(.45 0 0);
  --primary: oklch(.205 0 0);
  --primary-text: oklch(.985 0 0);
  --error: oklch(.45 .16 25);
  --success: oklch(.4 .1 150);
  --radius: .625rem;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  background: var(--background);
  color: var(--foreground);
}
@media (prefers-color-scheme: dark) {
  :root {
    --background: oklch(.192 0 0);
    --foreground: oklch(.947 0 0);
    --sidebar: oklch(.15 0 0);
    --border: rgb(255 255 255 / 9%);
    --muted: oklch(.72 0 0);
    --primary: oklch(.947 0 0);
    --primary-text: oklch(.192 0 0);
    --error: oklch(.78 .12 25);
    --success: oklch(.78 .1 150);
  }
}
* { box-sizing: border-box; }
body { margin: 0; min-width: 0; }
.workspace-header {
  background: var(--sidebar);
  border-bottom: 1px solid var(--border);
  padding: calc(16px + env(safe-area-inset-top)) max(24px, env(safe-area-inset-right)) 16px max(24px, env(safe-area-inset-left));
}
.brand { font-size: 16px; font-weight: 650; letter-spacing: -.02em; }
.brand span { color: var(--muted); font-size: 13px; font-weight: 400; margin-left: 12px; }
main {
  max-width: 640px;
  margin: 0 auto;
  padding: 48px max(24px, env(safe-area-inset-right)) calc(32px + env(safe-area-inset-bottom)) max(24px, env(safe-area-inset-left));
}
h1 { margin: 0 0 8px; font-size: 22px; line-height: 1.4; letter-spacing: -.025em; font-weight: 600; }
p { margin: 0; }
.description, .hint, .session { font-size: 13px; color: var(--muted); }
.session { margin-top: 16px; overflow-wrap: anywhere; }
.session strong { color: var(--foreground); font-weight: 500; }
form { margin-top: 32px; }
.field + .field { margin-top: 24px; }
label { display: block; margin-bottom: 8px; font-weight: 500; }
select, button { font: inherit; border-radius: 8px; min-height: 44px; }
select {
  display: block;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border);
  background: var(--background);
  color: var(--foreground);
  text-overflow: ellipsis;
}
.hint { margin-top: 8px; overflow-wrap: anywhere; }
.actions { margin-top: 32px; padding-top: 24px; border-top: 1px solid var(--border); }
button {
  padding: 8px 20px;
  border: 1px solid transparent;
  background: var(--primary);
  color: var(--primary-text);
  font-weight: 500;
  cursor: pointer;
  transition: opacity 150ms ease-out;
}
button:active:not(:disabled) { opacity: .75; }
button:disabled { opacity: .5; cursor: wait; }
select:disabled { opacity: .6; }
:focus-visible { outline: 2px solid var(--foreground); outline-offset: 4px; }
#status { margin-top: 12px; min-height: 40px; font-size: 13px; overflow-wrap: anywhere; }
#status[data-state="error"] { color: var(--error); }
#status[data-state="success"] { color: var(--success); }
@media (hover: hover) and (pointer: fine) {
  button:hover:not(:disabled) { opacity: .85; }
}
@media (max-width: 480px) {
  main { padding-top: 32px; }
  button { width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  button { transition: none; }
}
`;
