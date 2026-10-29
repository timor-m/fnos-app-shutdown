<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { AlarmClock, Check, CircleAlert, Clock3, Plus, RefreshCw, Save, Trash2 } from "lucide-vue-next";
import { apiGet, apiSend, type WakeConfig, type WakeData, type WakePlan } from "../api";
import TimePicker from "./TimePicker.vue";
import SelectField from "./SelectField.vue";

const props = defineProps<{ active: boolean }>();
const emit = defineEmits<{ "open-deploy": [] }>();
const data = ref<WakeData | null>(null);
const draft = ref<WakeConfig | null>(null);
const revision = ref("");
const baseline = ref("");
const loading = ref(false);
const inspecting = ref(false);
let requestEpoch = 0;
const saving = ref(false);
const error = ref("");
const message = ref("");
const removedPlan = ref<{ plan: WakePlan; index: number } | null>(null);
function removePlan(index: number) {
  if (!draft.value) return;
  const [plan] = draft.value.plans.splice(index, 1);
  removedPlan.value = { plan, index };
}
function undoRemove() {
  if (!draft.value || !removedPlan.value || draft.value.plans.length >= 64) return;
  draft.value.plans.splice(removedPlan.value.index, 0, removedPlan.value.plan);
  removedPlan.value = null;
}
function matchesDays(plan: WakePlan, selected: number[]) {
  return plan.weekdays.length === selected.length && selected.every(d => plan.weekdays.includes(d));
}
const dirty = computed(() => !!draft.value && JSON.stringify(draft.value) !== baseline.value);
const days = [{ value: 1, label: "一" }, { value: 2, label: "二" }, { value: 3, label: "三" }, { value: 4, label: "四" }, { value: 5, label: "五" }, { value: 6, label: "六" }, { value: 0, label: "日" }];
const selectedDevice = computed(() => {
  if (!data.value || !draft.value) return null;
  if (draft.value.device !== "auto") return data.value.devices.find(d => d.id === draft.value!.device) || null;
  const available = data.value.devices.filter(d => d.available);
  return available.length === 1 ? available[0] : null;
});
const deviceOptions = computed(() => {
  const options = [{ value: "auto", label: "自动（唯一可用设备）" }, ...(data.value?.devices || []).map(d => ({ value: d.id, label: `${d.id} · ${d.name}${d.available ? '' : '（不可用）'}` }))];
  if (draft.value && !options.some(option => option.value === draft.value!.device)) options.push({ value: draft.value.device, label: `${draft.value.device}（未检测到）` });
  return options;
});
const alarmOptions = [{ value: "preserve", label: "保留外部闹钟（推荐）" }, { value: "replace", label: "接管并覆盖已有闹钟" }];
const conflicts = computed(() => {
  const slots = new Set<string>();
  const errors: string[] = [];
  for (const [i, p] of (draft.value?.plans || []).entries()) {
    if (!p.weekdays.length) errors.push(`第 ${i + 1} 条计划需要选择星期`);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(p.time)) errors.push(`第 ${i + 1} 条计划时间无效`);
    if (!p.enabled) continue;
    for (const day of p.weekdays) {
      const slot = `${day}-${p.time}`;
      if (slots.has(slot)) errors.push(`第 ${i + 1} 条计划与其他启用计划重复`);
      slots.add(slot);
    }
  }
  return [...new Set(errors)];
});
const stale = computed(() => {
  const state = data.value?.state;
  return !state?.checked_at || Date.parse(data.value!.server_time) - Date.parse(state.checked_at) > 180_000;
});
const pending = computed(() => data.value && JSON.stringify(data.value.config) !== JSON.stringify(data.value.state?.applied_config));
const statusText = computed(() => {
  if (!data.value?.installed) return "需要部署开机计划服务";
  if (stale.value) return "尚未收到近期执行器心跳";
  if (data.value.state?.result === "error") return "闹钟同步失败";
  if (pending.value) return "等待执行器应用配置";
  return data.value.state?.result === "armed" ? "闹钟已写入并校验" : "开机计划已停用";
});

