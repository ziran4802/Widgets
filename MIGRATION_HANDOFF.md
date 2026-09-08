# Widget → Widgets 迁移交接

确认日期：2026-09-08。用户已确认本方案，接手会话应直接执行迁移，不重复规划。

## 目标与边界

- 源目录：`G:\workspace\Codex\Widget`；目标：`G:\workspace\Codex\Widgets`。
- 定位：用 vibe coding 持续折腾的 Windows 桌面小组件，个人练手和自用优先，按个人需求迭代。准备公开源码，不包装为成熟商业产品。
- 按清单复制当前代码快照，在 Widgets 建立独立 Git 历史；保留目标现有 Git 历史及文件，不复制源 `.git`，不重置目标仓库。
- 源目录保持只读，不删除、不移动、不改动。MyUI 不在本次迁移范围内。
- 此次不新增功能、不重构架构、不升级依赖、不加入安装器或复杂发布流程。修复迁移造成的问题属于范围内。
- 仓库称 Widgets；应用仍叫 Widget，保留 `Widget.exe`、`WIDGET_*`、现有包名和配置身份，避免影响配置、单实例及自启动。
- 本次授权为本地迁移、整理、验证及 Git commit；不包含创建远程仓库、推送、改变可见性或发布 Release。
- 每个完成且可验证的改动必须创建对应 Git commit。保留用户已有改动，不盲目使用 `git add .`。

## 已检查的基线（执行前重新核验）

- 源 HEAD：`77ddd230256686711d2a52ccb415ecb1ed9bc3c2`，标题 `docs: rewrite README`；检查时工作区干净。
- 源 origin：`https://github.com/ziran4802/widget.git`；未核验远程公开状态，不直接继承为新仓库远程。
- 规划开始时目标已初始化 Git，无提交、无远程，仅有用户提供的 AGENTS.md。本交接提交后目标不再是空历史。
- 源跟踪文件：src 37 个，test 18 个，tools 16 个，docs 1 个，根目录 17 个。数量仅供核对，不替代执行时清单。
- 依赖：Electron 43.2.0、koffi 2.14.1；本地 Electron 包声明 Node >=22.12.0，实际执行前核验工具链并记录版本。
- 历史文档记录 Node 测试 95/95 通过；本规划会话未运行测试，不可当作新目录验收结果。
- 旧 next-release-plan.md 仍描述从阶段 1 开始，但 HANDOFF.md 已记录各阶段实施，不能照旧计划重做功能。

## 文件清单

### 复制并保留

- `src/` 全部源码，含管理器、组件、WorkerW 和 M0 探针。
- `test/` 全部测试。
- `tools/` 的跟踪源码与脚本，含 `.js`、`.ps1`、`.cs`；不复制生成的 exe。
- `package.json`、`package-lock.json`：复制后按下节调整。
- `LICENSE`：保留现有 MIT 文本与版权署名。
- `.gitignore`：复制后补充。
- `docs/design/manager-concept-v1.png`：保留并标明 AI 概念图、示例数据，不能充当实机截图。

使用源 Git 跟踪文件清单筛选，不整体递归复制项目目录。执行前检查任何嵌套 AGENTS.md。

### 重写或新建

- `README.md`：重写为公开入口，说明定位、当前功能、Windows 11 x64/主屏范围、环境要求、安装运行、打包、测试、限制、许可证。
- `AGENTS.md`：以目标现有文件为基础，保留逐次 commit 规则，补充新仓库开发入口与简明约束；不覆盖为旧源版本。
- `docs/development.md`：从旧文档提炼当前架构入口、命令、M0 探针用途、配置和诊断位置、必要验证方式。
- `docs/status.md`：当前能力、已知限制、待人工验证项；区分历史证据、本轮自动化与本轮人工验证。

### 留在旧目录，不原样复制

`HANDOFF.md`、`next-release-plan.md`、`design-plan.md`、`host-probe-plan.md`、`m0-results.md`、`prd.md`、`technical-design.md`、`visual-design.md`、`task_plan.md`、`findings.md`、`progress.md`。

从这些文件提炼有效内容即可，不保留失效任务指令和个人路径到公开文档。不得把旧范围重新当作执行要求。

### 不进入新仓库

- 源 `.git/`、`node_modules/`、`dist/`、`diagnostics/`、`.m0-user-data/`、生成的 launcher exe。
- 真实配置、便签、登录凭据、token、环境文件、日志、临时 smoke profile 和构建产物。
- 当前交接文件含个人路径，迁移完成后从目标跟踪文件中移除；其初始提交仍包含该文件。对外发布候选检查需覆盖完整目标历史：若用户不希望公开本机路径，另行准备经授权的干净发布快照，不擅自重写此仓库历史。

## 已确认的必要修改

