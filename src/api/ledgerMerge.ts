/**
 * 账本读取层客户端：**多源合并口径**（PRD P0-15）。
 *
 * ## 为什么需要它
 *
 * P0-25 的对账（`ledgerQuery.ts`）已经出完证据并拍板：两源（`codex_logs` 网关请求 /
 * `codex_sessions` 会话）是**同一批数据的两个采集端**，logs 侧在网关故障/未走网关的日子漏记
 * （本机 10 个偏离天全部是 `sessions > logs`，吻合天连续 7 天差异 ≤1%）。
 * 合并口径定为：**按「天(UTC) × 模型」格取两源 token 更大的那个源（max），不相加**；
 * 只有单源有数据的天退回该源。
 *
 * ⚠️ **取大 ≠ 相加**：相加会把吻合天的用量**翻倍**。
 *
 * ## 红线
 *
 * - **只有量没有钱**：`MergedCell` 里**没有任何 cost 字段**，Rust 侧连
 *   `estimated_cost_usd` 都不搬运。计价唯一入口是前端
 *   `cockpitSplitCostUsd() × cockpitPriceBook.ts`（见 `mergeUsage.ts`）。
 * - **档位与来源无关**：两源都走同一个分档规则（`TokenSplit::add`，阈值 272_000），
 *   sessions 侧的格**同样带 long 档**。所以 `MergedCell` **没有 `graded` 字段** ——
 *   初版按来源标"未分档"是错的（2026-09-12 QA 复核纠正）。
 *   `winner` 只说明"这格用了哪个源"，`sessions` 侧 = 日志侧漏记、由会话源补上。
 * - 非桌面运行时 / 调用失败返 `null`，不抛错。
 */

import { invoke } from '@tauri-apps/api/core'
import { errMsg } from '@/stores/connection'
import { isDesktopRuntime as detectDesktop } from '@/api/url'
import i18n from '@/i18n'

const t = i18n.global.t

/** 一天的毫秒数。天桶 = UTC 日（与 Rust `DAY_MS` 同值）。 */
export const DAY_MS = 86_400_000

/** 6 档位 token 向量：标准档 / 长文本档 × 普通输入 / 缓存命中 / 输出。**纯量，无金额**。 */
export interface TierVector {
  stdNormalInput: number
  stdCached: number
  stdOutput: number
  longNormalInput: number
  longCached: number
  longOutput: number
}

/** 该格用了哪个源（Rust `MergeWinner`，camelCase 序列化）。 */
export type MergeWinner =
  /** 两源都有，logs 量更大（或平手 —— 平手取 logs，网关口径字段更全） */
  | 'logs'
  /** 两源都有，sessions 量更大 ⇒ logs 侧这天漏记，由会话源补上 */
  | 'sessions'
  /** 只有 logs 有数据 */
  | 'logsOnly'
  /** 只有 sessions 有数据 */
  | 'sessionsOnly'

/** winner 的中文标签。 */
export const MERGE_WINNER_LABELS: Readonly<Record<MergeWinner, string>> = Object.freeze({
  get logs() { return t('costCenter.api.logs') },
  get sessions() { return t('costCenter.api.sessions') },
  get logsOnly() { return t('costCenter.api.logsOnly') },
  get sessionsOnly() { return t('costCenter.api.sessionsOnly') },
})

/**
 * winner 是否来自 sessions 源 —— 即这格是"**日志侧漏记、由会话源补上**"。
 *
 * ⚠️ 只用于覆盖率统计，**与档位质量无关**（两源档位同源同规则）。
 */
export function isSessionsWinner(winner: MergeWinner): boolean {
  return winner === 'sessions' || winner === 'sessionsOnly'
}

/** 一个**已合并**的用量格：天(UTC) × 模型 × 账号 × key。 */
export interface MergedCell {
  /** UTC 日桶起点（epoch ms） */
  dayBucketMs: number
  modelId: string
  sourceAccountId: string
  apiKeyId: string
  /** 胜出源的 6 档位 token（**不是两源相加**） */
  tokens: TierVector
  requests: number
  success: number
  error: number
  winner: MergeWinner
  /** 两源在该「天 × 模型」格都有数据（真正的"取大"格） */
  bothPresent: boolean
  /** 该格 logs 侧 token 合计（0 = 该格 logs 无数据，是事实不是缺失） */
  logsTokens: number
  /** 该格 sessions 侧 token 合计 */
  sessionsTokens: number
}

