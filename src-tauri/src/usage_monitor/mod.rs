pub mod accounts;
mod analysis;
mod antigravity;
mod codex_mode_logs;
mod collector;
mod deepseek;
mod deepseek_parser;
#[cfg(test)]
mod deepseek_tests;
mod live;
mod parser;
pub(crate) mod pricing;
mod quota;
mod store;
#[cfg(test)]
mod tests;
pub mod types;
pub mod weekly;

use std::sync::{Arc, Mutex};
use types::*;

#[derive(Clone, Default)]
struct RuntimeStatus {
    started_at_ms: i64,
    collected_at_ms: i64,
    collecting: bool,
    sources: Vec<SourceStatus>,
    error: Option<String>,
    antigravity: Option<SourceStatus>,
}

#[derive(Clone, Default)]
pub struct MonitorRuntime {
    inner: Arc<Mutex<RuntimeStatus>>,
}

impl MonitorRuntime {
    fn status_snapshot(&self) -> Result<RuntimeStatus, String> {
        self.inner
            .lock()
            .map(|state| state.clone())
            .map_err(|error| error.to_string())
    }

    fn update_error(&self, error: Option<String>) {
        if let Ok(mut s) = self.inner.lock() {
            s.error = error;
        }
    }
    pub fn start(&self) {
        if let Ok(mut state) = self.inner.lock() {
            state.started_at_ms = crate::ledger_db::now_ms();
        }
        if let Err(error) = crate::ledger_db::open_default()
            .map_err(|e| e.to_string())
            .and_then(|conn| store::initialize(&conn))
        {
            self.update_error(Some(error));
            return;
        }
        let runtime = self.clone();
        std::thread::spawn(move || {
            if let Err(e) = collector::run(runtime.clone()) {
                runtime.update_error(Some(e));
            }
        });
        let runtime = self.clone();
        std::thread::spawn(move || antigravity_loop(runtime));
    }
}

fn connection() -> Result<rusqlite::Connection, String> {
    let path = crate::ledger_db::ledger_db_path().map_err(|e| e.to_string())?;
    crate::ledger_db::open_read_only(&path).map_err(|e| e.to_string())
}

fn status_counts(
    sessions: &[SessionSummary],
    now: i64,
) -> (
    MonitorStatusCounts,
    std::collections::BTreeMap<String, MonitorStatusCounts>,
) {
    let mut global = MonitorStatusCounts::default();
    let mut tools: std::collections::BTreeMap<_, _> =
        ["codex", "claude", "antigravity", "deepseek-harness"]
            .into_iter()
            .map(|tool| (tool.to_owned(), MonitorStatusCounts::default()))
            .collect();
    for session in sessions {
        for counts in [
            &mut global,
            tools.entry(session.meta.tool.clone()).or_default(),
        ] {
            match session.meta.status.as_str() {
                "running" | "active" => counts.running += 1,
                "recent" => counts.recent += 1,
                "stale" => counts.stale += 1,
                "completed" | "idle" => counts.idle += 1,
                _ => counts.unknown += 1,
            }
            if session.meta.updated_at_ms >= now - 30 * 60_000 && session.meta.updated_at_ms <= now
            {
                counts.active_last30m += 1;
            }
        }
    }
    (global, tools)
}

fn rate_sessions_for_live(sessions: &[SessionSummary], live: &LiveSnapshot) -> Vec<SessionSummary> {
    let contributors: std::collections::BTreeSet<_> = live
        .by_session
        .iter()
        .filter(|group| {
            group
                .windows
                .iter()
                .any(|window| window.seconds == 300 && window.observed_output_tokens > 0)
        })
        .filter_map(|group| group.session_key.as_deref())
        .collect();
    let mut result = store::rate_sessions(sessions);
    let mut keys: std::collections::BTreeSet<_> =
        result.iter().map(|session| session.key.clone()).collect();
    result.extend(
        sessions
            .iter()
            .filter(|session| {
                contributors.contains(session.key.as_str()) && keys.insert(session.key.clone())
            })
            .cloned(),
    );
    result
}

