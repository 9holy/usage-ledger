//! Read-only Antigravity LS metadata (installed IDE 1.23.2 protocol).
//! Tokens stay in memory; only metadata offsets, never CSRF or message bodies, enter state.

use super::{
    parser::ParsedLine,
    types::{RequestTiming, SessionMeta, UsageRecord},
};
use chrono::DateTime;
use reqwest::blocking::Client;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::Read,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

const SERVICE: &str = "exa.language_server_pb.LanguageServerService";
const RESPONSE_LIMIT: u64 = 8 * 1024 * 1024;
const PAGE_LIMIT: usize = 256;
const SESSION_LIMIT: usize = 8;

#[derive(Clone, Deserialize)]
struct Connection {
    executable: String,
    namespace: String,
    csrf: String,
    ports: Vec<u16>,
}

struct Discovery {
    checked: Instant,
    connections: Vec<Connection>,
    error: Option<String>,
}

static DISCOVERY: OnceLock<Mutex<Option<Discovery>>> = OnceLock::new();

// Query only Antigravity's own processes and their listening ports, never scan port ranges.
#[cfg(windows)]
fn discover() -> Result<Vec<Connection>, String> {
    use std::os::windows::process::CommandExt;
    let script = r#"
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
function Arg($line,$name) {
  $m=[regex]::Match($line,'(?:^|\s)'+[regex]::Escape($name)+'(?:=|\s+)(?:"([^"]+)"|(\S+))')
  if($m.Success){if($m.Groups[1].Success){return $m.Groups[1].Value};return $m.Groups[2].Value};return ''
}
$items=@()
$currentSid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
Get-CimInstance Win32_Process -Filter "Name LIKE 'language_server%'" | ForEach-Object {
  $p=$_; $path=$p.ExecutablePath
  if(!$path -or $path -notmatch '(?i)\\antigravity\\resources\\bin\\language_server\.exe$|\\resources\\app\\extensions\\antigravity\\bin\\language_server_windows_(x64|arm)\.exe$'){return}
  if((Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid).Sid -ne $currentSid){return}
  $csrf=Arg $p.CommandLine '--csrf_token'; $ns=Arg $p.CommandLine '--app_data_dir'
  if(!$csrf -or $ns -notmatch '^antigravity(?:-ide|-cli|-dev)?$'){return}
  $listeners=@(Get-NetTCPConnection -OwningProcess $p.ProcessId -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort -Unique)
  $port=Arg $p.CommandLine '--https_server_port'
  if($port -match '^\d+$' -and [int]$port -gt 0){$listeners=@($listeners | Where-Object {$_ -eq [int]$port})}
  if($listeners.Count -gt 0){$items+=@{executable=$path;namespace=$ns;csrf=$csrf;ports=@($listeners | Sort-Object)}}
}
ConvertTo-Json -InputObject @($items) -Depth 4 -Compress
"#;
    let output = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(0x08000000)
        .output()
        .map_err(|_| "无法读取 Antigravity 运行实例元数据".to_string())?;
    if !output.status.success() {
        // PowerShell's error text can contain the command line: never surface it.
        return Err("读取 Antigravity 运行实例元数据失败".into());
    }
    serde_json::from_slice(&output.stdout).map_err(|_| "Antigravity 运行实例元数据格式无效".into())
}

#[cfg(any(target_os = "macos", test))]
#[path = "antigravity_macos.rs"]
mod macos;

#[cfg(target_os = "macos")]
fn discover() -> Result<Vec<Connection>, String> {
    macos::discover()
}

#[cfg(not(any(windows, target_os = "macos")))]
fn discover() -> Result<Vec<Connection>, String> {
    Err("Antigravity LS 自动发现目前仅支持 Windows 和 macOS".into())
}

