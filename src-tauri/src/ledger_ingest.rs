//! 本地持久成本账本 · 摄取管线
//!
//! 把 cockpit 源库的单请求用量**增量**搬进自有账本(`ledger_db`),核心机制是
//! **桶级二态写入**(架构文档 §3.2):
//!
//! | 桶状态 | 判据 | 写入方式 |
//! |---|---|---|
//! | 未封桶 | `hour_bucket + 3_600_000 + SEAL_LAG_MS > now_ms` | 整桶重扫 → **覆盖**(replace) |
//! | 已封桶 | 反之 | 只取 `id > bucket.max_source_id` → **累加**(add) |
//!
//! 为什么必须是二态而不是"一律累加"或"一律覆盖":
//! - 一律累加 → 尾部乱序写、后置补写 token 会重复计数;
//! - 一律覆盖 → cockpit 保留策略删掉旧行后,重扫会读到"少了几行"的桶,把**老账抹掉**
//!   ——这恰恰是本项目存在的理由(用户诉求:cockpit 删数据不能删我们的账)。
//!
//! 二态的分界(3 小时)保证"还可能被改的行"落在未封桶侧走覆盖,
//! "已经不会再变的行"落在已封桶侧走累加。
//!
//! # 红线
//!
//! 1. **只存量不存钱**:本文件不出现任何单价 / 倍率 / 金额计算。
//!    `estimated_cost_usd` / `model_pricing_version` 是 cockpit **原样搬运**,仅供审计。
//! 2. **数据源不可用不是 `Err`**:返 `source_available:false + reason`(B5),绝不静默变 0。
//! 3. **分档逻辑单一来源**:逐行走 `cockpit_logs_db::TokenSplit::add`,不另写
//!    `if input > 272_000`。
//! 4. **分位数不可加**:`latency_p50_ms` / `latency_p95_ms` / `bucket_latency` 一律**覆盖写入**,
//!    任何地方都不得 `+`。
//! 5. **桶对齐**:epoch 小时(UTC),`ts.div_euclid(3_600_000) * 3_600_000`,不得改成本地时区整点。
//! 6. **`account_identity` 只增不删**:本文件不出现针对该表的 `DELETE`。
//! 7. **源库信息不硬编码**:源库路径 / 表名 / 时间列由 [`IngestSource`] 参数传入,
//!    默认值是 codex 单请求用量库那一套。换成 `codex_session_usage.sqlite` 等第二源时
//!    只需换 `IngestSource`,二态写入 / 身份归并 / 分批扫描逻辑不用重写。
//!
//! # 已知限制(必须在 UI/文档如实标注)
//!
//! 超出封桶延迟(3 小时)之后源库才发生的行更新**不追溯**(架构文档 §3.2 明确列为已知限制)。
//! 源库重建且新库首行时间落在与老数据**同一个小时桶**时,该桶可能被多计一次;
//! 这是"已封桶永不覆盖"这条硬保险的代价,边界极窄,选择保账不保精确。

use rusqlite::{Connection, OpenFlags, Transaction, TransactionBehavior};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::cockpit_logs_db::{TokenSplit, REQUEST_LOG_DB_NAME, SESSION_USAGE_DB_NAME};
use crate::ledger_db;

/// 重叠扫描行数。实测日均 4,156 行 ⇒ ≈1.2 小时,已覆盖 PRD 说的"10 分钟内可能补写"。
pub const OVERLAP_ROWS: i64 = 200;

/// 封桶延迟。必须 > 重叠窗口覆盖的时长 + 安全余量(实测重叠窗口 ≈1.2h)。
pub const SEAL_LAG_MS: i64 = 3 * 3_600_000;

/// 单个事务最多处理的行数。太大则单次持锁过久,太小则提交次数过多。
pub const BATCH_MAX_ROWS: i64 = 50_000;

/// 摄取互斥锁。5 分钟一次的后台触发 + 用户手动"立即摄取"可能撞车,
/// 竞争失败直接返 `skipped`,不排队(排队会让 UI 越点越卡)。
static INGEST_LOCK: Mutex<()> = Mutex::new(());

// 档位阈值**不在本模块重定义** —— 权威定义在
// `crate::ledger_db::TIER_LONG_CONTEXT_THRESHOLD_TOKENS`(它再透传
// `cockpit_logs_db::LONG_CONTEXT_THRESHOLD_TOKENS`,红线 3 / 共享知识第 10 条)。
//
// 这里曾有一份**同名同值的副本**(2026-09-14 清除)。留着它是净负债:两份定义让
// "改了一处忘了另一处"退化成**静默的档位漂移** —— 编译通过、测试可能仍绿,
// 但账本里的长文本档会与 cockpit 的 `summarize` 分叉。阈值只允许一个来源。
//
// 注意:摄取路径**不自己判定档位** —— 判定由 `TokenSplit::add` 单点完成(共享知识第 11 条)。

/// 一分钟的毫秒数(仅用于时长统计)。
///
/// 唯一使用点是 `describe()` 的耗时格式化,而 `describe()` 只服务于单测断言
/// ⇒ 一并收敛进测试构建,生产二进制里不留死代码。
#[cfg(test)]
const MS_PER_MINUTE: i64 = 60_000;

// =============================================================================
// 源库抽象(可传入,不硬编码)
// =============================================================================

/// 源库时间列的单位。
///
/// 为什么需要它:cockpit 两个源的时间列**单位不同** ——
/// `codex_local_access_logs.sqlite` 是 epoch **毫秒**,`codex_session_usage.sqlite` 是 epoch **秒**。
/// 账本的桶对齐、水位、`first_ms/last_ms` 一律按**毫秒**语义,所以必须在这里单点归一。
///
/// 共享知识第 18 条:秒/毫秒**只允许经本类型转换**,禁止在别处出现 `* 1000` / `/ 1000`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TsUnit {
    /// epoch 毫秒(codex 单请求用量库)。
    Millis,
    /// epoch 秒(codex 会话用量库)。
    Seconds,
}

impl TsUnit {
    /// 一个"水位单位"等于多少毫秒(秒 = 1000)。
    ///
    /// 用途:把"重叠 N 行"换算成"重叠 N 毫秒" —— 水位列**是时间列**时
    /// (会话源 `timestamp`),重叠量必须按时间算,见 [`IngestSource::overlap_for`]。
    pub fn ms_per_unit(self) -> i64 {
        match self {
            TsUnit::Millis => 1,
            TsUnit::Seconds => 1_000,
        }
    }

    /// 单点换算:原始值 → epoch 毫秒。
    ///
    /// `Seconds` 走 `saturating_mul`,坏数据(如 13 位秒值)只会得到饱和值而不是 UB。
    ///
    /// 生产路径的时间归一走 [`TsUnit::sql_expr`](SQL 片段,`SELECT` / `MIN()` / `WHERE`
    /// 三处共用),不经过本方法 —— 这里只给单测断言"秒/毫秒换算语义"用,故只在测试构建中存在。
    #[cfg(test)]
    pub fn to_ms(self, raw: i64) -> i64 {
        match self {
            TsUnit::Millis => raw,
            TsUnit::Seconds => raw.saturating_mul(1000),
        }
    }

    /// SQL 侧归一表达式。**这是本模块唯一的 `* 1000` 出现点。**
    ///
    /// 为什么放在 SQL 而不是只放在 `read_row`:
    /// 时间列同时被三处用到 —— `SELECT`(读行)、`MIN(ts)`(源库水位)、`WHERE ts >= ?`(整桶重扫)。
    /// 只在 `read_row` 换算会让后两处拿秒比毫秒,桶判定直接失效。把归一收敛成一个 SQL 片段,
    /// 三处共用同一表达式,才真正做到"单点"。
    pub fn sql_expr(&self, column: &str) -> String {
        match self {
            TsUnit::Millis => column.to_string(),
            TsUnit::Seconds => format!("({column} * 1000)"),
        }
    }
}

/// 实例级身份派生规则(源库没有账号维度时用)。
///
/// 派生结果 = `{platform}|inst:{实例名}`,例:`codex|inst:默认实例`。
/// 形态上的两个硬要求:
/// - **带 `|` 分隔符**:`IdentitySegment::platform_of` 先按 `|` 切,才能解析出
///   `codex` 平台(否则整串会被当成平台名);
/// - **绝不产生空串**:空账号会把真实用量塌缩进"未归属"桶 —— 那是丢数据,不是兜底。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstanceIdentity {
    /// 平台前缀(进 `account_identity.platform`,同时是账号 ID 前缀)。
    pub platform: String,
    /// 源库里承载实例名的列(会话源 = `instance_name`,全表实测只有 `默认实例` 一个取值)。
    pub column: String,
}

impl InstanceIdentity {
    /// 由源库实例名派生账本账号 ID。
    pub fn account_id_of(&self, raw: &str) -> String {
        let name = raw.trim();
        if name.is_empty() {
            format!("{}|inst:unknown", self.platform)
        } else {
            format!("{}|inst:{name}", self.platform)
        }
    }
}

/// 一个 cockpit 数据源的定位信息。
///
/// 抽出来是为了"账本要接多个 cockpit 源"(`codex_session_usage.sqlite` 139MB、
/// `account_store.sqlite`、`codex_pelican/history.sqlite3` …)。
/// 二态写入 / 身份归并 / 分批扫描与源库无关,换源只需换这个结构体。
#[derive(Debug, Clone)]
pub struct IngestSource {
    /// 源在账本里的标识(`codex_logs` / `codex_sessions`)。**进 `usage_rollup` 等表的 PK**,
    /// 业务代码禁止写字面量(二期共享知识第 15 条)。
    pub source_name: String,
    /// 源库文件绝对路径。
    pub db_path: PathBuf,
    /// 表名(默认 `request_logs`)。
    pub table: String,
    /// **水位列(有序)**。增量扫描与桶内幂等都依赖它。
    ///
    /// - 第 1 列必须是**整型**(它的值要持久化进 `ingest_state.last_id` /
    ///   `rollup_bucket_state.max_source_id`,两张表的列都是 INTEGER);
    /// - 第 2 列起是同值时的次级排序键(文本),**不持久化**(账本 INTEGER 列存不下文本),
    ///   跨进程恢复时取空串,由桶级二态写入吸收重复投递(见 [`Watermark`])。
    ///
    /// 生成的是**行值比较** SQL `(c1, c2) > (?1, ?2)`(SQLite 3.15+,rusqlite 内置版本足够新)。
    ///
    /// ⚠️ **绝不能用 SQLite 隐式 `rowid` 做水位**:`session_usage_events` 没有
    /// `INTEGER PRIMARY KEY`,`rowid` 只是**插入序**,且 `VACUUM` / 源库重建都会重排
    /// 行值 —— 水位会被静默污染(指向另一批数据),表现为"账本少了一截且看不出来"。
    /// 该表有真实的时间列与唯一的 `request_id`,故用 `(timestamp, request_id)` 复合水位。
    pub id_columns: Vec<String>,
    /// 请求时间列名(默认 `timestamp`)。
    pub ts_column: String,
    /// 时间列单位(默认 [`TsUnit::Millis`];session 源是 [`TsUnit::Seconds`])。
    pub ts_unit: TsUnit,
    /// 源库**没有账号列**时的实例级身份派生规则。`None` = 用源库 `account_id` 列。
    ///
    /// 为什么必须派生而不是留空:会话源 234,990 行**没有任何账号维度**
    /// (`instance_id` 恒 `__default__`,无 email / api_key / official_account),
    /// 若按"缺列 → 空串"兜底,这 23 万行真实用量会全部塌缩进同一个"零成本未归属"桶,
    /// 正是"codex 的数据又丢了"的表现形式。故一律派生成
    /// `{platform}|inst:{instance_name}` 这种**实例级**账号,与真实账号分桶但不丢量。
    pub instance_identity: Option<InstanceIdentity>,
    /// 源库**没有** `success` 列时,该源的行按成功还是失败计入。
    ///
    /// 为什么需要它(而不是像架构 §2.4 那样一律兜底 0):
    /// `TokenSplit::add` 里 token **无论成败都会累加**,`success` 只影响 `success` / `error`
    /// 两个计数。若给会话源兜底 0,`usage_rollup` 会记下"234,990 次请求、0 成功、234,990 失败"
    /// —— 真实用量被报成 100% 失败,健康度面板直接失真。这正是 N3 要防的那类坑。
    ///
    /// 语义:`None` = 本源有 `success` 列(用真实值);`Some(true)` = 无该列,且**可确证**
    /// 本源只记已完成轮次(会话用量事件);`Some(false)` = 无该列且无从判定,保守按失败计。
    pub success_when_column_absent: Option<bool>,
    /// 人类可读的源名(只用于中文错误文案与日志)。
    pub label: String,
    /// 列探测结果。`None` = 由管线打开源库后自行探测(推荐);
    /// 传入 `Some` 可用于单测预置或缓存。
    pub columns: Option<SourceColumns>,
}

impl IngestSource {
    /// 默认源:cockpit 单请求用量库 `%USERPROFILE%\.antigravity_cockpit\codex_local_access_logs.sqlite`。
    ///
    /// 路径与库名**直接复用** `cockpit_logs_db`,不在本模块重定义(红线 3 / 共享知识第 10 条)。
    pub fn codex_logs() -> Result<Self, String> {
        Ok(IngestSource {
            source_name: ledger_db::SOURCE_CODEX_LOGS.to_string(),
            db_path: crate::cockpit_logs_db::request_log_db_path()?,
            table: "request_logs".to_string(),
            id_columns: vec!["id".to_string()],
            ts_column: "timestamp".to_string(),
            ts_unit: TsUnit::Millis,
            instance_identity: None,
            // logs 源一定有 success 列 ⇒ 兜底值不会被用到
            success_when_column_absent: None,
            label: format!("cockpit 单请求用量库({REQUEST_LOG_DB_NAME})"),
            columns: None,
        })
    }

    /// 第二源:cockpit 会话用量库 `%USERPROFILE%\.antigravity_cockpit\codex_session_usage.sqlite`。
    ///
    /// 这是**唯一带 `session_id`(thread uuid)** 的来源,覆盖 3~7 月单请求库没有的历史
    /// (约 4.3 万行)。两源 `request_id` 格式不同、实测 JOIN 交集 = 0,
    /// 因此**不做行级去重**,只做"源级隔离 + 读取层口径"(架构难点 N5/N6)。
    ///
    /// 注意本源的三个"缺":
    /// - 无账号维度(`instance_id` 恒 `__default__`) ⇒ 派生成实例级账号
    ///   `codex|inst:{instance_name}`,**绝不塌缩进未归属桶**(见 [`InstanceIdentity`]);
    /// - 无成本字段 ⇒ 账本该源的 `estimated_cost_usd` 恒 0,成本只能由前端按 token 自算;
    /// - 无 success / latency / error 字段 ⇒ 兜底 `success=1`(会话事件都是已完成轮次)、
    ///   延迟样本 0(cockpit 未采集,混进去会把分位数拉向 0)。
    ///
    /// 水位为什么是 `(timestamp, request_id)` 复合而不是 `request_id` 单列:
    /// `request_id` 形如 `codex_session:thread-v1:<session_uuid>:<seq>`,序号**只在同一个
    /// session 内**单调递增,与全局时间顺序无关 ⇒ 单列水位会让"过去的 session 被后补扫进来"
    /// 这类行永远落在水位之外。以 `timestamp`(epoch 秒)为主键、`request_id` 为次级键,
    /// 才是与本表时间语义一致的全序。
    pub fn codex_sessions() -> Result<Self, String> {
        Ok(IngestSource {
            source_name: ledger_db::SOURCE_CODEX_SESSIONS.to_string(),
            db_path: crate::cockpit_logs_db::session_usage_db_path()?,
            table: crate::cockpit_logs_db::SESSION_USAGE_TABLE.to_string(),
            // 不用 rowid(见 `id_columns` 字段文档):该表没有 INTEGER PRIMARY KEY,
            // VACUUM / 重建都会重排行值,水位会被静默污染
            id_columns: vec!["timestamp".to_string(), "request_id".to_string()],
            ts_column: "timestamp".to_string(),
            ts_unit: TsUnit::Seconds,
            instance_identity: Some(InstanceIdentity {
                platform: "codex".to_string(),
                column: "instance_name".to_string(),
            }),
            // 该表只记已完成的会话轮次用量,没有 success 列 ⇒ 按成功计入(见字段文档)
            success_when_column_absent: Some(true),
            label: format!("cockpit 会话用量库({SESSION_USAGE_DB_NAME})"),
            columns: None,
        })
    }

    /// 指向任意 SQLite 源库(**预留 API:第二源接入时用**,见 skill `ledger-add-source`)。
    /// `source_name` 默认 [`DEFAULT_SOURCE_NAME`],
    /// 显式设 [`SOURCE_CODEX_SESSIONS`] 时用 [`IngestSource::codex_sessions`]。
    ///
    /// 当前生产路径只走 [`IngestSource::all_known`](codex_logs → codex_sessions),
    /// 所以编译器报"从未使用"。**显式放行而不是删除**:它是接入新源时的唯一构造入口,
    /// 删掉会让下一个源只能手抄 11 个字段(且必然抄漏 `ts_unit`)。
    /// 生产侧确实不调用它 —— 放行的只是"未使用",不是"可以随便用"。
    #[allow(dead_code)]
    pub fn sqlite(db_path: impl Into<PathBuf>, table: &str, id_column: &str, ts_column: &str) -> Self {
        let db_path = db_path.into();
        let label = format!("{}#{table}", db_path.display());
        IngestSource {
            source_name: ledger_db::DEFAULT_SOURCE_NAME.to_string(),
            db_path,
            table: table.to_string(),
            id_columns: vec![id_column.to_string()],
            ts_column: ts_column.to_string(),
            ts_unit: TsUnit::Millis,
            instance_identity: None,
            success_when_column_absent: None,
            label,
            columns: None,
        }
    }

    /// 水位**首列**(整型,值要落 `ingest_state.last_id` / `max_source_id`)。
    ///
    /// 复合水位源的完整列用 [`IngestSource::id_columns`];单列源的调用点继续用本方法,
    /// 省得为了一个元素到处写 `[0]`。
    pub fn id_column(&self) -> &str {
        self.id_columns.first().map_or("", |c| c.as_str())
    }

    /// 完整水位列(有序)。扫描 SQL 的 `ORDER BY` 与行值比较都取自它。
    pub fn id_columns(&self) -> &[String] {
        &self.id_columns
    }

    /// 水位首列是否是时间列。
    fn is_time_watermark(&self) -> bool {
        self.id_column() == self.ts_column
    }

    /// 该源的重叠扫描量(**水位列的原生单位**)。
    ///
    /// - 水位是时间列(会话源 `timestamp`,单位秒)⇒ 重叠整整一个封桶延迟
    ///   ([`SEAL_LAG_MS`] 换算成秒 = 10,800),保证"还可能被改的整个未封桶窗口"
    ///   每轮都被重扫 —— 否则按 200 行/200 秒的旧口径,3 小时窗口内的迟到回填会漏掉;
    /// - 水位是自增 id(单请求源)⇒ 沿用行数口径 200 行 ≈ 1.2 小时。
    pub fn overlap_for(&self, overlap_rows: i64) -> i64 {
        if self.is_time_watermark() {
            SEAL_LAG_MS / self.ts_unit.ms_per_unit().max(1)
        } else {
            overlap_rows.max(0)
        }
    }

    /// 时间列的**毫秒语义** SQL 表达式(`SELECT` / `MIN()` 两处共用)。
    fn ts_expr(&self) -> String {
        self.ts_unit.sql_expr(&self.ts_column)
    }

    /// 整桶重扫的时间范围**边界**(单位 = 时间列的原生单位)。
    ///
    /// 为什么不直接拿毫秒去比 `(timestamp * 1000)`:那样 SQLite 用不上
    /// `idx_session_usage_timestamp`,**每个桶都是一次 23 万行全表扫** ——
    /// 首次回填 178 天 = 4,272 个桶 ⇒ 十亿行级读取。把**边界**换算成源列单位、
    /// 让裸列直接与索引比较,一次桶扫描只读该桶那几十行。
    ///
    /// 换算无损(不是近似):小时桶是 3_600_000 ms 的整数倍,秒单位下同样是
    /// 3_600 的整数倍,故 `ts ∈ [bucket_s, bucket_s + 3_600)` 与
    /// `hour_bucket(ts * 1000) == bucket_ms` **完全等价**。
    /// 这是 `ts_expr` 的**逆运算**,两者都收敛在 [`TsUnit`] 上,不散落到调用点。
    fn bucket_bounds(&self, bucket_ms: i64) -> (i64, i64) {
        let unit = self.ts_unit.ms_per_unit().max(1);
        (
            bucket_ms.div_euclid(unit),
            (bucket_ms + ledger_db::HOUR_MS).div_euclid(unit),
        )
    }

    /// 全部已知源(摄取入口按此顺序遍历)。
    ///
    /// 某个源定位失败(如主目录环境变量缺失)**不阻断其它源** —— 逐源 `Result`,
    /// 由调用方把失败源如实报成 `sourceAvailable:false`,绝不静默跳过。
    pub fn all_known() -> Vec<Result<Self, String>> {
        vec![Self::codex_logs(), Self::codex_sessions()]
    }
}

/// 源库列探测结果。
///
/// cockpit 各版本列不一致(旧版没有 `email` / `event_key` / `official_account_id` /
/// `client_instance_id` / `model_pricing_version`)。缺列时用 `''` / `0` 兜底并**动态拼 SELECT**,
/// 而不是让一条 SQL 因缺列整批失败。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SourceColumns {
    /// 源库实际列名(保留原始大小写,比较时忽略大小写)。
    present: Vec<String>,
    pub has_email: bool,
    pub has_event_key: bool,
    pub has_official_account_id: bool,
    pub has_client_instance_id: bool,
    pub has_model_pricing_version: bool,
    pub has_http_status: bool,
}

impl SourceColumns {
    /// `PRAGMA table_info(<table>)` 探测。探测成本 < 1 ms,且只在单批次内使用:
    /// cockpit 升级后列会变,不跨进程缓存。
    ///
    /// **额外补隐式 `rowid`**:`PRAGMA table_info` 不返回 `rowid` / `_rowid_` / `oid`。
    /// 不补的话,某个源若只能以 `rowid` 作水位(既没有整型主键、也没有可用时间列),
    /// 会出现两个后果:① `has("rowid")` 为假 → 被误判"源不兼容";
    /// ② `pick("rowid", "0 AS id")` 兜底成常量 0 → 水位永远停在 0、每轮全量重扫。
    /// 只有 `WITHOUT ROWID` 表才真的没有 rowid,故按 DDL 判定后再补。
    ///
    /// ⚠️ **当前两个源都不用它**:会话源走 `(timestamp, request_id)` 复合水位 ——
    /// `rowid` 是插入序,源库重建 / `VACUUM` 会重排行值,水位会被静默污染。
    /// 这里保留探测能力只是给"将来某个只有 TEXT 主键的源"留后路。
    pub fn probe(conn: &Connection, table: &str) -> Result<Self, String> {
        if table.is_empty() || !table.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(format!("源表名不合法: {table:?}"));
        }
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(|e| format!("探测源表列失败({table}): {e}"))?;
        let mut present: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| format!("探测源表列失败({table}): {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("读取源表列失败({table}): {e}"))?;
        drop(stmt);

        // 隐式 rowid:非 WITHOUT ROWID 表才存在(见本方法文档注释)
        if !Self::is_without_rowid(conn, table)? {
            for alias in ["rowid", "_rowid_", "oid"] {
                present.push(alias.to_string());
            }
        }
        Ok(Self::from_present(present))
    }

