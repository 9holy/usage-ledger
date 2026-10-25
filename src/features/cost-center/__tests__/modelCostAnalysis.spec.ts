import './costDataI18n'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  aggregateModelStatsFromUsageLogs,
  accountCostSnapshot,
  buildModelCostRows,
  classifyModelProvider,
  summarizeModelAudit,
  summarizeModelCosts,
  sumTokenCounts,
} from '../modelCostAnalysis'

describe('model cost analysis', () => {
  it('propagates unknown token counts without changing real zero counts', () => {
    expect(sumTokenCounts(0, 0)).toBe(0)
    expect(sumTokenCounts(2, 3)).toBe(5)
    expect(sumTokenCounts(2, null)).toBeNull()
    expect(sumTokenCounts(2, undefined)).toBeNull()
    expect(sumTokenCounts(2, Number.NaN)).toBeNull()
  })

  it.each(['input_tokens', 'output_tokens', 'cache_creation_tokens', 'cache_read_tokens'] as const)('does not invent a model token total when %s is unknown', (field) => {
    const known = {
      id: 1, model: 'fixture', input_tokens: 10, output_tokens: 20, cache_creation_tokens: 3, cache_read_tokens: 4,
      total_cost: 0, actual_cost: 0, created_at: '2026-08-07T08:00:00.000Z',
    }
    const [aggregate] = aggregateModelStatsFromUsageLogs([known, { ...known, id: 2, [field]: null }] as any, 'requested')
    expect(aggregate.total_tokens).toBeNull()
    expect(aggregate[field]).toBeNull()
    const [row] = buildModelCostRows([aggregate])
    expect(row.total_tokens).toBeNull()
    expect(row[field]).toBeNull()
    expect(row.standardCost).toBe(0)
    expect(row.revenue).toBe(0)
  })

  it('does not label a known zero reference price as missing', () => {
    const [row] = buildModelCostRows([{ model: 'public-beta', requests: 1, input_tokens: 100, output_tokens: 20, cache_creation_tokens: 0, cache_read_tokens: 80, total_tokens: 120, cost: 0, account_cost: 0, actual_cost: null }])
    expect(row.pricingMissing).toBe(false)
    expect(row.standardCost).toBe(0)
    expect(row.revenue).toBeNull()
  })
  it('applies account rate to the pre-multiplier stats snapshot, matching official aggregation SQL', () => {
    expect(accountCostSnapshot({ account_stats_cost: 2, total_cost: 4, account_rate_multiplier: 0.5 })).toBe(1)
    expect(accountCostSnapshot({ account_stats_cost: 2, total_cost: 4, account_rate_multiplier: 0 })).toBe(0)
    expect(accountCostSnapshot({ account_stats_cost: 2, total_cost: 4, account_rate_multiplier: null })).toBe(2)
    expect(accountCostSnapshot({ account_stats_cost: null, total_cost: 4, account_rate_multiplier: 0.5 })).toBe(2)
  })
  it('separates official standard cost, upstream account cost, revenue and gross profit', () => {
    const rows = buildModelCostRows([
      {
        model: 'deepseek-v4-pro',
        requests: 2,
        input_tokens: 1_000_000,
        output_tokens: 500_000,
        cache_creation_tokens: 0,
        cache_read_tokens: 250_000,
        total_tokens: 1_750_000,
        cost: 0.87090625,
        account_cost: 0.435453125,
        actual_cost: 1.2,
      },
    ])

    expect(rows[0]).toMatchObject({
      provider: 'DeepSeek',
      standardCost: 0.87090625,
      accountCost: 0.435453125,
      revenue: 1.2,
      grossProfit: 0.764546875,
    })
    expect(rows[0].grossMargin).toBeCloseTo(0.6371223958)
  })

  it('falls back to standard cost for legacy records without an account-cost snapshot', () => {
    const rows = buildModelCostRows([{ model: 'custom-relay-model', cost: 0.2, actual_cost: 0.3 } as any])
    expect(rows[0].accountCost).toBe(0.2)
    expect(rows[0].accountCostEstimated).toBe(true)
  })

  it('summarizes every visible model', () => {
    const rows = buildModelCostRows([
      { model: 'deepseek-v4-flash', cost: 0.14, account_cost: 0.1, actual_cost: 0.2 } as any,
      { model: 'gpt-5.4', cost: 1, account_cost: 0.8, actual_cost: 1.4 } as any,
    ])
    expect(summarizeModelCosts(rows)).toMatchObject({
      standardCost: 1.14,
      accountCost: 0.9,
      revenue: 1.6,
      grossProfit: 0.7,
    })
  })

  it('rebuilds an exact-window model aggregate from real usage logs', () => {
    const logs = [
      {
        model: 'deepseek-chat', upstream_model: 'deepseek-v4-flash',
        input_tokens: 10, output_tokens: 20, cache_creation_tokens: 0, cache_read_tokens: 5,
        total_cost: 0.1, actual_cost: 0.2, account_stats_cost: 0.08, account_rate_multiplier: 1,
        created_at: '2026-08-07T07:01:00.000Z',
      },
      {
        model: 'deepseek-chat', upstream_model: 'deepseek-v4-flash',
        input_tokens: 30, output_tokens: 40, cache_creation_tokens: 0, cache_read_tokens: 10,
        total_cost: 0.3, actual_cost: 0.5, account_stats_cost: 0.24, account_rate_multiplier: 1,
        created_at: '2026-08-07T07:09:00.000Z',
      },
    ] as any

    expect(aggregateModelStatsFromUsageLogs(logs, 'upstream')).toEqual([expect.objectContaining({
      model: 'deepseek-v4-flash',
      requests: 2,
      input_tokens: 40,
      output_tokens: 60,
      cache_read_tokens: 15,
      cost: 0.4,
      actual_cost: 0.7,
      account_cost: 0.32,
      first_seen: '2026-08-07T07:01:00.000Z',
      last_seen: '2026-08-07T07:09:00.000Z',
    })])
  })

  it('groups audited costs by the model declared in the upstream response without repricing the log', () => {
    const logs = [{
      model: 'deepseek-chat',
      upstream_model: 'deepseek-v4-pro',
      upstream_response_model: 'deepseek-v4-flash',
      upstream_model_mismatch: true,
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_cost: 0.25,
      actual_cost: 0.5,
      account_stats_cost: 0.2,
      created_at: '2026-08-07T08:00:00.000Z',
    }] as any

    expect(aggregateModelStatsFromUsageLogs(logs, 'response')).toEqual([
      expect.objectContaining({
        model: 'deepseek-v4-flash',
        cost: 0.25,
        account_cost: 0.2,
        actual_cost: 0.5,
      }),
    ])
  })

  it('keeps a missing response declaration unknown instead of reporting the sent model as a response', () => {
    const logs = [null, undefined, ' '].map((response, index) => ({
      id: index + 1, model: 'requested', upstream_model: 'sent', upstream_response_model: response,
      total_cost: 0.25, actual_cost: 0.5, created_at: '2026-08-07T08:00:00.000Z',
    })) as any

    expect(aggregateModelStatsFromUsageLogs(logs, 'response')).toEqual([
      expect.objectContaining({ model: '未知响应模型', requests: 3, cost: 0.75, actual_cost: 1.5 }),
    ])
    expect(aggregateModelStatsFromUsageLogs(logs, 'upstream')[0].model).toBe('sent')
    expect(aggregateModelStatsFromUsageLogs(logs, 'requested')[0].model).toBe('requested')
  })

  it('summarizes matched, mismatched and unobserved upstream model declarations without losing cost snapshots', () => {
    const logs = [
      {
        upstream_model_mismatch: false,
        total_cost: 0.1,
        account_stats_cost: 0.08,
        actual_cost: 0.2,
      },
      {
        upstream_model_mismatch: true,
        total_cost: 0.3,
        account_stats_cost: 0.24,
        actual_cost: 0.5,
      },
      {
        upstream_model_mismatch: null,
        total_cost: 0.4,
        account_stats_cost: 0.32,
        actual_cost: 0.6,
      },
    ] as any

    expect(summarizeModelAudit(logs)).toEqual({
      totalRequests: 3,
      observedRequests: 2,
      matchedRequests: 1,
      mismatchRequests: 1,
      unobservedRequests: 1,
      mismatchRate: 0.5,
      mismatchStandardCost: 0.3,
      mismatchAccountCost: 0.24,
      mismatchRevenue: 0.5,
    })
  })

  it.each([
    ['deepseek-v4-pro', 'DeepSeek'],
    ['gpt-5.4', 'OpenAI'],
    ['claude-sonnet-4-5', 'Anthropic'],
    ['gemini-3-pro', 'Google'],
    ['grok-4', 'xAI'],
    ['mistral-large-latest', 'Mistral'],
    ['meta-llama/llama-4-maverick', 'Meta / Llama'],
    ['qwen3.5-plus', 'Alibaba / Qwen'],
    ['glm-5', 'Z.ai / GLM'],
    ['kimi-k2.5', 'Moonshot / Kimi'],
    ['minimax-m2.1', 'MiniMax'],
    ['command-r-plus', 'Cohere'],
    ['sonar-pro', 'Perplexity'],
    ['relay/private-model', '其他/中转'],
  ])('classifies %s as %s', (model, provider) => {
    expect(classifyModelProvider(model)).toBe(provider)
  })
})

