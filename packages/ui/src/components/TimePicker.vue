<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Check, Clock3, X } from "lucide-vue-next";

const props = defineProps<{
  modelValue: string;
  label?: string;
  ariaLabel?: string;
}>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const hours = ref(23);
const minutes = ref(59);
const hourWheel = ref<HTMLElement | null>(null);
const minuteWheel = ref<HTMLElement | null>(null);
const panelStyle = ref<Record<string, string>>({});
const ITEM_HEIGHT = 40;

const pad = (value: number) => String(value).padStart(2, "0");
const hourOptions = Array.from({ length: 24 }, (_, i) => i);
const minuteOptions = Array.from({ length: 60 }, (_, i) => i);

function readValue() {
  const match = /^(\d{2}):(\d{2})$/.exec(props.modelValue);
  if (match) {
    hours.value = Number(match[1]);
    minutes.value = Number(match[2]);
  }
}

function scrollToSelection() {
  for (const [wheel, value] of [[hourWheel.value, hours.value], [minuteWheel.value, minutes.value]] as const) {
    if (wheel) wheel.scrollTop = value * ITEM_HEIGHT;
  }
}

function updatePosition() {
  if (!open.value || !root.value || !panel.value || window.innerWidth <= 760) return;
  const rect = root.value.getBoundingClientRect();
  const width = Math.min(300, window.innerWidth - 32);
  panelStyle.value = {
    top: `${rect.bottom + 8}px`,
    left: `${Math.max(16, Math.min(rect.left, window.innerWidth - width - 16))}px`,
    width: `${width}px`
  };
}

function openPicker() {
  readValue();
  open.value = true;
  nextTick(() => {
    scrollToSelection();
    updatePosition();
  });
}

function onWheelScroll(kind: "hour" | "minute", event: Event) {
  const target = event.target as HTMLElement;
  const value = Math.max(0, Math.min(kind === "hour" ? 23 : 59, Math.round(target.scrollTop / ITEM_HEIGHT)));
  if (kind === "hour") hours.value = value;
  else minutes.value = value;
}

function choose(kind: "hour" | "minute", value: number) {
  if (kind === "hour") hours.value = value;
  else minutes.value = value;
  nextTick(scrollToSelection);
}

function confirm() {
  emit("update:modelValue", `${pad(hours.value)}:${pad(minutes.value)}`);
  open.value = false;
}

function onOutside(event: Event) {
  const target = event.target as Node;
  if (!root.value?.contains(target) && !panel.value?.contains(target)) open.value = false;
}

watch(open, (value) => {
  const method = value ? "addEventListener" : "removeEventListener";
  document[method]("mousedown", onOutside);
  document[method]("touchstart", onOutside);
  window[method]("resize", updatePosition);
  window[method]("scroll", updatePosition, true);
});

onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onOutside);
  document.removeEventListener("touchstart", onOutside);
  window.removeEventListener("resize", updatePosition);
  window.removeEventListener("scroll", updatePosition, true);
});
</script>

<template>
  <div ref="root" class="time-picker">
    <button type="button" class="time-picker-trigger" :aria-label="ariaLabel" @click="openPicker">
      <Clock3 :size="17" aria-hidden="true" />
      <span>{{ modelValue || "请选择时间" }}</span>
    </button>
    <Teleport to="body">
      <div v-if="open" class="time-picker-layer" @mousedown.self="open = false" @touchstart.self.prevent="open = false">
        <div ref="panel" class="time-picker-panel" :style="panelStyle" role="dialog" aria-modal="true" :aria-label="label || '选择时间'">
          <header class="time-picker-header">
            <button type="button" aria-label="取消" title="取消" @click="open = false"><X :size="18" /></button>
            <strong>{{ label || "选择时间" }}</strong>
            <button type="button" class="confirm" aria-label="确认" title="确认" @click="confirm"><Check :size="18" /></button>
          </header>
          <div class="time-picker-wheels">
            <div class="time-picker-wheel">
              <span>时</span>
              <div ref="hourWheel" class="time-wheel-scroll" @scroll="onWheelScroll('hour', $event)">
                <button v-for="hour in hourOptions" :key="hour" type="button" :class="{ selected: hour === hours }" @click="choose('hour', hour)">{{ pad(hour) }}</button>
              </div>
            </div>
            <b>:</b>
            <div class="time-picker-wheel">
              <span>分</span>
              <div ref="minuteWheel" class="time-wheel-scroll" @scroll="onWheelScroll('minute', $event)">
                <button v-for="minute in minuteOptions" :key="minute" type="button" :class="{ selected: minute === minutes }" @click="choose('minute', minute)">{{ pad(minute) }}</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.time-picker { width: 100%; min-width: 0; }
.time-picker-trigger { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 44px; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--bg-inset); color: var(--text-1); font: inherit; font-variant-numeric: tabular-nums; text-align: left; cursor: pointer; }
.time-picker-trigger svg { flex: 0 0 auto; color: var(--text-3); }
.time-picker-trigger:focus-visible { outline: 2px solid var(--brand); outline-offset: 1px; }
.time-picker-layer { position: fixed; inset: 0; z-index: 140; background: rgba(0, 0, 0, .35); pointer-events: none; }
.time-picker-panel { position: fixed; overflow: hidden; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--r-md); box-shadow: var(--shadow-lg); pointer-events: auto; }
.time-picker-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--border); }
.time-picker-header button { display: grid; place-items: center; width: 34px; height: 34px; padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--text-2); cursor: pointer; }
.time-picker-header button:hover { background: var(--bg-hover); }
.time-picker-header .confirm { color: var(--brand-text); }
.time-picker-wheels { display: flex; align-items: center; gap: 8px; height: 220px; padding: 12px 24px; }
.time-picker-wheels > b { align-self: center; color: var(--text-2); font-size: 1.2rem; }
.time-picker-wheel { flex: 1; min-width: 0; text-align: center; }
.time-picker-wheel > span { display: block; margin-bottom: 4px; color: var(--text-3); font-size: .75rem; font-weight: 600; }
.time-wheel-scroll { height: 172px; overflow-y: auto; scroll-snap-type: y mandatory; scrollbar-width: none; -webkit-overflow-scrolling: touch; }
.time-wheel-scroll::-webkit-scrollbar { display: none; }
.time-wheel-scroll button { display: flex; align-items: center; justify-content: center; width: 100%; height: 40px; padding: 0; border: 0; background: transparent; color: var(--text-2); font: inherit; font-size: 1.05rem; font-variant-numeric: tabular-nums; scroll-snap-align: start; cursor: pointer; }
.time-wheel-scroll button.selected { color: var(--text-1); font-weight: 700; transform: scale(1.08); }
@media (max-width: 760px) {
  .time-picker-layer { display: flex; align-items: flex-end; pointer-events: auto; }
  .time-picker-panel { position: fixed; left: 0 !important; top: auto !important; width: 100% !important; border: 0; border-radius: var(--r-lg) var(--r-lg) 0 0; padding-bottom: env(safe-area-inset-bottom); }
  .time-picker-wheels { height: 250px; padding-inline: 60px; }
  .time-wheel-scroll { height: 202px; }
}
@media (prefers-reduced-motion: reduce) { .time-picker-panel { animation: none; } }
</style>
