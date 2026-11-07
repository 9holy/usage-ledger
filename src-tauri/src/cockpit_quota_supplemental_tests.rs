//! Follow-up production contracts pinned to jlcodes99/cockpit-tools
//! 820e176842d440a60e650729c3a39932b76a0ccb. Fixtures contain no real accounts.
//! These tests call the existing public reader, so they also compile against v0.2.38.
use super::*;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};

const NOW: i64 = 1_792_000_001_000;
const OBSERVED: i64 = 1_792_000_000_000;
const RESET: i64 = 1_792_010_000_000;
static NEXT: AtomicUsize = AtomicUsize::new(0);

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!(
            "cockpit-quota-supplemental-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        )))
    }
    fn write(&self, path: &str, value: Value) {
        let path = self.0.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    }
    fn rows(&self, channel: &str) -> Vec<QuotaSnapshot> {
        let accounts = ChannelAccounts::load(&self.0, channel).unwrap();
        SnapshotProvider { now_ms: NOW }.fetch(&accounts).unwrap()
    }
    fn account(&self, channel: &str, mut value: Value) {
        value["id"] = json!("member");
        value["email"] = json!("member@example.invalid");
        let dir = match channel {
            CH_TRAE | CH_TRAE_CN | CH_TRAE_SOLO | CH_TRAE_SOLO_CN => {
                self.write("trae_accounts.json", json!({"accounts":[{"id":"member",
                    "email":"member@example.invalid", "query_identity":{"version":1,"platform":channel}}]}));
                "trae_accounts".to_string()
            }
            _ => accounts_dir_name(channel),
        };
        self.write(&format!("{dir}/member.json"), value);
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn row<'a>(rows: &'a [QuotaSnapshot], id: &str) -> &'a QuotaSnapshot {
    rows.iter()
        .find(|row| row.model_id == id)
        .unwrap_or_else(|| panic!("missing quota pool {id}; actual rows: {rows:?}"))
}

fn assert_percent(rows: &[QuotaSnapshot], id: &str, percent: f64) {
    assert_eq!(row(rows, id).percent, Some(percent));
}

fn encrypted() -> Value {
    json!({"version":1,"kind":"trae_account","algorithm":"AES-256-GCM",
        "key_id":"fixture","nonce":"AAAAAAAAAAAAAAAA","ciphertext":"fixture-only","encrypted_at":1792000000})
}

#[test]
fn supplemental_contract_trae_plaintext_query_identity_partitions_all_four_platforms() {
    let fixture = Fixture::new();
    let channels = [CH_TRAE, CH_TRAE_SOLO, CH_TRAE_CN, CH_TRAE_SOLO_CN];
    fixture.write(
        "trae_accounts.json",
        json!({"accounts":channels.iter().enumerate().map(|(i, channel)|
        json!({"id":format!("member-{i}"), "email":format!("member-{i}@example.invalid"),
            "query_identity":{"version":1,"platform":channel}})).collect::<Vec<_>>()}),
    );
    for i in 0..4 {
        fixture.write(&format!("trae_accounts/member-{i}.json"), encrypted());
    }
    let mut all_ids = Vec::new();
    for (i, channel) in channels.iter().enumerate() {
        let accounts = ChannelAccounts::load(&fixture.0, channel).unwrap();
        assert_eq!(
            accounts.accounts.len(),
            1,
            "one physical Trae directory must not duplicate all accounts into every channel"
        );
        assert_eq!(accounts.accounts[0].id, format!("member-{i}"));
        all_ids.push(accounts.accounts[0].id.clone());
    }
    all_ids.sort();
    all_ids.dedup();
    assert_eq!(all_ids.len(), 4);
}

#[test]
fn supplemental_contract_trae_unknown_identity_version_cannot_be_called_international() {
    let fixture = Fixture::new();
    fixture.write(
        "trae_accounts.json",
        json!({"accounts":[{"id":"member",
        "query_identity":{"version":2,"platform":"trae_cn"}}]}),
    );
    fixture.write("trae_accounts/member.json", encrypted());
    assert!(
        ChannelAccounts::load(&fixture.0, CH_TRAE).is_err(),
        "unsupported identity needs an explicit source error, not a guessed channel"
    );
}

