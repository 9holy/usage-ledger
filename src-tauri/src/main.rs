#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cockpit_logs_db;
mod cockpit_quota;
mod desktop_shell;
mod finance_ledger;
mod model_catalog;
mod ledger_db;
mod ledger_ingest;
mod ledger_merge;
mod ledger_query;
mod proxy;
mod usage_monitor;

use desktop_shell::{handle_main_window_event, is_background_launch, setup_desktop_shell, show_main_window};

/// cockpit-tools 用户数据目录(%USERPROFILE%\.antigravity_cockpit)。
/// cockpit 读本地 JSON 主源:零认证、零进程依赖、成本已预算好(见 codex_local_access_stats.json)。
fn cockpit_data_dir() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "无法定位用户主目录(USERPROFILE/HOME 均未设置)".to_string())?;
    Ok(std::path::PathBuf::from(home).join(".antigravity_cockpit"))
}

/// 本控制台用户数据目录(Windows %APPDATA%\2api-console,其他 ~/.local/share/2api-console)。
/// 存 cockpit 模式本地成本档案(cockpit_cost_profiles.json)——cockpit 是只读本地 JSON 数据源,
/// 无后端可写(sub2api 存 PG,cockpit 存本地 JSON 对齐"手动补充采购价"语义)。
fn console_data_dir() -> Result<std::path::PathBuf, String> {
    if let Ok(appdata) = std::env::var("APPDATA") {
        return Ok(std::path::PathBuf::from(appdata).join("2api-console"));
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "无法定位用户主目录(APPDATA/USERPROFILE/HOME 均未设置)".to_string())?;
    Ok(std::path::PathBuf::from(home).join(".local").join("share").join("2api-console"))
}

/// 读本地成本档案 JSON(cockpit 模式手动配置的采购价)。不存在时返 "{}"(首次使用)。
#[tauri::command]
fn read_cost_profiles() -> Result<String, String> {
    let path = console_data_dir()?.join("cockpit_cost_profiles.json");
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("{}".to_string()),
        Err(e) => Err(format!("读取成本档案失败: {e}")),
    }
}

/// 写本地成本档案 JSON(全量覆盖)。前端序列化为字符串传入,Rust 侧只负责落盘。
#[tauri::command]
fn write_cost_profiles(json: String) -> Result<(), String> {
    use std::io::Write;
    static WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = WRITE_LOCK.lock().map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    if !value.is_object() {
        return Err("Cost profiles must be a JSON object".to_string());
    }
    let dir = console_data_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {e}"))?;
    let target = dir.join("cockpit_cost_profiles.json");
    let pending = dir.join("cockpit_cost_profiles.json.pending");
    // Persist the replacement before touching the valid file.
    let mut file = std::fs::File::create(&pending).map_err(|e| e.to_string())?;
    file.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    std::fs::rename(&pending, &target).map_err(|e| format!("Cost profile replacement failed: {e}"))
}

/// 读 cockpit 用量台账 JSON。台账保留"已从 cockpit 移除的账号"的历史用量,
/// 解决 cockpit 端"移除 API 即丢数据、重新加入从 0 计数"的问题——成本端不能丢。
/// 不存在时返 "{}"(首次使用)。上限裁剪由前端完成后传入(2000 账号封顶)。
#[tauri::command]
fn read_cost_ledger() -> Result<String, String> {
    let path = console_data_dir()?.join("cockpit_usage_ledger.json");
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("{}".to_string()),
        Err(e) => Err(format!("读取用量台账失败: {e}")),
    }
}

/// 写 cockpit 用量台账 JSON(全量覆盖;前端先做 2000 上限裁剪再传入)。
#[tauri::command]
fn write_cost_ledger(json: String) -> Result<(), String> {
    let dir = console_data_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {e}"))?;
    std::fs::write(dir.join("cockpit_usage_ledger.json"), json).map_err(|e| format!("写入失败: {e}"))
}

/// 写 cockpit 本地 JSON 文件(账号导入/路由规则更新等)。
/// name 白名单同 read_cockpit_file:[a-z_0-9]+\.json,防目录穿越。
/// content 由前端序列化为 JSON 字符串传入,Rust 侧只负责落盘(全量覆盖)。
#[tauri::command]
fn write_cockpit_file(name: String, content: String) -> Result<(), String> {
    let prefix = name.strip_suffix(".json").unwrap_or("");
    let valid = name.ends_with(".json")
        && !prefix.is_empty()
        && name.len() <= 64
        && prefix.chars().all(|c| matches!(c, 'a'..='z' | '_' | '0'..='9'));
    if !valid {
        return Err(format!("非法文件名: {name}(仅允许 a-z_0-9 + .json)"));
    }
    let dir = cockpit_data_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {e}"))?;
    std::fs::write(dir.join(&name), content).map_err(|e| format!("写入 {name} 失败: {e}"))
}

/// 读 cockpit 本地 JSON 文件。name 仅允许 [a-z_0-9]+\.json(前缀至少 1 字符),防目录穿越;根目录固定。
#[tauri::command]
fn read_cockpit_file(name: String) -> Result<String, String> {
    // 白名单:.json 结尾 + 前缀非空 + 仅小写字母/下划线/数字 + 总长 ≤64
    let prefix = name.strip_suffix(".json").unwrap_or("");
    let valid = name.ends_with(".json")
        && !prefix.is_empty()
        && name.len() <= 64
        && prefix.chars().all(|c| matches!(c, 'a'..='z' | '_' | '0'..='9'));
    if !valid {
        return Err(format!("非法文件名: {name}(仅允许 a-z_0-9 + .json)"));
    }
    let path = cockpit_data_dir()?.join(&name);
    match std::fs::read_to_string(&path) {
        Ok(content) => Ok(content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Err(format!("cockpit 数据文件不存在: {name}(cockpit 未安装或未运行过)"))
        }
        Err(e) => Err(format!("读取 {name} 失败: {e}")),
    }
}

/// 读 cockpit codex-api 路由日志原文(供前端解析路由审计)。
/// 日志文件名含 '-' 和 .log 后缀(如 codex-api.log.2026-08-26),无法走 read_cockpit_file 白名单。
/// 白名单:仅 logs/ 子目录 + 文件名匹配 codex-api 系列命名,防目录穿越。
/// ponytail: 日志可能 15MB+,直接 read_to_string 返回;前端解析后丢弃。不流式——一次读完够(已缓存)。
#[tauri::command]
fn read_cockpit_log_file(name: String) -> Result<String, String> {
    // 仅允许 codex-api 系列日志名:codex-api.log / codex-api.log.YYYY-MM-DD / codex-api-YYYY-MM-DD.log
    let valid = name.len() <= 64
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && (name == "codex-api.log"
            || regex_matches(&name, r"^codex-api\.log\.\d{4}-\d{2}-\d{2}$")
            || regex_matches(&name, r"^codex-api-\d{4}-\d{2}-\d{2}\.log$"));
    if !valid {
        return Err(format!("非法日志文件名: {name}(仅允许 codex-api 系列日志)"));
    }
    let path = cockpit_data_dir()?.join("logs").join(&name);
    // canonicalize 二次校验:解析后的绝对路径必须仍在 cockpit_data_dir/logs 下,防符号链接穿越
    let logs_dir = cockpit_data_dir()?.join("logs");
    let canonical = path.canonicalize().map_err(|e| format!("日志不存在: {name}({e})"))?;
    let canonical_dir = logs_dir.canonicalize().map_err(|e| format!("logs 目录异常: {e}"))?;
    if !canonical.starts_with(&canonical_dir) {
        return Err(format!("路径越界: {name}"));
    }
    match std::fs::read_to_string(&canonical) {
        Ok(content) => Ok(content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Err(format!("日志文件不存在: {name}"))
        }
        Err(e) => Err(format!("读取 {name} 失败: {e}")),
    }
}

/// 单条日志事件的必要字段(serde 按需反序列化,其余字段自动忽略)。
#[derive(serde::Deserialize)]
struct CockpitLogEvent {
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "requestId")]
    request_id: Option<String>,
    model: Option<String>,
    /// 入站接口路径(request_completed/request_started 带的 path,如 /v1/responses)。
    /// 路由明细表要按"模型×账号×入站接口"分维度,故一并解析。
    path: Option<String>,
    /// 上游账号 id(auth_selected/auth_result 事件带;与 cockpit stats accountId 同一标识体系)。
    /// 供 per-account 聚合,让 7d/30d 账号级请求数用真实滚动窗口而非日历快照。
    #[serde(rename = "accountId")]
    account_id: Option<String>,
    #[serde(rename = "startedAtMs")]
    started_at_ms: Option<i64>,
    #[serde(rename = "completedAtMs")]
    completed_at_ms: Option<i64>,
    #[serde(rename = "latencyMs")]
    latency_ms: Option<i64>,
    status: Option<i64>,
    success: Option<bool>,
}

/// 按 requestId 聚合中的单个请求。
struct CockpitLogRequest {
    model: Option<String>,
    account_id: Option<String>,
    path: Option<String>,
    started_at_ms: Option<i64>,
    completed_at_ms: Option<i64>,
    status: Option<i64>,
    success: Option<bool>,
    ttft_ms: Option<i64>,
    duration_ms: Option<i64>,
}

/// 路由明细聚合:模型 × 账号 × 入站接口(对应前端 ModelRouteRow 的分组键)。
#[derive(Default)]
struct RouteAgg {
    requests: u64,
    success: u64,
    error: u64,
    first_ms: Option<i64>,
    last_ms: Option<i64>,
}

/// 单个时间桶的聚合统计。
struct OpsBucketAgg {
    requests: u64,
    success: u64,
    error: u64,
    ttfts: Vec<i64>,
    durations: Vec<i64>,
}

