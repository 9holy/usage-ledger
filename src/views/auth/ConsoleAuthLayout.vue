<template>
  <main class="console-surface console-auth login-workspace">
    <header class="login-brand">
      <img :src="siteLogo || '/logo.svg'" :alt="siteName" />
      <div>
        <h1>{{ siteName }}</h1>
        <span>{{ siteSubtitle }}</span>
      </div>
      <router-link to="/connect" :title="t('desktop.auth.back')" :aria-label="t('desktop.auth.back')" class="console-icon-button">
        <ArrowLeft :size="17" />
      </router-link>
    </header>
    <section class="login-content">
      <slot />
      <footer v-if="$slots.footer">
        <slot name="footer" />
      </footer>
    </section>
    <div class="login-copyright">&copy; {{ currentYear }} {{ siteName }}. All rights reserved.</div>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowLeft } from '@lucide/vue'
import { useAppStore } from '@/stores'
import { sanitizeUrl } from '@/utils/url'
import { isDesktopRuntime } from '@/api/url'
import { DESKTOP_LOGO, getDesktopName } from '@/utils/branding'
import '@/styles/console-theme.css'

const appStore = useAppStore()
const { t } = useI18n()
const siteName = computed(() => isDesktopRuntime() ? getDesktopName() : appStore.siteName || 'Sub2API')
const siteLogo = computed(() => isDesktopRuntime() ? DESKTOP_LOGO : sanitizeUrl(appStore.siteLogo || '', { allowRelative: true, allowDataUrl: true }))
const siteSubtitle = computed(() => isDesktopRuntime() ? 'Usage Ledger' : appStore.cachedPublicSettings?.site_subtitle || 'Console')
const currentYear = new Date().getFullYear()
onMounted(() => { appStore.fetchPublicSettings() })
</script>

<style scoped>
.login-workspace{min-height:100dvh;padding-bottom:28px}.login-brand{display:flex;align-items:center;gap:13px;padding:22px 32px;border-bottom:1px solid var(--cost-line-strong)}.login-brand img{width:34px;height:34px;object-fit:contain}.login-brand h1{margin:0;font-size:19px;font-weight:650}.login-brand span{display:block;color:var(--cost-muted);font-size:11px;margin-top:4px;overflow-wrap:anywhere}.login-brand .console-icon-button{margin-left:auto}.login-content{width:min(100% - 40px,400px);margin:56px auto 0}.login-content footer{margin-top:26px;padding-top:22px;border-top:1px solid var(--cost-line);font-size:12px;text-align:center}.login-copyright{margin:36px 20px 0;text-align:center;color:var(--cost-muted);font-size:10px}.login-content :deep(h2){color:var(--cost-text);font-size:21px;font-weight:600}.login-content :deep(p),.login-content :deep(.text-gray-500){color:var(--cost-muted)}.login-content :deep(a){color:var(--cost-blue)}.login-content :deep(.bg-gray-200){background:var(--cost-line)}.login-content :deep(.text-gray-400){color:var(--cost-muted)}.login-content :deep(.text-gray-800){color:var(--cost-text)}.login-content :deep(.btn-secondary){height:40px}.login-content :deep(.login-error){padding:11px 12px;border:1px solid #72483d;background:#30201c;color:#efb6a7;font-size:12px;line-height:1.7;overflow-wrap:anywhere}@media(max-width:600px){.login-brand{padding:20px}.login-content{margin-top:32px}}
.login-workspace,.login-content{min-width:0}.login-brand>div{min-width:0;flex:1}.login-brand img{flex-shrink:0}.login-brand h1,.login-brand span,.login-copyright{overflow-wrap:anywhere}.login-content :deep(.btn){max-width:100%;min-width:0;white-space:normal;overflow-wrap:anywhere}.login-content :deep(.btn-secondary){height:auto;min-height:40px}.login-content :deep(.btn>svg){flex-shrink:0}
</style>
