# 开发说明

本项目是 Windows 桌面小组件的个人 vibe coding 练手仓库。修改前先确认是否仍在 Windows 11 x64、主屏和单用户范围内；不把实验性实现包装成跨平台或生产级保证。

## 架构入口

| 文件 | 职责 |
| --- | --- |
| `src/main.js` | Electron 入口；默认进入 manager，`--probe` / `--auto-attach` 进入 M0 探针 |
| `src/manager-main.js` | manager 主进程、窗口编排、托盘、指标服务、额度服务和退出清理 |
| `src/app-service.js` | 配置与目录业务服务 |
| `src/catalog-state.js` | 组件目录、编辑工作副本、保存/取消状态机 |
| `src/config-contract.js` | 配置 schema、组件类型、主题和 bounds 校验 |
| `src/config-store.js` | 原子写入、备份和恢复 |
| `src/manager-ipc.js` | manager IPC 命令、来源校验和错误映射 |
| `src/widget-window-service.js` | 组件 BrowserWindow 生命周期、桌面层切换、拖动、位置保存和恢复 |
| `src/widget-renderer.js` | 系统监测/时钟/便签/额度渲染、主题和编辑态交互 |
| `src/metrics-service.js` | CPU/内存采样，以及 GPU/网络异步 provider 结果合并 |
| `src/resource-metrics.js` | Windows GPU Engine 和 Network Interface 读取及不可用降级 |
| `src/codex-quota-service.js` | 本地 Codex app-server JSON-RPC quota provider 及窗口归一化 |
| `src/host-service.js` / `src/workerw-host-adapter.js` | 主屏 WorkerW 桌面宿主抽象、附着、输入和几何校验 |

## 运行命令

```powershell
npm.cmd ci
npm.cmd run manager
npm.cmd start
npm.cmd run probe
```

默认 manager 是产品入口；M0 probe 是独立研究入口，不接入 manager 的单实例路径。PowerShell 下优先使用 `npm.cmd`。

## 配置与诊断

- 正式默认配置：Electron `app.getPath('userData')\widget-config.json`。
- 测试配置：设置 `WIDGET_M1_CONFIG_PATH` 指向临时 JSON；不要让 smoke 使用真实用户配置。
- manager 诊断：默认写入当前工作目录的 `diagnostics/m1-manager.jsonl`，可用 `WIDGET_M1_REPORT` 覆盖。
- 性能报告：`diagnostics/performance-report.json`；诊断目录已被 `.gitignore` 忽略。
- `WIDGET_M1_AUTO_EXIT_MS`：仅供 smoke 自动退出。
- `WIDGET_M1_TEST_RENDERER_CRASH_MS` / `WIDGET_M1_TEST_RENDERER_CRASH_INSTANCE`：仅供 Renderer 恢复 smoke。
- `WIDGET_M1_TEST_CODEX_QUOTA` / `WIDGET_M1_TEST_CODEX_QUOTA_MS`：仅供额度 smoke 的内存 fixture 和 DOM 检查。
- `WIDGET_CODEX_EXECUTABLE`：可选地指定本地 Codex native executable；未指定时服务使用系统命令或已知的本机安装路径。
- `WIDGET_M1_HOST_MODE=floating`：仅用于诊断时显式使用普通 floating 窗口；正式默认尝试 desktop WorkerW，宿主失败时组件安全隐藏，不覆盖其他程序。

配置身份保持为 Widget：代码使用 `widget-config.json`，自启动识别正式 `Widget.exe`，不要全局替换为仓库名 `Widgets`。

## 验证与打包

```powershell
npm.cmd test
npm.cmd run smoke:manager
npm.cmd run smoke:manager-ui
npm.cmd run smoke:single-instance
npm.cmd run smoke:tray
npm.cmd run smoke:note
npm.cmd run smoke:codex-quota
npm.cmd run smoke:renderer-recovery
npm.cmd run smoke:autostart
npm.cmd run smoke:performance
npm.cmd run smoke:desktop
npm.cmd run package:portable
npm.cmd run smoke:portable
```

smoke 脚本应使用临时配置、临时 Electron profile 和临时工作目录，并在结束时清理自己创建的范围。自动化自启动 smoke 只验证 `--autostart --silent-autostart` 行为，不注册真实当前用户启动项。

portable 打包复制 Electron runtime、`src/`、`package.json` 和 koffi；生成的 `Widget.exe` 以及 `resources/app/LICENSE` 属于成品，不提交到 Git。Electron runtime 自带的 `LICENSE` / `LICENSES.chromium.html` 与 koffi 包内许可证保持独立，不以项目 MIT 文件覆盖它们。

## 人工验证边界

需要普通可见 Windows 桌面会话的检查包括：`Win+D` 后组件是否仍显示、锁定态点击是否穿透、编辑态拖动、完成/取消后重新附着、真实 Codex 登录读取、便签中文输入/粘贴/选择/滚动、托盘菜单、Explorer 重启、注销登录自启动恢复、移动 portable 后路径修复，以及 165% DPI 下的布局和可读性。未执行的项目必须在 `docs/status.md` 中保持待验证状态。
