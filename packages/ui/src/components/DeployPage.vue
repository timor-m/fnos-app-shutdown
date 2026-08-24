<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Activity, Check, Copy, ListOrdered, RefreshCw, Trash2, Wrench } from "lucide-vue-next";
import { apiGet, apiGetText, copyToClipboard, fetchAbout, type StatusData } from "../api";
import DeployBadge from "./DeployBadge.vue";

const DATA_DIR_PLACEHOLDER = "<数据目录>";

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

// ---------- §9 命令（一字不差，仅替换 <直连端口>） ----------
// 命令经 SSH 在 NAS 本机执行：用 127.0.0.1 + 应用直连端口（wizard 配置），
// 绕开网关注销态校验与域名回环（hairpin）问题
const DEPLOY_COMMAND_TEMPLATE = `curl -fsSL "http://127.0.0.1:<直连端口>/app/fnos-app-shutdown/api/executor/script" -o /tmp/fnos-shutdown-executor.sh \\
  && DATA_DIR=<数据目录> \\
  && test -d "$DATA_DIR" \\
  && sudo install -m 700 -o root -g root /tmp/fnos-shutdown-executor.sh /usr/local/sbin/ \\
  && printf '*/10 * * * * root FNOS_SHUTDOWN_DATA_DIR=%q /usr/local/sbin/fnos-shutdown-executor.sh\\n' "$DATA_DIR" | sudo tee /etc/cron.d/fnos-shutdown \\
  && PING_BIN="$(command -v ping)" \\
  && sudo setcap cap_net_raw+ep "$PING_BIN" \\
  && sudo -u fnos-app-shutdown "$PING_BIN" -c 1 -W 1 127.0.0.1 >/dev/null \\
  && rm -f /tmp/fnos-shutdown-executor.sh`;

const VERIFY_COMMAND_TEMPLATE = `DATA_DIR=<数据目录> \\
  && test -d "$DATA_DIR" \\
  && PING_BIN="$(command -v ping)" \\
  && sudo getcap "$PING_BIN" \\
  && sudo -u fnos-app-shutdown "$PING_BIN" -c 1 -W 1 127.0.0.1 \\
  && sudo env FNOS_SHUTDOWN_DATA_DIR="$DATA_DIR" /usr/local/sbin/fnos-shutdown-executor.sh --dry-run`;

const MANUAL_INSTALL_COMMAND_TEMPLATE = `DATA_DIR=<数据目录> \\
  && test -d "$DATA_DIR" \\
  && sudo install -m 700 -o root -g root /tmp/fnos-shutdown-executor.sh /usr/local/sbin/ \\
  && printf '*/10 * * * * root FNOS_SHUTDOWN_DATA_DIR=%q /usr/local/sbin/fnos-shutdown-executor.sh\\n' "$DATA_DIR" | sudo tee /etc/cron.d/fnos-shutdown \\
  && PING_BIN="$(command -v ping)" \\
  && sudo setcap cap_net_raw+ep "$PING_BIN" \\
  && sudo -u fnos-app-shutdown "$PING_BIN" -c 1 -W 1 127.0.0.1 >/dev/null \\
  && rm -f /tmp/fnos-shutdown-executor.sh`;

const UNINSTALL_COMMAND = `sudo rm -f /usr/local/sbin/fnos-shutdown-executor.sh /etc/cron.d/fnos-shutdown`;

/** 应用直连端口（关于接口）；null = 未启用，一键命令退化为占位符并提示 */
const servicePort = ref<number | null>(null);
const dataDir = ref<string | null>(null);

function commandWithDataDir(template: string) {
  return template.replaceAll(
    DATA_DIR_PLACEHOLDER,
    dataDir.value ? shellQuote(dataDir.value) : DATA_DIR_PLACEHOLDER
  );
}

const deployCommand = computed(() =>
  commandWithDataDir(
    DEPLOY_COMMAND_TEMPLATE.replace("<直连端口>", String(servicePort.value ?? "<直连端口>"))
  )
);
const verifyCommand = computed(() => commandWithDataDir(VERIFY_COMMAND_TEMPLATE));
const manualInstallCommand = computed(() => commandWithDataDir(MANUAL_INSTALL_COMMAND_TEMPLATE));

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
      dataDir.value = a.app.storageDir || null;
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
              cron 会显式携带当前应用数据目录 <code>{{ dataDir || "未检测到" }}</code>，因此应用安装在任意存储卷都能与执行器共享配置和状态。
              同时通过 <code>sudo setcap cap_net_raw+ep "$(command -v ping)"</code> 为系统 ping 授予原始套接字能力，使低权限应用用户也能执行「主机在线」检测；不会授予应用 root 权限。
              首次部署后，应用升级时执行器会自动验签同步新版（§3.6），无需再跑命令。
            </p>
            <p v-if="servicePort === null" class="badge-hint warn">
              未检测到直连端口：请在应用设置（向导）中配置服务端口后刷新本页，或使用下方「复制脚本全文」方式部署。
            </p>
            <p v-if="dataDir === null" class="badge-hint warn">
              未检测到应用数据目录：请刷新本页后重试，不要执行仍含有 <code>&lt;数据目录&gt;</code> 占位符的命令。
            </p>
            <div class="cmd-block">
              <div class="cmd-block-head">
                <span class="cmd-title">一键部署 / 升级</span>
                <button
                  class="copy-btn"
                  :class="{ copied: copiedKey === 'deploy' }"
                  type="button"
                  :disabled="servicePort === null || dataDir === null"
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
              执行以下命令，先验证应用用户可 ping 本机，再以 root 进行一次无副作用检测。输出的版本应为 {{ status.executor.appVersion }}，<code>DATA_DIR</code> 应为 <code>{{ dataDir || "实际应用数据目录" }}</code>。
            </p>
            <div class="cmd-block">
              <div class="cmd-block-head">
                <span class="cmd-title">验证命令</span>
                <button
                  class="copy-btn"
                  :class="{ copied: copiedKey === 'verify' }"
                  type="button"
                  :disabled="dataDir === null"
                  @click="copy('verify', verifyCommand)"
                >
                  <Check v-if="copiedKey === 'verify'" :size="12" />
                  <Copy v-else :size="12" />
                  {{ copiedKey === "verify" ? "已复制" : "复制" }}
                </button>
              </div>
              <pre class="cmd-view">{{ verifyCommand }}</pre>
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
            :disabled="dataDir === null"
            @click="copy('manual', manualInstallCommand)"
          >
            <Check v-if="copiedKey === 'manual'" :size="12" />
            <Copy v-else :size="12" />
            {{ copiedKey === "manual" ? "已复制" : "复制" }}
          </button>
        </div>
        <pre class="cmd-view">{{ manualInstallCommand }}</pre>
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
