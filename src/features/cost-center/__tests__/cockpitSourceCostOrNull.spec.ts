/**
 * cockpit 数据源自带 `estimatedCostUsd` 的**哨兵 0** 判据回归锁。
 *
 * 病根:cockpit 那个字段同一个 0 承担两种含义 ——
 *   ① 真的没用过;② 有用量,但 cockpit 没给该模型配单价。
 * 源码证据(cockpit-tools 仓库):
 *   · `src-tauri/src/modules/codex_local_access_routing_pricing.rs:1824`
 *     `let Some(pricing) = resolve_base_model_pricing(None, model) else { return 0.0; };`
 *   · 同文件 `:1845` `if cost.is_finite() && cost > 0.0 { cost } else { 0.0 }`
 *   · 其 TS 层 `src/utils/codexWindowStats.ts:104` `estimatedCostUsd: totals?.estimatedCostUsd ?? 0`
 * 本机实测样本(读 `%USERPROFILE%\.antigravity_cockpit\codex_local_access_stats.json`):
 *   · `monthly.models` 的 `gpt-image-2`:`totalTokens: 6704`、`estimatedCostUsd: 0.0`
 *     —— **有用量、无单价**的哨兵 0,不是推演。
 *   · 同文件 `accounts[]` 里 35 个 0 成本账号**全部** `totalTokens === 0`(真的没用过)。
 *
 * 断言成对写:缺失 ⇒ null;真实 0 ⇒ 仍是 0。
 */
import { describe, it, expect } from 'vitest'
import { cockpitSourceCostOrNull, isCockpitSentinelZero } from '../cockpitAdapter'

/** 只带本判据关心的两个字段(其余字段与判据无关)。 */
function usage(estimatedCostUsd: unknown, totalTokens: unknown) {
  return { estimatedCostUsd, totalTokens }
}

describe('cockpitSourceCostOrNull · 哨兵 0', () => {
  it('有用量却报 0 ⇒ 未知(null),不是实测 0(本机 gpt-image-2 真实样本)', () => {
    expect(cockpitSourceCostOrNull(usage(0, 6704))).toBeNull()
  })

  it('一点用量都没有时 0 是**真值**,必须原样返回 0(不能连带把真实 0 也判成未知)', () => {
    expect(cockpitSourceCostOrNull(usage(0, 0))).toBe(0)
    expect(cockpitSourceCostOrNull(usage(0, 0))).not.toBeNull()
  })

  it('负成本 + 有用量 ⇒ 未知(负成本无经济含义,同样不能当实测值)', () => {
    expect(cockpitSourceCostOrNull(usage(-1, 1000))).toBeNull()
    expect(cockpitSourceCostOrNull(usage(-0.0001, 1))).toBeNull()
  })

  it('正常有价:原样返回,且不被倍率/单位改动', () => {
    expect(cockpitSourceCostOrNull(usage(12.5, 1000))).toBe(12.5)
    expect(cockpitSourceCostOrNull(usage(26703.026330520297, 23_869_163_651))).toBeCloseTo(26703.026330520297, 9)
  })

  it('字段缺失 ≠ 0:必须 null(Number(null) === 0 是编译器看不见的陷阱)', () => {
    expect(cockpitSourceCostOrNull(usage(null, 0))).toBeNull()
    expect(cockpitSourceCostOrNull(usage(undefined, 1000))).toBeNull()
    expect(cockpitSourceCostOrNull({})).toBeNull()
    expect(cockpitSourceCostOrNull({ totalTokens: 100 })).toBeNull()
  })

  it('整块 usage 缺失 ⇒ null', () => {
    expect(cockpitSourceCostOrNull(null)).toBeNull()
    expect(cockpitSourceCostOrNull(undefined)).toBeNull()
  })

  it('非有限数(NaN / Infinity / 字符串)⇒ null,不得渲染成 $NaN', () => {
    expect(cockpitSourceCostOrNull(usage(Number.NaN, 1000))).toBeNull()
    expect(cockpitSourceCostOrNull(usage(Number.POSITIVE_INFINITY, 1000))).toBeNull()
    expect(cockpitSourceCostOrNull(usage('abc', 1000))).toBeNull()
  })

  it('totalTokens 缺失时不能凭"没用量"把 0 当真实 0 —— 缺 token 数就没有判据', () => {
    // totalTokens undefined → Number(undefined) = NaN → 不大于 0 → 不构成"有用量"
    // ⇒ 退回"0 是真值"。这是**有意的**:源没给 token 数时,0 只能按 cockpit 的原样接受,
    //    同时 `useUnifiedCost.cockpitStatus` 的 reason 会把这种情况说清。
    //    这里把当前行为钉住,将来若改判据必须先改这条断言并说明理由。
    expect(cockpitSourceCostOrNull(usage(0, undefined))).toBe(0)
  })
})

describe('isCockpitSentinelZero · 与 cockpitSourceCostOrNull 同一条判据', () => {
  it('只在"有值、≤0、且有用量"时为 true', () => {
    expect(isCockpitSentinelZero(usage(0, 6704))).toBe(true)
    expect(isCockpitSentinelZero(usage(-3, 1))).toBe(true)
  })

  it('真实 0(无用量)不算哨兵 0', () => {
    expect(isCockpitSentinelZero(usage(0, 0))).toBe(false)
  })

  it('字段缺失 / 有正常成本 / 整块缺失都不算哨兵 0', () => {
    expect(isCockpitSentinelZero(usage(null, 1000))).toBe(false)
    expect(isCockpitSentinelZero(usage(undefined, 1000))).toBe(false)
    expect(isCockpitSentinelZero(usage(12.5, 1000))).toBe(false)
    expect(isCockpitSentinelZero({})).toBe(false)
    expect(isCockpitSentinelZero(null)).toBe(false)
    expect(isCockpitSentinelZero(undefined)).toBe(false)
  })

  it('两个函数必须一致:被 cockpitSourceCostOrNull 判成 null 的"有值"行,必然是哨兵 0', () => {
    const rows = [usage(0, 6704), usage(-1, 1000), usage(0, 0), usage(12.5, 1000), usage(null, 0), usage(0, undefined)]
    for (const row of rows) {
      const cost = cockpitSourceCostOrNull(row)
      const raw = row.estimatedCostUsd
      if (raw == null || cost != null) continue
      expect(isCockpitSentinelZero(row)).toBe(true)
    }
  })
})
