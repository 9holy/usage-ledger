import { getLocale } from '@/i18n'

export function usageLocale(): string {
  return getLocale() === 'en' ? 'en-US' : 'zh-CN'
}

export function formatUsagePercent(value: number): string {
  if (value > 0 && value < 0.1) return '<0.1%'
  if (value > 99.9 && value < 100) return '>99.9%'
  return `${value.toFixed(1)}%`
}
