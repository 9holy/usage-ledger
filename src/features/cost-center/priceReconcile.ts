import { costDataText } from './costDataText'
/**
 * 价目对账：把 cockpit **当时实际使用的单价**与本项目 `cockpitPriceBook.ts` 逐模型比对。
 *
 * ## 为什么需要它（缺口 ③「无独立单价交叉校验」）
 *
 * 我们的成本是**自己算的**（`cockpitSplitCostUsd()` × `cockpitPriceBook.ts`）。
 * 此前没有任何东西能回答一个致命问题：**"我们的价目表对吗？"**
 *
 * `request_logs` 里的 `input_usd_per_million` / `output_usd_per_million` /
 * `cached_input_usd_per_million` 是 cockpit 自己落库的、**当时实际使用**的单价（100% 有值），
 * 外加 `model_pricing_version`。这就是现成的独立基准。
 *
 * ## ⚠️ 最容易误判的一点：同一模型天然有两组单价
 *
 * 实测（2026-09-12，本机 181,832 行）：
 *
 * | 模型 | 标准档 | 长文本档 |
 * |---|---|---|
 * | `gpt-5.6-sol` | 5 / 0.5 / 30（133,455 行） | **10 / 1 / 45**（10,125 行） |
 * | `gpt-5.6-luna` | 0.2 / 0.02 / 1.2（28,681 行） | **0.4 / 0.04 / 1.8**（857 行） |
 * | `gpt-6-astra` | 10 / 1 / 50（3,540 行） | **20 / 2 / 75**（3,822 行） |
 *
 * 长文本档 = 标准档 × `COCKPIT_LONG_CONTEXT_MULTIPLIERS`（input ×2 / cache ×2 / output ×1.5），
 * **与我们的价目表完全吻合**。所以"一个模型出现两组单价"**不是调价**，是长上下文档位。
 * 靠 `longContextRows` / `standardRows` 把两组归位，否则会对每个有长文本流量的模型**误报**。
 *
 * ## 红线（不可越）
 *
 * 本模块**只比对，不参与计价**。比对结果用于"提示价目表可能过期"，
 * **绝不**用它去改成本数字。计价唯一入口仍是 `cockpitSplitCostUsd()` × `cockpitPriceBook.ts`。
 *
 * ## 已实证的口径（2026-09-12，真实库 151,521 行 cost>0 记录）
 *
 * `estimated_cost_usd == (normal × input价 + cache_read × cached价 + output × output价) / 1e6`
 * 其中 `normal = input − min(cached, input)`，**零偏差**。
 * 因此 `cache_write_tokens` 无需单独建模（它按 input 价计，已被 `normal` 覆盖），
 * `reasoning_tokens` 也无需单独建模（是 output 的子集）。
 */

import {
  COCKPIT_LONG_CONTEXT_MULTIPLIERS,
  COCKPIT_PRICE_BOOK,
  COCKPIT_PRICE_BOOK_VERSION,
  normalizeCockpitModelKey,
} from './cockpitPriceBook'
import type { CockpitModelPriceSnapshot, CockpitPriceVariant } from '@/api/cockpit/facets'

/** 单个"档位"的对账结论。 */
export type PriceReconcileStatus =
  /** 该档三档单价与我们价目表**完全一致** */
  | 'match'
  /** 双方都有价，但有档位不一致 —— 我们的价目表可能过期 */
  | 'mismatch'
  /** cockpit 有实际单价，我们的价目表**没有收录该模型**（会走回退路径） */
  | 'not_in_book'
  /** 同一档位内出现**多组不同单价** ⇒ 真正的窗口内调价 */
  | 'price_changed'
  /** 数据源侧三档单价全为 0（未记录单价），无从对账 */
  | 'no_price_recorded'
  /** 源有长文本档单价，但我们价目表标注该模型 `sessionLongContext: false` */
  | 'long_context_not_declared'

/** 一个模型的一个档位（标准 / 长文本）的对账明细。 */
export interface PriceTierReconcile {
  tier: 'standard' | 'long'
  status: PriceReconcileStatus
  /** 该档请求数 */
  rows: number
  /** cockpit 实际单价（该档内行数最多的那组） */
  cockpit: { input: number; cached: number; output: number } | null
  /** 我们价目表的单价 */
  ours: { input: number; cached: number; output: number } | null
  /** 该档内出现过几组不同单价（>1 = 真正的窗口内调价） */
  variantCount: number
  /** 不一致的档位名（中文，可直接展示） */
  differingFields: string[]
}

export interface PriceReconcileRow {
  model: string
  /** cockpit 侧请求数（= 对账权重） */
  cockpitRows: number
  /** 标准档结论（必有一项） */
  standard: PriceTierReconcile
  /** 长文本档结论；该模型无长文本流量时为 null */
  long: PriceTierReconcile | null
  /** 该模型的整体结论（取两个档里最严重的那个） */
  status: PriceReconcileStatus
  /** cockpit 侧价目版本号集合 */
  pricingVersions: number[]
}

