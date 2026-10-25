import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 三源口径的**措辞契约**守卫(2026-09-16 收口轮 / 同日加固轮 / 同日加固第二轮)。
 *
 * 背景:CostCenterView.vue 里反复出现
 *   `connectionType === null ? '〈cockpit 措辞〉' : '〈sub2api 措辞〉'`
 * 这类**两分支**写法 —— 把「非 cockpit」一律当成 sub2api,**完全无视 cliproxy 是第三个源**。
 * 而 cliproxy(CPA `usage_events` × LiteLLM 单价估算)既没有营收层,也没有渠道价 / 账号费率,
 * 也不读 `usage_logs`;任何在 cliproxy 下可达、却写着这些词的文案都是撒谎。
 * cockpit(本机 `~/.antigravity_cockpit` 单请求用量库自算成本)同样没有营收层。
 *
 * 该缺陷已连续三轮复发(每次都是「改了主处、漏了孪生」),所以这里用 lint 式源码断言把它永久钉住。
 *
 * ── 加固轮(2026-09-16 第二轮)修掉的五个可绕开变体 ──────────────────────────────
 *   W1 `connectionType !== 'cliproxy' ? '产出' : '估算成本'`   —— 旧规则只认 `=== null ?`
 *   W2 新增 `const isCliproxy = computed(...)` + `isCliproxy.value ? '估算成本' : '产出'`
 *      —— 旧白名单只要求"块内出现字符串 cliproxy",一个单源谓词就自动免检
 *   W3 `{{ '产' + '出' }}`                                      —— 旧规则按子串匹配,拼接后不含「产出」
 *   W4 `connectionType === 'cliproxy' ? '估算成本' : '产出'`     —— 出现 cliproxy 子串即免检
 *   W5 `connectionType ? '估算成本' : '自算成本'`                —— 槽内无词表命中,旧规则不触发
 *
 * 对应五条加固:
 *   1. 「是否含字符串 cliproxy」→ **结构判定**:要求表达式在语法上出现 `(===|!==) 'cliproxy'`。
 *   2. 收紧 computed 白名单:块内必须出现**对 cliproxy 的比较**,且必须**同时点名另一个源**
 *      (`'sub2api'` 或 `null`)—— 只写一个源的谓词不算(否则 W2 免检)。白名单按引用关系**传递闭包**。
 *   3. 词表匹配前先**归一化相邻字符串字面量相加**(覆盖 W3)。
 *   4. 新增**三态穷举规则**:凡绑定表达式提到 connectionType/sourceKind 或带词表命中,
 *      必须同时出现 cliproxy 比较与(另一源比较 / null 比较);禁止 `A ? x : y` 形态。
 *      这条一次覆盖 W1 / W4 / W5,W2 由收紧后的白名单覆盖。
 *   5. 扫描范围从单文件扩到 `src/features/cost-center/components/*.vue` —— 这正是本轮漏掉
 *      `AdaptiveOperationsCharts.vue`(对 cockpit 与 cliproxy 两源都把成本标成「用户计费」)的直接原因。
 *
 * ── 收口轮(2026-09-16 第三轮) ──────────────────────────────────────────────
 *   扩范围后被命中的 `CostProfileInspector.vue` 已按源分支(按量流程条 / 账号费率格 /
 *   固定附加成本说明 / meteredPriceSource / meteredExplanation),上一轮为它留的三条
 *   「已确认缺陷 · 超出允许改动范围」豁免随之全部删除;并新增一条断言禁止该文件再出现豁免。
 *
 * ── 加固第二轮(2026-09-16 第四轮,本次) ────────────────────────────────────
 * 复核实测:12 个新变体里 **7 个能绕过守卫**。逐个补上:
 *   W6  `withDefaults(defineProps<...>(), { sourceKind: 'sub2api' })` / `sourceKind?:`
 *       —— 缺省值让「没传就静默走 sub2api」,是唯一会**静默走错源**的缺口 ⇒ 新增规则 F。
 *   W7  `hasRev = computed(() => base.value !== 'z')` + 引用 `hasRev` 的槽位免检
 *       —— 传递闭包只看「引用」不看「谓词形状」⇒ 加固 2b:对白名单成员做布尔降维
 *       (`!x` / `x === y` / `x !== y`)的块与槽位都不再算「说清来源」。
 *   W8  静态 `aria-label="用户计费"`   —— 静态属性白名单只有 label|note|title|caption
 *   W9  静态 `data-tip="渠道价"`       —— 同上 ⇒ 加固 3b:静态属性扫描扩到**全部**静态属性。
 *   W10 文本节点 `usage&#95;logs`      —— 词表匹配前不做 HTML 实体解码 ⇒ 加固 3c。
 *   W11 `{{ 'usage' }}{{ '_logs' }}`   —— 相邻插值拼接后不含词表词 ⇒ 加固 3d。
 *   W12 措辞写进 `modelCostAnalysis.ts` / `financialTrend.ts` / 两个 adapter 等 `.ts`
 *       —— 扫描范围只有 `.vue` ⇒ 加固 5b:扩到 `src/features/cost-center/**\/*.ts`
 *       (排除 `__tests__/`、`*.spec.ts`、`*.test.ts`),并把 `loadFile` 的脚本区起点
 *       对 `.ts` 修正为「整份文件」(旧实现取不到 `<script>` 会退化成只切最后一行)。
 *   另外把 `毛利` / `贡献毛利` / `回本` 加入源措辞词表 —— 上一轮把 `回本率` 的假零
 *   (`0.0%`)修掉时正是被这三词漏掉的两条 note 放过去的。
 *
 * 八条规则都是**结构不变量**(不含文案快照),允许三种合法的「已区分三源」写法:
 *   1. 槽位里直接内联 `connectionType === null ? … : connectionType === 'cliproxy' ? … : …`;
 *   2. 槽位引用一个**自身三态穷举**的 computed(见 sourceAwareComputed);
 *   3. 无词表命中、只做 `=== 'sub2api'` 门控的槽位(其余源落到不表态的兜底,如 `'—'`)。
 *
 * 说明:本文件只查**源码文本**(与 uiShellContract.spec.ts 同款做法),不替代渲染层测试;
 * 回本率 / 毛利的**渲染层**红线另有 `revenueLayerNullContract.spec.ts`。
 */

