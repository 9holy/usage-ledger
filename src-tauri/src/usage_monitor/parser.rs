use super::types::{RequestTiming, SessionMeta, TurnTiming, UsageRecord};
use chrono::DateTime;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::VecDeque, path::Path};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ParserState {
    pub session: Option<SessionMeta>,
    pub(crate) quota_account_id: Option<String>,
    pub(crate) quota_identity_loaded: bool,
    pub(crate) quota_identity_error: Option<String>,
    turn_id: String,
    root_turn_id: Option<String>,
    requested_model: Option<String>,
    requested_mode: Option<String>,
    requested_mode_turn_id: Option<String>,
    requested_mode_ambiguous: bool,
    rerouted_model: Option<String>,
    fork: bool,
    own_activity: bool,
    sequence: u64,
    last_total: Option<Tokens>,
    canonical_total: Option<Tokens>,
    pending_usage: Option<UsageOccurrence>,
    recent: VecDeque<UsageRecord>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct UsageOccurrence {
    id: String,
    turn_id: String,
    tokens: Tokens,
    total: Option<Tokens>,
    canonical: bool,
    paired: bool,
}

#[derive(Default, Debug)]
pub struct ParsedLine {
    pub session: Option<SessionMeta>,
    pub usage: Vec<UsageRecord>,
    pub delete_ids: Vec<String>,
    pub quotas: Vec<super::quota::QuotaObservation>,
}

impl ParserState {
    fn remember(&mut self, record: UsageRecord) {
        self.recent.retain(|r| r.id != record.id);
        self.recent.push_back(record);
        // Only partial-chunk association lives here; durable identity/upserts belong to SQLite.
        if self.recent.len() > 8 {
            self.recent.pop_front();
        }
    }

    fn previous(&self, id: &str) -> Option<&UsageRecord> {
        self.recent.iter().find(|r| r.id == id)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
struct Tokens {
    input: Option<i64>,
    output: Option<i64>,
    read: Option<i64>,
    write: Option<i64>,
    reasoning: Option<i64>,
}

fn string(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn number(v: &Value, key: &str) -> Result<Option<i64>, String> {
    match v.get(key).filter(|v| !v.is_null()) {
        None => Ok(None),
        Some(v) => v
            .as_i64()
            .filter(|n| *n >= 0)
            .map(Some)
            .ok_or_else(|| format!("invalid nonnegative integer: {key}")),
    }
}

fn timestamp(v: &Value) -> Option<i64> {
    v.as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp_millis())
        .or_else(|| {
            v.as_i64().and_then(|n| {
                if n >= 1_000_000_000_000 {
                    Some(n)
                } else {
                    n.checked_mul(1000)
                }
            })
        })
}

fn mode(value: Option<String>) -> Option<String> {
    value.map(|v| match v.as_str() {
        "default" | "normal" => "standard".into(),
        "priority" => "fast".into(),
        _ => v,
    })
}

impl Tokens {
    fn same_endpoint(&self, other: &Self) -> bool {
        self.input.is_some()
            && self.output.is_some()
            && self.input == other.input
            && self.output == other.output
    }

    fn same_usage(&self, other: &Self) -> bool {
        self.same_endpoint(other)
            && [
                (self.read, other.read),
                (self.write, other.write),
                (self.reasoning, other.reasoning),
            ]
            .into_iter()
            .all(|(a, b)| a.zip(b).is_none_or(|(a, b)| a == b))
    }

    fn codex(v: &Value) -> Result<Self, String> {
        let read = number(v, "cached_input_tokens")?
            .or(number(&v["input_tokens_details"], "cached_tokens")?);
        Ok(Self {
            input: number(v, "input_tokens")?,
            output: number(v, "output_tokens")?,
            read,
            write: number(v, "cache_write_input_tokens")?,
            reasoning: number(v, "reasoning_output_tokens")?
                .or(number(&v["output_tokens_details"], "reasoning_tokens")?),
        })
    }

    fn delta(&self, previous: &Self) -> Option<Self> {
        fn sub(a: Option<i64>, b: Option<i64>) -> Option<Option<i64>> {
            match (a, b) {
                (Some(a), Some(b)) => a.checked_sub(b).filter(|n| *n >= 0).map(Some),
                _ => Some(None),
            }
        }
        Some(Self {
            input: sub(self.input, previous.input)?,
            output: sub(self.output, previous.output)?,
            read: sub(self.read, previous.read)?,
            write: sub(self.write, previous.write)?,
            reasoning: sub(self.reasoning, previous.reasoning)?,
        })
    }

    fn apply(&self, record: &mut UsageRecord) -> Result<(), String> {
        record.input_tokens = self.input.unwrap_or(0);
        record.source_input_tokens = self.input;
        record.output_tokens = self.output.unwrap_or(self.reasoning.unwrap_or(0));
        record.cache_read_tokens = self.read.unwrap_or(0);
        record.cache_write_tokens = self.write.unwrap_or(0);
        record.reasoning_tokens = self.reasoning;
        record.context_tokens = self.input;
        for (name, value) in [
            ("input_tokens", self.input),
            ("output_tokens", self.output),
            ("cache_read_tokens", self.read),
            ("cache_write_tokens", self.write),
        ] {
            if value.is_none() {
                record.unknown_fields.push(name.into());
            }
        }
        let cached = record
            .cache_read_tokens
            .checked_add(record.cache_write_tokens)
            .ok_or("token count overflow")?;
        if self.input.is_none() {
            record.input_tokens = cached;
        }
        if self.input.is_some() && cached > record.input_tokens {
            return Err("cache tokens exceed normalized input tokens".into());
        }
        if self
            .reasoning
            .is_some_and(|n| self.output.is_some_and(|o| n > o))
        {
            return Err("reasoning tokens exceed output tokens".into());
        }
        Ok(())
    }

    fn fill_missing(&mut self, record: &UsageRecord) {
        let known = |field: &str| !record.unknown_fields.iter().any(|s| s == field);
        self.input = self
            .input
            .or_else(|| known("input_tokens").then_some(record.input_tokens));
        self.output = self
            .output
            .or_else(|| known("output_tokens").then_some(record.output_tokens));
        self.read = self
            .read
            .or_else(|| known("cache_read_tokens").then_some(record.cache_read_tokens));
        self.write = self
            .write
            .or_else(|| known("cache_write_tokens").then_some(record.cache_write_tokens));
        self.reasoning = self.reasoning.or(record.reasoning_tokens);
    }
}

fn fallback_id(path: &Path) -> String {
    path.file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

fn session(state: &mut ParserState, tool: &str, id: String, time: i64) {
    if state.session.is_none() {
        state.session = Some(SessionMeta {
            tool: tool.into(),
            id,
            status: "unknown".into(),
            started_at_ms: time,
            updated_at_ms: time,
            ..Default::default()
        });
    }
}

fn set_turn(state: &mut ParserState, id: String) {
    if state.turn_id != id {
        state.turn_id = id;
        state.root_turn_id = None;
        state.rerouted_model = None;
        state.pending_usage = None;
        if let Some(session) = &mut state.session {
            session.turn_timing = None;
        }
    }
}

fn set_requested_mode(state: &mut ParserState, value: Option<String>, turn_context: bool) {
    let next = mode(value);
    if state.requested_mode != next
        && !state.turn_id.is_empty()
        && (!turn_context || state.recent.iter().any(|row| row.turn_id == state.turn_id))
    {
        // A settings event has no response ID; an outstanding request may use the old value.
        state.requested_mode_ambiguous = true;
        state
            .requested_mode_turn_id
            .get_or_insert_with(|| state.turn_id.clone());
    }
    state.requested_mode = next;
}

fn record(state: &ParserState, tool: &str, id: String, time: i64, time_known: bool) -> UsageRecord {
    let ambiguous = state.requested_mode_ambiguous
        || state
            .requested_mode_turn_id
            .as_ref()
            .is_some_and(|turn| turn != &state.turn_id);
    let mut unknown_fields = if time_known {
        vec![]
    } else {
        vec!["timestamp".into()]
    };
    if ambiguous {
        unknown_fields.push("requested_mode_ambiguous".into());
    }
    UsageRecord {
        id,
        tool: tool.into(),
        session_id: state.session.as_ref().unwrap().id.clone(),
        turn_id: state.turn_id.clone(),
        root_turn_id: state.root_turn_id.clone(),
        timestamp_ms: time,
        model: state
            .rerouted_model
            .clone()
            .or(state.requested_model.clone()),
        requested_model: state.requested_model.clone(),
        model_basis: if state.rerouted_model.is_some() {
            "model_reroute"
        } else if state.requested_model.is_some() {
            "turn_context_requested"
        } else {
            "unknown"
        }
        .into(),
        requested_mode: (!ambiguous).then(|| state.requested_mode.clone()).flatten(),
        mode_basis: "unknown".into(),
        unknown_fields,
        ..Default::default()
    }
}

fn response_evidence(record: &mut UsageRecord, value: &Value) {
    if let Some(model) = string(value, "response_model").or_else(|| string(value, "model")) {
        record.model = Some(model);
        record.model_basis = "response_model".into();
    }
    if let Some(tier) = mode(string(value, "service_tier").or_else(|| string(value, "speed"))) {
        record.mode = Some(tier);
        record.mode_basis = "response_reported".into();
    }
    if let Some(geo) = string(value, "inference_geo").filter(|s| s != "global") {
        record
            .unknown_fields
            .push(format!("unsupported_pricing_modifier:inference_geo={geo}"));
    }
}

fn provisional_id(state: &ParserState, total: &Tokens) -> Option<String> {
    // This is a native thread/turn cumulative endpoint, not equality of request token values.
    Some(format!(
        "legacy:{}:{}:{}:{}",
        state.session.as_ref().unwrap().id,
        state.turn_id,
        total.input?,
        total.output?
    ))
}

fn codex(
    state: &mut ParserState,
    path: &Path,
    row: &Value,
    time: i64,
    known: bool,
) -> Result<ParsedLine, String> {
    let kind = row["type"].as_str().unwrap_or("");
    let payload = row.get("payload").unwrap_or(row);
    let event = if kind == "event_msg" {
        payload["type"].as_str().unwrap_or("")
    } else {
        kind
    };
    let mut result = ParsedLine::default();
    if event == "session_meta" {
        let id = string(payload, "id")
            .or_else(|| string(payload, "thread_id"))
            .unwrap_or_else(|| fallback_id(path));
        let parent = string(payload, "parent_thread_id")
            .or_else(|| {
                string(
                    &payload["source"]["subagent"]["thread_spawn"],
                    "parent_thread_id",
                )
            })
            .or_else(|| string(payload, "forked_from_id"));
        state.fork = string(payload, "forked_from_id").is_some();
        state.own_activity = !state.fork;
        state.quota_account_id = string(payload, "creator_account_id");
        state.quota_identity_loaded = true;
        state.quota_identity_error = None;
        state.requested_mode = None;
        state.requested_mode_turn_id = None;
        state.requested_mode_ambiguous = false;
        state.session = Some(SessionMeta {
            tool: "codex".into(),
            id,
            parent_id: parent,
            root_id: string(payload, "session_id"),
            project: string(payload, "cwd"),
            model: None,
            status: "unknown".into(),
            started_at_ms: timestamp(&payload["timestamp"]).unwrap_or(time),
            updated_at_ms: time,
            turn_timing: None,
        });
        return Ok(result);
    }
    session(
        state,
        "codex",
        string(payload, "thread_id").unwrap_or_else(|| fallback_id(path)),
        time,
    );
    let owner_matches =
        string(payload, "thread_id").is_none_or(|id| id == state.session.as_ref().unwrap().id);
    // Copied fork prefixes retain their original timestamps/owner IDs, not new inference.
    let inherited = !owner_matches
        || (state.fork && known && time < state.session.as_ref().unwrap().started_at_ms);
    if inherited {
        if event == "token_count" && payload["info"]["total_token_usage"].is_object() {
            state.last_total = Some(Tokens::codex(&payload["info"]["total_token_usage"])?);
        }
        return Ok(result);
    }
    if event == "token_count" {
        result.quotas = super::quota::codex_observations(
            payload,
            state.quota_account_id.as_deref(),
            &state.session.as_ref().unwrap().id,
            known.then_some(time),
        );
        for quota in &mut result.quotas {
            quota.source_error = state.quota_identity_error.clone();
        }
    }
    match event {
        "task_started" | "turn_started" | "turn_context" => {
            if let Some(id) = string(payload, "turn_id") {
                if state.requested_mode_turn_id.as_ref() != Some(&id) {
                    state.requested_mode_turn_id = Some(id.clone());
                    state.requested_mode_ambiguous = false;
                }
                set_turn(state, id);
            }
            if let Some(root) = string(payload, "root_turn_id") {
                state.root_turn_id = Some(root);
            }
            if !state.fork || known {
                state.own_activity = true;
            }
            if let Some(model) = string(payload, "model") {
                state.requested_model = Some(model);
            }
            if payload.get("service_tier").is_some() {
                set_requested_mode(state, string(payload, "service_tier"), true);
            }
            if event != "turn_context" {
                state.session.as_mut().unwrap().status = "active".into();
                if !state.turn_id.is_empty() {
                    let turn_id = state.turn_id.clone();
                    let timing = state
                        .session
                        .as_mut()
                        .unwrap()
                        .turn_timing
                        .get_or_insert_with(|| TurnTiming {
                            turn_id,
                            basis: "codex_turn_events".into(),
                            ..Default::default()
                        });
                    timing.started_at_ms = timestamp(&payload["started_at"])
                        .or(known.then_some(time))
                        .or(timing.started_at_ms);
                }
            }
        }
        "thread_settings_applied" => {
            let settings = &payload["thread_settings"];
            state.requested_model = string(settings, "model");
            if settings.get("service_tier").is_some() {
                set_requested_mode(state, string(settings, "service_tier"), false);
            }
        }
        "model_reroute" => {
            state.rerouted_model = string(payload, "to_model");
        }
        "task_complete" | "turn_complete" | "turn_aborted" => {
            if let Some(id) = string(payload, "turn_id") {
                set_turn(state, id);
            }
            state.session.as_mut().unwrap().status = "idle".into();
            if !state.turn_id.is_empty() {
                let turn_id = state.turn_id.clone();
                let timing = state
                    .session
                    .as_mut()
                    .unwrap()
                    .turn_timing
                    .get_or_insert_with(|| TurnTiming {
                        turn_id,
                        basis: "codex_turn_events".into(),
                        ..Default::default()
                    });
                timing.started_at_ms = timestamp(&payload["started_at"]).or(timing.started_at_ms);
                timing.completed_at_ms =
                    timestamp(&payload["completed_at"]).or(known.then_some(time));
                timing.duration_ms = number(payload, "duration_ms")?.or(timing.duration_ms);
                // This is first output of the whole task/turn, not any individual response.
                timing.ttft_ms = number(payload, "time_to_first_token_ms")?.or(timing.ttft_ms);
            }
        }
        "token_usage_record" | "raw_response_completed" => {
            let Some(response_id) = string(payload, "response_id") else {
                return Err("response usage lacks response_id".into());
            };
            let value = if event == "token_usage_record" {
                &payload["usage"]
            } else {
                &payload["token_usage"]
            };
            if !value.is_object() {
                return Ok(result);
            }
            if let Some(turn) = string(payload, "turn_id") {
                set_turn(state, turn);
            }
            let id = format!("response:{response_id}");
            let mut usage = state
                .previous(&id)
                .cloned()
                .unwrap_or_else(|| record(state, "codex", id.clone(), time, known));
            usage.request_id = Some(response_id);
            usage.root_turn_id = string(payload, "root_turn_id").or(usage.root_turn_id);
            if known {
                usage.timestamp_ms = time;
                usage.unknown_fields.retain(|f| f != "timestamp");
            }
            let mut tokens = Tokens::codex(value)?;
            if state.previous(&id).is_some() {
                tokens.fill_missing(&usage);
            }
            usage.unknown_fields.retain(|f| {
                !matches!(
                    f.as_str(),
                    "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens"
                )
            });
            tokens.apply(&mut usage)?;
            response_evidence(&mut usage, value);
            response_evidence(&mut usage, payload);
            let duration = number(payload, "duration_ms")?;
            usage.duration_ms = duration.or(usage.duration_ms);
            if duration.is_some() || event == "raw_response_completed" && known {
                let timing = usage.request_timing.get_or_insert_with(|| RequestTiming {
                    basis: "codex_response_usage".into(),
                    ..Default::default()
                });
                timing.duration_ms = duration.or(timing.duration_ms);
                if event == "raw_response_completed" && known {
                    timing.completed_at_ms = Some(time);
                    timing.basis = "codex_raw_response_completed".into();
                }
            }
            usage.usage_basis = event.into();
            let total = payload
                .get("thread_token_usage")
                .filter(|v| v.is_object())
                .map(Tokens::codex)
                .transpose()?;
            let advances = total.as_ref().is_none_or(|now| {
                state
                    .canonical_total
                    .as_ref()
                    .is_none_or(|old| now.delta(old).is_some() && !now.same_endpoint(old))
            });
            let new_occurrence = advances && state.previous(&id).is_none();
            let paired_legacy = state.pending_usage.as_ref().is_some_and(|pending| {
                !pending.canonical
                    && new_occurrence
                    && pending.turn_id == state.turn_id
                    && pending.tokens.same_usage(&tokens)
                    && pending
                        .total
                        .as_ref()
                        .zip(total.as_ref())
                        .is_some_and(|(a, b)| a.same_endpoint(b))
            });
            if paired_legacy {
                result
                    .delete_ids
                    .push(state.pending_usage.as_ref().unwrap().id.clone());
            }
            let existing = state
                .pending_usage
                .as_ref()
                .filter(|p| p.canonical && p.id == id);
            let paired = paired_legacy || existing.is_some_and(|p| p.paired);
            if new_occurrence || existing.is_some() {
                state.pending_usage = Some(UsageOccurrence {
                    id: id.clone(),
                    turn_id: state.turn_id.clone(),
                    tokens,
                    total: total.clone(),
                    canonical: true,
                    paired,
                });
            }
            if advances && total.is_some() {
                state.canonical_total = total;
            }
            state.remember(usage.clone());
            result.usage.push(usage);
        }
        "token_count" => {
            let info = &payload["info"];
            if !info.is_object() {
                return Ok(result);
            }
            let total = info
                .get("total_token_usage")
                .filter(|v| v.is_object())
                .map(Tokens::codex)
                .transpose()?;
            if total
                .as_ref()
                .zip(state.last_total.as_ref())
                .is_some_and(|(a, b)| a.same_endpoint(b))
            {
                return Ok(result);
            }
            let previous = state.last_total.clone();
            if let Some(total) = &total {
                state.last_total = Some(total.clone());
            }
            if state.fork && !state.own_activity {
                return Ok(result);
            }
            let provisional = total.as_ref().and_then(|t| provisional_id(state, t));
            let last = info
                .get("last_token_usage")
                .filter(|v| v.is_object())
                .map(Tokens::codex)
                .transpose()?;
            let delta = total
                .as_ref()
                .zip(previous.as_ref())
                .and_then(|(a, b)| a.delta(b));
            let pending = state
                .pending_usage
                .as_ref()
                .filter(|p| p.canonical && !p.paired && p.turn_id == state.turn_id);
            // Context compaction can shift legacy totals; the source occurrence and counter transition establish this pair.
            let paired = pending.is_some_and(|p| {
                last.as_ref().is_some_and(|last| last.same_usage(&p.tokens))
                    && (delta.as_ref().is_some_and(|d| d.same_usage(&p.tokens))
                        || p.total
                            .as_ref()
                            .zip(total.as_ref())
                            .is_some_and(|(a, b)| a.same_endpoint(b)))
            });
            if paired {
                state.pending_usage.as_mut().unwrap().paired = true;
                if let Some(id) = provisional {
                    result.delete_ids.push(id);
                }
                return Ok(result);
            }
            let occurrence_total = total.clone();
            let (tokens, basis, per_request) = if let Some(last) = last {
                (last, "legacy_last_token_usage", true)
            } else if let Some(delta) = delta {
                (delta, "legacy_cumulative_delta", false)
            } else if let Some(total) = total {
                (total, "legacy_initial_cumulative", false)
            } else {
                return Ok(result);
            };
            state.sequence += 1;
            let native_id = string(payload, "response_id");
            let id = native_id
                .as_ref()
                .map(|id| format!("response:{id}"))
                .or(provisional)
                .unwrap_or_else(|| {
                    format!(
                        "legacy:{}:{}:{time}:{}",
                        state.session.as_ref().unwrap().id,
                        state.turn_id,
                        state.sequence
                    )
                });
            let mut usage = record(state, "codex", id.clone(), time, known);
            usage.request_id = native_id;
            tokens.apply(&mut usage)?;
            if !per_request {
                usage.context_tokens = None;
                usage.unknown_fields.push("per_request_input_tokens".into());
            }
            usage.usage_basis = basis.into();
            response_evidence(&mut usage, payload);
            state.pending_usage = Some(UsageOccurrence {
                id,
                turn_id: state.turn_id.clone(),
                tokens,
                total: occurrence_total,
                canonical: false,
                paired: false,
            });
            result.usage.push(usage);
        }
        _ => {}
    }
    if let Some(meta) = &mut state.session {
        meta.model = state.requested_model.clone().or(meta.model.clone());
    }
    Ok(result)
}

fn claude(
    state: &mut ParserState,
    path: &Path,
    row: &Value,
    time: i64,
    known: bool,
) -> Result<ParsedLine, String> {
    let path_parent = path
        .parent()
        .filter(|p| p.file_name().is_some_and(|n| n == "subagents"))
        .and_then(Path::parent)
        .and_then(Path::file_name)
        .map(|s| s.to_string_lossy().into_owned());
    let child_id = path_parent
        .as_ref()
        .map(|_| fallback_id(path).trim_start_matches("agent-").to_owned());
    let id = child_id
        .or_else(|| string(row, "sessionId"))
        .unwrap_or_else(|| fallback_id(path));
    session(state, "claude", id, time);
    let meta = state.session.as_mut().unwrap();
    meta.parent_id = path_parent.or(meta.parent_id.clone());
    if let Some(cwd) = string(row, "cwd") {
        meta.project = Some(cwd);
    }
    let mut result = ParsedLine::default();
    let tool_result = row["message"]["content"]
        .as_array()
        .is_some_and(|blocks| blocks.iter().any(|b| b["type"] == "tool_result"));
    if row["type"] == "user" && row["isMeta"] != true && !tool_result {
        if let Some(id) = string(row, "uuid") {
            set_turn(state, id);
        }
        return Ok(result);
    }
    if row["type"] == "system" && row["subtype"] == "turn_duration" {
        if !state.turn_id.is_empty() {
            let turn_id = state.turn_id.clone();
            state.session.as_mut().unwrap().turn_timing = Some(TurnTiming {
                turn_id,
                completed_at_ms: known.then_some(time),
                duration_ms: number(row, "durationMs")?,
                basis: "claude_system.turn_duration".into(),
                ..Default::default()
            });
        }
        return Ok(result);
    }
    if row["type"] != "assistant" || row["isApiErrorMessage"] == true {
        return Ok(result);
    }
    let message = &row["message"];
    if message["model"] == "<synthetic>" || message["isApiErrorMessage"] == true {
        return Ok(result);
    }
    let data = &message["usage"];
    if !data.is_object() {
        return Ok(result);
    }
    let message_id = string(message, "id");
    let request_id = string(row, "requestId")
        .or_else(|| string(row, "request_id"))
        .or_else(|| string(message, "request_id"));
    let identity = message_id
        .clone()
        .map(|s| format!("message:{s}"))
        .or_else(|| request_id.as_ref().map(|s| format!("request:{s}")))
        .or_else(|| string(row, "uuid").map(|s| format!("occurrence:{s}")))
        .ok_or("assistant usage lacks message, request and occurrence IDs")?;
    let id = format!("claude:{identity}");
    let mut usage = state
        .previous(&id)
        .cloned()
        .unwrap_or_else(|| record(state, "claude", id.clone(), time, known));
    usage.request_id = request_id.or(message_id);
    usage.timestamp_ms = time;
    if let Some(model) = string(message, "model") {
        usage.model = Some(model.clone());
        usage.model_basis = "response_model".into();
        state.session.as_mut().unwrap().model = Some(model);
    }
    let mut tokens = Tokens {
        input: number(data, "input_tokens")?,
        output: number(data, "output_tokens")?,
        read: number(data, "cache_read_input_tokens")?,
        write: number(data, "cache_creation_input_tokens")?,
        reasoning: None,
    };
    if state.previous(&id).is_some() {
        let known_old = |field: &str| !usage.unknown_fields.iter().any(|s| s == field);
        tokens.output = tokens
            .output
            .or_else(|| known_old("output_tokens").then_some(usage.output_tokens));
        tokens.read = tokens
            .read
            .or_else(|| known_old("cache_read_tokens").then_some(usage.cache_read_tokens));
        tokens.write = tokens
            .write
            .or_else(|| known_old("cache_write_tokens").then_some(usage.cache_write_tokens));
        tokens.input = tokens.input.or_else(|| {
            known_old("uncached_input_tokens")
                .then_some(usage.input_tokens - usage.cache_read_tokens - usage.cache_write_tokens)
        });
    }
    let uncached_known = tokens.input.is_some();
    let source_input_tokens = tokens.input;
    let input_known = tokens.input.is_some() && tokens.read.is_some() && tokens.write.is_some();
    tokens.input = Some(
        tokens
            .input
            .unwrap_or(0)
            .checked_add(tokens.read.unwrap_or(0))
            .and_then(|n| n.checked_add(tokens.write.unwrap_or(0)))
            .ok_or("token count overflow")?,
    );
    usage.unknown_fields.retain(|f| {
        !matches!(
            f.as_str(),
            "input_tokens"
                | "uncached_input_tokens"
                | "output_tokens"
                | "cache_read_tokens"
                | "cache_write_tokens"
        )
    });
    tokens.apply(&mut usage)?;
    usage.source_input_tokens = source_input_tokens;
    if !input_known {
        usage.unknown_fields.push("input_tokens".into());
        usage.context_tokens = None;
    }
    if !uncached_known {
        usage.unknown_fields.push("uncached_input_tokens".into());
    }
    if known {
        usage.unknown_fields.retain(|f| f != "timestamp");
    }
    let creation = &data["cache_creation"];
    usage.cache_write_5m_tokens =
        number(creation, "ephemeral_5m_input_tokens")?.or(usage.cache_write_5m_tokens);
    usage.cache_write_1h_tokens =
        number(creation, "ephemeral_1h_input_tokens")?.or(usage.cache_write_1h_tokens);
    if usage.cache_write_tokens == 0
        && !usage
            .unknown_fields
            .iter()
            .any(|s| s == "cache_write_tokens")
    {
        usage.cache_write_5m_tokens = Some(0);
        usage.cache_write_1h_tokens = Some(0);
    }
    response_evidence(&mut usage, message);
    response_evidence(&mut usage, data);
    if let Some(speed) = mode(string(data, "speed")) {
        usage.mode = Some(speed);
        usage.mode_basis = "response_reported".into();
    }
    usage.duration_ms = number(row, "durationMs")?
        .or(number(row, "duration_ms")?)
        .or(usage.duration_ms);
    usage.usage_basis = "assistant_message_usage".into();
    state.remember(usage.clone());
    result.usage.push(usage);
    Ok(result)
}

pub fn parse_line(
    state: &mut ParserState,
    tool: &str,
    path: &Path,
    line: &str,
    modified_ms: i64,
) -> Result<ParsedLine, String> {
    if line.trim().is_empty() {
        return Ok(ParsedLine::default());
    }
    // Error messages never include a source fragment, which can contain prompts or credentials.
    let row: Value = serde_json::from_str(line)
        .map_err(|e| format!("invalid JSON at column {}: {:?}", e.column(), e.classify()))?;
    if !row.is_object() {
        return Err("JSONL record is not an object".into());
    }
    let observed = timestamp(&row["timestamp"]).or_else(|| timestamp(&row["time"]));
    let time = observed.unwrap_or(modified_ms);
    let mut result = match tool {
        "codex" => codex(state, path, &row, time, observed.is_some())?,
        "claude" => claude(state, path, &row, time, observed.is_some())?,
        "antigravity" => {
            session(
                state,
                tool,
                string(&row, "session_id")
                    .or_else(|| string(&row, "sessionId"))
                    .unwrap_or_else(|| {
                        let parts: Vec<_> = path
                            .components()
                            .map(|p| p.as_os_str().to_string_lossy().into_owned())
                            .collect();
                        if let Some(brain) = parts.iter().position(|p| p == "brain") {
                            if brain > 0 && brain + 1 < parts.len() {
                                return format!("{}:{}", parts[brain - 1], parts[brain + 1]);
                            }
                        }
                        path.parent()
                            .and_then(Path::file_name)
                            .map(|s| s.to_string_lossy().into_owned())
                            .unwrap_or_else(|| fallback_id(path))
                    }),
                time,
            );
            ParsedLine::default()
        }
        _ => return Err("unsupported usage source".into()),
    };
    if let Some(meta) = &mut state.session {
        meta.updated_at_ms = meta.updated_at_ms.max(time);
    }
    result.session = state.session.clone();
    Ok(result)
}

pub fn finish_batch(_state: &mut ParserState) -> ParsedLine {
    ParsedLine::default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn feed(state: &mut ParserState, value: Value) -> ParsedLine {
        parse_line(
            state,
            "codex",
            Path::new("rollout.jsonl"),
            &value.to_string(),
            0,
        )
        .unwrap()
    }
    fn counts(input: i64, output: i64) -> Value {
        json!({"input_tokens":input,"output_tokens":output,"cached_input_tokens":0,"cache_write_input_tokens":0,"reasoning_output_tokens":0})
    }
    fn meta(state: &mut ParserState) {
        feed(
            state,
            json!({"type":"session_meta","timestamp":"2026-10-15T17:00:00Z","payload":{"id":"thread"}}),
        );
        feed(
            state,
            json!({"type":"turn_context","payload":{"turn_id":"turn","model":"gpt-6-sol"}}),
        );
    }
    fn legacy(state: &mut ParserState, input: i64, output: i64) -> ParsedLine {
        feed(
            state,
            json!({"type":"event_msg","timestamp":"2026-10-15T17:01:00Z","payload":{"type":"token_count","info":{"total_token_usage":counts(input,output),"last_token_usage":counts(10,2)}}}),
        )
    }
    fn modern(state: &mut ParserState, response: &str, input: i64, output: i64) -> ParsedLine {
        feed(
            state,
            json!({"type":"event_msg","timestamp":"2026-10-15T17:01:00Z","payload":{"type":"token_usage_record","thread_id":"thread","session_id":"root","turn_id":"turn","root_turn_id":"root-turn","response_id":response,"usage":counts(10,2),"thread_token_usage":counts(input,output)}}),
        )
    }
    #[test]
    fn canonical_replaces_legacy_and_reverse_order_deduplicates() {
        let mut s = ParserState::default();
        meta(&mut s);
        let old = legacy(&mut s, 10, 2).usage.remove(0);
        let canonical = modern(&mut s, "r1", 10, 2);
        assert_eq!(canonical.delete_ids, vec![old.id]);
        assert_eq!(canonical.usage[0].session_id, "thread");
        assert_eq!(
            canonical.usage[0].root_turn_id.as_deref(),
            Some("root-turn")
        );
        assert!(legacy(&mut s, 10, 2).usage.is_empty());
        assert_eq!(modern(&mut s, "r2", 20, 4).usage.len(), 1);
        assert!(legacy(&mut s, 20, 4).usage.is_empty());
        assert_eq!(legacy(&mut s, 30, 6).usage.len(), 1); // Equal per-response tokens are distinct occurrences.
        let restored: ParserState =
            serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert_eq!(restored.last_total, s.last_total);
    }
    #[test]
    fn ambiguous_late_equal_tokens_are_not_merged_and_cursor_history_is_bounded() {
        let mut s = ParserState::default();
        meta(&mut s);
        legacy(&mut s, 10, 2);
        for n in 2..100 {
            legacy(&mut s, n * 10, n * 2);
        }
        assert!(modern(&mut s, "late", 10, 2).delete_ids.is_empty());
        assert!(legacy(&mut s, 990, 198).usage.is_empty());
        for n in 0..50 {
            modern(&mut s, &format!("recent-{n}"), 1000 + n * 10, 200 + n * 2);
        }
        assert_eq!(s.recent.len(), 8);
    }
    #[test]
    fn real_compaction_offset_pairs_occurrences_using_independent_counter_transitions() {
        let mut s = ParserState::default();
        meta(&mut s);
        let observed = |input, output, read, reasoning| {
            json!({"input_tokens":input,"output_tokens":output,
            "cached_input_tokens":read,"cache_write_input_tokens":0,"reasoning_output_tokens":reasoning})
        };
        let legacy_base = observed(81_438_803, 171_144, 79_167_616, 96_249);
        let canonical_base = observed(82_056_555, 174_470, 79_784_192, 96_249);
        let legacy_total = observed(81_557_663, 171_618, 79_276_416, 96_260);
        let canonical_total = observed(82_175_415, 174_944, 79_892_992, 96_260);
        feed(
            &mut s,
            json!({"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":legacy_base,"last_token_usage":observed(109_764,41,107_776,8)}}}),
        );
        let usage = observed(118_860, 474, 108_800, 11);
        let canonical = json!({"type":"token_usage_record","payload":{"thread_id":"thread","turn_id":"turn","response_id":"offset-response","usage":usage,"thread_token_usage":canonical_total}});
        assert_eq!(feed(&mut s, canonical.clone()).usage.len(), 1);
        let restored: ParserState =
            serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        s = restored;
        let legacy = json!({"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":legacy_total,"last_token_usage":usage}}});
        let paired = feed(&mut s, legacy.clone());
        assert!(paired.usage.is_empty());
        assert_eq!(
            paired.delete_ids,
            vec!["legacy:thread:turn:81557663:171618"]
        );
        assert!(feed(&mut s, legacy).usage.is_empty());
        assert_eq!(s.last_total.as_ref().unwrap().input, Some(81_557_663));
        assert_eq!(s.canonical_total.as_ref().unwrap().input, Some(82_175_415));

        let mut reverse = ParserState::default();
        meta(&mut reverse);
        reverse.last_total = Some(Tokens::codex(&legacy_base).unwrap());
        reverse.canonical_total = Some(Tokens::codex(&canonical_base).unwrap());
        let old = feed(&mut reverse, json!({"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":legacy_total,"last_token_usage":usage}}})).usage.remove(0).id;
        // Reversed, shifted counters have no native occurrence link; do not guess from equal deltas.
        assert!(!feed(&mut reverse, canonical).delete_ids.contains(&old));
    }
    #[test]
    fn equal_response_tokens_without_matching_occurrence_transition_remain_distinct() {
        let mut s = ParserState::default();
        meta(&mut s);
        legacy(&mut s, 100, 20);
        modern(&mut s, "canonical", 1000, 200);
        assert_eq!(legacy(&mut s, 120, 24).usage.len(), 1);
        assert!(modern(&mut s, "late-other", 1010, 202)
            .delete_ids
            .is_empty());
    }
    #[test]
    fn fork_prefix_is_not_new_usage_and_child_keeps_native_identity() {
        let mut s = ParserState::default();
        feed(
            &mut s,
            json!({"type":"session_meta","timestamp":"2026-10-15T17:02:00Z","payload":{"id":"thread","forked_from_id":"parent"}}),
        );
        assert!(legacy(&mut s, 10, 2).usage.is_empty());
        feed(
            &mut s,
            json!({"type":"event_msg","timestamp":"2026-10-15T17:03:00Z","payload":{"type":"task_started","turn_id":"new"}}),
        );
        let mut row = json!({"type":"event_msg","timestamp":"2026-10-15T17:04:00Z","payload":{"type":"token_count","info":{"total_token_usage":counts(20,4)}}});
        let usage = feed(&mut s, row.clone()).usage.remove(0);
        assert_eq!((usage.input_tokens, usage.output_tokens), (10, 2));
        assert_eq!(
            s.session.as_ref().unwrap().parent_id.as_deref(),
            Some("parent")
        );
        row["payload"]["info"]["total_token_usage"] = counts(20, 4);
        assert!(feed(&mut s, row).usage.is_empty());
    }
    #[test]
    fn models_and_requested_modes_are_not_actual_tiers() {
        let mut s = ParserState::default();
        meta(&mut s);
        feed(
            &mut s,
            json!({"type":"turn_context","payload":{"turn_id":"turn","service_tier":"priority"}}),
        );
        let a = modern(&mut s, "a", 10, 2).usage.remove(0);
        feed(
            &mut s,
            json!({"type":"turn_context","payload":{"turn_id":"turn","model":"gpt-6.1-sol","service_tier":"priority"}}),
        );
        let mut b = modern(&mut s, "b", 20, 4).usage.remove(0);
        assert_ne!(a.model, b.model);
        assert_eq!(b.mode, None);
        assert_eq!(b.requested_mode.as_deref(), Some("fast"));
        response_evidence(
            &mut b,
            &json!({"model":"gpt-6-luna","service_tier":"default"}),
        );
        assert_eq!(b.model.as_deref(), Some("gpt-6-luna"));
        assert_eq!(b.requested_model.as_deref(), Some("gpt-6.1-sol"));
        assert_eq!(b.mode.as_deref(), Some("standard"));
    }

    fn scoped_response(state: &mut ParserState, id: &str, turn: &str) -> UsageRecord {
        feed(
            state,
            json!({"type":"event_msg","timestamp":"2026-10-15T17:01:00Z",
            "payload":{"type":"token_usage_record","thread_id":"thread","turn_id":turn,
                "response_id":id,"usage":counts(10,2)}}),
        )
        .usage
        .remove(0)
    }

    #[test]
    fn requested_mode_changes_are_ambiguous_until_explicit_next_turn() {
        let mut s = ParserState::default();
        feed(
            &mut s,
            json!({"type":"session_meta","payload":{"id":"thread"}}),
        );
        let setting = |tier: Value| {
            json!({"type":"event_msg","payload":{"type":"thread_settings_applied",
            "thread_id":"thread","thread_settings":{"service_tier":tier}}})
        };
        feed(&mut s, setting(json!("default")));
        feed(
            &mut s,
            json!({"type":"task_started","payload":{"turn_id":"turn"}}),
        );
        let old = scoped_response(&mut s, "before-change", "turn");
        assert_eq!(old.requested_mode.as_deref(), Some("standard"));
        feed(&mut s, setting(json!("default")));
        assert_eq!(
            scoped_response(&mut s, "same-setting", "turn")
                .requested_mode
                .as_deref(),
            Some("standard")
        );
        feed(&mut s, setting(json!("priority")));
        let pending = scoped_response(&mut s, "pending-old-request", "turn");
        assert!(pending.requested_mode.is_none());
        assert!(pending
            .unknown_fields
            .iter()
            .any(|field| field == "requested_mode_ambiguous"));
        assert_eq!(old.requested_mode.as_deref(), Some("standard"));
        feed(
            &mut s,
            json!({"type":"task_started","payload":{"turn_id":"next"}}),
        );
        assert_eq!(
            scoped_response(&mut s, "new-request", "next")
                .requested_mode
                .as_deref(),
            Some("fast")
        );
        assert!(scoped_response(&mut s, "late-old-response", "turn")
            .requested_mode
            .is_none());
        assert_eq!(
            scoped_response(&mut s, "still-new", "next")
                .requested_mode
                .as_deref(),
            Some("fast")
        );
        feed(&mut s, setting(Value::Null));
        feed(
            &mut s,
            json!({"type":"task_started","payload":{"turn_id":"null-setting"}}),
        );
        assert!(scoped_response(&mut s, "null-request", "null-setting")
            .requested_mode
            .is_none());
        feed(
            &mut s,
            json!({"type":"event_msg","payload":{"type":"thread_settings_applied",
            "thread_id":"thread","thread_settings":{"model":"gpt-6.1-sol"}}}),
        );
        assert!(scoped_response(&mut s, "missing-setting", "null-setting")
            .requested_mode
            .is_none());
    }

    #[test]
    fn same_turn_context_change_is_not_assigned_to_outstanding_requests() {
        let mut s = ParserState::default();
        meta(&mut s);
        feed(
            &mut s,
            json!({"type":"turn_context","payload":{"turn_id":"turn","service_tier":"default"}}),
        );
        let old = scoped_response(&mut s, "before", "turn");
        assert_eq!(old.requested_mode.as_deref(), Some("standard"));
        feed(
            &mut s,
            json!({"type":"turn_context","payload":{"turn_id":"turn","service_tier":"priority"}}),
        );
        let mut pending = scoped_response(&mut s, "after", "turn");
        assert!(pending.requested_mode.is_none());
        response_evidence(&mut pending, &json!({"service_tier":"priority"}));
        assert_eq!(pending.mode.as_deref(), Some("fast"));
        assert_eq!(pending.mode_basis, "response_reported");
    }

    #[test]
    fn parent_settings_and_legacy_state_do_not_change_request_scope() {
        let mut s = ParserState::default();
        meta(&mut s);
        s.requested_mode = Some("standard".into());
        let mut legacy = serde_json::to_value(&s).unwrap();
        legacy
            .as_object_mut()
            .unwrap()
            .remove("requested_mode_turn_id");
        legacy
            .as_object_mut()
            .unwrap()
            .remove("requested_mode_ambiguous");
        let mut s: ParserState = serde_json::from_value(legacy).unwrap();
        assert_eq!(
            scoped_response(&mut s, "legacy-setting", "turn")
                .requested_mode
                .as_deref(),
            Some("standard")
        );
        feed(
            &mut s,
            json!({"type":"event_msg","payload":{"type":"thread_settings_applied",
            "thread_id":"parent","thread_settings":{"service_tier":"priority"}}}),
        );
        assert_eq!(
            scoped_response(&mut s, "own-request", "turn")
                .requested_mode
                .as_deref(),
            Some("standard")
        );
        feed(
            &mut s,
            json!({"type":"session_meta","timestamp":"2026-10-15T18:00:00Z",
            "payload":{"id":"child","forked_from_id":"parent"}}),
        );
        feed(
            &mut s,
            json!({"type":"event_msg","timestamp":"2026-10-15T17:00:00Z",
            "payload":{"type":"thread_settings_applied","thread_id":"parent","thread_settings":{"service_tier":"priority"}}}),
        );
        assert!(s.requested_mode.is_none());
    }
    #[test]
    fn timing_codex_turn_events_do_not_become_response_durations() {
        let mut state = ParserState::default();
        meta(&mut state);
        let started = feed(
            &mut state,
            json!({"type":"event_msg","timestamp":"2026-10-16T00:00:00Z","payload":{"type":"task_started","turn_id":"turn","started_at":1792108800}}),
        );
        assert_eq!(
            started.session.unwrap().turn_timing.unwrap().started_at_ms,
            Some(1_792_108_800_000)
        );
        assert!(modern(&mut state, "response", 10, 2).usage[0]
            .request_timing
            .is_none());
        let completed = feed(
            &mut state,
            json!({"type":"event_msg","timestamp":"2026-10-16T00:02:00Z","payload":{"type":"task_complete","turn_id":"turn","started_at":1792108800,"completed_at":1792108920,"duration_ms":120000,"time_to_first_token_ms":4500}}),
        );
        let timing = completed.session.unwrap().turn_timing.unwrap();
        assert_eq!(timing.turn_id, "turn");
        assert_eq!(
            (timing.duration_ms, timing.ttft_ms),
            (Some(120_000), Some(4500))
        );
        assert_eq!(timing.completed_at_ms, Some(1_792_108_920_000));
        assert_eq!(timing.basis, "codex_turn_events");
        let next = feed(
            &mut state,
            json!({"type":"turn_context","payload":{"turn_id":"next"}}),
        );
        assert!(
            next.session.unwrap().turn_timing.is_none(),
            "the next turn cannot inherit the previous turn's measurements"
        );
    }
    #[test]
    fn timing_response_completion_keeps_request_scope_and_actual_tier() {
        let mut state = ParserState::default();
        meta(&mut state);
        feed(
            &mut state,
            json!({"type":"turn_context","payload":{"turn_id":"turn","model":"gpt-6-sol","service_tier":"priority"}}),
        );
        let mut row = json!({"type":"raw_response_completed","timestamp":"2026-10-16T00:02:00Z","payload":{"response_id":"timed","duration_ms":2000,"token_usage":counts(10,2)}});
        row["payload"]["token_usage"]["model"] = json!("gpt-6-luna");
        row["payload"]["token_usage"]["service_tier"] = json!("default");
        let usage = feed(&mut state, row).usage.remove(0);
        let timing = usage.request_timing.unwrap();
        assert_eq!(timing.duration_ms, Some(2000));
        assert_eq!(timing.completed_at_ms, Some(1_792_108_920_000));
        assert_eq!(
            (
                timing.started_at_ms,
                timing.ttft_ms,
                timing.streaming_duration_ms
            ),
            (None, None, None)
        );
        assert_eq!(usage.model.as_deref(), Some("gpt-6-luna"));
        assert_eq!(usage.mode.as_deref(), Some("standard"));
        assert_eq!(usage.requested_mode.as_deref(), Some("fast"));
        assert!(state.session.as_ref().unwrap().turn_timing.is_none());
    }
    #[test]
    fn timing_claude_system_duration_requires_a_real_user_turn() {
        let mut state = ParserState::default();
        let path = Path::new("projects/session.jsonl");
        let system = json!({"type":"system","subtype":"turn_duration","sessionId":"session","timestamp":"2026-10-16T00:02:00Z","durationMs":7175});
        let parse = |state: &mut ParserState, row: Value| {
            parse_line(state, "claude", path, &row.to_string(), 0).unwrap()
        };
        assert!(parse(&mut state, system.clone())
            .session
            .unwrap()
            .turn_timing
            .is_none());
        parse(
            &mut state,
            json!({"type":"user","sessionId":"session","uuid":"real-user-turn","timestamp":"2026-10-16T00:01:00Z"}),
        );
        let timed = parse(&mut state, system);
        assert!(timed.usage.is_empty());
        let timing = timed.session.unwrap().turn_timing.unwrap();
        assert_eq!(timing.turn_id, "real-user-turn");
        assert_eq!(timing.duration_ms, Some(7175));
        assert_eq!(timing.completed_at_ms, Some(1_792_108_920_000));
        assert_eq!((timing.started_at_ms, timing.ttft_ms), (None, None));
        parse(
            &mut state,
            json!({"type":"user","sessionId":"session","uuid":"next-real-turn"}),
        );
        assert!(state.session.unwrap().turn_timing.is_none());
    }
    #[test]
    fn claude_chunks_upsert_normalized_usage_and_subagent_path_wins() {
        let mut s = ParserState::default();
        let mut row = json!({"type":"assistant","sessionId":"parent","timestamp":"2026-10-15T17:00:00Z","message":{"id":"msg","model":"claude-opus-5-5","usage":{"input_tokens":10,"output_tokens":2,"cache_read_input_tokens":20,"cache_creation_input_tokens":5,"cache_creation":{"ephemeral_5m_input_tokens":3,"ephemeral_1h_input_tokens":2},"speed":"fast"}}});
        let path = Path::new("projects/parent/subagents/agent-child.jsonl");
        let a = parse_line(&mut s, "claude", path, &row.to_string(), 0)
            .unwrap()
            .usage
            .remove(0);
        row["message"]["usage"]["output_tokens"] = json!(7);
        let b = parse_line(&mut s, "claude", path, &row.to_string(), 0)
            .unwrap()
            .usage
            .remove(0);
        assert_eq!(a.id, b.id);
        assert_eq!((b.input_tokens, b.output_tokens), (35, 7));
        assert_eq!(b.session_id, "child");
        assert_eq!(
            s.session.as_ref().unwrap().parent_id.as_deref(),
            Some("parent")
        );
        assert_eq!(b.mode.as_deref(), Some("fast"));
        assert!(b.unknown_fields.is_empty());
        row["message"]["model"] = json!("<synthetic>");
        assert!(parse_line(&mut s, "claude", path, &row.to_string(), 0)
            .unwrap()
            .usage
            .is_empty());
        row["message"]["model"] = json!("claude-opus-5-5");
        row["isApiErrorMessage"] = json!(true);
        assert!(parse_line(&mut s, "claude", path, &row.to_string(), 0)
            .unwrap()
            .usage
            .is_empty());
    }
    #[test]
    fn unknown_breakdowns_are_not_known_zero_and_content_is_never_saved() {
        let mut s = ParserState::default();
        meta(&mut s);
        let row = json!({"type":"event_msg","payload":{"type":"token_usage_record","thread_id":"thread","turn_id":"turn","response_id":"unknown","usage":{"input_tokens":10,"output_tokens":2},"content":"PRIVATE PROMPT"}});
        let usage = feed(&mut s, row).usage.remove(0);
        assert!(usage.unknown_fields.contains(&"cache_read_tokens".into()));
        let partial = feed(&mut s, json!({"type":"event_msg","payload":{"type":"token_usage_record","thread_id":"thread","turn_id":"turn","response_id":"partial","usage":{"cached_input_tokens":20,"cache_write_input_tokens":0,"reasoning_output_tokens":4}}})).usage.remove(0);
        assert_eq!((partial.input_tokens, partial.output_tokens), (20, 4));
        assert!(partial.unknown_fields.contains(&"input_tokens".into()));
        assert!(partial.unknown_fields.contains(&"output_tokens".into()));
        assert!(!serde_json::to_string(&s)
            .unwrap()
            .contains("PRIVATE PROMPT"));
        assert!(
            parse_line(&mut s, "codex", Path::new("x"), "{\"secret\": broken}", 0)
                .unwrap_err()
                .find("secret")
                .is_none()
        );
        assert!(parse_line(
            &mut s,
            "antigravity",
            Path::new("chat/transcript.jsonl"),
            "{\"step\":1,\"content\":\"PRIVATE PROMPT\"}",
            0
        )
        .unwrap()
        .usage
        .is_empty());
    }

    #[test]
    fn antigravity_discovery_uses_conversation_not_shared_logs_directory() {
        let mut a = ParserState::default();
        let mut b = ParserState::default();
        let left = parse_line(
            &mut a,
            "antigravity",
            Path::new("home/.gemini/antigravity/brain/one/.system_generated/logs/transcript.jsonl"),
            "{}",
            0,
        )
        .unwrap();
        let right = parse_line(
            &mut b,
            "antigravity",
            Path::new("home/.gemini/antigravity/brain/two/.system_generated/logs/transcript.jsonl"),
            "{}",
            0,
        )
        .unwrap();
        assert_eq!(left.session.unwrap().id, "antigravity:one");
        assert_eq!(right.session.unwrap().id, "antigravity:two");
    }
}
