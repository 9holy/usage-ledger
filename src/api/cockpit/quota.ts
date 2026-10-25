/**
 * 渠道配额客户端（`src-tauri/src/cockpit_quota.rs`，二期 T14 / PRD P0-21）。
 *
 * ## 为什么必须有这一层（2026-09-12）
 *
 * Rust 侧 `quota_list_channels` / `quota_snapshots` / `quota_refresh` / `quota_history`
 * 四个命令已经写好（含 20 渠道语义表 + `percentage` 方向归一化单点），
 * 但**全仓前端零调用** —— 于是"每个渠道账号用了多少"这个能力对用户不可见。
 *
 * ## 三条路径（PRD §6 P0-21）
 *
 * - **B｜落盘快照**（默认，零外网请求）：读 cockpit 已写盘的 `quota` / `*_usage_raw`
 *   + `cache/quota_api_v1_*`。数据是"上次刷新时刻"的快照。
 * - **A｜实时**（用户主动点"立即刷新"）：本轮 `LiveApiProvider` 恒失败并降级回 B
 *   （合规考量，只留插槽）。失败**不阻塞**，返回 `liveError` 供 UI 提示。
 * - C｜离线 IDE 库：kiro / windsurf 的补充路径，Rust 侧按需回退。
 *
 * ## UI 铁律（P0-21 验收②⑤）
 *
 * 每处用量**必须**标注数据时间戳与来源类型（`实时` / `落盘快照`），
 * 用量不可得（API Key 类账号）显示"**用量不可得**"而**不是 0%**。
 * 不标注时间戳的用量数字等于骗用户。
 */

import { invoke } from '@tauri-apps/api/core'
import { errMsg } from '@/stores/connection'
import { isDesktopRuntime as detectDesktop } from '@/api/url'
import i18n from '@/i18n'

const t = i18n.global.t

const NOT_DESKTOP_MSG = '渠道配额需要桌面运行时（Tauri）'

/** `percentage` 的原始语义（Rust `PercentKind`，serde lowercase）。 */
export type QuotaPercentKind = 'remaining' | 'used'

/** 数据来源类型（Rust `QuotaSourceKind`）。 */
export type QuotaSourceKind = 'snapshot' | 'live'

/** 配额窗口类型（Rust `QuotaWindowKind`）。5h 窗口不参与月费分摊。 */
export type QuotaWindowKind = 'fiveHour' | 'weekly' | 'monthly' | 'unknown'

/** 渠道探测结果（P1-13：没账号的渠道不占位）。 */
export interface QuotaChannelSummary {
  channel: string
  accountCount: number
  dir: string
  hasAccounts: boolean
  usesDesktopCache: boolean
  /** 该渠道声明的 `percentage` 语义；null = 未声明（Rust 侧会报错，不会静默兜底）。 */
  percentKind: QuotaPercentKind | null
}

/** 一条归一化后的配额快照。**前端只看这个结构**。 */
export interface QuotaSnapshot {
  channel: string
  accountId: string
  email: string
  /** 空串 = 该渠道不按模型分（账号级配额）。 */
  modelId: string
  /** Native quota scope; a model-specific limit is not an account-wide limit. */
  scope?: string
  displayName: string
  /** ★ 已归一化为"剩余%"（0..100）。**null = 用量不可得，绝不是 0**。 */
  percent: number | null
  /** 剩余比例（0..1），P0-22 配额分摊成本的唯一消费口径。 */
  remainingFraction: number | null
  usedFraction: number | null
  /** 原始语义（审计用：让上层知道这个数是不是被翻转过）。 */
  percentKind: QuotaPercentKind | null
  /** ★ 非空 = 用量不可得（API Key 类等）。 */
  unavailableReason: string | null
  windowKind: QuotaWindowKind
  windowStartedAtMs: number | null
  resetAtMs: number | null
  source: QuotaSourceKind
  /** 本次读取时刻。 */
  fetchedAtMs: number
  /** 数据自身的落盘时刻（cockpit `updatedAt`）。 */
  updatedAtMs: number | null
  /** 数据自身时间戳已超过 TTL → UI 应显示"数据可能过期"。 */
  stale: boolean
  /** 原始来源标识（如 `cache/quota_api_v1_desktop/authorized`）。 */
  rawKind: string
  sourceError?: string | null
  /** ★ 账号套餐/档位（`plus` / `pro` / `team` / `API_KEY` / `Google AI Pro` …）。
   *  **null = 源里没有或账号详情加密读不到** → UI 显示 `—`，绝不用 0/猜测值冒充。
   *  来源见 Rust `plan_of()`：各渠道账号详情里的 plan_type / plan_name / plan_raw /
   *  membership_type / copilot_plan / subscription_tier。 */
  plan: string | null
}

