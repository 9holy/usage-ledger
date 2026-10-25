import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { baseCompile } from '@intlify/message-compiler'
import { costComponentI18n } from './costI18n'
import zh from '@/i18n/locales/zh/costComponents'
import en from '@/i18n/locales/en/costComponents'
import CostApiAccessPanel from '../CostApiAccessPanel.vue'
import TruthfulMetric from '../TruthfulMetric.vue'
import ModelContributionChart from '../ModelContributionChart.vue'
import CostProfileInspector from '../CostProfileInspector.vue'
import FinanceBatchEditor from '../FinanceBatchEditor.vue'
import type { SourceAccount } from '../../sourceTypes'
import type { ModelCostRow } from '../../modelCostAnalysis'

const mocks = vi.hoisted(() => ({
  target: 'https://gateway.example/api/v1',
  list: vi.fn(), settings: vi.fn(), copy: vi.fn(), push: vi.fn(), fetch: vi.fn(),
}))
vi.mock('@/api/url', () => ({ getActiveConnection: () => ({ baseUrl: mocks.target }) }))
vi.mock('@/api', () => ({ keysAPI: { list: mocks.list }, authAPI: { getPublicSettings: mocks.settings } }))
vi.mock('@/composables/useClipboard', () => ({ useClipboard: () => ({ copyToClipboard: mocks.copy }) }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('@/api/financeLedger', () => ({ saveFinanceBatch: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.list.mockResolvedValue({ items: [{ id: 1, name: 'fixture key', key: 'fixture-not-a-credential', status: 'active' }] })
  mocks.settings.mockResolvedValue({ api_base_url: '' })
  vi.stubGlobal('fetch', mocks.fetch)
})
afterEach(() => vi.unstubAllGlobals())

describe('cost component bilingual messages', () => {
  it('keeps every key and interpolation parameter consistent and both catalogs compilable', () => {
    expect(Object.keys(en.costComponents).sort()).toEqual(Object.keys(zh.costComponents).sort())
    const parameters = (message: string) => [...message.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
    for (const [key, chinese] of Object.entries(zh.costComponents)) {
      const english = en.costComponents[key as keyof typeof en.costComponents]
      expect(parameters(english), key).toEqual(parameters(chinese))
      const errors: string[] = []
      for (const message of [chinese, english]) baseCompile(message, { onError: error => errors.push(error.message) })
      expect(errors, key).toEqual([])
      expect(english, key).not.toMatch(/\p{Script=Han}/u)
    }
  })

  it('reacts to locale changes without replacing source names or coercing a string account ID', async () => {
    const i18n = costComponentI18n('en')
    const cell = mount(TruthfulMetric, { props: { label: 'raw-model-原文' }, global: { plugins: [i18n] } })
    expect(cell.text()).toContain('No data')
    const chart = mount(ModelContributionChart, { props: { rows: [{ model: 'raw-model-原文', accountCost: 1, revenue: 2, grossProfit: 1 } as ModelCostRow], state: 'measured' }, global: { plugins: [i18n] } })
    expect(chart.text()).toContain('User charges')
    const account = { id: 'cliproxy:opaque%3Aid', name: '原始账号', type: 'oauth', platform: 'openai', extra: {}, credentials: {}, created_at: '2026-01-01T00:00:00Z' } as SourceAccount
    const profile = mount(CostProfileInspector, { props: { account, sourceKind: 'cliproxy', saving: false, now: new Date('2026-10-25T00:00:00Z') }, global: { plugins: [i18n] } })
    expect(profile.text()).toContain('原始账号')
    expect(profile.text()).toContain('Save cost settings')
    expect(profile.props('account').id).toBe('cliproxy:opaque%3Aid')
    const batch = mount(FinanceBatchEditor, { props: { scope: { source: 'cliproxy', instanceId: 'local' }, accounts: [], channels: [] }, global: { plugins: [i18n] } })
    expect(batch.find('[aria-label="Total batch payment"]').exists()).toBe(true)
    i18n.global.locale.value = 'zh'
    await nextTick()
    expect(cell.text()).toContain('无数据')
    expect(chart.text()).toContain('用户计费')
    expect(profile.text()).toContain('保存成本设置')
    expect(batch.find('[aria-label="批次实付总额"]').exists()).toBe(true)
    cell.unmount(); chart.unmount(); profile.unmount(); batch.unmount()
  })
})

describe('business API address normalization', () => {
  it.each([
    ['https://gateway.example/api/v1', 'https://gateway.example/v1'],
    ['https://gateway.example/deployment/api/v1/', 'https://gateway.example/deployment/v1'],
    ['https://gateway.example/v0/management', 'https://gateway.example/v1'],
    ['https://gateway.example/v1', 'https://gateway.example/v1'],
    ['http://127.0.0.1:8317', 'http://127.0.0.1:8317/v1'],
  ])('uses the business base for %s in all seven templates without making requests', async (target, business) => {
    mocks.target = target
    const wrapper = mount(CostApiAccessPanel, { props: { desktopMode: true }, global: { plugins: [costComponentI18n('en')] } })
    await flushPromises()
    expect(wrapper.findAll('[role="tab"]')).toHaveLength(7)
    for (const tab of wrapper.findAll('[role="tab"]')) {
      await tab.trigger('click')
      expect(wrapper.get('pre').text()).toContain(business)
      expect(wrapper.get('pre').text()).not.toContain('/api/v1/responses')
    }
    expect(wrapper.text()).toContain(target.includes('127.0.0.1') ? 'Local gateway address' : 'Remote gateway address')
    expect(mocks.fetch).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('keeps the explicit test limited to the normalized models endpoint', async () => {
    mocks.target = 'https://gateway.example/api/v1'
    mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: 'raw-model-原文' }] }) })
    const wrapper = mount(CostApiAccessPanel, { props: { desktopMode: true }, global: { plugins: [costComponentI18n('en')] } })
    await flushPromises()
    await wrapper.findAll('button').find(button => button.text() === 'Test connection')!.trigger('click')
    await flushPromises()
    expect(mocks.fetch).toHaveBeenCalledOnce()
    expect(mocks.fetch.mock.calls[0][0]).toBe('https://gateway.example/v1/models')
    expect(wrapper.get('pre').text()).toContain('raw-model-原文')
    wrapper.unmount()
  })
})
