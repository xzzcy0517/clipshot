'use strict';
/**
 * 截图结果 SW 内存暂存。preview 页通过 meta → chunk 循环分块拉取,
 * 避免把几十 MB 的 base64 塞进单条消息或 URL。
 * TTL 10 分钟惰性过期 + 最多驻留 3 个 job(LRU)。
 */
globalThis.ClipShot = globalThis.ClipShot || {};
(function (CS) {
  const TTL_MS = 10 * 60 * 1000;
  const MAX_JOBS = 3;
  /** jobId → 单图 {mime,name,notes,widthPx,heightPx,chunks,segChunkCounts,ts,bytes}
      或多图(P009){items:[同单图结构], ts, bytes} */
  const store = new Map();
  /** 上传会话:uploadId → {items:[], cur:{name,mime,parts}|null, bytes, ts} */
  const uploads = new Map();
  const UPLOAD_MAX_FILE = 50 * 1024 * 1024;
  const UPLOAD_MAX_BATCH = 150 * 1024 * 1024;

  function fresh(entry) { return Date.now() - entry.ts < TTL_MS; }

  function enforce() {
    for (const [id, e] of store) if (!fresh(e)) store.delete(id);
    for (const [id, u] of uploads) if (Date.now() - u.ts >= TTL_MS) uploads.delete(id);
    while (store.size > MAX_JOBS) {
      const oldest = store.keys().next().value;
      store.delete(oldest);
    }
  }

  function chunkSegment(b64, segIndex) {
    const size = CS.CHUNK_B64;
    const out = [];
    for (let i = 0; i < b64.length; i += size) {
      out.push({ seg: segIndex, b64: b64.slice(i, i + size) });
    }
    if (out.length === 0) out.push({ seg: segIndex, b64: '' });
    return out;
  }

  CS.imagestore = {
    /**
     * @param jobId string 键
     * @param data {mime,name,notes,widthPx,heightPx,segments:[{b64}]}
     */
    put(jobId, data) {
      const chunks = [];
      const segChunkCounts = [];
      let bytes = 0;
      (data.segments || []).forEach((seg, i) => {
        const cs = chunkSegment(seg.b64, i);
        segChunkCounts.push(cs.length);
        bytes += seg.b64.length;
        chunks.push(...cs);
      });
      store.set(jobId, {
        mime: data.mime, name: data.name, notes: data.notes || [],
        widthPx: data.widthPx || null, heightPx: data.heightPx || null,
        chunks, segChunkCounts, ts: Date.now(), bytes
      });
      enforce();
      return jobId;
    },

    meta(jobId) {
      const e = store.get(jobId);
      if (!e || !fresh(e)) { store.delete(jobId); return { ok: false, error: CS.ERR.STALE_JOB }; }
      e.ts = Date.now(); // 访问续期
      if (e.items) { // P009 多图:逐张给 meta,分块按 item 索引拉取
        return {
          ok: true,
          items: e.items.map((x) => ({
            mime: x.mime, name: x.name, notes: x.notes,
            widthPx: x.widthPx, heightPx: x.heightPx,
            segments: x.segChunkCounts, chunkCount: x.chunks.length, totalBytes: x.bytes
          }))
        };
      }
      return {
        ok: true, mime: e.mime, name: e.name, notes: e.notes,
        widthPx: e.widthPx, heightPx: e.heightPx,
        segments: e.segChunkCounts, chunkCount: e.chunks.length, totalBytes: e.bytes
      };
    },

    chunk(jobId, item, index) {
      const e = store.get(jobId);
      if (!e || !fresh(e)) { store.delete(jobId); return { ok: false, error: CS.ERR.STALE_JOB }; }
      const holder = e.items ? e.items[item | 0] : e;
      const c = holder && holder.chunks[index];
      if (!c) return { ok: false, error: CS.ERR.STALE_JOB };
      e.ts = Date.now();
      return { ok: true, b64: c.b64, index, seg: c.seg };
    },

    done(jobId) { store.delete(jobId); return { ok: true }; },

    /* ---------------- P009:图片上传会话(分块累积,整批入 store) ---------------- */
    uploadBegin(p) {
      const id = String(p.uploadId || '');
      if (!id) return { ok: false, error: CS.ERR.UNKNOWN };
      let u = uploads.get(id);
      if (!u) { u = { items: [], cur: null, bytes: 0, ts: Date.now() }; uploads.set(id, u); }
      u.ts = Date.now();
      if (!(p.size > 0) || p.size > UPLOAD_MAX_FILE || u.bytes + p.size > UPLOAD_MAX_BATCH) {
        return { ok: false, error: CS.ERR.FILE_TOO_LARGE };
      }
      if (!/^image\//.test(p.mime || '')) return { ok: false, error: CS.ERR.UNKNOWN };
      finalizeCur(u);
      const name = String(p.name || 'image').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 120) || 'image';
      u.cur = { name, mime: p.mime, parts: [] };
      u.bytes += p.size;
      return { ok: true };
    },
    uploadChunk(p) {
      const u = uploads.get(String(p.uploadId || ''));
      if (!u || !u.cur) return { ok: false, error: CS.ERR.STALE_JOB };
      u.ts = Date.now();
      u.cur.parts.push(String(p.b64 || ''));
      return { ok: true };
    },
    uploadDone(p) {
      const id = String(p.uploadId || '');
      const u = uploads.get(id);
      if (!u) return { ok: false, error: CS.ERR.STALE_JOB };
      finalizeCur(u);
      uploads.delete(id);
      if (!u.items.length) return { ok: false, error: CS.ERR.UNKNOWN };
      this.putItems(id, { items: u.items });
      return { ok: true, jobId: id };
    },

    /** 多图入店(P009):items=[{mime,name,notes,widthPx,heightPx,segments:[{b64}]}] */
    putItems(jobId, data) {
      const items = (data.items || []).map((it) => {
        const chunks = [];
        const segChunkCounts = [];
        let bytes = 0;
        (it.segments || []).forEach((seg, i) => {
          const cs = chunkSegment(seg.b64, i);
          segChunkCounts.push(cs.length);
          bytes += seg.b64.length;
          chunks.push(...cs);
        });
        return {
          mime: it.mime, name: it.name, notes: it.notes || [],
          widthPx: it.widthPx || null, heightPx: it.heightPx || null,
          chunks, segChunkCounts, bytes
        };
      });
      store.set(jobId, { items, ts: Date.now(), bytes: items.reduce((n, x) => n + x.bytes, 0) });
      enforce();
      return jobId;
    },

    _size() { return store.size; }
  };

  /** 当前张收束:拼 b64、解尺寸头、动图加注记,并入批次 */
  function finalizeCur(u) {
    if (!u.cur) return;
    const b64 = u.cur.parts.join('');
    const notes = [];
    if (u.cur.mime === 'image/gif') notes.push('动图按首帧编辑与导出');
    let widthPx = null, heightPx = null;
    try {
      const sz = CS.geom.parseImageSize(CS.util.b64Decode(b64.slice(0, 65536 & ~3)));
      if (sz) { widthPx = sz.width; heightPx = sz.height; }
    } catch (e) { /* 尺寸头解析失败不阻断 */ }
    u.items.push({ mime: u.cur.mime, name: u.cur.name, notes, widthPx, heightPx, segments: [{ b64 }] });
    u.cur = null;
  }
})(globalThis.ClipShot);
