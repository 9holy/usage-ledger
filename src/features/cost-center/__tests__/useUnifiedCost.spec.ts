import './costDataI18n'
/**
 * useUnifiedCost 端到端单测 — 汇总卡片金额 == Σ 逐账号行金额
 *
 * 这是架构设计 【F】7.2 标记的**真实缺口**回归锁:
 *   汇总卡片(`cockpitCost`)此前是 `stats.totals.estimatedCostUsd × 倍率`,
 *   逐账号行(`cockpitAccountRows[].costUsd`)却是**裸** `a.usage.estimatedCostUsd`(漏乘倍率),
 *   同一页面两个口径对不上 —— 用户最在意的那种"说不清"的错误。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ref } from 'vue'

// 局部 mock:本文件只关心桌面端判定。**必须**保留真实导出 ——
// useUnifiedCost 现在经 cockpitAdapter → useCostCenterData → @/api/admin/dashboard
// 间接加载 @/api/client,@/api/client 会在模块初始化期调用 getAPIBaseURL();
// 只 mock 一个 isDesktopRuntime 会让整个套件在 collect 阶段就炸(不是断言失败,是收集失败)。
vi.mock('@/api/url', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/url')>()),
  isDesktopRuntime: () => true,
}))
// 可变对象:各用例切换"当前连接的是哪个源"(null = 桌面本机 cockpit)。
// 工厂只返回闭包,不在模块初始化期解引用,故无需 vi.hoisted。
const activeConnection: { active: { type: string; id?: string } | null; connections: Array<{ id: string; type: string; lastUsed: number; baseUrl?: string }> } = { active: { type: 'sub2api' }, connections: [] }
vi.mock('@/stores/connection', () => ({
  useConnectionStore: () => activeConnection,
  errMsg: (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback),
}))
vi.mock('@/api/cockpit', () => ({
  getCockpitStats: vi.fn(),
  getCockpitCodexAccounts: vi.fn(),
  getCockpitConnectionState: vi.fn(),
  getCockpitRequestLogSummary: vi.fn(),
  getCockpitLocalAccess: vi.fn(),
}))
vi.mock('@/api/cliproxy/cpaData', async (original) => ({
  ...await original<typeof import('@/api/cliproxy/cpaData')>(),
  getCliproxyUsageEvents: vi.fn(),
  getCliproxyModelPrices: vi.fn(),
  getCliproxyUsageSnapshot: vi.fn(),
}))
vi.mock('../unifiedSourceReader', async (original) => ({ ...await original<typeof import('../unifiedSourceReader')>(), readSub2apiWindow: vi.fn() }))

import { getCockpitStats, getCockpitCodexAccounts, getCockpitConnectionState, getCockpitRequestLogSummary, getCockpitLocalAccess } from '@/api/cockpit'
import { getCliproxyUsageEvents, getCliproxyModelPrices, getCliproxyUsageSnapshot } from '@/api/cliproxy/cpaData'
import { readSub2apiWindow, windowCostReading } from '../unifiedSourceReader'
import { usageWindowBounds } from '../usageWindow'
import { useUnifiedCost, unmeasuredSourcesNote, lowerBoundSourcesNote } from '../useUnifiedCost'
import type { CostBasisKind } from '../costBasis'

const STORAGE_KEY = '2api-console.unified-sources'

function usageStats(estimatedCostUsd: number) {
  return {
    requestCount: 10,
    successCount: 10,
    failureCount: 0,
    clientCanceledCount: 0,
    upstreamResponseFailedCount: 0,
    streamIncompleteCount: 0,
    totalLatencyMs: 100,
    textRequestCount: 10,
    imageRequestCount: 0,
    imageGenerationRequestCount: 0,
    imageEditRequestCount: 0,
    imageGenerationCapabilityFailureCount: 0,
    inputTokens: 1000,
    outputTokens: 500,
    totalTokens: 1500,
    cachedTokens: 100,
    reasoningTokens: 0,
    estimatedCostUsd,
  }
}

/** 两个账号,估算成本分别 12 / 8 → totals 20(与逐账号之和一致,便于断言)。 */
function stats() {
  return {
    since: 1_756_800_000_000,
    updatedAt: 1_756_800_000_000,
    totals: usageStats(20),
    accounts: [
      { accountId: 'acct-a', email: 'a@gmail.com', usage: usageStats(12) },
      { accountId: 'acct-b', email: 'b@gmail.com', usage: usageStats(8) },
    ],
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-16T12:00:00Z'))
  activeConnection.connections = [{ id: 'saved-sub', type: 'sub2api', lastUsed: 1 }]
  activeConnection.active = { type: 'sub2api' }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(['sub2api', 'cliproxy', 'cockpit']))
  vi.mocked(getCockpitConnectionState).mockResolvedValue({ available: true, running: true, reason: null } as never)
  vi.mocked(getCockpitStats).mockResolvedValue(stats() as never)
  vi.mocked(getCockpitCodexAccounts).mockResolvedValue([] as never)
  // cliproxy 默认给空数据:连 cliproxy 的用例才走到 loadCliproxy,空数据 → 诚实返 empty
  vi.mocked(getCliproxyUsageEvents).mockResolvedValue([] as never)
  vi.mocked(getCliproxyModelPrices).mockResolvedValue({} as never)
  vi.mocked(getCockpitLocalAccess).mockResolvedValue(null)
  vi.mocked(getCockpitRequestLogSummary).mockResolvedValue({ available: true, rowCount: 0, groups: [], windowEndMs: null } as never)
  vi.mocked(getCliproxyUsageSnapshot).mockResolvedValue({ available: true, events: [], readStartMs: Date.now() - 30 * 86400000, readEndMs: Date.now() })
  vi.mocked(readSub2apiWindow).mockImplementation(async (connection, window) => ({ ...windowCostReading('sub2api', `sub2api:${connection.id}`, window), costUsd: 3, records: 1, state: 'measured', coverageBasis: 'stored_records' }))
})
afterEach(() => vi.useRealTimers())

