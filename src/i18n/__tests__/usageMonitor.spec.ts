import { expect, it } from 'vitest'
import en from '../locales/en/usageMonitor'
import zh from '../locales/zh/usageMonitor'

function entries(value: object, prefix = ''): Array<[string, string]> {
  return Object.entries(value).flatMap(([key, child]) => typeof child === 'string'
    ? [[prefix + key, child] as [string, string]]
    : entries(child, prefix + key + '.'))
}

it('has matching usage-monitor messages and interpolation fields, without untranslated English labels', () => {
  const english = entries(en)
  const chinese = entries(zh)
  expect(english.map(([key]) => key)).toEqual(chinese.map(([key]) => key))
  for (let index = 0; index < english.length; index++) {
    expect(english[index][1], english[index][0]).not.toMatch(/\p{Script=Han}/u)
    expect(english[index][1].match(/\{\w+\}/g) ?? [], english[index][0]).toEqual(chinese[index][1].match(/\{\w+\}/g) ?? [])
  }
})
