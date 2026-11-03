/**
 * 合并转发搜索 · 渲染层（界面 + 与 QQ 通信）
 * ------------------------------------------------------------------
 * 这是插件里最大的一块，按顺序分成 8 段，从上往下读就行：
 *
 *   1. 环境与工具函数
 *   2. 主题跟随（自动识别 QQ 深色/浅色）
 *   3. 跟 QQ 要数据的封装（kernel）
 *   4. 内容补全队列（把卡片"里面"的文字拉回来）
 *   5. 弹窗界面
 *   6. 搜索逻辑
 *   7. 详情面板
 *   8. 设置页 & 启动
 *
 * 设计原则：所有可能失败的地方都要"兜住"，宁可少一个功能，也不能让 QQ 崩。
 */

/* ==================================================================
 * 1. 环境与工具函数
 * ================================================================== */

const SLUG = 'forward-search';

/** preload 暴露出来的接口。拿不到说明桥接层出问题了，后面会给出提示 */
let bridge = typeof window !== 'undefined' ? window.forwardSearch : null;

/** 诊断日志：写到主进程的 debug.log，真机排障用。任何阶段错了都能留痕。 */
function diag(msg) {
    try {
        if (bridge && bridge.log) bridge.log(msg);
    } catch (_) { /* 日志失败无所谓 */ }
}

if (typeof window !== 'undefined') {
    // QQ 自己是 Vue + Web Components，偶尔会抛一些它自己的异常（local://root/... 那些）。
    // 那些和我们无关，记进来只会把日志淹掉，所以只留来源是我们插件的。
    const isOurs = (file) => {
        const f = String(file || '');
        return f.indexOf('forward-search') >= 0 || f.indexOf('plugins/forward-search') >= 0;
    };

    window.addEventListener('error', (e) => {
        if (!isOurs(e && e.filename)) return;
        diag(`[renderer:error] ${(e && e.message) || e} @ ${(e && e.filename) || '?'}:${(e && e.lineno) || '?'}`);
    });
    window.addEventListener('unhandledrejection', (e) => {
        const reason = e && e.reason;
        const stack = String((reason && (reason.stack || reason.message)) || reason || '');
        if (!isOurs(stack)) return;
        diag(`[renderer:reject] ${stack}`);
    });
    diag('[renderer] 模块已加载，桥接=' + (bridge ? 'ok' : 'missing'));
}

const STATE = {
    open: false,
    mode: 'search',       // search | detail | onboard
    query: '',
    results: [],
    activeIndex: 0,
    searching: false,
    error: '',
    config: null,
    currentCard: null,
    // 正在聊天里找卡片时不重复触发（滚动 + 查找是异步的，手快会打架）
    locating: false
};

