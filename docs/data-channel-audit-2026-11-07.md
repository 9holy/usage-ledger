# 三端成本数据与用量监控通道核验（2026-11-07）

## 结论与核验边界

这轮以 `9holy/usage-ledger@d21bb208672587d77f100e39dd8f33435040da83`（v0.2.37）为旧实现，逐段追踪来源源码、HTTP/SQLite/JSON 结构、接收类型、账号关联、时间窗口、汇总及页面消费者。发现并修复了历史用量遗漏、额度字段误读、账号归属证据不足、来源实例串账、错误状态和数值校验问题。

**采购价、周期摊销、损失、毛利、回本和本地报价规则仍属于本项目。此次修的是进入算法的事实、范围和证据，没有用来源收费算法替换本项目成本算法。** 源端客户扣费、标准价等值、额度百分比、绝对剩余次数、现金余额与本地采购支出保持不同含义。

核验材料是固定上游提交、实际生产读取链路和合成回归数据库/响应。没有连接用户真实服务、读取真实私有账号数据库或拿供应商账单逐笔勾稽。因此本报告可以说明接入契约与修复的行为，不能宣布所有已发生的真实请求、采购和余额均已完成账单核对。

## 1. 固定的来源版本

| 来源 | 固定源码 | 重点证据 |
| --- | --- | --- |
| Sub2API | [Wei-Shaw/sub2api@6b4b37d](https://github.com/Wei-Shaw/sub2api/tree/6b4b37db43443b5e88e424fe3c69602cc3810dfb) | handler、DTO、usage SQL、分页、日期及配额降级响应 |
| CLIProxyAPI | [router-for-me/CLIProxyAPI@c5251b5](https://github.com/router-for-me/CLIProxyAPI/tree/c5251b57b3fa5dcbc689f514f4aa166daacb4481) | usage producer、token 分项、认证槽 ID、管理 API |
| CLIProxyAPI Plus | [kaitranntt/CLIProxyAPIPlus@0341bcc](https://github.com/kaitranntt/CLIProxyAPIPlus/tree/0341bcc440583738d7d0e673abefc63bbe99e131) | producer 与管理端兼容契约 |
| CPA Token Usage | [zhumengling/codex-token-usage@8dffcb7](https://github.com/zhumengling/codex-token-usage/tree/8dffcb71ce8d99ce1a45fcf39d1dcb63879e44b6) | 插件落库字段、路径、记录顺序、额度槽和保留期 |
| Cockpit Tools | [jlcodes99/cockpit-tools@820e176](https://github.com/jlcodes99/cockpit-tools/tree/820e176842d440a60e650729c3a39932b76a0ccb) | 数据根、实例注册表、账号索引、各平台额度模型、请求库与价格来源 |
| Codex | [openai/codex@efdacaf](https://github.com/openai/codex/tree/efdacaf46ff54660a239189a6d62434c5db33d2c) | protocol TokenUsageRecord、Responses usage、官方 usage nullable 窗口 |
| DeepSeek Harness | [deepseek-ai/deepseek-harness@fcc0ad4](https://github.com/deepseek-ai/deepseek-harness/tree/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159) | v4 session 格式、usage-projection、turn-usage 与重试替换 |
| Claude API | [官方 prompt caching 字段说明](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#tracking-cache-performance) | 普通输入、缓存读、缓存写为独立分项；不是完整客户端日志生产器源码 |

三个成本来源的完整接口和字段矩阵分别见 [Sub2API](sub2api-data-contract-audit-2026-11-07.md)、[CLIProxyAPI/CPA](cliproxy-data-contract-audit-2026-11-07.md)、[Cockpit](cockpit-data-contract-audit-2026-11-07.md)。用量监控的事务、账号与额度状态核对见[监控额度报告](monitor-quota-contract-audit-2026-11-07.md)。用户实际部署是否等于这些固定提交仍需部署版本证据；缺失扩展不能根据名称推定实现。

## 2. 成本面板：主要确认问题

| 通道 | 旧行为与影响 | 修复后的行为 |
| --- | --- | --- |
| Sub2API 历史账号 | 先聚合日志，经济汇总又遍历当前账号清单，删号后的历史用量被遗漏 | 保留日志中的历史和未归属 ID；缺采购档案时保留事实小计、将完整经济指标和容量预测标为未知 |
| Sub2API 运行质量 | 官方不支持 `time_range=1m`，会默认按 1 小时查询 | 明确传入同次捕获的起止时间；不冒充与另一次分页读取逐毫秒原子一致 |
| Sub2API 额度 | HTTP 200 带 error/error_code 也当成功，占用成功 TTL | 识别降级；旧值保留原时间并标历史，失败可重试，成功清错，真实零值保留 |
| CPA 认证槽 | 当前 auth-file owner、套餐、创建/刷新时间覆盖整个历史槽 | 历史槽只使用请求当时保存的证据；当前管理状态独立；刷新时间不充当最后请求时间 |
| CPA 主次额度 | 没有时长字段，却把 primary/secondary 标成 5 小时/7 天 | 只显示主/次窗口；不以距重置的剩余时间推断周期 |
| CPA token 完整性 | authoritative total 有未分类残量时重构为较小总数并完整计价 | 保留总数和已知桶，分类不完整时禁止完整报价；Claude/OpenAI reasoning 不重复相加 |
| CPA 路径与实例 | 忽略数据/价格覆盖；同 auth_index 可借默认实例管理状态和成本档案 | 对应绝对路径、来源摘要、账号 ID、档案和财务 scope 一致；读取失败不能归到 local |
| Cockpit 数据根 | 固定旧 `.antigravity_cockpit`，遗漏 modern/dev/显式目录 | 按官方根选择优先级只读定位，两个独立根不合并，不创建或迁移上游目录 |
| Cockpit 价格和数量 | NULL 缓存价可变成免费；价格版本与具体价格组错配；坏数值被置零 | 区分 NULL 和真实 0，按实际价格组保留版本，拒绝错型/负数/溢出和精度丢失 |
| Cockpit 账号与额度 | 忽略明文索引身份，重复邮箱分配同一额度；原生平台字段被漏读或单位误解 | 唯一索引 ID 关联；歧义保持未归属；按各平台原生含义处理剩余/已用比例、次数和时间单位 |
| Cockpit 来源切换 | 账号 ID 不含 root；同一 API key 文本可生成相同 ID，旧历史与档案串到另一目录 | 历史 legacy 物理根保持 local 兼容；独立 modern/custom/dev 来源隔离账号/档案/财务 scope、JSON 历史和 SQLite usage/checkpoints；物理别名保持同一来源 |

Cockpit 的 `codex_apikey_ + md5(api_key)` 来源 ID 没有目录或 base URL（[producer](https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/codex_account_provider.rs)）。因此不能以 ID 字符串相等证明两套来源是同一个采购账号。旧 legacy 物理根的默认档案继续保留，不能自动认领到独立 modern/custom/dev 实例。默认目录选择变化也不能把两套物理根都映射成 local；后台摄取从同一次捕获的物理根与身份派生来源库和目的账本，避免解析来源之后切根而写错库。

## 3. 用量监控：六条读取接口

| 本地命令 | 数据来源及范围 | 核对结果与处理 |
| --- | --- | --- |
| `usage_monitor_snapshot` | collector 状态、会话页、请求汇总、当前流式观察 | 同一只读连接和读事务；筛选/分页校验；来源读取失败不表示零使用 |
| `usage_monitor_session` | 明确 session key、请求页、子会话和请求证据 | 同一读事务；请求 ID、父子关系及过滤保持一致；不凭会话创建人认领全部请求 |
| `usage_monitor_analysis` | 指定窗口的请求、模型、token、计价与速率 | 同一读事务；缺时间、缺分类、未计价、累计未逐笔记录分别保留状态 |
| `usage_monitor_accounts` | 唯一请求归属、账号周期、已录入财务及额度证据 | 同一读事务和明确 `[start, observedEnd)`；账号/实例/周期一致才支持完整指标 |
| `usage_monitor_weekly` | 周窗口用量及有条件的预测 | 依已有证据生成；不是供应商官方账单，也不能把配额百分比换算成请求 token |
| `usage_monitor_quotas` | 本地日志、官方 Codex 查询、Cockpit 额度观察和趋势 | 本轮补充读事务；失败按账号/来源隔离，保留原观察时间；消失或换时长的旧窗口标历史，成功清错 |

### 四个采集来源

| 来源 | 逐字段核对 | 明确边界 |
| --- | --- | --- |
| Codex | 新 `token_usage_record`/`raw_response_completed` 与旧 token_count；原始 input 已含 cache，output 已含 reasoning；保留 `cache_write_input_tokens`、response/thread/turn 身份 | 当前登录、会话创建者、相同 reset 不能替代历史请求归属。未逐笔累计仍是累计证据 |
| Claude Code | assistant usage、缓存读/写、缓存写时长分项、message/request/occurrence ID、分块更新与子会话路径 | 使用官方 API 字段语义和实际支持的日志形状；没有取得完整客户端日志生产器源码，不能声明所有历史客户端变体均已源码证明 |
| Antigravity | 本地 brain transcript 发现会话；Cockpit 独立额度观察 | 当前 transcript 无可证实 token 时只提供会话发现，并明确 partial；额度不是 token 证据，不能补造成本或零用量 |
| DeepSeek Harness | v2–v4 JSONL/Zstandard、连续 seq、继承前缀、attempt/retry、独立 cache、总量一致性、响应模型优先 | 当前固定上游写 v4；未知版本/破损尾部/矛盾计数拒绝整个快照，保留此前提交的账；不恢复已丢日志 |

Codex 的 Cockpit 托管实例注册表使用 `InstanceProfile` 的 camelCase `userDataDir`（[模型](https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/models/instance.rs)）。旧 collector 只读 `user_data_dir`，本轮修复并保留旧键兼容。畸形条目报告部分失败，合法实例及独立 Codex 目录仍可继续采集。

官方 Codex usage 的 primary/secondary 是可空对象（[schema](https://github.com/openai/codex/blob/efdacaf46ff54660a239189a6d62434c5db33d2c/codex-rs/codex-backend-openapi-models/src/models/rate_limit_status_details.rs)）。成功查询里窗口消失或改变时长，不能让旧窗口继续装作当前窗口；失败查询也不能更新上次成功观察时间。

## 4. 账目与持久化

- **事实与计算分开。** 金额来自用户显式采购/续费/退款/损失记录，不能从当前成本配置伪造历史付款；来源消费金额、客户扣费和参考价格各有字段语义。
- **来源、实例、账号、币种分开。** 本地 finance 事件保留自己的 scope；独立 modern/custom/dev Cockpit usage/checkpoint 使用独立持久库，旧 legacy 物理根仍使用原库。不同币种不直接相加。
- **历史不随源清理丢失。** 已封桶事实和账号历史维持已有保留规则；换独立源不能当同一源重建追加。来源首次为空与读取失败分开。
- **完整性影响结论。** 缺采购档案、日志截断、报价缺失、归属冲突或旧额度仅支持已知小计，不支持完整盈利/回本/可用余额断言。
- **金额可表示性。** 本轮补上跨账号币种总额和账号终身金额的有限数检查。两个各自有限的数相加仍可溢出；结果必须报错，不能被 JSON 默默变成 null 或假零。公式与费率不变。
- **自己的账本不写入来源目录。** 阻止 legacy/modern/dev/custom Cockpit 目录及其符号链接别名；在创建备选目录之前检查，未创建的后代路径也保护。

## 5. 回归证据

修复前的独立基线使用旧生产实现加新增断言。编译或环境失败不算缺陷复现，零测试命中不算通过。

| 反例组 | 旧实现实际结果 |
| --- | --- |
| 根侧 monitor 目录/字段/账本保护及金额溢出 | 13 例：11 失败，2 个兼容/币种控制通过 |
| Cockpit 跨来源 JSON 历史及 SQLite/checkpoint | 2 例均失败 |
| 隔离实现终审：默认目录动态选择及摄取途中切根 | 修复前候选实现的 2 例均实际失败；分别复现身份相同与 A 源写入 B 账本 |
| CPA 目录暂缺/创建及失效别名 | 修复前候选实现 2 例均实际失败，同轮 4 项控制通过；身份必须稳定、失效别名不得变成有效空实例 |
| Cockpit 额度原生形状/身份/单位 | 24 例：23 失败，1 个 OAuth 小数比例控制通过 |
| Codex 官方额度失败、无效 200、可空及变时长窗口 | 4 例均失败 |
| Cockpit 监控额度 root scope 与逐行错误隔离 | 2 例均失败；同轮其余 12 项来源/SQLite 回归通过 |
| Sub2API 与 CPA 前端及原生专项 | 具体反例、固定生产者引用和专项命令见各来源报告 |

最终候选的 Linux headless 原生业务全量回归：**560 通过、0 失败、21 个原有 ignored 保持不执行**，实际日志 `data-channel-native-final.log`。该运行保留所有生产业务模块及非 GUI 测试，包含本轮目录切换、持久历史、额度失败恢复、金额溢出及 CPA/Cockpit 本地读取反例；不包含 Tauri 宏、desktop shell 或跨系统原生行为。Windows/macOS 原生编译、桌面测试及安装包验证由后续发布工作流逐平台执行，记录在对应 `BUILD-INFO.json`，不能用 Linux 结果代替。

前端完整回归：**371 个测试文件通过、2 个文件按原条件跳过；3503 项通过、0 失败、11 项按原条件跳过**，实际日志 `final-frontend-vitest-rerun.log`。包含 39 项成本页面挂载集成断言，其中新增真实读取失败不写回、批次切换来源不写回的测试；其余金额、请求、时间、未知状态和列维度断言继续保留。独立类型检查和 ESLint 均通过；构建脚本 15 项通过；桌面和 Web 生产构建均成功。构建保留现有较大 chunk 提示，没有把该提示作为数据准确性或原生桌面验证。发布前按源码导出策略生成并核验全部 1255 个文件的完整清单；三平台原生、安装包和启动检查继续由同一源码提交的发布工作流执行。最终 `BUILD-INFO.json` 绑定该提交、manifest 摘要及三平台安装包摘要，不以专项数量代替全量验证。

## 6. 仍不能由源码核对解决的边界

1. 用户部署版本、私有扩展、实际授权范围和真实数据库内容未在此次读取；尤其 Sub2API 的可选 economics/cost-loss/pricing 扩展并非已固定官方路由。
2. offset 分页不是远端事务快照；去重不证明翻页期间新增/删除导致的漏项不存在。读取上限、保留期、清理与未知值必须继续显式展示。
3. CPA 认证槽没有历史 owner 生命周期字段，不能证明同一路径换号前后的历史所有人。Cockpit 同目录、同 API key 改 base URL 时仍可能保留原账号 ID，来源隔离不能补出供应方生命周期；持久诊断也没有完整原生 response ID 可供无歧义替代匹配。
4. 供应商服务实际少报或丢失的请求、删除的日志、缺失的采购凭证不能仅凭当前总数重建。真实账目准确性仍需要匿名原始明细与账单逐笔核对。
5. 桌面安装/启动检查和合成测试验证实现行为，不等于所有 GUI 操作、用户真实账户或提供方账单已人工验收。

