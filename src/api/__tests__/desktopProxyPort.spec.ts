import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.doUnmock('../../../package.json')
  vi.resetModules()
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
})

it.each([
  ['0.2.50',18765],
  ['0.2.51',18765],
  ['0.2.51-preview.13',18766],
])('keeps the %s desktop API and cost clients on port %i',async(version,port)=>{
  vi.resetModules()
  vi.doMock('../../../package.json',()=>({version}))
  ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__={}
  const api=await import('../url')
  expect(api.PROXY_PORT).toBe(port)
  expect(api.getAPIBaseURL()).toBe(`http://127.0.0.1:${port}`)
  expect(api.getCostServiceBaseURL()).toBe(`http://127.0.0.1:${port}`)
})
