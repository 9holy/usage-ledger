import './usageI18nFixture'
import i18n from '@/i18n'
import { mount } from '@vue/test-utils'
import { it, expect } from 'vitest'
import UsageValueChart from '../UsageValueChart.vue'
const forecast = {
  currency: 'USD',
  method: 'week_average' as const,
  projectedAmount: null,
  projectedSubtotal: 70,
  observedSubtotal: 50,
  additionalSubtotal: 20,
  pricedRequests: 1,
  unpricedRequests: 0,
  coverage: 'observed_records_only' as const,
  reason: 'fixture',
  comparisons: [],
}
it('colors the capsule by observed and future value, never quota', async () => {
  const w = mount(UsageValueChart, { props: { forecast } })
  expect(w.get('.observed-fill').attributes('style')).toContain('71.428571')
  expect(
    w.findAll('[data-value]').map((e) => e.attributes('data-value')),
  ).toEqual(['50', '20', '70'])
  expect(w.get('[role=img]').attributes('aria-label')).toContain('预计增加 $20')
  expect(w.text()).toContain('与右侧账号剩余额度分别统计')
  await w.setProps({
    forecast: {
      ...forecast,
      additionalSubtotal: null,
      projectedSubtotal: null,
    },
  })
  expect(w.find('.value-capsule').exists()).toBe(false)
  expect(w.text()).toContain('尚未取得完整')
})
it('keeps precise value tooltip and small positive currency label', () => {
  const w = mount(UsageValueChart, {
    props: {
      forecast: {
        ...forecast,
        projectedSubtotal: 0.244968,
        observedSubtotal: 0.144968,
        additionalSubtotal: 0.1,
      },
    },
  })
  expect(w.get('[role=img]').attributes('aria-label')).toContain('$0.145')
  expect(w.get('[data-value="0.144968"]').attributes('title')).toContain(
    '0.144968',
  )
})

it('shows account quota amounts and proportions without global trend wording', async () => {
  const w = mount(UsageValueChart, {
    props: {
      forecast: {
        currency: 'USD',
        observedSubtotal: 0.144968,
        additionalSubtotal: 1.667132,
        projectedSubtotal: 1.8121,
      },
      quota: { accountLabel: 'Account 2', usedPercent: 8 },
    },
  })
  expect(w.get('.observed-fill').attributes('style')).toBe('width: 8%;')
  expect(w.get('.forecast-fill').attributes('style')).toBe('width: 92%;')
  expect(
    w.findAll('[data-value]').map((e) => e.attributes('data-value')),
  ).toEqual(['0.144968', '1.667132', '1.8121'])
  expect(w.findAll('dt').map((e) => e.text())).toEqual([
    '本轮已用',
    '剩余额度推算',
    '本周额度总额',
  ])
  expect(w.get('.value-bridge-heading').text()).toContain(
    'Account 2 · 周额度金额推算',
  )
  expect(w.get('figure').attributes('aria-label')).toBe(
    'Account 2，本轮已用 8%，周额度用满100%的金额推算',
  )
  expect(w.get('[role=img]').attributes('aria-label')).toBe(
    'Account 2本轮已用 8%，已用金额 $0.145，剩余额度推算 $1.667，本周额度100%总额 $1.812',
  )
  expect(w.find('.capsule-explanation').exists()).toBe(false)
  expect(w.get('.capsule-scale').text()).toContain('100%')
  expect(w.get('figcaption').text()).toBe(
    '按已记录计价用量等比例推算，假设模型与缓存结构不变，不是未来支出预测。',
  )
  expect(w.text()).not.toContain('标准价')
  expect(w.text()).not.toContain('不是账号额度')
  expect(w.get('[role=img]').attributes('aria-label')).not.toContain('预计增加')
  expect(w.findAll('[data-value]').map((e) => e.attributes('title'))).toEqual([
    '美元 $0.144968',
    '美元 $1.667132',
    '美元 $1.812100',
  ])

  await w.setProps({
    forecast: {
      currency: 'USD',
      observedSubtotal: 0.144968,
      additionalSubtotal: null,
      projectedSubtotal: null,
    },
  })
  expect(w.find('.value-capsule').exists()).toBe(false)
  expect(w.get('.value-capsule-empty').text()).toBe(
    '尚未取得完整的账号额度推算数据',
  )
  expect(w.text()).not.toContain('标准价')
})

