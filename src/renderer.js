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
    // 检索范围：current = 只看眼下打开的这个会话，all = 全部会话
    scope: 'current',
    // 上一次搜索实际用的范围，用来判断"当前会话没结果"要不要提示切全部
    scopeUsed: 'current',
    // 排序方式：relevance = 相关度（默认），time = 按时间
    sortBy: 'relevance'
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
            <div class="fs-titlebar">
                <span class="fs-titlebar-name">合并转发搜索</span>
                <button class="fs-titlebar-close" type="button" title="关闭" aria-label="关闭">
                    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
                    </svg>
                </button>
            </div>
            <div class="fs-search">
                <svg class="fs-search-icon" viewBox="0 0 16 16" fill="none">
                    <circle cx="7" cy="7" r="5" stroke="currentColor" stroke-width="1.6"/>
                    <path d="M11 11L14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
                </svg>
                <input class="fs-input" type="text" spellcheck="false" placeholder="搜索合并转发卡片里的内容…" />
                <span class="fs-hotkey"></span>
            </div>
            <div class="fs-scope">
                <button class="fs-scope-btn" type="button" data-scope="current"></button>
                <button class="fs-scope-btn" type="button" data-scope="all">全部会话</button>
                <span class="fs-scope-spacer"></span>
                <button class="fs-sort-btn" type="button" data-sort="relevance">相关度</button>
                <button class="fs-sort-btn" type="button" data-sort="time">按时间</button>
                <span class="fs-scope-count"></span>
            </div>
            <div class="fs-dock-head">
                <span class="fs-dock-dot"></span>
                <span class="fs-dock-text"></span>
                <button class="fs-dock-expand" type="button">展开</button>
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
    const panel = mask.querySelector('.fs-panel');
    const titlebar = mask.querySelector('.fs-titlebar');

    // 标题栏右上角的关闭按钮：跟 Esc / 点遮罩一样，直接关掉
    mask.querySelector('.fs-titlebar-close').addEventListener('click', (e) => {
        e.stopPropagation();
        closePanel();
    });

    // 拖动标题栏移动面板（在遮罩内自由摆放，松手停住，位置不重置）
    makeDraggable(panel, titlebar);

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

    // 检索范围：默认跟着眼下打开的这个会话，也可以切成全部会话
    const scope = mask.querySelector('.fs-scope');
    scope.querySelectorAll('.fs-scope-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const next = btn.dataset.scope;
            if (btn.disabled || STATE.scope === next) return;
            STATE.scope = next;
            renderScopeBar();
            if (STATE.query) doSearch();
            input.focus();
        });
    });

    // 排序：相关度 / 按时间
    scope.querySelectorAll('.fs-sort-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const next = btn.dataset.sort;
            if (STATE.sortBy === next) return;
            STATE.sortBy = next;
            renderScopeBar();
            if (STATE.query) doSearch();
            input.focus();
        });
    });

    // 停靠状态下的"展开"，回到大面板继续搜
    const dockHead = mask.querySelector('.fs-dock-head');
    dockHead.querySelector('.fs-dock-expand').addEventListener('click', () => undockPanel());

    // 停靠时焦点往往不在输入框上，Esc / 回车 / 上下键得在文档级兜住
    document.addEventListener('keydown', (e) => {
        if (!STATE.open || !isDocked()) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            closePanel();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            openActive();
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            moveActive(1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            moveActive(-1);
        }
    });

    ui = { mask, panel, input, body, scope, dockHead };
    return ui;
}

/* ---------- 面板拖动 ----------
 * 按住标题栏拖动，面板在遮罩内自由移动；松手就停在当前位置，不自动回中。
 * 用 pointer 事件 + setPointerCapture，比 mouse 事件更稳，也兼容触摸。
 */
function makeDraggable(panel, handle) {
    if (!panel || !handle) return;

    handle.addEventListener('pointerdown', (e) => {
        // 点的是关闭按钮就不拖（关闭按钮在标题栏里）
        if (e.target && e.target.closest('.fs-titlebar-close')) return;

        e.preventDefault();
        const mask = panel.parentElement;
        if (!mask) return;

        // 记下拖动起点：面板当前左上角（未定位时按当前可视位置算）
        let baseLeft = panel.offsetLeft;
        let baseTop = panel.offsetTop;
        if (!mask.classList.contains('fs-panel-dragging')) {
            // 首次拖动：把面板从 flex 居中切到绝对定位，并锁定当前位置
            const pr = panel.getBoundingClientRect();
            const mr = mask.getBoundingClientRect();
            baseLeft = pr.left - mr.left;
            baseTop = pr.top - mr.top;
            mask.classList.add('fs-panel-dragging');
        }

        const startX = e.clientX;
        const startY = e.clientY;

        const onMove = (ev) => {
            const dx = ev.clientX - startX;
            const dy = ev.clientY - startY;
            let left = baseLeft + dx;
            let top = baseTop + dy;

            // 不让面板被拖出可视区域
            const pw = panel.offsetWidth;
            const ph = panel.offsetHeight;
            const mw = mask.clientWidth;
            const mh = mask.clientHeight;
            left = Math.max(0, Math.min(left, mw - pw));
            top = Math.max(0, Math.min(top, mh - ph));

            panel.style.left = left + 'px';
            panel.style.top = top + 'px';
        };

        const onUp = () => {
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', onUp);
            handle.removeEventListener('pointercancel', onUp);
            if (handle.releasePointerCapture) {
                try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
            }
        };

        try { handle.setPointerCapture(e.pointerId); } catch (_) {}
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        handle.addEventListener('pointercancel', onUp);
    });
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
        ui.mask.classList.remove('is-docked');
        renderScopeBar();
        renderResultsArea();
        if (STATE.query) doSearch();
    }

    // 重置拖动状态：每次打开都回到居中，不带上次拖动的位置
    ui.mask.classList.remove('fs-panel-dragging');
    if (ui.panel) {
        ui.panel.style.left = '';
        ui.panel.style.top = '';
    }

    // 排障用：config 里写了 debugAutoQuery 就自动填好关键词并搜一次，
    // 方便截图/远程看"搜出来长什么样"。默认没有这个配置项。
    if (STATE.config && STATE.config.debugAutoQuery && !STATE.query) {
        ui.input.value = STATE.query = STATE.config.debugAutoQuery;
        doSearch();
    }

    ui.mask.style.display = 'flex';
    hideWatchBar();
    STATE.open = true;
    setTimeout(() => ui.input.focus(), 30);
    refreshStats();
}

