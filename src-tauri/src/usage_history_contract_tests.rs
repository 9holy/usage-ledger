use crate::{read_cost_ledger, write_cost_ledger, EnvGuard, ENV_LOCK};

const VALID: &str = r#"{"accounts":[{"email":"history@example.invalid","updatedAt":1,"usage":{"requestCount":0,"estimatedCostUsd":0.00001}}]}"#;

fn rejected_without_replacing_history(payload: &str) {
    let _lock = ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let fixture = std::env::temp_dir().join(format!("usage-ledger-history-contract-{}", std::process::id()));
    let _home = EnvGuard::set("HOME", &fixture);
    let _profile = EnvGuard::set("USERPROFILE", &fixture);
    let _appdata = EnvGuard::set("APPDATA", fixture.join("app"));
    let _source = EnvGuard::set("COCKPIT_TOOLS_DATA_DIR", fixture.join("upstream"));
    std::fs::remove_dir_all(&fixture).ok();
    write_cost_ledger(VALID.into(), None).unwrap();
    let result = write_cost_ledger(payload.into(), None);
    let retained = read_cost_ledger().unwrap();
    std::fs::remove_dir_all(&fixture).ok();
    assert!(result.is_err(), "malformed ledger replacement must be rejected");
    assert_eq!(retained, VALID, "a rejected write must preserve the exact previous history");
}

#[test]
fn completion_ledger_write_requires_accounts() {
    rejected_without_replacing_history(r#"{"other":true}"#);
}

#[test]
fn completion_ledger_write_requires_valid_history_rows() {
    rejected_without_replacing_history(r#"{"accounts":[{"email":"history@example.invalid","updatedAt":1,"usage":{"requestCount":null}}]}"#);
}

#[test]
fn completion_ledger_write_rejects_ambiguous_duplicate_emails() {
    rejected_without_replacing_history(r#"{"accounts":[{"email":"same@example.invalid","updatedAt":1,"usage":{"requestCount":2}},{"email":"same@example.invalid","updatedAt":2,"usage":{"requestCount":7}}]}"#);
}

#[test]
fn completion_ledger_write_rejects_fractional_source_counters() {
    rejected_without_replacing_history(r#"{"accounts":[{"email":"history@example.invalid","updatedAt":1,"usage":{"requestCount":1.5}}]}"#);
}

#[test]
fn completion_ledger_write_rejects_imprecise_source_counters() {
    rejected_without_replacing_history(r#"{"accounts":[{"email":"history@example.invalid","updatedAt":1,"usage":{"totalTokens":9007199254740992}}]}"#);
}
