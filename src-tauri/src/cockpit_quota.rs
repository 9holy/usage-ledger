//! 渠道配额读取层（T14）—— **只读 cockpit 落盘数据，配额不进账本**。
//!
//! ## 边界（红线）
//!
//! - **不进账本**：配额的量纲是"百分比 / 余额"，不是 token。本文件**不得**出现任何
//!   `INSERT INTO usage_rollup`（有 `quota_module_never_writes_to_the_ledger` 单测钉死）。
//! - **不读凭证、不调上游**：本轮 `LiveApiProvider` 恒失败并降级到 `SnapshotProvider`
//!   （主理人拍板：合规考量，路径 A 只留插槽）。
//! - **不做月费外推**：只输出"当前窗口状态"（`windowKind` + `remainingFraction`），
//!   5h 窗口线性外推成月费属于编造，交给前端且必须标注"估算"。
//! - **`percentage` 语义归一化只在本文件一处**（P0-23 / 共享知识第 21 条）。
//!
//! ## 两个已核实的硬前提
//!
//! 1. `cache/quota_api_v1_desktop/authorized` **必须在 `read_cockpit_dir` 白名单里**，
//!    否则 antigravity 那个 TTL 60s 的配额缓存读不到（架构师报 D-5）。白名单唯一来源是
//!    本文件的 [`ALLOWED_QUOTA_SUBDIRS`]，`main.rs` 必须引用它，不许另抄一份。
//! 2. 配额缓存文件名是 `<sha256(email)>.json`（69 字符），**过不了** `read_cockpit_file`
//!    的 `name.len() <= 64` 校验 → 只能列目录全读（架构师报 D-6）。
//!
//! ## 关联键
//!
//! 依赖树里没有 sha256，只有 md5，**不自己算哈希**。缓存 JSON 内部自带 `email` 字段，
//! 因此走"列目录全读 → 按 `email` 反关联"，与前端 `getCockpitQuotaHistories()` 同手法。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use serde::Serialize;

// ────────────────────────────── 渠道常量 ──────────────────────────────

pub const CH_CODEX: &str = "codex";
pub const CH_GEMINI: &str = "gemini";
pub const CH_ANTIGRAVITY: &str = "antigravity";
pub const CH_ANTIGRAVITY_IDE: &str = "antigravity_ide";
pub const CH_CLAUDE: &str = "claude_manager";
pub const CH_CURSOR: &str = "cursor";
pub const CH_KIRO: &str = "kiro";
pub const CH_TRAE: &str = "trae";
pub const CH_TRAE_CN: &str = "trae_cn";
pub const CH_TRAE_SOLO: &str = "trae_solo";
pub const CH_TRAE_SOLO_CN: &str = "trae_solo_cn";
pub const CH_WINDSURF: &str = "windsurf";
pub const CH_GROK: &str = "grok";
pub const CH_CODEBUDDY: &str = "codebuddy";
pub const CH_CODEBUDDY_CN: &str = "codebuddy_cn";
pub const CH_WORKBUDDY: &str = "workbuddy";
pub const CH_QODER: &str = "qoder";
pub const CH_GITHUB_COPILOT: &str = "github-copilot";
pub const CH_ZED: &str = "zed";
pub const CH_ZCODE: &str = "zcode";

/// 有账号清单的渠道全集（PRD §3.2 的 20 渠道去掉"Codex API Service"这个无账号服务页）。
pub const ALL_CHANNELS: &[&str] = &[
    CH_CODEX,
    CH_ANTIGRAVITY,
    CH_ANTIGRAVITY_IDE,
    CH_GEMINI,
    CH_CLAUDE,
    CH_ZED,
    CH_GITHUB_COPILOT,
    CH_WINDSURF,
    CH_KIRO,
    CH_CURSOR,
    CH_GROK,
    CH_CODEBUDDY,
    CH_CODEBUDDY_CN,
    CH_QODER,
    CH_ZCODE,
    CH_TRAE,
    CH_TRAE_SOLO,
    CH_TRAE_CN,
    CH_TRAE_SOLO_CN,
    CH_WORKBUDDY,
];

// ────────────────────────────── 路径与缓存常量 ──────────────────────────────

/// 配额历史（按模型的时间序列，就是 cockpit 界面上百分比进度条的来源）。
pub const SUBDIR_QUOTA_HISTORY: &str = "cache/quota_history";
/// antigravity 桌面端配额缓存（TTL 60s）。★ D-5：这一条原本不在白名单里。
pub const SUBDIR_QUOTA_DESKTOP: &str = "cache/quota_api_v1_desktop/authorized";
/// antigravity 插件端配额缓存。
pub const SUBDIR_QUOTA_PLUGIN: &str = "cache/quota_api_v1_plugin/authorized";

/// `read_cockpit_dir` 的子目录白名单。**唯一来源** —— `main.rs` 的 `ALLOWED_SUBDIRS`
/// 必须引用本常量，不许另抄一份（抄了就会出现"白名单加了、读的人不知道"的漂移）。
pub const ALLOWED_QUOTA_SUBDIRS: &[&str] = &[
    SUBDIR_QUOTA_HISTORY,
    SUBDIR_QUOTA_DESKTOP,
    SUBDIR_QUOTA_PLUGIN,
];

/// antigravity 桌面缓存的 TTL（对齐 cockpit 自己的 60 秒）。
pub const TTL_DESKTOP_CACHE_MS: i64 = 60_000;
/// 账号快照 / 配额历史的 TTL。
pub const TTL_SNAPSHOT_MS: i64 = 300_000;

/// 归一化时允许的浮点容差（原始数据常见 100.0000000001）。
const PERCENT_EPSILON: f64 = 1e-6;

// ────────────────────────────── 枚举 ──────────────────────────────

/// `percentage` 的**原始**语义。★ P0-23：必须显式声明，禁止默认值兜底。
///
/// 反例教训：`grok` 给的是"已用%"，`codex`/`antigravity`/`gemini` 给的是"剩余%"。
/// 混用会把"还剩 90%"显示成"已用 90%" —— 不报错、不影响布局，只让成本算反方向。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PercentKind {
    /// 原始值 = 剩余百分比。
    Remaining,
    /// 原始值 = 已用百分比（需要 `100 - x` 翻转）。
    Used,
}

/// 数据来源（P0-21 验收②：每处用量必须标注来源类型）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum QuotaSourceKind {
    /// 路径 B：cockpit 落盘快照（默认，零外网请求）。
    Snapshot,
    /// 路径 A：实时调上游（本轮不启用）。
    Live,
}

/// 配额窗口类型。5h 窗口**不参与月费分摊**（主理人拍板）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum QuotaWindowKind {
    FiveHour,
    Weekly,
    Monthly,
    Unknown,
}

// ────────────────────────────── 归一化（P0-23 单点） ──────────────────────────────

/// 渠道 → `percentage` 原始语义。**每个渠道一行，没有兜底分支**。
///
/// ⚠️ trae 系列的取舍：PRD §3.3 第 6 列写"剩余"，但同一格括号里写明落盘字段是
/// `usedPercent`（"需转"）。**按字段事实判为 `Used`**；若实测反了，只改这四行。
pub const CHANNEL_SEMANTICS: &[(&str, PercentKind)] = &[
    (CH_CODEX, PercentKind::Remaining),
    (CH_GEMINI, PercentKind::Remaining),
    (CH_ANTIGRAVITY, PercentKind::Remaining),
    (CH_ANTIGRAVITY_IDE, PercentKind::Remaining),
    (CH_CLAUDE, PercentKind::Remaining),
    (CH_CURSOR, PercentKind::Remaining),
    (CH_KIRO, PercentKind::Remaining),
    (CH_WINDSURF, PercentKind::Remaining),
    (CH_GROK, PercentKind::Used),
    (CH_CODEBUDDY, PercentKind::Remaining),
    (CH_CODEBUDDY_CN, PercentKind::Remaining),
    (CH_WORKBUDDY, PercentKind::Remaining),
    (CH_QODER, PercentKind::Remaining),
    (CH_GITHUB_COPILOT, PercentKind::Remaining),
    (CH_ZED, PercentKind::Remaining),
    (CH_ZCODE, PercentKind::Remaining),
    (CH_TRAE, PercentKind::Used),
    (CH_TRAE_CN, PercentKind::Used),
    (CH_TRAE_SOLO, PercentKind::Used),
    (CH_TRAE_SOLO_CN, PercentKind::Used),
];

/// 字段名 → 语义。**字段名字面即语义，优先级高于渠道表**（最不易出错的一层）。
pub const FIELD_SEMANTICS: &[(&str, PercentKind)] = &[
    ("remainingFraction", PercentKind::Remaining),
    ("remainingPercentage", PercentKind::Remaining),
    ("remainingPercent", PercentKind::Remaining),
    ("remaining_percent", PercentKind::Remaining),
    ("remaining", PercentKind::Remaining),
    ("percentage", PercentKind::Remaining),
    ("usedPercent", PercentKind::Used),
    ("usedPercentage", PercentKind::Used),
    ("used_percent", PercentKind::Used),
    ("used_percentage", PercentKind::Used),
    ("usagePercent", PercentKind::Used),
    ("percentUsed", PercentKind::Used),
];

/// 优先按**字段名**判语义，其次按渠道表；都没有 → **报错**（不是静默取默认）。
pub fn resolve_semantics(channel: &str, raw_field: &str) -> Result<PercentKind, String> {
    if let Some((_, kind)) = FIELD_SEMANTICS.iter().find(|(f, _)| *f == raw_field) {
        return Ok(*kind);
    }
    match CHANNEL_SEMANTICS.iter().find(|(c, _)| *c == channel) {
        Some((_, kind)) => Ok(*kind),
        None => Err(format!(
            "渠道 {channel} 未声明 percentage 语义(P0-23:禁止默认值兜底,请先补 CHANNEL_SEMANTICS)"
        )),
    }
}

/// 渠道声明的语义（无字段名可用时）。未声明返回 `None` —— 调用方必须当错误处理。
pub fn percent_semantics_of(channel: &str) -> Option<PercentKind> {
    CHANNEL_SEMANTICS.iter().find(|(c, _)| *c == channel).map(|(_, k)| *k)
}

/// ★ 归一化单点：原始百分比 + 语义 → **剩余百分比（0..100）**。
///
/// 这是全仓唯一允许做 `100 - x` 翻转的地方（共享知识第 21 条）。
pub fn normalize_percent(raw_percent: f64, kind: PercentKind) -> Result<f64, String> {
    if !raw_percent.is_finite() {
        return Err(format!("配额百分比不是有限数: {raw_percent}"));
    }
    // 半开区间判定:越界(含浮点误差容差)一律拒绝,不 clamp 兜底。
    // 用 `RangeInclusive::contains` 而非两个比较:边界只有一处,改不动歪。
    if !(-PERCENT_EPSILON..=100.0 + PERCENT_EPSILON).contains(&raw_percent) {
        return Err(format!("配额百分比越界(期望 0..100): {raw_percent}"));
    }
    let clamped = raw_percent.clamp(0.0, 100.0);
    Ok(match kind {
        PercentKind::Remaining => clamped,
        PercentKind::Used => 100.0 - clamped,
    })
}

// ────────────────────────────── 落盘字段表 ──────────────────────────────

/// 渠道 → 账号详情里的落盘快照字段（按顺序探测，第一个取到值的生效）。
pub fn raw_fields_of(channel: &str) -> &'static [&'static str] {
    match channel {
        CH_CLAUDE => &["claude_usage_raw", "quota"],
        CH_CODEX | CH_GROK | CH_ANTIGRAVITY | CH_GEMINI | CH_ANTIGRAVITY_IDE => {
            &["quota"]
        }
        CH_CURSOR => &["cursor_usage_raw"],
        CH_KIRO => &["kiro_usage_raw"],
        CH_TRAE | CH_TRAE_CN | CH_TRAE_SOLO | CH_TRAE_SOLO_CN => {
            &["trae_entitlement_raw", "trae_usage_raw"]
        }
        CH_WINDSURF => &["copilot_quota_snapshots", "windsurf_plan_status"],
        CH_CODEBUDDY | CH_CODEBUDDY_CN | CH_WORKBUDDY => &["quota_raw", "usage_raw"],
        CH_QODER => &["auth_credit_usage_raw", "credits_usage_percent"],
        CH_GITHUB_COPILOT => &["copilot_quota_snapshots"],
        CH_ZED => &["usage_raw", "usage_tokens_raw"],
        CH_ZCODE => &["quota_remaining"],
        _ => &[],
    }
}

/// 渠道 → 账号目录名。
///
/// ⚠️ **平台 ID ≠ 账号目录名**：cockpit 有 3 处对不上，**不能**机械拼 `{channel}_accounts`。
/// 依据（cockpit 源码，只读参考 `E:\sub2api\cockpit-tools-main`）：
///
/// 1. `claude_manager`（平台 ID）→ 目录 **`claude_accounts`**
///    —— `src-tauri/src/modules/claude_account_core_storage.rs:38`（同文件 `:37` 是索引名
///    `claude_accounts.json`）。
/// 2. `github-copilot`（平台 ID）→ 目录 **`github_copilot_accounts`**（连字符换成下划线）
///    —— `crates/cockpit-core/src/modules/github_copilot_account.rs:11`，
///    `src-tauri/src/modules/github_copilot_account.rs:12` 同。
/// 3. `trae_cn` / `trae_solo` / `trae_solo_cn` —— cockpit 把 **4 个 Trae 平台存在同一个
///    `trae_accounts` 目录**（`src-tauri/src/modules/trae_account_platform_storage.rs:22`），
///    平台标识在**账号内部**字段里（`resolve_account_platform_kind`），而账号详情是加密的
///    ⇒ **我们无法按平台拆分**。所以这 3 个变体**刻意保持指向各自的（不存在的）目录** ——
///    结果是它们不占位（`has_accounts=false`，前端整行过滤掉），而不是谎报"0 账号"。
///    它们的数据**没有丢**：都在 `trae` 这一行里（`trae_accounts` 是全平台合计）。
///    **不要"顺手修好"**：把这 3 个指到 `trae_accounts` 会让同一批账号在 4 行里重复出现，
///    比不显示更糟。有 `trae_variants_deliberately_point_at_their_own_missing_dirs` 钉死。
///
/// 其余渠道机械拼 `{channel}_accounts` 与 cockpit 的 `ACCOUNTS_DIR` 常量**逐一核对一致**
/// （codex / cursor / kiro / grok / windsurf / codebuddy / codebuddy_cn / workbuddy / qoder /
/// zed / zcode），故默认规则保留。
///
/// **gemini / antigravity / antigravity_ide 例外**：详情落在 `accounts/` 而不是
/// `<channel>_accounts/`（PRD §3.1；cockpit `crates/cockpit-core/src/modules/account.rs:27`）。
///
/// ⚠️ 本函数同时决定 [`index_file_path`]（索引名 = `<目录名>.json`），所以改这里会一并
/// 影响 Plan 列的取值来源。
pub fn accounts_dir_name(channel: &str) -> String {
    match channel {
        // gemini / antigravity 系：Google 系共用 `accounts/`（PRD §3.1）。
        CH_ANTIGRAVITY | CH_GEMINI | CH_ANTIGRAVITY_IDE => "accounts".to_string(),
        // 平台 ID `claude_manager` ≠ 目录 `claude_accounts`（见上方依据 1）。
        CH_CLAUDE => "claude_accounts".to_string(),
        // 平台 ID `github-copilot` ≠ 目录 `github_copilot_accounts`（见上方依据 2）。
        CH_GITHUB_COPILOT => "github_copilot_accounts".to_string(),
        // 默认：`{channel}_accounts`。trae 3 个变体刻意走这条（见上方依据 3）。
        _ => format!("{channel}_accounts"),
    }
}

/// 该渠道是否吃 antigravity 60s 桌面缓存（只有 Google 系有这份缓存）。
pub fn uses_desktop_cache(channel: &str) -> bool {
    matches!(channel, CH_ANTIGRAVITY | CH_GEMINI | CH_ANTIGRAVITY_IDE)
}

// ────────────────────────────── 数据结构 ──────────────────────────────

/// 一条归一化后的配额快照。**前端只看这个结构**。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaSnapshot {
    pub channel: String,
    pub account_id: String,
    pub email: String,
    /// 模型 id；空串 = 该渠道不按模型分（账号级配额）。
    pub model_id: String,
    pub scope: String,
    /// 模型/账号显示名（antigravity 的 `displayName`、quota_history 的 `label`）。
    pub display_name: String,
    /// ★ 已归一化为"剩余%"（0..100）。**`None` = 用量不可得，绝不是 0**。
    pub percent: Option<f64>,
    /// 剩余比例（0..1），T15 / P0-22 的唯一消费口径。
    pub remaining_fraction: Option<f64>,
    /// 已用比例（0..1），= `1 - remaining_fraction`。
    pub used_fraction: Option<f64>,
    /// 原始语义（审计用：让上层知道这个数是不是被翻转过）。
    pub percent_kind: Option<PercentKind>,
    /// ★ 非空 = 用量不可得（API Key 类等）。**返回标注型空值而不是 0**。
    pub unavailable_reason: Option<String>,
    pub window_kind: QuotaWindowKind,
    pub window_started_at_ms: Option<i64>,
    pub reset_at_ms: Option<i64>,
    pub source: QuotaSourceKind,
    /// 本次读取的时刻（epoch ms）。
    pub fetched_at_ms: i64,
    /// 数据自身的落盘时刻（cockpit `updatedAt`）；用于判定"数据可能过期"。
    pub updated_at_ms: Option<i64>,
    /// 数据自身时间戳已超过 TTL → true。UI 决定是否显示"数据可能过期"。
    pub stale: bool,
    /// 原始来源标识（如 `cache/quota_api_v1_desktop/authorized`、`Account.quota`）。
    pub raw_kind: String,
    pub source_error: Option<String>,
    /// ★ 账号套餐/档位（如 `plus` / `pro` / `team` / `API_KEY` / `Gemini Code Assist…`）。
    /// **`None` = 源里没有或账号详情加密读不到** → 界面显示 `—`，绝不用 0/猜测值冒充。
    ///
    /// 依据(cockpit 源码,只读):各渠道账号模型普遍带套餐字段——
    /// `crates/cockpit-core/src/models/{codex,workbuddy,trae,qoder,codebuddy}.rs` 的
    /// `pub plan_type`、`kiro.rs` 的 `plan_name`、`zed.rs` 的 `plan_raw`、
    /// `cursor.rs` 的 `membership_type`、`windsurf.rs` / `github_copilot.rs` 的 `copilot_plan`、
    /// `quota.rs` 的 `subscription_tier` / `tier_id`。桌面端此前只把 `plan_type` 当
    /// `display_name` 兜底候选(`AccountSnapshot`),从未单独暴露 —— 本字段即补齐。
    pub plan: Option<String>,
}

