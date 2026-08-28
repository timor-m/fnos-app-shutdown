<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { ListChecks, RotateCcw, Settings2, Undo2 } from "lucide-vue-next";
import { apiGet, apiSend, type ShutdownConfig } from "../api";

const loading = ref(true);
const loadError = ref("");
const saving = ref(false);
const saveError = ref("");
const saveOk = ref(false);
const fieldErrors = reactive<Record<string, string>>({});

/** §3.1 默认值（「恢复默认」按钮与初始表单共用） */
function defaultForm() {
  return {
    enabled: true,
    windowStart: "23:00",
    windowEnd: "08:00",
    checkIntervalSec: "60",
    maxChecks: "60",
    cpu: { enabled: true, maxPercent: "10" },
    load: { enabled: true, maxPerCore: "0.5" },
    users: { enabled: true, maxActive: "0" },
    ssh: { enabled: true, ports: "8975" },
    diskIo: { enabled: true, maxIowaitPercent: "30" },
    network: {
      enabled: true,
      maxRxKbps: "10",
      maxTxKbps: "0",
      excludeInterfaces: "lo, docker*, br-*, veth*, ovs*"
    },
    minUptime: { enabled: false, minSec: "1800" },
    smbSessions: { enabled: false },
    tcpSessions: { enabled: true, ports: "8005, 5666, 5667, 443, 80" },
    downloadActive: { enabled: false, ports: "", maxConnections: "0" },
    vmRunning: { enabled: false },
    processRunning: { enabled: false, names: "" },
    diskScrub: { enabled: false },
    hostOnline: { enabled: false, hosts: "" },
    calendarRules: { enabled: false, skipWeekdays: [] as number[], skipDates: "" }
  };
}

const form = reactive<ReturnType<typeof defaultForm>>(defaultForm());

// ---------- 未保存修改跟踪：当前表单 vs 已加载/已保存快照（深比较） ----------
const savedSnapshot = ref("");

function takeSnapshot(): string {
  return JSON.stringify(form);
}

const dirty = computed(() => savedSnapshot.value !== "" && takeSnapshot() !== savedSnapshot.value);

/** 放弃修改，恢复为已保存值 */
function resetToSaved() {
  if (!savedSnapshot.value) return;
  Object.assign(form, JSON.parse(savedSnapshot.value));
}

/** 填入 §3.1 默认值（仍需点保存才生效） */
function resetDefaults() {
  Object.assign(form, defaultForm());
}

// ---------- 总开关：即时保存立即生效（紧急开关不做表单式暂存） ----------
const masterWorking = ref(false);
const masterMsg = ref("");
const masterMsgOk = ref(true);

/**
 * 总开关切换后立即 PUT：以「上次保存的值 + 新开关状态」为负载，
 * 其余字段的未保存修改既不被带入、也不被覆盖（dirty 状态保持）。
 */
async function onMasterToggle() {
  if (!savedSnapshot.value || masterWorking.value) return;
  const baseState = JSON.parse(savedSnapshot.value) as ReturnType<typeof defaultForm>;
  baseState.enabled = form.enabled;
  const payload = buildConfig(baseState, false);
  if (!payload) return; // 快照来自已保存值，必然合法；防御
  masterWorking.value = true;
  masterMsg.value = "";
  try {
    const data = await apiSend<{ config: ShutdownConfig }>("PUT", "config", payload);
    savedSnapshot.value = JSON.stringify(baseState);
    masterMsgOk.value = true;
    masterMsg.value = data.config.enabled ? "已开启，立即生效" : "已关闭，立即生效";
  } catch (err) {
    form.enabled = !form.enabled; // 失败回滚开关
    masterMsgOk.value = false;
    masterMsg.value = err instanceof Error ? err.message : "操作失败";
  } finally {
    masterWorking.value = false;
    setTimeout(() => {
      masterMsg.value = "";
    }, 3000);
  }
}

