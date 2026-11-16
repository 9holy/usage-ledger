import '@/features/desktop/__tests__/usageI18nFixture'
import {expect,it} from 'vitest'
import i18n from '@/i18n'
import {financeErrorText} from '../financeErrorText'

it('explains native finance rejections in the selected language and preserves unknown diagnostics',()=>{
  const error='Handle or void the active linked events before voiding their source'
  i18n.global.locale.value='zh'
  expect(financeErrorText(error)).toContain('请先处理或作废关联')
  expect(financeErrorText(new Error('Termination loss exceeds the remaining prepaid balance at its business time'))).toContain('不能超过')
  i18n.global.locale.value='en'
  expect(financeErrorText(new Error(error))).toBe('Handle or void the linked refunds and termination losses before voiding the original record.')
  expect(financeErrorText('SQLite busy')).toBe('SQLite busy')
})
