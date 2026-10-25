/**
 * cockpit 套餐名 → 徽章 class。
 *
 * 为什么要归一化：cockpit 各渠道的套餐名大小写/分隔符不统一
 * （`plus` / `API_KEY` / `K12` / `Kiro Pro` / `Google AI Pro` …），
 * 直接 `plan-${name.toLowerCase()}` 会漏掉既有的 `.plan-API_KEY`（大写）规则，
 * 并把带空格的值拼成多个垃圾类名。
 *
 * 未知一律落 `plan-unknown`（中性 muted）——**绝不为好看套正向强调色**。
 *
 * 依据（cockpit 源码，只读）：`crates/cockpit-core/src/models/` 各渠道套餐字段
 * 大小写并不统一——codex `plan_type` 实测有 `plus` / `pro` / `team` / `free` /
 * `API_KEY` / `self_serve_business_prolite`；gemini `plan_name` 是自由文本
 * （如 `Gemini Code Assist in Google One AI Pro`）。所以归一化必须显式白名单，
 * 不能靠 `toLowerCase()` 想当然。
 */
export function planBadgeClass(plan: string | null | undefined): string {
  // 归一化：去首尾空白 → 小写 → 去掉所有空白/下划线/连字符。
  // `API_KEY` / `api-key` / `api key` 都归一到 `apikey`。
  const key = (plan ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (key === 'plus') return 'plan-plus'
  if (key === 'team') return 'plan-team'
  if (key === 'apikey') return 'plan-API_KEY' // 复用既有的大写类名，不要改 CSS
  if (key === 'k12') return 'plan-k12'
  return 'plan-unknown'
}
