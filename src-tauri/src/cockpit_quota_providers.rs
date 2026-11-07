//! Provider payloads written by cockpit-tools 820e176842d440a60e650729c3a39932b76a0ccb.
//! Read quota numerators/denominators only. Monetary quota budgets are never costs.
//! Missing, unlimited, and unsupported scopes stay unavailable instead of becoming zero use.
use super::*;
use serde_json::Value;

pub(super) fn is_trae(channel: &str) -> bool {
    matches!(
        channel,
        CH_TRAE | CH_TRAE_CN | CH_TRAE_SOLO | CH_TRAE_SOLO_CN
    )
}

/// Exact summary identifiers retained by quota.rs::is_summary_bucket. A model
/// name containing "weekly" alone is not evidence of a quota window.
pub(super) fn google_summary_window(id: &str) -> Option<QuotaWindowKind> {
    match id {
        "3p-5h" | "claude:5h" | "gemini-5h" | "gemini:5h" | "gemini-argon-5h" | "argon:5h" => {
            Some(QuotaWindowKind::FiveHour)
        }
        "3p-weekly"
        | "claude:weekly"
        | "gemini-weekly"
        | "gemini:weekly"
        | "gemini-argon-wtu-weekly"
        | "argon:weekly" => Some(QuotaWindowKind::Weekly),
        _ if id.starts_with("gemini-argon-") && id.ends_with("-5h") => {
            Some(QuotaWindowKind::FiveHour)
        }
        _ if id.starts_with("gemini-argon-") && id.ends_with("-weekly") => {
            Some(QuotaWindowKind::Weekly)
        }
        _ => None,
    }
}

fn platform(value: &str) -> Option<String> {
    let value = value.trim().to_ascii_lowercase().replace('-', "_");
    is_trae(&value).then_some(value)
}

/// The producer writes query_identity v1 into the plaintext Trae summary, including
/// the resolved provider_key. No decryption or credential-derived guess is needed.
pub(super) fn indexed_trae_platform(entry: &Value) -> Result<Option<String>, String> {
    let Some(identity) = entry.get("query_identity").filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    if identity.get("version").and_then(Value::as_u64) != Some(1) {
        return Err("Trae 账号索引 query_identity 版本不支持，无法核实所属平台".into());
    }
    identity
        .get("platform")
        .and_then(Value::as_str)
        .and_then(platform)
        .map(Some)
        .ok_or_else(|| "Trae 账号索引缺少有效 query_identity.platform".into())
}

/// Legacy plaintext exports may contain explicit platform metadata. Deliberately
/// do not infer the platform from credentials, email, filename, or a default.
pub(super) fn explicit_trae_platform(json: &Value) -> Result<Option<String>, String> {
    let mut found = None;
    for field in [
        "trae_profile_raw",
        "trae_server_raw",
        "trae_entitlement_raw",
        "trae_usage_raw",
    ] {
        let Some(raw) = json.get(field).filter(|value| value.is_object()) else {
            continue;
        };
        for value in [
            Some(raw),
            raw.get("Result"),
            raw.get("result"),
            raw.get("data"),
        ]
        .into_iter()
        .flatten()
        {
            for candidate in [
                value.get("platformId"),
                value.get("platform_id"),
                value.get("platform").filter(|item| item.is_string()),
                value.pointer("/platform/platformId"),
                value.pointer("/platform/platform_id"),
            ]
            .into_iter()
            .flatten()
            {
                let candidate = candidate
                    .as_str()
                    .and_then(platform)
                    .ok_or_else(|| "Trae 账号详情包含无法识别的平台标识".to_string())?;
                if found.as_ref().is_some_and(|old| old != &candidate) {
                    return Err("Trae 账号详情包含冲突的平台标识".into());
                }
                found = Some(candidate);
            }
        }
    }
    Ok(found)
}

fn number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.trim().parse::<f64>().ok())
        .filter(|n| n.is_finite())
}

fn nums(value: &Value, fields: &[&str]) -> Option<f64> {
    fields
        .iter()
        .find_map(|field| value.get(*field).and_then(number))
}

