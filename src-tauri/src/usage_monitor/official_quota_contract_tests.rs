//! HTTP producer-contract fixtures from openai/codex@efdacaf46ff54660a239189a6d62434c5db33d2c.
//! These exercise the public save/read path so the same assertions run against
//! the old implementation before fixes; no replacement quota parser is used.
use super::*;
use serde_json::json;

const OBSERVED: i64 = 1_800_000_000_000;

fn db() -> Connection {
    let connection = Connection::open_in_memory().unwrap();
    super::super::store::initialize(&connection).unwrap();
    connection
}

fn window(seconds: i64, used: i64) -> Value {
    json!({"used_percent":used,"limit_window_seconds":seconds,
        "reset_after_seconds":seconds,"reset_at":OBSERVED/1000 + seconds.max(300)})
}

fn payload(seconds: i64, used: i64) -> Value {
    json!({"plan_type":"pro","rate_limit":{"allowed":true,"limit_reached":false,
        "primary_window":window(seconds,used),"secondary_window":null}})
}

fn save_payload(connection: &Connection, value: &Value, time: i64) -> Result<(), String> {
    super::super::codex_quota_accounts::save_authenticated(
        connection, Path::new("synthetic-codex-home"), "account-a", value, time)
}

fn report(connection: &Connection, time: i64) -> Value {
    serde_json::to_value(read(connection, time).unwrap()).unwrap()
}

#[test]
fn contract_followup_official_additional_pools_keep_identity_and_retire_independently() {
    let connection = db();
    let mut value = payload(18000, 25);
    value["rate_limit"]["secondary_window"] = window(604800, 30);
    value["credits"] = json!({"has_credits":true,"unlimited":false,"balance":"4.250"});
    value["additional_rate_limits"] = json!([
        {"metered_feature":"codex_spark","limit_name":"Spark","rate_limit":{
            "allowed":true,"limit_reached":false,"primary_window":window(18000,0)}},
        {"metered_feature":"code_review","limit_name":"Code review","rate_limit":{
            "allowed":true,"limit_reached":false,"primary_window":window(604800,70)}}
    ]);
    save_payload(&connection, &value, OBSERVED).unwrap();
    let first = report(&connection, OBSERVED + 1);
    let rows = first["quotas"].as_array().unwrap();
    assert_eq!(rows.len(), 4, "all declared pools must reach the monitor");
    let spark = rows.iter().find(|row| row["limitId"] == "codex_spark").unwrap();
    assert_eq!(spark["poolLabel"], "Spark");
    assert_eq!(spark["usedPercent"], 0.0);
    assert_eq!(spark["remainingPercent"], 100.0);
    assert_eq!(spark["credits"], Value::Null, "account credits do not belong to an additional pool");
    assert_eq!(rows.iter().filter(|row| row["limitId"] == "codex").count(), 2);
    assert_eq!(connection.query_row("SELECT COUNT(*) FROM monitor_account_cycles", [], |row| row.get::<_, i64>(0)).unwrap(), 1,
        "only the main exact weekly pool may create an account monetary cycle");

    // A missing pool must retire even if another pool has the same slot and duration.
    value["additional_rate_limits"] = json!([value["additional_rate_limits"][0].clone()]);
    save_payload(&connection, &value, OBSERVED + 1000).unwrap();
    let next = report(&connection, OBSERVED + 1001);
    let rows = next["quotas"].as_array().unwrap();
    let review = rows.iter().find(|row| row["limitId"] == "code_review").unwrap();
    assert_eq!(review["stale"], true);
    assert_eq!(review["observedAtMs"], OBSERVED);
    assert_eq!(review["usedPercent"], 70.0);
    assert!(review["sourceError"].is_string());
    assert!(rows.iter().filter(|row| row["limitId"] != "code_review").all(|row| row["stale"] == false));
}

