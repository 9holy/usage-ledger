<template>
  <main class="console-surface console-auth connect-workspace">
    <ConsoleWorkspaceHeader v-if="isDesktop" />
    <header v-else class="connect-header">
      <div class="connect-brand">
        <img :src="siteLogo || '/logo.svg'" :alt="siteName" />
        <div>
          <h1>{{ siteName }} Console</h1>
          <span>{{ appStore.cachedPublicSettings?.site_subtitle || t('desktop.connect.subtitle') }}</span>
        </div>
      </div>
      <LocaleSwitcher />
    </header>
    <div class="connect-columns" :class="{ 'is-editing': showEditor }">
      <div class="connect-intro"><div><span>{{ t('desktop.workspace.cost') }}</span><h1>{{ t('desktop.connect.title') }}</h1><p>{{ t('desktop.connect.description') }}</p></div><div class="intro-mark" aria-hidden="true"><i/><i/><i/><b/></div></div>
      <aside class="connections-pane" :aria-label="t('desktop.connect.sourcesLabel')">
        <div class="pane-heading">
          <h2>{{ t('desktop.connect.sources') }} <span>{{ connectionStore.connections.length + 1 }}</span></h2>
          <button v-if="!showEditor" ref="createButton" type="button" class="btn btn-primary new-connection" @click="openEditor()"><Plus :size="18" />{{ t('desktop.connect.newConnection') }}</button>
        </div>
        <p v-if="connectionStore.error && !showEditor" class="connection-error" role="alert"><CircleAlert :size="16" />{{ connectionStore.error }}</p>
        <div v-if="connectionStore.connections.length" class="saved-connections">
          <article v-for="conn in connectionStore.connections" :key="conn.id" class="saved-connection" :style="{ '--source-rgb': conn.type === 'sub2api' ? '111,205,232' : '199,223,116' }" :class="{ 'is-connected': conn.id === connectionStore.activeId && connectionStore.connected }">
            <div class="source-identity">
              <span class="source-icon-frame"><img class="source-logo" :src="conn.type === 'sub2api' ? '/source-icons/sub2api.svg' : '/source-icons/cliproxyapi.jpg'" alt="" /></span>
              <div class="connection-copy">
                <strong>{{ conn.name }}</strong>
                <span class="connection-meta"><span>{{ conn.type === 'sub2api' ? 'Sub2API' : 'CLIProxyAPI' }}</span><b :class="{ 'is-live': conn.id === connectionStore.activeId && connectionStore.connected }"><i />{{ conn.id === connectionStore.activeId && connectionStore.connected ? t('desktop.connect.connected') : t('desktop.connect.saved') }}</b>
                </span>
              </div>
            </div>
            <span class="connection-address-label">{{ t('desktop.connect.address') }}</span><p class="connection-address">{{ conn.baseUrl }}</p>
            <div class="connection-actions">
              <button type="button" class="console-icon-button remove-connection" :aria-label="t('desktop.connect.remove', { name: conn.name })" :title="t('desktop.connect.remove', { name: conn.name })" :disabled="connectionStore.connecting" @click="pendingRemove = conn.id"><Trash2 :size="17" /></button>
              <button type="button" class="connection-main btn btn-secondary" :disabled="connectionStore.connecting" @click="handleConnect(conn.id)">
                <Icon v-if="connectionStore.connecting && conn.id === pendingConnectionId" name="sync" size="sm" class="animate-spin" />
                <LogIn v-else :size="17" />{{ connectionStore.connecting && conn.id === pendingConnectionId ? t('desktop.connect.connecting') : t('desktop.connect.enter') }}
              </button>
            </div>
            <div v-if="pendingRemove === conn.id" class="remove-confirm" role="group" :aria-label="t('desktop.connect.confirmRemove', { name: conn.name })">
              <span>{{ t('desktop.connect.removeQuestion') }}</span>
              <button type="button" @click="handleRemove(conn.id)">{{ t('desktop.connect.delete') }}</button>
              <button type="button" @click="pendingRemove = null">{{ t('desktop.connect.cancel') }}</button>
            </div>
          </article>
        </div>
        <p v-else class="connection-empty">{{ t('desktop.connect.noConnections') }}</p>
        <div class="pane-heading local-heading">
          <h2>{{ t('desktop.connect.localData') }}</h2>
        </div>
        <article class="local-source">
          <span class="source-icon-frame"><img class="source-logo" src="/source-icons/cockpit.png" alt="" /></span>
          <div class="connection-copy">
            <strong>Cockpit <small>{{ t('desktop.connect.localDevice') }}</small></strong>
            <span class="cockpit-status" :class="cockpitState === null ? 'status-neutral' : cockpitState.available ? 'status-available' : 'status-warning'">{{ cockpitState === null ? t('desktop.connect.detecting') : cockpitState.available ? t('desktop.connect.available') : t('desktop.connect.notInstalled') }}</span>
            <small v-if="cockpitState && !cockpitState.available">{{ cockpitState.reason }}</small>
          </div>
          <button type="button" class="local-connection btn btn-secondary" :disabled="connectionStore.connecting" @click="enterCockpitCostCenter"><LogIn :size="17" />{{ t('desktop.connect.enter') }}</button>
        </article>
      </aside>
      <section v-show="showEditor" class="connection-form-pane" :aria-label="t('desktop.connect.editorLabel')">
        <div class="form-heading">
          <div class="reconnect-heading">
            <h2>{{ reconnectConnectionId ? t('desktop.connect.reconnect') : t('desktop.connect.newConnection') }}</h2>
            <button type="button" class="console-icon-button" :title="t('desktop.connect.collapseEditor')" :aria-label="t('desktop.connect.collapseEditor')" :disabled="connectionStore.connecting" @click="closeEditor"><X :size="19" /></button>
          </div>
        </div>
        <p v-if="connectionStore.error" class="connection-error" role="alert">
          <CircleAlert :size="16" />{{ connectionStore.error }}</p>
        <p v-if="twoFactorError && twoFactorError !== connectionStore.error" class="connection-error" role="alert"><CircleAlert :size="16" />{{ twoFactorError }}</p>
        <form @submit.prevent="handleCreate" class="connection-form">
          <div class="form-field">
            <label for="conn-name" class="input-label">{{ t('desktop.connect.name') }}</label>
            <input id="conn-name" v-model="form.name" type="text" required class="input" :placeholder="t('desktop.connect.namePlaceholder')" />
          </div>
          <div class="form-field">
            <label class="input-label">{{ t('desktop.connect.type') }}</label>
            <div class="connection-segment" role="group" :aria-label="t('desktop.connect.type')">
              <button type="button" :aria-pressed="form.type === 'sub2api'" @click="form.type = 'sub2api'">
                <Server :size="15" />Sub2API</button>
              <button type="button" :aria-pressed="form.type === 'cliproxy'" @click="form.type = 'cliproxy'">
                <Terminal :size="15" />CLIProxyAPI</button>
            </div>
          </div>
          <div class="form-field full-width">
            <label for="conn-url" class="input-label">{{ t('desktop.connect.address') }}</label>
            <input id="conn-url" v-model="form.baseUrl" type="text" :required="form.type === 'sub2api'" class="input" :placeholder="form.type === 'sub2api' ? 'https://sub2api.example.com' : t('desktop.connect.localUrlPlaceholder')" />
          </div>
          <div v-if="form.type === 'sub2api'" class="form-field full-width">
            <label class="input-label">{{ t('desktop.connect.authMode') }}</label>
            <div class="connection-segment" role="group" :aria-label="t('desktop.connect.authMode')">
              <button type="button" :aria-pressed="form.authMode === 'apikey'" @click="form.authMode = 'apikey'">
                <KeyRound :size="15" />{{ t('desktop.connect.adminKey') }}</button>
              <button type="button" :aria-pressed="form.authMode === 'login'" @click="form.authMode = 'login'">
                <LogIn :size="15" />{{ t('desktop.connect.loginMode') }}</button>
            </div>
          </div>
          <div v-if="form.type === 'sub2api' && form.authMode === 'apikey'" class="form-field full-width">
            <label for="conn-key" class="input-label">{{ t('desktop.connect.adminKey') }}</label>
            <div class="secret-input">
              <input id="conn-key" v-model="form.apiKey" :type="showApiKey ? 'text' : 'password'" required class="input" placeholder="admin-xxxxxxxx" />
              <button type="button" :aria-label="showApiKey ? t('desktop.connect.hideApiKey') : t('desktop.connect.showApiKey')" :title="showApiKey ? t('desktop.connect.hideApiKey') : t('desktop.connect.showApiKey')" @click="showApiKey = !showApiKey">
                <EyeOff v-if="showApiKey" :size="16" />
                <Eye v-else :size="16" />
              </button>
            </div>
          </div>
          <div v-if="form.type === 'cliproxy'" class="form-field full-width">
            <label for="conn-secret" class="input-label">{{ t('desktop.connect.managementKey') }}</label>
            <div class="secret-input">
              <input id="conn-secret" v-model="form.secretKey" :type="showSecretKey ? 'text' : 'password'" required class="input" :placeholder="t('desktop.connect.secretPlaceholder')" />
              <button type="button" :aria-label="showSecretKey ? t('desktop.connect.hideSecret') : t('desktop.connect.showSecret')" :title="showSecretKey ? t('desktop.connect.hideSecret') : t('desktop.connect.showSecret')" @click="showSecretKey = !showSecretKey">
                <EyeOff v-if="showSecretKey" :size="16" />
                <Eye v-else :size="16" />
              </button>
            </div>
            <p class="input-hint">{{ t('desktop.connect.secretHint') }}</p>
          </div>
          <template v-if="form.type === 'sub2api' && form.authMode === 'login'">
            <div class="form-field full-width">
              <label for="conn-email" class="input-label">{{ t('desktop.connect.email') }}</label>
              <input id="conn-email" v-model="form.email" type="email" required autocomplete="username" class="input" placeholder="admin@example.com" />
            </div>
            <div class="form-field full-width">
              <label for="conn-password" class="input-label">{{ t('desktop.connect.password') }}</label>
              <div class="secret-input">
                <input id="conn-password" v-model="form.password" :type="showPassword ? 'text' : 'password'" required autocomplete="current-password" class="input" :placeholder="t('desktop.connect.password')" />
                <button type="button" :aria-label="showPassword ? t('desktop.connect.hidePassword') : t('desktop.connect.showPassword')" :title="showPassword ? t('desktop.connect.hidePassword') : t('desktop.connect.showPassword')" @click="showPassword = !showPassword">
                  <EyeOff v-if="showPassword" :size="16" />
                  <Eye v-else :size="16" />
                </button>
              </div>
            </div>
            <label class="remember-password full-width">
              <input v-model="form.rememberPassword" type="checkbox" />
              <span>{{ t('desktop.connect.rememberPassword') }}<small>{{ t('desktop.connect.rememberHint') }}</small>
              </span>
            </label>
          </template>
          <details class="cost-service full-width">
            <summary>{{ t('desktop.connect.advanced') }}</summary>
            <label for="conn-cost" class="input-label">{{ t('desktop.connect.costService') }}</label>
            <input id="conn-cost" v-model="form.costServiceUrl" type="text" class="input" placeholder="http://localhost:8088" />
            <p class="input-hint">{{ t('desktop.connect.costServiceHint') }}</p>
            <p v-if="isDesktop" class="input-hint cost-warning">{{ t('desktop.connect.costServiceDesktopHint') }}</p>
          </details>
          <button type="submit" :disabled="connectionStore.connecting" class="btn btn-primary full-width">
            <Icon v-if="connectionStore.connecting" name="sync" size="md" class="mr-2 animate-spin" />
            <LogIn v-else :size="16" class="mr-2" />{{ connectionStore.connecting ? t('desktop.connect.connecting') : t('desktop.connect.saveAndConnect') }}</button>
        </form>
        <form v-if="twoFactorPending" @submit.prevent="handleTwoFactor" class="two-factor-form">
          <label for="conn-totp" class="input-label">{{ t('desktop.connect.twoFactor') }}</label>
          <div>
            <input id="conn-totp" v-model="totpCode" type="text" inputmode="numeric" maxlength="6" autocomplete="one-time-code" required class="input" placeholder="000000" />
            <button type="submit" :disabled="connectionStore.connecting" class="btn btn-primary">{{ t('desktop.connect.verify') }}</button>
          </div>
        </form>
      </section>
    </div>
  </main>
