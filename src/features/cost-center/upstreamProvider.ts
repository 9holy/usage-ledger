import { costDataText } from './costDataText'
import type { SourceAccount as Account } from './sourceTypes'

export type UpstreamProviderKey =
  | 'codex'
  | 'openai'
  | 'deepseek'
  | 'anthropic'
  | 'gemini'
  | 'antigravity'
  | 'grok'
  | 'azure-openai'
  | 'mistral'
  | 'groq'
  | 'together'
  | 'fireworks'
  | 'cohere'
  | 'perplexity'
  | 'zai'
  | 'moonshot'
  | 'minimax'
  | 'alibaba'
  | 'sensenova'
  | 'siliconflow'
  | 'openrouter'
  | 'volcengine'
  | 'bedrock'
  | 'relay'
  | 'other'

export type UpstreamProviderFilter = 'all' | UpstreamProviderKey

export interface UpstreamProviderTab {
  key: UpstreamProviderFilter
  label: string
  count: number
}

export const providerOrder: UpstreamProviderKey[] = [
  'codex',
  'openai',
  'deepseek',
  'anthropic',
  'gemini',
  'antigravity',
  'grok',
  'azure-openai',
  'mistral',
  'groq',
  'together',
  'fireworks',
  'cohere',
  'perplexity',
  'zai',
  'moonshot',
  'minimax',
  'alibaba',
  'sensenova',
  'siliconflow',
  'openrouter',
  'volcengine',
  'bedrock',
  'relay',
  'other',
]

