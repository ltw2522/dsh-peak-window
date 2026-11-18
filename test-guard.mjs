/**
 * 峰时守卫的时间判定自测：纯逻辑校验，不启动浏览器。
 * 用法：node test-guard.mjs
 */
import fs from 'node:fs';
import assert from 'node:assert';

const source = fs.readFileSync(new URL('./client.js', import.meta.url), 'utf8');

// 伪 window：捕获 __ModuleLoader__.load 注册的模块
// localStorage 用 Map 做后端：放假数据要真的写缓存再读回来，空实现测不出缓存逻辑
const memStore = new Map();
const fakeWindow = {
  __ModuleLoader__: { load: (mod) => { fakeWindow.__mod = mod; } },
  localStorage: {
    getItem: (key) => (memStore.has(key) ? memStore.get(key) : null),
    setItem: (key, value) => { memStore.set(key, String(value)); },
    removeItem: (key) => { memStore.delete(key); },
  },
  setInterval, clearInterval, setTimeout, clearTimeout,
};

// 伪 fetch：只认 {year}.json 这一种地址，2027 故意返回 404（模拟"明年还没公布"）
const fetchCalls = [];
const fakeFetch = async (url) => {
  fetchCalls.push(url);
  const matched = /(\d{4})\.json/.exec(url);
  const year = matched ? Number(matched[1]) : 0;
  if (year === 2027) return { ok: false, status: 404 };
  return {
    ok: true,
    status: 200,
    json: async () => ({
      year,
      days: [
        { name: '假数据', date: '2026-12-31', isOffDay: true },   // 周四放假
        { name: '假数据', date: '2026-12-26', isOffDay: false },  // 周六上班（调休）
      ],
    }),
  };
};

// client.js 是脚本（无 import/export），用 Function 注入 window 与 fetch 后执行
new Function('window', 'fetch', source)(fakeWindow, fakeFetch);
assert.ok(fakeWindow.__mod, '模块应已注册');
assert.strictEqual(fakeWindow.__mod.id, 'dsh-peak-window');

// 极简 React 替身：只需要 createElement 与几个 hooks 的占位
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useEffect: () => {},
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useRef: (init) => ({ current: init }),
};

