<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, type Component } from "vue";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  History,
  MinusCircle,
  MoonStar,
  Power,
  RefreshCw,
  Repeat,
  ScanSearch,
  X,
  XCircle
} from "lucide-vue-next";
import {
  apiGet,
  apiSend,
  fetchDryRun,
  formatTime,
  type DryRunCheckResult,
  type DryRunData,
  type ExecutorState,
  type StatusData
} from "../api";
import { formatClock, formatCountdown, formatRelative } from "../utils";

const emit = defineEmits<{ (e: "open-deploy"): void }>();

const POLL_INTERVAL_MS = 30_000;

const loading = ref(true);
const error = ref("");
const status = ref<StatusData | null>(null);
const nowTs = ref(Date.now());

let timer: ReturnType<typeof setInterval> | null = null;

async function loadStatus(silent = false) {
  if (!silent) {
    loading.value = true;
    error.value = "";
  }
  try {
    status.value = await apiGet<StatusData>("status");
    nowTs.value = Date.now();
  } catch (err) {
    if (!silent) error.value = err instanceof Error ? err.message : "加载失败";
  } finally {
    loading.value = false;
  }
}

// ---------- 部署异常横幅（ok 时不占视觉空间，仅异常态提示并引导去部署页） ----------
const deployBanner = computed<{ cls: string; text: string } | null>(() => {
  const s = status.value;
  if (!s) return null;
  const state: ExecutorState = s.executor.state;
  switch (state) {
    case "undeployed":
      return { cls: "danger", text: "尚未检测到执行器，自动关机不会生效，请先完成部署。" };
    case "outdated":
      return {
        cls: "warn",
        text: `执行器版本过旧（脚本 ${s.executor.status?.script_version || "未知"} · 应用 ${s.executor.appVersion}），cron 下次触发（≤10 分钟）将自动验签同步；也可到部署页重跑一键命令立即升级。`
      };
    case "stalled":
      return { cls: "warn", text: "超过 20 分钟未收到执行器心跳，cron 可能失效，请到部署向导检查。" };
    default:
      return null;
  }
});

// ---------- 今晚跳过（§5-B） ----------
const skipActive = computed(() => Boolean(status.value?.skip?.active));

/** 总开关：关闭时执行器入口即退出，skip.json 不会被读取，跳过状态不得显示「生效中」 */
const masterEnabled = computed(() => Boolean(status.value?.config?.enabled));
const skipEffective = computed(() => skipActive.value && masterEnabled.value);

/** 跳过状态主文案（skipUntil 为空 = skip.json 损坏的 fail-safe，§3.2） */
const skipStateText = computed(() => {
  const skip = status.value?.skip;
  if (!skip?.active) return "未跳过";
  if (!masterEnabled.value) return "已暂停";
  if (!skip.skipUntil) return "fail-safe 生效中";
  return "生效中";
});

/** 跳过截止时刻，独立一行展示 */
const skipUntilDetail = computed(() => {
  const skip = status.value?.skip;
  if (!skip?.active || !skip.skipUntil) return "";
  const until = `持续至 ${formatClock(skip.skipUntil)}`;
  return masterEnabled.value ? until : `总开关关闭 · ${until}`;
});

const skipWorking = ref(false);
const skipError = ref("");

async function toggleSkip() {
  skipWorking.value = true;
  skipError.value = "";
  try {
    if (skipActive.value) {
      await apiSend("DELETE", "skip");
    } else {
      await apiSend("POST", "skip");
    }
    await loadStatus(true);
  } catch (err) {
    skipError.value = err instanceof Error ? err.message : "操作失败";
  } finally {
    skipWorking.value = false;
  }
}

// ---------- 运行状态行 ----------
const lastActionText = computed(() => {
  const action = status.value?.executor.status?.last_action;
  if (!action) return null;
  const map: Record<string, string> = {
    disabled: "总开关已关闭，未进入监控",
    skipped: "今晚跳过生效，未进入监控",
    out_of_window: "触发时不在工作阶段内",
    monitoring: "正在监控循环中",
    window_end: "监控中离开工作阶段，正常结束",
    max_rounds_reached: "达到最大检查轮次，未关机",
    poweroff: "全部检查通过，已发起关机"
  };
  return { text: map[action] || `未知状态：${action}`, time: status.value?.executor.status?.last_trigger };
});

