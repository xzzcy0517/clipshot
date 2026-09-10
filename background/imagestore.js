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
  /** jobId → { mime, name, notes, widthPx, heightPx, chunks:[{seg,b64}], segChunkCounts:[n], ts, bytes } */
  const store = new Map();

  function fresh(entry) { return Date.now() - entry.ts < TTL_MS; }

  function enforce() {
    for (const [id, e] of store) if (!fresh(e)) store.delete(id);
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
      return {
        ok: true, mime: e.mime, name: e.name, notes: e.notes,
        widthPx: e.widthPx, heightPx: e.heightPx,
        segments: e.segChunkCounts, chunkCount: e.chunks.length, totalBytes: e.bytes
      };
    },

    chunk(jobId, index) {
      const e = store.get(jobId);
      if (!e || !fresh(e)) { store.delete(jobId); return { ok: false, error: CS.ERR.STALE_JOB }; }
      const c = e.chunks[index];
      if (!c) return { ok: false, error: CS.ERR.STALE_JOB };
      e.ts = Date.now();
      return { ok: true, b64: c.b64, index, seg: c.seg };
    },

    done(jobId) { store.delete(jobId); return { ok: true }; },

    _size() { return store.size; }
  };
})(globalThis.ClipShot);