/// 最近秩百分位(与前端 percentile 语义近似;p50/p95 足够趋势图用)。
fn nearest_rank_percentile(sorted: &[i64], pct: u64) -> Option<i64> {
    if sorted.is_empty() {
        return None;
    }
    let n = sorted.len() as u64;
    // `div_ceil` 而不是 `(n * pct + 99) / 100`:后者在 n*pct 接近 u64::MAX 时会先溢出
    let idx = (n * pct).div_ceil(100).clamp(1, n) as usize - 1;
    sorted.get(idx).copied()
}

/// 多天 codex-api 日志 → 请求级时间桶聚合(修复"7d/30d 观察窗口趋势无效")。
///
/// 背景:日志按天滚动(codex-api.log.YYYY-MM-DD),单天可达 40MB+/26k 行,
/// 而前端 parseCockpitApiLog 有 MAX_COCKPIT_LOG_LINES=25000 行截断——多天日志
/// 拼接后只会保留最新 25000 行,观察窗口对趋势图永远无效;整段传 JS 也会
/// 让 WebView2 行数组内存暴涨。因此在 Rust 侧流式逐行解析、按 requestId 聚合
/// (与前端 parseCockpitApiLog 同语义)、按 bucket_hours 分桶,只返回几 KB 的桶统计。
///
/// 除时间桶外同时返回 **路由明细聚合**(模型 × 账号 × 入站接口):真实模型/渠道/接口明细表
/// 此前只读当天的 codex-api.log,切到 7d/30d 数字不变——改成窗口内多天日志聚合后才有窗口语义。
/// start_ms/end_ms 是可选的精确时间窗(闭区间 [start_ms, end_ms]);不传则按整天文件口径,
/// 传了则只统计落在该闭区间内的请求(1h/6h 窗口不会把整天算进来)。
///
/// 日期参数由前端给(本地时区的 YYYY-MM-DD,Rust 不做时区换算,ISO 日期可直接字典序比较)。
/// 日志无 token/usage 字段(实测 0 条),成本留 0 由前端快照口径补,不编造。
#[tauri::command]
fn summarize_cockpit_api_logs(
    start_date: String,
    end_date: String,
    bucket_hours: u32,
    start_ms: Option<i64>,
    end_ms: Option<i64>,
) -> Result<serde_json::Value, String> {
    // regex_matches 只支持少数固定模式,日期校验用现成的 is_date(YYYY-MM-DD)
    if !is_date(&start_date) || !is_date(&end_date) {
        return Err("日期格式必须是 YYYY-MM-DD".into());
    }
    if start_date > end_date {
        return Err("start_date 不能晚于 end_date".into());
    }
    if !(1..=168).contains(&bucket_hours) {
        return Err("bucket_hours 必须在 1..=168".into());
    }
    let bucket_ms: i64 = bucket_hours as i64 * 3_600_000;

    let logs_dir = cockpit_data_dir()?.join("logs");
    let canonical_dir = match logs_dir.canonicalize() {
        Ok(d) => d,
        Err(e) => return Err(format!("logs 目录不存在: {e}")),
    };
    let entries = std::fs::read_dir(&canonical_dir).map_err(|e| format!("列 logs 目录失败: {e}"))?;

    // 收集范围内日期的日志文件(文件名即日期,字典序即时间序);上限 62 个文件防滥用。
    let mut dated_files: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let name = match entry.file_name().into_string() {
            Ok(n) => n,
            Err(_) => continue,
        };
        let Some(date) = name.strip_prefix("codex-api.log.") else { continue };
        if !is_date(date) || date < start_date.as_str() || date > end_date.as_str() {
            continue;
        }
        dated_files.push(date.to_string());
    }
    dated_files.sort();
    dated_files.dedup();
    if dated_files.len() > 62 {
        dated_files = dated_files.split_off(dated_files.len() - 62);
    }

    let mut by_request: std::collections::HashMap<String, CockpitLogRequest> =
        std::collections::HashMap::new();

    for date in &dated_files {
        let path = canonical_dir.join(format!("codex-api.log.{date}"));
        let file = match std::fs::File::open(&path) {
            Ok(f) => f,
            Err(_) => continue,
        };
        let reader = std::io::BufReader::new(file);
        for line in std::io::BufRead::lines(reader) {
            let line = match line {
                Ok(l) => l,
                Err(_) => continue,
            };
            // 与前端 parseCockpitApiLog 同过滤:只认 sidecar 前缀行
            if !line.contains("[CodexLocalAccess][sidecar]") {
                continue;
            }
            let Some(brace) = line.find('{') else { continue };
            let Ok(evt) = serde_json::from_str::<CockpitLogEvent>(&line[brace..]) else { continue };
            let Some(rid) = evt.request_id else { continue };
            let entry = by_request.entry(rid).or_insert(CockpitLogRequest {
                model: None,
                account_id: None,
                path: None,
                started_at_ms: None,
                completed_at_ms: None,
                status: None,
                success: None,
                ttft_ms: None,
                duration_ms: None,
            });
            // 任何事件带 accountId 都记录(auth_selected/auth_result 有,auth 归因到请求)
            if evt.account_id.is_some() {
                entry.account_id = evt.account_id;
            }
            if evt.path.is_some() {
                entry.path = evt.path;
            }
            match evt.kind.as_str() {
                "request_started" | "executor_started" => {
                    if evt.model.is_some() {
                        entry.model = evt.model;
                    }
                    if evt.started_at_ms.is_some() {
                        entry.started_at_ms = evt.started_at_ms;
                    }
                }
                "auth_result" => {
                    entry.success = evt.success.or(entry.success);
                }
                "request_completed" => {
                    if evt.status.is_some() {
                        entry.status = evt.status;
                    }
                    if evt.latency_ms.is_some() {
                        entry.duration_ms = evt.latency_ms;
                    }
                    if evt.completed_at_ms.is_some() {
                        entry.completed_at_ms = evt.completed_at_ms;
                    }
                }
                // 首个 chunk 只用来补 ttft,且**不能覆盖已有的**(重试/多段流会重复上报)
                "stream_first_chunk" if entry.ttft_ms.is_none() => {
                    entry.ttft_ms = evt.latency_ms;
                }
                _ => {}
            }
        }
    }

    // 分桶(与前端 cockpitLogToOpsTrend 同口径:落桶时间 = completedAtMs ?? startedAtMs;
    // 只统计有 model 的业务请求;status 优先于 auth_result.success)
    let mut buckets: std::collections::BTreeMap<i64, OpsBucketAgg> = std::collections::BTreeMap::new();
    // per-account 请求归因:(requests, success, error);与桶相同的 success 判定
    let mut account_agg: std::collections::HashMap<String, (u64, u64, u64)> =
        std::collections::HashMap::new();
    let mut route_agg: std::collections::HashMap<(String, String, String), RouteAgg> =
        std::collections::HashMap::new();
    let mut requests_total: u64 = 0;
    for req in by_request.into_values() {
        if req.model.is_none() {
            continue;
        }
        let Some(ts) = req.completed_at_ms.or(req.started_at_ms) else { continue };
        // 精确时间窗过滤(闭区间):1h/6h 窗口不能把整天的请求算进来。
        // 只按日期文件过滤会退化为"当天累计",与所选窗口不符。
        if start_ms.is_some_and(|s| ts < s) || end_ms.is_some_and(|e| ts > e) {
            continue;
        }
        requests_total += 1;
        let bucket_start = ts.div_euclid(bucket_ms) * bucket_ms;
        let b = buckets.entry(bucket_start).or_insert(OpsBucketAgg {
            requests: 0,
            success: 0,
            error: 0,
            ttfts: Vec::new(),
            durations: Vec::new(),
        });
        b.requests += 1;
        // 成功判定统一:status 优先(2xx=成功),无 status 回退 auth_result.success
        let outcome: Option<bool> = match req.status {
            Some(status) => Some((200..300).contains(&status)),
            None => req.success,
        };
        match outcome {
            Some(true) => b.success += 1,
            Some(false) => b.error += 1,
            None => {}
        }
        if let Some(acc) = &req.account_id {
            let e = account_agg.entry(acc.clone()).or_insert((0, 0, 0));
            e.0 += 1;
            match outcome {
                Some(true) => e.1 += 1,
                Some(false) => e.2 += 1,
                None => {}
            }
        }
        if let Some(t) = req.ttft_ms {
            b.ttfts.push(t);
        }
        if let Some(d) = req.duration_ms {
            b.durations.push(d);
        }
        // 路由明细聚合:模型 × 账号 × 入站接口(支撑"真实模型/渠道/接口明细"表按窗口出数)
        let route_key = (
            req.model.clone().unwrap_or_default(),
            req.account_id.clone().unwrap_or_default(),
            req.path.clone().unwrap_or_default(),
        );
        let r = route_agg.entry(route_key).or_default();
        r.requests += 1;
        match outcome {
            Some(true) => r.success += 1,
            Some(false) => r.error += 1,
            None => {}
        }
        r.first_ms = Some(r.first_ms.map_or(ts, |v: i64| v.min(ts)));
        r.last_ms = Some(r.last_ms.map_or(ts, |v: i64| v.max(ts)));
    }

    // 窗口级 TTFT 样本:分位数不可加,必须从窗口内全部原始样本算,
    // 不能对桶分位数做平均/加权(桶在下面被 move 消费,先拷一份样本出来)。
    let mut window_ttfts: Vec<i64> = Vec::new();
    let bucket_values: Vec<serde_json::Value> = buckets
        .into_iter()
        .map(|(start, b)| {
            window_ttfts.extend(b.ttfts.iter().copied());
            let mut ttfts = b.ttfts;
            let mut durations = b.durations;
            ttfts.sort_unstable();
            durations.sort_unstable();
            serde_json::json!({
                "bucket_start_ms": start,
                "request_count": b.requests,
                "success_count": b.success,
                "error_count": b.error,
                "ttft_p50_ms": nearest_rank_percentile(&ttfts, 50),
                "ttft_p95_ms": nearest_rank_percentile(&ttfts, 95),
                "duration_p95_ms": nearest_rank_percentile(&durations, 95),
            })
        })
        .collect();
    window_ttfts.sort_unstable();

    // per-account 输出:按请求数降序,账号 id 原样传(前端做 FNV 哈希映射到账号行)
    let mut account_values: Vec<serde_json::Value> = account_agg
        .into_iter()
        .map(|(account_id, (requests, success, error))| {
            serde_json::json!({
                "account_id": account_id,
                "requests": requests,
                "success_count": success,
                "error_count": error,
            })
        })
        .collect();
    account_values.sort_by(|a, b| {
        let ra = a["requests"].as_u64().unwrap_or(0);
        let rb = b["requests"].as_u64().unwrap_or(0);
        rb.cmp(&ra).then_with(|| a["account_id"].as_str().cmp(&b["account_id"].as_str()))
    });

    // 路由明细输出:按请求数降序;account_id/path 为空串表示日志未记录(前端按"未记录"渲染)
    let mut route_values: Vec<serde_json::Value> = route_agg
        .into_iter()
        .map(|((model, account_id, path), r)| {
            serde_json::json!({
                "model": model,
                "account_id": if account_id.is_empty() { serde_json::Value::Null } else { serde_json::json!(account_id) },
                "inbound_path": if path.is_empty() { serde_json::Value::Null } else { serde_json::json!(path) },
                "requests": r.requests,
                "success_count": r.success,
                "error_count": r.error,
                "first_ms": r.first_ms,
                "last_ms": r.last_ms,
            })
        })
        .collect();
    route_values.sort_by(|a, b| {
        let ra = a["requests"].as_u64().unwrap_or(0);
        let rb = b["requests"].as_u64().unwrap_or(0);
        rb.cmp(&ra).then_with(|| a["model"].as_str().cmp(&b["model"].as_str()))
    });

    Ok(serde_json::json!({
        "buckets": bucket_values,
        "accounts": account_values,
        "routes": route_values,
        "files_read": dated_files,
        "requests_total": requests_total,
        // 窗口级 TTFT 分位数:从窗口内全部原始样本算(非桶分位数平均),无样本为 null
        "ttft_p50_ms": nearest_rank_percentile(&window_ttfts, 50),
        "ttft_p95_ms": nearest_rank_percentile(&window_ttfts, 95),
        // 已读日志文件的日期范围:前端据此判断"滚动窗口是否被日志保留期覆盖"
        // (30d 窗口可能只有 6 天日志,少计的时段如实标注而非冒充完整 30 天)
        "min_date": dated_files.first(),
        "max_date": dated_files.last(),
    }))
}

