# npm 死代理清理 技术变更说明

> 目标绝对路径：~/.npmrc（备份 ~/.npmrc.bak.20261017）
> 目标环境：Termux (android-arm64)，本机 npm 11.17.0 / node v24.17.0
> 是否Git：否（用户级 dotfile）
> 可写性：可写（用户显式授权选项 B）
> 易失性与重建方式：非易失；备份文件可整文件回滚

### 问题
`axum update` 连续失败：npm 全部网络请求 ECONNREFUSED 127.0.0.1:7890（Clash 代理进程未运行），外层下载、postinstall 内层 npm install（bundled-pi 缓存装配）均被阻断。

### 原因
两处死代理配置：① `~/.npmrc` 持久层 `proxy`/`https-proxy` 两行指向 127.0.0.1:7890；② 会话环境变量 `npm_config_proxy`/`npm_config_https_proxy` 同值（经取证：不在任何 profile/rc，系长存活交互 shell PID 1374 `bash -l` 内手动 export，随 shell 关闭自然消失，非持久源）。内层 npm 因 `ensure-bundled-pi.js` 的 `npmInstallEnv` 剥离 `npm_*` 环境变量，必然回退读 `~/.npmrc`，故持久层两行是必清项。

### 修改点
- 删除 `~/.npmrc` 中 `proxy=http://127.0.0.1:7890` 与 `https-proxy=http://127.0.0.1:7890` 两行；authToken 与 registry 行原样保留。
- 未改动任何 profile/rc 文件（环境变量层无持久来源，无需清理）。

### 预期结果
- `npm config get proxy` / `https-proxy` 均为 null（卸载会话残留 env 后验证，事实观测）。
- `npm ping` 直连 registry.npmjs.org 返回 PONG 1054ms（事实观测）。
- 后续 `axum update`/`axum code` 首次缓存装配（ensure-bundled-pi 内层 npm install）不再撞死代理；本次 update 已通过 `AXUM_BUNDLED_PI_NPM` 包装器临时绕过完成（全局 axum 与 pi-b3034b7ad9a6 缓存均已就绪）。
- 残留：长存活旧 shell 及其子进程（含当前 axum code 会话）仍带 `npm_config_proxy` env，关闭后清零；期间直接跑 npm 会仍走死代理，属已知会话级残留，无需处理。
- 回滚方式：`cp ~/.npmrc.bak.20261017 ~/.npmrc`。
