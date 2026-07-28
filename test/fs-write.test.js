import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readlink, rename, rm, stat, writeFile, copyFile } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Faithful JS mirror of plugin/pi-edit/src/fs-write.ts
function errCode(error) {
  if (error instanceof Error) {
    return error.code;
  }
  return undefined;
}

async function resolveTarget(inputPath) {
  const absolutePath = resolve(inputPath);
  const { root } = parse(absolutePath);
  const parts = absolutePath.slice(root.length).split(sep).filter((part) => part.length > 0);
  const visitedSymlinks = new Set();

  async function resParts(currentPath, remainingParts) {
    if (remainingParts.length === 0) return currentPath;
    const [nextPart, ...tail] = remainingParts;
    const candidatePath = join(currentPath, nextPart);
    try {
      const candidateStats = await lstat(candidatePath);
      if (!candidateStats.isSymbolicLink()) return resParts(candidatePath, tail);
      if (visitedSymlinks.has(candidatePath)) {
        const error = new Error(`Too many symbolic links while resolving ${inputPath}`);
        error.code = "ELOOP";
        throw error;
      }
      visitedSymlinks.add(candidatePath);
      const linkTargetPath = resolve(dirname(candidatePath), await readlink(candidatePath));
      const targetParts = linkTargetPath.slice(parse(linkTargetPath).root.length).split(sep).filter((p) => p.length > 0);
      return resParts(parse(linkTargetPath).root, [...targetParts, ...tail]);
    } catch (error) {
      if (errCode(error) === "ENOENT") return join(candidatePath, ...tail);
      throw error;
    }
  }

  return resParts(root, parts);
}

async function writeAtomic(inputPath, content) {
  const targetPath = await resolveTarget(inputPath);
  let existingStats = null;
  try {
    existingStats = await stat(targetPath);
  } catch (error) {
    if (errCode(error) !== "ENOENT") throw error;
  }

  if (existingStats && existingStats.nlink > 1) {
    await writeFile(targetPath, content, "utf-8");
    return;
  }

  const dir = dirname(targetPath);
  const tempPath = join(dir, `.tmp-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const tempHandle = await open(tempPath, "wx", 0o600);
  try {
    await tempHandle.writeFile(content, "utf-8");
    if (existingStats) await tempHandle.chmod(existingStats.mode & 0o7777);
  } catch (error) {
    await tempHandle.close();
    try { await rm(tempPath, { force: true }); } catch {}
    throw error;
  }
  try {
    await tempHandle.close();
    await rename(tempPath, targetPath);
  } catch (error) {
    if (errCode(error) === "EXDEV") {
      try {
        await copyFile(tempPath, targetPath);
        await rm(tempPath, { force: true });
        return;
      } catch {
        try { await rm(tempPath, { force: true }); } catch {}
        throw error;
      }
    }
    try { await rm(tempPath, { force: true }); } catch {}
    throw error;
  }
}

test("resolveTarget resolves absolute path", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fs-"));
  const result = await resolveTarget(tmpDir);
  assert.equal(result, resolve(tmpDir));
  fs.rmSync(tmpDir, { recursive: true });
});

test("resolveTarget resolves relative path to absolute", async () => {
  const result = await resolveTarget("./some/file.txt");
  assert.ok(path.isAbsolute(result), "should be absolute");
  assert.ok(result.endsWith("some/file.txt"));
});

test("resolveTarget follows symlinks", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fs-"));
  const realDir = path.join(tmpDir, "real");
  const linkDir = path.join(tmpDir, "link");
  fs.mkdirSync(realDir);
  fs.writeFileSync(path.join(realDir, "target.txt"), "content");
  fs.symlinkSync(realDir, linkDir);
  const result = await resolveTarget(path.join(linkDir, "target.txt"));
  assert.equal(result, resolve(path.join(realDir, "target.txt")));
  fs.rmSync(tmpDir, { recursive: true });
});

test("writeAtomic writes new file", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fs-"));
  const filePath = path.join(tmpDir, "new.txt");
  await writeAtomic(filePath, "hello world");
  assert.equal(fs.readFileSync(filePath, "utf-8"), "hello world");
  fs.rmSync(tmpDir, { recursive: true });
});

test("writeAtomic overwrites existing file", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fs-"));
  const filePath = path.join(tmpDir, "existing.txt");
  fs.writeFileSync(filePath, "old content");
  await writeAtomic(filePath, "new content");
  assert.equal(fs.readFileSync(filePath, "utf-8"), "new content");
  fs.rmSync(tmpDir, { recursive: true });
});

test("writeAtomic creates nested directories", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fs-"));
  const filePath = path.join(tmpDir, "sub", "dir", "file.txt");
  await writeAtomic(filePath, "nested");
  assert.equal(fs.readFileSync(filePath, "utf-8"), "nested");
  fs.rmSync(tmpDir, { recursive: true });
});

test("writeAtomic writes empty content", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fs-"));
  const filePath = path.join(tmpDir, "empty.txt");
  await writeAtomic(filePath, "");
  assert.equal(fs.readFileSync(filePath, "utf-8"), "");
  fs.rmSync(tmpDir, { recursive: true });
});

test("writeAtomic preserves file permissions on overwrite", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fs-"));
  const filePath = path.join(tmpDir, "perm.txt");
  fs.writeFileSync(filePath, "original");
  fs.chmodSync(filePath, 0o644);
  const modeBefore = fs.statSync(filePath).mode & 0o7777;
  await writeAtomic(filePath, "updated");
  const modeAfter = fs.statSync(filePath).mode & 0o7777;
  assert.equal(modeAfter, modeBefore);
  fs.rmSync(tmpDir, { recursive: true });
});
