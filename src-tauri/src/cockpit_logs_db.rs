//! cockpit 单请求用量库:`%USERPROFILE%\.antigravity_cockpit\codex_local_access_logs.sqlite`
//!
//! # 为什么必须有这一层
//!
//! 三份 cockpit 数据源的口径各不相同,只有本库能支撑"本项目自算成本":
//!
//! | 数据源 | 滚动窗口 | token | 单请求 |
//! |---|---|---|---|
//! | `codex_local_access_stats.json` | 否(日/周/月**日历**累计快照) | 有(聚合) | 无 |
//! | `logs/codex-api.log.*` | 是 | **无**(实测 grep inputTokens/cachedTokens 命中 0) | 有 |
//! | 本库 `request_logs` 表 | 是 | 有 | **有** |
//!
//! cockpit 的长上下文档位价是按**单请求** `input_tokens > 272_000` 判定的
//! (已用本机 179,002 行实测校验:该判定与 cockpit 自己落库的单价档位 100% 一致,
//! 见 docs 注释与 `cockpit_logs_db` 单测)。没有单请求 token 就只能拿"窗口平均 token"
//! 去猜——实测 gpt-6-astra 会把成本算少一半($2,122 vs 真实 $3,929)。
//!
//! # 职责边界
//!
//! 本模块**只做扫描与分档聚合,不做计价**。价目表(内置价目 + 用户在 cockpit 配的覆盖价)
//! 由前端 `src/features/cost-center/` 单一持有,避免 Rust 侧再养一份价目导致两处漂移。
//! 输出把 token 拆成"标准档 / 长文本档"两套,前端按自己价目表分别计价后相加。

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

/// 长上下文档位阈值(单次请求 input_tokens 超过此值走长文本价)。
/// 与 cockpit `CODEX_LOCAL_ACCESS_LONG_CONTEXT_THRESHOLD_TOKENS` 同值。
pub const LONG_CONTEXT_THRESHOLD_TOKENS: i64 = 272_000;

/// 数据库文件名(cockpit 数据目录下)。
pub const REQUEST_LOG_DB_NAME: &str = "codex_local_access_logs.sqlite";

/// 第二源数据库文件名(cockpit 数据目录下):Codex CLI **会话日志**的用量落库。
///
/// 与 [`REQUEST_LOG_DB_NAME`] 的关键差异(2026-09-11 本机实测):
/// - 表 `session_usage_events`,主键是 TEXT `request_id` ⇒ 增量水位只能走隐式 `rowid`;
/// - `timestamp` 是 **epoch 秒**(不是毫秒);
/// - 列名是 `model` / `cached_input_tokens`(不是 `model_id` / `cached_tokens`);
/// - **无** `account_id`,只有恒为 `__default__` 的 `instance_id` / `instance_name`;
/// - **无** 成本 / 成功标志 / 延迟 / 错误分类字段;
/// - 覆盖 2026-03-07 → 2026-09-01,比单请求库多出约 4.3 万行 3~7 月历史。
///
/// 它是**唯一带 `session_id`(thread uuid)** 的来源,但 `session_id` 不进账本 grain
/// (会让基数从"每小时 × 账号 × 模型"膨胀到"每小时 × session")。
pub const SESSION_USAGE_DB_NAME: &str = "codex_session_usage.sqlite";

/// 第二源的表名(常量,禁止在业务代码里写字面量)。
pub const SESSION_USAGE_TABLE: &str = "session_usage_events";

/// 分档 token 聚合。缓存命中是 input 的**子集**(不是 input 之外另加一份),
/// 故"普通输入"与"缓存命中"在聚合阶段就拆开存,前端直接 × 对应单价即可。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenSplit {
    pub requests: i64,
    pub success: i64,
    pub error: i64,
    /// 标准档:未命中缓存的输入 token
    pub std_normal_input: i64,
    /// 标准档:缓存命中 token(input 的子集)
    pub std_cached: i64,
    /// 标准档:输出 token
    pub std_output: i64,
    /// 长文本档:未命中缓存的输入 token
    pub long_normal_input: i64,
    /// 长文本档:缓存命中 token(input 的子集)
    pub long_cached: i64,
    /// 长文本档:输出 token
    pub long_output: i64,
    pub std_context_min: Option<i64>,
    pub std_context_max: Option<i64>,
    pub long_context_min: Option<i64>,
    pub long_context_max: Option<i64>,
    /// cockpit 自己落库的估算成本(USD)之和。
    /// 用途:**仅在某模型本项目没有可用单价时**作为诚实回退,并由前端标注口径
    /// (不冒充"本项目自算")。有单价时成本一律由本项目自算,不读这个值。
    pub estimated_cost_usd: f64,
    /// 失败原因分类计数(本机实测:upstream_error 19,271 / request_failed 4,206 /
    /// client_canceled 2,761 / quota_or_rate_limit 730 / auth_failed 93)。
    ///
    /// 为什么必须落这一层(2026-09-11):"账号健康"图和"请求质量 → 429/402/其他"图
    /// 此前只有 sub2api 的 economics / ops 错误端点一个来源,cockpit 源下整片空白。
    /// 而 `request_logs.error_category` 与 `http_status` 是本机真实存在的分类字段,
    /// 按桶聚合即可还原健康三态(可调度 / 限流 / 错误)——不是没有数据,是没去读。
    pub rate_limited: i64,
    pub upstream_error: i64,
    pub client_canceled: i64,
}

impl TokenSplit {
    /// 累加一条请求。长文本档仅按 token 阈值切分——**是否真的启用长文本价**
    /// 取决于该模型价目里的 `sessionLongContext` 标记,由前端决定(有些模型没有长文本文档)。
    /// 对 T01 账本摄取(ledger_db 复用同一分档口径)可见。
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn add(
        &mut self,
        input: i64,
        output: i64,
        cached: i64,
        success: bool,
        estimated_cost_usd: f64,
        error_category: &str,
        http_status: Option<i64>,
    ) {
        self.requests += 1;
        self.estimated_cost_usd += if estimated_cost_usd.is_finite() { estimated_cost_usd } else { 0.0 };
        if success {
            self.success += 1
        } else {
            self.error += 1;
            // 三态互斥归类,避免同一条失败被数两遍(比如 429 同时带 quota_or_rate_limit):
            // 先判限流,再判上游错误,再判客户端取消,其余留在 error 里当"其他"。
            if error_category == "quota_or_rate_limit" || http_status == Some(429) {
                self.rate_limited += 1;
            } else if error_category == "upstream_error" {
                self.upstream_error += 1;
            } else if error_category == "client_canceled" {
                self.client_canceled += 1;
            }
        }
        // 与 cockpit calculate_usage_cost_usd_from_tokens 同口径:
        //   cached = min(cached, input);normal_input = input - cached
        let hit = cached.min(input).max(0);
        let normal = (input - hit).max(0);
        let out = output.max(0);
        if input > LONG_CONTEXT_THRESHOLD_TOKENS {
            self.long_context_min = Some(self.long_context_min.map_or(input, |v| v.min(input)));
            self.long_context_max = Some(self.long_context_max.map_or(input, |v| v.max(input)));
            self.long_normal_input += normal;
            self.long_cached += hit;
            self.long_output += out;
        } else {
            self.std_context_min = Some(self.std_context_min.map_or(input, |v| v.min(input)));
            self.std_context_max = Some(self.std_context_max.map_or(input, |v| v.max(input)));
            self.std_normal_input += normal;
            self.std_cached += hit;
            self.std_output += out;
        }
    }
}

/// 单个时间桶的耗时分位数。
///
/// 为什么单独出这一层,而不是把分位数挂在 `TokenSplit` 上(2026-09-10):
/// cells 是"桶 × 模型"粒度,而分位数**不能跨模型相加**——把 3 个模型的 p95 求平均
/// 或取最大都是编造。延迟曲线要的是"整个桶"的 p95,必须在桶粒度上重新取样本。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BucketLatency {
    pub start_ms: i64,
    /// 该桶内 `latency_ms > 0` 的样本数(用于判断分位数可信度)
    pub samples: i64,
    pub p50_ms: Option<i64>,
    pub p95_ms: Option<i64>,
}

/// 最近秩(nearest-rank)分位数:与常见 p95 定义一致,样本为空时返回 None。
fn percentile(sorted: &[i64], pct: f64) -> Option<i64> {
    if sorted.is_empty() {
        return None;
    }
    let idx = ((sorted.len() - 1) as f64 * pct).round() as usize;
    sorted.get(idx).copied()
}

/// 时间桶 × 模型 的一格(成本趋势 + 逐模型合计都从这里派生)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestLogCell {
    pub start_ms: i64,
    pub model: String,
    /// 服务档位(`service_tier` 原文)。**它已进入聚合键** ⇒ 同一格只可能有一个档位值,
    /// 前端可据此对该格的整批 token 施加档位倍率(priority ×2 / flex ×0.5)。
    ///
    /// 空串 = **日志未记录档位**,不等于 `standard`(倍率上恰好同为 ×1,但措辞不得声称
    /// "这是 standard 档");旧版 cockpit 无该列时同样恒为空串,由 `expr_or` 兜底。
    pub service_tier: String,
    #[serde(flatten)]
    pub split: TokenSplit,
}

