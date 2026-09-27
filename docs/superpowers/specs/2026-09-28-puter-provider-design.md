# Puter 平台接入设计（驱动协议模式）

- 日期：2026-09-28
- 状态：已评审通过，待实施
- 工作副本：`d:\Projects\FreeLLMapi\freellmapi-src`（`main` 分支的浅克隆）

## 1. 背景与问题

FreeLLMapi 已部署在 VPS（`http://192.227.237.53:3001/`）。此前尝试把 Puter 作为
`Custom (OpenAI-compatible)` 端点接入，所有请求返回：

```
Custom (OpenAI-compatible) API error 402: Payment Required
```

**根因已确认为协议选型错误，而非额度耗尽。** Puter 官方文档明确：OpenAI 兼容端点
（`/puterai/openai/v1/*`）与 Anthropic 兼容端点**额外要求付费订阅**，免费账户调用固定返回
`402 subscription_required`。同一批模型通过 `puter.ai.*`（底层是 `POST /drivers/call`）
对免费账户开放，消耗账户的计量制免费额度。

因此接入路径是：**复刻 `puter.ai.chat()` 的驱动调用链，而不是使用 OpenAI 兼容端点。**

## 2. 目标与非目标

### 目标

1. 新增内置平台 `puter`，以账户 auth token 作为密钥（即用户所说的 `PUTER_AUTH_TOKEN`）。
   该 token **按密钥存储**，不使用全局环境变量——多账号是本需求的核心，全局单 token 与之冲突。
2. 在 Trae 等 IDE 中通过 FreeLLMapi 网关调用 Puter 免费模型（OpenAI 兼容 + 流式 + 工具调用）。
3. 配置 Puter 密钥时可关联代理（http/https/socks4/socks5），使不同账号走不同出口 IP，
   分别消耗各自的免费额度。
4. 鉴权探针不得消耗 AI 额度（健康检查每 ~5 分钟一次）。

### 非目标

- 不做代理池管理页（增删改查、连通性测试、轮换）。
- 不动态同步 Puter 全量目录（约 1030 个模型，两次实测分别为 1030 / 1029，目录为动态）。
- 不改动 FreeLLMapi 的网关对外协议（Trae 侧只需填 base_url）。
- 不引入 `@heyputer/puter.js` SDK。

## 3. 已验证事实（实时探针，2026-09-28）

所有结论来自对 `https://api.puter.com` 的真实调用，非文档推断。

| 验证项 | 结果 |
| --- | --- |
| `GET /puterai/chat/models/details` | 200，**约 1030 个模型**，17 个上游 provider；字段 `id` `puterId` `name` `modalities` `tool_call` `context` `max_tokens` `provider` `release_date` `open_weights` `costs` |
| `POST /drivers/call` 非流式 | 200，`{success:true, result:{message, finish_reason, usage}}`；免费账户可用 |
| `POST /drivers/call` 流式 | 200，`Content-Type: application/x-ndjson`，逐行 `{type:"text",text:"1"}`，末行 `{type:"usage",usage:{...}}`；**无 finish_reason 行** |
| 流式工具调用 | 行 `{type:"tool_use",id,name,input:{...},text:""}` 紧接 `{type:"usage",...}` |
| 工具调用（非流式） | `finish_reason:"tool_calls"`，`message.tool_calls:[{id,type:"function",function:{name,arguments}}]` |
| 无效 token | 401 `{error:"Authentication failed",message:"Authentication failed",code:"token_auth_failed"}` |
| 缺失 token（`/whoami`） | 401 `code:"token_missing"` |
| 不存在模型 | 400 `{error:"Model not found: X",code:"bad_request"}` |
| `normalize` 行为 | 不开时 Claude 返回 Anthropic 原生结构（`content:[{type:"text"}]`、`stop_reason`）；开 `normalize:true` 才是 OpenAI 结构 |
| usage 字段 | 各上游不一致：`gpt-5-nano`/`gemini` 给 `prompt_tokens`/`completion_tokens`；Claude 给 `input_tokens`/`output_tokens`；**全部带 `usd_cents`** |
| 免费鉴权探针 | `GET /whoami` + `Authorization: Bearer <token>` → 200（用户信息）/ 401；**不消耗 AI 额度** |
| `test_mode:true` | 仍产生真实补全，**不可**用作免额度探针 |

### 线协议（取自 `@heyputer/puter.js@2.6.3` 源码并实测确认）

