import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 格式化**必须按界面语言**，不得落到操作系统默认 locale —— lint 式源码守卫。
 *
 * ── 背景（2026-09-22 实测，不是推断）─────────────────────────────────────
 * 本机 Windows 用户 locale 是 `zh-TW`，于是：
 *
 * ```
 * new Intl.DateTimeFormat().resolvedOptions().locale            // 'zh-TW'
 * new Date('2026-09-16T18:00:00')
 *   .toLocaleString([], { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' })
 * // '09/16 下午06:00'   ← 英文界面里冒出「下午」
 * ```
 *
 * 决定性证据：`DashboardView.spec.ts` 有一条「英文界面不得出现汉字」的反向断言，
 * 在 `en` 界面下渲染出 `Stats may be stale · 09/16 下午06:00` 而**确定性失败**。
 *
 * ── 落到 OS 默认 locale 的写法有三种（都「看着像没事」）──────────────────
 *   · `f([])`          —— 空数组（**最像「用默认」**，实际是 OS locale）
 *   · `f(undefined, …)` —— 显式 undefined
 *   · `f()`            —— 无参
 * 三者在 `en` 界面下都会渲染中文。界面语言只能由 i18n 的 locale 决定。
 *
 * ── 本仓库的**唯一入口**────────────────────────────────────────────────
 *   · 日期 → `@/utils/format` 的 `formatDate()`（内部
 *     `new Intl.DateTimeFormat(localeOverride ?? getLocale(), options)`）
 *     及其包装 `formatDateOnly` / `formatDateTime` / `formatDateTimeToMinute` / `formatTime`
 *   · 数字（千分位、不用紧凑单位）→ `@/utils/format` 的 `formatNumberLocaleString()`
 *     （内部 `Intl.NumberFormat(getLocale())`，并按 locale 缓存 formatter）
 *   · 其它需要裸 Intl 的场合 → 直接把 `getLocale()` 作为 locale 参数传进去
 * `getLocale()` 读 `i18n.global.locale` —— 即运行时界面语言，且是响应式的。
 *
 * ── 被本守卫抓出来的真实缺陷（已修）─────────────────────────────────────
 * 第一轮（只查日期，15 处 / 9 文件）：
 *   · `src/views/admin/DashboardView.vue`  统计卡陈旧角标 → `09/16 下午06:00`
 *   · `src/views/admin/CostCenterView.vue` **成本面板「最后刷新时间」**（5 处）
 *   · `src/components/account/UpstreamBillingRateCell.vue` 上游账单快照时间
 *   · `src/components/account/OllamaCloudUsageSettings.vue` 快照抓取时间
 *   · `src/components/admin/usage/UsageCleanupDialog.vue` 清理任务时间范围
 *   · 以及 `payment/orderUtils.ts`、`OrderTable.vue`、`UserDashboardStats.vue`、
 *     `AdaptiveOperationsCharts.vue`、`CostProfileInspector.vue`、`upstreamTable.ts`、
 *     `BackupView.vue`、`ProxiesView.vue`、`BatchImageGuideView.vue`
 * 第二轮（扩到整个家族，58 处 / 36 文件）：
 *   · **金额**：4 个支付视图各有一份 `new Intl.NumberFormat(undefined, { style:'currency' })`
 *     —— 货币符号与小数位随 OS 变（`zh-TW` 下 `US$1.00`）
 *   · **成本面板**：`CostCenterView.vue:2250` 价格目录更新时间、`:3342` 整数
 *   · **日志时间**：`AuditLogView.vue`、`OpsSystemLogTable.vue`、`OpsDashboardHeader.vue`
 *   · **数字**：42 处裸 `.toLocaleString()`（`UsageTable.vue` 一个文件 15 处）
 *
 * ── 规则（只查**源码文本**，与 `uiShellContract.spec.ts` / `cliproxyWordingContract.spec.ts` 同款）
 *   R1–R3   `.toLocaleString()` 无参 / `[]` / `undefined`
 *   R4–R7   `.toLocaleDateString()` / `.toLocaleTimeString()` 同上三种写法
 *   R8–R11  `Intl.DateTimeFormat / NumberFormat / Collator / RelativeTimeFormat` 传 `undefined` 或 `[]`
 *   R12–R14 `Intl.DateTimeFormat / NumberFormat / Collator` **无参**
 *           —— **唯一豁免**：紧跟 `.resolvedOptions()`（只为读宿主时区/货币小数位，不渲染任何东西）
 *
 * ── 明确不做的事（诚实声明）──────────────────────────────────────────────
 *   1. 注释与字符串字面量在匹配前被挖空，所以**注释里写 `toLocaleString([])` 不会被误报**。
 *      模板字符串的 `${…}` 表达式**按代码处理**（不挖空）—— 早期版本把它一起挖空，
 *      于是 `\`…${date.toLocaleString()}…\`` 这类写法被静默放过。2026-09-22 用
 *      「屏蔽 vs 不屏蔽」差分实测，这一条「已知限制」实际藏了 **5 处真违规**
 *      （`CostLineChart` ×2 / `ModelContributionChart` / `DataGovernancePanel` /
 *      `UpstreamProbeCell`，其中 4 个在成本中心组件里）。**已修 masker，并补了下面对应的
 *      反向自检** —— 把「已知限制」写进注释不能替代修好它。
 *   2. 本守卫只查源码文本，不替代渲染层断言。日期文案的**渲染层**回归由
 *      `DashboardView.spec.ts` 的反向断言（`en` 界面不得出现汉字）负责。
 *   3. 不检查 `.toLocaleLowerCase()` / `.toLocaleUpperCase()` —— 本仓库调用点为 0；
 *      一旦出现，这里会先补规则再改代码。
 */

