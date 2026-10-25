import './costDataI18n'
/**
 * 2026-09-17:cliproxy(CPA `usage_events`)逐账号**观察窗口**统计接入的回归测试。
 *
 * 背景:`loadFromCliproxy` 此前把 `rangeAccountStats` 写成空、源状态如实登记
 * 「CLIProxyAPI 未接入逐账号窗口用量」—— 登记是诚实的,但用户选「最近 1 小时」时
 * 表格里显示的仍是**今日**的数(视图回退 todayStats),标签与数据不符。
 *
 * 修法:events 自带毫秒 `requested_at`(src-tauri/src/main.rs:689),
 * `cliproxyEventsToTodayStats` 本就接受窗口边界 ⇒ 非 today 窗口直接按
 * `usageWindowBounds(range)` 过滤,与 sub2api 的 `today-stats/batch`(start_time = 窗口起点)同语义。
 *
 * 本文件钉住四件事:
 *   ① 窗口不同 ⇒ 逐账号数字不同(1h 不得计入 3 小时前的请求);
 *   ② 窗口外无记录的账号 ⇒ 无数据(null),不是伪造的 0 请求 / $0;
 *   ③ 窗口源权威时视图不得回退自然日(rangeWindowAuthoritative = true),today 例外;
 *   ④ todayStats(自然日)不受影响,仍供「今日」面板使用。
 *
 * 2026-09-23 追加:模型区**独立窗口**(modelCostRange)那一轨的回归测试(见文件末尾的
 * 第二个 describe)。起因:独立复核用变异把视图调用点的 `modelCostRange.value` 换成
 * `range.value`,全量 2550 条**全绿** —— 当时没有任何用例钉住「模型表/路由表读的是哪条轨」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { authIndexToAccountId } from '../cliproxyAdapter'
import { useCostCenterData } from '../useCostCenterData'
import { setActiveConnection } from '@/api/url'
import { UNATTRIBUTED_USAGE_ACCOUNT_ID } from '../model'
import type { CliproxyUsageEvent, LitellmPricing } from '@/api/cliproxy/cpaData'

const PRICES: Record<string, LitellmPricing> = {
  'gpt-5.6-terra': { input_cost_per_token: 2e-6, output_cost_per_token: 1.2e-5 },
}

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

function makeEvent(authIndex: string, requestedAtMs: number, totalTokens: number): CliproxyUsageEvent {
  return {
    id: requestedAtMs,
    requested_at: requestedAtMs,
    provider: 'openai',
    executor_type: 'codex',
    model: 'gpt-5.6-terra',
    alias: 'gpt-5.6-terra',
    auth_index: authIndex,
    auth_type: 'api_key',
    source: 'test',
    reasoning_effort: 'medium',
    service_tier: 'auto',
    latency_ms: 100,
    ttft_ms: 50,
    failed: false,
    status_code: 200,
    input_tokens: totalTokens,
    output_tokens: 0,
    reasoning_tokens: 0,
    cached_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_tokens: totalTokens,
    primary_used_percent: null,
    primary_reset_at: null,
    primary_used_tokens: null,
    primary_remaining_tokens: null,
    primary_limit_tokens: null,
    secondary_used_percent: null,
    secondary_reset_at: null,
    secondary_used_tokens: null,
    secondary_remaining_tokens: null,
    secondary_limit_tokens: null,
  }
}

/** 账号 id 由 auth_index 经 FNV 哈希派生(不是数字解析),用例必须用同一函数推导 key。 */
const idOf = (authIndex: string): string => String(authIndexToAccountId(authIndex))

/** 从 store 的账号清单里取真实账号对象(id 与 events 聚合一致),而不是手搓一个假对象。 */
function accountOf(data: ReturnType<typeof useCostCenterData>, authIndex: string) {
  const account = data.accounts.value.find((item) => String(item.id) === idOf(authIndex))
  expect(account, `账号 ${authIndex} 未出现在 accounts 里`).toBeTruthy()
  return account!
}

