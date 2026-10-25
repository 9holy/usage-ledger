/**
 * 成本倍率的**唯一入口**(架构设计 【F】7.1 / PRD P0-16)。
 *
 * 背景:倍率兜底表达式原先内联 8 处 + `?? DEFAULT` 2 处 + 调用点 6 处,
 * 分散实现必然在某处漏乘/漏兜底(已真实发生:useUnifiedCost 汇总卡片乘了倍率,
 * 逐账号行没乘 → 同一页面两个口径)。
 *
 * 语义:未手动设置成本价格时,**官方价 × 倍率** 作为 billed 兜底。
 *
 * 硬约束:全仓非测试代码禁止再**内联**倍率兜底判定(即"有限且为正,否则取兜底常量"
 * 这个判断),一律改调本文件的 `resolveCostMultiplier()`。兜底常量只在 model.ts 定义一次。
 */

import { DEFAULT_COST_MULTIPLIER } from './model'

/** 合法倍率:必须是有限数且严格为正。全仓唯一一份判定实现。 */
function isUsableMultiplier(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * 解析成本倍率;入参非法(undefined / null / 0 / 负数 / NaN / Infinity / 非数字)时
 * 回退 `DEFAULT_COST_MULTIPLIER`(model.ts,当前 0.2)。
 */
export function resolveCostMultiplier(value?: number | null): number {
  return isUsableMultiplier(value) ? value : DEFAULT_COST_MULTIPLIER
}

/**
 * 与 `resolveCostMultiplier` 同判定,但不套兜底值:返 null 表示"调用方没给合法倍率"。
 * 供需要区分"用户没设"与"用户设成 0.7"的场景使用。
 */
export function costMultiplierOrNull(value?: number | null): number | null {
  return isUsableMultiplier(value) ? value : null
}

/** 官方价金额 × 倍率(非法金额按 0 处理,不让 NaN 污染上游求和)。 */
export function applyCostMultiplier(amount: number, multiplier?: number | null): number {
  if (!Number.isFinite(amount)) return 0
  return amount * resolveCostMultiplier(multiplier)
}
