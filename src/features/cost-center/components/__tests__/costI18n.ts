import { mount, shallowMount } from '@vue/test-utils'
import { beforeEach } from 'vitest'
import { i18n } from '@/i18n'
import zh from '@/i18n/locales/zh/costComponents'
import en from '@/i18n/locales/en/costComponents'
import zhCommon from '@/i18n/locales/zh/common'
import enCommon from '@/i18n/locales/en/common'

i18n.global.mergeLocaleMessage('zh', { ...zhCommon, ...zh })
i18n.global.mergeLocaleMessage('en', { ...enCommon, ...en })
beforeEach(() => { i18n.global.locale.value = 'zh' })

export function costComponentI18n(locale: 'zh' | 'en' = 'zh') {
  i18n.global.locale.value = locale
  return i18n
}

function optionsWithI18n(options: any = {}) {
  return { ...options, global: { ...options.global, plugins: [costComponentI18n(), ...(options.global?.plugins ?? [])] } }
}

export const mountWithCostI18n: typeof mount = (component: any, options?: any) => mount(component, optionsWithI18n(options))
export const shallowMountWithCostI18n: typeof shallowMount = (component: any, options?: any) => shallowMount(component, optionsWithI18n(options))
