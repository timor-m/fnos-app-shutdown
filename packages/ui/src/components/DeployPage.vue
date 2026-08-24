<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Activity, Check, Copy, ListOrdered, RefreshCw, Trash2, Wrench } from "lucide-vue-next";
import { apiGet, apiGetText, copyToClipboard, fetchAbout, type StatusData } from "../api";
import DeployBadge from "./DeployBadge.vue";

// ---------- §9 命令（一字不差，仅替换 <直连端口>） ----------
// 命令经 SSH 在 NAS 本机执行：用 127.0.0.1 + 应用直连端口（wizard 配置），
// 绕开网关注销态校验与域名回环（hairpin）问题
const DEPLOY_COMMAND_TEMPLATE = `curl -fsSL "http://127.0.0.1:<直连端口>/app/fnos-app-shutdown/api/executor/script" -o /tmp/fnos-shutdown-executor.sh \\
  && sudo install -m 700 -o root -g root /tmp/fnos-shutdown-executor.sh /usr/local/sbin/ \\
  && printf '*/10 * * * * root /usr/local/sbin/fnos-shutdown-executor.sh\\n' | sudo tee /etc/cron.d/fnos-shutdown \\
  && APP_GID="$(id -g fnos-app-shutdown)" \\
  && PING_GID_RANGE="$(awk -v gid="$APP_GID" '{ min=$1; max=$2; if (gid < min) min=gid; if (gid > max) max=gid; print min, max }' /proc/sys/net/ipv4/ping_group_range)" \\
  && sudo install -d -m 755 -o root -g root /etc/sysctl.d /var/lib/fnos-shutdown \\
  && { sudo test -f /var/lib/fnos-shutdown/ping-group-range.original || cat /proc/sys/net/ipv4/ping_group_range | sudo tee /var/lib/fnos-shutdown/ping-group-range.original >/dev/null; } \\
  && printf 'net.ipv4.ping_group_range = %s\\n' "$PING_GID_RANGE" | sudo tee /etc/sysctl.d/99-fnos-shutdown-ping.conf >/dev/null \\
  && sudo sysctl -w "net.ipv4.ping_group_range=$PING_GID_RANGE" \\
  && sudo -u fnos-app-shutdown ping -c 1 -W 1 127.0.0.1 >/dev/null \\
  && rm -f /tmp/fnos-shutdown-executor.sh`;

const VERIFY_COMMAND = `sudo -u fnos-app-shutdown ping -c 1 -W 1 127.0.0.1 \\
  && sudo /usr/local/sbin/fnos-shutdown-executor.sh --version`;

const MANUAL_INSTALL_COMMAND = `sudo install -m 700 -o root -g root /tmp/fnos-shutdown-executor.sh /usr/local/sbin/ \\
  && printf '*/10 * * * * root /usr/local/sbin/fnos-shutdown-executor.sh\\n' | sudo tee /etc/cron.d/fnos-shutdown \\
  && APP_GID="$(id -g fnos-app-shutdown)" \\
  && PING_GID_RANGE="$(awk -v gid="$APP_GID" '{ min=$1; max=$2; if (gid < min) min=gid; if (gid > max) max=gid; print min, max }' /proc/sys/net/ipv4/ping_group_range)" \\
  && sudo install -d -m 755 -o root -g root /etc/sysctl.d /var/lib/fnos-shutdown \\
  && { sudo test -f /var/lib/fnos-shutdown/ping-group-range.original || cat /proc/sys/net/ipv4/ping_group_range | sudo tee /var/lib/fnos-shutdown/ping-group-range.original >/dev/null; } \\
  && printf 'net.ipv4.ping_group_range = %s\\n' "$PING_GID_RANGE" | sudo tee /etc/sysctl.d/99-fnos-shutdown-ping.conf >/dev/null \\
  && sudo sysctl -w "net.ipv4.ping_group_range=$PING_GID_RANGE" \\
  && sudo -u fnos-app-shutdown ping -c 1 -W 1 127.0.0.1 >/dev/null \\
  && rm -f /tmp/fnos-shutdown-executor.sh`;

const UNINSTALL_COMMAND = `PING_GID_RANGE="$(sudo cat /var/lib/fnos-shutdown/ping-group-range.original 2>/dev/null || true)" \\
  && sudo rm -f /usr/local/sbin/fnos-shutdown-executor.sh /etc/cron.d/fnos-shutdown /etc/sysctl.d/99-fnos-shutdown-ping.conf \\
  && { [ -z "$PING_GID_RANGE" ] || sudo sysctl -w "net.ipv4.ping_group_range=$PING_GID_RANGE"; } \\
  && sudo rm -f /var/lib/fnos-shutdown/ping-group-range.original \\
  && { sudo rmdir /var/lib/fnos-shutdown 2>/dev/null || true; }`;

