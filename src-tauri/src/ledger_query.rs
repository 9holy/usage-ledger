//! 账本读取层：**多源对账**（PRD P0-25）+ 源清单（架构 T12 子项 10）。
//!
//! # 这个文件为什么存在
//!
//! 账本已经能分源落库（`codex_logs` + `codex_sessions`），但**读取层刻意不合并**：
//! 用户拍板"**先对账再定**"，合并口径（P0-15）**被本项阻塞**。
//! 本文件的唯一职责就是**出证据** —— 按 `(天, 模型)` 并列两源 token，算出差额，
//! 给出"同一批 / 不同批次"的**可复核**结论，交给用户拍板 A / B / 分段相加。
//!
//! # 红线
//!
//! 1. **只读**：本文件只有 `SELECT`，不出现 `INSERT` / `UPDATE` / `DELETE`。
//! 2. **不合并**：不产出任何"总额"。两源数字**永远并列**，合并是 P0-15 的事，
//!    且必须等用户拍板后才实现（PRD §5.5 执行顺序是硬性的）。
//! 3. **零乘法**：本文件不做任何计价。只做求和与计数。
//! 4. **天桶按 UTC**（`hour_bucket / 86_400_000`）：与"桶对齐是 epoch 小时"同一条铁律，
//!    **不得改成本地时区日**，否则跨源对账的日边界会错位。
//!
//! # 结论是启发式，必须可复核
//!
//! "同一批 / 不同批次"没有理论判据，本文件用**重叠窗口的两源差异比**做一个**启发式**判断，
//! 并把**测得的比值、阈值、重叠区间**一并返回。UI 必须把这些数字展示出来，
//! 让用户能自己复核，而不是只看到一个结论词。

use rusqlite::Connection;
use serde::Serialize;
use std::collections::BTreeMap;

use crate::ledger_db;
use crate::ledger_ingest;

/// 一天的毫秒数。天桶 = `hour_bucket / DAY_MS * DAY_MS`（UTC 日）。
pub const DAY_MS: i64 = 86_400_000;

/// 判定"同一批"的差异比阈值（启发式）。
///
/// 取 0.20 的理由：两源若记录同一批请求，token 数应基本吻合；
/// 但两源的 token 归属口径仍有细微差异（会话源无 `success` 概念、日志源含失败请求的 0 token 行），
/// 留 20% 余量。**这是启发式，不是判据** —— 比值与阈值都会原样返回给 UI。
pub const SAME_BATCH_DIVERGENCE_THRESHOLD: f64 = 0.20;

/// 对账结论。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReconcileVerdict {
    /// 两源在时间上**无重叠** ⇒ 无法判断（这正是口径 A 的理想情形）
    NoOverlap,
    /// 账本里缺某个源 ⇒ 证据不足
    InsufficientData,
    /// 重叠区**每一天**两源量级都接近 ⇒ **同一批请求的两个视角**
    LikelySameBatch,
    /// 重叠区**每一天**两源量级都差异显著 ⇒ **不同批次**（CLI 直连 vs 走网关）
    LikelyDifferentBatch,
    /// **混合**：多数天两源吻合，少数天显著偏离。
    ///
    /// 为什么单列这一档（2026-09-12 实测发现）：整体差异比会被**少数异常天**拉高，
    /// 只看总比值会误判成"整体不同批次"。实测本机 32 个重叠天里多数天差额在 1% 内
    /// （如 08-26 差额仅 −50,331 / 7.2 亿 ≈ 0.007%），而 07-29 一天 sessions 是 logs 的 10 倍。
    /// 这种结构下"分段相加"与"只取 logs"都不对，**必须逐天决定**。
    MixedBatch,
}

impl ReconcileVerdict {
    /// 一句话人话（UI 直接显示；同时把数字带出来便于复核）。
    fn describe(self) -> &'static str {
        match self {
            ReconcileVerdict::NoOverlap => {
                "两源时间区间无重叠：无法比较，也不需要合并口径（各自覆盖各自的时段）"
            }
            ReconcileVerdict::InsufficientData => {
                "证据不足：账本里缺少其中一个源的数据，无法对账"
            }
            ReconcileVerdict::LikelySameBatch => {
                "重叠区每一天两源量级都接近 ⇒ 同一批请求的两个视角（口径 A「重叠区只取 logs」不会丢数据）"
            }
            ReconcileVerdict::LikelyDifferentBatch => {
                "重叠区每一天两源量级都差异显著 ⇒ 不同批次（CLI 直连 vs 走网关）。口径 A 会漏掉真实用量，应改为分段相加"
            }
            ReconcileVerdict::MixedBatch => {
                "多数重叠天两源吻合、少数天显著偏离 ⇒ **不能整体定口径**，需逐天判断（偏离的那几天单独看）"
            }
        }
    }
}

/// 一个 `(天, 模型)` 格的两源并列数字。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileCell {
    /// UTC 日桶起点（epoch ms）
    pub day_bucket_ms: i64,
    pub model_id: String,
    /// logs 源总 token（6 档位之和：标准/长文本 × 普通输入/缓存/输出）
    pub logs_tokens: i64,
    pub logs_requests: i64,
    pub sessions_tokens: i64,
    pub sessions_requests: i64,
    /// `sessions − logs`（正 = 会话源更多）
    pub token_diff: i64,
    pub requests_diff: i64,
    /// 两源在该格**都有量** ⇒ 真正的重叠格（对账最该看的行）
    pub overlap: bool,
}

/// 单个源在窗口内的合计。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceTokenTotals {
    pub source_name: String,
    /// 人话标签（UI 直接用）
    pub label: String,
    pub tokens: i64,
    pub requests: i64,
    /// 有量的天数
    pub days: i64,
    pub first_ms: Option<i64>,
    pub last_ms: Option<i64>,
}

