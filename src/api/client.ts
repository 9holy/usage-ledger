/**
 * Axios HTTP Client Configuration
 * Base client with interceptors for authentication, token refresh, and error handling
 */

import axios, { AxiosInstance, AxiosError, InternalAxiosRequestConfig, AxiosResponse } from 'axios'
import type { ApiResponse } from '@/types'
import { getLocale } from '@/i18n'
import {
  ADMIN_UI_REQUEST_HEADER,
  USER_UI_REQUEST_HEADER,
  shouldMarkAdminUIRequest,
  shouldMarkUserUIRequest,
} from './adminUIRequest'
import { captureAuthConnection, getAPIBaseURL, isDesktopRuntime, redirectToAppPath, getActiveConnection, getSub2apiTargetBase, getCostTargetBase } from './url'
export { buildApiUrl, buildGatewayUrl } from './url'

// 扩展 axios config:cost 服务请求显式指定 baseURL 时打标记,跳过拦截器的 baseURL 刷新。
declare module 'axios' {
  interface AxiosRequestConfig {
    _explicitBaseURL?: boolean
    _authConnectionRevision?: number
  }
}

// ==================== Axios Instance Configuration ====================

export const apiClient: AxiosInstance = axios.create({
  baseURL: getAPIBaseURL(),
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json'
  }
})

// 远程连接建立后,baseURL 可能变化(切换连接)。每次请求前用最新 baseURL。
// cost 服务请求显式指定了 baseURL(_explicitBaseURL 标记),不覆盖。
function refreshBaseURL(config: InternalAxiosRequestConfig & { _explicitBaseURL?: boolean }) {
  if (config._explicitBaseURL) return
  const latest = getAPIBaseURL()
  if (config.baseURL !== latest) {
    config.baseURL = latest
  }
}

// ==================== Request Interceptor ====================

// Get user's timezone
const getUserTimezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
}

apiClient.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    config._authConnectionRevision = captureAuthConnection().revision
    refreshBaseURL(config)

    // 注入认证 header。sub2api 按 authMode 分流(curl 实测确认):
    //   - login 模式:apiKey 存 JWT → Authorization: Bearer(sub2api admin 中间件 Bearer 只认 JWT)
    //   - apikey 模式:apiKey 存 Admin API Key → X-API-Key(sub2api admin key 必须走此 header,Bearer 会被当 JWT 解析返 INVALID_TOKEN)
    // cliproxy 一律 X-API-Key。apiKey 为空不注入(login 模式首次 /auth/login 前无凭证)。
    const conn = getActiveConnection()
    if (conn && conn.apiKey && config.headers) {
      if (conn.type === 'sub2api' && conn.authMode === 'login') {
        config.headers.Authorization = `Bearer ${conn.apiKey}`
      } else {
        config.headers['X-API-Key'] = conn.apiKey
      }
    }

    // 桌面运行时:baseURL 指本地反代,远程真实地址通过 X-Target-Base 传给反代转发。
    // 即使 apiKey 为空(login 首次请求)也要注入,否则 login 请求也跨域挂。
    // _explicitBaseURL 标记的 cost 请求用 cost target,其余用 sub2api target。
    if (isDesktopRuntime() && config.headers) {
      config.headers['X-Target-Base'] = config._explicitBaseURL
        ? getCostTargetBase()
        : getSub2apiTargetBase()
    }

    // Attach locale for backend translations
    if (config.headers) {
      config.headers['Accept-Language'] = getLocale()
    }

    // Attach timezone for all GET requests (backend may use it for default date ranges)
    if (config.method === 'get') {
      if (!config.params) {
        config.params = {}
      }
      config.params.timezone = getUserTimezone()
    }

    if (config.headers) {
      const requestURL = String(config.url || '')
      if (shouldMarkAdminUIRequest(requestURL)) {
        config.headers[ADMIN_UI_REQUEST_HEADER] = '1'
      }
      if (shouldMarkUserUIRequest(requestURL)) {
        config.headers[USER_UI_REQUEST_HEADER] = '1'
      }
    }

    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// ==================== Response Interceptor ====================

