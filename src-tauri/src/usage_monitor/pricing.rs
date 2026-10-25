use super::types::{CostEstimate, CostScenario, PriceEvidence, UsageRecord};
use crate::model_catalog::{
    CatalogCost, CatalogModel, CatalogQuoteInput, CatalogSnapshot, TokenRates,
};
use chrono::{Datelike, Timelike};

const CHECKED_AT: &str = "2026-10-16";
pub const VERSION: &str = "models-dev-official-rules-2026-10-16-v3";
const OPENAI: &str = "https://developers.openai.com/api/docs/pricing";
const ANTHROPIC: &str = "https://platform.claude.com/docs/en/about-claude/pricing";
const ZAI: &str = "https://docs.z.ai/guides/overview/pricing";
const VOLCENGINE: &str = "https://docs.volcengine.com/docs/ark/model-pricing?lang=zh";
const THIRD_PARTY_CHECKED_AT: &str = "2026-10-15T18:52:07Z";

#[derive(Clone, Copy)]
struct Rates {
    input: f64,
    read: f64,
    write_5m: f64,
    write_1h: f64,
    output: f64,
}

fn rates(input: f64, read: f64, write_5m: f64, write_1h: f64, output: f64) -> Rates {
    Rates {
        input,
        read,
        write_5m,
        write_1h,
        output,
    }
}

fn unknown(reason: &str) -> CostEstimate {
    CostEstimate {
        reason: Some(reason.into()),
        ..Default::default()
    }
}

// Rates are verified model/tier rows, not a provider-wide multiplier.
fn openai(model: &str, mode: &str, long: bool) -> Option<Rates> {
    let result = match (model, mode, long) {
        ("gpt-6-astra", "standard", false) => rates(10., 1., 12.5, 12.5, 50.),
        ("gpt-6-astra", "standard", true) => rates(20., 2., 25., 25., 75.),
        ("gpt-6-astra", "fast", false) => rates(20., 2., 25., 25., 100.),
        ("gpt-6-astra", "fast", true) => rates(40., 4., 50., 50., 150.),
        ("gpt-6-astra", "ultrafast", false) => rates(60., 6., 75., 75., 300.),
        ("gpt-6-astra", "ultrafast", true) => rates(120., 12., 150., 150., 450.),
        ("gpt-6.1-sol", "standard", false) => rates(2., 0.1, 2.5, 2.5, 10.),
        ("gpt-6.1-sol", "standard", true) => rates(4., 0.2, 5., 5., 15.),
        ("gpt-6.1-sol", "fast", false) => rates(4., 0.2, 5., 5., 20.),
        ("gpt-6.1-sol", "fast", true) => rates(8., 0.4, 10., 10., 30.),
        ("gpt-6.1-sol", "ultrafast", false) => rates(12., 0.6, 15., 15., 60.),
        ("gpt-6.1-sol", "ultrafast", true) => rates(24., 1.2, 30., 30., 90.),
        ("gpt-6-sol", "standard", false) => rates(2., 0.2, 2.5, 2.5, 10.),
        ("gpt-6-sol", "standard", true) => rates(4., 0.4, 5., 5., 15.),
        ("gpt-6-sol", "fast", false) => rates(4., 0.4, 5., 5., 20.),
        ("gpt-6-sol", "fast", true) => rates(8., 0.8, 10., 10., 30.),
        ("gpt-6-luna", "standard", false) => rates(0.1, 0.01, 0.125, 0.125, 0.5),
        ("gpt-6-luna", "standard", true) => rates(0.2, 0.02, 0.25, 0.25, 0.75),
        ("gpt-6-luna", "fast", false) => rates(0.2, 0.02, 0.25, 0.25, 1.),
        ("gpt-6-luna", "fast", true) => rates(0.4, 0.04, 0.5, 0.5, 1.5),
        ("gpt-5.6-sol", "standard", false) => rates(4., 0.4, 5., 5., 20.),
        ("gpt-5.6-sol", "standard", true) => rates(8., 0.8, 10., 10., 30.),
        ("gpt-5.6-sol", "fast", false) => rates(8., 0.8, 10., 10., 40.),
        ("gpt-5.6-sol", "fast", true) => rates(16., 1.6, 20., 20., 60.),
        _ => return None,
    };
    Some(result)
}

fn anthropic(model: &str, mode: &str, long: bool) -> Option<Rates> {
    Some(match (model, mode) {
        ("claude-fable-5-1" | "claude-mythos-5-1", "standard") => rates(10., 0.25, 12.5, 20., 50.),
        ("claude-opus-5-5", "standard") => rates(4., 0.2, 5., 8., 20.),
        ("claude-opus-5-5", "fast") => rates(8., 0.4, 10., 16., 40.),
        ("claude-sonnet-5-5", "standard") => rates(2., 0.1, 2.5, 4., 10.),
        ("claude-haiku-5-5", "standard") if long => rates(0.5, 0.05, 0.625, 1., 2.5),
        ("claude-haiku-5-5", "standard") => rates(0.1, 0.01, 0.125, 0.2, 0.5),
        (
            "claude-opus-5" | "claude-opus-4-8" | "claude-opus-4-7" | "claude-opus-4-6",
            "standard",
        ) => rates(5., 0.5, 6.25, 10., 25.),
        ("claude-opus-5" | "claude-opus-4-8", "fast") => rates(10., 1., 12.5, 20., 50.),
        ("claude-sonnet-5", "standard") => rates(2., 0.2, 2.5, 4., 10.),
        ("claude-sonnet-4-6", "standard") => rates(3., 0.3, 3.75, 6., 15.),
        _ => return None,
    })
}

