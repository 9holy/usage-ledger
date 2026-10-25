/**
 * CLIProxyAPI 管理 API 封装(/v0/management/*)
 *
 * 实测端点全集(2026-08-17 Node fetch 直测 http://127.0.0.1:8317 + management.html bundle op.* 调用全集双重确认):
 * GET 200: latest-version/config/config.yaml/usage-queue/auth-files/auth-files/models/auth-files/download/
 *   api-keys/api-key-usage/logs/request-error-logs/debug/ws-auth/routing/strategy/proxy-url/force-model-prefix/
 *   request-log/logging-to-file/logs-max-total-size-mb/error-logs-max-files/usage-statistics-enabled/
 *   request-retry/max-retry-interval/plugins/plugins/{id}/config/plugin-store/
 *   model-definitions/{name}/
 *   gemini-api-key/codex-api-key/claude-api-key/xai-api-key/interactions-api-key/
 *   openai-compatibility/vertex-api-key/oauth-model-alias/oauth-excluded-models/
 *   {provider}-auth-url/get-auth-status
 * POST 200: oauth-callback/api-call
 * DELETE 200: auth-files?name=/api-keys?index=/plugins/{id}/logs/
 *   {provider}-api-key?api-key=&base-url=/oauth-excluded-models?provider=/openai-compatibility?index=
 * GET 400: logs(logging-to-file:false 时)
 *
 * 契约:
 * - GET 返裸数据(无 {code,message,data} 信封);对象型返 {"<key>":[...]} 或 {"files":[...]}
 * - 单值端点 PUT 请求体 {"value":...};对象数组 PATCH {"index":n,"value":{...}} 或 {"match":"<key>","value":{...}}
 * - 成功返 {"status":"ok"}
 * - DELETE 查询参数三种(按端点):auth-files/api-keys/openai-compatibility 用 ?name= 或 ?index=;
 *   6 类 provider key(gemini/codex/claude/xai/interactions/vertex)用 ?api-key=&base-url=;
 *   oauth-excluded-models 用 ?provider=
 *
 * OAuth 流程(bundle Sy 对象确认):
 * 1. startAuth(provider): GET /{provider}-auth-url?(is_webui=true) → 返 {auth_url,state}
 * 2. getAuthStatus(state): GET /get-auth-status?state= → 轮询返 {status,...}
 * 3. submitCallback(provider, redirect_url): POST /oauth-callback {provider,redirect_url}
 * by 集合(codex/anthropic/antigravity/xai)的 auth-url 需加 is_webui=true
 */

import { cliproxyClient } from './client'

// ==================== 类型定义 ====================

export interface CliproxyVersion {
  'latest-version'?: string
}

export interface CliproxyConfig {
  [key: string]: unknown
}

export interface UsageQueueRecord {
  timestamp: number
  latency_ms: number
  source: string
  auth_index: string
  tokens: { input: number; output: number; reasoning: number; cached: number; total: number }
  failed: boolean
  provider: string
  model: string
  alias: string
  endpoint: string
  auth_type: string
  api_key: string
  request_id: string
}

/** 认证文件(实测字段:id/auth_index/name/provider/status/disabled/success/failed/email/account/source/path/priority/weight/note/next_retry_after 等)
 *  priority/weight 是 cliproxy 真实调度权重(credentialweight),非造假派生。 */
export interface AuthFile {
  id: string
  auth_index: string
  name: string
  provider: string
  label?: string
  status: string
  status_message?: string
  disabled: boolean
  unavailable?: boolean
  runtime_only?: boolean
  source: string
  path?: string
  size?: number
  modtime?: string
  success: number
  failed: number
  recent_requests?: unknown
  email?: string
  account_type?: string
  account?: string
  type?: string
  project_id?: string
  created_at?: string
  updated_at?: string
  last_refresh?: string
  /** 真实优先级(cliproxy auth 文件 priority 属性,非造假) */
  priority?: number
  /** 真实调度权重(credentialweight AttributeWeight) */
  weight?: number
  note?: string
  /** 下次重试时间(限流/封禁恢复) */
  next_retry_after?: string
  id_token?: unknown
  websockets?: unknown
}