export interface QuotaHistoryPoint {
  timestampMs: number
  remainingPercentage: number
  remainingFraction: number
  resetAtMs: number | null
  countdownSeconds: number | null
}

export interface QuotaHistorySeries {
  email: string
  modelKey: string
  label: string
  points: QuotaHistoryPoint[]
}

export interface QuotaRefreshResult {
  snapshots: QuotaSnapshot[]
  /** 非空 = 实时刷新失败已降级到落盘快照，UI 应提示原因（如 403）。 */
  liveError: string | null
  source: QuotaSourceKind
  fetchedAtMs: number
}

/** 命令 1：探测哪些渠道有账号。 */
export async function getQuotaChannels(): Promise<QuotaChannelSummary[]> {
  if (!detectDesktop()) {
    console.warn(`[quota] ${NOT_DESKTOP_MSG}`)
    return []
  }
  try {
    return await invoke<QuotaChannelSummary[]>('quota_list_channels')
  } catch (e) {
    console.warn('[quota] 列渠道失败:', errMsg(e, '未知错误'))
    return []
  }
}

/** 命令 2：读某渠道的配额快照（路径 B，零外网请求）。 */
export async function getQuotaSnapshots(channel: string): Promise<QuotaSnapshot[]> {
  if (!detectDesktop()) return []
  try {
    return await invoke<QuotaSnapshot[]>('quota_snapshots', { channel })
  } catch (e) {
    console.warn(`[quota] 读 ${channel} 配额失败:`, errMsg(e, '未知错误'))
    return []
  }
}

/**
 * 命令 3：路径 A（实时）优先，失败自动降级到路径 B。
 *
 * 只在用户点"立即刷新"时调用 —— 默认路径**绝不**发外网请求（P0-21 验收③）。
 */
export async function refreshQuotaSnapshots(channel: string): Promise<QuotaRefreshResult | null> {
  if (!detectDesktop()) return null
  try {
    return await invoke<QuotaRefreshResult>('quota_refresh', { channel })
  } catch (e) {
    console.warn(`[quota] 刷新 ${channel} 配额失败:`, errMsg(e, '未知错误'))
    return null
  }
}

/** 命令 4：读配额历史时间序列（cockpit 百分比进度条的数据源）。`email` 空 = 全部。 */
export async function getQuotaHistory(email = ''): Promise<QuotaHistorySeries[]> {
  if (!detectDesktop()) return []
  try {
    return await invoke<QuotaHistorySeries[]>('quota_history', { email })
  } catch (e) {
    console.warn('[quota] 读配额历史失败:', errMsg(e, '未知错误'))
    return []
  }
}

/** 来源类型中文标签（UI 铁律：必须显示）。 */
export function quotaSourceLabel(source: QuotaSourceKind): string {
  return source === 'live' ? t('costCenter.api.quotaLive') : t('costCenter.api.quotaSnapshot')
}

/** 窗口类型中文标签。 */
export function quotaWindowLabel(kind: QuotaWindowKind): string {
  switch (kind) {
    case 'fiveHour':
      return t('costCenter.api.fiveHourWindow')
    case 'weekly':
      return t('costCenter.api.weeklyWindow')
    case 'monthly':
      return t('costCenter.api.monthlyWindow')
    default:
      return t('costCenter.api.windowUnknown')
  }
}

/** `updatedAtMs` 未知时，chip / 单元格里那句中性说明（解释这里为什么没有「可能过期」）。 */
export function quotaNoUpdatedAtNote(): string { return t('costCenter.api.noSavedAt') }

