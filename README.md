# 智能关机（fnos-app-shutdown）

飞牛 fnOS Native 应用：在设定的夜间工作阶段内（默认 23:00–08:00），经 CPU、负载、在线用户、SSH、磁盘 IO、网络等空闲检查全部通过后自动关机。采用官方统一网关访问模型，通过 Unix Socket 接入 NAS 登录态，不直接暴露应用端口。

应用（Web 配置/状态/日志）与 root 执行器（cron 触发、真正执行关机判定）完全经文件系统原子通信，协作契约见 [docs/CONTRACT.md](docs/CONTRACT.md)——所有跨端行为以契约为准，改动先改契约再实现。

## 功能

- 工作阶段 + 15 项空闲检查项（CPU、负载、在线用户、SSH 会话、磁盘 IO、网络收发、最小运行时长、SMB 会话、TCP 会话、下载连接、虚拟机、进程、磁盘擦洗、主机在线、日历规则），逐项开关/阈值可配
- 部署向导：执行器一键部署命令、三态健康检测（正常/版本过旧/运行异常）
- 运行日志按月滚动、按「次」分组展示，支持日期筛选、关键字高亮、滚动加载
- 今晚跳过（skip.json fail-safe）、手动检测当前是否满足关机条件
- 明亮/暗黑双主题

## 应用截图

以下截图来自 iPhone SE 尺寸（375×667）高清预览：

| 状态 | 设置 |
| --- | --- |
| ![状态页](snapshots/iphone-se-status.jpg) | ![设置页](snapshots/iphone-se-settings.jpg) |

| 日志 | 部署 |
| --- | --- |
| ![日志页](snapshots/iphone-se-logs.jpg) | ![部署页](snapshots/iphone-se-deploy.jpg) |

![关于页](snapshots/iphone-se-about.jpg)

## 环境要求

- Node.js 22、npm
- 用于安装测试的 fnOS 设备
- `fnpack 1.2.3`，可通过项目命令下载
- 设备端 `appcenter-cli`，用于脚本化安装测试

## 快速开始

```bash
npm ci
npm run dev
```

本地访问：

```text
http://127.0.0.1:3333/app/fnos-app-shutdown/
```

开发模式同时启动 Nitro 和 Vite，前端与 API 都使用网关前缀，尽早模拟安装后的路径行为。
端口被占用时可使用 `APP_PORT=3350 WEB_PORT=3351 npm run dev`。

## 配置

应用元数据集中在 `template.config.json`：

- `appName`：应用唯一标识（`fnos-app-shutdown`）
- `gatewayPrefix`：必须使用 `/app/{appName}` 或其子路径
- `gatewaySocket`：安装目录下的 Unix Socket 文件名
- `runtimeDependency`：默认 `nodejs_v22`
- `osMinVersion`：统一网关国内版最低要求，默认 `1.1.3100`
- `maintainer`、`distributor`：发布信息
- `uiAllUsers`：桌面入口是否对所有用户可见（默认开启，访问权限可编辑）
- `servicePort`：可选直连服务端口默认值（默认 8366；安装/设置向导可改，0 = 关闭直连、仅统一网关）。直连访问不经过 NAS 登录校验，面向局域网开放时请自行评估风险；修改后需重启应用生效

版本号以 `package.json.version` 为准，打包时同步到 `manifest`，并强制与执行器脚本 `SCRIPT_VERSION` 一致（契约 §3.3 三态检测依赖这一致性）。

## 构建与打包

```bash
npm run build
npm run pack:app
npm run download:fnpack
npm run pack:fpk
```

`pack:app` 会执行构建、生成 fnOS 包目录、创建 `app.tgz`，并校验：

- manifest 关键字段、网关入口与 Socket 配置
- 权限和资源声明、生命周期脚本及可执行权限
- 512px 包根图标、256px 包图标和多尺寸入口图标
- 执行器 `SCRIPT_VERSION` 与 `package.json.version` 一致
- `app.tgz` checksum

构建产物：

- `dist/app.tgz`、`dist/*.fpk`
- `.fnos-build/package/`，用于排查最终包内容

## 设备测试

手动测试可从应用中心选择 `.fpk` 安装。脚本化测试在 fnOS 设备执行：

```bash
appcenter-cli install-fpk fnos-app-shutdown-<version>.fpk
appcenter-cli start fnos-app-shutdown
appcenter-cli list
```

安装后在「部署」页复制一键命令，SSH 到设备执行即可完成执行器首次部署（幂等）。
此后应用升级时执行器自动验签同步新版（契约 §3.6），无需再跑命令；验签失败会记日志并继续旧版。

执行器签名私钥位于 `keys/executor-private.pem`（gitignore，离线保管）；CI 通过 GitHub Secret `EXECUTOR_SIGNING_KEY`（PEM 全文）注入。
发布前应在干净设备上验证安装、启动、停止、升级、卸载保留/删除数据，以及普通用户和管理员的访问边界。

## 目录

```text
packages/ui/              Vue 前端（状态/设置/日志/部署/关于）
packages/server/          Nitro API、配置/跳过/状态/日志服务与执行器脚本资产
packages/assets/          fnOS 图标资源
scripts/                  开发、构建、打包与校验脚本
docs/CONTRACT.md          执行器 ↔ 应用协作契约（权威文档）
docs/FNOS_DEVELOPMENT.md  官方开发规范摘要与发布清单
.ui-dist/                 前端构建产物
.server-dist/             Nitro 构建产物
.fnos-build/package/      fnOS 包目录
data/                     本机开发运行数据（dev 专用，不入库）
dist/                     发布产物
```

## 官方资料

- [飞牛应用开发者平台](https://developer.fnnas.com/docs/guide/)
- [Native 应用案例](https://developer.fnnas.com/docs/examples/native/)
- [统一网关](https://developer.fnnas.com/docs/core-concepts/gateway-registration/)
- [fnpack](https://developer.fnnas.com/docs/cli/fnpack/)

仓库内的对照结论和维护清单见 [docs/FNOS_DEVELOPMENT.md](docs/FNOS_DEVELOPMENT.md)。
