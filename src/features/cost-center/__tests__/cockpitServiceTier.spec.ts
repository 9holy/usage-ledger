/**
 * cockpit 服务档位(`service_tier`)全链路 —— 2026-09-20
 *
 * 背景:档位倍率表(`COCKPIT_SERVICE_TIER_MULTIPLIERS`)早已定义,但从数据读取到计价
 * **全链路都没用上**。一旦出现 priority 流量,成本会**少算 50%**。
 *
 * 本文件的断言分两组:
 * ① 倍率本身:standard ⇒ ×1、priority ⇒ ×2、flex ⇒ ×0.5;
 * ② 语义诚实:空串 / 未知值 / 缺字段 ⇒ 倍率仍为 ×1,但**措辞不得声称这是 standard 档**
 *    (本机实测 `service_tier` 的 `''` 是「日志未记录档位」,不是「standard」)。
 *
 * 计价入口唯一:`cockpitSplitCostUsd()` × `cockpitPriceBook.ts`。
 */
import { describe, expect, it } from 'vitest'
import {
  COCKPIT_COST_BASIS_BOOK,
  cockpitRequestLogGroupCost,
  cockpitRequestLogToAccountStats,
  cockpitRequestLogToApiKeyStats,
  cockpitRequestLogToCostTrend,
  cockpitRequestLogToModelStats,
  cockpitSplitCostUsd,
} from '../cockpitAdapter'
import {
  cockpitEffectivePriceSets,
  cockpitServiceTierLabel,
  cockpitServiceTierMultiplier,
  normalizeCockpitServiceTier,
} from '../cockpitPriceBook'
import type { CockpitRequestLogCell, CockpitRequestLogGroup, CockpitRequestLogSummary } from '../../../api/cockpit'

/** 内置价目表:gpt-6-astra 标准档 10 / 1 / 50 USD per 1M token。 */
const sets = cockpitEffectivePriceSets(undefined)
const ASTRA = sets['gpt-6-astra']!

/** 一条 (模型×账号×key×档位) 聚合。token 分档默认 0。 */
function group(overrides: Partial<CockpitRequestLogGroup> = {}): CockpitRequestLogGroup {
  return {
    model: 'gpt-6-astra',
    accountId: 'codex_abc',
    apiKeyId: '',
    firstMs: 1_700_000_000_000,
    lastMs: 1_700_000_060_000,
    requests: 1,
    success: 1,
    error: 0,
    stdNormalInput: 0,
    stdCached: 0,
    stdOutput: 0,
    longNormalInput: 0,
    longCached: 0,
    longOutput: 0,
    estimatedCostUsd: 0,
    rateLimited: 0,
    upstreamError: 0,
    clientCanceled: 0,
    serviceTier: '',
    ...overrides,
  }
}

function cell(overrides: Partial<CockpitRequestLogCell> = {}): CockpitRequestLogCell {
  return { startMs: 1_700_000_000_000, model: 'gpt-6-astra', ...group(), ...overrides }
}

function summaryOf(
  groups: CockpitRequestLogGroup[],
  cells: CockpitRequestLogCell[] = [],
): CockpitRequestLogSummary {
  return {
    available: true,
    reason: null,
    rowCount: groups.reduce((s, g) => s + g.requests, 0),
    windowStartMs: 1_700_000_000_000,
    windowEndMs: 1_700_000_060_000,
    bucketHours: 1,
    cells,
    groups,
    bucketLatencies: [],
  }
}

/* -------------------------------------------------------------------------- */
/* ① 档位归一化 + 倍率                                                          */
/* -------------------------------------------------------------------------- */

