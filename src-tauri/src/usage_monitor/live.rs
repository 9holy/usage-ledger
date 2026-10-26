use super::types::*;
use rusqlite::{params, Connection};
use std::collections::{BTreeMap, BTreeSet};

pub const RETENTION_MS: i64 = 3_660_000;
const GAP_MS: i64 = 5_000;
const MINUTE: i64 = 60_000;
const TOOLS: [&str; 4] = ["codex", "claude", "antigravity", "deepseek-harness"];

pub fn initialize(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS monitor_live_coverage (
        source TEXT NOT NULL,tool TEXT NOT NULL,start_ms INTEGER NOT NULL,end_ms INTEGER NOT NULL,
        open INTEGER NOT NULL,PRIMARY KEY(source,tool,start_ms));
        CREATE INDEX IF NOT EXISTS monitor_live_coverage_end ON monitor_live_coverage(end_ms);",
    )
    .map_err(|error| error.to_string())
}

pub struct CoverageWriter {
    source: &'static str,
    active: BTreeMap<String, (i64, i64)>,
    paused: BTreeSet<String>,
}
impl CoverageWriter {
    pub fn new(source: &'static str) -> Self {
        Self {
            source,
            active: BTreeMap::new(),
            paused: BTreeSet::new(),
        }
    }
    pub fn observe(
        &mut self,
        conn: &Connection,
        tool: &str,
        now: i64,
        healthy: bool,
    ) -> Result<(), String> {
        let previous = self.active.get(tool).copied();
        let paused = self.paused.remove(tool);
        let contiguous =
            healthy && previous.is_some_and(|(_, end)| now >= end && now - end <= GAP_MS);
        if !contiguous {
            if let Some((start, _)) = self.active.remove(tool) {
                conn.execute("UPDATE monitor_live_coverage SET open=0 WHERE source=?1 AND tool=?2 AND start_ms=?3",params![self.source,tool,start]).map_err(|error|error.to_string())?;
            }
        }
        if !healthy {
            return Ok(());
        }
        if contiguous {
            let (start, last) = previous.unwrap();
            if now - last < 1_000 && !paused {
                return Ok(());
            }
            conn.execute("UPDATE monitor_live_coverage SET end_ms=?4,open=1 WHERE source=?1 AND tool=?2 AND start_ms=?3",params![self.source,tool,start,now]).map_err(|error|error.to_string())?;
            self.active.insert(tool.into(), (start, now));
        } else {
            conn.execute("INSERT INTO monitor_live_coverage(source,tool,start_ms,end_ms,open) VALUES(?1,?2,?3,?3,1)",params![self.source,tool,now]).map_err(|error|error.to_string())?;
            self.active.insert(tool.into(), (now, now));
        }
        Ok(())
    }
    pub fn pause(&mut self, conn: &Connection, tool: &str) -> Result<(), String> {
        if let Some((start, _)) = self.active.get(tool) {
            if self.paused.insert(tool.into()) {
                conn.execute("UPDATE monitor_live_coverage SET open=0 WHERE source=?1 AND tool=?2 AND start_ms=?3",params![self.source,tool,start]).map_err(|error|error.to_string())?;
            }
        }
        Ok(())
    }
}

