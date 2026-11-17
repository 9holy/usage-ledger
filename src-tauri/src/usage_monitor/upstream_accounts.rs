use super::types::{RequestTiming, SessionMeta, UsageRecord};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountIdentity {
    pub id: String,
    pub tool: String,
    pub account_id: String,
    pub organization_id: Option<String>,
    pub label: String,
    pub subscription: bool,
    #[serde(default = "eligible")]
    pub quota_eligible: bool,
    #[serde(default)]
    pub quotas: Vec<super::quota::UpstreamQuota>,
    pub subscription_end_ms: Option<i64>,
    pub quota_dimension: Option<String>,
    pub created_at_ms: Option<i64>,
    #[serde(default)]
    pub resets:Vec<ResetEvent>,
}

#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
pub struct ResetEvent {pub id:String,pub at_ms:i64}

fn eligible() -> bool { true }

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub event_id: String,
    pub account: String,
    pub request_id: String,
    pub session_id: Option<String>,
    pub model: String,
    pub timestamp_ms: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    // A provider identity recorded on the request can establish historical ownership.
    pub official_account_id: Option<String>,
    pub details:Option<ReceiptDetails>,
}

#[derive(Clone,Deserialize,Serialize)]
#[serde(rename_all="camelCase")]
pub struct ReceiptDetails {
    pub requested_mode:Option<String>,
    pub client_tool:Option<String>,
    pub duration_ms:Option<i64>,
    pub cache_write5m_tokens:Option<i64>,
    pub cache_write1h_tokens:Option<i64>,
    #[serde(default)]
    pub non_token:bool,
    pub reported_usd:Option<f64>,
}

fn event_key(source:&str,event:&str,time:i64)->String{
    if source=="sub2api" && !event.is_empty() && event.bytes().all(|value|value.is_ascii_digit()){format!("{event}:{time}")}else{event.into()}
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceBatch {
    pub source: String,
    pub instance: String,
    pub observed_ms: i64,
    pub accounts: Vec<AccountIdentity>,
    pub receipts: Vec<Receipt>,
    pub history: Option<HistoryCursor>,
}

#[derive(Clone,Deserialize,Serialize)]
#[serde(rename_all="camelCase")]
pub struct HistoryCursor {
    next_page:u32,
    start_ms:i64,
    end_ms:i64,
    complete:bool,
    last_sync_ms:i64,
    #[serde(default)]
    reset_checked_ms:i64,
}

fn history_key(source:&str,instance:&str)->String{
    format!("upstream_history:{source}:{:x}",md5::compute(instance))
}

fn read_history(conn:&Connection,source:&str,instance:&str,now:i64)->Result<HistoryCursor,String>{
    let saved:Option<String>=conn.query_row("SELECT data FROM monitor_state WHERE key=?1",[history_key(source,instance)],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    let mut cursor=if let Some(saved)=saved {serde_json::from_str::<HistoryCursor>(&saved).map_err(|e|e.to_string())?}else{
        let first:Option<i64>=conn.query_row("SELECT MIN(timestamp_ms) FROM monitor_requests WHERE json_extract(usage,'$.billingScope')='api' AND timestamp_ms>0",[],|r|r.get(0)).map_err(|e|e.to_string())?;
        HistoryCursor{next_page:1,start_ms:first.unwrap_or_else(||now.saturating_sub(600_000)),end_ms:now,complete:false,last_sync_ms:now,reset_checked_ms:0}
    };
    if cursor.complete && now.saturating_sub(cursor.last_sync_ms)>600_000{
        cursor=HistoryCursor{next_page:1,start_ms:cursor.last_sync_ms.saturating_sub(600_000),end_ms:now,complete:false,last_sync_ms:now,reset_checked_ms:cursor.reset_checked_ms};
    }
    Ok(cursor)
}

#[tauri::command]
pub async fn usage_monitor_upstream_history(source:String,instance:String,now_ms:i64)->Result<HistoryCursor,String>{
    if source!="sub2api" || !text(&instance) || now_ms<=0 || now_ms>8_640_000_000_000_000{return Err("Invalid upstream history scope".into());}
    tauri::async_runtime::spawn_blocking(move||read_history(&super::connection()?,&source,&instance,now_ms)).await.map_err(|e|e.to_string())?
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult { accepted: usize, matched: usize, imported:usize, awaiting_identity: usize, changed: bool }

#[derive(Clone, Default)]
pub(super) struct Owner {
    pub account: String,
    pub account_tool: String,
    pub subscription: bool,
    pub sources: BTreeSet<String>,
    pub conflict: bool,
    pub quota_eligible: bool,
}

pub(super) fn initialize(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS monitor_upstream_accounts (
      source TEXT NOT NULL,instance TEXT NOT NULL,local_id TEXT NOT NULL,tool TEXT NOT NULL,
      account_key TEXT NOT NULL,subscription INTEGER NOT NULL,label TEXT NOT NULL,
      first_seen_ms INTEGER NOT NULL,last_seen_ms INTEGER NOT NULL,quota_eligible INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(source,instance,local_id));
      CREATE TABLE IF NOT EXISTS monitor_upstream_receipts (
      source TEXT NOT NULL,instance TEXT NOT NULL,event_id TEXT NOT NULL,tool TEXT NOT NULL,
      account_key TEXT NOT NULL,subscription INTEGER NOT NULL,request_id TEXT NOT NULL,
      model TEXT NOT NULL,timestamp_ms INTEGER NOT NULL,input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,cache_read_tokens INTEGER NOT NULL,cache_write_tokens INTEGER NOT NULL,
      monitor_id TEXT,conflicted INTEGER NOT NULL DEFAULT 0,quota_eligible INTEGER NOT NULL DEFAULT 1,account_tool TEXT NOT NULL DEFAULT '',session_id TEXT,
      local_id TEXT,official_account_id TEXT,details TEXT,original_quote TEXT,
      PRIMARY KEY(source,instance,event_id));
      CREATE INDEX IF NOT EXISTS monitor_upstream_receipt_native ON monitor_upstream_receipts(tool,request_id);
      CREATE INDEX IF NOT EXISTS monitor_upstream_receipt_monitor ON monitor_upstream_receipts(tool,monitor_id);
      CREATE INDEX IF NOT EXISTS monitor_requests_native_identity ON monitor_requests(tool,json_extract(usage,'$.requestId'));
      CREATE INDEX IF NOT EXISTS monitor_requests_shared_identity ON monitor_requests(json_extract(usage,'$.requestId'));
      CREATE INDEX IF NOT EXISTS monitor_upstream_receipt_reference ON monitor_upstream_receipts(request_id);").map_err(|e| e.to_string())?;
    let dimension:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM monitor_state WHERE key='upstream_account_dimension_v1')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    if !dimension {
        let mut columns=conn.prepare("PRAGMA table_info(monitor_upstream_receipts)").map_err(|e|e.to_string())?;
        let names=columns.query_map([],|r|r.get::<_,String>(1)).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
        if !names.iter().any(|name|name=="account_tool"){conn.execute("ALTER TABLE monitor_upstream_receipts ADD COLUMN account_tool TEXT NOT NULL DEFAULT ''",[]).map_err(|e|e.to_string())?;}
        conn.execute("UPDATE monitor_upstream_receipts SET account_tool=tool WHERE account_tool=''",[]).map_err(|e|e.to_string())?;
        conn.execute("INSERT OR IGNORE INTO monitor_state VALUES('upstream_account_dimension_v1','1')",[]).map_err(|e|e.to_string())?;
    }
    let sessions:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM monitor_state WHERE key='upstream_session_matching_v1')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    if !sessions {
        let mut columns=conn.prepare("PRAGMA table_info(monitor_upstream_receipts)").map_err(|e|e.to_string())?;
        let names=columns.query_map([],|r|r.get::<_,String>(1)).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
        if !names.iter().any(|name|name=="session_id"){conn.execute("ALTER TABLE monitor_upstream_receipts ADD COLUMN session_id TEXT",[]).map_err(|e|e.to_string())?;}
        conn.execute("INSERT OR IGNORE INTO monitor_state VALUES('upstream_session_matching_v1','1')",[]).map_err(|e|e.to_string())?;
    }
    conn.execute("CREATE INDEX IF NOT EXISTS monitor_upstream_receipt_session ON monitor_upstream_receipts(session_id,timestamp_ms)",[]).map_err(|e|e.to_string())?;
    let pending:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM monitor_state WHERE key='upstream_pending_identity_v1')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    if !pending {
        let mut columns=conn.prepare("PRAGMA table_info(monitor_upstream_receipts)").map_err(|e|e.to_string())?;
        let names=columns.query_map([],|r|r.get::<_,String>(1)).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
        for name in ["local_id","official_account_id"] {
            if !names.iter().any(|column|column==name) {
                conn.execute(&format!("ALTER TABLE monitor_upstream_receipts ADD COLUMN {name} TEXT"),[]).map_err(|e|e.to_string())?;
            }
        }
        conn.execute("INSERT OR IGNORE INTO monitor_state VALUES('upstream_pending_identity_v1','1')",[]).map_err(|e|e.to_string())?;
    }
    conn.execute("CREATE INDEX IF NOT EXISTS monitor_upstream_receipt_identity ON monitor_upstream_receipts(source,instance,local_id) WHERE NOT conflicted",[]).map_err(|e|e.to_string())?;
    conn.execute_batch("CREATE INDEX IF NOT EXISTS monitor_requests_token_identity ON monitor_requests(session_key,json_extract(usage,'$.model'),json_extract(usage,'$.inputTokens'),json_extract(usage,'$.outputTokens'),json_extract(usage,'$.cacheReadTokens'),json_extract(usage,'$.cacheWriteTokens'));
      CREATE INDEX IF NOT EXISTS monitor_upstream_token_identity ON monitor_upstream_receipts(session_id,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens);").map_err(|e|e.to_string())?;
    let details:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM monitor_state WHERE key='upstream_usage_details_v2')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    if !details {
        let mut columns=conn.prepare("PRAGMA table_info(monitor_upstream_receipts)").map_err(|e|e.to_string())?;
        let names=columns.query_map([],|r|r.get::<_,String>(1)).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
        if !names.iter().any(|name|name=="details"){conn.execute("ALTER TABLE monitor_upstream_receipts ADD COLUMN details TEXT",[]).map_err(|e|e.to_string())?;}
        if !names.iter().any(|name|name=="original_quote"){conn.execute("ALTER TABLE monitor_upstream_receipts ADD COLUMN original_quote TEXT",[]).map_err(|e|e.to_string())?;}
        conn.execute("UPDATE monitor_upstream_receipts SET event_id=event_id||':'||timestamp_ms WHERE source='sub2api' AND event_id<>'' AND event_id NOT GLOB '*[^0-9]*'",[]).map_err(|e|e.to_string())?;
        conn.execute("UPDATE monitor_state SET data=json_set(data,'$.nextPage',1,'$.complete',json('false'),'$.endMs',?1) WHERE key LIKE 'upstream_history:sub2api:%'",[crate::ledger_db::now_ms()]).map_err(|e|e.to_string())?;
        conn.execute("INSERT OR IGNORE INTO monitor_state VALUES('upstream_usage_details_v2','1')",[]).map_err(|e|e.to_string())?;
    }
    Ok(())
}

