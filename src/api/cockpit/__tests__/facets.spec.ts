/**
 * `request_logs` 未读维度汇总客户端单测（PRD 缺口 ③）。
 *
 * 锁死四件事：① 命令名与参数名与 Rust 侧一致；② 失败不抛错（不阻塞首屏）；
 * ③ **缺列必须如实为空 + 可判定**，绝不显示 0；④ 失败分类必须含 `request_failed`
 * （旧口径下它只能落进"其他 error"，彻底不可见）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import '@/api/__tests__/costCenterLocaleFixture'
import i18n from '@/i18n'
import { invoke } from '@tauri-apps/api/core'
import {
  describeFailureBreakdown,
  errorCategoryRows,
  facetDimensionUnavailable,
  gatewayModeRows,
  getRequestLogFacets,
  nullifyMissingFacetNumbers,
  reasoningEffortRows,
  requestKindLabel,
  requestKindRows,
  type CockpitRequestLogFacets,
} from '../facets'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/api/url', () => ({ isDesktopRuntime: () => true }))
vi.mock('@/stores/connection', () => ({ errMsg: (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback) }))

it('localizes known facet labels while preserving counts, shares, unknown categories and source diagnostics', () => {
  const value = facets()
  const evidence = () => errorCategoryRows(value).map(({ label: _label, ...row }) => row)
  const before = evidence()
  i18n.global.locale.value = 'en'
  expect(errorCategoryRows(value).find(row => row.key === 'request_failed')?.label).toBe('Request failed (unspecified)')
  expect(reasoningEffortRows(value).find(row => row.key === 'xhigh')?.label).toBe('Extra high')
  expect(requestKindLabel('原始类型')).toBe('原始类型')
  expect(describeFailureBreakdown(value)).toContain('100 unclassified')
  expect(describeFailureBreakdown({ ...value, available: false, reason: '来源诊断原文' })).toContain('来源诊断原文')
  expect(evidence()).toEqual(before)
  i18n.global.locale.value = 'zh'
  expect(reasoningEffortRows(value).find(row => row.key === 'xhigh')?.label).toBe('极高')
})

function facets(overrides: Partial<CockpitRequestLogFacets> = {}): CockpitRequestLogFacets {
  return {
    available: true,
    reason: null,
    rowCount: 181_829,
    successRows: 176_000,
    failedRows: 5_829,
    failedWithoutCategory: 100,
    errorCategories: {
      upstream_error: 19_296,
      request_failed: 4_212,
      client_canceled: 2_762,
      quota_or_rate_limit: 731,
      auth_failed: 130,
    },
    reasoningTokens: 23_718_880,
    reasoningRows: 130_614,
    reasoningEfforts: { xhigh: 39_779, medium: 25_900, max: 18_501 },
    gatewayModes: { sidecar: 180_399, legacy: 1_430 },
    requestKinds: { text: 181_825 },
    priceSnapshots: [],
    presentColumns: ['model_id', 'error_category', 'reasoning_effort'],
    missingColumns: [],
    ...overrides,
  }
}

describe('getRequestLogFacets · 命令封装', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
  })

  it('命令名与 camelCase 参数与 Rust 一致', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(JSON.stringify(facets()))
    await getRequestLogFacets(1_000, 2_000)
    expect(invoke).toHaveBeenCalledWith('cockpit_request_log_facets', { startMs: 1_000, endMs: 2_000 })
  })

  it('不传窗口时用 null（不是 undefined）', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(JSON.stringify(facets()))
    await getRequestLogFacets()
    expect(invoke).toHaveBeenCalledWith('cockpit_request_log_facets', { startMs: null, endMs: null })
  })

  it('失败返回 null 而不是抛错', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('库不存在'))
    await expect(getRequestLogFacets()).resolves.toBeNull()
  })

  it('返回体不是对象时也返 null（不把坏数据当结果）', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(JSON.stringify({ nope: 1 }))
    await expect(getRequestLogFacets()).resolves.toBeNull()
  })
})

describe('facetDimensionUnavailable · 缺列判定', () => {
  it('null → 不可得', () => {
    expect(facetDimensionUnavailable(null, 'reasoning_effort')).toBe(true)
  })

  it('列在 missingColumns 里 → 不可得（忽略大小写）', () => {
    expect(facetDimensionUnavailable(facets({ missingColumns: ['Gateway_Mode'] }), 'gateway_mode')).toBe(true)
  })

  it('列不在 missingColumns 里 → 可得', () => {
    expect(facetDimensionUnavailable(facets({ missingColumns: [] }), 'gateway_mode')).toBe(false)
  })
})

/** 一份带数字的单价快照（模拟 Rust `priceSnapshots[i]`）。 */
function snapshot() {
  return {
    model: 'gpt-5.6-sol',
    rows: 120,
    inputTokens: 1_000,
    outputTokens: 200,
    cachedTokens: 50,
    reasoningTokens: 30,
    estimatedCostUsd: 12.5,
    variants: [
      {
        inputUsdPerMillion: 5, outputUsdPerMillion: 30, cachedInputUsdPerMillion: 0.5,
        rows: 100, longContextRows: 0, standardRows: 100, estimatedCostUsd: 10, pricingVersions: [1],
      },
      {
        inputUsdPerMillion: 10, outputUsdPerMillion: 45, cachedInputUsdPerMillion: 1,
        rows: 20, longContextRows: 20, standardRows: 0, estimatedCostUsd: 2.5, pricingVersions: [1],
      },
    ],
  }
}

