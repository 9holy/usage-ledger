import { shallowMount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { costComponentI18n } from './costI18n'
import { usageBucketHours } from '../../usageWindow'
import type { OpsThroughputTrendPoint } from '@/api/admin/ops'
import AdaptiveOperationsCharts from '../AdaptiveOperationsCharts.vue'
import CostLineChart from '../CostLineChart.vue'
import EconomicCostLineChart from '../EconomicCostLineChart.vue'
import GlassQualityChart from '../GlassQualityChart.vue'

function point(overrides: Partial<OpsThroughputTrendPoint> = {}): OpsThroughputTrendPoint {
  return {
    bucket_start: '2026-08-11T12:00:00.000Z',
    request_count: 1,
    success_count: 1,
    error_count: 0,
    token_consumed: 15,
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    switch_count: 0,
    user_billed_usd: 1,
    account_cost_usd: 0.25,
    contribution_usd: 0.75,
    duration_p95_ms: null,
    ttft_p50_ms: null,
    ttft_p95_ms: null,
    qps: 0.2,
    tps: 3,
    ...overrides,
  }
}

function mountChart(
  opsTrend: OpsThroughputTrendPoint[],
  sourceKind: 'sub2api' | 'cliproxy' | 'cockpit' = 'sub2api',
  overrides: Record<string, unknown> = {},
  i18n = costComponentI18n(),
) {
  return shallowMount(AdaptiveOperationsCharts, {
    global: { plugins: [i18n] },
    props: {
      sourceKind,
      opsTrend,
      financialTrend: opsTrend.map((item) => ({
        timestamp: item.bucket_start,
        billedUsd: item.user_billed_usd,
        accountCostUsd: item.account_cost_usd,
        contributionUsd: item.contribution_usd,
        bucketHours: 5 / 3600,
        source: 'ops' as const,
      })),
      errorTrend: [],
      economics: null,
      cnyPerUsd: 7,
      opsBucketHours: 5 / 3600,
      procurementHourlyCny: 0,
      opsState: 'measured',
      opsReason: '',
      healthState: 'empty',
      healthReason: '没有健康样本',
      ...overrides,
    },
  })
}

describe('AdaptiveOperationsCharts truthful rates', () => {
  it('keeps valid financial data available when Ops is unavailable, including inferred zero facts', async () => {
    const wrapper = mountChart([point()], 'sub2api', { opsState: 'unavailable', opsReason: 'Ops failed', financialState: 'partial', financialReason: 'Verified SQL subtotal' })
    const chart = wrapper.findComponent(EconomicCostLineChart)
    expect(chart.props()).toMatchObject({ state: 'partial', stateReason: 'Verified SQL subtotal' })
    expect(wrapper.findComponent(GlassQualityChart).props('state')).toBe('unavailable')
    expect(chart.props('series')[0].data).toEqual([5040])
    await wrapper.setProps({ financialState: undefined, financialReason: undefined, financialTrend: [{ timestamp: point().bucket_start, billedUsd: 0, accountCostUsd: 0, contributionUsd: 0, bucketHours: 1, source: 'usage_logs', costPartial: false }] })
    expect(chart.props('state')).toBe('measured')
    expect(chart.props('stateReason')).not.toBe('Ops failed')
    expect(chart.props('series')[0].data).toEqual([0])
  })

  it('uses the query intersection for all economic modes and keeps outside buckets unknown', async () => {
    const queryWindow = { start: new Date('2026-08-11T12:00:02Z'), end: new Date('2026-08-11T12:00:03Z') }
    const wrapper = mountChart([point()], 'sub2api', { queryWindow, procurementHourlyCny: 14 })
    const hours = usageBucketHours(point().bucket_start, 5 / 3600, queryWindow)!
    const chart = wrapper.findComponent(EconomicCostLineChart)
    expect(hours).toBe(1 / 3600)
    expect(chart.props('series').map((series: { data: number[] }) => series.data[0])).toEqual([25200, 6300, 18886])
    await wrapper.get('select[aria-label="收支指标"]').setValue('unit')
    expect(chart.props('series')[0].data[0]).toBeCloseTo(14 / 3600)
    await wrapper.get('select[aria-label="收支指标"]').setValue('return')
    expect(chart.props('series')[0].data[0]).toBeCloseTo(180000)
    expect(chart.props('series')[1].data[0]).toBeCloseTo((18900 - 14) / 25200 * 100)
    await wrapper.setProps({ queryWindow: { start: new Date('2026-08-11T13:00:00Z'), end: new Date('2026-08-11T13:01:00Z') } })
    expect(chart.props('series').every((series: { data: unknown[] }) => series.data[0] == null)).toBe(true)
  })

  it('infers partial and unavailable financial states without borrowing Ops success', async () => {
    const wrapper = mountChart([point()], 'sub2api', { financialTrend: [{ timestamp: point().bucket_start, billedUsd: 1, accountCostUsd: null, contributionUsd: null, bucketHours: 1, source: 'usage_logs', costPartial: true }] })
    const chart = wrapper.findComponent(EconomicCostLineChart)
    expect(chart.props('state')).toBe('partial')
    await wrapper.setProps({ financialTrend: [{ timestamp: point().bucket_start, billedUsd: null, accountCostUsd: null, contributionUsd: null, bucketHours: 1, source: 'usage_logs', costPartial: false }] })
    expect(chart.props('state')).toBe('unavailable')
    await wrapper.setProps({ financialTrend: [] })
    expect(chart.props('state')).toBe('empty')
  })
  it('uses the known bucket width when a window contains only one point', () => {
    const economyChart = mountChart([point()]).findComponent(EconomicCostLineChart)
    const series = economyChart.props('series') as Array<{ data: Array<number | null> }>

    expect(series[0].data[0]).toBeCloseTo(5040)
  })

  it('keeps a null fact as a chart gap instead of converting it to zero', () => {
    const economyChart = mountChart([point({ user_billed_usd: null as unknown as number })]).findComponent(EconomicCostLineChart)
    const series = economyChart.props('series') as Array<{ data: Array<number | null> }>

    expect(series[0].data[0]).toBeNull()
  })
})

describe('AdaptiveOperationsCharts cache and locale contracts', () => {
  it.each(['sub2api', 'cliproxy', 'cockpit'] as const)('uses stable, separate economy mode IDs for %s', async sourceKind => {
    const i18n = costComponentI18n()
    const wrapper = mountChart([point()], sourceKind, {}, i18n)
    const chart = wrapper.findComponent(EconomicCostLineChart)
    const ids = () => chart.props('series').map((series: { id: string }) => series.id)
    const flow = ids()
    expect(flow.every((id: string) => id.startsWith('flow-'))).toBe(true)
    await wrapper.get('select[aria-label="收支指标"]').setValue('unit')
    const unit = ids()
    expect(unit.every((id: string) => id.startsWith('unit-'))).toBe(true)
    i18n.global.locale.value = 'en'
    await nextTick()
    expect(ids()).toEqual(unit)
    await wrapper.get('select[aria-label="Income and cost metrics"]').setValue('return')
    const returns = ids()
    expect(returns.every((id: string) => id.startsWith('return-'))).toBe(true)
    const all = [...flow, ...unit, ...returns]
    expect(new Set(all).size).toBe(all.length)
  })
  it.each(['sub2api', 'cliproxy', 'cockpit'] as const)('uses the source token contract for %s, preserving zero and unknown ratios', async sourceKind => {
    const wrapper = mountChart([point({ input_tokens: sourceKind === 'sub2api' ? 40 : 100, cache_read_tokens: 50, cache_creation_tokens: 10 })], sourceKind)
    await wrapper.get('select[aria-label="响应速度指标"]').setValue('cache')
    const chart = () => wrapper.findAllComponents(CostLineChart).at(-1)!
    expect(chart().props('series')[0].data).toEqual([50])
    await wrapper.setProps({ opsTrend: [point({ input_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 0 })] })
    expect(chart().props('series')[0].data).toEqual([0])
    await wrapper.setProps({ opsTrend: [point({ input_tokens: null, cache_read_tokens: 50 })] })
    expect(chart().props('series')[0].data).toEqual([null])
    await wrapper.setProps({ opsTrend: [point({ input_tokens: 100, cache_read_tokens: 50, cache_creation_tokens: null })] })
    expect(chart().props('series')[0].data).toEqual([sourceKind === 'sub2api' ? null : 50])
    await wrapper.setProps({ opsTrend: [point({ input_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 })] })
    expect(chart().props('series')[0].data).toEqual([null])
  })

  it('parses naive SQL buckets as UTC for labels, error alignment and event placement', async () => {
    const previous = process.env.TZ
    process.env.TZ = 'Asia/Taipei'
    try {
      const wrapper = mountChart([point({ bucket_start: '2026-08-11 12:00:00' })], 'sub2api', {
        errorTrend: [{ bucket_start: '2026-08-11T12:00:00Z', upstream_429_count: 2, upstream_402_count: 0, upstream_error_count_excl_429_529: 0 }],
        economics: { series: [], events: [{ occurred_at: '2026-08-11T12:00:00Z', label: 'raw-event-原文', severity: 'warning' }] },
      })
      const label = wrapper.findComponent(EconomicCostLineChart).props('labels')[0]
      expect(wrapper.findComponent(EconomicCostLineChart).props('events')).toHaveLength(1)
      expect(wrapper.findComponent(EconomicCostLineChart).props('events')[0].label).toContain('raw-event-原文')
      await wrapper.get('select[aria-label="请求质量指标"]').setValue('status')
      expect(wrapper.findAllComponents(CostLineChart)[0].props('series')[0].data).toEqual([2])
      await wrapper.setProps({ financialTrend: [{ timestamp: '2026-08-11T12:00:00Z', billedUsd: 1, accountCostUsd: 0, contributionUsd: 1, bucketHours: 1, source: 'ops', costPartial: false }] })
      expect(wrapper.findComponent(EconomicCostLineChart).props('labels')[0]).toBe(label)
    } finally {
      if (previous == null) delete process.env.TZ
      else process.env.TZ = previous
    }
  })

  it('switches static labels and computed series immediately while preserving the selected mode and raw values', async () => {
    const i18n = costComponentI18n()
    const wrapper = mountChart([point()], 'cliproxy', { accountHealth: { normal: 1, limited: 2, error: 3, inactive: 4 } }, i18n)
    await wrapper.get('select[aria-label="响应速度指标"]').setValue('cache')
    const before = wrapper.findComponent(EconomicCostLineChart).props('series')[0].data
    i18n.global.locale.value = 'en'
    await nextTick()
    expect(wrapper.text()).toContain('Cost and request trends')
    expect(wrapper.findComponent(EconomicCostLineChart).props('series')[0].label).toBe('Usage value estimate')
    expect(wrapper.findComponent(EconomicCostLineChart).props('series')[0].data).toEqual(before)
    expect((wrapper.get('select[aria-label="Response speed metrics"]').element as HTMLSelectElement).value).toBe('cache')
    expect(wrapper.find('.account-health__bar').attributes('aria-label')).toBe('Can receive requests 1, Rate limited 2, Error 3, Inactive 4')
  })
})

/**
 * 三源口径回归锁(2026-09-16)。
 *
 * billedUsd 只有 sub2api(usage_logs.actual_cost)是**用户计费(营收)**:
 * cockpitAdapter / cliproxyAdapter 都刻意把 actual_cost 填成**成本**,且与 account_cost 逐点相等
 * ⇒ contributionUsd 恒为 0。此前本组件对三源共用「用户计费、成本与贡献毛利 / 用户计费 / 贡献毛利」,
 * 等于对 cockpit 与 cliproxy 两源都把成本标成营收、并把假零画成一条线。
 */
describe('AdaptiveOperationsCharts 三源口径', () => {
  function mount(sourceKind: 'sub2api' | 'cliproxy' | 'cockpit') {
    return mountChart([point()], sourceKind)
  }

  it('sub2api 保持原样:收入口径 + 三条序列(用户计费 / 上游账号成本 / 贡献毛利)', () => {
    const wrapper = mount('sub2api')
    const chart = wrapper.findComponent(EconomicCostLineChart)
    expect(chart.props('series').map((s: { label: string }) => s.label))
      .toEqual(['用户计费', '上游账号成本', '贡献毛利'])
    expect(wrapper.text()).toContain('用户计费、成本与贡献毛利')
  })

  it('cockpit:flow 档标题改为「成本与采购」,序列只剩自算成本(不画假零贡献毛利)', () => {
    const wrapper = mount('cockpit')
    const labels = wrapper.findComponent(EconomicCostLineChart).props('series').map((s: { label: string }) => s.label)
    expect(labels).toEqual(['用量估值（按价格计算）'])
    expect(labels).not.toContain('用户计费')
    expect(labels).not.toContain('贡献毛利')
    expect(wrapper.text()).toContain('成本与采购')
    expect(wrapper.text()).not.toContain('用户计费、成本与贡献毛利')
  })

  it('cliproxy:flow 档序列只剩估算成本', () => {
    const wrapper = mount('cliproxy')
    expect(wrapper.findComponent(EconomicCostLineChart).props('series').map((s: { label: string }) => s.label))
      .toEqual(['用量估值'])
    expect(wrapper.text()).toContain('成本与采购')
  })

  it('unit 档:非 sub2api 标题去掉「产出」,副标题换成按源成本口径', async () => {
    for (const [sourceKind, costWord] of [['cockpit', '用量估值（按价格计算）'], ['cliproxy', '用量估值']] as const) {
      const wrapper = mount(sourceKind)
      await wrapper.find('select[aria-label="收支指标"]').setValue('unit')
      const chart = wrapper.findComponent(EconomicCostLineChart)
      expect(wrapper.text()).toContain('每 1 USD 费用对应的采购成本')
      expect(wrapper.text()).not.toContain('产出')
      expect(wrapper.text()).toContain(`固定采购费率 ÷ ${costWord}`)
      expect(chart.props('series').map((s: { label: string }) => s.label)).toEqual([`采购成本 / ${costWord}`])
    }
  })

  it('keeps revenue analysis available while explaining missing source inputs', async () => {
    for (const sourceKind of ['cockpit', 'cliproxy'] as const) {
      const wrapper = mount(sourceKind)
      expect(wrapper.find('select[aria-label="收支指标"] option[value="return"]').exists()).toBe(true)
      await wrapper.find('select[aria-label="收支指标"]').setValue('return')
      expect(wrapper.findComponent(EconomicCostLineChart).props('state')).toBe('unavailable')
      expect(wrapper.findComponent(EconomicCostLineChart).props('series')).toEqual([])
    }
    const wrapper = mount('sub2api')
    await wrapper.find('select[aria-label="收支指标"]').setValue('return')
    await wrapper.setProps({ sourceKind: 'cliproxy' })
    expect((wrapper.find('select[aria-label="收支指标"]').element as HTMLSelectElement).value).toBe('return')
  })

  it('return 档:sub2api 仍然照画(它是唯一有营收层的源)', async () => {
    const wrapper = mount('sub2api')
    await wrapper.find('select[aria-label="收支指标"]').setValue('return')
    const chart = wrapper.findComponent(EconomicCostLineChart)
    expect(chart.props('state')).toBe('measured')
    expect(chart.props('series').map((s: { label: string }) => s.label))
      .toEqual(['固定采购回本率', '贡献毛利率'])
  })

  it('shows current account states without inventing a historical series', async () => {
    const wrapper = mount('cliproxy')
    await wrapper.setProps({ accountHealth: { normal: 1, limited: 2, error: 3, inactive: 4 } })
    expect(wrapper.find('.account-health__total strong').text()).toBe('10')
    expect(wrapper.find('.account-health__bar').attributes('aria-label')).toBe('可接收请求 1，限流 2，异常 3，停用 4')
    expect(wrapper.find('.account-health').text()).not.toContain('无记录')
    expect(wrapper.findAllComponents(CostLineChart)).toHaveLength(1)
    expect(wrapper.findComponent(EconomicCostLineChart).exists()).toBe(true)
    expect(wrapper.findComponent(GlassQualityChart).exists()).toBe(true)
    await wrapper.setProps({ accountHealth: null, healthReason: '账号读取失败' })
    expect(wrapper.find('.account-health').exists()).toBe(false)
    expect(wrapper.find('.account-health__missing').text()).toBe('账号读取失败')
  })

  it('keeps latency and error dimensions selectable even without samples', async () => {
    const wrapper = mount('cliproxy')
    const select = wrapper.find('select[aria-label="响应速度指标"]')
    expect((select.element as HTMLSelectElement).value).toBe('tokens')
    expect(select.find('option[value="latency"]').exists()).toBe(true)
    expect(wrapper.find('select[aria-label="请求质量指标"] option[value="status"]').exists()).toBe(true)
    await wrapper.setProps({ opsTrend: [point({ duration_p95_ms: 18 })] })
    expect(select.find('option[value="latency"]').exists()).toBe(true)
    await select.setValue('latency')
    expect(wrapper.findAllComponents(CostLineChart).at(-1)?.props('series')[2].data).toEqual([18])
    await wrapper.setProps({ opsTrend: [point()] })
    expect((select.element as HTMLSelectElement).value).toBe('latency')
    expect(wrapper.findAllComponents(CostLineChart).at(-1)?.props('series')[2].data).toEqual([null])
  })
})
