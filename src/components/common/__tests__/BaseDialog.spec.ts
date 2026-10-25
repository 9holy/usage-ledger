import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import BaseDialog from '../BaseDialog.vue'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key })
}))

describe('BaseDialog', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    document.body.classList.remove('modal-open')
  })

  it('resets body scroll position when reopened', async () => {
    const wrapper = mount(BaseDialog, {
      attachTo: document.body,
      props: { show: false, title: 'Details' },
      slots: { default: '<div style="height: 2000px">content</div>' },
      global: { stubs: { Icon: true } }
    })

    await wrapper.setProps({ show: true })
    await nextTick()
    const body = document.body.querySelector<HTMLElement>('.modal-body')
    expect(body).not.toBeNull()
    body!.scrollTop = 480

    await wrapper.setProps({ show: false })
    await wrapper.setProps({ show: true })
    await nextTick()

    expect(document.body.querySelector<HTMLElement>('.modal-body')?.scrollTop).toBe(0)
    wrapper.unmount()
  })

  it('keeps keyboard focus inside the dialog and restores its trigger', async () => {
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    const wrapper = mount(BaseDialog, {
      attachTo: document.body,
      props: { show: true, title: 'Confirm' },
      slots: { default: '<input aria-label="value">', footer: '<button type="button">Save</button>' },
      global: { stubs: { Icon: true } },
    })
    await nextTick()
    const dialog = document.body.querySelector<HTMLElement>('.modal-content')!
    const buttons = dialog.querySelectorAll('button')
    expect(document.activeElement).toBe(buttons[0])
    buttons[buttons.length - 1].focus()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(buttons[0])
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(buttons[buttons.length - 1])
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(wrapper.emitted('close')).toHaveLength(1)
    await wrapper.setProps({ show: false })
    expect(document.activeElement).toBe(trigger)
    wrapper.unmount()
  })

  it('has unique labels and does not unlock or steal focus from another open dialog', async () => {
    const options = { attachTo: document.body, props: { show: true, title: 'First' }, global: { stubs: { Icon: true } } }
    const first = mount(BaseDialog, options)
    await nextTick()
    const second = mount(BaseDialog, { ...options, props: { show: true, title: 'Second' } })
    await nextTick()
    const labels = [...document.body.querySelectorAll('.modal-overlay')].map(node => node.getAttribute('aria-labelledby'))
    expect(new Set(labels).size).toBe(2)
    const focused = document.activeElement
    await first.setProps({ show: false })
    expect(document.body.classList.contains('modal-open')).toBe(true)
    expect(document.activeElement).toBe(focused)
    first.unmount()
    expect(document.body.classList.contains('modal-open')).toBe(true)
    second.unmount()
    expect(document.body.classList.contains('modal-open')).toBe(false)
  })
})