it('keeps the liquid boundary, scale, percentages and monetary leaders on the same live ratio', async () => {
  const w = mount(UsageValueChart, {
    props: {
      forecast: {
        currency: 'USD',
        observedSubtotal: 8,
        additionalSubtotal: 92,
        projectedSubtotal: 100,
      },
      quota: { accountLabel: 'A', usedPercent: 8 },
    },
  })
  expect(w.get('.capsule-scale-pointer').attributes('data-percent')).toBe('8')
  expect(w.find('.capsule-live-label').exists()).toBe(false)
  expect(w.find('.capsule-share').exists()).toBe(false)
  expect(w.get('.value-capsule-readouts').text()).not.toContain('%')
  expect(w.findAll('.capsule-pins circle')[0].attributes('cx')).toBe('126')
  await w.setProps({
    forecast: {
      currency: 'USD',
      observedSubtotal: 60,
      additionalSubtotal: 40,
      projectedSubtotal: 100,
    },
    quota: { accountLabel: 'A', usedPercent: 60 },
  })
  expect(w.get('.observed-fill').attributes('style')).toBe('width: 60%;')
  expect(w.get('.capsule-divider').attributes('style')).toContain('left: 49%')
  expect(w.get('.capsule-scale-pointer').text()).toContain('60.0%')
  expect(w.findAll('.capsule-pins circle')[1].attributes('cx')).toBe('620')
  expect(w.findAll('.capsule-pins circle')[0].attributes('cx')).toBe('295')
  expect(w.findAll('.capsule-links path')[0].attributes('d')).toContain(
    'M 295 0',
  )
})

it('labels every partial account amount as a priced portion in both languages without changing chart geometry', async () => {
  const w = mount(UsageValueChart, {
    props: {
      forecast: { currency: 'USD', observedSubtotal: 10, additionalSubtotal: 40, projectedSubtotal: 50 },
      quota: { accountLabel: 'Account 2', usedPercent: 20 }, partial: true,
    },
  })
  expect(w.get('.value-bridge-heading').text()).toContain('已计价部分推算')
  expect(w.findAll('dt').map(row => row.text())).toEqual(['本轮已计价', '剩余已计价部分推算', '100%额度已计价部分'])
  expect(w.get('figure').attributes('aria-label')).toContain('已计价部分推算')
  expect(w.get('[role=img]').attributes('aria-label')).toContain('100%额度已计价部分推算 $50')
  expect(w.text()).not.toContain('本周额度总额')
  const boundary = w.get('.capsule-divider').attributes('style')
  i18n.global.locale.value = 'en'
  await w.vm.$nextTick()
  expect(w.get('.value-bridge-heading').text()).toContain('Priced-portion projection')
  expect(w.findAll('dt').map(row => row.text())).toEqual(['Priced this cycle', 'Remaining priced portion', 'Priced portion at 100%'])
  expect(w.get('[role=img]').attributes('aria-label')).toContain('unidentified or unpriced usage excluded')
  expect(w.get('.capsule-divider').attributes('style')).toBe(boundary)
  expect(w.get('.observed-fill').attributes('style')).toBe('width: 20%;')
  expect(w.findAll('[data-value]').map(row => row.attributes('data-value'))).toEqual(['10', '40', '50'])
})

it('does not invent a minimum liquid segment at zero, full or very small shares', async () => {
  const w = mount(UsageValueChart, {
    props: {
      forecast: {
        currency: 'USD',
        observedSubtotal: 0,
        additionalSubtotal: 100,
        projectedSubtotal: 100,
      },
      quota: { accountLabel: 'A', usedPercent: 0 },
    },
  })
  expect(w.get('.observed-fill').attributes('style')).toBe('width: 0%;')
  expect(w.find('.capsule-divider').exists()).toBe(false)
  await w.setProps({
    forecast: {
      currency: 'USD',
      observedSubtotal: 0.03,
      additionalSubtotal: 99.97,
      projectedSubtotal: 100,
    },
    quota: { accountLabel: 'A', usedPercent: 0.03 },
  })
  expect(w.get('.observed-fill').attributes('style')).toBe('width: 0.03%;')
  expect(w.get('.capsule-scale-pointer').text()).toContain('<0.1%')
  await w.setProps({
    forecast: {
      currency: 'USD',
      observedSubtotal: 100,
      additionalSubtotal: 0,
      projectedSubtotal: 100,
    },
    quota: { accountLabel: 'A', usedPercent: 100 },
  })
  expect(w.get('.forecast-fill').attributes('style')).toBe('width: 0%;')
  expect(w.find('.capsule-divider').exists()).toBe(false)
  expect(w.get('.capsule-scale-pointer').text()).toContain('100.0%')
})
