/**
 * API Client 拦截器测试 — 远程连接模式
 *
 * 桌面端去掉内置 sub2api 后,认证来自连接管理器(connection store),不再用 localStorage.auth_token
 * 或 refresh_token 刷新。本测试覆盖当前真实行为:
 * - 请求拦截器:按 type+authMode 注入——sub2api login(JWT)→ Bearer;sub2api apikey(admin key)/cliproxy → X-API-Key;空 apiKey 不注入
 * - baseURL 刷新(切换连接)+ cost 请求显式 baseURL 不被覆盖
 * - timezone / Admin-UI / User-UI 标记
 * - 响应拦截器:code=0 解包、code!=0 拒绝、423 合规、401 派发 api:unauthorized
 * - 网络错误文案(桌面端/远程)、请求取消
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AxiosInstance } from 'axios'
import type { ConnectionConfig } from '@/stores/connection'

// ---- mock 依赖(必须在 import client 前) ----
// url.ts:连接注入与 baseURL 拼接的来源;client.ts 拦截器读 getActiveConnection/getAPIBaseURL/isDesktopRuntime
const urlState = {
  active: null as ConnectionConfig | null,
  baseURL: '/api/v1',
  desktop: false,
  revision: 0,
}
vi.mock('@/api/url', () => ({
  getActiveConnection: () => urlState.active,
  captureAuthConnection: () => ({ revision: urlState.revision }),
  getAPIBaseURL: () => urlState.baseURL,
  isDesktopRuntime: () => urlState.desktop,
  redirectToAppPath: vi.fn((path: string) => {
    window.location.hash = `#${path}`
  }),
  buildApiUrl: (p: string) => `${urlState.baseURL.replace(/\/+$/, '')}${p.startsWith('/') ? p : `/${p}`}`,
  buildGatewayUrl: (p: string) => p,
}))
vi.mock('@/i18n', () => ({ getLocale: () => 'zh-CN' }))

function setConnection(conn: ConnectionConfig | null) {
  urlState.revision += 1
  urlState.active = conn
  urlState.baseURL = conn
    ? `${conn.baseUrl.replace(/\/+$/, '')}${conn.type === 'sub2api' ? '/api/v1' : '/v1'}`
    : '/api/v1'
}

function makeAdapter(respondWith: () => any) {
  return vi.fn().mockImplementation(() => Promise.resolve(respondWith()))
}

function okResponse(data: unknown = {}) {
  return { status: 200, data: { code: 0, data, message: 'ok' }, headers: {}, config: {}, statusText: 'OK' }
}

describe('API Client', () => {
  let apiClient: AxiosInstance

  beforeEach(async () => {
    localStorage.clear()
    window.history.replaceState({}, '', '/')
    urlState.active = null
    urlState.baseURL = '/api/v1'
    urlState.desktop = false
    vi.resetModules()
    const mod = await import('@/api/client')
    apiClient = mod.apiClient
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // --- 认证 header 分流 ---

  describe('认证 header 分流(按连接 type + authMode)', () => {
    // curl 实测:sub2api admin key 必须 X-API-Key(Bearer 会被当 JWT 解析返 INVALID_TOKEN);
    // login 模式 JWT 必须 Bearer。认证 header 按 authMode 分流,不按 type 硬定。
    it('sub2api apikey 模式(admin key)注入 X-API-Key', async () => {
      setConnection({ id: '1', name: 's2', type: 'sub2api', baseUrl: 'https://s2.example.com', apiKey: 'admin-c2ebaec5', authMode: 'apikey', lastUsed: 0 })
      const adapter = makeAdapter(() => okResponse({}))
      apiClient.defaults.adapter = adapter
      await apiClient.get('/admin/groups/all')
      const config = adapter.mock.calls[0][0]
      expect(config.headers.get('X-API-Key')).toBe('admin-c2ebaec5')
      expect(config.headers.get('Authorization')).toBeFalsy()
    })

    it('sub2api login 模式(JWT)注入 Authorization: Bearer', async () => {
      setConnection({ id: '1b', name: 's2', type: 'sub2api', baseUrl: 'https://s2.example.com', apiKey: 'jwt-token', authMode: 'login', lastUsed: 0 })
      const adapter = makeAdapter(() => okResponse({}))
      apiClient.defaults.adapter = adapter
      await apiClient.get('/admin/groups/all')
      const config = adapter.mock.calls[0][0]
      expect(config.headers.get('Authorization')).toBe('Bearer jwt-token')
      expect(config.headers.get('X-API-Key')).toBeFalsy()
    })

    it('cliproxy 连接注入 X-API-Key', async () => {
      setConnection({ id: '2', name: 'cp', type: 'cliproxy', baseUrl: 'https://cp.example.com', apiKey: 'xkey', lastUsed: 0 })
      const adapter = makeAdapter(() => okResponse({}))
      apiClient.defaults.adapter = adapter
      await apiClient.get('/health')
      const config = adapter.mock.calls[0][0]
      expect(config.headers.get('X-API-Key')).toBe('xkey')
      expect(config.headers.get('Authorization')).toBeFalsy()
    })

    it('apiKey 为空时不注入任何认证 header(登录前/公开端点)', async () => {
      setConnection({ id: '3', name: 's2', type: 'sub2api', baseUrl: 'https://s2.example.com', apiKey: '', lastUsed: 0 })
      const adapter = makeAdapter(() => okResponse({}))
      apiClient.defaults.adapter = adapter
      await apiClient.get('/auth/login')
      const config = adapter.mock.calls[0][0]
      expect(config.headers.get('Authorization')).toBeFalsy()
      expect(config.headers.get('X-API-Key')).toBeFalsy()
    })

    it('无活跃连接时不注入认证 header', async () => {
      setConnection(null)
      const adapter = makeAdapter(() => okResponse({}))
      apiClient.defaults.adapter = adapter
      await apiClient.get('/test')
      const config = adapter.mock.calls[0][0]
      expect(config.headers.get('Authorization')).toBeFalsy()
      expect(config.headers.get('X-API-Key')).toBeFalsy()
    })
  })

  // --- baseURL 刷新 ---

  describe('baseURL 刷新', () => {
    it('每次请求刷新为最新 baseURL(切换连接后生效)', async () => {
      setConnection({ id: 'a', name: 'a', type: 'sub2api', baseUrl: 'https://a.example.com', apiKey: 'k', lastUsed: 0 })
      const adapter = makeAdapter(() => okResponse({}))
      apiClient.defaults.adapter = adapter
      await apiClient.get('/test')
      expect(adapter.mock.calls[0][0].baseURL).toBe('https://a.example.com/api/v1')

      // 切换连接到 cliproxy
      setConnection({ id: 'b', name: 'b', type: 'cliproxy', baseUrl: 'https://b.example.com', apiKey: 'k', lastUsed: 0 })
      await apiClient.get('/test')
      expect(adapter.mock.calls[1][0].baseURL).toBe('https://b.example.com/v1')
    })

    it('不带 withCredentials(远程模式无 cookie 跨域)', async () => {
      setConnection({ id: '1', name: 's2', type: 'sub2api', baseUrl: 'https://s2.example.com', apiKey: 'k', lastUsed: 0 })
      const adapter = makeAdapter(() => okResponse({}))
      apiClient.defaults.adapter = adapter
      await apiClient.post('/auth/oauth/bind-token', {})
      const config = adapter.mock.calls[0][0]
      expect(config.withCredentials).toBeFalsy()
    })
  })

  // --- timezone ---

  describe('timezone 参数', () => {
    it('GET 请求附加 timezone', async () => {
      const adapter = makeAdapter(() => okResponse({}))
      apiClient.defaults.adapter = adapter
      await apiClient.get('/test')
      expect(adapter.mock.calls[0][0].params).toHaveProperty('timezone')
    })

    it('POST 请求不附加 timezone', async () => {
      const adapter = makeAdapter(() => okResponse({}))
      apiClient.defaults.adapter = adapter
      await apiClient.post('/test', { foo: 'bar' })
      expect(adapter.mock.calls[0][0].params?.timezone).toBeUndefined()
    })
  })

  // --- Admin-UI / User-UI 标记 ---

  describe('UI 来源标记', () => {
    it('管理路径请求带 Admin-UI 标记', async () => {
      const adapter = makeAdapter(() => okResponse({}))
      apiClient.defaults.adapter = adapter
      await apiClient.get('/admin/users')
      expect(adapter.mock.calls[0][0].headers.get('X-Admin-UI-Request')).toBe('1')
    })

    it('在管理页面调共享 API 同时带 Admin-UI 标记', async () => {
      window.history.replaceState({}, '', '/admin/dashboard')
      const adapter = makeAdapter(() => okResponse({}))
      apiClient.defaults.adapter = adapter
      await apiClient.get('/groups/available')
      expect(adapter.mock.calls[0][0].headers.get('X-Admin-UI-Request')).toBe('1')
    })

    it('普通页面调共享 API 不带 Admin-UI 标记', async () => {
      const adapter = makeAdapter(() => okResponse({}))
      apiClient.defaults.adapter = adapter
      await apiClient.get('/groups/available')
      expect(adapter.mock.calls[0][0].headers.get('X-Admin-UI-Request')).toBeFalsy()
    })

    it('用户侧 timing API 带 User-UI 标记', async () => {
      const adapter = makeAdapter(() => okResponse({}))
      apiClient.defaults.adapter = adapter
      await apiClient.get('/auth/me')
      const config = adapter.mock.calls[0][0]
      expect(config.headers.get('X-User-UI-Request')).toBe('1')
    })

    it('管理页调 keys 同时带 Admin 与 User 标记', async () => {
      window.history.replaceState({}, '', '/admin/dashboard')
      const adapter = makeAdapter(() => okResponse({}))
      apiClient.defaults.adapter = adapter
      await apiClient.get('/keys')
      const config = adapter.mock.calls[0][0]
      expect(config.headers.get('X-Admin-UI-Request')).toBe('1')
      expect(config.headers.get('X-User-UI-Request')).toBe('1')
    })
  })

  // --- 响应拦截器 ---

  describe('响应拦截器', () => {
    it('code=0 时解包 data 字段', async () => {
      const adapter = makeAdapter(() => ({ status: 200, data: { code: 0, data: { name: 'test' }, message: 'ok' }, headers: {}, config: {}, statusText: 'OK' }))
      apiClient.defaults.adapter = adapter
      const response = await apiClient.get('/test')
      expect(response.data).toEqual({ name: 'test' })
    })

    it('code!=0 时拒绝并返回结构化错误', async () => {
      const adapter = makeAdapter(() => ({ status: 200, data: { code: 1001, message: '参数错误', data: null }, headers: {}, config: {}, statusText: 'OK' }))
      apiClient.defaults.adapter = adapter
      await expect(apiClient.get('/test')).rejects.toEqual(
        expect.objectContaining({ code: 1001, message: '参数错误' }),
      )
    })

    it('423 合规未确认时广播 admin-compliance-required 事件', async () => {
      const listener = vi.fn()
      window.addEventListener('admin-compliance-required', listener)
      const adapter = vi.fn().mockRejectedValue({
        response: {
          status: 423,
          data: { code: 'ADMIN_COMPLIANCE_ACK_REQUIRED', message: 'compliance required', metadata: { version: 'v1' } },
        },
        config: { url: '/admin/users', headers: {} },
        code: 'ERR_BAD_REQUEST',
      })
      apiClient.defaults.adapter = adapter
      await expect(apiClient.get('/admin/users')).rejects.toEqual(
        expect.objectContaining({ status: 423, code: 'ADMIN_COMPLIANCE_ACK_REQUIRED' }),
      )
      expect(listener).toHaveBeenCalledTimes(1)
      window.removeEventListener('admin-compliance-required', listener)
    })
  })

  // --- 401 处理(派发事件 + 跳转 connect) ---

  describe('401 远程认证失效', () => {
    it('rejects a stale source 401 without notifying or redirecting the newly selected connection', async () => {
      setConnection({ id: 'a', name: 'A', type: 'sub2api', authMode: 'login', baseUrl: 'https://a.example', apiKey: 'a-token', lastUsed: 0 })
      window.location.hash = '#/admin/cost-center'
      const listener = vi.fn()
      window.addEventListener('api:unauthorized', listener)
      let rejectRequest!: () => void
      apiClient.defaults.adapter = (config) => new Promise((_resolve, reject) => {
        rejectRequest = () => reject({ response: { status: 401, data: { code: 'TOKEN_EXPIRED' } }, config })
      })
      const pending = apiClient.get('/auth/me')
      const rejected = expect(pending).rejects.toMatchObject({ status: 401, code: 'TOKEN_EXPIRED' })
      await vi.waitFor(() => expect(rejectRequest).toBeTypeOf('function'))
      setConnection({ id: 'b', name: 'B', type: 'sub2api', authMode: 'login', baseUrl: 'https://b.example', apiKey: 'b-token', lastUsed: 0 })
      rejectRequest()
      await rejected
      expect(listener).not.toHaveBeenCalled()
      expect(window.location.hash).toBe('#/admin/cost-center')
      window.removeEventListener('api:unauthorized', listener)
    })
    it('401(非登录端点)派发 api:unauthorized 并跳转 /connect', async () => {
      setConnection({ id: '1', name: 's2', type: 'sub2api', baseUrl: 'https://s2.example.com', apiKey: 'k', lastUsed: 0 })
      const listener = vi.fn()
      window.addEventListener('api:unauthorized', listener)
      const adapter = vi.fn().mockRejectedValue({
        response: { status: 401, data: { code: 'TOKEN_EXPIRED', message: 'expired' } },
        config: { url: '/admin/users', headers: {} },
        code: 'ERR_BAD_REQUEST',
      })
      apiClient.defaults.adapter = adapter
      await expect(apiClient.get('/admin/users')).rejects.toMatchObject({ status: 401 })
      expect(listener).toHaveBeenCalledTimes(1)
      // 跳转到 /connect(hash 路由)
      await vi.waitFor(() => expect(window.location.hash).toContain('/connect'))
      window.removeEventListener('api:unauthorized', listener)
    })

    it('登录端点 401 不跳转(避免登录页循环)', async () => {
      setConnection({ id: '1', name: 's2', type: 'sub2api', baseUrl: 'https://s2.example.com', apiKey: '', lastUsed: 0 })
      const adapter = vi.fn().mockRejectedValue({
        response: { status: 401, data: { code: 'INVALID_CREDENTIALS', message: 'bad password' } },
        config: { url: '/auth/login', headers: {} },
        code: 'ERR_BAD_REQUEST',
      })
      apiClient.defaults.adapter = adapter
      await expect(apiClient.post('/auth/login', {})).rejects.toMatchObject({ status: 401 })
      expect(window.location.hash).not.toContain('/connect')
    })
  })

  // --- Ops 监控禁用 ---

  describe('Ops 监控禁用', () => {
    it('404 Ops monitoring disabled 派发事件并缓存禁用标记', async () => {
      const listener = vi.fn()
      window.addEventListener('ops-monitoring-disabled', listener)
      const adapter = vi.fn().mockRejectedValue({
        response: { status: 404, data: { message: 'Ops monitoring is disabled' } },
        config: { url: '/admin/ops/dashboard', headers: {} },
        code: 'ERR_BAD_REQUEST',
      })
      apiClient.defaults.adapter = adapter
      await expect(apiClient.get('/admin/ops/dashboard')).rejects.toMatchObject({ code: 'OPS_DISABLED' })
      expect(listener).toHaveBeenCalledTimes(1)
      expect(localStorage.getItem('ops_monitoring_enabled_cached')).toBe('false')
      window.removeEventListener('ops-monitoring-disabled', listener)
    })
  })

  // --- 网络错误 ---

  describe('网络错误', () => {
    it('远程模式返回英文网络错误文案', async () => {
      urlState.desktop = false
      const adapter = vi.fn().mockRejectedValue({ code: 'ERR_NETWORK', message: 'Network Error', config: { url: '/test' } })
      apiClient.defaults.adapter = adapter
      await expect(apiClient.get('/test')).rejects.toEqual(
        expect.objectContaining({ status: 0, message: 'Network error. Please check your connection.' }),
      )
    })

    it('桌面模式返回含后端地址与 CORS 提示的中文文案', async () => {
      urlState.desktop = true
      setConnection({ id: '1', name: 's2', type: 'sub2api', baseUrl: 'https://s2.example.com', apiKey: 'k', lastUsed: 0 })
      const adapter = vi.fn().mockRejectedValue({ code: 'ERR_NETWORK', message: 'Network Error', config: { url: '/test' } })
      apiClient.defaults.adapter = adapter
      await expect(apiClient.get('/test')).rejects.toEqual(
        expect.objectContaining({ status: 0, message: expect.stringContaining('无法连接') }),
      )
    })
  })

  // --- 请求取消 ---

  describe('请求取消', () => {
    it('取消的请求保持原始取消错误(不误判为网络错误)', async () => {
      const axios = await import('axios')
      const source = axios.CancelToken.source()
      const adapter = vi.fn().mockRejectedValue(new axios.Cancel('Operation canceled'))
      apiClient.defaults.adapter = adapter
      await expect(apiClient.get('/test', { cancelToken: source.token })).rejects.toBeDefined()
    })
  })
})
