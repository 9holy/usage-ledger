# 数据通道、日志与账目补充核验：v0.2.39

## 核验目标

本轮在已发布的 `9holy/usage-ledger@be0318c0a6caf93c62d810774cf3a06e46bfbf30`（v0.2.38）上继续核对成本工作台的三个来源、用量监控、账号关联和本地账目。此前初审没有完整追到部分平台的实际写盘代码，也没有穷尽额度扩展字段和所有界面消费者；不能用“已有测试通过”代替这些检查。本轮按入口清单追踪实际生产者、响应或日志结构、读取、持久化、适配和界面消费，并为确定的问题先运行旧实现反例，再修复。

**成本规则仍由本项目定义。** 采购价格、周期摊销、损失、利润、回本及自有报价公式没有被上游算法替换。本轮更正输入字段、账号和来源身份、观察时间、数据完整性，以及错误不能伪装成成功或零值的行为。

固定上游提交沿用[初审来源表](data-channel-audit-2026-11-07.md#1-固定的来源版本)，补充报告逐项链接到真正的 writer、handler、模型或客户端。源码审查能确认这些已列明契约和实现行为；没有产生真实私有账单逐笔核对的结论。

## 1. 成本工作台入口清单

| 范围 | 实际输入与消费 | 本轮补充核对 |
| --- | --- | --- |
| Sub2API 使用事实 | `/admin/usage`、当前账号、自然日统计、明确起止的 Ops、dashboard、渠道和模型参考价 | 延续初审已修复的历史账号保留、时间裁剪、分页和降级响应；补全 API 接入面板的 `/keys` 分页、连接/密钥切换、`/settings/public` 与手动 `/v1/models` 诊断。明细见 [Sub2API 补充报告](sub2api-extension-contract-audit-2026-11-07.md) |
| Sub2API 可选扩展 | economics snapshot、cost-loss 状态/写入包装、pricing status/refresh | 检查本仓库所有调用及固定官方仓库路由；明确哪些实际被页面调用、哪些只是未使用的 API 包装、哪些缺少服务端生产者。不能将同名 TypeScript 类型当作已经核实的后端 |
| CPA 管理与本地插件 | 主刷新五个管理 HTTP 读取和两条本地源读取、成本档案、外部管理页 | 分清运行版本响应头与最新发行版；捕获连接地址/凭据版本并拒绝旧批次回写；检查本地采购档案失败和显式零。明细见 [CPA 完整入口报告](cliproxy-interface-coverage-2026-11-07.md) |
| Cockpit 用量 | 网关请求 SQLite、会话 usage、聚合 JSON、持久历史与统一来源读取 | 保留初审的来源实例隔离；补上 JSON 历史读写数值校验、重复邮箱歧义及先校验后写入。明细见[账目报告](finance-data-contract-audit-2026-11-07.md) |
| Cockpit 额度 | 账号索引/详情、实际各平台 raw 响应、当前缓存与兼容历史文件；四个原生命令 | 追到 Trae 平台身份、Zed `user_raw`、Windsurf 日/周、Buddy/CN/WorkBuddy、Cursor 重置、Qoder、Google 配额 summary/cache 的实际生产者；统一已用/剩余、数量/百分比、毫秒/秒、原始观察时间及错误。明细见 [Cockpit 生产契约补充报告](cockpit-quota-production-contract-2026-11-07.md) |
| 本地财务 | query、save、void、save_batch、get_batch、void_batch、related_events 共七个命令 | 查询、读批次、原子写入、作废关系、分摊和数值校验均逐项核对；切换账户/时间或读取失败不能继续展示旧窗口金额。明细见[账目报告](finance-data-contract-audit-2026-11-07.md) |

这里的“入口”指成本工作台、用量监控及其账目实际使用的接口，并非声称外部管理页或上游产品的所有独立功能都由 Usage Ledger 实现或完成审查。嵌入管理页由相应上游提供，部署可指定不同页面。

## 2. 用量监控实际读取通路

六个页面读取命令为 `usage_monitor_snapshot`、`usage_monitor_session`、`usage_monitor_analysis`、`usage_monitor_accounts`、`usage_monitor_weekly`、`usage_monitor_quotas`。其参数、筛选、分页、读事务及账号证据已逐一核对，详见[监控初审](monitor-quota-contract-audit-2026-11-07.md)及[完整额度与消费补充报告](monitor-usage-contract-completion-2026-11-07.md)。本轮进一步核对这些命令依赖的输入，而不是仅查看页面总数。

| 输入 | 软件实际读取位置 / 接口 | 进入账本的字段与处理 |
| --- | --- | --- |
| Codex 会话日志 | 默认 `.codex`、非空 `CODEX_HOME`、Cockpit `codex_instances.json` 中合法的 `userDataDir`；各根下 `sessions` 和 `archived_sessions` 的 JSONL | `session_meta`、`turn_context`、新 `token_usage_record` / `raw_response_completed`、旧 `token_count`；thread/turn/response 身份、原始时间、模型、输入/输出、缓存和 reasoning。累计与逐笔事实分别记录；重复样本替换，不能重复计费 |
| Codex 运行元数据 | 各 Codex 根的 `logs_*.sqlite` | 按准确 thread/turn/request span 关联实际模式和计费证据；未知或冲突保持未知，不按附近文本或当前登录人猜测 |
| 官方 Codex 额度 | `codex_quota_accounts::Reader` 的认证 usage 读取 → `quota::save_authenticated_codex` | 主池、额外池、plan、credits、spend control、allowed/limit reached、窗口秒数和 reset。不同池独立保留；秒数不先舍入作为身份；仅有明确账号身份的主池精确七天窗口可用于主周周期 |
| Cockpit 请求账号证据 | 请求库 `request_logs`，关联 `request_diagnostics`、`request_session_lookup` | `official_account_id` 与 session、模型、时间、Token 共同约束。保留来源；矛盾/多解不认领；当前账号或会话创建者不是全部历史请求归属 |
| Claude Code | 默认 `.claude/projects`、非空 `CLAUDE_CONFIG_DIR/projects` 的 JSONL，含 subagents | assistant `message.usage`、request/message/occurrence ID、缓存读/写及 5m/1h 分项。普通输入与缓存分项独立；synthetic/error message 不冒充有效模型用量。API 字段语义可对照官方文档；完整闭源客户端所有日志变体没有公开生产源码依据 |
| Antigravity 文件 | `.gemini/{antigravity,antigravity-ide,antigravity-cli}/brain` 下受限发现的 `transcript.jsonl` | 发现会话；没有 Token 证据的 transcript 不构造精确 Token 或成本 |
| Antigravity 本机接口 | 自有语言服务进程的 loopback HTTPS：`LanguageServerService/GetAllCascadeTrajectories`、`GetCascadeTrajectoryGeneratorMetadata` | 前者列会话，后者读取 `generatorMetadata.chatModel.usage`，`includeMessages=false`。保存模型响应名、Token、原始开始时间、TTFT/streaming duration 及分页游标；缓存包含口径不能证实的部分保持未知/下界。每轮有时间、会话数、页长和响应大小限制，持续轮转，不把一次返回当全部历史 |
| DeepSeek Harness | `DSH_HOME/sessions`，未指定时 `.dsh/sessions`；支持的 JSONL/Zstandard 会话代际 | 固定上游当前 v4 writer、兼容 v2–v4 reader、连续 seq、继承边界、turn/step/attempt、最终 usage 替换及重试独立计数。破损尾部/矛盾 Token 不提交半个快照 |
| Cockpit 配额观察 | 明确 source instance 的平台快照 | 保存各行原采集时间、账号、池、窗口和 sourceError；来源失败不污染其他实例，成功读取的当前时间不刷新旧数据年龄 |

上述文件发现和传输实现见 `collector.rs`、`parser.rs`、`codex_mode_logs.rs`、`request_accounts.rs`、`antigravity.rs`、`deepseek.rs`、`deepseek_parser.rs`。Antigravity 的两个本机接口是旧汇总遗漏的清单项目；本轮实际检查了其发现、只读请求、字段解析、分页和失败路径。当前工作区没有 Antigravity 完整服务端源码，不能把本地适配代码中的协议注释当作新的完整上游源码证明。

## 3. 账号、金额和未知值的约束

1. **上游账号 ID 优先于邮箱。** Cockpit 的累计生产者按 `account_id` 分开累计。同邮箱多账号不能被旧 email-keyed 历史合成同一份金额。本轮在修改当前数据之前检查歧义，保留原账本、停止错误写回，页面继续展示当前账号各自的真实源值。
2. **百分比、余额和采购支出不混用。** 额外池耗尽不表示主池耗尽；额度 credits 不能覆盖明确 spend block；没有可用百分比窗口时仍可保留独立状态和 credits。额度值不是用户实际付款证据。
3. **真实零、缺失、无效、失败和历史不同。** 显式零采购可以保存；空输入不能转成免费。缺失/损坏采购档案不能静默使用默认价得到完整利润。JSON 用量历史在写入前拒绝无效计数、时间和非有限金额；本地成本档案对来源已明确的条目验证金额、币种、周期与日期，未归属的旧键原样保留。
4. **时间和范围属于数据身份。** 原窗口 61 秒和 119 秒不能因分钟显示相同而合并；604799 秒不能凑成七天采购周期；Google 缓存更新时刻不能替代旧 summary 桶的独立观察时间；切换财务窗口时先撤下旧范围快照。
5. **持久化先验证，再提交。** 财务使用原有事务和 scope，新增批次读取/查询的完整性检查；坏数据返回明确错误。JSON 历史在前端和原生写入边界都验证，并继续校验捕获的来源身份。

## 4. 反例与验证记录

各专项报告保留修复前生产实现上的实际失败、固定来源证据和修复后的定向结果。编译失败、无测试命中、启动失败不计为缺陷复现。旧版反例使用独立冻结源码，不在共享候选中反复还原生产文件。

根侧已完成的定向证据：财务原生新增 4 个反例在旧实现均失败，候选财务 13 项通过；旧范围快照 2 个界面反例均失败，相关 3 文件 16 项通过；JSON 历史 5 个原生坏写反例均失败，候选均通过；历史数值/邮箱归属前端旧实现 7 项失败，相关 3 文件 148 项通过。冻结 v0.2.38 的真实页面另复现同邮箱账号 2/1 被改成 2/2，修复后保持 2/1 并停止歧义历史写回。没有用删除金额断言的方式让测试通过。

最终本地门禁基于冻结候选完成，原生测试前后 45 个源码/锁文件摘要一致；前端、脚本和构建序列前后全部参与源码/测试摘要一致。结果如下：

| 最终门禁 | 实际结果 |
| --- | --- |
| 完整 headless 原生业务测试 | **621 passed / 0 failed / 21 原有 ignored** |
| 完整前端测试 | **376 文件通过，3,608 passed / 0 failed / 11 原有 skipped**；另 2 个原有套件 skipped |
| 全仓 ESLint | 通过 |
| `vue-tsc --noEmit` | 通过 |
| 发布与平台脚本测试 | **15 passed / 0 failed / 0 skipped** |
| 桌面前端构建、普通网页构建 | 均通过 |
| 源码导出策略及 diff 空白检查 | 均通过；当前策略包含 **1,273 文件** |

首轮完整前端检查另找到一份旧 locale 测试夹具缺失实际 API-key 分页字段。仅补齐 `total/page/page_size/pages` 后，保留全部请求次数、地址及模型原文断言；该文件 8 项通过，再完整重跑得到上表结果。未通过削弱生产校验或删除断言取得通过。

Windows/macOS 的原生测试、安装包构建和隔离启动检查在公开发布前由同一源码提交的 CI 执行，必须全部成功。构建和安装包的精确源码提交、manifest、平台回执及文件摘要由本版 [BUILD-INFO.json](https://github.com/9holy/usage-ledger/releases/download/v0.2.39/BUILD-INFO.json) 记录；本地 headless 通过不替代三平台安装验证。

## 5. 完成范围与无法从现有源码补出的事实

本轮列明的入口都需有检查结论：已对照生产契约、仅保留兼容 reader、外部委托页面、无实际消费者、或没有对应服务端源码。不能把最后三类写成已核实的远端账目。

- Sub2API 可选成本扩展没有包含在当前仓库或固定官方仓库中；本地请求、类型、消费者和降级行为可以检查，其服务内部写账与计算需要对应实现。
- CPA 认证槽缺少历史 owner 生命周期，源日志保留期及上游删除无法由现在的记录逆向还原。
- Claude/Antigravity 完整闭源客户端未公开的日志或服务字段，不能用本地适配器自证全部版本兼容。
- offset 分页没有远端事务快照；来源权限、部署版本、实际采集缺口和真实付款凭证属于运行及账单事实。源码核验没有据此宣布私有账目逐笔平衡。

这些界限不阻止修复已确定的数据通道问题，也不影响按现有授权发布经验证的源码和安装包。
