// Noop / duplicate-payload loop guard.
//
// Mirrors the upstream pi-hashline-edit guard. Models empirically ignore soft
// noop text and can loop indefinitely re-sending byte-identical payloads.
// A thrown tool error is what actually breaks the cycle. This module is pure
// in-memory state (no persistence, no native deps) so it is Android-friendly.

/** Hard limit after which a repeated byte-identical noop escalates to an error. */
export const NOOP_HARD_LIMIT = 3;

interface NoopEntry {
  payloadKey: string;
  count: number;
}

const noopTracker = new Map<string, NoopEntry>();

// Tracks the payloadKey of the last successfully applied replace per canonical
// path. Used to detect duplicate-applied payloads (e.g. a change sent twice
// after a false failure assumption by a weak model).
const appliedPayloadTracker = new Map<string, string>();

/**
 * Record a noop replace attempt for the given canonical mutation target path.
 * A different payloadKey resets the count (the model changed payload = progress).
 * Returns the current count and whether the hard limit has been hit.
 */
export function recordNoopEdit(
  path: string,
  payloadKey: string,
): { count: number; escalate: boolean } {
  const existing = noopTracker.get(path);
  if (existing && existing.payloadKey === payloadKey) {
    existing.count += 1;
  } else {
    noopTracker.set(path, { payloadKey, count: 1 });
  }
  const count = noopTracker.get(path)!.count;
  return { count, escalate: count >= NOOP_HARD_LIMIT };
}

/**
 * Clear the noop counter for a path and record the payloadKey of the
 * successfully applied replace, for duplicate-applied-payload detection.
 */
export function recordAppliedEdit(path: string, payloadKey: string): void {
  noopTracker.delete(path);
  appliedPayloadTracker.set(path, payloadKey);
}

/**
 * Returns true when the incoming payloadKey matches the last successfully
 * applied payload for the path. The caller must additionally verify the file
 * has not changed since that edit before treating this as a duplicate.
 */
export function isDuplicateAppliedPayload(path: string, payloadKey: string): boolean {
  return appliedPayloadTracker.get(path) === payloadKey;
}

/**
 * Clear the applied-payload record for a path. Called when the model re-reads
 * the file — a deliberate re-read followed by the same payload is intentional
 * and must be allowed through.
 */
export function clearAppliedPayload(path: string): void {
  appliedPayloadTracker.delete(path);
  // A re-read is also evidence the model saw current state; clear the noop
  // counter too so an unrelated future identical payload is not prematurely
  // flagged as a loop continuation.
  noopTracker.delete(path);
}

/** Reset all counters — for use in tests only. */
export function resetNoopLoopGuard(): void {
  noopTracker.clear();
  appliedPayloadTracker.clear();
}
