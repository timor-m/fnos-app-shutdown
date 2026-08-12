#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const rootDir = resolve(new URL("..", import.meta.url).pathname);
const packageDir = join(rootDir, ".fnos-build", "package");
const template = JSON.parse(readFileSync(join(rootDir, "template.config.json"), "utf8"));
const errors = [];

function check(condition, message) {
  if (!condition) {
    errors.push(message);
  }
}

function readJson(relativePath) {
  const filePath = join(packageDir, relativePath);
  check(existsSync(filePath), `Missing ${relativePath}`);
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    errors.push(`Invalid JSON in ${relativePath}: ${error.message}`);
    return null;
  }
}

function pngDimensions(relativePath) {
  const filePath = join(packageDir, relativePath);
  check(existsSync(filePath), `Missing ${relativePath}`);
  if (!existsSync(filePath)) {
    return null;
  }

  const buffer = readFileSync(filePath);
  const isPng = buffer.length >= 24 && buffer.subarray(1, 4).toString("ascii") === "PNG";
  check(isPng, `${relativePath} must be a PNG file`);
  if (!isPng) {
    return null;
  }

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

for (const relativePath of [
  "manifest",
  "config/privilege",
  "config/resource",
  "app",
  "cmd",
  "wizard",
  "app/ui/config",
  "app/server/serve.mjs"
]) {
  check(existsSync(join(packageDir, relativePath)), `Missing ${relativePath}`);
}

const manifestPath = join(packageDir, "manifest");
const manifest = {};
if (existsSync(manifestPath)) {
  for (const line of readFileSync(manifestPath, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator > 0) {
      manifest[line.slice(0, separator)] = line.slice(separator + 1);
    }
  }
}

check(manifest.appname === template.appName, "manifest.appname does not match template config");
check(manifest.source === "thirdparty", "manifest.source must be thirdparty");
check(manifest.os_min_version === template.osMinVersion, "manifest.os_min_version is missing or stale");
check(manifest.ctl_stop === "true", "service applications must expose lifecycle controls");
check(!("service_port" in manifest), "gateway applications must not declare service_port");
check(manifest.desktop_applaunchname === template.desktopLaunchName, "desktop entry ID mismatch");

const privilege = readJson("config/privilege");
check(privilege?.defaults?.["run-as"] === "package", "config/privilege must use run-as=package");

const resource = readJson("config/resource");
check(resource && Object.keys(resource).length === 0, "starter resource declaration should be empty");

const uiConfig = readJson("app/ui/config");
const uiEntry = uiConfig?.[".url"]?.[template.desktopLaunchName];
check(uiEntry?.gatewayPrefix === template.gatewayPrefix, "gatewayPrefix mismatch");
check(uiEntry?.gatewaySocket === template.gatewaySocket, "gatewaySocket mismatch");
check(uiEntry?.url === template.gatewayPrefix, "gateway URL mismatch");
// 网关入口下 port 留空（不参与路由），仅用于允许管理员在桌面入口设置直连端口
check(uiEntry?.port === "", "gateway entry port must be empty string (direct-access opt-in only)");
check(uiEntry?.allUsers === template.uiAllUsers, "allUsers mismatch with template config");
check(uiEntry?.control?.portPerm === "editable", "portPerm must be editable (允许设置直连端口)");
check(
  uiEntry?.control?.accessPerm === (template.uiAllUsers ? "editable" : "readonly"),
  "accessPerm mismatch with uiAllUsers"
);

const iconRoot = pngDimensions("ICON.PNG");
const icon256 = pngDimensions("ICON_256.PNG");
const icon512 = pngDimensions("ICON_512.PNG");
check(iconRoot?.width === 512 && iconRoot?.height === 512, "ICON.PNG must be 512 x 512");
check(icon256?.width === 256 && icon256?.height === 256, "ICON_256.PNG must be 256 x 256");
check(icon512?.width === 512 && icon512?.height === 512, "ICON_512.PNG must be 512 x 512");

for (const iconSize of [64, 256, 512]) {
  const dimensions = pngDimensions(`app/ui/images/icon_${iconSize}.png`);
  check(
    dimensions?.width === iconSize && dimensions?.height === iconSize,
    `app/ui/images/icon_${iconSize}.png has incorrect dimensions`
  );
}

for (const scriptName of [
  "main",
  "install_init",
  "install_callback",
  "upgrade_init",
  "upgrade_callback",
  "uninstall_init",
  "uninstall_callback",
  "config_init",
  "config_callback"
]) {
  const relativePath = `cmd/${scriptName}`;
  const filePath = join(packageDir, relativePath);
  check(existsSync(filePath), `Missing ${relativePath}`);
  if (existsSync(filePath)) {
    check((statSync(filePath).mode & 0o111) !== 0, `${relativePath} must be executable`);
  }
}

check(!existsSync(join(packageDir, "app/ui/index.cgi")), "gateway template must not include index.cgi");

// 安装/设置向导：提供可选直连服务端口（wizard_service_port）；卸载向导保留
for (const wizardName of ["install", "config", "uninstall"]) {
  const wizardPath = join(packageDir, "wizard", wizardName);
  check(existsSync(wizardPath), `Missing wizard/${wizardName}`);
}
for (const wizardName of ["install", "config"]) {
  const wizardPath = join(packageDir, "wizard", wizardName);
  if (existsSync(wizardPath)) {
    const steps = JSON.parse(readFileSync(wizardPath, "utf8"));
    const hasPortField = Array.isArray(steps)
      && steps.some((step) => step.items?.some((item) => item.field === "wizard_service_port"));
    check(hasPortField, `wizard/${wizardName} must collect wizard_service_port`);
  }
}

// Contract §3.5: the executor script must be packaged at app/server/assets/
// and its SCRIPT_VERSION must equal the manifest version.
const executorScriptPath = join(packageDir, "app/server/assets/fnos-shutdown-executor.sh");
check(existsSync(executorScriptPath), "Missing app/server/assets/fnos-shutdown-executor.sh");
if (existsSync(executorScriptPath)) {
  const scriptBody = readFileSync(executorScriptPath, "utf8");
  const scriptVersion = scriptBody.match(/^SCRIPT_VERSION="([^"]+)"$/m)?.[1];
  check(Boolean(scriptVersion), "executor script must define SCRIPT_VERSION");
  check(
    scriptVersion === manifest.version,
    `executor SCRIPT_VERSION (${scriptVersion}) must match manifest version (${manifest.version})`
  );
  check((statSync(executorScriptPath).mode & 0o777) === 0o644, "executor script must be 644 in the package");

  // Contract §3.6: signature file must exist and verify against the embedded SELF_UPDATE_PUBKEY
  const sigPath = `${executorScriptPath}.sig`;
  check(existsSync(sigPath), "Missing fnos-shutdown-executor.sh.sig (run npm run sign:executor)");
  if (existsSync(sigPath)) {
    const pub = scriptBody.match(/SELF_UPDATE_PUBKEY='([\s\S]*?)'/)?.[1];
    check(Boolean(pub), "executor script must embed SELF_UPDATE_PUBKEY");
    if (pub) {
      const pubTmp = join(packageDir, ".executor-pubkey.tmp.pem");
      writeFileSync(pubTmp, `${pub}\n`);
      try {
        execFileSync("openssl", ["dgst", "-sha256", "-verify", pubTmp, "-signature", sigPath, executorScriptPath], {
          stdio: ["ignore", "ignore", "ignore"]
        });
      } catch {
        check(false, "executor signature does not verify against embedded SELF_UPDATE_PUBKEY");
      } finally {
        rmSync(pubTmp, { force: true });
      }
    }
  }
}

const appArchivePath = join(rootDir, "dist", "app.tgz");
check(existsSync(appArchivePath), "Missing dist/app.tgz");
if (existsSync(appArchivePath) && manifest.checksum) {
  const checksum = createHash("md5").update(readFileSync(appArchivePath)).digest("hex");
  check(manifest.checksum === checksum, "manifest checksum does not match dist/app.tgz");
}

if (errors.length > 0) {
  console.error("fnOS package validation failed:");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("fnOS package validation passed.");
