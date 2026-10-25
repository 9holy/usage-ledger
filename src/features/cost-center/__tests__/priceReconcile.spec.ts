import './costDataI18n'
/**
 * 价目对账单测（缺口 ③「无独立单价交叉校验」）。
 *
 * 最关键的一条：**同一模型天然有两组单价（标准档 + 长文本档），不是调价。**
 * 真实数据实测 gpt-5.6-sol = 5/0.5/30（133,455 行）+ 10/1/45（10,125 行），
 * 后者正是标准档 × 2/2/1.5。若不做档位归位，每个有长文本流量的模型都会被误报。
 *
 * 关键：这份对账**只提示，不改成本**。计价唯一入口仍是
 * `cockpitSplitCostUsd()` × `cockpitPriceBook.ts`。
 */
import { describe, expect, it } from 'vitest'
import { COCKPIT_PRICE_BOOK, COCKPIT_PRICE_BOOK_VERSION } from '../cockpitPriceBook'
import { reconcileCockpitPrices, PRICE_RECONCILE_STATUS_LABELS } from '../priceReconcile'
import type { CockpitModelPriceSnapshot, CockpitPriceVariant } from '@/api/cockpit/facets'

interface VariantSpec {
  price: [number, number, number]
  rows: number
  /** 该组里有几条是长上下文请求 */
  longRows?: number
  versions?: number[]
}

function snap(
  model: string,
  specs: VariantSpec[],
  totalRows?: number,
): CockpitModelPriceSnapshot {
  const variants: CockpitPriceVariant[] = specs.map((s) => {
    const longRows = s.longRows ?? 0
    return {
      inputUsdPerMillion: s.price[0],
      cachedInputUsdPerMillion: s.price[1],
      outputUsdPerMillion: s.price[2],
      rows: s.rows,
      longContextRows: longRows,
      standardRows: s.rows - longRows,
      estimatedCostUsd: 0,
      pricingVersions: s.versions ?? [COCKPIT_PRICE_BOOK_VERSION],
    }
  })
  return {
    model,
    rows: totalRows ?? specs.reduce((n, s) => n + s.rows, 0),
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    estimatedCostUsd: 1,
    variants,
  }
}

/** gpt-5.6-sol 的真实形态：标准档 5/0.5/30 + 长文本档 10/1/45。 */
function realSolSnapshot(): CockpitModelPriceSnapshot {
  return snap('gpt-5.6-sol', [
    { price: [5, 0.5, 30], rows: 133_455 },
    { price: [10, 1, 45], rows: 10_125, longRows: 10_125 },
  ])
}

describe('长文本档归位（最关键）', () => {
  it('标准档 + 长文本档两组单价必须判为 match，绝不能误报成"窗口内调价"', () => {
    const r = reconcileCockpitPrices([realSolSnapshot()])
    expect(r.rows).toHaveLength(1)
    const row = r.rows[0]
    expect(row.standard.status).toBe('match')
    expect(row.standard.variantCount).toBe(1)
    expect(row.long).not.toBeNull()
    expect(row.long!.status).toBe('match')
    expect(row.long!.rows).toBe(10_125)
    expect(row.status).toBe('match')
    expect(r.issueCount).toBe(0)
    expect(r.summary).toContain('价目一致')
    expect(r.summary).toContain('长文本档')
  })

  it('长文本档单价 = 标准档 × 2/2/1.5（与 cockpit 同规则）', () => {
    const row = reconcileCockpitPrices([realSolSnapshot()]).rows[0]
    expect(row.long!.ours).toEqual({ input: 10, cached: 1, output: 45 })
    expect(row.long!.cockpit).toEqual({ input: 10, cached: 1, output: 45 })
  })

  it('gpt-6-astra 的真实形态（10/1/50 + 20/2/75）同样一致', () => {
    const s = snap('gpt-6-astra', [
      { price: [10, 1, 50], rows: 3_540 },
      { price: [20, 2, 75], rows: 3_822, longRows: 3_822 },
    ])
    const r = reconcileCockpitPrices([s])
    expect(r.rows[0].standard.status).toBe('match')
    expect(r.rows[0].long!.status).toBe('match')
  })

  it('模型只有标准档流量 → long 为 null（不编造长文本档）', () => {
    const r = reconcileCockpitPrices([snap('gpt-5.6-sol', [{ price: [5, 0.5, 30], rows: 100 }])])
    expect(r.rows[0].long).toBeNull()
    expect(r.rows[0].status).toBe('match')
  })

  it('同一档位内出现两组单价 → 才是真正的 price_changed', () => {
    const s = snap('gpt-5.6-sol', [
      { price: [5, 0.5, 30], rows: 800 },
      { price: [7, 0.7, 42], rows: 200 },
    ])
    const r = reconcileCockpitPrices([s])
    expect(r.rows[0].standard.variantCount).toBe(2)
    expect(r.rows[0].standard.status).toBe('price_changed')
    expect(r.summary).toContain('调价')
  })
})

