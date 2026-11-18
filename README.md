# 峰时守卫 · dsh-peak-window

DSH 插件：发送消息前自动判定峰时 / 谷时，替你挡一次不划算的提问。

- **峰时**点「发送消息」→ 先弹一张深色确认卡（`继续` 红色放行、`返回` 浅灰退回去，草稿原样保留）；
- **谷时**距峰时不足提前量时 → 点发送或对话开始运行时弹一次提醒（`知道了`），可设置重复提醒间隔；
- **放假安排自动更新**：内置表兜底 + 本地缓存 + 联网按年同步，跨年不用回来改代码；调休补班日按全天谷价。

所有设置都在 **设置 → 峰时守卫** 里（也可从卡片的「设置」按钮进），改完即时生效。

## 安装

已发布到 npm 后，一条命令即可：

```
plugin_manager action=install_bundle target=dsh-peak-window
```

本地开发时指向目录也行：

```
plugin_manager action=install_bundle target=<本仓库绝对路径>
```

装完刷新页面即可生效；改 `client.js` 后需重启或重新安装才能加载新模块。

## 目录

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半，空的 `apply()`；插件条目由 `cordis.patch.yml` 插入 |
| `client.js` | 浏览器半：输入卡探针 + 整帧浮层确认卡 + 发送按钮拦截 |
| `cordis.patch.yml` | Loader 补丁，插入 `peak-guard` 一行 |
| `locale/*.json` | 插件列表里的标题、描述与详情文件路径 |
| `docs/DETAIL.md` | 插件详情页正文 |
| `icon.svg` | 图标 |
| `test-guard.mjs` | 时间判定自测（峰谷口径、翻转点、文案、门禁、设置钳制） |
| `test-view.mjs` | 界面结构自测（峰时卡 / 谷时提醒 / 设置面板 / 空态 / 样式注入） |

## 安装

```
plugin_manager action=install_bundle target=D:\dsh_workspace\dsh-peak-window
```

装完刷新页面即可生效；改 `client.js` 后需重启或重新安装才能加载新模块。

## 分享给别人

插件没有运行时依赖，所有文件都在包里，三种给法由简到繁：

**① 拷文件夹（最稳，已在同机验证）**

把整个 `dsh-peak-window` 目录拷给对方（U 盘、网盘、微信都行），对方在自己机器上执行：

```
plugin_manager action=install_bundle target=<拷贝后的绝对路径，如 D:\tools\dsh-peak-window>
```

然后重启 DSH。装完 `设置 → 峰时守卫` 会出现一页设置。

**② 单个 tgz（一个文件，最省事）**

本目录下的 `dsh-peak-window-1.1.5.tgz` 就是打包产物（`pnpm pack` 重新生成）。对方：

```
plugin_manager action=install_bundle target=<tgz 的绝对路径>
```

若对方环境不认 tgz，退回方案 ①。

**③ 发到 npm / 插件市场（公开分享）**

先把 `package.json` 里的 `"private": true` 删掉，再 `npm publish`；对方按包名安装：

```
plugin_manager action=install_bundle target=dsh-peak-window
```

要进插件市场还需要市场索引收录，这一步取决于索引维护方。

**对方必须知道的几点**

- 装完要**重启 DSH**：客户端的代码是宿主启动时打包的，刷新页面不算数；
- 设置存在**各自浏览器**的 localStorage（键 `dsh-peak-window:settings:v1`），互不干扰，换浏览器会回到默认值；
- 峰谷口径固定（工作日 09:00–12:00、14:00–18:00）；放假安排由插件自动联网更新，不用每年改代码（调休补班日按全天谷价）；
- 唯一的外部请求是向公开 CDN 取每年一份放假 JSON（只发 GET、不带本地数据），设置里可一键关掉；
- 插件不读凭据，只在本机判断时间与拦一次点击。

## 放假安排自动更新

内置表只是兜底，插件自己会更新，**跨年不用回来改代码**：

| 层级 | 来源 | 何时使用 |
| --- | --- | --- |
| ① | 刚拉到的网络数据 | 打开 DSH 时、点「立即更新」时 |
| ② | 本机缓存 `dsh-peak-window:holidays:v1` | 断网、CDN 不可达时 |
| ③ | 内置表（2026 年 + 6 个调休补班日） | 从没联网成功过 |

- 数据源 NateScarlet/holiday-cn（MIT），每年国务院公布后由该仓库更新 `{year}.json`；插件取今年 + 明年。
- 两个 CDN：`fastly.jsdelivr.net` 优先，失败换 `gcore.jsdelivr.net`，单次 6 秒超时。
- 12 小时有效期，启动时与每 30 分钟检查一次是否过期；失败不清空旧数据，只在设置里提示一行。
- 数据里的 `isOffDay=false` 是**调休补班日**：要上班，但计费口径按**全天谷价**，不算峰时。
- 关掉设置里的「自动联网更新」后，插件完全不发网络请求。

## 暂停到谷时

峰时确认卡上多了一颗「暂停，谷时自动恢复执行」：把当前输入存下来，等转谷时自动发出。

- 存档键 `dsh-peak-window:pending:v1`，刷新/重启都还在；
- 发送前三重检查：同一会话、没有回合在跑、输入卡空闲，否则原地等，不丢内容；
- 切到别的会话会提示一次，切回去自动发；
- 设置里有「已暂停待发送 … 取消暂停」，随时取消（只清存档，草稿不动）。

## 自测

```
node test-guard.mjs   # 纯时间逻辑，不碰 DOM
node test-view.mjs    # 用极简 React 替身渲染组件树，断言文案与按钮配色
```

`test-view.mjs` 会把 `client.js` 放进伪 `window` / `document` 里执行，因此改动组件结构后要同步更新断言。

想看卡片长什么样而不用等真峰时，在浏览器控制台执行：

```js
__dshPeakGuardDebug.preview('peak')   // 峰时确认卡
__dshPeakGuardDebug.preview('near')   // 谷时临近峰时提醒
__dshPeakGuardDebug.readState()       // 当前设置与卡片状态
```

## 实现要点

宿主没有"提交前确认"的扩展点，所以：

1. `conversation.input.right` 注册一个空渲染探针，把 `useInput` / `useSession` / `inputActions` 的快照登记到模块级 store；
2. `shell.overlay` 注册确认卡，并在 `document` 捕获阶段监听 `click` 与 `keydown`；
3. 命中输入卡内的发送按钮且此刻该拦 → `preventDefault + stopPropagation`，React 的 `onClick` 不执行，发送被冻结在"点下去之前"；
4. 「继续」把同一个按钮重放一次 `click()`（放行标记跳过自己的监听），投递模式、埋点、焦点都交回宿主；「返回」只关卡片，草稿天然保留；「暂停」把草稿存进 localStorage，到转谷时写回输入框再走 `inputActions.submit('queue')`；
5. `settings.section` 注册一页「峰时守卫」，与卡片里的设置面板共用 `SettingsPanel`（`variant='page'` 切换成宿主主题配色），因此不弹卡也能改设置。

## 链接

- 源码仓库：<https://github.com/ltw2522/dsh-peak-window>
- npm 包：<https://www.npmjs.com/package/dsh-peak-window>
- 问题反馈：<https://github.com/ltw2522/dsh-peak-window/issues>

## 许可证

MIT
