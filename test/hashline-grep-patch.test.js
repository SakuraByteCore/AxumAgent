import assert from "node:assert/strict";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";
import { patchHashlineGrep } from "../src/bundled-pi-patches.js";

const source = `import { readNormFile } from "./file-reader";
async function searchFile(file, regex, maxMatches) {
  let norm;
  norm = await readNormFile(file);
  const lines = visLines(norm.normalized);
  const matchLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i]!)) matchLines.push(i);
  }
  if (matchLines.length === 0) return undefined;
  const keptMatches = matchLines.slice(0, maxMatches);
  return { lines, keptMatches, hashes: norm.fileHashes };
}`;
const stripBOM = text => ({ text: text.replace(/^\uFEFF/, "") });
const toLF = text => text.replace(/\r\n/g, "\n");
const visLines = text => text === "" ? [] : text.replace(/\n$/, "").split("\n");

function compile(code, readNormFile) {
  return new Function("readNormFile", "stripBOM", "toLF", "visLines",
    stripTypeScriptTypes(code.replace(/^import .*;$/gm, "")) + "\nreturn searchFile;"
  )(readNormFile, stripBOM, toLF, visLines);
}

test("hashline grep avoids hashes for misses and preserves normalized matches and anchors", async () => {
  for (const [text, pattern, flags, limit] of [
    ["alpha\nbeta\nalpha\n", "alpha", "", 1], ["\uFEFFalpha\r\nbeta\r\n", "^alpha$", "", 10],
    ["中文🙂\nALPHA\n", "alpha|中文", "i", 10], ["\nalpha\n\n", "^$", "", 10],
    ["alpha\nbeta\n", "missing", "", 10], ["", ".*", "", 10],
  ]) {
    let calls = 0;
    const read = async file => { calls++; const normalized = toLF(stripBOM(file.text).text); return { normalized, fileHashes: visLines(normalized).map((_, i) => `h${i}`) }; };
    const expected = await compile(source, read)({ text }, new RegExp(pattern, flags), limit);
    calls = 0;
    const actual = await compile(patchHashlineGrep(source), read)({ text }, new RegExp(pattern, flags), limit);
    assert.deepEqual(actual, expected);
    assert.equal(calls, expected === undefined ? 0 : 1);
  }
});

test("hashline grep patch is idempotent and rejects incompatible upstream layouts", () => {
  const patched = patchHashlineGrep(source);
  assert.equal(patchHashlineGrep(patched), patched);
  for (const anchor of ['import { readNormFile } from "./file-reader";', "  let norm;\n", "  const lines = visLines(norm.normalized);\n", "  if (matchLines.length === 0) return undefined;\n"]) {
    assert.throws(() => patchHashlineGrep(source.replace(anchor, "")), /searchFile layout changed/);
  }
});
