# Cockpit 数据通道源码契约核验（2026-11-07）

> v0.2.39 补充核验见 [Cockpit 20 渠道配额生产通道](cockpit-quota-production-contract-2026-11-07.md)。新报告继续追到生产请求、账号写入和官方解析，替代本文有关 Trae 明文平台不可分、部分 raw 通道未接入的旧限制；本文 v0.2.38 的测试统计保留为历史记录。

## 结论与范围

本次核验比较的是 `usage-ledger` 的读取、归属、聚合与展示契约，以及公开上游的实际生产源码。发现并修复了数据目录漂移、缓存单价 NULL 被当作 0、单价版本串组、SQLite 非法数值被吞掉、加密账号与明文索引未关联、同邮箱额度重复归属、部分真实额度结构未被读取、额度单位与时间单位不符等问题。

**本项目的成本算法、手工采购价和倍率仍由本项目持有。** 上游请求计数、Token、源单价、额度快照分别是输入事实；上游 `estimated_cost_usd` 是来源估值，不能冒充本地采购成本、实付款、余额或官方账单。缺少本地价格时原有带 `source_estimate` 标识的回退仍保留，本次没有把来源估值改成独立计价，也没有用它覆盖手工价格。

没有访问用户真实设备的运行库、账号凭据、支付记录或供应商账单。因此不能把“固定源码和合成反例通过”表述为“用户所有真实账目已经对平”，也不能保证未提供的私有分支与该公开版本完全一致。

### 固定来源

