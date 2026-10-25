/**
 * 连接管理器 — 远程连接 Sub2API / CLI Proxy API
 *
 * 桌面端去掉内置 sub2api 后,通过此 store 管理多个远程连接配置。
 * baseUrl / type / apiKey 供 api/url.ts 与 api/client.ts 读取,按 type 注入认证 header。
 *
 * 两种认证:
 * - sub2api:Admin API Key(Bearer)或管理员账号登录拿 JWT(Bearer)
 * - cliproxy:X-API-Key
 */

import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { apiClient } from '@/api/client'
import { cliproxyClient } from '@/api/cliproxy'
import { login as apiLogin, refreshToken as apiRefreshToken, isTotp2FARequired, getTokenExpiresAt, type LoginResponse } from '@/api/auth'
import { authConnectionBindingMatches, setActiveConnection } from '@/api/url'
import { useAuthStore } from '@/stores/auth'

export type ConnectionType = 'sub2api' | 'cliproxy'
export type Sub2ApiAuthMode = 'apikey' | 'login'

export interface ConnectionConfig {
  id: string
  name: string
  type: ConnectionType
  baseUrl: string
  /** sub2api: API Key 或 JWT;cliproxy: 业务 API Key(/v1/* 验证用) */
  apiKey: string
  /** cliproxy 管理 secret-key(/v0/management/* 认证用,bcrypt 明文;sub2api 不用) */
  secretKey?: string
  /** sub2api 连接的认证方式(决定 401 时是否走 login) */
  authMode?: Sub2ApiAuthMode
  /** sub2api login 模式存的邮箱(JWT 过期时预填邮箱,用户只重输密码——未勾选记住密码时) */
  email?: string
  /** sub2api login 模式记住的密码(勾选"记住密码"才存;与 apiKey/secretKey 同为混淆存储而非加密)。
   *  存在时 JWT 过期/丢失走静默重登,不再要求手动重输;undefined 表示用户未勾选,维持旧行为。 */
  password?: string
  /** 该连接 JWT 过期时间戳(ms);有效期内点已保存连接直接复用 JWT,过期才要求重输密码 */
  tokenExpiresAt?: number
  /** cost 服务地址(可选,提供 economics/cost-loss 端点) */
  costServiceUrl?: string
  lastUsed: number
}

const STORAGE_KEY = '2api-console.connections'
const ACTIVE_KEY = '2api-console.active'

/** 简单混淆存储(非加密,但避免明文) */
function obfuscate(str: string): string {
  return btoa(encodeURIComponent(str))
}
function deobfuscate(str: string): string {
  try { return decodeURIComponent(atob(str)) } catch { return str }
}

/** 提取错误信息:axios 拦截器 reject 的是普通对象(非 Error 实例),需读其 message 字段,
 *  否则 client.ts 构造的 networkMessage(CORS 提示/真实 baseURL/401 原因)被吞成无信息字面量。 */
export function errMsg(e: unknown, fallback: string): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message)
  return fallback
}

function loadConnections(): ConnectionConfig[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const list = JSON.parse(raw) as Array<Record<string, unknown>>
    return list.map(c => ({
      ...c,
      apiKey: deobfuscate(String(c.apiKey)),
      secretKey: c.secretKey ? deobfuscate(String(c.secretKey)) : undefined,
      password: c.password ? deobfuscate(String(c.password)) : undefined,
    }) as unknown as ConnectionConfig)
  } catch (e) {
    console.warn('[connection] load failed', e)
    return []
  }
}

function saveConnections(conns: ConnectionConfig[]) {
  const safe = conns.map(c => ({
    ...c,
    apiKey: obfuscate(c.apiKey),
    secretKey: c.secretKey ? obfuscate(c.secretKey) : undefined,
    password: c.password ? obfuscate(c.password) : undefined,
  }))
  localStorage.setItem(STORAGE_KEY, JSON.stringify(safe))
}

function loadActiveId(): string | null {
  return localStorage.getItem(ACTIVE_KEY)
}

