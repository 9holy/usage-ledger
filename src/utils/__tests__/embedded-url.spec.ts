import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildEmbeddedUrl, detectTheme, getEmbeddedSandbox } from '../embedded-url'

describe('embedded-url', () => {
  const originalLocation = window.location

  beforeEach(() => {
    Object.defineProperty(window, 'location', {
      value: {
        origin: 'https://app.example.com',
        href: 'https://app.example.com/user/purchase',
      },
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    })
    document.documentElement.classList.remove('dark')
    vi.restoreAllMocks()
  })

  it('adds embedded query parameters including locale and source context', () => {
    const result = buildEmbeddedUrl(
      'https://pay.example.com/checkout?plan=pro',
      42,
      'token-123',
      'dark',
      'zh-CN',
    )

    const url = new URL(result)
    expect(url.searchParams.get('plan')).toBe('pro')
    expect(url.searchParams.get('user_id')).toBe('42')
    expect(url.searchParams.has('token')).toBe(false)
    expect(result).not.toContain('token-123')
    expect(url.searchParams.get('theme')).toBe('dark')
    expect(url.searchParams.get('lang')).toBe('zh-CN')
    expect(url.searchParams.get('ui_mode')).toBe('embedded')
    expect(url.searchParams.get('src_host')).toBe('https://app.example.com')
    expect(url.searchParams.get('src_url')).toBe('https://app.example.com/user/purchase')
  })

  it('omits optional params when they are empty', () => {
    const result = buildEmbeddedUrl('https://pay.example.com/checkout', undefined, '', 'light')

    const url = new URL(result)
    expect(url.searchParams.get('theme')).toBe('light')
    expect(url.searchParams.get('ui_mode')).toBe('embedded')
    expect(url.searchParams.has('user_id')).toBe(false)
    expect(url.searchParams.has('token')).toBe(false)
    expect(url.searchParams.has('lang')).toBe(false)
  })

  it('returns original string for invalid url input', () => {
    expect(buildEmbeddedUrl('not a url', 1, 'token')).toBe('not a url')
  })

  it('never leaks query or hash credentials through source tracking', () => {
    window.location.href = 'https://app.example.com/custom?token=private#/page?api_key=secret'
    const result = buildEmbeddedUrl('https://third-party.example/page', 1, 'admin-secret')
    const url = new URL(result)
    expect(url.searchParams.get('src_url')).toBe('https://app.example.com/custom')
    expect(result).not.toMatch(/private|secret/)
  })

  it.each(['javascript:alert(1)', 'data:text/html,test'])('rejects executable iframe destination %s', (url) => {
    expect(buildEmbeddedUrl(url, 1, 'private-token')).toBe('')
  })

  it.each([
    ['https://app.example.com/embed', 'https://app.example.com'],
    ['https://app.example.com:443/embed', 'https://app.example.com'],
    ['/relative', 'https://app.example.com'],
    ['not a URL', 'https://app.example.com'],
    ['javascript:alert(1)', 'https://app.example.com'],
    ['data:text/html,test', 'https://app.example.com'],
    ['https://external.example/embed', 'null'],
    ['https://external.example/embed', 'file:///application/index.html'],
    ['https://external.example/embed', 'unknown://localhost'],
  ])('keeps %s isolated when hosted by %s', (destination, host) => {
    expect(getEmbeddedSandbox(destination, host)).toBe('allow-scripts allow-forms allow-popups')
  })

  it.each([
    ['https://external.example/embed', 'https://app.example.com'],
    ['https://app.example.com:8443/embed', 'https://app.example.com'],
    ['http://app.example.com/embed', 'https://app.example.com'],
    ['https://external.example/embed', 'tauri://localhost'],
    ['https://external.example/embed', 'http://tauri.localhost'],
  ])('preserves storage for cross-origin %s hosted by %s', (destination, host) => {
    expect(getEmbeddedSandbox(destination, host)).toBe('allow-scripts allow-forms allow-popups allow-same-origin')
    expect(getEmbeddedSandbox(destination, host)).not.toContain('allow-top-navigation')
  })

  it('detects dark mode from document root class', () => {
    document.documentElement.classList.add('dark')
    expect(detectTheme()).toBe('dark')
  })
})
