# Cockpit 20 渠道配额生产通道补充核验

## 范围、版本与结论

本报告补齐上一轮报告未追到生产请求、写入与输出位置的配额通道；基线是 `9holy/usage-ledger@be0318c0a6caf93c62d810774cf3a06e46bfbf30`（v0.2.38），对应本次 v0.2.39 修改。上游固定为 [jlcodes99/cockpit-tools@820e176842d440a60e650729c3a39932b76a0ccb][upstream]，不是随时间变化的默认分支。

原报告 [Cockpit 数据通道源码契约核验](cockpit-data-contract-audit-2026-11-07.md) 的请求库、Token、价格和来源隔离证据继续保留；其中关于 Trae 无法从明文索引分流、部分渠道仅有 opaque raw 数据的旧结论，由本报告的具体生产链及限制替代。原报告的 v0.2.38 测试统计属于历史记录，不能当成本轮结果。

本轮已修复可用源码证明的漏读、错读与错误隐匿，包括四种 Trae 的索引分流、Windsurf 日/周与 credits 结构、Buddy 系列资源包、Zed 当前桌面接口、Qoder 个人/企业作用域、Cursor 重置、Google 新旧观测及项目冲突、旧 Google 历史误绑 Codex，以及读取失败被转换为空表。

**自有成本算法、手工采购价、倍率和实付金额没有改变。** 本文的 credits、资源包额度、供应商预算、Token spending cents 都只用于来源自身的额度比例；它们不能成为本项目的采购成本、付款事件或经核实的账单。没有读取真实账号凭据、调用用户供应商接口或核对用户设备账单。源码契约与合成反例通过不等于所有真实账户已经完成账务对账。

## 证据链与读取边界

以下路径相对于固定上游。以 `src-tauri/src/modules/mod.rs` 实际编译的模块为准；不能仅看到另一个目录里同名模块就当成当前生产代码。每个已支持形状均追到请求或导入、账号字段赋值、持久化以及官方界面的解释函数。本项目新增解析在 `src-tauri/src/cockpit_quota_providers.rs`，身份、缓存和时间处理仍由 `cockpit_quota.rs` 管理。

渠道账号的正常路径是 `<channel>_accounts.json` 索引与 `<channel>_accounts/<id>.json` 详情，特殊映射见下表。上游 [secure_account_storage][storage] 可以整体加密详情。本项目不解密凭据：明文索引能够证明账号身份或 Trae 平台，不能因此宣称密文中的配额可读。只有可读的持久化字段、兼容导出或 Google 明文缓存进入配额解析；读不到的额度保留未知。

默认读取仍是来源已经写入本地的数据。`LiveApiProvider` 的当前实现没有代用户发送上游配额请求；“立即刷新”可能返回明确的实时失败和本地快照降级。因此本报告列出的 HTTP 接口是 **Cockpit 的生产请求**，并非 usage-ledger 本轮新增的外网请求。

## 20 渠道逐项矩阵

“已核实”表示有固定源码的生产与存储证据；“已修”表示本轮有旧版反例及候选回归。所有比例均保留来源观测时间，最终显示统一为剩余百分比。不同池之间的百分比不相加。