describe('cliproxy 逐账号观察窗口统计接入', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // 21:00 起算:1h 窗口(20:00~21:00)与自然日(00:00~24:00)必然不同,
    // 3 小时前的 events(18:00)在自然日内、在 1h 窗口外。
    vi.setSystemTime(new Date(2026, 8, 17, 21, 0, 0))
  })

  afterEach(() => {
    vi.useRealTimers()
    setActiveConnection(null)
  })

  it('retains a same-target management snapshot on failure without borrowing it for another target', () => {
    setActiveConnection({ type: 'cliproxy', baseUrl: 'http://127.0.0.1:8317', id: 'local', name: 'local', apiKey: '', lastUsed: 0 })
    const data = useCostCenterData()
    const stamp = new Date()
    const managed = { id: 'file-A', auth_index: 'managed-A', name: 'Managed A', provider: 'codex', account_type: 'oauth', status: 'active', disabled: false } as never
    const events = [makeEvent('usage-A', Date.now() - MINUTE, 1000)]
    data.loadFromCliproxy([managed], {}, null, events, PRICES, {}, '1h', '1h', 7, stamp, true)
    data.loadFromCliproxy([], null, null, events, PRICES, {}, '1h', '1h', 7, new Date(Date.now() + MINUTE), true, 'management offline')
    expect(data.cliproxyAuthFiles.value).toEqual([managed])
    expect(data.accounts.value.some(account => account.name === 'Managed A')).toBe(true)
    expect(data.sourceStates.value.accounts.status).toBe('stale')
    expect(data.sourceStates.value.accounts.updatedAt).toBe(stamp.toISOString())
    expect(data.rangeAccountStats.value[idOf('usage-A')].requests).toBe(1)
    setActiveConnection({ type: 'cliproxy', baseUrl: 'https://another.example', id: 'other', name: 'other', apiKey: '', lastUsed: 0 })
    data.loadFromCliproxy([], null, null, events, PRICES, {}, '1h', '1h', 7, new Date(), true, 'another target offline')
    expect(data.cliproxyAuthFiles.value).toEqual([])
    expect(data.cliproxyManagementSnapshotAt.value).toBeNull()
    expect(data.sourceStates.value.accounts.status).toBe('unavailable')
    expect(data.accounts.value.some(account => account.name === 'Managed A')).toBe(false)
    data.loadFromCliproxy([], {}, null, [], PRICES, {}, '1h', '1h', 7, new Date(), true)
    expect(data.sourceStates.value.accounts.status).toBe('empty')
  })

  it('keeps fixed local CPA events separate from a remote management account with the same auth_index', () => {
    setActiveConnection({ type: 'cliproxy', baseUrl: 'https://remote.example', id: 'remote', name: 'remote', apiKey: '', lastUsed: 0 })
    const data = useCostCenterData()
    const remote = { id: 'remote-auth', auth_index: 'alpha', name: 'REMOTE ONLY', email: 'remote@example.test', provider: 'codex', status: 'active', disabled: false } as never
    data.loadFromCliproxy([remote], {}, null, [makeEvent('alpha', Date.now() - MINUTE, 1000)], PRICES, {}, '1h', '1h', 7)
    expect(data.cliproxyLocalAccountLink.value).toBe(false)
    expect(data.cliproxyAuthFiles.value).toEqual([remote])
    expect(data.accounts.value.some((account) => account.name === 'REMOTE ONLY' || account.name === 'remote@example.test')).toBe(false)
    expect(data.accounts.value).toHaveLength(1)
    expect(data.accountEconomics.value!.projection.account_cost_usd_per_hour).toBeGreaterThan(0)
  })

  it('1h:只统计窗口内 events,窗口外无记录的账号显示无数据', () => {
    const now = Date.now()
    const inWindow = now - 10 * MINUTE
    const threeHoursAgo = now - 3 * HOUR
    const events = [
      makeEvent('alpha', inWindow, 100),
      makeEvent('alpha', inWindow, 50),
      makeEvent('alpha', threeHoursAgo, 9_000),
      makeEvent('beta', threeHoursAgo, 700),
    ]

    const data = useCostCenterData()
    data.loadFromCliproxy([], null, null, events, PRICES, {}, '1h', '1h', 7.2)

    expect(data.trendQueryWindow.value).toEqual({ start: new Date(now - HOUR), end: new Date(now) })
    expect(data.rangeAccountStatsWindow.value).toEqual(data.trendQueryWindow.value)
    expect(data.rangeAccountStatsScope.value).toEqual({ source: 'cliproxy', instanceId: 'local' })

    const alpha = data.rangeStats.value(accountOf(data, 'alpha'))
    expect(alpha?.requests).toBe(2)
    expect(alpha?.tokens).toBe(150)
    // 成本是有限正数(估算口径),不是 0 也不是 NaN
    expect(alpha?.cost).toBeGreaterThan(0)
    expect(Number.isFinite(alpha?.cost)).toBe(true)

    // beta 在 1h 窗口内没有记录 ⇒ 无数据;绝不能落成「0 请求 / $0」的假实测。
    expect(data.rangeStats.value(accountOf(data, 'beta'))).toBeNull()

    // 窗口源已被请求 ⇒ 视图不得回退自然日(否则 beta 会显示今日的 700 token)
    expect(data.rangeWindowAuthoritative.value).toBe(true)
    expect(data.sourceStates.value.rangeStats.status).toBe('measured')
    expect(data.sourceStates.value.rangeStats.reason).toContain('最近 1 小时')

    // todayStats(自然日)不受影响:3 小时前的 events 仍属今日
    expect(data.todayStats.value[idOf('alpha')]?.requests).toBe(3)
    expect(data.todayStats.value[idOf('beta')]?.requests).toBe(1)
  })

  it('窗口不同 ⇒ 数字不同:24h 计入 3 小时前的请求,1h 不计入', () => {
    const now = Date.now()
    const threeHoursAgo = now - 3 * HOUR
    const events = [makeEvent('gamma', threeHoursAgo, 700)]

    const hourly = useCostCenterData()
    hourly.loadFromCliproxy([], null, null, events, PRICES, {}, '1h', '1h', 7.2)
    expect(hourly.rangeStats.value(accountOf(hourly, 'gamma'))).toBeNull()

    const daily = useCostCenterData()
    daily.loadFromCliproxy([], null, null, events, PRICES, {}, '24h', '24h', 7.2)
    expect(daily.rangeStats.value(accountOf(daily, 'gamma'))?.requests).toBe(1)
    expect(daily.rangeStats.value(accountOf(daily, 'gamma'))?.tokens).toBe(700)
  })

  it('keeps one old batch anchor across midnight, minute, model, operations and economics windows after fetching finishes', async () => {
    const anchor = new Date(2026, 8, 17, 0, 0, 30)
    vi.setSystemTime(new Date(anchor.getTime() + 2 * MINUTE))
    const events = [
      makeEvent('alpha', anchor.getTime() - 45000, 100),
      makeEvent('alpha', anchor.getTime() - 10000, 200),
      makeEvent('alpha', anchor.getTime() + 1000, 400),
      makeEvent('alpha', anchor.getTime() - 3 * HOUR, 800),
    ]
    const data = useCostCenterData()
    data.loadFromCliproxy([], null, null, events, PRICES, {}, '1m', '24h', 7.2, anchor)
    expect(data.todayStats.value[idOf('alpha')].requests).toBe(1)
    expect(data.todayStats.value[idOf('alpha')].tokens).toBe(200)
    expect(data.rangeStats.value(accountOf(data, 'alpha'))).toMatchObject({ requests: 2, tokens: 300 })
    expect(data.models.value[0]).toMatchObject({ requests: 3, total_tokens: 1100 })
    expect(data.modelRoutes.value[0].requests).toBe(3)
    expect(data.trend.value.reduce((sum, point) => sum + point.requests, 0)).toBe(2)
    expect(data.opsOverview.value?.request_count_total).toBe(2)
    expect(data.trendQueryWindow.value).toEqual({ start: new Date(anchor.getTime() - MINUTE), end: anchor })
    expect(data.accountEconomics.value).toMatchObject({ sampled_at: anchor.toISOString(), local_derived: { window: { start: new Date(anchor.getTime() - MINUTE), end: anchor } } })
    await data.loadAccountEconomics('all', '1m')
    expect(data.accountEconomics.value?.sampled_at).toBe(anchor.toISOString())
    expect(data.lastUpdated.value!.getTime()).toBeGreaterThan(anchor.getTime())
  })

  it('today exposes the same exact natural-day account window without an implicit fallback', () => {
    const now = Date.now()
    const events = [makeEvent('delta', now - 3 * HOUR, 700)]

    const data = useCostCenterData()
    data.loadFromCliproxy([], null, null, events, PRICES, {}, 'today', 'today', 7.2)

    expect(data.trendQueryWindow.value?.end.getTime()).toBe(now)

    expect(data.rangeWindowAuthoritative.value).toBe(true)
    expect(data.rangeStats.value(accountOf(data, 'delta'))?.requests).toBe(1)
    expect(data.sourceStates.value.rangeStats.status).toBe('measured')
    expect(data.rangeAccountStatsWindow.value).toEqual(data.trendQueryWindow.value)
  })

  it('窗口内完全没有 events ⇒ 空状态 + 原因,不是 measured 的假 0', () => {
    const now = Date.now()
    const events = [makeEvent('epsilon', now - 5 * HOUR, 700)]

    const data = useCostCenterData()
    data.loadFromCliproxy([], null, null, events, PRICES, {}, '1m', '1m', 7.2)

    expect(data.rangeWindowAuthoritative.value).toBe(true)
    expect(data.sourceStates.value.rangeStats.status).toBe('empty')
    expect(data.sourceStates.value.rangeStats.reason).toContain('最近 1 分钟')
    expect(data.rangeStats.value(accountOf(data, 'epsilon'))).toBeNull()
  })

  it('clears account-window bounds and identity together with source data', () => {
    const data = useCostCenterData()
    data.loadFromCliproxy([], null, null, [makeEvent('history', Date.now() - MINUTE, 100)], PRICES, {}, '30d', '30d', 7.2)
    expect(data.rangeAccountStats.value[idOf('history')]?.requests).toBe(1)
    expect(data.rangeAccountStatsWindow.value).not.toBeNull()
    data.resetRangeWindowState()
    expect(data.rangeAccountStats.value).toEqual({})
    expect(data.rangeAccountStatsWindow.value).toBeNull()
    expect(data.rangeAccountStatsScope.value).toBeNull()
  })

  it('preserves missing-auth usage without creating a synthetic account or mixing a real unknown ID', () => {
    const data = useCostCenterData()
    data.loadFromCliproxy([], null, null, [makeEvent('', Date.now() - MINUTE, 100), makeEvent('unknown', Date.now() - MINUTE, 200)], PRICES, {}, '30d', '30d', 7.2)
    expect(data.rangeAccountStats.value[UNATTRIBUTED_USAGE_ACCOUNT_ID]?.requests).toBe(1)
    expect(data.rangeAccountStats.value[idOf('unknown')]?.tokens).toBe(200)
    expect(data.accounts.value.map(row => String(row.id))).toEqual([idOf('unknown')])
    expect(data.sourceStates.value.rangeStats.status).toBe('partial')
    expect(data.sourceStates.value.rangeStats.reason).toContain('1 条请求未归属账号')
    expect(data.rangeAccountStatsScope.value).toEqual({ source: 'cliproxy', instanceId: 'local' })
  })
})

