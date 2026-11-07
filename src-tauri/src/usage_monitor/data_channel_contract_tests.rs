//! Cross-module regressions derived from Cockpit's persisted data contracts.
//! Upstream: jlcodes99/cockpit-tools @ 820e176842d440a60e650729c3a39932b76a0ccb.

use std::path::{Path, PathBuf};

struct Fixture {
    root: PathBuf,
    _environment: Vec<crate::EnvGuard>,
}

impl Fixture {
    fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "ledger-data-contract-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let mut environment = vec![crate::EnvGuard::set("USERPROFILE", &root)];
        for key in ["COCKPIT_TOOLS_DATA_DIR", "COCKPIT_TOOLS_PROFILE", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "DSH_HOME"] {
            environment.push(crate::EnvGuard::remove(key));
        }
        Self { root, _environment: environment }
    }

    fn registry(&self, directory: &Path, value: serde_json::Value) {
        std::fs::create_dir_all(directory).unwrap();
        std::fs::write(directory.join("codex_instances.json"), serde_json::to_vec(&value).unwrap()).unwrap();
    }

    fn has_codex_home(sources: &[super::collector::SourceRoot], home: &Path) -> bool {
        ["sessions", "archived_sessions"].iter().all(|suffix| {
            sources.iter().any(|source| source.tool == "codex" && source.path == home.join(suffix))
        })
    }
}

impl Drop for Fixture {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.root); }
}

#[test]
fn data_channel_identity_default_is_compatible_and_custom_is_stable_before_creation() {
    let _lock = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let fixture = Fixture::new("source-identity");
    assert_ne!(crate::cockpit_data_path::source_instance_id().unwrap(), "local",
        "a modern installation cannot claim history from the legacy physical root");
    std::fs::create_dir_all(fixture.root.join(".antigravity_cockpit")).unwrap();
    assert_eq!(crate::cockpit_data_path::source_instance_id().unwrap(), "local");
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(fixture.root.join(".antigravity_cockpit"), fixture.root.join(".cockpit_tools")).unwrap();
        assert_eq!(crate::cockpit_data_path::source_instance_id().unwrap(), "local",
            "the upstream modern alias must preserve the legacy physical history");
    }
    {
        let _dev = crate::EnvGuard::set("COCKPIT_TOOLS_PROFILE", "dev");
        assert_ne!(crate::cockpit_data_path::source_instance_id().unwrap(), "local");
    }
    let a = fixture.root.join("source-a");
    let identity = {
        let _source = crate::EnvGuard::set("COCKPIT_TOOLS_DATA_DIR", &a);
        let before = crate::cockpit_data_path::source_instance_id().unwrap();
        std::fs::create_dir_all(&a).unwrap();
        assert_eq!(crate::cockpit_data_path::source_instance_id().unwrap(), before);
        assert_eq!(crate::get_cockpit_source_identity().unwrap()["sourceInstanceId"], before);
        assert!(before.starts_with("cockpit:") && !before.contains(&fixture.root.to_string_lossy().to_string()));
        before
    };
    {
        let _source = crate::EnvGuard::set("COCKPIT_TOOLS_DATA_DIR", fixture.root.join("source-b"));
        assert_ne!(crate::cockpit_data_path::source_instance_id().unwrap(), identity);
        assert!(crate::write_cost_ledger("{\"accounts\":[]}".into(), Some(identity)).is_err(),
            "a batch read from source A cannot overwrite source B's retained history");
    }
}

#[cfg(unix)]
#[test]
fn data_channel_identity_canonical_alias_preserves_the_same_history() {
    let _lock = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let fixture = Fixture::new("source-identity-alias");
    let _appdata = crate::EnvGuard::set("APPDATA", fixture.root.join("own-data"));
    let source = fixture.root.join("physical-source");
    let alias = fixture.root.join("alias-source");
    std::fs::create_dir_all(&source).unwrap();
    std::os::unix::fs::symlink(&source, &alias).unwrap();
    let identity = {
        let _source = crate::EnvGuard::set("COCKPIT_TOOLS_DATA_DIR", &source);
        crate::write_cost_ledger("{\"accounts\":[]}".into(), None).unwrap();
        crate::cockpit_data_path::source_instance_id().unwrap()
    };
    let _alias = crate::EnvGuard::set("COCKPIT_TOOLS_DATA_DIR", &alias);
    assert_eq!(crate::cockpit_data_path::source_instance_id().unwrap(), identity);
    assert_eq!(crate::read_cost_ledger().unwrap(), "{\"accounts\":[]}");
}