| 渠道键 | 生产请求 / 写入入口 | 当前可读字段与输出 | 本轮结果及明确边界 |
|---|---|---|---|
| `codex` | [codex_quota::fetch_quota][codex-quota] GET `https://chatgpt.com/backend-api/wham/usage`；[账号更新][codex-write] 持久化 `quota` | `hourly_percentage` / `weekly_percentage` 是归一化后的剩余值；presence、窗口分钟数、reset 秒分别保留 | 已核实；不能从 primary/secondary 槽位名称自行推断时长。API Key 模式不被视为 ChatGPT 订阅；自定义服务的金额或无限余额不当作订阅额度 |
| `claude` | OAuth GET `https://api.anthropic.com/api/oauth/usage`；Desktop GET `https://claude.ai/api/organizations/{org}/usage`；[desktop_auth][claude-auth] 保存 `quota`、`claude_usage_raw` | `five_hour`、`seven_day`、Sonnet、启用的 extra；Desktop `limits[]` 与 OAuth utilization 的单位分别解释 | 已核实并保留前轮修复；默认 scalar 0 且没有原始观测/reset 不证明存在额度池；OAuth 0.5 是 0.5%，不能统一放大 100 倍 |
| `antigravity` | [quota::fetch_quota_for_token][google] POST `fetchAvailableModels` 和 `retrieveUserQuotaSummary`；[account::update_account_quota][google-write] 写 `accounts/<id>.json` | `quota.models[]` 的 `name/percentage/reset_time`，模型和汇总池分开；当前 desktop cache v2 | 已修缓存优先级、汇总池身份、独立时间与项目冲突；同邮箱必须唯一匹配 |
| `gemini` | 同上，原生额度读取使用同一个 `accounts` 池 | 同一 Google 生产证据的渠道别名 | 已核实；不是第二份可累计用量。`gemini_accounts.json` 仅保留历史兼容，无当前 producer 证据 |
| `antigravity_ide` | 同上，原生额度读取使用同一个 `accounts` 池 | 同一 Google 生产证据的渠道别名 | 已核实；不能把三个别名的额度或账号统计相加 |
| `github_copilot` | [github_copilot_oauth][copilot] GET `https://api.github.com/copilot_internal/user`；[account refresh][copilot-write] 写 `copilot_quota_snapshots` | `premium_models` 或 `premium_interactions` 的 `percent_remaining`；`unlimited`、entitlement 校验 | 已核实；已解析有限 premium 池。`copilot_limited_user_quotas` 的免费用户独立配额未在该展示层接入；不凭它猜有限分母或周期 |
| `kiro` | [kiro_oauth][kiro] GET `https://management.{region}.kiro.dev/Get-Usage-Limits`；[commit_refresh][kiro-write] 保存有效 payload | `credits_total/used`、`bonus_total/used`，prompt 与 add-on 分开；prompt `usage_reset_at` 秒 | 已核实；成功的 quota refresh 才更新 `usage_updated_at` 秒；token 刷新/账号使用时间不能当新观测；不把主池 reset 复制给 bonus |
| `windsurf` | [windsurf_oauth][windsurf] POST SeatManagementService `GetPlanStatus` / `GetUserStatus`；Devin、Auth1 路径在同模块归一化；[account][windsurf-write] 落盘 | `copilot_quota_snapshots.windsurfPlanStatus`、`windsurf_plan_status`、`quotaUsage`；日/周 remaining%，credits total/used | 已修真实结构、别名、隐藏池与 reset；日额度池可展示但当前窗口枚举保留 `unknown`，不冒充 5h；周窗口可证明 |
| `cursor` | [cursor_account][cursor] GET `https://cursor.com/api/usage-summary`，POST `https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo` | `cursor_usage_raw.individualUsage.plan`、`planInfo`；总/auto/api used%；explicit period；毫秒 reset | 已修 weekly/monthly 与重置时间；三个读数有包含关系，不相加；没有 period 不仅凭未来日期猜周/月 |
| `grok` | [grok_account::query_quota][grok] GET CLI billing `.../v1/billing?format=credits`，补充 CLI user / subscriptions / tasks；账号保存 `quota` 与 raw | `weeklyLimitPercent`、`weeklyUsed/Total`、`products[]`；统一计费不再展开旧 products 重复计算 | 已核实；`usage_updated_at` 毫秒。供应商 credits、prepaid、cap 不是采购或实付；没有分母的余额不转比例 |
| `zcode` | [zcode_account][zcode] GET `https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=...`；`apply_quota_payload`、`upsert_account` | 来源归一化 `quota_total/used/remaining`，`quota_reset_at` 秒，观测毫秒 | 已核实；只作来源额度比，API Key 无订阅额度；来源将 period_end/expiry 汇入边界，不额外断言固定周期 |
| `trae` | [Trae refresh][trae-refresh] POST v1 pay-status / entitlement-usage；统一 `trae_accounts` | 索引 `query_identity {version:1,platform:"trae"}`；raw credits / requests / legacy budgets | 已修平台分流与真实 pack 结构；未知身份版本明确错误，不默认国际版 |
| `trae_cn` | 同一 [refresh][trae-refresh] 优先 CN v2，支持 current-entitlement-list fallback | 同一物理目录，`query_identity.platform="trae_cn"` | 已修；不能读取虚构的 `trae_cn_accounts` 目录，也不能与国际版重复归属 |
| `trae_solo` | 同一 [平台解析与请求][trae-platform]；SOLO 平台身份参与上游路由选择 | 同一物理目录，`query_identity.platform="trae_solo"` | 已修；用明确身份分流，不从同邮箱或加密外壳猜平台 |
| `trae_solo_cn` | 同一 [CN 请求选择][trae-refresh] 和 [query_identity][trae-id] 写入 | 同一物理目录，`query_identity.platform="trae_solo_cn"` | 已修；四个渠道不复制同一整池账号；没有平台证据报告来源错误 |
| `codebuddy` | [codebuddy_oauth][buddy] POST `https://www.codebuddy.ai/v2/billing/meter/{get-dosage-notify,get-payment-type,get-user-resource}`；企业补充请求 | `quota_raw.userResource` / `usage_raw`；`Response.Data.Accounts[]`、资源的 precise cycle 分母/剩余 | 已修套层、精确字段和资源身份；额度 resourceSummary/套餐金额不重复作为第二个池或成本 |
| `codebuddy_cn` | [codebuddy_cn_oauth][buddy-cn] 对 `https://www.codebuddy.cn` 的对应请求及 `get-enterprise-user-usage`，企业结果归一化为 Accounts | 标准资源包与 enterprise `limitNum/credit`，包装后 `Cycle*Precise` | 已修；direct enterprise `credit` 是已用，不能按剩余解释；无限及缺失分母保留未知 |
| `workbuddy` | [workbuddy_oauth][workbuddy] + [buddy_resource_api][buddy-resource]：`https://copilot.tencent.com` 的 summary、paid/free packages，分页合并后落盘 | `data.resources[]`、独立 `resourceSummary`；`CapacityType=4` 使用当前请求日期第一条 `SlicePeriodUsageDetails` | 已修资源身份去重、日 slice 与有限周期字段；同资源不因 summary 再加一遍；过期不自动等于可重置 |
| `zed` | [zed_account::fetch_remote_bundle][zed] GET `https://cloud.zed.dev/client/users/me`；构建并保存 stored account | `user_raw.plan.usage.edit_predictions.used/limit` 和归一化 flat；旧 token-spend 有限预算保留兼容 | 已修当前 desktop 通道；不能凭浏览器 billing API 猜桌面可访问。当前 fetch 的 usage_raw 是空对象、观测时间可能为空；last_used 不补造观测时间 |
| `qoder` | [qoder_oauth][qoder] GET `https://openapi.qoder.sh/sash/api/v2/me/usage`；[qoder_account][qoder-write] 保存 raw 或本地导入 envelope | `auth_credit_usage_raw`：personal/hybrid 的 `qoderUsage`、base/add-on/shared 包；`percentage` 是已用 | 已修作用域和 raw 变体；enterprise envelope 不回退旧个人 scalar。企业池未进入个人额度展示；expiry/9999 sentinel 不当有效 reset |