describe('cockpit 服务档位:归一化与倍率', () => {
  it('三个已知档位各自归一化,大小写/空白不影响', () => {
    expect(normalizeCockpitServiceTier('standard')).toBe('standard')
    expect(normalizeCockpitServiceTier('priority')).toBe('priority')
    expect(normalizeCockpitServiceTier('flex')).toBe('flex')
    expect(normalizeCockpitServiceTier('  Priority ')).toBe('priority')
  })

  it('空串 / null / undefined / 未知值一律 → null(「未记录」,绝不冒充 standard)', () => {
    for (const raw of ['', '   ', null, undefined, 'auto', 'default', 'PRIORITY_PLUS']) {
      expect(normalizeCockpitServiceTier(raw)).toBeNull()
    }
  })

  it('成对倍率:standard ×1 / priority ×2 / flex ×0.5;未记录 ×1', () => {
    expect(cockpitServiceTierMultiplier('standard')).toBe(1)
    expect(cockpitServiceTierMultiplier('priority')).toBe(2)
    expect(cockpitServiceTierMultiplier('flex')).toBe(0.5)
    // 未记录档位数值上与 standard 相同,但语义是「不知道」——见下一条措辞断言
    expect(cockpitServiceTierMultiplier('')).toBe(1)
    expect(cockpitServiceTierMultiplier(null)).toBe(1)
  })

  it('★ 措辞:空串/未记录档位的标签必须写「未记录」,不得渲染成 Standard', () => {
    expect(cockpitServiceTierLabel('standard')).toBe('Standard')
    for (const raw of ['', null, undefined, 'auto']) {
      const label = cockpitServiceTierLabel(raw)
      expect(label).toContain('未记录')
      expect(label).not.toBe('Standard')
      expect(label.toLowerCase()).not.toContain('standard')
    }
  })
})

/* -------------------------------------------------------------------------- */
/* ② 计价:档位倍率真的进了钱                                                    */
/* -------------------------------------------------------------------------- */

describe('cockpitSplitCostUsd:档位倍率参与计价', () => {
  // 1M 标准档输入 × $10/M = $10
  const oneMillionStdInput = () => group({ stdNormalInput: 1_000_000 })

  it('standard ⇒ ×1($10)', () => {
    const { cost, basis } = cockpitSplitCostUsd(oneMillionStdInput(), ASTRA, 1, 'standard')
    expect(cost).toBeCloseTo(10, 9)
    expect(basis).toBe(COCKPIT_COST_BASIS_BOOK)
  })

  it('priority ⇒ ×2($20),并在口径文案里如实标注', () => {
    const { cost, basis } = cockpitSplitCostUsd(oneMillionStdInput(), ASTRA, 1, 'priority')
    expect(cost).toBeCloseTo(20, 9)
    expect(basis).toContain('× 2')
    expect(basis).toContain('priority')
  })

  it('flex ⇒ ×0.5($5)', () => {
    const { cost, basis } = cockpitSplitCostUsd(oneMillionStdInput(), ASTRA, 1, 'flex')
    expect(cost).toBeCloseTo(5, 9)
    expect(basis).toContain('× 0.5')
  })

  it('★ 未记录档位(空串)⇒ ×1 且数字与 standard 相同,但**不追加任何档位标注**', () => {
    const unrecorded = cockpitSplitCostUsd(oneMillionStdInput(), ASTRA, 1, '')
    const standard = cockpitSplitCostUsd(oneMillionStdInput(), ASTRA, 1, 'standard')
    expect(unrecorded.cost).toBeCloseTo(standard.cost, 12)
    // 口径文案与"有单价"基线**逐字相同** ⇒ 没有任何档位后缀
    expect(unrecorded.basis).toBe(COCKPIT_COST_BASIS_BOOK)
    expect(unrecorded.basis).toBe(standard.basis)
    expect(unrecorded.basis).not.toContain('Standard')
    expect(unrecorded.basis).not.toContain('priority')
    expect(unrecorded.basis).not.toContain('× 2')
    expect(unrecorded.basis).not.toContain('× 0.5')
  })

  it('档位倍率与账号成本倍率是两回事,各自独立相乘', () => {
    // $10 × 账号倍率 2 × priority 倍率 2 = $40
    expect(cockpitSplitCostUsd(oneMillionStdInput(), ASTRA, 2, 'priority').cost).toBeCloseTo(40, 9)
    // 只给账号倍率,不给档位 ⇒ ×1
    expect(cockpitSplitCostUsd(oneMillionStdInput(), ASTRA, 2).cost).toBeCloseTo(20, 9)
  })

  it('显式入参优先于数据自带的档位', () => {
    const split = oneMillionStdInput()
    expect(split.serviceTier).toBe('')
    // 数据说"未记录",调用方说"这批是 priority" ⇒ 听调用方的
    expect(cockpitSplitCostUsd(split, ASTRA, 1, 'priority').cost).toBeCloseTo(20, 9)
    // 反过来:数据带 priority,调用方显式给 standard ⇒ 听调用方的
    expect(cockpitSplitCostUsd(group({ stdNormalInput: 1_000_000, serviceTier: 'priority' }), ASTRA, 1, 'standard').cost).toBeCloseTo(10, 9)
  })

  it('不传档位时,读该批数据自带的 serviceTier(Rust 已按档位拆聚合)', () => {
    const split = group({ stdNormalInput: 1_000_000, serviceTier: 'priority' })
    expect(cockpitSplitCostUsd(split, ASTRA, 1).cost).toBeCloseTo(20, 9)
  })

  it('无单价回退数据源估算时**不**再乘档位倍率(数据源估算已反映实际档位,乘了就是双重计价)', () => {
    const split = group({ model: 'gpt-image-2', stdNormalInput: 1000, estimatedCostUsd: 12.5, serviceTier: 'priority' })
    const { cost } = cockpitSplitCostUsd(split, sets['gpt-image-2'], 1, 'priority')
    expect(cost).toBeCloseTo(12.5, 9)
  })

  it('长文本档 token 同样吃档位倍率(priority 下整批 ×2)', () => {
    // 长文本 1M × $20/M = $20;priority ⇒ $40
    const split = group({ longNormalInput: 1_000_000 })
    expect(cockpitSplitCostUsd(split, ASTRA, 1, 'priority').cost).toBeCloseTo(40, 9)
  })
})