fn seconds_ms(value: &Value) -> Option<i64> {
    let value = value.get("seconds").unwrap_or(value);
    let n = number(value)?;
    if n <= 0.0 || n > 9_007_199_254_740.0 {
        return None;
    }
    (n.trunc() as i64).checked_mul(1000)
}

fn exact_ms(value: &Value) -> Option<i64> {
    number(value)
        .filter(|n| *n > 0.0 && *n <= 9_007_199_254_740_991.0)
        .map(|n| n.trunc() as i64)
        .or_else(|| {
            value
                .as_str()
                .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
                .map(|time| time.timestamp_millis())
        })
}

/// Buddy/Qoder's public parsers explicitly accept seconds or milliseconds at 1e12.
/// Offset-free date text does not identify an instant across producer/reader
/// timezones; retain the measured ratio and leave that reset unknown.
fn flexible_time(value: &Value) -> Option<i64> {
    if let Some(n) = number(value) {
        return if n >= 1_000_000_000_000.0 {
            exact_ms(value)
        } else {
            seconds_ms(value)
        };
    }
    let text = value.as_str()?.trim();
    if let Ok(time) = chrono::DateTime::parse_from_rfc3339(text) {
        return Some(time.timestamp_millis());
    }

    None
}

fn used_percent(used: Option<f64>, total: Option<f64>) -> Option<f64> {
    let (used, total) = (used?, total?);
    if !used.is_finite() || !total.is_finite() || used < 0.0 || total <= 0.0 {
        return None;
    }
    // Observed consumption can exceed a finite allowance. The remaining allowance
    // is then zero; the excess is not a negative balance or a purchase amount.
    Some((used / total * 100.0).min(100.0))
}

fn remaining_percent(remaining: Option<f64>, total: Option<f64>) -> Option<f64> {
    let (remaining, total) = (remaining?, total?);
    if !remaining.is_finite()
        || !total.is_finite()
        || remaining < 0.0
        || total <= 0.0
        || remaining > total
    {
        return None;
    }
    Some(remaining / total * 100.0)
}

fn scalar_text(value: Option<&Value>) -> Option<String> {
    let value = value?;
    value
        .as_str()
        .filter(|text| !text.trim().is_empty())
        .map(str::to_owned)
        .or_else(|| value.as_u64().map(|n| n.to_string()))
}

pub(super) fn entries(channel: &str, json: &Value) -> Option<Vec<RawEntry>> {
    match channel {
        CH_TRAE | CH_TRAE_CN | CH_TRAE_SOLO | CH_TRAE_SOLO_CN => trae_entries(json),
        CH_WINDSURF => windsurf_entries(json),
        CH_CODEBUDDY | CH_CODEBUDDY_CN | CH_WORKBUDDY => buddy_entries(json),
        CH_ZED => zed_entries(json),
        CH_QODER => qoder_entries(json),
        CH_CURSOR => cursor_entries(json),
        _ => None,
    }
}

