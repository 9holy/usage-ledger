/**
 * 多源合并口径客户端单测（PRD P0-15）。
 *
 * 锁死四件事：
 * ① 命令名与 camelCase 参数与 Rust 一致；② 失败返 null 不抛错；
 * ③ **合并结果里没有任何金额字段**（账本只存量不存钱）；
 * ④ 口径文案是"已定案"；覆盖率说的是"由会话源补全"，**不是"未分档"**。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import './costCenterLocaleFixture'
import i18n from '@/i18n'
import { invoke } from '@tauri-apps/api/core'
import {
  describeMergedUsage,
  isSessionsWinner,
  mergedCellRows,
  mergedLedgerUsage,
  MERGE_WINNER_LABELS,
  tierVectorLong,
  tierVectorTotal,
  type MergedCell,
  type MergedUsageResult,
} from '../ledgerMerge'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/api/url', () => ({ isDesktopRuntime: () => true }))
vi.mock('@/stores/connection', () => ({ errMsg: (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback) }))

/** 2026-09-10 / 2026-09-11（UTC） */
const D1 = Date.UTC(2026, 8, 10)
const D2 = Date.UTC(2026, 8, 11)

it('switches source labels without altering merged tokens, amounts or raw model identities', () => {
  const value = result()
  const values = () => mergedCellRows(value).map(({ winnerLabel: _label, ...row }) => row)
  const before = values()
  i18n.global.locale.value = 'en'
  expect(MERGE_WINNER_LABELS.sessions).toBe('Sessions (sessions)')
  expect(describeMergedUsage(value)).toBe('Policy: daily × model maximum')
  expect(describeMergedUsage({ ...value, available: false, reason: '来源诊断原文' })).toContain('来源诊断原文')
  expect(values()).toEqual(before)
  i18n.global.locale.value = 'zh'
  expect(MERGE_WINNER_LABELS.sessions).toBe('会话（sessions）')
})

function cell(overrides: Partial<MergedCell> = {}): MergedCell {
  return {
    dayBucketMs: D1,
    modelId: 'gpt-6-astra',
    sourceAccountId: 'codex_a1',
    apiKeyId: '',
    tokens: {
      stdNormalInput: 600,
      stdCached: 200,
      stdOutput: 200,
      longNormalInput: 0,
      longCached: 0,
      longOutput: 0,
    },
    requests: 10,
    success: 9,
    error: 1,
    winner: 'logs',
    bothPresent: true,
    logsTokens: 1_000,
    sessionsTokens: 1_000,
    ...overrides,
  }
}

function result(overrides: Partial<MergedUsageResult> = {}): MergedUsageResult {
  return {
    available: true,
    reason: null,
    cells: [
      cell(),
      cell({
        dayBucketMs: D2,
        modelId: 'gpt-5.6-luna',
        winner: 'sessionsOnly',
        bothPresent: false,
        logsTokens: 0,
        sessionsTokens: 7_000,
        tokens: {
          stdNormalInput: 5_000,
          stdCached: 1_500,
          stdOutput: 500,
          longNormalInput: 0,
          longCached: 0,
          longOutput: 0,
        },
      }),
    ],
    coverage: {
      sessionsBackfilledDays: 1,
      sessionsBackfilledTokens: 7_000,
      longRatioObserved: 0.2,
    },
    windowStartMs: D1,
    windowEndMs: D2,
    ...overrides,
  }
}

describe('mergedLedgerUsage · 命令封装', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
  })

  it('命令名与 camelCase 参数与 Rust 一致', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(result())
    await mergedLedgerUsage(7)
    expect(invoke).toHaveBeenCalledWith('ledger_merged_usage', { windowDays: 7 })
  })

  it('不传窗口时用 null（全量）', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(result())
    await mergedLedgerUsage()
    expect(invoke).toHaveBeenCalledWith('ledger_merged_usage', { windowDays: null })
  })

  it('失败返回 null 而不是抛错', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('账本未生成'))
    await expect(mergedLedgerUsage()).resolves.toBeNull()
  })
})