/// 模型 × 上游账号 × 网关 API Key 的一格。
///
/// 三个维度合一组,是因为前端的"累计"展示区三者都要(model / 账号 / API Key),
/// 而成本必须**逐模型**计价(不同模型单价不同),所以 key 里必须保留 model;
/// 反过来任何一维都能对它求和得到,不需要再打三份聚合。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestLogGroup {
    pub model: String,
    /// 日志/库里没有 accountId 时为空串(不编造账号归属)
    pub account_id: String,
    /// 发起请求的网关 API Key id(本地网关密钥用量表用)
    pub api_key_id: String,
    /// 服务档位(`service_tier` 原文,已进入聚合键,语义见 [`RequestLogCell::service_tier`])。
    pub service_tier: String,
    /// 窗口内最早/最晚一条请求时间(ms)
    pub first_ms: Option<i64>,
    pub last_ms: Option<i64>,
    #[serde(flatten)]
    pub split: TokenSplit,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestLogSummary {
    /// 库存在且查询成功。false 时前端回退 stats JSON 口径并在 UI 标注。
    pub available: bool,
    /// 不可用原因(库不存在 / 表缺失 / 查询失败),直接展示给排障。
    pub reason: Option<String>,
    /// 实际扫描到的行数(窗口内)
    pub row_count: i64,
    pub window_start_ms: Option<i64>,
    pub window_end_ms: Option<i64>,
    pub bucket_hours: i64,
    pub cells: Vec<RequestLogCell>,
    pub groups: Vec<RequestLogGroup>,
    /// 桶级耗时分位数(与 cells 同桶边界)。
    /// 日志(codex-api.log)只保留 ~5 天,而本库覆盖全量,延迟曲线因此不再断在 5 天前。
    pub bucket_latencies: Vec<BucketLatency>,
}

fn unavailable(reason: impl Into<String>, bucket_hours: i64) -> RequestLogSummary {
    RequestLogSummary {
        available: false,
        reason: Some(reason.into()),
        row_count: 0,
        window_start_ms: None,
        window_end_ms: None,
        bucket_hours,
        cells: Vec::new(),
        groups: Vec::new(),
        bucket_latencies: Vec::new(),
    }
}

/// cockpit 数据目录(`%USERPROFILE%\.antigravity_cockpit`)。路径**只在这里拼**。
pub fn cockpit_data_dir() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "无法定位用户主目录(USERPROFILE/HOME 均未设置)".to_string())?;
    Ok(PathBuf::from(home).join(".antigravity_cockpit"))
}

pub fn request_log_db_path() -> Result<PathBuf, String> {
    Ok(cockpit_data_dir()?.join(REQUEST_LOG_DB_NAME))
}

/// 第二源(`codex_session_usage.sqlite`)的绝对路径。
pub fn session_usage_db_path() -> Result<PathBuf, String> {
    Ok(cockpit_data_dir()?.join(SESSION_USAGE_DB_NAME))
}

/// 只读打开。cockpit 本库是 **WAL 模式**:只读连接需要能读写 -shm,
/// 因此先试只读,失败(通常是要做 WAL 恢复)再退化为可写连接 + `query_only=1`
/// (保证不改动 cockpit 数据,同时允许访问 shm)。
fn open_readonly(path: &PathBuf) -> Result<Connection, String> {
    let ro = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    match Connection::open_with_flags(path, ro) {
        // 这里不用 `return`:整个 `match` 就是函数体尾表达式(`clippy::needless_return`)
        Ok(conn) => finish(conn),
        Err(first) => {
            // 记录首次失败原因,退化仍失败时一并报出,便于排障
            let rw = Connection::open_with_flags(
                path,
                OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(|e| format!("打开用量库失败(只读: {first};可写: {e})"))?;
            finish(rw)
        }
    }
}

fn finish(conn: Connection) -> Result<Connection, String> {
    // query_only:硬性禁止任何写语句,即便退化到可写连接也不动 cockpit 数据
    conn.pragma_update(None, "query_only", true)
        .map_err(|e| format!("设置 query_only 失败: {e}"))?;
    conn.busy_timeout(std::time::Duration::from_millis(5_000))
        .map_err(|e| format!("设置 busy_timeout 失败: {e}"))?;
    Ok(conn)
}

/// `(模型 × 账号 × API Key × 服务档位)` 维度的分档聚合：`键 -> (分档 token, 最小时间戳, 最大时间戳)`。
///
/// 抽别名一是消 `clippy::type_complexity`，二是键与值都是元组、裸写时读的人得自己数位置。
///
/// **服务档位为什么进键**(2026-09-20):档位倍率(priority ×2 / flex ×0.5)只能对
/// "整批同一档位"的 token 施加。若把不同档位合进同一格,格内 token 已无法再拆回档位,
/// 计价侧就只剩两条路——按单一档位猜(编造),或一律 ×1(有 priority 流量时少算 50%)。
/// 进键后每格单档位,倍率可精确施加;代价只是(模型×账号×key)多出几个分组,量级可忽略。
type GroupAggMap = HashMap<(String, String, String, String), (TokenSplit, Option<i64>, Option<i64>)>;

/// 扫描窗口内的单请求用量,按 (时间桶 × 模型) 与 (模型 × 账号 × API Key) 两个维度分档聚合。
///
/// `include_cells = false` 时跳过时间桶聚合(只要"累计"口径的展示区用得上 groups,
/// 桶是纯浪费:实测 17.9 万行里 cells 占近一半开销)。
pub fn summarize(
    path: &PathBuf,
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    bucket_hours: i64,
    include_cells: bool,
) -> Result<RequestLogSummary, String> {
    if !(1..=168).contains(&bucket_hours) {
        return Err("bucket_hours 必须在 1..=168".into());
    }
    if !path.exists() {
        return Ok(unavailable(
            format!("cockpit 用量库不存在: {}（旧版 cockpit 未落库，回退快照口径）", path.display()),
            bucket_hours,
        ));
    }
    let conn = open_readonly(path)?;

    // request_logs 表缺失 = 版本不兼容,如实报不可用以回退,不让成本静默变 0
    let has_table: bool = conn
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='request_logs'")
        .and_then(|mut st| st.query_row([], |_| Ok(true)))
        .unwrap_or(false);
    if !has_table {
        return Ok(unavailable("用量库缺少 request_logs 表（cockpit 版本不兼容）", bucket_hours));
    }

    let bucket_ms = bucket_hours * 3_600_000;
    let lo = start_ms.unwrap_or(i64::MIN);
    let hi = end_ms.unwrap_or(i64::MAX);

    let columns = request_log_columns(&conn);
    // service_tier 走 expr_or:真实库(本机 1.3.45)有该列,旧版没有 ⇒ 兜底成空串
    // (空串 = "日志未记录档位"),而不是让整条 SQL 因缺列失败。
    let sql = format!(
        "SELECT model_id, account_id, api_key_id, timestamp, input_tokens, output_tokens, cached_tokens, success,
         estimated_cost_usd, latency_ms, {}, http_status, {} FROM request_logs WHERE timestamp >= ?1 AND timestamp <= ?2",
        expr_or(&columns, "error_category", "''"),
        expr_or(&columns, "service_tier", "''"),
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("查询 request_logs 失败: {e}"))?;
    let rows = stmt
        .query_map(rusqlite::params![lo, hi], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, f64>(8)?,
                row.get::<_, i64>(9).unwrap_or(0),
                row.get::<_, String>(10).unwrap_or_default(),
                row.get::<_, Option<i64>>(11).unwrap_or(None),
                row.get::<_, String>(12).unwrap_or_default(),
            ))
        })
        .map_err(|e| format!("遍历 request_logs 失败: {e}"))?;

    let mut cells: HashMap<(i64, String, String), TokenSplit> = HashMap::new();
    let mut groups: GroupAggMap = HashMap::new();
    // 桶级耗时样本(与 cells 同桶边界,但**不按模型拆**——分位数不可加)
    let mut bucket_samples: HashMap<i64, Vec<i64>> = HashMap::new();
    let mut row_count = 0i64;
    let mut min_ts: Option<i64> = None;
    let mut max_ts: Option<i64> = None;

    for row in rows {
        let (model, account, api_key, ts, input, output, cached, success, estimated, latency, error_cat, status, service_tier) =
            row.map_err(|e| format!("读取 request_logs 行失败: {e}"))?;
        row_count += 1;
        min_ts = Some(min_ts.map_or(ts, |m: i64| m.min(ts)));
        max_ts = Some(max_ts.map_or(ts, |m: i64| m.max(ts)));

        // 桶边界与 cells 完全一致(div_euclid 对齐 epoch),前端可直接按 start_ms 对齐。
        // 只收 latency_ms > 0 的样本:0 表示 cockpit 未采集到该请求耗时,
        // 混进去会把分位数整体拉向 0,画出一条"快得离谱"的假曲线。
        if latency > 0 {
            let bucket_start = ts.div_euclid(bucket_ms) * bucket_ms;
            bucket_samples.entry(bucket_start).or_default().push(latency);
        }

        if include_cells {
            let bucket_start = ts.div_euclid(bucket_ms) * bucket_ms;
            cells
                .entry((bucket_start, model.clone(), service_tier.clone()))
                .or_default()
                .add(input, output, cached, success != 0, estimated, &error_cat, status);
        }

        let g = groups
            .entry((model, account, api_key, service_tier))
            .or_insert((TokenSplit::default(), None, None));
        g.0.add(input, output, cached, success != 0, estimated, &error_cat, status);
        g.1 = Some(g.1.map_or(ts, |m: i64| m.min(ts)));
        g.2 = Some(g.2.map_or(ts, |m: i64| m.max(ts)));
    }

    let mut cell_list: Vec<RequestLogCell> = cells
        .into_iter()
        .map(|((start_ms, model, service_tier), split)| RequestLogCell { start_ms, model, service_tier, split })
        .collect();
    cell_list.sort_by(|a, b| {
        a.start_ms
            .cmp(&b.start_ms)
            .then(a.model.cmp(&b.model))
            .then(a.service_tier.cmp(&b.service_tier))
    });

    let mut group_list: Vec<RequestLogGroup> = groups
        .into_iter()
        .map(|((model, account_id, api_key_id, service_tier), (split, first_ms, last_ms))| RequestLogGroup {
            model,
            account_id,
            api_key_id,
            service_tier,
            first_ms,
            last_ms,
            split,
        })
        .collect();
    group_list.sort_by(|a, b| {
        a.model
            .cmp(&b.model)
            .then(a.account_id.cmp(&b.account_id))
            .then(a.api_key_id.cmp(&b.api_key_id))
            .then(a.service_tier.cmp(&b.service_tier))
    });

    let mut bucket_latency_list: Vec<BucketLatency> = bucket_samples
        .into_iter()
        .map(|(start_ms, mut samples)| {
            let count = samples.len() as i64;
            samples.sort_unstable();
            BucketLatency {
                start_ms,
                samples: count,
                p50_ms: percentile(&samples, 0.50),
                p95_ms: percentile(&samples, 0.95),
            }
        })
        .collect();
    bucket_latency_list.sort_by_key(|b| b.start_ms);

    Ok(RequestLogSummary {
        available: true,
        reason: None,
        row_count,
        window_start_ms: min_ts,
        window_end_ms: max_ts,
        bucket_hours,
        cells: cell_list,
        groups: group_list,
        bucket_latencies: bucket_latency_list,
    })
}

