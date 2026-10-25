/**
 * 账号优先级(`Account.priority`)的三源诚实性契约。
 *
 * ## 病根(2026-09-20 修正)
 *
 * `Account.priority` 声明成 `number`,但**三个源里只有一个真的"有优先级"**:
 *
 * | 源 | 实际情况 | 修正前 | 渲染成 |
 * |---|---|---|---|
 * | cliproxy | CPA **无账号优先级概念** | 适配器硬编码 `priority: 0` | `0 · 最低` ← 编造 |
 * | cockpit | 账号在 `codex_local_access.json` **没有路由规则**时源没表达优先级 | `cockpitPriority(undefined)` 返回 `1` | `1 · 正常` ← 编造 |
 * | sub2api | 远程 API 实测值(1 = 正常) | 原样 | 正确 |
 *
 * 模板那一格是 `priority === 2 ? '最高' : priority === 0 ? '最低' : '正常'` ——
 * 也就是说**任何**非空数字都会被翻译成一个"我们其实不掌握"的结论。
 * 红线:源不掌握的字段必须能被 UI 显示成 `—`,绝不允许填 0/1 冒充实测。
 *
 * ## 断言口径
 *
 * 判据是「**没规则 / 没字段** ⇒ `null`」,不是「字段缺失」。
 * 所以每一组都**成对写反例**:源**确实给了**值时必须是真值,不能被一并 null 掉。
 * 只验「能通过」等于没验 —— 把 `return null` 无条件写死也能过。
 */
import { describe, expect, it } from 'vitest'
import { cockpitPlatformAccountsToAccounts, cockpitStatsToAccounts } from '../cockpitAdapter'
import { cliproxyEventsToAccounts } from '../cliproxyAdapter'
import { cliproxyAuthFilesToAccounts } from '../cliproxyManagementAdapter'
import type { CliproxyUsageEvent } from '@/api/cliproxy/cpaData'
import type { AuthFile } from '@/api/cliproxy/management'
import type { CockpitStats } from '@/api/cockpit'

const PLUS_ACCOUNT_ID = 'codex_aaaa1111bbbb2222'
const ORPHAN_ACCOUNT_ID = 'codex_dddd4444eeee5555'

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function cockpitStats(): CockpitStats {
  return {
    since: 1_756_100_000_000,
    updatedAt: 1_756_800_000_000,
    totals: {
      requestCount: 20,
      successCount: 18,
      failureCount: 2,
      clientCanceledCount: 0,
      upstreamResponseFailedCount: 0,
      streamIncompleteCount: 0,
      totalLatencyMs: 20_000,
      textRequestCount: 20,
      imageRequestCount: 0,
      imageGenerationRequestCount: 0,
      imageEditRequestCount: 0,
      imageGenerationCapabilityFailureCount: 0,
      inputTokens: 2000,
      outputTokens: 1000,
      totalTokens: 3200,
      cachedTokens: 200,
      reasoningTokens: 0,
      estimatedCostUsd: 0.04,
      updatedAt: 1_756_800_000_000,
    },
    accounts: [
      { accountId: PLUS_ACCOUNT_ID, email: 'plus1@gmail.com', usage: accountUsage() },
      { accountId: ORPHAN_ACCOUNT_ID, email: 'retired@gmail.com', usage: accountUsage() },
    ],
  }
}

function accountUsage() {
  return {
    requestCount: 10,
    successCount: 9,
    failureCount: 1,
    clientCanceledCount: 0,
    upstreamResponseFailedCount: 0,
    streamIncompleteCount: 0,
    totalLatencyMs: 10_000,
    textRequestCount: 10,
    imageRequestCount: 0,
    imageGenerationRequestCount: 0,
    imageEditRequestCount: 0,
    imageGenerationCapabilityFailureCount: 0,
    inputTokens: 1000,
    outputTokens: 500,
    totalTokens: 1600,
    cachedTokens: 100,
    reasoningTokens: 0,
    estimatedCostUsd: 0.02,
    updatedAt: 1_756_800_000_000,
  }
}

function cliproxyEvent(overrides: Partial<CliproxyUsageEvent> = {}): CliproxyUsageEvent {
  return {
    id: 1,
    requested_at: 1_756_800_000_000,
    provider: 'openai',
    executor_type: 'codex',
    model: 'gpt-6-astra',
    alias: 'gpt-6-astra',
    auth_index: 'auth-1',
    auth_type: 'oauth',
    source: 'cpa',
    reasoning_effort: 'medium',
    service_tier: 'auto',
    latency_ms: 800,
    ttft_ms: 120,
    failed: false,
    status_code: 200,
    input_tokens: 100,
    output_tokens: 50,
    reasoning_tokens: 0,
    cached_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_tokens: 150,
    primary_used_percent: null,
    primary_reset_at: null,
    primary_used_tokens: null,
    primary_remaining_tokens: null,
    primary_limit_tokens: null,
    secondary_used_percent: null,
    secondary_reset_at: null,
    secondary_used_tokens: null,
    secondary_remaining_tokens: null,
    secondary_limit_tokens: null,
    ...overrides,
  }
}

