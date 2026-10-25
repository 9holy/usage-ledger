import { expect, it } from 'vitest'
import en from '../locales/en/desktop'
import zh from '../locales/zh/desktop'

function entries(value: object, prefix = ''): Array<[string, string]> {
  return Object.entries(value).flatMap(([key, child]) => typeof child === 'string'
    ? [[prefix + key, child] as [string, string]]
    : entries(child, prefix + key + '.'))
}

it('keeps the desktop locale keys complete in both languages', () => {
  const english = entries(en)
  const chinese = entries(zh)
  expect(english.length).toBeGreaterThan(50)
  expect(english.map(([key]) => key)).toEqual(chinese.map(([key]) => key))
  expect(english.every(([, value]) => value.trim() && !/\p{Script=Han}/u.test(value))).toBe(true)
  expect(chinese.every(([, value]) => value.trim())).toBe(true)
  for (let index = 0; index < english.length; index++) {
    expect(english[index][1].match(/\{\w+\}/g) ?? []).toEqual(chinese[index][1].match(/\{\w+\}/g) ?? [])
  }
})
