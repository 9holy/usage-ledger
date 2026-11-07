//! Pinned source contracts: jlcodes99/cockpit-tools
//! 820e176842d440a60e650729c3a39932b76a0ccb, models/account.rs and secure_account_storage.rs.
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT_FIXTURE: AtomicUsize = AtomicUsize::new(0);
struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("cockpit-quota-contract-{}-{}",
            std::process::id(), NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed))))
    }
    fn write(&self, name: &str, value: serde_json::Value) {
        let path = self.0.join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, serde_json::to_string(&value).unwrap()).unwrap();
    }
    fn cache(&self) {
        self.write(&format!("{SUBDIR_QUOTA_DESKTOP}/{}.json", "a".repeat(64)), serde_json::json!({
            "email": "member@example.invalid", "updatedAt": 1_792_000_000_000i64,
            "payload": {"models": {"gemini-pro": {"quotaInfo": {"remainingFraction": 0.75}}}}
        }));
    }
}
impl Drop for Fixture {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

fn encrypted() -> serde_json::Value {
    serde_json::json!({"version":1,"kind":"antigravity_account","algorithm":"AES-256-GCM",
        "key_id":"fixture","nonce":"AAAAAAAAAAAAAAAA","ciphertext":"fixture-only","encrypted_at":1792000000})
}

#[test]
fn contract_audit_quota_plaintext_index_links_encrypted_detail_to_observed_cache() {
    let fixture = Fixture::new();
    fixture.write("accounts.json", serde_json::json!({"version":"2.0", "accounts":[
        {"id":"account-uuid","email":"member@example.invalid","name":"Member","created_at":1,"last_used":2}
    ]}));
    fixture.write("accounts/account-uuid.json", encrypted());
    fixture.cache();
    let accounts = ChannelAccounts::load(&fixture.0, CH_ANTIGRAVITY).unwrap();
    assert_eq!(accounts.accounts[0].email, "member@example.invalid");
    assert_eq!(accounts.accounts[0].display_name, "Member");
    let rows = SnapshotProvider{now_ms:1_792_000_000_001}.fetch(&accounts).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].account_id, "account-uuid", "cache filename is not the indexed account ID");
    assert_eq!(rows[0].percent, Some(75.0));
    assert_eq!(rows[0].updated_at_ms, Some(1_792_000_000_000));
}

#[test]
fn contract_audit_quota_shared_email_cache_is_not_assigned_to_multiple_accounts() {
    let fixture = Fixture::new();
    for id in ["workspace-a", "workspace-b"] {
        fixture.write(&format!("accounts/{id}.json"), serde_json::json!({"id":id,"email":"member@example.invalid"}));
    }
    fixture.cache();
    let accounts = ChannelAccounts::load(&fixture.0, CH_ANTIGRAVITY).unwrap();
    let rows = SnapshotProvider{now_ms:1_792_000_000_001}.fetch(&accounts).unwrap();
    assert!(rows.iter().filter(|row| row.account_id == "workspace-a" || row.account_id == "workspace-b")
        .all(|row| row.percent.is_none()), "email-only cache cannot prove workspace ownership");
    assert_eq!(rows.iter().filter(|row| row.percent.is_some()).count(), 1);
}

#[test]
fn contract_audit_quota_removed_index_account_is_not_restored_from_leftover_detail() {
    let fixture = Fixture::new();
    fixture.write("accounts.json", serde_json::json!({"version":"2.0","accounts":[
        {"id":"current","email":"current@example.invalid"}
    ]}));
    fixture.write("accounts/current.json", encrypted());
    fixture.write("accounts/deleted.json", encrypted());
    let accounts = ChannelAccounts::load(&fixture.0, CH_ANTIGRAVITY).unwrap();
    assert_eq!(accounts.accounts.len(), 1);
    assert_eq!(accounts.accounts[0].id, "current");
}

#[test]
fn contract_audit_quota_malformed_detail_is_source_error_not_empty_accounts() {
    let fixture = Fixture::new();
    let path = fixture.0.join("accounts/broken.json");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, "{broken-json").unwrap();
    assert!(ChannelAccounts::load(&fixture.0, CH_ANTIGRAVITY).is_err());
}

#[test]
fn contract_audit_quota_missing_indexed_detail_is_source_error_not_zero_accounts() {
    let fixture = Fixture::new();
    fixture.write("accounts.json", serde_json::json!({"version":"2.0","accounts":[
        {"id":"current","email":"current@example.invalid"}
    ]}));
    assert!(ChannelAccounts::load(&fixture.0, CH_ANTIGRAVITY).is_err());
}

