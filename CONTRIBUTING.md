# Contributing

欢迎参与「智能关机」应用的开发与完善。

## Development

```bash
npm ci
npm run dev
```

## Build

```bash
npm run build
npm run pack:app
npm run pack:fpk
```

## Notes

- 跨端行为（配置/状态/跳过/日志、执行器行为）一律先改 `docs/CONTRACT.md` 契约再实现
- 应用元数据集中在 `template.config.json`
- 版本号以 `package.json` 为主，必须与执行器 `SCRIPT_VERSION` 同步递增
- `prepare-package` 会自动同步版本到 `manifest`
- 变更打包逻辑后必须执行 `npm run pack:app`，确保包结构校验通过
- fnOS 规范和设备测试清单见 `docs/FNOS_DEVELOPMENT.md`