describe('same-window independent source summaries', () => {
  function paidFixtures() {
    vi.mocked(getCockpitLocalAccess).mockResolvedValue({ modelPricings: [{ modelId: 'fixture-model', inputUsdPerMillion: 2, outputUsdPerMillion: 4, cachedInputUsdPerMillion: 0 }] } as never)
    vi.mocked(getCockpitRequestLogSummary).mockResolvedValue({ available: true, rowCount: 1, windowEndMs: Date.now() - 10000, groups: [{ model: 'fixture-model', stdNormalInput: 1000000, stdCached: 0, stdOutput: 0, longNormalInput: 0, longCached: 0, longOutput: 0, estimatedCostUsd: 0 }] } as never)
    vi.mocked(getCliproxyUsageSnapshot).mockResolvedValue({ available: true, events: [{ model: 'fixture-model', provider: 'openai-compatibility', executor_type: 'OpenAICompatExecutor', response_service_tier: 'standard', requested_at: Date.now() - 10000, input_tokens: 1000000, output_tokens: 0, reasoning_tokens: 0, cached_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0, total_tokens: 1000000 }] as never, readStartMs: Date.now() - 30 * 86400000, readEndMs: Date.now() })
    vi.mocked(getCliproxyModelPrices).mockResolvedValue({ 'fixture-model': { input_cost_per_token: 0.000002, output_cost_per_token: 0.000004 } })
  }

  it.each(['today', '1m', '5m', '30m', '1h', '6h', '24h', '7d', '30d'] as const)('%s: all three sources share exact bounds, instance identity, counts and window units', async (range) => {
    paidFixtures()
    activeConnection.active = { type: 'cliproxy', id: 'remote-management' }
    const unified = useUnifiedCost(ref({ actual: { account_cost_usd: 999, billed_usd: 9999 } }) as never, ref(0.7))
    await unified.loadUnified(range)
    const bounds = usageWindowBounds(range)
    const end = Math.min(Date.now(), bounds.end.getTime())
    expect(unified.sub2apiCost.value).toBe(3)
    expect(unified.cockpitCost.value).toBeCloseTo(1.4)
    expect(unified.cliproxyCost.value).toBeCloseTo(1.4)
    expect(unified.totalCostUsd.value).toBeCloseTo(5.8)
    expect(unified.totalCostUnitMixed.value).toBe(false)
    for (const item of unified.contributedSources.value) {
      expect(item).toMatchObject({ unit: 'window', startMs: bounds.start.getTime(), endMs: end })
      expect(unified.sourceStatuses.value[item.key].period).toEqual({ startMs: bounds.start.getTime(), endMs: end })
    }
    expect(unified.sourceReadings.value.cliproxy?.instanceId).toBe('cliproxy:local:cpa_usage_events')
    expect(unified.sourceReadings.value.cockpit?.tokens).toBe(1000000)
    expect(unified.sourceReadings.value.cliproxy?.tokens).toBe(1000000)
    expect(getCockpitRequestLogSummary).toHaveBeenCalledWith(1, bounds.start.getTime(), end - 1, false)
    expect(getCliproxyUsageSnapshot).toHaveBeenCalledWith({ start: bounds.start, end: new Date(end) })
    expect(unified.totalCostNote.value).toContain('未跨源去重')
  })

  it('keeps saved Sub2API and local CPA data when the main connection changes to Cockpit', async () => {
    paidFixtures()
    const unified = useUnifiedCost(ref(null), ref(0.7))
    await unified.loadUnified('1h')
    activeConnection.active = null
    expect(unified.sub2apiCost.value).toBe(3)
    expect(unified.cliproxyCost.value).toBeCloseTo(1.4)
    expect(readSub2apiWindow).toHaveBeenCalledWith(expect.objectContaining({ id: 'saved-sub' }), expect.anything(), { signal: expect.any(AbortSignal) })
  })

  it('reports confirmed empty queries as zero but missing local databases as unknown', async () => {
    const unified = useUnifiedCost(ref(null))
    await unified.loadUnified('1h')
    expect(unified.cockpitCost.value).toBe(0)
    expect(unified.cliproxyCost.value).toBe(0)
    expect(unified.sourceStatuses.value.cliproxy.state).toBe('empty')
    vi.mocked(getCliproxyUsageSnapshot).mockResolvedValue({ available: false, events: [], readStartMs: null, readEndMs: null })
    vi.mocked(getCockpitRequestLogSummary).mockResolvedValue(null)
    await unified.loadUnified('1h')
    expect(unified.cockpitCost.value).toBeNull()
    expect(unified.cliproxyCost.value).toBeNull()
    expect(unified.unmeasuredSources.value).toEqual(expect.arrayContaining(['cliproxy', 'cockpit']))
  })

  it('preserves unknown-price and partial-price costs without using cumulative fallback values', async () => {
    paidFixtures()
    vi.mocked(getCliproxyModelPrices).mockResolvedValue({ 'fixture-model': {} })
    vi.mocked(getCockpitLocalAccess).mockResolvedValue(null)
    const unified = useUnifiedCost(ref(null), ref(0.7), ref(999), ref({}), ref(9999))
    await unified.loadUnified('1h')
    expect(unified.cockpitCost.value).toBeNull()
    expect(unified.cliproxyCost.value).toBeNull()
    expect(unified.cliproxyEstimate.value?.byModel[0].costUnknown).toBe(true)
    expect(unified.totalCostUsd.value).toBe(3)
    expect(unified.unmeasuredSources.value).toEqual(expect.arrayContaining(['cockpit', 'cliproxy']))
  })

  it('does not publish an obsolete window response after a newer load completes', async () => {
    let finish!: (value: Awaited<ReturnType<typeof readSub2apiWindow>>) => void
    vi.mocked(readSub2apiWindow).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const unified = useUnifiedCost(ref(null))
    const previous = unified.loadUnified('1h')
    await unified.loadUnified('5m')
    const latest = unified.sourceReadings.value.sub2api
    finish({ ...windowCostReading('sub2api', 'sub2api:old', usageWindowBounds('1h')), costUsd: 99 })
    await previous
    expect(unified.sourceReadings.value.sub2api).toEqual(latest)
    expect(unified.loading.value).toBe(false)
    expect(vi.mocked(readSub2apiWindow).mock.calls[0][2]?.signal?.aborted).toBe(true)
  })

  it('keeps the priced CPA subtotal as a lower bound when another model is unpriced', async () => {
    paidFixtures()
    const snapshot = await getCliproxyUsageSnapshot()
    vi.mocked(getCliproxyUsageSnapshot).mockResolvedValue({ ...snapshot, events: [...snapshot.events, { ...snapshot.events[0], model: 'unpriced-fixture' }] })
    const unified = useUnifiedCost(ref(null), ref(0.7))
    await unified.loadUnified('1h')
    expect(unified.cliproxyCost.value).toBeCloseTo(1.4)
    expect(unified.sourceStatuses.value.cliproxy.state).toBe('partial')
    expect(unified.lowerBoundSources.value).toContain('cliproxy')
    expect(unified.totalCostNote.value).toContain('下界')
  })

  it('refreshes CPA instead of reusing an injected snapshot that cannot cover the new end time', async () => {
    const unified = useUnifiedCost(ref(null))
    unified.selectedSources.value = new Set(['cliproxy'])
    unified.setCliproxyData([], {}, { available: true, readStartMs: Date.now() - 86400000, readEndMs: Date.now() - 60000 })
    await unified.loadUnified('1h')
    expect(getCliproxyUsageSnapshot).toHaveBeenCalledTimes(1)
    expect(unified.cliproxyCost.value).toBe(0)
  })

  it('does not read unselected sources and reuses explicit CPA read metadata without a second database query', async () => {
    const unified = useUnifiedCost(ref(null))
    unified.selectedSources.value = new Set(['cliproxy'])
    unified.setCliproxyData([], {}, { available: true, readStartMs: Date.now() - 86400000, readEndMs: Date.now() })
    await unified.loadUnified('1h')
    expect(getCliproxyUsageSnapshot).not.toHaveBeenCalled()
    expect(getCockpitRequestLogSummary).not.toHaveBeenCalled()
    expect(readSub2apiWindow).not.toHaveBeenCalled()
    expect(unified.totalCostUsd.value).toBe(0)
  })

  it('reuses a proven Sub2API period without scanning twice, but rejects the same id after its target changes', async () => {
    activeConnection.connections = [{ id: 'saved-sub', type: 'sub2api', lastUsed: 1, baseUrl: 'https://own.example.test' }]
    const unified = useUnifiedCost(ref(null))
    unified.selectedSources.value = new Set(['sub2api'])
    const reading = { ...windowCostReading('sub2api', 'sub2api:saved-sub', usageWindowBounds('1h')), source: 'sub2api' as const, costUsd: 5, records: 2, tokens: 10, state: 'partial' as const, coverageBasis: 'bounded_sample' as const }
    unified.setSub2apiData({ id: 'saved-sub', baseUrl: 'https://own.example.test' }, reading)
    await unified.loadUnified('1h')
    expect(readSub2apiWindow).not.toHaveBeenCalled()
    expect(unified.sub2apiCost.value).toBe(5)
    activeConnection.connections[0].baseUrl = 'https://other.example.test'
    await unified.loadUnified('1h')
    expect(readSub2apiWindow).toHaveBeenCalledTimes(1)
    expect(unified.sub2apiCost.value).toBe(3)
  })
})

