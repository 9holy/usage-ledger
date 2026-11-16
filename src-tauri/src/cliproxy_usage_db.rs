use rusqlite::{params, types::ValueRef, Connection, OpenFlags};
use serde_json::{json, Map, Number, Value};
use std::{path::{Component, Path, PathBuf}, time::Duration};

/// The plugin resolves relative overrides against its own process cwd. The desktop
/// reader has no evidence of that cwd, so it must not silently choose its own.
pub fn absolute_override(value: &str, variable: &str) -> Result<PathBuf, String> {
    let path = Path::new(value.trim());
    if !path.is_absolute() {
        return Err(format!("{variable} must be an absolute path; the CPA producer working directory is unknown"));
    }
    // Match filepath.Clean: remove lexical '.'/'..' before reading, without creating files.
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => { clean.pop(); }
            other => clean.push(other.as_os_str()),
        }
    }
    Ok(clean)
}

pub fn plugin_data_dir(home: Option<&str>, override_dir: Option<&str>) -> Result<PathBuf, String> {
    if let Some(value) = override_dir.filter(|value| !value.trim().is_empty()) {
        return absolute_override(value, "CPA_TOKEN_USAGE_DIR");
    }
    let home = home.filter(|value| !value.trim().is_empty()).ok_or("Cannot locate CPA user home directory")?;
    Ok(absolute_override(home, "CPA user home")?.join(".cli-proxy-api").join("plugins").join("codex-token-usage"))
}

pub fn source_instance_id(directory: &Path, home: Option<&str>) -> Result<String, String> {
    // Resolve existing parents even when the final directory does not exist.
    // Raw-path fallback would change identity after creation, especially through
    // parent aliases and Windows extended-length canonical paths. Broken aliases
    // are read errors; they cannot establish an empty source or a default scope.
    let identity = crate::ledger_db::resolved_path_for_ownership(directory)
        .map_err(|error| error.to_string())?;
    let identity_bytes = |path: &Path| {
        if cfg!(windows) {
            path.to_string_lossy().replace('\\', "/").to_ascii_lowercase().into_bytes()
        } else {
            path.as_os_str().as_encoded_bytes().to_vec()
        }
    };
    let default = plugin_data_dir(home, None).ok()
        .and_then(|path| crate::ledger_db::resolved_path_for_ownership(&path).ok());
    if default.as_ref().is_some_and(|path| identity_bytes(path) == identity_bytes(&identity)) {
        return Ok("local".into());
    }
    // Namespace only, not a security or ownership proof. Do not expose local paths to the UI.
    Ok(format!("path-{:x}", md5::compute(identity_bytes(&identity))))
}

pub fn attach_source_identity(raw: &str, with_metadata: bool, instance: &str) -> Result<String, String> {
    let mut value: Value = serde_json::from_str(raw).map_err(|error| error.to_string())?;
    let events = if with_metadata {
        let snapshot = value.as_object_mut().ok_or("Invalid CPA usage metadata")?;
        snapshot.insert("sourceInstanceId".into(), Value::String(instance.into()));
        snapshot.insert("managementLinkAllowed".into(), Value::Bool(instance == "local"));
        snapshot.get_mut("events").and_then(Value::as_array_mut)
    } else {
        value.as_array_mut()
    }.ok_or("Invalid CPA usage event array")?;
    for event in events {
        event.as_object_mut().ok_or("Invalid CPA usage event")?
            .insert("source_instance_id".into(), Value::String(instance.into()));
    }
    Ok(value.to_string())
}