export interface ApiKeysResponse {
  'api-keys': string[]
}

export interface ApiKeyUsageBucket {
  success: number
  failed: number
  recent_requests: number[]
}

export interface LogEntry {
  lines: string[]
  'line-count': number
  'latest-timestamp': number
  'next-cursor'?: string
  'cursor-reset'?: boolean
}

export interface ErrorLogFile {
  name: string
  size: number
  modified: number
}

export interface ErrorLogFilesResponse {
  files: ErrorLogFile[]
}

export interface StatusOk {
  status: string
  [key: string]: unknown
}

/** 插件(实测字段:id/path/configured/registered/enabled/effective_enabled/supports_oauth/oauth_provider/logo/config_fields) */
export interface Plugin {
  id: string
  path?: string
  configured: boolean
  registered: boolean
  enabled: boolean
  effective_enabled: boolean
  supports_oauth: boolean
  oauth_provider?: string
  logo?: string
  config_fields?: PluginConfigField[]
  store?: PluginStoreMeta
}

export interface PluginConfigField {
  name: string
  type: string
  enum_values?: string[]
  description?: string
  default?: unknown
  required?: boolean
}

export interface PluginStoreMeta {
  id?: string
  name?: string
  description?: string
  author?: string
  version?: string
  release_tag?: string
  repository?: string
  homepage?: string
  license?: string
  tags?: string[]
}

export interface PluginsResponse {
  plugins_enabled: boolean
  plugins_dir: string
  plugins: Plugin[]
}

/** 7 类提供商 key 的通用条目(字段按 provider 不同,用宽松类型) */
export interface ProviderKeyEntry {
  'api-key'?: string
  name?: string
  weight?: number
  prefix?: string
  'base-url'?: string
  'proxy-url'?: string
  'disable-cooling'?: boolean
  headers?: Record<string, string>
  models?: unknown[]
  'excluded-models'?: string[]
  [key: string]: unknown
}

/** OAuth 模型别名条目 */
export interface OAuthAliasEntry {
  name: string
  alias: string
  'display-name'?: string
  fork?: boolean
  'force-mapping'?: boolean
}

// ==================== OAuth 登录 ====================

/** OAuth 启动响应:GET /{provider}-auth-url 返 {url,state,...}(实测字段名为 url,非 auth_url)
 *  xai 为 device flow,额外返 {flow,expires_in,user_code} */
export interface OAuthAuthUrlResponse {
  url: string
  state: string
  status?: string
  flow?: string
  expires_in?: number
  user_code?: string
}

/** OAuth 状态轮询:GET /get-auth-status?state= */
export interface OAuthAuthStatus {
  status: string
  message?: string
  provider?: string
  auth_index?: string
  email?: string
}

/** OAuth 提交回调:POST /oauth-callback {provider,redirect_url} */
export interface OAuthCallbackBody {
  provider: string
  redirect_url: string
}

/** 模型定义:GET /model-definitions/{name} */
export interface ModelDefinition {
  name: string
  [key: string]: unknown
}

/** 插件商店条目:GET /plugin-store */
export interface PluginStoreEntry {
  id: string
  name?: string
  description?: string
  author?: string
  version?: string
  repository?: string
  homepage?: string
  license?: string
  tags?: string[]
  [key: string]: unknown
}

/** 插件商店响应 */
export interface PluginStoreResponse {
  entries: PluginStoreEntry[]
  [key: string]: unknown
}

/** API 调用结果:POST /api-call */
export interface ApiCallResult {
  status_code: number
  header: Record<string, string>
  body: unknown
  bodyText?: string
}

// ==================== 泛型 helpers(对象数组型端点统一 PATCH 模式) ====================

