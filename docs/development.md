# 开发说明

本项目是 Windows 桌面小组件的个人 vibe coding 练手仓库。修改前先确认是否仍在 Windows 11 x64、主屏和单用户范围内；不把实验性实现包装成跨平台或生产级保证。

## 架构入口

| 文件 | 职责 |
| --- | --- |
| `src/main.js` | Electron 入口；默认进入 manager，`--probe` / `--auto-attach` 进入 M0 探针 |
| `src/manager-main.js` | manager 主进程、窗口编排、托盘、指标服务、额度服务和退出清理 |
| `src/manager-renderer.js` / `src/manager-pagination.js` | manager 页面渲染、组件分页、响应式容量和编辑面板交互；分页模型可独立回归测试 |
| `src/app-service.js` | 配置与目录业务服务 |
| `src/catalog-state.js` | 组件目录、编辑工作副本、保存/取消状态机 |
| `src/config-contract.js` | 配置 schema、组件类型、主题和 bounds 校验 |
| `src/config-store.js` | 原子写入、备份和恢复 |
| `src/manager-ipc.js` | manager IPC 命令、来源校验和错误映射 |
| `src/widget-window-service.js` | 组件 BrowserWindow 生命周期、桌面层切换、拖动、位置保存和恢复 |
| `src/desktop-input-router.js` | WorkerW 待办区域的鼠标转发；普通应用遮挡、锁定、隐藏和布局编辑时不转发新点击 |
| `src/widget-renderer.js` | 系统监测/时钟/便签/每日待办/额度渲染、主题和编辑态交互 |
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
- `WIDGET_M1_TEST_TODO_MS` / `WIDGET_M1_TEST_TODO_TITLE`：仅供每日待办 smoke 的临时 DOM 交互和保存检查。
- `WIDGET_M1_TEST_MANAGER_SCREENSHOT_DIR`：仅供 manager UI smoke 将实际 Electron 页面抓取到指定临时目录；不应指向仓库提交路径。
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
npm.cmd run smoke:todo
npm.cmd run smoke:codex-quota
npm.cmd run smoke:renderer-recovery
npm.cmd run smoke:autostart
npm.cmd run smoke:performance
npm.cmd run smoke:desktop
npm.cmd run package:portable
npm.cmd run smoke:portable
```

smoke 脚本应使用临时配置、临时 Electron profile 和临时工作目录，并在结束时清理自己创建的范围。manager UI smoke 还会覆盖目录首末页、窗口缩放后的页容量、编辑面板替换和滚动高度检查；需要图片证据时使用 `WIDGET_M1_TEST_MANAGER_SCREENSHOT_DIR` 将抓图放在仓库外。自动化自启动 smoke 只验证 `--autostart --silent-autostart` 行为，不注册真实当前用户启动项。

每日待办配置保存在组件私有配置中：`dateKey` 是本地日期，`items` 最多 64 条，每条只包含稳定 `id`、纯文本 `title` 和 `completed`。Widget 启动时检测日期变化并清空上一日任务；运行中跨午夜的刷新由组件窗口定时检查完成。新增和勾选通过 `widget-preload.js` 暴露的受控 IPC 保存，不直接访问文件系统。桌面交互默认开启；标题条锁定按钮和托盘菜单只切换窗口运行时输入模式，不新增或修改配置字段，锁定后可由托盘恢复。

portable 打包复制 Electron runtime、`src/`、`package.json` 和 koffi；生成的 `Widget.exe` 以及 `resources/app/LICENSE` 属于成品，不提交到 Git。Electron runtime 自带的 `LICENSE` / `LICENSES.chromium.html` 与 koffi 包内的许可证（当前包为 `LICENSE.txt`）保持独立，不以项目 MIT 文件覆盖它们。

## 待办桌面输入验证

`npm.cmd run smoke:todo-desktop` 使用临时 Electron profile 和内存待办，在真实 WorkerW 上通过系统鼠标/键盘输入验证光标能移入组件、焦点、新增、勾选和锁定/解锁；不使用真实配置，也不通过 DOM `.click()` 触发操作。测试通过系统移动事件并回读光标坐标检查移动是否被阻挡，只有清理时才直接恢复光标位置。请先露出主屏右下方的测试区域。测试会短暂移动鼠标，结束后恢复位置。

需要自动处理遮挡时可运行 `npm.cmd run smoke:todo-desktop -- --minimize-obstruction`，允许脚本短暂最小化遮挡测试点的普通应用窗口，结束后恢复其原窗口状态。此测试需要可见桌面会话，不能把无桌面的沙箱执行结果当作实机输入证据。

Windows 11 的壁纸 WorkerW 可能处于禁用状态。交互期间原生适配器暂时启用父窗口，并在最后一个交互组件锁定或脱离时恢复原状态。鼠标钩子仅转发每日待办区域中被同一桌面宿主接走的输入，不拦截键盘输入；键盘通过原生窗口焦点进入组件。Koffi 固定为 2.15.2，以包含 Node 24.14+ 回调退出崩溃的修复。

## 人工验证边界

需要普通可见 Windows 桌面会话的检查包括：`Win+D` 后组件是否仍显示、锁定态点击是否穿透、编辑态拖动、完成/取消后重新附着、真实 Codex 登录读取、便签中文输入/粘贴/选择/滚动、托盘菜单、Explorer 重启、注销登录自启动恢复、移动 portable 后路径修复，以及 165% DPI 下的布局和可读性。未执行的项目必须在 `docs/status.md` 中保持待验证状态。
