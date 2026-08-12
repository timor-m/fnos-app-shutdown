import { formatTime } from "./api";

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前；超过 7 天回退绝对时间 */
export function formatRelative(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "-";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = now - t;
  if (diff < 0) return formatTime(iso);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return formatTime(iso);
}

/** 本地 ISO → "HH:MM" */
export function formatClock(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 毫秒差 → 分钟级倒计时文案："2 小时 15 分钟" / "45 分钟" / "不到 1 分钟" */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return "不到 1 分钟";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "不到 1 分钟";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} 分钟`;
  if (rest === 0) return `${hours} 小时`;
  return `${hours} 小时 ${rest} 分钟`;
}
