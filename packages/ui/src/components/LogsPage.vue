<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  ArrowUp,
  ArrowUpToLine,
  Check,
  ChevronsDown,
  Copy,
  FileText,
  Filter,
  Pause,
  Play,
  RefreshCw,
  Search,
  X
} from "lucide-vue-next";
import { apiGet, copyToClipboard } from "../api";

const POLL_INTERVAL_MS = 30_000;
const LOG_PAGE_SIZE = 500;

// ---------- 运行日志（§3.4：原文展示，仅做展示层过滤/分组，不做结构化解析） ----------
interface LogPage {
  month: string;
  totalLines: number;
  offset: number;
  lines: string[];
}

const months = ref<string[]>([]);
const pageLoading = ref(true);
/** 选择的日期（YYYY-MM-DD），默认当天；月份由日期推导 */
const selectedDate = ref(todayStr());
/** 所选日期的月份日志文件不存在 */
const monthMissing = ref(false);
const logLines = ref<string[]>([]);
const logTotal = ref(0);
/** logLines[0] 在全文中的行偏移（0 基） */
const loadedStart = ref(0);
const logLoading = ref(false);
const logError = ref("");

const keyword = ref("");
const onlyMatches = ref(false);
const autoScroll = ref(true);
const autoRefresh = ref(true);
const logViewEl = ref<HTMLElement | null>(null);
const sentinelEl = ref<HTMLElement | null>(null);
const copyAllDone = ref(false);

let timer: ReturnType<typeof setInterval> | null = null;
let sentinelObserver: IntersectionObserver | null = null;

function todayStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 日志文件按月滚动（§3.4 YYYY-MM.log），月份由所选日期推导 */
const selectedMonth = computed(() => selectedDate.value.slice(0, 7));

function fetchLogPage(month: string, offset: number, limit: number): Promise<LogPage> {
  return apiGet<LogPage>(
    `logs?month=${encodeURIComponent(month)}&offset=${offset}&limit=${limit}`
  );
}

async function loadMonths() {
  try {
    const data = await apiGet<{ months: string[] }>("logs");
    months.value = data.months || [];
    if (months.value.length > 0) {
      await loadLatestLogs();
    }
  } catch (err) {
    logError.value = err instanceof Error ? err.message : "日志加载失败";
  } finally {
    pageLoading.value = false;
  }
}

/** 重置并加载最新一页（数据层时间正序存储，展示层倒序、最新在最上）；所选月份无日志文件时按空态处理 */
async function loadLatestLogs() {
  logLoading.value = true;
  logError.value = "";
  monthMissing.value = false;
  try {
    const probe = await fetchLogPage(selectedMonth.value, 0, 1);
    logTotal.value = probe.totalLines;
    if (probe.totalLines === 0) {
      logLines.value = [];
      loadedStart.value = 0;
      return;
    }
    const start = Math.max(0, probe.totalLines - LOG_PAGE_SIZE);
    const data = await fetchLogPage(selectedMonth.value, start, LOG_PAGE_SIZE);
    logTotal.value = data.totalLines;
    logLines.value = data.lines;
    loadedStart.value = data.offset;
    scrollLogToTop();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "日志加载失败";
    if (/404/.test(msg)) {
      monthMissing.value = true;
      logLines.value = [];
      logTotal.value = 0;
      loadedStart.value = 0;
    } else {
      logError.value = msg;
    }
  } finally {
    logLoading.value = false;
  }
}

const hasEarlierLogs = computed(() => loadedStart.value > 0);

/** 加载更早的一页（展示倒序下更早的内容追加在底部，视口位置天然不变，无需恢复滚动） */
async function loadEarlierLogs() {
  if (monthMissing.value || !hasEarlierLogs.value || logLoading.value) return;
  logLoading.value = true;
  logError.value = "";
  try {
    const newStart = Math.max(0, loadedStart.value - LOG_PAGE_SIZE);
    const data = await fetchLogPage(selectedMonth.value, newStart, loadedStart.value - newStart);
    logTotal.value = data.totalLines;
    logLines.value = [...data.lines, ...logLines.value];
    loadedStart.value = data.offset;
  } catch (err) {
    logError.value = err instanceof Error ? err.message : "日志加载失败";
  } finally {
    logLoading.value = false;
  }
}