impl QuotaSnapshot {
    /// 构造一条"用量不可得"的快照（**不是 0%**）。
    #[allow(clippy::too_many_arguments)]
    fn unavailable(
        channel: &str,
        account_id: &str,
        email: &str,
        display_name: &str,
        reason: String,
        source: QuotaSourceKind,
        now_ms: i64,
        raw_kind: &str,
        plan: Option<String>,
    ) -> Self {
        Self {
            channel: channel.to_string(),
            account_id: account_id.to_string(),
            email: email.to_string(),
            model_id: String::new(),
            scope: "account".into(),
            display_name: display_name.to_string(),
            percent: None,
            remaining_fraction: None,
            used_fraction: None,
            percent_kind: None,
            unavailable_reason: Some(reason),
            window_kind: QuotaWindowKind::Unknown,
            window_started_at_ms: None,
            reset_at_ms: None,
            source,
            fetched_at_ms: now_ms,
            updated_at_ms: None,
            stale: false,
            raw_kind: raw_kind.to_string(),
            source_error: None,
            plan,
        }
    }
}

/// 账号详情里承载"套餐/档位"的字段名（按顺序探测，第一个非空生效）。
///
/// 依据(cockpit 源码,只读):
/// - `plan_type`:`crates/cockpit-core/src/models/{codex,workbuddy,trae,qoder,codebuddy}.rs`
///   （各渠道 `Account` 与 `*AccountSummary` 都带）；
/// - `plan_name`:`models/kiro.rs:35,79`、gemini 账号详情实测字段；
/// - `plan_raw`:`models/zed.rs:14,80`；
/// - `membership_type`:`models/cursor.rs:54`；
/// - `copilot_plan`:`models/windsurf.rs:87`、`models/github_copilot.rs:55`；
/// - `subscription_tier` / `tier_id`:`models/quota.rs:32,38`（antigravity/gemini 配额结构，
///   账号详情加密时读不到 → None）。
///
/// 取不到一律 `None`（界面显示 `—`），绝不编造。
const PLAN_FIELD_CANDIDATES: &[&str] = &[
    "plan_type",
    "planType",
    "plan_name",
    "planName",
    "plan_raw",
    "planRaw",
    "copilot_plan",
    "copilotPlan",
    "membership_type",
    "membershipType",
    "subscription_tier",
    "subscriptionTier",
    "tier_id",
    "tierId",
];

/// 从账号详情 JSON 抽套餐名。先看顶层，再看嵌套 `quota`（antigravity/gemini 的
/// `subscription_tier` / `tier_id` 在 `quota` 里）。空串视为没有。
fn plan_of(json: &serde_json::Value) -> Option<String> {
    let top = first_str(json, PLAN_FIELD_CANDIDATES);
    if !top.is_empty() {
        return Some(top);
    }
    if let Some(quota) = json.get("quota") {
        let nested = first_str(quota, PLAN_FIELD_CANDIDATES);
        if !nested.is_empty() {
            return Some(nested);
        }
    }
    None
}

/// 渠道索引（摘要）文件路径 = `<root>/<accounts_dir_name>.json`。
///
/// 依据(cockpit 源码,只读) `src-tauri/src/modules/secure_account_storage.rs:1-5`：
/// 索引/摘要文件**保持明文**，只有逐账号详情 JSON 落盘加密。各渠道的索引文件名常量
/// 与 [`accounts_dir_name`] 的推导逐一核对一致 ——
/// `codex_accounts.json`(`codex_account_core_tokens.rs:12`)、
/// `cursor_accounts.json`(`cursor_account.rs:13`)、`kiro_accounts.json`(`kiro_account.rs:12`)、
/// `trae_accounts.json`(`trae_account_core_platform_storage.rs:21`)、
/// `windsurf_accounts.json`(`windsurf_account.rs:14`)、`qoder_accounts.json`(`qoder_account.rs:10`)、
/// `codebuddy_accounts.json` / `codebuddy_cn_accounts.json`(`codebuddy*_account.rs:14`)、
/// `workbuddy_accounts.json`(`workbuddy_account.rs:14`)、`zed_accounts.json`(`zed_account.rs:14`)、
/// `claude_accounts.json`(`src-tauri/.../claude_account_core_storage.rs:37`)；
/// Google 系（antigravity / gemini）为 `accounts.json`(`crates/.../account.rs:26`)。
fn index_file_path(root: &Path, channel: &str) -> PathBuf {
    root.join(format!("{}.json", accounts_dir_name(channel)))
}

/// 从**明文索引文件**抽 `<账号 id, 套餐>`。
///
/// 索引形如 `{ "accounts": [ { "id": "...", "email": "...", "plan_type": "..." } ] }`。
/// 取值复用 [`plan_of`]（它已覆盖所有字段名变体与嵌套 `quota`），不另抄字段名表。
///
/// **文件不存在 / 读失败 / 解析失败 / 结构不符 → 静默返回空 map**：
/// "这个渠道没装"是正常状态而不是错误 —— 与 [`load_dir_files`] 的既有约定一致。
fn load_index_plans(root: &Path, channel: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let path = index_file_path(root, channel);
    let Ok(content) = std::fs::read_to_string(&path) else {
        return out;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) else {
        return out;
    };
    let Some(entries) = json.get("accounts").and_then(|v| v.as_array()) else {
        return out;
    };
    for entry in entries {
        let id = first_str(entry, &["id", "account_id", "accountId"]);
        if id.is_empty() {
            continue;
        }
        // 只收非空字符串（`plan_of` 内部已把空串视为没有）。
        if let Some(plan) = plan_of(entry) {
            out.insert(id, plan);
        }
    }
    out
}

/// 配额历史的一个采样点。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaHistoryPoint {
    pub timestamp_ms: i64,
    /// 原始 `remainingPercentage`（quota_history 明确是剩余）。
    pub remaining_percentage: f64,
    /// 归一化后的剩余比例（0..1）。
    pub remaining_fraction: f64,
    pub reset_at_ms: Option<i64>,
    pub countdown_seconds: Option<i64>,
}

/// 配额历史的一个模型序列。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaHistorySeries {
    pub email: String,
    /// JSON 里的模型 key（如 `claude-4-5` / `g3-pro`）。
    pub model_key: String,
    /// 显示名（如 `Claude`）。
    pub label: String,
    pub points: Vec<QuotaHistoryPoint>,
}

/// 一个渠道账号的落盘快照。
#[derive(Debug, Clone)]
pub struct AccountSnapshot {
    /// 文件名去 `.json`（可能是 uuid，含 `-`，过不了 `read_cockpit_file` 白名单）。
    pub id: String,
    pub email: String,
    pub display_name: String,
    /// 原始 JSON，按需取字段（各渠道字段名不统一）。
    pub json: serde_json::Value,
    /// 套餐/档位。**优先取自明文索引文件**（`<channel>_accounts.json`），
    /// 因为逐账号详情文件是 AES-256-GCM 密文，plan 永远读不出来。
    ///
    /// 依据(cockpit 源码,只读) `src-tauri/src/modules/secure_account_storage.rs:1-5`：
    /// *"Index/summary files stay plaintext; only per-account detail JSON is encrypted
    /// at rest."* —— 本字段就是那条"明文索引"的接入点。
    /// **取不到一律 `None`**（界面显示 `—`），绝不编造默认档位。
    pub plan: Option<String>,
}

/// 一个渠道的全部账号 —— `QuotaProvider::fetch` 的输入。
#[derive(Debug, Clone)]
pub struct ChannelAccounts {
    pub channel: String,
    /// cockpit 数据根（`~/.antigravity_cockpit`）。
    pub root: PathBuf,
    pub dir: PathBuf,
    pub accounts: Vec<AccountSnapshot>,
}

impl ChannelAccounts {
    /// 列目录 + 批量读（`<id>` 可能是 uuid，只能列目录，不能走文件名白名单）。
    pub fn load(root: &Path, channel: &str) -> Result<Self, String> {
        let dir = root.join(accounts_dir_name(channel));
        let mut accounts = Vec::new();
        if !dir.exists() {
            return Ok(Self {
                channel: channel.to_string(),
                root: root.to_path_buf(),
                dir,
                accounts,
            });
        }
        // ★ 先读**明文索引**（`<channel>_accounts.json`）拿套餐。逐账号详情文件是
        // AES-256-GCM 密文（`secure_account_storage.rs:1-5`），`plan_of(&json)` 在密文
        // 信封里永远找不到 `plan_type` / `plan_name` → 界面 Plan 列恒为 `—`。索引明文
        // 且就在目录旁边，是唯一能拿到套餐的地方。
        let index_plans = load_index_plans(root, channel);
        let entries = std::fs::read_dir(&dir).map_err(|e| format!("列 {} 失败: {e}", dir.display()))?;
        let mut names: Vec<String> = Vec::new();
        for entry in entries.flatten() {
            let name = match entry.file_name().into_string() {
                Ok(n) => n,
                Err(_) => continue,
            };
            if name.ends_with(".tmp") || name.ends_with(".bak") || !name.ends_with(".json") {
                continue;
            }
            names.push(name);
        }
        names.sort();
        for name in names {
            let path = dir.join(&name);
            let content = match std::fs::read_to_string(&path) {
                Ok(c) => c,
                Err(_) => continue,
            };
            let json: serde_json::Value = match serde_json::from_str(&content) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let id = name.trim_end_matches(".json").to_string();
            // 索引优先（明文、权威），详情兜底（详情仍是明文的老版本文件照样能用）。
            let plan = index_plans.get(&id).cloned().or_else(|| plan_of(&json));
            accounts.push(AccountSnapshot {
                email: first_str(&json, &["email", "accountEmail", "emailAddress"]),
                display_name: first_str(
                    &json,
                    &["display_name", "displayName", "name", "plan_name", "planName", "plan_type"],
                ),
                id,
                json,
                plan,
            });
        }
        Ok(Self {
            channel: channel.to_string(),
            root: root.to_path_buf(),
            dir,
            accounts,
        })
    }
}

/// 渠道探测结果（P1-13：不存在的渠道不占位）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelSummary {
    pub channel: String,
    pub account_count: usize,
    pub dir: String,
    pub has_accounts: bool,
    /// 是否吃 antigravity 60s 桌面缓存。
    pub uses_desktop_cache: bool,
    /// 该渠道声明的 `percentage` 语义（`remaining` / `used`）。
    pub percent_kind: Option<PercentKind>,
}

// ────────────────────────────── 缓存 ──────────────────────────────

/// 目录里的一个 JSON 文件（**不缓存原始字符串**：结构化前才允许进缓存）。
#[derive(Debug, Clone)]
pub struct DirFile {
    /// 文件名（含 `.json`）。桌面缓存的文件名 = `sha256(email)`，账号文件加密时
    /// 它就是唯一可用的账号标识（见 `SnapshotProvider::fetch` 路径 ④）。
    pub name: String,
    pub content: String,
}

/// 缓存结果。`cache_hit = true` 表示这次**没有**重读磁盘。
#[derive(Debug, Clone)]
pub struct Cached<T> {
    pub value: T,
    pub error: Option<String>,
    /// 实际文件读取时刻；命中缓存或刷新失败时保持不变。
    pub fetched_at_ms: i64,
    /// 本次是否命中缓存（未重读磁盘）。当前只有单测读它（断言 60s TTL 行为）。
    #[allow(dead_code)]
    pub cache_hit: bool,
}

// `HashMap::new()` 不是 const fn，静态初始化必须走 `LazyLock`（T14 worker 被限流中断时留下的
// 编译错误，主理人补修：rustc 1.97 直接支持 `std::sync::LazyLock`）。
/// 目录缓存的存储形态：`缓存键 -> (首次读取时刻 ms, 文件原文列表)`。
///
/// 抽别名一是消 `clippy::type_complexity`，二是避免同一串三层泛型在三个静态上各写一遍。
type DirFileCache = LazyLock<Mutex<HashMap<String, (i64, Vec<DirFile>)>>>;

static DESKTOP_CACHE: DirFileCache = LazyLock::new(|| Mutex::new(HashMap::new()));
static HISTORY_CACHE: DirFileCache = LazyLock::new(|| Mutex::new(HashMap::new()));
static SNAPSHOT_CACHE: DirFileCache = LazyLock::new(|| Mutex::new(HashMap::new()));

/// 列目录 + 全读，按 TTL 缓存**文件原文**；解析结果另外缓存在上层。
///
/// 目录不存在 → 返回空 Vec（不是 Err）："没装这个渠道"是正常的，不该报错。
fn load_dir_files(root: &Path, subdir: &str) -> Result<Vec<DirFile>, String> {
    let dir = root.join(subdir);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("列 {subdir} 失败: {e}"))?;
    let mut names: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let name = match entry.file_name().into_string() {
            Ok(n) => n,
            Err(_) => continue,
        };
        if name.ends_with(".tmp") || name.ends_with(".bak") || !name.ends_with(".json") {
            continue;
        }
        names.push(name);
    }
    names.sort();
    let mut out = Vec::new();
    for name in names {
        let path = dir.join(&name);
        if let Ok(content) = std::fs::read_to_string(&path) {
            out.push(DirFile { name, content });
        }
    }
    Ok(out)
}

/// 带 TTL 的读目录。命中缓存时 `Cached::fetched_at_ms` **保持不变**。
///
/// 过期后重读；**重读失败时降级返回旧值**（stale），不把"刷新失败"变成"数据消失"。
/// stale 分支保留原读取时刻并透传刷新错误。
fn cached_dir_files(
    cache: &Mutex<HashMap<String, (i64, Vec<DirFile>)>>,
    root: &Path,
    subdir: &str,
    ttl_ms: i64,
    now_ms: i64,
) -> Result<Cached<Vec<DirFile>>, String> {
    let key = format!("{}|{subdir}", root.display());
    let mut guard = cache.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((fetched_at, value)) = guard.get(&key) {
        if now_ms - *fetched_at < ttl_ms {
            return Ok(Cached {
                value: value.clone(),
                error: None,
                fetched_at_ms: *fetched_at,
                cache_hit: true,
            });
        }
    }
    match load_dir_files(root, subdir) {
        Ok(files) => {
            guard.insert(key, (now_ms, files.clone()));
            Ok(Cached {
                value: files,
                error: None,
                fetched_at_ms: now_ms,
                cache_hit: false,
            })
        }
        Err(e) => match guard.get(&key) {
            Some((fetched_at, value)) => Ok(Cached {
                value: value.clone(),
                error: Some(e),
                fetched_at_ms: *fetched_at,
                cache_hit: true,
            }),
            None => Err(e),
        },
    }
}

/// 读 antigravity 桌面配额缓存（TTL 60s，对齐 cockpit 自己的 TTL）。
pub fn cached_desktop_files(root: &Path, now_ms: i64) -> Result<Cached<Vec<DirFile>>, String> {
    cached_dir_files(&DESKTOP_CACHE, root, SUBDIR_QUOTA_DESKTOP, TTL_DESKTOP_CACHE_MS, now_ms)
}

/// 读配额历史（TTL 300s）。
pub fn cached_history_files(root: &Path, now_ms: i64) -> Result<Cached<Vec<DirFile>>, String> {
    cached_dir_files(&HISTORY_CACHE, root, SUBDIR_QUOTA_HISTORY, TTL_SNAPSHOT_MS, now_ms)
}

/// 读插件端配额缓存（TTL 60s）。
///
/// 当前 UI 还没接插件端配额面板（T14 只落了读取层），保留公开 API 并显式放行 dead_code。
#[allow(dead_code)]
pub fn cached_plugin_files(root: &Path, now_ms: i64) -> Result<Cached<Vec<DirFile>>, String> {
    cached_dir_files(&SNAPSHOT_CACHE, root, SUBDIR_QUOTA_PLUGIN, TTL_DESKTOP_CACHE_MS, now_ms)
}

/// 仅测试用：清空进程内缓存，避免用例之间互相污染。
#[cfg(test)]
fn clear_caches() {
    for cache in [&DESKTOP_CACHE, &HISTORY_CACHE, &SNAPSHOT_CACHE] {
        cache.lock().unwrap_or_else(|e| e.into_inner()).clear();
    }
}

// ────────────────────────────── JSON 小工具 ──────────────────────────────

/// 按顺序取第一个非空字符串字段。
fn first_str(json: &serde_json::Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(v) = json.get(*key).and_then(|v| v.as_str()) {
            if !v.trim().is_empty() {
                return v.trim().to_string();
            }
        }
    }
    String::new()
}

/// 取第一个数字字段（整数或浮点）。
fn first_num(json: &serde_json::Value, keys: &[&str]) -> Option<f64> {
    for key in keys {
        if let Some(v) = json.get(*key) {
            if let Some(n) = v.as_f64() {
                return Some(n);
            }
            if let Some(n) = v.as_i64() {
                return Some(n as f64);
            }
            if let Some(s) = v.as_str() {
                if let Ok(n) = s.trim().parse::<f64>() {
                    return Some(n);
                }
            }
        }
    }
    None
}

/// 数字保留现有毫秒口径；RFC3339 字符串自带时区。
///
/// ⚠️ 这里必须用 `continue` 而不是 `?`：早先写成 `json.get(*key)?`，`?` 会在**第一个键缺失时
/// 直接返回 None**，导致后面的候选键永远不被检查。实际后果是——凡是 reset 字段不是列表首位的
/// 渠道（例如 codex 用 `reset_at`，而列表首位是 `resetTime`）**静默丢掉重置时间**。
/// 单测 `codex_account_snapshot_windows_are_classified` 就是钉这个回归的。
fn first_ms(json: &serde_json::Value, keys: &[&str]) -> Option<i64> {
    for key in keys {
        let Some(v) = json.get(*key) else { continue };
        if let Some(n) = v.as_i64() {
            return Some(n);
        }
        if let Some(n) = v.as_f64() {
            return Some(n as i64);
        }
        if let Some(s) = v.as_str() {
            if let Ok(n) = s.trim().parse::<i64>() {
                return Some(n);
            }
            if let Ok(time) = chrono::DateTime::parse_from_rfc3339(s.trim()) {
                return Some(time.timestamp_millis());
            }
        }
    }
    None
}

/// 从键名猜窗口类型（只认显式命名，猜不出就 `Unknown` —— 不编造）。
fn window_kind_of(key: &str) -> QuotaWindowKind {
    let k = key.to_ascii_lowercase();
    if k.contains("five_hour") || k.contains("5h") || k.contains("hourly") || k.contains("fivehour")
    {
        QuotaWindowKind::FiveHour
    } else if k.contains("seven_day") || k.contains("7d") || k.contains("weekly") {
        QuotaWindowKind::Weekly
    } else if k.contains("month") {
        QuotaWindowKind::Monthly
    } else {
        QuotaWindowKind::Unknown
    }
}