fn trae_entries(json: &Value) -> Option<Vec<RawEntry>> {
    let raw = json.get("trae_usage_raw")?;
    let roots: Vec<_> = [
        Some(raw),
        raw.get("data"),
        raw.get("Result"),
        raw.get("result"),
        raw.get("payload"),
        raw.get("user_current_entitlement_list"),
        raw.get("ide_user_ent_usage"),
    ]
    .into_iter()
    .flatten()
    .filter(|value| value.is_object())
    .collect();
    let packs = roots.iter().find_map(|value| {
        value
            .get("user_entitlement_pack_list")
            .and_then(Value::as_array)
    })?;
    if roots.iter().any(|value| {
        value
            .get("code")
            .and_then(number)
            .is_some_and(|code| code != 0.0)
    }) {
        return Some(Vec::new());
    }
    let credits = roots
        .iter()
        .any(|value| value.get("is_credits_billing").and_then(Value::as_bool) == Some(true));
    let mut out = Vec::new();
    for (position, pack) in packs.iter().enumerate() {
        // Credits include hidden/inactive buckets in the official aggregation;
        // legacy fast-request quotas only include visible active packs.
        if !credits
            && (pack["is_hide"].as_bool() == Some(true)
                || nums(pack, &["status", "entitlement_status"])
                    .is_some_and(|status| status != 1.0))
        {
            continue;
        }
        let Some(base) = pack.get("entitlement_base_info") else {
            continue;
        };
        let quota = base
            .get("quota")
            .or_else(|| base.pointer("/product_extra/subscription_extra/quota"))
            .or_else(|| base.pointer("/product_extra/package_extra/quota"));
        let (Some(quota), Some(usage)) = (quota, pack.get("usage")) else {
            continue;
        };
        let id = scalar_text(base.get("entitlement_id"))
            .or_else(|| scalar_text(pack.get("entitlement_id")))
            .unwrap_or_else(|| format!("pack-{position}"));
        let reset = base
            .get("end_time")
            .and_then(number)
            .filter(|n| *n > 0.0)
            .and_then(|n| seconds_ms(&Value::from(n + 1.0)))
            .or_else(|| json.get("plan_reset_at").and_then(seconds_ms));
        let fields: &[(&str, &str, &str)] = if credits {
            &[("credits", "credits_limit", "credits_amount")]
        } else {
            &[
                (
                    "fast_requests",
                    "premium_model_fast_request_limit",
                    "premium_model_fast_amount",
                ),
                ("basic_usage", "basic_usage_limit", "basic_usage_amount"),
                ("bonus_usage", "bonus_usage_limit", "bonus_usage_amount"),
            ]
        };
        for (pool, cap, used) in fields {
            if let Some(percent) = used_percent(nums(usage, &[*used]), nums(quota, &[*cap])) {
                let mut entry =
                    native_pool(&format!("{pool}:{id}"), "used_percent", percent, reset);
                entry.display_name = first_str(pack, &["display_desc"]);
                out.push(entry);
            }
        }
    }
    Some(out)
}

