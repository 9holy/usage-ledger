import { mountWithCostI18n as mount } from './costI18n'
import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import type { Account } from '@/types'
import CostProfileInspector from '../CostProfileInspector.vue'

const JOINED_AT = '2026-08-01T00:00:00.000Z'

type SourceKind = 'sub2api' | 'cliproxy' | 'cockpit'

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: 1,
    name: 'upstream',
    platform: 'openai',
    type: 'apikey',
    credentials: {},
    extra: {},
    proxy_id: null,
    concurrency: 1,
    priority: 1,
    status: 'active',
    error_message: null,
    last_used_at: null,
    expires_at: null,
    auto_pause_on_expired: false,
    created_at: JOINED_AT,
    updated_at: JOINED_AT,
    schedulable: true,
    rate_limited_at: null,
    rate_limit_reset_at: null,
    overload_until: null,
    temp_unschedulable_until: null,
    temp_unschedulable_reason: null,
    session_window_start: null,
    session_window_end: null,
    session_window_status: null,
    ...overrides,
  } as Account
}

function mountInspector(account: Account, sourceKind: SourceKind = 'sub2api') {
  return mount(CostProfileInspector, {
    props: {
      sourceKind,
      account,
      saving: false,
      now: new Date('2026-08-06T12:00:00.000Z'),
    },
  })
}

describe('CostProfileInspector billing modes', () => {
  it('focuses the close control on open and restores the trigger on close', async () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    const wrapper = mount(CostProfileInspector, { attachTo: document.body, props: { sourceKind: 'sub2api', account: makeAccount(), saving: false, now: new Date() } })
    await nextTick()
    expect(document.activeElement).toBe(wrapper.get('[aria-label="关闭成本配置"]').element)
    await wrapper.setProps({ account: null })
    expect(document.activeElement).toBe(trigger)
    wrapper.unmount()
    trigger.remove()
  })
  it('shows official DeepSeek API keys as automatic metered billing', () => {
    const wrapper = mountInspector(makeAccount({
      name: 'deepseek',
      credentials: { base_url: 'https://api.deepseek.com/v1' },
    }))

    expect(wrapper.text()).toContain('按 API 用量估值')
    expect(wrapper.text()).toContain('DeepSeek 官方')
    expect(wrapper.text()).toContain('无需填写购买账号的费用')
    expect(wrapper.text()).toContain('输入 Token + 缓存命中 + 输出 Token')
    expect(wrapper.find('#cost-amount').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('应用美国官方默认价')
    expect(wrapper.text()).not.toContain('保存成本设置')
  })

  it('keeps subscription procurement fields for OAuth accounts', () => {
    const wrapper = mountInspector(makeAccount({
      name: 'codex',
      type: 'oauth',
      extra: { plan_type: 'plus' },
    }))

    expect(wrapper.text()).toContain('账号费用设置')
    expect(wrapper.text()).toContain('应用美国官方默认价')
    expect(wrapper.find('#cost-amount').exists()).toBe(true)
    expect(wrapper.text()).toContain('保存成本设置')
  })

  it('labels relays as channel-priced and only reveals optional fixed overhead on demand', async () => {
    const wrapper = mountInspector(makeAccount({
      name: 'relay',
      type: 'upstream',
      credentials: { base_url: 'https://relay.example.com/v1' },
    }))

    expect(wrapper.text()).toContain('上游 API')
    expect(wrapper.text()).toContain('渠道自定义价格')
    expect(wrapper.find('#cost-amount').exists()).toBe(false)

    await wrapper.get('[data-testid="enable-fixed-overhead"]').trigger('click')
    expect(wrapper.find('#cost-amount').exists()).toBe(true)
    expect(wrapper.text()).toContain('保存固定附加成本')
  })
})

/**
 * 三源口径(2026-09-16 收口轮)。上一轮 cliproxyWordingContract.spec.ts 把扫描范围扩到
 * components/*.vue 后命中了本文件,但当时不在授权范围内,只留了三条「已确认缺陷」豁免。
 * 这里补上渲染层断言:按量文案必须与真实数据来源一致 ——
 * sub2api 读 usage_logs 且价格分渠道价 / 官方目录;cliproxy 读 CPA usage_events、只认 LiteLLM 单价;
 * cockpit 读本机用量库、只认本地价目表。后两者都**没有**渠道价与账号费率层。
 */
describe('CostProfileInspector 按量文案按源分支', () => {
  const meteredApiKey = () => makeAccount({ name: 'metered', type: 'apikey', credentials: {} })

  it('sub2api:流程条走 usage_logs,并保留账号倍率这一步', () => {
    const text = mountInspector(meteredApiKey(), 'sub2api').text()

    expect(text).toContain('usage_logs')
    expect(text).toContain('官方模型价格目录')
    expect(text).toContain('账号倍率')
    expect(text).toContain('账号成本倍率')
    expect(text).toContain('×1.0000')
    expect(text).not.toContain('LiteLLM 单价')
    expect(text).not.toContain('本地价目表')
  })

  it('cliproxy:只说 CPA usage_events × LiteLLM 单价,不出现 usage_logs / 渠道价 / 账号倍率', () => {
    const text = mountInspector(meteredApiKey(), 'cliproxy').text()

    expect(text).toContain('CPA usage_events')
    expect(text).toContain('LiteLLM 单价')
    expect(text).toContain('未提供账号费率')
    expect(text).not.toContain('usage_logs')
    expect(text).not.toContain('渠道自定义价格')
    expect(text).not.toContain('未配置渠道价')
    expect(text).not.toContain('官方模型价格目录')
    expect(text).not.toContain('账号倍率')
    expect(text).not.toContain('×1.0000')
    expect(text).not.toContain('本地价目表')
  })

  it('cockpit:只说本机用量库 × 本地价目表自算,不出现 usage_logs / 渠道价 / 账号倍率', () => {
    const text = mountInspector(meteredApiKey(), 'cockpit').text()

    expect(text).toContain('cockpit 本地用量库')
    expect(text).toContain('本地价目表')
    expect(text).toContain('未提供账号费率')
    expect(text).not.toContain('usage_logs')
    expect(text).not.toContain('渠道自定义价格')
    expect(text).not.toContain('未配置渠道价')
    expect(text).not.toContain('LiteLLM 单价')
    expect(text).not.toContain('账号倍率')
    expect(text).not.toContain('×1.0000')
  })

  it('固定附加成本说明同样按源改写(展开编辑器后才可见)', async () => {
    const wrapper = mountInspector(meteredApiKey(), 'cliproxy')
    await wrapper.get('[data-testid="enable-fixed-overhead"]').trigger('click')

    const text = wrapper.text()
    expect(text).toContain('CPA usage_events、实际使用的模型和 LiteLLM 价格计算')
    expect(text).not.toContain('usage_logs')
    expect(wrapper.get('.cost-form-note').text()).not.toContain('渠道价格')
  })
})
