/**
 * 峰时守卫（dsh-peak-window）—— 浏览器端。
 *
 * 宿主没有「提交前确认」的扩展点，所以这里用两个槽位配合完成：
 *   1. conversation.input.right：输入卡右下角的空渲染探针，把当前会话的输入状态
 *      （草稿是否为空、投递阶段、是否在运行、submit 入口）登记到模块级 store；
 *   2. shell.overlay：整帧浮层，负责画确认卡，并在 document 捕获阶段拦住
 *      「发送消息」按钮的点击 —— 拦下即 preventDefault，React 的 onClick 不会执行，
 *      草稿、附件、光标全部原地保留，正好实现「返回」的语义。
 * 「继续」时对同一个按钮重放一次 click（放行标记），把投递模式、埋点、焦点
 * 全部交回宿主，避免我们自己拼一条提交流程。
 *
 * 峰时口径与 @kenz1117/dsh-ui-usage-billing 保持一致：
 * 工作日 09:00–12:00、14:00–18:00 为峰时，周末与法定节假日全天为谷时。
 */

window.__ModuleLoader__.load({
  id: 'dsh-peak-window',
  factory(require) {
    'use strict';

    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState } = React;

    /*
     * 峰时守卫：发送前的峰谷闸门。
     *
     * 一句话原理：宿主没有"提交前确认"的扩展点，所以这里不等提交发生，
     * 而是在捕获阶段把"发送按钮的点击 / 输入框的回车"拦下来；拦下来就等于消息没发出、
     * 草稿还在，此时再决定是补发（继续）还是作罢（返回）。
     *
     * 数据流：
     *   用户点发送 ──► document 捕获监听 ──► gateAt(now)
     *                                   ├─ null  ──► 放行，宿主照常发送
     *                                   └─ 有结果 ──► 拦下 + 打开卡片
     *                                                   ├─ 继续 ──► 重放原始事件
     *                                                   └─ 返回 ──► 只关卡片
     *
     * 三块状态各司其职：
     *   1. 时间判定（纯函数，无副作用）—— 口径、翻转点、剩余时长格式化；
     *   2. 模块级 store（订阅式）—— 计划、草稿、运行态、上次提醒时刻；
     *   3. 两个槽位 —— 输入卡探针（拿 session 状态）+ 整帧浮层（画卡片、装全局监听）。
     *
     * 刻意不做的事：
     *   - 不改宿主任何文件、不包一层 Composer 组件，只旁挂一个空渲染探针和一个浮层；
     *   - 不把卡片做成模态框，因为它可能出现在正在跑的回合旁边，锁住页面反而更糟；
     *   - 不自己计算"发送"该走什么模式，永远把决定权交回宿主。
     */

    /* ==================== 一、常量与文案 ==================== */
    // 命名空间、存储键、时间单位与峰时口径都集中在这里；
    // 改作息、改默认值、改节假日，理论上只需要动这一节。

    // 插件自己的命名空间：既是 i18n 词典的键前缀，也是插件的稳定标识。
    // 改它会连带影响 localStorage 里已存的设置（键名里带着它），所以别轻易动。
    const NS = 'dsh-peak-window';
    const CONV_NS = 'ui-conversation';
    const SETTINGS_KEY = 'dsh-peak-window:settings:v1';
    // 暂停待发的草稿：单独一个键，因为它跨刷新、跨重启都要留着，
    // 和设置的生命周期不同（设置是长期偏好，草稿是一次性的待办）
    // 待发草稿的存储键：带版本后缀，将来结构变了直接换 v2，不必写迁移代码
    const DEFER_KEY = 'dsh-peak-window:pending:v1';
    // 旧包名（dsh-peak-guard）时期的存储键。改名是为了上架 npm，但老用户的设置与放假缓存
    // 都还躺在旧键里，直接换键等于让他们回到默认值、还要重拉一次数据，所以保留这两个只读别名。
    const LEGACY_SETTINGS_KEY = 'dsh-peak-guard:settings:v1';
    const LEGACY_HOLIDAY_CACHE_KEY = 'dsh-peak-guard:holidays:v1';

    /**
     * 读 localStorage，新键没有时回落到旧键，并顺手把旧值搬到新键。
     * 只做"读时迁移"，不删旧键 —— 万一新版被回退，旧版还能读到自己那份数据。
     * @param {string} key       当前键
     * @param {string} legacyKey 旧键，可为空
     * @returns {string|null} 原始字符串
     */
    function storageRead(key, legacyKey) {
      try {
        const hit = window.localStorage.getItem(key);
        if (hit) return hit;
        if (!legacyKey) return null;
        const old = window.localStorage.getItem(legacyKey);
        if (old) window.localStorage.setItem(key, old);   // 迁移一次，下次直接命中新键
        return old;
      } catch (error) {
        return null;                                      // 隐私模式下当没有
      }
    }
    // 时间单位与扫描上限：SCAN_DAYS 取 8 是因为最长的连续谷时是"周五 18:00 到周一 09:00"，
    // 期间的法定节假日还可能再加几天，留足余量后扫描结果是稳定可预期的。
    const MIN_MS = 60 * 1000;              // 一分钟
    const DAY_MS = 24 * 60 * MIN_MS;       // 一天
    const SCAN_DAYS = 8;                   // 找下一个峰谷翻转点最多向前扫几天

    // 工作日峰时窗口（单位：当日分钟数）：09:00–12:00、14:00–18:00
    // 峰时窗口按"当日分钟数"给出：[开始, 结束)，单位分钟。
    // 540 = 09:00、720 = 12:00、840 = 14:00、1080 = 18:00。
    // 只写这个数组而不写 if 判断，是为了以后调整作息时只改数据、不动逻辑。
    const PEAK_WINDOWS = [
      [9 * 60, 12 * 60],
      [14 * 60, 18 * 60],
    ];

    // ── 节假日数据：内置兜底表 + 每年自动从公开数据源更新 ─────────────────
    // 内置 2026 年表：只在"从没联网成功过"或"整段时间都离线"时兜底使用。
    // 正常路径是下面 refreshHolidays() 把网络数据合并进来，用户不用每年回来改代码。
    // 格式统一用 YYYYMMDD 字符串，方便直接和 dayKey() 的输出比对。
    const HOLIDAYS = new Set([
      '20260101', '20260102', '20260103',
      '20260216', '20260217', '20260218', '20260219', '20260220', '20260221', '20260222',
      '20260405', '20260406',
      '20260501', '20260502', '20260503', '20260504', '20260505',
      '20260619', '20260620', '20260621',
      '20260925', '20260926', '20260927',
      '20261001', '20261002', '20261003', '20261004', '20261005', '20261006', '20261007',
    ]);

    // 调休补班日：被调成工作日的周末（要上班，但计费按全天谷价）。
    // 这类日子必须单独记一份，否则只会被"周六周日算谷时"顺手覆盖，
    // 一旦日后有人改成"周末也要看补班表"，就会误判成峰时。
    // 内置部分是兜底，联网后由数据源的 isOffDay=false 覆盖。
    const BUILTIN_WORKDAYS = new Set([
      '20260104',   // 元旦调休上班（周日）
      '20260214',   // 春节调休上班（周六）
      '20260228',   // 春节调休上班（周六）
      '20260509',   // 劳动节调休上班（周六）
      '20260920',   // 国庆调休上班（周日）
      '20261010',   // 国庆调休上班（周六）
    ]);

    /*
     * 放假安排的取数优先级（从高到低）：
     *   ① 本次刚拉到的网络数据 —— 刚更新，最新；
     *   ② localStorage 里的上次结果 —— 断网、CDN 挂掉、刚开机时用；
     *   ③ 内置表 —— 从没联网成功过时最后兜底，保证插件永远有数据可用。
     * 三层都是有数据就跑，不会因为"没网"把峰谷判定变成"全谷时"，那样反而更误导人。
     * 每年国务院公布次年安排后，数据源仓库会更新对应年份的 JSON，
     * 用户这边什么都不用做：12 小时内总会拉到一次新的。
     */

    // 数据源：NateScarlet/holiday-cn（MIT 许可）。
    // 该项目每年国务院公布次年放假安排后更新对应年份的 JSON，字段是
    //   { year, days: [{ name, date:'YYYY-MM-DD', isOffDay:true|false }] }
    // isOffDay=false 的那批就是"调休补班日"，一次请求把放假与补班都拿到了。
    // 两个地址是同一份文件的不同 CDN：fastly 在国内容易连上，gcore 作备用；
    // 将来两个都抽风时，改这里换成任意返回同格式 JSON 的地址即可，逻辑不用动。
    const HOLIDAY_FEED_URLS = [
      'https://fastly.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json',
      'https://gcore.jsdelivr.net/gh/NateScarlet/holiday-cn@master/{year}.json',
    ];
    const HOLIDAY_CACHE_KEY = 'dsh-peak-window:holidays:v1';  // 拉到的数据存本地，断网也能用
    // 有效期取 12 小时：放假安排一年只变一次，但"用户换了电脑/清了缓存"是随时的，
    // 半天一次既够新鲜，也不会在一天里反复打 CDN。
    const HOLIDAY_TTL_MS = 12 * 3600 * 1000;                  // 12 小时内不重复拉取
    const HOLIDAY_CHECK_MS = 30 * 60 * 1000;                  // 每 30 分钟看一眼是否过期
    const HOLIDAY_TIMEOUT_MS = 6000;                          // 单地址超时，超时立刻换备用
    const HOLIDAY_BUILTIN_YEAR = 2026;                        // 内置表覆盖的年份，仅用于文案

    // 运行时用的两份集合 + 一份元信息。
    // 元信息会镜像进 store，设置页据此显示"上次更新于何时、数据从哪来"。
    // 注意：集合本身不进 store —— 它是大对象且不参与渲染，只参与判定，放进快照纯属浪费。
    let holidaySets = { offDays: new Set(HOLIDAYS), workDays: new Set(BUILTIN_WORKDAYS) };
    // 放假数据的运行时状态：只做展示与判断用，不参与渲染以外的事情
    let holidayInfo = {
      fetchedAt: 0,            // 上次成功拉取的时刻；0 表示从未成功过
      source: 'builtin',       // builtin=内置表 / cache=本地缓存 / network=刚拉到的
      busy: false,             // 正在拉取，设置页据此禁用按钮
      error: null,             // 上次失败原因；失败不清空旧数据，只是显示提示
      years: [HOLIDAY_BUILTIN_YEAR], // 当前覆盖的年份，用于文案与排错
    };

    // 界面文案（客户端半是单文件模块，不引入 JSON 加载，故内置字典；
    // locale/*.json 只负责插件列表里的标题与描述）
    const ZH = {
      peakTitle: '当前为峰时',
      peakBody: '{remain} 后转谷时',
      nearTitle: '距离峰时仅剩 {remain}',
      nearBody: '峰时价格更高，可先返回稍后再发送',
      continueLabel: '继续',
      backLabel: '返回',
      okLabel: '知道了',
      settingsLabel: '设置',
      settingsTitle: '峰时守卫设置',
      pageDesc: '发送前自动判定峰时与谷时：峰时先确认再发，谷时临近峰时提醒一次。下面这些设置对所有会话立即生效。',
      leadLabel: '谷时提醒提前量',
      leadHint: '距离峰时不足该时长时提醒，最大 24 小时。',
      hourUnit: '时',
      minuteUnit: '分',
      repeatLabel: '重复提醒',
      repeatEvery: '重复间隔',
      repeatHint: '首次提醒后每隔该间隔再次提醒；间隔不得大于提前量。',
      runningLabel: '对话运行时也提醒',
      enterLabel: '回车发送同样拦截',
      ruleText: '峰时：工作日 09:00–12:00、14:00–18:00；周末与法定节假日算谷时。',
      doneLabel: '完成',
      holiLabel: '放假安排',
      holiHint: '自动取当年与次年的放假安排，跨年不用再改代码；断网时用本地缓存或内置表。',
      holiAutoLabel: '自动联网更新',
      holiRefresh: '立即更新',
      holiRefreshing: '更新中…',
      holiBuiltin: '内置表（{years} 年）',
      holiUpdated: '已更新 {when}',
      holiFailed: '更新失败，继续使用本地数据',
      pauseLabel: '暂停，谷时自动恢复执行',
      pauseHint: '先把这次输入存下来，等转谷时自动发出',
      deferredTitle: '已暂停，等谷时自动发送',
      deferredBody: '转谷时（约 {remain} 后）会自动发出你刚才存下的内容',
      deferredElsewhereTitle: '暂停的对话不在当前会话',
      deferredElsewhereBody: '请切回原来那个会话，转谷时插件会自动把内容发出去',
      pendingLabel: '已暂停待发送',
      pendingValue: '{when} 自动发送',
      pendingCancel: '取消暂停',
      debugLabel: '调试模式（仅本机）',
      debugHint: '打开后可强制峰时/谷时并快进时钟，用来验证卡片与自动发送是否符合预期；关掉即恢复真实时间。',
      debugNow: '当前时间',
      debugForceLabel: '强制档位',
      debugForceAuto: '按真实时间',
      debugForcePeak: '强制峰时',
      debugForceOff: '强制谷时',
      debugForceNear: '强制临近峰时',
      debugClockLabel: '时钟快进',
      debugClockReset: '复位',
      // 调试区文案集中在这里，与正式设置项共用一份字典，避免两处各写一套
      debugTierPeak: '峰时',
      debugTierOff: '谷时',
    };

    // 英文文案：键与中文完全一一对应，缺键会让插件在英文界面下显示键名。
    // meta 里的 title/description 只在插件列表里用，正文文案才走 t()。
    const EN = {
      peakTitle: 'Peak hours right now',
      peakBody: 'Off-peak in {remain}',
      nearTitle: 'Off-peak ends in {remain}',
      nearBody: 'Sending in peak hours costs more. You can go back and send later.',
      continueLabel: 'Send anyway',
      backLabel: 'Back',
      okLabel: 'Got it',
      settingsLabel: 'Settings',
      settingsTitle: 'Peak guard settings',
      pageDesc: 'Peak and off-peak are checked before every send: during peak you confirm first, and just before a peak window starts you get one reminder. Changes below apply to all conversations immediately.',
      leadLabel: 'Warn before peak',
      leadHint: 'Warn once the next peak window is this close; at most 24 hours.',
      hourUnit: 'h',
      minuteUnit: 'm',
      repeatLabel: 'Repeat reminder',
      repeatEvery: 'Repeat every',
      repeatHint: 'Remind again after this interval; it cannot exceed the lead time.',
      runningLabel: 'Also warn while a turn is running',
      enterLabel: 'Intercept Enter as well',
      ruleText: 'Peak hours: weekdays 09:00-12:00 and 14:00-18:00. Weekends and public holidays are off-peak.',
      doneLabel: 'Done',
      holiLabel: 'Holiday calendar',
      holiHint: 'Fetches this year and next year holidays automatically, so no yearly edits; offline it falls back to the local cache or the built-in table.',
      holiAutoLabel: 'Auto update online',
      holiRefresh: 'Update now',
      holiRefreshing: 'Updating…',
      holiBuiltin: 'Built-in table ({years})',
      holiUpdated: 'Updated {when}',
      holiFailed: 'Update failed, still using local data',
      pauseLabel: 'Pause and auto-send off-peak',
      pauseHint: 'Keeps this draft and sends it once off-peak starts',
      deferredTitle: 'Paused, will send off-peak',
      deferredBody: 'Sends your saved draft when off-peak starts (about {remain})',
      deferredElsewhereTitle: 'Paused draft belongs to another conversation',
      deferredElsewhereBody: 'Switch back to that conversation; it will be sent when off-peak starts',
      pendingLabel: 'Paused draft',
      pendingValue: 'sends at {when}',
      pendingCancel: 'Cancel pause',
      debugLabel: 'Debug mode (this browser only)',
      debugHint: 'Force peak/off-peak or fast-forward the clock to verify the card and auto-send; turn it off to return to real time.',
      debugNow: 'Current time',
      debugForceLabel: 'Forced tier',
      debugForceAuto: 'Real time',
      debugForcePeak: 'Force peak',
      debugForceOff: 'Force off-peak',
      debugForceNear: 'Force near peak',
      debugClockLabel: 'Clock',
      debugClockReset: 'Reset',
      debugTierPeak: 'peak',
      debugTierOff: 'off-peak',
    };

    /* ==================== 二、时间判定 ==================== */
    // 全部是纯函数：输入时间戳，输出布尔值或时刻，不读全局状态，方便单测直接调。
    // 这些函数被 __dshPeakGuardDebug 暴露出去，test-guard.mjs 就是照着它们写的断言。

    /**
     * 数字补零到两位（0~9 → 00~09）。
     * 只用在一处：把「9h5m」这种读起来别扭的输出修成「9h05m」。
     * @param {number} value 待格式化的整数
     * @returns {string} 至少两位的十进制字符串
     */
    function pad2(value) {
      return String(value).padStart(2, '0');
    }

    // 本地日期键：20261117，用于节假日表比对
    /**
     * 把时间戳换成"当天日期"的键，例如 20261117。
     * 用本地时间而不是 UTC：峰谷是给人看的作息，必须跟着挂钟走。
     * @param {number} timestamp 毫秒时间戳
     * @returns {string} YYYYMMDD
     */
    function dayKey(timestamp) {
      const date = new Date(timestamp);
      return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`;
    }

    /**
     * 把一串 {date, isOffDay} 记录灌进运行时集合。
     * 每次都从"内置表"重新起算，再叠加传入的记录，因此重复调用是幂等的：
     * 网络数据里明确写着的那天，永远盖过内置表；没写到的日子继续用内置表兜底。
     * @param {Array<{date:string,isOffDay:boolean}>} days 数据源里的一天一条记录
     */
    function applyHolidayDays(days) {
      const offDays = new Set(HOLIDAYS);          // 先铺内置节假日
      const workDays = new Set(BUILTIN_WORKDAYS); // 再铺内置调休补班日
      (days || []).forEach((day) => {
        if (!day || typeof day.date !== 'string') return;   // 脏数据直接跳过，不让整批作废
        const key = day.date.replace(/-/g, '');             // '2026-10-01' → '20261001'
        if (day.isOffDay) {
          offDays.add(key);
          workDays.delete(key);                   // 同一天不可能既是假日又要上班，后到的说了算
        } else {
          workDays.add(key);
          offDays.delete(key);
        }
      });
      holidaySets = { offDays, workDays };
    }

    /**
     * 读本地缓存（上次成功拉取的结果）。
     * 缓存放 localStorage：断网、CDN 被墙、跨年当天没联网，都还能按上次的数据工作。
     * 缓存结构坏了当作没有——内置表始终可用，不能因为一条脏缓存让插件起不来。
     */
    function holidayCacheRead() {
      try {
        const raw = storageRead(HOLIDAY_CACHE_KEY, LEGACY_HOLIDAY_CACHE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.days)) return;
        applyHolidayDays(parsed.days);
        holidayInfo = {
          fetchedAt: Number(parsed.fetchedAt) || 0,
          source: 'cache',
          busy: false,
          error: null,
          years: Array.isArray(parsed.years) && parsed.years.length ? parsed.years : [HOLIDAY_BUILTIN_YEAR],
        };
      } catch (error) {
        // 缓存坏了就当没有：内置表仍然可用
      }
    }

    /**
     * 写本地缓存。写不进去（隐私模式、配额满）只影响"下次启动是否还新鲜"，不影响本次判定。
     * @param {Array} days      归一化后的 {date,isOffDay} 列表
     * @param {Array} years     覆盖到的年份
     * @param {number} fetchedAt 拉取成功的时刻
     */
    function holidayCacheWrite(days, years, fetchedAt) {
      try {
        window.localStorage.setItem(HOLIDAY_CACHE_KEY, JSON.stringify({
          version: 1,
          fetchedAt,
          years,
          days,
        }));
      } catch (error) {
        // 存不下就只在本次会话生效
      }
    }

    /**
     * 拉某一年的放假安排，两个 CDN 是"先用 fastly、失败再换 gcore"的关系。
     * 用 AbortController 给单次请求兜底超时：CDN 偶发挂住而不报错，
     * 没有超时就会一直 busy，用户点「立即更新」也没反应。
     * 注意这里是"下载"而不是"上传"：只发一个 GET，不带任何本地数据、不带 cookie 内容，
     * 请求的也只是"今年/明年"这四个数字。
     * @param {number} year 年份
     * @returns {Promise<object>} 数据源 JSON
     */
    async function fetchHolidayYear(year) {
      let lastError = null;
      for (let index = 0; index < HOLIDAY_FEED_URLS.length; index += 1) {
        const url = HOLIDAY_FEED_URLS[index].replace('{year}', String(year));
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), HOLIDAY_TIMEOUT_MS);
        try {
          const response = await fetch(url, { signal: controller.signal, cache: 'no-cache' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = await response.json();
          if (!body || !Array.isArray(body.days)) throw new Error('bad payload');
          return body;
        } catch (error) {
          lastError = error;   // 记下原因，换下一个地址再试
        } finally {
          clearTimeout(timer);
        }
      }
      throw lastError || new Error('feed unreachable');
    }

    /**
     * 刷新节假日数据：拉今年与明年两份，合并进运行时集合并写缓存。
     * - 只有"今年"失败才算失败（明年还没公布是常态，10 月前拉不到 2027 属正常）；
     * - 失败不清空旧数据，只是在设置页显示一行"更新失败，继续使用本地数据"；
     * - force=false 时若缓存还新鲜（12 小时内）直接返回，避免每半小时打一次 CDN。
     * @param {boolean} force true=无视有效期立即拉取（用户点「立即更新」时）
     * @returns {Promise<object>} 刷新后的元信息
     */
    async function refreshHolidays(force) {
      if (holidayInfo.busy) return holidayInfo;                       // 已经在拉了，不叠并发
      const fresh = holidayInfo.fetchedAt > 0
        && Date.now() - holidayInfo.fetchedAt < HOLIDAY_TTL_MS;
      if (!force && fresh) return holidayInfo;

      holidayInfo = Object.assign({}, holidayInfo, { busy: true, error: null });
      setState({ holi: holidayInfo });

      const thisYear = new Date().getFullYear();
      const years = [thisYear, thisYear + 1];                          // 明年一并取，跨年前就绪
      const fetched = [];
      let failure = null;
      for (const year of years) {
        try {
          fetched.push({ year, body: await fetchHolidayYear(year) });
        } catch (error) {
          // 只有今年失败才是真失败；明年没有属于正常情况（国务院一般 11 月才公布）
          if (year === thisYear) failure = error;
        }
      }

      if (failure) {
        holidayInfo = Object.assign({}, holidayInfo, {
          busy: false,
          error: String((failure && failure.message) || failure),
        });
        setState({ holi: holidayInfo });
        return holidayInfo;                                          // 旧数据继续用，不降级成空
      }

      const days = [];
      const okYears = [];
      fetched.forEach((item) => {
        okYears.push(item.year);
        item.body.days.forEach((day) => {
          if (!day || typeof day.date !== 'string') return;
          days.push({ date: day.date, isOffDay: !!day.isOffDay });
        });
      });

      applyHolidayDays(days);
      const fetchedAt = Date.now();
      holidayInfo = { fetchedAt, source: 'network', busy: false, error: null, years: okYears };
      holidayCacheWrite(days, okYears, fetchedAt);
      setState({ holi: holidayInfo });
      return holidayInfo;
    }

    // 启动时先读缓存：这样"刚打开 DSH 就要判断峰谷"的那一刻，手里已经有去年的数据
    holidayCacheRead();

    /**
     * 判断某天是否要按"工作日"看待（即峰时窗口生效）。
     * 顺序：两张特例表优先，最后才看星期几。
     * 注意：调休补班日虽然要上班，但计费口径是"全天谷价"，
     * 所以它和法定节假日一样直接返回 false —— 不能因为"要上班"就判成工作日。
     * @param {number} timestamp 毫秒时间戳
     * @returns {boolean} true=工作日（仅普通周一至周五）
     */
    function isWorkday(timestamp) {
      const key = dayKey(timestamp);
      if (holidaySets.offDays.has(key)) return false;     // 法定节假日：整天谷价
      if (holidaySets.workDays.has(key)) return false;    // 调休补班日：同样整天谷价
      const weekday = new Date(timestamp).getDay();
      return weekday !== 0 && weekday !== 6;              // 普通周末休息，其余是工作日
    }

    // 该时刻是否落在峰时
    /**
     * 判断某一时刻是否处于峰时。
     * 顺序上先排除周末、法定节假日与调休补班日（它们整天谷价），再看是否落进任一个峰时窗口；
     * 窗口是左闭右开，所以 12:00 整点已经算谷时——这样和"12:00 后转谷时"的文案一致。
     * @param {number} timestamp 毫秒时间戳
     * @returns {boolean} true=峰时
     */
    function isPeak(timestamp) {
      if (!isWorkday(timestamp)) return false;                   // 节假日/补班日/普通周末：整天谷价
      const date = new Date(timestamp);
      const minute = date.getHours() * 60 + date.getMinutes();   // 当日分钟数
      for (let index = 0; index < PEAK_WINDOWS.length; index += 1) {
        const from = PEAK_WINDOWS[index][0];
        const to = PEAK_WINDOWS[index][1];
        if (minute >= from && minute < to) return true;
      }
      return false;
    }

    // 下一个峰谷状态翻转的时刻；entering 表示翻转后是否进入峰时
    /**
     * 找出此刻之后"峰谷状态第一次发生变化"的时刻。
     * 做法是从下一分钟起逐分钟向前试，最多扫 SCAN_DAYS 天：
     * 与其维护复杂的作息代数，不如用最笨的扫描换取不会算错的可靠性。
     * @param {number} timestamp 毫秒时间戳
     * @returns {{atMs:number, entering:boolean}|null}
     *          atMs=翻转时刻；entering=true 表示那一刻进入峰时（谷→峰），false 表示进入谷时。
     */
    function nextSwitch(timestamp) {
      const current = isPeak(timestamp);
      const start = Math.ceil(timestamp / MIN_MS) * MIN_MS;     // 对齐到整分，避免秒级抖动
      const limit = timestamp + SCAN_DAYS * DAY_MS;
      for (let cursor = start; cursor <= limit; cursor += MIN_MS) {
        if (isPeak(cursor) !== current) return { atMs: cursor, entering: !current };
      }
      return null;                                             // 理论上不会发生
    }

    // 时长格式化：与用量插件的胶囊同款，9h49m / 0h07m
    /**
     * 把剩余毫秒格式化成「XhYYm」。
     * 不足一分钟时向上取整到 1 分钟：卡片上显示「0h00m」会让人以为已经没有时间了。
     * @param {number} ms 剩余毫秒
     * @returns {string} 例如 2h00m / 9h49m
     */
    function formatRemain(ms) {
      const totalMinutes = Math.max(1, Math.ceil(ms / MIN_MS));
      const hours = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      return `${hours}h${pad2(minutes)}m`;
    }

    /**
     * 把"上次更新时间"格式化成给人看的一小段：11-18 00:12。
     * 只到分钟：这张表一天最多更新几次，秒级精度对用户没有意义，反而占地方。
     * @param {number} timestamp 毫秒时间戳
     * @returns {string} 例如 11-18 00:12；时间戳为 0 时返回空串（表示从未更新）
     */
    function formatUpdatedAt(timestamp) {
      if (!timestamp) return '';
      const date = new Date(timestamp);
      return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    }

    /**
     * 把时间戳格式化成「HH:MM」，用在"已暂停待发送，14:00 自动发送"这类文案里。
     * 只给同一天用；跨天时设置页那一行会带上日期（由调用方决定怎么拼）。
     * @param {number} timestamp 毫秒时间戳
     * @returns {string} 例如 14:00
     */
    function formatClock(timestamp) {
      // 只取时分：暂停最长也就等到下一个谷时开始，不会跨到第二天以外的场景
      const date = new Date(timestamp);
      return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
    }

    /**
     * 把数值夹在闭区间 [low, high] 内。
     * 设置项一律经过它：用户能输入任何数字，落库前必须收敛到合法范围。
     * @param {number} value 原值
     * @param {number} low 下限
     * @param {number} high 上限
     * @returns {number} 夹紧后的值
     */
    function clamp(value, low, high) {
      return Math.min(high, Math.max(low, value));
    }

    /* ==================== 三、设置存取 ==================== */
    // 设置只有四个用户可改的字段，读出来一律先过 normalizeSettings 再使用；
    // 这样即便 localStorage 里是上一版插件留下的旧结构，也不会把非法值带进判定。

    // 出厂默认值：提前量 2 小时（够吃个午饭再回来发）、重复间隔 15 分钟、
    // 运行中也提醒、回车同样拦截。这四项都能在卡片里的设置面板改。
    // 注意 debugMode/forceTier 也在这一份里：它们和正式设置存同一个 key，
    // 好处是刷新页面后仍然保持上次的调试状态，省得每次都重新点一遍。
    const DEFAULT_SETTINGS = {
      leadMin: 120,            // 谷时提醒提前量：默认 2 小时
      repeatEnabled: true,     // 是否重复提醒
      repeatMin: 15,           // 重复间隔：默认 15 分钟
      remindWhileRunning: true,// 对话运行时是否也提醒
      guardEnter: true,        // 回车发送是否同样拦截
      autoHoliday: true,       // 是否允许联网更新放假安排（关掉就只用本地缓存/内置表）
      debugMode: false,        // 调试模式：默认关，只在本机浏览器里生效
      forceTier: 'auto',       // 调试用：auto=按真实时间判定；peak/offPeak/near=强制档位
    };

    // 一律做钳制：提前量 1 分钟 ~ 24 小时；重复间隔 1 分钟 ~ 提前量（需求要求 t 不得大于提前量）
    /**
     * 把外部读来的设置（可能来自旧版本、被手改过的 localStorage）整理成合法值。
     * 规则：缺字段用默认值兜底；0 或非数字视为非法输入，同样退回默认值；
     * 有值的做夹紧——提前量 1 分钟~24 小时，重复间隔 1 分钟~提前量。
     * 最后一种钳制直接对应需求里的"t 不得大于 ??h??m"。
     * @param {object|null} raw 原始设置对象
     * @returns {object} 含 leadMs / repeatMs 等派生字段的完整设置
     */
    function normalizeSettings(raw) {
      const base = Object.assign({}, DEFAULT_SETTINGS, raw && typeof raw === 'object' ? raw : {});
      const leadMin = clamp(Math.round(Number(base.leadMin) || DEFAULT_SETTINGS.leadMin), 1, 1440);
      const repeatMin = clamp(Math.round(Number(base.repeatMin) || DEFAULT_SETTINGS.repeatMin), 1, leadMin);
      return {
        leadMin,
        leadMs: leadMin * MIN_MS,
        repeatMin,
        repeatMs: repeatMin * MIN_MS,
        repeatEnabled: base.repeatEnabled !== false,
        remindWhileRunning: base.remindWhileRunning !== false,
        guardEnter: base.guardEnter !== false,
        // 默认开启：每年自动取放假安排是本插件的核心卖点，关掉只是给"完全不想联网"的人留个口子
        autoHoliday: base.autoHoliday !== false,
        // 调试开关只认严格 true：localStorage 里手改成字符串也不会误开
        debugMode: base.debugMode === true,
        // 强制档位只认白名单，其余一律auto——避免旧数据把判定卡在一个不存在的档上
        forceTier: ['peak', 'offPeak', 'near'].indexOf(base.forceTier) >= 0 ? base.forceTier : 'auto',
      };
    }

    /**
     * 从 localStorage 读设置。
     * 读失败一律退回默认值：隐私模式、存储被禁、JSON 损坏都不该让插件崩掉。
     * @returns {object} 规范化后的设置
     */
    function loadSettings() {
      try {
        const raw = storageRead(SETTINGS_KEY, LEGACY_SETTINGS_KEY);
        return normalizeSettings(raw ? JSON.parse(raw) : null);
      } catch (error) {
        return normalizeSettings(null);   // 隐私模式 / 禁用存储时退回默认值
      }
    }

    /**
     * 把设置写回 localStorage。
     * 只存四个用户可改的字段，不存派生的毫秒值，避免两份真值打架。
     * 写失败（配额满、隐私模式）就只在本次会话内生效，不弹任何错误打扰用户。
     * @param {object} settings 规范化后的设置
     */
    function saveSettings(settings) {
      try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({
          leadMin: settings.leadMin,
          repeatMin: settings.repeatMin,
          repeatEnabled: settings.repeatEnabled,
          remindWhileRunning: settings.remindWhileRunning,
          guardEnter: settings.guardEnter,
          autoHoliday: settings.autoHoliday,
        }));
      } catch (error) {
        // 存不下就只在本次会话生效，不打断用户
      }
    }

    /* ==================== 四、模块级状态 ==================== */
    // 单例 store：写入只有 setState 一个口子，读取有两条路——
    // 组件走 useGuardState（订阅 + 重渲染），逻辑代码走 readState（拿快照做判断）。

    // 模块级状态。整个插件只有这一份真值，组件全部通过 useGuardState 读它：
    //   settings      规范化后的设置（提前量、重复间隔、各开关）
    //   dialog        当前卡片；null 表示没卡，kind 区分峰时确认与谷时提醒
    //   pending       被拦下的那次提交：source 记录是点击还是回车，el 保存原始元素以便重放
    //   composer      输入卡探针最近一次上报的会话状态（草稿是否为空、是否在跑、兜底 submit）
    //   lastReminderAt 首次谷时提醒的时刻，重复提醒以它为基准；0 表示还没提醒过
    //   now           渲染用的"现在"，由定时器刷新，驱动卡片上的倒计时
    //   holi          放假数据的元信息（从哪来、什么时候更新、是否正在更新、上次错误）
    let state = {
      settings: loadSettings(),
      dialog: null,       // { kind:'peak'|'near', atMs, view:'main'|'settings', source }
      pending: null,      // { source:'click'|'enter', el:HTMLButtonElement|null }
      composer: null,     // { sessionId, draftEmpty, phase, running, submit }
      lastReminderAt: 0,  // 上一次「谷时提醒」弹出的时刻，重复提醒的计时基准
      now: Date.now(),
      holi: holidayInfo,  // 与 holidayInfo 指向同一对象；刷新时整块替换，不原地改
      defer: loadDefer(), // 暂停待发的草稿 { sessionId, text, atMs, savedAt }，null 表示没有
      deferNoticeAt: 0,   // 上次因"会话不匹配"提示的时刻，防止每 5 秒重复弹
    };

    // 订阅者集合：卡片组件挂载时加入、卸载时移除；用 Set 保证同一个组件不会重复登记。
    const subscribers = new Set();

    /**
     * 取当前状态的只读快照。
     * 组件只在渲染期读它，写入口统一收敛到 setState，避免多处赋值导致状态漂移。
     * @returns {object} 模块级状态对象
     */
    function readState() {
      return state;
    }

    /**
     * 订阅状态变化，返回退订函数。
     * 用最朴素的自建订阅而不是 useSyncExternalStore：
     * 本插件的状态在 React 之外也会变（定时器、全局监听），自建订阅对版本差异更宽容。
     * @param {Function} listener 状态变化时调用
     * @returns {Function} 退订
     */
    function subscribe(listener) {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    }

    /**
     * 通知所有订阅者。
     * 单个订阅者抛错只吞掉它自己的异常：一个组件坏了不该让其余卡片一起停摆。
     */
    function emit() {
      subscribers.forEach((listener) => {
        try {
          listener();
        } catch (error) {
          // 单个订阅者报错不影响其它订阅者
        }
      });
    }

    /**
     * 以"合并"的方式更新状态并广播。
     * 只做浅合并：嵌套对象（如 dialog）改动时由调用方整块替换，语义更清楚。
     * @param {object} patch 要合并进状态的字段
     */
    function setState(patch) {
      state = Object.assign({}, state, patch);
      emit();
    }

    // 订阅式快照钩子（不依赖 useSyncExternalStore，兼容各 React 版本）
    /**
     * 订阅式快照钩子：组件调用它即可在状态变化后重渲染。
     * @returns {object} 当前状态快照
     */
    function useGuardState() {
      const [snapshot, setSnapshot] = useState(readState);
      useEffect(() => subscribe(() => setSnapshot(readState())), []);
      return snapshot;
    }

    // 由 apply 注入的 ui-conversation 翻译函数，用来识别发送按钮的 aria-label
    // ui-conversation 的翻译函数由 apply 注入；拿不到时退化为结构判定，不能让识别直接失效。
    let translateConversation = null;

    /* ==================== 四之二、调试模式 ==================== */
    // 需求原话是"仅我可调试"：实现上不做账号校验，而是做成
    // 默认关闭 + 只写本机 localStorage 的开关。别人的插件实例看不到你的开关，
    // 也就看不到这些调试控件；想要更强的隔离，把同一个开关改成"要输口令才能开"即可。
    // 调试模式解决的是"想验一段特定时间，但一天只有那几个窗口"的问题：
    // 打开后既可以快进时钟，也可以直接把当前档位强制成峰时/谷时/临近峰时。
    // 它只改本机 localStorage 里的开关，不影响任何其他用户，也不需要服务端配合。

    // 时钟偏移量（毫秒）：只在调试模式打开时参与判定，关掉瞬间等于没快进过。
    // 有意不写进 localStorage：意外留下的"未来时钟"会让判定长期错乱，
    // 刷新页面就归零比持久化更安全。
    let debugOffsetMs = 0;

    /**
     * 供全部判定使用的"当前时间"。
     * 真实时间 + 调试偏移；没开调试时就是 Date.now()，与线上行为完全一致。
     * 注意：放假缓存的 12 小时有效期仍用真实时间，不受快进影响。
     * @returns {number} 毫秒时间戳
     */
    // 为什么要有这么一层：判定函数全部以"传入的时间戳"为准，
    // 只要这里换掉时间源，整条链路（门禁/倒计时/重复提醒/暂停待发）就一起快进了，
    // 不需要在每个调用点各写一遍 if (debug)。
    function nowMs() {
      const offset = state.settings && state.settings.debugMode ? debugOffsetMs : 0;
      return Date.now() + offset;
    }

    /**
     * 当前"应该算峰时还是谷时"——把调试强制档也算进去的唯一入口。
     * 判定逻辑本身（isPeak）保持纯函数，不掺调试；需要按用户视角看档位的地方都走这里。
     * @param {number} now 毫秒时间戳
     * @returns {'peak'|'offPeak'} 当前档位
     */
    // 供 UI 与"要不要重复提醒"这类地方共用；
    // 刻意和 isPeak 分开：isPeak 必须保持纯函数，否则 nextSwitch 的扫描会被强制档带偏，
    // 出现"永远扫不到翻转点"的死循环。
    function effectiveTier(now) {
      const forced = state.settings && state.settings.debugMode ? state.settings.forceTier : 'auto';
      if (forced === 'peak') return 'peak';
      if (forced === 'offPeak') return 'offPeak';
      if (forced === 'near') return 'offPeak';         // 临近峰时属于谷时，只是余量少
      return isPeak(now) ? 'peak' : 'offPeak';
    }

    /**
     * 快进/倒退时钟（仅调试模式生效）。
     * @param {number} deltaMs 增量毫秒，可为负
     */
    // 时钟按钮直接改偏移量而不是伪造时间戳：
    // 偏移是累加的，点十次 +1m 就是 +10m，符合直觉；复位一按就回真实时间。
    function advanceClock(deltaMs) {
      // 没开调试时这些函数是空操作：本地按钮都渲染不出来，但防止有人从控制台直接调
      if (!state.settings || !state.settings.debugMode) return;
      debugOffsetMs += deltaMs;
      setState({ now: nowMs() });
    }

    /**
     * 复位调试时钟偏移，回到真实时间。
     */
    function resetClock() {
      debugOffsetMs = 0;
      setState({ now: nowMs() });
    }

    // 调试模式的使用清单（也是我验证插件时的顺序）：
    // 1) 打开调试开关，确认状态行显示的时间是"现在"；
    // 2) 点「强制峰时」，再点一次发送——应弹出峰时卡，点「返回」草稿还在；
    // 3) 点「强制临近峰时」，再点发送——应弹出"仅剩"提醒，且消息照常发出；
    // 4) 点「+1h」若干次，观察状态行的档位是否随虚拟时间在峰谷之间切换；
    // 5) 测自动发送：在峰时点「暂停」，然后连续快进到转谷时刻，看消息是否自动发出；
    // 6) 点「复位」并关掉调试开关，恢复真实时间与自动判定。

    /* ==================== 五、门禁判定与动作 ==================== */
    // 这一节回答两个问题：此刻该不该拦（gateAt）、拦下来之后三个按钮各做什么。
    // 动作函数都不直接操作 DOM，只改 store；真正的重放发生在 confirmSend 里。

    // 判定此刻「点击发送」要不要先弹卡；返回 null 表示直接放行
    /**
     * 核心判定：此刻点"发送"要不要先弹卡。
     * - 已有卡片：不再叠加第二张，直接放行（避免连着弹）；
     * - 峰时：给「此时为峰时，X 后转谷时」；
     * - 谷时但下一个翻转点是进入峰时、且剩余时间不超过提前量：给「距离峰时仅剩 X」；
     * - 其余情况（包括周末连着放假的"长谷时"）：不拦。
     * @param {number} now 毫秒时间戳
     * @returns {{kind:'peak'|'near', atMs:number}|null} null=放行
     */
    function gateAt(now) {
      if (state.dialog) return null;                 // 已有卡片时不叠加第二个
      // 调试模式：先看强制档，命中就不再走真实时间判定
      const forced = state.settings && state.settings.debugMode ? state.settings.forceTier : 'auto';
      // 强制档只影响"弹什么卡"，不影响真实的峰谷计算；
      // 关掉调试模式后 gateAt 立刻回到真实时间判定，不需要重启插件。
      if (forced === 'peak') {
        // 假装 1 小时后转谷时：卡片上的倒计时会正常走，方便看着它跳到 0h00m
        return { kind: 'peak', atMs: now + 60 * MIN_MS };
      }
      if (forced === 'offPeak') return null;         // 强制谷时：任何情况下都不弹
      if (forced === 'near') {
        // 强制"临近峰时"：余量取提前量与 30 分钟中较小者，保证一定落进提醒窗口
        return { kind: 'near', atMs: now + Math.min(state.settings.leadMs, 30 * MIN_MS) };
      }
      if (isPeak(now)) {
        const next = nextSwitch(now);                // 峰时：卡片显示「还剩多久转谷时」
        return next ? { kind: 'peak', atMs: next.atMs } : null;
      }
      const next = nextSwitch(now);
      if (!next || next.entering !== true) return null; // 谷时但下一跳不是峰时（如长周末）
      const remain = next.atMs - now;
      if (remain <= 0 || remain > state.settings.leadMs) return null;
      return { kind: 'near', atMs: next.atMs };
    }

    /**
     * 这条判定要不要真的把发送拦下来。
     * 只有峰时确认卡才拦：需求里谷时提醒是「不作干预」的告知，用户点完「知道了」就得能照常发出去；
     * 若谷时也拦，用户点一次发送、点一次知道了、再点一次发送，会陷入"永远发不出去"的死循环。
     * @param {{kind:string}|null} decision gateAt 的返回值
     * @returns {boolean} true=拦下这次发送
     */
    function blocks(decision) {
      return !!decision && decision.kind === 'peak';
    }

    /**
     * 打开卡片。
     * 谷时提醒会把 lastReminderAt 记成"现在"，作为重复提醒的计时起点；
     * 峰时确认卡不计入，否则一个个点"继续"会把提醒节奏带乱。
     * @param {{kind:string, atMs:number}} decision gateAt 的返回值
     * @param {string} source 触发来源：click / enter / repeat / running / preview
     */
    function openDialog(decision, source) {
      const now = Date.now();
      setState({
        dialog: { kind: decision.kind, atMs: decision.atMs, view: 'main', source },
        // 「首次」谷时提醒时刻：重复提醒从这里起算（峰时卡片不计入）
        lastReminderAt: decision.kind === 'near' ? now : state.lastReminderAt,
        now,
      });
    }

    // 只关卡片，不提交：草稿 / 附件 / 光标全部保持原样
    /**
     * 关闭卡片。
     * 只清 dialog 与 pending 两个字段，不碰草稿、附件、光标位置——
     * 「返回」的全部意义就在这里：一次都没发出去，输入框原样留着。
     */
    function dismissDialog() {
      setState({ dialog: null, pending: null, now: Date.now() });
    }

    /* ==================== 五之二、暂停到谷时自动发送 ==================== */
    // 设计要点：
    // 1. 只存纯文本，不存 DOM；附件在输入卡里本来就还在，不需要搬（自动发送前会重新读一次草稿）。
    // 2. 到点不等于能发：会话可能被切走、回合可能正在跑，所以真正发送前要再过一遍条件。
    // 3. 发送动作走宿主自己的 InputActions（setDraft + submit），等同于用户手动发出。

    /**
     * 读取上次暂停、尚未发送的草稿。
     * 解析失败一律当作没有：宁可不发，也不能拿坏数据去填输入框。
     * @returns {{sessionId:string,text:string,atMs:number,savedAt:number}|null} 待发条目
     */
    function loadDefer() {
      try {
        const raw = window.localStorage.getItem(DEFER_KEY);
        if (!raw) return null;
        const value = JSON.parse(raw);
        if (!value || typeof value.text !== 'string' || !value.text.trim()) return null;
        if (!value.atMs || !isFinite(value.atMs)) return null;
        return {
          sessionId: String(value.sessionId || ''),
          text: value.text,
          atMs: Number(value.atMs),
          savedAt: Number(value.savedAt) || 0,
        };
      } catch (error) {
        return null;
      }
    }

    /**
     * 把待发条目写进 localStorage，失败只影响"刷新后还在不在"，不影响本次自动发送。
     * @param {object} entry 待发条目
     */
    function saveDefer(entry) {
      try {
        if (entry) window.localStorage.setItem(DEFER_KEY, JSON.stringify(entry));
        else window.localStorage.removeItem(DEFER_KEY);
      } catch (error) {
        // 隐私模式下存不下：本次会话内仍然会发，只是刷新后丢失
      }
    }

    /**
     * 「暂停，谷时自动恢复执行」：把当前草稿存下来，到谷时再发。
     * 先存再关卡片：存失败也要让用户看到卡片消失了吗？——不，存失败就不关卡片，
     * 让用户改用「返回」自己留着草稿，避免"点了暂停、内容却没了"这种最坏结果。
     */
    function deferSend() {
      const composer = state.composer;
      const dialog = state.dialog;
      if (!composer || !dialog || dialog.kind !== 'peak') return;
      const text = typeof composer.draft === 'string' ? composer.draft : '';
      // 空草稿（可能只有附件）不支持暂停：直接收起卡片，避免用户误以为内容已存下
      if (!text.trim()) {
        // 没有文字（只有附件）时不支持暂停：直接当「返回」，不让用户以为存下了
        dismissDialog();
        return;
      }
      // 记下会话 id：草稿属于哪个会话，就只能发回哪个会话
      const entry = {
        sessionId: String(composer.sessionId || ''),
        text,
        atMs: dialog.atMs,
        savedAt: nowMs(),
      };
      // 落盘后才能算"暂停成功"：刷新页面也还在，第二天开机继续等谷时
      saveDefer(entry);
      // 卡片上确认一下：避免用户以为"点了暂停但什么都没发生"
      setState({
        defer: entry,
        dialog: { kind: 'deferred', atMs: dialog.atMs, view: 'main', source: 'pause' },
        pending: null,
        now: nowMs(),
      });
    }

    /**
     * 取消暂停：清掉待发条目，草稿保持在输入框里（不清空用户的东西）。
     */
    /**
     * 取消暂停：只清待发条目，不动输入框里的草稿。
     * 用户按了这个多半是想自己再改两笔，把内容一起清掉等于二次伤害。
     */
    function cancelDefer() {
      saveDefer(null);
      // 只清待发条目，不动输入框里的草稿：用户取消暂停后多半是想自己再改两笔
      setState({ defer: null, deferNoticeAt: 0, dialog: null, now: Date.now() });
    }

    /**
     * 到点检查：该发就发。
     * 由 tick 每 5 秒调用一次，条件不满足就原地等待（不回退、不丢数据）：
     * - 还没到点：等；
     * - 当前会话不是存草稿的那个：提示一次"切回原会话"，继续等；
     * - 回合正在跑 / 输入卡在投递中：等它空闲；
     * - 都满足：填回草稿 → 调宿主 submit → 清掉待发条目。
     */
    function trySendDeferred(now) {
      const entry = state.defer;
      if (!entry || now < entry.atMs) return;
      const composer = state.composer;
      const actions = (composer && composer.actions) || {};
      // 会话对不上就先不发：内容属于原来那个会话，发到当前会话等于串台
      if (!composer || !composer.sessionId || composer.sessionId !== entry.sessionId) {
        // 会话切走了：数据留着，等用户回到原会话；只提示一次，不刷屏
        if (now - state.deferNoticeAt > 60000) {
          setState({
            deferNoticeAt: now,
            dialog: { kind: 'deferred-elsewhere', atMs: now + 8000, view: 'main', source: 'auto' },
            now,
          });
        }
        return;
      }
      // 回合正在跑、或输入卡正在投递：等它空闲，避免和用户刚点下的发送抢同一份草稿
      if (composer.running || (composer.phase && composer.phase !== 'plain')) return;
      if (typeof actions.setDraft !== 'function' || typeof composer.submit !== 'function') return;

      // 先写回输入框再提交：这样即使用户正好在看，也能看到"内容回来了、正在发"的完整过程
      actions.setDraft(entry.text);
      saveDefer(null);
      setState({ defer: null, deferNoticeAt: 0, now });
      // 等一帧让宿主把草稿写进输入框，再提交；200ms 是实测够用的最小余量
      // 延迟一个短定时再提交：宿主把 setDraft 落到输入框是异步的，同步提交会读到旧草稿
      window.setTimeout(() => {
        const current = state.composer;
        if (current && typeof current.submit === 'function') current.submit('queue');
      }, 200);
      // 卡片会自己消失：atMs 已经过去，tick 到点就收（这里给 6 秒阅读时间）
      setState({ dialog: { kind: 'deferred', atMs: now + 6000, view: 'main', source: 'auto' }, now });
    }

    /**
     * 在主视图与设置视图之间切换。
     * 刻意不做成两个弹窗：设置改完仍停在原来那张卡上，pending 不丢，
     * 用户点「完成」回来还能接着选继续或返回。
     */
    function toggleSettingsView() {
      if (!state.dialog) return;
      const view = state.dialog.view === 'settings' ? 'main' : 'settings';
      setState({ dialog: Object.assign({}, state.dialog, { view }), now: Date.now() });
    }

    // 「继续」：把这次点击原样重放给宿主按钮
    // 「继续」重放时的放行标记：记下要补发的那颗按钮，点击事件回到监听里时直接跳过拦截。
    // 用模块级变量而不是 state，是因为它只在一次同步的 click() 调用期间有效，没必要触发重渲染。
    let replayButton = null;

    /**
     * 「继续」：把刚才被拦下的那次发送原样补发出去。
     * 不直接调 inputActions.submit，而是重放原始事件，理由是宿主自己的发送分支里
     * 还有投递模式选择、埋点、焦点回收等逻辑，绕过去容易出现"点了没反应"或"发两次"。
     * 重放前先记下标记，让全局监听放行这一下，避免自己拦自己。
     */
    function confirmSend() {
      const pending = state.pending;
      setState({ dialog: null, pending: null });
      if (!pending) return;
      // 回车被拦下的：向原输入框补发一次回车，走宿主自己的发送分支（模式、埋点、焦点都一致）
      if (pending.source === 'enter') {
        const target = pending.el;
        if (target && target.isConnected) {
          replayKeyTarget = target;
          target.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            bubbles: true,
            cancelable: true,
          }));
          window.setTimeout(() => {
            if (replayKeyTarget === target) replayKeyTarget = null;
          }, 0);
          return;
        }
      }
      if (pending.el && pending.el.isConnected) {
        replayButton = pending.el;
        pending.el.click();
        window.setTimeout(() => {
          if (replayButton === pending.el) replayButton = null;
        }, 0);
        // 双保险：宿主若改了提交时机（改成 pointerdown 之类），click 重放会落空。
        // 800ms 后草稿还在，说明没发出去，改用 InputActions 直接投递。
        window.setTimeout(() => {
          const composer = state.composer;
          if (!composer || composer.draftEmpty) return;
          if (typeof composer.submit === 'function') composer.submit('queue');
        }, 800);
        return;
      }
      // 兜底（按钮已消失）：走 InputActions.submit，等价于排队发送
      const submit = state.composer && state.composer.submit;
      if (typeof submit === 'function') submit('queue');
    }

    /**
     * 改设置：先规范化、再落库、最后广播。
     * 三步顺序不能反——先落库会把非法值写进存储，先广播会让界面短暂显示非法值。
     * @param {object} patch 只包含要改的字段
     */
    function patchSettings(patch) {
      const next = normalizeSettings(Object.assign({}, state.settings, patch));
      const wasAuto = state.settings.autoHoliday;   // 必须在 setState 之前取旧值
      saveSettings(next);
      setState({ settings: next });
      // 用户刚把「自动联网更新」打开：立刻补拉一次，不用等到下一个半小时的巡检
      if (next.autoHoliday && !wasAuto) {
        refreshHolidays(true).catch(() => {});
      }
    }

    /* ==================== 六、按钮识别与事件拦截 ==================== */
    // 识别靠 aria-label 而不是 CSS 类名：宿主随时可能调样式，但无障碍名称是接口契约的一部分。
    // 监听挂在 document 的捕获阶段，因此一定早于 React 在根容器上的合成事件。

    /**
     * 取出宿主"发送按钮"的本地化名称集合。
     * 宿主的主按钮会在发送/加入队列/插话之间切换文案，三种都要认；
     * 同时过滤掉语言包缺失时原样返回的键名（形如 input.send），否则会拿键名去比 aria-label。
     * @returns {Set<string>} 可能出现在发送按钮上的 aria-label
     */
    function conversationLabels() {
      const labels = new Set();
      const keys = ['input.send', 'input.send.queue', 'input.send.steer'];
      for (let index = 0; index < keys.length; index += 1) {
        try {
          const text = translateConversation ? translateConversation(keys[index]) : '';
          // 语言包缺失时 bind 常常原样返回键名（形如 input.send），这种值不能当标签用
          if (typeof text === 'string' && text && text !== keys[index] && !/^[a-z]+(\.[a-z0-9]+)+$/i.test(text)) {
            labels.add(text);
          }
        } catch (error) {
          // 语言包缺失：交给下面的结构兜底
        }
      }
      return labels;
    }

    // 发送按钮的"词根"：各语言里表示"发送"的词，用于宽松匹配。
    // 之所以不靠精确字符串：宿主的 aria-label 会带括号补充（如"发送消息（Enter）"）、
    // 也可能因为语言包版本差异多一个空格，精确相等在实战里太脆。
    const SEND_WORDS = ['发送', 'send', 'senden', 'enviar', '送信', '전송', 'отправ'];

    /**
     * 规范化无障碍名称：去掉所有空白/零宽字符、去掉括号里的补充说明、转小写。
     * @param {string} value 原始 aria-label
     * @returns {string} 可比较的文本
     */
    function normalizeLabelText(value) {
      return String(value || '')
        .replace(/[\s\u00a0\u200b\u200c\u200d\ufeff]+/g, '')
        .replace(/[（(][^（）()]*[)）]/g, '')
        .toLowerCase();
    }

    /**
     * 判断一段无障碍名称是不是"发送"：规范化后包含任一发送词根即可。
     * @param {string} value aria-label
     * @returns {boolean} 像不像发送按钮
     */
    function looksLikeSend(value) {
      const text = normalizeLabelText(value);
      if (!text) return false;
      return SEND_WORDS.some((word) => text.indexOf(word) >= 0);
    }

    // 最近一次点击的判定记录：出问题时不靠猜，直接看它为什么没命中
    // 点击诊断：只保留最后一次判定结果，用户排查"为什么没弹卡"时读它即可
    const clickTrace = { last: null };

    // 命中输入卡内的主发送按钮则返回该按钮，否则返回 null
    /**
     * 从点击目标往上找"输入卡里的主发送按钮"。
     * 判定条件依次是：在 button 上、位于 [data-composer-card] 内、未被禁用、
     * 不处于发送中、aria-label 命中发送文案。
     *
     * 三个容易踩的坑（都已在实战中核对过）：
     * 1. `aria-busy={false}` 在 React 里会渲染成 `aria-busy="false"`，属性**始终存在**，
     *    所以只能用取值判断，不能 `hasAttribute`——否则永远认不到按钮（历史 bug）。
     * 2. `data-sending` 才是"正在投递"的可靠标记（true 时才渲染，false 时移除）。
     * 3. aria-label 可能带括号后缀或空格差异，故保留词根宽松匹配与 primary 类名兜底。
     * @param {EventTarget} target 事件目标
     * @returns {HTMLButtonElement|null} 命中的按钮
     */
    function findSubmitButton(target) {
      if (!(target instanceof Element)) return null;
      const button = target.closest('button');
      if (!button) return null;
      const card = button.closest('[data-composer-card]');
      if (!card) return null;
      if (button.disabled) return null;
      // 取值判断：只有显式 true 才算"正在发送"
      if (button.getAttribute('aria-busy') === 'true') return null;
      if (button.hasAttribute('data-sending')) return null;

      const ariaLabel = button.getAttribute('aria-label') || '';
      const labels = conversationLabels();
      // ① 语言包精确命中（最理想的情况）
      if (labels.has(ariaLabel)) return button;
      // ② 语言包存在但文案有差异（括号、空白、大小写）→ 词根匹配
      if (looksLikeSend(ariaLabel)) return button;
      // ③ 词根也没中：宿主主按钮带 primary 类名，且有无障碍名称
      if (ariaLabel && /(^|[\s_-])primary([\s_-]|$)/i.test(String(button.className || ''))) return button;
      // ④ 语言包可用、以上都不中 → 判定不是主按钮，避免误拦别的图标键
      if (labels.size > 0) return null;
      if (!ariaLabel) return null;
      // ⑤ 语言包完全不可用：结构兜底，卡片内最后一个按钮就是主按钮
      const buttons = card.querySelectorAll('button');
      return buttons[buttons.length - 1] === button ? button : null;
    }

    /**
     * 捕获阶段的点击拦截。
     * 抢在 React 的 onClick 之前 preventDefault + stopPropagation，等于把发送冻结在
     * "手指按下去、消息还没投递"的那一刻；草稿因此天然保留，不需要额外备份。
     * @param {MouseEvent} event 点击事件
     */
    function onClickCapture(event) {
      const button = findSubmitButton(event.target);
      // 记录这次点击的判定依据：按钮状态 + 是否命中 + 门禁结果。
      // 只留最近一次，不累积、不外发，纯粹给排查用。
      // 用 try 包住：诊断代码不能影响主流程。
      try {
        const card = event.target instanceof Element ? event.target.closest('[data-composer-card]') : null;
        clickTrace.last = {
          inCard: !!card,
          hit: !!button,
          label: button ? button.getAttribute('aria-label') : null,
          cls: button ? String(button.className).slice(0, 60) : null,
          at: Date.now(),
        };
      } catch (error) {
        // 忽略诊断异常
      }
      // 先看是不是我们放行的那次重放点击
      if (!button) return;
      if (replayButton && replayButton === button) {
        replayButton = null;
        return;
      }
      const decision = gateAt(nowMs());
      if (!decision) return;
      if (!blocks(decision)) {
        // 谷时提醒：只弹卡告知，不拦这次点击——消息照常发出去，卡片留在旁边直到用户点「知道了」
        openDialog(decision, 'click');
        return;
      }
      // 捕获阶段拦下：React 的 onClick 不会执行，等于「发送前」被冻结
      event.preventDefault();
      event.stopPropagation();
      setState({ pending: { source: 'click', el: button } });
      openDialog(decision, 'click');
    }

    // 「继续」时补发的回车落在同一个输入框上，用这个标记放行一次，避免自己拦自己
    let replayKeyTarget = null;

    /**
     * 捕获阶段的键盘拦截，管两件事：
     * 1) Esc：任何视图下都等价于「返回 / 知道了」；
     * 2) 回车发送：与点击同等对待（可在设置里关掉），避免出现"点按钮被拦、按回车却漏过去"。
     * 带修饰键的回车（Shift/Ctrl/Alt/Cmd）属于换行或宿主的其它语义，一律不接管。
     * @param {KeyboardEvent} event 键盘事件
     */
    function onKeyDownCapture(event) {
      // Esc：任何视图下都等于「返回 / 知道了」
      if (event.key === 'Escape' && state.dialog) {
        event.preventDefault();
        dismissDialog();
        return;
      }
      if (replayKeyTarget && event.target === replayKeyTarget) {
        replayKeyTarget = null;
        return;                              // 这是我们自己补发的回车，直接交给宿主
      }
      if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
      // 带修饰键的 Enter 是宿主的换行/发送快捷键语义，不接管
      if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      if (!state.settings.guardEnter) return;
      const composer = state.composer;
      if (!composer || composer.draftEmpty) return;
      if (!(event.target instanceof Element) || !event.target.closest('[data-composer-card]')) return;
      const decision = gateAt(nowMs());
      if (!decision) return;
      if (!blocks(decision)) {
        // 与点击同一套规则：谷时只告知、不拦，回车照常把内容发出去
        openDialog(decision, 'enter');
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setState({ pending: { source: 'enter', el: event.target instanceof Element ? event.target : null } });
      openDialog(decision, 'enter');
    }

    /* ==================== 七、定时任务 ==================== */
    // 两个节奏：有卡片时 1 秒刷新倒计时，常驻 5 秒巡检是否该重复提醒。
    // 定时器由浮层组件在挂载时装、卸载时清，插件被禁用后不会留下空转的 interval。

    /**
     * 定时巡检（有卡片时 1 秒一次，常驻 5 秒一次）。
     * 三件事：到点自动收卡（卡片上的倒计时已经失效）、刷新倒计时、
     * 以及在"首次提醒之后"按设定的间隔重复提醒。
     * 重复提醒只在谷时临近峰时之间发生，进入峰时就停。
     */
    function tick() {
      const now = nowMs();
      // 巡检顺序有讲究：先处理待发，再处理卡片，
      // 这样"卡片刚被关掉"和"该自动发送"能落在同一轮里，不用等下一个 5 秒。
      // 暂停到谷时的自动发送：只在"没有卡片挡着"的时候动手，
      // 用户正在卡上做选择时不去抢方向盘；卡片关掉后的下一轮巡检就会发送。
      if (!state.dialog) trySendDeferred(now);
      const dialog = state.dialog;
      if (dialog) {
        // 到点换档：卡片上的「还剩多久」已经失效，自动收起
        if (dialog.atMs && now >= dialog.atMs) {
          setState({ dialog: null, pending: null, now });
          return;
        }
        // 只刷新倒计时，不打扰设置面板里的输入
        if (dialog.view === 'main') setState({ now });
        return;
      }
      // 重复提醒：只在「已经弹过首次谷时提醒之后」才计时
      const settings = state.settings;
      if (!settings.repeatEnabled || state.lastReminderAt <= 0) return;
      if (effectiveTier(now) === 'peak') return;
      const next = nextSwitch(now);
      if (!next || next.entering !== true) return;
      const remain = next.atMs - now;
      if (remain <= 0 || remain > settings.leadMs) return;
      if (now - state.lastReminderAt < settings.repeatMs) return;
      setState({
        dialog: { kind: 'near', atMs: next.atMs, view: 'main', source: 'repeat' },
        lastReminderAt: now,
        now,
      });
    }

    // 会话从空闲转入运行：谷时临近峰时给一次非阻断提示（不暂停、不抢焦点）
    /**
     * 会话从空闲转入运行的那一刻，若正处在"谷时临近峰时"的窗口内，提醒一次。
     * 这是需求里"对话正在运行时也要提醒"的落点：只弹卡、不暂停、不抢焦点，
     * 正在跑的回合完全不受影响。
     */
    function remindWhileRunning() {
      if (!state.settings.remindWhileRunning) return;
      if (state.dialog) return;
      const now = nowMs();
      if (effectiveTier(now) === 'peak') return;
      const next = nextSwitch(now);
      if (!next || next.entering !== true) return;
      const remain = next.atMs - now;
      if (remain <= 0 || remain > state.settings.leadMs) return;
      setState({
        dialog: { kind: 'near', atMs: next.atMs, view: 'main', source: 'running' },
        lastReminderAt: now,
        now,
      });
    }

    /* ==================== 八、样式 ==================== */
    // 样式是一段字符串而不是 CSS 文件：插件包少一个文件、少一层构建依赖。
    // 所有类名统一加 dpg- 前缀，避免和宿主或其它插件的类名撞车。

    // 样式全部内联成一段字符串，由 injectStyles 挂到 head 上。
    // 这样做的好处是不依赖构建工具、不需要额外的 css 文件，代价是要靠 data-plugin-css 手动去重。
    // 配色只借用宿主的两类 token（品牌色、语义色），其余用固定值：
    // 深色胶囊按用户提供的效果图取 #2b2b2b 底 + 白字，宿主主题里没有对应的 tooltip 变量。
    const CSS = [
      /* 卡片本体：仿输入框旁的原生悬浮提示（深色圆角胶囊），浮在输入卡上方 */
      '.dpg-card{position:fixed;right:20px;bottom:108px;z-index:20;box-sizing:border-box;',
      'width:min(304px,calc(100vw - 32px));padding:12px 14px;border-radius:12px;',
      'background:#2b2b2b;color:#f5f5f5;border:1px solid rgba(255,255,255,.09);',
      'box-shadow:0 12px 32px rgba(0,0,0,.38),0 2px 8px rgba(0,0,0,.24);',
      'font-size:13px;line-height:1.5;pointer-events:auto;animation:dpg-in .16s ease-out}',

      '@keyframes dpg-in{from{opacity:0;transform:translateY(6px) scale(.985)}to{opacity:1;transform:none}}',

      '.dpg-head{display:flex;align-items:flex-start;gap:8px}',
      '.dpg-dot{width:8px;height:8px;border-radius:50%;margin-top:6px;flex:none;background:#e5484d}',
      '.dpg-dot[data-kind="near"]{background:#f5a524}',
      '.dpg-text{min-width:0}',

      '.dpg-title{font-size:13px;font-weight:600;letter-spacing:.01em;color:#fff}',
      '.dpg-body{margin-top:2px;font-size:12px;color:rgba(255,255,255,.72);font-variant-numeric:tabular-nums}',

      '.dpg-actions{display:flex;align-items:center;gap:8px;margin-top:10px}',
      '.dpg-actions-pause{margin-top:8px}',
      '.dpg-spacer{flex:1 1 auto}',

      '.dpg-btn{appearance:none;border:0;border-radius:8px;padding:5px 12px;font:inherit;',
      'font-size:12px;line-height:18px;cursor:pointer;transition:background .12s ease}',
      '.dpg-btn:focus-visible{outline:2px solid #fff;outline-offset:1px}',

      /* 返回 / 知道了：浅灰色（低饱和的浅底 + 浅字） */
      '.dpg-btn-neutral{background:rgba(255,255,255,.16);color:#f0f0f0}',
      '.dpg-btn-neutral:hover{background:rgba(255,255,255,.26)}',

      /* 继续：红色 */
      '.dpg-btn-danger{background:#e5484d;color:#fff}',
      '.dpg-btn-danger:hover{background:#f0555a}',

      /* 暂停：整行宽的低饱和蓝，和红色「继续」明确区分，位置在两者之上 */
      '.dpg-btn-pause{flex:1 1 auto;background:rgba(88,140,255,.18);color:#cfe0ff;',
      'border:1px solid rgba(88,140,255,.35);text-align:center}',
      '.dpg-btn-pause:hover{background:rgba(88,140,255,.28)}',

      /* 设置：纯文字按钮，弱化到不抢「继续/返回」的注意力 */
      '.dpg-btn-ghost{background:transparent;color:rgba(255,255,255,.58);padding-left:2px;padding-right:2px}',
      '.dpg-btn-ghost:hover{color:#fff}',

      /*
       * 设置面板：沿用卡片的深色底，控件用低对比的白色半透明填充；
       * 开关是自绘的（button + role=switch），因为宿主没有导出可复用的 Switch。
       */
      /* 设置面板 */
      '.dpg-settings{display:flex;flex-direction:column;gap:9px;margin-top:10px}',
      '.dpg-row{display:flex;align-items:center;justify-content:space-between;gap:10px;',
      'font-size:12px;color:rgba(255,255,255,.82)}',
      '.dpg-field{display:flex;align-items:center;gap:4px}',
      '.dpg-unit{font-size:11px;color:rgba(255,255,255,.55)}',

      '.dpg-num{width:50px;box-sizing:border-box;background:rgba(255,255,255,.1);',
      'border:1px solid rgba(255,255,255,.14);color:#fff;border-radius:6px;padding:3px 6px;',
      'font:inherit;font-size:12px;text-align:right}',
      '.dpg-num:focus{outline:none;border-color:rgba(255,255,255,.42)}',

      '.dpg-switch{position:relative;width:34px;height:20px;flex:none;border:0;padding:0;',
      'border-radius:999px;background:rgba(255,255,255,.2);cursor:pointer}',
      '.dpg-switch[aria-checked="true"]{background:#3b82f6}',
      '.dpg-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;',
      'background:#fff;transition:transform .15s ease}',
      '.dpg-switch[aria-checked="true"] .dpg-knob{transform:translateX(14px)}',

      '.dpg-hint{margin-top:8px;font-size:11px;line-height:1.6;color:rgba(255,255,255,.5)}',
      // 放假数据那块是"一行状态 + 若干行说明"，用列容器把它们叠起来
      '.dpg-col{display:flex;flex-direction:column;gap:4px;margin-top:8px}',
      '.dpg-col .dpg-hint{margin-top:0}',
      // 更新失败用警示色：深浅两套主题都要能看清，所以走 token 而不是写死橙色
      '.dpg-hint-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.dpg-page .dpg-hint-warn{color:var(--dsw-alias-state-warn-primary)}',
      // 设置页里的操作按钮要跟着主题走，深色面板里那份仍用白字
      '.dpg-page .dpg-btn-ghost{color:var(--dsw-alias-brand-primary)}',
      '.dpg-page .dpg-btn-ghost:disabled{opacity:.5}',
      /*
       * 设置页的样式只覆盖“配色与疏密”，布局完全交给宿主：
       * 宿主负责页面容器与滚动，这里只把表单按行排开，避免在别的主题下出现硬编码的深色块。
       */

      '.dpg-page-wrap{padding:2px 0 6px}',
      '.dpg-page-title{margin:0 0 4px;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.dpg-page-desc{margin:0 0 12px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
      '.dpg-page-hint{margin-top:12px;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
      '.dpg-page{gap:12px;margin-top:0}',
      '.dpg-page .dpg-row{font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.dpg-page .dpg-num{width:64px;background:var(--dsw-alias-bg-layer-2);',
      'border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}',
      '.dpg-page .dpg-num:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.dpg-page .dpg-unit{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.dpg-page .dpg-hint{color:var(--dsw-alias-label-secondary)}',
      // 调试区：按钮多、允许换行，深色卡与浅色页里都用同一套
      // 调试区按钮较多，允许换行；右对齐与其它行保持一致的视觉节奏
      '.dpg-wrap{flex-wrap:wrap;justify-content:flex-end;gap:6px}',
      // 调试区与正式设置之间用一条虚线分隔，暗示"这块是给排查用的"
      '.dpg-debug{margin-top:2px;padding-top:8px;border-top:1px dashed rgba(255,255,255,.14)}',
      '.dpg-page .dpg-debug{border-top-color:var(--dsw-alias-border-l1)}',
      // 当前生效的强制档高亮：不靠文字加粗，只靠底色，扫一眼就知道现在是哪一档
      '.dpg-btn-active{background:rgba(88,140,255,.28);color:#fff}',
      '.dpg-page .dpg-btn-active{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent);',
    ].join('\n');

    // 每个插件一个 <style data-plugin-css>，随 fiber 卸载一起移除
    /**
     * 往 head 里挂一段插件自有样式，返回卸载函数交给 ctx.effect 托管。
     * 用 data-plugin-css 打标：一是避免重复注入，二是卸载时能精确摘掉自己那一段。
     * @returns {Function} 清理函数
     */
    function injectStyles() {
      const style = document.createElement('style');
      style.setAttribute('data-plugin-css', 'dsh-peak-window');
      style.textContent = CSS;
      document.head.appendChild(style);
      return () => {
        style.remove();
      };
    }

    /* ==================== 九、输入卡探针（无渲染） ==================== */
    // 这个槽位唯一的用途是"借"到 session 作用域的 props：
    // useInput 拿草稿、useSession 拿 running、inputActions 拿兜底提交。
    // 它不画任何东西，组件体只做状态上报，返回 null。

    /**
     * 只做状态登记，不画任何像素：
     * - useInput 给出草稿与投递阶段，用于判断「回车是否有内容可发」；
     * - useSession 给出 running，用于「对话正在运行时」的提醒；
     * - inputActions.submit 作为确认后的兜底发送入口。
     */
    /**
     * 输入卡探针：不渲染任何像素，只把宿主的状态登记到模块级 store。
     * - useInput 给出草稿是否为空、投递阶段；
     * - useSession 给出 running，用于"对话运行中提醒"；
     * - inputActions.submit 作为按钮已消失时的兜底发送入口。
     * 之所以要多注册一个槽位，是因为 shell.overlay 拿不到 session 作用域的这些 props。
     * @param {object} props 槽位注入的标准属性
     * @returns {null} 永远不渲染
     */
    function ComposerProbe(props) {
      const input = props.useInput((value) => value);
      const running = props.useSession((snapshot) => !!(snapshot && snapshot.running));
      const actions = props.inputActions;

      // 每次渲染后同步一次快照（不触发额外渲染，浮层按需读取）
      useEffect(() => {
        setState({
          composer: {
            sessionId: props.sessionId,
            draftEmpty: input.draft.trim() === '' && input.attachmentIds.length === 0,
            draft: input.draft,                       // 原文，供「暂停到谷时」存档
            phase: input.phase,
            running,
            submit: (mode) => {
              try {
                actions.submit(mode);
              } catch (error) {
                // 提交失败由宿主自己提示，这里不吞掉用户可见的错误
              }
            },
            // 自动发送前要把存下的文字写回输入框，再走宿主的提交通道
            actions: {
              setDraft: (text) => {
                try {
                  actions.setDraft(text);
                } catch (error) {
                  // 写不进去就发不出去，trySendDeferred 下一轮会重试
                }
              },
            },
          },
        });
      });

      // 运行态由假变真：谷时临近峰时提醒一次
      // 用 ref 记住上一次的值，是为了把"边沿"和"电平"分开：
      // 只要 running 一直为真，就只在跳变那一下判一次，不会随每次渲染重复弹卡。
      // 只在 running 由假变真的那个边沿提醒：否则每渲染一次都会判定一遍，
      // 长回合跑起来会变成一直弹卡。
      const runningRef = React.useRef(false);
      useEffect(() => {
        if (running && !runningRef.current) {
          runningRef.current = true;
          remindWhileRunning();
        } else if (!running) {
          runningRef.current = false;
        }
      }, [running]);

      return null;
    }

    /* ==================== 十、设置面板 ==================== */
    // 设置面板与设置页共用；两处只是外壳不同，字段与钳制规则完全一致。

    // 面板画在卡片内部，跟着卡片一起出现/消失；
    // 每个开关与输入框都带 data-testid，test-view.mjs 靠它断言结构。

    /**
     * 设置面板：提前量（时+分）、重复提醒开关与间隔、运行中提醒、回车拦截。
     * 数字输入用"本地字符串态 + 失焦/回车时落库"的写法：
     * 否则用户删空输入框的瞬间就会被钳成 1，体验上像输入框在抢键盘。
     * @param {object} props settings 与 t
     */
    function SettingsPanel(props) {
      const settings = props.settings;
      const t = props.t;

      // 输入框用本地字符串态：允许中途是空串，失焦/回车时才落库钳制
      const [hoursText, setHoursText] = useState(String(Math.floor(settings.leadMin / 60)));
      const [minutesText, setMinutesText] = useState(String(settings.leadMin % 60));
      const [repeatText, setRepeatText] = useState(String(settings.repeatMin));

      // 被钳制或被别人改动时，同步显示值
      useEffect(() => {
        setHoursText(String(Math.floor(settings.leadMin / 60)));
        setMinutesText(String(settings.leadMin % 60));
      }, [settings.leadMin]);
      useEffect(() => {
        setRepeatText(String(settings.repeatMin));
      }, [settings.repeatMin]);

      /**
       * 把"时 + 分"两个输入框合成合法的提前量写回设置。
       * 允许用户先填 0 时 0 分——那会被夹到 1 分钟而不是报错，
       * 因为报错需要额外的提示区域，而夹紧只需要看一眼数字就知道结果。
       */
      function commitLead() {
        const hours = clamp(Math.floor(Number(hoursText) || 0), 0, 24);
        const minutes = clamp(Math.floor(Number(minutesText) || 0), 0, 59);
        const total = clamp(hours * 60 + minutes, 1, 1440);
        patchSettings({ leadMin: total });
      }

      /**
       * 写入重复间隔，上限取当前的提前量：
       * 需求明确要求"间隔不得大于提前量"，放这里钳制比在文案里警告更可靠。
       */
      function commitRepeat() {
        const minutes = clamp(Math.floor(Number(repeatText) || 0), 1, settings.leadMin);
        patchSettings({ repeatMin: minutes });
      }

      /**
       * 数字输入框的一个薄封装：统一外观、统一 testid、统一"回车即提交"。
       * @param {string} value 受控值（字符串态，允许中途为空）
       * @param {Function} onChange 输入时更新本地字符串
       * @param {Function} onBlur 失焦或回车时落库
       * @param {string} testId 供结构自测定位
       * @returns {object} React 元素
       */
      function numberInput(value, onChange, onBlur, testId) {
        return h('input', {
          type: 'number',
          className: 'dpg-num',
          value,
          min: 0,
          max: 999,
          'data-testid': testId,
          onChange: (event) => onChange(event.target.value),
          onBlur,
          onKeyDown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onBlur();
            }
          },
        });
      }

      /**
       * 一行"标签 + 自绘开关"。
       * 用 button + role="switch" 而不是 checkbox：宿主主题里没有现成的开关组件，
       * 而 button 能直接拿到键盘焦点与回车/空格激活，无障碍上不吃亏。
       * @param {string} label 左侧文案
       * @param {boolean} checked 当前状态
       * @param {Function} onToggle 切换回调
       * @param {string} testId 供结构自测定位
       * @returns {object} React 元素
       */
      function switchRow(label, checked, onToggle, testId) {
        return h('div', { className: 'dpg-row' },
          h('span', null, label),
          h('button', {
            type: 'button',
            className: 'dpg-switch',
            role: 'switch',
            'aria-checked': checked ? 'true' : 'false',
            'aria-label': label,
            'data-testid': testId,
            onClick: onToggle,
          }, h('span', { className: 'dpg-knob' })));
      }

      /**
       * 放假数据这一块：状态文字 + 「立即更新」按钮 + （失败时的）警示行。
       * 状态文字按来源分三种：内置表（从没联网成功）、已更新（缓存或刚拉到的）。
       * 失败不清空旧数据，所以这里只多显示一行提醒，状态文字仍然是上次成功的时间。
       * @returns {object} React 元素
       */
      function holidayRow() {
        const holi = props.holi || {
          source: 'builtin', busy: false, error: null, fetchedAt: 0, years: [],
        };
        const years = (holi.years && holi.years.length ? holi.years : [HOLIDAY_BUILTIN_YEAR]).join('、');
        const text = holi.source === 'builtin'
          ? t('holiBuiltin').replace('{years}', years)
          : t('holiUpdated').replace('{when}', formatUpdatedAt(holi.fetchedAt));
        return h('div', { className: 'dpg-col' },
          h('div', { className: 'dpg-row' },
            h('span', null, t('holiLabel')),
            h('span', { className: 'dpg-field' },
              h('span', {
                className: 'dpg-hint',
                'data-testid': 'peak-guard-holi-status',
              }, text),
              h('button', {
                type: 'button',
                className: 'dpg-btn dpg-btn-ghost',
                'data-testid': 'peak-guard-holi-refresh',
                disabled: !!holi.busy,
                onClick: () => {
                  // 手动更新：force=true 跳过 12 小时有效期；失败只在下面显示一行提示
                  refreshHolidays(true).catch(() => {});
                },
              }, holi.busy ? t('holiRefreshing') : t('holiRefresh')))),
          holi.error
            ? h('div', { className: 'dpg-hint dpg-hint-warn' }, t('holiFailed'))
            : null,
          h('div', { className: 'dpg-hint' }, t('holiHint')));
      }

      /**
       * 调试区：一行状态 + 四个强制档位 + 四个时钟按钮。
       * 只在 settings.debugMode 打开时渲染，因此对普通用户完全不可见；
       * 状态行显示的是"虚拟时间 + 当前判定"，方便对照卡片上的文案是否自洽。
       * @returns {object} React 元素
       */
      function debugSection() {
        const nowValue = props.now || nowMs();
        const tier = effectiveTier(nowValue);
        // 状态行故意把日期也带上：快进可能跨天，只看 HH:MM 会分不清是今天还是明天
        const tierText = tier === 'peak' ? t('debugTierPeak') : t('debugTierOff');
        // 强制档位按钮：active 表示当前生效的那一档，点击即切换
        const forceButton = (key, label, testId) => h('button', {
          type: 'button',
          className: 'dpg-btn dpg-btn-ghost' + (settings.forceTier === key ? ' dpg-btn-active' : ''),
          'data-testid': testId,
          'data-active': settings.forceTier === key ? 'true' : 'false',
          onClick: () => {
            patchSettings({ forceTier: key });
            setState({ now: nowMs() });      // 立刻刷新状态行，不用等下一次巡检
          },
        }, label);

        return h('div', { className: 'dpg-col dpg-debug' },
          h('div', { className: 'dpg-row' },
            h('span', null, t('debugNow')),
            h('span', { className: 'dpg-hint', 'data-testid': 'peak-guard-debug-now' },
              `${formatUpdatedAt(nowValue)} · ${tierText}`)),
          h('div', { className: 'dpg-row' },
            h('span', null, t('debugForceLabel')),
            h('span', { className: 'dpg-field dpg-wrap' },
              forceButton('auto', t('debugForceAuto'), 'peak-guard-force-auto'),
              forceButton('peak', t('debugForcePeak'), 'peak-guard-force-peak'),
              forceButton('offPeak', t('debugForceOff'), 'peak-guard-force-off'),
              forceButton('near', t('debugForceNear'), 'peak-guard-force-near'))),
          h('div', { className: 'dpg-row' },
            h('span', null, t('debugClockLabel')),
            h('span', { className: 'dpg-field dpg-wrap' },
              h('button', {
                type: 'button', className: 'dpg-btn dpg-btn-ghost',
                'data-testid': 'peak-guard-clock-1m',
                onClick: () => advanceClock(MIN_MS),
              }, '+1m'),
              h('button', {
                type: 'button', className: 'dpg-btn dpg-btn-ghost',
                'data-testid': 'peak-guard-clock-10m',
                onClick: () => advanceClock(10 * MIN_MS),
              }, '+10m'),
              h('button', {
                type: 'button', className: 'dpg-btn dpg-btn-ghost',
                'data-testid': 'peak-guard-clock-1h',
                onClick: () => advanceClock(60 * MIN_MS),
              }, '+1h'),
              h('button', {
                type: 'button', className: 'dpg-btn dpg-btn-ghost',
                'data-testid': 'peak-guard-clock-reset',
                onClick: () => resetClock(),
              }, t('debugClockReset')))),
          // 说明写在最后：先给控件、再给解释，符合设置页从上到下的阅读顺序
          h('div', { className: 'dpg-hint' }, t('debugHint')));
      }

      // 同一套控件在两个地方用：卡片里是深色小面板，设置页里是正常疏密度的偏好列表，
      // 靠 dpg-page 这个修饰类切换配色与间距，避免维护两份表单。
      return h('div', { className: props.variant === 'page' ? 'dpg-settings dpg-page' : 'dpg-settings' },
        h('div', { className: 'dpg-row' },
          h('span', null, t('leadLabel')),
          h('span', { className: 'dpg-field' },
            numberInput(hoursText, setHoursText, commitLead, 'peak-guard-lead-hours'),
            h('span', { className: 'dpg-unit' }, t('hourUnit')),
            numberInput(minutesText, setMinutesText, commitLead, 'peak-guard-lead-minutes'),
            h('span', { className: 'dpg-unit' }, t('minuteUnit')))),

        switchRow(t('repeatLabel'), settings.repeatEnabled, () => {
          patchSettings({ repeatEnabled: !settings.repeatEnabled });
        }, 'peak-guard-repeat-switch'),

        settings.repeatEnabled
          ? h('div', { className: 'dpg-row' },
              h('span', null, t('repeatEvery')),
              h('span', { className: 'dpg-field' },
                numberInput(repeatText, setRepeatText, commitRepeat, 'peak-guard-repeat-minutes'),
                h('span', { className: 'dpg-unit' }, t('minuteUnit'))))
          : null,

        switchRow(t('runningLabel'), settings.remindWhileRunning, () => {
          patchSettings({ remindWhileRunning: !settings.remindWhileRunning });
        }, 'peak-guard-running-switch'),

        switchRow(t('enterLabel'), settings.guardEnter, () => {
          patchSettings({ guardEnter: !settings.guardEnter });
        }, 'peak-guard-enter-switch'),

        // 放假安排：开关管"要不要联网"，右边那一行管"现在是什么状态、要不要手动拉一次"
        switchRow(t('holiAutoLabel'), settings.autoHoliday, () => {
          patchSettings({ autoHoliday: !settings.autoHoliday });
        }, 'peak-guard-holi-switch'),

        holidayRow(),

        // 调试模式是唯一会"改变判定结果"的开关，所以单独成段、并带一行说明；
      // 其余开关只影响提醒何时出现，不会让峰谷判定本身变样。

      // 调试模式放在正式设置之后、说明文字之前：
      // 位置靠下不打扰日常使用，打开后又能立刻看到下面冒出来的调试区。

      // 已暂停待发送：只有真的存了一条才出现，并提供「取消暂停」，免得用户忘了这回事。
        // 这一行同时充当"回执"：用户关掉卡片后仍能从设置里看到内容还没发出去，
        // 也能在反悔时一键取消，不必等它到点自动发走。时间只显示 HH:MM，
        // 跨天的情形极少（暂停最多等到下一个谷时开始），为了不撑破一行就不带日期。
        props.defer
          ? h('div', { className: 'dpg-col' },
              h('div', { className: 'dpg-row' },
                h('span', null, t('pendingLabel')),
                h('span', { className: 'dpg-field' },
                  h('span', { className: 'dpg-hint', 'data-testid': 'peak-guard-pending-when' },
                    t('pendingValue').replace('{when}', formatClock(props.defer.atMs))),
                  h('button', {
                    type: 'button',
                    className: 'dpg-btn dpg-btn-ghost',
                    'data-testid': 'peak-guard-pending-cancel',
                    onClick: cancelDefer,
                  }, t('pendingCancel')))))
          : null,

        // 调试模式：开关 + 强制档位 + 时钟快进，全部只在打开开关后出现
        switchRow(t('debugLabel'), settings.debugMode, () => {
          // 关掉时顺手把偏移清零，避免下次打开还在"未来"里
          if (settings.debugMode) resetClock();
          patchSettings({ debugMode: !settings.debugMode, forceTier: 'auto' });
        }, 'peak-guard-debug-switch'),

        // 关闭时不渲染调试区：普通用户永远只看到六个正式设置项
        settings.debugMode ? debugSection() : null,

        h('div', { className: 'dpg-hint' }, t('leadHint')),
        settings.repeatEnabled ? h('div', { className: 'dpg-hint' }, t('repeatHint')) : null);
    }

    /**
     * 设置页：把同一套控件放进「设置 → 峰时守卫」里，随时可以打开，不必等卡片。
     * 页面用宿主主题 token 着色，因此深浅两套主题下都能看清；卡片里那份仍用深色。
     * @param {object} props t
     */
    function SettingsPage(props) {
      const snapshot = useGuardState();
      const t = props.t;
      // 标题与说明由这一页自己给：settings.section 只负责把组件放进内容列，不额外加壳。
      // 表单部分直接复用卡片里那套控件，靠 variant='page' 换成主题配色。
      return h('div', { className: 'dpg-page-wrap', 'data-peak-guard': 'page' },
        h('h2', { className: 'dpg-page-title' }, t('settingsTitle')),
        h('p', { className: 'dpg-page-desc' }, t('pageDesc')),
        h(SettingsPanel, { settings: snapshot.settings, holi: snapshot.holi, defer: snapshot.defer, now: snapshot.now, t, variant: 'page' }),
        h('div', { className: 'dpg-page-hint' }, t('ruleText')));
    }

    /* ==================== 十一、确认卡（整帧浮层） ==================== */
    // 整帧浮层是唯一能"盖在输入卡上方又不会被裁剪"的位置，
    // 卡片自己开启 pointer-events，浮层其余部分保持 click-through，不挡正文操作。

    /**
     * 确认卡本体，挂在 shell.overlay 上（整帧浮层，不会被输入卡裁剪）。
     * 同一组件负责三件事：装全局监听、跑定时器、按状态画峰时卡/谷时提醒/设置面板。
     * 无卡片时返回 null，但监听与常驻定时器仍然保留——它们本来就该在没卡的时候待命。
     * @param {object} props t
     */
    function GuardOverlay(props) {
      const t = props.t;
      const snapshot = useGuardState();
      const hasDialog = snapshot.dialog !== null;

      // 监听挂在 document 的捕获阶段：这是唯一能稳定抢在 React 合成事件之前的位置。
      // 处理函数是模块级函数、内部读 state 而不是闭包捕获快照，
      // 所以这里不需要把它列进依赖，装一次就能一直用。
      // 全局监听只装一次；处理函数是模块级的，永远读最新 state
      useEffect(() => {
        document.addEventListener('click', onClickCapture, true);
        document.addEventListener('keydown', onKeyDownCapture, true);
        return () => {
          document.removeEventListener('click', onClickCapture, true);
          document.removeEventListener('keydown', onKeyDownCapture, true);
        };
      }, []);

      // 倒计时必须每秒动一次，否则"还剩 9h49m"会一直停在打开卡片那一刻；
      // 没卡的时候没有必要跑这个定时器，所以直接不装。
      // 有卡片时每秒刷新倒计时；收起后彻底停摆
      useEffect(() => {
        if (!hasDialog) return undefined;
        const id = window.setInterval(tick, 1000);
        return () => window.clearInterval(id);
      }, [hasDialog]);

      // 5 秒一次足够：重复提醒的粒度是分钟级，1 秒一次只是白烧 CPU。
      // 这个定时器与上面那个互补——上面管"卡在的时候刷新"，它管"没卡的时候该不该冒出来"。
      // 常驻巡检：到点收卡片、按间隔重复提醒
      useEffect(() => {
        const id = window.setInterval(tick, 5000);
        return () => window.clearInterval(id);
      }, []);

      const dialog = snapshot.dialog;
      if (!dialog) return null;

      // 设置视图：卡片原地切换，不丢 pending（用户改完设置仍可继续/返回）
      if (dialog.view === 'settings') {
        return h('div', {
          className: 'dpg-card',
          role: 'dialog',
          'aria-label': t('settingsTitle'),
          'data-peak-guard': 'settings',
        },
          h('div', { className: 'dpg-title' }, t('settingsTitle')),
          h(SettingsPanel, { settings: snapshot.settings, holi: snapshot.holi, defer: snapshot.defer, now: snapshot.now, t }),
          h('div', { className: 'dpg-hint' }, t('ruleText')),
          h('div', { className: 'dpg-actions' },
            h('span', { className: 'dpg-spacer' }),
            h('button', {
              type: 'button',
              className: 'dpg-btn dpg-btn-neutral',
              'data-testid': 'peak-guard-done',
              onClick: toggleSettingsView,
            }, t('doneLabel'))));
      }

      // 两种卡只差文案与按钮组，共用一个骨架：
      // 这里先算出标题与正文再统一渲染，避免三处 JSX 各写一遍 replace，
      // 也让 test-view.mjs 可以只断言文本、不必关心分支结构。
      // 峰时卡给"继续/返回"，谷时提醒只给"知道了"，免得用户在提醒上误触发送。
      const isPeakDialog = dialog.kind === 'peak';
      // 暂停后的两种告知卡：已暂停（等谷时自动发）/ 草稿属于别的会话
      const isDeferNotice = dialog.kind === 'deferred' || dialog.kind === 'deferred-elsewhere';
      const remain = dialog.atMs ? formatRemain(Math.max(0, dialog.atMs - snapshot.now)) : '';
      const title = isPeakDialog
        ? t('peakTitle')
        : isDeferNotice
          ? (dialog.kind === 'deferred' ? t('deferredTitle') : t('deferredElsewhereTitle'))
          : t('nearTitle').replace('{remain}', remain);
      const body = isPeakDialog
        ? t('peakBody').replace('{remain}', remain)
        : isDeferNotice
          ? (dialog.kind === 'deferred' ? t('deferredBody').replace('{remain}', remain) : t('deferredElsewhereBody'))
          : t('nearBody');

      return h('div', {
        className: 'dpg-card',
        role: isPeakDialog ? 'alertdialog' : 'status',
        'aria-live': 'polite',
        'aria-label': title,
        'data-peak-guard': dialog.kind,
        'data-peak-guard-source': dialog.source || '',
      },
        h('div', { className: 'dpg-head' },
          h('span', { className: 'dpg-dot', 'data-kind': dialog.kind }),
          h('div', { className: 'dpg-text' },
            h('div', { className: 'dpg-title' }, title),
            h('div', { className: 'dpg-body' }, body))),

        // 暂停单独占一行：文案长，和返回/继续挤一行会把两个短按钮压扁，
        // 而且它和「继续」是互斥语义（一个现在发、一个等谷时发），分开摆能降低误点概率。
        // 颜色用低饱和蓝而不是红/灰：既不是危险动作，也不该像次要操作。
        isPeakDialog
          ? h('div', { className: 'dpg-actions dpg-actions-pause' },
              h('button', {
                type: 'button',
                className: 'dpg-btn dpg-btn-pause',
                'data-testid': 'peak-guard-pause',
                title: t('pauseHint'),
                onClick: deferSend,
              }, t('pauseLabel')))
          : null,

        h('div', { className: 'dpg-actions' },
          h('button', {
            type: 'button',
            className: 'dpg-btn dpg-btn-ghost',
            'data-testid': 'peak-guard-settings',
            onClick: toggleSettingsView,
          }, t('settingsLabel')),
          h('span', { className: 'dpg-spacer' }),
          isPeakDialog
            ? h('button', {
                type: 'button',
                className: 'dpg-btn dpg-btn-neutral',
                'data-testid': 'peak-guard-back',
                onClick: dismissDialog,
              }, t('backLabel'))
            : null,
          isPeakDialog
            ? h('button', {
                type: 'button',
                className: 'dpg-btn dpg-btn-danger',
                'data-testid': 'peak-guard-continue',
                onClick: confirmSend,
              }, t('continueLabel'))
            : h('button', {
                type: 'button',
                className: 'dpg-btn dpg-btn-neutral',
                'data-testid': 'peak-guard-ok',
                onClick: dismissDialog,
              }, t('okLabel'))));
    }

    /* ==================== 十二、挂载 ==================== */
    // 装配顺序：词典 → 翻译函数 → 样式 → 三个槽位，后面两步都依赖前面两步的结果。
    // apply 只做装配：注册词典、取翻译函数、注入样式、注册两个槽位。
    // 这里不读 DOM、不判定时间，所有行为都在事件到来时才发生。
    // 三个槽位分别解决“总能打开设置”“拿到会话状态”“画出卡片”三件事。

    /**
     * 插件入口。
     * 顺序有讲究：先注册词典并取到 ui-conversation 的翻译函数（识别发送按钮要用它），
     * 再注入样式，最后注册三个槽位（设置页、输入卡探针、整帧浮层）。所有副作用都包在 ctx.effect 里并返回清理函数，
     * 保证插件被禁用或热重载时不会留下野样式、野监听。
     * @param {object} ctx 客户端插件上下文
     */
    function apply(ctx) {
      // 先注册词典，再取绑定函数：t() 在调用时按当前语言解析
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'peak-guard: locale');

      try {
        translateConversation = ctx.locale.bind(CONV_NS);
      } catch (error) {
        translateConversation = null;   // 语言包未就绪时退回结构判定
      }

      ctx.effect(injectStyles, 'peak-guard: styles');

      // 放假安排的自动更新：启动时补一次（缓存新鲜就只读缓存，不发请求），
      // 之后每 30 分钟看一眼是否过期（12 小时有效期），过期才真的去 CDN 取。
      // 请求只发生在"打开 DSH 或用户点立即更新"时，不随每次发送触发，也不带任何本地数据。
      ctx.effect(() => {
        const maybeRefresh = () => {
          if (!readState().settings.autoHoliday) return;   // 用户关了自动更新就彻底不联网
          refreshHolidays(false).catch(() => {});          // 失败已有 UI 提示，这里只吞掉 Promise
        };
        maybeRefresh();
        const timer = window.setInterval(maybeRefresh, HOLIDAY_CHECK_MS);
        return () => window.clearInterval(timer);
      }, 'peak-guard: holiday feed');

      // 设置页：随时可打开的正式入口（卡片里的「设置」只是顺手，不能当唯一入口）
      // 设置页放在 order 45：排在「记忆宫殿」「预设」之后、外部 MCP 之前，
      // 属于“与本机使用习惯相关的偏后位置”，不抢常用项的位置。

      // 导航项文案走 label：传函数时宿主每次投影都会重新读，切语言后不用重新注册。
      let pageLabel = '峰时守卫';
      try {
        const ownText = ctx.locale.bind(NS);
        if (typeof ownText === 'function') pageLabel = () => ownText('settingsTitle');
      } catch (error) {
        // 语言包还没就绪就用中文兜底，不影响页面本身
      }
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'peak-guard-settings',
        order: 45,
        label: pageLabel,
        locale: NS,
      }, SettingsPage));

      // 输入卡探针：session 槽位，拿得到 useInput / useSession / inputActions
      ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
        name: 'conversation.input.right',
        id: 'peak-guard-probe',
        order: 200,
        locale: NS,
      }, ComposerProbe));

      // 探针与卡片的 id 都以 peak-guard- 开头：槽位里重名会覆盖别人，前缀能保证不会撞车。
      // 整帧浮层：root 槽位，天然不被输入卡裁剪；卡片自己开启 pointer-events
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'peak-guard-dialog',
        order: 400,
        locale: NS,
      }, GuardOverlay));
    }

    // 自测出口：时间判定与门禁是纯函数，挂到 window 上便于用脚本复核（不影响插件行为）
    if (typeof window !== 'undefined') {
      window.__dshPeakGuardDebug = {
        isPeak,
        // 调试模式：测试可以快进时钟、强制档位，再断言 gateAt 的行为
        nowMs,
        effectiveTier,
        advanceClock,
        resetClock,
        debugOffset: () => debugOffsetMs,
        nextSwitch,
        formatRemain,
        gateAt,
        blocks,
        readState,
        normalizeSettings,
        openDialog,
        dismissDialog,
        toggleSettingsView,
        patchSettings,
        // 放假数据相关：单测用 isWorkday 覆盖调休，用 refreshHolidays 走一遍网络路径
        isWorkday,
        refreshHolidays,
        holidayInfo: () => holidayInfo,
        // 按钮识别与点击诊断：clickTrace 记录最近一次点击为什么命中/没命中
        formatClock,
        findSubmitButton,
        conversationLabels,
        looksLikeSend,
        clickTrace,
        // 暂停到谷时：单测直接调这三个函数验证"存/发/取消"三条路径
        deferSend,
        cancelDefer,
        trySendDeferred,
        formatClock,
        // 单测专用：直接改 store（正常代码走组件上报，不需要它）。
        // 仅用于 jsdom 之外的无浏览器单测：那里没有槽位、拿不到 useInput，
        // 又想验证"到点自动发送"的完整链路，于是允许测试直接摆出场景。
        __test: { setState },
        // 预览入口：手动构造一个假的 atMs 打开卡片，不发消息、不改设置，
        // 用于在非峰时段检查配色与文案，调完直接 Esc 关掉。
        // 预览：不等到真的峰时也能看卡片样式，preview('peak') / preview('near')
        preview: (kind) => {
          const now = Date.now();
          const offset = (kind === 'near' ? 45 : 49) * MIN_MS;
          openDialog({ kind: kind === 'near' ? 'near' : 'peak', atMs: now + offset }, 'preview');
          return state.dialog;
        },
        components: { GuardOverlay, SettingsPanel, SettingsPage, ComposerProbe },
      };
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    };
  },
});
