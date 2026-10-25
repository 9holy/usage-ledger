import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createPinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import ConsoleWorkspaceHeader from '../ConsoleWorkspaceHeader.vue'
import { i18n, initI18n } from '@/i18n'
import { invoke } from '@tauri-apps/api/core'
import desktopZh from '@/i18n/locales/zh/desktop'
import desktopEn from '@/i18n/locales/en/desktop'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue(undefined) }))

vi.mock('@/router', () => ({
  default: { currentRoute: { value: { name: 'Connect', params: {}, meta: { title: 'Connections', titleKey: 'desktop.pages.connect' } } } },
}))

beforeEach(() => {
  vi.clearAllMocks()
  i18n.global.setLocaleMessage('zh', { desktop: desktopZh })
  i18n.global.setLocaleMessage('en', { desktop: desktopEn })
  i18n.global.locale.value = 'zh'
})
afterEach(() => { Reflect.deleteProperty(window, '__TAURI_INTERNALS__') })

it('keeps the cost workspace selected inside its detail routes and updates accessible navigation', async () => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }]
  })
  await router.push('/connect')
  const wrapper = mount(ConsoleWorkspaceHeader, {
    global: { plugins: [createPinia(), router, i18n] }
  })
  for (const path of ['/connect', '/admin/cost-center?panel=overview', '/cockpit/cost-center']) {
    await router.push(path)
    expect(wrapper.get('.workspace-switch [aria-current="page"]').text()).toContain('成本工作台')
    expect(wrapper.findAll('.workspace-switch [aria-current="page"]')).toHaveLength(1)
  }
  await router.push('/usage-monitor')
  expect(wrapper.get('.workspace-switch [aria-current="page"]').text()).toContain('全局用量监控')
  expect(wrapper.get('.workspace-brand').attributes('href')).toBe('/connect')
  wrapper.unmount()
})

it('switches the live header language through the existing locale menu and preserves the saved choice', async () => {
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
  localStorage.setItem('sub2api_locale', 'zh')
  await initI18n()
  await flushPromises()
  expect(invoke).toHaveBeenLastCalledWith('set_desktop_locale', { locale: 'zh' })
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }] })
  await router.push('/usage-monitor')
  const wrapper = mount(ConsoleWorkspaceHeader, { global: { plugins: [createPinia(), router, i18n] } })
  expect(localStorage.getItem('sub2api_locale')).toBe('zh')
  await wrapper.get('.workspace-locale button').trigger('click')
  await wrapper.findAll('.workspace-locale button').find(button => button.text().includes('English'))!.trigger('click')
  await vi.waitFor(() => expect(i18n.global.locale.value).toBe('en'))
  await vi.waitFor(() => expect(wrapper.findAll('.workspace-locale button')).toHaveLength(1))
  await flushPromises()
  expect(wrapper.get('.workspace-brand strong').text()).toBe('Usage Ledger')
  expect(wrapper.get('.workspace-switch').attributes('aria-label')).toBe('Workspace navigation')
  expect(wrapper.get('.workspace-switch [aria-current="page"]').text()).toContain('Usage Monitor')
  expect(localStorage.getItem('sub2api_locale')).toBe('en')
  expect(document.documentElement.lang).toBe('en')
  expect(document.title).toBe('Connections - Usage Ledger')
  expect(invoke).toHaveBeenLastCalledWith('set_desktop_locale', { locale: 'en' })
  await wrapper.get('.workspace-locale button').trigger('click')
  await wrapper.findAll('.workspace-locale button').find(button => button.text().includes('中文'))!.trigger('click')
  await vi.waitFor(() => expect(i18n.global.locale.value).toBe('zh'))
  await vi.waitFor(() => expect(wrapper.findAll('.workspace-locale button')).toHaveLength(1))
  await flushPromises()
  expect(wrapper.get('.workspace-brand strong').text()).toBe('用量账本')
  expect(localStorage.getItem('sub2api_locale')).toBe('zh')
  expect(document.title).toBe('连接 - 用量账本')
  expect(invoke).toHaveBeenLastCalledWith('set_desktop_locale', { locale: 'zh' })
  wrapper.unmount()
})
