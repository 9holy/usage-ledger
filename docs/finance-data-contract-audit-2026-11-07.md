# 财务与本地历史接口逐项源码核验

本轮基线为 `be0318c0a6caf93c62d810774cf3a06e46bfbf30`（v0.2.38）。本报告补齐此前只列出六个用量监控读取命令、未逐项列明财务接口的缺口。核验对象是本项目实际调用和实现，不以缺少用户账单为由停止源码核验。

财务事件的生产者是本项目录入界面和本地命令；供应商请求日志、额度或参考报价不是采购付款的生产者。原有采购、摊销、退款、停用损失及毛利规则保持不变，本轮修复读取契约、范围和存储校验。

## 七个财务入口

前端包装均在 [`src/api/financeLedger.ts`](../src/api/financeLedger.ts)，原生命令注册于 [`src-tauri/src/main.rs`](../src-tauri/src/main.rs)，数据结构、SQL、写事务及计算在 [`finance_ledger.rs`](../src-tauri/src/finance_ledger.rs)。所有命令使用 camelCase 参数/返回字段，异步命令把阻塞 SQLite 操作放在 `spawn_blocking`。

| 命令 | 实际界面消费者 / 输入 | 原生存取和返回契约 | 核验结果 |
| --- | --- | --- | --- |
| `finance_ledger_query` | `CostEventsPanel.reload`、`CostCenterView.loadLocalFinance`；source、instanceId、可选 accountId/channel/plan、startMs/endMs、listMode/offset/limit | 同一次 SELECT 读取明确 source+instance 的事件，之后在同一内存快照中验证关联并计算。周期为 `[start,end)`；列表最多 100；列表页码及 all/current 不改变统计周期 | 已核实范围和字段映射。账号/渠道/套餐过滤影响对应汇总；分页只影响展示列表。本轮补批次总额一致性检查，并修复页面换窗口/账号后失败仍展示旧金额的问题 |
| `finance_ledger_save` | `CostEventsPanel.submit`；新记录由前端生成 UUID，编辑保留原 UUID、账号和未修改时间戳 | Immediate 事务；验证正有限金额、CNY/USD、时间、coverage、关系；已有事件禁止换来源/实例/账号/批次，作废后不可编辑；检查整份作用域关联及批次后提交并返回已保存记录 | 已核实。采购与续费可带覆盖期；退款/损失的正金额由 kind 表示业务方向，不用负数代替。无关联/无覆盖事实保持 unresolved，不补造采购 |
| `finance_ledger_void` | `CostEventsPanel.confirmVoid`；作用域取自待作废事件本身 | 检查 source+instance，存在有效子事件则拒绝；软作废保留原记录；整份作用域校验与更新处于同一事务 | 已核实。确认框本身不发调用；取消不作废；已作废行可保留展示。没有物理 DELETE |
| `finance_ledger_save_batch` | `FinanceBatchEditor.submit`；批次 UUID、实付总额、币种、发生时间、渠道和逐账号分摊 | 唯一记录 ID/账号；同 scope、币种和时间；统一写入批次元数据；移除的旧分摊软作废；所有分摊与总额相符，任何关联冲突或校验失败整体回滚 | 已核实。批次修改不通过多个独立单条事务拼装，保留原子性；没有改变既有浮点容差或分摊规则 |
| `finance_ledger_get_batch` | `CostEventsPanel.openBatch`；scope、batchId | 仅读有效批次成员，返回 totalAmount/currency/occurredAtMs/purchaseChannel/events | 本轮修复：旧读取仅取首行 total 并 unwrap；现在逐行验证、核对分摊合计，不把坏元数据、Infinity 或缺失总额当有效批次 |
| `finance_ledger_void_batch` | `CostEventsPanel.confirmVoid` 识别 batchId 后走整批接口 | Immediate 事务中读取同作用域批次并软作废全部成员；任一成员有未处理关联事件则全批回滚 | 已核实。没有把单条确认误传到另一实例，也没有只作废当前分页可见成员 |
| `finance_ledger_related_events` | `CostEventsPanel` 退款/损失编辑器的关联候选读取 | 明确 source+instance+account+currency，排除已作废事件，仅返 purchase/renewal/termination_loss；按业务时间及持久身份排序 | 已核实。前端额外排除正在编辑的自身记录，并按 refund/termination 类型限制候选；原生写入仍再次校验，前端筛选不能代替关系约束。本轮统一行读取校验覆盖此入口 |

### 公共数据约束

- 所有财务读入口使用同一个 `row_event`。它现在验证持久行的输入结构、有限金额、合法时间及批次元数据；损坏的数据报告错误，不序列化成假零或 `null`，也不自动删改原事实。
- 采购 → 停用损失 → 退款或采购 → 退款是允许的关联图；来源、实例、账号、币种一致且子事件不能早于原事件。关联图和退款上限由写事务检查。
- 真实零采购价可以出现在成本档案中；财务事件本身要求正金额。这是两种不同的数据契约，没有把空金额改成免费。
- 事件列表包含可查看的作废历史；费用汇总仅使用有效事实。当前窗口、累计费用、现金付款、退款及剩余预付分别返回，不能相互替代。
- 本地查询的同一内存快照保证自身一致性；七条彼此独立的命令不构成跨调用的事务，也没有因此声称与远端供应商同一时刻结算。

## 用量历史 JSON 读写

[`readCostLedger/writeCostLedger`](../src/api/cockpit/index.ts) 对应 `read_cost_ledger/write_cost_ledger`。缺文件返回 JSON `null`，合法空历史为 `{accounts:[]}`。数据根身份在写入时与请求捕获的 sourceInstanceId 比较，目的路径由同一次捕获的身份生成，原子替换保留失败前文件。

