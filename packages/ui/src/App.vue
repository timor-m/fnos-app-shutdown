<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, type Component } from "vue";
import { Gauge, Info, Moon, Package, Rocket, ScrollText, Settings, Sun } from "lucide-vue-next";
import appIcon from "./assets/app-icon.png";
import StatusPage from "./components/StatusPage.vue";
import SettingsPage from "./components/SettingsPage.vue";
import LogsPage from "./components/LogsPage.vue";
import DeployPage from "./components/DeployPage.vue";
import AboutPage from "./components/AboutPage.vue";

type TabKey = "status" | "settings" | "logs" | "deploy" | "about";

const tabs: { key: TabKey; label: string; icon: Component }[] = [
  { key: "status", label: "状态", icon: Gauge },
  { key: "settings", label: "设置", icon: Settings },
  { key: "logs", label: "日志", icon: ScrollText },
  { key: "deploy", label: "部署", icon: Package },
  { key: "about", label: "关于", icon: Info }
];

const activeTab = ref<TabKey>("status");

// ---------- 主题：明亮 / 暗黑，默认跟随系统，选择持久化 ----------
type Theme = "light" | "dark";
const THEME_KEY = "fnos-shutdown-theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");

const theme = ref<Theme>(readInitialTheme());

function readInitialTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return media.matches ? "dark" : "light";
}

function applyTheme(value: Theme) {
  document.documentElement.dataset.theme = value;
}

function toggleTheme() {
  theme.value = theme.value === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, theme.value);
  applyTheme(theme.value);
}

function onSystemThemeChange(e: MediaQueryListEvent) {
  // 仅在用户未手动选择过时跟随系统
  if (!localStorage.getItem(THEME_KEY)) {
    theme.value = e.matches ? "dark" : "light";
    applyTheme(theme.value);
  }
}

applyTheme(theme.value);

// ---------- 回顶小火箭：滚动超过两个视口高度时出现 ----------
const showBackTop = ref(false);
let scrollTicking = false;

function onWindowScroll() {
  if (scrollTicking) return;
  scrollTicking = true;
  requestAnimationFrame(() => {
    showBackTop.value = window.scrollY > 2 * window.innerHeight;
    scrollTicking = false;
  });
}

function backToTop() {
  window.scrollTo({ top: 0, behavior: "smooth" });
}

onMounted(() => {
  media.addEventListener("change", onSystemThemeChange);
  window.addEventListener("scroll", onWindowScroll, { passive: true });
});

onBeforeUnmount(() => {
  media.removeEventListener("change", onSystemThemeChange);
  window.removeEventListener("scroll", onWindowScroll);
});
</script>

<template>
  <!-- 吸顶栏：logo + 标签导航 + 主题切换，滚动时固定在顶部 -->
  <header class="topbar">
    <div class="topbar-inner">
      <div class="app-title">
        <img class="app-logo" :src="appIcon" alt="智能关机" />
        <div class="app-title-text">
          <h1>智能关机</h1>
          <p>工作阶段内检测到系统持续空闲时自动关机</p>
        </div>
      </div>
      <nav class="tabs">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          class="tab"
          :class="{ active: activeTab === tab.key }"
          type="button"
          :title="tab.label"
          :aria-label="tab.label"
          @click="activeTab = tab.key"
        >
          <component :is="tab.icon" :size="16" />
          <span class="tab-label">{{ tab.label }}</span>
        </button>
      </nav>
      <button
        class="theme-toggle"
        type="button"
        :title="theme === 'dark' ? '切换到明亮主题' : '切换到暗黑主题'"
        :aria-label="theme === 'dark' ? '切换到明亮主题' : '切换到暗黑主题'"
        @click="toggleTheme"
      >
        <Sun v-if="theme === 'dark'" :size="18" />
        <Moon v-else :size="18" />
      </button>
    </div>
  </header>

  <main class="shell">
    <StatusPage v-if="activeTab === 'status'" @open-deploy="activeTab = 'deploy'" />
    <SettingsPage v-else-if="activeTab === 'settings'" />
    <LogsPage v-else-if="activeTab === 'logs'" />
    <DeployPage v-else-if="activeTab === 'deploy'" />
    <AboutPage v-else />
  </main>

  <!-- 右下角：回顶小火箭 -->
  <Transition name="back-top">
    <button
      v-if="showBackTop"
      class="back-top"
      type="button"
      title="回到顶部"
      aria-label="回到顶部"
      @click="backToTop"
    >
      <Rocket :size="20" />
    </button>
  </Transition>
</template>
