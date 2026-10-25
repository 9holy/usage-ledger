//! 本地持久成本账本 · SQLite 数据层
//!
//! # 这个库为什么必须存在
//!
//! cockpit 的 `request_logs` 是**滚动窗口**库(实测只留最近 43.7 天、179,002 行),
//! 且 cockpit 删号即丢数据、重新加入从 0 计数。成本账要跨月对账,不能寄存在会滚动的库里,
//! 所以本项目自己持有一份**只增不删**的持久账本。
//!
//! # 红线(本模块必须守住)
//!
//! - **只存"量"不存"钱"**:本文件不出现任何单价 / 倍率 / 金额计算。
//!   `estimated_cost_usd` / `model_pricing_version` 是 cockpit 原样搬运字段,仅供审计,
//!   **绝不参与计价**。计价唯一入口是前端 `costEngine.ts` / `cockpitPriceBook.ts`。
//! - **桶对齐**:`hour_bucket = ts_ms.div_euclid(3_600_000) * 3_600_000`(epoch 小时,UTC)。
//!   不得改成"本地时区整点"——改了就和 cockpit 自己的桶边界错位。
//! - **`account_identity` 只增不删**:本文件不出现针对该表的 DELETE。
//! - **绝不落进 cockpit 目录**(`%USERPROFILE%\.antigravity_cockpit\`):那个目录由 cockpit
//!   拥有并会自行清理,我们的账放那里等于把命交出去。
//!
//! # 连接模型
//!
//! **每次操作独立 `Connection`**,不共享 `Mutex<Connection>`。
//! 账本是低写入频率(5 分钟一次摄取)+ 多读的场景,独占锁反而是瓶颈;
//! 用 WAL + `busy_timeout=5000` 让 SQLite 自己处理并发即可。
//!
//! # 与 T02 的接口约定
//!
//! T02(摄取)只需 `open_in()` / `open_default()` 拿连接 + `hour_bucket()` 算桶,
//! 其余 DDL / 迁移由本模块 `open()` 内部自动完成,摄取侧不写建表语句。
//!
//! # schema 版本
//!
//! | 版本 | 内容 |
//! |---|---|
//! | v1–v7 | 一期 7 张表(单源) |
//! | v8–v12 | 二期多源化:`source_name` 进 `usage_rollup` / `rollup_bucket_state` / `bucket_latency` 三个 PK,`ingest_state` 主键改为 `source_name`,新增 `price_book_version` |
//! | v13 | 显式录入的本地财务事件,不从成本配置生成采购历史 |
//!
//! 建表常量(`SQL_CREATE_*`)本身写成 **v8 终态**,所以空库与 v7 老库走完
//! `MIGRATIONS` 后 `sqlite_master` 完全一致(由单测守住)。
//! `account_identity` / `identity_override` **不带** source 维度 —— 身份跨源共享。

#![allow(dead_code)] // T02/T03 尚未接入,先容忍未使用的导出项;接入后请删除本行

use rusqlite::{params, Connection, OpenFlags};
use std::fmt;
use std::path::{Path, PathBuf};

/// 复用 `cockpit_logs_db` 的既有常量,**本模块不重定义**(红线 3)。
pub use crate::cockpit_logs_db::{LONG_CONTEXT_THRESHOLD_TOKENS, REQUEST_LOG_DB_NAME};

/// 档位切分阈值:直接透传 `cockpit_logs_db::LONG_CONTEXT_THRESHOLD_TOKENS`。
///
/// T02 摄取时以 `input_tokens > TIER_LONG_CONTEXT_THRESHOLD_TOKENS` 逐请求判定,
/// 判定结果**烘焙**进 `usage_rollup` 的 6 个档位列(不可在读取时再算:
/// 分位数不可加,档位同理——聚合后再判会把长文本请求算成标准档)。
pub const TIER_LONG_CONTEXT_THRESHOLD_TOKENS: i64 = LONG_CONTEXT_THRESHOLD_TOKENS;

/// 账本文件名。刻意与 `REQUEST_LOG_DB_NAME` 不同,防止两个库互相覆盖。
pub const LEDGER_DB_FILE_NAME: &str = "cost_ledger.sqlite";

/// 一小时 = 3,600,000 ms。桶对齐与封桶判定的唯一时间单位。
pub const HOUR_MS: i64 = 3_600_000;

/// 环境变量:显式指定账本目录(运维 / 排障用)。未设置时走 Tauri `app_data_dir()`。
pub const LEDGER_DIR_ENV: &str = "CONSOLE2API_LEDGER_DIR";

/// Tauri `app_data_dir()` 在 Windows 上解析为 `%APPDATA%\<identifier>`。
/// 与 `tauri.conf.json` 的 `identifier` 保持一致。
pub const TAURI_APP_ID: &str = "com.console.2api";

/// 无 Tauri 运行时的回落目录名(与 `main.rs::console_data_dir()` 同口径)。
pub const FALLBACK_DIR_NAME: &str = "2api-console";

/// 代码已知的最新 schema 版本。必须与 `MIGRATIONS` 末项版本号一致
/// (由 `latest_constant_matches_last_migration` 单测守住)。
///
/// v1–v7 = 一期 7 张表;v8–v12 = 二期多源化(见 `docs/architecture/ledger-schema-v8.sql`)。
pub const SCHEMA_VERSION_LATEST: u32 = 15;

/// 一期唯一已知源:cockpit 单请求用量库 `codex_local_access_logs.sqlite`。
///
/// **这是 `source_name` 的唯一已支持取值之一**,业务代码禁止写字面量
/// (二期共享知识第 15 条)。老库(v7)搬迁时全部行打这个标签。
pub const SOURCE_CODEX_LOGS: &str = "codex_logs";

/// 二期第二源:cockpit 会话用量库 `codex_session_usage.sqlite`(139 MB)。
///
/// T12 接入;T11 只负责把常量与 schema 准备好。
pub const SOURCE_CODEX_SESSIONS: &str = "codex_sessions";

/// `source_name` 的默认值。与 `usage_rollup` / `bucket_latency` /
/// `rollup_bucket_state` 三张表的 `DEFAULT 'codex_logs'` 保持一致。
pub const DEFAULT_SOURCE_NAME: &str = SOURCE_CODEX_LOGS;

// -----------------------------------------------------------------------------
// DDL 常量(7 张表)
//
// 以 docs/architecture/ledger-schema.sql 为准。每张表的建表语句连同其索引
// 一并作为一条迁移,因此 DDL 常量与迁移 SQL 是**同一份文本**,不存在两份副本漂移。
// -----------------------------------------------------------------------------

/// 1. 迁移水位:一行 = 一个已应用版本。
pub const SQL_CREATE_SCHEMA_VERSION: &str = "
CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER PRIMARY KEY,          -- 单调递增,一行 = 一个已应用版本
  applied_at  INTEGER NOT NULL,             -- epoch ms
  description TEXT    NOT NULL DEFAULT ''
);
";

