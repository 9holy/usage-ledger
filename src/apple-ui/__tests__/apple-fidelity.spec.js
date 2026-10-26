import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initAppleFidelity } from '../apple-fidelity.mjs'

describe('Apple fidelity update work', () => {
  let root
  let runtime
  let frames
  let resizeCallbacks

  const mutations = () => new Promise(resolve => queueMicrotask(resolve))
  const renderFrames = () => {
    for (const [id, callback] of frames) {
      frames.delete(id)
      callback(0)
    }
  }

  beforeEach(() => {
    initAppleFidelity(document).destroy()
    root = document.createElement('main')
    document.body.append(root)
    frames = new Map()
    resizeCallbacks = []
    let nextFrame = 0
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      frames.set(++nextFrame, callback)
      return nextFrame
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => frames.delete(id))
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback) { resizeCallbacks.push(callback) }
      observe() {}
      disconnect() {}
    })
  })

  afterEach(() => {
    runtime?.destroy()
    root.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('does not scan or measure the page for repeated text-only updates', async () => {
    root.innerHTML = '<span>0</span>'
    const query = vi.spyOn(root, 'querySelectorAll')
    const measure = vi.spyOn(root, 'getBoundingClientRect')
    runtime = initAppleFidelity(root)
    query.mockClear()
    measure.mockClear()

    for (let value = 1; value <= 100; value++) {
      root.firstChild.textContent = String(value)
      await mutations()
    }

    expect(query).not.toHaveBeenCalled()
    expect(measure).not.toHaveBeenCalled()
  })

  it('binds inserted scroll sources, late targets, and restores their attributes', async () => {
    runtime = initAppleFidelity(root)
    root.innerHTML = '<section data-aui-scroll-edge-source data-aui-scroll-edge-target="#late-edge"></section>'
    await mutations()
    const source = root.querySelector('section')
    expect(source.hasAttribute('data-aui-scroll-edge-bound')).toBe(false)

    const target = document.createElement('header')
    target.id = 'late-edge'
    root.append(target)
    await mutations()
    renderFrames()
    expect(source.hasAttribute('data-aui-scroll-edge-bound')).toBe(true)
    expect(target.getAttribute('data-aui-scroll-edge-state')).toBe('none')

    source.scrollTop = 42
    source.dispatchEvent(new Event('scroll'))
    renderFrames()
    expect(target.getAttribute('data-aui-scroll-edge-state')).toBe('hard')
    runtime.destroy()
    expect(source.hasAttribute('data-aui-scroll-edge-bound')).toBe(false)
    expect(target.hasAttribute('data-aui-scroll-edge-state')).toBe(false)
  })

  it('updates width classes through the existing resize observer', () => {
    const measure = vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ width: 400 })
    runtime = initAppleFidelity(root)
    expect(root.getAttribute('data-aui-size-class')).toBe('compact')
    measure.mockReturnValue({ width: 800 })
    resizeCallbacks[0]()
    expect(root.getAttribute('data-aui-size-class')).toBe('regular')
    measure.mockReturnValue({ width: 1200 })
    resizeCallbacks[0]()
    expect(root.getAttribute('data-aui-size-class')).toBe('expanded')
  })

  it('retains mutation-driven sizing when ResizeObserver is unavailable', async () => {
    delete window.ResizeObserver
    root.innerHTML = '<span>before</span>'
    const measure = vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({ width: 400 })
    runtime = initAppleFidelity(root)
    measure.mockReturnValue({ width: 800 })
    root.firstChild.textContent = 'after'
    await mutations()
    expect(root.getAttribute('data-aui-size-class')).toBe('regular')
  })
})
