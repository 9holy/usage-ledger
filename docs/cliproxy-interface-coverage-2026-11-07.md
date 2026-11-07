# CLIProxyAPI 成本页实际接口补充核验（v0.2.39）

## 核验对象和结论

本报告补充 [v0.2.38 数据契约审计](cliproxy-data-contract-audit-2026-11-07.md)，基线为 Usage Ledger `be0318c0a6caf93c62d810774cf3a06e46bfbf30`。从 `CostCenterView.vue`、`useCostCenterData.ts`、`useUnifiedCost.ts` 及实际挂载的子组件逐一追踪调用，没有把 API 模块中的所有导出都算作页面实际调用。

本项目直接消费的五个 CPA 管理 HTTP 读接口、两条 CPA 本地源读取、版本元数据、成本档案读写和页面相关来源守卫，已经对照固定源码核验。已修复错误版本字段、连接变化后的旧响应覆盖、档案损坏被默认估算接管、空采购金额被当作免费等实际问题。自有成本公式没有改变。

结论的限制是明确的：源码契约和合成数据反例不等于真实部署、用户账号或账单已经对账；外部 `management.html` 是委托页面，用户可自行替换其版本。其生产接口来源已列明，不能替用户确认当前运行的是本报告中的 UI 提交。

### 固定主源

