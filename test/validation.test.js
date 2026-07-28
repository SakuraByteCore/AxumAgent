import assert from "node:assert/strict";
import { constants } from "node:fs";
import { accessSync } from "node:fs";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Faithful JS mirror of plugin/pi-edit/src/validation.ts
function errCode(error) {
  if (error instanceof Error) {
    return error.code;
  }
  return undefined;
}

function valAccessSync(absolutePath, pathStr, accessMode) {
  try {
    accessSync(absolutePath, accessMode);
  } catch (error) {
    const code = errCode(error);
    if (code === "ENOENT") throw new Error(`File not found: ${pathStr}`);
    if (code === "EACCES" || code === "EPERM") {
      const accessLabel = accessMode & constants.W_OK ? "not writable" : "not readable";
      throw new Error(`File is ${accessLabel}: ${pathStr}`);
    }
    throw new Error(`Cannot access file: ${pathStr}`);
  }
}

function valKind(file, pathStr) {
  if (file.kind === "directory") throw new Error(`Path is a directory: ${pathStr}. Use ls to inspect directories.`);
  if (file.kind === "binary") throw new Error(`Path is a binary file: ${pathStr} (${file.description}). Hashline edit only supports text files.`);
  if (file.kind === "image") throw new Error(`Path is an image file: ${pathStr}. Hashline edit only supports text files.`);
}

test("valKind accepts text files", () => {
  const file = { kind: "text", text: "hello" };
  // Should not throw
  valKind(file, "/test.txt");
});

test("valKind rejects directories", () => {
  const file = { kind: "directory" };
  assert.throws(() => valKind(file, "/dir"), /Path is a directory/);
});

test("valKind rejects binary files", () => {
  const file = { kind: "binary", description: "detected as binary" };
  assert.throws(() => valKind(file, "/bin"), /binary file/);
});

test("valKind rejects image files", () => {
  const file = { kind: "image", mimeType: "image/png" };
  assert.throws(() => valKind(file, "/img.png"), /image file/);
});

test("valAccess throws ENOENT for non-existent file", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-"));
  const nonExist = path.join(tmpDir, "does-not-exist.txt");
  assert.throws(() => valAccessSync(nonExist, "/does-not-exist.txt", constants.R_OK), /File not found/);
  fs.rmSync(tmpDir, { recursive: true });
});

test("valAccess reads existing file without error", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-"));
  const tmpFile = path.join(tmpDir, "readable.txt");
  fs.writeFileSync(tmpFile, "content");
  // Should not throw
  valAccessSync(tmpFile, tmpFile, constants.R_OK);
  fs.rmSync(tmpDir, { recursive: true });
});

test("errCode extracts code from Error", () => {
  const err = new Error("test");
  err.code = "ENOENT";
  assert.equal(errCode(err), "ENOENT");
});

test("errCode returns undefined for non-Error", () => {
  assert.equal(errCode("string"), undefined);
  assert.equal(errCode(null), undefined);
});
