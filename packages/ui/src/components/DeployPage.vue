<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { Activity, Check, Copy, ListOrdered, RefreshCw, Trash2, Wrench } from "lucide-vue-next";
import { apiGet, apiGetText, copyToClipboard, fetchAbout, type StatusData } from "../api";
import DeployBadge from "./DeployBadge.vue";

const DATA_DIR_PLACEHOLDER = "<数据目录>";

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

// ---------- §9 命令（变量化展示） ----------
// 命令经 SSH 在 NAS 本机执行：用 127.0.0.1 + 应用直连端口（wizard 配置），
// 绕开网关注销态校验与域名回环（hairpin）问题
const DEPLOY_COMMAND_TEMPLATE = `(
D=<数据目录>
U="http://127.0.0.1:<直连端口>/app/fnos-app-shutdown/api/executor/script"
T="$(mktemp)" || exit 1
trap 'rm -f "$T"' EXIT

curl -fsSL "$U" -o "$T" \\
  && sudo bash "$T" --install "$D"
)`;

const VERIFY_COMMAND_TEMPLATE = `sudo /usr/local/sbin/fnos-shutdown-executor.sh --verify-installation`;

const MANUAL_INSTALL_COMMAND_TEMPLATE = `sudo bash /tmp/fnos-shutdown-executor.sh --install <数据目录> \\
  && rm -f /tmp/fnos-shutdown-executor.sh`;

const UNINSTALL_COMMAND = `sudo /usr/local/sbin/fnos-shutdown-executor.sh --uninstall`;

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
const commandError = ref("");

async function loadCommandConfig() {
  commandError.value = "";
  try {
    const about = await fetchAbout();
    servicePort.value = about.app.servicePort;
    dataDir.value = about.app.storageDir || null;
  } catch (err) {
    commandError.value = err instanceof Error ? err.message : "部署命令参数读取失败";
  }
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const [result] = await Promise.all([apiGet<StatusData>("status"), loadCommandConfig()]);
    status.value = result;
  } catch (err) {
    error.value = err instanceof Error ? err.message : "加载失败";
  } finally {
    loading.value = false;
  }
}

// ---------- 复制 ----------
const copiedKey = ref("");
let copiedTimer: ReturnType<typeof setTimeout> | null = null;
const manualCopyText = ref("");
const manualCopyInput = ref<HTMLTextAreaElement | null>(null);

