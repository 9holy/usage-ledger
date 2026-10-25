import { costDataText } from './costDataText'
/**
 * 合并口径（P0-15）→ 计价的**唯一衔接层**。
 *
 * ## 为什么单独一个文件
 *
 * Rust `ledger_merge.rs` 只产"量"（`MergedCell` 里没有任何金额字段，连
 * `estimated_cost_usd` 都不搬运）。钱只能在前端算，而且必须走同一个入口：
 * `cockpitSplitCostUsd() × cockpitPriceBook.ts`。
 * 本文件只做一件事：**把合并格翻译成分档 token 并计价**。
 *
 * ## ⚠️ 档位与"哪个源胜出"无关（2026-09-12 修正）
 *
 * 初版按来源硬编码了一个"未分档"概念：sessions 胜出就标 `source_estimate` +
 * 「长文本档缺失（保守偏低）」。**前提是错的** —— 摄取层对所有源统一走
 * `TokenSplit::add`，档位判定是 `input > 272_000`，与 `source_name` 无关；
 * 实测两源 long 档占比同量级（logs 22.46% / sessions 19.84%），14 个吻合天逐日重合。
 *
 * 所以现在：**sessions 格与 logs 格一视同仁**，`graded` 字段已从 Rust 侧删除，
 * 成本一律按 `cockpitSplitCostUsd()` 吃全 6 档位算（long 档照常 ×2/×2/×1.5）。
 * 覆盖率说的是"**哪天的量是靠会话源补上的（日志侧漏记）**"，与档位质量无关。
 */

import { cockpitSplitCostUsd } from '@/features/cost-center/cockpitAdapter'
import {
  cockpitEffectivePriceSets,
  cockpitPriceSetFor,
  type CockpitLocalPricingInput,
} from '@/features/cost-center/cockpitPriceBook'
import {
  noPriceNoEstimateCost,
  type PricedCost,
} from '@/features/cost-center/costBasis'
import type { MergedCell, TierCoverage, TierVector } from '@/api/ledgerMerge'

/** 无可用单价时的文案（合并层不搬运 estimated_cost_usd ⇒ 没有任何可回退的估算）。 */
const mergeNoPriceLabel = () => costDataText('noUsableUnitPriceMergedCellCostUnknownNot')

/** 计价时用的价目表缓存（内置价目表是常量，只需算一次）。 */
let bookPriceSetsCache: ReturnType<typeof cockpitEffectivePriceSets> | null = null

function priceSetsOf(
  pricings?: CockpitLocalPricingInput[],
): ReturnType<typeof cockpitEffectivePriceSets> {
  if (!pricings || pricings.length === 0) {
    bookPriceSetsCache ??= cockpitEffectivePriceSets(undefined)
    return bookPriceSetsCache
  }
  return cockpitEffectivePriceSets(pricings)
}

/**
 * 合并格 → 分档 token（`CockpitTokenSplit` 形状）。
 *
 * `estimatedCostUsd` 恒为 0：**合并层不搬运数据源的钱**（红线），
 * 所以"无单价"时没有可回退的估算，只能标"成本未知"（`no_price_no_estimate`）。
 */
function toTokenSplit(cell: MergedCell): Parameters<typeof cockpitSplitCostUsd>[0] {
  const t: TierVector = cell.tokens
  return {
    requests: cell.requests,
    success: cell.success,
    error: cell.error,
    stdNormalInput: t.stdNormalInput,
    stdCached: t.stdCached,
    stdOutput: t.stdOutput,
    longNormalInput: t.longNormalInput,
    longCached: t.longCached,
    longOutput: t.longOutput,
    // 红线：账本只存量不存钱。这里给 0 是"没有估算可回退"的显式表达，
    // 不是把数据源的钱搬过来 —— 有单价时 cockpitSplitCostUsd 根本不读它。
    estimatedCostUsd: 0,
    rateLimited: 0,
    upstreamError: 0,
    clientCanceled: 0,
  }
}

/**
 * 一个合并格的成本（USD）。
 *
 * - 有可用单价 → `basis = priced`（**不管来源**：sessions 格与 logs 格同规则，
 *   long 档照常按 ×2/×2/×1.5 计，见文件头）；
 * - 无可用单价 → `basis = no_price_no_estimate`，**cost 恒为 0 但标注"未知"**，绝不冒充 $0；
 * - `multiplier` 与 cockpit 直连口径同参（成本倍率），不传即走项目默认倍率。
 */
export function mergedCellCost(
  cell: MergedCell,
  pricings?: CockpitLocalPricingInput[],
  multiplier?: number,
): PricedCost {
  const priceSet = cockpitPriceSetFor(priceSetsOf(pricings), cell.modelId)
  if (!priceSet) {
    // 没有该模型的单价，且合并层不搬运 estimated_cost_usd ⇒ 没有可回退的估算
    return noPriceNoEstimateCost(mergeNoPriceLabel())
  }
  const priced = cockpitSplitCostUsd(toTokenSplit(cell), priceSet, multiplier)
  return { cost: priced.cost, basis: priced.costBasis, label: priced.basis }
}

/**
 * 覆盖率文案：`含 N 天由会话源补全（日志侧漏记）`。
 *
 * ⚠️ 不是"未分档" —— 两源档位同源同规则，会话源的量同样带 long 档。
 * 资产总览脚注与合并面板都用这一句 —— 口径只有一处，不会两处说法不一致。
 */
export function mergeCoverageLabel(coverage: TierCoverage | null | undefined): string {
  if (!coverage) return costDataText('coverageUnknown')
  if (coverage.sessionsBackfilledDays <= 0) return costDataText('fullyCoveredByGatewayRequestRecords')
  return costDataText('includesDaysBackfilledFromSessionRecordsMissingLogRecords', { p0: coverage.sessionsBackfilledDays })
}

/**
 * 长文本文档位占比提示（`longRatioObserved`）。
 *
 * 这是**合并结果**里 long 档的实测占比（计价已按 ×2/×2/×1.5 计入），
 * 不是"低估幅度" —— 初版把它当低估提示是基于错误前提，已纠正。
 */
export function mergeLongRatioHint(coverage: TierCoverage | null | undefined): string {
  const ratio = coverage?.longRatioObserved
  if (ratio == null) return costDataText('noUsageDataCannotCalculateTheLongContextTier')
  return costDataText('mergedLongContextTierShareCostsInclude22', { p0: (ratio * 100).toFixed(2) })
}
