import { invoke } from '@tauri-apps/api/core'
import { isDesktopRuntime } from '@/api/url'

export async function syncDesktopLocale(locale: 'en' | 'zh'): Promise<void> {
  if (!isDesktopRuntime()) return
  try {
    await invoke('set_desktop_locale', { locale })
  } catch (error) {
    console.warn('Failed to update native desktop language', error)
  }
}
