import './usageI18nFixture'
import i18n from '@/i18n'
import { computed, defineComponent, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { expect, it } from 'vitest'
import UsageModeEvidence from '../UsageModeEvidence.vue'
import UsageTokenComposition from '../UsageTokenComposition.vue'

it('keeps response-confirmed mode evidence selected when its labels change language', async () => {
  const Host = defineComponent({
    components: { UsageModeEvidence },
    setup() {
      const rows = computed(() => [{ label: i18n.global.t('usageMonitor.text.responseConfirmation'), counts: { standard: 3, unknown: 1 }, segments: [{ key: 'standard', label: i18n.global.t('usageMonitor.text.standard'), count: 3, percent: 75, color: '#79bdff' }, { key: 'unknown', label: i18n.global.t('usageMonitor.text.notReported'), count: 1, percent: 25, color: '#a4afbd' }] }])
      return { rows }
    },
    template: '<UsageModeEvidence :rows="rows" :total="4" />',
  })
  const wrapper = mount(Host)
  expect(wrapper.get('.evidence-hero strong').text()).toBe('3')
  i18n.global.locale.value = 'en'; await nextTick()
  expect(wrapper.get('.evidence-hero strong').text()).toBe('3')
  expect(wrapper.get('.is-confirmed h3').text()).toBe('Response confirmation')
  expect(wrapper.get('.evidence-hero').text()).toContain('75.0%')
  expect(wrapper.get('h2').text()).toBe('Billing-mode records')
  i18n.global.locale.value = 'zh'; await nextTick()
  expect(wrapper.get('.is-confirmed h3').text()).toBe('响应确认')
  wrapper.unmount()
})

it('keeps the product titles and four mode counts in the selected design’s ordered readout grid', () => {
  const keys = ['standard', 'fast', 'priority', 'unknown']
  const counts = { standard: 2118, fast: 0, priority: 0, unknown: 330 }
  const wrapper = mount(UsageModeEvidence, {
    props: {
      total: 2448,
      rows: [
        {
          label: '请求设置',
          counts,
          segments: keys.map((key) => ({
            key,
            label: key,
            count: counts[key as keyof typeof counts],
            percent: (counts[key as keyof typeof counts] / 2448) * 100,
            color: '#79bdff',
          })),
        },
      ],
    },
  })
  expect(wrapper.get('h2').text()).toBe('计费模式记录')
  const cells = wrapper.findAll('.evidence-cell')
  expect(cells.map((cell) => cell.attributes('data-count'))).toEqual([
    '2118',
    '0',
    '0',
    '330',
  ])
  expect(wrapper.get('.evidence-values').attributes('style')).toContain(
    '--modes: 4',
  )
  expect(cells.map((cell) => cell.attributes('data-state'))).toEqual(keys)
  expect(cells.map((cell) => Number(cell.attributes('data-percent')))).toEqual([
    (2118 / 2448) * 100,
    0,
    0,
    (330 / 2448) * 100,
  ])
  expect(wrapper.findAll('.readout-leaders')).toHaveLength(0)
  const token = mount(UsageTokenComposition, {
    props: { inputTokens: 100, cacheReadTokens: 98, outputTokens: 1 },
  })
  expect(token.get('h2').text()).toBe('这些 Token 用在哪里')
})
