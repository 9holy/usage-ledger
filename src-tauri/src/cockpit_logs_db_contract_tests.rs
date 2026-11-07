//! Contracts verified against jlcodes99/cockpit-tools
//! 820e176842d440a60e650729c3a39932b76a0ccb.
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "cockpit-contract-{}-{}", std::process::id(), NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }

    fn db(&self) -> (PathBuf, Connection) {
        let path = self.0.join(REQUEST_LOG_DB_NAME);
        let conn = Connection::open(&path).unwrap();
        // Current upstream create_request_logs_table: cached price is nullable;
        // the remaining selected counters have non-null numeric contracts.
        conn.execute_batch("CREATE TABLE request_logs (
            id INTEGER PRIMARY KEY, model_id TEXT NOT NULL DEFAULT 'fixture',
            account_id TEXT NOT NULL DEFAULT 'codex_fixture', api_key_id TEXT NOT NULL DEFAULT '',
            timestamp INTEGER NOT NULL DEFAULT 1000, success INTEGER NOT NULL DEFAULT 1,
            input_tokens INTEGER NOT NULL DEFAULT 100, output_tokens INTEGER NOT NULL DEFAULT 10,
            cached_tokens INTEGER NOT NULL DEFAULT 20, reasoning_tokens INTEGER NOT NULL DEFAULT 5,
            estimated_cost_usd REAL NOT NULL DEFAULT 0.01, latency_ms INTEGER NOT NULL DEFAULT 10,
            http_status INTEGER, error_category TEXT NOT NULL DEFAULT '',
            service_tier TEXT NOT NULL DEFAULT '', reasoning_effort TEXT NOT NULL DEFAULT '',
            gateway_mode TEXT NOT NULL DEFAULT 'native', request_kind TEXT NOT NULL DEFAULT 'text',
            input_usd_per_million REAL NOT NULL DEFAULT 5,
            output_usd_per_million REAL NOT NULL DEFAULT 30,
            cached_input_usd_per_million REAL, model_pricing_version INTEGER NOT NULL DEFAULT 1
        );").unwrap();
        (path, conn)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

fn assert_roots(expected: &std::path::Path) {
    assert_eq!(cockpit_data_dir().unwrap(), expected);
    assert_eq!(crate::cockpit_quota::cockpit_root().unwrap(), expected);
    assert_eq!(crate::cockpit_data_dir().unwrap(), expected);
}

#[test]
fn contract_audit_cockpit_current_directory_is_read_without_creating_legacy_store() {
    let _lock = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let fixture = Fixture::new();
    let _home = crate::EnvGuard::set("USERPROFILE", &fixture.0);
    let _home2 = crate::EnvGuard::set("HOME", &fixture.0);
    let _override = crate::EnvGuard::remove("COCKPIT_TOOLS_DATA_DIR");
    let _profile = crate::EnvGuard::remove("COCKPIT_TOOLS_PROFILE");
    let current = fixture.0.join(".cockpit_tools");
    std::fs::create_dir_all(&current).unwrap();
    std::fs::write(current.join("codex_accounts.json"), "{\"accounts\":[]}").unwrap();
    assert_roots(&current);
    assert_eq!(crate::read_cockpit_file("codex_accounts.json".into()).unwrap(), "{\"accounts\":[]}");
    assert!(!fixture.0.join(".antigravity_cockpit").exists());
}

#[test]
fn contract_audit_cockpit_explicit_missing_override_never_falls_back_to_other_accounts() {
    let _lock = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let fixture = Fixture::new();
    let _home = crate::EnvGuard::set("USERPROFILE", &fixture.0);
    let _home2 = crate::EnvGuard::set("HOME", &fixture.0);
    let missing = fixture.0.join("selected-but-missing");
    let _override = crate::EnvGuard::set("COCKPIT_TOOLS_DATA_DIR", &missing);
    std::fs::create_dir_all(fixture.0.join(".antigravity_cockpit")).unwrap();
    std::fs::write(fixture.0.join(".antigravity_cockpit/codex_accounts.json"), "{\"accounts\":[{\"id\":\"wrong-store\"}]}").unwrap();
    assert_roots(&missing);
    assert!(crate::read_cockpit_file("codex_accounts.json".into()).is_err());
    assert!(!missing.exists(), "a data reader must not create the selected upstream directory");
}

#[test]
fn contract_audit_cockpit_relative_override_requires_producer_directory_evidence() {
    let _lock = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let fixture = Fixture::new();
    let _home = crate::EnvGuard::set("USERPROFILE", &fixture.0);
    let _home2 = crate::EnvGuard::set("HOME", &fixture.0);
    let _override = crate::EnvGuard::set("COCKPIT_TOOLS_DATA_DIR", " relative-instance ");
    std::fs::create_dir_all(fixture.0.join(".antigravity_cockpit")).unwrap();
    for result in [cockpit_data_dir(), crate::cockpit_quota::cockpit_root(), crate::cockpit_data_dir()] {
        assert!(result.unwrap_err().contains("绝对路径"));
    }
}

#[cfg(unix)]
#[test]
fn contract_audit_cockpit_current_alias_returns_the_official_current_name() {
    let _lock = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let fixture = Fixture::new();
    let _home = crate::EnvGuard::set("USERPROFILE", &fixture.0);
    let _home2 = crate::EnvGuard::set("HOME", &fixture.0);
    let _override = crate::EnvGuard::remove("COCKPIT_TOOLS_DATA_DIR");
    let _profile = crate::EnvGuard::remove("COCKPIT_TOOLS_PROFILE");
    let legacy = fixture.0.join(".antigravity_cockpit");
    let current = fixture.0.join(".cockpit_tools");
    std::fs::create_dir_all(&legacy).unwrap();
    std::os::unix::fs::symlink(&legacy, &current).unwrap();
    assert_roots(&current);
}

#[test]
fn contract_audit_cockpit_dev_profile_is_isolated_from_production() {
    let _lock = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let fixture = Fixture::new();
    let _home = crate::EnvGuard::set("USERPROFILE", &fixture.0);
    let _home2 = crate::EnvGuard::set("HOME", &fixture.0);
    let _override = crate::EnvGuard::remove("COCKPIT_TOOLS_DATA_DIR");
    let _profile = crate::EnvGuard::set("COCKPIT_TOOLS_PROFILE", " DEV ");
    std::fs::create_dir_all(fixture.0.join(".antigravity_cockpit")).unwrap();
    let selected = fixture.0.join(".cockpit_tools_dev");
    assert_roots(&selected);
    assert!(!selected.exists());
}

#[test]
fn contract_audit_cockpit_independent_current_and_legacy_stores_keep_upstream_legacy_priority() {
    let _lock = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let fixture = Fixture::new();
    let _home = crate::EnvGuard::set("USERPROFILE", &fixture.0);
    let _home2 = crate::EnvGuard::set("HOME", &fixture.0);
    let _override = crate::EnvGuard::remove("COCKPIT_TOOLS_DATA_DIR");
    let _profile = crate::EnvGuard::remove("COCKPIT_TOOLS_PROFILE");
    let legacy = fixture.0.join(".antigravity_cockpit");
    let current = fixture.0.join(".cockpit_tools");
    std::fs::create_dir_all(&legacy).unwrap();
    std::fs::create_dir_all(&current).unwrap();
    assert_roots(&legacy);
    assert!(legacy.is_dir() && current.is_dir(), "no merging or renaming source stores");
}

#[test]
fn contract_audit_cockpit_invalid_legacy_entry_is_an_error_not_a_different_store() {
    let _lock = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let fixture = Fixture::new();
    let _home = crate::EnvGuard::set("USERPROFILE", &fixture.0);
    let _home2 = crate::EnvGuard::set("HOME", &fixture.0);
    let _override = crate::EnvGuard::remove("COCKPIT_TOOLS_DATA_DIR");
    let _profile = crate::EnvGuard::remove("COCKPIT_TOOLS_PROFILE");
    std::fs::write(fixture.0.join(".antigravity_cockpit"), "not-a-directory").unwrap();
    std::fs::create_dir_all(fixture.0.join(".cockpit_tools")).unwrap();
    assert!(cockpit_data_dir().is_err());
    assert!(crate::cockpit_quota::cockpit_root().is_err());
    assert!(crate::cockpit_data_dir().is_err());
}

#[test]
fn contract_audit_cockpit_nullable_cached_price_remains_unknown_and_distinct_from_free() {
    let fixture = Fixture::new();
    let (path, conn) = fixture.db();
    conn.execute_batch("INSERT INTO request_logs(id,cached_input_usd_per_million) VALUES (1,NULL),(2,0);").unwrap();
    let result = facets(&path, None, None).unwrap();
    let json = serde_json::to_value(result).unwrap();
    let variants = json["priceSnapshots"][0]["variants"].as_array().unwrap();
    assert_eq!(variants.len(), 2, "unrecorded and explicitly zero cache prices are different source facts");
    assert!(variants.iter().any(|v| v["cachedInputUsdPerMillion"].is_null()));
    assert!(variants.iter().any(|v| v["cachedInputUsdPerMillion"] == 0.0));
}

#[test]
fn contract_audit_cockpit_each_price_variant_keeps_only_its_observed_versions() {
    let fixture = Fixture::new();
    let (path, conn) = fixture.db();
    conn.execute_batch("INSERT INTO request_logs(id,input_usd_per_million,cached_input_usd_per_million,model_pricing_version) VALUES
        (1,5,0.5,1),(2,5,0.5,3),(3,10,1,2);").unwrap();
    let result = facets(&path, None, None).unwrap();
    let variants = &result.price_snapshots[0].variants;
    assert_eq!(variants.iter().find(|v| v.input_usd_per_million == 5.0).unwrap().pricing_versions, vec![1,3]);
    assert_eq!(variants.iter().find(|v| v.input_usd_per_million == 10.0).unwrap().pricing_versions, vec![2]);
}

#[test]
fn contract_audit_cockpit_invalid_numeric_rows_are_not_silently_changed_to_zero() {
    let fixture = Fixture::new();
    let (path, conn) = fixture.db();
    for assignment in ["input_tokens = -1", "output_tokens = -1", "success = 2", "input_tokens = 9007199254740992"] {
        conn.execute_batch("DELETE FROM request_logs; INSERT INTO request_logs(id,cached_input_usd_per_million) VALUES(1,0.5);").unwrap();
        conn.execute_batch(&format!("UPDATE request_logs SET {assignment}")).unwrap();
        assert!(summarize(&path, None, None, 1, true).is_err(), "summary accepted invalid {assignment}");
        assert!(facets(&path, None, None).is_err(), "facets accepted invalid {assignment}");
    }
}

#[test]
fn contract_audit_cockpit_wrong_sqlite_type_does_not_become_a_zero_facet() {
    let fixture = Fixture::new();
    let (path, conn) = fixture.db();
    conn.execute_batch("INSERT INTO request_logs(id,cached_input_usd_per_million,input_tokens) VALUES(1,0.5,'invalid-token-count');").unwrap();
    assert!(facets(&path, None, None).is_err(), "bad source types must fail instead of silently producing $0/0 tokens");
}

#[test]
fn contract_audit_cockpit_aggregate_overflow_is_rejected_before_javascript_precision_loss() {
    let fixture = Fixture::new();
    let (path, conn) = fixture.db();
    conn.execute_batch("INSERT INTO request_logs(id,cached_input_usd_per_million,input_tokens) VALUES
        (1,0.5,4503599627370496),(2,0.5,4503599627370496);").unwrap();
    assert!(summarize(&path, None, None, 1, true).is_err());
    assert!(facets(&path, None, None).is_err());
}
