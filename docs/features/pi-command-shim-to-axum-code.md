# [pi 命令入口] 变更说明

### 问题

外部检测 Pi agent 可用性时判定为不可用：

```
Binary: pi
Resolved path: not found
Version: unknown
Status: Unavailable
```

检测同时给出两条探针结果：

- `which -a pi: spawn /usr/bin/which ENOENT`：检测方硬编码了 `/usr/bin/which`。
- `bash -lc type -a pi: Command failed: type: pi: not found`：设备 PATH 中确实没有 `pi` 可执行文件。

期望效果：外部调用方把 AxumAgent 当作 Pi agent 使用——调用 `pi` 直接落到当前的 `axum code`（Axum 默认配置 + 全部内置扩展），而不是裸 Pi。

### 原因

1. Axum 只暴露 `axum` / `code` 两个入口，从未在 PATH 上提供 `pi`；`~/.pi/agent/bin`（Pi daemon PATH 与登录 shell PATH 的第一项）甚至不存在。
2. 本机是 Android/Termux：不存在 `/usr` 目录（`ls /usr` → No such file or directory），`/bin` 指向 `/system/bin`；因此检测方硬编码的 `/usr/bin/which` 永远无法执行，该条探针在本机不可修复。
3. 追加 `pi` 启动器后实测发现第二个隐患：从 Axum/Pi 会话内部调用 `pi` 会继承 `NODE_OPTIONS=--import=.../pi-web-fast-loader.js`；`buildPiEnv()` 再追加一次同名 preload，子进程会二次改写 Pi SDK 源码，触发 `Axum Fast: unsupported Pi SDK payload hook` 并直接退出。

### 修改点

- **新增 `src/pi-command-shim.js`**：生成 `pi` 启动器内容与落盘逻辑。
  - 落点：`~/.pi/agent/bin/pi`（Pi daemon PATH 与登录 shell PATH 的第一项）。
  - 内容：`#!/usr/bin/env sh` + `exec "$axum_bin" code "$@"`，`axum_bin` 优先取运行时 `command -v axum`，回落到写入时记录的绝对路径 → 始终指向**当前**安装的 axum。
  - 幂等：内容一致则不重写；带自有标记，若目标位置存在**非本模块写入**的 `pi`（真实 Pi 安装）则跳过，绝不覆盖。
- **启动器自身清理继承环境**：shim 在 `exec axum code` 前剔除继承 `NODE_OPTIONS` 中的 `pi-web-fast-loader.js` preload（CLI 自己会追加一份），因此即便全局安装仍是旧版本，会话内调用 `pi` 也不会二次改写 Pi SDK 而崩溃。
- **新增 `src/fast-loader-env.js`**：`buildFastLoaderNodeOptions()` 在追加 Fast loader preload 前剔除继承环境里同名 preload，其他 `NODE_OPTIONS` 原样保留。
- **`bin/axum.js`**：`runPi()` 与 `runInstall()` 调用 `ensurePiCommandShim()`（每次启动/安装都保证启动器存在且指向当前 axum）；`buildPiEnv()` 改用 `buildFastLoaderNodeOptions()`。
- **`src/pi-web-fast-loader.js` 幂等化**：同一进程内若存在多份 loader（全局安装版被 preload + 仓库版被 import），第二份 hook 会读到已被改写的 SDK 源码并抛出 `Axum Fast: Pi SDK payload callback changed`。现改为：hook 注册加全局标记（`Symbol.for("axum.fast-service-tier.loader-hook")`）只注册一次；`instrumentWebSdk()` 对已改写源码原样返回。

### 预期结果

- `type -a pi` 命中 `~/.pi/agent/bin/pi`，检测可判定 Pi agent 可用。
- 任何 `pi ...` 调用等价于 `axum code ...`：同样的 Axum 默认模型/思考档、同样的内置扩展、同样的会话目录。
- 从会话内部调用 `pi` 不再因 preload 叠加崩溃。

### 验证

- 新增测试 13 条全部通过：
  - `test/pi-command-shim.test.js`（6 条）：脚本内容与参数透传、落点路径、可执行位与幂等、外部 `pi` 不被覆盖、真实执行启动器得到 `code --version extra`、启动器剔除继承的 fast loader preload。
  - `test/fast-loader-env.test.js`（4 条）：空 `NODE_OPTIONS`、继承同名 preload 被剔除、无关选项保留、二次构造不重复叠加。
  - `test/pi-web-fast-loader.test.js`（3 条）：hook 每进程只注册一次、已改写源码原样返回、第二份 loader 副本不再注册第二个 hook。
- 设备实测：
  - `bash -lc 'type -a pi'` → `pi is /data/data/com.termux/files/home/.pi/agent/bin/pi`。
  - 干净环境（外部调用方视角）`pi --version` → `0.99.2`。
  - 继承会话 `NODE_OPTIONS` 时 `pi --version` → `0.99.2`（修复前该路径报 `Axum Fast: unsupported Pi SDK payload hook` 并退出）。
  - 仓库版 `node bin/axum.js code --version` → `0.99.2`。
  - `test/fast-service-tier.test.js` 的真实 SDK 用例在双 loader 环境下由失败转为通过（修复前报 `Axum Fast: Pi SDK payload callback changed`）。
- `npm test` 与 `npm run build` 结果见提交说明中的基线对比。

### 外部落点与重建方式

- 落点（pwd 之外，运行时生成物）：`~/.pi/agent/bin/pi`（0755）。
- 重建方式：执行 `axum code` 或 `axum install`（自动重新生成）；也可 `node -e 'import("./src/pi-command-shim.js").then(m => console.log(m.ensurePiCommandShim()))'`。
- 该文件带 `AxumAgent pi shim` 标记；`axum update` 覆盖全局包不会影响它，`axum code` 每次启动会刷新其内容以指向当前 axum。

### 证据

- **观测事实**：`bash -lc 'type -a pi'` 在改动前输出 `type: pi: not found`；`ls /usr` → 不存在；`command -v which` → 不存在（仅 `whereis` 存在）；`~/.pi/agent/bin` 改动前不存在；登录 shell PATH 首项为 `~/.pi/agent/bin`；`pi --version` 改动后输出 `0.99.2`。
- **确定推导**：`pi` 未落盘 ⇒ `type -a pi` 失败 ⇒ 检测判定 Unavailable；落盘 `~/.pi/agent/bin/pi` ⇒ 该项必然命中（PATH 首项）⇒ 外部 `pi` 调用进入 `axum code`。
- **分析推论**：进程内同时存在两份 Fast loader（全局安装版被 `NODE_OPTIONS` preload + 仓库版被 import）时，hook 链中后注册者先执行、先注册者随后再次改写同一 SDK 源码，第二次命中 `block.split("return payload;").length !== 2` → 抛出 `Axum Fast: Pi SDK payload callback changed`；`buildPiEnv()` 追加的 preload 与继承 preload 同属一类叠加。证据：hook 链实测栈（repo hook → nextStep → global hook → instrument）、被改写源码头部 import 指向全局安装路径、以及两处 loader 文件内容一致。
- **未知盲区**：外部检测方位于本仓库之外，其 `/usr/bin/which` 探针在本机无法成立（Android 无 `/usr`），该条探针是否影响最终 Status 取决于检测方是否以其它探针为准；本次未修改该外部检测实现。