/** 按 index PATCH 对象数组某项:{"index":n,"value":{...}} */
export async function patchArrayItem<T>(resource: string, index: number, value: Partial<T>): Promise<StatusOk> {
  const { data } = await cliproxyClient.patch<StatusOk>(`/${resource}`, { index, value })
  return data
}

/** 按 match key PATCH 对象数组某项:{"match":"<key>","value":{...}} */
export async function patchArrayByMatch<T>(resource: string, matchKey: string, value: Partial<T>): Promise<StatusOk> {
  const { data } = await cliproxyClient.patch<StatusOk>(`/${resource}`, { match: matchKey, value })
  return data
}

/** 单值端点 PUT:{"value":...} */
export async function putValue<T>(resource: string, value: T): Promise<StatusOk> {
  const { data } = await cliproxyClient.put<StatusOk>(`/${resource}`, { value })
  return data
}

/** 数组型端点 PUT 整改(原始数组) */
export async function putArray<T>(resource: string, items: T[]): Promise<StatusOk> {
  const { data } = await cliproxyClient.put<StatusOk>(`/${resource}`, items)
  return data
}

/** 数组型端点 DELETE(查询参数) */
export async function deleteArrayItem(resource: string, params: Record<string, string | number>): Promise<StatusOk> {
  const { data } = await cliproxyClient.delete<StatusOk>(`/${resource}`, { params })
  return data
}

// ==================== 概览 / 配置 ====================

export async function getLatestVersion(): Promise<CliproxyVersion> {
  const { data } = await cliproxyClient.get<CliproxyVersion>('/latest-version')
  return data
}

export async function getConfig(): Promise<CliproxyConfig> {
  const { data } = await cliproxyClient.get<CliproxyConfig>('/config')
  return data
}

export async function getConfigYaml(): Promise<string> {
  const { data } = await cliproxyClient.get<string>('/config.yaml', { responseType: 'text', transformResponse: (r) => r })
  return data
}

export async function putConfigYaml(yaml: string): Promise<StatusOk> {
  const { data } = await cliproxyClient.put<StatusOk>('/config.yaml', yaml, {
    headers: { 'Content-Type': 'application/yaml' },
    transformRequest: [(d) => d],
  })
  return data
}

export async function getUsageQueue(count = 10): Promise<UsageQueueRecord[]> {
  const { data } = await cliproxyClient.get<UsageQueueRecord[]>('/usage-queue', { params: { count } })
  return data
}

// ==================== 认证文件 ====================

/** 列出全部认证文件。实测响应:{"files":[...]} */
export async function getAuthFiles(): Promise<AuthFile[]> {
  const { data } = await cliproxyClient.get<{ files?: AuthFile[] } | AuthFile[]>('/auth-files')
  if (Array.isArray(data)) return data
  return data?.files ?? []
}

/** 下载单个认证文件(仅 source=file 可下载),返 blob */
export async function downloadAuthFile(name: string): Promise<Blob> {
  const { data } = await cliproxyClient.get<Blob>('/auth-files/download', {
    params: { name },
    responseType: 'blob',
  })
  return data
}

/** 列出某认证文件的可用模型(GET /auth-files/models?name=) */
export async function getAuthFileModels(name: string): Promise<string[]> {
  const { data } = await cliproxyClient.get<{ models?: string[] } | string[]>('/auth-files/models', {
    params: { name },
  })
  if (Array.isArray(data)) return data
  return data?.models ?? []
}

/** 删除认证文件(DELETE /auth-files?name=) */
export async function deleteAuthFile(name: string): Promise<StatusOk> {
  return deleteArrayItem('auth-files', { name })
}

// ==================== API Keys(业务 key) ====================

export async function getApiKeys(): Promise<string[]> {
  const { data } = await cliproxyClient.get<ApiKeysResponse>('/api-keys')
  return data['api-keys'] ?? []
}

export async function putApiKeys(keys: string[]): Promise<StatusOk> {
  return putArray('/api-keys', keys)
}

export async function patchApiKey(index: number, value: string): Promise<StatusOk> {
  return patchArrayItem<string>('/api-keys', index, value)
}

