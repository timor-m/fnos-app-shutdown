# fnOS 应用开发规范

本文根据飞牛应用开发者平台文档整理，作为本应用的开发、评审和发布基线。最后核对日期：2026-07-20。

> 注：文中部分示例沿用上游模板的 `fnos-app-template` 命名，阅读时对应替换为本应用的 `fnos-app-shutdown` 即可；规范结论不受影响。

## 1. 开发与发布流程

1. 准备独立 fnOS 测试设备、管理员账号、可用存储空间和网络访问。
2. 在开发机编写代码，使用 `fnpack` 创建或构建应用包。
3. 通过应用中心手动安装，或在设备上使用 `appcenter-cli install-fpk`。
4. 验证安装、入口、主流程、权限、异常依赖、升级和卸载。
5. 准备最终 `.fpk`、图标、真实界面截图、更新说明和测试材料。
6. 按应用中心当前的开发者提交渠道上架。

手动安装只用于本地测试，不应作为公开分发方式。

## 2. 包目录

```text
package/
├── app/                  安装到 TRIM_APPDEST
│   ├── server/
│   └── ui/
├── cmd/                  生命周期脚本
├── config/
│   ├── privilege
│   └── resource
├── wizard/
├── manifest
├── ICON.PNG              512 x 512
└── ICON_256.PNG          256 x 256
```

安装后应通过系统环境变量定位目录：

- `TRIM_APPDEST`：应用文件
- `TRIM_PKGETC`：配置
- `TRIM_PKGVAR`：持久运行数据
- `TRIM_PKGTMP`：临时文件
- `TRIM_PKGHOME`：应用用户数据
- `TRIM_DATA_SHARE_PATHS`：声明的数据共享目录
- `TRIM_DATA_ACCESSIBLE_PATHS`：用户授权目录
- `TRIM_TEMP_LOGFILE`：面向用户的生命周期错误信息

生命周期脚本不得依赖硬编码的 `/var/apps/{appname}` 应用路径。

## 3. 生命周期

`cmd/main` 必须支持：

- `start`：幂等启动应用
- `stop`：幂等停止应用
- `status`：运行返回 `0`，未运行返回 `3`

其他标准脚本：

- `install_init` / `install_callback`
- `upgrade_init` / `upgrade_callback`
- `uninstall_init` / `uninstall_callback`
- `config_init` / `config_callback`

脚本应可重复执行。失败前把简短、可操作的信息写入 `TRIM_TEMP_LOGFILE`。

本模板把 PID、日志和业务数据保存在 `TRIM_PKGVAR`，Socket 保存在 `TRIM_APPDEST`。启动后会检查进程与 Socket，停止时先发送 `TERM`，超时后再发送 `KILL`。

## 4. Manifest

本模板使用的关键字段：

```text
source=thirdparty
platform=all
install_dep_apps=nodejs_v22
os_min_version=1.1.3100
ctl_stop=true
disable_authorization_path=true
```

约束：

- 第三方应用必须使用 `source=thirdparty`。
- `platform=all` 只适用于没有架构相关二进制的包。
- 统一网关应用不声明 `service_port`。
- 最低系统版本必须反映真实测试范围。
- 服务应用使用 `ctl_stop=true` 提供启停和状态控制。
- 当前模板不访问用户目录，因此隐藏授权目录设置；派生应用需要用户文件时必须调整。

## 5. 访问模型

官方提供三种模型：

| 模型 | 适合 | 限制 |
| --- | --- | --- |
| `index.cgi` | 小型静态页、轻量兼容包 | 每次请求启动进程，不支持 WebSocket |
| 统一网关 | 常驻服务、API、WebSocket、NAS 登录态 | 服务需监听 Unix Socket 并适配前缀 |
| 独立端口 | 与 NAS 登录态无关的独立服务 | 应用自行处理认证与端口暴露 |

本模板默认统一网关：

```text
gatewayPrefix=/app/fnos-app-template
gatewaySocket=app.sock
```

服务监听 `${TRIM_APPDEST}/app.sock`。网关校验 NAS 会话后转发请求，并提供：

- `X-Trim-Userid`
- `X-Trim-Username`
- `X-Trim-Isadmin`

网关只证明用户已登录。应用仍需执行数据归属、管理员操作、文件路径和高风险操作的业务鉴权。不要信任客户端请求体或 WebSocket 消息里的用户 ID。

## 6. 权限与资源

默认权限：