此前前端只在读取时验证部分形状，写入会先 `JSON.stringify`，使 NaN/Infinity 变为 `null`；原生写入也只检查顶层是对象。本轮前端序列化前和原生写文件前均核验：accounts 数组、非空邮箱、唯一历史邮箱、可表示的毫秒时间、非负有限数值，以及请求/Token/延迟等源计数的整数与 JavaScript 安全范围。缺少某个旧计数仍保持缺失，合法零值和小数源估价保留。

字段依据是固定 Cockpit 的 [`CodexLocalAccessUsageStats`](https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/models/codex_local_access.rs)：计数与毫秒延迟是 `u64`，`estimated_cost_usd` 是 `f64`。后者仍是源估值，不转成采购付款。

### 邮箱不能代替唯一账号 ID

上游 [`upsert_account_usage_stats`](https://github.com/jlcodes99/cockpit-tools/blob/820e176842d440a60e650729c3a39932b76a0ccb/src-tauri/src/modules/codex_local_access_gateway_runtime.rs) 按 `account_id` 定位统计行，邮箱是另一个字段。同邮箱的两个账号可以分别有不同金额。

旧 `applyCockpitUsageLedger` 用邮箱建 map，并在遍历第二个账号时把第一个账号的历史最大值套上去；真实挂载反例中两行金额 `2` 和 `1` 被改成 `2` 和 `2`。本轮在任何历史合并和写回之前核对邮箱唯一性。出现歧义时保留两个当前账号各自的源事实和既存历史文件，页面明确显示历史关联失败，跳过该兼容 JSON 历史的写回；不会任意选择一个账号，也不会删除旧文件。独立 SQLite 用量摄取仍按其请求身份和来源规则处理。

这条兼容历史本来只有邮箱，不包含完整 owner 生命周期。唯一邮箱下的既有保留行为仍兼容；无法证明的多账号关系没有被伪造成可自动迁移的事实。旧原生 roundtrip/根切换测试的示例补上真实的 updatedAt/usage 层级，邮箱、数量、路径隔离及原文件保留断言没有删减。

## 其他实际数据入口

以下不计入“六个监控读取接口”或“七个财务入口”，本轮也明确检查它们的调用边界：

| 入口 | 数据来源与本地行为 | 范围 |
| --- | --- | --- |
| `ledger_ingest` | `src/api/ledger.ts` → `ledger_ingest.rs`；逐源读取请求 SQLite 和会话 SQLite、更新自己的持久用量及检查点 | 依已有源事务、写事务和来源捕获规则；返回逐源 ok/skipped/sourceAvailable，不把源不可用说成零使用 |
| `ledger_reconcile_sources` | `src/api/ledgerQuery.ts` → `ledger_query.rs`；读取本实例两源的已存数量及重叠格 | 缺账本为 unavailable；read-only；全量窗口与源身份在页面读取前后核对 |
| `ledger_list_sources` | 同上；水位、源代次、扫描行数、已存请求与Token | 缺账本为空源列表；扫描行数不是唯一用户操作数；与另两个查询不是单个跨命令快照 |
| `ledger_merged_usage` | `src/api/ledgerMerge.ts` → `ledger_merge.rs`；返回现有合并规则下的数量、覆盖信息 | 只返回量；沿用原有日×模型合并规则，未改变自己的计价规则，未把重叠格当新的请求 |
| `model_catalog_status/refresh/quote_batch` | `src/api/modelCatalog.ts` → 原生 model_catalog；当前价目状态、刷新结果、逐输入报价 | 自有报价服务单独于上游采购/扣费事实；输入含 inclusive input、独立缓存写时长、实际/请求模式及上下文证据。此次没有修改费率或成本纯算法 |

## 回归证据

- 财务旧生产上新增 4 条原生反例实际失败：批次总额缺失导致 panic、分摊与实付总额冲突被批次读取接受、同一冲突被汇总接受、Infinity 被读取返回。修复后整个财务原生组 **13/13 通过**，包含既有退款、作废、批量原子性、迁移、币种与溢出测试。
- 财务旧页面 2 条反例实际失败：新时间窗口读取中仍显示旧行；账号过滤读取失败仍显示原总额。修复后财务 API、单条和批次编辑三个前端文件 **16/16 通过**。首次夹具有一个 aria-label 写错，修正后重新在未修实现上观察两条业务断言失败，未把选择器错误计入缺陷证据。
- JSON 历史原生旧生产 5 条反例实际失败：缺 accounts、坏行、重复邮箱、小数计数、超精度计数均能覆盖旧文件。修复后与 4 条财务新反例及同过滤器命中的 1 条既有请求完成测试合跑，**10/10 通过**；所有拒绝写入均检查原文件字节保持不变。
- JSON 历史前端旧生产 7 条断言实际失败；精确 v0.2.38 的页面挂载另证实金额 `1` 被另一个同邮箱账号的 `2` 覆盖。修复后读取/写入、adapter 及成本页挂载三个文件 **148/148 通过**。
- 定向旧/新日志保留为 `completion-finance-*-before*`、`completion-finance-*-after`、`completion-history-native-*`、`completion-usage-ledger-*`。这些是源码契约反例与隔离数据库/目录测试，不声称连接过用户实际账号或替用户执行过财务写入。

最终跨模块测试、源码提交和安装包来源以本轮统一报告与公开 `BUILD-INFO.json` 为准，不用本专项通过数量替代整包门禁。