1. README 移除 MyUI 与个人工作区背景，使用项目相对路径。说明自用优先、实验性质和实际限制，不承诺固定维护周期或未经验证的兼容性。
2. package.json 修正仍写着 M0 probe 的 description，补充 `license` 与适当的运行环境信息；保留 `private: true`、现有 name 和依赖版本。仓库 URL 未确定前不编造 repository/homepage/bugs 地址。
3. package-lock.json 当前 resolved 使用 registry.npmmirror.com；建议统一为官方 npm 公共源，保持锁定版本、依赖树及 integrity，执行干净安装验证。若无法验证下载来源，记录实际阻塞，不靠升级依赖绕过。
4. .gitignore 整体忽略 diagnostics、本机配置、环境文件和临时产物；规则尽量精确，不误忽略测试夹具、锁文件或源码。
5. tools/portable-package.ps1 将项目 LICENSE 带入成品，核对 Electron/koffi 附带许可证与声明保持完整，不以项目许可证覆盖依赖许可证。
6. tools/m0-launcher/build.ps1 的 `C:\Windows` 硬编码改为基于实际系统目录解析，保留编译器不存在时的明确错误。
7. Codex 额度为可选组件。当前代码调用本机 app-server；无可用服务时降级。不要因使用本地进程就宣称全链路离线，也不要复制登录信息。描述以实际代码与验证为准。
8. 保留现有 app 身份：配置目前通过 Electron `app.getPath('userData')/widget-config.json` 读取，自启动识别 Widget.exe。不要全局把 Widget 替换成 Widgets。

## 执行顺序与提交

1. 阅读目标 AGENTS.md、本文件；核验两目录 Git 状态、源 HEAD、目标已有文件和工具链。源若前进则检查增量，仍按同一迁移范围纳入当前快照并记录实际来源；遇到不明用户改动不要覆盖。
2. 按白名单复制当前源码、测试、工具及必要文件，保留目标交接和规则。检查数量与差异，创建迁移基线 commit，提交说明记录实际源 SHA。
3. 完成文档、元数据、忽略规则与脚本的必要修改；按可验证工作包创建 commit，不扩大为产品改版。
4. 在新目录独立安装依赖、运行测试、生成新 portable，解决迁移引入的问题并提交。不得复制旧 node_modules/dist 冒充构建成功。
5. 核对配置路径、原配置与便签兼容性。自动化使用隔离 profile 和临时配置，禁止覆盖真实便签。涉及真实数据先备份，不能把数据加入 Git。
6. 如需切换用户实际运行版本，先记录旧成品路径及启动项；通过正常退出关闭旧实例后再启动新成品，避免单实例把新启动转给旧进程造成误判。不要按宽泛进程名强杀应用。
7. 自启动若仍指向旧 portable，使用已有路径修复入口；自动测试不得注册真实用户启动项。需要用户实际登录或可见 UI 操作时先准备成品和明确步骤，列为待人工验证。
8. 完成仓库检查，更新 docs/status.md，以实际验证证据收尾。移除本临时交接文件并创建 commit；交付源 SHA、新提交、测试结果、构建路径、剩余人工事项。公开操作留待后续授权。

任何递归删除都必须先确认最终绝对路径位于目标项目预期产物目录；不删除源文件、不重置目标 .git。旧项目可用于回滚对照，目标改动可按对应 commit 回退；不自动修改真实用户配置与启动项作回滚。

## 验证与验收

在 Widgets 根目录执行，记录实际命令、结果、工具版本与环境限制：

```powershell
npm.cmd ci
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
npm.cmd run package:portable
npm.cmd run smoke:portable
```

运行 smoke 前阅读脚本，确认临时配置、profile 与清理范围。M0 probe 入口也要检查，在适合的交互桌面验证。桌面 smoke 为 `npm.cmd run smoke:desktop`，不能替代下列人工项：Win+D、锁定点击穿透、编辑拖动、完成/取消后重新附着、真实 Codex 登录读取、登录自启动、Explorer 重启及锁屏/睡眠恢复。不能执行的项目写明原因，不将历史通过写为本轮通过。

验收条件：

- 新目录可独立安装、启动和打包；不依赖源绝对路径或旧构建产物。
- 原有测试通过；必要 smoke 有实际结果，失败已解决或明确区分环境阻塞。
- 应用名字、配置身份与自启动识别保持兼容，真实数据未入库。
- 公开文档与实现一致，命令和链接可用，概念图标注准确。
- 检查最终跟踪文件及目标历史中的凭据、本机路径、日志、便签和产物；忽略规则不等于历史清理。
- 各完成改动已有 Git commit，工作区状态可解释；源项目保持原状。

## 本交接的状态

方案已获用户确认。本会话只生成交接并提交，没有执行迁移、安装、测试或 GitHub 发布。接手会话按本文件继续实施。
