/**
 * 本地持久账本客户端单测（二期 T11–T13 的"最后一公里"）。
 *
 * 背景：`ledger_ingest` 曾注册在 `main.rs` 却**全仓零调用**，账本从未落盘。
 * 本测试锁死四件事：① 调用参数名与 Rust 侧一致；② 失败不抛错（不阻塞首屏）；
 * ③ 会话内只触发一次（避免每次切窗口重扫 40 万行）；
 * ④ **逐源上报**——绝不把两源合并成一个数字，否则"会话源一行都没进来"会被掩盖。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import './costCenterLocaleFixture'
import i18n from '@/i18n'
import { invoke } from '@tauri-apps/api/core'
import {
  describeLedgerIngest,
  describeLedgerSource,
  ledgerAllUnavailableReason,
  ledgerIngest,
  ledgerIngestOnce,
  ledgerIngestTriggered,
  ledgerSourceDelivered,
  ledgerSourceLabel,
  resetLedgerIngestTriggerForTest,
  type LedgerIngestResult,
  type LedgerSourceOutcome,
} from '../ledger'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/api/url', () => ({ isDesktopRuntime: () => true }))
vi.mock('@/stores/connection', () => ({ errMsg: (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback) }))

it('switches ingest explanations while retaining source identities, raw diagnostics and outcome counts', () => {
  const value = source({ label: '原始来源 Alpha', scannedRows: 12, upsertedBuckets: 3 })
  i18n.global.locale.value = 'en'
  expect(describeLedgerSource(value)).toContain('原始来源 Alpha: scanned 12 rows / updated 3 buckets')
  expect(describeLedgerSource({ ...value, sourceAvailable: false, reason: '来源诊断原文' })).toContain('来源诊断原文')
  expect(describeLedgerIngest(null)).toContain('Ledger ingest not run')
  expect(value.scannedRows).toBe(12)
  i18n.global.locale.value = 'zh'
  expect(describeLedgerSource(value)).toContain('扫描 12 行 / 更新 3 桶')
})

function source(overrides: Partial<LedgerSourceOutcome> = {}): LedgerSourceOutcome {
  return {
    sourceName: 'codex_logs',
    label: 'cockpit 单请求用量库(codex_local_access_logs.sqlite)',
    ok: true,
    skipped: false,
    sourceAvailable: true,
    reason: null,
    scannedRows: 181_823,
    upsertedBuckets: 514,
    newIdentityRows: 5,
    lastId: 181_818,
    rescanTriggered: false,
    sourceResetDetected: false,
    sourceGeneration: 1,
    durationMs: 1_900,
    ...overrides,
  }
}

function result(overrides: Partial<LedgerIngestResult> = {}): LedgerIngestResult {
  const sources = overrides.sources ?? [
    source(),
    source({
      sourceName: 'codex_sessions',
      label: 'cockpit 会话用量库(codex_session_usage.sqlite)',
      scannedRows: 234_990,
      upsertedBuckets: 1_401,
      lastId: 234_990,
    }),
  ]
  return {
    ok: true,
    totalScannedRows: sources.reduce((n, s) => n + s.scannedRows, 0),
    totalUpsertedBuckets: sources.reduce((n, s) => n + s.upsertedBuckets, 0),
    durationMs: 4_200,
    ...overrides,
    sources,
  }
}

describe('ledgerIngest · 命令封装', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
    resetLedgerIngestTriggerForTest()
  })

  it('传 camelCase 参数（与 Rust `full_rescan` / `overlap_rows` 对应）', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(result())
    await ledgerIngest(true, 500)
    expect(invoke).toHaveBeenCalledWith('ledger_ingest', { fullRescan: true, overlapRows: 500 })
  })

  it('默认 fullRescan=false、overlapRows=null', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(result())
    await ledgerIngest()
    expect(invoke).toHaveBeenCalledWith('ledger_ingest', { fullRescan: false, overlapRows: null })
  })

  it('失败返回 null 而不是抛错（不阻塞首屏）', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('开账本失败'))
    await expect(ledgerIngest()).resolves.toBeNull()
  })
})

describe('ledgerIngestOnce · 会话内只触发一次', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset()
    resetLedgerIngestTriggerForTest()
  })

  it('第二次调用直接返回，不再 invoke', async () => {
    vi.mocked(invoke).mockResolvedValue(result())
    ledgerIngestOnce()
    ledgerIngestOnce()
    ledgerIngestOnce()
    // 首次是异步的，等一个微任务队列
    await Promise.resolve()
    await Promise.resolve()
    expect(ledgerIngestTriggered()).toBe(true)
    expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1)
  })

  it('结果通过回调上报', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(result())
    const done = vi.fn()
    ledgerIngestOnce(done)
    await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1))
    expect(done.mock.calls[0][0].sources).toHaveLength(2)
  })
})

describe('逐源判定', () => {
  it('ledgerSourceDelivered：可用且非让路才算"拿到了数据"', () => {
    expect(ledgerSourceDelivered(source())).toBe(true)
    expect(ledgerSourceDelivered(source({ skipped: true }))).toBe(false)
    expect(ledgerSourceDelivered(source({ sourceAvailable: false }))).toBe(false)
    expect(ledgerSourceDelivered(source({ ok: false }))).toBe(false)
  })

  it('ledgerSourceLabel：定位失败时退回 sourceName，再退回"未知源"', () => {
    expect(ledgerSourceLabel(source({ label: 'X' }))).toBe('X')
    expect(ledgerSourceLabel(source({ label: '', sourceName: 'codex_sessions' }))).toBe('codex_sessions')
    expect(ledgerSourceLabel(source({ label: '', sourceName: '' }))).toBe('未知源')
  })

  it('describeLedgerSource：不可用时把 reason 原样带出', () => {
    const text = describeLedgerSource(
      source({ sourceName: 'codex_sessions', sourceAvailable: false, reason: '会话库不存在' }),
    )
    expect(text).toContain('会话库不存在')
    expect(text).not.toContain('扫描')
  })

  it('describeLedgerSource：让路不算失败', () => {
    expect(describeLedgerSource(source({ skipped: true }))).toContain('已有摄取在执行')
  })

  it('describeLedgerSource：源库重建 → 提示世代', () => {
    const text = describeLedgerSource(source({ sourceResetDetected: true, sourceGeneration: 3 }))
    expect(text).toContain('世代 3')
  })
})

describe('describeLedgerIngest · 人话摘要', () => {
  it('未执行（null）', () => {
    expect(describeLedgerIngest(null)).toContain('未执行')
  })

  it('没有可用数据源时如实说明', () => {
    expect(describeLedgerIngest(result({ sources: [] }))).toContain('没有可用的数据源')
  })

  it('多源 → 逐源分行，两源行数都要出现（不许合并成一个数字）', () => {
    const text = describeLedgerIngest(result())
    expect(text).toContain('181823')
    expect(text).toContain('234990')
    // 两个源名都要出现，才能看出"哪个源没进来"
    expect(text).toContain('codex_local_access_logs.sqlite')
    expect(text).toContain('codex_session_usage.sqlite')
  })

  it('某一源不可用 → 另一源仍照常上报（不被拖成一句"未执行"）', () => {
    const text = describeLedgerIngest(
      result({
        sources: [
          source(),
          source({ sourceName: 'codex_sessions', sourceAvailable: false, reason: '会话库不存在' }),
        ],
      }),
    )
    expect(text).toContain('181823')
    expect(text).toContain('会话库不存在')
  })
})

describe('ledgerAllUnavailableReason · 全部不可用才汇总', () => {
  it('至少一个源可用 → null', () => {
    expect(
      ledgerAllUnavailableReason(
        result({
          sources: [source(), source({ sourceName: 'codex_sessions', sourceAvailable: false, reason: 'x' })],
        }),
      ),
    ).toBeNull()
  })

  it('全部不可用 → 拼出所有原因', () => {
    const reason = ledgerAllUnavailableReason(
      result({
        sources: [
          source({ sourceAvailable: false, reason: '日志库不存在' }),
          source({ sourceName: 'codex_sessions', sourceAvailable: false, reason: '会话库不存在' }),
        ],
      }),
    )
    expect(reason).toContain('日志库不存在')
    expect(reason).toContain('会话库不存在')
  })

  it('null / 空源列表 → null（不编造原因）', () => {
    expect(ledgerAllUnavailableReason(null)).toBeNull()
    expect(ledgerAllUnavailableReason(result({ sources: [] }))).toBeNull()
  })
})