```
POST {ORIGIN}/drivers/call
Content-Type: text/plain;actually=json
{
  "interface": "puter-chat-completion",
  "driver":    "ai-chat",
  "method":    "complete",
  "args":      { "messages": [...], "model": "...", "stream": false, "normalize": true, ... },
  "auth_token": "<token>"
}
```

关键点：

- 鉴权走 body 的 `auth_token` 字段，驱动调用**不发 `Authorization` 头**。
- `Content-Type` 是 `text/plain;actually=json`（非 `application/json`），必须照抄。
- `args.messages` 采用 OpenAI 形态。
- 官方 SDK 的 `PARAMS_TO_PASS` 不含 `tool_choice`，即 **`tool_choice` 不被透传**。

## 4. 架构

### 4.1 组件与文件改动

| 文件 | 改动 |
| --- | --- |
| `shared/types.ts` | `Platform` 联合新增 `'puter'`；注释记录免费额度事实（计量制、按月重置、无需付费订阅即可用 `puter.ai.*`） |
| `server/src/routes/keys.ts` | `PLATFORMS` 白名单新增 `'puter'` |
| `server/src/providers/puter.ts` | **新增**：`PuterProvider extends BaseProvider` |
| `server/src/providers/index.ts` | `register(new PuterProvider({ timeoutMs }))` |
| `server/src/lib/sampling-params.ts` | 新增 `puter` 参数策略 |
| `server/src/services/provider-quota.ts` | 新增 `puter` 配额池：池键 `puter::account`，并登记为共享池（见 §6.1） |
| `client/src/lib/routing.ts` | `PLATFORM_COLORS` 新增 `puter` 配色（否则平台标签回落默认色） |
| `server/src/db/migrations/20260928_000001_puter_models.ts` | **新增**：精选模型 `INSERT OR IGNORE` + `backfillFallback` |
| `client/src/components/keys/shared.tsx` | 平台下拉新增 Puter 项（label 说明额度，url 指向取 token 的页面） |
| `client/src/components/keys/add-key-form.tsx` | 新增可选「代理地址」输入 |
| `client/src/components/keys/edit-key-dialog.tsx` | 新增代理地址编辑，回显 `maskedProxyUrl` |
| `client/src/i18n/locales/en.json`、`zh-CN.json` | 新增文案键 |
| `server/src/__tests__/providers/puter.test.ts` | **新增**：TDD 测试 |
| `docs/en/providers/01-supported-platforms.md`、`docs/zh-cn/providers/01-supported-platforms.md` | 平台清单补一行 |

### 4.2 PuterProvider 设计

继承 `BaseProvider`，平台标识 `puter`，展示名 `Puter`。

**常量**

- `API_ORIGIN = process.env.PUTER_API_ORIGIN ?? 'https://api.puter.com'`（便于自建/代理，且测试可注入）
- `DRIVER_CONTENT_TYPE = 'text/plain;actually=json'`
- `IFACE = 'puter-chat-completion'`，`DRIVER = 'ai-chat'`，`METHOD = 'complete'`
- `AUTH_PROBE_URL = ${API_ORIGIN}/whoami`

**私有方法**

- `buildDriverBody(args)` → 组装第 3 节的请求体。`auth_token` 只进 body，不写日志。
- `readNdjsonStream(res)` → 逐行 JSON 解析，复用 `this.readWithStallTimeout` 的停流看守语义。
  `BaseProvider.readSseStream` 只识别 `data:` 前缀，**不可复用**（先例：`GoogleProvider` 自解析线格式）。
- `normalizeUsage(usage)` → `prompt_tokens ?? input_tokens`、`completion_tokens ?? output_tokens`、
  `total_tokens = prompt + completion`。
- `readUpstreamError(statusText, body)` → 解析 `{error, message, code}` 三字段。

**传输**

全部走 `this.fetchWithTimeout(url, init, timeoutMs, { signal, timeoutBounds })`。
这是「每密钥代理自动生效」的唯一前提：内部 `proxyFetch` 从 AsyncLocalStorage 取当前 key 的代理。

- 非流式：`timeoutBounds: 'request'`
- 流式：`timeoutBounds: 'headers'`，配合 `readWithStallTimeout` 做停流看守
- `timeoutMs` 默认 120000（Puter 走各上游，慢模型 + 排队可能超过项目默认 15s），可被
  `PROVIDER_TIMEOUT_PUTER` 覆盖

## 5. 数据流

### 5.1 非流式 `chatCompletion`

1. 组装 `args`：`messages`（透传 OpenAI 形态）、`model`、`temperature`、`max_tokens`、
   `tools`、`normalize: true`。