fn quote(
    record: &UsageRecord,
    model: &str,
    mode: &str,
    input: i64,
    writes: (i64, i64),
) -> Result<CostScenario, &'static str> {
    let uncached = record.input_tokens - record.cache_read_tokens - record.cache_write_tokens;
    let (write5, write1) = writes;
    let (price, source, provider, currency, tier) = if model.starts_with("gpt-") {
        let long = input > 272_000;
        let Some(price) = openai(model, mode, long) else {
            return Err("unverified_model_or_mode_price");
        };
        (
            price,
            OPENAI,
            "OpenAI",
            "USD",
            if long {
                ">272000 input tokens"
            } else {
                "<=272000 input tokens"
            },
        )
    } else if model.starts_with("claude-") {
        let long = model == "claude-haiku-5-5" && input > 100_000;
        let Some(price) = anthropic(model, mode, long) else {
            return Err("unverified_model_or_mode_price");
        };
        let tier = if model == "claude-haiku-5-5" {
            if long {
                ">100000 input tokens"
            } else {
                "<=100000 input tokens"
            }
        } else {
            "full published context window"
        };
        (price, ANTHROPIC, "Anthropic", "USD", tier)
    } else if model == "glm-5.2" {
        // Cache creation is ordinary input processing, not Anthropic TTL-priced writes.
        (
            rates(1.4, 0.26, 1.4, 1.4, 4.4),
            ZAI,
            "Z.AI",
            "USD",
            "full published context window",
        )
    } else if model == "doubao-seed-2.0-code" {
        let (price, tier) = if input <= 32_000 {
            (rates(3.2, 0.64, 3.2, 3.2, 16.), "<=32000 input tokens")
        } else if input <= 128_000 {
            (
                rates(4.8, 0.96, 4.8, 4.8, 24.),
                ">32000 and <=128000 input tokens",
            )
        } else if input <= 256_000 {
            (
                rates(9.6, 1.92, 9.6, 9.6, 48.),
                ">128000 and <=256000 input tokens",
            )
        } else {
            return Err("unverified_context_price");
        };
        (price, VOLCENGINE, "Volcengine Ark", "CNY", tier)
    } else {
        return Err("unverified_model_or_mode_price");
    };
    let amount = (uncached as f64 * price.input
        + record.cache_read_tokens as f64 * price.read
        + write5 as f64 * price.write_5m
        + write1 as f64 * price.write_1h
        + record.output_tokens as f64 * price.output)
        / 1_000_000.;
    Ok(CostScenario {
        scenario_key: None,
        mode: mode.into(),
        amount,
        evidence: PriceEvidence {
            version: VERSION.into(),
            source_url: source.into(),
            checked_at: if source == ZAI || source == VOLCENGINE {
                THIRD_PARTY_CHECKED_AT
            } else {
                CHECKED_AT
            }
            .into(),
            model: model.into(),
            mode: mode.into(),
            context_tier: tier.into(),
            input_per_million: price.input,
            cached_per_million: Some(price.read),
            cache_write_per_million: (source == OPENAI).then_some(price.write_5m),
            cache_write_5m_per_million: (source == ANTHROPIC).then_some(price.write_5m),
            cache_write_1h_per_million: (source == ANTHROPIC).then_some(price.write_1h),
            output_per_million: price.output,
            currency: currency.into(),
            pricing_provider: provider.into(),
            excluded_components: if source == VOLCENGINE {
                vec!["unmeasured_explicit_cache_storage".into()]
            } else {
                vec![]
            },
            catalog_revision: None,
            pricing_basis: Some("official_equivalent".into()),
            rule_version: Some(VERSION.into()),
            rule_sources: vec![source.into()],
            time_band: None,
        },
    })
}

fn estimate_official(record: &UsageRecord) -> CostEstimate {
    let Some(model) = record.model.as_deref() else {
        return unknown("unknown_model");
    };
    if model == "qianfan-code-latest" {
        return unknown("subscription_routing_alias_needs_model");
    }
    let ordinary_write = model == "glm-5.2" || model == "doubao-seed-2.0-code";
    let tiered = model != "glm-5.2";
    if record.unknown_fields.iter().any(|s| {
        matches!(
            s.as_str(),
            "input_tokens" | "output_tokens" | "cache_read_tokens"
        ) || (!ordinary_write && s == "cache_write_tokens")
            || (tiered && s == "per_request_input_tokens")
    }) {
        return unknown("incomplete_token_breakdown");
    }
    if record
        .unknown_fields
        .iter()
        .any(|s| s.starts_with("unsupported_pricing_modifier:"))
    {
        return unknown("unsupported_pricing_modifier");
    }
    let input = if tiered {
        let Some(input) = record.context_tokens else {
            return unknown("unknown_per_request_context");
        };
        if input != record.input_tokens {
            return unknown("inconsistent_per_request_context");
        }
        input
    } else {
        record.input_tokens
    };
    if [
        record.input_tokens,
        record.output_tokens,
        record.cache_read_tokens,
        record.cache_write_tokens,
    ]
    .iter()
    .any(|n| *n < 0)
        || record
            .cache_read_tokens
            .checked_add(record.cache_write_tokens)
            .is_none_or(|cached| cached > record.input_tokens)
    {
        return unknown("invalid_token_breakdown");
    }
    let writes = if model.starts_with("claude-") && record.cache_write_tokens > 0 {
        let (Some(a), Some(b)) = (record.cache_write_5m_tokens, record.cache_write_1h_tokens)
        else {
            return unknown("unknown_cache_write_ttl");
        };
        if a < 0 || b < 0 || a.checked_add(b) != Some(record.cache_write_tokens) {
            return unknown("inconsistent_cache_write_ttl");
        }
        (a, b)
    } else {
        (record.cache_write_tokens, 0)
    };
    let mut reason =
        "current_official_price_equivalent; not_historical_paid_cost_or_subscription_bill"
            .to_owned();
    if record.model_basis == "turn_context_requested" {
        reason.push_str("; requested_model_not_response_confirmed");
    }
    let actual_mode = record
        .mode
        .as_deref()
        .filter(|_| record.mode_basis == "response_reported");
    if (model.starts_with("gpt-") || model.starts_with("claude-")) && actual_mode.is_none() {
        let scenarios: Vec<_> = ["standard", "fast", "ultrafast"]
            .into_iter()
            .filter_map(|mode| quote(record, model, mode, input, writes).ok())
            .collect();
        if scenarios.is_empty() {
            return unknown("unverified_model_or_mode_price");
        }
        reason.push_str("; actual_mode_unknown; scenarios_not_actual_detection_or_cost_bounds");
        if record.requested_mode.is_some() {
            reason.push_str("; requested_mode_only");
        }
        return CostEstimate {
            scenarios,
            reason: Some(reason),
            ..Default::default()
        };
    }
    let mode = if ordinary_write {
        reason.push_str("; reference_provider_api_tariff_not_actual_provider_or_mode");
        if model == "glm-5.2" {
            reason.push_str("; cache_creation_is_regular_input; cache_storage_currently_free");
        } else {
            reason.push_str(
                "; regular_inference_subtotal_excludes_unmeasured_explicit_cache_storage",
            );
        }
        "standard"
    } else {
        let Some(mode) = actual_mode else {
            return unknown("unknown_actual_mode");
        };
        mode
    };
    match quote(record, model, mode, input, writes) {
        Ok(quoted) => CostEstimate {
            usd: (quoted.evidence.currency == "USD").then_some(quoted.amount),
            cny: (quoted.evidence.currency == "CNY").then_some(quoted.amount),
            evidence: Some(quoted.evidence),
            reason: Some(reason),
            ..Default::default()
        },
        Err(reason) => unknown(reason),
    }
}

const DEEPSEEK: &str = "https://api-docs.deepseek.com/quick_start/pricing/";
const HOLIDAYS_2026: &str = "https://www.beijing.gov.cn/cs/gncs/zcwj/202603/t20260327_4568275.html";

pub fn revision(catalog: &CatalogSnapshot) -> String {
    format!("{VERSION}:{}", catalog.revision)
}