describe('TierVector 助手', () => {
  it('合计 = 6 档位之和；长文本合计 = 3 个 long 档位', () => {
    const t = cell().tokens
    expect(tierVectorTotal(t)).toBe(1_000)
    expect(tierVectorLong(t)).toBe(0)
    const withLong = { ...t, longNormalInput: 120, longCached: 50, longOutput: 30 }
    expect(tierVectorTotal(withLong)).toBe(1_200)
    expect(tierVectorLong(withLong)).toBe(200)
  })
})

describe('winner 标签与 sessions 侧判定', () => {
  it('四种 winner 都有中文标签', () => {
    for (const w of ['logs', 'sessions', 'logsOnly', 'sessionsOnly'] as const) {
      expect(MERGE_WINNER_LABELS[w]).toBeTruthy()
    }
  })

  it('sessions / sessionsOnly 是 sessions 侧（= 日志侧漏记、由会话源补上）', () => {
    expect(isSessionsWinner('sessions')).toBe(true)
    expect(isSessionsWinner('sessionsOnly')).toBe(true)
    expect(isSessionsWinner('logs')).toBe(false)
    expect(isSessionsWinner('logsOnly')).toBe(false)
  })
})

describe('mergedCellRows · 明细行', () => {
  it('按天升序、同天按 token 降序，并补上 UTC 日期与 winner 标签', () => {
    const rows = mergedCellRows(
      result({
        cells: [
          cell({ dayBucketMs: D2, modelId: 'b', tokens: { ...cell().tokens } }),
          cell({ dayBucketMs: D1, modelId: 'a' }),
          cell({
            dayBucketMs: D2,
            modelId: 'c',
            tokens: { stdNormalInput: 900, stdCached: 0, stdOutput: 0, longNormalInput: 0, longCached: 0, longOutput: 0 },
          }),
        ],
      }),
    )
    // 同天按 token 降序：b(1,000) 在 c(900) 前
    expect(rows.map((r) => `${r.day}/${r.modelId}`)).toEqual([
      '2026-09-10/a',
      '2026-09-11/b',
      '2026-09-11/c',
    ])
    expect(rows[0].totalTokens).toBe(1_000)
    expect(rows[0].winnerLabel).toBe('网关请求（logs）')
  })

  it('null → 空数组，不编造', () => {
    expect(mergedCellRows(null)).toEqual([])
  })
})

describe('describeMergedUsage · 口径文案', () => {
  it('已定案：按天 × 模型取大', () => {
    expect(describeMergedUsage(result())).toBe('已定：按天 × 模型取大')
  })

  it('未执行 / 不可用 / 空账本分别如实说明', () => {
    expect(describeMergedUsage(null)).toContain('未执行')
    expect(describeMergedUsage(result({ available: false, reason: '账本尚未生成' }))).toContain('账本尚未生成')
    expect(describeMergedUsage(result({ cells: [], reason: '账本里没有用量数据' }))).toContain('账本里没有用量数据')
  })
})

describe('没有金额字段（红线）', () => {
  it('MergedCell / MergedUsageResult 里不得出现任何 cost 字段', () => {
    const c = cell()
    for (const key of Object.keys(c)) {
      expect(key.toLowerCase()).not.toContain('cost')
      expect(key.toLowerCase()).not.toContain('usd')
    }
    const r = result()
    for (const key of Object.keys(r)) {
      expect(key.toLowerCase()).not.toContain('cost')
    }
    expect(Object.keys(c)).not.toContain('estimatedCostUsd')
  })

  /**
   * **回归（2026-09-12 QA 复核）**：`graded` 字段已删除。
   *
   * 它按"来源"硬编码档位质量（sessions 胜出 ⇒ `false`），前提是错的 ——
   * 两源都走 `TokenSplit::add`（阈值 272_000）判档，与 source 无关。
   * 留着只会继续把"由会话源补全的量"误报成"没分档的量"。
   */
  it('MergedCell 没有 graded 字段（档位质量不按来源判断）', () => {
    expect(Object.keys(cell())).not.toContain('graded')
    expect(Object.keys(result().coverage)).not.toContain('ungradedDays')
  })
})
