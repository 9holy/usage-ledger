import './usageI18nFixture'
import i18n from '@/i18n'
import { mount, flushPromises } from '@vue/test-utils'
import { expect, it, vi } from 'vitest'
import UsageRecordId from '../UsageRecordId.vue'

it('copies the full identifier and reports clipboard failure without hiding the value', async () => {
  const previous = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  const wrapper = mount(UsageRecordId, { props: { label: '请求 ID', value: 'full-request-identifier' } })
  try {
    await wrapper.get('button').trigger('click'); await flushPromises()
    expect(writeText).toHaveBeenCalledWith('full-request-identifier')
    expect(wrapper.get('[role="status"]').text()).toBe('已复制')
    writeText.mockRejectedValueOnce(new Error('unavailable'))
    await wrapper.get('button').trigger('click'); await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toContain('复制失败')
    i18n.global.locale.value = 'en'; await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toBe('Copy failed; select the text to copy')
    expect(wrapper.get('code').text()).toBe('full-request-identifier')
  } finally {
    wrapper.unmount()
    if (previous) Object.defineProperty(navigator, 'clipboard', previous)
    else Reflect.deleteProperty(navigator, 'clipboard')
  }
})