fn from_usage(record: &UsageRecord) -> CatalogQuoteInput {
    let observed = |name: &str, value: i64| {
        (!record.unknown_fields.iter().any(|field| field == name)).then_some(value)
    };
    CatalogQuoteInput {
        id: record.id.clone(),
        model: record.model.clone().unwrap_or_default(),
        provider: record
            .provider
            .clone()
            .filter(|_| record.provider_basis == "response_reported"),
        actual_mode: record
            .mode
            .clone()
            .filter(|_| record.mode_basis == "response_reported"),
        requested_mode: record.requested_mode.clone(),
        timestamp_ms: observed("timestamp", record.timestamp_ms),
        input_tokens: observed("input_tokens", record.input_tokens),
        output_tokens: observed("output_tokens", record.output_tokens),
        cache_read_tokens: observed("cache_read_tokens", record.cache_read_tokens),
        cache_write_tokens: observed("cache_write_tokens", record.cache_write_tokens),
        cache_write_5m_tokens: record.cache_write_5m_tokens,
        cache_write_1h_tokens: record.cache_write_1h_tokens,
        context_tokens: record.context_tokens,
        ..Default::default()
    }
}
pub fn estimate_with_catalog(record: &UsageRecord, catalog: &CatalogSnapshot) -> CostEstimate {
    estimate_condition(record, catalog, None)
}

fn estimate_condition(
    record: &UsageRecord,
    catalog: &CatalogSnapshot,
    reference_mode: Option<&str>,
) -> CostEstimate {
    if record
        .unknown_fields
        .iter()
        .any(|field| field.starts_with("unsupported_pricing_modifier:"))
    {
        return unknown("unsupported_pricing_modifier");
    }
    let mut input = from_usage(record);
    if let Some(mode) = reference_mode {
        input.actual_mode = Some(mode.into());
    }
    let mut cost = quote_input(&input, catalog);
    if record.model_basis == "turn_context_requested"
        && !cost
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("requested_model_not_response_confirmed"))
    {
        cost.reason
            .get_or_insert_with(String::new)
            .push_str("; requested_model_not_response_confirmed");
    }
    cost
}
pub fn estimate(record: &UsageRecord) -> CostEstimate {
    estimate_with_catalog(record, &crate::model_catalog::snapshot())
}

pub fn standard_reference(record: &UsageRecord, catalog: &CatalogSnapshot) -> CostEstimate {
    // This is a pricing condition only. It never edits the record or claims an observed response mode.
    let mut cost = estimate_condition(record, catalog, Some("standard"));
    cost.reason
        .get_or_insert_with(String::new)
        .push_str("; counterfactual_standard_reference_not_actual_mode_or_paid_bill");
    cost
}

