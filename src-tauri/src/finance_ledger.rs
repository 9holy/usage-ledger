use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

// v13 stays immutable: installed databases apply the additive v14 migration below.
pub const SCHEMA_SQL: &str = "
CREATE TABLE IF NOT EXISTS finance_events (
 id TEXT PRIMARY KEY, source TEXT NOT NULL CHECK(source IN ('sub2api','cliproxy','cockpit')),
 instance_id TEXT NOT NULL, account_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('purchase','renewal','refund','termination_loss')),
 amount REAL NOT NULL CHECK(amount>0), currency TEXT NOT NULL CHECK(currency IN ('CNY','USD')),
 occurred_at_ms INTEGER NOT NULL, coverage_start_ms INTEGER, coverage_end_ms INTEGER, note TEXT,
 created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, voided_at_ms INTEGER,
 CHECK((coverage_start_ms IS NULL AND coverage_end_ms IS NULL) OR
 (kind IN ('purchase','renewal') AND coverage_start_ms IS NOT NULL AND coverage_end_ms IS NOT NULL
 AND coverage_end_ms>coverage_start_ms))
);
CREATE INDEX IF NOT EXISTS ix_finance_scope_time ON finance_events(source,instance_id,account_id,occurred_at_ms);
";
pub const MIGRATION_V14: &str = "
ALTER TABLE finance_events ADD COLUMN purchase_channel TEXT;
ALTER TABLE finance_events ADD COLUMN plan_label TEXT;
ALTER TABLE finance_events ADD COLUMN batch_id TEXT;
ALTER TABLE finance_events ADD COLUMN batch_total REAL;
ALTER TABLE finance_events ADD COLUMN related_event_id TEXT;
CREATE INDEX ix_finance_batch ON finance_events(source,instance_id,batch_id);
CREATE INDEX ix_finance_related ON finance_events(related_event_id) WHERE related_event_id IS NOT NULL;
";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinanceScope {
    pub source: String,
    pub instance_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinanceEventInput {
    pub id: String,
    pub source: String,
    pub instance_id: String,
    pub account_id: String,
    pub kind: String,
    pub amount: f64,
    pub currency: String,
    pub occurred_at_ms: i64,
    pub coverage_start_ms: Option<i64>,
    pub coverage_end_ms: Option<i64>,
    pub note: Option<String>,
    pub purchase_channel: Option<String>,
    pub plan_label: Option<String>,
    pub batch_id: Option<String>,
    pub batch_total: Option<f64>,
    pub related_event_id: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinanceEvent {
    #[serde(flatten)]
    pub entry: FinanceEventInput,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub voided_at_ms: Option<i64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinanceQuery {
    pub source: String,
    pub instance_id: String,
    pub account_id: Option<String>,
    pub start_ms: i64,
    pub end_ms: i64,
    #[serde(default)]
    pub list_mode: Option<String>,
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "page_size")]
    pub limit: usize,
    pub purchase_channel: Option<String>,
    pub plan_label: Option<String>,
}
fn page_size() -> usize {
    100
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FinanceBatchInput {
    pub scope: FinanceScope,
    pub batch_id: String,
    pub total_amount: f64,
    pub currency: String,
    pub occurred_at_ms: i64,
    pub purchase_channel: Option<String>,
    pub allocations: Vec<FinanceEventInput>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinanceBatch {
    pub scope: FinanceScope,
    pub batch_id: String,
    pub total_amount: f64,
    pub currency: String,
    pub occurred_at_ms: i64,
    pub purchase_channel: Option<String>,
    pub events: Vec<FinanceEvent>,
}
#[derive(Clone, Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrencySummary {
    pub currency: String,
    pub cash_outlay: f64,
    pub refunds: f64,
    pub accrued_expense: f64,
    pub recognized_loss: f64,
    pub expense_credits: f64,
    pub net_expense: Option<f64>,
    pub remaining_prepaid: Option<f64>,
    pub ongoing_hourly_expense: Option<f64>,
    pub unresolved_count: usize,
    pub has_entered_facts: bool,
    pub termination_loss: f64,
    pub amortized_expense: f64,
    pub missing_coverage_count: usize,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageInterval {
    pub start_ms: i64,
    pub end_ms: i64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    pub account_id: String,
    #[serde(flatten)]
    pub totals: CurrencySummary,
    pub coverage_intervals: Vec<CoverageInterval>,
    pub lifetime_accrued_expense: f64,
    pub lifetime_recognized_loss: f64,
    pub lifetime_expense_credits: f64,
    pub lifetime_coverage_intervals: Vec<CoverageInterval>,
}
#[derive(Default, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinanceSummary {
    pub event_count: usize,
    pub has_entered_facts: bool,
    pub unresolved_termination_count: usize,
    pub currencies: Vec<CurrencySummary>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinanceSnapshot {
    pub events: Vec<FinanceEvent>,
    pub total_events: usize,
    pub purchase_channels: Vec<String>,
    pub plan_labels: Vec<String>,
    pub summary: FinanceSummary,
    pub by_account: Vec<AccountSummary>,
}

fn valid_id_text(value: &str, field: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > 512 || value.chars().any(char::is_control) {
        return Err(format!("Invalid {field}"));
    }
    Ok(())
}
fn valid_scope(source: &str, instance: &str) -> Result<(), String> {
    if !matches!(source, "sub2api" | "cliproxy" | "cockpit") {
        return Err("Unsupported finance source".into());
    }
    valid_id_text(instance, "instanceId")
}
fn valid_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
fn valid_time(value: i64) -> bool {
    (-8_640_000_000_000_000..=8_640_000_000_000_000).contains(&value)
}
fn is_purchase(e: &FinanceEventInput) -> bool {
    matches!(e.kind.as_str(), "purchase" | "renewal")
}
fn tolerance(amount: f64) -> f64 {
    0.000001_f64.max(amount.abs() * 1e-10)
}
fn validate(e: &FinanceEventInput) -> Result<(), String> {
    valid_scope(&e.source, &e.instance_id)?;
    valid_id_text(&e.account_id, "accountId")?;
    if !valid_uuid(&e.id) {
        return Err("Invalid event UUID".into());
    }
    if !matches!(
        e.kind.as_str(),
        "purchase" | "renewal" | "refund" | "termination_loss"
    ) {
        return Err("Invalid event kind".into());
    }
    if !e.amount.is_finite() || e.amount <= 0. {
        return Err("Amount must be positive and finite".into());
    }
    if !matches!(e.currency.as_str(), "CNY" | "USD") {
        return Err("Unsupported event currency".into());
    }
    if !valid_time(e.occurred_at_ms) {
        return Err("Invalid event time".into());
    }
    match (e.coverage_start_ms, e.coverage_end_ms) {
        (None, None) => {}
        (Some(s), Some(t)) if is_purchase(e) && valid_time(s) && valid_time(t) && t > s => {}
        _ => {
            return Err(
                "Coverage requires a valid start/end interval on purchase or renewal".into(),
            )
        }
    }
    for (value, field) in [
        (&e.purchase_channel, "purchaseChannel"),
        (&e.plan_label, "planLabel"),
    ] {
        if let Some(value) = value {
            valid_id_text(value, field)?;
        }
    }
    if e.note.as_ref().is_some_and(|s| s.chars().count() > 1000) {
        return Err("Note exceeds 1000 characters".into());
    }
    match (&e.batch_id, e.batch_total) {
        (None, None) => {}
        (Some(id), Some(total))
            if is_purchase(e) && valid_uuid(id) && total.is_finite() && total > 0. => {}
        _ => return Err("Invalid purchase batch metadata".into()),
    }
    if let Some(id) = &e.related_event_id {
        if !valid_uuid(id) || id == &e.id || is_purchase(e) {
            return Err("Invalid related event".into());
        }
    }
    Ok(())
}

const SELECT_EVENT: &str =
    "SELECT id,source,instance_id,account_id,kind,amount,currency,occurred_at_ms,
 coverage_start_ms,coverage_end_ms,note,created_at_ms,updated_at_ms,voided_at_ms,
 purchase_channel,plan_label,batch_id,batch_total,related_event_id FROM finance_events";
fn row_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<FinanceEvent> {
    Ok(FinanceEvent {
        entry: FinanceEventInput {
            id: row.get(0)?,
            source: row.get(1)?,
            instance_id: row.get(2)?,
            account_id: row.get(3)?,
            kind: row.get(4)?,
            amount: row.get(5)?,
            currency: row.get(6)?,
            occurred_at_ms: row.get(7)?,
            coverage_start_ms: row.get(8)?,
            coverage_end_ms: row.get(9)?,
            note: row.get(10)?,
            purchase_channel: row.get(14)?,
            plan_label: row.get(15)?,
            batch_id: row.get(16)?,
            batch_total: row.get(17)?,
            related_event_id: row.get(18)?,
        },
        created_at_ms: row.get(11)?,
        updated_at_ms: row.get(12)?,
        voided_at_ms: row.get(13)?,
    })
}
fn find(conn: &Connection, id: &str) -> Result<Option<FinanceEvent>, String> {
    conn.query_row(&format!("{SELECT_EVENT} WHERE id=?1"), [id], row_event)
        .optional()
        .map_err(|e| e.to_string())
}
fn load(conn: &Connection, scope: &FinanceScope) -> Result<Vec<FinanceEvent>, String> {
    let mut stmt=conn.prepare(&format!("{SELECT_EVENT} WHERE source=?1 AND instance_id=?2 ORDER BY occurred_at_ms,created_at_ms,id")).map_err(|e|e.to_string())?;
    let rows = stmt
        .query_map(params![scope.source, scope.instance_id], row_event)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}
fn check_owner(old: &FinanceEvent, new: &FinanceEventInput) -> Result<(), String> {
    if old.entry.source != new.source
        || old.entry.instance_id != new.instance_id
        || old.entry.account_id != new.account_id
    {
        return Err("Event ownership cannot change; void and enter a new event".into());
    }
    if old.voided_at_ms.is_some() {
        return Err("Voided events cannot be edited".into());
    }
    if old.entry.batch_id != new.batch_id {
        return Err("Event batch cannot change".into());
    }
    Ok(())
}
fn write(conn: &Connection, e: &FinanceEventInput, now: i64) -> Result<(), String> {
    validate(e)?;
    if let Some(old) = find(conn, &e.id)? {
        check_owner(&old, e)?;
    }
    conn.execute("INSERT INTO finance_events(id,source,instance_id,account_id,kind,amount,currency,occurred_at_ms,
        coverage_start_ms,coverage_end_ms,note,created_at_ms,updated_at_ms,purchase_channel,plan_label,batch_id,batch_total,related_event_id)
        VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12,?13,?14,?15,?16,?17)
        ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,amount=excluded.amount,currency=excluded.currency,
        occurred_at_ms=excluded.occurred_at_ms,coverage_start_ms=excluded.coverage_start_ms,coverage_end_ms=excluded.coverage_end_ms,
        note=excluded.note,purchase_channel=excluded.purchase_channel,plan_label=excluded.plan_label,
        batch_total=excluded.batch_total,related_event_id=excluded.related_event_id,updated_at_ms=excluded.updated_at_ms",
        params![e.id,e.source,e.instance_id,e.account_id,e.kind,e.amount,e.currency,e.occurred_at_ms,
            e.coverage_start_ms,e.coverage_end_ms,e.note,now,e.purchase_channel,e.plan_label,e.batch_id,e.batch_total,e.related_event_id])
        .map_err(|e|e.to_string())?;
    Ok(())
}