function facetsWithSnapshot(missingColumns: string[]) {
  return facets({ priceSnapshots: [snapshot()], missingColumns })
}

describe('nullifyMissingFacetNumbers · 缺列 ⇒ 未知,不是 0', () => {
  it('无缺列 ⇒ 原样返回同一对象(不重建,值也不动)', () => {
    const f = facetsWithSnapshot([])
    const out = nullifyMissingFacetNumbers(f)
    expect(out).toBe(f)
    expect(out.priceSnapshots[0].estimatedCostUsd).toBe(12.5)
    expect(out.priceSnapshots[0].variants[1].estimatedCostUsd).toBe(2.5)
  })

  it('缺 estimated_cost_usd ⇒ 快照与每档位成本都是 null,不能是 0', () => {
    const out = nullifyMissingFacetNumbers(facetsWithSnapshot(['estimated_cost_usd']))
    expect(out.priceSnapshots[0].estimatedCostUsd).toBeNull()
    expect(out.priceSnapshots[0].variants[0].estimatedCostUsd).toBeNull()
    expect(out.priceSnapshots[0].variants[1].estimatedCostUsd).toBeNull()
    // 成对断言:同一份快照里**与成本无关**的字段不能被误伤
    expect(out.priceSnapshots[0].inputTokens).toBe(1_000)
    expect(out.priceSnapshots[0].rows).toBe(120)
  })

  it('缺 token 三列 ⇒ 只有对应字段变 null(逐列独立,不共用一个 flag)', () => {
    const out = nullifyMissingFacetNumbers(
      facetsWithSnapshot(['input_tokens', 'cached_tokens']),
    )
    expect(out.priceSnapshots[0].inputTokens).toBeNull()
    expect(out.priceSnapshots[0].cachedTokens).toBeNull()
    // 未缺的列必须保留原值 —— 「一条 null 吞掉整块」是过度修正
    expect(out.priceSnapshots[0].outputTokens).toBe(200)
    expect(out.priceSnapshots[0].estimatedCostUsd).toBe(12.5)
  })

  it('缺 reasoning_tokens ⇒ 只抹快照里的那份,顶层 reasoningTokens 不动', () => {
    const out = nullifyMissingFacetNumbers(facetsWithSnapshot(['reasoning_tokens']))
    expect(out.priceSnapshots[0].reasoningTokens).toBeNull()
    // 顶层有独立的视图级守卫(uiShellContract.spec.ts 钉住),不在这里抹第二遍
    expect(out.reasoningTokens).toBe(23_718_880)
  })

  it('缺列但快照为空数组 ⇒ 不炸,仍返回缺列后的对象', () => {
    const out = nullifyMissingFacetNumbers(facets({ priceSnapshots: [], missingColumns: ['input_tokens'] }))
    expect(out.priceSnapshots).toEqual([])
  })

  it('大小写不敏感(与 facetDimensionUnavailable 同一判据)', () => {
    const out = nullifyMissingFacetNumbers(facetsWithSnapshot(['Estimated_Cost_USD']))
    expect(out.priceSnapshots[0].estimatedCostUsd).toBeNull()
  })

  it('端到端:解析边界就抹掉 —— Rust 回 0 + 缺列,前端拿到的是 null', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(JSON.stringify(facetsWithSnapshot(['estimated_cost_usd'])))
    const out = await getRequestLogFacets()
    expect(out).not.toBeNull()
    expect(out!.priceSnapshots[0].estimatedCostUsd).toBeNull()
    expect(out!.priceSnapshots[0].estimatedCostUsd).not.toBe(0)
  })
})

