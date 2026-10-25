//! 账本读取层：**多源合并口径**（PRD P0-15）。
//!
//! # 这个文件为什么存在
//!
//! P0-25 的对账（`ledger_query.rs`）已经出完证据并拍板：两源（`codex_logs` 网关请求 /
//! `codex_sessions` 会话）是**同一批数据的两个采集端**，logs 侧在网关故障/未走网关的日子
//! **漏记**（本机 10 个偏离天全部是 `sessions > logs`，吻合天连续 7 天差异 ≤1%）。
//! 因此合并口径定为：**按「天(UTC) × 模型」格取两源 token 更大的那个源（max），不相加**；
//! 只有单源有数据的天**退回该源**。
//!
//! ⚠️ **取大 ≠ 相加**：相加会把 08-14～08-20 这些吻合天的用量**翻倍**（设计 §1 难点 1）。
//!
//! # 合并只发生在这一层
//!
//! 格数达十万级（天 × 模型 × 账号 × key），前端合并要拉全量明细（内存爆 + 口径散落），
//! 所以合并放在 Rust 只读层，命令 `ledger_merged_usage`。
//!
//! # 红线
//!
//! 1. **只读**：本文件只有 `SELECT`，不出现 `INSERT` / `UPDATE` / `DELETE`。
//! 2. **只存量不存钱**：`MergedCell` **没有任何 cost 字段**，`estimated_cost_usd`
//!    **一律不搬运**（连读都不读）。计价唯一入口是前端
//!    `cockpitSplitCostUsd() × cockpitPriceBook.ts`，合并层只负责"选哪一堆 token"。
//! 3. **两源分档同源同规则，档位质量与 winner 无关**：
//!    摄取层 `RollupAgg::add`(`ledger_ingest.rs`) 对**所有源**统一走 `TokenSplit::add`，
//!    档位判定是 `input > LONG_CONTEXT_THRESHOLD_TOKENS(272_000)`，**与 `source_name` 无关**。
//!    实测两源 long 档占比同量级（logs 22.46% / sessions 19.84%），14 个吻合天逐日重合
//!    （08-20 两边都是 27.57%）。因此**不存在"某个源没有长文本分档"这回事**，
//!    合并层一律**原样沿用胜出源的 6 档位**，既不清零也不重判。
//! 4. **天桶按 UTC**（`hour_bucket / DAY_MS * DAY_MS`）：与 `ledger_query.rs` **同一个表达式**，
//!    否则两层的"天"边界会错位。**不得改成本地时区日**。
//! 5. **源不可用不是 `Err`**：账本未生成 / 窗口内无数据时返回**标注型空值**
//!    （`available=false` + `reason`，或 `available=true` + 空 `cells`），
//!    **绝不静默变 0**。
//! 6. **无观测值不编 0**：`long_ratio_observed` 没有观测到就是 `None`。
//!
//! # ⚠️ 曾经踩过的坑（2026-09-12 QA 复核发现，别再犯）
//!
//! 初版按"来源"硬编码了一个 `graded` 字段：sessions 胜出就标 `graded = false`，
//! 文案写成"长文本档缺失（保守偏低）"。**前提是错的** —— 见上面红线 3。
//! 后果：把"**由会话源补全的量占比**"误报成"**没有分档的量占比**"
//! （本机 22.8B 里实际有 4.9B 带 long 档并已按 ×2/×2/×1.5 计价）。
//! 现在改为 `TierCoverage.sessions_backfilled_*`：**语义是"日志侧漏记、由会话源补上"**，
//! 与档位质量无关。回归用例见 `sessions_winner_keeps_its_own_long_tiers`。
//!
//! # 格内 winner 一致性（关键假设）
//!
//! winner 按「天 × 模型」判定，**同格内所有 account/key 行沿用同一 winner**，
//! 下钻维度（account / key）原样保留（设计 §1 关键假设）。
//! 平手时**取 logs**（logs 是网关请求口径，字段更全：有 error_category / 单价快照）。

use rusqlite::Connection;
use serde::Serialize;
use std::collections::BTreeMap;

use crate::ledger_db;
use crate::ledger_query::DAY_MS;

/// 6 档位 token 向量：标准档 / 长文本档 × 普通输入 / 缓存命中 / 输出。
///
/// **纯量**：这里没有任何金额字段，也不允许有。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TierVector {
    pub std_normal_input: i64,
    pub std_cached: i64,
    pub std_output: i64,
    pub long_normal_input: i64,
    pub long_cached: i64,
    pub long_output: i64,
}

impl TierVector {
    /// 6 档位合计（取大时的比较量）。
    pub fn total(&self) -> i64 {
        self.std_normal_input
            + self.std_cached
            + self.std_output
            + self.long_normal_input
            + self.long_cached
            + self.long_output
    }

    /// 长文本档合计（`long_ratio_observed` 的分子）。
    fn long_total(&self) -> i64 {
        self.long_normal_input + self.long_cached + self.long_output
    }

    fn add(&mut self, other: &TierVector) {
        self.std_normal_input += other.std_normal_input;
        self.std_cached += other.std_cached;
        self.std_output += other.std_output;
        self.long_normal_input += other.long_normal_input;
        self.long_cached += other.long_cached;
        self.long_output += other.long_output;
    }
}

/// 该格**用了哪个源**。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeWinner {
    /// 两源都有，logs 量更大（或平手 —— 平手取 logs，它字段更全）
    Logs,
    /// 两源都有，sessions 量更大 ⇒ logs 侧这天漏记，用会话源补上
    Sessions,
    /// 只有 logs 有数据（sessions 侧断采 / 未覆盖）
    LogsOnly,
    /// 只有 sessions 有数据（logs 侧漏记 / 未覆盖）
    SessionsOnly,
}