/** 把 HTML 特殊字符转义，防止卡片里的文字把界面结构搞坏 */
function esc(text) {
    return String(text == null ? '' : text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** 把命中的关键词包上 <em>，用于高亮 */
function highlight(text, query) {
    const safe = esc(text);
    if (!query) return safe;
    const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    let out = safe;
    for (const t of terms) {
        // 用不区分大小写的替换，同时对正则元字符转义
        const pattern = new RegExp('(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
        out = out.replace(pattern, '<em>$1</em>');
    }
    return out;
}

/** 时间戳（秒）→ 人看得懂的格式 */
function formatTime(sec) {
    if (!sec) return '';
    const d = new Date(sec * 1000);
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const sameDay =
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate();
    if (sameDay) return hm;
    if (d.getFullYear() === now.getFullYear()) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 防抖：输入停下来之后才真正去搜 */
function debounce(fn, wait) {
    let timer = null;
    return function (...args) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            fn.apply(this, args);
        }, wait);
    };
}

/** 睡一会儿（补全队列限速用） */
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/** 统一的日志前缀，方便在 QQ 日志里 grep */
function log(...args) {
    console.log('[forward-search]', ...args);
}

/* ==================================================================
 * 2. 主题跟随
 * ------------------------------------------------------------------
 * 配置项 theme 有三种取值：
 *   system（默认）  跟随系统深浅色，系统改了就跟着变
 *   light / dark   用户手动锁定，忽略系统和 QQ
 *   auto           旧版行为：看 QQ 自己页面的底色（保留兼容）
 *
 * 为什么默认用 system 而不是看 QQ 的底色：
 * 读 QQ 界面颜色虽然"看起来更贴合"，但它依赖 QQ 的 DOM 结构，
 * 每次 QQ 改版都可能失效；而系统深浅色是浏览器原生告诉我们的，稳定得多。
 * ================================================================== */

let currentTheme = 'light';

/** 系统是不是深色。拿不到返回 null（老版本 Electron 可能没有 matchMedia） */
function systemPrefersDark() {
    try {
        if (!window.matchMedia) return null;
        return !!window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch (_) {
        return null;
    }
}

/** 把 CSS 颜色字符串解析成 [r,g,b,a]，解析不了返回 null */
function parseColor(str) {
    if (!str) return null;
    const m = String(str).match(/[\d.]+/g);
    if (!m || m.length < 3) return null;
    const r = Number(m[0]);
    const g = Number(m[1]);
    const b = Number(m[2]);
    const a = m.length >= 4 ? Number(m[3]) : 1;
    if (![r, g, b].every((n) => isFinite(n))) return null;
    return [r, g, b, isFinite(a) ? a : 1];
}

/** 取某个元素自身背景色的亮度；全透明或没有颜色返回 null */
function luminanceOf(el) {
    const c = parseColor(getComputedStyle(el).backgroundColor);
    if (!c || c[3] <= 0.1) return null; // 透明 = 这层没在画底色
    return (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;
}

/** 从这个元素出发往上找第一个"真正在画底色"的层，返回 'light' / 'dark' / null */
function themeFrom(el) {
    let cur = el;
    let depth = 0;
    while (cur && depth < 12) {
        const lum = luminanceOf(cur);
        if (lum !== null) return lum < 0.5 ? 'dark' : 'light';
        cur = cur.parentElement;
        depth += 1;
    }
    return null;
}

function computeTheme() {
    try {
        const mode = (STATE.config && STATE.config.theme) || 'system';

        // 手动锁定优先级最高
        if (mode === 'light' || mode === 'dark') return mode;

        // 跟随系统：auto 是历史写法，和 system 同义，都先看系统深浅色偏好；
        // 系统偏好读不到（老系统/被禁用）才退回去看 QQ 自己的底色
        const dark = systemPrefersDark();
        if (dark !== null) return dark ? 'dark' : 'light';
        return detectThemeFromDom();
    } catch (_) {
        return 'light';
    }
}

/** 通过 QQ 界面的实际底色判断深浅（依赖 DOM 结构，只作为兜底） */
function detectThemeFromDom() {
    try {
        if (!document.body) return 'light';

        // 1) 从 body 往上找（最常见：body 或 html 上就写着底色）
        //
        // 但 QQ 的 body 背景常常是 rgba(0,0,0,0)（完全透明），
        // 直接把 rgb 取出来算亮度会得到纯黑 → 浅色主题下弹窗被画成深色。
        // 所以这里先看 alpha，透明就继续往上。
        let t = themeFrom(document.body);
        if (t) return t;

        // 2) QQ 的底色往往画在 body 的子容器上（#app 之类），往上是找不到的。
        //    取左上角那个点所在的元素往上找，等于问"这块地方实际是什么颜色"。
        try {
            if (document.elementFromPoint) {
                const hit = document.elementFromPoint(2, 2);
                // 别让弹窗自己的遮罩把自己算进去，否则会越套越深
                if (hit && !(hit.closest && hit.closest('.fs-root'))) {
                    t = themeFrom(hit);
                    if (t) return t;
                }
            }
        } catch (_) {
            /* 取不到就继续往下面兜底 */
        }

        // 3) 兜底：扫 body 的直接子元素
        const kids = document.body.children || [];
        for (let i = 0; i < kids.length && i < 8; i += 1) {
            t = themeFrom(kids[i]);
            if (t) return t;
        }

        // 4) 实在判断不出来，退回系统的深浅色偏好
        const dark = systemPrefersDark();
        if (dark !== null) return dark ? 'dark' : 'light';
        return 'light';
    } catch (_) {
        return 'light';
    }
}

/** 把主题打到页面上所有 .fs-root 上（弹窗和设置页可能同时存在） */
function applyTheme() {
    const next = computeTheme();
    if (next !== currentTheme) log('主题切换为', next);
    currentTheme = next;
    const roots = document.querySelectorAll('.fs-root');
    for (let i = 0; i < roots.length; i += 1) {
        // 入口按钮挂在 QQ 自己的顶栏上，得跟 QQ 的底色走，不能跟弹窗主题走
        if (roots[i].classList.contains('fs-launcher') || roots[i].classList.contains('fs-float')) continue;
        roots[i].setAttribute('data-fs-theme', next);
    }
    const launcher = document.querySelector('.fs-launcher');
    if (launcher) launcher.setAttribute('data-fs-theme', detectThemeFromDom());
    // 悬浮按钮浮在 QQ 内容上，同理跟 QQ 底色走
    const floatBtn = document.querySelector('.fs-float');
    if (floatBtn) floatBtn.setAttribute('data-fs-theme', detectThemeFromDom());
}

function watchTheme() {
    // 1) 系统深浅色变化 —— "跟随系统"模式靠它
    try {
        if (window.matchMedia) {
            const mq = window.matchMedia('(prefers-color-scheme: dark)');
            const onChange = () => applyTheme();
            if (mq.addEventListener) mq.addEventListener('change', onChange);
            else if (mq.addListener) mq.addListener(onChange); // 老版本 Electron 只有这个
        }
    } catch (_) {
        /* 没有 matchMedia 也不影响，下面还有 DOM 监听 */
    }

    // 2) QQ 自己切主题 —— auto 模式和兜底逻辑靠它
    try {
        const observer = new MutationObserver(() => applyTheme());
        observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
        // 有些版本不改 body，改的是 html，顺带也看一眼
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    } catch (_) {
        /* 监听失败就只在打开弹窗时判断一次，也能用 */
    }
}

/* ==================================================================
 * 3. 跟 QQ 要数据
 * ------------------------------------------------------------------
 * 说明一个很现实的问题：QQ 没有对外公开"给我某条合并转发的全部内容"这种接口，
 * 这些方法名和参数是社区长期摸索出来的，不同版本可能微妙变化。
 *
 * 所以这里的策略是：
 *   a) 同一个操作准备几种可能的调用写法，挨个试，哪个能返回东西就用哪个
 *   b) 拿到返回后不假设结构，而是"深度遍历找长得像消息的东西"
 *   c) 全都失败就安静地降级，不弹错、不崩
 *
 * 这样即使 QQ 改版，最多是"内容补全暂时不可用"，基础搜索仍然正常。
 * ================================================================== */

/** 把 QQ 返回里所有"像消息"的对象都捞出来（带 msgId 和 elements 的） */
function collectMessages(node, out, depth) {
    if (!node || typeof node !== 'object' || depth > 6) return out;
    if (Array.isArray(node)) {
        for (const item of node) collectMessages(item, out, depth + 1);
        return out;
    }
    if (node.msgId && Array.isArray(node.elements)) {
        out.push(node);
    }
    for (const key of Object.keys(node)) {
        const v = node[key];
        if (v && typeof v === 'object') collectMessages(v, out, depth + 1);
    }
    return out;
}

/** 调一次 QQ 接口。返回 null 表示这次没成功。 */
async function callKernel(cmdName, payload, awaitMode) {
    if (!bridge || !bridge.nativeCall) return null;
    try {
        return await bridge.nativeCall(cmdName, payload, awaitMode, 5000);
    } catch (err) {
        log('调用失败', cmdName, err);
        return null;
    }
}

/**
 * 用几种常见写法去请求同一个能力，返回第一个成功的结果。
 *
 * 关键点是 budgetMs：如果没有总时间预算，五种写法各自超时叠加起来
 * 会让界面卡住半分钟，这绝对不能接受。所以这里给一个总预算，
 * 超了就放弃剩下的尝试，直接走降级。
 *
 * @param {Array} tries [{cmdName, payload, awaitMode}]
 * @param {number} budgetMs 总预算
 */
async function callKernelAny(tries, budgetMs = 11000) {
    const start = Date.now();
    for (const t of tries) {
        if (Date.now() - start > budgetMs) break;
        const res = await callKernel(t.cmdName, t.payload, t.awaitMode);
        if (!res) continue;
        const msgs = collectMessages(res, [], 0);
        if (msgs.length > 0) return { res, msgs };
        // 返回了但没解析出消息：把原始形状记下来，不然只能瞎猜
        try {
            diag(`[kernel] ${t.cmdName} 有返回但无消息：${JSON.stringify(res).slice(0, 400)}`);
        } catch (_) {
            /* 序列化失败就算了 */
        }
    }
    return null;
}

/** 构造 QQ 接口要的会话对象 */
function peerOf(card) {
    return {
        chatType: card.chatType || 2,
        peerUid: card.peerUid || '',
        guildId: '',
        name: card.peerName || ''
    };
}

/**
 * 拉取一张卡片"里面"的消息。
 * @param {object} card
 * @param {number} budgetMs 总时间预算，用户正在等的情况下给少一点
 * @returns {Promise<Array|null>} 成功返回子消息数组，失败返回 null
 */
async function fetchCardInner(card, budgetMs = 11000) {
    if (!card || !card.msgId) return null;
    const start = Date.now();
    const peer = peerOf(card);
    const resid = card.resid || '';

    const tries = [
        // 卡片里带着 resid，很多版本服务端要的是它，不是外层消息 ID
        { label: 'getMultiMsg resid', cmdName: 'nodeIKernelMsgService/getMultiMsg', payload: [{ peer, msgId: resid }, null], awaitMode: true },
        { label: 'getMultiMsg resid 位置参数', cmdName: 'nodeIKernelMsgService/getMultiMsg', payload: [peer, resid, null], awaitMode: true },
        { label: 'getMultiMsg msgId', cmdName: 'nodeIKernelMsgService/getMultiMsg', payload: [{ peer, msgId: card.msgId }, null], awaitMode: true },
        { label: 'getMultiMsg msgId 位置参数', cmdName: 'nodeIKernelMsgService/getMultiMsg', payload: [peer, card.msgId, null], awaitMode: true },
        // 退而求其次：只把外层消息拿回来，它可能自带 records
        { label: 'IncludeSelf 外层消息', cmdName: 'nodeIKernelMsgService/getMsgsIncludeSelf', payload: [{ peer, msgId: card.msgId, cnt: 1, queryOrder: true }, null], awaitMode: true }
    ];

    let hitMsgs = null;
    for (let i = 0; i < tries.length; i++) {
        const t = tries[i];
        if (Date.now() - start > budgetMs) break;
        const res = await callKernel(t.cmdName, t.payload, t.awaitMode);
        const msgs = res ? collectMessages(res, [], 0) : [];
        diag(`[inner] ${i + 1}.${t.label} → ${res ? res.__statue || 'ok' : 'null'} / ${msgs.length} 条`);
        if (msgs.length > 0) {
            hitMsgs = msgs;
            break;
        }
    }
    if (!hitMsgs) return null;

    // 只拿回"卡片自己"不算拿到内容：它里面还是那张卡，没有内部消息
    if (hitMsgs.length === 1 && (hitMsgs[0].elements || []).some((el) => el && el.multiForwardMsgElement)) {
        diag('[inner] 只拿回卡片本身，判定为失败');
        return null;
    }

    const hit = { msgs: hitMsgs };

    // 从返回的消息里，把真正属于"卡片内部"的内容挑出来
    const record = requireRecordParser();
    const inner = [];
    for (const msg of hit.msgs) {
        // 如果这条就是卡片本身，并且它自带 records，直接解析
        const fromRecords = record ? record.parseInnerRecords(msg.records) : [];
        if (fromRecords.length > 0) {
            for (const m of fromRecords) inner.push(m);
            continue;
        }
        // 否则把这条当成卡片里的一条子消息
        if (record) {
            const text = record.messageToText(msg);
            if (text) {
                inner.push({
                    name:
                        msg.sendMemberName ||
                        msg.sendNickName ||
                        msg.senderName ||
                        msg.peerName ||
                        '未知',
                    time: record.normalizeTime(msg.msgTime),
                    text: text.slice(0, 1500)
                });
            }
        }
    }

    // 去重（同一段话重复出现多半是重复抓取）
    const unique = [];
    const seen = new Set();
    for (const m of inner) {
        const key = m.name + '|' + m.text;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(m);
    }

    return unique.length > 0 ? unique : null;
}

/**
 * 渲染层拿不到 CommonJS 的 record.js，这里放一个极简版解析器。
 * （主进程和 preload 用的是完整版，界面层只需要最基础的文本提取）
 */
let _recordParser = null;
function requireRecordParser() {
    if (_recordParser) return _recordParser;
    _recordParser = {
        normalizeTime(value) {
            const n = Number(value);
            if (!Number.isFinite(n) || n <= 0) return 0;
            return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
        },
        /**
         * 9.9.31 的合并转发卡片：elementType=16 的 multiForwardMsgElement，
         * xmlContent 里存的是 XML。规则与 core/record.js 里那份保持一致
         * （沙箱里 require 不到本地模块，这里只能各存一份，改的时候两边都要动）。
         */
        parseMultiForwardElement(el) {
            if (!el || typeof el !== 'object' || !el.multiForwardMsgElement) return null;
            const node = el.multiForwardMsgElement;
            const xml = typeof node.xmlContent === 'string' ? node.xmlContent : '';
            if (!xml) return null;
            if (xml.indexOf('viewMultiMsg') === -1 && xml.indexOf('m_resid') === -1) return null;

            const unescape = (t) =>
                String(t || '')
                    .replace(/&lt;/g, '<')
                    .replace(/&gt;/g, '>')
                    .replace(/&quot;/g, '"')
                    .replace(/&#39;/g, "'")
                    .replace(/&amp;/g, '&');

            const attr = (name) => {
                const m = xml.match(new RegExp(`${name}="([^"]*)"`));
                return m ? m[1] : '';
            };

            const titles = [];
            const re = /<title[^>]*>([\s\S]*?)<\/title>/g;
            let m;
            while ((m = re.exec(xml)) !== null) titles.push(unescape(m[1].trim()));

            const sum = xml.match(/<summary[^>]*>([\s\S]*?)<\/summary>/);
            const summary = sum ? unescape(sum[1].trim()) : '';
            const source = xml.match(/<source[^>]*name="([^"]*)"/);
            const countMatch = summary.match(/(\d+)\s*条/);

            return {
                title: String(titles[0] || '聊天记录').slice(0, 60),
                preview: String(titles.slice(1).join(' / ') || (source ? unescape(source[1]) : '')).slice(0, 300),
                summary: summary.slice(0, 120),
                resid: String(node.resId || attr('m_resid') || ''),
                fileName: String(node.fileName || attr('m_fileName') || ''),
                count: (countMatch ? parseInt(countMatch[1], 10) : 0) || parseInt(attr('tSum'), 10) || 0
            };
        },
        parseInnerRecords(records) {
            if (!Array.isArray(records)) return [];
            const out = [];
            for (const rec of records) {
                const msg = rec && rec.message ? rec.message : rec;
                if (!msg || !Array.isArray(msg.elements)) continue;
                const text = this.messageToText(msg);
                if (!text) continue;
                out.push({
                    name: msg.sendMemberName || msg.sendNickName || msg.senderName || '未知',
                    time: this.normalizeTime(msg.msgTime),
                    text: text.slice(0, 1500)
                });
            }
            return out;
        },
        messageToText(msg) {
            if (!msg || !Array.isArray(msg.elements)) return '';
            const parts = [];
            for (const el of msg.elements) {
                if (!el) continue;
                if (el.textElement) parts.push(el.textElement.content || '');
                else if (el.picElement) parts.push('[图片]');
                else if (el.fileElement) parts.push('[文件] ' + (el.fileElement.fileName || ''));
                else if (el.pttElement) parts.push('[语音]');
                else if (el.videoElement) parts.push('[视频]');
                else if (el.faceElement) parts.push(el.faceElement.faceText || '[表情]');
                else if (el.arkElement) parts.push('[卡片]');
            }
            return parts.join(' ').replace(/\s+/g, ' ').trim();
        }
    };
    return _recordParser;
}

/* ==================================================================
 * 4. 内容补全队列
 * ------------------------------------------------------------------
 * 这是唯一会主动"联网"的部分，所以做得非常保守：
 *   - 默认关闭，必须用户明确同意才跑
 *   - 一次只处理一条，两条之间强制等待（带随机浮动）
 *   - 随时可以暂停，进度存在内存里，界面能看到
 * ================================================================== */

const crawler = {
    running: false,
    paused: false,
    total: 0,
    done: 0,
    failed: 0,
    lastError: '',
    _stop: false
};

async function runCrawl() {
    if (crawler.running) return;
    if (!STATE.config || !STATE.config.contentMode) {
        toast('当前是"仅本地模式"，请先在设置里打开内容补全');
        return;
    }
    if (!bridge) {
        toast('桥接层未加载，无法补全');
        return;
    }

    crawler.running = true;
    crawler.paused = false;
    crawler._stop = false;
    crawler.done = 0;
    crawler.failed = 0;
    crawler.lastError = '';
    renderCrawlStatus();

    const interval = Math.max(600, Number(STATE.config.crawlIntervalMs) || 1600);
    const jitter = Math.max(0, Number(STATE.config.crawlJitterMs) || 700);

    try {
        // 分批取，边跑边存，QQ 关掉也不会白跑
        for (let round = 0; round < 200; round++) {
            if (crawler._stop) break;
            while (crawler.paused) {
                await sleep(400);
                if (crawler._stop) break;
            }
            if (crawler._stop) break;

            const batch = await bridge.pending(60, {});
            const list = (batch && batch.ok ? batch.data : []) || [];
            if (list.length === 0) break;
            crawler.total = crawler.done + list.length;

            for (const card of list) {
                if (crawler._stop) break;
                while (crawler.paused) {
                    await sleep(400);
                    if (crawler._stop) break;
                }
                if (crawler._stop) break;

                renderCrawlStatus();
                let inner = null;
                try {
                    inner = await fetchCardInner(card);
                } catch (err) {
                    crawler.lastError = String(err && err.message ? err.message : err);
                }

                if (inner && inner.length > 0) {
                    await bridge.setInner(card.id, inner, 1);
                    crawler.done++;
                } else {
                    await bridge.setInner(card.id, [], 2);
                    crawler.failed++;
                }

                // 限速：固定间隔 + 随机浮动，别让请求节奏显得太机器
                const wait = interval + Math.floor(Math.random() * jitter);
                await sleep(wait);
            }
        }
    } finally {
        crawler.running = false;
        renderCrawlStatus();
        try {
            if (bridge) await bridge.compact();
        } catch (_) {
            /* 压缩失败无所谓 */
        }
    }
}

/**
 * 历史扫描：把会话的历史消息过一遍，把里面的合并转发卡片都收进来。
 *
 * 真机摸出来的两条硬规则（9.9.31）：
 *   1. 只有"QQ 本地缓存过"的会话才有消息 —— 也就是你打开过的那些聊天。
 *      没打开过的会话一律返回空列表，不是接口坏了，是本地确实没有。
 *   2. 取消息要用"对象参数 + 同 callbackId 应答"这种写法：
 *      `[{ peer, msgId, cnt, queryOrder }, null]`。
 *      位置参数（peer, msgId, cnt, queryOrder）会被直接拒掉（promiseStatue=fail），
 *      等 onMsgInfoListUpdate 事件则永远等不到。
 */
async function scanHistory(limitPerPeer = 200) {
    if (!bridge) return;
    if (!bridge.nativeCall) {
        toast('桥接层不支持直接调用，无法扫描');
        return;
    }
    if (!STATE.config || !STATE.config.contentMode) {
        toast('扫描历史需要先打开内容补全模式');
        return;
    }

    crawler.running = true;
    crawler.paused = false;
    crawler._stop = false;
    crawler.done = 0;
    crawler.failed = 0;
    renderCrawlStatus();

    try {
        const peers = await listPeers();
        if (!peers.length) {
            toast('没能取到会话列表，无法扫描');
            return;
        }

        // 当前打开的会话排最前：它的消息一定在本地缓存里，能立刻出结果
        let active = null;
        try {
            const r = bridge.lastPeer ? await bridge.lastPeer() : null;
            active = r && r.ok ? r.data : r;
        } catch (_) {
            active = null;
        }
        const ordered = [];
        if (active && active.peerUid) ordered.push(active);
        for (const p of peers) {
            if (active && p.peerUid === active.peerUid) continue;
            ordered.push(p);
        }

        diag(`[scan] 开始，会话 ${ordered.length} 个，最近活跃=${active ? active.peerUid : '未知'}`);

        const interval = Math.max(400, Number(STATE.config.crawlIntervalMs) || 1600);
        let cachedPeers = 0;

        for (const peer of ordered) {
            if (crawler._stop) break;
            let anchor = '0';
            let fetched = 0;
            let page = 0;
            let peerCards = 0;

            while (fetched < limitPerPeer && !crawler._stop) {
                const res = await bridge.nativeCall(
                    'nodeIKernelMsgService/getMsgsIncludeSelf',
                    [{ peer, msgId: anchor, cnt: 20, queryOrder: true }, null],
                    true,
                    4000
                );
                const msgs = res ? collectMessages(res, [], 0) : [];

                page++;
                if (msgs.length === 0) break;

                const cards = [];
                for (const msg of msgs) {
                    const card = toCard(msg, peer);
                    if (card) cards.push(card);
                }
                if (cards.length > 0) await bridge.upsert(cards);

                peerCards += cards.length;
                fetched += msgs.length;
                crawler.done += cards.length;
                renderCrawlStatus();

                // 下一页的锚点：这一页最后一条
                const ids = msgs.map((m) => String(m.msgId || '')).filter(Boolean);
                const nextAnchor = ids[ids.length - 1];
                if (!nextAnchor || nextAnchor === anchor) break;
                anchor = nextAnchor;

                await sleep(interval);
            }

            if (fetched > 0) {
                cachedPeers++;
                diag(`[scan] ${peer.name || peer.peerUid} 读到 ${fetched} 条，卡片 ${peerCards} 张`);
            }
        }

        diag(`[scan] 结束：有缓存的会话 ${cachedPeers} 个，共收录 ${crawler.done} 张卡片`);

        if (crawler.done === 0) {
            toast(cachedPeers > 0 ? '这些会话里没有合并转发卡片' : '本地没有缓存消息，先打开几个群再扫描');
        }
    } finally {
        crawler.running = false;
        renderCrawlStatus();
        refreshStats();
    }
}

/** 取会话列表：优先用旁听到的缓存，缓存为空才去问 QQ */
async function listPeers() {
    // QQ 启动时会把最近联系人和群列表推一遍，主进程顺手存了下来。
    // 这条路不需要额外请求，也不依赖接口名（9.9.31 上事件叫 onRecentContactListChangedVer2）。
    try {
        const cached = bridge && bridge.peers ? await bridge.peers() : null;
        const list = (cached && cached.ok ? cached.data : cached) || [];
        if (Array.isArray(list) && list.length > 0) {
            diag(`[scan] 用缓存里的 ${list.length} 个会话`);
            return list;
        }
    } catch (err) {
        log('读会话缓存失败', err);
    }

    const tries = [
        {
            cmdName: 'nodeIKernelRecentContactService/getRecentContactList',
            payload: [{ count: 200 }],
            awaitMode: ['nodeIKernelRecentContactListener/onRecentContactListChangedVer2',
                'nodeIKernelRecentContactListener/onRecentContactListChanged']
        },
        {
            cmdName: 'nodeIKernelRecentContactService/getRecentContactList',
            payload: [{ count: 200 }, null],
            awaitMode: ['nodeIKernelRecentContactListener/onRecentContactListChangedVer2',
                'nodeIKernelRecentContactListener/onRecentContactListChanged']
        },
        { cmdName: 'nodeIKernelRecentContactService/getRecentContactList', payload: [], awaitMode: true }
    ];

    for (let i = 0; i < tries.length; i++) {
        const t = tries[i];
        const res = await callKernel(t.cmdName, t.payload, t.awaitMode);
        diag(`[scan] 取会话列表 写法${i + 1} ${res ? '有返回 ' + Object.keys(res).slice(0, 6).join(',') : '空'}`);
        if (res) {
            try {
                diag(`[scan] 原始 ${JSON.stringify(res).slice(0, 1200)}`);
            } catch (_) {
                /* 转不了就算了 */
            }
        }
        if (!res) continue;
        const out = [];
        const walk = (node, depth) => {
            if (!node || typeof node !== 'object' || depth > 6) return;
            if (Array.isArray(node)) {
                node.forEach((n) => walk(n, depth + 1));
                return;
            }
            if (node.peerUid && (node.chatType !== undefined || node.peerType !== undefined)) {
                const name = node.peerName || node.remark || node.sendMemberName || '';
                const uid = node.peerUid;
                out.push({
                    chatType: Number(node.chatType || node.peerType || 2),
                    peerUid: uid,
                    guildId: '',
                    name: name
                });
                if (name) out[out.length - 1].__name = name;
            }
            Object.values(node).forEach((v) => {
                if (v && typeof v === 'object') walk(v, depth + 1);
            });
        };
        walk(res, 0);
        if (out.length > 0) {
            // 去重
            const seen = new Set();
            return out.filter((p) => {
                const k = p.chatType + ':' + p.peerUid;
                if (seen.has(k)) return false;
                seen.add(k);
                return true;
            });
        }
    }
    return [];
}

/** 把一条消息尝试转成卡片（界面层用的轻量版，实际解析在主进程/preload） */
function toCard(msg, peer) {
    if (!msg || !Array.isArray(msg.elements)) return null;
    const parser = requireRecordParser();
    for (const el of msg.elements) {
        // 先认新版 multiForwardMsgElement（XML），再退回老版 arkElement（JSON）
        let card = parser.parseMultiForwardElement(el);
        if (!card && el && el.arkElement) {
            const raw = el.arkElement.bytesData;
            if (typeof raw === 'string' && raw.indexOf('multimsg') !== -1) {
                try {
                    const json = JSON.parse(raw);
                    const detail = (json.meta && json.meta.detail) || {};
                    const resid0 = detail.m_resid || detail.resid || '';
                    let title = '';
                    if (Array.isArray(detail.news) && detail.news[0]) title = detail.news[0].text || '';
                    else if (detail.news && typeof detail.news === 'object') title = detail.news.text || '';
                    if (resid0) {
                        card = {
                            title: title || '聊天记录',
                            preview: detail.source || '',
                            summary: detail.summary || '',
                            resid: resid0,
                            fileName: detail.m_fileName || '',
                            count: parseInt(String(detail.summary || '').replace(/\D/g, ''), 10) || 0
                        };
                    }
                } catch (_) {
                    /* 解析失败就换下一个元素 */
                }
            }
        }
        if (!card || !card.resid) continue;

        return {
            id: `${peer.chatType}:${peer.peerUid}:${msg.msgId}`,
            chatType: peer.chatType,
            peerUid: peer.peerUid,
            peerName: peer.__name || peer.name || peer.peerUid,
            msgId: String(msg.msgId || ''),
            msgSeq: String(msg.msgSeq || ''),
            msgTime: parser.normalizeTime(msg.msgTime),
            senderName: msg.sendMemberName || msg.sendNickName || '',
            title: card.title || '聊天记录',
            preview: card.preview || '',
            count: card.count || 0,
            resid: card.resid,
            fileName: card.fileName || '',
            innerState: 0,
            inner: []
        };
    }
    return null;
}

/* ==================================================================
 * 5. 弹窗界面
 * ================================================================== */

let ui = null;

async function injectStyleOnce() {
    if (document.getElementById('fs-style')) return;
    // getStyle 现在是异步的（样式表由主进程代读，preload 沙箱里没有 fs）
    let css = '';
    try {
        css = bridge && bridge.getStyle ? await bridge.getStyle() : '';
    } catch (err) {
        log('读取样式失败', err);
    }
    if (!css) {
        log('样式表为空，界面可能会比较朴素');
        return;
    }
    const style = document.createElement('style');
    style.id = 'fs-style';
    style.textContent = css;
    document.head.appendChild(style);
}

function buildUi() {
    if (ui) return ui;

    const mask = document.createElement('div');
    mask.className = 'fs-root fs-mask';
    mask.setAttribute('data-fs-theme', currentTheme);
    mask.style.display = 'none';
    mask.innerHTML = `
        <div class="fs-panel" role="dialog" aria-label="合并转发搜索">
            <div class="fs-search">
                <svg class="fs-search-icon" viewBox="0 0 16 16" fill="none">
                    <circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.6"/>
                    <path d="M11 11L14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
                </svg>
                <input class="fs-input" type="text" spellcheck="false" placeholder="搜索合并转发卡片里的内容…" />
                <span class="fs-hotkey"></span>
            </div>
            <div class="fs-body"></div>
            <div class="fs-foot">
                <span class="fs-foot-stat"></span>
                <span class="fs-foot-spacer"></span>
                <a class="fs-link fs-link-scan">扫描历史</a>
                <a class="fs-link fs-link-settings">设置</a>
                <span class="fs-keyhint"><kbd>Esc</kbd>关闭</span>
                <span class="fs-keyhint"><kbd>↑</kbd><kbd>↓</kbd>选择</span>
                <span class="fs-keyhint fs-keyhint-enter"><kbd>Enter</kbd>打开</span>
            </div>
        </div>`;
    document.body.appendChild(mask);


    const input = mask.querySelector('.fs-input');
    const body = mask.querySelector('.fs-body');

    // 搜索框右边那个小胶囊显示当前快捷键，提醒用户下次可以直接按
    const hotkeyTip = mask.querySelector('.fs-hotkey');
    if (hotkeyTip) hotkeyTip.textContent = (STATE.config && STATE.config.hotkey) || 'Alt+S';

    // 点击遮罩空白处关闭
    mask.addEventListener('mousedown', (e) => {
        if (e.target === mask) closePanel();
    });

    // 输入 → 防抖搜索
    const debounced = debounce(() => {
        STATE.query = input.value.trim();
        STATE.activeIndex = 0;
        doSearch();
    }, (STATE.config && STATE.config.debounce) || 220);
    input.addEventListener('input', debounced);

    // 键盘操作
    input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            moveActive(1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            moveActive(-1);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            openActive();
        }
    });

    mask.querySelector('.fs-link-settings').addEventListener('click', () => {
        openSettingsHint();
    });

    // 扫描历史：把各个会话翻一遍，把里面的合并转发卡片收进索引
    mask.querySelector('.fs-link-scan').addEventListener('click', async () => {
        if (crawler.running) {
            // 正在跑的时候点一下 = 暂停/继续
            crawler.paused = !crawler.paused;
            renderCrawlStatus();
            return;
        }
        const yes = confirm(
            '扫描历史会逐个打开你的会话翻看聊天记录，把里面的合并转发卡片收进索引。\n\n' +
                '这会向 QQ 的服务器发出一些请求，数量取决于你的聊天量。建议在空闲时进行，中途可以点"暂停"。\n\n' +
                '确定开始吗？'
        );
        if (!yes) return;
        await scanHistory(200);
    });

    ui = { mask, panel: mask.querySelector('.fs-panel'), input, body };
    return ui;
}

/** 打开弹窗（异步：样式表要从主进程取） */
async function openPanel() {
    await injectStyleOnce();
    buildUi();
    applyTheme();

    if (STATE.config && STATE.config.onboarded === false) {
        renderOnboard();
    } else {
        STATE.mode = 'search';
        renderResultsArea();
        if (STATE.query) doSearch();
    }

    // 排障用：config 里写了 debugAutoQuery 就自动填好关键词并搜一次，
    // 方便截图/远程看"搜出来长什么样"。默认没有这个配置项。
    if (STATE.config && STATE.config.debugAutoQuery && !STATE.query) {
        ui.input.value = STATE.query = STATE.config.debugAutoQuery;
        doSearch();
    }

    ui.mask.style.display = 'flex';
    STATE.open = true;
    setTimeout(() => ui.input.focus(), 30);
    refreshStats();
}

function closePanel() {
    if (!ui) return;
    ui.mask.style.display = 'none';
    STATE.open = false;
    STATE.mode = 'search';
    if (ui.input) ui.input.value = STATE.query = '';
}

/* ---------- 各区域的渲染 ---------- */

function renderResultsArea() {
    if (!ui) return;
    const body = ui.body;

    if (STATE.mode === 'detail') return renderDetail();
    if (STATE.mode === 'onboard') return renderOnboard();

    if (STATE.error) {
        body.innerHTML = `
            <div class="fs-state">
                <strong>出了点问题</strong>
                ${esc(STATE.error)}
                <div class="fs-hint">可以先试试关掉弹窗再打开，或者重新输入关键词。</div>
            </div>`;
        return;
    }

    if (STATE.searching) {
        body.innerHTML = `
            <div class="fs-skeleton">
                <div class="fs-sk-line" style="width:70%"></div>
                <div class="fs-sk-line" style="width:45%"></div>
                <div class="fs-sk-line" style="width:62%"></div>
            </div>`;
        return;
    }

    if (!STATE.query) {
        // 索引空的时候，光说"输入关键词"没用——得直接给个能点的动作
        const total = (STATE.stats && STATE.stats.total) || 0;
        if (total === 0) {
            body.innerHTML = `
            <div class="fs-state fs-state-empty">
                <div class="fs-art">
                    <svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
                        <rect x="10" y="14" width="34" height="26" rx="6" stroke="currentColor" stroke-width="2.2" opacity=".55"/>
                        <path d="M17 24h20M17 31h13" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" opacity=".38"/>
                        <circle cx="42" cy="42" r="10" stroke="currentColor" stroke-width="2.4"/>
                        <path d="M49.5 49.5L56 56" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
                    </svg>
                </div>
                <strong>索引里还没有卡片</strong>
                先在 QQ 里打开一个有合并转发的群，然后点下面这个按钮。<br/>
                只有 QQ 本地缓存过的会话（也就是你打开过的聊天）才读得到消息。
                <div><button class="fs-btn fs-act-scan">扫描当前会话</button></div>
                <div class="fs-hint">之后新收到的卡片会自动收录，不用再点。</div>
            </div>`;
            const scanBtn = body.querySelector('.fs-act-scan');
            if (scanBtn) {
                scanBtn.addEventListener('click', async () => {
                    scanBtn.disabled = true;
                    scanBtn.textContent = '扫描中…';
                    await scanHistory(200);
                    scanBtn.disabled = false;
                    scanBtn.textContent = '扫描当前会话';
                    renderResultsArea();
                });
            }
            return;
        }

        body.innerHTML = `
            <div class="fs-state fs-state-empty">
                <div class="fs-art">
                    <svg viewBox="0 0 64 64" fill="none" aria-hidden="true">
                        <rect x="10" y="14" width="34" height="26" rx="6" stroke="currentColor" stroke-width="2.2" opacity=".55"/>
                        <path d="M17 24h20M17 31h13" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" opacity=".38"/>
                        <circle cx="42" cy="42" r="10" stroke="currentColor" stroke-width="2.4"/>
                        <path d="M49.5 49.5L56 56" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
                    </svg>
                </div>
                <strong>输入关键词开始找</strong>
                搜的是整张合并转发卡片，包括卡片里面的聊天内容。<br/>
                比如搜一句你在转发里看到过的话。
                <div class="fs-hint">关键词可以用空格分开，表示"同时包含"。</div>
            </div>`;
        return;
    }

    if (STATE.results.length === 0) {
        body.innerHTML = `
            <div class="fs-state">
                <strong>没有找到匹配的卡片</strong>
                换个词试试？或者看看是不是还没补全内容。
                <div class="fs-hint">卡片内容如果没补全，只能搜到标题和摘要。</div>
                <button class="fs-btn fs-btn-ghost fs-act-crawl">去补全内容</button>
            </div>`;
        const btn = body.querySelector('.fs-act-crawl');
        if (btn) btn.addEventListener('click', () => runCrawl());
        return;
    }

    body.innerHTML = STATE.results
        .map((card, i) => {
            const active = i === STATE.activeIndex ? ' is-active' : '';
            const countBadge = card.count > 0 ? `<span class="fs-badge">共 ${card.count} 条</span>` : '';
            const pending = card.innerState === 0 ? '<span class="fs-badge" style="opacity:.6">内容未补全</span>' : '';
            return `
                <div class="fs-item${active}" data-index="${i}">
                    <div class="fs-item-head">
                        <span class="fs-item-group">${esc(card.peerName || '未知群聊')}</span>
                        <span class="fs-dot"></span>
                        <span class="fs-item-time">${formatTime(card.msgTime)}</span>
                        ${countBadge}${pending}
                    </div>
                    <div class="fs-item-title">${highlight(card.title || '聊天记录', STATE.query)}</div>
                    <div class="fs-item-preview">${highlight(card.preview || '（无摘要）', STATE.query)}</div>
                </div>`;
        })
        .join('');

    body.querySelectorAll('.fs-item').forEach((el) => {
        el.addEventListener('click', () => {
            const idx = Number(el.dataset.index);
            STATE.activeIndex = idx;
            openCard(STATE.results[idx]);
        });
        el.addEventListener('mouseenter', () => {
            STATE.activeIndex = Number(el.dataset.index);
            body.querySelectorAll('.fs-item').forEach((n) => n.classList.remove('is-active'));
            el.classList.add('is-active');
        });
    });
}

function moveActive(delta) {
    if (STATE.results.length === 0) return;
    STATE.activeIndex = (STATE.activeIndex + delta + STATE.results.length) % STATE.results.length;
    const nodes = ui.body.querySelectorAll('.fs-item');
    nodes.forEach((n, i) => n.classList.toggle('is-active', i === STATE.activeIndex));
    const active = nodes[STATE.activeIndex];
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest' });
}

function openActive() {
    const card = STATE.results[STATE.activeIndex];
    if (card) openCard(card);
}

/* ==================================================================
 * 6. 搜索
 * ================================================================== */

async function doSearch() {
    if (!ui) return;
    STATE.error = '';

    if (!STATE.query) {
        renderResultsArea();
        return;
    }

    if (!bridge) {
        STATE.error = '插件桥接层没有加载成功，请重启 QQ 再试。';
        STATE.searching = false;
        renderResultsArea();
        return;
    }

    STATE.searching = true;
    renderResultsArea();

    try {
        const res = await bridge.search(STATE.query, (STATE.config && STATE.config.maxResults) || 60);
        if (!res || !res.ok) {
            throw new Error((res && res.error) || '搜索失败');
        }
        STATE.results = res.data || [];

        // 群名兜底：早期收录的记录可能没有群名，用缓存补一下
        for (const card of STATE.results) {
            if ((!card.peerName || card.peerName === card.peerUid) && bridge.getPeerName) {
                const name = bridge.getPeerName(card.peerUid);
                if (name) card.peerName = name;
            }
        }
    } catch (err) {
        STATE.results = [];
        STATE.error = '搜索时出错：' + String((err && err.message) || err);
    } finally {
        STATE.searching = false;
        renderResultsArea();
        // 排障用：debugAutoOpenCard 打开时自动点开第一条结果，方便截图/远程看详情页
        if (STATE.config && STATE.config.debugAutoOpenCard && STATE.results.length > 0 && !STATE.openCardDone) {
            STATE.openCardDone = true;
            setTimeout(() => openCard(STATE.results[0]), 600);
        }
    }
}

/* ==================================================================
 * 7. 详情面板
 * ------------------------------------------------------------------
 * 需求里说得很清楚：跳转失败不能崩，要直接把内容摊开给用户看。
 * 所以这里的逻辑是"先尽力跳到聊天，然后无论如何都展示全文"。
 * ================================================================== */

async function openCard(card) {
    if (!card) return;
    STATE.currentCard = card;
    STATE.mode = 'detail';
    renderDetail();

    // 顺手试一下跳到聊天窗口。跳不过去也没关系，详情已经显示出来了。
    tryJumpToChat(card);
}

let jumpNotice = '';

/**
 * 把卡片预览拆成一条条"谁说了什么"。
 *
 * 预览是卡片 XML 里那几行 `<title>`：第一行是卡片标题，后面每行是「昵称: 内容」，
 * 用 " / " 连在一起。这些就是卡片封面上的真实内容，虽然只有前几条，
 * 但比让用户对着一个空白页强得多。
 */
function splitPreview(preview) {
    if (!preview) return [];
    return String(preview)
        .split(' / ')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            // "昵称: 内容" 或 "昵称：内容"
            const m = line.match(/^(.{1,24}?)[:：]\s*([\s\S]*)$/);
            if (m && m[2]) return { name: m[1].trim(), text: m[2].trim() };
            return { name: '', text: line };
        });
}