#[tauri::command]
pub async fn usage_monitor_quotas() -> Result<quota::QuotaReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        quota::read(&connection()?, crate::ledger_db::now_ms())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn usage_monitor_snapshot(
    runtime: tauri::State<'_, MonitorRuntime>,
    tool: Option<String>,
    offset: Option<u32>,
    limit: Option<u32>,
    search: Option<String>,
    status: Option<String>,
    unpriced_only: Option<bool>,
) -> Result<MonitorSnapshot, String> {
    if tool
        .as_deref()
        .is_some_and(|v| !matches!(v, "codex" | "claude" | "antigravity" | "deepseek-harness"))
    {
        return Err("Unknown usage source".into());
    }
    let search = search.unwrap_or_default();
    if search.chars().count() > 200 {
        return Err("Search exceeds 200 characters".into());
    }
    let active = match status.as_deref().unwrap_or("all") {
        "all" => None,
        "active" => Some(true),
        "history" => Some(false),
        _ => return Err("Unknown session status filter".into()),
    };
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = connection()?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let now = crate::ledger_db::now_ms();
        let mut sessions = store::sessions(&tx, None, now)?;
        let (status_counts, tool_status_counts) = status_counts(&sessions, now);
        sessions.retain(|session| {
            tool.as_deref()
                .map_or(true, |tool| session.meta.tool == tool)
        });
        let totals = store::sum_sessions(&sessions);
        let mut active_sessions: Vec<_> = sessions
            .iter()
            .filter(|session| {
                matches!(
                    session.meta.status.as_str(),
                    "running" | "active" | "stale" | "recent"
                )
            })
            .cloned()
            .collect();
        let state = runtime.status_snapshot()?;
        let sources: Vec<_> = state
            .sources
            .into_iter()
            .chain(state.antigravity)
            .collect();
        let mut live = live::read(&tx, now, state.started_at_ms, state.collected_at_ms)?;
        live.unavailable_tools = ["codex", "claude", "antigravity", "deepseek-harness"]
            .into_iter()
            .filter(|tool| {
                !sources
                    .iter()
                    .any(|source| source.tool == *tool && source.status == "watching")
            })
            .map(str::to_owned)
            .collect();
        live.source_coverage_incomplete = !live.unavailable_tools.is_empty()
            || state.error.is_some()
            || sources.iter().any(|source| {
                source.status != "metadata"
                    && (matches!(source.status.as_str(), "partial" | "error" | "unavailable")
                        || source.error.is_some())
            });
        let mut rate_sessions = rate_sessions_for_live(&sessions, &live);
        store::filter_sessions(
            &mut sessions,
            &search,
            active,
            unpriced_only.unwrap_or(false),
        );
        let count = sessions.len() as i64;
        let collected_at_ms = state.collected_at_ms;
        let collecting = state.collecting;
        let error = state.error;
        let mut sessions: Vec<_> = sessions
            .into_iter()
            .skip(offset.unwrap_or(0) as usize)
            .take(limit.unwrap_or(100).clamp(1, 200) as usize)
            .collect();
        store::enrich_session_outputs(
            &tx,
            &mut [&mut sessions, &mut active_sessions, &mut rate_sessions],
        )?;
        let snapshot = MonitorSnapshot {
            status_counts,
            tool_status_counts,
            live,
            collected_at_ms,
            refresh_ms: 2000,
            rate_window_seconds: 60,
            totals,
            sessions,
            session_count: count,
            active_sessions,
            rate_sessions,
            sources,
            collecting,
            error,
        };
        tx.commit().map_err(|e| e.to_string())?;
        Ok(snapshot)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn antigravity_loop(runtime: MonitorRuntime) {
    use rusqlite::OptionalExtension;
    let result = (|| -> Result<(), String> {
        let mut conn = crate::ledger_db::open_default().map_err(|error| error.to_string())?;
        let stored: Option<String> = conn
            .query_row(
                "SELECT data FROM monitor_state WHERE key='antigravity'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let mut state: serde_json::Value = match stored {
            Some(s) => serde_json::from_str(&s).map_err(|e| e.to_string())?,
            None => serde_json::json!({}),
        };
        let started = crate::ledger_db::now_ms();
        let mut coverage = live::CoverageWriter::new("language_server");
        loop {
            let now = crate::ledger_db::now_ms();
            let mut next = state.clone();
            let result=antigravity::collect(&mut next).and_then(|batch|{
                let count=batch.len();
                let tx=conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
                for parsed in batch {
                    if let Some(session)=parsed.session {store::save_session(&tx,&session)?;}
                    for id in parsed.delete_ids {store::delete_request(&tx,"antigravity",&id)?;}
                    for usage in parsed.usage {store::save_usage(&tx,&usage,started,now)?;}
                }
                tx.execute("INSERT INTO monitor_state(key,data) VALUES('antigravity',?1) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
                    [serde_json::to_string(&next).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
                tx.commit().map_err(|e|e.to_string())?;
                state=next;Ok(count)
            });
            let (status, error, count) = match result {
                Ok(count) => {
                    let error = state
                        .get("lastError")
                        .and_then(|v| v.as_str())
                        .filter(|v| !v.is_empty())
                        .map(str::to_owned);
                    (
                        if error.is_some() {
                            "partial"
                        } else {
                            "watching"
                        },
                        error,
                        count,
                    )
                }
                Err(error) => ("unavailable", Some(error), 0),
            };
            coverage.observe(&conn, "*", crate::ledger_db::now_ms(), true)?;
            coverage.observe(
                &conn,
                "antigravity",
                crate::ledger_db::now_ms(),
                status == "watching",
            )?;
            if let Ok(mut shared) = runtime.inner.lock() {
                shared.antigravity = Some(SourceStatus {
                    tool: "antigravity".into(),
                    root: "Local language-server usage metadata".into(),
                    status: status.into(),
                    files: count,
                    last_scan_ms: now,
                    error,
                    ..Default::default()
                });
            }
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
    })();
    if let Err(error) = result {
        if let Ok(mut shared) = runtime.inner.lock() {
            shared.antigravity = Some(SourceStatus {
                tool: "antigravity".into(),
                root: "Local language-server usage metadata".into(),
                status: "error".into(),
                error: Some(error),
                ..Default::default()
            });
        }
    }
}

#[tauri::command]
pub async fn usage_monitor_session(
    key: String,
    offset: Option<u32>,
    limit: Option<u32>,
    unpriced_only: Option<bool>,
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    model: Option<String>,
    turn_id: Option<String>,
    pricing_reason: Option<String>,
    include_descendants: Option<bool>,
) -> Result<SessionDetail, String> {
    let period = MonitorPeriod {
        start_ms,
        end_ms,
        model,
        turn_id,
        pricing_reason: pricing_reason.filter(|value| !value.is_empty()),
    };
    validate_period(&period)?;
    tauri::async_runtime::spawn_blocking(move || {
        let conn = connection()?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let detail = store::session_detail_with_descendants(
            &tx,
            &key,
            offset.unwrap_or(0),
            limit.unwrap_or(100).clamp(1, 200),
            crate::ledger_db::now_ms(),
            unpriced_only.unwrap_or(false),
            &period,
            include_descendants.unwrap_or(false),
        )?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(detail)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn validate_period(period: &MonitorPeriod) -> Result<(), String> {
    if period
        .start_ms
        .is_some_and(|start| start < 0 || start > 8_640_000_000_000_000)
        || period
            .end_ms
            .is_some_and(|end| end <= 0 || end > 8_640_000_000_000_000)
        || period
            .start_ms
            .zip(period.end_ms)
            .is_some_and(|(start, end)| start >= end)
    {
        return Err("Invalid monitor time range".into());
    }
    if period
        .model
        .as_ref()
        .is_some_and(|value| value.chars().count() > 512)
        || period
            .turn_id
            .as_ref()
            .is_some_and(|value| value.chars().count() > 2048)
        || period
            .pricing_reason
            .as_ref()
            .is_some_and(|value| value.chars().count() > 200)
    {
        return Err("Monitor filter is too long".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn usage_monitor_analysis(
    tool: Option<String>,
    start_ms: Option<i64>,
    end_ms: i64,
    model: Option<String>,
    search: Option<String>,
    status: Option<String>,
    unpriced_only: Option<bool>,
    offset: Option<u32>,
    limit: Option<u32>,
    pricing_reason: Option<String>,
) -> Result<MonitorAnalysis, String> {
    if tool.as_deref().is_some_and(|value| {
        !matches!(
            value,
            "codex" | "claude" | "antigravity" | "deepseek-harness"
        )
    }) {
        return Err("Unknown usage source".into());
    }
    let period = MonitorPeriod {
        start_ms,
        end_ms: Some(end_ms),
        model,
        turn_id: None,
        pricing_reason: pricing_reason.filter(|value| !value.is_empty()),
    };
    validate_period(&period)?;
    let search = search.unwrap_or_default();
    if search.chars().count() > 200 {
        return Err("Search exceeds 200 characters".into());
    }
    let active = match status.as_deref().unwrap_or("all") {
        "all" => None,
        "active" => Some(true),
        "history" => Some(false),
        _ => return Err("Unknown session status filter".into()),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let conn = connection()?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let result = analysis::read(
            &tx,
            tool.as_deref(),
            &period,
            &search,
            active,
            unpriced_only.unwrap_or(false),
            offset.unwrap_or(0) as usize,
            limit.unwrap_or(100).clamp(1, 200) as usize,
            crate::ledger_db::now_ms(),
        )?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod pricing_reason_filter_tests {
    use super::*;
    #[test]
    fn status_snapshot_releases_the_mutex_and_keeps_one_consistent_status() {
        let runtime = MonitorRuntime::default();
        {
            let mut state = runtime.inner.lock().unwrap();
            state.started_at_ms = 1;
            state.collected_at_ms = 10;
            state.collecting = true;
            state.sources.push(SourceStatus { tool: "codex".into(), status: "watching".into(), ..Default::default() });
            state.antigravity = Some(SourceStatus { tool: "antigravity".into(), status: "watching".into(), ..Default::default() });
        }
        let captured = runtime.status_snapshot().unwrap();
        let writer = runtime.clone();
        let (sent, received) = std::sync::mpsc::channel();
        let thread = std::thread::spawn(move || {
            let mut state = writer.inner.lock().unwrap();
            state.collected_at_ms = 20;
            state.collecting = false;
            state.sources[0].status = "error".into();
            state.error = Some("synthetic failure".into());
            sent.send(()).unwrap();
        });
        received.recv_timeout(std::time::Duration::from_secs(2)).unwrap();
        thread.join().unwrap();
        assert_eq!((captured.started_at_ms, captured.collected_at_ms, captured.collecting), (1, 10, true));
        assert_eq!(captured.sources[0].status, "watching");
        assert_eq!(captured.antigravity.unwrap().status, "watching");
        assert!(captured.error.is_none());
        let latest = runtime.status_snapshot().unwrap();
        assert_eq!((latest.collected_at_ms, latest.collecting), (20, false));
        assert_eq!(latest.sources[0].status, "error");
        assert_eq!(latest.error.as_deref(), Some("synthetic failure"));
    }

    #[test]
    fn pricing_reason_boundary_rejects_only_oversized_filters() {
        let mut period = MonitorPeriod {
            pricing_reason: Some("x".repeat(200)),
            ..Default::default()
        };
        assert!(validate_period(&period).is_ok());
        period.pricing_reason = Some("x".repeat(201));
        assert!(validate_period(&period).is_err());
        period.pricing_reason = None;
        assert!(validate_period(&period).is_ok());
    }
}
