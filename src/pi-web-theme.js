// 追加到上游全局 CSS；沿用 html.dark 与现有主题持久化。
export const PI_WEB_THEME_CSS = String.raw`
/* Axum chat theme */
:root {
  color-scheme: light;
  --bg: oklch(1 0 0);
  --bg-panel: oklch(.985 0 0);
  --bg-hover: oklch(.965 0 0);
  --bg-selected: oklch(.94 0 0);
  --border: oklch(.92 0 0);
  --text: oklch(.205 0 0);
  --text-muted: oklch(.45 0 0);
  --text-dim: oklch(.52 0 0);
  --accent: oklch(.205 0 0);
  --accent-hover: oklch(.32 0 0);
  --user-bg: oklch(.96 0 0);
  --assistant-bg: var(--bg);
  --tool-bg: var(--bg-panel);
  --bg-subtle: rgb(0 0 0 / 3%);
  --axum-on-accent: oklch(.985 0 0);
  --sidebar-width: 240px;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
}
html.dark {
  color-scheme: dark;
  --bg: oklch(.192 0 0);
  --bg-panel: oklch(.15 0 0);
  --bg-hover: oklch(.25 0 0);
  --bg-selected: oklch(.29 0 0);
  --border: rgb(255 255 255 / 9%);
  --text: oklch(.947 0 0);
  --text-muted: oklch(.72 0 0);
  --text-dim: oklch(.65 0 0);
  --accent: oklch(.947 0 0);
  --accent-hover: oklch(.82 0 0);
  --user-bg: oklch(.27 0 0);
  --assistant-bg: var(--bg);
  --tool-bg: var(--bg-panel);
  --bg-subtle: rgb(255 255 255 / 4%);
  --axum-on-accent: oklch(.15 0 0);
}
html, body { font-family: var(--font-sans); font-size: 14px; }
.sidebar-container { background: var(--bg-panel); }
button, [role="button"] {
  touch-action: manipulation;
  transition: background-color 150ms ease-out, color 150ms ease-out, border-color 150ms ease-out;
}
.config-button, .config-sidebar-item, .settings-theme-option, .settings-language-option {
  border-radius: 8px;
}
.config-button-primary:not(.is-success),
button:is([style*="background:var(--accent)"], [style*="background: var(--accent)"],
  [style*="background-color:var(--accent)"], [style*="background-color: var(--accent)"]) {
  color: var(--axum-on-accent) !important;
  background: var(--accent) !important;
  border-color: var(--accent) !important;
  box-shadow: none !important;
}
/* 空项目入口在上游使用固定蓝色。 */
.sidebar-container button:is([style*="background:rgba(37,99,235,0.06)"],
  [style*="background: rgba(37, 99, 235, 0.06)"]) {
  background: var(--bg-selected) !important;
  border-color: var(--border) !important;
}
:where(input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]), select, textarea) {
  border-radius: 8px !important;
  font-family: var(--font-sans);
}
:where(button, [role="button"], input, select, textarea):focus-visible {
  outline: 2px solid var(--accent) !important;
  outline-offset: 2px;
}
textarea[style*="border: none"]:focus-visible { outline: none !important; }
:where(button, [role="button"]):active:not(:disabled) { filter: brightness(.94); }
:where(button, [role="button"]):disabled { cursor: not-allowed; }
:where(button, [role="button"])[aria-busy="true"] { cursor: progress; }
.markdown-body:not(.markdown-custom-message):not(.markdown-compaction-message) {
  font-size: 16px;
  line-height: 28px;
}
/* 上游用户气泡使用行内样式；兼容 SSR 与浏览器序列化的空格。 */
div:is([style*="background:var(--user-bg)"], [style*="background: var(--user-bg)"]) {
  background: var(--user-bg) !important;
  border-color: transparent !important;
  border-radius: 16px !important;
  font-size: 16px !important;
  line-height: 28px !important;
}
.markdown-body:not(.markdown-user-message):not(.markdown-custom-message):not(.markdown-compaction-message) {
  background: transparent;
  box-shadow: none;
}
.markdown-code-block { border-radius: 8px; box-shadow: none; }
/* 仅中和成功工具卡片；保留红色错误与差异内容。 */
div:is([style*="border-radius:7px"], [style*="border-radius: 7px"]):is(
  [style*="background:rgba(34,197,94,0.04)"], [style*="background: rgba(34, 197, 94, 0.04)"]) {
  background: transparent !important;
  border-color: var(--border) !important;
  border-radius: 8px !important;
}
div[style*="border"][style*="var(--border)"]:is(:has(> textarea), :has(> div > textarea)) {
  border-radius: 16px !important;
  box-shadow: none !important;
}
@media (hover: hover) and (pointer: fine) {
  .config-button-primary:not(.is-success):not(:disabled):hover,
  button:is([style*="background:var(--accent)"], [style*="background: var(--accent)"]):not(:disabled):hover {
    background: var(--accent-hover) !important;
    border-color: var(--accent-hover) !important;
  }
}
@media (pointer: coarse) {
  :where(button, [role="button"], select, input:not([type="checkbox"]):not([type="radio"]):not([type="range"])) {
    min-width: 44px !important;
    min-height: 44px !important;
  }
  input, select, textarea { font-size: 16px !important; }
  /* 触屏展示消息行内依赖鼠标悬停的操作。 */
  div:has(> div > div[style*="var(--user-bg)"]) > div > div[style*="pointer-events:"],
  button[style*="pointer-events:"]:is([style*="height:22px"], [style*="height: 22px"]) {
    opacity: 1 !important;
    pointer-events: auto !important;
  }
  .config-button-primary:not(.is-success):not(:disabled):hover { background: var(--accent); border-color: var(--accent); }
  .config-button-secondary:not(:disabled):hover { background: transparent; }
}
body {
  padding-top: env(safe-area-inset-top);
  padding-bottom: env(safe-area-inset-bottom);
  padding-left: env(safe-area-inset-left);
  padding-right: env(safe-area-inset-right);
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
}
`;