const atLatestPage = computed(() => loadedStart.value + logLines.value.length >= logTotal.value);

/** 手动刷新 / 自动刷新：位于末尾页时追加新行 */
async function refreshLogs(manual = false) {
  if (monthMissing.value || logLoading.value) return;
  if (!atLatestPage.value) {
    if (manual) await loadLatestLogs();
    return;
  }
  if (manual) {
    logLoading.value = true;
    logError.value = "";
  }
  try {
    const offset = loadedStart.value + logLines.value.length;
    const data = await fetchLogPage(selectedMonth.value, offset, LOG_PAGE_SIZE);
    logTotal.value = data.totalLines;
    if (offset > data.totalLines) {
      // 日志被轮转/清空，回退到最新一页
      await loadLatestLogs();
      return;
    }
    if (data.lines.length > 0) {
      logLines.value = [...logLines.value, ...data.lines];
      scrollLogToTop();
    }
  } catch (err) {
    if (manual) logError.value = err instanceof Error ? err.message : "日志刷新失败";
  } finally {
    if (manual) logLoading.value = false;
  }
}

function maybeAutoRefreshLogs() {
  if (autoRefresh.value && !monthMissing.value && atLatestPage.value) {
    void refreshLogs(false);
  }
}

/** 展示倒序：最新内容在顶部，自动滚动即回到顶部 */
function scrollLogToTop() {
  if (!autoScroll.value) return;
  void nextTick(() => {
    const el = logViewEl.value;
    if (el) el.scrollTop = 0;
  });
}

/** 切换日期：重置并按新日期所在月份重新加载 */
async function onDateChange() {
  logLines.value = [];
  loadedStart.value = 0;
  logTotal.value = 0;
  keyword.value = "";
  await loadLatestLogs();
}

async function copyAllLoaded() {
  if (logLines.value.length === 0) return;
  try {
    await copyToClipboard(logLines.value.join("\n"));
    copyAllDone.value = true;
    setTimeout(() => {
      copyAllDone.value = false;
    }, 2000);
  } catch {
    logError.value = "复制失败，请手动选择文本复制";
  }
}

// ---------- 日期维度筛选（§3.4 行首 [YYYY-MM-DD HH:MM:SS]，仅取日期，不解析消息内容） ----------
const DATE_RE = /^\[(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}\]/;

function lineDate(line: string): string {
  const m = DATE_RE.exec(line);
  return m ? m[1] : "";
}

// ---------- 关键字过滤与高亮（客户端包含匹配，仅影响展示） ----------
interface LogSeg {
  text: string;
  hit: boolean;
}

interface LogRow {
  num: number;
  raw: string;
  /** 行首时间戳前缀（含方括号与尾随空格，§3.4 行格式允许取）；无时间戳行为空串 */
  ts: string;
  /** 仅时分秒的短前缀（组头已含日期，明细行省空间）；无时间戳行为空串 */
  tsShort: string;
  segs: LogSeg[];
  hit: boolean;
}

/** 行首 [YYYY-MM-DD HH:MM:SS] 时间戳前缀（§3.4 行格式契约） */
const TS_PREFIX_RE = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\]\s*/;

/** 先按日期过滤，再做关键字高亮（仅匹配行的剔除在分组层做，以保证标记行始终保留） */
const displayRows = computed<LogRow[]>(() => {
  const kw = keyword.value.trim().toLowerCase();
  const date = selectedDate.value;
  const rows: LogRow[] = [];
  for (let i = 0; i < logLines.value.length; i++) {
    const line = logLines.value[i];
    if (date && lineDate(line) !== date) continue;
    const num = loadedStart.value + i + 1;
    const m = TS_PREFIX_RE.exec(line);
    const ts = m?.[0] ?? "";
    const tsShort = m ? `[${m[2]}] ` : "";
    const msg = line.slice(ts.length);
    if (!kw) {
      rows.push({ num, raw: line, ts, tsShort, segs: [{ text: msg, hit: false }], hit: false });
      continue;
    }
    const lower = msg.toLowerCase();
    const segs: LogSeg[] = [];
    let idx = 0;
    let hit = false;
    for (;;) {
      const found = lower.indexOf(kw, idx);
      if (found === -1) {
        segs.push({ text: msg.slice(idx), hit: false });
        break;
      }
      if (found > idx) segs.push({ text: msg.slice(idx), hit: false });
      segs.push({ text: msg.slice(found, found + kw.length), hit: true });
      hit = true;
      idx = found + kw.length;
    }
    rows.push({ num, raw: line, ts, tsShort, segs, hit });
  }
  return rows;
});

