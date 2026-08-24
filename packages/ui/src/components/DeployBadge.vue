<script setup lang="ts">
import { computed, type Component } from "vue";
import { AlertCircle, AlertTriangle, CheckCircle2, XCircle } from "lucide-vue-next";
import { formatTime, type ExecutorState, type StatusJson } from "../api";

const props = defineProps<{
  state: ExecutorState;
  status: StatusJson | null;
  appVersion?: string;
}>();

const badge = computed<{ icon: Component; label: string; cls: string; hint: string }>(() => {
  switch (props.state) {
    case "undeployed":
      return { icon: XCircle, label: "未部署", cls: "badge-danger", hint: "尚未检测到执行器，请前往「部署向导」完成部署" };
    case "ok":
      return { icon: CheckCircle2, label: "正常", cls: "badge-ok", hint: "" };
    case "outdated":
      return { icon: AlertTriangle, label: "版本过旧", cls: "badge-warn", hint: "" };
    case "stalled":
      return { icon: AlertCircle, label: "运行异常", cls: "badge-stalled", hint: "超过 20 分钟未收到执行器心跳，cron 可能失效" };
  }
});

const detail = computed(() => {
  if (props.state === "outdated") {
    const current = props.status?.script_version || "未知";
    const expected = props.appVersion || "未知";
    return `执行器版本 ${current}，应用包内版本 ${expected}；cron 下次触发（≤10 分钟）自动验签同步，也可重跑一键命令立即升级`;
  }
  if (props.state === "stalled") {
    return `最近一次触发：${formatTime(props.status?.last_trigger)}`;
  }
  return "";
});
</script>

<template>
  <div class="deploy-badge-wrap">
    <span class="deploy-badge" :class="badge.cls">
      <component :is="badge.icon" :size="15" class="badge-icon" />
      <span class="badge-label">{{ badge.label }}</span>
    </span>
    <p v-if="badge.hint || detail" class="badge-hint">{{ detail || badge.hint }}</p>
  </div>
</template>
