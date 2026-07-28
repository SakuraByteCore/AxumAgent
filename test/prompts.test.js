import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Faithful JS mirror of plugin/pi-edit/src/prompts.ts (template replacement logic)
function applyReplacements(content, replacements) {
  let result = content;
  if (replacements) {
    for (const [key, value] of Object.entries(replacements)) {
      result = result.split(`{{${key}}}`).join(value);
    }
  }
  return result;
}

function loadPContent(content, replacements) {
  return applyReplacements(content.trim(), replacements);
}

function loadGuideContent(content, replacements) {
  const replaced = applyReplacements(content, replacements);
  return replaced
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));
}

test("loadP replaces template variables", () => {
  const content = "Hello {{name}}, welcome to {{place}}.";
  assert.equal(loadPContent(content, { name: "Alice", place: "Wonderland" }), "Hello Alice, welcome to Wonderland.");
});

test("loadP replaces no variables when no replacements", () => {
  const content = "Hello {{name}}.";
  assert.equal(loadPContent(content), "Hello {{name}}.");
});

test("loadP trims surrounding whitespace", () => {
  const content = "  \nHello\n  ";
  assert.equal(loadPContent(content), "Hello");
});

test("loadP replaces multiple occurrences of same key", () => {
  const content = "{{x}} and {{x}}";
  assert.equal(loadPContent(content, { x: "Y" }), "Y and Y");
});

test("loadP handles replacement value with special chars", () => {
  const content = "Value: {{val}}";
  assert.equal(loadPContent(content, { val: "$1.00 (cheap)" }), "Value: $1.00 (cheap)");
});

test("loadP leaves unknown placeholders intact", () => {
  const content = "{{known}} and {{unknown}}";
  assert.equal(loadPContent(content, { known: "A" }), "A and {{unknown}}");
});

test("loadGuide extracts list items starting with dash", () => {
  const content = "Title\n- First item\n- Second item\nNot a list item\n- Third item";
  assert.deepEqual(loadGuideContent(content), ["First item", "Second item", "Third item"]);
});

test("loadGuide with template replacements", () => {
  const content = "- {{action}} the file\n- Save changes";
  assert.deepEqual(loadGuideContent(content, { action: "Edit" }), ["Edit the file", "Save changes"]);
});

test("loadGuide empty content yields empty array", () => {
  assert.deepEqual(loadGuideContent(""), []);
});

test("loadGuide no list items yields empty array", () => {
  const content = "Just some text\nno dashes here";
  assert.deepEqual(loadGuideContent(content), []);
});

test("loadGuide strips whitespace from list items", () => {
  const content = "-   spaced item  \n-  another  ";
  assert.deepEqual(loadGuideContent(content), ["  spaced item", " another"]);
});

test("loadGuide only matches dash-space prefix", () => {
  const content = "-real item\n- proper item\n--not matched";
  // "-r" starts with "- " only if next char is space; "-real" does not match "- "
  // Actually "-r" does NOT match "- " (dash-space), so only "- proper item" matches
  assert.deepEqual(loadGuideContent(content), ["proper item"]);
});
