# 用量监控接口与官方 Codex 额度契约补齐核验

## 核验对象与固定版本

本次从 `v0.2.38` / `be0318c0a6caf93c62d810774cf3a06e46bfbf30` 继续，补齐此前未完整消费的官方 HTTP 额度字段、额外额度池、非整分钟窗口，以及已经注册的六条监控读取通路。候选发布版本为 `0.2.39`。

对应官方生产者固定为 [`openai/codex@efdacaf46ff54660a239189a6d62434c5db33d2c`](https://github.com/openai/codex/tree/efdacaf46ff54660a239189a6d62434c5db33d2c)。核验使用该提交的实际 OpenAPI 模型、HTTP 客户端转换和本地日志协议，未用自行假设的 JSON 替代生产者契约。

本报告中的“已核实”指生产者源码、请求参数、保存与迁移、读取类型、账号/时间/错误范围及页面消费者已经逐项对照，确认缺口有反例及修复。它不表示已经把用户未提供的生产账号账单逐笔与服务商清单核销。这个区别不影响本次继续完成源码通路核验。

### 上游证据索引

| 标识 | 固定提交中的源码 | 证据 |
| --- | --- | --- |
| U1 | [rate_limit_status_payload.rs](https://github.com/openai/codex/blob/efdacaf46ff54660a239189a6d62434c5db33d2c/codex-rs/codex-backend-openapi-models/src/models/rate_limit_status_payload.rs) | `plan_type`、可空的主额度、积分、支出控制、额外池、限制原因；限制原因对象的 `type` |
| U2 | [rate_limit_status_details.rs](https://github.com/openai/codex/blob/efdacaf46ff54660a239189a6d62434c5db33d2c/codex-rs/codex-backend-openapi-models/src/models/rate_limit_status_details.rs) | `allowed`、`limit_reached`，可空的 primary/secondary 窗口 |
| U3 | [rate_limit_window_snapshot.rs](https://github.com/openai/codex/blob/efdacaf46ff54660a239189a6d62434c5db33d2c/codex-rs/codex-backend-openapi-models/src/models/rate_limit_window_snapshot.rs) | 百分比、原始秒数、相对倒计时、绝对重置时间 |
| U4 | [additional_rate_limit_details.rs](https://github.com/openai/codex/blob/efdacaf46ff54660a239189a6d62434c5db33d2c/codex-rs/codex-backend-openapi-models/src/models/additional_rate_limit_details.rs) | `metered_feature` 为池身份，`limit_name` 为名称，独立的可空 `rate_limit` |
| U5 | [credit_status_details.rs](https://github.com/openai/codex/blob/efdacaf46ff54660a239189a6d62434c5db33d2c/codex-rs/codex-backend-openapi-models/src/models/credit_status_details.rs) | 积分布尔状态、字符串余额及两类不透明消息数估计 |
| U6 | [spend_control_status_details.rs](https://github.com/openai/codex/blob/efdacaf46ff54660a239189a6d62434c5db33d2c/codex-rs/codex-backend-openapi-models/src/models/spend_control_status_details.rs) / [spend_control_limit_details.rs](https://github.com/openai/codex/blob/efdacaf46ff54660a239189a6d62434c5db33d2c/codex-rs/codex-backend-openapi-models/src/models/spend_control_limit_details.rs) | 限制是否达到、来源、三个字符串数值、两个百分比、重置字段 |
| U7 | [backend-client/src/client.rs](https://github.com/openai/codex/blob/efdacaf46ff54660a239189a6d62434c5db33d2c/codex-rs/backend-client/src/client.rs) | 主池 ID 为 `codex`；额外池不继承主池积分/支出控制；正秒数向上取整为显示分钟；使用绝对 `reset_at`；积分转换不消费消息估计数组 |
| U8 | [protocol/src/protocol.rs](https://github.com/openai/codex/blob/efdacaf46ff54660a239189a6d62434c5db33d2c/codex-rs/protocol/src/protocol.rs) | 本地规范 `RateLimitSnapshot`、窗口、积分、支出控制及 `normal_model_slug` |

## HTTP 请求与每个响应字段的消费

本地入口是 `src-tauri/src/usage_monitor/codex_quota_accounts.rs::schedule`：从相应 Codex home 的 `auth.json` 取得 ChatGPT 登录账号与令牌，向 `https://chatgpt.com/backend-api/wham/usage` 发 GET；账号标头为 `ChatGPT-Account-Id`，附带 bearer、`User-Agent: Codex Desktop` 和 `OpenAI-Beta: codex-1`。请求超时为 10 秒。成功额度的观察时间在额度响应后取得，不因随后独立的订阅查询延长。五分钟的调度尝试间隔不等于延长成功快照寿命。

保存路径为 `save_authenticated` → `quota::save_authenticated_codex` → `official_observations` → `monitor_quotas` / 同池趋势样本 → `quota::read` → `MonitorQuotaReport` → `UsageMonitorView.vue`。账号范围来自本次认证请求，不用会话创建者推断历史付费账号。

| HTTP 字段 | 接收与保存 | 返回及页面消费者 / 有意不使用的范围 |
| --- | --- | --- |
| `plan_type` | `OfficialUsagePayload.plan_type` → 该观测的 `plan` | 作为额度/积分/状态观测的套餐标签；不据这个字符串给自有成本定价 |
| `rate_limit` | 可空 `OfficialRateLimit`，主池 `limit_id=codex` | primary、secondary 分开呈现；缺失或 null 是完整快照中当前未报告，不沿用旧窗为当前 |
| `allowed`、`limit_reached` | 可空布尔 → `provider_status` | 单独显示源端限制；明确限制会阻止同账号主池的继续消费预测和预测快照写入，不把原始百分比改成 100 |
| `primary_window`、`secondary_window` | 独立 slot，可空 | 当前和历史分别保存；某个 slot 消失或时长改变，旧窗退为历史，数值和观察时间不删除 |
| `used_percent` | 有效有限百分比保留为 `used_percent` | 真实 0 保留；未知/非法百分比不补 0；剩余百分比由同一有效事实计算，限制状态不覆盖它 |
| `limit_window_seconds` | 原始 `window_seconds`，并参与数据库唯一身份 | `windowSeconds` 返回原始秒；正数的 `windowMinutes=ceil(seconds/60)` 仅供显示；非整分钟可显示精确秒数 |
| `reset_after_seconds` | `reset_after_seconds` | `resetAfterSeconds`；缺绝对时间时显示“采集时”倒计时，不每次读取重新加到当前时间 |
| `reset_at` | 正 Unix 秒转换为毫秒 | `resetsAtMs`，用于窗口失效/周期边界；优先于相对倒计时。已过期仍保留原始窗口及独立新余额/状态 |
| `credits.has_credits`、`credits.unlimited` | 可空布尔原值 → `QuotaCredits` | true、false、unknown 区分；主池账号级显示一次，不按两个窗口或额外池求和 |
| `credits.balance` | 非空字符串原值保存 | `balance`；真实字符串 `"0"` 显示；无法解读为数值的字符串仍作为源端原值显示，不成为可继续消费的证明 |
| `credits.approx_local_messages`、`approx_cloud_messages` | 识别可空数组的结构，元素保持不透明 | **有意不转换、不入请求账**。U5 只给出 `Vec<Value>`，U7 的官方积分快照也不使用它们；没有可用于真实请求/Token/金额的计量契约，不能伪装成已发生用量 |
| `spend_control.reached` | `QuotaSpendControl.reached` | 独立的源端限制事实；true 阻止主池继续消费预测，不构造采购费用 |
| `individual_limit.source` | 字符串原值 | 显示限额来源 |
| `individual_limit.limit`、`used`、`remaining` | 字符串原值 | 显示源端限额/已用/剩余；不擅加 USD/CNY 单位，不与本地采购支出、收入或请求成本合并 |
| `individual_limit.used_percent`、`remaining_percent` | 各自保留有效百分比 | 独立显示，不从其中一个重算另一个，不替代额度窗口百分比 |
| `individual_limit.reset_after_seconds`、`reset_at` | 各自保存，绝对秒转毫秒 | 绝对重置时间优先；相对值仅为采集时证据 |
| `additional_rate_limits[].metered_feature` | 独立 `limit_id` | 同账号不同池互不覆盖。空身份、重复身份、与主池 `codex` 冲突均拒绝该异常快照，旧事实不被部分新数据覆盖 |
| `additional_rate_limits[].limit_name` | `pool_label` | 池名称与窗口时长一起显示；无数字窗口时可保留池存在/名称的 summary |
| `additional_rate_limits[].rate_limit` | 与主窗相同的结构，但独立身份及状态 | 额外池分别展示/采样/退役；不复制主池积分、支出控制、限制原因，不进入主周金额周期或阻断主池预测 |
| `rate_limit_reached_type.type` | 官方已知枚举映射；未来值保留为 `unknown` 语义 | 主池显示窗口限制/工作区所有者或成员积分耗尽/用量限额达到。未知原因不凭空解释为已耗尽 |

类型兼容有明确范围：旧响应缺少可选标量可保留为 unknown；已存在字段的错误类型会使整个响应失败，不能把错误响应当成“成功但没有字段”。原生回归覆盖字符串 `allowed`、对象 `balance`、非数组额外池、数字 `used` 等输入。错误对外使用固定安全说明，不回传请求凭据。

### plan-only 响应的明确消费范围

合法 `plan_type + rate_limit:null` 且没有 credits/status/额外池证据时，当前没有独立实时套餐消费者，因而不制造一个当前额度百分比或 summary。此前窗口退为历史，旧 `plan` 仅属于旧观察。额度来源可呈现“尚未报告”，这不等于把未知额度认成零。

有 credits/status 但没有数字窗口时，会产生 `slot=summary`，窗口大小、使用百分比和重置时间保持 null。账号订阅资格与时间使用独立官方订阅接口 / 本地认证证据；采购金额来自本地账。仅有 `plan_type` 既不定价，也不续用旧周额度。上述两种响应均有同一反例内的独立断言。

## 身份、迁移、时效和金额边界

1. 唯一身份加入原始秒数：`tool + account_key + limit_id + slot + window_minutes + window_seconds`。61 秒与 119 秒虽然都显示 2 分钟，仍是两个不同观察，不互相覆盖。604799 秒虽然显示 10080 分钟，不能冒充 7 天。
2. 主周金额周期仅允许有已核实账号证据的主池及精确 604800 秒。新增写入和启动时 bootstrap 采用相同资格条件。额外池即使恰好 604800 秒也不创建主周期。已有自有金额公式未改变。
3. 迁移在写事务内重建约束，保留既有 row ID、样本关联、原始 JSON（包括历史错误与未识别扩展字段）。迁移可重复执行。对于旧官方 HTTP 行，缺少秒数字段时可由整分钟乘 60 推导身份，因为旧解析器仅接受正整分钟窗口；这个兼容依据不适用于新响应已提供的原始秒数。页面在缺新字段的旧 DTO 上保留此前资格兼容；新字段一旦存在必须精确匹配。
4. 完整成功快照会退休未再报告的窗口/额外池；旧值、旧观察时间仍保留。失败只标记对应账号历史状态，不改变别的账号，也不把失败时间写为成功额度时间。新成功清除对应错误。
5. 额度窗口到达 reset 会过期；同一刚获取响应中的 credits/status 有自己的五分钟观察寿命，不因窗口已过期就被整体拒收。源状态能区分“额度窗口过期”与“连独立元数据都没有报告”。过期窗口不写入新的当前周关联。
6. 页面请求失败时，保留的额度和积分明确转为历史；恢复成功再清掉错误。账面事实保留，unknown 不补零。明确限制可以在主窗仍余 80% 时阻止预测；解除限制恢复预测；再次限制不复活或刷新之前缓存的预测金额。额外池限制不会阻止主池。
7. 本地规范日志的 `normal_model_slug` 保留为额度模型别名；`spend_control_reached`、`individual_limit`、`rate_limit_reached_type` 可保留为额度状态。日志没有认证账号证据时仍为会话/未归属范围，不据别名、相同重置时间或创建者推断付费账号，也不改写请求真实模型。

## 六条已注册读取接口逐项核对

注册证据是 `src-tauri/src/main.rs` 的 `generate_handler!`。前端对应 `src/api/usageMonitor.ts` 和 `src/api/usageAccounts.ts`，页面消费在 `src/views/UsageMonitorView.vue`。六条均已核对调用参数、返回类型、读取事务、筛选/分页范围及异常消费者；“六条”是监控读取范围，不代表全部财务写接口。

| 命令 → 前端入口 | 数据及读取范围 | 输出与页面核对 |
| --- | --- | --- |
| `usage_monitor_snapshot` → `getUsageMonitorSnapshot` | `mod.rs` → `store::sessions`，单个数据库读取事务；工具白名单、search 长度、status 枚举；页大小前端 100，后端限 1–200 | `MonitorSnapshot`；工具总计先于会话列表筛选求和；搜索/状态/未计价只影响其明确的列表范围；全局及工具状态计数分开，页面选择对应范围；运行时采集状态作为独立状态 |
| `usage_monitor_session` → `getUsageMonitorSession` | `store::session_detail_with_descendants`；session key、起止时间、模型、turn、计价原因、未计价、子代理包含选项及分页；单读取事务 | `MonitorSessionDetail`；会话总计、过滤后总计与分页请求分开；子代理/父子关系有明确范围，不把分页行和整段总计混用；UI 保留对应查询身份 |
| `usage_monitor_analysis` → `getUsageMonitorAnalysis` | `analysis::read` / 共享使用量投影；工具、`[start,end)`、模型、计价原因；会话列表额外有搜索/状态/未计价/分页；单读取事务 | `MonitorAnalysis`；工具/模型/趋势/会话返回类型逐项对照；列表筛选不冒充全量时间段总计；无可靠时间与旧累计记录独立标识，不能分摊成虚构逐条请求 |
| `usage_monitor_weekly` → `getUsageMonitorWeekly` | `weekly::read_with_catalog`；明确观察 start/end 和独立 forecast end，范围最多 8 天；同一次目录快照与数据库读事务；历史预测样本和本周已发生账分开 | `MonitorWeeklyUsage`；接口返回全局和 `byTool`，页面选工具对应行（接口本身没有 tool 参数）；`unlocatedTotals` 保留无时间定位记录；已识别金额、参考金额、预测分开。额外池不再暂停主池预测，主池明确限制会暂停 |
| `usage_monitor_accounts` → `getUsageMonitorAccounts` | `accounts::read`；weekStart/now 范围最多 8 天，单读取事务；账号请求证据、creator reference、独立订阅事实、周期证据分别读取 | `AccountUsageReport`；确认归属、创建者参考、未归属、无时间定位分开；`creatorReference` 为非加总的参考子集。精确主周资格同步于写入和 bootstrap；额外池卡片不承载主账号金额，只有额外池时账号账面板独立呈现 |
| `usage_monitor_quotas` → `getUsageMonitorQuotas` | `quota::read`；额度、来源状态、趋势样本、账号显示身份处于同一读事务；原始账号/source instance 隔离沿用已核实规则 | `MonitorQuotaReport`；新增秒数、相对重置、provider status 完整返回。原始额度、credits、限制及错误分开显示；真实零、未知、过期、失败、额外池和账号分别保留 |

共同时间参数校验拒绝倒序、越界时间与过长模型/turn/计价原因；数据读取使用 `[start,end)`，不把源日志时间精度夸大为生产事件发生的更高精度。全局、会话、分析、周报和账号仍使用各自被说明的统计范围，不强行令不同范围的数字相等。

页面周数据加载一次捕获 `now`，把同一个 now 传给周报与账号查询；额度报告自带采集时间。各接口各有自己的事务，**没有宣称六次调用是一个跨接口原子快照**。账号金额预测继续检查窗口、quota 观察时刻、账号周期和对应请求快照是否一致；缺证据或不同步保持不可推算。

财务的 `finance_ledger_query/save/void/save_batch/get_batch/void_batch/related_events` 和 `read_cost_ledger/write_cost_ledger` 不包含在这六条读取接口内；本轮其逐项核验与修复见 [finance-data-contract-audit-2026-11-07.md](finance-data-contract-audit-2026-11-07.md) 及 [data-channel-completion-2026-11-07.md](data-channel-completion-2026-11-07.md)，不能仅凭这里的六条就声称覆盖财务全部入口。

## 可复现反例与验证结果

原生新增测试位于 `src-tauri/src/usage_monitor/official_quota_contract_tests.rs`。它们调用真实保存、SQLite 迁移和读取通路，在独立冻结旧源码上注入同一断言，不回滚共享工作区、不替换生产解析器。

| 新增原生反例 | 旧实现实际结果 | 修复后的关键断言 |
| --- | --- | --- |
| 主池及两个额外池、独立退役 | 失败 | 四个窗口全部返回；额外池真实 0 保留；不继承主积分；移除一池不影响其他池 |
| 61/119 秒、不同绝对/相对 reset | 失败 | 不漏窗、不撞 ID；显示 ceil 分钟同时保留精确秒；绝对 reset 优先 |
| 604799 秒主池及 604800 秒额外池 | 失败 | 主周关联/金额周期均不误建，重复初始化仍正确 |
| 没有窗口的真实 0 积分、后续 plan-only | 失败 | 首个 summary 数字额度为 null，余额为 `"0"`；后续旧事实为历史，不制造额度 |
| provider 状态和 spend control | 失败 | 所有被使用的字段独立保留；25% 不被改成 100%；仅有状态也能报告，不产生采购账 |
| 已知字段错误类型 / 重复池 ID | 失败 | 整次失败；旧事实不被成功稀疏刷新覆盖 |
| 旧表迁移及重复初始化 | 失败 | 原 ID、sample、原始 JSON/错误/扩展字段保留；新同窗口更新原 ID |
| 规范本地日志别名/控制状态 | 失败 | 元数据保留，仍为未认证的会话范围 |
| 响应到达时窗口刚过 reset | 失败 | 旧窗过期但成功接收独立余额；来源可报告；不创建当前周关联/周期 |

实际旧版证据：`official-quota-v0238-before.log` 为 **8 failed / 0 passed**；`official-quota-reset-v0238-before.log` 为 **1 failed / 0 passed**。均为断言失败，不是编译失败。

修复后的专项：`official-quota-native-after.log` 为 **28 passed**（含以上 9 条）；`official-quota-accounts-native-after.log` 为 **11 passed**。根代理随后完成整仓 headless 原生测试：`completion-final-native.log` 为 **621 passed / 0 failed / 21 原有 ignored**，运行前后 45 个原生源码/锁文件哈希一致。原生 headless 保留业务源码和测试，但不代替 Windows/macOS 桌面构建与安装验收。

页面新增 **13 条**，覆盖零积分、精确周资格、状态和支出控制、额外池身份/秒数/账号归属、额外池耗尽隔离、主池限制不能被余额越过、查询失败历史状态、积分独立时效，以及主池未耗尽但明确限制时的预测/缓存禁止与成功恢复。前 9 条在页面修复前全部失败；补充主池预测门禁的 4 条在门禁修改前 **3 failed / 1 正向控制 passed**（额外池不能阻断主池）。对应证据为 `official-quota-view-v0238-before.log`、`official-quota-view-scope-v0238-before.log`、`official-quota-view-freshness-v0238-before.log` 和 `official-quota-provider-gate-before.log`。

旧页面测试中“隐藏 0 积分”“窗口过期即余额过期”“独立额外池阻断主池”等断言与已核实的生产者契约相矛盾，已改为更明确的事实保留、实际观察年龄、独立范围断言；未删掉这些案例。另保留主池五小时耗尽不能被七天窗口更新覆盖的正向控制，并通过展开历史区检查额外池历史仍然存在。

最终所属页面/API/i18n **3 个文件 183 passed / 0 failed**，其中页面 157 条包含上述新增 13 条；所属 TypeScript/Vue/测试/中英文词典 ESLint 通过。证据为 `official-quota-view-full-after.log`、`official-quota-eslint-after.log`。整仓前端类型/测试/构建由根代理统一执行，最终门禁结果以本次发布核验报告为准。

## 尚不应被解释成的结论

- 消息数估计数组不代表请求账；字段已枚举并核实其没有可用的真实请求/Token契约，不属于遗漏了一个已知请求生产者。
- plan-only 不等于完整实时套餐同步；其有意消费范围如上，不凭缺失窗口补零。
- 原生客户端里的额度与限制不是本地采购支出；本次未替换自有成本算法。
- 此报告的官方生产者为固定 Codex 提交；Claude、Antigravity、Sub2API 私有扩展及其他端的对应生产者核验由同轮其他专项记录承接，不能把它们未提供的字段描述为已经核实的官方事实。
- 源码和合成真实结构反例能证明通路规则和缺口修复，不能替代未提供的生产账单逐笔核销；这与是否已完成上述可见接口的源码核验是两个范围。