/**
 * 尝试把用户带到这张卡片"本身"——不只是切到那个群，还要在聊天记录里
 * 把这条卡片滚到眼前、圈出来。
 *
 * 为什么非要做到这一步：合并转发卡片里的图片、文件、表情，QQ 只在自己
 * 的界面里渲染，插件拿不到（9.9.31 的 getMultiMsg 会被服务端拒）。
 * 与其让用户在详情页里对着一行"[图片]"发呆，不如直接把他送回原位置。
 *
 * 分三步，任何一步失败都降级，不抛异常：
 *   1. 切会话（优先点左侧会话列表，失败再调内核接口）
 *   2. 在消息列表里往上翻，按卡片封面上的文字匹配出那一条
 *   3. 滚到屏幕中间 + 画一个高亮圈
 */
async function tryJumpToChat(card, opts) {
    const autoClose = !(opts && opts.keepPanel);
    jumpNotice = '';

    // 1. 切会话。点列表是最可靠的方式（内核接口只激活、不切界面）。
    let switched = clickChatInUi(card);

    if (!switched && STATE.config && STATE.config.contentMode && bridge && bridge.nativeCall) {
        switched = await kernelActivateChat(card);
    }

    if (!switched) {
        jumpNotice = '没能自动跳到聊天，下面是这张卡片能读到的内容。';
        renderDetail();
        return false;
    }

    // 2. 等界面把消息渲染出来，再去找那张卡片
    await sleep(650);
    const node = await locateCardInChat(card);

    if (node) {
        jumpNotice = '';
        showFloatingToast(`已定位到「${card.peerName || '聊天'}」里的这张卡片`);
        if (autoClose) setTimeout(() => closePanel(), 260);
        return true;
    }

    // 3. 切过去了但没找到：多半是消息太旧、还没加载出来。
    //    这时候不自动关面板，免得把用户丢在一个空界面上。
    jumpNotice = `已经切到「${card.peerName || '聊天'}」，但在聊天里没定位到这张卡片。可能消息太旧还没加载出来，往上翻一翻。`;
    renderDetail();
    return false;
}

