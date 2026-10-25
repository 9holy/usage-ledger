import { costDataText } from './costDataText'
import type { SourceAccount, SourceAdminUsageLog as AdminUsageLog, SourceModelStat as ModelStat } from './sourceTypes'
import { describeUpstreamOrigin } from './upstreamProvider'

export type ModelCostSource = 'requested' | 'upstream' | 'response' | 'mapping'

export interface ModelCostRow extends ModelStat {
  provider: string
  /** 标准价。null = 该源不掌握该模型成本(既无本项目单价、数据源也无估算),
   *  显示层渲染「成本未知」而不是 $0.000000。 */
  standardCost: number | null
  /** 上游账号成本。null 语义同 standardCost。 */
  accountCost: number | null
  /** 成本是否"算不出来"。true 时 standardCost / accountCost 恒为 null —— 计价函数在这种情形下
   *  返回的是**哨兵 0**(costBasis.ts noPriceNoEstimateCost:cost 恒 0,只带 basis 标注),
   *  那个 0 不是实测成本,写进数值列会被渲染成 $0.000000。同 modelRouteAnalysis.ModelRouteRow.costUnknown。 */
  costUnknown?: boolean
  /** 用户计费(营收)。null = 该数据源不掌握营收(cockpit),必须渲染「—」而不是 0。 */
  revenue: number | null
  /** 毛利。null = 营收不可知,算不出毛利;不得回退成 0(那等于宣称"毛利为零")。 */
  grossProfit: number | null
  grossMargin: number | null
  accountCostEstimated: boolean
  /** 该行所在数据源没有营收口径(cockpit 本地采集源恒为 true)。 */
  revenueMissing: boolean
  pricingMissing: boolean
}

export interface ModelCostSummary {
  modelCount: number
  /**
   * 标准价合计。**已知部分之和**。
   *
   * ★ 2026-09-24:此前语义是「任一行未知 ⇒ 整个合计 null」,那是**过度修正** ——
   *   本机 9 个模型里 6 个有价(合计 $8,723.422),只因 3 个模型无单价,
   *   模型区 KPI 就显示 `—` + 「不可用」,而**同屏顶部**明明已把同一个 $8,723.422
   *   作为「最近窗口自算成本」显示出来 ⇒ 一个量在一页里给出两个互斥答案。
   *   与项目红线的三态桶对齐:**全未知 ⇒ null;部分未知 ⇒ 保留已知部分之和(真实下界)
   *   + 展示层标注**;`costPartial` 就是那个「下界」信号。
   */
  standardCost: number | null
  /** 上游账号成本合计。语义同 `standardCost`(已知部分之和)。 */
  accountCost: number | null
  /** 至少有一行成本未知时为真 —— 用于**文案**,不再用于把合计打成 null。 */
  costMissing: boolean
  /**
   * 标准价「部分未知」:合计只是**下界**。
   *
   * ★ 必须与 `accountCostPartial` **分开**:`standardCost` 为 null 的行,
   *   `accountCost` 在源给了 `account_cost` 时**仍然有值**(见 :250-252)。
   *   用一个共同的「全未知」闸门会把「标准价全未知、账号成本已知」误判成全部 null
   *   —— 正是 `modelCostAnalysis.spec.ts` 那条「cost 未知但源给了 account_cost ⇒ 合计取该值」抓到的。
   */
  standardCostPartial: boolean
  /** 上游账号成本「部分未知」:合计只是下界。语义同 `standardCostPartial`,判据独立。 */
  accountCostPartial: boolean
  /** 标准价未知的模型数(供「N 个模型无单价 · 合计为下界」文案)。 */
  unknownCostModelCount: number
  /** 账号成本未知的模型数(与上一项**分开计数**,理由见 `standardCostPartial`)。 */
  unknownAccountCostModelCount: number
  /** null = 至少有一行缺营收,合计营收不可信 */
  revenue: number | null
  /**
   * 毛利合计。null = **任一行**算不出毛利(缺营收 **或** 缺账号成本)⇒ 合计不可信,UI 必须显示「—」。
   *
   * 2026-09-22:此前只有 `revenueMissing` 一个守卫,而逐行毛利是
   * `revenue == null || accountCost == null ? null : revenue - accountCost`(:245)——
   * `revenue` 有值但 `accountCost` 为 null 的行(ModelStat.cost 为 null 且源也没给
   * account_cost)同样算不出毛利,却既不置 `revenueMissing` 也不会报错:
   * `:297` 直接**跳过**它,于是汇总报出一个**部分和**(全是这种行时是初值 `0`)
   * 却被当成总毛利 —— 同屏明细行那一列此时显示的是「—」,两处自相矛盾。
   * 现改为由 `grossProfitMissing` 独立记录,与 `:314`/`:315` 的 `costMissing` 处理对齐:
   * **合计口径必须与明细口径一致**。
   */
  grossProfit: number | null
  /** 任一行算不出毛利(缺营收或缺账号成本)⇒ 合计毛利不可信。 */
  grossProfitMissing: boolean
  grossMargin: number | null
  estimatedModelCount: number
  missingPricingCount: number
  /** 任一行缺营收 → 合计营收/毛利不可信,UI 必须显示「—」 */
  revenueMissing: boolean
}