const matchCount = computed(() => {
  if (!keyword.value.trim()) return 0;
  return displayRows.value.reduce((n, r) => n + (r.hit ? 1 : 0), 0);
});

const dateCount = computed(() => displayRows.value.length);

// ---------- 按「次」分组（§3.4：每次触发的首条日志是契约标记行 `=== ... ===`，仅此格式可依赖） ----------
// 结尾 === 前的空格按契约示例可缺省（`...）===`），故放宽为 `. *===`
const MARKER_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] === .*===$/;

interface LogGroup {
  /** 标记行的全文行号（稳定 key）；杂组为 legacy-首行行号 */
  key: string;
  /** 标记行行首时间戳（契约行格式允许取）；杂组为空 */
  time: string;
  /** 首个标记行之前的旧格式/样例行归入的「较早记录」杂组 */
  legacy: boolean;
  rows: LogRow[];
}

/**
 * 标记行开启新组；其后行归属该组直到下一个标记行。
 * 「仅匹配行」在分组层过滤：标记行始终保留以维持分组结构；过滤后无可见行的组（仅可能是杂组）整组隐藏。
 */
const groups = computed<LogGroup[]>(() => {
  const only = onlyMatches.value && keyword.value.trim() !== "";
  const out: LogGroup[] = [];
  let cur: LogGroup | null = null;
  for (const row of displayRows.value) {
    const m = MARKER_RE.exec(row.raw);
    if (m) {
      cur = { key: `m${row.num}`, time: m[1], legacy: false, rows: [row] };
      out.push(cur);
      continue;
    }
    if (only && !row.hit) continue;
    if (!cur) {
      cur = { key: `legacy-${row.num}`, time: "", legacy: true, rows: [] };
      out.push(cur);
    }
    cur.rows.push(row);
  }
  return out;
});

/** 展示层倒序：最新的「次」在最上；组内行保持时间正序（触发行在前、结果行在后） */
const displayGroups = computed<LogGroup[]>(() => [...groups.value].reverse());

// ---------- 无限滚动：底部哨兵进入视口时自动加载更早一页 ----------
// 哨兵为条件渲染元素，用 watch 在其出现时（重）建观察器；root 取日志面板自身
watch(sentinelEl, (el) => {
  sentinelObserver?.disconnect();
  sentinelObserver = null;
  if (el) {
    sentinelObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) void loadEarlierLogs();
        }
      },
      { root: logViewEl.value, rootMargin: "0px 0px 160px 0px" }
    );
    sentinelObserver.observe(el);
  }
});

onMounted(() => {
  void loadMonths();
  timer = setInterval(maybeAutoRefreshLogs, POLL_INTERVAL_MS);
});

onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  sentinelObserver?.disconnect();
});
</script>