/**
 * 用内核接口激活会话（点列表失败时的备用手段）。
 * 不同版本接口名不一样，挨个试；判断"真切过去了"不能只看应答码，
 * 应答只是 ack，拿到消息才算真的打开了这个会话。
 */
async function kernelActivateChat(card) {
    const peer = peerOf(card);
    const tries = [
        { label: 'AddActiveChat', cmd: 'nodeIKernelMsgService/getAioFirstViewLatestMsgsAndAddActiveChat', payload: [{ peer, cnt: 10 }, null] },
        { label: 'selectPeerChat', cmd: 'nodeIWindowApi/selectPeerChat', payload: [{ peer }, null] },
        { label: 'selectPeerChat 简写', cmd: 'nodeIWindowApi/selectPeerChat', payload: [{ peerUid: peer.peerUid, chatType: peer.chatType }] }
    ];

    for (const t of tries) {
        try {
            const res = await bridge.nativeCall(t.cmd, t.payload, true, 4000);
            const msgs = res ? collectMessages(res, [], 0).length : 0;
            diag(`[jump] ${t.label} → ${(res && res.__statue) || 'ok'} / ${msgs} 条`);
            if (msgs > 0) {
                clickChatInUi(card);
                return true;
            }
        } catch (err) {
            diag(`[jump] ${t.label} 抛异常 ${err}`);
        }
    }
    return false;
}