function fillFromConfig(config: ShutdownConfig) {
  form.enabled = config.enabled;
  form.windowStart = config.window.start;
  form.windowEnd = config.window.end;
  form.checkIntervalSec = String(config.check_interval_sec);
  form.maxChecks = String(config.max_checks);
  form.cpu = { enabled: config.checks.cpu.enabled, maxPercent: String(config.checks.cpu.max_percent) };
  form.load = { enabled: config.checks.load.enabled, maxPerCore: String(config.checks.load.max_per_core) };
  form.users = { enabled: config.checks.users.enabled, maxActive: String(config.checks.users.max_active) };
  form.ssh = { enabled: config.checks.ssh.enabled, ports: config.checks.ssh.ports.join(", ") };
  form.diskIo = { enabled: config.checks.disk_io.enabled, maxIowaitPercent: String(config.checks.disk_io.max_iowait_percent) };
  form.network = {
    enabled: config.checks.network.enabled,
    maxRxKbps: String(config.checks.network.max_rx_kbps),
    maxTxKbps: String(config.checks.network.max_tx_kbps),
    excludeInterfaces: config.checks.network.exclude_interfaces.join(", ")
  };
  form.minUptime = {
    enabled: config.checks.min_uptime.enabled,
    minSec: String(config.checks.min_uptime.min_sec)
  };
  form.smbSessions = { enabled: config.checks.smb_sessions.enabled };
  form.tcpSessions = {
    enabled: config.checks.tcp_sessions.enabled,
    ports: config.checks.tcp_sessions.ports.join(", ")
  };
  form.downloadActive = {
    enabled: config.checks.download_active.enabled,
    ports: config.checks.download_active.ports.join(", "),
    maxConnections: String(config.checks.download_active.max_connections)
  };
  form.vmRunning = { enabled: config.checks.vm_running.enabled };
  form.processRunning = {
    enabled: config.checks.process_running.enabled,
    names: config.checks.process_running.names.join(", ")
  };
  form.diskScrub = { enabled: config.checks.disk_scrub.enabled };
  form.hostOnline = {
    enabled: config.checks.host_online.enabled,
    hosts: config.checks.host_online.hosts.join(", ")
  };
  form.calendarRules = {
    enabled: config.checks.calendar_rules.enabled,
    skipWeekdays: [...config.checks.calendar_rules.skip_weekdays],
    skipDates: config.checks.calendar_rules.skip_dates.join(", ")
  };
}

// ---------- 星期几多选（calendar_rules.skip_weekdays，0=周日） ----------
const WEEKDAYS: { value: number; label: string }[] = [
  { value: 0, label: "日" },
  { value: 1, label: "一" },
  { value: 2, label: "二" },
  { value: 3, label: "三" },
  { value: 4, label: "四" },
  { value: 5, label: "五" },
  { value: 6, label: "六" }
];

function toggleWeekday(value: number) {
  const list = form.calendarRules.skipWeekdays;
  const i = list.indexOf(value);
  if (i >= 0) list.splice(i, 1);
  else list.push(value);
}

// ---------- §3.1 范围校验 ----------
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 跨零点提示：start > end 时工作时段跨日 */
const crossMidnightHint = computed(() => {
  const s = form.windowStart.trim();
  const e = form.windowEnd.trim();
  if (TIME_RE.test(s) && TIME_RE.test(e) && s > e) {
    return `工作时段跨零点，将于次日 ${e} 结束`;
  }
  return "";
});