export const providerLabels: Record<UpstreamProviderKey, string> = {
  codex: 'Codex',
  get openai() { return costDataText('officialOpenai') },
  get deepseek() { return costDataText('officialDeepseek') },
  get anthropic() { return costDataText('officialClaude') },
  get gemini() { return costDataText('officialGemini') },
  antigravity: 'Antigravity',
  get grok() { return costDataText('officialGrok') },
  'azure-openai': 'Azure OpenAI',
  get mistral() { return costDataText('officialMistral') },
  groq: 'Groq',
  together: 'Together AI',
  fireworks: 'Fireworks AI',
  get cohere() { return costDataText('officialCohere') },
  get perplexity() { return costDataText('officialPerplexity') },
  get zai() { return costDataText('zhipuZAi') },
  moonshot: 'Moonshot / Kimi',
  get minimax() { return costDataText('officialMinimax') },
  get alibaba() { return costDataText('alibabaCloudModelStudio') },
  get sensenova() { return costDataText('sensenova2') },
  get siliconflow() { return costDataText('siliconflow') },
  openrouter: 'OpenRouter',
  get volcengine() { return costDataText('volcengineArk') },
  bedrock: 'AWS Bedrock',
  get relay() { return costDataText('apiRelay') },
  get other() { return costDataText('other') },
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function accountUpstreamBaseUrl(account: Account): string {
  if (account.custom_base_url_enabled === true) {
    const customBaseUrl = readString(account.custom_base_url)
    if (customBaseUrl) return customBaseUrl
  }
  return readString(account.credentials?.base_url)
}

function parseHostname(baseUrl: string): string {
  if (!baseUrl) return ''
  try {
    return new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function isGoogleOfficialHost(host: string): boolean {
  return host === 'generativelanguage.googleapis.com'
    || host === 'aiplatform.googleapis.com'
    || host.endsWith('-aiplatform.googleapis.com')
    || host === 'cloudcode-pa.googleapis.com'
}

function providerFromOfficialHost(host: string): UpstreamProviderKey | null {
  if (host === 'api.deepseek.com') return 'deepseek'
  if (host === 'api.openai.com') return 'openai'
  if (host === 'api.anthropic.com') return 'anthropic'
  if (host === 'api.x.ai' || host.endsWith('.api.x.ai')) return 'grok'
  if (isGoogleOfficialHost(host)) return 'gemini'
  if (host.endsWith('.openai.azure.com')) return 'azure-openai'
  if (host === 'api.mistral.ai') return 'mistral'
  if (host === 'api.groq.com') return 'groq'
  if (host === 'api.together.xyz') return 'together'
  if (host === 'api.fireworks.ai') return 'fireworks'
  if (host === 'api.cohere.com' || host === 'api.cohere.ai') return 'cohere'
  if (host === 'api.perplexity.ai') return 'perplexity'
  if (host === 'api.z.ai' || host === 'open.bigmodel.cn') return 'zai'
  if (host === 'api.moonshot.cn' || host === 'api.moonshot.ai') return 'moonshot'
  if (host === 'api.minimax.chat' || host === 'api.minimax.io') return 'minimax'
  if (host === 'dashscope.aliyuncs.com' || host === 'dashscope-intl.aliyuncs.com') return 'alibaba'
  if (host === 'api.siliconflow.cn' || host === 'api.siliconflow.com') return 'siliconflow'
  if (host === 'openrouter.ai') return 'openrouter'
  if (host.endsWith('.volces.com')) return 'volcengine'
  return null
}

export function classifyUpstreamProvider(account: Account): UpstreamProviderKey {
  if (account.type === 'bedrock') return 'bedrock'

  const baseUrl = accountUpstreamBaseUrl(account)
  const host = parseHostname(baseUrl)
  const providerFromHost = providerFromOfficialHost(host)
  if (providerFromHost) return providerFromHost

  // A configured non-official endpoint is a relay even when it reuses the
  // OpenAI/Anthropic protocol. This distinction is important for cost truth.
  if (baseUrl) return 'relay'
  if (account.type === 'upstream') return 'relay'

  if (account.platform === 'openai') {
    return account.type === 'oauth' || account.type === 'setup-token' ? 'codex' : 'openai'
  }
  if (account.platform === 'anthropic') return 'anthropic'
  if (account.platform === 'gemini') return 'gemini'
  if (account.platform === 'antigravity') return 'antigravity'
  if (account.platform === 'grok') return 'grok'
  if (account.platform === 'sensenova') return 'sensenova'
  if (account.platform === 'zai') return 'zai'
  if (account.platform === 'deepseek') return 'deepseek'
  if (account.platform === 'moonshot') return 'moonshot'
  if (account.platform === 'minimax') return 'minimax'
  if (account.platform === 'dashscope') return 'alibaba'
  if (account.platform === 'volcengine') return 'volcengine'
  return 'other'
}

export function matchesUpstreamProvider(account: Account, filter: UpstreamProviderFilter): boolean {
  return filter === 'all' || classifyUpstreamProvider(account) === filter
}

export function buildUpstreamProviderTabs(accounts: Account[]): UpstreamProviderTab[] {
  const counts = new Map<UpstreamProviderKey, number>()
  for (const account of accounts) {
    const key = classifyUpstreamProvider(account)
    counts.set(key, (counts.get(key) || 0) + 1)
  }

  return [
    { key: 'all', label: costDataText('all'), count: accounts.length },
    ...providerOrder
      .filter((key) => (counts.get(key) || 0) > 0)
      .map((key) => ({ key, label: providerLabels[key], count: counts.get(key) || 0 })),
  ]
}

// The cost pool covers every configured upstream account. Keep these named
// entry points separate from the ranking table so the pool cannot regress to
// a hand-written list of selected vendors again.
export function buildAccountPoolProviderTabs(accounts: Account[]): UpstreamProviderTab[] {
  return buildUpstreamProviderTabs(accounts)
}

export function matchesAccountPoolProvider(account: Account, filter: UpstreamProviderFilter): boolean {
  return matchesUpstreamProvider(account, filter)
}

export function describeUpstreamOrigin(account: Account): string {
  const provider = classifyUpstreamProvider(account)
  // 中转账号统一显示"上游 API"(不带 host):账号名已区分渠道,host 冗余。
  // 影响 sub2api+cockpit 所有中转账号,统一口径。
  if (provider === 'relay') return costDataText('upstreamApi')
  if (provider === 'codex') return 'Codex OAuth'
  if (provider === 'other') return `${account.platform} · ${account.type}`
  return providerLabels[provider]
}
