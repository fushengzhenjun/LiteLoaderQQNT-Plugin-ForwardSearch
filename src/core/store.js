/**
 * 本地存储 + 全文检索
 * ------------------------------------------------------------------
 * 设计取舍（重要，别改成数据库）：
 * 为了做到"装完就能用、不装任何额外东西"，这里不用 SQLite、不用原生模块，
 * 只用 Node 自带的 fs 存一个 JSONL 文件，全部记录放在内存里。
 *
 * 为什么不建倒排索引：
 * 倒排索引在中文下会膨胀得很快（要做 bigram，几万条卡片就能吃掉几百 MB）。
 * 而"逐条字符串包含判断"在这个数据量下其实非常快——
 * 5 万条卡片、平均 200 字，全量扫一遍大约 20~40ms，比建索引更省内存也更简单。
 * 所以这里选择"预计算搜索文本 + 线性扫描"，换取轻量和零维护成本。
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** 搜索文本归一化：转小写、压缩空白，让匹配更宽松 */
function normalize(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * 去掉内部缓存字段再返回给渲染层。
 * 这些字段只在主进程里用，跨进程传过去纯属浪费带宽。
 */
function strip(rec) {
    const out = Object.assign({}, rec);
    delete out._search;
    delete out._innerText;
    delete out._titleText;
    return out;
}

class CardStore {
    /**
     * @param {string} dir 插件数据目录
     */
    constructor(dir) {
        this.dir = dir;
        this.file = path.join(dir, 'records.jsonl');
        this.records = [];          // 全量记录数组
        this.byId = new Map();      // id -> record，用于去重更新
        this._pos = new Map();      // id -> 在 records 数组里的下标（避免每次 indexOf 全表扫）
        this.pendingLines = [];     // 待落盘的行缓冲
        this.flushTimer = null;
        this.ready = false;
        this._ensureDir();
    }

    _ensureDir() {
        try {
            if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
        } catch (err) {
            console.error('[forward-search] 创建数据目录失败', err);
        }
    }

    /**
     * 从磁盘载入。
     * JSONL 是"追加写"的，同一个 id 后写的覆盖先写的，所以顺序读、后者胜出。
     */
    load() {
        this.records = [];
        this.byId.clear();
        this._pos.clear();

        let raw = '';
        try {
            if (fs.existsSync(this.file)) raw = fs.readFileSync(this.file, 'utf8');
        } catch (err) {
            console.error('[forward-search] 读取数据文件失败', err);
        }

        if (raw) {
            for (const line of raw.split('\n')) {
                if (!line.trim()) continue;
                try {
                    const rec = JSON.parse(line);
                    if (!rec || !rec.id) continue;
                    this.byId.set(rec.id, rec);
                } catch (_) {
                    // 单行损坏就跳过，不能让整个索引起不来
                }
            }
            this.records = Array.from(this.byId.values());
            for (let i = 0; i < this.records.length; i++) this._pos.set(this.records[i].id, i);
        }

        for (const rec of this.records) this._reindex(rec);
        this.ready = true;
        return this.records.length;
    }

    /** 预先算好这条记录的可搜索文本，搜索时就不用反复拼接了 */
    _reindex(rec) {
        const innerText = (rec.inner || []).map((m) => `${m.name} ${m.text}`).join(' ');
        rec._search = normalize(`${rec.peerName} ${rec.title} ${rec.preview} ${innerText}`);
        rec._innerText = normalize(innerText);
        rec._titleText = normalize(`${rec.peerName} ${rec.title} ${rec.preview}`);
    }

    /** 写入或更新一条记录 */
    upsert(rec) {
        if (!rec || !rec.id) return false;

        const old = this.byId.get(rec.id);
        // 已有内部内容、这次带的是空的 —— 保留旧的，别把数据洗掉
        if (old && (old.inner || []).length > 0 && (rec.inner || []).length === 0) {
            rec.inner = old.inner;
            rec.innerState = old.innerState;
        }
        // 保留首次收录时间
        if (old && old.firstSeenAt) rec.firstSeenAt = old.firstSeenAt;
        else rec.firstSeenAt = rec.firstSeenAt || Date.now();

        rec.updatedAt = Date.now();
        this._reindex(rec);

        if (this._pos.has(rec.id)) {
            // 已有记录：原地替换，保持数组顺序稳定
            this.records[this._pos.get(rec.id)] = rec;
        } else {
            this._pos.set(rec.id, this.records.length);
            this.records.push(rec);
        }
        this.byId.set(rec.id, rec);

        this._queueLine(rec);
        return true;
    }

    /** 批量写入，减少 IO 次数 */
    upsertMany(list) {
        let n = 0;
        for (const rec of list || []) {
            if (this.upsert(rec)) n++;
        }
        return n;
    }

    _queueLine(rec) {
        // 落盘时不写内部缓存字段（_search 之类）
        const clean = Object.assign({}, rec);
        delete clean._search;
        delete clean._innerText;
        delete clean._titleText;

        this.pendingLines.push(JSON.stringify(clean));
        if (this.pendingLines.length >= 200) this.flush();
        else this._scheduleFlush();
    }

    _scheduleFlush() {
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            this.flush();
        }, 800);
        // 别让定时器拖住 QQ 退出
        if (this.flushTimer.unref) this.flushTimer.unref();
    }

    /** 把缓冲的行真正写到磁盘 */
    flush() {
        if (this.pendingLines.length === 0) return;
        const lines = this.pendingLines.join('\n') + '\n';
        this.pendingLines = [];
        try {
            fs.appendFileSync(this.file, lines, 'utf8');
        } catch (err) {
            console.error('[forward-search] 写入数据文件失败', err);
        }
    }

    /**
     * 检索。
     * 规则：空格分隔的多个词必须全部命中（AND）；标题/群名命中排在内容命中前面。
     */
    search(query, limit = 60, peerUid = '') {
        const terms = normalize(query).split(' ').filter(Boolean);
        if (terms.length === 0) return [];
        const onlyPeer = peerUid ? String(peerUid) : '';

        const hits = [];
        for (const rec of this.records) {
            // 只看某个会话时先按会话过滤：这样 limit 不会被别的群占满
            if (onlyPeer && String(rec.peerUid) !== onlyPeer) continue;

            const text = rec._search || '';
            let ok = true;
            for (const t of terms) {
                if (text.indexOf(t) === -1) {
                    ok = false;
                    break;
                }
            }
            if (!ok) continue;

            // 打分：群名或卡片标题直接命中，权重更高
            let score = 0;
            const titleText = rec._titleText || '';
            for (const t of terms) {
                if (titleText.indexOf(t) !== -1) score += 10;
                if ((rec._innerText || '').indexOf(t) !== -1) score += 3;
            }
            if (rec.innerState === 1) score += 1;

            hits.push({ rec, score });
        }

        hits.sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return (b.rec.msgTime || 0) - (a.rec.msgTime || 0);
        });

        return hits.slice(0, limit).map((h) => strip(h.rec));
    }

    /** 取一条完整记录（含内部消息） */
    get(id) {
        const rec = this.byId.get(id);
        return rec ? strip(rec) : null;
    }

    /** 更新某条卡片的内部内容 */
    setInner(id, inner, state) {
        const rec = this.byId.get(id);
        if (!rec) return null;
        rec.inner = inner || [];
        rec.innerState = state;
        this._reindex(rec);
        this._queueLine(rec);
        return rec;
    }

    /** 取出"还没拉过内容"的卡片，供补全队列使用 */
    pending(limit = 200, filter = {}) {
        const out = [];
        for (const rec of this.records) {
            if (rec.innerState !== 0) continue;
            if (!rec.resid) continue;
            if (filter.since && (rec.msgTime || 0) < filter.since) continue;
            if (filter.peerUid && rec.peerUid !== filter.peerUid) continue;
            out.push(strip(rec));
            if (out.length >= limit) break;
        }
        return out;
    }

    stats() {
        let withInner = 0;
        let pendingCount = 0;
        const groups = new Set();
        for (const rec of this.records) {
            if (rec.innerState === 1) withInner++;
            else if (rec.innerState === 0 && rec.resid) pendingCount++;
            if (rec.peerUid) groups.add(rec.peerUid);
        }
        return {
            total: this.records.length,
            withInner,
            pending: pendingCount,
            groups: groups.size
        };
    }

    /**
     * 压缩数据文件：把同一个 id 的历史版本合并掉。
     * 补全一轮之后文件会膨胀，定期压一次能保住体积。
     */
    compact() {
        this.flush();
        try {
            const lines = [];
            for (const rec of this.records) {
                const clean = Object.assign({}, rec);
                delete clean._search;
                delete clean._innerText;
                delete clean._titleText;
                lines.push(JSON.stringify(clean));
            }
            const tmp = this.file + '.tmp';
            fs.writeFileSync(tmp, lines.join('\n') + '\n', 'utf8');
            fs.renameSync(tmp, this.file);
            return true;
        } catch (err) {
            console.error('[forward-search] 压缩数据文件失败', err);
            return false;
        }
    }

    /** 清空全部数据（设置页里的"清除索引"用） */
    clear() {
        this.records = [];
        this.byId.clear();
        this._pos.clear();
        this.pendingLines = [];
        try {
            if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
        } catch (err) {
            console.error('[forward-search] 清空数据失败', err);
        }
    }
}

module.exports = { CardStore, normalize };