#[test]
fn contract_followup_official_non_minute_windows_keep_exact_identity_and_reset_evidence() {
    let connection = db();
    save_payload(&connection, &payload(61, 0), OBSERVED).unwrap();
    let first = report(&connection, OBSERVED + 1);
    let rows = first["quotas"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "a positive non-minute window is not absent");
    assert_eq!(rows[0]["windowMinutes"], 2, "the official display conversion rounds up");
    assert_eq!(rows[0]["windowSeconds"], 61);
    assert_eq!(rows[0]["resetAfterSeconds"], 61);
    assert_eq!(rows[0]["resetsAtMs"], OBSERVED + 300_000, "absolute reset_at wins over relative countdown");
    assert_eq!(rows[0]["usedPercent"], 0.0);
    let old_id = rows[0]["id"].clone();

    save_payload(&connection, &payload(119, 40), OBSERVED + 1000).unwrap();
    super::initialize(&connection).unwrap();
    let next = report(&connection, OBSERVED + 1001);
    let rows = next["quotas"].as_array().unwrap();
    assert_eq!(rows.len(), 2, "61s and 119s must not collide at the same rounded minute");
    let old = rows.iter().find(|row| row["windowSeconds"] == 61).unwrap();
    let current = rows.iter().find(|row| row["windowSeconds"] == 119).unwrap();
    assert_eq!(old["id"], old_id);
    assert_eq!(old["stale"], true);
    assert_eq!(old["usedPercent"], 0.0);
    assert_ne!(old["id"], current["id"]);
    assert_eq!(current["windowMinutes"], 2);
    assert_eq!(current["stale"], false);
    assert_eq!(current["usedPercent"], 40.0);
}

