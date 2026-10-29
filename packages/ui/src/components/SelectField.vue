<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import { Check, ChevronDown } from "lucide-vue-next";

export interface SelectOption { value: string; label: string; disabled?: boolean }
const props = withDefaults(defineProps<{
  modelValue: string;
  options: SelectOption[];
  ariaLabel: string;
  disabled?: boolean;
  placeholder?: string;
}>(), { placeholder: "请选择" });
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const id = useId();
const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const menu = ref<HTMLElement | null>(null);
const open = ref(false);
const active = ref(-1);
const above = ref(false);
const maxHeight = ref(240);
const selected = computed(() => props.options.find(option => option.value === props.modelValue));
let search = "";
let searchTimer: ReturnType<typeof setTimeout> | undefined;

function close() { open.value = false; search = ""; clearTimeout(searchTimer); }
function position() {
  const box = trigger.value?.getBoundingClientRect();
  if (!box) return;
  const below = window.innerHeight - box.bottom - 12;
  const top = box.top - 12;
  above.value = below < 180 && top > below;
  maxHeight.value = Math.max(40, Math.min(240, above.value ? top : below));
}
async function reveal() {
  await nextTick();
  menu.value?.querySelector<HTMLElement>(`[data-index="${active.value}"]`)?.scrollIntoView({ block: "nearest" });
}
function show(last = false) {
  if (props.disabled || trigger.value?.matches(":disabled")) return;
  position();
  const index = props.options.findIndex(option => option.value === props.modelValue && !option.disabled);
  const enabled = props.options.map((option, i) => option.disabled ? -1 : i).filter(i => i >= 0);
  active.value = index >= 0 ? index : (last ? enabled.at(-1) : enabled[0]) ?? -1;
  open.value = true;
  void reveal();
}
function choose(index: number) {
  const option = props.options[index];
  if (!option || option.disabled || props.disabled || trigger.value?.matches(":disabled")) return;
  emit("update:modelValue", option.value);
  close();
  trigger.value?.focus();
}
function move(direction: number) {
  for (let n = 1; n <= props.options.length; n++) {
    const index = (active.value + direction * n + props.options.length) % props.options.length;
    if (!props.options[index]?.disabled) { active.value = index; void reveal(); return; }
  }
}
function onKey(event: KeyboardEvent) {
  if (event.key === "Tab") { close(); return; }
  if (event.key === "Escape") { if (open.value) { event.preventDefault(); close(); } return; }
  if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(event.key)) {
    event.preventDefault();
    if (!open.value) { show(event.key === "ArrowUp" || event.key === "End"); return; }
    if (event.key === "Enter" || event.key === " ") choose(active.value);
    else if (event.key === "Home" || event.key === "End") {
      active.value = event.key === "Home" ? -1 : 0;
      move(event.key === "Home" ? 1 : -1);
    } else move(event.key === "ArrowDown" ? 1 : -1);
  } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    if (!open.value) show();
    search += event.key.toLocaleLowerCase();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { search = ""; }, 600);
    const index = props.options.findIndex(option => !option.disabled && option.label.toLocaleLowerCase().startsWith(search));
    if (index >= 0) { active.value = index; void reveal(); }
  }
}
function outside(event: PointerEvent) { if (!root.value?.contains(event.target as Node)) close(); }
function blur(event: FocusEvent) { if (!root.value?.contains(event.relatedTarget as Node)) close(); }
watch(() => props.disabled, value => { if (value) close(); });
watch(() => props.options, () => { if (open.value) show(); });
onMounted(() => {
  document.addEventListener("pointerdown", outside, true);
  window.addEventListener("resize", close);
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", outside, true);
  window.removeEventListener("resize", close);
  clearTimeout(searchTimer);
});
</script>

<template>
  <div ref="root" class="select-field" @focusout="blur">
    <button ref="trigger" type="button" class="select-trigger" role="combobox" :disabled="disabled"
      :aria-label="ariaLabel" aria-haspopup="listbox" :aria-expanded="open" :aria-controls="id"
      :aria-activedescendant="open && active >= 0 ? `${id}-${active}` : undefined"
      @click="open ? close() : show()" @keydown="onKey">
      <span :class="{ 'select-placeholder': !selected }">{{ selected?.label || placeholder }}</span>
      <ChevronDown :size="14" :class="{ rotated: open }" />
    </button>
    <ul v-if="open" :id="id" ref="menu" role="listbox" :aria-label="ariaLabel" class="select-menu"
      :class="{ above }" :style="{ maxHeight: `${maxHeight}px` }" @mousedown.prevent>
      <li v-for="(option, index) in options" :id="`${id}-${index}`" :key="option.value" role="option"
        :data-index="index" :aria-selected="option.value === modelValue" :aria-disabled="option.disabled || undefined"
        :class="{ active: index === active, selected: option.value === modelValue, disabled: option.disabled }"
        @pointermove="!option.disabled && (active = index)" @click.stop="choose(index)">
        <span>{{ option.label }}</span><Check v-if="option.value === modelValue" :size="14" />
      </li>
      <li v-if="!options.length" class="select-empty" role="presentation">暂无选项</li>
    </ul>
  </div>
</template>

<style scoped>
.select-field { position: relative; min-width: 0; width: 100%; }
.select-trigger { box-sizing: border-box; display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; height: 30px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-inset); color: var(--text-1); font: inherit; font-size: 13px; line-height: 20px; text-align: left; cursor: pointer; touch-action: manipulation; }
.select-trigger > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.select-trigger svg { flex-shrink: 0; color: var(--text-2); }
.select-trigger .rotated { transform: rotate(180deg); }
.select-trigger:hover { border-color: var(--border-strong); }
.select-trigger:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
.select-trigger[aria-expanded="true"] { border-color: var(--brand); }
.select-trigger:disabled { opacity: .5; cursor: default; }
.select-placeholder { color: var(--text-3); }
.select-menu { position: absolute; z-index: 30; top: calc(100% + 4px); left: 0; right: 0; box-sizing: border-box; overflow-y: auto; overscroll-behavior: contain; margin: 0; padding: 4px; list-style: none; border: 1px solid var(--border-strong); border-radius: 7px; background: var(--bg-card); box-shadow: 0 6px 20px #0003; }
.select-menu.above { top: auto; bottom: calc(100% + 4px); }
.select-menu li { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 30px; box-sizing: border-box; padding: 5px 7px; border-radius: 4px; font-size: 13px; line-height: 20px; color: var(--text-1); cursor: pointer; }
.select-menu li span { overflow-wrap: anywhere; }
.select-menu li svg { flex-shrink: 0; }
.select-menu li.selected { color: var(--brand-text); }
.select-menu li.active { background: var(--brand-soft); }
.select-menu li.disabled, .select-menu .select-empty { color: var(--text-3); cursor: default; }
</style>
