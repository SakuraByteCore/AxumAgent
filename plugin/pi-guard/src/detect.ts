// Assistant output degradation (loop / "发癫") detector.
//
// Scans finalized assistant text for the output-degeneration fingerprints Pi
// itself guards against in its own self-check rules:
//   - a 2-4 char substring repeating >=3 times within an adjacent 20-char
//     window (e.g. 「御坂御坂御坂御坂…」 self-reference stacking)
//   - a single char repeating >=5 times within an adjacent 10-char window
//     (character avalanche)
// The scan is pure and dependency-free so it can be unit-tested on its own.

/** Sliding substring window size for the multi-char repeat scan. */
const SUBSTR_WINDOW = 20;
/** Min substring length probed for adjacent repeats. */
const SUBSTR_MIN = 2;
/** Max substring length probed for adjacent repeats. */
const SUBSTR_MAX = 4;
/** Adjacent occurrence count at which a multi-char substring is degenerate. */
const SUBSTR_REPEAT = 3;

/** Sliding single-char window size for the avalanche scan. */
const CHAR_WINDOW = 10;
/** Adjacent occurrence count at which a single char is degenerate. */
const CHAR_REPEAT = 5;

export interface DegradationHit {
  /** The degenerate pattern that triggered detection. */
  pattern: string;
  /** Window kind: "substr" or "char". */
  kind: "substr" | "char";
  /** 0-based index of the window start in the scanned text. */
  start: number;
  /** Adjacent occurrence count of the pattern in the window. */
  count: number;
}

/**
 * Scan text for output-degeneration patterns. Returns the first hit, or
 * undefined when the text reads normally. Multi-char substring repeats are
 * checked first because they carry more signal than single-char avalanches.
 */
export function detectDegradation(text: string): DegradationHit | undefined {
  if (!text) return undefined;
  const chars = [...text];

  const charLen = chars.length;
  const scanLimit = Math.max(0, charLen - SUBSTR_WINDOW + 1);

  // Multi-char substring scan: sliding window over the full text. The
  // window is clamped to the text length so short texts (charLen < 20) are
  // still scanned rather than skipped by an out-of-range scanLimit.
  for (let w = 0; w < charLen; w++) {
    const windowLen = Math.min(SUBSTR_WINDOW, charLen - w);
    const window = chars.slice(w, w + windowLen).join("");
    const windowLimit = windowLen;
    for (let len = SUBSTR_MIN; len <= SUBSTR_MAX; len++) {
      const probeLimit = windowLimit - len;
      for (let i = 0; i + len <= windowLimit; i++) {
        const probe = window.slice(i, i + len);
        // Skip whitespace-only probes: a run of spaces is not degeneration.
        if (probe.trim() === "") continue;
        let count = 1;
        let cursor = i + len;
        while (cursor + len <= windowLimit && window.slice(cursor, cursor + len) === probe) {
          count += 1;
          cursor += len;
        }
        if (count >= SUBSTR_REPEAT) {
          return { pattern: probe, kind: "substr", start: w + i, count };
        }
        // Continue probing other substring start positions (i) so a later
        // shorter probe is not blocked by an earlier non-matching longer one.
        void probeLimit;
      }
    }
  }

  // Single-char avalanche scan: count adjacent identical chars in a 10-char window.
  for (let w = 0; w + 1 <= charLen; w++) {
    const end = Math.min(charLen, w + CHAR_WINDOW);
    let maxRun = 1;
    let runChar = chars[w]!;
    let run = 1;
    for (let i = w + 1; i < end; i++) {
      if (chars[i] === chars[i - 1]) {
        run += 1;
        if (run > maxRun) {
          maxRun = run;
          runChar = chars[i]!;
        }
      } else {
        run = 1;
      }
    }
    if (maxRun >= CHAR_REPEAT && runChar !== " ") {
      return { pattern: runChar, kind: "char", start: w, count: maxRun };
    }
  }

  return undefined;
}

/**
 * Extract the concatenated text content from an agent message, ignoring
 * thinking blocks and tool calls. Returns the empty string for non-textual
 * messages so callers can short-circuit.
 */
export function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const msg = message as { role?: string; content?: unknown };
  if (msg.role !== "assistant") return "";
  const content = msg.content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: string };
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("");
}