export interface PriceReconcileResult {
  /** 逐模型结论，按请求数降序 */
  rows: PriceReconcileRow[]
  /** 我们价目表的版本号 */
  bookVersion: number
  /** 数据源里出现过的价目版本号（去重升序） */
  sourceVersions: number[]
  /** 数据源版本号与我们的版本号不一致 */
  versionMismatch: boolean
  /** 有问题的模型数 */
  issueCount: number
  /** 参与对账的模型数（排除源未记录单价的） */
  comparedCount: number
  /** 一句话结论 */
  summary: string
}

/** 浮点单价比较容差：单价是 USD/1M，量级 0.02–50，1e-9 足够区分真实差异。 */
const EPS = 1e-9

type PriceTriple = { input: number; cached: number; output: number }

function isAllZero(p: PriceTriple): boolean {
  return p.input === 0 && p.cached === 0 && p.output === 0
}

function toTriple(v: CockpitPriceVariant): PriceTriple {
  return {
    input: v.inputUsdPerMillion,
    cached: v.cachedInputUsdPerMillion,
    output: v.outputUsdPerMillion,
  }
}

/** 该单价组属于标准档还是长文本档（按行数占优的一侧归类）。 */
function variantTier(v: CockpitPriceVariant): 'standard' | 'long' | 'mixed' {
  const long = v.longContextRows ?? 0
  const std = v.standardRows ?? 0
  if (long === 0 && std === 0) return 'standard'
  if (std === 0) return 'long'
  if (long === 0) return 'standard'
  return 'mixed'
}

/** 比较一组单价与我们的价目，返回不一致的档位名。
 *
 *  ⚠️ 非有限值（undefined / NaN）一律判为**不一致** ——
 *  否则 `Math.abs(6 - undefined) > EPS` 为 false，**不一致会被静默判成一致**。 */
function diffFields(cockpit: PriceTriple, ours: PriceTriple): string[] {
  const differs = (a: number, b: number) =>
    !Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a - b) > EPS
  const fields: string[] = []
  if (differs(cockpit.input, ours.input)) fields.push(costDataText('input'))
  if (differs(cockpit.cached, ours.cached)) fields.push(costDataText('cacheHit'))
  if (differs(cockpit.output, ours.output)) fields.push(costDataText('output'))
  return fields
}

/**
 * 逐模型、**逐档位**对账。纯函数：给定快照即可复现，便于单测。
 *
 * @param snapshots Rust `RequestLogFacets.priceSnapshots`
 */
export function reconcileCockpitPrices(
  snapshots: CockpitModelPriceSnapshot[] | null | undefined,
): PriceReconcileResult {
  const list = snapshots ?? []
  const rows: PriceReconcileRow[] = []
  const sourceVersions = new Set<number>()

  for (const snap of list) {
    const variants = snap.variants ?? []
    for (const v of variants) {
      for (const ver of v.pricingVersions ?? []) sourceVersions.add(ver)
    }

    const bookEntry = COCKPIT_PRICE_BOOK[normalizeCockpitModelKey(snap.model)]
    // ⚠️ 必须转成 `PriceTriple`（input/cached/output）—— 价目表原始字段名是
    // `inputUsdPerMillion` 等，直接传进去会让比较变成 `Math.abs(6 - undefined)` = NaN，
    // 而 `NaN > EPS` 恒为 false ⇒ **不一致会被静默判成一致**。
    const bookStandard: PriceTriple | null = bookEntry
      ? {
          input: bookEntry.standard.inputUsdPerMillion,
          cached: bookEntry.standard.cachedInputUsdPerMillion,
          output: bookEntry.standard.outputUsdPerMillion,
        }
      : null
    // 长文本档:价目表只存标准档,长文本档按 cockpit 同规则派生(复用常量,不重复写 2/2/1.5)
    const bookLong: PriceTriple | null =
      bookStandard && bookEntry?.sessionLongContext
        ? {
            input: bookStandard.input * COCKPIT_LONG_CONTEXT_MULTIPLIERS.input,
            cached: bookStandard.cached * COCKPIT_LONG_CONTEXT_MULTIPLIERS.cache,
            output: bookStandard.output * COCKPIT_LONG_CONTEXT_MULTIPLIERS.output,
          }
        : null

    // 按档位归位：同一档位内若出现多组，才是真正的调价
    const stdVariants = variants.filter((v) => variantTier(v) !== 'long')
    const longVariants = variants.filter((v) => variantTier(v) === 'long')

    const standard = buildTier('standard', stdVariants, bookStandard)
    const long = longVariants.length > 0
      ? buildTier('long', longVariants, bookLong)
      : null

    // 整体结论取最严重的那个（顺序即严重度）
    const severity: PriceReconcileStatus[] = [
      'mismatch',
      'long_context_not_declared',
      'not_in_book',
      'price_changed',
      'no_price_recorded',
      'match',
    ]
    const status =
      severity.find((s) => s === standard.status || s === long?.status) ?? standard.status

    rows.push({
      model: snap.model,
      cockpitRows: snap.rows,
      standard,
      long,
      status,
      pricingVersions: variants[0]?.pricingVersions ?? [],
    })
  }

  rows.sort((a, b) => b.cockpitRows - a.cockpitRows || a.model.localeCompare(b.model))

  const versionMismatch =
    sourceVersions.size > 0 && !sourceVersions.has(COCKPIT_PRICE_BOOK_VERSION)
  const issueCount = rows.filter((r) => r.status !== 'match' && r.status !== 'no_price_recorded').length
  const comparedCount = rows.filter((r) => r.status !== 'no_price_recorded').length

  return {
    rows,
    bookVersion: COCKPIT_PRICE_BOOK_VERSION,
    sourceVersions: [...sourceVersions].sort((a, b) => a - b),
    versionMismatch,
    issueCount,
    comparedCount,
    summary: buildSummary(rows, sourceVersions, comparedCount, issueCount),
  }
}