#[test]
fn data_channel_audit_selected_root_change_does_not_reassign_default_history() {
    let _lock = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let fixture = Fixture::new("default-source-switch");
    let _appdata = crate::EnvGuard::set("APPDATA", fixture.root.join("own-data"));
    let modern = fixture.root.join(".cockpit_tools");
    let legacy = fixture.root.join(".antigravity_cockpit");
    std::fs::create_dir_all(&modern).unwrap();
    let modern_identity = crate::cockpit_data_path::source_instance_id().unwrap();
    let payload = "{\"accounts\":[{\"email\":\"modern@example.invalid\",\"updatedAt\":1,\"usage\":{}}]}";
    crate::write_cost_ledger(payload.into(), Some(modern_identity.clone())).unwrap();
    std::fs::create_dir_all(&legacy).unwrap();
    assert_ne!(crate::cockpit_data_path::source_instance_id().unwrap(), modern_identity,
        "an independent legacy root must not inherit the modern root identity");
    assert_eq!(crate::read_cost_ledger().unwrap(), "null");
    crate::write_cost_ledger("{\"accounts\":[]}".into(), None).unwrap();
    std::fs::remove_dir(&legacy).unwrap();
    assert_eq!(crate::cockpit_data_path::source_instance_id().unwrap(), modern_identity);
    assert_eq!(crate::read_cost_ledger().unwrap(), payload);
}

#[test]
fn data_channel_audit_selected_root_change_keeps_captured_ingest_in_its_own_ledger() {
    let _lock = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let fixture = Fixture::new("captured-source-switch");
    let _ledger = crate::EnvGuard::set("CONSOLE2API_LEDGER_DIR", fixture.root.join("own-ledger"));
    let modern = fixture.root.join(".cockpit_tools");
    let legacy = fixture.root.join(".antigravity_cockpit");
    std::fs::create_dir_all(&modern).unwrap();
    let conn = rusqlite::Connection::open(modern.join(crate::cockpit_logs_db::REQUEST_LOG_DB_NAME)).unwrap();
    conn.execute_batch("CREATE TABLE request_logs(id INTEGER PRIMARY KEY,event_key TEXT,timestamp INTEGER,account_id TEXT,input_tokens INTEGER,output_tokens INTEGER,cached_tokens INTEGER,success INTEGER); INSERT INTO request_logs VALUES(1,'modern-event',3600000,'same-id',100,10,0,1);").unwrap();
    drop(conn);
    // This is the production constructor used by the named-source command.
    let source = crate::ledger_ingest::IngestSource::codex_logs().unwrap();
    std::fs::create_dir_all(&legacy).unwrap();
    let options = crate::ledger_ingest::IngestOptions {
        source: Some(source), now_ms: Some(10 * crate::ledger_db::HOUR_MS), ..Default::default()
    };
    assert!(crate::ledger_ingest::ingest_all(&options).unwrap().ok);
    let runtime = tokio::runtime::Runtime::new().unwrap();
    assert!(runtime.block_on(crate::ledger_query::ledger_list_sources()).unwrap().is_empty(),
        "source captured from modern must not write into newly selected legacy");
    std::fs::remove_dir(&legacy).unwrap();
    assert_eq!(runtime.block_on(crate::ledger_query::ledger_list_sources()).unwrap()
        .iter().map(|source| source.tokens).sum::<i64>(), 110,
        "the original physical source must retain the successful captured batch");
}

#[test]
fn data_channel_audit_custom_sources_do_not_share_json_usage_history() {
    let _lock = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let fixture = Fixture::new("source-json-history");
    let _appdata = crate::EnvGuard::set("APPDATA", fixture.root.join("app-data"));
    let a = fixture.root.join("source-a");
    let b = fixture.root.join("source-b");
    let payload = r#"{"accounts":[{"email":"same@example.invalid","updatedAt":1,"usage":{"totalTokens":123}}]}"#;
    {
        let _source = crate::EnvGuard::set("COCKPIT_TOOLS_DATA_DIR", &a);
        crate::write_cost_ledger(payload.to_string(), None).unwrap();
    }
    {
        let _source = crate::EnvGuard::set("COCKPIT_TOOLS_DATA_DIR", &b);
        assert_eq!(crate::read_cost_ledger().unwrap(), "null", "a separate source must not inherit another source's retained usage");
    }
    {
        let _source = crate::EnvGuard::set("COCKPIT_TOOLS_DATA_DIR", &a);
        assert_eq!(crate::read_cost_ledger().unwrap(), payload, "switching away must not destroy the original source history");
    }
    assert!(!a.exists() && !b.exists(), "our persistence must not create upstream directories");
}