/**
 * 2026-09-23:模型区**独立窗口**(modelCostRange)那一轨的回归测试。
 *
 * 缺陷(ed57f9b 修):cliproxy 的模型表/路由表此前不带窗口参数,取的是 Rust 侧近 30 天全量,
 * 于是表头写「最近 1 分钟」、表里是 30 天合计(流量均匀时差约 43200 倍)。
 * 修法:`loadFromCliproxy` 新增 `modelRange` 形参,**只**驱动 models / modelRoutes 两张表,
 * 与顶部主窗口 `range` 分轨(主窗口驱动 trend / ops / 逐账号 / 采购)。
 *
 * 为什么还要专门钉「哪条轨」:独立复核(2026-09-23)把视图调用点 `CostCenterView.vue:3470`
 * 的第 8 个实参 `modelCostRange.value` 换成 `range.value`,**全量 2550 条全绿** ——
 * 当时的用例全部传「同值双轨」(`'1h','1h'` / `'24h','24h'`),两条轨取值相同,
 * 无论传哪条结果都一样,天然无法区分轨道。那是**真实可达**的回归:cliproxy 下模型区可分离,
 * 分离后任一窗口变化都会以两个不同 range 落到该调用点,接错轨就会让两张表按主窗口取数、
 * 而表头仍渲染 modelCostRangeLabel —— 正是 ed57f9b 要消灭的「表头与数字不同窗口」。
 * 下面两条 store 级用例传**不同值双轨**来区分轨道,第三条用源码扫描钉住视图接线。
 */