    /// 源表是否 `WITHOUT ROWID`(DDL 里带该关键字 ⇒ 没有隐式 rowid)。
    fn is_without_rowid(conn: &Connection, table: &str) -> Result<bool, String> {
        let ddl: Option<String> = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1",
                rusqlite::params![table],
                |row| row.get::<_, Option<String>>(0),
            )
            .unwrap_or(None);
        Ok(ddl
            .map(|s| s.to_ascii_uppercase().contains("WITHOUT ROWID"))
            .unwrap_or(false))
    }

    /// 由已知列名构造(单测可直接用,无需先建库)。
    pub fn from_present(present: Vec<String>) -> Self {
        let has = |name: &str| present.iter().any(|c| c.eq_ignore_ascii_case(name));
        SourceColumns {
            has_email: has("email"),
            has_event_key: has("event_key"),
            has_official_account_id: has("official_account_id"),
            has_client_instance_id: has("client_instance_id"),
            has_model_pricing_version: has("model_pricing_version"),
            has_http_status: has("http_status"),
            present,
        }
    }

    /// 源库是否有某列(忽略大小写)。
    pub fn has(&self, name: &str) -> bool {
        self.present.iter().any(|c| c.eq_ignore_ascii_case(name))
    }

    /// 列存在则用该列,否则用 `fallback`(一段带 `AS xxx` 的 SQL 表达式)。
    fn pick(&self, name: &str, fallback: &str) -> String {
        if self.has(name) {
            name.to_string()
        } else {
            fallback.to_string()
        }
    }

    /// **多候选**列名:按顺序取第一个存在的列,全都不存在才用 `fallback`。
    ///
    /// 为什么需要:两个源的同一逻辑字段列名不同 ——
    /// `model_id` / **`model`**、`cached_tokens` / **`cached_input_tokens`**。
    /// 不改 `pick()` 的单候选签名(向后兼容),新增本方法。
    fn pick_any(&self, candidates: &[&str], fallback: &str) -> String {
        for name in candidates {
            if self.has(name) {
                return (*name).to_string();
            }
        }
        fallback.to_string()
    }

    /// 账号列的最终 SQL 片段。
    ///
    /// 实例级身份源(会话源)直接把**实例名列**选进 account 槽,
    /// 由 [`InstanceIdentity::account_id_of`] 在 `read_row` 里派生 `{platform}|inst:{name}`。
    /// 为什么不拼 `'codex|inst:' || instance_name` 这种 SQL 表达式:派生规则要能被单测
    /// 直接断言(不建库、不跑 SQL),留在 Rust 侧才测得到;SQL 侧只负责"列在不在"。
    fn account_sql(&self, source: &IngestSource) -> String {
        match &source.instance_identity {
            Some(identity) => self.pick(&identity.column, "'' AS account_id"),
            None => self.pick("account_id", "'' AS account_id"),
        }
    }

    /// 动态拼 SELECT。核心 8 列(`id` / 时间 / 账号 / 模型 / 网关密钥 / 三档 token / success)
    /// 缺列时也兜底为 `0`,只有 `id` 与时间列缺失才算源不兼容(由调用方判定)。
    ///
    /// 时间列一律经 [`IngestSource::ts_expr`] 归一成**毫秒**(session 源是秒),
    /// 账号列走 [`IngestSource::instance_identity`] 派生(缺列时回退空串)。
    ///
    /// 复合水位源会在 18 个固定列**之后**追加次级水位列(见 [`Self::IDX_WATERMARK_TEXT`]),
    /// 缺列时同样兜底成空串 —— 保证任何表结构上都能拼出一条**可执行**的 SELECT。
    pub fn select_sql(&self, source: &IngestSource) -> String {
        let table = &source.table;
        let mut cols: Vec<String> = vec![
            // 固定列(顺序即读取下标,改动必须同步 `read_row`)
            // 水位首列(复合水位时次级列在下面追加)
            self.pick(source.id_column(), "0 AS id"),
            source.ts_expr(),
            self.account_sql(source),
            self.pick("api_key_id", "'' AS api_key_id"),
            // logs 源 `model_id`;sessions 源 `model`
            self.pick_any(&["model_id", "model"], "'' AS model_id"),
            self.pick("input_tokens", "0 AS input_tokens"),
            self.pick("output_tokens", "0 AS output_tokens"),
            // logs 源 `cached_tokens`;sessions 源 `cached_input_tokens`
            self.pick_any(&["cached_tokens", "cached_input_tokens"], "0 AS cached_tokens"),
            // success 列缺失时按源声明兜底(不是一律 0,见 `success_when_column_absent`)
            self.pick(
                "success",
                match source.success_when_column_absent {
                    Some(true) => "1 AS success",
                    _ => "0 AS success",
                },
            ),
            self.pick("estimated_cost_usd", "0 AS estimated_cost_usd"),
            self.pick("latency_ms", "0 AS latency_ms"),
            self.pick("error_category", "'' AS error_category"),
            // 版本相关列(旧库没有 ⇒ 兜底空 / NULL)
            self.pick("email", "'' AS email"),
            self.pick("event_key", "'' AS event_key"),
            self.pick("official_account_id", "'' AS official_account_id"),
            self.pick("client_instance_id", "'' AS client_instance_id"),
            self.pick("model_pricing_version", "NULL AS model_pricing_version"),
            self.pick("http_status", "NULL AS http_status"),
        ];
        // 复合水位的次级列:紧跟 18 个固定列,按 `id_columns` 顺序排列
        for column in source.id_columns().iter().skip(1) {
            cols.push(if self.has(column) {
                column.clone()
            } else {
                format!("'' AS {column}")
            });
        }
        format!("SELECT {} FROM {table}", cols.join(", "))
    }

    /// 读取下标契约(`select_sql` 的列顺序,`read_row` 依赖它)。
    const IDX_ID: usize = 0;
    const IDX_TS: usize = 1;
    const IDX_ACCOUNT: usize = 2;
    const IDX_API_KEY: usize = 3;
    const IDX_MODEL: usize = 4;
    const IDX_INPUT: usize = 5;
    const IDX_OUTPUT: usize = 6;
    const IDX_CACHED: usize = 7;
    const IDX_SUCCESS: usize = 8;
    const IDX_ESTIMATED: usize = 9;
    const IDX_LATENCY: usize = 10;
    const IDX_ERROR_CAT: usize = 11;
    const IDX_EMAIL: usize = 12;
    const IDX_EVENT_KEY: usize = 13;
    const IDX_OFFICIAL: usize = 14;
    const IDX_INSTANCE: usize = 15;
    const IDX_PRICING_VERSION: usize = 16;
    const IDX_HTTP_STATUS: usize = 17;
    /// 复合水位**次级列**的起始下标(第 1 列是 `IDX_ID`,故次级列从第 19 列开始)。
    const IDX_WATERMARK_TEXT: usize = 18;
}

/// 一条源库请求行(与类图 `SourceRow` 一一对应)。
#[derive(Debug, Clone, Default)]
pub struct SourceRow {
    /// 水位首列的值(整型)。桶级幂等与 `ingest_state.last_id` 都用它。
    pub id: i64,
    /// 复合水位的**次级列**值(按 `id_columns[1..]` 顺序)。单列水位源为空。
    ///
    /// 只在同一轮摄取内连续使用(推进批游标);跨轮从空串恢复,
    /// 因为账本的水位列是 INTEGER,存不下文本(见 [`Watermark`] 文档)。
    pub id_text: Vec<String>,
    /// 源行的 `event_key`(旧库无此列时为空串)。
    ///
    /// 生产侧**只写不读** —— 去重靠 `id` 水位 + 桶级二态写入,不靠这一列;
    /// 源库指纹里的 `first_event_key` 另有独立的 `MIN(id)` 查询,不走本字段。
    /// 读取方目前只有单测(断言 `read_row` 的列探测:新版取原值 / 旧库缺列兜底空串)。
    /// 显式放行而不是删掉:它是"列探测"这条链路的可观测产物,删了会让
    /// `columns.has_event_key` 的探测结果失去对应的取值断言。
    #[allow(dead_code)]
    pub event_key: String,
    pub ts_ms: i64,
    pub account_id: String,
    pub email: String,
    pub official_account_id: String,
    pub api_key_id: String,
    pub model_id: String,
    pub input: i64,
    pub output: i64,
    pub cached: i64,
    pub success: bool,
    pub estimated_cost_usd: f64,
    pub latency_ms: i64,
    pub error_category: String,
    pub http_status: Option<i64>,
    pub model_pricing_version: Option<String>,
    pub client_instance_id: String,
}

impl SourceRow {
    /// 时间桶(epoch 小时对齐)。**不得改成本地时区整点**。
    pub fn hour_bucket(&self) -> i64 {
        ledger_db::hour_bucket(self.ts_ms)
    }
}

/// 事实表 grain(v8:6 列,与 `usage_rollup` 主键一致,含 `source_name`)。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BucketKey {
    pub hour_bucket: i64,
    /// 数据源标识。**进主键**:两源"同账号同小时同模型"必须能各存一行(二期难点 N1)。
    pub source_name: String,
    pub source_account_id: String,
    pub model_id: String,
    pub api_key_id: String,
    pub client_instance_id: String,
}

/// 一个桶内某 grain 的聚合结果。
///
/// `split` 直接复用 `cockpit_logs_db::TokenSplit`(组合而非继承),
/// 保证分档口径与既有 cockpit 链路**零漂移**(共享知识第 11 条)。
#[derive(Debug, Clone, Default)]
pub struct RollupAgg {
    pub split: TokenSplit,
    /// `latency_ms > 0` 的样本。0 表示 cockpit 未采集到耗时,混进去会把分位数拉向 0。
    pub latency_samples: Vec<i64>,
    pub error_categories: BTreeMap<String, i64>,
    pub first_ms: Option<i64>,
    pub last_ms: Option<i64>,
    /// 本 grain 已计入的源库最大 id(幂等水位)。
    pub max_source_id: i64,
    /// 本 grain 本次聚合的源行数(自检用)。
    pub source_rows: i64,
    /// cockpit 原样搬运的价目版本(**仅供审计,绝不参与计价**)。空值不覆盖已知值。
    pub model_pricing_version: Option<String>,
}

impl RollupAgg {
    /// 累加一条源行。分档判定**必须**走 `TokenSplit::add`(红线 3)。
    pub fn add(&mut self, row: &SourceRow) {
        self.split.add(
            row.input,
            row.output,
            row.cached,
            row.success,
            row.estimated_cost_usd,
            &row.error_category,
            row.http_status,
        );
        if row.latency_ms > 0 {
            self.latency_samples.push(row.latency_ms);
        }
        if !row.error_category.is_empty() {
            *self.error_categories.entry(row.error_category.clone()).or_insert(0) += 1;
        }
        self.first_ms = Some(self.first_ms.map_or(row.ts_ms, |m: i64| m.min(row.ts_ms)));
        self.last_ms = Some(self.last_ms.map_or(row.ts_ms, |m: i64| m.max(row.ts_ms)));
        self.max_source_id = self.max_source_id.max(row.id);
        self.source_rows += 1;
        if let Some(version) = &row.model_pricing_version {
            if !version.is_empty() {
                self.model_pricing_version = Some(version.clone());
            }
        }
    }

    /// 最近秩分位数(与 `cockpit_logs_db::percentile()` 同实现,保证口径一致)。
    pub fn percentile(&self, pct: f64) -> Option<i64> {
        if self.latency_samples.is_empty() {
            return None;
        }
        let mut sorted = self.latency_samples.clone();
        sorted.sort_unstable();
        let idx = ((sorted.len() - 1) as f64 * pct).round() as usize;
        sorted.get(idx).copied()
    }

    fn p50(&self) -> Option<i64> {
        self.percentile(0.50)
    }

    fn p95(&self) -> Option<i64> {
        self.percentile(0.95)
    }

    /// `error_categories` 落库 JSON(键排序,保证同样输入产出同样字符串,便于对账)。
    pub fn error_categories_json(&self) -> String {
        serde_json::to_string(&self.error_categories).unwrap_or_else(|_| "{}".to_string())
    }
}

/// 身份分段(`account_identity` 一行)。**只增不删**。
///
/// 双时态列 `valid_from_hour` / `valid_to_hour` 是 T01 对 BUG-2 的修正:
/// 换绑邮箱回摆 A→B→A 时必须是 3 段,否则读取 JOIN 会一对多 fan-out 让度量翻倍。
#[derive(Debug, Clone, Default)]
pub struct IdentitySegment {
    pub source_account_id: String,
    pub client_instance_id: String,
    pub platform: String,
    pub email_norm: String,
    pub email_display: String,
    pub official_account_id: String,
    pub is_provider_test: bool,
    pub valid_from_hour: i64,
    /// 闭段时刻(epoch 小时);`None` = 该段仍开着。
    ///
    /// 生产侧**只写不读** —— "找开段 / 闭旧段"全在 SQL 里判(`valid_to_hour IS NULL`),
    /// 不经过本字段;读取方只有单测(断言"新开段必须是开段")。显式放行而不是删掉:
    /// 双时态是本表对 BUG-2 的核心修正,字段本身是那段设计的载体,删了它
    /// `INSERT` / `UPDATE` 两处 SQL 就失去了类型层面的对照。
    #[allow(dead_code)]
    pub valid_to_hour: Option<i64>,
    pub first_seen_ms: i64,
    pub last_seen_ms: i64,
    pub first_seen_source_id: i64,
    pub last_seen_source_id: i64,
}

impl IdentitySegment {
    /// `email_norm` = `lower(trim(email))`,归并比较用;`email_display` 保留原始大小写。
    pub fn email_norm_of(email: &str) -> String {
        email.trim().to_lowercase()
    }

    /// `platform` 取 `account_id` 前缀(架构文档 Q1 建议 ①),UI 侧另有枚举映射。
    ///
    /// **先按 `|` 切**:实例级派生账号是 `{platform}|inst:{name}` 形态
    /// (见 [`InstanceIdentity`]),不先切 `|` 会把 `codex|inst:默认实例` 整串当成平台名。
    /// 再按 `_` 切(如 `codex_apikey_abc` → `codex`)。
    pub fn platform_of(source_account_id: &str) -> String {
        source_account_id
            .split('|')
            .next()
            .unwrap_or("")
            .split('_')
            .next()
            .unwrap_or("")
            .to_string()
    }

    /// `model_provider_test_*` 前缀 → 隔离到测试分区(决策 5)。
    pub fn is_provider_test_of(source_account_id: &str) -> bool {
        source_account_id.starts_with("model_provider_test")
    }
}

// =============================================================================
// 水位
// =============================================================================

/// `ingest_state` 一行水位(v9 起按 `source_name` 分源,一个源一行)。
#[derive(Debug, Clone, Default)]
pub struct IngestState {
    /// 数据源标识(主键)。
    pub source_name: String,
    pub client_instance_id: String,
    pub source_path: String,
    pub source_fingerprint: String,
    pub last_id: i64,
    pub last_ts_ms: i64,
    pub last_ingest_ms: i64,
    pub last_batch_rows: i64,
    pub last_duration_ms: i64,
    pub total_rows_seen: i64,
    pub schema_version: u32,
}

/// 源库指纹 + 重建世代的编码。
///
/// 为什么塞进 `source_fingerprint` 这一个 TEXT 列,而不是给 `ingest_state` 加两列:
/// T01 定稿的 `ingest_state` 列结构被冻结("不得改动既有表结构"),而"重建判定"
/// 本来就要求把这个指纹持久化。把结构化字段编成单行 JSON 既满足持久化要求,
/// 又零 schema 变更;`parse()` 同时兼容架构文档写的 `MIN(id)|首行event_key` 裸格式。
///
/// T03 读状态时:`SourceFingerprint::parse(&state.source_fingerprint)`
/// → `.reset_detected()` / `.generation()`。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SourceFingerprint {
    /// 重建世代。每检测到一次源库重建 +1;**只增**。
    generation: i64,
    /// 最近一次摄取是否检测到源库重建(供 UI 提示"源库已重置,账本按累加口径续接")。
    reset_detected: bool,
    /// 源库当前 `MIN(id)`。
    min_id: i64,
    /// 源库 `id` 最小那一行的 `event_key`(旧库无此列时为空串)。
    first_event_key: String,
}

impl SourceFingerprint {
    /// 重建判据只看这两项:首行 id 与首行 event_key。
    fn signature(&self) -> String {
        format!("{}|{}", self.min_id, self.first_event_key)
    }

    pub fn generation(&self) -> i64 {
        self.generation
    }

    // 下面三个 getter 只有单测读(`generation()` 生产侧在用,故不在此列)。
    // 生产侧读同一批数据走的是**字段直读**(`signature()` / `encode()`),
    // 所以收敛进测试构建 —— 需要生产访问时把 `#[cfg(test)]` 去掉即可,改动是显式的。
    #[cfg(test)]
    pub fn reset_detected(&self) -> bool {
        self.reset_detected
    }

    #[cfg(test)]
    pub fn min_id(&self) -> i64 {
        self.min_id
    }

    #[cfg(test)]
    pub fn first_event_key(&self) -> &str {
        &self.first_event_key
    }

    /// 编码成单行 JSON。
    fn encode(&self) -> String {
        serde_json::to_string(&serde_json::json!({
            "generation": self.generation,
            "resetDetected": self.reset_detected,
            "minId": self.min_id,
            "firstEventKey": self.first_event_key,
        }))
        .unwrap_or_default()
    }

    /// 解析:优先按 JSON 解析;失败则按架构文档的 `MIN(id)|首行event_key` 裸格式兜底。
    pub fn parse(raw: &str) -> Self {
        let raw = raw.trim();
        if raw.is_empty() {
            return Self::default();
        }
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) {
            return SourceFingerprint {
                generation: value.get("generation").and_then(|v| v.as_i64()).unwrap_or(0),
                reset_detected: value
                    .get("resetDetected")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                min_id: value.get("minId").and_then(|v| v.as_i64()).unwrap_or(0),
                first_event_key: value
                    .get("firstEventKey")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            };
        }
        // 裸格式:MIN(id)|首行event_key
        let (min_part, key_part) = raw.split_once('|').unwrap_or((raw, ""));
        SourceFingerprint {
            generation: 0,
            reset_detected: false,
            min_id: min_part.trim().parse::<i64>().unwrap_or(0),
            first_event_key: key_part.to_string(),
        }
    }
}

/// 摄取水位游标:数值首列 + 次级文本列。
///
/// 为什么拆成"能持久化的"和"只能活一轮的"两部分:
/// 账本的水位列(`ingest_state.last_id` / `rollup_bucket_state.max_source_id`)是
/// **INTEGER**,`request_id` 是文本,塞不进去 —— 而 ledger_db 的表结构不允许为
/// 一个源新增列。所以跨轮只恢复 `numeric`,次级列取空串,代价是"与首列值相同的行
/// 会被重新投递一次"。这个重复投递由桶级二态写入**完全吸收**:
/// - 未封桶 → 整桶重算覆盖(重投多少都一样);
/// - 已封桶 → `id <= max_source_id` 直接跳过(重投的必然 <= 水位)。
/// 因此"只存数值"不会重复计数,只是多读几行。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Watermark {
    /// 水位首列的值(整型,**可持久化**)。
    pub numeric: i64,
    /// 次级列的值。**不持久化**,跨轮为空。
    pub text: Vec<String>,
}

impl Watermark {
    /// 从持久化水位恢复(`rescan` 时传 0 即可)。
    pub fn at(numeric: i64) -> Self {
        Watermark { numeric, text: Vec::new() }
    }

    /// 推进到这批行的最大水位(批内已按水位列升序,这里取 max 只是防御)。
    fn advance(&mut self, rows: &[SourceRow]) {
        for row in rows {
            if self.numeric < row.id || (self.numeric == row.id && Self::text_less(&self.text, &row.id_text)) {
                self.numeric = row.id;
                self.text = row.id_text.clone();
            }
        }
    }

    /// 逐列字典序比较,缺位按空串(空串最小 ⇒ 恢复态一定被推进)。
    fn text_less(a: &[String], b: &[String]) -> bool {
        let len = a.len().max(b.len());
        for i in 0..len {
            let left = a.get(i).map_or("", |s| s.as_str());
            let right = b.get(i).map_or("", |s| s.as_str());
            if left != right {
                return left < right;
            }
        }
        false
    }

    /// 绑定参数:首列数值 + 次级列(缺位补空串,长度对齐 `columns`)。
    fn binds(&self, columns: usize) -> Vec<rusqlite::types::Value> {
        let mut out = Vec::with_capacity(columns.max(1));
        out.push(rusqlite::types::Value::Integer(self.numeric));
        for i in 0..columns.saturating_sub(1) {
            out.push(rusqlite::types::Value::Text(self.text.get(i).cloned().unwrap_or_default()));
        }
        out
    }
}

/// 源库当前事实(`MAX(id)` / `MIN(id)` / `MIN(ts)` / 首行 event_key)。
#[derive(Debug, Clone, Default)]
struct SourceFacts {
    max_id: i64,
    min_id: i64,
    min_ts_ms: i64,
    first_event_key: String,
    row_count: i64,
}

// =============================================================================
// 选项与结果
// =============================================================================

/// `ledger_ingest` 的入参。
#[derive(Debug, Clone)]
pub struct IngestOptions {
    /// 强制全量重扫(`start_id = 0`)。**不影响已封桶的累加语义**:已封桶仍只累加新行。
    pub full_rescan: bool,
    /// 重叠扫描行数,默认 [`OVERLAP_ROWS`]。
    pub overlap_rows: i64,
    /// 客户端实例 ID(多机合并时区分),默认 `""` = 本机。
    pub client_instance_id: String,
    /// 源库定位。`None` = **全部已知源**([`IngestSource::all_known`],当前 = codex_logs + codex_sessions)。
    pub source: Option<IngestSource>,
    /// 注入"现在"(单测固定时钟用)。`None` = 真实系统时间。
    pub now_ms: Option<i64>,
}

impl Default for IngestOptions {
    fn default() -> Self {
        IngestOptions {
            full_rescan: false,
            overlap_rows: OVERLAP_ROWS,
            client_instance_id: String::new(),
            source: None,
            now_ms: None,
        }
    }
}

/// `ledger_ingest` 的返回(与类图 `IngestResult` 一致 + 重建世代两个字段)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestResult {
    /// 摄取流程本身是否正常结束(与源库可用性无关)。
    pub ok: bool,
    /// 上一轮摄取还在跑 ⇒ 本轮直接让路,不做任何事。
    pub skipped: bool,
    /// 源库是否可用。false 时 `reason` 必有值,**绝不静默变 0**(B5)。
    pub source_available: bool,
    pub reason: Option<String>,
    /// 本批扫描到的源行数(含重叠窗口)。
    pub scanned_rows: i64,
    /// 本次 UPSERT 的桶数。
    pub upserted_buckets: i64,
    /// 本次新增的身份分段数(只增不删)。
    pub new_identity_rows: i64,
    pub duration_ms: i64,
    /// 摄取后源库水位。
    pub last_id: i64,
    /// 是否触发了全量重扫(源库重建 或 用户勾选"完整重扫")。
    pub rescan_triggered: bool,
    /// 源库指纹是否变化。
    pub fingerprint_changed: bool,
    /// 提交的事务批次数。
    pub batches: i64,
    /// 是否检测到源库重建(供 UI 提示;已持久化到 `ingest_state.source_fingerprint`)。
    pub source_reset_detected: bool,
    /// 源库重建世代(每次重建 +1)。
    pub source_generation: i64,
}