#[test]
fn contract_audit_quota_duplicate_index_identity_is_rejected() {
    let fixture = Fixture::new();
    fixture.write("accounts.json", serde_json::json!({"version":"2.0","accounts":[
        {"id":"same","email":"first@example.invalid"},
        {"id":"same","email":"second@example.invalid"}
    ]}));
    fixture.write("accounts/same.json", encrypted());
    assert!(ChannelAccounts::load(&fixture.0, CH_ANTIGRAVITY).is_err());
}

fn codex_native_quota() -> serde_json::Value {
    serde_json::json!({"email":"codex@example.invalid", "usage_updated_at":1_792_000_000i64,
        "quota":{"hourly_percentage":83,"hourly_reset_time":1_792_010_000i64,
            "hourly_window_minutes":300,"hourly_window_present":true,
            "weekly_percentage":41,"weekly_reset_time":1_792_600_000i64,
            "weekly_window_minutes":10080,"weekly_window_present":true}})
}

#[test]
fn contract_audit_quota_codex_native_flat_fields_are_remaining_and_seconds() {
    let fixture = Fixture::new();
    fixture.write("codex_accounts/codex_fixture.json", codex_native_quota());
    let accounts = ChannelAccounts::load(&fixture.0, CH_CODEX).unwrap();
    let rows = SnapshotProvider{now_ms:1_792_000_001_000}.fetch(&accounts).unwrap();
    assert_eq!(rows.len(), 2);
    let primary = rows.iter().find(|row| row.model_id == "primary_window").unwrap();
    assert_eq!(primary.percent, Some(83.0), "stored percentage is already remaining");
    assert_eq!(primary.percent_kind, Some(PercentKind::Remaining));
    assert_eq!(primary.window_kind, QuotaWindowKind::FiveHour);
    assert_eq!(primary.reset_at_ms, Some(1_792_010_000_000));
    assert_eq!(primary.updated_at_ms, Some(1_792_000_000_000));
    assert!(!primary.stale);
    let secondary = rows.iter().find(|row| row.model_id == "secondary_window").unwrap();
    assert_eq!(secondary.percent, Some(41.0));
    assert_eq!(secondary.window_kind, QuotaWindowKind::Weekly);
}

#[test]
fn contract_audit_quota_codex_absent_window_sentinel_is_not_a_full_quota() {
    let fixture = Fixture::new();
    let mut account = codex_native_quota();
    account["quota"]["hourly_window_minutes"] = 60.into();
    account["quota"]["weekly_window_present"] = false.into();
    account["quota"]["weekly_percentage"] = 100.into();
    fixture.write("codex_accounts/codex_fixture.json", account);
    let accounts = ChannelAccounts::load(&fixture.0, CH_CODEX).unwrap();
    let rows = SnapshotProvider{now_ms:1_792_000_001_000}.fetch(&accounts).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].model_id, "primary_window");
    assert_eq!(rows[0].percent, Some(83.0));
    assert_eq!(rows[0].window_kind, QuotaWindowKind::Unknown, "slot name does not prove a five-hour duration");
}

#[test]
fn contract_audit_quota_codex_failed_refresh_does_not_refresh_observation_age() {
    let fixture = Fixture::new();
    let mut account = codex_native_quota();
    account["quota_error"] = serde_json::json!({"message":"fixture refresh failure","timestamp":1_792_000_001i64});
    fixture.write("codex_accounts/codex_fixture.json", account);
    let accounts = ChannelAccounts::load(&fixture.0, CH_CODEX).unwrap();
    let rows = SnapshotProvider{now_ms:1_792_000_001_000}.fetch(&accounts).unwrap();
    assert_eq!(rows[0].percent, Some(83.0));
    assert_eq!(rows[0].updated_at_ms, None);
    assert!(rows[0].stale);
    assert!(rows[0].source_error.is_some());
}

#[test]
fn contract_audit_quota_invalid_fraction_is_not_reinterpreted_as_a_percentage() {
    let fixture = Fixture::new();
    fixture.write("accounts/account.json", serde_json::json!({"email":"member@example.invalid"}));
    fixture.write(&format!("{SUBDIR_QUOTA_DESKTOP}/{}.json", "b".repeat(64)), serde_json::json!({
        "email":"member@example.invalid", "updatedAt":1_792_000_000_000i64,
        "payload":{"models":{"gemini-pro":{"quotaInfo":{"remainingFraction":1.2}}}}
    }));
    let accounts = ChannelAccounts::load(&fixture.0, CH_ANTIGRAVITY).unwrap();
    assert!(SnapshotProvider{now_ms:1_792_000_001_000}.fetch(&accounts).is_err());
}