#[test]
fn supplemental_contract_trae_legacy_plaintext_platform_is_not_counted_twice() {
    let fixture = Fixture::new();
    fixture.write(
        "trae_accounts/member.json",
        json!({"id":"member",
        "trae_usage_raw":{"platform_id":"trae_solo_cn"}}),
    );
    assert!(ChannelAccounts::load(&fixture.0, CH_TRAE)
        .unwrap()
        .accounts
        .is_empty());
    let accounts = ChannelAccounts::load(&fixture.0, CH_TRAE_SOLO_CN).unwrap();
    assert_eq!(accounts.accounts.len(), 1);
}

fn trae_pack(id: &str, quota: Value, usage: Value) -> Value {
    json!({"status":1,"entitlement_base_info":{"entitlement_id":id,"end_time":1792009999i64,"quota":quota},"usage":usage})
}

#[test]
fn supplemental_contract_trae_credit_pack_uses_credits_not_legacy_dollar_fields() {
    let fixture = Fixture::new();
    fixture.account(CH_TRAE, json!({"usage_updated_at":1792000000i64,
        "trae_usage_raw":{"code":0,"data":{"is_credits_billing":true,"user_entitlement_pack_list":[
            trae_pack("subscription", json!({"credits_limit":200,"basic_usage_limit":1}), json!({"credits_amount":50,"basic_usage_amount":1}))
        ]}}}));
    let rows = fixture.rows(CH_TRAE);
    assert_eq!(rows.len(), 1);
    assert_percent(&rows, "credits:subscription", 75.0);
    assert_eq!(rows[0].updated_at_ms, Some(OBSERVED));
    assert_eq!(rows[0].reset_at_ms, Some(RESET));
}

#[test]
fn supplemental_contract_trae_cn_fast_request_payload_has_nested_quota_and_reset() {
    let fixture = Fixture::new();
    fixture.account(CH_TRAE_CN, json!({"usage_updated_at":1792000000i64,"trae_usage_raw":{
        "code":0,"user_current_entitlement_list":{"_cockpit_source":"user_current_entitlement_list",
        "user_entitlement_pack_list":[{"status":1,"entitlement_base_info":{"entitlement_id":"fast",
            "end_time":1792009999i64,"product_extra":{"package_extra":{"quota":{"premium_model_fast_request_limit":1000}}}},
            "usage":{"premium_model_fast_amount":250}}]}}}));
    let rows = fixture.rows(CH_TRAE_CN);
    assert_percent(&rows, "fast_requests:fast", 75.0);
    assert_eq!(rows[0].reset_at_ms, Some(RESET));
}

#[test]
fn supplemental_contract_trae_legacy_budgets_keep_base_and_bonus_denominators_separate() {
    let fixture = Fixture::new();
    fixture.account(CH_TRAE_SOLO, json!({"trae_usage_raw":{"code":0,"Result":{"user_entitlement_pack_list":[
        trae_pack("pro", json!({"basic_usage_limit":20,"bonus_usage_limit":10}), json!({"basic_usage_amount":5,"bonus_usage_amount":8}))
    ]}}}));
    let rows = fixture.rows(CH_TRAE_SOLO);
    assert_eq!(rows.len(), 2);
    assert_percent(&rows, "basic_usage:pro", 75.0);
    assert_percent(&rows, "bonus_usage:pro", 20.0);
}

#[test]
fn supplemental_contract_trae_missing_used_or_unlimited_is_not_a_finite_full_balance() {
    let fixture = Fixture::new();
    fixture.account(
        CH_TRAE,
        json!({"trae_usage_raw":{"is_credits_billing":true,"user_entitlement_pack_list":[
            trae_pack("missing", json!({"credits_limit":200}), json!({})),
            trae_pack("unlimited", json!({"credits_limit":-1}), json!({"credits_amount":50}))
        ]}}),
    );
    assert!(fixture
        .rows(CH_TRAE)
        .iter()
        .all(|row| row.percent.is_none()));
}

