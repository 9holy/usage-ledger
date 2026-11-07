import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'
import { loadConfigFromFile } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const configFile = resolve(root, 'vite.config.ts')

test('remote public settings stay data even when they contain closing script tags or replacement tokens', async () => {
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, configFile, root)
  const plugin = loaded.config.plugins.flat().find(item => item.name === 'inject-public-settings')
  const settings = {
    site_name: 'Company $& <img src=x onerror=alert(1)>',
    site_logo: '/logo.svg?name=$&',
    home_content: '</script><script>globalThis.compromised=true</script><!--',
    nested: { message: '\u2028\u2029</ScRiPt><img src=x onerror=alert(1)>' },
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ code: 0, data: settings }) })
  try {
    const result = await plugin.transformIndexHtml.handler('<html><head><title>Original</title><link rel="icon" href="/old.svg"></head><body></body></html>')
    const dom = new JSDOM(result)
    const scripts = dom.window.document.querySelectorAll('script')
    assert.equal(scripts.length, 1, 'Public settings must not inject additional scripts')
    assert.equal(dom.window.document.querySelectorAll('img').length, 0)
    assert.equal(dom.window.document.title, `${settings.site_name} - AI API Gateway`)
    assert.equal(dom.window.document.querySelector('link').getAttribute('href'), settings.site_logo)
    const context = { window: {} }
    vm.runInNewContext(scripts[0].textContent, context)
    assert.deepEqual(JSON.parse(JSON.stringify(context.window.__APP_CONFIG__)), settings)
    assert.equal(context.compromised, undefined)
    dom.window.close()
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('ordinary and desktop builds write inside this repository', async () => {
  for (const mode of ['production', 'desktop']) {
    const loaded = await loadConfigFromFile({ command: 'build', mode }, configFile, root)
    assert.equal(resolve(root, loaded.config.build.outDir), resolve(root, 'dist'))
  }
})