#[test]
fn contract_audit_quota_malformed_cache_is_source_error_not_a_silent_empty_result() {
    let fixture = Fixture::new();
    let path = fixture.0.join(SUBDIR_QUOTA_DESKTOP).join("invalid.json");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, "{broken-json").unwrap();
    let accounts = ChannelAccounts::load(&fixture.0, CH_ANTIGRAVITY).unwrap();
    assert!(SnapshotProvider{now_ms:1_792_000_001_000}.fetch(&accounts).is_err());
}

#[test]
fn contract_audit_quota_copilot_uses_percent_and_preferred_premium_alias_not_absolute_count() {
    let fixture = Fixture::new();
    fixture.write("github_copilot_accounts/member.json", serde_json::json!({
        "usage_updated_at":1_792_000_000i64, "copilot_quota_snapshots":{
            "premium_interactions":{"entitlement":100,"remaining":5,"percent_remaining":5,"has_quota":true},
            "premium_models":{"entitlement":10,"remaining":7,"percent_remaining":70,"has_quota":true}}}));
    let accounts = ChannelAccounts::load(&fixture.0, CH_GITHUB_COPILOT).unwrap();
    let rows = SnapshotProvider{now_ms:1_792_000_001_000}.fetch(&accounts).unwrap();
    assert_eq!(rows.len(), 1, "premium_models supersedes the legacy alias");
    assert_eq!(rows[0].model_id, "premium_models");
    assert_eq!(rows[0].percent, Some(70.0));
    assert_eq!(rows[0].updated_at_ms, Some(1_792_000_000_000));
}

#[test]
fn contract_audit_quota_absolute_remaining_without_percentage_is_not_percent() {
    let fixture = Fixture::new();
    fixture.write("github_copilot_accounts/member.json", serde_json::json!({"copilot_quota_snapshots":{
        "premium_interactions":{"entitlement":1000,"remaining":10,"has_quota":true}}}));
    let accounts = ChannelAccounts::load(&fixture.0, CH_GITHUB_COPILOT).unwrap();
    let rows = SnapshotProvider{now_ms:1_792_000_001_000}.fetch(&accounts).unwrap();
    assert!(rows.iter().all(|row| row.percent.is_none()));
}

#[test]
fn contract_audit_quota_qoder_scalar_used_percentage_has_the_correct_direction() {
    let fixture = Fixture::new();
    fixture.write("qoder_accounts/member.json", serde_json::json!({"credits_usage_percent":25.0,
        "usage_updated_at":1_792_000_000i64}));
    let accounts = ChannelAccounts::load(&fixture.0, CH_QODER).unwrap();
    let rows = SnapshotProvider{now_ms:1_792_000_001_000}.fetch(&accounts).unwrap();
    assert_eq!(rows[0].percent, Some(75.0));
    assert_eq!(rows[0].percent_kind, Some(PercentKind::Used));
    assert_eq!(rows[0].updated_at_ms, Some(1_792_000_000_000));
}

#[test]
fn contract_audit_quota_kiro_credit_pools_keep_independent_denominators() {
    let fixture = Fixture::new();
    fixture.write("kiro_accounts/member.json", serde_json::json!({"credits_total":200.0,"credits_used":50.0,
        "bonus_total":100.0,"bonus_used":10.0,"usage_reset_at":1_792_600_000i64,"usage_updated_at":1_792_000_000i64}));
    let accounts = ChannelAccounts::load(&fixture.0, CH_KIRO).unwrap();
    let rows = SnapshotProvider{now_ms:1_792_000_001_000}.fetch(&accounts).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows.iter().find(|row| row.model_id == "prompt_credits").unwrap().percent, Some(75.0));
    assert_eq!(rows.iter().find(|row| row.model_id == "add_on_credits").unwrap().percent, Some(90.0));
    assert_eq!(rows[0].updated_at_ms, Some(1_792_000_000_000));
}

