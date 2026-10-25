use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub tool: String,
    pub id: String,
    pub parent_id: Option<String>,
    #[serde(default)]
    pub root_id: Option<String>,
    pub project: Option<String>,
    pub model: Option<String>,
    pub status: String,
    pub started_at_ms: i64,
    pub updated_at_ms: i64,
    #[serde(default)]
    pub turn_timing: Option<TurnTiming>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestTiming {
    #[serde(default)]
    pub started_at_ms: Option<i64>,
    #[serde(default)]
    pub completed_at_ms: Option<i64>,
    #[serde(default)]
    pub duration_ms: Option<i64>,
    #[serde(default)]
    pub ttft_ms: Option<i64>,
    #[serde(default)]
    pub streaming_duration_ms: Option<i64>,
    pub basis: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnTiming {
    pub turn_id: String,
    #[serde(default)]
    pub started_at_ms: Option<i64>,
    #[serde(default)]
    pub completed_at_ms: Option<i64>,
    #[serde(default)]
    pub duration_ms: Option<i64>,
    #[serde(default)]
    pub ttft_ms: Option<i64>,
    pub basis: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeModeEvidence {
    pub mode: Option<String>,
    pub conflicted: bool,
    pub observed_at_ms: i64,
    pub source: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRecord {
    pub id: String,
    pub tool: String,
    pub session_id: String,
    pub turn_id: String,
    pub request_id: Option<String>,
    pub root_turn_id: Option<String>,
    pub timestamp_ms: i64,
    pub model: Option<String>,
    pub requested_model: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub provider_basis: String,
    pub model_basis: String,
    pub mode: Option<String>,
    pub requested_mode: Option<String>,
    pub mode_basis: String,
    pub input_tokens: i64,
    #[serde(default)]
    pub source_input_tokens: Option<i64>,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub cache_write_5m_tokens: Option<i64>,
    pub cache_write_1h_tokens: Option<i64>,
    pub reasoning_tokens: Option<i64>,
    pub duration_ms: Option<i64>,
    pub context_tokens: Option<i64>,
    pub usage_basis: String,
    #[serde(default)]
    pub unknown_fields: Vec<String>,
    #[serde(default)]
    pub request_timing: Option<RequestTiming>,
    #[serde(default)]
    pub runtime_mode: Option<RuntimeModeEvidence>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceEvidence {
    pub version: String,
    pub source_url: String,
    pub checked_at: String,
    pub model: String,
    pub mode: String,
    pub context_tier: String,
    pub input_per_million: f64,
    pub cached_per_million: Option<f64>,
    pub cache_write_per_million: Option<f64>,
    pub cache_write_5m_per_million: Option<f64>,
    pub cache_write_1h_per_million: Option<f64>,
    pub output_per_million: f64,
    #[serde(default = "usd_currency")]
    pub currency: String,
    #[serde(default)]
    pub pricing_provider: String,
    #[serde(default)]
    pub excluded_components: Vec<String>,
    #[serde(default)]
    pub catalog_revision: Option<String>,
    #[serde(default)]
    pub pricing_basis: Option<String>,
    #[serde(default)]
    pub rule_version: Option<String>,
    #[serde(default)]
    pub rule_sources: Vec<String>,
    #[serde(default)]
    pub time_band: Option<String>,
}

fn usd_currency() -> String {
    "USD".into()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostScenario {
    #[serde(default)]
    pub scenario_key: Option<String>,
    pub mode: String,
    pub amount: f64,
    pub evidence: PriceEvidence,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostEstimate {
    pub usd: Option<f64>,
    #[serde(default)]
    pub cny: Option<f64>,
    #[serde(default)]
    pub scenarios: Vec<CostScenario>,
    pub reason: Option<String>,
    pub evidence: Option<PriceEvidence>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub request_count: i64,
    pub priced_cost_usd: f64,
    #[serde(default)]
    pub priced_cost_cny: f64,
    #[serde(default)]
    pub scenario_requests: i64,
    #[serde(default)]
    pub scenarios: Vec<ScenarioTotal>,
    pub unpriced_requests: i64,
    pub incomplete_requests: i64,
    #[serde(default)]
    pub cache_unknown_requests: i64,
    pub cache_hit_ratio: Option<f64>,
    #[serde(default)]
    pub known_cache_input_tokens: i64,
    #[serde(default)]
    pub known_cache_read_tokens: i64,
    #[serde(default)]
    pub known_cache_hit_ratio: Option<f64>,
    #[serde(default)]
    pub cache_known_requests: i64,
    pub output_tokens_per_second: f64,
    #[serde(default)]
    pub reasoning_tokens: i64,
    #[serde(default)]
    pub reasoning_known_requests: i64,
    #[serde(default)]
    pub actual_mode_counts: std::collections::BTreeMap<String, i64>,
    #[serde(default)]
    pub requested_mode_counts: std::collections::BTreeMap<String, i64>,
    #[serde(default)]
    pub unpriced_tokens: i64,
    #[serde(default)]
    pub unpriced_token_known_requests: i64,
    #[serde(default)]
    pub unpriced_reason_counts: std::collections::BTreeMap<String, i64>,
    #[serde(default)]
    pub price_summary: PriceSummary,
    #[serde(default)]
    pub automatic_price_summary: AutomaticPriceSummary,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomaticPriceSummary {
    pub by_mode: std::collections::BTreeMap<String, AutomaticModeSummary>,
    pub by_currency: std::collections::BTreeMap<String, AutomaticCurrencySummary>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomaticModeSummary {
    pub response_requests: i64,
    pub requested_requests: i64,
    pub unknown_requests: i64,
    pub covered_requests: i64,
    pub by_currency: std::collections::BTreeMap<String, AutomaticModeAmount>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomaticModeAmount {
    pub amount: f64,
    pub request_count: i64,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomaticCurrencySummary {
    pub response_subtotal: f64,
    pub response_requests: i64,
    pub requested_subtotal: f64,
    pub requested_requests: i64,
    pub unknown_reference_subtotal: f64,
    pub unknown_reference_requests: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PriceSummary {
    pub covered_requests: i64,
    pub by_currency: std::collections::BTreeMap<String, CurrencyPriceSummary>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrencyPriceSummary {
    pub confirmed_subtotal: f64,
    pub confirmed_requests: i64,
    pub standard_subtotal: f64,
    pub standard_requests: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScenarioTotal {
    #[serde(default)]
    pub scenario_key: Option<String>,
    pub mode: String,
    pub currency: String,
    pub amount: f64,
    pub request_count: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub key: String,
    #[serde(flatten)]
    pub meta: SessionMeta,
    pub totals: Totals,
    pub recent_request: Option<RecentRequest>,
    pub request_speed: RequestSpeed,
    pub latest_completed_turn: Option<CompletedTurnSummary>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedTurnSummary {
    pub timing: TurnTiming,
    pub output_tokens: Option<i64>,
    pub output_tokens_per_second: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentRequest {
    pub id: String,
    pub timestamp_ms: i64,
    pub model: Option<String>,
    pub model_basis: String,
    pub mode: Option<String>,
    pub mode_basis: String,
    pub requested_mode: Option<String>,
    pub requested_model: Option<String>,
    pub request_timing: Option<RequestTiming>,
    pub runtime_mode: Option<RuntimeModeEvidence>,
    pub unknown_fields: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeightedRequestSpeed {
    pub basis: Option<String>,
    pub valid_samples: usize,
    pub total_samples: usize,
    pub output_tokens: i64,
    pub duration_ms: i64,
    pub output_tokens_per_second: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestSpeedSample {
    pub request_id: String,
    pub timestamp_ms: i64,
    pub output_tokens: i64,
    pub duration_ms: i64,
    pub output_tokens_per_second: f64,
    pub basis: String,
    pub started_at_ms: Option<i64>,
    pub completed_at_ms: Option<i64>,
    pub ttft_ms: Option<i64>,
    pub streaming_duration_ms: Option<i64>,
    pub streaming_tokens_per_second: Option<f64>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestSpeed {
    pub latest: Option<RequestSpeedSample>,
    pub last10: WeightedRequestSpeed,
    pub by_basis: Vec<WeightedRequestSpeed>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatus {
    pub tool: String,
    pub root: String,
    pub status: String,
    pub files: usize,
    pub last_scan_ms: i64,
    pub error: Option<String>,
    #[serde(default)]
    pub registered_files: usize,
    #[serde(default)]
    pub present_registered_files: Option<usize>,
    #[serde(default)]
    pub missing_registered_files: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorSnapshot {
    pub collected_at_ms: i64,
    pub refresh_ms: u64,
    pub rate_window_seconds: u64,
    pub totals: Totals,
    pub sessions: Vec<SessionSummary>,
    pub active_sessions: Vec<SessionSummary>,
    /// Active/unconfirmed sessions plus every completed session contributing to the observed rate.
    pub rate_sessions: Vec<SessionSummary>,
    pub session_count: i64,
    pub sources: Vec<SourceStatus>,
    pub collecting: bool,
    pub error: Option<String>,
    pub live: LiveSnapshot,
    pub status_counts: MonitorStatusCounts,
    pub tool_status_counts: std::collections::BTreeMap<String, MonitorStatusCounts>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorStatusCounts {
    pub running: i64,
    pub recent: i64,
    pub stale: i64,
    pub idle: i64,
    pub unknown: i64,
    pub active_last30m: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveWindow {
    pub seconds: i64,
    pub observed_output_tokens: i64,
    pub output_tokens_per_second: Option<f64>,
    pub covered_ms: i64,
    pub complete: bool,
    pub source_complete: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveGroup {
    pub tool: Option<String>,
    pub model: Option<String>,
    pub session_key: Option<String>,
    pub windows: Vec<LiveWindow>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveBucket {
    pub start_ms: i64,
    pub end_ms: i64,
    pub observed_output_tokens: i64,
    pub output_tokens: Option<i64>,
    pub covered_ms: i64,
    pub source_complete: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedOutputBucket {
    pub start_ms: i64,
    pub end_ms: i64,
    pub output_tokens: Option<i64>,
    pub known_output_tokens: i64,
    pub request_count: i64,
    pub unknown_output_requests: i64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveSnapshot {
    pub sampled_at_ms: i64,
    pub collection_updated_at_ms: i64,
    pub basis: &'static str,
    pub windows: Vec<LiveWindow>,
    pub by_tool: Vec<LiveGroup>,
    pub by_model: Vec<LiveGroup>,
    pub by_session: Vec<LiveGroup>,
    pub timeline: Vec<LiveBucket>,
    pub timeline_by_tool: std::collections::BTreeMap<String, Vec<LiveBucket>>,
    #[serde(default)]
    pub recorded_timeline: Vec<RecordedOutputBucket>,
    #[serde(default)]
    pub recorded_timeline_by_tool: std::collections::BTreeMap<String, Vec<RecordedOutputBucket>>,
    pub peak_minute_output_tokens: Option<i64>,
    pub source_coverage_incomplete: bool,
    pub unavailable_tools: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestDetail {
    #[serde(flatten)]
    pub usage: UsageRecord,
    pub cost: CostEstimate,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDetail {
    pub session: SessionSummary,
    pub members: Vec<SessionSummary>,
    pub include_descendants: bool,
    pub unlinked_child_requests: u64,
    pub requests: Vec<RequestDetail>,
    pub request_count: i64,
    pub turns: Vec<TurnSummary>,
    pub filtered_totals: Totals,
    pub selected_completed_turn: Option<CompletedTurnSummary>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnSummary {
    pub id: String,
    pub started_at_ms: i64,
    pub updated_at_ms: i64,
    pub totals: Totals,
    pub timing: Option<TurnTiming>,
}

#[derive(Clone, Debug, Default)]
pub struct MonitorPeriod {
    pub start_ms: Option<i64>,
    pub end_ms: Option<i64>,
    pub model: Option<String>,
    pub turn_id: Option<String>,
    pub pricing_reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBreakdown {
    pub tool: String,
    pub model: Option<String>,
    pub totals: Totals,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBucket {
    pub start_ms: i64,
    pub end_ms: i64,
    pub totals: Totals,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorAnalysis {
    pub start_ms: Option<i64>,
    pub end_ms: i64,
    pub totals: Totals,
    pub by_tool: Vec<UsageBreakdown>,
    pub tool_overview: Vec<UsageBreakdown>,
    pub by_model: Vec<UsageBreakdown>,
    pub timeline: Vec<UsageBucket>,
    pub available_models: Vec<String>,
    pub sessions: Vec<SessionSummary>,
    pub session_count: usize,
    pub latest_request_at_ms: std::collections::BTreeMap<String, Option<i64>>,
}
