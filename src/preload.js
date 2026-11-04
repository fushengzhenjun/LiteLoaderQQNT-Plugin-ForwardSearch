/**
 * 合并转发搜索 · 预加载脚本
 * ------------------------------------------------------------------
 * 运行位置：QQ 渲染进程的 preload 环境。
 * 这个位置很特殊——它既能用 Node 的模块（fs、path），又能拿到 Electron 的 ipcRenderer，
 * 所以"读写文件"和"跟 QQ 主进程说话"都只能在这里做。
 *
 * 它对外（window.forwardSearch）提供四类能力：
 *   1. 调用 QQ 自己的消息接口（nativeCall）—— 用的是 QQ 原生通信通道，不伪造登录、不碰协议
 *   2. 被动收录：QQ 收到消息时"顺便"把合并转发卡片记下来（不产生任何额外请求）
 *   3. 读写插件配置、本地索引
 *   4. 提供弹窗要用的样式表
 *
 * 关于第 1 点多说一句（这决定了账号风险）：
 * QQ 的渲染层想调原生功能，是把请求发到 `RM_IPCFROM_RENDERER{窗口ID}` 这个通道上，
 * 主进程监听到之后转给底层。我们做的事情是——用同样的方式发同样的请求，
 * 相当于"借用 QQ 自己的手"去取数据，而不是另外开一个客户端登录。
 * 所以它不会被判定成异地登录 / 协议模拟，风险等级远低于 NapCat、QCE 这类完整协议端。
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// ⚠️ 重要：QQ 的 preload 跑在沙箱里，只有 'electron' 能 require。
// fs、path、以及本地的 record.js / store.js 在这里全都拿不到——
// 一旦 require 它们，整个 preload 会直接抛异常，接口也就挂不上去。
// （这一条是真机实测踩出来的，不是理论推测）
// 所以：读文件、解析卡片这类活，全部转给主进程，这边只做"转发"。

const SLUG = 'forward-search';

/* ==================================================================
 * 一、基础环境探测
 * ================================================================== */

/**
 * 当前窗口的 webContents id。
 * QQ 的 IPC 通道名带这个 id，拿错了就发不到地方，所以这里做了懒加载 + 兜底。
 */
let _webContentId = null;
function getWebContentId() {
    if (_webContentId !== null) return _webContentId;
    try {
        _webContentId = ipcRenderer.sendSync('forward-search:webContentId');
    } catch (_) {
        _webContentId = null;
    }
    if (typeof _webContentId !== 'number') _webContentId = 0;
    return _webContentId;
}

/* ==================================================================
 * 二、调用 QQ 原生接口
 * ================================================================== */

let _seq = 0;
function nextCallbackId() {
    _seq += 1;
    return `fs-${Date.now().toString(36)}-${_seq}`;
}

/**
 * 请求 QQ 的原生服务。
 *
 * @param {string} cmdName  例如 'nodeIKernelMsgService/getMsgsIncludeSelf'
 * @param {Array}  payload  参数数组，具体形状跟着 QQ 的接口走
 * @param {boolean|string|string[]} awaitCallback
 *        传 true    → 等同一个 callbackId 的回复
 *        传字符串    → 等 payload.cmdName 等于它的回复（例如 'xxx/onMsgInfoListUpdate'）
 *        传数组     → 命中其中任意一个就返回
 * @param {number} timeoutMs 超时时间，超时返回 null，绝不挂死界面
 * @returns {Promise<any|null>}
 */
