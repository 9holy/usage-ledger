import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import type { Account } from '@/types'
import AccountQuotaInfo from '../AccountQuotaInfo.vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string, params?: { time?: string }) => params?.time ?? key }),
}))

const account = (reset: string | null) => ({
  platform: 'gemini', credentials: {}, rate_limit_reset_at: reset,
}) as Account

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-26T00:00:00Z'))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('AccountQuotaInfo reset timestamp', () => {
  it('parses once while preserving countdown updates, prop changes and expiry', async () => {
    const parse = vi.spyOn(Date, 'parse')
    const wrapper = mount(AccountQuotaInfo, {
      props: { account: account('2026-10-26T00:01:05Z') },
    })
    expect(wrapper.text()).toContain('1m 5s')
    expect(parse).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(6000)
    expect(wrapper.text()).toContain('59s')
    expect(wrapper.get('.font-medium.text-red-600').exists()).toBe(true)
    expect(parse).toHaveBeenCalledTimes(1)

    await wrapper.setProps({ account: account('2026-10-26T00:00:08Z') })
    expect(wrapper.text()).toContain('2s')
    expect(parse).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(wrapper.text()).toContain('admin.accounts.gemini.rateLimit.unlimited')
    expect(vi.getTimerCount()).toBe(0)
    wrapper.unmount()
  })

  it('keeps absent and invalid dates unlimited and clears an active timer on unmount', async () => {
    const wrapper = mount(AccountQuotaInfo, { props: { account: account(null) } })
    expect(wrapper.text()).toContain('admin.accounts.gemini.rateLimit.unlimited')
    expect(vi.getTimerCount()).toBe(0)
    await wrapper.setProps({ account: account('invalid-date') })
    expect(wrapper.text()).toContain('admin.accounts.gemini.rateLimit.unlimited')
    expect(vi.getTimerCount()).toBe(0)

    await wrapper.setProps({ account: account('2026-10-26T00:00:20Z') })
    expect(wrapper.text()).toContain('20s')
    expect(vi.getTimerCount()).toBe(1)
    wrapper.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