fn selected_model<'a>(
    catalog: &'a CatalogSnapshot,
    provider: Option<&str>,
    model: &str,
) -> Result<(&'a str, &'a str, &'a CatalogModel), &'static str> {
    if let Some(provider) = provider {
        if let Some((id, _)) = catalog.providers.get_key_value(provider) {
            let (key, entry) = catalog
                .find(id, model)
                .ok_or("unknown_model_for_provider")?;
            return Ok((id, key, entry));
        }
        let mut providers = catalog
            .providers
            .iter()
            .filter(|(id, p)| id.as_str() == provider || p.name.eq_ignore_ascii_case(provider));
        let (id, _) = providers.next().ok_or("unknown_catalog_provider")?;
        if providers.next().is_some() {
            return Err("ambiguous_catalog_provider");
        }
        let (key, entry) = catalog
            .find(id, model)
            .ok_or("unknown_model_for_provider")?;
        return Ok((id, key, entry));
    }
    if let Some((provider, id)) = model.split_once('/') {
        if let Some((key, entry)) = catalog.find(provider, id) {
            return Ok((
                catalog.providers.get_key_value(provider).unwrap().0,
                key,
                entry,
            ));
        }
    }
    let preferred = if model.starts_with("gpt-") {
        Some("openai")
    } else if model.starts_with("claude-") {
        Some("anthropic")
    } else if model.starts_with("deepseek-") {
        Some("deepseek")
    } else if model.starts_with("sensenova-") {
        Some("sensenova")
    } else {
        None
    };
    if let Some(provider) = preferred {
        if let Some((key, entry)) = catalog.find(provider, model) {
            return Ok((
                catalog.providers.get_key_value(provider).unwrap().0,
                key,
                entry,
            ));
        }
    }
    let candidates = catalog.candidates(model);
    let canonical: Vec<_> = candidates
        .iter()
        .filter(|(provider, key, entry)| {
            entry.canonical_model_id.as_deref() == Some(format!("{provider}/{key}").as_str())
        })
        .collect();
    if canonical.len() == 1 {
        return Ok(*canonical[0]);
    }
    if candidates.len() == 1 {
        return Ok(candidates[0]);
    }
    Err(if candidates.is_empty() {
        "unknown_catalog_model"
    } else {
        "ambiguous_model_provider"
    })
}

fn context_range(
    input: &CatalogQuoteInput,
    cost: &CatalogCost,
) -> Result<(i64, i64), &'static str> {
    if !input.aggregate {
        let context = input.context_tokens.ok_or("unknown_per_request_context")?;
        if context < 0 || input.input_tokens != Some(context) {
            return Err("inconsistent_per_request_context");
        }
        return Ok((context, context));
    }
    if input.context_tokens.is_some() {
        return Err("aggregate_input_is_not_per_request_context");
    }
    match (input.context_min, input.context_max) {
        (Some(min), Some(max)) if min >= 0 && max >= min => return Ok((min, max)),
        (Some(_), Some(_)) => return Err("invalid_aggregate_context_range"),
        _ => {}
    }
    if input.context_tier.as_deref() == Some("base") {
        return Ok((
            0,
            cost.tiers
                .iter()
                .filter(|t| t.tier.kind == "context")
                .map(|t| t.tier.size)
                .min()
                .unwrap_or(i64::MAX),
        ));
    }
    if let Some(size) = input
        .context_tier
        .as_deref()
        .and_then(|tier| tier.strip_prefix('>'))
        .and_then(|v| v.parse::<i64>().ok())
    {
        if cost
            .tiers
            .iter()
            .any(|t| t.tier.kind == "context" && t.tier.size == size)
        {
            return Ok((
                size.saturating_add(1),
                cost.tiers
                    .iter()
                    .filter(|t| t.tier.kind == "context" && t.tier.size > size)
                    .map(|t| t.tier.size)
                    .min()
                    .unwrap_or(i64::MAX),
            ));
        }
    }
    Err("unknown_aggregate_context_range")
}
fn tier_at(cost: &CatalogCost, context: i64) -> Option<usize> {
    cost.tiers
        .iter()
        .enumerate()
        .filter(|(_, tier)| context > tier.tier.size)
        .max_by_key(|(_, tier)| tier.tier.size)
        .map(|(index, _)| index)
}
fn supplemental_rates(price: Rates, tier: &str, source: &str) -> (TokenRates, String, Vec<String>) {
    (
        TokenRates {
            input: Some(price.input),
            output: Some(price.output),
            cache_read: Some(price.read),
            cache_write: Some(price.write_5m),
            reasoning: None,
        },
        tier.into(),
        vec![source.into()],
    )
}
fn catalog_rates(
    model: &CatalogModel,
    model_id: &str,
    provider: &str,
    mode: &str,
    range: (i64, i64),
) -> Result<(TokenRates, String, Vec<String>), &'static str> {
    let base = model.cost.as_ref().ok_or("missing_catalog_token_prices")?;
    let selected = if mode == "standard" {
        Some(base)
    } else {
        model
            .experimental
            .modes
            .get(mode)
            .and_then(|m| m.cost.as_ref())
    };
    if selected.is_none() {
        if provider == "openai" {
            if range.0 <= 272_000 && range.1 > 272_000 {
                return Err("aggregate_context_spans_price_tiers");
            }
            if let Some(price) = openai(model_id, mode, range.0 > 272_000) {
                return Ok(supplemental_rates(
                    price,
                    if range.0 > 272_000 {
                        ">272000 input tokens"
                    } else {
                        "<=272000 input tokens"
                    },
                    OPENAI,
                ));
            }
        }
        if provider == "anthropic" {
            if model_id == "claude-haiku-5-5" && range.0 <= 100_000 && range.1 > 100_000 {
                return Err("aggregate_context_spans_price_tiers");
            }
            if let Some(price) = anthropic(
                model_id,
                mode,
                model_id == "claude-haiku-5-5" && range.0 > 100_000,
            ) {
                return Ok(supplemental_rates(
                    price,
                    "official model context tariff",
                    ANTHROPIC,
                ));
            }
        }
        return Err("unverified_model_or_mode_price");
    }
    let selected = selected.unwrap();
    if base
        .tiers
        .iter()
        .chain(&selected.tiers)
        .any(|tier| tier.tier.kind != "context")
    {
        return Err("unsupported_catalog_price_tier");
    }
    if provider == "openai" && openai(model_id, mode, false).is_some() {
        if range.0 <= 272_000 && range.1 > 272_000 {
            return Err("aggregate_context_spans_price_tiers");
        }
        if range.0 > 272_000 && !selected.tiers.iter().any(|tier| tier.tier.size == 272_000) {
            let price = openai(model_id, mode, true).ok_or("unverified_mode_context_price")?;
            return Ok(supplemental_rates(price, ">272000 input tokens", OPENAI));
        }
    }
    if provider == "anthropic"
        && model_id == "claude-haiku-5-5"
        && !selected.tiers.iter().any(|t| t.tier.size == 100_000)
    {
        if range.0 <= 100_000 && range.1 > 100_000 {
            return Err("aggregate_context_spans_price_tiers");
        }
        if range.0 > 100_000 {
            return anthropic(model_id, mode, true)
                .map(|price| supplemental_rates(price, ">100000 input tokens", ANTHROPIC))
                .ok_or("unverified_mode_context_price");
        }
    }
    if mode != "standard"
        && selected.tiers.is_empty()
        && base.tiers.iter().any(|tier| range.1 > tier.tier.size)
    {
        return Err("unverified_mode_context_price");
    }
    let low = tier_at(selected, range.0);
    let high = tier_at(selected, range.1);
    if low != high {
        return Err("aggregate_context_spans_price_tiers");
    }
    let (rates, tier) = if let Some(index) = low {
        (
            &selected.tiers[index].rates,
            format!(">{} input tokens", selected.tiers[index].tier.size),
        )
    } else {
        (
            &selected.rates,
            selected
                .tiers
                .iter()
                .map(|t| t.tier.size)
                .min()
                .map_or_else(
                    || "full published context window".into(),
                    |size| format!("<={size} input tokens"),
                ),
        )
    };
    Ok((rates.clone(), tier, vec![]))
}
fn holiday_2026(month: u32, day: u32) -> bool {
    let date = month * 100 + day;
    [
        (101, 103),
        (215, 223),
        (404, 406),
        (501, 505),
        (619, 621),
        (925, 927),
        (1001, 1007),
    ]
    .iter()
    .any(|(start, end)| date >= *start && date <= *end)
}
fn deepseek_bands(input: &CatalogQuoteInput) -> Result<Vec<(&'static str, f64)>, &'static str> {
    if input.aggregate {
        return match input.time_band.as_deref() {
            Some("peak") => Ok(vec![("peak", 2.)]),
            Some("off_peak") => Ok(vec![("off_peak", 1.)]),
            _ => Err("unknown_aggregate_time_band"),
        };
    }
    let Some(time) = input
        .timestamp_ms
        .and_then(chrono::DateTime::from_timestamp_millis)
    else {
        return Ok(vec![("off_peak", 1.), ("peak", 2.)]);
    };
    let candidate = time.weekday().number_from_monday() <= 5
        && ((1..4).contains(&time.hour()) || (6..10).contains(&time.hour()));
    if !candidate {
        return Ok(vec![("off_peak", 1.)]);
    }
    if time.year() != 2026 {
        return Ok(vec![("off_peak", 1.), ("peak", 2.)]);
    }
    // UTC peak hours are 09:00-18:00 in China, so the statutory-holiday date is the same date.
    Ok(if holiday_2026(time.month(), time.day()) {
        vec![("off_peak", 1.)]
    } else {
        vec![("peak", 2.)]
    })
}
fn normalize_mode(mode: &str) -> &str {
    match mode {
        "normal" | "default" => "standard",
        "priority" => "fast",
        other => other,
    }
}

fn catalog_quote(
    input: &CatalogQuoteInput,
    catalog: &CatalogSnapshot,
) -> Result<CostEstimate, &'static str> {
    if input.model.is_empty() {
        return Err("unknown_model");
    }
    let (provider, model_id, model) =
        selected_model(catalog, input.provider.as_deref(), &input.model)?;
    let cost = model.cost.as_ref().ok_or("missing_catalog_token_prices")?;
    let ordinary_write =
        provider == "deepseek" || (matches!(provider, "zai" | "zhipuai") && model_id == "glm-5.2");
    let tokens = input.input_tokens.ok_or("incomplete_token_breakdown")?;
    let output = input.output_tokens.ok_or("incomplete_token_breakdown")?;
    let read = input
        .cache_read_tokens
        .ok_or("incomplete_token_breakdown")?;
    let write = if ordinary_write {
        input.cache_write_tokens.unwrap_or(0)
    } else {
        input
            .cache_write_tokens
            .ok_or("incomplete_token_breakdown")?
    };
    if [tokens, output, read, write].iter().any(|n| *n < 0)
        || read.checked_add(write).is_none_or(|cached| cached > tokens)
    {
        return Err("invalid_token_breakdown");
    }
    let range = if cost.tiers.is_empty()
        && !(provider == "openai" && openai(model_id, "standard", false).is_some())
        && !input.aggregate
        && input.context_tokens.is_none()
    {
        (tokens, tokens)
    } else {
        context_range(input, cost)?
    };
    let modes: Vec<String> = if let Some(mode) = input.actual_mode.as_deref() {
        vec![normalize_mode(mode).into()]
    } else {
        let mut modes = vec!["standard".to_owned()];
        modes.extend(
            model
                .experimental
                .modes
                .iter()
                .filter(|(_, mode)| mode.cost.is_some())
                .map(|(mode, _)| mode.clone()),
        );
        for mode in ["fast", "ultrafast"] {
            if !modes.iter().any(|m| m == mode)
                && ((provider == "openai" && openai(model_id, mode, false).is_some())
                    || (provider == "anthropic" && anthropic(model_id, mode, false).is_some()))
            {
                modes.push(mode.into());
            }
        }
        modes
    };
    let bands = if provider == "deepseek" {
        deepseek_bands(input)?
    } else {
        vec![("", 1.)]
    };
    let mode_unknown = input.actual_mode.is_none();
    let time_unknown = bands.len() > 1;
    let mut quotes = Vec::new();
    let mut last_error = "unverified_model_or_mode_price";
    for mode in &modes {
        let (rates, tier, mut rules) = match catalog_rates(model, model_id, provider, mode, range) {
            Ok(value) => value,
            Err(error) => {
                last_error = error;
                continue;
            }
        };
        let unit_source = rules
            .first()
            .cloned()
            .unwrap_or_else(|| crate::model_catalog::SOURCE_URL.into());
        let (Some(input_price), Some(output_price)) = (rates.input, rates.output) else {
            last_error = "missing_input_or_output_price";
            continue;
        };
        if output > 0 && rates.reasoning.is_some_and(|price| price != output_price) {
            last_error = "unmeasured_separately_priced_reasoning";
            continue;
        }
        if read > 0 && rates.cache_read.is_none() {
            last_error = "missing_cache_read_price";
            continue;
        }
        let (write5, write1, write5_price, write1_price) = if provider == "anthropic" && write > 0 {
            let (Some(a), Some(b)) = (input.cache_write_5m_tokens, input.cache_write_1h_tokens)
            else {
                last_error = "unknown_cache_write_ttl";
                continue;
            };
            if a < 0 || b < 0 || a.checked_add(b) != Some(write) {
                last_error = "inconsistent_cache_write_ttl";
                continue;
            }
            // The official prompt-cache rule is 2x the selected input tariff for one-hour writes.
            rules.push(ANTHROPIC.into());
            (a, b, rates.cache_write, Some(input_price * 2.))
        } else {
            (
                write,
                0,
                if ordinary_write && rates.cache_write.is_none() {
                    Some(input_price)
                } else {
                    rates.cache_write
                },
                None,
            )
        };
        if (write5 > 0 && write5_price.is_none()) || (write1 > 0 && write1_price.is_none()) {
            last_error = "missing_cache_write_price";
            continue;
        }
        for &(band, multiplier) in &bands {
            let uncached = tokens - read - write;
            let amount = (uncached as f64 * input_price
                + read as f64 * rates.cache_read.unwrap_or(0.)
                + write5 as f64 * write5_price.unwrap_or(0.)
                + write1 as f64 * write1_price.unwrap_or(0.)
                + output as f64 * output_price)
                * multiplier
                / 1_000_000.;
            if !amount.is_finite() {
                last_error = "cost_exceeds_numeric_range";
                continue;
            }
            let mut rule_sources = rules.clone();
            if provider == "deepseek" {
                rule_sources.extend([DEEPSEEK.into(), HOLIDAYS_2026.into()]);
            }
            let checked = if unit_source == crate::model_catalog::SOURCE_URL {
                chrono::DateTime::from_timestamp_millis(catalog.fetched_at_ms)
                    .map_or_else(|| CHECKED_AT.into(), |date| date.to_rfc3339())
            } else {
                CHECKED_AT.into()
            };
            quotes.push(CostScenario {
                scenario_key: Some(if band.is_empty() {
                    mode.clone()
                } else {
                    format!("{mode}:{band}")
                }),
                mode: mode.clone(),
                amount,
                evidence: PriceEvidence {
                    version: revision(catalog),
                    source_url: unit_source.clone(),
                    checked_at: checked,
                    model: model_id.into(),
                    mode: mode.clone(),
                    context_tier: tier.clone(),
                    input_per_million: input_price * multiplier,
                    cached_per_million: rates.cache_read.map(|n| n * multiplier),
                    cache_write_per_million: if provider == "anthropic" {
                        None
                    } else {
                        write5_price.map(|n| n * multiplier)
                    },
                    cache_write_5m_per_million: if provider == "anthropic" {
                        write5_price.map(|n| n * multiplier)
                    } else {
                        None
                    },
                    cache_write_1h_per_million: if provider == "anthropic" {
                        write1_price.map(|n| n * multiplier)
                    } else {
                        None
                    },
                    output_per_million: output_price * multiplier,
                    currency: "USD".into(),
                    pricing_provider: provider.into(),
                    excluded_components: if provider == "sensenova" {
                        vec!["third_party_route_payment_not_verified".into()]
                    } else {
                        vec![]
                    },
                    catalog_revision: Some(catalog.revision.clone()),
                    pricing_basis: Some(
                        if input.provider.is_none()
                            && matches!(
                                provider,
                                "openai" | "anthropic" | "deepseek" | "sensenova" | "zai"
                            )
                        {
                            "official_equivalent"
                        } else {
                            "catalog_provider_reference"
                        }
                        .into(),
                    ),
                    rule_version: Some(VERSION.into()),
                    rule_sources,
                    time_band: (!band.is_empty()).then(|| band.into()),
                },
            });
        }
    }
    if quotes.is_empty() {
        return Err(last_error);
    }
    let mut reason =
        "current_catalog_price_equivalent; not_historical_paid_cost_or_subscription_bill"
            .to_owned();
    if input.provider.is_none() {
        reason.push_str("; actual_provider_unknown; named_reference_provider_only");
    }
    if provider == "sensenova" {
        reason.push_str("; official_public_preview_reference_not_third_party_free_billing");
    }
    if mode_unknown {
        reason.push_str("; actual_mode_unknown; published_tariffs_not_actual_mode_detection");
    }
    if time_unknown {
        reason.push_str("; holiday_calendar_or_timestamp_unknown; time_band_scenarios");
    }
    if input.requested_mode.is_some() && mode_unknown {
        reason.push_str("; requested_mode_only");
    }
    let same_amount = quotes.len() == modes.len() * bands.len()
        && quotes.iter().all(|quote| quote.amount == quotes[0].amount);
    if (mode_unknown || time_unknown) && !same_amount {
        reason.push_str("; scenarios_not_actual_detection_or_cost_bounds");
        return Ok(CostEstimate {
            scenarios: quotes,
            reason: Some(reason),
            ..Default::default()
        });
    }
    if mode_unknown || time_unknown {
        reason.push_str("; same_amount_for_all_published_tariffs");
    }
    let quote = quotes.remove(0);
    Ok(CostEstimate {
        usd: Some(quote.amount),
        evidence: Some(quote.evidence),
        reason: Some(reason),
        ..Default::default()
    })
}