/// 一个偏离显著的重叠天（证据明细）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DivergentDay {
    pub day_bucket_ms: i64,
    /// UTC 日 `YYYY-MM-DD`
    pub day: String,
    pub logs_tokens: i64,
    pub sessions_tokens: i64,
    pub token_diff: i64,
    /// 该天差异比 = `|sessions − logs| / max(两者)`
    pub divergence: f64,
}

/// 多源对账结果（PRD P0-25 的载体）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileResult {
    pub available: bool,
    pub reason: Option<String>,
    /// 逐 `(天, 模型)` 并列明细，按天升序、同天按 token 降序
    pub cells: Vec<ReconcileCell>,
    /// 逐源合计
    pub sources: Vec<SourceTokenTotals>,
    /// 两源**时间区间**的交集（epoch ms）
    pub overlap_start_ms: Option<i64>,
    pub overlap_end_ms: Option<i64>,
    pub overlap_days: i64,
    /// 交集区间内两源各自的 token 合计（**只统计交集区间**，不是全窗口）
    pub overlap_logs_tokens: i64,
    pub overlap_sessions_tokens: i64,
    /// 差异比 = `|sessions − logs| / max(两者)`。两者皆 0 时 `None`（不编造 0）。
    pub overlap_divergence: Option<f64>,
    /// 重叠天里**差异 ≤ 阈值**的天数（两源吻合 ⇒ 同一批）
    pub overlap_days_close: i64,
    /// 重叠天里**差异 > 阈值**的天数（两源偏离 ⇒ 不同批次）
    pub overlap_days_divergent: i64,
    /// **只有 logs 有 token** 的天数（覆盖缺口，不是批次差异）
    pub logs_only_days: i64,
    /// **只有 sessions 有 token** 的天数（覆盖缺口：3~7 月历史正是这种）
    pub sessions_only_days: i64,
    /// 偏离最严重的重叠天（按差异比降序，最多 5 条）。
    ///
    /// 为什么必须单列：整体差异比会被少数异常天拉高，
    /// 只看总比值会把"多数天吻合"误判成"整体不同批次"。这里把异常天直接摆出来。
    pub top_divergent_days: Vec<DivergentDay>,
    /// 本次判定所用的阈值（原样返回，供复核）
    pub divergence_threshold: f64,
    pub verdict: ReconcileVerdict,
    pub verdict_reason: String,
    /// 口径 A 的 `T0` = logs 源最早请求时间（**运行时探测，不硬编码**）。
    /// 仅当账本里确有 logs 数据时才有值。
    pub t0_ms: Option<i64>,
}

impl ReconcileResult {
    fn unavailable(reason: impl Into<String>) -> Self {
        ReconcileResult {
            available: false,
            reason: Some(reason.into()),
            cells: Vec::new(),
            sources: Vec::new(),
            overlap_start_ms: None,
            overlap_end_ms: None,
            overlap_days: 0,
            overlap_logs_tokens: 0,
            overlap_sessions_tokens: 0,
            overlap_divergence: None,
            overlap_days_close: 0,
            overlap_days_divergent: 0,
            logs_only_days: 0,
            sessions_only_days: 0,
            top_divergent_days: Vec::new(),
            divergence_threshold: SAME_BATCH_DIVERGENCE_THRESHOLD,
            verdict: ReconcileVerdict::InsufficientData,
            verdict_reason: ReconcileVerdict::InsufficientData.describe().to_string(),
            t0_ms: None,
        }
    }
}

/// 源的人话标签。**不查源库**（对账只看账本，源库可能已不存在）。
fn source_label(source_name: &str) -> String {
    match source_name {
        "codex_logs" => "网关请求口径（codex_logs）".to_string(),
        "codex_sessions" => "会话口径（codex_sessions）".to_string(),
        other => other.to_string(),
    }
}

/// 一条 `(天, 模型, 源)` 的原始聚合行。
struct RawRow {
    day: i64,
    model_id: String,
    source_name: String,
    tokens: i64,
    requests: i64,
}

/// 扫描窗口内按 `(天, 模型, 源)` 聚合。
fn scan_by_day_model(
    conn: &Connection,
    start_ms: Option<i64>,
    end_ms: Option<i64>,
) -> Result<Vec<RawRow>, String> {
    // 天桶用整数除法（hour_bucket 是 HOUR_MS 的整数倍，故除法无损）
    let sql = "
        SELECT (hour_bucket / ?1) * ?1 AS day_bucket,
               model_id,
               source_name,
               SUM(std_normal_input + std_cached + std_output
                 + long_normal_input + long_cached + long_output) AS tokens,
               SUM(requests) AS requests
        FROM usage_rollup
        WHERE hour_bucket >= ?2 AND hour_bucket <= ?3
        GROUP BY day_bucket, model_id, source_name";
    let mut stmt = conn.prepare(sql).map_err(|e| format!("对账查询失败: {e}"))?;
    let lo = start_ms.unwrap_or(i64::MIN);
    let hi = end_ms.unwrap_or(i64::MAX);
    let rows = stmt
        .query_map(rusqlite::params![DAY_MS, lo, hi], |row| {
            Ok(RawRow {
                day: row.get::<_, i64>(0)?,
                model_id: row.get::<_, String>(1)?,
                source_name: row.get::<_, String>(2)?,
                tokens: row.get::<_, i64>(3).unwrap_or(0),
                requests: row.get::<_, i64>(4).unwrap_or(0),
            })
        })
        .map_err(|e| format!("对账查询失败: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读取对账行失败: {e}"))?;
    Ok(rows)
}