```json
{
  "defaults": {
    "run-as": "package"
  },
  "username": "fnos-app-template",
  "groupname": "fnos-app-template"
}
```

原则：

- 长期运行和面向用户的服务使用专用包用户。
- 只有确需硬件用户组时才添加 `join-groups`。
- 不为方便而使用 root。
- `config/resource` 只声明实际使用的资源。
- 数据共享目录通常不需要给自身重复配置 `permission`，系统会授予应用用户所需 ACL。

本模板不需要用户可见共享目录，因此 `config/resource` 默认为 `{}`。派生应用需要导入、导出或让用户在文件管理器中管理内容时，再声明 `data-share`。

## 7. 用户向导

只有无法安全自动检测或默认处理的必需配置才使用向导。字段会作为同名环境变量传给生命周期脚本，使用前必须再次校验。

本应用经安装/设置向导提供可选直连服务端口（0 = 不启用，仅统一网关），向导值持久化到 `TRIM_PKGVAR/service-port` 后由 `cmd/main` 读取；卸载向导保留数据处理选项：

- `keep`：保留数据
- `delete`：删除 `TRIM_PKGVAR` 下的业务数据和日志

敏感字段应使用 `password`，不得写入日志或提交环境变量文件。

## 8. 图标

包根目录：

- `ICON.PNG`：512 x 512，用于应用中心/应用详情页等大图展示
- `ICON_256.PNG`：256 x 256

要求：

- PNG 或 JPG，sRGB
- 单文件不超过 1024 KB
- 正方形画布
- 512px 和 256px 下主体清晰，64px 入口图标由 `app/ui/images/icon_64.png` 提供
- 视觉主体使用符合系统风格的圆角和留白

入口使用 `app/ui/images/icon_{0}.png`。模板校验根 512px、256px 和入口多尺寸文件存在且尺寸正确。

## 9. 本地与设备验证

本地：

```bash
npm ci
npm run dev
npm run build
npm start
```

Unix Socket 模拟：

```bash
FNOS_SOCKET_PATH=/tmp/fnos-app-template.sock npm start
curl --unix-socket /tmp/fnos-app-template.sock \
  http://localhost/app/fnos-app-template/api/health
```

打包：

```bash
npm run download:fnpack
npm run pack:fpk
```

设备：

```bash
appcenter-cli install-fpk fnos-app-template.fpk
appcenter-cli start fnos-app-template
appcenter-cli stop fnos-app-template
```

## 10. 发布检查

- [ ] `npm ci`、`npm run build`、`npm run pack:fpk` 成功
- [ ] `.fpk` 可在干净设备安装
- [ ] 应用可启动、停止并正确返回状态
- [ ] 桌面入口在 HTTP 和 HTTPS 访问 NAS 时均可打开
- [ ] 普通用户与管理员权限边界正确
- [ ] 用户只能访问自己的数据
- [ ] 输入、ID 和文件路径均有校验
- [ ] 依赖不可用、配置错误、磁盘不足时有清晰错误
- [ ] 升级保留配置与数据
- [ ] 卸载的保留/删除选项符合用户选择
- [ ] manifest 版本、兼容范围、维护者和 changelog 准确
- [ ] 图标、真实界面截图和测试材料齐全

## 11. 官方来源

- [欢迎与学习路径](https://developer.fnnas.com/docs/guide/)
- [应用框架](https://developer.fnnas.com/docs/core-concepts/framework/)
- [Manifest](https://developer.fnnas.com/docs/core-concepts/manifest/)
- [环境变量](https://developer.fnnas.com/docs/core-concepts/environment-variables/)
- [应用权限](https://developer.fnnas.com/docs/core-concepts/privilege/)
- [应用资源](https://developer.fnnas.com/docs/core-concepts/resource/)
- [应用入口](https://developer.fnnas.com/docs/core-concepts/app-entry/)
- [统一网关](https://developer.fnnas.com/docs/core-concepts/gateway-registration/)
- [用户向导](https://developer.fnnas.com/docs/core-concepts/wizard/)
- [运行时环境](https://developer.fnnas.com/docs/core-concepts/runtime/)
- [图标](https://developer.fnnas.com/docs/core-concepts/icon/)
- [Native 应用案例](https://developer.fnnas.com/docs/examples/native/)
- [fnpack](https://developer.fnnas.com/docs/cli/fnpack/)
- [appcenter-cli](https://developer.fnnas.com/docs/cli/appcentercli/)
