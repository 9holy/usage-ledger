import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setActiveConnection, buildGatewayUrl, buildUpstreamApiUrl } from '../url'
import { fetchApi, fetchGateway } from '../fetch'

const proxy = vi.hoisted(() => ({ headers: vi.fn() }))
vi.mock('@/api/desktopProxy', () => ({ getDesktopProxyHeaders: proxy.headers }))

function connect(type: 'sub2api' | 'cliproxy' = 'sub2api', authMode: 'apikey' | 'login' = 'apikey') {
  setActiveConnection({ id: type, name: 'Fixture', type, authMode, baseUrl: 'https://upstream.example/prefix', apiKey: 'connection-key', lastUsed: 1 })
}

beforeEach(() => {
  setActiveConnection(null)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
  proxy.headers.mockReset().mockImplementation(async (target: string) => ({ 'X-Target-Base': target, 'X-Proxy-Token': 'native-token' }))
})
afterEach(() => {
  setActiveConnection(null)
  delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  vi.unstubAllGlobals()
})

describe('connection-bound fetch and gateway URLs', () => {
  it('keeps the remote gateway origin and deployment path in desktop resource URLs', () => {
    (window as any).__TAURI_INTERNALS__ = {}
    connect()
    expect(buildGatewayUrl('/v1/usage')).toBe('https://upstream.example/prefix/v1/usage')
    expect(buildUpstreamApiUrl('/api/v1/plugin-ui/session')).toBe('https://upstream.example/prefix/api/v1/plugin-ui/session')
  })

  it('forwards administrative streaming requests with the correct admin-key header', async () => {
    (window as any).__TAURI_INTERNALS__ = {}
    connect()
    await fetchApi('/admin/accounts/1/test', { method: 'POST', headers: { Authorization: 'Bearer previous-session', 'Content-Type': 'application/json' }, body: '{}' })
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    const headers = new Headers(init?.headers)
    expect(url).toBe('http://127.0.0.1:18765/admin/accounts/1/test')
    expect(headers.get('X-API-Key')).toBe('connection-key')
    expect(headers.has('Authorization')).toBe(false)
    expect(headers.get('X-Target-Base')).toBe('https://upstream.example/prefix/api/v1')
    expect(headers.get('X-Proxy-Token')).toBe('native-token')
  })

  it('keeps a business API key on gateway requests rather than replacing it with an admin key', async () => {
    (window as any).__TAURI_INTERNALS__ = {}
    connect()
    await fetchGateway('/v1/images/batches', { headers: { Authorization: 'Bearer business-key' } })
    const [url, init] = vi.mocked(fetch).mock.calls[0]
    const headers = new Headers(init?.headers)
    expect(url).toBe('http://127.0.0.1:18765/v1/images/batches')
    expect(headers.get('Authorization')).toBe('Bearer business-key')
    expect(headers.has('X-API-Key')).toBe(false)
    expect(headers.get('X-Target-Base')).toBe('https://upstream.example/prefix')
  })

  it('does not expose the native proxy token to directly accessed CLIProxyAPI servers', async () => {
    (window as any).__TAURI_INTERNALS__ = {}
    connect('cliproxy')
    await fetchGateway('/v1/models')
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://upstream.example/prefix/v1/models')
    expect(new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).has('X-Proxy-Token')).toBe(false)
    expect(proxy.headers).not.toHaveBeenCalled()
  })

  it('supports a configured public gateway without losing its deployment path', async () => {
    (window as any).__TAURI_INTERNALS__ = {}
    connect()
    await fetchGateway('/models', { headers: { Authorization: 'Bearer business-key' } }, 'https://gateway.example/prefix/v1')
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('http://127.0.0.1:18765/models')
    expect(new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).get('X-Target-Base')).toBe('https://gateway.example/prefix/v1')
  })

  it('never sends credentials if the native capability cannot be obtained', async () => {
    (window as any).__TAURI_INTERNALS__ = {}
    connect()
    proxy.headers.mockRejectedValueOnce(new Error('native unavailable'))
    await expect(fetchApi('/auth/login', { method: 'POST', body: '{"password":"private"}' })).rejects.toThrow('native unavailable')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('cancels a queued native request after switching connections', async () => {
    (window as any).__TAURI_INTERNALS__ = {}
    connect()
    let finish!: (headers: Record<string, string>) => void
    proxy.headers.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const pending = fetchApi('/admin/accounts/1/test', { method: 'POST' })
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    setActiveConnection(null)
    finish({ 'X-Proxy-Token': 'native-token' })
    await rejection
    expect(fetch).not.toHaveBeenCalled()
  })
})
