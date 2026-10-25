import './usageI18nFixture'
import { mount } from '@vue/test-utils'
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import UsageEfficiencyBand from '../UsageEfficiencyBand.vue'
import { efficiencyColors } from '../usageEfficiencyScene'
import { buildCacheRibbonGeometry } from '../cacheRibbonGeometry'
import { cacheMaterialBand } from '../cacheRibbonMaterial'
import type { MonitorTotals } from '@/api/usageMonitor'
beforeAll(() => vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
afterAll(() => vi.unstubAllGlobals())

function totals(): MonitorTotals {
  return { inputTokens: 834871795, outputTokens: 100, totalTokens: 834871895, cacheReadTokens: 814000000, cacheWriteTokens: 0, requestCount: 3313, pricedCostUsd: 0, unpricedRequests: 431, incompleteRequests: 0, cacheHitRatio: .975, outputTokensPerSecond: 0,
    automaticPriceSummary: { byMode: { standard: { responseRequests: 0, requestedRequests: 2882, unknownRequests: 0, coveredRequests: 2882, byCurrency: {} }, unknown: { responseRequests: 0, requestedRequests: 0, unknownRequests: 431, coveredRequests: 0, byCurrency: {} } }, byCurrency: {} } }
}

describe('Cache efficiency and pricing geometry', () => {
  it('retains live shares and renders no invented flow for zero or missing data', () => {
    for (const ratio of [0, .000001, .38, .975, .97913, .999999, 1]) {
      const shape = buildCacheRibbonGeometry(ratio)
      expect(shape.hitShare).toBe(ratio)
      expect(shape.missShare).toBe(1-ratio)
      expect(shape.front.length > 0).toBe(ratio > 0)
      expect(shape.miss.length > 0).toBe(ratio < 1)
      for (const ribbon of [...shape.front,...shape.rear,...shape.miss]) {
        for (const surface of [ribbon.body, ribbon.highlight, ribbon.softHighlight, ribbon.shade]) {
          expect(surface).not.toMatch(/NaN|Infinity/)
          expect(surface.endsWith('Z')).toBe(true)
        }
        const numbers = ribbon.body.match(/-?\d+(?:\.\d+)?/g)!.map(Number)
        numbers.forEach((value,index)=>expect(value).toBeGreaterThanOrEqual(index%2?0:90))
        numbers.forEach((value,index)=>expect(value).toBeLessThan(index%2?285:700))
      }
    }
    for (const value of [null,NaN,Infinity,-.1,1.1]) {
      const shape=buildCacheRibbonGeometry(value)
      expect(shape.front).toHaveLength(0);expect(shape.miss).toHaveLength(0)
      expect(shape.hitShare).toBeNull()
    }
    expect(buildCacheRibbonGeometry(.975).front[0].body).not.toBe(buildCacheRibbonGeometry(.38).front[0].body)
  })
  it('reduces small-panel detail without changing the measured shares', () => {
    const wide=buildCacheRibbonGeometry(.975,760), small=buildCacheRibbonGeometry(.975,342)
    expect(small.front.length).toBeLessThan(wide.front.length)
    expect(small.rear.length).toBeLessThan(wide.rear.length)
    expect(small.missShare).toBeCloseTo(.025,12)
    expect(small.miss[0].strokeWidth).toBeGreaterThan(wide.miss[0].strokeWidth)
    expect(small.anchors.hit.x).toBeGreaterThan(100)
    expect(small.anchors.miss.y).toBeLessThan(280)
  })

  it('maps material only to real ribbon surfaces while live values change geometry', () => {
    const reference = buildCacheRibbonGeometry(.975), changed = buildCacheRibbonGeometry(.38)
    for (const kind of ['front', 'rear'] as const) {
      {
        const original = cacheMaterialBand(reference[kind], reference[kind])
        const updated = cacheMaterialBand(changed[kind], reference[kind], Math.sqrt(.38 / .975))
        expect(updated.positions).not.toEqual(original.positions)
        expect(updated.uvs).toEqual(original.uvs)
        expect(updated.positions.every(Number.isFinite)).toBe(true)
        expect(updated.indices.every(index => index < updated.positions.length / 3)).toBe(true)
        for (let j = 0; j < updated.uvs.length; j += 2) {
          const x = updated.uvs[j] * 760, y = (1 - updated.uvs[j + 1]) * 285
          expect(x > 240 && x < 355 && y > 10 && y < 75).toBe(false)
          expect(x > 450 && x < 575 && y > 210 && y < 255).toBe(false)
        }
      }
    }
  })

  it('displays period totals, actual estimate coverage, read/write values and color meaning', () => {
    const wrapper = mount(UsageEfficiencyBand, { props: { totals: totals() } })
    expect(wrapper.get('.cache-hit').text()).toContain('97.5%')
    expect(wrapper.get('.cache-miss').text()).toContain('2.5%')
    expect(wrapper.get('.cache-token-ledger').text()).toContain('8.14亿')
    expect(wrapper.get('.cache-token-ledger').text()).toContain('缓存写入0')
    expect(wrapper.get('.pricing-visual').text()).toContain('3,313')
    expect(wrapper.get('.prism-label[data-state=known]').text()).toContain('2,882')
    expect(wrapper.get('.prism-label[data-state=known]').text()).toContain('87.0%')
    expect(wrapper.get('.prism-label[data-state=unknown]').text()).toContain('431')
    expect(wrapper.get('.prism-label[data-state=unknown]').text()).toContain('13.0%')
    expect(wrapper.find('.prism-label[data-state=missing]').exists()).toBe(false)
    expect(wrapper.get('.prism-zero-states').text()).toContain('缺少价格 0')
    expect(wrapper.get('.efficiency-band').attributes('style')).toContain('--efficiency-unknown: #c9a66b')
    wrapper.unmount()
  })

  it('retains partial cache provenance and updates all three nonzero fee categories', async () => {
    const current = totals()
    current.cacheHitRatio = null; current.knownCacheHitRatio = .98; current.cacheKnownRequests = 2
    const wrapper = mount(UsageEfficiencyBand, { props: { totals: current } })
    expect(wrapper.get('.cache-visual').text()).toContain('输入和缓存信息齐全 2 / 3,313 次')
    expect(wrapper.get('.cache-hit').text()).toContain('98.0%')
    await wrapper.setProps({ totals: { ...current, requestCount: 4, automaticPriceSummary: { byMode: { standard: { responseRequests: 1, requestedRequests: 1, unknownRequests: 0, coveredRequests: 1, byCurrency: {} }, unknown: { responseRequests: 0, requestedRequests: 0, unknownRequests: 2, coveredRequests: 0, byCurrency: {} } }, byCurrency: {} } } })
    expect(wrapper.findAll('.prism-label').map(row => row.attributes('data-percent'))).toEqual(['25', '50', '25'])
    expect(wrapper.get('.prism-label[data-state=missing]').text()).toContain('缺少价格 1')
    wrapper.unmount()
  })

  it('distinguishes not-yet-loaded data, unknown cache and a genuinely empty period', async () => {
    const wrapper = mount(UsageEfficiencyBand)
    expect(wrapper.text()).toContain('尚未取得缓存统计')
    expect(wrapper.text()).toContain('尚未取得费用统计')
    expect(wrapper.find('.cache-hit').exists()).toBe(false)
    expect(wrapper.find('.prism-label').exists()).toBe(false)
    const empty = { ...totals(), requestCount: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheHitRatio: null }
    await wrapper.setProps({ totals: empty })
    expect(wrapper.text()).toContain('所选期间暂无请求')
    expect(wrapper.get('.cache-token-ledger').text()).not.toContain('未取得')
    expect(wrapper.find('.cache-hit').exists()).toBe(false)
    expect(wrapper.find('.prism-label').exists()).toBe(false)
    wrapper.unmount()
  })
  it('moves the miss readout clear of a large lower bundle as live ratios change', async () => {
    const wrapper = mount(UsageEfficiencyBand, { props: { totals: totals() } })
    expect(wrapper.get('.cache-visual').classes()).not.toContain('has-wide-miss')
    await wrapper.setProps({ totals: { ...totals(), cacheHitRatio: .38 } })
    expect(wrapper.get('.cache-visual').classes()).toContain('has-wide-miss')
    expect(wrapper.get('.cache-miss').text()).toContain('62.0%')
    await wrapper.setProps({ totals: { ...totals(), cacheHitRatio: 1 } })
    expect(wrapper.get('.cache-visual').classes()).not.toContain('has-wide-miss')
    wrapper.unmount()
  })

})