function accept(result: WakeData, replaceDraft: boolean) {
  data.value = result;
  if (replaceDraft) {
    draft.value = JSON.parse(JSON.stringify(result.config));
    removedPlan.value = null;
    baseline.value = JSON.stringify(draft.value);
    revision.value = result.revision;
  }
}
async function load(quiet = false) {
  if (loading.value || saving.value || (!props.active && quiet)) return;
  const epoch = ++requestEpoch;
  loading.value = true;
  if (!quiet) { error.value = ""; inspecting.value = true; }
  try {
    const result = await apiGet<WakeData>("wake");
    if (epoch === requestEpoch) accept(result, !dirty.value);
  }
  catch (err) { if (!quiet) error.value = err instanceof Error ? err.message : "加载失败"; }
  finally { loading.value = false; inspecting.value = false; }
}
async function save() {
  if (!draft.value || conflicts.value.length) return;
  ++requestEpoch;
  saving.value = true; error.value = ""; message.value = "";
  try {
    accept(await apiSend<WakeData>("PUT", "wake", { revision: revision.value, config: draft.value }), true);
    message.value = "配置已保存，执行器约一分钟内同步闹钟；以执行状态为准。";
  } catch (err) { error.value = err instanceof Error ? err.message : "保存失败"; }
  finally { saving.value = false; }
}
function reset() { if (data.value) { accept(data.value, true); message.value = "已恢复服务器上的配置"; } }
function add() {
  if (!draft.value || draft.value.plans.length >= 64) return;
  // Works on fnOS HTTP origins where crypto.randomUUID may not be exposed.
  const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
  draft.value.plans.push({ id: Array.from(bytes, b => b.toString(16).padStart(2, "0")).join(""), enabled: true, time: "08:00", weekdays: [1, 2, 3, 4, 5], note: "" });
  message.value = "";
}
function toggleDay(plan: WakePlan, day: number) {
  plan.weekdays = plan.weekdays.includes(day) ? plan.weekdays.filter(d => d !== day) : [...plan.weekdays, day].sort();
}
function fmt(at: string) {
  // ISO returned by the NAS already contains its timezone; never convert to browser timezone.
  return at.slice(0, 16).replace("T", " ");
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value) { event.preventDefault(); event.returnValue = ""; }
}
let timer: ReturnType<typeof setInterval>;
onMounted(() => { window.addEventListener("beforeunload", beforeUnload); void load(); timer = setInterval(() => void load(true), 15000); });
onBeforeUnmount(() => { clearInterval(timer); window.removeEventListener("beforeunload", beforeUnload); });
</script>

