/**
 * 合并转发卡片解析
 * ------------------------------------------------------------------
 * 这个文件只做一件事：把 QQ 的一条消息对象，判断它是不是"合并转发卡片"，
 * 如果是，就把它拆成我们可以存、可以搜的结构。
 *
 * 为什么要写得这么"宽容"：
 * QQ 的卡片格式随版本变化过好几次，字段名有 m_resid / resid 两种写法，
 * 内容有 JSON 和 XML 两种形态。所以这里全部用"模糊查找"，
 * 只要长得像就认，而不是写死某个字段路径。这样升级 QQ 后不容易整个失效。
 */

'use strict';

/** 合并转发卡片在 QQ 元素里的特征词 */
const MULTI_MSG_MARKERS = ['com.tencent.multimsg', 'com.tencent.multi_msg', 'multimsg', 'multi_msg'];

/** 安全 JSON 解析，失败返回 null */
function safeJson(text) {
    try {
        return JSON.parse(text);
    } catch (_) {
        return null;
    }
}

/**
 * 在一棵对象树里递归查找某个键，返回第一个命中的值。
 * 用来兼容不同版本的字段位置差异。
 */
function deepFind(node, keys, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 8) return undefined;
    for (const key of keys) {
        if (node[key] !== undefined && node[key] !== null && node[key] !== '') {
            return node[key];
        }
    }
    for (const value of Object.values(node)) {
        if (value && typeof value === 'object') {
            const hit = deepFind(value, keys, depth + 1);
            if (hit !== undefined) return hit;
        }
    }
    return undefined;
}

/**
 * 从卡片文本里抠出"共 N 条"。
 * QQ 的摘要一般是「查看23条转发消息」这种写法。
 */
function pickCount(text) {
    if (!text) return 0;
    const m = String(text).match(/(\d+)\s*条/);
    return m ? parseInt(m[1], 10) : 0;
}

/**
 * 把消息时间统一成"秒"。
 * QQ 有时候给秒，有时候给毫秒，有时候给字符串。
 */
function normalizeTime(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
}

/**
 * 判断一段 ark 的 bytesData 是不是合并转发卡片，并解析出外层信息。
 * 返回 null 表示"不是合并转发"。
 */
/** XML 里那几个转义字符还原回来，不然搜"&amp;"这类会漏 */
function xmlUnescape(text) {
    return String(text || '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
}

/**
 * 9.9.31 起，合并转发卡片是 elementType=16 的 multiForwardMsgElement，
 * 内容是一段 XML 字符串（不是以前那种 arkElement 的 JSON）。
 *
 * XML 长这样：
 *   <msg serviceID="35" action="viewMultiMsg" m_fileName=".." m_resid=".." tSum="6">
 *     <item><title size="34">群聊的聊天记录</title>
 *           <title size="26">张三: 第一句</title>
 *           <title size="26">李四: 第二句</title>
 *           <summary>查看6条转发消息</summary></item>
 *   </msg>
 *
 * 关键点：后面那几行 title 就是卡片内部的开头几条消息，**可以直接拿来搜**，
 * 所以即使还没拉取完整内容，也能搜到一部分。
 */
function parseMultiForwardElement(el) {
    if (!el || typeof el !== 'object' || !el.multiForwardMsgElement) return null;

    const node = el.multiForwardMsgElement;
    const xml = typeof node.xmlContent === 'string' ? node.xmlContent : '';
    if (!xml) return null;
    if (xml.indexOf('viewMultiMsg') === -1 && xml.indexOf('m_resid') === -1) return null;

    const attr = (name) => {
        const m = xml.match(new RegExp(`${name}="([^"]*)"`));
        return m ? m[1] : '';
    };

    const titles = [];
    const re = /<title[^>]*>([\s\S]*?)<\/title>/g;
    let m;
    while ((m = re.exec(xml)) !== null) titles.push(xmlUnescape(m[1].trim()));

    const summaryMatch = xml.match(/<summary[^>]*>([\s\S]*?)<\/summary>/);
    const summary = summaryMatch ? xmlUnescape(summaryMatch[1].trim()) : '';
    const sourceMatch = xml.match(/<source[^>]*name="([^"]*)"/);

    const title = titles[0] || '聊天记录';
    const preview = titles.slice(1).join(' / ') || (sourceMatch ? xmlUnescape(sourceMatch[1]) : '');
    const count = pickCount(summary) || parseInt(attr('tSum'), 10) || 0;

    return {
        title: String(title).slice(0, 60),
        preview: String(preview).slice(0, 300),
        summary: summary.slice(0, 120),
        resid: String(node.resId || attr('m_resid') || ''),
        fileName: String(node.fileName || attr('m_fileName') || ''),
        count
    };
}

/**
 * 兼容两种卡片形态：新的 multiForwardMsgElement（XML）和老的 arkElement（JSON）。
 * 老的留着是为了让用户翻旧记录时也能认出来。
 */
function parseCardFromElement(el) {
    if (!el || typeof el !== 'object') return null;
    return parseMultiForwardElement(el) || (el.arkElement ? parseArkCard(el.arkElement.bytesData) : null);
}

