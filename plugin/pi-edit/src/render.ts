import { Box, Spacer, Text } from "@earendil-works/pi-tui";

// Minimal render helpers aligned with upstream pi-coding-agent's render-utils and
// the built-in read/edit tool renderers. pi-coding-agent does not export its
// render-utils from the public surface, so the pieces we need live here.

export interface ToolTheme {
  fg: (color: string, text: string) => string;
  bg: (color: string, text: string) => string;
  bold: (text: string) => string;
}

/** Coerce a possibly-aliased / unknown tool argument into a string path. */
export function readArgPath(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const rec = args as Record<string, unknown>;
  const raw = typeof rec.file_path === "string" ? rec.file_path : rec.path;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/** Render a path relative to cwd when shorter, else absolute. */
export function formatPath(rawPath: string, cwd: string): string {
  if (rawPath === ".") return ".";
  // Normalize for display only; do not touch the filesystem.
  const norm = rawPath.replace(/\\/g, "/");
  const cwdNorm = cwd.replace(/\\/g, "/").replace(/\/$/, "");
  if (cwdNorm && norm.startsWith(cwdNorm + "/")) {
    const rel = norm.slice(cwdNorm.length + 1);
    return rel.length <= norm.length ? rel : norm;
  }
  return norm;
}

/**
 * Build the one-line call header shared by read/replace:
 *   <bold toolTitle name> <accent path> [suffix]
 * Mirrors upstream formatReadCall/formatEditCall without depending on internals.
 */
export function buildCallHeader(
  name: string,
  theme: ToolTheme,
  rawPath: string | null,
  cwd: string,
  suffix = "",
): string {
  const title = theme.fg("toolTitle", theme.bold(name));
  const path = theme.fg(
    "accent",
    rawPath == null ? "<no path>" : formatPath(rawPath, cwd),
  );
  return `${title} ${path}${suffix}`;
}

/**
 * A self-rendered shell box (mirrors upstream `renderShell: "self"` + Box usage).
 *
 * Upstream edit uses Box(1, 1, identity) — the bgFn is set per-state by the
 * caller via setBgFn (toolPendingBg / toolSuccessBg / toolErrorBg). We default
 * to the identity function so the caller's already-styled header text is not
 * restyled by the box. Matches upstream Box(1, 1) for left padding alignment
 * with renderResult lines. Header is the call/result one-liner; optional body
 * lines are appended below with a spacer, each already styled by the caller.
 */
export function buildShellBox(_theme: ToolTheme, header: string, bodyLines: string[] = []): Box {
  const box = new Box(1, 1, (text: string) => text);
  box.addChild(new Text(header, 0, 0));
  if (bodyLines.length > 0) {
    box.addChild(new Spacer(1));
    box.addChild(new Text(bodyLines.join("\n"), 0, 0));
  }
  return box;
}

/**
 * 折叠态预览抽取器：从已渲染的正文里取前 maxLines 行，并标注剩余行数。
 * 上游 bash/grep/find/ls 在折叠态同样展示前若干行真实输出，而非空摘要；
 * 这里对齐该惯例，保证用户折叠状态下也能一眼看到“具体操作了啥”。
 *
 * 输入 raw 必须是展开态会原样渲染的同一份正文（含已有 ANSI 着色），
 * 本函数只做行级截断，不再二次着色，避免重复/冲突。
 * 返回可直接塞进 Text 的多行字符串，或 null 表示无可预览内容。
 */
export function collapsePreview(raw: string, maxLines: number, theme: ToolTheme): string | null {
  const allLines = raw.split("\n");
  // 去掉首尾空白行，跟渲染输出观感一致。
  let start = 0;
  let end = allLines.length;
  while (start < end && allLines[start]!.trim().length === 0) start++;
  while (end > start && allLines[end - 1]!.trim().length === 0) end--;
  const body = allLines.slice(start, end);
  if (body.length === 0) return null;
  if (body.length <= maxLines) return body.join("\n");
  const shown = body.slice(0, maxLines).join("\n");
  const remaining = body.length - maxLines;
  return `${shown}\n${theme.fg("muted", `... (${remaining} more lines, expand to view)`)}`;
}
