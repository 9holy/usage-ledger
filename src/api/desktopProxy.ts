import { invoke } from '@tauri-apps/api/core'

let proxyToken: Promise<string> | null = null

/** The native bridge grants a fresh capability for each application process. */
export async function getDesktopProxyHeaders(targetBase: string): Promise<Record<string, string>> {
  if (!proxyToken) {
    const pending = invoke<string>('get_proxy_token').then((token) => {
      if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) {
        throw new Error('The desktop proxy did not provide a valid session token')
      }
      return token
    }).catch((error) => {
      // A failed native invocation must never fall back to an unauthenticated request.
      if (proxyToken === pending) proxyToken = null
      throw error
    })
    proxyToken = pending
  }
  return { 'X-Target-Base': targetBase, 'X-Proxy-Token': await proxyToken }
}
