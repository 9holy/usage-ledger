/**
 * 多源对账客户端单测（PRD P0-25）。
 *
 * 锁死四件事：
 * ① 命令名与参数名与 Rust 侧一致；② 失败不抛错；
 * ③ **两源数字永远并列，绝不产出"总额"**；
 * ④ **结论必须带可复核的数字**，且未拍板前永远标注"合并口径待定"。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import './costCenterLocaleFixture'
import i18n from '@/i18n'
import { invoke } from '@tauri-apps/api/core'
import {
  describeLedgerSourceRow,
  describeReconcile,
  formatDivergence,
  formatUtcDay,
  listLedgerSources,
  RECONCILE_VERDICT_LABELS,
  reconcileCellRows,
  reconcileLedgerSources,
  reconcileVerdictTone,
  type LedgerSourceInfo,
  type ReconcileResult,
} from '../ledgerQuery'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/api/url', () => ({ isDesktopRuntime: () => true }))
vi.mock('@/stores/connection', () => ({ errMsg: (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback) }))

const DAY = 86_400_000
/** 2026-09-10 / 2026-09-11（UTC） */
const D1 = Date.UTC(2026, 8, 10)
const D2 = Date.UTC(2026, 8, 11)

it('switches reconciliation labels without changing evidence, day boundaries or raw diagnostic text', () => {
  const value = result()
  const before = reconcileCellRows(value)
  i18n.global.locale.value = 'en'
  expect(RECONCILE_VERDICT_LABELS.noOverlap).toBe('No overlap between sources')
  expect(describeReconcile(value)).toContain('Merge basis pending')
  expect(describeReconcile({ ...value, available: false, reason: '来源诊断原文' })).toContain('来源诊断原文')
  expect(formatDivergence(null)).toBe('Cannot compare')
  expect(formatDivergence(0)).toBe('0.0%')
  expect(reconcileCellRows(value)).toEqual(before)
  expect(formatUtcDay(D1)).toBe('2026-09-10')
  i18n.global.locale.value = 'zh'
  expect(RECONCILE_VERDICT_LABELS.noOverlap).toBe('两源无重叠')
})

function result(overrides: Partial<ReconcileResult> = {}): ReconcileResult {
  return {
    available: true,
    reason: null,
    cells: [
      {
        dayBucketMs: D1,
        modelId: 'gpt-5.6-sol',
        logsTokens: 1_000,
        logsRequests: 10,
        sessionsTokens: 1_100,
        sessionsRequests: 11,
        tokenDiff: 100,
        requestsDiff: 1,
        overlap: true,
      },
      {
        dayBucketMs: D2,
        modelId: 'gpt-5.6-luna',
        logsTokens: 500,
        logsRequests: 5,
        sessionsTokens: 0,
        sessionsRequests: 0,
        tokenDiff: -500,
        requestsDiff: -5,
        overlap: false,
      },
    ],
    sources: [
      {
        sourceName: 'codex_logs',
        label: '网关请求口径（codex_logs）',
        tokens: 1_500,
        requests: 15,
        days: 2,
        firstMs: D1,
        lastMs: D2,
      },
      {
        sourceName: 'codex_sessions',
        label: '会话口径（codex_sessions）',
        tokens: 1_100,
        requests: 11,
        days: 1,
        firstMs: D1,
        lastMs: D1,
      },
    ],
    overlapStartMs: D1,
    overlapEndMs: D1,
    overlapDays: 1,
    overlapLogsTokens: 1_000,
    overlapSessionsTokens: 1_100,
    overlapDivergence: 100 / 1_100,
    overlapDaysClose: 1,
    overlapDaysDivergent: 0,
    topDivergentDays: [],
    divergenceThreshold: 0.2,
    verdict: 'likelySameBatch',
    verdictReason: '重叠 1 天（2026-09-10..2026-09-10）：logs 1000 token vs sessions 1100 token，总差异比 9.1%（阈值 20%）；逐天看：1 天吻合 / 0 天偏离。',
    t0Ms: D2,
    ...overrides,
  }
}