fn connections() -> Result<Vec<Connection>, String> {
    let mut guard = DISCOVERY
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "Antigravity 运行实例缓存不可用")?;
    if guard
        .as_ref()
        .is_none_or(|d| d.checked.elapsed() >= Duration::from_secs(30))
    {
        let result = discover();
        let (connections, error) = match result {
            Ok(c) => (c, None),
            Err(e) => (Vec::new(), Some(e)),
        };
        *guard = Some(Discovery {
            checked: Instant::now(),
            connections,
            error,
        });
    }
    let cache = guard.as_ref().expect("discovery initialized");
    if let Some(e) = &cache.error {
        return Err(e.clone());
    }
    if cache.connections.is_empty() {
        return Err(
            "未发现运行中的 Antigravity App / IDE / CLI language server；未启动应用".into(),
        );
    }
    Ok(cache.connections.clone())
}

fn prefer_port(executable: &str, port: u16) {
    if let Ok(mut guard) = DISCOVERY.get_or_init(|| Mutex::new(None)).lock() {
        if let Some(cache) = guard.as_mut() {
            for c in &mut cache.connections {
                if c.executable == executable {
                    c.ports.sort_by_key(|p| *p != port);
                }
            }
        }
    }
}

fn certificate_path(executable: &Path) -> Option<PathBuf> {
    let bin = executable.parent()?;
    let extension = bin.parent()?;
    let certificate = extension.join("dist/languageServer/cert.pem");
    certificate.is_file().then_some(certificate)
}

fn client(connection: &Connection) -> Result<Client, String> {
    client_with_expired_loopback_certificate(connection, false)
}

fn client_with_expired_loopback_certificate(
    connection: &Connection,
    expired: bool,
) -> Result<Client, String> {
    let mut builder = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_millis(1500));
    if let Some(path) = certificate_path(Path::new(&connection.executable)) {
        let pem = std::fs::read(path).map_err(|_| "无法读取 Antigravity 安装证书")?;
        let certificate =
            reqwest::Certificate::from_pem(&pem).map_err(|_| "Antigravity 安装证书格式无效")?;
        builder = builder.add_root_certificate(certificate);
        if expired {
            // IDE 1.23.2 bundles a cert that expired 2026-09-04. Only post()'s
            // fixed, owned loopback endpoint may retry an Expired TLS failure.
            builder = builder.danger_accept_invalid_certs(true);
        }
    } else {
        // App 2.23.1 uses a self-signed loopback certificate too. This client has no
        // arbitrary-URL API: post() fixes 127.0.0.1 and disables all redirects.
        builder = builder.danger_accept_invalid_certs(true);
    }
    builder
        .build()
        .map_err(|_| "无法创建 Antigravity 本机只读客户端".into())
}

fn expired_certificate(error: &reqwest::Error) -> bool {
    let mut source = std::error::Error::source(error);
    while let Some(error) = source {
        if error
            .to_string()
            .contains("invalid peer certificate: Expired")
        {
            return true;
        }
        source = error.source();
    }
    false
}

fn post(
    client: &Client,
    connection: &Connection,
    port: u16,
    method: &str,
    body: Value,
) -> Result<Value, String> {
    let endpoint = format!("https://127.0.0.1:{port}/{SERVICE}/{method}");
    let request_deadline = Instant::now() + Duration::from_millis(1500);
    let send = |client: &Client| {
        client
            .post(&endpoint)
            .timeout(
                request_deadline
                    .saturating_duration_since(Instant::now())
                    .max(Duration::from_millis(1)),
            )
            .header("x-codeium-csrf-token", &connection.csrf)
            .header("Connect-Protocol-Version", "1")
            .json(&body)
            .send()
    };
    let response = match send(client) {
        Err(error) if expired_certificate(&error) => {
            send(&client_with_expired_loopback_certificate(connection, true)?)
        }
        result => result,
    }
    .map_err(|_| "Antigravity 本机 LS 只读请求失败（未验证兼容性或连接已失效）")?;
    if !response.status().is_success() {
        return Err(format!(
            "Antigravity 本机 LS {method} 返回 HTTP {}",
            response.status().as_u16()
        ));
    }
    let mut bytes = Vec::new();
    response
        .take(RESPONSE_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Antigravity LS metadata 读取失败")?;
    if bytes.len() as u64 > RESPONSE_LIMIT {
        return Err("Antigravity LS metadata 超过单页大小限制".into());
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "Antigravity LS metadata 不是兼容的 JSON 响应".into())
}

fn text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn timestamp(value: &Value) -> Option<i64> {
    value
        .as_str()
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.timestamp_millis())
}

