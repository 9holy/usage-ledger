import { costDataText } from './costDataText'
/**
 * CLIProxyAPI 成本反算 — usage-queue token × 模型定价
 *
 * CLIProxyAPI 的 /v0/management 不暴露成本字段(实测零匹配),只有 usage-queue 的最近 N 条
 * 请求 token 快照。本模块用 token 数 × 模型定价(借用 cockpit modelPricings 或 sub2api 模型
 * 目录)反算 USD 成本。
 *
 * 口径限制(必须向用户标注):
 * - usage-queue 是最近 N 条快照(默认 20),非生命周期累计 → 反算结果是「最近 N 条请求成本」
 * - 定价表跨源借用,未知模型降级跳过(不计入,单独统计 unmatched)
 * - 估算值,不与 sub2api/cockpit 的事实成本同口径
 */

import type { UsageQueueRecord } from '@/api/cliproxy/management'
import type { CockpitModelPricing } from '@/api/cockpit'
import { addPricedCost, noPriceNoEstimateCost, pricedCost, type CostBasis, type PricedCost } from './costBasis'

/**
 * 注(2026-09-11,T15):本模块的 `estimateCliproxyCost` 在**生产代码里已无引用**
 * (CPA 路径已改用 `cliproxyAdapter.cliproxyEventsTotalCost`);仓库里只剩本文件的类型
 * `CliproxyCostEstimate` / `CliproxyCostByModel` 被 `useUnifiedCost` 引用。
 * 因此文件**保留**(删会炸类型),但按 P0-17 同步修掉"静默变 0":
 * 无匹配定价时返回标注型空值 `no_price_no_estimate`,不再冒充 $0。
 */

export interface CliproxyCostByModel {
  model: string
  requestCount: number
  costUsd: number
  /** 该模型**没有匹配到定价**:costUsd 恒为 0 但语义是"算不出",UI 必须显示"成本未知"而非 $0.0000。 */
  costUnknown?: boolean
  inputTokens: number
  outputTokens: number
  cachedTokens: number
}

export interface CliproxyCostEstimate {
  /** 反算总成本 USD(仅含匹配到定价的请求) */
  totalUsd: number
  /** 总成本的计价依据标注(无匹配定价时不是 0,是"算不出") */
  totalCostBasis: CostBasis
  /** 总成本口径文案(供 UI 角标) */
  totalCostLabel: string
  /** 按模型分组的成本明细 */
  byModel: CliproxyCostByModel[]
  /** 参与反算的请求数 */
  matchedRequests: number
  /** 未匹配到定价的请求数(未计入成本) */
  unmatchedRequests: number
  /** usage-queue 总请求数 */
  windowSize: number
  /** 是否为估算(恒为 true,标注用) */
  estimated: true
}

/** 单条请求成本(标注型空值):tokens × 每百万 token 定价。定价缺省字段按 0 处理(不计该 token 类别)。
 *  无匹配定价 → `no_price_no_estimate`(P0-17:不静默变 0)。 */
function costForRecord(record: UsageQueueRecord, pricing: CockpitModelPricing | undefined): PricedCost {
  if (!pricing) return noPriceNoEstimateCost(costDataText('noMatchingModelPriceUnknownCostNot0'))
  const tokens = record.tokens
  const input = Number(tokens?.input ?? 0) * (Number(pricing.inputUsdPerMillion ?? 0) / 1_000_000)
  const output = Number(tokens?.output ?? 0) * (Number(pricing.outputUsdPerMillion ?? 0) / 1_000_000)
  const cached = Number(tokens?.cached ?? 0) * (Number(pricing.cachedInputUsdPerMillion ?? 0) / 1_000_000)
  return pricedCost(input + output + cached)
}

/**
 * 按 usage-queue + 定价表反算 cliproxy 成本。
 * @param queue usage-queue 快照(getUsageQueue 返回)
 * @param pricings 模型定价表(cockpit modelPricings)
 */
export function estimateCliproxyCost(
  queue: UsageQueueRecord[],
  pricings: CockpitModelPricing[],
): CliproxyCostEstimate {
  const pricingMap = new Map(pricings.map(p => [p.modelId, p]))
  const byModelMap = new Map<string, CliproxyCostByModel>()
  let total: PricedCost = pricedCost(0)
  let matchedRequests = 0
  let unmatchedRequests = 0

  for (const record of queue) {
    const model = record.model || 'unknown'
    const pricing = pricingMap.get(model)
    const priced = costForRecord(record, pricing)
    const cost = priced.cost
    const hasPricing = !!pricing

    if (hasPricing) {
      matchedRequests += 1
      // 逐条累加并保留"最差"的计价依据,避免部分算不出被掩盖
      total = addPricedCost(total, priced)
    } else {
      unmatchedRequests += 1
      total = addPricedCost(total, priced)
    }

    const existing = byModelMap.get(model)
    const tokens = record.tokens
    if (existing) {
      existing.requestCount += 1
      existing.costUsd += cost
      existing.inputTokens += Number(tokens?.input ?? 0)
      existing.outputTokens += Number(tokens?.output ?? 0)
      existing.cachedTokens += Number(tokens?.cached ?? 0)
    } else {
      byModelMap.set(model, {
        model,
        requestCount: 1,
        costUsd: cost,
        costUnknown: !hasPricing,
        inputTokens: Number(tokens?.input ?? 0),
        outputTokens: Number(tokens?.output ?? 0),
        cachedTokens: Number(tokens?.cached ?? 0),
      })
    }
  }

  return {
    totalUsd: total.cost,
    totalCostBasis: total.basis,
    totalCostLabel: total.label ?? '',
    byModel: Array.from(byModelMap.values()).sort((a, b) => b.costUsd - a.costUsd),
    matchedRequests,
    unmatchedRequests,
    windowSize: queue.length,
    estimated: true,
  }
}