#[test]
fn supplemental_contract_windsurf_plan_status_retains_daily_weekly_remaining_and_unix_resets() {
    let fixture = Fixture::new();
    fixture.account(CH_WINDSURF, json!({"usage_updated_at":1792000000i64,
        "windsurf_plan_status":{"planStatus":{"dailyQuotaRemainingPercent":12.5,"weeklyQuotaRemainingPercent":80,
            "dailyQuotaResetAtUnix":"1792010000","weeklyQuotaResetAtUnix":1792600000i64}},
        "copilot_quota_snapshots":{"windsurfPlanStatus":{"dailyQuotaRemainingPercent":12.5,"weeklyQuotaRemainingPercent":80,
            "dailyQuotaResetAtUnix":"1792010000","weeklyQuotaResetAtUnix":1792600000i64}}}));
    let rows = fixture.rows(CH_WINDSURF);
    assert_eq!(rows.len(), 2);
    assert_percent(&rows, "daily_quota", 12.5);
    assert_percent(&rows, "weekly_quota", 80.0);
    assert_eq!(row(&rows, "daily_quota").reset_at_ms, Some(RESET));
    assert_eq!(
        row(&rows, "weekly_quota").window_kind,
        QuotaWindowKind::Weekly
    );
    assert_eq!(rows[0].updated_at_ms, Some(OBSERVED));
}

#[test]
fn supplemental_contract_windsurf_devin_quota_usage_aliases_are_read() {
    let fixture = Fixture::new();
    fixture.account(
        CH_WINDSURF,
        json!({"windsurf_plan_status":{"quotaUsage":{
        "dailyRemainingPercent":60,"weeklyRemainingPercent":90,"dailyResetAtUnix":1792010000i64}}}),
    );
    let rows = fixture.rows(CH_WINDSURF);
    assert_percent(&rows, "daily_quota", 60.0);
    assert_percent(&rows, "weekly_quota", 90.0);
    assert_eq!(row(&rows, "daily_quota").reset_at_ms, Some(RESET));
}

#[test]
fn supplemental_contract_windsurf_hidden_quota_is_not_a_zero_or_full_pool() {
    let fixture = Fixture::new();
    fixture.account(
        CH_WINDSURF,
        json!({"windsurf_plan_status":{
        "dailyQuotaRemainingPercent":0,"weeklyQuotaRemainingPercent":70,
        "planInfo":{"hideDailyQuota":true,"hideWeeklyQuota":false}}}),
    );
    let rows = fixture.rows(CH_WINDSURF);
    assert_eq!(rows.len(), 1);
    assert_percent(&rows, "weekly_quota", 70.0);
}

#[test]
fn supplemental_contract_windsurf_credits_available_field_is_total_not_remaining() {
    let fixture = Fixture::new();
    fixture.account(
        CH_WINDSURF,
        json!({"windsurf_plan_status":{
        "availablePromptCredits":10000,"usedPromptCredits":2500,
        "planInfo":{"monthlyPromptCredits":10000},"planEnd":{"seconds":"1792010000"}}}),
    );
    let rows = fixture.rows(CH_WINDSURF);
    assert_percent(&rows, "prompt_credits", 75.0);
    assert_eq!(rows[0].reset_at_ms, Some(RESET));
}

fn official_resource(id: &str) -> Value {
    json!({"ResourceId":id,"PackageCode":"TCACA_code_002_AkiJS3ZHF5","Status":0,
        "CycleCapacitySizePrecise":"1000.5","CycleCapacityRemainPrecise":"750.375",
        "CycleCapacitySize":1,"CycleCapacityRemain":0,"CycleResetTime":"1792010000"})
}

#[test]
fn supplemental_contract_codebuddy_wrapped_official_resources_prefer_precise_cycle_fields() {
    let fixture = Fixture::new();
    fixture.account(CH_CODEBUDDY, json!({"usage_updated_at":1792000000i64,
        "quota_raw":{"userResource":{"data":{"Response":{"Data":{"Accounts":[official_resource("resource-a")]}}}}}}));
    let rows = fixture.rows(CH_CODEBUDDY);
    assert_percent(&rows, "resource:resource-a", 75.0);
    assert_eq!(rows[0].reset_at_ms, Some(RESET));
    assert_eq!(rows[0].updated_at_ms, Some(OBSERVED));
}

