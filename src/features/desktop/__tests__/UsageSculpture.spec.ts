import './usageI18nFixture'
import { mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import { Group } from 'three'
import UsageSculpture from '../UsageSculpture.vue'

const stage = vi.hoisted(() => ({
  replace: vi.fn(),
  resize: vi.fn(),
  dispose: vi.fn(),
  focus: vi.fn(),
  anchors: vi.fn(() => ({ requested: { x: 18, y: 44 } }))
}))
vi.mock('../usageEfficiencyScene', () => ({
  createEfficiencyStage: () => stage
}))
const originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
afterEach(() => {
  if (originalWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalWidth)
  else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
  vi.clearAllMocks()
})
it('reuses GPU geometry for unchanged snapshots and releases it when unmounted', async () => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 800
  })
  const initial = vi.fn(() => new Group()),
    fresh = vi.fn(() => new Group())
  const wrapper = mount(UsageSculpture, {
    props: {
      kind: 'token',
      signature: 'same-data',
      factory: initial,
      label: '真实统计'
    }
  })
  expect(initial).toHaveBeenCalledTimes(1)
  expect(wrapper.emitted('anchors')?.[0]).toEqual([{ requested: { x: 18, y: 44 } }])
  await wrapper.setProps({ factory: fresh })
  expect(fresh).not.toHaveBeenCalled()
  await wrapper.setProps({ signature: 'changed-data' })
  expect(fresh).toHaveBeenCalledTimes(1)
  expect(wrapper.attributes('aria-label')).toBe('真实统计')
  wrapper.unmount()
  expect(stage.dispose).toHaveBeenCalledTimes(1)
})