const VIEW_PATH = 'src/views/admin/CostCenterView.vue'
const COMPONENT_DIR = 'src/features/cost-center/components'
const FEATURE_DIR = 'src/features/cost-center'
/**
 * 成本中心的**第二个宿主视图**(2026-09-22 纳入)。
 * 它复用 `components/CostLineChart.vue` 等成本中心组件,自己也在渲染成本口径措辞
 * (`自算成本(非实测)` / `自算成本不可得`,见该文件 224/225/238)。此前不在扫描面内 ——
 * 扫描范围按目录不按文件是既有教训(只扫 `CostCenterView.vue` 曾漏掉 `components/*.vue`),
 * 这个视图是同一教训的第二处漏网。
 */
const COCKPIT_VIEW_PATH = 'src/views/cockpit/CockpitDataView.vue'

/** cliproxy / cockpit 下必然是假话的措辞。 */
const SOURCE_BOUND_TERMS = ['产出', '用户计费', '收入', '营收', '渠道价', '账号费率', 'usage_logs', '毛利', '贡献毛利', '回本']

/** 成本口径措辞:本身不撒谎,但一旦出现在**两分支**槽位里,就说明有一个源的兜底分支
 *  被静默套上了别源的口径 —— W5(`connectionType ? '估算成本' : '自算成本'`)正是这种写法,
 *  它槽内没有任何 SOURCE_BOUND_TERMS 命中,只靠词表抓不到。 */
const SOURCE_CALIBER_TERMS = ['自算成本', '估算成本']

/**
 * ★ 语言覆盖(2026-09-22):`SOURCE_BOUND_TERMS` 的**英文对照词**,尚未启用。
 *
 * 它现在**不能**直接并进 `SOURCE_BOUND_TERMS`:`hits()` 用的是**纯子串**匹配,
 * 而英文源码里 `modelCostSummary.revenue` / `revenueMissing` / `stats.totals.outputTokens`
 * 都会命中 `revenue` / `output`。实测在成本中心面跑一遍英文词表得到 **50 处命中,
 * 其中 0 处是用户可见的源措辞 —— 全是标识符**。直接并进去会把守卫从「假绿」翻成「假红」,
 * 而假红的下场通常是被注释掉,最终同样失去守卫。
 *
 * 启用顺序(不可颠倒):先给 `hits()` 换**词边界**匹配 → 再把本表并进 `SOURCE_BOUND_TERMS`。
 * 见文件末尾的「语言覆盖 tripwire」。
 */
const SOURCE_BOUND_TERMS_EN = [
  'revenue', 'user billing', 'channel price', 'account rate',
  'gross margin', 'contribution margin', 'payback',
]

/**
 * 成本中心面**是否已经开始 i18n 化**的判据:文件把文案交给 `t()` / `$t()` / `useI18n` 渲染。
 *
 * 只认「`t(` 后面紧跟字符串字面量」这一种形态,`\b` 让 `formatTokens(` / `mount(` / `output(`
 * 这类以 `t(` 结尾的**标识符调用**天然不命中 —— 这条正是 tripwire 自检里要钉住的负向对照。
 * 已知代价:注释里写 `t('…')` 会误命中;方向是**假红**(fail-loud),不是漏报。
 */
