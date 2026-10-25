/**
 * 账本读取层客户端：**多源对账**（PRD P0-25）+ 源清单。
 *
 * ## 为什么需要它
 *
 * 账本已能分源落库（`codex_logs` + `codex_sessions`），但**读取层刻意不合并**：
 * 用户拍板"**先对账再定**"，合并口径（P0-15）**被本项阻塞**。
 * 本模块的唯一职责是**出证据** —— 按 `(天, 模型)` 并列两源 token、算差额、
 * 给出"同一批 / 不同批次"的**可复核**结论。
 *
 * ## 结论是启发式，必须把数字一起显示
 *
 * "同一批 / 不同批次"没有理论判据。Rust 侧用**重叠区两源差异比**做启发式判断，
 * 并把**测得的比值、阈值、重叠区间**一并返回。
 * **UI 必须展示这些数字**，让用户能自己复核 —— 只显示一个结论词是不负责任的。
 *
 * ## 红线
 *
 * - **不产出总额**：两源数字永远并列。合并是 P0-15 的事，须等用户拍板。
 * - 非桌面运行时返 null / 空数组，不抛错。
 */

import { invoke } from '@tauri-apps/api/core'
import { errMsg } from '@/stores/connection'
import { isDesktopRuntime as detectDesktop } from '@/api/url'
import i18n from '@/i18n'

const t = i18n.global.t

/** 对账结论（Rust `ReconcileVerdict`，camelCase 序列化）。 */
export type ReconcileVerdict =
  | 'noOverlap'
  | 'insufficientData'
  | 'likelySameBatch'
  | 'likelyDifferentBatch'
  /**
   * **混合**：多数重叠天两源吻合，少数天显著偏离。
   *
   * 为什么单列这一档（2026-09-12 实测）：整体差异比会被**少数异常天**拉高，
   * 只看总比值会把"多数天吻合"误判成"整体不同批次"。本机实测 32 个重叠天里
   * 多数天差额在 1% 内（08-26 差额仅 −50,331 / 7.2 亿 ≈ 0.007%），
   * 而 07-29 一天 sessions 是 logs 的 10 倍。这种结构下**必须逐天决定**。
   */
  | 'mixedBatch'

/** 一个偏离显著的重叠天（证据明细）。 */
export interface DivergentDay {
  dayBucketMs: number
  /** UTC 日 `YYYY-MM-DD` */
  day: string
  logsTokens: number
  sessionsTokens: number
  tokenDiff: number
  /** 该天差异比 */
  divergence: number
}

/** 一个 `(天, 模型)` 格的两源并列数字。 */
export interface ReconcileCell {
  /** UTC 日桶起点（epoch ms） */
  dayBucketMs: number
  modelId: string
  logsTokens: number
  logsRequests: number
  sessionsTokens: number
  sessionsRequests: number
  /** `sessions − logs`（正 = 会话源更多） */
  tokenDiff: number
  requestsDiff: number
  /** 两源在该格**都有量** ⇒ 真正的重叠格（最该看的行） */
  overlap: boolean
}

/** 单个源在窗口内的合计。 */
export interface SourceTokenTotals {
  sourceName: string
  label: string
  tokens: number
  requests: number
  days: number
  firstMs: number | null
  lastMs: number | null
}

/** `ledger_reconcile_sources` 的返回。 */
export interface ReconcileResult {
  available: boolean
  reason: string | null
  cells: ReconcileCell[]
  sources: SourceTokenTotals[]
  overlapStartMs: number | null
  overlapEndMs: number | null
  overlapDays: number
  /** **只统计交集区间**内的两源 token 合计 */
  overlapLogsTokens: number
  overlapSessionsTokens: number
  /** 差异比 = `|sessions − logs| / max(两者)`；两者皆 0 时为 null（不编造 0） */
  overlapDivergence: number | null
  /** 重叠天里**差异 ≤ 阈值**的天数（两源吻合 ⇒ 同一批） */
  overlapDaysClose: number
  /** 重叠天里**差异 > 阈值**的天数（两源偏离 ⇒ 不同批次） */
  overlapDaysDivergent: number
  /**
   * 偏离最严重的重叠天（按差异比降序，最多 5 条）。
   *
   * 必须展示：整体差异比会被少数异常天拉高，只看总比值会把"多数天吻合"
   * 误判成"整体不同批次"。这些异常天是用户拍板的关键证据。
   */
  topDivergentDays: DivergentDay[]
  /** 判定所用阈值（原样返回，供复核） */
  divergenceThreshold: number
  verdict: ReconcileVerdict
  verdictReason: string
  /** 口径 A 的 `T0` = logs 源最早时间（运行时探测） */
  t0Ms: number | null
}

/** 账本里的一个源（含水位与已落库量）。 */
export interface LedgerSourceInfo {
  sourceName: string
  label: string
  sourcePath: string
  lastId: number
  lastTsMs: number
  lastIngestMs: number
  totalRowsSeen: number
  resetGeneration: number
  rows: number
  tokens: number
  requests: number
  firstMs: number | null
  lastMs: number | null
}