/**
 * 毛利**合计**的缺失判据(2026-09-22)。
 *
 * `summarizeModelCosts` 此前只用 `revenueMissing` 当守卫,而逐行毛利是
 * `revenue == null || accountCost == null ? null : revenue - accountCost`。
 * `revenue` 有值但 `accountCost` 为 null 的行同样算不出毛利,却既不置 `revenueMissing`
 * 也不报错 —— reduce 里被**跳过**,于是汇总报出一个**部分和**(全是这种行时是初值 `0`),
 * 而同屏明细行那一列此时显示的是「—」:同一个「毛利」两处自相矛盾。
 *
 * 注意别把判据换成 `costMissing`:见第三条 —— `cost` 未知但源给了 `account_cost` 的行
 * 毛利是**算得出来的**,用 costMissing 会造出一个假「—」。
 *
 * 输入是 `ModelStat` 字面量:被验的是 `summarizeModelCosts` 的契约,而
 * `ModelStat.cost` / `actual_cost` 的 `| null` 正是类型显式允许的组合(见 `types/index.ts` 注释)。
 */
describe('model cost summary · 毛利合计的缺失判据', () => {
  it('★ 有营收但缺账号成本 ⇒ 毛利合计为 null(不是 0,也不是部分和)', () => {
    const rows = buildModelCostRows([
      { model: 'gpt-6-astra', cost: null, actual_cost: 1.2, total_tokens: 1_000 } as any,
    ])
    const summary = summarizeModelCosts(rows)

    expect(rows[0].revenue).toBe(1.2)
    expect(rows[0].accountCost).toBeNull()
    expect(rows[0].grossProfit).toBeNull()

    expect(summary.revenueMissing).toBe(false) // 营收是有的 —— 所以旧的守卫放行了
    expect(summary.revenue).toBe(1.2)
    expect(summary.grossProfitMissing).toBe(true)
    expect(summary.grossProfit).toBeNull()
    expect(summary.grossMargin).toBeNull()
  })

  it('★ 一好一坏两行 ⇒ 合计是 null,而不是「好的那一行」的部分和', () => {
    const rows = buildModelCostRows([
      { model: 'gpt-6-astra', cost: 0.4, account_cost: 0.4, actual_cost: 1.2, total_tokens: 1_000 } as any,
      { model: 'gpt-6-astra', cost: null, actual_cost: 0.8, total_tokens: 1_000 } as any,
    ])
    const summary = summarizeModelCosts(rows)
    const good = rows.find((row) => row.grossProfit != null)!.grossProfit!
    expect(good).toBeCloseTo(0.8, 9)

    expect(summary.grossProfitMissing).toBe(true)
    expect(summary.grossProfit).toBeNull()
    // 判别力:修复前这里恰好等于 good —— 所以这一条要**明确否掉那个值**。
    expect(summary.grossProfit).not.toBe(good)
  })

  it('成对反例:cost 未知但源给了 account_cost ⇒ 毛利仍算得出来,不得误判成不可用', () => {
    const rows = buildModelCostRows([
      { model: 'custom-relay-model', cost: null, account_cost: 0.5, actual_cost: 1.2, total_tokens: 1_000 } as any,
    ])
    const summary = summarizeModelCosts(rows)
    expect(rows[0].costUnknown).toBe(true)
    expect(rows[0].grossProfit).toBeCloseTo(0.7, 9)
    expect(summary.costMissing).toBe(true)
    // 用 costMissing 当守卫就会在这里造出假「—」。
    expect(summary.grossProfitMissing).toBe(false)
    expect(summary.grossProfit).toBeCloseTo(0.7, 9)
  })

  it('成对反例:每行都算得出 ⇒ 合计是各行之和', () => {
    const rows = buildModelCostRows([
      { model: 'gpt-6-astra', cost: 0.4, account_cost: 0.4, actual_cost: 1.2, total_tokens: 1_000 } as any,
      { model: 'gpt-6-astra', cost: 0.3, account_cost: 0.3, actual_cost: 0.9, total_tokens: 1_000 } as any,
    ])
    const summary = summarizeModelCosts(rows)
    expect(summary.grossProfitMissing).toBe(false)
    expect(summary.grossProfit).toBeCloseTo(1.4, 9)
  })
})

