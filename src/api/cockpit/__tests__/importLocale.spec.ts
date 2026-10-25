import '@/api/__tests__/costCenterLocaleFixture'
import { beforeEach, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import i18n from '@/i18n'
import { importCockpitCodexAccounts, importCockpitRoutingRules } from '../index'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@/api/url', () => ({ isDesktopRuntime: () => true }))
vi.mock('@/stores/connection', () => ({ errMsg: (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback }))

beforeEach(() => { vi.clearAllMocks() })

it('keeps imported account data and write payloads unchanged while the returned message follows locale', async () => {
  vi.mocked(invoke).mockImplementation(async command => command === 'read_cockpit_file' ? JSON.stringify({ accounts: [{ id: 'existing', email: '原始标识' }] }) as never : undefined as never)
  const result = await importCockpitCodexAccounts([{ id: 'existing' }, { id: 'new', email: '原始账号@example.test' }])
  expect(result).toMatchObject({ added: 1, skipped: 1, total: 2 })
  expect(result.message).toBe('导入 1 个新账号,跳过 1 个已存在,总计 2 个')
  const calls = vi.mocked(invoke).mock.calls.length
  i18n.global.locale.value = 'en'
  expect(result.message).toBe('Accounts imported: 1; existing accounts skipped: 1; total: 2')
  expect(invoke).toHaveBeenCalledTimes(calls)
  const payload = vi.mocked(invoke).mock.calls.find(([name]) => name === 'write_cockpit_file')?.[1] as { content: string }
  expect(JSON.parse(payload.content).accounts[1].email).toBe('原始账号@example.test')
})

it('keeps routing replacement rules unchanged while switching the result message', async () => {
  vi.mocked(invoke).mockImplementation(async command => command === 'read_cockpit_file' ? JSON.stringify({ customRoutingRules: [{ accountId: 'existing', priority: 1, weight: 1 }] }) as never : undefined as never)
  const rules = [{ accountId: 'existing', priority: 2, weight: 3 }, { accountId: 'new', priority: 4, weight: 5 }]
  const result = await importCockpitRoutingRules(rules)
  expect(result).toMatchObject({ added: 1, skipped: 1, total: 2 })
  const calls = vi.mocked(invoke).mock.calls.length
  i18n.global.locale.value = 'en'
  expect(result.message).toBe('Rules imported: 1; existing rules updated: 1; total: 2')
  expect(invoke).toHaveBeenCalledTimes(calls)
  const payload = vi.mocked(invoke).mock.calls.find(([name]) => name === 'write_cockpit_file')?.[1] as { content: string }
  expect(JSON.parse(payload.content).customRoutingRules).toEqual(rules)
})
