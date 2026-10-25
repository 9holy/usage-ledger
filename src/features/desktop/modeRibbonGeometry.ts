// One common axis for all independent sources. Never inflate small segments.
export function modeRibbonRanges(counts: number[], total: number) {
  let cursor = 0
  return counts.map((count) => {
    const start = cursor
    cursor = Math.min(
      1,
      cursor +
        (Number.isFinite(count) && count > 0 && total > 0 ? count / total : 0),
    )
    return { start, end: cursor }
  })
}
