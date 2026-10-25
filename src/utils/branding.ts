import { sanitizeUrl } from '@/utils/url'
import { isDesktopRuntime } from '@/api/url'
import { getLocale } from '@/i18n'

export const DESKTOP_NAME = '用量账本'
export const DESKTOP_LOGO = '/usage-ledger.png'

export function getDesktopName(): string {
  return getLocale() === 'en' ? 'Usage Ledger' : DESKTOP_NAME
}

export function updateFavicon(logoUrl: string): void {
  const sanitizedLogoUrl = sanitizeUrl(isDesktopRuntime() ? DESKTOP_LOGO : logoUrl, {
    allowRelative: true,
    allowDataUrl: true,
  })
  if (!sanitizedLogoUrl) {
    return
  }

  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!link) {
    link = document.createElement('link')
    link.rel = 'icon'
    document.head.appendChild(link)
  }

  link.type = sanitizedLogoUrl.endsWith('.svg') ? 'image/svg+xml' : sanitizedLogoUrl.endsWith('.png') ? 'image/png' : 'image/x-icon'
  link.href = sanitizedLogoUrl
}
