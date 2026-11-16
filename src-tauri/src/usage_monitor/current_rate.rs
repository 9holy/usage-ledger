use super::types::UsageRecord;
use rusqlite::{params, Connection};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CurrentRate {
    tool: String,
    model: Option<String>,
    session_key: String,
    output_tokens_per_second: f64,
    sampled_at_ms: i64,
    interval_ms: i64,
}

pub(super) fn initialize(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS monitor_current_rates (
      session_key TEXT PRIMARY KEY,tool TEXT NOT NULL,id TEXT NOT NULL,observed_ms INTEGER NOT NULL,
      source_ms INTEGER NOT NULL,output_tokens INTEGER NOT NULL,interval_ms INTEGER NOT NULL);")
        .map_err(|e|e.to_string())
}

pub(super) fn sample(usage: &UsageRecord, previous: Option<&UsageRecord>) -> Option<(i64,i64)> {
    let previous = previous?;
    if usage.unknown_fields.iter().chain(&previous.unknown_fields).any(|field| matches!(field.as_str(),"output_tokens"|"timestamp")) { return None; }
    let output = usage.output_tokens - previous.output_tokens;
    let interval = usage.request_timing.as_ref().and_then(|t|t.streaming_duration_ms)
        .zip(previous.request_timing.as_ref().and_then(|t|t.streaming_duration_ms))
        .map(|(after,before)|after-before)
        .unwrap_or(usage.timestamp_ms-previous.timestamp_ms);
    // Only consecutive updates of one request measure generation; separate requests include waits.
    (output>0 && interval>0 && interval<=10_000).then_some((output,interval))
}

pub(super) fn observe(conn:&Connection,usage:&UsageRecord,key:&str,sample:Option<(i64,i64)>,source_ms:i64,observed_ms:i64)->Result<(),String>{
    if let Some((output,interval)) = sample.filter(|_|source_ms>=observed_ms-10_000) {
        conn.prepare_cached("INSERT INTO monitor_current_rates VALUES(?1,?2,?3,?4,?5,?6,?7)
          ON CONFLICT(session_key) DO UPDATE SET tool=excluded.tool,id=excluded.id,observed_ms=excluded.observed_ms,
          source_ms=excluded.source_ms,output_tokens=excluded.output_tokens,interval_ms=excluded.interval_ms")
          .map_err(|e|e.to_string())?.execute(params![key,usage.tool,usage.id,observed_ms,source_ms,output,interval]).map_err(|e|e.to_string())?;
    } else {
        conn.prepare_cached("DELETE FROM monitor_current_rates WHERE session_key=?1").map_err(|e|e.to_string())?.execute([key]).map_err(|e|e.to_string())?;
    }
    Ok(())
}

pub(super) fn read(conn:&Connection,now:i64,started:i64,scope:Option<&str>,keys:Option<&str>,tool:Option<&str>)->Result<Vec<CurrentRate>,String>{
    let mut query=conn.prepare("SELECT s.tool,json_extract(r.usage,'$.model'),s.session_key,s.output_tokens*1000.0/s.interval_ms,s.observed_ms,s.interval_ms
      FROM monitor_current_rates s JOIN monitor_requests r ON r.tool=s.tool AND r.id=s.id
      WHERE s.observed_ms>=MAX(?1-10000,?2) AND s.observed_ms<=?1 AND s.source_ms>=?1-10000 AND s.source_ms<=?1+5000
      AND (?3 IS NULL OR json_extract(r.usage,'$.billingScope')=?3)
      AND (?4 IS NULL OR (s.tool,s.id) IN (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?4)))
      AND (?5 IS NULL OR s.tool=?5)").map_err(|e|e.to_string())?;
    let rows=query.query_map(params![now,started,scope,keys,tool],|r|Ok(CurrentRate{tool:r.get(0)?,model:r.get(1)?,session_key:r.get(2)?,output_tokens_per_second:r.get(3)?,sampled_at_ms:r.get(4)?,interval_ms:r.get(5)?})).map_err(|e|e.to_string())?;
    rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rates_require_continuous_known_output_and_expire() {
        let mut before=UsageRecord{output_tokens:100,timestamp_ms:1000,..Default::default()};
        let mut after=before.clone();after.output_tokens=160;after.timestamp_ms=3000;
        assert_eq!(sample(&after,Some(&before)),Some((60,2000)));
        assert!(sample(&after,None).is_none());
        after.timestamp_ms=20000;assert!(sample(&after,Some(&before)).is_none());
        after.timestamp_ms=1000;assert!(sample(&after,Some(&before)).is_none());
        before.unknown_fields.push("output_tokens".into());after.timestamp_ms=3000;
        assert!(sample(&after,Some(&before)).is_none());
        let mut conn=Connection::open_in_memory().unwrap();super::super::store::initialize(&conn).unwrap();
        let tx=conn.transaction().unwrap();
        after.tool="claude".into();after.id="one".into();after.session_id="session".into();
        super::super::store::save_usage(&tx,&after,i64::MAX,3000).unwrap();tx.commit().unwrap();
        observe(&conn,&after,"claude:session",Some((60,2000)),3000,3000).unwrap();
        assert_eq!(read(&conn,4000,0,None,None,None).unwrap()[0].output_tokens_per_second,30.);
        assert!(read(&conn,14000,0,None,None,None).unwrap().is_empty());
        assert!(read(&conn,4000,5000,None,None,None).unwrap().is_empty());
        assert!(read(&conn,4000,0,Some("api"),None,None).unwrap().is_empty());
        observe(&conn,&after,"claude:session",None,4000,4000).unwrap();
        assert!(read(&conn,4000,0,None,None,None).unwrap().is_empty());
    }
}
