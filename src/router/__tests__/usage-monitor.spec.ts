import { describe, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n'
import desktopEn from '@/i18n/locales/en/desktop'

const mocks = vi.hoisted(() => ({
  guard: null as null | ((to: { path: string }, from: unknown, next: () => void) => Promise<void>),
  connection: vi.fn(() => { throw new Error('local page must not touch connection store') }),
  auth: vi.fn(() => { throw new Error('local page must not touch auth store') }),
  routes: [] as Array<{ path: string; meta?: { requiresAuth?: boolean } }>,
}))
vi.mock('vue-router', () => ({
  createWebHistory: vi.fn(), createWebHashHistory: vi.fn(),
  createRouter: (options: { routes: typeof mocks.routes }) => {
    mocks.routes = options.routes
    return { beforeEach: (guard: typeof mocks.guard) => { mocks.guard = guard }, afterEach: vi.fn(), onError: vi.fn() }
  },
}))
vi.mock('@/stores/connection', () => ({ useConnectionStore: mocks.connection }))
vi.mock('@/stores/auth', () => ({ useAuthStore: mocks.auth }))
vi.mock('@/stores/app', () => ({ useAppStore: vi.fn() }))
vi.mock('@/stores/adminSettings', () => ({ useAdminSettingsStore: vi.fn() }))
vi.mock('@/stores/adminCompliance', () => ({ useAdminComplianceStore: vi.fn() }))
vi.mock('@/composables/useNavigationLoading', () => ({ useNavigationLoadingState: () => ({ startNavigation: vi.fn(), endNavigation: vi.fn() }) }))
vi.mock('@/composables/useRoutePrefetch', () => ({ useRoutePrefetch: vi.fn() }))
vi.mock('@/api/setup', () => ({ getSetupStatus: vi.fn() }))

describe('local usage monitor route', () => {
  it('allows direct navigation before remote restoration or authentication', async () => {
    await import('@/router')
    i18n.global.setLocaleMessage('en', { desktop: desktopEn })
    const next = vi.fn()
    const monitorRoute = mocks.routes.find((route) => route.path === '/usage-monitor')
    const target = { path: '/usage-monitor', params: {}, meta: monitorRoute?.meta ?? {} }
    await mocks.guard!(target, {}, next)
    expect(next).toHaveBeenCalledWith()
    expect(mocks.connection).not.toHaveBeenCalled()
    expect(mocks.auth).not.toHaveBeenCalled()
    expect(monitorRoute?.meta).toMatchObject({ requiresAuth: false, titleKey: 'desktop.pages.monitor' })
  })
})