| 主源 | 固定提交 |
| --- | --- |
| [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI/tree/c5251b57b3fa5dcbc689f514f4aa166daacb4481) | `c5251b57b3fa5dcbc689f514f4aa166daacb4481` |
| [kaitranntt/CLIProxyAPIPlus](https://github.com/kaitranntt/CLIProxyAPIPlus/tree/0341bcc440583738d7d0e673abefc63bbe99e131) | `0341bcc440583738d7d0e673abefc63bbe99e131` |
| [zhumengling/codex-token-usage](https://github.com/zhumengling/codex-token-usage/tree/8dffcb71ce8d99ce1a45fcf39d1dcb63879e44b6) | `8dffcb71ce8d99ce1a45fcf39d1dcb63879e44b6` |
| [router-for-me/Cli-Proxy-API-Management-Center](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/tree/953fb2444350c6c36052dda46cac0abce6b23ea6) | `953fb2444350c6c36052dda46cac0abce6b23ea6` |
| [kaitranntt/Cli-Proxy-API-Management-Center](https://github.com/kaitranntt/Cli-Proxy-API-Management-Center/tree/5ce2be18df81b5e5c0390aa038f39357606e8f50) | `5ce2be18df81b5e5c0390aa038f39357606e8f50` |

## 1. 成本页直接消费的 CPA 管理 HTTP 链路

`CostCenterView.reload` 的 CPA 分支一次并行读取下表五个 HTTP 接口和两个本地源。随后等待汇率，再统一发布该批次的数据。主线当前同时注册 v8 管理路由及兼容的 `/v0/management` 路由；本项目走后者，见 [主线路由](https://github.com/router-for-me/CLIProxyAPI/blob/c5251b57b3fa5dcbc689f514f4aa166daacb4481/internal/api/server_management.go#L14-L33) 和 [Plus 路由](https://github.com/kaitranntt/CLIProxyAPIPlus/blob/0341bcc440583738d7d0e673abefc63bbe99e131/internal/api/server_management.go)。

| 实际请求（相对 `/v0/management`） | 生产参数 / 输出 | 本地读取 → 消费 | 结果与边界 |
| --- | --- | --- | --- |
| `GET /auth-files`，不带分页参数 | `ListAuthFiles` 返回 `files`；正常管理器记录包含 `auth_index`、状态和认证元数据；磁盘回退只提供有限文件元数据。[生产者](https://github.com/router-for-me/CLIProxyAPI/blob/c5251b57b3fa5dcbc689f514f4aa166daacb4481/internal/api/handlers/management/auth_files.go#L106-L200) | `getAuthFiles` → `cliproxyAuthFilesToAccounts` / `loadFromCliproxy` → 当前管理实体、历史槽、来源状态 | 清单无分页遗漏；坏列表拒绝，确知空列表保留。当前实体与历史认证槽的 owner / 类型 / 套餐边界沿用前报告，不能将当前邮箱追溯到整段历史。 |
| `GET /config`，无查询参数 | `GetConfig` 返回配置对象，配置未初始化时 `{}`；路由配置在 `routing.strategy`；JSON 中没有运行版本字段。[生产者](https://github.com/router-for-me/CLIProxyAPI/blob/c5251b57b3fa5dcbc689f514f4aa166daacb4481/internal/api/handlers/management/config_basic.go#L26-L33) | `getConfigSnapshot` → `loadFromCliproxy(config)` 与管理概览 | 配置仅作为本页设置来源可读的证据，调试和路由展示另有明确端点。空对象不再作为已加载设置。非对象 / 数组拒绝。 |
| 同一次 `/config` 响应的 `X-CPA-VERSION` | 管理中间件写入 Version / Commit / BuildDate / 插件支持响应头；不是 config body 字段，也不是 latest release。[中间件](https://github.com/router-for-me/CLIProxyAPI/blob/c5251b57b3fa5dcbc689f514f4aa166daacb4481/internal/api/handlers/management/handler.go#L324-L346)；[CORS 暴露头](https://github.com/router-for-me/CLIProxyAPI/blob/c5251b57b3fa5dcbc689f514f4aa166daacb4481/internal/api/server_middleware.go#L26-L45) | `getConfigSnapshot.reportedVersion` → `cliproxyOverview.version` | 只显示该响应服务报告的运行版本；缺头未知；大小写不敏感。不把未签名响应头当身份认证或二进制证明。版本与本批连接 revision 绑定。 |
| `GET /debug` | `{debug:boolean}`，包括明确 `false`。[生产者](https://github.com/router-for-me/CLIProxyAPI/blob/c5251b57b3fa5dcbc689f514f4aa166daacb4481/internal/api/handlers/management/config_basic.go#L203-L206) | `getDebug` → 管理概览 | 不把缺字段或字符串当 `false`；明确 false 仍展示为关闭。失败结果为未知。 |
| `GET /routing/strategy` | `{strategy:string}`；上游归一化 rr / wrr / ff，未知配置值以 trim 后原值输出。[生产者](https://github.com/router-for-me/CLIProxyAPI/blob/c5251b57b3fa5dcbc689f514f4aa166daacb4481/internal/api/handlers/management/config_basic.go#L312-L336) | `getRoutingStrategy` → 管理概览 | 保留 `round-robin`、`weighted-round-robin`、`fill-first` 及未来非空策略；无值不补猜默认轮询。不是请求调度结果日志。 |
| `GET /api-key-usage` | 内存 API-key auth，按 provider（有 compat_name 时使用它）及 `base_url\|api_key` 分组；累计 success / failed 与 recent bucket 数组，manager 不可用返回 503。[生产者](https://github.com/router-for-me/CLIProxyAPI/blob/c5251b57b3fa5dcbc689f514f4aa166daacb4481/internal/api/handlers/management/api_key_usage.go#L12-L116) | `getApiKeyUsage` → `cliproxyKeyUsage`；`cliproxyUsageSummary` 已定义但当前页面无使用者 | 不是所有 OAuth 账号的历史账，更不能补齐本地 SQLite。验证非负整数及 bucket 形状，保留 0；未知 / 坏对象不变成空清单。 |

`recent_requests[].time` 特别核实：它是**本地时区 `HH:mm-HH:mm` 展示标签**，20 个 10 分钟桶；不是 ISO 时间戳，不包含日期或时区。证据为 [SDK 的 label formatter 与 snapshot](https://github.com/router-for-me/CLIProxyAPI/blob/c5251b57b3fa5dcbc689f514f4aa166daacb4481/sdk/cliproxy/auth/types.go#L427-L474)，Plus 相同。新增 `23:50-00:00` / `00:00-00:10` 零计数反例；不能从该标签恢复跨日历史账。

管理鉴权走当前连接的 Bearer 管理 key；上游也支持 `X-Management-Key`。本次只检查代码和合成响应，没有读取真实密钥或请求服务。客户端和页面均捕获连接 revision；同一个连接 ID 修改 URL 或 key 后，旧成功、旧 401 以及等待汇率期间的整批旧数据都不能覆盖新连接。

## 2. 实际本地读取、自有档案和公共页面通路

| 调用 | 生产 / 存储来源 → DTO | 实际消费者与核验结果 |
| --- | --- | --- |
| Tauri `read_cliproxy_usage_events({withMetadata:true})` | 本机插件 `usage.db` / `usage_events` → `CliproxyUsageSnapshot`；默认读取最近 30 天，显式窗口使用毫秒起止点并在 SQLite 秒时间精度上筛选；元数据记录 available、读取范围、sourceInstanceId | `cpaData.getCliproxyUsageSnapshot` → `loadFromCliproxy` → 按槽账号、今日/滚动窗口用量、请求失败、模型、趋势、配额槽。路径、token、去重、NULL、source identity 证据见前报告；并非远程管理库。 |
| Tauri `read_cliproxy_model_prices` | `CPA_MODEL_PRICE_FILE` 覆盖或同一插件数据目录中的 `model_prices.cache` → LiteLLM 每-token 参考价格对象 | `getCliproxyModelPrices` → 本地计价依据与模型归类。自定义路径、相对路径拒绝、缺价未知沿用前报告；不把它当供应商实付账单。 |
| Tauri `model_catalog_quote_batch({items})` | `cliproxyQuoteInput` 只传入已证实分类的 token、模型、时间和实际/请求模式；本项目 native 目录报价 → 自有 `MonitorCostEstimate` | 逐事件附加 `priceQuote`；计价算法属于本项目。分类闭合失败 / 缺单价继续留未知与已知小计；未引入上游收费算法。 |
| 汇总页 CPA 入口 | `useUnifiedCost.loadUnified` 复用具有覆盖范围的注入快照，否则用显式窗口调用前两个本地读接口 | `sourceInstanceId` 与读取范围共同限定可复用数据；成功空窗可为 0，源不可读不能为 0。没有新增远端统计接口，也不会消费 usage queue。 |
| Tauri `read_cost_profiles` | 本项目 `cockpit_cost_profiles.json`：只有文件不存在返回 `{}`，实际读取错误返回 Err；前端 JSON 顶层及实际消费档案字段严格验证 | `preloadLocalCostProfiles` → 源限定 ID 的 `extra.cost_profile` → View 固定采购成本。损坏、null、字符串、负金额、无效币种/周期/日期拒绝；明确数字 0 保留。未归属旧数字键原样保留，不猜归属。 |
| Tauri `write_cost_profiles({json})` | `saveCockpitCostProfile` / bulk / 全局 multiplier 都先成功读旧 map，再合并、校验和 native 原子替换 | CostProfileInspector 只发本项目保存事件；空输入不能变 0。失败读取不能以空 map 覆盖旧文件。全局 multiplier 是本项目明确配置，账号档案仍按完整来源 ID 隔离。 |
| 本地档案读取失败的消费结果 | 同一源限定 ID 的此前有效档案可保留为 stale；其他档案未确认 | 不借其他目录相同槽的档案。`accountEconomics` unavailable；View 完整费用/费率和月采购合计未知，实际请求、用量、自算 token 值与已知财务小计保留。不是抹掉账，也不是改计算公式。 |
| 本地目录状态 / 手动刷新 | `model_catalog_status`、`model_catalog_refresh`；CPA / Cockpit 按钮走本项目本地目录，Sub2API 按钮另走远程扩展 | `loadLocalCatalog` → 目录状态、模型数和本地参考依据。不能将这条通路混写成 CPA `/plugins` 或远端 pricing/refresh。 |
| 本页财务子组件 | 本项目 `finance_ledger_query/save/void/save_batch/get_batch/void_batch/related_events`，带 source / instance / account / 时间参数 | `CostEventsPanel`、`FinanceBatchEditor`、View 财务读取属于本项目账，不是 CPA 插件日志。具体契约与本轮修复见 [财务专项报告](finance-data-contract-audit-2026-11-07.md)。 |

汇率通道也独立于 CPA：`exchangeRate.ts` 依次采用用户覆盖、参考汇率缓存/网络和明确的离线兜底，返回 `source`；不是管理接口回传的实际结算汇率。本轮在所有异步读取完成后再次检查连接，才发布 FX 与 CPA 批次。

## 3. 页面可达管理操作、外部 UI 与未调用导出

### 本项目实际可达

`CostApiAccessPanel` 只在 Sub2API 分支挂载，不会为 CPA 成本页读取 `/keys` 或探测 `/v1/models`。`DataGovernancePanel`、图表、指标和 CPA 账号行消费 props / store；CPA 行显示历史延迟，不发 Sub2API 账号 test 请求。成本档案保存、目录刷新和自有财务操作已在上表列出。

CPA 的“管理”页是 `${configuredBase}/management.html` iframe；无 base 时仅该便利入口展示默认端口假设。它并非本项目通过 `management.ts` 实现的另一套配置 CRUD。

### 外部管理页的真实来源

主线默认面板仓库来自 [config_defaults.go](https://github.com/router-for-me/CLIProxyAPI/blob/c5251b57b3fa5dcbc689f514f4aa166daacb4481/internal/config/config_defaults.go#L3-L6)；Plus 配置了其对应仓库。上游 `remote-management.panel-github-repository` 与 asset updater 允许使用其他仓库/版本。此次固定的默认 UI 实际使用 `/v8/management`，见 [constants.ts](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/953fb2444350c6c36052dda46cac0abce6b23ea6/src/utils/constants.ts#L17) 与 [connection.ts](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/953fb2444350c6c36052dda46cac0abce6b23ea6/src/utils/connection.ts#L14-L18)。

| 默认 UI 的操作类别 | 固定源码中的实际接口来源 |
| --- | --- |
| 配置 / 开关 / 业务 key | `/config`、`/config.yaml` 及 `/config/...` 字段路径，GET / PUT / PATCH；[config.ts](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/953fb2444350c6c36052dda46cac0abce6b23ea6/src/services/api/config.ts)、[apiKeys.ts](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/953fb2444350c6c36052dda46cac0abce6b23ea6/src/services/api/apiKeys.ts) |
| 认证文件 / 状态 / 刷新 / 冷却 | `/credentials`、`/credentials/status`、`/credentials/fields`、`/credentials/refresh`、`/routing/cooldown/reset`，以及上传、下载、删除；[authFiles.ts](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/953fb2444350c6c36052dda46cac0abce6b23ea6/src/services/api/authFiles.ts#L545-L624) |
| 日志 | `/observability/logs`、`/observability/logs/errors` 及日志下载，读取与清理均由委托 UI 发起；[logs.ts](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/953fb2444350c6c36052dda46cac0abce6b23ea6/src/services/api/logs.ts) |
| OAuth | `/oauth/auth-url`、`/oauth/status`、`/oauth/session`、callback / SIWC；[oauth.ts](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/953fb2444350c6c36052dda46cac0abce6b23ea6/src/services/api/oauth.ts) |
| 插件 | `/plugins`、`/plugins/store`、插件安装/删除及 `/config/plugins/configs/...`；[plugins.ts](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/953fb2444350c6c36052dda46cac0abce6b23ea6/src/services/api/plugins.ts#L315-L370) |

该表说明页面委托了哪些生产接口，**不是完整外部管理 UI 或用户自定义 UI 的测试认证**。本轮没有发送任何实际配置写、删除、OAuth、安装或诊断请求。旧的 iframe 自动注入 `localStorage.managementKey` 只属便利兼容路径：固定主线 UI 的 [useAuthStore.ts](https://github.com/router-for-me/Cli-Proxy-API-Management-Center/blob/953fb2444350c6c36052dda46cac0abce6b23ea6/src/stores/useAuthStore.ts#L232-L255) 已清除旧明文键并使用自身存储封装；跨域也不能注入。因此不能声称对该 UI 版本已保证自动登录，用户登录该委托页面与成本数据读取是两条独立链路。

### 仅导出，没有本页实际调用

完整搜索 `src` 的非测试调用后，`management.ts` 中 latest-version、config YAML 读写、auth-file 下载/模型/删除、API keys CRUD、运行日志/错误日志、其他 runtime scalar、provider key CRUD、OAuth alias/exclusion/start/status/callback、插件管理、model-definitions、api-call 等包装没有被成本页或其子组件调用。`cliproxyConfigToOverview` 也没有调用者，不能把它的旧字段假设说成本页正在使用的逻辑。

`consumeUsageQueue` 没有任何展示调用。`GET /usage-queue` 会 `PopOldest`，不是无副作用读日志，证据与禁用展示用途见前报告。本轮没有为验证触碰真实 queue。运行日志和请求错误文件也没有被当作 token / 成本账；成本历史以本地 `usage_events` 为源。

## 4. 反例与验证记录

| 修复组 | 旧实现 / 旧候选的真实反例 | 修复后 |
| --- | --- | --- |
| CPA 版本和连接批次 | 2 文件 6 failed / 1 passed：版本误读 config body；同 ID 换 URL / key 后旧响应、旧 401、等待 FX 后的旧批次仍被接受 | Header 来源与客户端/批次 revision 守卫；保持 false、空清单与零计数 |
| 档案边界和空输入 | 2 文件 9 failed / 12 passed：null / 空串 / 数字字符串 / 负数 / Infinity / 坏单位日期；清空金额变免费 | 严格边界；明确 0、legacy 算法版本、未归属键保留 |
| 档案读取失败的消费 | store 3 failed / 10 passed；View 1 failed / 3 passed | 同源有效档案 stale；首次/异源失败无完整成本。用量 1 次、自算 0.4 USD、已知 2.8 CNY 小计保留 |
| 真实近期桶标签 | 新候选将 `time` 错当 Date.parse 日期，真实 `23:50-00:00` 测试 1 failed / 14 passed | 改为非空原始标签验证，不推断日期；该候选缺口在发布前关闭 |

最终相关定向组为 **7 个测试文件、69 项通过、0 跳过**：`clientScope`、`managementContract`、`costProfiles`、`CostProfileInspector`、`CostApiAccessPanel`、`costStoreIntegration`、`CostCenterCliproxyContract`。Sub2API 接入面板的生产者和反例见 [扩展与接入专项](sub2api-extension-contract-audit-2026-11-07.md)。统一类型、全量测试、构建和发布结果由本轮总报告记录，本报告不以定向通过代替全量门禁。

## 5. 没有被此核验消除的边界

- CPA schema 没有历史 owner 生命周期、主次窗口时长、完整响应模型审计和全部 pricing quality 元数据；这些是**已查明上游不提供**，不应列为“尚未去查”的接口。
- 本地插件实例和远程管理服务没有通用可证明的绑定标识；自定义目录不自动关联远端当前账号，不能凭地址相似推断同一账。
- 外部可替换管理 UI 的精确部署版本和自动登录行为没有被真实验证。默认源码接口已枚举，但用户自定义页面不在这份固定源码证明内。
- `cost_profiles` 是全 map 原子替换，不是多进程版本比较事务；此次保证失败读取不覆盖，并未声称解决多个独立写入者同时修改的合并冲突。
- 所有采购档案、财务事件和成本公式仍是本项目自有口径；未取得用户凭证或真实账单来认定金额已实际结算。