/* -------------------------------------------------------------------------- */
/* ③ 聚合路径:档位信息不能被合并吃掉                                             */
/* -------------------------------------------------------------------------- */

describe('cockpit 聚合路径:按档位分组计价', () => {
  it('★ 同模型混有 standard 与 priority 时,逐档位计价后相加(不是先合并再 ×1)', () => {
    const s = summaryOf([
      group({ serviceTier: 'standard', stdNormalInput: 1_000_000, requests: 1 }),
      group({ serviceTier: 'priority', stdNormalInput: 1_000_000, requests: 1 }),
    ])
    const stats = cockpitRequestLogToModelStats(s, sets, 1)
    expect(stats).toHaveLength(1)
    expect(stats[0]!.requests).toBe(2)
    // $10(standard) + $20(priority) = $30;若合并 token 后按 ×1 会得 $20(少算 1/3)
    expect(stats[0]!.cost).toBeCloseTo(30, 9)
  })

  it('逐账号成本:档位倍率逐组生效', () => {
    const s = summaryOf([
      group({ accountId: 'codex_a', serviceTier: 'priority', stdNormalInput: 1_000_000 }),
      group({ accountId: 'codex_a', serviceTier: 'standard', stdNormalInput: 1_000_000 }),
    ])
    const stats = cockpitRequestLogToAccountStats(s, sets, 1)
    const rows = Object.values(stats)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.cost).toBeCloseTo(30, 9)
  })

  it('逐 API Key 成本:档位倍率逐组生效', () => {
    const s = summaryOf([
      group({ apiKeyId: 'key-1', serviceTier: 'priority', stdNormalInput: 1_000_000 }),
    ])
    const stats = cockpitRequestLogToApiKeyStats(s, sets, 1)
    expect(stats['key-1']!.cost).toBeCloseTo(20, 9)
  })

  it('成本趋势:同桶内不同档位分别计价后相加', () => {
    const s = summaryOf([], [
      cell({ serviceTier: 'standard', stdNormalInput: 1_000_000 }),
      cell({ serviceTier: 'priority', stdNormalInput: 1_000_000 }),
    ])
    const trend = cockpitRequestLogToCostTrend(s, sets, 1)
    expect(trend).toHaveLength(1)
    expect(trend[0]!.cost).toBeCloseTo(30, 9)
  })

  it('(模型×账号) 精确成本:档位倍率逐组生效', () => {
    const s = summaryOf([
      group({ serviceTier: 'priority', stdNormalInput: 1_000_000 }),
    ])
    const byGroup = cockpitRequestLogGroupCost(s, sets, 1)
    const rows = [...byGroup.values()]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.cost).toBeCloseTo(20, 9)
  })

  it('未记录档位的聚合仍按 ×1 计(本机当前无 priority 流量 ⇒ 数字不变)', () => {
    const s = summaryOf([group({ serviceTier: '', stdNormalInput: 1_000_000 })])
    expect(cockpitRequestLogToModelStats(s, sets, 1)[0]!.cost).toBeCloseTo(10, 9)
  })
})