describe('errorCategoryRows · 失败分类', () => {
  it('request_failed 必须出现（旧口径下完全不可见）', () => {
    const rows = errorCategoryRows(facets())
    const rf = rows.find((r) => r.key === 'request_failed')
    expect(rf).toBeDefined()
    expect(rf!.count).toBe(4_212)
    expect(rf!.label).toBe('请求失败（未细分）')
  })

  it('按数量降序', () => {
    const counts = errorCategoryRows(facets()).map((r) => r.count)
    expect([...counts].sort((a, b) => b - a)).toEqual(counts)
  })

  it('占比按分类内合计计算；未收录的分类名原样保留（不吞）', () => {
    const rows = errorCategoryRows(facets({ errorCategories: { a: 3, b: 1, 未来新分类: 4 } }))
    expect(rows.map((r) => r.key)).toEqual(['未来新分类', 'a', 'b'])
    expect(rows.find((r) => r.key === '未来新分类')!.label).toBe('未来新分类')
    expect(rows.find((r) => r.key === 'a')!.share).toBeCloseTo(0.375)
  })

  it('无数据时 share 为 null（不是 0 —— 0 会被读成"占 0%"）', () => {
    expect(errorCategoryRows(facets({ errorCategories: {} }))).toEqual([])
  })
})

describe('describeFailureBreakdown · 一句话摘要', () => {
  it('未分类的失败必须单独说出来，不能并进"其他"', () => {
    const text = describeFailureBreakdown(facets())
    expect(text).toContain('失败 5829 次')
    expect(text).toContain('未分类 100 次')
  })

  it('无未分类失败时不出现该句', () => {
    const text = describeFailureBreakdown(facets({ failedWithoutCategory: 0 }))
    expect(text).not.toContain('未分类')
  })

  it('未读取 / 不可用时如实说明', () => {
    expect(describeFailureBreakdown(null)).toContain('未读取')
    expect(describeFailureBreakdown(facets({ available: false, reason: '库不存在' }))).toContain('库不存在')
  })
})

describe('推理档位 / 网关模式分布', () => {
  it('推理档位用中文标签且降序', () => {
    const rows = reasoningEffortRows(facets())
    expect(rows[0].key).toBe('xhigh')
    expect(rows[0].label).toBe('极高')
  })

  it('网关模式用中文标签（能看出多少走了旧通道）', () => {
    const rows = gatewayModeRows(facets())
    const legacy = rows.find((r) => r.key === 'legacy')
    expect(legacy!.label).toBe('Legacy（旧通道）')
    expect(legacy!.count).toBe(1_430)
  })

  it('null 时返回空数组，不编造', () => {
    expect(reasoningEffortRows(null)).toEqual([])
    expect(gatewayModeRows(null)).toEqual([])
  })
})

describe('requestKindRows · 请求类型分布（源已给、此前前端漏接）', () => {
  it('已收录取值给中文标签且降序', () => {
    const rows = requestKindRows(facets({ requestKinds: { text: 181_825, image_generation: 900, image_edit: 40 } }))
    expect(rows.map((r) => r.key)).toEqual(['text', 'image_generation', 'image_edit'])
    expect(rows[0].label).toBe('文本')
    expect(rows[1].label).toBe('图像生成')
  })

  it('未收录取值原样返回，不硬编一个中文名', () => {
    expect(requestKindLabel('some_future_kind')).toBe('some_future_kind')
    const rows = requestKindRows(facets({ requestKinds: { some_future_kind: 7 } }))
    expect(rows[0].label).toBe('some_future_kind')
    expect(rows[0].label).not.toBe('其他')
  })

  it('维度不可得 ⇒ 空数组（不落 0）', () => {
    expect(requestKindRows(null)).toEqual([])
    // 旧版 payload 可能整字段缺失（类型声明了非可选，但网络 JSON 无运行时保证）
    const missing = facets({ requestKinds: undefined as unknown as Record<string, number> })
    expect(requestKindRows(missing)).toEqual([])
  })

  it('真实的 0 仍是 0，不转成 null / 不消失', () => {
    const rows = requestKindRows(facets({ requestKinds: { text: 0 } }))
    expect(rows).toHaveLength(1)
    expect(rows[0].count).toBe(0)
    // 合计为 0 时占比不可算 ⇒ null（0 会被读成"占 0%"）
    expect(rows[0].share).toBeNull()
  })

  it('缺列时可判定为"该版本不提供"，有列时可得', () => {
    expect(facetDimensionUnavailable(facets({ missingColumns: ['request_kind'] }), 'request_kind')).toBe(true)
    expect(facetDimensionUnavailable(facets(), 'request_kind')).toBe(false)
  })
})