/** 多源对账（P0-25）。`windowDays` 省略/为 null = 全量。 */
export async function reconcileLedgerSources(
  windowDays?: number | null,
): Promise<ReconcileResult | null> {
  if (!detectDesktop()) return null
  try {
    return await invoke<ReconcileResult>('ledger_reconcile_sources', {
      windowDays: windowDays ?? null,
    })
  } catch (e) {
    console.warn('[ledger] 多源对账失败:', errMsg(e, '未知错误'))
    return null
  }
}

/** 列出账本里的全部源。失败返回空数组（不抛错）。 */
export async function listLedgerSources(): Promise<LedgerSourceInfo[]> {
  if (!detectDesktop()) return []
  try {
    const list = await invoke<LedgerSourceInfo[]>('ledger_list_sources')
    return Array.isArray(list) ? list : []
  } catch (e) {
    console.warn('[ledger] 读源清单失败:', errMsg(e, '未知错误'))
    return []
  }
}

/** 结论的中文标签。 */
export const RECONCILE_VERDICT_LABELS: Record<ReconcileVerdict, string> = {
  get noOverlap() { return t('costCenter.api.noOverlap') },
  get insufficientData() { return t('costCenter.api.insufficientData') },
  get likelySameBatch() { return t('costCenter.api.sameBatch') },
  get likelyDifferentBatch() { return t('costCenter.api.differentBatch') },
  get mixedBatch() { return t('costCenter.api.mixedBatch') },
}

/** 结论的语气（UI 配色）：ok = 已有明确结论；warn = 需要用户拍板；unknown = 证据不足。 */
export function reconcileVerdictTone(verdict: ReconcileVerdict): 'ok' | 'warn' | 'unknown' {
  if (verdict === 'likelyDifferentBatch' || verdict === 'mixedBatch') return 'warn'
  if (verdict === 'likelySameBatch' || verdict === 'noOverlap') return 'ok'
  return 'unknown'
}

/** UTC 日 `YYYY-MM-DD`（与 Rust 侧天桶同口径，**不得用本地时区**）。 */
export function formatUtcDay(dayBucketMs: number): string {
  return new Date(dayBucketMs).toISOString().slice(0, 10)
}

/** 差异比的展示文案。`null` → 「无法比较」（**不是 0%**）。 */
export function formatDivergence(divergence: number | null): string {
  if (divergence == null) return t('costCenter.api.cannotCompare')
  return `${(divergence * 100).toFixed(1)}%`
}

/** 对账明细行（补上可读日期与合计，便于排序/展示）。 */
export interface ReconcileCellRow extends ReconcileCell {
  day: string
  /** 两源合计（仅用于排序与"这一格有多少量"的直觉判断，**不是合并口径**） */
  totalTokens: number
  /** 差异比；两源合计为 0 时为 null */
  divergence: number | null
}

/** 明细行，按天升序、同天按两源合计量降序（与 Rust 侧排序一致，便于对拍）。 */
export function reconcileCellRows(result: ReconcileResult | null): ReconcileCellRow[] {
  const cells = result?.cells ?? []
  return cells
    .map((c) => {
      const totalTokens = c.logsTokens + c.sessionsTokens
      const mx = Math.max(c.logsTokens, c.sessionsTokens)
      return {
        ...c,
        day: formatUtcDay(c.dayBucketMs),
        totalTokens,
        divergence: mx > 0 ? Math.abs(c.tokenDiff) / mx : null,
      }
    })
    .sort(
      (a, b) =>
        a.dayBucketMs - b.dayBucketMs ||
        b.totalTokens - a.totalTokens ||
        a.modelId.localeCompare(b.modelId),
    )
}

/**
 * 一句话摘要（资产总览页的「合并口径待定」脚注用）。
 *
 * **必须**同时给出：结论 + 逐天结构（吻合/偏离天数）+ "待拍板"的状态。
 * P0-25 未出证据前 P0-15 不得定案，因此这里永远不能说"已定案"。
 * 只报总差异比是不够的 —— 它会被少数异常天拉高。
 */
export function describeReconcile(result: ReconcileResult | null): string {
  if (!result) return t('costCenter.api.reconcileNotRun')
  if (!result.available) return t('costCenter.api.reconcileUnavailable', { reason: result.reason ?? t('costCenter.api.ledgerMissing') })
  if (result.cells.length === 0) return t('costCenter.api.reconcileEmpty')
  const verdict = RECONCILE_VERDICT_LABELS[result.verdict]
  if (result.overlapDays === 0) {
    return t('costCenter.api.reconcileNoOverlap', { verdict })
  }
  const structure = t('costCenter.api.reconcileStructure', { close: result.overlapDaysClose, divergent: result.overlapDaysDivergent })
  return t('costCenter.api.reconcileSummary', { verdict, days: result.overlapDays, structure, divergence: formatDivergence(result.overlapDivergence) })
}

/** 源清单的一行文案（水位 + 落库量）。 */
export function describeLedgerSourceRow(info: LedgerSourceInfo): string {
  const parts = [
    t('costCenter.api.watermark', { value: info.lastId }),
    t('costCenter.api.ledgerRows', { value: info.rows }),
    t('costCenter.api.requests', { value: info.requests }),
  ]
  if (info.resetGeneration > 0) parts.push(t('costCenter.api.sourceGeneration', { value: info.resetGeneration }))
  return parts.join(' · ')
}
