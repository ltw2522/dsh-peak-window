# 更新记录

版本号与 `package.json` 的 `version`、`client.js` 里的 `PLUGIN_VERSION` 保持一致；
每个版本都能在 [Releases](https://github.com/ltw2522/dsh-peak-window/releases) 上找到对应产物。

## 1.3.1 — 2026-11-23

修 1.3.0 的两个致命缺陷。**1.3.0 装上后插件在界面上完全不出现**，看到 1.3.0 请直接升到 1.3.1。

- **`exports` 补上 `"./package.json"`**
  宿主的 `dsh-client-modules` 用 `createRequire().resolve('<包名>/package.json')` 读清单，`exports` 里没有这一条时 Node 抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`，整个包一行 client 记录都进不了模块表。
  （改名前的非 scoped 名走的是 `loader.internal.resolveSync` 分支，绕过了这个要求；换成 scoped 名后才暴露。）
- **模块注册 id 改为 `@ltw2522/dsh-peak-window`**
  `client.js` 里原先写死 `id: 'dsh-peak-window'`，与条目名不一致。宿主按条目名取模块，取不到时**不报错**，只是 `apply()` 永不执行 —— 设置页区块、输入框探针、浮层三处 UI 同时消失。
- **测试加焊点**：`test-guard.mjs` 断言「模块 id 必须等于 `package.json` 的 `name`」，以后改名漏改直接测试失败。
- 版本号同步：`package.json` 与 `client.js` 的 `PLUGIN_VERSION` 都是 `1.3.1`。

## 1.3.0 — 2026-11-21

- 包名迁移到 `@ltw2522/dsh-peak-window`（旧名 `dsh-peak-window` 同步标记 deprecated）。
- ⚠️ 该版本带上述两个缺陷，**客户端不会加载**，仅作历史记录保留。

## 1.2.6 — 2026-11-18

- 修「文案有两份」的问题：设置页与卡片的文案其实读 `client.js` 内嵌的 `ZH`/`EN`，`locale/*.json` 只管插件列表标题 —— 1.2.5 只改了 JSON，导致逻辑生效但界面像没更新。本版同步两处，并在 `test-guard.mjs` 加断言。
- 「本次不再提醒」语义确认：点后整段谷时静音，直到进入峰时前，重复提醒、再次发送、会话转入运行都不再弹卡。

## 1.2.5 — 2026-11-18

- 新增「本次不再提醒」：点后整段谷时静音到进入峰时为止，由 `isMuted()` 统一否决 `gateAt()` / `remindWhileRunning()` / `tick()` 三处。
