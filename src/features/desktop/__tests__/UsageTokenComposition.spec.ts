import './usageI18nFixture'
import { mount } from '@vue/test-utils'
import { describe, it, expect } from 'vitest'
import UsageTokenComposition from '../UsageTokenComposition.vue'
describe('Token reservoir data', () => {
  it('retains small positive shares and zero quantities', async () => {
    const w = mount(UsageTokenComposition, {
      props: { inputTokens: 443048, cacheReadTokens: 442624, outputTokens: 82 },
    })
    expect(w.get('.token-readout.output').text()).toContain('<0.1%')
    expect(w.findAll('.token-parts>div').at(-1)!.attributes('title')).toContain(
      '82 Token',
    )
    await w.setProps({ outputTokens: 0 })
    expect(w.get('.token-readout.output strong').text()).toBe('0')
    expect(w.findAll('.token-parts>div').at(-1)!.attributes('style')).toContain(
      'width: 0%',
    )
  })
  it('counts cache within input exactly once and labels the denominator', async () => {
    const w = mount(UsageTokenComposition, {
      props: { inputTokens: 800, cacheReadTokens: 600, outputTokens: 200 },
    })
    expect(
      w
        .findAll('[data-tokens]')
        .map((e) => Number(e.attributes('data-tokens'))),
    ).toEqual([200, 600, 200])
    expect(
      w
        .findAll('[data-percent]')
        .map((e) => Number(e.attributes('data-percent'))),
    ).toEqual([20, 60, 20])
    expect(w.get('.cache-insight strong').text()).toBe('75.0%')
    expect(w.get('.token-total strong').attributes('title')).toBe('1,000')
    await w.setProps({ partial: true })
    expect(w.text()).toContain('已记录的缓存读取')
    await w.setProps({ inputTokens: null })
    expect(w.find('.token-landscape').exists()).toBe(false)
    expect(w.text()).toContain('尚未取得完整')
  })
  it('does not invent absent cache, and isolates SVG ids', () => {
    const a = mount(UsageTokenComposition, {
      props: { inputTokens: 100, outputTokens: 20, cacheReadTokens: null },
    })
    const b = mount(UsageTokenComposition, {
      props: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 90 },
    })
    expect(a.findAll('.token-parts>div')).toHaveLength(2)
    expect(a.get('.token-readout.cache').text()).toContain('未记录')
    const ids = new Set(a.findAll('[id]').map((e) => e.attributes('id')))
    expect(b.findAll('[id]').every((e) => !ids.has(e.attributes('id')))).toBe(
      true,
    )
  })
})

it('moves photographed water surfaces with the true denominators and removes zero flow', async () => {
  const w = mount(UsageTokenComposition, {
    props: { inputTokens: 800, cacheReadTokens: 600, outputTokens: 200 },
  })
  expect(w.get('[data-vessel=cache]').attributes('data-level')).toBe('0.75')
  expect(w.get('[data-vessel=fresh]').attributes('data-level')).toBe('0.25')
  expect(w.get('[data-vessel=output]').attributes('data-level')).toBe('0.2')
  expect(
    w.get('[data-vessel=output] .token-liquid-surface').attributes('transform'),
  ).toBe('translate(0,76)')
  await w.setProps({ outputTokens: 0, cacheReadTokens: 0 })
  expect(w.find('[data-vessel=cache] image').exists()).toBe(false)
  expect(w.find('[data-vessel=output] image').exists()).toBe(false)
  expect(w.find('.token-output-flow').exists()).toBe(false)
  expect(w.get('[data-vessel=fresh]').attributes('data-level')).toBe('1')
})
