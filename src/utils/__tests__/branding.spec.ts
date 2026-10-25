import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDesktopName, updateFavicon } from '@/utils/branding'
import { resolveDocumentTitle } from '@/router/title'
import { i18n } from '@/i18n'

describe('updateFavicon', () => {
  beforeEach(() => {
    document.head.innerHTML = '<link rel="icon" href="/logo.svg">'
    i18n.global.locale.value = 'zh'
  })
  afterEach(() => { Reflect.deleteProperty(window, '__TAURI_INTERNALS__') })

  it('keeps the desktop product identity when a remote server supplies branding', () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
    updateFavicon('https://example.com/server-logo.png')
    expect(document.querySelector('link[rel="icon"]')?.getAttribute('href')).toBe('/usage-ledger.png')
    expect(document.querySelector('link[rel="icon"]')?.getAttribute('type')).toBe('image/png')
    expect(resolveDocumentTitle('成本中心', 'Remote Server')).toBe('成本中心 - 用量账本')
  })

  it('replaces the default favicon with the configured logo', () => {
    updateFavicon('https://example.com/custom-logo.png')

    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    expect(link?.href).toBe('https://example.com/custom-logo.png')
  })

  it('ignores unsafe logo URLs', () => {
    updateFavicon('javascript:alert(1)')

    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    expect(link?.getAttribute('href')).toBe('/logo.svg')
  })

  it('resolves the desktop brand from the active locale without overwriting saved preferences', () => {
    localStorage.setItem('sub2api_locale', 'zh')
    expect(getDesktopName()).toBe('用量账本')
    i18n.global.locale.value = 'en'
    expect(getDesktopName()).toBe('Usage Ledger')
    expect(localStorage.getItem('sub2api_locale')).toBe('zh')
  })
})