/** 距工作阶段开始 / 结束的分钟级倒计时，随 30s 轮询刷新 */
const phaseCountdown = computed(() => {
  const t = status.value?.tonight;
  if (!t) return "";
  if (t.inWindow) {
    const end = new Date(t.windowEnd).getTime();
    if (Number.isNaN(end)) return "";
    return `约 ${formatCountdown(end - nowTs.value)}后结束`;
  }
  const start = new Date(t.windowStart).getTime();
  if (Number.isNaN(start)) return "";
  return `约 ${formatCountdown(start - nowTs.value)}后进入工作`;
});

const currentPhaseText = computed(() => {
  const t = status.value?.tonight;
  if (!t) return "-";
  if (t.monitoring) return "工作阶段 · 监控中";
  return t.inWindow ? "工作阶段" : "休息阶段";
});

// ---------- 手动检测关机条件（executor --dry-run，§4.1 零副作用） ----------
const showCheck = ref(false);
const checkRunning = ref(false);
const checkError = ref("");
const checkResult = ref<DryRunData | null>(null);

async function runChecks() {
  showCheck.value = true;
  checkRunning.value = true;
  checkError.value = "";
  try {
    checkResult.value = await fetchDryRun();
  } catch (err) {
    checkResult.value = null;
    checkError.value = err instanceof Error ? err.message : "检测失败";
  } finally {
    checkRunning.value = false;
  }
}

/** 主按钮：结果展开中再点 = 收起；否则重新拉取 */
function onCheckClick() {
  if (showCheck.value && !checkRunning.value) {
    showCheck.value = false;
    return;
  }
  void runChecks();
}

const CHECK_NAME_ZH: Record<string, string> = {
  cpu: "CPU 使用率",
  load: "系统负载",
  users: "登录用户",
  ssh: "SSH 连接",
  disk_io: "磁盘 IO",
  network: "网络活动",
  min_uptime: "最小运行时间",
  smb_sessions: "SMB 会话",
  tcp_sessions: "TCP 连接",
  download_active: "下载活跃",
  vm_running: "虚拟机",
  process_running: "关键进程",
  disk_scrub: "阵列清洗",
  host_online: "主机在线",
  calendar_rules: "日历规则"
};

const RESULT_ICON: Record<DryRunCheckResult, Component> = {
  pass: CheckCircle2,
  busy: XCircle,
  skip: MinusCircle,
  fail: AlertTriangle
};

const RESULT_CLASS: Record<DryRunCheckResult, string> = {
  pass: "text-ok",
  busy: "cr-danger",
  skip: "cr-muted",
  fail: "text-warn"
};

onMounted(() => {
  void loadStatus();
  timer = setInterval(() => void loadStatus(true), POLL_INTERVAL_MS);
});

onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div v-if="loading" class="skeleton-block">
    <div class="skeleton" style="width: 32%"></div>
    <div class="skeleton" style="width: 68%"></div>
    <div class="skeleton" style="width: 54%"></div>
    <div class="skeleton" style="width: 61%"></div>
  </div>
  <div v-else-if="error" class="feedback error">
    {{ error }}
    <button class="btn small" type="button" @click="loadStatus()">重试</button>
  </div>

  <template v-else-if="status">
    <!-- 部署异常横幅（ok 时不渲染） -->
    <div v-if="deployBanner" class="status-banner" :class="deployBanner.cls">
      <AlertTriangle :size="16" class="banner-icon" />
      <p>{{ deployBanner.text }}</p>
      <button class="btn small" type="button" @click="emit('open-deploy')">前往部署向导</button>
    </div>

    <!-- 紧凑状态面板 -->
    <section class="panel">
      <header class="panel-header">
        <h2 class="panel-title">
          <Activity :size="18" />
          运行状态
        </h2>
        <span>每 30 秒自动刷新</span>
      </header>

      <div class="status-grid">
        <div class="status-item">
          <Power :size="15" class="status-icon" />
          <span class="status-label">总开关</span>
          <span class="status-value" :class="status.config.enabled ? 'text-ok' : 'text-muted'">
            {{ status.config.enabled ? "已启用" : "已停用" }}
          </span>
        </div>
        <div class="status-item">
          <Activity :size="15" class="status-icon" />
          <span class="status-label">当前阶段</span>
          <span class="status-value" :class="status.tonight.monitoring ? 'text-ok' : ''">
            <span v-if="status.tonight.monitoring" class="dot"></span>
            {{ currentPhaseText }}
            <span v-if="phaseCountdown" class="text-muted">（{{ phaseCountdown }}）</span>
          </span>
        </div>
        <div class="status-item">
          <Clock :size="15" class="status-icon" />
          <span class="status-label">工作时段</span>
          <span class="status-value">
            {{ formatClock(status.tonight.windowStart) }} – {{ formatClock(status.tonight.windowEnd) }}
          </span>
        </div>
        <div class="status-item">
          <Repeat :size="15" class="status-icon" />
          <span class="status-label">检查节奏</span>
          <span class="status-value">
            每 {{ status.config.checkIntervalSec }} 秒 · 最多 {{ status.config.maxChecks }} 轮
          </span>
        </div>
        <div class="status-item span-all">
          <MoonStar :size="15" class="status-icon" />
          <span class="status-label">今晚跳过</span>
          <span class="status-value" :class="skipEffective ? 'text-warn' : 'text-muted'">
            <span>{{ skipStateText }}</span>
            <span v-if="skipUntilDetail" class="skip-detail">{{ skipUntilDetail }}</span>
          </span>
          <button
            class="btn small skip-btn"
            :class="skipActive ? 'danger' : 'primary'"
            type="button"
            :disabled="skipWorking"
            @click="toggleSkip"
          >
            {{ skipWorking ? "处理中..." : skipActive ? "取消跳过" : "今晚跳过" }}
          </button>
        </div>
        <div v-if="lastActionText" class="status-item span-all">
          <History :size="15" class="status-icon" />
          <span class="status-label">最近动作</span>
          <span class="status-value status-action">
            {{ lastActionText.text }} · {{ formatRelative(lastActionText.time, nowTs) }}
            <span class="text-muted">（{{ formatTime(lastActionText.time) }}）</span>
          </span>
        </div>
      </div>

      <p v-if="status.executor.status?.config_fallback" class="badge-hint warn status-hint">
        执行器读取配置时触发了默认值兜底（config_fallback），请到「设置」页检查并重新保存配置。
      </p>

      <p v-if="skipError" class="badge-hint warn status-hint">{{ skipError }}</p>

      <!-- 手动检测入口：基于当前配置执行一次完整检查（只读，无副作用） -->
      <div class="status-actions">
        <p>基于当前配置立即执行一次完整检查，只读无副作用。</p>
        <div class="actions-btns">
          <button class="btn small" type="button" :disabled="checkRunning" @click="onCheckClick">
            <ScanSearch :size="14" :class="{ spinning: checkRunning }" />
            {{ checkRunning ? "检测中..." : showCheck ? "收起检测结果" : "检测关机条件" }}
          </button>
        </div>
      </div>

      <!-- 关机条件检测结果（dry-run 十五项） -->
      <div v-if="showCheck" class="checkrun">
        <div class="checkrun-head">
          <template v-if="checkRunning">
            <span class="checkrun-summary">正在检测...</span>
          </template>
          <template v-else-if="checkError">
            <span class="checkrun-summary bad">检测失败</span>
          </template>
          <template v-else-if="checkResult">
            <component
              :is="checkResult.overall === 'pass' ? CheckCircle2 : XCircle"
              :size="16"
              :class="checkResult.overall === 'pass' ? 'text-ok' : 'cr-danger'"
            />
            <span class="checkrun-summary" :class="checkResult.overall === 'pass' ? 'ok' : 'bad'">
              {{ checkResult.overall === "pass" ? "当前满足关机条件" : "当前不满足关机条件" }}
            </span>
            <span class="text-muted">{{ formatTime(checkResult.ranAt) }}</span>
          </template>
          <span class="checkrun-spacer"></span>
          <button
            class="icon-btn"
            type="button"
            :disabled="checkRunning"
            title="重新检测"
            @click="runChecks"
          >
            <RefreshCw :size="13" :class="{ spinning: checkRunning }" />
          </button>
          <button class="icon-btn" type="button" title="关闭" @click="showCheck = false">
            <X :size="13" />
          </button>
        </div>
        <p v-if="checkError" class="checkrun-error">{{ checkError }}</p>
        <p
          v-else-if="checkResult?.executionMode === 'unprivileged'"
          class="badge-hint warn status-hint"
        >
          当前为低权限检测；SMB、虚拟机和 Btrfs 清洗可能因权限显示失败。请到部署页重新执行一键部署命令，以获得与 root 执行器一致的结果。
        </p>
        <div v-if="checkResult" class="checkrun-list">
          <div v-for="c in checkResult.checks" :key="c.name" class="checkrun-item">
            <component :is="RESULT_ICON[c.result]" :size="15" :class="RESULT_CLASS[c.result]" />
            <span class="checkrun-name">{{ CHECK_NAME_ZH[c.name] || c.name }}</span>
            <span class="checkrun-detail" :title="c.detail">
              {{ c.enabled ? c.detail : "未启用（视为通过）" }}
            </span>
          </div>
        </div>
      </div>
    </section>
  </template>
</template>
