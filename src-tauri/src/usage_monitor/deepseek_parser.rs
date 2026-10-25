//! Read-only projection of official DeepSeek Harness v2–v4 session artifacts.
//! Contract: deepseek-ai/deepseek-harness @ 22ddee3792402c3e70ec5f86a63c3e3e895a2f60.
//! Retains accounting metadata only, never prompts, messages, credentials or tool output.
use super::types::{SessionMeta, UsageRecord};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    io::{BufRead, Read},
};

const MAX_LINE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

fn text(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)?
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn count(value: &Value, field: &str) -> Result<Option<i64>, String> {
    match value.get(field) {
        None => Ok(None),
        Some(n) => n
            .as_i64()
            .filter(|n| (0..=MAX_SAFE_INTEGER).contains(n))
            .map(Some)
            .ok_or_else(|| format!("DeepSeek Harness invalid {field}")),
    }
}

fn required(value: &Value, field: &str) -> Result<i64, String> {
    count(value, field)?.ok_or_else(|| format!("DeepSeek Harness missing {field}"))
}

fn sum(a: i64, b: i64) -> Result<i64, String> {
    a.checked_add(b)
        .filter(|n| *n <= MAX_SAFE_INTEGER)
        .ok_or_else(|| "DeepSeek Harness token count overflow".into())
}

/// The caller supplies plain JSONL, or a bounded Zstandard-decoded stream.
/// A torn tail refuses the whole snapshot, preserving the previously committed ledger.
pub fn parse_lines<R: BufRead>(reader: R) -> Result<(SessionMeta, Vec<UsageRecord>), String> {
    parse_artifact(reader, None)
}

