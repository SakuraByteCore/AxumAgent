---
name: pi-plugins
description: Use when adding, removing, version-bumping, or troubleshooting Pi extensions/plugins in the AxumAgent distribution. Covers the bundled-pi-packages registry, platform derivation chain, test synchronization, README updates, and build verification. Trigger phrases include "add a plugin", "bundle pi extension", "update pi-* version", "pi install npm:", "plugin not loading on Android", and any work involving the src/bundled-pi-packages.js registry.
---

# Pi Plugins

Add, remove, version-pin, or debug Pi extensions bundled in the AxumAgent distribution. This skill encodes the full workflow so each plugin change takes minutes instead of hours.

## Scoped use (mandatory gate — check BEFORE any action)

This skill is **exclusive to the AxumAgent repository**. It is registered globally, so it may be surfaced in any working directory; use is **not** authorized outside AxumAgent. Before reading or running anything:

1. Resolve the current working directory (or the intended target project root).
2. Require ALL of the following — otherwise **abort immediately** and state that this skill does not apply here:
   - Working root contains `src/bundled-pi-packages.js` AND `src/bundled-pi-platform.js` (the registry + derivation source).
   - Working root contains `package.json` whose `name` field equals the AxumAgent distribution package.
   - Working root is a Git repository whose remote `origin` URL points at the AxumAgent repository.
3. Treat any ambiguity about the working root as a hard stop: ask which repository to target rather than guessing.
4. Do not create, install, or link anything in unknown or non-AxumAgent paths because this skill is loaded. Nothing is writable outside the AxumAgent checkout.

If the gate passes, the target is AxumAgent and the remainder of this skill applies normally.

## Architecture (read first)

The plugin system has one source and many derived consumers. **Always edit the source; never hand-edit derived data.**

### Source of truth

`src/bundled-pi-packages.js` — single array `bundledPiPackages`. Each entry:

```js
{ name: "<npm-spec>", packageName: "<node_modules name>", extensionPath: "<entry file or null>", android: <true|false>, unsupportedPlatforms: ["win32"|...] }
```

| Field | Purpose |
|---|---|
| `name` | npm install spec. Versioned (`pkg@1.2.0`) or local (`pkg@file:plugin/pkg`). |
| `packageName` | Resolved name inside `node_modules`. Scoped packages keep `@scope/name`. |
| `extensionPath` | Pi extension entry relative to package root. `null` for the core CLI. String for one extension. Array for multi-extension packages. |
| `android` | `true` = load on Android/Termux. Omit/false = exclude from Android installs. |
| `unsupportedPlatforms` | Optional array of platform ids to exclude (e.g. `["win32"]`). |

### Derived consumers (do NOT edit directly)

- `src/bundled-pi-platform.js` — `supportedBundledPiPackages()`, `localPluginNames()` (filters `file:` only), `supportedBundledPiExtensions()`, `expectedBundledExtensionCount()`. All read from the registry.
- `src/resolve-bundled-pi.js` — `resolveBundledExtensions()` maps registry entries to on-disk paths.
- `src/ensure-bundled-pi.js` — syncs local `file:` plugin sources into cache, then runs `npm install`.

## Two plugin types

### Type A: npm package (e.g. `@narumitw/pi-goal`, `pi-web-access`)

Upstream published to npm. Installed via `npm install <name>@<version>`.

### Type B: local file: plugin (e.g. `pi-edit`, `pi-bar`, `pi-header`, `pi-loop-guard`)

Source lives in `plugin/<name>/` in the repo. Shipped as `file:plugin/<name>`. The `ensure-bundled-pi.js` sync step copies the local source into the cache before npm resolves the `file:` spec.

## Step-by-step: add an npm plugin

### 1. Inspect the target package

```bash
npm view <package-name> version pi main
```

The `pi.extensions` field (from `npm view <pkg> pi`) tells the `extensionPath`. Typical values: `["./index.ts"]` or `["./src/index.ts"]`.

Verify Android safety — check for native deps:

```bash
npm pack <package-name>@<version>   # download to temp dir
tar -xzf <package-name>-<version>.tgz
# inspect package/package.json for node-gyp / binding.gyp / .node prebuilds
grep -rl "binding.gyp\|node-gyp\|\.node\"\|prebuild" package/package.json
```