fn duration(value: &Value) -> Option<i64> {
    let seconds = value.as_str()?.strip_suffix('s')?.parse::<f64>().ok()?;
    (seconds.is_finite() && seconds >= 0.0 && seconds <= i64::MAX as f64 / 1000.0)
        .then_some((seconds * 1000.0).round() as i64)
}

fn tokens(value: &Value, key: &str) -> Result<Option<i64>, String> {
    let Some(value) = value.get(key) else {
        // ModelUsageStats uses nonoptional proto3 uint64 fields: JSON omits zero.
        return Ok(Some(0));
    };
    let n = value
        .as_i64()
        .or_else(|| value.as_str().and_then(|v| v.parse().ok()));
    n.filter(|n| *n >= 0)
        .map(Some)
        .ok_or_else(|| format!("Antigravity LS {key} 不是非负 token 整数"))
}

fn session_id(namespace: &str, id: &str) -> String {
    format!("{namespace}:{id}")
}

fn active(summary: &Value) -> bool {
    matches!(
        summary["status"].as_str(),
        Some(
            "CASCADE_RUN_STATUS_RUNNING"
                | "CASCADE_RUN_STATUS_BUSY"
                | "CASCADE_RUN_STATUS_CANCELING"
        )
    ) || matches!(summary["status"].as_i64(), Some(2..=4))
}

