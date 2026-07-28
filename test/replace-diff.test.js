import assert from "node:assert/strict";
import test from "node:test";

// Faithful JS mirror of plugin/pi-edit/src/replace-diff.ts
function detectEnding(content) {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1 || crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

function toLF(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreEndings(text, ending) {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function stripBOM(content) {
  return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

test("detectEnding returns LF for unix files", () => {
  assert.equal(detectEnding("line1\nline2\n"), "\n");
});

test("detectEnding returns CRLF for windows files", () => {
  assert.equal(detectEnding("line1\r\nline2\r\n"), "\r\n");
});

test("detectEnding returns LF when no line endings", () => {
  assert.equal(detectEnding("no newlines here"), "\n");
});

test("detectEnding returns LF when only LF present", () => {
  assert.equal(detectEnding("only\nlf"), "\n");
});

test("detectEnding returns LF when only CRLF present without LF", () => {
  // \r\n contains \n so lfIdx !== -1, but crlfIdx === 0, lfIdx === 1
  // crlfIdx < lfIdx => CRLF
  assert.equal(detectEnding("a\r\nb"), "\r\n");
});

test("detectEnding prefers CRLF when it appears first", () => {
  assert.equal(detectEnding("a\r\nb\nc"), "\r\n");
});

test("detectEnding prefers LF when it appears first", () => {
  assert.equal(detectEnding("a\nb\r\nc"), "\n");
});

test("toLF converts CRLF to LF", () => {
  assert.equal(toLF("a\r\nb\r\nc"), "a\nb\nc");
});

test("toLF converts bare CR to LF", () => {
  assert.equal(toLF("a\rb\rc"), "a\nb\nc");
});

test("toLF on mixed endings", () => {
  assert.equal(toLF("a\r\nb\rc\nd"), "a\nb\nc\nd");
});

test("toLF on no endings is identity", () => {
  assert.equal(toLF("plain text"), "plain text");
});

test("restoreEndings converts LF back to CRLF", () => {
  assert.equal(restoreEndings("a\nb\nc", "\r\n"), "a\r\nb\r\nc");
});

test("restoreEndings LF is identity", () => {
  assert.equal(restoreEndings("a\nb\nc", "\n"), "a\nb\nc");
});

test("stripBOM removes BOM", () => {
  const { bom, text } = stripBOM("\uFEFFhello");
  assert.equal(bom, "\uFEFF");
  assert.equal(text, "hello");
});

test("stripBOM no BOM is identity", () => {
  const { bom, text } = stripBOM("hello");
  assert.equal(bom, "");
  assert.equal(text, "hello");
});

test("stripBOM empty string has no BOM", () => {
  const { bom, text } = stripBOM("");
  assert.equal(bom, "");
  assert.equal(text, "");
});