fn text(value: &str) -> bool { !value.trim().is_empty() && value.len() <= 512 && !value.chars().any(char::is_control) }

fn native_key(conn: &Connection, identity: &AccountIdentity) -> Result<String, String> {
    let raw = match identity.tool.as_str() {
        "codex" => format!("account:{}", identity.account_id),
        "claude" => {
            let organization=identity.organization_id.as_deref().filter(|id|!id.is_empty()).ok_or("Claude upstream identity requires its organization")?;
            super::request_identity::claude_account_key(&identity.account_id,Some(organization))
        },
        _ => return Err("Unsupported upstream account provider".into()),
    };
    let alias=conn.query_row("SELECT account_key FROM monitor_account_native_keys WHERE tool=?1 AND native_key=?2",
        params![identity.tool,raw], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
    if let Some(alias)=alias{return Ok(alias);}
    conn.execute("INSERT OR IGNORE INTO monitor_account_native_keys(tool,native_key,account_key) VALUES(?1,?2,?2)",params![identity.tool,raw]).map_err(|e|e.to_string())?;
    Ok(raw)
}

#[cfg(test)]
pub(super) fn save(conn:&mut Connection,batch:SourceBatch)->Result<SyncResult,String>{save_at(conn,batch,i64::MAX)}

fn save_at(conn: &mut Connection, batch: SourceBatch, live_after:i64) -> Result<SyncResult, String> {
    if !matches!(batch.source.as_str(), "sub2api" | "cliproxy") || !text(&batch.instance)
        || batch.observed_ms <= 0 || batch.observed_ms > 8_640_000_000_000_000 || batch.accounts.len() > 10_000 || batch.receipts.len() > 2_000 {
        return Err("Invalid upstream evidence batch".into());
    }
    if batch.history.as_ref().is_some_and(|cursor|batch.source!="sub2api" || cursor.next_page==0 || cursor.start_ms<0 || cursor.start_ms>cursor.end_ms || cursor.end_ms>batch.observed_ms+60_000){return Err("Invalid upstream history cursor".into());}
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e| e.to_string())?;
    let mut result = SyncResult::default();
    let mut identities = BTreeMap::new();
    for identity in &batch.accounts {
        if !text(&identity.id) || !text(&identity.account_id) || !text(&identity.label)
            || identity.organization_id.as_ref().is_some_and(|id| !text(id)) || identities.contains_key(identity.id.as_str())
            || identity.quotas.len()>2 || identity.quota_dimension.as_ref().is_some_and(|value|!text(value))
            || identity.created_at_ms.is_some_and(|created|created<=0 || created>batch.observed_ms+60_000)
            || identity.resets.len()>100 || identity.resets.iter().any(|event|!text(&event.id)||event.at_ms<=0||event.at_ms>batch.observed_ms+60_000)
            || (!identity.quotas.is_empty() && (identity.tool!="codex" || !identity.subscription || !identity.quota_eligible)) {
            return Err("Invalid or duplicate upstream identity".into());
        }
        let key = native_key(&tx, identity)?;
        let first: Option<(String, bool, i64, bool)> = tx.query_row(
            "SELECT account_key,subscription,first_seen_ms,quota_eligible FROM monitor_upstream_accounts WHERE source=?1 AND instance=?2 AND local_id=?3",
            params![batch.source,batch.instance,identity.id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(|e| e.to_string())?;
        let misread_global=batch.source=="sub2api" && identity.tool=="codex" && identity.quota_dimension.as_deref()==Some("global") && identity.quota_eligible
            && first.as_ref().is_some_and(|(old,subscription,_,eligible)|old==&key && *subscription==identity.subscription && !eligible);
        let changed_key=format!("upstream_identity_changed:{}:{:x}:{}",batch.source,md5::compute(&batch.instance),identity.id);
        let changed=first.as_ref().is_some_and(|(old,subscription,_,eligible)|old!=&key || *subscription!=identity.subscription || (*eligible!=identity.quota_eligible && !misread_global));
        if changed {tx.execute("INSERT OR IGNORE INTO monitor_state VALUES(?1,'1')",[&changed_key]).map_err(|e|e.to_string())?;}
        let changed_before:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM monitor_state WHERE key=?1)",[&changed_key],|r|r.get(0)).map_err(|e|e.to_string())?;
        let mut first_seen = first.filter(|(old, subscription, _, eligible)| old == &key && *subscription == identity.subscription && (*eligible==identity.quota_eligible || misread_global)).map_or(batch.observed_ms, |(_,_,first,_)| first);
        if !changed_before {
            if let Some(created)=identity.created_at_ms {
                let previous_owner:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM monitor_upstream_receipts WHERE source=?1 AND instance=?2 AND local_id=?3 AND account_key<>'' AND account_key<>?4)",params![batch.source,batch.instance,identity.id,key],|r|r.get(0)).map_err(|e|e.to_string())?;
                if !previous_owner {first_seen=first_seen.min(created);}
            }
        }
        tx.execute("INSERT INTO monitor_upstream_accounts VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)
          ON CONFLICT(source,instance,local_id) DO UPDATE SET tool=excluded.tool,account_key=excluded.account_key,
          subscription=excluded.subscription,label=excluded.label,first_seen_ms=excluded.first_seen_ms,last_seen_ms=excluded.last_seen_ms,quota_eligible=excluded.quota_eligible",
            params![batch.source,batch.instance,identity.id,identity.tool,key,identity.subscription,identity.label,first_seen,batch.observed_ms,identity.quota_eligible]).map_err(|e| e.to_string())?;
        if misread_global {
            result.changed |= tx.execute("UPDATE monitor_upstream_receipts SET quota_eligible=1 WHERE source=?1 AND instance=?2
              AND account_key=?3 AND subscription=?4 AND NOT quota_eligible AND NOT conflicted
              AND (local_id=?5 OR (local_id IS NULL AND (SELECT COUNT(*) FROM monitor_upstream_accounts a WHERE a.source=?1 AND a.instance=?2 AND a.account_key=?3)=1))",
              params![batch.source,batch.instance,key,identity.subscription,identity.id]).map_err(|e|e.to_string())?>0;
        }
        identities.insert(identity.id.as_str(), (identity, key, first_seen));
    }
    let conflict="(local_id IS NOT NULL AND local_id<>excluded.local_id)
          OR (request_id<>'' AND excluded.request_id<>'' AND request_id<>excluded.request_id)
          OR model<>excluded.model OR timestamp_ms<>excluded.timestamp_ms
          OR input_tokens<>excluded.input_tokens OR output_tokens<>excluded.output_tokens
          OR cache_read_tokens<>excluded.cache_read_tokens OR cache_write_tokens<>excluded.cache_write_tokens
          OR (session_id IS NOT NULL AND excluded.session_id IS NOT NULL AND session_id<>excluded.session_id)
          OR (official_account_id IS NOT NULL AND excluded.official_account_id IS NOT NULL AND official_account_id<>excluded.official_account_id)";
    let save_receipt=format!("INSERT INTO monitor_upstream_receipts(source,instance,event_id,tool,account_tool,account_key,subscription,request_id,session_id,model,timestamp_ms,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,local_id,official_account_id,details)
          VALUES(?1,?2,?3,'','','',0,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)
          ON CONFLICT(source,instance,event_id) DO UPDATE SET conflicted=conflicted OR ({conflict}),
          local_id=COALESCE(local_id,excluded.local_id),session_id=COALESCE(session_id,excluded.session_id),
          official_account_id=COALESCE(official_account_id,excluded.official_account_id),
          details=COALESCE(excluded.details,details),
          request_id=CASE WHEN request_id='' THEN excluded.request_id ELSE request_id END
          WHERE (NOT conflicted AND ({conflict})) OR local_id IS NULL
          OR (session_id IS NULL AND excluded.session_id IS NOT NULL)
          OR (official_account_id IS NULL AND excluded.official_account_id IS NOT NULL)
          OR (excluded.details IS NOT NULL AND details IS NOT excluded.details)
          OR (request_id='' AND excluded.request_id<>'')");
    let mut references=BTreeSet::new();
    for receipt in &batch.receipts {
        if !text(&receipt.event_id) || !text(&receipt.account) || !text(&receipt.model)
            || (!receipt.request_id.is_empty() && !text(&receipt.request_id))
            || (receipt.request_id.is_empty() && receipt.session_id.is_none())
            || receipt.session_id.as_ref().is_some_and(|id|!text(id))
            || receipt.official_account_id.as_ref().is_some_and(|id|!text(id))
            || receipt.details.as_ref().is_some_and(|details|details.requested_mode.as_ref().is_some_and(|mode|!text(mode)) || details.client_tool.as_ref().is_some_and(|tool|!matches!(tool.as_str(),"codex"|"claude"|"antigravity"|"deepseek-harness"|"api")) || [details.duration_ms,details.cache_write5m_tokens,details.cache_write1h_tokens].into_iter().flatten().any(|value|value<0) || details.reported_usd.is_some_and(|amount|!amount.is_finite()||amount<0.))
            || receipt.timestamp_ms <= 0 || receipt.timestamp_ms > batch.observed_ms + 60_000
            || [receipt.input_tokens,receipt.output_tokens,receipt.cache_read_tokens,receipt.cache_write_tokens].iter().any(|n| *n < 0)
            || receipt.cache_read_tokens.checked_add(receipt.cache_write_tokens).is_none_or(|cached|cached>receipt.input_tokens) {
            return Err("Invalid upstream request evidence".into());
        }
        let receipt_changed=tx.execute(&save_receipt,
          params![batch.source,batch.instance,event_key(&batch.source,&receipt.event_id,receipt.timestamp_ms),receipt.request_id,receipt.session_id,receipt.model,receipt.timestamp_ms,receipt.input_tokens,receipt.output_tokens,receipt.cache_read_tokens,receipt.cache_write_tokens,receipt.account,receipt.official_account_id,receipt.details.as_ref().map(serde_json::to_string).transpose().map_err(|e|e.to_string())?]).map_err(|e| e.to_string())?>0;
        result.changed|=receipt_changed;
        if receipt_changed{references.insert(receipt.request_id.clone());}
        if receipt.details.as_ref().is_some_and(|details|details.non_token){
            result.changed|=tx.execute("UPDATE monitor_upstream_receipts SET quota_eligible=0 WHERE source=?1 AND instance=?2 AND event_id=?3 AND quota_eligible",params![batch.source,batch.instance,event_key(&batch.source,&receipt.event_id,receipt.timestamp_ms)]).map_err(|e|e.to_string())?>0;
        }
    }
    for (identity,key,first_seen) in identities.values() {
        // Source account creation covers initial history; an observed identity change starts a new binding.
        let mut resolve=tx.prepare("UPDATE monitor_upstream_receipts SET
          account_key=?4,tool=?5,account_tool=?5,subscription=?6,quota_eligible=CASE WHEN json_extract(details,'$.nonToken') THEN 0 ELSE ?7 END
          WHERE source=?1 AND instance=?2 AND local_id=?3 AND NOT conflicted AND account_key=''
          AND (official_account_id=?8 OR (official_account_id IS NULL AND timestamp_ms>=?9 AND timestamp_ms<=?10))
          RETURNING request_id").map_err(|e|e.to_string())?;
        let rows=resolve.query_map(params![batch.source,batch.instance,identity.id,key,identity.tool,identity.subscription,identity.quota_eligible,identity.account_id,first_seen,batch.observed_ms],|r|r.get::<_,String>(0)).map_err(|e|e.to_string())?;
        let mut resolved=false;
        for row in rows {references.insert(row.map_err(|e|e.to_string())?);result.changed=true;resolved=true;}
        if resolved {
            tx.execute("INSERT INTO monitor_account_profiles(tool,account_key,label,saved_ms) VALUES(?1,?2,?3,?4)
              ON CONFLICT(tool,account_key) DO NOTHING",params![identity.tool,key,identity.label,batch.observed_ms]).map_err(|e|e.to_string())?;
        }
        if identity.label != identity.account_id {
            result.changed |= tx.execute("UPDATE monitor_account_profiles SET label=?3,saved_ms=?4
              WHERE tool=?1 AND account_key=?2 AND label<>?3",params![identity.tool,key,identity.label,batch.observed_ms]).map_err(|e|e.to_string())?>0;
        }
        for quota in &identity.quotas {
            if quota.observed_at_ms>=*first_seen {
                result.changed |= super::quota::save_upstream_codex(&tx,key,&identity.label,&batch.source,quota,batch.observed_ms)?;
            }
        }
        for reset in &identity.resets {
            if identity.tool=="codex" && identity.subscription && reset.at_ms>=*first_seen {
                let reset_source=format!("{}:{:x}",batch.source,md5::compute(&batch.instance));
                result.changed|=super::accounts::record_upstream_reset(&tx,key,&reset_source,&reset.id,reset.at_ms)?;
            }
        }
        if identity.tool=="codex"&&!identity.quotas.is_empty(){result.changed|=super::accounts::apply_saved_resets(&tx,key)?;}
        if identity.tool=="codex" && identity.subscription {
            if let Some(end)=identity.subscription_end_ms {
                result.changed |= super::accounts::save_upstream_subscription(&tx,key,&batch.source,end,batch.observed_ms)?;
            }
        }
    }
    for receipt in &batch.receipts {
        let (resolved,linked):(bool,bool)=tx.query_row("SELECT account_key<>'' AND NOT conflicted,monitor_id IS NOT NULL FROM monitor_upstream_receipts WHERE source=?1 AND instance=?2 AND event_id=?3",
          params![batch.source,batch.instance,event_key(&batch.source,&receipt.event_id,receipt.timestamp_ms)],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;
        if resolved {result.accepted+=1;if !linked{references.insert(receipt.request_id.clone());}} else {result.awaiting_identity+=1;}
    }
    result.matched+=rebind_references(&tx,&references)?;
    result.imported=import_source_requests(&tx,&references,live_after.max(batch.observed_ms.saturating_sub(60_000)),batch.observed_ms)?;
    result.changed|=result.imported>0;
    result.changed |= result.matched>0;
    if let Some(mut cursor)=batch.history{
        cursor.last_sync_ms=batch.observed_ms;
        tx.execute("INSERT INTO monitor_state(key,data) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET data=excluded.data
          WHERE json_extract(excluded.data,'$.lastSyncMs')>=json_extract(monitor_state.data,'$.lastSyncMs')",
          params![history_key(&batch.source,&batch.instance),serde_json::to_string(&cursor).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(result)
}

fn match_receipt(conn: &Transaction<'_>, reference: &str) -> Result<usize, String> {
    if reference.is_empty(){return match_session_receipts(conn,reference);}
    let mut query = conn.prepare("SELECT tool,id,usage FROM monitor_requests WHERE json_extract(usage,'$.requestId')=?1 AND COALESCE(json_extract(usage,'$.usageBasis'),'')<>'upstream_receipt'
      UNION SELECT tool,id,usage FROM monitor_requests WHERE tool IN ('codex','claude','antigravity','deepseek-harness','api') AND id IN (?1,?2,?3,?4) AND COALESCE(json_extract(usage,'$.usageBasis'),'')<>'upstream_receipt'").map_err(|e| e.to_string())?;
    let rows = query.query_map(params![reference,format!("response:{reference}"),format!("request:{reference}"),format!("message:{reference}")], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).map_err(|e| e.to_string())?;
    let mut candidates = Vec::new();
    for row in rows {
        let (tool,id, json) = row.map_err(|e| e.to_string())?;
        let usage: UsageRecord = serde_json::from_str(&json).map_err(|e| e.to_string())?;
        candidates.push((tool,id, usage));
    }
    if candidates.is_empty(){return match_session_receipts(conn,reference);}
    if candidates.len() != 1 {
        conn.execute("UPDATE monitor_upstream_receipts SET monitor_id=NULL WHERE request_id=?1",[reference]).map_err(|e|e.to_string())?;
        return Ok(0);
    }
    let (tool,id, usage) = &candidates[0];
    if usage.unknown_fields.iter().any(|field| matches!(field.as_str(),"input_tokens"|"output_tokens"|"cache_read_tokens"|"cache_write_tokens")) {
        conn.execute("UPDATE monitor_upstream_receipts SET monitor_id=NULL WHERE request_id=?1 AND monitor_id IS NOT NULL",[reference]).map_err(|e|e.to_string())?;
        return Ok(0);
    }
    retire_source_aliases(conn,reference,tool,id)?;
    conn.execute("UPDATE monitor_upstream_receipts SET monitor_id=?3,tool=?1 WHERE request_id=?2 AND NOT conflicted
      AND account_key<>''
      AND model=?4 AND input_tokens=?5 AND output_tokens=?6 AND cache_read_tokens=?7 AND cache_write_tokens=?8
      AND (monitor_id IS NULL OR monitor_id<>?3 OR tool<>?1)",params![tool,reference,id,usage.model,usage.input_tokens,usage.output_tokens,usage.cache_read_tokens,usage.cache_write_tokens]).map_err(|e| e.to_string())
}

fn retire_source_aliases(tx:&Transaction<'_>,reference:&str,tool:&str,id:&str)->Result<(),String>{
    let aliases={
        let mut query=tx.prepare("SELECT DISTINCT r.tool,r.monitor_id,s.session_key FROM monitor_upstream_receipts r
          JOIN monitor_requests n ON n.tool=?2 AND n.id=?3
          JOIN monitor_requests s ON s.tool=r.tool AND s.id=r.monitor_id
          WHERE r.request_id=?1 AND json_extract(s.usage,'$.usageBasis')='upstream_receipt'
          AND r.model=json_extract(n.usage,'$.model') AND r.input_tokens=json_extract(n.usage,'$.inputTokens')
          AND r.output_tokens=json_extract(n.usage,'$.outputTokens') AND r.cache_read_tokens=json_extract(n.usage,'$.cacheReadTokens') AND r.cache_write_tokens=json_extract(n.usage,'$.cacheWriteTokens')").map_err(|e|e.to_string())?;
        let rows=query.query_map(params![reference,tool,id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?))).map_err(|e|e.to_string())?;
        rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?
    };
    for(old_tool,alias,session)in aliases{
        super::store::remove_snapshot_request(tx,&old_tool,&alias)?;
        tx.execute("DELETE FROM monitor_api_requests WHERE id=?1",[&alias]).map_err(|e|e.to_string())?;
        tx.execute("DELETE FROM monitor_original_api_quotes WHERE tool=?1 AND id=?2",params![old_tool,alias]).map_err(|e|e.to_string())?;
        tx.execute("DELETE FROM monitor_sessions WHERE key=?1 AND json_extract(meta,'$.usageSource')='upstream_receipt' AND NOT EXISTS(SELECT 1 FROM monitor_requests WHERE session_key=?1)",[session]).map_err(|e|e.to_string())?;
    }
    Ok(())
}

fn import_source_requests(tx:&Transaction<'_>,references:&BTreeSet<String>,live_after:i64,observed:i64)->Result<usize,String>{
    if references.is_empty(){return Ok(0);}
    let encoded=serde_json::to_string(references).map_err(|e|e.to_string())?;
    let pending={
        let mut query=tx.prepare("SELECT source,instance,account_tool,account_key,event_id,request_id,session_id,model,timestamp_ms,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,details,original_quote
          FROM monitor_upstream_receipts r WHERE source='sub2api' AND NOT conflicted AND account_key<>'' AND details IS NOT NULL AND request_id IN (SELECT value FROM json_each(?1))
          AND (monitor_id IS NULL OR (monitor_id LIKE 'upstream:%' AND json_extract(details,'$.nonToken') AND json_extract(details,'$.reportedUsd') IS NOT NULL
            AND (SELECT json_extract(cost,'$.usd') FROM monitor_requests n WHERE n.tool=r.tool AND n.id=r.monitor_id) IS NOT json_extract(details,'$.reportedUsd')))").map_err(|e|e.to_string())?;
        let rows=query.query_map([encoded],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,Receipt{
            event_id:r.get(4)?,account:String::new(),request_id:r.get(5)?,session_id:r.get(6)?,model:r.get(7)?,timestamp_ms:r.get(8)?,input_tokens:r.get(9)?,output_tokens:r.get(10)?,cache_read_tokens:r.get(11)?,cache_write_tokens:r.get(12)?,details:Some(serde_json::from_str(&r.get::<_,String>(13)?).map_err(|e|rusqlite::Error::FromSqlConversionFailure(13,rusqlite::types::Type::Text,Box::new(e)))?),official_account_id:None},r.get::<_,Option<String>>(14)?))).map_err(|e|e.to_string())?;
        rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?
    };
    let catalog=crate::model_catalog::snapshot();
    let mut imported=0;
    for(source,instance,account_tool,account,receipt,quote)in pending{
        let session=receipt.session_id.clone().unwrap_or_else(||format!("upstream:{source}:{:x}:{:x}",md5::compute(&instance),md5::compute(&account)));
        let represented:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM monitor_requests WHERE COALESCE(json_extract(usage,'$.usageBasis'),'')<>'upstream_receipt' AND (
          json_extract(usage,'$.requestId')=?1 OR id IN (?1,?2,?3,?4) OR (session_key IN (?5,?6,?7,?8,?9)
          AND json_extract(usage,'$.model')=?10 AND json_extract(usage,'$.inputTokens')=?11 AND json_extract(usage,'$.outputTokens')=?12 AND json_extract(usage,'$.cacheReadTokens')=?13 AND json_extract(usage,'$.cacheWriteTokens')=?14)))",
          params![receipt.request_id,format!("response:{}",receipt.request_id),format!("request:{}",receipt.request_id),format!("message:{}",receipt.request_id),format!("codex:{session}"),format!("claude:{session}"),format!("antigravity:{session}"),format!("deepseek-harness:{session}"),format!("api:{session}"),receipt.model,receipt.input_tokens,receipt.output_tokens,receipt.cache_read_tokens,receipt.cache_write_tokens],|r|r.get(0)).map_err(|e|e.to_string())?;
        if represented{continue;}
        let aggregate:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM monitor_requests WHERE session_key IN (?1,?2,?3,?4,?5) AND timestamp_ms>=?6 AND json_extract(usage,'$.usageBasis')='legacy_initial_cumulative')",
          params![format!("codex:{session}"),format!("claude:{session}"),format!("antigravity:{session}"),format!("deepseek-harness:{session}"),format!("api:{session}"),receipt.timestamp_ms],|r|r.get(0)).map_err(|e|e.to_string())?;
        if aggregate{continue;}
        let details=receipt.details.as_ref().unwrap();
        let tool=if let Some(tool)=details.client_tool.as_ref().filter(|tool|tool.as_str()!="api"){tool.clone()}else{
            let mut query=tx.prepare("SELECT tool FROM monitor_sessions WHERE key IN (?1,?2,?3,?4)").map_err(|e|e.to_string())?;
            let tools=query.query_map(params![format!("codex:{session}"),format!("claude:{session}"),format!("antigravity:{session}"),format!("deepseek-harness:{session}")],|r|r.get::<_,String>(0)).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
            if tools.len()==1{tools[0].clone()}else{"api".into()}
        };
        let id=format!("upstream:{source}:{:x}:{}",md5::compute(&instance),receipt.event_id);
        let session_key=super::store::session_key(&tool,&session);
        let known:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM monitor_sessions WHERE key=?1)",[&session_key],|r|r.get(0)).map_err(|e|e.to_string())?;
        if !known{
            super::store::save_session(tx,&SessionMeta{tool:tool.clone(),id:session.clone(),project:Some("Sub2API".into()),status:"unknown".into(),started_at_ms:receipt.timestamp_ms,updated_at_ms:receipt.timestamp_ms,..Default::default()})?;
            tx.execute("UPDATE monitor_sessions SET meta=json_set(meta,'$.usageSource','upstream_receipt') WHERE key=?1",[&session_key]).map_err(|e|e.to_string())?;
        }
        // Bind before pricing; historical imports never pretend to be fresh streaming samples.
        tx.execute("UPDATE monitor_upstream_receipts SET tool=?4,monitor_id=?5 WHERE source=?1 AND instance=?2 AND event_id=?3",params![source,instance,receipt.event_id,tool,id]).map_err(|e|e.to_string())?;
        tx.execute("INSERT OR IGNORE INTO monitor_api_requests VALUES(?1)",[&id]).map_err(|e|e.to_string())?;
        let quote_value=quote.as_ref().map(|json|serde_json::from_str::<serde_json::Value>(json)).transpose().map_err(|e|e.to_string())?;
        let recorded_mode=quote_value.as_ref().filter(|quote|quote["_modeBasis"]=="response_reported").and_then(|quote|quote["_mode"].as_str()).map(str::to_owned);
        let requested=quote_value.as_ref().filter(|quote|quote["_usageBasis"]!="upstream_receipt").and_then(|quote|quote["_requestedMode"].as_str()).map(str::to_owned).or_else(||details.requested_mode.clone());
        let usage=UsageRecord{id:id.clone(),tool:tool.clone(),session_id:session,request_id:Some(receipt.request_id.clone()),timestamp_ms:receipt.timestamp_ms,
            model:Some(receipt.model.clone()),requested_model:Some(receipt.model),model_basis:"upstream_usage_record".into(),provider:Some(if account_tool=="codex"{"openai"}else{"anthropic"}.into()),provider_basis:"upstream_account_identity".into(),
            mode_basis:if recorded_mode.is_some(){"response_reported"}else{"unknown"}.into(),mode:recorded_mode,requested_mode:requested,input_tokens:receipt.input_tokens,output_tokens:receipt.output_tokens,cache_read_tokens:receipt.cache_read_tokens,cache_write_tokens:receipt.cache_write_tokens,
            cache_write_5m_tokens:details.cache_write5m_tokens,cache_write_1h_tokens:details.cache_write1h_tokens,context_tokens:Some(receipt.input_tokens),billing_scope:Some("api".into()),usage_basis:"upstream_receipt".into(),
            request_timing:details.duration_ms.filter(|duration|*duration>0).map(|duration|RequestTiming{duration_ms:Some(duration),basis:"upstream_forward_request".into(),..Default::default()}),..Default::default()};
        let mut usage=usage;
        if details.non_token&&details.reported_usd.is_none() {usage.unknown_fields.push("unsupported_pricing_modifier:non_token_billing".into());}
        let reported=details.reported_usd.filter(|_|details.non_token).map(|amount|serde_json::from_value::<super::types::CostEstimate>(serde_json::json!({
            "usd":amount,"reason":null,"evidence":{"version":"Sub2API recorded amount","sourceUrl":format!("{instance}/admin/usage"),
            "checkedAt":chrono::DateTime::from_timestamp_millis(receipt.timestamp_ms).map(|time|time.to_rfc3339()).unwrap_or_default(),"model":usage.model,"mode":details.requested_mode.as_deref().unwrap_or("standard"),
            "contextTier":"source_recorded_charge","inputPerMillion":0.,"outputPerMillion":0.,"currency":"USD","pricingProvider":"Sub2API","pricingBasis":"upstream_recorded"}
        }))).transpose().map_err(|e|e.to_string())?;
        let quote=reported.or(quote.map(|json|serde_json::from_str::<super::types::CostEstimate>(&json)).transpose().map_err(|e|e.to_string())?);
        let quote=quote.as_ref().filter(|quote|quote.usd.is_some()||quote.cny.is_some()||!quote.scenarios.is_empty());
        super::store::save_source_usage(tx,&usage,live_after,observed,&catalog,quote)?;
        imported+=1;
    }
    Ok(imported)
}

pub(super) fn recover_pending(conn:&mut Connection,started:i64,now:i64)->Result<(),String>{
    let pending:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM monitor_state WHERE key='upstream_usage_pending')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    if !pending{return Ok(());}
    let tx=conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
    let references={
        let mut query=tx.prepare("SELECT DISTINCT request_id FROM monitor_upstream_receipts WHERE source='sub2api' AND monitor_id IS NULL AND NOT conflicted AND account_key<>'' AND details IS NOT NULL").map_err(|e|e.to_string())?;
        let rows=query.query_map([],|r|r.get::<_,String>(0)).map_err(|e|e.to_string())?;
        rows.collect::<Result<BTreeSet<_>,_>>().map_err(|e|e.to_string())?
    };
    rebind_references(&tx,&references)?;
    import_source_requests(&tx,&references,started.max(now.saturating_sub(60_000)),now)?;
    tx.execute("DELETE FROM monitor_state WHERE key='upstream_usage_pending'",[]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())
}

fn rebind_references(tx:&Transaction<'_>,references:&BTreeSet<String>)->Result<usize,String>{
    if references.is_empty(){return Ok(0);}
    let encoded=serde_json::to_string(references).map_err(|e|e.to_string())?;
    let mut query=tx.prepare("SELECT DISTINCT tool,monitor_id FROM monitor_upstream_receipts WHERE request_id IN (SELECT value FROM json_each(?1)) AND monitor_id IS NOT NULL").map_err(|e|e.to_string())?;
    let mut affected=BTreeSet::new();
    let mut matched=0;
    // Keep both old and new links so ambiguous evidence can also restore the original quote.
    for pass in 0..2 {
        let rows=query.query_map([&encoded],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(|e|e.to_string())?;
        for row in rows{affected.insert(row.map_err(|e|e.to_string())?);}
        if pass==0 {for reference in references{matched+=match_receipt(tx,reference)?;}}
    }
    for(tool,id)in affected{super::billing::repair_upstream_quote(tx,&tool,&id)?;}
    Ok(matched)
}

fn match_session_receipts(conn:&Transaction<'_>,reference:&str)->Result<usize,String>{
    let mut receipts=conn.prepare("SELECT source,instance,event_id,session_id,model,timestamp_ms,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,monitor_id
      FROM monitor_upstream_receipts WHERE source IN ('sub2api','cliproxy') AND request_id=?1 AND session_id IS NOT NULL AND NOT conflicted AND account_key<>''").map_err(|e|e.to_string())?;
    let rows=receipts.query_map([reference],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,i64>(5)?,r.get::<_,i64>(6)?,r.get::<_,i64>(7)?,r.get::<_,i64>(8)?,r.get::<_,i64>(9)?,r.get::<_,Option<String>>(10)?))).map_err(|e|e.to_string())?;
    let mut matched=0;
    for row in rows {
        let(source,instance,event,session,model,time,input,output,read,write,old)=row.map_err(|e|e.to_string())?;
        let mut query=conn.prepare_cached("SELECT tool,id,timestamp_ms FROM monitor_requests WHERE session_key IN (?1,?2,?3,?4)
          AND json_extract(usage,'$.model')=?5
          AND json_extract(usage,'$.inputTokens')=?6 AND json_extract(usage,'$.outputTokens')=?7
          AND json_extract(usage,'$.cacheReadTokens')=?8 AND json_extract(usage,'$.cacheWriteTokens')=?9
          AND COALESCE(json_extract(usage,'$.usageBasis'),'')<>'upstream_receipt'
          AND NOT EXISTS(SELECT 1 FROM json_each(usage,'$.unknownFields') WHERE value IN ('input_tokens','output_tokens','cache_read_tokens','cache_write_tokens'))").map_err(|e|e.to_string())?;
        let mut candidates=query.query_map(params![format!("codex:{session}"),format!("claude:{session}"),format!("antigravity:{session}"),format!("deepseek-harness:{session}"),model,input,output,read,write],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?))).map_err(|e|e.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
        let native_candidates=candidates.len();
        let first_native=candidates.first().cloned();
        // Exact session/model/Token identity survives client delivery delay; time only resolves repeats.
        if candidates.len()>1 {candidates.retain(|(_,_,stamp)|time.saturating_sub(3000)<=*stamp && *stamp<=time.saturating_add(3000));}
        if candidates.len()!=1 {
            if native_candidates==0&&old.as_ref().is_some_and(|old|old.starts_with("upstream:")){continue;}
            if old.as_ref().is_some_and(|old|old.starts_with("upstream:")){
                if let Some((tool,id,_))=first_native {retire_source_aliases(conn,reference,&tool,&id)?;}
            }
            conn.execute("UPDATE monitor_upstream_receipts SET monitor_id=NULL WHERE source=?1 AND instance=?2 AND event_id=?3 AND monitor_id IS NOT NULL",params![source,instance,event]).map_err(|e|e.to_string())?;
            continue;
        }
        let (tool,id,_)=&candidates[0];
        let synthetic=old.as_ref().is_some_and(|old|old.starts_with("upstream:"));
        if old.as_ref().is_some_and(|old|old!=id)&&!synthetic{
            conn.execute("UPDATE monitor_upstream_receipts SET monitor_id=NULL,conflicted=1 WHERE source=?1 AND instance=?2 AND event_id=?3",params![source,instance,event]).map_err(|e|e.to_string())?;
            continue;
        }
        let other:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM monitor_upstream_receipts WHERE source=?1 AND instance=?2
          AND tool=?3 AND monitor_id=?4 AND event_id<>?5 AND NOT conflicted)",params![source,instance,tool,id,event],|r|r.get(0)).map_err(|e|e.to_string())?;
        if other {
            conn.execute("UPDATE monitor_upstream_receipts SET monitor_id=NULL,conflicted=1 WHERE source=?1 AND instance=?2 AND ((tool=?3 AND monitor_id=?4) OR event_id=?5)",params![source,instance,tool,id,event]).map_err(|e|e.to_string())?;
            continue;
        }
        if synthetic {retire_source_aliases(conn,reference,tool,id)?;}
        matched+=conn.execute("UPDATE monitor_upstream_receipts SET tool=?4,monitor_id=?5 WHERE source=?1 AND instance=?2 AND event_id=?3 AND monitor_id IS NULL",params![source,instance,event,tool,id]).map_err(|e|e.to_string())?;
    }
    Ok(matched)
}

pub(super) fn bind_request(conn: &Transaction<'_>, usage: &UsageRecord) -> Result<(), String> {
    let unknown=usage.unknown_fields.iter().any(|field|matches!(field.as_str(),"input_tokens"|"output_tokens"|"cache_read_tokens"|"cache_write_tokens"));
    let invalidated=conn.execute("UPDATE monitor_upstream_receipts SET monitor_id=NULL WHERE tool=?1 AND monitor_id=?2
      AND (model IS NOT ?3 OR input_tokens<>?4 OR output_tokens<>?5 OR cache_read_tokens<>?6 OR cache_write_tokens<>?7 OR ?8)",
      params![usage.tool,usage.id,usage.model,usage.input_tokens,usage.output_tokens,usage.cache_read_tokens,usage.cache_write_tokens,unknown]).map_err(|e|e.to_string())?;
    let mut references=BTreeSet::new();
    if let Some(reference) = &usage.request_id {
        let pending: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM monitor_upstream_receipts WHERE request_id=?1 AND NOT conflicted)",[reference], |r| r.get(0)).map_err(|e| e.to_string())?;
        if pending { references.insert(reference.clone()); }
    }
    let mut query=conn.prepare_cached("SELECT DISTINCT request_id FROM monitor_upstream_receipts WHERE source IN ('sub2api','cliproxy') AND session_id=?1 AND model=?2 AND input_tokens=?3 AND output_tokens=?4 AND cache_read_tokens=?5 AND cache_write_tokens=?6 AND NOT conflicted AND account_key<>''").map_err(|e|e.to_string())?;
    let rows=query.query_map(params![usage.session_id,usage.model,usage.input_tokens,usage.output_tokens,usage.cache_read_tokens,usage.cache_write_tokens],|r|r.get::<_,String>(0)).map_err(|e|e.to_string())?;
    for row in rows{references.insert(row.map_err(|e|e.to_string())?);}
    rebind_references(conn,&references)?;
    if invalidated>0 {super::billing::repair_upstream_quote(conn,&usage.tool,&usage.id)?;}
    Ok(())
}

pub(super) fn owners(conn: &Connection, ids: Option<&str>) -> Result<BTreeMap<(String,String),Owner>, String> {
    let mut result = BTreeMap::<(String,String),Owner>::new();
    let mut query = conn.prepare("SELECT tool,monitor_id,account_key,subscription,source,conflicted,quota_eligible,CASE WHEN account_tool='' THEN tool ELSE account_tool END FROM monitor_upstream_receipts
      WHERE monitor_id IS NOT NULL AND account_key<>'' AND (?1 IS NULL OR monitor_id IN (SELECT value FROM json_each(?1)))").map_err(|e| e.to_string())?;
    let rows = query.query_map([ids], |r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,bool>(3)?,r.get::<_,String>(4)?,r.get::<_,bool>(5)?,r.get::<_,bool>(6)?,r.get::<_,String>(7)?))).map_err(|e| e.to_string())?;
    for row in rows {
        let (tool,id,account,subscription,source,conflict,eligible,account_tool) = row.map_err(|e| e.to_string())?;
        let owner = result.entry((tool,id)).or_default();
        owner.conflict |= conflict || (!owner.account.is_empty() && (owner.account != account || owner.subscription != subscription || owner.account_tool!=account_tool));
        owner.quota_eligible=if owner.account.is_empty(){eligible}else{owner.quota_eligible&&eligible};
        owner.account = account; owner.account_tool=account_tool;owner.subscription = subscription; owner.sources.insert(source);
    }
    let mut quota=conn.prepare("SELECT r.id,MIN(a.account_key),COUNT(DISTINCT a.account_key) FROM monitor_request_quota_evidence e
      JOIN monitor_codex_quota_accounts a ON a.home=e.home AND a.reset_ms=e.reset_ms AND a.plan=e.plan
      JOIN monitor_requests r ON r.tool='codex' AND r.id=e.id WHERE json_extract(r.usage,'$.billingScope')='api'
      AND (?1 IS NULL OR r.id IN (SELECT value FROM json_each(?1))) GROUP BY r.id").map_err(|e|e.to_string())?;
    let rows=quota.query_map([ids],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?))).map_err(|e|e.to_string())?;
    for row in rows {
        let(id,account,count)=row.map_err(|e|e.to_string())?;
        result.entry(("codex".into(),id)).or_insert_with(||Owner{account,account_tool:"codex".into(),subscription:true,sources:BTreeSet::from(["api".into()]),conflict:count!=1,quota_eligible:true});
    }
    Ok(result)
}

