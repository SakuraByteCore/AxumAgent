# 微信 OpenClaw 当前会话控制 技术变更说明

### 问题

微信收发由腾讯插件负责，Axum 绑定当前终端会话接收任务、忙时排队并回传结果，不启动另一个工作会话。

### 原因

事实：腾讯插件默认把消息交给 OpenClaw Agent，不会接管现有 Axum 会话。
已通过 GitHub API 查看 OpenClaw 的 registerCommand（绕过 LLM）、registerService、channel.outbound.loadAdapter(channelId) 及腾讯插件 outbound.sendText(ctx)。
调查时参考 OpenClaw main 提交 4d689774c5e653162c98b76064f8c214b7914c41、腾讯插件 main 提交 874637a0dbc24050f72d1385add4fc6170a2d726；这是源码契约证据，不是安装版本兼容认证。
公开来源：
- https://github.com/openclaw/openclaw/blob/main/src/plugins/plugin-command.types.ts
- https://github.com/openclaw/openclaw/blob/main/src/plugins/plugin-registration.types.ts
- https://github.com/openclaw/openclaw/blob/main/src/plugins/runtime/types-channel.ts
- https://github.com/openclaw/openclaw/blob/main/src/channels/plugins/registry-loader.ts
- https://github.com/Tencent/openclaw-weixin/blob/main/src/channel.ts
Pi 事件定义查看本地 node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts；消息发送参数沿用仓库既有 streamingBehavior 契约，防止与运行时版本分叉。

### 修改点

- 新增 plugin/pi-remote-control/：无第三方依赖的 Pi 插件，登记到捆绑清单；仅执行 /remote on 后监听 127.0.0.1，默认端口 18791。
- queue.js：内存任务队列、显式请求 ID 去重、绑定代次校验、串行任务、只收集 assistant 文本，忽略思考与工具正文。每次 /remote on 生成新 binding，防止旧请求误投重绑会话。
- server.js：Bearer 认证、JSON 接收、请求长度和处理超时限制；GET /status、POST /tasks、GET /tasks/:id。
- index.js：消息进入当前 Pi 会话；本地任务执行中先排队，agent_settled 后派发。远程任务运行中拒绝新的本地普通输入以避免结果混归，提示完成后重发；/remote off 可解除绑定。切换会话或关闭时解除绑定，不转投新会话。
- 新增 plugin/openclaw-axum/：独立 OpenClaw 插件包，不作为 Pi 扩展加载；注册 /axum 命令及结果轮询服务，限定 channel、accountId、senderId 和上游授权状态。按文本长度分段，通过腾讯插件 sendText 回传原发送方。
- 更新 src/bundled-pi-packages.js、四个清单/CLI/解析测试文件及 README 三语入口；新增 test/remote-control.test.js。
- 未修改任何外部 OpenClaw 配置、凭据、CI/CD 或锁文件；并发任务的 pi-bar 文件不属于本任务。

### 预期结果

#### 配置与操作

1. OpenClaw 机器先安装并登录腾讯渠道插件（已有安装可跳过）。登录属于用户操作，本轮未执行：

```sh
openclaw plugins install @tencent-weixin/openclaw-weixin
openclaw channels login --channel openclaw-weixin
```

2. 安装本仓库提供的 OpenClaw 适配插件。以下从 AxumAgent 仓库根运行，异机时需把 plugin/openclaw-axum 整个包交付到 OpenClaw 主机再安装：

```sh
openclaw plugins install ./plugin/openclaw-axum
```

在 OpenClaw 插件配置中为 `plugins.entries.axum-bridge.config` 设置 senderId 和 accountId，值取当前微信登录账号与实际发送方的渠道标识（不是昵称）。配置示意：

```json
{
  "senderId": "实际微信发送方ID",
  "accountId": "实际微信渠道账号ID"
}
```

3. 两端进程环境注入相同的 `AXUM_REMOTE_TOKEN`（至少 32 字符随机值，不写入源码）。可在终端临时生成：

```sh
export AXUM_REMOTE_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
```

使用现有进程管理方式将相同值注入 OpenClaw Gateway；不要把重新执行生成命令产生的不同值当作同一令牌。OpenClaw 端 `AXUM_REMOTE_URL` 默认 http://127.0.0.1:18791；Axum 端 `AXUM_REMOTE_PORT` 默认 18791。两端重启以加载插件与环境。

异机在 OpenClaw 主机建立到 Axum 主机的回环端口隧道，仍使用默认 URL，不将桥接监听扩展到公网：

```sh
ssh -N -L 127.0.0.1:18791:127.0.0.1:18791 user@axum-host
```

4. 在目标 Axum 终端执行 `/remote on`；微信依次发送：

```text
/axum bind
/axum 查看当前项目结构
/axum status
```

需要可重试且有副作用的任务使用显式 ID：

```text
/axum run task-001 修改指定测试文件
/axum result task-001
```

重复相同 ID 和相同内容不重复执行；同 ID 不同内容明确拒绝。`/remote status` 查看本地绑定，`/remote off` 解除绑定。

#### 已执行验证与限制

- 桥接定向测试：真实回环 HTTP + OpenClaw/Pi API 替身，覆盖授权、绑定、排队、去重、结果回传与关闭。未使用真实微信账号。
- 第一次 `timeout 30s npm test` 超时；拆批首轮再次卡在 test/e2e.test.js。该文件启动真实 axum code 并可能触发新缓存安装，未在本轮扩大安装预算，不能宣称全量通过。
- 最终验证：排除超时的 test/e2e.test.js 后，其余全部测试 507/507 通过（约 11.5 秒，日志 $TMPDIR/wechat-no-e2e-final.log）；直接相关测试批次 106/106 通过；最终绑定代次与回传复验 3/3 通过。四个新增业务 JS 通过 node --check，git diff --check 通过。
- 全量回归曾捕获新代码使用旧 deliverAs 参数，已改为仓库现有 streamingBehavior 并通过 stress-retry 回归，未改测试绕过断言。
- 测试日志留在 Termux 临时目录，不在仓库交付清单；没有提取包或构建大资产。
- 未安装 OpenClaw、未扫码、未做真实微信/模型端到端验收。OpenClaw API 依据以上源码，实际部署版本需具备相同接口。
- 首版使用 `/axum <需求>`；普通微信文本仍交给 OpenClaw，不劫持其全部聊天。
- 队列、绑定与已送分段进度仅存内存，每次绑定最多 100 条任务记录。进程退出不会自动恢复任务或补投；关闭绑定不取消已发生的写入，亦不强停模型。
- OpenClaw 命令上下文没有已核实的稳定入站消息 ID，普通 `/axum <需求>` 无法承诺跨上游重复投递的严格一次执行；显式 `/axum run <ID> <需求>` 提供进程生命周期内去重。
- 回传失败保留未完成状态并记录日志，定时重试；若微信已收到但响应丢失，可能重复发送当前文本分段，不宣称 exactly-once。任务执行不随回传重试再次提交。
- 会话关闭、隧道断开或网络错误均不报告任务成功；可通过 result 命令核查。重启或重新绑定可能使旧内存记录失效。
- 人工待验收：真实微信 bind/发送/排队/回传；未授权账号拒绝；会话切换后旧绑定拒绝；断线恢复后查询结果；确认没有返回思考内容。

#### 回退

在终端 /remote off，停用 OpenClaw 的 axum-bridge 扩展即可停止桥接；源码回退仅恢复本次清单、测试、README 与新增两个插件包，不触碰微信登录材料或其他并发改动。