export async function patchApiKeyByMatch(oldKey: string, newKey: string): Promise<StatusOk> {
  return patchArrayByMatch<string>('/api-keys', oldKey, newKey)
}

export async function deleteApiKey(params: { value?: string; index?: number }): Promise<StatusOk> {
  return deleteArrayItem('/api-keys', params)
}

export async function getApiKeyUsage(): Promise<Record<string, Record<string, ApiKeyUsageBucket>>> {
  const { data } = await cliproxyClient.get<Record<string, Record<string, ApiKeyUsageBucket>>>('/api-key-usage')
  return data
}

// ==================== 日志 ====================

export async function getLogs(opts?: { after?: number; limit?: number; cursor?: string }): Promise<LogEntry> {
  const { data } = await cliproxyClient.get<LogEntry>('/logs', { params: opts })
  return data
}

export async function deleteLogs(): Promise<{ success: boolean; message: string; removed: number }> {
  const { data } = await cliproxyClient.delete<{ success: boolean; message: string; removed: number }>('/logs')
  return data
}

export async function getErrorLogFiles(): Promise<ErrorLogFile[]> {
  const { data } = await cliproxyClient.get<ErrorLogFilesResponse>('/request-error-logs')
  return data.files ?? []
}

export async function downloadErrorLog(name: string): Promise<Blob> {
  const { data } = await cliproxyClient.get<Blob>(`/request-error-logs/${encodeURIComponent(name)}`, {
    responseType: 'blob',
  })
  return data
}

// ==================== 运行时单值开关 ====================

/** 通用单值 GET:返 {"<key>":value} 中的 value */
async function getScalar<T>(endpoint: string, key: string): Promise<T> {
  const { data } = await cliproxyClient.get<Record<string, T>>(`/${endpoint}`)
  return data[key]
}

export async function getDebug(): Promise<boolean> { return getScalar<boolean>('debug', 'debug') }
export async function getWsAuth(): Promise<boolean> { return getScalar<boolean>('ws-auth', 'ws-auth') }
export async function getRoutingStrategy(): Promise<string> {
  const { data } = await cliproxyClient.get<{ strategy: string }>('/routing/strategy')
  return data.strategy
}
export async function getProxyUrl(): Promise<string> { return getScalar<string>('proxy-url', 'proxy-url') }
export async function getForceModelPrefix(): Promise<boolean> { return getScalar<boolean>('force-model-prefix', 'force-model-prefix') }
export async function getRequestRetry(): Promise<number> { return getScalar<number>('request-retry', 'request-retry') }
export async function getMaxRetryInterval(): Promise<number> { return getScalar<number>('max-retry-interval', 'max-retry-interval') }
export async function getLoggingToFile(): Promise<boolean> { return getScalar<boolean>('logging-to-file', 'logging-to-file') }
export async function getLogsMaxTotalSizeMb(): Promise<number> { return getScalar<number>('logs-max-total-size-mb', 'logs-max-total-size-mb') }
export async function getErrorLogsMaxFiles(): Promise<number> { return getScalar<number>('error-logs-max-files', 'error-logs-max-files') }
export async function getUsageStatisticsEnabled(): Promise<boolean> { return getScalar<boolean>('usage-statistics-enabled', 'usage-statistics-enabled') }
export async function getRequestLog(): Promise<boolean> { return getScalar<boolean>('request-log', 'request-log') }

/** 通用单值 PUT:{"value":...} */
export async function putScalar<T>(endpoint: string, value: T): Promise<StatusOk> {
  return putValue<T>(endpoint, value)
}

// ==================== 插件 ====================

export async function getPlugins(): Promise<PluginsResponse> {
  const { data } = await cliproxyClient.get<PluginsResponse>('/plugins')
  return data
}

/** 整改插件配置(PUT /plugins,值含 enabled/configs 等) */
export async function putPluginsConfig(value: Record<string, unknown>): Promise<StatusOk> {
  return putValue<Record<string, unknown>>('plugins', value)
}

