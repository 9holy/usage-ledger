/**
 * API URL 解析 — 远程连接模式 + 桌面端本地反代绕 CORS
 *
 * 桌面端 WebView2 跨域请求远程 sub2api 会被 CORS 预检拦截(远程不响应 OPTIONS)。
 * 解法:Rust 壳起本地反代 127.0.0.1:PROXY_PORT,前端 baseURL 指本地反代,
 * 远程真实地址通过 X-Target-Base header 传(client.ts 注入),反代 reqwest 转发。
 *
 * - 桌面运行时:getAPIBaseURL/getCostServiceBaseURL 返本地反代地址(无前缀);
 *   远程拼接(baseUrl+前缀)由 getSub2apiTargetBase/getCostTargetBase 提供,供 client.ts 注入 target header。
 * - 非桌面(web/dev 同源):走原逻辑,baseURL 即远程地址。
 */

import type { ConnectionConfig } from '@/stores/connection'
import { version } from '../../package.json'
import { shallowRef } from 'vue'

const DEFAULT_API_BASE_URL = '/api/v1'

/** Stable and isolated preview applications must not share a proxy listener. */
export const PROXY_PORT = version.includes('-preview.') ? 18766 : 18765
/** 桌面端本地反代 baseURL(无前缀,path 由请求自带,target 由 header 传)。 */
const DESKTOP_PROXY_BASE = `http://127.0.0.1:${PROXY_PORT}`
/** cliproxy 本地默认地址(sidecar 常驻端口 8317);baseUrl 留空时兜底。 */
const DEFAULT_CLIPROXY_BASE = 'http://127.0.0.1:8317'

/** 当前活跃连接配置(由 connection store 在 connect 时注入) */
const activeConnectionState = shallowRef<ConnectionConfig | null>(null)
let connectionRevision = 0

export function setActiveConnection(conn: ConnectionConfig | null): void {
  if (activeConnectionState.value !== conn) connectionRevision += 1
  activeConnectionState.value = conn
}

export function captureAuthConnection() {
  return { connection: activeConnectionState.value, revision: connectionRevision, apiBase: getAPIBaseURL(), targetBase: getSub2apiTargetBase() }
}

export type AuthConnectionContext = ReturnType<typeof captureAuthConnection>

export function isAuthConnectionCurrent(context: AuthConnectionContext): boolean {
  return context.revision === connectionRevision && context.connection === activeConnectionState.value
}

export function persistAuthConnectionBinding(context: AuthConnectionContext): void {
  const connection = context.connection
  if (connection?.type === 'sub2api' && connection.authMode === 'login') {
    localStorage.setItem('2api-console.auth-connection', JSON.stringify({ id: connection.id, baseUrl: connection.baseUrl }))
  } else {
    localStorage.removeItem('2api-console.auth-connection')
  }
}

export function authConnectionBindingMatches(context: Pick<AuthConnectionContext, 'connection'>): boolean {
  if (!context.connection) return true
  try {
    const binding = JSON.parse(localStorage.getItem('2api-console.auth-connection') || 'null')
    return binding?.id === context.connection.id && binding?.baseUrl === context.connection.baseUrl
  } catch {
    return false
  }
}

export async function syncConnectionJwt(context: AuthConnectionContext, token: string, expiresAt?: number): Promise<AuthConnectionContext> {
  if (!isAuthConnectionCurrent(context)) throw new Error('Connection changed during authentication')
  const expected = context.connection
  if (!expected || expected.type !== 'sub2api' || expected.authMode !== 'login') return context
  const { useConnectionStore } = await import('@/stores/connection')
  if (!isAuthConnectionCurrent(context)) throw new Error('Connection changed during authentication')
  const store = useConnectionStore()
  if (store.activeId !== expected.id) throw new Error('Connection changed during authentication')
  store.updateConnection(expected.id, { apiKey: token, tokenExpiresAt: expiresAt })
  setActiveConnection(store.active)
  return captureAuthConnection()
}

export function getActiveConnection(): ConnectionConfig | null {
  return activeConnectionState.value
}

export function isDesktopRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in (window as any)
}

export function hasSub2apiBackend(): boolean {
  return !isDesktopRuntime() || activeConnectionState.value?.type === 'sub2api'
}