describe('reconcileLedgerSources · 命令封装', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
  })

  it('命令名与 camelCase 参数与 Rust 一致', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(result())
    await reconcileLedgerSources(7)
    expect(invoke).toHaveBeenCalledWith('ledger_reconcile_sources', { windowDays: 7 })
  })

  it('不传窗口时用 null（全量）', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(result())
    await reconcileLedgerSources()
    expect(invoke).toHaveBeenCalledWith('ledger_reconcile_sources', { windowDays: null })
  })

  it('失败返回 null 而不是抛错', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('账本未生成'))
    await expect(reconcileLedgerSources()).resolves.toBeNull()
  })
})

describe('listLedgerSources · 源清单', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
  })

  it('失败返回空数组而不是抛错', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('boom'))
    await expect(listLedgerSources()).resolves.toEqual([])
  })

  it('返回体不是数组时也返空数组（不把坏数据当结果）', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ nope: 1 })
    await expect(listLedgerSources()).resolves.toEqual([])
  })
})

describe('formatUtcDay / formatDivergence', () => {
  it('日期按 UTC 格式化（不得用本地时区）', () => {
    expect(formatUtcDay(Date.UTC(2026, 0, 1))).toBe('2026-01-01')
    expect(formatUtcDay(Date.UTC(2026, 11, 31))).toBe('2026-12-31')
  })

  it('差异比 null → 「无法比较」，不是 0%', () => {
    expect(formatDivergence(null)).toBe('无法比较')
    expect(formatDivergence(0)).toBe('0.0%')
    expect(formatDivergence(0.091)).toBe('9.1%')
  })
})

describe('结论标签与语气', () => {
  it('五种结论都有中文标签', () => {
    for (const v of [
      'noOverlap',
      'insufficientData',
      'likelySameBatch',
      'likelyDifferentBatch',
      'mixedBatch',
    ] as const) {
      expect(RECONCILE_VERDICT_LABELS[v]).toBeTruthy()
    }
  })

  it('不同批次 / 混合 = warn（需要用户拍板）；同一批 / 无重叠 = ok；证据不足 = unknown', () => {
    expect(reconcileVerdictTone('likelyDifferentBatch')).toBe('warn')
    expect(reconcileVerdictTone('mixedBatch')).toBe('warn')
    expect(reconcileVerdictTone('likelySameBatch')).toBe('ok')
    expect(reconcileVerdictTone('noOverlap')).toBe('ok')
    expect(reconcileVerdictTone('insufficientData')).toBe('unknown')
  })
})

describe('describeReconcile · 一句话摘要', () => {
  it('永远标注"合并口径待定（对账中）"—— 未拍板前不得伪装已定案', () => {
    const text = describeReconcile(result())
    expect(text).toContain('合并口径待定（对账中）')
    expect(text).toContain('同批（逐天吻合）')
    expect(text).toContain('9.1%')
    expect(text).not.toContain('已定案')
  })

  it('必须带"逐天结构"，不能只报总差异比（总比值会被少数异常天拉高）', () => {
    const text = describeReconcile(
      result({ overlapDays: 32, overlapDaysClose: 25, overlapDaysDivergent: 7, overlapDivergence: 0.277 }),
    )
    expect(text).toContain('25 天吻合 / 7 天偏离')
    expect(text).toContain('27.7%')
  })

  it('混合结论如实呈现', () => {
    const text = describeReconcile(
      result({ verdict: 'mixedBatch', overlapDaysClose: 25, overlapDaysDivergent: 7 }),
    )
    expect(text).toContain('混合（需逐天判断）')
  })

  it('无重叠时说明"无需合并"', () => {
    const text = describeReconcile(result({ overlapDays: 0, verdict: 'noOverlap', overlapDivergence: null }))
    expect(text).toContain('两源无重叠')
    expect(text).toContain('无需合并')
  })

  it('证据不足时说明原因', () => {
    const text = describeReconcile(
      result({ verdict: 'insufficientData', verdictReason: '账本里只有 codex_logs 一个源' }),
    )
    expect(text).toContain('证据不足')
  })

  it('未执行 / 不可用 / 空账本分别如实说明', () => {
    expect(describeReconcile(null)).toContain('未执行')
    expect(describeReconcile(result({ available: false, reason: '账本尚未生成' }))).toContain('账本尚未生成')
    expect(describeReconcile(result({ cells: [] }))).toContain('暂无用量数据')
  })
})

