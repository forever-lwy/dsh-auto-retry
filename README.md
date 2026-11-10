# DSH 自动重试

适用于 **DeepSeek Harness**（当前在 `0.2.2-rc.1` 上构建测试，不按 dsh 版本拦截加载） 的模型请求自动重试插件。上游返回 524 超时、429 限流、5xx、网络断连等错误时，在**当前步骤内原地重发同一请求**，次数可设置，条件可自定义。

## 它怎样“继承已完成的工作”

dsh 的 agent loop 在结束一轮之前，会把每次失败的模型请求交给 `agent/request-error` 恢复链。本插件在这里回答“重试”，loop 就在**同一个打开的轮次、同一个步骤**内重跑失败的那一步：

- 之前所有步骤、工具调用和工具结果都保留在会话历史里，不会重复执行。
- 重发的请求与失败的那次逐字相同（同一份历史、同一个模型），**不追加任何“继续”消息**。
- 失败前还没有输出正文（只有思考内容或什么都没有）时，聊天界面清掉这次尝试，再显示重新生成的内容。失败前已经输出了正文时，默认不重试，而是保留这些内容，见下一节。
- 每次计划的重试先写入会话日志（原生 `llm/retry` / `llm/retry-started` 事件），再开始等待，所以聊天里会出现 dsh 自带的“模型重试”提示，取消或崩溃也不会留下看不见的待重试。

重试单位是“步骤”（一次模型调用及其工具执行），不是整轮。模型 API 不支持从断点续传，所以重试会完整重新生成这一步，之前的步骤不受影响。

## 出错时保留已生成的内容

dsh 对以错误结束的请求只记录一次失败尝试，不把任何内容写进会话历史。很长的回答在网关超时（例如 axonhub 的 600 秒总时限、Cloudflare 约 100 秒的空闲断开）时会整段消失，重试也只能从头再生成，而且常常再次超时。

开启“出错时保留已生成内容”（默认开）后，对任何提供方的 agent 对话请求：

- 请求在**正文已经开始输出之后**失败时，已生成的正文和思考内容作为一条回复**写入会话**，末尾附一段说明，例如：`⚠️ 输出未完成：Google 流在终止标记之前结束。以上是连接断开前已生成的内容；回复“继续”可从断开处接着写。`
- 本轮随即结束，界面下方显示 dsh 固定的“已达到输出 token 上限”提示（dsh 只在这种结束方式下保留内容）。真实原因以回复里的说明为准。
- 在输入框回复“继续”，下一次请求的历史里就包含这段内容和那句说明，模型从断开处接着写。之前的步骤和工具结果全部保留。
- 这种失败**不再自动重试**，因为重试会丢掉已生成的内容。
- 断开时还没生成完的工具调用不会执行。
- 只有思考内容、只有空白，或用户手动取消的请求，保持原来的处理，继续按重试规则走。
- 会话标题、摘要等不属于 agent 对话的内部请求不受影响，照常报错。

保留下来的内容不带提供方的原生回放数据（例如 Gemini 的思考签名），下一轮按普通文本发回，正文不受影响。这个开关与“启用自动重试”互相独立，也遵守“仅限提供方”。

## 安装

在 DSH「插件 → 添加插件」输入下面的来源，确认安装并启用：

```text
github:forever-lwy/dsh-auto-retry
```

仓库默认分支是 `release`，其中每个提交都是某次发版的源码加上构建好的 `lib/`，并去掉了 `prepare`，所以安装时不装 devDependencies、不构建。dshmarket 按默认分支上 `package.json` 的版本号判断是否有更新，点击更新时安装 `release` 的最新提交。不要安装 `master`：它只有源码，安装时会靠 `prepare` 拉全部 devDependencies 现场构建。

包名自 0.1.2 起为 `@forever-lwy/dsh-auto-retry`，以免与 npm 和插件市场目录里的同名插件混淆。从旧的 `dsh-auto-retry` 版本包迁移时，先卸载旧的 `dsh-auto-retry`，再安装上面的来源；两者注册同一宿主行，不能同时安装。宿主行 id 和设置命名空间不变。

是否需要重启以安装界面提示为准。不要用 `link:`、目录依赖或模块路径把源码目录接入常用 profile。

## 设置

