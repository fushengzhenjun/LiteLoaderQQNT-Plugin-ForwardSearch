/**
 * 合并转发搜索 · 主进程入口
 * ------------------------------------------------------------------
 * 运行位置：QQ 的主进程（Node.js 环境），所以这里可以随便用 fs 读写文件。
 *
 * 这里只负责三件事：
 *   1. 管配置（读/写 config.json）
 *   2. 管数据（本地卡片索引的存取、搜索）
 *   3. 当"快递员"（渲染层要存/查数据，都通过这里的 IPC 接口）
 *
 * 真正跟 QQ 要数据的逻辑不在这里，在渲染层（src/renderer.js），
 * 因为只有渲染层才拿得到 QQ 自己的通信通道。
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { ipcMain, shell } = require('electron');

const { CardStore } = require('./core/store');
const record = require('./core/record');

const SLUG = 'forward-search';

/** 默认配置。第一次运行就写这个。 */
const DEFAULT_CONFIG = {
    // 唤起搜索框的快捷键（Electron Accelerator 格式，也支持单键组合写法）
    hotkey: 'Alt+S',
    // 输入防抖毫秒数
    debounce: 220,
    // 单次最多显示多少条结果
    maxResults: 60,
    /**
     * 内容模式：
     *   false = 仅本地模式（默认）。不发任何主动请求，只用"顺便抓到"的内容。
     *   true  = 联网补全模式。会调用 QQ 自己的接口，把卡片内部内容补全。
     */
    contentMode: false,
    // 被动收录：别人发来卡片、或你自己打开卡片时，顺手存下来（不产生额外请求）
    passiveCapture: true,
    // 补全队列每次请求之间的间隔（毫秒），越大越安全
    crawlIntervalMs: 1600,
    // 间隔的随机浮动，避免机器味太重的固定节奏
    crawlJitterMs: 700,
    // 是否已经看过首次引导页
    onboarded: false,
    // 主题：system 跟随系统 / light 浅色 / dark 深色 / auto 跟随 QQ 界面底色
    theme: 'system',
    // 主面板上的圆形悬浮按钮
    showFloat: true,
    // 悬浮按钮位置（比例坐标 0~1，null = 用默认的右下角）
    floatPos: null
};

/**
 * 快捷键白名单校验。
 * 起因很实在：之前设置页是个自由输入框，手一滑就存成 "A+B"、"空字符串"，
 * 结果要么按不出来，要么按什么键都弹窗。这里统一在入口挡一道。
 * 规则：必须有主键；修饰键只能是 ctrl/alt/shift/meta；单个普通字符允许但不推荐。
 */
function normalizeHotkey(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return DEFAULT_CONFIG.hotkey;

    const parts = raw.split('+').map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) return DEFAULT_CONFIG.hotkey;

    const key = parts.pop();
    const mods = parts.map((p) => p.toLowerCase());

    const allowedMods = ['ctrl', 'control', 'alt', 'shift', 'meta', 'cmd', 'win'];
    if (mods.some((m) => !allowedMods.includes(m))) return DEFAULT_CONFIG.hotkey;

    // 主键：单个字符、F1-F24、或常见的功能键
    const specials = ['up', 'down', 'left', 'right', 'esc', 'space', 'enter', 'tab',
        'backspace', 'delete', 'home', 'end', 'pageup', 'pagedown', 'insert'];
    const isFn = /^f([1-9]|1[0-9]|2[0-4])$/i.test(key);
    const isChar = Array.from(key).length === 1;
    const isSpecial = specials.includes(key.toLowerCase());
    if (!isFn && !isChar && !isSpecial) return DEFAULT_CONFIG.hotkey;

    return raw;
}

let store = null;
let config = null;
let dataDir = '';
let configFile = '';

/** 解析插件数据目录。优先用 LiteLoader 给的路径，失败就退回插件目录下的 data/ */
function resolveDataDir() {
    try {
        const info = globalThis.LiteLoader && globalThis.LiteLoader.plugins && globalThis.LiteLoader.plugins[SLUG];
        if (info && info.path && info.path.data) return info.path.data;
    } catch (_) {
        /* 忽略，走兜底 */
    }
    return path.join(__dirname, '..', 'data');
}