// The allowed graph is purchase -> loss -> refund (or purchase -> refund), so cycles cannot pass kind validation.
fn relations<'a>(all: &'a [FinanceEvent]) -> Result<BTreeMap<&'a str, &'a FinanceEvent>, String> {
    let active: BTreeMap<_, _> = all
        .iter()
        .filter(|e| e.voided_at_ms.is_none())
        .map(|e| (e.entry.id.as_str(), e))
        .collect();
    for event in active.values() {
        let e = &event.entry;
        validate(e)?;
        if let Some(id) = e.related_event_id.as_deref() {
            let parent = active
                .get(id)
                .ok_or("Related event is missing or voided; handle linked events first")?;
            let p = &parent.entry;
            if e.account_id != p.account_id
                || e.currency != p.currency
                || e.source != p.source
                || e.instance_id != p.instance_id
            {
                return Err("Related event must use the same scope, account and currency".into());
            }
            if !(is_purchase(p) || (e.kind == "refund" && p.kind == "termination_loss")) {
                return Err("Termination must link a purchase; refund must link a purchase or termination loss".into());
            }
            if e.occurred_at_ms < p.occurred_at_ms {
                return Err("Related event cannot occur before its source event".into());
            }
        }
    }
    Ok(active)
}
fn root_id<'a>(e: &'a FinanceEvent, active: &BTreeMap<&str, &'a FinanceEvent>) -> Option<&'a str> {
    if is_purchase(&e.entry) {
        return Some(&e.entry.id);
    }
    let parent = active.get(e.entry.related_event_id.as_deref()?)?;
    if is_purchase(&parent.entry) {
        Some(&parent.entry.id)
    } else {
        parent
            .entry
            .related_event_id
            .as_deref()
            .filter(|id| active.get(id).is_some_and(|p| is_purchase(&p.entry)))
    }
}
fn validate_batches(all: &[FinanceEvent]) -> Result<(), String> {
    let mut groups = BTreeMap::<&str, Vec<&FinanceEventInput>>::new();
    for event in all.iter().filter(|e| e.voided_at_ms.is_none()) {
        if let Some(id) = event.entry.batch_id.as_deref() {
            groups.entry(id).or_default().push(&event.entry);
        }
    }
    for group in groups.values() {
        let first = group[0];
        let sum: f64 = group.iter().map(|e| e.amount).sum();
        if !sum.is_finite()
            || (sum - first.batch_total.unwrap()).abs() > tolerance(sum)
            || group.iter().any(|e| {
                e.batch_total != first.batch_total
                    || e.currency != first.currency
                    || e.occurred_at_ms != first.occurred_at_ms
                    || e.purchase_channel != first.purchase_channel
            })
        {
            return Err("Batch allocations must equal its paid total and share currency, time and channel; edit the whole batch".into());
        }
    }
    Ok(())
}