2. `POST /drivers/call`。
3. 非 2xx → 见第 6 节错误映射。
4. 解析 `{success: true, result}`；`success === false` 同样按错误处理。
5. 归一化为 `ChatCompletionResponse`：
   - `message.content` / `message.tool_calls` / `finish_reason` 直接取用
   - 补齐 `id`（缺失时 `makeId()`）、`created`、`object`、`choices[0].index = 0`
   - `usage` 走 `normalizeUsage`
   - 写入 `_routed_via = { platform, model }`
6. 不向 Puter 发送 `tool_choice` / `parallel_tool_calls`（官方 SDK 不透传 `tool_choice`）。

### 5.2 流式 `streamChatCompletion`

请求时 `args.stream = true`，响应为 NDJSON。逐行映射（合成标准 `ChatCompletionChunk`）：

| Puter 行 | 映射 |
| --- | --- |
| `{type:"text", text}` | `choices[0].delta.content = text` |
| `{type:"reasoning", reasoning}` | `choices[0].delta.reasoning_content = reasoning` |
| `{type:"tool_use", id, name, input}` | `choices[0].delta.tool_calls = [{ index, id, type:"function", function:{ name, arguments: JSON.stringify(input) } }]` |
| `{type:"usage", usage}` | 累积，附加到收尾帧的 `usage` |
| `{type:"error", message}` | 抛错终止流 |
| 其他/未知 `type` | 忽略 |

**收尾帧由适配器合成**：有 `tool_use` 则 `finish_reason = 'tool_calls'`，否则 `'stop'`。
必须合成的原因：Puter 流里没有 finish_reason，而 `BaseProvider.readSseFrames` 在流结束时
若未见 finish_reason 会判定为「截断」并抛错——不合成的话每个正常流都会被误判为失败。

### 5.3 鉴权 `validateKey`

`GET {API_ORIGIN}/whoami`，`Authorization: Bearer <token>`。

- 200 → `true`
- 401 → `{ valid: false, error }`，error 取响应体 `message`（`token_auth_failed` / `token_missing`）
- 网络错误 → 抛出，由 health 服务标记 `status='error'` 而不计入失败（与 `AIHordeProvider` 一致）

选择理由：健康检查每 ~5 分钟对每个 key 跑一次，用真实对话探活会烧光免费额度。
`/whoami` 实测不消耗 AI 额度；`test_mode:true` 实测仍会真实补全，不可用。

## 6. 错误处理与配额

| 上游响应 | 处理 |
| --- | --- |
| 401 / `code:"token_auth_failed"` | 密钥无效 |
| 402 / `code:"insufficient_funds"` | 额度耗尽 → `providerHttpError` 保留 status 402，交由路由/冷却层决定换道或冷却，适配器不自行重试 |
| 429 | 优先读 `Retry-After` 头，其次由 `parseStatedRetryMs` 读 body，写入 `retryAfterMs` |
| 400 / `code:"bad_request"` | 参数或模型 id 错误，透出 `message` |
| 流内 `{type:"error"}` | 抛错；已产出的内容保留 |
| 超时 / 断流 | 由 `fetchWithTimeout` + `readWithStallTimeout` 负责；错误信息含平台名便于 triage |

错误消息统一经 `providerHttpError(res, message, body)` 构造，以复用项目的退避与
日志脱敏链路。`auth_token` 绝不出现在错误消息或日志中。

### 6.1 配额池归属（易错点）

`provider-quota.ts` 的池键默认分支（`inferPoolForPlatform`）是
`${platform}::${normalizedModelId}`，即**按模型分池**。
Puter 不是这个模型：**一个账号一份免费额度，跨该账号下所有模型共享**。若沿用默认分支，
一个账号在某模型上 402 后，同账号的其他模型仍被当作独立配额继续尝试，冷却与预算统计都会失真。

因此需要两处显式声明：

- `inferPoolForPlatform`：`platform === 'puter'` → `'puter::account'`
- `isSharedPool`：登记 `'puter'` 为共享池

由于 `provider_quota_state` 的状态行以 `(platform, key_id, quota_pool_key, metric)` 为键，
`puter::account` 恰好是**每账号一个池、池内跨模型共享**——与「多账号各消耗自身额度」完全吻合。

## 7. 每密钥代理

后端**已完整支持**，本设计零改动：

