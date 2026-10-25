import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createI18n } from 'vue-i18n'
import { parse } from 'vue/compiler-sfc'
import App from '@/App.vue'
import en from '@/i18n/locales/en/desktop'

const runtime = vi.hoisted(() => ({ desktop: true }))
vi.mock('@/api/url', () => ({ isDesktopRuntime: () => runtime.desktop }))
vi.mock('@/stores', () => ({
  useAppStore: () => ({ siteName: 'Usage Ledger', siteLogo: '', cachedPublicSettings: null, fetchPublicSettings: vi.fn() }),
  useAuthStore: () => ({ isAuthenticated: false, isAdmin: false }),
  useSubscriptionStore: () => ({ stopPolling: vi.fn() }),
  useAnnouncementStore: () => ({}),
  useAdminComplianceStore: () => ({}),
  useAdminSettingsStore: () => ({ customMenuItems: [] }),
}))
vi.mock('@/components/common/Toast.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/common/NavigationProgress.vue', () => ({
  default: { template: '<div class="navigation-progress" style="position:fixed" />' },
}))
vi.mock('@/components/common/AnnouncementPopup.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/admin/AdminComplianceDialog.vue', () => ({ default: { template: '<div />' } }))

const fullTitle = 'Usage Ledger: Current weekly allowance and subscription-month usage'
const { descriptor } = parse(readFileSync(resolve(process.cwd(), 'src/App.vue'), 'utf8'))
let wrapper: VueWrapper | undefined
let stylesheet: HTMLStyleElement | undefined

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  stylesheet?.remove()
  stylesheet = undefined
  vi.restoreAllMocks()
})

it.each([
  { label: 'MacIntel desktop token', platform: 'MacIntel', desktop: true, native: true },
  { label: 'MacARM64 desktop token', platform: 'MacARM64', desktop: true, native: true },
  { label: 'Windows desktop', platform: 'Win32', desktop: true, native: false },
  { label: 'macOS browser', platform: 'MacIntel', desktop: false, native: false },
])('uses the correct chrome and safe-area mode for $label', async ({ platform, desktop, native }) => {
  runtime.desktop = desktop
  vi.spyOn(window.navigator, 'platform', 'get').mockReturnValue(platform)
  stylesheet = document.createElement('style')
  stylesheet.textContent = descriptor.styles.map(style => style.content).join('\n')
  document.head.appendChild(stylesheet)
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{
      path: '/usage-monitor',
      component: {
        data: () => ({ fullTitle }),
        template: '<aside class="sidebar" style="position:fixed">Accounts</aside><main class="min-h-screen"><h1>{{ fullTitle }}</h1><section class="h-screen">Recorded amounts</section><Teleport to="body"><div class="modal-overlay" style="position:fixed">Amount details</div></Teleport></main>',
      },
    }],
  })
  await router.push('/usage-monitor')
  await router.isReady()
  const i18n = createI18n({ legacy: false, locale: 'en', messages: { en: { desktop: en } } })
  wrapper = mount(App, { attachTo: document.body, global: { plugins: [router, i18n] } })
  await flushPromises()

  const frame = wrapper.get('.app-window')
  expect(frame.classes().includes('app-window--desktop')).toBe(desktop)
  expect(frame.classes().includes('app-window--native-chrome')).toBe(native)
  expect(document.documentElement.classList.contains('desktop-runtime')).toBe(desktop)
  expect(document.documentElement.classList.contains('desktop-native-chrome')).toBe(native)
  expect(wrapper.find('.desktop-titlebar').exists()).toBe(desktop && !native)
  expect(wrapper.get('h1').text()).toBe(fullTitle)
  expect(wrapper.get('.h-screen').text()).toBe('Recorded amounts')

  const expectedOffset = desktop ? native ? '0px' : '36px' : ''
  expect(getComputedStyle(frame.element).getPropertyValue('--desktop-titlebar-height')).toBe(expectedOffset)
  expect(getComputedStyle(document.documentElement).getPropertyValue('--desktop-titlebar-height')).toBe(expectedOffset)
  if (desktop) {
    expect(getComputedStyle(frame.element).borderTopWidth).toBe(native ? '0px' : '1px')
    expect(getComputedStyle(wrapper.get('.sidebar').element).top).toBe('var(--desktop-titlebar-height)')
    expect(getComputedStyle(wrapper.get('.navigation-progress').element).top).toBe('var(--desktop-titlebar-height)')
    const modal = document.querySelector('.modal-overlay')!
    expect(modal.textContent).toBe('Amount details')
    expect(getComputedStyle(modal).top).toBe('var(--desktop-titlebar-height)')
    expect(getComputedStyle(wrapper.get('.min-h-screen').element).minHeight).toBe('calc(100vh - var(--desktop-titlebar-height))')
    expect(getComputedStyle(wrapper.get('.h-screen').element).height).toBe('calc(100vh - var(--desktop-titlebar-height))')
  }
  if (desktop && !native) {
    expect(wrapper.get('.desktop-titlebar__brand').text()).toBe('Usage Ledger')
    expect(wrapper.findAll('.desktop-titlebar__controls button')).toHaveLength(3)
  }

  wrapper.unmount()
  wrapper = undefined
  expect(document.documentElement.classList.contains('desktop-runtime')).toBe(false)
  expect(document.documentElement.classList.contains('desktop-native-chrome')).toBe(false)
  expect(document.querySelector('.modal-overlay')).toBeNull()
})