impl MergeWinner {
    /// 是否来自 `codex_sessions` 源 —— 决定该格是否算"由会话源补全"。
    ///
    /// ⚠️ 这个判定**只**用于覆盖率统计（"日志侧漏记了多少"），
    /// **绝不能**用来推断档位质量（两源分档同源同规则，见文件头红线 3）。
    fn is_sessions_side(self) -> bool {
        matches!(self, MergeWinner::Sessions | MergeWinner::SessionsOnly)
    }

    /// 人话标签（UI 直接显示）。
    ///
    /// 只在端到端实测（`end_to_end_merged_usage_real_sources`，`--ignored`）里打印用，
    /// 常规构建不引用 —— 前端的中文标签在 `src/api/ledgerMerge.ts` 的 `MERGE_WINNER_LABELS`。
    #[allow(dead_code)]
    pub fn label(self) -> &'static str {
        match self {
            MergeWinner::Logs => "网关请求（logs）",
            MergeWinner::Sessions => "会话（sessions）",
            MergeWinner::LogsOnly => "仅网关请求（logs）",
            MergeWinner::SessionsOnly => "仅会话（sessions）",
        }
    }
}

/// 一个**已合并**的用量格：天(UTC) × 模型 × 账号 × key。
///
/// `tokens` 是**胜出源**在这一行的 6 档位明细 —— **不是两源相加**。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedCell {
    /// UTC 日桶起点（epoch ms）
    pub day_bucket_ms: i64,
    pub model_id: String,
    pub source_account_id: String,
    pub api_key_id: String,
    /// 胜出源的 6 档位 token（**不含任何金额**）
    pub tokens: TierVector,
    pub requests: i64,
    pub success: i64,
    pub error: i64,
    /// 该「天 × 模型」格用了哪个源
    pub winner: MergeWinner,
    /// 两源在该「天 × 模型」格**都有数据**（真正的"取大"格；`false` = 单源覆盖）
    pub both_present: bool,
    /// 该「天 × 模型」格 logs 侧的 token 合计（0 = 该格 logs 无数据，**不是缺失值**）
    pub logs_tokens: i64,
    /// 该「天 × 模型」格 sessions 侧的 token 合计
    pub sessions_tokens: i64,
}

/// 覆盖率汇总：告诉 UI"有多少天的量是靠会话源补上的（日志侧漏记）"。
///
/// ⚠️ 命名与语义（2026-09-12 修正）：这里统计的是**来源补全**，**不是档位质量**。
/// 两源都走同一个分档规则（`TokenSplit::add`，阈值 272_000），sessions 侧的格
/// **同样带 long 档**，成本照常按 ×2/×2/×1.5 计。初版把它叫"未分档"是错的。
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TierCoverage {
    /// **由会话源补全**的天数：该天至少有一个「天 × 模型」格的 winner 来自 sessions
    /// （Sessions / SessionsOnly），即 logs 侧这天漏记或没覆盖
    pub sessions_backfilled_days: i64,
    /// 这些**补全格**的 token 合计。
    ///
    /// 口径说明：同一天里 logs 胜出的格**不计入**（那部分不是"补全"来的）。
    pub sessions_backfilled_tokens: i64,
    /// **合并结果里**的长文本档占比 = `long_total / (std_total + long_total)`。
    ///
    /// 基于**最终合并后的量**算（不是某一侧、也不是只看重叠区），
    /// 因为计价吃的就是这个结果。无数据（分母为 0）时是 `None` —— **不编 0**。
    pub long_ratio_observed: Option<f64>,
}

/// `ledger_merged_usage` 的返回。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedUsageResult {
    pub available: bool,
    /// 不可用原因（标注型空值；可用时 `None`）
    pub reason: Option<String>,
    /// 已合并的格（按天升序、同天按 token 降序）
    pub cells: Vec<MergedCell>,
    pub coverage: TierCoverage,
    /// 有量的首日 / 末日（UTC 日桶）。无数据时不编 0，是 `None`。
    pub window_start_ms: Option<i64>,
    pub window_end_ms: Option<i64>,
}

impl MergedUsageResult {
    /// 标注型空值：账本不可用。**不产出任何 0 填充的格**。
    fn unavailable(reason: impl Into<String>) -> Self {
        MergedUsageResult {
            available: false,
            reason: Some(reason.into()),
            cells: Vec::new(),
            coverage: TierCoverage {
                sessions_backfilled_days: 0,
                sessions_backfilled_tokens: 0,
                long_ratio_observed: None,
            },
            window_start_ms: None,
            window_end_ms: None,
        }
    }
}

/// 一条 `(天, 模型, 源, 账号, key)` 的原始聚合行。
struct RawRow {
    day: i64,
    model_id: String,
    source_name: String,
    account: String,
    key: String,
    tokens: TierVector,
    requests: i64,
    success: i64,
    error: i64,
}

