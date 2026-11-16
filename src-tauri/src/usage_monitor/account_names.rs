use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
use base64::{engine::general_purpose, Engine};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use std::{collections::{BTreeMap, BTreeSet}, io::Read, path::{Path,PathBuf}};

const ALIASES_KEY:&str="account_display_names_v1";
const LIMIT:u64=1024*1024;

pub(super) fn initialize(conn:&Connection)->Result<(),String>{
    conn.execute_batch("CREATE TABLE IF NOT EXISTS monitor_account_profiles (
      tool TEXT NOT NULL,account_key TEXT NOT NULL,label TEXT NOT NULL,saved_ms INTEGER NOT NULL,
      PRIMARY KEY(tool,account_key));
      CREATE TABLE IF NOT EXISTS monitor_account_native_keys (
      tool TEXT NOT NULL,native_key TEXT NOT NULL,account_key TEXT NOT NULL,PRIMARY KEY(tool,native_key));").map_err(|e|e.to_string())
}

#[derive(Default)]
pub(super) struct Names {pub labels:BTreeMap<String,String>,pub warnings:Vec<String>,native_keys:BTreeMap<String,String>}

#[derive(Default,Deserialize)]
struct Metadata {
    #[serde(default)] id:String,
    #[serde(default)] email:String,
    account_id:Option<String>,
    account_uuid:Option<String>,
    organization_uuid:Option<String>,
}
#[derive(Deserialize)]
struct Index {accounts:Vec<Metadata>}
#[derive(Deserialize)]
struct Envelope {version:u32,algorithm:String,nonce:String,ciphertext:String}

fn bytes(path:&Path)->Result<Option<Vec<u8>>,()> {
    let file=match std::fs::File::open(path){Ok(file)=>file,Err(e)if e.kind()==std::io::ErrorKind::NotFound=>return Ok(None),Err(_)=>return Err(())};
    let mut bytes=Vec::new();file.take(LIMIT+1).read_to_end(&mut bytes).map_err(|_|())?;
    if bytes.len()>LIMIT as usize{return Err(());} Ok(Some(bytes))
}

// Deserialize display metadata only; ignored credential fields are not allocated.
fn profile(path:&Path,cipher:Option<&Aes256Gcm>)->Result<Option<Metadata>,()> {
    let Some(mut data)=bytes(path)? else{return Ok(None)};
    let result=if let Ok(envelope)=serde_json::from_slice::<Envelope>(&data){
        if envelope.version!=1||envelope.algorithm!="AES-256-GCM"{return Err(());}
        let nonce=general_purpose::STANDARD.decode(envelope.nonce).map_err(|_|())?;
        if nonce.len()!=12{return Err(());}
        let encrypted=general_purpose::STANDARD.decode(envelope.ciphertext).map_err(|_|())?;
        let mut plaintext=cipher.ok_or(())?.decrypt(Nonce::from_slice(&nonce),encrypted.as_ref()).map_err(|_|())?;
        let metadata=serde_json::from_slice(&plaintext).map_err(|_|());plaintext.fill(0);metadata
    }else{serde_json::from_slice(&data).map_err(|_|())};
    data.fill(0);result.map(Some)
}

fn cipher(root:&Path)->Result<Option<Aes256Gcm>,()> {
    let Some(mut encoded)=bytes(&root.join("secure-account-storage.key"))? else{return Ok(None)};
    let raw=std::str::from_utf8(&encoded).map_err(|_|())?;
    let mut key=general_purpose::STANDARD.decode(raw.trim()).map_err(|_|())?;
    let cipher=Aes256Gcm::new_from_slice(&key).map_err(|_|());key.fill(0);encoded.fill(0);cipher.map(Some)
}