pub fn quote_input(input: &CatalogQuoteInput, catalog: &CatalogSnapshot) -> CostEstimate {
    let model_alias = input.model.rsplit('/').next().unwrap_or(&input.model);
    if model_alias == "qianfan-code-latest" || model_alias.starts_with("gpt-reserve") {
        return unknown("subscription_routing_alias_needs_model");
    }
    match catalog_quote(input, catalog) {
        Ok(cost) => cost,
        Err(error) => {
            if input.provider.is_some() || input.aggregate {
                return unknown(error);
            }
            let mut unknown_fields = Vec::new();
            for (name, value) in [
                ("input_tokens", input.input_tokens),
                ("output_tokens", input.output_tokens),
                ("cache_read_tokens", input.cache_read_tokens),
                ("cache_write_tokens", input.cache_write_tokens),
            ] {
                if value.is_none() {
                    unknown_fields.push(name.into());
                }
            }
            let usage = UsageRecord {
                model: Some(input.model.clone()),
                mode: input.actual_mode.clone().map(|m| normalize_mode(&m).into()),
                mode_basis: if input.actual_mode.is_some() {
                    "response_reported"
                } else {
                    "unknown"
                }
                .into(),
                requested_mode: input.requested_mode.clone(),
                timestamp_ms: input.timestamp_ms.unwrap_or(0),
                input_tokens: input.input_tokens.unwrap_or(0),
                output_tokens: input.output_tokens.unwrap_or(0),
                cache_read_tokens: input.cache_read_tokens.unwrap_or(0),
                cache_write_tokens: input.cache_write_tokens.unwrap_or(0),
                cache_write_5m_tokens: input.cache_write_5m_tokens,
                cache_write_1h_tokens: input.cache_write_1h_tokens,
                context_tokens: input.context_tokens,
                unknown_fields,
                ..Default::default()
            };
            let fallback = estimate_official(&usage);
            if fallback.usd.is_some() || fallback.cny.is_some() || !fallback.scenarios.is_empty() {
                fallback
            } else if catalog.providers.is_empty() {
                fallback
            } else {
                unknown(error)
            }
        }
    }
}

