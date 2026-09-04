#!/usr/bin/env node

import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const rootDir = resolve(dirname(new URL(import.meta.url).pathname), "..");
const packageDir = join(rootDir, ".fnos-build", "package");
const distDir = join(rootDir, "dist");
const outputDir = join(rootDir, ".server-dist");
const template = JSON.parse(readFileSync(join(rootDir, "template.config.json"), "utf8"));
const packageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
const version = packageJson.version || "0.1.0";
const subVersion = `${version}.0`;

function assertConfig(condition, message) {
  if (!condition) {
    throw new Error(`Invalid template.config.json: ${message}`);
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

assertConfig(/^[A-Za-z][A-Za-z0-9_-]*$/.test(template.appName), "appName must be URL and shell safe");
assertConfig(
  template.gatewayPrefix === `/app/${template.appName}`
    || template.gatewayPrefix.startsWith(`/app/${template.appName}/`),
  "gatewayPrefix must use /app/{appName}"
);
assertConfig(/^[A-Za-z0-9_-]+\.sock$/.test(template.gatewaySocket), "gatewaySocket must be a socket filename");
assertConfig(template.source === "thirdparty", "third-party applications must use source=thirdparty");
assertConfig(template.runAs === "package", "the template must use the least-privileged package user");

if (!existsSync(outputDir)) {
  throw new Error("Missing .server-dist directory. Run `npm run build` first.");
}

rmSync(packageDir, { recursive: true, force: true });
mkdirSync(packageDir, { recursive: true });
mkdirSync(distDir, { recursive: true });

const appRoot = join(packageDir, "app");
const appServer = join(appRoot, "server");
const appUi = join(appRoot, "ui");
const appUiImages = join(appUi, "images");
const cmdDir = join(packageDir, "cmd");
const configDir = join(packageDir, "config");
const wizardDir = join(packageDir, "wizard");

for (const dir of [appServer, appUiImages, cmdDir, configDir, wizardDir]) {
  mkdirSync(dir, { recursive: true });
}

cpSync(outputDir, appServer, { recursive: true });

// Contract §3.5: ship the executor script inside the package and keep its
// SCRIPT_VERSION in sync with the app version.
const executorScriptSrc = join(rootDir, "packages", "server", "assets", "fnos-shutdown-executor.sh");
if (!existsSync(executorScriptSrc)) {
  throw new Error("Missing packages/server/assets/fnos-shutdown-executor.sh");
}
const executorScriptBody = readFileSync(executorScriptSrc, "utf8");
const scriptVersionMatch = executorScriptBody.match(/^SCRIPT_VERSION="([^"]+)"$/m);
if (!scriptVersionMatch) {
  throw new Error("fnos-shutdown-executor.sh must define SCRIPT_VERSION=\"x.y.z\"");
}
if (scriptVersionMatch[1] !== version) {
  throw new Error(
    `Executor SCRIPT_VERSION (${scriptVersionMatch[1]}) must match package version (${version})`
  );
}
const appServerAssets = join(appServer, "assets");
mkdirSync(appServerAssets, { recursive: true });
copyFileSync(executorScriptSrc, join(appServerAssets, "fnos-shutdown-executor.sh"));
chmodSync(join(appServerAssets, "fnos-shutdown-executor.sh"), 0o644);
// §3.6：签名文件随包分发（npm run sign:executor 生成）
const executorSigSrc = `${executorScriptSrc}.sig`;
if (!existsSync(executorSigSrc)) {
  throw new Error("Missing fnos-shutdown-executor.sh.sig. Run `npm run sign:executor` first.");
}
copyFileSync(executorSigSrc, join(appServerAssets, "fnos-shutdown-executor.sh.sig"));
chmodSync(join(appServerAssets, "fnos-shutdown-executor.sh.sig"), 0o644);

const iconsDir = join(rootDir, "packages", "assets", "icons");
const generatedIconsDir = join(iconsDir, "generated");
const packageIcon512Root = join(iconsDir, "ICON.PNG");
const packageIcon256 = join(iconsDir, "ICON_256.PNG");
const packageIcon512 = join(generatedIconsDir, "icon_512.png");
const uiIconSizes = [32, 48, 64, 72, 96, 128, 256, 512];

if (!existsSync(packageIcon512Root) || !existsSync(packageIcon256) || !existsSync(packageIcon512)) {
  throw new Error("Missing required 512px root, 256px or generated 512px package icon.");
}

copyFileSync(packageIcon512Root, join(packageDir, "ICON.PNG"));
copyFileSync(packageIcon256, join(packageDir, "ICON_256.PNG"));
copyFileSync(packageIcon512, join(packageDir, "ICON_512.PNG"));

for (const size of uiIconSizes) {
  const generatedIcon = join(generatedIconsDir, `icon_${size}.png`);
  if (!existsSync(generatedIcon)) {
    throw new Error(`Missing UI icon: packages/assets/icons/generated/icon_${size}.png`);
  }
  copyFileSync(generatedIcon, join(appUiImages, `icon_${size}.png`));
}

const licensePath = join(rootDir, "LICENSE");
if (existsSync(licensePath)) {
  copyFileSync(licensePath, join(packageDir, "LICENSE"));
}

const privilege = {
  defaults: {
    "run-as": template.runAs
  },
  username: template.appName,
  groupname: template.appName
};

// The starter does not require user-visible shares or system integration.
const resource = {};

const manifest = `appname=${template.appName}
version=${version}
sub_version=${subVersion}
display_name=${template.displayName}
desc=${template.appDescription}
changelog=${template.releaseNotes.summary}
source=${template.source}
platform=${template.platform}
maintainer=${template.maintainer}
maintainer_url=${template.maintainerUrl}
distributor=${template.distributor}
distributor_url=${template.distributorUrl}
os_min_version=${template.osMinVersion}
desktop_uidir=ui
desktop_applaunchname=${template.desktopLaunchName}
install_dep_apps=${template.runtimeDependency}
ctl_stop=true
disable_authorization_path=true
checksum=__APP_TGZ_MD5__
`;

const uiConfig = {
  ".url": {
    [template.desktopLaunchName]: {
      title: template.appTitle,
      icon: "images/icon_{0}.png",
      type: "iframe",
      protocol: "http",
      // 统一网关入口下 protocol/port 不参与路由（官方文档）；port 留空 + portPerm editable，
      // 允许管理员在桌面入口设置里填写直连端口（对应安装/设置向导的 wizard_service_port）
      port: "",
      gatewayPrefix: template.gatewayPrefix,
      gatewaySocket: template.gatewaySocket,
      url: template.gatewayPrefix,
      allUsers: template.uiAllUsers,
      control: {
        accessPerm: template.uiAllUsers ? "editable" : "readonly",
        portPerm: "editable"
      }
    }
  }
};

const serverLauncher = `#!/usr/bin/env node

import { chmodSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { handleUpgrade, middleware } from "./server/index.mjs";

const socketPath = process.env.FNOS_SOCKET_PATH || "";
// SERVICE_PORT：安装/设置向导配置的直连端口（0/空 = 不启用）；无 Socket 的本地开发回退 PORT/NITRO_PORT
const servicePort = Number(process.env.SERVICE_PORT || 0);
const devPort = Number(process.env.PORT || process.env.NITRO_PORT || 3000);
const host = process.env.HOST || process.env.NITRO_HOST || "127.0.0.1";

const servers = [];

function listen(socket, port, listenHost) {
  const server = createServer(middleware);
  if (handleUpgrade) {
    server.on("upgrade", handleUpgrade);
  }
  server.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  if (socket) {
    server.listen(socket, () => {
      chmodSync(socket, 0o660);
      console.log(\`fnOS gateway socket listening at \${socket}\`);
    });
  } else {
    server.listen(port, listenHost, () => {
      console.log(\`Nitro listening at http://\${listenHost}:\${port}\`);
    });
  }
  servers.push(server);
}

function cleanupSocket() {
  if (socketPath) {
    rmSync(socketPath, { force: true });
  }
}

function shutdown() {
  for (const server of servers) {
    server.close();
  }
  cleanupSocket();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

if (socketPath) {
  cleanupSocket();
  listen(socketPath, 0, "");
  // 直连端口仅供 NAS 本机部署脚本使用，绑定回环地址，禁止通过局域网绕过网关鉴权
  if (servicePort > 0) {
    listen("", servicePort, "127.0.0.1");
  }
} else {
  listen("", servicePort > 0 ? servicePort : devPort, host);
}
`;

const appNameShell = shellQuote(template.appName);
const appTitleShell = shellQuote(template.appTitle);
const gatewayPrefixShell = shellQuote(template.gatewayPrefix);
const runtimeBinShell = shellQuote(`/var/apps/${template.runtimeDependency}/target/bin`);

const cmdMain = `#!/bin/bash

LOG_FILE="\${TRIM_PKGVAR}/info.log"
PID_FILE="\${TRIM_PKGVAR}/app.pid"
APP_DIR="\${TRIM_APPDEST}/server"
SERVER_ENTRY="\${APP_DIR}/serve.mjs"
SOCKET_PATH="\${TRIM_APPDEST}/${template.gatewaySocket}"
PORT_FILE="\${TRIM_PKGVAR}/service-port"

export PATH=${runtimeBinShell}:"\${PATH}"

log_msg() {
    mkdir -p "\${TRIM_PKGVAR}"
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" >> "\${LOG_FILE}"
}

report_error() {
    log_msg "$1"
    if [ -n "\${TRIM_TEMP_LOGFILE:-}" ]; then
        printf "%s\\n" "$1" > "\${TRIM_TEMP_LOGFILE}"
    fi
}

read_pid() {
    [ -r "\${PID_FILE}" ] || return 1
    pid="$(head -n 1 "\${PID_FILE}" | tr -d '[:space:]')"
    case "\${pid}" in
        ""|*[!0-9]*) return 1 ;;
    esac
    printf "%s" "\${pid}"
}

is_running() {
    pid="$(read_pid)" || return 1
    kill -0 "\${pid}" 2>/dev/null
}

status_app() {
    if is_running; then
        return 0
    fi
    rm -f "\${PID_FILE}" "\${SOCKET_PATH}"
    return 1
}

start_app() {
    if status_app; then
        return 0
    fi

    if ! command -v node >/dev/null 2>&1; then
        report_error "Node.js runtime is unavailable. Reinstall the required ${template.runtimeDependency} dependency."
        return 1
    fi

    if [ ! -f "\${SERVER_ENTRY}" ]; then
        report_error "Application server entry is missing."
        return 1
    fi

    mkdir -p "\${TRIM_PKGVAR}/data" "\${TRIM_PKGVAR}/log"
    rm -f "\${SOCKET_PATH}"
    log_msg "Starting ${template.appName}"

    # 直连服务端口（安装/设置向导写入 PORT_FILE；0/空/非法 = 不启用，仅网关访问）
    SERVICE_PORT=""
    if [ -r "\${PORT_FILE}" ]; then
        candidate="$(head -n 1 "\${PORT_FILE}" | tr -d '[:space:]')"
        case "\${candidate}" in
            ""|*[!0-9]*) ;;
            *) [ "\${candidate}" -ge 1024 ] && [ "\${candidate}" -le 65535 ] && SERVICE_PORT="\${candidate}" ;;
        esac
    fi

    APP_NAME=${appNameShell} \\
    APP_TITLE=${appTitleShell} \\
    GATEWAY_PREFIX=${gatewayPrefixShell} \\
    FNOS_SOCKET_PATH="\${SOCKET_PATH}" \\
    SERVICE_PORT="\${SERVICE_PORT}" \\
    LOG_DIR="\${TRIM_PKGVAR}/log" \\
    STORAGE_DIR="\${TRIM_PKGVAR}/data" \\
    node "\${SERVER_ENTRY}" >> "\${LOG_FILE}" 2>&1 &

    printf "%s" "$!" > "\${PID_FILE}"
    count=0
    while [ "\${count}" -lt 10 ]; do
        if status_app && [ -S "\${SOCKET_PATH}" ]; then
            return 0
        fi
        sleep 1
        count=$((count + 1))
    done

    report_error "Application failed to start within 10 seconds. Check \${LOG_FILE}."
    return 1
}

stop_app() {
    if ! is_running; then
        rm -f "\${PID_FILE}" "\${SOCKET_PATH}"
        return 0
    fi

    pid="$(read_pid)"
    log_msg "Stopping ${template.appName}"
    kill -TERM "\${pid}" 2>> "\${LOG_FILE}" || true

    count=0
    while kill -0 "\${pid}" 2>/dev/null && [ "\${count}" -lt 10 ]; do
        sleep 1
        count=$((count + 1))
    done

    if kill -0 "\${pid}" 2>/dev/null; then
        kill -KILL "\${pid}" 2>> "\${LOG_FILE}" || true
    fi

    rm -f "\${PID_FILE}" "\${SOCKET_PATH}"
}

case "\${1:-}" in
    start)
        start_app
        ;;
    stop)
        stop_app
        ;;
    status)
        if status_app; then
            exit 0
        fi
        exit 3
        ;;
    *)
        report_error "Unknown application command: \${1:-<empty>}"
        exit 1
        ;;
esac
`;

// 服务端口向导项：install/config 共用。0 = 不启用直连端口（仅统一网关访问）
const servicePortWizardItem = {
  type: "text",
  field: "wizard_service_port",
  label: "服务端口",
  initValue: String(template.servicePort),
  rules: [
    { required: true, message: "请输入服务端口，填 0 表示不启用" },
    { pattern: "^(0|[0-9]{4,5})$", message: "端口须为 0 或 1024-65535 的整数" }
  ]
};

const servicePortTips = {
  type: "tips",
  helpText:
    "直连端口仅绑定 NAS 本机回环地址（127.0.0.1），用于部署页从本机下载执行器脚本，不对局域网开放，也不会提供绕过网关的远程访问。修改端口后需重启应用生效。"
};

const installWizard = [
  {
    stepTitle: "服务设置",
    items: [servicePortTips, servicePortWizardItem]
  }
];

const configWizard = [
  {
    stepTitle: "服务设置",
    items: [servicePortTips, servicePortWizardItem]
  }
];

const uninstallWizard = [
  {
    stepTitle: "确认卸载",
    items: [
      {
        type: "tips",
        helpText: "您即将卸载此应用。请选择是否删除应用数据与日志。"
      },
      {
        type: "radio",
        field: "wizard_data_action",
        label: "数据处理",
        initValue: "keep",
        options: [
          { label: "保留数据", value: "keep" },
          { label: "删除数据", value: "delete" }
        ],
        rules: [
          {
            required: true,
            message: "请选择数据处理方式"
          }
        ]
      }
    ]
  }
];

// 端口持久化：向导值以字符串处理并再次校验（官方要求），合法则写入 TRIM_PKGVAR/service-port，
// cmd/main start 时读取。非法输入回退默认端口，不阻断安装/配置流程。
const persistServicePort = `
port="\${wizard_service_port:-${template.servicePort}}"
case "\${port}" in
    ""|*[!0-9]*) port="${template.servicePort}" ;;
    *) { [ "\${port}" -lt 1024 ] || [ "\${port}" -gt 65535 ]; } && [ "\${port}" != "0" ] && port="${template.servicePort}" ;;
esac
printf "%s" "\${port}" > "\${TRIM_PKGVAR}/service-port"
`;

const callbackScripts = {
  install_init: "#!/bin/bash\nexit 0\n",
  install_callback: `#!/bin/bash
${persistServicePort}
exit 0
`,
  upgrade_init: "#!/bin/bash\nexit 0\n",
  upgrade_callback: "#!/bin/bash\nexit 0\n",
  uninstall_init: "#!/bin/bash\nexit 0\n",
  uninstall_callback: `#!/bin/bash

if [ "\${wizard_data_action:-keep}" = "delete" ]; then
    rm -rf "\${TRIM_PKGVAR:?}/data" "\${TRIM_PKGVAR:?}/log"
fi

exit 0
`,
  config_init: "#!/bin/bash\nexit 0\n",
  config_callback: `#!/bin/bash
${persistServicePort}
exit 0
`
};

writeFileSync(join(packageDir, "manifest"), manifest, "utf8");
writeFileSync(join(configDir, "privilege"), `${JSON.stringify(privilege, null, 2)}\n`, "utf8");
writeFileSync(join(configDir, "resource"), `${JSON.stringify(resource, null, 2)}\n`, "utf8");
writeFileSync(join(appUi, "config"), `${JSON.stringify(uiConfig, null, 2)}\n`, "utf8");
writeFileSync(join(appServer, "serve.mjs"), serverLauncher, "utf8");
writeFileSync(join(cmdDir, "main"), cmdMain, "utf8");

for (const [name, content] of Object.entries(callbackScripts)) {
  writeFileSync(join(cmdDir, name), content, "utf8");
}

writeFileSync(join(wizardDir, "install"), `${JSON.stringify(installWizard, null, 2)}\n`, "utf8");
writeFileSync(join(wizardDir, "config"), `${JSON.stringify(configWizard, null, 2)}\n`, "utf8");
writeFileSync(join(wizardDir, "uninstall"), `${JSON.stringify(uninstallWizard, null, 2)}\n`, "utf8");

for (const path of [
  join(cmdDir, "main"),
  ...Object.keys(callbackScripts).map((name) => join(cmdDir, name))
]) {
  chmodSync(path, 0o755);
}

console.log(`Prepared fnOS package directory: ${packageDir}`);