function nativeCall(cmdName, payload, awaitCallback, timeoutMs = 8000) {
    const wid = getWebContentId();
    if (!wid) return Promise.resolve(null);

    const fromMainChannel = `RM_IPCFROM_MAIN${wid}`;
    const toMainChannel = `RM_IPCFROM_RENDERER${wid}`;
    const callbackId = nextCallbackId();

    // 不想等回复的调用，发出去就完事
    if (!awaitCallback) {
        try {
            ipcRenderer.send(toMainChannel, { peerId: wid, callbackId, type: 'request', eventName: 'ntApi' }, {
                cmdName,
                cmdType: 'invoke',
                payload: Array.isArray(payload) ? payload : [payload]
            });
        } catch (err) {
            console.warn('[forward-search] 发送原生请求失败', cmdName, err);
        }
        return Promise.resolve(null);
    }

    return new Promise((resolve) => {
        let settled = false;
        let timer = null;

        const done = (value) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            try {
                ipcRenderer.off(fromMainChannel, onEvent);
            } catch (_) {
                /* 忽略 */
            }
            resolve(value);
        };

        function onEvent(_event, envelope, body) {
            // 不同版本把内容放在第 2 或第 3 个参数上，两个都看一眼
            const envelopeObj = envelope && typeof envelope === 'object' ? envelope : {};
            const payloadObj = body && typeof body === 'object' ? body : envelopeObj;
            if (!payloadObj) return;

            if (awaitCallback === true) {
                if (envelopeObj.callbackId === callbackId) {
                    // 把成功/失败状态一起带回去，出错时能一眼看出是接口被拒还是没数据
                    const stat = envelopeObj.promiseStatue || envelopeObj.promiseStatus || 'ok';
                    done(Object.assign({}, payloadObj, { __statue: stat }));
                }
                return;
            }

            const wanted = Array.isArray(awaitCallback) ? awaitCallback : [awaitCallback];
            if (payloadObj.cmdName && wanted.indexOf(payloadObj.cmdName) !== -1) done(payloadObj);
        }

        ipcRenderer.on(fromMainChannel, onEvent);
        timer = setTimeout(() => done(null), timeoutMs);
        if (timer.unref) timer.unref();

        try {
            ipcRenderer.send(
                toMainChannel,
                {
                    peerId: wid,
                    callbackId,
                    type: 'request',
                    eventName: 'ntApi'
                },
                {
                    cmdName,
                    cmdType: 'invoke',
                    payload: Array.isArray(payload) ? payload : [payload]
                }
            );
        } catch (err) {
            console.warn('[forward-search] 发送原生请求失败', cmdName, err);
            done(null);
        }
    });
}

/* ==================================================================
 * 三、被动收录：QQ 收到消息时顺手记下合并转发卡片
 * ================================================================== */

/** 最近处理过的消息 ID，防止同一张卡片被反复写入 */
const seenMsgIds = new Set();
function markSeen(id) {
    if (seenMsgIds.size > 4000) seenMsgIds.clear();
    if (seenMsgIds.has(id)) return false;
    seenMsgIds.add(id);
    return true;
}

/** 群名/好友名小缓存，避免同一条卡片反复查名字 */
const peerNameCache = new Map();

let captureEnabled = true;

/**
 * 从 QQ 主进程推过来的数据里，捞出所有合并转发卡片。
 *
 * 这里只做"转发"：把原始数据丢给主进程，由主进程解析并入库。
 * 原因见文件顶部——沙箱里没有 record.js 可用，解析逻辑只能在主进程跑。
 * 好处是这一层非常薄，不会拖慢 QQ；坏处是多一次 IPC，但这点开销可以忽略。
 */
function harvestMessages(payload) {
    if (!captureEnabled || !payload) return;
    try {
        ipcRenderer.send('forward-search:capture', payload);
    } catch (err) {
        // 收录失败绝不能影响 QQ 正常收发消息
        console.warn('[forward-search] 被动收录转发失败', err);
    }
}

/** 只要 payload 里带了这几类事件名，就说明可能是消息数据 */
function maybeMessageEvent(cmdName) {
    if (!cmdName || typeof cmdName !== 'string') return false;
    return (
        cmdName.indexOf('MsgInfoList') !== -1 ||
        // 9.9.31 上消息是通过 onRecvActiveMsg 推过来的，
        // 早期只匹配了 onRecvMsg，结果一条都收不到（真机踩过这个坑）
        /onRecv/i.test(cmdName) ||
        cmdName.indexOf('onAddSendMsg') !== -1 ||
        cmdName.indexOf('onMsgUpdate') !== -1 ||
        cmdName.indexOf('getMultiMsg') !== -1 ||
        cmdName.indexOf('onMsgRecord') !== -1
    );
}

/**
 * 会话列表相关的事件。
 * 注意 9.9.31 上是 `onRecentContactListChangedVer2`——带 Ver2 后缀，
 * 早期版本叫 `onRecentContactListChanged`，两个都得认。
 * QQ 启动时本来就会推这些，我们只是旁听，不需要额外发请求去要。
 */
function maybePeerEvent(cmdName) {
    if (!cmdName || typeof cmdName !== 'string') return false;
    return (
        /RecentContactListChanged/i.test(cmdName) ||
        /onGroupListUpdate|onGroupListChange/i.test(cmdName) ||
        /onBuddyListChange/i.test(cmdName)
    );
}

/** 把会话列表事件原样转给主进程，由主进程提取 peerUid / 名字 */
function harvestPeers(payload) {
    try {
        ipcRenderer.send('forward-search:peers', payload);
    } catch (err) {
        console.warn('[forward-search] 会话列表转发失败', err);
    }
}

let installed = false;

