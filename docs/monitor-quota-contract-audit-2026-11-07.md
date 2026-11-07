# 用量监控接口与额度状态契约核验（2026-11-07）

## 核验范围与证据版本

- 本项目基线：`9holy/usage-ledger@d21bb208672587d77f100e39dd8f33435040da83`。
- 官方 Codex 契约：[`openai/codex@efdacaf46ff54660a239189a6d62434c5db33d2c`](https://github.com/openai/codex/tree/efdacaf46ff54660a239189a6d62434c5db33d2c)。
- Cockpit 契约：[`jlcodes99/cockpit-tools@820e176842d440a60e650729c3a39932b76a0ccb`](https://github.com/jlcodes99/cockpit-tools/tree/820e176842d440a60e650729c3a39932b76a0ccb)。上游额度文件具体字段由 Cockpit 专项审计负责；本文核对它们进入用量监控后的账号、来源、错误和历史语义。
- 本文是对 API 包装、原生命令、查询和额度状态机的源码核验，以及合成夹具回归。没有读取用户真实凭据、调用真实账号额度或订阅接口，也没有核对实际供应商账单。
- 采购摊销和成本算法继续使用本项目自己的模型。额度百分比、重置时间和来源状态不等于支出凭证。

## 1. 前端到原生数据通路

| 前端入口 | 原生命令 / 数据通路 | 范围、身份和一致性 | 本次检查结论 |
| --- | --- | --- | --- |
| `src/api/usageMonitor.ts` 的 snapshot | `usage_monitor_snapshot` → `usage_monitor/mod.rs` → `store::sessions`、会话和状态汇总 | tool 白名单；search 最多 200 字符；status 为 all/active/history；原生页大小限制 1–200，前端固定 100；多次 SQL 在一个读事务中执行 | totals 受 tool 影响；search/status/unpriced 是会话列表筛选，不自动改变该工具全局 totals。全局 statusCounts 与 toolStatusCounts 同时返回，前端按对应范围使用 |
| analysis | `usage_monitor_analysis` → `analysis::read` | 时间、model 等 period 参数验证；tool 白名单；search/status 验证；分页上限 200；读事务 | 时间/tool/model 限定统计范围，列表搜索及状态属于会话筛选。未知时间和未展开的账面量另列，不为了凑齐时间分布制造时间戳 |
| session | `usage_monitor_session` → 会话、turn、usage/detail 查询 | session key、period 与筛选参数验证；读事务；分页上限 200 | 会话不存在和缺乏定价事实不等于零请求或零成本。未知时间在有界窗口内不能硬归入某日 |
| quotas | `usage_monitor_quotas` → `quota::read` → `monitor_quotas`、样本、账号标识、来源状态 | **本次补充读事务**，让同次返回的额度、错误状态和账号标识读取同一数据库快照 | 单条数值仍保留自己的原始 observedAtMs；接口被调用的时间不能冒充源端成功采集时间 |
| weekly | `usage_monitor_weekly` → `weekly::read_with_catalog` | `startMs/endMs/forecastEndMs` 验证；窗口最长 8 天；查询使用读事务 | 观察末点和预测末点独立。统计、预测与未定位事实的核验由主监控账本专项共同负责 |
| `src/api/usageAccounts.ts` 的 accounts | `usage_monitor_accounts` → `accounts::read` | `weekStartMs/nowMs` 验证，最长 8 天；读事务；按可证实的账号证据和周期组织 | 确认归属的请求，与基于会话创建者等参考线索的子集分开，不能相加形成重复金额。无账号证据保留未分配，不猜测历史登录账号 |

前端上述入口均有桌面运行环境约束，Tauri 参数使用 camelCase，与命令参数绑定对应。读事务只能保证本地 SQLite 查询一致性；运行状态、外部文件、远端请求与本地数据库并非同一分布式事务，不能据此宣称所有外部源在同一毫秒完成采集。

### 账号身份与来源身份不能混为一谈

`request_accounts.rs` 从官方请求日志的 `official_account_id` 得到 `account:<officialID>`，同时保留来源库路径、请求日志 ID、会话和 Token 等匹配证据。同一个官方供应商账号可出现在多个来源目录中，不能为了隔离目录把其真实供应商身份随意改成不同账号。存在互相冲突的匹配时维持 Conflict，不把其中一个候选强行当作准确归属。

Cockpit 本地记录的原始 account ID 则可能在不同配置目录中重复。额度缓存、额度历史和由额度推导的周周期必须区分本地来源实例。两者采用不同身份规则有明确证据基础。

## 2. 官方 Codex 额度契约

固定上游的 [RateLimitStatusDetails][o-details] 明确将 `primary_window`、`secondary_window` 定义为双重 Option，允许字段缺失和显式 null；[RateLimitStatusPayload][o-payload] 的 `rate_limit` 也允许缺失/null。官方 [backend-client 映射][o-client] 将不存在的 rate_limit 映射成不存在的两个窗口，而不是复用之前的窗口。

本地通路为：身份匹配过的官方异步请求 → `codex_quota_accounts::Reader::collect` → `save_authenticated` → `quota::save_authenticated_codex` → `monitor_quotas` 与额度采样 → `quota::read` → 前端额度展示。直接认证的账号额度可以提供账号归属；本地 session 的 quota 日志仅能证明会话作用域，不能因为 home/plan/reset 恰好一致就变成该账号的历史登录证据。

| 场景 | 修复前问题 | 修复后行为 |
| --- | --- | --- |
| 一个账号刷新失败 | 仅在后台打印失败，历史值仍可能显示 current；界面不知道这次失败 | 用单独的账号检查状态记录失败。已有百分比与原始采集时间保留，标历史/sourceError；不延长成功 TTL；其他账号不受影响 |
| 第一次刷新就失败，没有先前额度 | 无法准确区分未报告与本次失败 | 来源状态显示失败，不凭空创建一个 0% 的额度对象 |
| 成功响应移除某个 slot，或 slot 的时长改变 | 旧主键 `(slot, window_minutes)` 的行不再被覆盖，仍被当 current | 记录本次完整窗口集合；之前的该账号官方窗口若已不在集合中，保留历史行和数值，标为最新检查未报告。新窗口独立保存 |
| 成功响应 `rate_limit: null` | 旧窗口可能继续 current | 旧窗口保留为历史；没有新窗口就不伪造零值 |
| 较晚返回的旧响应 | 可能把被新检查退役的窗口再次恢复成 current | 比较该账号已记录的检查时间和窗口时间，较旧结果不能反向更新当前状态 |
| 一个 HTTP 成功响应结构无效 | 保存出错中止当前收集，队列中其他账号的成功结果也未处理 | 仅把该账号本次检查标失败，继续处理其他结果；事务回滚该无效结果，不清除之前已证实的额度事实 |
| 后续真正成功 | 原先失败状态缺乏明确恢复通道 | 同账号成功清错；真实的 0% 仍为 0，不被 null 化 |

账号检查状态单独存于 `monitor_state`，不把失败检查的时间写回额度原始 `observed_ms`。对外只返回固定安全错误说明与失败账号数，不把远端异常字符串、Authorization、API key 或 token 暴露为错误详情。

## 3. Cockpit 来源与错误隔离

### 内部身份兼容

`cockpit_data_path::source_instance_id()` 是统一来源身份入口。只有历史 legacy 物理根返回 `local`，独立 modern/dev/custom 根返回稳定的 `cockpit:<digest>`；同一物理目录的规范化别名得到同一个实例身份，目录选择变化不会重用另一根的 local。

- 历史 legacy 物理根保持既有内部键 `cockpit:<rawID>`，兼容已保存的本地历史。
- 独立 modern/dev/custom 根使用 `cockpit:instance:<sourceID>:<rawID>`，隔离相同 rawID 的不同本地来源。
- 不修改上游返回的 raw account ID。前端收到的账号标识仍经过现有隐私处理。
- 额度来源状态增加可选 `sourceInstance`。旧的已保存来源状态没有该字段时按默认 local 解读，不能把它推广成所有自定义实例的错误。

旧版本已写入的、没有实例身份的自定义目录记录无法仅靠现存 rawID 可靠判断属于哪个目录，本次不猜测并重归属这些旧数据。新读数使用明确实例键，不能据此声称历史上已经混合过的数据已被自动拆分还原。

### 失败和成功的状态传播

`from_cockpit` 现在保留每条 `QuotaSnapshot.source_error`，并兼容 `unavailable_reason`。一个账号失败只影响其自身读数；来源总状态可以为 partial 并显示失败读数数量，但聚合警告不再自动施加到成功账号。

整个源读取失败时，只对相同工具、相同 sourceInstance 的已存窗口标记 sourceError；时间、百分比、重置点均保留。失败状态持久保存在这些历史行中，切换到另一个自定义或默认目录后不会因为聚合 source status 被替换而重新显示 current。另一个来源的账号、采样和周周期不受影响。

成功重读可能仍返回相同的原始 `updated_at_ms`。这种情况仅允许更新错误元数据，不能替换同时间戳的数值或伪造新采样时间。真正后续的新观察按原有单调时间规则更新，清除本账号错误并保留准确的零值。

耗尽预测只使用有账号归属且无 sourceError 的合格采样。部分源失败时只清理受影响账号的预测采样；全源失败时也只清理该实例的采样，不能使其他来源账号的预测失效。

## 4. 反例与回归记录

测试使用临时目录、内存 SQLite 和合成 HTTP payload，不调用真实服务。

| 组别 | 实际修复前结果 | 覆盖内容 |
| --- | --- | --- |
| 4 条 `contract_audit_official_*` | **4 条全部断言失败**，日志 `monitor-quota-contract-before.log` | 单账号失败隔离及成功恢复；nullable/变时长退役与迟到旧结果；无效成功结果不阻断其他账号；首次失败不虚构额度 |
| 2 条 `contract_audit_cockpit_*` | **2 条全部断言失败**；同轮另外 12 条路径/数据库控制案例通过，日志 `monitor-quota-scope-before.log` | 同 rawID 切换目录后只剩 1 个账号（应为 2）；某账号错误使健康账号也 stale；默认身份兼容和全源失败范围 |
| 同一 Cockpit 错误案例的加强断言 | **1 条真实断言失败**，日志 `monitor-quota-persistence-before.log`，失败信息为 `switching roots must not revive a known failed reading` | 全源失败后切到 default 仍历史；切回成功清错且时间不变；后续新观察的真 0；其他账号和实例持续隔离 |
| 修复后 Cockpit 两条专项案例 | **2 通过，0 失败**，日志 `monitor-quota-default-after.log` | 使用最终生产实现与完整加强断言；每次重编译测试包，避免冻结工作树之间复用旧测试二进制 |

最终冻结候选的原生业务全量回归已由主任务统一运行：**560 通过、0 失败、21 个原有 ignored**，日志 `data-channel-native-final.log`；上述额度反例全部通过。加强后的来源测试包含两个 custom 根、独立 modern 根和历史 legacy 根：同 rawID 保留 4 个来源账号、8 个额度窗口，只有 legacy 物理根使用原 local 键。该 headless 运行不替代 Windows/macOS 桌面测试。局部 `src/api/usageMonitor.ts` ESLint 与修改范围的 whitespace 检查已通过。没有删除账号身份、历史保留或失败隔离断言来满足新实现；非零比例经过 fraction 往返的数值比较采用小于 `1e-9` 的浮点误差，真 0、时间、账号数和状态仍精确断言。

## 5. 保留的界限

- 源码契约与合成反例能确认这些数据通路及状态机的行为，不能证明用户真实部署中每条请求都已采集、每笔采购都已登记或供应商账单完全相符。
- 官方额度的 absent/null 与真实 0 有不同含义。本次验证了主要 rate_limit 的主、次窗口及标准 5 小时/7 天窗口变化。官方额外额度池、非整分钟时长等扩展字段不能仅凭这一测试集宣称全部完整覆盖。
- 不把本地会话额度相关性当作真实账号归属，不把官方账户 ID 和本地实例 ID 混成同一概念。
- 缺时间、缺账号、缺价格、失效/失败来源各有独立未知状态。保留可证实事实，不以 0 替代缺失数据。
- 本文不包含实际账号凭据、实际账单或用户个人用量。本次专项没有触发发布、推送或安装包上传。

[o-details]: https://github.com/openai/codex/blob/efdacaf46ff54660a239189a6d62434c5db33d2c/codex-rs/codex-backend-openapi-models/src/models/rate_limit_status_details.rs
[o-payload]: https://github.com/openai/codex/blob/efdacaf46ff54660a239189a6d62434c5db33d2c/codex-rs/codex-backend-openapi-models/src/models/rate_limit_status_payload.rs
[o-client]: https://github.com/openai/codex/blob/efdacaf46ff54660a239189a6d62434c5db33d2c/codex-rs/backend-client/src/client.rs