## 关键通道的生产细节与修复依据

### Trae：平台身份和额度结构均有可核验证据

[models/trae.rs][trae-model] 的摘要 `from_account` 调用 [trae_account_identity::query_identity][trae-id]，输出 version 1、subject/email 及解析后的 platform。国际、CN、SOLO、SOLO CN 在 [platform_storage][trae-platform] 使用同一 `trae_accounts.json` 和 `trae_accounts`。因此“详情加密所以四个平台完全不能区分”的前轮结论不完整：当前明文摘要可以证明平台。旧明文导出仅在包含明确平台 metadata 时兼容；未知 version、冲突平台、完全缺证据都返回错误。

请求由 [refresh_quota_snapshot][trae-refresh] 选择 `/trae/api/v1/pay/ide_user_pay_status`、`ide_user_ent_usage`，CN 优先 v2 并可以回退 `user_current_entitlement_list`。`apply_entitlement_response`、`apply_usage_response` 保存 raw，而成功 usage 更新 `usage_updated_at` 秒。实际 pack 可能处在 `data`、`Result`、`result`、`payload` 等 wrapper，分母可能在 `entitlement_base_info.quota`、`subscription_extra` 或 `package_extra`。

本项目按 [官方 Trae 类型与聚合函数][trae-ui] 区分 credits 模式与 legacy 模式。credits 使用 `credits_limit/credits_amount`，不拿旧金额字段代替；legacy 分开 fast requests、basic 与 bonus。credits 模式的 pack 聚合规则与 legacy 的可见/活动过滤不同，不能共用一个“忽略隐藏 pack”的假设。每个 entitlement 保留独立池身份；已有明确结束秒按源规则 `end_time + 1` 得到边界。缺失 used、无限分母 `-1` 不制造 100% 剩余。

