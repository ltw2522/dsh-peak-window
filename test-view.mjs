/**
 * 峰时守卫的界面结构自测：用极简 React 替身把卡片渲染成对象树，
 * 检查文案、按钮配色类名与设置项，不需要真实浏览器。
 * 用法：node test-view.mjs
 */
import fs from 'node:fs';
import assert from 'node:assert';

const source = fs.readFileSync(new URL('./client.js', import.meta.url), 'utf8');

/* —— 伪 document：样式注入与全局监听都落在这些空实现上 —— */
const head = { children: [], appendChild(node) { this.children.push(node); } };
const fakeDocument = {
  head,
  createElement: (tag) => ({
    tag,
    attrs: {},
    textContent: '',
    setAttribute(name, value) { this.attrs[name] = value; },
    remove() {},
  }),
  addEventListener: () => {},
  removeEventListener: () => {},
};
globalThis.document = fakeDocument;

const fakeWindow = {
  __ModuleLoader__: { load: (mod) => { fakeWindow.__mod = mod; } },
  localStorage: { getItem: () => null, setItem: () => {} },
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout,
  clearTimeout,
};
new Function('window', 'document', source)(fakeWindow, fakeDocument);

/* —— 极简 React：createElement 只记录树；hooks 全部是占位 —— */
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
  useEffect: () => {},
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useRef: (init) => ({ current: init }),
};

