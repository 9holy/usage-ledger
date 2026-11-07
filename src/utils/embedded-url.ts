/**
 * Shared URL builder for iframe-embedded pages.
 * Used by PurchaseSubscriptionView and CustomPageView to build consistent URLs
 * with user_id, theme, lang, ui_mode and source context, without login credentials.
 */

const EMBEDDED_USER_ID_QUERY_KEY = 'user_id'
const EMBEDDED_THEME_QUERY_KEY = 'theme'
const EMBEDDED_LANG_QUERY_KEY = 'lang'
const EMBEDDED_UI_MODE_QUERY_KEY = 'ui_mode'
const EMBEDDED_UI_MODE_VALUE = 'embedded'
const EMBEDDED_SRC_HOST_QUERY_KEY = 'src_host'
const EMBEDDED_SRC_QUERY_KEY = 'src_url'
const ISOLATED_SANDBOX = 'allow-scripts allow-forms allow-popups'

/** Keep same-origin documents isolated; cross-origin apps retain their own storage and login. */
export function getEmbeddedSandbox(
  destination: string,
  hostOrigin = typeof window === 'undefined' ? '' : window.location.origin,
): string {
  try {
    const target = new URL(destination)
    const host = new URL(hostOrigin)
    if (!['http:', 'https:'].includes(target.protocol) || host.username || host.password) return ISOLATED_SANDBOX
    const distinctHttpOrigin = ['http:', 'https:'].includes(host.protocol) && target.origin !== host.origin
    // Tauri's macOS asset scheme can have an opaque URL.origin, but this explicit
    // localhost application origin is distinct from every HTTP(S) document.
    const desktopAssetOrigin = host.protocol === 'tauri:' && host.hostname === 'localhost'
    if (distinctHttpOrigin || desktopAssetOrigin) return `${ISOLATED_SANDBOX} allow-same-origin`
  } catch {
    // Invalid URLs and unknown/opaque host origins never receive extra capabilities.
  }
  return ISOLATED_SANDBOX
}

export function buildEmbeddedUrl(
  baseUrl: string,
  userId?: number,
  _authToken?: string | null,
  theme: 'light' | 'dark' = 'light',
  lang?: string,
): string {
  if (!baseUrl) return baseUrl
  try {
    const url = new URL(baseUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    if (userId) {
      url.searchParams.set(EMBEDDED_USER_ID_QUERY_KEY, String(userId))
    }
    // The embedded page may be on a third-party server. Never disclose an application
    // JWT or admin API key in its URL, referrer, browser history or server access log.
    url.searchParams.set(EMBEDDED_THEME_QUERY_KEY, theme)
    if (lang) {
      url.searchParams.set(EMBEDDED_LANG_QUERY_KEY, lang)
    }
    url.searchParams.set(EMBEDDED_UI_MODE_QUERY_KEY, EMBEDDED_UI_MODE_VALUE)
    // Source tracking: let the embedded page know where it's being loaded from
    if (typeof window !== 'undefined') {
      url.searchParams.set(EMBEDDED_SRC_HOST_QUERY_KEY, window.location.origin)
      const source = new URL(window.location.href)
      source.search = ''
      source.hash = ''
      url.searchParams.set(EMBEDDED_SRC_QUERY_KEY, source.toString())
    }
    return url.toString()
  } catch {
    return baseUrl
  }
}

export function detectTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}