/** 解析插件自己的目录（用来读 style.css） */
function resolvePluginDir() {
    try {
        const info = globalThis.LiteLoader && globalThis.LiteLoader.plugins && globalThis.LiteLoader.plugins[SLUG];
        if (info && info.path && info.path.plugin) return info.path.plugin;
    } catch (_) {
        /* 忽略，走兜底 */
    }
    return path.join(__dirname, '..');
}

function loadConfig() {
    configFile = path.join(dataDir, 'config.json');
    let saved = {};
    try {
        if (fs.existsSync(configFile)) saved = JSON.parse(fs.readFileSync(configFile, 'utf8')) || {};
    } catch (err) {
        console.error('[forward-search] 配置文件损坏，已使用默认配置', err);
    }
    config = Object.assign({}, DEFAULT_CONFIG, saved);

    // 老配置里可能存着无效快捷键（比如手打出来的 "A+B"、空串），读进来就纠正掉
    const fixedHotkey = normalizeHotkey(config.hotkey);
    if (fixedHotkey !== config.hotkey) {
        console.warn('[forward-search] 快捷键配置无效，已回退到默认值', config.hotkey, '→', fixedHotkey);
        config.hotkey = fixedHotkey;
        try {
            fs.mkdirSync(dataDir, { recursive: true });
            fs.writeFileSync(configFile, JSON.stringify(config, null, 4), 'utf8');
        } catch (err) {
            console.error('[forward-search] 回写快捷键失败', err);
        }
    }

    // 第一次运行时把默认配置写出来。
    // 好处是用户点"打开数据目录"能看到一个可读的 config.json，想手改也有个东西可改。
    //
    // 注意：LiteLoader 只负责创建 plugins 目录，插件的 data 目录要自己建。
    // 少了这句 mkdir，首次写入会直接 ENOENT 失败（已实测踩到过）。
    if (!fs.existsSync(configFile)) {
        try {
            fs.mkdirSync(dataDir, { recursive: true });
            fs.writeFileSync(configFile, JSON.stringify(config, null, 4), 'utf8');
        } catch (err) {
            console.error('[forward-search] 写入默认配置失败', err);
        }
    }
    return config;
}

function saveConfig(patch) {
    const safe = Object.assign({}, patch || {});
    if ('hotkey' in safe) safe.hotkey = normalizeHotkey(safe.hotkey);
    config = Object.assign({}, config, safe);
    try {
        // 同样要先保证目录存在，否则第一次保存设置会静默失败
        fs.mkdirSync(path.dirname(configFile), { recursive: true });
        fs.writeFileSync(configFile, JSON.stringify(config, null, 4), 'utf8');
    } catch (err) {
        console.error('[forward-search] 保存配置失败', err);
    }
    // 配置变更广播给所有窗口，设置页和搜索框好同步
    try {
        const { BrowserWindow } = require('electron');
        for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) win.webContents.send('forward-search:configChanged', config);
        }
    } catch (_) {
        /* 广播失败不影响主流程 */
    }
    return config;
}

/* ==================================================================
 * 被动收录
 * ------------------------------------------------------------------
 * preload 会把 QQ 推送过来的原始消息数据整包转给这里，由主进程解析。
 * 为什么不在 preload 里解析？因为 preload 跑在沙箱里，拿不到 record.js。
 * （这一条是真机实测踩出来的：沙箱里 require 本地模块会直接抛异常）
 * ================================================================== */

/** 已经处理过的消息 ID，防止同一条消息被重复解析 */
const seenMsgIds = new Set();

function markSeen(id) {
    if (seenMsgIds.has(id)) return false;
    // 防止无限增长：超过两万条就清空重来，宁可多解析几次也不吃内存
    if (seenMsgIds.size > 20000) seenMsgIds.clear();
    seenMsgIds.add(id);
    return true;
}