### Windsurf：PlanStatus、Devin aliases 和旧 credits

[windsurf_oauth][windsurf] 的 `get_plan_status`、`get_user_status`、`merge_plan_snapshot`、`build_payload` 把服务响应组合成 `copilot_quota_snapshots.windsurfPlanStatus` 与 `windsurf_plan_status`。Devin 流程另有 `quotaUsage`、camel/snake aliases；Auth1 protobuf 解码最终也输出明确日/周剩余值与 Unix reset。不能只读取旧 Copilot `premium_interactions` 就宣称 Windsurf 当前额度已覆盖。

读取器现覆盖这几条实际路径，遵从 `hideDailyQuota/hideWeeklyQuota`。日/周字段表示剩余；旧 credits 表示总额度与已用。[官方 Windsurf UI][windsurf-ui] 明确把 `availablePromptCredits` 作为总额兼容字段，并优先 `planInfo.monthlyPromptCredits`；旧实现若把 available 当剩余会反向显示。现在 prompt、add-on 分池，planEnd 的 protobuf seconds 单独转换。缺失 protobuf 字段不会按 UI 展示默认 0 伪造成真实观测。

### Buddy 系列：资源包不是任意数字对象

三端 OAuth 将请求结果交给 [codebuddy_account][buddy-write]、[codebuddy_cn_account][buddy-cn-write] 和 [workbuddy_account][workbuddy-write] 的 `apply_payload` / `refresh_account_token_once`，经 `upsert_account_record` / `save_account_file` 持久化 `quota_raw={dosage,payment,userResource}` 和 `usage_raw`。只有 usage 确实刷新成功才更新秒级 `usage_updated_at`；失败保留旧观测和 `quota_query_last_error`，本项目也不以 `last_used` 刷新旧值。[官方 parser][buddy-parser] 先识别 `Response.Data.Accounts`，再识别新 `resources`；精确 Cycle 字段优先于普通 Cycle、再优先于总 Capacity。资源 `Status=0/3` 表示当前/已用完的可展示状态，Unlimited 不代表有限满额。

[CN enterprise wrapper][buddy-cn] 将 `get-enterprise-user-usage` 的 limit 与 credit 已用值转成 Accounts；本项目也识别原始 direct enterprise 格式。WorkBuddy [buddy_resource_api][buddy-resource] 对 paid/free 分页，合并时按 `ResourceId` 去重，summary 作为旁路信息；本项目按相同身份读取，不能把 summary 加成另一份资源。`CapacityType=4` 的日切片使用请求日期对应的第一条详情，不能拿账户总体余额替代当日余额。

根据 [quota-model][buddy-quota-model]，`CycleResetTime` 可作为 reset；只有明确 CycleEnd 与有效期不同才按 cycle end + 1 秒解释下一周期。`ExpiredTime`/`DeductionEndTime` 只是有效期时不冒充刷新。数字时间沿用生产者 seconds/ms 分界；没有时区的日期文本无法在不同进程时区中证明同一时刻，读取器保留比例而将该 reset 留空。这是明确兼容限制，没有默认为 UTC。

### Zed 和 Qoder：当前请求作用域优先