- 官方公开仓库：[jlcodes99/cockpit-tools](https://github.com/jlcodes99/cockpit-tools)。
- 核验提交：[820e176842d440a60e650729c3a39932b76a0ccb](https://github.com/jlcodes99/cockpit-tools/commit/820e176842d440a60e650729c3a39932b76a0ccb)。
- 应用修改前基线：`9holy/usage-ledger@d21bb208672587d77f100e39dd8f33435040da83`。
- 以下路径均相对于固定上游仓库。`data_paths.rs` 的真实路径是仓库根下的 `crates/cockpit-core/src/modules/data_paths.rs`；桌面 `src-tauri/src/modules/mod.rs` 显式导入该文件。其他本文引用的桌面生产模块以 `src-tauri/src/` 下实际编译版本为准。

## 主数据通道矩阵

| 输入通道 | 固定源码 / 字段 | usage-ledger 接入点 | 核验后的语义与限制 |
|---|---|---|---|
| 数据目录 | [`data_paths.rs`](https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/crates/cockpit-core/src/modules/data_paths.rs)：`COCKPIT_TOOLS_DATA_DIR`、`COCKPIT_TOOLS_PROFILE`、新旧目录选择 | `cockpit_data_path.rs`；文件、SQLite、额度、监控共用 | 不再只认旧 `.antigravity_cockpit`；不混读两套账号；不迁移、创建或重写来源目录 |
| 网关逐事件用量 | [`codex_local_access_request_logs.rs`](https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/codex_local_access_request_logs.rs)：`request_logs`，数值 `id`，唯一 `event_key`，毫秒 `timestamp`，账号/模型/API Key/Token/服务档位 | `cockpit_logs_db::{summarize,facets}`；持久账本摄取另有自己的增量边界 | 按实际事件行计数；模型×账号×Key×档位保留粒度；来源缺失与损坏不显示为正常零用量 |
| 本地会话用量 | [`codex_session_usage.rs`](https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/codex_session_usage.rs)：`session_usage_events`；秒 `timestamp`、`model`、`cached_input_tokens`、`session_id`、`instance_id`、`file_path` | `ledger_ingest` / `usage_monitor` | 不是网关请求表的同一契约；没有账号、成功、延迟、价格列，不能从当前账号或目录名补造历史归属 |
| 聚合 JSON | [`codex_local_access_request_logs.rs`](https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/codex_local_access_request_logs.rs) 与 `codex_local_access_window_stats.rs`：累计与日历窗口统计 | `src/api/cockpit/index.ts`、`cockpitAdapter.ts` | 仅作为已有聚合快照或明确回退；不能由它重建任意滚动窗口的逐请求上下文分档，也不能再与同一批 SQLite 用量相加 |
| 源价目快照 | 同一请求表 `input_usd_per_million`、`output_usd_per_million`、可空 `cached_input_usd_per_million`、`model_pricing_version` | `facets.ts`、`priceReconcile.ts` | 只用于源价目核对；NULL 保持未知，显式 0 保持 0；版本号只归入实际使用该价格的行组 |
| 请求身份与诊断 | [`codex_local_access_request_diagnostics.rs`](https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/codex_local_access_request_diagnostics.rs)、`codex_local_access_request_identity.rs` | 监控的请求级账号解析 | 记录网关 `request_id`、捕获状态、客户端 session/thread/install/ChatGPT account 字段；不能把它直接等同于 Responses `response_id` |
| 账号索引和详情 | [`models/account.rs`](https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/models/account.rs)、`models/codex.rs`、[`secure_account_storage.rs`](https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/secure_account_storage.rs) | `ChannelAccounts::load`、账号 metadata API | 索引明文，详情可以整体 AES-GCM 加密；从索引读取可证的 id/email/name/plan，不能把密文里的缺字段当空账号或无额度 |
| Google 桌面额度缓存 | [`quota_cache.rs`](https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/quota_cache.rs)、`quota.rs`：邮箱、毫秒 `updatedAt`、`payload` | `cockpit_quota::SnapshotProvider` | 邮箱匹配必须唯一；文件名哈希不是账号 UUID；缓存读取时刻不能刷新观测时刻 |
| Google 原生额度详情 | [`models/quota.rs`](https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/models/quota.rs)：`models: Vec<ModelQuota>`，`name`、`percentage`、`reset_time`，秒 `last_updated` | 原生 Google 额度分支 | 数组与桌面 payload 的模型字典分别读取；`percentage` 已是剩余，0 是可用事实；没有 reset 不编造周期 |
| 本地成本与账目 | 本项目自有成本档案、财务事件与 SQLite 汇总库 | 本项目成本算法、`finance_ledger`、`ledger_*` | 来源额度和上游估值不构成采购/付款证据；不同 Cockpit 数据根必须具有独立实例身份，见后文 |

## 数据目录、身份及增量边界

目录规则经源码逐项核对：非空显式目录优先；`dev` profile 使用开发目录；生产默认 `.cockpit_tools`、旧目录 `.antigravity_cockpit`；开发目录相应带 `_dev`。新旧两目录独立并存时，上游保留旧库优先；新目录只是旧目录的路径别名时返回新名称。旧条目损坏或不是可用目录会报错，不能悄悄换成另一个账号池。

本项目的独立读取器有一项明确的限制：**拒绝相对 `COCKPIT_TOOLS_DATA_DIR`**，提示改成绝对路径。上游把相对值解释为其进程工作目录；本项目无法证明与生产者具有相同工作目录。此限制用于避免选错数据源，不宣称完全镜像上游的相对路径行为。显式选择不存在的绝对目录也不会回退默认库。

`request_logs` 的 `event_key` 由时间、请求 ID、账号/邮箱/Key、模型、网关模式、请求种类、成功/错误、延迟与 Token 等组成，不是一个跨来源的全局请求 ID。`session_usage_events` 则用 `REQUEST_ID_PREFIX:root_thread_id:event_index` 作为文本主键，写入使用 `INSERT OR IGNORE`。会话事件和网关事件是否重叠，必须由具体事件身份与来源覆盖规则证明；不能因为模型、Token、同秒时间相同就删除一条。

固定版本的请求表和诊断表没有第一类 `response_id` 列。诊断 `attempts_json` 里的 `upstreamRequestId` 也不能自动视为 Responses 响应 ID。运行时捕获和可选 `payloads_json` 中可能出现响应对象，但捕获可能关闭、截断或清除，不能作为普遍存在的稳定归属接口。会话/客户端线程 ID 只证明关联线索，不能据此替任意历史请求认领账号。

### 跨数据根的财务与历史隔离

这不是仅理论上的 UUID 碰撞：上游 [`codex_account_provider.rs::build_api_key_account_id`](https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/codex_account_provider.rs) 生成 `codex_apikey_ + md5(api_key)`，不含 provider、base URL 或数据根。[`codex_account_token_refresh.rs::build_account_storage_id`](https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/codex_account_token_refresh.rs) 的 OAuth ID 来自邮箱及可用的 account/org 身份，也不包含数据根。相同凭据/身份放在两个独立目录中会正常地产生相同来源 ID。

基线的成本档案和 JSON 历史台账使用固定控制台目录；财务 `instanceId` 固定为 `local`；SQLite 摄取状态按 `source_name` 保存，来源指纹只含最小 ID 和首行事件键，写入的 `source_path` 未参与隔离。这些设计在引入显式目录后会把不同来源的历史、手工金额或检查点混在同一个身份空间。

本轮已统一修复目录派生的稳定来源身份、前端账号/财务命名空间、本地历史 JSON 与持久摄取库。只有固定的历史 legacy 物理根兼容 local，独立 modern/dev/custom 根分开；官方现代路径指向原 legacy 的别名仍是同一来源。后台摄取在构造来源时捕获物理根与身份，日志库、会话库和目的账本使用同一上下文；默认根或别名随后变化不能让已捕获的 A 源写入 B 账本。旧的全局金额与历史只能留在有证据的兼容作用域，不能自动认领到另一个物理根。此修改不改变财务金额、全局成本档案格式或成本算法。

同一目录中的生命周期仍是另一条边界：[`codex_account_mutations_quota.rs::update_api_key_credentials`](https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/codex_account_mutations_quota.rs) 编辑 base URL/provider 时仍仅用 API Key 生成 `new_id`。Key 文本不变，存储 ID 就不变。因此“同一来源根 + 同一 raw ID”是稳定存储键，并不能单独证明历史上始终属于同一服务商、工作区或采购生命周期。目录隔离不会凭空补出上游未保存的历史身份事实，也不能据此宣称历史所有者或账单已全部核实。

## Token、源单价及时间窗口

- 缓存命中 Token 是输入 Token 的子集。现有 `normal = input - min(cached,input)` 分拆保留，不把 cache 再加到输入总量上；已核对的请求契约并未提供可直接作为额外费用的独立 cache-write 计数。
- reasoning Token 属于输出的细分观测，不能再作为一份输出费用重复累加。可选字段缺失由已有 `missingColumns` 与前端 nullable 值显示未知。
- 长上下文按逐请求输入量分拆，并保留实际上下文范围供本项目目录报价使用。源价目核对不能拿“同模型两组单价”直接推断调价；长文与标准档本就可能不同。
- `cached_input_usd_per_million` 在当前官方 SQLite schema 中允许 NULL。旧实现把 NULL 当 0，并且把 NULL 与显式免费缓存价归为一组；本次已保留二者区别。缺少缓存源价时，核对结果不显示“已完全匹配”或以这个空值制造一次调价。没有可比较模型时，总结明确显示暂无可比较模型，不再显示“价目一致：0 个模型”；显式记录的零缓存价仍参与比较。
- 每个价格组合的 `pricingVersions` 现在来自该组自己的行；前端模型级版本列表合并所有组。旧实现把同模型所有版本复制给每组，前端又只取第一组版本，两个方向都会失真。
- SQLite 读取不再把坏类型、负 Token、非 0/1 成功标志或无法精确交给 JavaScript 的整数吞成 0。单行和汇总均验证非负、有限及安全整数范围，错误返回来源错误。
- 请求查询窗口是调用方给定毫秒边界的闭区间；桶按固定小时宽度划分。上游日/周/月快照是自己的日历窗口，不能将两种范围当成天然相同。
- 原生网关 `service_tier` 可来自响应值或回退到请求值；上游还分别保存 requested/response 字段，并明确 OAuth 回显不能证实调度。报价应继续保留请求条件或未知条件，不能把字段回显称作已确认的实付档位。

## 额度：20 个渠道逐项列明

下表的“核实”只指对应源码字段与本项目展示契约。详情被加密、来源没有字段、无法确定分母或观测时间时，仍显示未知。额度快照不是请求用量，池之间也不能按次数或百分比求和。

| 渠道 | 官方存储/字段 | 百分比、时间、归属处理 | 当前边界 |
|---|---|---|---|
| `codex` | `codex_accounts`；`CodexQuota.hourly_* / weekly_*` | 已修：扁平剩余百分比；reset/usage 时间为秒；presence=false 的 100 是哨兵；300/10080 分钟才标五小时/周 | 无明确 presence 或 raw-window 证据，不补造窗口；加密详情未知 |
| `gemini` | Google 共用 `accounts`、桌面缓存、`QuotaData.models[]` | 已修：明文索引映射、模型数组、剩余百分比与 last_updated 秒 | 同一账号目录的同一快照不得与另外两个 Google 名称重复累计 |
| `antigravity` | 同上 | 同上 | `gemini_accounts.json` 仅保留历史兼容扩展入口；不能把官方 `accounts.json` 复制成第二套账号 |
| `antigravity_ide` | 同上 | 同上 | 别名合并需同目录且快照一致；不扩大账号数 |
| `claude_manager` | `claude_accounts`；`claude_usage_raw`、`ClaudeQuota` | 已修：OAuth direct、桌面 endpoints 包装、当前 limits[]、原生 flat；已用百分比只翻转一次；ISO/秒 reset；usage_updated_at 毫秒 | 桌面小于 1 的 fraction 与 OAuth 百分数分开；无观测证据的 flat 默认 0 不是已用 0；extra_usage 金额字段不作为采购支出 |
| `cursor` | `cursor_accounts`；`cursor_usage_raw` 的 individualUsage/planUsage 及 snake_case 兼容 | 已修：total/auto/api 已用百分比与明确 used/limit 分母；usage_updated_at 秒 | 三个观测可以重叠，不求和；缺组件保持未知；未证实 reset 单位时不编造日期 |
| `kiro` | `kiro_accounts`；credits/bonus total、used | 已修：主额度与附加额度分别保留分母；usage/reset 秒 | 缺 used 或有效 total 不默认免费额度；附加池不套主池 reset |
| `trae` | `trae_accounts`；`trae_entitlement_raw` / `trae_usage_raw` | 已核对存储与原始字段；仅消费明确支持的百分比结构 | 原始 payload 未提供明确受支持百分比时未知；不把原始金额、请求次数猜成百分数 |
| `trae_cn` | 官方与其他 Trae 平台共享 `trae_accounts` | 不把同一目录复制为第二批额度账号 | 当前无可证拆分时由 Trae 汇总承载；独立分平台值未知 |
| `trae_solo` | 同上 | 同上 | 同上 |
| `trae_solo_cn` | 同上 | 同上 | 同上 |
| `windsurf` | `windsurf_accounts`；Copilot 快照或 plan status | 已修支持的 premium 快照百分比单位；usage_updated_at 秒 | 未被证明的 plan status 原始结构保持未知；不限量不冒充一次有限 100% 观测 |
| `grok` | `grok_accounts`；camelCase `GrokQuota` 与 products | 已修：weeklyLimitPercent 实为已用；credit 与 product 池保留；unified billing 不再复制 product 池；usage_updated_at 毫秒 | prepaidBalance 不进入额度百分比/采购成本；未捕获分母不能反推 |
| `codebuddy` | `codebuddy_accounts`；quota_raw / usage_raw | 已核对存储和原始字段，消费已支持的显式百分比形状 | opaque 或缺字段 payload 保持未知，不猜接口金额 |
| `codebuddy_cn` | `codebuddy_cn_accounts`；quota_raw / usage_raw | 同上 | 同上 |
| `workbuddy` | `workbuddy_accounts`；quota_raw / usage_raw | 同上 | 同上 |
| `qoder` | `qoder_accounts`；credits_usage_percent | 已修：数值标量直接读取，已用→剩余；usage_updated_at 秒 | 未给标量且 raw 结构不支持时未知，不把 credits 余额当美元 |
| `github-copilot` | `github_copilot_accounts`；premium_models / premium_interactions | 已修：优先当前别名、`percent_remaining` 是百分数、`remaining` 是绝对次数；usage_updated_at 秒 | 没有百分比不把绝对次数直接显示为百分数；limited-user 分母需凭据派生，本读取器不读取凭据去造分母 |
| `zed` | `zed_accounts`；usage_raw / usage_tokens_raw | 已核对原始存储字段，仅消费可识别且单位明确的百分比 | spending_limit_cents、Token 原始值不直接视作额度百分比或实际付款；未支持 raw 结构未知 |
| `zcode` | `zcode_accounts`；quota_total / quota_remaining / quota_reset_at | 已修：remaining/total；reset 秒；usage_updated_at 毫秒 | total 无效则未知；额度单位不变成财务美元 |

上述 provider 依据包括 [`models/codex.rs`](https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/models/codex.rs)、[`codex_quota.rs`](https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/codex_quota.rs)、[`claude_account_desktop_auth.rs`](https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/claude_account_desktop_auth.rs)、[`cursor_account.rs`](https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/cursor_account.rs)、[`kiro_account.rs`](https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/kiro_account.rs)、[`github_copilot_account.rs`](https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/github_copilot_account.rs)、[`grok_account_quota.rs`](https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/grok_account_quota.rs)、[`grok_account.rs`](https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/grok_account.rs)、[`qoder_account.rs`](https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/qoder_account.rs)、[`zcode_account.rs`](https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/zcode_account.rs) 及对应 `models/*.rs`。

### 账号与额度关联的保守边界

当前索引存在时以索引成员为准，不从删除后遗留的详情文件复活一个账号；缺失索引的历史格式仍允许扫描详情。索引/详情损坏、类型错误、重复 ID、索引与详情邮箱冲突、已登记详情缺失均返回来源错误。对明文索引可证身份的加密详情，保留该账号 ID 与显示信息；不解密凭据。

Google 桌面缓存按 email 命名/归档，不包含足以区分同邮箱多个工作区的唯一账号 ID。因此只有一条缓存与一个当前账号唯一匹配时才关联；多账号同邮箱不把一次额度复制给多个账号。无法关联的缓存保持其来源记录身份，不能作为该账号已完成历史归属的证据。已有百分比但没有观测时间时，读取时间也不会顶替观测时间。

缓存层现在将文件读失败/坏 JSON 作为来源错误；有旧缓存时保留旧内容和原读取时刻，并标注刷新失败，不用“本次读缓存成功”刷新其年龄。`remainingFraction` 固定以 0..1 解释，超界被拒绝，不能换猜成 0..100 百分数。

`cache/quota_history` 与部分扩展 payload 保留兼容读取。本次固定公开版本的已检查生产模块未找到该历史目录的稳定写入契约，故未将它作为所有当前官方账号都存在的权威账单接口；这些采样也不能换算已消费 Token 或实付金额。

## 反例与验证证据

新增反例都使用上述实际生产字段形状以及隔离的合成目录/SQLite，未读取真实账号。旧实现的红灯证明来自运行断言，**不把编译错误或 0 个测试算作反例成立**。

| 套件 | 冻结旧实现结果 | 修复后结果 |
|---|---|---|
| `cockpit_logs_db_contract_tests.rs` 初始 10 例 | 9 失败、1 旧目录优先兼容控制通过 | 修复后 12/12 通过（含新增相对目录拒绝与当前别名选择控制，主线原生候选验证） |
| `priceReconcile.spec.ts` 初始新增 2 例 | 2 失败、原有 21 通过 | 与 `src/api/cockpit/__tests__/facets.spec.ts` 合跑，55/55 通过（另含 NULL 混合组、零缓存价可比较、无可比较模型不显示通过） |
| `cockpit_quota_contract_tests.rs` 24 例 | 23 失败、1 OAuth 原百分数兼容控制通过 | 主线统一 native 验证中 24/24 通过；不代表用户设备上的真实账号已逐笔对账 |

最终冻结候选的原生业务全量回归为 **560 通过、0 失败、21 个原有 ignored**（`data-channel-native-final.log`）。默认根动态选择及摄取途中切根的两条终审反例在修复前候选上均实际失败，修复后纳入该全量通过；它们分别保证不重用另一物理根的 local 身份，以及已捕获的 A 源只写入 A 的持久库。

本轮工作区证据：`cockpit-audit-evidence/native-before.log`、`frontend-before.log`、`frontend-summary-before.log`、`frontend-after.log`、`quota-native-before.log`。原生旧快照分别保留在 `cockpit-contract-baseline` 和 `cockpit-quota-contract-baseline`。定向命令使用 `corepack pnpm`（9.15.9）；原生共享 Cargo 时段由主线统一安排。Rust 文件已通过不写盘的 rustfmt 语法解析检查；这不替代编译与运行测试。

测试环境必须隔离 `HOME`、`USERPROFILE`、`COCKPIT_TOOLS_DATA_DIR`、`COCKPIT_TOOLS_PROFILE`。尤其旧的文件写入白名单测试，即使 HOME 被改为临时目录，显式来源覆盖也可能胜过它；本轮已在对应写入用例及额度夹具中显式清除覆盖，主线运行器同时隔离这些环境变量。

## 本专项修改边界

直接修改包括公共目录读取器、Cockpit SQLite 聚合/facets、额度读取器、nullable 源价目类型与核对，以及相应反例。主线另外负责源实例身份、成本/财务命名空间、用量监控、多开实例 camelCase 注册表、持久账本保护与增量规则；对应最终集成和全量结果以本次统一审计报告为准。

未将源码审计包装为用户账户余额、历史支付、充值或扣费已被外部账单确认。真实对账仍需要用户选中的数据目录、时间范围及供应商结算依据三者一致。


## 前端实例与账本闭环补充

### 上游身份限制

官方 [`codex_account_provider.rs:470-472`](https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/codex_account_provider.rs#L470-L472) 仅用 API Key 字节的 MD5 生成 `codex_apikey_*`，没有数据根、base URL 或 provider。创建时 provider 配置另行解析（[`codex_account_lifecycle.rs:206-217`](https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/codex_account_lifecycle.rs#L206-L217)），编辑 base URL 时 ID 仍只由 Key 生成（[`codex_account_mutations_quota.rs:480-515`](https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/codex_account_mutations_quota.rs#L480-L515)）。因此“两个目录中同 raw ID”是确定的串账反例，不是抽象风险。

本次用 native 的 `get_cockpit_source_identity` 返回值约束读取批次。只有历史默认 legacy 物理根兼容 `local`，保留既有档案 ID；独立 modern、dev、custom 根均使用 `cockpit:<摘要>`，指向同一 legacy 物理根的规范路径别名仍归 `local`。不会因为现代默认目录出现或消失而让另一个物理根认领旧账本，也不向远程发送真实本机路径。此变更证明的是实例范围隔离，**不证明同目录同 Key 改 base URL 前后的 owner/provider 生命周期**；缺少历史归属字段时不移动、删除或猜测旧档案。

| 消费点 | 原问题 | 修复后契约 |
| --- | --- | --- |
| 账号与历史 email 账号 | ID 只有 `cockpit:<raw>`，跨目录碰撞 | 历史默认 legacy ID 兼容；其他物理根为 `cockpit:instance:<encoded instance>:<encoded raw>`，历史 email 身份同样带实例 |
| 成本档案与财务范围 | 全局档案 map/finance scope 将不同目录当 `local` | 档案按完整 scoped account ID 读取/保存；`financeInstanceId` 与 `rangeAccountStatsScope` 使用本批 native identity；身份读取失败为 `unavailable` |
| 请求、配额、模型过滤、路由 | raw ID join 可把另一目录的行接入当前账号 | adapter 明确接收同一 sourceInstanceId；主窗口和独立模型窗口一致，保留原始请求、token、成本、零值与空值语义 |
| Unified 窗口 | 来源固定 `cockpit:local:request_logs`；旧元数据可复用到新目录 | summary 使用实际实例；注入 metadata 必须声明且匹配该实例；读取前后核对 identity，变化则整批 unavailable |
| Unified 累计账号成本 | 同 raw ID 的旧视图累计 map 可套到新目录 stats | 累计成本 ref 同时携带其 source identity，仅同源时使用；新源的真实窗口合计不受旧 map 影响 |
| 渠道配额缓存 | 全会话缓存只有 raw account ID，换目录仍可合并旧值 | composable 保存 snapshot source；换源清缓存和待返回结果；视图只合并同源快照；点击实时刷新前先核对来源，换源时不向新实例发送旧操作 |
| facets / 当前账号元数据 / 多源对账 | 旧异步请求可在新来源标签下落地 | 每批前后验证来源，并以批次序号及当前 source 拒绝过期结果；清理来源时失效 pending 结果 |
| 本项目 JSON 用量台账 | 读取异常、无效 JSON 被当 null，随后可能写入“新空账本” | native 缺文件专用返回 JSON `null`；合法空表仍是 `{accounts:[]}`；读取、JSON 形状、账户行错误抛出，保留原文件并跳过 merge/write |
| 持久写回 | 全部读取结束前已经写账本，目录切换可能混入另一源 | 主批次关闭身份检查发生于写前；`write_cost_ledger` 收到 expectedSourceInstanceId，native 检查并从同一 captured identity 选择目的地；不匹配拒绝写入 |

这些修改只限制数据归属与可用性，不修改本项目的价格、倍率、采购、损耗或成本纯算法。首次无文件、确知空文件、真实零成本/零额度、未知值、历史档案与历史默认 legacy 目录 ID 保持分开。

### 前端反例与验证

- 未修复实现：`cockpitSourceIsolation.spec.ts` 与 `sourceLedgerContract.spec.ts` 共 **9 失败 / 1 通过**，覆盖跨目录同 Key、档案及 scope、跨源 metadata、批次中换根、读取错误和坏 JSON。
- 配额补充反例：**2 失败**，分别证明换根后旧快照/实时刷新通道仍可复用、渠道与快照读取之间换根未被拒绝。后续修复保留同源确知 0% 断言。
- 累计成本补充反例：**1 失败**，新目录窗口与账号 stats 已读取，旧目录同 raw ID 累计成本 99 仍被标为本项目实测。修复后同源 99 保留，新源不使用旧 map，真实窗口成本仍保留。
- 账本行形状补充反例：**2 失败 / 4 通过**，`accounts:[{}]` 与 `usage:null` 不能进入可重写状态；另补空字符串文件不得被当首次缺失的反例。
- 修复后定向验证：9 文件 **182 项通过**（账号/路由/模型/财务档案/配额/未知值与老消费端）；另 8 文件 **105 项通过**（Unified、CPA 同用模块、视图接线与模型目录）。收尾的 4 文件 **65 项通过** 包含新增空文件/无账户字段对象反例。CostCenterView 的 Vue SFC 解析与 script 编译通过。

旧 `useUnifiedCost.spec.ts` 仅补 native identity mock 及 metadata/累计 map 的同源证据，保留原金额、下界、未知、零、日期、并发及复用断言。所有反例使用合成 fixture；没有读取真实用户账本，也没有触发真实上游配额刷新。
