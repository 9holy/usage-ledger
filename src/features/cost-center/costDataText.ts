import { i18n } from '@/i18n'
import en from '@/i18n/locales/en/costData'
import zh from '@/i18n/locales/zh/costData'

// Helpers can run before the route's lazy locale bundle has loaded.
i18n.global.mergeLocaleMessage('en', { costData: en })
i18n.global.mergeLocaleMessage('zh', { costData: zh })

export type CostDataKey = keyof typeof en

export function costDataText(key: CostDataKey, params: Record<string, unknown> = {}): string {
  return i18n.global.t(`costData.${key}`, params)
}
