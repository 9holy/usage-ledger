import './usageI18nFixture'
import i18n from '@/i18n'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { expect, it } from 'vitest'
import UsageRequestPulse from '../UsageRequestPulse.vue'
import UsagePriceFlow from '../UsagePriceFlow.vue'
import UsageTokenComposition from '../UsageTokenComposition.vue'
import { usageColors, usageIntensityColors } from '../usageChartPalette'
import type { MonitorRequest, PriceEvidence } from '@/api/usageMonitor'

it('switches infographic labels and compact units without changing raw models, counts or tariffs', async () => {
  const input = 800000000
  const tokens = mount(UsageTokenComposition, { props: { inputTokens: input, cacheReadTokens: 600000000, outputTokens: 200000000 } })
  const requests = [{ id: '请求原始ID', model: '模型原名 Alpha', timestampMs: 1000, outputTokens: 20000, unknownFields: [] }] as MonitorRequest[]
  const pulse = mount(UsageRequestPulse, { props: { requests, selected: '请求原始ID' } })
  const evidence = { currency: 'CNY', inputPerMillion: 4, cachedPerMillion: 0.000001, outputPerMillion: 20 } as PriceEvidence
  const prices = mount(UsagePriceFlow, { props: { evidence } })
  const priceValues = prices.findAll('.tariff-ribbon').map(row => row.attributes('data-price'))
  i18n.global.locale.value = 'en'; await nextTick()
  expect(tokens.get('h2').text()).toBe('Where tokens are used')
  expect(tokens.text()).not.toMatch(/万|亿/)
  expect(tokens.props('inputTokens')).toBe(input)
  expect(pulse.text()).toContain('Output per request')
  expect(pulse.get('.pulse-grid button').attributes('aria-label')).toContain('模型原名 Alpha')
  await pulse.get('.pulse-grid button').trigger('click')
  expect(pulse.emitted('select')?.[0][0]).toBe('请求原始ID')
  expect(prices.text()).toContain('CNY / million tokens')
  expect(prices.text()).toContain('0.000001')
  expect(prices.findAll('.tariff-ribbon').map(row => row.attributes('data-price'))).toEqual(priceValues)
  i18n.global.locale.value = 'zh'; await nextTick()
  expect(tokens.get('h2').text()).toBe('这些 Token 用在哪里')
  expect(prices.text()).toContain('元 / 百万 Token')
  tokens.unmount(); pulse.unmount(); prices.unmount()
})

it('keeps the request pulse proportional and selectable, with zero distinct from missing output', async () => {
  const requests = [20, 10, 0, 999].map((outputTokens, index) => ({ id: `r${index}`, model: 'gpt-6.1-sol', timestampMs: 1000 + index, outputTokens, unknownFields: index === 3 ? ['output_tokens'] : [] }) as MonitorRequest)
  const wrapper = mount(UsageRequestPulse, { props: { requests, selected: 'r1' } })
  expect(wrapper.findAll('.pulse-column i').map(row => row.attributes('style'))).toEqual(['height: 100%;', 'height: 50%;', 'height: 0%;'])
  expect(wrapper.get('.unknown').text()).toContain('?')
  expect(wrapper.get('header').text()).toContain('已记录 30 输出 Token')
  expect((wrapper.findAll('.pulse-grid button')[0].element as HTMLElement).style.getPropertyValue('--pulse-color')).toBe(usageIntensityColors[2])
  expect((wrapper.findAll('.pulse-grid button')[1].element as HTMLElement).style.getPropertyValue('--pulse-color')).toBe(usageIntensityColors[1])
  expect((wrapper.findAll('.pulse-grid button')[2].element as HTMLElement).style.getPropertyValue('--pulse-color')).toBe(usageIntensityColors[0])
  expect(wrapper.findAll('.pulse-grid .peak')).toHaveLength(1)
  expect(wrapper.get('.pulse-grid .peak').attributes('aria-label')).toContain('20 输出 Token')
  await wrapper.get('.is-selected').trigger('click')
  expect(wrapper.emitted('select')?.[0][0]).toBe('r1')
  await wrapper.setProps({ requests: [requests[2]] })
  expect(wrapper.get('header').text()).toContain('最高 0 Token')
  expect(wrapper.find('.peak').exists()).toBe(false)
  await wrapper.setProps({ requests: [requests[3]] })
  expect(wrapper.get('header').text()).toContain('输出数量尚未取得')
  expect(wrapper.get('header').text()).not.toContain('已记录 0')
})

