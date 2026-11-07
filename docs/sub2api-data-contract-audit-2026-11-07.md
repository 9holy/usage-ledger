# Sub2API 成本数据通道源码核验（2026-11-07）

> 本文件保留 v0.2.38 时点的核验记录。v0.2.39 的 [可选扩展与接入面板补充报告](sub2api-extension-contract-audit-2026-11-07.md) 已补齐实际调用者、完整生产源码搜索、API Key 分页和连接/密钥异步保护，并关闭 cost-loss/pricing 畸形 200 假数据问题。confirm/refund/reverse 仅为未使用导出，不能当作本页 native 财务操作；独立扩展 producer 未取得的边界仍明确保留。

## 范围与固定版本

- 本项目审计基线：`9holy/usage-ledger@d21bb208672587d77f100e39dd8f33435040da83`（v0.2.37）。
- 上游契约：[`Wei-Shaw/sub2api@6b4b37db43443b5e88e424fe3c69602cc3810dfb`](https://github.com/Wei-Shaw/sub2api/tree/6b4b37db43443b5e88e424fe3c69602cc3810dfb)，以 GitHub API 查询及浅克隆 `git rev-parse HEAD` 固定。
- 本项目中的来源引用指向 `Wei-Shaw/sub2api`。同日查询 `9holy/sub2api` 返回 404，不能据此虚构一个已验证的用户 fork；也不能断言用户的实际部署就是上面的官方提交。
- 范围是成本工作台的 Sub2API 原始用量、账号、配额、运行质量、价格参考、可选账本接口以及统一来源读取通路。用量监控原生采集和另外两个来源由各自审计负责。
- 本次仅进行了源码对照和合成反例测试，没有连接用户实际 Sub2API 服务，没有读取用户真实账单或账号凭据，没有执行账号探测、采购资料修改或账本写入。

**计算边界：采购、周期摊销、损失、毛利及回本仍由本项目自己的成本模型处理。上游客户扣费、标准价等值、账号倍率快照分别保留各自含义；本次没有用上游收费算法替换本地采购模型。**

## 1. 端点、类型、聚合与展示通路

下表中的路径均相对于 `/api/v1`，可选成本服务单独说明。

| 端点 / 输入 | 固定上游源码契约 | 本项目接收类型 / 入口 | 聚合、账号关联和展示去向 | 核验结果 |
| --- | --- | --- | --- | --- |
| `GET /admin/usage`：`page/page_size/start_date/end_date/timezone/account_id/sort_by/sort_order/exact_total` | [Usage handler][u-usage-handler]；[查询 SQL / 分页][u-usage-query]；[DTO][u-dto] | `adminAPI.usage.list` → `PaginatedResponse<AdminUsageLog>`；`useCostCenterData.loadModelRouteLogs` | 按 `created_at` 再裁剪 `[start,end)` → `accountStatsFromLogs`、趋势、模型、路由、模型审计；账号以 `account_id` 关联，不能以当前账号清单过滤历史事实 | 日期参数不是精确时间参数。完整读取与 25,000 条上限分别标记；已修复后续经济汇总丢失历史账号的错误 |
| 同一 usage 端点，统一来源面板独立读取 | [认证中间件][u-auth]；同上 usage 契约 | `readSub2apiWindow` 自建 axios 客户端，捕获指定连接的地址、API key/JWT；`WindowCostReading` | `aggregateSub2apiWindowLogs` → 请求数、Token、账号快照金额、窗口覆盖状态 → 统一来源成本汇总 | 不借用另一个活动连接的认证；不将 `actual_cost` 当账号成本；后续页失败保留已知小计并标 partial |
| `GET /admin/accounts`：分页、`include_scheduler_score=true`、ID 升序 | [Account handler List][u-account-handler]；[账号软删除 schema][u-account-schema] | `adminAPI.accounts.list` → `PaginatedResponse<Account>`；`readAllPages` | 当前账号元数据、状态、平台、调度字段、`extra.cost_profile` → 账号表、筛选、本地经济模型 | 清单是当前可见账号，不能据此证明历史日志不存在。ID 在日志中存在而清单缺失时，事实仍须保留 |
| `POST /admin/accounts/today-stats/batch`：`account_ids` | [GetBatchTodayStats][u-account-handler] 的请求只声明 `account_ids`；[自然日 SQL][u-usage-stats] | `BatchTodayStatsResponse.stats` / `WindowStats` → `todayStats` | 作为源端自然日快照；覆盖范围足够的精确日志随后重算本地今日及滚动窗口 | 客户端为扩展兼容发送的 `start_time` 不在官方请求契约内，不能据此把响应解释成任意滚动窗口 |
| `GET /admin/accounts/:id/today-stats`、`GET /admin/accounts/:id/stats?days=N` | [Account handler][u-account-handler]；[账号聚合 SQL][u-usage-stats] | `WindowStats` / `AccountUsageStatsResponse` | API 模块有包装；成本页当前精确窗口主路径不依赖这两个端点 | `days` 是源端自然日跨度，不能代替 1 分钟、1 小时等精确窗口 |
| `GET /admin/accounts/:id/usage?source=passive|active&force=true` | [GetUsage][u-account-handler]；[UsageInfo 与降级逻辑][u-account-usage] | `AccountUsageInfo` → Sub2API `quotaRefresh` | 按原始账号 ID 保存配额周期和重置时间 → 账号配额单元格及配额来源状态 | Anthropic OAuth/setup-token 用 passive，其余受支持账号用 active。HTTP 200 可能携带 `error/error_code`；本次已修复成功状态、缓存和历史证据标记 |
| `POST /admin/accounts/usage/batch`：`account_ids, force` | [GetBatchUsage][u-account-handler] | `BatchAccountUsageResponse {usage, errors}` | API 包装存在；成本页当前使用有并发上限的逐账号读取 | 批量返回的独立错误映射不是成功配额；本次未改用此端点 |
| `GET /admin/dashboard/snapshot-v2`：观察窗口 / 模型窗口 | [snapshot v2 handler][u-dashboard-snapshot]；[日期解析][u-dashboard] | `DashboardSnapshotV2Response` → `snapshotMatchesRequestedWindow` | 仅接受能回显请求精确起止点的扩展响应；官方日期快照走 usage 日志兼容聚合 → 趋势与模型 | 当前官方响应只有 `start_date/end_date`，没有精确 `start_time/end_time`。不能把源端日期累计或 lifetime stats 当所选短窗口 |
| `GET /admin/ops/dashboard/snapshot-v2` | [Ops snapshot handler][u-ops-snapshot]；[时间范围解析][u-ops-handler]；[Ops SQL][u-ops-repo] | `OpsDashboardSnapshotV2Response` → `opsOverview/opsTrend/opsErrorTrend` | 请求成功/错误、吞吐、延迟及 SLA 等运行质量面板；不据账号健康状态反推请求失败数 | **已修复** `1m` 被上游静默读成 `1h`。所有范围现在发送与 usage 同次捕获的 ISO 起止点；监控未启用时维持 unavailable |
| `GET /admin/channels` | [Channel List][u-channel-handler]；[官方路由][u-routes] | `PaginatedResponse<Channel>` → `readAllPages` | 以日志 `channel_id` 等明确字段关联路由价格和名称 | 缺渠道资料时保留日志原始路由事实并标 partial；不以展示名强行配对 |
| `GET /admin/channels/model-pricing?model=...` | [Channel GetModelDefaultPricing][u-channel-handler] | `ModelDefaultPricing` → `modelPricing` | 查询日志中实际转发模型（缺失才用请求模型）→ 模型价格参考；一次最多 100 个不同模型 | 是上游参考价格，不是采购凭证；未查询到价格仍是缺数据 |
| `GET /admin/channels/pricing/sync-models` | [官方路由][u-routes] / [Channel handler][u-channel-handler] | `SyncPricingModelsResult` | 管理 API 包装，非本次成本刷新必要链路 | 官方路由存在 |
| `GET /admin/channels/pricing/status`、`POST /admin/channels/pricing/refresh` | 固定提交的 [官方 channel 路由][u-routes] **未注册**这两个路径 | `PricingCatalogStatus` | 可选增强服务；状态读取失败显示 unavailable，不能凭此推断价格为 0 | 属于扩展兼容边界，不能声称官方部署必定支持。参考模型价格端点与此独立 |
| `GET /admin/settings` | [官方 settings 路由][u-routes] | `SystemSettings` | 调度配置和相关说明 | 是配置数据，不能当请求账或成本账 |
| `GET /admin/accounts/economics/snapshot` | 固定官方路由未注册；请求通过本项目 `getCostServiceBaseURL()` 指向可选成本服务 | `AccountEconomicsSnapshot` | 可选经济采样；不存在时 `deriveLoadedEconomics` 调用本地 `buildLocalEconomicsSnapshot` | 扩展不可用不应制造远端账本。回退保留本地模型；缺档案/不完整用量会标 partial、禁止完整盈利预测 |
| `GET /admin/accounts/cost-loss-states`；成本损失 confirm/refund/reverse 写入 | 固定官方路由未注册；单独成本服务扩展 | `AccountCostLossState[]` / `AccountCostLossEvent` | 终止损失、退款和冲销账本；可提供已删除账号的保留档案 | 当前源码不足以核验用户扩展服务内的真实账目；本次没有执行这些写入 |
| `PUT /admin/accounts/:id` 与 `POST /admin/accounts/bulk-update`，`extra.cost_profile` | [Account Update/BulkUpdate][u-account-handler]；[账号更新服务][u-admin-account]；`Extra` 支持扩展数据，单个更新提交 extra 对象，批量路径做 JSONB 顶层 key 合并 | `UpdateAccountRequest` / bulk 结果 | 本项目采购金额、币种、周期、开始时间、算法版本 → 当前账号资料 / 本地模型；单个保存时客户端保留已读 extra 的其他字段 | 只验证请求数据通道；本次没有修改任何用户采购资料；单个 PUT 不是带版本比较的并发事务 |
| `POST /admin/accounts/:id/test` | [官方账号测试路由][u-routes]；账号测试 SSE | `parseAccountTestSse` / `AccountTestResult` | 终止 `test_complete` 与 error 事件 → 即时探测结果及延迟 | API 包装按 SSE 解析；不是历史请求成功率，本次未向真实账号发起探测 |

## 2. 计数、金额、时间和身份字段

| 原始字段 / 行为 | 来源含义与客户端处理 |
| --- | --- |
| `id` | usage 记录 ID，用于跨页去重；上游 SQL 对 `created_at` 相同的行以 `id` 排序。不能拿当前账号数量当请求数量 |
| `account_id` | 请求发生时的账号 ID；账号之后软删除不等于该请求也被删除。只按这个明确 ID 关联；平台缺证据时不猜测 |
| `created_at` | 上游 `time.Time` JSON 时间戳；客户端在已请求日期范围内再次做 `[start,end)` 裁剪 |
| `input_tokens/output_tokens/cache_creation_tokens/cache_read_tokens` | [UsageLog.TotalTokens][u-usage-service] 和统计 SQL 都将四项相加。缓存创建 5m/1h 字段是拆分维度，不能再重复加到总 Token |
| `total_cost` | 源端标准价格等值，不是本地采购支出 |
| `actual_cost` / 聚合 `user_cost` | 源端客户扣费/客户账单值。接入经济模型作为明确的营收事实输入，不能填进采购成本 |
| `account_stats_cost` | 源端在请求发生时保存的账号统计价格基数；缺失的历史格式按官方 SQL 回退 `total_cost` |
| `account_rate_multiplier` | 源端账号统计倍率快照，缺失按 1，明确的 0 必须保留。账号统计金额是 `COALESCE(account_stats_cost,total_cost) * COALESCE(account_rate_multiplier,1)`，与官方统计 SQL 一致 |
| 请求模型 / `upstream_model` / `upstream_response_model` | 分别是客户请求、实际转发映射目标、上游响应声称模型；路由和审计保留区别，响应模型未知不应自动造出匹配结论 |
| `reasoning_effort` | 当前官方 DTO 表示客户端请求档位；新增 `upstream_reasoning_effort` 表示实际转发档位。成本页未把前者当实际转发档位进行成本计算；此项没有为改变金额而做映射替换 |
| HTTP 200 + `error/error_code` | 上游允许降级配额快照，尤其 Antigravity 错误会返回 `UsageInfo` 和 nil Go error，由 handler 包装成功响应。传输成功不证明配额采集成功 |

### 分页与日期精度

1. 官方 pagination 最大 `page_size` 是 1000；更大或非法值会回默认值，因此现有 1000 请求是契约允许的。
2. `exact_total=false` 的无账号过滤路径会用 `limit+1` 探测是否还有下一页，`total` 可能只是 `offset+limit+1` 下界。不能用该数值冒充完整总条数；读取器在满页时继续。
3. `/admin/usage` 的 `start_date/end_date` 是时区内日期，end date 经 `AddDate(0,0,1)` 后按 `< end` 查询。客户端精确时间裁剪负责短窗口，而不是假设服务端识别额外 `start_time` 参数。
4. `today-stats/batch` 是源端自然日；本地日期与服务器日期可能不同。成本页把它标为源自然日快照，完整日志覆盖足够时按本地窗口重算。
5. `snapshot-v2` 的官方日期快照没有精确边界回显。客户端保守回退日志，不凭同名 range 认为响应已满足精确窗口。
6. Ops 的 `parseOpsDuration` 缺少 `1m`，未知值按 snapshot 默认 `1h` 处理。本次统一发同一观察窗口的明确起止点。其 raw SQL 使用 `>= start` 与 `< end`；`mode=auto` 可使用整小时预聚合并补 raw 头尾。趋势桶仍为 60/300/3600 秒，官方 snapshot 的缓存键以 RFC3339 秒精度格式化，不能将这个接口描述成与另一次日志分页查询逐毫秒原子一致。

### 认证与可见范围

管理员 API key 用 `x-api-key`，JWT 用 `Authorization: Bearer ...`，与 [admin auth middleware][u-auth] 一致。统一来源读取器用对应连接自身的凭据，过期 JWT 直接报不可用，不为另一个实例自动登录。主成本读取以连接快照和请求序号检查陈旧响应。

当前官方 scoped admin usage 响应保留原始 Token、金额及账号价格快照字段，仅限制相关嵌套资源。账号/usage 的实际可见范围仍受部署授权影响；本次没有取得用户部署上的权限范围清单，所以“全局”只能表示该连接实际可读取的范围。

## 3. 确认并修复的问题

### 3.1 历史账号用量在经济汇总中再次被丢弃

上游账号软删除而 usage 独立保留。原始日志聚合已保留这些 ID，但 `deriveLoadedEconomics` 又只遍历当前账号清单，导致真实请求对应的营收和账号价格快照从最终经济汇总消失。

修复后：

- 全部账号范围保留 usage 中全部 ID；显式筛选 usage-only ID 也能找到它。
- 平台筛选只使用当前账号或保留损失档案中有证据的平台；未知平台不硬塞给某个平台。
- 原始请求数、Token、客户扣费、标准价和账号倍率快照均保留。
- 不创建假的零采购账号来补足元数据。缺采购档案时，完整采购总额、完整经济成本、毛利、回本和预测为未知，数据质量为 partial。
- 完整日志仍能证明账面金额及金额/小时；依赖账号档案的容量调整预测则为未知，预测置信度 unavailable，不让已知小时率冒充可完成的容量预测。
- 现有非空字段 `procurement_accrued_cny` 保留已知档案的小计，并有明确警告，不能解释为完整采购总额。

独立端到端夹具同时有当前账号与已删账号：已删账号请求 1、Token 360、标准值 20、客户扣费 44、账号统计基数 6、倍率 0.25；最终保留其账号金额 1.5，与当前账号合计 2.5，客户扣费合计 53，采购/毛利仍未知。

### 3.2 部分窗口不能变成完整窗口预测

此前部分已读样本可在本地经济回退中被重新标为 estimated，并用于整个观察窗口速率和毛利推算。现在 partial/stale 的请求覆盖状态继续传到经济结果，已读金额保留，无法支持的完整窗口预测、回本及贡献值为 null。完整、真实的零金额与零采购控制案例仍保持 0。

### 3.3 配额降级响应被视为成功刷新

之前仅看 Promise fulfilled，HTTP 200 带错误也会得到 measured，并占用 5 分钟成功缓存；旧配额在网络失败后也缺少历史标记。

现在识别 `error` 和 `error_code`：有可证实窗口则 partial，无可证实窗口则 unavailable；可保留先前有效窗口和原采集时间，明确标为历史/本次失败。降级响应不推进成功 TTL，下一次刷新可重试；真正成功响应会清除旧错误，真实 0% 保留。失败响应的更新时间不伪装成有效配额的采集时间。

失败提示使用通用安全文案；只保留白名单机器错误码，不把异常字符串中的 URL、Authorization 或 API key 显示出来。

### 3.4 一分钟运行质量实际请求了一小时

`time_range=1m` 不在官方 Ops 支持列表，会静默回到 1h。已将该接口所有范围改成同次捕获的 `observationStart/observationEnd`，避免短窗口回退和服务端重新取 now 引入不同窗口。没有改变源连接认证绑定，也没有更换原本的 `mode=auto` 或运行质量指标口径。

## 4. 回归证据

所有失败均在对应实现修复前执行；没有删减原断言。

| 组别 | 修复前结果 | 反例内容 |
| --- | --- | --- |
| 经济汇总 5 个新增案例 | 4 失败、精确零控制通过；该文件合计 4 失败 / 8 通过 | 历史 ID 被丢；显式选择缺档案 ID 得到假零；未归属/平台筛选；部分窗口被当完整估算 |
| 配额 4 个新增案例 | 4 失败；原窗口案例 29 通过 | 200+error 有窗口、200+error_code 无窗口、错误占成功 TTL、不正确刷新旧窗口时间/状态 |
| Ops 3 个新增案例 | 2 失败、today 控制通过；该文件 2 失败 / 34 通过 | 1m 把 30 分钟前请求也算进来；7d 没有固定起止点，加载期间时钟变化；本地 today 起点 |
| 缺档案案例的容量预测加强断言 | 加强前 1 失败 / 11 通过 | 原始小时率可证实，但容量预测置信度仍是 low；修复后标 unavailable、容量调整值未知 |
| 修复后的三个专项文件 | **54 通过，0 失败** | `derivedEconomics.spec.ts`、`sub2apiAccountWindow.spec.ts`、`unifiedSourceReader.spec.ts` |

复核命令：

```sh
corepack pnpm test:run \
  src/features/cost-center/__tests__/derivedEconomics.spec.ts \
  src/features/cost-center/__tests__/sub2apiAccountWindow.spec.ts \
  src/features/cost-center/__tests__/unifiedSourceReader.spec.ts \
  --maxWorkers=1
```

另执行 `modelCostAnalysis.spec.ts`：**42 通过，0 失败**。其中已有源端账号金额 COALESCE、倍率缺失回退、倍率真实 0、旧格式以及价格/营收分离断言；字段公式以官方 SQL 为依据，而不是自定义更换采购算法。

最终将上述四个文件合并复跑：**4 文件 / 96 测试通过，0 失败**，日志 `sub2api-contract-final.log`；相关 TypeScript、专项测试与翻译文件的 ESLint 通过。

## 5. 可确认范围与未确认边界

- 可确认：上述固定提交中的路由、请求参数、DTO、SQL 字段含义、软删除关系，以及本项目消费路径和修复反例。
- 不能确认：用户当前服务的版本、用户安装的自定义扩展、真实供应商账单、实际采购资料、账号凭据有效性、真实请求是否全部入账、日志保留期和远端删除情况。
- 25,000 条日志是有意设置的读取上限；达到上限或后续页失败，只能给样本小计/partial，不能宣布完整窗口已对账。
- 上游按 offset 分页，没有客户端可用的事务快照或固定 as-of 游标；读取期间新增/删除数据可能导致跨页漂移。去重能防止重复累加，不能证明绝无漏项。
- 有记录缺少成本或 Token 分项时，已知小计与未知维度必须分开。一次成功 HTTP 响应也不保证该部署采集了所有请求。
- 可选 economics、cost-loss、pricing status/refresh 服务不属于已固定的官方提交。其存在性、内部公式及用户真实账目需要对应扩展源码或部署响应才能继续确认。
- 本次没有发布新版、推送代码或创建安装包；是否继续发布由主任务统一处理。

[u-auth]: https://github.com/Wei-Shaw/sub2api/blob/6b4b37db43443b5e88e424fe3c69602cc3810dfb/backend/internal/server/middleware/admin_auth.go
[u-routes]: https://github.com/Wei-Shaw/sub2api/blob/6b4b37db43443b5e88e424fe3c69602cc3810dfb/backend/internal/server/routes/admin.go
[u-usage-handler]: https://github.com/Wei-Shaw/sub2api/blob/6b4b37db43443b5e88e424fe3c69602cc3810dfb/backend/internal/handler/admin/usage_handler.go
[u-usage-query]: https://github.com/Wei-Shaw/sub2api/blob/6b4b37db43443b5e88e424fe3c69602cc3810dfb/backend/internal/repository/usage_log_repo_query.go
[u-usage-stats]: https://github.com/Wei-Shaw/sub2api/blob/6b4b37db43443b5e88e424fe3c69602cc3810dfb/backend/internal/repository/usage_log_repo_stats.go
[u-usage-service]: https://github.com/Wei-Shaw/sub2api/blob/6b4b37db43443b5e88e424fe3c69602cc3810dfb/backend/internal/service/usage_log.go
[u-dto]: https://github.com/Wei-Shaw/sub2api/blob/6b4b37db43443b5e88e424fe3c69602cc3810dfb/backend/internal/handler/dto/types.go
[u-account-handler]: https://github.com/Wei-Shaw/sub2api/blob/6b4b37db43443b5e88e424fe3c69602cc3810dfb/backend/internal/handler/admin/account_handler.go
[u-account-schema]: https://github.com/Wei-Shaw/sub2api/blob/6b4b37db43443b5e88e424fe3c69602cc3810dfb/backend/ent/schema/account.go
[u-account-usage]: https://github.com/Wei-Shaw/sub2api/blob/6b4b37db43443b5e88e424fe3c69602cc3810dfb/backend/internal/service/account_usage_service.go
[u-admin-account]: https://github.com/Wei-Shaw/sub2api/blob/6b4b37db43443b5e88e424fe3c69602cc3810dfb/backend/internal/service/admin_account.go
[u-dashboard-snapshot]: https://github.com/Wei-Shaw/sub2api/blob/6b4b37db43443b5e88e424fe3c69602cc3810dfb/backend/internal/handler/admin/dashboard_snapshot_v2_handler.go
[u-dashboard]: https://github.com/Wei-Shaw/sub2api/blob/6b4b37db43443b5e88e424fe3c69602cc3810dfb/backend/internal/handler/admin/dashboard_handler.go
[u-ops-snapshot]: https://github.com/Wei-Shaw/sub2api/blob/6b4b37db43443b5e88e424fe3c69602cc3810dfb/backend/internal/handler/admin/ops_snapshot_v2_handler.go
[u-ops-handler]: https://github.com/Wei-Shaw/sub2api/blob/6b4b37db43443b5e88e424fe3c69602cc3810dfb/backend/internal/handler/admin/ops_handler.go
[u-ops-repo]: https://github.com/Wei-Shaw/sub2api/blob/6b4b37db43443b5e88e424fe3c69602cc3810dfb/backend/internal/repository/ops_repo_dashboard.go
[u-channel-handler]: https://github.com/Wei-Shaw/sub2api/blob/6b4b37db43443b5e88e424fe3c69602cc3810dfb/backend/internal/handler/admin/channel_handler.go