#[test]
fn supplemental_contract_codebuddy_cn_enterprise_wrapper_preserves_capacity_and_cycle() {
    let fixture = Fixture::new();
    fixture.account(CH_CODEBUDDY_CN, json!({"usage_raw":{"code":0,"data":{"Response":{"Data":{"Accounts":[{
        "PackageCode":"enterprise","PackageName":"企业版","Status":0,"Unlimited":false,
        "CycleCapacitySizePrecise":"2000","CycleCapacityRemainPrecise":"500","CycleCapacityUsedPrecise":"1500",
        "CycleResetTime":"2026-10-14T20:46:40Z"}]}}}}}));
    let rows = fixture.rows(CH_CODEBUDDY_CN);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].percent, Some(25.0));
    assert_eq!(rows[0].reset_at_ms, Some(1_792_010_800_000));
}

#[test]
fn supplemental_contract_workbuddy_paginated_resources_do_not_read_summary_as_another_pool() {
    let fixture = Fixture::new();
    fixture.account(
        CH_WORKBUDDY,
        json!({"usage_updated_at":1792000000i64,"usage_raw":{"code":0,"data":{
        "resources":[official_resource("paid-a")],
        "resourceSummary":{"Packages":[{"remaining":999999,"total":999999}]}}}}),
    );
    let rows = fixture.rows(CH_WORKBUDDY);
    assert_eq!(rows.len(), 1);
    assert_percent(&rows, "resource:paid-a", 75.0);
    assert_eq!(rows[0].updated_at_ms, Some(OBSERVED));
}

#[test]
fn supplemental_contract_workbuddy_capacity_type_four_uses_requested_day_slice() {
    let fixture = Fixture::new();
    fixture.account(CH_WORKBUDDY, json!({"quota_raw":{"userResource":{"data":{"resources":[{
        "ResourceId":"daily","PackageCode":"daily","Status":0,"CapacityType":4,
        "CycleCapacitySizePrecise":"999","CycleCapacityRemainPrecise":"999",
        "SlicePeriodUsageDetails":[{"SlicePeriodCapacitySizePrecise":"100","SlicePeriodCapacityRemainPrecise":"20"}]
    }]}}}}));
    let rows = fixture.rows(CH_WORKBUDDY);
    assert_percent(&rows, "resource:daily", 20.0);
}

#[test]
fn supplemental_contract_codebuddy_credits_array_preserves_remaining_semantics() {
    let fixture = Fixture::new();
    fixture.account(
        CH_CODEBUDDY,
        json!({"usage_raw":{"data":{"resources":[{
            "commodity_code":"pro","name":"Pro","total":200,"remaining":50,"expire_at":1792010000i64
        }]}}}),
    );
    let rows = fixture.rows(CH_CODEBUDDY);
    assert_eq!(rows[0].percent, Some(25.0));
    // An expiry is not a proved recurring refresh time.
    assert_eq!(rows[0].reset_at_ms, None);
}

#[test]
fn supplemental_contract_codebuddy_direct_enterprise_response_reads_credit_as_used() {
    let fixture = Fixture::new();
    fixture.account(
        CH_CODEBUDDY_CN,
        json!({"usage_raw":{"code":0,"data":{
        "limitNum":400,"credit":100,"cycleResetTime":1792010000i64}}}),
    );
    let rows = fixture.rows(CH_CODEBUDDY_CN);
    assert_eq!(rows[0].percent, Some(75.0));
    assert_eq!(rows[0].reset_at_ms, Some(RESET));
}

#[test]
fn supplemental_contract_buddy_missing_remaining_inactive_and_unlimited_never_become_full_quota() {
    let fixture = Fixture::new();
    fixture.account(CH_WORKBUDDY, json!({"usage_raw":{"data":{"resources":[
        {"PackageCode":"missing","Status":0,"CycleCapacitySizePrecise":"100"},
        {"PackageCode":"expired","Status":2,"CycleCapacitySizePrecise":"100","CycleCapacityRemainPrecise":"100"},
        {"PackageCode":"unlimited","Status":0,"Unlimited":true,"CycleCapacitySizePrecise":"-1","CycleCapacityRemainPrecise":"-1"}
    ]}}}));
    assert!(fixture
        .rows(CH_WORKBUDDY)
        .iter()
        .all(|row| row.percent.is_none()));
}

