# pi-edit (AxumAgent bundled fork)

Pure-JS hash-anchored read/replace extension for the Pi coding agent.

Pure-JS extension using only Node.js built-in modules (`node:sqlite`, `node:crypto`) so it runs on every platform AxumAgent supports, including Android/Termux where native C++ addons cannot compile.

## Replacements

| Upstream dependency | Replacement | Notes |
|---|---|---|
| `better-sqlite3` | `node:sqlite` (`DatabaseSync`) | Node 22+ built-in SQLite, same as `pi-hermes-memory` on Android |
| `sql.js` | — | Not needed; node:sqlite covers the hash store |
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