function numInRange(raw: string, min: number, max: number, integer: boolean): number | null {
  const n = Number(raw.trim());
  if (raw.trim() === "" || !Number.isFinite(n)) return null;
  if (integer && !Number.isInteger(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

/** 逗号分隔端口列表：空串 → []；全部 1–65535 整数 → number[]；否则 null */
function parsePortList(raw: string): number[] | null {
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  const parsed: number[] = [];
  for (const part of trimmed.split(",")) {
    const p = numInRange(part, 1, 65535, true);
    if (p === null) return null;
    parsed.push(p);
  }
  return parsed;
}

/** 逗号分隔字符串列表：空串 → []；每项匹配 re → string[]；否则 null */
function parseStringList(raw: string, re: RegExp): string[] | null {
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  const parsed: string[] = [];
  for (const part of trimmed.split(",")) {
    const item = part.trim();
    if (!re.test(item)) return null;
    parsed.push(item);
  }
  return parsed;
}

/** 合法 MM-DD（2 月允许到 29，4/6/9/11 月限 30 天） */
const MONTH_DAY_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function isValidMonthDay(item: string): boolean {
  if (!MONTH_DAY_RE.test(item)) return false;
  const month = Number(item.slice(0, 2));
  const day = Number(item.slice(3, 5));
  const maxDay = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day <= maxDay;
}

/** 逗号分隔 MM-DD 列表：空串 → []；全部合法月日 → string[]；否则 null */
function parseMonthDayList(raw: string): string[] | null {
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  const parsed: string[] = [];
  for (const part of trimmed.split(",")) {
    const item = part.trim();
    if (!isValidMonthDay(item)) return null;
    parsed.push(item);
  }
  return parsed;
}

/**
 * 校验并组装完整 config；全部合法返回对象，否则返回 null。
 * collectErrors 时把错误写入 fieldErrors（用于表单内联提示）；总开关即时保存时不打扰表单。
 */
function buildConfig(
  s: ReturnType<typeof defaultForm>,
  collectErrors: boolean
): ShutdownConfig | null {
  const errors: Record<string, string> = {};
  const setErr = (key: string, msg: string) => {
    errors[key] = msg;
  };
  if (collectErrors) {
    Object.keys(fieldErrors).forEach((k) => delete fieldErrors[k]);
  }

  if (!TIME_RE.test(s.windowStart.trim())) setErr("windowStart", "格式须为 HH:MM（00:00–23:59）");
  if (!TIME_RE.test(s.windowEnd.trim())) setErr("windowEnd", "格式须为 HH:MM（00:00–23:59）");
  if (TIME_RE.test(s.windowStart.trim()) && s.windowStart.trim() === s.windowEnd.trim()) {
    setErr("windowEnd", "开始与结束时间不能相同");
  }

  const interval = numInRange(s.checkIntervalSec, 10, 3600, true);
  if (interval === null) setErr("checkIntervalSec", "须为 10–3600 的整数（秒）");
  const maxChecks = numInRange(s.maxChecks, 1, 720, true);
  if (maxChecks === null) setErr("maxChecks", "须为 1–720 的整数");

  const cpuMax = numInRange(s.cpu.maxPercent, 0, 100, false);
  if (cpuMax === null) setErr("cpu.maxPercent", "须为 0–100 的数字");
  const loadMax = numInRange(s.load.maxPerCore, 0, 64, false);
  if (loadMax === null) setErr("load.maxPerCore", "须为 0–64 的数字");
  const usersMax = numInRange(s.users.maxActive, 0, 100, true);
  if (usersMax === null) setErr("users.maxActive", "须为 0–100 的整数");
  const diskMax = numInRange(s.diskIo.maxIowaitPercent, 0, 100, true);
  if (diskMax === null) setErr("diskIo.maxIowaitPercent", "须为 0–100 的整数");
  const netRxMax = numInRange(s.network.maxRxKbps, 0, 1048576, true);
  if (netRxMax === null) setErr("network.maxRxKbps", "须为 0–1048576 的整数");
  const netTxMax = numInRange(s.network.maxTxKbps, 0, 1048576, true);
  if (netTxMax === null) setErr("network.maxTxKbps", "须为 0–1048576 的整数");
  const minUptimeSec = numInRange(s.minUptime.minSec, 0, 86400, true);
  if (minUptimeSec === null) setErr("minUptime.minSec", "须为 0–86400 的整数（秒）");
  const maxConnections = numInRange(s.downloadActive.maxConnections, 0, 65535, true);
  if (maxConnections === null) setErr("downloadActive.maxConnections", "须为 0–65535 的整数");

  const sshPorts = parsePortList(s.ssh.ports);
  if (sshPorts === null) setErr("ssh.ports", "端口须为 1–65535 的整数，多个用逗号分隔");
  const tcpPorts = parsePortList(s.tcpSessions.ports);
  if (tcpPorts === null) setErr("tcpSessions.ports", "端口须为 1–65535 的整数，多个用逗号分隔");
  const downloadPorts = parsePortList(s.downloadActive.ports);
  if (downloadPorts === null) setErr("downloadActive.ports", "端口须为 1–65535 的整数，多个用逗号分隔");

  let excludes: string[] = [];
  const exclRaw = s.network.excludeInterfaces.trim();
  if (exclRaw !== "") {
    const parsed: string[] = [];
    let bad = false;
    for (const part of exclRaw.split(",")) {
      const item = part.trim();
      if (!/^[a-zA-Z0-9_*?-]{1,32}$/.test(item)) {
        bad = true;
        break;
      }
      parsed.push(item);
    }
    if (bad) setErr("network.excludeInterfaces", "每项仅限字母、数字、_ * ? -，不超过 32 字符");
    else excludes = parsed;
  }

  const processNames = parseStringList(s.processRunning.names, /^[a-zA-Z0-9_.+-]{1,64}$/);
  if (processNames === null) {
    setErr("processRunning.names", "进程名仅限字母、数字、_ . + -，不超过 64 字符，逗号分隔");
  }
  const hosts = parseStringList(s.hostOnline.hosts, /^[a-zA-Z0-9.-]{1,64}$/);
  if (hosts === null) {
    setErr("hostOnline.hosts", "主机仅限字母、数字、. -（IPv4 或主机名），不超过 64 字符，逗号分隔");
  }
  const skipWeekdays = s.calendarRules.skipWeekdays.filter(
    (d) => Number.isInteger(d) && d >= 0 && d <= 6
  );
  if (skipWeekdays.length !== s.calendarRules.skipWeekdays.length) {
    setErr("calendarRules.skipWeekdays", "星期取值须为 0–6");
  }
  const skipDates = parseMonthDayList(s.calendarRules.skipDates);
  if (skipDates === null) {
    setErr("calendarRules.skipDates", "日期须为合法 MM-DD（如 10-01），逗号分隔");
  }

  if (Object.keys(errors).length > 0) {
    if (collectErrors) {
      Object.assign(fieldErrors, errors);
    }
    return null;
  }

  return {
    enabled: s.enabled,
    window: { start: s.windowStart.trim(), end: s.windowEnd.trim() },
    check_interval_sec: interval!,
    max_checks: maxChecks!,
    checks: {
      cpu: { enabled: s.cpu.enabled, max_percent: cpuMax! },
      load: { enabled: s.load.enabled, max_per_core: loadMax! },
      users: { enabled: s.users.enabled, max_active: usersMax! },
      ssh: { enabled: s.ssh.enabled, ports: sshPorts! },
      disk_io: { enabled: s.diskIo.enabled, max_iowait_percent: diskMax! },
      network: {
        enabled: s.network.enabled,
        max_rx_kbps: netRxMax!,
        max_tx_kbps: netTxMax!,
        exclude_interfaces: excludes
      },
      min_uptime: { enabled: s.minUptime.enabled, min_sec: minUptimeSec! },
      smb_sessions: { enabled: s.smbSessions.enabled },
      tcp_sessions: { enabled: s.tcpSessions.enabled, ports: tcpPorts! },
      download_active: {
        enabled: s.downloadActive.enabled,
        ports: downloadPorts!,
        max_connections: maxConnections!
      },
      vm_running: { enabled: s.vmRunning.enabled },
      process_running: { enabled: s.processRunning.enabled, names: processNames! },
      disk_scrub: { enabled: s.diskScrub.enabled },
      host_online: { enabled: s.hostOnline.enabled, hosts: hosts! },
      calendar_rules: {
        enabled: s.calendarRules.enabled,
        skip_weekdays: [...skipWeekdays].sort((a, b) => a - b),
        skip_dates: skipDates!
      }
    }
  };
}

async function load() {
  loading.value = true;
  loadError.value = "";
  try {
    const data = await apiGet<{ config: ShutdownConfig; fallback: boolean }>("config");
    fillFromConfig(data.config);
    savedSnapshot.value = takeSnapshot();
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : "加载失败";
  } finally {
    loading.value = false;
  }
}

async function save() {
  saveError.value = "";
  saveOk.value = false;
  const config = buildConfig(form, true);
  if (!config) {
    saveError.value = "存在非法字段，请按提示修正后再保存";
    return;
  }
  saving.value = true;
  try {
    const data = await apiSend<{ config: ShutdownConfig }>("PUT", "config", config);
    fillFromConfig(data.config);
    savedSnapshot.value = takeSnapshot();
    saveOk.value = true;
    setTimeout(() => {
      saveOk.value = false;
    }, 3000);
  } catch (err) {
    saveError.value = err instanceof Error ? err.message : "保存失败";
  } finally {
    saving.value = false;
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div v-if="loading" class="feedback">正在读取配置...</div>
  <div v-else-if="loadError" class="feedback error">
    {{ loadError }}
    <button class="btn" type="button" @click="load">重试</button>
  </div>

  <template v-else>
    <!-- 全局区 -->
    <section class="panel">
      <header class="panel-header">
        <h2 class="panel-title">
          <Settings2 :size="18" />
          全局设置
        </h2>
        <span>保存后最迟一个检查周期生效</span>
      </header>

      <div class="field-row">
        <div class="field-main">
          <label class="field-label">总开关</label>
          <p class="field-desc">切换后立即生效，无需保存；关闭后执行器触发即退出，不会执行任何检查与关机。</p>
        </div>
        <label class="switch">
          <input
            v-model="form.enabled"
            type="checkbox"
            :disabled="masterWorking"
            @change="onMasterToggle"
          />
          <span class="slider"></span>
        </label>
        <span v-if="masterMsg" class="master-msg" :class="{ err: !masterMsgOk }">{{ masterMsg }}</span>
      </div>

      <div class="field-row">
        <div class="field-main">
          <label class="field-label">工作时段</label>
          <p class="field-desc">左闭右开；开始晚于结束表示跨零点（如 23:00 – 08:00）。</p>
        </div>
        <div class="field-inputs window-inputs">
          <label class="time-input-field">
            <span class="time-input-label">开始</span>
            <input
              v-model="form.windowStart"
              class="input time-input"
              type="time"
              step="60"
              aria-label="工作阶段开始时间"
            />
          </label>
          <span class="time-range-separator" aria-hidden="true">至</span>
          <label class="time-input-field">
            <span class="time-input-label">结束</span>
            <input
              v-model="form.windowEnd"
              class="input time-input"
              type="time"
              step="60"
              aria-label="工作阶段结束时间"
            />
          </label>
        </div>
      </div>
      <p v-if="fieldErrors.windowStart" class="field-error">{{ fieldErrors.windowStart }}</p>
      <p v-if="fieldErrors.windowEnd" class="field-error">{{ fieldErrors.windowEnd }}</p>
      <p v-else-if="crossMidnightHint" class="cross-hint">{{ crossMidnightHint }}</p>

      <div class="field-row">
        <div class="field-main">
          <label class="field-label">检查间隔（秒）</label>
          <p class="field-desc">监控循环每轮间隔，范围 10–3600，默认 60。</p>
        </div>
        <div class="field-inputs">
          <div class="input-wrap">
            <input v-model="form.checkIntervalSec" class="input" type="text" inputmode="numeric" />
            <span class="unit">秒</span>
          </div>
        </div>
      </div>
      <p v-if="fieldErrors.checkIntervalSec" class="field-error">{{ fieldErrors.checkIntervalSec }}</p>

      <div class="field-row">
        <div class="field-main">
          <label class="field-label">最大检查轮次</label>
          <p class="field-desc">达到轮次后本轮监控放弃关机，范围 1–720，默认 60。</p>
        </div>
        <div class="field-inputs">
          <div class="input-wrap">
            <input v-model="form.maxChecks" class="input" type="text" inputmode="numeric" />
            <span class="unit">轮</span>
          </div>
        </div>
      </div>
      <p v-if="fieldErrors.maxChecks" class="field-error">{{ fieldErrors.maxChecks }}</p>
    </section>

    <!-- 检查项区 -->
    <section class="panel">
      <header class="panel-header">
        <h2 class="panel-title">
          <ListChecks :size="18" />
          检查项
        </h2>
        <span>全部启用项通过才会关机；未启用的项视为通过</span>
      </header>

      <div class="check-grid">
        <article class="check-card" :class="{ off: !form.cpu.enabled }">
          <div class="check-head">
            <div class="field-main">
              <label class="field-label">CPU 使用率</label>
              <p class="field-desc">负载折算的 CPU 使用率不高于上限才通过。</p>
            </div>
            <div class="check-head-right">
              <span class="check-state">{{ form.cpu.enabled ? "已启用" : "已停用" }}</span>
              <label class="switch">
                <input v-model="form.cpu.enabled" type="checkbox" />
                <span class="slider"></span>
              </label>
            </div>
          </div>
          <div class="check-params" :class="{ disabled: !form.cpu.enabled }">
            <label class="param-label">使用率上限（%，0–100）</label>
            <div class="input-wrap">
              <input v-model="form.cpu.maxPercent" class="input" type="text" inputmode="decimal" :disabled="!form.cpu.enabled" />
              <span class="unit">%</span>
            </div>
            <p v-if="fieldErrors['cpu.maxPercent']" class="field-error">{{ fieldErrors["cpu.maxPercent"] }}</p>
          </div>
        </article>

        <article class="check-card" :class="{ off: !form.load.enabled }">
          <div class="check-head">
            <div class="field-main">
              <label class="field-label">系统负载</label>
              <p class="field-desc">load1 与 load5 均低于「核数 × 每核上限」才通过。</p>
            </div>
            <div class="check-head-right">
              <span class="check-state">{{ form.load.enabled ? "已启用" : "已停用" }}</span>
              <label class="switch">
                <input v-model="form.load.enabled" type="checkbox" />
                <span class="slider"></span>
              </label>
            </div>
          </div>
          <div class="check-params" :class="{ disabled: !form.load.enabled }">
            <label class="param-label">每核负载上限（0–64）</label>
            <input v-model="form.load.maxPerCore" class="input" type="text" inputmode="decimal" :disabled="!form.load.enabled" />
            <p v-if="fieldErrors['load.maxPerCore']" class="field-error">{{ fieldErrors["load.maxPerCore"] }}</p>
          </div>
        </article>

        <article class="check-card" :class="{ off: !form.users.enabled }">
          <div class="check-head">
            <div class="field-main">
              <label class="field-label">登录用户</label>
              <p class="field-desc">活跃登录用户（不含 root）不超过上限才通过。</p>
            </div>
            <div class="check-head-right">
              <span class="check-state">{{ form.users.enabled ? "已启用" : "已停用" }}</span>
              <label class="switch">
                <input v-model="form.users.enabled" type="checkbox" />
                <span class="slider"></span>
              </label>
            </div>
          </div>
          <div class="check-params" :class="{ disabled: !form.users.enabled }">
            <label class="param-label">活跃用户数上限（0–100）</label>
            <input v-model="form.users.maxActive" class="input" type="text" inputmode="numeric" :disabled="!form.users.enabled" />
            <p v-if="fieldErrors['users.maxActive']" class="field-error">{{ fieldErrors["users.maxActive"] }}</p>
          </div>
        </article>

        <article class="check-card" :class="{ off: !form.ssh.enabled }">
          <div class="check-head">
            <div class="field-main">
              <label class="field-label">SSH 连接</label>
              <p class="field-desc">所列端口均无已建立连接才通过；留空 = 自动跟随 sshd 配置的 Port（探测失败回退 22）。</p>
            </div>
            <div class="check-head-right">
              <span class="check-state">{{ form.ssh.enabled ? "已启用" : "已停用" }}</span>
              <label class="switch">
                <input v-model="form.ssh.enabled" type="checkbox" />
                <span class="slider"></span>
              </label>
            </div>
          </div>
          <div class="check-params" :class="{ disabled: !form.ssh.enabled }">
            <label class="param-label">端口列表（逗号分隔，1–65535；留空自动检测）</label>
            <input v-model="form.ssh.ports" class="input" type="text" placeholder="8975" :disabled="!form.ssh.enabled" />
            <p v-if="fieldErrors['ssh.ports']" class="field-error">{{ fieldErrors["ssh.ports"] }}</p>
          </div>
        </article>

        <article class="check-card" :class="{ off: !form.diskIo.enabled }">
          <div class="check-head">
            <div class="field-main">
              <label class="field-label">磁盘 IO</label>
              <p class="field-desc">IO 等待（iowait）低于上限才通过。</p>
            </div>
            <div class="check-head-right">
              <span class="check-state">{{ form.diskIo.enabled ? "已启用" : "已停用" }}</span>
              <label class="switch">
                <input v-model="form.diskIo.enabled" type="checkbox" />
                <span class="slider"></span>
              </label>
            </div>
          </div>
          <div class="check-params" :class="{ disabled: !form.diskIo.enabled }">
            <label class="param-label">iowait 上限（%，0–100）</label>
            <div class="input-wrap">
              <input v-model="form.diskIo.maxIowaitPercent" class="input" type="text" inputmode="numeric" :disabled="!form.diskIo.enabled" />
              <span class="unit">%</span>
            </div>
            <p v-if="fieldErrors['diskIo.maxIowaitPercent']" class="field-error">{{ fieldErrors["diskIo.maxIowaitPercent"] }}</p>
          </div>
        </article>

        <article class="check-card" :class="{ off: !form.network.enabled }">
          <div class="check-head">
            <div class="field-main">
              <label class="field-label">网络活动</label>
              <p class="field-desc">接收（与发送）速率低于上限才通过；可排除本机与容器网桥接口。</p>
            </div>
            <div class="check-head-right">
              <span class="check-state">{{ form.network.enabled ? "已启用" : "已停用" }}</span>
              <label class="switch">
                <input v-model="form.network.enabled" type="checkbox" />
                <span class="slider"></span>
              </label>
            </div>
          </div>
          <div class="check-params" :class="{ disabled: !form.network.enabled }">
            <label class="param-label">接收速率上限（KB/s，0–1048576）</label>
            <div class="input-wrap">
              <input v-model="form.network.maxRxKbps" class="input" type="text" inputmode="numeric" :disabled="!form.network.enabled" />
              <span class="unit">KB/s</span>
            </div>
            <p v-if="fieldErrors['network.maxRxKbps']" class="field-error">{{ fieldErrors["network.maxRxKbps"] }}</p>
            <label class="param-label">发送速率上限（KB/s，0–1048576；0 = 不检查 TX）</label>
            <div class="input-wrap">
              <input v-model="form.network.maxTxKbps" class="input" type="text" inputmode="numeric" :disabled="!form.network.enabled" />
              <span class="unit">KB/s</span>
            </div>
            <p v-if="fieldErrors['network.maxTxKbps']" class="field-error">{{ fieldErrors["network.maxTxKbps"] }}</p>
            <label class="param-label">排除接口（逗号分隔 glob，如 lo, docker*）</label>
            <input v-model="form.network.excludeInterfaces" class="input" type="text" :disabled="!form.network.enabled" />
            <p v-if="fieldErrors['network.excludeInterfaces']" class="field-error">{{ fieldErrors["network.excludeInterfaces"] }}</p>
          </div>
        </article>

        <article class="check-card" :class="{ off: !form.minUptime.enabled }">
          <div class="check-head">
            <div class="field-main">
              <label class="field-label">最小运行时间</label>
              <p class="field-desc">系统开机不足指定时长时不关机，防 WoL/定时唤醒后被立即关机。</p>
            </div>
            <div class="check-head-right">
              <span class="check-state">{{ form.minUptime.enabled ? "已启用" : "已停用" }}</span>
              <label class="switch">
                <input v-model="form.minUptime.enabled" type="checkbox" />
                <span class="slider"></span>
              </label>
            </div>
          </div>
          <div class="check-params" :class="{ disabled: !form.minUptime.enabled }">
            <label class="param-label">最小运行时长（0–86400）</label>
            <div class="input-wrap">
              <input v-model="form.minUptime.minSec" class="input" type="text" inputmode="numeric" :disabled="!form.minUptime.enabled" />
              <span class="unit">秒</span>
            </div>
            <p v-if="fieldErrors['minUptime.minSec']" class="field-error">{{ fieldErrors["minUptime.minSec"] }}</p>
          </div>
        </article>

        <article class="check-card" :class="{ off: !form.smbSessions.enabled }">
          <div class="check-head">
            <div class="field-main">
              <label class="field-label">SMB 会话</label>
              <p class="field-desc">存在活跃 SMB 会话时不关机。</p>
            </div>
            <div class="check-head-right">
              <span class="check-state">{{ form.smbSessions.enabled ? "已启用" : "已停用" }}</span>
              <label class="switch">
                <input v-model="form.smbSessions.enabled" type="checkbox" />
                <span class="slider"></span>
              </label>
            </div>
          </div>
        </article>

        <article class="check-card" :class="{ off: !form.tcpSessions.enabled }">
          <div class="check-head">
            <div class="field-main">
              <label class="field-label">TCP 连接</label>
              <p class="field-desc">指定端口存在 ESTABLISHED 连接时不关机（如 8005 媒体、5666 管理）。</p>
            </div>
            <div class="check-head-right">
              <span class="check-state">{{ form.tcpSessions.enabled ? "已启用" : "已停用" }}</span>
              <label class="switch">
                <input v-model="form.tcpSessions.enabled" type="checkbox" />
                <span class="slider"></span>
              </label>
            </div>
          </div>
          <div class="check-params" :class="{ disabled: !form.tcpSessions.enabled }">
            <label class="param-label">端口列表（逗号分隔，1–65535；留空 = 直接通过）</label>
            <input v-model="form.tcpSessions.ports" class="input" type="text" placeholder="8005, 5666, 5667, 443, 80" :disabled="!form.tcpSessions.enabled" />
            <p v-if="fieldErrors['tcpSessions.ports']" class="field-error">{{ fieldErrors["tcpSessions.ports"] }}</p>
          </div>
        </article>

        <article class="check-card" :class="{ off: !form.downloadActive.enabled }">
          <div class="check-head">
            <div class="field-main">
              <label class="field-label">下载活跃</label>
              <p class="field-desc">指定端口活跃连接数超阈值时不关机（qBittorrent/aria2 等下载器）。</p>
            </div>
            <div class="check-head-right">
              <span class="check-state">{{ form.downloadActive.enabled ? "已启用" : "已停用" }}</span>
              <label class="switch">
                <input v-model="form.downloadActive.enabled" type="checkbox" />
                <span class="slider"></span>
              </label>
            </div>
          </div>
          <div class="check-params" :class="{ disabled: !form.downloadActive.enabled }">
            <label class="param-label">端口列表（逗号分隔，1–65535；留空 = 连接数恒为 0）</label>
            <input v-model="form.downloadActive.ports" class="input" type="text" :disabled="!form.downloadActive.enabled" />
            <p v-if="fieldErrors['downloadActive.ports']" class="field-error">{{ fieldErrors["downloadActive.ports"] }}</p>
            <label class="param-label">活跃连接数阈值（0–65535）</label>
            <input v-model="form.downloadActive.maxConnections" class="input" type="text" inputmode="numeric" :disabled="!form.downloadActive.enabled" />
            <p v-if="fieldErrors['downloadActive.maxConnections']" class="field-error">{{ fieldErrors["downloadActive.maxConnections"] }}</p>
          </div>
        </article>

        <article class="check-card" :class="{ off: !form.vmRunning.enabled }">
          <div class="check-head">
            <div class="field-main">
              <label class="field-label">虚拟机</label>
              <p class="field-desc">有虚拟机处于运行状态时不关机（硬关机可能损坏 guest 磁盘）。</p>
            </div>
            <div class="check-head-right">
              <span class="check-state">{{ form.vmRunning.enabled ? "已启用" : "已停用" }}</span>
              <label class="switch">
                <input v-model="form.vmRunning.enabled" type="checkbox" />
                <span class="slider"></span>
              </label>
            </div>
          </div>
        </article>

        <article class="check-card" :class="{ off: !form.processRunning.enabled }">
          <div class="check-head">
            <div class="field-main">
              <label class="field-label">关键进程</label>
              <p class="field-desc">指定进程在运行时不关机（如 ffmpeg、trim.face_det）。</p>
            </div>
            <div class="check-head-right">
              <span class="check-state">{{ form.processRunning.enabled ? "已启用" : "已停用" }}</span>
              <label class="switch">
                <input v-model="form.processRunning.enabled" type="checkbox" />
                <span class="slider"></span>
              </label>
            </div>
          </div>
          <div class="check-params" :class="{ disabled: !form.processRunning.enabled }">
            <label class="param-label">进程名（精确匹配，逗号分隔；留空 = 直接通过）</label>
            <input v-model="form.processRunning.names" class="input" type="text" placeholder="ffmpeg, trim.face_det" :disabled="!form.processRunning.enabled" />
            <p v-if="fieldErrors['processRunning.names']" class="field-error">{{ fieldErrors["processRunning.names"] }}</p>
          </div>
        </article>

        <article class="check-card" :class="{ off: !form.diskScrub.enabled }">
          <div class="check-head">
            <div class="field-main">
              <label class="field-label">阵列/清洗</label>
              <p class="field-desc">RAID 重建或 btrfs scrub 进行中时不关机。</p>
            </div>
            <div class="check-head-right">
              <span class="check-state">{{ form.diskScrub.enabled ? "已启用" : "已停用" }}</span>
              <label class="switch">
                <input v-model="form.diskScrub.enabled" type="checkbox" />
                <span class="slider"></span>
              </label>
            </div>
          </div>
        </article>

        <article class="check-card" :class="{ off: !form.hostOnline.enabled }">
          <div class="check-head">
            <div class="field-main">
              <label class="field-label">主机在线</label>
              <p class="field-desc">指定 IP 在线（ping 可达）时不关机，如电视/手机/电脑。</p>
            </div>
            <div class="check-head-right">
              <span class="check-state">{{ form.hostOnline.enabled ? "已启用" : "已停用" }}</span>
              <label class="switch">
                <input v-model="form.hostOnline.enabled" type="checkbox" />
                <span class="slider"></span>
              </label>
            </div>
          </div>
          <div class="check-params" :class="{ disabled: !form.hostOnline.enabled }">
            <label class="param-label">IP / 主机名（逗号分隔；留空 = 直接通过）</label>
            <input v-model="form.hostOnline.hosts" class="input" type="text" placeholder="192.168.1.10, 192.168.1.20" :disabled="!form.hostOnline.enabled" />
            <p v-if="fieldErrors['hostOnline.hosts']" class="field-error">{{ fieldErrors["hostOnline.hosts"] }}</p>
          </div>
        </article>

        <article class="check-card" :class="{ off: !form.calendarRules.enabled }">
          <div class="check-head">
            <div class="field-main">
              <label class="field-label">日历规则</label>
              <p class="field-desc">命中跳过规则的日期不关机。</p>
            </div>
            <div class="check-head-right">
              <span class="check-state">{{ form.calendarRules.enabled ? "已启用" : "已停用" }}</span>
              <label class="switch">
                <input v-model="form.calendarRules.enabled" type="checkbox" />
                <span class="slider"></span>
              </label>
            </div>
          </div>
          <div class="check-params" :class="{ disabled: !form.calendarRules.enabled }">
            <label class="param-label">跳过星期（点选，可多选）</label>
            <div class="weekday-row">
              <button
                v-for="d in WEEKDAYS"
                :key="d.value"
                type="button"
                class="weekday-btn"
                :class="{ on: form.calendarRules.skipWeekdays.includes(d.value) }"
                :disabled="!form.calendarRules.enabled"
                @click="toggleWeekday(d.value)"
              >
                {{ d.label }}
              </button>
            </div>
            <p v-if="fieldErrors['calendarRules.skipWeekdays']" class="field-error">{{ fieldErrors["calendarRules.skipWeekdays"] }}</p>
            <label class="param-label">跳过日期（MM-DD，逗号分隔，如 10-01）</label>
            <input v-model="form.calendarRules.skipDates" class="input" type="text" placeholder="10-01, 01-01" :disabled="!form.calendarRules.enabled" />
            <p v-if="fieldErrors['calendarRules.skipDates']" class="field-error">{{ fieldErrors["calendarRules.skipDates"] }}</p>
          </div>
        </article>
      </div>
    </section>

    <div class="save-bar">
      <p v-if="saveError" class="field-error save-msg">{{ saveError }}</p>
      <p v-else-if="saveOk" class="save-msg save-ok">已保存，最迟一个检查周期后生效。</p>
      <span v-else-if="dirty" class="save-msg dirty-hint">
        <span class="dirty-dot"></span>
        有未保存修改
      </span>
      <button class="btn" type="button" title="填入默认值（仍需保存才生效）" @click="resetDefaults">
        <Undo2 :size="14" />
        恢复默认
      </button>
      <button v-if="dirty" class="btn" type="button" title="放弃修改，恢复为已保存值" @click="resetToSaved">
        <RotateCcw :size="14" />
        重置
      </button>
      <button class="btn primary" type="button" :disabled="saving" @click="save">
        {{ saving ? "保存中..." : "保存设置" }}
      </button>
    </div>
  </template>
</template>