#[test]
fn supplemental_contract_zed_current_users_me_payload_reads_edit_predictions() {
    let fixture = Fixture::new();
    fixture.account(CH_ZED, json!({"user_raw":{"plan":{"usage":{"edit_predictions":{"used":250,"limit":1000}},
        "subscription_period":{"ended_at":"2026-10-14T20:33:20Z"}}},"usage_raw":{},"usage_tokens_raw":{},"last_used":1792000000i64}));
    let rows = fixture.rows(CH_ZED);
    assert_percent(&rows, "edit_predictions", 75.0);
    assert_eq!(rows[0].reset_at_ms, Some(RESET));
    assert_eq!(
        rows[0].updated_at_ms, None,
        "last_used is not a quota observation timestamp"
    );
}

#[test]
fn supplemental_contract_zed_persisted_flat_fields_and_usage_timestamp_are_seconds() {
    let fixture = Fixture::new();
    fixture.account(
        CH_ZED,
        json!({"edit_predictions_used":200,"edit_predictions_limit_raw":"1000",
        "billing_period_end_at":1792010000i64,"usage_updated_at":1792000000i64}),
    );
    let rows = fixture.rows(CH_ZED);
    assert_percent(&rows, "edit_predictions", 80.0);
    assert_eq!(rows[0].updated_at_ms, Some(OBSERVED));
    assert_eq!(rows[0].reset_at_ms, Some(RESET));
}

#[test]
fn supplemental_contract_zed_legacy_token_budget_is_only_a_quota_ratio() {
    let fixture = Fixture::new();
    fixture.account(
        CH_ZED,
        json!({"token_spend_used_cents":250,"token_spend_limit_cents":1000,
        "token_spend_remaining_cents":750,"edit_predictions_limit_raw":"unlimited"}),
    );
    let rows = fixture.rows(CH_ZED);
    assert_eq!(rows.len(), 1);
    assert_percent(&rows, "token_spend", 75.0);
}

#[test]
fn supplemental_contract_zed_unlimited_or_missing_used_cannot_be_zero_consumption() {
    let fixture = Fixture::new();
    fixture.account(
        CH_ZED,
        json!({"edit_predictions_limit_raw":"unlimited",
        "edit_predictions_used":999,"token_spend_limit_cents":1000}),
    );
    assert!(fixture.rows(CH_ZED).iter().all(|row| row.percent.is_none()));
}

#[test]
fn supplemental_contract_qoder_hybrid_envelope_keeps_personal_and_addon_buckets_separate() {
    let fixture = Fixture::new();
    fixture.account(CH_QODER, json!({"usage_updated_at":1792000000i64,"auth_credit_usage_raw":{
        "displayMode":"hybrid","qoderUsage":{"userQuota":{"used":25,"total":100,"percentage":25},
            "addOnQuota":{"used":10,"total":50,"percentage":20},"resetAt":1792010000i64},
        "enterpriseUsage":{"detailUrl":"https://example.invalid/usage","used":999,"percentage":99}}}));
    let rows = fixture.rows(CH_QODER);
    assert_eq!(rows.len(), 2);
    assert_percent(&rows, "credits", 75.0);
    assert_percent(&rows, "add_on_credits", 80.0);
    assert_eq!(row(&rows, "credits").reset_at_ms, Some(RESET));
}

#[test]
fn supplemental_contract_qoder_enterprise_mode_does_not_reuse_stale_personal_scalar() {
    let fixture = Fixture::new();
    fixture.account(CH_QODER, json!({"credits_usage_percent":25,"credits_total":100,"credits_used":25,
        "auth_credit_usage_raw":{"displayMode":"enterprise","qoderUsage":{"userQuota":{"percentage":25}},
            "enterpriseUsage":{"detailUrl":"https://example.invalid/usage"}}}));
    assert!(fixture
        .rows(CH_QODER)
        .iter()
        .all(|row| row.percent.is_none()));
}

#[test]
fn supplemental_contract_qoder_legacy_raw_bucket_percentage_means_used() {
    let fixture = Fixture::new();
    fixture.account(
        CH_QODER,
        json!({"auth_credit_usage_raw":{"userQuota":{"used":40,"total":100,"percentage":40}}}),
    );
    assert_percent(&fixture.rows(CH_QODER), "credits", 60.0);
}