impl IngestResult {
    /// 源库不可用:不是 `Err`,而是"如实报不可用"(B5)。
    fn source_unavailable(reason: impl Into<String>) -> Self {
        IngestResult {
            ok: true,
            skipped: false,
            source_available: false,
            reason: Some(reason.into()),
            scanned_rows: 0,
            upserted_buckets: 0,
            new_identity_rows: 0,
            duration_ms: 0,
            last_id: 0,
            rescan_triggered: false,
            fingerprint_changed: false,
            batches: 0,
            source_reset_detected: false,
            source_generation: 0,
        }
    }

    /// 已有摄取在跑:让路,不算失败。
    fn skipped() -> Self {
        IngestResult {
            ok: true,
            skipped: true,
            source_available: true,
            reason: Some("已有摄取任务在执行,本轮跳过".to_string()),
            ..IngestResult::default()
        }
    }
}

impl Default for IngestResult {
    fn default() -> Self {
        IngestResult {
            ok: true,
            skipped: false,
            source_available: true,
            reason: None,
            scanned_rows: 0,
            upserted_buckets: 0,
            new_identity_rows: 0,
            duration_ms: 0,
            last_id: 0,
            rescan_triggered: false,
            fingerprint_changed: false,
            batches: 0,
            source_reset_detected: false,
            source_generation: 0,
        }
    }
}

// =============================================================================
// 多源摄取结果(逐源如实上报)
// =============================================================================

/// 单个源的摄取结果。
///
/// 为什么不直接复用 [`IngestResult`]:多源下必须能**逐源**说清"哪个源扫了多少行、
/// 哪个源不可用、不可用的原因是什么"。把两源合并成一个数字,就再也看不出
/// "会话源其实一行都没进来"——那正是本次审计要根治的静默失败。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceIngestOutcome {
    /// 源标识(`codex_logs` / `codex_sessions`)。
    pub source_name: String,
    /// 人类可读的源名(中文,直接可用于 UI)。
    pub label: String,
    /// 该源本轮流程是否正常结束。
    pub ok: bool,
    /// 让路(已有摄取在跑)。
    pub skipped: bool,
    /// 源库是否可用。false 时 `reason` 必有值。
    pub source_available: bool,
    pub reason: Option<String>,
    pub scanned_rows: i64,
    pub upserted_buckets: i64,
    pub new_identity_rows: i64,
    pub last_id: i64,
    pub rescan_triggered: bool,
    pub source_reset_detected: bool,
    pub source_generation: i64,
    pub duration_ms: i64,
}

impl SourceIngestOutcome {
    fn of(source: &IngestSource, r: IngestResult) -> Self {
        SourceIngestOutcome {
            source_name: source.source_name.clone(),
            label: source.label.clone(),
            ok: r.ok,
            skipped: r.skipped,
            source_available: r.source_available,
            reason: r.reason,
            scanned_rows: r.scanned_rows,
            upserted_buckets: r.upserted_buckets,
            new_identity_rows: r.new_identity_rows,
            last_id: r.last_id,
            rescan_triggered: r.rescan_triggered,
            source_reset_detected: r.source_reset_detected,
            source_generation: r.source_generation,
            duration_ms: r.duration_ms,
        }
    }

    /// 源定位失败(如主目录环境变量缺失):不是 `Err`,如实上报不可用。
    fn unlocated(reason: impl Into<String>) -> Self {
        SourceIngestOutcome {
            source_name: String::new(),
            label: String::new(),
            ok: true,
            skipped: false,
            source_available: false,
            reason: Some(reason.into()),
            scanned_rows: 0,
            upserted_buckets: 0,
            new_identity_rows: 0,
            last_id: 0,
            rescan_triggered: false,
            source_reset_detected: false,
            source_generation: 0,
            duration_ms: 0,
        }
    }

    /// 该源摄取过程中抛了硬错误(**不阻断其它源**,如实记为失败)。
    fn failed(source: &IngestSource, reason: impl Into<String>) -> Self {
        SourceIngestOutcome {
            ok: false,
            source_available: true,
            reason: Some(reason.into()),
            ..Self::of(source, IngestResult::default())
        }
    }

    /// 让路态(整轮被并发摄取挡下)。
    fn skipped_of(source: &IngestSource) -> Self {
        Self::of(source, IngestResult::skipped())
    }
}

/// 一轮"全部源"的摄取结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestAllResult {
    /// 所有源都正常结束(`skipped` 与"源不可用"都算正常 —— 后者是 B5 语义,不是失败)。
    pub ok: bool,
    /// 逐源明细,**顺序与 [`IngestSource::all_known`] 一致**。
    pub sources: Vec<SourceIngestOutcome>,
    pub total_scanned_rows: i64,
    pub total_upserted_buckets: i64,
    /// 本轮总耗时(含全部源)。
    pub duration_ms: i64,
}

impl IngestAllResult {
    fn of(sources: Vec<SourceIngestOutcome>, started_ms: i64) -> Self {
        IngestAllResult {
            ok: sources.iter().all(|s| s.ok),
            total_scanned_rows: sources.iter().map(|s| s.scanned_rows).sum(),
            total_upserted_buckets: sources.iter().map(|s| s.upserted_buckets).sum(),
            duration_ms: (ledger_db::now_ms() - started_ms).max(0),
            sources,
        }
    }

    /// 整轮让路:每个已知源都标 `skipped`,不算失败。
    fn skipped_all() -> Self {
        let sources = IngestSource::all_known()
            .into_iter()
            .map(|s| match s {
                Ok(source) => SourceIngestOutcome::skipped_of(&source),
                Err(e) => SourceIngestOutcome::unlocated(e),
            })
            .collect();
        IngestAllResult {
            ok: true,
            sources,
            total_scanned_rows: 0,
            total_upserted_buckets: 0,
            duration_ms: 0,
        }
    }
}

// =============================================================================
// 源库 I/O
// =============================================================================

/// 只读打开源库。
///
/// cockpit 的库是 WAL 模式:只读连接需要能读写 `-shm`,因此先试只读,
/// 失败(通常是要做 WAL 恢复)再退化为可写连接 + `query_only=1`
/// —— 保证**不改动 cockpit 数据**,同时允许访问 shm。与 `cockpit_logs_db` 同策略。
fn open_source_readonly(path: &Path) -> Result<Connection, String> {
    let read_only = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = match Connection::open_with_flags(path, read_only) {
        Ok(conn) => conn,
        Err(first) => Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| format!("打开源库失败(只读: {first};可写: {e})"))?,
    };
    conn.pragma_update(None, "query_only", true)
        .map_err(|e| format!("设置源库 query_only 失败: {e}"))?;
    conn.busy_timeout(std::time::Duration::from_millis(5_000))
        .map_err(|e| format!("设置源库 busy_timeout 失败: {e}"))?;
    Ok(conn)
}

/// 源库是否含指定表。
fn source_table_exists(conn: &Connection, table: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
        rusqlite::params![table],
        |_| Ok(true),
    )
    .or_else(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => Ok(false),
        other => Err(other),
    })
    .map_err(|e| format!("探测源表是否存在失败({table}): {e}"))
}

/// 读取源库当前事实。
fn read_source_facts(
    conn: &Connection,
    source: &IngestSource,
    columns: &SourceColumns,
) -> Result<SourceFacts, String> {
    let id = source.id_column();
    // MIN(ts) 必须走**毫秒语义**表达式:会话源裸列是秒,直接 MIN 会得到秒值,
    // 传给 `hour_bucket()` 会算出一个 ≈1970 的桶 ⇒ 重建时把所有桶的水位都归零 ⇒ 重复计数。
    let ts = source.ts_expr();
    let table = &source.table;
    let key_expr = columns.pick("event_key", "'' AS event_key");
    let sql = format!(
        "SELECT MAX({id}), MIN({id}), MIN({ts}), COUNT(*), \
         (SELECT {key_expr} FROM {table} WHERE {id} = (SELECT MIN({id}) FROM {table})) \
         FROM {table}"
    );
    conn.query_row(&sql, [], |row| {
        Ok(SourceFacts {
            max_id: row.get::<_, Option<i64>>(0)?.unwrap_or(0),
            min_id: row.get::<_, Option<i64>>(1)?.unwrap_or(0),
            min_ts_ms: row.get::<_, Option<i64>>(2)?.unwrap_or(0),
            row_count: row.get::<_, i64>(3).unwrap_or(0),
            first_event_key: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
        })
    })
    .map_err(|e| format!("读取源库水位失败({table}): {e}"))
}

/// 按 `select_sql` 的列顺序读一行。
///
/// `source` 进来是为了三件"源相关"的归一,都集中在这里,不散落到调用点:
/// ① 时间单位(秒 → 毫秒,经 [`TsUnit::sql_expr`] 在 SQL 侧完成,本行已是毫秒);
/// ② 复合水位的次级列;③ 实例级身份派生。
fn read_row(row: &rusqlite::Row<'_>, source: &IngestSource) -> rusqlite::Result<SourceRow> {
    use SourceColumns as C;
    let pricing: Option<String> = row.get::<_, Option<String>>(C::IDX_PRICING_VERSION).unwrap_or(None);
    let raw_account = row.get::<_, Option<String>>(C::IDX_ACCOUNT)?.unwrap_or_default();
    let mut id_text: Vec<String> = Vec::with_capacity(source.id_columns().len().saturating_sub(1));
    for offset in 0..source.id_columns().len().saturating_sub(1) {
        id_text.push(row.get::<_, Option<String>>(C::IDX_WATERMARK_TEXT + offset)?.unwrap_or_default());
    }
    Ok(SourceRow {
        id: row.get::<_, Option<i64>>(C::IDX_ID)?.unwrap_or(0),
        id_text,
        // SQL 侧已归一成毫秒(`ts_expr`),这里不再二次换算
        ts_ms: row.get::<_, Option<i64>>(C::IDX_TS)?.unwrap_or(0),
        account_id: match &source.instance_identity {
            Some(identity) => identity.account_id_of(&raw_account),
            None => raw_account,
        },
        api_key_id: row.get::<_, Option<String>>(C::IDX_API_KEY)?.unwrap_or_default(),
        model_id: row.get::<_, Option<String>>(C::IDX_MODEL)?.unwrap_or_default(),
        input: row.get::<_, Option<i64>>(C::IDX_INPUT).unwrap_or(Some(0)).unwrap_or(0),
        output: row.get::<_, Option<i64>>(C::IDX_OUTPUT).unwrap_or(Some(0)).unwrap_or(0),
        cached: row.get::<_, Option<i64>>(C::IDX_CACHED).unwrap_or(Some(0)).unwrap_or(0),
        success: row.get::<_, Option<i64>>(C::IDX_SUCCESS).unwrap_or(Some(0)).unwrap_or(0) != 0,
        estimated_cost_usd: row
            .get::<_, Option<f64>>(C::IDX_ESTIMATED)
            .unwrap_or(Some(0.0))
            .unwrap_or(0.0),
        latency_ms: row.get::<_, Option<i64>>(C::IDX_LATENCY).unwrap_or(Some(0)).unwrap_or(0),
        error_category: row.get::<_, Option<String>>(C::IDX_ERROR_CAT).unwrap_or_default().unwrap_or_default(),
        http_status: row.get::<_, Option<i64>>(C::IDX_HTTP_STATUS).unwrap_or(None),
        model_pricing_version: pricing.filter(|s| !s.is_empty()),
        event_key: row.get::<_, Option<String>>(C::IDX_EVENT_KEY).unwrap_or_default().unwrap_or_default(),
        email: row.get::<_, Option<String>>(C::IDX_EMAIL).unwrap_or_default().unwrap_or_default(),
        official_account_id: row.get::<_, Option<String>>(C::IDX_OFFICIAL).unwrap_or_default().unwrap_or_default(),
        client_instance_id: row.get::<_, Option<String>>(C::IDX_INSTANCE).unwrap_or_default().unwrap_or_default(),
    })
}

/// 增量扫描 SQL:水位之后的一批。
///
/// - 单列水位(单请求源 `id`)⇒ `WHERE id > ?1`;
/// - 复合水位(会话源 `(timestamp, request_id)`)⇒ **行值比较**
///   `WHERE (timestamp, request_id) > (?1, ?2)`(SQLite 3.15+ 行值语法)。
///
/// 单列时不套括号是为了让 SQL 与"水位列 = 整型主键"的旧形态**逐字一致**
/// (吃得上主键索引,也避免改变既有执行计划)。
pub(crate) fn scan_batch_sql(source: &IngestSource, columns: &SourceColumns) -> String {
    let select = columns.select_sql(source);
    let order = source.id_columns().join(", ");
    let limit_param = source.id_columns().len() + 1;
    if source.id_columns().len() <= 1 {
        return format!("{select} WHERE {} > ?1 ORDER BY {order} ASC LIMIT ?{limit_param}", source.id_column());
    }
    let placeholders = (1..=source.id_columns().len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    format!("{select} WHERE ({order}) > ({placeholders}) ORDER BY {order} ASC LIMIT ?{limit_param}")
}

/// 整桶重扫 SQL:`[bucket, bucket + 1h)`。**只按时间范围过滤,不带水位条件** ——
/// 否则 3 小时窗口内迟到回填进来的行(时间戳早于当前水位)永远落不进账本。
///
/// 边界用**裸时间列**比较(单位换算见 [`IngestSource::bucket_bounds`]),
/// 这样源库的 `timestamp` 索引才吃得上;桶内的毫秒归一仍走 `SELECT` 里的 `ts_expr`。
pub(crate) fn scan_bucket_sql(source: &IngestSource, columns: &SourceColumns) -> String {
    let select = columns.select_sql(source);
    let ts = &source.ts_column;
    format!(
        "{select} WHERE {ts} >= ?1 AND {ts} < ?2 ORDER BY {} ASC",
        source.id_columns().join(", ")
    )
}

/// 扫描一批"水位 > [`Watermark`]"的源行(上限 `limit`)。
fn scan_batch(
    conn: &Connection,
    source: &IngestSource,
    columns: &SourceColumns,
    after: &Watermark,
    limit: i64,
) -> Result<Vec<SourceRow>, String> {
    let sql = scan_batch_sql(source, columns);
    let mut binds: Vec<rusqlite::types::Value> = after.binds(source.id_columns().len());
    binds.push(rusqlite::types::Value::Integer(limit.max(1)));
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("扫描源库失败: {e}"))?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(binds), |row| read_row(row, source))
        .map_err(|e| format!("扫描源库失败: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取源行失败: {e}"))?;
    Ok(rows)
}

/// 读某个桶的**全部**行(`[bucket, bucket + 1h)`),按水位升序。
///
/// 未封桶走这里做"整桶重算";已封桶也读整桶 —— 因为 `bucket_latency` 必须整桶重采样,
/// 分位数不可加(共享知识第 9 条)。
fn scan_bucket(
    conn: &Connection,
    source: &IngestSource,
    columns: &SourceColumns,
    bucket: i64,
) -> Result<Vec<SourceRow>, String> {
    let sql = scan_bucket_sql(source, columns);
    let (from, to) = source.bucket_bounds(bucket);
    let mut stmt = conn.prepare(&sql).map_err(|e| format!("扫描源库桶失败: {e}"))?;
    let rows = stmt
        .query_map(rusqlite::params![from, to], |row| read_row(row, source))
        .map_err(|e| format!("扫描源库桶失败: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取源库桶行失败: {e}"))?;
    Ok(rows)
}

// =============================================================================
// 桶级二态写入
// =============================================================================

/// 写入模式。二态的分界就是 [`is_unsealed`]。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteMode {
    /// 未封桶:整桶重算 → **覆盖**。尾部乱序/后置补写都靠它纠正。
    Replace,
    /// 已封桶:纯增量 → **累加**。cockpit 删旧行时保住我们的账。
    Add,
}

/// 桶是否未封:还没过"可能被改"的窗口。
pub fn is_unsealed(hour_bucket: i64, now_ms: i64) -> bool {
    hour_bucket + ledger_db::HOUR_MS + SEAL_LAG_MS > now_ms
}

/// 最近秩分位数(与 `cockpit_logs_db::percentile()` 同实现,保证两端口径一致)。
fn percentile_of(sorted: &[i64], pct: f64) -> Option<i64> {
    if sorted.is_empty() {
        return None;
    }
    let idx = ((sorted.len() - 1) as f64 * pct).round() as usize;
    sorted.get(idx).copied()
}

/// 源行的客户端实例 ID:源库无此列(或有但为空)时归到本机实例。
fn instance_of(row: &SourceRow, default_instance: &str) -> String {
    let raw = row.client_instance_id.trim();
    if raw.is_empty() {
        default_instance.to_string()
    } else {
        raw.to_string()
    }
}

/// 27 列(顺序即占位符 `?1..?27`;第 24 个是 `error_categories`,add 模式复用它传合并后的 JSON)。
const ROLLUP_COLUMNS: &str = "hour_bucket, source_name, source_account_id, model_id, api_key_id, \
     client_instance_id, \
     std_normal_input, std_cached, std_output, long_normal_input, long_cached, long_output, \
     requests, success, error, rate_limited, upstream_error, client_canceled, \
     estimated_cost_usd, model_pricing_version, latency_p50_ms, latency_p95_ms, latency_samples, \
     error_categories, first_ms, last_ms, updated_at_ms";

const ROLLUP_PLACEHOLDERS: &str = "?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, \
     ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27";

/// 冲突目标必须**逐列等于** v8 主键(否则 SQLite 报"没有匹配的唯一索引")。
const ROLLUP_CONFLICT_TARGET: &str =
    "hour_bucket, source_name, source_account_id, model_id, api_key_id, client_instance_id";

/// replace 模式:`error_categories` 也覆盖(整桶重算是权威值)。
const ROLLUP_REPLACE_SET: &str = "\
std_normal_input = excluded.std_normal_input, std_cached = excluded.std_cached, \
std_output = excluded.std_output, long_normal_input = excluded.long_normal_input, \
long_cached = excluded.long_cached, long_output = excluded.long_output, \
requests = excluded.requests, success = excluded.success, error = excluded.error, \
rate_limited = excluded.rate_limited, upstream_error = excluded.upstream_error, \
client_canceled = excluded.client_canceled, \
estimated_cost_usd = excluded.estimated_cost_usd, \
model_pricing_version = COALESCE(excluded.model_pricing_version, usage_rollup.model_pricing_version), \
latency_p50_ms = excluded.latency_p50_ms, latency_p95_ms = excluded.latency_p95_ms, \
latency_samples = excluded.latency_samples, error_categories = ?24, \
first_ms = excluded.first_ms, last_ms = excluded.last_ms, updated_at_ms = excluded.updated_at_ms";

/// add 模式:度量累加,**分位数一律不动**(不可加);
/// `error_categories` 由 Rust 侧"读旧 → 合并 → 写回",复用第 24 个占位符。
const ROLLUP_ADD_SET: &str = "\
std_normal_input = usage_rollup.std_normal_input + excluded.std_normal_input, \
std_cached = usage_rollup.std_cached + excluded.std_cached, \
std_output = usage_rollup.std_output + excluded.std_output, \
long_normal_input = usage_rollup.long_normal_input + excluded.long_normal_input, \
long_cached = usage_rollup.long_cached + excluded.long_cached, \
long_output = usage_rollup.long_output + excluded.long_output, \
requests = usage_rollup.requests + excluded.requests, \
success = usage_rollup.success + excluded.success, \
error = usage_rollup.error + excluded.error, \
rate_limited = usage_rollup.rate_limited + excluded.rate_limited, \
upstream_error = usage_rollup.upstream_error + excluded.upstream_error, \
client_canceled = usage_rollup.client_canceled + excluded.client_canceled, \
estimated_cost_usd = usage_rollup.estimated_cost_usd + excluded.estimated_cost_usd, \
model_pricing_version = COALESCE(excluded.model_pricing_version, usage_rollup.model_pricing_version), \
latency_p50_ms = usage_rollup.latency_p50_ms, latency_p95_ms = usage_rollup.latency_p95_ms, \
latency_samples = usage_rollup.latency_samples + excluded.latency_samples, \
error_categories = ?24, \
first_ms = MIN(COALESCE(usage_rollup.first_ms, excluded.first_ms), COALESCE(excluded.first_ms, usage_rollup.first_ms)), \
last_ms = MAX(COALESCE(usage_rollup.last_ms, excluded.last_ms), COALESCE(excluded.last_ms, usage_rollup.last_ms)), \
updated_at_ms = excluded.updated_at_ms";

/// 只增不删的 UPSERT。唯一键是 4 列(含 `valid_from_hour`),回摆邮箱时能再开新段。
const IDENTITY_UPSERT_SQL: &str = "\
INSERT INTO account_identity (
  source_account_id, client_instance_id, platform, email_norm, email_display,
  official_account_id, is_provider_test, valid_from_hour, valid_to_hour,
  first_seen_ms, last_seen_ms, first_seen_source_id, last_seen_source_id, updated_at_ms)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?10, ?11, ?12, ?13)
ON CONFLICT(source_account_id, client_instance_id, email_norm, valid_from_hour) DO UPDATE SET
  last_seen_ms        = MAX(account_identity.last_seen_ms, excluded.last_seen_ms),
  last_seen_source_id = MAX(account_identity.last_seen_source_id, excluded.last_seen_source_id),
  email_display       = COALESCE(NULLIF(excluded.email_display, ''), account_identity.email_display),
  official_account_id = COALESCE(NULLIF(excluded.official_account_id, ''), account_identity.official_account_id),
  updated_at_ms       = excluded.updated_at_ms";

/// 只放宽 `last_seen_*` 与回填空字段(不新增段)。
const IDENTITY_WIDEN_SQL: &str = "\
UPDATE account_identity SET
  last_seen_ms        = MAX(last_seen_ms, ?1),
  last_seen_source_id = MAX(last_seen_source_id, ?2),
  email_display       = COALESCE(NULLIF(?3, ''), email_display),
  official_account_id = COALESCE(NULLIF(?4, ''), official_account_id),
  updated_at_ms       = ?5
WHERE id = ?6";

const BUCKET_LATENCY_UPSERT_SQL: &str = "\
INSERT INTO bucket_latency (source_name, hour_bucket, client_instance_id, samples, p50_ms, p95_ms, updated_at_ms)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
ON CONFLICT(source_name, hour_bucket, client_instance_id) DO UPDATE SET
  samples = excluded.samples, p50_ms = excluded.p50_ms, p95_ms = excluded.p95_ms,
  updated_at_ms = excluded.updated_at_ms";

const BUCKET_STATE_UPSERT_SQL: &str = "\
INSERT INTO rollup_bucket_state (source_name, hour_bucket, client_instance_id, max_source_id, source_rows, sealed, updated_at_ms)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
ON CONFLICT(source_name, hour_bucket, client_instance_id) DO UPDATE SET
  max_source_id = MAX(rollup_bucket_state.max_source_id, excluded.max_source_id),
  source_rows   = excluded.source_rows,
  sealed        = MAX(rollup_bucket_state.sealed, excluded.sealed),
  updated_at_ms = excluded.updated_at_ms";