fn windsurf_entries(json: &Value) -> Option<Vec<RawEntry>> {
    let snapshots = json.get("copilot_quota_snapshots");
    let status = snapshots
        .and_then(|v| v.get("windsurfPlanStatus"))
        .filter(|v| v.is_object())
        .or_else(|| {
            json.get("windsurf_plan_status")
                .and_then(|v| v.get("planStatus"))
                .filter(|v| v.is_object())
        })
        .or_else(|| json.get("windsurf_plan_status").filter(|v| v.is_object()))
        .or_else(|| json.pointer("/windsurf_user_status/userStatus/planStatus"))
        .or_else(|| json.pointer("/windsurf_user_status/planStatus"))?;
    let plan = status
        .get("planInfo")
        .or_else(|| status.get("plan_info"))
        .or_else(|| snapshots.and_then(|v| v.get("windsurfPlanInfo")))
        .unwrap_or(&Value::Null);
    let quota = status
        .get("quotaUsage")
        .filter(|v| v.is_object())
        .unwrap_or(status);
    let mut out = Vec::new();
    let fields = [
        (
            "daily_quota",
            &[
                "dailyQuotaRemainingPercent",
                "dailyRemainingPercent",
                "daily_quota_remaining_percent",
                "daily_remaining_percent",
            ][..],
            &[
                "dailyQuotaResetAtUnix",
                "dailyResetAtUnix",
                "daily_quota_reset_at_unix",
                "daily_reset_at_unix",
            ][..],
            "hideDailyQuota",
            "hide_daily_quota",
        ),
        (
            "weekly_quota",
            &[
                "weeklyQuotaRemainingPercent",
                "weeklyRemainingPercent",
                "weekly_quota_remaining_percent",
                "weekly_remaining_percent",
            ][..],
            &[
                "weeklyQuotaResetAtUnix",
                "weeklyResetAtUnix",
                "weekly_quota_reset_at_unix",
                "weekly_reset_at_unix",
            ][..],
            "hideWeeklyQuota",
            "hide_weekly_quota",
        ),
    ];
    let mut quota_shape = false;
    for (id, percent_fields, reset_fields, hide, hide_snake) in fields {
        if percent_fields
            .iter()
            .any(|key| quota.get(*key).is_some() || status.get(*key).is_some())
        {
            quota_shape = true;
        }
        if plan[hide].as_bool() == Some(true) || plan[hide_snake].as_bool() == Some(true) {
            continue;
        }
        if let Some(percent) = nums(quota, percent_fields).or_else(|| nums(status, percent_fields))
        {
            let reset = reset_fields.iter().find_map(|field| {
                quota
                    .get(*field)
                    .or_else(|| status.get(*field))
                    .and_then(seconds_ms)
            });
            let mut entry = native_pool(id, "percent_remaining", percent, reset);
            if id == "weekly_quota" {
                entry.window_kind = QuotaWindowKind::Weekly;
            }
            out.push(entry);
        }
    }
    // Missing quota protobuf fields stay unknown. Never substitute the upstream
    // UI's display-only zero defaults for a measured observation.
    if quota_shape {
        return Some(out);
    }
    let reset = status
        .get("planEnd")
        .or_else(|| status.get("plan_end"))
        .and_then(seconds_ms);
    for (id, total, used) in [
        (
            "prompt_credits",
            nums(plan, &["monthlyPromptCredits", "monthly_prompt_credits"]).or_else(|| {
                nums(
                    status,
                    &["availablePromptCredits", "available_prompt_credits"],
                )
            }),
            nums(status, &["usedPromptCredits", "used_prompt_credits"]),
        ),
        (
            "add_on_credits",
            nums(
                plan,
                &[
                    "monthlyFlexCreditPurchaseAmount",
                    "monthly_flex_credit_purchase_amount",
                    "monthlyAddOnCredits",
                    "monthly_add_on_credits",
                    "monthlyTopUpCredits",
                    "monthly_top_up_credits",
                ],
            )
            .or_else(|| {
                nums(
                    status,
                    &[
                        "availableFlexCredits",
                        "available_flex_credits",
                        "availableAddOnCredits",
                        "available_add_on_credits",
                        "availableTopUpCredits",
                        "available_top_up_credits",
                    ],
                )
            }),
            nums(
                status,
                &[
                    "usedFlexCredits",
                    "used_flex_credits",
                    "usedAddOnCredits",
                    "used_add_on_credits",
                    "usedTopUpCredits",
                    "used_top_up_credits",
                ],
            ),
        ),
    ] {
        if let Some(percent) = used_percent(used, total) {
            let mut entry = native_pool(id, "used_percent", percent, reset);
            if id == "prompt_credits" {
                entry.window_kind = QuotaWindowKind::Monthly;
            }
            out.push(entry);
        }
    }
    Some(out)
}