function closePanel() {
    if (!ui) return;
    ui.mask.style.display = 'none';
    ui.mask.classList.remove('is-docked');
    STATE.open = false;
    STATE.mode = 'search';
    // 关键词和结果留着：定位完想再搜同一条时，不用重敲一遍
    // （以前这里会把 query 清空，导致"回到搜索结果"没东西可回）
}

/* ---------- 检索范围：当前会话 / 全部会话 ---------- */

function renderScopeBar() {
    if (!ui || !ui.scope) return;

    const peer = currentPeer();
    const curBtn = ui.scope.querySelector('[data-scope="current"]');
    const allBtn = ui.scope.querySelector('[data-scope="all"]');
    if (!curBtn || !allBtn) return;

    if (!peer) {
        // 右侧还是"选个会话"的空白页，"当前会话"就没有意义了
        if (STATE.scope === 'current') STATE.scope = 'all';
        curBtn.disabled = true;
        curBtn.innerHTML = '<span class="fs-scope-name">当前会话</span>';
        curBtn.title = '先在 QQ 里打开一个聊天，才能只搜那个会话';
    } else {
        curBtn.disabled = false;
        curBtn.innerHTML =
            `<span class="fs-scope-dot" style="background:${peerColor(peer.peerUid)}"></span>` +
            `<span class="fs-scope-name">${esc(shortName(peer.name || '当前会话'))}</span>`;
        curBtn.title = `只搜这个会话：${peer.name || peer.peerUid}`;
    }

    curBtn.classList.toggle('is-on', STATE.scope === 'current');
    allBtn.classList.toggle('is-on', STATE.scope === 'all');

    // 排序按钮高亮
    ui.scope.querySelectorAll('.fs-sort-btn').forEach((btn) => {
        btn.classList.toggle('is-on', btn.dataset.sort === STATE.sortBy);
    });

    updateScopeCount();
}

function updateScopeCount() {
    if (!ui || !ui.scope) return;
    const box = ui.scope.querySelector('.fs-scope-count');
    if (!box) return;
    if (STATE.searching) {
        box.textContent = '搜索中…';
        return;
    }
    if (!STATE.query || !STATE.results.length) {
        box.textContent = '';
        return;
    }
    box.textContent = STATE.scopeUsed === 'current' ? `本会话 ${STATE.results.length} 条` : `${STATE.results.length} 条`;
}

/* ---------- 传送后停靠 ----------
 * 传送到位之后不再"啪"一下把面板关掉：缩到右下角停着，把聊天区让出来，
 * 但搜索结果还在，可以接着点下一条。要关就 Esc，要还原就点「展开」。
 */
function dockPanel(note) {
    if (!ui) return;

    STATE.mode = 'search';
    STATE.open = true;
    // 停靠前清掉拖动残留，让停靠条用 flex 正常摆到右下角
    ui.mask.classList.remove('fs-panel-dragging');
    if (ui.panel) {
        ui.panel.style.left = '';
        ui.panel.style.top = '';
    }
    ui.mask.classList.add('is-docked');

    const text = ui.dockHead && ui.dockHead.querySelector('.fs-dock-text');
    const dot = ui.dockHead && ui.dockHead.querySelector('.fs-dock-dot');
    const peer = currentPeer();

    if (text) text.textContent = note || (peer ? `已传送到「${peer.name || peer.peerUid}」` : '已传送');
    if (dot) dot.style.background = peer ? peerColor(peer.peerUid) : 'var(--fs-accent)';

    renderScopeBar();
    renderResultsArea();
}

function undockPanel() {
    if (!ui) return;
    ui.mask.classList.remove('is-docked');
    STATE.open = true;
    renderScopeBar();
    renderResultsArea();
    setTimeout(() => ui.input.focus(), 30);
}

function isDocked() {
    return !!(ui && ui.mask.classList.contains('is-docked'));
}

/* ---------- 各区域的渲染 ---------- */

