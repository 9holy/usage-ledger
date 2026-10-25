import './usageI18nFixture'
import i18n from '@/i18n'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountUsage, AccountUsageCycle, AccountUsagePeriod } from '@/api/usageAccounts'
import type { MonitorTotals } from '@/api/usageMonitor'
import { usageColors } from '../usageChartPalette'
import UsageAccountPeriods from '../UsageAccountPeriods.vue'

const day = (value: string) => Date.parse(`${value}T00:00:00Z`)
function totals(overrides: Partial<MonitorTotals> = {}): MonitorTotals {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requestCount: 0, pricedCostUsd: 0, unpricedRequests: 0, incompleteRequests: 0, cacheHitRatio: null, outputTokensPerSecond: 0, ...overrides }
}
function period(value = totals()): AccountUsagePeriod {
  return { startMs: day('2026-10-01'), endMs: day('2026-11-01'), observedEndMs: day('2026-10-18'), totals: value }
}
function cycle(value = totals(), overrides: Partial<AccountUsageCycle> = {}): AccountUsageCycle {
  return { ...period(value), startMs: day('2026-10-15'), endMs: day('2026-10-22'), resetAtMs: day('2026-10-22'), quotaObservedAtMs: day('2026-10-18'), exhaustedAtMs: null, exhaustionUnknown: false, usedPercent: 30, current: true, ...overrides }
}
function account(overrides: Partial<AccountUsage> = {}): AccountUsage {
  return { accountKey: 'anonymous-key', accountLabel: 'Example', tool: 'codex', attribution: 'session_creator', subscription: { startMs: null, endMs: null, checkedAtMs: null, source: 'none', error: null }, calendarWeek: period(), subscriptionMonth: null, currentCycle: null, previousCycle: null, quotaCycles: [], monthCycles: [], unsegmentedMonth: totals(), ...overrides }
}
function identified(usd: number, cny?: number): MonitorTotals {
  return totals({ requestCount: 2, automaticPriceSummary: { byMode: { standard: { responseRequests: 2, requestedRequests: 0, unknownRequests: 0, coveredRequests: 2, byCurrency: { USD: { amount: usd, requestCount: 1 } } } }, byCurrency: { USD: { responseSubtotal: usd, responseRequests: 1, requestedSubtotal: 0, requestedRequests: 0, unknownReferenceSubtotal: 0, unknownReferenceRequests: 0 }, ...(cny == null ? {} : { CNY: { responseSubtotal: cny, responseRequests: 1, requestedSubtotal: 0, requestedRequests: 0, unknownReferenceSubtotal: 0, unknownReferenceRequests: 0 } }) } } })
}

afterEach(() => vi.useRealTimers())