function normalizePath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`
}

function normalizeAPIBaseURL(value: unknown): string {
  const raw = String(value || '').trim()
  if (!raw) return DEFAULT_API_BASE_URL
  const withoutTrailingSlash = raw.replace(/\/+$/, '')
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(withoutTrailingSlash) || withoutTrailingSlash.startsWith('//')) {
    return withoutTrailingSlash
  }
  return normalizePath(withoutTrailingSlash)
}

/** 按连接 type 取 API 前缀:sub2api → /api/v1,cliproxy → /v1(OpenAI 兼容业务端点)。 */
function prefixFor(conn: ConnectionConfig): string {
  return conn.type === 'sub2api' ? '/api/v1' : '/v1'
}

/** 远程 baseUrl 拼前缀(去重:baseUrl 已含前缀则不重复拼)。 */
function joinRemoteBase(baseUrl: string, prefix: string): string {
  const base = normalizeAPIBaseURL(baseUrl)
  if (base.endsWith(prefix)) return base
  return `${base}${prefix}`
}

/**
 * 远程 sub2api 目标地址(含前缀),供 client.ts 注入 X-Target-Base。
 * 桌面反代模式:baseURL 指本地,真实远程地址走此 header。
 */
export function getSub2apiTargetBase(): string {
  if (activeConnectionState.value) {
    return joinRemoteBase(activeConnectionState.value.baseUrl, prefixFor(activeConnectionState.value))
  }
  const configured = import.meta.env.VITE_API_BASE_URL
  return configured ? normalizeAPIBaseURL(configured) : DEFAULT_API_BASE_URL
}

/**
 * 远程 cost 服务目标地址(含前缀),供 client.ts 注入 X-Target-Base(_explicitBaseURL 请求用)。
 * - 配了 costServiceUrl → 拼前缀
 * - 未配 → 回退 sub2api target(cost 挂 sub2api 同域反代场景)
 */
export function getCostTargetBase(): string {
  if (activeConnectionState.value?.costServiceUrl) {
    return joinRemoteBase(activeConnectionState.value.costServiceUrl, prefixFor(activeConnectionState.value))
  }
  return getSub2apiTargetBase()
}

/**
 * cliproxy 管理 API 目标地址(baseUrl + /v0/management),供 cliproxyClient 直连。
 * cliproxy CORS 全开,不走本地反代;管理端点前缀固定 /v0/management(与业务前缀 /v1 不同)。
 */
export function getCliproxyManagementBase(): string {
  if (activeConnectionState.value) {
    // baseUrl 留空兜底本地 8317(避免拼成 /api/v1/v0/management 错误路径)
    const raw = activeConnectionState.value.baseUrl?.trim()
    const base = normalizeAPIBaseURL(raw || DEFAULT_CLIPROXY_BASE)
    return base.endsWith('/v0/management') ? base : `${base}/v0/management`
  }
  return '/v0/management'
}

/** 桌面运行时且 sub2api 连接才走本地反代(cliproxy CORS 全开,直连远程不经反代)。 */
function shouldUseDesktopProxy(): boolean {
  return isDesktopRuntime() && activeConnectionState.value?.type !== 'cliproxy'
}

/**
 * 当前 API baseURL。
 * - 桌面运行时:返本地反代地址(远程真实地址走 X-Target-Base header,见 client.ts)。
 * - 非桌面(web/dev):返远程地址直接请求(同源无 CORS 问题)。
 */
export function getAPIBaseURL(): string {
  // 桌面运行时:sub2api 连接走本地反代(绕 CORS);cliproxy 连接 CORS 全开直连远程
  if (shouldUseDesktopProxy()) {
    return DESKTOP_PROXY_BASE
  }

  // cliproxy / 非桌面:远程连接已建立,按 type 拼前缀
  if (activeConnectionState.value) {
    // cliproxy baseUrl 留空兜底本地 8317
    const base = activeConnectionState.value.type === 'cliproxy'
      ? (activeConnectionState.value.baseUrl?.trim() || DEFAULT_CLIPROXY_BASE)
      : activeConnectionState.value.baseUrl
    return joinRemoteBase(base, prefixFor(activeConnectionState.value))
  }

  // 未连接:环境变量优先,否则默认同源 /api/v1
  const configured = import.meta.env.VITE_API_BASE_URL
  if (configured) return normalizeAPIBaseURL(configured)

  return DEFAULT_API_BASE_URL
}

/**
 * Cost 服务 baseURL(独立进程,提供 economics/cost-loss 端点)。
 * - 桌面运行时:返本地反代地址(cost 真实地址走 X-Target-Base header)。
 * - 非桌面:返远程 cost 地址或回退 sub2api baseURL。
 */
export function getCostServiceBaseURL(): string {
  // 桌面运行时:sub2api 连接走本地反代;cliproxy 连接直连
  if (shouldUseDesktopProxy()) {
    return DESKTOP_PROXY_BASE
  }
  if (activeConnectionState.value?.costServiceUrl) {
    return joinRemoteBase(activeConnectionState.value.costServiceUrl, prefixFor(activeConnectionState.value))
  }
  return getAPIBaseURL()
}

/** Navigate without losing the hash router when the app is hosted in a Tauri asset window. */
export function redirectToAppPath(path: string): void {
  const normalized = path.startsWith('/') ? path : `/${path}`
  if (isDesktopRuntime()) {
    window.location.hash = `#${normalized}`
    return
  }
  window.location.href = normalized
}

function appendApiPath(baseURL: string, path: string): string {
  const base = baseURL.replace(/\/+$/, '')
  let suffix = normalizePath(path)
  if (suffix === DEFAULT_API_BASE_URL) {
    suffix = ''
  } else if (suffix.startsWith(`${DEFAULT_API_BASE_URL}/`)) {
    suffix = suffix.slice(DEFAULT_API_BASE_URL.length)
  }
  return `${base}${suffix}`
}

export function buildApiUrl(path: string): string {
  return appendApiPath(getAPIBaseURL(), path)
}

/** Navigations and embedded resources cannot carry the native proxy authorization headers. */
export function buildUpstreamApiUrl(path: string): string {
  return appendApiPath(getSub2apiTargetBase(), path)
}

export function getGatewayTargetBase(): string {
  const connection = getActiveConnection()
  const apiBase = connection?.type === 'cliproxy'
    ? joinRemoteBase(connection.baseUrl?.trim() || DEFAULT_CLIPROXY_BASE, '/v1')
    : getSub2apiTargetBase()
  const prefix = connection ? prefixFor(connection) : DEFAULT_API_BASE_URL
  return apiBase.endsWith(prefix) ? apiBase.slice(0, -prefix.length) : apiBase
}

export function buildGatewayUrl(path: string): string {
  const suffix = normalizePath(path)
  const target = getGatewayTargetBase()
  try {
    const base =
      typeof window === 'undefined'
        ? new URL(target)
        : new URL(target || '/', window.location.origin)
    return `${base.toString().replace(/\/+$/, '')}${suffix}`
  } catch {
    return `${target.replace(/\/+$/, '')}${suffix}`
  }
}