/** 群名/好友名缓存，展示"群名称"要用 */
const peerNames = new Map();

/* ------------------------------------------------------------------
 * 会话缓存
 * ------------------------------------------------------------------
 * 扫描历史需要知道"有哪些群/好友"。本来想直接调 getRecentContactList 要，
 * 但真机上这个接口只回 {result:0,errMsg:"success"} 这种应答，数据是从
 * `nodeIKernelRecentContactListener/onRecentContactListChangedVer2` 事件推过来的。
 *
 * 既然 QQ 启动时本来就会推全量列表，那就别另发请求了——旁听即可，
 * 既不增加请求量，也不会因为接口改名而失效。
 * ------------------------------------------------------------------ */

const peerMap = new Map(); // peerUid -> { chatType, peerUid, guildId, name }
let lastActivePeer = null; // 最近收到消息的会话，用来验证"本地缓存"范围
let peerSaveTimer = null;
let peerFile = '';

function loadPeers() {
    if (!peerFile) return;
    try {
        if (!fs.existsSync(peerFile)) return;
        const arr = JSON.parse(fs.readFileSync(peerFile, 'utf8'));
        for (const p of arr || []) {
            if (p && p.peerUid) peerMap.set(String(p.peerUid), p);
        }
        console.log(`[forward-search] 载入 ${peerMap.size} 个会话记录`);
    } catch (err) {
        console.warn('[forward-search] 读取会话缓存失败', err);
    }
}

function savePeersSoon() {
    if (peerSaveTimer) return;
    peerSaveTimer = setTimeout(() => {
        peerSaveTimer = null;
        try {
            fs.writeFileSync(peerFile, JSON.stringify(Array.from(peerMap.values())), 'utf8');
        } catch (err) {
            console.warn('[forward-search] 写会话缓存失败', err);
        }
    }, 2000);
    if (peerSaveTimer.unref) peerSaveTimer.unref();
}

function notePeer(chatType, peerUid, name) {
    const uid = peerUid === undefined || peerUid === null ? '' : String(peerUid);
    if (!uid) return false;
    const old = peerMap.get(uid);
    const t = Number(chatType) || (old && old.chatType) || 2;
    const n = name || (old && old.name) || '';
    if (old && old.chatType === t && old.name === n) return false;
    peerMap.set(uid, { chatType: t, peerUid: uid, guildId: '', name: n });
    return true;
}

/** 从任意形状的会话列表事件里捞出 peerUid + 名字 */
function harvestPeers(payload) {
    const root = payload && payload.payload ? payload.payload : payload;
    let changed = 0;

    const walk = (node, depth) => {
        if (!node || typeof node !== 'object' || depth > 7) return;

        if (Array.isArray(node)) {
            for (const item of node) walk(item, depth + 1);
            return;
        }

        // 最近联系人 / 消息里自带 peerUid
        if (node.peerUid) {
            const t = node.chatType !== undefined ? node.chatType : node.peerType;
            if (t !== undefined) {
                const name = node.peerName || node.remark || node.sendMemberName || node.peerNickName || '';
                if (notePeer(t, node.peerUid, name)) changed++;
            }
        }

        // 群列表：groupCode 就是群号
        if (node.groupCode && (node.groupName || node.groupRemark)) {
            if (notePeer(2, node.groupCode, node.groupRemark || node.groupName)) changed++;
        }

        // 好友列表：uid + nick/remark
        if (node.uid && !node.peerUid && (node.nick || node.remark)) {
            if (notePeer(1, node.uid, node.remark || node.nick)) changed++;
        }

        for (const key of Object.keys(node)) {
            const v = node[key];
            if (v && typeof v === 'object') walk(v, depth + 1);
        }
    };

    try {
        walk(root, 0);
    } catch (err) {
        console.warn('[forward-search] 解析会话列表失败', err);
    }

    if (changed > 0) {
        console.log(`[forward-search] 会话缓存 ${peerMap.size} 个（新增/更新 ${changed}）`);
        savePeersSoon();
    }
    return peerMap.size;
}