const mod = fakeWindow.__mod.factory((name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected require: ${name}`);
});
assert.strictEqual(typeof mod.apply, 'function');

const dbg = fakeWindow.__dshPeakGuardDebug;
// 组件的 t 由槽位注入；这里直接给中文文案（与 locale/zh.json 一致）
const ZH = JSON.parse(fs.readFileSync(new URL('./locale/zh.json', import.meta.url), 'utf8'));
const t = (key, vars) => {
  let text = ZH[key] || key;
  Object.keys(vars || {}).forEach((name) => { text = text.replace(`{${name}}`, vars[name]); });
  return text;
};

/* —— 渲染并把对象树压平成可断言的文本/按钮列表 —— */
function collect(node, out = { texts: [], buttons: [], classNames: [] }) {
  if (node === null || node === undefined || node === false) return out;
  if (Array.isArray(node)) { node.forEach((child) => collect(child, out)); return out; }
  if (typeof node === 'string' || typeof node === 'number') { out.texts.push(String(node)); return out; }
  if (typeof node.type === 'function') return collect(node.type(node.props), out);   // 子组件就地展开
  const className = node.props.className || '';
  if (className) out.classNames.push(className);
  if (node.type === 'button') {
    out.buttons.push({
      className,
      testId: node.props['data-testid'] || '',
      text: collect({ type: 'fragment', props: {}, children: node.children }).texts.join(''),
    });
  }
  collect(node.children, out);
  return out;
}

const render = (props) => collect(mod.__renderOverride ? null : dbg.components.GuardOverlay(props));

/* —— 场景一：峰时确认卡 —— */
dbg.dismissDialog();
dbg.openDialog({ kind: 'peak', atMs: Date.now() + 2 * 3600 * 1000 }, 'test');
let view = render({ t });
let text = view.texts.join(' ');
assert.ok(text.includes('当前为峰时'), `峰时卡标题缺失：${text}`);
assert.ok(/2h00m 后转谷时/.test(text), `峰时卡应显示剩余时长：${text}`);
assert.ok(view.buttons.some((b) => b.text === '继续' && b.className.includes('dpg-btn-danger')), '继续按钮应为红色');
assert.ok(view.buttons.some((b) => b.text === '返回' && b.className.includes('dpg-btn-neutral')), '返回按钮应为浅灰');
// 暂停：文案与需求逐字一致，且独立占一行（dpg-actions-pause），不与返回/继续挤在一起
assert.ok(view.buttons.some((b) => b.text === '暂停，谷时自动恢复执行' && b.testId === 'peak-guard-pause'),
  '峰时卡应有「暂停，谷时自动恢复执行」按钮');

/* —— 场景二：谷时临近峰时提醒（只有一个按钮） —— */
dbg.dismissDialog();
dbg.openDialog({ kind: 'near', atMs: Date.now() + 45 * 60 * 1000 }, 'test');
view = render({ t });
text = view.texts.join(' ');
assert.ok(text.includes('距离峰时仅剩'), `提醒文案缺失：${text}`);
assert.ok(text.includes('0h45m'), `提醒应显示剩余时长：${text}`);
assert.strictEqual(view.buttons.filter((b) => b.text === '知道了').length, 1, '应只有一个「知道了」');
assert.ok(view.buttons.some((b) => b.text === '知道了' && b.className.includes('dpg-btn-neutral')), '知道了应为浅灰');
assert.ok(!view.buttons.some((b) => b.text === '继续'), '谷时提醒不应出现继续按钮');

/* —— 场景三：设置面板 —— */
dbg.toggleSettingsView();
view = render({ t });
text = view.texts.join(' ');
assert.ok(text.includes('峰时守卫设置'), '设置面板标题缺失');
assert.ok(text.includes('谷时提醒提前量'), '缺少提前量设置项');
assert.ok(text.includes('重复间隔'), '缺少重复间隔设置项');
assert.ok(text.includes('回车发送同样拦截'), '缺少回车拦截开关');
assert.ok(text.includes('工作日 09:00–12:00'), '缺少峰时口径说明');
assert.ok(view.buttons.some((b) => b.text === '完成'), '设置面板应有完成按钮');
assert.ok(view.classNames.some((name) => name.includes('dpg-switch')), '开关应使用 dpg-switch 样式');

/* —— 场景三之二：暂停后的两种告知卡 —— */
dbg.dismissDialog();
dbg.openDialog({ kind: 'deferred', atMs: Date.now() + 2 * 3600 * 1000 }, 'pause');
view = render({ t });
text = view.texts.join(' ');
assert.ok(text.includes('已暂停，等谷时自动发送'), `暂停告知卡标题缺失：${text}`);
assert.ok(text.includes('2h00m'), `暂停告知卡应显示剩余时长：${text}`);
assert.ok(view.buttons.some((b) => b.text === '知道了'), '暂停告知卡应有「知道了」');
assert.ok(!view.buttons.some((b) => b.text === '继续'), '暂停告知卡不应有继续按钮');

dbg.openDialog({ kind: 'deferred-elsewhere', atMs: Date.now() + 8000 }, 'auto');
view = render({ t });
text = view.texts.join(' ');
assert.ok(text.includes('暂停的对话不在当前会话'), `跨会话提示缺失：${text}`);

/* —— 场景四：设置页（从「设置」里随时可打开的那一页） —— */
dbg.dismissDialog();
const page = collect(dbg.components.SettingsPage({ t }));
const pageText = page.texts.join(' ');
assert.ok(pageText.includes('峰时守卫设置'), '设置页应有标题');
assert.ok(pageText.includes('发送前自动判定峰时与谷时'), '设置页应有说明文字');
assert.ok(pageText.includes('工作日 09:00–12:00'), '设置页应带峰时口径');
assert.ok(page.classNames.some((name) => name.split(/\s+/).includes('dpg-page')), '设置页应使用 dpg-page 布局');
assert.ok(page.buttons.some((b) => b.testId === 'peak-guard-repeat-switch'),
  '设置页应带与卡片一致的开关控件');
// 放假数据：一行状态、一个开关、一个「立即更新」按钮，三件都要在设置页里可见
assert.ok(pageText.includes('放假安排'), '设置页应有放假数据一行');
assert.ok(page.buttons.some((b) => b.testId === 'peak-guard-holi-switch'),
  '设置页应有自动更新开关');
assert.ok(page.buttons.some((b) => b.testId === 'peak-guard-holi-refresh'),
  '设置页应有立即更新按钮');

/* —— 场景四之二：调试模式 —— */
// 默认关闭时，设置页里不该出现任何调试控件
assert.ok(!page.buttons.some((b) => b.testId === 'peak-guard-force-peak'),
  '未开调试时不应出现强制档位按钮');
dbg.patchSettings({ debugMode: true });
const dbgPage = collect(dbg.components.SettingsPage({ t }));
const dbgText = dbgPage.texts.join(' ');
assert.ok(dbgText.includes('调试模式'), '应出现调试模式开关');
assert.ok(dbgText.includes('强制峰时'), '应出现强制峰时按钮');
assert.ok(dbgText.includes('时钟快进'), '应出现时钟快进行');
assert.ok(dbgPage.buttons.some((b) => b.testId === 'peak-guard-force-peak'), '缺少强制峰时');
assert.ok(dbgPage.buttons.some((b) => b.testId === 'peak-guard-force-off'), '缺少强制谷时');
assert.ok(dbgPage.buttons.some((b) => b.testId === 'peak-guard-force-near'), '缺少强制临近峰时');
assert.ok(dbgPage.buttons.some((b) => b.testId === 'peak-guard-clock-1m'), '缺少 +1m 按钮');
assert.ok(dbgPage.buttons.some((b) => b.testId === 'peak-guard-clock-reset'), '缺少时钟复位按钮');
// 关掉调试后调试区整体消失
dbg.patchSettings({ debugMode: false, forceTier: 'auto' });
const plainPage = collect(dbg.components.SettingsPage({ t }));
assert.ok(!plainPage.buttons.some((b) => b.testId === 'peak-guard-force-peak'),
  '关掉调试后不应残留调试按钮');

/* —— 场景五：关闭后不渲染任何节点 —— */
dbg.dismissDialog();
const empty = render({ t });
assert.strictEqual(empty.texts.length, 0, '无卡片时不应有文本');
assert.strictEqual(empty.buttons.length, 0, '无卡片时不应有按钮');

/* —— 场景五：预览出口（不等到真实峰时也能看样式）—— */
const previewPeak = dbg.preview('peak');
assert.strictEqual(previewPeak.kind, 'peak', 'preview(peak) 应打开峰时卡');
assert.strictEqual(dbg.readState().dialog.source, 'preview');
const previewNear = dbg.preview('near');
assert.strictEqual(previewNear.kind, 'near', 'preview(near) 应打开谷时提醒');
assert.ok(previewNear.atMs - Date.now() <= 45 * 60 * 1000 + 1000, '预览提醒应显示 45 分钟');
dbg.dismissDialog();

/* —— 场景六：样式注入与卸载 —— */
const dispose = mod.apply({
  effect: (run) => { const off = run(); assert.strictEqual(typeof off, 'function', 'effect 应返回清理函数'); return off; },
  locale: {
    register: (ns, dicts) => () => {},
    bind: () => (key) => ZH[key] || key,
  },
  slots: {
    inject: (key, factory) => { assert.strictEqual(typeof factory, 'function'); },
  },
});
assert.ok(head.children.some((node) => node.attrs['data-plugin-css'] === 'dsh-peak-window'), '应注入插件样式');
// 浅色设置页里的"关"态开关必须有自己的配色，否则白底白块等于没渲染（曾把调试开关藏没了）
const cssNode = head.children.find((node) => node.attrs['data-plugin-css'] === 'dsh-peak-window');
const cssText = JSON.stringify(cssNode);
assert.ok(cssText.includes('.dpg-page .dpg-switch'), '缺少设置页开关的关态配色');
assert.ok(cssText.includes('aria-checked=\"true\"') || cssText.includes('aria-checked'), '开关仍应按 aria-checked 切换配色');

console.log('界面结构断言通过：峰时卡 / 谷时提醒 / 设置面板 / 空态 / 样式注入');
