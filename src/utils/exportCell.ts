/**
 * 导出单元格:成本值。
 *
 * 源不掌握成本(该行 `null`)时必须导出**空单元格**,不能导出 `0.000000` ——
 * 导出文件会被保存、转发、二次统计,脱离页面「无数据」文案的语境,
 * 表里一个 `0.000000` 与「实测成本为零」无从区分。
 * (红线:源不支持 / 读不到 / 不可测 ⇒ 空值,绝不用 0 冒充实测 0。)
 *
 * 注意与「真实的 0」区分:入参是数字 0 时**照常导出** `0.000000` ——
 * 那是源明确给出的零,不是未知。
 */
export function exportCostCell(value: number | null | undefined, digits = 6): string {
  if (value == null || !Number.isFinite(Number(value))) return ''
  return Number(value).toFixed(digits)
}