function installPassiveCapture() {
    if (installed) return;
    const wid = getWebContentId();
    if (!wid) return;
    installed = true;

    // 注意：这里只是"旁听"，不会把 QQ 自己的监听挤掉，消息照常显示
    ipcRenderer.on(`RM_IPCFROM_MAIN${wid}`, (_event, envelope, body) => {
        try {
            const payloadObj = body && typeof body === 'object' ? body : envelope;
            if (!payloadObj) return;
            if (maybeMessageEvent(payloadObj.cmdName)) harvestMessages(payloadObj);
            if (maybePeerEvent(payloadObj.cmdName)) harvestPeers(payloadObj);
        } catch (err) {
            // 旁听失败绝不能让 QQ 崩
            console.warn('[forward-search] 被动收录出错', err);
        }
    });

    // 读取配置，决定要不要开被动收录
    try {
        const config = ipcRenderer.sendSync('forward-search:config:getSync');
        if (config && typeof config.passiveCapture === 'boolean') captureEnabled = config.passiveCapture;
    } catch (_) {
        /* 读不到就默认开着 */
    }
}

/* ==================================================================
 * 四、对外暴露的接口
 * ================================================================== */

/**
 * 读取弹窗样式表，返回 Promise<string>。
 * 读文件只能在主进程做（沙箱里没有 fs），所以这里走一次 IPC。
 * 拿不到就返回空字符串，界面会自动降级成"能用但朴素"，不会白屏。
 */
function loadStyle() {
    return ipcRenderer.invoke('forward-search:style').then(
        (res) => (res && res.ok && res.data) || '',
        () => ''
    );
}

const api = {
    version: '1.0.0',
    available: true,
    webContentId: getWebContentId(),

    /** 拿样式表 */
    getStyle: loadStyle,

    /** 调 QQ 原生接口 */
    nativeCall,

    /** 读配置 */
    getConfig: () => ipcRenderer.invoke('forward-search:config:get'),
    /** 写诊断日志（写到数据目录 debug.log） */
    log: (line) => ipcRenderer.invoke('forward-search:log', line),
    /** 改配置（部分字段） */
    patchConfig: (patch) => ipcRenderer.send('forward-search:config:patch', patch),
    /** 配置变化时通知界面 */
    onConfigChanged: (cb) => {
        ipcRenderer.on('forward-search:configChanged', (_e, cfg) => cb(cfg));
    },

    /** 本地索引读写 */
    upsert: (records) => ipcRenderer.invoke('forward-search:upsert', records),
    search: (query, limit, peerUid, sortBy) => ipcRenderer.invoke('forward-search:search', query, limit, peerUid || '', sortBy || 'relevance'),
    list: (limit, peerUid) => ipcRenderer.invoke('forward-search:list', limit, peerUid || ''),
    getCard: (id) => ipcRenderer.invoke('forward-search:get', id),
    stats: () => ipcRenderer.invoke('forward-search:stats'),
    /** 旁听到的会话列表（扫描历史用） */
    peers: () => ipcRenderer.invoke('forward-search:peers'),
    lastPeer: () => ipcRenderer.invoke('forward-search:lastPeer'),
    pending: (limit, filter) => ipcRenderer.invoke('forward-search:pending', limit, filter),
    setInner: (id, inner, state) => ipcRenderer.invoke('forward-search:setInner', id, inner, state),
    /** 让主进程发滚轮，把聊天往上翻（QQ 的虚拟列表只认真实输入） */
    scrollChatUp: (opts) => ipcRenderer.invoke('forward-search:scrollChatUp', opts),
    compact: () => ipcRenderer.invoke('forward-search:compact'),
    clear: () => ipcRenderer.invoke('forward-search:clear'),
    openDataDir: () => ipcRenderer.invoke('forward-search:openDataDir'),

    /** 群名缓存，界面层可以直接用 */
    getPeerName: (peerUid) => peerNameCache.get(peerUid) || '',
    setPeerName: (peerUid, name) => peerNameCache.set(peerUid, name)
};

try {
    // 正常情况走 contextBridge，这是 Electron 推荐的安全做法
    contextBridge.exposeInMainWorld('forwardSearch', api);
} catch (err) {
    // 极少见的情况（contextIsolation 被关掉），直接挂到 window 上
    try {
        window.forwardSearch = api;
    } catch (_) {
        console.error('[forward-search] 无法暴露接口', err);
    }
}

// 启动被动收录。延迟一下，等 QQ 自己的监听装好。
setTimeout(() => {
    try {
        installPassiveCapture();
    } catch (err) {
        console.warn('[forward-search] 启动被动收录失败', err);
    }
}, 2000);