#[test]
fn data_channel_audit_custom_sources_do_not_share_persistent_usage_or_checkpoints() {
    let _lock = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let fixture = Fixture::new("source-sqlite-history");
    let _ledger = crate::EnvGuard::set("CONSOLE2API_LEDGER_DIR", fixture.root.join("own-ledger"));
    let a = fixture.root.join("source-a");
    let b = fixture.root.join("source-b");
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let ingest = |directory: &Path, input: i64| {
        std::fs::create_dir_all(directory).unwrap();
        let path = directory.join("source.sqlite");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE request_logs(id INTEGER PRIMARY KEY,event_key TEXT,timestamp INTEGER,account_id TEXT,input_tokens INTEGER,output_tokens INTEGER,cached_tokens INTEGER,success INTEGER);").unwrap();
        conn.execute("INSERT INTO request_logs VALUES(1,'same-local-event-key',3600000,'same-source-account-id',?1,10,0,1)", [input]).unwrap();
        drop(conn);
        let mut source = crate::ledger_ingest::IngestSource::sqlite(&path, "request_logs", "id", "timestamp");
        source.source_name = crate::ledger_db::SOURCE_CODEX_LOGS.to_string();
        let options = crate::ledger_ingest::IngestOptions { source: Some(source), now_ms: Some(10 * crate::ledger_db::HOUR_MS), ..Default::default() };
        let result = crate::ledger_ingest::ingest_all(&options).unwrap();
        assert!(result.ok, "valid fixture source must ingest successfully");
    };
    {
        let _source = crate::EnvGuard::set("COCKPIT_TOOLS_DATA_DIR", &a);
        ingest(&a, 100);
        assert_eq!(runtime.block_on(crate::ledger_query::ledger_list_sources()).unwrap().iter().map(|source| source.tokens).sum::<i64>(), 110);
    }
    {
        let _source = crate::EnvGuard::set("COCKPIT_TOOLS_DATA_DIR", &b);
        assert!(runtime.block_on(crate::ledger_query::ledger_list_sources()).unwrap().is_empty(), "unselected source history must not appear under a new source");
        ingest(&b, 200);
        assert_eq!(runtime.block_on(crate::ledger_query::ledger_list_sources()).unwrap().iter().map(|source| source.tokens).sum::<i64>(), 210);
    }
    {
        let _source = crate::EnvGuard::set("COCKPIT_TOOLS_DATA_DIR", &a);
        assert_eq!(runtime.block_on(crate::ledger_query::ledger_list_sources()).unwrap().iter().map(|source| source.tokens).sum::<i64>(), 110);
    }
}

#[test]
fn data_channel_audit_legacy_registry_and_independent_ledger_remain_supported() {
    let _lock = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let fixture = Fixture::new("compatibility-control");
    let managed = fixture.root.join("legacy-codex");
    fixture.registry(&fixture.root.join(".antigravity_cockpit"), serde_json::json!({
        "instances": [{"user_data_dir":managed}]
    }));
    let (sources, error) = super::collector::roots().unwrap();
    assert!(error.is_none());
    assert!(Fixture::has_codex_home(&sources, &managed));
    assert!(crate::ledger_db::assert_not_cockpit_path(&fixture.root.join("independent-ledger/ledger.sqlite")).is_ok());
}

#[test]
fn data_channel_audit_cockpit_registry_uses_persisted_camel_case() {
    let _lock = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let fixture = Fixture::new("camel-case");
    let managed = fixture.root.join("managed-codex");
    fixture.registry(&fixture.root.join(".antigravity_cockpit"), serde_json::json!({
        "instances": [{"id":"managed-1", "userDataDir":managed}]
    }));
    let (sources, error) = super::collector::roots().unwrap();
    assert!(error.is_none(), "valid upstream InstanceStore must not be reported as corrupt");
    assert!(Fixture::has_codex_home(&sources, &managed), "camelCase userDataDir is the upstream persisted field");
}

#[test]
fn data_channel_audit_cockpit_registry_reads_modern_root() {
    let _lock = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let fixture = Fixture::new("modern-root");
    let managed = fixture.root.join("managed-codex");
    fixture.registry(&fixture.root.join(".cockpit_tools"), serde_json::json!({
        "instances": [{"id":"managed-1", "userDataDir":managed}]
    }));
    let (sources, error) = super::collector::roots().unwrap();
    assert!(error.is_none());
    assert!(Fixture::has_codex_home(&sources, &managed), "new Cockpit installations must be discovered");
}