/// 源库重建:`max_source_id` 归零让新库的小 id 能计入,**`sealed` 绝不重置**(硬保险)。
/// 只作用于**当前源**:不加 `source_name` 谓词会把另一个源的桶水位一起清掉。
const BUCKET_STATE_RESET_SQL: &str = "\
UPDATE rollup_bucket_state SET max_source_id = 0, updated_at_ms = ?2
WHERE source_name = ?1 AND hour_bucket >= ?3 AND client_instance_id = ?4";

/// 水位按 `source_name` 分源存储(v9 起主键就是 `source_name`,不再是 `id = 1`)。
const INGEST_STATE_UPSERT_SQL: &str = "\
INSERT INTO ingest_state (source_name, client_instance_id, source_path, source_fingerprint, last_id,
  last_ts_ms, last_ingest_ms, last_batch_rows, last_duration_ms, total_rows_seen, schema_version)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
ON CONFLICT(source_name) DO UPDATE SET
  client_instance_id  = excluded.client_instance_id,
  source_path         = excluded.source_path,
  source_fingerprint  = excluded.source_fingerprint,
  last_id             = excluded.last_id,
  last_ts_ms          = excluded.last_ts_ms,
  last_ingest_ms      = excluded.last_ingest_ms,
  last_batch_rows     = excluded.last_batch_rows,
  last_duration_ms    = excluded.last_duration_ms,
  total_rows_seen     = excluded.total_rows_seen,
  schema_version      = excluded.schema_version";

/// 读水位。没有行 = 首次使用,返回默认值(全 0)。
///
/// `pub`:T03 的 `ledger_status` 要读 `last_id` / `last_ingest_ms` / 指纹,
/// 不应自己再写一份 SQL。源库重建标记用 `SourceFingerprint::parse(source_fingerprint)` 解出。
pub fn read_state(conn: &Connection, source_name: &str) -> Result<IngestState, String> {
    let mut stmt = conn
        .prepare(
            "SELECT source_name, client_instance_id, source_path, source_fingerprint, last_id, last_ts_ms,
                    last_ingest_ms, last_batch_rows, last_duration_ms, total_rows_seen, schema_version
             FROM ingest_state WHERE source_name = ?1",
        )
        .map_err(|e| format!("读取摄取水位失败: {e}"))?;
    let found = stmt
        .query_row(rusqlite::params![source_name], |row| {
            Ok(IngestState {
                source_name: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                client_instance_id: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                source_path: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                source_fingerprint: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                last_id: row.get::<_, Option<i64>>(4)?.unwrap_or(0),
                last_ts_ms: row.get::<_, Option<i64>>(5)?.unwrap_or(0),
                last_ingest_ms: row.get::<_, Option<i64>>(6)?.unwrap_or(0),
                last_batch_rows: row.get::<_, Option<i64>>(7)?.unwrap_or(0),
                last_duration_ms: row.get::<_, Option<i64>>(8)?.unwrap_or(0),
                total_rows_seen: row.get::<_, Option<i64>>(9)?.unwrap_or(0),
                schema_version: row.get::<_, Option<i64>>(10)?.unwrap_or(0).max(0) as u32,
            })
        })
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(format!("读取摄取水位失败: {other}")),
        })?;
    Ok(found.unwrap_or_default())
}

/// 写水位(与数据同一事务)。
fn write_state(tx: &Transaction<'_>, state: &IngestState) -> Result<(), String> {
    tx.execute(
        INGEST_STATE_UPSERT_SQL,
        rusqlite::params![
            state.source_name,
            state.client_instance_id,
            state.source_path,
            state.source_fingerprint,
            state.last_id,
            state.last_ts_ms,
            state.last_ingest_ms,
            state.last_batch_rows,
            state.last_duration_ms,
            state.total_rows_seen,
            state.schema_version as i64,
        ],
    )
    .map_err(|e| format!("写入摄取水位失败: {e}"))?;
    Ok(())
}

/// 读桶级水位:`(max_source_id, sealed)`。无记录 = `(0, false)`。
///
/// 按 `(source_name, hour_bucket, instance)` 查:两源水位独立(二期难点 N2)。
fn read_bucket_state(
    tx: &Transaction<'_>,
    source_name: &str,
    bucket: i64,
    instance: &str,
) -> Result<(i64, bool), String> {
    let mut stmt = tx
        .prepare(
            "SELECT max_source_id, sealed FROM rollup_bucket_state
             WHERE source_name = ?1 AND hour_bucket = ?2 AND client_instance_id = ?3",
        )
        .map_err(|e| format!("读取桶水位失败: {e}"))?;
    let found = stmt
        .query_row(rusqlite::params![source_name, bucket, instance], |row| {
            Ok((
                row.get::<_, Option<i64>>(0)?.unwrap_or(0),
                row.get::<_, Option<i64>>(1)?.unwrap_or(0) != 0,
            ))
        })
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(format!("读取桶水位失败: {other}")),
        })?;
    Ok(found.unwrap_or((0, false)))
}

/// 读既有的 `error_categories` JSON(add 模式要"读旧 → 合并 → 写回")。
fn read_error_categories(
    tx: &Transaction<'_>,
    key: &BucketKey,
) -> Result<BTreeMap<String, i64>, String> {
    let mut stmt = tx
        .prepare(
            "SELECT error_categories FROM usage_rollup
             WHERE hour_bucket = ?1 AND source_name = ?2 AND source_account_id = ?3
               AND model_id = ?4 AND api_key_id = ?5 AND client_instance_id = ?6",
        )
        .map_err(|e| format!("读取失败细分失败: {e}"))?;
    let raw: Option<String> = stmt
        .query_row(
            rusqlite::params![
                key.hour_bucket,
                key.source_name,
                key.source_account_id,
                key.model_id,
                key.api_key_id,
                key.client_instance_id
            ],
            |row| row.get::<_, Option<String>>(0),
        )
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(format!("读取失败细分失败: {other}")),
        })?;
    Ok(raw
        .as_deref()
        .and_then(|s| serde_json::from_str::<BTreeMap<String, i64>>(s).ok())
        .unwrap_or_default())
}

/// 合并失败细分分布(add 模式:旧 + 新)。
fn merge_error_categories(
    tx: &Transaction<'_>,
    key: &BucketKey,
    agg: &RollupAgg,
) -> Result<String, String> {
    let mut merged = read_error_categories(tx, key)?;
    for (name, count) in &agg.error_categories {
        *merged.entry(name.clone()).or_insert(0) += *count;
    }
    Ok(serde_json::to_string(&merged).unwrap_or_else(|_| "{}".to_string()))
}

/// UPSERT 一个 grain。分位数**只覆盖、不累加**(共享知识第 9 条)。
fn upsert_rollup(
    tx: &Transaction<'_>,
    key: &BucketKey,
    agg: &RollupAgg,
    mode: WriteMode,
    now: i64,
) -> Result<(), String> {
    let error_categories = match mode {
        WriteMode::Replace => agg.error_categories_json(),
        WriteMode::Add => merge_error_categories(tx, key, agg)?,
    };
    let sql = match mode {
        WriteMode::Replace => format!(
            "INSERT INTO usage_rollup ({ROLLUP_COLUMNS}) VALUES ({ROLLUP_PLACEHOLDERS}) \
             ON CONFLICT({ROLLUP_CONFLICT_TARGET}) \
             DO UPDATE SET {ROLLUP_REPLACE_SET}"
        ),
        WriteMode::Add => format!(
            "INSERT INTO usage_rollup ({ROLLUP_COLUMNS}) VALUES ({ROLLUP_PLACEHOLDERS}) \
             ON CONFLICT({ROLLUP_CONFLICT_TARGET}) \
             DO UPDATE SET {ROLLUP_ADD_SET}"
        ),
    };
    tx.execute(
        &sql,
        rusqlite::params![
            key.hour_bucket,
            key.source_name,
            key.source_account_id,
            key.model_id,
            key.api_key_id,
            key.client_instance_id,
            agg.split.std_normal_input,
            agg.split.std_cached,
            agg.split.std_output,
            agg.split.long_normal_input,
            agg.split.long_cached,
            agg.split.long_output,
            agg.split.requests,
            agg.split.success,
            agg.split.error,
            agg.split.rate_limited,
            agg.split.upstream_error,
            agg.split.client_canceled,
            agg.split.estimated_cost_usd,
            agg.model_pricing_version.as_deref(),
            agg.p50(),
            agg.p95(),
            agg.latency_samples.len() as i64,
            error_categories,
            agg.first_ms,
            agg.last_ms,
            now,
        ],
    )
    .map_err(|e| format!("UPSERT usage_rollup 失败: {e}"))?;
    Ok(())
}

/// 写桶级延迟(**覆盖**:分位数不可加)。按 `(source_name, hour_bucket, instance)` 分源。
fn upsert_bucket_latency(
    tx: &Transaction<'_>,
    source_name: &str,
    bucket: i64,
    instance: &str,
    samples: &[i64],
    now: i64,
) -> Result<(), String> {
    tx.execute(
        BUCKET_LATENCY_UPSERT_SQL,
        rusqlite::params![
            source_name,
            bucket,
            instance,
            samples.len() as i64,
            percentile_of(samples, 0.50),
            percentile_of(samples, 0.95),
            now,
        ],
    )
    .map_err(|e| format!("UPSERT bucket_latency 失败: {e}"))?;
    Ok(())
}

/// 写桶级水位。`sealed` 用 `MAX` 合并,**永不从 1 退回 0**(§5 硬保险)。
#[allow(clippy::too_many_arguments)] // 8 个参数逐一对应 `bucket_state` 表的列,封成结构体只是把同样的值挪个地方
fn upsert_bucket_state(
    tx: &Transaction<'_>,
    source_name: &str,
    bucket: i64,
    instance: &str,
    max_source_id: i64,
    source_rows: i64,
    sealed: bool,
    now: i64,
) -> Result<(), String> {
    tx.execute(
        BUCKET_STATE_UPSERT_SQL,
        rusqlite::params![source_name, bucket, instance, max_source_id, source_rows, sealed as i64, now],
    )
    .map_err(|e| format!("UPSERT rollup_bucket_state 失败: {e}"))?;
    Ok(())
}

/// 身份 UPSERT(只增不删)。返回是否**新增**了一段。
///
/// 判定顺序:
/// 1. 观测小时落在"同一 `(账号, 实例, 邮箱)` 已有段"内 → 只放宽 `last_seen`;
/// 2. 否则找**开段**(`valid_to_hour IS NULL`):
///    - 邮箱相同(观测早于段起点,补齐历史)→ 只放宽,不动时段;
///    - 邮箱不同且观测小时 > 段起点 → **闭合旧段** + 开新段;
///    - 观测小时 <= 段起点(乱序的旧行,属于已被取代的年代)→ 忽略;
/// 3. 没有开段 → 开新段。
fn upsert_identity(tx: &Transaction<'_>, seg: &IdentitySegment, now: i64) -> Result<bool, String> {
    let hour = seg.valid_from_hour;

    // 1) 同邮箱已有段(开或闭)覆盖该小时 → 只放宽
    let mut containing = tx
        .prepare(
            "SELECT id FROM account_identity
             WHERE source_account_id = ?1 AND client_instance_id = ?2 AND email_norm = ?3
               AND valid_from_hour <= ?4 AND (valid_to_hour IS NULL OR valid_to_hour > ?4)
             ORDER BY valid_from_hour DESC LIMIT 1",
        )
        .map_err(|e| format!("查询身份段失败: {e}"))?;
    let existing: Option<i64> = containing
        .query_row(
            rusqlite::params![
                seg.source_account_id,
                seg.client_instance_id,
                seg.email_norm,
                hour
            ],
            |row| row.get(0),
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(format!("查询身份段失败: {other}")),
        })?;
    drop(containing);

    if let Some(id) = existing {
        widen_identity(tx, id, seg, now)?;
        return Ok(false);
    }

    // 2) 找开段
    let mut open_stmt = tx
        .prepare(
            "SELECT id, email_norm, valid_from_hour FROM account_identity
             WHERE source_account_id = ?1 AND client_instance_id = ?2 AND valid_to_hour IS NULL
             ORDER BY valid_from_hour DESC LIMIT 1",
        )
        .map_err(|e| format!("查询开段失败: {e}"))?;
    let open: Option<(i64, String, i64)> = open_stmt
        .query_row(rusqlite::params![seg.source_account_id, seg.client_instance_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                row.get::<_, Option<i64>>(2)?.unwrap_or(0),
            ))
        })
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(format!("查询开段失败: {other}")),
        })?;
    drop(open_stmt);

    if let Some((id, open_email, open_from)) = open {
        if open_email == seg.email_norm || hour <= open_from {
            // 同邮箱补齐历史 / 乱序旧行:不动时段,只放宽
            widen_identity(tx, id, seg, now)?;
            return Ok(false);
        }
        // 换绑邮箱:先闭合旧段(闭合点是新段起点,不产生零长段)
        tx.execute(
            "UPDATE account_identity SET valid_to_hour = ?1, updated_at_ms = ?2 WHERE id = ?3",
            rusqlite::params![hour, now, id],
        )
        .map_err(|e| format!("闭合身份段失败: {e}"))?;
    }

    // 3) 开新段
    tx.execute(
        IDENTITY_UPSERT_SQL,
        rusqlite::params![
            seg.source_account_id,
            seg.client_instance_id,
            seg.platform,
            seg.email_norm,
            seg.email_display,
            seg.official_account_id,
            seg.is_provider_test as i64,
            hour,
            seg.first_seen_ms,
            seg.last_seen_ms,
            seg.first_seen_source_id,
            seg.last_seen_source_id,
            now,
        ],
    )
    .map_err(|e| format!("新增身份段失败: {e}"))?;
    Ok(true)
}

/// 放宽既有身份段的 `last_seen_*`,回填空字段(**绝不新增、绝不删除**)。
fn widen_identity(tx: &Transaction<'_>, id: i64, seg: &IdentitySegment, now: i64) -> Result<(), String> {
    tx.execute(
        IDENTITY_WIDEN_SQL,
        rusqlite::params![
            seg.last_seen_ms,
            seg.last_seen_source_id,
            seg.email_display,
            seg.official_account_id,
            now,
            id,
        ],
    )
    .map_err(|e| format!("放宽身份段失败: {e}"))?;
    Ok(())
}

/// 从一个桶的全部行里提取身份观测:每个 `(账号, 实例)` 一条,
/// 邮箱/上游 ID 取**该桶内最新那一行**为代表(小时粒度,与 `valid_from_hour` 对齐)。
fn identity_observations(rows: &[SourceRow], default_instance: &str) -> Vec<IdentitySegment> {
    let mut map: BTreeMap<(String, String), IdentitySegment> = BTreeMap::new();
    for row in rows {
        let instance = instance_of(row, default_instance);
        let key = (row.account_id.clone(), instance.clone());
        let email = row.email.trim().to_string();
        let email_norm = IdentitySegment::email_norm_of(&email);
        let hour = row.hour_bucket();

        let entry = map.entry(key).or_insert_with(|| IdentitySegment {
            source_account_id: row.account_id.clone(),
            client_instance_id: instance.clone(),
            platform: IdentitySegment::platform_of(&row.account_id),
            email_norm: email_norm.clone(),
            email_display: email.clone(),
            official_account_id: row.official_account_id.trim().to_string(),
            is_provider_test: IdentitySegment::is_provider_test_of(&row.account_id),
            valid_from_hour: hour,
            valid_to_hour: None,
            first_seen_ms: row.ts_ms,
            last_seen_ms: row.ts_ms,
            first_seen_source_id: row.id,
            last_seen_source_id: row.id,
        });

        // 最新一行 = 该账号在本桶的当前身份(时间相同则取 id 大者)
        let newer = row.ts_ms > entry.last_seen_ms
            || (row.ts_ms == entry.last_seen_ms && row.id >= entry.last_seen_source_id);
        if newer {
            entry.email_norm = email_norm;
            entry.email_display = email;
            entry.last_seen_ms = row.ts_ms;
            entry.last_seen_source_id = row.id;
        }
        if row.ts_ms < entry.first_seen_ms {
            entry.first_seen_ms = row.ts_ms;
            entry.first_seen_source_id = row.id;
        }
        // 上游 official_account_id 覆盖率仅 30.4%:只回填非空值,不用空值覆盖已知值
        let official = row.official_account_id.trim();
        if !official.is_empty() {
            entry.official_account_id = official.to_string();
        }
        entry.valid_from_hour = ledger_db::hour_bucket(entry.first_seen_ms);
    }
    map.into_values().collect()
}

/// 处理一个桶(二态写入)。返回本次 UPSERT 的桶数(0 或 1)。
#[allow(clippy::too_many_arguments)]
fn ingest_bucket(
    tx: &Transaction<'_>,
    src: &Connection,
    source: &IngestSource,
    columns: &SourceColumns,
    bucket: i64,
    now: i64,
    default_instance: &str,
) -> Result<i64, String> {
    let (bucket_max_source_id, bucket_sealed) =
        read_bucket_state(tx, &source.source_name, bucket, default_instance)?;
    let unsealed = is_unsealed(bucket, now);
    let rows = scan_bucket(src, source, columns, bucket)?;

    // 分位数:整桶重采样(与 add/replace 无关),一律覆盖写
    let mut samples: Vec<i64> = rows.iter().filter(|r| r.latency_ms > 0).map(|r| r.latency_ms).collect();
    samples.sort_unstable();

    // 已封桶只取增量(水位 > 桶水位);未封桶整桶重算。`sealed` 字段是硬保险:
    // 即使源库指纹变化也**只累加、永不覆盖**(§5.4)。
    //
    // 复合水位下比较的只是**数值首列**(`timestamp` 秒):次级列是文本,
    // `rollup_bucket_state.max_source_id` 是 INTEGER 存不下。含义是"该桶已计入到
    // 哪个秒为止",同一秒内后到的行(水位元组更大但首列相同)在已封桶里不再补记 ——
    // 这是本设计唯一已知的量差窗口,宽度 = 1 秒,且只在"迟到回填落进已封桶"时触发。
    // 反向(改成 `<`)会让每次重叠重扫都把边界行重复累加,那是**翻倍**,比漏记严重得多。
    let take_increment_only = bucket_sealed || !unsealed;
    let mode = if take_increment_only { WriteMode::Add } else { WriteMode::Replace };

    let mut aggs: BTreeMap<BucketKey, RollupAgg> = BTreeMap::new();
    let mut max_source_id_in_bucket = bucket_max_source_id;
    for row in &rows {
        max_source_id_in_bucket = max_source_id_in_bucket.max(row.id);
        if take_increment_only && row.id <= bucket_max_source_id {
            continue;
        }
        let key = BucketKey {
            hour_bucket: bucket,
            source_name: source.source_name.clone(),
            source_account_id: row.account_id.clone(),
            model_id: row.model_id.clone(),
            api_key_id: row.api_key_id.clone(),
            client_instance_id: instance_of(row, default_instance),
        };
        aggs.entry(key).or_default().add(row);
    }

    for (key, agg) in &aggs {
        upsert_rollup(tx, key, agg, mode, now)?;
    }

    upsert_bucket_latency(tx, &source.source_name, bucket, default_instance, &samples, now)?;
    upsert_bucket_state(
        tx,
        &source.source_name,
        bucket,
        default_instance,
        max_source_id_in_bucket,
        rows.len() as i64,
        // 未封桶 → 0;已封桶 → 1。MAX 合并保证永不回退
        !unsealed,
        now,
    )?;

    // 身份只增不删:整桶观测(不因 add/replace 而少记)
    for seg in identity_observations(&rows, default_instance) {
        upsert_identity(tx, &seg, now)?;
    }

    Ok(if aggs.is_empty() { 0 } else { 1 })
}

// =============================================================================
// 摄取主流程
// =============================================================================

/// 打开账本并摄取**单个**源(`opts.source` 未指定时用默认源 codex 单请求用量库)。
///
/// 生产路径**不走这里** —— 前端 `invoke('ledger_ingest')` 与后台定时线程都走
/// [`ingest_all_guarded`](多源 + 整轮持锁)。本函数与 [`ingest_guarded`] 是
/// "只摄一个源"的便捷入口,当前只被单测使用(单源场景更好断言),故收敛进测试构建。
#[cfg(test)]
pub fn ingest(opts: &IngestOptions) -> Result<IngestResult, String> {
    let started = ledger_db::now_ms();
    let source = match &opts.source {
        Some(source) => source.clone(),
        None => IngestSource::codex_logs()?,
    };
    let ledger_path = ledger_db::ledger_db_path().map_err(|e| e.to_string())?;
    let mut conn = ledger_db::open(&ledger_path).map_err(|e| e.to_string())?;
    ingest_into(&mut conn, &source, opts, started)
}

/// 摄取并处理并发:已有摄取在跑 → 直接让路(`ok:true, skipped:true`)。
///
/// 见 [`ingest`] 的说明:仅测试构建存在。
#[cfg(test)]
pub fn ingest_guarded(opts: &IngestOptions) -> Result<IngestResult, String> {
    match INGEST_LOCK.try_lock() {
        Ok(_guard) => ingest(opts),
        Err(_) => Ok(IngestResult::skipped()),
    }
}

/// 打开账本并**顺序摄取全部已知源**(codex_logs → codex_sessions)。
///
/// 设计要点:
/// - **账本连接只开一次**,逐源各起一个事务;一个源失败不影响后续源(逐源 `Err` 记录);
/// - `opts.source` 为 `Some` 时退化成"只摄这一个源",便于单测与排障;
/// - 顺序固定,便于把 `IngestAllResult.sources` 与 UI 行一一对上。
pub fn ingest_all(opts: &IngestOptions) -> Result<IngestAllResult, String> {
    let started = ledger_db::now_ms();
    let sources = match &opts.source {
        Some(s) => vec![Ok(s.clone())],
        None => IngestSource::all_known(),
    };
    let ledger_path = ledger_db::ledger_db_path().map_err(|e| e.to_string())?;
    let mut conn = ledger_db::open(&ledger_path).map_err(|e| e.to_string())?;

    let mut outcomes = Vec::with_capacity(sources.len());
    for candidate in sources {
        match candidate {
            Ok(source) => {
                let t0 = ledger_db::now_ms();
                match ingest_into(&mut conn, &source, opts, t0) {
                    Ok(r) => outcomes.push(SourceIngestOutcome::of(&source, r)),
                    Err(e) => outcomes.push(SourceIngestOutcome::failed(&source, e)),
                }
            }
            Err(e) => outcomes.push(SourceIngestOutcome::unlocated(e)),
        }
    }
    Ok(IngestAllResult::of(outcomes, started))
}

/// 多源摄取 + 并发让路:**整轮**只持一次锁,避免两轮互相穿插导致同一源重复扫。
pub fn ingest_all_guarded(opts: &IngestOptions) -> Result<IngestAllResult, String> {
    match INGEST_LOCK.try_lock() {
        Ok(_guard) => ingest_all(opts),
        Err(_) => Ok(IngestAllResult::skipped_all()),
    }
}