/** 单插件配置(GET /plugins/{id}/config) */
export async function getPluginConfig(pluginId: string): Promise<Record<string, unknown>> {
  const { data } = await cliproxyClient.get<Record<string, unknown>>(`/plugins/${encodeURIComponent(pluginId)}/config`)
  return data
}

/** 删除插件(DELETE /plugins/{id}) */
export async function deletePlugin(pluginId: string): Promise<StatusOk> {
  const { data } = await cliproxyClient.delete<StatusOk>(`/plugins/${encodeURIComponent(pluginId)}`)
  return data
}

/** 插件商店(GET /plugin-store) */
export async function getPluginStore(): Promise<PluginStoreResponse> {
  const { data } = await cliproxyClient.get<PluginStoreResponse>('/plugin-store')
  return data
}

// ==================== 7 类提供商 key ====================

/** 通用提供商 key 列表 GET:返 {"<resource>":[...]} */
async function getProviderKeys<T>(resource: string): Promise<T[]> {
  const { data } = await cliproxyClient.get<Record<string, T[]>>(`/${resource}`)
  return data[resource] ?? []
}

export async function getGeminiApiKeys(): Promise<ProviderKeyEntry[]> { return getProviderKeys<ProviderKeyEntry>('gemini-api-key') }
export async function getCodexApiKeys(): Promise<ProviderKeyEntry[]> { return getProviderKeys<ProviderKeyEntry>('codex-api-key') }
export async function getClaudeApiKeys(): Promise<ProviderKeyEntry[]> { return getProviderKeys<ProviderKeyEntry>('claude-api-key') }
export async function getXaiApiKeys(): Promise<ProviderKeyEntry[]> { return getProviderKeys<ProviderKeyEntry>('xai-api-key') }
export async function getInteractionsApiKeys(): Promise<ProviderKeyEntry[]> { return getProviderKeys<ProviderKeyEntry>('interactions-api-key') }
export async function getOpenaiCompatibility(): Promise<ProviderKeyEntry[]> { return getProviderKeys<ProviderKeyEntry>('openai-compatibility') }
export async function getVertexApiKeys(): Promise<ProviderKeyEntry[]> { return getProviderKeys<ProviderKeyEntry>('vertex-api-key') }

/** 整改提供商 key 列表(原始数组 PUT) */
export async function putProviderKeys<T>(resource: string, items: T[]): Promise<StatusOk> {
  return putArray<T>(resource, items)
}

/** 按 index 修改提供商 key 条目 */
export async function patchProviderKey<T>(resource: string, index: number, value: Partial<T>): Promise<StatusOk> {
  return patchArrayItem<T>(resource, index, value)
}

/** 按 match(api-key/name)修改提供商 key 条目 */
export async function patchProviderKeyByMatch<T>(resource: string, matchKey: string, value: Partial<T>): Promise<StatusOk> {
  return patchArrayByMatch<T>(resource, matchKey, value)
}

/**
 * 删除提供商 key 条目(DELETE,三种参数模式按端点):
 * - 6 类 provider key(gemini/codex/claude/xai/interactions/vertex):?api-key=<key>&base-url=<url>(bundle jv 拼接)
 * - openai-compatibility:?index=<n>
 * - 其余走泛型 deleteArrayItem
 */
export async function deleteProviderKey(resource: string, params: Record<string, string | number>): Promise<StatusOk> {
  return deleteArrayItem(resource, params)
}

/** 6 类 provider key 专用 DELETE:?api-key=&base-url=(bundle jv=(e,t)=>{...api-key...base-url...}) */
export async function deleteProviderKeyByApiKey(resource: string, apiKey: string, baseUrl?: string): Promise<StatusOk> {
  const params: Record<string, string> = { 'api-key': apiKey.trim() }
  if (baseUrl) params['base-url'] = baseUrl.trim()
  return deleteArrayItem(resource, params)
}

