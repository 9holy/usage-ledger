<template>
  <header class="desktop-titlebar" data-tauri-drag-region @dblclick="toggleMaximize">
    <div class="desktop-titlebar__brand" data-tauri-drag-region>
      <img :src="DESKTOP_LOGO" alt="" />
      <span data-tauri-drag-region>{{ t('desktop.brand.name') }}</span>
    </div>
    <div class="desktop-titlebar__controls" @dblclick.stop>
      <button type="button" :title="t('desktop.window.minimize')" :aria-label="t('desktop.window.minimizeLabel')" @click="minimize"><Minus :size="15" /></button>
      <button type="button" :title="t('desktop.window.maximize')" :aria-label="t('desktop.window.maximizeLabel')" @click="toggleMaximize"><Square :size="12" /></button>
      <button type="button" class="is-close" :title="t('desktop.window.close')" :aria-label="t('desktop.window.closeLabel')" @click="close"><X :size="16" /></button>
    </div>
  </header>
</template>

<script setup lang="ts">
import { Minus, Square, X } from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { DESKTOP_LOGO } from '@/utils/branding'

const { t } = useI18n()

async function currentWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  return getCurrentWindow()
}

async function minimize() { await (await currentWindow()).minimize() }
async function toggleMaximize() { await (await currentWindow()).toggleMaximize() }
async function close() { await (await currentWindow()).close() }
</script>

<style scoped>
.desktop-titlebar { position: relative; z-index: 10000; display: flex; min-height: 36px; flex: 0 0 36px; align-items: center; justify-content: space-between; color: #cbd3cb; background: #0c110d; border: 1px solid #2f3930; border-bottom-color: #263027; user-select: none; }
.desktop-titlebar__brand { display: flex; min-width: 0; align-items: center; gap: 8px; padding-left: 10px; font: 11px 'Segoe UI Variable', 'Segoe UI', sans-serif; }
.desktop-titlebar__brand img { width: 18px; height: 18px; border-radius: 4px; }
.desktop-titlebar__brand span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.desktop-titlebar__controls { display: flex; align-self: stretch; }
.desktop-titlebar__controls button { display: grid; width: 46px; place-items: center; color: #aab4ab; background: transparent; border: 0; }
.desktop-titlebar__controls button:hover { color: #eef3ed; background: #273028; }
.desktop-titlebar__controls button.is-close:hover { color: #fff; background: #c42b1c; }
@media (prefers-reduced-motion: reduce) { .desktop-titlebar__controls button { transition: none; } }
</style>