/**
 * 让 QQ 界面真的打开某个会话。
 *
 * 内核层的 AddActiveChat 只是把会话"激活"了（列表会顶到第一条），
 * 但界面不会跟着切过去，右侧还是空白。所以这里补一步：
 * 在会话列表里找到那一项，直接触发它自己的 click。
 * 用的是元素 click，不是模拟鼠标，不会误点到别的东西。
 */
function clickChatInUi(card) {
    const name = card && card.peerName;
    if (!name || name === card.peerUid) return false;

    // 会话项的类名是 .recent-contact-item（真机确认过）。
    // 直接 .click() 不够：QQ 的列表是拖拽组件，只认完整的按下/抬起序列。
    const items = Array.from(document.querySelectorAll('.recent-contact-item'));
    const target = items.find((el) => (el.textContent || '').indexOf(name) !== -1);
    if (!target) {
        diag(`[jump] 列表里没有「${name}」（共 ${items.length} 项）`);
        return false;
    }

    const opts = { bubbles: true, cancelable: true, view: window };
    try {
        target.dispatchEvent(new PointerEvent('pointerdown', opts));
        target.dispatchEvent(new MouseEvent('mousedown', opts));
        target.dispatchEvent(new PointerEvent('pointerup', opts));
        target.dispatchEvent(new MouseEvent('mouseup', opts));
        target.dispatchEvent(new MouseEvent('click', opts));
        diag(`[jump] 已对「${name}」派发点击序列`);
        return true;
    } catch (err) {
        diag(`[jump] 派发点击失败 ${err}`);
        return false;
    }
}

/* ------------------------------------------------------------------
 * 在聊天里"定位"一条卡片
 * ------------------------------------------------------------------
 * QQ 没有给我们"跳到第 N 条消息"的接口，所以只能自己翻：
 *   找到聊天滚动区 → 一屏一屏往上翻 → 每一屏按文字匹配卡片
 * 匹配用的是卡片封面上的原文（XML 里那几行 <title>），
 * 它和聊天里那张卡片显示的字是同一份，所以命中率不错。
 * ------------------------------------------------------------------ */

/** 这个元素自己能滚吗（排除我们自己的弹窗） */
function isScrollableBox(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.closest && el.closest('.fs-root')) return false;
    const st = getComputedStyle(el);
    if (!/(auto|scroll|overlay)/.test(st.overflowY)) return false;
    return el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 140;
}

/** 找聊天消息区的滚动容器：右侧面积最大的那个可滚动块 */
function findChatScroller(needles) {
    const match = Array.isArray(needles) ? needles : [];
    const vw = window.innerWidth;
    const right = [];
    const any = [];

    document.querySelectorAll('div, ul, section, main, article').forEach((el) => {
        if (!isScrollableBox(el)) return;
        const r = el.getBoundingClientRect();
        if (r.width < 200 || r.height < 150) return;
        any.push({ el, area: r.width * r.height });
        if (r.right >= vw * 0.35) right.push({ el, area: r.width * r.height }); // 右边才是聊天区
    });

    // 优先用"当前就能看到目标文字"的那一个：卡片就在眼前时，这个判断最准。
    // 都不含目标文字时，退回到面积最大的那个（一般就是消息列表）。
    const pools = right.length > 0 ? [right, any] : [any];
    for (const pool of pools) {
        const hit = pool.find((c) => {
            const txt = c.el.textContent || '';
            return match.some((n) => txt.indexOf(n) !== -1);
        });
        if (hit) return hit.el;
    }

    const best = (right.length > 0 ? right : any).sort((a, b) => b.area - a.area);
    return best.length > 0 ? best[0].el : null;
}

/** 从卡片里挑出几段"足够独特"的原文，用来在聊天里认出它 */
function locateNeedles(card) {
    const out = [];
    const push = (text) => {
        const t = String(text || '').trim();
        if (t.length >= 3) out.push(t.slice(0, 20));
    };

    String(card.preview || '')
        .split(' / ')
        .forEach((line) => {
            // 去掉"昵称: "前缀，只留正文，命中率更高
            push(line.replace(/^[^:：]{1,24}[:：]\s*/, ''));
        });

    if (out.length === 0) push(card.preview);
    return Array.from(new Set(out)).slice(0, 4);
}

/**
 * 在当前这一屏里找最像目标卡片的元素。
 * 打分逻辑：命中的原文片段越多越像；文字越长越可能是整个列表容器，扣分。
 */
function searchCardIn(scroller, card, needles) {
    if (!scroller || needles.length === 0) return null;

    // 先在"像消息的节点"里找，命中不了再退化成全量扫描。
    // 全量扫一次几百上千个节点，翻 30 屏就是几万次，能省则省。
    let nodes = scroller.querySelectorAll(
        '[class*="message"], [class*="msg"], [class*="bubble"], [class*="card"], [class*="record"], [class*="item"]'
    );
    if (nodes.length < 5) nodes = scroller.querySelectorAll('div, li, article, section');

    let best = null;
    let bestScore = 0;

    for (const el of nodes) {
        if (el.closest && el.closest('.fs-root')) continue;
        const txt = el.textContent || '';
        if (txt.length < 3 || txt.length > 1500) continue;

        let hits = 0;
        for (const n of needles) {
            if (txt.indexOf(n) !== -1) hits++;
        }
        if (hits === 0) continue;

        const titleHit = card.title && txt.indexOf(String(card.title).slice(0, 5)) !== -1 ? 1 : 0;
        const score = hits * 10 + titleHit * 3 - Math.min(txt.length / 200, 6);
        if (score > bestScore) {
            bestScore = score;
            best = el;
        }
    }
    return best ? { el: best, score: bestScore } : null;
}

/** 在消息列表里往上翻，直到找到这张卡片；找不到返回 null */
async function locateCardInChat(card) {
    if (STATE.locating) return null;
    STATE.locating = true;
    try {
        const needles = locateNeedles(card);
        if (needles.length === 0) return null;

        const scroller = findChatScroller(needles);
        if (!scroller) {
            diag('[locate] 没找到聊天的滚动容器');
            return null;
        }
        diag(
            `[locate] 容器 ${scroller.tagName.toLowerCase()}.${String(scroller.className).slice(0, 36)} ` +
                `sh=${scroller.scrollHeight} ch=${scroller.clientHeight} top=${Math.round(scroller.scrollTop)}`
        );

        let hit = searchCardIn(scroller, card, needles);

        for (let round = 0; !hit && round < 30; round++) {
            const before = scroller.scrollTop;
            if (before <= 0) break;

            scroller.scrollTop = Math.max(0, before - scroller.clientHeight * 0.85);
            scroller.dispatchEvent(new Event('scroll', { bubbles: true }));

            // 等 QQ 把上一批消息渲染出来（虚拟列表 + 懒加载，得给点时间）
            await sleep(300);
            hit = searchCardIn(scroller, card, needles);

            // 滚不动了说明到底了
            if (!hit && Math.abs(scroller.scrollTop - before) < 4) break;
        }

        if (!hit) {
            diag(`[locate] 翻了 30 屏没找到：needles=${needles.join('|').slice(0, 60)}`);
            return null;
        }

        if (hit.el.scrollIntoView) hit.el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        await sleep(420);
        highlightLocated(hit.el);
        diag(`[locate] 命中 score=${hit.score} class=${String(hit.el.className).slice(0, 40)}`);
        return hit.el;
    } catch (err) {
        diag('[locate] 出错 ' + err);
        return null;
    } finally {
        STATE.locating = false;
    }
}

/** 在找到的元素外面画一圈高亮，2.6 秒后自己消失 */
function highlightLocated(el) {
    try {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return;
        const ring = document.createElement('div');
        ring.className = 'fs-locate-ring';
        ring.style.left = Math.round(r.left - 5) + 'px';
        ring.style.top = Math.round(r.top - 5) + 'px';
        ring.style.width = Math.round(r.width + 10) + 'px';
        ring.style.height = Math.round(r.height + 10) + 'px';
        document.body.appendChild(ring);
        setTimeout(() => ring.remove(), 2600);
    } catch (_) { /* 画不出圈不影响跳转 */ }
}

