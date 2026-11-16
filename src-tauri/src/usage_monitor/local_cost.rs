use super::{accounts,store,types::{UsageRecord,Totals,WeightedRequestSpeed,MonitorPeriod},weekly};
use rusqlite::{params,Connection,OptionalExtension};
use serde::{Deserialize,Serialize};
use std::collections::BTreeMap;

#[derive(Default,Serialize)]
#[serde(rename_all="camelCase")]
pub(super) struct UsageAnalytics {
    pub(super) totals:Totals,
    latest_request_ms:Option<i64>,
    models:Vec<ModelUsage>,
    timeline:Vec<TimeUsage>,
    observed_timeline:Vec<super::types::LiveBucket>,
}
impl UsageAnalytics {
    pub(super) fn client_tools(&self)->std::collections::BTreeSet<String>{self.models.iter().map(|row|row.tool.clone()).collect()}
}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
struct ModelUsage {tool:String,model:Option<String>,totals:Totals,speeds:Vec<WeightedRequestSpeed>}
#[derive(Serialize)]
#[serde(rename_all="camelCase")]
struct TimeUsage {start_ms:i64,end_ms:i64,totals:Totals}
#[derive(Default)]
pub(super) struct UsageAnalyticsBuilder {
    totals:Totals,
    latest_request_ms:Option<i64>,
    models:BTreeMap<(String,Option<String>),(Totals,BTreeMap<String,WeightedRequestSpeed>)>,
    timeline:BTreeMap<i64,TimeUsage>,
    observed:BTreeMap<i64,(i64,i64)>,
    tools:std::collections::BTreeSet<String>,
}
impl UsageAnalyticsBuilder {
    pub(super) fn add(&mut self,usage:&UsageRecord,totals:&Totals,start:i64,bucket:i64){
        store::merge_totals(&mut self.totals,totals);
        self.tools.insert(usage.tool.clone());
        self.latest_request_ms=Some(self.latest_request_ms.map_or(usage.timestamp_ms,|previous|previous.max(usage.timestamp_ms)));
        let (model,speeds)=self.models.entry((usage.tool.clone(),usage.model.clone())).or_default();
        store::merge_totals(model,totals);
        if let Some(timing)=usage.request_timing.as_ref().filter(|timing|!timing.basis.is_empty()) {
            let speed=speeds.entry(timing.basis.clone()).or_insert_with(||WeightedRequestSpeed{basis:Some(timing.basis.clone()),..Default::default()});
            speed.total_samples+=1;
            if let Some(sample)=store::speed_sample(usage){store::add_speed(speed,&sample);}
        }
        let time=start+(usage.timestamp_ms-start).div_euclid(bucket)*bucket;
        store::merge_totals(&mut self.timeline.entry(time).or_insert_with(||TimeUsage{start_ms:time,end_ms:time+bucket,totals:Default::default()}).totals,totals);
    }
    pub(super) fn observe(&mut self,tool:&str,samples:&[(i64,i64)],start:i64,bucket:i64){
        self.tools.insert(tool.into());
        let start=(start+59_999)/60_000*60_000;
        let bucket=(bucket+59_999)/60_000*60_000;
        for(time,tokens)in samples{let begin=start+(*time-start).div_euclid(bucket)*bucket;let value=self.observed.entry(begin).or_insert((begin+bucket,0));value.1+=tokens;}
    }
    pub(super) fn finish(mut self,coverage:&BTreeMap<String,Vec<(i64,i64)>>,end:i64)->UsageAnalytics{
        store::finish_totals(&mut self.totals);
        let tool=if self.tools.len()==1{self.tools.first().map(String::as_str)}else{None};
        let observed_timeline=self.observed.into_iter().map(|(start,(finish,tokens))|super::live::history_bucket(coverage,tool,start,finish.min(end/60_000*60_000),tokens)).collect();
        UsageAnalytics{
            totals:self.totals,
            latest_request_ms:self.latest_request_ms,
            observed_timeline,
            models:self.models.into_iter().map(|((tool,model),(mut totals,speeds))|{store::finish_totals(&mut totals);ModelUsage{tool,model,totals,speeds:speeds.into_values().collect()}}).collect(),
            timeline:self.timeline.into_values().map(|mut time|{store::finish_totals(&mut time.totals);time}).collect(),
        }
    }
}

pub(super) fn observed_samples(conn:&Connection,start:i64,end:i64)->Result<BTreeMap<(String,String),Vec<(i64,i64)>>,String>{
    observed_samples_scoped(conn,start,end,None,&MonitorPeriod::default())
}

pub(super) fn observed_samples_scoped(conn:&Connection,start:i64,end:i64,tool:Option<&str>,period:&MonitorPeriod)->Result<BTreeMap<(String,String),Vec<(i64,i64)>>,String>{
    // Hot and archived data share complete minute boundaries; partial minutes remain in live rates.
    let start=(start+59_999)/60_000*60_000;
    let end=end/60_000*60_000;
    let mut query=conn.prepare("WITH samples AS (SELECT tool,id,bucket_ms,output_tokens FROM monitor_output_history WHERE bucket_ms>=?1 AND bucket_ms<?2
      UNION ALL SELECT o.tool,o.id,o.observed_ms/60000*60000,SUM(o.output_tokens) FROM monitor_observations o
      JOIN monitor_requests r ON r.tool=o.tool AND r.id=o.id
      WHERE o.observed_ms>=?1 AND o.observed_ms<?2 AND COALESCE(json_extract(r.usage,'$.usageBasis'),'')!='legacy_initial_cumulative'
      GROUP BY o.tool,o.id,o.observed_ms/60000)
      SELECT s.tool,s.id,s.bucket_ms,s.output_tokens FROM samples s JOIN monitor_requests r ON r.tool=s.tool AND r.id=s.id
      WHERE (?3 IS NULL OR r.tool=?3) AND (?4 IS NULL OR json_extract(r.usage,'$.model')=?4)
      AND (?5 IS NULL OR COALESCE(json_extract(r.usage,'$.billingScope'),'unknown')=?5)").map_err(|e|e.to_string())?;
    let rows=query.query_map(params![start,end,tool,period.model,period.billing_scope],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,i64>(2)?,r.get::<_,i64>(3)?))).map_err(|e|e.to_string())?;
    let mut result=BTreeMap::<(String,String),Vec<(i64,i64)>>::new();
    for row in rows{let(tool,id,time,tokens)=row.map_err(|e|e.to_string())?;result.entry((tool,id)).or_default().push((time,tokens));}Ok(result)
}