/// 后台定时摄取守护线程(2026-09-12 补)。
///
/// ## 为什么必须有它
/// 账本存在的意义是「**cockpit 删了,我这儿还有**」。但此前摄取**只在前端每次加载时
/// 触发一次**(`CostCenterView.vue` 的 `ledgerIngestOnce`),程序连续运行时新增数据
/// 根本不入库;一旦 cockpit 在这个窗口内轮转或清理旧行,那些还没被摄取的数据就
/// **永久丢失**了 —— 兜底形同虚设。
///
/// ## 设计约束
/// - 走 [`ingest_all_guarded`]:整轮只持一次 `INGEST_LOCK`,与前端触发/手工触发
///   互不穿插;抢不到锁就本轮跳过(返回 `skipped_all`),**绝不阻塞、绝不重复扫**。
/// - **增量**:按 `ingest_state.last_id` 水位只扫新行,稳态开销极小(实测二次摄取
///   只扫 200 行 / 7 桶),不需要为省事调大间隔。
/// - 失败**只记日志不 panic**:源库临时不可用(B5)下一轮自动重试。
/// - 首次等待**一个完整间隔**再跑,避免与启动时的前端首次摄取抢锁。
pub fn spawn_periodic_ingest(interval: std::time::Duration) {
    // ⚠️ 起线程失败**绝不能让主程序起不来** —— 定时摄取是增强,不是启动前置条件。
    // 起不来只是回到"只在前端加载时摄一次"的旧行为,不该拖垮整个桌面端。
    let spawned = std::thread::Builder::new()
        .name("ledger-periodic-ingest".to_string())
        .spawn(move || loop {
            std::thread::sleep(interval);
            match ingest_all_guarded(&IngestOptions::default()) {
                Ok(r) => {
                    let skipped = r.sources.iter().any(|s| s.skipped);
                    if skipped {
                        // 已有摄取在跑,本轮让路 —— 正常,不刷日志噪音
                        continue;
                    }
                    if r.ok {
                        // 顺利路径保持单行紧凑(每 5 分钟一行,不该刷屏)
                        eprintln!(
                            "[ledger] 定时摄取: 扫 {} 行 / 写桶 {} / 耗时 {}ms",
                            r.total_scanned_rows, r.total_upserted_buckets, r.duration_ms
                        );
                    } else {
                        // 出问题才铺开逐源明细 —— 由 `describe_all` 单点渲染。
                        // 此前这里手抄了一份残缺版(只打 `source_name` + 原因,
                        // 丢了扫描行数与水位),与 `describe_all` 必然分叉,故改用后者。
                        // 同时把**所有**源都列出来(不只失败的),便于一眼看出"谁进谁没进"。
                        eprintln!("[ledger] 定时摄取有问题:\n{}", describe_all(&r));
                    }
                }
                Err(e) => eprintln!("[ledger] 定时摄取失败: {e}"),
            }
        });
    if let Err(e) = spawned {
        eprintln!("[ledger] 定时摄取线程启动失败，退回「仅前端加载时摄取一次」的旧行为: {e}");
    }
}

/// 摄取主流程(可注入账本连接与源,单测直接调它)。
///
/// 步骤对应架构文档 §3.2:列探测 → 重建判定 → 分批扫描 → 桶级二态写入 →
/// 身份 UPSERT → 延迟覆盖 → 同事务写水位 → COMMIT。
pub fn ingest_into(
    conn: &mut Connection,
    source: &IngestSource,
    opts: &IngestOptions,
    started_ms: i64,
) -> Result<IngestResult, String> {
    let now = opts.now_ms.unwrap_or_else(ledger_db::now_ms);
    let instance = opts.client_instance_id.clone();

    // ── 1. 源库可用性:不可用不是 Err(B5) ──
    if !source.db_path.exists() {
        return Ok(IngestResult::source_unavailable(format!(
            "{} 不存在: {}（旧版 cockpit 未落库,回退快照口径）",
            source.label,
            source.db_path.display()
        )));
    }
    let src = open_source_readonly(&source.db_path)?;
    if !source_table_exists(&src, &source.table)? {
        return Ok(IngestResult::source_unavailable(format!(
            "{} 缺少 {} 表（cockpit 版本不兼容）",
            source.label, source.table
        )));
    }
    let columns = match &source.columns {
        Some(columns) => columns.clone(),
        None => SourceColumns::probe(&src, &source.table)?,
    };
    let missing = source
        .id_columns()
        .iter()
        .chain(std::iter::once(&source.ts_column))
        .find(|column| !columns.has(column));
    if let Some(column) = missing {
        return Ok(IngestResult::source_unavailable(format!(
            "{} 缺少 {} 列（cockpit 版本不兼容）",
            source.label, column
        )));
    }

    let facts = read_source_facts(&src, source, &columns)?;
    let mut state = read_state(conn, &source.source_name)?;
    let recorded = SourceFingerprint::parse(&state.source_fingerprint);

    // ── 2. 重建判定 ──
    //   MAX(id) < last_id            → 库被重建/回退(id 从 1 重来)
    //   MIN(id) == 1 && 指纹变化      → 库是全新的
    let computed = SourceFingerprint {
        generation: recorded.generation,
        reset_detected: false,
        min_id: facts.min_id,
        first_event_key: facts.first_event_key.clone(),
    };
    let has_history = state.last_id > 0 || !state.source_fingerprint.is_empty();
    let fingerprint_changed =
        has_history && recorded.signature() != computed.signature();
    let mut rescan = opts.full_rescan;
    let mut reset_detected = false;
    let mut generation = recorded.generation;
    if has_history && (facts.max_id < state.last_id || (facts.min_id == 1 && fingerprint_changed)) {
        rescan = true;
        reset_detected = true;
        generation = recorded.generation + 1;
    }

    let mut result = IngestResult {
        source_available: true,
        rescan_triggered: rescan,
        fingerprint_changed,
        source_reset_detected: reset_detected,
        source_generation: generation,
        ..IngestResult::default()
    };

    state.source_name = source.source_name.clone();
    state.client_instance_id = instance.clone();
    state.source_path = source.db_path.to_string_lossy().to_string();
    state.schema_version = ledger_db::SCHEMA_VERSION_LATEST;
    state.source_fingerprint = SourceFingerprint {
        generation,
        reset_detected,
        min_id: facts.min_id,
        first_event_key: facts.first_event_key.clone(),
    }
    .encode();

    let mut tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| format!("开启账本事务失败: {e}"))?;

    // ── 3. 源库重建:新库时间范围内的桶水位归零,`sealed` 保持原值 ──
    if reset_detected {
        let threshold = ledger_db::hour_bucket(facts.min_ts_ms);
        tx.execute(
            BUCKET_STATE_RESET_SQL,
            rusqlite::params![source.source_name, now, threshold, instance],
        )
        .map_err(|e| format!("重置桶水位失败: {e}"))?;
    }

    // ── 4. 空源库:只记"我来看过",不动任何账 ──
    if facts.row_count == 0 {
        state.last_ingest_ms = now;
        state.last_batch_rows = 0;
        state.last_duration_ms = (ledger_db::now_ms() - started_ms).max(0);
        write_state(&tx, &state)?;
        tx.commit().map_err(|e| format!("提交事务失败: {e}"))?;
        result.duration_ms = (ledger_db::now_ms() - started_ms).max(0);
        result.last_id = state.last_id;
        return Ok(result);
    }

    // ── 5. 分批扫描 + 桶级二态写入 ──
    let overlap = source.overlap_for(opts.overlap_rows);
    let mut cursor =
        if rescan { Watermark::default() } else { Watermark::at((state.last_id - overlap).max(0)) };
    let mut processed: BTreeSet<i64> = BTreeSet::new();

    loop {
        let batch = scan_batch(&src, source, &columns, &cursor, BATCH_MAX_ROWS)?;
        if batch.is_empty() {
            break;
        }
        result.batches += 1;
        result.scanned_rows += batch.len() as i64;

        let touched: BTreeSet<i64> = batch.iter().map(|row| row.hour_bucket()).collect();
        for bucket in touched {
            if !processed.insert(bucket) {
                continue;
            }
            result.upserted_buckets += ingest_bucket(
                &tx,
                &src,
                source,
                &columns,
                bucket,
                now,
                &instance,
            )?;
        }

        // 复合水位:批内推进完整游标(含次级列),但只有**数值首列**能落账本
        cursor.advance(&batch);
        let batch_max_id = cursor.numeric;
        let batch_max_ts = batch
            .iter()
            .map(|row| row.ts_ms)
            .max()
            .unwrap_or(state.last_ts_ms);

        // 数据与水位**同一事务**提交:崩在中途不会留下"账写了、水位没动"
        state.last_id = batch_max_id;
        state.last_ts_ms = batch_max_ts;
        state.last_ingest_ms = now;
        state.last_batch_rows = batch.len() as i64;
        state.last_duration_ms = (ledger_db::now_ms() - started_ms).max(0);
        state.total_rows_seen += batch.len() as i64;
        write_state(&tx, &state)?;
        tx.commit().map_err(|e| format!("提交事务失败: {e}"))?;

        if (batch.len() as i64) < BATCH_MAX_ROWS {
            break;
        }
        tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| format!("开启账本事务失败: {e}"))?;
    }

    result.duration_ms = (ledger_db::now_ms() - started_ms).max(0);
    result.last_id = state.last_id;
    result.ok = true;
    Ok(result)
}

// =============================================================================
// Tauri 命令
// =============================================================================

/// 摄取账本。
///
/// - 唯一 `async` 命令:内部 `spawn_blocking`,**不阻塞 WebView 主线程**;
/// - 进程内 `INGEST_LOCK` 用 `try_lock`,竞争失败返 `skipped`(不排队);
/// - 源库不可用**不是** `Err`,而是 `sourceAvailable:false + reason`(B5);
/// - `Err` 只用于真正的失败(开账本失败、迁移失败、SQL 错误),文案中文可直接展示。
/// 摄取全部已知 cockpit 源(默认 codex_logs + codex_sessions)。
///
/// `source` 可选:传 [`SOURCE_CODEX_LOGS`] / [`SOURCE_CODEX_SESSIONS`] 只摄该源
/// (排障 / 单源补扫用);不传 = 全部已知源。
///
/// 为什么是**加可选参数**而不是新增一条命令:既有前端 `invoke('ledger_ingest')`
/// 不传 `source`,语义必须保持"摄全部源";新增命令则要再改一遍
/// `generate_handler!` 与前端权限清单,收益为零。
///
/// 返回**逐源**结果(不是合并后的一个数字):UI 必须能看出"哪个源没进来、为什么"。
#[tauri::command]
pub async fn ledger_ingest(
    full_rescan: Option<bool>,
    overlap_rows: Option<i64>,
    source: Option<String>,
) -> Result<IngestAllResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resolved = match resolve_source(source.as_deref()) {
            Ok(resolved) => resolved,
            // 数据源名不认识 = 该源不可用(B5):如实报,不静默退化成"摄全部源"
            Err(reason) => return Ok(IngestAllResult::of(vec![SourceIngestOutcome::unlocated(reason)], ledger_db::now_ms())),
        };
        let opts = IngestOptions {
            full_rescan: full_rescan.unwrap_or(false),
            overlap_rows: overlap_rows.filter(|n| *n >= 0).unwrap_or(OVERLAP_ROWS),
            source: resolved,
            ..IngestOptions::default()
        };
        ingest_all_guarded(&opts)
    })
    .await
    .map_err(|e| format!("摄取任务异常结束: {e}"))?
}

/// 命令入参的数据源名 → 源定位。`None` = 全部已知源(既有语义)。
fn resolve_source(name: Option<&str>) -> Result<Option<IngestSource>, String> {
    match name {
        // 不传 = 全部已知源(既有语义,不得退化成"只摄默认源")
        None => Ok(None),
        Some(ledger_db::SOURCE_CODEX_LOGS) => Ok(Some(IngestSource::codex_logs()?)),
        Some(ledger_db::SOURCE_CODEX_SESSIONS) => Ok(Some(IngestSource::codex_sessions()?)),
        Some(other) => Err(format!("未知数据源: {other}（已知: {SOURCE_NAMES}）")),
    }
}

/// 已知数据源名(错误文案用,避免调用方猜)。
const SOURCE_NAMES: &str = "codex_logs / codex_sessions";

/// 人类可读的**单源**摄取摘要。
///
/// 生产路径只有多源(`ingest_all_guarded`),所以生产摘要走 [`describe_all`];
/// 本函数当前只被单测用作"文案契约"的断言载体 —— 单测要钉住的是
/// **源库不可用时必须如实说"未执行 + 原因",绝不静默变 0**(红线 2),
/// 故收敛进测试构建,不占生产二进制。
#[cfg(test)]
pub fn describe(result: &IngestResult) -> String {
    if result.skipped {
        return "摄取跳过:已有任务在执行".to_string();
    }
    if !result.source_available {
        return format!(
            "摄取未执行:{}",
            result.reason.clone().unwrap_or_else(|| "源库不可用".to_string())
        );
    }
    format!(
        "摄取完成:扫描 {} 行 / 更新 {} 桶 / 新增身份 {} 段 / {} 批 / 耗时 {} 分钟{}",
        result.scanned_rows,
        result.upserted_buckets,
        result.new_identity_rows,
        result.batches,
        result.duration_ms / MS_PER_MINUTE,
        if result.source_reset_detected {
            format!("(检测到源库重建,世代 {})", result.source_generation)
        } else {
            String::new()
        }
    )
}

/// 人类可读的**多源**摄取摘要(逐源一行,不可用的源把原因原样带出)。
///
/// 唯一调用方是 [`spawn_periodic_ingest`] 的定时日志。放这里而不是在日志处内联拼字符串,
/// 是为了让"某个源为什么没进来"只有**一个**渲染实现 —— 此前日志处手抄了一份残缺版
/// (只打 `source_name` + 原因,丢了扫描行数与水位),两处必然分叉。
pub fn describe_all(result: &IngestAllResult) -> String {
    let mut lines = Vec::with_capacity(result.sources.len() + 1);
    for s in &result.sources {
        let name = if s.label.is_empty() {
            s.source_name.clone()
        } else {
            s.label.clone()
        };
        if s.skipped {
            lines.push(format!("{name}:跳过(已有摄取在执行)"));
        } else if !s.source_available {
            lines.push(format!(
                "{name}:未摄取 —— {}",
                s.reason.clone().unwrap_or_else(|| "源库不可用".to_string())
            ));
        } else if !s.ok {
            lines.push(format!(
                "{name}:失败 —— {}",
                s.reason.clone().unwrap_or_else(|| "未知错误".to_string())
            ));
        } else {
            lines.push(format!(
                "{name}:扫描 {} 行 / 更新 {} 桶 / 水位 {}{}",
                s.scanned_rows,
                s.upserted_buckets,
                s.last_id,
                if s.source_reset_detected {
                    format!("(源库重建,世代 {})", s.source_generation)
                } else {
                    String::new()
                }
            ));
        }
    }
    lines.join("\n")
}

