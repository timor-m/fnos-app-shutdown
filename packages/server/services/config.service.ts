import { readFile } from "node:fs/promises";
import { writeFileAtomic } from "../utils/atomic-file";
import { getConfigFilePath } from "../utils/data-paths";
import { parseWindowTime } from "../utils/local-time";

// 契约 §3.1：config.json schema。示例值即默认值。
export type ShutdownConfig = {
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
};

export function defaultConfig(): ShutdownConfig {
  return {
    enabled: true,
    window: { start: "23:00", end: "08:00" },
    check_interval_sec: 60,
    max_checks: 60,
    checks: {
      cpu: { enabled: true, max_percent: 10 },
      load: { enabled: true, max_per_core: 0.5 },
      users: { enabled: true, max_active: 0 },
      ssh: { enabled: true, ports: [8975] },
      disk_io: { enabled: true, max_iowait_percent: 30 },
      network: {
        enabled: true,
        max_rx_kbps: 10,
        max_tx_kbps: 0,
        exclude_interfaces: ["lo", "docker*", "br-*", "veth*", "ovs*"]
      },
      min_uptime: { enabled: false, min_sec: 1800 },
      smb_sessions: { enabled: false },
      tcp_sessions: { enabled: true, ports: [8005, 5666, 5667, 443, 80] },
      download_active: { enabled: false, ports: [], max_connections: 0 },
      vm_running: { enabled: false },
      process_running: { enabled: false, names: [] },
      disk_scrub: { enabled: false },
      host_online: { enabled: false, hosts: [] },
      calendar_rules: { enabled: false, skip_weekdays: [], skip_dates: [] }
    }
  };
}

const IFACE_RE = /^[a-zA-Z0-9_*?-]+$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

type CheckName = keyof ShutdownConfig["checks"];

const CHECK_NAMES: CheckName[] = [
  "cpu",
  "load",
  "users",
  "ssh",
  "disk_io",
  "network",
  "min_uptime",
  "smb_sessions",
  "tcp_sessions",
  "download_active",
  "vm_running",
  "process_running",
  "disk_scrub",
  "host_online",
  "calendar_rules"
];

// 单字段校验器：返回 null 表示合法（value 可能已被规范化），否则返回错误描述。
// 写入路径（PUT）逐条收集错误；读取路径把「有错误」整体回退默认。
function validateWindow(value: unknown): string | null {
  if (!isPlainObject(value)) {
    return "必须是对象 { start, end }";
  }

  const start = parseWindowTime(value.start);
  const end = parseWindowTime(value.end);

  if (typeof value.start !== "string" || start === null) {
    return "window.start 非法：需为 HH:MM（00:00-23:59）";
  }
  if (typeof value.end !== "string" || end === null) {
    return "window.end 非法：需为 HH:MM（00:00-23:59）";
  }
  if (start === end) {
    return "window.start 与 window.end 不能相同";
  }

  return null;
}

function validatePorts(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return "必须是整数数组";
  }
  for (const port of value) {
    if (!isInt(port) || port < 1 || port > 65535) {
      return `端口 ${JSON.stringify(port)} 非法：每项需为 1-65535 的整数`;
    }
  }
  return null;
}

function validateExcludeInterfaces(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return "必须是字符串数组";
  }
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > 32 || !IFACE_RE.test(item)) {
      return `接口模式 ${JSON.stringify(item)} 非法：每项仅含 [a-zA-Z0-9_*?-] 且 ≤32 字符`;
    }
  }
  return null;
}

// 通用 string[] 校验：每项匹配给定字符集且 ≤maxLen 字符。
function validateStringList(
  value: unknown,
  re: RegExp,
  maxLen: number,
  describe: (item: unknown) => string
): string | null {
  if (!Array.isArray(value)) {
    return "必须是字符串数组";
  }
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > maxLen || !re.test(item)) {
      return describe(item);
    }
  }
  return null;
}

const PROC_NAME_RE = /^[a-zA-Z0-9_.+-]+$/;
const HOST_RE = /^[a-zA-Z0-9.-]+$/;
const SKIP_DATE_RE = /^(\d{2})-(\d{2})$/;

function validateProcessNames(value: unknown): string | null {
  return validateStringList(
    value,
    PROC_NAME_RE,
    64,
    (item) => `进程名 ${JSON.stringify(item)} 非法：每项仅含 [a-zA-Z0-9_.+-] 且 ≤64 字符`
  );
}

function validateHosts(value: unknown): string | null {
  return validateStringList(
    value,
    HOST_RE,
    64,
    (item) => `主机 ${JSON.stringify(item)} 非法：每项仅含 [a-zA-Z0-9.-] 且 ≤64 字符`
  );
}

