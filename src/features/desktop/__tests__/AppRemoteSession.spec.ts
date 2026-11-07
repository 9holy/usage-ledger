import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive, nextTick } from 'vue'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import { setActiveConnection } from '@/api/url'
import type { ConnectionConfig } from '@/stores/connection'
import App from '@/App.vue'

const state = vi.hoisted(() => ({
  auth: { isAuthenticated: true, isAdmin: true, authMode: 'apikey', token: 'fixture-token' },
  subscriptions: { fetchActiveSubscriptions: vi.fn(async () => []), startPolling: vi.fn(), stopPolling: vi.fn(), clear: vi.fn() },
  announcements: { fetchAnnouncements: vi.fn(async () => {}), reset: vi.fn() },
  compliance: { fetchStatus: vi.fn(async () => ({})), reset: vi.fn() },
  app: { siteName: 'Usage Ledger', siteLogo: '', cachedPublicSettings: null, fetchPublicSettings: vi.fn(async () => null) },
}))
vi.mock('@/stores', () => ({
  useAppStore: () => state.app,
  useAuthStore: () => state.auth,
  useSubscriptionStore: () => state.subscriptions,
  useAnnouncementStore: () => state.announcements,
  useAdminComplianceStore: () => state.compliance,
  useAdminSettingsStore: () => ({ customMenuItems: [] }),
}))
vi.mock('@/components/common/Toast.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/common/NavigationProgress.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/common/AnnouncementPopup.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/components/admin/AdminComplianceDialog.vue', () => ({ default: { template: '<div />' } }))
vi.mock('@/features/desktop/DesktopTitleBar.vue', () => ({ default: { template: '<div />' } }))

let wrapper: VueWrapper | undefined

async function mountApplication() {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/admin/cost-center', component: { template: '<main />' } }] })
  await router.push('/admin/cost-center')
  await router.isReady()
  wrapper = mount(App, { global: { plugins: [router] } })
  await flushPromises()
}

function selectConnection(type: ConnectionConfig['type'] = 'sub2api', authMode: 'login' | 'apikey' = 'apikey') {
  setActiveConnection({ id: 'a', name: 'A', type, authMode, baseUrl: 'https://a.example', apiKey: 'fixture-token', lastUsed: 0 })
}

beforeEach(() => {
  vi.clearAllMocks()
  state.auth = reactive({ isAuthenticated: true, isAdmin: true, authMode: 'apikey', token: 'fixture-token' })
  Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.useRealTimers()
  setActiveConnection(null)
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

describe('remote user requests', () => {
  it.each(['sub2api', 'cliproxy'] as const)('does not send JWT-only subscriptions or announcements for a %s API key session', async (type) => {
    selectConnection(type)
    await mountApplication()
    expect(state.subscriptions.fetchActiveSubscriptions).not.toHaveBeenCalled()
    expect(state.subscriptions.startPolling).not.toHaveBeenCalled()
    expect(state.announcements.fetchAnnouncements).not.toHaveBeenCalled()
    expect(state.compliance.fetchStatus).not.toHaveBeenCalled()
  })

  it('starts subscriptions and announcements for a matching login session', async () => {
    state.auth.authMode = 'jwt'
    selectConnection('sub2api', 'login')
    await mountApplication()
    expect(state.subscriptions.fetchActiveSubscriptions).toHaveBeenCalledTimes(1)
    expect(state.subscriptions.startPolling).toHaveBeenCalledTimes(1)
    expect(state.announcements.fetchAnnouncements).toHaveBeenCalledTimes(1)
  })

  it('cancels delayed announcement loading on logout', async () => {
    state.auth.isAuthenticated = false
    state.auth.authMode = 'jwt'
    selectConnection('sub2api', 'login')
    await mountApplication()
    vi.useFakeTimers()
    state.auth.isAuthenticated = true
    await nextTick()
    expect(state.announcements.fetchAnnouncements).not.toHaveBeenCalled()
    state.auth.isAuthenticated = false
    await nextTick()
    await vi.advanceTimersByTimeAsync(3000)
    expect(state.announcements.fetchAnnouncements).not.toHaveBeenCalled()
  })
})
