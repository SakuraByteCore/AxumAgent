export const SNIFF_BYTES = 8192;
export const MAX_BYTES = 100 * 1024 * 1024;
export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 256 * 1024;
export const MAX_HASH_RETRIES = 262144;
export const AUTO_READ_MAX = 2000;
export const AUTO_READ_HASH_MAX = 20000;
export const MAX_HASH_LINES = 20000;
export const MAX_REPLACE_ADDED_LINES = 4000;

// 折叠态下展示的正文/diff 预览最大行数（对齐上游 bash/grep 折叠预览量级）。
// 折叠态本就该让用户一眼看到“具体操作了啥”，再展开看全量。
export const COLLAPSED_PREVIEW_LINES = 10;
// Soft cap on total content_lines across all edits in one replace call.
// Exceeding it rejects the edit with [E_REPLACE_TOO_LARGE] so callers fall back to `write`.
export const MAX_RESULT_HASH_LINES = MAX_HASH_LINES;

// Budget for genDiff output. When old+new line count exceeds this, the full LCS
// diff is skipped and a compact summary hunk is returned instead (truncated: true).
export const MAX_DIFF_LINES = 6000;
