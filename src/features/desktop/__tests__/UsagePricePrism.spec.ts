import './usageI18nFixture'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import UsagePricePrism from '../UsagePricePrism.vue'

beforeEach(() =>
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    }
  )
)
afterEach(() => vi.unstubAllGlobals())

it('preserves measured counts, exact percentages and removes zero-category geometry', async () => {
  const wrapper = mount(UsagePricePrism, {
    props: {
      total: 3313,
      parts: [
        { state: 'known', count: 2882, percent: (2882 / 3313) * 100 },
        { state: 'unknown', count: 431, percent: (431 / 3313) * 100 },
        { state: 'missing', count: 0, percent: 0 }
      ]
    }
  })
  expect(wrapper.get('.prism-total').text()).toContain('3,313')
  expect(wrapper.findAll('.prism-label').map((row) => row.attributes('data-count'))).toEqual(['2882', '431'])
  expect(wrapper.get('[data-state=known]').text()).toContain('87.0%')
  expect(wrapper.get('[data-state=unknown]').text()).toContain('模式没记录 431 次')
  expect(wrapper.find('[data-state=missing]').exists()).toBe(false)
  await wrapper.setProps({
    total: 4,
    parts: [
      { state: 'known', count: 1, percent: 25 },
      { state: 'unknown', count: 2, percent: 50 },
      { state: 'missing', count: 1, percent: 25 }
    ]
  })
  expect(wrapper.findAll('.prism-label').map((row) => row.attributes('data-percent'))).toEqual([
    '25',
    '50',
    '25'
  ])
  expect(wrapper.get('pattern[id$="missing-hatch"] use[stroke="#e5a38f"]').attributes('stroke')).toBe(
    '#e5a38f'
  )
  expect(wrapper.findAll('polygon').every((p) => !p.attributes('points').match(/NaN|Infinity/))).toBe(true)
  const sides = wrapper.findAll('.prism-side-material')
  expect(sides).toHaveLength(2)
  expect(Number(sides[0].attributes('x'))).toBeLessThan(740)
  expect(Number(sides[1].attributes('x'))).toBe(740)
  expect(sides[1].attributes('filter')).toContain('missingMaterial')
})

it('isolates definitions between instances and renders a full single category without a false remainder', () => {
  const props = {
    total: 10,
    parts: [{ state: 'known' as const, count: 10, percent: 100 }]
  }
  const first = mount(UsagePricePrism, { props }),
    second = mount(UsagePricePrism, { props })
  const ids = first.findAll('[id]').map((node) => node.attributes('id'))
  expect(second.findAll('[id]').every((node) => !ids.includes(node.attributes('id')))).toBe(true)
  expect(first.findAll('.prism-label')).toHaveLength(1)
  expect(first.text()).toContain('100.0%')
  expect(first.findAll('polygon').every((p) => !p.attributes('points').match(/NaN|Infinity/))).toBe(true)
})

it('keeps the reference weave density and legible fine strokes in small containers', async () => {
  let resize = () => {}
  const disconnect = vi.fn()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback
      }
      observe() {}
      disconnect = disconnect
    }
  )
  const wrapper = mount(UsagePricePrism, {
    props: {
      total: 100,
      parts: [
        { state: 'known', count: 87, percent: 87 },
        { state: 'unknown', count: 13, percent: 13 }
      ]
    }
  })
  try {
    Object.defineProperty(wrapper.element, 'clientWidth', { value: 820, configurable: true })
    resize()
    await nextTick()
    Object.defineProperty(wrapper.element, 'clientWidth', { value: 390, configurable: true })
    resize()
    await nextTick()
    expect(wrapper.get('pattern[id$=referenceBrush]').element.getAttribute('patternTransform')).toBe(
      `scale(${820 / 390})`
    )
    expect((Number(wrapper.get('pattern[id$=unknown-hatch]').attributes('width')) * 390) / 820).toBeCloseTo(
      (13 * 390) / 820
    )
    expect((Number(wrapper.get('.prism-ruler').attributes('stroke-width')) * 390) / 820).toBeCloseTo(1.6)
    expect((Number(wrapper.get('.prism-cut-slot').attributes('stroke-width')) * 390) / 820).toBeCloseTo(0.7)
    expect(wrapper.get('[data-state=unknown]').attributes('data-count')).toBe('13')
    expect(wrapper.get('pattern[id$=champagneTop]').attributes('patternTransform')).toBe('scale(1)')
    Object.defineProperty(wrapper.element, 'clientWidth', { value: 200, configurable: true })
    resize()
    await nextTick()
    expect((Number(wrapper.get('pattern[id$=unknown-hatch]').attributes('width')) * 200) / 820).toBeCloseTo(6)
  } finally {
    wrapper.unmount()
    vi.unstubAllGlobals()
  }
  expect(disconnect).toHaveBeenCalledOnce()
})

it('keeps connection laminates translucent and rear frame visible only through its side', () => {
  const wrapper = mount(UsagePricePrism, {
    props: {
      total: 100,
      parts: [
        { state: 'known', count: 87, percent: 87 },
        { state: 'unknown', count: 13, percent: 13 }
      ]
    }
  })
  const layers = wrapper.findAll('.prism-core, .prism-laminate')
  expect(layers[0].classes()).toContain('prism-core')
  expect(wrapper.findAll('.prism-laminate')).toHaveLength(3)
  const rimRight = Math.max(
    ...wrapper
      .get('.prism-silver-rim')
      .attributes('points')
      .split(' ')
      .map((point) => Number(point.split(',')[0]))
  )
  expect(
    wrapper
      .findAll('.prism-laminate polygon')
      .every((layer) => Number(layer.attributes('points').split(',')[0]) > rimRight)
  ).toBe(true)
  expect(
    wrapper
      .findAll('.prism-laminate polygon')
      .every((layer) => Number(layer.attributes('fill-opacity')) < 0.2)
  ).toBe(true)
  expect(wrapper.get('.prism-side-material').attributes('clip-path')).toContain('unknown-side-clip')
  expect(wrapper.get('.prism-top-bevel').exists()).toBe(true)
  wrapper.unmount()
})
