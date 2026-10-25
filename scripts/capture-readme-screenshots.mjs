import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(repo)
const version = JSON.parse(await readFile(path.join(repo, 'package.json'), 'utf8')).version
const output = path.join(repo, 'docs/screenshots')
const require = createRequire(import.meta.url)
const playwright = process.env.PLAYWRIGHT_MODULE || 'playwright-core'
let chromium, PNG
try {
  chromium = require(playwright).chromium
  PNG = require(path.join(path.dirname(require.resolve(playwright)), 'lib/utilsBundle.js')).PNG
} catch {
  throw new Error('Screenshot capture needs playwright-core. Install it in your tooling environment or set PLAYWRIGHT_MODULE to its package directory. Set BROWSER_EXECUTABLE to your Chromium executable when needed.')
}
const fixtureImport = '/docs/demo/readme-fixtures.js'
const entry = `
import {createApp,h} from 'vue';
import {createPinia} from 'pinia';
import {Chart as ChartJS} from 'chart.js';
import {createRouter,createMemoryHistory,RouterView} from 'vue-router';
import i18n,{initI18n} from '/src/i18n';
import '/src/style.css';
import '/src/apple-ui/apple-fidelity.css';
import '/src/apple-ui/apple-fidelity-profile.css';
import '/src/apple-ui/apple-fidelity.mjs';
import Monitor from '/src/views/UsageMonitorView.vue';
import Connect from '/src/views/ConnectView.vue';
import Cost from '/src/views/admin/CostCenterView.vue';
import {useConnectionStore} from '/src/stores/connection';
import {useAppStore} from '/src/stores/app';
import {authAPI,keysAPI} from '/src/api';
import {setActiveConnection} from '/src/api/url';
import {connection,publicSettings} from '${fixtureImport}';
ChartJS.register({id:'readme-static-charts',beforeInit(chart){chart.options.animation=false;},beforeUpdate(chart){chart.options.animation=false;}});
const app=createApp({render:()=>h(RouterView)});
app.config.errorHandler=e=>{window.__demoErrors.push(String(e.stack||e));};
app.use(createPinia());await initI18n();app.use(i18n);
const settings=useAppStore();settings.fetchPublicSettings=async()=>publicSettings;
const connections=useConnectionStore();connections.connections=[connection];connections.activeId=connection.id;connections.connected=true;
setActiveConnection(connection);
authAPI.getPublicSettings=async()=>publicSettings;
keysAPI.list=async()=>({items:[],total:0,page:1,page_size:100,pages:0});
const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',redirect:'/usage-monitor'},{path:'/usage-monitor',component:Monitor},{path:'/connect',component:Connect},{path:'/admin/cost-center',component:Cost}]});
app.use(router);await router.isReady();app.mount('#app');
window.__demoNavigate=path=>router.push(path);window.__demoTranslate=key=>i18n.global.t(key);window.__demoReady=true;
`
const plugin = {
  name: 'readme-demo-only', enforce: 'pre',
  resolveId(id) { if (id === '/readme-demo.js') return '\0readme-demo'; if (id === '@tauri-apps/api/core') return '\0readme-ipc' },
  load(id) { if (id === '\0readme-demo') return entry; if (id === '\0readme-ipc') return `import {invoke as fixtureInvoke} from '${fixtureImport}';export async function invoke(command,args){if(command==='set_desktop_locale')return null;return fixtureInvoke(command,args);}` },
  transform(source, id) {
    if (id.split('?')[0].endsWith('/features/cost-center/useCostCenterData.ts')) return source.replace('export function useCostCenterData()', 'function originalDemoData()') + `\nimport {fillCostData} from '${fixtureImport}';export function useCostCenterData(){return fillCostData(originalDemoData(),buildLocalEconomicsSnapshot,sourceState);}`
    if (id.split('?')[0].endsWith('/features/cost-center/useUnifiedCost.ts')) return source.replace('export function useUnifiedCost(', 'function originalDemoUnified(') + `\nimport {fillUnified} from '${fixtureImport}';export function useUnifiedCost(...args){return fillUnified(originalDemoUnified(...args));}`
  },
  configureServer(server) {
    server.middlewares.use('/readme-preview', async (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(await server.transformIndexHtml('/readme-preview', '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Usage Ledger DEMO</title><style>html,body,#app{min-height:100vh;background:#101413!important}body{margin:0}*{box-sizing:border-box}</style></head><body><div id="app"></div><script type="module" src="/readme-demo.js"></script></body></html>'))
    })
  },
}
const server = await createServer({ configFile: false, root: repo, cacheDir: process.env.README_CAPTURE_CACHE_DIR || path.join(repo, 'node_modules/.cache/readme-demo-capture'), resolve: { alias: { '@': path.join(repo, 'src') } }, plugins: [plugin, vue()], server: { host: '127.0.0.1', port: 0 }, logLevel: 'warn' })
let browser
const pages = [], errors = [], escapes = [], canvasChecks = [], unknownIPC = []
try {
  await mkdir(output, { recursive: true })
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] })
  for (const locale of ['en', 'zh']) {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1080 }, deviceScaleFactor: 1, locale: locale === 'en' ? 'en-US' : 'zh-CN', timezoneId: 'Asia/Taipei', colorScheme: 'dark' })
    await context.route('**/*', async route => {
      const url = new URL(route.request().url())
      if (url.origin === origin || url.protocol === 'data:' || url.protocol === 'blob:') await route.continue()
      else { escapes.push(url.origin); await route.abort() }
    })
    await context.addInitScript(locale => {
      const NativeDate = Date, fixed = NativeDate.parse('2026-10-18T08:00:00Z')
      window.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [fixed])) } static now() { return fixed } }
      window.__TAURI_INTERNALS__ = {}; window.__demoErrors = []; window.__demoUnknownIPC = []
      localStorage.setItem('sub2api_locale', locale); localStorage.setItem('theme', 'dark')
    }, locale)
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(origin + '/readme-preview')
    await page.waitForFunction(() => window.__demoReady)
    const translate = async key => {
      const label = await page.evaluate(key => window.__demoTranslate(key), key)
      assert.notEqual(label, key, `Missing ${locale} translation: ${key}`)
      return label
    }
    const settle = async () => { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); await page.waitForTimeout(250) }
    const capture = async (view, labelKey) => {
      await settle()
      const name = view + (locale === 'en' ? '-en' : '')
      const expected = await translate(labelKey)
      assert((await page.locator('body').innerText()).includes(expected), `Missing view: ${expected}`)
      assert.equal(await page.locator('html').getAttribute('lang'), locale, 'Wrong document locale')
      assert.equal(await page.evaluate(() => localStorage.getItem('sub2api_locale')), locale, 'Wrong stored locale')
      assert.deepEqual(await page.evaluate(() => window.__demoErrors), [], 'Vue errors')
      const toolbarHeading = view.startsWith('cost-') ? await page.evaluate(() => {
        const heading = document.querySelector('#cost-toolbar-edge > .cost-brand-block > h1')
        const back = document.querySelector('#cost-toolbar-edge > .cost-back-button')
        return { text: heading.textContent, title: heading.title, right: heading.getBoundingClientRect().right, backLeft: back.getBoundingClientRect().left, overflow: getComputedStyle(heading).overflow, textOverflow: getComputedStyle(heading).textOverflow }
      }) : null
      if (toolbarHeading) {
        assert.equal(toolbarHeading.title, expected, 'Toolbar tooltip does not match full heading')
        assert.equal(toolbarHeading.text, expected, 'Toolbar heading lost accessible text')
        assert(toolbarHeading.right <= toolbarHeading.backLeft, 'Toolbar heading overlaps back button')
        assert.equal(toolbarHeading.overflow, 'hidden', 'Toolbar heading is not contained')
        assert.equal(toolbarHeading.textOverflow, 'ellipsis', 'Toolbar heading is not ellipsized')
      }
      const privacy = await page.evaluate(() => {
        const text = document.body.innerText
        const emailCount = (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).length
        const tokenCount = (text.match(/\b(?:sk-|ghp_)[A-Za-z0-9_-]{24,}\b/g) || []).length
        const secretInputs = [...document.querySelectorAll('input[type=password]')].filter(input => input.value).length
        const hosts = [...new Set((text.match(/https?:\/\/[^\s<>\x60]+/g) || []).map(value => { try { return new URL(value).hostname } catch { return 'unparseable' } }))]
        return { emailCount, tokenCount, secretInputs, hosts }
      })
      assert.equal(privacy.emailCount, 0, 'Email-shaped text in DEMO screenshot')
      assert.equal(privacy.tokenCount, 0, 'Token-shaped text in DEMO screenshot')
      assert.equal(privacy.secretInputs, 0, 'Populated secret input in DEMO screenshot')
      assert(privacy.hosts.every(host => host.endsWith('.invalid') || ['127.0.0.1', 'localhost', 'github.com', 'models.dev'].includes(host)), 'Non-DEMO address requires review')
      const buffer = await page.screenshot({ path: path.join(output, name + '.png'), fullPage: true, animations: 'disabled' })
      const png = PNG.sync.read(buffer)
      let variation = 0
      for (let i = 0; i < png.data.length; i += 16) if (Math.max(...png.data.subarray(i, i + 3)) > 80) variation++
      assert(variation > 1000, `Blank screenshot: ${name}`)
      pages.push({ name, view, locale, expectedLabel: expected, width: png.width, height: png.height, nonblankSamples: variation, privacy, ...(toolbarHeading ? { toolbarHeading } : {}) })
      console.log(`Captured ${name}`)
    }
    for (const [tab, key] of [['overview','liveOverview'],['analysis','usageAnalysis'],['sessions','sessionDetails'],['sources','collectionPricing']]) {
      await page.locator('#monitor-tab-' + tab).click()
      assert.equal(await page.locator('#monitor-tab-' + tab).getAttribute('aria-selected'), 'true', 'Wrong monitor tab')
      await page.locator('#monitor-panel-' + tab).waitFor()
      if (tab === 'analysis') {
        await page.locator('.cache-visual').scrollIntoViewIfNeeded()
        await page.waitForFunction(() => document.querySelector('.cache-raster.ready'))
        for (const canvas of await page.locator('.cache-raster.ready').all()) {
          const png = PNG.sync.read(await canvas.screenshot())
          let colored = 0
          for (let i = 0; i < png.data.length; i += 4) if (Math.max(...png.data.subarray(i, i + 3)) - Math.min(...png.data.subarray(i, i + 3)) > 40) colored++
          assert(colored > 500, 'Blank 3D demo canvas')
          canvasChecks.push({ locale, view: 'monitor-analysis', coloredPixels: colored })
        }
        assert(await page.locator('.reference-prism svg image').count() > 0, 'Missing price material textures')
      }
      await capture('monitor-' + tab, 'usageMonitor.text.' + key)
    }
    await page.locator('#monitor-tab-sessions').click()
    await page.locator('#monitor-session-detail').waitFor()
    assert(await page.locator('.family-table tbody tr').count() === 2, 'Missing synthetic session family')
    await page.locator('.session-identifiers summary').click()
    await capture('monitor-session-family', 'usageMonitor.text.fullIdentifiersSource')
    await page.evaluate(() => window.__demoNavigate('/connect'))
    await page.getByText('DEMO Workspace', { exact: true }).waitFor()
    await capture('connect-saved', 'desktop.connect.sources')
    await page.getByRole('button', { name: await translate('desktop.connect.newConnection'), exact: true }).click()
    await capture('connect-new', 'desktop.connect.name')
    for (const [panel, key] of [['overview','upstreamAssetsLiveCosts'],['upstreams','accountOperations'],['oauth','oauthLiveCosts'],['api','apiAccessCenter'],['unified','unifiedCostSummary'],['finance','costLedger'],['governance','dataSourcesAndHistoryControls']]) {
      // The production view initializes the selected panel from its route query.
      await page.evaluate(() => window.__demoNavigate('/connect'))
      await page.evaluate(value => window.__demoNavigate('/admin/cost-center?desktop=1&panel=' + value), panel)
      await capture('cost-' + panel, 'costCenter.text.' + key)
    }
    unknownIPC.push(...await page.evaluate(() => window.__demoUnknownIPC))
    await context.close()
  }
  const localeCounts = Object.fromEntries(['en', 'zh'].map(locale => [locale, pages.filter(page => page.locale === locale).length]))
  assert.deepEqual(localeCounts, { en: 14, zh: 14 }, 'Incomplete bilingual capture')
  assert.equal(new Set(pages.map(page => page.name)).size, 28, 'Duplicate screenshot name')
  assert.deepEqual(pages.filter(page => page.locale === 'en').map(page => page.view), pages.filter(page => page.locale === 'zh').map(page => page.view), 'Locale view coverage differs')
  assert(canvasChecks.some(check => check.locale === 'en') && canvasChecks.some(check => check.locale === 'zh'), 'Missing locale canvas checks')
  assert.deepEqual(errors, [], 'Browser errors')
  assert.deepEqual(escapes, [], 'Requests escaped the isolated harness')
  assert.deepEqual(unknownIPC, [], 'Unexpected IPC')
  const capturedAt = new Date()
  const manifest = { version, capturedAt: capturedAt.toISOString(), captureDateTaipei: capturedAt.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' }), defaultLocale: 'en', localeCounts, source: 'Current production Vue components; synthetic DEMO only, not production data or visual acceptance', fixtureClock: '2026-10-18T08:00:00Z', viewport: { width: 1600, height: 1080 }, pages, canvasChecks, errors, escapes, unknownIPC }
  await writeFile(path.join(output, 'capture-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(JSON.stringify(manifest, null, 2))
} finally {
  await browser?.close()
  await server.close()
}