/// Tauri 命令入口。返回 JSON 字符串(与 `summarize_cockpit_api_logs` 一致返回 Value 也可,
/// 这里用 String 让前端 `JSON.parse` 边界清晰,和 read_cockpit_file 系列保持同风格)。
#[tauri::command]
pub fn summarize_cockpit_request_logs(
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    bucket_hours: i64,
    // 是否要时间桶(cells)。"累计"展示区只要 groups,传 false 省一半开销。
    include_cells: Option<bool>,
) -> Result<String, String> {
    let path = request_log_db_path()?;
    let summary = summarize(&path, start_ms, end_ms, bucket_hours, include_cells.unwrap_or(true))?;
    serde_json::to_string(&summary).map_err(|e| format!("序列化用量聚合失败: {e}"))
}

/// 单个模型的一组**单价快照**(cockpit 当时实际使用的三档单价)。
///
/// 中途调价时同一模型会有多组,故按"组"返回而不是只留一组 —— 只留一组必然骗人。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceVariant {
    pub input_usd_per_million: f64,
    pub output_usd_per_million: f64,
    pub cached_input_usd_per_million: f64,
    /// 使用该组单价的请求数
    pub rows: i64,
    /// 该组里**长上下文**请求数(`input_tokens > 272_000`)。
    ///
    /// 为什么必须有这个数:同一模型在同一窗口**天然会有两组单价** ——
    /// 标准档 + 长文本档(实测 gpt-5.6-sol 5/0.5/30 与 10/1/45 各一组)。
    /// 只看"有两组"会把**正常的长文本档**误报成"窗口内调价"。
    /// 用本字段把两组归位:`standard_rows > 0 && long_context_rows == 0` ⇒ 标准档,反之 ⇒ 长文本档。
    pub long_context_rows: i64,
    /// 该组里**标准档**请求数(`input_tokens <= 272_000`)
    pub standard_rows: i64,
    /// 该组单价下 cockpit 自己算出的成本合计(原样搬运,供对账)
    pub estimated_cost_usd: f64,
    /// 该组对应的价目版本号集合(同一单价可能跨多个版本号)
    pub pricing_versions: Vec<i64>,
}

/// 按模型的单价快照汇总(**对账基准**,不是计价结果)。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPriceSnapshot {
    pub model: String,
    pub rows: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cached_tokens: i64,
    pub reasoning_tokens: i64,
    pub estimated_cost_usd: f64,
    /// 该模型出现过的不同单价组合,按行数降序。>1 表示窗口内调过价。
    pub variants: Vec<PriceVariant>,
}

/// `request_logs` 中**此前未读**的 5 个维度的一次性汇总(PRD 缺口 ③)。
///
/// 为什么单开一个命令而不是塞进 `summarize()`:
/// `summarize()` 是热路径(本机 17.9 万行,cells 聚合占近一半开销),而本结构是
/// **窗口级小结果**(几十行),按需单独取即可,不拖慢主链路。
///
/// # 红线
/// 本结构**不含任何乘法结果**。三档单价是 cockpit 的**原样值**,只作对账基准;
/// 计价唯一入口仍是前端 `cockpitSplitCostUsd()` × `cockpitPriceBook.ts`。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestLogFacets {
    pub available: bool,
    pub reason: Option<String>,
    pub row_count: i64,
    /// 窗口内成功的请求数(`success != 0`)
    pub success_rows: i64,
    /// 窗口内失败的请求数(`success == 0`)
    pub failed_rows: i64,
    /// 失败但 `error_category` 为空的请求数。
    ///
    /// 单列出来是因为:空 `error_category` 里既有成功也有失败,
    /// 混成一个"空分类"数字会让"未知失败"凭空消失。**有量就是有量,不合并。**
    pub failed_without_category: i64,
    /// **失败原因全量分类**(此前 `TokenSplit` 只单独计数 3 类)。
    ///
    /// 本机实测 12 类:upstream_error / request_failed / client_canceled /
    /// quota_or_rate_limit / auth_failed / stream_incomplete / model_not_available /
    /// upstream_first_byte_timeout / account_prepare_failed / cooldown / auth_refresh_failed。
    /// 只计 `success == 0` 的行(成功行不该出现在失败分类里)。
    pub error_categories: BTreeMap<String, i64>,
    /// 推理 token 合计。
    ///
    /// ⚠️ **它是 `output_tokens` 的子集,不是额外量**(2026-09-12 用真实库 15.1 万行验证:
    /// `total_tokens == input + output` 恒成立,且 `estimated_cost_usd` 按 output 复算零偏差)。
    /// 因此**不参与任何计价**,只作可见性展示。
    pub reasoning_tokens: i64,
    /// `reasoning_tokens > 0` 的请求数
    pub reasoning_rows: i64,
    /// `reasoning_effort` 分布(xhigh / medium / max / high / low)。
    /// 旧版 cockpit 无该列时为空表(如实为空,不编造)。
    pub reasoning_efforts: BTreeMap<String, i64>,
    /// 网关模式分布(sidecar / legacy)。回答"有多少请求走了旧通道"。
    pub gateway_modes: BTreeMap<String, i64>,
    /// `request_kind` 分布(text / image_generation / image_edit …)
    pub request_kinds: BTreeMap<String, i64>,
    /// 按模型的单价快照(对账基准),按请求数降序。
    pub price_snapshots: Vec<ModelPriceSnapshot>,
    /// 本次探测到的 `request_logs` 列名(旧库缺列时前端能看出哪些维度不可得)
    pub present_columns: Vec<String>,
    /// 缺失的**可选**列(如 `reasoning_effort` / `gateway_mode`)。
    /// 非空即表示对应维度在 UI 上必须标"该版本 cockpit 不提供",而不是显示 0。
    pub missing_columns: Vec<String>,
}

fn facets_unavailable(reason: impl Into<String>) -> RequestLogFacets {
    RequestLogFacets {
        available: false,
        reason: Some(reason.into()),
        row_count: 0,
        success_rows: 0,
        failed_rows: 0,
        failed_without_category: 0,
        error_categories: BTreeMap::new(),
        reasoning_tokens: 0,
        reasoning_rows: 0,
        reasoning_efforts: BTreeMap::new(),
        gateway_modes: BTreeMap::new(),
        request_kinds: BTreeMap::new(),
        price_snapshots: Vec::new(),
        present_columns: Vec::new(),
        missing_columns: Vec::new(),
    }
}