#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct ApiCostRule {
    pub model:Option<String>,
    pub start_ms:i64,
    pub currency:String,
    pub multiplier:Option<f64>,
    pub input:Option<f64>,
    pub output:Option<f64>,
    pub cache_read:Option<f64>,
    pub cache_write:Option<f64>,
    pub cache_write5m:Option<f64>,
    pub cache_write1h:Option<f64>,
}

#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct AccountState { pub status:String,pub updated_at_ms:i64 }

#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Settings {
    pub cny_per_usd:f64,
    pub api_rules:Vec<ApiCostRule>,
    pub accounts:BTreeMap<String,AccountState>,
}
impl Default for Settings {
    fn default()->Self{Self{cny_per_usd:6.69,api_rules:Vec::new(),accounts:BTreeMap::new()}}
}

pub(super) fn read_settings(conn:&Connection)->Result<Settings,String>{
    let data:Option<String>=conn.query_row("SELECT data FROM local_cost_settings WHERE id=1",[],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    data.map(|s|serde_json::from_str(&s).map_err(|e|e.to_string())).unwrap_or_else(||Ok(Settings::default()))
}
fn validate(settings:&Settings)->Result<(),String>{
    let price=|p:Option<f64>|p.is_none_or(|n|n.is_finite()&&(0. ..=1e9).contains(&n));
    if !settings.cny_per_usd.is_finite() || settings.cny_per_usd<=0. || settings.cny_per_usd>1e6 || settings.api_rules.len()>1000 || settings.accounts.len()>10000 {return Err("Invalid local cost settings".into());}
    let mut unique=std::collections::BTreeSet::new();
    for rule in &settings.api_rules {
        if rule.start_ms<0 || rule.start_ms>8_640_000_000_000_000 || !matches!(rule.currency.as_str(),"USD"|"CNY") || rule.model.as_ref().is_some_and(|m|m.trim().is_empty()||m.len()>512)
            || ![rule.multiplier,rule.input,rule.output,rule.cache_read,rule.cache_write,rule.cache_write5m,rule.cache_write1h].into_iter().all(price)
            || (rule.multiplier.is_none()&&(rule.input.is_none()||rule.output.is_none()))
            || !unique.insert((rule.model.clone(),rule.start_ms)) {return Err("Invalid or duplicate API cost rule".into());}
    }
    for(id,state)in &settings.accounts {
        if id.is_empty()||id.len()>512||id=="unassigned"||!matches!(state.status.as_str(),"active"|"inactive"|"banned")||state.updated_at_ms<0{return Err("Invalid local account state".into());}
    }
    Ok(())
}

#[derive(Default,Serialize)]
#[serde(rename_all="camelCase")]
pub struct ApiExpense {
    pub by_currency:BTreeMap<String,f64>,
    pub priced_requests:i64,
    pub missing_requests:i64,
    pub by_model:Vec<ApiModelExpense>,
    pub by_account:BTreeMap<String,ApiAccountExpense>,
}

#[derive(Default,Serialize)]
#[serde(rename_all="camelCase")]
pub struct ApiAccountExpense {
    pub by_currency:BTreeMap<String,f64>,pub priced_requests:i64,pub missing_requests:i64,pub by_model:Vec<ApiModelExpense>,
    pub by_source:BTreeMap<String,Vec<ApiModelExpense>>,
}

#[derive(Default,Serialize)]
#[serde(rename_all="camelCase")]
pub struct ApiModelExpense {
    tool:String,model:Option<String>,by_currency:BTreeMap<String,f64>,priced_requests:i64,missing_requests:i64,
}

fn rule_amount(rule:&ApiCostRule,usage:&UsageRecord,cost:&str)->Result<Option<f64>,String>{
    if let Some(multiplier)=rule.multiplier {
        let totals=weekly::saved_request_totals(usage,cost)?;
        return Ok(totals.automatic_price_summary.by_currency.get(&rule.currency)
            .filter(|s|s.requested_requests+s.response_requests>0)
            .map(|s|(s.requested_subtotal+s.response_subtotal)*multiplier));
    }
    if usage.unknown_fields.iter().any(|f|matches!(f.as_str(),"input_tokens"|"output_tokens"|"cache_read_tokens"|"cache_write_tokens")) {return Ok(None);}
    let input=usage.input_tokens-usage.cache_read_tokens-usage.cache_write_tokens;
    if input<0{return Ok(None);}
    let component=|count:i64,rate:Option<f64>|if count==0{Some(0.)}else{rate.map(|rate|count as f64*rate)};
    let write=if usage.cache_write_tokens==0 {Some(0.)}else if let Some(rate)=rule.cache_write {Some(usage.cache_write_tokens as f64*rate)}else{
        usage.cache_write_5m_tokens.zip(usage.cache_write_1h_tokens)
            .filter(|(a,b)|a+b==usage.cache_write_tokens)
            .and_then(|(a,b)|component(a,rule.cache_write5m).zip(component(b,rule.cache_write1h))).map(|(a,b)|a+b)
    };
    Ok(component(input,rule.input).zip(component(usage.output_tokens,rule.output))
        .zip(component(usage.cache_read_tokens,rule.cache_read)).zip(write)
        .map(|(((a,b),c),d)|(a+b+c+d)/1e6))
}

fn api_expense(conn:&Connection,start:i64,end:i64,settings:&Settings)->Result<ApiExpense,String>{
    api_expense_scoped(conn,start,end,settings,None,&MonitorPeriod::default())
}

pub(super) fn api_expense_scoped(conn:&Connection,start:i64,end:i64,settings:&Settings,tool:Option<&str>,period:&MonitorPeriod)->Result<ApiExpense,String>{
    let mut result=ApiExpense::default();
    if period.billing_scope.as_deref().is_some_and(|scope|scope!="api") {return Ok(result);}
    let mut models=BTreeMap::<(String,Option<String>),ApiModelExpense>::new();
    let mut account_models=BTreeMap::<(String,String,Option<String>),ApiModelExpense>::new();
    let mut source_models=BTreeMap::<(String,String,String,Option<String>),ApiModelExpense>::new();
    let owners=super::upstream_accounts::owners(conn,None)?;
    let mut stmt=conn.prepare("SELECT usage,cost FROM monitor_requests WHERE json_extract(usage,'$.billingScope')='api' AND timestamp_ms>=?1 AND timestamp_ms<?2
      AND (?3 IS NULL OR tool=?3) AND (?4 IS NULL OR json_extract(usage,'$.model')=?4)").map_err(|e|e.to_string())?;
    let rows=stmt.query_map(params![start,end,tool,period.model],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(|e|e.to_string())?;
    for row in rows {
        let(data,cost)=row.map_err(|e|e.to_string())?;
        let usage:UsageRecord=serde_json::from_str(&data).map_err(|e|e.to_string())?;
        let owner=owners.get(&(usage.tool.clone(),usage.id.clone())).filter(|owner|!owner.conflict);
        if owner.is_some_and(|owner|owner.subscription){continue;}
        let account=owner.map_or_else(||"api:all".into(),|owner|super::quota::report_account_key(&owner.account_tool,&owner.account));
        let source=owner.map_or_else(||"api".into(),|owner|owner.sources.iter().cloned().collect::<Vec<_>>().join("+"));
        let rule=settings.api_rules.iter().filter(|r|r.start_ms<=usage.timestamp_ms && r.model.as_ref().is_none_or(|m|Some(m.as_str())==usage.model.as_deref()))
            .max_by_key(|r|(r.model.is_some(),r.start_ms));
        let amount=rule.map(|r|rule_amount(r,&usage,&cost)).transpose()?.flatten();
        let model=models.entry((usage.tool.clone(),usage.model.clone())).or_insert_with(||ApiModelExpense{tool:usage.tool.clone(),model:usage.model.clone(),..Default::default()});
        let account_total=result.by_account.entry(account.clone()).or_default();
        let account_model=account_models.entry((account.clone(),usage.tool.clone(),usage.model.clone())).or_insert_with(||ApiModelExpense{tool:usage.tool.clone(),model:usage.model.clone(),..Default::default()});
        let source_model=source_models.entry((account,source,usage.tool.clone(),usage.model.clone())).or_insert_with(||ApiModelExpense{tool:usage.tool.clone(),model:usage.model.clone(),..Default::default()});
        if let (Some(rule),Some(amount))=(rule,amount){
            *result.by_currency.entry(rule.currency.clone()).or_default()+=amount;result.priced_requests+=1;
            *model.by_currency.entry(rule.currency.clone()).or_default()+=amount;model.priced_requests+=1;
            *account_total.by_currency.entry(rule.currency.clone()).or_default()+=amount;account_total.priced_requests+=1;
            *account_model.by_currency.entry(rule.currency.clone()).or_default()+=amount;account_model.priced_requests+=1;
            *source_model.by_currency.entry(rule.currency.clone()).or_default()+=amount;source_model.priced_requests+=1;
        }else{result.missing_requests+=1;model.missing_requests+=1;account_total.missing_requests+=1;account_model.missing_requests+=1;source_model.missing_requests+=1;}
    }
    result.by_model=models.into_values().collect();
    for((account,_,_),model)in account_models{result.by_account.entry(account).or_default().by_model.push(model);}
    for((account,source,_,_),model)in source_models{result.by_account.entry(account).or_default().by_source.entry(source).or_default().push(model);}
    Ok(result)
}

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct Report {
    settings:Settings,
    accounts:Vec<accounts::LocalCostUsage>,
    api_expense:ApiExpense,
    purchases:BTreeMap<String,Purchase>,
    start_ms:i64,
    end_ms:i64,
    analytics:UsageAnalytics,
    current_account_key:Option<String>,
    account_names:BTreeMap<String,String>,
}

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
struct Purchase {amount:f64,currency:String,coverage_start_ms:Option<i64>,coverage_end_ms:Option<i64>}
fn read(conn:&Connection,start:i64,end:i64,month_start:Option<i64>)->Result<Report,String>{
    if start<0 || end<=start || end>8_640_000_000_000_000 {return Err("Invalid local cost period".into());}
    if month_start.is_some_and(|month|month<0||month>=end){return Err("Invalid calendar month period".into());}
    let tx=conn.unchecked_transaction().map_err(|e|e.to_string())?;
    let settings=read_settings(&tx)?;
    let (accounts,analytics,current_account_key)=accounts::local_cost_usage_with_month(&tx,start,end,month_start)?;
    let api_expense=api_expense(&tx,start,end,&settings)?;
    let mut purchases=BTreeMap::new();
    let mut query=tx.prepare("SELECT account_id,amount,currency,coverage_start_ms,coverage_end_ms FROM finance_events WHERE source='local' AND instance_id='usage-monitor' AND kind IN ('purchase','renewal') AND voided_at_ms IS NULL AND occurred_at_ms<?1 ORDER BY occurred_at_ms DESC,id DESC").map_err(|e|e.to_string())?;
    let rows=query.query_map([end],|r|Ok((r.get::<_,String>(0)?,Purchase{amount:r.get(1)?,currency:r.get(2)?,coverage_start_ms:r.get(3)?,coverage_end_ms:r.get(4)?}))).map_err(|e|e.to_string())?;
    for row in rows{let(id,purchase)=row.map_err(|e|e.to_string())?;purchases.entry(id).or_insert(purchase);}
    Ok(Report{settings,accounts,api_expense,purchases,start_ms:start,end_ms:end,analytics,current_account_key,account_names:super::account_names::aliases(&tx)?})
}

#[tauri::command]
pub async fn local_cost_report(start_ms:i64,end_ms:i64,month_start_ms:Option<i64>)->Result<Report,String>{
    tauri::async_runtime::spawn_blocking(move||read(&super::connection()?,start_ms,end_ms,month_start_ms)).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn local_cost_save_settings(settings:Settings)->Result<(),String>{
    validate(&settings)?;
    tauri::async_runtime::spawn_blocking(move||{
        let conn=crate::ledger_db::open_default().map_err(|e|e.to_string())?;
        conn.execute("INSERT INTO local_cost_settings VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET data=excluded.data",[serde_json::to_string(&settings).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
        Ok(())
    }).await.map_err(|e|e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all="camelCase")]
pub struct LiveReport {account_key:String,source_key:Option<String>,live:super::types::LiveSnapshot}

#[cfg(test)]
fn read_live(conn:&Connection,account_key:String,now:i64,started:i64,updated:i64)->Result<LiveReport,String>{
    read_live_source(conn,account_key,None,now,started,updated)
}

fn read_live_source(conn:&Connection,account_key:String,source_key:Option<String>,now:i64,started:i64,updated:i64)->Result<LiveReport,String>{
    if account_key=="all" && source_key.is_none(){
        return Ok(LiveReport{account_key,source_key,live:super::live::read_scoped(conn,now,started,updated,None)?});
    }
    if !matches!(account_key.as_str(),"all"|"api:all"|"unassigned") && !super::quota::known_report_account(conn,&account_key)? {return Err("Unknown account scope".into());}
    let mut query=conn.prepare("SELECT r.usage FROM (SELECT DISTINCT tool,id FROM monitor_observations WHERE observed_ms>?1 AND observed_ms<=?2) o JOIN monitor_requests r ON r.tool=o.tool AND r.id=o.id").map_err(|e|e.to_string())?;
    let data=query.query_map(params![now-3_600_000,now],|r|r.get::<_,String>(0)).map_err(|e|e.to_string())?;
    let requests=data.map(|row|serde_json::from_str::<UsageRecord>(&row.map_err(|e|e.to_string())?).map_err(|e|e.to_string())).collect::<Result<Vec<_>,String>>()?;
    let keys=accounts::request_assignments(conn,&requests)?.into_iter().filter(|(_,_,key,source)| (account_key=="all"||key==&account_key)&&source_key.as_ref().is_none_or(|selected|selected==source)).map(|(tool,id,_,_)|(tool,id)).collect::<Vec<_>>();
    let clients=keys.iter().map(|(tool,_)|tool.as_str()).collect::<std::collections::BTreeSet<_>>();
    let tool=if clients.len()==1{clients.first().copied()}else{None};
    let encoded=serde_json::to_string(&keys).map_err(|e|e.to_string())?;
    let snapshot=super::live::read_requests(conn,now,started,updated,&encoded,tool)?;
    Ok(LiveReport{account_key,source_key,live:snapshot})
}

#[tauri::command]
pub async fn local_cost_live(account_key:String,source_key:Option<String>,runtime:tauri::State<'_,super::MonitorRuntime>)->Result<LiveReport,String>{
    if account_key.len()>512 || source_key.as_ref().is_some_and(|key|key.is_empty()||key.len()>128){return Err("Invalid account scope".into());}
    let status=runtime.status_snapshot()?;
    tauri::async_runtime::spawn_blocking(move||read_live_source(&super::connection()?,account_key,source_key,crate::ledger_db::now_ms(),status.started_at_ms,status.collected_at_ms)).await.map_err(|e|e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rule()->ApiCostRule{ApiCostRule{model:None,start_ms:0,currency:"USD".into(),multiplier:None,input:Some(2.),output:Some(10.),cache_read:Some(0.2),cache_write:None,cache_write5m:Some(2.5),cache_write1h:Some(4.)}}
    #[test]
    fn local_rates_count_disjoint_cache_buckets_and_do_not_treat_missing_prices_as_free(){
        let u=UsageRecord{input_tokens:1000000,output_tokens:100000,cache_read_tokens:500000,cache_write_tokens:200000,cache_write_5m_tokens:Some(100000),cache_write_1h_tokens:Some(100000),..Default::default()};
        assert!((rule_amount(&rule(),&u,"{}").unwrap().unwrap()-2.35).abs()<1e-10);
        let mut r=rule();r.cache_write1h=None;
        assert_eq!(rule_amount(&r,&u,"{}").unwrap(),None);
        r.cache_write=Some(0.);assert_eq!(rule_amount(&r,&u,"{}").unwrap(),Some(1.7));
    }
    #[test]
    fn invalid_rules_do_not_pass_the_storage_boundary(){
        let mut s=Settings::default();s.api_rules=vec![rule(),rule()];assert!(validate(&s).is_err());
        s.api_rules.pop();assert!(validate(&s).is_ok());s.api_rules[0].input=Some(-1.);assert!(validate(&s).is_err());
    }
    #[test]
    fn rate_history_uses_the_same_complete_minutes_before_and_after_archival(){
        let conn=Connection::open_in_memory().unwrap();super::super::store::initialize(&conn).unwrap();
        let usage=UsageRecord{id:"edge".into(),tool:"codex".into(),timestamp_ms:110_000,output_tokens:120,..Default::default()};
        conn.execute("INSERT INTO monitor_requests VALUES('codex','edge','codex:thread',110000,?1,'{}')",[serde_json::to_string(&usage).unwrap()]).unwrap();
        conn.execute("INSERT INTO monitor_observations VALUES('codex','edge','codex:thread',119999,120)",[]).unwrap();
        let key=("codex".into(),"edge".into());
        let before=observed_samples(&conn,60_000,180_000).unwrap();
        assert_eq!(before[&key],vec![(60_000,120)]);
        assert!(observed_samples(&conn,90_000,180_000).unwrap().is_empty());
        super::super::live::prune(&conn,super::super::live::RETENTION_MS+180_000).unwrap();
        assert_eq!(observed_samples(&conn,60_000,180_000).unwrap(),before);
        assert!(observed_samples(&conn,90_000,180_000).unwrap().is_empty());
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_requests",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        let (_,all,_)=accounts::local_cost_usage(&conn,0,180_123).unwrap();
        assert_eq!((all.observed_timeline[0].start_ms,all.observed_timeline[0].observed_output_tokens),(60_000,120));
        let mut builder=UsageAnalyticsBuilder::default();builder.observe("codex",&before[&key],1,3_600_001);
        let history=builder.finish(&BTreeMap::new(),180_123).observed_timeline;
        assert_eq!((history[0].start_ms,history[0].end_ms,history[0].observed_output_tokens),(60_000,180_000,120));
    }
    #[test]
    fn live_accounts_api_and_unassigned_use_the_same_ownership_as_amounts(){
        let mut conn=Connection::open_in_memory().unwrap();crate::ledger_db::migrate(&mut conn).unwrap();super::super::store::initialize(&conn).unwrap();
        let now=1_000_000;
        for name in ["a","b"]{
            conn.execute("INSERT INTO monitor_account_profiles VALUES('codex',?1,?2,0)",params![format!("account:{name}"),name]).unwrap();
            let state=serde_json::json!({"session":{"id":name},"quota_account_id":name});
            conn.execute("INSERT INTO monitor_files VALUES(?1,'codex',0,'fixture',?2)",params![name,state.to_string()]).unwrap();
        }
        for(id,session,scope,tokens)in [("a","a","subscription",600),("b","b","subscription",300),("api","a","api",120),("unknown","missing","subscription",60)]{
            let record=UsageRecord{id:id.into(),session_id:session.into(),tool:"codex".into(),model:Some(id.into()),timestamp_ms:now-100,output_tokens:tokens,billing_scope:Some(scope.into()),..Default::default()};
            let tx=conn.transaction().unwrap();super::super::store::save_usage_with_catalog(&tx,&record,0,now-100,&crate::model_catalog::CatalogSnapshot::default()).unwrap();tx.commit().unwrap();
            conn.execute("UPDATE monitor_requests SET usage=json_set(usage,'$.billingScope',?2) WHERE id=?1",params![id,scope]).unwrap();
        }
        for tool in ["*","codex"]{conn.execute("INSERT INTO monitor_live_coverage VALUES('fixture',?1,?2,?3,1)",params![tool,now-300_000,now]).unwrap();}
        let identities=super::super::quota::account_report_identities(&conn,"codex").unwrap();
        for(key,tokens)in [(identities["account:a"].0.as_str(),600),(identities["account:b"].0.as_str(),300),("api:all",120),("unassigned",60),("all",1080)]{
            let snapshot=read_live(&conn,key.into(),now,0,now).unwrap();assert_eq!(snapshot.live.windows[0].observed_output_tokens,tokens,"{key}");
            assert_eq!(snapshot.live.by_model.len(),if key=="all"{4}else{1});
        }
        assert!(read_live(&conn,"codex:nonexistent".into(),now,0,now).is_err());
    }
    #[test]
    fn account_rate_history_keeps_output_when_request_time_is_outside_the_period(){
        let mut conn=Connection::open_in_memory().unwrap();
        crate::ledger_db::migrate(&mut conn).unwrap();super::super::store::initialize(&conn).unwrap();
        conn.execute("INSERT INTO monitor_account_profiles VALUES('codex','account:retained','Retained account',0)",[]).unwrap();
        conn.execute("INSERT INTO monitor_files VALUES('removed-log','codex',0,'fixture',?1)",
            [serde_json::json!({"session":{"id":"known"},"quota_account_id":"retained"}).to_string()]).unwrap();
        for(id,session,time,output)in [("before","known",60_000,10),("after","known",300_000,20),("unassigned","missing",60_000,30)]{
            let usage=UsageRecord{id:id.into(),tool:"codex".into(),session_id:session.into(),timestamp_ms:time,output_tokens:output,billing_scope:Some("subscription".into()),..Default::default()};
            conn.execute("INSERT INTO monitor_requests VALUES('codex',?1,?2,?3,?4,'{}')",params![id,format!("codex:{session}"),time,serde_json::to_string(&usage).unwrap()]).unwrap();
            conn.execute("INSERT INTO monitor_observations VALUES('codex',?1,?2,180001,?3)",params![id,format!("codex:{session}"),output]).unwrap();
        }
        conn.execute("INSERT INTO monitor_coverage_history VALUES('fixture','codex',120000,240000)",[]).unwrap();
        conn.execute("INSERT INTO monitor_coverage_history VALUES('fixture','*',120000,240000)",[]).unwrap();
        let result=read(&conn,120_000,240_000,None).unwrap();
        let analysis=super::super::analysis::read(&conn,None,&MonitorPeriod{start_ms:Some(120_000),end_ms:Some(240_000),..Default::default()},"",None,false,0,100,240_000).unwrap();
        let observed=|analytics:&UsageAnalytics|analytics.observed_timeline.iter().map(|bucket|bucket.observed_output_tokens).sum::<i64>();
        assert_eq!(result.analytics.totals.request_count,0);
        assert_eq!(observed(&result.analytics),60);
        assert_eq!(analysis.observed_timeline.iter().map(|bucket|bucket.observed_output_tokens).sum::<i64>(),60);
        let account=result.accounts.iter().find(|a|a.label=="Retained account").unwrap();
        assert_eq!((account.totals.request_count,observed(&account.analytics)),(0,30));
        assert_eq!(observed(&account.sources["direct"]),30);
        assert_eq!(observed(&result.accounts.iter().find(|a|a.id=="unassigned").unwrap().analytics),30);
        assert_eq!(result.accounts.iter().map(|a|observed(&a.analytics)).sum::<i64>(),60);
        assert_eq!(account.analytics.observed_timeline[0].output_tokens,Some(30));
    }
    #[test]
    fn removed_source_accounts_keep_costs_identity_models_and_quota_cycles(){
        use super::super::upstream_accounts::{self,AccountIdentity,Receipt,SourceBatch};
        let mut conn=Connection::open_in_memory().unwrap();
        crate::ledger_db::migrate(&mut conn).unwrap();super::super::store::initialize(&conn).unwrap();
        let now=2_000_000;
        let usage=UsageRecord{id:"response:retained".into(),request_id:Some("retained".into()),tool:"codex".into(),session_id:"thread".into(),
            model:Some("model".into()),timestamp_ms:1_500_000,input_tokens:100,output_tokens:20,cache_read_tokens:40,
            billing_scope:Some("api".into()),requested_mode:Some("standard".into()),..Default::default()};
        let saved_quote=r#"{"usd":5,"reason":"same_amount_for_all_published_tariffs"}"#;
        conn.execute("INSERT INTO monitor_requests VALUES('codex',?1,'codex:thread',?2,?3,?4)",params![usage.id,usage.timestamp_ms,serde_json::to_string(&usage).unwrap(),saved_quote]).unwrap();
        let batch=SourceBatch{source:"sub2api".into(),instance:"https://fixture.test/api/v1".into(),observed_ms:now,history:None,
            accounts:vec![AccountIdentity{id:"old-local-id".into(),tool:"codex".into(),account_id:"retained".into(),organization_id:None,
                label:"retained@example.test".into(),subscription:true,quota_eligible:true,subscription_end_ms:Some(now+86_400_000),quota_dimension:Some("global".into()),created_at_ms:None,resets:Vec::new(),
                quotas:vec![super::super::quota::UpstreamQuota{slot:"secondary".into(),window_minutes:10080,used_percent:50.,observed_at_ms:now,resets_at_ms:604_800_000+1_000_000}]}],
            receipts:vec![Receipt{event_id:"event".into(),account:"old-local-id".into(),request_id:"retained".into(),session_id:Some("thread".into()),model:"model".into(),
                timestamp_ms:usage.timestamp_ms,input_tokens:100,output_tokens:20,cache_read_tokens:40,cache_write_tokens:0,official_account_id:Some("retained".into()),details:None}]};
        upstream_accounts::save(&mut conn,batch).unwrap();
        let account_key=super::super::quota::report_account_key("codex","account:retained");
        let event:crate::finance_ledger::FinanceEventInput=serde_json::from_value(serde_json::json!({
            "id":"11111111-1111-4111-8111-111111111111","source":"local","instanceId":"usage-monitor","accountId":account_key,
            "kind":"purchase","amount":70,"currency":"CNY","occurredAtMs":1_000_000,"coverageStartMs":1_000_000,"coverageEndMs":3_000_000,
            "purchaseChannel":"Retained channel"})).unwrap();
        crate::finance_ledger::save(&mut conn,event).unwrap();
        let before=read(&conn,0,now,None).unwrap();
        let snapshot=&before.accounts.iter().find(|account|account.id==account_key).unwrap();
        assert_eq!((snapshot.label.as_str(),snapshot.totals.request_count,snapshot.analytics.models.len()),("retained@example.test",1,1));
        assert!(!serde_json::to_value(snapshot).unwrap()["periods"]["quotaCycles"].as_array().unwrap().is_empty());
        upstream_accounts::save(&mut conn,SourceBatch{source:"sub2api".into(),instance:"https://fixture.test/api/v1".into(),observed_ms:now+1,accounts:Vec::new(),receipts:Vec::new(),history:None}).unwrap();
        // Even loss of the disposable source catalog must not erase the stored receipt/profile.
        conn.execute("DELETE FROM monitor_upstream_accounts",[]).unwrap();
        let after=read(&conn,0,now,None).unwrap();
        let retained=after.accounts.iter().find(|account|account.id==account_key).unwrap();
        assert_eq!(serde_json::to_value(snapshot).unwrap(),serde_json::to_value(retained).unwrap());
        assert_eq!(after.purchases[&account_key].amount,70.);
        assert_eq!(after.api_expense.priced_requests+after.api_expense.missing_requests,0);
        let finances=crate::finance_ledger::query(&conn,serde_json::from_value(serde_json::json!({"source":"local","instanceId":"usage-monitor","startMs":0,"endMs":now})).unwrap()).unwrap();
        assert_eq!((finances.total_events,finances.by_account[0].account_id.as_str(),finances.by_account[0].totals.cash_outlay),(1,account_key.as_str(),70.));
        assert_eq!(conn.query_row("SELECT cost FROM monitor_requests WHERE id=?1",[usage.id],|row|row.get::<_,String>(0)).unwrap(),saved_quote);
    }
    #[test]
    fn analytics_preserve_token_quotes_and_keep_timing_bases_separate(){
        let mut grouped=UsageAnalyticsBuilder::default();
        for(id,tool,basis,duration)in [("one","codex","request",1000),("two","codex","turn",2000),("three","claude","request",1000)] {
            let usage=UsageRecord{id:id.into(),tool:tool.into(),model:Some("shared-model".into()),input_tokens:100,output_tokens:20,timestamp_ms:1000,requested_mode:Some("standard".into()),request_timing:Some(super::super::types::RequestTiming{basis:basis.into(),duration_ms:Some(duration),..Default::default()}),..Default::default()};
            let totals=weekly::saved_request_totals(&usage,r#"{"usd":1,"evidence":{"currency":"USD","mode":"standard"}}"#).unwrap();
            grouped.add(&usage,&totals,0,3600000);
        }
        let result=grouped.finish(&BTreeMap::new(),i64::MAX);
        assert_eq!((result.totals.request_count,result.totals.total_tokens),(3,360));
        assert_eq!(result.models.len(),2);
        let codex=result.models.iter().find(|row|row.tool=="codex").unwrap();
        assert_eq!(codex.speeds.len(),2);
        assert_eq!(codex.totals.automatic_price_summary.by_currency["USD"].requested_subtotal,2.);
        assert_eq!(result.timeline[0].totals.request_count,3);
        assert_eq!(codex.speeds.iter().map(|speed|speed.output_tokens_per_second.unwrap()).collect::<Vec<_>>(),vec![20.,10.]);
    }
    #[test]
    fn effective_model_rules_are_separate_from_saved_quotes_and_unknown_billing_types(){
        let mut conn=Connection::open_in_memory().unwrap();
        crate::ledger_db::migrate(&mut conn).unwrap();
        super::super::store::initialize(&conn).unwrap();
        for(id,time,scope)in [("before",1000,Some("api")),("after",3000,Some("api")),("unknown",3000,None)]{
            let usage=UsageRecord{id:id.into(),tool:"codex".into(),session_id:"thread".into(),timestamp_ms:time,model:Some("model".into()),billing_scope:scope.map(str::to_owned),requested_mode:Some("standard".into()),..Default::default()};
            conn.execute("INSERT INTO monitor_requests VALUES('codex',?1,'codex:thread',?2,?3,?4)",params![id,time,serde_json::to_string(&usage).unwrap(),r#"{"usd":10,"evidence":{"currency":"USD","mode":"standard"}}"#]).unwrap();
        }
        let mut base=rule();base.multiplier=Some(0.2);
        let mut model=base.clone();model.model=Some("model".into());model.start_ms=2000;model.multiplier=Some(0.3);
        let settings=Settings{api_rules:vec![base,model],..Default::default()};
        let result=api_expense(&conn,0,4000,&settings).unwrap();
        assert_eq!((result.priced_requests,result.missing_requests),(2,0));
        assert_eq!(result.by_currency["USD"],5.);
        assert_eq!(result.by_model.len(),1);
        assert_eq!(result.by_model[0].by_currency["USD"],5.);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_requests WHERE json_extract(cost,'$.usd')=10",[],|r|r.get::<_,i64>(0)).unwrap(),3);
        assert_eq!(api_expense(&conn,0,4000,&Settings::default()).unwrap().missing_requests,2);
        conn.execute("UPDATE monitor_requests SET usage=json_remove(usage,'$.requestedMode') WHERE id='after'",[]).unwrap();
        let partial=api_expense(&conn,0,4000,&settings).unwrap();
        assert_eq!((partial.priced_requests,partial.missing_requests),(1,1));
        assert_eq!(partial.by_currency["USD"],2.);
    }

    #[test]
    #[ignore = "Requires an explicit isolated ledger copy for migration and real-account verification"]
    fn copied_local_cost_migration_and_report(){
        let path=std::path::PathBuf::from(std::env::var_os("LOCAL_COST_LEDGER_COPY").unwrap()).canonicalize().unwrap();
        assert_eq!(path.file_name().unwrap(),"ledger-audit-work.sqlite");
        assert_ne!(path,crate::ledger_db::ledger_db_path().unwrap().canonicalize().unwrap());
        let mut conn=Connection::open_with_flags(&path,rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE).unwrap();
        crate::ledger_db::migrate(&mut conn).unwrap();
        super::super::store::initialize(&conn).unwrap();
        let end=crate::ledger_db::now_ms();
        super::super::account_names::collect(&conn,end).unwrap();
        let start=end-30*86_400_000;
        let clock=std::time::Instant::now();
        let report=read(&conn,start,end,None).unwrap();
        let elapsed=clock.elapsed().as_millis();
        let (requests,tokens):(i64,i64)=conn.query_row("SELECT COUNT(*),COALESCE(SUM(json_extract(usage,'$.inputTokens')+json_extract(usage,'$.outputTokens')),0) FROM monitor_requests WHERE timestamp_ms>=?1 AND timestamp_ms<?2",params![start,end],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        assert_eq!(report.accounts.iter().map(|a|a.totals.request_count).sum::<i64>(),requests);
        assert_eq!(report.accounts.iter().map(|a|a.totals.total_tokens).sum::<i64>(),tokens);
        assert_eq!(report.analytics.totals.request_count,requests);
        for account in &report.accounts {
            assert_eq!(account.analytics.totals.request_count,account.totals.request_count);
            assert_eq!(account.analytics.models.iter().map(|model|model.totals.request_count).sum::<i64>(),account.totals.request_count);
            assert_eq!(account.analytics.timeline.iter().map(|bucket|bucket.totals.total_tokens).sum::<i64>(),account.totals.total_tokens);
        }
        assert_eq!(report.accounts.iter().map(|a|&a.id).collect::<std::collections::BTreeSet<_>>().len(),report.accounts.len());
        let api=report.accounts.iter().find(|a|a.id=="api:all").unwrap();
        assert_eq!(api.totals.request_count,report.api_expense.priced_requests+report.api_expense.missing_requests);
        assert_eq!(conn.query_row("PRAGMA quick_check",[],|r|r.get::<_,String>(0)).unwrap(),"ok");
        std::fs::write(path.with_file_name("local-cost-report.json"),serde_json::to_vec(&report).unwrap()).unwrap();
        std::fs::write(path.with_file_name("local-cost-quotas.json"),serde_json::to_vec(&super::super::quota::read(&conn,end).unwrap()).unwrap()).unwrap();
        let mut lives=BTreeMap::new();
        for key in std::iter::once("all").chain(report.accounts.iter().map(|a|a.id.as_str())){
            lives.insert(key,read_live(&conn,key.into(),end,end-3_600_000,end).unwrap());
        }
        std::fs::write(path.with_file_name("local-cost-live.json"),serde_json::to_vec(&lives).unwrap()).unwrap();
        println!("{}",serde_json::json!({"schema":crate::ledger_db::SCHEMA_VERSION_LATEST,"accountRows":report.accounts.len(),"requests":requests,"tokens":tokens,"apiRequests":api.totals.request_count,"reportMs":elapsed,"partitionsConserve":true}));
    }

    #[test]
    #[ignore = "Requires explicit isolated working and original ledger copies for identity reconciliation"]
    fn copied_identity_framework_reconciliation(){
        let path=std::path::PathBuf::from(std::env::var_os("LOCAL_COST_LEDGER_COPY").unwrap()).canonicalize().unwrap();
        let original=std::path::PathBuf::from(std::env::var_os("LOCAL_COST_ORIGINAL_LEDGER").unwrap()).canonicalize().unwrap();
        assert_eq!(path.file_name().unwrap(),"ledger-audit-work.sqlite");assert_ne!(path,original);
        assert_ne!(path,crate::ledger_db::ledger_db_path().unwrap().canonicalize().unwrap());
        let start=std::env::var("LOCAL_COST_AUDIT_START_MS").unwrap().parse::<i64>().unwrap();let end=crate::ledger_db::now_ms();
        let cutoff=std::env::var("LOCAL_COST_AUDIT_CUTOFF_MS").unwrap().parse::<i64>().unwrap();
        let mut conn=Connection::open_with_flags(&path,rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE|rusqlite::OpenFlags::SQLITE_OPEN_URI).unwrap();
        crate::ledger_db::migrate(&mut conn).unwrap();super::super::store::initialize(&conn).unwrap();
        super::super::account_names::collect(&conn,end).unwrap();
        let before=read(&conn,start,end,None).unwrap();
        super::super::billing::bootstrap(&mut conn).unwrap();
        let issues=super::super::collector::replay_claude_identities(&mut conn).unwrap();
        let after=read(&conn,start,end,None).unwrap();
        let mut original_uri=tauri::Url::from_file_path(&original).unwrap();original_uri.query_pairs_mut().append_pair("mode","ro");
        conn.execute("ATTACH DATABASE ?1 AS original",[original_uri.as_str()]).unwrap();
        let counts:(i64,i64)=conn.query_row("SELECT (SELECT COUNT(*) FROM monitor_requests),(SELECT COUNT(*) FROM original.monitor_requests)",[],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();assert_eq!(counts.0,counts.1);
        let changed_usage:i64=conn.query_row("SELECT COUNT(*) FROM monitor_requests r JOIN original.monitor_requests o ON o.tool=r.tool AND o.id=r.id
          WHERE json_remove(r.usage,'$.billingScope')<>json_remove(o.usage,'$.billingScope')",[],|r|r.get(0)).unwrap();assert_eq!(changed_usage,0);
        let changed_non_codex_quotes:i64=conn.query_row("SELECT COUNT(*) FROM monitor_requests r JOIN original.monitor_requests o ON o.tool=r.tool AND o.id=r.id WHERE r.tool<>'codex' AND r.cost<>o.cost",[],|r|r.get(0)).unwrap();assert_eq!(changed_non_codex_quotes,0);
        let unexplained_quotes:i64=conn.query_row("SELECT COUNT(*) FROM monitor_requests r JOIN original.monitor_requests o ON o.tool=r.tool AND o.id=r.id
          WHERE r.cost<>o.cost AND json_extract(r.usage,'$.billingScope') IS json_extract(o.usage,'$.billingScope')",[],|r|r.get(0)).unwrap();assert_eq!(unexplained_quotes,0);
        assert_eq!(before.analytics.totals.request_count,after.analytics.totals.request_count);assert_eq!(before.analytics.totals.total_tokens,after.analytics.totals.total_tokens);
        assert_eq!(after.accounts.iter().map(|row|row.totals.request_count).sum::<i64>(),after.analytics.totals.request_count);
        for row in &after.accounts{assert_eq!(row.analytics.totals.request_count,row.totals.request_count);}
        let summary=|report:&Report|report.accounts.iter().map(|a|serde_json::json!({"id":a.id,"tool":a.tool,"requests":a.totals.request_count,"tokens":a.totals.total_tokens,"verified":a.verified_requests,"reference":a.reference_requests,"prices":a.totals.automatic_price_summary})).collect::<Vec<_>>();
        let scope_changes=conn.prepare("SELECT r.tool,COALESCE(json_extract(o.usage,'$.billingScope'),'unknown'),COALESCE(json_extract(r.usage,'$.billingScope'),'unknown'),COUNT(*) FROM monitor_requests r JOIN original.monitor_requests o ON o.tool=r.tool AND o.id=r.id
          WHERE json_extract(r.usage,'$.billingScope') IS NOT json_extract(o.usage,'$.billingScope') GROUP BY 1,2,3").unwrap().query_map([],|r|Ok(serde_json::json!({"tool":r.get::<_,String>(0)?,"before":r.get::<_,String>(1)?,"after":r.get::<_,String>(2)?,"requests":r.get::<_,i64>(3)?}))).unwrap().collect::<Result<Vec<_>,_>>().unwrap();
        let price_delta:(f64,f64)=conn.query_row("SELECT COALESCE(SUM(COALESCE(json_extract(r.cost,'$.usd'),0)-COALESCE(json_extract(o.cost,'$.usd'),0)),0),COALESCE(SUM(COALESCE(json_extract(r.cost,'$.cny'),0)-COALESCE(json_extract(o.cost,'$.cny'),0)),0)
          FROM monitor_requests r JOIN original.monitor_requests o ON o.tool=r.tool AND o.id=r.id WHERE r.timestamp_ms<?1",[cutoff],|r|Ok((r.get(0)?,r.get(1)?))).unwrap();
        let result=serde_json::json!({"before":summary(&before),"after":summary(&after),"scopeChanges":scope_changes,"sourceIssues":issues,"rows":counts.0,"onlyBillingScopeChanged":changed_usage==0,"nonCodexQuotesPreserved":changed_non_codex_quotes==0,"fixedCutoffCostDelta":{"usd":price_delta.0,"cny":price_delta.1}});
        std::fs::write(path.with_file_name("framework-audit.json"),serde_json::to_vec(&result).unwrap()).unwrap();
        std::fs::write(path.with_file_name("local-cost-report.json"),serde_json::to_vec(&after).unwrap()).unwrap();
        std::fs::write(path.with_file_name("local-cost-quotas.json"),serde_json::to_vec(&super::super::quota::read(&conn,end).unwrap()).unwrap()).unwrap();
        let lives=std::iter::once("all").chain(after.accounts.iter().map(|a|a.id.as_str())).map(|key|(key,read_live(&conn,key.into(),end,end-3_600_000,end).unwrap())).collect::<BTreeMap<_,_>>();
        std::fs::write(path.with_file_name("local-cost-live.json"),serde_json::to_vec(&lives).unwrap()).unwrap();
        assert_eq!(conn.query_row("PRAGMA quick_check",[],|r|r.get::<_,String>(0)).unwrap(),"ok");
        println!("{}",serde_json::json!({"rows":counts.0,"monthlyRequests":after.analytics.totals.request_count,"scopeChanges":scope_changes,"metadataIssues":issues.len(),"fixedCutoffCostDelta":{"usd":price_delta.0,"cny":price_delta.1},"requestDataPreserved":true}));
    }

}
