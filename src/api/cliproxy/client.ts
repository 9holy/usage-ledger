/**
 * CLIProxyAPI 管理 API 独立 axios 客户端
 *
 * 与 sub2api 的 apiClient 区分(协议级不兼容):
 * - 不走本地反代:cliproxy CORS 全开,baseURL 直指远程 conn.baseUrl + /v0/management
 * - 认证用 Authorization: Bearer <secretKey>(管理 key,非业务 api-key)
 * - 响应不解包信封:cliproxy 管理 API 返裸数据对象,无 {code,message,data}
 * - 401 不立即跳转:连续 5 次认证失败触发约 30 分钟 IP 封禁,派发事件让 UI 提示,
 *   避免用户反复重试触发封禁(与 apiClient 的 401 跳 /connect 不同)
 *
 * sub2api 的 apiClient 一行不改,两套客户端完全隔离。
 */

import axios, { type AxiosInstance, type AxiosError, type InternalAxiosRequestConfig } from 'axios'
import { getLocale } from '@/i18n'
import { getActiveConnection, getCliproxyManagementBase, isDesktopRuntime } from '@/api/url'

export const cliproxyClient: AxiosInstance = axios.create({
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json',
  },
})

// 请求拦截器:每次刷新 baseURL(切换连接)+ 注入 Bearer secretKey + locale
cliproxyClient.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    // baseURL 动态:从当前活跃连接拼 /v0/management(切换连接后立即生效)
    config.baseURL = getCliproxyManagementBase()

    const conn = getActiveConnection()
    // 管理 key 走 Bearer(sub2api admin key 走 X-API-Key,cliproxy 管理 secret-key 走 Bearer)
    if (conn && conn.secretKey && config.headers) {
      config.headers.Authorization = `Bearer ${conn.secretKey}`
    }

    if (config.headers) {
      config.headers['Accept-Language'] = getLocale()
    }

    return config
  },
  (error) => Promise.reject(error),
)

// 响应拦截器:无信封解包,只做错误归一化 + 401 派发(不跳转,IP ban 考虑)
cliproxyClient.interceptors.response.use(
  (response) => response, // 裸数据直接透传,调用方自己取 response.data
  (error: AxiosError) => {
    // 请求取消保持原样
    if (error.code === 'ERR_CANCELED' || axios.isCancel(error)) {
      return Promise.reject(error)
    }

    if (error.response) {
      const { status, data } = error.response
      const apiData = (typeof data === 'object' && data !== null ? data : {}) as Record<string, any>

      // 401/403:cliproxy 管理认证失败(secret-key 无效/远程管理禁用)。
      // 不跳 /connect、不派发事件 —— 连续失败会触发 IP 封禁,跳走再回来重试只会累积失败次数。
      // 错误经 reject message → errMsg 在视图 error 区显示,用户改 key 后原地重试。
      if (status === 401 || status === 403) {
        return Promise.reject({
          status,
          code: apiData.error,
          message: apiData.error || '管理认证失败(可能已触发 IP 封禁,请稍后重试)',
        })
      }

      return Promise.reject({
        status,
        code: apiData.error,
        message: apiData.error || apiData.message || error.message,
      })
    }

    // 网络错误:cliproxy 直连(不经反代),失败通常是服务不可达或 IP 被封禁
    const networkMessage = isDesktopRuntime()
      ? `无法连接 CLIProxyAPI(${getCliproxyManagementBase()})。请检查服务是否运行、地址是否正确。`
      : 'Network error. Please check your connection.'
    return Promise.reject({
      status: 0,
      message: networkMessage,
    })
  },
)

export default cliproxyClient
