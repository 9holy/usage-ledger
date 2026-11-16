<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Info, Pencil, Plus, SlidersHorizontal, X } from '@lucide/vue'
import type { ApiCostRule, LocalCostSettings } from '@/api/localCost'
import { usageLocale } from '@/utils/usageFormat'

const props=defineProps<{settings:LocalCostSettings;saving:boolean;saveSettings:(settings:LocalCostSettings)=>Promise<void>}>()
const {t}=useI18n()
const editing=ref(false),error=ref(''),method=ref<'multiplier'|'rates'>('multiplier'),exchange=ref(props.settings.cnyPerUsd)
const localTime=(value:number)=>new Date(value-new Date(value).getTimezoneOffset()*60000).toISOString().slice(0,16)
const effective=ref(''),model=ref(''),currency=ref<'USD'|'CNY'>('USD'),multiplier=ref<string|number>('')
const fields=['input','output','cacheRead','cacheWrite','cacheWrite5m','cacheWrite1h'] as const
const rates=ref<Record<typeof fields[number],string|number>>({input:'',output:'',cacheRead:'',cacheWrite:'',cacheWrite5m:'',cacheWrite1h:''})
watch(()=>props.settings.cnyPerUsd,value=>{if(!editing.value)exchange.value=value})
function open(rule?:ApiCostRule){
  editing.value=true;error.value='';model.value=rule?.model??'';currency.value=rule?.currency??'USD';method.value=rule?.multiplier==null&&rule?'rates':'multiplier';multiplier.value=String(rule?.multiplier??'')
  effective.value=localTime(rule?.startMs??new Date(new Date().getFullYear(),new Date().getMonth(),1).getTime())
  for(const field of fields)rates.value[field]=rule?.[field]==null?'':String(rule[field])
}
async function persist(settings:LocalCostSettings){error.value='';try{await props.saveSettings(settings);return true}catch(failure){error.value=String(failure instanceof Error?failure.message:failure);return false}}
async function save(){
  const number=(value:string|number)=>String(value).trim()===''?null:Number(value)
  const rule:ApiCostRule={model:model.value.trim()||null,startMs:new Date(effective.value).getTime(),currency:method.value==='multiplier'?'USD':currency.value,multiplier:method.value==='multiplier'?number(multiplier.value):null,input:null,output:null,cacheRead:null,cacheWrite:null,cacheWrite5m:null,cacheWrite1h:null}
  if(method.value==='rates')for(const field of fields)rule[field]=number(rates.value[field])
  if(await persist({...props.settings,apiRules:[...props.settings.apiRules.filter(previous=>previous.model!==rule.model||previous.startMs!==rule.startMs),rule]}))editing.value=false
}
defineExpose({ openEditor: open })
</script>

<template>
  <section class="monitor-api-prices prices-workspace" :aria-label="t('desktop.localCost.apiPricing')">
    <header class="prices-heading"><div><h2>{{ t('desktop.localCost.apiPricing') }}</h2><small>{{ t('desktop.localCost.rulesCount',{count:settings.apiRules.length}) }}</small></div><button type="button" class="cost-command local-command" :disabled="saving" @click="open()"><Plus :size="15" />{{ t('desktop.localCost.addRule') }}</button></header>
    <form class="monitor-exchange exchange-form" @submit.prevent="persist({...settings,cnyPerUsd:Number(exchange)})"><label>{{ t('desktop.localCost.exchange') }}<input v-model="exchange" type="number" required min="0.000001" step="any" :disabled="saving" /></label><button class="console-icon-button" :disabled="saving" :title="t('desktop.localCost.saveExchange')" :aria-label="t('desktop.localCost.saveExchange')"><Check :size="15" /></button></form>
    <p v-if="error" class="cost-error" role="alert">{{ error }}</p>
    <form v-if="editing" class="monitor-price-editor price-editor" @submit.prevent="save">
      <header><h3>{{ t('desktop.localCost.editPrice') }}</h3><button type="button" class="console-icon-button" :disabled="saving" :title="t('costComponents.cancel')" @click="editing=false"><X :size="15" /></button></header>
      <div class="monitor-price-fields price-fields">
        <label>{{ t('desktop.localCost.model') }}<input v-model="model" maxlength="512" :placeholder="t('desktop.localCost.allModels')" :disabled="saving" /></label>
        <label>{{ t('desktop.localCost.effective') }}<input v-model="effective" type="datetime-local" required :disabled="saving" /></label>
        <label>{{ t('desktop.localCost.method') }}<select v-model="method" :disabled="saving"><option value="multiplier">{{ t('desktop.localCost.multiplier') }}</option><option value="rates">{{ t('desktop.localCost.unitPrices') }}</option></select></label>
        <label v-if="method==='multiplier'">{{ t('desktop.localCost.factor') }}<input v-model="multiplier" type="number" min="0" step="any" required :disabled="saving" /></label>
        <template v-else><label>{{ t('costComponents.currency') }}<select v-model="currency" :disabled="saving"><option>USD</option><option>CNY</option></select></label><label v-for="field in fields" :key="field">{{ t('desktop.localCost.'+field) }}<input v-model="rates[field]" type="number" min="0" step="any" :required="field==='input'||field==='output'" :disabled="saving" /></label></template>
      </div>
      <footer><span :title="t('desktop.localCost.priceNote')"><Info :size="14" />{{ t('desktop.localCost.priceHistoryKept') }}</span><button class="cost-command local-command primary-command" :disabled="saving"><Check :size="15" />{{ t('costComponents.save') }}</button></footer>
    </form>
    <div v-if="settings.apiRules.length" class="monitor-price-table"><table class="price-rules"><thead><tr><th>{{ t('desktop.localCost.model') }}</th><th>{{ t('desktop.localCost.effective') }}</th><th>{{ t('desktop.localCost.method') }}</th><th>{{ t('costComponents.actions') }}</th></tr></thead><tbody><tr v-for="rule in settings.apiRules" :key="(rule.model??'all')+':'+rule.startMs">
      <td><strong>{{ rule.model??t('desktop.localCost.allModels') }}</strong></td><td>{{ new Date(rule.startMs).toLocaleString(usageLocale()) }}</td><td><template v-if="rule.multiplier!=null">{{ rule.multiplier }}× <small>{{ t('desktop.localCost.multiplier') }}</small></template><template v-else><span v-for="field in fields.filter(field=>rule[field]!=null)" :key="field" class="saved-rate">{{ t('desktop.localCost.'+field) }} <b>{{ rule.currency }} {{ rule[field] }}</b></span><small>{{ t('desktop.localCost.perMillion') }}</small></template></td>
      <td><button type="button" class="console-icon-button" :title="t('costComponents.editFinancialEvent')" :disabled="saving" @click="open(rule)"><Pencil :size="15" /></button></td>
    </tr></tbody></table></div>
    <div v-else-if="!editing" class="monitor-price-empty pricing-empty"><SlidersHorizontal :size="28" /><h3>{{ t('desktop.localCost.noApiPrices') }}</h3><button type="button" class="cost-command local-command" :disabled="saving" @click="open()"><Plus :size="15" />{{ t('desktop.localCost.addRule') }}</button></div>
  </section>
