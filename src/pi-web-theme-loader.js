import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { Server } from "node:http";
import path from "node:path";
import { PI_WEB_THEME_CSS } from "./pi-web-theme.js";

const INSTALL_FLAG = Symbol.for("axum.pi-web.theme-loader");
const MAX_CSS_BYTES = 256 * 1024;
const MAX_CSS_FILES = 64;
const CSS_FILENAME = /^[a-zA-Z0-9_.-]+\.css$/;

// 仅扫描样式目录；逐个释放候选内容，只缓存一个全局样式响应。
export function createThemeAsset(packageRoot) {
  const directory = path.join(packageRoot, ".next", "static", "css");
  const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && CSS_FILENAME.test(entry.name));
  if (files.length > MAX_CSS_FILES) throw new Error("Axum theme: CSS directory exceeds scan limit");
  let asset;
  for (const { name } of files) {
    const filename = path.join(directory, name);
    if (statSync(filename).size > MAX_CSS_BYTES) continue;
    const original = readFileSync(filename, "utf8");
    if (!original.includes("--user-bg:") || !original.includes("html.dark")) continue;
    if (asset) throw new Error("Axum theme: multiple global stylesheets found; unsupported pi-web build");
    const body = Buffer.from(`${original}\n${PI_WEB_THEME_CSS}\n`);
    asset = Object.freeze({
      pathname: `/_next/static/css/${name}`,
      body,
      etag: `"${createHash("sha256").update(body).digest("hex")}"`,
    });
  }
  if (!asset) throw new Error(`Axum theme: global CSS not found in ${directory}; unsupported pi-web build`);
  return asset;
}

export function installPiWebTheme(options) {
  const { packageRoot, serverType = Server } = options;
  const root = path.resolve(packageRoot);
  const prototype = serverType.prototype;
  if (prototype[INSTALL_FLAG]) {
    if (prototype[INSTALL_FLAG].packageRoot !== root) throw new Error("Axum theme: conflicting package roots");
    return prototype[INSTALL_FLAG];
  }
  const asset = createThemeAsset(root);
  const originalEmit = prototype.emit;
  const installation = Object.freeze({ packageRoot: root, pathname: asset.pathname, etag: asset.etag });
  prototype.emit = function (event, ...args) {
    const [request, response] = args;
    if (event !== "request" || (request.method !== "GET" && request.method !== "HEAD") ||
        request.url?.split("?", 1)[0] !== asset.pathname) {
      return Reflect.apply(originalEmit, this, [event, ...args]);
    }
    const validators = request.headers["if-none-match"];
    const unchanged = typeof validators === "string" && validators.split(",").some((entry) => {
      const tag = entry.trim();
      return tag === "*" || tag.replace(/^W\//, "") === asset.etag;
    });
    response.statusCode = unchanged ? 304 : 200;
    response.setHeader("Content-Type", "text/css; charset=utf-8");
    response.setHeader("ETag", asset.etag);
    response.setHeader("Cache-Control", "no-cache");
    if (!unchanged) response.setHeader("Content-Length", asset.body.length);
    response.end(unchanged || request.method === "HEAD" ? undefined : asset.body);
    return true;
  };
  Object.defineProperty(prototype, INSTALL_FLAG, { value: installation });
  return installation;
}

// NODE_OPTIONS 由 Next 子进程继承；ESM/CJS 共用内置 http.Server。
if (process.env.AXUM_PI_WEB_THEME_ROOT) {
  installPiWebTheme({ packageRoot: process.env.AXUM_PI_WEB_THEME_ROOT });
}