async function copy(key: string, text: string) {
  copyError.value = "";
  manualCopyText.value = "";
  if ((key === "deploy" || key === "manual") && !dataDir.value) {
    copyError.value = "尚未取得数据目录，请点击刷新重试后再复制部署命令。";
    return;
  }
  if (key === "deploy" && servicePort.value === null) {
    copyError.value = "尚未取得直连端口，请刷新重试；若未启用直连端口，请使用下方手动安装方式。";
    return;
  }
  try {
    await copyToClipboard(text);
    copiedKey.value = key;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copiedKey.value = "";
    }, 2000);
  } catch {
    copiedKey.value = "";
    copyError.value = "浏览器未允许自动复制，已选中下方文本，请按 Ctrl+C（Mac：⌘C），手机可长按复制。";
    manualCopyText.value = text;
    await nextTick();
    manualCopyInput.value?.focus();
    manualCopyInput.value?.select();
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

onMounted(() => { void load(); });
</script>

<template>
  <div class="deploy-page">
  <div v-if="copyError" class="feedback" role="alert">
    <p>{{ copyError }}</p>
    <textarea v-if="manualCopyText" ref="manualCopyInput" class="manual-copy-input" :value="manualCopyText" readonly rows="8" aria-label="手动复制命令或脚本" />
  </div>
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
      <p v-if="status.executor.statusReadError" class="badge-hint warn">
        无法读取执行器状态文件（{{ status.executor.statusReadError }}）。请检查应用数据目录与 executor 目录权限；版本号验证成功不代表状态文件可读。
      </p>
      <p v-if="status.executor.state === 'outdated'" class="badge-hint warn">
        执行器版本较旧，将在下次 cron 触发时自动更新；也可重跑一键命令立即升级。
      </p>
      <p v-else-if="status.executor.state === 'undeployed'" class="badge-hint">
        请通过 SSH 执行下方命令完成部署。
      </p>
    </section>

    <!-- 部署步骤 -->
    <section class="panel">
      <header class="panel-header">
        <h2 class="panel-title">
          <ListOrdered :size="18" />
          部署步骤
        </h2>
        <span>首次使用开机计划需重新部署</span>
      </header>

      <div class="steps">
        <div class="step">
          <span class="step-num">1</span>
          <div class="step-body">
            <p class="step-title">复制部署命令</p>
            <p class="field-desc">
              安装执行器、开机计划服务、cron 和必要的 sudo 检测权限。需要系统 Python 3.8+。
            </p>
            <p v-if="servicePort === null" class="badge-hint warn">
              未检测到服务端口，请先完成端口配置或使用下方手动安装方式。
            </p>
            <p v-if="dataDir === null" class="badge-hint warn">
              未检测到应用数据目录，请刷新后重试。
            </p>
            <p v-if="commandError" class="badge-hint warn" role="alert">部署命令参数读取失败：{{ commandError }}</p>
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
              <pre class="cmd-view" tabindex="0" aria-label="可横向滚动的命令">{{ deployCommand }}</pre>
            </div>
          </div>
        </div>

        <div class="step">
          <span class="step-num">2</span>
          <div class="step-body">
            <p class="step-title">SSH 登录 NAS 执行</p>
            <p class="field-desc">
              登录 NAS 后粘贴执行，并按提示输入 sudo 密码。
            </p>
          </div>
        </div>

        <div class="step">
          <span class="step-num">3</span>
          <div class="step-body">
            <p class="step-title">验证部署结果</p>
            <p class="field-desc">
              检查安装和权限配置；显示“部署验证通过”即完成。
            </p>
            <div class="cmd-block">
              <div class="cmd-block-head">
                <span class="cmd-title">验证命令</span>
                <button
                  class="copy-btn"
                  :class="{ copied: copiedKey === 'verify' }"
                  type="button"
                  @click="copy('verify', verifyCommand)"
                >
                  <Check v-if="copiedKey === 'verify'" :size="12" />
                  <Copy v-else :size="12" />
                  {{ copiedKey === "verify" ? "已复制" : "复制" }}
                </button>
              </div>
              <pre class="cmd-view" tabindex="0" aria-label="可横向滚动的命令">{{ verifyCommand }}</pre>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- 备选方案 -->
    <details class="panel deploy-extra">
      <summary class="panel-header">
        <span class="panel-title">
          <Wrench :size="18" />
          备选方案：手动安装脚本
        </span>
        <span>一键命令不可用时使用</span>
      </summary>
      <p class="field-desc block-desc">
        将脚本保存为 <code>/tmp/fnos-shutdown-executor.sh</code>，再执行安装命令。
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
            @click="copy('manual', manualInstallCommand)"
          >
            <Check v-if="copiedKey === 'manual'" :size="12" />
            <Copy v-else :size="12" />
            {{ copiedKey === "manual" ? "已复制" : "复制" }}
          </button>
        </div>
        <pre class="cmd-view" tabindex="0" aria-label="可横向滚动的命令">{{ manualInstallCommand }}</pre>
      </div>

    </details>

    <!-- 卸载执行器 -->
    <details class="panel deploy-extra">
      <summary class="panel-header">
        <span class="panel-title">
          <Trash2 :size="18" />
          卸载执行器
        </span>
        <span>手动操作</span>
      </summary>
      <p class="field-desc block-desc">
        应用卸载后，如需清理执行器和相关授权，请手动执行：
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
        <pre class="cmd-view" tabindex="0" aria-label="可横向滚动的命令">{{ UNINSTALL_COMMAND }}</pre>
      </div>
    </details>
  </template>
  </div>
</template>

<style scoped>
.deploy-page { display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; gap: 10px; font-size: 12px; }
.manual-copy-input { box-sizing: border-box; width: 100%; font-family: monospace; resize: vertical; }
.deploy-page > .panel { min-width: 0; margin: 0; padding: 12px; }
.panel-header { gap: 6px; margin-bottom: 8px; flex-wrap: wrap; }
.panel-title { font-size: 14px; gap: 6px; }
.panel-title svg { width: 16px; height: 16px; }
.panel-header > span:not(.panel-title) { font-size: 12px; }
.deploy-page .btn { box-sizing: border-box; min-height: 0; height: 30px; padding: 0 9px; border-radius: 6px; font-size: 12px; gap: 5px; box-shadow: none; }
.field-desc, .badge-hint, :deep(.badge-hint) { font-size: 12px; line-height: 1.6; margin: 6px 0 0; overflow-wrap: anywhere; }
:deep(.deploy-badge-wrap) { flex-direction: row; align-items: center; flex-wrap: wrap; gap: 6px 10px; }
:deep(.deploy-badge) { padding: 3px 8px; font-size: 12px; gap: 5px; border-radius: 6px; }
:deep(.deploy-badge-wrap .badge-hint) { margin: 0; }
.step { gap: 8px; padding: 4px 0 12px; }
.step:last-child { padding-bottom: 0; }
.step-num { width: 22px; height: 22px; font-size: 12px; }
.step:not(:last-child)::before { left: 10px; top: 29px; width: 1px; }
.step-title { font-size: 13px; line-height: 22px; margin: 0; }
.step-body .field-desc { margin: 3px 0 6px; }
.cmd-block { min-width: 0; max-width: 100%; margin: 6px 0 0; border-radius: 6px; }
.cmd-block-head { padding: 4px 8px; gap: 8px; }
.cmd-block-head .cmd-title { font-size: 11px; letter-spacing: 0; }
.copy-btn { box-sizing: border-box; height: 26px; padding: 0 7px; border-radius: 5px; font-size: 12px; }
.cmd-view { max-width: 100%; box-sizing: border-box; overflow: auto; padding: 8px; font-size: 12px; line-height: 1.5; white-space: pre; word-break: normal; tab-size: 2; }
.actions-row { margin: 8px 0; gap: 6px; }
.block-desc { margin: 6px 0; }
.deploy-extra > summary { cursor: pointer; margin: 0; list-style: none; }
.deploy-extra > summary::-webkit-details-marker { display: none; }
.deploy-extra > summary::after { content: '+'; margin-left: auto; color: var(--text-2); font-size: 16px; }
.deploy-extra[open] > summary::after { content: '−'; }
.deploy-extra[open] > summary { margin-bottom: 8px; }
.deploy-page button, .deploy-extra > summary { touch-action: manipulation; }
.deploy-page button:focus-visible, .deploy-extra > summary:focus-visible, .cmd-view:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
@media (max-width: 760px) {
  .deploy-page > .panel { padding: 10px; }
  .deploy-extra > summary > span:not(.panel-title) { display: none; }
  .cmd-view { max-height: 180px; }
}
</style>