/** openai-compatibility 专用 DELETE:?index= */
export async function deleteOpenaiCompatibility(index: number): Promise<StatusOk> {
  return deleteArrayItem('openai-compatibility', { index })
}

// ==================== OAuth 模型别名 ====================

export async function getOauthModelAlias(): Promise<Record<string, OAuthAliasEntry[]> | null> {
  const { data } = await cliproxyClient.get<Record<string, OAuthAliasEntry[]> | { 'oauth-model-alias': null }>('/oauth-model-alias')
  if (!data) return null
  if ('oauth-model-alias' in data) return (data as { 'oauth-model-alias': Record<string, OAuthAliasEntry[]> | null })['oauth-model-alias'] ?? null
  return data as Record<string, OAuthAliasEntry[]>
}

export async function putOauthModelAlias(value: Record<string, OAuthAliasEntry[]>): Promise<StatusOk> {
  return putValue('oauth-model-alias', value)
}

export async function getOauthExcludedModels(): Promise<Record<string, string[]> | null> {
  const { data } = await cliproxyClient.get<Record<string, string[]> | { 'oauth-excluded-models': null }>('/oauth-excluded-models')
  if (!data) return null
  if ('oauth-excluded-models' in data) return (data as { 'oauth-excluded-models': Record<string, string[]> | null })['oauth-excluded-models'] ?? null
  return data as Record<string, string[]>
}

export async function putOauthExcludedModels(value: Record<string, string[]>): Promise<StatusOk> {
  return putValue('oauth-excluded-models', value)
}

/** 按 provider 删除排除模型(DELETE /oauth-excluded-models?provider=) */
export async function deleteOauthExcludedModels(provider: string): Promise<StatusOk> {
  return deleteArrayItem('oauth-excluded-models', { provider })
}

// ==================== OAuth 登录流程 ====================

/** 需 is_webui=true 的 provider 集合(bundle by=new Set(["codex","anthropic","antigravity","xai"])) */
const WEBUI_OAUTH_PROVIDERS = new Set(['codex', 'anthropic', 'antigravity', 'xai'])

/**
 * 启动 OAuth 授权(GET /{provider}-auth-url)
 * 返 {auth_url,state};webui provider 加 is_webui=true 让回调走 web 而非本地端口
 */
export async function startOAuthAuth(provider: string): Promise<OAuthAuthUrlResponse> {
  const params: Record<string, string> = {}
  const normalized = provider.trim().toLowerCase()
  if (WEBUI_OAUTH_PROVIDERS.has(normalized)) params.is_webui = 'true'
  const { data } = await cliproxyClient.get<OAuthAuthUrlResponse>(`/${normalized}-auth-url`, { params })
  return data
}

/** 轮询 OAuth 授权状态(GET /get-auth-status?state=) */
export async function getOAuthAuthStatus(state: string): Promise<OAuthAuthStatus> {
  const { data } = await cliproxyClient.get<OAuthAuthStatus>('/get-auth-status', { params: { state } })
  return data
}

/** 提交 OAuth 回调(POST /oauth-callback {provider,redirect_url}) */
export async function submitOAuthCallback(provider: string, redirectUrl: string): Promise<StatusOk> {
  const { data } = await cliproxyClient.post<StatusOk>('/oauth-callback', {
    provider: provider.trim().toLowerCase(),
    redirect_url: redirectUrl,
  } satisfies OAuthCallbackBody)
  return data
}

// ==================== 模型定义 ====================

/** 查询模型定义(GET /model-definitions/{name}) */
export async function getModelDefinition(name: string): Promise<ModelDefinition> {
  const { data } = await cliproxyClient.get<ModelDefinition>(`/model-definitions/${encodeURIComponent(name)}`)
  return data
}

// ==================== API 调用测试 ====================

/** 发起一次 API 调用(POST /api-call),body 含 provider/model/messages 等 */
export async function postApiCall(body: Record<string, unknown>): Promise<ApiCallResult> {
  const { data } = await cliproxyClient.post<ApiCallResult>('/api-call', body)
  return data
}