/// 在一个 JSON 对象里找百分比字段，返回 `(字段名, 值, 语义)`。
/// 剩余类字段名优先；找不到再找已用类。**找不到返回 None（不是 0）**。
fn pick_percent(obj: &serde_json::Value) -> Option<(String, f64, PercentKind)> {
    const REMAINING_KEYS: &[&str] = &[
        "remainingFraction",
        "remainingPercentage",
        "remainingPercent",
        "remaining_percent",
        "remaining",
        "percentage",
        "percentRemaining",
    ];
    const USED_KEYS: &[&str] = &[
        "usedPercent",
        "usedPercentage",
        "used_percent",
        "used_percentage",
        "usagePercent",
        "percentUsed",
    ];
    for key in REMAINING_KEYS {
        if let Some(v) = obj.get(*key) {
            if let Some(n) = v.as_f64().or_else(|| v.as_i64().map(|i| i as f64)) {
                return Some(((*key).to_string(), n, PercentKind::Remaining));
            }
            // antigravity 的 remainingFraction 有时是 0..1 的小数
            if let Some(s) = v.as_str() {
                if let Ok(n) = s.trim().parse::<f64>() {
                    return Some(((*key).to_string(), n, PercentKind::Remaining));
                }
            }
        }
    }
    for key in USED_KEYS {
        if let Some(v) = obj.get(*key) {
            if let Some(n) = v.as_f64().or_else(|| v.as_i64().map(|i| i as f64)) {
                return Some(((*key).to_string(), n, PercentKind::Used));
            }
        }
    }
    None
}

/// 把 quota_summary 的 `bucketId`(如 `gemini-weekly`、`claude-five-hour`)映射到窗口类型,
/// 仅用于展示;**不参与计价、不参与 UI 排序**(P0-23:不准默认值兜底 —— `Unknown` 必须留)。
fn classify_window_kind_from_bucket(bucket_id: Option<&str>) -> QuotaWindowKind {
    let Some(id) = bucket_id else {
        return QuotaWindowKind::Unknown;
    };
    let lower = id.to_ascii_lowercase();
    if lower.contains("weekly") || lower.contains("seven_day") || lower.contains("week") {
        QuotaWindowKind::Weekly
    } else if lower.contains("five_hour")
        || lower.contains("five-hour")
        || lower.contains("hourly")
        || lower.contains("_hour")
        || lower.ends_with("hour")
        // 真实数据形态（2026-09-12 现场）：`gemini-5h` / `3p-5h` / `claude-5h`。
        // 上一版只认 `five-hour`/`...hour`，这两个都命中不了 → 5 小时窗口被判成 Unknown，
        // UI 上"周/5小时"分不出来。这里补上 `-5h` / `_5h` / 纯 `5h`。
        || lower.ends_with("-5h")
        || lower.ends_with("_5h")
        || lower == "5h"
    {
        QuotaWindowKind::FiveHour
    } else {
        QuotaWindowKind::Unknown
    }
}

/// `remainingFraction` 在 antigravity 桌面缓存里是 **0..1 的小数**，其余渠道是 0..100。
/// 这里按字段名 + 量级判定：字段名含 `Fraction` 且 |v| <= 1 → 乘 100。
fn scale_percent(raw: f64, field: &str) -> f64 {
    if field.to_ascii_lowercase().contains("fraction") && raw.abs() <= 1.0 {
        raw * 100.0
    } else {
        raw
    }
}

// ────────────────────────────── 抽取：账号快照 → 原始条目 ──────────────────────────────

/// 抽取出来的"未归一化"配额条目。
struct RawEntry {
    scope: &'static str,
    model_id: String,
    display_name: String,
    field: String,
    raw_percent: f64,
    reset_at_ms: Option<i64>,
    window_kind: QuotaWindowKind,
}

/// zcode 是绝对额度渠道（`quota_total` / `quota_used` / `quota_remaining`），
/// 没有百分比字段 → 用 remaining/total 现算，语义恒为"剩余"。
fn zcode_entry(json: &serde_json::Value) -> Option<RawEntry> {
    let total = first_num(json, &["quota_total", "quotaTotal"])?;
    let remaining = first_num(json, &["quota_remaining", "quotaRemaining"])?;
    if total <= 0.0 {
        return None;
    }
    Some(RawEntry {
        scope: "account",
        model_id: String::new(),
        display_name: String::new(),
        field: "quota_remaining".to_string(),
        raw_percent: (remaining / total) * 100.0,
        reset_at_ms: first_ms(json, &["reset_at", "resetAt", "resetTime"]),
        window_kind: QuotaWindowKind::Unknown,
    })
}

/// 从一个"容器"对象里抽条目：`{"models": {...}}` 按模型拆；带窗口键的按窗口拆；
/// 自身就是百分比对象的直接收一条。
fn entries_from_container(
    container: &serde_json::Value,
    window_hint: QuotaWindowKind,
) -> Vec<RawEntry> {
    let mut out = Vec::new();

    // 形态一：{ models: { <modelId>: { displayName?, quotaInfo|... } } }
    if let Some(models) = container.get("models").and_then(|v| v.as_object()) {
        let mut keys: Vec<&String> = models.keys().collect();
        keys.sort();
        for key in keys {
            let model = &models[key];
            let inner = model.get("quotaInfo").unwrap_or(model);
            let (field, raw, _) = match pick_percent(inner) {
                Some(v) => v,
                None => continue,
            };
            out.push(RawEntry {
                scope: "model",
                model_id: key.clone(),
                display_name: first_str(model, &["displayName", "display_name", "label", "name"]),
                field,
                raw_percent: raw,
                reset_at_ms: first_ms(inner, &["resetTime", "resetAt", "reset_at"]),
                window_kind: QuotaWindowKind::Unknown,
            });
        }
    }

    // 形态五（2026-09-12 补）：`quota_summary.groups[].buckets[]`
    //
    // **历史与根因**：cockpit 升级后把配额面板的数据源从
    //   `{ models: { <id>: { quotaInfo: { remainingFraction, ... } } } }`
    // 改成了现在的
    //   `{ quota_summary: { groups: [ { buckets: [ { bucketId, displayName,
    //                                              remainingFraction, resetTime } ] } ] } }`
    // 我们只认前者，导致 antigravity / gemini / antigravity_ide 全渠道**全账号都显示
    // "用量不可得"**(P0-21 验收⑤要求不静默变 0,设计如此;但底层是 schema 没跟上,
    // **不该**长期是这个状态 —— 用户看到的就是一整面"用量不可得")。
    // 修法:在这里补一组桶解析,一个 bucket 展开成一条 RawEntry:
    //   - `bucketId` → `model_id`(它是窗口标识,如 `gemini-weekly` / `five_hour`)
    //   - `displayName` → `display_name`
    //   - `remainingFraction` → `raw_percent`(0..1,标准化时 ×100 走 PercentKind::Remaining)
    //   - `resetTime` 字符串 → `reset_at_ms`(容错:ISO8601 解析失败就 None)
    if let Some(qs) = container.get("quota_summary").and_then(|v| v.as_object()) {
        if let Some(groups) = qs.get("groups").and_then(|v| v.as_array()) {
            for group in groups {
                let buckets = match group.get("buckets").and_then(|v| v.as_array()) {
                    Some(b) => b,
                    None => continue,
                };
                for bucket in buckets {
                    let raw = match bucket.get("remainingFraction").and_then(|v| v.as_f64()) {
                        Some(v) => v,
                        None => continue,
                    };
                    let bucket_id = bucket
                        .get("bucketId")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    let model_id = if let Some(id) = bucket_id.clone() {
                        if !id.is_empty() { id } else {
                            let fb = first_str(bucket, &["modelId", "model_id", "model"]);
                            if fb.is_empty() { "(unknown)".to_string() } else { fb }
                        }
                    } else {
                        let fb = first_str(bucket, &["modelId", "model_id", "model"]);
                        if fb.is_empty() { "(unknown)".to_string() } else { fb }
                    };
                    let bn = first_str(bucket, &["displayName", "display_name", "label"]);
                    let gn = first_str(group, &["displayName", "display_name", "label"]);
                    let display_name: String = if !bn.is_empty() {
                        bn
                    } else if !gn.is_empty() {
                        gn
                    } else {
                        String::new()
                    };
                    let reset_at_ms = first_ms(bucket, &["resetTimeMs", "reset_time_ms", "resetTime"]);
                    let window_kind = classify_window_kind_from_bucket(bucket_id.as_deref());
                    out.push(RawEntry {
                        scope: "pool",
                        model_id,
                        display_name,
                        field: "remainingFraction".to_string(),
                        raw_percent: raw,
                        reset_at_ms,
                        window_kind,
                    });
                }
            }
            if !out.is_empty() {
                return out;
            }
        }
    }

    if !out.is_empty() {
        return out;
    }

    // 形态二：自身就是百分比对象（含 remaining*/used* 字段）
    if let Some((field, raw, _)) = pick_percent(container) {
        out.push(RawEntry {
            scope: "account",
            model_id: first_str(container, &["modelId", "model_id", "model", "name"]),
            display_name: first_str(container, &["displayName", "display_name", "label"]),
            field,
            raw_percent: raw,
            reset_at_ms: first_ms(container, &["resetTime", "resetAt", "reset_at", "resetsAt"]),
            window_kind: window_hint,
        });
        return out;
    }

    // 形态三：按窗口键拆（codex / claude：five_hour / seven_day / hourly / weekly …）
    if let Some(obj) = container.as_object() {
        let mut keys: Vec<&String> = obj.keys().collect();
        keys.sort();
        for key in keys {
            let value = &obj[key];
            let inner = value
                .get("quotaInfo")
                .or_else(|| value.get("quota"))
                .unwrap_or(value);
            let (field, raw, _) = match pick_percent(inner) {
                Some(v) => v,
                None => continue,
            };
            let model_id = first_str(inner, &["modelId", "model_id", "model", "name"]);
            out.push(RawEntry {
                scope: "pool",
                model_id: if model_id.is_empty() { key.clone() } else { model_id },
                display_name: first_str(inner, &["displayName", "display_name", "label"]),
                field,
                raw_percent: raw,
                reset_at_ms: first_ms(
                    inner,
                    &["resetTime", "resetAt", "reset_at", "resetsAt", "reset_at_ms"],
                ),
                window_kind: window_kind_of(key),
            });
        }
    }
    out
}

/// 从账号 JSON 里按渠道字段表抽所有条目。
fn extract_entries(channel: &str, json: &serde_json::Value) -> Vec<RawEntry> {
    if channel == CH_CLAUDE {
        if let Some(raw) = json.get("claude_usage_raw") {
            let entries: Vec<_> = [
                ("five_hour", QuotaWindowKind::FiveHour),
                ("seven_day", QuotaWindowKind::Weekly),
                ("seven_day_sonnet", QuotaWindowKind::Weekly),
            ].into_iter().filter_map(|(key, window_kind)| {
                let window = raw.get(key)?;
                let used = window.get("utilization")?.as_f64()?;
                Some(RawEntry {
                    scope: "pool", model_id: key.into(), display_name: key.into(),
                    field: "used_percent".into(), raw_percent: used,
                    reset_at_ms: claude_reset_ms(&window["resets_at"]), window_kind,
                })
            }).collect();
            if !entries.is_empty() { return entries; }
        }
    }
    if channel == CH_ZCODE {
        if let Some(entry) = zcode_entry(json) {
            return vec![entry];
        }
    }
    let mut out = Vec::new();
    for field in raw_fields_of(channel) {
        let Some(value) = json.get(*field) else { continue };
        // 有些渠道把 JSON 存成字符串（如 cursor_usage_raw 是二次序列化的 JSON）
        let parsed: Option<serde_json::Value> = value.as_str().and_then(|s| serde_json::from_str(s).ok());
        let container = parsed.as_ref().unwrap_or(value);
        let arr = match container {
            serde_json::Value::Array(items) => items.clone(),
            other => vec![other.clone()],
        };
        for item in &arr {
            let mut entries = entries_from_container(item, QuotaWindowKind::Unknown);
            if entries.is_empty() {
                // 再往下一层找 `quota`（claude 的 { quota: { five_hour: {...} } }）
                if let Some(inner) = item.get("quota") {
                    entries = entries_from_container(inner, QuotaWindowKind::Unknown);
                }
            }
            out.extend(entries);
        }
        if !out.is_empty() {
            break;
        }
    }
    out
}

fn claude_reset_ms(value: &serde_json::Value) -> Option<i64> {
    if let Some(time) = value.as_str().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()) {
        return Some(time.timestamp_millis());
    }
    // Cockpit's native Claude parser accepts Unix seconds and already-millisecond values.
    let time = value.as_i64().or_else(|| value.as_str()?.parse::<i64>().ok())?;
    if time <= 0 { None } else if time > 10_000_000_000 { Some(time) }
    else { time.checked_mul(1000) }
}

// ────────────────────────────── API Key 类账号（§3.5） ──────────────────────────────

/// 返回 `Some(reason)` = 该账号被 cockpit **显式排除**订阅配额查询 → 用量不可得。
///
/// 覆盖 PRD §3.5 的三类：grok `api_key`、claude `ApiKey`/`DesktopGateway`、
/// windsurf `api_key`。
pub fn api_key_exclusion_reason(channel: &str, json: &serde_json::Value) -> Option<String> {
    let auth_mode = first_str(json, &["auth_mode", "authMode", "authType", "auth_type"]);
    let account_type = first_str(json, &["account_type", "accountType", "type"]);
    let badge = first_str(json, &["badge", "plan_badge"]);
    let is_api_key = account_type.eq_ignore_ascii_case("api_key")
        || account_type.eq_ignore_ascii_case("apikey")
        || badge.eq_ignore_ascii_case("API_KEY")
        || auth_mode.eq_ignore_ascii_case("api_key")
        || auth_mode.eq_ignore_ascii_case("apikey");
    match channel {
        CH_GROK if is_api_key => Some(
            "grok 的 api_key 类账号被 cockpit 显式排除订阅配额查询(PRD §3.5):用量不可得".to_string(),
        ),
        CH_CLAUDE
            if auth_mode.eq_ignore_ascii_case("ApiKey")
                || auth_mode.eq_ignore_ascii_case("DesktopGateway") =>
        {
            Some(format!(
                "claude 的 {auth_mode} 模式账号被 cockpit 显式排除订阅配额查询(PRD §3.5):用量不可得"
            ))
        }
        CH_WINDSURF if is_api_key => Some(
            "windsurf 的 api_key 类账号被 cockpit 显式排除订阅配额查询(PRD §3.5):用量不可得"
                .to_string(),
        ),
        _ => None,
    }
}

// ────────────────────────────── Provider ──────────────────────────────

/// 配额提供者。路径 B（快照）是默认实现；路径 A（实时上游）是可选增强。
///
/// **两者输出同一个 [`QuotaSnapshot`]，前端只看 `source` 字段** ——
/// A 的实现无法污染 B 的架构。
pub trait QuotaProvider {
    fn kind(&self) -> QuotaSourceKind;
    fn fetch(&self, ch: &ChannelAccounts) -> Result<Vec<QuotaSnapshot>, String>;
}

/// 路径 B（默认）：读 cockpit 落盘 JSON，零外网请求。
pub struct SnapshotProvider {
    pub now_ms: i64,
}

/// 路径 A（可选）：实时调上游。**本轮恒失败** —— 主理人拍板：不读凭证、不调上游 API。
///
/// 失败不是缺陷而是设计：由 [`fetch_with_fallback`] 降级到路径 B，前端拿到
/// `source='snapshot'` + 失败原因，不阻塞。
pub struct LiveApiProvider {
    /// 当前路径 A 恒失败（不调上游），这个时间戳只为将来接实时接口预留 —— 显式放行 dead_code。
    #[allow(dead_code)]
    pub now_ms: i64,
}

/// antigravity 桌面缓存里的一条（已按 email 索引）。
///
/// **`id` 是必须的**：实测文件名 = `sha256(email)`（`31a42606…` 双侧吻合），
/// 所以当账号文件被加密、账号侧 email 读不到时（见 [`SnapshotProvider::fetch`] 的路径 ④），
/// 要用它当账号标识 —— 否则前端拿到一批 `account_id` 为空的行，无法归因也无法稳定排序。
struct DesktopEntry {
    /// 文件名去 `.json`。cockpit 当前实现 = `sha256(email)`。
    id: String,
    email: String,
    updated_at_ms: Option<i64>,
    entries: Vec<RawEntry>,
}

/// 解析桌面缓存文件：`{ email, updatedAt, payload: { models: { <id>: { quotaInfo } } } }`。
fn parse_desktop_file(file: &DirFile) -> Option<DesktopEntry> {
    let json: serde_json::Value = serde_json::from_str(&file.content).ok()?;
    let email = first_str(&json, &["email"]);
    let payload = json.get("payload").unwrap_or(&json);
    let entries = entries_from_container(payload, QuotaWindowKind::Unknown);
    let id = file.name.trim_end_matches(".json").to_string();
    Some(DesktopEntry {
        id: if id.is_empty() { email.clone() } else { id },
        email,
        updated_at_ms: first_ms(&json, &["updatedAt", "updated_at", "updatedAtMs"]),
        entries,
    })
}

impl QuotaProvider for SnapshotProvider {
    fn kind(&self) -> QuotaSourceKind {
        QuotaSourceKind::Snapshot
    }