fn buddy_entries(json: &Value) -> Option<Vec<RawEntry>> {
    let quota = json.get("quota_raw");
    let resource = quota
        .and_then(|v| v.get("userResource"))
        .filter(|v| v.is_object())
        .or_else(|| json.get("usage_raw").filter(|v| v.is_object()));
    let candidates: Vec<_> = [
        resource,
        resource.and_then(|v| v.get("data")),
        resource.and_then(|v| v.pointer("/data/data")),
        quota.and_then(|v| v.get("data")),
        quota.and_then(|v| v.pointer("/data/data")),
    ]
    .into_iter()
    .flatten()
    .filter(|v| v.is_object())
    .collect();
    // Official legacy Accounts takes precedence over the newer resources wrapper,
    // matching extractResourceAccounts; resourceSummary is never a second pool.
    let legacy = candidates.iter().find_map(|v| {
        v.get("Response")
            .or_else(|| v.get("response"))
            .and_then(|v| v.get("Data").or_else(|| v.get("data")))
            .and_then(|v| v.get("Accounts").or_else(|| v.get("accounts")))
            .and_then(Value::as_array)
            .filter(|v| !v.is_empty())
    });
    let resources = legacy.or_else(|| {
        candidates.iter().find_map(|v| {
            v.get("resources")
                .and_then(Value::as_array)
                .filter(|v| !v.is_empty())
        })
    });
    if let Some(resources) = resources {
        let mut out = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for (position, resource) in resources.iter().enumerate() {
            let official = resource
                .get("PackageCode")
                .and_then(Value::as_str)
                .is_some();
            let unlimited = resource["Unlimited"].as_bool() == Some(true)
                || resource["unlimited"].as_bool() == Some(true);
            if unlimited {
                continue;
            }
            if official
                && !nums(resource, &["Status", "status"])
                    .is_some_and(|status| status == 0.0 || status == 3.0)
            {
                continue;
            }
            let (total, remaining) = if official {
                if nums(resource, &["CapacityType"]) == Some(4.0) {
                    let slice = resource
                        .get("SlicePeriodUsageDetails")
                        .and_then(Value::as_array)
                        .and_then(|v| v.first());
                    (
                        slice.and_then(|v| nums(v, &["SlicePeriodCapacitySizePrecise"])),
                        slice.and_then(|v| nums(v, &["SlicePeriodCapacityRemainPrecise"])),
                    )
                } else {
                    (
                        nums(
                            resource,
                            &[
                                "CycleCapacitySizePrecise",
                                "CycleCapacitySize",
                                "CapacitySizePrecise",
                                "CapacitySize",
                            ],
                        ),
                        nums(
                            resource,
                            &[
                                "CycleCapacityRemainPrecise",
                                "CycleCapacityRemain",
                                "CapacityRemainPrecise",
                                "CapacityRemain",
                            ],
                        ),
                    )
                }
            } else {
                (
                    nums(resource, &["total", "limit_num", "limitNum"]),
                    nums(resource, &["remaining", "remain"]),
                )
            };
            let Some(percent) = remaining_percent(remaining, total) else {
                continue;
            };
            let resource_id = scalar_text(resource.get("ResourceId"));
            if resource_id
                .as_ref()
                .is_some_and(|id| !seen.insert(id.clone()))
            {
                continue;
            }
            let id = resource_id.unwrap_or_else(|| {
                format!(
                    "{}:{position}",
                    first_str(
                        resource,
                        &[
                            "PackageCode",
                            "commodity_code",
                            "commodityCode",
                            "package_code",
                            "packageCode"
                        ]
                    )
                )
            });
            // Expiry is not necessarily a refresh. Only use CycleResetTime, or
            // the producer's explicit cycle-end-before-expiry refresh contract.
            let end = resource.get("CycleEndTime").and_then(flexible_time);
            let expiry = resource
                .get("DeductionEndTime")
                .and_then(flexible_time)
                .or_else(|| resource.get("ExpiredTime").and_then(flexible_time))
                .or(end);
            let reset = resource
                .get("CycleResetTime")
                .and_then(flexible_time)
                .or_else(|| {
                    end.zip(expiry)
                        .filter(|(end, expiry)| end != expiry)
                        .and_then(|(end, _)| end.checked_add(1000))
                });
            let mut entry = native_pool(
                &format!("resource:{id}"),
                "percent_remaining",
                percent,
                reset,
            );
            entry.display_name = first_str(
                resource,
                &["PackageName", "name", "package_name", "packageName"],
            );
            out.push(entry);
        }
        return Some(out);
    }
    for candidate in &candidates {
        let data = candidate
            .get("data")
            .filter(|v| v.is_object())
            .unwrap_or(candidate);
        if let Some(limit) = nums(data, &["limit_num", "limitNum"]) {
            let used = nums(data, &["used_num", "usedNum", "credit"]);
            return Some(
                used_percent(used, Some(limit))
                    .map(|percent| {
                        native_pool(
                            "enterprise_credits",
                            "used_percent",
                            percent,
                            data.get("cycle_reset_time")
                                .or_else(|| data.get("cycleResetTime"))
                                .and_then(flexible_time),
                        )
                    })
                    .into_iter()
                    .collect(),
            );
        }
    }
    // An explicitly empty official response is observed absence, not a reason to
    // reinterpret a numeric summary/amount as a percentage through generic parsing.
    candidates
        .iter()
        .any(|v| {
            v.get("resources").is_some()
                || v.get("Response").is_some()
                || v.get("response").is_some()
        })
        .then(Vec::new)
}

