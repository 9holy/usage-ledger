import { mountWithCostI18n as mount } from './costI18n'
import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import GlassQualityChart from '../GlassQualityChart.vue'
const spies = vi.hoisted(() => ({ draw: vi.fn(() => true), release: vi.fn() }))
vi.mock('../glassChartRenderer', () => ({ glassGeneration: () => 1, loadQualityArtwork: vi.fn(), drawGlassSplit: spies.draw, retainGlassRenderer: () => spies.release }))
vi.mock('../CostLineChart.vue', () => ({ default: { name: 'CostLineChart', props: ['labels', 'series', 'events', 'height', 'state'], template: '<div class="history-stub" />' } }))
const make = (data: Array<Array<number | null>>, state = 'measured') => mount(GlassQualityChart, { props: { labels: ['a', 'b'], series: data.map((values, i) => ({ label: ['成功', '失败', '切号事件'][i], color: ['#50d9b4', '#f28f85', '#79bdff'][i], data: values })), state: state as any } })
describe('GlassQualityChart honest summary and lifecycle', () => {
 it('uses only paired known buckets for rate and excludes switching from requests', () => {
  const w = make([[10, null], [2, 3], [8, 9]])
  expect(w.get('.quality-inlet strong').text()).toBe('12')
  expect(w.get('.quality-success strong').text()).toBe('10')
  expect(w.get('.quality-failure strong').text()).toBe('2')
  expect(w.get('.quality-rate strong').text()).toBe('83.3%')
  expect(w.get('.quality-switch strong').text()).toBe('17')
  expect(w.get('.quality-proof').text()).toContain('1/2 个时段的记录完整')
  expect(w.get('.quality-switch').text()).toContain('不计入请求')
  w.unmount()
 })
 it('keeps unknown distinct from measured zero and does not invent a zero-denominator rate', () => {
  const unknown = make([[null,null],[null,null],[null,null]])
  expect(unknown.get('.quality-inlet strong').text()).toBe('—'); expect(unknown.get('.quality-rate strong').text()).toBe('—'); unknown.unmount()
  const zero = make([[0,0],[0,0],[0,0]])
  expect(zero.get('.quality-inlet strong').text()).toBe('0'); expect(zero.get('.quality-rate strong').text()).toBe('—'); zero.unmount()
 })
 it('preserves raw historical arrays/gaps and switches its accessible legend for both views', async () => {
  const w = make([[10,null],[2,3],[8,9]])
  await w.get('[role="tab"]:nth-child(2)').trigger('click')
  const chart = w.findComponent({ name: 'CostLineChart' })
  expect(chart.props('series').map((s: any) => s.data)).toEqual([[10,null],[2,3],[8,9]])
  await w.get('[aria-label="显示成功"]').trigger('click')
  expect(chart.props('series')[0].data).toEqual([null,null]); expect(chart.props('series')[1].data).toEqual([2,3])
  await w.get('[role="tab"]:nth-child(1)').trigger('click')
  expect(w.get('.quality-success strong').text()).toBe('已隐藏')
  w.unmount()
 })
 it('retains unavailable state rather than manufacturing summaries', () => {
  const w = make([[1,2],[0,0],[0,0]],'unavailable')
  expect(w.find('.quality-inlet').exists()).toBe(false); expect(w.find('[role="status"]').exists()).toBe(true);w.unmount()
 })
 it('retries an asynchronously loaded material rather than caching an incomplete draw', async () => {
  spies.draw.mockReset().mockReturnValue(false)
  const w=make([[10,2],[1,0],[0,0]])
  await nextTick(); await nextTick()
  expect(w.find('.quality-fallback').exists()).toBe(true)
  spies.draw.mockReturnValue(true)
  window.dispatchEvent(new Event('cost-gl-artwork-ready'))
  await nextTick()
  expect(w.find('.quality-fallback').exists()).toBe(false)
  w.unmount()
 })
 it('releases renderer and redraw listeners on unmount', async () => {
  spies.release.mockClear(); const w=make([[1,2],[0,0],[0,0]]); await nextTick();w.unmount();expect(spies.release).toHaveBeenCalledOnce()
  spies.draw.mockClear();window.dispatchEvent(new Event('cost-gl-restored'));await nextTick();expect(spies.draw).not.toHaveBeenCalled()
 })
})