/** 面板关掉之后也要能提示，所以单独做一个悬浮 toast */
let floatToastTimer = null;
function showFloatingToast(message) {
    try {
        let el = document.querySelector('.fs-float-toast');
        if (!el) {
            el = document.createElement('div');
            el.className = 'fs-float-toast';
            document.body.appendChild(el);
        }
        el.textContent = message;
        el.classList.add('is-show');
        if (floatToastTimer) clearTimeout(floatToastTimer);
        floatToastTimer = setTimeout(() => el.classList.remove('is-show'), 2800);
    } catch (_) {
        toast(message);
    }
}

/**
 * 定位到卡片之后，再替用户点一下它——QQ 会弹出原生的"聊天记录"窗口，
 * 里面的图片、文件、表情全都在。这是详情页唯一显示不了的东西。
 */
async function openOriginalCard(card) {
    const el = await locateCardInChat(card);
    if (!el) {
        toast('没能在聊天里定位到这张卡片');
        return false;
    }
    await sleep(500);

    // 找到真正可点击的那一层（卡片本体一般有几个带 card/forward/bubble 的类名）
    let target = el;
    for (let i = 0; i < 4; i++) {
        const cls = String(target.className || '');
        if (/card|forward|multi|bubble|message|item/i.test(cls)) break;
        if (!target.parentElement || target.parentElement === document.body) break;
        target = target.parentElement;
    }

    const opts = { bubbles: true, cancelable: true, view: window };
    try {
        target.dispatchEvent(new PointerEvent('pointerdown', opts));
        target.dispatchEvent(new MouseEvent('mousedown', opts));
        target.dispatchEvent(new PointerEvent('pointerup', opts));
        target.dispatchEvent(new MouseEvent('mouseup', opts));
        target.dispatchEvent(new MouseEvent('click', opts));
        diag('[locate] 已点击卡片，尝试打开原生窗口');
        showFloatingToast('已打开原卡片，图片在里面');
        setTimeout(() => closePanel(), 200);
        return true;
    } catch (err) {
        diag('[locate] 点击卡片失败 ' + err);
        return false;
    }
}

/**
 * 消息正文渲染。图片/视频/语音/文件这几种，插件拿不到内容本身
 * （QQ 不在 XML 里放原图地址），所以做成小胶囊，配合下面的"定位"按钮用。
 */
function renderMsgText(text) {
    const raw = String(text == null ? '' : text);
    if (!raw) return '<span class="fs-msg-media">空消息</span>';

    const re = /\[(图片|视频|语音|文件|表情)\]/g;
    let html = '';
    let last = 0;
    let m;
    while ((m = re.exec(raw)) !== null) {
        html += highlight(raw.slice(last, m.index), STATE.query);
        html += `<span class="fs-msg-media">${m[1]}</span>`;
        last = m.index + m[0].length;
    }
    html += highlight(raw.slice(last), STATE.query);
    return html;
}

function renderDetail() {
    if (!ui) return;
    const card = STATE.currentCard;
    if (!card) {
        STATE.mode = 'search';
        renderResultsArea();
        return;
    }

    const inner = card.inner || [];
    let innerHtml = '';

    if (inner.length > 0) {
        innerHtml = inner
            .map((m) => {
                const name = m.name || '未知';
                const initial = Array.from(name)[0] || '?';
                const timeHtml = m.time ? `<span class="fs-msg-time">${formatTime(m.time)}</span>` : '';
                return `
                <div class="fs-msg">
                    <div class="fs-avatar">${esc(initial)}</div>
                    <div class="fs-msg-body">
                        <div class="fs-msg-meta">
                            <span class="fs-msg-name">${esc(name)}</span>
                            ${timeHtml}
                        </div>
                        <div class="fs-msg-text">${renderMsgText(m.text)}</div>
                    </div>
                </div>`;
            })
            .join('');
    } else {
        // 拿不到完整正文（9.9.31 的 getMultiMsg 会被服务端拒），那就把封面上的内容摊开。
        // 这几行本来就是卡片内部的原文，只是条数少而已。
        const lines = splitPreview(card.preview);
        if (lines.length > 0) {
            innerHtml =
                lines
                    .map((m) => {
                        const name = m.name || '';
                        const initial = name ? Array.from(name)[0] : '…';
                        return `
                <div class="fs-msg">
                    <div class="fs-avatar">${esc(initial)}</div>
                    <div class="fs-msg-body">
                        <div class="fs-msg-meta"><span class="fs-msg-name">${esc(name || '卡片内容')}</span></div>
                        <div class="fs-msg-text">${highlight(m.text || '', STATE.query)}</div>
                    </div>
                </div>`;
                    })
                    .join('') +
                `<div class="fs-note">以上是卡片封面上显示的内容${card.count ? `（这张卡共 ${card.count} 条）` : ''}。
                 更靠后的消息，QQ 没有下发给插件，暂时读不到；图片和文件更是只有原卡片里才有。</div>`;
        } else if (card.innerState === 2) {
            innerHtml = `<div class="fs-state">这张卡片的内容没能读出来。<br/>可能是消息太久远，或者已经被清理了。</div>`;
        } else {
            innerHtml = `<div class="fs-state">这张卡片本地没有存下任何内容。</div>`;
        }
    }

    ui.body.innerHTML = `
        <div class="fs-detail">
            <div class="fs-detail-head">
                <div class="fs-detail-title">${esc(card.title || '聊天记录')}</div>
                <div class="fs-detail-sub">
                    ${esc(card.peerName || '未知群聊')} · ${formatTime(card.msgTime)}
                    ${card.count ? ' · 共 ' + card.count + ' 条' : ''}
                    ${jumpNotice ? '<br/>' + esc(jumpNotice) : ''}
                </div>
            </div>
            <div class="fs-detail-actions">
                <button class="fs-btn fs-act-locate">在聊天里定位这条</button>
                <button class="fs-btn fs-btn-ghost fs-act-open">打开原卡片</button>
            </div>
            <div class="fs-detail-tip">图片、文件、表情只在 QQ 原卡片里显示，点上面两个按钮就能回到原消息。</div>
            <div class="fs-detail-list">${innerHtml}</div>
            <div class="fs-foot">
                <a class="fs-link fs-act-back">← 返回搜索结果</a>
                <span class="fs-foot-spacer"></span>
                <span>Esc 关闭</span>
            </div>
        </div>`;

    const back = ui.body.querySelector('.fs-act-back');
    if (back) {
        back.addEventListener('click', () => {
            STATE.mode = 'search';
            STATE.currentCard = null;
            renderResultsArea();
        });
    }
    const crawlBtn = ui.body.querySelector('.fs-act-crawl');
    if (crawlBtn) crawlBtn.addEventListener('click', () => runCrawl());

    // 定位 / 打开原卡片：两个按钮做的事一样，区别是第二个找到后还会替用户点开
    const locateBtn = ui.body.querySelector('.fs-act-locate');
    if (locateBtn) {
        locateBtn.addEventListener('click', async () => {
            locateBtn.disabled = true;
            locateBtn.textContent = '正在找…';
            await tryJumpToChat(card, { keepPanel: false });
            locateBtn.disabled = false;
            locateBtn.textContent = '在聊天里定位这条';
        });
    }
    const openBtn = ui.body.querySelector('.fs-act-open');
    if (openBtn) {
        openBtn.addEventListener('click', async () => {
            openBtn.disabled = true;
            openBtn.textContent = '正在打开…';
            await openOriginalCard(card);
            openBtn.disabled = false;
            openBtn.textContent = '打开原卡片';
        });
    }

    // 如果本地没内容，顺便试着补一下（仅在允许联网时）
    if (inner.length === 0 && card.innerState === 0 && !card.__filling && STATE.config && STATE.config.contentMode) {
        fillThisCard(card);
    }
}

/**
 * 只补当前这一张（用户正等着看，所以给的时间预算比批量补全短）。
 * __filling 这个标记很重要：没有它，renderDetail 和 fillThisCard 会互相触发成死循环。
 */
async function fillThisCard(card) {
    if (card.__filling) return;
    card.__filling = true;
    renderDetail();
    try {
        const inner = await fetchCardInner(card, 8000);
        if (inner && inner.length > 0) {
            await bridge.setInner(card.id, inner, 1);
            card.inner = inner;
            card.innerState = 1;
        } else {
            card.innerState = 2;
        }
    } catch (_) {
        /* 补不到就算了，界面上已经有降级提示 */
        card.innerState = 2;
    } finally {
        card.__filling = false;
        if (STATE.currentCard && STATE.currentCard.id === card.id && STATE.mode === 'detail') {
            renderDetail();
        }
    }
}

/* ==================================================================
 * 8. 引导页 / 设置 / 启动
 * ================================================================== */

function renderOnboard() {
    if (!ui) return;
    STATE.mode = 'onboard';
    ui.body.innerHTML = `
        <div class="fs-onboard">
            <h3>第一次用，先花 30 秒看一下</h3>
            <p>这个插件帮你按"内容"找合并转发卡片——搜的是卡片里面说过的话，不只是外面那行摘要。</p>

            <div class="fs-note">
                这里要说清楚一件事：<b>QQ 的合并转发卡片，里面那些消息并不存在你电脑上</b>。
                你点开卡片时，QQ 才去服务器拉一次。所以想搜到"里面的内容"，插件也必须去拉一次。
            </div>

            <p>因此有两种用法，你选一个：</p>
            <ul>
                <li><b>仅本地模式（推荐先用这个）</b><br/>完全不联网。你打开过的卡片、别人发来时装过的内容会自动存下来，能搜到这些。</li>
                <li><b>内容补全模式</b><br/>用 QQ 自己的接口把历史卡片的内容一条条补回来。会有少量请求，速度慢一些，覆盖更全。</li>
            </ul>

            <div class="fs-actions">
                <button class="fs-btn" data-act="content">用内容补全模式</button>
                <button class="fs-btn fs-btn-ghost" data-act="local">先用仅本地模式</button>
            </div>
            <p class="fs-hint" style="margin-top:12px;font-size:11px;color:var(--fs-text-weak)">
                随时可以在设置里改。快捷键默认 Alt + S。
            </p>
        </div>`;

    ui.body.querySelector('[data-act="content"]').addEventListener('click', () => {
        bridge && bridge.patchConfig({ contentMode: true, onboarded: true });
        STATE.config.contentMode = true;
        STATE.config.onboarded = true;
        STATE.mode = 'search';
        renderResultsArea();
        ui.input.focus();
        setTimeout(() => runCrawl(), 300);
    });

    ui.body.querySelector('[data-act="local"]').addEventListener('click', () => {
        bridge && bridge.patchConfig({ contentMode: false, onboarded: true });
        STATE.config.contentMode = false;
        STATE.config.onboarded = true;
        STATE.mode = 'search';
        renderResultsArea();
        ui.input.focus();
    });
}

function renderCrawlStatus() {
    const el = document.querySelector('.fs-foot-stat');
    if (!el) return;
    if (crawler.running) {
        const total = crawler.total || 0;
        el.textContent = crawler.paused
            ? `已暂停（${crawler.done}/${total}）`
            : `正在补全内容 ${crawler.done}/${total}${crawler.failed ? '（失败 ' + crawler.failed + '）' : ''}`;
    } else if (crawler.done > 0) {
        el.textContent = `补全完成：成功 ${crawler.done}，失败 ${crawler.failed}`;
    } else {
        refreshStats();
    }
}