const SRC_DIR = 'src'

interface Rule {
  id: string
  why: string
  re: RegExp
}

const OS_LOCALE = '⇒ 落到操作系统默认 locale'
const NO_ARGS = '无参 ⇒ 落到操作系统默认 locale'

const RULES: Rule[] = [
  // ── 日期/时间：落到 OS locale 会直接改变用户看到的字符串
  { id: 'R1', why: NO_ARGS, re: /\.toLocaleString\(\s*\)/g },
  { id: 'R2', why: '空数组 locale ' + OS_LOCALE, re: /\.toLocaleString\(\s*\[\s*\]\s*[,)]/g },
  { id: 'R3', why: 'undefined locale ' + OS_LOCALE, re: /\.toLocaleString\(\s*undefined\s*[,)]/g },
  { id: 'R4', why: NO_ARGS, re: /\.toLocaleDateString\(\s*\)/g },
  { id: 'R5', why: '缺 locale ' + OS_LOCALE, re: /\.toLocaleDateString\(\s*(?:undefined|\[\s*\])\s*[,)]/g },
  { id: 'R6', why: NO_ARGS, re: /\.toLocaleTimeString\(\s*\)/g },
  { id: 'R7', why: '缺 locale ' + OS_LOCALE, re: /\.toLocaleTimeString\(\s*(?:undefined|\[\s*\])\s*[,)]/g },
  // ── Intl 构造器：locale 参数缺失/undefined/[] 同样落到 OS locale
  { id: 'R8', why: 'Intl.DateTimeFormat 缺 locale ' + OS_LOCALE, re: /Intl\.DateTimeFormat\(\s*(?:undefined|\[\s*\])\s*[,)]/g },
  { id: 'R9', why: 'Intl.NumberFormat 缺 locale ' + OS_LOCALE, re: /Intl\.NumberFormat\(\s*(?:undefined|\[\s*\])\s*[,)]/g },
  { id: 'R10', why: 'Intl.Collator 缺 locale ' + OS_LOCALE, re: /Intl\.Collator\(\s*(?:undefined|\[\s*\])\s*[,)]/g },
  { id: 'R11', why: 'Intl.RelativeTimeFormat 缺 locale ' + OS_LOCALE, re: /Intl\.RelativeTimeFormat\(\s*(?:undefined|\[\s*\])\s*[,)]/g },
  // ── 无参构造器：唯一豁免是紧跟 .resolvedOptions()
  { id: 'R12', why: 'Intl.DateTimeFormat ' + NO_ARGS, re: /Intl\.DateTimeFormat\(\s*\)(?!\s*\.resolvedOptions)/g },
  { id: 'R13', why: 'Intl.NumberFormat ' + NO_ARGS, re: /Intl\.NumberFormat\(\s*\)(?!\s*\.resolvedOptions)/g },
  { id: 'R14', why: 'Intl.Collator ' + NO_ARGS, re: /Intl\.Collator\(\s*\)(?!\s*\.resolvedOptions)/g },
]