<template>
  <div class="wake-page">
    <div v-if="error" class="feedback error" role="alert">{{ error }} <button class="btn small" @click="load()">重试读取</button></div>
    <div v-if="loading && !data" class="feedback" role="status">正在检测开机支持…</div>
    <template v-if="data && draft">
      <section class="panel">
        <header class="panel-header">
          <h2 class="panel-title"><AlarmClock :size="18" /> 开机支持检测</h2>
          <button class="btn small" :disabled="loading || saving" @click="load()"><RefreshCw :size="14" /> {{ inspecting ? "检测中…" : "重新检测" }}</button>
        </header>
        <div class="wake-detection-grid">
          <div class="wake-summary"><span class="field-desc">RTC 唤醒接口</span><strong>{{ selectedDevice ? '接口可用 · ' + selectedDevice.id : data.devices.length ? '需要选择或检查设备' : '未发现 RTC 接口' }}</strong><span class="field-desc">{{ selectedDevice?.name || '请确认设备提供 RTC wakealarm 接口。' }}</span></div>
          <div class="wake-summary"><span class="field-desc">闹钟执行状态</span><strong :class="{ 'wake-warning': stale || pending || data.state?.result === 'error' }">{{ statusText }}</strong><span class="field-desc">{{ data.state?.checked_at ? '最近检查 ' + fmt(data.state.checked_at) : '尚无同步记录' }}</span></div>
          <div class="wake-summary"><span class="field-desc">关机后唤醒能力</span><strong>需要实机验证</strong><span class="field-desc">接口可用或写入成功，均不能证明主板能从关机状态唤醒。</span></div>
        </div>
        <p v-if="!data.installed" class="wake-notice wake-deploy-notice"><span>首次使用需部署开机计划服务。</span><button class="btn small" @click="emit('open-deploy')">前往部署</button></p>
        <p v-if="data.state?.error || data.status_error" class="feedback error" role="alert">{{ data.state?.error || data.status_error }}</p>
        <details class="wake-help"><summary>如何验证关机后自动开机？</summary><p>先在 BIOS / UEFI 中开启 RTC 唤醒，保持设备电源接通。创建距离现在至少 5 分钟的开机计划，保存后等待“闹钟已写入并校验”，再自行正常关机，观察设备是否按时启动。此页面不会自动关机测试。</p><p>只读检测无法确认 BIOS 设置、关机供电及固件唤醒能力；异常断电也无法保证执行关机前同步。ARM 设备尤其需要逐机验证。</p></details>
      </section>

      <section class="panel">
        <header class="panel-header"><h2 class="panel-title"><Clock3 :size="18" /> 开机计划配置</h2><span>按 NAS 时间 · {{ data.timezone }} · {{ fmt(data.server_time) }}</span></header>
        <p v-if="data.config_error" class="feedback error">原配置无法读取：{{ data.config_error }}。下方显示关闭状态的默认配置，保存将替换损坏配置。</p>
        <fieldset :disabled="saving" class="wake-fieldset">
          <div class="wake-options">
            <label class="wake-master">
              <span><strong>定时开机</strong><small>{{ draft.enabled ? '已开启 · 按保存的计划唤醒设备' : '已关闭 · 可先编辑计划' }}</small></span>
              <input v-model="draft.enabled" class="wake-switch" role="switch" aria-label="启用定时开机" type="checkbox" />
            </label>
            <div class="wake-field"><span>唤醒设备</span><SelectField v-model="draft.device" :options="deviceOptions" aria-label="唤醒设备" :disabled="saving" /></div>
            <div class="wake-field"><span>已有闹钟处理</span><SelectField :model-value="draft.alarm_policy" :options="alarmOptions" aria-label="已有闹钟处理" :disabled="saving" @update:model-value="draft.alarm_policy = $event as WakeConfig['alarm_policy']" /></div>
          </div>
          <p v-if="draft.alarm_policy === 'replace'" class="wake-notice wake-warning">接管模式会覆盖其他应用设置的 RTC 闹钟，请先停用其他定时开机工具，避免反复争用。</p>
          <p class="field-desc wake-config-hint">独立于智能关机开关。闹钟准备失败或距开机不足 2 分钟时，暂停自动关机。</p>
          <details v-if="data.devices.length" class="wake-help wake-device-list"><summary>设备检测详情 · {{ data.devices.length }} 个 RTC</summary><div v-for="d in data.devices" :key="d.id"><strong>{{ d.id }}</strong> · {{ d.available ? '接口可读，时钟偏差 ' + (d.offset! / 3600) + ' 小时' : d.error }}<span v-if="d.alarm"> · 当前闹钟原始值 {{ d.alarm }}</span></div></details>
          <div class="wake-toolbar"><span class="wake-list-title">开机时间 <span class="wake-count">{{ draft.plans.length }}</span></span><div class="actions-row"><button v-if="draft.plans.length > 1" class="btn small" @click="draft.plans.forEach(p => p.enabled = true)">全部启用</button><button v-if="draft.plans.length > 1" class="btn small" @click="draft.plans.forEach(p => p.enabled = false)">全部停用</button><button class="btn primary small" :disabled="draft.plans.length >= 64" @click="add"><Plus :size="14" /> 新增计划</button></div></div>
          <div v-if="!draft.plans.length" class="wake-empty"><AlarmClock :size="30" /><strong>还没有开机计划</strong><span>添加每天、工作日、周末或指定星期的开机时间。</span><button class="btn" @click="add">添加第一个计划</button></div>
          <article v-for="(plan, index) in draft.plans" :key="plan.id" class="wake-plan" :class="{ 'wake-plan-off': !plan.enabled }">
            <div class="wake-plan-head"><label class="wake-enable"><input v-model="plan.enabled" class="wake-switch" role="switch" :aria-label="'启用计划 ' + (index + 1)" type="checkbox" /><span>计划 {{ index + 1 }}</span><small class="wake-plan-state">{{ plan.enabled ? '已启用' : '已停用' }}</small></label><button class="btn small wake-delete" :aria-label="'删除计划 ' + (index + 1)" title="删除计划（可撤销）" @click="removePlan(index)"><Trash2 :size="16" /><span>删除</span></button></div>
            <div class="wake-plan-fields"><div class="wake-field"><span>开机时间</span><TimePicker v-model="plan.time" :aria-label="'计划 ' + (index + 1) + ' 开机时间'" /></div><label class="wake-field">备注<input v-model="plan.note" class="input" maxlength="120" placeholder="例如：工作日早上开机" /></label></div>
            <div class="wake-repeat"><span class="field-desc">重复</span><div class="wake-presets"><button type="button" :aria-pressed="matchesDays(plan, [0,1,2,3,4,5,6])" :class="{ selected: matchesDays(plan, [0,1,2,3,4,5,6]) }" @click="plan.weekdays = [0,1,2,3,4,5,6]">每天</button><button type="button" :aria-pressed="matchesDays(plan, [1,2,3,4,5])" :class="{ selected: matchesDays(plan, [1,2,3,4,5]) }" @click="plan.weekdays = [1,2,3,4,5]">工作日</button><button type="button" :aria-pressed="matchesDays(plan, [0,6])" :class="{ selected: matchesDays(plan, [0,6]) }" @click="plan.weekdays = [0,6]">周末</button></div><div class="wake-days" role="group" :aria-label="'计划 ' + (index + 1) + ' 重复星期'"><button v-for="day in days" :key="day.value" :aria-pressed="plan.weekdays.includes(day.value)" :aria-label="'星期' + day.label" :class="{ selected: plan.weekdays.includes(day.value) }" @click="toggleDay(plan, day.value)">{{ day.label }}</button></div></div>
          </article>
          <div v-if="removedPlan" class="wake-undo" role="status"><span>已删除计划，保存后生效</span><button class="btn small" :disabled="draft.plans.length >= 64" @click="undoRemove">撤销删除</button></div>
        </fieldset>
        <p v-for="conflict in conflicts" :key="conflict" class="wake-warning" role="alert"><CircleAlert :size="14" /> {{ conflict }}</p>
        <div class="wake-save" :class="{ 'is-dirty': dirty }"><span role="status">{{ dirty ? '有未保存的修改' : message || '更改保存后约一分钟生效' }}</span><div class="actions-row"><button class="btn" :disabled="saving || !dirty" @click="reset">撤销修改</button><button class="btn primary" :disabled="saving || conflicts.length > 0 || (!dirty && !data.config_error)" @click="save"><Save :size="15" /> {{ saving ? '保存中…' : '保存配置' }}</button></div></div>
      </section>

      <section class="panel"><header class="panel-header"><h2 class="panel-title"><Clock3 :size="18" /> 未来 7 天</h2><span>依据已保存配置 · NAS 时间</span></header><p v-if="!data.config.enabled" class="wake-notice wake-preview-note">定时开机已关闭 · 以下为计划预览</p><p v-if="dirty" class="field-desc">当前编辑尚未保存，预览将在保存后更新。</p><div v-if="data.next_wake" class="wake-next"><span>下一计划时间</span><strong>{{ fmt(data.next_wake.at) }}</strong><span>{{ data.next_wake.note }}</span></div><div v-if="!data.preview.length" class="wake-empty">未来 7 天没有启用的开机计划。</div><ol v-else class="wake-preview"><li v-for="event in data.preview" :key="event.id + event.timestamp"><time>{{ fmt(event.at) }}</time><span>{{ event.note || '定时开机' }}</span></li></ol></section>
      <section v-if="data.state?.history?.length" class="panel"><header class="panel-header"><h2 class="panel-title"><Check :size="18" /> 最近同步记录</h2></header><ul class="wake-history"><li v-for="(item, i) in data.state.history" :key="i"><time>{{ fmt(item.at) }}</time><span>{{ item.message }}</span></li></ul></section>
    </template>
  </div>