#[tauri::command]
pub async fn usage_monitor_sync_upstream(batch: SourceBatch,runtime:tauri::State<'_,super::MonitorRuntime>) -> Result<SyncResult, String> {
    let started=runtime.status_snapshot()?.started_at_ms;
    tauri::async_runtime::spawn_blocking(move || {
        let mut conn=crate::ledger_db::open_default().map_err(|e|e.to_string())?;
        save_at(&mut conn,batch,started)
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bind_request(conn:&Connection,usage:&UsageRecord)->Result<(),String>{
        let tx=conn.unchecked_transaction().map_err(|e|e.to_string())?;
        super::bind_request(&tx,usage)?;
        tx.commit().map_err(|e|e.to_string())
    }

    fn database() -> Connection {
        let mut conn=Connection::open_in_memory().unwrap();
        crate::ledger_db::migrate(&mut conn).unwrap();
        super::super::store::initialize(&conn).unwrap();
        conn
    }
    fn usage(id:&str) -> UsageRecord {
        UsageRecord { id:format!("response:{id}"),request_id:Some(id.into()),tool:"codex".into(),session_id:"thread".into(),model:Some("model".into()),billing_scope:Some("api".into()),timestamp_ms:2000,input_tokens:100,output_tokens:20,cache_read_tokens:40,..Default::default() }
    }
    fn insert(conn:&Connection,usage:&UsageRecord){
        conn.execute("INSERT INTO monitor_requests VALUES(?1,?2,'codex:thread',?3,?4,?5)",params![usage.tool,usage.id,usage.timestamp_ms,serde_json::to_string(usage).unwrap(),r#"{"usd":5}"#]).unwrap();
    }
    fn batch(source:&str,instance:&str,account:&str,request:&str) -> SourceBatch {
        SourceBatch { source:source.into(),instance:instance.into(),observed_ms:3000,history:None,
            accounts:vec![AccountIdentity{id:"local-1".into(),tool:"codex".into(),account_id:account.into(),organization_id:None,label:"same@email.test".into(),subscription:true,quota_eligible:true,quotas:Vec::new(),subscription_end_ms:None,quota_dimension:None,created_at_ms:None,resets:Vec::new()}],
            receipts:vec![Receipt{event_id:"event-1".into(),account:"local-1".into(),request_id:request.into(),session_id:None,model:"model".into(),timestamp_ms:2000,input_tokens:100,output_tokens:20,cache_read_tokens:40,cache_write_tokens:0,official_account_id:Some(account.into()),details:None}] }
    }

    #[test]
    fn sources_enrich_one_request_without_duplicate_usage_and_survive_source_removal(){
        let mut conn=database();let request=usage("native");insert(&conn,&request);
        for (source,instance) in [("sub2api","https://one.test/api/v1"),("cliproxy","http://127.0.0.1:8317/v0/management")] {
            assert_eq!(save(&mut conn,batch(source,instance,"upstream-a","native")).unwrap().matched,1);
            assert_eq!(save(&mut conn,batch(source,instance,"upstream-a","native")).unwrap().matched,0);
        }
        let assigned=super::super::accounts::request_assignments(&conn,&[request]).unwrap();
        assert_eq!(assigned[0].2,super::super::quota::report_account_key("codex","account:upstream-a"));
        assert_eq!(assigned[0].3,"cliproxy+sub2api");
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_requests",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(conn.query_row("SELECT SUM(json_extract(cost,'$.usd')) FROM monitor_requests",[],|r|r.get::<_,f64>(0)).unwrap(),5.);
        conn.execute("DELETE FROM monitor_upstream_accounts",[]).unwrap();
        let retained=owners(&conn,None).unwrap();assert_eq!(retained[&("codex".into(),"response:native".into())].account,"account:upstream-a");
        let mut untyped=usage("unknown");untyped.billing_scope=None;
        assert_eq!(super::super::accounts::request_assignments(&conn,&[untyped]).unwrap()[0].3,"unknown");
    }

    #[test]
    fn unique_request_tokens_survive_delivery_delay_and_repeated_tokens_stay_unassigned(){
        let mut conn=database();
        let mut receipt=batch("sub2api","https://one.test/api/v1","upstream-a","gateway-reference");
        receipt.observed_ms=110_000;receipt.receipts[0].session_id=Some("thread".into());receipt.receipts[0].timestamp_ms=100_000;
        let mut native=usage("native");native.timestamp_ms=110_000;insert(&conn,&native);
        assert_eq!(save(&mut conn,receipt).unwrap().matched,1);
        assert_eq!(owners(&conn,None).unwrap()[&("codex".into(),native.id.clone())].account,"account:upstream-a");
        let mut duplicate=native.clone();duplicate.id="response:other".into();duplicate.request_id=Some("other".into());duplicate.timestamp_ms=111_000;
        insert(&conn,&duplicate);bind_request(&conn,&duplicate).unwrap();
        assert!(owners(&conn,None).unwrap().is_empty());

        let mut conn=database();
        let mut delayed=batch("sub2api","https://one.test/api/v1","upstream-a","gateway-reference");
        delayed.observed_ms=110_000;delayed.receipts[0].session_id=Some("thread".into());delayed.receipts[0].timestamp_ms=100_000;
        assert_eq!(save(&mut conn,delayed).unwrap().matched,0);
        insert(&conn,&native);bind_request(&conn,&native).unwrap();
        assert_eq!(owners(&conn,None).unwrap()[&("codex".into(),native.id.clone())].account,"account:upstream-a");
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_requests",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    }

    #[test]
    fn historical_collection_resumes_saved_pages_and_reopens_only_a_missed_interval(){
        let mut conn=database();insert(&conn,&usage("native"));
        let first=read_history(&conn,"sub2api","https://one.test/api/v1",2_000_000).unwrap();
        assert_eq!((first.next_page,first.start_ms,first.complete),(1,2000,false));
        let mut source=batch("sub2api","https://one.test/api/v1","upstream-a","native");source.observed_ms=2_000_000;
        source.history=Some(HistoryCursor{next_page:6,..first});save(&mut conn,source).unwrap();
        let resumed=read_history(&conn,"sub2api","https://one.test/api/v1",2_100_000).unwrap();
        assert_eq!((resumed.next_page,resumed.end_ms,resumed.complete),(6,2_000_000,false));
        let mut invalid=batch("sub2api","https://one.test/api/v1","upstream-a","native");invalid.observed_ms=2_100_000;
        invalid.receipts[0].input_tokens=-1;invalid.history=Some(HistoryCursor{next_page:11,..resumed.clone()});
        assert!(save(&mut conn,invalid).is_err());
        assert_eq!(read_history(&conn,"sub2api","https://one.test/api/v1",2_100_000).unwrap().next_page,6);
        let mut complete=batch("sub2api","https://one.test/api/v1","upstream-a","native");complete.observed_ms=2_100_000;
        complete.history=Some(HistoryCursor{complete:true,..resumed});save(&mut conn,complete).unwrap();
        assert!(read_history(&conn,"sub2api","https://one.test/api/v1",2_600_000).unwrap().complete);
        let gap=read_history(&conn,"sub2api","https://one.test/api/v1",3_000_000).unwrap();
        assert_eq!((gap.next_page,gap.start_ms,gap.end_ms,gap.complete),(1,1_500_000,3_000_000,false));
    }

    #[test]
    fn concurrent_collection_waits_for_the_writer_while_readers_keep_their_snapshot(){
        let unique=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let directory=std::env::temp_dir().join(format!("usage-ledger-writer-{}-{unique}",std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        let path=directory.join("cost_ledger.sqlite");
        let mut writer=crate::ledger_db::open(&path).unwrap();super::super::store::initialize(&writer).unwrap();
        let held=writer.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).unwrap();
        held.execute("INSERT INTO monitor_state VALUES('held-writer','1')",[]).unwrap();
        let (ready_tx,ready_rx)=std::sync::mpsc::channel();
        let worker_path=path.clone();
        let worker=std::thread::spawn(move||{
            let mut conn=Connection::open(&worker_path).unwrap();
            conn.busy_timeout(std::time::Duration::from_secs(2)).unwrap();
            ready_tx.send(()).unwrap();
            save(&mut conn,batch("sub2api","https://one.test/api/v1","upstream-a","source-only"))
        });
        ready_rx.recv().unwrap();
        let reader=crate::ledger_db::open_read_only(&path).unwrap();
        assert_eq!(reader.query_row("SELECT COUNT(*) FROM monitor_state WHERE key='held-writer'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        std::thread::sleep(std::time::Duration::from_millis(50));
        held.commit().unwrap();
        assert_eq!(worker.join().unwrap().unwrap().accepted,1);
        assert_eq!(reader.query_row("SELECT COUNT(*) FROM monitor_upstream_receipts",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        drop(reader);drop(writer);std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn source_only_usage_is_durable_promotes_to_native_once_and_returns_if_snapshot_retires(){
        let mut conn=database();
        let mut source=batch("sub2api","https://one.test/api/v1","upstream-a","gateway-reference");
        source.receipts[0].session_id=Some("thread".into());
        source.receipts[0].model="gpt-6.1-sol".into();
        source.receipts[0].details=Some(ReceiptDetails{requested_mode:Some("standard".into()),client_tool:Some("codex".into()),duration_ms:Some(1000),cache_write5m_tokens:None,cache_write1h_tokens:None,non_token:false,reported_usd:None});
        assert_eq!(save(&mut conn,source).unwrap().imported,1);
        let original=conn.query_row("SELECT usage,cost FROM monitor_requests",[],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).unwrap();
        let imported:UsageRecord=serde_json::from_str(&original.0).unwrap();
        assert_eq!(imported.usage_basis,"upstream_receipt");
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_observations",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        let mut native=usage("native");native.model=Some("gpt-6.1-sol".into());native.context_tokens=Some(100);native.requested_mode=Some("standard".into());native.timestamp_ms=10_000;
        let tx=conn.transaction().unwrap();super::super::store::save_usage_with_catalog(&tx,&native,i64::MAX,10_000,&crate::model_catalog::CatalogSnapshot::default()).unwrap();tx.commit().unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_requests",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(conn.query_row("SELECT monitor_id FROM monitor_upstream_receipts",[],|r|r.get::<_,String>(0)).unwrap(),native.id);
        let totals:super::super::types::Totals=serde_json::from_str(&conn.query_row("SELECT totals FROM monitor_sessions WHERE key='codex:thread'",[],|r|r.get::<_,String>(0)).unwrap()).unwrap();
        assert_eq!((totals.request_count,totals.input_tokens,totals.output_tokens),(1,100,20));
        let tx=conn.transaction().unwrap();super::super::store::remove_snapshot_request(&tx,"codex",&native.id).unwrap();tx.commit().unwrap();
        recover_pending(&mut conn,20_000,20_000).unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_requests",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        let restored:UsageRecord=serde_json::from_str(&conn.query_row("SELECT usage FROM monitor_requests",[],|r|r.get::<_,String>(0)).unwrap()).unwrap();
        assert_eq!(restored.usage_basis,"upstream_receipt");
        assert_eq!((restored.input_tokens,restored.output_tokens),(100,20));
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_observations",[],|r|r.get::<_,i64>(0)).unwrap(),0);
    }

    #[test]
    fn missing_session_does_not_drop_a_source_charge_or_turn_it_into_free_token_usage(){
        let mut conn=database();
        let mut source=batch("sub2api","https://one.test/api/v1","upstream-a","service-call");
        source.receipts[0].model="gpt-6.1-sol".into();source.receipts[0].input_tokens=0;source.receipts[0].output_tokens=0;source.receipts[0].cache_read_tokens=0;
        source.receipts[0].details=Some(ReceiptDetails{requested_mode:Some("standard".into()),client_tool:Some("codex".into()),duration_ms:Some(1000),cache_write5m_tokens:None,cache_write1h_tokens:None,non_token:true,reported_usd:Some(0.01)});
        assert_eq!(save(&mut conn,source).unwrap().imported,1);
        let json:String=conn.query_row("SELECT cost FROM monitor_requests",[],|r|r.get(0)).unwrap();
        let cost:super::super::types::CostEstimate=serde_json::from_str(&json).unwrap();
        assert_eq!(cost.usd,Some(0.01));
        assert_eq!(cost.evidence.as_ref().unwrap().pricing_basis.as_deref(),Some("upstream_recorded"));
        assert!(!owners(&conn,None).unwrap().values().next().unwrap().quota_eligible);
        assert!(cost.scenarios.is_empty());
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_requests",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        let mut corrected=batch("sub2api","https://one.test/api/v1","upstream-a","service-call");
        corrected.receipts[0].model="gpt-6.1-sol".into();corrected.receipts[0].input_tokens=0;corrected.receipts[0].output_tokens=0;corrected.receipts[0].cache_read_tokens=0;
        corrected.receipts[0].details=Some(ReceiptDetails{requested_mode:Some("standard".into()),client_tool:Some("codex".into()),duration_ms:Some(1000),cache_write5m_tokens:None,cache_write1h_tokens:None,non_token:true,reported_usd:Some(0.02)});
        save(&mut conn,corrected).unwrap();
        assert_eq!(conn.query_row("SELECT json_extract(cost,'$.usd') FROM monitor_requests",[],|r|r.get::<_,f64>(0)).unwrap(),0.02);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_requests",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    }

    #[test]
    fn equal_emails_and_local_ids_do_not_merge_accounts_or_organizations(){
        let mut conn=database();insert(&conn,&usage("first"));insert(&conn,&usage("second"));
        save(&mut conn,batch("sub2api","https://one.test/api/v1","upstream-a","first")).unwrap();
        save(&mut conn,batch("sub2api","https://two.test/api/v1","upstream-b","second")).unwrap();
        let assigned=super::super::accounts::request_memberships(&conn,&[usage("first"),usage("second")]).unwrap();
        assert_ne!(assigned[0].2,assigned[1].2);
        let mut identity=AccountIdentity{id:"local".into(),tool:"claude".into(),account_id:"same-user".into(),organization_id:Some("organization-a".into()),label:"same@email.test".into(),subscription:true,quota_eligible:true,quotas:Vec::new(),subscription_end_ms:None,quota_dimension:None,created_at_ms:None,resets:Vec::new()};
        let first=native_key(&conn,&identity).unwrap();identity.organization_id=Some("organization-b".into());assert_ne!(first,native_key(&conn,&identity).unwrap());
        let conflicting=batch("cliproxy","http://127.0.0.1:8317/v0/management","upstream-b","first");save(&mut conn,conflicting).unwrap();
        assert_eq!(super::super::accounts::request_memberships(&conn,&[usage("first")]).unwrap()[0].2,"api:all");
    }

    #[test]
    fn current_identity_does_not_claim_old_requests_and_late_native_logs_bind_once(){
        let mut conn=database();insert(&conn,&usage("old"));
        let mut snapshot=batch("sub2api","https://one.test/api/v1","upstream-a","old");snapshot.receipts[0].official_account_id=None;
        let result=save(&mut conn,snapshot).unwrap();assert_eq!((result.accepted,result.awaiting_identity),(0,1));
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_account_profiles",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        let mut new_request=batch("sub2api","https://one.test/api/v1","upstream-a","later");new_request.receipts[0].event_id="later-event".into();
        let result=save(&mut conn,new_request).unwrap();assert_eq!(result.matched,0);
        let mut later=usage("later");later.output_tokens=21;insert(&conn,&later);bind_request(&conn,&later).unwrap();assert!(owners(&conn,None).unwrap().is_empty());
        conn.execute("UPDATE monitor_requests SET usage=json_set(usage,'$.outputTokens',20) WHERE id=?1",[&later.id]).unwrap();later.output_tokens=20;
        bind_request(&conn,&later).unwrap();bind_request(&conn,&later).unwrap();assert_eq!(owners(&conn,None).unwrap().len(),1);
    }

    #[test]
    fn subscription_routes_do_not_receive_an_extra_api_charge_and_account_partitions_conserve(){
        let mut conn=database();insert(&conn,&usage("subscription"));insert(&conn,&usage("metered"));
        save(&mut conn,batch("sub2api","https://one.test/api/v1","subscription-owner","subscription")).unwrap();
        let mut api=batch("sub2api","https://one.test/api/v1","api-owner","metered");api.accounts[0].subscription=false;api.receipts[0].event_id="metered-event".into();
        save(&mut conn,api).unwrap();
        let settings:super::super::local_cost::Settings=serde_json::from_value(serde_json::json!({"cnyPerUsd":7,"accounts":{},"apiRules":[{"model":null,"startMs":0,"currency":"USD","input":1,"output":1,"cacheRead":1,"cacheWrite":1}]})).unwrap();
        let expenses=super::super::local_cost::api_expense_scoped(&conn,0,4000,&settings,None,&super::super::types::MonitorPeriod::default()).unwrap();
        assert_eq!((expenses.priced_requests,expenses.missing_requests),(1,0));
        assert!((expenses.by_currency["USD"]-0.00012).abs()<1e-12);
        let metered=super::super::quota::report_account_key("codex","account:api-owner");
        assert_eq!(expenses.by_account[&metered].priced_requests,1);
        let (rows,all,_)=super::super::accounts::local_cost_usage(&conn,0,4000).unwrap();
        assert_eq!((all.totals.request_count,rows.iter().map(|row|row.totals.request_count).sum::<i64>()),(2,2));
        assert_eq!(rows.iter().map(|row|row.totals.priced_cost_usd).sum::<f64>(),10.);
        assert_eq!(rows.iter().find(|row|row.id=="api:all").unwrap().totals.request_count,0);
    }

    #[test]
    fn another_quota_pool_keeps_the_same_owner_but_does_not_inflate_the_primary_weekly_prediction(){
        let mut conn=database();insert(&conn,&usage("primary"));insert(&conn,&usage("other-pool"));
        save(&mut conn,batch("sub2api","https://one.test/api/v1","same-owner","primary")).unwrap();
        let mut other=batch("sub2api","https://one.test/api/v1","same-owner","other-pool");other.accounts[0].quota_eligible=false;other.receipts[0].event_id="other-pool".into();
        save(&mut conn,other).unwrap();
        super::super::accounts::observe_quota(&conn,"codex","account:same-owner","secondary",Some(10080),Some(3000),Some(604_801_000),Some(20.)).unwrap();
        let (rows,all,_)=super::super::accounts::local_cost_usage(&conn,0,4000).unwrap();
        assert_eq!(all.totals.request_count,2);
        let row=rows.iter().find(|row|row.totals.request_count==2).unwrap();
        let json=serde_json::to_value(row).unwrap();
        assert_eq!(json["periods"]["currentCycle"]["quotaSnapshot"]["billingTotals"]["subscription"]["requestCount"],1);
        assert_eq!(json["totals"]["pricedCostUsd"],10.);
    }

    #[test]
    fn a_claude_client_using_an_openai_account_joins_that_account_instead_of_creating_a_claude_identity(){
        let mut conn=database();
        let mut direct=usage("direct");direct.billing_scope=Some("subscription".into());insert(&conn,&direct);
        let mut routed=usage("cross-client");routed.tool="claude".into();insert(&conn,&routed);
        conn.execute("INSERT INTO monitor_codex_quota_accounts VALUES('fixture',604801000,'pro','account:shared',1000,1)",[]).unwrap();
        conn.execute("INSERT INTO monitor_request_quota_evidence VALUES(?1,'fixture',604801000,'pro')",[&direct.id]).unwrap();
        let result=save(&mut conn,batch("sub2api","https://one.test/api/v1","shared","cross-client")).unwrap();assert_eq!(result.matched,1);
        let again=save(&mut conn,batch("sub2api","https://one.test/api/v1","shared","cross-client")).unwrap();assert_eq!(again.matched,0);
        let expected=super::super::quota::report_account_key("codex","account:shared");
        let assignments=super::super::accounts::request_assignments(&conn,&[direct,routed]).unwrap();
        assert_eq!(assignments[0].2,expected);assert_eq!(assignments[1].2,expected);assert_eq!(assignments[1].0,"claude");
        let(rows,all,_)=super::super::accounts::local_cost_usage(&conn,0,4000).unwrap();
        assert_eq!(all.totals.request_count,2);
        let row=rows.iter().find(|row|row.id==expected).unwrap();assert_eq!(row.totals.request_count,2);
        let json=serde_json::to_value(row).unwrap();
        assert_eq!(json["sources"]["sub2api"]["models"][0]["tool"],"claude");
        assert!(!rows.iter().any(|row|row.tool=="claude"&&row.totals.request_count>0));
    }

    #[test]
    fn existing_receipts_gain_the_provider_dimension_without_losing_evidence_or_requests(){
        let mut conn=database();insert(&conn,&usage("native"));save(&mut conn,batch("sub2api","https://one.test/api/v1","shared","native")).unwrap();
        conn.execute("DELETE FROM monitor_state WHERE key='upstream_account_dimension_v1'",[]).unwrap();
        conn.execute("ALTER TABLE monitor_upstream_receipts DROP COLUMN account_tool",[]).unwrap();
        conn.execute("DELETE FROM monitor_state WHERE key='upstream_pending_identity_v1'",[]).unwrap();
        conn.execute("DROP INDEX monitor_upstream_receipt_identity",[]).unwrap();
        conn.execute("ALTER TABLE monitor_upstream_receipts DROP COLUMN local_id",[]).unwrap();
        conn.execute("ALTER TABLE monitor_upstream_receipts DROP COLUMN official_account_id",[]).unwrap();
        initialize(&conn).unwrap();initialize(&conn).unwrap();
        let saved=owners(&conn,None).unwrap();assert_eq!(saved[&("codex".into(),"response:native".into())].account_tool,"codex");
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_upstream_receipts",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(conn.query_row("SELECT json_extract(cost,'$.usd') FROM monitor_requests",[],|r|r.get::<_,f64>(0)).unwrap(),5.);
    }

    #[test]
    fn sub2api_session_evidence_matches_different_gateway_and_provider_request_ids_once(){
        let mut conn=database();insert(&conn,&usage("provider-response"));
        let mut source=batch("sub2api","https://one.test/api/v1","shared","gateway-request");source.receipts[0].session_id=Some("thread".into());
        assert_eq!(save(&mut conn,source).unwrap().matched,1);
        let assigned=super::super::accounts::request_assignments(&conn,&[usage("provider-response")]).unwrap();
        assert_eq!(assigned[0].2,super::super::quota::report_account_key("codex","account:shared"));
        assert_eq!(assigned[0].3,"sub2api");
        let mut replay=batch("sub2api","https://one.test/api/v1","shared","gateway-request");replay.receipts[0].session_id=Some("thread".into());assert_eq!(save(&mut conn,replay).unwrap().matched,0);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_requests",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    }

    #[test]
    fn session_matching_rejects_ambiguous_tokens_or_another_session_without_a_clock_gate(){
        let mut conn=database();insert(&conn,&usage("one"));insert(&conn,&usage("two"));
        let mut source=batch("sub2api","https://one.test/api/v1","shared","gateway-request");source.receipts[0].session_id=Some("thread".into());assert_eq!(save(&mut conn,source).unwrap().matched,0);
        assert!(owners(&conn,None).unwrap().is_empty());
        conn.execute("DELETE FROM monitor_requests WHERE id='response:two'",[]).unwrap();
        for(session,time)in [("different-thread",2000)]{
            let mut wrong=batch("sub2api","https://one.test/api/v1","shared","wrong-reference");wrong.observed_ms=30_000;wrong.receipts[0].event_id=format!("{session}-{time}");wrong.receipts[0].session_id=Some(session.into());wrong.receipts[0].timestamp_ms=time;
            assert_eq!(save(&mut conn,wrong).unwrap().matched,0);
        }
        let mut delayed=batch("sub2api","https://one.test/api/v1","shared","delayed-reference");delayed.observed_ms=30_000;delayed.receipts[0].event_id="delayed".into();delayed.receipts[0].session_id=Some("thread".into());delayed.receipts[0].timestamp_ms=20_000;
        assert_eq!(save(&mut conn,delayed).unwrap().matched,1);
    }

    #[test]
    fn source_creation_recovers_initial_history_but_never_extends_a_changed_identity(){
        let mut conn=database();insert(&conn,&usage("native"));
        let mut history=batch("sub2api","https://one.test/api/v1","old","native");history.observed_ms=10_000;
        history.accounts[0].created_at_ms=Some(1000);history.receipts[0].official_account_id=None;
        assert_eq!(save(&mut conn,history).unwrap().matched,1);
        let mut changed=batch("sub2api","https://one.test/api/v1","new","past");changed.observed_ms=50_000;changed.receipts[0].timestamp_ms=20_000;
        changed.accounts[0].created_at_ms=Some(1000);changed.receipts[0].official_account_id=None;changed.receipts[0].event_id="unproven-past".into();
        assert_eq!(save(&mut conn,changed).unwrap().awaiting_identity,1);
        let mut again=batch("sub2api","https://one.test/api/v1","new","past");again.observed_ms=60_000;again.accounts[0].created_at_ms=Some(1000);again.receipts.clear();
        save(&mut conn,again).unwrap();
        assert_eq!(conn.query_row("SELECT first_seen_ms FROM monitor_upstream_accounts",[],|r|r.get::<_,i64>(0)).unwrap(),50_000);
        assert_eq!(conn.query_row("SELECT account_key FROM monitor_upstream_receipts WHERE event_id='unproven-past'",[],|r|r.get::<_,String>(0)).unwrap(),"");
        assert_eq!(owners(&conn,None).unwrap()[&("codex".into(),"response:native".into())].account,"account:old");
    }

    #[test]
    fn subscription_gateway_prices_keep_api_activity_and_restore_api_quotes_on_conflict(){
        for client in ["codex","claude"]{
        let mut conn=database();
        let mut native=usage("priced");native.model=Some("gpt-6.1-sol".into());native.input_tokens=400_000;native.cache_read_tokens=100_000;native.output_tokens=100;
        native.tool=client.into();
        native.context_tokens=Some(400_000);native.mode=Some("standard".into());native.mode_basis="response_reported".into();
        conn.execute("INSERT INTO monitor_api_requests VALUES(?1)",[&native.id]).unwrap();
        let tx=conn.transaction().unwrap();super::super::store::save_usage_with_catalog(&tx,&native,0,2000,&crate::model_catalog::CatalogSnapshot::default()).unwrap();tx.commit().unwrap();
        let api:String=conn.query_row("SELECT cost FROM monitor_requests WHERE id=?1",[&native.id],|r|r.get(0)).unwrap();
        let make=|source:&str,account:&str|{
            let mut source=batch(source,"https://one.test/api/v1",account,"priced");
            source.receipts[0].model=native.model.clone().unwrap();source.receipts[0].input_tokens=native.input_tokens;source.receipts[0].output_tokens=native.output_tokens;source.receipts[0].cache_read_tokens=native.cache_read_tokens;source
        };
        save(&mut conn,make("sub2api","one")).unwrap();
        let stored:serde_json::Value=conn.query_row("SELECT cost FROM monitor_requests WHERE id=?1",[&native.id],|r|r.get::<_,String>(0)).map(|s|serde_json::from_str(&s).unwrap()).unwrap();
        assert!(stored["usd"].is_number(),"{stored}");
        assert!((stored["usd"].as_f64().unwrap()-0.611).abs()<1e-10);
        assert_eq!(super::super::billing::original_api(&conn,client,&native.id).unwrap(),Some(api.clone()));
        assert_eq!(conn.query_row("SELECT json_extract(usage,'$.billingScope') FROM monitor_requests WHERE id=?1",[&native.id],|r|r.get::<_,String>(0)).unwrap(),"api");
        save(&mut conn,make("cliproxy","other")).unwrap();
        assert_eq!(conn.query_row("SELECT cost FROM monitor_requests WHERE id=?1",[&native.id],|r|r.get::<_,String>(0)).unwrap(),api);
        }
    }

    #[test]
    fn delayed_native_logs_bind_session_evidence_but_two_gateway_attempts_do_not_claim_one_request(){
        let mut conn=database();let mut source=batch("sub2api","https://one.test/api/v1","shared","gateway-request");source.receipts[0].session_id=Some("thread".into());assert_eq!(save(&mut conn,source).unwrap().matched,0);
        let local=usage("provider-response");insert(&conn,&local);bind_request(&conn,&local).unwrap();assert_eq!(owners(&conn,None).unwrap().len(),1);
        let mut retry=batch("sub2api","https://one.test/api/v1","shared","another-gateway-request");retry.receipts[0].session_id=Some("thread".into());retry.receipts[0].event_id="second-attempt".into();assert_eq!(save(&mut conn,retry).unwrap().matched,0);
        assert!(owners(&conn,None).unwrap().is_empty());
    }

    #[test]
    fn delayed_identity_resolves_persisted_evidence_without_refetching_the_request(){
        let mut conn=database();insert(&conn,&usage("native"));
        let mut pending=batch("cliproxy","http://127.0.0.1:8317/v0/management","shared","native");pending.accounts.clear();
        let result=save(&mut conn,pending).unwrap();assert_eq!((result.accepted,result.awaiting_identity),(0,1));
        assert!(owners(&conn,None).unwrap().is_empty());
        let mut later=batch("cliproxy","http://127.0.0.1:8317/v0/management","shared","native");later.observed_ms=700_000;later.receipts.clear();
        let result=save(&mut conn,later).unwrap();assert_eq!(result.matched,1);assert!(result.changed);
        assert_eq!(owners(&conn,None).unwrap()[&("codex".into(),"response:native".into())].account,"account:shared");
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_requests",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    }

    #[test]
    fn an_identity_change_cannot_claim_unproven_earlier_pending_requests(){
        let mut conn=database();insert(&conn,&usage("native"));
        let mut pending=batch("sub2api","https://one.test/api/v1","old","native");pending.accounts.clear();pending.receipts[0].official_account_id=None;
        save(&mut conn,pending).unwrap();
        let mut login=batch("sub2api","https://one.test/api/v1","new","native");login.observed_ms=700_000;login.receipts.clear();
        assert_eq!(save(&mut conn,login).unwrap().matched,0);
        assert!(owners(&conn,None).unwrap().is_empty());
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_upstream_receipts WHERE account_key=''",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    }

    #[test]
    fn conflicting_source_replays_and_changed_native_usage_do_not_keep_a_stale_owner(){
        let mut conn=database();let mut local=usage("native");insert(&conn,&local);
        save(&mut conn,batch("sub2api","https://one.test/api/v1","shared","native")).unwrap();
        let mut changed=batch("sub2api","https://one.test/api/v1","shared","native");changed.receipts[0].output_tokens=21;
        let result=save(&mut conn,changed).unwrap();assert!(result.changed);assert_eq!(result.accepted,0);
        assert!(owners(&conn,None).unwrap()[&("codex".into(),"response:native".into())].conflict);
        assert_eq!(conn.query_row("SELECT json_extract(cost,'$.usd') FROM monitor_requests",[],|r|r.get::<_,f64>(0)).unwrap(),5.);
        conn.execute("DELETE FROM monitor_upstream_receipts",[]).unwrap();
        save(&mut conn,batch("cliproxy","http://127.0.0.1:8317/v0/management","shared","native")).unwrap();
        local.output_tokens=21;conn.execute("UPDATE monitor_requests SET usage=?1",[serde_json::to_string(&local).unwrap()]).unwrap();
        bind_request(&conn,&local).unwrap();assert!(owners(&conn,None).unwrap().is_empty());
    }

    #[test]
    fn cliproxy_session_evidence_can_bind_late_without_inventing_a_shared_request_id(){
        let mut conn=database();
        let mut source=batch("cliproxy","http://127.0.0.1:8317/v0/management","shared","");source.receipts[0].session_id=Some("thread".into());
        assert_eq!(save(&mut conn,source).unwrap().matched,0);
        let local=usage("native");insert(&conn,&local);bind_request(&conn,&local).unwrap();
        assert_eq!(owners(&conn,None).unwrap()[&("codex".into(),"response:native".into())].account,"account:shared");
        let mut retry=batch("cliproxy","http://127.0.0.1:8317/v0/management","shared","");retry.receipts[0].session_id=Some("thread".into());retry.receipts[0].event_id="retry".into();
        assert_eq!(save(&mut conn,retry).unwrap().matched,0);
        assert!(owners(&conn,None).unwrap().is_empty());
    }

    #[test]
    fn actual_account_email_replaces_an_old_source_remark_without_reassigning_usage(){
        let mut conn=database();insert(&conn,&usage("native"));
        let mut source=batch("sub2api","https://one.test/api/v1","shared","native");source.accounts[0].label="11-12".into();save(&mut conn,source).unwrap();
        let before:(String,String)=conn.query_row("SELECT usage,cost FROM monitor_requests",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        let mut names=batch("sub2api","https://one.test/api/v1","shared","native");names.receipts.clear();names.accounts[0].label="actual@example.test".into();
        let result=save(&mut conn,names).unwrap();assert!(result.changed);assert_eq!(result.matched,0);
        let label:String=conn.query_row("SELECT label FROM monitor_account_profiles WHERE account_key='account:shared'",[],|r|r.get(0)).unwrap();assert_eq!(label,"actual@example.test");
        assert_eq!(owners(&conn,None).unwrap()[&("codex".into(),"response:native".into())].account,"account:shared");
        let after:(String,String)=conn.query_row("SELECT usage,cost FROM monitor_requests",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();assert_eq!(before,after);
        let mut missing=batch("sub2api","https://one.test/api/v1","shared","native");missing.receipts.clear();missing.accounts[0].label="shared".into();
        assert!(!save(&mut conn,missing).unwrap().changed);
        assert_eq!(conn.query_row("SELECT label FROM monitor_account_profiles WHERE account_key='account:shared'",[],|r|r.get::<_,String>(0)).unwrap(),label);
    }

    #[test]
    fn a_late_shared_response_id_corrects_a_prior_session_only_match(){
        let mut conn=database();let first=usage("first");insert(&conn,&first);
        let mut receipt=batch("cliproxy","http://127.0.0.1:8317/v0/management","shared","");receipt.receipts[0].session_id=Some("thread".into());save(&mut conn,receipt).unwrap();
        let second=usage("second");insert(&conn,&second);
        let mut stronger=batch("cliproxy","http://127.0.0.1:8317/v0/management","shared","second");stronger.receipts[0].session_id=Some("thread".into());
        assert_eq!(save(&mut conn,stronger).unwrap().matched,1);
        let owner=owners(&conn,None).unwrap();assert!(!owner.contains_key(&(first.tool,first.id)));assert!(owner.contains_key(&(second.tool,second.id)));
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_requests",[],|r|r.get::<_,i64>(0)).unwrap(),2);
    }

    #[test]
    fn gateway_quota_and_expiry_attach_to_the_same_account_without_inventing_subscription_dates_or_missing_usage(){
        let mut conn=database();insert(&conn,&usage("native"));
        let mut observed=batch("sub2api","https://one.test/api/v1","shared","native");observed.observed_ms=1500;observed.receipts.clear();save(&mut conn,observed).unwrap();
        let mut source=batch("sub2api","https://one.test/api/v1","shared","native");
        source.accounts[0].quotas.push(super::super::quota::UpstreamQuota{slot:"primary".into(),window_minutes:10080,used_percent:25.,observed_at_ms:2500,resets_at_ms:604_801_000});
        source.accounts[0].subscription_end_ms=Some(900_000_000);
        source.receipts.push(Receipt{event_id:"pending".into(),account:"local-1".into(),request_id:"pending-native".into(),session_id:None,model:"model".into(),timestamp_ms:2100,input_tokens:100,output_tokens:20,cache_read_tokens:40,cache_write_tokens:0,official_account_id:Some("shared".into()),details:None});
        save(&mut conn,source).unwrap();
        let (rows,all,_)=super::super::accounts::local_cost_usage_with_month(&conn,0,3000,Some(0)).unwrap();assert_eq!(all.totals.request_count,1);
        let row=rows.iter().find(|r|r.totals.request_count==1).unwrap();let json=serde_json::to_value(row).unwrap();
        assert_eq!(json["periods"]["currentCycle"]["usedPercent"],25.);
        assert_eq!(json["periods"]["currentCycle"]["quotaSnapshot"]["observedEndMs"],2501);
        assert_eq!(json["periods"]["currentCycle"]["quotaSnapshot"]["sourceCoverageIncomplete"],true);
        assert_eq!(json["periods"]["subscription"]["endMs"],900_000_000);
        assert!(json["periods"]["subscription"]["startMs"].is_null());assert!(json["periods"]["subscriptionMonth"].is_null());
        assert_eq!(json["periods"]["calendarMonth"]["startMs"],0);
        assert_eq!(json["periods"]["calendarMonth"]["totals"]["requestCount"],1);
        let mut late=usage("pending-native");late.timestamp_ms=2100;insert(&conn,&late);bind_request(&conn,&late).unwrap();
        let(rows,_,_)=super::super::accounts::local_cost_usage(&conn,0,3000).unwrap();let row=rows.iter().find(|r|r.totals.request_count==2).unwrap();
        assert_eq!(serde_json::to_value(row).unwrap()["periods"]["currentCycle"]["quotaSnapshot"]["sourceCoverageIncomplete"],false);
        assert_eq!(conn.query_row("SELECT SUM(json_extract(cost,'$.usd')) FROM monitor_requests",[],|r|r.get::<_,f64>(0)).unwrap(),10.);
    }

    #[test]
    fn explicit_global_dimension_repairs_the_misread_primary_pool_without_changing_identity_or_saved_amounts(){
        let mut conn=database();insert(&conn,&usage("native"));
        let mut old=batch("sub2api","https://one.test/api/v1","shared","native");old.accounts[0].quota_eligible=false;save(&mut conn,old).unwrap();
        conn.execute("UPDATE monitor_upstream_receipts SET local_id=NULL",[]).unwrap();
        let mut fixed=batch("sub2api","https://one.test/api/v1","shared","native");fixed.observed_ms=5000;fixed.receipts.clear();fixed.accounts[0].quota_dimension=Some("global".into());
        assert!(save(&mut conn,fixed).unwrap().changed);
        assert!(owners(&conn,None).unwrap()[&("codex".into(),"response:native".into())].quota_eligible);
        assert_eq!(conn.query_row("SELECT first_seen_ms FROM monitor_upstream_accounts",[],|r|r.get::<_,i64>(0)).unwrap(),3000);
        assert_eq!(conn.query_row("SELECT json_extract(cost,'$.usd') FROM monitor_requests",[],|r|r.get::<_,f64>(0)).unwrap(),5.);
    }
}