function captureFromPayload(payload) {
    if (!payload || !config || config.passiveCapture === false) return 0;

    // QQ 不同事件把消息放在不同字段里，这几种都试一遍
    const candidates = [];
    const d = payload.payload;
    if (d) {
        if (Array.isArray(d.msgList)) candidates.push(d.msgList);
        if (Array.isArray(d.msgs)) candidates.push(d.msgs);
        if (Array.isArray(d.messages)) candidates.push(d.messages);
        if (Array.isArray(d)) candidates.push(d);
        if (d.msgRecord) candidates.push([d.msgRecord]);
        if (d.msg) candidates.push([d.msg]);
    }
    if (Array.isArray(payload.msgList)) candidates.push(payload.msgList);

    const cards = [];
    for (const list of candidates) {
        for (const msg of list) {
            if (!msg || !msg.msgId) continue;
            if (!markSeen(String(msg.msgId))) continue;

            try {
                const peerUid = msg.peerUid;
                // 记一下最近活跃会话：只有它的消息在本地缓存里，排除/定位问题时有用
                if (peerUid) {
                    lastActivePeer = {
                        chatType: Number(msg.chatType) || 2,
                        peerUid: String(peerUid),
                        guildId: '',
                        name: peerNames.get(String(peerUid)) || ''
                    };
                }
                const name = msg.peerName || msg.peerNickName;
                if (peerUid && name && !peerNames.has(peerUid)) peerNames.set(peerUid, name);

                const card = record.cardFromMessage(msg, {
                    peerUid,
                    peerName: peerNames.get(peerUid) || peerUid
                });
                if (card) cards.push(card);
            } catch (err) {
                // 单条解析失败不能影响其它消息
                console.warn('[forward-search] 解析消息失败', err);
            }
        }
    }

    if (cards.length > 0) store.upsertMany(cards);
    return cards.length;
}

/**
 * 往 QQ 聊天窗口的 webContents 里投滚轮，把消息列表往上/下推 n 下。
 *
 * 为什么非要走主进程：QQ 9.9 的消息区是虚拟列表（`.q-scroll-view` 的 scrollHeight
 * 固定 300000、`scrollTop` 会被立刻压回 0.x），渲染层里改 scrollTop、派发合成 wheel、
 * 按 PageUp 全都推不动。实测只有 `webContents.sendInputEvent` 的 mouseWheel 有效——
 * 每 8 下大约推进 960px，并且会让 QQ 继续加载更早的历史。
 *
 * 安全性：sendInputEvent 直接投给指定窗口的渲染进程，不移动系统光标、不发给前台窗口，
 * 所以即使 QQ 在后台也不会误滚到别的程序上。
 *
 * @param {{x:number,y:number,notches:number,dir:'up'|'down'}} opts x/y 是窗口内 CSS 像素
 */
async function scrollChatUp(opts) {
    const { BrowserWindow } = require('electron');
    const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
    const win = wins.find((w) => String(w.webContents.getURL()).indexOf('#/main/message') >= 0);
    if (!win) return { ok: false, reason: 'no-chat-window' };

    const notches = Math.max(1, Math.min(30, Math.round(opts.notches || 12)));
    const dir = opts.dir === 'down' ? -1 : 1;
    const x = Math.round(opts.x || 0);
    const y = Math.round(opts.y || 0);
    const wc = win.webContents;

    // 先把指针放到这个点上，Chromium 按它决定滚哪个容器
    wc.sendInputEvent({ type: 'mouseMove', x, y });
    for (let i = 0; i < notches; i++) {
        wc.sendInputEvent({
            type: 'mouseWheel',
            x,
            y,
            deltaX: 0,
            deltaY: 120 * dir,
            wheelTicksX: 0,
            wheelTicksY: -3 * dir,
            canScroll: true
        });
        await new Promise((r) => setTimeout(r, 45));
    }
    return { ok: true, notches, dir };
}