/**
 * 账号成本**合计**的缺失判据(2026-09-23)。
 *
 * 逐行 `accountCost` 在 `model.account_cost` 是有限数时**取用它**(见 :250-252),
 * 于是存在 `cost: null`(⇒ `costUnknown`)但 `account_cost` 有值的行 —— 明细列渲染得出
 * 真实账号成本。而旧代码 `summary.accountCost = summary.costMissing || ...` 用 `costMissing`
 * (等价于 `costUnknown`)当守卫,把这种**算得出来的合计**判成 null ⇒ 界面显示假「—」。
 * 判据必须与逐行等价:`row.accountCost == null`。
 */
describe('model cost summary · 账号成本合计的缺失判据', () => {
  it('★ cost 未知但源给了 account_cost ⇒ 合计取该值(不是 null),且与明细一致', () => {
    const rows = buildModelCostRows([
      { model: 'custom-relay-model', cost: null, account_cost: 0.5, total_tokens: 1_000 } as any,
    ])
    const summary = summarizeModelCosts(rows)

    // 明细列渲染出的真实账号成本。
    expect(rows[0].costUnknown).toBe(true)
    expect(rows[0].accountCost).toBe(0.5)
    // 明细与合计必须一致:合计不得是假「—」。
    expect(summary.costMissing).toBe(true) // standardCost 那一列确实未知,保留
    expect(summary.accountCost).toBe(0.5)
    expect(summary.accountCost).not.toBeNull()
  })

  it('成对反例:cost 未知且源**没有** account_cost ⇒ 合计必须 null(不得变 0)', () => {
    const rows = buildModelCostRows([
      { model: 'custom-relay-model', cost: null, total_tokens: 1_000 } as any,
    ])
    const summary = summarizeModelCosts(rows)

    expect(rows[0].accountCost).toBeNull()
    expect(summary.accountCost).toBeNull()
    expect(summary.accountCost).not.toBe(0)
  })
})

