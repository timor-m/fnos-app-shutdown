<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import {
  AppWindow,
  Check,
  Clock,
  Copy,
  Cpu,
  Gauge,
  Github,
  Globe,
  Info,
  Link2,
  MemoryStick,
  MessageCircle,
  RefreshCw,
  Server,
  Tag,
  Timer,
  UserRound
} from "lucide-vue-next";
import { copyToClipboard, fetchAbout, type AboutData } from "../api";

const loading = ref(true);
const error = ref("");
const about = ref<AboutData | null>(null);
const qqCopyState = ref<"idle" | "copied" | "error">("idle");
let qqCopyTimer: ReturnType<typeof setTimeout> | null = null;

async function copyQqGroup() {
  if (!about.value) return;

  try {
    await copyToClipboard(about.value.app.qqGroup);
    qqCopyState.value = "copied";
  } catch {
    qqCopyState.value = "error";
  }

  if (qqCopyTimer) clearTimeout(qqCopyTimer);
  qqCopyTimer = setTimeout(() => {
    qqCopyState.value = "idle";
  }, 2000);
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    about.value = await fetchAbout();
  } catch (err) {
    error.value = err instanceof Error ? err.message : "加载失败";
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void load();
});

onBeforeUnmount(() => {
  if (qqCopyTimer) clearTimeout(qqCopyTimer);
});

