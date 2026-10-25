import { shallowMountWithCostI18n as shallowMount, costComponentI18n } from './costI18n'
import { describe, expect, it, vi } from 'vitest'
import CostLineChart from '../EconomicCostLineChart.vue'
import { Bar, Line } from 'vue-chartjs'

// Chart unit tests need a deterministic locale, not the application's lazy router.
vi.mock('@/i18n', async importOriginal => ({
  ...await importOriginal<typeof import('@/i18n')>(),
  getLocale: () => 'en-US',
}))

describe('Economic WebGL projection', () => {
  it('formats the drawn peak with the live locale, currency and scaled units without changing data', async () => {
    const values = [0, 1200.5678, null, 450]
    const wrapper = shallowMount(CostLineChart, { props: {
      economicLedger: true, material: 'soft-gold', labels: ['a', 'b', 'c', 'd'],
      series: [{ label: 'Billing', color: '#f4c467', data: [...values] }],
      valuePrefix: '$', valueSuffix: ' kUSD', valueDivisor: 1000,
    } })
    const state = (wrapper.vm as any).$.setupState
    const ctx = {
      save: vi.fn(), restore: vi.fn(), measureText: () => ({ width: 100 }),
      setLineDash: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
      stroke: vi.fn(), arc: vi.fn(), fill: vi.fn(), fillText: vi.fn(),
    }
    const chart = {
      ctx, data: state.chartData, chartArea: { left: 0, right: 300, top: 20, bottom: 150 },
      isDatasetVisible: () => true,
      getDatasetMeta: () => ({ data: values.map((_value, index) => ({ x: index * 70, y: 60 })) }),
      scales: { y: { getPixelForValue: () => 150 } },
    }
    costComponentI18n('en')
    state.economicSurface.afterDatasetsDraw(chart)
    expect(ctx.fillText).toHaveBeenLastCalledWith('Peak $1.2006 kUSD', expect.any(Number), expect.any(Number))
    costComponentI18n('zh')
    await wrapper.setProps({ valuePrefix: '€', valueSuffix: ' units', valueDivisor: 1 })
    state.economicSurface.afterDatasetsDraw(chart)
    expect(ctx.fillText).toHaveBeenLastCalledWith('峰值 €1,200.5678 units', expect.any(Number), expect.any(Number))
    expect(state.chartData.datasets[0].data).toEqual(values)
    expect(chart.data.datasets[0].data).toEqual(values)
  })

  it('uses monotone display interpolation for all actual economic series without changing values', () => {
    const series = [
      { label: '计费', color: '#f4c467', data: [0, 8, null, 5] },
      { label: '成本', color: '#79bdff', data: [0, 3, null, 4] },
      { label: '贡献', color: '#50d9b4', data: [0, 5, null, -1] },
    ]
    const wrapper = shallowMount(CostLineChart, { props: { material: 'soft-gold', labels: ['a', 'b', 'c', 'd'], series } })
    const state = (wrapper.vm as any).$.setupState
    for (let i = 0; i < series.length; i++) {
      expect(state.chartData.datasets[i].data).toEqual(series[i].data)
      expect(state.chartData.datasets[i].cubicInterpolationMode).toBe('monotone')
      expect(state.chartData.datasets[i].spanGaps).toBe(false)
    }
    expect(state.chartDescription).toContain('带子的宽度不表示数据多少或误差')
  })
})

