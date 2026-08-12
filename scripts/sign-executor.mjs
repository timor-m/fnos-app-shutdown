#!/usr/bin/env node
// §3.6：用离线私钥对执行器脚本签名（RSA-3072/SHA-256），产物 .sig 随包分发。
// 私钥位于 keys/executor-private.pem（gitignore，绝不入库）；丢失不致命——已部署设备
// 仅失去自动升级能力，重新生成密钥对并更新脚本内嵌公钥后，设备需重跑一次 §9 手动命令。

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const rootDir = resolve(new URL("..", import.meta.url).pathname);
const privateKeyFile = join(rootDir, "keys", "executor-private.pem");
const script = join(rootDir, "packages", "server", "assets", "fnos-shutdown-executor.sh");
const sigOut = `${script}.sig`;

// 私钥来源：本地 keys/executor-private.pem；CI 走 GitHub Secret（EXECUTOR_SIGNING_KEY，PEM 全文）
let privateKey = privateKeyFile;
if (!existsSync(privateKeyFile)) {
  const fromEnv = process.env.EXECUTOR_SIGNING_KEY;
  if (!fromEnv) {
    console.error(`Missing signing key: ${privateKeyFile}（或环境变量 EXECUTOR_SIGNING_KEY）`);
    console.error("生成：openssl genrsa -out keys/executor-private.pem 3072");
    console.error("并把公钥（openssl rsa -pubout）嵌入脚本 SELF_UPDATE_PUBKEY 常量。");
    process.exit(1);
  }
  privateKey = join(rootDir, ".fnos-build", ".executor-signing-key.tmp.pem");
  mkdirSync(dirname(privateKey), { recursive: true });
  writeFileSync(privateKey, fromEnv, { mode: 0o600 });
}

try {
  execFileSync("openssl", ["dgst", "-sha256", "-sign", privateKey, "-out", sigOut, script]);
} finally {
  if (privateKey !== privateKeyFile) rmSync(privateKey, { force: true });
}

// 立即用脚本内嵌公钥自验，防止「签了的钥匙」与「嵌进去的钥匙」不一致
const body = readFileSync(script, "utf8");
const pub = body.match(/SELF_UPDATE_PUBKEY='([\s\S]*?)'/)?.[1];
if (!pub) {
  console.error("executor script missing SELF_UPDATE_PUBKEY block");
  process.exit(1);
}
const pubTmp = join(rootDir, ".fnos-build", ".executor-pubkey.tmp.pem");
mkdirSync(dirname(pubTmp), { recursive: true });
writeFileSync(pubTmp, `${pub}\n`);
try {
  execFileSync("openssl", ["dgst", "-sha256", "-verify", pubTmp, "-signature", sigOut, script]);
} catch {
  console.error("signature does NOT match the embedded SELF_UPDATE_PUBKEY");
  process.exit(1);
} finally {
  rmSync(pubTmp, { force: true });
}
console.log(`Signed executor script: ${sigOut}`);
