// 契约 §3.0：时间戳一律本地时区 ISO 8601 带偏移，如 2026-08-11T23:30:01+08:00。
// 契约 §4.4：窗口判定粒度为分钟，左闭右开，start>end 表示跨零点。

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

export function toLocalIso(date: Date) {
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);

  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    + `T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
    + `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  );
}

// HH:MM → 分钟数（0-1439）；非法返回 null。
export function parseWindowTime(value: unknown): number | null {
  if (typeof value !== "string" || !HHMM_RE.test(value)) {
    return null;
  }

  const [hh, mm] = value.split(":");
  return Number(hh) * 60 + Number(mm);
}

// 左闭右开；start>end 跨零点：[s,1440) ∪ [0,e)。
export function isInWindowMinute(nowMin: number, startMin: number, endMin: number) {
  if (startMin < endMin) {
    return nowMin >= startMin && nowMin < endMin;
  }

  return nowMin >= startMin || nowMin < endMin;
}

export type WindowBounds = {
  inWindow: boolean;
  start: Date;
  end: Date;
};

// 契约 §5-B：skip_until 取「当前或下一窗口的 end」，由应用负责算对。
// 返回当前（若在窗口内）或下一窗口的起止时刻。
export function currentOrNextWindow(now: Date, startMin: number, endMin: number): WindowBounds {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const inWindow = isInWindowMinute(nowMin, startMin, endMin);
  const crossMidnight = startMin > endMin;

  // 窗口开始日相对今天的偏移：窗口内且已过零点（跨零点窗口的凌晨段）→ 昨天；
  // 窗口外且今天的开始时刻已过 → 明天。
  let dayOffset: number;
  if (inWindow) {
    dayOffset = crossMidnight && nowMin < endMin ? -1 : 0;
  } else {
    dayOffset = nowMin < startMin ? 0 : 1;
  }

  const start = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + dayOffset,
    Math.floor(startMin / 60),
    startMin % 60,
    0,
    0
  );
  const end = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + dayOffset + (crossMidnight ? 1 : 0),
    Math.floor(endMin / 60),
    endMin % 60,
    0,
    0
  );

  return { inWindow, start, end };
}
