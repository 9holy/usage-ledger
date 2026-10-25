import { beforeEach, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { isDesktopRuntime } from '@/api/url'
import { syncDesktopLocale } from '../desktopLocale'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/api/url', () => ({ isDesktopRuntime: vi.fn(() => false) }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(isDesktopRuntime).mockReturnValue(false)
  vi.mocked(invoke).mockResolvedValue(undefined)
})

it('does not invoke native APIs in browser mode', async () => {
  await syncDesktopLocale('en')
  expect(invoke).not.toHaveBeenCalled()
})

it('sends only the selected locale to the caption command, without window or data operations', async () => {
  vi.mocked(isDesktopRuntime).mockReturnValue(true)
  await syncDesktopLocale('zh')
  await syncDesktopLocale('en')
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ['set_desktop_locale', { locale: 'zh' }],
    ['set_desktop_locale', { locale: 'en' }],
  ])
})

it('reports native failures without rejecting language initialization or switching', async () => {
  vi.mocked(isDesktopRuntime).mockReturnValue(true)
  const error = new Error('tray unavailable')
  vi.mocked(invoke).mockRejectedValueOnce(error)
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    await expect(syncDesktopLocale('en')).resolves.toBeUndefined()
    expect(warning).toHaveBeenCalledWith('Failed to update native desktop language', error)
  } finally { warning.mockRestore() }
})