/// 2. 事实表:档位化小时桶聚合(v8:★ `source_name` 进 PK,放第 2 位)。
///
/// grain = (hour_bucket, **source_name**, source_account_id, model_id, api_key_id, client_instance_id)。
/// 实测基数:43.7 天 → 2,202 行;≈18,400 行/年 ≈3 MB/年。
///
/// ## 为什么 `source_name` 放第 2 位而不是第 1 位(二期 §2.1)
///
/// - 保留 `hour_bucket` 打头 → **跨源窗口扫描**继续吃 PK;
/// - 分源查询 = "hour 范围 + source 过滤" → 同样吃 PK 前缀。
///
/// 两种查询**共用一个索引**,不额外建表/建索引。
pub const SQL_CREATE_USAGE_ROLLUP: &str = "
CREATE TABLE IF NOT EXISTS usage_rollup (
  -- ── grain(6 列,全部进 PK)──
  hour_bucket          INTEGER NOT NULL,    -- epoch ms,UTC 对齐:ts.div_euclid(3_600_000)*3_600_000
  source_name          TEXT    NOT NULL DEFAULT 'codex_logs',  -- ★ codex_logs | codex_sessions
  source_account_id    TEXT    NOT NULL,    -- cockpit 原始 account_id;'' = 无账号归属
  model_id             TEXT    NOT NULL,
  api_key_id           TEXT    NOT NULL,
  client_instance_id   TEXT    NOT NULL DEFAULT '',   -- 入 grain:多机合并时不互相覆盖

  -- ── 度量:6 档位 token(摄取时逐请求判定后烘焙)──
  std_normal_input     INTEGER NOT NULL DEFAULT 0,
  std_cached           INTEGER NOT NULL DEFAULT 0,
  std_output           INTEGER NOT NULL DEFAULT 0,
  long_normal_input    INTEGER NOT NULL DEFAULT 0,
  long_cached          INTEGER NOT NULL DEFAULT 0,
  long_output          INTEGER NOT NULL DEFAULT 0,

  -- ── 度量:计数 ──
  requests             INTEGER NOT NULL DEFAULT 0,
  success              INTEGER NOT NULL DEFAULT 0,
  error                INTEGER NOT NULL DEFAULT 0,
  rate_limited         INTEGER NOT NULL DEFAULT 0,   -- quota_or_rate_limit 或 http_status=429
  upstream_error       INTEGER NOT NULL DEFAULT 0,   -- error_category=upstream_error
  client_canceled      INTEGER NOT NULL DEFAULT 0,   -- error_category=client_canceled

  -- ── 审计 / 回退(cockpit 原样值,绝不参与本项目计价)──
  estimated_cost_usd    REAL NOT NULL DEFAULT 0,
  model_pricing_version TEXT,                        -- 源库无此列时为 NULL

  -- ── 延迟(grain 行内样本的最近秩分位数;NULL = 无样本)──
  latency_p50_ms  INTEGER,
  latency_p95_ms  INTEGER,
  latency_samples INTEGER NOT NULL DEFAULT 0,        -- latency_ms > 0 的样本数

  -- ── 失败细分(三态列装不下 auth_failed 等,故存 JSON 分布)──
  error_categories TEXT NOT NULL DEFAULT '{}',       -- JSON: {\"upstream_error\":18194,...}

  -- ── 窗口端点(对账 / 展示)──
  first_ms      INTEGER,
  last_ms       INTEGER,
  updated_at_ms INTEGER NOT NULL,

  PRIMARY KEY (hour_bucket, source_name, source_account_id, model_id, api_key_id, client_instance_id)
);
-- PK 前导列 = hour_bucket,按窗口扫描直接吃 PK,不另建 hour 索引
CREATE INDEX IF NOT EXISTS ix_rollup_account ON usage_rollup(source_account_id, hour_bucket);
CREATE INDEX IF NOT EXISTS ix_rollup_model   ON usage_rollup(model_id, hour_bucket);
CREATE INDEX IF NOT EXISTS ix_rollup_key     ON usage_rollup(api_key_id, hour_bucket);
-- v8:分源查询(按 source 过滤 + hour 范围)直接吃这个索引
CREATE INDEX IF NOT EXISTS ix_rollup_source  ON usage_rollup(source_name, hour_bucket);
";

/// 3. 身份表:只增不删,**时段闭合**。
///
/// ## 修正 1(BUG-2)
///
/// `docs/architecture/ledger-schema.sql` 原稿只有
/// `ux_identity_seg(source_account_id, client_instance_id, email_norm)` 三列唯一索引,
/// **缺 `valid_from_hour` / `valid_to_hour` 两列**。换绑邮箱回摆 A→B→A 时:
/// 三列唯一键会拒掉第三段(A 的第二段),而若允许插入则读取 JOIN 会命中 A 的两段
/// → 一对多 fan-out → 度量翻倍。故本实现**以评审修正为准**,补上两列并把
/// `valid_from_hour` 纳入唯一索引。
///
/// ⚠️ 连带影响(T02 必读):唯一索引变为 4 列后,UPSERT 必须写
/// `ON CONFLICT(source_account_id, client_instance_id, email_norm, valid_from_hour)`,
/// 原稿里的三列写法会因"没有匹配的唯一索引"而直接报错。
pub const SQL_CREATE_ACCOUNT_IDENTITY: &str = "
CREATE TABLE IF NOT EXISTS account_identity (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  source_account_id    TEXT    NOT NULL,
  client_instance_id   TEXT    NOT NULL DEFAULT '',
  platform             TEXT    NOT NULL DEFAULT '',   -- account_id 前缀(见架构文档 Q1)
  email_norm           TEXT    NOT NULL DEFAULT '',   -- lower(trim(email)),归并比较用
  email_display        TEXT    NOT NULL DEFAULT '',   -- 原始大小写,仅展示
  official_account_id  TEXT    NOT NULL DEFAULT '',   -- 覆盖率仅 30.4%,只作强提示
  is_provider_test     INTEGER NOT NULL DEFAULT 0,    -- model_provider_test_* 前缀 → 隔离到测试分区
  -- ── 时段闭合(修正 BUG-2)──
  -- 同一 (账号, 邮箱) 的每一次生效各占一段;换绑邮箱回摆 A→B→A = 3 段,不合并、不改写。
  valid_from_hour      INTEGER NOT NULL,              -- 段起点(epoch 小时桶),无默认值:逼调用方显式给
  valid_to_hour        INTEGER,                       -- 段终点(不含);NULL = 该段至今有效
  first_seen_ms        INTEGER NOT NULL,
  last_seen_ms         INTEGER NOT NULL,
  first_seen_source_id INTEGER NOT NULL DEFAULT 0,    -- 分段归属的边界依据
  last_seen_source_id  INTEGER NOT NULL DEFAULT 0,
  updated_at_ms        INTEGER NOT NULL
);
-- 唯一索引**包含 valid_from_hour**:回摆后同一邮箱可以再开一段,但同一小时桶只能开一段。
CREATE UNIQUE INDEX IF NOT EXISTS ux_identity_seg
  ON account_identity(source_account_id, client_instance_id, email_norm, valid_from_hour);
CREATE INDEX IF NOT EXISTS ix_identity_email ON account_identity(email_norm);
CREATE INDEX IF NOT EXISTS ix_identity_open  ON account_identity(source_account_id, client_instance_id, valid_to_hour);
";

/// 4. 人工归并覆盖(优先级最高,高于 `account_identity` 自动归并)。
pub const SQL_CREATE_IDENTITY_OVERRIDE: &str = "
CREATE TABLE IF NOT EXISTS identity_override (
  source_account_id  TEXT    NOT NULL,
  client_instance_id TEXT    NOT NULL DEFAULT '',
  identity_key       TEXT    NOT NULL,                -- 强制归并目标
  note               TEXT    NOT NULL DEFAULT '',
  created_at_ms      INTEGER NOT NULL,
  PRIMARY KEY (source_account_id, client_instance_id)
);
";

/// 5. 桶级摄取状态:幂等的唯一依据(v10:★ `source_name` 进 PK)。
///
/// `max_source_id` = 该桶已计入的源库最大 id;
/// `sealed=0` → 整桶重扫后覆盖(replace);`sealed=1` → 只累加 id > max_source_id(add)。
///
/// ⚠️ **漏了 `source_name` 就会两源共用一个 `max_source_id`** —— session 源的 `rowid`
/// 与 logs 源的 `id` 混为一谈,幂等直接崩坏(二期难点 N2)。`sealed` 按
/// `(source_name, hour_bucket)` 判定(二期共享知识第 28 条)。
pub const SQL_CREATE_ROLLUP_BUCKET_STATE: &str = "
CREATE TABLE IF NOT EXISTS rollup_bucket_state (
  source_name        TEXT    NOT NULL DEFAULT 'codex_logs',
  hour_bucket        INTEGER NOT NULL,
  client_instance_id TEXT    NOT NULL DEFAULT '',
  max_source_id      INTEGER NOT NULL DEFAULT 0,
  source_rows        INTEGER NOT NULL DEFAULT 0,      -- 最近一次重算时桶内源行数(自检用)
  sealed             INTEGER NOT NULL DEFAULT 0,
  updated_at_ms      INTEGER NOT NULL,
  PRIMARY KEY (source_name, hour_bucket, client_instance_id)
);
";

/// 6. 整桶延迟分位数(v10:★ `source_name` 进 PK)。分位数不可加 → 只能整桶重采样后覆盖写入。
pub const SQL_CREATE_BUCKET_LATENCY: &str = "
CREATE TABLE IF NOT EXISTS bucket_latency (
  source_name        TEXT    NOT NULL DEFAULT 'codex_logs',
  hour_bucket        INTEGER NOT NULL,
  client_instance_id TEXT    NOT NULL DEFAULT '',
  samples            INTEGER NOT NULL DEFAULT 0,
  p50_ms             INTEGER,
  p95_ms             INTEGER,
  updated_at_ms      INTEGER NOT NULL,
  PRIMARY KEY (source_name, hour_bucket, client_instance_id)
);
";

/// 7. 摄取水位(v9:★ 主键由 `id INTEGER CHECK(id=1)` 改为 `source_name`)。
///
/// 两源各有独立水位,`last_id` / 指纹互不覆盖(二期验收项)。
/// 老库(v7)单行搬迁为 `source_name = 'codex_logs'`。
///
/// ## 修正 2(体积)
///
/// 水位表是**每源一行**,不是"每次摄取插一行"的审计表,
/// 因此不存在 5 分钟一次 → 年增 10 MB 的问题,**无需滚动保留逻辑**。
/// 另外两张会随时间增长的表 `rollup_bucket_state` / `bucket_latency` 是
/// "每源每桶每实例一行",上限 8,760 行/年/源/实例,同样无需裁剪。
pub const SQL_CREATE_INGEST_STATE: &str = "
CREATE TABLE IF NOT EXISTS ingest_state (
  source_name        TEXT    PRIMARY KEY,             -- ★ codex_logs | codex_sessions
  client_instance_id TEXT    NOT NULL DEFAULT '',
  source_path        TEXT    NOT NULL DEFAULT '',
  source_fingerprint TEXT    NOT NULL DEFAULT '',     -- JSON: generation/resetDetected/minId/firstEventKey
  last_id            INTEGER NOT NULL DEFAULT 0,      -- 源库 id(或 rowid)水位
  last_ts_ms         INTEGER NOT NULL DEFAULT 0,
  last_ingest_ms     INTEGER NOT NULL DEFAULT 0,
  last_batch_rows    INTEGER NOT NULL DEFAULT 0,
  last_duration_ms   INTEGER NOT NULL DEFAULT 0,
  total_rows_seen    INTEGER NOT NULL DEFAULT 0,
  schema_version     INTEGER NOT NULL DEFAULT 0
);
";

/// 8. 价目表版本历史(v11:★ 新增)。
///
/// ## 为什么它不违反"只存量不存钱"
///
/// 存的是**单价配置**,不是**计价结果**。本表只有 `INSERT` / `SELECT`,
/// Rust 侧**零乘法** —— 单价 × token 的乘法只能在前端 `cockpitSplitCostUsd()` 里发生
/// (二期共享知识第 24 条 / 红线 B1)。
///
/// `effective_from` / `effective_to` 单位是 **epoch 小时桶**(与 `hour_bucket` 同量纲),
/// 便于按 `hour_bucket` 直接 JOIN 取"当时的价目"。
pub const SQL_CREATE_PRICE_BOOK_VERSION: &str = "
CREATE TABLE IF NOT EXISTS price_book_version (
  version_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  source         TEXT    NOT NULL,          -- cockpit_builtin | cockpit_user | manual
  scope          TEXT    NOT NULL DEFAULT 'global',
  model_id       TEXT    NOT NULL,          -- 精确模型名;'' = 通配默认档
  tier           TEXT    NOT NULL DEFAULT 'standard',   -- standard | priority | flex
  effective_from INTEGER NOT NULL,          -- epoch 小时桶(含)
  effective_to   INTEGER,                   -- epoch 小时桶(不含);NULL = 至今有效
  input_usd_per_million         REAL NOT NULL,
  cached_input_usd_per_million  REAL NOT NULL,
  output_usd_per_million        REAL NOT NULL,
  session_long_context INTEGER NOT NULL DEFAULT 0,
  note           TEXT    NOT NULL DEFAULT '',
  created_at_ms  INTEGER NOT NULL
);
-- 同一 (来源, 作用域, 模型, 档位) 在同一小时只能有一个生效起点
CREATE UNIQUE INDEX IF NOT EXISTS ux_price_ver
  ON price_book_version(source, scope, model_id, tier, effective_from);
CREATE INDEX IF NOT EXISTS ix_price_lookup
  ON price_book_version(model_id, effective_from, effective_to);
";

// -----------------------------------------------------------------------------
// v8 – v12 增量迁移(二期多源化)
//
// 权威文本: docs/architecture/ledger-schema-v8.sql
//
// 幂等性四重保证:
//   ① migrate() 以 max(user_version, MAX(schema_version.version)) 为判据,已 apply 的整段跳过;
//   ② 每条迁移**首行** `DROP TABLE IF EXISTS <临时表>` 自愈残留(上一次跑到一半崩了的情况);
//   ③ 数据搬迁一律 `INSERT OR IGNORE`,重跑不翻倍;
//   ④ 全部在**单事务**内执行,失败整体回滚。
//
// 注意:迁移 1–7 的 DDL 常量已经写成 v8 终态,所以**空库**会先建 v8 表再被
// v8–v10 重建一次(空表上跑,零成本);**老库**(v7)只跑 v8–v12。
// 两条路径的终点 sqlite_master 完全一致(由 `fresh_and_migrated_schema_are_identical` 守住)。
// -----------------------------------------------------------------------------

/// v8:`usage_rollup` 加 `source_name`(PK 第 2 位)。老行全部打 `codex_logs` 标签。
pub const SQL_MIGRATE_V8_USAGE_ROLLUP: &str = "
DROP TABLE IF EXISTS usage_rollup_v8;
CREATE TABLE usage_rollup_v8 (
  hour_bucket          INTEGER NOT NULL,
  source_name          TEXT    NOT NULL DEFAULT 'codex_logs',
  source_account_id    TEXT    NOT NULL,
  model_id             TEXT    NOT NULL,
  api_key_id           TEXT    NOT NULL,
  client_instance_id   TEXT    NOT NULL DEFAULT '',
  std_normal_input     INTEGER NOT NULL DEFAULT 0,
  std_cached           INTEGER NOT NULL DEFAULT 0,
  std_output           INTEGER NOT NULL DEFAULT 0,
  long_normal_input    INTEGER NOT NULL DEFAULT 0,
  long_cached          INTEGER NOT NULL DEFAULT 0,
  long_output          INTEGER NOT NULL DEFAULT 0,
  requests             INTEGER NOT NULL DEFAULT 0,
  success              INTEGER NOT NULL DEFAULT 0,
  error                INTEGER NOT NULL DEFAULT 0,
  rate_limited         INTEGER NOT NULL DEFAULT 0,
  upstream_error       INTEGER NOT NULL DEFAULT 0,
  client_canceled      INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd   REAL NOT NULL DEFAULT 0,
  model_pricing_version TEXT,
  latency_p50_ms  INTEGER,
  latency_p95_ms  INTEGER,
  latency_samples INTEGER NOT NULL DEFAULT 0,
  error_categories TEXT NOT NULL DEFAULT '{}',
  first_ms      INTEGER,
  last_ms       INTEGER,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (hour_bucket, source_name, source_account_id, model_id, api_key_id, client_instance_id)
);

-- 老数据原样搬迁(零丢失):6 档位 token / 计数 / estimated_cost_usd /
-- latency_* / error_categories / first_ms / last_ms / updated_at_ms 一字不改。
INSERT OR IGNORE INTO usage_rollup_v8 (
  hour_bucket, source_name, source_account_id, model_id, api_key_id, client_instance_id,
  std_normal_input, std_cached, std_output, long_normal_input, long_cached, long_output,
  requests, success, error, rate_limited, upstream_error, client_canceled,
  estimated_cost_usd, model_pricing_version,
  latency_p50_ms, latency_p95_ms, latency_samples, error_categories,
  first_ms, last_ms, updated_at_ms
) SELECT
  hour_bucket, 'codex_logs', source_account_id, model_id, api_key_id, client_instance_id,
  std_normal_input, std_cached, std_output, long_normal_input, long_cached, long_output,
  requests, success, error, rate_limited, upstream_error, client_canceled,
  estimated_cost_usd, model_pricing_version,
  latency_p50_ms, latency_p95_ms, latency_samples, error_categories,
  first_ms, last_ms, updated_at_ms
FROM usage_rollup;

DROP TABLE usage_rollup;
ALTER TABLE usage_rollup_v8 RENAME TO usage_rollup;

-- ⚠️ 索引必须在 DROP 老表**之后**重建(踩过的坑):
-- 若提前在临时表 usage_rollup_v8 上用 IF NOT EXISTS 建索引,空库路径下这 4 个
-- 索引名已经挂在老 usage_rollup 上 ⇒ 整句被『已存在』跳过 ⇒ 临时表上没有索引,
-- 紧接着 DROP TABLE usage_rollup 又把老表的索引一起删掉 ⇒ 4 个索引永久丢失,
-- 且空库与老库的终态不一致。放在 DROP 之后,名字必然空闲,重建才真正发生。
CREATE INDEX IF NOT EXISTS ix_rollup_account ON usage_rollup(source_account_id, hour_bucket);
CREATE INDEX IF NOT EXISTS ix_rollup_model   ON usage_rollup(model_id, hour_bucket);
CREATE INDEX IF NOT EXISTS ix_rollup_key     ON usage_rollup(api_key_id, hour_bucket);
CREATE INDEX IF NOT EXISTS ix_rollup_source  ON usage_rollup(source_name, hour_bucket);
";

/// v9:`ingest_state` 单行表(`id=1`)→ 按 `source_name` 为主键。老水位打 `codex_logs` 标签。
pub const SQL_MIGRATE_V9_INGEST_STATE: &str = "
DROP TABLE IF EXISTS ingest_state_v9;
CREATE TABLE ingest_state_v9 (
  source_name        TEXT    PRIMARY KEY,
  client_instance_id TEXT    NOT NULL DEFAULT '',
  source_path        TEXT    NOT NULL DEFAULT '',
  source_fingerprint TEXT    NOT NULL DEFAULT '',
  last_id            INTEGER NOT NULL DEFAULT 0,
  last_ts_ms         INTEGER NOT NULL DEFAULT 0,
  last_ingest_ms     INTEGER NOT NULL DEFAULT 0,
  last_batch_rows    INTEGER NOT NULL DEFAULT 0,
  last_duration_ms   INTEGER NOT NULL DEFAULT 0,
  total_rows_seen    INTEGER NOT NULL DEFAULT 0,
  schema_version     INTEGER NOT NULL DEFAULT 0
);

-- 空库时 ingest_state 无行 ⇒ 本语句搬 0 行,不会凭空造出一条空水位
INSERT OR IGNORE INTO ingest_state_v9 (
  source_name, client_instance_id, source_path, source_fingerprint,
  last_id, last_ts_ms, last_ingest_ms, last_batch_rows, last_duration_ms,
  total_rows_seen, schema_version
) SELECT
  'codex_logs', client_instance_id, source_path, source_fingerprint,
  last_id, last_ts_ms, last_ingest_ms, last_batch_rows, last_duration_ms,
  total_rows_seen, schema_version
FROM ingest_state;

DROP TABLE ingest_state;
ALTER TABLE ingest_state_v9 RENAME TO ingest_state;
";

/// v10:桶状态 + 整桶延迟 加 `source_name`(两张一起重建)。
///
/// 这两张表是**幂等的唯一依据**与**延迟真相**,漏了 source 就会出现
/// "两源共用一个 `max_source_id`"(幂等崩坏)或"两源延迟互相覆盖"。
pub const SQL_MIGRATE_V10_BUCKETS: &str = "
DROP TABLE IF EXISTS rollup_bucket_state_v10;
CREATE TABLE rollup_bucket_state_v10 (
  source_name        TEXT    NOT NULL DEFAULT 'codex_logs',
  hour_bucket        INTEGER NOT NULL,
  client_instance_id TEXT    NOT NULL DEFAULT '',
  max_source_id      INTEGER NOT NULL DEFAULT 0,
  source_rows        INTEGER NOT NULL DEFAULT 0,
  sealed             INTEGER NOT NULL DEFAULT 0,
  updated_at_ms      INTEGER NOT NULL,
  PRIMARY KEY (source_name, hour_bucket, client_instance_id)
);
-- sealed 原样搬迁:已封桶永不覆盖是硬保险,迁移也不许把它重置
INSERT OR IGNORE INTO rollup_bucket_state_v10 (
  source_name, hour_bucket, client_instance_id, max_source_id, source_rows, sealed, updated_at_ms
) SELECT
  'codex_logs', hour_bucket, client_instance_id, max_source_id, source_rows, sealed, updated_at_ms
FROM rollup_bucket_state;
DROP TABLE rollup_bucket_state;
ALTER TABLE rollup_bucket_state_v10 RENAME TO rollup_bucket_state;

DROP TABLE IF EXISTS bucket_latency_v10;
CREATE TABLE bucket_latency_v10 (
  source_name        TEXT    NOT NULL DEFAULT 'codex_logs',
  hour_bucket        INTEGER NOT NULL,
  client_instance_id TEXT    NOT NULL DEFAULT '',
  samples            INTEGER NOT NULL DEFAULT 0,
  p50_ms             INTEGER,
  p95_ms             INTEGER,
  updated_at_ms      INTEGER NOT NULL,
  PRIMARY KEY (source_name, hour_bucket, client_instance_id)
);
INSERT OR IGNORE INTO bucket_latency_v10 (
  source_name, hour_bucket, client_instance_id, samples, p50_ms, p95_ms, updated_at_ms
) SELECT
  'codex_logs', hour_bucket, client_instance_id, samples, p50_ms, p95_ms, updated_at_ms
FROM bucket_latency;
DROP TABLE bucket_latency;
ALTER TABLE bucket_latency_v10 RENAME TO bucket_latency;
";

/// v11:`price_book_version` 价目表版本历史(纯配置表,Rust 侧零乘法)。
///
/// v7 库里没有这张表,所以 v11 **直接复用建表常量**(唯一的一份 DDL,不会漂移);
/// `CREATE TABLE IF NOT EXISTS` + `CREATE INDEX IF NOT EXISTS` 本身已幂等。
pub const SQL_MIGRATE_V11_PRICE_BOOK: &str = SQL_CREATE_PRICE_BOOK_VERSION;

/// v12:对账索引 —— 按 (源, 模型, 小时) 支撑"两源并列"的 P0-25 对账视图。
pub const SQL_MIGRATE_V12_RECONCILE_INDEX: &str = "
CREATE INDEX IF NOT EXISTS ix_rollup_reconcile
  ON usage_rollup(source_name, model_id, hour_bucket);
";

/// 迁移列表:(版本号, 说明, SQL)。**必须按版本号升序**。
///
/// v1–v7:一条迁移 = 一张表(连同其索引),DDL 常量与迁移 SQL 是同一份文本,
/// 不会出现"常量改了、迁移没改"的漂移。常量本身是 **v8 终态**,所以空库与老库殊途同归。
/// v8–v12:二期多源化增量迁移,见各自常量的文档。
pub const MIGRATIONS: &[(u32, &str, &str)] = &[
    (1, "schema_version 迁移水位表", SQL_CREATE_SCHEMA_VERSION),
    (2, "usage_rollup 档位化小时桶事实表", SQL_CREATE_USAGE_ROLLUP),
    (3, "account_identity 身份表(时段闭合,修正 BUG-2)", SQL_CREATE_ACCOUNT_IDENTITY),
    (4, "identity_override 人工归并覆盖", SQL_CREATE_IDENTITY_OVERRIDE),
    (5, "rollup_bucket_state 桶级摄取状态", SQL_CREATE_ROLLUP_BUCKET_STATE),
    (6, "bucket_latency 整桶延迟分位数", SQL_CREATE_BUCKET_LATENCY),
    (7, "ingest_state 摄取水位", SQL_CREATE_INGEST_STATE),
    (8, "usage_rollup 加 source_name(PK 第 2 位)并搬迁老数据", SQL_MIGRATE_V8_USAGE_ROLLUP),
    (9, "ingest_state 主键改为 source_name 并搬迁老水位", SQL_MIGRATE_V9_INGEST_STATE),
    (10, "rollup_bucket_state / bucket_latency 加 source_name", SQL_MIGRATE_V10_BUCKETS),
    (11, "price_book_version 价目表版本历史", SQL_MIGRATE_V11_PRICE_BOOK),
    (12, "ix_rollup_reconcile 对账索引", SQL_MIGRATE_V12_RECONCILE_INDEX),
    (13, "显式录入的本地财务事件", crate::finance_ledger::SCHEMA_SQL),
    (14, "采购批次与财务事件关联", crate::finance_ledger::MIGRATION_V14),
    (15, "models.dev 本地目录缓存", crate::model_catalog::MIGRATION_V15),
];

/// 开库后立即生效的 PRAGMA(与 `docs/architecture/ledger-schema.sql` 头部一致)。
pub const SQL_PRAGMAS: &str = "
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
";

/// 账本表的名字(单测与自检用),包含财务事件与目录缓存。
pub const LEDGER_TABLES: [&str; 10] = [
    "schema_version",
    "usage_rollup",
    "account_identity",
    "identity_override",
    "rollup_bucket_state",
    "bucket_latency",
    "ingest_state",
    "price_book_version",
    "finance_events",
    "model_catalog_cache",
];

// -----------------------------------------------------------------------------
// 错误类型
// -----------------------------------------------------------------------------

/// 账本数据层的错误。
#[derive(Debug)]
pub enum LedgerError {
    /// SQLite 本身报错(建表失败 / 约束冲突 / IO 错误等)。
    Sqlite(rusqlite::Error),
    /// 无法定位或创建账本目录。
    Path(String),
    /// 库里记录的 schema 版本比代码认识的最新版本还高 —— 用户拿新版建了库又退回旧版。
    /// 这是**必须显式失败**的场景:旧代码按旧语义写新表会静默损坏数据。
    FutureSchemaVersion { found: u32, supported: u32 },
    /// 读路径遇到**落后**的 schema(代码已升级,但账本还没被写路径迁移)。
    ///
    /// 只读打开**不跑迁移**(见 [`open_read_only`]),所以这里必须显式报错而不是硬读 ——
    /// 否则 SELECT 会撞 `no such column` 这种让人一头雾水的错。
    /// 正常情况不会命中:启动时会摄取一次,写路径会把 schema 推到最新。
    SchemaOutdated { found: u32, supported: u32 },
}

impl fmt::Display for LedgerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LedgerError::Sqlite(e) => write!(f, "账本 SQLite 错误: {e}"),
            LedgerError::Path(msg) => write!(f, "账本路径不可用: {msg}"),
            LedgerError::FutureSchemaVersion { found, supported } => write!(
                f,
                "账本版本 {found} 高于应用支持的 {supported},请升级 2api-console 后再打开(旧版本写入新表会损坏数据)"
            ),
            LedgerError::SchemaOutdated { found, supported } => write!(
                f,
                "账本版本 {found} 落后于应用要求的 {supported},请等待一次摄取完成后重试"
            ),
        }
    }
}

