// Terminal cell-width helpers keyed on grapheme clusters. East-Asian wide /
// fullwidth code points and the emoji planes occupy two columns per cluster;
// combining marks, variation selectors, and U+200D joiners contribute nothing;
// ANSI SGR runs are passed through as zero-width tokens so truncation and tail
// slicing never split an escape sequence or a surrogate pair.
const graphemeSegmenter = typeof Intl.Segmenter === "function"
	? new Intl.Segmenter("en", { granularity: "grapheme" })
	: undefined;

const ESC = "\x1b";

function codePointWidth(cp: number): number {
	if (cp === 0x200d || cp === 0xfe0e || cp === 0xfe0f) return 0;
	if (cp >= 0x0300 && cp <= 0x036f) return 0;
	if (cp >= 0x1ab0 && cp <= 0x1aff) return 0;
	if (cp >= 0x1dc0 && cp <= 0x1dff) return 0;
	if (cp >= 0x20d0 && cp <= 0x20ff) return 0;
	if (cp >= 0xfe20 && cp <= 0xfe2f) return 0;
	if (cp < 0x20) return 0;
	if (
		(cp >= 0x1100 && cp <= 0x115f) ||
		(cp >= 0x2e80 && cp <= 0x303e) ||
		(cp >= 0x3041 && cp <= 0x33ff) ||
		(cp >= 0x3400 && cp <= 0x4dbf) ||
		(cp >= 0x4e00 && cp <= 0x9fff) ||
		(cp >= 0xa000 && cp <= 0xa4cf) ||
		(cp >= 0xa960 && cp <= 0xa97f) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe10 && cp <= 0xfe1f) ||
		(cp >= 0xfe30 && cp <= 0xfe6f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x16fe0 && cp <= 0x16fe4) ||
		(cp >= 0x17000 && cp <= 0x187f7) ||
		(cp >= 0x18800 && cp <= 0x18cd5) ||
		(cp >= 0x1aff0 && cp <= 0x1aff3) ||
		(cp >= 0x1b150 && cp <= 0x1b167) ||
		(cp >= 0x1b170 && cp <= 0x1b2fb) ||
		(cp >= 0x1f300 && cp <= 0x1faff) ||
		(cp >= 0x20000 && cp <= 0x2fffd) ||
		(cp >= 0x30000 && cp <= 0x3fffd)
	) {
		return 2;
	}
	return 1;
}

function clusterWidth(cluster: string): number {
	let width = 0;
	for (const ch of cluster) {
		const w = codePointWidth(ch.codePointAt(0)!);
		if (w === 2) return 2;
		if (w === 1) width = 1;
	}
	return width;
}

export interface DisplayToken {
	text: string;
	width: number;
}

export function* displayTokens(text: string): Generator<DisplayToken, void, void> {
	let i = 0;
	while (i < text.length) {
		const esc = text.indexOf(ESC + "[", i);
		const end = esc === -1 ? text.length : esc;
		const plain = text.slice(i, end);
		if (plain.length > 0) {
			if (graphemeSegmenter) {
				for (const { segment } of graphemeSegmenter.segment(plain)) {
					yield { text: segment, width: clusterWidth(segment) };
				}
			} else {
				for (const ch of plain) {
					yield { text: ch, width: clusterWidth(ch) };
				}
			}
		}
		if (esc === -1) return;
		const m = text.indexOf("m", esc + 2);
		const runEnd = m === -1 ? text.length : m + 1;
		yield { text: text.slice(esc, runEnd), width: 0 };
		i = runEnd;
	}
}

export function displayWidth(text: string): number {
	let width = 0;
	for (const token of displayTokens(text)) width += token.width;
	return width;
}

export function truncateDisplayToWidth(text: string, width: number, ellipsis = ""): string {
	if (width <= 0) return "";
	if (displayWidth(text) <= width) return text;
	const budget = Math.max(0, width - displayWidth(ellipsis));
	let used = 0;
	let out = "";
	for (const token of displayTokens(text)) {
		if (token.width === 0) {
			out += token.text;
			continue;
		}
		if (used + token.width > budget) break;
		out += token.text;
		used += token.width;
	}
	return out + ellipsis;
}

export function takeDisplayTail(text: string, budget: number): string {
	if (budget <= 0) return "";
	if (displayWidth(text) <= budget) return text;
	const tokens = [...displayTokens(text)];
	let used = 0;
	let start = tokens.length;
	for (let i = tokens.length - 1; i >= 0; i--) {
		if (used + tokens[i]!.width > budget) break;
		used += tokens[i]!.width;
		start = i;
	}
	return tokens.slice(start).map((token) => token.text).join("");
}
