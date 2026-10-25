/**
 * Cockpit 数据页成本展示的诚实性回归锁。
 *
 * 本页的成本有**两个来源**,此前两条都没防住"算不出来被当 0":
 *  1. 数据源口径 `stats.totals.estimatedCostUsd` —— 它是**哨兵 0**:有用量但模型没匹配到单价时
 *     也写 0(证据:cockpit-tools `codex_local_access_routing_pricing.rs:1824` 的
 *     `resolve_base_model_pricing(...) else { return 0.0; }`、`:1845` 的
 *     `if cost > 0.0 { cost } else { 0.0 }`、TS 层 `codexWindowStats.ts:104` 的 `?? 0`;
 *     本机实测样本:`codex_local_access_stats.json` → `monthly.models` 的 `gpt-image-2`,
 *     totalTokens 6704、estimatedCostUsd 0.0)。此前模板写 `selfTotalUsd ?? stats.totals.estimatedCostUsd`
 *     裸取 ⇒ 渲染 `$0.00`。
 *  2. 本项目自算口径 `cockpitSplitCostUsd` —— 没有该模型单价时返回 cost=0 且
 *     basis='no_price_no_estimate',此前只累加 cost ⇒ 自算总额静默偏小。
 *
 * 断言成对写:缺失/算不出 ⇒ 「无数据」;真实 0 ⇒ 仍是 `$0.00`。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import i18n from '@/i18n'
import desktopEn from '@/i18n/locales/en/desktop'
import desktopZh from '@/i18n/locales/zh/desktop'
import commonEn from '@/i18n/locales/en/common'
import commonZh from '@/i18n/locales/zh/common'
import costEn from '@/i18n/locales/en/costComponents'
import costZh from '@/i18n/locales/zh/costComponents'
import costDataEn from '@/i18n/locales/en/costData'
import costDataZh from '@/i18n/locales/zh/costData'

vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/stores/connection', () => ({
  errMsg: (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback),
}))
vi.mock('@/api/cockpit', () => ({
  getCockpitConnectionState: vi.fn(),
  getCockpitStats: vi.fn(),
  getCockpitCodexAccounts: vi.fn(),
  getCockpitRequestLogSummary: vi.fn(),
  getCockpitLocalAccess: vi.fn(),
}))

import {
  getCockpitConnectionState,
  getCockpitStats,
  getCockpitCodexAccounts,
  getCockpitRequestLogSummary,
  getCockpitLocalAccess,
} from '@/api/cockpit'
import CockpitDataView from '../CockpitDataView.vue'

function usageStats(estimatedCostUsd: number, totalTokens = 1500) {
  return {
    requestCount: 10, successCount: 10, failureCount: 0, clientCanceledCount: 0,
    upstreamResponseFailedCount: 0, streamIncompleteCount: 0, totalLatencyMs: 100,
    textRequestCount: 10, imageRequestCount: 0, imageGenerationRequestCount: 0,
    imageEditRequestCount: 0, imageGenerationCapabilityFailureCount: 0,
    inputTokens: 1000, outputTokens: 500, totalTokens, cachedTokens: 100, reasoningTokens: 0,
    estimatedCostUsd,
  }
}

function statsFixture(estimatedCostUsd: number, totalTokens = 1500, accounts: unknown[] = []) {
  return { since: 1, updatedAt: 1, totals: usageStats(estimatedCostUsd, totalTokens), accounts, models: [], apiKeys: [] }
}

/**
 * 内置价目表里**没有**的模型 id。
 * 用真实模型名(如 gpt-5.6-sol)会命中 `COCKPIT_PRICE_BOOK` ⇒ 走本项目自算、根本不读
 * 组里的 `estimatedCostUsd`(实测会算出 $0.01),那样就测不到"无单价"这条路径了。
 */
const UNPRICED_A = 'zzz-unpriced-model-a'
const UNPRICED_B = 'zzz-unpriced-model-b'

/** 单请求用量库的一组聚合(模型 × 账号)。 */
function group(model: string, estimatedCostUsd: number) {
  return {
    model, accountId: 'acct-a', apiKeyId: 'key-1', firstMs: 1, lastMs: 2,
    requests: 1, success: 1, error: 0,
    stdNormalInput: 1000, stdCached: 0, stdOutput: 100,
    longNormalInput: 0, longCached: 0, longOutput: 0,
    estimatedCostUsd, rateLimited: 0, upstreamError: 0, clientCanceled: 0,
  }
}

function logSummary(groups: unknown[], available = true) {
  return {
    available, rowCount: groups.length, windowStartMs: null, windowEndMs: null,
    bucketHours: 1, cells: [], groups, bucketLatencies: [],
  }
}

/** 本页唯一的总成本大数元素 */
function totalStrong(wrapper: ReturnType<typeof mount>) {
  return wrapper.find('.cost-donut strong')
}