pub fn parse_artifact<R: BufRead>(mut reader: R, expected_version: Option<u64>) -> Result<(SessionMeta, Vec<UsageRecord>), String> {
    let mut session: Option<SessionMeta> = None;
    let mut seeded = false;
    let mut saw_seed = false;
    let mut next_seq = 0;
    let mut model = None;
    let mut provider = None;
    let mut retry_seq = BTreeMap::new();
    let mut usage = BTreeMap::new();
    loop {
        let mut line = Vec::new();
        let bytes = reader
            .by_ref()
            .take(MAX_LINE_BYTES + 1)
            .read_until(b'\n', &mut line)
            .map_err(|e| format!("DeepSeek Harness read: {e}"))?;
        if bytes == 0 {
            break;
        }
        if bytes as u64 > MAX_LINE_BYTES {
            return Err("DeepSeek Harness JSONL record exceeds 32 MiB".into());
        }
        if line.last() != Some(&b'\n') {
            return Err("DeepSeek Harness incomplete final record; retry after append".into());
        }
        let value: Value =
            serde_json::from_slice(&line).map_err(|e| format!("DeepSeek Harness JSONL: {e}"))?;
        let kind = value
            .get("type")
            .and_then(Value::as_str)
            .ok_or("DeepSeek Harness missing record type")?;
        if session.is_none() {
            if kind != "session" {
                return Err("DeepSeek Harness missing session header".into());
            }
            let version = required(&value, "version")?;
            if expected_version.is_some_and(|expected| expected != version as u64) {
                return Err("DeepSeek Harness filename/header format version mismatch".into());
            }
            if !(2..=4).contains(&version) {
                return Err(format!(
                    "Unsupported DeepSeek Harness session format v{version}; supported: v2–v4"
                ));
            }
            seeded = value
                .get("isSeeded")
                .and_then(Value::as_bool)
                .ok_or("DeepSeek Harness missing isSeeded")?;
            let created = required(&value, "createdAt")?;
            session = Some(SessionMeta {
                tool: "deepseek-harness".into(),
                id: text(&value, "id").ok_or("DeepSeek Harness missing session id")?,
                parent_id: text(&value, "parentSession"),
                project: text(&value, "cwd"),
                started_at_ms: created,
                updated_at_ms: created,
                status: "observed".into(),
                ..Default::default()
            });
            continue;
        }
        let seq = required(&value, "seq")?;
        if seq != next_seq {
            return Err(format!(
                "DeepSeek Harness event sequence gap: expected {next_seq}, got {seq}"
            ));
        }
        next_seq += 1;
        let time = required(&value, "time")?;
        let data = value
            .get("data")
            .ok_or("DeepSeek Harness missing event data")?;
        let current = session.as_mut().unwrap();
        current.updated_at_ms = current.updated_at_ms.max(time);
        if kind == "session/end-seed"
            && data.get("inherited").and_then(Value::as_bool) == Some(true)
        {
            if !seeded {
                return Err("DeepSeek Harness unseeded session has inherited marker".into());
            }
            // Ancestor markers may appear in the inherited prefix: the LAST marker wins.
            usage.clear();
            retry_seq.clear();
            saw_seed = true;
            continue;
        }
        if kind == "request/header" {
            let config = &data["header"]["config"];
            model = text(config, "model");
            provider = text(config, "provider");
        } else if kind == "request/context" {
            model = text(data, "model");
            provider = text(data, "provider");
        } else if kind == "llm/retry-started" {
            retry_seq.insert((required(data, "turn")?, required(data, "step")?), seq);
        }
        if kind != "assistant/message" && kind != "assistant/attempt" {
            continue;
        }
        let sample = if kind == "assistant/message" {
            data.get("usage")
        } else {
            None
        }
        .or_else(|| {
            data.get("stream")?
                .as_array()?
                .iter()
                .rev()
                .find_map(|record| {
                    (record.get("type")?.as_str()? == "chunk" && record["chunk"]["type"] == "usage")
                        .then(|| record["chunk"].get("usage"))
                        .flatten()
                })
        });
        let Some(sample) = sample else {
            continue;
        };
        let turn = required(data, "turn")?;
        let step = required(data, "step")?;
        let attempt = *retry_seq.get(&(turn, step)).unwrap_or(&-1);
        let uncached = required(sample, "inputTokens")?;
        let output = required(sample, "outputTokens")?;
        let read = count(sample, "cacheReadTokens")?;
        let write = count(sample, "cacheWriteTokens")?;
        let reasoning = count(sample, "reasoningTokens")?;
        if reasoning.is_some_and(|n| n > output) {
            return Err("DeepSeek Harness reasoning exceeds output".into());
        }
        let known_prompt = sum(sum(uncached, read.unwrap_or(0))?, write.unwrap_or(0))?;
        let total = count(sample, "totalTokens")?;
        let prompt = match total {
            Some(total) => {
                let prompt = total
                    .checked_sub(output)
                    .filter(|n| *n >= known_prompt)
                    .ok_or("DeepSeek Harness inconsistent totalTokens")?;
                if read.is_some() && write.is_some() && prompt != known_prompt {
                    return Err("DeepSeek Harness inconsistent disjoint token buckets".into());
                }
                prompt
            }
            None => known_prompt,
        };
        let mut unknown_fields = Vec::new();
        if read.is_none() {
            unknown_fields.push("cache_read_tokens".into());
        }
        if write.is_none() {
            unknown_fields.push("cache_write_tokens".into());
        }
        if total.is_none() && (read.is_none() || write.is_none()) {
            unknown_fields.push("input_tokens".into());
        }
        let source = &data["message"]["source"];
        let actual_model = text(source, "model");
        let actual_provider = text(source, "provider");
        let record = UsageRecord {
            id: format!("dsh:{}:{turn}:{step}:{attempt}", current.id),
            tool: "deepseek-harness".into(),
            session_id: current.id.clone(),
            turn_id: turn.to_string(),
            timestamp_ms: time,
            model: actual_model.clone().or_else(|| model.clone()),
            requested_model: model.clone(),
            provider: actual_provider.clone().or_else(|| provider.clone()),
            model_basis: if actual_model.is_some() {
                "response_model"
            } else if model.is_some() {
                "turn_context_requested"
            } else {
                "unknown"
            }
            .into(),
            provider_basis: if actual_provider.is_some() {
                "response_source"
            } else if provider.is_some() {
                "request_header"
            } else {
                "unknown"
            }
            .into(),
            mode_basis: "unknown".into(),
            input_tokens: prompt,
            source_input_tokens: Some(uncached),
            output_tokens: output,
            cache_read_tokens: read.unwrap_or(0),
            cache_write_tokens: write.unwrap_or(0),
            reasoning_tokens: reasoning,
            usage_basis: "provider_reported".into(),
            unknown_fields,
            ..Default::default()
        };
        current.model = record.model.clone();
        // Settlement samples replace within an attempt, not add (official token-meter fold).
        usage.insert((turn, step, attempt), record);
    }
    let session = session.ok_or("DeepSeek Harness missing complete session header")?;
    if seeded && !saw_seed {
        return Err("DeepSeek Harness seeded session lacks inherited boundary".into());
    }
    Ok((session, usage.into_values().collect()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn parse(seeded: bool, events: Vec<Value>) -> Result<(SessionMeta, Vec<UsageRecord>), String> {
        let mut rows = vec![
            json!({"type":"session","version":4,"id":"test","createdAt":1000,"isSeeded":seeded,"delegationDepth":0}),
        ];
        for (seq, mut event) in events.into_iter().enumerate() {
            event["seq"] = json!(seq);
            event["time"] = json!(2000 + seq);
            rows.push(event);
        }
        let log = rows.iter().map(|v| format!("{v}\n")).collect::<String>();
        parse_lines(log.as_bytes())
    }
    fn sample(input: i64, output: i64) -> Value {
        json!({"type":"assistant/message","data":{"turn":1,"step":1,"usage":{"inputTokens":input,"outputTokens":output,"cacheReadTokens":7,"cacheWriteTokens":2,"reasoningTokens":1},"message":{"source":{"kind":"model","provider":"deepseek-official","model":"deepseek-v4-flash"}}}})
    }
    #[test]
    fn disjoint_tokens_and_final_sample_replacement() {
        let (_, rows) = parse(false, vec![sample(10, 2), sample(14, 5)]).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].input_tokens, 23);
        assert_eq!(rows[0].source_input_tokens, Some(14));
        assert_eq!(rows[0].output_tokens, 5);
        assert_eq!(rows[0].reasoning_tokens, Some(1));
        assert_eq!(rows[0].model_basis, "response_model");
    }
    #[test]
    fn retry_is_an_additional_attempt() {
        let (_, rows) = parse(
            false,
            vec![
                sample(10, 2),
                json!({"type":"llm/retry-started","data":{"turn":1,"step":1,"retry":1}}),
                sample(14, 5),
            ],
        )
        .unwrap();
        assert_eq!(rows.len(), 2);
        assert_ne!(rows[0].id, rows[1].id);
        assert_eq!(rows.iter().map(|r| r.output_tokens).sum::<i64>(), 7);
    }
    #[test]
    fn last_inherited_marker_discards_ancestor_and_parent_usage() {
        let boundary = json!({"type":"session/end-seed","data":{"inherited":true}});
        let (_, rows) = parse(
            true,
            vec![
                sample(999, 2),
                boundary.clone(),
                sample(888, 3),
                boundary,
                sample(14, 5),
            ],
        )
        .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].source_input_tokens, Some(14));
        assert!(parse(true, vec![sample(14, 5)]).is_err());
    }
    #[test]
    fn attempts_use_last_stream_usage_and_preserve_unknown_buckets() {
        let attempt = json!({"type":"assistant/attempt","data":{"turn":2,"step":1,"stream":[{"type":"chunk","chunk":{"type":"usage","usage":{"inputTokens":1,"outputTokens":2}}},{"type":"chunk","chunk":{"type":"usage","usage":{"inputTokens":10,"outputTokens":3,"cacheReadTokens":20,"totalTokens":33}}}]}});
        let (_, rows) = parse(false, vec![attempt]).unwrap();
        assert_eq!(rows[0].input_tokens, 30);
        assert_eq!(rows[0].output_tokens, 3);
        assert_eq!(rows[0].unknown_fields, vec!["cache_write_tokens"]);
    }
    #[test]
    fn invalid_accounting_is_rejected_not_coerced() {
        let mut bad = sample(10, 2);
        bad["data"]["usage"]["totalTokens"] = json!(12);
        assert!(parse(false, vec![bad]).is_err());
        let mut bad = sample(10, 2);
        bad["data"]["usage"]["inputTokens"] = json!(-1);
        assert!(parse(false, vec![bad]).is_err());
    }
    #[test]
    fn future_format_and_sequence_gaps_are_rejected() {
        assert!(parse_lines(b"{\"type\":\"session\",\"version\":5}\n".as_slice()).is_err());
        let log = b"{\"type\":\"session\",\"version\":4,\"id\":\"s\",\"createdAt\":0,\"isSeeded\":false}\n{\"type\":\"turn/start\",\"seq\":1,\"time\":2,\"data\":{}}\n";
        assert!(parse_lines(log.as_slice()).is_err());
    }
    #[test]
    fn incomplete_tail_is_not_committed() {
        let log = b"{\"type\":\"session\",\"version\":4,\"id\":\"s\",\"createdAt\":0,\"isSeeded\":false}\n{\"type\":\"assistant/message\"";
        assert!(parse_lines(log.as_slice()).is_err());
    }
    #[test]
    fn released_v2_v3_headers_share_supported_framing() {
        for version in [2, 3, 4] {
            let header =
                json!({"type":"session","version":version,"id":"s","createdAt":0,"isSeeded":false});
            assert!(parse_lines(format!("{header}\n").as_bytes()).is_ok());
        }
        for version in [0, 1, 5] {
            let header = json!({"type":"session","version":version});
            assert!(parse_lines(format!("{header}\n").as_bytes()).is_err());
        }
    }
    #[test]
    fn missing_cache_without_exact_total_marks_prompt_unknown() {
        let mut event = sample(10, 2);
        event["data"]["usage"]
            .as_object_mut()
            .unwrap()
            .remove("cacheReadTokens");
        let (_, rows) = parse(false, vec![event]).unwrap();
        assert!(rows[0].unknown_fields.contains(&"input_tokens".into()));
        assert_eq!(rows[0].source_input_tokens, Some(10));
    }
}