/// 探测 `request_logs` 的实际列名(忽略大小写)。
fn request_log_columns(conn: &Connection) -> Vec<String> {
    let mut stmt = match conn.prepare("PRAGMA table_info(request_logs)") {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    stmt.query_map([], |row| row.get::<_, String>(1))
        .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
        .unwrap_or_default()
}

/// 缺失即兜底成常量,避免一条 SQL 因旧库缺列整批失败。
fn expr_or(columns: &[String], name: &str, fallback: &str) -> String {
    if columns.iter().any(|c| c.eq_ignore_ascii_case(name)) {
        name.to_string()
    } else {
        fallback.to_string()
    }
}

/// 扫描窗口内 `request_logs` 的**未读维度**,一次返回 5 组汇总(见 [`RequestLogFacets`])。
pub fn facets(
    path: &PathBuf,
    start_ms: Option<i64>,
    end_ms: Option<i64>,
) -> Result<RequestLogFacets, String> {
    if !path.exists() {
        return Ok(facets_unavailable(format!(
            "cockpit 用量库不存在: {}（旧版 cockpit 未落库）",
            path.display()
        )));
    }
    let conn = open_readonly(path)?;
    let has_table: bool = conn
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='request_logs'")
        .and_then(|mut st| st.query_row([], |_| Ok(true)))
        .unwrap_or(false);
    if !has_table {
        return Ok(facets_unavailable("用量库缺少 request_logs 表（cockpit 版本不兼容）"));
    }

    let columns = request_log_columns(&conn);
    // 可选列缺失时如实记录(前端据此标"该版本不提供",而不是显示 0)
    let optional = [
        "error_category",
        "reasoning_tokens",
        "reasoning_effort",
        "gateway_mode",
        "request_kind",
        "input_usd_per_million",
        "output_usd_per_million",
        "cached_input_usd_per_million",
        "model_pricing_version",
        // 2026-09-21 补:这 4 列此前也用 expr_or(...,"0") 兜底却**不在** optional 列表里
        // ⇒ 缺列时既不上报 missing_columns,也没有任何守卫,静默出全 0。
        "input_tokens",
        "output_tokens",
        "cached_tokens",
        "estimated_cost_usd",
    ];
    let missing_columns: Vec<String> = optional
        .iter()
        .filter(|c| !columns.iter().any(|p| p.eq_ignore_ascii_case(c)))
        .map(|c| (*c).to_string())
        .collect();
    // 单价三列缺任意一列 ⇒ 整份 price_snapshots 不发出去。
    // 否则 expr_or(...,"0") 会把"源没落单价"变成 (0,0,0) 三元组,
    // 前端 `pricePair` 的 `v == null ? '—'` 永远走不到,「我们的价目 vs 源实际单价」
    // 那一列会显示 `$0.00/M` —— 徽标写着"源无单价"、数字写着 0,自相矛盾(假零)。
    // 置空后前端落到既有分支「数据源未提供单价快照(该版本 cockpit 不落三档单价)」。
    let price_columns_present = ["input_usd_per_million", "output_usd_per_million", "cached_input_usd_per_million"]
        .iter()
        .all(|c| columns.iter().any(|p| p.eq_ignore_ascii_case(c)));

    let lo = start_ms.unwrap_or(i64::MIN);
    let hi = end_ms.unwrap_or(i64::MAX);
    let sql = format!(
        "SELECT model_id, success, \
         {}, {}, {}, {}, \
         {}, {}, {}, {}, \
         {}, {}, {}, {} \
         FROM request_logs WHERE timestamp >= ?1 AND timestamp <= ?2",
        expr_or(&columns, "error_category", "''"),
        expr_or(&columns, "reasoning_tokens", "0"),
        expr_or(&columns, "reasoning_effort", "''"),
        expr_or(&columns, "gateway_mode", "''"),
        expr_or(&columns, "request_kind", "''"),
        expr_or(&columns, "input_usd_per_million", "0"),
        expr_or(&columns, "output_usd_per_million", "0"),
        expr_or(&columns, "cached_input_usd_per_million", "0"),
        expr_or(&columns, "input_tokens", "0"),
        expr_or(&columns, "output_tokens", "0"),
        expr_or(&columns, "cached_tokens", "0"),
        expr_or(&columns, "estimated_cost_usd", "0"),
    );

    let mut stmt = conn.prepare(&sql).map_err(|e| format!("查询 request_logs 失败: {e}"))?;
    let rows = stmt
        .query_map(rusqlite::params![lo, hi], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1).unwrap_or(0),
                row.get::<_, String>(2).unwrap_or_default(),
                row.get::<_, i64>(3).unwrap_or(0),
                row.get::<_, String>(4).unwrap_or_default(),
                row.get::<_, String>(5).unwrap_or_default(),
                row.get::<_, String>(6).unwrap_or_default(),
                row.get::<_, f64>(7).unwrap_or(0.0),
                row.get::<_, f64>(8).unwrap_or(0.0),
                row.get::<_, f64>(9).unwrap_or(0.0),
                row.get::<_, i64>(10).unwrap_or(0),
                row.get::<_, i64>(11).unwrap_or(0),
                row.get::<_, i64>(12).unwrap_or(0),
                row.get::<_, f64>(13).unwrap_or(0.0),
            ))
        })
        .map_err(|e| format!("遍历 request_logs 失败: {e}"))?;

    let mut out = facets_unavailable("");
    out.available = true;
    out.reason = None;
    out.present_columns = columns.clone();
    out.missing_columns = missing_columns;

    // 单价版本号单独查一次(它不在上面 14 列里,避免主循环变宽)
    let pricing_expr = expr_or(&columns, "model_pricing_version", "NULL");
    let has_pricing = !pricing_expr.eq_ignore_ascii_case("NULL");
    let mut price_versions: HashMap<String, Vec<i64>> = HashMap::new();
    if has_pricing {
        let vsql = format!(
            "SELECT model_id, {pricing_expr} FROM request_logs \
             WHERE timestamp >= ?1 AND timestamp <= ?2 AND {pricing_expr} IS NOT NULL"
        );
        if let Ok(mut vstmt) = conn.prepare(&vsql) {
            if let Ok(vrows) = vstmt.query_map(rusqlite::params![lo, hi], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            }) {
                for v in vrows.flatten() {
                    price_versions.entry(v.0).or_default().push(v.1);
                }
            }
        }
    }

    // 模型 → (单价三元组 → 聚合)。单价三元组用 f64 位模式做键,避免 NaN/-0.0 串组。
    #[derive(Default)]
    struct VariantAgg {
        rows: i64,
        cost: f64,
        long_context_rows: i64,
        standard_rows: i64,
    }
    #[derive(Default)]
    struct ModelAgg {
        rows: i64,
        input: i64,
        output: i64,
        cached: i64,
        reasoning: i64,
        cost: f64,
        variants: HashMap<(u64, u64, u64), VariantAgg>,
    }
    let mut models: HashMap<String, ModelAgg> = HashMap::new();

    for row in rows {
        let (
            model, success, error_cat, reasoning, effort, gateway, kind,
            in_p, out_p, cached_p, input_tok, output_tok, cached_tok, cost,
        ) = row.map_err(|e| format!("读取 request_logs 行失败: {e}"))?;

        out.row_count += 1;
        if success != 0 {
            out.success_rows += 1;
        } else {
            out.failed_rows += 1;
            let cat = error_cat.trim();
            if cat.is_empty() {
                // 失败但无分类:单独计数,不混进"空分类"里凭空消失
                out.failed_without_category += 1;
            } else {
                *out.error_categories.entry(cat.to_string()).or_insert(0) += 1;
            }
        }
        if reasoning > 0 {
            out.reasoning_tokens += reasoning;
            out.reasoning_rows += 1;
        }
        for (raw, map) in [
            (effort, &mut out.reasoning_efforts),
            (gateway, &mut out.gateway_modes),
            (kind, &mut out.request_kinds),
        ] {
            let v = raw.trim();
            if !v.is_empty() {
                *map.entry(v.to_string()).or_insert(0) += 1;
            }
        }

        let m = models.entry(model).or_default();
        m.rows += 1;
        m.input += input_tok;
        m.output += output_tok;
        m.cached += cached_tok;
        m.reasoning += reasoning;
        m.cost += if cost.is_finite() { cost } else { 0.0 };
        let key = (in_p.to_bits(), out_p.to_bits(), cached_p.to_bits());
        let v = m.variants.entry(key).or_default();
        v.rows += 1;
        v.cost += if cost.is_finite() { cost } else { 0.0 };
        // 用长上下文档位给单价组"归位":两组单价里哪组是标准档、哪组是长文本档
        if input_tok > LONG_CONTEXT_THRESHOLD_TOKENS {
            v.long_context_rows += 1;
        } else {
            v.standard_rows += 1;
        }
    }

    let mut snapshots: Vec<ModelPriceSnapshot> = Vec::with_capacity(models.len());
    for (model, agg) in models {
        let versions = {
            let mut vs = price_versions.get(&model).cloned().unwrap_or_default();
            vs.sort_unstable();
            vs.dedup();
            vs
        };
        let mut variants: Vec<PriceVariant> = agg
            .variants
            .into_iter()
            .map(|((ib, ob, cb), v)| PriceVariant {
                input_usd_per_million: f64::from_bits(ib),
                output_usd_per_million: f64::from_bits(ob),
                cached_input_usd_per_million: f64::from_bits(cb),
                rows: v.rows,
                long_context_rows: v.long_context_rows,
                standard_rows: v.standard_rows,
                estimated_cost_usd: v.cost,
                pricing_versions: versions.clone(),
            })
            .collect();
        variants.sort_by_key(|v| std::cmp::Reverse(v.rows));
        snapshots.push(ModelPriceSnapshot {
            model,
            rows: agg.rows,
            input_tokens: agg.input,
            output_tokens: agg.output,
            cached_tokens: agg.cached,
            reasoning_tokens: agg.reasoning,
            estimated_cost_usd: agg.cost,
            variants,
        });
    }
    snapshots.sort_by(|a, b| b.rows.cmp(&a.rows).then(a.model.cmp(&b.model)));
    // 单价列缺失 ⇒ 宁可整份不发(前端如实显示"该版本不提供"),也不发一组 0 单价。
    // 发 (0,0,0) 会让前端 `pricePair` 的 `v == null ? '—'` 永远走不到,
    // 「我们的价目 vs 源实际单价」那一列渲染成 `$0.00/M` —— 假零。
    out.price_snapshots = if price_columns_present { snapshots } else { Vec::new() };

    Ok(out)
}