/// 扫描窗口内按 `(天, 模型, 源, 账号, key)` 聚合。
///
/// 天桶表达式与 `ledger_query::scan_by_day_model` **逐字符相同**
/// （`(hour_bucket / DAY_MS) * DAY_MS`）—— 两层的"天"必须是同一个天。
fn scan(
    conn: &Connection,
    start_ms: Option<i64>,
    end_ms: Option<i64>,
) -> Result<Vec<RawRow>, String> {
    let sql = "
        SELECT (hour_bucket / ?1) * ?1 AS day_bucket,
               model_id,
               source_name,
               source_account_id,
               api_key_id,
               COALESCE(SUM(std_normal_input), 0),
               COALESCE(SUM(std_cached), 0),
               COALESCE(SUM(std_output), 0),
               COALESCE(SUM(long_normal_input), 0),
               COALESCE(SUM(long_cached), 0),
               COALESCE(SUM(long_output), 0),
               COALESCE(SUM(requests), 0),
               COALESCE(SUM(success), 0),
               COALESCE(SUM(error), 0)
        FROM usage_rollup
        WHERE hour_bucket >= ?2 AND hour_bucket <= ?3
        GROUP BY day_bucket, model_id, source_name, source_account_id, api_key_id";
    let mut stmt = conn.prepare(sql).map_err(|e| format!("合并查询失败: {e}"))?;
    let lo = start_ms.unwrap_or(i64::MIN);
    let hi = end_ms.unwrap_or(i64::MAX);
    let rows = stmt
        .query_map(rusqlite::params![DAY_MS, lo, hi], |row| {
            Ok(RawRow {
                day: row.get::<_, i64>(0)?,
                model_id: row.get::<_, String>(1)?,
                source_name: row.get::<_, String>(2)?,
                account: row.get::<_, String>(3).unwrap_or_default(),
                key: row.get::<_, String>(4).unwrap_or_default(),
                tokens: TierVector {
                    std_normal_input: row.get::<_, i64>(5).unwrap_or(0),
                    std_cached: row.get::<_, i64>(6).unwrap_or(0),
                    std_output: row.get::<_, i64>(7).unwrap_or(0),
                    long_normal_input: row.get::<_, i64>(8).unwrap_or(0),
                    long_cached: row.get::<_, i64>(9).unwrap_or(0),
                    long_output: row.get::<_, i64>(10).unwrap_or(0),
                },
                requests: row.get::<_, i64>(11).unwrap_or(0),
                success: row.get::<_, i64>(12).unwrap_or(0),
                error: row.get::<_, i64>(13).unwrap_or(0),
            })
        })
        .map_err(|e| format!("合并查询失败: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取合并行失败: {e}"))?;
    Ok(rows)
}

/// 单源在一个「天 × 模型」格里的合计。
#[derive(Default, Clone, Copy)]
struct Side {
    tokens: TierVector,
    requests: i64,
    success: i64,
    error: i64,
}

/// 一个「天 × 模型」格：两源各自合计 + 各自的下钻行下标。
#[derive(Default)]
struct Cell {
    logs: Option<Side>,
    sessions: Option<Side>,
    logs_rows: Vec<usize>,
    sessions_rows: Vec<usize>,
}

/// 多源合并（PRD P0-15）：按「天 × 模型」取两源 token 更大的那个源。
///
/// `window_days` 为 `None` = 全量（不设时间过滤）。
pub fn merged_usage(
    conn: &Connection,
    window_days: Option<i64>,
) -> Result<MergedUsageResult, String> {
    // 窗口起点 = 现在 − N 天（按 UTC 日对齐，与天桶同口径；与 ledger_query::reconcile 同式）
    let end_ms = ledger_db::now_ms();
    let start_ms = window_days
        .filter(|d| *d > 0)
        .map(|d| (end_ms / DAY_MS) * DAY_MS - (d - 1) * DAY_MS);

    let rows = scan(conn, start_ms, None)?;
    if rows.is_empty() {
        // 空账本不是"不可用"，是"没有数据" —— 如实标注，不产出 0 填充的格
        return Ok(MergedUsageResult {
            available: true,
            reason: Some("账本里没有用量数据（尚未摄取，或窗口内无请求）".to_string()),
            cells: Vec::new(),
            coverage: TierCoverage {
                sessions_backfilled_days: 0,
                sessions_backfilled_tokens: 0,
                long_ratio_observed: None,
            },
            window_start_ms: None,
            window_end_ms: None,
        });
    }

    // ── 透视：(day, model) → 两源 ──
    let mut grid: BTreeMap<(i64, String), Cell> = BTreeMap::new();
    for (idx, row) in rows.iter().enumerate() {
        let is_logs = row.source_name == ledger_db::SOURCE_CODEX_LOGS;
        let is_sessions = row.source_name == ledger_db::SOURCE_CODEX_SESSIONS;
        if !is_logs && !is_sessions {
            // 未来的第三源不参与两源合并（与 ledger_query 同处理），也不静默丢掉：
            // 这里跳过即不产出格，账本里的数据仍在，等口径扩展时再定。
            continue;
        }
        let e = grid.entry((row.day, row.model_id.clone())).or_default();
        let side = if is_sessions {
            e.sessions.get_or_insert_default()
        } else {
            e.logs.get_or_insert_default()
        };
        side.tokens.add(&row.tokens);
        side.requests += row.requests;
        side.success += row.success;
        side.error += row.error;
        if is_sessions {
            e.sessions_rows.push(idx);
        } else {
            e.logs_rows.push(idx);
        }
    }

    let mut cells: Vec<MergedCell> = Vec::new();
    // 逐天累计：该天总 token / 其中"由会话源补全"的 token
    let mut per_day: BTreeMap<i64, (i64, i64)> = BTreeMap::new();
    // long_ratio_observed：基于**合并结果**算（计价吃的就是这个结果）
    let mut long_sum = 0i64;
    let mut long_denom = 0i64;

    for ((day, model_id), c) in grid {
        let both_present = c.logs.is_some() && c.sessions.is_some();
        // 取大：平手时取 logs（网关请求口径，字段更全）
        let (winner, chosen, row_idx): (MergeWinner, Side, &Vec<usize>) = match (&c.logs, &c.sessions) {
            (Some(l), Some(s)) => {
                if l.tokens.total() >= s.tokens.total() {
                    (MergeWinner::Logs, *l, &c.logs_rows)
                } else {
                    (MergeWinner::Sessions, *s, &c.sessions_rows)
                }
            }
            (Some(l), None) => (MergeWinner::LogsOnly, *l, &c.logs_rows),
            (None, Some(s)) => (MergeWinner::SessionsOnly, *s, &c.sessions_rows),
            (None, None) => continue,
        };
        // ⚠️ 只用于"来源补全"统计，与档位质量无关（两源档位同源同规则）
        let backfilled = winner.is_sessions_side();
        let logs_tokens = c.logs.map(|l| l.tokens.total()).unwrap_or(0);
        let sessions_tokens = c.sessions.map(|s| s.tokens.total()).unwrap_or(0);

        // 胜出源的 6 档位**原样**进 long_ratio，既不按来源清零也不重判
        long_sum += chosen.tokens.long_total();
        long_denom += chosen.tokens.total();

        let day_entry = per_day.entry(day).or_insert((0, 0));
        day_entry.0 += chosen.tokens.total();
        if backfilled {
            day_entry.1 += chosen.tokens.total();
        }

        for &i in row_idx {
            let r = &rows[i];
            cells.push(MergedCell {
                day_bucket_ms: day,
                model_id: model_id.clone(),
                source_account_id: r.account.clone(),
                api_key_id: r.key.clone(),
                tokens: r.tokens,
                requests: r.requests,
                success: r.success,
                error: r.error,
                winner,
                both_present,
                logs_tokens,
                sessions_tokens,
            });
        }
    }

    // 补全天 = 该天至少有一个格由 sessions 补上；补全 token = 这些**补全格**的合计
    let mut sessions_backfilled_days = 0i64;
    let mut sessions_backfilled_tokens = 0i64;
    for backfilled_tok in per_day.values().map(|(_, backfilled)| backfilled) {
        if *backfilled_tok > 0 {
            sessions_backfilled_days += 1;
            sessions_backfilled_tokens += *backfilled_tok;
        }
    }

    let long_ratio_observed = if long_denom > 0 {
        Some(long_sum as f64 / long_denom as f64)
    } else {
        None
    };

    // 窗口端点：只认"有量"的天，不编 0
    let mut days_with_tokens: Vec<i64> = per_day
        .iter()
        .filter(|(_, (day_total, _))| *day_total > 0)
        .map(|(d, _)| *d)
        .collect();
    days_with_tokens.sort_unstable();
    let window_start_ms = days_with_tokens.first().copied();
    let window_end_ms = days_with_tokens.last().copied();

    cells.sort_by(|a, b| {
        a.day_bucket_ms
            .cmp(&b.day_bucket_ms)
            .then(b.tokens.total().cmp(&a.tokens.total()))
            .then(a.model_id.cmp(&b.model_id))
            .then(a.source_account_id.cmp(&b.source_account_id))
            .then(a.api_key_id.cmp(&b.api_key_id))
    });

    Ok(MergedUsageResult {
        available: true,
        reason: None,
        cells,
        coverage: TierCoverage {
            sessions_backfilled_days,
            sessions_backfilled_tokens,
            long_ratio_observed,
        },
        window_start_ms,
        window_end_ms,
    })
}