describe('account allowance periods', () => {
  it('switches period labels, dates and currencies without changing account attribution, cycles or amounts', async () => {
    const data = account({ currentCycle: cycle(identified(1.25, 8.75)) })
    const wrapper = mount(UsageAccountPeriods, { props: { account: data } })
    i18n.global.locale.value = 'en'; await nextTick()
    expect(wrapper.get('.amount-overview h4').text()).toBe('Weekly quota used this cycle')
    expect(wrapper.get('.period-amount').text()).toBe('$1.25 · CNY ¥8.75')
    expect(wrapper.text()).toContain('10/15/2026')
    expect(wrapper.props('account')).toEqual(data)
    expect(wrapper.get('details summary').text()).toBe('Amount details')
    i18n.global.locale.value = 'zh'; await nextTick()
    expect(wrapper.get('.period-amount').text()).toBe('$1.25 · 人民币 ¥8.75')
    expect(wrapper.text()).toContain('2026/10/15')
    wrapper.unmount()
  })
  it('keeps saved automatic prices in separate currencies and shows the real round dates', () => {
    const wrapper = mount(UsageAccountPeriods, { props: { account: account({ currentCycle: cycle(identified(1.25, 8.75)) }) } })
    expect(wrapper.get('.period-amount').text()).toBe('$1.25 · 人民币 ¥8.75')
    expect(wrapper.get('.amount-overview h4').text()).toBe('本轮周额度已用')
    expect(wrapper.findAll('details')).toHaveLength(1)
    expect(wrapper.get('details').attributes('open')).toBeUndefined()
    expect(wrapper.get('details summary').text()).toBe('金额明细')
    expect(wrapper.text()).toContain('本轮已记录用量估算')
    expect(wrapper.text()).toContain('2026/10/15')
    expect(wrapper.text()).toContain('2026/10/22')
    expect(wrapper.text()).toContain('按会话创建账号归属 · 参考估算，非实付')
    expect(wrapper.find('canvas').exists()).toBe(false)
  })

  it('does not draw an empty month or turn unpriced requests into zero dollars', () => {
    const wrapper = mount(UsageAccountPeriods, { props: { account: account({ currentCycle: cycle(totals({ requestCount: 3, unpricedRequests: 3 })) }) } })
    expect(wrapper.text()).toContain('来源未提供订阅起点')
    expect(wrapper.get('.amount-overview .unknown-month').text()).toBe('订阅日期未确认')
    expect(wrapper.text()).toContain('金额未知')
    expect(wrapper.text()).toContain('3 次缺单价')
    expect(wrapper.text()).not.toContain('$0')
    expect(wrapper.find('.subscription-month').exists()).toBe(false)
    expect(wrapper.find('.cycle-list').exists()).toBe(false)
  })

  it('labels unknown-mode references separately and reports identified requests without a price', () => {
    const value = totals({ requestCount: 4, automaticPriceSummary: { byMode: { standard: { responseRequests: 2, requestedRequests: 0, unknownRequests: 0, coveredRequests: 1, byCurrency: { USD: { amount: 2, requestCount: 1 } } } }, byCurrency: { USD: { responseSubtotal: 2, responseRequests: 1, requestedSubtotal: 0, requestedRequests: 0, unknownReferenceSubtotal: 99, unknownReferenceRequests: 2 } } } })
    const wrapper = mount(UsageAccountPeriods, { props: { account: account({ currentCycle: cycle(value) }) } })
    expect(wrapper.get('.period-amount').text()).toBe('$2.00')
    expect(wrapper.get('.reference').text()).toBe('模式未识别参考 $99.00')
    expect(wrapper.text()).toContain('2 次模式未识别')
    expect(wrapper.text()).toContain('1 次已识别但缺单价')
  })

  it('shows monthly intersections and unsegmented records with their amounts without removing them from the month', () => {
    vi.useFakeTimers().setSystemTime(day('2026-10-18'))
    const first = cycle(identified(3), { startMs: day('2026-10-01'), endMs: day('2026-10-08'), resetAtMs: day('2026-10-08'), quotaObservedAtMs: day('2026-10-08'), current: false })
    const second = cycle(identified(4))
    const wrapper = mount(UsageAccountPeriods, { props: { account: account({ currentCycle: second, subscription: { startMs: day('2026-10-01'), endMs: day('2027-01-01'), checkedAtMs: day('2026-10-18'), source: 'local_auth', error: null }, subscriptionMonth: period(identified(9)), monthCycles: [first, second], unsegmentedMonth: identified(2) }) } })
    expect(wrapper.get('.subscription-month .period-amount').text()).toBe('$9.00')
    expect(wrapper.get('.subscription-month h4').text()).toBe('本月已用')
    expect(wrapper.text()).toContain('本订阅月累计')
    expect(wrapper.text()).toContain('按来源订阅日期统计')
    expect(wrapper.text()).toContain('订阅信息更新于')
    const cycles = wrapper.findAll('.cycle-list li')
    expect(wrapper.findAll('.amount-evidence > div')).toHaveLength(2)
    expect(wrapper.get('.cycle-history').element.closest('.amount-evidence')).toBeNull()
    expect(cycles).toHaveLength(2)
    expect(cycles[0].text()).toContain('$3.00')
    expect(cycles[1].text()).toContain('$4.00')
    expect(cycles[0].attributes('style')).toContain(usageColors.cache)
    expect(cycles[1].attributes('style')).toContain(usageColors.input)
    expect(wrapper.get('.unsegmented').text()).toContain('此前未分轮记录')
    expect(wrapper.get('.unsegmented').text()).toContain('$2.00')
    expect(wrapper.get('.unsegmented').text()).toContain('已计入月累计')
  })

  it('marks an expired subscription month as historical instead of current', () => {
    vi.useFakeTimers().setSystemTime(day('2026-11-02'))
    const wrapper = mount(UsageAccountPeriods, { props: { account: account({ subscriptionMonth: period(identified(5)) }) } })
    expect(wrapper.text()).toContain('历史订阅月累计')
    expect(wrapper.get('.subscription-month h4').text()).toBe('历史月已用')
    expect(wrapper.text()).toContain('该订阅月已结束')
    expect(wrapper.text()).not.toContain('本订阅月累计')
  })

  it('shows the same recorded weekly quota percentage in monthly and full cycles, preserving unknown, zero and time coverage', async () => {
    const full = cycle(identified(3), { startMs: day('2026-09-28'), endMs: day('2026-10-05'), resetAtMs: day('2026-10-05'), quotaObservedAtMs: day('2026-10-04'), usedPercent: 27, current: false })
    const clipped = { ...full, startMs: day('2026-10-01') }
    const unknown = cycle(identified(4), { usedPercent: null })
    unknown.totals.incompleteRequests = 1
    const zero = cycle(identified(5), { startMs: day('2026-10-22'), endMs: day('2026-10-29'), resetAtMs: day('2026-10-29'), usedPercent: 0 })
    const data = account({ subscriptionMonth: period(identified(12)), monthCycles: [clipped, unknown, zero], quotaCycles: [zero, unknown, full] })
    const wrapper = mount(UsageAccountPeriods, { props: { account: data } })
    const monthRows = () => wrapper.findAll('.cycle-history li')
    const fullRows = () => wrapper.findAll('.quota-cycle-details li')
    expect(monthRows().map(row => row.get('.cycle-quota-percent').text())).toEqual(['上次记录的周额度已用 27.0%', '已用比例未记录', '上次记录的周额度已用 0.0%'])
    expect(fullRows().map(row => row.get('.cycle-quota-percent').text())).toEqual(['上次记录的周额度已用 0.0%', '已用比例未记录', '上次记录的周额度已用 27.0%'])
    expect(monthRows()[0].get('.cycle-quota-percent').attributes('title')).toContain('2026/10/04')
    expect(monthRows()[1].text()).toContain('1 次记录不完整')
    expect(monthRows()[1].get('.cycle-quota-percent').text()).not.toContain('0%')
    expect(monthRows()[0].text()).toContain('2026/10/01')
    expect(fullRows()[2].text()).toContain('2026/09/28')
    expect(monthRows()[0].get('.cycle-track').attributes('aria-hidden')).toBe('true')
    const trackStyle = monthRows()[0].attributes('style')
    i18n.global.locale.value = 'en'; await nextTick()
    expect(monthRows()[0].get('.cycle-quota-percent').text()).toBe('Last recorded weekly quota used: 27.0%')
    expect(monthRows()[1].get('.cycle-quota-percent').text()).toBe('Used percentage not recorded')
    expect(monthRows()[2].get('.cycle-quota-percent').text()).toBe('Last recorded weekly quota used: 0.0%')
    expect(monthRows()[0].get('.cycle-quota-percent').attributes('title')).toContain('10/04/2026')
    expect(wrapper.props('account')).toEqual(data)
    await wrapper.setProps({ account: { ...data, monthCycles: [{ ...clipped, usedPercent: 1 }, unknown, zero] } })
    expect(monthRows()[0].get('.cycle-quota-percent').text()).toContain('1.0%')
    expect(monthRows()[0].attributes('style')).toBe(trackStyle)
    expect(monthRows()[0].get('.cycle-heading strong').text()).toBe('$3.00')
    wrapper.unmount()
  })

  it('shows no-record and paused states without a fake zero estimate or duplicate credits', () => {
    const wrapper = mount(UsageAccountPeriods, { props: { account: account({ currentCycle: cycle() }), paused: true } })
    expect(wrapper.text()).toContain('本轮暂无已采集用量')
    expect(wrapper.text()).toContain('采集已暂停')
    expect(wrapper.text()).not.toContain('$0')
    expect(wrapper.text()).toContain('之后的用量只计入订阅月累计，积分余额不换算成金额')
    expect(wrapper.find('.amount-overview').text()).not.toContain('积分')
    const unknown = mount(UsageAccountPeriods, { props: { account: account() } })
    expect(unknown.text()).toContain('还没有额度周期的记录')
  })

  it('keeps unknown-mode-only and standard-reference-only values out of the main saved amount', () => {
    const automatic = totals({ requestCount: 1, automaticPriceSummary: { byMode: {}, byCurrency: { USD: { responseSubtotal: 0, responseRequests: 0, requestedSubtotal: 0, requestedRequests: 0, unknownReferenceSubtotal: 7, unknownReferenceRequests: 1 } } } })
    const wrapper = mount(UsageAccountPeriods, { props: { account: account({ currentCycle: cycle(automatic) }) } })
    expect(wrapper.get('.period-amount').text()).toBe('已识别金额未知')
    expect(wrapper.get('.reference').text()).toContain('模式未识别参考 $7.00')
    const standard = totals({ requestCount: 1, priceSummary: { coveredRequests: 1, byCurrency: { USD: { confirmedSubtotal: 0, confirmedRequests: 0, standardSubtotal: 8, standardRequests: 1 } } } })
    const fallback = mount(UsageAccountPeriods, { props: { account: account({ currentCycle: cycle(standard) }) } })
    expect(fallback.get('.period-amount').text()).toBe('金额未知')
    expect(fallback.get('.reference').text()).toContain('标准价参考 $8.00')
  })

  it('does not round a small recorded amount down to zero', () => {
    const wrapper = mount(UsageAccountPeriods, { props: { account: account({ currentCycle: cycle(identified(0.0000123)) }) } })
    expect(wrapper.get('.period-amount').text()).toBe('$0.0000123')
  })

  it('never substitutes natural-week money when the current quota boundary is unknown', () => {
    const wrapper = mount(UsageAccountPeriods, { props: { account: account({ calendarWeek: period(identified(4)) }) } })
    expect(wrapper.get('.period-amount').text()).toBe('本轮边界未确认')
    expect(wrapper.get('.amount-overview h4').text()).toBe('本轮周额度已用')
    expect(wrapper.text()).not.toContain('$4.00')
    expect(wrapper.text()).not.toContain('自然周')
  })

  it('shows the full previous round amount outside collapsed details even without subscription dates', () => {
    const previous = cycle(identified(123.45, 6), { startMs: day('2026-09-25'), endMs: day('2026-10-02'), resetAtMs: day('2026-10-02'), quotaObservedAtMs: day('2026-10-02'), observedEndMs: day('2026-10-02'), current: false })
    const wrapper = mount(UsageAccountPeriods, { props: { account: account({ previousCycle: previous, currentCycle: cycle(identified(7)) }) } })
    expect(wrapper.get('.previous-cycle h4').text()).toBe('上轮周额度已用')
    expect(wrapper.get('.previous-cycle .period-amount').text()).toBe('$123.45 · 人民币 ¥6.00')
    expect(wrapper.get('.previous-cycle').element.closest('details')).toBeNull()
    expect(wrapper.get('.amount-overview .period-amount').text()).toBe('$7.00')
    expect(wrapper.get('.previous-details').text()).toContain('2026/09/25')
    expect(wrapper.get('.previous-details').text()).toContain('2026/10/02')
    expect(wrapper.get('.previous-details').text()).toContain('完整额度轮次 · 已结束')
    expect(wrapper.get('.previous-details').text()).toContain('2 次请求')
  })

  it('does not label missing previous-round records as zero or substitute a clipped month cycle', () => {
    const wrapper = mount(UsageAccountPeriods, { props: { account: account({ monthCycles: [cycle(identified(9), { current: false })], subscriptionMonth: period(identified(9)) }) } })
    expect(wrapper.find('.previous-cycle').exists()).toBe(false)
    expect(wrapper.get('.previous-unavailable').text()).toBe('尚未记录已结束的周额度轮次')
  })

  it('keeps previous-round unknown-mode value separate from its identified amount', () => {
    const value = identified(10)
    value.requestCount = 3
    Object.assign(value.automaticPriceSummary!.byCurrency.USD, { unknownReferenceSubtotal: 99, unknownReferenceRequests: 1 })
    const wrapper = mount(UsageAccountPeriods, { props: { account: account({ previousCycle: cycle(value, { current: false }) }) } })
    expect(wrapper.get('.previous-cycle .period-amount').text()).toBe('$10.00')
    expect(wrapper.get('.previous-details .reference').text()).toBe('模式未识别参考 $99.00')
    expect(wrapper.get('.previous-details').text()).toContain('1 次模式未识别')
  })

  it('shows every uncut quota round newest first independently from monthly totals including post-exhaustion use', () => {
    vi.useFakeTimers().setSystemTime(day('2026-10-18'))
    const first100 = day('2026-10-17')
    const current = cycle(identified(40), { usedPercent: 100, exhaustedAtMs: first100, observedEndMs: first100 + 1 })
    const partial = identified(25, 6)
    partial.requestCount = 3
    Object.assign(partial.automaticPriceSummary!.byCurrency.USD, { unknownReferenceSubtotal: 99, unknownReferenceRequests: 1 })
    const previous = cycle(partial, { startMs: day('2026-09-23'), endMs: day('2026-09-30'), resetAtMs: day('2026-09-30'), quotaObservedAtMs: day('2026-09-28'), exhaustedAtMs: day('2026-09-28'), observedEndMs: day('2026-09-28') + 1, usedPercent: 100, current: false })
    const earlyReset = cycle(identified(5), { startMs: day('2026-09-20'), endMs: day('2026-09-22'), resetAtMs: day('2026-09-27'), quotaObservedAtMs: day('2026-09-22'), observedEndMs: day('2026-09-22'), usedPercent: 50, current: false })
    const wrapper = mount(UsageAccountPeriods, { props: { account: account({
      currentCycle: current, previousCycle: previous, quotaCycles: [current, previous, earlyReset],
      subscriptionMonth: period(identified(90)), monthCycles: [{ ...current, observedEndMs: day('2026-10-18'), totals: identified(90) }],
    }) } })
    expect(wrapper.get('.amount-overview .period-amount').text()).toBe('$40.00')
    expect(wrapper.get('.subscription-month .period-amount').text()).toBe('$90.00')
    expect(wrapper.get('.current-details').text()).toContain('首次记录到额度用完：2026/10/17')
    expect(wrapper.get('.current-details').text()).toContain('已记录至 2026/10/17')
    expect(wrapper.get('.current-details').text()).toContain('2026/10/22')
    expect(wrapper.get('.month-details').text()).toContain('含额度用尽后用量')
    expect(wrapper.get('.cycle-history').text()).toContain('本月各轮明细（含额度用尽后用量）')
    expect(wrapper.get('.cycle-history').text()).toContain('$90.00')

    const history = wrapper.get('.quota-cycle-details')
    expect(history.attributes('open')).toBeUndefined()
    expect(history.element.closest('.amount-details')).toBeNull()
    expect(history.get('summary').text()).toBe('额度轮次 3')
    const rows = history.findAll('li')
    expect(rows.map(row => Number(row.attributes('data-start-ms')))).toEqual([current.startMs, previous.startMs, earlyReset.startMs])
    expect(rows[0].text()).toContain('本轮 · 额度已用尽')
    expect(rows[0].text()).toContain('已用 100.0%')
    expect(rows[0].text()).toContain('$40.00')
    expect(rows[0].text()).not.toContain('$90.00')
    expect(rows[1].get('.cycle-heading strong').text()).toBe('$25.00 · 人民币 ¥6.00')
    expect(rows[1].get('.reference').text()).toBe('模式未识别参考 $99.00')
    expect(rows[1].text()).toContain('1 次模式未识别')
    expect(rows[1].text()).toContain('2026/09/23')
    expect(rows[1].text()).toContain('2026/09/30')
    expect(rows[2].text()).toContain('第 1 轮 · 已结束')
    expect(rows[2].text()).toContain('已用 50.0%')
    expect(rows[2].text()).toContain('2026/09/22')
    expect(rows[2].text()).not.toContain('首次观测')
  })

  it('labels legacy exhausted rounds without a known first-100 time instead of displaying fake zero or empty usage', () => {
    const current = cycle(totals(), { usedPercent: 100, exhaustionUnknown: true })
    const previous = cycle(totals(), { startMs: day('2026-09-01'), endMs: day('2026-09-08'), resetAtMs: day('2026-09-08'), quotaObservedAtMs: day('2026-09-08'), usedPercent: 100, exhaustionUnknown: true, current: false })
    const wrapper = mount(UsageAccountPeriods, { props: { account: account({ currentCycle: current, previousCycle: previous, quotaCycles: [current, previous] }) } })
    expect(wrapper.get('.amount-overview .period-amount').text()).toBe('用尽时间未记录')
    expect(wrapper.get('.previous-cycle .period-amount').text()).toBe('用尽时间未记录')
    expect(wrapper.get('.quota-cycle-details').text()).toContain('用尽时间未记录')
    expect(wrapper.text()).not.toContain('暂无已采集用量')
    expect(wrapper.text()).not.toContain('$0')
    expect(wrapper.text()).not.toContain('首次记录到额度用完：')
    expect(wrapper.get('.current-details').text()).not.toContain('已记录至')
  })

  it('keeps an unknown exhaustion cutoff after a correction to 99 percent without resuming uncapped weekly money', () => {
    const corrected = cycle(identified(999), { usedPercent: 99, exhaustionUnknown: true })
    const wrapper = mount(UsageAccountPeriods, { props: { account: account({ currentCycle: corrected, quotaCycles: [corrected] }) } })
    expect(wrapper.get('.amount-overview .period-amount').text()).toBe('用尽时间未记录')
    expect(wrapper.get('.quota-cycle-details').text()).toContain('已用 99.0%')
    expect(wrapper.get('.quota-cycle-details').text()).toContain('用尽时间未记录')
    expect(wrapper.text()).not.toContain('$999')
    expect(wrapper.text()).not.toContain('$0')
    expect(wrapper.get('.current-details').text()).not.toContain('已记录至')
  })
})