[Zed fetch_remote_bundle][zed] 明确只调用 `/client/users/me`；`usage_raw`、`usage_tokens_raw` 和浏览器 subscription/preference 数据在该桌面 flow 中为空对象。当前 edit prediction 信息在 `user_raw.plan.usage.edit_predictions`，并映射到持久化 flat 字段。旧 UI billing 路径可能对合法桌面凭据返回 401，不能作为本项目补抓入口。当前 flow 未产生 `usage_cache_updated_at` 时，观测时间必须未知；账号 `last_used` 不是数据时间。旧 `token_spend_used_cents/limit_cents` 仅作为有限预算比例兼容。

[Qoder 当前请求][qoder] 的 `/sash/api/v2/me/usage` 与 [qoder_usage][qoder-scope] 共同定义作用域。导入代码可能保存 `{displayMode,qoderUsage,enterpriseUsage}`；hybrid 仅将个人子对象用于个人额度；enterprise 即使账号遗留 `credits_usage_percent` 也不能显示为当前个人额度。base、add-on、shared package 分开读取，percentage 按已用方向转换。只识别 resetAt，不从 expiresAt 或 year 9999 未设哨兵推导周期。

### Cursor：重置单位与周期独立

[cursor_account][cursor] 将 usage-summary 与 GetPlanInfo 合并后保存；[src/types/cursor.ts][cursor-ui] 将 numeric/numeric-string reset 按毫秒解释，亦支持带时区日期文本。`includedUsagePeriod` 的 weekly/枚举 2 与 monthly/枚举 1 是周期证据。weekly 使用 includedUsageResetsAt，monthly 使用 billingCycleEnd；只有日期没有 period 时保留未知周期。总、auto、API 百分比是不同视图，不能累加。

## Google：实际缓存 writer、项目范围与独立观测时间

当前真正写 cache 的是 [quota.rs::write_api_cache][google]，不是同名兼容模块中的空实现。该文件定义 `API_CACHE_VERSION=2`，并在 API 请求后调用 `write_api_cache("authorized", "desktop", ...)`。结果路径为 `cache/quota_api_v1_desktop/authorized/<sha256(normalized-email)>.json`，记录 `version/source/customSource/email/projectId/updatedAt/payload`。目录仍叫 v1 不等于 payload 仍只有 version 1。`updatedAt` 是毫秒；账号 `quota.last_updated` 是秒。

[quota_cache.rs][google-compat] 的 version 1 reader 与 no-op `write_quota_cache` 属于另一条兼容逻辑。仅看到它便断言当前上游不写 desktop cache 是错误的；本报告明确更正这一点。两个旧测试 fixture 曾写成 `source="desktop"`，本轮按实际 writer 改成 `source="authorized",customSource="desktop"`，保留原有所有数值和关联断言，没有放宽 source 校验。

当前处理规则：

1. 同邮箱缓存只有与唯一账号匹配时才用于该账号；已有身份冲突或重复邮箱不会给多个账号灌同一份额度。来源根身份继续由 v0.2.38 已建立的路径隔离保证。
2. 原生可用观测比缓存更新或相同时保留原生；没有观测时间的缓存不能压过有时间的原生。被消费但未采用的旧缓存不会再次以 synthetic account 复现。
3. 记录存在版本/来源字段时验证受支持版本与 authorized 来源。`projectId` 必须为 string/null；若缓存与可读账号两边都有项目事实，已知不相同（包括 null 对另一个项目）不得覆盖账号。
4. 源 `quota.models[]` 混有模型和汇总桶。按上游 `is_summary_bucket` 的确切集合（`3p-5h`、`claude:5h`、Gemini/argon 对应 5h 和 weekly 标识）识别 pool 与周期；一般模型名包含 weekly 不是证据。
5. [preserve_failed_summary][google] 会在项目/套餐一致时保留旧汇总池，并标记 `quota_summary_stale` 与旧 `quota_summary_updated_at`。模型 `last_updated` 新不代表汇总池新。本项目逐条保存不同的观测时间；汇总旧时间缺失则仍为空，不能套模型的新时间。
6. 新 cache 可能只有模型请求成功、没有汇总结果；此时继续显示上游显式保留的旧汇总池，但标记 stale/sourceError，不伪造当前观测，也不把旧池悄悄丢掉。