/** 单档位对账。 */
function buildTier(
  tier: 'standard' | 'long',
  variants: CockpitPriceVariant[],
  ours: PriceTriple | null,
): PriceTierReconcile {
  const rows = variants.reduce((n, v) => n + v.rows, 0)
  // variants 已由 Rust 侧按 rows 降序
  const dominant = variants[0]
  const cockpit = dominant ? toTriple(dominant) : null
  const variantCount = variants.length

  let status: PriceReconcileStatus
  let differingFields: string[] = []

  if (!cockpit || isAllZero(cockpit)) {
    status = 'no_price_recorded'
  } else if (!ours) {
    // 长文本档走到这里 = 源有长文本流量,但我们价目表没给该模型派生长文本价
    // (即 `sessionLongContext: false`) ⇒ 我们会漏价,必须点名。
    status = tier === 'long' ? 'long_context_not_declared' : 'not_in_book'
  } else {
    differingFields = diffFields(cockpit, ours)
    if (differingFields.length > 0) status = 'mismatch'
    else status = variantCount > 1 ? 'price_changed' : 'match'
  }

  return { tier, status, rows, cockpit, ours, variantCount, differingFields }
}

function buildSummary(
  rows: PriceReconcileRow[],
  sourceVersions: Set<number>,
  comparedCount: number,
  issueCount: number,
): string {
  if (rows.length === 0) return costDataText('noReconcilableModelsSourceProvidesNoUnitPriceSnapshots')

  const longCount = rows.filter((r) => r.long).length
  const longNote = longCount > 0 ? costDataText('includingLongContextTiersForModels', { p0: longCount }) : ''

  let base: string
  if (issueCount === 0) {
    base = costDataText('pricesMatchStandardLongContextUnitPricesForModels', { p0: comparedCount, p1: longNote })
  } else {
    const count = (s: PriceReconcileStatus) =>
      rows.filter((r) => r.standard.status === s || r.long?.status === s).length
    const parts: string[] = []
    const mismatch = count('mismatch')
    const missing = count('not_in_book')
    const changed = count('price_changed')
    const undeclared = count('long_context_not_declared')
    if (mismatch) parts.push(costDataText('tierUnitPricesDiffer', { p0: mismatch }))
    if (undeclared) parts.push(costDataText('longContextTiersAreUndeclared', { p0: undeclared }))
    if (missing) parts.push(costDataText('modelsAreNotInTheCatalog', { p0: missing }))
    if (changed) parts.push(costDataText('tiersHavePriceChangesWithinTheWindow', { p0: changed }))
    base = costDataText('pricesNeedReview', { p0: parts.join('、') })
  }

  if (sourceVersions.size > 0 && !sourceVersions.has(COCKPIT_PRICE_BOOK_VERSION)) {
    base += costDataText('priceVersionsSourceLocal', { p0: [...sourceVersions].sort((a, b) => a - b).join('/'), p1: COCKPIT_PRICE_BOOK_VERSION })
  }
  return base
}

/** 状态的中文说明（UI 徽标用）。 */
export const PRICE_RECONCILE_STATUS_LABELS: Record<PriceReconcileStatus, string> = {
  match: costDataText('matched'),
  mismatch: costDataText('mismatched'),
  not_in_book: costDataText('notInCatalog'),
  price_changed: costDataText('priceChangedWithinWindow'),
  no_price_recorded: costDataText('sourceHasNoUnitPrice'),
  long_context_not_declared: costDataText('longContextTierUndeclared'),
}

/** 档位的中文名。 */
export const PRICE_TIER_LABELS: Record<'standard' | 'long', string> = {
  standard: costDataText('standardTier'),
  long: costDataText('longContextTier'),
}
