import { costDataText } from './costDataText'
/**
 * 「诚实值」纯函数层 —— P0-21 验收⑤:不可得**绝不**显示 0 / 绿色健康态。
 *
 * 2026-09-12 代码审查后从 `CostCenterView.vue` 抽出。原实现把 null/undefined 用
 * `Number(x) || 0`、`?? 0`、`return 1`、`Number.isFinite` 兜底压成了
 * 「0 ms」「$0.00」「0.0%」「绿色 high 级」—— 界面在暗示系统并不掌握的信息。
 *
 * 本模块统一契约:**无从判断时返回 `null`,由调用方渲染 `—` / `无样本` / `成本未知`。**
 * 与 `dataState.ts` 的分工:dataState 管「数据源整体是否可用」,本模块管「单个数值是否为真值」。
 */

import {
  noPriceNoEstimateCost,
  pricedCost,
  sourceEstimateCost,
  type CostBasisKind,
  type PricedCost,
} from './costBasis'
import type { AccountUsageInfo } from '@/types'

/** 「没有这个值」的统一展示符。与真实 0 必须肉眼可分。 */
export const UNKNOWN_DASH = '—'

/** 把任意输入收敛成有限数;null / '' / NaN / Infinity 一律判为「无值」。 */
export function finiteOrNull(value: unknown): number | null {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

// ==================== ① TTFT 等延迟样本 ====================

/**
 * 首 token 延迟 P95(ms)。无样本返回 `null` —— **绝不返回 0**。
 *
 * `0 ms` 在物理上不存在(首 token 必然耗时),把它显示出来等于断言"瞬时返回"。
 * `api/cockpit/index.ts` 里 `ttft_p95_ms` 就是 `number | null`,null 是常态而非异常。
 */
export function latencySampleMs(value: unknown): number | null {
  const ms = finiteOrNull(value)
  if (ms == null) return null
  // <= 0 同样是"没测到":真实延迟不可能是 0 或负数。
  return ms > 0 ? ms : null
}

// ==================== ② 成本单元格(复用 PricedCost 三态) ====================

export interface CostCellSource {
  /** 本项目按价目表自算的成本(USD);null = 没有自算值 */
  selfCost?: number | null
  selfCostBasis?: CostBasisKind | null
  /** 数据源自带估算(USD);null = 数据源也没给 */
  sourceEstimate?: number | null
  /** 回退数据源估算时要乘的倍率(自算值已含倍率,不再二次相乘)。默认 1。 */
  multiplier?: number | null
}

export interface CostCell {
  /** 金额。basis 为 no_price_no_estimate 时恒为 0,**不得当真实成本展示**。 */
  costUsd: number
  /** 是否是本项目自算值 */
  costIsOurs: boolean
  /** 计价依据;`no_price_no_estimate` = 算不出,UI 必须显示「成本未知」 */
  costBasis: CostBasisKind
  costPartial?: boolean
}

/**
 * 把「自算值 / 数据源估算」折叠成三态 PricedCost。
 *
 * ★ 关键:两者都缺时**不能**回退 0 —— 那是把"算不出来"冒充成"这个不花钱"。
 * 与 `useUnifiedCost.cockpitAccountRows` 口径保持一致(含 `estimate > 0` 判定)。
 */
export function pricedCostOf(source: CostCellSource): PricedCost {
  const self = finiteOrNull(source.selfCost)
  if (source.selfCostBasis === 'no_price_no_estimate') return noPriceNoEstimateCost()
  if (self != null) return source.selfCostBasis === 'source_estimate' ? sourceEstimateCost(self) : pricedCost(self)

  const estimate = finiteOrNull(source.sourceEstimate)
  // 复用既有口径:估算值必须 > 0 才算"有估算",0/负数视为数据源没给出可用估算。
  if (estimate != null && estimate > 0) {
    const multiplier = finiteOrNull(source.multiplier) ?? 1
    return sourceEstimateCost(estimate * multiplier)
  }
  return noPriceNoEstimateCost()
}

/** 成本单元格:金额 + 是否自算 + 计价依据。 */
export function resolveCostCell(source: CostCellSource): CostCell {
  const self = finiteOrNull(source.selfCost)
  if (source.selfCostBasis === 'no_price_no_estimate' && self != null && self > 0) {
    return { costUsd: self, costIsOurs: true, costBasis: source.selfCostBasis, costPartial: true }
  }
  const priced = pricedCostOf(source)
  return {
    costUsd: priced.cost,
    costIsOurs: priced.basis.kind === 'priced',
    costBasis: priced.basis.kind,
  }
}

// ==================== ③ 配额窗口利用率 ====================

/** 利用率分级。`unknown` = 无从判断,**绝不给绿色**(绿色是"健康"的正向断言)。 */
export type QuotaGrade = 'high' | 'medium' | 'low' | 'critical' | 'unknown'

/** 收敛成 0–100 的利用率;无值返回 null。 */
export function clampUtilization(value: unknown): number | null {
  const number = finiteOrNull(value)
  if (number == null) return null
  return clamp(number, 0, 100)
}

/** 进度条宽度专用:无值画 0 宽(视觉占位,不代表"消耗 0")。 */
export function utilizationBarWidth(value: unknown): number {
  return clampUtilization(value) ?? 0
}

export function quotaGrade(value: unknown): QuotaGrade {
  const utilization = clampUtilization(value)
  if (utilization == null) return 'unknown'
  if (utilization >= 90) return 'critical'
  if (utilization >= 75) return 'low'
  if (utilization >= 50) return 'medium'
  return 'high'
}

export function formatUtilization(value: unknown): string {
  const utilization = clampUtilization(value)
  return utilization == null ? UNKNOWN_DASH : `${Math.round(utilization)}%`
}

/** 是否有主用量窗口(5h / 7d 任一存在)。 */
export function hasPrimaryUsageWindow(usage?: AccountUsageInfo | null): boolean {
  return Boolean(usage?.five_hour || usage?.seven_day)
}

/**
 * 单账号窗口余量(0–1)。无窗口返回 `null` —— **绝不返回 1**。
 *
 * 返回 1 会让"我们不知道用了多少"显示成"剩余 100%",正是 P0-21 要消灭的假信息。
 *
 * 可达性(2026-09-20 逐源核验):窗口存在但 `utilization` 不可得是**真实可达**的 ——
 * `UsageProgress.utilization` 声明为 `number`(src/types/index.ts:1259),但 sub2api 源
 * 的 AccountUsageInfo 直接来自远程 HTTP 响应(api/admin/accounts.ts:535
 * `apiClient.get<AccountUsageInfo>` → useCostCenterData.ts:822 原样入库),**没有任何运行时校验**,
 * 类型断言对网络 JSON 不构成保证;本仓自带的测试助手也把该字段建模为可空
 * (__tests__/noSilentZero.spec.ts:256 `windowOf(utilization: number | null)`)。
 * (cockpit 的 five_hour/seven_day 恒为 null、cliproxy 由 `!= null` 守卫,这两条路径不可达。)
 *
 * ⇒ 不可得的窗口**跳过**;全部窗口都不可得 ⇒ `null`(不落 0、更不落 1)。
 */
export function quotaRemainingRatio(usage?: AccountUsageInfo | null): number | null {
  const windows = [usage?.five_hour, usage?.seven_day].filter(Boolean)
  if (!windows.length) return null
  let mostConstrained: number | null = null
  for (const window of windows) {
    const utilization = clampUtilization(window!.utilization)
    // 该窗口余量不可得 ⇒ 跳过。当成 0 会把这个窗口读成"没用任何配额",从而抬高余量。
    if (utilization == null) continue
    mostConstrained = mostConstrained == null ? utilization : Math.max(mostConstrained, utilization)
  }
  if (mostConstrained == null) return null
  return clamp(1 - mostConstrained / 100, 0, 1)
}

/** 一组账号的平均窗口余量。一个都没同步过返回 `null`(不是 0 —— 0 会被读成"已耗尽")。 */
export function averageQuotaRemaining(usages: ReadonlyArray<AccountUsageInfo | undefined | null>): number | null {
  const synced = usages.filter(hasPrimaryUsageWindow)
  if (!synced.length) return null
  let total = 0
  let counted = 0
  for (const usage of synced) {
    const ratio = quotaRemainingRatio(usage)
    // 窗口在、余量却不可得:既不是 0% 也不是 100%,不参与平均。
    // (`?? 0` 会把它算成"已耗尽",是 quotaRemainingRatio 修好之后新冒出来的假 0。)
    if (ratio == null) continue
    total += ratio
    counted += 1
  }
  return counted > 0 ? total / counted : null
}

/**
 * 从快照组里挑"最老且确实有百分比"的那条,供百分比与时间戳**同源**展示。
 *
 * 此前 `worst` 取 `Math.min(...pcts)`、`stamp` 取 `snaps[0]`、`oldestAgeMs` 取最老一条,
 * 三者可能来自不同行 —— 显示出来的"剩余 X% · N 天前"里,% 和天数互不相干。
 */
export function pickMostStaleSnapshot<T>(
  snapshots: ReadonlyArray<T>,
  ageMsOf: (snapshot: T) => number | null,
  hasPercentOf: (snapshot: T) => boolean,
  /**
   * 备用排序键(剩余百分比)。年龄全都判不出来时,退回"剩余最低"的那条 ——
   * 沿用原 `worst = min(pcts)` 的保守语义,而不是随便抓第一条。
   */
  percentOf?: (snapshot: T) => number | null,
): T | null {
  let best: T | null = null
  let bestAge = -1
  for (const snapshot of snapshots) {
    if (!hasPercentOf(snapshot)) continue
    const age = ageMsOf(snapshot)
    if (age == null) continue
    if (best === null || age > bestAge) {
      best = snapshot
      bestAge = age
    }
  }
  if (best !== null) return best

  // 一条年龄都判不出来:退回"剩余最低"的一条,至少保证百分比与时间戳取自同一行。
  let lowest: T | null = null
  let lowestPercent = Number.POSITIVE_INFINITY
  for (const snapshot of snapshots) {
    if (!hasPercentOf(snapshot)) continue
    const percent = percentOf?.(snapshot) ?? null
    if (percent == null) continue
    if (lowest === null || percent < lowestPercent) {
      lowest = snapshot
      lowestPercent = percent
    }
  }
  return lowest ?? snapshots.find(hasPercentOf) ?? null
}

// ==================== ③b 加载失败时的旧数据标注 ====================

/**
 * 配额"加载失败但仍显示旧数据"的标注(审查 #10)。
 *
 * 数据层在读取失败时**不清空** `snapshotsByChannel` 是对的 —— 旧值 + 说明 > 一片空白。
 * 但展示侧必须说清这些数字是**上次成功加载**的,否则用户会当成最新数据读。
 * 这与 ageDays ≥ 1 的陈旧数据同源:**展示了数字,却没说这数字还能不能信**。
 */
export interface QuotaStaleNotice {
  /** 当前展示的是否为"上次成功加载"的旧数据(需转灰 + 标注) */
  staleDueToError: boolean
  /** 主提示文案;null = 无需提示 */
  title: string | null
  /** 原始错误原文(小字展示,便于排查);null = 无 */
  detail: string | null
}

/** 无错误时的返回值 —— 保证"行为与现在完全一致,不出现多余提示"。 */
export const NO_QUOTA_STALE_NOTICE: QuotaStaleNotice = Object.freeze({
  staleDueToError: false,
  title: null,
  detail: null,
})

/**
 * @param error           数据层回传的失败原因(空串 / null 都算没失败)
 * @param hasRenderedData 界面上是否确实渲染着旧数据。没有数据可展示就谈不上"旧"。
 */
export function quotaStaleNotice(error: unknown, hasRenderedData: boolean): QuotaStaleNotice {
  const raw = typeof error === 'string' ? error.trim() : ''
  if (!raw || !hasRenderedData) return NO_QUOTA_STALE_NOTICE
  return {
    staleDueToError: true,
    title: costDataText('readFailedShowingTheLastSuccessfullyLoadedData'),
    detail: raw,
  }
}

// ==================== ④ 请求计数与失败率 ====================

export interface RequestCountInput {
  /** Ops 上报的总请求数 */
  reportedTotal?: number | null
  /** Ops 上报的成功请求数 */
  reportedSuccess?: number | null
  /** Ops 上报的失败请求数 */
  reportedError?: number | null
  /** Ops 上报的比率，可能是排除业务限制的 SLA 口径，不能替代全部失败占比。 */
  reportedErrorRate?: number | null
  /** Ops 缺失时,由趋势点累加得到的总量 */
  fallbackTotal?: number | null
  /** 回退总量是否真有观测样本(趋势点存在)。false = 连样本都没有。 */
  fallbackObserved?: boolean
}

export interface RequestCounts {
  total: number | null
  success: number | null
  error: number | null
  errorRate: number | null
  reportedErrorRate: number | null
}

/**
 * 请求计数与失败率。
 *
 * ★ 分母为 0(零观测)时失败率返回 `null`,**绝不返回 0** —— 没有请求 ≠ 零失败。
 * `cliproxyAdapter` 在 `requestTotal === 0` 时就是硬编码 `error_rate: 0`,
 * 直接拿这个数渲染会变成"实测失败率 0.0%"。
 *
 * ★ 失败数一律只用上报值:回退的"处于 error 态的账号数"是**账号数**不是**请求数**,
 * 与请求总量不同口径,不能拿去和总量做减法。
 */
export function resolveRequestCounts(input: RequestCountInput): RequestCounts {
  const reportedTotal = finiteOrNull(input.reportedTotal)
  const total = reportedTotal ?? (input.fallbackObserved ? Math.max(0, finiteOrNull(input.fallbackTotal) ?? 0) : null)
  const error = finiteOrNull(input.reportedError)

  let success = finiteOrNull(input.reportedSuccess)
  if (success == null && total != null && error != null) success = Math.max(0, total - error)

  const reportedRate = finiteOrNull(input.reportedErrorRate)
  const reportedErrorRate = reportedRate == null ? null : clamp(reportedRate, 0, 1)
  const errorRate = total != null && total > 0 && error != null ? clamp(error / total, 0, 1) : null

  return { total, success, error, errorRate, reportedErrorRate }
}

// ==================== ⑤ 综合质量分 ====================

export type QualityProvenance = 'ops' | 'derived'

export interface QualityScoreInput {
  /** Ops 上报的健康分(0–100) */
  healthScore?: number | null
  /** 可调度账号数 */
  activeAccounts?: number | null
  /** 账号总数 */
  totalAccounts?: number | null
  /** 失败率(0–1);null = 无观测 */
  errorRate?: number | null
}

export interface QualityScore {
  /** 综合分;null = 算不出来(连账号可用率都无从判断) */
  score: number | null
  /** 真实来源:`ops` = Ops 实测,`derived` = 账号状态推算 */
  provenance: QualityProvenance
}

/**
 * 综合质量分 + **真实来源标注**。
 *
 * 此前模板只凭 `opsOverview` 是否存在就写「Ops 实测」,可 `health_score` 为 null 时
 * 分数其实是用账号可用率推算的 —— 标注与来源对不上。这里把来源一并返回,由 UI 照实写。
 */
export function resolveQualityScore(input: QualityScoreInput): QualityScore {
  const healthScore = finiteOrNull(input.healthScore)
  if (healthScore != null) return { score: clamp(healthScore, 0, 100), provenance: 'ops' }

  const totalAccounts = finiteOrNull(input.totalAccounts)
  const errorRate = finiteOrNull(input.errorRate)
  if (totalAccounts == null || totalAccounts <= 0 || errorRate == null) {
    return { score: null, provenance: 'derived' }
  }
  const active = Math.max(0, finiteOrNull(input.activeAccounts) ?? 0)
  const availability = clamp(active / totalAccounts, 0, 1)
  return { score: clamp(availability * 82 + (1 - errorRate) * 18, 0, 100), provenance: 'derived' }
}

// ==================== ⑥ 展示辅助 ====================

/** 有值才是"实测";空串 / null / **非有限数**一律是不可用,不能挂「实测」徽标。
 *
 *  ★ 数字分支的 `Number.isFinite` 不是多余的(2026-09-23 复核翻案):
 *  同一格里的 `value` 走 `formatTokens` / `formatInteger` / `costEmphasisClass`,
 *  它们**都**判 `!Number.isFinite(Number(v)) ⇒ '无数据' / 中性色`。
 *  若这里放行 NaN,就会出现「**数值格写『无数据』、旁边徽标写『实测』**」的同格自相矛盾 ——
 *  而 `NaN` 正是"没有测到"的表示,挂「实测」等于替一个不存在的数字背书。
 *  本模块自己的 `finiteOrNull`(:24)注释早就写着「null / '' / NaN / Infinity 一律判为『无值』」,
 *  `costEmphasisClass`(CockpitDataView)也早就这么判了 —— 只有这里漏了。
 *  注意只对 `typeof === 'number'` 生效:字符串格(端点/策略/Key 等配置文本)不走格式化函数,
 *  不能被 `Number('OpenAI 兼容') === NaN` 误伤成「不可用」。 */
export function truthfulState(value: unknown): 'measured' | 'unavailable' {
  if (value == null || value === '') return 'unavailable'
  if (typeof value === 'number') return Number.isFinite(value) ? 'measured' : 'unavailable'
  return 'measured'
}

export function formatPercentOrDash(value: number | null | undefined): string {
  const number = finiteOrNull(value)
  return number == null ? UNKNOWN_DASH : `${(number * 100).toFixed(1)}%`
}