function validateSkipWeekdays(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return "必须是整数数组";
  }
  for (const item of value) {
    if (!isInt(item) || item < 0 || item > 6) {
      return `星期 ${JSON.stringify(item)} 非法：每项需为 0-6 的整数（0=周日）`;
    }
  }
  return null;
}

// MM-DD，需为合法月日（02-29 视为合法，仅闰年生效）。
function validateSkipDates(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return "必须是字符串数组";
  }
  const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  for (const item of value) {
    const m = typeof item === "string" ? SKIP_DATE_RE.exec(item) : null;
    if (!m) {
      return `日期 ${JSON.stringify(item)} 非法：每项需为 MM-DD 格式`;
    }
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month < 1 || month > 12 || day < 1 || day > DAYS_IN_MONTH[month - 1]) {
      return `日期 ${JSON.stringify(item)} 非法：不是合法的月日`;
    }
  }
  return null;
}

// 逐字段校验，errors 收集「字段路径: 问题」。缺失字段采用默认（checks 缺失项同理，
// 契约 §3.1：checks 中缺失某个检查项 → 该项按默认处理）。未知字段/未知检查项忽略。
export function validateConfig(
  input: unknown,
  onError: (path: string, problem: string) => void
): ShutdownConfig {
  const config = defaultConfig();

  if (!isPlainObject(input)) {
    onError("config", "必须是 JSON 对象");
    return config;
  }

  if ("enabled" in input) {
    if (typeof input.enabled === "boolean") {
      config.enabled = input.enabled;
    } else {
      onError("enabled", "必须是布尔值");
    }
  }

  if ("window" in input) {
    const problem = validateWindow(input.window);
    if (problem === null) {
      const window = input.window as { start: string; end: string };
      config.window = { start: window.start, end: window.end };
    } else {
      onError("window", problem);
    }
  }

  if ("check_interval_sec" in input) {
    const value = input.check_interval_sec;
    if (isInt(value) && value >= 10 && value <= 3600) {
      config.check_interval_sec = value;
    } else {
      onError("check_interval_sec", "必须是 10-3600 的整数");
    }
  }

  if ("max_checks" in input) {
    const value = input.max_checks;
    if (isInt(value) && value >= 1 && value <= 720) {
      config.max_checks = value;
    } else {
      onError("max_checks", "必须是 1-720 的整数");
    }
  }

  if ("checks" in input) {
    if (!isPlainObject(input.checks)) {
      onError("checks", "必须是对象");
    } else {
      for (const name of CHECK_NAMES) {
        if (!(name in input.checks)) {
          continue;
        }
        validateCheckItem(name, input.checks[name], config, onError);
      }
      // 未知检查项名 → 忽略（契约 §3.1 向前兼容）
    }
  }

  return config;
}