/**
 * `.resolvedOptions()` 豁免的**登记表**。
 * 这些位置读的是「宿主时区 / 某货币的小数位」，**不渲染任何面向用户的字符串**，
 * 所以按 OS locale 解析反而语义正确（时区就该是宿主时区）。
 * 新增一处豁免必须在**这里登记并说明理由** —— 否则下面的断言会红。
 */
const RESOLVED_OPTIONS_ALLOWLIST = [
  'src/api/client.ts',
  'src/components/admin/usage/UsageCleanupDialog.vue',
  'src/features/cost-center/useCostCenterData.ts',
  'src/views/KeyUsageView.vue',
  'src/views/admin/GroupsView.vue',
  'src/views/admin/affiliates/AdminAffiliateRecordsTable.vue',
]

const RESOLVED_OPTIONS_RE = /Intl\.(?:DateTimeFormat|NumberFormat|Collator)\(\s*\)\s*\.resolvedOptions/g

interface Offender {
  file: string
  line: number
  rule: string
  why: string
  snippet: string
}

/**
 * 把注释（`//` / `/* *​/` / `<!-- -->`）与字符串字面量（' " `）挖成空格。
 * **保留换行**，所以行号与原文一一对应。
 */
export function maskCommentsAndStrings(text: string): string {
  const out = text.split('')
  const blank = (from: number, to: number) => {
    for (let i = Math.max(0, from); i < to && i < out.length; i += 1) {
      if (out[i] !== '\n' && out[i] !== '\r') out[i] = ' '
    }
  }

  /**
   * 按「代码」扫描，沿途挖空注释与字符串的**字面量文本**。
   * `stopAtBrace` 为真时扫到深度归零的 `}` 即返回其下标（用于模板字符串的 `${…}`）。
   *
   * ⚠️ `depth` 初值必须由调用方给对：`${…}` 的内容从 `{` 之后开始，所以初始深度是 **1**。
   * 早期版本传 0，于是 `${ {a:1} }` / `${f({a:1})}` 这类**嵌套花括号**会在内层 `}` 就提前
   * 返回，masker 随即失去同步 —— 后面的代码被当文本吞掉（假绿），注释里的写法反而被当代码
   * （假红）。实测这一个初值错让 6 个 `.resolvedOptions()` 豁免点里 5 个「消失」。
   */
  function scanCode(from: number, stopAtBrace: boolean, depth: number): number {
    let i = from
    while (i < text.length) {
      const c = text[i]
      const n = text[i + 1]
      if (c === '/' && n === '/') {
        let j = i
        while (j < text.length && text[j] !== '\n') j += 1
        blank(i, j)
        i = j
        continue
      }
      if (c === '/' && n === '*') {
        const end = text.indexOf('*/', i + 2)
        const j = end === -1 ? text.length : end + 2
        blank(i, j)
        i = j
        continue
      }
      if (c === '<' && text.startsWith('<!--', i)) {
        const end = text.indexOf('-->', i + 4)
        const j = end === -1 ? text.length : end + 3
        blank(i, j)
        i = j
        continue
      }
      if (c === "'" || c === '"' || c === '`') {
        i = scanString(i)
        continue
      }
      if (stopAtBrace) {
        if (c === '{') depth += 1
        else if (c === '}') {
          depth -= 1
          if (depth === 0) return i
        }
      }
      i += 1
    }
    return -1
  }

  /**
   * 从 `from`（指向引号）扫过整个字面量，返回引号之后的下标。
   *
   * **模板字符串的 `${…}` 表达式保持原样** —— 那是代码，不是文本。
   * 早期版本把它一并挖空，于是 `\`…${date.toLocaleString()}…\`` 这类写法
   * 被静默放过：2026-09-22 用「屏蔽 vs 不屏蔽」差分实测，漏掉了 **5 处真违规**
   * （`CostLineChart` / `ModelContributionChart` / `DataGovernancePanel` /
   * `UpstreamProbeCell`）。把「已知限制」写进注释并不能替代修好它。
   */
  function scanString(from: number): number {
    const quote = text[from]
    let i = from + 1
    while (i < text.length) {
      const c = text[i]
      if (c === '\\') {
        blank(i, i + 2)
        i += 2
        continue
      }
      if (c === quote) {
        blank(i, i + 1)
        return i + 1
      }
      if (quote === '`' && c === '$' && text[i + 1] === '{') {
        blank(i, i + 2)
        const close = scanCode(i + 2, true, 1)
        if (close < 0) return text.length
        blank(close, close + 1)
        i = close + 1
        continue
      }
      if (c !== '\n' && c !== '\r') out[i] = ' '
      i += 1
    }
    return i
  }

  scanCode(0, false, 0)
  return out.join('')
}