/**
 * ★ 三态桶:合计不得因「**部分**未知」被压成 null(2026-09-24)
 *
 * 病根:旧 reduce 是「任一行 null ⇒ 整个合计 null」,于是本机 9 个模型里 6 个有价
 * (合计 $8,723.422,正是面板顶部「最近窗口自算成本」显示的值),只因 3 个模型无单价,
 * 模型区 KPI 就显示 `—` + 「不可用」+「成本未知 · 无单价且数据源无估算」
 * ⇒ **同一个量在一页里给出两个互斥答案**。
 *
 * 正确判据(与项目红线一致):
 *   全未知 ⇒ null(真算不出来);部分未知 ⇒ **已知部分之和**(真实下界)+ 展示层标注;
 *   全已知 ⇒ 合计。
 */
describe('model cost summary · 三态桶(部分未知 ⇒ 下界,不是 null)', () => {
  it('★ 部分未知 ⇒ 合计 = 已知部分之和,且 standardCostPartial 为真', () => {
    const rows = buildModelCostRows([
      { model: 'gpt-6-astra', cost: 4467.164213, total_tokens: 2_556_368_679 } as any,
      { model: 'gpt-5.6-sol', cost: 4199.148709, total_tokens: 5_673_704_223 } as any,
      { model: 'gpt-image-2', cost: null, total_tokens: 3_359 } as any,
    ])
    const summary = summarizeModelCosts(rows)

    // 已知部分必须照加出来,不得因为有一行未知就整体变 null。
    expect(summary.standardCost).not.toBeNull()
    expect(summary.standardCost).toBeCloseTo(8666.312922, 4)
    // 下界信号:界面据此降 partial 并标「N 个模型无单价 · 合计为下界」。
    expect(summary.standardCostPartial).toBe(true)
    expect(summary.unknownCostModelCount).toBe(1)
    expect(summary.costMissing).toBe(true) // 保留:至少一行未知(供文案使用)
  })

  it('成对反例:全未知 ⇒ 合计必须 null(不得变 0,也不得标下界)', () => {
    const rows = buildModelCostRows([
      { model: 'a', cost: null, total_tokens: 10 } as any,
      { model: 'b', cost: null, total_tokens: 20 } as any,
    ])
    const summary = summarizeModelCosts(rows)

    expect(summary.standardCost).toBeNull()
    expect(summary.standardCost).not.toBe(0)
    // 全未知是「不可计算」,不是「下界」—— 两者语义不同,不能都标 partial。
    expect(summary.standardCostPartial).toBe(false)
  })

  it('成对反例:全已知 ⇒ 合计 = 各行之和,partial 为 false', () => {
    const rows = buildModelCostRows([
      { model: 'a', cost: 0.4, total_tokens: 10 } as any,
      { model: 'b', cost: 0.6, total_tokens: 20 } as any,
    ])
    const summary = summarizeModelCosts(rows)

    expect(summary.standardCost).toBeCloseTo(1.0, 9)
    expect(summary.standardCostPartial).toBe(false)
    expect(summary.unknownCostModelCount).toBe(0)
  })

  it('★ 逐列独立判据:standardCost 全未知而 accountCost 已知 ⇒ 两列给出不同答案', () => {
    const rows = buildModelCostRows([
      { model: 'a', cost: null, account_cost: 0.5, total_tokens: 10 } as any,
    ])
    const summary = summarizeModelCosts(rows)

    // 同一行:标准价算不出来、账号成本算得出来 ⇒ 不能用一把闸门把两列一起打成 null。
    expect(summary.standardCost).toBeNull()
    expect(summary.accountCost).toBe(0.5)
    expect(summary.standardCostPartial).toBe(false) // 全未知 ⇒ 不标下界
    expect(summary.accountCostPartial).toBe(false) // 全已知 ⇒ 不标下界
  })

  it('★ 逐列独立判据(反向):部分行有 account_cost ⇒ 账号成本是下界', () => {
    const rows = buildModelCostRows([
      { model: 'a', cost: null, account_cost: 0.5, total_tokens: 10 } as any,
      { model: 'b', cost: null, total_tokens: 20 } as any,
    ])
    const summary = summarizeModelCosts(rows)

    expect(summary.standardCost).toBeNull()
    expect(summary.accountCost).toBe(0.5)
    expect(summary.accountCostPartial).toBe(true)
    expect(summary.unknownAccountCostModelCount).toBe(1)
    // ★ 计数不得串列:标准价未知 2 行、账号成本未知 1 行。
    expect(summary.unknownCostModelCount).toBe(2)
  })
})