apiClient.interceptors.response.use(
  (response: AxiosResponse) => {
    // Unwrap standard API response format { code, message, data }
    const apiResponse = response.data as ApiResponse<unknown>
    if (apiResponse && typeof apiResponse === 'object' && 'code' in apiResponse) {
      if (apiResponse.code === 0) {
        // Success - return the data portion
        response.data = apiResponse.data
      } else {
        // API error
        const resp = apiResponse as unknown as Record<string, unknown>
        return Promise.reject({
          status: response.status,
          code: apiResponse.code,
          message: apiResponse.message || 'Unknown error',
          reason: resp.reason,
          metadata: resp.metadata,
        })
      }
    }
    return response
  },
  async (error: AxiosError<ApiResponse<unknown>>) => {
    // Request cancellation: keep the original axios cancellation error so callers can ignore it.
    // Otherwise we'd misclassify it as a generic "network error".
    if (error.code === 'ERR_CANCELED' || axios.isCancel(error)) {
      return Promise.reject(error)
    }

    // Handle common errors
    if (error.response) {
      const { status, data } = error.response
      const url = String(error.config?.url || '')

      // Validate `data` shape to avoid HTML error pages breaking our error handling.
      const apiData = (typeof data === 'object' && data !== null ? data : {}) as Record<string, any>

      // Ops monitoring disabled: treat as feature-flagged 404, and proactively redirect away
      // from ops pages to avoid broken UI states.
      if (status === 404 && apiData.message === 'Ops monitoring is disabled') {
        try {
          localStorage.setItem('ops_monitoring_enabled_cached', 'false')
        } catch {
          // ignore localStorage failures
        }
        try {
          window.dispatchEvent(new CustomEvent('ops-monitoring-disabled'))
        } catch {
          // ignore event failures
        }

        if (window.location.pathname.startsWith('/admin/ops')) {
          redirectToAppPath('/admin/settings')
        }

        return Promise.reject({
          status,
          code: 'OPS_DISABLED',
          message: apiData.message || error.message,
          url
        })
      }

      if (status === 423 && apiData.code === 'ADMIN_COMPLIANCE_ACK_REQUIRED') {
        try {
          window.dispatchEvent(new CustomEvent('admin-compliance-required', {
            detail: apiData.metadata || {}
          }))
        } catch {
          // ignore event failures
        }

        return Promise.reject({
          status,
          code: apiData.code,
          message: apiData.message || error.message,
          metadata: apiData.metadata,
        })
      }

      // 401: 远程连接认证失效(API Key 无效/JWT 过期)。
      // 不再做 token refresh(远程模式由 connection store 管理连接),
      // 派发 api:unauthorized 事件,由 App.vue/连接层处理跳转。
      if (status === 401) {
        const isAuthEndpoint =
          url.includes('/auth/login') || url.includes('/auth/register') || url.includes('/auth/refresh')
        if (!isAuthEndpoint && (error.config?._authConnectionRevision == null || error.config._authConnectionRevision === captureAuthConnection().revision)) {
          try {
            window.dispatchEvent(new CustomEvent('api:unauthorized'))
          } catch {
            // ignore event failures
          }
          if (!window.location.hash.includes('/connect') && !window.location.pathname.includes('/login')) {
            redirectToAppPath('/connect')
          }
        }

        return Promise.reject({
          status: 401,
          code: apiData.code,
          message: apiData.message || error.message,
          metadata: apiData.metadata,
        })
      }

      // Return structured error
      return Promise.reject({
        status,
        code: apiData.code,
        reason: apiData.reason,
        error: apiData.error,
        message: apiData.message || apiData.detail || error.message,
        metadata: apiData.metadata,
      })
    }

    // Network error. 桌面端经本地反代转发,网络错误通常意味反代未启动或远程不可达。
    const networkMessage = isDesktopRuntime()
      ? `无法连接服务（本地反代 ${getAPIBaseURL()}）。请检查远程服务地址是否正确、网络是否可达。`
      : 'Network error. Please check your connection.'
    return Promise.reject({
      status: 0,
      message: networkMessage
    })
  }
)

export default apiClient
