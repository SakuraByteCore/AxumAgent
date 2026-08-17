import { createHash } from "node:crypto";

export function loadP(relativePath: string, replacements?: Record<string, string>): string {
  const filePath = new URL(relativePath, import.meta.url);
  const fs = require("fs");
  let content = fs.readFileSync(filePath, "utf-8").trim();
  if (replacements) {
    for (const [key, value] of Object.entries(replacements)) {
      content = content.split(`{{${key}}}`).join(value);
    }
  }
  return content;
}

export function loadGuide(relativePath: string, replacements?: Record<string, string>): string[] {
  const filePath = new URL(relativePath, import.meta.url);
  const fs = require("fs");
  let content = fs.readFileSync(filePath, "utf-8");
  if (replacements) {
    for (const [key, value] of Object.entries(replacements)) {
      content = content.split(`{{${key}}}`).join(value);
    }
  }
  return content.split("\n").map((line: string) => line.trim()).filter((line: string) => line.startsWith("- ")).map((line: string) => line.slice(2));
}