- `POST /api/keys`、`PATCH /api/keys/:id` 均接受 `proxyUrl`
- `server/src/lib/key-proxy.ts` 负责校验（`http/https/socks4/socks4a/socks5/socks5h`）与加密存储
- `maskProxyUrl` 回显掩码
- 已有测试：`keys-proxy.test.ts`、`router-key-proxy.test.ts`

本次仅补前端入口：

- `add-key-form.tsx`：新增可选代理地址输入
- `edit-key-dialog.tsx`：新增代理地址编辑，非空时显示后端返回的 `maskedProxyUrl`
- 前端校验规则与后端 `isValidKeyProxyUrl` 保持一致，避免提交后 400

效果：一个 Puter 账号绑定一个固定出口代理 → 一个出口 IP，各账号独立消耗自身免费额度。

补充说明：Puter token 是随机串、无厂商前缀，`server/src/lib/key-parser.ts` 的
`PREFIX_MAP` 无法自动识别。因此导入 `.env`/配置文件时，Puter 密钥必须在行内显式声明平台，
或在 Keys 页下拉里手动选择 Puter。这是使用约束，不是代码缺陷，UI 文案需说明。

## 8. 模型目录

### 8.1 决策

写入 versioned migration（`INSERT OR IGNORE`，幂等），**不**走托管 catalog
（`services/catalog-sync.ts` 绑定付费 license 与 `api.freellmapi.co`，不可用于本地新增平台）。

### 8.2 精选清单（40 个，字段取自实时目录）

筛选口径：`tool_call = true`、输出含 `text`、跨 17 个上游覆盖面、优先最新旗舰与常用轻量档。

| provider | model_id | ctx | max_tokens | vision |
| --- | --- | --- | --- | --- |
| azure-openai | `gpt-5-nano` | 128000 | 128000 | Y |
| azure-openai | `gpt-5-mini` | 128000 | 128000 | Y |
| azure-openai | `gpt-5.4` | 1050000 | 1050000 | Y |
| azure-openai | `gpt-4o-mini` | 128000 | 16384 | Y |
| openai-completion | `gpt-4.1-mini` | 1047576 | 32768 | Y |
| openai-completion | `gpt-5-2025-08-07` | 128000 | 128000 | Y |
| openai-completion | `gpt-6-luna` | 1050000 | 128000 | Y |
| openai-responses | `gpt-5-pro` | 400000 | 272000 | Y |
| claude | `claude-haiku-4-5-20251001` | 200000 | 64000 | Y |
| claude | `claude-sonnet-4-5-20250929` | 200000 | 64000 | Y |
| claude | `claude-sonnet-4-6` | 1000000 | 64000 | Y |
| claude | `claude-opus-4-8` | 1000000 | 128000 | Y |
| claude | `claude-opus-5-5` | 1000000 | 128000 | Y |
| claude | `claude-fable-5-1` | 1000000 | 128000 | Y |
| gemini | `gemini-2.5-flash` | 1048576 | 65536 | Y |
| gemini | `gemini-2.5-flash-lite` | 1048576 | 65536 | Y |
| gemini | `gemini-3.1-pro-preview` | 1048576 | 65536 | Y |
| gemini | `gemini-3.5-flash` | 1048576 | 65536 | Y |
| gemini | `gemini-3.8-flash` | 1048576 | 65536 | Y |
| gemini | `gemma-4-31b-it` | 262144 | 8192 | Y |
| xai | `grok-4.5` | 500000 | 500000 | Y |
| xai | `grok-4.6` | 500000 | 500000 | Y |
| deepseek | `deepseek-v4-flash` | 1000000 | 384000 | n |
| deepseek | `deepseek-v4-pro` | 1000000 | 384000 | n |
| zai | `glm-4.7` | 200000 | 128000 | n |
| zai | `glm-5.3` | 1000000 | 128000 | n |
| zai | `glm-5.3-flash` | 1000000 | 128000 | n |
| alibaba | `qwen-flash` | 1000000 | 32768 | n |
| alibaba | `qwen3.5-plus` | 1000000 | 65536 | Y |
| alibaba | `qwen3.7-max` | 1000000 | 65536 | n |
| alibaba | `qwen3.8-max` | 1000000 | 131072 | Y |
| alibaba | `qwen3-coder-plus` | 1048576 | 65536 | n |
| alibaba | `qwen3-vl-plus` | 262144 | 32768 | Y |
| moonshotai | `kimi-k3` | 1048576 | 1048576 | Y |
| moonshotai | `kimi-k2.7-code` | 262144 | 262144 | Y |
| minimax | `minimax-m3` | 1048576 | 512000 | Y |
| minimax | `minimax-m2.7` | 204800 | 196608 | n |
| mistral | `mistral-large-2512` | 262144 | 262144 | Y |
| mistral | `codestral-2508` | 256000 | 256000 | n |
| byteplus | `seed-2-0-pro-260328` | 256000 | 128000 | Y |

