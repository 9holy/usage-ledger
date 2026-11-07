import { flushPromises, type VueWrapper } from '@vue/test-utils'
import { mountWithCostI18n as mount } from './costI18n'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CostApiAccessPanel from '../CostApiAccessPanel.vue'
import { setActiveConnection } from '@/api/url'

const mocks = vi.hoisted(() => ({
  listKeys: vi.fn(),
  getPublicSettings: vi.fn(),
  push: vi.fn(),
  copy: vi.fn(),
  gateway: vi.fn(),
}))

vi.mock('@/api', () => ({
  keysAPI: { list: mocks.listKeys },
  authAPI: { getPublicSettings: mocks.getPublicSettings },
}))
vi.mock('@/composables/useClipboard', () => ({
  useClipboard: () => ({ copyToClipboard: mocks.copy }),
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('@/api/fetch', () => ({ fetchGateway: mocks.gateway }))

const connection = { id: 'same-sub2', type: 'sub2api' as const, name: 'Fixture', baseUrl: 'https://one.example.test', apiKey: 'fixture-admin-a', lastUsed: 0 }
const key = (id: number) => ({ id, name: `Key ${id}`, key: `fixture-only-key-${id}`, status: 'active', group: { name: 'Fixture', platform: 'openai' } })
const page = (items: ReturnType<typeof key>[], total = items.length, current = 1) => ({ items, total, page: current, page_size: 100, pages: Math.ceil(total / 100) })
const modelResponse = (payload: unknown) => ({ ok: true, status: 200, json: async () => payload })
const wrappers: VueWrapper[] = []
function open() {
  const wrapper = mount(CostApiAccessPanel, { props: { desktopMode: true } })
  wrappers.push(wrapper)
  return wrapper
}

describe('CostApiAccessPanel data truthfulness', () => {
  beforeEach(() => {
    mocks.listKeys.mockReset()
    mocks.getPublicSettings.mockReset().mockResolvedValue({ api_base_url: '' })
    mocks.gateway.mockReset()
    setActiveConnection(connection)
  })
  afterEach(() => { wrappers.splice(0).forEach(wrapper => wrapper.unmount()); setActiveConnection(null) })

  it('does not describe an API failure as an empty key list', async () => {
    mocks.listKeys.mockRejectedValue(new Error('401 Unauthorized'))
    const wrapper = open()
    await flushPromises()

    expect(wrapper.get('[role="alert"]').text()).toContain('API Key 无数据：401 Unauthorized')
    expect(wrapper.text()).toContain('这不是“没有密钥”')
    expect(wrapper.text()).not.toContain('当前确实没有密钥')
  })

  it('shows an empty state only after a successful empty response', async () => {
    mocks.listKeys.mockResolvedValue({ items: [], total: 0, page: 1, page_size: 100 })
    const wrapper = open()
    await flushPromises()

    expect(wrapper.text()).toContain('API Key 清单读取成功，但当前确实没有密钥')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('loads keys beyond the first 100 entries using the server pagination contract', async () => {
    mocks.listKeys.mockResolvedValueOnce(page(Array.from({ length: 100 }, (_, index) => key(index + 1)), 101))
      .mockResolvedValueOnce(page([key(101)], 101, 2))
    const wrapper = open(); await flushPromises()
    expect(mocks.listKeys).toHaveBeenCalledTimes(2)
    expect(mocks.listKeys.mock.calls.map(call => call.slice(0, 2))).toEqual([[1, 100], [2, 100]])
    expect((wrapper.vm as any).keys).toHaveLength(101)
    expect(wrapper.findAll('select')[0].findAll('option')).toHaveLength(102)
    expect((wrapper.vm as any).keyLoadState).toBe('measured')
  })

  it('keeps read pages as partial when a later page fails instead of claiming a complete key inventory', async () => {
    mocks.listKeys.mockResolvedValueOnce(page(Array.from({ length: 100 }, (_, index) => key(index + 1)), 101))
      .mockRejectedValueOnce(new Error('fixture second page denied'))
    const wrapper = open(); await flushPromises()
    expect((wrapper.vm as any).keys).toHaveLength(100)
    expect((wrapper.vm as any).keyLoadState).toBe('partial')
    expect(wrapper.get('[role="alert"]').text()).toContain('fixture second page denied')
    expect(wrapper.text()).not.toContain('当前确实没有密钥')
  })

  it.each(['URL', 'administrative key'])('does not publish an obsolete key list when the same connection ID changes %s', async change => {
    let finish!: (result: ReturnType<typeof page>) => void
    mocks.listKeys.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockResolvedValueOnce(page([key(2)]))
    const wrapper = open(); await flushPromises()
    setActiveConnection({ ...connection, ...(change === 'URL' ? { baseUrl: 'https://two.example.test' } : { apiKey: 'fixture-admin-b' }) })
    await flushPromises()
    finish(page([key(1)])); await flushPromises()
    expect((wrapper.vm as any).keys.map((entry: { id: number }) => entry.id)).toEqual([2])
    expect((wrapper.vm as any).selectedKeyId).toBe('2')
  })

  it('discards a model response for a key that was deselected while the request was pending', async () => {
    mocks.listKeys.mockResolvedValue(page([key(1), key(2)]))
    let finish!: (result: ReturnType<typeof modelResponse>) => void
    mocks.gateway.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const wrapper = open(); await flushPromises()
    const pending = (wrapper.vm as any).testConnection()
    await flushPromises()
    await wrapper.findAll('select')[0].setValue('2')
    finish(modelResponse({ object: 'list', data: [{ id: 'model-for-key-one' }] }))
    await pending; await flushPromises()
    expect((wrapper.vm as any).models).toEqual([])
    expect((wrapper.vm as any).testOk).toBe(false)
    expect((wrapper.vm as any).lastProbeMs).toBeNull()
    expect((wrapper.vm as any).testing).toBe(false)
  })

  it.each([null, {}, { data: [{}] }, { data: [{ id: 2 }] }])('does not classify a malformed 200 response as a healthy model catalogue: %j', async payload => {
    mocks.listKeys.mockResolvedValue(page([key(1)]))
    mocks.gateway.mockResolvedValue(modelResponse(payload))
    const wrapper = open(); await flushPromises()
    await (wrapper.vm as any).testConnection(); await flushPromises()
    expect((wrapper.vm as any).testOk).toBe(false)
    expect((wrapper.vm as any).models).toEqual([])
    expect((wrapper.vm as any).testMessage).toBeTruthy()
  })

  it('preserves an explicitly empty valid model list and prevents expired keys from remaining selected after refresh', async () => {
    mocks.listKeys.mockResolvedValueOnce(page([key(1)]))
      .mockResolvedValueOnce(page([{ ...key(1), status: 'expired' }]))
    mocks.gateway.mockResolvedValue(modelResponse({ object: 'list', data: [] }))
    const wrapper = open(); await flushPromises()
    await (wrapper.vm as any).testConnection(); await flushPromises()
    expect((wrapper.vm as any).testOk).toBe(true)
    expect((wrapper.vm as any).models).toEqual([])
    await (wrapper.vm as any).loadKeys(); await flushPromises()
    expect((wrapper.vm as any).selectedKey).toBeNull()
    expect((wrapper.vm as any).testOk).toBe(false)
  })
})