#[test]
fn supplemental_contract_qoder_unlimited_and_missing_denominator_are_not_fabricated_balances() {
    let fixture = Fixture::new();
    fixture.account(
        CH_QODER,
        json!({"auth_credit_usage_raw":{"displayMode":"personal","qoderUsage":{
        "userQuota":{"used":40},"addOnQuota":{"used":5,"total":-1}}}}),
    );
    assert!(fixture
        .rows(CH_QODER)
        .iter()
        .all(|row| row.percent.is_none()));
}

fn cursor_account(period: Value, reset: Value) -> Value {
    json!({"usage_updated_at":1792000000i64,"cursor_usage_raw":{"individualUsage":{"plan":{"totalPercentUsed":25}},
        "planInfo":{"includedUsagePeriod":period,"includedUsageResetsAt":reset},"billingCycleEnd":1792600000000i64}})
}

#[test]
fn supplemental_contract_cursor_weekly_included_reset_is_milliseconds() {
    let fixture = Fixture::new();
    fixture.account(CH_CURSOR, cursor_account(json!(2), json!(RESET)));
    let rows = fixture.rows(CH_CURSOR);
    assert_percent(&rows, "total_usage", 75.0);
    assert_eq!(rows[0].window_kind, QuotaWindowKind::Weekly);
    assert_eq!(rows[0].reset_at_ms, Some(RESET));
}

#[test]
fn supplemental_contract_cursor_explicit_monthly_uses_billing_cycle_not_weekly_reset() {
    let fixture = Fixture::new();
    fixture.account(CH_CURSOR, cursor_account(json!("monthly"), json!(RESET)));
    let rows = fixture.rows(CH_CURSOR);
    assert_eq!(rows[0].window_kind, QuotaWindowKind::Monthly);
    assert_eq!(rows[0].reset_at_ms, Some(1_792_600_000_000));
}

#[test]
fn supplemental_contract_cursor_reset_without_period_remains_unknown_duration() {
    let fixture = Fixture::new();
    fixture.account(
        CH_CURSOR,
        cursor_account(Value::Null, json!("1792010000000")),
    );
    let rows = fixture.rows(CH_CURSOR);
    assert_eq!(rows[0].reset_at_ms, Some(RESET));
    assert_eq!(
        rows[0].window_kind,
        QuotaWindowKind::Unknown,
        "a timestamp alone does not prove a seven-day period"
    );
}

fn google_with_cache(cache_time: Option<i64>, snapshot_time: i64) -> Fixture {
    let fixture = Fixture::new();
    fixture.account(
        CH_ANTIGRAVITY,
        json!({"quota":{"last_updated":snapshot_time,"models":[{
        "name":"gemini-pro","percentage":80,"reset_time":"2026-10-14T20:33:20Z"}]}}),
    );
    fixture.write(
        &format!("{SUBDIR_QUOTA_DESKTOP}/{}.json", "c".repeat(64)),
        json!({
        "version":1,"source":"authorized","email":"member@example.invalid","updatedAt":cache_time,
        "payload":{"models":{"gemini-pro":{"quotaInfo":{"remainingFraction":0.1}}}}}),
    );
    fixture
}

#[test]
fn supplemental_contract_newer_google_account_quota_beats_legacy_desktop_cache() {
    let fixture = google_with_cache(Some(OBSERVED - 600000), OBSERVED / 1000);
    let rows = fixture.rows(CH_ANTIGRAVITY);
    assert_eq!(
        rows.len(),
        1,
        "older cache must not reappear as a second unowned account"
    );
    assert_percent(&rows, "gemini-pro", 80.0);
    assert_eq!(rows[0].updated_at_ms, Some(OBSERVED));
    assert_eq!(rows[0].raw_kind, "AccountSnapshot");
}

#[test]
fn supplemental_contract_equal_google_cache_timestamp_keeps_native_account_quota() {
    let fixture = google_with_cache(Some(OBSERVED), OBSERVED / 1000);
    let rows = fixture.rows(CH_ANTIGRAVITY);
    assert_percent(&rows, "gemini-pro", 80.0);
}

#[test]
fn supplemental_contract_undated_google_legacy_cache_cannot_override_dated_native_quota() {
    let fixture = google_with_cache(None, OBSERVED / 1000);
    assert_percent(&fixture.rows(CH_ANTIGRAVITY), "gemini-pro", 80.0);
}