impl std::error::Error for LedgerError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            LedgerError::Sqlite(e) => Some(e),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for LedgerError {
    fn from(e: rusqlite::Error) -> Self {
        LedgerError::Sqlite(e)
    }
}

// -----------------------------------------------------------------------------
// 时间桶
// -----------------------------------------------------------------------------

/// epoch 小时桶:`ts_ms.div_euclid(3_600_000) * 3_600_000`。
///
/// **不得改成"本地时区整点"**:cockpit 侧与前端消费侧都按 epoch 小时对齐,
/// 改成本地整点会让桶边界与 cockpit 错位,跨时区机器上还会出现重复/漏桶。
/// 用 `div_euclid` 而非 `/`:1970 年之前的负时间戳(脏数据)也能向下取到桶边界,不会向上取整。
pub fn hour_bucket(ts_ms: i64) -> i64 {
    ts_ms.div_euclid(HOUR_MS) * HOUR_MS
}

/// 当前 epoch 毫秒(时钟回退到 1970 前时退化为 0,不 panic)。
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// -----------------------------------------------------------------------------
// 路径
// -----------------------------------------------------------------------------

/// 在给定目录下解析账本文件路径(目录 + 固定文件名)。
pub fn ledger_db_path_in(dir: &Path) -> PathBuf {
    dir.join(LEDGER_DB_FILE_NAME)
}