### 8.3 上线前冒烟门禁

项目规范要求「模型行不得未经实测就入目录」。因此实施时附带一次性冒烟脚本：
对上述 40 个 id 各发一次极小请求（`max_tokens` 最小、单轮 "OK"），**失败者从 migration 中剔除**。
冒烟结果与剔除记录写入 migration 注释。

### 8.4 额度事实

Puter 未公布免费额度的具体数值。migration 注释与 `Platform` 注释只写
「计量制免费额度、按月重置、`puter.ai.*` 路径无需付费订阅」，**不编造数字**。

## 9. 测试策略（TDD）

`server/src/__tests__/providers/puter.test.ts`，先写失败测试再实现：

1. **请求形状**：URL 为 `${ORIGIN}/drivers/call`；`Content-Type` 为 `text/plain;actually=json`；
   body 含 `interface`/`driver`/`method`/`args`/`auth_token`；`tools` 被透传；`tool_choice` 不被发送；
   `normalize: true` 存在。
2. **token 不泄漏**：断言错误消息与日志字段中不含 token 明文。
3. **非流式归一**：解析 `{success,result}`；`gpt-5-nano` 型 usage（`prompt_tokens`）与
   Claude 型 usage（`input_tokens`）都能得到正确的 `prompt_tokens`/`completion_tokens`/`total_tokens`；
   补齐 `id`/`object`/`created`/`choices[0].index`。
4. **流式转换**：NDJSON（text / reasoning / tool_use / usage 组合）→ chunk 序列；
   `tool_use` 的 `input` 被序列化为 JSON 字符串；收尾帧 `finish_reason` 正确合成
   （有 tool_use → `tool_calls`，否则 `stop`）；`{type:"error"}` 抛错。
5. **错误映射**：401 → 无效密钥；402 → 保留 status 402；400 → 透出 `message`；三者均经 `providerHttpError`。
6. **validateKey**：`/whoami` 200 → `true`；401 → `{valid:false,error}`；网络错误向上抛。
7. **迁移幂等**：重复执行 `up()` 不产生重复行。
8. **白名单同步**：`'puter'` 同时存在于 `Platform` 联合与 `PLATFORMS`。
9. **配额池归属**：`inferPoolForPlatform('puter', ...)` 对不同 model 均返回 `'puter::account'`；
   `isSharedPool('puter')` 为 `true`。

验证命令：仓库根 `npm test` 与 `tsc --noEmit` 全绿。

## 10. 实现期待实测确认的风险点

以下必须用探针实测，不得靠推断：

1. **多轮工具回填**：`{role:"tool", tool_call_id, content}` 是否被 Puter 接受。
2. **视觉消息**：OpenAI 的 `content:[{type:"image_url",image_url:{url}}]` 是否可用。
3. **`max_tokens` 兼容性**：个别上游可能拒绝该字段；若拒绝，在 `sampling-params.ts` 的
   `puter` 策略中 `drop`。
4. **`reasoning_effort` 透传**：Puter 的 `PARAMS_TO_PASS` 含 `reasoning_effort`，但需实测是否
   所有上游都接受；不接受的按平台策略 drop。
5. **流式 usage 归属**：确认 `usage` 行是流的最后一行且不含 finish_reason（当前观测如此）。

任一项与预期不符，回到本设计更新第 5/6 节后再实施。

## 11. 交付与部署

1. 改动全部落在 `d:\Projects\FreeLLMapi\freellmapi-src`，随仓库提交。
2. 本地验证：仓库根 `npm test` + `tsc --noEmit`。
3. VPS 更新：按仓库既有部署方式重建并重启；`PUTER_API_ORIGIN` 与 `PROVIDER_TIMEOUT_PUTER`
   为可选环境变量。
4. Trae 侧：base_url 指向 `http://192.227.237.53:3001/v1`，model 填任一精选 id；
   网关本身无需改动。
5. 多账号：在 Keys 页为每个 Puter 账号各添加一条密钥，并分别填写各自的代理地址。

## 12. 清理项

- `.puter-token`（工作区根目录）为临时凭据，验证与实施完成后删除。
- `.probe/` 为一次性探针脚本，实施完成后删除。