let _statsText = '';
async function refreshStats() {
    if (!bridge || !ui) return;
    try {
        const res = await bridge.stats();
        if (res && res.ok) {
            const s = res.data;
            STATE.stats = s;
            _statsText = `已收录 ${s.total} 张卡片 · 其中 ${s.withInner} 张有完整内容`;
            const el = document.querySelector('.fs-foot-stat');
            if (el && !crawler.running) el.textContent = _statsText;
            // 空状态依赖总数，统计变了要重画一次，不然会一直显示"还没有卡片"
            if (STATE.open && !STATE.query) renderResultsArea();
        }
    } catch (_) {
        /* 统计失败不影响使用 */
    }
}

function toast(message) {
    const el = document.querySelector('.fs-foot-stat');
    if (el) {
        const old = el.textContent;
        el.textContent = message;
        setTimeout(() => {
            el.textContent = old || _statsText;
        }, 2600);
    } else {
        log(message);
    }
}

function openSettingsHint() {
    toast('设置：QQ 左下角 ⚙ → 插件设置 → 合并转发搜索');
}

/* ---------- 设置页（QQ 设置面板里的那一块） ---------- */

export const onSettingWindowCreated = (view) => {
    try {
        injectStyleOnce();
        // 设置窗口是独立窗口，主题要重新判断一次
        const theme = computeTheme();
        const root = document.createElement('div');
        root.className = 'fs-root fs-settings';
        root.setAttribute('data-fs-theme', theme);
        root.innerHTML = `
            <div class="fs-row">
                <div class="fs-row-label">
                    外观
                    <span class="fs-row-desc">跟随系统：系统切成深色时，弹窗也跟着变深色。</span>
                </div>
                <div class="fs-seg" data-k="theme">
                    <button type="button" data-val="system">跟随系统</button>
                    <button type="button" data-val="light">浅色</button>
                    <button type="button" data-val="dark">深色</button>
                </div>
            </div>
            <div class="fs-row">
                <div class="fs-row-label">
                    内容补全模式
                    <span class="fs-row-desc">关闭 = 仅本地模式，完全不联网。打开后会用 QQ 自己的接口把卡片内容补全。</span>
                </div>
                <div class="fs-switch" data-k="contentMode"></div>
            </div>
            <div class="fs-row">
                <div class="fs-row-label">
                    被动收录
                    <span class="fs-row-desc">别人发来卡片、你打开卡片时顺手存下来，不额外发请求。</span>
                </div>
                <div class="fs-switch" data-k="passiveCapture"></div>
            </div>
            <div class="fs-row">
                <div class="fs-row-label">
                    快捷键
                    <span class="fs-row-desc">点一下这个按钮，然后直接按你想用的组合键（比如 Ctrl+Shift+F）。改完重启 QQ 生效。</span>
                </div>
                <button class="fs-btn fs-btn-ghost fs-hotkey-rec" data-k="hotkey" type="button">Alt+S</button>
            </div>
            <div class="fs-row">
                <div class="fs-row-label">
                    悬浮按钮
                    <span class="fs-row-desc">主面板上放一个可以拖动的圆形按钮，随时点开搜索，不依赖快捷键。</span>
                </div>
                <div class="fs-switch" data-k="showFloat"></div>
            </div>
            <div class="fs-row">
                <div class="fs-row-label">
                    补全速度
                    <span class="fs-row-desc">两次请求之间的等待时间。越大越安全，越小越快。</span>
                </div>
                <input class="fs-input" data-k="crawlIntervalMs" type="number" style="flex:0 0 100px;text-align:right;border:1px solid var(--fs-border);border-radius:6px;padding:4px 8px;" />
            </div>
            <div class="fs-row">
                <div class="fs-row-label">
                    本地数据
                    <span class="fs-row-desc" data-stat>正在统计…</span>
                    <div class="fs-progress"><i data-progress></i></div>
                </div>
                <button class="fs-btn fs-btn-ghost" data-act="open">打开目录</button>
                <button class="fs-btn fs-btn-ghost" data-act="clear">清空索引</button>
            </div>
        `;
        view.appendChild(root);

        const refresh = async () => {
            if (!bridge) return;
            const cfg = await bridge.getConfig();
            const c = cfg && cfg.ok ? cfg.data : STATE.config || {};
            STATE.config = c;

            // 设置页自己也要跟着主题走
            root.setAttribute('data-fs-theme', computeTheme());

            const seg = root.querySelector('.fs-seg[data-k="theme"]');
            if (seg) {
                const paint = (val) => {
                    Array.from(seg.querySelectorAll('button')).forEach((b) => {
                        b.classList.toggle('is-on', b.dataset.val === val);
                    });
                };
                // auto 是老配置的写法，界面上统一表现成"跟随系统"
                paint(c.theme === 'auto' ? 'system' : c.theme || 'system');
                Array.from(seg.querySelectorAll('button')).forEach((b) => {
                    b.addEventListener('click', () => {
                        const val = b.dataset.val;
                        paint(val);
                        STATE.config.theme = val;
                        bridge.patchConfig({ theme: val });
                        // 立刻换，不用等 QQ 重启
                        applyTheme();
                    });
                });
            }

            root.querySelectorAll('.fs-switch').forEach((sw) => {
                sw.classList.toggle('is-on', !!c[sw.dataset.k]);
                sw.addEventListener('click', () => {
                    const k = sw.dataset.k;
                    const next = !sw.classList.contains('is-on');
                    sw.classList.toggle('is-on', next);
                    bridge.patchConfig({ [k]: next });
                    STATE.config[k] = next;
                    // 悬浮按钮要立刻出现/消失，不用等重启
                    if (k === 'showFloat') {
                        if (next) mountFloat();
                        else unmountFloat();
                    }
                });
            });

            // 快捷键录制：点一下 → 直接按组合键 → 存进去。
            // 之所以不做成输入框，是因为手打很容易打出 "A+B" 这种无效值（真机上就这么废过一次）。
            const hotkeyBtn = root.querySelector('[data-k="hotkey"]');
            if (hotkeyBtn) {
                let recording = false;
                const show = (v) => { hotkeyBtn.textContent = v || '未设置'; };
                show(c.hotkey || 'Alt+S');

                const startRecord = () => {
                    if (recording) return;
                    recording = true;
                    hotkeyBtn.classList.add('is-recording');
                    hotkeyBtn.textContent = '请按键…（Esc 取消）';
                    hotkeyBtn.focus();
                };

                hotkeyBtn.addEventListener('click', startRecord);

                hotkeyBtn.addEventListener('keydown', (e) => {
                    if (!recording) return;
                    e.preventDefault();
                    e.stopPropagation();

                    if (e.key === 'Escape') {
                        recording = false;
                        hotkeyBtn.classList.remove('is-recording');
                        show(c.hotkey || 'Alt+S');
                        hotkeyBtn.blur();
                        return;
                    }

                    // 只按了修饰键，继续等主键
                    if (MODIFIER_KEYS.includes(String(e.key).toLowerCase())) return;
                    if (!e.key || e.key === 'Unidentified') return;

                    const parts = [];
                    if (e.ctrlKey) parts.push('Ctrl');
                    if (e.altKey) parts.push('Alt');
                    if (e.shiftKey) parts.push('Shift');
                    if (e.metaKey) parts.push('Meta');

                    const main = keyLabel(e.key);
                    const combo = parts.concat(main).join('+');

                    // 没有修饰键也允许，但要提醒一下：单独一个字母会和打字冲突
                    recording = false;
                    hotkeyBtn.classList.remove('is-recording');
                    show(combo);
                    c.hotkey = combo;
                    STATE.config.hotkey = combo;
                    bridge.patchConfig({ hotkey: combo });
                    hotkeyBtn.blur();
                    diag(`[settings] 快捷键改为 ${combo}`);
                });

                hotkeyBtn.addEventListener('blur', () => {
                    if (!recording) return;
                    recording = false;
                    hotkeyBtn.classList.remove('is-recording');
                    show(c.hotkey || 'Alt+S');
                });
            }
            const speed = root.querySelector('[data-k="crawlIntervalMs"]');
            if (speed) {
                speed.value = c.crawlIntervalMs || 1600;
                speed.addEventListener('change', () =>
                    bridge.patchConfig({ crawlIntervalMs: Math.max(600, Number(speed.value) || 1600) })
                );
            }

            const stats = await bridge.stats();
            if (stats && stats.ok) {
                const d = stats.data;
                const el = root.querySelector('[data-stat]');
                if (el) el.textContent = `已收录 ${d.total} 张卡片，${d.withInner} 张有完整内容，${d.pending} 张待补全。`;
                const bar = root.querySelector('[data-progress]');
                if (bar) {
                    const pct = d.total ? Math.round((d.withInner / d.total) * 100) : 0;
                    bar.style.width = pct + '%';
                }
            }
        };

        root.querySelector('[data-act="open"]').addEventListener('click', () => bridge && bridge.openDataDir());
        root.querySelector('[data-act="clear"]').addEventListener('click', async () => {
            if (!bridge) return;
            const yes = confirm('确定要清空本地索引吗？这会删掉所有已收录的卡片记录（不影响 QQ 本身的消息）。');
            if (!yes) return;
            await bridge.clear();
            refresh();
        });

        refresh();
    } catch (err) {
        console.error('[forward-search] 搭建设置页失败', err);
    }
};

/* ---------- 快捷键 ---------- */

const MODIFIER_KEYS = ['control', 'alt', 'shift', 'meta', 'os'];

/** 把录制到的按键名换成人看得懂、又能存进配置的写法 */
function keyLabel(key) {
    const k = String(key || '');
    if (k === ' ') return 'Space';
    if (k.length === 1) return k.toUpperCase();
    const map = {
        ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
        Escape: 'Esc', Backspace: 'Backspace', Delete: 'Delete', Enter: 'Enter', Tab: 'Tab',
        Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown'
    };
    return map[k] || k;
}

/** 配置里的写法 → 浏览器 e.key 的写法，两边对得上才可能命中 */
const KEY_ALIASES = {
    up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright',
    esc: 'escape', space: ' ', delete: 'delete', return: 'enter'
};

/**
 * 解析 "Alt+S" 这类字符串。
 * 关键点：解析失败要返回 disabled:true，而不是返回一个 key 为空的组合——
 * 否则空 key 会变成"随便按什么都能触发"，在设置里打字都会弹窗（真机踩过）。
 */
function parseHotkey(text) {
    const raw = String(text || '').trim();
    if (!raw) return { disabled: true, key: '', ctrl: false, alt: false, shift: false, meta: false };

    const parts = raw.split('+').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const key = parts.pop() || '';

    // 只有修饰键、没有主键 → 无效
    if (!key || MODIFIER_KEYS.includes(key)) {
        return { disabled: true, key: '', ctrl: false, alt: false, shift: false, meta: false };
    }

    // 形如 "A+B"（B 当主键、A 当修饰键）这种手打出来的废值也要挡住，
    // 否则会退化成"单按 B 就触发"，等于把聊天打字全劫持了。
    const knownMods = ['ctrl', 'control', 'alt', 'shift', 'meta', 'cmd', 'win'];
    if (parts.some((p) => !knownMods.includes(p))) {
        return { disabled: true, key: '', ctrl: false, alt: false, shift: false, meta: false };
    }

    return {
        disabled: false,
        ctrl: parts.includes('ctrl') || parts.includes('control'),
        alt: parts.includes('alt'),
        shift: parts.includes('shift'),
        meta: parts.includes('meta') || parts.includes('cmd') || parts.includes('win'),
        key: KEY_ALIASES[key] || key
    };
}

