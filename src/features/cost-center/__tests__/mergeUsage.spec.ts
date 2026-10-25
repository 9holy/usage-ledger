import './costDataI18n'
/**
 * 合并口径 → 计价衔接单测（P0-15 T03）。
 *
 * 锁死四件事：
 * ① 计价唯一入口是 `cockpitSplitCostUsd() × cockpitPriceBook.ts`（与直连口径同参同结果）；
 * ② **档位质量与来源无关**：sessions 格与 logs 格一视同仁走 `priced`，
 *    long 档照常按 ×2/×2/×1.5 计（这是 2026-09-12 QA 复核纠正的错误前提）；
 * ③ 无可用单价 → `no_price_no_estimate`（cost 恒 0 但标注"未知"，绝不冒充 $0）；
 * ④ 覆盖率文案形如「含 N 天由会话源补全（日志侧漏记）」。
 */
import { describe, expect, it } from 'vitest'
import type { MergedCell, TierCoverage } from '@/api/ledgerMerge'
import {
  mergeCoverageLabel,
  mergedCellCost,
  mergeLongRatioHint,
} from '../mergeUsage'
import { cockpitPriceSetFor, cockpitEffectivePriceSets } from '../cockpitPriceBook'

/** gpt-6-astra 标准档 10/1/50（USD / 1M），长上下文 ×2/×2/×1.5。 */
const PER_MILLION = 1e6

function cell(overrides: Partial<MergedCell> = {}): MergedCell {
  return {
    dayBucketMs: Date.UTC(2026, 8, 10),
    modelId: 'gpt-6-astra',
    sourceAccountId: 'codex_a1',
    apiKeyId: '',
    tokens: {
      stdNormalInput: 1_000_000,
      stdCached: 0,
      stdOutput: 0,
      longNormalInput: 0,
      longCached: 0,
      longOutput: 0,
    },
    requests: 10,
    success: 9,
    error: 1,
    winner: 'logs',
    bothPresent: true,
    logsTokens: 1_000_000,
    sessionsTokens: 900_000,
    ...overrides,
  }
}

describe('mergedCellCost · 走 cockpitSplitCostUsd × 内置价目表', () => {
  it('标准档：1M input × $10/1M = $10', () => {
    const c = mergedCellCost(cell(), undefined, 1)
    expect(c.basis.kind).toBe('priced')
    expect(c.cost).toBeCloseTo(10, 9)
  })

  it('长文本档按 ×2/×2/×1.5 计价（与直连口径一致）', () => {
    const c = mergedCellCost(
      cell({
        tokens: {
          stdNormalInput: 0,
          stdCached: 0,
          stdOutput: 0,
          longNormalInput: 1_000_000,
          longCached: 0,
          longOutput: 1_000_000,
        },
      }),
      undefined,
      1,
    )
    // input 10 × 2 = 20；output 50 × 1.5 = 75
    expect(c.cost).toBeCloseTo(95, 9)
    expect(c.basis.kind).toBe('priced')
  })

  it('倍率与直连口径同参', () => {
    expect(mergedCellCost(cell(), undefined, 2).cost).toBeCloseTo(20, 9)
  })
})

/**
 * **关键回归**：档位质量**不按来源判断**。
 *
 * 两源都走 `TokenSplit::add`（阈值 272_000），sessions 格同样带 long 档 ——
 * 初版给 sessions 格降级成 `source_estimate` 是错的（会让人以为长文本溢价没计）。
 */
describe('mergedCellCost · sessions 格与 logs 格一视同仁', () => {
  it('sessions 胜出：仍是 priced，long 档照常按 ×2/×2/×1.5 计入', () => {
    const c = mergedCellCost(
      cell({
        winner: 'sessions',
        tokens: {
          stdNormalInput: 0,
          stdCached: 0,
          stdOutput: 0,
          longNormalInput: 1_000_000,
          longCached: 0,
          longOutput: 1_000_000,
        },
      }),
      undefined,
      1,
    )
    expect(c.basis.kind).toBe('priced', '来源不影响 basis')
    expect(c.cost).toBeCloseTo(95, 9)
  })

  it('sessionsOnly（日志侧漏记的天）同样按 priced 计', () => {
    const c = mergedCellCost(cell({ winner: 'sessionsOnly' }), undefined, 1)
    expect(c.basis.kind).toBe('priced')
    expect(c.cost).toBeCloseTo(10, 9)
  })

  it('basis 只有 priced / no_price_no_estimate 两种（不再按来源降级）', () => {
    const kinds = new Set([
      mergedCellCost(cell()).basis.kind,
      mergedCellCost(cell({ winner: 'sessions' })).basis.kind,
      mergedCellCost(cell({ winner: 'sessionsOnly' })).basis.kind,
      mergedCellCost(cell({ modelId: 'no-such-model' })).basis.kind,
    ])
    expect([...kinds].sort()).toEqual(['no_price_no_estimate', 'priced'])
  })
})

