# DSH 自动重试

适用于 **DeepSeek Harness**（当前在 `0.2.2-rc.1` 上构建测试，不按 dsh 版本拦截加载） 的模型请求自动重试插件。上游返回 524 超时、429 限流、5xx、网络断连等错误时，在**当前步骤内原地重发同一请求**，次数可设置，条件可自定义。

## 它怎样“继承已完成的工作”

dsh 的 agent loop 在结束一轮之前，会把每次失败的模型请求交给 `agent/request-error` 恢复链。本插件在这里回答“重试”，loop 就在**同一个打开的轮次、同一个步骤**内重跑失败的那一步：

- 之前所有步骤、工具调用和工具结果都保留在会话历史里，不会重复执行。
- 重发的请求与失败的那次逐字相同（同一份历史、同一个模型），**不追加任何“继续”消息**。
- 失败尝试中途已流出的半截文字不会写入历史；聊天界面会清掉它，再显示重新生成的内容。
- 每次计划的重试先写入会话日志（原生 `llm/retry` / `llm/retry-started` 事件），再开始等待，所以聊天里会出现 dsh 自带的“模型重试”提示，取消或崩溃也不会留下看不见的待重试。

重试单位是“步骤”（一次模型调用及其工具执行），不是整轮。一个步骤内失败的部分输出无法“接着写”：模型 API 不支持从断点续传，所以这一步会完整重新生成，之前的步骤不受影响。

## 安装

开发源码与运行副本分离。版本包：

```text
/plugins/releases/dsh-auto-retry-0.1.1.tgz
```

在 dsh「插件 → 添加插件」输入上面的**容器路径**，确认安装并启用。是否需要重启以安装界面提示为准。不要用 `link:`、目录依赖或模块路径把源码目录接入常用 profile。

## 设置

在「插件」页打开 **dsh-auto-retry** 组合包，设置直接显示在页面上。保存后下一次失败即按新设置处理，不需要重启，也不会重新加载插件。设置写入当前 profile 的 `cordis.patch.yml`（`auto-retry` 一行），随 `data` 持久化。

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| 启用自动重试 | 开 | 关闭后失败交回 dsh 内置的重试与恢复处理 |
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