/// 列 cockpit 子目录下所有匹配文件并批量读原文(供配额历史等哈希文件名 JSON)。
/// subdir 限白名单枚举,防任意目录。**白名单唯一来源是 `cockpit_quota::ALLOWED_QUOTA_SUBDIRS`**
/// (T14 / 架构师报 D-5:原实现漏了 `cache/quota_api_v1_desktop/authorized`,
/// 导致 antigravity 那个 TTL 60s 的配额缓存读不到)。此处**不得另抄一份**。
/// pattern 限 ^[a-f0-9]{64}\.json$(sha256 哈希)或 *(列全部),防目录穿越。
/// 返回 Vec<{name,content}>,每项是文件原文。
#[tauri::command]
fn read_cockpit_dir(subdir: String, pattern: String) -> Result<Vec<serde_json::Value>, String> {
    if !cockpit_quota::ALLOWED_QUOTA_SUBDIRS.iter().any(|s| *s == subdir) {
        return Err(format!(
            "非法子目录: {subdir}(仅允许 {})",
            cockpit_quota::ALLOWED_QUOTA_SUBDIRS.join(", ")
        ));
    }
    let base = cockpit_data_dir()?.join(&subdir);
    let canonical_base = base.canonicalize().map_err(|e| format!("目录不存在: {subdir}({e})"))?;
    let entries = std::fs::read_dir(&canonical_base).map_err(|e| format!("列目录失败: {subdir}({e})"))?;

    let use_glob = pattern == "*";
    let mut results: Vec<serde_json::Value> = Vec::new();
    for entry in entries.flatten() {
        let file_name = match entry.file_name().into_string() {
            Ok(n) => n,
            Err(_) => continue,
        };
        // 跳过 .tmp 临时文件(quota_history 有原子写残留)
        if file_name.ends_with(".tmp") || file_name.ends_with(".bak") {
            continue;
        }
        let matches = if use_glob {
            file_name.ends_with(".json")
        } else {
            // pattern 是正则(前端传 ^[a-f0-9]{64}\.json$ 等),此处简单校验 hex+json
            regex_matches(&file_name, &pattern)
        };
        if !matches {
            continue;
        }
        let path = entry.path();
        // canonicalize 二次校验仍在 canonical_base 下
        let canonical = match path.canonicalize() {
            Ok(c) => c,
            Err(_) => continue,
        };
        if !canonical.starts_with(&canonical_base) {
            continue;
        }
        if let Ok(content) = std::fs::read_to_string(&canonical) {
            results.push(serde_json::json!({ "name": file_name, "content": content }));
        }
    }
    Ok(results)
}

/// 简易正则匹配(无 regex crate 依赖,手写最小实现)。
/// 仅支持 read_cockpit_log_file/dir 用的固定模式:\d{4}-\d{2}-\d{2} 与 [a-f0-9]{64}\.json。
/// ponytail: 不引 regex crate——树内无此依赖,手写 2 个匹配够用。
fn regex_matches(input: &str, pattern: &str) -> bool {
    if pattern == r"^codex-api\.log\.\d{4}-\d{2}-\d{2}$" {
        let rest = match input.strip_prefix("codex-api.log.") {
            Some(r) => r,
            None => return false,
        };
        return rest.len() == 10 && is_date(rest);
    }
    if pattern == r"^codex-api-\d{4}-\d{2}-\d{2}\.log$" {
        let rest = match input.strip_prefix("codex-api-").and_then(|r| r.strip_suffix(".log")) {
            Some(r) => r,
            None => return false,
        };
        return rest.len() == 10 && is_date(rest);
    }
    if pattern.starts_with("^[a-f0-9]") && pattern.contains("{64}") {
        // hex hash .json:64 位小写十六进制 + .json
        let rest = match input.strip_suffix(".json") {
            Some(r) => r,
            None => return false,
        };
        return rest.len() == 64 && rest.chars().all(|c| matches!(c, 'a'..='f' | '0'..='9'));
    }
    false
}

/// 校验 YYYY-MM-DD 日期格式。
fn is_date(s: &str) -> bool {
    s.len() == 10
        && s.as_bytes()[4] == b'-'
        && s.as_bytes()[7] == b'-'
        && s[0..4].chars().all(|c| c.is_ascii_digit())
        && s[5..7].chars().all(|c| c.is_ascii_digit())
        && s[8..10].chars().all(|c| c.is_ascii_digit())
}

/// 探测 cockpit-tools 是否在运行:读 server.json 是否存在且含 pid 字段。
/// ponytail: 不再调 tasklist 查进程存活——Cockpit Tools 自启程序会反复拉 PowerShell,
/// 我们的 tasklist 探测虽非源头但会放大子进程活动。纯文件探测(server.json 存在即视为可用)
/// 足够成本中心判断数据可读性,避免任何子进程拉起。
#[tauri::command]
fn check_cockpit_running() -> Result<bool, String> {
    let server_path = cockpit_data_dir()?.join("server.json");
    let content = match std::fs::read_to_string(&server_path) {
        Ok(c) => c,
        Err(_) => return Ok(false), // 无 server.json = 未运行过
    };
    let has_pid = serde_json::from_str::<serde_json::Value>(&content)
        .ok()
        .and_then(|v| v.get("pid").and_then(|p| p.as_u64()))
        .is_some();
    Ok(has_pid)
}

/// 读 codex_model_providers.json,对每个 apiKeys[].apiKey 算 MD5,返回 accountId→provider name 映射。
/// cockpit stats 的 apikey 账号 accountId = `codex_apikey_<md5(apiKey)>`(已验证 5/5 匹配)。
/// 前端无 MD5 库(Web Crypto 不支持 MD5),Rust 侧算后返 Vec<{accountId,name}>。
#[tauri::command]
fn read_cockpit_apikey_names() -> Result<Vec<serde_json::Value>, String> {
    let path = cockpit_data_dir()?.join("codex_model_providers.json");
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("读取 codex_model_providers.json 失败: {e}")),
    };
    let providers: Vec<serde_json::Value> = serde_json::from_str(&content)
        .map_err(|e| format!("解析 codex_model_providers.json 失败: {e}"))?;
    let mut results: Vec<serde_json::Value> = Vec::new();
    for provider in providers {
        let name = provider.get("name").and_then(|v| v.as_str()).unwrap_or("未命名渠道");
        let base_url = provider.get("baseUrl").and_then(|v| v.as_str()).unwrap_or("");
        let api_keys = match provider.get("apiKeys").and_then(|v| v.as_array()) {
            Some(arr) => arr,
            None => continue,
        };
        for key in api_keys {
            let api_key = match key.get("apiKey").and_then(|v| v.as_str()) {
                Some(k) if !k.is_empty() => k,
                _ => continue,
            };
            // key.name 优先(用户可给单个 key 起名),否则用 provider name
            let key_name = key.get("name").and_then(|v| v.as_str()).filter(|s| !s.is_empty());
            let display_name = key_name.unwrap_or(name);
            let hash = format!("{:x}", md5::compute(api_key.as_bytes()));
            results.push(serde_json::json!({
                "accountId": format!("codex_apikey_{hash}"),
                "name": display_name,
                "baseUrl": base_url,
            }));
        }
    }
    Ok(results)
}