/** 应用直连端口（关于接口）；null = 未启用，一键命令退化为占位符并提示 */
const servicePort = ref<number | null>(null);

const deployCommand = computed(() =>
  DEPLOY_COMMAND_TEMPLATE.replace("<直连端口>", String(servicePort.value ?? "<直连端口>"))
);

// ---------- 部署状态 ----------
const loading = ref(true);
const error = ref("");
const status = ref<StatusData | null>(null);

async function load() {
  loading.value = true;
  error.value = "";
  try {
    status.value = await apiGet<StatusData>("status");
  } catch (err) {
    error.value = err instanceof Error ? err.message : "加载失败";
  } finally {
    loading.value = false;
  }
}

// ---------- 复制 ----------
const copiedKey = ref("");
let copiedTimer: ReturnType<typeof setTimeout> | null = null;

async function copy(key: string, text: string) {
  try {
    await copyToClipboard(text);
    copiedKey.value = key;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copiedKey.value = "";
    }, 2000);
  } catch {
    copiedKey.value = "";
    copyError.value = "复制失败，请手动选择文本复制";
  }
}

const copyError = ref("");

// ---------- 备选：复制脚本全文 ----------
const scriptLoading = ref(false);

async function copyScript() {
  scriptLoading.value = true;
  copyError.value = "";
  try {
    const text = await apiGetText("executor/script");
    await copy("script", text);
  } catch (err) {
    copyError.value = err instanceof Error ? err.message : "获取脚本失败";
  } finally {
    scriptLoading.value = false;
  }
}

onMounted(() => {
  void load();
  // 直连端口用于生成一键命令；失败不影响主流程（命令保留占位符并提示）
  fetchAbout()
    .then((a) => {
      servicePort.value = a.app.servicePort;
    })
    .catch(() => {});
});
</script>

