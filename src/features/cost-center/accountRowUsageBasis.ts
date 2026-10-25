import { costDataText } from './costDataText'
import type { AccountWindowUsage } from './model'

/** 上游排行表一行的两种用量取值:观察窗口(window)与自然日(today)。 */
export interface AccountUsageStatsPair {
  today: AccountWindowUsage | null
  window: AccountWindowUsage | null
}

/** 一行用量数值的**实际口径**。
 *  - `'window'`:数值来自所选观察窗口的逐账号源;
 *  - `'today'`:所选窗口没有该账号的记录,已回退到**本机自然日**;
 *  - `'none'`:两个源都没有 ⇒ 无数据(界面显示「无数据」,绝不是 0)。 */
export type UsageBasis = 'window' | 'today' | 'none'

/**
 * 该行应当显示的用量对象。
 *
 * `rangeWindowAuthoritative` 为真表示**本次加载确实请求过逐账号窗口源**(sub2api 的 7d/30d、
 * cliproxy)—— 此时窗口源缺失就是"该窗口无数据",**不得**回退自然日:
 * 那会把「今日」的数显示在「最近 7 天 / 最近 1 个月」的格子里(窗口口径不符)。
 */
export function resolveUsageStatsFor(
  row: AccountUsageStatsPair,
  rangeWindowAuthoritative: boolean,
): AccountWindowUsage | null {
  if (row.window) return row.window
  if (rangeWindowAuthoritative) return null
  return row.today
}

/**
 * 该行数值的实际口径(与 `usageStatsFor` **逐字对齐** —— 它就是 `usageStatsFor` 返回值的来源,
 * 两套判据一旦分叉,标注就会与数值脱节)。
 *
 * ★★ 2026-09-26(第七轮):此前视图用**整表**粒度的 `usesRangeWindow`
 *    (`accountLedgers.some(row => row.window != null)`)决定要不要标「（本机自然日）」。
 *    但回退是**逐账号**的 —— A 账号在窗口内有记录、B 账号没有,B 就会回退自然日。
 *    ⇒ 只要**有一行**拿到窗口数据,整表的标注就全部消失,于是「最近 1 小时」的列头下
 *    躺着今日的数,用户却看不到任何提示。**判据粒度必须与回退粒度一致。**
 */
export function resolveUsageBasis(
  row: AccountUsageStatsPair,
  rangeWindowAuthoritative: boolean,
): UsageBasis {
  if (row.window) return 'window'
  if (rangeWindowAuthoritative) return 'none'
  return row.today ? 'today' : 'none'
}

/** 逐行口径后缀:该行数值实际来自自然日时显式标出(与表头的窗口名并用,不取代表头)。 */
export function resolveRowUsageSuffix(
  row: AccountUsageStatsPair,
  rangeWindowAuthoritative: boolean,
): string {
  return resolveUsageBasis(row, rangeWindowAuthoritative) === 'today' ? costDataText('localCalendarDay') : ''
}