/// 解析账本文件路径。
///
/// 优先级:
/// 1. 环境变量 `CONSOLE2API_LEDGER_DIR`(运维 / 排障显式指定);
/// 2. Tauri `app_data_dir()` 等价路径 —— Windows `%APPDATA%\com.console.2api`;
/// 3. 回落 `%APPDATA%\2api-console`;
/// 4. 回落 `~/.local/share/2api-console`。
///
/// 2/3/4 采用"第一个可创建成功的候选",保证返回的路径一定可写。
/// **绝不返回 cockpit 目录**(`%USERPROFILE%\.antigravity_cockpit\`)。
pub fn ledger_db_path() -> Result<PathBuf, LedgerError> {
    if let Ok(dir) = std::env::var(LEDGER_DIR_ENV) {
        let dir = dir.trim();
        if !dir.is_empty() {
            let path = ledger_db_path_in(Path::new(dir));
            assert_not_cockpit_path(&path)?;
            return Ok(path);
        }
    }
    let path = ledger_db_path_in(&resolve_app_data_dir()?);
    assert_not_cockpit_path(&path)?;
    Ok(path)
}

/// 按优先级挑出第一个可创建的账本目录。
fn resolve_app_data_dir() -> Result<PathBuf, LedgerError> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(appdata) = std::env::var("APPDATA") {
        let appdata = appdata.trim();
        if !appdata.is_empty() {
            // Tauri app_data_dir() 在 Windows 上的解析结果
            candidates.push(Path::new(appdata).join(TAURI_APP_ID));
            candidates.push(Path::new(appdata).join(FALLBACK_DIR_NAME));
        }
    }
    if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        let home = home.trim();
        if !home.is_empty() {
            candidates.push(Path::new(home).join(".local").join("share").join(FALLBACK_DIR_NAME));
        }
    }
    if candidates.is_empty() {
        return Err(LedgerError::Path(
            "无法定位用户数据目录(APPDATA/USERPROFILE/HOME 均未设置)".to_string(),
        ));
    }
    for candidate in &candidates {
        if std::fs::create_dir_all(candidate).is_ok() {
            return Ok(candidate.clone());
        }
    }
    // 全都创建失败:返回首选候选,让随后的 open() 报出真实的 SQLite 错误。
    Ok(candidates[0].clone())
}

/// 防串味自检:账本绝不能落在 cockpit 数据目录里,也不能套用 cockpit 的库文件名。
///
/// cockpit 目录由 cockpit 拥有并会自行清理,我们的账放那里等于把命交出去。
pub fn assert_not_cockpit_path(path: &Path) -> Result<(), LedgerError> {
    let under_cockpit = path
        .components()
        .any(|c| c.as_os_str().eq_ignore_ascii_case(".antigravity_cockpit"));
    if under_cockpit {
        return Err(LedgerError::Path(format!(
            "账本不得落在 cockpit 数据目录: {}",
            path.display()
        )));
    }
    if path.file_name().and_then(|n| n.to_str()) == Some(REQUEST_LOG_DB_NAME) {
        return Err(LedgerError::Path(format!(
            "账本文件名不得与 cockpit 源库同名({REQUEST_LOG_DB_NAME}): {}",
            path.display()
        )));
    }
    Ok(())
}

// -----------------------------------------------------------------------------
// 连接与迁移
// -----------------------------------------------------------------------------

/// 打开账本(不存在则创建并升到最新 schema)。
///
/// 每次调用返回**独立连接**,调用方用完即弃;不要缓存 `Connection`。
pub fn open(path: &Path) -> Result<Connection, LedgerError> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| LedgerError::Path(format!("创建账本目录失败 {}: {e}", parent.display())))?;
        }
    }
    let mut conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.execute_batch(SQL_PRAGMAS)?;
    migrate(&mut conn)?;
    Ok(conn)
}

