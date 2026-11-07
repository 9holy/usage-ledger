import { getDesktopProxyHeaders } from './desktopProxy'
import { buildApiUrl, buildGatewayUrl, captureAuthConnection, getGatewayTargetBase, isAuthConnectionCurrent, isDesktopRuntime, PROXY_PORT } from './url'

/** Fetch/SSE uses the same captured connection and native capability as the Axios clients. */
async function request(path: string, init: RequestInit, gateway: boolean, gatewayBase?: string): Promise<Response> {
  const context = captureAuthConnection()
  const connection = context.connection
  const target = gateway ? gatewayBase || getGatewayTargetBase() : context.targetBase
  const headers = new Headers(init.headers)
  let url = gatewayBase ? `${gatewayBase.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}` : gateway ? buildGatewayUrl(path) : buildApiUrl(path)

  // Gateway callers supply a business API key. Administrative calls use the active connection.
  if (!gateway && connection) {
    headers.delete('Authorization')
    headers.delete('X-API-Key')
    if (connection.apiKey) {
      if (connection.type === 'sub2api' && connection.authMode === 'login') headers.set('Authorization', `Bearer ${connection.apiKey}`)
      else headers.set('X-API-Key', connection.apiKey)
    }
  }

  if (isDesktopRuntime() && connection?.type !== 'cliproxy') {
    if (gateway) url = `http://127.0.0.1:${PROXY_PORT}${path.startsWith('/') ? path : `/${path}`}`
    const proxyHeaders = await getDesktopProxyHeaders(target)
    if (!isAuthConnectionCurrent(context)) throw new DOMException('Connection changed before the request was sent', 'AbortError')
    for (const [name, value] of Object.entries(proxyHeaders)) headers.set(name, value)
  }

  return fetch(url, { ...init, headers })
}

export function fetchApi(path: string, init: RequestInit = {}): Promise<Response> {
  return request(path, init, false)
}

export function fetchGateway(path: string, init: RequestInit = {}, gatewayBase?: string): Promise<Response> {
  return request(path, init, true, gatewayBase)
}