function validateCheckItem(
  name: CheckName,
  value: unknown,
  config: ShutdownConfig,
  onError: (path: string, problem: string) => void
) {
  const prefix = `checks.${name}`;

  if (!isPlainObject(value)) {
    onError(prefix, "必须是对象");
    return;
  }

  if ("enabled" in value) {
    if (typeof value.enabled === "boolean") {
      config.checks[name].enabled = value.enabled;
    } else {
      onError(`${prefix}.enabled`, "必须是布尔值");
    }
  }

  switch (name) {
    case "cpu":
      if ("max_percent" in value) {
        const v = value.max_percent;
        if (isFiniteNumber(v) && v >= 0 && v <= 100) {
          config.checks.cpu.max_percent = v;
        } else {
          onError("checks.cpu.max_percent", "必须是 0-100 的数字");
        }
      }
      break;
    case "load":
      if ("max_per_core" in value) {
        const v = value.max_per_core;
        if (isFiniteNumber(v) && v >= 0 && v <= 64) {
          config.checks.load.max_per_core = v;
        } else {
          onError("checks.load.max_per_core", "必须是 0-64 的数字");
        }
      }
      break;
    case "users":
      if ("max_active" in value) {
        const v = value.max_active;
        if (isInt(v) && v >= 0 && v <= 100) {
          config.checks.users.max_active = v;
        } else {
          onError("checks.users.max_active", "必须是 0-100 的整数");
        }
      }
      break;
    case "ssh":
      if ("ports" in value) {
        const problem = validatePorts(value.ports);
        if (problem === null) {
          config.checks.ssh.ports = value.ports as number[];
        } else {
          onError("checks.ssh.ports", problem);
        }
      }
      break;
    case "disk_io":
      if ("max_iowait_percent" in value) {
        const v = value.max_iowait_percent;
        if (isInt(v) && v >= 0 && v <= 100) {
          config.checks.disk_io.max_iowait_percent = v;
        } else {
          onError("checks.disk_io.max_iowait_percent", "必须是 0-100 的整数");
        }
      }
      break;
    case "network":
      if ("max_rx_kbps" in value) {
        const v = value.max_rx_kbps;
        if (isInt(v) && v >= 0 && v <= 1048576) {
          config.checks.network.max_rx_kbps = v;
        } else {
          onError("checks.network.max_rx_kbps", "必须是 0-1048576 的整数");
        }
      }
      if ("max_tx_kbps" in value) {
        const v = value.max_tx_kbps;
        if (isInt(v) && v >= 0 && v <= 1048576) {
          config.checks.network.max_tx_kbps = v;
        } else {
          onError("checks.network.max_tx_kbps", "必须是 0-1048576 的整数");
        }
      }
      if ("exclude_interfaces" in value) {
        const problem = validateExcludeInterfaces(value.exclude_interfaces);
        if (problem === null) {
          config.checks.network.exclude_interfaces = value.exclude_interfaces as string[];
        } else {
          onError("checks.network.exclude_interfaces", problem);
        }
      }
      break;
    case "min_uptime":
      if ("min_sec" in value) {
        const v = value.min_sec;
        if (isInt(v) && v >= 0 && v <= 86400) {
          config.checks.min_uptime.min_sec = v;
        } else {
          onError("checks.min_uptime.min_sec", "必须是 0-86400 的整数");
        }
      }
      break;
    case "smb_sessions":
      // 无参数，仅 enabled
      break;
    case "tcp_sessions":
      if ("ports" in value) {
        const problem = validatePorts(value.ports);
        if (problem === null) {
          config.checks.tcp_sessions.ports = value.ports as number[];
        } else {
          onError("checks.tcp_sessions.ports", problem);
        }
      }
      break;
    case "download_active":
      if ("ports" in value) {
        const problem = validatePorts(value.ports);
        if (problem === null) {
          config.checks.download_active.ports = value.ports as number[];
        } else {
          onError("checks.download_active.ports", problem);
        }
      }
      if ("max_connections" in value) {
        const v = value.max_connections;
        if (isInt(v) && v >= 0 && v <= 65535) {
          config.checks.download_active.max_connections = v;
        } else {
          onError("checks.download_active.max_connections", "必须是 0-65535 的整数");
        }
      }
      break;
    case "vm_running":
      // 无参数，仅 enabled
      break;
    case "process_running":
      if ("names" in value) {
        const problem = validateProcessNames(value.names);
        if (problem === null) {
          config.checks.process_running.names = value.names as string[];
        } else {
          onError("checks.process_running.names", problem);
        }
      }
      break;
    case "disk_scrub":
      // 无参数，仅 enabled
      break;
    case "host_online":
      if ("hosts" in value) {
        const problem = validateHosts(value.hosts);
        if (problem === null) {
          config.checks.host_online.hosts = value.hosts as string[];
        } else {
          onError("checks.host_online.hosts", problem);
        }
      }
      break;
    case "calendar_rules":
      if ("skip_weekdays" in value) {
        const problem = validateSkipWeekdays(value.skip_weekdays);
        if (problem === null) {
          config.checks.calendar_rules.skip_weekdays = value.skip_weekdays as number[];
        } else {
          onError("checks.calendar_rules.skip_weekdays", problem);
        }
      }
      if ("skip_dates" in value) {
        const problem = validateSkipDates(value.skip_dates);
        if (problem === null) {
          config.checks.calendar_rules.skip_dates = value.skip_dates as string[];
        } else {
          onError("checks.calendar_rules.skip_dates", problem);
        }
      }
      break;
  }
}

export type ReadConfigResult = {
  config: ShutdownConfig;
  // 契约 §3.1：文件缺失 / JSON 解析失败 → 全部默认值 + fallback 标志。
  fallback: boolean;
};

export async function readConfig(): Promise<ReadConfigResult> {
  let raw: string;
  try {
    raw = await readFile(getConfigFilePath(), "utf8");
  } catch {
    return { config: defaultConfig(), fallback: true };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { config: defaultConfig(), fallback: true };
  }

  if (!isPlainObject(parsed)) {
    return { config: defaultConfig(), fallback: true };
  }

  // 读取规则：单字段非法 → 该字段回退默认，其余正常采用（validateConfig 遇错不采用该字段）。
  const config = validateConfig(parsed, () => {});
  return { config, fallback: false };
}

export async function writeConfig(config: ShutdownConfig) {
  await writeFileAtomic(getConfigFilePath(), `${JSON.stringify(config, null, 2)}\n`);
}
