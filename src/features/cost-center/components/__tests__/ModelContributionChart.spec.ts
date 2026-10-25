import { mountWithCostI18n as mount } from './costI18n'
import { describe, expect, it, vi } from 'vitest'
import ModelContributionChart from '../ModelContributionChart.vue'
import type { ModelCostRow } from '../../modelCostAnalysis'
vi.mock('@/i18n', async importOriginal => ({
  ...await importOriginal<typeof import('@/i18n')>(),
  getLocale: () => 'en-US',
}))
function row(model: string, accountCost: number | null, revenue: number | null = null, grossProfit: number | null = null): ModelCostRow {
  return { model, accountCost, revenue, revenueMissing: revenue == null, grossProfit } as ModelCostRow
}
const rings = (rows: ModelCostRow[]) => mount(ModelContributionChart, { props: { rows, state: 'measured' } })
describe('ModelContributionChart double rings', () => {
  it('keeps 230px height/top 8 and sorts unknown after measured zero', () => {
    const wrapper = rings([row('unknown', null), row('zero', 0), row('largest', 5)])
    expect(wrapper.attributes('style')).toContain('height: 230px')
    expect(wrapper.findAll('.model-heading strong').map(el => el.text())).toEqual(['largest', 'zero', 'unknown'])
    expect(wrapper.findAll('[data-value="accountCost"]').map(el => el.text())).toEqual(['$5.00', '$0.00', '—'])
    expect(rings(Array.from({ length: 12 }, (_, i) => row(`m${i}`, i))).findAll('.model-card')).toHaveLength(8)
    expect(wrapper.find('canvas').exists()).toBe(false)
  })
  it('never invents a delta or composition and preserves negative stored delta', () => {
    const wrapper = rings([row('missingDelta', 3, 8), row('negative', 7, 2, -5), row('missingCost', null, 1, 1)])
    const rows = wrapper.findAll('.model-card')
    expect(rows[0].find('[data-value="grossProfit"]').text()).toBe('—')
    expect(rows[0].find('[data-mark="difference"]').exists()).toBe(false)
    expect(rows[1].find('[data-mark="difference"]').exists()).toBe(false)
    expect(rows[1].find('[data-value="grossProfit"]').classes()).toContain('value-negative')
    expect(rows[1].find('[data-value="grossProfit"]').text()).toBe('−$5.00')
    expect(rows[2].find('[data-mark="difference"]').exists()).toBe(false)
  })
  it('independently toggles marks and numerals without rescaling or confusing hidden with unknown', async () => {
    const wrapper = rings([row('a', 3, 8, 5)])
    const costArc = wrapper.find('[data-mark="cost"]').attributes('stroke-dasharray')
    const originalBillingArc = wrapper.find('[data-mark="billing"]').attributes('stroke-dasharray')
    const billing = wrapper.get('button[aria-label="显示用户计费"]')
    await billing.trigger('click')
    expect(billing.attributes('aria-pressed')).toBe('false')
    expect(wrapper.find('[data-mark="billing"]').exists()).toBe(false)
    expect(wrapper.get('[data-value="revenue"]').text()).toBe('已隐藏')
    expect(wrapper.get('[data-mark="cost"]').attributes('stroke-dasharray')).toBe(costArc)
    expect(wrapper.find('[data-mark="difference"]').exists()).toBe(true)
    await wrapper.get('button[aria-label="显示计费差额"]').trigger('click')
    expect(wrapper.find('[data-mark="difference"]').exists()).toBe(false)
    await wrapper.get('button[aria-label="显示上游成本"]').trigger('click')
    expect(wrapper.find('[data-mark="cost"]').exists()).toBe(false)
    await billing.trigger('click')
    expect(wrapper.get('[data-value="revenue"]').text()).toBe('$8.00')
    expect(wrapper.get('[data-mark="billing"]').attributes('stroke-dasharray')).toBe(originalBillingArc)
  })
  it('shows all three full precision values on focus/hover, including hidden values, and dismisses', async () => {
    const wrapper = rings([row('a', 3.123456, 8.765432, 4.222222)])
    await wrapper.get('button[aria-label="显示计费差额"]').trigger('click')
    await wrapper.get('.model-card').trigger('focus')
    expect(wrapper.get('[role="tooltip"]').text()).toContain('$3.123456')
    expect(wrapper.get('[role="tooltip"]').text()).toContain('$8.765432')
    expect(wrapper.get('[role="tooltip"]').text()).toContain('$4.222222')
    expect(wrapper.get('[role="tooltip"]').text()).toContain('不代表经营利润')
    await wrapper.get('.model-card').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(false)
    await wrapper.get('.model-card').trigger('mouseenter')
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(true)
    await wrapper.get('.model-card').trigger('mouseleave')
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(false)
  })
  it('does not present a synthetic numeric scale when all endpoints are unknown', () => {
    const wrapper = rings([row('unknown', null)])
    expect(wrapper.get('.ring-caption').text()).toContain('统一上限 —')
    expect(wrapper.findAll('[data-mark]')).toHaveLength(0)
    expect(wrapper.findAll('[data-value]').map(el => el.text())).toEqual(['—', '—', '—'])
  })
  it('uses a common billing maximum and source cost/difference composition', () => {
    const wrapper = rings([row('max', 6, 10, 4), row('half', 3, 5, 2), row('zero', 0, 0, 0), row('negative', 2, -1, -3)])
    const cards = wrapper.findAll('.model-card')
    expect(cards[0].get('[data-mark="billing"]').attributes('stroke-dasharray')).toBe('100 0')
    expect(cards[1].get('[data-mark="billing"]').attributes('stroke-dasharray')).toBe('50 50')
    expect(cards[0].get('[data-mark="cost"]').attributes('stroke-dasharray')).toBe('60 40')
    expect(cards[0].get('[data-mark="difference"]').attributes('stroke-dasharray')).toBe('40 60')
    expect(cards[0].get('[data-mark="difference"]').attributes('stroke-dashoffset')).toBe('-60')
    expect(cards[0].get('[data-mark="cost"]').attributes('transform')).toBe('translate(140 0) scale(-1 1) rotate(-90 70 70)')
    expect(cards[0].get('[data-mark="difference"]').attributes('transform')).toBe('translate(140 0) scale(-1 1) rotate(-90 70 70)')
    expect(cards[2].get('[data-value="revenue"]').text()).toBe('$0.00')
    expect(cards[2].findAll('[data-mark]')).toHaveLength(0)
    expect(cards[3].get('[data-value="revenue"]').text()).toBe('−$1.00')
    expect(cards[3].findAll('[data-mark]')).toHaveLength(0)
  })
  it('does not show misleading composition for inconsistent source amounts', async () => {
    const wrapper = rings([row('mismatch', 3, 8, 2)])
    expect(wrapper.find('[data-mark="billing"]').exists()).toBe(true)
    expect(wrapper.find('[data-mark="cost"]').exists()).toBe(false)
    expect(wrapper.find('[data-mark="difference"]').exists()).toBe(false)
    expect(wrapper.get('[data-value="grossProfit"]').text()).toBe('$2.00')
    await wrapper.get('.model-card').trigger('focus')
    expect(wrapper.get('[role="tooltip"]').text()).toContain('金额构成不一致')
  })
  it('retains loading/unavailable/empty states without fabricating rows', () => {
    for (const state of ['loading', 'unavailable', 'empty'] as const) {
      const wrapper = mount(ModelContributionChart, { props: { rows: [row('a', 1, 2, 1)], state, stateReason: 'source reason' } })
      expect(wrapper.find('.model-card').exists()).toBe(false)
      expect(wrapper.text()).toContain('source reason')
    }
  })
})