    fn fetch(&self, ch: &ChannelAccounts) -> Result<Vec<QuotaSnapshot>, String> {
        // 语义未声明 → 直接失败（P0-23:禁止默认值兜底）
        let declared = percent_semantics_of(&ch.channel).ok_or_else(|| {
            format!("渠道 {} 未声明 percentage 语义,拒绝出数(P0-23)", ch.channel)
        })?;
        let _ = declared;

        // Google 系优先吃 60s 桌面缓存（比账号快照新）
        let desktop_cache = if uses_desktop_cache(&ch.channel) {
            Some(cached_desktop_files(&ch.root, self.now_ms)?)
        } else { None };
        let desktop: Vec<DesktopEntry> = desktop_cache.as_ref().map(|cache|
            cache.value.iter().filter_map(parse_desktop_file).collect()).unwrap_or_default();

        // 桌面缓存是 Google 系配额的**权威来源**（cockpit 自己 60s 刷一次）。
        // 但账号文件可能整体加密 —— 实测 `accounts/` 与 `*_accounts/` 下只剩
        // `{version,kind,algorithm,key_id,nonce,ciphertext,encrypted_at}`，**没有 email**。
        // 于是 `acct.email` 恒为 ""，路径 ② 的 `d.email == acct.email` 永远不成立，
        // 11 份自包含（自带 email + quota）的明文缓存被整批丢弃 —— UI 看到的就是一整面
        // "用量不可得"。所以只要桌面缓存非空，它就是该渠道配额的权威源。
        let desktop_is_authoritative = !desktop.is_empty();
        // 记录哪些桌面缓存条目已被账号循环消费，路径 ④ 只补剩下的。
        let mut consumed: Vec<bool> = vec![false; desktop.len()];

        let mut out = Vec::new();
        for acct in &ch.accounts {
            // ① API Key 类账号 → 标注型空值（**不是 0**）
            if let Some(reason) = api_key_exclusion_reason(&ch.channel, &acct.json) {
                out.push(QuotaSnapshot::unavailable(
                    &ch.channel,
                    &acct.id,
                    &acct.email,
                    &acct.display_name,
                    reason,
                    self.kind(),
                    self.now_ms,
                    SUBDIR_QUOTA_DESKTOP,
                    acct.plan.clone(),
                ));
                continue;
            }

            // ② 桌面缓存命中（按 email 反关联，不算 sha256）
            let hit = if !acct.email.is_empty() {
                desktop
                    .iter()
                    .position(|d| !d.email.is_empty() && d.email == acct.email)
            } else {
                None
            };
            if let Some(idx) = hit {
                consumed[idx] = true;
                let d = &desktop[idx];
                let updated_at = d.updated_at_ms;
                for entry in &d.entries {
                    out.push(self.build(
                        ch,
                        acct,
                        entry,
                        updated_at,
                        SUBDIR_QUOTA_DESKTOP,
                        TTL_DESKTOP_CACHE_MS,
                    )?);
                }
                continue;
            }

            // ③ 退到账号快照字段
            let entries = extract_entries(&ch.channel, &acct.json);
            if entries.is_empty() {
                // 桌面缓存是权威源、且这个账号身份不可得（文件加密）→ **不在此处造
                // "用量不可得"噪音**：一个连自己是谁都不知道的账号，报"用量不可得"
                // 是假信息（真正的原因是身份读不到，不是用量读不到）。交给 ④ 用
                // 桌面缓存统一出数；桌面缓存里确实没有它，那才是不出数。
                if desktop_is_authoritative && acct.email.is_empty() {
                    continue;
                }
                out.push(QuotaSnapshot::unavailable(
                    &ch.channel,
                    &acct.id,
                    &acct.email,
                    &acct.display_name,
                    format!(
                        "账号快照里没有 {} 字段(该渠道可能尚未刷新过用量):用量不可得",
                        raw_fields_of(&ch.channel).join(" / ")
                    ),
                    self.kind(),
                    self.now_ms,
                    "AccountSnapshot",
                    acct.plan.clone(),
                ));
                continue;
            }
            let claude_error = ch.channel == CH_CLAUDE && acct.json.get("quota_error").is_some_and(|v| !v.is_null());
            let updated_at = if claude_error { None }
                else if ch.channel == CH_CLAUDE {
                    first_ms(&acct.json, &["usage_updated_at", "updatedAt", "updated_at", "updatedAtMs"])
                } else { first_ms(&acct.json, &["updatedAt", "updated_at", "updatedAtMs"]) };
            for entry in entries {
                let mut row = self.build(ch, acct, &entry, updated_at, "AccountSnapshot", TTL_SNAPSHOT_MS)?;
                if claude_error {
                    row.source_error = Some("Claude quota refresh failed; retained snapshot time is unverified".into());
                    row.stale = true;
                }
                out.push(row);
            }
        }

        // ④ 桌面缓存自包含补出（2026-09-12 修：账号文件加密时的唯一出数路径）
        //
        // **为什么需要它**：账号侧 email 不可得时，上面 ② 匹配不上、③ 读不到快照字段，
        // 结果是 cockpit 明明刷了 11 份带 `quota_summary` 的明文缓存，我们却一条都出不来。
        // 而桌面缓存文件**自己就带 email** —— 它不需要跟账号关联，是自包含的。
        // 所以这里直接以它为主体出数：账号标识用它自己的文件名（= sha256(email)），
        // 邮箱用它自己的 email 字段。这比"拿加密账号 id 去猜"诚实得多。
        for (idx, d) in desktop.iter().enumerate() {
            if consumed[idx] || d.email.is_empty() || d.entries.is_empty() {
                continue;
            }
            let acct = AccountSnapshot {
                id: d.id.clone(),
                email: d.email.clone(),
                display_name: String::new(),
                json: serde_json::Value::Null,
                // 桌面缓存条目自带 email 但**不带套餐** → 如实 None（界面 `—`），
                // 绝不拿渠道名/默认档位顶替。
                plan: None,
            };
            for entry in &d.entries {
                out.push(self.build(
                    ch,
                    &acct,
                    entry,
                    d.updated_at_ms,
                    SUBDIR_QUOTA_DESKTOP,
                    TTL_DESKTOP_CACHE_MS,
                )?);
            }
        }
        if let Some(cache) = desktop_cache {
            for row in &mut out {
                if row.raw_kind == SUBDIR_QUOTA_DESKTOP {
                    row.fetched_at_ms = cache.fetched_at_ms;
                    row.source_error = cache.error.clone();
                    row.stale |= cache.error.is_some();
                }
            }
        }
        Ok(out)
    }
}

impl SnapshotProvider {
    /// 原始条目 → 归一化快照。**`normalize_percent` 是唯一的翻转点**。
    fn build(
        &self,
        ch: &ChannelAccounts,
        acct: &AccountSnapshot,
        entry: &RawEntry,
        updated_at_ms: Option<i64>,
        raw_kind: &str,
        ttl_ms: i64,
    ) -> Result<QuotaSnapshot, String> {
        let kind = resolve_semantics(&ch.channel, &entry.field)?;
        let scaled = scale_percent(entry.raw_percent, &entry.field);
        let percent = normalize_percent(scaled, kind)?;
        let remaining = percent / 100.0;
        let stale = updated_at_ms.is_some_and(|u| u + ttl_ms < self.now_ms);
        Ok(QuotaSnapshot {
            channel: ch.channel.clone(),
            account_id: acct.id.clone(),
            email: acct.email.clone(),
            model_id: entry.model_id.clone(),
            scope: entry.scope.into(),
            display_name: entry.display_name.clone(),
            percent: Some(percent),
            remaining_fraction: Some(remaining),
            used_fraction: Some(1.0 - remaining),
            percent_kind: Some(kind),
            unavailable_reason: None,
            window_kind: entry.window_kind,
            window_started_at_ms: None,
            reset_at_ms: entry.reset_at_ms,
            source: QuotaSourceKind::Snapshot,
            fetched_at_ms: self.now_ms,
            updated_at_ms,
            stale,
            raw_kind: raw_kind.to_string(),
            source_error: None,
            plan: acct.plan.clone(),
        })
    }
}

impl QuotaProvider for LiveApiProvider {
    fn kind(&self) -> QuotaSourceKind {
        QuotaSourceKind::Live
    }

    /// 本轮不读凭证、不调上游 API（主理人拍板，合规考量）→ **恒失败**，由
    /// [`fetch_with_fallback`] 降级到路径 B。等解禁时只改这一处。
    fn fetch(&self, ch: &ChannelAccounts) -> Result<Vec<QuotaSnapshot>, String> {
        Err(format!(
            "{} 的实时配额接口未启用:本轮不读凭证、不调上游 API(主理人拍板)",
            ch.channel
        ))
    }
}

/// 路径 A 优先，失败自动降级到路径 B。返回值 = (快照, A 的失败原因)。
///
/// 失败**不阻塞**：前端拿到 B 的快照 + `live_error` 提示即可。
pub fn fetch_with_fallback<P: QuotaProvider>(
    live: &LiveApiProvider,
    fallback: &P,
    ch: &ChannelAccounts,
) -> Result<(Vec<QuotaSnapshot>, Option<String>), String> {
    match live.fetch(ch) {
        Ok(rows) => Ok((rows, None)),
        Err(reason) => {
            let rows = fallback.fetch(ch)?;
            Ok((rows, Some(reason)))
        }
    }
}

// ────────────────────────────── 配额历史 ──────────────────────────────

/// 解析配额历史目录：`{ email, updatedAt, models: { <key>: { label, points: [...] } } }`。
///
/// `email` 为空时返回全部；否则只返回该邮箱的序列（**按 JSON 内 email 反关联**）。
pub fn quota_history_series(
    root: &Path,
    email: Option<&str>,
    now_ms: i64,
) -> Result<Vec<QuotaHistorySeries>, String> {
    let files = cached_history_files(root, now_ms)?.value;
    let mut out = Vec::new();
    for file in &files {
        let json: serde_json::Value = match serde_json::from_str(&file.content) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let file_email = first_str(&json, &["email"]);
        if let Some(want) = email {
            if !want.is_empty() && file_email != want {
                continue;
            }
        }
        let updated_at = first_ms(&json, &["updatedAt", "updated_at"]);
        let Some(models) = json.get("models").and_then(|v| v.as_object()) else {
            continue;
        };
        let mut keys: Vec<&String> = models.keys().collect();
        keys.sort();
        for key in keys {
            let model = &models[key];
            let mut points = Vec::new();
            if let Some(arr) = model.get("points").and_then(|v| v.as_array()) {
                for point in arr {
                    let ts = match first_ms(point, &["timestamp", "timestampMs", "t"]) {
                        Some(t) => t,
                        None => continue,
                    };
                    let raw = match first_num(
                        point,
                        &[
                            "remainingPercentage",
                            "remainingPercent",
                            "remaining_percent",
                            "percentage",
                        ],
                    ) {
                        Some(v) => v,
                        None => continue,
                    };
                    let remaining = match normalize_percent(raw, PercentKind::Remaining) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    let countdown = first_num(point, &["countdownSeconds", "countdown_seconds"])
                        .map(|c| c as i64);
                    let reset_at = first_ms(point, &["resetTime", "resetAt", "reset_at"]).or_else(|| {
                        countdown.and_then(|c| updated_at.or(Some(ts)).map(|base| base + c * 1000))
                    });
                    points.push(QuotaHistoryPoint {
                        timestamp_ms: ts,
                        remaining_percentage: raw,
                        remaining_fraction: remaining / 100.0,
                        reset_at_ms: reset_at,
                        countdown_seconds: countdown,
                    });
                }
            }
            points.sort_by_key(|p| p.timestamp_ms);
            out.push(QuotaHistorySeries {
                email: file_email.clone(),
                model_key: key.clone(),
                label: first_str(model, &["label", "displayName", "display_name", "name"]),
                points,
            });
        }
    }
    out.sort_by(|a, b| a.email.cmp(&b.email).then_with(|| a.model_key.cmp(&b.model_key)));
    Ok(out)
}

// ────────────────────────────── 命令 ──────────────────────────────

/// cockpit 数据根目录（`~/.antigravity_cockpit`）。
pub fn cockpit_root() -> Result<PathBuf, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map_err(|_| "无法定位用户主目录(USERPROFILE/HOME 均未设置)".to_string())?;
    Ok(PathBuf::from(home).join(".antigravity_cockpit"))
}

/// 命令 1：探测哪些渠道有账号（P1-13：没账号的渠道不占位）。
#[tauri::command]
pub fn quota_list_channels() -> Result<Vec<ChannelSummary>, String> {
    let root = cockpit_root()?;
    let now_ms = chrono_like_now_ms();
    let mut out = Vec::new();
    for channel in ALL_CHANNELS {
        let accounts = ChannelAccounts::load(&root, channel)?;
        out.push(ChannelSummary {
            channel: (*channel).to_string(),
            account_count: accounts.accounts.len(),
            dir: accounts.dir.to_string_lossy().to_string(),
            has_accounts: !accounts.accounts.is_empty(),
            uses_desktop_cache: uses_desktop_cache(channel),
            percent_kind: percent_semantics_of(channel),
        });
    }
    let _ = now_ms;
    Ok(out)
}

/// 命令 2：读某渠道的配额快照（路径 B，零外网请求；60s / 300s 缓存）。
#[tauri::command]
pub fn quota_snapshots(channel: String) -> Result<Vec<QuotaSnapshot>, String> {
    let root = cockpit_root()?;
    let accounts = ChannelAccounts::load(&root, &channel)?;
    let provider = SnapshotProvider {
        now_ms: chrono_like_now_ms(),
    };
    provider.fetch(&accounts)
}

/// 命令 3：路径 A（实时）优先，失败自动降级到路径 B。
///
/// 返回 `{ snapshots, liveError, source }` —— `liveError` 非空表示已降级，
/// 前端应提示"实时刷新失败，显示的是落盘快照"。
#[tauri::command]
pub fn quota_refresh(channel: String) -> Result<serde_json::Value, String> {
    let root = cockpit_root()?;
    let accounts = ChannelAccounts::load(&root, &channel)?;
    let now_ms = chrono_like_now_ms();
    let live = LiveApiProvider { now_ms };
    let fallback = SnapshotProvider { now_ms };
    let (snapshots, live_error) = fetch_with_fallback(&live, &fallback, &accounts)?;
    let source = snapshots
        .first()
        .map(|s| s.source)
        .unwrap_or(QuotaSourceKind::Snapshot);
    Ok(serde_json::json!({
        "snapshots": snapshots,
        "liveError": live_error,
        "source": source,
        "fetchedAtMs": now_ms,
    }))
}

/// 命令 4：读配额历史时间序列（cockpit 百分比进度条的数据源）。
/// `email` 为空 → 返回全部邮箱的序列。
#[tauri::command]
pub fn quota_history(email: String) -> Result<Vec<QuotaHistorySeries>, String> {
    let root = cockpit_root()?;
    let filter = if email.trim().is_empty() { None } else { Some(email.trim()) };
    quota_history_series(&root, filter, chrono_like_now_ms())
}

// ──────────────────── 命令 5/6：当前账号 + 模型分组 ────────────────────

/// 来源标识：`provider_current_accounts.json`（cockpit 桌面端主源）。
const SRC_PROVIDER_CURRENT_ACCOUNTS: &str = "provider_current_accounts";
/// 来源标识：`antigravity_runtime_current_accounts.json`（外部运行时插件写入）。
const SRC_ANTIGRAVITY_RUNTIME: &str = "antigravity_runtime";

/// 「当前账号」一条记录。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CurrentAccountEntry {
    /// 文件里的原始 key，**原样保留，不做任何 normalize**（避免丢平台）。
    pub platform: String,
    /// 账号 id。
    pub account_id: String,
    /// 来源标识：`"provider_current_accounts"` 或 `"antigravity_runtime"`。
    pub source: String,
}

/// 模型分组配置（group_settings.json）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelGroups {
    /// 是否读到了文件。false 时其余字段全空。
    pub available: bool,
    /// modelId → groupId
    pub mappings: HashMap<String, String>,
    /// groupId → 显示名
    pub names: HashMap<String, String>,
    /// groupId 顺序
    pub order: Vec<String>,
    /// 文件里的 updatedAt（毫秒）。缺失 = None。
    pub updated_at_ms: Option<i64>,
    /// 文件里的 updatedBy。缺失 = None。
    pub updated_by: Option<String>,
}

/// 读一个"可选"的 JSON 文件。
///
/// - 文件不存在（`ErrorKind::NotFound`）→ `Ok(None)`，**不是错误**（只是这个源不存在）
/// - 存在但 JSON 解析失败 → `Err`（要能看到原因，不许静默吞掉）
/// - 其它 IO 错误 → `Err`
fn read_optional_json(path: &Path) -> Result<Option<serde_json::Value>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str::<serde_json::Value>(&text)
            .map(Some)
            .map_err(|e| format!("解析 {} 失败: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("读取 {} 失败: {e}", path.display())),
    }
}

/// 从「平台 → 账号 id」映射里收集条目。
///
/// 用 `serde_json::Value` 手工取字段，**不定义会 panic 的反序列化结构体**：
/// 这两个文件由外部写入，可能是残缺形态。非字符串值直接跳过，不 panic。
fn collect_current_accounts(
    json: &serde_json::Value,
    map_keys: &[&str],
    source: &str,
    out: &mut Vec<CurrentAccountEntry>,
) {
    let Some(map) = map_keys
        .iter()
        .find_map(|k| json.get(*k).and_then(|v| v.as_object()))
    else {
        return;
    };
    for (platform, account) in map {
        let Some(account_id) = account.as_str() else {
            continue;
        };
        if account_id.trim().is_empty() {
            continue;
        }
        out.push(CurrentAccountEntry {
            platform: platform.clone(),
            account_id: account_id.to_string(),
            source: source.to_string(),
        });
    }
}

/// 读 cockpit 的「当前账号」映射（两个文件合并）。
///
/// - 单个文件不存在 → 该源不贡献，**不是错误**
/// - 两个都不存在 → 返回**空 Vec**（不是 Err）
/// - 文件存在但 JSON 解析失败 → 返回 Err（要能看到原因）
///
/// 平台 key **原样保留**：cockpit 写入时经 `normalize_platform()`
/// （只读参考 `cockpit-tools-main/src-tauri/src/modules/provider_current_state.rs:29-49`）校验，
/// 但**读时不做限制** ⇒ key 是开放集合，我们也不做白名单，否则会丢平台。
pub fn read_current_accounts(root: &Path) -> Result<Vec<CurrentAccountEntry>, String> {
    let mut out = Vec::new();

    // 源 A：provider_current_accounts.json —— cockpit 桌面端主源。
    // 结构依据 provider_current_state.rs:6-14：
    //   { "version": "1.0", "current_accounts": { "<平台>": "<账号 id>" } }
    let file_a = root.join("provider_current_accounts.json");
    if let Some(json) = read_optional_json(&file_a)? {
        collect_current_accounts(
            &json,
            &["current_accounts", "currentAccounts"],
            SRC_PROVIDER_CURRENT_ACCOUNTS,
            &mut out,
        );
    }

    // 源 B：antigravity_runtime_current_accounts.json —— **由外部运行时插件写入**
    // （在 cockpit 源码里 grep 不到，故来源单独标注为 antigravity_runtime）。
    // 本机实测结构：{ "currentAccounts": { "antigravity": "<uuid>" } }
    let file_b = root.join("antigravity_runtime_current_accounts.json");
    if let Some(json) = read_optional_json(&file_b)? {
        collect_current_accounts(
            &json,
            &["currentAccounts", "current_accounts"],
            SRC_ANTIGRAVITY_RUNTIME,
            &mut out,
        );
    }

    // 排序只影响顺序、不影响内容：HashMap 迭代序不稳定，固定下来便于前端与测试断言。
    out.sort_by(|a, b| {
        a.platform
            .cmp(&b.platform)
            .then_with(|| a.source.cmp(&b.source))
    });
    Ok(out)
}

/// 命令 5：读 cockpit 的「当前账号」映射（两个文件合并）。
#[tauri::command]
pub fn quota_current_accounts() -> Result<Vec<CurrentAccountEntry>, String> {
    read_current_accounts(&cockpit_root()?)
}

