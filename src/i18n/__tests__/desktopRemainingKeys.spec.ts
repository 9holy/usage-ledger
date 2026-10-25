import { expect, it } from 'vitest'
import en from '../locales/en'
import zh from '../locales/zh'

const repaired = [
  'common.required', 'common.tryAgain', 'common.sending', 'common.apply', 'common.creating', 'common.clear',
  'admin.accounts.fromModel', 'admin.accounts.toModel', 'admin.accounts.messages.accountCreated',
  'admin.users.passwordCopied', 'admin.channels.noGroupsSelected', 'admin.channels.emptyModelsInPricing',
  'admin.ops.runtime.metricThresholds', 'admin.ops.runtime.metricThresholdsHint',
  'admin.ops.runtime.slaMinPercent', 'admin.ops.runtime.slaMinPercentHint',
  'admin.ops.runtime.ttftP99MaxMs', 'admin.ops.runtime.ttftP99MaxMsHint',
  'admin.ops.runtime.requestErrorRateMaxPercent', 'admin.ops.runtime.requestErrorRateMaxPercentHint',
  'admin.ops.runtime.upstreamErrorRateMaxPercent', 'admin.ops.runtime.upstreamErrorRateMaxPercentHint',
  'cliproxy.nav.unifiedCost', 'desktop.nav.costMonitor', 'desktop.nav.backToCostMonitor',
]

function message(locale: object, key: string): unknown {
  return key.split('.').reduce((node: any, part) => node?.[part], locale)
}

it.each(repaired)('resolves the actual registered static UI key %s in both languages', key => {
  const english = message(en, key)
  const chinese = message(zh, key)
  expect(typeof english).toBe('string')
  expect(typeof chinese).toBe('string')
  expect(english).not.toMatch(/\p{Script=Han}/u)
  expect((english as string).match(/\{\w+\}/g) ?? []).toEqual((chinese as string).match(/\{\w+\}/g) ?? [])
})