function authFile(overrides: Partial<AuthFile> = {}): AuthFile {
  return {
    id: 'af-1',
    auth_index: 'auth-1',
    name: 'acct.json',
    provider: 'openai',
    status: 'active',
    disabled: false,
    source: 'file',
    success: 0,
    failed: 0,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// cliproxy:CPA 没有优先级这个概念
// ---------------------------------------------------------------------------

describe('账号优先级 · cliproxy:源无此概念 ⇒ null,不是 0', () => {
  it('事件账号:每个账号的 priority 都是 null(此前恒为 0 ⇒ 渲染「0 · 最低」)', () => {
    const accounts = cliproxyEventsToAccounts([cliproxyEvent(), cliproxyEvent({ id: 2, auth_index: 'auth-2' })])
    expect(accounts.length).toBe(2)
    for (const account of accounts) {
      expect(account.priority).toBeNull()
    }
    // 成对反例:同一批账号里**源确实提供**的字段不得被一并 null 掉
    expect(accounts[0]!.scheduler_score).toBeNull() // 无调度评分,确实没有
    expect(accounts[0]!.last_used_at).not.toBeNull()
    expect(accounts[0]!.created_at).not.toBeNull()
  })

  it('auth-files 账号:auth-file 里没有 priority 字段 ⇒ null', () => {
    const accounts = cliproxyAuthFilesToAccounts([authFile()], [])
    expect(accounts).toHaveLength(1)
    expect(accounts[0]!.priority).toBeNull()
  })

  it('成对反例:auth-file 里**有** priority ⇒ 原样透传,不得被 null 掉', () => {
    const accounts = cliproxyAuthFilesToAccounts(
      [authFile({ priority: 3 }), authFile({ id: 'af-2', auth_index: 'auth-2', priority: 0 })],
      [],
    )
    expect(accounts[0]!.priority).toBe(3)
    // 源**明确给了 0** —— 这才是真正的「最低」,必须保留 0(不能把"真 0"也说成未知)
    expect(accounts[1]!.priority).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// cockpit:没有路由规则 = 源没表达优先级
// ---------------------------------------------------------------------------

describe('账号优先级 · cockpit:无路由规则 ⇒ null,不是 1(「正常」)', () => {
  it('完全不传 routingRules ⇒ 每个账号 priority 都是 null(此前返回 1 ⇒ 渲染「1 · 正常」)', () => {
    const accounts = cockpitStatsToAccounts(cockpitStats())
    expect(accounts.length).toBe(2)
    for (const account of accounts) {
      expect(account.priority).toBeNull()
    }
  })

  it('传了 routingRules 但没覆盖某账号 ⇒ 该账号仍是 null(不落到「正常」)', () => {
    const accounts = cockpitStatsToAccounts(cockpitStats(), new Map(), undefined, [
      { accountId: PLUS_ACCOUNT_ID, priority: 0, weight: 1, isPreferred: true },
    ])
    expect(accounts.find((a) => a.name === 'plus1@gmail.com')!.priority).toBe(2)
    expect(accounts.find((a) => a.name === 'retired@gmail.com')!.priority).toBeNull()
  })

  it('成对反例:规则存在时按实测语义映射 —— isPreferred→2 / isBackup→0 / 显式>0→2 / 显式<0→0', () => {
    const accounts = cockpitStatsToAccounts(cockpitStats(), new Map(), undefined, [
      { accountId: PLUS_ACCOUNT_ID, priority: 0, weight: 1, isBackup: true },
      { accountId: ORPHAN_ACCOUNT_ID, priority: 5, weight: 1 },
    ])
    expect(accounts.find((a) => a.name === 'plus1@gmail.com')!.priority).toBe(0)
    expect(accounts.find((a) => a.name === 'retired@gmail.com')!.priority).toBe(2)
  })

  it('成对反例:规则存在且未表达偏好(priority=0 且无 isPreferred/isBackup)⇒ 1 是**实测结论**,必须保留', () => {
    const accounts = cockpitStatsToAccounts(cockpitStats(), new Map(), undefined, [
      { accountId: PLUS_ACCOUNT_ID, priority: 0, weight: 1 },
    ])
    expect(accounts.find((a) => a.name === 'plus1@gmail.com')!.priority).toBe(1)
  })

  it('平台账号(gemini/antigravity/claude)那条路径也不得填 1 —— 该函数根本不接收 routingRules', () => {
    // 这是**同一批账号**的另一条构造路径(cockpitPlatformAccountsToAccounts),
    // 由 useCostCenterData 并入同一张上游表。它此前硬编码 `priority: 1`,
    // 而"非 codex 平台账号"同样没有优先级概念 ⇒ 渲染「1 · 正常」是编造。
    // 变异检查:把 cockpitAdapter 里这条路径的 `priority: null` 改回 1,本断言必须失败。
    const accounts = cockpitPlatformAccountsToAccounts([
      { id: 'gemini-1', email: 'g@example.com', platform: 'gemini' },
      { id: 'antigravity-1', email: 'a@example.com', platform: 'antigravity' },
    ])
    expect(accounts).toHaveLength(2)
    for (const account of accounts) {
      expect(account.priority).toBeNull()
    }
    // 成对反例:同一批账号里**源确实提供**的字段不得被一并 null 掉
    expect(accounts[0]!.name).toBe('g@example.com')
    expect(accounts[0]!.platform).toBe('gemini')
  })
})