#[cfg(test)]
mod catalog_tests {
    use super::*;
    fn catalog() -> CatalogSnapshot {
        CatalogSnapshot::parse(r#"{
          "openai":{"models":{
            "gpt-6.1-sol":{"cost":{"input":2,"output":10,"cache_read":0.1,"cache_write":2.5,"tiers":[{"tier":{"type":"context","size":272000},"input":4,"output":15,"cache_read":0.2,"cache_write":5}]},"experimental":{"modes":{"fast":{"cost":{"input":4,"output":20,"cache_read":0.2,"cache_write":5}}}}},
            "gpt-future":{"cost":{"input":1,"output":2,"tiers":[{"tier":{"type":"context","size":1000},"input":2,"output":3}]},"experimental":{"modes":{"fast":{"cost":{"input":2,"output":4}}}}}
          }},
          "anthropic":{"models":{"claude-opus-5-5":{"cost":{"input":4,"output":20,"cache_read":0.2,"cache_write":5}}}},
          "deepseek":{"models":{"deepseek-v4-flash":{"cost":{"input":0.15,"output":0.6,"cache_read":0.003}}}},
          "sensenova":{"models":{"sensenova-6.8-flash-lite":{"cost":{"input":0,"output":0,"cache_read":0}}}},
          "vendor":{"models":{"shared":{"cost":{"input":1,"output":2}},"reasoning-priced":{"cost":{"input":1,"output":2,"reasoning":9}},"same-price":{"cost":{"input":1,"output":2},"experimental":{"modes":{"fast":{"cost":{"input":1,"output":2}}}}}}},
          "other":{"models":{"shared":{"cost":{"input":10,"output":20}}}}
        }"#,"test-revision".into(),1_792_108_800_000).unwrap()
    }
    fn input(model: &str) -> CatalogQuoteInput {
        CatalogQuoteInput {
            model: model.into(),
            actual_mode: Some("standard".into()),
            input_tokens: Some(1000),
            context_tokens: Some(1000),
            output_tokens: Some(100),
            cache_read_tokens: Some(0),
            cache_write_tokens: Some(0),
            ..Default::default()
        }
    }
    fn at(time: &str) -> i64 {
        chrono::DateTime::parse_from_rfc3339(time)
            .unwrap()
            .timestamp_millis()
    }
    #[test]
    fn exact_provider_missing_cache_and_zero_are_distinct() {
        let catalog = catalog();
        let mut item = input("shared");
        assert_eq!(
            quote_input(&item, &catalog).reason.as_deref(),
            Some("ambiguous_model_provider")
        );
        item.provider = Some("vendor".into());
        assert_eq!(
            quote_input(&item, &catalog)
                .evidence
                .unwrap()
                .input_per_million,
            1.
        );
        item.provider = Some("other".into());
        assert_eq!(
            quote_input(&item, &catalog)
                .evidence
                .unwrap()
                .input_per_million,
            10.
        );
        item.provider = Some("vendor".into());
        item.cache_read_tokens = Some(1);
        assert_eq!(
            quote_input(&item, &catalog).reason.as_deref(),
            Some("missing_cache_read_price")
        );
        item = input("sensenova-6.8-flash-lite");
        item.actual_mode = None;
        let free = quote_input(&item, &catalog);
        assert_eq!(free.usd, Some(0.));
        assert!(free.scenarios.is_empty());
        assert_eq!(item.actual_mode, None);
        assert!(free
            .reason
            .unwrap()
            .contains("not_third_party_free_billing"));
        assert_eq!(free.evidence.unwrap().cached_per_million, Some(0.));
        item = input("reasoning-priced");
        item.provider = Some("vendor".into());
        assert_eq!(
            quote_input(&item, &catalog).reason.as_deref(),
            Some("unmeasured_separately_priced_reasoning")
        );
    }
    #[test]
    fn unknown_mode_only_requires_scenarios_when_the_amount_changes() {
        let catalog = catalog();
        let mut item = input("gpt-6.1-sol");
        item.actual_mode = None;
        item.requested_mode = Some("fast".into());
        let cost = quote_input(&item, &catalog);
        assert!(cost.usd.is_none());
        assert_eq!(item.actual_mode, None);
        assert!(cost.scenarios.iter().any(|q| q.mode == "fast"));
        assert!(cost.reason.unwrap().contains("requested_mode_only"));
        item = input("same-price");
        item.actual_mode = None;
        item.provider = Some("vendor".into());
        let cost = quote_input(&item, &catalog);
        assert!(cost.usd.is_some() && cost.scenarios.is_empty());
        assert!(cost
            .reason
            .unwrap()
            .contains("same_amount_for_all_published_tariffs"));
        assert_eq!(item.actual_mode, None);
    }
    #[test]
    fn aggregate_context_uses_real_request_range_and_official_fast_long_gap() {
        let catalog = catalog();
        let mut item = input("gpt-6.1-sol");
        item.provider = Some("openai".into());
        item.aggregate = true;
        item.input_tokens = Some(1_000_000);
        item.context_tokens = None;
        item.context_min = Some(1000);
        item.context_max = Some(2000);
        item.actual_mode = Some("fast".into());
        assert_eq!(
            quote_input(&item, &catalog)
                .evidence
                .unwrap()
                .input_per_million,
            4.
        );
        item.context_min = Some(300_000);
        item.context_max = Some(400_000);
        let long = quote_input(&item, &catalog).evidence.unwrap();
        assert_eq!(long.input_per_million, 8.);
        assert_eq!(long.source_url, OPENAI);
        item.context_min = Some(272_000);
        assert_eq!(
            quote_input(&item, &catalog).reason.as_deref(),
            Some("aggregate_context_spans_price_tiers")
        );
        item.context_min = None;
        item.context_max = None;
        assert_eq!(
            quote_input(&item, &catalog).reason.as_deref(),
            Some("unknown_aggregate_context_range")
        );
        item.context_tokens = Some(1_000_000);
        assert_eq!(
            quote_input(&item, &catalog).reason.as_deref(),
            Some("aggregate_input_is_not_per_request_context")
        );
        item = input("gpt-future");
        item.provider = Some("openai".into());
        item.input_tokens = Some(1001);
        item.context_tokens = Some(1001);
        item.actual_mode = Some("fast".into());
        assert_eq!(
            quote_input(&item, &catalog).reason.as_deref(),
            Some("unverified_mode_context_price")
        );
    }
    #[test]
    fn claude_cache_ttl_supplements_catalog_without_double_counting() {
        let catalog = catalog();
        let mut item = input("claude-opus-5-5");
        item.provider = Some("anthropic".into());
        item.cache_read_tokens = Some(200);
        item.cache_write_tokens = Some(50);
        assert_eq!(
            quote_input(&item, &catalog).reason.as_deref(),
            Some("unknown_cache_write_ttl")
        );
        item.cache_write_5m_tokens = Some(30);
        item.cache_write_1h_tokens = Some(20);
        let quote = quote_input(&item, &catalog);
        assert!((quote.usd.unwrap() - 0.00535).abs() < 1e-12);
        let evidence = quote.evidence.unwrap();
        assert_eq!(evidence.cache_write_1h_per_million, Some(8.));
        assert!(evidence
            .rule_sources
            .iter()
            .any(|source| source == ANTHROPIC));
    }
    #[test]
    fn deepseek_2026_holiday_utc_boundaries_and_unknown_calendar_scenarios() {
        let catalog = catalog();
        let mut item = input("deepseek-v4-flash");
        item.input_tokens = Some(1_000_000);
        item.context_tokens = Some(1_000_000);
        item.output_tokens = Some(0);
        item.actual_mode = None;
        for (time, expected) in [
            ("2026-10-01T01:00:00Z", 0.15),
            ("2026-10-08T00:59:59Z", 0.15),
            ("2026-10-08T01:00:00Z", 0.3),
            ("2026-10-08T04:00:00Z", 0.15),
            ("2026-10-08T06:00:00Z", 0.3),
            ("2026-10-08T10:00:00Z", 0.15),
            ("2026-10-10T01:00:00Z", 0.15),
        ] {
            item.timestamp_ms = Some(at(time));
            assert_eq!(quote_input(&item, &catalog).usd, Some(expected), "{time}");
        }
        item.timestamp_ms = Some(at("2027-01-04T01:00:00Z"));
        let unknown = quote_input(&item, &catalog);
        assert!(unknown.usd.is_none());
        assert_eq!(
            unknown
                .scenarios
                .iter()
                .map(|q| q.scenario_key.as_deref().unwrap())
                .collect::<Vec<_>>(),
            vec!["standard:off_peak", "standard:peak"]
        );
        item.aggregate = true;
        item.context_tokens = None;
        item.context_min = Some(100);
        item.context_max = Some(1000);
        assert_eq!(
            quote_input(&item, &catalog).reason.as_deref(),
            Some("unknown_aggregate_time_band")
        );
        item.time_band = Some("peak".into());
        assert_eq!(quote_input(&item, &catalog).usd, Some(0.3));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(model: &str, mode: &str, input: i64) -> UsageRecord {
        UsageRecord {
            model: Some(model.into()),
            mode: Some(mode.into()),
            mode_basis: "response_reported".into(),
            model_basis: "response_model".into(),
            input_tokens: input,
            context_tokens: Some(input),
            output_tokens: 100,
            cache_read_tokens: 200,
            cache_write_tokens: 50,
            ..Default::default()
        }
    }
    #[test]
    fn standard_fast_and_context_use_exact_table_rows() {
        for (model, expected) in [
            ("gpt-6-astra", 10.),
            ("gpt-6.1-sol", 2.),
            ("gpt-6-sol", 2.),
            ("gpt-6-luna", 0.1),
            ("gpt-5.6-sol", 4.),
        ] {
            let mut r = request(model, "standard", 1000);
            let standard = estimate(&r);
            assert!(standard.scenarios.is_empty());
            assert_eq!(
                standard.evidence.as_ref().unwrap().input_per_million,
                expected
            );
            r.mode = Some("fast".into());
            let fast = estimate(&r);
            assert!((fast.usd.unwrap() - standard.usd.unwrap() * 2.).abs() < 1e-12);
            r.input_tokens = 272_000;
            r.context_tokens = Some(272_000);
            assert_eq!(
                estimate(&r).evidence.unwrap().input_per_million,
                expected * 2.
            );
            r.input_tokens += 1;
            r.context_tokens = Some(r.input_tokens);
            assert_eq!(
                estimate(&r).evidence.unwrap().input_per_million,
                expected * 4.
            );
        }
    }
    #[test]
    fn cache_read_write_and_reasoning_are_not_added_twice() {
        let mut r = request("gpt-6-sol", "standard", 1000);
        r.reasoning_tokens = Some(40);
        assert!(
            (estimate(&r).usd.unwrap()
                - (750. * 2. + 200. * 0.2 + 50. * 2.5 + 100. * 10.) / 1_000_000.)
                .abs()
                < 1e-12
        );
        r.model = Some("claude-opus-5-5".into());
        r.cache_write_5m_tokens = Some(30);
        r.cache_write_1h_tokens = Some(20);
        assert!(
            (estimate(&r).usd.unwrap()
                - (750. * 4. + 200. * 0.2 + 30. * 5. + 20. * 8. + 100. * 20.) / 1_000_000.)
                .abs()
                < 1e-12
        );
        r.mode = Some("fast".into());
        assert_eq!(estimate(&r).evidence.unwrap().input_per_million, 8.);
    }
    #[test]
    fn unknown_mode_alias_breakdown_context_and_ttl_stay_unknown() {
        let mut r = request("claude-opus-5-5", "standard", 1000);
        assert_eq!(
            estimate(&r).reason.as_deref(),
            Some("unknown_cache_write_ttl")
        );
        r.cache_write_5m_tokens = Some(49);
        r.cache_write_1h_tokens = Some(0);
        assert_eq!(
            estimate(&r).reason.as_deref(),
            Some("inconsistent_cache_write_ttl")
        );
        r = request("gpt-6-sol", "standard", 1000);
        r.mode = None;
        let cost = estimate(&r);
        assert!(cost.usd.is_none());
        assert!(cost.cny.is_none());
        assert_eq!(
            cost.scenarios
                .iter()
                .map(|s| s.mode.as_str())
                .collect::<Vec<_>>(),
            vec!["standard", "fast"]
        );
        assert_eq!(r.mode, None);
        r.mode = Some("fast".into());
        r.mode_basis = "requested".into();
        let requested_only = estimate(&r);
        assert!(requested_only.usd.is_none());
        assert_eq!(requested_only.scenarios.len(), 2);
        r = request("gpt-6-sol-latest", "standard", 1000);
        assert!(estimate(&r).usd.is_none());
        r = request("gpt-6-sol", "standard", 1000);
        r.unknown_fields.push("cache_read_tokens".into());
        let incomplete = estimate(&r);
        assert!(incomplete.usd.is_none());
        assert!(incomplete.scenarios.is_empty());
        r.unknown_fields.clear();
        r.context_tokens = None;
        assert!(estimate(&r).usd.is_none());
    }
    #[test]
    fn claude_context_threshold_and_historical_equivalence_are_explicit() {
        let mut r = request("claude-haiku-5-5", "standard", 100_000);
        r.cache_write_tokens = 0;
        assert_eq!(estimate(&r).evidence.unwrap().input_per_million, 0.1);
        r.input_tokens += 1;
        r.context_tokens = Some(r.input_tokens);
        r.timestamp_ms = 1;
        let cost = estimate(&r);
        assert_eq!(cost.evidence.unwrap().input_per_million, 0.5);
        assert!(cost
            .reason
            .unwrap()
            .contains("current_official_price_equivalent"));
        r.model = Some("claude-sonnet-5-5".into());
        r.mode = Some("fast".into());
        assert!(estimate(&r).usd.is_none());
    }

    #[test]
    fn mode_unknown_scenarios_are_reference_prices_not_actual_detection() {
        let mut r = request("gpt-6.1-sol", "standard", 1000);
        r.mode = None;
        r.mode_basis = "unknown".into();
        r.requested_mode = Some("fast".into());
        let cost = estimate(&r);
        assert_eq!(r.mode, None);
        assert!(cost.usd.is_none() && cost.cny.is_none() && cost.evidence.is_none());
        assert_eq!(
            cost.scenarios
                .iter()
                .map(|s| s.mode.as_str())
                .collect::<Vec<_>>(),
            vec!["standard", "fast", "ultrafast"]
        );
        let standard = cost.scenarios[0].amount;
        assert!((cost.scenarios[1].amount - standard * 2.).abs() < 1e-12);
        assert!((cost.scenarios[2].amount - standard * 6.).abs() < 1e-12);
        assert!(cost.reason.unwrap().contains("requested_mode_only"));
        assert!(cost.scenarios.iter().all(|s| s.evidence.currency == "USD"
            && s.evidence.pricing_provider == "OpenAI"
            && s.evidence.version == VERSION));
        r.mode = Some("ultrafast".into());
        r.mode_basis = "response_reported".into();
        let known = estimate(&r);
        assert!(known.scenarios.is_empty());
        assert_eq!(known.usd, Some(cost.scenarios[2].amount));
    }

    #[test]
    fn glm_uses_named_zai_equivalent_and_only_required_token_breakdowns() {
        let mut r = request("glm-5.2", "standard", 1000);
        r.mode = None;
        r.mode_basis = "unknown".into();
        r.context_tokens = None;
        r.reasoning_tokens = Some(40);
        r.unknown_fields = vec!["cache_write_tokens".into(), "timestamp".into()];
        let cost = estimate(&r);
        assert!(
            (cost.usd.unwrap() - (800. * 1.4 + 200. * 0.26 + 100. * 4.4) / 1_000_000.).abs()
                < 1e-12
        );
        assert!(cost.cny.is_none() && cost.scenarios.is_empty());
        let evidence = cost.evidence.unwrap();
        assert_eq!(evidence.pricing_provider, "Z.AI");
        assert_eq!(evidence.currency, "USD");
        assert!(evidence.cache_write_per_million.is_none());
        assert!(
            evidence.cache_write_5m_per_million.is_none()
                && evidence.cache_write_1h_per_million.is_none()
        );
        assert!(cost
            .reason
            .unwrap()
            .contains("cache_storage_currently_free"));
        assert_eq!(r.mode, None);
        r.unknown_fields.push("cache_read_tokens".into());
        assert_eq!(
            estimate(&r).reason.as_deref(),
            Some("incomplete_token_breakdown")
        );
    }

    #[test]
    fn claude_unknown_mode_only_quotes_published_tiers() {
        for (model, expected) in [
            ("claude-opus-5-5", vec!["standard", "fast"]),
            ("claude-sonnet-4-6", vec!["standard"]),
        ] {
            let mut r = request(model, "standard", 1000);
            r.mode = None;
            r.mode_basis = "unknown".into();
            r.cache_write_tokens = 0;
            let cost = estimate(&r);
            assert_eq!(r.mode, None);
            assert!(cost.usd.is_none() && cost.cny.is_none());
            assert_eq!(
                cost.scenarios
                    .iter()
                    .map(|s| s.mode.as_str())
                    .collect::<Vec<_>>(),
                expected
            );
            assert!(cost
                .scenarios
                .iter()
                .all(|s| s.evidence.pricing_provider == "Anthropic"));
            r.cache_write_tokens = 1;
            assert_eq!(
                estimate(&r).reason.as_deref(),
                Some("unknown_cache_write_ttl")
            );
        }
    }

    #[test]
    fn doubao_keeps_cny_context_bands_and_partial_storage_evidence() {
        for (input, expected) in [
            (32_000, 3.2),
            (32_001, 4.8),
            (128_000, 4.8),
            (128_001, 9.6),
            (256_000, 9.6),
        ] {
            let r = request("doubao-seed-2.0-code", "standard", input);
            let cost = estimate(&r);
            let evidence = cost.evidence.unwrap();
            assert!(cost.usd.is_none() && cost.cny.is_some() && cost.scenarios.is_empty());
            assert_eq!(evidence.currency, "CNY");
            assert_eq!(evidence.input_per_million, expected);
            assert!(evidence
                .excluded_components
                .contains(&"unmeasured_explicit_cache_storage".into()));
            assert!(
                evidence.cache_write_5m_per_million.is_none()
                    && evidence.cache_write_1h_per_million.is_none()
            );
            assert!(
                (cost.cny.unwrap()
                    - ((input - 200) as f64 * evidence.input_per_million
                        + 200. * evidence.cached_per_million.unwrap()
                        + 100. * evidence.output_per_million)
                        / 1_000_000.)
                    .abs()
                    < 1e-12
            );
        }
        let r = request("doubao-seed-2.0-code", "standard", 256_001);
        assert_eq!(
            estimate(&r).reason.as_deref(),
            Some("unverified_context_price")
        );
    }

    #[test]
    fn subscription_routing_alias_never_receives_an_invented_model_price() {
        let r = request("qianfan-code-latest", "standard", 1000);
        let cost = estimate(&r);
        assert_eq!(
            cost.reason.as_deref(),
            Some("subscription_routing_alias_needs_model")
        );
        assert!(
            cost.usd.is_none()
                && cost.cny.is_none()
                && cost.scenarios.is_empty()
                && cost.evidence.is_none()
        );
    }
}