/// 打开账本用于**只读查询**(对账 / 合并口径 / 各 Tauri 读命令)。
///
/// ★ 与 [`open`] 的关键区别:**不跑 [`migrate`]**。
///
/// **为什么(2026-09-12 实测教训)**:
/// 应用后台有一个定时摄取线程(默认 15 分钟一次)在**写**账本。而 `migrate()` 会开写事务
/// (即便版本已是最新,`conn.transaction()` 也预备了写锁)。读路径跟着跑 migrate 就等于
/// **读操作去抢写锁**,和摄取线程撞成 `SQLITE_BUSY` —— 而 SQLite 对写-写冲突**不走**
/// `busy_timeout` 排队,是立刻失败。表现就是:用户正看着资产总览,后台一摄取,界面就报错。
///
/// 只读路径只需要"能 SELECT"。schema 版本的推进是写路径的职责,读路径只做校验:
/// 版本落后就显式报 [`LedgerError::SchemaOutdated`],绝不硬读、绝不自己动手迁移。
///
/// **调用前必须确认文件存在**(调用方已有 `path.exists()` 检查):这里刻意**不带**
/// `SQLITE_OPEN_CREATE`,免得一个查询动作凭空建出库来。
pub fn open_read_only(path: &Path) -> Result<Connection, LedgerError> {
    if !path.exists() {
        return Err(LedgerError::Path(format!(
            "账本尚不存在,请先完成一次摄取: {}",
            path.display()
        )));
    }
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    // 只读路径**只**设 busy_timeout:
    //  - `journal_mode` 库里已是 WAL,重复设置属于写动作,可能触发不必要的锁;
    //  - `foreign_keys` 对纯 SELECT 无意义。
    // WAL 下读者不阻塞写者、写者也不阻塞读者,所以只要求"等"就够了。
    conn.execute_batch("PRAGMA busy_timeout = 10000;")?;
    let found = current_version(&conn)?;
    if found < SCHEMA_VERSION_LATEST {
        return Err(LedgerError::SchemaOutdated {
            found,
            supported: SCHEMA_VERSION_LATEST,
        });
    }
    Ok(conn)
}

/// 打开默认路径下的账本(便捷入口)。
pub fn open_default() -> Result<Connection, LedgerError> {
    let path = ledger_db_path()?;
    open(&path)
}

/// 打开指定目录下的账本(单测与 T02 指定实例目录时常用)。
pub fn open_in(dir: &Path) -> Result<Connection, LedgerError> {
    open(&ledger_db_path_in(dir))
}

/// 读取 `PRAGMA user_version`(当前库版本)。
pub fn current_version(conn: &Connection) -> Result<u32, LedgerError> {
    let v: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    Ok(v.max(0) as u32)
}

/// 应用所有待执行的迁移,并把水位写回 `schema_version` 与 `PRAGMA user_version`。
///
/// - 全部迁移在**单个事务**内执行:中途失败整体回滚,不会留下半截 schema。
/// - 已应用过的版本会被跳过(判据 = `max(PRAGMA user_version, MAX(schema_version.version))`),
///   重复调用是幂等的。
/// - 库里版本**高于**代码已知最新版本时直接报错,不做任何猜测式降级迁移。
pub fn migrate(conn: &mut Connection) -> Result<u32, LedgerError> {
    let user_version = current_version(conn)?;
    let applied_max: i64 = conn
        .query_row("SELECT COALESCE(MAX(version), 0) FROM schema_version", [], |row| {
            row.get(0)
        })
        .unwrap_or(0);
    let base = user_version.max(applied_max.max(0) as u32);

    if base > SCHEMA_VERSION_LATEST {
        return Err(LedgerError::FutureSchemaVersion {
            found: base,
            supported: SCHEMA_VERSION_LATEST,
        });
    }

    let tx = conn.transaction()?;
    let mut applied = 0u32;
    for (version, description, sql) in MIGRATIONS {
        if *version <= base {
            continue;
        }
        tx.execute_batch(sql)?;
        tx.execute(
            "INSERT INTO schema_version (version, applied_at, description) VALUES (?1, ?2, ?3)",
            params![*version as i64, now_ms(), description],
        )?;
        applied += 1;
    }
    tx.commit()?;

    // user_version 与 schema_version 表保持同步:前者给"快速判版本"用,后者给审计看。
    conn.pragma_update(None, "user_version", SCHEMA_VERSION_LATEST as i64)?;
    Ok(applied)
}

// -----------------------------------------------------------------------------
// 单测
// -----------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::types::Value;

    /// 每个用例一个独占临时目录(带 pid + 纳秒,避免并行测试互相踩)。
    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("console2api-ledger-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    /// 列出库里所有用户表(排除 sqlite_ 内部表)。
    fn user_tables(conn: &Connection) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .expect("准备 sqlite_master 查询");
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .expect("查询 sqlite_master");
        rows.collect::<Result<Vec<_>, _>>().expect("读取表名")
    }

    /// 取某个索引的建索引 SQL(用于断言唯一索引是否含 valid_from_hour)。
    fn index_sql(conn: &Connection, name: &str) -> String {
        conn.query_row(
            "SELECT COALESCE(sql, '') FROM sqlite_master WHERE type = 'index' AND name = ?1",
            params![name],
            |row| row.get(0),
        )
        .unwrap_or_default()
    }

    #[test]
    fn latest_constant_matches_last_migration() {
        let last = MIGRATIONS.last().expect("迁移列表非空").0;
        assert_eq!(SCHEMA_VERSION_LATEST, last, "SCHEMA_VERSION_LATEST 必须等于末项迁移版本");
        // 版本号严格递增,否则 migrate() 的跳过判据会错乱
        for w in MIGRATIONS.windows(2) {
            assert!(w[0].0 < w[1].0, "迁移版本号必须严格递增: {} vs {}", w[0].0, w[1].0);
        }
        assert_eq!(MIGRATIONS.len(), 15, "用量、财务及目录缓存增量迁移");
        assert_eq!(LEDGER_TABLES.len(), 10, "用量、财务及目录缓存");
        assert!(
            LEDGER_TABLES.contains(&"price_book_version"),
            "v11 新增的价目表必须在表清单里"
        );
    }

    /// v7(一期)历史 DDL —— **冻结**,只用于构造"老库"来验证迁移。
    /// 改动它等于改历史,请另写新迁移。
    const V7_DDL: &str = "
CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER PRIMARY KEY,
  applied_at  INTEGER NOT NULL,
  description TEXT    NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS usage_rollup (
  hour_bucket          INTEGER NOT NULL,
  source_account_id    TEXT    NOT NULL,
  model_id             TEXT    NOT NULL,
  api_key_id           TEXT    NOT NULL,
  client_instance_id   TEXT    NOT NULL DEFAULT '',
  std_normal_input     INTEGER NOT NULL DEFAULT 0,
  std_cached           INTEGER NOT NULL DEFAULT 0,
  std_output           INTEGER NOT NULL DEFAULT 0,
  long_normal_input    INTEGER NOT NULL DEFAULT 0,
  long_cached          INTEGER NOT NULL DEFAULT 0,
  long_output          INTEGER NOT NULL DEFAULT 0,
  requests             INTEGER NOT NULL DEFAULT 0,
  success              INTEGER NOT NULL DEFAULT 0,
  error                INTEGER NOT NULL DEFAULT 0,
  rate_limited         INTEGER NOT NULL DEFAULT 0,
  upstream_error       INTEGER NOT NULL DEFAULT 0,
  client_canceled      INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd    REAL NOT NULL DEFAULT 0,
  model_pricing_version TEXT,
  latency_p50_ms  INTEGER,
  latency_p95_ms  INTEGER,
  latency_samples INTEGER NOT NULL DEFAULT 0,
  error_categories TEXT NOT NULL DEFAULT '{}',
  first_ms      INTEGER,
  last_ms       INTEGER,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (hour_bucket, source_account_id, model_id, api_key_id, client_instance_id)
);
CREATE INDEX IF NOT EXISTS ix_rollup_account ON usage_rollup(source_account_id, hour_bucket);
CREATE INDEX IF NOT EXISTS ix_rollup_model   ON usage_rollup(model_id, hour_bucket);
CREATE INDEX IF NOT EXISTS ix_rollup_key     ON usage_rollup(api_key_id, hour_bucket);
CREATE TABLE IF NOT EXISTS rollup_bucket_state (
  hour_bucket        INTEGER NOT NULL,
  client_instance_id TEXT    NOT NULL DEFAULT '',
  max_source_id      INTEGER NOT NULL DEFAULT 0,
  source_rows        INTEGER NOT NULL DEFAULT 0,
  sealed             INTEGER NOT NULL DEFAULT 0,
  updated_at_ms      INTEGER NOT NULL,
  PRIMARY KEY (hour_bucket, client_instance_id)
);
CREATE TABLE IF NOT EXISTS bucket_latency (
  hour_bucket        INTEGER NOT NULL,
  client_instance_id TEXT    NOT NULL DEFAULT '',
  samples            INTEGER NOT NULL DEFAULT 0,
  p50_ms             INTEGER,
  p95_ms             INTEGER,
  updated_at_ms      INTEGER NOT NULL,
  PRIMARY KEY (hour_bucket, client_instance_id)
);
CREATE TABLE IF NOT EXISTS ingest_state (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  client_instance_id TEXT    NOT NULL DEFAULT '',
  source_path        TEXT    NOT NULL DEFAULT '',
  source_fingerprint TEXT    NOT NULL DEFAULT '',
  last_id            INTEGER NOT NULL DEFAULT 0,
  last_ts_ms         INTEGER NOT NULL DEFAULT 0,
  last_ingest_ms     INTEGER NOT NULL DEFAULT 0,
  last_batch_rows    INTEGER NOT NULL DEFAULT 0,
  last_duration_ms   INTEGER NOT NULL DEFAULT 0,
  total_rows_seen    INTEGER NOT NULL DEFAULT 0,
  schema_version     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS account_identity (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  source_account_id    TEXT    NOT NULL,
  client_instance_id   TEXT    NOT NULL DEFAULT '',
  platform             TEXT    NOT NULL DEFAULT '',
  email_norm           TEXT    NOT NULL DEFAULT '',
  email_display        TEXT    NOT NULL DEFAULT '',
  official_account_id  TEXT    NOT NULL DEFAULT '',
  is_provider_test     INTEGER NOT NULL DEFAULT 0,
  valid_from_hour      INTEGER NOT NULL,
  valid_to_hour        INTEGER,
  first_seen_ms        INTEGER NOT NULL,
  last_seen_ms         INTEGER NOT NULL,
  first_seen_source_id INTEGER NOT NULL DEFAULT 0,
  last_seen_source_id  INTEGER NOT NULL DEFAULT 0,
  updated_at_ms        INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_identity_seg
  ON account_identity(source_account_id, client_instance_id, email_norm, valid_from_hour);
CREATE INDEX IF NOT EXISTS ix_identity_email ON account_identity(email_norm);
CREATE INDEX IF NOT EXISTS ix_identity_open
  ON account_identity(source_account_id, client_instance_id, valid_to_hour);
CREATE TABLE IF NOT EXISTS identity_override (
  source_account_id  TEXT    NOT NULL,
  client_instance_id TEXT    NOT NULL DEFAULT '',
  identity_key       TEXT    NOT NULL,
  note               TEXT    NOT NULL DEFAULT '',
  created_at_ms      INTEGER NOT NULL,
  PRIMARY KEY (source_account_id, client_instance_id)
);";

    /// 归一化 DDL 文本,用于比较"结构等价"而非逐字节相等:
    /// - 去掉 `--` 行注释(建表常量带注释,迁移里的临时表不带);
    /// - 去掉 `"`(`ALTER TABLE ... RENAME TO` 会把表名写成 `"usage_rollup"`);
    /// - 折叠连续空白。
    fn norm_ddl(sql: &str) -> String {
        let mut no_comments = String::with_capacity(sql.len());
        for line in sql.lines() {
            let cut = line.find("--").unwrap_or(line.len());
            no_comments.push_str(&line[..cut]);
            no_comments.push('\n');
        }
        no_comments
            .replace('"', "")
            .split_whitespace()
            .collect::<Vec<&str>>()
            .join(" ")
    }

    /// 造一个"真实的 v7 老库":建 v7 表 + 写 schema_version 1..7 + user_version=7 + 老数据。
    /// 返回 (账本路径, 期望的 6 档位合计)。
    fn seed_v7(dir: &Path) -> PathBuf {
        let path = ledger_db_path_in(dir);
        let conn = Connection::open(&path).expect("建 v7 老库");
        conn.execute_batch(V7_DDL).expect("建 v7 表");
        // 老数据:两桶 × 两个账号,带齐延迟/失败细分/端点,确保"零丢失"可验证
        conn.execute_batch(
            "INSERT INTO usage_rollup (hour_bucket, source_account_id, model_id, api_key_id,
                client_instance_id, std_normal_input, std_cached, std_output,
                long_normal_input, long_cached, long_output, requests, success, error,
                rate_limited, upstream_error, client_canceled, estimated_cost_usd,
                model_pricing_version, latency_p50_ms, latency_p95_ms, latency_samples,
                error_categories, first_ms, last_ms, updated_at_ms)
             VALUES
               (1000, 'codex_a1', 'm1', 'k1', '', 10, 20, 30, 40, 50, 60, 7, 5, 2, 1, 1, 0,
                1.5, 'v-old', 11, 91, 3, '{\"upstream_error\":1}', 1000, 9000, 12345),
               (1000, 'codex_a2', 'm2', 'k2', 'inst-9', 1, 2, 3, 4, 5, 6, 3, 3, 0, 0, 0, 0,
                0.25, NULL, NULL, NULL, 0, '{}', 2000, 8000, 12346),
               (2000, 'codex_a1', 'm1', 'k1', '', 100, 200, 300, 400, 500, 600, 9, 8, 1, 0, 1, 0,
                2.75, 'v-old', 22, 92, 5, '{\"upstream_error\":1}', 3000, 7000, 12347);
             INSERT INTO rollup_bucket_state (hour_bucket, client_instance_id, max_source_id,
                source_rows, sealed, updated_at_ms) VALUES
               (1000, '', 777, 10, 1, 555),
               (2000, '', 888, 9, 0, 556);
             INSERT INTO bucket_latency (hour_bucket, client_instance_id, samples, p50_ms, p95_ms,
                updated_at_ms) VALUES
               (1000, '', 3, 11, 91, 555),
               (2000, '', 5, 22, 92, 556);
             INSERT INTO ingest_state (id, client_instance_id, source_path, source_fingerprint,
                last_id, last_ts_ms, last_ingest_ms, last_batch_rows, last_duration_ms,
                total_rows_seen, schema_version)
             VALUES (1, 'inst-1', 'C:/src.sqlite', 'legacy|fp', 8888, 9999, 1111, 222, 33, 4444, 7);",
        )
        .expect("写 v7 老数据");
        for version in 1..=7u32 {
            conn.execute(
                "INSERT INTO schema_version (version, applied_at, description) VALUES (?1, ?2, ?3)",
                params![version as i64, 1_700_000_000_000i64, format!("v{version}")],
            )
            .expect("写 v7 迁移水位");
        }
        conn.pragma_update(None, "user_version", 7i64).expect("写 user_version=7");
        drop(conn);
        path
    }

    fn tier_sums(conn: &Connection) -> Vec<i64> {
        [
            "std_normal_input",
            "std_cached",
            "std_output",
            "long_normal_input",
            "long_cached",
            "long_output",
        ]
        .iter()
        .map(|c| {
            conn.query_row(&format!("SELECT COALESCE(SUM({c}),0) FROM usage_rollup"), [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap_or(0)
        })
        .collect()
    }

    fn scalar_i64(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get::<_, Option<i64>>(0))
            .unwrap_or(None)
            .unwrap_or(0)
    }

    #[test]
    fn open_repeatedly_is_idempotent() {
        let dir = temp_dir("idempotent");
        let path = ledger_db_path_in(&dir);

        // 连续开库 3 次(每次独立连接,模拟"5 分钟摄取一次")
        for round in 1..=3 {
            let conn = open(&path).unwrap_or_else(|e| panic!("第 {round} 次开库失败: {e}"));
            assert_eq!(
                current_version(&conn).expect("读版本"),
                SCHEMA_VERSION_LATEST,
                "第 {round} 次开库后版本应恒为最新"
            );
            let rows: i64 = conn
                .query_row("SELECT COUNT(*) FROM schema_version", [], |r| r.get(0))
                .expect("数 schema_version 行数");
            assert_eq!(
                rows, MIGRATIONS.len() as i64,
                "第 {round} 次开库后不应重复 apply 迁移(schema_version 应恰好 {} 行)",
                MIGRATIONS.len()
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn all_ledger_tables_exist() {
        let dir = temp_dir("tables");
        let conn = open(&ledger_db_path_in(&dir)).expect("开库");
        let tables = user_tables(&conn);
        for name in LEDGER_TABLES {
            assert!(tables.iter().any(|t| t == name), "缺表: {name}");
        }
        assert_eq!(tables.len(), LEDGER_TABLES.len(), "不应有多余的表: {tables:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ------------------------------------------------------------ v7 → v12 迁移

    #[test]
    fn v8_migration_preserves_every_legacy_value() {
        let dir = temp_dir("v7migrate");
        let path = seed_v7(&dir);
        let conn = open(&path).expect("迁移老库");

        assert_eq!(current_version(&conn).expect("版本"), SCHEMA_VERSION_LATEST);
        // 一条不少
        assert_eq!(scalar_i64(&conn, "SELECT COUNT(*) FROM usage_rollup"), 3, "3 个老 grain 必须全在");
        assert_eq!(scalar_i64(&conn, "SELECT COUNT(*) FROM rollup_bucket_state"), 2);
        assert_eq!(scalar_i64(&conn, "SELECT COUNT(*) FROM bucket_latency"), 2);
        assert_eq!(scalar_i64(&conn, "SELECT COUNT(*) FROM ingest_state"), 1);

        // 6 档位 token 合计一字不变(10+1+100 / 20+2+200 / ... )
        assert_eq!(tier_sums(&conn), vec![111, 222, 333, 444, 555, 666], "6 档位必须原样搬迁");
        // 计数 / 审计值 / 延迟 / 失败细分 / 端点全部原样
        assert_eq!(scalar_i64(&conn, "SELECT COALESCE(SUM(requests),0) FROM usage_rollup"), 19);
        assert_eq!(scalar_i64(&conn, "SELECT COALESCE(SUM(error),0) FROM usage_rollup"), 3);
        assert_eq!(scalar_i64(&conn, "SELECT COALESCE(SUM(latency_samples),0) FROM usage_rollup"), 8);
        let cost: f64 = conn
            .query_row("SELECT COALESCE(SUM(estimated_cost_usd),0) FROM usage_rollup", [], |r| r.get(0))
            .expect("读审计成本");
        assert!((cost - 4.5).abs() < 1e-9, "estimated_cost_usd 原样搬迁: {cost}");
        let cats: String = conn
            .query_row(
                "SELECT error_categories FROM usage_rollup WHERE hour_bucket = 1000 AND source_account_id = 'codex_a1'",
                [],
                |r| r.get(0),
            )
            .expect("读失败细分");
        assert_eq!(cats, "{\"upstream_error\":1}", "error_categories 原样搬迁");
        let (first_ms, last_ms): (i64, i64) = conn
            .query_row(
                "SELECT first_ms, last_ms FROM usage_rollup WHERE hour_bucket = 1000 AND source_account_id = 'codex_a1'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .expect("读端点");
        assert_eq!((first_ms, last_ms), (1000, 9000), "窗口端点原样搬迁");
        // 老行的 NULL 不能被默认值顶掉
        let p50: Option<i64> = conn
            .query_row(
                "SELECT latency_p50_ms FROM usage_rollup WHERE hour_bucket = 1000 AND source_account_id = 'codex_a2'",
                [],
                |r| r.get(0),
            )
            .expect("读 NULL 分位数");
        assert_eq!(p50, None, "老行的 NULL 分位数必须保持 NULL");

        // 全部打上 codex_logs 标签
        let distinct: Vec<String> = conn
            .prepare("SELECT DISTINCT source_name FROM usage_rollup")
            .and_then(|mut s| {
                s.query_map([], |r| r.get::<_, String>(0))
                    .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
            })
            .expect("读 source_name");
        assert_eq!(distinct, vec![SOURCE_CODEX_LOGS.to_string()], "老数据必须打 codex_logs 标签");

        // 桶水位:max_source_id 与 sealed 原样(sealed 绝不能被重置)
        let sealed_flags = conn
            .prepare("SELECT hour_bucket, max_source_id, sealed FROM rollup_bucket_state ORDER BY hour_bucket")
            .and_then(|mut s| {
                s.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)))
                    .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
            })
            .expect("读桶水位");
        assert_eq!(sealed_flags, vec![(1000, 777, 1), (2000, 888, 0)], "sealed/水位必须原样搬迁");

        // 水位表:主键换成 source_name,字段一字不改
        let (src, path_txt, fp, last_id, total) = conn
            .query_row(
                "SELECT source_name, source_path, source_fingerprint, last_id, total_rows_seen FROM ingest_state",
                [],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, i64>(3)?,
                        r.get::<_, i64>(4)?,
                    ))
                },
            )
            .expect("读水位");
        assert_eq!(src, SOURCE_CODEX_LOGS);
        assert_eq!(path_txt, "C:/src.sqlite");
        assert_eq!(fp, "legacy|fp");
        assert_eq!(last_id, 8888);
        assert_eq!(total, 4444);
        // 老列 id 必须消失
        let has_id: bool = conn
            .prepare("SELECT 1 FROM pragma_table_info('ingest_state') WHERE name = 'id'")
            .and_then(|mut s| s.query_row([], |_| Ok(true)))
            .unwrap_or(false);
        assert!(!has_id, "v9 后 ingest_state 不应再有 id 列");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn migration_is_idempotent_when_replayed() {
        let dir = temp_dir("replay");
        let path = seed_v7(&dir);
        let expected = {
            let conn = open(&path).expect("首次迁移");
            tier_sums(&conn)
        };
        // 对已迁移的库再连开 3 次 + 显式 migrate() 3 次:不报错、不翻倍、不多写水位
        let mut conn = open(&path).expect("重开");
        for round in 1..=3 {
            let applied = migrate(&mut conn).unwrap_or_else(|e| panic!("第 {round} 次 migrate 失败: {e}"));
            assert_eq!(applied, 0, "第 {round} 次不应再 apply 任何迁移");
            assert_eq!(tier_sums(&conn), expected, "第 {round} 次后 6 档位不得翻倍");
            assert_eq!(scalar_i64(&conn, "SELECT COUNT(*) FROM usage_rollup"), 3, "行数不得翻倍");
            assert_eq!(
                scalar_i64(&conn, "SELECT COUNT(*) FROM schema_version"),
                MIGRATIONS.len() as i64,
                "schema_version 行数应与迁移数一致"
            );
            assert_eq!(current_version(&conn).expect("版本"), SCHEMA_VERSION_LATEST);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn two_sources_do_not_collide_on_same_grain() {
        let dir = temp_dir("twosource");
        let conn = open(&ledger_db_path_in(&dir)).expect("开库");
        // 唯一索引必须含 source_name(否则两源撞键)
        let pk = conn
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'usage_rollup'",
                [],
                |r| r.get::<_, String>(0),
            )
            .expect("读建表 SQL");
        assert!(pk.contains("source_name"), "usage_rollup 主键缺 source_name: {pk}");

        let insert = "INSERT INTO usage_rollup (hour_bucket, source_name, source_account_id, model_id,
            api_key_id, client_instance_id, std_normal_input, updated_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1)";
        for source in [SOURCE_CODEX_LOGS, SOURCE_CODEX_SESSIONS] {
            conn.execute(
                insert,
                params![1000i64, source, "codex_a1", "m1", "k1", "", 10i64],
            )
            .unwrap_or_else(|e| panic!("插入 {source} 应成功: {e}"));
        }
        // 同一源再插同 grain → 必须撞主键(证明唯一键生效)
        let dup = conn.execute(insert, params![1000i64, SOURCE_CODEX_LOGS, "codex_a1", "m1", "k1", "", 10i64]);
        assert!(dup.is_err(), "同一源同 grain 第二次插入应撞主键");
        assert_eq!(scalar_i64(&conn, "SELECT COUNT(*) FROM usage_rollup"), 2, "两源各 1 行");
        let sources: Vec<String> = conn
            .prepare("SELECT DISTINCT source_name FROM usage_rollup ORDER BY source_name")
            .and_then(|mut s| {
                s.query_map([], |r| r.get::<_, String>(0))
                    .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
            })
            .expect("读源");
        assert_eq!(sources, vec![SOURCE_CODEX_LOGS, SOURCE_CODEX_SESSIONS]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ingest_state_keys_are_per_source() {
        let dir = temp_dir("perstate");
        let conn = open(&ledger_db_path_in(&dir)).expect("开库");
        let upsert = "INSERT INTO ingest_state (source_name, source_path, last_id, schema_version)
            VALUES (?1, ?2, ?3, 12)
            ON CONFLICT(source_name) DO UPDATE SET last_id = excluded.last_id, source_path = excluded.source_path";
        conn.execute(upsert, params![SOURCE_CODEX_LOGS, "C:/logs.sqlite", 100i64])
            .expect("写 logs 水位");
        conn.execute(upsert, params![SOURCE_CODEX_SESSIONS, "C:/sessions.sqlite", 7i64])
            .expect("写 sessions 水位");
        // 再写一次 logs:只动自己那行
        conn.execute(upsert, params![SOURCE_CODEX_LOGS, "C:/logs.sqlite", 999i64])
            .expect("更新 logs 水位");

        assert_eq!(scalar_i64(&conn, "SELECT COUNT(*) FROM ingest_state"), 2, "两个源两条水位");
        let logs_id = scalar_i64(
            &conn,
            &format!("SELECT last_id FROM ingest_state WHERE source_name = '{SOURCE_CODEX_LOGS}'"),
        );
        let sessions_id = scalar_i64(
            &conn,
            &format!("SELECT last_id FROM ingest_state WHERE source_name = '{SOURCE_CODEX_SESSIONS}'"),
        );
        assert_eq!(logs_id, 999, "logs 水位应被更新");
        assert_eq!(sessions_id, 7, "sessions 水位不得被覆盖");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn fresh_and_migrated_schema_are_identical() {
        let fresh_dir = temp_dir("fresh");
        let fresh = open(&ledger_db_path_in(&fresh_dir)).expect("开空库");
        let legacy_dir = temp_dir("legacy");
        let legacy_path = seed_v7(&legacy_dir);
        let legacy = open(&legacy_path).expect("迁移老库");

        let dump = |conn: &Connection| -> Vec<String> {
            let mut stmt = conn
                .prepare(
                    "SELECT type, name, tbl_name, COALESCE(sql,'') FROM sqlite_master
                     WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
                )
                .expect("prepare");
            stmt.query_map([], |r| {
                Ok(format!(
                    "{}|{}|{}|{}",
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    norm_ddl(&r.get::<_, String>(3)?)
                ))
            })
            .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
            .expect("dump")
        };
        let a = dump(&fresh);
        let b = dump(&legacy);
        let only_fresh: Vec<String> = a.iter().filter(|x| !b.contains(*x)).cloned().collect();
        let only_legacy: Vec<String> = b.iter().filter(|x| !a.contains(*x)).cloned().collect();
        assert!(
            only_fresh.is_empty() && only_legacy.is_empty(),
            "空库与老库的终态 schema 必须完全一致\n  仅空库有: {only_fresh:#?}\n  仅老库有: {only_legacy:#?}"
        );
        let _ = std::fs::remove_dir_all(&fresh_dir);
        let _ = std::fs::remove_dir_all(&legacy_dir);
    }

    /// v8 用"建临时表 → 搬数据 → 删老表 → 改名"重建 `usage_rollup`。
    /// 索引若建在 `DROP TABLE` 之前,`IF NOT EXISTS` 会因为"名字已被老表占用"而整句跳过,
    /// 随后老表连同索引一起被删 ⇒ 索引永久丢失。本测试钉死这条回归。
    #[test]
    fn rollup_indexes_survive_the_v8_rebuild() {
        let fresh_dir = temp_dir("idx_fresh");
        let legacy_dir = temp_dir("idx_legacy");
        let cases: [(&str, Connection); 2] = [
            ("空库", open(&ledger_db_path_in(&fresh_dir)).expect("开空库")),
            ("老库", open(&seed_v7(&legacy_dir)).expect("迁移老库")),
        ];
        for (label, conn) in &cases {
            let names: Vec<String> = conn
                .prepare(
                    "SELECT name FROM sqlite_master
                     WHERE type = 'index' AND tbl_name = 'usage_rollup' ORDER BY name",
                )
                .and_then(|mut s| {
                    s.query_map([], |r| r.get::<_, String>(0))
                        .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
                })
                .expect("读索引名");
            for expected in [
                "ix_rollup_account",
                "ix_rollup_key",
                "ix_rollup_model",
                "ix_rollup_reconcile",
                "ix_rollup_source",
            ] {
                assert!(
                    names.iter().any(|n| n == expected),
                    "{label} 丢了索引 {expected}: {names:?}"
                );
            }
        }
        drop(cases);
        let _ = std::fs::remove_dir_all(&fresh_dir);
        let _ = std::fs::remove_dir_all(&legacy_dir);
    }

    #[test]
    fn price_book_version_is_config_only() {
        let dir = temp_dir("pricebook");
        let conn = open(&ledger_db_path_in(&dir)).expect("开库");
        let cols: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('price_book_version')")
            .and_then(|mut s| {
                s.query_map([], |r| r.get::<_, String>(0))
                    .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
            })
            .expect("读列");
        for expected in [
            "version_id",
            "source",
            "scope",
            "model_id",
            "tier",
            "effective_from",
            "effective_to",
            "input_usd_per_million",
            "cached_input_usd_per_million",
            "output_usd_per_million",
            "session_long_context",
            "note",
            "created_at_ms",
        ] {
            assert!(cols.iter().any(|c| c == expected), "缺列 {expected}: {cols:?}");
        }
        // 唯一索引(同一来源/作用域/模型/档位/生效起点只能一条)
        conn.execute(
            "INSERT INTO price_book_version (source, scope, model_id, tier, effective_from,
                input_usd_per_million, cached_input_usd_per_million, output_usd_per_million, created_at_ms)
             VALUES ('cockpit_builtin', 'global', 'm1', 'standard', 1000, 1.0, 0.1, 4.0, 1)",
            [],
        )
        .expect("首次插入应成功");
        let dup = conn.execute(
            "INSERT INTO price_book_version (source, scope, model_id, tier, effective_from,
                input_usd_per_million, cached_input_usd_per_million, output_usd_per_million, created_at_ms)
             VALUES ('cockpit_builtin', 'global', 'm1', 'standard', 1000, 2.0, 0.2, 8.0, 2)",
            [],
        );
        assert!(dup.is_err(), "ux_price_ver 应阻止重复生效起点");
        assert_eq!(scalar_i64(&conn, "SELECT COUNT(*) FROM price_book_version"), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn account_identity_validity_window_unique_index_enforced() {
        let dir = temp_dir("identity");
        let conn = open(&ledger_db_path_in(&dir)).expect("开库");

        // 唯一索引必须含 valid_from_hour(修正 BUG-2 的核心)
        let sql = index_sql(&conn, "ux_identity_seg");
        assert!(sql.contains("valid_from_hour"), "唯一索引缺 valid_from_hour: {sql}");
        assert!(sql.to_lowercase().contains("unique"), "ux_identity_seg 不是唯一索引: {sql}");

        // PRAGMA table_info 必须能看到时段闭合两列
        let cols: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('account_identity')")
            .and_then(|mut s| {
                s.query_map([], |r| r.get::<_, String>(0))
                    .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
            })
            .expect("读 account_identity 列");
        assert!(cols.iter().any(|c| c == "valid_from_hour"), "缺 valid_from_hour 列: {cols:?}");
        assert!(cols.iter().any(|c| c == "valid_to_hour"), "缺 valid_to_hour 列: {cols:?}");

        let insert = "
            INSERT INTO account_identity (
              source_account_id, client_instance_id, platform, email_norm, email_display,
              official_account_id, is_provider_test, valid_from_hour, valid_to_hour,
              first_seen_ms, last_seen_ms, first_seen_source_id, last_seen_source_id, updated_at_ms
            ) VALUES (?1, ?2, '', ?3, ?3, '', 0, ?4, ?5, 1, 1, 0, 0, 1)";

        let h1 = hour_bucket(1_700_000_000_000);
        let h2 = h1 + HOUR_MS;
        conn.execute(insert, params!["acct-1", "", "a@x.com", h1, Value::Null])
            .expect("首段应插入成功");

        // 同一 (账号, 实例, 邮箱, 起始小时) 插两次 → 必须冲突
        let dup = conn.execute(insert, params!["acct-1", "", "a@x.com", h1, Value::Null]);
        assert!(dup.is_err(), "同一时段重复插入应被唯一索引拒绝");
        let msg = format!("{}", dup.unwrap_err());
        assert!(msg.to_lowercase().contains("unique"), "错误应源于唯一约束: {msg}");

        // 回摆 A→B→A:邮箱换成 B 再换回 A,只要起始小时不同就各占一段(不冲突)
        conn.execute(insert, params!["acct-1", "", "b@x.com", h1 + HOUR_MS, Value::Null])
            .expect("换绑到 B 应成功");
        conn.execute(insert, params!["acct-1", "", "a@x.com", h2 + HOUR_MS, Value::Null])
            .expect("回摆到 A 应成功(新时段)");

        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM account_identity", [], |r| r.get(0))
            .expect("数行数");
        assert_eq!(rows, 3, "A→B→A 应为 3 段:实际 {rows}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ledger_path_is_not_under_cockpit_dir() {
        let path = ledger_db_path().expect("解析账本路径");
        assert!(
            !path
                .components()
                .any(|c| c.as_os_str().eq_ignore_ascii_case(".antigravity_cockpit")),
            "账本绝不能落在 cockpit 目录: {}",
            path.display()
        );
        assert_eq!(
            path.file_name().and_then(|n| n.to_str()),
            Some(LEDGER_DB_FILE_NAME),
            "账本文件名不对: {}",
            path.display()
        );
        assert_ne!(
            path.file_name().and_then(|n| n.to_str()),
            Some(REQUEST_LOG_DB_NAME),
            "账本不得与 cockpit 源库同名"
        );
        // 显式构造一个 cockpit 路径,自检函数必须拒绝
        let cockpit = std::path::PathBuf::from(r"C:\Users\someone\.antigravity_cockpit").join(LEDGER_DB_FILE_NAME);
        assert!(assert_not_cockpit_path(&cockpit).is_err(), "cockpit 路径应被拒绝");
    }

    #[test]
    fn hour_bucket_aligns_to_epoch_hour() {
        assert_eq!(HOUR_MS, 3_600_000);
        assert_eq!(hour_bucket(0), 0);
        assert_eq!(hour_bucket(3_599_999), 0);
        assert_eq!(hour_bucket(3_600_000), 3_600_000);
        assert_eq!(hour_bucket(1_700_000_000_000), 1_699_999_200_000);
        // 负数(脏数据)也必须向下对齐到桶边界,不能向上取整
        assert_eq!(hour_bucket(-1), -3_600_000);
        assert_eq!(hour_bucket(-3_600_000), -3_600_000);
        // 幂等:已对齐的值再算一次不变
        let b = hour_bucket(1_700_000_000_000);
        assert_eq!(hour_bucket(b), b);
    }

    #[test]
    fn migrate_rejects_future_user_version() {
        let dir = temp_dir("future");
        let path = ledger_db_path_in(&dir);
        {
            let conn = open(&path).expect("开库");
            assert_eq!(current_version(&conn).expect("版本"), SCHEMA_VERSION_LATEST);
        }
        // 模拟"用户用更新版本建过库,又退回旧版"
        let mut conn = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .expect("重开");
        conn.pragma_update(None, "user_version", (SCHEMA_VERSION_LATEST as i64) + 1_000)
            .expect("写入未来版本");
        let err = migrate(&mut conn).expect_err("高于已知版本必须报错");
        let msg = format!("{err}");
        assert!(msg.contains("请升级"), "错误提示必须明确要求升级: {msg}");
        assert!(msg.contains(&format!("{}", SCHEMA_VERSION_LATEST + 1_000)), "错误应带实际版本: {msg}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ── 只读打开（2026-09-12 补：读路径不得与后台摄取抢写锁） ──

    #[test]
    fn open_read_only_refuses_to_create_the_db() {
        let dir = temp_dir("ro-missing");
        let path = ledger_db_path_in(&dir);
        assert!(!path.exists(), "前提:库还没建");
        let err = open_read_only(&path).expect_err("只读打开绝不能凭空建库");
        let msg = format!("{err}");
        assert!(msg.contains("账本尚不存在"), "错误要说清是没建库: {msg}");
        assert!(!path.exists(), "失败后也不能留下空库文件");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn open_read_only_on_current_schema_can_select() {
        let dir = temp_dir("ro-ok");
        let path = ledger_db_path_in(&dir);
        {
            let conn = open(&path).expect("建库");
            assert_eq!(current_version(&conn).unwrap(), SCHEMA_VERSION_LATEST);
        }
        let conn = open_read_only(&path).expect("最新版本应能只读打开");
        let tables = user_tables(&conn);
        assert!(tables.contains(&"usage_rollup".to_string()), "应能读到表: {tables:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 版本落后时必须**显式报错**,而不是硬读撞 `no such column`。
    #[test]
    fn open_read_only_reports_outdated_schema_instead_of_hard_reading() {
        let dir = temp_dir("ro-outdated");
        let path = ledger_db_path_in(&dir);
        {
            let conn = open(&path).expect("建库");
            conn.pragma_update(None, "user_version", 1).expect("假装是 v1 老库");
        }
        let err = open_read_only(&path).expect_err("落后版本必须报错");
        let msg = format!("{err}");
        assert!(msg.contains("落后"), "错误要说清是版本落后: {msg}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 回归护栏：**读路径不得抢写锁**。
    ///
    /// 后台定时摄取线程持写事务时，读连接必须照样能打开并 SELECT。
    /// 若哪天有人把 `open_read_only` 改回跑 `migrate()`，这个用例会挂。
    #[test]
    fn open_read_only_works_while_another_thread_holds_a_write_txn() {
        let dir = temp_dir("ro-vs-writer");
        let path = ledger_db_path_in(&dir);
        {
            let conn = open(&path).expect("建库");
            conn.execute_batch("CREATE TABLE _probe (x INTEGER)").expect("探针表");
        }

        // ★ 2026-09-29:这里**不许用 sleep 赌时序**(原实现是 `sleep(250ms)`)。
        //
        //   原实现假设"睡 250ms 写线程必定已持锁"。满套件并发跑时(153 个用例抢 CPU)
        //   `open()` 里的 `migrate()` 要建表建索引,远超 250ms ⇒ 主线程的 `open_read_only`
        //   和写线程的 `open()` **同时初始化 WAL / -shm** ⇒ 写线程拿到
        //   `SQLITE_READONLY: attempt to write a readonly database`(实测 5 轮挂 1 次;
        //   单独跑这条用例机器空闲,10/10 全过 —— 典型的负载相关 flaky)。
        //
        //   改成 channel 精确交接后:读者**确实**在写事务存续期间读(不再是"碰巧"),
        //   且两个 `open()` 永不同时发生。护栏的强度反而提高了。
        //
        //   (附带发现:两条连接并发初始化同一个 WAL 库会拿到 SQLITE_READONLY 而非 BUSY,
        //    所以 `busy_timeout` **兜不住**这种情况。生产侧 ingest 首次 migrate 与 UI 首读
        //    若真撞在同一毫秒,同样会走这条路径 —— 目前概率极低,记在这里不为掩盖。)
        let (locked_tx, locked_rx) = std::sync::mpsc::channel::<()>();
        let (read_done_tx, read_done_rx) = std::sync::mpsc::channel::<()>();

        /// 作用域结束即放行写线程提交 —— 即便中途断言失败也一定放行,否则 join 会永久挂起。
        struct ReleaseOnDrop(std::sync::mpsc::Sender<()>);
        impl Drop for ReleaseOnDrop {
            fn drop(&mut self) {
                let _ = self.0.send(());
            }
        }

        let writer_path = path.clone();
        let writer = std::thread::spawn(move || {
            let mut conn = open(&writer_path).expect("写连接");
            let tx = conn.transaction().expect("起写事务");
            tx.execute_batch("INSERT INTO _probe VALUES (1)")
                .expect("写事务持锁");
            // 持锁事实成立之后才放行读者
            locked_tx.send(()).expect("通知持锁");
            // 读者读完之前绝不提交 ⇒ 读必然落在写事务存续期间
            read_done_rx.recv().expect("等待读者完成");
            tx.commit().expect("提交");
        });

        locked_rx.recv().expect("写线程必须真的持上写锁");

        {
            let _release = ReleaseOnDrop(read_done_tx);
            let conn = open_read_only(&path)
                .expect("后台正在写时,只读打开也必须成功(读路径不得跑 migrate 抢写锁)");
            let n: i64 = conn
                .query_row("SELECT COUNT(*) FROM usage_rollup", [], |r| r.get(0))
                .expect("持锁期间仍能 SELECT");
            assert!(n >= 0);
            // `conn` 先于 `_release` 析构 ⇒ 读锁先释放,写线程提交才不会撞上读者
        }

        writer.join().expect("写线程不该 panic");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