/// 每个源的 `(天)` 集合，用于算时间交集与"有量天数"。
#[derive(Default)]
struct SourceSpan {
    /// 有过**任何行**的天（含 0-token 的失败请求）—— 用于"覆盖"语义
    days_any: std::collections::BTreeSet<i64>,
    /// **有 token** 的天 —— 用于"对账可比性"语义
    ///
    /// ⚠️ 为什么必须与 `days_any` 分开（2026-09-12 实测踩到）：
    /// 某些天 logs 只有 0-token 的失败请求（有行、有 requests、tokens = 0），
    /// 而 sessions 有 4.4 亿 token。若用 `days_any` 判重叠，这些天会被算成
    /// "差异 100% 的偏离天"，把结论从"覆盖缺口"误报成"批次不同"。
    days_with_tokens: std::collections::BTreeSet<i64>,
    tokens: i64,
    requests: i64,
    first_ms: Option<i64>,
    last_ms: Option<i64>,
}

/// 多源对账（PRD P0-25）。
///
/// `window_days` 为 `None` = 全量（不设时间过滤）。
pub fn reconcile(
    conn: &Connection,
    window_days: Option<i64>,
) -> Result<ReconcileResult, String> {
    // 窗口起点 = 现在 − N 天（按 UTC 日对齐，与天桶同口径）
    let end_ms = ledger_db::now_ms();
    let start_ms = window_days
        .filter(|d| *d > 0)
        .map(|d| (end_ms / DAY_MS) * DAY_MS - (d - 1) * DAY_MS);

    let raw = scan_by_day_model(conn, start_ms, None)?;
    if raw.is_empty() {
        let mut r = ReconcileResult::unavailable(
            "账本里没有用量数据（尚未摄取，或窗口内无请求）",
        );
        r.available = true;
        r.reason = None;
        r.verdict = ReconcileVerdict::InsufficientData;
        r.verdict_reason = ReconcileVerdict::InsufficientData.describe().to_string();
        return Ok(r);
    }

    // ── 透视：(day, model) → 两源 ──
    #[derive(Default, Clone, Copy)]
    struct Pair {
        logs_tokens: i64,
        logs_requests: i64,
        sessions_tokens: i64,
        sessions_requests: i64,
    }
    let mut grid: BTreeMap<(i64, String), Pair> = BTreeMap::new();
    let mut spans: BTreeMap<String, SourceSpan> = BTreeMap::new();

    for row in raw {
        let e = grid.entry((row.day, row.model_id)).or_default();
        let span = spans.entry(row.source_name.clone()).or_default();
        span.days_any.insert(row.day);
        if row.tokens > 0 {
            span.days_with_tokens.insert(row.day);
        }
        span.tokens += row.tokens;
        span.requests += row.requests;
        // 覆盖区间按"有 token 的天"算:0-token 的失败天不该撑大覆盖范围
        if row.tokens > 0 {
            span.first_ms = Some(span.first_ms.map_or(row.day, |m: i64| m.min(row.day)));
            span.last_ms = Some(span.last_ms.map_or(row.day, |m: i64| m.max(row.day)));
        }

        if row.source_name == ledger_db::SOURCE_CODEX_SESSIONS {
            e.sessions_tokens += row.tokens;
            e.sessions_requests += row.requests;
        } else if row.source_name == ledger_db::SOURCE_CODEX_LOGS {
            e.logs_tokens += row.tokens;
            e.logs_requests += row.requests;
        }
        // 其它源（未来新增）暂不参与两源对账，但上面已计入 spans，不会被静默吞掉
    }

    let logs = spans.get(ledger_db::SOURCE_CODEX_LOGS);
    let sessions = spans.get(ledger_db::SOURCE_CODEX_SESSIONS);

    // ── 时间交集（按"有 token 的天"） ──
    // 只用有 token 的天：0-token 的失败天与另一源的巨量 token 相比毫无意义，
    // 会被算成"差异 100%"，把覆盖缺口误报成批次不同。
    let overlap_days_set: std::collections::BTreeSet<i64> = match (logs, sessions) {
        (Some(a), Some(b)) => a.days_with_tokens.intersection(&b.days_with_tokens).copied().collect(),
        _ => Default::default(),
    };
    let overlap_start_ms = overlap_days_set.iter().next().copied();
    let overlap_end_ms = overlap_days_set.iter().next_back().copied();

    // 只有单源有 token 的天数 —— 这是"覆盖缺口"，与"批次差异"是两件事
    let logs_only_days = logs
        .map(|l| {
            l.days_with_tokens
                .difference(&overlap_days_set)
                .count() as i64
        })
        .unwrap_or(0);
    let sessions_only_days = sessions
        .map(|s| {
            s.days_with_tokens
                .difference(&overlap_days_set)
                .count() as i64
        })
        .unwrap_or(0);

    let mut overlap_logs_tokens = 0i64;
    let mut overlap_sessions_tokens = 0i64;
    // 逐天合计(仅重叠天),用于判"每天是否吻合"
    let mut per_day: BTreeMap<i64, (i64, i64)> = BTreeMap::new();
    for ((day, _model), pair) in &grid {
        if overlap_days_set.contains(day) {
            overlap_logs_tokens += pair.logs_tokens;
            overlap_sessions_tokens += pair.sessions_tokens;
            let e = per_day.entry(*day).or_insert((0, 0));
            e.0 += pair.logs_tokens;
            e.1 += pair.sessions_tokens;
        }
    }

    // 逐天差异比 + 分类(吻合 / 偏离)。这是把"整体比值"拆成结构的关键一步。
    let mut top_divergent_days: Vec<DivergentDay> = Vec::new();
    let mut overlap_days_close = 0i64;
    let mut overlap_days_divergent = 0i64;
    for (day, (l, s)) in &per_day {
        let mx = (*l).max(*s);
        if mx <= 0 {
            continue;
        }
        let d = ((*s - *l).unsigned_abs() as f64) / mx as f64;
        if d <= SAME_BATCH_DIVERGENCE_THRESHOLD {
            overlap_days_close += 1;
        } else {
            overlap_days_divergent += 1;
            top_divergent_days.push(DivergentDay {
                day_bucket_ms: *day,
                day: format_day(*day),
                logs_tokens: *l,
                sessions_tokens: *s,
                token_diff: *s - *l,
                divergence: d,
            });
        }
    }
    top_divergent_days.sort_by(|a, b| {
        b.divergence
            .partial_cmp(&a.divergence)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    top_divergent_days.truncate(5);

    let overlap_divergence = {
        let mx = overlap_logs_tokens.max(overlap_sessions_tokens);
        if mx > 0 {
            Some(
                (overlap_sessions_tokens - overlap_logs_tokens).unsigned_abs() as f64 / mx as f64,
            )
        } else {
            None
        }
    };

    // ── 结论 ──
    let (verdict, verdict_reason) = match (logs, sessions) {
        (Some(_), None) => (
            ReconcileVerdict::InsufficientData,
            format!(
                "{}；账本里只有 {} 一个源，无第二个源可比。",
                ReconcileVerdict::InsufficientData.describe(),
                ledger_db::SOURCE_CODEX_LOGS
            ),
        ),
        (None, Some(_)) => (
            ReconcileVerdict::InsufficientData,
            format!(
                "{}；账本里只有 {} 一个源，无第二个源可比。",
                ReconcileVerdict::InsufficientData.describe(),
                ledger_db::SOURCE_CODEX_SESSIONS
            ),
        ),
        (None, None) => (
            ReconcileVerdict::InsufficientData,
            ReconcileVerdict::InsufficientData.describe().to_string(),
        ),
        (Some(_), Some(_)) => {
            if overlap_days_set.is_empty() {
                (ReconcileVerdict::NoOverlap, ReconcileVerdict::NoOverlap.describe().to_string())
            } else if overlap_days_close + overlap_days_divergent == 0 {
                (
                    ReconcileVerdict::InsufficientData,
                    "重叠区两源 token 合计都是 0，无法比较。".to_string(),
                )
            } else {
                // 结论看**逐天结构**，不看总比值 —— 总比值会被少数异常天拉高
                let verb = if overlap_days_divergent == 0 {
                    ReconcileVerdict::LikelySameBatch
                } else if overlap_days_close == 0 {
                    ReconcileVerdict::LikelyDifferentBatch
                } else {
                    ReconcileVerdict::MixedBatch
                };
                let mut reason = format!(
                    "重叠 {} 天（{}..{}）：logs {:.0} token vs sessions {:.0} token，总差异比 {:.1}%（阈值 {:.0}%）；\
                     逐天看：{} 天吻合 / {} 天偏离；另有覆盖缺口 logs 独有 {} 天 / sessions 独有 {} 天。{}",
                    overlap_days_set.len(),
                    overlap_start_ms.map(format_day).unwrap_or_else(|| "—".into()),
                    overlap_end_ms.map(format_day).unwrap_or_else(|| "—".into()),
                    overlap_logs_tokens as f64,
                    overlap_sessions_tokens as f64,
                    overlap_divergence.unwrap_or(0.0) * 100.0,
                    SAME_BATCH_DIVERGENCE_THRESHOLD * 100.0,
                    overlap_days_close,
                    overlap_days_divergent,
                    logs_only_days,
                    sessions_only_days,
                    verb.describe(),
                );
                if !top_divergent_days.is_empty() {
                    let worst = top_divergent_days
                        .iter()
                        .take(3)
                        .map(|d| format!("{} 差异 {:.0}%", d.day, d.divergence * 100.0))
                        .collect::<Vec<_>>()
                        .join("、");
                    reason.push_str(&format!(" 偏离最大的天：{worst}。"));
                }
                (verb, reason)
            }
        }
    };

    // 在消费 `spans` 之前把 T0 取出（`logs` 是对 `spans` 的借用，不能与 move 共存）
    let t0_ms = logs.and_then(|l| l.first_ms);

    // ── 明细行 ──
    let mut cells: Vec<ReconcileCell> = grid
        .into_iter()
        .map(|((day, model_id), pair)| ReconcileCell {
            day_bucket_ms: day,
            model_id,
            logs_tokens: pair.logs_tokens,
            logs_requests: pair.logs_requests,
            sessions_tokens: pair.sessions_tokens,
            sessions_requests: pair.sessions_requests,
            token_diff: pair.sessions_tokens - pair.logs_tokens,
            requests_diff: pair.sessions_requests - pair.logs_requests,
            overlap: pair.logs_tokens > 0 && pair.sessions_tokens > 0,
        })
        .collect();
    cells.sort_by(|a, b| {
        a.day_bucket_ms
            .cmp(&b.day_bucket_ms)
            .then((b.logs_tokens + b.sessions_tokens).cmp(&(a.logs_tokens + a.sessions_tokens)))
            .then(a.model_id.cmp(&b.model_id))
    });

    let sources: Vec<SourceTokenTotals> = spans
        .into_iter()
        .map(|(source_name, s)| SourceTokenTotals {
            label: source_label(&source_name),
            source_name,
            tokens: s.tokens,
            requests: s.requests,
            // 报"有 token 的天数":0-token 的失败天不是有量天
            days: s.days_with_tokens.len() as i64,
            first_ms: s.first_ms,
            last_ms: s.last_ms,
        })
        .collect();

    Ok(ReconcileResult {
        available: true,
        reason: None,
        cells,
        sources,
        overlap_start_ms,
        overlap_end_ms,
        overlap_days: overlap_days_set.len() as i64,
        overlap_logs_tokens,
        overlap_sessions_tokens,
        overlap_divergence,
        overlap_days_close,
        overlap_days_divergent,
        logs_only_days,
        sessions_only_days,
        top_divergent_days,
        divergence_threshold: SAME_BATCH_DIVERGENCE_THRESHOLD,
        verdict,
        verdict_reason,
        t0_ms,
    })
}

/// 把天桶起点格式化成 `YYYY-MM-DD`（UTC）。仅用于人话文案。
///
/// `pub` 是被 `ledger_merge.rs` 共用（两层的"天"必须是同一个格式化口径）。
pub fn format_day(day_ms: i64) -> String {
    // 手工换算,零依赖:epoch 天 → 儒略日 → 公历
    let days = day_ms.div_euclid(DAY_MS);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

// =============================================================================
// 源清单（架构 T12 子项 10）
// =============================================================================

/// 账本里的一个源。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerSourceInfo {
    pub source_name: String,
    pub label: String,
    /// 源库路径（摄取时记录）
    pub source_path: String,
    /// 水位（源库 id / rowid）
    pub last_id: i64,
    pub last_ts_ms: i64,
    pub last_ingest_ms: i64,
    pub total_rows_seen: i64,
    /// 源库重建世代
    pub reset_generation: i64,
    /// 账本里该源的行数 / token / 请求数
    pub rows: i64,
    pub tokens: i64,
    pub requests: i64,
    pub first_ms: Option<i64>,
    pub last_ms: Option<i64>,
}

/// 逐源账本量：`source_name -> (行数, 总 token, 总请求数, MIN(桶), MAX(桶))`。
///
/// 抽别名一是消 `clippy::type_complexity`，二是元组有 5 个位置、裸写时读的人得自己数。
type SourceUsageAgg = BTreeMap<String, (i64, i64, i64, Option<i64>, Option<i64>)>;

/// 列出账本里的全部源（含水位与已落库量）。
///
/// 为什么需要它：UI 要能回答"**哪些源真的进来了**、各自的覆盖区间是什么"。
/// 只看摄取返回值不够 —— 那是"这一次"的结果，这里是"账本里现在有什么"。
pub fn list_sources(conn: &Connection) -> Result<Vec<LedgerSourceInfo>, String> {
    let mut out: Vec<LedgerSourceInfo> = Vec::new();

    // 1) 水位表(每源一行)。它是"已知源"的权威清单 —— 即便该源零行也在。
    let mut stmt = conn
        .prepare(
            "SELECT source_name, source_path, last_id, last_ts_ms, last_ingest_ms,
                    total_rows_seen, source_fingerprint FROM ingest_state ORDER BY source_name",
        )
        .map_err(|e| format!("读源水位失败: {e}"))?;
    let states = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1).unwrap_or_default(),
                row.get::<_, i64>(2).unwrap_or(0),
                row.get::<_, i64>(3).unwrap_or(0),
                row.get::<_, i64>(4).unwrap_or(0),
                row.get::<_, i64>(5).unwrap_or(0),
                row.get::<_, String>(6).unwrap_or_default(),
            ))
        })
        .map_err(|e| format!("读源水位失败: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("读源水位失败: {e}"))?;
    drop(stmt);

    // 2) 逐源汇总账本量
    let mut agg = conn
        .prepare(
            "SELECT source_name,
                    COUNT(*),
                    COALESCE(SUM(std_normal_input + std_cached + std_output
                      + long_normal_input + long_cached + long_output), 0),
                    COALESCE(SUM(requests), 0),
                    MIN(hour_bucket),
                    MAX(hour_bucket)
             FROM usage_rollup GROUP BY source_name",
        )
        .map_err(|e| format!("汇总账本用量失败: {e}"))?;
    let mut usage: SourceUsageAgg = BTreeMap::new();
    let rows = agg
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1).unwrap_or(0),
                row.get::<_, i64>(2).unwrap_or(0),
                row.get::<_, i64>(3).unwrap_or(0),
                row.get::<_, Option<i64>>(4).unwrap_or(None),
                row.get::<_, Option<i64>>(5).unwrap_or(None),
            ))
        })
        .map_err(|e| format!("汇总账本用量失败: {e}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("汇总账本用量失败: {e}"))?;
    for r in rows {
        usage.insert(r.0, (r.1, r.2, r.3, r.4, r.5));
    }
    drop(agg);

    for (source_name, source_path, last_id, last_ts_ms, last_ingest_ms, total_rows_seen, fingerprint) in states {
        let fp = ledger_ingest::SourceFingerprint::parse(&fingerprint);
        let (rows, tokens, requests, first_ms, last_ms) =
            usage.get(&source_name).copied().unwrap_or((0, 0, 0, None, None));
        out.push(LedgerSourceInfo {
            label: source_label(&source_name),
            source_name,
            source_path,
            last_id,
            last_ts_ms,
            last_ingest_ms,
            total_rows_seen,
            reset_generation: fp.generation(),
            rows,
            tokens,
            requests,
            first_ms,
            last_ms,
        });
    }
    Ok(out)
}

// =============================================================================
// Tauri 命令
// =============================================================================

/// 多源对账（PRD P0-25）。`window_days` 为 `None` = 全量。
#[tauri::command]
pub async fn ledger_reconcile_sources(window_days: Option<i64>) -> Result<ReconcileResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = ledger_db::ledger_db_path().map_err(|e| e.to_string())?;
        // 账本文件还不存在 = 尚未摄取,如实报不可用(不是 Err)
        if !path.exists() {
            return Ok(ReconcileResult::unavailable(format!(
                "账本尚未生成（{}），请先让成本中心完成一次摄取",
                path.display()
            )));
        }
        // 只读打开:不跑 migrate,免得读操作去抢写锁、和后台摄取线程撞 SQLITE_BUSY
        let conn = ledger_db::open_read_only(&path).map_err(|e| e.to_string())?;
        reconcile(&conn, window_days)
    })
    .await
    .map_err(|e| format!("对账任务异常结束: {e}"))?
}