/**
 * 视图**接线**守卫:上面那些字段必须真的被 KPI 用上。
 *
 * 纯函数测试挡得住「算法算错」,挡不住「视图退回旧的 `costMissing ||` 闸门」
 * —— 那正是本项目反复出现的「修一处、漏一处」。
 */
describe('model cost summary · 视图接线(不得回到「任一行未知 ⇒ 合计 null」)', () => {
  const viewPath = resolve(process.cwd(), 'src/views/admin/CostCenterView.vue')
  const source = readFileSync(viewPath, 'utf-8')

  it('扫描面非空:确实读到了视图源码', () => {
    expect(source.length).toBeGreaterThan(10_000)
    expect(source).toContain('modelCostSummary')
  })

  it('★ KPI 不得再用 costMissing 把合计打成不可用', () => {
    expect(source).not.toContain('modelCostSummary.costMissing || modelCostSummary.standardCost == null')
    expect(source).not.toContain('modelCostSummary.costMissing || modelCostSummary.accountCost == null')
  })

  it('★ 两列各自接上自己的下界信号(不得串列)', () => {
    // ★★ 存在性断言在这里**不够**:`accountCostPartial` 在同一行里出现 2 次
    //   (`:note` 一处 + `:state` 一处),变异只改其中一处时「存在」依旧成立 ⇒ 断言恒绿。
    //   必须按**格**钉:标准价格只能用标准价的下界信号,账号成本格只能用账号成本的。
    const lines = source.split('\n')
    const stdLines = lines.filter((l) => l.includes('modelCostSummary.standardCost == null ?'))
    const acctLines = lines.filter((l) => l.includes('modelCostSummary.accountCost == null ?'))
    // 扫描面非空:两格都得找得到,否则下面的断言是在空数组上恒真(0 次循环)。
    expect(stdLines.length, '必须找得到标准价格那一行').toBeGreaterThan(0)
    expect(acctLines.length, '必须找得到账号成本那一行').toBeGreaterThan(0)

    for (const line of stdLines) {
      expect(line, '标准价格必须用 standardCostPartial').toContain('modelCostSummary.standardCostPartial')
      expect(line, '标准价格不得串用账号成本的下界信号').not.toContain('modelCostSummary.accountCostPartial')
    }
    for (const line of acctLines) {
      expect(line, '账号成本格必须用 accountCostPartial').toContain('modelCostSummary.accountCostPartial')
      expect(line, '账号成本格不得串用标准价的下界信号').not.toContain('modelCostSummary.standardCostPartial')
    }

    // 计数用的未知模型数同样不得串列。
    expect(source).toContain('modelCostSummary.unknownCostModelCount')
    expect(source).toContain('modelCostSummary.unknownAccountCostModelCount')
  })
})