pub fn read_usage_events(
    path: &Path,
    with_metadata: bool,
    start_ms: Option<i64>,
    end_ms: Option<i64>,
) -> Result<String, String> {
    match (start_ms, end_ms) {
        (None, None) => {}
        (Some(start), Some(end)) if start < end => {}
        _ => return Err("startMs/endMs must be supplied together with startMs < endMs".into()),
    }
    match std::fs::metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(if with_metadata {
                json!({"available":false,"events":[],"readStartMs":null,"readEndMs":null})
                    .to_string()
            } else {
                "[]".into()
            });
        }
        Err(error) => return Err(format!("Cannot inspect CPA usage database: {error}")),
        Ok(_) => {}
    }
    let read = || -> Result<Value, String> {
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|error| error.to_string())?;
        conn.pragma_update(None, "query_only", true)
            .map_err(|error| error.to_string())?;
        conn.busy_timeout(Duration::from_secs(5))
            .map_err(|error| error.to_string())?;
        let mut columns = conn
            .prepare("PRAGMA table_info(usage_events)")
            .map_err(|error| error.to_string())?;
        let names = columns
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|error| error.to_string())?;
        let mut response_tier_column = "NULL AS response_service_tier";
        let mut optional=Vec::new();
        for name in names {
            let name=name.map_err(|error| error.to_string())?;
            if name == "response_service_tier" {
                response_tier_column = "response_service_tier";
            }
            if matches!(name.as_str(),"id"|"request_id"|"response_id"|"session_id"|"official_account_id") {optional.push(name);}
        }
        let extra=if optional.is_empty(){String::new()}else{format!(", {}",optional.join(", "))};
        let id_order = if optional.iter().any(|name| name == "id") { ", id DESC" } else { "" };
        let sql = format!(
            "SELECT requested_at, provider, executor_type, model, alias, auth_index, auth_type, \
             source, reasoning_effort, service_tier, {response_tier_column}, latency_ms, ttft_ms, failed, status_code, \
             input_tokens, output_tokens, reasoning_tokens, cached_tokens, cache_read_tokens, \
             cache_creation_tokens, total_tokens, primary_used_percent, primary_reset_at, \
             primary_used_tokens, primary_remaining_tokens, primary_limit_tokens, \
             secondary_used_percent, secondary_reset_at, secondary_used_tokens, \
             secondary_remaining_tokens, secondary_limit_tokens{extra} \
             FROM usage_events WHERE requested_at >= ?1 AND requested_at < ?2 ORDER BY requested_at DESC{id_order}"
        );
        let end = end_ms.unwrap_or_else(crate::ledger_db::now_ms);
        let start = start_ms.unwrap_or_else(|| end - 30 * 86_400_000);
        let mut statement = conn.prepare(&sql).map_err(|error| error.to_string())?;
        let names: Vec<_> = statement
            .column_names()
            .into_iter()
            .map(str::to_owned)
            .collect();
        let mut rows = statement
            .query(params![start as f64 / 1000., end as f64 / 1000.])
            .map_err(|error| error.to_string())?;
        let mut events = Vec::new();
        while let Some(row) = rows.next().map_err(|error| error.to_string())? {
            let mut event = Map::new();
            for (index, name) in names.iter().enumerate() {
                let value = row.get_ref(index).map_err(|error| error.to_string())?;
                let value = if name == "failed" {
                    Value::Bool(match value {
                        ValueRef::Null => false,
                        ValueRef::Integer(value) => value != 0,
                        ValueRef::Real(value) => value != 0.,
                        ValueRef::Text(value) => !value.is_empty(),
                        ValueRef::Blob(_) => return Err("Unexpected binary CPA usage field".into()),
                    })
                } else {
                    match value {
                        ValueRef::Null => Value::Null,
                        ValueRef::Integer(value) => Value::from(if name == "requested_at" {
                            value
                                .checked_mul(1000)
                                .ok_or("CPA usage timestamp exceeds supported range")?
                        } else {
                            value
                        }),
                        ValueRef::Real(value) => Value::Number(
                            Number::from_f64(if name == "requested_at" {
                                value * 1000.
                            } else {
                                value
                            })
                            .ok_or("Non-finite CPA usage number")?,
                        ),
                        ValueRef::Text(value) => Value::String(
                            std::str::from_utf8(value)
                                .map_err(|_| "Invalid UTF-8 CPA usage field")?
                                .into(),
                        ),
                        ValueRef::Blob(_) => return Err("Unexpected binary CPA usage field".into()),
                    }
                };
                event.insert(name.clone(), value);
            }
            events.push(Value::Object(event));
        }
        Ok(if with_metadata {
            json!({"available":true,"events":events,"readStartMs":start,"readEndMs":end})
        } else {
            Value::Array(events)
        })
    };
    read()
        .map(|value| value.to_string())
        .map_err(|error| format!("Cannot read CPA usage database: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "cpa usage # ' \u{7528}\u{91cf} {}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&root).unwrap();
            Self(root)
        }

        fn path(&self) -> PathBuf {
            self.0.join("usage.db")
        }

        fn database(&self) -> Connection {
            let conn = Connection::open(self.path()).unwrap();
            conn.execute_batch(
                "CREATE TABLE usage_events(
                requested_at, provider, executor_type, model, alias, auth_index, auth_type,
                source, reasoning_effort, service_tier, latency_ms, ttft_ms, failed, status_code,
                input_tokens, output_tokens, reasoning_tokens, cached_tokens, cache_read_tokens,
                cache_creation_tokens, total_tokens, primary_used_percent, primary_reset_at,
                primary_used_tokens, primary_remaining_tokens, primary_limit_tokens,
                secondary_used_percent, secondary_reset_at, secondary_used_tokens,
                secondary_remaining_tokens, secondary_limit_tokens, api_key
            )",
            )
            .unwrap();
            conn
        }

        fn read(&self, metadata: bool, start: i64, end: i64) -> Value {
            serde_json::from_str(
                &read_usage_events(&self.path(), metadata, Some(start), Some(end)).unwrap(),
            )
            .unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn preserves_native_values_bounds_order_and_optional_response_tier_without_secrets() {
        let fixture = Fixture::new();
        let conn = fixture.database();
        for (timestamp, failed) in [(0., 1), (1., 0), (1.5, 2), (2., 1)] {
            conn.execute("INSERT INTO usage_events(requested_at,provider,service_tier,failed,input_tokens,primary_used_percent,api_key) VALUES(?1,'provider','priority',?2,0,0.25,'private-api-key')", params![timestamp,failed]).unwrap();
        }
        let report = fixture.read(true, 1000, 2000);
        assert_eq!(report["available"], true);
        assert_eq!(report["readStartMs"], 1000);
        assert_eq!(report["readEndMs"], 2000);
        let events = report["events"].as_array().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["requested_at"], 1500.);
        assert_eq!(events[1]["requested_at"], 1000.);
        assert_eq!(events[0]["failed"], true);
        assert_eq!(events[1]["failed"], false);
        assert_eq!(events[0]["input_tokens"], 0);
        assert_eq!(events[0]["primary_used_percent"], 0.25);
        assert!(events[0]["output_tokens"].is_null());
        assert!(events[0]["response_service_tier"].is_null());
        assert_eq!(events[0]["service_tier"], "priority");
        assert_eq!(events[0].as_object().unwrap().len(), 32);
        assert!(!report.to_string().contains("api_key"));
        assert!(!report.to_string().contains("private-api-key"));
        conn.execute_batch("ALTER TABLE usage_events ADD COLUMN response_service_tier; UPDATE usage_events SET response_service_tier='default'").unwrap();
        assert_eq!(
            fixture.read(false, 1000, 2000)[0]["response_service_tier"],
            "default"
        );
        conn.execute_batch("ALTER TABLE usage_events ADD COLUMN session_id; ALTER TABLE usage_events ADD COLUMN response_id;
          UPDATE usage_events SET session_id='shared-session',response_id='provider-response'").unwrap();
        let correlated=fixture.read(false,1000,2000);
        assert_eq!(correlated[0]["session_id"],"shared-session");
        assert_eq!(correlated[0]["response_id"],"provider-response");
        assert_eq!(
            conn.query_row("SELECT api_key FROM usage_events LIMIT 1", [], |row| row
                .get::<_, String>(
                0
            ))
            .unwrap(),
            "private-api-key"
        );
    }

    #[test]
    fn exact_millisecond_bounds_match_sql_and_metadata() {
        let fixture = Fixture::new();
        let conn = fixture.database();
        conn.execute_batch("INSERT INTO usage_events(requested_at) VALUES(10),(11),(12)")
            .unwrap();
        for (start, end, expected) in [(10_000, 11_000, 10_000), (10_001, 11_001, 11_000)] {
            let result = fixture.read(true, start, end);
            assert_eq!(result["available"], true);
            assert_eq!(result["readStartMs"], start);
            assert_eq!(result["readEndMs"], end);
            let events = result["events"].as_array().unwrap();
            assert_eq!(events.len(), 1);
            assert_eq!(events[0]["requested_at"], expected);
        }
    }

    #[test]
    fn preserves_integer_timestamps_null_failed_and_default_window() {
        let fixture = Fixture::new();
        let conn = fixture.database();
        conn.execute_batch("INSERT INTO usage_events(requested_at,failed) VALUES(1,NULL)")
            .unwrap();
        assert_eq!(fixture.read(false, 1000, 2000)[0]["requested_at"], 1000);
        assert_eq!(fixture.read(false, 1000, 2000)[0]["failed"], false);
        let before = crate::ledger_db::now_ms();
        let result: Value =
            serde_json::from_str(&read_usage_events(&fixture.path(), true, None, None).unwrap())
                .unwrap();
        let after = crate::ledger_db::now_ms();
        let end = result["readEndMs"].as_i64().unwrap();
        assert!((before..=after).contains(&end));
        assert_eq!(result["readStartMs"], end - 30 * 86_400_000);
        assert_eq!(result["events"], json!([]));
        assert_eq!(
            read_usage_events(&fixture.path(), false, None, None).unwrap(),
            "[]"
        );
    }

    #[test]
    fn missing_database_is_unavailable_without_creating_it_and_invalid_bounds_fail_first() {
        let fixture = Fixture::new();
        assert_eq!(fixture.read(false, 0, 1), json!([]));
        assert_eq!(
            fixture.read(true, 0, 1),
            json!({"available":false,"events":[],"readStartMs":null,"readEndMs":null})
        );
        assert!(!fixture.path().exists());
        for (start, end) in [
            (Some(1), None),
            (None, Some(2)),
            (Some(2), Some(2)),
            (Some(3), Some(2)),
        ] {
            assert_eq!(
                read_usage_events(&fixture.path(), false, start, end).unwrap_err(),
                "startMs/endMs must be supplied together with startMs < endMs"
            );
        }
    }

    #[test]
    fn malformed_database_missing_table_and_binary_fields_are_errors_not_empty_results() {
        let fixture = Fixture::new();
        std::fs::write(fixture.path(), b"not sqlite").unwrap();
        assert!(read_usage_events(&fixture.path(), false, Some(0), Some(2000)).is_err());
        std::fs::remove_file(fixture.path()).unwrap();
        drop(Connection::open(fixture.path()).unwrap());
        assert!(read_usage_events(&fixture.path(), false, Some(0), Some(2000)).is_err());
        let conn = fixture.database();
        conn.execute_batch("INSERT INTO usage_events(requested_at,provider) VALUES(1,x'0102')")
            .unwrap();
        assert!(
            read_usage_events(&fixture.path(), false, Some(0), Some(2000))
                .unwrap_err()
                .contains("Unexpected binary")
        );
    }

    #[cfg(unix)]
    #[test]
    fn double_quotes_in_database_paths_are_literal() {
        let fixture = Fixture::new();
        drop(fixture.database());
        let path = fixture.0.join("usage\"quoted.db");
        std::fs::rename(fixture.path(), &path).unwrap();
        assert_eq!(
            read_usage_events(&path, false, Some(0), Some(2000)).unwrap(),
            "[]"
        );
    }

    #[test]
    fn contract_audit_cpa_equal_second_records_preserve_durable_id_order() {
        let fixture = Fixture::new();
        let conn = fixture.database();
        conn.execute_batch("ALTER TABLE usage_events ADD COLUMN id INTEGER;
          INSERT INTO usage_events(id,requested_at,auth_index,primary_used_percent) VALUES(10,1,'same-slot',5),(11,1,'same-slot',25)").unwrap();
        let report = fixture.read(true, 0, 2000);
        let events = report["events"].as_array().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["id"], 11);
        assert_eq!(events[0]["primary_used_percent"], 25);
        assert_eq!(events[1]["id"], 10);
        assert_eq!(events[1]["primary_used_percent"], 5);
        assert!(!report.to_string().contains("api_key"));
    }
}
