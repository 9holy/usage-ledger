<template>
  <div
    class="cost-metric-cell"
    :class="[accentClass, `data-${state}`]"
    :data-data-state="state"
  >
    <div class="cost-metric-cell__heading">
    <span class="cost-metric-cell__label">{{ label }}</span>
    <em v-if="state !== 'measured'" class="cost-metric-cell__state">
      <CircleAlert v-if="state === 'unavailable'" :size="11" />
      <Clock3 v-else-if="state === 'loading' || state === 'stale'" :size="11" />
      <Sigma v-else-if="state === 'estimated'" :size="11" />
      <CircleMinus v-else-if="state === 'empty'" :size="11" />
      <TriangleAlert v-else :size="11" />
      {{ dataAvailabilityLabel(state) }}
    </em>
    </div>
    <strong class="cost-metric-cell__value">{{ value ?? emptyValue }}</strong>
    <small class="cost-metric-cell__note">{{ note }}</small>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
const { t } = useI18n()

import { computed } from 'vue'
import { CircleAlert, CircleMinus, Clock3, Sigma, TriangleAlert } from '@lucide/vue'
import { dataAvailabilityLabel, type DataAvailability } from '../dataState'

const props = withDefaults(defineProps<{
  label?: string
  value?: string
  note?: string
  accent?: string
  state?: DataAvailability
}>(), {
  label: '',
  note: '',
  accent: '',
  state: 'measured',
})

/**
 * accent 是「已实测」的视觉语言:只有 state === 'measured' 才把 accent-* 挂到根元素上,
 * 其余状态(loading / estimated / empty / partial / unavailable / stale)一律中性色,不替「不知道」背书。
 * 这条门控同时约束了父组件里以 .cost-metric-cell.accent-* 为锚点的活规则(例如 ::before 左色条)。
 */
const accentClass = computed(() => (props.accent && props.state === 'measured' ? `accent-${props.accent}` : ''))
const emptyValue = computed(() => t('costComponents.noData'))
</script>

<style scoped>
.cost-metric-cell {
  position: relative;
}

/* 排版规则原先写在父组件的 `.cost-metric-cell > span / > strong / > small` 里。
   Vue scoped CSS 只把父组件的 scope id 打在子组件的根元素上,而 span/strong/small 在本组件内部、
   只带本组件的 scope id,所以父组件那条编译成 `... > strong[data-v-父]` 后永不匹配。
   写进本组件后,选择器末位元素带的正是本组件的 scope id ⇒ 真正生效。 */
.cost-metric-cell__heading { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 6px 8px; }
.cost-metric-cell__label { min-width: 0; color: #849086; font-size: 11px; overflow-wrap: anywhere; }
.cost-metric-cell__value { min-width: 0; margin-top: 7px; color: #f0f3ed; font: 700 20px/1.35 'Cascadia Mono', Consolas, monospace; overflow-wrap: anywhere; }
/* note 是口径说明,**默认必须完整可见** —— 这批诚实性修复的核心交付就是把口径写到界面上。
   此前这里是 `overflow: hidden + text-overflow: ellipsis + white-space: nowrap`:
   格子约 200px 宽、9px 等宽字体一行只放得下 ~23 个汉字,而新增的口径注释(例如
   「本机自然日 · cockpit 单请求用量库按本地价目表自算 × 成本倍率（本项目配置）」)更长,
   于是写上去的口径全被「…」截断 —— 交付本身被自己的样式吃掉了。改为允许换行。
   金额也必须保留完整数字，不用省略号代替计量值。 */
.cost-metric-cell__note {
  margin-top: 5px;
  color: var(--cost-muted, #7f8b81);
  font: 10px 'Cascadia Mono', monospace;
  line-height: 1.45;
  /* 窄格子里遇到长串(路径 / 模型 id / 金额)也不横向溢出,一律折行显示 */
  overflow-wrap: anywhere;
}

/* 强调色:末位选择器 .cost-metric-cell__value 是本组件内部元素,带本组件 scope id ⇒ 真正匹配。
   accentClass 已保证 accent-* 只在 measured 态存在,故这里不需要再重复判状态。 */
.cost-metric-cell.accent-lime > .cost-metric-cell__value { color: var(--cost-lime); }
.cost-metric-cell.accent-gold > .cost-metric-cell__value { color: var(--cost-gold); }
.cost-metric-cell.accent-blue > .cost-metric-cell__value { color: var(--cost-blue); }

.cost-metric-cell__state {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
  border: 1px solid rgb(255 255 255 / 12%);
  border-radius: 999px;
  padding: 3px 6px;
  color: #9ca69e;
  background: rgb(255 255 255 / 4%);
  font: 500 9px/1 'Segoe UI Variable', sans-serif;
  font-style: normal;
  letter-spacing: 0;
}

.cost-metric-cell.data-unavailable strong,
.cost-metric-cell.data-loading strong {
  color: #aab2ab;
}

.cost-metric-cell.data-unavailable .cost-metric-cell__state { color: #e39787; border-color: rgb(227 151 135 / 32%); }
.cost-metric-cell.data-estimated .cost-metric-cell__state,
.cost-metric-cell.data-partial .cost-metric-cell__state { color: #e0bd4e; border-color: rgb(224 189 78 / 32%); }
.cost-metric-cell.data-empty .cost-metric-cell__state,
.cost-metric-cell.data-stale .cost-metric-cell__state { color: #91a3b0; border-color: rgb(145 163 176 / 30%); }

@media (forced-colors: active) {
  .cost-metric-cell__state { border-color: CanvasText; color: CanvasText; }
}
</style>
