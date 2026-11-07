# CLIProxyAPI / CPA 本地数据契约审计（2026-11-07）

> 本文件保留 v0.2.38 时点的核验记录。v0.2.39 已补完成本页实际管理接口、运行版本响应头、近期桶时间标签、连接批次及本地档案读失败闭环，见 [实际接口补充报告](cliproxy-interface-coverage-2026-11-07.md)；不要把历史范围说明当作这些通路仍未核验。

## 范围与结论

本次逐字段核对公开上游源码与 Usage Ledger 的读取、适配、账号分组及统计消费链路。成本单价、采购档案、财务事件和计算规则属于本项目；没有移植上游收费算法。本报告证明的是指定源码版本的数据契约及合成反例结果，**不代表已连接、抽查或对账用户的真实账号、服务、数据库和历史账单**。

固定的上游版本：

| 来源 | 仓库 | 固定提交 |
| --- | --- | --- |
| CPA Token Usage 插件 | [zhumengling/codex-token-usage](https://github.com/zhumengling/codex-token-usage/tree/8dffcb71ce8d99ce1a45fcf39d1dcb63879e44b6) | `8dffcb71ce8d99ce1a45fcf39d1dcb63879e44b6` |
| CLIProxyAPI 主线 | [router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI/tree/c5251b57b3fa5dcbc689f514f4aa166daacb4481) | `c5251b57b3fa5dcbc689f514f4aa166daacb4481` |
| CLIProxyAPI Plus | [kaitranntt/CLIProxyAPIPlus](https://github.com/kaitranntt/CLIProxyAPIPlus/tree/0341bcc440583738d7d0e673abefc63bbe99e131) | `0341bcc440583738d7d0e673abefc63bbe99e131` |

本地审计基线：`d21bb208672587d77f100e39dd8f33435040da83`。实现与回归测试位于同一修复分支。

## 源字段 → 本地读取 → 适配 → 消费矩阵

| 上游字段/接口 | 真实契约及证据 | 本地读取/适配 | 账号与统计消费、修复 |
| --- | --- | --- | --- |
| `CPA_TOKEN_USAGE_DIR` | 非空覆盖默认用户目录；`filepath.Clean` 不等于展开 `~`。见 [paths.go](https://github.com/zhumengling/codex-token-usage/blob/8dffcb71ce8d99ce1a45fcf39d1dcb63879e44b6/paths.go#L21-L60) | `main.rs::cliproxy_plugins_dir` → `cliproxy_usage_db::plugin_data_dir` | 修复只读固定默认目录。绝对覆盖目录产生稳定实例摘要；默认目录维持 `local` 兼容。相对覆盖依赖生产者 cwd，本项目没有其证据，明确拒绝并要求绝对路径。 |
| `CPA_MODEL_PRICE_FILE` | 独立覆盖，优先于数据目录默认 `model_prices.cache`。见 [paths.go](https://github.com/zhumengling/codex-token-usage/blob/8dffcb71ce8d99ce1a45fcf39d1dcb63879e44b6/paths.go#L63-L82) | `read_cliproxy_model_prices` | 自定义价格文件与数据目录各自遵守覆盖优先级；不再从另一个默认实例借价目。不存在的价格目录保持无目录语义。 |
| `usage_events` | 插件本机 SQLite 明细，非管理 API；当前字段见 [schema.go](https://github.com/zhumengling/codex-token-usage/blob/8dffcb71ce8d99ce1a45fcf39d1dcb63879e44b6/schema.go#L12-L57) | `read_cliproxy_usage_events` 只读 → `getCliproxyUsageSnapshot` → `scopedCliproxyEvents` | snapshot 与每条事件携带同一 `sourceInstanceId`。账号、窗口范围、档案键、财务查询和汇总来源标识统一使用该实例；拒绝跨实例混合批次。 |
| `requested_at`, `id` | 秒级时间，SQLite 自增 `id`；上游排序是时间和 id 双降序。见 [reporting.go](https://github.com/zhumengling/codex-token-usage/blob/8dffcb71ce8d99ce1a45fcf39d1dcb63879e44b6/reporting.go#L55-L60) | native 保留 `id`，`ORDER BY requested_at DESC, id DESC` | 同秒记录不再随机选配额快照；不把同秒、同模型、同 token 的两条真实记录去重。旧 schema 无 id 时保留兼容读取，不伪造持久序号。 |
| `auth_index` | 认证槽索引，文件路径/显式种子/API Key 等生成；文件原位换账号可能保留同索引。见 [auth/types.go](https://github.com/router-for-me/CLIProxyAPI/blob/c5251b57b3fa5dcbc689f514f4aa166daacb4481/sdk/cliproxy/auth/types.go#L580-L743) | `authIndexToAccountId`，默认旧 ID 不变；custom 使用实例命名空间 | 历史行明确称“认证槽”；不以当前 auth-file 邮箱、owner、类型、套餐或创建时间覆盖全部历史。用户显式录入的槽成本档案与财务记录保留，不猜生命周期、不搬迁旧账。 |
| `provider`, `executor_type`, `auth_type`, `alias`, `source` | 保存请求当时的原字段；`alias` 属于模型请求语义，并非账号姓名；没有 owner 生命周期字段。见 [main.go](https://github.com/zhumengling/codex-token-usage/blob/8dffcb71ce8d99ce1a45fcf39d1dcb63879e44b6/main.go#L301-L335) | 历史账号类型只用记录中的 `auth_type`，缺失保持未知 | 不用模型名称推断官方账号。兼容执行器标协议/中转来源；不透明 provider 保持未核实；明确原生 OAuth 才保留相应官方来源语义。 |
| 输入/缓存 token | 兼容 cache umbrella 与细分缓存见 [token_accounting.go](https://github.com/zhumengling/codex-token-usage/blob/8dffcb71ce8d99ce1a45fcf39d1dcb63879e44b6/token_accounting.go#L11-L24) | `cliproxyTokenBreakdown` 按 provider 规范化 | OpenAI/Gemini cache 为输入子集；Claude cache 与原始 input 独立。已有单价与自有算法不变，避免重复缓存计数。 |
| 输出/推理 token | Claude 原始 output 已含 thinking，而 canonical breakdown 才减去 thinking 分成独立桶。见 [usage_helpers.go](https://github.com/router-for-me/CLIProxyAPI/blob/c5251b57b3fa5dcbc689f514f4aa166daacb4481/internal/runtime/executor/helps/usage_helpers.go#L2722-L2777) | CPA 保存的是原始 `Detail.OutputTokens`，不是 canonical 分桶 | Claude/OpenAI reasoning 不再次加到输出；Gemini candidates 与 thoughts 独立，依真实 provider 语义相加。 |
| `total_tokens` | 正的源 total 优先；CPA 丢失 canonical quality/unclassified 元数据。见 [token_accounting.go](https://github.com/zhumengling/codex-token-usage/blob/8dffcb71ce8d99ce1a45fcf39d1dcb63879e44b6/token_accounting.go#L48-L61) | `cliproxyTokenBreakdown.accountingComplete` 与 source total | 保留权威总量及已知桶；总量与可证分类不一致不按完整请求计价、不把差值猜成输出。明细、模型、趋势、ops、路由均保留源 total，已知小计仍可见。 |
| primary/secondary 比例、reset | 当前 `usage_events` 没有窗口时长/存在性列；插件支持动态 2h/5h/7d/月等。见 [quota_dynamic_window_test.go](https://github.com/zhumengling/codex-token-usage/blob/8dffcb71ce8d99ce1a45fcf39d1dcb63879e44b6/quota_dynamic_window_test.go#L9-L125) | `primary_window`、`secondary_window` 独立历史快照 | 删除固定“5 小时/7 天”推断，显示主/次窗口。没有 reset 的已报告比例仍保留；非零 secondary + null reset 可见；零值加有效 reset 仍是确知零。零加无 reset 的旧缺省值不能证明该槽存在。 |
| `failed`, `status_code` | 原始失败标记；失败且 status=0 时插件存 599。见 [main.go](https://github.com/zhumengling/codex-token-usage/blob/8dffcb71ce8d99ce1a45fcf39d1dcb63879e44b6/main.go#L2579-L2611) | 保留失败请求、token 和原状态 | 不过滤失败消费，不据 HTTP 状态伪造 token。配额历史沿用“最近成功记录”选择策略并保留旧回归断言；明确不是当前实时配额。 |
| `GET /auth-files` | 不传 page/page_size 时返回整个清单；返回对象含 `files`。见 [auth_files.go](https://github.com/router-for-me/CLIProxyAPI/blob/c5251b57b3fa5dcbc689f514f4aa166daacb4481/internal/api/handlers/management/auth_files.go#L106-L200) | `getAuthFiles` 严格验证列表形状 | 无需虚构分页循环；畸形对象不默认为“空账号池”。legacy bare array 与真实空列表仍兼容。 |
| auth-files disk fallback | 管理器未就绪时仅磁盘元数据，缺 runtime status/disabled/auth_index。见 [auth_files.go](https://github.com/router-for-me/CLIProxyAPI/blob/c5251b57b3fa5dcbc689f514f4aa166daacb4481/internal/api/handlers/management/auth_files.go#L383-L450) | `hasCurrentCliproxyAuthState` | 磁盘记录保留，但不伪造成健康可调度账号；当前健康状态与历史认证槽独立。自定义 CPA 目录没有管理服务同实例证据，禁止自动关联默认本机管理账号。 |
| `last_refresh` | 认证刷新时间 `LastRefreshedAt`，非请求最后使用时间。见 [auth_files.go](https://github.com/router-for-me/CLIProxyAPI/blob/c5251b57b3fa5dcbc689f514f4aa166daacb4481/internal/api/handlers/management/auth_files.go#L722-L730) | `cliproxyAuthFileToAccount` | 不再作为 last_used_at；没有使用证据时保持未知。 |
| `api-key-usage.recent_requests` | `{time,success,failed}[]` 的内存分桶，非数字数组。见 [api_key_usage.go](https://github.com/router-for-me/CLIProxyAPI/blob/c5251b57b3fa5dcbc689f514f4aa166daacb4481/internal/api/handlers/management/api_key_usage.go#L12-L116) | 管理 API 类型纠正 | 不将当前内存计数当作 CPA 历史账本或请求明细补齐。 |
| `GET /usage-queue` | **破坏性出队**，handler 调用 `PopOldest`。见 [主线 usage.go](https://github.com/router-for-me/CLIProxyAPI/blob/c5251b57b3fa5dcbc689f514f4aa166daacb4481/internal/api/handlers/management/usage.go#L23-L42) 与 [Plus usage.go](https://github.com/kaitranntt/CLIProxyAPIPlus/blob/0341bcc440583738d7d0e673abefc63bbe99e131/internal/api/handlers/management/usage.go#L102-L115) | 未使用导出改为 `consumeUsageQueue`，加破坏性契约注释 | 当前展示链路无调用；没有为核验访问任何真实 queue。不能用该 GET 轮询展示/诊断，否则会抢走其他消费者记录。 |

## Token 语义的完整追踪

`usage.handle` 回调反序列化原始 usage record 后将 `Detail` 各整数直接写入 SQLite（[插件 main.go](https://github.com/zhumengling/codex-token-usage/blob/8dffcb71ce8d99ce1a45fcf39d1dcb63879e44b6/main.go#L485-L493)、[插入语句](https://github.com/zhumengling/codex-token-usage/blob/8dffcb71ce8d99ce1a45fcf39d1dcb63879e44b6/main.go#L2579-L2611)）。主线 SDK 的 canonical `TokenBreakdown` 构造器要求和原始 `Detail` 不完全相同，必须沿生产调用链解释，不能仅凭构造器名称决定相加。

| 生产者 | 原始输入 | 原始输出 | 本地规范化总量 |
| --- | --- | --- | --- |
| OpenAI/Codex | 含 cache read 子集 | 含 reasoning 子集 | input + output；cache/reasoning 不重复加 |
| Anthropic/Claude | 不含独立 cache read/create | **已含 thinking** | input + cache read + cache create + raw output |
| Gemini | prompt + tool use，含 cache 子集 | candidates，thoughts 单列 | input + output + reasoning |

Claude helper 先保持 `Detail.OutputTokens = rawOutputTokens`，只在 canonical 构造器入参处用 `rawOutputTokens - reasoningTokens`。因此对插件存下的 output 再加 reasoning 会重复计算。Gemini 则明确把 candidates 与 thoughts 分开（[Gemini producer](https://github.com/router-for-me/CLIProxyAPI/blob/c5251b57b3fa5dcbc689f514f4aa166daacb4481/internal/runtime/executor/helps/usage_helpers.go#L3237-L3265)）。Plus 的相应生产与 canonical 规范一致。

确定的分类不完整反例来自主线上游测试：`{usage:{input_tokens:10,total_tokens:15}}` 被规范化成输入 10、输出 0、总量 15、unclassified 5（[usage_helpers_test.go](https://github.com/router-for-me/CLIProxyAPI/blob/c5251b57b3fa5dcbc689f514f4aa166daacb4481/internal/runtime/executor/helps/usage_helpers_test.go#L117-L145)）。CPA schema 不保存 unclassified。旧适配器错误地把它重构成完整 10 token 并完整计价；新逻辑保留 15，保留已知输入 10，阻止不完整请求进入完整报价，同时保留其他完整请求的已知成本小计。

## 实例与账号边界

- 默认目录维持已有 `cliproxy:<raw-id>` 与 `local` 财务 scope；自定义目录使用稳定路径摘要，实际路径不发给远程服务。
- 两个目录相同 `auth_index` 拥有不同账号 ID、成本档案键和财务 scope。来源读取失败使用 `unavailable`，不能回退借用默认实例财务。
- 当前本机管理连接只有在其地址和默认实例规则成立时才参与关联。自定义目录未证明由该管理服务写入，不自动 join。
- auth_index 是认证槽，不保证 owner 跨时间稳定。当前邮箱更换不会重新归属历史；原显式成本档案按槽保留。没有上游生命周期字段，无法证明换号前后实际 owner；不得称“账号历史已核实”。
- `source` 可能含来源内容，`alias` 是模型别名；二者均不能当作历史账号姓名。当前管理面板可以展示当前元数据，但与历史槽行分开。

自定义来源身份还必须在目录暂缺和创建后保持稳定。旧实现直接 `canonicalize(...).unwrap_or(rawPath)`，在父目录别名或 Windows 路径规范形式变化时会生成不同摘要；Rust [canonicalize 文档](https://doc.rust-lang.org/std/fs/fn.canonicalize.html)明确不存在路径返回错误、Windows 使用扩展长度路径形式。本轮统一通过已存在的父目录解析物理路径，失效别名返回读取错误，不退成有效空实例。新增 2 个反例在修复前候选上均实际失败（同轮 4 项控制通过，`native-cpa-path-before.log`）。

## 时间、覆盖、失败与重试

本地 SQL 按请求时间窗口读取存量记录，管理 auth-files 不带分页时按上游契约读取全量。SQLite 内全部留存记录不等于自安装以来完整历史：插件默认保留 90 天，可配置并夹在 7 至 3650 天之间（[main.go](https://github.com/zhumengling/codex-token-usage/blob/8dffcb71ce8d99ce1a45fcf39d1dcb63879e44b6/main.go#L1045)、[配置限制](https://github.com/zhumengling/codex-token-usage/blob/8dffcb71ce8d99ce1a45fcf39d1dcb63879e44b6/main.go#L1183)；清理逻辑见 [diagnostics.go](https://github.com/zhumengling/codex-token-usage/blob/8dffcb71ce8d99ce1a45fcf39d1dcb63879e44b6/diagnostics.go#L218)）。没有读取用户真实 retention 设置，也不能恢复已清理记录。

上游 usage reporter 使用 `sync.Once` 限制一次 reporter 的发布，但插件没有稳定客户端请求 ID、重试链 ID、去重键（[usage_helpers.go](https://github.com/router-for-me/CLIProxyAPI/blob/c5251b57b3fa5dcbc689f514f4aa166daacb4481/internal/runtime/executor/helps/usage_helpers.go#L63)）。记录计数只能称保存的请求/尝试记录数，不能保证等于唯一最终用户操作数。失败请求仍可能消费 token，应保留；不通过同秒/同模型/token 猜测去重。

主/次配额是记录时的历史快照。reset 减 requested_at 只表示剩余时间，不是完整窗口长度；记录过期与实时刷新不可混同。各槽独立选择，缺少某槽不能清除另一个槽的有效历史证据。

## 反例与验证

本次新增断言在旧生产代码上先失败，再应用修复；没有删除跳过边界，也没有把未知数改成 0。

| 反例组 | 旧实现结果 | 修复后的定向验证 |
| --- | --- | --- |
| CPA quota 槽、同秒 id、窗口 helper、视图标签、last_refresh | 5 失败、2 通过 | 4 文件 33 通过 |
| 两实例同 auth_index、显式档案、管理 join、owner 替换、混合批次 | 5 失败 | 2 文件 12 通过（后续增加回归） |
| 畸形 auth-files 与磁盘 fallback 当前健康状态 | 5 失败、9 通过 | 纳入 10 文件 118 项与后续集 |
| native 自定义目录、相对覆盖、source identity、id 排序 | 4 个实际断言失败 | 最终原生业务全量 560 通过 / 0 失败 / 21 原有 ignored，包含这 4 条；不把启动失败当缺陷复现 |
| producer input=10,total=15 分类缺失 | 1 失败、5 通过 | 纳入下方最终定向集 |
| nonzero secondary、reset 缺失 | 1 失败、8 通过 | 纳入下方最终定向集 |
| opaque/兼容 provider 被模型名冒充官方 | 1 失败、6 通过 | 8 文件 119 通过 |
| CPA 及公共消费端最终定向集 | — | 14 文件 227 通过；另 9 文件 111 消费端断言通过 |

相关新增测试：`cliproxyUpstreamContract.spec.ts`、`cliproxySourceIsolation.spec.ts`、`managementContract.spec.ts`、native `cliproxy_path_contract_tests` 及 `contract_audit_cpa_equal_second_records_preserve_durable_id_order`。日志位于审计工作区，最终全仓/native 门禁由主审计汇总。

更正旧测试的理由：固定 primary=5h/secondary=7d 无上游证据；exact auth_index 不能证明当前邮箱拥有全部历史；缺分类但已知 total 不应把总量也置空；Gemini reasoning 增加后的 total 必须遵守 producer 总量，不能留下自相矛盾夹具。保留原始比例、零/空、reset、历史、失败请求、成本数值与请求数等独立断言。

## 仍无法由静态源码证明的事项

实际部署的主线/Plus/插件版本、进程环境和 cwd、用户数据库 schema、采集缺口、已删除记录、当前 owner 的历史生命周期、每条失败/重试与唯一用户请求的关系，以及真实采购与支付事实都没有连接核实。默认本机管理地址匹配是有限的本地关联条件，并非远程部署或端口转发的实例证明。当前 CPA schema 缺失 canonical unclassified/quality 和响应 service tier 等字段时，本项目不能凭推测补齐。所有这类缺口保留未知或不完整状态，不能宣称真实账目已全面核对完成。
