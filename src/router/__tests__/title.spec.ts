import { afterEach, describe, expect, it } from 'vitest'
import { resolveDocumentTitle, resolveRouteDocumentTitle } from '@/router/title'
import { i18n } from '@/i18n'
import en from '@/i18n/locales/en/desktop'
import zh from '@/i18n/locales/zh/desktop'

afterEach(() => { Reflect.deleteProperty(window, '__TAURI_INTERNALS__') })

describe('resolveDocumentTitle', () => {
  it('路由存在标题时，使用“路由标题 - 站点名”格式', () => {
    expect(resolveDocumentTitle('Usage Records', 'My Site')).toBe('Usage Records - My Site')
  })

  it('路由无标题时，回退到站点名', () => {
    expect(resolveDocumentTitle(undefined, 'My Site')).toBe('My Site')
  })

  it('站点名为空时，回退默认站点名', () => {
    expect(resolveDocumentTitle('Dashboard', '')).toBe('Dashboard - Sub2API')
    expect(resolveDocumentTitle(undefined, '   ')).toBe('Sub2API')
  })

  it('站点名变更时仅影响后续路由标题计算', () => {
    const before = resolveDocumentTitle('Admin Dashboard', 'Alpha')
    const after = resolveDocumentTitle('Admin Dashboard', 'Beta')

    expect(before).toBe('Admin Dashboard - Alpha')
    expect(after).toBe('Admin Dashboard - Beta')
  })
})

describe('resolveRouteDocumentTitle', () => {
  it('translates desktop page titles and the product name from the active locale', () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
    i18n.global.setLocaleMessage('en', { desktop: en })
    i18n.global.setLocaleMessage('zh', { desktop: zh })
    const route = { name: 'UsageMonitor', params: {}, meta: { title: '全局用量监控', titleKey: 'desktop.pages.monitor' } }
    i18n.global.locale.value = 'en'
    expect(resolveRouteDocumentTitle(route, 'Remote brand')).toBe('Usage Monitor - Usage Ledger')
    i18n.global.locale.value = 'zh'
    expect(resolveRouteDocumentTitle(route, 'Remote brand')).toBe('全局用量监控 - 用量账本')
  })

  it('自定义页面菜单加载后，使用菜单名称作为标题', () => {
    const route = {
      name: 'CustomPage',
      params: { id: 'scheduler' },
      meta: {
        title: 'Custom Page'
      }
    }

    expect(resolveRouteDocumentTitle(route, 'EzouAPI')).toBe('Custom Page - EzouAPI')
    expect(resolveRouteDocumentTitle(route, 'EzouAPI', [
      {
        id: 'scheduler',
        label: '账号调度器',
        icon_svg: '',
        url: 'https://example.com',
        visibility: 'admin',
        sort_order: 0
      }
    ])).toBe('账号调度器 - EzouAPI')
  })
})