describe('useUnifiedCost · 逐账号:下界与哨兵 0 必须与实测金额区分开', () => {
  function makeWithAccountBasis(
    totalUsd: number | null,
    accountCost: Record<string, number> | null,
    accountBasis: Record<string, CostBasisKind> | null,
  ) {
    return useUnifiedCost(
      ref(null) as never,
      ref(0.7),
      ref<number | null>(null),
      ref<Record<string, number> | null>(accountCost),
      ref<number | null>(totalUsd),
      ref<CostBasisKind | null>(null),
      ref<Record<string, CostBasisKind> | null>(accountBasis),
    )
  }

  it('★ 部分模型无单价 ⇒ 金额照给(真实下界),但必须标 costLowerBound', async () => {
    activeConnection.active = null
    const unified = makeWithAccountBasis(10, { 'acct-a': 10 }, { 'acct-a': 'no_price_no_estimate' })
    await unified.loadUnified('1h')

    const row = unified.cockpitAccountRows.value.find((r) => r.accountId === 'acct-a')!
    expect(row.costUsd).toBeCloseTo(10, 8)
    expect(row.costBasis).toBe('priced')
    expect(row.costLowerBound).toBe(true)
  })

  it('成对反例:全组有单价 ⇒ costLowerBound 必须是 false(守卫没有把实测也标成下界)', async () => {
    activeConnection.active = null
    const unified = makeWithAccountBasis(10, { 'acct-a': 10 }, { 'acct-a': 'priced' })
    await unified.loadUnified('1h')

    const row = unified.cockpitAccountRows.value.find((r) => r.accountId === 'acct-a')!
    expect(row.costUsd).toBeCloseTo(10, 8)
    expect(row.costBasis).toBe('priced')
    expect(row.costLowerBound).toBe(false)
  })

  it('★ 全组无单价且有用量 ⇒ 哨兵 0 必须走「成本未知」,不得渲染成 $0.00', async () => {
    activeConnection.active = null
    // 该账号的源侧估算也是 0(源自己也没匹配到单价)⇒ 没有任何可用来源
    vi.mocked(getCockpitStats).mockResolvedValue({
      since: 1, updatedAt: 1,
      totals: usageStats(0),
      accounts: [{ accountId: 'acct-a', email: 'a@x', usage: usageStats(0) }],
    } as never)
    const unified = makeWithAccountBasis(0, { 'acct-a': 0 }, { 'acct-a': 'no_price_no_estimate' })
    await unified.loadUnified('1h')

    const row = unified.cockpitAccountRows.value.find((r) => r.accountId === 'acct-a')!
    expect(row.usage.totalTokens).toBeGreaterThan(0)
    expect(row.costBasis).toBe('no_price_no_estimate')
    expect(row.costIsOurs).toBe(false)
    expect(row.costLowerBound).toBe(false)
  })

  it('成对反例:全组无单价但源侧有估算 ⇒ 回退估算并标注,不是「成本未知」', async () => {
    activeConnection.active = null
    // 默认 stats 里 acct-a 的 estimatedCostUsd = 12 ⇒ 有源侧估算可用
    const unified = makeWithAccountBasis(0, { 'acct-a': 0 }, { 'acct-a': 'no_price_no_estimate' })
    await unified.loadUnified('1h')

    const row = unified.cockpitAccountRows.value.find((r) => r.accountId === 'acct-a')!
    expect(row.costBasis).toBe('source_estimate')
    expect(row.costUsd).toBeCloseTo(12 * 0.7, 8)
    expect(row.costIsOurs).toBe(false)
  })

  it('未注入逐账号依据(旧调用点)⇒ 维持原行为(不因缺信号而谎报下界)', async () => {
    activeConnection.active = null
    const unified = makeWithAccountBasis(10, { 'acct-a': 10 }, null)
    await unified.loadUnified('1h')

    const row = unified.cockpitAccountRows.value.find((r) => r.accountId === 'acct-a')!
    expect(row.costBasis).toBe('priced')
    expect(row.costLowerBound).toBe(false)
  })
})