function renderResultsArea() {
    if (!ui) return;
    const body = ui.body;
    updateScopeCount();

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
        const peer = currentPeer();

        // 只搜了当前会话却没结果：直接给一个"去全部会话找找"的出口
        if (STATE.scopeUsed === 'current' && peer) {
            body.innerHTML = `
            <div class="fs-state">
                <strong>「${esc(shortName(peer.name || '这个会话', 18))}」里没有找到</strong>
                这个会话里没收录到匹配的卡片。换个词，或者去别的会话找找。
                <div><button class="fs-btn fs-act-allscope">搜全部会话</button></div>
                <div class="fs-hint">索引里只有你打开过、或别人发来时被动存下来的卡片。</div>
            </div>`;
            const allBtn2 = body.querySelector('.fs-act-allscope');
            if (allBtn2) {
                allBtn2.addEventListener('click', () => {
                    STATE.scope = 'all';
                    renderScopeBar();
                    doSearch();
                });
            }
            return;
        }

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

    const peerNow = currentPeer();
    body.innerHTML = STATE.results
        .map((card, i) => {
            const active = i === STATE.activeIndex ? ' is-active' : '';
            const countBadge = card.count > 0 ? `<span class="fs-badge">共 ${card.count} 条</span>` : '';
            const pending = card.innerState === 0 ? '<span class="fs-badge" style="opacity:.6">内容未补全</span>' : '';

            // 每个群一个固定颜色 + 首字，多个群混在一起时一眼能分清是哪一个
            const hue = peerHue(card.peerUid);
            const initial = (card.peerName || '群').trim().slice(0, 1);
            const isHere = !!(peerNow && String(card.peerUid) === peerNow.peerUid);
            const hereTag = isHere ? '<span class="fs-badge-here">当前</span>' : '';

            return `
                <div class="fs-item${active}${isHere ? ' is-here' : ''}" data-index="${i}">
                    <div class="fs-item-head">
                        <span class="fs-item-avatar" style="--h:${hue}">${esc(initial)}</span>
                        <span class="fs-item-group">${esc(card.peerName || '未知群聊')}</span>
                        <span class="fs-dot"></span>
                        <span class="fs-item-time">${formatTime(card.msgTime)}</span>
                        ${hereTag}${countBadge}${pending}
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

    // 范围：默认只看眼下这个会话，用户切到"全部会话"才搜全库
    const peer = currentPeer();
    const scoped = STATE.scope === 'current' && peer ? peer.peerUid : '';
    STATE.scopeUsed = scoped ? 'current' : 'all';

    try {
        const res = await bridge.search(
            STATE.query,
            (STATE.config && STATE.config.maxResults) || 60,
            scoped,
            STATE.sortBy
        );
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

/* ==================================================================
 * 直达通道：借 QQ 自己的 AIO 接口，一步跳到那条消息
 * ==================================================================
 * 老办法是"替你往上滚轮翻页"：一张十小时前的卡片要翻几十屏，根本没法用。
 *
 * 真机上挖到了 QQ 前端自己的跳转入口（9.9.31 验证通过）：
 *
 *   `.chat-msg-area.__VUE__`     QQ 把当前挂载的 Vue 组件实例挂在这个数组上，
 *                                顺着实例的 parent 往上走，能拿到 AIO 面板的 ctx
 *   ctx.aioStore.setData(peer)   切换会话，不需要这个会话出现在左侧列表里
 *   ctx.msgAction.jumpToAioMessage({ action: { payload: {
 *       msgId, msgSeq, msgClientSeq, msgTime } } })
 *                                一步定位到那条消息，缺的历史由 QQ 自己加载
 *
 * 这条路不模拟滚轮、不要用户手动翻，点到哪条就到哪条。
 * 任何一环拿不到（QQ 改结构 / 消息已删除），自动退回老的滚轮方案。
 */

/** 拿 AIO 面板的组件上下文；拿不到返回 null */
function aioCtx() {
    const host = document.querySelector('.chat-msg-area');
    const insts = host && host.__VUE__;
    if (!insts || !insts.length) return null;

    for (let i = 0; i < insts.length; i++) {
        let inst = insts[i];
        let guard = 0;
        while (inst && guard++ < 24) {
            const ctx = inst.ctx;
            if (ctx && ctx.$MsgList && ctx.msgAction) return ctx;
            inst = inst.parent;
        }
    }
    return null;
}

/** 轮询等到条件成立，超时返回最后一次的结果 */
async function waitFor(fn, timeout = 2000, step = 90) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
        try {
            const v = fn();
            if (v) return v;
        } catch (_) {
            /* 组件树中途变化会抛错，忽略继续等 */
        }
        await sleep(step);
    }
    try {
        return fn() || null;
    } catch (_) {
        return null;
    }
}

/** 当前 AIO 里打开的会话 uid */
function currentAioUid(ctx) {
    const c = ctx || aioCtx();
    if (!c || !c.curAioData || !c.curAioData.header) return '';
    return String(c.curAioData.header.uid || '');
}

/**
 * 眼下打开的是哪个会话。
 * 群的 peerUid 就是群号，好友是 u_xxx，跟索引里存的 peerUid 是同一套值。
 * 没打开会话（右侧还是"选个会话"的空白页）时返回 null。
 */
function currentPeer() {
    const ctx = aioCtx();
    if (!ctx || !ctx.curAioData || !ctx.curAioData.header) return null;

    const h = ctx.curAioData.header;
    const uid = String(h.uid || '');
    if (!uid) return null;

    return {
        peerUid: uid,
        chatType: Number(ctx.curAioData.chatType) || 1,
        name: String(h.peerName || h.remark || ''),
        uin: String(h.uin || '')
    };
}

/** 由会话 id 生成一个稳定色相，同一个群永远是同一个颜色 */
function peerHue(peerUid) {
    const s = String(peerUid || '');
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
}

function peerColor(peerUid) {
    return `hsl(${peerHue(peerUid)} 58% 50%)`;
}

/** 群名太长时截一下，别把头部撑爆 */
function shortName(name, max = 14) {
    const s = String(name || '');
    if (s.length <= max) return s;
    return s.slice(0, max) + '…';
}

/**
 * QQ 刚启动、还没点过任何会话时，右侧是"选个会话"的空页面，
 * `.aio` 容器是 display:none。这时候只改 store 数据界面上什么都看不到，
 * 所以先把它顶开。等用户之后点别的会话，QQ 自己会把状态纠正回来。
 */
function ensureAioVisible() {
    const aio = document.querySelector('.aio');
    if (!aio) return false;
    if (getComputedStyle(aio).display !== 'none') return false;

    try {
        aio.style.display = 'flex';
        const empty = document.querySelector('.empty-panel');
        if (empty) empty.style.display = 'none';
        diag('[jump] 聊天区原本是隐藏的，先顶开');
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * 用 QQ 自己的 aioStore 切会话。
 * 比点击会话列表更硬：目标会话不在"最近聊天"里也能切过去。
 */
async function switchPeerByStore(card) {
    const ctx = aioCtx();
    if (!ctx || !ctx.aioStore || typeof ctx.aioStore.setData !== 'function') return false;

    const peerUid = String(card.peerUid || '');
    if (!peerUid) return false;

    try {
        const p = ctx.aioStore.setData({
            peerUid,
            chatType: Number(card.chatType) || 1,
            independent: 0,
            showMiniDetail: false,
            peerName: card.peerName || '',
            uin: String(card.peerUin || peerUid),
            memberName: null,
            unreadCnt: '0',
            remark: '',
            appid: ''
        });
        if (p && p.then) await p;
    } catch (err) {
        diag(`[jump] aioStore.setData 失败 ${err}`);
        return false;
    }

    return !!(await waitFor(() => currentAioUid() === peerUid, 2600));
}

/**
 * 直达：切会话 + 定位到那条消息。
 * @returns {Promise<boolean>} true 表示已经站在卡片上（已高亮）
 */
async function directJumpToCard(card) {
    if (!card || !card.msgId) return false;

    const ctx = aioCtx();
    if (!ctx) {
        diag('[jump] 拿不到 AIO 上下文，走老路');
        return false;
    }

    const peerUid = String(card.peerUid || '');

    // 1) 切会话：先点列表（用户能看到选中态），点不到再动 store
    if (peerUid && currentAioUid(ctx) !== peerUid) {
        let ok = false;
        if (clickChatInUi(card)) {
            ok = !!(await waitFor(() => currentAioUid() === peerUid, 1500));
        }
        if (!ok) ok = await switchPeerByStore(card);
        if (!ok) {
            diag(`[jump] 切会话失败 peer=${peerUid}`);
            return false;
        }
    }

    // 2) 界面得先真的把聊天区显示出来，否则后面滚/定位都是对着 display:none 做无用功
    if (ensureAioVisible()) await sleep(350);

    // 3) 等首屏消息就绪，否则 jump 会扑空
    await waitFor(() => {
        const c = aioCtx();
        return c && c.$MsgList && c.$MsgList.msgs && c.$MsgList.msgs.length > 0;
    }, 2400);

    const live = aioCtx();
    if (!live || !live.msgAction || typeof live.msgAction.jumpToAioMessage !== 'function') {
        diag('[jump] 没有 jumpToAioMessage');
        return false;
    }

    const payload = {
        msgId: String(card.msgId),
        msgSeq: String(card.msgSeq || '0'),
        msgClientSeq: '0',
        msgTime: String(card.msgTime || 0)
    };

    // 3) 向 QQ 要一次真实消息：记录里的 seq/time 是采集时的快照，可能对不上
    try {
        const peer = { chatType: Number(card.chatType) || 1, peerUid, guildId: '' };
        const res = await Promise.race([
            live.msgApis.getMsgs({ peer, msgId: payload.msgId, queryOrder: true }),
            sleep(2500).then(() => null)
        ]);
        const list = res && (res.msgList || (Array.isArray(res) ? res : null));
        if (list && list.length) {
            const hit = list.find((m) => String(m.msgId) === payload.msgId);
            if (hit) {
                payload.msgSeq = String(hit.msgSeq || payload.msgSeq);
                payload.msgTime = String(hit.msgTime || payload.msgTime);
                payload.msgClientSeq = String(hit.clientSeq || '0');
            }
        }
    } catch (err) {
        diag(`[jump] 取真实消息失败，用记录里的 seq/time：${err}`);
    }

    // 4) 让 QQ 自己跳
    try {
        const p = live.msgAction.jumpToAioMessage({ action: { payload } });
        if (p && p.then) await p;
        diag(`[jump] jumpToAioMessage id=${payload.msgId} seq=${payload.msgSeq}`);
    } catch (err) {
        diag(`[jump] jumpToAioMessage 抛错 ${err}`);
    }

    let node = await waitFor(() => findCardNode(card), 3000);

    // 5) 兜底：消息已经在列表里但没滚到，直接让列表滚
    if (!node) {
        const c2 = aioCtx();
        try {
            if (c2 && c2.$MsgList && typeof c2.$MsgList.scrollToMsg === 'function') {
                const p = c2.$MsgList.scrollToMsg({ id: payload.msgId });
                if (p && p.then) await p;
                diag('[jump] 改用 $MsgList.scrollToMsg');
            }
        } catch (err) {
            diag(`[jump] scrollToMsg 抛错 ${err}`);
        }
        node = await waitFor(() => findCardNode(card), 2600);
    }

    if (!node) {
        diag('[jump] 直达后 DOM 里仍没有这条消息');
        return false;
    }

    // 虚拟列表刚把节点插进来时还没排版（宽高都是 0），这时候画圈会画在左上角。
    // 等它真正有尺寸再圈，通常只差一两帧。
    node = (await waitFor(() => {
        const el = findCardNode(card);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 ? el : null;
    }, 1800)) || node;

    highlightLocated(node);
    diag('[jump] 直达成功');
    return true;
}

/**
 * 把用户送到这张卡片"本身"。
 * 先走直达通道，失败再退回老的滚轮翻页。
 */
async function tryJumpToChat(card, opts) {
    const autoClose = !(opts && opts.keepPanel);
    jumpNotice = '';

    // 直达通道可用时，成败就是定论：要么站到卡片上，要么这条消息真的没了。
    // 不再退回滚轮——"消息不在了"这种情况，翻几十屏也翻不出来。
    if (aioCtx()) {
        if (await directJumpToCard(card)) {
            // 传送到了就停靠在角落，不把面板收走——还想点下一条随时能点
            if (autoClose) dockPanel(`已传送到「${(currentPeer() && currentPeer().name) || card.peerName || '聊天'}」`);
            showWatchBar('已传送到这张卡片（蓝圈标出，往上一点就是它）', 'hit');
            hideWatchBar(4200);
            return true;
        }
        // 没传送到，就别把详情页也收走——用户至少还能看内容
        jumpNotice = '聊天记录里找不到这条消息了，可能已被撤回或删除。下面是这张卡片能读到的内容。';
        renderDetail();
        showWatchBar('聊天记录里找不到这条消息了，可能已被撤回或删除', 'miss');
        hideWatchBar(8000);
        return false;
    }

    // —— 以下是老路：只有 QQ 改版、直达接口拿不到时才会走到 ——

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

    // 2. 等界面把消息渲染出来，先看这一屏有没有
    await sleep(800);
    let node = locateCardInView(card);

    if (node) {
        jumpNotice = '';
        if (autoClose) setTimeout(() => dockPanel(), 300);
        showWatchBar('已定位到这张卡片（蓝圈就在聊天区），圈 2.6 秒后自动消失', 'hit');
        hideWatchBar(4000);
        return true;
    }

    // 3. 不在这一屏：先收起弹窗（遮罩会挡滚轮），然后让主进程替你往上翻。
    //    这是唯一能真正把人送到卡片的方式——QQ 的列表只认真实滚轮。
    if (autoClose) dockPanel();
    showWatchBar(`正在替你往上翻「${card.peerName || '聊天'}」，找到就圈出来…`);
    node = await autoScrollToCard(card, {
        budget: 25000,
        onProgress: (n) => showWatchBar(`正在往上翻「${card.peerName || '聊天'}」… 第 ${n} 屏`)
    });

    if (node) {
        highlightLocated(node);
        showWatchBar('已定位到这张卡片（蓝圈），往上一点就是它', 'hit');
        hideWatchBar(5000);
        return true;
    }

    // 4. 翻不动（不是前台 / 已经到顶 / 卡片太旧没加载）：退回"陪用户翻"，并且说清原因。
    const watching = watchCardInChat(card, {
        open: false,
        onHit: () => {
            showWatchBar('找到了，就是这张（蓝圈已标出）', 'hit');
            hideWatchBar(4000);
        },
        onTimeout: () => {
            showWatchBar('两分钟没翻到这张卡片，多半是消息太旧、还没被加载出来', 'miss');
            hideWatchBar(9000);
        }
    });

    if (watching) {
        showWatchBar(`没能自动翻到，继续盯着「${card.peerName || '聊天'}」· 你往上翻，看到就圈出来`);
    } else {
        showWatchBar(`已切到「${card.peerName || '聊天'}」，但没能开始盯梢，往上翻翻看`, 'miss');
        hideWatchBar(6000);
    }
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

/**
 * 聊天消息区。
 *
 * 真机上（QQ 9.9.31）是 `.chat-msg-area` 里的虚拟列表 `.ml-list`：
 * 它自己不做原生滚动——高度永远等于可视高度，滑动由 QQ 自己的逻辑接管，
 * 所以 `scrollTop` / `scrollIntoView` / 合成 wheel 事件统统推不动它。
 * 这条是量出来的：连 `:hover` 都进不去，只有真实鼠标滚轮才管用。
 *
 * 结论：插件不能"替用户翻"，只能"陪用户翻"——
 * 切到会话后盯着这块区域，用户一翻到那张卡片，我们立刻圈住它。
 */
function chatRoot() {
    const byClass = document.querySelector('.chat-msg-area') || document.querySelector('.ml-list');
    if (byClass) return byClass;

    // 老版本/别的皮肤：退回"右侧最大的可滚动块"
    const vw = window.innerWidth;
    let best = null;
    document.querySelectorAll('div, ul, section, main').forEach((el) => {
        if (!el || el.nodeType !== 1 || (el.closest && el.closest('.fs-root'))) return;
        const st = getComputedStyle(el);
        if (!/(auto|scroll|overlay)/.test(st.overflowY)) return;
        if (el.scrollHeight <= el.clientHeight + 40 || el.clientHeight < 140) return;
        const r = el.getBoundingClientRect();
        if (r.width < 200 || r.right < vw * 0.35) return;
        const area = r.width * r.height;
        if (!best || area > best.area) best = { el, area };
    });
    return best ? best.el : null;
}

/**
 * 真正的滚动容器。
 *
 * `.chat-msg-area` 只是外壳，里面 `.q-scroll-view`（id=ml-root）才是 QQ 的滚动层：
 * 它的 scrollHeight 固定 300000、scrollTop 会被 QQ 立刻压回 0.x，
 * 所以 `scrollTop=` 这条路不通，只能靠真实滚轮（由主进程代发）。
 */
function chatScroller() {
    return (
        document.querySelector('.chat-msg-area .q-scroll-view') ||
        document.querySelector('#ml-root') ||
        document.querySelector('.q-scroll-view') ||
        chatRoot()
    );
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

/**
 * 按消息 id 精确找卡片。
 *
 * 真机上每条消息渲染出来的 DOM id 就是它的 msgId（`.ml-item#7703832830172393598`），
 * 所以只要它被渲染出来，就能一次命中——比按文字模糊匹配可靠得多。
 */
function findCardNode(card) {
    if (!card || !card.msgId) return null;
    const root = chatRoot();
    const node = document.getElementById(String(card.msgId));
    if (node && root && root.contains(node)) return node;
    return null;
}

/** 在"当前这一屏"里定位。找得到就圈出来，找不到返回 null */
function locateCardInView(card) {
    const root = chatRoot();
    if (!root) {
        diag('[locate] 没有聊天区');
        return null;
    }

    // 先按 msgId 精确找，找不到再退回文字匹配（兼容别的 QQ 版本）
    const exact = findCardNode(card);
    if (exact) {
        if (exact.scrollIntoView) {
            try {
                exact.scrollIntoView({ block: 'center' });
            } catch (_) { /* 忽略 */ }
        }
        highlightLocated(exact);
        diag('[locate] 按 msgId 命中');
        return exact;
    }

    const hit = searchCardIn(root, card, locateNeedles(card));
    if (!hit) {
        diag('[locate] 当前这一屏没有匹配');
        return null;
    }
    if (hit.el.scrollIntoView) hit.el.scrollIntoView({ block: 'center' });
    highlightLocated(hit.el);
    diag(`[locate] 文字命中 score=${hit.score} class=${String(hit.el.className).slice(0, 40)}`);
    return hit.el;
}

/**
 * 把卡片滚到可视区中间。
 * QQ 自己管滚动，所以只能继续投小批量滚轮，一点点挪。
 */
async function centerCard(node, sc) {
    const pos = {
        x: Math.round(sc.getBoundingClientRect().left + sc.getBoundingClientRect().width / 2),
        y: Math.round(sc.getBoundingClientRect().top + sc.getBoundingClientRect().height / 2)
    };
    for (let i = 0; i < 6; i++) {
        const cur = findCardNode({ msgId: node.id });
        if (!cur) return null;
        const r = cur.getBoundingClientRect();
        const a = sc.getBoundingClientRect();
        if (r.top >= a.top + 6 && r.bottom <= a.bottom - 6) return cur;
        const dir = r.top < a.top ? 'up' : 'down';
        const res = await bridge.scrollChatUp(Object.assign({ notches: 2, dir }, pos));
        if (!res || !res.ok || !res.data || !res.data.ok) return cur;
        await sleep(380);
    }
    return findCardNode({ msgId: node.id });
}

/**
 * 替用户往上翻，直到那张卡片被 QQ 渲染出来。这是"真正把人送到卡片"的唯一办法：
 * QQ 的消息区只认真实滚轮，所以由主进程往它的 webContents 里投滚轮，每翻一批用
 * msgId 精确查一次，命中就停下来并把它挪到可视区中间。
 *
 * @param {object} card
 * @param {{budget?:number, onProgress?:(round:number)=>void}} opts
 * @returns {Promise<Element|null>}
 */
async function autoScrollToCard(card, opts) {
    if (!card || !card.msgId) return null;
    if (!bridge || !bridge.scrollChatUp) return null;

    const sc = chatScroller();
    if (!sc) return null;
    const rect0 = sc.getBoundingClientRect();
    if (rect0.width < 120 || rect0.height < 80) return null;

    const pos = {
        x: Math.round(rect0.left + rect0.width / 2),
        y: Math.round(rect0.top + rect0.height / 2)
    };
    // 进度只能看"内容有没有换"：QQ 每加载完一页会把 scrollTop 重置回 0，
    // 所以滚动偏移不能当进度用，必须看首条消息的 id 和它的位置。
    const marker = () => {
        const first = document.querySelector('.ml-list > *');
        if (!first) return '';
        return first.id + '|' + Math.round(first.getBoundingClientRect().top);
    };

    const budget = (opts && opts.budget) || 35000;
    const onProgress = (opts && opts.onProgress) || null;
    const deadline = Date.now() + budget;
    let lastMove = Date.now();
    let lastMark = '';
    let round = 0;

    while (Date.now() < deadline && round < 70) {
        round++;

        const node = findCardNode(card);
        if (node) {
            diag(`[scroll] 第 ${round} 轮命中`);
            return (await centerCard(node, sc)) || node;
        }

        const before = marker();
        if (before !== lastMark) {
            lastMark = before;
            lastMove = Date.now();
        }
        const res = await bridge.scrollChatUp(Object.assign({ notches: 8 }, pos));
        const inner = res && res.data;
        if (!res || !res.ok || !inner || !inner.ok) {
            diag('[scroll] 主进程没滚：' + JSON.stringify((inner && inner.reason) || (res && res.error) || 'unknown'));
            return null;
        }
        await sleep(800);

        const hit = findCardNode(card);
        if (hit) {
            diag(`[scroll] 第 ${round} 轮命中`);
            return (await centerCard(hit, sc)) || hit;
        }

        // 内容一直在变就继续翻；连续 3.5 秒没有任何变化，才算真的到顶
        const after = marker();
        if (after !== lastMark) {
            lastMark = after;
            lastMove = Date.now();
        }
        if (round % 5 === 0) diag(`[scroll] 第 ${round} 轮 ${after}`);
        if (Date.now() - lastMove > 4000) {
            diag('[scroll] 4 秒没有新内容，判定到顶');
            return null;
        }

        if (onProgress) {
            try {
                onProgress(round);
            } catch (_) { /* 忽略 */ }
        }
    }

    diag(`[scroll] 翻了 ${round} 轮仍未命中`);
    return null;
}

/* ------------------------------------------------------------------
 * 盯着聊天区，等用户把卡片翻出来
 * ------------------------------------------------------------------
 * QQ 的虚拟列表只认真实滚轮（合成事件推不动），所以定位不能靠脚本翻页。
 * 换个做法：切到会话后留个观察者挂在消息区上，一旦目标卡片被滚进视野，
 * 立刻画圈、提示，必要时替用户点开原生卡片窗口。
 * ------------------------------------------------------------------ */

let cardWatcher = null;

function stopCardWatch() {
    if (cardWatcher) {
        try {
            cardWatcher.stop();
        } catch (_) { /* 忽略 */ }
        cardWatcher = null;
    }
}

/**
 * @param {object} card 目标卡片
 * @param {object} opts { open: 找到后是否自动点开, timeout: 毫秒, onHit, onTimeout }
 * @returns {boolean} 是否成功挂上
 */
function watchCardInChat(card, opts) {
    stopCardWatch();
    const needles = locateNeedles(card);
    if (!needles.length && !card.msgId) return false;
    if (!chatRoot()) return false;

    const openAfter = !!(opts && opts.open);
    const life = (opts && opts.timeout) || 120000;
    const onHit = opts && opts.onHit;
    const onTimeout = opts && opts.onTimeout;
    let stopped = false;

    const tick = () => {
        if (stopped) return;
        try {
            const root = chatRoot();
            if (!root) return;

            // 先按 msgId 精确找（QQ 把 msgId 直接写成 DOM id），没有再退回文字匹配
            let el = findCardNode(card);
            if (!el) {
                const hit = searchCardIn(root, card, needles);
                if (!hit) return;
                el = hit.el;
            }

            stop();
            highlightLocated(el);
            if (typeof onHit === 'function') onHit(el);
            else showFloatingToast(openAfter ? '找到了，正在打开原卡片…' : '找到了，就是这张');
            if (openAfter) setTimeout(() => clickCardNode(el), 400);
            diag('[locate] 观察者命中');
        } catch (err) {
            diag('[locate] tick 异常 ' + err);
        }
    };

    let debounceTimer = null;
    const schedule = () => {
        if (stopped) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(tick, 220);
    };

    let obs = null;
    try {
        obs = new MutationObserver(schedule);
        const root = chatRoot();
        if (root) obs.observe(root, { childList: true, subtree: true });
        else obs.observe(document.body, { childList: true, subtree: true });
    } catch (_) { /* 观察不了就靠定时器 */ }

    const iv = setInterval(tick, 900);
    const timeout = setTimeout(() => {
        stop();
        if (typeof onTimeout === 'function') {
            try {
                onTimeout();
            } catch (err) {
                diag('[locate] onTimeout 异常 ' + err);
            }
        }
    }, life);

    function stop() {
        if (stopped) return;
        stopped = true;
        clearInterval(iv);
        clearTimeout(timeout);
        if (debounceTimer) clearTimeout(debounceTimer);
        if (obs) obs.disconnect();
        if (cardWatcher && cardWatcher.__self === stop) cardWatcher = null;
    }

    cardWatcher = { stop, __self: stop };
    tick(); // 也许卡片本来就在视野里
    return true;
}

/** 替用户点一下卡片，让 QQ 自己弹出"聊天记录"窗口（图片、文件都在里面） */
function clickCardNode(el) {
    if (!el) return false;
    let target = el;
    for (let i = 0; i < 4; i++) {
        const cls = String(target.className || '');
        if (/card|forward|multi|bubble|message|item/i.test(cls)) break;
        if (!target.parentElement || target.parentElement === document.body) break;
        target = target.parentElement;
    }
    const o = { bubbles: true, cancelable: true, view: window };
    try {
        target.dispatchEvent(new PointerEvent('pointerdown', o));
        target.dispatchEvent(new MouseEvent('mousedown', o));
        target.dispatchEvent(new PointerEvent('pointerup', o));
        target.dispatchEvent(new MouseEvent('mouseup', o));
        target.dispatchEvent(new MouseEvent('click', o));
        diag('[locate] 已点击卡片');
        return true;
    } catch (err) {
        diag('[locate] 点击失败 ' + err);
        return false;
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

/* ------------------------------------------------------------------
 * 盯梢状态条
 * ------------------------------------------------------------------
 * 点完"定位"之后弹窗必须收起来：遮罩盖在聊天区上，不收起来滚轮就用不了。
 * 但之前是"收起来 + 2.8 秒 toast"，用户看到的就是弹窗凭空消失，
 * 以为插件崩了。所以换成一条常驻状态条：
 *   - 一直显示现在在等什么（往上翻到卡片我就圈出来）
 *   - 有"取消"，随时能停
 *   - 有"回到搜索结果"，不用重新搜一遍
 * 状态条本身 pointer-events: none，只有按钮能点，不挡滚轮。
 * ------------------------------------------------------------------ */

let watchBarEl = null;
let watchBarTimer = null;

function ensureWatchBar() {
    if (watchBarEl && document.body.contains(watchBarEl)) return watchBarEl;

    const bar = document.createElement('div');
    bar.className = 'fs-root fs-watchbar';
    bar.setAttribute('data-fs-theme', detectThemeFromDom());
    bar.innerHTML = `
        <span class="fs-watchdot"></span>
        <span class="fs-watchtext"></span>
        <button type="button" class="fs-watchbtn fs-watch-back">回到搜索结果</button>
        <button type="button" class="fs-watchbtn fs-watch-cancel">取消</button>`;

    bar.querySelector('.fs-watch-cancel').addEventListener('click', (e) => {
        e.stopPropagation();
        stopCardWatch();
        hideWatchBar();
        showFloatingToast('已停止定位');
    });

    bar.querySelector('.fs-watch-back').addEventListener('click', (e) => {
        e.stopPropagation();
        stopCardWatch();
        hideWatchBar();
        openPanel();
    });

    document.body.appendChild(bar);
    watchBarEl = bar;
    return bar;
}

/**
 * @param {string} text 状态文案
 * @param {string} tone '' | 'hit' | 'miss'
 */
function showWatchBar(text, tone) {
    try {
        const bar = ensureWatchBar();
        bar.classList.toggle('is-hit', tone === 'hit');
        bar.classList.toggle('is-miss', tone === 'miss');
        bar.querySelector('.fs-watchtext').textContent = text;
        bar.classList.add('is-show');
        if (watchBarTimer) {
            clearTimeout(watchBarTimer);
            watchBarTimer = null;
        }
    } catch (_) { /* 状态条画不出来不影响主流程 */ }
}

/** @param {number} delay 毫秒；给了就过一会儿自动收起 */
function hideWatchBar(delay) {
    if (watchBarTimer) {
        clearTimeout(watchBarTimer);
        watchBarTimer = null;
    }
    const doHide = () => {
        if (watchBarEl) watchBarEl.classList.remove('is-show');
    };
    if (delay && delay > 0) watchBarTimer = setTimeout(doHide, delay);
    else doHide();
}

/**
 * 打开原卡片：定位到它，然后替用户点一下——
 * QQ 会弹出原生的"聊天记录"窗口，里面的图片、文件、表情都在。
 * 如果卡片不在当前这一屏，就挂着观察者，等用户滚到那儿自动点开。
 */
async function openOriginalCard(card) {
    let el = locateCardInView(card);

    // 不在这一屏：先走直达通道（一步跳过去），跳到了再点开
    if (!el && card) {
        const canDirect = !!aioCtx();
        if (canDirect && (await directJumpToCard(card))) {
            el = locateCardInView(card);
        } else if (canDirect) {
            dockPanel();
            showWatchBar('聊天记录里找不到这条消息了，可能已被撤回或删除', 'miss');
            hideWatchBar(8000);
            return false;
        }
    }

    // 直达接口拿不到（QQ 改版）才退回老办法：往上翻，翻到了再点开
    if (!el) {
        if (card && card.peerName) dockPanel();
        showWatchBar('正在传送，找到后自动打开原卡片…');
        el = await autoScrollToCard(card, {
            budget: 25000,
            onProgress: (n) => showWatchBar(`正在往上翻… 第 ${n} 屏，找到就替你打开`)
        });
        if (el) highlightLocated(el);
    }

    if (el) {
        await sleep(400);
        clickCardNode(el);
        if (card && card.peerName) dockPanel();
        showWatchBar('已替你点开原卡片，QQ 的聊天记录窗口里能看到图片和文件', 'hit');
        hideWatchBar(4500);
        return true;
    }

    const watching = watchCardInChat(card, {
        open: true,
        onHit: () => {
            showWatchBar('找到了，正在替你打开原卡片…', 'hit');
            hideWatchBar(4500);
        },
        onTimeout: () => {
            showWatchBar('两分钟没翻到这张卡片，多半是消息太旧、还没被加载出来', 'miss');
            hideWatchBar(9000);
        }
    });

    if (watching) {
        if (card && card.peerName) dockPanel();
        showWatchBar(`往上翻到「${card.title || '这张卡片'}」，我会自动帮你打开原卡片`);
        return true;
    }

    showWatchBar('没能在聊天里定位到这张卡片', 'miss');
    hideWatchBar(6000);
    return false;
}

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
            <div class="fs-detail-tip">图片、文件、表情只在 QQ 原卡片里显示。<br/>
                点上面的按钮会切到聊天并收起这个弹窗（不然它挡住滚轮），底部会留一条状态条——上面有「回到搜索结果」。</div>
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
 *
 * innerFailed 是为了避免"每次打开都往内核打 5 个必失败的请求"：
 * 9.9.31 上 getMultiMsg 会被服务端拒，用户点十次结果就打五十次。
 * 只在本次运行里记住，重启后还会再试一次，不写死。
 */
const innerFailed = new Set();

async function fillThisCard(card) {
    if (!card || card.__filling || innerFailed.has(card.id)) return;
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
            innerFailed.add(card.id);
        }
    } catch (_) {
        /* 补不到就算了，界面上已经有降级提示 */
        card.innerState = 2;
        innerFailed.add(card.id);
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
