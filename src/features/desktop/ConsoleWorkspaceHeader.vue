<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Activity, ChartNoAxesCombined } from '@lucide/vue'
import { DESKTOP_LOGO } from '@/utils/branding'
import LocaleSwitcher from '@/components/common/LocaleSwitcher.vue'

const route = useRoute()
const { t } = useI18n()
const costActive = computed(
  () =>
    route.path === '/connect' ||
    route.path.startsWith('/admin/cost-center') ||
    route.path.startsWith('/cockpit/cost-center')
)
const monitorActive = computed(() => route.path.startsWith('/usage-monitor'))
</script>

<template>
  <header class="workspace-header">
    <router-link class="workspace-brand" to="/connect" :aria-label="t('desktop.workspace.home')">
      <span class="workspace-mark"><img :src="DESKTOP_LOGO" alt="" /></span>
      <span
        ><strong>{{ t('desktop.brand.name') }}</strong
        ><small>{{ t('desktop.brand.subtitle') }}</small></span
      >
    </router-link>
    <nav class="workspace-switch" :aria-label="t('desktop.workspace.navigation')">
      <router-link
        to="/connect"
        class="workspace-link workspace-cost"
        :class="{ 'is-active': costActive }"
        :aria-current="costActive ? 'page' : undefined"
      >
        <span class="workspace-icon"><ChartNoAxesCombined :size="21" /></span>
        <span class="workspace-label"><strong>{{ t('desktop.workspace.cost') }}</strong><small>{{ t('desktop.workspace.costNote') }}</small></span>
      </router-link>
      <router-link
        to="/usage-monitor"
        class="workspace-link workspace-monitor"
        :class="{ 'is-active': monitorActive }"
        :aria-current="monitorActive ? 'page' : undefined"
      >
        <span class="workspace-icon"><Activity :size="21" /></span>
        <span class="workspace-label"><strong>{{ t('desktop.workspace.monitor') }}</strong><small>{{ t('desktop.workspace.monitorNote') }}</small></span>
      </router-link>
    </nav>
    <div class="workspace-locale" :aria-label="t('desktop.workspace.language')"><LocaleSwitcher /></div>
  </header>
</template>

<style scoped>
.workspace-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 24px;
  padding: 18px 32px;
  min-height: 104px;
  border-bottom: 1px solid #34473b;
  background: linear-gradient(110deg, #15221a, #0d1712 55%, #101e17);
  box-shadow:
    inset 0 1px #e9ffe707,
    0 8px 24px #00000014;
}
.workspace-brand {
  justify-self: start;
  display: flex;
  align-items: center;
  gap: 13px;
  min-width: 0;
  color: var(--cost-text, #e9ede6);
  text-decoration: none;
}
.workspace-locale { justify-self: end; }
.workspace-mark {
  display: grid;
  place-items: center;
  width: 48px;
  height: 48px;
  flex-shrink: 0;
  border-radius: 13px;
  background: radial-gradient(circle at 35% 20%, #d8f6a918, transparent 70%);
}
.workspace-mark img {
  width: 46px;
  height: 46px;
  object-fit: contain;
}
.workspace-brand > span:last-child {
  min-width: 0;
}
.workspace-brand strong {
  display: block;
  font-size: 23px;
  font-weight: 650;
  line-height: 1.35;
  white-space: nowrap;
}
.workspace-brand small {
  display: block;
  margin-top: 4px;
  font-size: 11px;
  letter-spacing: 0.08em;
  color: #91a295;
}
.workspace-switch {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 5px;
  padding: 5px;
  border: 1px solid #354a3c;
  border-radius: 16px;
  background: linear-gradient(#09130f, #112017);
  box-shadow:
    inset 0 2px 5px #0006,
    0 1px #d9f3cf0a;
}
.workspace-link {
  --workspace-accent: #c8e879;
  display: flex;
  align-items: center;
  gap: 11px;
  position: relative;
  min-width: 195px;
  padding: 10px 16px;
  border: 1px solid transparent;
  border-radius: 11px;
  color: #9bada0;
  text-decoration: none;
  transition:
    background 0.15s,
    border-color 0.15s,
    color 0.15s;
}
.workspace-monitor {
  --workspace-accent: #65ddc1;
}
.workspace-icon {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border: 1px solid #637e6526;
  border-radius: 9px;
  background: linear-gradient(135deg, #49624a18, #0d1711);
  color: #9cac9b;
  box-shadow: inset 0 1px #d6f6ce0b;
}
.workspace-label {
  min-width: 0;
}
.workspace-label strong {
  display: block;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
  white-space: nowrap;
}
.workspace-label small {
  display: block;
  margin-top: 3px;
  font-size: 10px;
  color: #788f7f;
  white-space: nowrap;
}
.workspace-link.is-active {
  border-color: #587044;
  background: linear-gradient(135deg, #34442b, #1a2c21 80%);
  box-shadow:
    inset 0 1px #ecffd624,
    0 4px 10px #0004;
  color: #eff8e8;
}
.workspace-monitor.is-active {
  border-color: #3c7460;
  background: linear-gradient(135deg, #234c3e, #162f26 80%);
}
.workspace-link.is-active .workspace-icon {
  color: var(--workspace-accent);
  border-color: #aac99540;
  background: linear-gradient(135deg, #aecb8e24, #13271d);
  box-shadow: inset 0 1px #dfffca1f;
}
.workspace-link.is-active .workspace-label small {
  color: #b0c4ad;
}
.workspace-link.is-active::after {
  content: '';
  position: absolute;
  right: 10px;
  top: 13px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--workspace-accent);
  box-shadow: 0 0 8px #b7e99566;
}
.workspace-link:hover:not(.is-active) {
  color: #e5f0e4;
  background: #21352880;
  border-color: #3d5543;
}
.workspace-link:focus-visible,
.workspace-brand:focus-visible {
  outline: 2px solid var(--workspace-accent, #b9e55a);
  outline-offset: 4px;
}
@media (max-width: 900px) {
  .workspace-header { grid-template-columns: minmax(0, 1fr) auto; }
  .workspace-switch { width: 100%; grid-column: 1 / -1; grid-row: 2; }
  .workspace-brand { grid-column: 1; grid-row: 1; }
  .workspace-locale { grid-column: 2; grid-row: 1; }
}
@media (max-width: 720px) {
  .workspace-header {
    padding: 16px 20px;
    gap: 15px;
  }
  .workspace-brand strong {
    font-size: 20px;
  }
  .workspace-mark {
    width: 42px;
    height: 42px;
  }
  .workspace-mark img {
    width: 40px;
    height: 40px;
  }
  .workspace-link {
    min-width: 0;
    padding: 8px 10px;
    gap: 8px;
  }
  .workspace-icon {
    width: 32px;
    height: 32px;
  }
  .workspace-label strong {
    font-size: 13px;
  }
  .workspace-label small {
    font-size: 10px;
    white-space: normal;
  }
  .workspace-link.is-active::after {
    right: 7px;
    top: 8px;
  }
}
@media (max-width: 380px) {
  .workspace-header {
    padding-inline: 14px;
  }
  .workspace-link {
    padding-inline: 8px;
    gap: 6px;
  }
  .workspace-icon {
    width: 28px;
    height: 30px;
  }
  .workspace-label strong {
    font-size: 12px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .workspace-link {
    transition: none;
  }
}
</style>