function lineOf(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1
  }
  return line
}

function scanSource(relativePath: string, raw: string): Offender[] {
  const masked = maskCommentsAndStrings(raw)
  const offenders: Offender[] = []
  for (const rule of RULES) {
    rule.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = rule.re.exec(masked)) !== null) {
      const line = lineOf(masked, m.index)
      offenders.push({
        file: relativePath,
        line,
        rule: rule.id,
        why: rule.why,
        snippet: raw.split(/\r?\n/)[line - 1]?.trim() ?? '',
      })
      if (m.index === rule.re.lastIndex) rule.re.lastIndex += 1
    }
  }
  return offenders
}

function isTestPath(rel: string): boolean {
  // rel 用 '/' 拼接（见 collectFiles），这里同时容忍 Windows 的 '\\'
  if (/[\\/]__tests__[\\/]/.test(rel)) return true
  return /\.(spec|test)\.[cm]?[jt]sx?$/.test(rel)
}

function collectFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(resolve(process.cwd(), dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      collectFiles(rel, acc)
    } else if (/\.(ts|vue)$/.test(entry.name) && !isTestPath(rel)) {
      acc.push(rel)
    }
  }
  return acc
}

function scanRepo(): { files: string[]; offenders: Offender[] } {
  const files = collectFiles(SRC_DIR)
  const offenders: Offender[] = []
  for (const file of files) {
    const raw = readFileSync(resolve(process.cwd(), file), 'utf8')
    offenders.push(...scanSource(file, raw))
  }
  return { files, offenders }
}

function report(offenders: Offender[]): string[] {
  return offenders.map(
    (o) => `  - ${o.file}:${o.line} [${o.rule} ${o.why}]\n      ${o.snippet}`
  )
}

/** 拿一个真实文件做底注入代码，返回扫描结果 —— 不靠自造字符串。 */
function scanWithInjection(file: string, code: string): Offender[] {
  const raw = readFileSync(resolve(process.cwd(), file), 'utf8')
  return scanSource(file, `${raw}\n${code}\n`)
}