#[derive(Default)]
struct LotResult {
    accrued: f64,
    loss: f64,
    credits: f64,
    remaining: f64,
    hourly: f64,
    lifetime_accrued: f64,
    lifetime_loss: f64,
    lifetime_credits: f64,
}
fn in_window(t: i64, start: i64, end: i64) -> bool {
    t >= start && t < end
}
fn advance(
    balance: &mut f64,
    rate: f64,
    cursor: &mut i64,
    until: i64,
    stop: i64,
    start: i64,
    end: i64,
    result: &mut LotResult,
) {
    let to = until.min(stop).max(*cursor);
    if to > *cursor {
        let duration = to - *cursor;
        let expense = (*balance).min(rate * duration as f64).max(0.);
        let overlap = (to.min(end) - (*cursor).max(start)).max(0);
        result.accrued += expense * (overlap as f64 / duration as f64);
        result.lifetime_accrued += expense;
        *balance = (*balance - expense).max(0.);
        *cursor = to;
    }
}
fn calculate_lot(
    root: &FinanceEvent,
    children: &[&FinanceEvent],
    start: i64,
    end: i64,
    validate_all: bool,
) -> Result<Option<LotResult>, String> {
    let p = &root.entry;
    let Some((coverage_start, coverage_end)) = p.coverage_start_ms.zip(p.coverage_end_ms) else {
        return Ok(None);
    };
    let mut balance = p.amount;
    let mut rate = balance / (coverage_end - coverage_start) as f64;
    let mut cursor = coverage_start;
    let mut terminated = false;
    let mut total_refunded = 0.;
    let mut refunded_losses = BTreeMap::<&str, f64>::new();
    let losses: BTreeMap<_, _> = children
        .iter()
        .filter(|e| e.entry.kind == "termination_loss")
        .map(|e| (e.entry.id.as_str(), e.entry.amount))
        .collect();
    let mut result = LotResult::default();
    for child in children {
        let e = &child.entry;
        if !validate_all && e.occurred_at_ms >= end {
            break;
        }
        advance(
            &mut balance,
            rate,
            &mut cursor,
            e.occurred_at_ms,
            coverage_end,
            start,
            end,
            &mut result,
        );
        if e.kind == "termination_loss" {
            if e.amount > balance + tolerance(p.amount) {
                return Err(
                    "Termination loss exceeds the remaining prepaid balance at its business time"
                        .into(),
                );
            }
            balance = (balance - e.amount).max(0.);
            if in_window(e.occurred_at_ms, start, end) {
                result.loss += e.amount;
            }
            result.lifetime_loss += e.amount;
            terminated = true;
            rate = 0.;
        } else {
            total_refunded += e.amount;
            if total_refunded > p.amount + tolerance(p.amount) {
                return Err("Cumulative refunds exceed the original purchase payment".into());
            }
            if e.related_event_id.as_deref() == Some(p.id.as_str()) {
                let prepaid = balance.min(e.amount);
                balance = (balance - prepaid).max(0.);
                if in_window(e.occurred_at_ms, start, end) {
                    result.credits += e.amount - prepaid;
                }
                result.lifetime_credits += e.amount - prepaid;
                if !terminated && e.occurred_at_ms < coverage_end {
                    rate = balance / (coverage_end - e.occurred_at_ms.max(coverage_start)) as f64;
                }
            } else {
                let id = e.related_event_id.as_deref().unwrap();
                let refunded = refunded_losses.entry(id).or_default();
                *refunded += e.amount;
                if *refunded > losses.get(id).copied().unwrap_or(0.) + tolerance(p.amount) {
                    return Err("Refund exceeds the unrefunded termination loss".into());
                }
                if in_window(e.occurred_at_ms, start, end) {
                    result.credits += e.amount;
                }
                result.lifetime_credits += e.amount;
            }
        }
    }
    advance(
        &mut balance,
        rate,
        &mut cursor,
        end,
        coverage_end,
        start,
        end,
        &mut result,
    );
    result.remaining = balance;
    result.hourly = if !terminated && end > coverage_start && end < coverage_end {
        rate * 3_600_000.
    } else {
        0.
    };
    Ok(Some(result))
}
fn grouped_children<'a>(
    all: &'a [FinanceEvent],
    active: &BTreeMap<&str, &'a FinanceEvent>,
) -> BTreeMap<&'a str, Vec<&'a FinanceEvent>> {
    let mut groups = BTreeMap::<&str, Vec<&FinanceEvent>>::new();
    for e in all
        .iter()
        .filter(|e| e.voided_at_ms.is_none() && !is_purchase(&e.entry))
    {
        if let Some(id) = root_id(e, active) {
            groups.entry(id).or_default().push(e);
        }
    }
    groups
}
fn validate_ledger(conn: &Connection, scope: &FinanceScope) -> Result<(), String> {
    let all = load(conn, scope)?;
    let active = relations(&all)?;
    validate_batches(&all)?;
    let groups = grouped_children(&all, &active);
    let mut all_loss_refunds = BTreeMap::<&str, f64>::new();
    for child in active.values().filter(|e| e.entry.kind == "refund") {
        if let Some(parent) = child
            .entry
            .related_event_id
            .as_deref()
            .and_then(|id| active.get(id))
        {
            if parent.entry.kind == "termination_loss" {
                let total = all_loss_refunds.entry(&parent.entry.id).or_default();
                *total += child.entry.amount;
                if !total.is_finite()
                    || *total > parent.entry.amount + tolerance(parent.entry.amount)
                {
                    return Err("Refund exceeds the unrefunded termination loss".into());
                }
            }
        }
    }
    for root in active.values().filter(|e| is_purchase(&e.entry)) {
        let children = groups
            .get(root.entry.id.as_str())
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let refund_sum: f64 = children
            .iter()
            .filter(|e| e.entry.kind == "refund")
            .map(|e| e.entry.amount)
            .sum();
        if !refund_sum.is_finite() || refund_sum > root.entry.amount + tolerance(root.entry.amount)
        {
            return Err("Cumulative refunds exceed the original purchase payment".into());
        }
        let mut loss_refunds = BTreeMap::<&str, f64>::new();
        for child in children.iter().filter(|e| e.entry.kind == "refund") {
            let parent = active[child.entry.related_event_id.as_deref().unwrap()];
            if parent.entry.kind == "termination_loss" {
                let amount = loss_refunds.entry(&parent.entry.id).or_default();
                *amount += child.entry.amount;
                if *amount > parent.entry.amount + tolerance(parent.entry.amount) {
                    return Err("Refund exceeds the unrefunded termination loss".into());
                }
            }
        }
        calculate_lot(
            root,
            children,
            -8_640_000_000_000_000,
            8_640_000_000_000_000,
            true,
        )?;
    }
    Ok(())
}