If native modules exist, the plugin is **not Android-safe**. Either find a pure-JS alternative, fork it locally (Type B), or set `android: false` and add `unsupportedPlatforms: ["android"]`.

### 2. Add the registry entry

Edit `src/bundled-pi-packages.js`. Insert before the trailing `];`. Follow the existing comment style:

```js
  // <plugin-name>: <one-line description>. <native-dep status>.
  { name: "<package-name>@<version>", packageName: "<package-name>", extensionPath: "<entry.ts>", android: true },
```

Reference example (pi-goal, scoped npm package):

```js
  // pi-goal: pure TS extension for autonomous /goal completion. No native deps.
  { name: "@narumitw/pi-goal@0.31.0", packageName: "@narumitw/pi-goal", extensionPath: "src/index.ts", android: true },
```

Reference example (pi-web-access, unscoped npm package):

```js
  { name: "pi-web-access@0.18.0", packageName: "pi-web-access", extensionPath: "index.ts", android: true },
```

### 3. Update tests (critical — hardcoded counts WILL break)

There are **three** test files with hardcoded extension counts and package lists. Every new plugin increments the count by 1.

#### `test/bundled-pi-platform.test.js`

Three tests with `deepEqual` package lists + `expectedBundledExtensionCount`:

- Test "loads pi-edit and pi-goal on Android" (platform `android`)
- Test "keeps same bundled Pi extensions on Linux desktop platforms" (platform `linux`)
- Test "Windows loads the same extension set as other platforms" (platform `win32`)

For each: append the new package spec to the `deepEqual` array AND bump the count:

```js
    "@narumitw/pi-goal@0.31.0",
    "pi-web-access@0.18.0",        // <-- add
  ]);
  assert.equal(expectedBundledExtensionCount({ platform: "android", env: {} }), 6);  // 5 -> 6
```

**Only update** `localPluginNames` deepEqual if the new plugin is a `file:` type. npm plugins do NOT appear there.

#### `test/resolve-bundled-pi.test.js`

Three tests with `writePackage` + `extensions.length` + indexed `extensions[N]` assertions:

- "resolves bundled Pi from Axum cache directory"
- "Android loads pi-edit and pi-goal"
- "Windows loads same extension set as other platforms"

For each: add `writePackage(cache, "<packageName>", { "<extensionPath>": "" })`, bump `extensions.length` from 5→6, add the new `extensions[5]` index assertion:

```js
  writePackage(cache, "pi-web-access", { "index.ts": "" });
  ...
  assert.equal(extensions.length, 6);
  ...
  assert.equal(extensions[5], path.join(cache, "node_modules", "pi-web-access", "index.ts"));
  assert.equal(existingBundledExtensions(options).length, 6);
```

Two fakeNpm tests with inline `pkg(...)` / `writePkg(...)` calls:

- "ensure installs missing bundled Pi into cache root once and patches Pi TUI"
- "reinstalls bundled Pi when cached runtime dependency is missing"

For each: add the package to the fakeNpm script's package list AND bump the `existingBundledExtensions` count assertion (first test only; second has no count assertion but still needs the package written so the install set matches the registry):

```js
pkg('<packageName>', { '<extensionPath>': '' });
```