describe('档位不一致的判定', () => {
  it('标准档输入价不一致 → mismatch 且指出档位名', () => {
    const r = reconcileCockpitPrices([snap('gpt-5.6-sol', [{ price: [6, 0.5, 30], rows: 100 }])])
    expect(r.rows[0].standard.status).toBe('mismatch')
    expect(r.rows[0].standard.differingFields).toEqual(['输入'])
    expect(r.rows[0].standard.ours).toEqual({ input: 5, cached: 0.5, output: 30 })
    expect(r.summary).toContain('1 个档位单价不一致')
  })

  it('长文本档不一致 → mismatch（说明长文本倍率可能变了）', () => {
    const s = snap('gpt-5.6-sol', [
      { price: [5, 0.5, 30], rows: 100 },
      { price: [11, 1, 45], rows: 50, longRows: 50 },
    ])
    const r = reconcileCockpitPrices([s])
    expect(r.rows[0].standard.status).toBe('match')
    expect(r.rows[0].long!.status).toBe('mismatch')
    expect(r.rows[0].long!.differingFields).toEqual(['输入'])
    expect(r.rows[0].status).toBe('mismatch')
  })

  it('多档不一致时全部列出', () => {
    const r = reconcileCockpitPrices([snap('gpt-5.6-sol', [{ price: [6, 0.6, 30], rows: 10 }])])
    expect(r.rows[0].standard.differingFields).toEqual(['输入', '缓存命中'])
  })

  it('防回归:价目侧取到非有限值时判为"不一致"，绝不静默通过', () => {
    // 这条锁死一类真实踩过的坑:把价目表原始字段名(inputUsdPerMillion)当三元组(input)用，
    // 会让 Math.abs(6 - undefined) = NaN，而 NaN > EPS 恒为 false ⇒ 不一致被判成一致。
    const r = reconcileCockpitPrices([snap('gpt-5.6-sol', [{ price: [5, 0.5, 30], rows: 10 }])])
    // 正常路径:一致就是一致
    expect(r.rows[0].standard.differingFields).toEqual([])
    // 人为制造非有限值:必须报不一致
    const bad = reconcileCockpitPrices([
      snap('gpt-5.6-sol', [{ price: [Number.NaN, 0.5, 30], rows: 10 }]),
    ])
    expect(bad.rows[0].standard.differingFields).toContain('输入')
    expect(bad.rows[0].standard.status).toBe('mismatch')
  })

  it('价目表未收录该模型 → not_in_book', () => {
    const r = reconcileCockpitPrices([snap('某未来模型', [{ price: [9, 0.9, 90], rows: 10 }])])
    expect(r.rows[0].standard.status).toBe('not_in_book')
    expect(r.rows[0].standard.ours).toBeNull()
    expect(r.summary).toContain('未收录')
  })

  it('源有长文本档但价目表标注 sessionLongContext=false → long_context_not_declared', () => {
    // gpt-5.3-codex 在价目表里 sessionLongContext: false
    const s = snap('gpt-5.3-codex', [
      { price: [1.75, 0.175, 14], rows: 10 },
      { price: [3.5, 0.35, 21], rows: 5, longRows: 5 },
    ])
    const r = reconcileCockpitPrices([s])
    expect(r.rows[0].standard.status).toBe('match')
    expect(r.rows[0].long!.status).toBe('long_context_not_declared')
    expect(r.rows[0].status).toBe('long_context_not_declared')
    expect(r.summary).toContain('长文本档未声明')
  })
})