describe('mergedCellCost · 无可用单价', () => {
  it('cost 恒 0 但 basis 是 no_price_no_estimate（不静默变 0 / 不冒充 $0）', () => {
    const c = mergedCellCost(cell({ modelId: 'no-such-model' }))
    expect(c.cost).toBe(0)
    expect(c.basis.kind).toBe('no_price_no_estimate')
    expect(c.label).toContain('非 $0')
  })

  it('合并层不搬运 estimated_cost_usd ⇒ 无单价时没有可回退的估算', () => {
    const sets = cockpitEffectivePriceSets(undefined)
    expect(cockpitPriceSetFor(sets, 'gpt-5.4')).toBeTruthy()
    const c = mergedCellCost(cell({ modelId: 'gpt-5.4' }), undefined, 1)
    // gpt-5.4 标准档 2.5/0.25/15 ⇒ 1M input = $2.5
    expect(c.cost).toBeCloseTo(2.5, 9)
    expect(c.basis.kind).toBe('priced')
  })
})

describe('mergeCoverageLabel · 覆盖率文案', () => {
  it('形如「含 N 天由会话源补全（日志侧漏记）」', () => {
    const coverage: TierCoverage = {
      sessionsBackfilledDays: 43,
      sessionsBackfilledTokens: 22_833_695_225,
      longRatioObserved: 0.2,
    }
    expect(mergeCoverageLabel(coverage)).toBe('含 43 天由会话源补全（日志侧漏记）')
  })

  it('没有补全天时说"全部由网关请求口径覆盖"；无覆盖率时说"未知"', () => {
    expect(
      mergeCoverageLabel({ sessionsBackfilledDays: 0, sessionsBackfilledTokens: 0, longRatioObserved: null }),
    ).toBe('全部由网关请求口径覆盖')
    expect(mergeCoverageLabel(null)).toBe('覆盖率未知')
  })

  /** 文案里**不得**再出现"未分档" —— 那是错误前提留下的说法。 */
  it('文案不再出现"未分档"（档位质量与来源无关）', () => {
    const text = mergeCoverageLabel({
      sessionsBackfilledDays: 43,
      sessionsBackfilledTokens: 1,
      longRatioObserved: 0.2,
    })
    expect(text).not.toContain('未分档')
  })
})

describe('mergeLongRatioHint · 长文本文档位占比', () => {
  it('有观测值时给出占比，并说明已计入成本（不是"低估"提示）', () => {
    const text = mergeLongRatioHint({
      sessionsBackfilledDays: 1,
      sessionsBackfilledTokens: 1,
      longRatioObserved: 0.2,
    })
    expect(text).toContain('20.00%')
    expect(text).toContain('已按')
    expect(text).not.toContain('低估')
  })

  it('无数据（null）时如实说"无用量数据"，不编 0%', () => {
    expect(
      mergeLongRatioHint({ sessionsBackfilledDays: 0, sessionsBackfilledTokens: 0, longRatioObserved: null }),
    ).toContain('无用量数据')
    expect(mergeLongRatioHint(null)).toContain('无用量数据')
  })
})

describe('单位换算自检', () => {
  it('价目表是 USD / 1M token（1 token = $1e-6 × 单价）', () => {
    const c = mergedCellCost(
      cell({
        tokens: { stdNormalInput: 1, stdCached: 0, stdOutput: 0, longNormalInput: 0, longCached: 0, longOutput: 0 },
      }),
      undefined,
      1,
    )
    expect(c.cost).toBeCloseTo(10 / PER_MILLION, 12)
  })
})