const mod = fakeWindow.__mod.factory((name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected require: ${name}`);
});
assert.strictEqual(typeof mod.apply, 'function');
assert.deepStrictEqual(mod.inject, ['slots', 'locale']);

const dbg = fakeWindow.__dshPeakGuardDebug;
assert.ok(dbg, '自测出口应存在');

const at = (month, day, hour, minute = 0) => new Date(2026, month - 1, day, hour, minute).getTime();
const label = (ms) => new Date(ms).toLocaleString('zh-CN', { hour12: false });

// —— 峰时口径 ——
assert.strictEqual(dbg.isPeak(at(11, 17, 10, 0)), true, '周二 10:00 应为峰时');
assert.strictEqual(dbg.isPeak(at(11, 17, 12, 0)), false, '周二 12:00 整应为谷时');
assert.strictEqual(dbg.isPeak(at(11, 17, 13, 0)), false, '周二 13:00 午休为谷时');
assert.strictEqual(dbg.isPeak(at(11, 17, 14, 0)), true, '周二 14:00 应为峰时');
assert.strictEqual(dbg.isPeak(at(11, 17, 18, 0)), false, '周二 18:00 下班后应为谷时');
assert.strictEqual(dbg.isPeak(at(11, 21, 10, 0)), false, '周六 10:00 应为谷时');
assert.strictEqual(dbg.isPeak(at(10, 1, 10, 0)), false, '国庆 10:00 应为谷时（节假日表）');

// —— 下一个翻转点 ——
const s1 = dbg.nextSwitch(at(11, 17, 10, 0));
assert.strictEqual(label(s1.atMs), '2026/11/17 12:00:00');
assert.strictEqual(s1.entering, false, '峰时之后进入谷时');

const s2 = dbg.nextSwitch(at(11, 17, 13, 0));
assert.strictEqual(label(s2.atMs), '2026/11/17 14:00:00');
assert.strictEqual(s2.entering, true, '午休之后进入峰时');

const s3 = dbg.nextSwitch(at(11, 17, 19, 0));
assert.strictEqual(label(s3.atMs), '2026/11/18 09:00:00');
assert.strictEqual(s3.entering, true);

// 周五晚间 → 下一个峰时应落到周一 09:00
const s4 = dbg.nextSwitch(at(11, 20, 19, 0));
assert.strictEqual(label(s4.atMs), '2026/11/23 09:00:00');
assert.strictEqual(s4.entering, true);

// —— 文案格式 ——
assert.strictEqual(dbg.formatRemain(2 * 3600 * 1000), '2h00m');
assert.strictEqual(dbg.formatRemain(9 * 3600 * 1000 + 49 * 60 * 1000), '9h49m');
assert.strictEqual(dbg.formatRemain(30 * 1000), '0h01m', '不足一分钟按 1 分钟显示');

// —— 门禁判定（默认提前量 2 小时）——
assert.strictEqual(dbg.readState().settings.leadMin, 120);
const g1 = dbg.gateAt(at(11, 17, 10, 0));
assert.strictEqual(g1.kind, 'peak', '峰时应弹确认卡');
assert.strictEqual(dbg.gateAt(at(11, 17, 13, 0)).kind, 'near', '距峰时 1 小时应弹提醒');
assert.strictEqual(dbg.gateAt(at(11, 17, 13, 0)).atMs, s2.atMs);
assert.strictEqual(dbg.gateAt(at(11, 17, 15, 0)).kind, 'peak', '峰时中段同样是确认卡');
assert.strictEqual(dbg.gateAt(at(11, 17, 6, 0)), null, '离峰时 3 小时以上不提醒');
assert.strictEqual(dbg.gateAt(at(11, 17, 7, 0)).kind, 'near', '正好 2 小时（等于提前量）应提醒');
assert.strictEqual(dbg.gateAt(at(11, 21, 10, 0)), null, '周六不提醒');

// —— 拦截语义：只有峰时卡才拦，谷时提醒只告知 ——
assert.strictEqual(dbg.blocks(g1), true, '峰时必须拦下发送');
assert.strictEqual(dbg.blocks(dbg.gateAt(at(11, 17, 13, 0))), false, '谷时提醒不许拦发送');
assert.strictEqual(dbg.blocks(null), false, '没有判定时当然不拦');

// —— 设置钳制：重复间隔不得大于提前量 ——
const clamped = dbg.normalizeSettings({ leadMin: 30, repeatMin: 120 });
assert.strictEqual(clamped.leadMin, 30);
assert.strictEqual(clamped.repeatMin, 30, '重复间隔应被钳到提前量');
// 非法值（0 或非数字）退回默认提前量，而不是钳到 1 分钟
const clamped2 = dbg.normalizeSettings({ leadMin: 0, repeatMin: 0 });
assert.strictEqual(clamped2.leadMin, 120, '0 视为非法，退回默认 2 小时');
assert.strictEqual(clamped2.repeatMin, 15, 'repeatMin 同样退回默认 15 分钟');
assert.strictEqual(dbg.normalizeSettings({ leadMin: 5000 }).leadMin, 1440, '上限钳到 1440 分钟');
assert.strictEqual(dbg.normalizeSettings({ leadMin: 999, repeatMin: 1 }).repeatMin, 1);

// —— 调休补班日：要上班，但计费口径是全天谷价（不是峰时） ——
assert.strictEqual(dbg.isWorkday(at(9, 20, 10, 0)), false, '2026-09-20 是国庆调休补班的周日');
assert.strictEqual(dbg.isPeak(at(9, 20, 10, 0)), false, '调休补班日全天谷价，上午不算峰时');
assert.strictEqual(dbg.isPeak(at(9, 20, 15, 0)), false, '调休补班日下午也不算峰时');
assert.strictEqual(dbg.isWorkday(at(2, 14, 10, 0)), false, '2026-02-14 是春节调休补班的周六');
assert.strictEqual(dbg.isPeak(at(2, 14, 10, 0)), false, '春节调休补班日同样全天谷价');
assert.strictEqual(dbg.isWorkday(at(11, 21, 10, 0)), false, '普通周六仍是休息日');
assert.strictEqual(dbg.isWorkday(at(10, 1, 10, 0)), false, '10-01 是法定节假日');
assert.strictEqual(dbg.isWorkday(at(11, 18, 10, 0)), true, '普通周三仍是工作日（对照）');

// —— 联网更新：拉到数据后立刻生效，并写入本地缓存 ——
const holi = await dbg.refreshHolidays(true);
assert.strictEqual(holi.source, 'network', '成功拉取后来源应为 network');
assert.ok(holi.fetchedAt > 0, '应记录更新时刻');
assert.ok(fetchCalls.some((url) => url.includes('2026.json')), '应请求今年');
assert.ok(fetchCalls.some((url) => url.includes('2027.json')), '应顺带请求明年');
assert.strictEqual(dbg.isPeak(at(12, 31, 10, 0)), false, '网络数据里的假日应生效（周四放假）');
assert.strictEqual(dbg.isPeak(at(12, 26, 10, 0)), false, '网络数据里的调休补班日也是全天谷价（周六补班）');
assert.ok(memStore.has('dsh-peak-window:holidays:v1'), '拉到的数据应写入 localStorage 缓存');

// —— 缓存回读：新起一个模块实例，只用缓存也要能认出放假 ——
// 只调 factory 不调 apply：apply 会注入样式（需要 document），而缓存回读发生在 factory 内部
new Function('window', 'fetch', source)(fakeWindow, async () => ({ ok: false, status: 500 }));
fakeWindow.__mod.factory((name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected require: ${name}`);
});
const dbg2 = fakeWindow.__dshPeakGuardDebug;
assert.strictEqual(dbg2.holidayInfo().source, 'cache', '重启后应从缓存恢复');
assert.strictEqual(dbg2.isPeak(at(12, 31, 10, 0)), false, '缓存里的假日应继续生效');
// 拉取失败时要保留旧数据、只记错误，不能把表清空
await dbg2.refreshHolidays(true);
assert.ok(dbg2.holidayInfo().error, '失败应记录原因');
assert.strictEqual(dbg2.isPeak(at(12, 31, 10, 0)), false, '失败后仍用旧数据判定');