const I18N_RENDER_PATTERN = /\buseI18n\s*\(|\$t\s*\(|\bt\s*\(\s*['"`]/

type Rule = 'A' | 'B' | 'B2' | 'B3' | 'C' | 'D' | 'E' | 'F'

interface Exemption {
  /** 相对仓库根的路径 */
  file: string
  /** 命中文本必须包含的片段(用片段而非行号,行号漂移后仍有效) */
  snippet: string
  /** 为什么合规。**必须写清**;不允许"懒得改"式豁免。 */
  reason: string
  /** 只豁免哪几条规则;缺省 = 全部 */
  rules?: Rule[]
}

/** 逐条人工判定后的显式豁免。 */
const EXEMPTIONS: Exemption[] = [
  {
    file: VIEW_PATH,
    snippet: '已从真实 usage_logs 按',
    rules: ['C'],
    reason: 'sub2api 专属:modelStatsExactWindowFallback 只在 sub2api 装载器里可能置真(cockpit / cliproxy 的装载器都显式置 false),cliproxy 下不可达。',
  },
  {
    file: VIEW_PATH,
    snippet: '所选窗口超过 25,000 条 usage_logs',
    rules: ['C'],
    reason: 'sub2api 专属:25,000 条读取上限只存在于 usage_logs 兼容聚合。',
  },
  {
    file: VIEW_PATH,
    snippet: '不产出任何',
    rules: ['C'],
    reason: '「不产出任何"总额"」里的「产出」是动词,不是数据源断言。',
  },
  {
    file: VIEW_PATH,
    snippet: '无有效收入',
    rules: ['B3', 'E'],
    reason: '该分支只在 `modelCostSummary.revenueMissing === false` 时才可达(同槽位首层判据),而 revenueMissing 为真当且仅当数据源不提供 actual_cost(modelCostAnalysis.ts:192,注释明确 cockpit 恒为真)⇒ cockpit / cliproxy 下整格渲染「—」,不会出现「收入」字样。',
  },
  {
    file: `${COMPONENT_DIR}/ModelContributionChart.vue`,
    snippet: "label: '用户收入'",
    rules: ['B', 'D'],
    reason: '该序列只在 `revenueMissing === false` 时才进入 datasets(同文件 chartData);cockpit / cliproxy 下每行 revenueMissing 为真 ⇒ 整根柱子不画,不会声称零收入。',
  },
  {
    file: VIEW_PATH,
    snippet: 'label="毛利（窗口）"',
    rules: ['B'],
    reason: '「毛利（窗口）」是**中性指标名**,不是口径断言:该格的 :value 与 :note 都已按源三态穷举 —— 非 sub2api 时 :value 渲染「—」、:note 写「本机/CPA 无营收口径 · 毛利不可计算」,且 :accent 不再给 lime。静态标签本身在任何源下都不对外声称"这里有一个可算的毛利"。',
  },
  {
    file: VIEW_PATH,
    snippet: 'label="毛利 / 毛利率"',
    rules: ['B'],
    reason: '同上:中性指标名。该格的 :value 首层判据是 `modelCostSummary.revenueMissing`(cockpit / cliproxy 恒为真 ⇒ 渲染「—」),:note 走 `${revenueMissingNote} · 毛利不可计算`,两者都已按源表态。',
  },
  {
    file: VIEW_PATH,
    snippet: 'label="回本率"',
    rules: ['B'],
    reason: '「回本率」是**中性指标名**,不是口径断言:该格 :value 的首层判据是 `paybackRatio == null`,而 paybackRatio 以 windowGrossMarginCny 为输入 —— 后者对非 sub2api 短路返回 null ⇒ 两源下整格渲染「无数据」;:note 也已三态穷举为「需营收口径 · 本机/CPA 无营收层，回本率不可计算」。',
  },
  {
    file: VIEW_PATH,
    snippet: 'label="预计回本"',
    rules: ['B'],
    reason: '同上:中性指标名。:value 首层判据是 `estimatedPaybackHours == null`(同样以 windowGrossMarginCny 为输入,两源下恒 null ⇒ 渲染「无数据」),:note 三态穷举为「需营收口径 · …」。',
  },
  {
    file: VIEW_PATH,
    snippet: "estimatedPaybackHours <= 0 ? '已回本'",
    rules: ['B3'],
    reason: '命中的词是**数据状态**「已回本」(回本周期已归零),不是口径断言。该分支只在 `estimatedPaybackHours <= 0` 时可达,而 estimatedPaybackHours 的输入 windowGrossMarginCny 对非 sub2api 恒返回 null ⇒ 这个分支在两源下**不可达**(整格渲染「无数据」)。',
  },
  {
    file: `${FEATURE_DIR}/financialTrend.ts`,
    snippet: "source: 'ops' | 'usage_logs'",
    rules: ['D'],
    reason: '这是**类型判别字段**的联合类型声明(`FinancialTrendPoint.source`):标注该点取自哪条趋势序列(ops 桶 vs usage_logs 兼容聚合),不是对外文案,更不对任何源声称营收 / 渠道价 / 账号费率。',
  },
  {
    file: `${FEATURE_DIR}/financialTrend.ts`,
    snippet: "source: 'usage_logs' as const",
    rules: ['D'],
    reason: '同上:给判别字段赋 `\'usage_logs\'` 字面量。该分支只在调用方传入 usage 序列(useOps 为假)时执行,描述的是**趋势来源**而非连接类型;cliproxy / cockpit 的趋势同样可以走这条路径,文案不对外渲染。',
  },
  {
    file: `${COMPONENT_DIR}/ModelContributionChart.vue`,
    snippet: "label: '毛利'",
    rules: ['B', 'D'],
    reason: '与同文件的「用户收入」共用一个门控:两者都在 `...(revenueMissing.value ? [] : [ … ])` 展开里,revenueMissing 为真(cockpit / cliproxy 下每行 revenueMissing 恒为真)⇒ 该 dataset 根本不进 datasets,legend 里不会出现「毛利」,更不会画出 0 柱或负柱。',
  },
  {
    file: `${FEATURE_DIR}/useCostCenterData.ts`,
    snippet: "'usage_logs 聚合已读取'",
    rules: ['D'],
    reason: 'sub2api 专属:该块是 `async function reload()`(useCostCenterData.ts:589),入口第一句就是 `applySourceKey(\'sub2api\')`,取数全部走 `adminAPI.dashboard.*`(sub2api 管理端点);cliproxy 走 `loadFromCliproxy()`、cockpit 走 `loadFromCockpit()`,两者都不经过本函数。文案只是该源自身的取数状态。',
  },
  {
    file: `${FEATURE_DIR}/useUnifiedCost.ts`,
    snippet: "'官方内核无 economics 端点,已回退 usage_logs 窗口聚合(actual_cost)'",
    rules: ['D'],
    reason: 'sub2api 专属:该块是 `const sub2apiStatus = computed(...)`,产出的是**按源分项**记录里 `sub2api` 那一项(同文件 `sourceStatuses`),消费点 CostCenterView.vue:706 是 `unified.sourceStatuses.value[key].reason` —— 只有 key === \'sub2api\' 的那一行会渲染它;cockpit / cliproxy 各自有独立的 status computed 与措辞。',
  },
]

/** HTML 命名实体里与本次词表相关的少数几个;数字实体走通用解码。 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  lowbar: '_', underscore: '_', hyphen: '-', period: '.', sol: '/',
  colon: ':', comma: ',', lpar: '(', rpar: ')', num: '#', percnt: '%',
}

/** 加固 3c:HTML 实体解码 —— `usage&#95;logs` / `usage&#x5F;logs` / `usage&lowbar;logs`
 *  在浏览器里都会渲染成 `usage_logs`,不做解码就等于放它过关。 */
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (match, hex: string) => {
      const code = Number.parseInt(hex, 16)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    })
    .replace(/&#(\d+);/g, (match, dec: string) => {
      const code = Number.parseInt(dec, 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    })
    .replace(/&([a-z][a-z0-9]*);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
}

/** 加固 3d:相邻插值拼接 —— `{{ 'usage' }}{{ '_logs' }}` 在浏览器里连成 `usage_logs`,
 *  归一化成 `{{ 'usage' + '_logs' }}` 后由 normalizeStringLiterals 合并。 */
function joinAdjacentInterpolations(text: string): string {
  return text.replace(/\}\}\s*\{\{/g, '+')
}

/** 归一化相邻字符串字面量相加(`'产' + '出'` → `'产出'`),否则拼接写法可绕过子串匹配。 */
function normalizeStringLiterals(text: string): string {
  let out = text
  for (let pass = 0; pass < 8; pass += 1) {
    const next = out.replace(/'([^'\n]*)'\s*\+\s*'([^'\n]*)'/g, "'$1$2'")
    if (next === out) break
    out = next
  }
  return out
}

/** 词表匹配前统一走这条:实体解码 → 相邻插值拼接 → 相邻字面量相加。 */
function normalize(text: string): string {
  return normalizeStringLiterals(joinAdjacentInterpolations(decodeHtmlEntities(text)))
}

function hits(text: string): string[] {
  const normalized = normalize(text)
  return SOURCE_BOUND_TERMS.filter((term) => normalized.includes(term))
}

/** 返回**已经开始 i18n 渲染**的文件路径(其余文件仍是中文硬编码)。 */
function filesRenderingThroughI18n(files: { path: string; text: string }[]): string[] {
  return files.filter((file) => I18N_RENDER_PATTERN.test(file.text)).map((file) => file.path)
}

const CLIPROXY_COMPARISON = /(===|!==)\s*'cliproxy'/
const SUB2API_COMPARISON = /(===|!==)\s*'sub2api'/
const NULL_COMPARISON = /(===|!==)\s*null/

/**
 * 结构判定(加固 1 + 4):该表达式是否**三态穷举** —— 既在语法上出现 cliproxy 分支,
 * 又点名了另一个源(`'sub2api'` 或 `null`)。
 * `connectionType !== 'cliproxy' ? '产出' : '估算成本'` 与 `connectionType === 'cliproxy' ? … : …`
 * 都只点名一个源 ⇒ 兜底分支把 cockpit 静默当成 sub2api ⇒ 不算穷举。
 */
function isSourceExhaustive(text: string): boolean {
  return CLIPROXY_COMPARISON.test(text) && (SUB2API_COMPARISON.test(text) || NULL_COMPARISON.test(text))
}

/**
 * 加固 2b:对白名单成员做**布尔降维**。
 *
 * `const hasRev = computed(() => base.value !== 'z')` 把 base 的三值结果压成一个恒真的布尔,
 * 引用 `hasRev` 的槽位就重新获得「非 sub2api 一律套别源口径」的自由 —— 而旧闭包只看「引用」,
 * 于是这种写法自动免检(W7)。
 * 三种降维形态都算:`!x` / `x === y` / `x !== y`(含 `x.value !== 'z'` 这类带属性路径的写法)。
 * 纯传递(`const b = computed(() => a.value)`)不算降维,仍可进白名单。
 */
function reducesBoolean(text: string, name: string): boolean {
  const ref = `\\b${name}\\b(?:\\s*\\.\\s*\\w+)*`
  return new RegExp(`!\\s*${ref}`).test(text)
    || new RegExp(`${ref}\\s*(===|!==)`).test(text)
    || new RegExp(`(===|!==)\\s*${ref}`).test(text)
}

interface Block {
  /** 该顶层声明在**原文件**里的行号(1 起) */
  line: number
  body: string[]
}

/** 顶层声明(`^\S` 起头)切块,供脚本区规则使用。`offset` = 切片起点在原文件里的 0 起行号。
 *
 *  加固 5b 的附带修正:`.ts` 文件里真正的"一块"常常是**缩进的**嵌套函数 / computed
 *  (useCostCenterData.ts 的 `async function reload()` 就在 `useCostCenterData()` 里面)。
 *  只按 `^\S` 切,一个 1500 行的 composable 会变成**一整块**,豁免就只能写成"整块放过",
 *  那等于把守卫在那块里关掉。所以块边界同时认缩进的 `function` 声明与缩进的 `const X = computed`。 */
const BLOCK_BOUNDARY = /^\S|^\s+(?:export\s+)?(?:async\s+)?function\s+\w+|^\s*const\s+\w+\s*=\s*computed/

function topLevelBlocks(lines: string[], offset: number): Block[] {
  const blocks: Block[] = []
  let current: Block | null = null
  lines.forEach((line, index) => {
    if (BLOCK_BOUNDARY.test(line) && current != null) {
      blocks.push(current)
      current = { line: offset + index + 1, body: [line] }
      return
    }
    if (current == null) current = { line: offset + index + 1, body: [line] }
    else current.body.push(line)
  })
  if (current != null) blocks.push(current)
  return blocks
}

function referencesAny(text: string, names: Set<string>): boolean {
  for (const name of names) {
    if (new RegExp(`\\b${name}\\b`).test(text)) return true
  }
  return false
}

/** 该文本引用到的白名单成员(用于逐个检查有没有被降维)。 */
function referencedAware(text: string, names: Set<string>): string[] {
  const found: string[] = []
  for (const name of names) {
    if (new RegExp(`\\b${name}\\b`).test(text)) found.push(name)
  }
  return found
}

interface ScannedFile {
  path: string
  lines: string[]
  templateStart: number
  templateEnd: number
  scriptStart: number
  blocks: string[][]
  sourceAwareComputed: Set<string>
}

function lastIndexWhere(lines: string[], predicate: (line: string) => boolean): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (predicate(lines[index])) return index
  }
  return -1
}

/**
 * 收紧后的白名单(加固 2 + 2b):块内必须出现对 cliproxy 的比较,**且**点名另一个源。
 * 只写一个源的谓词(`const isCliroxy = computed(() => connectionType.value === 'cliproxy')`)不进白名单
 * —— 它的兜底分支仍然把 cockpit 当成 sub2api,正是 W2 的攻击点。
 * 白名单按引用关系做**传递闭包**:`A` 三态穷举 ⇒ 引用 `A` 的 `B` 也是源感知的,引用 `B` 的 `C` 同理。
 * 加固 2b:传递时必须**未对 A 做布尔降维**,否则 `hasRev = computed(() => A.value !== 'z')`
 * 会带着"恒真布尔"混进白名单(W7)。
 */
function collectSourceAwareComputed(blocks: Block[]): Set<string> {
  const definitions = blocks
    .map((block) => ({
      name: block.body[0].match(/^\s*const\s+(\w+)\s*=\s*computed/)?.[1],
      body: block.body.join('\n'),
    }))
    .filter((item): item is { name: string; body: string } => item.name != null)
  const aware = new Set<string>()
  for (let pass = 0; pass <= definitions.length; pass += 1) {
    let changed = false
    for (const definition of definitions) {
      if (aware.has(definition.name)) continue
      if (isSourceExhaustive(definition.body)) {
        aware.add(definition.name)
        changed = true
        continue
      }
      const referenced = referencedAware(definition.body, aware)
      if (referenced.length > 0 && referenced.every((name) => !reducesBoolean(definition.body, name))) {
        aware.add(definition.name)
        changed = true
      }
    }
    if (!changed) break
  }
  return aware
}

function loadFile(path: string): ScannedFile {
  const lines = readFileSync(resolve(process.cwd(), path), 'utf8').split(/\r?\n/)
  const templateStart = lines.findIndex((line) => line.trim() === '<template>')
  const templateEnd = lastIndexWhere(lines, (line) => line.trim() === '</template>')
  const rawScriptStart = lines.findIndex((line) => line.trim().startsWith('<script'))
  // 加固 5b:`.ts` 文件没有 `<template>` / `<script>` 标签。旧实现直接拿 findIndex 的 -1 去 slice,
  // 会把脚本区退化成"只有最后一行",规则 D 形同虚设 ⇒ 这里对纯 .ts 把整份文件当脚本区。
  const scriptStart = rawScriptStart >= 0 ? rawScriptStart : 0
  const scriptLines = rawScriptStart >= 0 ? lines.slice(rawScriptStart) : lines
  return {
    path,
    lines,
    templateStart,
    templateEnd,
    scriptStart,
    blocks: topLevelBlocks(scriptLines, scriptStart),
    sourceAwareComputed: collectSourceAwareComputed(topLevelBlocks(scriptLines, scriptStart)),
  }
}

/** 递归收集 `dir` 下扩展名匹配且路径未被排除的文件(相对仓库根,正斜杠)。 */
function collectFiles(dir: string, keep: (name: string) => boolean, excluded: (relative: string) => boolean): string[] {
  const found: string[] = []
  const walk = (relative: string) => {
    for (const entry of readdirSync(resolve(process.cwd(), relative), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`
      if (excluded(child)) continue
      if (entry.isDirectory()) walk(child)
      else if (entry.isFile() && keep(entry.name)) found.push(child)
    }
  }
  walk(dir)
  return found.sort()
}

/** 加固 5b:`*.spec.ts` / `*.test.ts` / `__tests__/` 是测试自身,扫它们等于自我命中。 */
function isTestPath(relative: string): boolean {
  return relative.includes('/__tests__/') || /\.(spec|test)\.tsx?$/.test(relative)
}

/** 扫描范围(加固 5 + 5b):主视图 + 组件目录所有 .vue + 特性目录所有 .ts(备份文件不以 .vue 结尾,天然排除)。 */
const SCANNED: ScannedFile[] = [
  loadFile(VIEW_PATH),
  loadFile(COCKPIT_VIEW_PATH),
  ...collectFiles(COMPONENT_DIR, (name) => name.endsWith('.vue'), () => false).map(loadFile),
  ...collectFiles(FEATURE_DIR, (name) => name.endsWith('.ts'), isTestPath).map(loadFile),
]

interface Offender {
  file: string
  line: number | null
  /** 报告里展示的一行 */
  display: string
  /** 用于匹配豁免的原文(可能是整块,因为脚本规则的命中点在块内) */
  match: string
  rule: Rule
}

function exempt(offender: Offender): boolean {
  return EXEMPTIONS.some((item) => item.file === offender.file
    && (item.rules == null || item.rules.includes(offender.rule))
    && offender.match.includes(item.snippet))
}

function report(offenders: Offender[]): string[] {
  return offenders.filter((offender) => !exempt(offender))
    .map((offender) => `${offender.file}:${offender.line ?? '-'} — ${offender.display}`)
}

function collect(regex: RegExp, line: string, group: number): string[] {
  const found: string[] = []
  regex.lastIndex = 0
  let match = regex.exec(line)
  while (match != null) {
    found.push(match[group])
    match = regex.exec(line)
  }
  return found
}

/** 该槽位是否携带"源措辞"—— 只有带措辞的槽位才需要三态穷举。
 *  不带措辞的 `=== 'sub2api' ? 数字 : '—'` 门控、`v-if` 结构判断不在此列:
 *  它们不对外表态口径;强行要求三态只会逼出一堆同义重复分支,那是把守卫当枷锁而不是诚实。 */
function carriesSourceWording(expression: string): boolean {
  const normalized = normalize(expression)
  return SOURCE_BOUND_TERMS.some((term) => normalized.includes(term))
    || SOURCE_CALIBER_TERMS.some((term) => normalized.includes(term))
}

/** 该槽位是否"说清了来源":自身三态穷举,或引用一个三态穷举的 computed。
 *  带措辞时**不接受** `=== 'sub2api' ? A : B`:兜底分支会把 cockpit / cliproxy 一起套上 sub2api 的说法。
 *  加固 2b:引用白名单成员时若对它做了布尔降维(`!x` / `x === y`),等于把三源压成两态 ⇒ 不算说清来源。 */
function explainsSource(file: ScannedFile, expression: string): boolean {
  if (isSourceExhaustive(expression)) return true
  const referenced = referencedAware(expression, file.sourceAwareComputed)
  if (referenced.length === 0) return false
  return referenced.every((name) => !reducesBoolean(expression, name))
}

/** 剥掉插值、属性值与标签,只留模板的**文本节点**正文。 */
function textNodeText(line: string): string {
  return line
    .replace(/\{\{[\s\S]*?\}\}/g, '')
    .replace(/"[^"]*"/g, '""')
    .replace(/<[^>]*>/g, ' ')
}

/** 文本节点的源上下文:属性与文本常分两行(`v-if` 在上一行),故连同上一行一起看。 */
function textNodeHasSourceContext(file: ScannedFile, index: number): boolean {
  const window = `${file.lines[index - 1] ?? ''}\n${file.lines[index]}`
  return isSourceExhaustive(window)
    || SUB2API_COMPARISON.test(window)
    || referencesAny(window, file.sourceAwareComputed)
}

/** 只做 `=== 'sub2api'` 门控、其余源落到不表态兜底的槽位,不参与穷举检查的"结构指令"白名单。 */
const STRUCTURAL_ATTRIBUTES = new Set(['if', 'else-if', 'show', 'model', 'for', 'ref', 'key'])

/** 加固 3b:静态属性扫描 —— 从 `label|note|title|caption` 扩到**全部**静态属性,
 *  覆盖 `aria-label="用户计费"` / `data-tip="渠道价"` 这类同样会渲染给用户看的静态槽位。
 *  前导否定仍排除 `:label` / `@click` 等绑定;`v-*` 指令值是指令表达式,不按"静态文案"判。 */
const STATIC_ATTRIBUTE = /(?<![:@\w-])([a-z][\w-]*)="([^"]*)"/g
const STATIC_PROPERTY = /(?<![\w'])(label|title|note|caption)\s*:\s*'[^']*'/

function isStaticProseAttribute(name: string): boolean {
  if (STRUCTURAL_ATTRIBUTES.has(name)) return false
  if (name.startsWith('v-')) return false
  return true
}

/** 加固 1(W6):`withDefaults(...)` 实参里出现 `sourceKind` ⇒ 该组件的源标识有默认值,
 *  父组件漏传时会**静默**按默认源渲染(不报错、不显示"无数据"),这是唯一会静默走错源的缺口。 */
function withDefaultsSpans(text: string): string[] {
  const spans: string[] = []
  const opener = /withDefaults\s*\(/g
  let match = opener.exec(text)
  while (match != null) {
    let depth = 1
    let cursor = opener.lastIndex
    while (cursor < text.length && depth > 0) {
      const char = text[cursor]
      if (char === '(') depth += 1
      else if (char === ')') depth -= 1
      cursor += 1
    }
    spans.push(text.slice(match.index, cursor))
    match = opener.exec(text)
  }
  return spans
}

describe('cost center 三源措辞契约:非 cockpit / 非 sub2api 不得默认按 sub2api 说话', () => {
  it('规则 A:两分支 `connectionType === null ?` 的槽位不得出现营收层 / 渠道价 / 账号费率 / usage_logs 措辞', () => {
    // 两分支 = 有 cockpit 分支却没有 cliproxy 分支 ⇒ 兜底分支被静默当成 sub2api。
    // 按**属性/插值分段**判定(不能按整行):同一行可以同时有一个两分支 label 和一个三分支 note。
    const offenders: Offender[] = []
    for (const file of SCANNED) {
      file.lines.forEach((line, index) => {
        line.split('"').forEach((chunk) => {
          if (/connectionType(?:\.value)? === null \?/.test(chunk)
            && !CLIPROXY_COMPARISON.test(chunk)
            && hits(chunk).length > 0) {
            offenders.push({ file: file.path, line: index + 1, display: chunk.trim().slice(0, 140), match: chunk, rule: 'A' })
          }
        })
      })
    }
    expect(report(offenders)).toEqual([])
  })

  it('规则 B(加固 3b):任何静态属性槽位不得出现上述措辞(含 aria-* / data-*)', () => {
    // 随源变化的槽位必须写成 `:label` / `:note` 绑定;写死的静态槽位在三源下必然对两个源说错话。
    const offenders: Offender[] = []
    for (const file of SCANNED) {
      file.lines.forEach((line, index) => {
        const slots: string[] = []
        STATIC_ATTRIBUTE.lastIndex = 0
        let attribute = STATIC_ATTRIBUTE.exec(line)
        while (attribute != null) {
          const [, name, value] = attribute
          if (isStaticProseAttribute(name) && hits(`${name}="${value}"`).length > 0) slots.push(`${name}="${value}"`)
          attribute = STATIC_ATTRIBUTE.exec(line)
        }
        const property = line.match(STATIC_PROPERTY)?.[0]
        if (property != null && hits(property).length > 0) slots.push(property)
        if (slots.length === 0) return
        const slot = slots.join(' ')
        // 脚本区里的 `label: '…'` 若落在**三态穷举的 computed 块**内(如 economySeries 的 sub2api 分支),
        // 它已由规则 D 覆盖,静态槽位规则不重复判它。
        const owner = file.blocks.find((block) => index + 1 >= block.line && index + 1 < block.line + block.body.length)
        if (owner) {
          const ownerBody = owner.body.join('\n')
          if (isSourceExhaustive(ownerBody) || referencesAny(ownerBody, file.sourceAwareComputed)) return
        }
        offenders.push({ file: file.path, line: index + 1, display: slot.trim().slice(0, 140), match: slot, rule: 'B' })
      })
    }
    expect(report(offenders)).toEqual([])
  })

  it('规则 B2:动态槽位(:label/:note/:title/:caption)出现上述措辞时必须说清来源', () => {
    const dynamicSlot = /:(label|note|title|caption)="([^"]*)"/g
    const offenders: Offender[] = []
    for (const file of SCANNED) {
      file.lines.forEach((line, index) => {
        collect(dynamicSlot, line, 2).forEach((value) => {
          if (carriesSourceWording(value) && !explainsSource(file, value)) {
            offenders.push({ file: file.path, line: index + 1, display: value.trim().slice(0, 140), match: value, rule: 'B2' })
          }
        })
      })
    }
    expect(report(offenders)).toEqual([])
  })

  it('规则 B3(加固 4):带源语义的绑定槽位必须三态穷举,禁止 `A ? x : y`', () => {
    // 覆盖 W1(只认 `!== 'cliproxy'`)/ W4(只认 `=== 'cliproxy'`)/ W5(裸 connectionType 真值判断):
    // 这三种写法都会让某个源的兜底分支被静默当成 sub2api。
    const binding = /:([\w-]+)="([^"]*)"/g
    const offenders: Offender[] = []
    for (const file of SCANNED) {
      file.lines.forEach((line, index) => {
        binding.lastIndex = 0
        let match = binding.exec(line)
        while (match != null) {
          const [, attribute, expression] = match
          if (!STRUCTURAL_ATTRIBUTES.has(attribute)
            && carriesSourceWording(expression)
            && !explainsSource(file, expression)) {
            offenders.push({ file: file.path, line: index + 1, display: `${attribute}="${expression.trim().slice(0, 130)}"`, match: expression, rule: 'B3' })
          }
          match = binding.exec(line)
        }
      })
    }
    expect(report(offenders)).toEqual([])
  })

  it('规则 C:模板文本节点里的上述措辞必须由源分支区分(或落在已豁免的 sub2api 专属 / 动词用法)', () => {
    // 多行 HTML 注释先按位置挖空(保留换行,行号稳定),否则注释正文会被当成文案。
    const offenders: Offender[] = []
    for (const file of SCANNED) {
      const templateText = file.lines
        .slice(file.templateStart, file.templateEnd + 1)
        .join('\n')
        .replace(/<!--[\s\S]*?-->/g, (comment) => comment.replace(/[^\n]/g, ' '))
      templateText.split('\n').forEach((line, index) => {
        const raw = file.lines[file.templateStart + index] ?? ''
        const lineNo = file.templateStart + index + 1
        if (hits(textNodeText(line)).length > 0 && !textNodeHasSourceContext(file, file.templateStart + index)) {
          offenders.push({ file: file.path, line: lineNo, display: raw.trim().slice(0, 140), match: raw, rule: 'C' })
        }
      })
    }
    expect(report(offenders)).toEqual([])
  })

  it('规则 E(加固 3d):模板插值 {{ }} 出现上述措辞或源判断时必须说清来源', () => {
    const offenders: Offender[] = []
    for (const file of SCANNED) {
      file.lines.forEach((line, index) => {
        if (index <= file.templateStart || index >= file.templateEnd) return
        // 先归一化:相邻插值 `{{ 'usage' }}{{ '_logs' }}` 连成 `{{ 'usage' + '_logs' }}` 后才会被词表命中。
        collect(/\{\{([\s\S]*?)\}\}/g, normalize(line), 1).forEach((value) => {
          if (carriesSourceWording(value) && !explainsSource(file, value)) {
            offenders.push({ file: file.path, line: index + 1, display: value.trim().slice(0, 140), match: value, rule: 'E' })
          }
        })
      })
    }
    expect(report(offenders)).toEqual([])
  })

  it('规则 D:脚本区每个顶层声明块若出现上述措辞,该块必须自己区分三源', () => {
    const offenders: Offender[] = []
    for (const file of SCANNED) {
      for (const block of file.blocks) {
        const body = block.body
          .filter((line) => line.trim() !== '' && !/^\s*(\/\/|\*|\/\*)/.test(line))
          .join('\n')
        if (hits(body).length === 0) continue
        if (isSourceExhaustive(body) || referencesAny(body, file.sourceAwareComputed)) continue
        const firstHit = block.body.find((line) => hits(line).length > 0 && !/^\s*(\/\/|\*|\/\*)/.test(line)) ?? block.body[0]
        offenders.push({
          file: file.path,
          line: block.line,
          display: `${block.body[0].trim().slice(0, 90)} ⟶ ${firstHit.trim().slice(0, 90)}`,
          match: body,
          rule: 'D',
        })
      }
    }
    expect(report(offenders)).toEqual([])
  })

  it('规则 F(加固 1 / W6):声明 sourceKind 的组件不得给它默认值或可选声明', () => {
    // `withDefaults(defineProps<…>(), { sourceKind: 'sub2api' })` 与 `sourceKind?: …`
    // 都会让"父组件漏传"变成"静默按 sub2api 渲染" —— 不报错、不显示"无数据",
    // 是全部盲区里唯一会**静默走错源**的一个。源标识必须三态必填。
    const offenders: string[] = []
    for (const file of SCANNED) {
      const text = file.lines.join('\n')
      if (!/\bsourceKind\b/.test(text)) continue
      if (withDefaultsSpans(text).some((span) => /\bsourceKind\b/.test(span))) {
        offenders.push(`${file.path} — withDefaults(...) 给了 sourceKind 默认值`)
      }
      if (/sourceKind\s*\?\s*:/.test(text)) {
        offenders.push(`${file.path} — sourceKind 被声明成可选属性`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('白名单自身不许退化:三源穷举的 computed 必须真的被识别,单源谓词 / 布尔降维必须被拒', () => {
    // 这条锁住加固 2 / 2b 本身 —— 否则有人把 isSourceExhaustive 改回"含字符串 cliproxy"
    // 或把 reducesBoolean 删掉就没人发现。
    const view = SCANNED.find((file) => file.path === VIEW_PATH)!
    const component = SCANNED.find((file) => file.path.endsWith('AdaptiveOperationsCharts.vue'))!
    expect(view.sourceAwareComputed.has('costSourceKind')).toBe(true)
    expect(isSourceExhaustive("connectionType.value === 'cliproxy'")).toBe(false)
    expect(isSourceExhaustive("props.sourceKind === 'cliproxy' ? '估算成本' : '自算成本'")).toBe(false)
    expect(isSourceExhaustive("connectionType.value === 'cliproxy' ? 'x' : connectionType.value === null ? 'y' : 'z'")).toBe(true)
    expect(component.sourceAwareComputed.size).toBeGreaterThan(0)

    // 加固 2b:三种降维形态都必须被认出来,纯传递不算降维。
    expect(reducesBoolean("sourceEconomy.value !== 'z'", 'sourceEconomy')).toBe(true)
    expect(reducesBoolean('!hasRevenueLayer.value', 'hasRevenueLayer')).toBe(true)
    expect(reducesBoolean("'z' === hasRevenueLayer.value", 'hasRevenueLayer')).toBe(true)
    expect(reducesBoolean('sourceEconomy.value', 'sourceEconomy')).toBe(false)

    // 闭包必须拒收"降维块":构造一个假的 blocks,确认它不会把 hasRev 收进白名单。
    const fakeBlocks: Block[] = [
      { line: 1, body: ["const base = computed(() => connectionType.value === 'cliproxy' ? 'c' : connectionType.value === null ? 'k' : 's')"] },
      { line: 2, body: ["const hasRev = computed(() => base.value !== 'z')"] },
      { line: 3, body: ["const passthrough = computed(() => base.value)"] },
    ]
    const fakeAware = collectSourceAwareComputed(fakeBlocks)
    expect(fakeAware.has('base')).toBe(true)
    expect(fakeAware.has('hasRev')).toBe(false)
    expect(fakeAware.has('passthrough')).toBe(true)
  })

  it('豁免不得回潮:CostProfileInspector.vue 已按源分支,不再接受对该文件的任何豁免', () => {
    // 本轮(2026-09-16 第三轮)把该文件写死的 usage_logs / 渠道价 文案改成三源分支后,
    // 三条「已确认缺陷 · 超出允许改动范围」豁免全部删除。这里钉住它 ——
    // 否则有人把缺陷文案改回来时,只要顺手补一条豁免就能让守卫重新变绿。
    expect(EXEMPTIONS.filter((item) => item.file.endsWith('CostProfileInspector.vue'))).toEqual([])
  })

  it('归一化(加固 3 / 3c / 3d):字面量相加、HTML 实体、相邻插值都必须能被词表命中', () => {
    expect(hits("'产' + '出'")).toEqual(['产出'])
    expect(hits("{{ '产' + '出' }}")).toEqual(['产出'])
    expect(hits("'us' + 'age_logs'")).toEqual(['usage_logs'])
    // 3c HTML 实体(数字 / 十六进制 / 命名)
    expect(hits('usage&#95;logs')).toEqual(['usage_logs'])
    expect(hits('usage&#x5F;logs')).toEqual(['usage_logs'])
    expect(hits('usage&lowbar;logs')).toEqual(['usage_logs'])
    expect(hits('&#x4EA7;&#x51FA;')).toEqual(['产出'])
    // 3d 相邻插值拼接
    expect(hits("{{ 'usage' }}{{ '_logs' }}")).toEqual(['usage_logs'])
    expect(hits("{{ '毛' }}{{ '利' }}")).toEqual(['毛利'])
  })

  /**
   * ★ 语言覆盖 tripwire(2026-09-22)
   *
   * `SOURCE_BOUND_TERMS` 是**中文词表**,且 `hits()` 是**纯子串匹配**。这两点合起来有一个
   * 从未被写下来的**隐含前提**:成本中心面是「中文硬编码 + 中文词表」的**自洽组合** ——
   * 源码里渲染什么,词表就匹配什么。
   *
   * 一旦有人把这些文件 i18n 化,渲染出的英文文案**一个中文词都不命中**,规则 A–F 会照常全绿
   * ⇒ 守卫**静默失效**。届时英文界面完全可以把 cliproxy / cockpit 的估算成本标成 "Revenue",
   * 而 CI 是绿的 —— 正是本项目反复吃亏的「假绿」形态。
   *
   * 但**不能直接把英文词条并进词表**(理由见 `SOURCE_BOUND_TERMS_EN` 注释:实测 50 处命中
   * 全是标识符,会把假绿翻成假红)。正确顺序:**先换词边界匹配,再补英文词条**。
   * 本 tripwire 的职责是让这个顺序**不能被人静默跳过**。
   */
  it('★ 语言覆盖:成本中心未 i18n 化前不得引入 t()/useI18n(否则中文词表静默失效)', () => {
    const surface = [VIEW_PATH, COCKPIT_VIEW_PATH]
      .concat(collectFiles(COMPONENT_DIR, (name) => name.endsWith('.vue'), () => false))
      .map((path) => ({ path, text: readFileSync(resolve(process.cwd(), path), 'utf8') }))

    const i18nRendered = filesRenderingThroughI18n(surface)
    if (i18nRendered.length > 0) {
      throw new Error([
        `成本中心面已开始 i18n 化:${i18nRendered.join(', ')}`,
        `但 SOURCE_BOUND_TERMS 仍是中文词表(${SOURCE_BOUND_TERMS.join(' / ')}),`,
        '而 hits() 是纯子串匹配 —— 英文文案一个词都不命中,规则 A–F 会**静默失效**。',
        '修法(顺序不可颠倒):',
        `  1. 先给 hits() 换**词边界**匹配 —— 否则 ${SOURCE_BOUND_TERMS_EN.join(' / ')}`,
        '     会在 modelCostSummary.revenue / revenueMissing / totals.outputTokens',
        '     这类标识符上假红(实测:成本中心面跑英文词表 = 50 命中 / 0 真措辞);',
        '  2. 再把 SOURCE_BOUND_TERMS_EN 并进 SOURCE_BOUND_TERMS。',
      ].join('\n'))
    }

    // 词表必须与「实际渲染语言」同语言。当前渲染语言 = 中文 ⇒ 词表是中文、英文表未启用。
    // 这两条是**非空断言**:防止有人只改词表语言、不碰渲染语言,让 tripwire 的前提失真。
    expect(SOURCE_BOUND_TERMS.some((term) => /[\u4e00-\u9fff]/.test(term))).toBe(true)
    expect(SOURCE_BOUND_TERMS_EN.some((term) => /[\u4e00-\u9fff]/.test(term))).toBe(false)
  })

  it('tripwire 自检:注入 i18n 渲染写法必须被识别,标识符调用不得误命中', () => {
    // 没有这条,上面那个 `if` 就是一句无法证伪的空话 —— 它可能永远不命中。
    expect(filesRenderingThroughI18n([
      { path: 'plain.vue', text: '<p>纯中文硬编码</p>' },
      { path: 'ident.vue', text: 'formatTokens(a.usage.outputTokens); mount(Comp); output(x)' },
      { path: 'call.vue', text: "<p>{{ t('cost.title') }}</p>" },
      { path: 'composable.vue', text: 'const { t } = useI18n()' },
      { path: 'global.vue', text: "<span>{{ $t('cost.note') }}</span>" },
    ])).toEqual(['call.vue', 'composable.vue', 'global.vue'])
  })

  /**
   * ★ 词表耦合 tripwire(2026-09-22)
   *
   * 上一条只认 `t()` / `useI18n` 形态 —— 若有人把中文**直接改成硬编码英文**（不走 i18n），
   * 它完全看不见。这条补上那个洞:断言**词表里的每个词都真的出现在扫描面里**。
   *
   * 为什么不是「命中数 >= N」:魔数地板既脆弱又说不清（多少才算够?）。而「每个词至少出现一次」
   * 是**非任意**的 —— 一个从不出现的词就是**死词**（守卫在为一个不存在的写法报警）;
   * 而源码被翻译/改写时中文词会整批消失,这条断言必然先红。
   *
   * 实测(2026-09-22):36 个扫描文件 / 370 次命中 / 14 个文件含词;
   * 10 个 `SOURCE_BOUND_TERMS` 全部出现（最少的是「贡献毛利」6 次）,
   * 2 个 `SOURCE_CALIBER_TERMS` 也全部出现。
   */
  it('★ 词表耦合:每个受保护的词都必须真的出现在扫描面里(死词 = 守卫在为空报警)', () => {
    const corpus = normalize(SCANNED.map((file) => file.lines.join('\n')).join('\n'))
    const dead = [...SOURCE_BOUND_TERMS, ...SOURCE_CALIBER_TERMS]
      .filter((term) => !corpus.includes(term))

    expect(dead, `以下词在扫描面里一次都没出现 —— 要么是死词,要么源码已被翻译/改写:\n${dead.join(' / ')}`)
      .toEqual([])
  })
})