/// 读 `group_settings.json` 里的字符串映射（`modelId`/`groupId` → 字符串）。
fn read_str_map(json: &serde_json::Value, key: &str) -> HashMap<String, String> {
    json.get(key)
        .and_then(|v| v.as_object())
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

/// 读 cockpit 的模型分组配置。
///
/// ★ 红线：`group_settings.json` **不存在时绝不套用 cockpit 的默认分组**。
///
/// cockpit 的 `GroupSettings::default()`
/// （只读参考 `cockpit-tools-main/src-tauri/src/modules/group_settings.rs:71-120`）
/// 会兜底出 Claude 4.5 / Gemini Pro / Gemini Flash 三组。**我们不要复制那套默认值**：
/// ① 那是 cockpit 的业务默认值，复制过来会「改一处忘一处」地静默漂移；
/// ② 我们展示的是「落盘的事实」，不是「cockpit 会怎么兜底」。
/// 文件不存在 → `available: false`，前端显示「未配置」。
pub fn read_model_groups(root: &Path) -> Result<ModelGroups, String> {
    let Some(json) = read_optional_json(&root.join("group_settings.json"))? else {
        return Ok(ModelGroups {
            available: false,
            mappings: HashMap::new(),
            names: HashMap::new(),
            order: Vec::new(),
            updated_at_ms: None,
            updated_by: None,
        });
    };

    // 结构依据 group_settings.rs:47-69（#[serde(rename_all = "camelCase")]）：
    //   groupMappings / groupNames / groupOrder / updatedAt / updatedBy
    let order = json
        .get("groupOrder")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();

    Ok(ModelGroups {
        available: true,
        mappings: read_str_map(&json, "groupMappings"),
        names: read_str_map(&json, "groupNames"),
        order,
        updated_at_ms: first_ms(&json, &["updatedAt"]),
        updated_by: json
            .get("updatedBy")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    })
}

/// 命令 6：模型分组配置（group_settings.json）。
#[tauri::command]
pub fn quota_model_groups() -> Result<ModelGroups, String> {
    read_model_groups(&cockpit_root()?)
}

// ──────────────────── 命令 7：账号分组 ────────────────────

/// 一个账号分组（cockpit `account_groups.json` / `codex_account_groups.json`）。
///
/// 结构依据（**只读参考** cockpit 源码）：
/// - 通用：`src/services/accountGroupService.ts:16-21` → `{id, name, accountIds, createdAt}`
/// - Codex 专用：`src/services/codexAccountGroupService.ts:31-42` → 同上，但另有
///   `sortOrder` 与 `quotaAutoRefreshMinutes`。那两个字段与「账号属于哪个分组」无关，
///   **本列不接**（分组级配额刷新是另一个维度，要做另开）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountGroupEntry {
    pub id: String,
    pub name: String,
    /// 该分组包含的账号 id。**可能含已删除账号** —— cockpit 自己用
    /// `accountById.has(id)` 过滤（`WakeupTasksPage.tsx:813`）。我们只做
    /// "账号 → 分组名"的正向查询，不存在的账号自然不会命中，无需额外过滤。
    pub account_ids: Vec<String>,
    pub created_at_ms: Option<i64>,
}

/// 账号分组配置。**两个来源分开返回，不合并**。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountGroups {
    /// 通用分组 `account_groups.json` 是否读到。
    pub available: bool,
    /// 通用分组：可装任何渠道的账号，且**一个账号可属于多个分组**
    /// （cockpit `WakeupTasksPage.tsx:789-800` 的 `groupIdsByAccountId` 是 `string[]`）。
    pub groups: Vec<AccountGroupEntry>,
    /// Codex 专用分组 `codex_account_groups.json` 是否读到。
    pub codex_available: bool,
    /// Codex 专用分组：只装 Codex 账号，且 cockpit 侧是 `find()` 取**第一个**命中的分组
    /// （`codexAccountGroupService.ts:122`）⇒ 实际是一对一。
    pub codex_groups: Vec<AccountGroupEntry>,
}

