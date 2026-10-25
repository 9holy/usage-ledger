import i18n from '@/i18n'
import { usageLocale } from '@/utils/usageFormat'
import type { LiveWindow } from '@/api/usageMonitor'

const t = i18n.global.t

export function displayLiveRate(window?: LiveWindow, digits = 2): { text: string; value: number | null; partial: boolean } {
  if (!window) return { text: t('usageMonitor.text.noSamples'), value: null, partial: true }
  const partial = !window.complete || window.sourceComplete === false
  const measured = window.outputTokensPerSecond
  const value = measured != null && Number.isFinite(measured) && measured > 0
    ? measured
    : partial && window.observedOutputTokens > 0 && window.seconds > 0
      ? window.observedOutputTokens / window.seconds
      : null
  if (value != null) {
    const text = value < 10 ** -digits
      ? new Intl.NumberFormat(usageLocale(), { maximumSignificantDigits: 2, useGrouping: false }).format(value)
      : value.toFixed(digits)
    return { text, value, partial }
  }
  if (window.complete && window.sourceComplete === false && measured === 0 && window.observedOutputTokens === 0) return { text: t('usageMonitor.text.waitingForNewRecords'), value: null, partial: true }
  if (!partial && measured === 0) return { text: t('usageMonitor.text.noOutput'), value: 0, partial: false }
  return { text: window.coveredMs > 0 ? t('usageMonitor.text.insufficientSampling') : t('usageMonitor.text.noSamples'), value: null, partial }
}
