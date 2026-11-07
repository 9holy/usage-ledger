import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import axios, { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import { cliproxyClient } from '../client'
import { setActiveConnection } from '@/api/url'
import type { ConnectionConfig } from '@/stores/connection'

vi.mock('@/i18n', () => ({ getLocale: () => 'en' }))

const connection = (overrides: Partial<ConnectionConfig> = {}): ConnectionConfig => ({
  id: 'same-saved-connection', name: 'Synthetic CPA', type: 'cliproxy',
  baseUrl: 'https://cpa-a.example.test', apiKey: '', secretKey: 'fixture-key-a', lastUsed: 0,
  ...overrides,
})
const originalAdapter = cliproxyClient.defaults.adapter

beforeEach(() => setActiveConnection(connection()))
afterEach(() => { cliproxyClient.defaults.adapter = originalAdapter; setActiveConnection(null); vi.restoreAllMocks() })

describe('CLIProxyAPI management connection scope', () => {
  it.each([
    { label: 'URL', changed: { baseUrl: 'https://cpa-b.example.test' } },
    { label: 'management key', changed: { secretKey: 'fixture-key-b' } },
  ])('rejects an old successful response after the same saved ID changes $label', async ({ changed }) => {
    let complete!: (response: AxiosResponse) => void
    let sent!: () => void
    const dispatched = new Promise<void>(resolve => { sent = resolve })
    let request!: InternalAxiosRequestConfig
    cliproxyClient.defaults.adapter = config => {
      request = config
      sent()
      return new Promise<AxiosResponse>(resolve => { complete = resolve })
    }
    const pending = cliproxyClient.get('/config').then(value => value, error => error)
    await dispatched
    expect(request.baseURL).toBe('https://cpa-a.example.test/v0/management')
    expect(request.headers.get('Authorization')).toBe('Bearer fixture-key-a')
    setActiveConnection(connection(changed))
    complete({ data: { debug: false }, status: 200, statusText: 'OK', headers: {}, config: request })
    expect(axios.isCancel(await pending)).toBe(true)
  })

  it('does not attribute an old authentication error to the new management connection', async () => {
    let fail!: (error: AxiosError) => void
    let sent!: () => void
    const dispatched = new Promise<void>(resolve => { sent = resolve })
    let request!: InternalAxiosRequestConfig
    cliproxyClient.defaults.adapter = config => {
      request = config
      sent()
      return new Promise<AxiosResponse>((_, reject) => { fail = reject })
    }
    const pending = cliproxyClient.get('/auth-files').then(value => value, error => error)
    await dispatched
    setActiveConnection(connection({ secretKey: 'fixture-key-b' }))
    fail(new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', request, undefined,
      { data: { error: 'invalid management key' }, status: 401, statusText: 'Unauthorized', headers: {}, config: request }))
    expect(axios.isCancel(await pending)).toBe(true)
  })

  it('preserves a genuine empty inventory and explicit false on the unchanged connection', async () => {
    cliproxyClient.defaults.adapter = async config => ({ data: { files: [], debug: false }, status: 200, statusText: 'OK', headers: {}, config })
    expect((await cliproxyClient.get('/auth-files')).data).toEqual({ files: [], debug: false })
  })
})