/// 解析一个分组数组。缺 `id` 或 `name` 的条目**整条跳过** ——
/// 没有标识的分组无法展示，也绝不给它编个名字。
fn parse_account_groups(json: &serde_json::Value) -> Vec<AccountGroupEntry> {
    let Some(arr) = json.as_array() else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|item| {
            let obj = item.as_object()?;
            let id = obj.get("id").and_then(|v| v.as_str()).unwrap_or("").trim();
            if id.is_empty() {
                return None;
            }
            let name = obj.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
            if name.is_empty() {
                return None;
            }
            let account_ids = obj
                .get("accountIds")
                .and_then(|v| v.as_array())
                .map(|ids| {
                    ids.iter()
                        .filter_map(|v| v.as_str())
                        .map(|s| s.to_string())
                        .filter(|s| !s.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            Some(AccountGroupEntry {
                id: id.to_string(),
                name: name.to_string(),
                account_ids,
                created_at_ms: first_ms(item, &["createdAt"]),
            })
        })
        .collect()
}

/// 读 cockpit 的账号分组（两个**独立**来源）。
///
/// ★ 为什么不把两个来源合成一个列表：它们是两套不相干的机制 ——
/// `account_groups.json` 是通用分组（可装任何渠道的账号、一个账号可属于多个），
/// `codex_account_groups.json` 只装 Codex 账号。合并会让同一个账号被算进两套无关的组。
/// 展示层按渠道选来源，或两边都查后去重（见前端 `groupLabelsFor`）。
///
/// 文件不存在 → 对应 `*_available: false`（**不是错误**，只是用户没建过分组）；
/// 坏 JSON → Err（要能看到原因）。
pub fn read_account_groups(root: &Path) -> Result<AccountGroups, String> {
    let (available, groups) = match read_optional_json(&root.join("account_groups.json"))? {
        Some(json) => (true, parse_account_groups(&json)),
        None => (false, Vec::new()),
    };
    let (codex_available, codex_groups) =
        match read_optional_json(&root.join("codex_account_groups.json"))? {
            Some(json) => (true, parse_account_groups(&json)),
            None => (false, Vec::new()),
        };
    Ok(AccountGroups {
        available,
        groups,
        codex_available,
        codex_groups,
    })
}

/// 命令 7：账号分组（account_groups.json + codex_account_groups.json）。
#[tauri::command]
pub fn quota_account_groups() -> Result<AccountGroups, String> {
    read_account_groups(&cockpit_root()?)
}

/// 当前时间（epoch ms）。不引 chrono 依赖：SystemTime 足够。
pub fn chrono_like_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ────────────────────────────── 测试 ──────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// 不进账本自检的"针"：拆开写，避免本文件源码里出现完整字符串导致自检永远失败。
    const LEDGER_WRITE_PREFIX: &str = "INSERT INTO";
    const LEDGER_FACT_TABLE: &str = "usage_rollup";

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("cockpit_quota_{tag}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }

    fn write_json(path: &Path, json: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("建父目录");
        }
        std::fs::write(path, json).expect("写文件");
    }

    fn hex64(seed: u8) -> String {
        format!("{seed:02x}").repeat(32)
    }

    // ── 归一化 ──

    #[test]
    fn remaining_semantics_passes_through() {
        assert_eq!(normalize_percent(80.0, PercentKind::Remaining).unwrap(), 80.0);
        assert_eq!(normalize_percent(0.0, PercentKind::Remaining).unwrap(), 0.0);
        assert_eq!(normalize_percent(100.0, PercentKind::Remaining).unwrap(), 100.0);
    }

    /// ★ P0-23 核心：grok 的"已用%"必须被翻转成"剩余%"，且 `percent_kind` 标记为 used。
    #[test]
    fn grok_used_percent_is_flipped_to_remaining() {
        let kind = resolve_semantics(CH_GROK, "usagePercent").expect("grok 必须已声明语义");
        assert_eq!(kind, PercentKind::Used, "grok 的 usagePercent 是已用%");
        let remaining = normalize_percent(20.0, kind).unwrap();
        assert_eq!(remaining, 80.0, "已用 20% ⇒ 剩余 80%");
        // 反向接错必须失败：若把 grok 当 Remaining，会得出 20（完全相反的结论）
        let wrong = normalize_percent(20.0, PercentKind::Remaining).unwrap();
        assert_ne!(wrong, remaining, "语义接反必须产出不同的数");
    }

    #[test]
    fn every_channel_declares_its_semantics() {
        for channel in ALL_CHANNELS {
            assert!(
                percent_semantics_of(channel).is_some(),
                "渠道 {channel} 未声明 percentage 语义(P0-23 禁止默认值兜底)"
            );
        }
    }

    /// 逐个渠道锁死方向：声明为 Used 的渠道，20 必须变 80；声明为 Remaining 的必须保持 20。
    #[test]
    fn channel_direction_is_locked_per_channel() {
        for channel in ALL_CHANNELS {
            let kind = percent_semantics_of(channel).unwrap();
            let normalized = normalize_percent(20.0, kind).unwrap();
            match kind {
                PercentKind::Used => assert_eq!(normalized, 80.0, "{channel} 应是已用%"),
                PercentKind::Remaining => assert_eq!(normalized, 20.0, "{channel} 应是剩余%"),
            }
        }
        // 已知反向渠道的白名单（改这里前先看 PRD §3.4）
        assert_eq!(percent_semantics_of(CH_GROK), Some(PercentKind::Used));
        assert_eq!(percent_semantics_of(CH_CODEX), Some(PercentKind::Remaining));
        assert_eq!(percent_semantics_of(CH_ANTIGRAVITY), Some(PercentKind::Remaining));
        assert_eq!(percent_semantics_of(CH_GEMINI), Some(PercentKind::Remaining));
    }

    #[test]
    fn unknown_channel_is_rejected_not_defaulted() {
        assert!(percent_semantics_of("some_new_channel").is_none());
        let err = resolve_semantics("some_new_channel", "whatever").unwrap_err();
        assert!(err.contains("未声明"), "未知渠道必须报错: {err}");
    }

    #[test]
    fn out_of_range_percent_is_rejected() {
        assert!(normalize_percent(-5.0, PercentKind::Remaining).is_err());
        assert!(normalize_percent(120.0, PercentKind::Remaining).is_err());
        assert!(normalize_percent(f64::NAN, PercentKind::Remaining).is_err());
        // 浮点毛刺在容差内被夹紧
        assert_eq!(normalize_percent(100.0000001, PercentKind::Remaining).unwrap(), 100.0);
    }

    // ── 配额历史 ──

    #[test]
    fn quota_history_parses_models_and_points() {
        let root = temp_root("history");
        write_json(
            &root.join(SUBDIR_QUOTA_HISTORY).join(format!("{}.json", hex64(1))),
            r#"{
              "email": "a@example.com",
              "updatedAt": 1774355884304,
              "models": {
                "claude-4-5": { "label": "Claude", "points": [
                  {"timestamp": 1774355880000, "remainingPercentage": 100, "resetTime": 1774373880000, "countdownSeconds": 17998},
                  {"timestamp": 1774359480000, "remainingPercentage": 63}
                ]},
                "g3-pro": { "label": "Gemini 3 Pro", "points": [
                  {"timestamp": 1774355880000, "remainingPercentage": 37}
                ]}
              }
            }"#,
        );
        clear_caches();
        let series = quota_history_series(&root, Some("a@example.com"), 1_774_359_000_000).unwrap();
        assert_eq!(series.len(), 2, "两个模型各一条序列: {series:?}");
        assert_eq!(series[0].model_key, "claude-4-5");
        assert_eq!(series[0].label, "Claude");
        assert_eq!(series[0].points.len(), 2);
        assert_eq!(series[0].points[0].remaining_percentage, 100.0);
        assert_eq!(series[0].points[0].remaining_fraction, 1.0);
        assert_eq!(series[0].points[0].reset_at_ms, Some(1_774_373_880_000));
        assert_eq!(series[0].points[1].remaining_fraction, 0.63);
        // countdownSeconds 也能推出 resetAt（updatedAt + countdown*1000）
        assert_eq!(series[1].model_key, "g3-pro");
        assert_eq!(series[1].points[0].remaining_fraction, 0.37);

        // 按 email 反关联：另一个邮箱不该命中
        let none = quota_history_series(&root, Some("b@example.com"), 1_774_359_000_000).unwrap();
        assert!(none.is_empty(), "email 不匹配应返回空: {none:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── 缓存 ──

    /// **关键回归(2026-09-12)**:cockpit 升级后配额 schema 从
    ///   `{ models: { id: { quotaInfo: { remainingFraction } } } }`
    /// 改成了
    ///   `{ payload: { quota_summary: { groups: [ { buckets: [ { remainingFraction, bucketId, displayName } ] } ] } } }`
    /// parse_desktop_file 必须认后者(否则 antigravity/gemini/antigravity_ide 全显示"用量不可得")。
    /// **真实现场回归（2026-09-12 补）：账号文件加密时仍必须出数。**
    ///
    /// 用户二次反馈「用量还是不可得」。上一轮只补了 `quota_summary` 解析，**没修关联**，
    /// 所以解析对了也出不了数。现场形态（实测 `~/.antigravity_cockpit/`）：
    ///   - `accounts/<uuid>.json` 整体加密，keys 只有
    ///     `version/kind/algorithm/key_id/nonce/ciphertext/encrypted_at` ⇒ **读不到 email**
    ///   - `cache/quota_api_v1_desktop/authorized/<sha256(email)>.json` 明文 ⇒ 自带 email + 配额
    ///
    /// 加密账号让 `acct.email` 恒为 ""，按 email 反关联永远失败，11 份明文缓存被整批丢弃。
    #[test]
    fn encrypted_accounts_still_yield_percent_from_desktop_cache() {
        let root = temp_root("encrypted-accounts");
        // ① 加密的账号文件（真实 keys，值脱敏）
        write_json(
            &root.join("accounts").join("00000000-0000-4000-8000-000000000001.json"),
            r#"{"version":1,"kind":"account","algorithm":"AES-256-GCM","key_id":"local",
                "nonce":"AAAAAAAAAAAAAAAA","ciphertext":"zzzz","encrypted_at":"2023-11-14T22:13:20Z"}"#,
        );
        // ② 明文桌面缓存：文件名 = sha256(email)，payload 用保持现场结构的演示 quota_summary
        write_json(
            &root
                .join(SUBDIR_QUOTA_DESKTOP)
                .join("1d76b62173c8ac67590fc988a265b13613528a9b5b8c7bd246d8a444d331b154.json"),
            r#"{"version":1,"source":"desktop","email":"demo@example.invalid",
                "updatedAt":1700000000000,
                "payload":{"quota_summary":{"groups":[
                  {"displayName":"Gemini Models","buckets":[
                    {"bucketId":"gemini-weekly","displayName":"Weekly Limit",
                     "remainingFraction":0.8,"resetTime":"2023-11-21T22:13:20Z","window":"weekly"},
                    {"bucketId":"gemini-5h","displayName":"Five Hour Limit",
                     "remainingFraction":0.25,"resetTime":"2023-11-15T03:13:20Z","window":"5h"}
                  ]}]}}}"#,
        );

        let accounts = ChannelAccounts::load(&root, CH_ANTIGRAVITY).unwrap();
        assert_eq!(accounts.accounts.len(), 1);
        assert!(
            accounts.accounts[0].email.is_empty(),
            "用例前提:加密账号必须读不到 email,否则这个回归测不到点上"
        );

        let rows = SnapshotProvider {
            now_ms: 1700000000000 + 1_000,
        }
        .fetch(&accounts)
        .unwrap();

        // 核心断言:**不许再是"用量不可得"**
        assert_eq!(rows.len(), 2, "两个 bucket 都要出数,实际: {rows:?}");
        assert!(
            rows.iter().all(|r| r.percent.is_some()),
            "绝不能再出现用量不可得: {rows:?}"
        );
        assert!(rows.iter().all(|r| r.unavailable_reason.is_none()));
        // 账号身份必须落在桌面缓存自己身上（id = 文件名 = sha256(email)）
        assert!(
            rows.iter().all(|r| r.email == "demo@example.invalid"),
            "邮箱应取自桌面缓存: {rows:?}"
        );
        assert!(
            rows.iter().all(|r| r.account_id
                == "1d76b62173c8ac67590fc988a265b13613528a9b5b8c7bd246d8a444d331b154"),
            "account_id 应是桌面缓存文件名: {rows:?}"
        );
        // remainingFraction 0..1 → 剩余百分比 80 / 25
        let weekly = rows.iter().find(|r| r.model_id == "gemini-weekly").expect("weekly 桶");
        assert!((weekly.percent.unwrap() - 80.0).abs() < 1e-6);
        assert_eq!(weekly.window_kind, QuotaWindowKind::Weekly);
        let fiveh = rows.iter().find(|r| r.model_id == "gemini-5h").expect("5h 桶");
        assert!((fiveh.percent.unwrap() - 25.0).abs() < 1e-6, "实际 {}%", fiveh.percent.unwrap());
        // 真实 bucketId 是 `gemini-5h` 而不是 `five-hour`,必须判成 FiveHour 而不是 Unknown
        assert_eq!(
            fiveh.window_kind,
            QuotaWindowKind::FiveHour,
            "真实 bucketId `gemini-5h` 必须识别为 FiveHour"
        );
        assert!(!fiveh.stale, "60s TTL 内不算陈旧");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// **真机实测（2026-09-12）：吃真实的 `~/.antigravity_cockpit`，验证"用户屏幕上到底出不出数"。**
    ///
    /// 单测是造的夹具，可能跟现场不一致 —— 上一轮就是"解析测试过了、现场还是不可得"。
    /// 这条直接读真机目录，把每个 Google 系账号的百分比打出来，人眼可核对。
    /// 用 `--ignored` 单独跑，CI 不跑（依赖本机 cockpit 数据）。
    #[test]
    #[ignore = "依赖本机 ~/.antigravity_cockpit 真实数据,CI 不跑"]
    fn real_cockpit_dir_yields_percent_for_google_channels() {
        // cockpit_root() 走 env,必须在持锁状态下读真机目录。
        let _env = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let root = cockpit_root().expect("本机应有 ~/.antigravity_cockpit");
        let now_ms = chrono_like_now_ms();
        let mut total = 0usize;
        let mut with_percent = 0usize;
        let mut unavailable = 0usize;
        for channel in [CH_ANTIGRAVITY, CH_GEMINI, CH_ANTIGRAVITY_IDE] {
            let accounts = match ChannelAccounts::load(&root, channel) {
                Ok(a) => a,
                Err(e) => {
                    println!("[{channel}] 载入失败: {e}");
                    continue;
                }
            };
            if accounts.accounts.is_empty() {
                continue;
            }
            let emails_known = accounts.accounts.iter().filter(|a| !a.email.is_empty()).count();
            let rows = SnapshotProvider { now_ms }.fetch(&accounts).expect("fetch 不应为 Err");
            println!(
                "[{channel}] 账号 {} 个(可读 email {} 个) → 快照 {} 条",
                accounts.accounts.len(),
                emails_known,
                rows.len()
            );
            for r in &rows {
                total += 1;
                match r.percent {
                    Some(p) => {
                        with_percent += 1;
                        println!(
                            "    ✓ {} | {} | {} = {:.1}% | window={:?} | src={}",
                            r.email, r.model_id, r.display_name, p, r.window_kind, r.raw_kind
                        );
                    }
                    None => {
                        unavailable += 1;
                        println!(
                            "    ✗ {} | {} | 用量不可得: {}",
                            r.email,
                            r.account_id,
                            r.unavailable_reason.as_deref().unwrap_or("(无原因)")
                        );
                    }
                }
            }
        }
        println!("\n=== 合计 {total} 条:出数 {with_percent} / 不可得 {unavailable} ===");
        assert!(total > 0, "真机一条都没出,说明目录形态又变了");
        assert!(
            with_percent > 0,
            "真机一条百分比都没有 —— 这就是用户看到的「用量还是不可得」"
        );
    }

    /// **导出真机快照，供前端渲染链路验证**（2026-09-12 补）。
    ///
    /// 光有 Rust 侧"能解析"不够 —— 用户看的是**渲染后的 chip**。这条把真机跑出来的快照
    /// 原样写成 JSON，前端再用同一套 `quotaChannelMerge` + 年龄逻辑跑一遍，
    /// 就能在不打开浏览器的情况下确认「用户到底会看到什么」
    /// （合并成几个 chip、百分比多少、有没有标年龄）。
    #[test]
    #[ignore = "导出真机快照供 UI 渲染验证,CI 不跑"]
    fn dump_real_snapshots_for_ui_verification() {
        // cockpit_root() 走 env,必须在持锁状态下读真机目录。
        let _env = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let root = cockpit_root().expect("本机应有 ~/.antigravity_cockpit");
        let now_ms = chrono_like_now_ms();
        let mut all: Vec<QuotaSnapshot> = Vec::new();
        for channel in ALL_CHANNELS {
            let accounts = match ChannelAccounts::load(&root, channel) {
                Ok(a) => a,
                Err(_) => continue,
            };
            if accounts.accounts.is_empty() {
                continue;
            }
            let provider = SnapshotProvider { now_ms };
            if let Ok(rows) = provider.fetch(&accounts) {
                all.extend(rows);
            }
        }
        let out = std::env::temp_dir().join("console2api-real-quota-snapshots.json");
        let json = serde_json::to_string_pretty(&all).expect("序列化快照");
        std::fs::write(&out, &json).expect("写出快照文件");
        println!("导出 {} 条快照 → {}", all.len(), out.display());
        assert!(!all.is_empty(), "真机一条都没出,目录形态可能又变了");
    }

    /// 边界：账号加密**且**桌面缓存也没有 → 必须诚实报"用量不可得"，而不是静默变 0。
    #[test]
    fn encrypted_accounts_without_desktop_cache_report_unavailable_not_zero() {
        let root = temp_root("encrypted-no-cache");
        write_json(
            &root.join("accounts").join("00000000-0000-4000-8000-000000000001.json"),
            r#"{"version":1,"kind":"account","algorithm":"AES-256-GCM","ciphertext":"zzzz"}"#,
        );
        let accounts = ChannelAccounts::load(&root, CH_ANTIGRAVITY).unwrap();
        let rows = SnapshotProvider { now_ms: 5_000 }.fetch(&accounts).unwrap();
        assert_eq!(rows.len(), 1, "没有桌面缓存时仍要为这个账号报一次不可得");
        assert!(rows[0].percent.is_none(), "绝不能是 Some(0.0)");
        assert!(rows[0].unavailable_reason.is_some(), "必须给出可读原因");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 回归：账号侧 email 可读时，仍走老的**精确 email 关联**，不会被 ④ 重复出数。
    #[test]
    fn readable_email_still_uses_precise_match_and_no_duplicate() {
        let root = temp_root("plain-email");
        write_json(
            &root.join("accounts").join("acct-1.json"),
            r#"{"email":"g@example.com","displayName":"G"}"#,
        );
        write_json(
            &root.join(SUBDIR_QUOTA_DESKTOP).join("aaaa.json"),
            r#"{"email":"g@example.com","updatedAt":1784122877082,
                "payload":{"quota_summary":{"groups":[{"buckets":[
                  {"bucketId":"gemini-weekly","remainingFraction":0.5}]}]}}}"#,
        );
        let accounts = ChannelAccounts::load(&root, CH_ANTIGRAVITY).unwrap();
        assert_eq!(accounts.accounts[0].email, "g@example.com");
        let rows = SnapshotProvider { now_ms: 1784122877082 }.fetch(&accounts).unwrap();
        assert_eq!(rows.len(), 1, "只能出一条,④ 不得重复补出: {rows:?}");
        assert_eq!(rows[0].account_id, "acct-1", "应保留账号侧 id");
        assert!((rows[0].percent.unwrap() - 50.0).abs() < 1e-6);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn parse_desktop_file_recognises_quota_summary_schema() {
        let file = DirFile {
            name: "g.json".to_string(),
            content: r#"{
              "email": "g@example.com",
              "updatedAt": 1700000000000,
              "payload": {
                "quota_summary": {
                  "groups": [
                    {
                      "buckets": [
                        {"bucketId": "gemini-weekly", "displayName": "Weekly Limit",
                         "remainingFraction": 1.0, "resetTime": "2026-07-22T00:00:00Z"},
                        {"bucketId": "gemini-five-hour", "displayName": "5h Limit",
                         "remainingFraction": 0.42, "resetTime": "2026-07-21T18:00:00Z"}
                      ]
                    }
                  ]
                }
              }
            }"#.to_string(),
        };
        let entry = parse_desktop_file(&file).expect("必须认 quota_summary schema");
        assert_eq!(entry.email, "g@example.com".to_string());
        assert_eq!(entry.entries.len(), 2, "两个 bucket 都要展开成两条 RawEntry");
        let wk = entry.entries.iter().find(|e| e.model_id == "gemini-weekly").expect("weekly 必须有");
        assert_eq!(wk.display_name, "Weekly Limit");
        assert!((wk.raw_percent - 1.0).abs() < 1e-9);
        assert_eq!(wk.window_kind, QuotaWindowKind::Weekly);
        let fh = entry.entries.iter().find(|e| e.model_id == "gemini-five-hour").expect("5h 必须有");
        assert_eq!(fh.display_name, "5h Limit");
        assert!((fh.raw_percent - 0.42).abs() < 1e-9);
        assert_eq!(fh.window_kind, QuotaWindowKind::FiveHour);
        assert_eq!(fh.reset_at_ms, Some(1_784_656_800_000));
    }

    #[test]
    fn parse_desktop_file_legacy_models_schema_still_works() {
        let file = DirFile {
            name: "g.json".to_string(),
            content: r#"{"email":"g@example.com","payload":{"models":{"g3-pro":{"quotaInfo":{"remainingFraction":0.5}}}}}"#.to_string(),
        };
        let entry = parse_desktop_file(&file).expect("老 schema 不能被这次升级打破");
        assert_eq!(entry.entries.len(), 1);
        assert_eq!(entry.entries[0].model_id, "g3-pro");
    }

    #[test]
    fn quota_models_and_explicit_pools_keep_distinct_scopes_and_iso_reset() {
        let entries = entries_from_container(&serde_json::json!({
            "models":{"gemini-pro":{"quotaInfo":{"remainingFraction":0.6}}},
            "quota_summary":{"groups":[{"buckets":[
                {"bucketId":"gemini-weekly","remainingFraction":0.4,
                    "resetTime":"2026-07-22T00:00:00Z"}
            ]}]}
        }), QuotaWindowKind::Unknown);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].scope, "model");
        assert_eq!(entries[0].window_kind, QuotaWindowKind::Unknown);
        assert_eq!(entries[1].scope, "pool");
        assert_eq!(entries[1].window_kind, QuotaWindowKind::Weekly);
        assert_eq!(entries[1].reset_at_ms, Some(1_784_678_400_000));
    }

    #[test]
    fn desktop_cache_hits_within_60s_and_rereads_after() {
        let root = temp_root("cache");
        let file = root.join(SUBDIR_QUOTA_DESKTOP).join(format!("{}.json", hex64(2)));
        write_json(
            &file,
            r#"{"email":"g@example.com","updatedAt":1000,"payload":{"models":{
                 "g3-pro":{"quotaInfo":{"remainingFraction":0.9,"resetTime":9999}}}}}"#,
        );
        clear_caches();

        let t0 = 1_000_000_i64;
        let first = cached_desktop_files(&root, t0).unwrap();
        assert!(!first.cache_hit, "首次必须是未命中");
        assert_eq!(first.value.len(), 1);

        // 改写文件：60s 内不应该被看到（证明没重读磁盘）
        write_json(
            &file,
            r#"{"email":"g@example.com","updatedAt":2000,"payload":{"models":{
                 "g3-pro":{"quotaInfo":{"remainingFraction":0.1,"resetTime":8888}}}}}"#,
        );
        let second = cached_desktop_files(&root, t0 + 59_000).unwrap();
        assert!(second.cache_hit, "60s 内必须命中缓存,不重读文件");
        assert_eq!(second.fetched_at_ms, t0, "命中缓存时 fetchedAtMs 不能变");
        assert!(second.value[0].content.contains("0.9"), "不该看到新内容");

        // 超过 60s → 重读
        let third = cached_desktop_files(&root, t0 + 61_000).unwrap();
        assert!(!third.cache_hit, "超过 TTL 必须重读");
        assert_eq!(third.fetched_at_ms, t0 + 61_000);
        assert!(third.value[0].content.contains("0.1"), "应看到新内容");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn desktop_refresh_error_preserves_snapshot_and_actual_read_time() {
        let root = temp_root("refresh-error");
        let cache_dir = root.join(SUBDIR_QUOTA_DESKTOP);
        write_json(&cache_dir.join(format!("{}.json", hex64(11))),
            r#"{"email":"masked@example.com","updatedAt":1000000,"payload":{"models":{
              "gemini-pro":{"quotaInfo":{"remainingFraction":0.5}}}}}"#);
        clear_caches();
        let accounts = ChannelAccounts::load(&root, CH_ANTIGRAVITY).unwrap();
        let initial = SnapshotProvider { now_ms: 1_000_000 }.fetch(&accounts).unwrap();
        assert_eq!(initial[0].fetched_at_ms, 1_000_000);
        std::fs::remove_dir_all(&cache_dir).unwrap();
        std::fs::write(&cache_dir, "not a directory").unwrap();
        let fallback = SnapshotProvider { now_ms: 1_061_000 }.fetch(&accounts).unwrap();
        assert_eq!(fallback[0].percent, Some(50.0));
        assert_eq!(fallback[0].fetched_at_ms, 1_000_000);
        assert!(fallback[0].stale);
        assert!(fallback[0].source_error.is_some());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn claude_native_usage_preserves_pool_identity_reset_units_and_failed_refresh_age() {
        let root=temp_root("claude-native");
        let path=root.join("claude_accounts/native.json");
        let mut account=serde_json::json!({"email":"test@example.com","auth_mode":"OAuth",
            "usage_updated_at":1_792_000_000_000i64,
            "claude_usage_raw":{
                "five_hour":{"utilization":0.0,"resets_at":"2026-10-16T00:00:00Z"},
                "seven_day":{"utilization":40.5,"resets_at":1_792_600_000i64},
                "seven_day_sonnet":{"utilization":20.25,"resets_at":1_792_600_000_000i64}}});
        write_json(&path,&account.to_string());
        let rows=SnapshotProvider{now_ms:1_792_000_001_000}.fetch(&ChannelAccounts::load(&root,CH_CLAUDE).unwrap()).unwrap();
        assert_eq!(rows.len(),3);
        let five=rows.iter().find(|r|r.model_id=="five_hour").unwrap();
        assert_eq!(five.percent,Some(100.0));
        assert_eq!(five.reset_at_ms,Some(1_792_108_800_000));
        assert!(rows.iter().filter(|r|r.window_kind==QuotaWindowKind::Weekly)
            .all(|r|r.reset_at_ms==Some(1_792_600_000_000)));
        assert!(rows.iter().all(|r|r.updated_at_ms==Some(1_792_000_000_000) && r.scope=="pool"));
        account["quota_error"]=serde_json::json!({"code":"usage_failed"});
        account["usage_updated_at"]=serde_json::json!(1_792_000_002_000i64);
        write_json(&path,&account.to_string());
        let failed=SnapshotProvider{now_ms:1_792_000_002_000}.fetch(&ChannelAccounts::load(&root,CH_CLAUDE).unwrap()).unwrap();
        assert!(failed.iter().all(|r|r.stale && r.source_error.is_some() && r.updated_at_ms.is_none()));
        assert_eq!(failed.iter().find(|r|r.model_id=="seven_day").unwrap().percent,Some(59.5));
        std::fs::remove_dir_all(root).unwrap();
    }

    // ── API Key 类账号 ──

    #[test]
    fn api_key_accounts_return_annotated_empty_not_zero() {
        let root = temp_root("apikey");
        write_json(
            &root.join("grok_accounts").join("k1.json"),
            r#"{"email":"k@example.com","account_type":"api_key","quota":{"usagePercent":42}}"#,
        );
        let accounts = ChannelAccounts::load(&root, CH_GROK).unwrap();
        assert_eq!(accounts.accounts.len(), 1);
        let rows = SnapshotProvider { now_ms: 5_000 }.fetch(&accounts).unwrap();
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert!(row.percent.is_none(), "API Key 类绝不能给出百分比(更不能是 0)");
        assert!(row.remaining_fraction.is_none());
        assert_eq!(row.percent, None, "percent 必须是 None 而不是 Some(0.0)");
        let reason = row.unavailable_reason.as_deref().unwrap_or("");
        assert!(reason.contains("api_key"), "必须给出可读原因: {reason}");
        assert!(!reason.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn claude_desktop_gateway_is_excluded() {
        let json: serde_json::Value =
            serde_json::from_str(r#"{"auth_mode":"DesktopGateway","quota":{"used_percent":10}}"#)
                .unwrap();
        let reason = api_key_exclusion_reason(CH_CLAUDE, &json);
        assert!(reason.is_some(), "claude DesktopGateway 必须被排除");
        assert!(reason.unwrap().contains("DesktopGateway"));
    }

    #[test]
    fn normal_accounts_are_not_excluded() {
        let json: serde_json::Value =
            serde_json::from_str(r#"{"auth_mode":"chatgpt","quota":{"used_percent":10}}"#).unwrap();
        assert!(api_key_exclusion_reason(CH_CLAUDE, &json).is_none());
        assert!(api_key_exclusion_reason(CH_GROK, &json).is_none());
    }

    // ── SnapshotProvider 端到端 ──

    #[test]
    fn snapshot_provider_reads_gemini_desktop_cache_per_model() {
        let root = temp_root("gemini");
        write_json(
            &root.join("accounts").join("acc-1.json"),
            r#"{"email":"g@example.com","plan_name":"Google AI Pro","quota":{"models":{}}}"#,
        );
        write_json(
            &root.join(SUBDIR_QUOTA_DESKTOP).join(format!("{}.json", hex64(3))),
            r#"{"version":1,"source":"desktop","email":"g@example.com","updatedAt":1000,
                "payload":{"models":{
                  "claude-4-5":{"displayName":"Claude","quotaInfo":{"remainingFraction":0.8,"resetTime":7777}},
                  "g3-pro":{"displayName":"Gemini 3 Pro","quotaInfo":{"remainingFraction":0.25,"resetTime":6666}}
                }}}"#,
        );
        clear_caches();
        let accounts = ChannelAccounts::load(&root, CH_ANTIGRAVITY).unwrap();
        assert_eq!(accounts.accounts.len(), 1);
        let rows = SnapshotProvider { now_ms: 1_000_000 }.fetch(&accounts).unwrap();
        assert_eq!(rows.len(), 2, "两个模型各一行: {rows:?}");
        assert_eq!(rows[0].model_id, "claude-4-5");
        assert_eq!(rows[0].display_name, "Claude");
        assert_eq!(rows[0].percent, Some(80.0), "0.8 的小数要放大成 80%");
        assert_eq!(rows[0].remaining_fraction, Some(0.8));
        // 1.0 - 0.8 在 f64 下是 0.19999999999999996，严格相等会误报 —— 用 epsilon 比。
        let used = rows[0].used_fraction.expect("used_fraction 应有值");
        assert!((used - 0.2).abs() < 1e-9, "used_fraction 应为 0.2，实际 {used}");
        assert_eq!(rows[0].percent_kind, Some(PercentKind::Remaining));
        assert_eq!(rows[0].source, QuotaSourceKind::Snapshot);
        assert_eq!(rows[1].percent, Some(25.0));
        assert!(rows[0].stale, "updatedAt=1000 距今远超 60s ⇒ stale");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn generic_window_keys_preserve_overall_and_model_specific_pool_identity() {
        let entries = entries_from_container(&serde_json::json!({
            "seven_day": {"used_percent": 8},
            "seven_day_sonnet": {"quotaInfo": {"used_percent": 100}},
            "weekly": {"model_id": "explicit-pool", "used_percent": 20},
        }), QuotaWindowKind::Unknown);
        assert_eq!(entries.iter().map(|entry| entry.model_id.as_str()).collect::<Vec<_>>(),
            vec!["seven_day", "seven_day_sonnet", "explicit-pool"]);
        assert!(entries.iter().all(|entry| entry.scope == "pool"
            && entry.window_kind == QuotaWindowKind::Weekly));
    }

    #[test]
    fn codex_account_snapshot_windows_are_classified() {
        let root = temp_root("codex");
        write_json(
            &root.join("codex_accounts").join("acc-2.json"),
            r#"{"email":"c@example.com","updatedAt":900000,
                "quota":{"five_hour":{"used_percent":30,"reset_at":111},
                         "seven_day":{"used_percent":70,"reset_at":222}}}"#,
        );
        let accounts = ChannelAccounts::load(&root, CH_CODEX).unwrap();
        let rows = SnapshotProvider { now_ms: 1_000_000 }.fetch(&accounts).unwrap();
        assert_eq!(rows.len(), 2, "两个窗口各一行: {rows:?}");
        let five = rows.iter().find(|r| r.window_kind == QuotaWindowKind::FiveHour).unwrap();
        let week = rows.iter().find(|r| r.window_kind == QuotaWindowKind::Weekly).unwrap();
        assert_eq!(five.percent, Some(70.0), "used_percent=30 ⇒ 剩余 70%");
        assert_eq!(five.percent_kind, Some(PercentKind::Used));
        assert_eq!(week.percent, Some(30.0));
        assert_eq!(five.reset_at_ms, Some(111));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn plan_of_reads_channel_specific_fields() {
        // codex/workbuddy/trae/qoder/codebuddy 用 plan_type
        assert_eq!(
            plan_of(&serde_json::from_str(r#"{"plan_type":"plus"}"#).unwrap()),
            Some("plus".to_string())
        );
        // kiro 用 plan_name
        assert_eq!(
            plan_of(&serde_json::from_str(r#"{"plan_name":"Kiro Pro"}"#).unwrap()),
            Some("Kiro Pro".to_string())
        );
        // zed 用 plan_raw
        assert_eq!(
            plan_of(&serde_json::from_str(r#"{"plan_raw":"zed_pro"}"#).unwrap()),
            Some("zed_pro".to_string())
        );
        // cursor 用 membership_type
        assert_eq!(
            plan_of(&serde_json::from_str(r#"{"membership_type":"pro"}"#).unwrap()),
            Some("pro".to_string())
        );
        // windsurf / github-copilot 用 copilot_plan
        assert_eq!(
            plan_of(&serde_json::from_str(r#"{"copilot_plan":"business"}"#).unwrap()),
            Some("business".to_string())
        );
        // antigravity/gemini 的档位在嵌套 quota 里(subscription_tier / tier_id)
        assert_eq!(
            plan_of(&serde_json::from_str(r#"{"quota":{"subscription_tier":"PRO"}}"#).unwrap()),
            Some("PRO".to_string())
        );
        // 空串 / 缺失 / 加密信封 → None(绝不猜、绝不用 0 冒充)
        assert_eq!(plan_of(&serde_json::from_str(r#"{"plan_type":""}"#).unwrap()), None);
        assert_eq!(plan_of(&serde_json::from_str(r#"{"email":"a@b.c"}"#).unwrap()), None);
        assert_eq!(
            plan_of(&serde_json::from_str(r#"{"version":1,"ciphertext":"xx"}"#).unwrap()),
            None
        );
    }

    #[test]
    fn plan_is_exposed_on_snapshot_and_unavailable_rows() {
        let root = temp_root("plan");
        // 明文账号详情带 plan_name(grok 形态;grok 的账号目录名是 grok_accounts/)
        write_json(
            &root.join("grok_accounts").join("acc-p.json"),
            r#"{"email":"p@example.com","plan_name":"Grok Pro","quota":{"usagePercent":42}}"#,
        );
        // API Key 类账号:不可得行也必须带出源里的 plan,不能被抹成 None
        write_json(
            &root.join("grok_accounts").join("acc-k.json"),
            r#"{"email":"k@example.com","account_type":"api_key","plan_type":"API_KEY","quota":{"usagePercent":42}}"#,
        );
        clear_caches();
        let accounts = ChannelAccounts::load(&root, CH_GROK).unwrap();
        assert_eq!(accounts.accounts.len(), 2);
        let rows = SnapshotProvider { now_ms: 1_000_000 }.fetch(&accounts).unwrap();
        let pro = rows.iter().find(|r| r.email == "p@example.com").expect("明文账号应出一行");
        assert_eq!(pro.plan.as_deref(), Some("Grok Pro"));
        assert!(pro.percent.is_some(), "普通账号应算出剩余%(grok 原始为已用%,42 ⇒ 58)");
        let key = rows.iter().find(|r| r.email == "k@example.com").expect("apikey 行应在");
        assert!(key.unavailable_reason.is_some(), "apikey 类必须标注用量不可得");
        assert_eq!(key.plan.as_deref(), Some("API_KEY"), "不可得行也要如实带出源里的 plan");
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── 套餐(plan)来源：明文索引 > 明文详情 > None ──

    /// ★ 本次修复的核心回归锁：详情文件是 AES-256-GCM 密文、`plan_of` 必然读不出套餐时，
    /// **明文索引文件必须把套餐补上**。
    ///
    /// 依据(cockpit 源码,只读) `src-tauri/src/modules/secure_account_storage.rs:1-5`：
    /// *"Index/summary files stay plaintext; only per-account detail JSON is encrypted at rest."*
    /// 谁把 `load_index_plans` 摘掉，这个用例立刻失败 —— Plan 列又会退回一整面 `—`。
    #[test]
    fn plan_comes_from_plaintext_index_when_detail_is_encrypted() {
        let root = temp_root("plan_index");
        // 逐账号详情 = 加密信封（真实形态，见 secure_account_storage.rs）
        let encrypted = r#"{"version":1,"kind":"kiro_account","algorithm":"AES-256-GCM",
            "key_id":"k1","nonce":"AAAAAAAAAAAAAAAA","ciphertext":"c29tZS1jaXBoZXI=",
            "encrypted_at":1700000000}"#;
        write_json(&root.join("kiro_accounts").join("acc-enc.json"), encrypted);
        // 同渠道的**明文索引**就在旁边，带 plan_type
        write_json(
            &root.join("kiro_accounts.json"),
            r#"{"accounts":[{"id":"acc-enc","email":"e@example.com","plan_type":"plus"}]}"#,
        );
        let accounts = ChannelAccounts::load(&root, CH_KIRO).unwrap();
        assert_eq!(accounts.accounts.len(), 1);
        // 先钉死前提：密文详情本身确实读不出套餐（否则这个用例就失去意义了）
        assert_eq!(
            plan_of(&accounts.accounts[0].json),
            None,
            "前提校验:密文信封里不该有 plan 字段"
        );
        assert_eq!(
            accounts.accounts[0].plan.as_deref(),
            Some("plus"),
            "明文索引必须把套餐补上(Plan 列恒为 — 的根因)"
        );
        // 端到端：不可得行也必须带出索引里的套餐，不能被抹成 None
        let rows = SnapshotProvider { now_ms: 1_000_000 }.fetch(&accounts).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].plan.as_deref(), Some("plus"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 索引文件不存在 → 退回读详情（详情仍是明文的老版本文件照样能用）。
    #[test]
    fn plan_falls_back_to_plaintext_detail_when_index_is_missing() {
        let root = temp_root("plan_fallback");
        write_json(
            &root.join("kiro_accounts").join("acc-plain.json"),
            r#"{"email":"k@example.com","plan_name":"Kiro Pro","kiro_usage_raw":{"remaining_percent":60}}"#,
        );
        assert!(
            !root.join("kiro_accounts.json").exists(),
            "前提校验:本用例不该有索引文件"
        );
        let accounts = ChannelAccounts::load(&root, CH_KIRO).unwrap();
        assert_eq!(accounts.accounts.len(), 1);
        assert_eq!(accounts.accounts[0].plan.as_deref(), Some("Kiro Pro"));
        let rows = SnapshotProvider { now_ms: 1_000_000 }.fetch(&accounts).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].percent, Some(60.0));
        assert_eq!(rows[0].plan.as_deref(), Some("Kiro Pro"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 红线：索引和详情都没有套餐 → `None`（界面显示 `—`）。
    /// **绝不能**兜成某个默认档位/渠道名 —— 取不到就是取不到。
    #[test]
    fn plan_is_none_when_neither_index_nor_detail_has_it() {
        let root = temp_root("plan_none");
        write_json(
            &root.join("kiro_accounts").join("acc-none.json"),
            r#"{"email":"n@example.com","kiro_usage_raw":{"remaining_percent":60}}"#,
        );
        // 索引存在但该账号没有套餐字段 → 同样不许编造
        write_json(
            &root.join("kiro_accounts.json"),
            r#"{"accounts":[{"id":"acc-none","email":"n@example.com"}]}"#,
        );
        let accounts = ChannelAccounts::load(&root, CH_KIRO).unwrap();
        assert_eq!(accounts.accounts.len(), 1);
        assert_eq!(accounts.accounts[0].plan, None, "取不到必须是 None,不许编造默认档位");
        let rows = SnapshotProvider { now_ms: 1_000_000 }.fetch(&accounts).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].plan, None, "快照也不许编造套餐");
        assert_eq!(rows[0].percent, Some(60.0), "用量本身照常出数,不受 plan 影响");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn zcode_absolute_values_become_remaining_percent() {
        let root = temp_root("zcode");
        write_json(
            &root.join("zcode_accounts").join("acc-3.json"),
            r#"{"email":"z@example.com","quota_total":1000,"quota_used":370,"quota_remaining":630,"reset_at":555}"#,
        );
        let accounts = ChannelAccounts::load(&root, CH_ZCODE).unwrap();
        let rows = SnapshotProvider { now_ms: 1_000_000 }.fetch(&accounts).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].percent, Some(63.0), "630/1000 ⇒ 剩余 63%");
        assert_eq!(rows[0].percent_kind, Some(PercentKind::Remaining));
        assert_eq!(rows[0].reset_at_ms, Some(555));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_quota_field_is_annotated_not_zero() {
        let root = temp_root("missing");
        write_json(
            &root.join("kiro_accounts").join("acc-4.json"),
            r#"{"email":"k@example.com"}"#,
        );
        let accounts = ChannelAccounts::load(&root, CH_KIRO).unwrap();
        let rows = SnapshotProvider { now_ms: 1_000_000 }.fetch(&accounts).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].percent.is_none(), "没字段不能返回 0");
        assert!(rows[0].unavailable_reason.is_some());
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── 路径 A 降级 ──

    #[test]
    fn live_provider_failure_degrades_to_snapshot() {
        let root = temp_root("fallback");
        write_json(
            &root.join("cursor_accounts").join("acc-5.json"),
            r#"{"email":"cu@example.com","cursor_usage_raw":{"remaining_percent":55}}"#,
        );
        let accounts = ChannelAccounts::load(&root, CH_CURSOR).unwrap();
        let now = 1_000_000;
        let (rows, live_error) =
            fetch_with_fallback(&LiveApiProvider { now_ms: now }, &SnapshotProvider { now_ms: now }, &accounts)
                .unwrap();
        assert!(live_error.is_some(), "路径 A 本轮恒失败");
        assert!(live_error.unwrap().contains("未启用"));
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].source, QuotaSourceKind::Snapshot, "降级后来源必须是 snapshot");
        assert_eq!(rows[0].percent, Some(55.0));
        let _ = std::fs::remove_dir_all(&root);
    }

    // ── 白名单 ──

    /// 回归钉子：antigravity 桌面缓存路径必须在白名单里（架构师报 D-5）。
    /// 以后有人删了 `ALLOWED_QUOTA_SUBDIRS` 里的这一条，这个用例立刻失败。
    #[test]
    fn desktop_cache_subdir_is_whitelisted() {
        assert!(
            ALLOWED_QUOTA_SUBDIRS.contains(&SUBDIR_QUOTA_DESKTOP),
            "cache/quota_api_v1_desktop/authorized 必须在白名单里(否则读不到 60s 配额缓存)"
        );
        assert!(ALLOWED_QUOTA_SUBDIRS.contains(&SUBDIR_QUOTA_HISTORY));
        assert!(ALLOWED_QUOTA_SUBDIRS.contains(&SUBDIR_QUOTA_PLUGIN));
    }

    /// 69 字符的 sha256 文件名论证：它过不了 `read_cockpit_file` 的 64 字符上限，
    /// 所以只能列目录读。这里把长度断言写死，防止以后有人"优化"回去。
    #[test]
    fn sha256_file_name_exceeds_single_file_limit() {
        let name = format!("{}.json", hex64(7));
        assert_eq!(name.len(), 69, "64 位 hex + .json");
        assert!(name.len() > 64, "因此不能用 read_cockpit_file(name.len() <= 64)");
    }

    // ── 红线 ──

    /// 不进账本自检：本模块不得出现任何写入 `usage_rollup` 的语句。
    ///
    /// ⚠️ 两个坑都踩过，必须按下面写法：
    /// 1. **先剥掉注释行再搜** —— 本文件头部文档里就写着"不得出现 `INSERT INTO usage_rollup`"，
    ///    直接全文搜索会被自己的文档命中；
    /// 2. **搜索词必须由片段拼出来** —— 若源码里直接写 `contains("INSERT OR")`，
    ///    那一行本身就是"含 INSERT OR 的代码行"，永远为真。
    #[test]
    fn quota_module_never_writes_to_the_ledger() {
        let source = include_str!("cockpit_quota.rs");
        let code: String = source
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        let needle = format!("{LEDGER_WRITE_PREFIX} {LEDGER_FACT_TABLE}");
        assert!(
            !code.contains(&needle),
            "配额数据不进账本:本模块不得出现 {needle}"
        );
        let any_insert = format!("{}{}", LEDGER_WRITE_PREFIX, " OR");
        assert!(!code.contains(&any_insert), "本模块不得写任何表");
    }

    #[test]
    fn accounts_dir_names_follow_the_gemini_exception() {
        assert_eq!(accounts_dir_name(CH_GEMINI), "accounts");
        assert_eq!(accounts_dir_name(CH_ANTIGRAVITY), "accounts");
        assert_eq!(accounts_dir_name(CH_ANTIGRAVITY_IDE), "accounts");
        assert_eq!(accounts_dir_name(CH_CODEX), "codex_accounts");
        // ⚠️ 修正:平台 ID `github-copilot` ≠ 目录 `github_copilot_accounts`（下划线）。
        assert_eq!(accounts_dir_name(CH_GITHUB_COPILOT), "github_copilot_accounts");
    }

    /// ★ **平台 ID → cockpit 账号目录名 全 20 渠道对照表**。
    ///
    /// 期望值逐条来自 cockpit 源码的 `ACCOUNTS_DIR` / `ACCOUNTS_INDEX_FILE` 常量
    /// （只读参考 `E:\sub2api\cockpit-tools-main`），依据写在第三列。
    ///
    /// **这是"目录名映射"的唯一事实来源**：以后新增渠道时若目录名拼错，本用例立刻挂掉。
    /// 让它变绿的正确做法是去 cockpit 源码核对那个渠道的 `ACCOUNTS_DIR` 常量，
    /// **不是**把期望值改成机械拼接的结果。
    #[test]
    fn accounts_dir_name_table_matches_cockpit_for_all_channels() {
        // (平台 ID, 期望目录名, cockpit 依据)
        let cases: &[(&str, &str, &str)] = &[
            (CH_CODEX, "codex_accounts", "cockpit-core/.../codex_account_core_tokens.rs:22"),
            (CH_ANTIGRAVITY, "accounts", "cockpit-core/.../account.rs:27（Google 系共用）"),
            (CH_ANTIGRAVITY_IDE, "accounts", "cockpit-core/.../account.rs:27（Google 系共用）"),
            (CH_GEMINI, "accounts", "cockpit-core/.../account.rs:27（Google 系共用）"),
            // ★ 不一致 1:平台 ID `claude_manager` → 目录 `claude_accounts`
            (CH_CLAUDE, "claude_accounts", "src-tauri/.../claude_account_core_storage.rs:38"),
            (CH_ZED, "zed_accounts", "src-tauri/.../zed_account.rs:16"),
            // ★ 不一致 2:平台 ID `github-copilot` → 目录 `github_copilot_accounts`
            (CH_GITHUB_COPILOT, "github_copilot_accounts", "cockpit-core/.../github_copilot_account.rs:11"),
            (CH_WINDSURF, "windsurf_accounts", "cockpit-core/.../windsurf_account.rs:15"),
            (CH_KIRO, "kiro_accounts", "cockpit-core/.../kiro_account.rs:13"),
            (CH_CURSOR, "cursor_accounts", "cockpit-core/.../cursor_account.rs:14"),
            (CH_GROK, "grok_accounts", "src-tauri/.../grok_account.rs:19"),
            (CH_CODEBUDDY, "codebuddy_accounts", "cockpit-core/.../codebuddy_account.rs:15"),
            (CH_CODEBUDDY_CN, "codebuddy_cn_accounts", "cockpit-core/.../codebuddy_cn_account.rs:15"),
            (CH_QODER, "qoder_accounts", "cockpit-core/.../qoder_account.rs:11"),
            (CH_ZCODE, "zcode_accounts", "src-tauri/.../zcode_account.rs:17"),
            (CH_TRAE, "trae_accounts", "src-tauri/.../trae_account_platform_storage.rs:22"),
            // ★ 不一致 3:cockpit 四平台共用 `trae_accounts`，但平台标识在**加密详情**里
            //   ⇒ 无法拆分。这 3 个变体**刻意**指向各自的（不存在的）目录：不占位 ≠ 谎报 0。
            (CH_TRAE_CN, "trae_cn_accounts", "默认规则:刻意不占位，见 trae_variants_* 用例"),
            (CH_TRAE_SOLO, "trae_solo_accounts", "默认规则:刻意不占位，见 trae_variants_* 用例"),
            (CH_TRAE_SOLO_CN, "trae_solo_cn_accounts", "默认规则:刻意不占位，见 trae_variants_* 用例"),
            (CH_WORKBUDDY, "workbuddy_accounts", "cockpit-core/.../workbuddy_account.rs:15"),
        ];

        for &(channel, expected, evidence) in cases {
            assert_eq!(
                accounts_dir_name(channel),
                expected,
                "渠道 {channel} 的账号目录名与 cockpit 不一致（依据: {evidence}）"
            );
        }

        // 表必须覆盖 `ALL_CHANNELS` 全集 —— 漏一个渠道就是漏测一个映射。
        assert_eq!(
            cases.len(),
            ALL_CHANNELS.len(),
            "对照表条目数({})必须等于 ALL_CHANNELS 长度({})",
            cases.len(),
            ALL_CHANNELS.len()
        );
        for channel in ALL_CHANNELS {
            assert!(
                cases.iter().any(|(c, _, _)| c == channel),
                "对照表漏了渠道 {channel} —— 新增渠道必须同步补进这张表"
            );
        }
    }

    /// ★ **回归锁**：`claude_manager` / `github-copilot` 是 cockpit 合法的**平台 ID**，
    /// 但**不是**账号目录名。它们是我们对外的渠道标识（展示 + 配额语义表都按这两个值走），
    /// 所以修的是"平台 ID → 目录名"这一步映射，**常量值一个都不许动**。
    ///
    /// 谁把 `accounts_dir_name` 退回机械拼接，这个用例立刻挂 —— 症状是「渠道配额表」
    /// 里 claude 与 GitHub Copilot 两行整行消失（不是显示 0）。
    #[test]
    fn platform_id_is_not_the_accounts_dir_for_claude_and_github_copilot() {
        // claude_manager → claude_accounts，不是 claude_manager_accounts
        assert_eq!(accounts_dir_name(CH_CLAUDE), "claude_accounts");
        assert_ne!(accounts_dir_name(CH_CLAUDE), "claude_manager_accounts");

        // github-copilot → github_copilot_accounts，不是 github-copilot_accounts
        assert_eq!(accounts_dir_name(CH_GITHUB_COPILOT), "github_copilot_accounts");
        assert_ne!(accounts_dir_name(CH_GITHUB_COPILOT), "github-copilot_accounts");

        // 常量值本身是对外渠道标识，不许改。
        assert_eq!(CH_CLAUDE, "claude_manager");
        assert_eq!(CH_GITHUB_COPILOT, "github-copilot");
    }

    /// ★ trae 三个变体**必须继续**指向各自的（不存在的）目录。
    ///
    /// 理由（防后人"顺手修好"）：cockpit 把 4 个 Trae 平台（trae / trae_solo / trae_cn /
    /// trae_solo_cn）的账号**存在同一个 `trae_accounts` 目录**
    /// （`src-tauri/src/modules/trae_account_platform_storage.rs:22`），
    /// 平台标识在账号**内部**字段里（`resolve_account_platform_kind`），
    /// 而账号详情是**加密**的 ⇒ 我们**无法按平台拆分**。
    ///
    /// 所以这 3 行不占位（`has_accounts=false` → 前端整行过滤），**数据没丢**：
    /// 全平台合计都在 `trae` 那一行里。若把它们指到 `trae_accounts`，
    /// 同一批账号会在 4 行里重复出现 —— 比不显示更糟。谁改了这里，本用例就挂。
    #[test]
    fn trae_variants_deliberately_point_at_their_own_missing_dirs() {
        assert_eq!(accounts_dir_name(CH_TRAE), "trae_accounts");
        assert_eq!(accounts_dir_name(CH_TRAE_CN), "trae_cn_accounts");
        assert_eq!(accounts_dir_name(CH_TRAE_SOLO), "trae_solo_accounts");
        assert_eq!(accounts_dir_name(CH_TRAE_SOLO_CN), "trae_solo_cn_accounts");

        // 三个变体一律不得与 trae 共用目录（重复计数红线）。
        for ch in [CH_TRAE_CN, CH_TRAE_SOLO, CH_TRAE_SOLO_CN] {
            assert_ne!(
                accounts_dir_name(ch),
                accounts_dir_name(CH_TRAE),
                "{ch} 不得与 trae 共用账号目录:cockpit 四平台共用 trae_accounts，\
                 但平台标识在加密详情里 ⇒ 无法拆分，指过去会让同一批账号在 4 行里重复出现"
            );
        }
    }

    // ── 命令 5/6：当前账号 + 模型分组 ──

    /// 用**隔离的数据根**跑一段逻辑：把 `USERPROFILE` + `HOME` 指向临时目录，
    /// 使 `cockpit_root()` 解析到 `<tmp>/.antigravity_cockpit`，
    /// **绝不读写真实的 `~/.antigravity_cockpit`**。
    ///
    /// 隔离手法与 `main.rs` 的 `read_cockpit_dir_accepts_whitelisted_subdir` 同源：
    /// `cockpit_root()` 只认 `USERPROFILE` / `HOME` 两个变量（cockpit_quota.rs:1495-1500），
    /// 本仓库里**不存在** `COCKPIT_TOOLS_TEST_DATA_DIR` 之类的专用测试变量。
    ///
    /// 环境变量是进程级的：别的模块也会改这几个变量，因此这里用
    /// **全仓库唯一的进程级锁** `crate::ENV_LOCK`（定义在 `main.rs` crate 根）。
    ///
    /// 此前本函数是"模块内 `static ENV_LOCK`"，与 `main.rs::tests` 里那把同名锁
    /// **互不相认** ⇒ 跨模块互斥失效：`main.rs` 的 `summarize_cockpit_api_logs_*`
    /// 会在本函数改写 `USERPROFILE`/`HOME` 的同一时刻读主目录，随机拿到"无法定位
    /// 用户主目录"。现在两处都指向同一把锁，互斥才真正生效。
    ///
    /// 结束后**恢复原值**（不残留）：改写交给 `crate::EnvGuard` 做 RAII，
    /// 即使闭包 `f()` panic，`Drop` 也会在 unwind 期间把 env 还原回去。
    fn with_isolated_cockpit_root<F, R>(tag: &str, f: F) -> R
    where
        F: FnOnce(&Path) -> R,
    {
        let _env = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        let home = std::env::temp_dir().join(format!("cockpit_quota_accounts_{tag}"));
        let _ = std::fs::remove_dir_all(&home);
        let root = home.join(".antigravity_cockpit");
        std::fs::create_dir_all(&root).expect("建隔离数据根");

        // 注意声明顺序：守卫必须晚于 `_env`(锁)声明，才能保证 Drop 时
        // "先还原 env，再放锁" —— 反过来会让并发用例看到还没还原的中间态。
        let _userprofile = crate::EnvGuard::set("USERPROFILE", &home);
        let _home = crate::EnvGuard::set("HOME", &home);

        let out = f(&root);

        let _ = std::fs::remove_dir_all(&home);
        out
    }

    /// 用例 1：两个源都在 → 各贡献 1 条，`source` 分别正确。
    #[test]
    fn current_accounts_merges_both_sources_with_correct_origin() {
        with_isolated_cockpit_root("both", |root| {
            write_json(
                &root.join("provider_current_accounts.json"),
                r#"{"version":"1.0","current_accounts":{"gemini":"acct-gemini"}}"#,
            );
            write_json(
                &root.join("antigravity_runtime_current_accounts.json"),
                r#"{"currentAccounts":{"antigravity":"00000000-0000-4000-8000-000000000001"}}"#,
            );

            let got = quota_current_accounts().expect("两个文件都在,应 Ok");
            assert_eq!(got.len(), 2, "两个源各 1 条: {got:?}");

            let gem = got
                .iter()
                .find(|e| e.platform == "gemini")
                .expect("gemini 应在结果里");
            assert_eq!(gem.account_id, "acct-gemini");
            assert_eq!(gem.source, "provider_current_accounts");

            let ant = got
                .iter()
                .find(|e| e.platform == "antigravity")
                .expect("antigravity 应在结果里");
            assert_eq!(ant.account_id, "00000000-0000-4000-8000-000000000001");
            assert_eq!(ant.source, "antigravity_runtime");
        });
    }

    /// 用例 1b：平台 key **原样保留** —— 不做 normalize，未知平台不丢。
    ///
    /// cockpit 的 `normalize_platform()` 是**写入侧**的校验，读侧是开放集合；
    /// 我们若照抄白名单就会把 `codebuddy-cn` 这类别名与未知平台整条丢掉。
    #[test]
    fn current_accounts_keep_raw_platform_keys() {
        with_isolated_cockpit_root("raw_keys", |root| {
            write_json(
                &root.join("provider_current_accounts.json"),
                r#"{"current_accounts":{"codebuddy-cn":"a1","某个未知平台":"a2"}}"#,
            );
            let got = quota_current_accounts().expect("应 Ok");
            let mut platforms: Vec<&str> = got.iter().map(|e| e.platform.as_str()).collect();
            platforms.sort_unstable();
            assert_eq!(
                platforms,
                vec!["codebuddy-cn", "某个未知平台"],
                "原始 key 必须原样保留(不 normalize): {got:?}"
            );
        });
    }

    /// 用例 2：只存在 `provider_current_accounts.json` → 返回 1 条。
    #[test]
    fn current_accounts_with_only_provider_source_returns_one() {
        with_isolated_cockpit_root("only_provider", |root| {
            write_json(
                &root.join("provider_current_accounts.json"),
                r#"{"current_accounts":{"gemini":"g-1"}}"#,
            );
            let got = quota_current_accounts().expect("应 Ok");
            assert_eq!(got.len(), 1, "{got:?}");
            assert_eq!(got[0].platform, "gemini");
            assert_eq!(got[0].account_id, "g-1");
            assert_eq!(got[0].source, "provider_current_accounts");
        });
    }

    /// 用例 3：两个文件都不存在 → 返回**空 Vec**（不是 Err）。
    #[test]
    fn current_accounts_without_any_file_is_empty_not_error() {
        with_isolated_cockpit_root("none", |_root| {
            let got = quota_current_accounts().expect("两个文件都不存在不是错误");
            assert!(got.is_empty(), "应返回空 Vec: {got:?}");
        });
    }

    /// 用例 4：`provider_current_accounts.json` 是坏 JSON → 返回 **Err**。
    #[test]
    fn current_accounts_with_broken_json_is_error() {
        with_isolated_cockpit_root("broken", |root| {
            write_json(
                &root.join("provider_current_accounts.json"),
                "{ this is not json",
            );
            let err = quota_current_accounts().expect_err("坏 JSON 应返 Err");
            assert!(
                err.contains("provider_current_accounts.json"),
                "错误信息应指明是哪个文件: {err}"
            );
        });
    }

    /// 用例 5：`group_settings.json` 正常解析 —— 四个字段都对。
    #[test]
    fn model_groups_parses_full_settings() {
        with_isolated_cockpit_root("groups", |root| {
            write_json(
                &root.join("group_settings.json"),
                r#"{
                    "groupMappings": {"claude-sonnet-4-5": "claude_45", "gemini-3-pro-high": "g3_pro"},
                    "groupNames": {"claude_45": "Claude 4.5", "g3_pro": "Gemini Pro"},
                    "groupOrder": ["claude_45", "g3_pro"],
                    "updatedAt": 1785063641459,
                    "updatedBy": "desktop"
                }"#,
            );

            let got = quota_model_groups().expect("应 Ok");
            assert!(got.available, "文件存在 → available 必须为 true");
            assert_eq!(got.mappings.len(), 2, "{:?}", got.mappings);
            assert_eq!(
                got.mappings.get("claude-sonnet-4-5").map(String::as_str),
                Some("claude_45")
            );
            assert_eq!(
                got.mappings.get("gemini-3-pro-high").map(String::as_str),
                Some("g3_pro")
            );
            assert_eq!(
                got.names.get("claude_45").map(String::as_str),
                Some("Claude 4.5")
            );
            assert_eq!(
                got.names.get("g3_pro").map(String::as_str),
                Some("Gemini Pro")
            );
            assert_eq!(
                got.order,
                vec!["claude_45".to_string(), "g3_pro".to_string()]
            );
            assert_eq!(got.updated_at_ms, Some(1785063641459));
            assert_eq!(got.updated_by.as_deref(), Some("desktop"));
        });
    }

    /// 用例 6：★ `group_settings.json` 不存在 → `available == false` 且全空。
    ///
    /// **这条断言就是「没有套用 cockpit 默认分组」的锁**：cockpit 的
    /// `GroupSettings::default()`（只读参考 group_settings.rs:71-120）会兜底出
    /// `claude_45` / `g3_pro` / `g3_flash` 三组。我们**不复制**那套业务默认值——
    /// 复制过来会「改一处忘一处」地静默漂移，而且我们展示的是「落盘的事实」。
    /// 谁把默认值抄进来，本用例立刻挂。
    #[test]
    fn model_groups_without_file_does_not_apply_cockpit_defaults() {
        with_isolated_cockpit_root("no_groups", |_root| {
            let got = quota_model_groups().expect("文件不存在不是错误");
            assert!(!got.available, "文件不存在 → available 必须为 false");
            assert!(
                got.mappings.is_empty(),
                "不得套用 cockpit 默认分组: {:?}",
                got.mappings
            );
            assert!(
                got.names.is_empty(),
                "不得套用 cockpit 默认分组名: {:?}",
                got.names
            );
            assert!(
                got.order.is_empty(),
                "不得套用 cockpit 默认分组顺序: {:?}",
                got.order
            );
            assert_eq!(got.updated_at_ms, None);
            assert_eq!(got.updated_by, None);
            for default_id in ["claude_45", "g3_pro", "g3_flash"] {
                assert!(
                    !got.mappings.values().any(|v| v.as_str() == default_id),
                    "出现了 cockpit 默认分组 {default_id}: {:?}",
                    got.mappings
                );
            }
        });
    }

    /// **真机实测（2026-09-15）：吃真实的 `~/.antigravity_cockpit`，验证两个新命令真的出数。**
    ///
    /// 夹具测试只证明「我造的数据能解析」，不证明「现场读得出来」——
    /// 上一轮就是「解析测试全过、现场还是不出数」。这条直接读真机目录，把当前账号与
    /// 模型分组打出来，人眼可核对。用 `--ignored` 单独跑，CI 不跑。
    #[test]
    #[ignore = "依赖本机 ~/.antigravity_cockpit 真实数据,CI 不跑"]
    fn real_cockpit_dir_yields_current_accounts_and_model_groups() {
        // cockpit_root() 依赖 USERPROFILE/HOME —— 读真机必须持进程级锁，
        // 否则并发用例把主目录临时改走后,这条读到的就不是真机目录了。
        let _env = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let root = cockpit_root().expect("本机应有 ~/.antigravity_cockpit");

        let accounts = read_current_accounts(&root).expect("读当前账号不应为 Err");
        println!("[真机] 「当前账号」{} 条:", accounts.len());
        for a in &accounts {
            println!("    {} -> {}  (来源 {})", a.platform, a.account_id, a.source);
        }
        // 不变式：平台 key 不该是空串（空了就说明文件结构跟我们理解的不一样）
        assert!(
            accounts.iter().all(|a| !a.platform.trim().is_empty()),
            "出现空平台名，说明文件结构与预期不符"
        );

        let groups = read_model_groups(&root).expect("读模型分组不应为 Err");
        println!(
            "[真机] 模型分组 available={} | mappings={} 条 | order={:?} | updatedBy={:?}",
            groups.available,
            groups.mappings.len(),
            groups.order,
            groups.updated_by
        );
        for (model, group) in &groups.mappings {
            println!(
                "    {model} -> {group} ({})",
                groups.names.get(group).map(String::as_str).unwrap_or("—")
            );
        }
        // 刻意**不**断言"本机一定有值"：本机没数据只说明这台机器没配过，
        // 不说明源不支持（样本没有 ≠ 源不支持）。
    }

    // ── 账号分组 ──

    /// 用例 1：两个来源都在 → 各自解析正确，且**分开返回、不合并**。
    #[test]
    fn account_groups_parses_both_sources_separately() {
        with_isolated_cockpit_root("groups_both", |root| {
            write_json(
                &root.join("account_groups.json"),
                r#"[{"id":"grp_1","name":"生产","accountIds":["a1","a2"],"createdAt":1785063641459}]"#,
            );
            write_json(
                &root.join("codex_account_groups.json"),
                r#"[{"id":"grp_9","name":"Codex 主力","accountIds":["cx1"],"createdAt":1785063642000}]"#,
            );

            let got = quota_account_groups().expect("两个文件都在,应 Ok");
            assert!(got.available && got.codex_available);
            assert_eq!(got.groups.len(), 1);
            assert_eq!(got.codex_groups.len(), 1);
            assert_eq!(got.groups[0].id, "grp_1");
            assert_eq!(got.groups[0].name, "生产");
            assert_eq!(got.groups[0].account_ids, vec!["a1", "a2"]);
            assert_eq!(got.groups[0].created_at_ms, Some(1785063641459));
            assert_eq!(got.codex_groups[0].id, "grp_9");
            // 两个来源**不能串**：通用列表里不得出现 codex 的分组，反之亦然
            assert!(got.groups.iter().all(|g| g.id != "grp_9"));
            assert!(got.codex_groups.iter().all(|g| g.id != "grp_1"));
        });
    }

    /// 用例 2：两个文件都不存在 → `available == false` + 空列表，**不是 Err**。
    #[test]
    fn account_groups_missing_files_are_not_errors() {
        with_isolated_cockpit_root("groups_none", |_root| {
            let got = quota_account_groups().expect("文件不存在不是错误");
            assert!(!got.available && !got.codex_available);
            assert!(got.groups.is_empty());
            assert!(got.codex_groups.is_empty());
        });
    }

    /// 用例 3：坏 JSON → Err（要能看到是哪个文件，不静默吞掉）。
    #[test]
    fn account_groups_broken_json_is_error() {
        with_isolated_cockpit_root("groups_broken", |root| {
            write_json(&root.join("account_groups.json"), "{not json");
            let err = quota_account_groups().expect_err("坏 JSON 必须报错");
            assert!(
                err.contains("account_groups.json"),
                "错误信息应指出是哪个文件: {err}"
            );
        });
    }

    /// 用例 4：缺 `id` 或 `name` 的条目**整条跳过** —— 绝不给它编个名字。
    #[test]
    fn account_groups_skips_entries_without_id_or_name() {
        with_isolated_cockpit_root("groups_partial", |root| {
            write_json(
                &root.join("account_groups.json"),
                r#"[
                  {"id":"grp_ok","name":"正常","accountIds":["a1"]},
                  {"name":"没有 id","accountIds":["a2"]},
                  {"id":"grp_noname","accountIds":["a3"]},
                  {"id":"grp_empty_name","name":"   ","accountIds":["a4"]},
                  {"id":"grp_no_ids","name":"没有账号"}
                ]"#,
            );
            let got = quota_account_groups().expect("应 Ok");
            assert_eq!(
                got.groups.len(),
                2,
                "只应保留 grp_ok 与 grp_no_ids: {:?}",
                got.groups
            );
            assert_eq!(got.groups[0].id, "grp_ok");
            assert_eq!(got.groups[1].id, "grp_no_ids");
            assert!(
                got.groups[1].account_ids.is_empty(),
                "缺 accountIds → 空列表，不是错误"
            );
        });
    }

    /// 用例 5：**一个账号可以同时属于多个分组**（通用分组的真实语义，
    /// 见 cockpit `WakeupTasksPage.tsx:789-800` 的 `groupIdsByAccountId` 是 `string[]`）。
    ///
    /// Rust 侧**不做去重、不取第一个** —— 那是展示层的决定，这里必须原样保留。
    #[test]
    fn account_groups_one_account_can_belong_to_many() {
        with_isolated_cockpit_root("groups_multi", |root| {
            write_json(
                &root.join("account_groups.json"),
                r#"[
                  {"id":"grp_a","name":"生产","accountIds":["shared","only_a"]},
                  {"id":"grp_b","name":"测试","accountIds":["shared","only_b"]}
                ]"#,
            );
            let got = quota_account_groups().expect("应 Ok");
            let hit: Vec<&str> = got
                .groups
                .iter()
                .filter(|g| g.account_ids.iter().any(|id| id == "shared"))
                .map(|g| g.name.as_str())
                .collect();
            assert_eq!(hit.len(), 2, "shared 应同时属于两个分组: {hit:?}");
        });
    }

    /// 用例 6：文件是对象 `{}` 而不是数组 → 空列表，**不崩也不是 Err**。
    /// （cockpit 的校验器要求数组，但文件是外部可写的，残缺形态不该让整个命令失败。）
    #[test]
    fn account_groups_non_array_yields_empty_not_panic() {
        with_isolated_cockpit_root("groups_nonarray", |root| {
            write_json(&root.join("account_groups.json"), r#"{"groups":[]}"#);
            let got = quota_account_groups().expect("应 Ok");
            assert!(got.available, "文件存在 → available 为 true");
            assert!(got.groups.is_empty(), "非数组 → 空列表");
        });
    }

    /// **真机实测（2026-09-15）：吃真实的 `~/.antigravity_cockpit`，看账号分组到底有没有。**
    ///
    /// 不断言"本机一定有值"：本机没建过分组不代表源不支持（样本没有 ≠ 源不支持）。
    #[test]
    #[ignore = "依赖本机 ~/.antigravity_cockpit 真实数据,CI 不跑"]
    fn real_cockpit_dir_yields_account_groups() {
        // 同上:cockpit_root() 走 env,必须持锁后再读真机目录。
        let _env = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let root = cockpit_root().expect("本机应有 ~/.antigravity_cockpit");
        let got = read_account_groups(&root).expect("读账号分组不应为 Err");
        println!(
            "[真机] 通用分组 available={} / {} 组 | Codex 分组 available={} / {} 组",
            got.available,
            got.groups.len(),
            got.codex_available,
            got.codex_groups.len()
        );
        for g in &got.groups {
            println!("    通用: {} ({}) 账号 {} 个", g.name, g.id, g.account_ids.len());
        }
        for g in &got.codex_groups {
            println!("    Codex: {} ({}) 账号 {} 个", g.name, g.id, g.account_ids.len());
        }
    }
}