pub fn save(conn: &mut Connection, event: FinanceEventInput) -> Result<FinanceEvent, String> {
    let scope = FinanceScope {
        source: event.source.clone(),
        instance_id: event.instance_id.clone(),
    };
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    write(&tx, &event, crate::ledger_db::now_ms())?;
    validate_ledger(&tx, &scope)?;
    let saved = find(&tx, &event.id)?.ok_or("Saved event unavailable")?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(saved)
}
fn scoped_event(conn: &Connection, scope: &FinanceScope, id: &str) -> Result<FinanceEvent, String> {
    valid_scope(&scope.source, &scope.instance_id)?;
    let event = find(conn, id)?.ok_or("Event not found")?;
    if event.entry.source != scope.source || event.entry.instance_id != scope.instance_id {
        return Err("Event scope mismatch".into());
    }
    Ok(event)
}
fn soft_void(conn: &Connection, id: &str, now: i64) -> Result<(), String> {
    let linked:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM finance_events WHERE related_event_id=?1 AND voided_at_ms IS NULL)",[id],|r|r.get(0)).map_err(|e|e.to_string())?;
    if linked {
        return Err("Handle or void the active linked events before voiding their source".into());
    }
    conn.execute("UPDATE finance_events SET voided_at_ms=COALESCE(voided_at_ms,?2),updated_at_ms=CASE WHEN voided_at_ms IS NULL THEN ?2 ELSE updated_at_ms END WHERE id=?1",params![id,now]).map_err(|e|e.to_string())?;
    Ok(())
}
pub fn void(conn: &mut Connection, scope: FinanceScope, id: &str) -> Result<FinanceEvent, String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    scoped_event(&tx, &scope, id)?;
    soft_void(&tx, id, crate::ledger_db::now_ms())?;
    validate_ledger(&tx, &scope)?;
    let saved = find(&tx, id)?.ok_or("Voided event unavailable")?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(saved)
}
pub fn get_batch(
    conn: &Connection,
    scope: FinanceScope,
    batch_id: &str,
) -> Result<FinanceBatch, String> {
    valid_scope(&scope.source, &scope.instance_id)?;
    if !valid_uuid(batch_id) {
        return Err("Invalid batch UUID".into());
    }
    let events: Vec<_> = load(conn, &scope)?
        .into_iter()
        .filter(|e| e.voided_at_ms.is_none() && e.entry.batch_id.as_deref() == Some(batch_id))
        .collect();
    let first = &events.first().ok_or("Active batch not found")?.entry;
    Ok(FinanceBatch {
        scope,
        batch_id: batch_id.into(),
        total_amount: first.batch_total.unwrap(),
        currency: first.currency.clone(),
        occurred_at_ms: first.occurred_at_ms,
        purchase_channel: first.purchase_channel.clone(),
        events,
    })
}
pub fn save_batch(conn: &mut Connection, batch: FinanceBatchInput) -> Result<FinanceBatch, String> {
    valid_scope(&batch.scope.source, &batch.scope.instance_id)?;
    if !valid_uuid(&batch.batch_id)
        || !batch.total_amount.is_finite()
        || batch.total_amount <= 0.
        || batch.allocations.is_empty()
    {
        return Err("A batch requires a valid UUID, positive total and allocations".into());
    }
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let now = crate::ledger_db::now_ms();
    let mut ids = BTreeSet::new();
    let mut accounts = BTreeSet::new();
    for mut entry in batch.allocations {
        if !ids.insert(entry.id.clone())
            || !accounts.insert(entry.account_id.clone())
            || entry.source != batch.scope.source
            || entry.instance_id != batch.scope.instance_id
            || !is_purchase(&entry)
            || entry.currency != batch.currency
            || entry.occurred_at_ms != batch.occurred_at_ms
        {
            return Err("Batch allocations require unique IDs, purchase/renewal and the batch scope, currency and time".into());
        }
        entry.batch_id = Some(batch.batch_id.clone());
        entry.batch_total = Some(batch.total_amount);
        entry.purchase_channel = batch.purchase_channel.clone();
        write(&tx, &entry, now)?;
    }
    for old in load(&tx, &batch.scope)?.iter().filter(|e| {
        e.voided_at_ms.is_none() && e.entry.batch_id.as_deref() == Some(batch.batch_id.as_str())
    }) {
        if !ids.contains(&old.entry.id) {
            soft_void(&tx, &old.entry.id, now)?;
        }
    }
    validate_ledger(&tx, &batch.scope)?;
    let saved = get_batch(&tx, batch.scope, &batch.batch_id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(saved)
}
pub fn void_batch(
    conn: &mut Connection,
    scope: FinanceScope,
    batch_id: &str,
) -> Result<(), String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let batch = get_batch(&tx, scope.clone(), batch_id)?;
    let now = crate::ledger_db::now_ms();
    for event in batch.events {
        soft_void(&tx, &event.entry.id, now)?;
    }
    validate_ledger(&tx, &scope)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

fn bucket<'a>(
    accounts: &'a mut BTreeMap<(String, String), AccountSummary>,
    e: &FinanceEventInput,
) -> &'a mut AccountSummary {
    accounts
        .entry((e.account_id.clone(), e.currency.clone()))
        .or_insert_with(|| AccountSummary {
            account_id: e.account_id.clone(),
            totals: CurrencySummary {
                currency: e.currency.clone(),
                net_expense: Some(0.),
                remaining_prepaid: Some(0.),
                ongoing_hourly_expense: Some(0.),
                ..Default::default()
            },
            coverage_intervals: Vec::new(),
            lifetime_accrued_expense: 0.,
            lifetime_recognized_loss: 0.,
            lifetime_expense_credits: 0.,
            lifetime_coverage_intervals: Vec::new(),
        })
}
fn unresolved(b: &mut AccountSummary, missing_coverage: bool) {
    b.totals.unresolved_count += 1;
    b.totals.missing_coverage_count += usize::from(missing_coverage);
    b.totals.net_expense = None;
    b.totals.remaining_prepaid = None;
    b.totals.ongoing_hourly_expense = None;
}
fn aggregate(target: &mut CurrencySummary, s: &CurrencySummary) {
    target.cash_outlay += s.cash_outlay;
    target.refunds += s.refunds;
    target.accrued_expense += s.accrued_expense;
    target.recognized_loss += s.recognized_loss;
    target.expense_credits += s.expense_credits;
    target.termination_loss += s.termination_loss;
    target.amortized_expense += s.amortized_expense;
    target.missing_coverage_count += s.missing_coverage_count;
    target.unresolved_count += s.unresolved_count;
    target.has_entered_facts |= s.has_entered_facts;
    target.net_expense = target.net_expense.zip(s.net_expense).map(|(a, b)| a + b);
    target.remaining_prepaid = target
        .remaining_prepaid
        .zip(s.remaining_prepaid)
        .map(|(a, b)| a + b);
    target.ongoing_hourly_expense = target
        .ongoing_hourly_expense
        .zip(s.ongoing_hourly_expense)
        .map(|(a, b)| a + b);
}
pub fn query(conn: &Connection, q: FinanceQuery) -> Result<FinanceSnapshot, String> {
    valid_scope(&q.source, &q.instance_id)?;
    if let Some(id) = &q.account_id {
        valid_id_text(id, "accountId")?;
    }
    if !valid_time(q.start_ms) || !valid_time(q.end_ms) || q.end_ms <= q.start_ms {
        return Err("Invalid finance time window".into());
    }
    if !matches!(q.list_mode.as_deref(), None | Some("current") | Some("all"))
        || q.limit == 0
        || q.limit > 100
    {
        return Err("Invalid finance list page".into());
    }
    let all = load(
        conn,
        &FinanceScope {
            source: q.source.clone(),
            instance_id: q.instance_id.clone(),
        },
    )?;
    let active = relations(&all)?;
    let groups = grouped_children(&all, &active);
    let identities: BTreeMap<_, _> = all.iter().map(|e| (e.entry.id.as_str(), e)).collect();
    let mut channels = BTreeSet::new();
    let mut plans = BTreeSet::new();
    for e in &all {
        if let Some(v) = &e.entry.purchase_channel {
            channels.insert(v.clone());
        }
        if let Some(v) = &e.entry.plan_label {
            plans.insert(v.clone());
        }
    }
    let matches = |e: &FinanceEvent| {
        let root = root_id(e, &identities)
            .and_then(|id| identities.get(id))
            .copied()
            .unwrap_or(e);
        q.account_id
            .as_ref()
            .is_none_or(|id| id == &e.entry.account_id)
            && q.purchase_channel
                .as_ref()
                .is_none_or(|v| Some(v) == root.entry.purchase_channel.as_ref())
            && q.plan_label
                .as_ref()
                .is_none_or(|v| Some(v) == root.entry.plan_label.as_ref())
    };
    let overlap = |e: &FinanceEventInput| {
        e.coverage_start_ms
            .zip(e.coverage_end_ms)
            .is_some_and(|(s, t)| s < q.end_ms && t > q.start_ms)
    };
    let mut listed: Vec<_> = all
        .iter()
        .filter(|e| {
            matches(e)
                && (q.list_mode.as_deref() == Some("all")
                    || in_window(e.entry.occurred_at_ms, q.start_ms, q.end_ms)
                    || overlap(&e.entry))
        })
        .cloned()
        .collect();
    listed.reverse();
    let total_events = listed.len();
    let events = listed.into_iter().skip(q.offset).take(q.limit).collect();
    let mut summary = FinanceSummary::default();
    let mut accounts = BTreeMap::new();
    for event in all
        .iter()
        .filter(|e| e.voided_at_ms.is_none() && matches(e))
    {
        let e = &event.entry;
        if e.occurred_at_ms >= q.end_ms && !overlap(e) {
            continue;
        }
        let b = bucket(&mut accounts, e);
        b.totals.has_entered_facts = true;
        if in_window(e.occurred_at_ms, q.start_ms, q.end_ms) {
            summary.event_count += 1;
            match e.kind.as_str() {
                "purchase" | "renewal" => b.totals.cash_outlay += e.amount,
                "refund" => b.totals.refunds += e.amount,
                "termination_loss" => b.totals.termination_loss += e.amount,
                _ => unreachable!(),
            }
        }
        if !is_purchase(e) && root_id(event, &active).is_none() && e.occurred_at_ms < q.end_ms {
            unresolved(b, false);
            if e.kind == "termination_loss" {
                summary.unresolved_termination_count += 1;
            }
        }
    }
    for root in all
        .iter()
        .filter(|e| e.voided_at_ms.is_none() && is_purchase(&e.entry) && matches(e))
    {
        let p = &root.entry;
        if p.occurred_at_ms >= q.end_ms && !overlap(p) {
            continue;
        }
        let b = bucket(&mut accounts, p);
        let children = groups.get(p.id.as_str()).map(Vec::as_slice).unwrap_or(&[]);
        if let Some(result) = calculate_lot(root, children, q.start_ms, q.end_ms, false)? {
            b.totals.accrued_expense += result.accrued;
            b.totals.amortized_expense += result.accrued;
            b.totals.recognized_loss += result.loss;
            b.totals.expense_credits += result.credits;
            b.lifetime_accrued_expense += result.lifetime_accrued;
            b.lifetime_recognized_loss += result.lifetime_loss;
            b.lifetime_expense_credits += result.lifetime_credits;
            if let Some(value) = &mut b.totals.remaining_prepaid {
                *value += result.remaining;
            }
            if let Some(value) = &mut b.totals.ongoing_hourly_expense {
                *value += result.hourly;
            }
            let start = p.coverage_start_ms.unwrap().max(q.start_ms);
            let end = p.coverage_end_ms.unwrap().min(q.end_ms);
            if end > start {
                b.coverage_intervals.push(CoverageInterval {
                    start_ms: start,
                    end_ms: end,
                });
            }
            let start = p.coverage_start_ms.unwrap();
            let end = p.coverage_end_ms.unwrap().min(q.end_ms);
            if end > start {
                b.lifetime_coverage_intervals.push(CoverageInterval {
                    start_ms: start,
                    end_ms: end,
                });
            }
        } else {
            unresolved(b, true);
            for child in children
                .iter()
                .filter(|c| c.entry.occurred_at_ms < q.end_ms)
            {
                unresolved(b, false);
                if child.entry.kind == "termination_loss" {
                    summary.unresolved_termination_count += 1;
                }
            }
        }
    }
    let mut currencies = BTreeMap::<String, CurrencySummary>::new();
    for account in accounts.values_mut() {
        let s = &mut account.totals;
        if s.unresolved_count == 0 {
            s.net_expense = Some(s.accrued_expense + s.recognized_loss - s.expense_credits);
        }
        let values = [
            Some(s.cash_outlay),
            Some(s.refunds),
            Some(s.accrued_expense),
            Some(s.recognized_loss),
            Some(s.expense_credits),
            s.net_expense,
            s.remaining_prepaid,
            s.ongoing_hourly_expense,
        ];
        if values.iter().flatten().any(|v| !v.is_finite()) {
            return Err("Finance totals exceed the supported numeric range".into());
        }
        account.coverage_intervals.sort_by_key(|v| v.start_ms);
        let mut merged: Vec<CoverageInterval> = Vec::new();
        for interval in account.coverage_intervals.drain(..) {
            if let Some(last) = merged
                .last_mut()
                .filter(|last| last.end_ms >= interval.start_ms)
            {
                last.end_ms = last.end_ms.max(interval.end_ms);
            } else {
                merged.push(interval);
            }
        }
        account.coverage_intervals = merged;
        let bucket = currencies
            .entry(s.currency.clone())
            .or_insert_with(|| CurrencySummary {
                currency: s.currency.clone(),
                net_expense: Some(0.),
                remaining_prepaid: Some(0.),
                ongoing_hourly_expense: Some(0.),
                ..Default::default()
            });
        aggregate(bucket, s);
    }
    summary.has_entered_facts = accounts.values().any(|v| v.totals.has_entered_facts);
    summary.currencies = currencies.into_values().collect();
    Ok(FinanceSnapshot {
        events,
        total_events,
        purchase_channels: channels.into_iter().collect(),
        plan_labels: plans.into_iter().collect(),
        summary,
        by_account: accounts.into_values().collect(),
    })
}

