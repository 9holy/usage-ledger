import { mountWithCostI18n as mount } from './costI18n'
import { describe, expect, it, vi } from 'vitest'
import DataGovernancePanel from '../DataGovernancePanel.vue'
import { createDataSourceStates, sourceState, COST_CENTER_SOURCE_KEYS } from '../../dataState'

const push = vi.fn()
vi.mock('vue-router', () => ({ useRouter: () => ({ push }) }))

describe('DataGovernancePanel', () => {
  it('summarizes every source state and explains retention semantics', async () => {
    const states = createDataSourceStates('measured')
    states.dashboard = sourceState('dashboard', 'unavailable', 'usage_logs 读取失败')
    states.economics = sourceState('economics', 'partial', '样本不足')
    states.accountUsage = sourceState('accountUsage', 'empty', '窗口内无记录')

    const wrapper = mount(DataGovernancePanel, {
      props: { sourceKind: 'sub2api', states, lastUpdated: '2026-08-11 10:00:00' },
    })

    // 每一条源状态都要有一张卡片。用键数而不是魔数:新增源(如 2026-09-17 的 rangeStats)
    // 时不会因为忘记改数字而假绿,同时"面板漏渲染某个源"仍会被抓到。
    expect(wrapper.findAll('.source-card')).toHaveLength(COST_CENTER_SOURCE_KEYS.length)
    expect(wrapper.text()).toContain('usage_logs 读取失败')
    expect(wrapper.text()).toContain('本机时间零点')
    expect(wrapper.text()).toContain('90 天')
    expect(wrapper.text()).toContain('封禁损失记录不会自动清空')

    await wrapper.get('.governance__actions button').trigger('click')
    expect(push).toHaveBeenCalledWith('/admin/usage')
  })
})

/**
 * 三源口径回归锁(2026-09-16):只有 sub2api 有 usage_logs 这张表。
 * cockpit 是本机单请求用量库,cliproxy 是 CPA usage_events —— 两者都不读 usage_logs,
 * 也不该出现「打开 usage_logs 历史与清理任务」这种指向别源数据的入口。
 */
describe('DataGovernancePanel 三源口径', () => {
  function render(sourceKind: 'sub2api' | 'cliproxy' | 'cockpit') {
    return mount(DataGovernancePanel, {
      props: { sourceKind, states: createDataSourceStates('measured') },
    })
  }

  it('cockpit:不提 usage_logs,历史入口指向本机用量库且不再跳 /admin/usage', async () => {
    push.mockClear()
    const wrapper = render('cockpit')
    expect(wrapper.text()).not.toContain('usage_logs')
    expect(wrapper.text()).toContain('cockpit 本地用量库')
    expect(wrapper.find('.governance__actions button').exists()).toBe(false)
    expect(push).not.toHaveBeenCalled()
  })

  it('cliproxy:不提 usage_logs,历史入口改为说明 CPA usage_events', async () => {
    push.mockClear()
    const wrapper = render('cliproxy')
    expect(wrapper.text()).not.toContain('usage_logs')
    expect(wrapper.text()).toContain('CPA usage_events')
    expect(wrapper.find('.governance__actions button').exists()).toBe(false)
    expect(push).not.toHaveBeenCalled()
  })

  it('sub2api 仍是唯一保留 usage_logs 措辞与清理入口的源', () => {
    const wrapper = render('sub2api')
    expect(wrapper.text()).toContain('查看和清理用量历史')
    expect(wrapper.find('.governance__actions button').exists()).toBe(true)
  })
})
