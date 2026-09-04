const base = import.meta.env.BASE_URL;

export type ApiEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { message: string } };

async function parseEnvelope<T>(res: Response): Promise<T> {
  let json: ApiEnvelope<T> | null = null;
  try {
    json = (await res.json()) as ApiEnvelope<T>;
  } catch {
    throw new Error(`接口返回异常（HTTP ${res.status}）`);
  }
  if (!res.ok || !json.ok) {
    const message = !json.ok ? json.error?.message : undefined;
    throw new Error(message || `请求失败（HTTP ${res.status}）`);
  }
  return json.data;
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${base}api/${path}`);
  return parseEnvelope<T>(res);
}

export async function apiSend<T>(
  method: "PUT" | "POST" | "DELETE",
  path: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`${base}api/${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return parseEnvelope<T>(res);
}

export async function apiGetText(path: string): Promise<string> {
  const res = await fetch(`${base}api/${path}`);
  if (!res.ok) {
    throw new Error(`请求失败（HTTP ${res.status}）`);
  }
  return res.text();
}

/** 复制到剪贴板，非安全上下文（http）下回退 execCommand */
export async function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } finally {
    document.body.removeChild(ta);
  }
}

/** ISO 8601（带偏移）→ 本地 "YYYY-MM-DD HH:MM:SS" */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---------- 契约类型（§3.1 / §3.2 / §3.3） ----------

export type CheckName =
  | "cpu"
  | "load"
  | "users"
  | "ssh"
  | "disk_io"
  | "network"
  | "min_uptime"
  | "smb_sessions"
  | "tcp_sessions"
  | "download_active"
  | "vm_running"
  | "process_running"
  | "disk_scrub"
  | "host_online"
  | "calendar_rules";

export interface ShutdownConfig {
  enabled: boolean;
  window: { start: string; end: string };
  check_interval_sec: number;
  max_checks: number;
  checks: {
    cpu: { enabled: boolean; max_percent: number };
    load: { enabled: boolean; max_per_core: number };
    users: { enabled: boolean; max_active: number };
    ssh: { enabled: boolean; ports: number[] };
    disk_io: { enabled: boolean; max_iowait_percent: number };
    network: {
      enabled: boolean;
      max_rx_kbps: number;
      max_tx_kbps: number;
      exclude_interfaces: string[];
    };
    min_uptime: { enabled: boolean; min_sec: number };
    smb_sessions: { enabled: boolean };
    tcp_sessions: { enabled: boolean; ports: number[] };
    download_active: { enabled: boolean; ports: number[]; max_connections: number };
    vm_running: { enabled: boolean };
    process_running: { enabled: boolean; names: string[] };
    disk_scrub: { enabled: boolean };
    host_online: { enabled: boolean; hosts: string[] };
    calendar_rules: { enabled: boolean; skip_weekdays: number[]; skip_dates: string[] };
  };
}

export type ExecutorState = "undeployed" | "ok" | "outdated" | "stalled";

export interface StatusJson {
  script_version?: string;
  last_trigger?: string;
  last_action?: string;
  config_fallback?: boolean;
  monitoring?: boolean;
}

export interface SkipInfo {
  exists: boolean;
  active: boolean;
  corrupted: boolean;
  skipUntil: string | null;
  reason: string | null;
  created: string | null;
}

export interface StatusData {
  executor: { state: ExecutorState; status: StatusJson | null; appVersion: string; statusReadError?: string };
  skip: SkipInfo;
  config: {
    enabled: boolean;
    window: { start: string; end: string };
    checkIntervalSec: number;
    maxChecks: number;
  };
  tonight: { windowStart: string; windowEnd: string; inWindow: boolean; monitoring: boolean };
}

// ---------- 关于页（应用内部 API，§8） ----------

export interface AboutData {
  app: {
    appId: string;
    appTitle: string;
    version: string;
    gatewayPrefix: string;
    accessMode: "gateway" | "port";
    /** 向导配置的直连端口；null = 未启用 */
    servicePort: number | null;
    /** 应用实际数据目录（${TRIM_PKGVAR}/data），供部署命令传给 root 执行器 */
    storageDir: string | null;
    runtime: string;
    node: string;
    maintainer: string;
    maintainerUrl: string;
    qqGroup: string;
    repoUrl: string;
  };
  system: {
    hostname: string;
    platform: string;
    arch: string;
    release: string;
    cpu: { model: string; cores: number };
    totalmemMB: number;
    freememMB: number;
    loadavg: number[];
    uptimeSec: number;
    processUptimeSec: number;
  };
}

export function fetchAbout(): Promise<AboutData> {
  return apiGet<AboutData>("about");
}

// ---------- 手动检测关机条件（应用内部 API，§8；检查逻辑唯一来源为 executor 脚本 --dry-run） ----------

export type DryRunCheckResult = "pass" | "busy" | "skip" | "fail";

export interface DryRunCheck {
  name: CheckName;
  enabled: boolean;
  result: DryRunCheckResult;
  detail: string;
}

export interface DryRunData {
  overall: "pass" | "fail";
  checks: DryRunCheck[];
  executionMode: "privileged" | "unprivileged";
  ranAt: string;
}

export function fetchDryRun(): Promise<DryRunData> {
  return apiGet<DryRunData>("checks/dry-run");
}
