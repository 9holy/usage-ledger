import { beforeEach } from 'vitest'
import i18n from '@/i18n'
import en from '@/i18n/locales/en/costCenter'
import zh from '@/i18n/locales/zh/costCenter'

beforeEach(() => {
  i18n.global.setLocaleMessage('en', { costCenter: en })
  i18n.global.setLocaleMessage('zh', { costCenter: zh })
  i18n.global.locale.value = 'zh'
})