/** 光标在输入框里时，所有全局快捷键都要让路 */
function isTypingTarget(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    // QQ 自己的输入框外面常套一层可编辑容器
    return !!(el.closest && el.closest('[contenteditable="true"], [contenteditable=""]'));
}

function setupHotkey() {
    let combo = parseHotkey(STATE.config && STATE.config.hotkey);

    document.addEventListener(
        'keydown',
        (e) => {
            // Esc：关掉弹窗或返回
            if (e.key === 'Escape' && STATE.open) {
                if (STATE.mode === 'detail') {
                    STATE.mode = 'search';
                    STATE.currentCard = null;
                    renderResultsArea();
                } else {
                    closePanel();
                }
                return;
            }

            // 在输入框里打字时不响应快捷键（否则设置里改快捷键会一边输入一边弹窗）
            if (isTypingTarget(e.target)) return;

            if (combo.disabled) return;

            const keyMatched = String(e.key || '').toLowerCase() === combo.key;
            if (!keyMatched) return;
            if (!!e.ctrlKey !== combo.ctrl) return;
            if (!!e.altKey !== combo.alt) return;
            if (!!e.shiftKey !== combo.shift) return;
            if (!!e.metaKey !== combo.meta) return;

            e.preventDefault();
            e.stopPropagation();

            diag(`[renderer] 快捷键命中 key=${e.key} alt=${e.altKey} open=${STATE.open}`);
            if (STATE.open) closePanel();
            else openPanel();
        },
        true
    );

    if (bridge && bridge.onConfigChanged) {
        bridge.onConfigChanged((cfg) => {
            STATE.config = cfg;
            combo = parseHotkey(cfg.hotkey);
            // 主题可能在设置页被改过，这里跟着换
            applyTheme();
        });
    }
}

/* ---------- 悬浮按钮（可拖动） ----------
 * 为什么还要这个：快捷键会被别的软件占用、也可能被自己改坏，
 * 有个看得见、点得着的按钮，才叫"随时能打开"。
 * 位置存成比例（0~1），换窗口大小、换分辨率都不会跑到屏幕外面去。
 */

const FLOAT_SIZE = 46;
const FLOAT_MARGIN = 8;

function clamp01(v) {
    return Math.min(1, Math.max(0, v));
}

function floatPosToPx(pos) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const p = pos && typeof pos.x === 'number' && typeof pos.y === 'number'
        ? pos
        : { x: 0.972, y: 0.78 }; // 默认贴在右下，输入框上方一点
    const maxX = Math.max(FLOAT_MARGIN, vw - FLOAT_SIZE - FLOAT_MARGIN);
    const maxY = Math.max(FLOAT_MARGIN, vh - FLOAT_SIZE - FLOAT_MARGIN);
    return {
        left: Math.min(maxX, Math.max(FLOAT_MARGIN, clamp01(p.x) * vw - FLOAT_SIZE / 2)),
        top: Math.min(maxY, Math.max(FLOAT_MARGIN, clamp01(p.y) * vh - FLOAT_SIZE / 2))
    };
}

function unmountFloat() {
    const el = document.querySelector('.fs-float');
    if (el) el.remove();
}

function mountFloat() {
    if (!isMainWindow()) return;
    if (STATE.config && STATE.config.showFloat === false) return;
    if (document.querySelector('.fs-float')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fs-root fs-float';
    btn.setAttribute('data-fs-theme', detectThemeFromDom());
    btn.title = `合并转发搜索（快捷键 ${(STATE.config && STATE.config.hotkey) || 'Alt+S'}）`;
    btn.innerHTML = `
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <circle cx="8.6" cy="8.6" r="5.4" stroke="currentColor" stroke-width="1.8"/>
            <path d="M12.8 12.8L16.6 16.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        </svg>`;

    const place = (pos) => {
        const { left, top } = floatPosToPx(pos);
        btn.style.left = left + 'px';
        btn.style.top = top + 'px';
    };
    place(STATE.config && STATE.config.floatPos);

    // 拖动 + 点击（移动超过 4px 就算拖动，不触发打开）
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let offsetX = 0;
    let offsetY = 0;

    btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        dragging = true;
        moved = false;
        const r = btn.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        offsetX = e.clientX - r.left;
        offsetY = e.clientY - r.top;
        btn.classList.add('is-dragging');
        try {
            btn.setPointerCapture(e.pointerId);
        } catch (_) { /* 忽略 */ }
    });

    btn.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        if (Math.abs(e.clientX - startX) > 4 || Math.abs(e.clientY - startY) > 4) moved = true;
        if (!moved) return;
        const maxX = window.innerWidth - FLOAT_SIZE - FLOAT_MARGIN;
        const maxY = window.innerHeight - FLOAT_SIZE - FLOAT_MARGIN;
        btn.style.left = Math.min(maxX, Math.max(FLOAT_MARGIN, e.clientX - offsetX)) + 'px';
        btn.style.top = Math.min(maxY, Math.max(FLOAT_MARGIN, e.clientY - offsetY)) + 'px';
    });

    btn.addEventListener('pointerup', (e) => {
        if (!dragging) return;
        dragging = false;
        btn.classList.remove('is-dragging');
        try {
            btn.releasePointerCapture(e.pointerId);
        } catch (_) { /* 忽略 */ }

        if (!moved) {
            if (STATE.open) closePanel();
            else openPanel();
            return;
        }

        // 松手后记住位置：存比例，下次换窗口大小也不跑偏
        const r = btn.getBoundingClientRect();
        const pos = {
            x: clamp01((r.left + FLOAT_SIZE / 2) / window.innerWidth),
            y: clamp01((r.top + FLOAT_SIZE / 2) / window.innerHeight)
        };
        STATE.config.floatPos = pos;
        if (bridge) bridge.patchConfig({ floatPos: pos });
        diag(`[float] 位置已保存 x=${pos.x.toFixed(3)} y=${pos.y.toFixed(3)}`);
    });

    document.body.appendChild(btn);
    const fr = btn.getBoundingClientRect();
    diag(`[float] 悬浮按钮已挂载 rect=${Math.round(fr.left)},${Math.round(fr.top)} ${Math.round(fr.width)}x${Math.round(fr.height)} vw=${window.innerWidth}`);
}

/* ---------- 入口按钮 ----------
 * 快捷键难免会被占用或者被用户忘掉，所以主面板右上角常驻一个小按钮。
 * 为什么用 position: fixed 挂在 body 上，而不是插进 QQ 的顶栏 DOM：
 * QQ 是 Vue 应用，顶栏会随状态重渲染，插进去的节点随时可能被抹掉；
 * 固定定位的节点属于我们自己的，QQ 怎么渲染都不影响它。
 */

/** 当前窗口是不是 QQ 主面板（聊天小窗、登录页、隐藏窗口都不算） */
function isMainWindow() {
    try {
        if (String(location.href).indexOf('index.html') < 0) return false;
        return !!document.querySelector('.sidebar');
    } catch (_) {
        return false;
    }
}

function mountLauncher() {
    if (!isMainWindow()) return;
    if (document.querySelector('.fs-launcher')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fs-root fs-launcher';
    // 跟 QQ 顶栏自身的深浅走，而不是弹窗设置里的主题
    btn.setAttribute('data-fs-theme', detectThemeFromDom());
    btn.title = `搜索合并转发卡片（快捷键 ${(STATE.config && STATE.config.hotkey) || 'Alt+S'}）`;
    btn.innerHTML = `
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="4.4" stroke="currentColor" stroke-width="1.5"/>
            <path d="M10.4 10.4L13.4 13.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <span>卡片搜索</span>`;

    // 用 mousedown 而不是 click：QQ 顶栏有拖拽逻辑，先抢在前面把事件停掉
    btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (STATE.open) closePanel();
        else openPanel();
    });

    document.body.appendChild(btn);
    const r = btn.getBoundingClientRect();
    diag(`[launcher] 入口按钮已挂载 rect=${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`);
}

/* ---------- 启动 ---------- */

async function bootstrap() {
    // 同一个窗口里只装一次
    if (window.__forwardSearchMounted) return;
    window.__forwardSearchMounted = true;
    diag('[renderer] bootstrap 开始');

    // preload 有可能比渲染层晚一步挂上，这里再取一次
    if (!bridge && window.forwardSearch) bridge = window.forwardSearch;

    injectStyleOnce();
    watchTheme();

    // 读配置。读不到就用一份保守的默认值，保证界面还能打开。
    try {
        const res = bridge ? await bridge.getConfig() : null;
        STATE.config = res && res.ok ? res.data : { hotkey: 'Alt+S', debounce: 220, maxResults: 60, contentMode: false, onboarded: false, theme: 'system' };
    } catch (_) {
        STATE.config = { hotkey: 'Alt+S', debounce: 220, maxResults: 60, contentMode: false, onboarded: false, theme: 'system' };
    }

    // 配置拿到了才知道该跟系统还是锁深浅，这里定一次基调
    applyTheme();
    diag(`[renderer] config 已读 theme=${STATE.config && STATE.config.theme} hotkey=${STATE.config && STATE.config.hotkey}`);

    setupHotkey();
    mountLauncher();
    mountFloat();

    // 窗口大小变了，按比例重新摆一次悬浮按钮（比例坐标不会跑出可见区域）
    window.addEventListener('resize', () => {
        const el = document.querySelector('.fs-float');
        if (!el || !STATE.config) return;
        const { left, top } = floatPosToPx(STATE.config.floatPos);
        el.style.left = left + 'px';
        el.style.top = top + 'px';
    });

    // QQ 某些操作会把 body 重渲染，按钮要是被抹掉了就补回来（3 秒一查，成本可忽略）
    if (isMainWindow()) {
        setInterval(() => {
            if (!document.querySelector('.fs-launcher')) mountLauncher();
            if (!document.querySelector('.fs-float')) mountFloat();
        }, 3000);
    }

    // 排障开关：config.json 里把 debugAutoOpen 设为 true，启动后会自己弹一次搜索框，
    // 方便远程排查"界面长什么样"。默认关闭，正常使用不需要动它。
    if (STATE.config && STATE.config.debugAutoOpen && isMainWindow()) {
        setTimeout(() => {
            if (!STATE.open) openPanel();
        }, 1500);
    }

    // 排障开关：debugAutoScan 打开后启动即扫描（不点按钮也能跑），用来验证内核接口是否可用。
    // 数量故意给得小，避免一上来就发一堆请求。
    if (STATE.config && STATE.config.debugAutoScan && isMainWindow()) {
        setTimeout(() => {
            diag('[scan] debugAutoScan 触发');
            scanHistory(40).catch((err) => diag('[scan] 异常 ' + err));
        }, 4000);
    }

    if (!bridge) {
        console.error('[forward-search] 没有拿到桥接接口，插件功能不可用（请检查 preload 是否加载）');
    } else {
        log('插件已就绪，快捷键', STATE.config.hotkey);
    }
}

// 等 QQ 自己的界面挂载完再动手，避免抢跑
if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(bootstrap, 800);
} else {
    window.addEventListener('DOMContentLoaded', () => setTimeout(bootstrap, 800));
}