/** 统一包一层，任何 handler 抛错都变成 { ok:false, error }，绝不把异常抛回渲染层 */
function handle(channel, fn) {
    ipcMain.handle(`forward-search:${channel}`, async (event, ...args) => {
        try {
            return { ok: true, data: await fn(...args) };
        } catch (err) {
            console.error(`[forward-search] IPC ${channel} 出错`, err);
            return { ok: false, error: String((err && err.message) || err) };
        }
    });
}

function setupIpc() {
    // 渲染层需要知道自己是第几个 webContents，才能走对 QQ 的通信通道
    ipcMain.on('forward-search:webContentId', (event) => {
        event.returnValue = event.sender.id;
    });

    // ---- 配置 ----
    ipcMain.on('forward-search:config:patch', (_event, patch) => {
        saveConfig(patch);
    });
    // preload 启动时要同步读一次配置，用同步通道
    ipcMain.on('forward-search:config:getSync', (event) => {
        event.returnValue = config;
    });
    handle('config:get', () => config);

    // ---- 样式表（preload 在沙箱里读不了文件，只能由这里代读）----
    handle('style', () => {
        const file = path.join(resolvePluginDir(), 'src', 'style.css');
        return fs.readFileSync(file, 'utf8');
    });

    // ---- 被动收录（preload 把原始数据转过来，这里解析）----
    ipcMain.on('forward-search:capture', (_event, payload) => {
        try {
            captureFromPayload(payload);
        } catch (err) {
            // 收录出错绝不能影响 QQ 正常收发消息
            console.warn('[forward-search] 被动收录出错', err);
        }
    });

    // ---- 会话列表（同理，旁听 QQ 自己的推送，扫描历史时要用）----
    ipcMain.on('forward-search:peers', (_event, payload) => {
        try {
            harvestPeers(payload);
        } catch (err) {
            console.warn('[forward-search] 整理会话列表出错', err);
        }
    });

    // ---- 数据 ----
    handle('upsert', (records) => store.upsertMany(records));
    handle('search', (query, limit, peerUid, sortBy) => store.search(query, limit || config.maxResults, peerUid || '', sortBy || 'relevance'));
    handle('get', (id) => store.get(id));
    handle('stats', () => store.stats());
    handle('peers', () => Array.from(peerMap.values()));
    handle('lastPeer', () => lastActivePeer);
    handle('pending', (limit, filter) => store.pending(limit || 100, filter || {}));
    handle('setInner', (id, inner, state) => store.setInner(id, inner, state));
    // 真滚轮：插件"替你往上翻"的唯一可行方式，详见 scrollChatUp 的注释
    handle('scrollChatUp', (opts) => scrollChatUp(opts || {}));
    handle('compact', () => store.compact());
    handle('clear', () => {
        store.clear();
        return true;
    });

    // ---- 杂项 ----
    handle('openDataDir', async () => {
        await shell.openPath(dataDir);
        return dataDir;
    });
    handle('dataDir', () => dataDir);

    // 渲染层诊断日志：追加到 data 目录的 debug.log，排查真机问题用
    handle('log', (line) => {
        try {
            const file = path.join(dataDir, 'debug.log');
            const ts = new Date().toISOString();
            fs.appendFileSync(file, `[${ts}] ${String(line)}\n`, 'utf8');
        } catch (_) { /* 日志失败不影响主流程 */ }
        return true;
    });
}

exports.onBrowserWindowCreated = (_window) => {
    // 目前不需要对窗口做任何处理，留这个钩子方便以后扩展
};

// 模块被 LiteLoader 载入时执行一次
(function bootstrap() {
    dataDir = resolveDataDir();
    loadConfig();

    store = new CardStore(dataDir);
    const count = store.load();

    peerFile = path.join(dataDir, 'peers.json');
    loadPeers();
    console.log(`[forward-search] 已载入 ${count} 条卡片记录，数据目录：${dataDir}`);

    setupIpc();

    // QQ 退出前把缓冲的数据写干净，避免丢记录
    process.on('exit', () => {
        try {
            store.flush();
        } catch (_) {
            /* 退出阶段错了也没办法了 */
        }
    });

    exports.__store = store;
    exports.__config = () => config;
})();