</template>

<style scoped>
.monitor-api-prices{border-top:1px solid var(--cost-line);padding:22px 0 0;margin-top:24px}.prices-heading,.prices-heading>div,.monitor-price-editor>header,.monitor-price-editor>footer,.monitor-exchange,.cost-command,.monitor-price-editor footer>span{display:flex;align-items:center;gap:10px}.prices-heading,.monitor-price-editor>header,.monitor-price-editor>footer{justify-content:space-between;flex-wrap:wrap}.monitor-api-prices h2{font-size:15px;font-weight:550;margin:0}.monitor-api-prices h3{font-size:13px;font-weight:550;margin:0}.monitor-api-prices small,.monitor-exchange label,.monitor-price-fields label,.monitor-price-editor footer>span{font-size:11px;color:var(--cost-muted)}.monitor-api-prices :is(input,select){min-height:36px;border:1px solid var(--cost-line);border-radius:4px;background:var(--cost-panel);color:var(--cost-text);padding:7px 9px;font:inherit;font-size:12px;min-width:0}.monitor-exchange{align-items:flex-end;margin:20px 0;gap:8px}.monitor-exchange label,.monitor-price-fields label{display:flex;flex-direction:column;gap:8px}.monitor-exchange input{width:135px}.cost-command{justify-content:center;min-height:36px;padding:7px 12px;background:var(--cost-panel);border:1px solid var(--cost-line-strong);border-radius:4px;font-size:12px;color:var(--cost-text)}.cost-command:hover:not(:disabled){background:var(--cost-panel-2)}.primary-command{background:var(--cost-lime);border-color:var(--cost-lime);color:#151912}.primary-command:hover:not(:disabled){background:#caeb87}.monitor-price-editor{border:1px solid var(--cost-line-strong);border-radius:4px;background:var(--cost-panel);padding:18px;margin:18px 0 24px}.monitor-price-editor input,.monitor-price-editor select{background:var(--cost-bg)}.monitor-price-fields{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin:18px 0}.monitor-price-fields :is(input,select){width:100%}.monitor-price-table{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;padding:14px 12px;border-bottom:1px solid var(--cost-line);vertical-align:middle}th{font-size:10px;font-weight:400;color:var(--cost-muted);background:var(--cost-panel)}td small{display:block;margin-top:5px;line-height:1.5}td strong{font-weight:550}.saved-rate{display:inline-flex;gap:8px;font-size:11px;color:var(--cost-muted);margin:3px 18px 3px 0}.saved-rate b{font-weight:500;color:var(--cost-text)}.cost-error{font-size:12px;color:var(--cost-gold);overflow-wrap:anywhere}.monitor-price-empty{display:flex;flex-direction:column;align-items:center;gap:12px;padding:28px 16px;margin:18px 0;border-block:1px solid var(--cost-line);color:var(--cost-muted)}.monitor-price-empty>svg{color:var(--cost-blue)}.monitor-price-empty h3{font-weight:400}
@media(max-width:850px){.monitor-price-fields{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:550px){.monitor-price-fields{grid-template-columns:minmax(0,1fr)}.prices-heading>div{flex-wrap:wrap}.monitor-price-editor>footer{align-items:flex-start;gap:14px}}
</style>
