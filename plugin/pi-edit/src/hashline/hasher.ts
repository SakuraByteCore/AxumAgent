import { createHash } from "node:crypto";

// Pure-JS hasher using node:crypto SHA-1, replacing xxhash-wasm.
// Returns a 32-bit unsigned integer derived from the first 4 bytes of SHA-1.
export function xxh32(input: string, _seed = 0): number {
  const buf = createHash("sha1").update(input, "utf8").digest();
  return buf.readUInt32BE(0) >>> 0;
}

// 64-bit content checksum as hex string (first 16 hex chars of SHA-1).
export function contentChecksum(content: string): string {
  return createHash("sha1").update(content, "utf8").digest("hex").slice(0, 16);
}

export function initHasher(): Promise<void> {
  return Promise.resolve();
}