/** `MM-DD HH:mm`（本地时区）。 */
function formatStampText(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 把快照的"数据时间戳"格式化成 `落盘快照·09-11 03:20` 这种可读标签（UI 铁律要求）。
 *
 * ★ 不可得的快照**不给时间戳**（2026-09-12 真机核对发现）：
 * 此时 `updatedAtMs`（数据本身的时间）读不到，若退回 `fetchedAtMs`（我们读取的时刻），
 * 界面会显示成「用量不可得 · 09-12 23:38」—— 时间戳是刚才，暗示"刚查过、确认没有用量"。
 * 但真相是我们**根本读不到数据**（账号文件加密），那不是一个数据时间。这样标是骗人。
 * 只给来源类型，不编造时间。
 *
 * ★ 落盘时刻未知时改称「读取于」（2026-09-15 诚实性修复）：
 * 数据源不提供自己的落盘时刻（`updatedAtMs === null`）时，原写法兜底成 `fetchedAtMs`，
 * 界面于是显示「落盘快照·09-11 03:20」—— 把"**我们什么时候算的**"冒充成
 * "**数据什么时候落盘的**"。更糟的是 `stale` 由 `updated_at_ms` 判定，为 null 时恒为
 * `false`，界面上连「（可能过期）」都不会出现，用户看到的是一句无提示的乐观假话。
 *
 * `fetchedAtMs` 是我们**确实知道**的事实（"我们在这个时刻读到了这批数据"），
 * 数据的落盘时刻我们**并不知道**。所以只能说「读取于」，不能说「落盘于」；
 * 并附一句中性说明，让用户知道为什么这里没有「可能过期」标记。
 */
export function quotaStampLabel(snapshot: QuotaSnapshot): string {
  const kind = quotaSourceLabel(snapshot.source)
  if (snapshot.unavailableReason || snapshot.percent == null) return kind
  if (snapshot.updatedAtMs == null) {
    return t('costCenter.api.readAt', { time: formatStampText(snapshot.fetchedAtMs), note: quotaNoUpdatedAtNote() })
  }
  const text = formatStampText(snapshot.updatedAtMs)
  return t(snapshot.stale ? 'costCenter.api.quotaStaleStamp' : 'costCenter.api.quotaStamp', { source: kind, time: text })
}

/**
 * 快照数据**距今多久**（毫秒）。`null` = 数据自身的落盘时刻不可知，年龄无从谈起。
 *
 * ★ 只认 `updatedAtMs`（数据本身的时间），**绝不退回 `fetchedAtMs`**（2026-09-15）：
 * 退回等于把"我们刚刚读了它"当成"数据刚刚落盘"，界面会显示年龄「刚刚」——
 * 于是一个 47 天前写入、今天才被读到的缓存，也会被说成"刚刚"，与"47 天前"的
 * 保守口径自相矛盾，正是"让时间戳看起来比实际更新"。落盘时刻未知时返回 `null`，
 * 由调用方显示空/「—」，**不编造年龄**。
 */
export function quotaAgeMs(snapshot: QuotaSnapshot, nowMs: number = Date.now()): number | null {
  const stamp = snapshot.updatedAtMs
  if (stamp == null || !Number.isFinite(stamp)) return null
  const age = nowMs - stamp
  return age >= 0 ? age : null
}

/**
 * 快照数据的"年龄"文案：`刚刚` / `12 分钟前` / `3 小时前` / `47 天前`。
 *
 * ★ 为什么必须有它（2026-09-12 现场教训）：cockpit 的桌面缓存**可能停更**。
 *   实测本机 `cache/quota_api_v1_desktop/authorized/` 11 份文件的 `updatedAt`
 *   停在 47 天前，全部写着 `remainingFraction: 1`。修好关联后这些数字能出来了，
 *   但**它们早已不代表当前用量** —— 只标一句"可能过期"太弱，用户会把
 *   47 天前的「剩余 100%」当成现在还剩 100%。所以必须把年龄明确说出来。
 *
 * 与 P0-21「不静默变 0」同源：不撒谎，不静默给错值。
 */
export function quotaAgeLabel(snapshot: QuotaSnapshot, nowMs: number = Date.now()): string {
  const age = quotaAgeMs(snapshot, nowMs)
  return age == null ? '' : formatAgeMs(age)
}

/** 把"毫秒年龄"格式化成 `刚刚` / `12 分钟前` / `3 小时前` / `47 天前`。
 *  单独导出是为了让调用方能先聚合出**最老**那条再统一格式化，避免口径不一致。 */
export function formatAgeMs(age: number): string {
  if (!Number.isFinite(age) || age < 0) return ''
  const MINUTE = 60_000
  const HOUR = 60 * MINUTE
  const DAY = 24 * HOUR
  if (age < MINUTE) return t('costCenter.api.justNow')
  if (age < HOUR) return t('costCenter.api.minutesAgo', { count: Math.floor(age / MINUTE) })
  if (age < DAY) return t('costCenter.api.hoursAgo', { count: Math.floor(age / HOUR) })
  return t('costCenter.api.daysAgo', { count: Math.floor(age / DAY) })
}

/**
 * 单条快照的展示文案。
 *
 * ★ 用量不可得时返回"用量不可得"，**不返回 0%**（P0-21 验收⑤ / P1-12）。
 */
export function quotaPercentLabel(snapshot: QuotaSnapshot): string {
  if (snapshot.unavailableReason || snapshot.percent == null) return t('costCenter.api.quotaUnavailable')
  return `${snapshot.percent.toFixed(1)}%`
}

// ──────────────── 「当前账号」与「模型分组」（2026-09-15 新增） ────────────────
//
// 用户要求「只要是使用数据都要接进来」。判定依据是 **cockpit 源码的结构体定义**，
// 不是本机样本里有没有值 —— 样本没有 ≠ 源不支持。

/** 「当前账号」一条记录（Rust `CurrentAccountEntry`）。 */
export interface CurrentAccountEntry {
  /** 文件里的原始 key，**未做任何归一化**（实测有 `gemini` / `github_copilot` / `trae_solo`）。 */
  platform: string
  /** 账号 id。 */
  accountId: string
  /** 来源：`provider_current_accounts`（cockpit 主源）或 `antigravity_runtime`（外部运行时插件）。 */
  source: string
}

/** 模型分组配置（Rust `ModelGroups`，来自 `group_settings.json`）。 */
export interface ModelGroups {
  /** 是否读到了 `group_settings.json`。false = 未落盘，UI 必须全显示 `—`。 */
  available: boolean
  /** modelId → groupId */
  mappings: Record<string, string>
  /** groupId → 显示名 */
  names: Record<string, string>
  /** groupId 顺序（cockpit 可自定义）。 */
  order: string[]
  /** `group_settings.json` 的 updatedAt（毫秒）。 */
  updatedAtMs: number | null
  /** 最后更新来源（`desktop` / `plugin`）。 */
  updatedBy: string | null
}

/** 命令 5：读 cockpit 的「当前账号」映射（provider_current_accounts.json + antigravity 运行时）。 */
export async function getQuotaCurrentAccounts(): Promise<CurrentAccountEntry[]> {
  if (!detectDesktop()) return []
  try {
    return await invoke<CurrentAccountEntry[]>('quota_current_accounts')
  } catch (e) {
    console.warn('[quota] 读当前账号失败:', errMsg(e, '未知错误'))
    return []
  }
}

/**
 * 命令 6：读 cockpit 的模型分组配置（`group_settings.json`）。
 *
 * ★ `null` = 读不到（非桌面 / 命令失败）；`available: false` = 文件未落盘。
 *   两者 UI 都必须显示 `—`，**绝不套用 cockpit 源码里的默认分组** ——
 *   那是 cockpit 的兜底行为，不是"用户配过"的事实。展示兜底值等于替用户
 *   声称一份他从未见过的配置。
 */
export async function getQuotaModelGroups(): Promise<ModelGroups | null> {
  if (!detectDesktop()) return null
  try {
    return await invoke<ModelGroups>('quota_model_groups')
  } catch (e) {
    console.warn('[quota] 读模型分组失败:', errMsg(e, '未知错误'))
    return null
  }
}

/**
 * 把渠道 ID 或平台 key 归一成可比较形式：小写 + 连字符转下划线。
 *
 * ★ 为什么需要它（2026-09-15）：两边拼写**本来就不一致**。
 *   渠道 ID 用的是 cockpit 平台常量（`github-copilot`，带连字符），
 *   而 `provider_current_accounts.json` 的 key 是归一化后的平台名
 *   （`github_copilot`，下划线，见 cockpit `provider_current_state.rs:29-49`
 *   的 `normalize_platform`）。不做这一步，`github-copilot` 永远匹配不上。
 */
export function normalizePlatformKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/-/g, '_')
}

