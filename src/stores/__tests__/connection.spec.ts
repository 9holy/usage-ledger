/**
 * connection store 测试 — 远程连接 + 2FA 流程
 *
 * 覆盖此前修过的 bug:
 * - 2FA 输错码无法重试:complete2FA 失败时保留 pending2FA(temp_token 不清),成功才清
 * - connectWithLogin 触发 2FA 时暂存 temp_token,供 complete2FA 换 JWT
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { LoginResponse, AuthResponse } from '@/api/auth'

// ---- mock 依赖 ----
const authAPI = vi.hoisted(() => ({
  login: vi.fn(),
  login2FA: vi.fn(),
  isTotp2FARequired: vi.fn<(r: LoginResponse) => r is { requires_2fa: true; temp_token: string }>(),
  getTokenExpiresAt: vi.fn(() => null),
  refreshToken: vi.fn(),
}))

vi.mock('@/api/auth', () => ({
  login: (...args: unknown[]) => authAPI.login(...args),
  login2FA: (...args: unknown[]) => authAPI.login2FA(...args),
  isTotp2FARequired: (r: LoginResponse) => authAPI.isTotp2FARequired(r),
  getTokenExpiresAt: () => authAPI.getTokenExpiresAt(),
  refreshToken: () => authAPI.refreshToken(),
}))

vi.mock('@/api/url', () => ({
  setActiveConnection: vi.fn(),
  getActiveConnection: vi.fn(() => null),
  authConnectionBindingMatches: vi.fn(() => false),
  getAPIBaseURL: vi.fn(() => '/api/v1'),
  isDesktopRuntime: vi.fn(() => false),
  redirectToAppPath: vi.fn(),
  buildApiUrl: vi.fn(),
  buildGatewayUrl: vi.fn(),
}))

// apiClient:connect() 验证请求用,sub2api 打 /admin/groups/all
const apiClient = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}))
vi.mock('@/api/client', () => ({ apiClient }))

// cliproxyClient:cliproxy 连接验证用(管理 secret-key 调 /auth-files,纯本地不外联 GitHub)
const cliproxyClient = vi.hoisted(() => ({
  get: vi.fn(),
}))
vi.mock('@/api/cliproxy', () => ({ cliproxyClient }))

// global fetch:cliproxy 连接验证业务 key 调 /v1/models(原生 fetch,不经 axios)
const fetchMock = vi.hoisted(() => vi.fn())
globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch

// auth store mock:connectWithApiKey/checkAuth/login2FA/logout
const authStore = vi.hoisted(() => ({
  connectWithApiKey: vi.fn(),
  checkAuth: vi.fn(),
  login2FA: vi.fn(),
  logout: vi.fn(async () => {}),
}))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => authStore }))

// crypto.randomUUID 稳定化(jsdom 的 crypto 是只读 getter,需 defineProperty 覆盖)
function stubUUID() {
  let n = 0
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { randomUUID: () => `uuid-${++n}` },
  })
}

async function loadStore() {
  const mod = await import('@/stores/connection')
  return mod.useConnectionStore()
}

function make2FAResponse(tempToken: string): LoginResponse {
  return { requires_2fa: true, temp_token: tempToken } as unknown as LoginResponse
}

function makeJWTResponse(jwt: string): AuthResponse {
  return {
    access_token: jwt,
    refresh_token: 'r',
    expires_in: 3600,
    token_type: 'Bearer',
    user: { id: 1, role: 'admin', email: 'a@b.c' },
  } as unknown as AuthResponse
}

describe('connection store — 2FA 流程', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
    vi.clearAllMocks()
    stubUUID()
    authAPI.isTotp2FARequired.mockImplementation((r: LoginResponse) =>
      typeof r === 'object' && r !== null && (r as any).requires_2fa === true,
    )
  })

  it('connectWithLogin 触发 2FA 时返回 requires2fa,暂存 temp_token', async () => {
    const store = await loadStore()
    const id = store.addConnection({
      name: 's2', type: 'sub2api', baseUrl: 'https://s2.example.com',
      apiKey: '', authMode: 'login',
    })
    authAPI.login.mockResolvedValueOnce(make2FAResponse('temp-abc'))

    const result = await store.connectWithLogin(id, 'a@b.c', 'pw')

    expect(result.requires2fa).toBe(true)
    expect(result.ok).toBe(false)
    // 2FA 待态:complete2FA 可用(不报"无待完成流程"),且 login2FA 被调(证明 temp_token 已暂存)
    const ok = await store.complete2FA('wrong-code')
    expect(ok.ok).toBe(true) // mockResolvedValue 默认成功;关键是 login2FA 被调用证明 pending 可达
    expect(authStore.login2FA).toHaveBeenCalledWith('temp-abc', 'wrong-code')
  })

  it('complete2FA 成功后写入 JWT 为连接 apiKey,并清除 pending2FA', async () => {
    const store = await loadStore()
    const id = store.addConnection({
      name: 's2', type: 'sub2api', baseUrl: 'https://s2.example.com',
      apiKey: '', authMode: 'login',
    })
    // 触发 2FA
    authAPI.login.mockResolvedValueOnce(make2FAResponse('temp-xyz'))
    await store.connectWithLogin(id, 'a@b.c', 'pw')

    // complete2FA:authStore.login2FA 成功 + JWT 写 localStorage
    authStore.login2FA.mockResolvedValueOnce({})
    localStorage.setItem('auth_token', 'final-jwt')

    const ok = await store.complete2FA('123456')

    expect(ok.ok).toBe(true)
    expect(authStore.login2FA).toHaveBeenCalledWith('temp-xyz', '123456')
    // JWT 存为连接 apiKey,后续请求带 Bearer
    const conn = store.connections.find(c => c.id === id)
    expect(conn?.apiKey).toBe('final-jwt')
    expect(conn?.authMode).toBe('login')
    expect(store.connected).toBe(true)
    // 成功后第二次 complete2FA 应报"无待完成流程"(pending 已清)
    const second = await store.complete2FA('000000')
    expect(second.ok).toBe(false)
    expect(second.error).toContain('无待完成')
    expect(second.requiresLogin).toBe(true)
  })

  it('complete2FA 失败时保留 pending2FA,可原地重试(不重输邮箱密码)', async () => {
    const store = await loadStore()
    const id = store.addConnection({
      name: 's2', type: 'sub2api', baseUrl: 'https://s2.example.com',
      apiKey: '', authMode: 'login',
    })
    authAPI.login.mockResolvedValueOnce(make2FAResponse('temp-keep'))
    await store.connectWithLogin(id, 'a@b.c', 'pw')

    // 第一次 complete2FA 失败(login2FA 抛错)
    authStore.login2FA.mockRejectedValueOnce(new Error('invalid totp'))
    const fail = await store.complete2FA('bad-code')
    expect(fail.ok).toBe(false)
    expect(fail.error).toBeTruthy() // Error.message 原样透传('invalid totp')
    expect(fail.requiresLogin).toBeUndefined()
    expect(store.connected).toBe(false)

    // 失败后 pending2FA 仍在:改码重试能用同一个 temp_token(无需重输邮箱密码)
    authStore.login2FA.mockResolvedValueOnce({})
    localStorage.setItem('auth_token', 'jwt-after-retry')
    const retry = await store.complete2FA('good-code')
    expect(retry.ok).toBe(true)
    // 两次都用同一个 temp_token(失败未清的回归守护)
    expect(authStore.login2FA).toHaveBeenNthCalledWith(1, 'temp-keep', 'bad-code')
    expect(authStore.login2FA).toHaveBeenNthCalledWith(2, 'temp-keep', 'good-code')
  })

  it.each(['removed', 'switched'])('complete2FA marks %s context as requiring login without calling the verifier', async (change) => {
    const store = await loadStore()
    const id = store.addConnection({ name: 's2', type: 'sub2api', baseUrl: 'https://s2.example.com', apiKey: '', authMode: 'login' })
    authAPI.login.mockResolvedValueOnce(make2FAResponse('temp-context'))
    await store.connectWithLogin(id, 'a@b.c', 'pw')
    if (change === 'removed') store.removeConnection(id)
    else store.clearActiveOnly()
    const result = await store.complete2FA('123456')
    expect(result.requiresLogin).toBe(true)
    expect(result.error).toContain(change === 'removed' ? '不存在' : '已切换')
    expect(authStore.login2FA).not.toHaveBeenCalled()
  })

  it('connectWithLogin 直接成功(无 2FA)写入 JWT 并连接', async () => {
    const store = await loadStore()
    const id = store.addConnection({
      name: 's2', type: 'sub2api', baseUrl: 'https://s2.example.com',
      apiKey: '', authMode: 'login',
    })
    // login 直接返回 JWT(无 requires_2fa),api/auth.login 内部已写 localStorage
    authAPI.login.mockImplementationOnce(async () => {
      const resp = makeJWTResponse('direct-jwt')
      localStorage.setItem('auth_token', 'direct-jwt')
      return resp
    })
    authStore.checkAuth.mockImplementation(() => {})

    const result = await store.connectWithLogin(id, 'a@b.c', 'pw')

    expect(result.ok).toBe(true)
    expect(result.requires2fa).toBeUndefined()
    const conn = store.connections.find(c => c.id === id)
    expect(conn?.apiKey).toBe('direct-jwt')
    expect(conn?.authMode).toBe('login')
    expect(store.connected).toBe(true)
  })
})

describe('connection store — 记住密码与静默重登', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
    vi.clearAllMocks()
    stubUUID()
    authAPI.isTotp2FARequired.mockImplementation((r: LoginResponse) =>
      typeof r === 'object' && r !== null && (r as any).requires_2fa === true,
    )
  })

  function makeLoginWriteJwt(jwt: string) {
    // 模拟 api/auth.login 的副作用:写 localStorage auth_token + token_expires_at(1 小时后过期)
    return authAPI.login.mockImplementationOnce(async () => {
      const resp = makeJWTResponse(jwt)
      localStorage.setItem('auth_token', jwt)
      localStorage.setItem('token_expires_at', String(Date.now() + 3600_000))
      return resp
    })
  }

  it('connectWithLogin 默认记住密码:store 内明文可用,localStorage 落盘为混淆值', async () => {
    const store = await loadStore()
    const id = store.addConnection({
      name: 's2', type: 'sub2api', baseUrl: 'https://s2.example.com',
      apiKey: '', authMode: 'login',
    })
    makeLoginWriteJwt('jwt-remembered')
    authStore.checkAuth.mockImplementation(() => {})

    const result = await store.connectWithLogin(id, 'a@b.c', 'my-secret-pw')

    expect(result.ok).toBe(true)
    const conn = store.connections.find(c => c.id === id)
    expect(conn?.password).toBe('my-secret-pw')
    expect(conn?.email).toBe('a@b.c')
    // 落盘是混淆值(base64 of encodeURIComponent),不含明文;新 store 加载能还原
    const raw = localStorage.getItem('2api-console.connections') ?? ''
    expect(raw).not.toContain('my-secret-pw')
    const reloaded = JSON.parse(raw) as Array<{ password: string }>
    expect(reloaded[0]?.password).not.toBe('my-secret-pw')
  })

  it('connectWithLogin 传 rememberPassword=false 清除已存密码', async () => {
    const store = await loadStore()
    const id = store.addConnection({
      name: 's2', type: 'sub2api', baseUrl: 'https://s2.example.com',
      apiKey: '', authMode: 'login', password: 'old-stored',
    })
    makeLoginWriteJwt('jwt-unremember')
    authStore.checkAuth.mockImplementation(() => {})

    const result = await store.connectWithLogin(id, 'a@b.c', 'pw', false)

    expect(result.ok).toBe(true)
    const conn = store.connections.find(c => c.id === id)
    expect(conn?.password).toBeUndefined()
    const raw = localStorage.getItem('2api-console.connections') ?? ''
    // 落盘数据里不残留旧密码明文(混淆值由第一个用例的往返逻辑保证)
    expect(raw).not.toContain('old-stored')
  })

  it('connectWithStoredJwt:JWT 过期 + 存了密码 → 静默重登成功', async () => {
    const store = await loadStore()
    const id = store.addConnection({
      name: 's2', type: 'sub2api', baseUrl: 'https://s2.example.com',
      apiKey: 'expired-jwt', authMode: 'login',
      email: 'a@b.c', password: 'stored-pw', tokenExpiresAt: Date.now() - 1000,
    })
    makeLoginWriteJwt('fresh-jwt')
    authStore.checkAuth.mockImplementation(() => {})

    const ok = await store.connectWithStoredJwt(id)

    expect(ok).toBe(true)
    // 静默重登:用连接里存的 email+password 调 /auth/login,不再要求用户重输
    expect(authAPI.login).toHaveBeenCalledWith({ email: 'a@b.c', password: 'stored-pw' })
    expect(store.connected).toBe(true)
    const conn = store.connections.find(c => c.id === id)
    expect(conn?.apiKey).toBe('fresh-jwt')
  })

  it('connectWithStoredJwt:JWT 丢失(localStorage 被清)+ 存了密码 → 静默重登成功', async () => {
    const store = await loadStore()
    const id = store.addConnection({
      name: 's2', type: 'sub2api', baseUrl: 'https://s2.example.com',
      apiKey: 'old-jwt', authMode: 'login',
      email: 'a@b.c', password: 'stored-pw', tokenExpiresAt: Date.now() + 3600_000,
    })
    // localStorage 无 auth_token(WebView2 数据重置场景)
    makeLoginWriteJwt('recovered-jwt')
    authStore.checkAuth.mockImplementation(() => {})

    const ok = await store.connectWithStoredJwt(id)

    expect(ok).toBe(true)
    expect(authAPI.login).toHaveBeenCalledWith({ email: 'a@b.c', password: 'stored-pw' })
    expect(store.connected).toBe(true)
  })

  it('connectWithStoredJwt:JWT 过期 + 未存密码 → 返回 false 引导手动重输,不发 login 请求', async () => {
    const store = await loadStore()
    const id = store.addConnection({
      name: 's2', type: 'sub2api', baseUrl: 'https://s2.example.com',
      apiKey: 'expired-jwt', authMode: 'login',
      email: 'a@b.c', tokenExpiresAt: Date.now() - 1000,
    })

    const ok = await store.connectWithStoredJwt(id)

    expect(ok).toBe(false)
    expect(authAPI.login).not.toHaveBeenCalled()
    expect(store.connected).toBe(false)
  })

  it('connectWithStoredJwt:JWT 仍有效 → 直接复用,不发 login 请求', async () => {
    const store = await loadStore()
    const id = store.addConnection({
      name: 's2', type: 'sub2api', baseUrl: 'https://s2.example.com',
      apiKey: 'live-jwt', authMode: 'login',
      email: 'a@b.c', password: 'stored-pw', tokenExpiresAt: Date.now() + 3600_000,
    })
    localStorage.setItem('auth_token', 'live-jwt')
    localStorage.setItem('auth_user', JSON.stringify({ id: 1, role: 'admin' }))
    authStore.checkAuth.mockImplementation(() => {})

    const ok = await store.connectWithStoredJwt(id)

    expect(ok).toBe(true)
    expect(authAPI.login).not.toHaveBeenCalled()
    expect(store.connected).toBe(true)
    expect(authStore.checkAuth).toHaveBeenCalled()
  })

  it('restoreActive:JWT 丢失 + 存了密码 → 启动时自动重登', async () => {
    const store = await loadStore()
    const id = store.addConnection({
      name: 's2', type: 'sub2api', baseUrl: 'https://s2.example.com',
      apiKey: '', authMode: 'login',
      email: 'a@b.c', password: 'stored-pw',
    })
    localStorage.setItem('2api-console.active', id)
    makeLoginWriteJwt('boot-jwt')
    authStore.checkAuth.mockImplementation(() => {})

    await store.restoreActive()

    expect(authAPI.login).toHaveBeenCalledWith({ email: 'a@b.c', password: 'stored-pw' })
    expect(store.connected).toBe(true)
    expect(store.activeId).toBe(id)
  })

  it('restoreActive:JWT 丢失 + 未存密码 → 清 active 引导手动登录(旧行为)', async () => {
    const store = await loadStore()
    const id = store.addConnection({
      name: 's2', type: 'sub2api', baseUrl: 'https://s2.example.com',
      apiKey: '', authMode: 'login', email: 'a@b.c',
    })
    localStorage.setItem('2api-console.active', id)

    await store.restoreActive()

    expect(authAPI.login).not.toHaveBeenCalled()
    expect(store.connected).toBe(false)
    expect(store.activeId).toBeNull()
    // 连接记录保留(含 email 供预填),只是清了 active 标记
    expect(store.connections.some(c => c.id === id)).toBe(true)
  })
})

describe('connection store — API Key / cliproxy 连接', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
    vi.clearAllMocks()
    stubUUID()
  })

  it('sub2api apikey 模式验证成功后注入占位管理员会话', async () => {
    const store = await loadStore()
    const id = store.addConnection({
      name: 's2', type: 'sub2api', baseUrl: 'https://s2.example.com',
      apiKey: 'admin-key', authMode: 'apikey',
    })
    apiClient.get.mockResolvedValueOnce({ data: [] })

    const ok = await store.connect(id)

    expect(ok).toBe(true)
    expect(store.connected).toBe(true)
    // 验证请求打到 /admin/groups/all(sub2api 验证端点)
    expect(apiClient.get).toHaveBeenCalledWith('/admin/groups/all')
    // apikey 模式注入占位管理员会话
    expect(authStore.connectWithApiKey).toHaveBeenCalledWith('admin-key')
  })

  it('连接失败时 connected=false 且不注入会话', async () => {
    const store = await loadStore()
    const id = store.addConnection({
      name: 's2', type: 'sub2api', baseUrl: 'https://s2.example.com',
      apiKey: 'bad-key', authMode: 'apikey',
    })
    apiClient.get.mockRejectedValueOnce(new Error('unauthorized'))

    const ok = await store.connect(id)

    expect(ok).toBe(false)
    expect(store.connected).toBe(false)
    expect(authStore.connectWithApiKey).not.toHaveBeenCalled()
    expect(store.error).toBeTruthy()
  })

  it('cliproxy 用 secret-key 调 /auth-files 验证(纯本地,不外联 GitHub)', async () => {
    const store = await loadStore()
    const id = store.addConnection({
      name: 'cp', type: 'cliproxy', baseUrl: 'https://cp.example.com',
      apiKey: 'xkey', secretKey: 'secret',
    })
    // secret-key 验证:cliproxyClient /auth-files 成功(纯本地端点,不用 /latest-version 避 GitHub 限流 502)
    cliproxyClient.get.mockResolvedValueOnce({ data: [] })

    const ok = await store.connect(id)

    expect(ok).toBe(true)
    expect(store.connected).toBe(true)
    // secret-key 经 cliproxyClient 调 /auth-files
    expect(cliproxyClient.get).toHaveBeenCalledWith('/auth-files')
    // cliproxy 模式注入占位管理员会话用 secretKey(非业务 apiKey)
    expect(authStore.connectWithApiKey).toHaveBeenCalledWith('secret')
  })

  it('cliproxy secret-key 无效(/auth-files 401)时连接失败,提示状态码', async () => {
    const store = await loadStore()
    const id = store.addConnection({
      name: 'cp', type: 'cliproxy', baseUrl: 'https://cp.example.com',
      apiKey: 'xkey', secretKey: 'bad-secret',
    })
    cliproxyClient.get.mockRejectedValueOnce({ status: 401, message: 'invalid management key' })

    const ok = await store.connect(id)

    expect(ok).toBe(false)
    expect(store.connected).toBe(false)
    // 错误含 baseUrl + 状态码,帮定位
    expect(store.error).toContain('cp.example.com')
    expect(store.error).toContain('401')
    expect(authStore.connectWithApiKey).not.toHaveBeenCalled()
  })
})
