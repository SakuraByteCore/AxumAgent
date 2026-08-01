// Per-path multi-version LRU snapshot store (in-memory).
//
// Mirrors the upstream pi-hashline-edit read-snapshot store: keeps
// MAX_PATHS × MAX_VERSIONS_PER_PATH entries plus a total UTF-16 length cap.
// Used by the replace stale-anchor recovery path: when anchors are stale, the
// edit pipeline replays the requested change against each stored version and
// three-way-merges the result onto the current live content.
//
// Pure in-memory (no disk, no native deps) so it is Android-friendly and does
// not perturb the existing hash-store.ts disk cache.

const MAX_PATHS = 8;
const MAX_VERSIONS_PER_PATH = 4;
// 32 MiB soft ceiling, measured in UTF-16 code units (string .length).
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

interface PathEntry {
  // Versions in newest-first order.
  versions: string[];
}

// Paths stored in MRU-first order (index 0 = most recently used).
const pathOrder: string[] = [];
const pathMap = new Map<string, PathEntry>();

function totalSize(): number {
  let n = 0;
  for (const entry of pathMap.values()) {
    for (const v of entry.versions) {
      n += v.length;
    }
  }
  return n;
}

/**
 * Evict the oldest version of the globally least-recently-used path.
 * If that path's version list becomes empty, remove the path entirely.
 */
function evictOldestVersion(): void {
  // LRU path is at the end of pathOrder.
  for (let i = pathOrder.length - 1; i >= 0; i--) {
    const p = pathOrder[i]!;
    const entry = pathMap.get(p);
    if (entry && entry.versions.length > 0) {
      entry.versions.pop(); // pop = remove oldest (last in newest-first array)
      if (entry.versions.length === 0) {
        pathMap.delete(p);
        pathOrder.splice(i, 1);
      }
      return;
    }
  }
}

/**
 * Record a read snapshot for canonicalPath.
 *
 * - If content is byte-identical to the current newest version for this path,
 *   the call is a no-op (read fusion — avoids storing duplicates), but still
 *   promotes the path to MRU position so subsequent reads keep it warm.
 * - Evicts oldest versions / paths to stay within all three limits.
 */
export function rememberReadSnapshot(canonicalPath: string, content: string): void {
  const existing = pathMap.get(canonicalPath);

  if (existing && existing.versions.length > 0 && existing.versions[0] === content) {
    const idx = pathOrder.indexOf(canonicalPath);
    if (idx > 0) {
      pathOrder.splice(idx, 1);
      pathOrder.unshift(canonicalPath);
    }
    return;
  }

  if (existing) {
    existing.versions.unshift(content);
    while (existing.versions.length > MAX_VERSIONS_PER_PATH) {
      existing.versions.pop();
    }
    const idx = pathOrder.indexOf(canonicalPath);
    if (idx > 0) {
      pathOrder.splice(idx, 1);
      pathOrder.unshift(canonicalPath);
    }
  } else {
    if (pathOrder.length >= MAX_PATHS) {
      const lruPath = pathOrder[pathOrder.length - 1]!;
      pathMap.delete(lruPath);
      pathOrder.pop();
    }
    pathMap.set(canonicalPath, { versions: [content] });
    pathOrder.unshift(canonicalPath);
  }

  while (totalSize() > MAX_TOTAL_BYTES) {
    evictOldestVersion();
    if (pathMap.size === 0) break;
  }
}

/**
 * Return the most recent snapshot for canonicalPath, or null if none is stored.
 * The duplicate-edit guard depends on this returning the newest version only.
 */
export function getReadSnapshot(canonicalPath: string): string | null {
  const entry = pathMap.get(canonicalPath);
  return entry && entry.versions.length > 0 ? entry.versions[0]! : null;
}

/**
 * Return all stored versions for canonicalPath in newest-first order.
 * Returns an empty array when no snapshot exists for the path.
 */
export function getReadSnapshotVersions(canonicalPath: string): string[] {
  const entry = pathMap.get(canonicalPath);
  return entry ? [...entry.versions] : [];
}

/** Reset the entire store — for use in tests only. */
export function resetReadSnapshot(): void {
  pathOrder.length = 0;
  pathMap.clear();
}