/**
 * 取某渠道的「当前账号」id。无记录返回 `null`（UI 显示 `—`）。
 *
 * 多个来源命中同一渠道时取**第一个**（Rust 侧已按 platform + source 排序，顺序稳定）。
 */
export function currentAccountIdFor(entries: CurrentAccountEntry[], channel: string): string | null {
  const want = normalizePlatformKey(channel)
  if (!want) return null
  const hit = entries.find((e) => normalizePlatformKey(e.platform) === want)
  return hit ? hit.accountId : null
}

/** 取某模型所属分组的显示名。取不到返回 `null`（UI 显示 `—`，不编造分组名）。 */
export function modelGroupLabelFor(groups: ModelGroups | null, modelId: string): string | null {
  if (!groups || !groups.available || !modelId) return null
  const groupId = groups.mappings[modelId]
  if (!groupId) return null
  return groups.names[groupId] ?? groupId
}

// ──────────────── 「账号分组」（2026-09-15 新增） ────────────────
//
// cockpit 里用户**手动**给账号打的标签（不是自动统计出来的使用数据）。
// 它在 cockpit 内的真正用途是「筛选 + 批量操作」（账号列表按分组过滤、唤醒任务按组选账号），
// 我们这边只做**只读展示**：某个账号被归到了哪些分组。