describe('lowerBoundSourcesNote · 纯函数文案', () => {
  it('无下界端 ⇒ 空串', () => {
    expect(lowerBoundSourcesNote([])).toBe('')
  })
  it('有下界端 ⇒ 点名并说清"总额是下界,不是实测总额"', () => {
    const note = lowerBoundSourcesNote(['cockpit'])
    expect(note).toContain('cockpit')
    expect(note).toContain('下界')
  })
})

/**
 * ★ 总成本不能静默丢掉算不出来的端。
 * `contributedSources` 只收 `cost != null` 的分项 ⇒ 成本拿不到的端**没有**进入 totalCostUsd;
 * 不标注就等于宣称"选中端总成本 = 全部选中端之和"。
 */

describe('unmeasuredSourcesNote · 纯函数文案', () => {
  it('有总成本 + 有未计入端 ⇒ 点名未计入的端', () => {
    const note = unmeasuredSourcesNote(10, ['cockpit'])
    expect(note).toContain('未计入 1 端')
    expect(note).toContain('cockpit')
    expect(note).toContain('总额只含其余端')
  })

  it('有总成本 + 无未计入端 ⇒ 空串', () => {
    expect(unmeasuredSourcesNote(10, [])).toBe('')
  })

  it('无总成本 + 有未计入端 ⇒ 说清是"算不出来",不是"没有数据"', () => {
    const note = unmeasuredSourcesNote(null, ['cockpit', 'cliproxy'])
    expect(note).toContain('都没有可用成本')
    expect(note).toContain('cockpit、cliproxy')
    expect(note).toContain('算不出来')
  })

  it('无总成本 + 无未计入端 ⇒ 仍给出解释', () => {
    expect(unmeasuredSourcesNote(null, [])).toBe('选中的端当前都没有可用成本')
  })
})