<template>
  <div v-if="loading" class="feedback">正在读取部署状态...</div>
  <div v-else-if="error" class="feedback error">
    {{ error }}
    <button class="btn small" type="button" @click="load">重试</button>
  </div>

  <template v-else-if="status">
    <!-- 部署状态卡片 -->
    <section class="panel">
      <header class="panel-header">
        <h2 class="panel-title">
          <Activity :size="18" />
          部署状态
        </h2>
        <button class="btn small" type="button" @click="load">
          <RefreshCw :size="13" />
          刷新
        </button>
      </header>
      <DeployBadge
        :state="status.executor.state"
        :status="status.executor.status"
        :app-version="status.executor.appVersion"
      />
      <p v-if="status.executor.state === 'outdated'" class="badge-hint warn">
        执行器脚本版本低于应用包内版本。cron 下次触发（≤10 分钟）会自动验签同步；也可在 NAS 上重跑下方一键命令立即升级（命令幂等，可重复执行）。
      </p>
      <p v-else-if="status.executor.state === 'undeployed'" class="badge-hint">
        在 NAS 上通过 SSH 执行下方一键命令完成部署；部署后 cron 最迟 10 分钟内首次触发，此处转为「正常」。
      </p>
    </section>

    <!-- 部署步骤 -->
    <section class="panel">
      <header class="panel-header">
        <h2 class="panel-title">
          <ListOrdered :size="18" />
          部署步骤
        </h2>
        <span>命令幂等，可重复执行</span>
      </header>

      <div class="steps">
        <div class="step">
          <span class="step-num">1</span>
          <div class="step-body">
            <p class="step-title">复制一键命令（首次部署 / 手动修复）</p>
            <p class="field-desc">
              命令会从本应用下载执行器脚本（127.0.0.1 直连端口，免网关注销态）、安装到 <code>/usr/local/sbin/</code> 并写入 cron（每 10 分钟触发一次）。
              同时仅为应用用户开放 ICMP Echo socket，使「主机在线」可在低权限手动检测中正常使用；不会授予应用 root 或 <code>CAP_NET_RAW</code>。
              首次部署后，应用升级时执行器会自动验签同步新版（§3.6），无需再跑命令。
            </p>
            <p v-if="servicePort === null" class="badge-hint warn">
              未检测到直连端口：请在应用设置（向导）中配置服务端口后刷新本页，或使用下方「复制脚本全文」方式部署。
            </p>
            <div class="cmd-block">
              <div class="cmd-block-head">
                <span class="cmd-title">一键部署 / 升级</span>
                <button
                  class="copy-btn"
                  :class="{ copied: copiedKey === 'deploy' }"
                  type="button"
                  @click="copy('deploy', deployCommand)"
                >
                  <Check v-if="copiedKey === 'deploy'" :size="12" />
                  <Copy v-else :size="12" />
                  {{ copiedKey === "deploy" ? "已复制" : "复制" }}
                </button>
              </div>
              <pre class="cmd-view">{{ deployCommand }}</pre>
            </div>
          </div>
        </div>

        <div class="step">
          <span class="step-num">2</span>
          <div class="step-body">
            <p class="step-title">SSH 登录 NAS 执行</p>
            <p class="field-desc">
              通过 SSH 登录 NAS，粘贴并执行上面复制的命令。安装完成后 cron 最迟 10 分钟内首次触发执行器。
            </p>
          </div>
        </div>

        <div class="step">
          <span class="step-num">3</span>
          <div class="step-body">
            <p class="step-title">验证部署结果</p>
            <p class="field-desc">
              执行以下命令，先验证应用用户可 ping 本机，再输出执行器版本号（应为 {{ status.executor.appVersion }}）；上方部署状态随后自动转为「正常」。
            </p>
            <div class="cmd-block">
              <div class="cmd-block-head">
                <span class="cmd-title">验证命令</span>
                <button
                  class="copy-btn"
                  :class="{ copied: copiedKey === 'verify' }"
                  type="button"
                  @click="copy('verify', VERIFY_COMMAND)"
                >
                  <Check v-if="copiedKey === 'verify'" :size="12" />
                  <Copy v-else :size="12" />
                  {{ copiedKey === "verify" ? "已复制" : "复制" }}
                </button>
              </div>
              <pre class="cmd-view">{{ VERIFY_COMMAND }}</pre>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 备选方案 -->
    <section class="panel">
      <header class="panel-header">
        <h2 class="panel-title">
          <Wrench :size="18" />
          备选方案：手动安装脚本
        </h2>
        <span>网关鉴权导致一键命令 curl 失败时使用</span>
      </header>
      <p class="field-desc block-desc">
        点击下方「复制脚本全文」，在 NAS 上将内容保存为 <code>/tmp/fnos-shutdown-executor.sh</code>，
        然后执行以下命令完成安装（与一键命令的后半段相同）：
      </p>
      <div class="actions-row">
        <button class="btn primary" type="button" :disabled="scriptLoading" @click="copyScript">
          <Check v-if="copiedKey === 'script'" :size="14" />
          <Copy v-else :size="14" />
          {{ copiedKey === "script" ? "已复制" : scriptLoading ? "获取中..." : "复制脚本全文" }}
        </button>
      </div>
      <div class="cmd-block">
        <div class="cmd-block-head">
          <span class="cmd-title">手动安装命令</span>
          <button
            class="copy-btn"
            :class="{ copied: copiedKey === 'manual' }"
            type="button"
            @click="copy('manual', MANUAL_INSTALL_COMMAND)"
          >
            <Check v-if="copiedKey === 'manual'" :size="12" />
            <Copy v-else :size="12" />
            {{ copiedKey === "manual" ? "已复制" : "复制" }}
          </button>
        </div>
        <pre class="cmd-view">{{ MANUAL_INSTALL_COMMAND }}</pre>
      </div>
      <p v-if="copyError" class="badge-hint warn">{{ copyError }}</p>
    </section>

    <!-- 卸载执行器 -->
    <section class="panel">
      <header class="panel-header">
        <h2 class="panel-title">
          <Trash2 :size="18" />
          卸载执行器
        </h2>
        <span>手动操作</span>
      </header>
      <p class="field-desc block-desc">
        卸载本应用<strong>不会</strong>自动移除执行器；如需移除，请在 NAS 上手动执行。命令会同时移除 ICMP 配置并恢复部署前的允许 GID 范围：
      </p>
      <div class="cmd-block">
        <div class="cmd-block-head">
          <span class="cmd-title">卸载命令</span>
          <button
            class="copy-btn"
            :class="{ copied: copiedKey === 'uninstall' }"
            type="button"
            @click="copy('uninstall', UNINSTALL_COMMAND)"
          >
            <Check v-if="copiedKey === 'uninstall'" :size="12" />
            <Copy v-else :size="12" />
            {{ copiedKey === "uninstall" ? "已复制" : "复制" }}
          </button>
        </div>
        <pre class="cmd-view">{{ UNINSTALL_COMMAND }}</pre>
      </div>
    </section>
  </template>
</template>
