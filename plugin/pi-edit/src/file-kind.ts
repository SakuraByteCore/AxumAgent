import { open as fsOpen, stat as fsStat } from "fs/promises";
import { SNIFF_BYTES, MAX_BYTES } from "./constants.js";

const IMG_SIGNATURES: Array<{ magic: number[]; mime: string }> = [
  { magic: [0xff, 0xd8, 0xff], mime: "image/jpeg" },
  { magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], mime: "image/png" },
  { magic: [0x47, 0x49, 0x46, 0x38], mime: "image/gif" },
  { magic: [0x52, 0x49, 0x46, 0x46], mime: "image/webp" }, // RIFF, check WEBP later
];

function detectImageMime(buf: Buffer): string | null {
  for (const sig of IMG_SIGNATURES) {
    if (sig.mime === "image/webp") {
      // RIFF....WEBP
      if (buf.length >= 12 && buf.readUInt32BE(8) === 0x57454250) return "image/webp";
      continue;
    }
    if (buf.length >= sig.magic.length && sig.magic.every((b, i) => buf[i] === b)) {
      return sig.mime;
    }
  }
  return null;
}

function isProbablyBinary(buf: Buffer): boolean {
  // Null bytes in first SNIFF_BYTES => binary
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) return true;
  }
  // High ratio of non-text bytes => binary.
  // Distinguish valid UTF-8 multibyte sequences (CJK, emoji, etc.) from
  // stray continuation/lead bytes and other non-text bytes.
  let nonText = 0;
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    // ASCII text and common control bytes are text.
    if (b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e)) {
      i++;
      continue;
    }
    // Valid UTF-8 lead bytes: 2-byte (0xC0-0xDF), 3-byte (0xE0-0xEF),
    // 4-byte (0xF0-0xF7). Count only when the expected continuation bytes
    // (0x80-0xBF) are present; otherwise treat the lead byte as non-text.
    let seqlen = 0;
    if (b >= 0xc0 && b <= 0xdf) seqlen = 2;
    else if (b >= 0xe0 && b <= 0xef) seqlen = 3;
    else if (b >= 0xf0 && b <= 0xf7) seqlen = 4;
    if (seqlen > 0) {
      if (i + seqlen <= buf.length) {
        let valid = true;
        for (let j = 1; j < seqlen; j++) {
          const c = buf[i + j];
          if (c < 0x80 || c > 0xbf) { valid = false; break; }
        }
        if (valid) { i += seqlen; continue; }
      }
      nonText++;
      i++;
      continue;
    }
    // Stray continuation bytes (0x80-0xBF) without a lead, or other bytes.
    nonText++;
    i++;
  }
  return buf.length > 0 && nonText / buf.length > 0.3;
}

export type FKind =
  | { kind: "directory" }
  | { kind: "image"; mimeType: string }
  | { kind: "text" }
  | { kind: "binary"; description: string };

export type LFile =
  | { kind: "directory" }
  | { kind: "image"; mimeType: string }
  | { kind: "text"; text: string; hadUtf8DecodeErrors?: true }
  | { kind: "binary"; description: string };

export async function loadFileKindAndText(filePath: string): Promise<LFile> {
  const pathStat = await fsStat(filePath);
  if (pathStat.isDirectory()) return { kind: "directory" };
  if (!pathStat.isFile()) return { kind: "binary", description: "unsupported file type" };
  if (pathStat.size > MAX_BYTES) return { kind: "binary", description: `file exceeds ${MAX_BYTES} byte limit` };

  const fileHandle = await fsOpen(filePath, "r");
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await fileHandle.read(buffer, 0, SNIFF_BYTES, 0);
    if (bytesRead === 0) return { kind: "text", text: "" };

    const sample = buffer.subarray(0, bytesRead);
    const imgMime = detectImageMime(sample);
    if (imgMime) return { kind: "image", mimeType: imgMime };
    if (isProbablyBinary(sample)) return { kind: "binary", description: "detected as binary by content sniffing" };

    const decoder = new TextDecoder("utf-8");
    const fatalDecoder = new TextDecoder("utf-8", { fatal: true });
    let hadUtf8DecodeErrors = false;
    const noteUtf8Err = (chunk?: Uint8Array): void => {
      if (hadUtf8DecodeErrors) return;
      try {
        fatalDecoder.decode(chunk, { stream: chunk !== undefined });
      } catch (error: unknown) {
        if (error instanceof TypeError) { hadUtf8DecodeErrors = true; return; }
        throw error;
      }
    };

    noteUtf8Err(sample);
    const parts: string[] = [decoder.decode(sample, { stream: true })];
    let position = bytesRead;
    while (true) {
      const { bytesRead: chunkBytesRead } = await fileHandle.read(buffer, 0, SNIFF_BYTES, position);
      if (chunkBytesRead === 0) break;
      const chunk = buffer.subarray(0, chunkBytesRead);
      noteUtf8Err(chunk);
      parts.push(decoder.decode(chunk, { stream: true }));
      position += chunkBytesRead;
    }
    noteUtf8Err();
    parts.push(decoder.decode());
    return { kind: "text", text: parts.join(""), ...(hadUtf8DecodeErrors ? { hadUtf8DecodeErrors: true as const } : {}) };
  } finally {
    await fileHandle.close();
  }
}

export async function classifyFileKind(filePath: string): Promise<FKind> {
  const loaded = await loadFileKindAndText(filePath);
  if (loaded.kind === "text") return { kind: "text" };
  return loaded;
}