#[test]
fn contract_audit_quota_grok_native_used_percentage_and_product_pools_are_not_balance_dollars() {
    let fixture = Fixture::new();
    fixture.write("grok_accounts/member.json", serde_json::json!({"usage_updated_at":1_792_000_000_000i64,
        "quota":{"weeklyLimitPercent":42.5,"prepaidBalance":1234.0,"products":[
            {"product":"coding","usagePercent":20.0}
        ]}}));
    let accounts = ChannelAccounts::load(&fixture.0, CH_GROK).unwrap();
    let rows = SnapshotProvider{now_ms:1_792_000_001_000}.fetch(&accounts).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows.iter().find(|row| row.model_id == "credit_usage").unwrap().percent, Some(57.5));
    assert_eq!(rows.iter().find(|row| row.model_id == "coding").unwrap().percent, Some(80.0));
    assert_eq!(rows[0].updated_at_ms, Some(1_792_000_000_000));
}

#[test]
fn contract_audit_quota_zcode_reset_seconds_and_observation_milliseconds_stay_distinct() {
    let fixture = Fixture::new();
    fixture.write("zcode_accounts/member.json", serde_json::json!({"quota_total":1000.0,"quota_remaining":630.0,
        "quota_reset_at":1_792_600_000i64,"usage_updated_at":1_792_000_000_000i64}));
    let accounts = ChannelAccounts::load(&fixture.0, CH_ZCODE).unwrap();
    let rows = SnapshotProvider{now_ms:1_792_000_001_000}.fetch(&accounts).unwrap();
    assert_eq!(rows[0].percent, Some(63.0));
    assert_eq!(rows[0].reset_at_ms, Some(1_792_600_000_000));
    assert_eq!(rows[0].updated_at_ms, Some(1_792_000_000_000));
}

#[test]
fn contract_audit_quota_google_model_array_uses_native_names_percentages_and_observation_seconds() {
    let fixture = Fixture::new();
    fixture.write("accounts/member.json", serde_json::json!({"email":"member@example.invalid", "quota":{
        "last_updated":1_792_000_000i64, "models":[
            {"name":"gemini-pro","display_name":"Gemini Pro","percentage":75,"reset_time":"2026-11-08T00:00:00Z"},
            {"name":"claude-sonnet","percentage":0,"reset_time":""}
        ]}}));
    let accounts = ChannelAccounts::load(&fixture.0, CH_ANTIGRAVITY).unwrap();
    let rows = SnapshotProvider{now_ms:1_792_000_001_000}.fetch(&accounts).unwrap();
    assert_eq!(rows.len(), 2);
    let pro = rows.iter().find(|row| row.model_id == "gemini-pro").unwrap();
    assert_eq!(pro.percent, Some(75.0));
    assert_eq!(pro.display_name, "Gemini Pro");
    assert_eq!(pro.updated_at_ms, Some(1_792_000_000_000));
    assert_eq!(pro.scope, "model");
    assert!(pro.reset_at_ms.is_some());
    assert_eq!(rows.iter().find(|row| row.model_id == "claude-sonnet").unwrap().percent, Some(0.0));
}

#[test]
fn contract_audit_quota_cursor_reads_native_plan_percent_used_fields() {
    let fixture = Fixture::new();
    fixture.write("cursor_accounts/member.json", serde_json::json!({"usage_updated_at":1_792_000_000i64,
        "cursor_usage_raw":{"individualUsage":{"plan":{
            "totalPercentUsed":25.0,"autoPercentUsed":10.0,"apiPercentUsed":40.0
        }}}}));
    let accounts = ChannelAccounts::load(&fixture.0, CH_CURSOR).unwrap();
    let rows = SnapshotProvider{now_ms:1_792_000_001_000}.fetch(&accounts).unwrap();
    assert_eq!(rows.len(), 3);
    for (id, remaining) in [("total_usage",75.0),("auto_composer",90.0),("api_usage",60.0)] {
        let row = rows.iter().find(|row| row.model_id == id).unwrap();
        assert_eq!(row.percent, Some(remaining));
        assert_eq!(row.updated_at_ms, Some(1_792_000_000_000));
    }
}

#[test]
fn contract_audit_quota_cursor_legacy_plan_ratio_does_not_fabricate_missing_component_percentages() {
    let fixture = Fixture::new();
    fixture.write("cursor_accounts/member.json", serde_json::json!({"cursor_usage_raw":{"plan_usage":{
        "used":20.0,"limit":100.0,"auto_percent_used":"10"
    }}}));
    let accounts = ChannelAccounts::load(&fixture.0, CH_CURSOR).unwrap();
    let rows = SnapshotProvider{now_ms:1_792_000_001_000}.fetch(&accounts).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows.iter().find(|row| row.model_id == "total_usage").unwrap().percent, Some(80.0));
    assert_eq!(rows.iter().find(|row| row.model_id == "auto_composer").unwrap().percent, Some(90.0));
    assert!(rows.iter().all(|row| row.model_id != "api_usage"));
}