// =============================================================================
// 单测
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::types::ValueRef;

    /// 固定时钟。所有用例都用它构造"已封桶 / 未封桶",避免依赖真实时间。
    const NOW: i64 = 1_700_000_000_000;

    /// 源库完整表结构(cockpit 真实库的超集)。
    const SOURCE_FULL_DDL: &str = "
        CREATE TABLE request_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_key TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            account_id TEXT NOT NULL DEFAULT '',
            email TEXT NOT NULL DEFAULT '',
            api_key_id TEXT NOT NULL DEFAULT '',
            model_id TEXT NOT NULL DEFAULT '',
            success INTEGER NOT NULL DEFAULT 0,
            error_category TEXT NOT NULL DEFAULT '',
            latency_ms INTEGER NOT NULL DEFAULT 0,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cached_tokens INTEGER NOT NULL DEFAULT 0,
            official_account_id TEXT NOT NULL DEFAULT '',
            client_instance_id TEXT NOT NULL DEFAULT '',
            http_status INTEGER,
            estimated_cost_usd REAL NOT NULL DEFAULT 0,
            model_pricing_version TEXT
        );
        CREATE INDEX idx_ts ON request_logs(timestamp);";

    /// 旧版 cockpit 的表结构:缺 email / event_key / official_account_id /
    /// client_instance_id / model_pricing_version 五列。
    const SOURCE_MINIMAL_DDL: &str = "
        CREATE TABLE request_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp INTEGER NOT NULL,
            account_id TEXT NOT NULL DEFAULT '',
            api_key_id TEXT NOT NULL DEFAULT '',
            model_id TEXT NOT NULL DEFAULT '',
            success INTEGER NOT NULL DEFAULT 0,
            error_category TEXT NOT NULL DEFAULT '',
            latency_ms INTEGER NOT NULL DEFAULT 0,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cached_tokens INTEGER NOT NULL DEFAULT 0,
            http_status INTEGER,
            estimated_cost_usd REAL NOT NULL DEFAULT 0
        );";

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "console2api-ingest-{tag}-{}-{}",
            std::process::id(),
            ledger_db::now_ms()
        ));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    /// 该小时桶的起点(负偏移 = 过去)。
    fn hour_at(delta_hours: i64) -> i64 {
        ledger_db::hour_bucket(NOW) + delta_hours * ledger_db::HOUR_MS
    }

    /// 建源库并返回路径。调用方随后用 `insert_*` 填数据。
    fn seed_source(dir: &Path, name: &str, ddl: &str) -> PathBuf {
        let path = dir.join(name);
        let conn = Connection::open(&path).expect("建源库");
        conn.execute_batch(ddl).expect("建源表");
        // 关闭写连接:摄取侧要按只读打开,先确保 WAL 已落盘
        drop(conn);
        path
    }

    fn open_source(path: &Path) -> Connection {
        Connection::open(path).expect("打开源库写入")
    }

    /// 源库定位(与 `IngestSource::sqlite` 等价,label 便于断言文案)。
    fn source_of(path: &Path) -> IngestSource {
        let mut source = IngestSource::sqlite(path, "request_logs", "id", "timestamp");
        source.label = "测试源".to_string();
        source
    }

    fn ledger_conn(dir: &Path) -> Connection {
        ledger_db::open(&ledger_db::ledger_db_path_in(dir)).expect("开账本")
    }

    /// 插一条完整源行(显式 id,便于构造"重建后 id 从 1 起"等场景)。
    #[allow(clippy::too_many_arguments)]
    fn insert_full(
        conn: &Connection,
        id: i64,
        ts: i64,
        model: &str,
        acc: &str,
        email: &str,
        key: &str,
        input: i64,
        output: i64,
        cached: i64,
        ok: bool,
        latency: i64,
        err: &str,
    ) {
        conn.execute(
            "INSERT INTO request_logs (id, event_key, timestamp, account_id, email, api_key_id, model_id,
                success, error_category, latency_ms, input_tokens, output_tokens, cached_tokens,
                http_status, estimated_cost_usd, model_pricing_version)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
            rusqlite::params![
                id,
                format!("k{id}"),
                ts,
                acc,
                email,
                key,
                model,
                ok as i64,
                err,
                latency,
                input,
                output,
                cached,
                if ok { 200 } else { 500 },
                0.25,
                "v-test",
            ],
        )
        .expect("插入源行");
    }

    /// 插一条"最小表"源行(无 email / event_key 列)。
    #[allow(clippy::too_many_arguments)] // 夹具:参数都是一次性字面量,封结构体反而更难读
    fn insert_minimal(conn: &Connection, id: i64, ts: i64, model: &str, acc: &str, key: &str, input: i64, output: i64, cached: i64, ok: bool) {
        conn.execute(
            "INSERT INTO request_logs (id, timestamp, account_id, api_key_id, model_id, success,
                error_category, latency_ms, input_tokens, output_tokens, cached_tokens, http_status, estimated_cost_usd)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
            rusqlite::params![id, ts, acc, key, model, ok as i64, "", 10, input, output, cached, 200, 0.0],
        )
        .expect("插入最小源行");
    }

    /// 把一条 SQL 的全部结果拼成可比较的字符串列表(用于"完全不变"断言)。
    fn dump(conn: &Connection, sql: &str) -> Vec<String> {
        let mut stmt = conn.prepare(sql).expect("prepare dump");
        let cols = stmt.column_count();
        let mut out = Vec::new();
        let mut rows = stmt.query([]).expect("query dump");
        while let Some(row) = rows.next().expect("迭代 dump") {
            let mut parts = Vec::with_capacity(cols);
            for i in 0..cols {
                let value = row.get_ref(i).expect("取列");
                parts.push(match value {
                    ValueRef::Null => "NULL".to_string(),
                    ValueRef::Integer(n) => n.to_string(),
                    ValueRef::Real(f) => format!("{f:.6}"),
                    ValueRef::Text(t) => String::from_utf8_lossy(t).to_string(),
                    ValueRef::Blob(b) => format!("blob[{}]", b.len()),
                });
            }
            out.push(parts.join("|"));
        }
        out
    }

    /// 账本全量快照(不含 `ingest_state`:它的 `last_duration_ms` 依赖真实时钟)。
    fn snapshot(conn: &Connection) -> String {
        let mut parts = Vec::new();
        parts.extend(dump(conn, "SELECT * FROM usage_rollup ORDER BY 1,2,3,4,5"));
        parts.extend(dump(conn, "SELECT * FROM bucket_latency ORDER BY 1,2"));
        parts.extend(dump(conn, "SELECT * FROM rollup_bucket_state ORDER BY 1,2"));
        parts.extend(dump(
            conn,
            "SELECT source_account_id, client_instance_id, platform, email_norm, first_seen_ms,
                    last_seen_ms, valid_from_hour, valid_to_hour FROM account_identity
             ORDER BY source_account_id, client_instance_id, email_norm, valid_from_hour",
        ));
        parts.join("\n")
    }

    fn scalar_i64(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |row| row.get::<_, Option<i64>>(0))
            .unwrap_or(None)
            .unwrap_or(0)
    }

    /// 6 档位 token + 各计数合计(顺序与 `TokenSplit` 一致)。
    fn rollup_totals(conn: &Connection) -> Vec<i64> {
        let cols = [
            "std_normal_input",
            "std_cached",
            "std_output",
            "long_normal_input",
            "long_cached",
            "long_output",
            "requests",
            "success",
            "error",
            "rate_limited",
            "upstream_error",
            "client_canceled",
        ];
        cols.iter()
            .map(|c| scalar_i64(conn, &format!("SELECT COALESCE(SUM({c}),0) FROM usage_rollup")))
            .collect()
    }

    fn run(conn: &mut Connection, path: &Path, opts: &IngestOptions) -> IngestResult {
        let source = opts.source.clone().unwrap_or_else(|| source_of(path));
        ingest_into(conn, &source, opts, NOW).expect("摄取应成功")
    }

    fn opts_now() -> IngestOptions {
        IngestOptions {
            now_ms: Some(NOW),
            ..IngestOptions::default()
        }
    }

    // ---------------------------------------------------------------- 幂等

    #[test]
    fn ingest_three_times_changes_nothing() {
        let dir = temp_dir("idempotent");
        let source_path = seed_source(&dir, "src.sqlite", SOURCE_FULL_DDL);
        {
            let src = open_source(&source_path);
            // 一个已封桶(-10h)+ 一个未封桶(-5 分钟)
            insert_full(&src, 1, hour_at(-10) + 1_000, "gpt-6-astra", "codex_a1", "a@x.com", "k1", 1_000, 200, 100, true, 120, "");
            insert_full(&src, 2, hour_at(-10) + 2_000, "gpt-6-astra", "codex_a1", "a@x.com", "k1", 2_000, 300, 0, false, 0, "upstream_error");
            insert_full(&src, 3, NOW - 300_000, "gpt-6-astra", "codex_a1", "a@x.com", "k1", 5_000, 400, 1_000, true, 90, "");
        }
        let mut conn = ledger_conn(&dir);
        let mut options = opts_now();
        options.source = Some(source_of(&source_path));

        let first = run(&mut conn, &source_path, &options);
        assert!(first.source_available && first.ok, "首次摄取应可用: {first:?}");
        assert_eq!(first.scanned_rows, 3, "首次应扫到 3 行");
        assert_eq!(first.batches, 1);
        assert!(scalar_i64(&conn, "SELECT COUNT(*) FROM usage_rollup") > 0);

        let after_first = snapshot(&conn);
        let totals_first = rollup_totals(&conn);

        for round in 2..=3 {
            let again = run(&mut conn, &source_path, &options);
            assert!(again.ok && again.source_available, "第 {round} 次摄取应成功");
            assert_eq!(snapshot(&conn), after_first, "第 {round} 次摄取后账本必须完全不变");
            assert_eq!(rollup_totals(&conn), totals_first, "第 {round} 次摄取后 6 档位+计数必须不变");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---------------------------------------------------------------- 重建

    #[test]
    fn source_rebuild_is_additive_and_keeps_sealed_buckets() {
        let dir = temp_dir("rebuild");
        let source_path = seed_source(&dir, "src.sqlite", SOURCE_FULL_DDL);
        {
            let src = open_source(&source_path);
            insert_full(&src, 1, hour_at(-20) + 1_000, "m1", "codex_old", "old@x.com", "k1", 1_000, 100, 0, true, 50, "");
            insert_full(&src, 2, hour_at(-20) + 2_000, "m1", "codex_old", "old@x.com", "k1", 1_000, 100, 0, true, 60, "");
            insert_full(&src, 3, hour_at(-10) + 1_000, "m1", "codex_old", "old@x.com", "k1", 1_000, 100, 0, true, 70, "");
        }
        let mut conn = ledger_conn(&dir);
        let mut options = opts_now();
        options.source = Some(source_of(&source_path));

        let before = run(&mut conn, &source_path, &options);
        assert_eq!(before.scanned_rows, 3);
        assert!(!before.rescan_triggered, "首次摄取不算重建");
        let totals_before = rollup_totals(&conn);
        assert_eq!(totals_before[6], 3, "首次 3 个请求");
        assert_eq!(totals_before[0], 3_000, "首次普通输入 3000");

        // ── 模拟 cockpit 库被重建:id 从 1 起、时间戳全新(就在刚才) ──
        std::fs::remove_file(&source_path).expect("删除旧源库");
        let rebuilt = seed_source(&dir, "src.sqlite", SOURCE_FULL_DDL);
        {
            let src = open_source(&rebuilt);
            insert_full(&src, 1, NOW - 240_000, "m1", "codex_new", "new@x.com", "k1", 4_000, 400, 0, true, 30, "");
            insert_full(&src, 2, NOW - 180_000, "m1", "codex_new", "new@x.com", "k1", 4_000, 400, 0, true, 40, "");
        }

        let after = run(&mut conn, &source_path, &options);
        assert!(after.source_reset_detected, "必须检测到源库重建");
        assert_eq!(after.source_generation, 1, "重建世代应为 1");
        assert!(after.rescan_triggered, "重建应触发全量重扫");
        assert_eq!(after.scanned_rows, 2, "重扫新库的 2 行");

        let totals_after = rollup_totals(&conn);
        assert_eq!(totals_after[6], 5, "无翻倍:3(老)+ 2(新)= 5,实际 {}", totals_after[6]);
        assert_eq!(totals_after[0], 3_000 + 8_000, "普通输入应为老 3000 + 新 8000");

        // 老账保留:老桶 -20h(1 行)+ -10h(1 行)+ 新桶(1 行)= 3 个 rollup 行
        let rollup_rows = scalar_i64(&conn, "SELECT COUNT(*) FROM usage_rollup");
        assert_eq!(rollup_rows, 3, "应为 3 个 grain 行,实际 {rollup_rows}");

        // 已封桶的 max_source_id 必须保留(不被重置),sealed 必须仍为 1
        let sealed_flags = dump(
            &conn,
            "SELECT sealed, max_source_id > 0 FROM rollup_bucket_state ORDER BY hour_bucket",
        );
        assert_eq!(sealed_flags.len(), 3, "三个桶水位");
        assert_eq!(sealed_flags[0], "1|1", "已封桶(-20h)必须 sealed=1 且水位未被清零");
        assert_eq!(sealed_flags[1], "1|1", "已封桶(-10h)必须 sealed=1 且水位未被清零");
        assert_eq!(sealed_flags[2], "0|1", "新桶(未封)sealed=0");

        // 印记里能读出重建标记与世代(T03 读状态用)
        let raw = conn
            .query_row("SELECT source_fingerprint FROM ingest_state WHERE source_name = 'codex_logs'", [], |r| {
                r.get::<_, String>(0)
            })
            .expect("读指纹");
        let parsed = SourceFingerprint::parse(&raw);
        assert!(parsed.reset_detected(), "指纹应记录 resetDetected: {raw}");
        assert_eq!(parsed.generation(), 1);
        assert_eq!(parsed.min_id(), 1);

        // 再摄取一次:不应再翻倍,也不应重复报重建
        let third = run(&mut conn, &source_path, &options);
        assert!(!third.source_reset_detected, "第二次不应再报重建");
        assert_eq!(rollup_totals(&conn), totals_after, "重复摄取不应改变合计");
        let _ = std::fs::remove_dir_all(&dir);
    }
    // ------------------------------------------------------------ 长上下文档位

    #[test]
    fn long_context_tiers_match_cockpit_summarize() {
        let dir = temp_dir("tiers");
        let source_path = seed_source(&dir, "src.sqlite", SOURCE_FULL_DDL);
        {
            let src = open_source(&source_path);
            // 1) 超过阈值 → 长文本档
            insert_full(&src, 1, hour_at(-8) + 1_000, "m1", "codex_a", "a@x.com", "k1", 300_000, 1_000, 10_000, true, 5, "");
            // 2) 恰好等于阈值 → 标准档(判定是 `>`,不是 `>=`)
            insert_full(&src, 2, hour_at(-8) + 2_000, "m1", "codex_a", "a@x.com", "k1", 272_000, 500, 0, true, 6, "");
            // 3) 刚过阈值 → 长文本档
            insert_full(&src, 3, hour_at(-8) + 3_000, "m1", "codex_a", "a@x.com", "k1", 272_001, 500, 0, true, 7, "");
            // 4) cached > input → hit 收敛到 input,normal 不为负
            insert_full(&src, 4, hour_at(-8) + 4_000, "m1", "codex_a", "a@x.com", "k1", 100, 10, 500, true, 8, "");
        }
        let mut conn = ledger_conn(&dir);
        let mut options = opts_now();
        options.source = Some(source_of(&source_path));
        run(&mut conn, &source_path, &options);

        // 同一份数据走既有 cockpit 链路(TokenSplit::add)分档聚合,两边必须逐项相等
        let summary = crate::cockpit_logs_db::summarize(&source_path, None, None, 1, true).expect("summarize");
        assert!(summary.available, "源库应可用");
        let mut expected = [0i64; 12];
        for cell in &summary.cells {
            let s = &cell.split;
            expected[0] += s.std_normal_input;
            expected[1] += s.std_cached;
            expected[2] += s.std_output;
            expected[3] += s.long_normal_input;
            expected[4] += s.long_cached;
            expected[5] += s.long_output;
            expected[6] += s.requests;
            expected[7] += s.success;
            expected[8] += s.error;
            expected[9] += s.rate_limited;
            expected[10] += s.upstream_error;
            expected[11] += s.client_canceled;
        }
        assert_eq!(
            rollup_totals(&conn),
            expected.to_vec(),
            "账本分档必须与 cockpit summarize 完全一致(零漂移)"
        );

        // 定点断言:把"阈值是 > 而非 >=""cached 是 input 子集"钉死。
        // 阈值取自**唯一权威定义**(`ledger_db`),本模块不再留同名副本 ——
        // 两份定义会让"改一处忘一处"退化成静默的档位漂移。
        assert_eq!(crate::ledger_db::TIER_LONG_CONTEXT_THRESHOLD_TOKENS, 272_000);
        assert_eq!(expected[3], (300_000 - 10_000) + 272_001, "长文本普通输入");
        assert_eq!(expected[4], 10_000, "长文本缓存命中");
        assert_eq!(expected[0], 272_000, "恰好等于阈值走标准档");
        assert_eq!(expected[1], 100, "cached > input 时收敛到 input");
        assert_eq!(expected[6], 4, "4 个请求");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ------------------------------------------------------------ 后置补写

    #[test]
    fn backfilled_tokens_overwrite_unsealed_bucket() {
        let dir = temp_dir("backfill");
        let source_path = seed_source(&dir, "src.sqlite", SOURCE_FULL_DDL);
        {
            let src = open_source(&source_path);
            insert_full(&src, 1, NOW - 300_000, "m1", "codex_a", "a@x.com", "k1", 1_000, 100, 0, true, 20, "");
        }
        let mut conn = ledger_conn(&dir);
        let mut options = opts_now();
        options.source = Some(source_of(&source_path));

        run(&mut conn, &source_path, &options);
        assert_eq!(rollup_totals(&conn)[0], 1_000, "首次普通输入应为 1000");

        // cockpit 后置补写:同一行的 token 被改写
        {
            let src = open_source(&source_path);
            src.execute("UPDATE request_logs SET input_tokens = 700, output_tokens = 50 WHERE id = 1", [])
                .expect("补写");
        }

        let second = run(&mut conn, &source_path, &options);
        assert!(second.scanned_rows >= 1, "重叠窗口应重新扫到该行");
        let totals = rollup_totals(&conn);
        assert_eq!(totals[0], 700, "未封桶必须被覆盖(700),而不是累加(1700)或留旧值(1000)");
        assert_eq!(totals[2], 50, "输出 token 也应被覆盖");
        assert_eq!(totals[6], 1, "requests 必须仍是 1(覆盖,不是累加)");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ------------------------------------------------------------ 身份分段

    #[test]
    fn identity_segments_split_and_rebind() {
        let dir = temp_dir("identity");
        let source_path = seed_source(&dir, "src.sqlite", SOURCE_FULL_DDL);
        let account = "codex_acct1";
        {
            let src = open_source(&source_path);
            insert_full(&src, 1, hour_at(-2) + 1_000, "m1", account, "A@X.com", "k1", 10, 1, 0, true, 5, "");
            insert_full(&src, 2, hour_at(-1) + 1_000, "m1", account, "b@x.com", "k1", 10, 1, 0, true, 5, "");
            insert_full(&src, 3, hour_at(0) + 1_000, "m1", account, "a@x.com", "k1", 10, 1, 0, true, 5, "");
        }
        let mut conn = ledger_conn(&dir);
        let mut options = opts_now();
        options.source = Some(source_of(&source_path));
        run(&mut conn, &source_path, &options);

        let segments = dump(
            &conn,
            "SELECT email_norm, valid_from_hour, valid_to_hour, platform FROM account_identity
             ORDER BY valid_from_hour",
        );
        assert_eq!(segments.len(), 3, "A→B→A 必须是 3 段,实际 {segments:?}");
        assert_eq!(
            segments[0],
            format!("a@x.com|{}|{}|codex", hour_at(-2), hour_at(-1)),
            "首段应被闭合在换绑那一刻"
        );
        assert_eq!(
            segments[1],
            format!("b@x.com|{}|{}|codex", hour_at(-1), hour_at(0)),
            "中段应被闭合在回摆那一刻"
        );
        assert_eq!(
            segments[2],
            format!("a@x.com|{}|NULL|codex", hour_at(0)),
            "末段应仍开着(valid_to_hour = NULL)"
        );

        // 幂等:再摄取不得新增段
        run(&mut conn, &source_path, &options);
        assert_eq!(
            dump(&conn, "SELECT COUNT(*) FROM account_identity"),
            vec!["3".to_string()],
            "重复摄取不得新增身份段"
        );
        // 账号段必须仍然只增不删
        assert_eq!(scalar_i64(&conn, "SELECT COUNT(*) FROM account_identity WHERE valid_to_hour IS NULL"), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ------------------------------------------------------------ 列缺失兜底

    #[test]
    fn missing_optional_columns_fall_back_to_empty() {
        let dir = temp_dir("minimal");
        let source_path = seed_source(&dir, "src.sqlite", SOURCE_MINIMAL_DDL);
        {
            let src = open_source(&source_path);
            insert_minimal(&src, 1, hour_at(-9) + 1_000, "m1", "codex_a", "k1", 1_000, 100, 0, true);
            insert_minimal(&src, 2, hour_at(-9) + 2_000, "m1", "codex_a", "k1", 2_000, 200, 0, false);
        }

        // 列探测:五个可选列全缺,核心列在
        {
            let src = open_source(&source_path);
            let columns = SourceColumns::probe(&src, "request_logs").expect("探测列");
            assert!(!columns.has_email);
            assert!(!columns.has_event_key);
            assert!(!columns.has_official_account_id);
            assert!(!columns.has_client_instance_id);
            assert!(!columns.has_model_pricing_version);
            assert!(columns.has_http_status, "http_status 应存在");
            assert!(columns.has("id") && columns.has("timestamp"), "核心列应在");
        }

        let mut conn = ledger_conn(&dir);
        let mut options = opts_now();
        options.source = Some(source_of(&source_path));
        let res = run(&mut conn, &source_path, &options);
        assert!(res.ok && res.source_available, "缺列不应报错,而是兜底: {res:?}");
        assert_eq!(res.scanned_rows, 2, "仍应扫到 2 行");

        let totals = rollup_totals(&conn);
        assert_eq!(totals[0], 3_000, "token 仍应正确入账");
        assert_eq!(totals[6], 2, "请求数 2");
        assert_eq!(totals[8], 1, "1 个失败应入账");

        let emails = dump(&conn, "SELECT email_norm FROM account_identity");
        assert_eq!(emails, vec![String::new()], "email 缺失应兜底为空串,实际 {emails:?}");

        let raw = conn
            .query_row("SELECT source_fingerprint FROM ingest_state WHERE source_name = 'codex_logs'", [], |r| {
                r.get::<_, String>(0)
            })
            .expect("读指纹");
        assert_eq!(SourceFingerprint::parse(&raw).first_event_key(), "", "event_key 缺失应兜底为空串");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ------------------------------------------------------------ 分批

    #[test]
    fn sixty_thousand_rows_commit_in_two_batches() {
        let dir = temp_dir("batch");
        let source_path = seed_source(&dir, "src.sqlite", SOURCE_FULL_DDL);
        {
            let src = open_source(&source_path);
            src.execute_batch("BEGIN").expect("开事务");
            let mut id = 0i64;
            for offset in 0..4i64 {
                let ts = hour_at(-100 + offset) + 1_000;
                for _ in 0..15_000 {
                    id += 1;
                    insert_full(&src, id, ts, "m1", "codex_big", "big@x.com", "k1", 1, 1, 0, true, 5, "");
                }
            }
            src.execute_batch("COMMIT").expect("提交");
        }

        let mut conn = ledger_conn(&dir);
        let mut options = opts_now();
        options.source = Some(source_of(&source_path));

        let res = run(&mut conn, &source_path, &options);
        assert_eq!(res.scanned_rows, 60_000, "应扫到 6 万行");
        assert_eq!(res.batches, 2, "6 万行 / 每批 {} ⇒ 2 批,实际 {}", BATCH_MAX_ROWS, res.batches);
        assert_eq!(res.last_id, 60_000, "水位应推进到 6 万");
        assert_eq!(
            scalar_i64(&conn, "SELECT last_id FROM ingest_state WHERE source_name = 'codex_logs'"),
            60_000,
            "ingest_state 应记录最后的 id"
        );
        assert_eq!(rollup_totals(&conn)[6], 60_000, "请求数应恰好 6 万(不重不漏)");
        assert_eq!(
            scalar_i64(&conn, "SELECT COUNT(*) FROM usage_rollup"),
            4,
            "4 个桶各 1 个 grain"
        );

        // 再摄取:重叠窗口的部分已是已封桶且水位到位 ⇒ 合计不变
        let again = run(&mut conn, &source_path, &options);
        assert_eq!(again.batches, 1, "增量扫描只应 1 批");
        assert_eq!(again.scanned_rows, OVERLAP_ROWS, "只应重扫重叠窗口 {OVERLAP_ROWS} 行");
        assert_eq!(rollup_totals(&conn)[6], 60_000, "重复摄取不应翻倍");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ------------------------------------------------------------ 源库不可用

    #[test]
    fn unavailable_source_is_not_an_error() {
        let dir = temp_dir("unavailable");
        let mut conn = ledger_conn(&dir);

        // 1) 文件不存在
        let missing = dir.join("nope.sqlite");
        let mut options = opts_now();
        options.source = Some(source_of(&missing));
        let res = run(&mut conn, &missing, &options);
        assert!(res.ok, "源库不可用不是失败(B5)");
        assert!(!res.source_available);
        assert_eq!(res.scanned_rows, 0, "不可用时不得静默变 0 之外的任何数");
        assert!(
            res.reason.as_deref().unwrap_or("").contains("不存在"),
            "reason 应说明文件不存在: {:?}",
            res.reason
        );

        // 2) 库在但缺 request_logs 表
        let empty_path = dir.join("empty.sqlite");
        Connection::open(&empty_path)
            .expect("建空库")
            .execute_batch("CREATE TABLE other(x)")
            .expect("建无关表");
        let mut options2 = opts_now();
        options2.source = Some(source_of(&empty_path));
        let res2 = run(&mut conn, &empty_path, &options2);
        assert!(res2.ok && !res2.source_available);
        assert!(
            res2.reason.as_deref().unwrap_or("").contains("缺少"),
            "reason 应说明缺表: {:?}",
            res2.reason
        );
        // 摘要文案必须把"未执行 + 原因"如实说出来(不静默变 0)
        let text = describe(&res2);
        assert!(text.contains("摄取未执行"), "摘要应说明未执行: {text}");
        assert!(text.contains("缺少"), "摘要应带原因: {text}");
        let ok_text = describe(&IngestResult::source_unavailable("x"));
        assert!(ok_text.contains("摄取未执行"), "{ok_text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ------------------------------------------------------------ 并发让路

    #[test]
    fn concurrent_ingest_skips_instead_of_queueing() {
        let guard = INGEST_LOCK.lock().expect("持锁模拟并发");
        let res = ingest_guarded(&IngestOptions::default()).expect("让路不应报错");
        assert!(res.skipped, "抢不到锁应让路");
        assert!(res.ok, "让路不算失败");
        drop(guard);
    }

    // ------------------------------------------------------------ 指纹与封桶边界

    #[test]
    fn fingerprint_roundtrip_and_legacy_format() {
        let fp = SourceFingerprint {
            generation: 3,
            reset_detected: true,
            min_id: 7,
            first_event_key: "evt|1".to_string(),
        };
        let raw = fp.encode();
        assert_eq!(
            SourceFingerprint::parse(&raw),
            fp,
            "JSON 往返必须无损(含分隔符的 event_key): {raw}"
        );
        // 兼容架构文档写的裸格式
        let legacy = SourceFingerprint::parse("1|evt-1");
        assert_eq!(legacy.min_id(), 1);
        assert_eq!(legacy.first_event_key(), "evt-1");
        assert_eq!(legacy.generation(), 0);
        assert!(!legacy.reset_detected());
        // 空 / 垃圾输入不 panic
        assert_eq!(SourceFingerprint::parse(""), SourceFingerprint::default());
        assert_eq!(SourceFingerprint::parse("garbage").min_id(), 0);
    }

    #[test]
    fn seal_boundary_uses_epoch_hour_plus_three_hours() {
        let base = ledger_db::hour_bucket(NOW);
        assert!(is_unsealed(base, NOW), "当前小时必未封");
        assert!(is_unsealed(base - 3 * ledger_db::HOUR_MS, NOW), "-3h 仍在封桶延迟内");
        assert!(!is_unsealed(base - 4 * ledger_db::HOUR_MS, NOW), "-4h 应已封桶");
        assert!(
            !is_unsealed(base - 10 * ledger_db::HOUR_MS, NOW),
            "更早的桶必已封桶"
        );
    }

    #[test]
    fn scan_batch_reads_every_contract_column() {
        let dir = temp_dir("scan");
        let source_path = seed_source(&dir, "src.sqlite", SOURCE_FULL_DDL);
        {
            let src = open_source(&source_path);
            insert_full(&src, 1, hour_at(-7) + 3_000, "m-scan", "codex_z", "Z@Y.com", "gw-1", 111, 22, 33, false, 44, "auth_failed");
            src.execute(
                "UPDATE request_logs SET official_account_id = 'oai-9', client_instance_id = 'inst-2', http_status = 401 WHERE id = 1",
                [],
            )
            .expect("补可空列");
        }

        let src = open_source(&source_path);
        let columns = SourceColumns::probe(&src, "request_logs").expect("探测");
        assert!(columns.select_sql(&source_of(&source_path)).starts_with("SELECT "));
        let rows = scan_batch(&src, &source_of(&source_path), &columns, &Watermark::default(), 10)
            .expect("扫描");
        assert_eq!(rows.len(), 1, "应扫到 1 行");
        let row = &rows[0];
        // 下标契约(select_sql 的列顺序)必须逐列对上
        assert_eq!(row.id, 1);
        assert_eq!(row.event_key, "k1");
        assert_eq!(row.ts_ms, hour_at(-7) + 3_000);
        assert_eq!(row.account_id, "codex_z");
        assert_eq!(row.email, "Z@Y.com");
        assert_eq!(row.official_account_id, "oai-9");
        assert_eq!(row.api_key_id, "gw-1");
        assert_eq!(row.model_id, "m-scan");
        assert_eq!(row.input, 111);
        assert_eq!(row.output, 22);
        assert_eq!(row.cached, 33);
        assert!(!row.success, "success=0 应映射为 false");
        assert_eq!(row.latency_ms, 44);
        assert_eq!(row.error_category, "auth_failed");
        assert_eq!(row.http_status, Some(401));
        assert_eq!(row.model_pricing_version.as_deref(), Some("v-test"));
        assert_eq!(row.client_instance_id, "inst-2");
        assert_eq!(row.hour_bucket(), hour_at(-7), "桶必须是 epoch 小时");

        // 身份观测:新开段的 valid_to_hour 必须为空(开段)
        let segments = identity_observations(&rows, "");
        assert_eq!(segments.len(), 1);
        assert!(segments[0].valid_to_hour.is_none(), "新开段必须是开段");
        assert_eq!(segments[0].email_norm, "z@y.com", "email 归一只用 lower+trim");
        assert_eq!(segments[0].platform, "codex");
        assert_eq!(segments[0].client_instance_id, "inst-2", "源库实例 ID 优先于默认实例");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_mode_is_two_state_and_sealed_never_reopens() {
        // Replace 只在"未封桶 且 桶水位未标记 sealed"时使用
        let base = ledger_db::hour_bucket(NOW);
        assert!(!is_unsealed(base - 5 * ledger_db::HOUR_MS, NOW));
        // IdentitySegment 的邮箱归一是 lower+trim
        assert_eq!(IdentitySegment::email_norm_of("  A@X.COM "), "a@x.com");
        assert_eq!(IdentitySegment::platform_of("codex_apikey_abc"), "codex");
        assert!(IdentitySegment::is_provider_test_of("model_provider_test_1"));
        assert!(!IdentitySegment::is_provider_test_of("codex_apikey_abc"));
    }

    // ------------------------------------------------------------ 端到端(手动)

    /// 端到端:拿**本机真实的 cockpit 单请求用量库**跑一次完整摄取,写进临时账本目录。
    ///
    /// 为什么标 `#[ignore]`:
    /// - 依赖本机 `~/.antigravity_cockpit/codex_local_access_logs.sqlite` 存在(CI 上必然没有);
    /// - 首次全量扫 18 万行需要数秒,不适合每次 `cargo test` 都跑;
    /// - 它读的是**用户真实数据**(只读打开,不写源库)。
    ///
    /// 手动验证命令(这是"账本真的能跑通"的最终证据):
    /// ```bash
    /// cd src-tauri
    /// cargo test --bin console2api end_to_end_against_real_cockpit_db -- --ignored --nocapture
    /// ```
    /// 期望输出:`row_count > 0`、`upserted_buckets > 0`、连续两次摄取第二次 `scanned_rows` 大幅下降
    /// (增量水位生效)且账本行数不变(幂等)。
    #[test]
    #[ignore = "手动端到端:依赖本机真实 cockpit 数据,见文档注释"]
    fn end_to_end_against_real_cockpit_db() {
        let source = match IngestSource::codex_logs() {
            Ok(s) => s,
            Err(e) => {
                println!("跳过:无法定位源库({e})");
                return;
            }
        };
        if !source.db_path.exists() {
            println!("跳过:源库不存在 {}", source.db_path.display());
            return;
        }

        let dir = std::env::temp_dir().join(format!("ledger-e2e-{}", ledger_db::now_ms()));
        std::fs::create_dir_all(&dir).expect("建临时账本目录");
        let ledger_path = ledger_db::ledger_db_path_in(&dir);
        let mut conn = ledger_db::open(&ledger_path).expect("开账本");

        // 第一次:全量(水位从 0 起)
        let first = ingest_into(
            &mut conn,
            &source,
            &IngestOptions { now_ms: Some(NOW), ..IngestOptions::default() },
            NOW,
        )
        .expect("首次摄取应成功");
        assert!(first.ok, "摄取流程应正常结束");
        assert!(first.source_available, "真实源库应可用: {:?}", first.reason);
        assert!(first.scanned_rows > 0, "首次应扫到真实行数,实际 {}", first.scanned_rows);
        assert!(first.upserted_buckets > 0, "首次应写入桶,实际 {}", first.upserted_buckets);

        let rows_after_first: i64 = conn
            .query_row("SELECT COUNT(*) FROM usage_rollup", [], |r| r.get(0))
            .expect("数 usage_rollup");

        // 第二次:同一水位,应几乎不扫新行
        let second = ingest_into(
            &mut conn,
            &source,
            &IngestOptions { now_ms: Some(NOW), ..IngestOptions::default() },
            NOW,
        )
        .expect("二次摄取应成功");
        let rows_after_second: i64 = conn
            .query_row("SELECT COUNT(*) FROM usage_rollup", [], |r| r.get(0))
            .expect("数 usage_rollup");

        println!(
            "首次: 扫描 {} 行 / 写桶 {} / 账本 {} 行\n二次: 扫描 {} 行 / 写桶 {} / 账本 {} 行",
            first.scanned_rows, first.upserted_buckets, rows_after_first,
            second.scanned_rows, second.upserted_buckets, rows_after_second,
        );
        assert_eq!(
            rows_after_first, rows_after_second,
            "幂等:第二次摄取不得改变账本行数(增量水位生效)"
        );
        assert!(
            second.scanned_rows < first.scanned_rows,
            "增量:第二次扫描行数({})应显著小于首次({})",
            second.scanned_rows, first.scanned_rows
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ------------------------------------------------------------ 第二源(codex_sessions)

    /// cockpit 会话用量库的真实表结构(本机 2026-09-12 实测 `PRAGMA table_info`)。
    /// 注意三处与单请求库不同:**秒级 timestamp**、**`model`**、**`cached_input_tokens`**;
    /// 且**无** `account_id` / `success` / 成本 / 延迟 / 错误分类。
    const SESSION_DDL: &str = "
        CREATE TABLE session_usage_events (
            request_id TEXT PRIMARY KEY,
            instance_id TEXT NOT NULL,
            instance_name TEXT NOT NULL,
            session_id TEXT NOT NULL,
            model TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            input_tokens INTEGER NOT NULL,
            cached_input_tokens INTEGER NOT NULL,
            output_tokens INTEGER NOT NULL,
            file_path TEXT NOT NULL
        );";

    /// 会话源真实列名(本机实测 `PRAGMA table_info(session_usage_events)`)。
    ///
    /// 为什么必须单独列一份:会话库与单请求库**同名不同义** —— 这里是 `model` / `cached_input_tokens`,
    /// 那边是 `model_id` / `cached_tokens`。任何"按名字猜列"的断言若不以这份名单为准,
    /// 产出的 SELECT 就会引用真实表上不存在的列 ⇒ 摄取期直接 `no such column`,整桶静默丢失。
    const SESSION_COLUMNS: &[&str] = &[
        "request_id",
        "instance_id",
        "instance_name",
        "session_id",
        "model",
        "timestamp",
        "input_tokens",
        "cached_input_tokens",
        "output_tokens",
        "file_path",
    ];

    /// 会话源定位(表名 / 列名 / 水位 / 时间单位与真实库一致)。
    fn session_source_of(path: &Path) -> IngestSource {
        let mut source = IngestSource::sqlite(path, "session_usage_events", "timestamp", "timestamp");
        source.source_name = ledger_db::SOURCE_CODEX_SESSIONS.to_string();
        source.ts_unit = TsUnit::Seconds;
        // 复合水位:时间是主键、request_id 是次级键(**不用 rowid**)
        source.id_columns = vec!["timestamp".to_string(), "request_id".to_string()];
        source.instance_identity = Some(InstanceIdentity {
            platform: "codex".to_string(),
            column: "instance_name".to_string(),
        });
        source.success_when_column_absent = Some(true);
        source.label = "测试会话源".to_string();
        source
    }

    /// 插一条会话源行(`request_id` 是 TEXT 主键,复合水位取 `timestamp` + `request_id`)。
    #[allow(clippy::too_many_arguments)] // 夹具:参数都是一次性字面量,封结构体反而更难读
    fn insert_session(
        conn: &Connection,
        seq: i64,
        ts_secs: i64,
        model: &str,
        instance_id: &str,
        input: i64,
        cached: i64,
        output: i64,
    ) {
        conn.execute(
            "INSERT INTO session_usage_events
                (request_id, instance_id, instance_name, session_id, model, timestamp,
                 input_tokens, cached_input_tokens, output_tokens, file_path)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            rusqlite::params![
                format!("codex_session:thread-v1:sess-{seq}:{seq}"),
                instance_id,
                "默认实例",
                format!("sess-{seq}"),
                model,
                ts_secs,
                input,
                cached,
                output,
                "/home/u/.codex/sessions/rollout-x.jsonl",
            ],
        )
        .expect("插会话行");
    }

    #[test]
    fn ts_unit_seconds_normalizes_to_millis() {
        // 单点换算:这是全模块唯一的秒→毫秒语义定义
        assert_eq!(TsUnit::Millis.to_ms(1_700_000_000_000), 1_700_000_000_000);
        assert_eq!(TsUnit::Seconds.to_ms(1_700_000_000), 1_700_000_000_000);
        // SQL 表达式:毫秒源原样,秒源乘 1000(供 SELECT / MIN / WHERE 三处共用)
        assert_eq!(TsUnit::Millis.sql_expr("timestamp"), "timestamp");
        assert_eq!(TsUnit::Seconds.sql_expr("timestamp"), "(timestamp * 1000)");
        // 坏数据(13 位秒值)只饱和不 panic
        assert_eq!(TsUnit::Seconds.to_ms(i64::MAX), i64::MAX);
    }

    #[test]
    fn pick_any_takes_first_present_candidate() {
        // logs 源:两个候选都在 → 取第一个(model_id)
        let logs = SourceColumns::from_present(vec!["model_id".into(), "model".into()]);
        assert_eq!(logs.pick_any(&["model_id", "model"], "'' AS model_id"), "model_id");
        // sessions 源:只有 model → 取 model
        let sessions = SourceColumns::from_present(vec!["model".into()]);
        assert_eq!(sessions.pick_any(&["model_id", "model"], "'' AS model_id"), "model");
        // 都不在 → 兜底
        let none = SourceColumns::from_present(vec!["other".into()]);
        assert_eq!(none.pick_any(&["model_id", "model"], "'' AS model_id"), "'' AS model_id");
        // 大小写不敏感
        let upper = SourceColumns::from_present(vec!["MODEL".into()]);
        assert_eq!(upper.pick_any(&["model_id", "model"], "'' AS model_id"), "model");
    }

    /// `probe()` 的隐式 rowid 补全是**保留能力**(见 `SourceColumns::probe` 文档),
    /// 当前两源都不用它作水位,但"只有 TEXT 主键的源"将来可能要用。
    #[test]
    fn rowid_is_visible_even_though_table_info_hides_it() {
        let dir = temp_dir("rowid");
        let path = seed_source(&dir, "sess.sqlite", SESSION_DDL);
        let conn = open_source(&path);
        let columns = SourceColumns::probe(&conn, "session_usage_events").expect("探测");

        // PRAGMA table_info 不返回 rowid —— 不补的话水位列会被误判缺失
        assert!(columns.has("rowid"), "隐式 rowid 必须被视为存在");
        assert!(columns.has("_rowid_"), "_rowid_ 别名同理");
        assert!(columns.has("oid"), "oid 别名同理");
        // 真实列也照常探测到
        assert!(columns.has("model"));
        assert!(columns.has("cached_input_tokens"));
        assert!(!columns.has("model_id"), "会话表没有 model_id");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn without_rowid_table_reports_no_rowid() {
        let dir = temp_dir("norowid");
        let path = dir.join("wr.sqlite");
        let conn = Connection::open(&path).expect("建库");
        conn.execute_batch(
            "CREATE TABLE t (a TEXT PRIMARY KEY, b INTEGER) WITHOUT ROWID;",
        )
        .expect("建表");
        let columns = SourceColumns::probe(&conn, "t").expect("探测");
        assert!(!columns.has("rowid"), "WITHOUT ROWID 表没有隐式 rowid");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn codex_sessions_source_config_matches_real_schema() {
        let source = IngestSource::codex_sessions().expect("构造会话源");
        assert_eq!(source.source_name, ledger_db::SOURCE_CODEX_SESSIONS);
        assert_eq!(source.source_name, "codex_sessions");
        assert_eq!(source.table, "session_usage_events");
        // 复合水位:时间是主序、request_id 是次级键
        assert_eq!(
            source.id_columns(),
            ["timestamp", "request_id"],
            "水位必须是 (timestamp, request_id) 复合:request_id 的序号只在 session 内单调"
        );
        assert_eq!(source.id_column(), "timestamp", "首列必须能落 INTEGER 水位");
        assert_eq!(source.ts_column, "timestamp");
        assert_eq!(source.ts_unit, TsUnit::Seconds, "会话库时间戳是秒");
        assert!(
            source.id_columns().iter().all(|c| c != "rowid"),
            "绝不能用 rowid 做水位:该表没有 INTEGER PRIMARY KEY,VACUUM/重建会重排行值"
        );
        assert_eq!(
            source.instance_identity,
            Some(InstanceIdentity {
                platform: "codex".to_string(),
                column: "instance_name".to_string()
            }),
            "该源没有账号列 ⇒ 必须派生实例级身份,绝不能塌缩进未归属桶"
        );
        assert_eq!(
            source.success_when_column_absent,
            Some(true),
            "该表无 success 列且只记已完成轮次 ⇒ 不能兜底成失败"
        );
        assert!(source.db_path.to_string_lossy().ends_with("codex_session_usage.sqlite"));
        // 目录解析必须落在 cockpit 数据目录(与单请求库同目录,不重新定义常量)
        let logs = IngestSource::codex_logs().expect("构造单请求源");
        assert_eq!(
            source.db_path.parent(),
            logs.db_path.parent(),
            "会话库与单请求库必须在同一个 cockpit 数据目录下"
        );
        // 两个源的标识必须不同,否则账本 grain 会互撞
        assert_ne!(source.source_name, logs.source_name);
    }

    #[test]
    fn sessions_select_sql_remaps_columns_and_normalizes_seconds() {
        let dir = temp_dir("sesssql");
        let path = seed_source(&dir, "sess.sqlite", SESSION_DDL);
        let conn = open_source(&path);
        let columns = SourceColumns::probe(&conn, "session_usage_events").expect("探测");
        let sql = columns.select_sql(&session_source_of(&path));

        // 秒 → 毫秒:三处(SELECT / MIN / WHERE)共用同一表达式
        assert!(sql.contains("(timestamp * 1000)"), "时间列必须归一成毫秒: {sql}");
        // 列名重映射
        assert!(sql.contains("model"), "会话源用 model: {sql}");
        assert!(sql.contains("cached_input_tokens"), "会话源用 cached_input_tokens: {sql}");
        assert!(
            sql.contains("instance_name"),
            "实例级身份取 instance_name 列: {sql}"
        );
        // 复合水位的次级列必须被选出来(read_row 要读它推进游标)
        assert!(
            sql.contains(", request_id FROM session_usage_events"),
            "次级水位列 request_id 必须出现在 SELECT 末尾: {sql}"
        );
        // 纯列名形态仍要能回退(旧库缺列不让整批 SQL 挂掉)
        let fallback = SourceColumns::from_present(vec!["timestamp".into()]);
        assert!(
            fallback
                .account_sql(&IngestSource::sqlite("/tmp/x.sqlite", "t", "id", "timestamp"))
                .contains("'' AS account_id"),
            "缺列时必须回退,不能拼出坏 SQL"
        );
        assert!(!sql.contains("rowid"), "水位不得依赖 rowid: {sql}");
        // success 兜底为 1(不是 0)
        assert!(sql.contains("1 AS success"), "无 success 列时按成功计入: {sql}");
        // 无成本字段 ⇒ 兜底 0(诚实:源本身没有估算)
        assert!(sql.contains("0 AS estimated_cost_usd"), "{sql}");
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sessions_rows_land_in_own_bucket_with_seconds_normalized() {
        let dir = temp_dir("sess-ingest");
        let path = seed_source(&dir, "sess.sqlite", SESSION_DDL);
        {
            let src = open_source(&path);
            // NOW 是毫秒;会话源写秒。取 NOW 所在整点桶的起点(秒),插两条。
            let bucket_ms = ledger_db::hour_bucket(NOW);
            let base_secs = bucket_ms / 1000;
            insert_session(&src, 1, base_secs + 10, "gpt-5.6-sol", "__default__", 1_000, 200, 300);
            insert_session(&src, 2, base_secs + 20, "gpt-5.6-sol", "__default__", 2_000, 500, 600);
        }

        let mut conn = ledger_conn(&dir);
        let source = session_source_of(&path);
        let r = ingest_into(
            &mut conn,
            &source,
            &IngestOptions { now_ms: Some(NOW), ..IngestOptions::default() },
            NOW,
        )
        .expect("摄取会话源");
        assert!(r.ok && r.source_available, "会话源应可用: {:?}", r.reason);
        assert_eq!(r.scanned_rows, 2);

        // 秒被正确归一:两条都落在 NOW 所在的小时桶里
        let bucket_ms = ledger_db::hour_bucket(NOW);
        let (src_name, hour, model, acc, input, cached, output, success, error): (
            String,
            i64,
            String,
            String,
            i64,
            i64,
            i64,
            i64,
            i64,
        ) = conn
            .query_row(
                "SELECT source_name, hour_bucket, model_id, source_account_id, \
                 std_normal_input, std_cached, std_output, success, error \
                 FROM usage_rollup",
                [],
                |row| {
                    Ok((
                        row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?,
                        row.get(5)?, row.get(6)?, row.get(7)?, row.get(8)?,
                    ))
                },
            )
            .expect("读账本行");
        assert_eq!(src_name, "codex_sessions", "必须打上会话源标签");
        assert_eq!(hour, bucket_ms, "秒级时间戳必须归一到毫秒桶,否则会整体错位");
        assert_eq!(model, "gpt-5.6-sol", "model 列被正确重映射");
        assert_eq!(
            acc, "codex|inst:默认实例",
            "无账号列 ⇒ 必须是实例级身份,绝不能塌缩进未归属桶(那等于把真实用量藏起来)"
        );
        assert!(!acc.is_empty(), "空账号会让 23 万行真实用量沉进零成本桶");
        assert_eq!(
            IdentitySegment::platform_of(&acc),
            "codex",
            "实例级身份必须解析出 codex 平台(platform_of 先按 | 切)"
        );
        // input 3000, cached 700 ⇒ normal 2300;cached 命中是 input 子集
        assert_eq!(input, 2_300, "普通输入 = input - cached");
        assert_eq!(cached, 700);
        assert_eq!(output, 900);
        assert_eq!(success, 2, "无 success 列 ⇒ 按成功计入,不能报成全失败");
        assert_eq!(error, 0, "绝不允许 2 行真实用量被记成 2 次失败");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn two_sources_same_hour_and_model_do_not_collide() {
        // N1/N2 的回归测试:两源"同小时 + 同模型 + 同账号"必须各存一行,不许互相覆盖
        let dir = temp_dir("two-src");
        let logs_path = seed_source(&dir, "logs.sqlite", SOURCE_FULL_DDL);
        let sess_path = seed_source(&dir, "sess.sqlite", SESSION_DDL);
        let bucket_ms = ledger_db::hour_bucket(NOW);
        {
            let src = open_source(&logs_path);
            insert_full(
                &src, 1, bucket_ms + 1_000, "shared-model", "__default__", "", "", 100, 10, 0, true, 5, "",
            );
        }
        {
            let src = open_source(&sess_path);
            insert_session(&src, 1, bucket_ms / 1000 + 5, "shared-model", "__default__", 200, 0, 20);
        }

        let mut conn = ledger_conn(&dir);
        let opts = IngestOptions { now_ms: Some(NOW), ..IngestOptions::default() };
        ingest_into(&mut conn, &source_of(&logs_path), &opts, NOW).expect("摄 logs");
        ingest_into(&mut conn, &session_source_of(&sess_path), &opts, NOW).expect("摄 sessions");

        let mut stmt = conn
            .prepare("SELECT source_name, std_normal_input FROM usage_rollup ORDER BY source_name")
            .expect("准备查询");
        let rows: Vec<(String, i64)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .expect("查询")
            .collect::<Result<Vec<_>, _>>()
            .expect("收集");
        drop(stmt);
        assert_eq!(rows.len(), 2, "两源同桶同模型必须各占一行,实际 {rows:?}");
        assert_eq!(rows[0], ("codex_logs".to_string(), 100));
        assert_eq!(rows[1], ("codex_sessions".to_string(), 200));
        // 水位必须分源独立(N2):两源各一条 ingest_state
        let state_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM ingest_state", [], |r| r.get(0))
            .expect("数水位");
        assert_eq!(state_count, 2, "ingest_state 必须按源分表,否则水位互相污染");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// P0-14 验收②③:**摄取后聚合 token 与直接扫源库结果一致**,且**连续 3 次行数不变**。
    ///
    /// 这是"账本没算错"的硬证据 —— 只断言"行数 > 0"是没用的,
    /// 必须逐档位(标准/长文本 × 普通输入/缓存/输出)与源库直接聚合对齐。
    #[test]
    fn sessions_rollup_tokens_match_direct_source_aggregate() {
        let dir = temp_dir("sess-verify");
        let path = seed_source(&dir, "sess.sqlite", SESSION_DDL);
        let bucket_ms = ledger_db::hour_bucket(NOW);
        let base = bucket_ms / 1000;
        {
            let src = open_source(&path);
            // 覆盖:标准档 / 长文本档(>272,000) / cached > input(坏数据) / 跨两个模型
            insert_session(&src, 1, base + 10, "m-a", "__default__", 1_000, 200, 300);
            insert_session(&src, 2, base + 20, "m-a", "__default__", 5_000, 0, 700);
            insert_session(&src, 3, base + 30, "m-b", "__default__", 300_000, 50_000, 1_000);
            // cached > input:口径必须与 cockpit 一致(cached = min(cached, input))
            insert_session(&src, 4, base + 40, "m-b", "__default__", 100, 999, 5);
        }

        let mut conn = ledger_conn(&dir);
        let source = session_source_of(&path);
        let opts = IngestOptions { now_ms: Some(NOW), ..IngestOptions::default() };
        let r1 = ingest_into(&mut conn, &source, &opts, NOW).expect("第 1 次");
        assert_eq!(r1.scanned_rows, 4);

        // ── 源库直接聚合(独立于账本实现,用 SQL 自己算一遍)──
        let (s_in, s_cached, s_out, l_in, l_cached, l_out, rows): (i64, i64, i64, i64, i64, i64, i64) = {
            let src = open_source(&path);
            src.query_row(
                "SELECT
                   COALESCE(SUM(CASE WHEN input_tokens <= 272000 THEN input_tokens - MIN(cached_input_tokens, input_tokens) END), 0),
                   COALESCE(SUM(CASE WHEN input_tokens <= 272000 THEN MIN(cached_input_tokens, input_tokens) END), 0),
                   COALESCE(SUM(CASE WHEN input_tokens <= 272000 THEN output_tokens END), 0),
                   COALESCE(SUM(CASE WHEN input_tokens >  272000 THEN input_tokens - MIN(cached_input_tokens, input_tokens) END), 0),
                   COALESCE(SUM(CASE WHEN input_tokens >  272000 THEN MIN(cached_input_tokens, input_tokens) END), 0),
                   COALESCE(SUM(CASE WHEN input_tokens >  272000 THEN output_tokens END), 0),
                   COUNT(*)
                 FROM session_usage_events",
                [],
                |row| {
                    Ok((
                        row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?,
                        row.get(4)?, row.get(5)?, row.get(6)?,
                    ))
                },
            )
            .expect("直接聚合源库")
        };

        // ── 账本聚合 ──
        let (b_in, b_cached, b_out, bl_in, bl_cached, bl_out, b_req): (i64, i64, i64, i64, i64, i64, i64) =
            conn.query_row(
                "SELECT COALESCE(SUM(std_normal_input),0), COALESCE(SUM(std_cached),0), COALESCE(SUM(std_output),0),
                        COALESCE(SUM(long_normal_input),0), COALESCE(SUM(long_cached),0), COALESCE(SUM(long_output),0),
                        COALESCE(SUM(requests),0)
                 FROM usage_rollup WHERE source_name = 'codex_sessions'",
                [],
                |row| {
                    Ok((
                        row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?,
                        row.get(4)?, row.get(5)?, row.get(6)?,
                    ))
                },
            )
            .expect("聚合账本");

        assert_eq!(b_in, s_in, "标准档普通输入必须与源库一致");
        assert_eq!(b_cached, s_cached, "标准档缓存命中必须与源库一致");
        assert_eq!(b_out, s_out, "标准档输出必须与源库一致");
        assert_eq!(bl_in, l_in, "长文本档普通输入必须与源库一致");
        assert_eq!(bl_cached, l_cached, "长文本档缓存命中必须与源库一致");
        assert_eq!(bl_out, l_out, "长文本档输出必须与源库一致");
        assert_eq!(b_req, rows, "请求数必须与源库行数一致");
        // 分档确实分开了(否则上面的相等断言可能是"两边都错成一样")
        assert!(l_in > 0 && s_in > 0, "两个档位都应有数据,否则分档没被验证");

        // ── 连续 3 次:行数与 token 都不许变 ──
        let rows_after_1: i64 = conn
            .query_row("SELECT COUNT(*) FROM usage_rollup", [], |r| r.get(0))
            .expect("数行");
        ingest_into(&mut conn, &source, &opts, NOW).expect("第 2 次");
        ingest_into(&mut conn, &source, &opts, NOW).expect("第 3 次");
        let rows_after_3: i64 = conn
            .query_row("SELECT COUNT(*) FROM usage_rollup", [], |r| r.get(0))
            .expect("数行");
        let (in_after, req_after): (i64, i64) = conn
            .query_row(
                "SELECT COALESCE(SUM(std_normal_input + long_normal_input),0), COALESCE(SUM(requests),0) \
                 FROM usage_rollup WHERE source_name = 'codex_sessions'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("再聚合");
        assert_eq!(rows_after_1, rows_after_3, "连续 3 次摄取行数必须不变");
        assert_eq!(in_after, s_in + l_in, "重复摄取不得把 token 累加翻倍");
        assert_eq!(req_after, rows, "重复摄取不得把请求数翻倍");

        let _ = std::fs::remove_dir_all(&dir);
    }

    // ------------------------------------------------------------ 复合水位 / 实例级身份

    #[test]
    fn real_session_timestamps_are_seconds_and_land_in_the_right_hour_bucket() {
        // 真实库 MIN(timestamp) = 1772869375(2026-03-07 15:42:55 +0800),单位是**秒**
        assert_eq!(TsUnit::Seconds.to_ms(1_772_869_375), 1_772_869_375_000);
        assert_eq!(TsUnit::Millis.to_ms(1_772_869_375_000), 1_772_869_375_000);
        assert_eq!(TsUnit::Seconds.sql_expr("timestamp"), "(timestamp * 1000)");
        // 桶必须是 epoch 小时(UTC 对齐),不得是本地整点
        let bucket = ledger_db::hour_bucket(TsUnit::Seconds.to_ms(1_772_869_375));
        assert_eq!(bucket, 1_772_866_800_000, "秒→毫秒后必须落在正确的小时桶");
        assert_eq!(bucket % ledger_db::HOUR_MS, 0, "桶必须整除小时");
        assert_eq!(ledger_db::hour_bucket(1_772_869_375_000), bucket);
        // 反证:不归一就错位(差 4 个多小时)—— 这就是归一化必须存在的理由
        assert_ne!(bucket, ledger_db::hour_bucket(1_772_869_375));
        assert_eq!(TsUnit::Seconds.ms_per_unit(), 1_000);
        assert_eq!(TsUnit::Millis.ms_per_unit(), 1);
    }

    /// 守护 [`IngestSource::bucket_bounds`] 的单位契约。
    ///
    /// 这条是 `scan_bucket_sql` 敢用**裸列** `timestamp >= ?1` 的前提:边界必须在调用侧
    /// 换算成源列原生单位。若哪天有人把边界改回毫秒,WHERE 不会报错、索引也不会报错 ——
    /// 只是每个桶把 1000 个小时的行一起读进来,累加翻倍且慢到超时。故必须有测试钉住。
    #[test]
    fn bucket_bounds_returns_native_units_so_the_where_clause_stays_index_usable() {
        let sessions = IngestSource::codex_sessions().expect("构造会话源");
        assert_eq!(sessions.ts_unit, TsUnit::Seconds);

        // 秒源:边界必须是**秒**。给毫秒会把 3_600_000 宽的区间塞进 WHERE ⇒ 扫 1000 个桶。
        let bucket_ms = 1_772_866_800_000;
        let (from, to) = sessions.bucket_bounds(bucket_ms);
        assert_eq!(from, 1_772_866_800, "桶下界必须是秒,毫秒会让 WHERE 边界放大 1000 倍");
        assert_eq!(to, 1_772_866_800 + 3_600, "桶上界 = 下界 + 1 小时(秒)");
        assert_eq!(to - from, 3_600, "区间宽度必须是 1 小时 = 3_600 秒(毫秒则是 3_600_000)");

        // 等价性:半开区间 [from, to) 内**每个**秒值都必须落回同一个毫秒桶
        for ts in [from, from + 1, from + 1_799, from + 3_599] {
            assert_eq!(
                ledger_db::hour_bucket(TsUnit::Seconds.to_ms(ts)),
                bucket_ms,
                "秒值 {ts} 必须仍在桶 {bucket_ms} 内"
            );
        }
        // 上界**不属于**本桶(半开,否则相邻桶边界行会被两桶各累加一次)
        assert_ne!(ledger_db::hour_bucket(TsUnit::Seconds.to_ms(to)), bucket_ms);
        assert_eq!(ledger_db::hour_bucket(TsUnit::Seconds.to_ms(to - 1)), bucket_ms);

        // 毫秒源必须**原样**返回毫秒(不得被换算除掉 1000)
        let logs = source_of(Path::new("C:/x/logs.sqlite"));
        assert_eq!(logs.ts_unit, TsUnit::Millis);
        assert_eq!(logs.bucket_bounds(bucket_ms), (bucket_ms, bucket_ms + ledger_db::HOUR_MS));
    }

    #[test]
    fn composite_watermark_generates_row_value_sql() {
        let source = session_source_of(Path::new("C:/x/sess.sqlite"));
        let columns =
            SourceColumns::from_present(SESSION_COLUMNS.iter().map(|c| (*c).to_string()).collect());

        // 增量扫描:行值比较(SQLite 3.15+)
        let sql = scan_batch_sql(&source, &columns);
        assert!(
            sql.contains("WHERE (timestamp, request_id) > (?1, ?2)"),
            "复合水位必须是行值比较: {sql}"
        );
        assert!(sql.contains("ORDER BY timestamp, request_id ASC LIMIT ?3"), "{sql}");
        assert!(!sql.contains("rowid"), "水位不得依赖 rowid: {sql}");

        // 整桶重扫:**只按时间范围**,不带水位条件 ⇒ 迟到回填能落进来。
        // WHERE 必须是**裸列** `timestamp >= ?1`,不能写成 `(timestamp * 1000) >= ?1`:
        // 会话库的 `idx_session_usage_timestamp` 建在裸列上,一旦把列包进算术表达式,
        // SQLite 无法用该索引 ⇒ 4272 个桶 × 23 万行 = 十亿级全表扫描(实测分钟级→超时)。
        // 桶边界由 `IngestSource::bucket_bounds()` **预先换算成秒**再作为 ?1/?2 传入,
        // 语义与毫秒比较完全等价,只是换算从 SQL 挪到了 Rust(见 `bucket_bounds` 上的注释)。
        let bucket_sql = scan_bucket_sql(&source, &columns);
        assert!(
            bucket_sql.contains("WHERE timestamp >= ?1 AND timestamp < ?2"),
            "整桶重扫必须走裸列时间范围(否则用不上 idx_session_usage_timestamp): {bucket_sql}"
        );
        assert!(
            !bucket_sql.contains("(timestamp * 1000) >= "),
            "WHERE 里不许出现算术包列: {bucket_sql}"
        );
        // SELECT 列表里的毫秒归一化仍然保留(桶归属要靠它)
        assert!(bucket_sql.contains("(timestamp * 1000)"), "SELECT 仍需毫秒归一化: {bucket_sql}");
        assert!(!bucket_sql.contains("> (?1"), "整桶重扫不得带水位条件: {bucket_sql}");
        assert!(bucket_sql.contains("ORDER BY timestamp, request_id ASC"), "{bucket_sql}");

        // 单列水位源必须保持老形态(不套行值括号 ⇒ 执行计划与主键索引不变)
        let logs = source_of(Path::new("C:/x/logs.sqlite"));
        let logs_columns = SourceColumns::from_present(vec!["id".into(), "timestamp".into()]);
        let logs_sql = scan_batch_sql(&logs, &logs_columns);
        assert!(logs_sql.contains("WHERE id > ?1 ORDER BY id ASC LIMIT ?2"), "{logs_sql}");
        assert!(!logs_sql.contains("(id) >"), "单列水位不该换行值语法: {logs_sql}");
    }

    #[test]
    fn instance_identity_is_never_unattributed() {
        let identity = InstanceIdentity {
            platform: "codex".to_string(),
            column: "instance_name".to_string(),
        };
        let derived = identity.account_id_of("默认实例");
        assert_eq!(derived, "codex|inst:默认实例");
        assert_ne!(derived, "__unattributed__", "实例级身份绝不能塌缩进未归属桶");
        assert!(!derived.is_empty(), "空账号 = 23 万行真实用量沉进零成本桶");
        assert_eq!(IdentitySegment::platform_of(&derived), "codex");
        // 源库实例名为空(旧库缺列)也不能塌缩成空串 / 未归属
        assert_eq!(identity.account_id_of(""), "codex|inst:unknown");
        assert_ne!(identity.account_id_of(""), "");
        assert_ne!(identity.account_id_of(""), "__unattributed__");
        assert_eq!(identity.account_id_of("  默认实例  "), "codex|inst:默认实例");
        // 真实源配置必须启用它
        let source = IngestSource::codex_sessions().expect("构造会话源");
        assert!(source.instance_identity.is_some(), "会话源没有账号列 ⇒ 必须派生实例级身份");
    }

    #[test]
    fn sessions_select_sql_only_references_real_columns() {
        let dir = temp_dir("sess-cols");
        let path = seed_source(&dir, "sess.sqlite", SESSION_DDL);
        let source = session_source_of(&path);
        let present: Vec<String> = SESSION_COLUMNS.iter().map(|c| (*c).to_string()).collect();
        let columns = SourceColumns::from_present(present.clone());
        let sql = columns.select_sql(&source);

        // SQL 关键字 / 兜底别名 / 数字不算"列引用"
        let keywords = [
            "SELECT", "FROM", "AS", "NULL", "session_usage_events", "id", "ts", "account_id",
            "api_key_id", "model_id", "cached_tokens", "input_tokens", "output_tokens", "success",
            "estimated_cost_usd", "latency_ms", "error_category", "email", "event_key",
            "official_account_id", "client_instance_id", "model_pricing_version", "http_status",
        ];
        for token in sql
            .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .filter(|t| !t.is_empty())
        {
            if keywords.contains(&token) || token.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            assert!(
                present.iter().any(|c| c == token),
                "SELECT 引用了真实表上不存在的列 `{token}`: {sql}"
            );
        }

        // 同一条 SQL 必须**真能执行**(库是按真实 schema 建的)
        let conn = open_source(&path);
        let mut stmt = conn.prepare(&sql).expect("会话源 SELECT 必须可执行");
        let rows = stmt
            .query_map([], |row| row.get::<_, Option<i64>>(0))
            .expect("执行 SELECT")
            .count();
        assert_eq!(rows, 0, "空库扫 0 行,但 SQL 本身要能跑通");
        drop(stmt);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 端到端:会话源 50 行跨 3 个桶(2 个已封桶 + 1 个未封桶)。
    ///
    /// 断言三件事:**首次全进来** → **迟到回填进未封桶(整桶替换)** →
    /// **强制全量重扫后已封桶一字不动**(永不覆盖 / 不重复计数)。
    #[test]
    fn sessions_two_state_write_across_sealed_and_unsealed_buckets() {
        let dir = temp_dir("sess-two-state");
        let path = seed_source(&dir, "sess.sqlite", SESSION_DDL);
        let base = ledger_db::hour_bucket(NOW);
        let sealed_a = base - 10 * ledger_db::HOUR_MS;
        let sealed_b = base - 5 * ledger_db::HOUR_MS;
        let open_c = base - 1 * ledger_db::HOUR_MS;
        assert!(!is_unsealed(sealed_a, NOW) && !is_unsealed(sealed_b, NOW), "A/B 必须已封桶");
        assert!(is_unsealed(open_c, NOW), "C 必须未封桶");

        // 会话源写**秒**
        let (a_s, b_s, c_s) = (sealed_a / 1000, sealed_b / 1000, open_c / 1000);
        {
            let src = open_source(&path);
            for i in 0..20i64 {
                insert_session(&src, 100 + i, a_s + 10 + i, "gpt-5.6-sol", "__default__", 100, 10, 20);
                insert_session(&src, 200 + i, b_s + 10 + i, "gpt-5.6-sol", "__default__", 100, 10, 20);
            }
            // 未封桶从 +100 秒起放 10 行,给迟到回填留出更早的时间位
            for i in 0..10i64 {
                insert_session(&src, 300 + i, c_s + 100 + i, "gpt-5.6-luna", "__default__", 100, 10, 20);
            }
        }

        let mut conn = ledger_conn(&dir);
        let source = session_source_of(&path);
        let opts = IngestOptions { now_ms: Some(NOW), ..IngestOptions::default() };

        // ── 首次:50 行全进来 ──
        let first = ingest_into(&mut conn, &source, &opts, NOW).expect("首次摄取");
        assert!(first.ok && first.source_available, "{:?}", first.reason);
        assert_eq!(first.scanned_rows, 50, "首次应扫到 50 行");

        let sum_by_bucket = |conn: &Connection, bucket: i64| -> (i64, i64, i64) {
            conn.query_row(
                "SELECT COALESCE(SUM(requests),0), \
                        COALESCE(SUM(std_normal_input + long_normal_input),0), \
                        COALESCE(SUM(std_cached),0) \
                 FROM usage_rollup WHERE source_name = ?1 AND hour_bucket = ?2",
                rusqlite::params![ledger_db::SOURCE_CODEX_SESSIONS, bucket],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("读桶聚合")
        };
        // 每行 input 100 / cached 10 ⇒ 普通输入 90;20 行 = 1800
        assert_eq!(sum_by_bucket(&conn, sealed_a), (20, 1_800, 200));
        assert_eq!(sum_by_bucket(&conn, sealed_b), (20, 1_800, 200));
        assert_eq!(sum_by_bucket(&conn, open_c), (10, 900, 100));

        // ── 二次:5 行**迟到回填**(时间戳早于当前水位,仍在同一未封桶)──
        {
            let src = open_source(&path);
            for i in 0..5i64 {
                insert_session(&src, 400 + i, c_s + 50 + i, "gpt-5.6-luna", "__default__", 100, 10, 20);
            }
        }
        let second = ingest_into(&mut conn, &source, &opts, NOW).expect("二次摄取");
        assert!(second.ok, "二次摄取应正常结束");
        assert_eq!(
            sum_by_bucket(&conn, sealed_a),
            (20, 1_800, 200),
            "已封桶 A 必须一字不动"
        );
        assert_eq!(
            sum_by_bucket(&conn, sealed_b),
            (20, 1_800, 200),
            "已封桶 B 必须一字不动"
        );
        assert_eq!(
            sum_by_bucket(&conn, open_c),
            (15, 1_350, 150),
            "未封桶 C 必须整桶重算并把 5 行迟到回填算进来(不带水位条件才做得到)"
        );

        // ── 三次:强制全量重扫 —— 已封桶被重新扫到,但只累加水位之后的行 ──
        let third = ingest_into(
            &mut conn,
            &source,
            &IngestOptions { full_rescan: true, now_ms: Some(NOW), ..IngestOptions::default() },
            NOW,
        )
        .expect("全量重扫");
        assert!(third.rescan_triggered, "应触发全量重扫");
        assert!(third.scanned_rows >= 55, "全量重扫应扫到 55 行,实际 {}", third.scanned_rows);
        assert_eq!(sum_by_bucket(&conn, sealed_a), (20, 1_800, 200), "全量重扫后已封桶 A 不得翻倍");
        assert_eq!(sum_by_bucket(&conn, sealed_b), (20, 1_800, 200), "全量重扫后已封桶 B 不得翻倍");
        assert_eq!(sum_by_bucket(&conn, open_c), (15, 1_350, 150), "未封桶仍是整桶重算值");

        // ── 身份与粒度:实例级身份,session_id / file_path 绝不进 grain ──
        let accounts = dump(
            &conn,
            "SELECT DISTINCT source_account_id FROM usage_rollup WHERE source_name = 'codex_sessions'",
        );
        assert_eq!(
            accounts,
            vec!["codex|inst:默认实例".to_string()],
            "必须是实例级身份,绝不能塌缩进未归属桶"
        );
        let platforms = dump(
            &conn,
            "SELECT DISTINCT platform FROM account_identity WHERE source_account_id = 'codex|inst:默认实例'",
        );
        assert_eq!(platforms, vec!["codex".to_string()], "平台必须解析成 codex");
        let grains: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM usage_rollup WHERE source_name = 'codex_sessions'",
                [],
                |r| r.get(0),
            )
            .expect("数 grain");
        assert_eq!(grains, 3, "3 个桶 × 单一身份 ⇒ 3 行;session_id/file_path 不得炸开粒度");
        let models = dump(
            &conn,
            "SELECT DISTINCT model_id FROM usage_rollup WHERE source_name = 'codex_sessions' ORDER BY model_id",
        );
        assert_eq!(models, vec!["gpt-5.6-luna".to_string(), "gpt-5.6-sol".to_string()]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 端到端:拿**本机真实的 cockpit 会话用量库**跑一次完整摄取(与单请求源同一账本)。
    ///
    /// 手动验证命令:
    /// ```bash
    /// cd src-tauri
    /// cargo test --bin console2api end_to_end_against_real_session_db -- --ignored --nocapture
    /// ```
    /// 期望:扫到 23 万量级行、写入非 0 桶,且**第二源不覆盖第一源**。
    /// 定时摄取线程**真的能跑**:起线程 → 等它至少跑一轮 → 账本必须还是好的。
    ///
    /// 为什么要有它(2026-09-12 补):`spawn_periodic_ingest` 此前只做了编译验证,
    /// 后台线程里 `ledger_db::open()` 能不能用、日志分支会不会 panic、账本会不会被写坏
    /// 全都没验过 —— 没验过的代码不该上。
    ///
    /// 手动验证命令:
    /// ```bash
    /// cd src-tauri
    /// cargo test --bin console2api periodic_ingest_thread_actually_runs -- --ignored --nocapture
    /// ```
    /// 期望:至少完成 1 轮(打印「定时摄取」日志)、账本仍可打开、行数不减。
    #[test]
    #[ignore = "手动端到端:会真实摄取本机账本(幂等),见文档注释"]
    fn periodic_ingest_thread_actually_runs() {
        let path = match ledger_db::ledger_db_path() {
            Ok(p) => p,
            Err(e) => {
                println!("跳过:无法定位账本({e})");
                return;
            }
        };
        let before = {
            let conn = ledger_db::open(&path).expect("打开账本");
            let n: i64 = conn
                .query_row("SELECT COUNT(*) FROM usage_rollup", [], |r| r.get(0))
                .expect("数行");
            n
        };

        // 1 秒间隔:首个 sleep(1s)后跑第一轮,再等 1s 收尾,共 3s 预算足够。
        spawn_periodic_ingest(std::time::Duration::from_secs(1));
        std::thread::sleep(std::time::Duration::from_millis(3_500));

        // ⚠️ 读取必须容忍 `DatabaseBusy`:后台线程正在写时,`ledger_db::open()` 里的
        // `migrate()`(含 `CREATE TABLE IF NOT EXISTS` 等 DDL)属于**写-写冲突**,
        // SQLite 对写-写不会用 busy_timeout 排队,而是直接返 SQLITE_BUSY。
        // 这是真实场景(定时摄取途中用户打开页面),调用方必须重试,不能一撞就报错。
        let mut after = -1i64;
        for attempt in 1..=12 {
            match ledger_db::open(&path) {
                Ok(conn) => match conn.query_row("SELECT COUNT(*) FROM usage_rollup", [], |r| r.get(0)) {
                    Ok(n) => {
                        after = n;
                        break;
                    }
                    Err(_) => std::thread::sleep(std::time::Duration::from_millis(500)),
                },
                Err(_) => std::thread::sleep(std::time::Duration::from_millis(500)),
            }
            if attempt == 12 {
                panic!("定时摄取持续占用账本超过 6 秒，读取一直拿不到连接");
            }
        }
        println!("定时摄取前后账本行数: {before} -> {after}");
        assert!(after >= before, "定时摄取不得让账本丢数据: {before} -> {after}");
    }

    #[test]
    #[ignore = "手动端到端:依赖本机真实 cockpit 数据,见文档注释"]
    fn end_to_end_against_real_session_db() {
        let source = match IngestSource::codex_sessions() {
            Ok(s) => s,
            Err(e) => {
                println!("跳过:无法定位源库({e})");
                return;
            }
        };
        if !source.db_path.exists() {
            println!("跳过:源库不存在 {}", source.db_path.display());
            return;
        }

        let dir = std::env::temp_dir().join(format!("ledger-e2e-sess-{}", ledger_db::now_ms()));
        std::fs::create_dir_all(&dir).expect("建临时账本目录");
        let mut conn = ledger_db::open(&ledger_db::ledger_db_path_in(&dir)).expect("开账本");

        let first = ingest_into(
            &mut conn,
            &source,
            &IngestOptions { now_ms: Some(NOW), ..IngestOptions::default() },
            NOW,
        )
        .expect("首次摄取应成功");
        assert!(first.ok && first.source_available, "真实会话源应可用: {:?}", first.reason);
        assert!(first.scanned_rows > 100_000, "应扫到 10 万+ 真实行,实际 {}", first.scanned_rows);

        let rows_after_first: i64 = conn
            .query_row("SELECT COUNT(*) FROM usage_rollup", [], |r| r.get(0))
            .expect("数 usage_rollup");
        // 秒级时间戳若没归一,桶会全部落在 1970 附近;这里断言桶都落在合理年份
        let (min_hour, max_hour): (i64, i64) = conn
            .query_row("SELECT MIN(hour_bucket), MAX(hour_bucket) FROM usage_rollup", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .expect("读桶范围");
        // 2026-01-01 ≈ 1_767_225_600_000 ms
        assert!(min_hour > 1_767_225_600_000, "桶起点太小,秒级时间戳可能没归一: {min_hour}");
        assert!(max_hour > min_hour, "应有多个桶");

        let second = ingest_into(
            &mut conn,
            &source,
            &IngestOptions { now_ms: Some(NOW), ..IngestOptions::default() },
            NOW,
        )
        .expect("二次摄取应成功");
        let rows_after_second: i64 = conn
            .query_row("SELECT COUNT(*) FROM usage_rollup", [], |r| r.get(0))
            .expect("数 usage_rollup");

        println!(
            "会话源首次: 扫描 {} 行 / 写桶 {} / 账本 {} 行 / 桶范围 {}..{}\n会话源二次: 扫描 {} 行 / 写桶 {} / 账本 {} 行",
            first.scanned_rows, first.upserted_buckets, rows_after_first, min_hour, max_hour,
            second.scanned_rows, second.upserted_buckets, rows_after_second,
        );
        assert_eq!(rows_after_first, rows_after_second, "幂等:二次摄取不得改账本行数");
        assert!(
            second.scanned_rows < first.scanned_rows,
            "增量:二次扫描({})应远小于首次({})",
            second.scanned_rows, first.scanned_rows
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
