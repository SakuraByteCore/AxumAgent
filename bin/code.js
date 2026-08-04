#!/usr/bin/env node
// `code` is a shortcut entry for `axum code`. Keep it in-process so
// `npm run code` avoids an extra Node startup before Pi starts.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const axum = path.join(here, "axum.js");
process.argv[1] = axum;
process.argv.splice(2, 0, "code");

try {
  await import(pathToFileURL(axum).href);
} catch (error) {
  console.error(`failed to start axum code: ${error.message}`);
  process.exit(1);
}