#[test]
fn contract_followup_official_rounded_near_week_and_additional_week_are_not_main_cycles() {
    let connection = db();
    let mut value = payload(604799, 20);
    value["additional_rate_limits"] = json!([{
        "metered_feature":"code_review","limit_name":"Code review","rate_limit":{
            "allowed":true,"limit_reached":false,"primary_window":window(604800,80)}}]);
    save_payload(&connection, &value, OBSERVED).unwrap();
    let view = report(&connection, OBSERVED + 1);
    let rows = view["quotas"].as_array().unwrap();
    assert_eq!(rows.len(), 2);
    let main = rows.iter().find(|row| row["limitId"] == "codex").unwrap();
    assert_eq!(main["windowMinutes"], 10080);
    assert_eq!(main["windowSeconds"], 604799);
    assert_eq!(connection.query_row("SELECT COUNT(*) FROM monitor_account_cycles", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    // The bootstrap must use the same eligibility rule on every startup.
    super::initialize(&connection).unwrap();
    super::initialize(&connection).unwrap();
    assert_eq!(connection.query_row("SELECT COUNT(*) FROM monitor_account_cycles", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    assert_eq!(connection.query_row("SELECT COUNT(*) FROM monitor_codex_quota_accounts", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
}

#[test]
fn contract_followup_official_credits_without_windows_preserve_real_zero_and_unknown_quota() {
    let connection = db();
    let value = json!({"plan_type":"pro","rate_limit":null,
        "credits":{"has_credits":false,"unlimited":false,"balance":"0"}});
    save_payload(&connection, &value, OBSERVED).unwrap();
    let view = report(&connection, OBSERVED + 1);
    let rows = view["quotas"].as_array().unwrap();
    assert_eq!(rows.len(), 1, "an account's reported credits cannot disappear with absent quota windows");
    assert_eq!(rows[0]["slot"], "summary");
    assert_eq!(rows[0]["usedPercent"], Value::Null);
    assert_eq!(rows[0]["windowMinutes"], Value::Null);
    assert_eq!(rows[0]["credits"], json!({"hasCredits":false,"unlimited":false,"balance":"0"}));
    assert_eq!(rows[0]["stale"], false);
    assert_eq!(rows[0]["plan"], "pro");
    save_payload(&connection, &json!({"plan_type":"pro","rate_limit":null,"credits":null}), OBSERVED + 1000).unwrap();
    let retired = report(&connection, OBSERVED + 1001);
    assert!(retired["quotas"].as_array().unwrap().iter().all(|row| row["stale"] == true));
    assert_eq!(retired["quotas"][0]["credits"]["balance"], "0");
}

#[test]
fn contract_followup_official_provider_status_and_spend_controls_are_facts_not_costs() {
    let connection = db();
    let mut value = payload(18000, 25);
    value["rate_limit"]["allowed"] = json!(false);
    value["rate_limit"]["limit_reached"] = json!(true);
    value["rate_limit_reached_type"] = json!({"type":"workspace_member_usage_limit_reached"});
    value["spend_control"] = json!({"reached":true,"individual_limit":{
        "source":"workspace","limit":"100.00","used":"99.00","remaining":"1.00",
        "used_percent":99,"remaining_percent":1,"reset_after_seconds":3600,
        "reset_at":OBSERVED/1000 + 3600}});
    save_payload(&connection, &value, OBSERVED).unwrap();
    let view = report(&connection, OBSERVED + 1);
    let row = &view["quotas"][0];
    assert_eq!(row["usedPercent"], 25.0, "a separate access restriction must not rewrite quota percentage");
    assert_eq!(row["providerStatus"]["allowed"], false);
    assert_eq!(row["providerStatus"]["limitReached"], true);
    assert_eq!(row["providerStatus"]["rateLimitReachedType"], "workspace_member_usage_limit_reached");
    let spend = &row["providerStatus"]["spendControl"];
    assert_eq!(spend["reached"], true);
    assert_eq!(spend["individualLimit"], json!({"source":"workspace","limit":"100.00","used":"99.00","remaining":"1.00",
        "usedPercent":99.0,"remainingPercent":1.0,"resetAfterSeconds":3600,"resetsAtMs":OBSERVED + 3_600_000}));
    assert_eq!(row["sourceError"], Value::Null, "a reported restriction is not a failed source read");
    assert_eq!(row["stale"], false);
    assert_eq!(row["depletion"]["status"], "unavailable");
    assert_eq!(row["depletion"]["reason"], "provider_limit");
    assert_eq!(connection.query_row("SELECT COUNT(*) FROM monitor_account_cycles", [], |row| row.get::<_, i64>(0)).unwrap(), 0);

    // An explicit status without a numeric window is still reportable evidence.
    value["rate_limit"]["primary_window"] = Value::Null;
    save_payload(&connection, &value, OBSERVED + 1000).unwrap();
    let view = report(&connection, OBSERVED + 1001);
    let summaries: Vec<_> = view["quotas"].as_array().unwrap().iter().filter(|row| row["slot"] == "summary").collect();
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0]["usedPercent"], Value::Null);
    assert_eq!(summaries[0]["providerStatus"]["allowed"], false);
}

#[test]
fn contract_followup_official_invalid_extra_contract_is_not_a_successful_sparse_update() {
    let connection = db();
    save_payload(&connection, &payload(18000, 30), OBSERVED).unwrap();
    let before = report(&connection, OBSERVED + 1)["quotas"].clone();
    let invalid = [
        ("additional_rate_limits", json!({"metered_feature":"invalid-container"})),
        ("additional_rate_limits", json!([{"metered_feature":"codex","limit_name":"colliding main pool","rate_limit":null}])),
        ("rate_limit", json!({"allowed":"false","limit_reached":false,"primary_window":window(18000,20)})),
        ("credits", json!({"has_credits":true,"unlimited":false,"balance":{"amount":5}})),
        ("spend_control", json!({"reached":true,"individual_limit":{"used":42}})),
    ];
    for (field, invalid_value) in invalid {
        let mut value = payload(18000, 0);
        value[field] = invalid_value;
        assert!(save_payload(&connection, &value, OBSERVED + 1000).is_err(), "invalid {field} must not become a successful refresh");
        assert_eq!(report(&connection, OBSERVED + 1)["quotas"], before, "a rejected full snapshot must not erase prior facts");
    }
}

#[test]
fn contract_followup_official_exact_window_migration_preserves_ids_samples_and_old_json() {
    let connection = Connection::open_in_memory().unwrap();
    connection.execute_batch("CREATE TABLE monitor_quotas (
        id INTEGER PRIMARY KEY,tool TEXT NOT NULL,account_key TEXT NOT NULL,limit_id TEXT NOT NULL,
        slot TEXT NOT NULL,window_minutes INTEGER NOT NULL,observed_ms INTEGER,data TEXT NOT NULL,
        UNIQUE(tool,account_key,limit_id,slot,window_minutes));
        CREATE TABLE monitor_quota_samples(quota_id INTEGER NOT NULL,bucket_ms INTEGER NOT NULL,
        observed_ms INTEGER NOT NULL,used_percent REAL NOT NULL,reset_ms INTEGER NOT NULL,plan TEXT,segment_reason TEXT,
        PRIMARY KEY(quota_id,bucket_ms));").unwrap();
    let old_json = json!({"tool":"codex","account_key":"account:account-a","account_label":null,
        "attribution":"account","limit_id":"codex","slot":"primary","window_minutes":300,
        "plan":"pro","model_id":null,"pool_label":null,"observed_at_ms":OBSERVED,
        "resets_at_ms":OBSERVED+18_000_000,"used_percent":0,"credits":{"hasCredits":false,"unlimited":false,"balance":"0"},
        "source":"codex_official_usage","billing_account_verified":true,
        "source_error":"retained historical failure","stale_after_ms":300000,"futureField":{"keep":true}}).to_string();
    connection.execute("INSERT INTO monitor_quotas VALUES(37,'codex','account:account-a','codex','primary',300,?1,?2)", params![OBSERVED,old_json]).unwrap();
    connection.execute("INSERT INTO monitor_quota_samples VALUES(37,?1,?1,0,?2,'pro','existing segment')", params![OBSERVED,OBSERVED+18_000_000]).unwrap();
    for _ in 0..2 {
        super::super::store::initialize(&connection).unwrap();
        let present: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM pragma_table_info('monitor_quotas') WHERE name='window_seconds')", [], |row| row.get(0)).unwrap();
        assert!(present, "quota identity must store exact producer seconds");
        assert_eq!(connection.query_row("SELECT id FROM monitor_quotas", [], |row| row.get::<_, i64>(0)).unwrap(), 37);
        assert_eq!(connection.query_row("SELECT data FROM monitor_quotas", [], |row| row.get::<_, String>(0)).unwrap(), old_json);
        assert_eq!(connection.query_row("SELECT window_seconds FROM monitor_quotas", [], |row| row.get::<_, i64>(0)).unwrap(), 18000);
        assert_eq!(connection.query_row("SELECT COUNT(*) FROM monitor_quota_samples WHERE quota_id=37 AND used_percent=0 AND segment_reason='existing segment'", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    }
    save_payload(&connection, &payload(18000, 10), OBSERVED + 1000).unwrap();
    assert_eq!(connection.query_row("SELECT id FROM monitor_quotas", [], |row| row.get::<_, i64>(0)).unwrap(), 37,
        "a later exact official observation must enrich the existing row, not duplicate it");
}

#[test]
fn contract_followup_codex_log_metadata_preserves_alias_and_status_without_account_inference() {
    let value = json!({"rate_limits":{"limit_id":"codex_spark","limit_name":"Spark","normal_model_slug":"source-model",
        "plan_type":"pro","primary":{"used_percent":0,"window_minutes":2,"resets_at":OBSERVED/1000+300},
        "spend_control_reached":true,"rate_limit_reached_type":"workspace_owner_usage_limit_reached",
        "individual_limit":{"limit":"50","used":"49","remaining_percent":2,"resets_at":OBSERVED/1000+3600}}});
    let rows = codex_observations(&value, Some("unproven-session-creator"), "session-a", Some(OBSERVED));
    assert_eq!(rows.len(), 1);
    let row = serde_json::to_value(&rows[0]).unwrap();
    assert_eq!(row["account_key"], "session:session-a");
    assert_eq!(row["attribution"], "unattributed");
    assert_eq!(row["model_id"], "source-model");
    assert_eq!(row["used_percent"], 0.0);
    assert_eq!(row["provider_status"]["spendControl"]["reached"], true);
    assert_eq!(row["provider_status"]["individualLimit"], Value::Null);
    assert_eq!(row["provider_status"]["spendControl"]["individualLimit"]["remainingPercent"], 2.0);
}

#[test]
fn contract_followup_official_reset_boundary_keeps_expired_window_and_independent_credits() {
    let connection = db();
    let mut value = payload(604800, 70);
    value["rate_limit"]["primary_window"]["reset_at"] = json!(OBSERVED / 1000 - 1);
    value["rate_limit"]["primary_window"]["reset_after_seconds"] = json!(0);
    value["credits"] = json!({"has_credits":true,"unlimited":false,"balance":"9.00"});
    let result = save_payload(&connection, &value, OBSERVED);
    assert!(result.is_ok(), "a response arriving after its quota reset still contains valid independent facts: {result:?}");
    let view = report(&connection, OBSERVED + 1);
    let row = &view["quotas"][0];
    assert_eq!(row["usedPercent"], 70.0);
    assert_eq!(row["expired"], true);
    assert_eq!(row["stale"], true);
    assert_eq!(row["sourceError"], Value::Null);
    assert_eq!(row["resetAfterSeconds"], 0);
    assert_eq!(row["credits"]["balance"], "9.00");
    assert_eq!(row["observedAtMs"], OBSERVED);
    let source = view["sources"].as_array().unwrap().iter().find(|source| source["source"] == "codex_official_usage").unwrap();
    assert_eq!(source["status"], "available", "expired quota is not the absence of a successful metadata response");
    assert_eq!(connection.query_row("SELECT COUNT(*) FROM monitor_account_cycles", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
    assert_eq!(connection.query_row("SELECT COUNT(*) FROM monitor_codex_quota_accounts", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
}
