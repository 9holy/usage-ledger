/**
 * 「号池运行状态 / 延迟排序」的**探测能力源三态契约** —— 视图侧接线守卫(2026-09-22)。
 *
 * ## 病根
 *
 * `CostCenterView.vue` 的「号池运行状态」格原本是二态
 * `connectionType === 'cliproxy' ? A : B`,把「非 cliproxy」一律当 sub2api。但**探测能力三源不同**:
 *
 * | 源 | 探测通道 | 延迟来源 |
 * |---|---|---|
 * | sub2api | `runProbe` → `adminAPI.testAccount` | `probes` |
 * | cliproxy | 无主动探测，CPA 历史延迟不推导当前健康 | 历史请求样本 |
 * | **cockpit** | **无**(本地用量采集源) | `cockpitAvgLatency`(单请求用量库),`probes` **恒为空** |
 *
 * 后果两处:
 * 1. cockpit 的「号池运行状态」**永久** `partial` + 「N 个未主动探测」(N 恒等于账号总数);
 * 2. 「按延迟排序」在 cockpit 下**全部账号无证据** ⇒ 排序键全是 `+∞`、排名列一个序号都不出,
 *    而延迟列明明显示着真实毫秒数。
 *
 * ## 本 spec 只做「接线」断言
 *
 * 三态**判定本身**已经搬进纯函数(`dataState.ts` 的 `poolHealthStateFor` /
 * `probeAvailabilityNote`、`upstreamTable.ts` 的 `latencyRankingProbe`),由
 * `dataState.test.ts` / `upstreamTable.spec.ts` **直接测**。
 * 这是有意的:文本扫描抓不住 `computed(() => true)` 这种**语义**改动 ——
 * 实测把 `probeCapable` 的函数体改成 `() => true`,`probeCapable` / `probeNote` 的字符串
 * 都还在,纯文本断言会**静默全绿**。所以本文件只钉「视图确实走单一入口」这一件文本能可靠判断的事。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'vue/compiler-sfc'

const VIEW_PATH = 'src/views/admin/CostCenterView.vue'
const VIEW = readFileSync(resolve(process.cwd(), VIEW_PATH), 'utf8')
const LINES = VIEW.split('\n')

/** 找**恰好一行**含该标记的行;数量不为 1 时返回 `''`,让调用方的肯定断言失败而不是静默通过。 */
function uniqueLine(marker: string): string {
  const hits = LINES.filter((line) => line.includes(marker))
  return hits.length === 1 ? hits[0] : ''
}

describe('号池运行状态的探测能力源三态契约', () => {
  it('视图确实把三态判定交给了纯函数(单一入口),而不是自己拼二态分支', () => {
    // 肯定断言:源码一改名就红,而不是让后续断言在空串上悄悄通过。
    expect(VIEW, '未找到 poolHealthStateFor 调用').toContain('poolHealthStateFor({')
    expect(VIEW, '未找到 probeAvailabilityNote 调用').toContain('probeAvailabilityNote(sourceKind.value')
    expect(VIEW, '未找到 latencyRankingProbe 调用(延迟排序的按源证据)')
      .toContain('latencyRankingProbe(sourceKind.value')
    expect(VIEW, '未找到 sourceKind 定义 —— 三源键必须是一处显式穷举')
      .toContain("const sourceKind = computed<'sub2api' | 'cliproxy' | 'cockpit'>")
    // 传参也要钉住:`poolHealthStateFor` 本身测得住,但「接线时硬编码了源」是纯函数测不到的。
    expect(VIEW, 'poolHealthStateFor 必须传 sourceKind.value,不得把源写死')
      .toContain('source: sourceKind.value,')
    // 旧的二态写法不得回归:模板里不该再出现 `=== 'cliproxy' ? … : …` 直接喂给号池状态格。
    expect(uniqueLine(":label=\"t('costCenter.text.poolOperatingStatus')\""), '未找到唯一的号池运行状态格').not.toBe('')
    expect(uniqueLine(":label=\"t('costCenter.text.poolOperatingStatus')\""), '格子的 state 必须走 poolHealthState')
      .toContain(':state="poolHealthState"')
  })

  it('模板里不得直接消费 oauthUnverifiedCount —— 一律经 probeAvailabilityNote', () => {
    const template = parse(VIEW, { filename: VIEW_PATH }).descriptor.template?.content ?? ''

    // ★ 扫描面自检(这一条是被真实 bug 逼出来的):`<template>` 在第 1 行、`</template>` 在第 1336 行,
    //   所以「从 indexOf('<template>') 切到文件尾」等于**整个 SFC**,会把 `<script setup>` 里
    //   `oauthUnverifiedCount` 的定义与注释一并算成「模板直接消费」⇒ 断言恒红、而它想钉的不变式
    //   其实一直成立。所以切片必须两端都取,并且**证明切对了**:
    expect(template.length, '模板切片为空 —— 扫描面塌了,这条等于没跑').toBeGreaterThan(0)
    expect(template, '切片把 <script> 也算进来了 —— 扫描面错了,断言会恒红').not.toContain('<script')
    expect(template, '切片里一个 <MetricCell 都没有 —— 这显然不是模板,扫描面塌了').toContain('<MetricCell')

    const direct = template.split('\n').filter((line) => line.includes('oauthUnverifiedCount'))
    expect(direct, `模板里直接消费了 oauthUnverifiedCount(应改为经 probeNote):\n${direct.join('\n')}`)
      .toEqual([])
  })

  it('探测按钮必须带 probeCapable 守卫(与探测格 :589 的 v-if 对齐)', () => {
    const buttons = LINES.filter((line) => line.includes('costCenter.text.testActualUpstreamConnectionTotalDuration')
      && line.trimStart().startsWith('<button'))
    expect(buttons.length, '未找到探测按钮那一行 —— 下面的断言会落在空数组上恒真').toBe(1)
    expect(buttons[0], 'cockpit 下探测按钮必须不渲染:点了会走 adminAPI,而 cockpit 账号 id 是 FNV-1a hash ⇒ 404')
      .toContain('v-if="probeCapable"')
    expect(VIEW).toContain("const probeCapable = computed(() => connectionType.value === 'sub2api')")
  })
})
