import { costDataText } from './costDataText'
/**
 * 标注型空值(PricedCost)—— 架构设计 【F】7.2 / PRD P0-17「消除静默变 0」。
 *
 * 问题:计价函数在"没有单价、数据源也没给估算"时返回 `0`。
 * 下游拿到 0 之后无法区分:
 *   (a) 真的算了,结果是 $0;
 *   (b) 根本算不出来(缺价目),被静默压成 0。
 * 用户看到 (b) 会以为这个账号不花钱 —— 这是**误导**,不是降级。
 *
 * 方案:成本值一律带 `basis` 标注返回。UI 拿到 `no_price_no_estimate`
 * 必须显示"成本未知"而不是 `$0.00`。
 */

/** 计价依据。三态,不含金额语义。 */
export type CostBasis =
  /** 本项目价目 × 用量(或官方订阅价)算出来的,可信 */
  | { kind: 'priced' }
  /** 本项目没有可用价目,回退数据源自带估算(估算,但至少有个来源) */
  | { kind: 'source_estimate' }
  /** ★ 既无价目、数据源也没给估算 —— 不是 0,是"算不出" */
  | { kind: 'no_price_no_estimate' }

export type CostBasisKind = CostBasis['kind']

/** 带标注的成本值。 */
export interface PricedCost {
  /** 金额(USD)。basis 为 no_price_no_estimate 时恒为 0,**不要当真实成本展示**。 */
  cost: number
  /** 计价依据 */
  basis: CostBasis
  /** UI 角标文案;省略时用 COST_BASIS_LABEL 的默认文案 */
  label?: string
}

/** 各 basis 的默认中文文案。 */
export const COST_BASIS_LABEL: Readonly<Record<CostBasisKind, string>> = Object.freeze({
  get priced() { return costDataText('localPricesUsageCalculated') },
  get source_estimate() { return costDataText('sourceEstimateNoUsableUnitPrice') },
  get no_price_no_estimate() { return costDataText('noUnitPriceOrSourceEstimateUnknownCostNot') },
})

/** 严重度:累加时取"更差"的一侧,避免部分算不出被部分算得出掩盖。 */
const BASIS_SEVERITY: Readonly<Record<CostBasisKind, number>> = Object.freeze({
  priced: 0,
  source_estimate: 1,
  no_price_no_estimate: 2,
})

/** 构造:本项目自算。 */
export function pricedCost(cost: number, label?: string): PricedCost {
  return { cost: Number.isFinite(cost) ? cost : 0, basis: { kind: 'priced' }, label }
}

/** 构造:回退数据源估算(有来源,但非本项目口径)。 */
export function sourceEstimateCost(cost: number, label?: string): PricedCost {
  return { cost: Number.isFinite(cost) ? cost : 0, basis: { kind: 'source_estimate' }, label }
}

/** 构造:算不出来。**cost 恒为 0,但 basis 标明"未知",绝不允许冒充真实 $0**。 */
export function noPriceNoEstimateCost(label?: string): PricedCost {
  return {
    cost: 0,
    basis: { kind: 'no_price_no_estimate' },
    label: label ?? COST_BASIS_LABEL.no_price_no_estimate,
  }
}

/** 取 basis 种类。 */
export function costBasisKindOf(value: PricedCost): CostBasisKind {
  return value.basis.kind
}

/** 是否"算不出来"。直接吃 basis kind —— 供已经把 basis 拆成独立字段的调用点
 *  (如 cockpitAdapter 的 CockpitUsageCost.costBasis)复用同一判据,避免在别处散落字符串比较。 */
export function isUnknownCostBasis(kind: CostBasisKind): boolean {
  return kind === 'no_price_no_estimate'
}

/** 是否"算不出来"(UI 应显示"成本未知"而非 $0.00)。 */
export function isCostUnknown(value: PricedCost): boolean {
  return isUnknownCostBasis(value.basis.kind)
}

/** 展示文案:自定义 label 优先,否则用默认文案。 */
export function costLabelOf(value: PricedCost): string {
  return value.label || COST_BASIS_LABEL[value.basis.kind]
}

/**
 * 成本累加。金额相加,basis 取"更差"的一侧:
 * 只要有一部分算不出来,整体就不能标成"已计价"。
 */
export function addPricedCost(left: PricedCost, right: PricedCost): PricedCost {
  const leftWorse = BASIS_SEVERITY[left.basis.kind] >= BASIS_SEVERITY[right.basis.kind]
  const winner = leftWorse ? left : right
  return {
    cost: left.cost + right.cost,
    basis: winner.basis,
    label: winner.label,
  }
}

/** 取"更差"的一侧(严重度高者胜),供成本累加 / 趋势桶合并时 OR 汇总 basis。
 *  `undefined` = 未标注(等价于已计价),不参与比较;全部未标注时返 undefined。
 *  语义与 `addPricedCost` 的「取更差一侧」一致:只要有一部分算不出来,整体就不能标成"已计价"。 */
export function worstCostBasisKind(...kinds: Array<CostBasisKind | undefined>): CostBasisKind | undefined {
  let worst: CostBasisKind | undefined
  for (const kind of kinds) {
    if (kind == null) continue
    if (worst == null || BASIS_SEVERITY[kind] > BASIS_SEVERITY[worst]) worst = kind
  }
  return worst
}

/** 逐 key 累加计价依据:取"更差"的一侧。
 *
 *  与 `worstCostBasisKind` 的区别只是**入参一定有一个新值**:分组求和时每一组都带 basis,
 *  所以结果一定存在(`worstCostBasisKind` 在"全未标注"时会返 undefined)。
 *  单独导出是为了让"逐账号/逐模型取更差一侧"这件事有一个**可直测**的实现,
 *  不必在视图的聚合循环里裸写 `worstCostBasisKind(prev, next) ?? next`。
 *
 *  ★ 语义:某个账号/模型下只要有**一组**算不出来,它的合计就只是**下界**
 *  (算不出来的那组贡献的是哨兵 0)⇒ 不能标成"已计价"。 */
export function worseBasisOf(current: CostBasisKind | undefined, next: CostBasisKind): CostBasisKind {
  return worstCostBasisKind(current, next) ?? next
}

/** 成本 × 系数(倍率/占比),basis 不变。 */
export function scalePricedCost(value: PricedCost, factor: number): PricedCost {
  if (!Number.isFinite(factor)) return { ...value, cost: 0 }
  return { ...value, cost: value.cost * factor }
}

/** 兼容层:老调用点只想要 number 时显式取 cost(必须同时自行处理 basis 标注)。 */
export function pricedCostToNumber(value: PricedCost): number {
  return value.cost
}
