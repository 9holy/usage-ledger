import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

beforeEach(() => {
  vi.resetModules()
  vi.mocked(invoke).mockReset()
})

describe('desktop proxy capability', () => {
  it('shares a native session token without mixing request targets', async () => {
    vi.mocked(invoke).mockResolvedValue('native-session-token')
    const { getDesktopProxyHeaders } = await import('../desktopProxy')
    const [first, second] = await Promise.all([
      getDesktopProxyHeaders('https://first.example/api/v1'),
      getDesktopProxyHeaders('https://second.example/api/v1'),
    ])
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('get_proxy_token')
    expect(first).toEqual({ 'X-Target-Base': 'https://first.example/api/v1', 'X-Proxy-Token': 'native-session-token' })
    expect(second).toEqual({ 'X-Target-Base': 'https://second.example/api/v1', 'X-Proxy-Token': 'native-session-token' })
  })

  it('fails closed when native authorization fails and can retry a failed invocation', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('native unavailable')).mockResolvedValueOnce('retry-token')
    const { getDesktopProxyHeaders } = await import('../desktopProxy')
    await expect(getDesktopProxyHeaders('https://example.test')).rejects.toThrow('native unavailable')
    await expect(getDesktopProxyHeaders('https://example.test')).resolves.toMatchObject({ 'X-Proxy-Token': 'retry-token' })
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it.each(['', 'bad\r\nheader', null])('rejects an invalid native token %s', async (token) => {
    vi.mocked(invoke).mockResolvedValue(token)
    const { getDesktopProxyHeaders } = await import('../desktopProxy')
    await expect(getDesktopProxyHeaders('https://example.test')).rejects.toThrow('valid session token')
  })
})
