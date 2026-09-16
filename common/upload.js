'use strict';
/**
 * P009:图片上传公共逻辑(popup / preview 空态共用)。
 * File[] → base64 分块 → SW imagestore 上传会话 → 返回 preview 可拉取的 jobId。
 * 协议消息见 common/messages.js(cs/upload.*);会话与上限由 background/imagestore.js 强制。
 */
globalThis.ClipShot = globalThis.ClipShot || {};
(function (CS) {
  const CHUNK = CS.CHUNK_B64 || 512 * 1024;

  function readB64(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => { const s = String(r.result || ''); res(s.slice(s.indexOf(',') + 1)); };
      r.onerror = () => rej(r.error || new Error('read failed'));
      r.readAsDataURL(file);
    });
  }

  /**
   * @param files FileList | File[]
   * @param onProgress (text) => void 可选进度回调
   * @returns Promise<{ok:true, jobId} | {ok:false, error}>
   */
  CS.uploadImages = async function (files, onProgress) {
    const list = [...files].filter((f) => /^image\//.test(f.type));
    if (!list.length) return { ok: false, error: 'NO_IMAGE' };
    const uploadId = crypto.randomUUID();
    const send = (msg) => chrome.runtime.sendMessage(msg);
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (onProgress) onProgress('正在上传 ' + (i + 1) + '/' + list.length + ':' + f.name);
      const b64 = await readB64(f);
      let r = await send({ type: CS.MSG.UPLOAD_BEGIN, uploadId, name: f.name, mime: f.type, size: f.size });
      if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'UNKNOWN' };
      for (let p = 0; p < b64.length; p += CHUNK) {
        r = await send({ type: CS.MSG.UPLOAD_CHUNK, uploadId, b64: b64.slice(p, p + CHUNK) });
        if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'UNKNOWN' };
      }
    }
    const d = await send({ type: CS.MSG.UPLOAD_DONE, uploadId });
    if (!d || !d.ok) return { ok: false, error: (d && d.error) || 'UNKNOWN' };
    return { ok: true, jobId: d.jobId };
  };
})(globalThis.ClipShot);
