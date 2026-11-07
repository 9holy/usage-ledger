import './usageI18nFixture'
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import UsagePricingCoveragePanel from '../UsagePricingCoveragePanel.vue'
import UsageCoverageAssembly from '../UsageCoverageAssembly.vue'
describe('pricing coverage panel', () => {
  it('labels coverage counts as records when the scope contains unsplit cumulative usage', () => {
    const wrapper = mount(UsagePricingCoveragePanel, { props: {
      rows: [
        { state: 'known', label: '可估算', count: 2, percent: 50, color: '#111' },
        { state: 'unknown', label: '未识别', count: 1, percent: 25, color: '#222' },
        { state: 'missing', label: '缺价格', count: 1, percent: 25, color: '#333' },
      ], total: 4, recordCounts: true, available: 50, loaded: true, period: '全部记录', reasons: [], unquoted: 2,
    } })
    const assembly = wrapper.getComponent(UsageCoverageAssembly)
    expect(assembly.text()).toContain('用量记录')
    expect(assembly.text()).not.toContain('次请求')
    expect(assembly.find('[role="img"]').attributes('aria-label')).toContain('4 条用量记录')
    wrapper.unmount()
  })
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