<template>
  <section class="panel log-panel">
    <header class="panel-header">
      <h2 class="panel-title">
        <FileText :size="18" />
        运行日志
      </h2>
      <span v-if="logTotal">共 {{ logTotal }} 行</span>
    </header>

    <div v-if="pageLoading" class="skeleton-block">
      <div class="skeleton" style="width: 45%"></div>
      <div class="skeleton" style="width: 92%"></div>
      <div class="skeleton" style="width: 78%"></div>
      <div class="skeleton" style="width: 84%"></div>
    </div>

    <div v-else-if="months.length === 0 && !logError" class="empty-state">
      <FileText :size="40" />
      <p class="empty-title">暂无日志</p>
      <p class="empty-desc">执行器部署并运行后，将按月生成运行日志。</p>
    </div>

    <template v-else>
      <div class="log-toolbar">
        <input
          v-model="selectedDate"
          class="input log-date"
          type="date"
          :max="todayStr()"
          title="选择日期（默认当天）"
          @change="onDateChange"
        />
        <div class="log-search">
          <Search class="search-icon" :size="14" />
          <input
            v-model="keyword"
            class="input"
            type="text"
            placeholder="关键字过滤（仅过滤展示）"
          />
          <button
            v-if="keyword"
            class="clear-btn"
            type="button"
            title="清除关键字"
            @click="keyword = ''"
          >
            <X :size="12" />
          </button>
        </div>
        <span class="spacer"></span>
        <button
          class="icon-btn"
          :class="{ active: onlyMatches }"
          type="button"
          :disabled="!keyword"
          title="仅显示匹配行（分组标记行始终保留）"
          :aria-pressed="onlyMatches"
          @click="onlyMatches = !onlyMatches"
        >
          <Filter :size="15" />
        </button>
        <button
          class="icon-btn"
          :class="{ active: autoScroll }"
          type="button"
          title="自动滚动到顶部（最新）"
          :aria-pressed="autoScroll"
          @click="autoScroll = !autoScroll"
        >
          <ArrowUp :size="15" />
        </button>
        <button
          class="icon-btn"
          :class="{ active: autoRefresh }"
          type="button"
          :title="autoRefresh ? '自动刷新开启中（每 30 秒），点击暂停' : '自动刷新已暂停，点击开启'"
          :aria-pressed="autoRefresh"
          @click="autoRefresh = !autoRefresh"
        >
          <Pause v-if="autoRefresh" :size="15" />
          <Play v-else :size="15" />
        </button>
        <button
          class="icon-btn"
          type="button"
          :disabled="logLoading"
          title="刷新"
          @click="refreshLogs(true)"
        >
          <RefreshCw :size="15" :class="{ spinning: logLoading }" />
        </button>
        <button
          class="icon-btn"
          type="button"
          :disabled="logLoading || atLatestPage"
          title="跳到最新"
          @click="loadLatestLogs"
        >
          <ArrowUpToLine :size="15" />
        </button>
        <button
          class="icon-btn"
          type="button"
          :disabled="logLines.length === 0"
          :title="copyAllDone ? '已复制' : '复制全部已加载'"
          @click="copyAllLoaded"
        >
          <Check v-if="copyAllDone" :size="15" />
          <Copy v-else :size="15" />
        </button>
      </div>

      <div v-if="logError" class="feedback error">{{ logError }}</div>

      <div v-else ref="logViewEl" class="log-view">
        <template v-if="displayGroups.length > 0">
          <div v-for="g in displayGroups" :key="g.key" class="log-group">
            <div class="log-group-head">
              <span class="log-group-time">{{ g.legacy ? "较早记录" : g.time }}</span>
              <span class="log-group-meta">{{ g.rows.length }} 行</span>
            </div>
            <div
              v-for="row in g.rows"
              :key="row.num"
              class="log-line"
              :class="{ hit: row.hit && keyword.trim() !== '' }"
              :title="row.raw"
            >
              <span class="log-text"><span v-if="row.ts" class="log-ts">{{ g.legacy ? row.ts : row.tsShort }}</span><template v-for="(seg, si) in row.segs" :key="si"><mark v-if="seg.hit">{{ seg.text }}</mark><template v-else>{{ seg.text }}</template></template></span>
            </div>
          </div>
          <div v-if="hasEarlierLogs" ref="sentinelEl" class="log-sentinel">
            <ChevronsDown :size="13" />
            {{ logLoading ? "加载更早日志中..." : "滚动到底部自动加载更早日志" }}
          </div>
        </template>
        <div v-else class="log-empty">
          <template v-if="logLoading">加载中...</template>
          <template v-else-if="keyword">已加载的行中没有匹配「{{ keyword }}」的内容</template>
          <template v-else>{{ selectedDate }} 暂无日志</template>
        </div>
      </div>

      <div class="log-footer">
        <span class="text-muted">
          当日 {{ dateCount }} 行 · 当月已加载 {{ logLines.length }} / 共 {{ logTotal }} 行
          <template v-if="keyword"> · 匹配 {{ matchCount }} 行</template>
        </span>
      </div>
    </template>
  </section>
</template>