</template>

<style scoped>
/* One compact scale for mouse and touch; no competing minimum-height overrides. */
.wake-page { display: grid; gap: 10px; font-size: 12px; }
.wake-page > .panel { margin-top: 0; padding: 12px; }
.panel-header { gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
.panel-title { font-size: 14px; gap: 6px; }
.panel-header > span, .wake-page .field-desc { font-size: 12px; line-height: 1.5; }
.wake-page .btn { box-sizing: border-box; height: 30px; min-height: 0; padding: 0 9px; gap: 4px; border-radius: 6px; font-size: 12px; line-height: 1; font-weight: 500; background: var(--bg-card); box-shadow: none; transform: none; }
.wake-page .btn.primary { background: var(--brand); border-color: var(--brand); color: white; }
.wake-page .btn:disabled { opacity: .5; cursor: default; }
.wake-page .btn:not(:disabled):active { background: var(--brand-soft); color: var(--brand-text); }
.wake-page .btn svg { width: 13px; height: 13px; }
.wake-page button, .wake-master, .wake-enable { touch-action: manipulation; -webkit-tap-highlight-color: transparent; }
.wake-page button:focus-visible, .wake-page input:focus-visible, .wake-page select:focus-visible, .wake-help summary:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.wake-detection-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.wake-summary { display: grid; align-content: start; gap: 4px; padding: 10px; background: var(--bg-inset); border-radius: 6px; }
.wake-summary strong { font-size: 13px; line-height: 1.5; }
.wake-summary .field-desc { margin: 0; }
.wake-notice { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding: 6px 8px; margin: 8px 0; background: var(--brand-soft); border-radius: 6px; line-height: 1.5; }
.wake-deploy-notice { justify-content: space-between; }
.wake-deploy-notice > span { flex: 1; min-width: 140px; }
.wake-help { margin-top: 6px; color: var(--text-2); font-size: 12px; line-height: 1.6; }
.wake-help summary { cursor: pointer; color: var(--brand-text); padding: 5px 0; }
.wake-help p { margin: 6px 0; }
.wake-warning { color: var(--warning); }
.wake-fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
.wake-options { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; align-items: center; }
.wake-master { display: flex; justify-content: space-between; align-items: center; gap: 10px; grid-column: 1 / -1; padding-bottom: 8px; border-bottom: 1px solid var(--border); cursor: pointer; }
.wake-master strong { font-size: 13px; font-weight: 600; }
.wake-master small { margin-left: 10px; color: var(--text-2); font-size: 12px; font-weight: 400; }
.wake-field { display: grid; gap: 4px; font-size: 12px; min-width: 0; color: var(--text-2); }
.wake-field .input, .wake-plan-fields :deep(.time-picker-trigger) { box-sizing: border-box; width: 100%; height: 30px; min-height: 0; padding: 4px 8px; font-family: inherit; font-size: 13px; line-height: 20px; border-radius: 6px; }
.wake-plan-fields :deep(.time-picker-trigger) { gap: 5px; }
.wake-plan-fields :deep(.time-picker-trigger svg) { width: 14px; height: 14px; }
input.wake-switch { appearance: none; -webkit-appearance: none; box-sizing: border-box; flex-shrink: 0; width: 30px; height: 18px; margin: 0; padding: 0; border: 1px solid var(--border-strong); border-radius: 12px; background: var(--bg-inset); position: relative; cursor: pointer; }
input.wake-switch::after { content: ''; position: absolute; left: 2px; top: 2px; width: 12px; height: 12px; background: var(--text-2); border-radius: 50%; }
input.wake-switch:checked { background: var(--brand); border-color: var(--brand); }
input.wake-switch:checked::after { background: white; transform: translateX(12px); }
input.wake-switch:disabled { cursor: default; opacity: .5; }
.wake-config-hint { margin: 8px 0; }
.wake-device-list { margin: 6px 0; overflow-wrap: anywhere; }
.wake-toolbar, .wake-plan-head, .wake-save { display: flex; justify-content: space-between; gap: 6px; align-items: center; flex-wrap: wrap; }
.wake-toolbar { margin: 10px 0 6px; padding-top: 8px; border-top: 1px solid var(--border); }
.wake-list-title, .wake-enable { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; }
.wake-count { display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 3px; background: var(--bg-inset); border-radius: 4px; font-size: 11px; color: var(--text-2); }
.wake-page .actions-row { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; }
.wake-empty { display: grid; justify-items: center; gap: 8px; padding: 18px 10px; text-align: center; color: var(--text-2); border: 1px dashed var(--border-strong); border-radius: 6px; }
.wake-plan { border: 1px solid var(--border); border-radius: 7px; padding: 8px; margin-top: 6px; }
.wake-plan-off { background: var(--bg-inset); }
.wake-plan-head { margin-bottom: 6px; }
.wake-enable { cursor: pointer; }
.wake-plan-state { font-size: 11px; color: var(--text-2); font-weight: 400; }
.wake-page .wake-delete { height: 26px; padding: 0 5px; background: transparent; border-color: transparent; color: var(--text-2); }
.wake-page .wake-delete:hover { color: var(--danger); background: var(--danger-soft); }
.wake-plan-fields { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 8px; }
.wake-repeat { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; margin-top: 8px; }
.wake-presets, .wake-days { display: flex; gap: 4px; }
.wake-presets { padding: 2px; border-radius: 5px; background: var(--bg-inset); }
.wake-presets button { height: 24px; min-height: 0; padding: 0 7px; border: 0; border-radius: 4px; background: transparent; color: var(--text-2); font: inherit; cursor: pointer; }
.wake-presets button.selected { color: var(--brand-text); background: var(--bg-card); box-shadow: var(--shadow-sm); }
.wake-days button { box-sizing: border-box; flex: 0 0 28px; width: 28px; height: 28px; padding: 0; background: var(--bg-card); color: var(--text-2); border: 1px solid var(--border); border-radius: 5px; font: inherit; cursor: pointer; }
.wake-days button.selected { background: var(--brand-soft); color: var(--brand-text); border-color: var(--brand); }
.wake-days button:disabled, .wake-presets button:disabled { opacity: .5; cursor: default; }
.wake-undo { display: flex; gap: 6px; align-items: center; justify-content: space-between; margin-top: 6px; padding: 4px 8px; background: var(--bg-inset); border-radius: 6px; color: var(--text-2); }
.wake-save { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border); color: var(--text-2); }
.wake-save > span { flex: 1; min-width: 150px; }
.wake-save .actions-row { margin-left: auto; }
.wake-save.is-dirty > span { color: var(--brand-text); }
.wake-save.is-dirty > span::before { content: ''; display: inline-block; width: 5px; height: 5px; margin-right: 5px; border-radius: 50%; background: var(--brand); }
.wake-preview-note { background: var(--bg-inset); color: var(--text-2); }
.wake-next { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; background: var(--brand-soft); color: var(--brand-text); padding: 8px; border-radius: 6px; margin-bottom: 8px; }
.wake-next strong { font-size: 15px; }
.wake-preview, .wake-history { list-style: none; margin: 0; padding: 0; max-height: 380px; overflow-y: auto; }
.wake-preview li, .wake-history li { display: grid; grid-template-columns: 124px minmax(0, 1fr); gap: 8px; padding: 7px 0; border-bottom: 1px solid var(--border); }
.wake-preview span, .wake-history span { overflow-wrap: anywhere; }
time { font-variant-numeric: tabular-nums; white-space: nowrap; color: var(--text-2); }
@media (max-width: 760px) {
  .wake-page > .panel { padding: 10px; }
  .wake-detection-grid { grid-template-columns: 1fr; gap: 0; border-radius: 6px; overflow: hidden; }
  .wake-summary { grid-template-columns: 90px minmax(0, 1fr); align-items: baseline; gap: 2px 8px; padding: 7px 8px; border-radius: 0; }
  .wake-summary + .wake-summary { border-top: 1px solid var(--border); }
  .wake-summary > .field-desc:first-child { grid-column: 1; grid-row: 1 / 3; }
  .wake-summary strong, .wake-summary > .field-desc:last-child { grid-column: 2; }
  .wake-options { grid-template-columns: 1fr; gap: 6px; }
  .wake-options > .wake-field { grid-template-columns: 90px minmax(0, 1fr); align-items: center; gap: 8px; }
}
@media (max-width: 480px) {
  .wake-master small { display: block; margin: 3px 0 0; }
  .wake-days { flex-basis: 100%; }
  .wake-presets { margin-left: auto; }
  .wake-toolbar .actions-row { gap: 4px; }
}
@media (hover: none) {
  .wake-page .btn:not(:disabled):hover { transform: none; box-shadow: none; }
}
</style>