export const useConnectionStore = defineStore('connection', () => {
  const connections = ref<ConnectionConfig[]>(loadConnections())
  const activeId = ref<string | null>(loadActiveId())
  const connected = ref(false)
  const connecting = ref(false)
  const error = ref<string | null>(null)
  let connectionAttempt = 0
  /** 2FA 中间态:首次 /auth/login 拿到 temp_token 后暂存,待 complete2FA 用 */
  const pending2FA = ref<{ connectionId: string; baseUrl: string; tempToken: string } | null>(null)

  const active = computed(() =>
    connections.value.find(c => c.id === activeId.value) ?? null,
  )

  /** 管理台首页路径:cliproxy 连接 → /cliproxy/dashboard,sub2api 连接 → /admin/dashboard。
   *  替代散落各处的硬编码 '/admin/dashboard',实现条件路由分流。 */
  const adminHomePath = computed(() =>
    active.value?.type === 'cliproxy' ? '/admin/cost-center' : '/admin/dashboard',
  )

  function addConnection(conn: Omit<ConnectionConfig, 'id' | 'lastUsed'>) {
    const id = crypto.randomUUID()
    const newConn: ConnectionConfig = { ...conn, id, lastUsed: Date.now() }
    connections.value.push(newConn)
    saveConnections(connections.value)
    return id
  }

  function removeConnection(id: string) {
    connections.value = connections.value.filter(c => c.id !== id)
    saveConnections(connections.value)
    if (activeId.value === id) {
      connectionAttempt += 1
      activeId.value = null
      localStorage.removeItem(ACTIVE_KEY)
      connected.value = false
      setActiveConnection(null)
    }
  }

  function updateConnection(id: string, patch: Partial<ConnectionConfig>) {
    const idx = connections.value.findIndex(c => c.id === id)
    if (idx >= 0) {
      connections.value[idx] = { ...connections.value[idx], ...patch }
      saveConnections(connections.value)
    }
  }

  /**
   * 用 API Key 连接(cliproxy 或 sub2api apikey 模式)。
   * 验证方式:发一个轻量 admin 请求,成功即视为连接有效。
   */
  async function connect(id: string): Promise<boolean> {
    const conn = connections.value.find(c => c.id === id)
    if (!conn) return false
    const attempt = ++connectionAttempt

    connecting.value = true
    error.value = null

    try {
      activeId.value = id
      // 注入 url.ts 活跃连接,client.ts 拦截器据此拼 baseURL + 注入认证 header
      setActiveConnection(conn)
      // 验证连接:sub2api 用 groups/all,cliproxy 只用 secret-key 验证管理 API
      if (conn.type === 'sub2api') {
        await apiClient.get('/admin/groups/all')
      } else {
        // cliproxy 验证:secret-key 调 /auth-files(纯本地,不外联 GitHub)。
        // 不用 /latest-version——该端点查 GitHub 仓库遇 rate limit 会返 502 unexpected_status。
        await cliproxyClient.get('/auth-files')
      }
      if (attempt !== connectionAttempt) return false
      conn.lastUsed = Date.now()
      saveConnections(connections.value)
      localStorage.setItem(ACTIVE_KEY, id)
      connected.value = true
      // apikey/cliproxy 无 JWT,注入占位管理员会话让管理台视图放行
      // cliproxy 用 secretKey(sub2api apikey 模式用 apiKey),占位会话不调业务端点,仅放行路由
      useAuthStore().connectWithApiKey(conn.type === 'cliproxy' ? (conn.secretKey ?? '') : conn.apiKey)
      return true
    } catch (e: unknown) {
      if (attempt !== connectionAttempt) return false
      // cliproxy 连接失败含 baseUrl + 状态码,帮定位(unexpected_status 通常是远程 cliproxy 返的错误码,检查 baseUrl/secret-key)
      const err: any = e
      const detail = conn.type === 'cliproxy' && err?.status != null
        ? `连接 ${conn.baseUrl} 失败(状态 ${err.status}): ${err?.message || err?.code || '未知错误'}`
        : errMsg(e, '连接失败')
      error.value = detail
      connected.value = false
      activeId.value = null
      setActiveConnection(null)
      return false
    } finally {
      if (attempt === connectionAttempt) connecting.value = false
    }
  }

  /**
   * JWT 不可用(过期/丢失)时的兜底:连接勾选过"记住密码"(email+password 都在)则静默重登,
   * 返回重登结果;否则返回 false,由调用方引导用户重输密码。
   * 仅对 authMode === 'login' 生效(apikey/cliproxy 没有密码概念)。
   * 重登若要求 2FA,connectWithLogin 返回 ok:false(内部已暂存 temp_token),
   * 调用方回落到手动流程即可。
   */
  async function reloginWithStoredPassword(conn: ConnectionConfig): Promise<boolean> {
    if (conn.authMode !== 'login' || !conn.email || !conn.password) return false
    const result = await connectWithLogin(conn.id, conn.email, conn.password)
    return result.ok
  }

  /**
   * sub2api login 模式快速重连:JWT 仍在有效期内时直接复用,不要求重输密码。
   * 判断依据:连接存的 tokenExpiresAt 未过期(login 时从 localStorage token_expires_at 取)。
   * JWT 过期/丢失时:连接存了密码(记住密码)→ 静默重登;没存 → 返回 false 引导用户重输密码。
   */
  async function connectWithStoredJwt(id: string): Promise<boolean> {
    let conn = connections.value.find(c => c.id === id)
    if (!conn || conn.type !== 'sub2api' || conn.authMode !== 'login') return false
    // JWT 可能被 WebView2 数据重置清掉：tokenExpiresAt 仍在连接记录中但 localStorage 已无 JWT。
    // 必须检查 JWT 实际存在，否则返回 true 后 checkAuth 读不到 JWT，用户卡在"已连接但 401"状态。
    const jwt = localStorage.getItem('auth_token')
    if (!jwt || (jwt !== conn.apiKey && !authConnectionBindingMatches({ connection: conn })) || !localStorage.getItem('auth_user')) {
      return reloginWithStoredPassword(conn)
    }
    const attempt = ++connectionAttempt
    const expiresAt = jwt === conn.apiKey ? conn.tokenExpiresAt : Number(localStorage.getItem('token_expires_at'))
    if (!expiresAt || expiresAt <= Date.now()) {
      if (!localStorage.getItem('refresh_token')) return reloginWithStoredPassword(conn)
      activeId.value = id
      setActiveConnection(conn)
      try {
        const refreshed = await apiRefreshToken()
        if (attempt !== connectionAttempt || active.value?.id !== id || active.value.baseUrl !== conn.baseUrl) return false
        updateConnection(id, { apiKey: refreshed.access_token, tokenExpiresAt: getTokenExpiresAt() ?? Date.now() + refreshed.expires_in * 1000 })
        conn = connections.value.find((connection) => connection.id === id)!
      } catch {
        if (attempt !== connectionAttempt || active.value?.id !== id) return false
        return reloginWithStoredPassword(conn)
      }
    } else if (jwt !== conn.apiKey) {
      updateConnection(id, { apiKey: jwt, tokenExpiresAt: expiresAt })
      conn = connections.value.find((connection) => connection.id === id)!
    }

    connecting.value = true
    error.value = null
    try {
      activeId.value = id
      setActiveConnection(conn)
      // JWT 仍在有效期:直接复用,不发 /auth/login。checkAuth 读 localStorage 已存的 JWT+user
      // (login 时 auth.ts 已写 auth_token/auth_user/token_expires_at,本次复用同一份)
      localStorage.setItem(ACTIVE_KEY, id)
      connected.value = true
      useAuthStore().checkAuth()
      conn.lastUsed = Date.now()
      saveConnections(connections.value)
      return true
    } catch (e: unknown) {
      error.value = errMsg(e, '重连失败')
      connected.value = false
      activeId.value = null
      setActiveConnection(null)
      return false
    } finally {
      connecting.value = false
    }
  }

  /**
   * sub2api 账号登录模式:先调 /auth/login 拿 JWT,再建立连接。
   * 登录成功后把 JWT 存为该连接的 apiKey,connect 复用 Bearer 注入。
   * rememberPassword(默认 true):是否把密码一并存进连接记录(混淆存储),
   * 供 JWT 过期/丢失时 connectWithStoredJwt / restoreActive 静默重登;
   * 传 false 会清除已存的密码(用户在表单取消勾选"记住密码")。
   */
  async function connectWithLogin(
    id: string,
    email: string,
    password: string,
    rememberPassword = true,
  ): Promise<{ ok: boolean; requires2fa?: boolean; error?: string }> {
    const conn = connections.value.find(c => c.id === id)
    if (!conn || conn.type !== 'sub2api') return { ok: false, error: '连接不存在或不支持账号登录' }
    const attempt = ++connectionAttempt

    connecting.value = true
    error.value = null

    try {
      activeId.value = id
      // 登录前注入连接,使 /auth/login 的 baseURL 指向目标 sub2api(无认证 header,登录接口本身不需要)
      setActiveConnection(conn)
      const resp: LoginResponse = await apiLogin({ email, password })
      if (attempt !== connectionAttempt || activeId.value !== id || active.value?.baseUrl !== conn.baseUrl) return { ok: false, error: '登录期间连接已切换' }
      if (isTotp2FARequired(resp)) {
        // 2FA 需要后续补码:暂存 temp_token,等 complete2FA 用它换 JWT
        pending2FA.value = { connectionId: id, baseUrl: conn.baseUrl, tempToken: resp.temp_token ?? '' }
        return { ok: false, requires2fa: true }
      }
      // 拿到 JWT,更新连接 apiKey(同时刷新 url.ts 活跃连接引用,使后续请求带 Bearer)
      // 存 email 供下次重连预填;存 tokenExpiresAt 判断 JWT 是否仍有效(login 时 auth.ts 已写 localStorage token_expires_at)
      // rememberPassword 时同步存/刷新密码(静默重登用);false 则清除,维持"只记邮箱"旧行为
      updateConnection(id, {
        apiKey: resp.access_token,
        authMode: 'login',
        email,
        tokenExpiresAt: getTokenExpiresAt() ?? undefined,
        password: rememberPassword ? password : undefined,
        lastUsed: Date.now(),
      })
      setActiveConnection(connections.value.find(c => c.id === id) ?? null)
      saveConnections(connections.value)
      localStorage.setItem(ACTIVE_KEY, id)
      connected.value = true
      // JWT 模式:apiLogin 已写 localStorage,checkAuth 读回并拉用户信息
      useAuthStore().checkAuth()
      return { ok: true }
    } catch (e: unknown) {
      const message = errMsg(e, '登录失败')
      if (attempt === connectionAttempt && activeId.value === id && active.value?.baseUrl === conn.baseUrl) {
        error.value = message
        connected.value = false
        activeId.value = null
        setActiveConnection(null)
      }
      return { ok: false, error: message }
    } finally {
      if (attempt === connectionAttempt) connecting.value = false
    }
  }

  /**
   * 2FA 补码:用 pending2FA 的 temp_token 换 JWT,完成 sub2api 账号登录连接。
   * authStore.login2FA 内部 setAuthFromResponse 已写 localStorage JWT,此处取回作连接 apiKey。
   */
  async function complete2FA(totpCode: string): Promise<{ ok: boolean; error?: string; requiresLogin?: boolean }> {
    const pending = pending2FA.value
    if (!pending) return { ok: false, error: '无待完成的 2FA 流程', requiresLogin: true }
    const id = pending.connectionId
    const conn = connections.value.find(c => c.id === id)
    if (!conn) {
      pending2FA.value = null
      return { ok: false, error: '连接不存在', requiresLogin: true }
    }
    if (activeId.value !== id || conn.baseUrl !== pending.baseUrl) return { ok: false, error: '2FA 期间连接已切换', requiresLogin: true }
    const attempt = ++connectionAttempt

    connecting.value = true
    error.value = null
    try {
      // login2FA 成功后 JWT 已写入 localStorage('auth_token'),活跃连接仍是首次登录注入的 conn
      await useAuthStore().login2FA(pending.tempToken, totpCode)
      if (attempt !== connectionAttempt || activeId.value !== id || active.value?.baseUrl !== pending.baseUrl) return { ok: false, error: '2FA 期间连接已切换', requiresLogin: true }
      const jwt = localStorage.getItem('auth_token') ?? ''
      updateConnection(id, { apiKey: jwt, authMode: 'login', tokenExpiresAt: getTokenExpiresAt() ?? undefined, lastUsed: Date.now() })
      setActiveConnection(connections.value.find(c => c.id === id) ?? null)
      saveConnections(connections.value)
      localStorage.setItem(ACTIVE_KEY, id)
      connected.value = true
      pending2FA.value = null // 成功才清,失败保留 temp_token 供用户原地重试
      return { ok: true }
    } catch (e: unknown) {
      if (attempt !== connectionAttempt) return { ok: false, error: '2FA 期间连接已切换', requiresLogin: true }
      error.value = errMsg(e, '2FA 验证失败')
      return { ok: false, error: error.value ?? '2FA 验证失败' }
    } finally {
      if (attempt === connectionAttempt) connecting.value = false
    }
  }

  function disconnect() {
    connectionAttempt += 1
    activeId.value = null
    connected.value = false
    localStorage.removeItem(ACTIVE_KEY)
    setActiveConnection(null)
    useAuthStore().logout().catch(() => {/* 远程登出失败不阻塞本地清除 */})
  }

  /** 清除活跃连接标记但不触发 authStore.logout——供 cockpit 占位会话复用:
   *  cockpit 不是远程连接,需让 connectionStore.active 为 null 使 CostCenterView
   *  命中 connectionType === null 的 cockpit 分支,但保留 authStore 占位会话放行 requiresAdmin。
   *  ponytail: 不调 logout,避免清掉刚注入的 cockpit-local 占位会话;connected 保留 true 让管理台可进。 */
  function clearActiveOnly() {
    connectionAttempt += 1
    activeId.value = null
    localStorage.removeItem(ACTIVE_KEY)
    setActiveConnection(null)
  }

  /**
   * 应用启动时恢复上次活跃连接。
   * - sub2api login:JWT 恢复,真实性留给首个业务请求 401 处理。
   * - cliproxy:调 /v0/management/auth-files 轻验证(纯本地,不用 latest-version 避 GitHub 限流 502),
   *   不标 connected(清除 activeId + setActiveConnection(null)),让用户重新连,避免 stale 连接
   *   导致跳错首页或后续管理 API 全 401。占位会话仍注入放行路由。
   * 由 App.vue onMounted 调用。
   */
  async function restoreActive() {
    const id = loadActiveId()
    if (!id) return
    const conn = connections.value.find(c => c.id === id)
    if (!conn) return
    const attempt = ++connectionAttempt
    activeId.value = id
    setActiveConnection(conn)
    const authStore = useAuthStore()
    if (conn.type === 'cliproxy') {
      // cliproxy:占位会话(secretKey,非业务 apiKey——cliproxy 桌面端不用业务 key)
      authStore.connectWithApiKey(conn.secretKey ?? '')
      // 轻验证:/auth-files 纯本地不外联(不用 /latest-version,会查 GitHub 限流返 502)
      try {
        await cliproxyClient.get('/auth-files')
        if (attempt !== connectionAttempt) return
        connected.value = true
      } catch {
        if (attempt !== connectionAttempt) return
        // 旧连接已失效(secret-key 变/服务下线):清 active 但保留连接记录,引导用户重连
        activeId.value = null
        setActiveConnection(null)
        connected.value = false
        localStorage.removeItem(ACTIVE_KEY)
      }
    } else if (conn.authMode !== 'login') {
      // sub2api apikey:占位会话,乐观恢复(首个业务请求验真)
      authStore.connectWithApiKey(conn.apiKey)
      connected.value = true
    } else {
      // login:JWT 仍在 localStorage(apiLogin 写入),checkAuth 读回。
      // 如果 localStorage 中 JWT 已被 WebView2 数据重置清掉,不能乐观标 connected,
      // 否则用户卡在"已连接但 401"状态。
      if (!await connectWithStoredJwt(conn.id) && activeId.value === id) {
        // JWT 丢失:清 active 但保留连接记录(含 email 预填),引导用户重新登录
        activeId.value = null
        setActiveConnection(null)
        connected.value = false
        localStorage.removeItem(ACTIVE_KEY)
      }
    }
  }

  return {
    connections,
    activeId,
    active,
    adminHomePath,
    connected,
    connecting,
    error,
    addConnection,
    removeConnection,
    updateConnection,
    connect,
    connectWithStoredJwt,
    connectWithLogin,
    complete2FA,
    disconnect,
    clearActiveOnly,
    restoreActive,
  }
})