export interface ModelAuditSummary {
  totalRequests: number
  observedRequests: number
  matchedRequests: number
  mismatchRequests: number
  unobservedRequests: number
  mismatchRate: number | null
  /** 替换请求的"标准计费成本"合计。null = 其中有记录的 total_cost 不可知(如 cockpit 适配器
   *  把 total_cost 置 null)⇒ 合计不可信,UI 渲染「—」而不是 0。与同对象的 mismatchAccountCost /
   *  mismatchRevenue 同一套空值语义。 */
  mismatchStandardCost: number | null
  /** 替换请求的"上游账号成本"合计。null = 其中有记录的账号成本不可知(accountCostSnapshot 返 null),
   *  合计不可信,UI 渲染「无数据」而不是 0。与同对象的 mismatchRevenue 同一套空值语义。 */
  mismatchAccountCost: number | null
  /** 替换请求的"用户计费"(营收)合计。null = 该数据源不掌握营收(cockpit),必须渲染「—」而不是 0。 */
  mismatchRevenue: number | null
}

function finiteNumber(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** 与 finiteNumber 相对:null/空/非有限 → null(表示"无此数据")。
 *  **不要**拿 finiteNumber 处理可能为 null 的值 —— `Number(null) === 0`,
 *  会把"算不出来"静默变成"实测为 0",正是本轮要消除的假零形态。 */
function nullableNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function sumTokenCounts(...values: Array<number | null | undefined>): number | null {
  let total = 0
  for (const value of values) {
    if (value == null || !Number.isFinite(value)) return null
    total += value
  }
  return total
}

function roundedMoney(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000
}

function normalizedModel(value: unknown, fallback = costDataText('unknownModel2')): string {
  const model = String(value ?? '').trim()
  return model || fallback
}

function modelDimension(log: AdminUsageLog, source: ModelCostSource): string {
  const requested = normalizedModel(log.model)
  const upstream = normalizedModel(log.upstream_model, requested)
  const response = normalizedModel(log.upstream_response_model, costDataText('unknownResponseModel'))
  if (source === 'upstream') return upstream
  if (source === 'response') return response
  if (source === 'mapping') return `${requested} -> ${upstream}`
  return requested
}

/** 账号费率估算：官方 SQL 为 COALESCE(account_stats_cost,total_cost) × account_rate_multiplier。
 * `account_stats_cost` 是倍率前统计定价，不是支付凭据。两项都缺失 ⇒ null(该源不掌握),
 *  不得用 finiteNumber 压成 0(那等于断言"这个账号确实没花钱")。
 *  真实 0(源给了 0)仍是 0。 */
export function accountCostSnapshot(log: Pick<AdminUsageLog, 'account_stats_cost' | 'total_cost' | 'account_rate_multiplier'>): number | null {
  const total = nullableNumber(log.account_stats_cost ?? log.total_cost)
  if (total == null) return null
  const accountMultiplier = log.account_rate_multiplier == null ? 1 : nullableNumber(log.account_rate_multiplier)
  return accountMultiplier == null ? null : total * accountMultiplier
}

export function* uniqueUsageLogs(logs: readonly AdminUsageLog[]): IterableIterator<AdminUsageLog> {
  const seen = new Set<number>()
  for (const log of logs) {
    // Compatibility adapters use id: 0 when the source has no persistent log ID.
    if (Number.isInteger(log.id) && log.id > 0) {
      if (seen.has(log.id)) continue
      seen.add(log.id)
    }
    yield log
  }
}

export function aggregateModelStatsFromUsageLogs(logs: AdminUsageLog[], source: ModelCostSource): ModelStat[] {
  const rows = new Map<string, ModelStat>()
  for (const log of uniqueUsageLogs(logs)) {
    const model = modelDimension(log, source)
    const createdAt = String(log.created_at || '')
    const accountCost = accountCostSnapshot(log)
    const logCost = nullableNumber(log.total_cost)
    const logRevenue = nullableNumber(log.actual_cost)
    const inputTokens = nullableNumber(log.input_tokens)
    const outputTokens = nullableNumber(log.output_tokens)
    const cacheCreationTokens = nullableNumber(log.cache_creation_tokens)
    const cacheReadTokens = nullableNumber(log.cache_read_tokens)
    const totalTokens = sumTokenCounts(inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens)
    const existing = rows.get(model)
    if (existing) {
      existing.requests += 1
      existing.input_tokens = sumTokenCounts(existing.input_tokens, inputTokens)
      existing.output_tokens = sumTokenCounts(existing.output_tokens, outputTokens)
      existing.cache_creation_tokens = sumTokenCounts(existing.cache_creation_tokens, cacheCreationTokens)
      existing.cache_read_tokens = sumTokenCounts(existing.cache_read_tokens, cacheReadTokens)
      existing.total_tokens = sumTokenCounts(existing.total_tokens, totalTokens)
      // 成本 null 传播:任一分量未知 ⇒ 合计未知(null + 已知 ≠ 已知,不得用 0 补齐)。
      existing.cost = existing.cost == null || logCost == null ? null : existing.cost + logCost
      // 营收不可知(cockpit: actual_cost === null)时保持 null,不用 0 冒充"营收为零"。
      existing.actual_cost = existing.actual_cost == null || logRevenue == null
        ? null
        : existing.actual_cost + logRevenue
      existing.account_cost = existing.account_cost == null || accountCost == null
        ? null
        : existing.account_cost + accountCost
      if (createdAt && (!existing.first_seen || createdAt < existing.first_seen)) existing.first_seen = createdAt
      if (createdAt && (!existing.last_seen || createdAt > existing.last_seen)) existing.last_seen = createdAt
      continue
    }
    rows.set(model, {
      model,
      requests: 1,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_tokens: cacheCreationTokens,
      cache_read_tokens: cacheReadTokens,
      total_tokens: totalTokens,
      cost: logCost,
      actual_cost: logRevenue,
      account_cost: accountCost,
      first_seen: createdAt || undefined,
      last_seen: createdAt || undefined,
    })
  }
  // null 安全:账号成本未知的行排最后,**不得当 0 参与比较**
  // (「null 当 0」与「正成本」比大小恰好同序,会让未知行冒充"成本最低"的确定结论)。
  return [...rows.values()].sort((left, right) => {
    if (left.account_cost == null && right.account_cost == null) return right.requests - left.requests
    if (left.account_cost == null) return 1
    if (right.account_cost == null) return -1
    return right.account_cost - left.account_cost || right.requests - left.requests
  })
}

export function summarizeModelAudit(logs: AdminUsageLog[]): ModelAuditSummary {
  const summary = [...uniqueUsageLogs(logs)].reduce<ModelAuditSummary>((result, log) => {
    result.totalRequests += 1
    if (log.upstream_model_mismatch == null) {
      result.unobservedRequests += 1
      return result
    }

    result.observedRequests += 1
    if (!log.upstream_model_mismatch) {
      result.matchedRequests += 1
      return result
    }

    result.mismatchRequests += 1
    // 标准成本不可知(total_cost 缺失)⇒ 合计不可信,保持 null 不用 0 补齐(同下方两处)。
    if (result.mismatchStandardCost !== null) {
      result.mismatchStandardCost = log.total_cost == null ? null : result.mismatchStandardCost + finiteNumber(log.total_cost)
    }
    // 账号成本不可知(account_stats_cost 与 total_cost 都缺)⇒ 合计不可信,保持 null 不用 0 补齐。
    if (result.mismatchAccountCost !== null) {
      const snapshot = accountCostSnapshot(log)
      result.mismatchAccountCost = snapshot == null ? null : result.mismatchAccountCost + snapshot
    }
    // 营收不可知(cockpit: actual_cost === null)时保持 null,不用 0 冒充"营收为零"。
    if (result.mismatchRevenue !== null) {
      result.mismatchRevenue = log.actual_cost == null ? null : result.mismatchRevenue + finiteNumber(log.actual_cost)
    }
    return result
  }, {
    totalRequests: 0,
    observedRequests: 0,
    matchedRequests: 0,
    mismatchRequests: 0,
    unobservedRequests: 0,
    mismatchRate: null as number | null,
    mismatchStandardCost: 0 as number | null,
    mismatchAccountCost: 0 as number | null,
    mismatchRevenue: 0 as number | null,
  })

  summary.mismatchRate = summary.observedRequests > 0
    ? summary.mismatchRequests / summary.observedRequests
    : null
  summary.mismatchStandardCost = summary.mismatchStandardCost == null ? null : roundedMoney(summary.mismatchStandardCost)
  summary.mismatchAccountCost = summary.mismatchAccountCost == null ? null : roundedMoney(summary.mismatchAccountCost)
  summary.mismatchRevenue = summary.mismatchRevenue == null ? null : roundedMoney(summary.mismatchRevenue)
  return summary
}

export function classifyModelProvider(model: string): string {
  const normalized = String(model || '').toLowerCase()
  if (normalized.includes('deepseek')) return 'DeepSeek'
  if (/(^|[/_-])(gpt|o[134])([/_-]|\d|$)/.test(normalized)) return 'OpenAI'
  if (normalized.includes('claude')) return 'Anthropic'
  if (normalized.includes('gemini')) return 'Google'
  if (normalized.includes('grok')) return 'xAI'
  if (normalized.includes('mistral') || normalized.includes('mixtral') || normalized.includes('codestral')) return 'Mistral'
  if (normalized.includes('llama')) return 'Meta / Llama'
  if (normalized.includes('qwen') || normalized.includes('qwq')) return 'Alibaba / Qwen'
  if (normalized.includes('glm') || normalized.includes('chatglm')) return 'Z.ai / GLM'
  if (normalized.includes('moonshot') || normalized.includes('kimi')) return 'Moonshot / Kimi'
  if (normalized.includes('minimax')) return 'MiniMax'
  if (/(^|[/_-])command-[ar]([/_-]|$)/.test(normalized)) return 'Cohere'
  if (normalized.includes('sonar')) return 'Perplexity'
  return costDataText('otherRelay')
}

export function buildModelCostRows(models: ModelStat[]): ModelCostRow[] {
  return models
    .map((model) => {
      // model.cost 为 null = 该源不掌握该模型成本(适配器已把哨兵 0 转成 null)⇒ 保持 null,
      // **不得**走 finiteNumber(`Number(null) === 0`,会把"算不出来"变成真实 $0)。
      const standardCost = model.cost == null ? null : nullableNumber(model.cost)
      const costUnknown = standardCost == null
      const hasAccountCost = typeof model.account_cost === 'number' && Number.isFinite(model.account_cost)
      // 账号成本缺失时回退标准价;标准价也未知 ⇒ 一起 null(不补齐 0)。
      const accountCost = hasAccountCost ? finiteNumber(model.account_cost) : standardCost
      // 营收口径:actual_cost 为 null 表示该数据源不掌握营收(cockpit 本地采集源)。
      // 此前这里用 finiteNumber(null) → 0,于是 revenue === accountCost、grossProfit 恒为 0,
      // 界面把一个"算不出来"渲染成了绿色的"毛利为零、经营健康"。
      const hasActualCost = typeof model.actual_cost === 'number' && Number.isFinite(model.actual_cost)
      const revenueMissing = !hasActualCost
      const revenue = hasActualCost ? finiteNumber(model.actual_cost) : null
      const grossProfit = revenue == null || accountCost == null ? null : revenue - accountCost
      const totalTokens = nullableNumber(model.total_tokens)

      return {
        ...model,
        requests: finiteNumber(model.requests),
        input_tokens: nullableNumber(model.input_tokens),
        output_tokens: nullableNumber(model.output_tokens),
        cache_creation_tokens: nullableNumber(model.cache_creation_tokens),
        cache_read_tokens: nullableNumber(model.cache_read_tokens),
        total_tokens: totalTokens,
        cost: standardCost,
        actual_cost: revenue,
        provider: classifyModelProvider(model.model),
        standardCost,
        accountCost,
        costUnknown,
        revenue,
        grossProfit,
        grossMargin: revenue == null || revenue <= 0 || grossProfit == null ? null : grossProfit / revenue,
        accountCostEstimated: !hasAccountCost,
        revenueMissing,
        // 营收不可知时按"此前 revenue === 0"的口径判定,保证 cockpit 行为与改动前一致。
        // 成本未知(null,既无单价也无估算)同样属于"缺少价格",必须计入。
        pricingMissing: totalTokens != null && totalTokens > 0
          && (standardCost == null || accountCost == null),
      }
    })
    // null 安全:成本未知的行排最后(null 不当 0 参与比较)。
    .sort((left, right) => {
      if (left.accountCost == null && right.accountCost == null) return right.requests - left.requests
      if (left.accountCost == null) return 1
      if (right.accountCost == null) return -1
      return right.accountCost - left.accountCost || right.requests - left.requests
    })
}

export function summarizeModelCosts(rows: ModelCostRow[]): ModelCostSummary {
  // ★ 毛利合计的「缺失」必须**逐行**累积(2026-09-22):判据是 `row.grossProfit == null`
  //   (即该行缺营收或缺账号成本),**不是** `revenueMissing` —— 后者只看营收。
  //   注意不要图省事用 `costMissing` 代替:ModelStat.cost 为 null 但源给了 account_cost 的行,
  //   `costUnknown` 为真而 `accountCost` 有值 ⇒ 该行毛利是**算得出来的**,用 costMissing 会把
  //   一个有效合计误判成不可用(假「—」也是不诚实)。
  const summary = rows.reduce<ModelCostSummary>((result, row) => {
    // ★ 2026-09-24 三态桶:**已知行照加,未知行只记账、不抹掉已知部分**。
    //   旧写法「任一行 null ⇒ 合计 null」把一个**算得出来的下界**判成了「不可用」:
    //   本机 9 个模型里 6 个有价(合计 $8,723.422),只因 3 个模型无单价,
    //   模型区 KPI 就显示 `—` + 「不可用」,而同屏顶部已把同一个 $8,723.422
    //   当作「最近窗口自算成本」显示出来 ⇒ 一个量在一页里两个互斥答案。
    //   注意:**未知行绝不用 0 顶替**(那才是真正的哨兵 0),只是不进求和。
    if (row.standardCost == null) result.unknownCostModelCount += 1
    else result.standardCost = (result.standardCost ?? 0) + row.standardCost
    // ★ 逐列独立记账:`standardCost` 为 null 时 `accountCost` 未必为 null
    //   (源给了 `account_cost` 的行,见 :250-252),绝不能共用计数/共用闸门。
    if (row.accountCost == null) result.unknownAccountCostModelCount += 1
    else result.accountCost = (result.accountCost ?? 0) + row.accountCost
    if (row.costUnknown) result.costMissing = true
    // 任一行缺营收 → 合计营收不可信(cockpit 恒为 true),绝不回退 0。
    if (row.revenue == null) result.revenueMissing = true
    else result.revenue = (result.revenue ?? 0) + row.revenue
    if (row.grossProfit != null) result.grossProfit = (result.grossProfit ?? 0) + row.grossProfit
    else result.grossProfitMissing = true
    if (row.accountCostEstimated) result.estimatedModelCount += 1
    if (row.pricingMissing) result.missingPricingCount += 1
    return result
  }, {
    modelCount: rows.length,
    standardCost: 0 as number | null,
    accountCost: 0 as number | null,
    costMissing: false,
    standardCostPartial: false,
    accountCostPartial: false,
    unknownCostModelCount: 0,
    unknownAccountCostModelCount: 0,
    revenue: 0,
    grossProfit: 0,
    grossProfitMissing: false,
    grossMargin: null,
    estimatedModelCount: 0,
    missingPricingCount: 0,
    revenueMissing: false,
  })

  // ★★ 三态桶收口(2026-09-24):
  //   **全未知** ⇒ null(真算不出来,UI 显示「—」+ 不可用,这是诚实的);
  //   **部分未知** ⇒ 出**已知部分之和**,置 `costPartial` ⇒ UI 显示该数并标注「为下界」;
  //   **全已知** ⇒ 出合计。
  //   旧的 `|| summary.costMissing` 把「部分未知」也归到 null —— 那正是过度修正。
  // 每列各自判「全未知」:标准价全未知 ≠ 账号成本全未知(源可能只给了 account_cost)。
  const allStandardUnknown = rows.length > 0 && summary.unknownCostModelCount === rows.length
  const allAccountUnknown = rows.length > 0 && summary.unknownAccountCostModelCount === rows.length
  summary.standardCostPartial = summary.unknownCostModelCount > 0 && !allStandardUnknown
  summary.accountCostPartial = summary.unknownAccountCostModelCount > 0 && !allAccountUnknown
  summary.standardCost = allStandardUnknown ? null : roundedMoney(summary.standardCost ?? 0)
  // ★ 账号成本合计的「缺失」判据必须与**逐行** `accountCost` 等价(`row.accountCost == null`),
  //   不是 `costUnknown` / `costMissing`(2026-09-23 修正)。
  //   `standardCost` 逐行判据就是 `costUnknown`,所以它保留 `costMissing`;
  //   但 `accountCost` 逐行会在 `model.account_cost` 有值时**回退/取用**它(见 :250-252),
  //   于是存在 `cost: null` 但 `account_cost: 0.5` 的行 —— 明细列渲染得出真实账号成本,
  //   用 `costMissing` 当守卫会把一个**算得出来的合计**判成 null ⇒ 界面显示假「—」。
  //   2026-09-24 续:上一条只拆掉了 `|| costMissing`,但 reduce 里的
  //   「任一行 null ⇒ 整个合计 null」仍在,于是**部分未知依旧被判成 null**。
  //   与 `standardCost` 一起改成三态桶:`allCostUnknown` ⇒ null,否则出已知部分之和。
  summary.accountCost = allAccountUnknown ? null : roundedMoney(summary.accountCost ?? 0)
  summary.revenue = summary.revenueMissing ? null : roundedMoney(summary.revenue ?? 0)
  summary.grossProfitMissing = summary.grossProfitMissing || summary.revenueMissing
  summary.grossProfit = summary.grossProfitMissing ? null : roundedMoney(summary.grossProfit ?? 0)
  summary.grossMargin = summary.revenue != null && summary.revenue > 0 && summary.grossProfit != null
    ? summary.grossProfit / summary.revenue
    : null
  return summary
}

export function describeCostAccountOrigin(account: SourceAccount): string {
  return describeUpstreamOrigin(account)
}