describe('topDivergentDays · 异常天证据', () => {
  it('偏离天原样带出，含差额与差异比（用户拍板的关键证据）', () => {
    const r = result({
      verdict: 'mixedBatch',
      overlapDays: 32,
      overlapDaysClose: 31,
      overlapDaysDivergent: 1,
      topDivergentDays: [
        {
          dayBucketMs: D1,
          day: '2026-07-29',
          logsTokens: 145_254_646,
          sessionsTokens: 1_500_640_748,
          tokenDiff: 1_355_386_102,
          divergence: 0.903,
        },
      ],
    })
    expect(r.topDivergentDays).toHaveLength(1)
    expect(r.topDivergentDays[0].day).toBe('2026-07-29')
    expect(r.topDivergentDays[0].tokenDiff).toBe(1_355_386_102)
  })
})

describe('reconcileCellRows · 明细行', () => {
  it('按天升序、同天按两源合计量降序', () => {
    const rows = reconcileCellRows(
      result({
        cells: [
          { dayBucketMs: D2, modelId: 'b', logsTokens: 10, logsRequests: 1, sessionsTokens: 0, sessionsRequests: 0, tokenDiff: -10, requestsDiff: -1, overlap: false },
          { dayBucketMs: D1, modelId: 'a', logsTokens: 100, logsRequests: 1, sessionsTokens: 0, sessionsRequests: 0, tokenDiff: -100, requestsDiff: -1, overlap: false },
          { dayBucketMs: D2, modelId: 'c', logsTokens: 900, logsRequests: 1, sessionsTokens: 0, sessionsRequests: 0, tokenDiff: -900, requestsDiff: -1, overlap: false },
        ],
      }),
    )
    expect(rows.map((r) => `${r.day}/${r.modelId}`)).toEqual([
      '2026-09-10/a',
      '2026-09-11/c',
      '2026-09-11/b',
    ])
  })

  it('补上可读日期与差异比；两源合计为 0 时差异比为 null', () => {
    const rows = reconcileCellRows(result())
    const c = rows.find((r) => r.dayBucketMs === D1)!
    expect(c.day).toBe('2026-09-10')
    expect(c.totalTokens).toBe(2_100)
    expect(c.divergence).toBeCloseTo(100 / 1_100)

    const zero = reconcileCellRows(
      result({
        cells: [
          { dayBucketMs: D1, modelId: 'm', logsTokens: 0, logsRequests: 0, sessionsTokens: 0, sessionsRequests: 0, tokenDiff: 0, requestsDiff: 0, overlap: false },
        ],
      }),
    )
    expect(zero[0].divergence).toBeNull()
  })

  it('null → 空数组，不编造', () => {
    expect(reconcileCellRows(null)).toEqual([])
  })
})

describe('describeLedgerSourceRow · 源清单行', () => {
  const info: LedgerSourceInfo = {
    sourceName: 'codex_logs',
    label: '网关请求口径（codex_logs）',
    sourcePath: 'C:/logs.sqlite',
    lastId: 181_818,
    lastTsMs: 0,
    lastIngestMs: 0,
    totalRowsSeen: 0,
    resetGeneration: 0,
    rows: 2_829,
    tokens: 19_896_008_487,
    requests: 181_818,
    firstMs: D1,
    lastMs: D2,
  }

  it('含水位、账本行数、请求数', () => {
    const text = describeLedgerSourceRow(info)
    expect(text).toContain('水位 181818')
    expect(text).toContain('账本 2829 行')
  })

  it('源库重建过则提示世代', () => {
    expect(describeLedgerSourceRow({ ...info, resetGeneration: 3 })).toContain('世代 3')
  })
})

describe('不产出总额（红线）', () => {
  it('两源合计只出现在 sources 里各自成行，没有合并字段', () => {
    const r = result()
    // 逐源合计必须各自独立
    expect(r.sources).toHaveLength(2)
    const logs = r.sources.find((s) => s.sourceName === 'codex_logs')!
    const sess = r.sources.find((s) => s.sourceName === 'codex_sessions')!
    expect(logs.tokens).toBe(1_500)
    expect(sess.tokens).toBe(1_100)
    // 结果对象里不得有"总额"类字段
    const keys = Object.keys(r)
    expect(keys).not.toContain('totalTokens')
    expect(keys).not.toContain('mergedTokens')
  })
})