有一个不能由源码读取器补造的边界：明文 `accounts.json` 摘要没有 project_id，而详情可能加密。已知项目冲突可以拒绝；只有邮箱可见时，唯一邮箱关联仍不能证明更细的 workspace/project 生命周期。本报告不把唯一邮箱匹配写成完整的项目或历史账单所有权证明。

## quota_history 与 gemini_accounts：保留兼容，取消错误权威性

在固定上游实际编译模块、模型、服务、界面类型及仓库文件名中，没有找到当前生产者写 `cache/quota_history`、plugin quota cache 或 `gemini_accounts.json` 的证据。Codex 的 team quota history 是另一个内部契约，不能当成 Google 同名目录的 producer。未删除用户历史文件或现有兼容读取。

旧 `cockpitQuotaToAccountUsage` 使用 Codex 统计账号按邮箱接 Google 历史，并可把旧的 0% 直接变成当前账号 `rate_limited`。本轮改成：只用显式 `antigravity/gemini` 平台 metadata；同邮箱必须唯一候选账号且唯一历史文件；sourceInstanceId 继续进入本地账号 ID；仅接受有效点的 0–100 剩余值及有效原始时间；按时间取最新而非数组末位；文件读取时间或文件总体时间不能覆盖观测点时间。

这类结果仅标记 passive/recorded 历史，来源状态为 partial；不会给 Codex 账号补造额度，也不会认定当前请求受限或作为实际采购。当前官方 Google 池仍从 accounts 进入；不能为三个渠道别名重复造账户。

## 错误传播：不再用空数组伪装成功

旧前端 `getQuotaChannels`、`getQuotaSnapshots`、`refreshQuotaSnapshots`（以及尚无消费者的 `getQuotaHistory`）把原生 Err 转换成 `[]/null`。这使 Trae 未知 identity version、坏来源文件或权限错误表现为成功的空表。现在原样抛给 `useChannelQuota`：先核对来源身份；同源读取失败保留旧快照，逐行标记 `stale=true` 和 `sourceError`，并设置 error/liveError；换源或无法证明来源一致时清空旧内容。

保留时不改变剩余比例、`updatedAtMs` 或 `fetchedAtMs`。整批报错而不是伪装健康渠道全部成功是本次的最小方案；没有新增原生 partial-summary schema。再次成功读取会由新批次替换旧状态。

实际历史消费者使用的是 `src/api/cockpit/index.ts::getCockpitQuotaHistories`。该函数现在将目录失败、坏 JSON、必需字段错型抛给 CostCenterView 已有的来源错误处理；真正缺失的目录仍由原生成功返回空数组。坏文件不会在静默跳过后产生“完整读取成功”的错觉。该修改没有新增历史写入，也没有删除旧文件。

## 反例、回归与可重复证据

所有 fixture 均由上述固定生产形状构造，使用 `example.invalid` 等非真实账号，未调用真实供应商接口。冻结旧生产源码只注入新测试和测试模块注册；没有替换旧生产逻辑。Rust headless 去除 Tauri command 宏的适配与主项目已有 headless 方法一致；锁版本校验、隔离 HOME/来源环境以及 package 清理防止旧二进制误复用。

| 验证组 | v0.2.38 旧实现实际结果 | 当前候选实际结果 |
|---|---|---|
| 34 条 supplemental_contract：Trae、Windsurf、Buddy、Zed、Qoder、Cursor、cache 优先级 | 29 个断言失败、5 个正向通过 | 全部通过，包含于下方原生 117 项 |
| 9 条 supplemental_google：汇总池/独立时间、v2、项目/版本/来源、保留失败汇总 | 8 个断言失败、1 个正向通过 | 全部通过，包含于原生 117 项 |
| 4 条 targeted history regression | 4 个断言失败；同文件另外 4 条未被该过滤器选择 | history 文件全部 8 项通过，包含于前端 95 项 |
| 12 条真实 API wrapper→hook/history 错误契约 | 11 个断言失败、1 个空目录/合法记录正向通过 | 12 项全部通过，包含于前端 95 项 |
| Cockpit 原生模块专项 | 不作为同范围旧版总通过率比较 | **117 passed，0 failed，4 原有本机数据依赖 ignored** |
| 6 个相关前端文件专项 | 不混入旧报告历史数量 | **95 passed，0 failed** |