// —— 改名迁移：旧包名 dsh-peak-guard 时期的设置键也要读得到 ——
// 打包改名后老用户的设置躺在旧键里，读不到就等于把他们打回默认值，所以这里钉住迁移行为。
const legacyStore = new Map([
  ['dsh-peak-guard:settings:v1', JSON.stringify({ leadMin: 540, repeatMin: 60, guardEnter: false })],
]);
const legacyWindow = {
  __ModuleLoader__: { load: (m) => { legacyWindow.__mod = m; } },
  localStorage: {
    getItem: (k) => (legacyStore.has(k) ? legacyStore.get(k) : null),
    setItem: (k, v) => { legacyStore.set(k, String(v)); },
    removeItem: (k) => { legacyStore.delete(k); },
  },
  setInterval, clearInterval, setTimeout, clearTimeout,
};
new Function('window', 'fetch', source)(legacyWindow, async () => ({ ok: false, status: 500 }));
legacyWindow.__mod.factory((name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected require: ${name}`);
});
const legacySettings = legacyWindow.__dshPeakGuardDebug.readState().settings;
assert.strictEqual(legacySettings.leadMin, 540, '旧键里的提前量 9 小时应被继承');
assert.strictEqual(legacySettings.repeatMin, 60, '旧键里的重复间隔应被继承');
assert.strictEqual(legacySettings.guardEnter, false, '旧键里的回车拦截开关应被继承');
assert.ok(legacyStore.has('dsh-peak-window:settings:v1'), '读到旧键时应顺手迁移到新键');

// 按钮名称匹配：宿主文案可能带括号、空格、大小写差异，必须宽松认
// （历史 bug：曾用 aria-busy 的 hasAttribute 判断，React 会渲染 "false"，导致永远认不到按钮）
assert.strictEqual(dbg.looksLikeSend('发送消息'), true, '精确文案应识别');
assert.strictEqual(dbg.looksLikeSend('发送消息（Enter）'), true, '带括号快捷键提示应识别');
assert.strictEqual(dbg.looksLikeSend('Send message'), true, '英文文案应识别');
assert.strictEqual(dbg.looksLikeSend(' 发 送 '), true, '带空白应识别');
assert.strictEqual(dbg.looksLikeSend('停止生成'), false, '停止键不能被当成发送键');
assert.strictEqual(dbg.looksLikeSend('选择模型，当前 DeepSeek-V4.1-Flash'), false, '模型选择键不能被误认');
assert.strictEqual(dbg.looksLikeSend(''), false, '空名称不猜');

/* —— 暂停到谷时自动发送 —— */
let sent = [];
let draft = '';
dbg.__test.setState({
  dialog: { kind: 'peak', atMs: at(11, 18, 12, 0), view: 'main', source: 'test' },
  composer: {
    sessionId: 's1',
    draftEmpty: false,
    draft: '帮我算一下这个电路',
    phase: 'plain',
    running: false,
    submit: (mode) => { sent.push(mode); },
    actions: { setDraft: (text) => { draft = text; } },
  },
  defer: null,
});
dbg.deferSend();
assert.ok(dbg.readState().defer, '暂停后应存下待发条目');
assert.strictEqual(dbg.readState().defer.text, '帮我算一下这个电路', '应原样存下草稿');
assert.strictEqual(dbg.readState().defer.atMs, at(11, 18, 12, 0), '到点应是转谷时的时刻');
assert.strictEqual(sent.length, 0, '暂停本身不能发送');

// 未到点：什么都不做
dbg.trySendDeferred(at(11, 18, 11, 59));
assert.strictEqual(sent.length, 0, '未到点不许发送');
assert.ok(dbg.readState().defer, '未到点应继续保留待发条目');

// 到点且会话匹配：写回草稿后提交
dbg.trySendDeferred(at(11, 18, 12, 0));
assert.strictEqual(draft, '帮我算一下这个电路', '应把存下的草稿写回输入框');
assert.strictEqual(dbg.readState().defer, null, '发出后应清掉待发条目');
await new Promise((resolve) => setTimeout(resolve, 250));
assert.deepStrictEqual(sent, ['queue'], '应通过宿主的 submit 排队发送一次');

// 会话不匹配：不发，只提示
sent = [];
dbg.__test.setState({
  composer: { sessionId: 's2', draftEmpty: true, draft: '', phase: 'plain', running: false, submit: (m) => sent.push(m), actions: { setDraft: () => {} } },
  defer: { sessionId: 's1', text: '别的会话的内容', atMs: at(11, 18, 12, 0), savedAt: 0 },
  deferNoticeAt: 0,
});
dbg.trySendDeferred(at(11, 18, 13, 0));
assert.strictEqual(sent.length, 0, '会话不匹配时不许往当前会话乱发');
assert.strictEqual(dbg.readState().dialog.kind, 'deferred-elsewhere', '应提示切回原会话');

// 取消暂停
dbg.cancelDefer();
assert.strictEqual(dbg.readState().defer, null, '取消后应清空待发条目');

// 时钟格式化
assert.strictEqual(dbg.formatClock(at(11, 18, 14, 5)), '14:05', '时间格式应为 HH:MM');

console.log('全部断言通过：峰谷判定 / 翻转点 / 文案 / 门禁 / 设置钳制 / 调休 / 联网更新 / 改名迁移 / 按钮匹配 / 暂停待发');