describe('边界与排序', () => {
  it('源侧单价全 0（未记录）→ no_price_recorded，且不计入 comparedCount / issueCount', () => {
    const r = reconcileCockpitPrices([snap('gpt-5.6-sol', [{ price: [0, 0, 0], rows: 100 }])])
    expect(r.rows[0].standard.status).toBe('no_price_recorded')
    expect(r.comparedCount).toBe(0)
    expect(r.issueCount).toBe(0)
    expect(r.summary).toContain('价目一致')
  })

  it('无 variants → no_price_recorded，不崩', () => {
    const s = snap('gpt-5.6-sol', [])
    s.variants = []
    const r = reconcileCockpitPrices([s])
    expect(r.rows[0].standard.status).toBe('no_price_recorded')
    expect(r.rows[0].standard.cockpit).toBeNull()
    expect(r.rows[0].long).toBeNull()
  })

  it('按请求数降序（权重大的先看）', () => {
    const r = reconcileCockpitPrices([
      snap('gpt-5.6-luna', [{ price: [0.2, 0.02, 1.2], rows: 10 }]),
      snap('gpt-5.6-sol', [{ price: [5, 0.5, 30], rows: 999 }]),
    ])
    expect(r.rows.map((x) => x.model)).toEqual(['gpt-5.6-sol', 'gpt-5.6-luna'])
  })

  it('null / 空输入 → 不崩，如实说明无可对账模型', () => {
    for (const input of [null, undefined, []]) {
      const r = reconcileCockpitPrices(input)
      expect(r.rows).toEqual([])
      expect(r.summary).toContain('无可对账模型')
      expect(r.issueCount).toBe(0)
    }
  })
})

describe('价目版本号', () => {
  it('源版本号不含本地版本 → versionMismatch，摘要点明两个版本', () => {
    const r = reconcileCockpitPrices([
      snap('gpt-5.6-sol', [{ price: [5, 0.5, 30], rows: 10, versions: [99] }]),
    ])
    expect(r.versionMismatch).toBe(true)
    expect(r.sourceVersions).toEqual([99])
    expect(r.bookVersion).toBe(COCKPIT_PRICE_BOOK_VERSION)
    expect(r.summary).toContain(`本地 ${COCKPIT_PRICE_BOOK_VERSION}`)
  })

  it('源版本号含本地版本 → 不算不一致', () => {
    const r = reconcileCockpitPrices([
      snap('gpt-5.6-sol', [{ price: [5, 0.5, 30], rows: 10, versions: [2, 3] }]),
    ])
    expect(r.versionMismatch).toBe(false)
    expect(r.sourceVersions).toEqual([2, 3])
  })

  it('源完全没有版本号 → 不臆断不一致', () => {
    const r = reconcileCockpitPrices([
      snap('gpt-5.6-sol', [{ price: [5, 0.5, 30], rows: 10, versions: [] }]),
    ])
    expect(r.versionMismatch).toBe(false)
  })
})

describe('价目表自身一致性（防手改错）', () => {
  it('每个收录模型的缓存价都必须低于输入价（否则缓存越多越贵，口径反了）', () => {
    for (const [model, entry] of Object.entries(COCKPIT_PRICE_BOOK)) {
      expect(entry.standard.cachedInputUsdPerMillion, model).toBeLessThan(entry.standard.inputUsdPerMillion)
    }
  })

  it('每个收录模型的输出价都必须 ≥ 输入价', () => {
    for (const [model, entry] of Object.entries(COCKPIT_PRICE_BOOK)) {
      expect(entry.standard.outputUsdPerMillion, model).toBeGreaterThanOrEqual(
        entry.standard.inputUsdPerMillion,
      )
    }
  })

  it('状态标签覆盖全部状态（UI 不会出现空白徽标）', () => {
    for (const s of [
      'match',
      'mismatch',
      'not_in_book',
      'price_changed',
      'no_price_recorded',
      'long_context_not_declared',
    ] as const) {
      expect(PRICE_RECONCILE_STATUS_LABELS[s]).toBeTruthy()
    }
  })
})
