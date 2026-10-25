use crate::usage_monitor::{pricing, types::CostEstimate};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, OnceLock},
    time::Duration,
};

pub const SOURCE_URL: &str = "https://models.dev/api.json";
const DAY_MS: i64 = 86_400_000;
pub const MIGRATION_V15: &str = "CREATE TABLE model_catalog_cache (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), json TEXT NOT NULL, etag TEXT,
 checked_at_ms INTEGER NOT NULL, fetched_at_ms INTEGER NOT NULL, revision TEXT NOT NULL);";

#[derive(Clone, Debug, Default, Deserialize)]
pub struct TokenRates {
    pub input: Option<f64>,
    pub output: Option<f64>,
    pub cache_read: Option<f64>,
    pub cache_write: Option<f64>,
    pub reasoning: Option<f64>,
}
#[derive(Clone, Debug, Deserialize)]
pub struct Tier {
    #[serde(rename = "type")]
    pub kind: String,
    pub size: i64,
}
#[derive(Clone, Debug, Deserialize)]
pub struct TierCost {
    pub tier: Tier,
    #[serde(flatten)]
    pub rates: TokenRates,
}
#[derive(Clone, Debug, Default, Deserialize)]
pub struct CatalogCost {
    #[serde(flatten)]
    pub rates: TokenRates,
    #[serde(default)]
    pub tiers: Vec<TierCost>,
}
#[derive(Clone, Debug, Default, Deserialize)]
pub struct CatalogMode {
    pub cost: Option<CatalogCost>,
}
#[derive(Clone, Debug, Default, Deserialize)]
pub struct Experimental {
    #[serde(default)]
    pub modes: BTreeMap<String, CatalogMode>,
}
#[derive(Clone, Debug, Default, Deserialize)]
pub struct CatalogModel {
    #[serde(default)]
    pub id: String,
    pub canonical_model_id: Option<String>,
    pub cost: Option<CatalogCost>,
    #[serde(default)]
    pub experimental: Experimental,
}
#[derive(Clone, Debug, Default, Deserialize)]
pub struct CatalogProvider {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub models: BTreeMap<String, CatalogModel>,
}
#[derive(Clone, Debug, Default)]
pub struct CatalogSnapshot {
    pub revision: String,
    pub fetched_at_ms: i64,
    pub providers: BTreeMap<String, CatalogProvider>,
    aliases: BTreeMap<String, Vec<(String, String)>>,
}
impl CatalogSnapshot {
    pub fn parse(json: &str, revision: String, fetched_at_ms: i64) -> Result<Self, String> {
        let providers: BTreeMap<String, CatalogProvider> =
            serde_json::from_str(json).map_err(|e| format!("Invalid model catalog: {e}"))?;
        if providers.values().all(|p| p.models.is_empty()) {
            return Err("Model catalog contains no models".into());
        }
        for model in providers.values().flat_map(|p| p.models.values()) {
            for cost in model.cost.iter().chain(
                model
                    .experimental
                    .modes
                    .values()
                    .filter_map(|m| m.cost.as_ref()),
            ) {
                for rates in std::iter::once(&cost.rates).chain(cost.tiers.iter().map(|t| &t.rates))
                {
                    if [
                        rates.input,
                        rates.output,
                        rates.cache_read,
                        rates.cache_write,
                        rates.reasoning,
                    ]
                    .iter()
                    .flatten()
                    .any(|n| !n.is_finite() || *n < 0.)
                    {
                        return Err("Model catalog contains an invalid token price".into());
                    }
                }
                if cost.tiers.iter().any(|tier| tier.tier.size < 0) {
                    return Err("Invalid catalog context threshold".into());
                }
            }
        }
        let mut aliases: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
        for (provider, entry) in &providers {
            for (key, model) in &entry.models {
                let mut names = vec![key.as_str(), model.id.as_str()];
                names.extend(model.canonical_model_id.as_deref());
                names.sort_unstable();
                names.dedup();
                for name in names.into_iter().filter(|name| !name.is_empty()) {
                    aliases
                        .entry(name.into())
                        .or_default()
                        .push((provider.clone(), key.clone()));
                }
            }
        }
        Ok(Self {
            revision,
            fetched_at_ms,
            providers,
            aliases,
        })
    }
    pub fn model_count(&self) -> usize {
        self.providers.values().map(|p| p.models.len()).sum()
    }
    pub fn find<'a>(&'a self, provider: &str, model: &str) -> Option<(&'a str, &'a CatalogModel)> {
        let models = &self.providers.get(provider)?.models;
        if let Some((key, value)) = models.get_key_value(model) {
            return Some((key, value));
        }
        let mut found = self
            .aliases
            .get(model)?
            .iter()
            .filter(|(id, _)| id == provider);
        let (_, key) = found.next()?;
        found
            .next()
            .is_none()
            .then(|| models.get_key_value(key))
            .flatten()
            .map(|(key, value)| (key.as_str(), value))
    }
    pub fn candidates(&self, model: &str) -> Vec<(&str, &str, &CatalogModel)> {
        let Some(aliases) = self.aliases.get(model) else {
            return Vec::new();
        };
        let mut providers: Vec<_> = aliases.iter().map(|(provider, _)| provider).collect();
        providers.sort_unstable();
        providers.dedup();
        providers
            .into_iter()
            .filter_map(|provider| {
                self.find(provider, model)
                    .map(|(key, entry)| (provider.as_str(), key, entry))
            })
            .collect()
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogStatus {
    pub available: bool,
    pub revision: Option<String>,
    pub checked_at_ms: Option<i64>,
    pub fetched_at_ms: Option<i64>,
    pub etag: Option<String>,
    pub refreshing: bool,
    pub error: Option<String>,
    pub model_count: usize,
    pub source_url: String,
}
struct CatalogState {
    snapshot: Arc<CatalogSnapshot>,
    status: CatalogStatus,
}
impl Default for CatalogState {
    fn default() -> Self {
        Self {
            snapshot: Arc::new(CatalogSnapshot::default()),
            status: CatalogStatus {
                source_url: SOURCE_URL.into(),
                ..Default::default()
            },
        }
    }
}
fn state() -> &'static Mutex<CatalogState> {
    static STATE: OnceLock<Mutex<CatalogState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(CatalogState::default()))
}
pub fn snapshot() -> Arc<CatalogSnapshot> {
    state()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .snapshot
        .clone()
}
fn status() -> CatalogStatus {
    state()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .status
        .clone()
}

