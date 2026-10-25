import { mount } from '@vue/test-utils'
import { beforeEach, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import DesktopTitleBar from '../DesktopTitleBar.vue'
import en from '@/i18n/locales/en/desktop'
import zh from '@/i18n/locales/zh/desktop'

const windowActions = vi.hoisted(() => ({ minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => windowActions }))
beforeEach(() => vi.clearAllMocks())

it('translates the brand and native window controls immediately without changing their actions', async () => {
  const i18n = createI18n({ legacy: false, locale: 'zh', messages: { en: { desktop: en }, zh: { desktop: zh } } })
  const wrapper = mount(DesktopTitleBar, { global: { plugins: [i18n] } })
  expect(wrapper.get('.desktop-titlebar__brand').text()).toBe('用量账本')
  i18n.global.locale.value = 'en'
  await wrapper.vm.$nextTick()
  expect(wrapper.get('.desktop-titlebar__brand').text()).toBe('Usage Ledger')
  await wrapper.get('[aria-label="Minimize window"]').trigger('click')
  await wrapper.get('[aria-label="Maximize or restore window"]').trigger('click')
  await wrapper.get('[aria-label="Close window"]').trigger('click')
  await vi.waitFor(() => expect(windowActions.close).toHaveBeenCalledOnce())
  expect(windowActions.minimize).toHaveBeenCalledOnce()
  expect(windowActions.toggleMaximize).toHaveBeenCalledOnce()
  expect(wrapper.get('[aria-label="Close window"]').attributes('title')).toBe('Close')
  i18n.global.locale.value = 'zh'
  await wrapper.vm.$nextTick()
  expect(wrapper.get('[aria-label="关闭窗口"]').attributes('title')).toBe('关闭')
})