async function renderPage() {
  const wrapper = mount(CockpitDataView, { global: { plugins: [i18n] } })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  i18n.global.setLocaleMessage('en', { desktop: desktopEn, ...commonEn, ...costEn, costData: costDataEn })
  i18n.global.setLocaleMessage('zh', { desktop: desktopZh, ...commonZh, ...costZh, costData: costDataZh })
  i18n.global.locale.value = 'zh'
  vi.mocked(getCockpitConnectionState).mockResolvedValue({ available: true, running: true, reason: null } as never)
  vi.mocked(getCockpitCodexAccounts).mockResolvedValue([] as never)
  vi.mocked(getCockpitLocalAccess).mockResolvedValue({ modelPricings: [] } as never)
  // 默认:单请求用量库不可用(旧版 cockpit 未落库)⇒ 走数据源口径
  vi.mocked(getCockpitRequestLogSummary).mockResolvedValue(logSummary([], false) as never)
  vi.mocked(getCockpitStats).mockResolvedValue(statsFixture(20) as never)
})

it('switches the local data page without refetching, changing costs or translating account data', async () => {
  const rawAccount = '账号原文 Alpha'
  vi.mocked(getCockpitStats).mockResolvedValue(statsFixture(20, 1500, [{ accountId: rawAccount, email: 'original@example.test', usage: usageStats(20) }]) as never)
  const wrapper = await renderPage()
  const reads = vi.mocked(getCockpitStats).mock.calls.length
  expect(totalStrong(wrapper).text()).toBe('$20.00')
  i18n.global.locale.value = 'en'; await flushPromises()
  expect(wrapper.get('.cost-page-heading h2').text()).toBe('Cockpit Data')
  expect(wrapper.get('[aria-label="Refresh Cockpit data"]').attributes('title')).toBe('Refresh Cockpit data')
  expect(wrapper.get('[aria-label="Cockpit account details table"]').text()).toContain(rawAccount)
  expect(wrapper.findAll('thead th').map(cell => cell.text())).toEqual(['Email', 'Plan', 'Subscription expires', 'Requests', 'Input', 'Output', 'Usage value estimate (USD)'])
  expect(totalStrong(wrapper).text()).toBe('$20.00')
  expect(wrapper.text()).toContain('Estimate from Cockpit, not a payment')
  expect(wrapper.get('.cost-metric-cell__state').text()).toBe('Estimated')
  expect(wrapper.text().replaceAll(rawAccount, '')).not.toMatch(/\p{Script=Han}/u)
  expect(vi.mocked(getCockpitStats)).toHaveBeenCalledTimes(reads)
  i18n.global.locale.value = 'zh'; await flushPromises()
  expect(wrapper.get('.cost-page-heading h2').text()).toBe('Cockpit 数据')
  expect(totalStrong(wrapper).text()).toBe('$20.00')
  wrapper.unmount()
})

it('localizes its own unknown-error fallback while retaining raw external diagnostics', async () => {
  vi.mocked(getCockpitStats).mockRejectedValueOnce(null)
  const wrapper = await renderPage()
  expect(wrapper.get('[role="alert"]').text()).toContain('cockpit 数据读取失败')
  i18n.global.locale.value = 'en'; await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toContain('Failed to read Cockpit data')
  vi.mocked(getCockpitStats).mockRejectedValueOnce(new Error('来源诊断原文'))
  await wrapper.get('[aria-label="Refresh Cockpit data"]').trigger('click'); await flushPromises()
  expect(wrapper.get('[role="alert"]').text()).toContain('来源诊断原文')
  wrapper.unmount()
})

describe('CockpitDataView · 总成本的哨兵 0', () => {
  it('源有用量却报 0 ⇒ 大数必须是「无数据」,不能渲染 $0.00', async () => {
    // 本机 monthly.models 的 gpt-image-2 就是这个形状:有 token、成本 0.0
    vi.mocked(getCockpitStats).mockResolvedValue(statsFixture(0, 6704) as never)

    const wrapper = await renderPage()

    expect(totalStrong(wrapper).text()).toBe('无数据')
    expect(wrapper.text()).not.toContain('$0.00')
    // 归因必须说清是"没匹配到单价",不是泛泛的"无数据"
    expect(wrapper.text()).toContain('没有对应价格')
  })

  it('真的一点用量都没有时 0 是**真值** ⇒ 仍渲染 $0.00(成对断言,防过度修正)', async () => {
    vi.mocked(getCockpitStats).mockResolvedValue(statsFixture(0, 0) as never)

    const wrapper = await renderPage()

    expect(totalStrong(wrapper).text()).toBe('$0.00')
  })

  it('有正常成本时原样展示(哨兵判据没有把真值也拦掉)', async () => {
    vi.mocked(getCockpitStats).mockResolvedValue(statsFixture(26703.03) as never)

    const wrapper = await renderPage()

    expect(totalStrong(wrapper).text()).toBe('$26,703.03')
  })

  it('成本字段缺失 ⇒ 也必须是「无数据」,且归因与哨兵 0 不同', async () => {
    vi.mocked(getCockpitStats).mockResolvedValue({ since: 1, updatedAt: 1, totals: {}, accounts: [] } as never)

    const wrapper = await renderPage()

    expect(totalStrong(wrapper).text()).toBe('无数据')
    expect(wrapper.text()).toContain('没有费用信息')
    expect(wrapper.text()).not.toContain('没有对应价格')
  })
})