/** 一个账号分组（Rust `AccountGroupEntry`）。 */
export interface AccountGroupEntry {
  id: string
  name: string
  /** 该分组包含的账号 id。**可能含已删除账号**（cockpit 自己会过滤）。 */
  accountIds: string[]
  createdAtMs: number | null
}

/** 账号分组配置（Rust `AccountGroups`）。**两个来源分开返回，不合并**。 */
export interface AccountGroups {
  /** 通用分组 `account_groups.json` 是否读到。 */
  available: boolean
  /** 通用分组：可装任何渠道的账号，**一个账号可属于多个**。 */
  groups: AccountGroupEntry[]
  /** Codex 专用分组 `codex_account_groups.json` 是否读到。 */
  codexAvailable: boolean
  /** Codex 专用分组。 */
  codexGroups: AccountGroupEntry[]
}

/** 命令 7：读 cockpit 的账号分组（通用 + Codex 专用，两个独立来源）。 */
export async function getQuotaAccountGroups(): Promise<AccountGroups | null> {
  if (!detectDesktop()) return null
  try {
    return await invoke<AccountGroups>('quota_account_groups')
  } catch (e) {
    console.warn('[quota] 读账号分组失败:', errMsg(e, '未知错误'))
    return null
  }
}

/**
 * 取某账号所属的分组名列表。返回 `[]` = 没有任何分组包含它（UI 显示 `—`）。
 *
 * ★ 三条口径（都对应 cockpit 侧的真实语义，不是随手定的）：
 *
 * 1. **两个来源都查**。通用分组（`account_groups.json`）与 Codex 专用分组
 *    （`codex_account_groups.json`）是两套不相干的机制，同一个账号可能只出现在其中一边 ——
 *    只查一边会漏。
 * 2. **不取第一个**。通用分组里一个账号**可以属于多个分组**
 *    （cockpit `WakeupTasksPage.tsx:789-800` 的 `groupIdsByAccountId` 是 `string[]`）。
 *    取第一个会吞掉其余标签。
 * 3. **去重后按名字排序**。两个来源可能有同名分组；去重避免显示成「生产 / 生产」，
 *    排序保证同一账号每次渲染顺序一致。
 *
 * 只做展示，**不做任何统计** —— 所以"合并两个来源"在这里是安全的：
 * 我们只是在回答"这个账号被贴了哪些标签"。
 */
export function groupLabelsFor(groups: AccountGroups | null, accountId: string): string[] {
  if (!groups || !accountId) return []
  const names = new Set<string>()
  for (const list of [groups.groups, groups.codexGroups]) {
    for (const g of list) {
      if (g.accountIds.includes(accountId)) names.add(g.name)
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b))
}