#[derive(Clone)]
struct CachedCatalog {
    json: String,
    etag: Option<String>,
    checked: i64,
    fetched: i64,
    revision: String,
}
fn read_cache(conn: &Connection) -> Result<Option<CachedCatalog>, String> {
    conn.query_row("SELECT json,etag,checked_at_ms,fetched_at_ms,revision FROM model_catalog_cache WHERE singleton=1",[],|r|Ok(CachedCatalog{json:r.get(0)?,etag:r.get(1)?,checked:r.get(2)?,fetched:r.get(3)?,revision:r.get(4)?})).optional().map_err(|e|e.to_string())
}
fn publish(cached: &CachedCatalog, parsed: CatalogSnapshot) {
    let mut state = state().lock().unwrap_or_else(|e| e.into_inner());
    state.status = CatalogStatus {
        available: true,
        revision: Some(cached.revision.clone()),
        checked_at_ms: Some(cached.checked),
        fetched_at_ms: Some(cached.fetched),
        etag: cached.etag.clone(),
        refreshing: state.status.refreshing,
        error: None,
        model_count: parsed.model_count(),
        source_url: SOURCE_URL.into(),
    };
    state.snapshot = Arc::new(parsed);
}
enum Download {
    NotModified,
    Updated { json: String, etag: Option<String> },
}
fn download(etag: Option<&str>) -> Result<Download, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|e| e.to_string())?;
    let mut request = client.get(SOURCE_URL);
    if let Some(etag) = etag {
        request = request.header(reqwest::header::IF_NONE_MATCH, etag);
    }
    let response = request
        .send()
        .map_err(|e| format!("Catalog download failed: {e}"))?;
    if response.status() == reqwest::StatusCode::NOT_MODIFIED {
        return Ok(Download::NotModified);
    }
    let response = response
        .error_for_status()
        .map_err(|e| format!("Catalog HTTP error: {e}"))?;
    let etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let json = response
        .text()
        .map_err(|e| format!("Cannot read model catalog: {e}"))?;
    Ok(Download::Updated { json, etag })
}
fn update_cache(
    conn: &Connection,
    old: Option<CachedCatalog>,
    download: Result<Download, String>,
    now: i64,
) -> Result<(CachedCatalog, CatalogSnapshot), String> {
    let next = match download? {
        Download::NotModified => {
            let mut old = old.ok_or("Catalog returned 304 without a saved catalog")?;
            old.checked = now;
            old
        }
        Download::Updated { json, etag } => {
            let revision = old
                .as_ref()
                .filter(|old| old.json == json)
                .map(|old| old.revision.clone())
                .unwrap_or_else(|| etag.clone().unwrap_or_else(|| format!("models-dev-{now}")));
            CachedCatalog {
                json,
                etag,
                checked: now,
                fetched: now,
                revision,
            }
        }
    };
    let parsed = CatalogSnapshot::parse(&next.json, next.revision.clone(), next.fetched)?;
    conn.execute("INSERT INTO model_catalog_cache(singleton,json,etag,checked_at_ms,fetched_at_ms,revision) VALUES(1,?1,?2,?3,?4,?5) ON CONFLICT(singleton) DO UPDATE SET json=excluded.json,etag=excluded.etag,checked_at_ms=excluded.checked_at_ms,fetched_at_ms=excluded.fetched_at_ms,revision=excluded.revision",params![next.json,next.etag,next.checked,next.fetched,next.revision]).map_err(|e|e.to_string())?;
    Ok((next, parsed))
}
fn refresh() -> CatalogStatus {
    {
        let mut state = state().lock().unwrap_or_else(|e| e.into_inner());
        if state.status.refreshing {
            return state.status.clone();
        }
        state.status.refreshing = true;
    }
    let result = (|| {
        let conn = crate::ledger_db::open_default().map_err(|e| e.to_string())?;
        let old = read_cache(&conn)?;
        let response = download(old.as_ref().and_then(|v| v.etag.as_deref()));
        update_cache(&conn, old, response, crate::ledger_db::now_ms())
    })();
    match result {
        Ok((cached, parsed)) => publish(&cached, parsed),
        Err(error) => {
            state()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .status
                .error = Some(error)
        }
    }
    let mut state = state().lock().unwrap_or_else(|e| e.into_inner());
    state.status.refreshing = false;
    state.status.clone()
}
pub fn start() {
    static STARTED: OnceLock<()> = OnceLock::new();
    if STARTED.set(()).is_err() {
        return;
    }
    std::thread::spawn(|| {
        let load = (|| {
            let conn = crate::ledger_db::open_default().map_err(|e| e.to_string())?;
            if let Some(cached) = read_cache(&conn)? {
                let parsed =
                    CatalogSnapshot::parse(&cached.json, cached.revision.clone(), cached.fetched)?;
                publish(&cached, parsed);
            }
            Ok::<_, String>(())
        })();
        if let Err(error) = load {
            state()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .status
                .error = Some(error);
        }
        loop {
            let now = crate::ledger_db::now_ms();
            let checked = status().checked_at_ms.unwrap_or(0);
            let delay = DAY_MS
                .saturating_sub(now.saturating_sub(checked))
                .clamp(0, DAY_MS);
            if delay > 0 {
                std::thread::sleep(Duration::from_millis(delay as u64));
                continue;
            }
            refresh();
            // A failed sync is visible, retains the cache, and is retried only on the next daily cycle.
            std::thread::sleep(Duration::from_millis(DAY_MS as u64));
        }
    });
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogQuoteInput {
    pub id: String,
    pub model: String,
    pub provider: Option<String>,
    pub actual_mode: Option<String>,
    pub requested_mode: Option<String>,
    pub timestamp_ms: Option<i64>,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub cache_read_tokens: Option<i64>,
    pub cache_write_tokens: Option<i64>,
    pub cache_write_5m_tokens: Option<i64>,
    pub cache_write_1h_tokens: Option<i64>,
    pub context_tokens: Option<i64>,
    #[serde(default)]
    pub aggregate: bool,
    pub context_min: Option<i64>,
    pub context_max: Option<i64>,
    pub context_tier: Option<String>,
    pub time_band: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogQuoteOutput {
    pub id: String,
    pub cost: CostEstimate,
}
#[tauri::command]
pub fn model_catalog_status() -> CatalogStatus {
    status()
}
#[tauri::command]
pub async fn model_catalog_refresh() -> Result<CatalogStatus, String> {
    tauri::async_runtime::spawn_blocking(refresh)
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn model_catalog_quote_batch(
    items: Vec<CatalogQuoteInput>,
) -> Result<Vec<CatalogQuoteOutput>, String> {
    let catalog = snapshot();
    tauri::async_runtime::spawn_blocking(move || {
        items
            .into_iter()
            .map(|item| {
                let cost = pricing::quote_input(&item, &catalog);
                CatalogQuoteOutput { id: item.id, cost }
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    const JSON: &str = r#"{"vendor":{"models":{"missing":{"id":"missing","cost":{"input":1,"output":2}},"free":{"cost":{"input":0,"output":0,"cache_read":0}}}}}"#;
    #[test]
    fn missing_prices_remain_missing_and_explicit_zero_remains_zero() {
        let catalog = CatalogSnapshot::parse(JSON, "test".into(), 1).unwrap();
        assert_eq!(
            catalog
                .find("vendor", "missing")
                .unwrap()
                .1
                .cost
                .as_ref()
                .unwrap()
                .rates
                .cache_read,
            None
        );
        assert_eq!(
            catalog
                .find("vendor", "free")
                .unwrap()
                .1
                .cost
                .as_ref()
                .unwrap()
                .rates
                .cache_read,
            Some(0.)
        );
        assert!(catalog.find("other", "missing").is_none());
    }
    #[test]
    fn etag_304_and_invalid_refresh_preserve_previous_cache() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(MIGRATION_V15).unwrap();
        let (first, _) = update_cache(
            &conn,
            None,
            Ok(Download::Updated {
                json: JSON.into(),
                etag: Some("etag-one".into()),
            }),
            10,
        )
        .unwrap();
        let (next, _) = update_cache(&conn, Some(first), Ok(Download::NotModified), 20).unwrap();
        assert_eq!(
            (next.fetched, next.checked, next.revision.as_str()),
            (10, 20, "etag-one")
        );
        assert!(update_cache(
            &conn,
            Some(next.clone()),
            Err("HTTP unavailable".into()),
            25
        )
        .is_err());
        assert!(update_cache(
            &conn,
            Some(next),
            Ok(Download::Updated {
                json: "{}".into(),
                etag: None
            }),
            30
        )
        .is_err());
        let saved = read_cache(&conn).unwrap().unwrap();
        assert_eq!(saved.checked, 20);
        assert_eq!(saved.json, JSON);
        assert!(update_cache(&conn, None, Ok(Download::NotModified), 30).is_err());
    }
}