fn session(namespace: &str, id: &str, summary: &Value) -> SessionMeta {
    let metadata = &summary["trajectoryMetadata"];
    SessionMeta {
        tool: "antigravity".into(),
        id: session_id(namespace, id),
        parent_id: text(metadata, "parentConversationId").map(|id| session_id(namespace, &id)),
        root_id: text(metadata, "rootConversationId").map(|id| session_id(namespace, &id)),
        project: metadata["workspaceUris"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(Value::as_str)
            .map(str::to_owned),
        model: None,
        status: if active(summary) {
            "active"
        } else if summary["status"].as_str() == Some("CASCADE_RUN_STATUS_IDLE")
            || summary["status"].as_i64() == Some(1)
        {
            "idle"
        } else {
            "unknown"
        }
        .into(),
        started_at_ms: timestamp(&summary["createdTime"])
            .or_else(|| timestamp(&metadata["createdAt"]))
            .unwrap_or(0),
        updated_at_ms: timestamp(&summary["lastModifiedTime"]).unwrap_or(0),
        ..Default::default()
    }
}

fn parse_metadata(
    namespace: &str,
    id: &str,
    index: u64,
    summary: &Value,
    metadata: &Value,
) -> Result<ParsedLine, String> {
    let mut session = session(namespace, id, summary);
    let chat = &metadata["chatModel"];
    let Some(usage) = chat.get("usage").filter(|u| u.is_object()) else {
        return Ok(ParsedLine {
            session: Some(session),
            ..Default::default()
        });
    };
    let input = tokens(usage, "inputTokens")?;
    let output = tokens(usage, "outputTokens")?;
    let read = tokens(usage, "cacheReadTokens")?;
    let write = tokens(usage, "cacheWriteTokens")?;
    let reasoning = tokens(usage, "thinkingOutputTokens")?;
    let cached = read
        .unwrap_or(0)
        .checked_add(write.unwrap_or(0))
        .ok_or("Antigravity cache token 溢出")?;
    let mut unknown = Vec::new();
    // The installed schema/UI does not establish whether inputTokens includes cache.
    // max(raw input, cache) is a lower bound under either convention, never their sum.
    if input.is_none() || cached > 0 {
        unknown.push("input_tokens".into());
    }
    for (field, value) in [
        ("output_tokens", output),
        ("cache_read_tokens", read),
        ("cache_write_tokens", write),
    ] {
        if value.is_none() {
            unknown.push(field.into());
        }
    }
    let output_lower_bound = output.unwrap_or(0).max(reasoning.unwrap_or(0));
    if reasoning.is_some_and(|n| output.is_some_and(|o| n > o))
        && !unknown.iter().any(|f| f == "output_tokens")
    {
        unknown.push("output_tokens".into());
    }
    // responseModel is the provider-reported string, not a requested enum/alias.
    let model = text(chat, "responseModel");
    session.model = model.clone();
    let started_at_ms = timestamp(&chat["chatStartMetadata"]["createdAt"]);
    let ttft_ms = duration(&chat["timeToFirstToken"]);
    let streaming_duration_ms = duration(&chat["streamingDuration"]);
    let duration_ms = ttft_ms
        .zip(streaming_duration_ms)
        .and_then(|(first, stream)| first.checked_add(stream));
    let record = UsageRecord {
        id: format!("antigravity:{}:generator:{index}", session.id),
        tool: "antigravity".into(),
        session_id: session.id.clone(),
        turn_id: text(metadata, "executionId").unwrap_or_else(|| format!("generator:{index}")),
        request_id: text(usage, "providerAssignedMessageId")
            .or_else(|| text(usage, "responseId"))
            .or_else(|| text(usage, "messageId")),
        timestamp_ms: started_at_ms.unwrap_or(0),
        model,
        model_basis: "antigravity_ls.chatModel.responseModel".into(),
        mode: None,
        mode_basis: "unknown: LS metadata has no actual service mode".into(),
        input_tokens: input.unwrap_or(0).max(cached),
        source_input_tokens: input,
        output_tokens: output_lower_bound,
        cache_read_tokens: read.unwrap_or(0),
        cache_write_tokens: write.unwrap_or(0),
        reasoning_tokens: reasoning,
        duration_ms,
        request_timing: Some(RequestTiming {
            started_at_ms,
            ttft_ms,
            streaming_duration_ms,
            duration_ms,
            // No independently observed completion timestamp is present in this metadata.
            completed_at_ms: None,
            basis: "antigravity_ls.chatModel".into(),
        }),
        // Do not use a convention-unknown input count to classify long-context prices.
        context_tokens: (cached == 0).then_some(input).flatten(),
        usage_basis:
            "antigravity_ls.generatorMetadata.chatModel.usage; input/cache convention unverified; duration=TTFT+streamingDuration when both reported"
                .into(),
        unknown_fields: unknown,
        ..Default::default()
    };
    Ok(ParsedLine {
        session: Some(session),
        usage: vec![record],
        ..Default::default()
    })
}

fn page_offset(cursor: &Value) -> u64 {
    let previous = cursor["offset"].as_u64().unwrap_or(0);
    if cursor["more"].as_bool().unwrap_or(false) {
        previous
    } else {
        previous.saturating_sub(2)
    }
}

fn needs_refresh(summary: &Value, cursor: &Value) -> bool {
    active(summary)
        || cursor["modified"].as_str() != Some(summary["lastModifiedTime"].as_str().unwrap_or(""))
        || cursor["more"].as_bool().unwrap_or(false)
}

fn parse_page(
    namespace: &str,
    id: &str,
    summary: &Value,
    page: &Value,
    cursor: &mut Value,
) -> Result<Vec<ParsedLine>, String> {
    let previous = cursor["offset"].as_u64().unwrap_or(0);
    let offset = page_offset(cursor);
    let modified = summary["lastModifiedTime"].as_str().unwrap_or("");
    let rows = match page.get("generatorMetadata") {
        Some(Value::Array(rows)) => rows.as_slice(),
        None if page.is_object() => &[], // Proto3 JSON omits empty repeated fields.
        _ => return Err("Antigravity generatorMetadata 格式无效".into()),
    };
    if rows.is_empty() {
        *cursor = json!({"offset": previous, "modified": modified, "more": false});
        return Ok(vec![ParsedLine {
            session: Some(session(namespace, id, summary)),
            ..Default::default()
        }]);
    }
    let mut results = Vec::new();
    let mut next = offset;
    let mut pending = None;
    for (n, row) in rows.iter().take(PAGE_LIMIT).enumerate() {
        let parsed = parse_metadata(namespace, id, offset + n as u64, summary, row)?;
        if parsed.usage.is_empty() && text(row, "error").is_none() {
            pending.get_or_insert(offset + n as u64);
        }
        results.push(parsed);
        next = offset + n as u64 + 1;
    }
    *cursor = json!({"offset": pending.unwrap_or(next), "modified": modified, "more": true});
    Ok(results)
}

/// Bounded background continuation. Caller must atomically persist records and state together.
pub fn collect(state: &mut Value) -> Result<Vec<ParsedLine>, String> {
    let connections = connections()?;
    if !state.is_object() {
        *state = json!({});
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut results = Vec::new();
    let mut errors = Vec::new();
    let mut namespaces = std::collections::HashSet::new();
    for connection in connections {
        if Instant::now() >= deadline {
            break;
        }
        if namespaces.contains(&connection.namespace) {
            continue;
        }
        let client = match client(&connection) {
            Ok(c) => c,
            Err(e) => {
                errors.push(e);
                continue;
            }
        };
        let mut found = None;
        for port in &connection.ports {
            if Instant::now() >= deadline {
                break;
            }
            if let Ok(list) = post(
                &client,
                &connection,
                *port,
                "GetAllCascadeTrajectories",
                json!({"excludeSubtrajectories": false}),
            ) {
                if let Some(summaries) = list["trajectorySummaries"].as_object() {
                    found = Some((*port, summaries.clone()));
                    break;
                }
                if list.is_object() && list.get("trajectorySummaries").is_none() {
                    found = Some((*port, serde_json::Map::new()));
                    break;
                }
            }
        }
        let Some((port, summaries)) = found else {
            errors.push(
                "Antigravity 已运行但全局会话只读协议不可用（App / IDE 版本兼容性未确认）".into(),
            );
            continue;
        };
        namespaces.insert(connection.namespace.clone());
        prefer_port(&connection.executable, port);
        let source_state = &mut state["sources"][&connection.namespace];
        if !source_state.is_object() {
            *source_state = json!({"sessions": {}, "next": 0});
        }
        let summaries: BTreeMap<_, _> = summaries.into_iter().collect();
        let entries: Vec<_> = summaries.iter().collect();
        let start = source_state["next"].as_u64().unwrap_or(0) as usize;
        let mut visited = 0;
        for step in 0..entries.len() {
            if visited >= SESSION_LIMIT || Instant::now() >= deadline {
                break;
            }
            let position = (start + step) % entries.len();
            let (id, summary) = entries[position];
            source_state["next"] = json!((position + 1) % entries.len());
            let cursor = &mut source_state["sessions"][id.as_str()];
            if !needs_refresh(summary, cursor) {
                continue;
            }
            visited += 1;
            let offset = page_offset(cursor);
            let page = match post(
                &client,
                &connection,
                port,
                "GetCascadeTrajectoryGeneratorMetadata",
                json!({"cascadeId": id, "generatorMetadataOffset": offset, "includeMessages": false}),
            ) {
                Ok(v) => v,
                Err(e) => {
                    errors.push(e);
                    continue;
                }
            };
            match parse_page(&connection.namespace, id, summary, &page, cursor) {
                Ok(lines) => results.extend(lines),
                Err(e) => errors.push(e),
            }
        }
    }
    state["lastError"] = if errors.is_empty() {
        Value::Null
    } else {
        json!(errors.join("；"))
    };
    if results.is_empty() && !errors.is_empty() {
        return Err(errors.join("；"));
    }
    Ok(results)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata() -> Value {
        json!({"executionId":"turn-1","chatModel":{"responseModel":"gemini-2.5-pro","chatStartMetadata":{"createdAt":"2026-10-16T00:00:00Z"},"timeToFirstToken":"0.250s","streamingDuration":"1.250s","usage":{"inputTokens":"100","outputTokens":"20","cacheReadTokens":"80","cacheWriteTokens":"0","thinkingOutputTokens":"5","responseId":"response-1"}}})
    }

    #[test]
    fn rate_duration_requires_both_reported_timing_components() {
        let mut row = metadata();
        row["chatModel"]["streamingDuration"] = json!("120s");
        let summary = json!({});
        let complete = parse_metadata("native", "session", 0, &summary, &row).unwrap();
        assert_eq!(complete.usage[0].duration_ms, Some(120_250));
        row["chatModel"]
            .as_object_mut()
            .unwrap()
            .remove("timeToFirstToken");
        let incomplete = parse_metadata("native", "session", 0, &summary, &row).unwrap();
        assert_eq!(incomplete.usage[0].duration_ms, None);
        assert_eq!(
            incomplete.usage[0].timestamp_ms,
            complete.usage[0].timestamp_ms
        );
        let timing = incomplete.usage[0].request_timing.as_ref().unwrap();
        assert_eq!(
            (
                timing.ttft_ms,
                timing.streaming_duration_ms,
                timing.duration_ms
            ),
            (None, Some(120_000), None)
        );
        assert!(timing.completed_at_ms.is_none());
    }

    #[test]
    fn metadata_has_stable_identity_actual_model_and_cache_lower_bound() {
        let summary = json!({"trajectoryMetadata":{"parentConversationId":"parent","rootConversationId":"root"}});
        let line = parse_metadata("antigravity-ide", "s", 3, &summary, &metadata()).unwrap();
        let usage = &line.usage[0];
        assert_eq!(usage.id, "antigravity:antigravity-ide:s:generator:3");
        assert_eq!(usage.model.as_deref(), Some("gemini-2.5-pro"));
        assert_eq!(usage.turn_id, "turn-1");
        assert_eq!(usage.duration_ms, Some(1500));
        let timing = usage.request_timing.as_ref().unwrap();
        assert_eq!(
            (
                timing.ttft_ms,
                timing.streaming_duration_ms,
                timing.duration_ms
            ),
            (Some(250), Some(1250), Some(1500))
        );
        assert_eq!(timing.started_at_ms, Some(usage.timestamp_ms));
        assert!(timing.completed_at_ms.is_none());
        assert_eq!(timing.basis, "antigravity_ls.chatModel");
        assert_eq!(usage.input_tokens, 100);
        assert!(usage.unknown_fields.contains(&"input_tokens".into()));
        assert!(usage.mode.is_none());
        assert!(usage.context_tokens.is_none());
        let session = line.session.unwrap();
        assert_eq!(session.parent_id.as_deref(), Some("antigravity-ide:parent"));
        assert_eq!(session.root_id.as_deref(), Some("antigravity-ide:root"));
    }

    #[test]
    fn no_usage_yet_does_not_fabricate_a_request() {
        let line = parse_metadata(
            "antigravity",
            "s",
            0,
            &json!({}),
            &json!({"chatModel":{"responseModel":"gemini"}}),
        )
        .unwrap();
        assert!(line.usage.is_empty());
    }

    #[test]
    fn requested_enum_does_not_become_actual_model_or_mode() {
        let value = json!({"chatModel":{"model":"MODEL_GOOGLE_GEMINI_2_5_PRO","usage":{"inputTokens":"5","outputTokens":"0","cacheReadTokens":"0","cacheWriteTokens":"0"}}});
        let line = parse_metadata("antigravity", "s", 0, &json!({}), &value).unwrap();
        assert!(line.usage[0].model.is_none());
        assert!(line.usage[0].mode.is_none());
        assert!(line.usage[0].unknown_fields.is_empty());
    }

    #[test]
    fn proto3_default_zero_and_invalid_counts_are_distinguished() {
        let line = parse_metadata(
            "antigravity",
            "s",
            0,
            &json!({}),
            &json!({"chatModel":{"usage":{"cacheReadTokens":"10"}}}),
        )
        .unwrap();
        assert_eq!(line.usage[0].input_tokens, 10);
        assert_eq!(line.usage[0].output_tokens, 0);
        assert!(line.usage[0]
            .unknown_fields
            .contains(&"input_tokens".into()));
        assert!(!line.usage[0]
            .unknown_fields
            .contains(&"output_tokens".into()));
        let mut bad = metadata();
        bad["chatModel"]["usage"]["inputTokens"] = json!("18446744073709551615");
        assert!(parse_metadata("antigravity", "s", 0, &json!({}), &bad).is_err());
    }

    #[test]
    fn token_update_overwrites_the_same_generator_identity() {
        let first = parse_metadata("antigravity", "s", 4, &json!({}), &metadata()).unwrap();
        let mut final_metadata = metadata();
        final_metadata["chatModel"]["usage"]["outputTokens"] = json!("40");
        let final_line =
            parse_metadata("antigravity", "s", 4, &json!({}), &final_metadata).unwrap();
        assert_eq!(first.usage[0].id, final_line.usage[0].id);
        assert_eq!(final_line.usage[0].output_tokens, 40);
    }

    #[test]
    fn only_packaged_ide_certificate_path_is_used() {
        assert!(certificate_path(Path::new("not-an-installation.exe")).is_none());
        assert_eq!(duration(&json!("-1s")), None);
        assert_eq!(duration(&json!("NaNs")), None);
    }

    #[test]
    fn pages_continue_then_unchanged_idle_sessions_are_skipped() {
        let summary =
            json!({"lastModifiedTime":"2026-10-16T00:00:00Z","status":"CASCADE_RUN_STATUS_IDLE"});
        let mut cursor = Value::Null;
        assert!(needs_refresh(&summary, &cursor));
        parse_page(
            "antigravity",
            "s",
            &summary,
            &json!({"generatorMetadata":[metadata(), metadata()]}),
            &mut cursor,
        )
        .unwrap();
        assert_eq!(page_offset(&cursor), 2);
        parse_page("antigravity", "s", &summary, &json!({}), &mut cursor).unwrap();
        assert!(!needs_refresh(&summary, &cursor));
        let changed = json!({"lastModifiedTime":"2026-10-16T00:01:00Z","status":"CASCADE_RUN_STATUS_RUNNING"});
        assert!(needs_refresh(&changed, &cursor));
        assert_eq!(page_offset(&cursor), 0);
    }

    #[test]
    fn unfinished_usage_is_reread_and_page_failures_do_not_advance() {
        let summary = json!({});
        let mut cursor = Value::Null;
        parse_page(
            "antigravity",
            "s",
            &summary,
            &json!({"generatorMetadata":[metadata(), {"executionId":"pending"}]}),
            &mut cursor,
        )
        .unwrap();
        assert_eq!(page_offset(&cursor), 1);
        let old = cursor.clone();
        assert!(parse_page(
            "antigravity",
            "s",
            &summary,
            &json!({"generatorMetadata":"invalid"}),
            &mut cursor
        )
        .is_err());
        assert_eq!(cursor, old);
        let page = json!({"generatorMetadata":[metadata()]});
        let result = parse_page("antigravity", "s", &summary, &page, &mut cursor).unwrap();
        assert!(result[0].usage[0].id.ends_with("generator:1"));
        assert_eq!(page_offset(&cursor), 2);
    }

    #[test]
    fn large_page_is_bounded_without_skipping_unprocessed_metadata() {
        let mut cursor = Value::Null;
        let rows: Vec<_> = (0..PAGE_LIMIT + 10).map(|_| metadata()).collect();
        let result = parse_page(
            "antigravity",
            "s",
            &json!({}),
            &json!({"generatorMetadata":rows}),
            &mut cursor,
        )
        .unwrap();
        assert_eq!(result.len(), PAGE_LIMIT);
        assert_eq!(page_offset(&cursor), PAGE_LIMIT as u64);
    }
}