在「插件」页打开 **dsh-auto-retry** 组合包，设置直接显示在页面上。保存后下一次失败即按新设置处理，不需要重启，也不会重新加载插件。设置写入当前 profile 的 `cordis.patch.yml`（`auto-retry` 一行），随 `data` 持久化。

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| 启用自动重试 | 开 | 关闭后失败交回 dsh 内置的重试与恢复处理 |
| 出错时保留已生成内容 | 开 | 正文已输出后失败时保留内容并结束本轮，不再重试；见上一节 |
| 每个步骤最多重试次数 | 5 | 用完后本轮按原错误结束；下一个步骤重新计数 |
| 首次等待 / 单次等待上限 | 2 秒 / 60 秒 | 指数退避（每次翻倍），±20% 随机浮动 |
| 遵循上游 Retry-After | 开 | 上游指定等待时间时使用它，不超过上限 |
| HTTP 状态码 | 408, 429, 500, 502, 503, 504, 520–526, 529 | 52x 为 Cloudflare 回源错误，524 即回源超时 |
| 错误代码 | RATE_LIMIT, SERVER, SERVER_ERROR, TIMEOUT, TRANSPORT, NETWORK, EMPTY_RESPONSE, OVERLOADED | dsh 归一化的失败代码 |
| 错误信息匹配 | 状态码数字、`ECONNRESET` 等系统错误、`fetch failed`、`other side closed`、`overloaded` 等 | 正则，不区分大小写，每行一条 |
| 排除的错误代码 | ABORTED, AUTH, QUOTA, ACCOUNT_QUOTA, INVALID_REQUEST, INVALID_CONFIG, INVALID_CREDENTIAL, MISSING_CREDENTIAL, MODEL_NOT_FOUND, CONTEXT_WINDOW_EXCEEDED, IMAGE_OFFLOAD_REQUIRED | 优先于所有重试条件 |
| 仅限提供方 | 空（全部） | 提供方 ID，例如 `google-ai-studio` |

满足状态码、错误代码、错误信息任意一条即重试；排除代码优先。各适配器报告错误的方式不同，三类条件可互相补充：

- **dsh-google-native**：带 HTTP 状态；524 报为 `SERVER_ERROR`，无状态的连接失败报为 `NETWORK`。
- **pi-ai**：状态码只出现在错误文字里，例如 `524 A timeout occurred`；由错误信息匹配命中。
- **DeepSeek 官方适配器**：`RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT` 等。

也可以不用界面，直接在 profile 的 `cordis.patch.yml` 中配置（毫秒）：

```yaml
- id: auto-retry
  config:
    maxRetries: 8
    initialDelayMs: 3000
    statusCodes: [429, 502, 503, 524]
    messagePatterns: ['\b524\b', 'ECONNRESET', '上游繁忙']
```

## 与内置重试的关系

dsh 自带的 `llm-retry` 也会对部分错误重试：没有自定义 `retryPolicy` 的提供方，默认对 `RATE_LIMIT`、`SERVER`、`TIMEOUT`、`TRANSPORT`、`EMPTY_RESPONSE` 最多重试 5 次。它不覆盖 google-native 的 `SERVER_ERROR`（524 等）和 `NETWORK`，也不能按状态码或错误文字自定义。

本插件排在恢复链最前面：

- 命中本插件规则的失败由本插件处理，只按这里的次数重试；用完即结束，不会再叠加内置重试。
- 没有命中（或被排除、插件关闭、提供方不在名单内）的失败原样交给后面的处理者，例如内置重试、上下文压缩、图片卸载。

## 注意

- 每次重试都是一次新的计费请求，会重复输入 token。
- 只覆盖经过 agent loop 的模型请求（对话及子智能体）；直接调用 `ctx.llm.stream()` 的功能（如标题生成）仍只尝试一次。
- 会话日志会记录失败信息（错误文字、状态码），与 dsh 内置重试相同，不含请求内容或凭据。
- 错误信息正则由你提供，过宽的正则可能把非暂时性错误也纳入重试，但次数有上限。

## 开发

```bash
npm install
npm run build
npm test
```

测试在真实的 rc.5 agent loop 中运行：一个脚本化的上游在完成一次工具调用后连续返回 524 和断连，验证工具不重复执行、重发请求与原请求一致、没有额外用户消息，以及次数用尽、取消、规则排除、与内置重试交接、设置页读写和配置热更新。

发版：在 `master` 上开发和推送不会触发任何构建。改完后递增 `package.json` 版本并提交，打同名标签并推送，例如 `git tag v0.1.2 && git push origin master v0.1.2`。GitHub Actions（`.github/workflows/release.yml`）只在 `v*` 标签推送时运行：检查标签与版本一致，按 lockfile `npm ci`，由 `scripts/release.mjs` 构建、测试，在 `release` 分支上追加一个发布提交（源码加 `lib/`，去掉 `prepare`；父提交是上一个发布提交和该标签的源码提交）并推送。`release` 已有同一或更高版本时会拒绝发版。`npm run release` 可在本地对已打标签的提交生成同样的发布提交（不推送）。