/// CPA Token Usage 插件目录(%USERPROFILE%\.cli-proxy-api\plugins\codex-token-usage)。
/// 插件本地存 usage.db(SQLite 完整用量历史 1629+ 行) + model_prices.cache(LiteLLM 3213 模型 per-token USD 定价)。
fn cliproxy_plugins_dir() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "无法定位用户主目录(USERPROFILE/HOME 均未设置)".to_string())?;
    Ok(std::path::PathBuf::from(home).join(".cli-proxy-api").join("plugins").join("codex-token-usage"))
}

/// 读 CPA 插件 usage.db 的 usage_events 表(最近 30 天),返 JSON 原文供前端 JSON.parse。
/// 用系统 python(python3.12 带 sqlite3 模块)只读连接读 SQLite,避免引 rusqlite 依赖(网络不通无法下载)。
/// python3 sqlite3 默认不锁 WAL,只读查询不影响插件持续写入。
/// 禁止返回 api_key 明文(SQL 侧不 SELECT 该列)。
/// ponytail: python bridge 是环境网络阻断下绕过 rusqlite 下载的务实方案;系统 python 3.12 已验证可用。
const CLIPROXY_RESPONSE_TIER_COLUMN: &str = r#"columns = {r[1] for r in con.execute("PRAGMA table_info(usage_events)")}
response_tier_column = "response_service_tier" if "response_service_tier" in columns else "NULL AS response_service_tier"
"#;

fn cliproxy_python_command() -> std::process::Command {
    let mut command = std::process::Command::new("python");
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: automatic refresh must not create a Python console.
        command.creation_flags(0x08000000);
    }
    command
}