it('compares tariffs in their original currency and retains tiny and missing cache prices', async () => {
  const evidence = { model: 'fixture', currency: 'CNY', inputPerMillion: 4, cachedPerMillion: 0.000001, outputPerMillion: 20 } as PriceEvidence
  const wrapper = mount(UsagePriceFlow, { props: { evidence } })
  expect(wrapper.text()).toContain('元 / 百万 Token')
  expect(wrapper.text()).toContain('0.000001')
  expect(wrapper.findAll('.tariff-ribbon').map(row => Number(row.attributes('data-price')))).toEqual([4, .000001, 20])
  expect(wrapper.text()).toContain('末端越高，单价越贵')
  expect(wrapper.findAll('.tariff-strand')).toHaveLength(108)
  expect(wrapper.findAll('.tariff-strand').every(row => row.attributes('transform') == null)).toBe(true)
  await wrapper.setProps({ evidence: { ...evidence, cachedPerMillion: null } })
  expect(wrapper.findAll('.tariff-ribbon')).toHaveLength(2)
  expect(wrapper.text()).toContain('单价未提供')
  expect((wrapper.findAll('.tariff-values>div')[1].element as HTMLElement).style.getPropertyValue('--tariff-color')).toBe(usageColors.unknown)
  await wrapper.setProps({ evidence: { ...evidence, cachedPerMillion: 0, currency: 'UNKNOWN' } })
  expect(wrapper.findAll('.tariff-ribbon')).toHaveLength(2)
  expect(wrapper.text()).toContain('该项单价为 0')
  expect(wrapper.text()).toContain('币种未确认 / 百万 Token')
})

it('places flow endpoints on one linear price scale and separates equal-price labels', async () => {
  const evidence = { currency: 'USD', inputPerMillion: 2, cachedPerMillion: .1, outputPerMillion: 10 } as PriceEvidence
  const wrapper = mount(UsagePriceFlow, { props: { evidence } })
  const points = () => wrapper.findAll('.tariff-price-point').map(point => ({ value: Number(point.attributes('data-price')), y: Number(point.attributes('cy')) }))
  expect(points()).toEqual([{ value: 2, y: 187.2 }, { value: .1, y: 225.96 }, { value: 10, y: 24 }])
  expect(wrapper.findAll('.tariff-end-value').map(row => row.text())).toEqual(['2', '0.1', '10'])
  expect(wrapper.get('.tariff-price-axis').text()).toContain('10')
  await wrapper.setProps({ evidence: { ...evidence, inputPerMillion: 10, cachedPerMillion: 10 } })
  expect(points().every(point => point.y === 24)).toBe(true)
  expect(new Set(wrapper.findAll('.tariff-price-point').map(point => point.attributes('cx'))).size).toBe(3)
  const labels = wrapper.findAll('.tariff-end-label').map(row => row.attributes('transform'))
  expect(new Set(labels).size).toBe(3)
  await wrapper.setProps({ evidence: { ...evidence, cachedPerMillion: null } })
  expect(points()).toHaveLength(2)
  expect(wrapper.findAll('.tariff-end-value')[1].text()).toBe('单价未提供')
})


it('uses the same input, cache and output colors for token flow and unit prices', () => {
  const flow = mount(UsageTokenComposition, { props: { inputTokens: 800, cacheReadTokens: 600, outputTokens: 200 } })
  const prices = mount(UsagePriceFlow, { props: { evidence: { inputPerMillion: 10, cachedPerMillion: 1, outputPerMillion: 50 } as PriceEvidence } })
  const colors = [usageColors.input, usageColors.cache, usageColors.output]
  expect(flow.findAll('.token-parts>div').map(column => (column.element as HTMLElement).style.getPropertyValue('--tone'))).toEqual(colors)
  expect(prices.findAll('.tariff-values>div').map(column => (column.element as HTMLElement).style.getPropertyValue('--tariff-color'))).toEqual(colors)
})


