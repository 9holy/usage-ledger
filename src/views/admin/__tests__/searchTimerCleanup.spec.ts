import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount } from '@vue/test-utils'
import AdminOrdersView from '../orders/AdminOrdersView.vue'
import AdminAffiliateRecordsTable from '../affiliates/AdminAffiliateRecordsTable.vue'

const { getOrders, listInviteRecords } = vi.hoisted(() => ({
  getOrders: vi.fn().mockResolvedValue({ data: { items: [], total: 0 } }),
  listInviteRecords: vi.fn().mockResolvedValue({ items: [], total: 0 }),
}))

vi.mock('@/api/admin/payment', () => ({
  adminPaymentAPI: { getOrders }, default: { getOrders },
}))
vi.mock('@/api/admin/affiliates', () => ({
  affiliatesAPI: { listInviteRecords }, default: { listInviteRecords },
}))
vi.mock('@/stores/app', () => ({ useAppStore: () => ({ showError: vi.fn() }) }))
vi.mock('vue-i18n', async () => {
  const actual = await vi.importActual<typeof import('vue-i18n')>('vue-i18n')
  return { ...actual, useI18n: () => ({ t: (key: string) => key }) }
})

const stubs = {
  AppLayout: { template: '<main><slot /></main>' },
  TablePageLayout: { template: '<section><slot name="filters" /><slot name="table" /></section>' },
}

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('admin search timer cleanup', () => {
  it('does not load orders for an abandoned pending search', async () => {
    vi.useFakeTimers()
    const wrapper = shallowMount(AdminOrdersView, { global: { stubs } })
    await flushPromises()
    getOrders.mockClear()
    await wrapper.get('input[type="text"]').setValue('order')
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(299)
    expect(getOrders).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(getOrders).toHaveBeenCalledTimes(1)
    getOrders.mockClear()
    await wrapper.get('input[type="text"]').setValue('abandoned order')

    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(300)
    await flushPromises()
    expect(getOrders).not.toHaveBeenCalled()
  })

  it('does not load affiliate records for an abandoned pending search', async () => {
    vi.useFakeTimers()
    const wrapper = shallowMount(AdminAffiliateRecordsTable, {
      props: { type: 'invites' }, global: { stubs },
    })
    await flushPromises()
    listInviteRecords.mockClear()
    await wrapper.get('input[type="text"]').setValue('affiliate')
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(299)
    expect(listInviteRecords).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(listInviteRecords).toHaveBeenCalledTimes(1)
    listInviteRecords.mockClear()
    await wrapper.get('input[type="text"]').setValue('abandoned affiliate')

    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(300)
    await flushPromises()
    expect(listInviteRecords).not.toHaveBeenCalled()
  })
})