新增 Rust 测试位于 `src-tauri/src/cockpit_quota_supplemental_tests.rs`；前端为 `cockpitHistoryContract.spec.ts`、`quotaReadErrors.spec.ts`，并保留更新后的已有正向断言。没有增加 skip、削弱核心数值/时间/身份断言或把编译失败算成红灯反例。已有四个本机来源测试依旧 ignored，不声称在合成测试环境访问了真实设备。

本轮保存的机器日志（工作环境 `cockpit-audit-evidence/`）：`quota-supplemental-before.log`、`quota-google-before.log`、`quota-supplemental-after.log`、`quota-history-frontend-before.log`、`quota-history-frontend-after.log`、`quota-errors-frontend-before.log`、`quota-errors-frontend-after.log`。其中历史早一轮 24 项前端通过日志为子集，最终相关 6 文件 95 项日志为 `quota-errors-frontend-after.log`。相关前端文件 ESLint 检查通过；全仓构建、全量类型检查和三平台发布门禁由发布流程独立记录，不能由本专项数量替代。

## 尚未提供的能力与证据

- 整体加密账号中缺乏可读配额时，仍显示不可得；未破解或导出凭据。
- Copilot 免费用户独立 quota、Qoder 企业组织池、无当前 producer 的 legacy/plugin 历史，不被冒充为已完整支持的个人额度。
- 缺分母、无限额度、无观测时间、未证明的周期或无时区 reset 保留未知；真实 0% 仍是有效观测。
- 邮箱、固定存储 ID、目录身份能够限定部分归属，但不自动证明同一目录内 provider/project 历史生命周期，更不证明付款记录。
- 本轮只改变读取和展示契约，不把供应商预算金额、额度余额或上游估值改造成自有成本算法输入的实付款证据。

[upstream]: https://github.com/jlcodes99/cockpit-tools/commit/820e176842d440a60e650729c3a39932b76a0ccb
[storage]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/secure_account_storage.rs
[codex-quota]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/codex_quota.rs
[codex-write]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/codex_account_mutations_quota.rs
[claude-auth]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/claude_account_desktop_auth.rs
[google]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/quota.rs
[google-write]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/account.rs
[google-compat]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/quota_cache.rs
[copilot]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/github_copilot_oauth.rs
[copilot-write]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/github_copilot_account.rs
[kiro]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/kiro_oauth.rs
[kiro-write]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/kiro_account.rs
[windsurf]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/windsurf_oauth.rs
[windsurf-write]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/windsurf_account.rs
[windsurf-ui]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src/types/windsurf.ts
[cursor]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/cursor_account.rs
[cursor-ui]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src/types/cursor.ts
[grok]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/grok_account.rs
[zcode]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/zcode_account.rs
[trae-model]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/models/trae.rs
[trae-id]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/trae_account_identity.rs
[trae-platform]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/trae_account_platform_storage.rs
[trae-refresh]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/trae_account_token_injection.rs
[trae-ui]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src/types/trae.ts
[buddy]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/codebuddy_oauth.rs
[buddy-cn]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/codebuddy_cn_oauth.rs
[workbuddy]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/workbuddy_oauth.rs
[buddy-resource]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/buddy_resource_api.rs
[buddy-parser]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src/utils/codebuddy-suite/parser.ts
[buddy-quota-model]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src/utils/codebuddy-suite/quota-model.ts
[zed]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/zed_account.rs
[qoder]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/qoder_oauth.rs
[qoder-write]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/qoder_account.rs
[qoder-scope]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/qoder_usage.rs

[buddy-write]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/codebuddy_account.rs
[buddy-cn-write]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/codebuddy_cn_account.rs
[workbuddy-write]: https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/workbuddy_account.rs