#[test]
fn supplemental_contract_newer_google_cache_remains_a_supported_compatibility_source() {
    let fixture = google_with_cache(Some(OBSERVED), (OBSERVED - 600000) / 1000);
    let rows = fixture.rows(CH_ANTIGRAVITY);
    assert_percent(&rows, "gemini-pro", 10.0);
    assert_eq!(rows[0].updated_at_ms, Some(OBSERVED));
}

#[test]
fn supplemental_contract_buddy_retained_refresh_error_preserves_old_observation_time() {
    let fixture = Fixture::new();
    fixture.account(
        CH_WORKBUDDY,
        json!({"usage_updated_at":1792000000i64,
        "quota_query_last_error":"fixture transport error", "quota_query_last_error_at":NOW,
        "usage_raw":{"data":{"resources":[official_resource("resource-a")]}}}),
    );
    let rows = fixture.rows(CH_WORKBUDDY);
    assert_percent(&rows, "resource:resource-a", 75.0);
    assert_eq!(rows[0].updated_at_ms, Some(OBSERVED));
    assert!(rows[0].stale);
    assert!(rows[0].source_error.is_some());
}

// quota.rs::build_quota_data_from_response appends real summary buckets to models[];
// preserve_failed_quota_summary deliberately preserves their older observation age.
fn google_summary_account(stale: bool, summary_time: Option<i64>) -> Value {
    json!({"quota":{"last_updated":1792000000i64,"project_id":"project-a",
        "quota_summary_stale":stale,"quota_summary_updated_at":summary_time,
        "models":[{"name":"gemini-pro","percentage":80,"reset_time":"2026-10-14T20:33:20Z"},
            {"name":"3p-5h","percentage":30,"reset_time":"2026-10-14T20:33:20Z"},
            {"name":"gemini:weekly","percentage":60,"reset_time":"2026-10-14T20:33:20Z"}]}})
}

#[test]
fn supplemental_google_native_summary_buckets_are_pools_with_proved_periods() {
    let fixture = Fixture::new();
    fixture.account(
        CH_ANTIGRAVITY,
        google_summary_account(false, Some(1792000000)),
    );
    let rows = fixture.rows(CH_ANTIGRAVITY);
    assert_eq!(row(&rows, "3p-5h").scope, "pool");
    assert_eq!(row(&rows, "3p-5h").window_kind, QuotaWindowKind::FiveHour);
    assert_eq!(
        row(&rows, "gemini:weekly").window_kind,
        QuotaWindowKind::Weekly
    );
    assert_eq!(row(&rows, "gemini-pro").scope, "model");
    assert_eq!(
        row(&rows, "gemini-pro").window_kind,
        QuotaWindowKind::Unknown
    );
}

#[test]
fn supplemental_google_failed_summary_keeps_old_time_while_model_observation_is_fresh() {
    let fixture = Fixture::new();
    fixture.account(
        CH_ANTIGRAVITY,
        google_summary_account(true, Some(1791000000)),
    );
    let rows = fixture.rows(CH_ANTIGRAVITY);
    let pool = row(&rows, "3p-5h");
    assert_eq!(pool.updated_at_ms, Some(1_791_000_000_000));
    assert!(pool.stale);
    assert!(pool.source_error.is_some());
    let model = row(&rows, "gemini-pro");
    assert_eq!(model.updated_at_ms, Some(OBSERVED));
    assert!(!model.stale);
    assert!(model.source_error.is_none());
}

#[test]
fn supplemental_google_retained_summary_without_timestamp_is_not_refreshed_by_model_time() {
    let fixture = Fixture::new();
    fixture.account(CH_ANTIGRAVITY, google_summary_account(true, None));
    let rows = fixture.rows(CH_ANTIGRAVITY);
    assert_eq!(row(&rows, "3p-5h").updated_at_ms, None);
    assert!(row(&rows, "3p-5h").stale);
}

fn write_google_v2_cache(fixture: &Fixture, project: Value, version: i32, source: &str) {
    fixture.write(
        &format!("{SUBDIR_QUOTA_DESKTOP}/{}.json", "d".repeat(64)),
        json!({
        "version":version,"source":source,"customSource":"desktop","projectId":project,
        "email":"member@example.invalid","updatedAt":OBSERVED + 100,
        "payload":{"models":{"gemini-pro":{"quotaInfo":{"remainingFraction":0.2}}},
            "quota_summary":{"groups":[{"buckets":[{"bucketId":"3p-5h","remainingFraction":0.7,
                "resetTime":"2026-10-14T20:33:20Z"}]}]}}}),
    );
}

