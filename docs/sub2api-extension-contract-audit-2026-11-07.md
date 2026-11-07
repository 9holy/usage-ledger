# Sub2API 可选成本扩展与接入面板补充核验（v0.2.39）

## 范围和可确认结论

本报告以 Usage Ledger `be0318c0a6caf93c62d810774cf3a06e46bfbf30`（v0.2.38）为基线，补完 [原 Sub2API 契约报告](sub2api-data-contract-audit-2026-11-07.md) 中可选 economics / cost-loss / pricing 的实际调用链，以及成本页 `CostApiAccessPanel` 的全部数据读接口。上游固定为 [Wei-Shaw/sub2api@6b4b37db43443b5e88e424fe3c69602cc3810dfb](https://github.com/Wei-Shaw/sub2api/tree/6b4b37db43443b5e88e424fe3c69602cc3810dfb)。

结论分为三类：

1. **已取得并核验真实生产实现：**当前用户 API Key 分页清单、公开 API 地址设置、按业务 key 返回的模型清单，以及它们的页面消费、异步连接/密钥绑定。发现并修复第一页 100 项截断、旧请求覆盖新连接/新 key、畸形 HTTP 200 被标健康、过期 key 仍保持选中等问题。
2. **已核验本项目消费及失败处理，但没有取得扩展生产者：**economics snapshot、cost-loss 状态和远程 pricing 状态/刷新。不能把 TypeScript DTO 和接口包装当服务端实现；本轮没有创造一个新收费后端来“补证”。对确实会制造假数据的 cost-loss / pricing 响应边界已加验证。
3. **已查明根本没有本页调用：**cost-loss confirm / refund / reverse 三个写包装。它们不是用户在本页录入的 native 财务账本。

未取得扩展生产者是源码证明边界，不应被“真实账单未对账”含糊替代。真实部署/账号对账另外没有执行；两者是不同限制。

## 1. 可选成本扩展：参数 → 本地 DTO → 实际消费

| 接口 | 请求路径 / 参数 / 目标 | 本项目实际消费 | 生产者核验及当前行为 |
| --- | --- | --- | --- |
| `getEconomicsSnapshot` | `GET /admin/accounts/economics/snapshot`；`scope,platform,account_ids` CSV、`cny_per_usd,exchange_rate_source,window_hours`；`getCostServiceBaseURL()` + `_explicitBaseURL:true` | `useCostCenterData.loadAccountEconomics` → `AccountEconomicsSnapshot` 的 actual、health、projection、data_quality、series、events；View 以自身精确窗口和财务/用量事实重算经营合计 | 已核实请求字段和调用者。固定官方完整源码未找到该路由/生产服务。本地没有对应 server。响应只按声明的扩展 DTO 兼容，不证明其采样、账号筛选、时区、持久化或预测算法；不可用时走自有 `deriveLoadedEconomics`，不伪造远端账。 |
| `listCostLossStates` | `GET /admin/accounts/cost-loss-states`；无分页 / 日期参数；同一可选成本服务目标 | `states[]` → 当前/删除账号的 account_id、历史 profile、终止时间、accrued/net loss、active/deleted → 本地经济模型与财务消费 | 生产服务未取得，不能保证扩展输出是完整账本。本轮拒绝缺 states、非数组、坏身份/日期/金额/币种/profile；这些结果进入已有 unavailable 分支，不能把 `{}` 当空损失账。明确 `states:[]` 和合法 0 保留。 |
| `confirmCostLoss` | `POST /admin/accounts/:id/cost-loss/confirm`；可选 message/status_code/upstream_code/occurred_at/idempotency_key；可选成本服务 | 仅导出，无非测试页面调用 | 没有证据证明服务侧幂等键、终止处理或事务语义；本轮未执行。 |
| `recordCostLossRefund` | `POST /admin/accounts/cost-loss-events/:eventId/refund`；amount、可选 message/occurred_at、idempotency_key；可选成本服务 | 仅导出，无非测试页面调用 | 没有服务侧退款到账/上限/并发实现证据；本轮未执行。 |
| `reverseCostLoss` | `POST /admin/accounts/:id/cost-loss/reverse`；无 body；可选成本服务 | 仅导出，无非测试页面调用 | 没有服务侧冲销审计/事务实现证据；本轮未执行。 |
| `getPricingStatus` | `GET /admin/channels/pricing/status`；**正常 Sub2API 主服务目标**，不是独立 costServiceUrl | `reload` → `pricingStatus` → 目录模型数、更新时间、源是否同步、刷新间隔、离线 fallback 标记 | 官方固定提交无该路径。本轮验证实际消费的字段；缺失/错型的 HTTP 200 拒绝而非标“同步”或 0 个模型。合法 0 模型和 false fallback 保留。 |
| `refreshPricing` | `POST /admin/channels/pricing/refresh`；正常 Sub2API 主服务，无 body | 价格目录按钮仅在 Sub2API 分支调用；其他两端调用本项目 native 目录刷新 | 与状态读取共享边界验证。无扩展 producer，不能声称确认下载 URL、更新任务、价格内容或服务内部刷新成功；本轮仅合成响应测试，无真实刷新写请求。 |

本地证据文件：`src/api/admin/accounts.ts`、`src/api/admin/channels.ts`、`src/api/admin/costExtensions.ts`、`src/api/url.ts`、`src/api/client.ts`、`src/features/cost-center/useCostCenterData.ts`、`src/views/admin/CostCenterView.vue`。

`costExtensions.ts` 的检查是**本项目消费者能安全解释的最小合同**，不是一个自行补出来的上游算法。它检查损失记录所需的源账号标识、日期、币种、已给定金额与档案；不计算或校正 `gross_loss - refund - reversal`，不篡改用户成本公式。pricing 的刷新间隔必须是可解释的正小时值；缺失/0 不再被当作宣称已核实的 24 小时刷新。

### 源码搜索范围和不存在结论的强度

本轮不仅搜索官方 route 注册，也检索了整个固定官方后端、前端、测试、配置和迁移树；关键词包括完整路径、`cost_loss`、`CostLoss`、`EconomicsSnapshot` 和 pricing/status/refresh。固定官方树没有相应实现。可复现核心检索：

```bash
rg -n 'cost-loss|economics/snapshot|pricing/status|pricing/refresh|cost_loss|CostLoss|EconomicsSnapshot' .
```

本仓库的对应命中是 TypeScript DTO/客户端、调用者和测试；原生 [`proxy.rs`](../src-tauri/src/proxy.rs) 的 Router 是 `/`、`/*path` 的通用转发器，`forward` 不生产经济采样或成本账。自有模型目录和 native 财务服务在本仓库另有实现，但不是这些远端 HTTP 路由的后端。目录/模型默认参考价的官方 [Channel handler](https://github.com/Wei-Shaw/sub2api/blob/6b4b37db43443b5e88e424fe3c69602cc3810dfb/backend/internal/handler/admin/channel_handler.go) 与 [admin 路由](https://github.com/Wei-Shaw/sub2api/blob/6b4b37db43443b5e88e424fe3c69602cc3810dfb/backend/internal/server/routes/admin.go) 不能证明可选扩展也存在。

另外查看了 GitHub 连接器当时可见的 `9holy` 仓库清单，并查询 `9holy/sub2api`（404）及成本扩展关键词，没有取得另一个相应 producer 仓库。**公开搜索无结果不能证明全世界不存在实现，也不能排除私有服务、其他组织/分支或未索引仓库。**因此保留“未取得生产源码”，不写成“该功能不存在”。后续若取得精确成本服务仓库/提交，还需补核 DTO、账号过滤、窗口含义、数据事务和幂等性。

## 2. CostApiAccessPanel 的全部实际读接口

此组件只在 Sub2API 成本页的 API 接入分支挂载。它与当前上游账号池、采购档案和 native 财务账是不同数据域。

| 接口及实际请求 | 生产实现 / 输出 | 页面消费及已核验语义 |
| --- | --- | --- |
| `GET /api/v1/keys?page=N&page_size=100&sort_by=created_at&sort_order=desc` | [JWT 用户路由](https://github.com/Wei-Shaw/sub2api/blob/6b4b37db43443b5e88e424fe3c69602cc3810dfb/backend/internal/server/routes/user.go) → [APIKeyHandler.List](https://github.com/Wei-Shaw/sub2api/blob/6b4b37db43443b5e88e424fe3c69602cc3810dfb/backend/internal/handler/api_key_handler.go#L105-L148) → 当前 subject.UserID → [ListByUserID](https://github.com/Wei-Shaw/sub2api/blob/6b4b37db43443b5e88e424fe3c69602cc3810dfb/backend/internal/repository/api_key_repo.go#L438-L485)；[排序与 ID tie breaker](https://github.com/Wei-Shaw/sub2api/blob/6b4b37db43443b5e88e424fe3c69602cc3810dfb/backend/internal/repository/api_key_repo.go#L654-L697) | `keysAPI.list` 取得标准分页 `items,total,page,page_size,pages`；id/name/key/status/group 用于选择与配置。它列的是**当前登录用户的业务 API Key**，不是整个上游账号清单，也不是管理员身份下所有用户的 key。管理员静态 API-key 连接未获该 JWT 用户接口授权时显示 unavailable，不能说没有 key。 |
| `GET /api/v1/settings/public` | [GetPublicSettings](https://github.com/Wei-Shaw/sub2api/blob/6b4b37db43443b5e88e424fe3c69602cc3810dfb/backend/internal/handler/setting_handler.go#L39-L75) 输出公共 DTO，包括 api_base_url | `authAPI.getPublicSettings` → 网页模式推荐 business base；桌面模式优先当前连接 base。去掉 admin API 后缀，再形成 `/v1` 地址。设置不是已测网络健康或账务来源。旧连接设置响应不能落入新连接。 |
| 用户点击诊断后的 `GET {gatewayBase}/models`，Bearer **所选业务 key** | [gateway 路由](https://github.com/Wei-Shaw/sub2api/blob/6b4b37db43443b5e88e424fe3c69602cc3810dfb/backend/internal/server/routes/gateway.go#L177-L209) → APIKeyAuth / group / model allowlist → [Models](https://github.com/Wei-Shaw/sub2api/blob/6b4b37db43443b5e88e424fe3c69602cc3810dfb/backend/internal/handler/gateway_handler.go#L1150-L1221)；普通响应 [writeModelsListResponse](https://github.com/Wei-Shaw/sub2api/blob/6b4b37db43443b5e88e424fe3c69602cc3810dfb/backend/internal/handler/openai_models_handler.go#L66-L79) 为 `{object:'list',data:[{id,...}]}` | `fetchGateway('/models',...,capturedBase)` → model IDs、诊断耗时和状态。可用模型受该 key 的组、平台、白名单及上游目录决定；未按本页 upstream account_id 探测。此请求不带 Codex client_version，不会主动请求 Codex manifest。 |

Pinned OpenAI 目录也沿上游 [openai_models_list.go](https://github.com/Wei-Shaw/sub2api/blob/6b4b37db43443b5e88e424fe3c69602cc3810dfb/backend/internal/service/openai_models_list.go) 归一为普通 data[].id 列表；对应 [生产测试](https://github.com/Wei-Shaw/sub2api/blob/6b4b37db43443b5e88e424fe3c69602cc3810dfb/backend/internal/service/openai_models_list_test.go#L62-L71) 将 OAuth manifest 转成列表。组件保留原有 `models[]` 兼容解析，但那属于兼容能力，不能说固定官方 `/v1/models` 主契约就是此形状。两种接受的形状都必须提供实际非空字符串 model identifier；HTTP 200 的 HTML、null、空对象或坏 entry 不能标为健康。合法 `data:[]` 是确知空目录，仍可证明本次目录请求被接受。

### 分页、账号关联和异步闭环

- 依据上游 [分页响应结构](https://github.com/Wei-Shaw/sub2api/blob/6b4b37db43443b5e88e424fe3c69602cc3810dfb/backend/internal/pkg/response/response.go#L120-L138) 读取后续页，不再停在 100 条。按 id 去重，并检查 total/page_size/pages 一致性与无进展；后页失败保留已读项并明确 partial。
- 一次最多读取 100 页、10,000 个 key。达到上限仍有记录时显示未完整读取，不宣称已覆盖全部。上游没有事务快照游标；可发现总数变化或重复项，不能证明全程没有无法观测的等量增删。
- key 列表、public settings 和模型诊断都捕获连接 revision；同连接 ID 改 URL 或管理认证 key 仍视为另一批。新来源清除旧列表/诊断，过时结果不回填。
- 模型请求还绑定所选业务 key 的 ID、内容及 gateway base；切换 key、同 ID key 内容变化、连接改变或组件卸载时中止/作废旧请求。过期/停用 key 不再作为有效选择保留。
- 控制台内按钮只诊断模型清单；生成用量的是用户之后执行的配置示例。本轮没有实际发起目录探测或生成请求。清单请求成功不证明模型生成、所有 upstream 账号或真实余额均健康。
- Clipboard / `/keys` 管理导航不读取其他数据接口；opsOverview 延迟来自父组件传入的 ops 数据，不能与本次 gateway 模型清单耗时混为同一测量。

## 3. 本页实际成本档案/账本写入路径的区分

Sub2API 的 Inspector 保存通过普通账号 `PUT /admin/accounts/:id` 或 bulk update 写 `extra.cost_profile`；这是本项目明确录入的采购参数，生产路由/extra 持久化已在原报告核验。本轮修复 Inspector 空金额变 0，对三端共用编辑器生效，明确数值 0 仍合法。

CPA/Cockpit 本地档案通过 native JSON 读写，坏数据和读失败闭环见 [CPA 接口补充核验](cliproxy-interface-coverage-2026-11-07.md)。三端页面的 CostEventsPanel / FinanceBatchEditor 使用本项目 native finance_ledger_*，见 [财务专项报告](finance-data-contract-audit-2026-11-07.md)。**这不是 confirmCostLoss / recordCostLossRefund / reverseCostLoss 三个无人调用的远端包装。**先前报告中把它们概括为“终止损失/退款/冲销账本”只能理解为 DTO 的意图，不能理解为本页真实执行了这些服务请求。

## 4. 合成反例与验证

| 测试组 | 修复前 | 修复后及保留断言 |
| --- | --- | --- |
| `CostApiAccessPanel.spec.ts` | 10 failed / 2 passed | 12/12：第 101 项可见；第二页失败 partial；同 ID URL/key 变化拒绝旧列表；选 key 后旧模型不回填；坏 200 不健康；合法空列表/空模型保留；expired key 失效 |
| `admin.costExtensions.spec.ts`，固定 v0.2.38 客户端两文件隔离载入 | 22 failed / 2 passed | 24/24：缺 states 与坏条目拒绝；合法空账、0 金额、inactive/deleted 快照保留；pricing 读/refresh 坏 DTO 拒绝，明确 0 模型和 false fallback 保留 |
| 共用本地档案/编辑器/CPA 生命周期 | 见 CPA 补充报告中真实旧红反例 | 7 文件 69/69（含 API 接入面板）；加扩展边界后相关定向合计 8 文件 93 项通过，无跳过 |

验证只使用合成 fixture 和固定源码。写接口只验证请求/响应边界和已有消费，未访问真实 key、财务数据或扩展服务。最终全量门禁和发布结果由本轮总报告记录。

## 5. 完成度的准确表述

可以确认本页实际接口和调用者已枚举，官方有生产源码的三条接入数据链已核验，发现的漏页、来源错配、真假空值和损坏扩展响应已修复。可选扩展的客户端边界、目标地址、失败处理和无人调用写包装也已查清。

仍不能确认可选成本服务内部的账目、窗口采样、账号生命周期、退款/冲销幂等和 pricing 刷新实现，因为未取得其 producer 源码。这不应写成“已核实正确”，也不等同于仅欠真实账单抽查。官方不提供扩展接口与官方已提供但本项目未读，是两种不同情况；本轮没有继续将前者掩盖为 0 或空账。