/// 列出账本里的全部源（水位 + 已落库量）。
#[tauri::command]
pub async fn ledger_list_sources() -> Result<Vec<LedgerSourceInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = ledger_db::ledger_db_path().map_err(|e| e.to_string())?;
        if !path.exists() {
            return Ok(Vec::new());
        }
        let conn = ledger_db::open_read_only(&path).map_err(|e| e.to_string())?;
        list_sources(&conn)
    })
    .await
    .map_err(|e| format!("读源清单异常结束: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "console2api-query-{tag}-{}-{}",
            std::process::id(),
            ledger_db::now_ms()
        ));
        std::fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    fn ledger_conn(dir: &std::path::Path) -> Connection {
        ledger_db::open(&ledger_db::ledger_db_path_in(dir)).expect("开账本")
    }

    /// 插一条 usage_rollup 行。`tokens` 全部记在 std_normal_input 上（口径无关，只要总和对）。
    #[allow(clippy::too_many_arguments)]
    fn insert_rollup(
        conn: &Connection,
        hour_bucket: i64,
        source_name: &str,
        model_id: &str,
        tokens: i64,
        requests: i64,
    ) {
        conn.execute(
            "INSERT INTO usage_rollup (hour_bucket, source_name, source_account_id, model_id,
                api_key_id, client_instance_id, std_normal_input, requests, updated_at_ms)
             VALUES (?1,?2,'acct',?3,'','',?4,?5,?6)",
            params![hour_bucket, source_name, model_id, tokens, requests, ledger_db::now_ms()],
        )
        .expect("插 usage_rollup");
    }

    fn insert_state(conn: &Connection, source_name: &str, last_id: i64, path: &str) {
        conn.execute(
            "INSERT INTO ingest_state (source_name, source_path, last_id, last_ts_ms,
                last_ingest_ms, total_rows_seen, source_fingerprint, schema_version)
             VALUES (?1,?2,?3,0,0,0,'{\"generation\":2,\"resetDetected\":false,\"minId\":1,\"firstEventKey\":\"\"}',0)",
            params![source_name, path, last_id],
        )
        .expect("插 ingest_state");
    }

    fn day(n: i64) -> i64 {
        // 以 NOW 所在 UTC 日为基准往前 n 天
        (ledger_db::now_ms() / DAY_MS) * DAY_MS - n * DAY_MS
    }

    #[test]
    fn reconcile_reports_two_sources_side_by_side_without_merging() {
        let dir = temp_dir("recon");
        let conn = ledger_conn(&dir);
        // 同一天、同一模型:logs 1000 / sessions 1100（差异 9.1% ≤ 20% → 同一批）
        insert_rollup(&conn, day(1), "codex_logs", "m-a", 1_000, 10);
        insert_rollup(&conn, day(1), "codex_sessions", "m-a", 1_100, 11);
        // 只 logs 有量的天
        insert_rollup(&conn, day(2), "codex_logs", "m-a", 500, 5);
        // 只 sessions 有量的天（3~7 月历史那种）
        insert_rollup(&conn, day(5), "codex_sessions", "m-b", 7_000, 70);

        let r = reconcile(&conn, None).expect("对账成功");
        assert!(r.available);
        // 逐源合计:两源**各自**成行,绝不合并成一个总额
        assert_eq!(r.sources.len(), 2);
        let logs = r.sources.iter().find(|s| s.source_name == "codex_logs").unwrap();
        let sess = r.sources.iter().find(|s| s.source_name == "codex_sessions").unwrap();
        assert_eq!((logs.tokens, logs.requests), (1_500, 15));
        assert_eq!((sess.tokens, sess.requests), (8_100, 81));

        // 明细:(天, 模型) 并列
        assert_eq!(r.cells.len(), 3);
        let c0 = r.cells.iter().find(|c| c.day_bucket_ms == day(1)).unwrap();
        assert_eq!(c0.logs_tokens, 1_000);
        assert_eq!(c0.sessions_tokens, 1_100);
        assert_eq!(c0.token_diff, 100, "差额 = sessions − logs");
        assert!(c0.overlap, "两源都有量 ⇒ 重叠格");

        // 重叠区只统计"两源都有量的天"
        assert_eq!(r.overlap_days, 1);
        assert_eq!(r.overlap_start_ms, Some(day(1)));
        assert_eq!(r.overlap_end_ms, Some(day(1)));
        assert_eq!(r.overlap_logs_tokens, 1_000);
        assert_eq!(r.overlap_sessions_tokens, 1_100);
        assert_eq!(r.overlap_divergence, Some(100.0 / 1_100.0));
        assert_eq!(r.verdict, ReconcileVerdict::LikelySameBatch);
        assert!(r.verdict_reason.contains("9.1%"), "结论必须带可复核的数字: {}", r.verdict_reason);
        // T0 = logs 最早天
        assert_eq!(r.t0_ms, Some(day(2)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reconcile_flags_different_batch_when_divergence_is_large() {
        let dir = temp_dir("recon-diff");
        let conn = ledger_conn(&dir);
        // 同一天同模型:logs 1000 vs sessions 5000 ⇒ 差异 80% > 20%
        insert_rollup(&conn, day(1), "codex_logs", "m-a", 1_000, 10);
        insert_rollup(&conn, day(1), "codex_sessions", "m-a", 5_000, 50);
        let r = reconcile(&conn, None).expect("对账成功");
        assert_eq!(r.verdict, ReconcileVerdict::LikelyDifferentBatch);
        assert_eq!(r.overlap_days_close, 0);
        assert_eq!(r.overlap_days_divergent, 1);
        assert_eq!(r.overlap_divergence, Some(0.8));
        assert!(r.verdict_reason.contains("分段相加"), "应给出改口径的提示");
        assert_eq!(r.top_divergent_days.len(), 1);
        assert_eq!(r.top_divergent_days[0].day, format_day(day(1)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **混合情形**：多数天吻合 + 少数天偏离 ⇒ 不得整体定口径。
    ///
    /// 这条锁死本机真实数据的结构（2026-09-12 实测）：32 个重叠天里多数天差额 < 1%，
    /// 但 07-29 一天 sessions 是 logs 的 10 倍 —— 只看总比值（27.7%）会误判成"整体不同批次"。
    #[test]
    fn reconcile_flags_mixed_batch_when_most_days_agree_but_a_few_diverge() {
        let dir = temp_dir("recon-mixed");
        let conn = ledger_conn(&dir);
        // 3 天几乎吻合（差异 0.5%）
        for d in 1..=3 {
            insert_rollup(&conn, day(d), "codex_logs", "m-a", 100_000, 100);
            insert_rollup(&conn, day(d), "codex_sessions", "m-a", 100_500, 100);
        }
        // 1 天严重偏离（sessions 是 logs 的 10 倍）
        insert_rollup(&conn, day(4), "codex_logs", "m-a", 100_000, 100);
        insert_rollup(&conn, day(4), "codex_sessions", "m-a", 1_000_000, 1_000);

        let r = reconcile(&conn, None).expect("对账成功");
        assert_eq!(r.overlap_days, 4);
        assert_eq!(r.overlap_days_close, 3, "3 天吻合");
        assert_eq!(r.overlap_days_divergent, 1, "1 天偏离");
        assert_eq!(
            r.verdict,
            ReconcileVerdict::MixedBatch,
            "多数吻合 + 少数偏离 必须是 MixedBatch,不能整体判成不同批次"
        );
        assert!(r.verdict_reason.contains("3 天吻合 / 1 天偏离"), "{}", r.verdict_reason);
        assert!(r.verdict_reason.contains("逐天"), "应提示需逐天判断: {}", r.verdict_reason);
        // 偏离最大的天被摆出来
        assert_eq!(r.top_divergent_days.len(), 1);
        assert_eq!(r.top_divergent_days[0].day, format_day(day(4)));
        assert!((r.top_divergent_days[0].divergence - 0.9).abs() < 1e-9);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **回归**：某天只有 0-token 的失败请求（有行、有 requests、tokens = 0）时，
    /// 不得被算成"差异 100% 的偏离天"。
    ///
    /// 本机真实数据踩到过：07-30 / 07-31 / 08-01 三天 logs 只有失败请求（0 token），
    /// 而 sessions 各有 4~7 亿 token。按"有行的天"判重叠会把它们报成
    /// "偏离最大的天（差异 100%）"，把**覆盖缺口**误报成**批次不同**。
    #[test]
    fn zero_token_days_are_coverage_gaps_not_divergence() {
        let dir = temp_dir("recon-zero-token");
        let conn = ledger_conn(&dir);
        // day(1):两源都有 token,几乎吻合
        insert_rollup(&conn, day(1), "codex_logs", "m-a", 100_000, 100);
        insert_rollup(&conn, day(1), "codex_sessions", "m-a", 100_000, 100);
        // day(2):logs 只有 0-token 的失败请求;sessions 有 4.4 亿
        insert_rollup(&conn, day(2), "codex_logs", "m-a", 0, 7);
        insert_rollup(&conn, day(2), "codex_sessions", "m-a", 444_648_228, 1_000);

        let r = reconcile(&conn, None).expect("对账成功");
        assert_eq!(r.overlap_days, 1, "只有 day(1) 是两源都有 token 的重叠天");
        assert_eq!(r.overlap_days_close, 1);
        assert_eq!(r.overlap_days_divergent, 0, "0-token 天不得算成偏离天");
        assert_eq!(r.verdict, ReconcileVerdict::LikelySameBatch);
        assert!(r.top_divergent_days.is_empty(), "0-token 天不该出现在偏离天列表里");
        assert_eq!(r.sessions_only_days, 1, "day(2) 应归为 sessions 独有的覆盖缺口");
        assert_eq!(r.logs_only_days, 0);
        assert!(r.verdict_reason.contains("覆盖缺口"), "{}", r.verdict_reason);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reconcile_reports_no_overlap_when_sources_cover_disjoint_days() {
        let dir = temp_dir("recon-noov");
        let conn = ledger_conn(&dir);
        // sessions 只覆盖很老的历史,logs 只覆盖最近 ⇒ 无重叠 = 口径 A 的理想情形
        insert_rollup(&conn, day(200), "codex_sessions", "m-a", 9_000, 90);
        insert_rollup(&conn, day(1), "codex_logs", "m-a", 1_000, 10);
        let r = reconcile(&conn, None).expect("对账成功");
        assert_eq!(r.overlap_days, 0);
        assert_eq!(r.overlap_start_ms, None, "无重叠时不得编造区间");
        assert_eq!(r.overlap_divergence, None, "无重叠时差异比必须是 None,不是 0");
        assert_eq!(r.verdict, ReconcileVerdict::NoOverlap);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reconcile_reports_insufficient_data_when_only_one_source_exists() {
        let dir = temp_dir("recon-one");
        let conn = ledger_conn(&dir);
        insert_rollup(&conn, day(1), "codex_logs", "m-a", 1_000, 10);
        let r = reconcile(&conn, None).expect("对账成功");
        assert_eq!(r.verdict, ReconcileVerdict::InsufficientData);
        assert!(r.verdict_reason.contains("只有"), "应说明缺哪个源: {}", r.verdict_reason);
        assert_eq!(r.sources.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reconcile_empty_ledger_is_available_but_insufficient() {
        let dir = temp_dir("recon-empty");
        let conn = ledger_conn(&dir);
        let r = reconcile(&conn, None).expect("空账本不应 Err");
        assert!(r.available, "空账本不是'不可用',是'没数据'");
        assert_eq!(r.cells.len(), 0);
        assert_eq!(r.verdict, ReconcileVerdict::InsufficientData);
        assert!(r.overlap_divergence.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reconcile_window_days_filters_by_utc_day() {
        let dir = temp_dir("recon-win");
        let conn = ledger_conn(&dir);
        insert_rollup(&conn, day(1), "codex_logs", "m-a", 1_000, 10);
        insert_rollup(&conn, day(1), "codex_sessions", "m-a", 1_000, 10);
        insert_rollup(&conn, day(40), "codex_logs", "m-old", 999_999, 9_999);
        insert_rollup(&conn, day(40), "codex_sessions", "m-old", 999_999, 9_999);

        let r = reconcile(&conn, Some(7)).expect("对账成功");
        assert!(
            r.cells.iter().all(|c| c.model_id == "m-a"),
            "7 天窗口不得包含 40 天前的数据: {:?}",
            r.cells.iter().map(|c| &c.model_id).collect::<Vec<_>>()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn format_day_is_correct_utc() {
        assert_eq!(format_day(0), "1970-01-01");
        // 2026-01-01 00:00:00 UTC = 1767225600000
        assert_eq!(format_day(1_767_225_600_000), "2026-01-01");
        assert_eq!(format_day(1_767_225_600_000 + 31 * DAY_MS), "2026-02-01");
    }

    #[test]
    fn list_sources_includes_watermark_even_when_zero_rows() {
        let dir = temp_dir("list-src");
        let conn = ledger_conn(&dir);
        insert_state(&conn, "codex_logs", 181_818, "C:/logs.sqlite");
        insert_state(&conn, "codex_sessions", 234_990, "C:/sess.sqlite");
        insert_rollup(&conn, day(1), "codex_logs", "m-a", 1_000, 10);

        let list = list_sources(&conn).expect("列源成功");
        assert_eq!(list.len(), 2, "零行的源也要在清单里(它有水位)");
        let logs = list.iter().find(|s| s.source_name == "codex_logs").unwrap();
        assert_eq!(logs.last_id, 181_818);
        assert_eq!(logs.rows, 1);
        assert_eq!(logs.tokens, 1_000);
        assert_eq!(logs.reset_generation, 2, "世代从指纹里解出来");
        let sess = list.iter().find(|s| s.source_name == "codex_sessions").unwrap();
        assert_eq!(sess.last_id, 234_990);
        assert_eq!(sess.rows, 0, "零行如实为 0");
        assert!(sess.first_ms.is_none(), "零行不得编造覆盖区间");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **端到端：用本机真实的两源数据产出对账证据（PRD P0-25 的最终交付物）。**
    ///
    /// 手动验证命令（这是"同一批 vs 不同批次"的唯一实证手段）：
    /// ```bash
    /// cd src-tauri
    /// cargo test --bin console2api end_to_end_reconcile_real_sources -- --ignored --nocapture
    /// ```
    /// 它把两个真实 cockpit 源都摄进**临时账本**（不碰生产账本），再跑对账并打印结论。
    #[test]
    #[ignore = "手动端到端:依赖本机真实 cockpit 数据,见文档注释"]
    fn end_to_end_reconcile_real_sources() {
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

        let dir = temp_dir("recon-e2e");
        let mut conn = ledger_conn(&dir);
        let opts = ledger_ingest::IngestOptions::default();
        let now = ledger_db::now_ms();
        for src in [&logs, &sessions] {
            let r = ledger_ingest::ingest_into(&mut conn, src, &opts, now)
                .unwrap_or_else(|e| panic!("摄取 {} 失败: {e}", src.source_name));
            println!("摄取 {}: 扫描 {} 行 / 写桶 {}", src.source_name, r.scanned_rows, r.upserted_buckets);
        }

        let r = reconcile(&conn, None).expect("对账成功");
        println!("\n──── 对账结论 ────");
        println!("{}", r.verdict_reason);
        println!("结论枚举: {:?}", r.verdict);
        println!("T0(logs 最早) = {:?} → {}", r.t0_ms, r.t0_ms.map(format_day).unwrap_or_default());
        println!(
            "重叠: {} 天 {:?}..{:?} / logs {} tok vs sessions {} tok / 差异比 {}",
            r.overlap_days,
            r.overlap_start_ms.map(format_day),
            r.overlap_end_ms.map(format_day),
            r.overlap_logs_tokens,
            r.overlap_sessions_tokens,
            r.overlap_divergence.map(|d| format!("{:.1}%", d * 100.0)).unwrap_or_else(|| "无法比较".into()),
        );
        println!("\n逐源合计:");
        for s in &r.sources {
            println!(
                "  {:<34} {:>14} tok / {:>8} req / {} 天 / {}..{}",
                s.label,
                s.tokens,
                s.requests,
                s.days,
                s.first_ms.map(format_day).unwrap_or_default(),
                s.last_ms.map(format_day).unwrap_or_default(),
            );
        }
        println!("\n重叠格 Top 12 (天 / 模型 / logs / sessions / 差额):");
        let mut overlaps: Vec<_> = r.cells.iter().filter(|c| c.overlap).collect();
        overlaps.sort_by_key(|c| -(c.logs_tokens + c.sessions_tokens));
        for c in overlaps.iter().take(12) {
            println!(
                "  {} {:<20} logs {:>10} sessions {:>10} 差额 {:>+11}",
                format_day(c.day_bucket_ms), c.model_id, c.logs_tokens, c.sessions_tokens, c.token_diff
            );
        }
        // 注意:这里按「天」统计覆盖缺口,与上面按「天×模型格」统计的不是一回事,
        // 同一个天可能既有吻合的模型格也有单源为 0 的模型格。
        println!(
            "\n覆盖缺口(按天,只用有 token 的天): logs 独有 {} 天 / sessions 独有 {} 天",
            r.logs_only_days, r.sessions_only_days
        );
        println!(
            "重叠天中至少有一个模型格单边为 0 的天数: logs 侧 {} / sessions 侧 {}",
            r.cells.iter().filter(|c| c.logs_tokens > 0 && c.sessions_tokens == 0).map(|c| c.day_bucket_ms).collect::<std::collections::BTreeSet<_>>().len(),
            r.cells.iter().filter(|c| c.sessions_tokens > 0 && c.logs_tokens == 0).map(|c| c.day_bucket_ms).collect::<std::collections::BTreeSet<_>>().len(),
        );

        assert!(r.available);
        assert!(!r.cells.is_empty(), "真实两源应有对账明细");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
