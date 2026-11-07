import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia, type Pinia } from 'pinia'
import { setActiveConnection } from '@/api/url'
import type { ConnectionConfig } from '@/stores/connection'
import type { PublicSettings, UserAnnouncement, UserSubscription } from '@/types'
import { useAppStore } from '@/stores/app'
import { useAdminSettingsStore } from '@/stores/adminSettings'
import { useAdminComplianceStore } from '@/stores/adminCompliance'
import { useAnnouncementStore } from '@/stores/announcements'
import { useSubscriptionStore } from '@/stores/subscriptions'
import type { AdminComplianceStatus } from '@/api/admin/compliance'

const api = vi.hoisted(() => ({
  publicSettings: vi.fn(), version: vi.fn(), settings: vi.fn(), payment: vi.fn(),
  announcements: vi.fn(), markRead: vi.fn(), subscriptions: vi.fn(), compliance: vi.fn(), accept: vi.fn(),
}))
vi.mock('@/api/auth', () => ({ getPublicSettings: api.publicSettings }))
vi.mock('@/api/admin/system', () => ({ checkUpdates: api.version }))
vi.mock('@/api', () => ({
  adminAPI: { settings: { getSettings: api.settings }, payment: { getConfig: api.payment } },
  announcementsAPI: { list: api.announcements, markRead: api.markRead },
}))
vi.mock('@/api/subscriptions', () => ({ default: { getActiveSubscriptions: api.subscriptions } }))
vi.mock('@/api/admin/compliance', () => ({ default: { getStatus: api.compliance, accept: api.accept } }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function connection(id: string, patch: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return { id, name: id, type: 'sub2api', authMode: 'login', baseUrl: `https://${id}.example`, apiKey: `token-${id}`, lastUsed: 0, ...patch }
}

function settings(name: string): PublicSettings {
  return { site_name: name, site_logo: `${name}.png`, payment_enabled: true, custom_menu_items: [] } as unknown as PublicSettings
}

function announcement(title: string): UserAnnouncement {
  return { id: 1, title, content: title, notify_mode: 'popup', read_at: null } as UserAnnouncement
}

describe('connection-scoped remote caches', () => {
  let pinia: Pinia

  beforeEach(() => {
    vi.resetAllMocks()
    localStorage.clear()
    delete window.__APP_CONFIG__
    setActiveConnection(connection('a'))
    pinia = createPinia()
    setActivePinia(pinia)
  })

  afterEach(() => {
    disposePinia(pinia)
    setActiveConnection(null)
    delete window.__APP_CONFIG__
  })

  it('discards old public settings and their injected cache while the new server loads', async () => {
    const store = useAppStore()
    api.publicSettings.mockResolvedValueOnce(settings('A'))
    await store.fetchPublicSettings()
    const old = deferred<PublicSettings>()
    const next = deferred<PublicSettings>()
    api.publicSettings.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
    const oldRequest = store.fetchPublicSettings(true)

    setActiveConnection(connection('b'))
    expect(store.publicSettingsLoaded).toBe(false)
    expect(store.siteName).toBe('Sub2API')
    expect(window.__APP_CONFIG__).toBeUndefined()
    const newRequest = store.fetchPublicSettings()
    old.resolve(settings('stale A'))
    expect(await oldRequest).toBeNull()
    expect(store.publicSettingsLoaded).toBe(false)
    void store.fetchPublicSettings()
    expect(api.publicSettings).toHaveBeenCalledTimes(3)
    next.resolve(settings('B'))
    await newRequest
    expect(store.siteName).toBe('B')
    expect(window.__APP_CONFIG__?.site_name).toBe('B')
  })

  it('preserves caches during token rotation but resets them when the server URL changes', async () => {
    const store = useAppStore()
    api.publicSettings.mockResolvedValue(settings('A'))
    await store.fetchPublicSettings()
    setActiveConnection(connection('a', { apiKey: 'rotated-token', lastUsed: Date.now() }))
    expect(store.publicSettingsLoaded).toBe(true)
    setActiveConnection(connection('a', { baseUrl: 'https://replacement.example' }))
    expect(store.publicSettingsLoaded).toBe(false)
  })

  it.each(['sub2api', 'cliproxy'] as const)('resets a %s cache when its static credential changes without changing its ID or URL', async (type) => {
    const initial = connection('a', { type, authMode: type === 'sub2api' ? 'apikey' : undefined, apiKey: 'old-api-key', secretKey: 'old-management-key' })
    setActiveConnection(initial)
    const store = useAppStore()
    api.publicSettings.mockResolvedValue(settings('A'))
    await store.fetchPublicSettings()
    setActiveConnection({ ...initial, ...(type === 'sub2api' ? { apiKey: 'new-api-key' } : { secretKey: 'new-management-key' }) })
    expect(store.publicSettingsLoaded).toBe(false)
    expect(store.cachedPublicSettings).toBeNull()
    expect(window.__APP_CONFIG__).toBeUndefined()
  })

  it('invalidates connection caches when the separate cost service changes', async () => {
    const store = useAppStore()
    api.publicSettings.mockResolvedValue(settings('A'))
    await store.fetchPublicSettings()
    setActiveConnection(connection('a', { costServiceUrl: 'https://new-cost.example' }))
    expect(store.publicSettingsLoaded).toBe(false)
  })

  it('does not restore another server update information after switching', async () => {
    const store = useAppStore()
    const old = deferred<unknown>()
    api.version.mockReturnValueOnce(old.promise)
    const request = store.fetchVersion()
    setActiveConnection(connection('b'))
    old.resolve({ current_version: 'old', latest_version: 'old-update', has_update: true })
    expect(await request).toBeNull()
    expect(store.hasUpdate).toBe(false)
    expect(store.currentVersion).toBe('')
  })

  it('does not let late admin settings overwrite the new source features or menus', async () => {
    const store = useAdminSettingsStore()
    const old = deferred<unknown>()
    api.settings.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ ops_monitoring_enabled: true, custom_menu_items: [] })
    api.payment.mockResolvedValue({ data: { enabled: false } })
    const request = store.fetch()
    setActiveConnection(connection('b'))
    await store.fetch()
    old.resolve({ ops_monitoring_enabled: false, custom_menu_items: [{ id: 'old-menu' }] })
    await request
    expect(store.opsMonitoringEnabled).toBe(true)
    expect(store.customMenuItems).toEqual([])
    expect(localStorage.getItem('ops_monitoring_enabled_cached')).toBe('true')
  })

  it('discards old announcements and pending read acknowledgements with identical IDs', async () => {
    const store = useAnnouncementStore()
    api.announcements.mockResolvedValueOnce([announcement('A')])
    await store.fetchAnnouncements()
    const read = deferred<void>()
    api.markRead.mockReturnValueOnce(read.promise)
    const reading = store.markAsRead(1)
    const old = deferred<UserAnnouncement[]>()
    api.announcements.mockReturnValueOnce(old.promise).mockResolvedValueOnce([announcement('B')])
    const refreshing = store.fetchAnnouncements(true)
    setActiveConnection(connection('b'))
    expect(store.currentPopup).toBeNull()
    await store.fetchAnnouncements()
    old.resolve([announcement('stale A')])
    read.resolve()
    await Promise.all([reading, refreshing])
    expect(store.announcements[0].title).toBe('B')
    expect(store.announcements[0].read_at).toBeNull()
    expect(store.currentPopup?.title).toBe('B')
  })

  it('discards old subscriptions without clearing the new request loading state', async () => {
    const store = useSubscriptionStore()
    const old = deferred<UserSubscription[]>()
    const next = deferred<UserSubscription[]>()
    api.subscriptions.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
    const oldRequest = store.fetchActiveSubscriptions()
    setActiveConnection(connection('b'))
    const newRequest = store.fetchActiveSubscriptions()
    old.resolve([{ id: 1 } as UserSubscription])
    await oldRequest
    expect(store.loading).toBe(true)
    expect(store.activeSubscriptions).toEqual([])
    next.resolve([{ id: 2 } as UserSubscription])
    await newRequest
    expect(store.activeSubscriptions.map((subscription) => subscription.id)).toEqual([2])
  })

  it('does not open another server compliance dialog after switching', async () => {
    const store = useAdminComplianceStore()
    const old = deferred<AdminComplianceStatus>()
    api.compliance.mockReturnValueOnce(old.promise)
    const request = store.fetchStatus()
    setActiveConnection(connection('b'))
    old.resolve({ required: true, version: 'old' } as AdminComplianceStatus)
    await request
    expect(store.status).toBeNull()
    expect(store.initialized).toBe(false)
    expect(store.shouldShow).toBe(false)
  })
})