#[tauri::command]
pub async fn finance_ledger_query(query: FinanceQuery) -> Result<FinanceSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::ledger_db::open_read_only(
            &crate::ledger_db::ledger_db_path().map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        self::query(&conn, query)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn finance_ledger_save(event: FinanceEventInput) -> Result<FinanceEvent, String> {
    tauri::async_runtime::spawn_blocking(move || {
        self::save(
            &mut crate::ledger_db::open_default().map_err(|e| e.to_string())?,
            event,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn finance_ledger_void(scope: FinanceScope, id: String) -> Result<FinanceEvent, String> {
    tauri::async_runtime::spawn_blocking(move || {
        self::void(
            &mut crate::ledger_db::open_default().map_err(|e| e.to_string())?,
            scope,
            &id,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn finance_ledger_save_batch(batch: FinanceBatchInput) -> Result<FinanceBatch, String> {
    tauri::async_runtime::spawn_blocking(move || {
        self::save_batch(
            &mut crate::ledger_db::open_default().map_err(|e| e.to_string())?,
            batch,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn finance_ledger_get_batch(
    scope: FinanceScope,
    batch_id: String,
) -> Result<FinanceBatch, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let conn = crate::ledger_db::open_read_only(
            &crate::ledger_db::ledger_db_path().map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        self::get_batch(&conn, scope, &batch_id)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn finance_ledger_void_batch(
    scope: FinanceScope,
    batch_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        self::void_batch(
            &mut crate::ledger_db::open_default().map_err(|e| e.to_string())?,
            scope,
            &batch_id,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn finance_ledger_related_events(
    scope: FinanceScope,
    account_id: String,
    currency: String,
) -> Result<Vec<FinanceEvent>, String> {
    valid_scope(&scope.source, &scope.instance_id)?;
    valid_id_text(&account_id, "accountId")?;
    if !matches!(currency.as_str(), "CNY" | "USD") {
        return Err("Unsupported event currency".into());
    }
    tauri::async_runtime::spawn_blocking(move|| {
        let conn=crate::ledger_db::open_read_only(&crate::ledger_db::ledger_db_path().map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
        let mut stmt=conn.prepare(&format!("{SELECT_EVENT} WHERE source=?1 AND instance_id=?2 AND account_id=?3 AND currency=?4 AND voided_at_ms IS NULL AND kind IN ('purchase','renewal','termination_loss') ORDER BY occurred_at_ms DESC,created_at_ms DESC,id")).map_err(|e|e.to_string())?;
        let rows=stmt.query_map(params![scope.source,scope.instance_id,account_id,currency],row_event).map_err(|e|e.to_string())?;
        rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())
    }).await.map_err(|e|e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    const DAY: i64 = 86_400_000;
    fn db() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA_SQL).unwrap();
        c.execute_batch(MIGRATION_V14).unwrap();
        c
    }
    fn scope() -> FinanceScope {
        FinanceScope {
            source: "cockpit".into(),
            instance_id: "local".into(),
        }
    }
    fn event(n: u32, kind: &str, amount: f64, time: i64) -> FinanceEventInput {
        FinanceEventInput {
            id: format!("00000000-0000-4000-8000-{n:012}"),
            source: "cockpit".into(),
            instance_id: "local".into(),
            account_id: "account".into(),
            kind: kind.into(),
            amount,
            currency: "CNY".into(),
            occurred_at_ms: time,
            coverage_start_ms: None,
            coverage_end_ms: None,
            note: None,
            purchase_channel: None,
            plan_label: None,
            batch_id: None,
            batch_total: None,
            related_event_id: None,
        }
    }
    fn purchase() -> FinanceEventInput {
        let mut p = event(1, "purchase", 100., 0);
        p.coverage_start_ms = Some(0);
        p.coverage_end_ms = Some(10 * DAY);
        p
    }
    fn linked(n: u32, kind: &str, amount: f64, time: i64, parent: u32) -> FinanceEventInput {
        let mut e = event(n, kind, amount, time);
        e.related_event_id = Some(event(parent, "purchase", 1., 0).id);
        e
    }
    fn window(start: i64, end: i64) -> FinanceQuery {
        FinanceQuery {
            source: "cockpit".into(),
            instance_id: "local".into(),
            account_id: None,
            start_ms: start,
            end_ms: end,
            list_mode: None,
            offset: 0,
            limit: 100,
            purchase_channel: None,
            plan_label: None,
        }
    }
    fn near(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-7, "{a} != {b}");
    }
    #[test]
    fn termination_and_its_refund_do_not_repeat_purchase_or_resume_accrual() {
        let mut c = db();
        save(&mut c, purchase()).unwrap();
        save(&mut c, linked(2, "termination_loss", 60., 4 * DAY, 1)).unwrap();
        save(&mut c, linked(3, "refund", 20., 6 * DAY, 2)).unwrap();
        let before = query(&c, window(0, 4 * DAY)).unwrap();
        let s = &before.by_account[0].totals;
        near(s.accrued_expense, 40.);
        near(s.recognized_loss, 0.);
        near(s.remaining_prepaid.unwrap(), 60.);
        near(s.ongoing_hourly_expense.unwrap(), 10. / 24.);
        let full = query(&c, window(0, 10 * DAY)).unwrap();
        let s = &full.by_account[0].totals;
        near(s.cash_outlay, 100.);
        near(s.refunds, 20.);
        near(s.accrued_expense, 40.);
        near(s.recognized_loss, 60.);
        near(s.expense_credits, 20.);
        near(s.net_expense.unwrap(), 80.);
        near(s.remaining_prepaid.unwrap(), 0.);
        near(s.ongoing_hourly_expense.unwrap(), 0.);
        let later = query(&c, window(5 * DAY, 7 * DAY)).unwrap();
        let s = &later.by_account[0].totals;
        near(s.accrued_expense, 0.);
        near(s.net_expense.unwrap(), -20.);
        near(s.ongoing_hourly_expense.unwrap(), 0.);
        assert_eq!(later.by_account[0].coverage_intervals[0].end_ms, 7 * DAY);
        assert!(void(&mut c, scope(), &event(1, "purchase", 1., 0).id).is_err());
        assert!(save(&mut c, linked(4, "refund", 41., 7 * DAY, 2)).is_err());
    }
    #[test]
    fn purchase_refunds_reduce_future_balance_not_past_expense() {
        let mut c = db();
        save(&mut c, purchase()).unwrap();
        save(&mut c, linked(2, "refund", 20., 2 * DAY, 1)).unwrap();
        let early = query(&c, window(0, 2 * DAY)).unwrap();
        near(early.by_account[0].totals.accrued_expense, 20.);
        let later = query(&c, window(2 * DAY, 6 * DAY)).unwrap();
        let s = &later.by_account[0].totals;
        near(s.accrued_expense, 30.);
        near(s.remaining_prepaid.unwrap(), 30.);
        near(s.ongoing_hourly_expense.unwrap(), 7.5 / 24.);
        let full = query(&c, window(0, 11 * DAY)).unwrap();
        near(full.by_account[0].totals.net_expense.unwrap(), 80.);
        assert!(save(&mut c, linked(3, "refund", 81., 8 * DAY, 1)).is_err());
    }
    #[test]
    fn full_precoverage_postcoverage_and_same_second_refunds() {
        for (at, expected_accrual, expected_credit) in
            [(0, 0., 0.), (2 * DAY, 20., 20.), (11 * DAY, 100., 100.)]
        {
            let mut c = db();
            save(&mut c, purchase()).unwrap();
            save(&mut c, linked(2, "refund", 100., at, 1)).unwrap();
            let r = query(&c, window(0, 12 * DAY)).unwrap();
            let s = &r.by_account[0].totals;
            near(s.accrued_expense, expected_accrual);
            near(s.expense_credits, expected_credit);
            near(s.net_expense.unwrap(), 0.);
            near(s.remaining_prepaid.unwrap(), 0.);
        }
        let mut c = db();
        let mut p = purchase();
        p.coverage_start_ms = Some(DAY);
        p.coverage_end_ms = Some(11 * DAY);
        save(&mut c, p).unwrap();
        save(&mut c, linked(2, "refund", 20., 0, 1)).unwrap();
        near(
            query(&c, window(0, 12 * DAY)).unwrap().by_account[0]
                .totals
                .accrued_expense,
            80.,
        );
    }
    #[test]
    fn unresolved_cash_and_native_currency_scope_are_honest_and_editable() {
        let mut c = db();
        assert!(!query(&c, window(0, 10)).unwrap().summary.has_entered_facts);
        let original = save(&mut c, event(1, "purchase", 10., 0)).unwrap();
        let mut remote = purchase();
        remote.id = event(2, "purchase", 1., 0).id;
        remote.instance_id = "remote".into();
        save(&mut c, remote).unwrap();
        let mut usd = event(3, "refund", 4., 9);
        usd.currency = "USD".into();
        save(&mut c, usd).unwrap();
        save(&mut c, event(4, "refund", 3., 10)).unwrap();
        let r = query(&c, window(0, 10)).unwrap();
        assert_eq!(r.events.len(), 2);
        assert_eq!(r.by_account.len(), 2);
        assert!(r.by_account.iter().all(|v| v.totals.net_expense.is_none()));
        let mut edit = original.entry.clone();
        edit.amount = 12.;
        let edited = save(&mut c, edit.clone()).unwrap();
        assert_eq!(edited.created_at_ms, original.created_at_ms);
        edit.account_id = "other".into();
        assert!(save(&mut c, edit).is_err());
        void(&mut c, scope(), &original.entry.id).unwrap();
        assert!(find(&c, &original.entry.id)
            .unwrap()
            .unwrap()
            .voided_at_ms
            .is_some());
        assert!(save(&mut c, original.entry).is_err());
        let mut bad = linked(5, "refund", 1., 1, 2);
        bad.instance_id = "local".into();
        assert!(save(&mut c, bad).is_err());
    }
    #[test]
    fn batch_total_atomic_edit_void_and_list_filters_do_not_change_summary() {
        let mut c = db();
        let id = event(99, "purchase", 1., 0).id;
        let mut a = purchase();
        a.amount = 40.;
        a.plan_label = Some("A".into());
        let mut b = event(2, "renewal", 60., 0);
        b.account_id = "second".into();
        b.coverage_start_ms = Some(0);
        b.coverage_end_ms = Some(10 * DAY);
        b.plan_label = Some("B".into());
        let mut batch = FinanceBatchInput {
            scope: scope(),
            batch_id: id.clone(),
            total_amount: 100.,
            currency: "CNY".into(),
            occurred_at_ms: 0,
            purchase_channel: Some("seller".into()),
            allocations: vec![a, b],
        };
        save_batch(&mut c, batch.clone()).unwrap();
        batch.allocations[0].amount = 50.;
        assert!(save_batch(&mut c, batch.clone()).is_err());
        near(
            get_batch(&c, scope(), &id).unwrap().events[0].entry.amount,
            40.,
        );
        batch.allocations[1].amount = 50.;
        save_batch(&mut c, batch.clone()).unwrap();
        let mut q = window(0, 10 * DAY);
        q.limit = 1;
        let r = query(&c, q.clone()).unwrap();
        assert_eq!(r.events.len(), 1);
        assert_eq!(r.total_events, 2);
        near(r.summary.currencies[0].net_expense.unwrap(), 100.);
        assert_eq!(r.purchase_channels, vec!["seller"]);
        q.offset = 1;
        q.list_mode = Some("all".into());
        near(
            query(&c, q).unwrap().summary.currencies[0]
                .net_expense
                .unwrap(),
            100.,
        );
        let mut direct = batch.allocations[0].clone();
        direct.batch_id = Some(id.clone());
        direct.batch_total = Some(100.);
        direct.purchase_channel = Some("seller".into());
        direct.amount = 70.;
        assert!(save(&mut c, direct).is_err());
        void_batch(&mut c, scope(), &id).unwrap();
        let r = query(&c, window(0, 10 * DAY)).unwrap();
        assert_eq!(r.total_events, 2);
        assert!(!r.summary.has_entered_facts);
    }
    #[test]
    fn additive_migration_keeps_old_facts_and_invalid_inputs_roll_back() {
        let mut c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA_SQL).unwrap();
        c.execute("INSERT INTO finance_events VALUES('00000000-0000-4000-8000-000000000001','cockpit','local','old','purchase',10,'CNY',0,NULL,NULL,NULL,0,0,NULL)",[]).unwrap();
        c.execute_batch(MIGRATION_V14).unwrap();
        let r = query(&c, window(0, 1)).unwrap();
        assert_eq!(r.total_events, 1);
        assert_eq!(r.by_account[0].totals.unresolved_count, 1);
        for amount in [0., -1., f64::NAN, f64::INFINITY] {
            assert!(save(&mut c, event(2, "purchase", amount, 0)).is_err());
        }
        let mut p = event(2, "purchase", 10., 0);
        p.coverage_start_ms = Some(0);
        assert!(save(&mut c, p).is_err());
    }
}
