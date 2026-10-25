import { beforeEach } from 'vitest'
import { i18n } from '@/i18n'
import '../costDataText'

i18n.global.locale.value = 'zh'
beforeEach(() => { i18n.global.locale.value = 'zh' })