describe('cliproxy 模型区独立窗口:models / modelRoutes 走 modelRange,与主窗口分轨', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 23, 21, 0, 0))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** 一条在 1h 窗口内、一条在 3 小时前(1h 外、24h 内)。 */
  function twoTracks(): CliproxyUsageEvent[] {
    const now = Date.now()
    return [
      makeEvent('alpha', now - 10 * MINUTE, 100),
      makeEvent('alpha', now - 3 * HOUR, 700),
    ]
  }

  it('主窗口 1h + 模型窗口 24h ⇒ 两张表按 24h 聚合(两条都计入)', () => {
    const data = useCostCenterData()
    data.loadFromCliproxy([], null, null, twoTracks(), PRICES, {}, '1h', '24h', 7.2)

    expect(data.models.value).toHaveLength(1)
    expect(data.models.value[0]!.requests).toBe(2)
    expect(data.modelRoutes.value).toHaveLength(1)
    expect(data.modelRoutes.value[0]!.requests).toBe(2)
    // 主窗口那一轨仍是 1h:逐账号只算窗口内那一条 —— 两轨互不污染。
    expect(data.rangeStats.value(accountOf(data, 'alpha'))?.requests).toBe(1)
  })

  it('成对反例:两个窗口互换 ⇒ 数字随之互换(证明两轨各自独立取参,不是共用一个)', () => {
    const swapped = useCostCenterData()
    swapped.loadFromCliproxy([], null, null, twoTracks(), PRICES, {}, '24h', '1h', 7.2)

    // 模型窗口 = 1h ⇒ 只剩窗口内那一条;主窗口 = 24h ⇒ 逐账号两条都算。
    // 若 store 内部把两个形参接反(或共用),这两组数字会一起错 ⇒ 红。
    expect(swapped.models.value[0]!.requests).toBe(1)
    expect(swapped.modelRoutes.value[0]!.requests).toBe(1)
    expect(swapped.rangeStats.value(accountOf(swapped, 'alpha'))?.requests).toBe(2)
  })

  it('视图调用点必须按 (range, modelCostRange) 顺序传参 —— 钉住接线,防「接错轨道」', () => {
    // 文本扫描钉不住「语义」,但**接线**必须钉:这是上面那个存活变异唯一的抓手。
    const view = readFileSync(resolve(process.cwd(), 'src/views/admin/CostCenterView.vue'), 'utf8')
    expect(view).toContain('data.loadFromCliproxy(')
    expect(view).toContain('range.value, modelCostRange.value, exchangeRate.value.rate')
    // 反向:不得出现「两轨都传主窗口」的写法。
    expect(view).not.toContain('range.value, range.value, exchangeRate.value.rate')
  })
})