fn zed_entries(json: &Value) -> Option<Vec<RawEntry>> {
    let user_edit = json.pointer("/user_raw/plan/usage/edit_predictions");
    let legacy_edit = json
        .pointer("/usage_raw/current_usage/edit_predictions")
        .or_else(|| json.pointer("/usage_raw/edit_predictions"));
    let edit = legacy_edit.or(user_edit);
    let raw_token = json
        .pointer("/usage_raw/current_usage/token_spend")
        .or_else(|| json.pointer("/usage_raw/token_spend"));
    let relevant = [
        "edit_predictions_used",
        "edit_predictions_limit_raw",
        "token_spend_used_cents",
        "token_spend_limit_cents",
    ]
    .iter()
    .any(|field| json.get(*field).is_some_and(|value| !value.is_null()))
        || edit.is_some()
        || raw_token.is_some();
    if !relevant {
        return None;
    }
    let reset = json
        .get("billing_period_end_at")
        .and_then(seconds_ms)
        .or_else(|| {
            let value = json.pointer("/user_raw/plan/subscription_period/ended_at")?;
            seconds_ms(value).or_else(|| exact_ms(value))
        });
    let mut out = Vec::new();
    for (id, used, total) in [
        (
            "edit_predictions",
            nums(json, &["edit_predictions_used"])
                .or_else(|| edit.and_then(|v| nums(v, &["used"]))),
            nums(json, &["edit_predictions_limit_raw"])
                .or_else(|| edit.and_then(|v| nums(v, &["limit"]))),
        ),
        (
            "token_spend",
            nums(json, &["token_spend_used_cents"])
                .or_else(|| raw_token.and_then(|v| nums(v, &["used"]))),
            nums(json, &["token_spend_limit_cents"])
                .or_else(|| raw_token.and_then(|v| nums(v, &["limit"]))),
        ),
    ] {
        if let Some(percent) = used_percent(used, total) {
            out.push(native_pool(id, "used_percent", percent, reset));
        }
    }
    Some(out)
}

fn qoder_entries(json: &Value) -> Option<Vec<RawEntry>> {
    let raw = json.get("auth_credit_usage_raw").filter(|v| v.is_object());
    let envelope = raw.is_some_and(|raw| {
        ["displayMode", "qoderUsage", "enterpriseUsage"]
            .iter()
            .any(|key| raw.get(*key).is_some())
    });
    if raw.is_some_and(|raw| raw["displayMode"].as_str() == Some("enterprise")) {
        return Some(Vec::new());
    }
    let personal = raw.and_then(|raw| {
        raw.get("qoderUsage")
            .filter(|v| v.is_object())
            .or_else(|| (!envelope).then_some(raw))
    });
    if envelope && personal.is_none() {
        return Some(Vec::new());
    }
    let mut out = Vec::new();
    if let Some(personal) = personal {
        let reset = personal
            .get("resetAt")
            .or_else(|| personal.get("reset_at"))
            .and_then(flexible_time)
            // Qoder uses year 9999 as an unset sentinel, not a real reset.
            .filter(|value| *value < 253_402_214_400_000);
        for (id, keys) in [
            ("credits", &["userQuota"][..]),
            (
                "add_on_credits",
                &["addOnQuota", "addonQuota", "add_on_quota"][..],
            ),
            (
                "shared_credits",
                &[
                    "orgResourcePackage",
                    "organizationResourcePackage",
                    "sharedCreditPackage",
                    "resourcePackage",
                ][..],
            ),
        ] {
            let Some(bucket) = keys
                .iter()
                .find_map(|key| personal.get(*key))
                .filter(|v| v.is_object())
            else {
                continue;
            };
            let total = nums(bucket, &["total", "quota", "limit"]);
            if total.is_some_and(|total| total <= 0.0) {
                continue;
            }
            let used = nums(bucket, &["used", "usage", "consumed"]);
            let remaining = nums(bucket, &["remaining", "available", "left"]);
            let percent = nums(bucket, &["percentage", "usagePercent", "usage_percentage"])
                .or_else(|| used_percent(used, total))
                .or_else(|| remaining_percent(remaining, total).map(|remaining| 100.0 - remaining));
            if let Some(percent) = percent {
                out.push(native_pool(id, "used_percent", percent, reset));
            }
        }
        if !out.iter().any(|entry| entry.model_id == "credits") {
            if let Some(percent) = nums(
                personal,
                &["totalUsagePercentage", "total_usage_percentage"],
            ) {
                out.push(native_pool("credits", "used_percent", percent, reset));
            }
        }
        // The scoped envelope is authoritative; a stale account scalar cannot
        // recreate personal quota absent from its current scoped response.
        if envelope || personal.get("userQuota").is_some() || !out.is_empty() {
            return Some(out);
        }
    }
    nums(json, &["credits_usage_percent"])
        .map(|percent| vec![native_pool("credits", "used_percent", percent, None)])
}