pub fn prune(conn: &Connection, now: i64) -> Result<(), String> {
    conn.execute(
        "DELETE FROM monitor_observations WHERE observed_ms<?1",
        [now - RETENTION_MS],
    )
    .map_err(|error| error.to_string())?;
    conn.execute(
        "DELETE FROM monitor_live_coverage WHERE end_ms<?1",
        [now - RETENTION_MS],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

fn merge_spans(mut spans: Vec<(i64, i64)>) -> Vec<(i64, i64)> {
    spans.sort_unstable();
    let mut merged: Vec<(i64, i64)> = Vec::new();
    for (start, end) in spans {
        if let Some(last) = merged.last_mut().filter(|last| start <= last.1) {
            last.1 = last.1.max(end);
        } else {
            merged.push((start, end));
        }
    }
    merged
}
fn source_covered(
    spans: &BTreeMap<String, Vec<(i64, i64)>>,
    tool: &str,
    start: i64,
    end: i64,
) -> i64 {
    spans
        .get(tool)
        .into_iter()
        .flatten()
        .map(|(a, b)| (end.min(*b) - start.max(*a)).max(0))
        .sum()
}
fn covered(
    spans: &BTreeMap<String, Vec<(i64, i64)>>,
    tool: Option<&str>,
    start: i64,
    end: i64,
) -> i64 {
    let Some(tool) = tool else {
        return source_covered(spans, "*", start, end);
    };
    let mut count = 0;
    for (a, b) in spans.get("*").into_iter().flatten() {
        for (c, d) in spans.get(tool).into_iter().flatten() {
            count += (end.min(*b).min(*d) - start.max(*a).max(*c)).max(0);
        }
    }
    count
}
fn source_complete(
    spans: &BTreeMap<String, Vec<(i64, i64)>>,
    tool: Option<&str>,
    start: i64,
    end: i64,
) -> bool {
    match tool {
        Some(tool) => source_covered(spans, tool, start, end) == end - start,
        None => TOOLS
            .iter()
            .all(|tool| source_covered(spans, tool, start, end) == end - start),
    }
}

#[derive(Default)]
struct Counts {
    short: i64,
    long: i64,
}
fn windows(
    counts: &Counts,
    spans: &BTreeMap<String, Vec<(i64, i64)>>,
    now: i64,
    tool: Option<&str>,
) -> Vec<LiveWindow> {
    [(60, counts.short), (300, counts.long)]
        .into_iter()
        .map(|(seconds, tokens)| {
            let covered_ms = covered(spans, tool, now - seconds * 1_000, now);
            let complete = covered_ms == seconds * 1_000;
            LiveWindow {
                seconds,
                observed_output_tokens: tokens,
                output_tokens_per_second: complete.then_some(tokens as f64 / seconds as f64),
                covered_ms,
                complete,
                source_complete: source_complete(spans, tool, now - seconds * 1_000, now),
            }
        })
        .collect()
}
fn counted_windows(counts: &Counts, coverage: &[LiveWindow]) -> Vec<LiveWindow> {
    coverage
        .iter()
        .zip([counts.short, counts.long])
        .map(|(window, tokens)| LiveWindow {
            observed_output_tokens: tokens,
            output_tokens_per_second: window.complete.then_some(tokens as f64 / window.seconds as f64),
            ..window.clone()
        })
        .collect()
}
fn add(counts: &mut Counts, timestamp: i64, tokens: i64, now: i64) {
    if timestamp > now - 60_000 {
        counts.short += tokens;
    }
    if timestamp > now - 300_000 {
        counts.long += tokens;
    }
}

fn minute_buckets(
    minutes: [i64; 60],
    spans: &BTreeMap<String, Vec<(i64, i64)>>,
    now: i64,
    tool: Option<&str>,
) -> Vec<LiveBucket> {
    minutes
        .into_iter()
        .enumerate()
        .map(|(index, tokens)| {
            let start = now - (60 - index as i64) * MINUTE;
            let end = start + MINUTE;
            let covered_ms = covered(spans, tool, start, end);
            let source_complete = source_complete(spans, tool, start, end);
            LiveBucket {
                start_ms: start,
                end_ms: end,
                observed_output_tokens: tokens,
                output_tokens: (covered_ms == MINUTE && source_complete).then_some(tokens),
                covered_ms,
                source_complete,
            }
        })
        .collect()
}

fn recorded_timeline(
    conn: &Connection,
    now: i64,
) -> Result<
    (
        Vec<RecordedOutputBucket>,
        BTreeMap<String, Vec<RecordedOutputBucket>>,
    ),
    String,
> {
    let start = now - 60 * MINUTE;
    let empty_buckets = || {
        (0..60)
            .map(|index| RecordedOutputBucket {
                start_ms: start + index * MINUTE,
                end_ms: start + (index + 1) * MINUTE,
                output_tokens: None,
                known_output_tokens: 0,
                request_count: 0,
                unknown_output_requests: 0,
            })
            .collect::<Vec<_>>()
    };
    let mut global = empty_buckets();
    let mut by_tool: BTreeMap<String, Vec<RecordedOutputBucket>> = TOOLS
        .into_iter()
        .map(|tool| (tool.into(), empty_buckets()))
        .collect();
    // Saved event timestamps locate usage reports, not individual generated tokens.
    let mut query = conn.prepare(
        "WITH requests AS (
            SELECT tool,(timestamp_ms-?1)/60000 AS minute,
                CASE WHEN json_type(usage,'$.outputTokens')='integer'
                    AND NOT EXISTS(SELECT 1 FROM json_each(usage,'$.unknownFields') WHERE value='output_tokens')
                    THEN json_extract(usage,'$.outputTokens') END AS output
            FROM monitor_requests
            WHERE timestamp_ms>=?1 AND timestamp_ms<?2
                AND COALESCE(json_extract(usage,'$.usageBasis'),'')!='legacy_initial_cumulative'
                AND NOT EXISTS(SELECT 1 FROM json_each(usage,'$.unknownFields') WHERE value='timestamp')
        ) SELECT tool,minute,COALESCE(SUM(output),0),COUNT(*),COUNT(*)-COUNT(output)
            FROM requests GROUP BY tool,minute",
    ).map_err(|error| error.to_string())?;
    let rows = query
        .query_map(params![start, now], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)? as usize,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    for row in rows {
        let (tool, minute, known, requests, unknown) = row.map_err(|error| error.to_string())?;
        for bucket in [
            &mut by_tool.entry(tool).or_insert_with(&empty_buckets)[minute],
            &mut global[minute],
        ] {
            bucket.known_output_tokens += known;
            bucket.request_count += requests;
            bucket.unknown_output_requests += unknown;
            bucket.output_tokens = (bucket.unknown_output_requests == 0
                && bucket.request_count > 0)
                .then_some(bucket.known_output_tokens);
        }
    }
    Ok((global, by_tool))
}

pub fn read(
    conn: &Connection,
    now: i64,
    started: i64,
    updated: i64,
) -> Result<LiveSnapshot, String> {
    let mut spans: BTreeMap<String, Vec<(i64, i64)>> = BTreeMap::new();
    let mut query = conn
        .prepare("SELECT tool,start_ms,end_ms,open FROM monitor_live_coverage WHERE end_ms>?1")
        .map_err(|error| error.to_string())?;
    let coverage = query
        .query_map([now - 60 * MINUTE], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, bool>(3)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    for row in coverage {
        let (tool, start, mut end, open) = row.map_err(|error| error.to_string())?;
        if open && start >= started && end <= now && now - end <= GAP_MS {
            end = now;
        }
        spans.entry(tool).or_default().push((start, end.min(now)));
    }
    for value in spans.values_mut() {
        *value = merge_spans(std::mem::take(value));
    }
    let mut global = Counts::default();
    let mut by_tool: BTreeMap<String, Counts> = TOOLS
        .into_iter()
        .map(|tool| (tool.into(), Counts::default()))
        .collect();
    let mut by_model: BTreeMap<(String, Option<String>), Counts> = BTreeMap::new();
    let mut by_session: BTreeMap<(String, String), Counts> = BTreeMap::new();
    let mut minutes = [0i64; 60];
    let mut tool_minutes: BTreeMap<String, [i64; 60]> = TOOLS
        .into_iter()
        .map(|tool| (tool.into(), [0; 60]))
        .collect();
    let mut query=conn.prepare("SELECT o.tool,r.session_key,json_extract(r.usage,'$.model'),o.observed_ms,o.output_tokens FROM monitor_observations o JOIN monitor_requests r ON r.tool=o.tool AND r.id=o.id WHERE o.observed_ms>?1 AND o.observed_ms<=?2 AND COALESCE(json_extract(r.usage,'$.usageBasis'),'')!='legacy_initial_cumulative'").map_err(|error|error.to_string())?;
    let rows = query
        .query_map(params![now - 60 * MINUTE, now], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    for row in rows {
        let (tool, key, model, time, tokens) = row.map_err(|error| error.to_string())?;
        add(&mut global, time, tokens, now);
        add(by_tool.entry(tool.clone()).or_default(), time, tokens, now);
        add(
            by_model.entry((tool.clone(), model)).or_default(),
            time,
            tokens,
            now,
        );
        add(
            by_session.entry((tool.clone(), key)).or_default(),
            time,
            tokens,
            now,
        );
        let index = ((time - (now - 60 * MINUTE) - 1) / MINUTE) as usize;
        minutes[index] += tokens;
        tool_minutes.entry(tool).or_insert([0; 60])[index] += tokens;
    }
    let timeline = minute_buckets(minutes, &spans, now, None);
    let timeline_by_tool = tool_minutes
        .into_iter()
        .map(|(tool, minutes)| {
            let buckets = minute_buckets(minutes, &spans, now, Some(&tool));
            (tool, buckets)
        })
        .collect();
    let peak_minute_output_tokens = timeline
        .iter()
        .map(|bucket| bucket.observed_output_tokens)
        .max();
    let (recorded_timeline, recorded_timeline_by_tool) = recorded_timeline(conn, now)?;
    let tool_coverage: BTreeMap<_, _> = by_tool
        .keys()
        .map(|tool| (tool.clone(), windows(&Counts::default(), &spans, now, Some(tool))))
        .collect();
    Ok(LiveSnapshot {
        sampled_at_ms: now,
        collection_updated_at_ms: updated,
        basis: "collector_observed_output",
        windows: windows(&global, &spans, now, None),
        by_tool: by_tool
            .into_iter()
            .map(|(tool, counts)| LiveGroup {
                windows: counted_windows(&counts, &tool_coverage[&tool]),
                tool: Some(tool),
                model: None,
                session_key: None,
            })
            .collect(),
        by_model: by_model
            .into_iter()
            .map(|((tool, model), counts)| LiveGroup {
                windows: counted_windows(&counts, &tool_coverage[&tool]),
                tool: Some(tool),
                model,
                session_key: None,
            })
            .collect(),
        by_session: by_session
            .into_iter()
            .map(|((tool, key), counts)| LiveGroup {
                windows: counted_windows(&counts, &tool_coverage[&tool]),
                tool: Some(tool),
                model: None,
                session_key: Some(key),
            })
            .collect(),
        timeline,
        timeline_by_tool,
        recorded_timeline,
        recorded_timeline_by_tool,
        peak_minute_output_tokens,
        source_coverage_incomplete: false,
        unavailable_tools: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage_monitor::store;
    #[test]
    fn shared_coverage_keeps_each_groups_counts_and_unknown_windows() {
        let now = 400_000;
        for wildcard in [vec![(100_000, now)], vec![(100_000, 340_000), (360_000, now)]] {
            let spans = BTreeMap::from([
                ("*".into(), wildcard),
                ("codex".into(), vec![(100_000, now)]),
                ("claude".into(), vec![(100_000, 350_000)]),
            ]);
            for tool in [None, Some("codex"), Some("claude"), Some("unreported-tool")] {
                let coverage = windows(&Counts::default(), &spans, now, tool);
                for counts in [Counts::default(), Counts { short: 17, long: 123 }, Counts { short: 0, long: 9 }] {
                    assert_eq!(
                        serde_json::to_value(counted_windows(&counts, &coverage)).unwrap(),
                        serde_json::to_value(windows(&counts, &spans, now, tool)).unwrap()
                    );
                }
            }
        }
    }

    fn usage(
        conn: &mut Connection,
        id: &str,
        tool: &str,
        session: &str,
        model: Option<&str>,
        time: i64,
        tokens: i64,
    ) {
        let record = UsageRecord {
            id: id.into(),
            tool: tool.into(),
            session_id: session.into(),
            model: model.map(str::to_owned),
            timestamp_ms: time,
            output_tokens: tokens,
            ..Default::default()
        };
        let tx = conn.transaction().unwrap();
        store::save_usage_with_catalog(
            &tx,
            &record,
            0,
            time,
            &crate::model_catalog::CatalogSnapshot::default(),
        )
        .unwrap();
        tx.commit().unwrap();
    }
    #[test]
    fn recorded_timeline_uses_saved_times_not_receipt_and_preserves_unknowns() {
        let now = 7_200_000;
        let start = now - 60 * MINUTE;
        let mut records = Vec::new();
        for (id, tool, session, time, output) in [
            ("parent", "codex", "parent", start, 20),
            ("child", "codex", "child", start + 500, 30),
            ("zero", "claude", "claude", start + MINUTE, 0),
            ("known", "codex", "parent", start + 2 * MINUTE + 1, 7),
            ("unknown", "claude", "claude", start + 2 * MINUTE + 2, 300),
            ("missing", "claude", "claude", start + 3 * MINUTE + 1, 8),
            ("baseline", "codex", "parent", start + 4 * MINUTE, 50_000),
            ("recent", "codex", "parent", now - 10_000, 60),
            ("unplaceable", "codex", "parent", now - 20_000, 777),
            ("before", "codex", "parent", start - 1, 999),
            ("end", "codex", "parent", now, 999),
            ("future", "codex", "parent", now + 1, 999),
        ] {
            records.push(UsageRecord {
                id: id.into(),
                tool: tool.into(),
                session_id: session.into(),
                timestamp_ms: time,
                output_tokens: output,
                unknown_fields: match id {
                    "unknown" => vec!["output_tokens".into()],
                    "unplaceable" => vec!["timestamp".into()],
                    _ => vec![],
                },
                usage_basis: if id == "baseline" {
                    "legacy_initial_cumulative".into()
                } else {
                    "canonical".into()
                },
                ..Default::default()
            });
        }
        let mut connections = [
            (Connection::open_in_memory().unwrap(), 0),
            (Connection::open_in_memory().unwrap(), i64::MAX),
        ];
        for (conn, live_after) in &mut connections {
            store::initialize(conn).unwrap();
            let tx = conn.transaction().unwrap();
            let catalog = crate::model_catalog::CatalogSnapshot::default();
            for record in &records {
                let receipt = if *live_after == 0 {
                    record.timestamp_ms
                } else {
                    now
                };
                store::save_usage_with_catalog(&tx, record, *live_after, receipt, &catalog)
                    .unwrap();
            }
            // A repeated canonical row is an upsert, not another subagent/request contribution.
            store::save_usage_with_catalog(&tx, &records[1], *live_after, now, &catalog).unwrap();
            store::save_session(
                &tx,
                &SessionMeta {
                    tool: "codex".into(),
                    id: "child".into(),
                    parent_id: Some("parent".into()),
                    updated_at_ms: start + 500,
                    ..Default::default()
                },
            )
            .unwrap();
            tx.execute("UPDATE monitor_requests SET usage=json_remove(usage,'$.outputTokens') WHERE id='missing'", []).unwrap();
            tx.commit().unwrap();
        }
        let streamed = read(&connections[0].0, now, 0, now).unwrap();
        let backfilled = read(&connections[1].0, now, now, now).unwrap();
        assert_eq!(
            serde_json::to_value(&streamed.recorded_timeline).unwrap(),
            serde_json::to_value(&backfilled.recorded_timeline).unwrap()
        );
        assert_eq!(
            serde_json::to_value(&streamed.recorded_timeline_by_tool).unwrap(),
            serde_json::to_value(&backfilled.recorded_timeline_by_tool).unwrap()
        );
        assert!(streamed.windows[0].observed_output_tokens > 0);
        assert_eq!(backfilled.windows[0].observed_output_tokens, 0);
        let buckets = &backfilled.recorded_timeline;
        assert_eq!(buckets.len(), 60);
        assert_eq!((buckets[0].start_ms, buckets[59].end_ms), (start, now));
        assert_eq!(
            (buckets[0].output_tokens, buckets[0].request_count),
            (Some(50), 2)
        );
        assert_eq!(
            (buckets[1].output_tokens, buckets[1].request_count),
            (Some(0), 1)
        );
        assert_eq!(
            (
                buckets[2].output_tokens,
                buckets[2].known_output_tokens,
                buckets[2].unknown_output_requests
            ),
            (None, 7, 1)
        );
        assert_eq!(
            (
                buckets[3].output_tokens,
                buckets[3].known_output_tokens,
                buckets[3].unknown_output_requests
            ),
            (None, 0, 1)
        );
        assert_eq!(
            (buckets[4].output_tokens, buckets[4].request_count),
            (None, 0)
        );
        assert_eq!(
            (buckets[5].output_tokens, buckets[5].request_count),
            (None, 0)
        );
        assert_eq!(buckets[59].output_tokens, Some(60));
        assert_eq!(
            buckets
                .iter()
                .map(|bucket| bucket.known_output_tokens)
                .sum::<i64>(),
            117
        );
        assert_eq!(
            buckets
                .iter()
                .map(|bucket| bucket.request_count)
                .sum::<i64>(),
            7
        );
        assert_eq!(
            connections[1]
                .0
                .query_row(
                    "SELECT COUNT(*) FROM monitor_requests WHERE id='unplaceable'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            1
        );
        for (index, bucket) in buckets.iter().enumerate() {
            let groups = &backfilled.recorded_timeline_by_tool;
            assert_eq!(
                groups
                    .values()
                    .map(|rows| rows[index].known_output_tokens)
                    .sum::<i64>(),
                bucket.known_output_tokens
            );
            assert_eq!(
                groups
                    .values()
                    .map(|rows| rows[index].request_count)
                    .sum::<i64>(),
                bucket.request_count
            );
            assert_eq!(
                groups
                    .values()
                    .map(|rows| rows[index].unknown_output_requests)
                    .sum::<i64>(),
                bucket.unknown_output_requests
            );
        }
    }
    #[test]
    fn retained_initial_cumulative_observations_do_not_enter_live_or_session_rates() {
        let mut conn = Connection::open_in_memory().unwrap();
        store::initialize(&conn).unwrap();
        let now = 600_000;
        let baseline = UsageRecord {
            id: "baseline".into(),
            tool: "codex".into(),
            session_id: "same".into(),
            timestamp_ms: now - 20_000,
            output_tokens: 50_000,
            usage_basis: "legacy_initial_cumulative".into(),
            ..Default::default()
        };
        let tx = conn.transaction().unwrap();
        store::save_usage_with_catalog(
            &tx,
            &baseline,
            0,
            baseline.timestamp_ms,
            &crate::model_catalog::CatalogSnapshot::default(),
        )
        .unwrap();
        tx.commit().unwrap();
        // Simulate an observation retained from a version before the write-side exclusion.
        conn.execute("INSERT INTO monitor_observations SELECT tool,id,session_key,timestamp_ms,50000 FROM monitor_requests WHERE id='baseline'", []).unwrap();
        usage(&mut conn, "valid", "codex", "same", None, now - 10_000, 60);
        let snapshot = read(&conn, now, 0, now).unwrap();
        for window in &snapshot.windows {
            assert_eq!(window.observed_output_tokens, 60);
        }
        assert_eq!(
            snapshot
                .timeline
                .iter()
                .map(|bucket| bucket.observed_output_tokens)
                .sum::<i64>(),
            60
        );
        let sessions = store::sessions(&conn, None, now).unwrap();
        assert_eq!(sessions[0].totals.output_tokens_per_second, 1.0);
        assert_eq!(sessions[0].totals.output_tokens, 50_060);
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM monitor_observations", [], |row| row
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            2
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM monitor_requests", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            2
        );
    }
    #[test]
    fn failed_tool_health_is_not_filled_by_other_collectors_or_the_program_clock() {
        let mut conn = Connection::open_in_memory().unwrap();
        store::initialize(&conn).unwrap();
        let now = 600_000;
        for (source, tool, end) in [
            ("language_server", "*", now),
            ("language_server", "antigravity", now),
            ("jsonl", "claude", now),
            ("jsonl", "codex", now - 30_000),
        ] {
            conn.execute(
                "INSERT INTO monitor_live_coverage VALUES(?1,?2,0,?3,0)",
                params![source, tool, end],
            )
            .unwrap();
        }
        usage(&mut conn, "a", "codex", "a", Some("m"), now - 10_000, 10);
        usage(&mut conn, "b", "claude", "b", Some("m"), now - 20_000, 20);
        let snapshot = read(&conn, now, 0, now).unwrap();
        assert_eq!(snapshot.windows[0].output_tokens_per_second, Some(0.5));
        assert!(snapshot.windows[0].complete);
        assert!(!snapshot.windows[0].source_complete);
        let codex = &snapshot
            .by_tool
            .iter()
            .find(|group| group.tool.as_deref() == Some("codex"))
            .unwrap()
            .windows[0];
        assert_eq!(codex.covered_ms, 30_000);
        assert_eq!(codex.output_tokens_per_second, None);
        assert_eq!(codex.observed_output_tokens, 10);
        let claude = &snapshot
            .by_tool
            .iter()
            .find(|group| group.tool.as_deref() == Some("claude"))
            .unwrap()
            .windows[0];
        assert!(claude.complete && claude.source_complete);
        assert_eq!(claude.output_tokens_per_second, Some(20. / 60.));
        assert_eq!(snapshot.timeline.last().unwrap().output_tokens, None);
        assert_eq!(snapshot.timeline.last().unwrap().observed_output_tokens, 30);
        assert_eq!(
            snapshot.timeline_by_tool["codex"]
                .last()
                .unwrap()
                .output_tokens,
            None
        );
        assert_eq!(
            snapshot.timeline_by_tool["claude"]
                .last()
                .unwrap()
                .output_tokens,
            Some(20)
        );
        assert_eq!(
            snapshot
                .by_tool
                .iter()
                .map(|group| group.windows[0].observed_output_tokens)
                .sum::<i64>(),
            snapshot.windows[0].observed_output_tokens
        );
    }
    #[test]
    fn per_tool_timeline_and_full_session_status_counts_conserve() {
        let mut conn = Connection::open_in_memory().unwrap();
        store::initialize(&conn).unwrap();
        let now = 3_600_000;
        conn.execute(
            "INSERT INTO monitor_live_coverage VALUES('collector','*',0,?1,0)",
            [now],
        )
        .unwrap();
        for tool in TOOLS {
            conn.execute(
                "INSERT INTO monitor_live_coverage VALUES('collector',?1,0,?2,0)",
                params![tool, now],
            )
            .unwrap();
        }
        let tx = conn.transaction().unwrap();
        for (tool, id, status, updated) in [
            ("codex", "running", "active", now),
            ("codex", "idle", "completed", now - 2_000_000),
            ("claude", "recent", "recent", now - 1000),
            ("claude", "stale", "running", now - 200_000),
            ("antigravity", "unknown", "unknown", now - 2_100_000),
        ] {
            store::save_session(
                &tx,
                &SessionMeta {
                    tool: tool.into(),
                    id: id.into(),
                    status: status.into(),
                    updated_at_ms: updated,
                    ..Default::default()
                },
            )
            .unwrap();
        }
        tx.commit().unwrap();
        usage(
            &mut conn,
            "a",
            "codex",
            "running",
            Some("m"),
            now - 10_000,
            10,
        );
        usage(
            &mut conn,
            "b",
            "claude",
            "recent",
            Some("m"),
            now - 20_000,
            20,
        );
        usage(
            &mut conn,
            "c",
            "antigravity",
            "unknown",
            None,
            now - 200_000,
            30,
        );
        let snapshot = read(&conn, now, 0, now).unwrap();
        assert_eq!(snapshot.timeline_by_tool.len(), TOOLS.len());
        for (index, global) in snapshot.timeline.iter().enumerate() {
            assert_eq!(
                snapshot
                    .timeline_by_tool
                    .values()
                    .map(|timeline| timeline[index].observed_output_tokens)
                    .sum::<i64>(),
                global.observed_output_tokens
            );
            assert!(snapshot
                .timeline_by_tool
                .values()
                .all(|timeline| timeline.len() == 60
                    && timeline[index].start_ms == global.start_ms
                    && timeline[index].covered_ms == global.covered_ms));
        }
        assert_eq!(
            snapshot.timeline_by_tool["codex"]
                .iter()
                .map(|bucket| bucket.observed_output_tokens)
                .sum::<i64>(),
            10
        );
        let sessions = store::sessions(&conn, None, now).unwrap();
        let (counts, tools) = crate::usage_monitor::status_counts(&sessions, now);
        assert_eq!(
            (
                counts.running,
                counts.recent,
                counts.stale,
                counts.idle,
                counts.unknown,
                counts.active_last30m
            ),
            (1, 1, 1, 1, 1, 3)
        );
        assert_eq!(
            tools
                .values()
                .map(|counts| counts.running
                    + counts.recent
                    + counts.stale
                    + counts.idle
                    + counts.unknown)
                .sum::<i64>(),
            sessions.len() as i64
        );
        assert_eq!(
            tools
                .values()
                .map(|counts| counts.active_last30m)
                .sum::<i64>(),
            counts.active_last30m
        );
        let rates = crate::usage_monitor::rate_sessions_for_live(&sessions, &snapshot);
        assert!(rates
            .iter()
            .any(|session| session.key == "antigravity:unknown"));
        assert_eq!(
            rates
                .iter()
                .map(|session| &session.key)
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            rates.len()
        );
    }
    #[test]
    fn live_windows_conserve_request_models_tools_sessions_and_unknown_model() {
        let mut conn = Connection::open_in_memory().unwrap();
        store::initialize(&conn).unwrap();
        let now = 3_600_000;
        conn.execute(
            "INSERT INTO monitor_live_coverage VALUES('collector','*',0,?1,0)",
            [now],
        )
        .unwrap();
        for tool in TOOLS {
            conn.execute(
                "INSERT INTO monitor_live_coverage VALUES('collector',?1,0,?2,0)",
                params![tool, now],
            )
            .unwrap();
        }
        usage(
            &mut conn,
            "a",
            "codex",
            "same",
            Some("before"),
            now - 10_000,
            10,
        );
        usage(
            &mut conn,
            "b",
            "codex",
            "same",
            Some("after"),
            now - 30_000,
            20,
        );
        usage(&mut conn, "c", "claude", "other", None, now - 20_000, 30);
        usage(
            &mut conn,
            "d",
            "codex",
            "same",
            Some("before"),
            now - 200_000,
            50,
        );
        usage(
            &mut conn,
            "old-live",
            "codex",
            "same",
            Some("before"),
            now - 3_000_000,
            100,
        );
        let tx = conn.transaction().unwrap();
        store::save_session(
            &tx,
            &SessionMeta {
                tool: "codex".into(),
                id: "same".into(),
                model: Some("last-session-model-is-not-a-group".into()),
                updated_at_ms: now,
                ..Default::default()
            },
        )
        .unwrap();
        tx.commit().unwrap();
        let snapshot = read(&conn, now, 0, now).unwrap();
        for (index, total) in [(0, 60), (1, 110)] {
            assert_eq!(snapshot.windows[index].observed_output_tokens, total);
            assert!(snapshot.windows[index].complete);
            for groups in [&snapshot.by_tool, &snapshot.by_model, &snapshot.by_session] {
                assert_eq!(
                    groups
                        .iter()
                        .map(|group| group.windows[index].observed_output_tokens)
                        .sum::<i64>(),
                    total
                );
                assert!(
                    (groups
                        .iter()
                        .map(|group| group.windows[index].output_tokens_per_second.unwrap())
                        .sum::<f64>()
                        - snapshot.windows[index].output_tokens_per_second.unwrap())
                    .abs()
                        < 1e-12
                );
            }
        }
        assert!(snapshot
            .by_model
            .iter()
            .any(|group| group.tool.as_deref() == Some("claude") && group.model.is_none()));
        assert!(!snapshot
            .by_model
            .iter()
            .any(|group| group.model.as_deref() == Some("last-session-model-is-not-a-group")));
        assert_eq!(snapshot.timeline.len(), 60);
        assert_eq!(
            snapshot
                .timeline
                .iter()
                .map(|bucket| bucket.observed_output_tokens)
                .sum::<i64>(),
            210
        );
        assert_eq!(snapshot.peak_minute_output_tokens, Some(100));
    }
    #[test]
    fn coverage_restart_gap_is_not_zero_and_hour_retention_does_not_erase_accounting() {
        let mut conn = Connection::open_in_memory().unwrap();
        store::initialize(&conn).unwrap();
        let mut first = CoverageWriter::new("jsonl");
        first.observe(&conn, "*", 1000, true).unwrap();
        first.observe(&conn, "*", 3000, true).unwrap();
        let mut second = CoverageWriter::new("jsonl");
        for time in (150_000..=160_000).step_by(2000) {
            second.observe(&conn, "*", time, true).unwrap();
        }
        let snapshot = read(&conn, 160_000, 150_000, 160_000).unwrap();
        assert_eq!(snapshot.windows[0].covered_ms, 10_000);
        assert_eq!(snapshot.windows[1].covered_ms, 12_000);
        assert!(snapshot
            .windows
            .iter()
            .all(|window| window.output_tokens_per_second.is_none()));
        assert!(snapshot
            .timeline
            .iter()
            .all(|bucket| bucket.output_tokens.is_none()));
        let now = 7_200_000;
        usage(
            &mut conn,
            "expired",
            "codex",
            "s",
            Some("m"),
            now - 3_800_000,
            1,
        );
        usage(
            &mut conn,
            "hour",
            "codex",
            "s",
            Some("m"),
            now - 3_500_000,
            2,
        );
        usage(&mut conn, "five", "codex", "s", Some("m"), now - 200_000, 3);
        prune(&conn, now).unwrap();
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM monitor_observations", [], |row| row
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            2
        );
        assert_eq!(
            conn.query_row("SELECT COUNT(*) FROM monitor_requests", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            3
        );
        assert_eq!(
            read(&conn, now, now, now).unwrap().windows[1].observed_output_tokens,
            3
        );
    }
}
