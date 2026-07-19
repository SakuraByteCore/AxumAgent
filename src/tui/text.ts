export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

export function charDisplayWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0 || code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0;
  if (
    (code >= 0x0300 && code <= 0x036f)
    || (code >= 0x1ab0 && code <= 0x1aff)
    || (code >= 0x1dc0 && code <= 0x1dff)
    || (code >= 0x20d0 && code <= 0x20ff)
    || (code >= 0xfe00 && code <= 0xfe0f)
  ) return 0;
  if (
    (code >= 0x1100 && code <= 0x115f)
    || code === 0x2329
    || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe19)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
  ) return 2;
  return 1;
}

export function visibleWidth(text: string): number {
  return Array.from(stripAnsi(text)).reduce((total, char) => total + charDisplayWidth(char), 0);
}

export function truncateToVisibleWidth(text: string, width: number): string {
  if (width <= 0) return "";
  let used = 0;
  let result = "";
  for (const char of Array.from(stripAnsi(text))) {
    const charWidth = charDisplayWidth(char);
    if (used + charWidth > width) break;
    result += char;
    used += charWidth;
  }
  return result;
}

export function clip(text: string, width: number): string {
  const textWidth = visibleWidth(text);
  if (textWidth <= width) return text + " ".repeat(width - textWidth);
  return `${truncateToVisibleWidth(text, Math.max(0, width - 1))}…`;
}

export function wrap(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const words = text.split(/\s+/g).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (!line) {
      line = word;
    } else if (visibleWidth(`${line} ${word}`) <= safeWidth) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function wrapPreservingShortLine(text: string, width: number): string[] {
  return visibleWidth(text) <= width ? [text] : wrap(text, width);
}