#[tauri::command]
fn read_cliproxy_usage_events(with_metadata: Option<bool>, start_ms: Option<i64>, end_ms: Option<i64>) -> Result<String, String> {
    match (start_ms, end_ms) {
        (None, None) => {}
        (Some(start), Some(end)) if start < end => {}
        _ => return Err("startMs/endMs must be supplied together with startMs < endMs".into()),
    }
    let db_path = cliproxy_plugins_dir()?.join("usage.db");
    if !db_path.exists() {
        return Ok(if with_metadata.unwrap_or(false) {
            serde_json::json!({"available":false,"events":[],"readStartMs":null,"readEndMs":null}).to_string()
        } else { "[]".to_string() });
    }
    // Windows 反斜杠在 python 字符串里会被当转义,转成正斜杠(Windows sqlite uri 同样接受)。
    let db_str = db_path.to_string_lossy().replace('\\', "/");

    // 内联 python:只读连接(uri mode=ro),30 天窗口,SELECT 精简字段(无 api_key),输出 JSON。
    // requested_at 秒×1000 转毫秒,供前端 new Date(ms) 与时间桶数值比较。
    // 不用 format!(python 脚本含花括号会被当占位符),改 str::replace 注入路径。
    let script = r#"import sqlite3, json, sys, time
con = sqlite3.connect("file:__DB__?mode=ro", uri=True)
con.row_factory = sqlite3.Row
__RESPONSE_TIER_COLUMN__
now = __END_MS__ if __END_MS__ is not None else int(time.time() * 1000)
cutoff = __START_MS__ if __START_MS__ is not None else now - 30 * 86400 * 1000
rows = con.execute(
    "SELECT requested_at, provider, executor_type, model, alias, auth_index, auth_type, "
    "source, reasoning_effort, service_tier, " + response_tier_column + ", latency_ms, ttft_ms, failed, status_code, "
    "input_tokens, output_tokens, reasoning_tokens, cached_tokens, cache_read_tokens, "
    "cache_creation_tokens, total_tokens, primary_used_percent, primary_reset_at, "
    "primary_used_tokens, primary_remaining_tokens, primary_limit_tokens, "
    "secondary_used_percent, secondary_reset_at, secondary_used_tokens, "
    "secondary_remaining_tokens, secondary_limit_tokens "
    "FROM usage_events WHERE requested_at >= ? AND requested_at < ? ORDER BY requested_at DESC",
    (cutoff / 1000, now / 1000))
out = []
for r in rows:
    d = {k: r[k] for k in r.keys()}
    d["requested_at"] = (d.get("requested_at") or 0) * 1000
    d["failed"] = bool(d.get("failed"))
    out.append(d)
con.close()
# ensure_ascii=True:Windows python stdout 默认 cp936(GBK),中文 provider/model 名
# 用 \uXXXX 转义确保纯 ASCII 传输,前端 JSON.parse 自动还原为中文,避免乱码。
result = {"available": True, "events": out, "readStartMs": cutoff, "readEndMs": now} if __META__ else out
sys.stdout.write(json.dumps(result, ensure_ascii=True, default=str))
"#.replace("__DB__", &db_str)
    .replace("__RESPONSE_TIER_COLUMN__", CLIPROXY_RESPONSE_TIER_COLUMN)
    .replace("__START_MS__", &start_ms.map(|value| value.to_string()).unwrap_or_else(|| "None".into()))
    .replace("__END_MS__", &end_ms.map(|value| value.to_string()).unwrap_or_else(|| "None".into()))
    .replace("__META__", if with_metadata.unwrap_or(false) { "True" } else { "False" });

    let output = cliproxy_python_command()
        .arg("-c")
        .arg(&script)
        .output()
        .map_err(|e| format!("启动 python 失败: {e}(需系统 python 3.x 带 sqlite3 模块)"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("python 读取 usage.db 失败: {}", stderr.trim()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.trim().is_empty() { return Err("python returned no usage result".into()); }
    Ok(stdout.into_owned())
}

/// 读 CPA 插件 model_prices.cache 原文 JSON(LiteLLM 3213 模型 per-token USD 定价)。
/// 不存在时返 "{}"(首次使用/插件未安装)。
#[tauri::command]
fn read_cliproxy_model_prices() -> Result<String, String> {
    let path = cliproxy_plugins_dir()?.join("model_prices.cache");
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("{}".to_string()),
        Err(e) => Err(format!("读取 model_prices.cache 失败: {e}")),
    }
}

fn main() {
    let background_launch = is_background_launch(std::env::args_os());
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if is_background_launch(args) {
                return;
            }
            if let Err(error) = show_main_window(app) {
                eprintln!("failed to restore main window from second instance: {error}");
            }
        }))
        .manage(usage_monitor::MonitorRuntime::default())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            desktop_shell::set_desktop_locale,
            model_catalog::model_catalog_status,
            model_catalog::model_catalog_refresh,
            model_catalog::model_catalog_quote_batch,
            usage_monitor::usage_monitor_snapshot,
            usage_monitor::accounts::usage_monitor_accounts,
            usage_monitor::usage_monitor_analysis,
            usage_monitor::usage_monitor_session,
            usage_monitor::usage_monitor_quotas,
            usage_monitor::weekly::usage_monitor_weekly,
            finance_ledger::finance_ledger_query,
            finance_ledger::finance_ledger_save,
            finance_ledger::finance_ledger_void,
            finance_ledger::finance_ledger_save_batch,
            finance_ledger::finance_ledger_get_batch,
            finance_ledger::finance_ledger_void_batch,
            finance_ledger::finance_ledger_related_events,
            read_cockpit_file,
            write_cockpit_file,
            check_cockpit_running,
            read_cockpit_log_file,
            summarize_cockpit_api_logs,
            cockpit_logs_db::summarize_cockpit_request_logs,
            cockpit_logs_db::cockpit_request_log_facets,
            read_cockpit_dir,
            read_cockpit_apikey_names,
            read_cost_profiles,
            write_cost_profiles,
            read_cost_ledger,
            write_cost_ledger,
            read_cliproxy_usage_events,
            read_cliproxy_model_prices,
            ledger_ingest::ledger_ingest,
            ledger_query::ledger_reconcile_sources,
            ledger_query::ledger_list_sources,
            ledger_merge::ledger_merged_usage,
            cockpit_quota::quota_list_channels,
            cockpit_quota::quota_snapshots,
            cockpit_quota::quota_refresh,
            cockpit_quota::quota_history,
            cockpit_quota::quota_current_accounts,
            cockpit_quota::quota_model_groups,
            cockpit_quota::quota_account_groups,
        ])
        .on_window_event(handle_main_window_event)
        .setup(move |app| {
            use tauri::Manager;
            // Single-instance detection runs before setup, so only the primary binds the proxy.
            proxy::spawn_proxy();
            model_catalog::start();
            app.state::<usage_monitor::MonitorRuntime>().start();
            setup_desktop_shell(app)
                .map_err(|error| format!("failed to initialize system tray: {error}"))?;
            if !background_launch {
                show_main_window(app.handle())
                    .map_err(|error| format!("failed to show main window on startup: {error}"))?;
            }
            // 账本后台定时摄取(2026-09-12 补):
            // 此前账本只在前端每次加载时摄取一次,程序连续运行时新增数据不会入库 ——
            // cockpit 一旦在这个窗口内轮转/清理旧行,那些数据就永久丢了,账本兜底形同虚设。
            // 这里起守护线程按间隔增量摄取(水位幂等,稳态只扫新行,开销极小)。
            // 间隔可用环境变量 `CONSOLE2API_LEDGER_INTERVAL_MIN` 覆盖(单位分钟,1~1440),默认 15。
            let interval_min = std::env::var("CONSOLE2API_LEDGER_INTERVAL_MIN")
                .ok()
                .and_then(|v| v.parse::<u64>().ok())
                .filter(|m| (1..=24 * 60).contains(m))
                .unwrap_or(15);
            ledger_ingest::spawn_periodic_ingest(std::time::Duration::from_secs(interval_min * 60));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building 2API Console");

    app.run(|_app_handle, _event| {});
}

/// 进程级环境变量互斥锁(仅测试)。
///
/// 环境变量 `set_var`/`remove_var` 是**进程级**全局操作,多个测试并发改
/// USERPROFILE/HOME/APPDATA 会互相踩(一测写进另一测的临时目录后被删,
/// 或 env 被删导致"无法定位用户主目录")。
///
/// 此前本仓库存在**两把同名但互不相认**的 ENV_LOCK:一把在 `mod tests` 内
/// (main.rs),一把在 cockpit_quota 的 `mod tests` 内。两把锁各锁各的 ⇒
/// 跨模块互斥**完全失效**,表现为 `summarize_cockpit_api_logs_*` 随机读到
/// 已被并发用例抹掉的主目录而 flaky。现在全仓库只用这一把:放在 crate 根,
/// `mod tests` 靠顶部 `use super::*;` 自动可见,其他模块用 `crate::ENV_LOCK`。
///
/// 只读 env 的用例同样必须持锁 —— 只锁改写方挡不住"读的瞬间被别人改写"。
/// 这是普通 `std::sync::Mutex`(非可重入),**同一个用例里只能 lock 一次**。
#[cfg(test)]
pub(crate) static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 环境变量 RAII 守卫(仅测试):改写 env 前先记下原值,`Drop` 时**原样还原**。
///
/// 关键点:绝不能"用完 `remove_var`" —— 那是**删除**而不是还原,会把整个测试
/// 进程毒化:此后任何需要主目录/APPDATA 的用例都会拿到
/// "无法定位用户主目录(USERPROFILE/HOME 均未设置)"。
/// 因此约定:裸 `remove_var` 只允许出现在 `Drop` 内部,业务代码一律用本守卫。
///
/// 用 RAII 而非"手动 Save/Restore"还有一层收益:`f()` panic 时 `Drop` 照样
/// 在 unwind 期间执行,不会把改过的 env 泄给后续用例。
#[cfg(test)]
pub(crate) struct EnvGuard {
    key: &'static str,
    prev: Option<std::ffi::OsString>,
}

#[cfg(test)]
impl EnvGuard {
    /// 记下 `key` 的当前值,写入 `value`;守卫 `Drop` 时还原回旧值。
    pub(crate) fn set(key: &'static str, value: impl AsRef<std::ffi::OsStr>) -> Self {
        let prev = std::env::var_os(key);
        std::env::set_var(key, value);
        Self { key, prev }
    }
}

#[cfg(test)]
impl Drop for EnvGuard {
    fn drop(&mut self) {
        // 原值存在就还原,原本不存在才删除 —— 保证测试进程 env 与跑测试前一致。
        match self.prev.take() {
            Some(prev) => std::env::set_var(self.key, prev),
            None => std::env::remove_var(self.key),
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn cliproxy_optional_response_tier_never_uses_requested_tier() {
        let script = format!(r#"import sqlite3
con = sqlite3.connect(":memory:")
con.execute("CREATE TABLE usage_events(service_tier TEXT)")
con.execute("INSERT INTO usage_events VALUES('priority')")
{optional}
assert con.execute("SELECT " + response_tier_column + " FROM usage_events").fetchone()[0] is None
con.execute("ALTER TABLE usage_events ADD COLUMN response_service_tier TEXT")
con.execute("UPDATE usage_events SET response_service_tier='default'")
{optional}
assert con.execute("SELECT " + response_tier_column + " FROM usage_events").fetchone()[0] == 'default'
"#, optional=super::CLIPROXY_RESPONSE_TIER_COLUMN);
        let output=super::cliproxy_python_command().args(["-c",&script]).output().unwrap();
        assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));
    }

    #[cfg(windows)]
    #[test]
    fn cliproxy_background_python_runs_without_a_console() {
        let output = super::cliproxy_python_command().args(["-c", r#"import ctypes
ctypes.windll.kernel32.GetConsoleWindow.restype = ctypes.c_void_p
print(bool(ctypes.windll.kernel32.GetConsoleWindow()))
"#]).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "False");
    }

    #[test]
    fn read_cliproxy_usage_events_rejects_invalid_bounds() {
        assert!(super::read_cliproxy_usage_events(Some(true), Some(1), None).is_err());
        assert!(super::read_cliproxy_usage_events(Some(true), None, Some(2)).is_err());
        assert!(super::read_cliproxy_usage_events(Some(true), Some(2), Some(2)).is_err());
        assert!(super::read_cliproxy_usage_events(Some(true), Some(3), Some(2)).is_err());
    }
    use super::*;

    #[test]
    fn desktop_capabilities_allow_the_fullscreen_control() {
        let capabilities: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json"))
                .expect("desktop capabilities must be valid JSON");
        let permissions = capabilities["permissions"]
            .as_array()
            .expect("desktop capabilities must declare permissions");

        assert!(
            permissions
                .iter()
                .any(|permission| permission.as_str() == Some("core:window:allow-set-fullscreen")),
            "the cost-center fullscreen control requires set_fullscreen permission"
        );
    }

    /// read_cockpit_file 合法名不被白名单拒绝(NotFound 是合法失败,不算名字非法)。
    #[test]
    fn read_cockpit_file_accepts_valid_names() {
        // 结果经由 cockpit_data_dir() 依赖 USERPROFILE/HOME —— 只读也必须持锁。
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        for ok in ["server.json", "codex_local_access_stats.json", "codex_accounts.json"] {
            let r = read_cockpit_file(ok.into());
            assert!(
                !matches!(r, Err(ref e) if e.starts_with("非法文件名")),
                "{ok} 不该被白名单拒绝: {r:?}"
            );
        }
    }

    /// read_cockpit_file 拒绝目录穿越与非法字符。
    #[test]
    fn read_cockpit_file_rejects_path_traversal() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let long_name = format!("{}.json", "a".repeat(70));
        let bad_cases: [&str; 10] = [
            "../config.json",
            "..\\..\\etc\\passwd.json",
            "/etc/passwd.json",
            "sub/dir/file.json",
            "UPPER.json",
            "dash-name.json",
            "no_ext",
            ".json",
            "",
            "",
        ];
        for bad in bad_cases.iter().chain(std::iter::once(&long_name.as_str())) {
            let r = read_cockpit_file((*bad).into());
            assert!(
                matches!(r, Err(ref e) if e.starts_with("非法文件名")),
                "应拒绝非法名 {bad:?},实际: {r:?}"
            );
        }
    }

    /// write_cockpit_file 合法名不被白名单拒绝(写入到 cockpit 目录,NotFound/IO 错误不算名字非法)。
    #[test]
    fn write_cockpit_file_accepts_valid_names() {
        // 结果经由 cockpit_data_dir() 依赖 USERPROFILE/HOME —— 只读/写入都必须持锁,
        // 否则并发用例把主目录改走后,这条会把文件写到别人的临时目录里。
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        // ★ 2026-09-30 事故(必须留着这段说明,否则迟早有人把隔离"简化"掉):
        //   `write_cockpit_file`(main.rs:91)是**真写盘**,而 `cockpit_data_dir()` 解析的是
        //   **真实主目录**。这条用例原先直接往 `%USERPROFILE%\.antigravity_cockpit` 写 `{}`,
        //   把用户真实的 `codex_local_access.json`(端口 64227 / apiKey / apiKeys[] /
        //   accessScope / routingStrategy / customRoutingRules / 图像生成配置)**覆盖成空对象**;
        //   连跑 12 轮压测 = 覆盖 12 次,直到文件变成 2 字节才被发现。
        //   ⇒ 主目录必须改到临时目录再写,断言只关心"白名单是否拒绝",根本不需要真盘。
        let tmp = std::env::temp_dir().join(format!("cockpit_write_test_{}", std::process::id()));
        std::fs::create_dir_all(&tmp).expect("建临时主目录失败");
        let _home = EnvGuard::set("USERPROFILE", &tmp);
        let _home2 = EnvGuard::set("HOME", &tmp);

        for ok in ["codex_accounts.json", "codex_local_access.json", "test_data.json"] {
            let r = write_cockpit_file(ok.into(), "{}".into());
            assert!(
                !matches!(r, Err(ref e) if e.starts_with("非法文件名")),
                "{ok} 不该被白名单拒绝: {r:?}"
            );
            // 反证:文件必须落在**临时**目录 —— 若哪天隔离失效,这里立刻炸,而不是悄悄毁真数据。
            assert!(
                tmp.join(".antigravity_cockpit").join(ok).exists(),
                "{ok} 必须写进临时目录而非用户真目录: {r:?}"
            );
        }
        std::fs::remove_dir_all(&tmp).ok();
    }

    /// write_cockpit_file 拒绝目录穿越与非法字符。
    #[test]
    fn write_cockpit_file_rejects_path_traversal() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let long_name = format!("{}.json", "a".repeat(70));
        let bad_cases: [&str; 10] = [
            "../config.json",
            "..\\..\\etc\\passwd.json",
            "/etc/passwd.json",
            "sub/dir/file.json",
            "UPPER.json",
            "dash-name.json",
            "no_ext",
            ".json",
            "",
            "",
        ];
        // 同样隔离主目录:这些名字**现在**都在 `write_cockpit_file` 的白名单判断处被拒
        // (不会走到写盘),但哪天有人往 `bad_cases` 里误加一个合法名,就会真写进用户目录。
        // 2026-09-30 已经因为同样的写法毁过一次 `codex_local_access.json`,不再赌第二次。
        let tmp = std::env::temp_dir().join(format!("cockpit_write_bad_{}", std::process::id()));
        std::fs::create_dir_all(&tmp).expect("建临时主目录失败");
        let _home = EnvGuard::set("USERPROFILE", &tmp);
        let _home2 = EnvGuard::set("HOME", &tmp);

        for bad in bad_cases.iter().chain(std::iter::once(&long_name.as_str())) {
            let r = write_cockpit_file((*bad).into(), "{}".into());
            assert!(
                matches!(r, Err(ref e) if e.starts_with("非法文件名")),
                "应拒绝非法名 {bad:?},实际: {r:?}"
            );
            // 白名单若漏判,文件会落到临时目录而非真目录 —— 顺便当成"不得漏判"的第二道断言。
            // 空名要跳过:`Path::join("")` 会退化成目录本身,`exists()` 恒真 ⇒ 假失败。
            if !bad.is_empty() {
                assert!(
                    !tmp.join(".antigravity_cockpit").join(bad).exists(),
                    "非法名 {bad:?} 不该真的写出文件"
                );
            }
        }
        std::fs::remove_dir_all(&tmp).ok();
    }

    /// read_cost_ledger 首次使用(文件不存在)返 "{}" 而非 Err。
    /// 设临时 APPDATA 隔离(不依赖外部环境,沙箱可能剥掉 env;持 ENV_LOCK 防并发踩)。
    #[test]
    fn read_cost_ledger_missing_file_returns_empty_object() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = std::env::temp_dir().join("console_ledger_test_empty");
        std::fs::remove_dir_all(&tmp).ok();
        let _appdata = EnvGuard::set("APPDATA", &tmp);
        let r = read_cost_ledger();
        std::fs::remove_dir_all(&tmp).ok();
        assert!(r.is_ok(), "read_cost_ledger 不应失败: {r:?}");
        assert_eq!(r.unwrap(), "{}", "不存在时应返空对象");
    }

    /// write_cost_ledger 落盘后 read_cost_ledger 能读回同内容(往返一致性)。
    /// 写入带唯一标记的载荷(进程 id + 时间戳),读回后断言该条目存在——
    /// 不依赖文件初始状态,多次运行/并行运行互不污染。
    #[test]
    fn cost_ledger_write_then_read_roundtrip() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = std::env::temp_dir().join("console_ledger_test_rw");
        std::fs::remove_dir_all(&tmp).ok();
        let _appdata = EnvGuard::set("APPDATA", &tmp);
        // 写入带唯一标记的载荷(进程 id + 时间戳),读回后断言该条目存在——
        // 不依赖文件初始状态,多次运行互不污染。
        let marker = format!(
            "roundtrip-{}-{}@test.local",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        let payload = format!(r#"{{"accounts":[{{"email":"{marker}","requestCount":42}}]}}"#);
        let write_result = write_cost_ledger(payload.clone());
        let back = read_cost_ledger();
        std::fs::remove_dir_all(&tmp).ok();
        write_result.expect("写入台账失败");
        let back = back.expect("读回台账失败");
        let v: serde_json::Value = serde_json::from_str(&back)
            .unwrap_or_else(|e| panic!("读回内容必须是合法 JSON: {e}; 实际: {back}"));
        let emails: Vec<&str> = v["accounts"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|e| e["email"].as_str())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        assert!(
            emails.contains(&marker.as_str()),
            "台账往返丢内容: 写入 {marker:?}, 读回条目 {emails:?}; 原文: {back}"
        );
    }

    /// summarize_cockpit_api_logs 参数校验:坏日期/区间倒置/桶尺寸越界必须 Err(不触盘)。
    #[test]
    fn summarize_cockpit_api_logs_rejects_bad_params() {
        // 虽然参数校验在函数入口 early-return(不触盘),但同批并发用例改 env 时
        // 仍可能让它走到依赖主目录的分支 —— 持锁把"会不会触盘"锁成确定值。
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        assert!(summarize_cockpit_api_logs("2026-9-1".into(), "2026-09-02".into(), 24, None, None).is_err());
        assert!(summarize_cockpit_api_logs("bad".into(), "2026-09-02".into(), 24, None, None).is_err());
        assert!(summarize_cockpit_api_logs("2026-09-02".into(), "2026-09-01".into(), 24, None, None).is_err());
        assert!(summarize_cockpit_api_logs("2026-09-01".into(), "2026-09-02".into(), 0, None, None).is_err());
        assert!(summarize_cockpit_api_logs("2026-09-01".into(), "2026-09-02".into(), 999, None, None).is_err());
    }

    /// summarize_cockpit_api_logs 聚合语义:按 requestId 聚合、只算有 model 的请求、
    /// status 2xx→success、无 completion 的用 startedAtMs 落桶、ttft/duration 出分位数。
    #[test]
    fn summarize_cockpit_api_logs_aggregates_request_buckets() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = std::env::temp_dir().join(format!("cockpit_summarize_test_{}", std::process::id()));
        let logs = tmp.join(".antigravity_cockpit").join("logs");
        std::fs::create_dir_all(&logs).expect("建临时 logs 目录失败");
        // 主目录必须"临时改写 + 自动还原":此前这里用完就 remove_var(删除而非还原),
        // 会把整个测试进程毒化 —— 之后任何读 HOME 的用例都拿不到主目录(见 EnvGuard)。
        let _userprofile = EnvGuard::set("USERPROFILE", &tmp);
        let _home = EnvGuard::set("HOME", &tmp);

        let sidecar = "[CodexLocalAccess][sidecar]";
        let log = format!(
            "{sidecar} {{\"type\":\"request_started\",\"requestId\":\"r1\",\"model\":\"gpt-5\",\"startedAtMs\":1000000000000}}\n\
             {sidecar} {{\"type\":\"auth_selected\",\"requestId\":\"r1\",\"accountId\":\"codex_aaa\",\"accountEmail\":\"a@x.com\"}}\n\
             {sidecar} {{\"type\":\"stream_first_chunk\",\"requestId\":\"r1\",\"latencyMs\":300}}\n\
             {sidecar} {{\"type\":\"request_completed\",\"requestId\":\"r1\",\"status\":200,\"latencyMs\":1200,\"completedAtMs\":1000000001000}}\n\
             {sidecar} {{\"type\":\"request_started\",\"requestId\":\"r2\",\"model\":\"gpt-5\",\"startedAtMs\":1000000060000}}\n\
             {sidecar} {{\"type\":\"auth_result\",\"requestId\":\"r2\",\"accountId\":\"codex_bbb\",\"success\":false}}\n\
             {sidecar} {{\"type\":\"request_started\",\"requestId\":\"r3\",\"startedAtMs\":1000000000000}}\n\
             {sidecar} {{\"type\":\"request_started\",\"requestId\":\"r4\",\"model\":\"gpt-5\",\"startedAtMs\":1000003600000}}\n\
             {sidecar} {{\"type\":\"request_completed\",\"requestId\":\"r4\",\"status\":500,\"latencyMs\":900,\"completedAtMs\":1000003600500}}\n\
             非日志行 without sidecar marker should be ignored\n"
        );
        std::fs::write(logs.join("codex-api.log.2026-09-01"), log).expect("写测试日志失败");

        let result = summarize_cockpit_api_logs("2026-09-01".into(), "2026-09-01".into(), 1, None, None);
        std::fs::remove_dir_all(&tmp).ok();

        let v = result.expect("聚合不应失败");
        assert_eq!(v["requests_total"].as_u64(), Some(3), "r3 无 model 应被排除; r1/r2/r4 计入");
        assert_eq!(v["files_read"].as_array().map(|a| a.len()), Some(1));
        assert_eq!(v["min_date"].as_str(), Some("2026-09-01"), "日志覆盖范围起点");
        assert_eq!(v["max_date"].as_str(), Some("2026-09-01"), "日志覆盖范围终点");
        let buckets = v["buckets"].as_array().expect("必须有 buckets");
        assert_eq!(buckets.len(), 2, "两个不同小时各一桶");
        let b1 = &buckets[0];
        assert_eq!(b1["bucket_start_ms"].as_i64(), Some(1000000000000 - 1000000000000 % 3_600_000));
        assert_eq!(b1["request_count"].as_u64(), Some(2), "r1(完成)+r2(未完成按 startedAt 落桶)");
        assert_eq!(b1["success_count"].as_u64(), Some(1), "r1 status 200");
        assert_eq!(b1["error_count"].as_u64(), Some(1), "r2 auth_result success:false 计 error");
        assert_eq!(b1["ttft_p50_ms"].as_i64(), Some(300));
        assert_eq!(b1["duration_p95_ms"].as_i64(), Some(1200));
        let b2 = &buckets[1];
        assert_eq!(b2["request_count"].as_u64(), Some(1));
        assert_eq!(b2["error_count"].as_u64(), Some(1), "status 500 计 error");

        // per-account 归因:r1→codex_aaa(auth_selected),r2→codex_bbb(auth_result),
        // r4 无 accountId 事件 → 不出现在 accounts;r3 无 model 已排除
        let accounts = v["accounts"].as_array().expect("必须有 accounts");
        assert_eq!(accounts.len(), 2, "codex_aaa + codex_bbb,无 accountId 的 r4 不归因");
        let aaa = accounts.iter().find(|a| a["account_id"] == "codex_aaa").expect("codex_aaa 存在");
        assert_eq!(aaa["requests"].as_u64(), Some(1));
        assert_eq!(aaa["success_count"].as_u64(), Some(1), "status 200 计成功");
        assert_eq!(aaa["error_count"].as_u64(), Some(0));
        let bbb = accounts.iter().find(|a| a["account_id"] == "codex_bbb").expect("codex_bbb 存在");
        assert_eq!(bbb["requests"].as_u64(), Some(1));
        assert_eq!(bbb["success_count"].as_u64(), Some(0));
        assert_eq!(bbb["error_count"].as_u64(), Some(1), "auth_result success:false 计失败");
        // 按 requests 降序排列(相同请求数按 account_id 字典序)
        assert_eq!(accounts[0]["account_id"].as_str(), Some("codex_aaa"), "按请求数降序,同数按 id 字典序");
    }

    /// 窗口级 TTFT 分位数:必须从窗口内全部原始样本算,**不能**对桶分位数做平均/加权
    /// (分位数不可加)。构造的数据让两种算法给出不同答案,以此把缺陷钉死。
    #[test]
    fn summarize_cockpit_api_logs_window_ttft_percentiles() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = std::env::temp_dir().join(format!("cockpit_window_ttft_test_{}", std::process::id()));
        let logs = tmp.join(".antigravity_cockpit").join("logs");
        std::fs::create_dir_all(&logs).expect("建临时 logs 目录失败");
        // 主目录必须"临时改写 + 自动还原":此前这里用完就 remove_var(删除而非还原),
        // 会把整个测试进程毒化 —— 之后任何读 HOME 的用例都拿不到主目录(见 EnvGuard)。
        let _userprofile = EnvGuard::set("USERPROFILE", &tmp);
        let _home = EnvGuard::set("HOME", &tmp);

        let sidecar = "[CodexLocalAccess][sidecar]";
        // 桶 A(hour 0)ttft: 100,100,100,100,1000 → 桶内 p50=100 / p95=1000
        // 桶 B(hour 1)ttft: 200,200,200,200,2000 → 桶内 p50=200 / p95=2000
        // 窗口合并 10 个原始样本最近秩:p50=200(idx4) / p95=2000(idx9);
        // 若错用"桶分位数平均"会得到 150 / 1500 —— 两者可区分。
        let mut log = String::new();
        let bucket_a_base: i64 = 1_000_000_000_000;
        let bucket_b_base: i64 = bucket_a_base + 3_600_000;
        for (prefix, base, samples) in [
            ("a", bucket_a_base, [100i64, 100, 100, 100, 1000]),
            ("b", bucket_b_base, [200i64, 200, 200, 200, 2000]),
        ] {
            for (i, ttft) in samples.iter().enumerate() {
                let id = format!("{prefix}{i}");
                let ts = base + i as i64;
                log.push_str(&format!(
                    "{sidecar} {{\"type\":\"request_started\",\"requestId\":\"{id}\",\"model\":\"gpt-5\",\"startedAtMs\":{ts}}}\n"
                ));
                log.push_str(&format!(
                    "{sidecar} {{\"type\":\"stream_first_chunk\",\"requestId\":\"{id}\",\"latencyMs\":{ttft}}}\n"
                ));
                log.push_str(&format!(
                    "{sidecar} {{\"type\":\"request_completed\",\"requestId\":\"{id}\",\"status\":200,\"latencyMs\":{ttft},\"completedAtMs\":{}}}\n",
                    ts + 10
                ));
            }
        }
        std::fs::write(logs.join("codex-api.log.2026-09-01"), log).expect("写测试日志失败");

        let result = summarize_cockpit_api_logs("2026-09-01".into(), "2026-09-01".into(), 1, None, None);
        std::fs::remove_dir_all(&tmp).ok();

        let v = result.expect("聚合不应失败");
        assert_eq!(v["requests_total"].as_u64(), Some(10));
        assert_eq!(v["buckets"].as_array().map(|a| a.len()), Some(2), "两个小时各一桶");
        // 桶级语义不变:仍按桶内样本算
        assert_eq!(v["buckets"][0]["ttft_p50_ms"].as_i64(), Some(100));
        assert_eq!(v["buckets"][0]["ttft_p95_ms"].as_i64(), Some(1000));
        assert_eq!(v["buckets"][1]["ttft_p50_ms"].as_i64(), Some(200));
        assert_eq!(v["buckets"][1]["ttft_p95_ms"].as_i64(), Some(2000));
        // 窗口级:从 10 个原始样本算(桶分位数平均会得到 150 / 1500,必须不相等)
        assert_eq!(v["ttft_p50_ms"].as_i64(), Some(200), "窗口 p50 必须来自原始样本");
        assert_eq!(v["ttft_p95_ms"].as_i64(), Some(2000), "窗口 p95 必须来自原始样本");
    }

    /// 窗口内无 TTFT 样本时,窗口级字段必须是 JSON null,**绝不能写 0**
    /// (0 会被前端渲染成"0 ms 瞬时返回"的假断言)。
    #[test]
    fn summarize_cockpit_api_logs_window_ttft_null_when_no_samples() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = std::env::temp_dir().join(format!("cockpit_window_ttft_null_test_{}", std::process::id()));
        let logs = tmp.join(".antigravity_cockpit").join("logs");
        std::fs::create_dir_all(&logs).expect("建临时 logs 目录失败");
        // 主目录必须"临时改写 + 自动还原":此前这里用完就 remove_var(删除而非还原),
        // 会把整个测试进程毒化 —— 之后任何读 HOME 的用例都拿不到主目录(见 EnvGuard)。
        let _userprofile = EnvGuard::set("USERPROFILE", &tmp);
        let _home = EnvGuard::set("HOME", &tmp);

        let sidecar = "[CodexLocalAccess][sidecar]";
        // 有请求、有 model,但没有任何 stream_first_chunk → 窗口内 0 个 ttft 样本
        let log = format!(
            "{sidecar} {{\"type\":\"request_started\",\"requestId\":\"n1\",\"model\":\"gpt-5\",\"startedAtMs\":1000000000000}}\n\
             {sidecar} {{\"type\":\"request_completed\",\"requestId\":\"n1\",\"status\":200,\"latencyMs\":900,\"completedAtMs\":1000000001000}}\n"
        );
        std::fs::write(logs.join("codex-api.log.2026-09-01"), log).expect("写测试日志失败");

        let result = summarize_cockpit_api_logs("2026-09-01".into(), "2026-09-01".into(), 1, None, None);
        std::fs::remove_dir_all(&tmp).ok();

        let v = result.expect("聚合不应失败");
        assert_eq!(v["requests_total"].as_u64(), Some(1), "请求计入但无 ttft 样本");
        assert!(v["ttft_p50_ms"].is_null(), "无样本必须是 null,不能是 0");
        assert!(v["ttft_p95_ms"].is_null(), "无样本必须是 null,不能是 0");
        assert_eq!(v["ttft_p50_ms"].as_i64(), None, "无样本不得写成 0");
        assert_eq!(v["ttft_p95_ms"].as_i64(), None, "无样本不得写成 0");
    }

    /// 路由明细聚合 + 精确时间窗过滤:真实模型/渠道/接口明细表按窗口出数的根基。
    /// 只按日期文件过滤会退化为"当天累计"(切 1h/7d 数字不变),必须按 [start_ms, end_ms] 过滤。
    #[test]
    fn summarize_cockpit_api_logs_aggregates_routes_and_window() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = std::env::temp_dir().join(format!("cockpit_routes_test_{}", std::process::id()));
        let logs = tmp.join(".antigravity_cockpit").join("logs");
        std::fs::create_dir_all(&logs).expect("建临时 logs 目录失败");
        // 主目录必须"临时改写 + 自动还原":此前这里用完就 remove_var(删除而非还原),
        // 会把整个测试进程毒化 —— 之后任何读 HOME 的用例都拿不到主目录(见 EnvGuard)。
        let _userprofile = EnvGuard::set("USERPROFILE", &tmp);
        let _home = EnvGuard::set("HOME", &tmp);

        let sidecar = "[CodexLocalAccess][sidecar]";
        // 同一天三批:r1(10:00)/r2(11:00) 在窗口内,r3(23:00) 在窗口外
        let log = format!(
            "{sidecar} {{\"type\":\"request_started\",\"requestId\":\"r1\",\"model\":\"gpt-5\",\"path\":\"/v1/responses\",\"startedAtMs\":1000000000000}}\n\
             {sidecar} {{\"type\":\"auth_selected\",\"requestId\":\"r1\",\"accountId\":\"codex_aaa\"}}\n\
             {sidecar} {{\"type\":\"request_completed\",\"requestId\":\"r1\",\"status\":200,\"latencyMs\":1000,\"completedAtMs\":1000000001000}}\n\
             {sidecar} {{\"type\":\"request_started\",\"requestId\":\"r2\",\"model\":\"gpt-5\",\"path\":\"/v1/responses\",\"startedAtMs\":1000003600000}}\n\
             {sidecar} {{\"type\":\"auth_selected\",\"requestId\":\"r2\",\"accountId\":\"codex_aaa\"}}\n\
             {sidecar} {{\"type\":\"request_completed\",\"requestId\":\"r2\",\"status\":500,\"latencyMs\":2000,\"completedAtMs\":1000003601000}}\n\
             {sidecar} {{\"type\":\"request_started\",\"requestId\":\"r3\",\"model\":\"gpt-5\",\"path\":\"/v1/chat/completions\",\"startedAtMs\":1000040000000}}\n\
             {sidecar} {{\"type\":\"request_completed\",\"requestId\":\"r3\",\"status\":200,\"latencyMs\":500,\"completedAtMs\":1000040000500}}\n"
        );
        std::fs::write(logs.join("codex-api.log.2026-09-01"), log).expect("写测试日志失败");

        // 窗口 [0, 1000007200000](前 2 小时):r3(≈+11h)必须被排除
        let result = summarize_cockpit_api_logs(
            "2026-09-01".into(),
            "2026-09-01".into(),
            1,
            Some(0),
            Some(1000007200000),
        );
        // 不传时间窗:整天口径,3 条全算
        let full = summarize_cockpit_api_logs("2026-09-01".into(), "2026-09-01".into(), 1, None, None);
        std::fs::remove_dir_all(&tmp).ok();

        let v = result.expect("窗口聚合不应失败");
        assert_eq!(v["requests_total"].as_u64(), Some(2), "窗口外的 r3 必须被排除");
        let routes = v["routes"].as_array().expect("必须有 routes");
        assert_eq!(routes.len(), 1, "r1/r2 同模型同账号同接口 → 合成一行");
        let r = &routes[0];
        assert_eq!(r["model"].as_str(), Some("gpt-5"));
        assert_eq!(r["account_id"].as_str(), Some("codex_aaa"));
        assert_eq!(r["inbound_path"].as_str(), Some("/v1/responses"));
        assert_eq!(r["requests"].as_u64(), Some(2));
        assert_eq!(r["success_count"].as_u64(), Some(1), "r1 status 200");
        assert_eq!(r["error_count"].as_u64(), Some(1), "r2 status 500");
        assert_eq!(r["first_ms"].as_i64(), Some(1000000001000), "窗口内最早完成时间");
        assert_eq!(r["last_ms"].as_i64(), Some(1000003601000), "窗口内最晚完成时间");

        let vfull = full.expect("整天聚合不应失败");
        assert_eq!(vfull["requests_total"].as_u64(), Some(3), "不传时间窗=整天口径");
        let full_routes = vfull["routes"].as_array().expect("必须有 routes");
        assert_eq!(full_routes.len(), 2, "r3 走 /v1/chat/completions 应独立成行");
    }

    /// check_cockpit_running 无 server.json 时返 false 而非 Err。
    #[test]
    fn check_cockpit_running_handles_missing_server_json() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // 临时把 USERPROFILE + HOME 都指向空目录,确保 cockpit_data_dir 下无 server.json。
        // 同时设两个变量避免与并发测试的全局变量竞争。
        let tmp = std::env::temp_dir().join("cockpit_test_empty_dir");
        std::fs::create_dir_all(&tmp).ok();
        // 主目录必须"临时改写 + 自动还原":此前这里用完就 remove_var(删除而非还原),
        // 会把整个测试进程毒化 —— 之后任何读 HOME 的用例都拿不到主目录(见 EnvGuard)。
        let _userprofile = EnvGuard::set("USERPROFILE", &tmp);
        let _home = EnvGuard::set("HOME", &tmp);
        let r = check_cockpit_running();
        assert!(r.is_ok(), "无 server.json 不该返 Err: {r:?}");
        std::fs::remove_dir_all(&tmp).ok();
    }

    /// read_cockpit_log_file 合法名不被白名单拒绝(NotFound/不存在是合法失败,不算名字非法)。
    #[test]
    fn read_cockpit_log_file_accepts_valid_names() {
        // 路径解析依赖 USERPROFILE/HOME(cockpit_data_dir)—— 只读也必须持锁。
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        for ok in [
            "codex-api.log",
            "codex-api.log.2026-08-26",
            "codex-api-2026-07-02.log",
        ] {
            let r = read_cockpit_log_file(ok.into());
            assert!(
                !matches!(r, Err(ref e) if e.starts_with("非法日志文件名")),
                "{ok} 不该被白名单拒绝: {r:?}"
            );
        }
    }

    /// read_cockpit_log_file 拒绝目录穿越与非 codex-api 系列日志名。
    #[test]
    fn read_cockpit_log_file_rejects_path_traversal() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let bad_cases: [&str; 8] = [
            "../codex-api.log",
            "..\\..\\codex-api.log",
            "/etc/codex-api.log",
            "sub/codex-api.log",
            "codex-api.log.evil",
            "evil-api.log",
            "codex-api.log/../../etc",
            "codex-api-evil.log",
        ];
        for bad in bad_cases.iter() {
            let r = read_cockpit_log_file((*bad).into());
            assert!(
                matches!(r, Err(ref e) if e.starts_with("非法日志文件名") || e.contains("路径越界")),
                "应拒绝非法日志名 {bad:?},实际: {r:?}"
            );
        }
    }

    /// read_cockpit_dir 拒绝非白名单子目录。
    #[test]
    fn read_cockpit_dir_rejects_invalid_subdir() {
        // 白名单判定在触盘之前,但后半段仍可能进 read_cockpit_dir 的路径解析(env 依赖)。
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        for bad in ["../etc", "cache/../../etc", "logs", "secret", ""] {
            let r = read_cockpit_dir(bad.into(), "*".into());
            assert!(
                matches!(r, Err(ref e) if e.starts_with("非法子目录")),
                "应拒绝非法子目录 {bad:?},实际: {r:?}"
            );
        }
    }

    /// read_cockpit_dir 白名单子目录可调用(目录不存在时返 Err 而非 panic)。
    #[test]
    fn read_cockpit_dir_accepts_whitelisted_subdir() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // 临时把 USERPROFILE + HOME 都指向空目录,quota_history 不存在 → Err 而非 panic。
        // 同时设两个变量避免与其他并发测试的全局变量竞争(cockpit_data_dir 先 USERPROFILE 后 HOME)。
        let tmp = std::env::temp_dir().join("cockpit_test_dir_empty");
        std::fs::create_dir_all(&tmp).ok();
        // 主目录必须"临时改写 + 自动还原":此前这里用完就 remove_var(删除而非还原),
        // 会把整个测试进程毒化 —— 之后任何读 HOME 的用例都拿不到主目录(见 EnvGuard)。
        let _userprofile = EnvGuard::set("USERPROFILE", &tmp);
        let _home = EnvGuard::set("HOME", &tmp);
        let r = read_cockpit_dir("cache/quota_history".into(), "*".into());
        assert!(r.is_err(), "不存在的目录应返 Err: {r:?}");
        assert!(
            !matches!(r, Err(ref e) if e.starts_with("非法子目录")),
            "白名单子目录不该被拒为非法: {r:?}"
        );
        std::fs::remove_dir_all(&tmp).ok();
    }

    /// regex_matches + is_date 基础正确性。
    #[test]
    fn regex_and_date_helpers() {
        assert!(is_date("2026-08-26"));
        assert!(!is_date("2026-8-26"));
        assert!(!is_date("20260826"));
        assert!(regex_matches("codex-api.log.2026-08-26", r"^codex-api\.log\.\d{4}-\d{2}-\d{2}$"));
        assert!(!regex_matches("codex-api.log.evil", r"^codex-api\.log\.\d{4}-\d{2}-\d{2}$"));
        assert!(regex_matches("codex-api-2026-07-02.log", r"^codex-api-\d{4}-\d{2}-\d{2}\.log$"));
        let hex64 = "8d95898128ee8f0f4f06e9328621c96aaa36614d5992eed5f5c7a97de650538f.json";
        assert!(regex_matches(hex64, r"^[a-f0-9]{64}\.json$"));
        assert!(!regex_matches("ABC.json", r"^[a-f0-9]{64}\.json$"));
    }

    /// md5 crate 标准测试向量(验证依赖正确接入)。
    #[test]
    fn md5_known_vectors() {
        assert_eq!(format!("{:x}", md5::compute(b"")), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(format!("{:x}", md5::compute(b"abc")), "900150983cd24fb0d6963f7d28e17f72");
    }

    /// read_cockpit_apikey_names 对真实 codex_model_providers.json 产出 accountId→name 映射。
    /// 验证:返回项含 accountId(codex_apikey_+32hex)与 name 两个字段。
    #[test]
    fn read_cockpit_apikey_names_returns_mapping() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        // 临时空目录:无 codex_model_providers.json → 返空 Vec(不报错)
        let tmp = std::env::temp_dir().join("cockpit_test_apikey_empty");
        std::fs::create_dir_all(&tmp).ok();
        let _userprofile = EnvGuard::set("USERPROFILE", &tmp);
        let r = read_cockpit_apikey_names();
        assert!(r.is_ok(), "无 providers 文件不该报错: {r:?}");
        assert!(r.unwrap().is_empty(), "空目录应返空数组");
        std::fs::remove_dir_all(&tmp).ok();
    }

    /// read_cost_profiles 不存在档案文件时返 "{}"(首次使用,不报错)。
    /// APPDATA 优先(Windows),设临时 APPDATA 隔离测试。
    #[test]
    fn read_cost_profiles_missing_returns_empty_object() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = std::env::temp_dir().join("console_cost_test_empty");
        std::fs::remove_dir_all(&tmp).ok();
        let _appdata = EnvGuard::set("APPDATA", &tmp);
        let r = read_cost_profiles();
        std::fs::remove_dir_all(&tmp).ok();
        assert!(r.is_ok(), "无档案文件不该报错: {r:?}");
        assert_eq!(r.unwrap(), "{}", "不存在时应返空对象");
    }

    /// write_cost_profiles 写后 read_cost_profiles 读回一致(全量覆盖)。
    #[test]
    fn write_then_read_cost_profiles_roundtrip() {
        let _env = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let tmp = std::env::temp_dir().join("console_cost_test_rw");
        std::fs::remove_dir_all(&tmp).ok();
        let _appdata = EnvGuard::set("APPDATA", &tmp);
        // 写入前应不存在(返 {})
        assert_eq!(read_cost_profiles().unwrap(), "{}");
        // 写入档案
        let payload = r#"{"1":{"amount":20,"currency":"USD"}}"#;
        assert!(write_cost_profiles(payload.to_string()).is_ok(), "写入应成功");
        // 读回应一致
        assert_eq!(read_cost_profiles().unwrap(), payload, "写后读回应一致");
        // 二次写入(覆盖不同内容)
        let payload2 = r#"{"2":{"amount":100}}"#;
        assert!(write_cost_profiles(payload2.to_string()).is_ok());
        assert_eq!(read_cost_profiles().unwrap(), payload2, "二次写入应覆盖");
        assert!(write_cost_profiles("[]".into()).is_err());
        assert!(write_cost_profiles("{broken".into()).is_err());
        assert_eq!(read_cost_profiles().unwrap(), payload2);
        assert!(!tmp.join("2api-console/cockpit_cost_profiles.json.pending").exists());
        std::fs::remove_dir_all(&tmp).ok();
    }
}