/**
 * ★ 视图侧接线(2026-09-23)。
 *
 * 「最差计价依据」这个信号**只有在生产端才拿得到** —— 逐组 `cockpitSplitCostUsd` 的 basis
 * 是 CostCenterView 聚合循环里才知道的,composable 拿到的只是最后那个汇总值。
 * 而上面的用例全部是**直接调 composable 传参** ⇒ 无论视图把哪个 basis 传进来,它们都绿
 * (「同值双轨」的教训:参数正确 ≠ 接线正确)。
 * ⇒ 接线必须用**源码扫描**钉(文本扫描钉不住语义,但"接线"正是它该钉的)。
 */
describe('useUnifiedCost · 视图接线:最差计价依据必须真的被算出来并透传', () => {
  const view = readFileSync(resolve(process.cwd(), 'src/views/admin/CostCenterView.vue'), 'utf8')

  it('扫描面非空(否定断言在空串上恒真,先钉住这一点)', () => {
    expect(view, '未找到 CostCenterView.vue 内容').not.toBe('')
    expect(view).toContain('useUnifiedCost(')
  })

  it('聚合循环必须逐组取"更差一侧",不是"最后一组说了算"', () => {
    // 反例:`worstBasis = costBasis.kind`(只留最后一组)会让"最后一组有单价、前面组没单价"
    // 这种真实分布被判成 priced ⇒ 状态回到 measured ⇒ 下界又冒充实测总额。
    expect(view).toContain('worstCostBasisKind(worstBasis, costBasis.kind)')
    expect(view).not.toContain('worstBasis = costBasis.kind')
  })

  it('★ 算出来的依据必须真的写进 ref(不能"算了但丢掉")', () => {
    // 独立复核抓到:此前只断言 `cockpitCumulativeCostBasis.value = null`(复位那行),
    // 于是把**赋值行**改成 `= null`(第①项修复彻底失效)全量测试仍绿 —— 那条断言名不副实。
    // 修法:正向钉住赋值形态本身。
    expect(view).toContain('cockpitCumulativeCostBasis.value = worstBasis ?? null')
    // 逐账号那一份同样要真的写进去(它是账号表的唯一信号来源)
    expect(view).toContain('cockpitCumulativeAccountBasis.value = byAccountBasis')
    expect(view).toContain('worseBasisOf(byAccountBasis[g.accountId], costBasis.kind)')
  })

  it('必须作为第 6 / 第 7 个实参透传(不是传了别的 ref)', () => {
    expect(view).toContain('computed(() => cockpitCumulativeCostBasis.value),')
    expect(view).toContain('computed(() => cockpitCumulativeAccountBasis.value),')
  })

  it('不可用时必须复位成 null(否则残留值会跟着切源走,D-4 同型)', () => {
    expect(view).toContain('cockpitCumulativeCostBasis.value = null')
    expect(view).toContain('cockpitCumulativeAccountBasis.value = null')
  })

  it('★ 总成本格必须渲染**合并后**的提醒(未计入的 + 下界的),不能退回只看未计入', () => {
    // 独立复核抓到:把模板改回 `unified.unmeasuredSourcesNote.value` 全量测试仍绿
    // ⇒ 「总额是下界」这句提示会从大数下方彻底消失。
    expect(view).toContain('unified.totalCostNote.value')
    expect(view).not.toContain('unified.unmeasuredSourcesNote.value')
  })

  it('★ 下界总额不得用实测强调色(cost-lime)', () => {
    expect(view).toContain("unified.lowerBoundSources.value.length ? 'cost-estimated' : 'cost-lime'")
  })

  it('★ 账号表的金额必须渲染下界小字(第二个消费点)', () => {
    expect(view).toContain('a.costLowerBound')
  })
})