fn cursor_entries(json: &Value) -> Option<Vec<RawEntry>> {
    let raw = json.get("cursor_usage_raw")?;
    let decoded = raw
        .as_str()
        .and_then(|s| serde_json::from_str::<Value>(s).ok());
    let raw = decoded.as_ref().unwrap_or(raw);
    let plan = raw
        .get("individualUsage")
        .or_else(|| raw.get("individual_usage"))
        .and_then(|v| v.get("plan"))
        .or_else(|| raw.get("planUsage"))
        .or_else(|| raw.get("plan_usage"))?;
    let info = raw
        .get("planInfo")
        .or_else(|| raw.get("plan_info"))
        .unwrap_or(&Value::Null);
    let period = info
        .get("includedUsagePeriod")
        .or_else(|| info.get("included_usage_period"))
        .or_else(|| raw.get("includedUsagePeriod"))
        .or_else(|| raw.get("included_usage_period"));
    let kind = match period {
        Some(Value::String(value))
            if ["weekly", "included_usage_period_weekly"]
                .contains(&value.to_ascii_lowercase().as_str()) =>
        {
            QuotaWindowKind::Weekly
        }
        Some(Value::String(value))
            if ["monthly", "included_usage_period_monthly"]
                .contains(&value.to_ascii_lowercase().as_str()) =>
        {
            QuotaWindowKind::Monthly
        }
        Some(value) if value.as_u64() == Some(2) => QuotaWindowKind::Weekly,
        Some(value) if value.as_u64() == Some(1) => QuotaWindowKind::Monthly,
        _ => QuotaWindowKind::Unknown,
    };
    let included_reset = info
        .get("includedUsageResetsAt")
        .or_else(|| info.get("included_usage_resets_at"))
        .or_else(|| raw.get("includedUsageResetsAt"))
        .or_else(|| raw.get("included_usage_resets_at"))
        .and_then(exact_ms);
    let cycle_reset = raw
        .get("billingCycleEnd")
        .or_else(|| raw.get("billing_cycle_end"))
        .or_else(|| info.get("billingCycleEnd"))
        .or_else(|| info.get("billing_cycle_end"))
        .and_then(exact_ms);
    let reset = match kind {
        QuotaWindowKind::Weekly => included_reset,
        QuotaWindowKind::Monthly => cycle_reset,
        _ => included_reset.or(cycle_reset),
    };
    let total = nums(plan, &["totalPercentUsed", "total_percent_used"]).or_else(|| {
        used_percent(
            nums(plan, &["used", "totalSpend", "total_spend"]),
            nums(plan, &["limit"]),
        )
    });
    Some(
        [
            ("total_usage", total),
            (
                "auto_composer",
                nums(plan, &["autoPercentUsed", "auto_percent_used"]),
            ),
            (
                "api_usage",
                nums(plan, &["apiPercentUsed", "api_percent_used"]),
            ),
        ]
        .into_iter()
        .filter_map(|(id, percent)| {
            percent.map(|percent| {
                let mut entry = native_pool(id, "used_percent", percent, reset);
                entry.window_kind = kind;
                entry
            })
        })
        .collect(),
    )
}
