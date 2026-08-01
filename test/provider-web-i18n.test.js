import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getLanguagePreference, saveLanguagePreference } from "../src/provider-config.js";

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axum-i18n-"));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("getLanguagePreference returns 'en' by default", () => {
  const { dir, cleanup } = tmpDir();
  const file = path.join(dir, "settings.json");
  assert.equal(getLanguagePreference(file), "en");
  cleanup();
});

test("saveLanguagePreference('ja') persists and reads back", () => {
  const { dir, cleanup } = tmpDir();
  const file = path.join(dir, "settings.json");
  const result = saveLanguagePreference("ja", file);
  assert.equal(result.language, "ja");
  assert.equal(result.file, file);
  assert.equal(getLanguagePreference(file), "ja");
  // verify file on disk
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.language, "ja");
  cleanup();
});

test("saveLanguagePreference('en') persists and reads back", () => {
  const { dir, cleanup } = tmpDir();
  const file = path.join(dir, "settings.json");
  saveLanguagePreference("en", file);
  assert.equal(getLanguagePreference(file), "en");
  cleanup();
});

test("saveLanguagePreference rejects unsupported language", () => {
  const { dir, cleanup } = tmpDir();
  const file = path.join(dir, "settings.json");
  assert.throws(() => saveLanguagePreference("fr", file), /Unsupported language/);
  assert.throws(() => saveLanguagePreference("ko", file), /Unsupported language/);
  cleanup();
});

test("getLanguagePreference falls back to 'en' for unsupported value on disk", () => {
  const { dir, cleanup } = tmpDir();
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, JSON.stringify({ language: "fr" }), { mode: 0o600 });
  assert.equal(getLanguagePreference(file), "en");
  cleanup();
});

test("saveLanguagePreference preserves existing settings keys", () => {
  const { dir, cleanup } = tmpDir();
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, JSON.stringify({ retry: { enabled: true, maxRetries: 5 }, defaultProvider: "acme" }), { mode: 0o600 });
  saveLanguagePreference("ja", file);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.language, "ja");
  assert.equal(raw.retry.enabled, true);
  assert.equal(raw.retry.maxRetries, 5);
  assert.equal(raw.defaultProvider, "acme");
  cleanup();
});

test("saveLanguagePreference('zh') persists and reads back", () => {
  const { dir, cleanup } = tmpDir();
  const file = path.join(dir, "settings.json");
  const result = saveLanguagePreference("zh", file);
  assert.equal(result.language, "zh");
  assert.equal(getLanguagePreference(file), "zh");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.language, "zh");
  cleanup();
});