#[test]
fn supplemental_google_current_v2_cache_preserves_models_and_summary_observation() {
    let fixture = Fixture::new();
    fixture.account(
        CH_ANTIGRAVITY,
        google_summary_account(false, Some(1792000000)),
    );
    write_google_v2_cache(&fixture, json!("project-a"), 2, "authorized");
    let rows = fixture.rows(CH_ANTIGRAVITY);
    assert_eq!(rows.len(), 2);
    assert_percent(&rows, "gemini-pro", 20.0);
    assert_percent(&rows, "3p-5h", 70.0);
    assert!(rows
        .iter()
        .all(|row| row.updated_at_ms == Some(OBSERVED + 100)));
}

#[test]
fn supplemental_google_newer_cache_from_a_different_project_cannot_override_account() {
    let fixture = Fixture::new();
    fixture.account(
        CH_ANTIGRAVITY,
        google_summary_account(false, Some(1792000000)),
    );
    write_google_v2_cache(&fixture, json!("project-b"), 2, "authorized");
    let rows = fixture.rows(CH_ANTIGRAVITY);
    assert_eq!(rows.len(), 3);
    assert_percent(&rows, "gemini-pro", 80.0);
    assert!(rows.iter().all(|row| row.account_id == "member"));
}

#[test]
fn supplemental_google_explicit_no_project_is_not_the_same_as_another_project() {
    let fixture = Fixture::new();
    let mut account = google_summary_account(false, Some(1792000000));
    account["quota"]["project_id"] = Value::Null;
    fixture.account(CH_ANTIGRAVITY, account);
    write_google_v2_cache(&fixture, json!("project-b"), 2, "authorized");
    assert_percent(&fixture.rows(CH_ANTIGRAVITY), "gemini-pro", 80.0);
}

#[test]
fn supplemental_google_unknown_cache_version_is_an_explicit_source_error() {
    let fixture = Fixture::new();
    fixture.account(CH_ANTIGRAVITY, json!({}));
    write_google_v2_cache(&fixture, Value::Null, 99, "authorized");
    let accounts = ChannelAccounts::load(&fixture.0, CH_ANTIGRAVITY).unwrap();
    assert!(SnapshotProvider { now_ms: NOW }.fetch(&accounts).is_err());
}

#[test]
fn supplemental_google_cache_source_mismatch_is_an_explicit_source_error() {
    let fixture = Fixture::new();
    fixture.account(CH_ANTIGRAVITY, json!({}));
    write_google_v2_cache(&fixture, Value::Null, 2, "different-source");
    let accounts = ChannelAccounts::load(&fixture.0, CH_ANTIGRAVITY).unwrap();
    assert!(SnapshotProvider { now_ms: NOW }.fetch(&accounts).is_err());
}

#[test]
fn supplemental_google_fresh_model_only_cache_does_not_discard_producer_retained_stale_windows() {
    let fixture = Fixture::new();
    fixture.account(
        CH_ANTIGRAVITY,
        google_summary_account(true, Some(1791000000)),
    );
    fixture.write(
        &format!("{SUBDIR_QUOTA_DESKTOP}/{}.json", "e".repeat(64)),
        json!({
        "version":2,"source":"authorized","customSource":"desktop","projectId":"project-a",
        "email":"member@example.invalid","updatedAt":OBSERVED+100,
        "payload":{"models":{"gemini-pro":{"quotaInfo":{"remainingFraction":0.2}}}}}),
    );
    let rows = fixture.rows(CH_ANTIGRAVITY);
    assert_eq!(rows.len(), 3);
    assert_percent(&rows, "gemini-pro", 20.0);
    assert_eq!(row(&rows, "gemini-pro").updated_at_ms, Some(OBSERVED + 100));
    assert_eq!(row(&rows, "3p-5h").updated_at_ms, Some(1_791_000_000_000));
    assert!(row(&rows, "3p-5h").stale);
    assert!(row(&rows, "3p-5h").source_error.is_some());
}
