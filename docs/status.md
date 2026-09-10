# 当前状态

这是 Widget 的公开状态摘要。项目定位是个人优先的 Windows vibe coding 练手；下列内容只描述当前迁入的代码快照和已记录证据，不构成跨机器兼容或维护承诺。

## 当前能力

- Electron manager、主屏 WorkerW 组件窗口、托盘生命周期和统一退出清理。
- 系统监测（CPU/内存/GPU 与物理网络速率）、时钟/日期、纯文本便签、每日待办和可选 Codex 额度组件。
- 每日待办当前支持本地当天任务的新增、勾选、进度显示和持久化；桌面默认可直接交互，标题条可锁定/恢复交互，锁定后可从托盘解锁；跨日自动清空，不保存历史或提醒。
- 组件目录分页、单实例、紧凑实例列表分页、布局编辑、保存/取消、主题/透明度/锁定设置、配置持久化和 Renderer 恢复。
- Windows 当前用户自启动代码仅对正式 portable `Widget.exe` 开放；开发版、M0 探针和非 portable 路径不会改真实启动项。
- portable 文件夹打包和独立 M0 WorkerW 研究入口。

## 证据分层

### 迁移前历史证据

源项目交接记录报告过 Node 回归和多项 Electron smoke 通过，最后记录的 Node 回归为 95/95。这些是迁移前证据，本节不把它们当作 Widgets 本轮测试结果。

### 本轮迁移自动化

迁移基线来自源快照 `77ddd230256686711d2a52ccb415ecb1ed9bc3c2`；`src/`、`test/`、`tools/` 和必要元数据未带入源 `.git`、`node_modules`、`dist` 或真实运行数据。目标仓库的独立安装、文档整理和脚本修正均已提交。

- 工具链：Node.js `v24.15.0`、npm `11.12.1`、Electron `43.2.0`、koffi `2.14.1`。
- `npm.cmd ci --registry=https://registry.npmjs.org/`：通过，安装 14 个包并报告 0 vulnerabilities；根 `postinstall` 自动补齐 Electron runtime。
- 迁移完成时的 Node 基线为 95/95；加入每日待办后的 `npm.cmd test`：100/100 通过。
- `smoke:manager`、`smoke:manager-ui`、`smoke:single-instance`、`smoke:tray`、`smoke:note`、`smoke:todo`、`smoke:codex-quota`、`smoke:renderer-recovery`、`smoke:autostart`、`smoke:performance`、`smoke:portable`：均通过。待办 smoke 实际操作 Electron 渲染器的新增/勾选并检查配置落盘；自启动 smoke 只验证 packaged `Widget.exe` 的静默启动，没有登记真实启动项。
- 管理器分页改造本轮：`npm.cmd test` 为 103/103；`npm.cmd run smoke:manager-ui` 通过，覆盖 1120×800 默认页（目录 3 张/页、实例 5 行）、800×640 紧凑页（目录 2 张/页、实例 3 行）、目录首末页、最后一页卡片宽度、页面切换、编辑面板替换和页面高度无滚动条。实际 Electron 页面抓图位于仓库外的 `manager-1120x800.png` 与 `manager-800x640.png`，不是概念图。
- 每日待办桌面交互改造：`npm.cmd test` 为 105/105；新增 WorkerW 输入模式的锁定/解锁回归、原生输入样式刷新及失败状态回归，并保留托盘菜单状态回归。运行时锁定不会写入 `locked` 或待办配置；待办保存 smoke 仍覆盖渲染器新增/勾选与配置落盘。修复后的 portable 副本已完成启动生命周期 smoke。
- 性能 smoke 本机基线：manager 335.4 MB、单组件 416.9 MB、双组件 489.3 MB、Renderer recovery 314.9 MB 峰值工作集；仅作当前机器观察值。
- `npm.cmd run package:portable`：通过；`Widget.exe`、Electron 声明、项目 `LICENSE` 和 koffi `LICENSE.txt` 均在成品中。
- M0 launcher 构建通过；带临时 profile、`--disable-gpu` 的 `--auto-attach` 探针退出码为 0。
- `npm.cmd run smoke:desktop`：未通过，当前自动化会话报告 `WorkerW not found`；manager 能正常启动/退出，但无法在此会话完成真实 WorkerW 桌面层验证。

### 2026-09-10 每日待办 WorkerW 输入修复尝试

- 调整输入设置顺序：先设置 Electron 鼠标忽略状态，再刷新并校验 WorkerW 原生样式；修正原生写入失败判断、交互态禁止激活标志检查和 `WindowFromPoint` 的 POINT 按值绑定。
- 本次 `npm.cmd test`：108/108 通过；`npm.cmd run smoke:todo` 通过；本机原生适配器加载成功。新增回归使用模拟 Win32 返回值覆盖写入失败和禁止激活标志残留，不能作为可见桌面输入证据。
- 保持待办附着 WorkerW。真实鼠标点击、输入焦点和桌面层遮挡仍待重启后的实机验证，尚不能宣称用户报告的问题已解决。

### 2026-09-10 WorkerW 输入链路修复

- 上一版样式修复后，用户仍确认无法交互。本次真实桌面只读检查发现：交互态子窗口未开启点击穿透，但父 WorkerW 带禁用标志，露出的待办区域采样命中 `SHELLDLL_DefView`。
- 保留 WorkerW 附着；新增限定待办区域的鼠标转发和父窗口启用状态管理，锁定/隐藏/布局编辑时停止转发新点击，普通应用遮挡时不抢占输入。锁定、脱离和退出释放相应资源。
- Koffi 从 2.14.1 升级并固定为 2.15.2。旧版本在最小钩子测试中出现退出崩溃；新版包含官方记录的 Node 24.14+ 回调退出修复，本次实机输入测试退出码为 0。
- 本次 `npm.cmd test`：115/115 通过。`npm.cmd run smoke:todo-desktop -- --minimize-obstruction` 在可见桌面会话中通过：原生焦点、系统键盘输入、新增、勾选、锁定、解锁、父窗口状态恢复。使用临时 profile 与内存待办，结果不是用户真实待办数据验证，也未覆盖中文输入法。
- 升级依赖后 `npm.cmd run smoke:todo` 与 `npm.cmd run smoke:portable` 均通过；完整重建 `dist/Widget-portable`，并核对三个输入相关源码、package.json 和 Windows x64 Koffi 原生模块与构建来源的 SHA-256 一致。
- 更新后的真实用户组件仍需用户重启并确认；不以隔离 fixture 的通过替代这一项。

### 本轮人工验证

尚未将下列项目写成自动化 PASS：

- 普通可见桌面中的 `Win+D`、锁定态点击穿透、编辑拖动，以及完成/取消后的重新附着。
- 便签中文输入法、粘贴、选择、滚动、保存失败后的重试和删除确认。
- 每日待办在普通可见桌面上的锁定态点击穿透、托盘解锁、新增/勾选保存、跨午夜清空和长文本边界。
- 本轮管理器已完成自动抓图和 DOM 尺寸检查；由于当前会话 Windows CUA 未返回可接管的原生窗口，尚未完成通过鼠标键盘对可见窗口进行的人工分页、缩放拖拽和编辑操作抽查。
- 真实 Codex 登录读取，而不是无服务时的安全不可用降级。
- 可见托盘菜单、首次关闭行为、Explorer 重启后的托盘恢复与最终退出。
- 成品设置页启用/关闭自启动、实际启动项路径核对、注销登录静默恢复和移动 portable 后路径修复。
- 165% DPI 下管理器布局、焦点、滚动和深浅色可读性。

验证完成后只更新证据分层，不删除仍未完成的人工事项。