describe('格式化 locale 契约（禁止落到 OS 默认 locale）', () => {
  it('扫描面必须非空（否则守卫等于没跑）', () => {
    const { files } = scanRepo()
    // 实测 ~800 个非测试 .ts/.vue；给一个宽松但能排除「目录写错 / 递归断掉」的下限。
    expect(files.length).toBeGreaterThan(300)
  })

  it('源码里不得出现任何 OS-locale 写法（R1–R14）', () => {
    const { offenders } = scanRepo()
    expect(report(offenders).join('\n')).toBe('')
  })

  it('反向自检：14 条规则逐条注入，必须全部命中（不靠自造字符串）', () => {
    const file = 'src/views/admin/DashboardView.vue'
    const injections: { rule: string; code: string }[] = [
      { rule: 'R1', code: 'const x = (count).toLocaleString()' },
      { rule: 'R2', code: 'const x = d.toLocaleString([], { hour: "2-digit" })' },
      { rule: 'R3', code: 'const x = d.toLocaleString(undefined, { hour: "2-digit" })' },
      { rule: 'R4', code: 'const x = d.toLocaleDateString()' },
      { rule: 'R5', code: 'const x = d.toLocaleDateString(undefined, { year: "numeric" })' },
      { rule: 'R6', code: 'const x = d.toLocaleTimeString()' },
      { rule: 'R7', code: 'const x = d.toLocaleTimeString([], { hour: "2-digit" })' },
      { rule: 'R8', code: 'const f = new Intl.DateTimeFormat(undefined, { year: "numeric" })' },
      { rule: 'R9', code: 'const f = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" })' },
      { rule: 'R10', code: 'const c = new Intl.Collator(undefined, { numeric: true })' },
      { rule: 'R11', code: 'const r = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })' },
      { rule: 'R12', code: 'const f = new Intl.DateTimeFormat()' },
      { rule: 'R13', code: 'const f = new Intl.NumberFormat()' },
      { rule: 'R14', code: 'const c = new Intl.Collator()' },
    ]

    for (const { rule, code } of injections) {
      const hits = scanWithInjection(file, code).filter((o) => o.rule === rule)
      expect(hits.length, `注入 ${rule} 后应被命中：${code}`).toBeGreaterThan(0)
    }
  })

  it('反向自检：模板字符串 ${…} 里的违规必须被命中（这条盲区曾漏掉 5 处真违规）', () => {
    const file = 'src/features/cost-center/components/CostLineChart.vue'
    const injections = [
      'const s = `x ${d.toLocaleString()} y`',
      'const s = `x ${value.toLocaleString(undefined, { maximumFractionDigits: 4 })} y`',
      'const s = `x ${n.toLocaleString([])} y`',
      'const s = `x ${new Date(v).toLocaleDateString()} y`',
      'const s = `outer ${`inner ${d.toLocaleTimeString()}`} y`',
      'const s = `x ${new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" })} y`',
    ]
    for (const code of injections) {
      const hits = scanWithInjection(file, code)
      expect(hits.length, `模板字符串 ${'${…}'} 内的违规应被命中：${code}`).toBeGreaterThan(0)
    }
  })

  it('反向自检：模板字符串的**纯文本**部分不得被误报（只有 ${…} 里才是代码）', () => {
    const file = 'src/features/cost-center/components/CostLineChart.vue'
    const raw = readFileSync(resolve(process.cwd(), file), 'utf8')
    const baseline = scanSource(file, raw)
    const benign = [
      'const s = `纯文本 toLocaleString() 不是代码`',
      'const s2 = `new Intl.NumberFormat(undefined, {}) 只是文案`',
      'const s3 = `d.toLocaleDateString() 也只是文案`',
      'const s4 = `Intl.DateTimeFormat() 同理`',
    ]
    for (const line of benign) {
      expect(scanSource(file, `${raw}\n${line}\n`), `不应命中：${line}`).toEqual(baseline)
    }
  })

  it('反向自检：masker 遇到嵌套花括号的 ${…} 不得跑偏（曾把后面整段代码吞掉 ⇒ 假绿）', () => {
    const file = 'src/features/cost-center/components/CostLineChart.vue'
    // 每段都在模板字符串**之后**再放一处真违规：masker 一旦失去同步，尾部代码会被当文本吞掉。
    const cases = [
      'const a = `x${JSON.stringify({ k: 1 })}y`; const b = d.toLocaleString()',
      'const a = `x${f({ k: { n: 1 } })}y`; const b = d.toLocaleString()',
      'const a = `x${cond ? { a: 1 } : { b: 2 }}y`; const b = d.toLocaleString()',
      'const a = `x${[1, 2].map((v) => ({ v })).length}y`; const b = d.toLocaleString()',
      'const a = `x${`y${JSON.stringify({ k: 1 })}z`}w`; const b = d.toLocaleString()',
    ]
    for (const code of cases) {
      const hits = scanWithInjection(file, code)
      expect(
        hits.some((o) => o.rule === 'R1'),
        `模板字符串之后的代码不得被 masker 吞掉：${code}`
      ).toBe(true)
    }
  })

  it('反向自检：注释与字符串里的同款文本**不得**被误报（否则守卫会把修复注释当成违规）', () => {
    const file = 'src/views/admin/DashboardView.vue'
    const raw = readFileSync(resolve(process.cwd(), file), 'utf8')
    const baseline = scanSource(file, raw)

    const benign = [
      '// 不要写 toLocaleString([]) / toLocaleString(undefined, …) / date.toLocaleString()',
      '/* new Date(ts).toLocaleString() 也是 OS locale */',
      '<!-- date.toLocaleString() 说明 -->',
      'const tip = "toLocaleString(undefined, { hour: \'2-digit\' })"',
      'const tip2 = `Intl.DateTimeFormat() 与 new Intl.NumberFormat() 都落到 OS locale`',
    ]
    for (const line of benign) {
      expect(scanSource(file, `${raw}\n${line}\n`), `不应命中：${line}`).toEqual(baseline)
    }
  })

  it('反向自检：**正解**写法不得被误报（否则守卫会逼着人写错）', () => {
    const file = 'src/views/admin/DashboardView.vue'
    const raw = readFileSync(resolve(process.cwd(), file), 'utf8')
    const baseline = scanSource(file, raw)

    const legit = [
      'const tz = Intl.DateTimeFormat().resolvedOptions().timeZone',
      'const digits = new Intl.NumberFormat(getLocale(), { style: "currency", currency }).resolvedOptions().maximumFractionDigits',
      'const f = new Intl.DateTimeFormat(getLocale(), { year: "numeric" })',
      'const n = formatNumberLocaleString(value)',
      'const s = formatDate(date, { month: "2-digit" })',
      'const d = new Date(ts).toLocaleString(getLocale())',
      'const d2 = new Date(ts).toLocaleDateString(getLocale(), { year: "numeric" })',
      'const c = new Intl.Collator(getLocale(), { numeric: true })',
    ]
    for (const line of legit) {
      expect(scanSource(file, `${raw}\n${line}\n`), `不应命中正解：${line}`).toEqual(baseline)
    }
  })

  it('.resolvedOptions() 豁免必须在登记表内（新增豁免要显式登记，不能悄悄开个口子）', () => {
    const found: string[] = []
    for (const file of collectFiles(SRC_DIR)) {
      const masked = maskCommentsAndStrings(readFileSync(resolve(process.cwd(), file), 'utf8'))
      RESOLVED_OPTIONS_RE.lastIndex = 0
      if (RESOLVED_OPTIONS_RE.test(masked)) found.push(file)
    }
    expect(found.sort()).toEqual([...RESOLVED_OPTIONS_ALLOWLIST].sort())
  })

  it('已修的关键文件必须走 @/utils/format 的入口（不能只是把参数删了）', () => {
    const dateEntry = [
      'src/views/admin/DashboardView.vue',
      'src/components/account/UpstreamBillingRateCell.vue',
      'src/components/account/OllamaCloudUsageSettings.vue',
      'src/components/admin/usage/UsageCleanupDialog.vue',
    ]
    for (const file of dateEntry) {
      const raw = readFileSync(resolve(process.cwd(), file), 'utf8')
      expect(raw, `${file} 应从 @/utils/format 取 formatDate`).toMatch(
        /import\s*\{[^}]*formatDate[^}]*\}\s*from\s*'@\/utils\/format'/
      )
    }

    const numberEntry = [
      'src/components/admin/usage/UsageTable.vue',
      'src/components/admin/usage/UsageStatsCards.vue',
      'src/components/common/StatCard.vue',
      'src/views/admin/CostCenterView.vue',
      'src/views/cockpit/CockpitDataView.vue',
    ]
    for (const file of numberEntry) {
      const raw = readFileSync(resolve(process.cwd(), file), 'utf8')
      expect(raw, `${file} 应从 @/utils/format 取 formatNumberLocaleString`).toMatch(
        /import\s*\{[^}]*formatNumberLocaleString[^}]*\}\s*from\s*'@\/utils\/format'/
      )
    }

    const localeEntry = [
      'src/components/admin/payment/OrderStatsCards.vue',
      'src/components/admin/payment/PaymentMethodChart.vue',
      'src/components/admin/payment/TopUsersLeaderboard.vue',
      'src/views/admin/orders/AdminPaymentDashboardView.vue',
      'src/components/common/DataTable.vue',
      'src/components/payment/currency.ts',
    ]
    for (const file of localeEntry) {
      const raw = readFileSync(resolve(process.cwd(), file), 'utf8')
      expect(raw, `${file} 应从 @/i18n 取 getLocale`).toMatch(
        /import\s*\{[^}]*getLocale[^}]*\}\s*from\s*'@\/i18n'/
      )
    }
  })

  it('formatNumberLocaleString 必须自己走 app locale（它是 42 处调用点的唯一入口）', () => {
    const raw = readFileSync(resolve(process.cwd(), 'src/utils/format.ts'), 'utf8')
    // 不能再是 `num.toLocaleString()` —— 那正是本轮修掉的 bug 本体
    expect(raw).not.toMatch(/num\.toLocaleString\(/)
    expect(raw).toMatch(/new Intl\.NumberFormat\(locale\)/)
    expect(raw).toMatch(/getNumberFormatter\(getLocale\(\)\)/)
  })

  it('生产代码里 getLocale() 的宿主是 i18n 全局实例（保证守卫说的「界面语言」不是空话）', () => {
    const raw = readFileSync(resolve(process.cwd(), 'src/utils/format.ts'), 'utf8')
    expect(raw).toMatch(/import\s*\{[^}]*getLocale[^}]*\}\s*from\s*'@\/i18n'/)
    expect(raw).toMatch(/localeOverride\s*\?\?\s*getLocale\(\)/)
  })
})
