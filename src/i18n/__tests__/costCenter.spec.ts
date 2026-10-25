import { expect, it } from 'vitest'
import en from '../locales/en/costCenter'
import zh from '../locales/zh/costCenter'

function entries(object: object, prefix = ''): Array<[string, string]> {
  return Object.entries(object).flatMap(([key, value]) => typeof value === 'string'
    ? [[prefix + key, value] as [string, string]] : entries(value, prefix + key + '.'))
}

it('keeps cost-center messages complete, compilable and free of untranslated English labels', () => {
  const english = entries(en), chinese = entries(zh)
  expect(english.map(([key]) => key)).toEqual(chinese.map(([key]) => key))
  for (let index = 0; index < english.length; index++) {
    const [key, text] = english[index]
    expect(text, key).not.toMatch(/\p{Script=Han}/u)
    expect((text.match(/\{\w+\}/g) ?? []).sort(), key).toEqual((chinese[index][1].match(/\{\w+\}/g) ?? []).sort())
  }
})

it('uses plain labels without mixing usage estimates, user charges and account costs', () => {
  expect(zh.text.apiReferenceValue).toBe('用量估值')
  expect(en.text.apiReferenceValue).toBe('Usage value estimate')
  expect(zh.text.userBilling).toBe('用户计费')
  expect(en.text.userBilling).toBe('User charges')
  expect(zh.text.procurementCost).toBe('账号费用')
  expect(en.text.procurementCost).toBe('Account costs')
  expect(zh.text.someModelsLackPricesValueIsALower).toContain('金额尚未算全')
  expect(en.text.someModelsLackPricesValueIsALower).toContain('amount is incomplete')
  expect(zh.text.originalPriceEquivalentNotRevenueOrActualProcurement).toContain('不是营收')
  expect(en.text.originalPriceEquivalentNotRevenueOrActualProcurement).toContain('not revenue')
})