describe('CockpitDataView · 自算口径的三态桶', () => {
  it('全部模型都无单价 ⇒ 不把"自算不出来"当 $0,回退数据源并如实标注归因', async () => {
    vi.mocked(getCockpitStats).mockResolvedValue(statsFixture(20) as never)
    vi.mocked(getCockpitRequestLogSummary).mockResolvedValue(logSummary([group(UNPRICED_A, 0)]) as never)

    const wrapper = await renderPage()

    // 回退到数据源估算 20(不是自算的 0)
    expect(totalStrong(wrapper).text()).toBe('$20.00')
    expect(wrapper.text()).toContain('本应用没有对应价格')
  })

  it('部分模型无单价 ⇒ 自算额是**下界**,必须标注且不给强调色', async () => {
    vi.mocked(getCockpitStats).mockResolvedValue(statsFixture(999) as never)
    vi.mocked(getCockpitRequestLogSummary).mockResolvedValue(
      logSummary([group(UNPRICED_B, 5), group(UNPRICED_A, 0)]) as never,
    )

    const wrapper = await renderPage()

    // 自算 5(只含算得出的那组),不再回退数据源 999
    expect(totalStrong(wrapper).text()).toBe('$5.00')
    expect(wrapper.text()).toContain('只算出一部分')
    expect(totalStrong(wrapper).classes()).toContain('cost-unknown-value')
    expect(totalStrong(wrapper).classes()).not.toContain('cost-emphasis')
  })

  it('全部模型都算得出 ⇒ 用自算值,且给强调色(没有把正常路径也降级)', async () => {
    vi.mocked(getCockpitStats).mockResolvedValue(statsFixture(999) as never)
    vi.mocked(getCockpitRequestLogSummary).mockResolvedValue(logSummary([group(UNPRICED_B, 5)]) as never)

    const wrapper = await renderPage()

    expect(totalStrong(wrapper).text()).toBe('$5.00')
    expect(totalStrong(wrapper).classes()).toContain('cost-emphasis')
    expect(wrapper.text()).not.toContain('只算出一部分')
  })
})

describe('CockpitDataView · 逐账号成本', () => {
  /** 成本列 = 第 7 列(邮箱/Plan/订阅到期/请求/Input/Output/成本) */
  function costCellText(wrapper: ReturnType<typeof mount>, rowIndex = 0) {
    const row = wrapper.findAll('tbody tr')[rowIndex]
    return row.findAll('td')[6].text()
  }

  it('账号有用量却报 0 ⇒ 该行「无数据」,不是 $0.00', async () => {
    vi.mocked(getCockpitStats).mockResolvedValue(statsFixture(0, 0, [
      { accountId: 'acct-x', email: 'x@example.com', usage: usageStats(0, 6704) },
    ]) as never)

    const wrapper = await renderPage()

    expect(costCellText(wrapper)).toContain('无数据')
    expect(costCellText(wrapper)).not.toContain('$0.00')
  })

  it('账号确实没有用量(0 token)⇒ 该行仍渲染 $0.00(成对断言)', async () => {
    vi.mocked(getCockpitStats).mockResolvedValue(statsFixture(0, 0, [
      { accountId: 'acct-y', email: 'y@example.com', usage: usageStats(0, 0) },
    ]) as never)

    const wrapper = await renderPage()

    expect(costCellText(wrapper)).toContain('$0.00')
  })
})

describe('CockpitDataView · 读取恢复', () => {
  it('shows a read failure without claiming missing data and can retry from the page', async () => {
    vi.mocked(getCockpitStats).mockRejectedValueOnce(new Error('本地数据读取失败'))
    const wrapper = await renderPage()
    expect(wrapper.get('[role="alert"]').text()).toContain('本地数据读取失败')
    expect(wrapper.text()).not.toContain('请先运行 cockpit-tools')
    await wrapper.get('[aria-label="刷新 Cockpit 数据"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(totalStrong(wrapper).text()).toBe('$20.00')
  })

  it('disables refresh while reading and preserves previous data when a refresh fails', async () => {
    vi.mocked(getCockpitStats).mockResolvedValue(statsFixture(20, 1500, [{ accountId: 'account', usage: usageStats(20) }]) as never)
    const wrapper = await renderPage()
    expect(wrapper.get('[aria-label="Cockpit 账号明细表格"]').attributes('tabindex')).toBe('0')
    let reject!: (error: Error) => void
    vi.mocked(getCockpitStats).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    await wrapper.get('[aria-label="刷新 Cockpit 数据"]').trigger('click')
    expect(wrapper.get('[aria-label="刷新 Cockpit 数据"]').attributes('disabled')).toBeDefined()
    expect(wrapper.get('main').attributes('aria-busy')).toBe('true')
    reject(new Error('刷新读取失败'))
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('保留上次成功读取的数据')
    expect(totalStrong(wrapper).text()).toBe('$20.00')
    expect(wrapper.get('[aria-label="刷新 Cockpit 数据"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('main').attributes('aria-busy')).toBe('false')
  })
})
