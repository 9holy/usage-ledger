import { shallowMountWithCostI18n as shallowMount } from './costI18n'
import { describe, expect, it, vi } from 'vitest'
import CostLineChart from '../CostLineChart.vue'

describe('CostLineChart truthful states', () => {
  it('uses opt-in value-anchored gradients and peak markers while preserving real gaps', () => {
    const stops = [{ value: 0, color: '#79bdff' }, { value: 10, color: '#50d9b4' }, { value: 20, color: '#f4c467' }]
    const wrapper = shallowMount(CostLineChart, { props: { labels: ['a', 'b', 'c', 'd'], series: [{ label: '输出', color: '#f4c467', colorStops: stops, fill: true, data: [0, 10, null, 20] }], showValues: true } })
    const state = (wrapper.vm as any).$.setupState
    const series = state.chartData.datasets[0]
    const gradient = { addColorStop: vi.fn() }
    const createLinearGradient = vi.fn(() => gradient)
    const chart = { chartArea: { top: 0, bottom: 200 }, ctx: { createLinearGradient }, scales: { y: { getPixelForValue: (value: number) => 200 - value * 10 } } }
    expect(series.borderColor({ chart })).toBe(gradient)
    expect(createLinearGradient).toHaveBeenCalledWith(0, 200, 0, 0)
    expect(gradient.addColorStop.mock.calls).toEqual([[0, '#79bdff'], [0.5, '#50d9b4'], [1, '#f4c467']])
    expect(series.data).toEqual([0, 10, null, 20])
    expect(series.spanGaps).toBe(false)
    expect(series.pointRadius).toEqual([3, 3, 3, 5])
    expect(series.cubicInterpolationMode).toBe('monotone')
    expect(state.chartOptions.plugins.legend.display).toBe(false)
  })
  it('enables readable points and scaled axes only when requested while preserving raw tooltip values', () => {
    const wrapper = shallowMount(CostLineChart, { props: { labels: ['1', '2'], series: [{ label: '输出', color: '#fff', data: [1000000, 1500000] }], showValues: true, valueDivisor: 1000000, valueSuffix: ' Token' } })
    const state = (wrapper.vm as any).$.setupState
    expect(state.chartData.datasets[0].pointRadius).toBe(3)
    expect(state.chartData.datasets[0].pointBackgroundColor).toBe('#fff')
    expect(wrapper.classes()).toContain('cost-chart--readable')
    expect(state.chartData.datasets[0].data).toEqual([1000000, 1500000])
    expect(state.chartOptions.scales.y.ticks.callback(1500000)).toBe('1.5')
    expect(state.chartOptions.scales.y.ticks.font.size).toBe(12)
    expect(state.chartOptions.scales.y.ticks.color).toBe('#a4b5ac')
    expect(state.chartOptions.scales.y.ticks.callback(0.000012)).not.toBe('0')
    expect(state.chartOptions.plugins.tooltip.callbacks.label({ parsed: { y: 1500000 }, dataset: { label: '输出' } })).toBe(' 输出: 1,500,000 Token')
    expect(state.chartOptions.plugins.tooltip.callbacks.label({ parsed: { y: 0.000012 }, dataset: { label: '参考价值' } })).toBe(' 参考价值: 0.000012 Token')
    expect(state.chartOptions.plugins.tooltip.callbacks.label({ parsed: { y: 0 }, dataset: { label: '参考价值' } })).toBe(' 参考价值: 0 Token')
    const legacy = shallowMount(CostLineChart, { props: { labels: ['1', '2'], series: [{ label: '成本', color: '#fff', data: [1, 2] }] } })
    expect((legacy.vm as any).$.setupState.chartData.datasets[0].pointRadius).toBe(0)
    expect((legacy.vm as any).$.setupState.chartOptions.scales.y.ticks.font.size).toBe(9)
    expect((legacy.vm as any).$.setupState.chartOptions.scales.y.ticks.color).toBe('#68736a')
  })
  it('does not cover a measured chart with an empty-state layer when there are no events', () => {
    const wrapper = shallowMount(CostLineChart, {
      props: {
        labels: ['12:00'],
        series: [{ label: '收入', color: '#fff', data: [1] }],
        state: 'measured',
        events: [],
      },
    })

    expect(wrapper.find('.cost-chart__state').exists()).toBe(false)
  })

  it('shows no-data instead of an empty plotting surface when every value is unavailable', () => {
    const wrapper = shallowMount(CostLineChart, {
      props: {
        labels: ['12:00'],
        series: [{ label: 'TTFT P95', color: '#fff', data: [null] }],
        state: 'measured',
      },
    })

    expect(wrapper.find('.cost-chart__state').text()).toContain('无记录')
  })
})

/**
 * 断点(null)在 tooltip 里必须是 `—`。
 *
 * 该图用 `spanGaps: false` 把缺失值画成**断点**,而 tooltip 曾把 `context.parsed.y` 走
 * `Number(y ?? 0)` ⇒ 悬停断点显示 `0`:把"该源不掌握这一档"渲染成"实测为 0",与断点语义相反。
 * 断言取 `chartOptions.plugins.tooltip.callbacks.label` 直接调用(该回调是纯函数,
 * 无需真渲染 canvas;shallowMount 已把 vue-chartjs 的 Line 打桩)。
 */
describe('CostLineChart tooltip 断点语义', () => {
  function tooltipLabel(parsedY: unknown, suffix = '') {
    const wrapper = shallowMount(CostLineChart, {
      props: {
        labels: ['12:00'],
        series: [{ label: '成本', color: '#fff', data: [parsedY as number | null] }],
        state: 'measured',
        valuePrefix: '$',
        valueSuffix: suffix,
      },
    })
    const options = (wrapper.vm as unknown as { $?: { setupState: Record<string, any> } }).$?.setupState.chartOptions
    const callback = options.plugins.tooltip.callbacks.label
    return callback({ parsed: { y: parsedY }, dataset: { label: '成本' } }) as string
  }

  it('断点(null / undefined / NaN)显示 — ,不显示 0', () => {
    for (const value of [null, undefined, Number.NaN]) {
      const text = tooltipLabel(value)
      expect(text, `parsed.y=${String(value)} 应显示 —`).toContain('—')
      expect(text, `parsed.y=${String(value)} 不得被渲染成 0`).not.toContain('0')
    }
  })

  it('成对反例:真实的 0 仍是 0(含前后缀),不能一刀切成 —', () => {
    expect(tooltipLabel(0)).toBe(' 成本: $0')
    expect(tooltipLabel(12.5, ' USD')).toBe(' 成本: $12.5 USD')
    expect(tooltipLabel(0)).not.toContain('—')
  })
})