#[test]
fn contract_audit_quota_claude_desktop_raw_wrapper_preserves_fraction_and_one_percent_distinction() {
    let fixture = Fixture::new();
    fixture.write("claude_accounts/member.json", serde_json::json!({"usage_updated_at":1_792_000_000_000i64,
        "claude_usage_raw":{"endpoints":{"organizationUsage":{
            "five_hour":{"utilization":1,"resets_at":"2026-11-08T00:00:00Z"},
            "sevenDay":{"utilization":0.88,"resetsAt":1_792_600_000i64}
        }}}}));
    let accounts = ChannelAccounts::load(&fixture.0, CH_CLAUDE).unwrap();
    let rows = SnapshotProvider{now_ms:1_792_000_001_000}.fetch(&accounts).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows.iter().find(|row| row.model_id == "five_hour").unwrap().percent, Some(99.0));
    let week = rows.iter().find(|row| row.model_id == "seven_day").unwrap();
    assert_eq!(week.percent, Some(12.0));
    assert_eq!(week.reset_at_ms, Some(1_792_600_000_000));
}

#[test]
fn contract_audit_quota_claude_native_flat_snapshot_does_not_turn_absent_default_zero_into_free_quota() {
    let fixture = Fixture::new();
    fixture.write("claude_accounts/member.json", serde_json::json!({"quota":{
        "five_hour_percentage":42,"five_hour_reset_time":1_792_010_000i64,
        "seven_day_percentage":0,"seven_day_sonnet_percentage":9
    }}));
    let accounts = ChannelAccounts::load(&fixture.0, CH_CLAUDE).unwrap();
    let rows = SnapshotProvider{now_ms:1_792_000_001_000}.fetch(&accounts).unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows.iter().find(|row| row.model_id == "five_hour").unwrap().percent, Some(58.0));
    assert_eq!(rows.iter().find(|row| row.model_id == "seven_day_sonnet").unwrap().percent, Some(91.0));
    assert!(rows.iter().all(|row| row.model_id != "seven_day"));
}

#[test]
fn contract_audit_quota_claude_current_limits_array_preserves_pool_scope_and_ignores_money_fields() {
    let fixture = Fixture::new();
    fixture.write("claude_accounts/member.json", serde_json::json!({"claude_usage_raw":{"endpoints":{"organizationUsage":{
        "limits":[
            {"kind":"session","group":"session","percent":42.4},
            {"kind":"weekly","group":"weekly","percent":18},
            {"kind":"weekly","group":"weekly","percent":"9","scope":{"model":{"display_name":"Claude Sonnet"}}}
        ], "extra_usage":{"is_enabled":true,"utilization":12,"used_credits":1234,"monthly_limit":5000}
    }}}}));
    let accounts = ChannelAccounts::load(&fixture.0, CH_CLAUDE).unwrap();
    let rows = SnapshotProvider{now_ms:1_792_000_001_000}.fetch(&accounts).unwrap();
    assert_eq!(rows.len(), 4);
    for (id, remaining) in [("five_hour",58.0),("seven_day",82.0),("seven_day_sonnet",91.0),("extra_usage",88.0)] {
        let row = rows.iter().find(|row| row.model_id == id).unwrap();
        assert_eq!(row.percent, Some(remaining));
        assert_eq!(row.scope, "pool");
    }
}

#[test]
fn contract_audit_quota_claude_oauth_raw_fraction_is_not_a_desktop_fraction() {
    let fixture = Fixture::new();
    fixture.write("claude_accounts/member.json", serde_json::json!({"claude_usage_raw":{
        "five_hour":{"utilization":0.88},"seven_day":{"utilization":1}
    }}));
    let accounts = ChannelAccounts::load(&fixture.0, CH_CLAUDE).unwrap();
    let rows = SnapshotProvider{now_ms:1_792_000_001_000}.fetch(&accounts).unwrap();
    assert_eq!(rows.iter().find(|row| row.model_id == "five_hour").unwrap().percent, Some(99.12));
    assert_eq!(rows.iter().find(|row| row.model_id == "seven_day").unwrap().percent, Some(99.0));
}