/**
 * 覆盖率：**有多少天的量是靠会话源补上的（日志侧漏记）**。
 *
 * ⚠️ 这是"来源补全"，**不是"没分档"** —— 两源档位同源同规则，
 * sessions 侧的量同样带 long 档，成本照常按 ×2/×2/×1.5 计。
 */
export interface TierCoverage {
  /** 由会话源补全的天数（该天至少有一个格的 winner 来自 sessions） */
  sessionsBackfilledDays: number
  /** 这些**补全格**的 token 合计（同天 logs 胜出的格不计入） */
  sessionsBackfilledTokens: number
  /**
   * **合并结果**里的长文本文档位占比 = `long / (std + long)`。
   * 没有用量数据（分母为 0）时为 null —— **不编 0**。
   */
  longRatioObserved: number | null
}

/** `ledger_merged_usage` 的返回。 */
export interface MergedUsageResult {
  available: boolean
  /** 不可用原因（标注型空值） */
  reason: string | null
  cells: MergedCell[]
  coverage: TierCoverage
  /** 有量的首日 / 末日（UTC 日桶）；无数据时为 null，不编 0 */
  windowStartMs: number | null
  windowEndMs: number | null
}

/** 合并口径用量（P0-15）。`windowDays` 省略/为 null = 全量。失败返 null，不抛错。 */
export async function mergedLedgerUsage(
  windowDays?: number | null,
): Promise<MergedUsageResult | null> {
  if (!detectDesktop()) return null
  try {
    return await invoke<MergedUsageResult>('ledger_merged_usage', {
      windowDays: windowDays ?? null,
    })
  } catch (e) {
    console.warn('[ledger] 合并口径用量读取失败:', errMsg(e, '未知错误'))
    return null
  }
}

/** 6 档位合计（与 Rust `TierVector::total` 同口径）。 */
export function tierVectorTotal(tokens: TierVector): number {
  return (
    tokens.stdNormalInput
    + tokens.stdCached
    + tokens.stdOutput
    + tokens.longNormalInput
    + tokens.longCached
    + tokens.longOutput
  )
}

/** 长文本档合计（input + cached + output）。 */
export function tierVectorLong(tokens: TierVector): number {
  return tokens.longNormalInput + tokens.longCached + tokens.longOutput
}

/** 明细行（补上可读日期与合计，便于排序/展示）。 */
export interface MergedCellRow extends MergedCell {
  /** UTC 日 `YYYY-MM-DD`（与 Rust 天桶同口径，**不得用本地时区**） */
  day: string
  /** 该行 token 合计 */
  totalTokens: number
  /** winner 中文标签 */
  winnerLabel: string
}

/** 明细行，按天升序、同天按 token 降序（与 Rust 侧排序一致）。 */
export function mergedCellRows(result: MergedUsageResult | null): MergedCellRow[] {
  const cells = result?.cells ?? []
  return cells
    .map((c) => ({
      ...c,
      day: new Date(c.dayBucketMs).toISOString().slice(0, 10),
      totalTokens: tierVectorTotal(c.tokens),
      winnerLabel: MERGE_WINNER_LABELS[c.winner] ?? c.winner,
    }))
    .sort(
      (a, b) =>
        a.dayBucketMs - b.dayBucketMs
        || b.totalTokens - a.totalTokens
        || a.modelId.localeCompare(b.modelId),
    )
}

/**
 * 一句话状态（资产总览脚注用）：口径**已定案**（"按天 × 模型取大"）。
 *
 * "由会话源补全的天数"由 `mergeUsage.ts` 的 `mergeCoverageLabel()` 补上 ——
 * 那是计价衔接层的事，本模块（api 层）只负责把 Rust 的原样数据搬回来，不解释覆盖率。
 */
export function describeMergedUsage(result: MergedUsageResult | null): string {
  if (!result) return t('costCenter.api.mergeNotRun')
  if (!result.available) return t('costCenter.api.mergeUnavailable', { reason: result.reason ?? t('costCenter.api.ledgerMissing') })
  if (result.cells.length === 0) return t('costCenter.api.mergeStatus', { reason: result.reason ?? t('costCenter.api.noUsage') })
  return t('costCenter.api.mergePolicy')
}