pub(super) fn aliases(conn:&Connection)->Result<BTreeMap<String,String>,String>{
    let value:Option<String>=conn.query_row("SELECT data FROM monitor_state WHERE key=?1",[ALIASES_KEY],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    value.map(|s|serde_json::from_str(&s).map_err(|_|"Account names could not be read".into())).unwrap_or_else(||Ok(BTreeMap::new()))
}

fn put(names:&mut BTreeMap<String,BTreeSet<String>>,wanted:&BTreeSet<String>,key:String,email:&str){
    if wanted.contains(&key)&&!email.trim().is_empty(){names.entry(key).or_default().insert(email.trim().to_owned());}
}

fn external(root:&Path,tool:&str,wanted:&BTreeSet<String>)->Names{
    let mut candidates=BTreeMap::<String,BTreeSet<String>>::new();let mut failures=0;
    let mut native_keys=BTreeMap::new();
    let index_file=match tool{"codex"=>"codex_accounts.json","claude"=>"claude_accounts.json","antigravity"=>"accounts.json",_=>return Names::default()};
    let index=bytes(&root.join(index_file)).and_then(|v|v.map(|bytes|serde_json::from_slice::<Index>(&bytes).map_err(|_|())).transpose());
    match index {
        Ok(Some(index))=>{
            let cipher=if tool=="codex"{match cipher(root){Ok(cipher)=>cipher,Err(())=>{failures+=1;None}}}else{None};
            for row in index.accounts {
                if row.id.is_empty()||row.id.len()>128||!row.id.bytes().all(|c|c.is_ascii_alphanumeric()||c==b'-'||c==b'_'){failures+=1;continue;}
                if tool=="codex"{
                    match profile(&root.join("codex_accounts").join(format!("{}.json",row.id)),cipher.as_ref()){
                        Ok(Some(metadata))=>{if metadata.id!=row.id{failures+=1;continue;}if let Some(id)=metadata.account_id{put(&mut candidates,wanted,format!("account:{id}"),if metadata.email.is_empty(){&row.email}else{&metadata.email});}},
                        Ok(None)=>{},Err(())=>failures+=1,
                    }
                }else{
                    let key=format!("cockpit:{}",row.id);
                    put(&mut candidates,wanted,key.clone(),&row.email);
                    if tool=="claude"{if let Some(uuid)=row.account_uuid.filter(|id|!id.is_empty()&&id.len()<=512){
                        let native=super::request_identity::claude_account_key(&uuid,row.organization_uuid.as_deref());
                        if wanted.contains(&native)&&!row.email.trim().is_empty(){candidates.entry(key.clone()).or_default().insert(row.email.trim().to_owned());}
                        native_keys.insert(key,native);
                    }}
                }
            }
        },Ok(None)=>{},Err(())=>failures+=1,
    }
    if tool=="antigravity"{
        for key in wanted.iter().filter_map(|key|key.strip_prefix("cockpit:")){
            if key.len()!=64||!key.bytes().all(|c|c.is_ascii_hexdigit()){continue;}
            let path=root.join("cache/quota_api_v1_desktop/authorized").join(format!("{key}.json"));
            match profile(&path,None){Ok(Some(row))=>put(&mut candidates,wanted,format!("cockpit:{key}"),&row.email),Ok(None)=>{},Err(())=>failures+=1}
        }
    }
    if tool=="codex"&&root.join(crate::cockpit_logs_db::REQUEST_LOG_DB_NAME).exists(){
        let result=(||->Result<(),rusqlite::Error>{
            let db=Connection::open_with_flags(root.join(crate::cockpit_logs_db::REQUEST_LOG_DB_NAME),OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            let mut query=db.prepare("SELECT email FROM request_logs WHERE official_account_id=?1 AND email<>'' ORDER BY timestamp DESC,id DESC LIMIT 1")?;
            let missing=wanted.iter().filter(|key|!candidates.contains_key(*key)).cloned().collect::<Vec<_>>();
            for key in &missing{
                if let Some(id)=key.strip_prefix("account:"){
                    let email:Option<String>=query.query_row([id],|r|r.get(0)).optional()?;
                    if let Some(email)=email{put(&mut candidates,wanted,key.clone(),&email);}
                }
            }
            Ok(())
        })();if result.is_err(){failures+=1;}
    }
    let mut result=Names{native_keys,..Default::default()};
    for(key,mut values)in candidates {if values.len()==1{result.labels.insert(key,values.pop_first().unwrap());}else{failures+=1;}}
    if failures>0{result.warnings.push(format!("{failures} saved {tool} account name records could not be read unambiguously"));}
    result
}

fn auth_names(tool:&str,wanted:&BTreeSet<String>,result:&mut Names){
    if tool=="claude"{
        #[derive(Deserialize)]struct Config{#[serde(rename="oauthAccount")]account:Option<Account>}
        #[derive(Deserialize)]struct Account{#[serde(rename="accountUuid")]id:String,#[serde(rename="emailAddress")]email:String,#[serde(rename="organizationUuid")]organization:Option<String>}
        let path=std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from).or_else(||std::env::var_os("USERPROFILE").or_else(||std::env::var_os("HOME")).map(PathBuf::from)).map(|root|root.join(".claude.json"));
        if let Some(path)=path{
            let read=(||->Result<(),()>{let Some(mut data)=bytes(&path)?else{return Ok(())};let parsed=serde_json::from_slice::<Config>(&data).map_err(|_|());data.fill(0);
                if let Some(account)=parsed?.account{let key=super::request_identity::claude_account_key(&account.id,account.organization.as_deref());if wanted.contains(&key)&&!account.email.trim().is_empty()&&!result.native_keys.values().any(|value|value==&key){result.native_keys.insert(key.clone(),key.clone());result.labels.insert(key,account.email);}}Ok(())})();
            if read.is_err(){result.warnings.push("Current Claude display metadata could not be read".into());}
        }
        return;
    }
    if tool!="codex"{return;}
    let mut paths=BTreeSet::new();
    if let Some(home)=std::env::var_os("USERPROFILE").or_else(||std::env::var_os("HOME")){paths.insert(PathBuf::from(home).join(".codex/auth.json"));}
    if let Some(home)=std::env::var_os("CODEX_HOME"){paths.insert(PathBuf::from(home).join("auth.json"));}
    #[derive(Deserialize)]struct Auth{tokens:Option<Tokens>}
    #[derive(Deserialize)]struct Tokens{id_token:Option<String>}
    #[derive(Deserialize)]struct Claims{email:Option<String>,#[serde(rename="https://api.openai.com/auth")]auth:Option<Identity>}
    #[derive(Deserialize)]struct Identity{chatgpt_account_id:Option<String>}
    for path in paths{
        let read=(||->Result<(),()>{
            let Some(mut data)=bytes(&path)?else{return Ok(())};
            let auth=serde_json::from_slice::<Auth>(&data).map_err(|_|());data.fill(0);
            let Some(token)=auth?.tokens.and_then(|t|t.id_token)else{return Ok(())};
            let decoded=token.split('.').nth(1).and_then(|payload|general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok());
            let mut token=token.into_bytes();token.fill(0);let mut decoded=decoded.ok_or(())?;
            let claims=serde_json::from_slice::<Claims>(&decoded).map_err(|_|());decoded.fill(0);
            let claims=claims?;
            if let(Some(id),Some(email))=(claims.auth.and_then(|a|a.chatgpt_account_id),claims.email){let key=format!("account:{id}");if wanted.contains(&key){result.labels.insert(key,email);}}
            Ok(())
        })();if read.is_err(){result.warnings.push("Current Codex display metadata could not be read".into());}
    }
}

fn discover(tool:&str,wanted:&BTreeSet<String>)->Names{
    #[cfg(test)]if std::env::var_os("LOCAL_COST_LEDGER_COPY").is_none(){return Names::default();}
    let root=crate::cockpit_logs_db::request_log_db_path().ok().and_then(|p|p.parent().map(Path::to_path_buf));
    let mut names=root.map(|root|external(&root,tool,wanted)).unwrap_or_default();
    auth_names(tool,wanted,&mut names);names
}

pub(super) fn collect(conn:&Connection,now:i64)->Result<(),String>{
    let last:Option<String>=conn.query_row("SELECT data FROM monitor_state WHERE key='account_names_collected_ms'",[],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    let linked:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM monitor_state WHERE key='account_native_names_v1')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    if linked&&last.and_then(|value|value.parse::<i64>().ok()).is_some_and(|last|now-last<60_000){return Ok(());}
    let mut warnings=BTreeMap::<String,Vec<String>>::new();
    for tool in ["codex","claude","antigravity","deepseek-harness"]{
        let wanted=super::quota::account_identity_keys(conn,tool)?;
        if wanted.is_empty(){continue;}
        let names=discover(tool,&wanted);
        save_names(conn,tool,&names,now)?;
        if !names.warnings.is_empty(){warnings.insert(tool.into(),names.warnings);}
    }
    conn.execute("INSERT INTO monitor_state(key,data) VALUES('account_names_status',?1) ON CONFLICT(key) DO UPDATE SET data=excluded.data",[serde_json::to_string(&warnings).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
    conn.execute("INSERT INTO monitor_state(key,data) VALUES('account_names_collected_ms',?1) ON CONFLICT(key) DO UPDATE SET data=excluded.data",[now.to_string()]).map_err(|e|e.to_string())?;
    conn.execute("INSERT OR IGNORE INTO monitor_state VALUES('account_native_names_v1','1')",[]).map_err(|e|e.to_string())?;
    Ok(())
}

fn save_names(conn:&Connection,tool:&str,names:&Names,now:i64)->Result<(),String>{
    for(key,label)in &names.labels{
        conn.execute("INSERT INTO monitor_account_profiles(tool,account_key,label,saved_ms) VALUES(?1,?2,?3,?4)
          ON CONFLICT(tool,account_key) DO UPDATE SET label=excluded.label,saved_ms=excluded.saved_ms WHERE label<>excluded.label",params![tool,key,label,now]).map_err(|e|e.to_string())?;
    }
    for(key,native)in &names.native_keys{
        conn.execute("INSERT OR IGNORE INTO monitor_account_native_keys(tool,native_key,account_key) VALUES(?1,?2,?3)",params![tool,native,key]).map_err(|e|e.to_string())?;
    }
    Ok(())
}

pub(super) fn native_keys(conn:&Connection,tool:&str)->Result<BTreeMap<String,String>,String>{
    let mut query=conn.prepare("SELECT native_key,account_key FROM monitor_account_native_keys WHERE tool=?1").map_err(|e|e.to_string())?;
    let rows=query.query_map([tool],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(|e|e.to_string())?;
    rows.collect::<Result<_,_>>().map_err(|e|e.to_string())
}

pub(super) fn resolve(conn:&Connection,tool:&str,wanted:&BTreeSet<String>)->Result<Names,String>{
    let mut names=Names::default();
    let mut query=conn.prepare("SELECT account_key,label FROM monitor_account_profiles WHERE tool=?1").map_err(|e|e.to_string())?;
    let rows=query.query_map([tool],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).map_err(|e|e.to_string())?;
    for row in rows{let(key,label)=row.map_err(|e|e.to_string())?;if wanted.contains(&key){names.labels.insert(key,label);}}
    let status:Option<String>=conn.query_row("SELECT data FROM monitor_state WHERE key='account_names_status'",[],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    if let Some(status)=status{let mut saved:BTreeMap<String,Vec<String>>=serde_json::from_str(&status).map_err(|_|"Account name status could not be read".to_owned())?;names.warnings=saved.remove(tool).unwrap_or_default();}
    Ok(names)
}

#[tauri::command]
pub async fn usage_monitor_set_account_name(account_key:String,name:String)->Result<(),String>{
    let name=name.trim().to_owned();
    if account_key.len()>512||name.chars().count()>128||name.chars().any(char::is_control){return Err("Invalid account name".into());}
    tauri::async_runtime::spawn_blocking(move||{
        let mut conn=crate::ledger_db::open_default().map_err(|e|e.to_string())?;
        if !super::quota::known_report_account(&conn,&account_key)?{return Err("Account not found".into());}
        let tx=conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|e|e.to_string())?;
        let mut saved=aliases(&tx)?;if name.is_empty(){saved.remove(&account_key);}else{saved.insert(account_key,name);}
        tx.execute("INSERT INTO monitor_state(key,data) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET data=excluded.data",params![ALIASES_KEY,serde_json::to_string(&saved).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e|e.to_string())
    }).await.map_err(|e|e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn native_claude_identity_keeps_the_existing_account_key_when_names_disappear_or_profiles_change(){
        let conn=Connection::open_in_memory().unwrap();super::super::store::initialize(&conn).unwrap();
        let mut names=Names::default();names.labels.insert("cockpit:original".into(),"a@example.test".into());names.native_keys.insert("cockpit:original".into(),"account:official".into());
        save_names(&conn,"claude",&names,1).unwrap();
        let before=native_keys(&conn,"claude").unwrap();
        save_names(&conn,"claude",&Names::default(),2).unwrap();
        names.native_keys.clear();names.native_keys.insert("cockpit:new-profile".into(),"account:official".into());
        save_names(&conn,"claude",&names,3).unwrap();
        assert_eq!(native_keys(&conn,"claude").unwrap(),before);
        assert_eq!(before["account:official"],"cockpit:original");
        assert_eq!(resolve(&conn,"claude",&BTreeSet::from(["cockpit:original".into()])).unwrap().labels["cockpit:original"],"a@example.test");
    }

    #[test]
    fn encrypted_names_match_exact_identity_and_survive_external_cleanup(){
        let root=std::env::temp_dir().join(format!("ledger-names-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(root.join("codex_accounts")).unwrap();
        let key=[7u8;32];let nonce=[3u8;12];let cipher=Aes256Gcm::new_from_slice(&key).unwrap();
        fs::write(root.join("secure-account-storage.key"),general_purpose::STANDARD.encode(key)).unwrap();
        fs::write(root.join("codex_accounts.json"),r#"{"accounts":[{"id":"local-a","email":"a@example.test"},{"id":"local-b","email":"a@example.test"}]}"#).unwrap();
        let encrypted=cipher.encrypt(Nonce::from_slice(&nonce),br#"{"id":"local-a","account_id":"official-a","email":"a@example.test","tokens":{"access_token":"ignored"}}"#.as_ref()).unwrap();
        let envelope=serde_json::json!({"version":1,"algorithm":"AES-256-GCM","nonce":general_purpose::STANDARD.encode(nonce),"ciphertext":general_purpose::STANDARD.encode(&encrypted)});
        let path=root.join("codex_accounts/local-a.json");fs::write(&path,envelope.to_string()).unwrap();
        fs::write(root.join("codex_accounts/local-b.json"),r#"{"id":"local-b","account_id":"official-b","email":"a@example.test"}"#).unwrap();
        let wanted=BTreeSet::from(["account:official-a".into(),"account:official-b".into(),"account:local-a".into()]);
        let names=external(&root,"codex",&wanted);
        assert_eq!(names.labels.len(),2);assert!(!names.labels.contains_key("account:local-a"));assert!(names.warnings.is_empty());
        let storage=root.with_extension("sqlite");
        let conn=Connection::open(&storage).unwrap();super::super::store::initialize(&conn).unwrap();
        save_names(&conn,"codex",&names,100).unwrap();
        let mut tampered=envelope;let mut damaged=encrypted;damaged[0]^=1;tampered["ciphertext"]=general_purpose::STANDARD.encode(damaged).into();
        fs::write(&path,tampered.to_string()).unwrap();assert!(profile(&path,Some(&cipher)).is_err());
        fs::remove_dir_all(&root).unwrap();
        save_names(&conn,"codex",&external(&root,"codex",&wanted),200).unwrap();
        drop(conn);let conn=Connection::open(&storage).unwrap();
        let retained=resolve(&conn,"codex",&wanted).unwrap();assert_eq!(retained.labels,names.labels);
        let identities=super::super::quota::account_report_identities(&conn,"codex").unwrap();assert_eq!(identities.len(),2);
        let raw="account:official-a";let id=super::super::quota::report_account_key("codex",raw);
        conn.execute("INSERT INTO monitor_state VALUES(?1,?2)",params![ALIASES_KEY,serde_json::json!({id.clone():"My account"}).to_string()]).unwrap();
        let renamed=super::super::quota::account_report_identities(&conn,"codex").unwrap();assert_eq!(renamed[raw],(id.clone(),"My account · a@example.test".into()));assert_eq!(identities[raw].0,id);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM monitor_requests",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        drop(conn);fs::remove_file(storage).unwrap();
    }

    #[test]
    fn conflicting_names_are_not_assigned_by_email_or_profile_order(){
        let mut candidates=BTreeMap::new();let wanted=BTreeSet::from(["account:a".into()]);
        put(&mut candidates,&wanted,"account:b".into(),"same@example.test");assert!(candidates.is_empty());
        put(&mut candidates,&wanted,"account:a".into(),"one@example.test");put(&mut candidates,&wanted,"account:a".into(),"two@example.test");
        assert_eq!(candidates["account:a"].len(),2);
    }
}