// =============================================================================
// Tauri 命令
// =============================================================================

/// 多源合并用量（PRD P0-15）。`window_days` 为 `None` = 全量。
///
/// **只返量不返钱**：`MergedCell` 里没有任何金额字段。
#[tauri::command]
pub async fn ledger_merged_usage(window_days: Option<i64>) -> Result<MergedUsageResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = ledger_db::ledger_db_path().map_err(|e| e.to_string())?;
        // 账本文件还不存在 = 尚未摄取，如实报不可用（不是 Err）
        if !path.exists() {
            return Ok(MergedUsageResult::unavailable(format!(
                "账本尚未生成（{}），请先让成本中心完成一次摄取",
                path.display()
            )));
        }
        // 只读打开:同 ledger_query,避免读路径跑 migrate 与后台摄取抢写锁
        let conn = ledger_db::open_read_only(&path).map_err(|e| e.to_string())?;
        merged_usage(&conn, window_days)
    })
    .await
    .map_err(|e| format!("合并用量任务异常结束: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger_ingest;
    use rusqlite::params;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "console2api-merge-{tag}-{}-{}",
            std::process::id(),
            ledger_db::now_ms()
        ));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    fn ledger_conn(dir: &std::path::Path) -> Connection {
        ledger_db::open(&ledger_db::ledger_db_path_in(dir)).expect("开账本")
    }

    /// 插一条 usage_rollup 行（6 档位可逐一指定）。
    #[allow(clippy::too_many_arguments)]
    fn insert_rollup(
        conn: &Connection,
        hour_bucket: i64,
        source_name: &str,
        model_id: &str,
        tokens: TierVector,
        requests: i64,
    ) {
        conn.execute(
            "INSERT INTO usage_rollup (hour_bucket, source_name, source_account_id, model_id,
                api_key_id, client_instance_id, std_normal_input, std_cached, std_output,
                long_normal_input, long_cached, long_output, requests, success, error, updated_at_ms)
             VALUES (?1,?2,'acct',?3,'','',?4,?5,?6,?7,?8,?9,?10,?10,0,?11)",
            params![
                hour_bucket,
                source_name,
                model_id,
                tokens.std_normal_input,
                tokens.std_cached,
                tokens.std_output,
                tokens.long_normal_input,
                tokens.long_cached,
                tokens.long_output,
                requests,
                ledger_db::now_ms(),
            ],
        )
        .expect("插 usage_rollup");
    }

    fn day(n: i64) -> i64 {
        // 以 NOW 所在 UTC 日为基准往前 n 天
        (ledger_db::now_ms() / DAY_MS) * DAY_MS - n * DAY_MS
    }

    fn std_vec(normal: i64, cached: i64, output: i64) -> TierVector {
        TierVector { std_normal_input: normal, std_cached: cached, std_output: output, ..Default::default() }
    }

    fn cell_tokens_sum(cells: &[MergedCell]) -> i64 {
        cells.iter().map(|c| c.tokens.total()).sum()
    }

    // ── 会话源夹具：**走真实摄取链路**造数 ──────────────────────────────────
    //
    // 为什么不能只用手插 `usage_rollup`：那样证明的是"我插的数据长什么样"，
    // 而合并层要证明的是"真实摄取后的档位有没有被保留"。
    // 表结构与 `ledger_ingest` 的 SESSION_DDL 一致（本机 cockpit 会话库实测结构）。

    /// cockpit 会话用量库真实表结构（秒级 timestamp / `model` / `cached_input_tokens`）。
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

    fn seed_session_source(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
        let path = dir.join(name);
        let src = Connection::open(&path).expect("建会话源库");
        src.execute_batch(SESSION_DDL).expect("建会话表");
        drop(src);
        path
    }

    fn open_source(path: &std::path::Path) -> Connection {
        Connection::open(path).expect("打开源库写入")
    }

    /// 会话源定位（与 `IngestSource::codex_sessions()` 同配置：复合水位 / 秒级 / 按成功计入）。
    fn session_source_of(path: &std::path::Path) -> ledger_ingest::IngestSource {
        let mut source =
            ledger_ingest::IngestSource::sqlite(path, "session_usage_events", "timestamp", "timestamp");
        source.source_name = ledger_db::SOURCE_CODEX_SESSIONS.to_string();
        source.ts_unit = ledger_ingest::TsUnit::Seconds;
        // 复合水位 (timestamp, request_id):不用 rowid(重建/VACUUM 会重排行值)
        source.id_columns = vec!["timestamp".to_string(), "request_id".to_string()];
        source.instance_identity = Some(ledger_ingest::InstanceIdentity {
            platform: "codex".to_string(),
            column: "instance_name".to_string(),
        });
        source.success_when_column_absent = Some(true);
        source.label = "合并层测试会话源".to_string();
        source
    }

    /// 插一条会话源行。
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
             VALUES (?1,?2,'默认实例',?3,?4,?5,?6,?7,?8,'/tmp/rollout-x.jsonl')",
            params![
                format!("sess-{seq}"),
                instance_id,
                format!("sess-{seq}"),
                model,
                ts_secs,
                input,
                cached,
                output,
            ],
        )
        .expect("插会话行");
    }

    /// **红线 ①：两源吻合的日子取大后 = 单源值，绝不翻倍。**
    ///
    /// 本机 08-14～08-20 连续 7 天两源差异 ≤1%（08-20 精确到 0）。
    /// 若误写成"相加"，这些天的用量会直接翻倍 —— 这是本次口径最危险的错法。
    #[test]
    fn merge_takes_max_not_sum_when_sources_agree() {
        let dir = temp_dir("agree");
        let conn = ledger_conn(&dir);
        // 同一天、同一模型、两个小时桶：两源完全吻合（源内跨小时是**相加**，跨源才是取大）
        let t = std_vec(600, 200, 200); // 每小时合计 1_000
        insert_rollup(&conn, day(1), "codex_logs", "m-a", t, 10);
        insert_rollup(&conn, day(1), "codex_sessions", "m-a", t, 10);
        insert_rollup(&conn, day(1) + 3_600_000, "codex_logs", "m-a", t, 10);
        insert_rollup(&conn, day(1) + 3_600_000, "codex_sessions", "m-a", t, 10);

        let r = merged_usage(&conn, None).expect("合并成功");
        assert!(r.available);
        assert_eq!(r.cells.len(), 1, "（天 × 模型 × 账号 × key）只有一格");
        assert_eq!(cell_tokens_sum(&r.cells), 2_000, "取大 = 2,000；跨源相加会成 4,000");
        for c in &r.cells {
            // 源内跨小时相加（1_000 × 2 小时 = 2_000）；跨源仍然只取一个源
            assert_eq!(
                c.tokens,
                TierVector { std_normal_input: 1_200, std_cached: 400, std_output: 400, ..Default::default() },
                "沿用胜出源的 6 档位明细，不是两源档位相加",
            );
            assert!(c.both_present);
            assert_eq!(c.winner, MergeWinner::Logs, "平手取 logs（网关口径字段更全）");
            assert_eq!(c.logs_tokens, 2_000);
            assert_eq!(c.sessions_tokens, 2_000);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **红线 ②：只有单源有数据的天退回该源**（不产出"取大失败"的空值，也不丢量）。
    ///
    /// 本机两种情形都有：09-01～09-11 只有 logs（sessions 断采），
    /// 03-07～07-28 只有 sessions（logs 未覆盖）。
    #[test]
    fn merge_falls_back_to_the_only_source_that_has_data() {
        let dir = temp_dir("single");
        let conn = ledger_conn(&dir);
        // day(1)：只有 logs
        insert_rollup(&conn, day(1), "codex_logs", "m-a", std_vec(500, 0, 0), 5);
        // day(5)：只有 sessions
        insert_rollup(&conn, day(5), "codex_sessions", "m-b", std_vec(7_000, 0, 0), 70);

        let r = merged_usage(&conn, None).expect("合并成功");
        assert_eq!(r.cells.len(), 2);
        let logs_only = r.cells.iter().find(|c| c.day_bucket_ms == day(1)).unwrap();
        assert_eq!(logs_only.winner, MergeWinner::LogsOnly);
        assert!(!logs_only.both_present);
        assert_eq!(logs_only.tokens.total(), 500, "单源天如实用该源的值");
        assert_eq!(logs_only.sessions_tokens, 0, "sessions 在该格无数据（事实 0，不是缺失值）");

        let sess_only = r.cells.iter().find(|c| c.day_bucket_ms == day(5)).unwrap();
        assert_eq!(sess_only.winner, MergeWinner::SessionsOnly);
        assert!(!sess_only.both_present);
        assert_eq!(sess_only.tokens.total(), 7_000);
        assert_eq!(sess_only.logs_tokens, 0);
        // 会话源补全：该天计入 sessions_backfilled_*（语义是"日志侧漏记"，不是"没分档"）
        assert_eq!(r.coverage.sessions_backfilled_days, 1);
        assert_eq!(r.coverage.sessions_backfilled_tokens, 7_000);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **红线 ③：源不可用时不产出 0 填充的格。**
    ///
    /// 空账本 / 无数据的窗口必须是"标注型空值 + 空 cells"，
    /// 一个 0 填充的格都不能有 —— 0 会被下游当成"真的用量为 0"。
    #[test]
    fn merge_emits_no_zero_filled_cells_when_there_is_no_data() {
        let dir = temp_dir("nodata");
        let conn = ledger_conn(&dir);

        let empty = merged_usage(&conn, None).expect("空账本不应 Err");
        assert!(empty.available, "空账本不是'不可用'，是'没数据'");
        assert!(empty.cells.is_empty(), "绝不产出 0 填充的格");
        assert!(empty.reason.is_some(), "必须给出人话原因: {:?}", empty.reason);
        assert!(empty.window_start_ms.is_none(), "无数据时不编 0 端点");
        assert!(empty.window_end_ms.is_none());
        assert!(empty.coverage.long_ratio_observed.is_none(), "无观测 ⇒ None,不是 0");
        assert_eq!(empty.coverage.sessions_backfilled_days, 0);

        // 窗口内无数据（数据都在 40 天前）同样是空 cells，不是 0 填充
        insert_rollup(&conn, day(40), "codex_logs", "m-old", std_vec(1, 1, 1), 1);
        insert_rollup(&conn, day(40), "codex_sessions", "m-old", std_vec(1, 1, 1), 1);
        let win = merged_usage(&conn, Some(7)).expect("窗口合并成功");
        assert!(win.cells.is_empty(), "7 天窗口内无数据 ⇒ 空 cells");
        assert!(win.window_start_ms.is_none());

        // 单源天只产出该源的行，另一侧不产出 0 行
        insert_rollup(&conn, day(1), "codex_sessions", "m-new", std_vec(9, 0, 0), 1);
        let one = merged_usage(&conn, Some(7)).expect("窗口合并成功");
        assert_eq!(one.cells.len(), 1, "只有 sessions 有数据 ⇒ 只产出 1 行，没有 logs 的 0 行");
        assert_eq!(one.cells[0].winner, MergeWinner::SessionsOnly);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **红线 ④（2026-09-12 修正）：sessions 胜出的格必须**原样保留它自己的 long 档**。**
    ///
    /// 初版在这里断言 `long_* == 0`，但夹具是手插的纯 std 向量 —— 证明的只是"我插的数据
    /// 没有 long 档"，不是"真实 sessions 源没有长文本分档"。**正是这层壳掩盖了
    /// 「graded 按来源硬编码」这个 bug。**
    ///
    /// 现在走**真实摄取链路**造数：插 `input_tokens = 300_000 > 272_000` 的会话行，
    /// 由 `RollupAgg::add → TokenSplit::add` 判档（与所有源同一规则），
    /// 再断言合并层**没有把档位清零**。
    #[test]
    fn sessions_winner_keeps_its_own_long_tiers() {
        let dir = temp_dir("sess-keeps-tiers");
        let mut conn = ledger_conn(&dir);
        // 会话源：**真实摄取**（input 300_000 > 272_000 ⇒ 长文本档）
        let sess_path = seed_session_source(&dir, "sess.sqlite");
        {
            let src = open_source(&sess_path);
            let base = day(1) / 1000; // 秒级时间戳，落在 day(1) 这个 UTC 日里
            insert_session(&src, 1, base + 10, "m-a", "__default__", 300_000, 50_000, 1_000);
            insert_session(&src, 2, base + 20, "m-a", "__default__", 1_000, 200, 300);
        }
        let now = ledger_db::now_ms();
        let r_ingest = ledger_ingest::ingest_into(
            &mut conn,
            &session_source_of(&sess_path),
            &ledger_ingest::IngestOptions::default(),
            now,
        )
        .expect("摄 sessions");
        assert_eq!(r_ingest.scanned_rows, 2, "两条会话行都应被摄取");
        // logs 侧用手插行（1_000 < 302_300）⇒ sessions 胜出
        insert_rollup(&conn, day(1), "codex_logs", "m-a", std_vec(1_000, 0, 0), 10);

        let r = merged_usage(&conn, None).expect("合并成功");
        assert_eq!(r.cells.len(), 1);
        let c = &r.cells[0];
        assert_eq!(c.winner, MergeWinner::Sessions, "sessions 量更大 ⇒ 由会话源补全");
        assert!(c.both_present);
        // ★ 关键断言：长文本档**必须保留**，不得因为来源是 sessions 就清零
        assert_eq!(c.tokens.long_normal_input, 250_000, "300_000 − cached 50_000");
        assert_eq!(c.tokens.long_cached, 50_000);
        assert_eq!(c.tokens.long_output, 1_000);
        assert_eq!(c.tokens.std_normal_input, 800, "1_000 − cached 200");
        assert_eq!(c.tokens.std_cached, 200);
        assert_eq!(c.tokens.std_output, 300);
        assert_eq!(c.tokens.total(), 302_300, "沿用 sessions 的 6 档位明细");
        assert_eq!(c.logs_tokens, 1_000);
        // long_ratio 基于**合并结果**：301_000 / 302_300
        let ratio = r.coverage.long_ratio_observed.expect("有量就有占比");
        assert!((ratio - 301_000.0 / 302_300.0).abs() < 1e-12, "实际 {ratio}");
        assert_eq!(r.coverage.sessions_backfilled_days, 1);
        assert_eq!(r.coverage.sessions_backfilled_tokens, 302_300);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **回归（防 Bug 1 复发）**：单源会话天（`SessionsOnly`）同样保留 long 档。
    ///
    /// 本机 03-07～07-28 这 30 天正是这种情形 —— 它们**不是"没分档"**，
    /// 会话源自己的 long 档占比实测 19.84%，与 logs 侧同量级。
    #[test]
    fn sessions_only_cells_keep_long_tiers_after_ingest() {
        let dir = temp_dir("sess-only-tiers");
        let mut conn = ledger_conn(&dir);
        let sess_path = seed_session_source(&dir, "sess.sqlite");
        {
            let src = open_source(&sess_path);
            let base = day(3) / 1000;
            insert_session(&src, 1, base + 10, "m-b", "__default__", 300_000, 0, 2_000);
        }
        ledger_ingest::ingest_into(
            &mut conn,
            &session_source_of(&sess_path),
            &ledger_ingest::IngestOptions::default(),
            ledger_db::now_ms(),
        )
        .expect("摄 sessions");

        let r = merged_usage(&conn, None).expect("合并成功");
        assert_eq!(r.cells.len(), 1);
        let c = &r.cells[0];
        assert_eq!(c.winner, MergeWinner::SessionsOnly);
        assert_eq!(c.tokens.long_normal_input, 300_000, "会话源的长文本档必须原样带出");
        assert_eq!(c.tokens.long_output, 2_000);
        assert_eq!(c.tokens.long_total(), 302_000);
        // 覆盖率：这是"补全"，不是"未分档"
        assert_eq!(r.coverage.sessions_backfilled_days, 1);
        assert_eq!(r.coverage.sessions_backfilled_tokens, 302_000);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 平手时取 logs（网关请求口径，字段更全：有 error_category / 单价快照）。
    #[test]
    fn tie_prefers_the_logs_side() {
        let dir = temp_dir("tie");
        let conn = ledger_conn(&dir);
        insert_rollup(&conn, day(1), "codex_logs", "m-a", std_vec(1_000, 0, 0), 10);
        insert_rollup(&conn, day(1), "codex_sessions", "m-a", std_vec(1_000, 0, 0), 10);
        let r = merged_usage(&conn, None).expect("合并成功");
        assert_eq!(r.cells[0].winner, MergeWinner::Logs, "平手取 logs");
        assert_eq!(r.coverage.sessions_backfilled_days, 0, "logs 胜出 ⇒ 不算补全");
    }

    /// `long_ratio_observed` 基于**合并结果**算：有量就有值（哪怕真的是 0.0），
    /// **只有"根本没有量"才是 `None`** —— 不编 0，也不把"有量无 long"伪装成"无观测"。
    #[test]
    fn long_ratio_is_measured_on_the_merged_result() {
        let dir = temp_dir("ratio");
        let conn = ledger_conn(&dir);
        // 全标准档 ⇒ 占比确实是 0.0（这是**测出来的** 0，不是编的）
        insert_rollup(&conn, day(1), "codex_logs", "m-a", std_vec(1_000, 0, 0), 10);
        let r = merged_usage(&conn, None).expect("合并成功");
        assert_eq!(r.coverage.long_ratio_observed, Some(0.0), "有量无 long ⇒ 0.0，不是 None");

        // 只有 sessions 有数据也一样（与来源无关）
        let dir2 = temp_dir("ratio2");
        let conn2 = ledger_conn(&dir2);
        insert_rollup(
            &conn2,
            day(1),
            "codex_sessions",
            "m-a",
            TierVector { std_normal_input: 750, long_normal_input: 250, ..Default::default() },
            10,
        );
        let r2 = merged_usage(&conn2, None).expect("合并成功");
        assert_eq!(r2.coverage.long_ratio_observed, Some(0.25), "sessions 格的 long 档照常计入");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&dir2);
    }

    /// 覆盖率：一天里只要有一个格由 sessions 补上 ⇒ 该天计入 `sessions_backfilled_days`；
    /// token 只算**这些补全格**（同天 logs 胜出的格不算"补全"）。
    #[test]
    fn coverage_counts_days_backfilled_by_sessions() {
        let dir = temp_dir("coverage");
        let conn = ledger_conn(&dir);
        // day(1)：logs 胜出（不算补全）
        insert_rollup(&conn, day(1), "codex_logs", "m-a", std_vec(1_000, 0, 0), 10);
        insert_rollup(&conn, day(1), "codex_sessions", "m-a", std_vec(900, 0, 0), 9);
        // day(2)：m-a 走 logs；m-b 只有 sessions ⇒ 该天算补全天，补全量只算 m-b
        insert_rollup(&conn, day(2), "codex_logs", "m-a", std_vec(1_000, 0, 0), 10);
        insert_rollup(&conn, day(2), "codex_logs", "m-b", std_vec(500, 0, 0), 5);
        insert_rollup(&conn, day(2), "codex_sessions", "m-b", std_vec(4_000, 0, 0), 40);

        let r = merged_usage(&conn, None).expect("合并成功");
        assert_eq!(r.coverage.sessions_backfilled_days, 1, "只有 day(2) 含补全格");
        assert_eq!(r.coverage.sessions_backfilled_tokens, 4_000, "只算 sessions 补上的那一格");
        assert_eq!(r.window_start_ms, Some(day(2)));
        assert_eq!(r.window_end_ms, Some(day(1)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 窗口按 UTC 日过滤（与 `ledger_query::reconcile` 同式，不碰本地时区）。
    #[test]
    fn merge_window_days_filters_by_utc_day() {
        let dir = temp_dir("window");
        let conn = ledger_conn(&dir);
        insert_rollup(&conn, day(1), "codex_logs", "m-a", std_vec(1_000, 0, 0), 10);
        insert_rollup(&conn, day(1), "codex_sessions", "m-a", std_vec(1_000, 0, 0), 10);
        insert_rollup(&conn, day(40), "codex_logs", "m-old", std_vec(9, 0, 0), 1);
        insert_rollup(&conn, day(40), "codex_sessions", "m-old", std_vec(9, 0, 0), 1);

        let r = merged_usage(&conn, Some(7)).expect("合并成功");
        assert!(
            r.cells.iter().all(|c| c.model_id == "m-a"),
            "7 天窗口不得包含 40 天前的数据: {:?}",
            r.cells.iter().map(|c| &c.model_id).collect::<Vec<_>>()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **端到端：用本机真实的两源数据跑合并口径（P0-15 的实测交付物）。**
    ///
    /// 手动验证命令（会话源补全天数 / token、合并后 long 档占比从这来，
    /// 决定资产总览总额何时切换）：
    /// ```bash
    /// cd src-tauri
    /// cargo test --bin console2api end_to_end_merged_usage_real_sources -- --ignored --nocapture
    /// ```
    /// 它把两个真实 cockpit 源都摄进**临时账本**（不碰生产账本），再跑合并并打印覆盖率。
    #[test]
    #[ignore = "手动端到端:依赖本机真实 cockpit 数据,见文档注释"]
    fn end_to_end_merged_usage_real_sources() {
        let logs = match ledger_ingest::IngestSource::codex_logs() {
            Ok(s) => s,
            Err(e) => {
                println!("跳过:无法定位单请求库({e})");
                return;
            }
        };
        let sessions = match ledger_ingest::IngestSource::codex_sessions() {
            Ok(s) => s,
            Err(e) => {
                println!("跳过:无法定位会话库({e})");
                return;
            }
        };
        if !logs.db_path.exists() || !sessions.db_path.exists() {
            println!("跳过:源库不存在");
            return;
        }

        let dir = temp_dir("merge-e2e");
        let mut conn = ledger_conn(&dir);
        let opts = ledger_ingest::IngestOptions::default();
        let now = ledger_db::now_ms();
        for src in [&logs, &sessions] {
            let r = ledger_ingest::ingest_into(&mut conn, src, &opts, now)
                .unwrap_or_else(|e| panic!("摄取 {} 失败: {e}", src.source_name));
            println!("摄取 {}: 扫描 {} 行 / 写桶 {}", src.source_name, r.scanned_rows, r.upserted_buckets);
        }

        let m = merged_usage(&conn, None).expect("合并成功");
        let c = m.coverage;
        println!("\n──── 合并口径实测（按天 × 模型取大）────");
        println!(
            "窗口: {}..{}",
            m.window_start_ms.map(crate::ledger_query::format_day).unwrap_or_else(|| "—".into()),
            m.window_end_ms.map(crate::ledger_query::format_day).unwrap_or_else(|| "—".into()),
        );
        println!("格数: {}", m.cells.len());
        println!(
            "会话源补全: {} 天 / {} token · 合并后 long 档占比 {}",
            c.sessions_backfilled_days,
            c.sessions_backfilled_tokens,
            c.long_ratio_observed
                .map(|d| format!("{:.2}%", d * 100.0))
                .unwrap_or_else(|| "无数据".into()),
        );
        let total: i64 = m.cells.iter().map(|x| x.tokens.total()).sum();
        let long_total: i64 = m.cells.iter().map(|x| x.tokens.long_total()).sum();
        println!("合并后 token 合计: {total}（其中 long 档 {long_total}）");
        // 两源侧各自的 long 占比（交叉验证"档位与来源无关"）
        for source in [ledger_db::SOURCE_CODEX_LOGS, ledger_db::SOURCE_CODEX_SESSIONS] {
            let (l, t): (i64, i64) = conn
                .query_row(
                    "SELECT COALESCE(SUM(long_normal_input + long_cached + long_output), 0),
                            COALESCE(SUM(std_normal_input + std_cached + std_output
                                       + long_normal_input + long_cached + long_output), 0)
                     FROM usage_rollup WHERE source_name = ?1",
                    rusqlite::params![source],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .expect("按源汇总档位");
            println!(
                "  {source} 落库 long 占比: {}",
                if t > 0 { format!("{:.2}%", l as f64 / t as f64 * 100.0) } else { "无数据".into() },
            );
        }
        let mut by_winner: BTreeMap<&str, (i64, i64, i64)> = BTreeMap::new();
        for cell in &m.cells {
            let e = by_winner.entry(cell.winner.label()).or_insert((0, 0, 0));
            e.0 += 1;
            e.1 += cell.tokens.total();
            e.2 += cell.tokens.long_total();
        }
        for (label, (n, tok, long)) in by_winner {
            println!(
                "  {label}: {n} 格 / {tok} token（其中 long 档 {long}，占 {:.2}%）",
                if tok > 0 { long as f64 / tok as f64 * 100.0 } else { 0.0 },
            );
        }
        println!("\n由会话源补全的天（logs 侧漏记）:");
        let mut backfilled_days: BTreeMap<i64, i64> = BTreeMap::new();
        for cell in m.cells.iter().filter(|x| x.winner.is_sessions_side()) {
            *backfilled_days.entry(cell.day_bucket_ms).or_insert(0) += cell.tokens.total();
        }
        for (d, tok) in backfilled_days.iter().take(80) {
            println!("  {}  {} token", crate::ledger_query::format_day(*d), tok);
        }

        assert!(m.available);
        assert!(!m.cells.is_empty(), "真实两源应有合并明细");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