function parseArkCard(bytesData) {
    if (typeof bytesData !== 'string' || bytesData.length === 0) return null;

    const lower = bytesData.toLowerCase();
    const looksLikeForward = MULTI_MSG_MARKERS.some((m) => lower.includes(m));
    if (!looksLikeForward) return null;

    // 大多数情况是 JSON；少数老版本是 XML，这里两种都兼容
    const json = safeJson(bytesData);
    if (json) {
        const title =
            deepFind(json, ['text']) || // meta.detail.news[0].text → 卡片标题
            deepFind(json, ['prompt']) ||
            '聊天记录';
        const preview = deepFind(json, ['source', 'desc', 'summary']) || '';
        const resid = deepFind(json, ['m_resid', 'resid', 'mResid']) || '';
        const fileName = deepFind(json, ['m_fileName', 'fileName']) || '';
        const summary = deepFind(json, ['summary']) || '';

        return {
            title: String(title).slice(0, 60),
            preview: String(preview).slice(0, 200),
            summary: String(summary).slice(0, 120),
            resid: String(resid),
            fileName: String(fileName),
            count: pickCount(summary) || pickCount(title)
        };
    }

    // XML 形态：用正则捞关键属性
    const get = (tag) => {
        const m = bytesData.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
        return m ? m[1].trim() : '';
    };
    const attr = (name) => {
        const m = bytesData.match(new RegExp(`${name}="([^"]*)"`));
        return m ? m[1] : '';
    };

    const summary = get('summary') || attr('summary');
    return {
        title: get('title') || '聊天记录',
        preview: attr('brief') || get('summary').slice(0, 200),
        summary,
        resid: attr('m_resid') || attr('resid'),
        fileName: attr('m_fileName'),
        count: pickCount(summary)
    };
}

/** 把单个消息元素压成一行可读文字（用于建立搜索文本） */
function elementToText(el) {
    if (!el || typeof el !== 'object') return '';
    const t = el.elementType;

    if (el.textElement) return el.textElement.content || '';
    if (el.picElement) return '[图片]';
    if (el.fileElement) return '[文件] ' + (el.fileElement.fileName || '');
    if (el.pttElement) return '[语音]';
    if (el.videoElement) return '[视频]';
    if (el.faceElement) return el.faceElement.faceText || '[表情]';
    if (el.marketFaceElement) return el.marketFaceElement.faceName || '[表情]';
    if (el.arkElement) {
        const card = parseArkCard(el.arkElement.bytesData);
        return card ? `[聊天记录] ${card.title} ${card.preview}` : '[卡片消息]';
    }
    if (el.replyElement) return '';
    if (t === 8 || t === 9) return '';
    return '';
}

/** 把一条消息的所有元素拼成一段文字 */
function messageToText(msg) {
    const elements = msg && msg.elements;
    if (!Array.isArray(elements)) return '';
    return elements
        .map(elementToText)
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** 从消息对象里取发送人显示名，按优先级回退 */
function senderNameOf(msg) {
    if (!msg) return '';
    return (
        msg.sendMemberName ||
        msg.sendRemarkName ||
        msg.sendNickName ||
        msg.senderName ||
        msg.nickName ||
        msg.senderUid ||
        '未知'
    );
}

/**
 * 解析合并转发卡片"里面"的那些子消息。
 * records 是 QQ 内联给我们的数组（有就直接用，不需要联网）。
 */
function parseInnerRecords(records) {
    if (!Array.isArray(records)) return [];
    const out = [];
    for (const rec of records) {
        // 有些版本会多包一层 { message: {...} }
        const msg = rec && rec.message ? rec.message : rec;
        if (!msg) continue;
        const text = messageToText(msg).slice(0, 1500);
        if (!text) continue;
        out.push({
            name: senderNameOf(msg),
            time: normalizeTime(msg.msgTime),
            text
        });
    }
    return out;
}

/**
 * 主入口：把一条 QQ 消息转成卡片记录。
 * 不是合并转发卡片 → 返回 null。
 */
function cardFromMessage(msg, context) {
    if (!msg || !Array.isArray(msg.elements)) return null;

    let card = null;
    for (const el of msg.elements) {
        const parsed = parseCardFromElement(el);
        if (parsed && parsed.resid) {
            card = parsed;
            break;
        }
    }
    if (!card) return null;

    const chatType = Number(msg.chatType) || (context && context.chatType) || 2;
    const peerUid = msg.peerUid || (context && context.peerUid) || '';
    const peerName = (context && context.peerName) || msg.peerName || peerUid || '未知聊天';

    const inner = parseInnerRecords(msg.records);

    return {
        // 唯一键：会话 + 消息 ID，保证重复抓取不会产生两条记录
        id: `${chatType}:${peerUid}:${msg.msgId}`,
        chatType,
        peerUid,
        peerName,
        msgId: String(msg.msgId || ''),
        msgSeq: String(msg.msgSeq || ''),
        msgTime: normalizeTime(msg.msgTime),
        senderName: senderNameOf(msg),
        title: card.title || '聊天记录',
        preview: card.preview || '',
        count: card.count || 0,
        resid: card.resid || '',
        fileName: card.fileName || '',
        // 内部内容状态：0=还没拉过，1=已经拉到，2=拉取失败
        innerState: inner.length > 0 ? 1 : 0,
        inner,
        updatedAt: Date.now()
    };
}

module.exports = {
    parseArkCard,
    parseMultiForwardElement,
    parseCardFromElement,
    parseInnerRecords,
    cardFromMessage,
    messageToText,
    elementToText,
    normalizeTime,
    pickCount
};
