import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import axios from 'axios'
const mocks = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn(), refresh: vi.fn() }))
vi.mock('@/api/client', () => ({ apiClient: { post: mocks.post, get: mocks.get } }))
vi.mock('@/api/cliproxy', () => ({ cliproxyClient: { get: vi.fn() } }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ checkAuth: vi.fn(), connectWithApiKey: vi.fn() }) }))
vi.mock('axios', () => ({ default: { post: mocks.refresh } }))
import { login, login2FA } from '../auth'
import { refreshAuthTokens } from '../tokenRefresh'
import { getActiveConnection, setActiveConnection } from '../url'
import { useConnectionStore } from '@/stores/connection'

const response = { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, token_type: 'Bearer', user: { id: 7, role: 'admin' } }
function currentConnection(baseUrl = 'https://source-a.example') {
  const store = useConnectionStore()
  const id = store.addConnection({ name: 'fixture', type: 'sub2api', authMode: 'login', baseUrl, apiKey: 'old-access', tokenExpiresAt: Date.now() + 3600_000 })
  store.activeId = id
  setActiveConnection(store.active)
  localStorage.setItem('auth_token', 'old-access')
  localStorage.setItem('refresh_token', 'old-refresh')
  localStorage.setItem('auth_user', JSON.stringify({ id: 7 }))
  localStorage.setItem('token_expires_at', String(Date.now() - 1))
  return { store, id }
}
beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
  setActiveConnection(null)
  vi.clearAllMocks()
})
afterEach(() => { setActiveConnection(null); delete (window as any).__TAURI_INTERNALS__ })

describe('connection-bound JWT commits', () => {
  it('login updates global, active request credential, persisted connection and expiry together', async () => {
    const { store, id } = currentConnection()
    mocks.post.mockResolvedValueOnce({ data: response })
    await login({ email: 'fixture@example.test', password: 'fixture' })
    expect(localStorage.getItem('auth_token')).toBe('new-access')
    expect(getActiveConnection()?.apiKey).toBe('new-access')
    expect(store.connections.find((connection) => connection.id === id)?.tokenExpiresAt).toBeGreaterThan(Date.now())
    const saved = JSON.parse(localStorage.getItem('2api-console.connections')!)[0]
    expect(decodeURIComponent(atob(saved.apiKey))).toBe('new-access')
  })

  it('2FA uses the same bound commit path', async () => {
    currentConnection()
    mocks.post.mockResolvedValueOnce({ data: response })
    await login2FA({ temp_token: 'fixture-temp', totp_code: '123456' })
    expect(getActiveConnection()?.apiKey).toBe('new-access')
    expect(localStorage.getItem('auth_token')).toBe('new-access')
  })

  it('desktop refresh targets the captured upstream through the proxy and synchronizes the connection', async () => {
    currentConnection()
    ;(window as any).__TAURI_INTERNALS__ = {}
    mocks.refresh.mockResolvedValueOnce({ data: { code: 0, data: response } })
    await refreshAuthTokens({ failedAccessToken: 'old-access' })
    expect(axios.post).toHaveBeenCalledWith('http://127.0.0.1:18765/auth/refresh', { refresh_token: 'old-refresh' }, expect.objectContaining({ headers: expect.objectContaining({ 'X-Target-Base': 'https://source-a.example/api/v1' }) }))
    expect(getActiveConnection()?.apiKey).toBe('new-access')
    expect(localStorage.getItem('auth_token')).toBe('new-access')
  })

  it('late login response does not overwrite another selected instance or its global session', async () => {
    const { store } = currentConnection()
    let resolve!: (value: unknown) => void
    mocks.post.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const pending = login({ email: 'fixture@example.test', password: 'fixture' })
    const b = store.addConnection({ name: 'B', type: 'sub2api', authMode: 'login', baseUrl: 'https://source-b.example', apiKey: 'b-access' })
    store.activeId = b
    setActiveConnection(store.active)
    localStorage.setItem('auth_token', 'b-access')
    resolve({ data: response })
    await expect(pending).rejects.toThrow('Connection changed')
    expect(getActiveConnection()?.apiKey).toBe('b-access')
    expect(localStorage.getItem('auth_token')).toBe('b-access')
  })

  it('late refresh response cannot be adopted after switching to another instance with the same user id', async () => {
    const { store } = currentConnection()
    let resolve!: (value: unknown) => void
    mocks.refresh.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    const pending = refreshAuthTokens({ failedAccessToken: 'old-access' })
    const rejected = expect(pending).rejects.toThrow('Session changed')
    const b = store.addConnection({ name: 'B', type: 'sub2api', authMode: 'login', baseUrl: 'https://source-b.example', apiKey: 'b-access' })
    store.activeId = b
    setActiveConnection(store.active)
    localStorage.setItem('auth_token', 'b-access')
    localStorage.setItem('refresh_token', 'b-refresh')
    resolve({ data: { code: 0, data: response } })
    await rejected
    expect(localStorage.getItem('auth_token')).toBe('b-access')
    expect(getActiveConnection()?.apiKey).toBe('b-access')
  })

  it('does not restore a saved JWT using an unrelated global token without its own saved password', async () => {
    const { store, id } = currentConnection()
    localStorage.setItem('auth_token', 'unbound-other-instance')
    expect(await store.connectWithStoredJwt(id)).toBe(false)
    expect(mocks.post).not.toHaveBeenCalled()
  })

  it('adopts a same-instance peer refresh when only the in-memory connection snapshot is old', async () => {
    const { store, id } = currentConnection()
    localStorage.setItem('2api-console.auth-connection', JSON.stringify({ id, baseUrl: store.active!.baseUrl }))
    localStorage.setItem('auth_token', 'peer-access')
    localStorage.setItem('refresh_token', 'peer-refresh')
    localStorage.setItem('token_expires_at', String(Date.now() + 3600_000))
    await expect(refreshAuthTokens({ failedAccessToken: 'old-access' })).resolves.toMatchObject({ access_token: 'peer-access' })
    expect(mocks.refresh).not.toHaveBeenCalled()
    expect(getActiveConnection()?.apiKey).toBe('peer-access')
  })

  it('restores an expired access token with its own refresh token without a saved password', async () => {
    const { store, id } = currentConnection()
    store.updateConnection(id, { tokenExpiresAt: Date.now() - 1 })
    setActiveConnection(store.active)
    mocks.refresh.mockResolvedValueOnce({ data: { code: 0, data: response } })
    expect(await store.connectWithStoredJwt(id)).toBe(true)
    expect(mocks.post).not.toHaveBeenCalled()
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
    expect(store.connected).toBe(true)
    expect(getActiveConnection()?.apiKey).toBe('new-access')
  })
})
