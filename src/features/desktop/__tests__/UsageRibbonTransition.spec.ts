import './usageI18nFixture'
import { mount } from '@vue/test-utils'
import { expect, it } from 'vitest'
import UsageEvidenceRibbon from '../UsageEvidenceRibbon.vue'

it('keeps transition centres on data boundaries and limits blending around tiny segments', () => {
  const w = mount(UsageEvidenceRibbon, {
    props: {
      total: 1000,
      label: 'test',
      parts: [
        { count: 500, color: '#79bdff' },
        { count: 1, color: '#c4a5f2' },
        { count: 499, color: '#a4afbd' },
      ],
    },
  })
  const gradients = w.findAll('linearGradient')
  expect(gradients).toHaveLength(2)
  for (const [i, boundary] of [0.5, 0.501].entries()) {
    const start = Number(gradients[i].attributes('x1')),
      end = Number(gradients[i].attributes('x2'))
    expect((start + end) / 2).toBeCloseTo(51 + 1946 * boundary)
    expect(end - start).toBeLessThanOrEqual(1946 * 0.001 * 0.4 + 0.00001)
  }
  expect(w.findAll('mask rect')[0].attributes('fill')).toBe('white')
  expect(
    w.findAll('image[data-start]').map((n) => Number(n.attributes('data-end'))),
  ).toEqual([0.5, 0.501, 1])
})

it('uses the first nonzero segment as a fully covered base and omits sheen for no data', async () => {
  const w = mount(UsageEvidenceRibbon, {
    props: {
      total: 100,
      label: 'test',
      parts: [
        { count: 0, color: '#79bdff' },
        { count: 100, color: '#c4a5f2' },
      ],
    },
  })
  expect(w.findAll('mask rect')[1].attributes('fill')).toBe('white')
  expect(w.findAll('linearGradient')).toHaveLength(0)
  await w.setProps({ total: 0, parts: [{ count: 0, color: '#79bdff' }] })
  expect(w.find('.ribbon-sheen').exists()).toBe(false)
})