/// Tauri 命令:读取 `request_logs` 的未读维度汇总(缺口 ③)。
#[tauri::command]
pub fn cockpit_request_log_facets(
    start_ms: Option<i64>,
    end_ms: Option<i64>,
) -> Result<String, String> {
    let path = request_log_db_path()?;
    let f = facets(&path, start_ms, end_ms)?;
    serde_json::to_string(&f).map_err(|e| format!("序列化用量维度汇总失败: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 建一个最小 request_logs 表(列与 cockpit 实际库一致的子集)。
    fn seed(dir: &std::path::Path) -> PathBuf {
        let path = dir.join(REQUEST_LOG_DB_NAME);
        let conn = Connection::open(&path).expect("建库");
        conn.execute_batch(
            "CREATE TABLE request_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_key TEXT NOT NULL UNIQUE,
                timestamp INTEGER NOT NULL,
                account_id TEXT NOT NULL DEFAULT '',
                email TEXT NOT NULL DEFAULT '',
                api_key_id TEXT NOT NULL DEFAULT '',
                api_key_label TEXT NOT NULL DEFAULT '',
                model_id TEXT NOT NULL DEFAULT '',
                request_kind TEXT NOT NULL DEFAULT 'other',
                -- 与真实库(本机 cockpit 1.3.45)一致:该列必须在夹具里,
                -- 否则测试永远覆盖不到「按服务档位拆聚合」这条真实 schema 的路径。
                service_tier TEXT NOT NULL DEFAULT '',
                success INTEGER NOT NULL DEFAULT 0,
                error_category TEXT NOT NULL DEFAULT '',
                latency_ms INTEGER NOT NULL DEFAULT 0,
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                total_tokens INTEGER NOT NULL DEFAULT 0,
                cached_tokens INTEGER NOT NULL DEFAULT 0,
                reasoning_tokens INTEGER NOT NULL DEFAULT 0,
                request_id TEXT NOT NULL DEFAULT '',
                -- 与 cockpit 真实库一致:可空(旧版本没有这一列,老记录为 NULL)。
                -- 写成 NOT NULL DEFAULT 0 会让未知状态码被当成 0,与真实数据不符。
                http_status INTEGER,
                error_message TEXT NOT NULL DEFAULT '',
                estimated_cost_usd REAL NOT NULL DEFAULT 0,
                input_usd_per_million REAL NOT NULL DEFAULT 0,
                output_usd_per_million REAL NOT NULL DEFAULT 0,
                cached_input_usd_per_million REAL NOT NULL DEFAULT 0
             );
             CREATE INDEX idx_ts ON request_logs(timestamp DESC);",
        )
        .expect("建表");
        path
    }

    #[allow(clippy::too_many_arguments)] // 夹具:列多但都是一次性字面量,封成结构体反而更难读
    fn insert(conn: &Connection, id: i64, ts: i64, model: &str, acc: &str, i: i64, o: i64, c: i64, ok: i64) {
        insert_with_latency(conn, id, ts, model, acc, i, o, c, ok, 0);
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_with_latency(
        conn: &Connection,
        id: i64,
        ts: i64,
        model: &str,
        acc: &str,
        i: i64,
        o: i64,
        c: i64,
        ok: i64,
        latency_ms: i64,
    ) {
        conn.execute(
            "INSERT INTO request_logs (id, event_key, timestamp, account_id, model_id, success,
             input_tokens, output_tokens, cached_tokens, latency_ms) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            rusqlite::params![id, format!("k{id}"), ts, acc, model, ok, i, o, c, latency_ms],
        )
        .expect("插入");
    }

    /// 桶级耗时分位数:延迟曲线在 7d/30d 唯一能站得住的数据来源
    /// (cockpit 日志只保留 ~5 天,而本库覆盖全量)。
    #[test]
    fn bucket_latencies_use_nearest_rank_and_skip_zero_samples() {
        let dir = std::env::temp_dir().join(format!("cockpit_logs_db_lat_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let path = seed(&dir);
        let hour = 3_600_000i64;
        {
            let conn = Connection::open(&path).unwrap();
            // 桶 0:1,2,...,10 秒里取 10 个样本(毫秒),最近秩 p95 = 第 (10-1)*0.95≈9 → 10_000
            for n in 1..=10 {
                insert_with_latency(&conn, n, n * 1_000, "m", "acc-a", 10, 1, 0, 1, n * 1_000);
            }
            // latency_ms = 0 表示 cockpit 未采集,不能混进样本
            insert_with_latency(&conn, 11, 11_000, "m", "acc-a", 10, 1, 0, 1, 0);
            // 桶 1(下一小时):单样本
            insert_with_latency(&conn, 12, hour + 5_000, "m", "acc-a", 10, 1, 0, 1, 7_000);
        }
        let s = summarize(&path, None, None, 1, true).expect("聚合成功");
        assert_eq!(s.bucket_latencies.len(), 2, "两个小时各一桶");

        let b0 = &s.bucket_latencies[0];
        assert_eq!(b0.start_ms, 0);
        assert_eq!(b0.samples, 10, "latency_ms=0 的那条不算样本");
        assert_eq!(b0.p50_ms, Some(6_000), "最近秩 p50 = 第 (10-1)*0.5≈5 → 6_000");
        assert_eq!(b0.p95_ms, Some(10_000));

        let b1 = &s.bucket_latencies[1];
        assert_eq!(b1.start_ms, hour);
        assert_eq!(b1.samples, 1);
        assert_eq!(b1.p95_ms, Some(7_000), "单样本时 p95 就是它自己");
    }

    /// 失败原因三态分类(2026-09-11):限流 / 上游错误 / 客户端取消互斥归类,
    /// 同一条失败只算一次——否则"账号健康"三态之和会超过失败总数。
    #[test]
    fn failure_categories_are_exclusive_and_complete() {
        let dir = std::env::temp_dir().join(format!("cockpit_logs_db_cat_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let path = seed(&dir);
        {
            let conn = Connection::open(&path).unwrap();
            let mut id = 0;
            let mut put = |category: &str, status: Option<i64>, ok: i64| {
                id += 1;
                conn.execute(
                    "INSERT INTO request_logs (id, event_key, timestamp, account_id, model_id, success,
                     input_tokens, output_tokens, cached_tokens, error_category, http_status)
                     VALUES (?1,?2,?3,'acc-a','m',?4,10,1,0,?5,?6)",
                    rusqlite::params![id, format!("k{id}"), id * 1_000, ok, category, status],
                )
                .expect("插入");
            };
            put("", None, 1); // 成功
            put("quota_or_rate_limit", None, 0); // 限流(按分类)
            put("", Some(429), 0); // 限流(按状态码)
            put("upstream_error", Some(503), 0); // 上游错误
            put("client_canceled", None, 0); // 客户端取消
            put("request_failed", None, 0); // 其他失败:不进任何分类
        }
        let s = summarize(&path, None, None, 1, true).expect("聚合成功");
        let split = &s.groups[0].split;
        assert_eq!(split.success, 1);
        assert_eq!(split.error, 5);
        assert_eq!(split.rate_limited, 2, "限流按分类与状态码各命中一次");
        assert_eq!(split.upstream_error, 1);
        assert_eq!(split.client_canceled, 1);
        // 三态互斥:分类计数之和(4)必须 ≤ 失败总数(5),"其他"留在 error 里
        assert!(
            split.rate_limited + split.upstream_error + split.client_canceled <= split.error,
            "同一条失败不能被数两遍"
        );
    }

    /// 全部请求都没有耗时样本时,p50/p95 必须是 None——宁可图上断点,也不填 0。
    #[test]
    fn bucket_latencies_are_none_without_samples() {
        let dir = std::env::temp_dir().join(format!("cockpit_logs_db_nolat_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let path = seed(&dir);
        {
            let conn = Connection::open(&path).unwrap();
            insert(&conn, 1, 1_000, "m", "acc-a", 10, 1, 0, 1);
        }
        let s = summarize(&path, None, None, 1, true).expect("聚合成功");
        assert!(s.bucket_latencies.is_empty(), "没有正样本就不产出桶延迟");
    }

    /// 带服务档位的插入(档位进聚合键,故夹具必须能写入该列)。
    #[allow(clippy::too_many_arguments)]
    fn insert_with_tier(
        conn: &Connection,
        id: i64,
        ts: i64,
        model: &str,
        acc: &str,
        i: i64,
        o: i64,
        c: i64,
        ok: i64,
        tier: &str,
    ) {
        conn.execute(
            "INSERT INTO request_logs (id, event_key, timestamp, account_id, model_id, success,
             input_tokens, output_tokens, cached_tokens, latency_ms, service_tier)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,0,?10)",
            rusqlite::params![id, format!("k{id}"), ts, acc, model, ok, i, o, c, tier],
        )
        .expect("插入");
    }

    /// `service_tier` 必须进聚合键(2026-09-20):同一 (模型×账号×key)、同一时间桶里
    /// 若把不同档位合成一批,前端就只能按单一档位猜(编造)或一律 ×1(有 priority 流量时少算 50%)。
    #[test]
    fn service_tier_splits_groups_and_cells() {
        let dir = std::env::temp_dir().join(format!("cockpit_logs_db_tier_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let path = seed(&dir);
        {
            let conn = Connection::open(&path).unwrap();
            insert_with_tier(&conn, 1, 1_000, "gpt-6-astra", "acc-a", 1_000, 10, 0, 1, "");
            insert_with_tier(&conn, 2, 2_000, "gpt-6-astra", "acc-a", 2_000, 20, 0, 1, "standard");
            insert_with_tier(&conn, 3, 3_000, "gpt-6-astra", "acc-a", 3_000, 30, 0, 1, "priority");
        }
        let s = summarize(&path, None, None, 1, true).expect("聚合成功");

        // 组:三个档位值各成一组,不被合并
        assert_eq!(s.groups.len(), 3, "档位不同必须分组,不能合成一批");
        let tiers: Vec<&str> = s.groups.iter().map(|g| g.service_tier.as_str()).collect();
        assert!(tiers.contains(&""), "空串档位如实保留,不得改写成 standard");
        assert!(tiers.contains(&"standard"));
        assert!(tiers.contains(&"priority"));
        let prio = s.groups.iter().find(|g| g.service_tier == "priority").expect("priority 组");
        assert_eq!(prio.split.requests, 1);
        assert_eq!(prio.split.std_normal_input, 3_000, "priority 组只装自己的 token");

        // 格(桶 × 模型 × 档位):同一小时桶同样按档位拆开
        assert_eq!(s.cells.len(), 3, "同桶同模型的不同档位不能合进一格");
        let prio_cell = s.cells.iter().find(|c| c.service_tier == "priority").expect("priority 格");
        assert_eq!(prio_cell.model, "gpt-6-astra");
        assert_eq!(prio_cell.split.std_normal_input, 3_000);
    }

    /// 旧版 cockpit 无 `service_tier` 列时,整条 SQL 不能失败;档位如实为空串(未记录)。
    #[test]
    fn missing_service_tier_column_falls_back_to_empty() {
        let dir = std::env::temp_dir().join(format!("cockpit_logs_db_notier_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let path = dir.join(REQUEST_LOG_DB_NAME);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE request_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_key TEXT NOT NULL UNIQUE,
                    timestamp INTEGER NOT NULL,
                    account_id TEXT NOT NULL DEFAULT '',
                    api_key_id TEXT NOT NULL DEFAULT '',
                    model_id TEXT NOT NULL DEFAULT '',
                    success INTEGER NOT NULL DEFAULT 0,
                    input_tokens INTEGER NOT NULL DEFAULT 0,
                    output_tokens INTEGER NOT NULL DEFAULT 0,
                    cached_tokens INTEGER NOT NULL DEFAULT 0,
                    latency_ms INTEGER NOT NULL DEFAULT 0,
                    estimated_cost_usd REAL NOT NULL DEFAULT 0,
                    http_status INTEGER
                 );",
            )
            .expect("建老表");
            conn.execute(
                "INSERT INTO request_logs (id, event_key, timestamp, account_id, model_id, success, input_tokens)
                 VALUES (1,'k1',1000,'acc-a','m',1,500)",
                [],
            )
            .expect("插入");
        }
        let s = summarize(&path, None, None, 1, true).expect("缺列也要能聚合");
        assert_eq!(s.groups.len(), 1);
        assert_eq!(s.groups[0].service_tier, "", "缺列 ⇒ 空串(未记录),不得编造 standard");
    }

    #[test]
    fn splits_long_context_by_single_request_input_tokens() {
        let dir = std::env::temp_dir().join(format!("cockpit_logs_db_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let path = seed(&dir);
        {
            let conn = Connection::open(&path).unwrap();
            // 标准档:input 1000,其中 400 命中缓存 → normal 600 / cached 400
            insert(&conn, 1, 1_000_000_000, "gpt-6-astra", "acc-a", 1000, 50, 400, 1);
            // 长文本档:input 恰好 272_000 仍走标准档(阈值是严格大于)
            insert(&conn, 2, 1_000_000_001, "gpt-6-astra", "acc-a", 272_000, 10, 0, 1);
            // 长文本档:input 272_001 ;cached 故意大于 input,验证子集裁剪 min(cached,input)
            insert(&conn, 3, 1_000_000_002, "gpt-6-astra", "acc-b", 272_001, 20, 999_999, 0);
        }
        let s = summarize(&path, None, None, 1, true).expect("聚合成功");
        assert!(s.available, "库存在应可用: {:?}", s.reason);
        assert_eq!(s.row_count, 3);
        assert_eq!(s.groups.len(), 2, "两个账号各一组");

        let a = s.groups.iter().find(|g| g.account_id == "acc-a").expect("acc-a");
        assert_eq!(a.split.requests, 2);
        assert_eq!(a.split.success, 2);
        assert_eq!((a.split.std_normal_input, a.split.std_cached, a.split.std_output), (600 + 272_000, 400, 60));
        assert_eq!((a.split.long_normal_input, a.split.long_cached, a.split.long_output), (0, 0, 0));
        assert_eq!((a.split.std_context_min, a.split.std_context_max), (Some(1000), Some(272_000)));
        assert_eq!((a.split.long_context_min, a.split.long_context_max), (None, None));

        let b = s.groups.iter().find(|g| g.account_id == "acc-b").expect("acc-b");
        assert_eq!(b.split.requests, 1);
        assert_eq!(b.split.error, 1, "success=0 计入 error");
        // cached 被裁剪为 input → normal 0,cached 272_001
        assert_eq!((b.split.long_normal_input, b.split.long_cached, b.split.long_output), (0, 272_001, 20));
        assert_eq!((b.split.long_context_min, b.split.long_context_max), (Some(272_001), Some(272_001)));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn buckets_by_hour_and_filters_window() {
        let dir = std::env::temp_dir().join(format!("cockpit_logs_db_win_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let path = seed(&dir);
        let hour = 3_600_000i64;
        {
            let conn = Connection::open(&path).unwrap();
            insert(&conn, 1, hour * 10 + 5, "m1", "a", 10, 1, 0, 1);
            insert(&conn, 2, hour * 11 + 5, "m1", "a", 20, 2, 0, 1);
            insert(&conn, 3, hour * 40 + 5, "m1", "a", 30, 3, 0, 1); // 窗口外
        }
        let s = summarize(&path, Some(hour * 10), Some(hour * 12), 1, true).expect("聚合成功");
        assert_eq!(s.row_count, 2, "窗口过滤生效");
        let starts: Vec<i64> = s.cells.iter().map(|c| c.start_ms).collect();
        assert_eq!(starts, vec![hour * 10, hour * 11], "按小时分桶且升序");
        assert_eq!(s.cells[0].split.std_normal_input, 10);
        assert_eq!(s.cells[1].split.std_normal_input, 20);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn groups_carry_api_key_and_can_skip_bucket_cells() {
        let dir = std::env::temp_dir().join(format!("cockpit_logs_db_key_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let path = seed(&dir);
        {
            let conn = Connection::open(&path).unwrap();
            // 同一账号 acc-a:两条走不同 API Key,一条没带 Key
            insert(&conn, 1, 1_000_000_001, "gpt-6-astra", "acc-a", 1000, 50, 0, 1);
            insert(&conn, 2, 1_000_000_002, "gpt-6-astra", "acc-a", 2000, 60, 0, 1);
            insert(&conn, 3, 1_000_000_003, "gpt-6-astra", "acc-a", 10, 1, 0, 1);
            conn.execute("UPDATE request_logs SET api_key_id = 'key_A' WHERE id = 1", [])
                .expect("设置 key_A");
            conn.execute("UPDATE request_logs SET api_key_id = 'key_B' WHERE id = 2", [])
                .expect("设置 key_B");
        }
        // include_cells = false:只保留 groups,cells 为空(省一半开销)
        let s = summarize(&path, None, None, 1, false).expect("聚合成功");
        assert_eq!(s.row_count, 3);
        assert!(s.cells.is_empty(), "跳过桶聚合时 cells 应为空");
        let a: Vec<_> = s.groups.iter().filter(|g| g.api_key_id == "key_A").collect();
        assert_eq!(a.len(), 1, "api_key_id 参与分组");
        assert_eq!(a[0].split.requests, 1);
        let b: Vec<_> = s.groups.iter().filter(|g| g.api_key_id == "key_B").collect();
        assert_eq!(b.len(), 1);
        // 同一账号 acc-a 下有两个 API Key → 组数应为 3(acc-a/key_A, acc-a/key_B, acc-a/'')
        assert_eq!(s.groups.iter().filter(|g| g.account_id == "acc-a").count(), 3);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_db_reports_unavailable_instead_of_error() {
        let path = std::env::temp_dir().join(format!("no_such_db_{}.sqlite", std::process::id()));
        let s = summarize(&path, None, None, 6, true).expect("不应返回 Err");
        assert!(!s.available);
        assert!(s.reason.unwrap_or_default().contains("不存在"));
    }

    // ---------------------------------------------------------------- facets(缺口 ③)

    /// 真实 cockpit 库的**完整**列集(比 `seed()` 多出 reasoning_effort / gateway_mode /
    /// model_pricing_version 三列)。`seed()` 用的是"旧版缺列"子集,两者都要覆盖。
    fn seed_full(dir: &std::path::Path) -> PathBuf {
        let path = dir.join(REQUEST_LOG_DB_NAME);
        let conn = Connection::open(&path).expect("建库");
        conn.execute_batch(
            "CREATE TABLE request_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_key TEXT NOT NULL UNIQUE,
                timestamp INTEGER NOT NULL,
                account_id TEXT NOT NULL DEFAULT '',
                model_id TEXT NOT NULL DEFAULT '',
                request_kind TEXT NOT NULL DEFAULT 'text',
                success INTEGER NOT NULL DEFAULT 0,
                error_category TEXT NOT NULL DEFAULT '',
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                cached_tokens INTEGER NOT NULL DEFAULT 0,
                reasoning_tokens INTEGER NOT NULL DEFAULT 0,
                estimated_cost_usd REAL NOT NULL DEFAULT 0,
                input_usd_per_million REAL NOT NULL DEFAULT 0,
                output_usd_per_million REAL NOT NULL DEFAULT 0,
                cached_input_usd_per_million REAL NOT NULL DEFAULT 0,
                reasoning_effort TEXT NOT NULL DEFAULT '',
                gateway_mode TEXT NOT NULL DEFAULT '',
                model_pricing_version INTEGER NOT NULL DEFAULT 0
             );",
        )
        .expect("建表");
        path
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_facet(
        conn: &Connection,
        id: i64,
        ts: i64,
        model: &str,
        ok: i64,
        cat: &str,
        i: i64,
        o: i64,
        c: i64,
        reas: i64,
        effort: &str,
        gateway: &str,
        in_p: f64,
        out_p: f64,
        cached_p: f64,
        ver: i64,
    ) {
        conn.execute(
            "INSERT INTO request_logs (id, event_key, timestamp, account_id, model_id, success,
             error_category, input_tokens, output_tokens, cached_tokens, reasoning_tokens,
             estimated_cost_usd, input_usd_per_million, output_usd_per_million,
             cached_input_usd_per_million, reasoning_effort, gateway_mode, model_pricing_version)
             VALUES (?1,?2,?3,'acc-a',?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)",
            rusqlite::params![
                id,
                format!("k{id}"),
                ts,
                model,
                ok,
                cat,
                i,
                o,
                c,
                reas,
                // 与真实口径一致:cache_write 按 input 单价计,故 estimated = (i-c)*inP + c*cachedP + o*outP
                ((i - c.min(i)) as f64 * in_p + c.min(i) as f64 * cached_p + o as f64 * out_p) / 1e6,
                in_p,
                out_p,
                cached_p,
                effort,
                gateway,
                ver,
            ],
        )
        .expect("插入");
    }

    #[test]
    fn facets_absent_db_reports_unavailable_instead_of_error() {
        let path = std::env::temp_dir().join(format!("no_such_facets_{}.sqlite", std::process::id()));
        let f = facets(&path, None, None).expect("不应返回 Err");
        assert!(!f.available, "库不存在必须如实报不可用");
        assert!(f.reason.unwrap_or_default().contains("不存在"));
        assert_eq!(f.row_count, 0);
        assert!(f.error_categories.is_empty(), "不可用时不得编造分类");
    }

    /// 旧版 cockpit 缺 `reasoning_effort` / `gateway_mode` / `model_pricing_version` 时,
    /// 对应维度必须**如实为空并列入 missing_columns**,而不是显示 0 或整条查询失败。
    #[test]
    fn facets_old_schema_reports_missing_columns_instead_of_zeroing() {
        let dir = std::env::temp_dir().join(format!("cockpit_facets_old_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let path = seed(&dir);
        {
            let conn = Connection::open(&path).unwrap();
            insert(&conn, 1, 1_000, "m-a", "acc-a", 100, 10, 0, 1);
            insert(&conn, 2, 2_000, "m-a", "acc-a", 100, 10, 0, 0);
        }
        let f = facets(&path, None, None).expect("旧库也必须能读");
        assert!(f.available);
        assert_eq!(f.row_count, 2);
        for col in ["reasoning_effort", "gateway_mode", "model_pricing_version"] {
            assert!(
                f.missing_columns.iter().any(|c| c == col),
                "缺列必须如实上报,实际 {:?}",
                f.missing_columns
            );
        }
        assert!(f.reasoning_efforts.is_empty(), "缺列时不得编造分布");
        assert!(f.gateway_modes.is_empty(), "缺列时不得编造分布");
        // 老库仍能给出单价快照(这三列本来就有)
        assert_eq!(f.price_snapshots.len(), 1);
        assert_eq!(f.price_snapshots[0].model, "m-a");
        assert_eq!(f.price_snapshots[0].rows, 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 单价三列缺失时**不得**发出 0 单价快照。
    ///
    /// 前端 `pricePair` 的诚实分支是 `v == null ? '—' : …`;发一组 (0,0,0) 会让它
    /// 渲染成 `$0.00/M` —— 徽标写着"源无单价"、数字写着 0,自相矛盾(假零)。
    /// 所以这里要的是"**缺失 ⇒ 没有快照**"这个信号,前端落到既有空态分支。
    /// 顺带覆盖 2026-09-21 新加进 optional 的 `cached_tokens` / `estimated_cost_usd`:
    /// 这两列此前也用 expr_or(...,"0") 兜底却不在 optional 里,缺列时**无人上报**。
    #[test]
    fn facets_missing_price_columns_emit_no_snapshots_instead_of_zero_prices() {
        let dir = std::env::temp_dir().join(format!("cockpit_facets_noprice_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let path = dir.join(REQUEST_LOG_DB_NAME);
        {
            let conn = Connection::open(&path).expect("建库");
            conn.execute_batch(
                "CREATE TABLE request_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_key TEXT NOT NULL UNIQUE,
                    timestamp INTEGER NOT NULL,
                    model_id TEXT NOT NULL DEFAULT '',
                    success INTEGER NOT NULL DEFAULT 0,
                    input_tokens INTEGER NOT NULL DEFAULT 0,
                    output_tokens INTEGER NOT NULL DEFAULT 0
                 );
                 INSERT INTO request_logs (event_key, timestamp, model_id, success, input_tokens, output_tokens)
                 VALUES ('k1', 1000, 'm-a', 1, 100, 10);",
            )
            .expect("建表并插行");
        }
        let f = facets(&path, None, None).expect("缺单价列也必须能读,不能整条失败");
        assert!(f.available);
        assert_eq!(f.row_count, 1);
        for col in [
            "input_usd_per_million",
            "output_usd_per_million",
            "cached_input_usd_per_million",
            "cached_tokens",
            "estimated_cost_usd",
            "reasoning_tokens",
        ] {
            assert!(
                f.missing_columns.iter().any(|c| c == col),
                "缺列必须如实上报 {col},实际 {:?}",
                f.missing_columns
            );
        }
        assert!(
            f.price_snapshots.is_empty(),
            "缺单价列时不得发 0 单价快照(前端会渲染成 $0.00/M),实际 {} 条",
            f.price_snapshots.len()
        );
        // 成对反例:token 列都在 ⇒ 聚合出的 token 仍是真值,不得被上面的守卫一并抹掉
        assert_eq!(f.reasoning_tokens, 0);
        assert_eq!(f.success_rows, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 成对反例(防守卫过度):单价三列**都在**、只是别的可选列缺失时,
    /// 单价快照必须照常发出 —— 否则这个守卫就从"防假零"变成了"藏真数据"。
    #[test]
    fn facets_price_columns_present_still_emit_snapshots_when_other_optional_columns_are_missing() {
        let dir = std::env::temp_dir().join(format!("cockpit_facets_pricesok_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let path = dir.join(REQUEST_LOG_DB_NAME);
        {
            let conn = Connection::open(&path).expect("建库");
            conn.execute_batch(
                "CREATE TABLE request_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    event_key TEXT NOT NULL UNIQUE,
                    timestamp INTEGER NOT NULL,
                    model_id TEXT NOT NULL DEFAULT '',
                    success INTEGER NOT NULL DEFAULT 0,
                    input_tokens INTEGER NOT NULL DEFAULT 0,
                    output_tokens INTEGER NOT NULL DEFAULT 0,
                    cached_tokens INTEGER NOT NULL DEFAULT 0,
                    estimated_cost_usd REAL NOT NULL DEFAULT 0,
                    input_usd_per_million REAL NOT NULL DEFAULT 0,
                    output_usd_per_million REAL NOT NULL DEFAULT 0,
                    cached_input_usd_per_million REAL NOT NULL DEFAULT 0
                 );
                 INSERT INTO request_logs
                   (event_key, timestamp, model_id, success, input_tokens, output_tokens, cached_tokens,
                    estimated_cost_usd, input_usd_per_million, output_usd_per_million, cached_input_usd_per_million)
                 VALUES ('k1', 1000, 'm-a', 1, 100, 10, 0, 0.5, 10.0, 50.0, 1.0);",
            )
            .expect("建表并插行");
        }
        let f = facets(&path, None, None).expect("读取失败");
        assert!(f.available);
        assert_eq!(f.price_snapshots.len(), 1, "单价列都在就必须发快照");
        assert_eq!(f.price_snapshots[0].model, "m-a");
        // 源侧单价是真值,不是 0
        assert_eq!(f.price_snapshots[0].variants[0].input_usd_per_million, 10.0);
        assert_eq!(f.price_snapshots[0].variants[0].output_usd_per_million, 50.0);
        // 缺的是别的列 ⇒ 只上报它们,不得把单价列也算成缺
        assert!(
            f.missing_columns.iter().any(|c| c == "reasoning_tokens"),
            "实际 {:?}",
            f.missing_columns
        );
        assert!(!f.missing_columns.iter().any(|c| c == "input_usd_per_million"));
        assert!(!f.missing_columns.iter().any(|c| c == "estimated_cost_usd"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 完整列集:失败原因全 12 类可见、单价调价拆成多组、推理 token 单列可见。
    #[test]
    fn facets_expose_full_error_categories_and_price_variants() {
        let dir = std::env::temp_dir().join(format!("cockpit_facets_full_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let path = seed_full(&dir);
        {
            let conn = Connection::open(&path).unwrap();
            // 成功 2 条(m-a 一条带推理 token)
            insert_facet(&conn, 1, 1_000, "m-a", 1, "", 1_000, 100, 0, 40, "high", "sidecar", 5.0, 30.0, 0.5, 3);
            insert_facet(&conn, 2, 2_000, "m-a", 1, "", 2_000, 200, 0, 0, "", "sidecar", 5.0, 30.0, 0.5, 3);
            // 失败:12 类里的 5 类 + 1 条无分类
            insert_facet(&conn, 3, 3_000, "m-a", 0, "upstream_error", 0, 0, 0, 0, "medium", "legacy", 5.0, 30.0, 0.5, 3);
            insert_facet(&conn, 4, 4_000, "m-a", 0, "request_failed", 0, 0, 0, 0, "", "legacy", 5.0, 30.0, 0.5, 3);
            insert_facet(&conn, 5, 5_000, "m-a", 0, "request_failed", 0, 0, 0, 0, "", "legacy", 5.0, 30.0, 0.5, 3);
            insert_facet(&conn, 6, 6_000, "m-b", 0, "auth_failed", 0, 0, 0, 0, "", "sidecar", 2.0, 12.0, 0.2, 3);
            insert_facet(&conn, 7, 7_000, "m-b", 0, "", 0, 0, 0, 0, "", "sidecar", 2.0, 12.0, 0.2, 3);
            // m-b 中途调价:后一条用新单价(4.0/24.0/0.4)
            insert_facet(&conn, 8, 8_000, "m-b", 1, "", 1_000, 50, 0, 0, "low", "sidecar", 4.0, 24.0, 0.4, 4);
        }
        let f = facets(&path, None, None).expect("聚合成功");

        assert!(f.available);
        assert!(f.missing_columns.is_empty(), "完整列集不该报缺列");
        assert_eq!(f.row_count, 8);
        assert_eq!(f.success_rows, 3);
        assert_eq!(f.failed_rows, 5);
        assert_eq!(f.failed_without_category, 1, "失败但无分类必须单独计数,不能消失");

        // 全 12 类里的这些必须都出现 —— 特别是 request_failed(旧口径下不可见)
        assert_eq!(f.error_categories.get("upstream_error"), Some(&1));
        assert_eq!(f.error_categories.get("request_failed"), Some(&2), "request_failed 必须单独可见");
        assert_eq!(f.error_categories.get("auth_failed"), Some(&1));
        // 成功行不得进失败分类
        assert_eq!(f.error_categories.values().sum::<i64>(), 4, "分类之和 == 失败且有分类的行数");

        // 推理 token 是 output 子集,单列可见但只是展示
        assert_eq!(f.reasoning_tokens, 40);
        assert_eq!(f.reasoning_rows, 1);
        assert_eq!(f.reasoning_efforts.get("high"), Some(&1));
        assert_eq!(f.reasoning_efforts.get("medium"), Some(&1));
        assert_eq!(f.reasoning_efforts.get("low"), Some(&1));
        assert_eq!(f.gateway_modes.get("sidecar"), Some(&5));
        assert_eq!(f.gateway_modes.get("legacy"), Some(&3));

        // 单价快照:m-a 一组,m-b 两组(调价),按行数降序
        assert_eq!(f.price_snapshots.len(), 2);
        let m_b = f.price_snapshots.iter().find(|s| s.model == "m-b").expect("m-b 应在");
        assert_eq!(m_b.rows, 3);
        assert_eq!(m_b.variants.len(), 2, "调价必须拆成两组,只留一组会骗人");
        let old = &m_b.variants[0];
        let new = &m_b.variants[1];
        assert_eq!(old.rows, 2, "旧价用了 2 次");
        assert_eq!(old.input_usd_per_million, 2.0);
        assert_eq!(new.rows, 1, "新价用了 1 次");
        assert_eq!(new.input_usd_per_million, 4.0);
        assert_eq!(new.pricing_versions, vec![3, 4], "版本号去重升序");
        // 成本是原样搬运的求和,不是重算
        assert!(m_b.estimated_cost_usd > 0.0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 端到端:拿**本机真实的 cockpit 单请求用量库**跑一次 facet 扫描。
    ///
    /// 手动验证命令:
    /// ```bash
    /// cd src-tauri
    /// cargo test --bin console2api end_to_end_facets_against_real_db -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "手动端到端:依赖本机真实 cockpit 数据,见文档注释"]
    fn end_to_end_facets_against_real_db() {
        let path = match request_log_db_path() {
            Ok(p) => p,
            Err(e) => {
                println!("跳过:无法定位源库({e})");
                return;
            }
        };
        if !path.exists() {
            println!("跳过:源库不存在 {}", path.display());
            return;
        }
        let f = facets(&path, None, None).expect("facet 扫描应成功");
        assert!(f.available, "真实库应可用: {:?}", f.reason);
        assert!(f.row_count > 100_000, "应扫到 10 万+ 行,实际 {}", f.row_count);
        assert!(
            f.error_categories.contains_key("request_failed"),
            "request_failed 必须出现在全量分类里(旧口径下它不可见): {:?}",
            f.error_categories.keys().collect::<Vec<_>>()
        );
        assert!(!f.price_snapshots.is_empty(), "真实库应有单价快照");
        assert!(
            f.reasoning_tokens > 0 && f.reasoning_rows > 0,
            "真实库应有推理 token(仅展示,不额外计价)"
        );
        println!(
            "真实库 facet: {} 行 / 成功 {} / 失败 {}(未分类 {}) / 失败分类 {} 类 / 推理 {} tok({} 行) / 单价模型 {} 个",
            f.row_count,
            f.success_rows,
            f.failed_rows,
            f.failed_without_category,
            f.error_categories.len(),
            f.reasoning_tokens,
            f.reasoning_rows,
            f.price_snapshots.len(),
        );
        println!("失败分类: {:?}", f.error_categories);
        println!("网关通道: {:?}", f.gateway_modes);
        println!("推理档位: {:?}", f.reasoning_efforts);
        for s in f.price_snapshots.iter().take(5) {
            println!(
                "  模型 {}: {} 行 / 单价组 {} / in={} cached={} out={} / cockpit成本 {}",
                s.model, s.rows, s.variants.len(),
                s.variants[0].input_usd_per_million,
                s.variants[0].cached_input_usd_per_million,
                s.variants[0].output_usd_per_million,
                s.estimated_cost_usd,
            );
        }
    }

    /// 回归:我方计价口径必须能**精确复现** cockpit 的 `estimated_cost_usd`。
    ///
    /// 这条把"缺口 ③:cache_write 未计价 / 无独立单价交叉校验"的结论钉死:
    /// `cache_write_tokens` 按 **input 单价**计,而我们的 `normal = input - cached`
    /// 恰好把它按同一单价算进去,故**无需单独建模**。
    #[test]
    fn our_pricing_reproduces_cockpit_estimated_cost_exactly() {
        let dir = std::env::temp_dir().join(format!("cockpit_facets_price_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let path = seed_full(&dir);
        {
            let conn = Connection::open(&path).unwrap();
            // 覆盖:纯未命中 / 全命中 / 部分命中 / 长上下文档 / 缓存大于输入(坏数据)
            let cases: [(i64, i64, i64); 5] = [
                (1_000, 0, 100),
                (1_000, 1_000, 100),
                (10_000, 2_500, 300),
                (300_000, 50_000, 1_000),
                (100, 999, 5),
            ];
            for (idx, (i, c, o)) in cases.iter().enumerate() {
                insert_facet(
                    &conn, idx as i64 + 1, (idx as i64 + 1) * 1_000, "m-p", 1, "", *i, *o, *c, 0,
                    "high", "sidecar", 5.0, 30.0, 0.5, 3,
                );
            }
        }
        let f = facets(&path, None, None).expect("聚合成功");
        let snap = &f.price_snapshots[0];
        let v = &snap.variants[0];
        let (in_p, out_p, cached_p) = (
            v.input_usd_per_million,
            v.output_usd_per_million,
            v.cached_input_usd_per_million,
        );
        // 用我方 TokenSplit 口径复算(cached = min(cached, input);normal = input - cached)
        let mut expect = 0.0f64;
        for (i, c, o) in [(1_000i64, 0i64, 100i64), (1_000, 1_000, 100), (10_000, 2_500, 300), (300_000, 50_000, 1_000), (100, 999, 5)] {
            let hit = c.min(i).max(0);
            let normal = (i - hit).max(0);
            expect += (normal as f64 * in_p + hit as f64 * cached_p + o as f64 * out_p) / 1e6;
        }
        assert!(
            (snap.estimated_cost_usd - expect).abs() < 1e-12,
            "我方口径必须精确复现 cockpit 成本: cockpit={} ours={}",
            snap.estimated_cost_usd,
            expect
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
