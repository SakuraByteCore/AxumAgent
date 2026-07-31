import https from "node:https";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO = "SakuraByteCore/AxumAgent";
const ARCHIVE_BASE = `https://github.com/${REPO}/archive/refs`;

let cachedPackageVersion;

/**
 * Read the installed Axum version from the bundled package.json.
 * npm pack ships package.json, so this value reflects what was installed.
 */
export function getInstalledVersion() {
  if (cachedPackageVersion) return cachedPackageVersion;
  const here = fileURLToPath(import.meta.url);
  const pkgPath = path.resolve(path.dirname(here), "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  cachedPackageVersion = pkg.version;
  return cachedPackageVersion;
}

/**
 * Resolve the tarball URL for a target version.
 * If version is null or undefined, returns the main branch tarball URL
 * to keep the existing default behavior unchanged.
 */
export function resolveTarballUrl(version) {
  if (!version) return `${ARCHIVE_BASE}/heads/main.tar.gz`;
  const clean = version.startsWith("v") ? version.slice(1) : version;
  if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(clean)) {
    throw new Error(
      `invalid version "${version}"; expected semver such as 0.1.0 or v0.1.0`,
    );
  }
  return `${ARCHIVE_BASE}/tags/v${clean}.tar.gz`;
}

/**
 * Fetch the list of published git tags from the GitHub API.
 * Returns an array of tag names (e.g. ["v0.1.0", "v0.2.0"]).
 * Throws on network or non-200 HTTP errors.
 */
export function fetchAvailableTags() {
  return new Promise((resolve, reject) => {
    const url = `https://api.github.com/repos/${REPO}/tags`;
    const req = https.get(
      url,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "axum-agent",
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`GitHub API responded ${res.statusCode}: ${getShortBody(body)}`));
            return;
          }
          try {
            const parsed = JSON.parse(body);
            if (!Array.isArray(parsed)) {
              reject(new Error("unexpected GitHub tag response shape"));
              return;
            }
            resolve(parsed.map((tag) => tag.name));
          } catch (err) {
            reject(new Error(`failed to parse GitHub tag response: ${err.message}`));
          }
        });
      },
    );
    req.on("error", (err) => reject(new Error(`GitHub API request failed: ${err.message}`)));
  });
}

function getShortBody(body) {
  return body.length <= 200 ? body : `${body.slice(0, 200)}...`;
}