describe('Economic readout hierarchy', () => {
  it('keeps different mode identities independent and restores each mode selection', async () => {
    const flow = [{ id: 'flow-billed', label: '计费', color: '#f4c467', data: [8] }]
    const unit = [{ id: 'unit-procurement-output', label: '单位成本', color: '#79bdff', data: [2] }]
    const wrapper = shallowMount(CostLineChart, { props: { economicLedger: true, labels: ['a'], series: flow } })
    const state = (wrapper.vm as any).$.setupState
    await wrapper.get('.cost-chart__keys button').trigger('click')
    expect(state.chartData.datasets[0].hidden).toBe(true)
    await wrapper.setProps({ series: unit })
    expect(state.chartData.datasets[0].hidden).toBe(false)
    await wrapper.get('.cost-chart__keys button').trigger('click')
    await wrapper.setProps({ series: [{ ...flow[0], label: 'Billing' }] })
    expect(state.chartData.datasets[0].hidden).toBe(true)
    await wrapper.get('.cost-chart__keys button').trigger('click')
    await wrapper.setProps({ series: [{ ...unit[0], label: 'Unit cost' }] })
    expect(state.chartData.datasets[0].hidden).toBe(true)
    expect(state.chartData.datasets[0].data).toEqual([2])
  })
  it('preserves hidden curves and primary selection when translated labels change', async () => {
    const series = [
      { label: '计费', color: '#f4c467', data: [0, 8] },
      { label: '成本', color: '#79bdff', data: [0, 3] },
    ]
    const wrapper = shallowMount(CostLineChart, { props: { economicLedger: true, labels: ['a', 'b'], series } })
    const state = (wrapper.vm as any).$.setupState
    await wrapper.findAll('.cost-chart__keys button')[0].trigger('click')
    await wrapper.setProps({ series: series.map((item, index) => ({ ...item, label: ['Billing', 'Cost'][index] })) })
    expect(wrapper.findAll('.cost-chart__keys button')[0].text()).toContain('Billing')
    expect(wrapper.findAll('.cost-chart__keys button')[0].attributes('aria-pressed')).toBe('false')
    expect(state.chartData.datasets.map((dataset: any) => dataset.hidden)).toEqual([true, false])
    expect(state.primarySeriesIndex).toBe(1)
    expect(state.chartData.datasets.map((dataset: any) => dataset.data)).toEqual(series.map(item => item.data))
    await wrapper.findAll('.cost-chart__keys button')[0].trigger('click')
    expect(state.chartData.datasets[0].hidden).toBe(false)
  })
  it('keeps per-series last-valid timestamps, unknowns and visible primary independent', async () => {
    const series = [
      { label: '计费', color: '#f4c467', data: [0, 8, null, 5] },
      { label: '成本', color: '#79bdff', data: [0, 3, null, null] },
      { label: '贡献', color: '#50d9b4', data: [null, null, null, null] },
    ]
    const wrapper = shallowMount(CostLineChart, { props: { economicLedger: true, material: 'soft-gold', valuePrefix: '¥', labels: ['a', 'b', 'c', 'd'], series } })
    const state = (wrapper.vm as any).$.setupState
    const keys = wrapper.findAll('.cost-chart__keys button')
    expect(keys).toHaveLength(3)
    expect(keys[0].attributes('title')).toContain('d')
    expect(keys[1].attributes('title')).toContain('b')
    expect(keys[2].text()).toContain('—')
    expect(state.chartData.datasets[0].fill).toBe(false)
    expect(state.chartData.datasets[1].fill).toBe(false)
    expect(state.chartOptions.plugins.legend.display).toBe(false)
    for (const dataset of state.chartData.datasets) { expect(dataset.tension).toBe(.3); expect(dataset.cubicInterpolationMode).toBe('monotone') }
    await keys[0].trigger('click')
    expect(keys[0].attributes('aria-pressed')).toBe('false')
    expect(state.chartData.datasets[0].hidden).toBe(true)
    expect(state.chartData.datasets[1].fill).toBe(false)
    expect(state.chartData.datasets.map((dataset: any) => dataset.data)).toEqual(series.map(item => item.data))
    await keys[0].trigger('click')
    expect(state.chartData.datasets[0].hidden).toBe(false)
  })

  it('does not turn true zero or negative values into missing readings', () => {
    const wrapper = shallowMount(CostLineChart, { props: { economicLedger: true, labels: ['a', 'b'], series: [
      { label: '零值', color: '#f4c467', data: [2, 0] },
      { label: '负值', color: '#50d9b4', data: [1, -2] },
    ] } })
    const keys = wrapper.findAll('.cost-chart__keys button')
    expect(keys[0].find('strong').text()).toBe('0')
    expect(keys[1].find('strong').text()).toContain('-2')
    expect(keys[0].attributes('title')).toContain('b')
  })
})
