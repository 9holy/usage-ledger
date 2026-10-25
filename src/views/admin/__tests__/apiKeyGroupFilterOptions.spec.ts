import { describe, it, expect } from 'vitest'
import { buildApiKeyGroupFilterOptions } from '../apiKeyGroupFilterOptions'
import type { AdminGroup } from '@/types'

const labels = {
  all: 'All',
  exclusive: 'Exclusive',
  public: 'Public',
  subscription: 'Subscription',
  disabled: 'Disabled',
}

function g(partial: Partial<AdminGroup>): AdminGroup {
  return {
    id: 0,
    name: '',
    status: 'active',
    is_exclusive: false,
    subscription_type: 'standard',
    ...partial,
  } as AdminGroup
}

describe('buildApiKeyGroupFilterOptions', () => {
  it('partitions active groups into exclusive/public/subscription with headers', () => {
    const groups = [
      g({ id: 1, name: 'Excl', is_exclusive: true, subscription_type: 'standard' }),
      g({ id: 2, name: 'Pub', is_exclusive: false, subscription_type: 'standard' }),
      g({ id: 3, name: 'Sub', is_exclusive: false, subscription_type: 'subscription' }),
    ]
    expect(buildApiKeyGroupFilterOptions(groups, labels)).toEqual([
      { value: null, label: 'All' },
      { value: -1, label: 'Exclusive', kind: 'group', disabled: true },
      { value: 1, label: 'Excl' },
      { value: -2, label: 'Public', kind: 'group', disabled: true },
      { value: 2, label: 'Pub' },
      { value: -3, label: 'Subscription', kind: 'group', disabled: true },
      { value: 3, label: 'Sub' },
    ])
  })

  it('treats subscription_type=subscription as subscription even if is_exclusive', () => {
    const groups = [g({ id: 9, name: 'X', is_exclusive: true, subscription_type: 'subscription' })]
    const opts = buildApiKeyGroupFilterOptions(groups, labels)
    expect(opts).toContainEqual({ value: 9, label: 'X' })
    expect(opts.find((o) => o.label === 'Subscription')).toBeDefined()
    expect(opts.find((o) => o.label === 'Exclusive')).toBeUndefined()
  })

  it('skips empty section headers', () => {
    const groups = [g({ id: 2, name: 'Pub', is_exclusive: false, subscription_type: 'standard' })]
    const opts = buildApiKeyGroupFilterOptions(groups, labels)
    expect(opts.find((o) => o.label === 'Exclusive')).toBeUndefined()
    expect(opts.find((o) => o.label === 'Subscription')).toBeUndefined()
    expect(opts).toContainEqual({ value: -2, label: 'Public', kind: 'group', disabled: true })
  })

  it('places non-active groups in a separate disabled section (not omitted)', () => {
    const groups = [
      g({ id: 1, name: 'Active', is_exclusive: true }),
      g({ id: 2, name: 'Inactive', is_exclusive: true, status: 'inactive' }),
    ]
    const opts = buildApiKeyGroupFilterOptions(groups, labels)
    // Active exclusive group appears in Exclusive section
    expect(opts).toContainEqual({ value: 1, label: 'Active' })
    // Disabled group appears in Disabled section
    expect(opts).toContainEqual({ value: 2, label: 'Inactive' })
    // Disabled section header present
    expect(opts).toContainEqual({ value: -4, label: 'Disabled', kind: 'group', disabled: true })
    // Not in Exclusive section
    const exclIdx = opts.findIndex((o) => o.value === -1)
    const disabledItemIdx = opts.findIndex((o) => o.value === 2)
    expect(exclIdx).toBeLessThan(disabledItemIdx)
  })

  it('section headers use distinct negative values (no duplicate Vue :key)', () => {
    const groups = [
      g({ id: 1, name: 'E', is_exclusive: true }),
      g({ id: 2, name: 'P', is_exclusive: false }),
      g({ id: 3, name: 'S', subscription_type: 'subscription' }),
      g({ id: 4, name: 'D', status: 'inactive' }),
    ]
    const opts = buildApiKeyGroupFilterOptions(groups, labels)
    const headerValues = opts.filter((o) => o.kind === 'group').map((o) => o.value)

    // ★ 扫描面非空(2026-09-22):`headerValues` 一为空,下面两条断言就**全部恒真** ——
    //   `unique.size === 0 === headerValues.length`,而 `forEach` 一次都不跑。
    //   整个用例会在「什么都没验」的情况下变绿,而测试名仍然声称验了段头。
    //   输入是 4 个分组,分别落进 exclusive / public / subscription / disabled 四段
    //   ⇒ 段头必须恰好是这四个哨兵值(-1 / -2 / -3 / -4)。
    //   注意字面量是**降序**的 -1 > -2 > -3 > -4;排序后应得升序 [-4, -3, -2, -1]。
    //   (2026-09-22:这里第一版写成 [-1, -2, -3, -4],被这条断言当场打红 —— 断言先抓住了写它的人。)
    expect(
      [...headerValues].sort((a, b) => a - b),
      '段头集合变了 —— 下面两条断言可能恒真',
    ).toEqual([-4, -3, -2, -1])

    const unique = new Set(headerValues)
    expect(unique.size).toBe(headerValues.length) // all distinct
    headerValues.forEach((v) => expect(v).toBeLessThan(0)) // all negative
  })

  it('returns only the all-option when there are no groups', () => {
    expect(buildApiKeyGroupFilterOptions([], labels)).toEqual([{ value: null, label: 'All' }])
  })
})
