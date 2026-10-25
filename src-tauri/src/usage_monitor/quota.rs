use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaCredits {
    #[serde(default)]
    pub has_credits: Option<bool>,
    #[serde(default)]
    pub unlimited: Option<bool>,
    #[serde(default)]
    pub balance: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct QuotaObservation {
    tool: String,
    account_key: String,
    account_label: Option<String>,
    attribution: String,
    limit_id: String,
    slot: String,
    window_minutes: Option<i64>,
    plan: Option<String>,
    model_id: Option<String>,
    pool_label: Option<String>,
    observed_at_ms: Option<i64>,
    resets_at_ms: Option<i64>,
    used_percent: Option<f64>,
    #[serde(default)]
    credits: Option<QuotaCredits>,
    source: String,
    pub(crate) source_error: Option<String>,
    stale_after_ms: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaSnapshot {
    pub id: i64,
    pub tool: String,
    pub account_key: String,
    pub account_label: String,
    pub attribution: String,
    pub limit_id: String,
    pub slot: String,
    pub window_minutes: Option<i64>,
    pub plan: Option<String>,
    pub model_id: Option<String>,
    pub pool_label: Option<String>,
    pub observed_at_ms: Option<i64>,
    pub resets_at_ms: Option<i64>,
    pub used_percent: Option<f64>,
    pub remaining_percent: Option<f64>,
    pub credits: Option<QuotaCredits>,
    pub source: String,
    pub stale: bool,
    pub expired: bool,
    pub source_error: Option<String>,
    pub depletion: DepletionEstimate,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DepletionEstimate {
    status: String,
    reason: Option<String>,
    remaining_hours: Option<f64>,
    survives_until_reset: Option<bool>,
    consumption_percent_per_hour: Option<f64>,
    sample_count: usize,
    span_ms: i64,
    as_of_ms: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaSourceStatus {
    tool: String,
    source: String,
    status: String,
    error: Option<String>,
    coverage: Option<BootstrapCoverage>,
    scope_note: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapCoverage {
    registered_files: usize,
    metadata_errors: usize,
    scopes_reported: usize,
    scopes_unreported: usize,
    tail_errors: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaReport {
    pub collected_at_ms: i64,
    pub quotas: Vec<QuotaSnapshot>,
    pub sources: Vec<QuotaSourceStatus>,
}

pub fn initialize(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS monitor_quotas (
           id INTEGER PRIMARY KEY, tool TEXT NOT NULL, account_key TEXT NOT NULL,
           limit_id TEXT NOT NULL, slot TEXT NOT NULL, window_minutes INTEGER NOT NULL,
           observed_ms INTEGER, data TEXT NOT NULL,
           UNIQUE(tool,account_key,limit_id,slot,window_minutes));
         CREATE TABLE IF NOT EXISTS monitor_quota_samples (
           quota_id INTEGER NOT NULL, bucket_ms INTEGER NOT NULL, observed_ms INTEGER NOT NULL,
           used_percent REAL NOT NULL, reset_ms INTEGER NOT NULL, plan TEXT, segment_reason TEXT,
           PRIMARY KEY(quota_id,bucket_ms));
         CREATE INDEX IF NOT EXISTS monitor_quota_samples_time ON monitor_quota_samples(observed_ms);",
    )
    .map_err(|e| e.to_string())?;
    super::accounts::initialize(conn)
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)?
        .as_str()
        .filter(|v| !v.trim().is_empty())
        .map(str::to_owned)
}

fn percent(value: Option<f64>) -> Option<f64> {
    value.filter(|v| v.is_finite() && (0.0..=100.0).contains(v))
}

pub fn codex_observations(
    payload: &Value,
    account_id: Option<&str>,
    session_id: &str,
    observed_ms: Option<i64>,
) -> Vec<QuotaObservation> {
    let Some(limits) = payload.get("rate_limits").filter(|v| v.is_object()) else {
        return Vec::new();
    };
    let account_id = account_id.filter(|id| !id.trim().is_empty());
    let credits = limits.get("credits").and_then(|value| {
        let credits = QuotaCredits {
            has_credits: value["has_credits"].as_bool(),
            unlimited: value["unlimited"].as_bool(),
            balance: text(value, "balance"),
        };
        (credits.has_credits.is_some() || credits.unlimited.is_some() || credits.balance.is_some())
            .then_some(credits)
    });
    ["primary", "secondary"]
        .into_iter()
        .filter_map(|slot| {
            let window = limits.get(slot).filter(|v| v.is_object())?;
            Some(QuotaObservation {
                tool: "codex".into(),
                account_key: match account_id {
                    Some(id) => format!("account:{id}"),
                    None => format!("session:{session_id}"),
                },
                account_label: None,
                attribution: if account_id.is_some() {
                    "account"
                } else {
                    "unattributed"
                }
                .into(),
                limit_id: text(limits, "limit_id").unwrap_or_else(|| "codex".into()),
                slot: slot.into(),
                window_minutes: window["window_minutes"].as_i64().filter(|v| *v > 0),
                plan: text(limits, "plan_type"),
                model_id: None,
                pool_label: text(limits, "limit_name"),
                observed_at_ms: observed_ms.filter(|v| *v > 0),
                resets_at_ms: window["resets_at"]
                    .as_i64()
                    .filter(|v| *v > 0)
                    .and_then(|v| v.checked_mul(1000)),
                used_percent: percent(window["used_percent"].as_f64()),
                credits: credits.clone(),
                source: "codex_local_log".into(),
                source_error: None,
                stale_after_ms: 300_000,
            })
        })
        .collect()
}

pub fn save(conn: &Connection, observation: &QuotaObservation) -> Result<(), String> {
    use rusqlite::OptionalExtension;
    let id: Option<i64> = conn.query_row(
        "INSERT INTO monitor_quotas(tool,account_key,limit_id,slot,window_minutes,observed_ms,data)
         VALUES(?1,?2,?3,?4,?5,?6,?7)
         ON CONFLICT(tool,account_key,limit_id,slot,window_minutes) DO UPDATE SET
           observed_ms=excluded.observed_ms,data=excluded.data
         WHERE COALESCE(excluded.observed_ms,0)>COALESCE(monitor_quotas.observed_ms,0)
         RETURNING id",
        params![
            observation.tool,
            observation.account_key,
            observation.limit_id,
            observation.slot,
            observation.window_minutes.unwrap_or(-1),
            observation.observed_at_ms,
            serde_json::to_string(observation).map_err(|e| e.to_string())?
        ],
        |row|row.get(0),
    ).optional().map_err(|e| e.to_string())?;
    if let Some(id) = id {
        save_sample(conn, id, observation)?;
        if observation.attribution == "account"
            && observation.source_error.is_none()
            && super::accounts::is_account_weekly_pool(
                &observation.tool,
                &observation.limit_id,
                observation.window_minutes,
            )
        {
            super::accounts::observe_quota(
                conn,
                &observation.tool,
                &observation.account_key,
                &observation.slot,
                observation.window_minutes,
                observation.observed_at_ms,
                observation.resets_at_ms,
                observation.used_percent,
            )?;
        }
    } else if let Some(credits) = &observation.credits {
        // Older parser versions saved this same observation without credits. Enrich only
        // that missing field; equal-time payloads must not replace quota facts or samples.
        conn.execute(
            "UPDATE monitor_quotas SET data=json_set(data,'$.credits',json(?1))
             WHERE tool=?2 AND account_key=?3 AND limit_id=?4 AND slot=?5
               AND window_minutes=?6 AND observed_ms=?7
               AND (json_type(data,'$.credits') IS NULL OR json_type(data,'$.credits')='null')",
            params![
                serde_json::to_string(credits).map_err(|e| e.to_string())?,
                observation.tool,
                observation.account_key,
                observation.limit_id,
                observation.slot,
                observation.window_minutes.unwrap_or(-1),
                observation.observed_at_ms,
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn save_sample(conn: &Connection, id: i64, observation: &QuotaObservation) -> Result<(), String> {
    use rusqlite::OptionalExtension;
    let eligible = observation.attribution == "account" && observation.source_error.is_none();
    let point = observation
        .observed_at_ms
        .zip(observation.used_percent)
        .zip(observation.resets_at_ms)
        .filter(|((time, _), reset)| eligible && reset > time);
    let Some(((time, used), reset)) = point else {
        return clear_samples(conn, id);
    };
    let previous:Option<(i64,i64,f64,i64,Option<String>,Option<String>)>=conn.query_row(
        "SELECT bucket_ms,observed_ms,used_percent,reset_ms,plan,segment_reason FROM monitor_quota_samples
         WHERE quota_id=?1 ORDER BY bucket_ms DESC LIMIT 1",[id],
        |row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?)))
        .optional().map_err(|e|e.to_string())?;
    let boundary = previous
        .as_ref()
        .and_then(|(_, old_time, old_used, old_reset, old_plan, _)| {
            if *old_reset != reset {
                Some("reset_changed")
            } else if old_plan != &observation.plan {
                Some("plan_changed")
            } else if used < *old_used {
                Some("usage_decreased")
            } else if time - *old_time > observation.stale_after_ms {
                Some("sampling_gap")
            } else {
                None
            }
        });
    if boundary.is_some() {
        clear_samples(conn, id)?;
    }
    let segment_reason = boundary
        .map(str::to_owned)
        .or_else(|| previous.as_ref().and_then(|row| row.5.clone()));
    let bucket = time / 300_000 * 300_000;
    conn.execute("INSERT INTO monitor_quota_samples(quota_id,bucket_ms,observed_ms,used_percent,reset_ms,plan,segment_reason)
        VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(quota_id,bucket_ms) DO UPDATE SET
        observed_ms=excluded.observed_ms,used_percent=excluded.used_percent,reset_ms=excluded.reset_ms,
        plan=excluded.plan,segment_reason=excluded.segment_reason",
        params![id,bucket,time,used,reset,observation.plan,segment_reason]).map_err(|e|e.to_string())?;
    if previous
        .as_ref()
        .is_none_or(|(old_bucket, _, _, _, _, _)| *old_bucket != bucket)
    {
        conn.execute(
            "DELETE FROM monitor_quota_samples WHERE quota_id=?1 AND
            (observed_ms<?2 OR bucket_ms NOT IN (SELECT bucket_ms FROM monitor_quota_samples
             WHERE quota_id=?1 ORDER BY bucket_ms DESC LIMIT 96))",
            params![id, time - 86_400_000],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn clear_samples(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM monitor_quota_samples WHERE quota_id=?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn depletion(
    conn: &Connection,
    id: i64,
    observation: &QuotaObservation,
    stale: bool,
    source_error: bool,
) -> Result<DepletionEstimate, String> {
    let mut result = DepletionEstimate {
        status: "unavailable".into(),
        reason: None,
        remaining_hours: None,
        survives_until_reset: None,
        consumption_percent_per_hour: None,
        sample_count: 0,
        span_ms: 0,
        as_of_ms: observation.observed_at_ms,
    };
    let reason = if observation.attribution != "account" {
        Some("unattributed")
    } else if source_error {
        Some("source_error")
    } else if stale {
        Some("stale")
    } else if observation.used_percent.is_none() {
        Some("quota_unknown")
    } else if observation.resets_at_ms.is_none() {
        Some("reset_unknown")
    } else {
        None
    };
    if let Some(reason) = reason {
        result.reason = Some(reason.into());
        return Ok(result);
    }
    let mut stmt = conn
        .prepare(
            "SELECT observed_ms,used_percent,segment_reason FROM monitor_quota_samples
        WHERE quota_id=?1 ORDER BY bucket_ms",
        )
        .map_err(|e| e.to_string())?;
    let samples = stmt
        .query_map([id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    result.sample_count = samples.len();
    result.status = "insufficient_samples".into();
    let (Some(first), Some(last)) = (samples.first(), samples.last()) else {
        return Ok(result);
    };
    result.span_ms = last.0 - first.0;
    result.reason = last.2.clone();
    let consumed = last.1 - first.1;
    // Ten minutes across three source buckets avoids extrapolating a short burst; fractions stay intact.
    let enough_samples = samples.len() >= 3 && result.span_ms >= 600_000;
    if !enough_samples || consumed <= 0.0 {
        if enough_samples && consumed == 0.0 && result.reason.is_none() {
            result.reason = Some("no_observed_consumption".into());
        }
        return Ok(result);
    }
    let rate = consumed * 3_600_000.0 / result.span_ms as f64;
    let remaining_hours = (100.0 - last.1) / rate;
    let until_reset = (observation.resets_at_ms.unwrap() - last.0) as f64 / 3_600_000.0;
    result.status = "estimated".into();
    result.reason = None;
    result.consumption_percent_per_hour = Some(rate);
    result.survives_until_reset = Some(remaining_hours > until_reset);
    if remaining_hours <= until_reset {
        result.remaining_hours = Some(remaining_hours);
    }
    Ok(result)
}

fn prune_samples(conn: &Connection, now_ms: i64) -> Result<(), String> {
    let due=conn.execute("INSERT INTO monitor_state(key,data) VALUES('quota_samples_pruned_at',?1)
        ON CONFLICT(key) DO UPDATE SET data=excluded.data WHERE CAST(monitor_state.data AS INTEGER)<?2",
        params![now_ms.to_string(),now_ms-3_600_000]).map_err(|e|e.to_string())?;
    if due > 0 {
        conn.execute(
            "DELETE FROM monitor_quota_samples WHERE observed_ms<?1",
            [now_ms - 86_400_000],
        )
        .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM monitor_quota_samples WHERE rowid IN
            (SELECT rowid FROM monitor_quota_samples ORDER BY observed_ms DESC LIMIT -1 OFFSET 16384)",[])
            .map_err(|e|e.to_string())?;
    }
    Ok(())
}

fn from_cockpit(row: crate::cockpit_quota::QuotaSnapshot, tool: &str) -> QuotaObservation {
    use crate::cockpit_quota::QuotaWindowKind;
    let window_minutes = match row.window_kind {
        QuotaWindowKind::FiveHour => Some(300),
        QuotaWindowKind::Weekly => Some(10080),
        _ => None,
    };
    let limit_id = if row.model_id.is_empty() {
        format!("{:?}", row.window_kind)
    } else {
        row.model_id.clone()
    };
    QuotaObservation {
        tool: tool.into(),
        account_key: format!("cockpit:{}", row.account_id),
        account_label: row.email.chars().next().map(|c| format!("{c}***")),
        attribution: "account".into(),
        limit_id,
        slot: row.scope.clone(),
        window_minutes,
        plan: row.plan,
        model_id: (row.scope == "model").then_some(row.model_id),
        pool_label: (!row.display_name.is_empty()).then_some(row.display_name),
        observed_at_ms: row.updated_at_ms,
        resets_at_ms: row.reset_at_ms,
        used_percent: percent(row.used_fraction.map(|v| v * 100.0)),
        credits: None,
        source: "cockpit_snapshot".into(),
        source_error: row.unavailable_reason,
        stale_after_ms: if row.raw_kind == crate::cockpit_quota::SUBDIR_QUOTA_DESKTOP {
            60_000
        } else {
            300_000
        },
    }
}

pub fn collect_offline(conn: &Connection) -> Result<(), String> {
    prune_samples(conn, crate::ledger_db::now_ms())?;
    let mut sources = Vec::new();
    for (tool, channel) in [
        ("claude", crate::cockpit_quota::CH_CLAUDE),
        ("antigravity", crate::cockpit_quota::CH_ANTIGRAVITY),
    ] {
        let (status, error) = match crate::cockpit_quota::quota_snapshots(channel.into()) {
            Ok(rows) => {
                let error = rows.iter().find_map(|row| row.source_error.clone());
                let status = if rows.is_empty() {
                    "not_reported"
                } else if error.is_some() {
                    "partial"
                } else {
                    "available"
                };
                for row in rows {
                    save(conn, &from_cockpit(row, tool))?;
                }
                (status, error)
            }
            Err(error) => ("error", Some(error)),
        };
        if status != "available" {
            conn.execute(
                "DELETE FROM monitor_quota_samples WHERE quota_id IN
                (SELECT id FROM monitor_quotas WHERE tool=?1 AND account_key LIKE 'cockpit:%')",
                [tool],
            )
            .map_err(|e| e.to_string())?;
        }
        sources.push(QuotaSourceStatus {
            tool: tool.into(),
            source: "cockpit_snapshot".into(),
            status: status.into(),
            error,
            coverage: None,
            scope_note: if tool == "claude" {
                Some(claude_scope_note())
            } else {
                None
            },
        });
    }
    conn.execute(
        "INSERT INTO monitor_state(key,data) VALUES('quota_sources',?1)
        ON CONFLICT(key) DO UPDATE SET data=excluded.data",
        [serde_json::to_string(&sources).map_err(|e| e.to_string())?],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn claude_scope_note() -> String {
    let base = std::env::var("ANTHROPIC_BASE_URL").ok().or_else(|| {
        let dir = std::env::var_os("CLAUDE_CONFIG_DIR")
            .map(std::path::PathBuf::from)
            .or_else(|| {
                std::env::var_os("USERPROFILE")
                    .or_else(|| std::env::var_os("HOME"))
                    .map(|p| std::path::PathBuf::from(p).join(".claude"))
            })?;
        let value: Value =
            serde_json::from_reader(std::fs::File::open(dir.join("settings.json")).ok()?).ok()?;
        text(&value["env"], "ANTHROPIC_BASE_URL")
    });
    let proxy = base
        .as_deref()
        .and_then(|s| reqwest::Url::parse(s).ok())
        .is_some_and(|url| !matches!(url.host_str(), Some("api.anthropic.com" | "claude.ai")));
    if proxy {
        "Claude Code is configured for a proxy. Independent OAuth account snapshots do not report the proxy plan's allowance.".into()
    } else {
        "Cockpit snapshots describe independently attributed accounts, not proof of the current Claude Code connection's allowance.".into()
    }
}

pub fn read(conn: &Connection, now_ms: i64) -> Result<QuotaReport, String> {
    use rusqlite::OptionalExtension;
    let saved: Option<String> = conn
        .query_row(
            "SELECT data FROM monitor_state WHERE key='quota_sources'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let mut sources: Vec<QuotaSourceStatus> = saved
        .map(|s| serde_json::from_str(&s))
        .transpose()
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    let mut stmt = conn
        .prepare(
            "SELECT id,data,MIN(id) OVER (PARTITION BY tool,account_key)
        FROM monitor_quotas ORDER BY tool,account_key,limit_id,slot,window_minutes",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut quotas = Vec::new();
    for row in rows {
        let (id, data, account_id) = row.map_err(|e| e.to_string())?;
        let observation: QuotaObservation =
            serde_json::from_str(&data).map_err(|e| e.to_string())?;
        let expired = observation
            .resets_at_ms
            .is_some_and(|reset| reset <= now_ms);
        let stale = expired
            || observation
                .observed_at_ms
                .is_none_or(|time| now_ms.saturating_sub(time) > observation.stale_after_ms);
        let source_error = observation.source_error.clone().or_else(|| {
            sources
                .iter()
                .find(|s| s.tool == observation.tool && s.source == observation.source)
                .and_then(|s| s.error.clone())
        });
        let stale = stale || source_error.is_some();
        let depletion = depletion(conn, id, &observation, stale, source_error.is_some())?;
        quotas.push(QuotaSnapshot {
            id,
            account_key: format!("{}:{account_id}", observation.tool),
            account_label: observation.account_label.unwrap_or_else(|| {
                if observation.attribution == "account" {
                    format!("Account {account_id}")
                } else {
                    format!("Unattributed session {account_id}")
                }
            }),
            tool: observation.tool,
            attribution: observation.attribution,
            limit_id: observation.limit_id,
            slot: observation.slot,
            window_minutes: observation.window_minutes,
            plan: observation.plan,
            model_id: observation.model_id,
            pool_label: observation.pool_label,
            observed_at_ms: observation.observed_at_ms,
            resets_at_ms: observation.resets_at_ms,
            used_percent: observation.used_percent,
            remaining_percent: observation.used_percent.map(|used| 100.0 - used),
            credits: observation.credits,
            source: observation.source,
            stale,
            expired,
            source_error,
            depletion,
        });
    }
    let bootstrap: Option<String> = conn
        .query_row(
            "SELECT data FROM monitor_state WHERE key='quota_bootstrap_v1'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let coverage: Option<BootstrapCoverage> = bootstrap
        .map(|s| serde_json::from_str(&s))
        .transpose()
        .map_err(|e| e.to_string())?;
    let error = coverage
        .as_ref()
        .filter(|c| c.metadata_errors + c.tail_errors > 0)
        .map(|c| {
            format!(
                "Quota bootstrap: {} metadata reads and {} tail reads failed",
                c.metadata_errors, c.tail_errors
            )
        });
    let reported = quotas.iter().any(|q| q.tool == "codex");
    let partial = coverage
        .as_ref()
        .is_some_and(|c| c.scopes_unreported + c.metadata_errors + c.tail_errors > 0);
    sources.push(QuotaSourceStatus {
        tool: "codex".into(),
        source: "codex_local_log".into(),
        status: if reported && partial {
            "partial"
        } else if reported {
            "available"
        } else {
            "not_reported"
        }
        .into(),
        error,
        coverage,
        scope_note: Some("One-time bounded tails cover reported scopes only; unreported scopes are not assumed unlimited.".into()),
    });
    Ok(QuotaReport {
        collected_at_ms: now_ms,
        quotas,
        sources,
    })
}

fn session_header(path: &Path) -> Result<Value, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut first = String::new();
    BufReader::new(file.take(2 * 1024 * 1024))
        .read_line(&mut first)
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&first).map_err(|_| "Invalid Codex session metadata".to_string())
}

pub fn account_from_header(path: &Path) -> Result<Option<String>, String> {
    let value = session_header(path)?;
    if value["type"] != "session_meta" {
        return Ok(None);
    }
    Ok(text(
        value.get("payload").unwrap_or(&value),
        "creator_account_id",
    ))
}

pub fn bootstrap(conn: &Connection) -> Result<(), String> {
    use rusqlite::OptionalExtension;
    let done: Option<String> = conn
        .query_row(
            "SELECT data FROM monitor_state WHERE key='quota_credits_bootstrap_v1'",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if done.is_some() {
        return Ok(());
    }
    let mut stmt = conn
        .prepare("SELECT path,state FROM monitor_files WHERE tool='codex'")
        .map_err(|e| e.to_string())?;
    let paths = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let mut coverage = BootstrapCoverage {
        registered_files: paths.len(),
        ..Default::default()
    };
    let mut accounts =
        std::collections::BTreeMap::<String, Vec<(u128, String, String, Option<String>)>>::new();
    for (path, json) in paths {
        let mut state: super::parser::ParserState =
            serde_json::from_str(&json).map_err(|e| e.to_string())?;
        if !state.quota_identity_loaded {
            match account_from_header(Path::new(&path)) {
                Ok(account) => state.quota_account_id = account,
                Err(error) => {
                    coverage.metadata_errors += 1;
                    state.quota_identity_error = Some(error);
                }
            }
            state.quota_identity_loaded = true;
            conn.execute(
                "UPDATE monitor_files SET state=?1 WHERE path=?2",
                params![
                    serde_json::to_string(&state).map_err(|e| e.to_string())?,
                    path
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        let session = state
            .session
            .as_ref()
            .map(|s| s.id.clone())
            .unwrap_or_else(|| path.clone());
        let key = state
            .quota_account_id
            .as_ref()
            .map(|id| format!("account:{id}"))
            .unwrap_or_else(|| format!("session:{session}"));
        let modified = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_millis());
        accounts
            .entry(key)
            .or_default()
            .push((modified, path, session, state.quota_account_id));
    }
    for files in accounts.values_mut() {
        files.sort_by(|a, b| b.0.cmp(&a.0));
        let mut reported = false;
        for (_, path, session, account) in files.iter().take(4) {
            match tail_observations(Path::new(path), account.as_deref(), session) {
                Ok(observations) if !observations.is_empty() => {
                    for observation in observations {
                        save(conn, &observation)?;
                    }
                    reported = true;
                    break;
                }
                Ok(_) => {}
                Err(_) => coverage.tail_errors += 1,
            }
        }
        if reported {
            coverage.scopes_reported += 1;
        } else {
            coverage.scopes_unreported += 1;
        }
    }
    // A bounded one-off tail read never rewinds the usage collector's durable offsets.
    conn.execute(
        "INSERT INTO monitor_state(key,data) VALUES('quota_bootstrap_v1',?1)
         ON CONFLICT(key) DO UPDATE SET data=excluded.data",
        [serde_json::to_string(&coverage).map_err(|e| e.to_string())?],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO monitor_state(key,data) VALUES('quota_credits_bootstrap_v1','done')",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn tail_observations(
    path: &Path,
    account: Option<&str>,
    session_id: &str,
) -> Result<Vec<QuotaObservation>, String> {
    let header = session_header(path)?;
    let metadata = header.get("payload").unwrap_or(&header);
    let owner = text(metadata, "id").or_else(|| text(metadata, "thread_id"));
    let fork = text(metadata, "forked_from_id").is_some();
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let file_metadata = file.metadata().map_err(|e| e.to_string())?;
    let started_at_ms = quota_timestamp(&metadata["timestamp"])
        .or_else(|| quota_timestamp(&header["timestamp"]))
        .unwrap_or_else(|| {
            file_metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |time| time.as_millis() as i64)
        });
    let len = file_metadata.len();
    let start = len.saturating_sub(128 * 1024);
    file.seek(SeekFrom::Start(start))
        .map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(file.take(len - start));
    let mut line = String::new();
    if start > 0 {
        reader.read_line(&mut line).map_err(|e| e.to_string())?;
    }
    let mut observations = Vec::new();
    loop {
        line.clear();
        if reader.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
            break;
        }
        if !line.contains("\"rate_limits\"") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value["type"] != "event_msg" || value["payload"]["type"] != "token_count" {
            continue;
        }
        let time = quota_timestamp(&value["timestamp"]).or_else(|| quota_timestamp(&value["time"]));
        let owner_matches = text(&value["payload"], "thread_id")
            .is_none_or(|id| id == owner.as_deref().unwrap_or(session_id));
        // Match the streaming parser: copied fork history is not this account's observation.
        if !owner_matches || (fork && time.is_some_and(|time| time < started_at_ms)) {
            continue;
        }
        observations.extend(codex_observations(
            &value["payload"],
            account,
            session_id,
            time,
        ));
    }
    Ok(observations)
}

fn quota_timestamp(value: &Value) -> Option<i64> {
    value
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|time| time.timestamp_millis())
        .or_else(|| {
            value.as_i64().and_then(|time| {
                if time >= 1_000_000_000_000 {
                    Some(time)
                } else {
                    time.checked_mul(1000)
                }
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        super::super::store::initialize(&conn).unwrap();
        conn
    }
    fn event(used: Value) -> Value {
        json!({"type":"token_count","info":null,"rate_limits":{"limit_id":"codex",
            "primary":{"used_percent":used,"window_minutes":10080,"resets_at":2000},"secondary":null}})
    }

    #[test]
    fn only_verified_overall_weekly_pools_update_or_bootstrap_monetary_cycles() {
        let day = 86_400_000;
        let start = 1_800_000_000_000;
        for (tool, overall, restricted) in [
            ("codex", Some("codex"), vec!["Weekly", "seven_day"]),
            ("claude", Some("seven_day"), vec!["seven_day_sonnet"]),
            ("antigravity", None, vec!["gemini-weekly", "3p-weekly"]),
        ] {
            let conn = db();
            let point = |limit_id: &str, observed, reset, used| {
                let mut point = trend_point(Some("owner"), "session", observed, used);
                point.tool = tool.into();
                point.limit_id = limit_id.into();
                point.resets_at_ms = Some(reset);
                point.credits = Some(QuotaCredits {
                    has_credits: Some(true), unlimited: Some(false), balance: Some("42.000".into()),
                });
                point
            };
            let assert_cycles = || {
                let cycles = conn.prepare(
                    "SELECT start_ms,reset_ms,observed_ms,used_percent,exhausted_ms FROM monitor_account_cycles ORDER BY start_ms",
                ).unwrap().query_map([], |row| Ok((
                    row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?,
                    row.get::<_, f64>(3)?, row.get::<_, Option<i64>>(4)?,
                ))).unwrap().collect::<Result<Vec<_>, _>>().unwrap();
                let expected = if overall.is_some() {
                    vec![(start, start + 7 * day, start + day, 8., None)]
                } else { vec![] };
                assert_eq!(cycles, expected, "{tool}");
            };
            if let Some(limit_id) = overall {
                save(&conn, &point(limit_id, start + day, start + 7 * day, 8.)).unwrap();
            }
            for (index, limit_id) in restricted.iter().enumerate() {
                let offset = (2 + index as i64 * 2) * day;
                let reset = start + offset + 7 * day;
                save(&conn, &point(limit_id, start + offset, reset, 0.)).unwrap();
                assert_cycles();
                save(&conn, &point(limit_id, start + offset + day, reset, 100.)).unwrap();
                assert_cycles();
            }
            let raw = || conn.prepare("SELECT data FROM monitor_quotas ORDER BY id").unwrap()
                .query_map([], |row| row.get::<_, String>(0)).unwrap()
                .collect::<Result<Vec<_>, _>>().unwrap();
            let saved = raw();
            assert_eq!(saved.len(), usize::from(overall.is_some()) + restricted.len());
            assert!(saved.iter().all(|json| serde_json::from_str::<QuotaObservation>(json).unwrap()
                .credits.unwrap().balance.as_deref() == Some("42.000")));
            assert_eq!(conn.query_row(
                "SELECT COUNT(*) FROM monitor_quota_samples", [], |row| row.get::<_, usize>(0),
            ).unwrap(), saved.len());

            // Simulate an existing installation retaining raw snapshots but no monetary rounds.
            conn.execute("DELETE FROM monitor_account_cycles", []).unwrap();
            super::super::accounts::initialize(&conn).unwrap();
            assert_cycles();
            assert_eq!(raw(), saved);
            assert_eq!(conn.query_row(
                "SELECT COUNT(*) FROM monitor_quota_samples", [], |row| row.get::<_, usize>(0),
            ).unwrap(), saved.len());
        }
    }

    #[test]
    fn credits_preserve_true_false_unknown_and_legacy_json() {
        let mut payload = event(json!(100));
        payload["rate_limits"]["credits"] = json!({
            "has_credits":true,"unlimited":false,"balance":"56033.5765135000"
        });
        let observation = codex_observations(&payload, Some("owner"), "s", Some(1000)).remove(0);
        let credits = observation.credits.as_ref().unwrap();
        assert_eq!(credits.has_credits, Some(true));
        assert_eq!(credits.unlimited, Some(false));
        assert_eq!(credits.balance.as_deref(), Some("56033.5765135000"));
        let mut legacy = serde_json::to_value(&observation).unwrap();
        legacy.as_object_mut().unwrap().remove("credits");
        assert!(serde_json::from_value::<QuotaObservation>(legacy)
            .unwrap()
            .credits
            .is_none());

        payload["rate_limits"]["credits"] = json!({"has_credits":false,"balance":"0"});
        let credits = codex_observations(&payload, Some("owner"), "s", Some(1000))
            .remove(0)
            .credits
            .unwrap();
        assert_eq!(credits.has_credits, Some(false));
        assert_eq!(credits.unlimited, None);
        assert_eq!(credits.balance.as_deref(), Some("0"));
        payload["rate_limits"]["credits"] = json!({"unlimited":true});
        let credits = codex_observations(&payload, Some("owner"), "s", Some(1000))
            .remove(0)
            .credits
            .unwrap();
        assert_eq!(credits.has_credits, None);
        assert_eq!(credits.unlimited, Some(true));
        payload["rate_limits"]["credits"] = json!({"has_credits":null});
        assert!(
            codex_observations(&payload, Some("owner"), "s", Some(1000))[0]
                .credits
                .is_none()
        );
    }

    #[test]
    fn credits_enrich_same_time_without_replacing_quota_or_summing_windows() {
        let conn = db();
        let old = codex_observations(&event(json!(100)), Some("owner"), "s", Some(1000)).remove(0);
        let mut legacy = serde_json::to_value(&old).unwrap();
        legacy.as_object_mut().unwrap().remove("credits");
        save(&conn, &serde_json::from_value(legacy).unwrap()).unwrap();
        let mut payload = event(json!(7));
        payload["rate_limits"]["secondary"] = json!({
            "used_percent":50,"window_minutes":300,"resets_at":2000
        });
        payload["rate_limits"]["credits"] =
            json!({"has_credits":true,"unlimited":false,"balance":"12.300"});
        for row in codex_observations(&payload, Some("owner"), "other-session", Some(1000)) {
            save(&conn, &row).unwrap();
        }
        let report = read(&conn, 1000).unwrap();
        assert_eq!(report.quotas.len(), 2);
        assert_eq!(report.quotas[0].account_key, report.quotas[1].account_key);
        assert!(report
            .quotas
            .iter()
            .all(|row| row.credits.as_ref().unwrap().balance.as_deref() == Some("12.300")));
        let primary = report
            .quotas
            .iter()
            .find(|row| row.slot == "primary")
            .unwrap();
        assert_eq!(primary.used_percent, Some(100.0));
        let serialized = serde_json::to_value(primary).unwrap();
        assert_eq!(serialized["credits"]["hasCredits"], true);
        assert_eq!(serialized["credits"]["unlimited"], false);
        assert_eq!(serialized["credits"]["balance"], "12.300");

        payload["rate_limits"]["credits"]["balance"] = json!("999");
        for time in [999, 1000] {
            save(
                &conn,
                &codex_observations(&payload, Some("owner"), "s", Some(time))[0],
            )
            .unwrap();
        }
        assert_eq!(
            read(&conn, 1000).unwrap().quotas[0]
                .credits
                .as_ref()
                .unwrap()
                .balance
                .as_deref(),
            Some("12.300")
        );
        let newer = codex_observations(&event(json!(90)), Some("owner"), "s", Some(2000)).remove(0);
        save(&conn, &newer).unwrap();
        save(
            &conn,
            &codex_observations(&payload, Some("owner"), "s", Some(1000))[0],
        )
        .unwrap();
        let report = read(&conn, 2000).unwrap();
        let primary = report
            .quotas
            .iter()
            .find(|row| row.slot == "primary")
            .unwrap();
        assert_eq!(primary.observed_at_ms, Some(2000));
        assert!(primary.credits.is_none());
    }

    #[test]
    fn weekly_primary_without_usage_is_persisted_and_shared_accounts_deduplicate() {
        let conn = db();
        for (session, time, used) in [
            ("parent", 1000, 83),
            ("child", 2000, 84),
            ("older", 1500, 0),
        ] {
            for row in codex_observations(
                &event(json!(used)),
                Some("PRIVATE-ACCOUNT"),
                session,
                Some(time),
            ) {
                save(&conn, &row).unwrap();
            }
        }
        let report = read(&conn, 2500).unwrap();
        assert_eq!(report.quotas.len(), 1);
        let row = &report.quotas[0];
        assert_eq!(row.window_minutes, Some(10080));
        assert_eq!(row.remaining_percent, Some(16.0));
        assert_eq!(row.slot, "primary");
        let expired = read(&conn, 2_000_000).unwrap();
        assert!(expired.quotas[0].expired);
        assert_eq!(expired.quotas[0].remaining_percent, Some(16.0));
        assert!(!serde_json::to_string(&report)
            .unwrap()
            .contains("PRIVATE-ACCOUNT"));
    }

    #[test]
    fn unattributed_sessions_stay_separate_and_invalid_is_not_zero() {
        let conn = db();
        for (id, used) in [
            ("one", json!(0)),
            ("two", json!(101)),
            ("three", Value::Null),
        ] {
            save(
                &conn,
                &codex_observations(&event(used), None, id, Some(1000))[0],
            )
            .unwrap();
        }
        let report = read(&conn, 301_001).unwrap();
        assert_eq!(report.quotas.len(), 3);
        assert!(report
            .quotas
            .iter()
            .all(|r| r.attribution == "unattributed" && r.stale));
        assert_eq!(
            report
                .quotas
                .iter()
                .filter(|r| r.remaining_percent == Some(100.0))
                .count(),
            1
        );
        assert_eq!(
            report
                .quotas
                .iter()
                .filter(|r| r.remaining_percent.is_none())
                .count(),
            2
        );
        let expired = read(&conn, 2_000_000).unwrap();
        assert!(expired.quotas.iter().all(|r| r.expired && r.stale));
        assert_eq!(expired.quotas[0].remaining_percent, Some(100.0));
    }

    #[test]
    fn parser_emits_quota_before_missing_usage_and_repeated_totals_returns() {
        let mut state = super::super::parser::ParserState::default();
        let path = Path::new("synthetic-rollout.jsonl");
        super::super::parser::parse_line(
            &mut state,
            "codex",
            path,
            &json!({"type":"session_meta","timestamp":"2026-10-16T00:00:00Z",
                "payload":{"id":"session","creator_account_id":"private"}})
            .to_string(),
            0,
        )
        .unwrap();
        for info in [
            Value::Null,
            json!({"total_token_usage":{"input_tokens":0,"output_tokens":0}}),
        ] {
            let mut payload = event(json!(83));
            payload["info"] = info;
            let line =
                json!({"type":"event_msg","timestamp":"2026-10-16T00:01:00Z","payload":payload})
                    .to_string();
            for _ in 0..2 {
                let parsed =
                    super::super::parser::parse_line(&mut state, "codex", path, &line, 0).unwrap();
                assert_eq!(parsed.quotas.len(), 1);
                assert_eq!(parsed.quotas[0].account_key, "account:private");
            }
        }
    }

    #[test]
    fn bootstrap_groups_accounts_preserves_offsets_and_persists_watermark() {
        let dir = std::env::temp_dir().join(format!(
            "console-quota-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("test.sqlite");
        {
            let conn = Connection::open(&db_path).unwrap();
            super::super::store::initialize(&conn).unwrap();
            conn.execute(
                "INSERT INTO monitor_state(key,data) VALUES('quota_bootstrap_v1','{}')",
                [],
            )
            .unwrap();
            for n in 0..18 {
                let account = if n == 0 { "other" } else { "shared" };
                let session = format!("session-{n}");
                let path = dir.join(format!("rollout-{n:02}.jsonl"));
                let mut payload = event(json!(42));
                payload["rate_limits"]["credits"] = json!({"has_credits":true,"balance":"42.000"});
                let body = format!(
                    "{}\n{}\n",
                    json!({"type":"session_meta","payload":{
                    "id":session,"creator_account_id":account}}),
                    json!({"type":"event_msg","timestamp":"2026-10-16T00:01:00Z","payload":payload})
                );
                std::fs::write(&path, &body).unwrap();
                let mut state = super::super::parser::ParserState::default();
                state.session = Some(super::super::types::SessionMeta {
                    id: session,
                    ..Default::default()
                });
                conn.execute(
                    "INSERT INTO monitor_files(path,tool,offset,signature,state)
                    VALUES(?1,'codex',?2,'keep-signature',?3)",
                    params![
                        path.to_string_lossy(),
                        body.len(),
                        serde_json::to_string(&state).unwrap()
                    ],
                )
                .unwrap();
            }
            bootstrap(&conn).unwrap();
            let report = read(&conn, 1_792_108_900_000).unwrap();
            assert_eq!(report.quotas.len(), 2);
            assert!(report.quotas.iter().all(|row| row
                .credits
                .as_ref()
                .unwrap()
                .balance
                .as_deref()
                == Some("42.000")));
            let unchanged: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM monitor_files
                WHERE signature='keep-signature' AND offset>0",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(unchanged, 18);
            conn.execute("DELETE FROM monitor_files", []).unwrap();
            bootstrap(&conn).unwrap();
        }
        let conn = Connection::open(&db_path).unwrap();
        assert_eq!(read(&conn, 1_792_108_900_000).unwrap().quotas.len(), 2);
        drop(conn);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn fork_bootstrap_rejects_parent_and_pre_fork_quota_without_claiming_coverage() {
        let path = std::env::temp_dir().join(format!(
            "console-quota-fork-{}-{}.jsonl",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let header = json!({"type":"session_meta","timestamp":"2026-10-16T02:00:00Z",
            "payload":{"id":"child","creator_account_id":"account-A","forked_from_id":"parent"}});
        let mut parent = event(json!(42));
        parent["thread_id"] = json!("parent");
        let body = format!(
            "{header}\n{}\n{}\n",
            json!({"type":"event_msg","timestamp":"2026-10-16T03:00:00Z","payload":parent}),
            json!({"type":"event_msg","timestamp":"2026-10-16T01:00:00Z","payload":event(json!(42))})
        );
        std::fs::write(&path, &body).unwrap();
        let mut state = super::super::parser::ParserState::default();
        super::super::parser::parse_line(&mut state, "codex", &path, &header.to_string(), 0)
            .unwrap();
        let conn = db();
        conn.execute(
            "INSERT INTO monitor_files(path,tool,offset,signature,state)
            VALUES(?1,'codex',?2,'unchanged',?3)",
            params![
                path.to_string_lossy(),
                body.len(),
                serde_json::to_string(&state).unwrap()
            ],
        )
        .unwrap();
        bootstrap(&conn).unwrap();
        let report = read(&conn, 1_792_108_900_000).unwrap();
        assert!(report.quotas.is_empty());
        assert_eq!(
            report
                .sources
                .iter()
                .find(|s| s.tool == "codex")
                .unwrap()
                .coverage
                .as_ref()
                .unwrap()
                .scopes_unreported,
            1
        );
        let offset: usize = conn
            .query_row("SELECT offset FROM monitor_files", [], |r| r.get(0))
            .unwrap();
        assert_eq!(offset, body.len());
        let mut own = event(json!(7));
        own["thread_id"] = json!("child");
        std::fs::write(
            &path,
            format!(
                "{body}{}\n",
                json!({"type":"event_msg",
            "timestamp":"2026-10-16T03:01:00Z","payload":own})
            ),
        )
        .unwrap();
        let rows = tail_observations(&path, Some("account-A"), "child").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].used_percent, Some(7.0));
        std::fs::remove_file(path).unwrap();
    }

    fn trend_point(account: Option<&str>, session: &str, time: i64, used: f64) -> QuotaObservation {
        let mut point =
            codex_observations(&event(json!(used)), account, session, Some(time)).remove(0);
        point.resets_at_ms = Some(36_000_000);
        point.plan = Some("pro".into());
        point
    }

    fn seed_trend(conn: &Connection) {
        for (time, used) in [(1_000_000, 20.0), (1_300_000, 40.0), (1_600_000, 60.0)] {
            save(conn, &trend_point(Some("shared"), "parent", time, used)).unwrap();
        }
    }

    #[test]
    fn depletion_uses_same_pool_samples_without_summing_accounts_or_rounding_fractions() {
        let conn = db();
        for (session, time, used) in [
            ("parent", 1_000_000, 20.1),
            ("child", 1_300_000, 20.2),
            ("parent", 1_600_000, 20.3),
        ] {
            save(&conn, &trend_point(Some("shared"), session, time, used)).unwrap();
        }
        save(
            &conn,
            &trend_point(Some("shared"), "child", 1_600_000, 20.3),
        )
        .unwrap();
        save(&conn, &trend_point(Some("other"), "other", 1_600_000, 99.0)).unwrap();
        let report = read(&conn, 1_600_000).unwrap();
        assert_eq!(report.quotas.len(), 2);
        let row = report
            .quotas
            .iter()
            .find(|r| r.used_percent == Some(20.3))
            .unwrap();
        assert!((row.remaining_percent.unwrap() - 79.7).abs() < 1e-9);
        assert_eq!(row.depletion.status, "estimated");
        assert_eq!(row.depletion.sample_count, 3);
        assert_eq!(row.depletion.span_ms, 600_000);
        assert_eq!(row.depletion.as_of_ms, row.observed_at_ms);
        assert!((row.depletion.consumption_percent_per_hour.unwrap() - 1.2).abs() < 1e-9);
        assert_eq!(row.depletion.survives_until_reset, Some(true));
        assert!(row.depletion.remaining_hours.is_none());
        assert_eq!(
            report
                .quotas
                .iter()
                .find(|r| r.used_percent == Some(99.0))
                .unwrap()
                .depletion
                .status,
            "insufficient_samples"
        );
    }

    #[test]
    fn depletion_starts_new_segment_at_reset_plan_decrease_or_sampling_gap() {
        for reason in [
            "reset_changed",
            "plan_changed",
            "usage_decreased",
            "sampling_gap",
        ] {
            let conn = db();
            seed_trend(&conn);
            let estimate = read(&conn, 1_600_000).unwrap();
            assert!(
                (estimate.quotas[0].depletion.remaining_hours.unwrap() - 1.0 / 6.0).abs() < 1e-9
            );
            let mut point = trend_point(Some("shared"), "child", 1_900_000, 65.0);
            match reason {
                "reset_changed" => point.resets_at_ms = Some(72_000_000),
                "plan_changed" => point.plan = Some("new-plan".into()),
                "usage_decreased" => point.used_percent = Some(30.0),
                "sampling_gap" => point.observed_at_ms = Some(2_200_000),
                _ => unreachable!(),
            }
            save(&conn, &point).unwrap();
            let report = read(&conn, point.observed_at_ms.unwrap()).unwrap();
            let forecast = &report.quotas[0].depletion;
            assert_eq!(forecast.status, "insufficient_samples");
            assert_eq!(forecast.sample_count, 1);
            assert_eq!(forecast.reason.as_deref(), Some(reason));
            assert!(forecast.remaining_hours.is_none());
        }
    }

    #[test]
    fn depletion_excludes_stale_error_unattributed_and_zero_or_short_samples() {
        let conn = db();
        seed_trend(&conn);
        let stale = read(&conn, 1_900_001).unwrap();
        assert_eq!(stale.quotas[0].depletion.reason.as_deref(), Some("stale"));
        let mut failed = trend_point(Some("shared"), "parent", 1_900_000, 60.0);
        failed.source_error = Some("metadata unavailable".into());
        save(&conn, &failed).unwrap();
        assert_eq!(
            read(&conn, 1_900_000).unwrap().quotas[0]
                .depletion
                .reason
                .as_deref(),
            Some("source_error")
        );
        save(&conn, &trend_point(None, "unattributed", 1_900_000, 10.0)).unwrap();
        assert!(read(&conn, 1_900_000).unwrap().quotas.iter().any(|r| r
            .depletion
            .reason
            .as_deref()
            == Some("unattributed")));
        let idle = db();
        for time in [1_000_000, 1_300_000, 1_600_000] {
            save(&idle, &trend_point(Some("idle"), "session", time, 5.0)).unwrap();
        }
        let forecast = read(&idle, 1_600_000).unwrap().quotas.remove(0).depletion;
        assert_eq!(forecast.status, "insufficient_samples");
        assert_eq!(forecast.reason.as_deref(), Some("no_observed_consumption"));
        assert!(forecast.remaining_hours.is_none());
        assert!(forecast.survives_until_reset.is_none());
    }

    #[test]
    fn quota_samples_are_bounded_and_cleanup_does_not_change_reported_quota() {
        let conn = db();
        for n in 0..110 {
            save(
                &conn,
                &trend_point(
                    Some("bounded"),
                    "session",
                    1_000_000 + n * 300_000,
                    n as f64 * 0.1,
                ),
            )
            .unwrap();
        }
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM monitor_quota_samples", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 96);
        prune_samples(&conn, 200_000_000).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM monitor_quota_samples", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
        assert_eq!(
            read(&conn, 33_700_000).unwrap().quotas[0].used_percent,
            Some(10.9)
        );
    }
}
