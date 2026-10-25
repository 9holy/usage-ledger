import './usageI18nFixture'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import UsagePricingCoveragePanel from '../UsagePricingCoveragePanel.vue'
import UsageCoverageAssembly from '../UsageCoverageAssembly.vue'
describe('pricing coverage panel', () => {
  it('keeps current eligibility separate from historical reasons and preserves filters', async () => {
    const wrapper = mount(UsagePricingCoveragePanel, {
      props: {
        rows: [],
        total: 727,
        available: (441 / 727) * 100,
        loaded: true,
        period: '今日 · 全部工具',
        unquoted: 286,
        reasons: [
          {
            key: 'actual_mode_unknown',
            label: '实际计费模式未报告',
            count: 725,
          },
          {
            key: 'unknown_catalog_model',
            label: '价格目录中未找到该模型',
            count: 2,
          },
        ],
      },
    })
    expect(wrapper.getComponent(UsageCoverageAssembly).props('total')).toBe(727)
    expect(
      wrapper.getComponent(UsageCoverageAssembly).props('available'),
    ).toBeCloseTo(60.6602476)
    expect(wrapper.text()).toContain('当前是否可估算，以现有计价依据为准')
    await wrapper.findAll('.coverage-reason-row button')[1].trigger('click')
    expect(wrapper.emitted('reason')).toEqual([['unknown_catalog_model']])
    await wrapper.get('.coverage-action').trigger('click')
    expect(wrapper.emitted('unquoted')).toHaveLength(1)
    await wrapper.setProps({
      loaded: false,
      reasons: [],
      total: undefined,
      available: null,
      unquoted: 0,
    })
    expect(wrapper.text()).toContain('期间统计尚未读取')
    expect(wrapper.find('.coverage-action').exists()).toBe(false)
  })
})
