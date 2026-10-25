import { config } from '@vue/test-utils'
import { beforeEach } from 'vitest'
import i18n from '@/i18n'
import en from '@/i18n/locales/en/usageMonitor'
import zh from '@/i18n/locales/zh/usageMonitor'
import desktopEn from '@/i18n/locales/en/desktop'
import desktopZh from '@/i18n/locales/zh/desktop'
import costDataEn from '@/i18n/locales/en/costData'
import costDataZh from '@/i18n/locales/zh/costData'
import componentsEn from '@/i18n/locales/en/costComponents'
import componentsZh from '@/i18n/locales/zh/costComponents'

config.global.plugins = [...(config.global.plugins ?? []), i18n]

beforeEach(() => {
  i18n.global.setLocaleMessage('en', { usageMonitor: en, desktop: desktopEn, costData: costDataEn, ...componentsEn })
  i18n.global.setLocaleMessage('zh', { usageMonitor: zh, desktop: desktopZh, costData: costDataZh, ...componentsZh })
  i18n.global.locale.value = 'zh'
})
