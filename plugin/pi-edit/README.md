# pi-edit (AxumAgent bundled fork)

Pure-JS hash-anchored read/replace extension for the Pi coding agent.

Pure-JS extension using only Node.js built-in `node:crypto` and a JSON file-backed hash store. No native dependencies — runs on every platform including Android/Termux and Node 18+.

## Replacements

| Upstream dependency | Replacement | Notes |
|---|---|---|
| `better-sqlite3` | Pure-JS JSON file backend | No SQL engine needed; hashes persisted as `hash-store.json` across sessions.
| `sql.js` | — | Not needed; pure-JS hash store replaces all SQLite usage |
| `xxhash-wasm` | `node:crypto` SHA-1 (32-bit truncation) | No WASM dependency |
| `file-type` | magic-byte sniffing | JPEG/PNG/GIF/WebP detection in pure JS |
| `diff` | LCS-based line diff | Pure JS unified-diff generator |
| `typebox` | plain JSON-schema objects | No schema library |
| `@earendil-works/pi-tui` | plain text output | No TUI rendering dependency |

## How it works

### read

Text files are returned as `HASH\u2502content` lines (3-char base64 hash, separator, line content). Line numbers are not part of the output — use the HASH to anchor edits.

### replace

Replaces lines referenced by `hash_range_inclusive` (two 3-char hashes from read) with `content_lines` (literal replacement lines). Bulk mode batches multiple edits in one `changes` array.

### Boundary dedup

If a `content_lines` edge (first non-empty line for leading, last non-empty line for trailing) equals the line adjacent to the anchor range, the call fails with `[E_BOUNDARY_DUP]` instead of silently dropping the duplicated line. Do not paste the line just outside the anchor range into `content_lines` — anchor only the lines you intend to replace. To replace the adjacent line too, expand `hash_range_inclusive` to include it.

## Commands

- `/toggle-replace-mode` — switch between bulk and flat replace modes
- `/toggle-auto-read` — toggle automatic hashline anchors after write/replace

## License

MIT.