**WARNING**: The fakeNpm scripts are template literals inside `fs.writeFileSync(fakeNpm, \`...\`)`. The outer template closes with a single backtick: `` `); ``. When editing, ensure exactly **one** backtick closes the outer template. Two or three backticks cause `SyntaxError` or runtime `JSON.stringify(...) is not a function`.

**WARNING (Extensions card truncation)**: `plugin/pi-header/index.ts` renders an Extensions card with a hardcoded `cardWidth = Math.min(width, 52)` (inner text area = 50 chars). The card lists all extension display names joined by `, `. Each extension name is derived as `basename(dirname(extensionPath))`. When the total joined length exceeds 50, `truncateLine` silently cuts the card body, showing fragments like a lone `p` instead of `pi-web-access`. After adding any extension, verify the joined name length fits within the card's inner width. If it overflows, bump the `52` limit in `const cardWidth = Math.min(width, 52)` to a larger value (e.g. `72`) so the full list is visible on standard 80-column terminals. The `Math.min(width, ...)` term still constrains it on narrow terminals. The pre-existing test `pi-header centers the Extensions card and matches the ASCII vertical gap` fails with `5 !== 1` regardless of this change — it is a known baseline failure unrelated to plugin additions.

#### `test/cli.test.js`

Two tests with `writePackage`:

- "axum code disables ambient extensions before loading bundled extensions" — add `writePackage`, bump `expectedExtensionCount` (const) from 5→6.
- "axum code --safe disables ambient extensions without loading bundled extensions" — add `writePackage` only. The `--safe` path asserts `-e` count is 0, which is unaffected.

### 4. Update README (three languages)

`README.md`, `README.ja.md`, `README.zh-CN.md` — two spots per file:

**Bundled runtime list** (near top, after `@narumitw/pi-goal`):

```markdown
- `pi-web-access`
```

**Safe-mode line** (in the `doctor` section):

```markdown
without loading `pi-edit` / `pi-bar` / `pi-goal` / `pi-header` / `pi-web-access`.
```

Japanese equivalent: `を読み込みません。` for the safe-mode line.
Chinese equivalent: `不加载 ... 。` for the safe-mode line.

### 5. Build and test

```bash
npm run build    # node --check on all src/ and bin/ files
npm test         # node --test test/*.test.js
```

If `npm test` shows `pass N / fail M`, compare against the pre-change baseline. Known pre-existing failures in this repo: `axum versions prints the installed version` (hardcoded version mismatch) and `pi-header centers the Extensions card` (ASCII layout). These are unrelated to plugin changes.

### 6. Verify the derivation chain

```bash
# Extension count reflects the new entry
node -e "import('./src/bundled-pi-platform.js').then(m=>console.log('count:',m.expectedBundledExtensionCount({platform:'android',env:{}})))"

# localPluginNames excludes npm plugins (only file: plugins listed)
node -e "import('./src/bundled-pi-platform.js').then(m=>console.log(m.localPluginNames({platform:'android',env:{}})))"

# Registration visible
grep "<package-name>" src/bundled-pi-packages.js
```

## Step-by-step: add a local file: plugin

Same as npm, with these differences:

1. Create `plugin/<name>/` with `package.json`, `index.ts`, and `LICENSE`. The `package.json` must contain:

```json
{
  "name": "<name>",
  "type": "module",
  "pi": { "extensions": ["./index.ts"] },
  "peerDependencies": { "@earendil-works/pi-coding-agent": ">=0.74.0" }
}
```

2. Registry entry uses `file:` spec:

```js
  { name: "<name>@file:plugin/<name>", packageName: "<name>", extensionPath: "index.ts", android: true },
```

3. `localPluginNames` deepEqual in `bundled-pi-platform.test.js` **must** include the new name — it is a `file:` plugin.

4. The `plugin/<name>/` source must exist on disk (a test checks `fs.existsSync`).

## Version bump an existing plugin

Only change the `@<version>` in the `name` field of `src/bundled-pi-packages.js` and the corresponding `@<version>` in the `deepEqual` arrays of `test/bundled-pi-platform.test.js`. No count change needed. Run build + test.

## Remove a plugin

Reverse of add:
1. Delete the entry from `src/bundled-pi-packages.js`.
2. Remove it from all three test files (writePackage calls, deepEqual arrays, count assertions, indexed assertions).
3. Bump counts down.
4. Remove from three READMEs.
5. If it was a `file:` plugin, delete `plugin/<name>/` and remove from `localPluginNames` deepEqual.

## Quick checklist (copy per task)

- [ ] `npm view <pkg> pi` → confirm `extensionPath`
- [ ] Check for native deps (Android safety)
- [ ] `src/bundled-pi-packages.js` — add entry
- [ ] `test/bundled-pi-platform.test.js` — 3× deepEqual + 3× count
- [ ] `test/resolve-bundled-pi.test.js` — 3× writePackage + lengths + index[5] + 2× fakeNpm pkg
- [ ] `test/cli.test.js` — 2× writePackage + 1× expectedExtensionCount
- [ ] `README.md` / `README.ja.md` / `README.zh-CN.md` — list + safe-mode line
- [ ] `npm run build` passes
- [ ] `npm test` — new failures == baseline failures
- [ ] `node -e` derivation check confirms count and localPluginNames