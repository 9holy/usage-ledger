/**
 * cockpitClient 测试 — 读本地 JSON + 类型解析 + 错误降级
 *
 * 覆盖:
 * - 桌面端:invoke('read_cockpit_file') 返 JSON 字符串 → 类型化解析
 * - 非桌面端:降级返 null(不调 invoke)
 * - 文件不存在:invoke 抛错 → 静默返 null
 * - 多函数并行(getCockpitConnectionState 汇总)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// invoke mock:可控返值/抛错
const invokeMock = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

// isDesktopRuntime mock:默认桌面端
const desktopFlag = { value: true }
vi.mock('@/api/url', () => ({
  isDesktopRuntime: () => desktopFlag.value,
}))
vi.mock('@/stores/connection', () => ({
  errMsg: (_e: unknown, fallback: string) => fallback,
}))

describe('cockpitClient', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    desktopFlag.value = true
    vi.resetModules()
  })

  it('桌面端读取 stats 并解析类型', async () => {
    invokeMock.mockResolvedValueOnce(
      JSON.stringify({
        since: 1785293907821,
        updatedAt: 1786989169943,
        totals: {
          requestCount: 98869, successCount: 83854, failureCount: 15015,
          clientCanceledCount: 1595, totalLatencyMs: 1156822786,
          textRequestCount: 98868, imageRequestCount: 1,
          imageGenerationRequestCount: 1, imageEditRequestCount: 0,
          imageGenerationCapabilityFailureCount: 0,
          inputTokens: 12353027224, outputTokens: 29681465,
          totalTokens: 12382708689, cachedTokens: 11455035710,
          reasoningTokens: 11193961, estimatedCostUsd: 11904.59,
        },
        accounts: [],
      }),
    )
    const { getCockpitStats } = await import('@/api/cockpit')
    const stats = await getCockpitStats()
    expect(stats).not.toBeNull()
    expect(stats!.totals.estimatedCostUsd).toBe(11904.59)
    expect(stats!.totals.totalTokens).toBe(12382708689)
    expect(invokeMock).toHaveBeenCalledWith('read_cockpit_file', { name: 'codex_local_access_stats.json' })
  })

  it('非桌面端降级返 null 且不调 invoke', async () => {
    desktopFlag.value = false
    const { getCockpitStats } = await import('@/api/cockpit')
    const stats = await getCockpitStats()
    expect(stats).toBeNull()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('invoke 抛错(文件不存在)时静默返 null', async () => {
    invokeMock.mockRejectedValueOnce(new Error('cockpit 数据文件不存在'))
    const { getCockpitStats } = await import('@/api/cockpit')
    const stats = await getCockpitStats()
    expect(stats).toBeNull()
  })

  it('getCockpitCodexAccounts 解析 accounts 数组', async () => {
    invokeMock.mockResolvedValueOnce(
      JSON.stringify({
        accounts: [
          { id: 'codex_abc', email: 'a@b.com', plan_type: 'plus', subscription_active_until: '2026-09-01T00:00:00+00:00' },
        ],
      }),
    )
    const { getCockpitCodexAccounts } = await import('@/api/cockpit')
    const accounts = await getCockpitCodexAccounts()
    expect(accounts).toHaveLength(1)
    expect(accounts[0].plan_type).toBe('plus')
  })

  it('getCockpitCodexAccounts 文件缺失返空数组(非 null)', async () => {
    invokeMock.mockRejectedValueOnce(new Error('不存在'))
    const { getCockpitCodexAccounts } = await import('@/api/cockpit')
    const accounts = await getCockpitCodexAccounts()
    expect(accounts).toEqual([])
  })

  it('isCockpitRunning 返布尔', async () => {
    invokeMock.mockResolvedValueOnce(true)
    const { isCockpitRunning } = await import('@/api/cockpit')
    expect(await isCockpitRunning()).toBe(true)
  })

  it('isCockpitRunning 非桌面端返 false', async () => {
    desktopFlag.value = false
    const { isCockpitRunning } = await import('@/api/cockpit')
    expect(await isCockpitRunning()).toBe(false)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('getCockpitConnectionState 汇总 available/running', async () => {
    // server.json + stats 成功 + running true
    invokeMock
      .mockResolvedValueOnce(JSON.stringify({ ws_port: 19528, version: '1.3.21', pid: 123 }))
      .mockResolvedValueOnce(JSON.stringify({ totals: { estimatedCostUsd: 1 }, accounts: [] }))
      .mockResolvedValueOnce(true)
    const { getCockpitConnectionState } = await import('@/api/cockpit')
    const state = await getCockpitConnectionState()
    expect(state.available).toBe(true)
    expect(state.running).toBe(true)
    expect(state.reason).toBeUndefined()
  })

  it('getCockpitConnectionState 未安装时 available=false', async () => {
    invokeMock
      .mockRejectedValueOnce(new Error('不存在')) // server.json
      .mockRejectedValueOnce(new Error('不存在')) // stats
      .mockResolvedValueOnce(false) // running
    const { getCockpitConnectionState } = await import('@/api/cockpit')
    const state = await getCockpitConnectionState()
    expect(state.available).toBe(false)
    expect(state.running).toBe(false)
    expect(state.reason).toBeTruthy()
  })
})