#[test]
fn data_channel_audit_cockpit_registry_override_does_not_mix_default_instance() {
    let _lock = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let fixture = Fixture::new("source-isolation");
    let custom_root = fixture.root.join("custom-state");
    let custom_home = fixture.root.join("custom-codex");
    let other_home = fixture.root.join("unselected-codex");
    fixture.registry(&custom_root, serde_json::json!({"instances":[{"userDataDir":custom_home}]}));
    fixture.registry(&fixture.root.join(".antigravity_cockpit"), serde_json::json!({"instances":[{"user_data_dir":other_home}]}));
    let _override = crate::EnvGuard::set("COCKPIT_TOOLS_DATA_DIR", &custom_root);
    let (sources, error) = super::collector::roots().unwrap();
    assert!(error.is_none());
    assert!(Fixture::has_codex_home(&sources, &custom_home));
    assert!(!Fixture::has_codex_home(&sources, &other_home), "explicit source selection cannot silently read another registry");
}

#[test]
fn data_channel_audit_missing_custom_registry_does_not_fall_back_to_other_accounts() {
    let _lock = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let fixture = Fixture::new("missing-override");
    let other_home = fixture.root.join("unselected-codex");
    fixture.registry(&fixture.root.join(".antigravity_cockpit"), serde_json::json!({"instances":[{"user_data_dir":other_home}]}));
    let _override = crate::EnvGuard::set("COCKPIT_TOOLS_DATA_DIR", fixture.root.join("not-created"));
    let (sources, _) = super::collector::roots().unwrap();
    assert!(!Fixture::has_codex_home(&sources, &other_home));
    assert!(Fixture::has_codex_home(&sources, &fixture.root.join(".codex")), "standalone Codex discovery must keep working");
}

#[test]
fn data_channel_audit_invalid_registry_is_reported_without_dropping_valid_sources() {
    let _lock = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let fixture = Fixture::new("invalid-registry");
    let managed = fixture.root.join("valid-codex");
    fixture.registry(&fixture.root.join(".antigravity_cockpit"), serde_json::json!({
        "instances": [{"userDataDir":managed}, {"userDataDir":17}]
    }));
    let (sources, error) = super::collector::roots().unwrap();
    assert!(error.is_some(), "wrong-type registered paths cannot be presented as complete discovery");
    assert!(Fixture::has_codex_home(&sources, &managed));
    assert!(Fixture::has_codex_home(&sources, &fixture.root.join(".codex")));
}

#[test]
fn data_channel_audit_ledger_rejects_modern_and_development_source_directories() {
    let _lock = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let fixture = Fixture::new("ledger-source-names");
    for directory in [".antigravity_cockpit", ".cockpit_tools", ".antigravity_cockpit_dev", ".cockpit_tools_dev"] {
        assert!(crate::ledger_db::assert_not_cockpit_path(&fixture.root.join(directory).join("nested/ledger.sqlite")).is_err(),
            "own ledger must never be stored inside upstream-owned directory {directory}");
    }
    assert!(crate::ledger_db::assert_not_cockpit_path(&fixture.root.join("independent-ledger/ledger.sqlite")).is_ok());
}

#[test]
fn data_channel_audit_ledger_rejects_explicit_custom_source_even_before_creation() {
    let _lock = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let fixture = Fixture::new("ledger-custom-source");
    let source = fixture.root.join("custom-source");
    let _override = crate::EnvGuard::set("COCKPIT_TOOLS_DATA_DIR", &source);
    assert!(crate::ledger_db::assert_not_cockpit_path(&source.join("nested/ledger.sqlite")).is_err());
    assert!(crate::ledger_db::assert_not_cockpit_path(&fixture.root.join("custom-source-other/ledger.sqlite")).is_ok(),
        "sibling names sharing a prefix are independent locations");
}

#[test]
fn data_channel_audit_ledger_checks_fallback_before_creating_directories() {
    let _lock = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let fixture = Fixture::new("ledger-appdata-source");
    let source = fixture.root.join("custom-source");
    let _source = crate::EnvGuard::set("COCKPIT_TOOLS_DATA_DIR", &source);
    let _appdata = crate::EnvGuard::set("APPDATA", &source);
    let _ledger = crate::EnvGuard::remove("CONSOLE2API_LEDGER_DIR");
    let selected = crate::ledger_db::ledger_db_path().unwrap();
    assert!(!selected.starts_with(&source));
    assert!(!source.exists(), "source discovery and rejected fallback candidates must never create upstream data directories");
}

#[cfg(unix)]
#[test]
fn data_channel_audit_ledger_rejects_symlink_alias_of_custom_source() {
    let _lock = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let fixture = Fixture::new("ledger-alias");
    let source = fixture.root.join("custom-source");
    std::fs::create_dir_all(&source).unwrap();
    let alias = fixture.root.join("innocent-name");
    std::os::unix::fs::symlink(&source, &alias).unwrap();
    let _override = crate::EnvGuard::set("COCKPIT_TOOLS_DATA_DIR", &source);
    assert!(crate::ledger_db::assert_not_cockpit_path(&alias.join("nested/ledger.sqlite")).is_err(),
        "a path alias does not change ownership of the source directory");
}