</template>

<script setup lang="ts">
import { CircleAlert, Eye, EyeOff, KeyRound, LogIn, Plus, Server, Terminal, Trash2, X } from '@lucide/vue'
import { computed, nextTick, reactive, ref, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import '@/styles/console-theme.css'
import Icon from '@/components/icons/Icon.vue'
import { useConnectionStore } from '@/stores/connection'
import type { ConnectionType, Sub2ApiAuthMode } from '@/stores/connection'
import { useAuthStore } from '@/stores/auth'
import { useAppStore } from '@/stores/app'
import { sanitizeUrl } from '@/utils/url'
import { getCockpitConnectionState, type CockpitConnectionState } from '@/api/cockpit'
import { isDesktopRuntime } from '@/api/url'
import ConsoleWorkspaceHeader from '@/features/desktop/ConsoleWorkspaceHeader.vue'
import LocaleSwitcher from '@/components/common/LocaleSwitcher.vue'

const router = useRouter()
const { t } = useI18n()
const connectionStore = useConnectionStore()
const authStore = useAuthStore()
const appStore = useAppStore()
const siteName = computed(() => appStore.siteName || 'Sub2API')
const siteLogo = computed(() => sanitizeUrl(appStore.siteLogo || '', { allowRelative: true, allowDataUrl: true }))
const showEditor = ref(connectionStore.connections.length === 0)
const createButton = ref<HTMLButtonElement | null>(null)
const pendingConnectionId = ref<string | null>(null)
async function openEditor(fresh = true) {
  if (fresh) {
    if (reconnectConnectionId.value) Object.assign(form, { name: '', baseUrl: '', apiKey: '', secretKey: '', email: '', password: '', costServiceUrl: '' })
    reconnectConnectionId.value = null
    twoFactorPending.value = false
    twoFactorError.value = ''
    totpCode.value = ''
  }
  showEditor.value = true
  await nextTick()
  document.getElementById('conn-name')?.focus()
}
async function closeEditor() {
  showEditor.value = false
  await nextTick()
  createButton.value?.focus()
}

// 桌面运行时:没有内置后端,Cost 服务等远程端点需显式连接后才生效,据此给出提示。
const isDesktop = isDesktopRuntime()

// cockpit 本地数据状态(只读展示):非远程连接,本地自动探测。
// null=探测中;有值=探测完成。cockpit 未装是合法状态,非错误。
// 注意 running 与 available 同义(只判本地文件可读,不判进程存活),UI 不得据此声称「运行中」。
const cockpitState = ref<CockpitConnectionState | null>(null)
onMounted(async () => {
  void appStore.fetchPublicSettings()
  cockpitState.value = await getCockpitConnectionState()
})

// cockpit 点击:建占位 admin 会话放行 requiresAdmin,跳完整成本中心三端汇总面板。
// cockpit 不是远程连接(无 baseUrl/secretKey),不进 connectionStore,只让 cost-center 路由放行。
function enterCockpitCostCenter() {
  // 清掉旧 sub2api/cliproxy active,让 CostCenterView connectionType === null 命中 cockpit 分支。
  // 不用 disconnect():它会调 authStore.logout 清掉占位会话。clearActiveOnly 只清 connection 标记。
  connectionStore.clearActiveOnly()
  authStore.connectWithApiKey('cockpit-local')
  router.push('/admin/cost-center?panel=overview')
}

const form = reactive<{
  name: string
  type: ConnectionType
  baseUrl: string
  apiKey: string
  secretKey: string
  authMode: Sub2ApiAuthMode
  email: string
  password: string
  rememberPassword: boolean
  costServiceUrl: string
}>({
  name: '',
  type: 'sub2api',
  baseUrl: '',
  apiKey: '',
  secretKey: '',
  authMode: 'apikey',
  email: '',
  password: '',
  rememberPassword: true,
  costServiceUrl: '',
})

// 纯 UI 状态:API Key/密码可见切换,不参与连接逻辑
const showApiKey = ref(false)
const showPassword = ref(false)
const showSecretKey = ref(false)
const twoFactorPending = ref(false)
const twoFactorError = ref('')
const pendingRemove = ref<string | null>(null)
const totpCode = ref('')
// JWT 过期重连路径:handleConnect 预填表单时指向已有连接 id,
// handleCreate 据此 update 已有连接而非 addConnection(否则每次重输密码都会多出一条重复连接)。
// 与 2FA 无关(2FA 用 store 内 pending2FA 暂存,不需要组件层 id)。
const reconnectConnectionId = ref<string | null>(null)
watch([() => form.type, () => form.authMode], () => {
  reconnectConnectionId.value = null
  twoFactorPending.value = false
  twoFactorError.value = ''
  totpCode.value = ''
}, { flush: 'sync' })

function redirectAfterConnect() {
  reconnectConnectionId.value = null
  router.replace(isDesktop ? '/admin/cost-center' : connectionStore.adminHomePath)
}

async function handleConnect(id: string) {
  const conn = connectionStore.connections.find(c => c.id === id)
  if (!conn) return
  pendingConnectionId.value = id
  reconnectConnectionId.value = null
  twoFactorPending.value = false
  twoFactorError.value = ''
  totpCode.value = ''
  // 已是活跃连接:直接跳转
  if (conn.id === connectionStore.activeId && connectionStore.connected) {
    redirectAfterConnect()
    return
  }
  // sub2api login 模式:JWT 仍在有效期内 → 直接复用 JWT 重连,不要求重输密码;
  // JWT 已过期/丢失 → 连接存了密码(记住密码)时 connectWithStoredJwt 内部已静默重登;
  // 没存密码才回落到这里:预填已知字段(含 email),引导用户重输密码(apikey/cliproxy 直接 connect)
  if (conn.type === 'sub2api' && conn.authMode === 'login') {
    const ok = await connectionStore.connectWithStoredJwt(id)
    if (ok) {
      redirectAfterConnect()
      return
    }
    // 手动重连:预填已知字段;密码仅在连接本就存了(如 2FA 场景)时回填,checkbox 同步真实状态
    form.name = conn.name
    form.baseUrl = conn.baseUrl
    form.type = 'sub2api'
    form.authMode = 'login'
    form.email = conn.email ?? ''
    form.password = conn.password ?? ''
    form.rememberPassword = conn.password != null && conn.password !== ''
    form.costServiceUrl = conn.costServiceUrl ?? ''
    reconnectConnectionId.value = id
    await openEditor(false)
    return
  }
  const ok = await connectionStore.connect(id)
  if (ok) redirectAfterConnect()
}

async function handleCreate() {
  twoFactorError.value = ''
  // JWT 过期重连路径:reconnectConnectionId 指向已有连接 → update 复用,不新建
  // (否则每次重输密码都会多出一条同 URL 的重复连接记录)
  const reconnectId = reconnectConnectionId.value
    && form.type === 'sub2api' && form.authMode === 'login'
    && connectionStore.connections.some(c => c.id === reconnectConnectionId.value && c.type === 'sub2api' && c.authMode === 'login')
    ? reconnectConnectionId.value
    : null
  if (!reconnectId) reconnectConnectionId.value = null

  // 记住密码:勾选才把密码存进连接记录(混淆存储),JWT 过期时静默重登用
  const rememberedPassword = form.type === 'sub2api' && form.authMode === 'login' && form.rememberPassword
    ? form.password
    : undefined

  if (reconnectId) {
    // 重连更新:只覆盖 login 相关字段;apiKey 不动(旧 JWT 由 connectWithLogin 成功后刷新,
    // 失败时保留旧值无副作用——旧 JWT 本就已过期)
    connectionStore.updateConnection(reconnectId, {
      name: form.name.trim() || 'Sub2API',
      baseUrl: form.baseUrl.trim().replace(/\/+$/, ''),
      authMode: 'login',
      email: form.email.trim(),
      password: rememberedPassword,
      costServiceUrl: form.costServiceUrl.trim() || undefined,
    })
  }

  const id = reconnectId ?? connectionStore.addConnection({
    name: form.name.trim() || (form.type === 'sub2api' ? 'Sub2API' : 'CLI Proxy'),
    type: form.type,
    // cliproxy 留空默认本地 8317(桌面端常连本地 sidecar);sub2api 必填远程地址
    baseUrl: form.type === 'cliproxy'
      ? (form.baseUrl.trim().replace(/\/+$/, '') || 'http://127.0.0.1:8317')
      : form.baseUrl.trim().replace(/\/+$/, ''),
    // cliproxy 桌面端只用 management API(secret-key Bearer),业务 apiKey 不需要;
    // sub2api apikey 模式 apiKey 存 Admin API Key,login 模式留空(后由 JWT 填)
    apiKey: form.type === 'sub2api' ? form.apiKey : '',
    secretKey: form.type === 'cliproxy' ? form.secretKey : undefined,
    authMode: form.type === 'sub2api' ? form.authMode : undefined,
    email: form.type === 'sub2api' && form.authMode === 'login' ? form.email.trim() : undefined,
    password: rememberedPassword,
    costServiceUrl: form.costServiceUrl.trim() || undefined,
  })

  if (form.type === 'sub2api' && form.authMode === 'login') {
    reconnectConnectionId.value = id
    const result = await connectionStore.connectWithLogin(id, form.email, form.password, form.rememberPassword)
    if (result.requires2fa) {
      twoFactorPending.value = true
      return
    }
    if (result.ok) redirectAfterConnect()
  } else {
    const ok = await connectionStore.connect(id)
    if (ok) redirectAfterConnect()
  }
}

async function handleTwoFactor() {
  // 2FA 补码:用 store 内暂存的 temp_token 走 login2FA 换 JWT,不再重发密码(否则陷入 2FA 循环)
  twoFactorError.value = ''
  const result = await connectionStore.complete2FA(totpCode.value)
  if (result.ok) {
    twoFactorPending.value = false
    totpCode.value = ''
    redirectAfterConnect()
  } else {
    twoFactorError.value = result.error || t('desktop.connect.twoFactorFailed')
    if (result.requiresLogin) {
      twoFactorPending.value = false
      totpCode.value = ''
    }
  }
  // 失败时保留 2FA 表单与 temp_token:用户改码后可原地重试,无需重输邮箱密码
}

function handleRemove(id: string) {
  connectionStore.removeConnection(id)
  if (reconnectConnectionId.value === id) reconnectConnectionId.value = null
  pendingRemove.value = null
}
</script>

<style scoped>
.connect-workspace{min-height:100%;width:100%;min-width:0;background:radial-gradient(ellipse at 76% 28%,#36532c16,transparent 48%),var(--cost-bg)}
.connect-header{display:flex;align-items:center;justify-content:space-between;padding:20px 32px;border-bottom:1px solid var(--cost-line-strong)}.connect-brand{display:flex;align-items:center;gap:13px}.connect-brand img{width:40px;height:40px}.connect-brand h1{font-size:22px;margin:0}.connect-brand span{display:block;margin-top:4px;color:var(--cost-muted)}
.connect-columns{display:grid;grid-template-columns:minmax(0,1fr);max-width:1264px;margin:0 auto;padding:44px 32px 64px;gap:30px}
.connect-columns.is-editing{grid-template-columns:minmax(0,1fr) minmax(420px,1fr)}
.connections-pane,.connection-form-pane{min-width:0}
.pane-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px}.pane-heading h2,.form-heading h2{font-size:23px;font-weight:650;margin:0}.pane-heading h2 span{margin-left:14px;font-size:16px;font-weight:400;color:var(--cost-muted)}.new-connection{display:flex;align-items:center;gap:8px;padding:0 18px}
.saved-connections{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.is-editing .saved-connections{grid-template-columns:1fr}
.saved-connection{position:relative;min-width:0;border:1px solid #415442;border-radius:14px;background:radial-gradient(ellipse at 95% 0%,rgba(var(--source-rgb),.11),transparent 62%),linear-gradient(145deg,#1a271d,#111c15 70%);padding:26px 26px 20px;box-shadow:inset 0 1px #c5e2c315,0 14px 28px #0002;transition:border-color .2s,box-shadow .2s,transform .2s}
.source-identity{display:flex;align-items:center;gap:16px}.source-icon-frame{display:grid;place-items:center;width:60px;height:60px;border:1px solid #6f8d7055;border-radius:14px;background:linear-gradient(140deg,#6d8a6f26,#122019);box-shadow:inset 0 1px #e0ffdd28,0 7px 14px #0004;flex-shrink:0}.source-logo{width:40px;height:40px;object-fit:contain;border-radius:8px;flex-shrink:0}.connection-copy{min-width:0;flex:1;overflow-wrap:anywhere}.connection-copy strong{display:block;font-size:21px;font-weight:600;color:var(--cost-text)}.connection-copy>small{display:block;margin-top:8px;color:var(--cost-muted);font-size:12px}
.connection-meta{display:flex;align-items:center;flex-wrap:wrap;gap:14px;margin-top:9px;font-size:12px}.connection-meta>span{color:var(--cost-blue)}.connection-meta b{display:flex;align-items:center;gap:6px;font-weight:400;color:#a5afa7}.connection-meta b.is-live{color:var(--cost-lime)}.connection-meta i{width:6px;height:6px;border-radius:50%;background:currentColor}
.connection-address-label{display:block;margin-top:26px;color:#829985;font-size:10px;letter-spacing:.05em}.connection-address{font-size:13px;color:#adbdaf;overflow-wrap:anywhere;margin:7px 0 22px;line-height:1.6;font-variant-numeric:tabular-nums}.connection-actions{display:flex;align-items:center;justify-content:space-between;border-top:1px solid var(--cost-line);padding-top:14px;gap:12px}
.connection-main,.local-connection{display:inline-flex;min-height:42px;border-radius:8px;align-items:center;justify-content:center;gap:9px;padding:0 16px;white-space:nowrap}.connection-main>svg,.local-connection>svg{color:var(--cost-lime);flex-shrink:0}.remove-connection{border-color:transparent;background:none}.remove-connection:hover:not(:disabled){color:#efb6a7}
.remove-confirm{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:12px;padding-top:12px;border-top:1px solid var(--cost-line);color:#efb6a7;font-size:12px}.remove-confirm button{padding:5px 12px;border:1px solid var(--cost-line-strong);border-radius:4px}.remove-confirm button:first-of-type{border-color:#925c50}
.connection-empty{font-size:14px;color:var(--cost-muted);padding:25px 0}
.local-heading{margin-top:38px}.local-heading h2{font-size:20px}
.local-source{display:flex;align-items:center;gap:18px;border:1px solid #415442;background:radial-gradient(ellipse at 0% 30%,#30634825,transparent 60%),linear-gradient(145deg,#19291e,#111c15);border-radius:14px;padding:26px;box-shadow:inset 0 1px #c5e2c315,0 14px 28px #0002}.local-source strong small{display:inline-block;margin-left:9px;font-size:11px;font-weight:400;color:#a5afa7}.cockpit-status{display:block;margin-top:10px;font-size:12px}.status-neutral{color:var(--cost-muted)}.status-available{color:var(--cost-lime)}.status-warning{color:var(--cost-gold)}
.connection-form-pane{border:1px solid #415442;border-radius:14px;padding:28px;background:linear-gradient(145deg,#1a281e,#111c15);box-shadow:inset 0 1px #c5e2c315,0 14px 28px #0002;align-self:start}.form-heading{margin-bottom:26px}.reconnect-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.reconnect-heading .console-icon-button{border-color:transparent;background:none}
.connection-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px 16px}.form-field{min-width:0}.full-width{grid-column:1/-1}.connection-segment{display:flex;min-height:42px;border:1px solid var(--cost-line-strong);border-radius:4px;overflow:hidden}.connection-segment button{display:flex;gap:6px;align-items:center;justify-content:center;flex:1;min-width:0;padding:8px;font-size:12px;color:#a5afa7;background:var(--cost-bg)}.connection-segment svg{flex-shrink:0}.connection-segment button+button{border-left:1px solid var(--cost-line-strong)}.connection-segment button[aria-pressed='true']{color:var(--cost-blue);background:#19252a;box-shadow:inset 0 0 0 1px var(--cost-blue)}.connection-segment button:hover{background:var(--cost-panel-2)}
.secret-input{position:relative}.secret-input .input{padding-right:44px}.secret-input>button{position:absolute;right:3px;top:3px;display:grid;place-items:center;width:34px;height:34px;color:#a5afa7;border-radius:3px}.secret-input>button:hover{color:var(--cost-text);background:var(--cost-panel-2)}
.remember-password{display:flex;gap:9px;align-items:flex-start;color:#b6bfb7;font-size:12px}.remember-password input{margin-top:3px;width:15px;height:15px}.remember-password small{display:block;color:var(--cost-muted);font-size:11px;margin-top:4px;line-height:1.6}
.cost-service{border-top:1px solid var(--cost-line);padding-top:15px}.cost-service summary{cursor:pointer;font-size:13px;color:#a5afa7;padding-bottom:6px}.cost-service[open] summary{margin-bottom:12px}.cost-warning{color:var(--cost-gold)!important}
.connection-error{display:flex;gap:9px;align-items:flex-start;background:#30201c;border:1px solid #72483d;color:#efb6a7;padding:12px;margin-bottom:20px;font-size:12px;overflow-wrap:anywhere}.connection-error svg{flex-shrink:0}.two-factor-form{margin-top:24px;padding-top:20px;border-top:1px solid var(--cost-gold)}.two-factor-form>div{display:flex;gap:10px}.two-factor-form .input{flex:1;min-width:0}.two-factor-form .btn{flex:0 0 90px}
@media(max-width:1100px){.connect-columns.is-editing{grid-template-columns:minmax(0,.9fr) minmax(380px,1fr);gap:24px}.connection-form-pane{padding:24px}.is-editing .local-source{flex-wrap:wrap}.is-editing .local-connection{margin-left:auto}}
@media(max-width:800px){.connect-columns,.connect-columns.is-editing{grid-template-columns:1fr;padding:28px 20px;gap:28px}.connection-form-pane{padding:24px}.saved-connections{grid-template-columns:1fr}.local-source{flex-wrap:wrap}.local-connection{margin-left:auto}}
@media(max-width:460px){.connection-form{grid-template-columns:1fr}.form-field{grid-column:1/-1}.saved-connection,.local-source{padding:18px}.pane-heading h2,.form-heading h2{font-size:20px}.new-connection{padding:0 12px}}

.connect-intro{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;gap:30px;margin-bottom:10px;padding-bottom:30px;border-bottom:1px solid #3a503c70}
.connect-intro>div>span{font-size:11px;color:#b3cd91}.connect-intro h1{font-size:32px;font-weight:650;line-height:1.35;color:#e4f1e5;margin:10px 0}.connect-intro p{font-size:13px;color:#9bb19f;margin:0;line-height:1.7}
.intro-mark{position:relative;width:130px;height:70px;transform:skewY(-12deg);opacity:.75;flex-shrink:0}.intro-mark i{position:absolute;width:74px;height:34px;border:1px solid #6e9273;border-radius:5px;background:linear-gradient(130deg,#49715440,#13271c);box-shadow:0 10px 15px #0004}.intro-mark i:nth-child(1){left:0;top:4px}.intro-mark i:nth-child(2){left:24px;top:18px}.intro-mark i:nth-child(3){left:48px;top:32px;border-color:#9ec968}.intro-mark b{position:absolute;left:61px;top:44px;width:38px;height:4px;background:linear-gradient(90deg,#c4e78b,#558f5c);box-shadow:0 0 12px #91d19b55}
.saved-connection::before{content:'';position:absolute;top:-1px;left:26px;right:26px;height:1px;background:linear-gradient(90deg,transparent,rgba(var(--source-rgb),.7),transparent)}.saved-connection:hover{border-color:rgba(var(--source-rgb),.55);box-shadow:inset 0 1px #d6f5dc20,0 18px 30px #0004;transform:translateY(-2px)}
.connection-meta b{border:1px solid #637b6240;border-radius:20px;padding:3px 8px;background:#15231a}.connection-main{background:linear-gradient(140deg,#365137,#1e3423)!important;border-color:#668263!important;color:#d9eed2!important;box-shadow:inset 0 1px #d6f5ce20}.connection-main:hover:not(:disabled),.local-connection:hover:not(:disabled){background:#304c31!important;border-color:#a5c78b!important}.new-connection{border-radius:8px;box-shadow:0 6px 18px #b6d96a12}.connection-form .input{border-radius:7px}.connect-workspace .input-label{font-size:12px}.connection-form .btn-primary{border-radius:8px;min-height:44px}
@media(prefers-reduced-motion:reduce){.saved-connection{transition:none}.saved-connection:hover{transform:none}}
@media(max-width:800px){.connect-intro{padding-bottom:24px;margin-bottom:0}.connect-intro h1{font-size:27px}.intro-mark{width:110px;transform:scale(.85) skewY(-12deg);transform-origin:right center}}
@media(max-width:460px){.connect-intro{gap:15px}.connect-intro h1{font-size:25px}.connect-intro p{font-size:12px}.intro-mark{display:none}.source-icon-frame{width:52px;height:52px}.source-logo{width:36px;height:36px}.connection-copy strong{font-size:19px}.connection-form-pane{padding:20px}.connection-main{padding:0 12px}}

.saved-connection.is-connected { border-color:rgba(var(--source-rgb),.65); background:radial-gradient(ellipse at 92% -20%,rgba(var(--source-rgb),.16),transparent 68%),linear-gradient(145deg,#1b2c21,#101a14 75%); }
.saved-connection:focus-within {outline:2px solid rgba(var(--source-rgb),.7);outline-offset:3px;}
.saved-connection.is-connected .connection-main {background:linear-gradient(140deg,#d1ef88,#adcf61)!important;color:#17240d!important;border-color:#c7e78a!important;box-shadow:inset 0 1px #efffd0,0 5px 14px #9bc34a18;}
.saved-connection.is-connected .connection-main svg {color:inherit;}
.saved-connection.is-connected .connection-main:hover:not(:disabled) {background:#d8ef95!important;border-color:#e3f7b0!important;}
.source-icon-frame {box-shadow:inset 0 1px #edffe140,inset 0 -3px 5px #0006,0 3px 0 #1c2f23,0 10px 18px #0006;}
.connection-address {font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:13px;line-height:1.65;}
.intro-mark {width:155px;height:92px;transform:perspective(450px) rotateY(-18deg) rotateX(10deg) skewY(-9deg);opacity:.95;}
.intro-mark i {width:88px;height:45px;background:linear-gradient(145deg,#5c94734d,#142b1d 65%);box-shadow:inset 0 1px #b4edc055,3px 5px 0 #112418,0 18px 24px #0007;}
.intro-mark i:nth-child(2){top:22px;left:29px;}
.intro-mark i:nth-child(3){top:40px;left:58px;border-color:#abc974;background:linear-gradient(130deg,#59834d66,#172b1b);}
.intro-mark b{left:76px;top:59px;width:46px;height:5px;box-shadow:0 0 18px #a3df7d65;}
@media(max-width:460px){.connection-address{font-size:12px;}}
</style>