// ---------- 展示格式化 ----------
function formatMem(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

/** 秒 → 「X 天 X 小时 X 分」（不足一天省略天，不足一小时省略小时） */
function formatUptime(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} 天`);
  if (hours > 0 || days > 0) parts.push(`${hours} 小时`);
  parts.push(`${minutes} 分`);
  return parts.join(" ");
}

const accessModeText = computed(() => {
  const mode = about.value?.app.accessMode;
  if (mode === "gateway") return "统一网关";
  if (mode === "port") return "端口直连";
  return "-";
});

/** 运行时 + Node 版本 + 接入模式合并一行 */
const runtimeText = computed(() => {
  const a = about.value?.app;
  if (!a) return "-";
  return `${a.runtime} · Node ${a.node} · ${accessModeText.value}`;
});

/** 直连端口：未启用时明示，避免与网关访问混淆 */
const servicePortText = computed(() => {
  const a = about.value?.app;
  if (!a) return "-";
  return a.servicePort ? String(a.servicePort) : "未启用";
});

/** 可用 / 总量 合并一行 */
const memText = computed(() => {
  const s = about.value?.system;
  if (!s) return "-";
  return `可用 ${formatMem(s.freememMB)} / 总量 ${formatMem(s.totalmemMB)}`;
});

const LOAD_LABELS = ["1 分钟", "5 分钟", "15 分钟"] as const;

function loadValue(index: number): string {
  const s = about.value?.system;
  if (!s || s.loadavg.length <= index) return "-";
  return s.loadavg[index].toFixed(2);
}

const platformText = computed(() => {
  const s = about.value?.system;
  if (!s) return "-";
  return `${s.platform} · ${s.arch} · ${s.release}`;
});

const cpuText = computed(() => {
  const s = about.value?.system;
  if (!s) return "-";
  return `${s.cpu.model}（${s.cpu.cores} 核）`;
});
</script>

<template>
  <div v-if="loading" class="feedback">正在读取应用与系统信息...</div>
  <div v-else-if="error" class="feedback error">
    {{ error }}
    <button class="btn small" type="button" @click="load">重试</button>
  </div>

  <template v-else-if="about">
    <!-- 应用信息 -->
    <section class="panel">
      <header class="panel-header">
        <h2 class="panel-title">
          <Info :size="18" />
          应用信息
        </h2>
        <button class="btn small" type="button" @click="load">
          <RefreshCw :size="13" />
          刷新
        </button>
      </header>
      <div class="about-list">
        <div class="about-item">
          <AppWindow :size="15" class="about-icon" />
          <span class="about-label">应用 ID</span>
          <span class="about-value" :title="about.app.appId">{{ about.app.appId }}</span>
        </div>
        <div class="about-item">
          <Info :size="15" class="about-icon" />
          <span class="about-label">名称</span>
          <span class="about-value" :title="about.app.appTitle">{{ about.app.appTitle }}</span>
        </div>
        <div class="about-item">
          <Tag :size="15" class="about-icon" />
          <span class="about-label">版本号</span>
          <span class="about-value" :title="about.app.version">{{ about.app.version }}</span>
        </div>
        <div class="about-item">
          <Globe :size="15" class="about-icon" />
          <span class="about-label">网关前缀</span>
          <span class="about-value" :title="about.app.gatewayPrefix">{{ about.app.gatewayPrefix }}</span>
        </div>
        <div class="about-item">
          <Link2 :size="15" class="about-icon" />
          <span class="about-label">直连端口</span>
          <span class="about-value" :title="servicePortText">{{ servicePortText }}</span>
        </div>
        <div class="about-item">
          <Server :size="15" class="about-icon" />
          <span class="about-label">运行时</span>
          <span class="about-value" :title="runtimeText">{{ runtimeText }}</span>
        </div>
        <div class="about-item">
          <UserRound :size="15" class="about-icon" />
          <span class="about-label">作者</span>
          <span class="about-value" :title="about.app.maintainer">
            <a class="about-link" :href="about.app.maintainerUrl" target="_blank" rel="noopener noreferrer">
              <Link2 :size="13" class="about-link-icon" />
              <span class="about-link-text">{{ about.app.maintainer }}</span>
            </a>
          </span>
        </div>
        <div class="about-item">
          <MessageCircle :size="15" class="about-icon" />
          <span class="about-label">QQ 群</span>
          <span class="about-value">
            <button
              class="about-copy"
              :class="{ copied: qqCopyState === 'copied' }"
              type="button"
              :title="qqCopyState === 'copied' ? '群号已复制' : '点击复制 QQ 群号'"
              @click="copyQqGroup"
            >
              <span class="tabular">{{ about.app.qqGroup }}</span>
              <Check v-if="qqCopyState === 'copied'" :size="14" />
              <Copy v-else :size="14" />
              <span>{{ qqCopyState === "copied" ? "已复制" : "复制" }}</span>
            </button>
            <span v-if="qqCopyState === 'error'" class="about-copy-error" role="status">
              复制失败，请手动选择群号
            </span>
          </span>
        </div>
        <div class="about-item">
          <Github :size="15" class="about-icon" />
          <span class="about-label">项目仓库</span>
          <span class="about-value" :title="about.app.repoUrl">
            <a class="about-link" :href="about.app.repoUrl" target="_blank" rel="noopener noreferrer">
              <Link2 :size="13" class="about-link-icon" />
              <span class="about-link-text">{{ about.app.repoUrl }}</span>
            </a>
          </span>
        </div>
      </div>
    </section>

    <!-- 系统信息 -->
    <section class="panel">
      <header class="panel-header">
        <h2 class="panel-title">
          <Server :size="18" />
          系统信息
        </h2>
        <span>来自运行所在 NAS 的 node:os</span>
      </header>
      <div class="about-list">
        <div class="about-item">
          <Server :size="15" class="about-icon" />
          <span class="about-label">主机名</span>
          <span class="about-value" :title="about.system.hostname">{{ about.system.hostname }}</span>
        </div>
        <div class="about-item">
          <Globe :size="15" class="about-icon" />
          <span class="about-label">系统</span>
          <span class="about-value" :title="platformText">{{ platformText }}</span>
        </div>
        <div class="about-item">
          <Cpu :size="15" class="about-icon" />
          <span class="about-label">CPU</span>
          <span class="about-value" :title="cpuText">{{ cpuText }}</span>
        </div>
        <div class="about-item">
          <MemoryStick :size="15" class="about-icon" />
          <span class="about-label">内存</span>
          <span class="about-value tabular" :title="memText">{{ memText }}</span>
        </div>
        <div class="about-item has-sub">
          <Gauge :size="15" class="about-icon" />
          <span class="about-label">负载</span>
        </div>
        <div class="about-sublist">
          <div v-for="(label, i) in LOAD_LABELS" :key="label" class="about-subitem">
            <span class="about-sublabel">{{ label }}</span>
            <span class="about-subvalue tabular">{{ loadValue(i) }}</span>
          </div>
        </div>
        <div class="about-item">
          <Clock :size="15" class="about-icon" />
          <span class="about-label">系统运行时间</span>
          <span class="about-value tabular">{{ formatUptime(about.system.uptimeSec) }}</span>
        </div>
        <div class="about-item">
          <Timer :size="15" class="about-icon" />
          <span class="about-label">应用运行时间</span>
          <span class="about-value tabular">{{ formatUptime(about.system.processUptimeSec) }}</span>
        </div>
      </div>
    </section>
  </template>
</template>
