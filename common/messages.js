'use strict';
/**
 * ClipShot 消息协议 —— 唯一权威定义。
 * background / content / popup / preview / options 共用(同一份文件,不同加载方式)。
 * 约定:
 *  - 所有 runtime 消息形如 { type: <MSG.*>, ...payload },响应为对象 { ok:true|false, ... }
 *  - 错误响应统一 { ok:false, error:<ERR.* 字符串> }
 *  - 跨边界坐标一律使用「文档 CSS px」,视口→文档换算只发生在 content 一处
 */
globalThis.ClipShot = globalThis.ClipShot || {};
(function (CS) {
  CS.EXT_VER = '0.1.0';

  /** 一次性消息类型(request/response) */
  CS.MSG = {
    // popup / 命令 → sw
    STATE_GET: 'cs/state.get',      // {} → {busyTabs:[{tabId,mode,phase,pct}]}
    JOB_START: 'cs/job.start',      // {tabId,mode,opts} → {ok,jobId} | {ok:false,error}
    JOB_CANCEL: 'cs/job.cancel',    // {tabId} → {ok}
    // sw → popup 广播(无响应,发送方忽略失败)
    JOB_EVENT: 'cs/job.event',      // {jobId,tabId,mode,phase,pct,text}
    // preview → sw
    IMG_META: 'cs/image.meta',      // {jobId} → {ok,mime,name,widthPx,heightPx,segments,chunkCount,totalBytes,notes[]}
    IMG_CHUNK: 'cs/image.chunk',    // {jobId,index} → {ok,b64,index}
    IMG_DONE: 'cs/image.done',      // {jobId} → {ok}
    // sw → content
    PING: 'cs/ping',                // {} → {ok,ver}
    METRICS: 'cs/metrics',          // {} → {ok,docW,docH,vw,vh,dpr,scroller,scrollerPath}
    SCROLL_START: 'cs/scroll.start',// {cfg} → {ok}(随后 content 建立 SCROLL_PORT)
    SCROLL_STOP: 'cs/scroll.stop',  // {reason} → {ok}
    HIDE_FIXED: 'cs/hideFixed',     // {} → {ok,fixedCount,stickyCount}
    RESTORE_FIXED: 'cs/restoreFixed',// {} → {ok,restored}
    PICK_GET: 'cs/pick.get',        // {maxAgeMs} → {ok,rectDoc,tag} | {ok:false,error}
    MARQUEE_BEGIN: 'cs/marquee.begin',// {} → {ok}
    MARQUEE_CLEAR: 'cs/marquee.clear',// {} → {ok}
    // content → sw
    MARQUEE_RESULT: 'cs/marquee.result',// {x,y,w,h} 视口 CSS px → {ok}
    MARQUEE_CANCEL: 'cs/marquee.cancel',// {reason} → {ok}
    // options 诊断 → sw
    DIAG_METRICS: 'cs/diag.metrics' // {tabId} → {ok,raw,metrics,dpr} | {ok:false,error}
  };

  /** 长时通道:自动滚动进度 */
  CS.SCROLL_PORT = 'clip/scroll';
  // content → sw:{ev:'progress',scrollTop,docH,pct} {ev:'heartbeat'} {ev:'stepSettled',scrollTop,docH}
  //             {ev:'atTopDone'} {ev:'done',fullyScrolled,infinite,stoppedBy} {ev:'error',code,msg}
  // sw → content:{cmd:'proceed'} {cmd:'stop'}

  /** 错误码 */
  CS.ERR = {
    BUSY: 'BUSY',
    PAGE_NOT_ALLOWED: 'PAGE_NOT_ALLOWED',
    CONTENT_DEAD: 'CONTENT_DEAD',
    DEVTOOLS_CONFLICT: 'DEVTOOLS_CONFLICT',
    ATTACH_FAIL: 'ATTACH_FAIL',
    USER_CANCELED_BANNER: 'USER_CANCELED_BANNER',
    NO_TARGET: 'NO_TARGET',
    ELEMENT_GONE: 'ELEMENT_GONE',
    CAPTURE_TIMEOUT: 'CAPTURE_TIMEOUT',
    PAGE_TOO_LARGE: 'PAGE_TOO_LARGE',
    MEMORY_LIMIT: 'MEMORY_LIMIT',
    SCROLL_FAILED: 'SCROLL_FAILED',
    STALE_JOB: 'STALE_JOB',
    UNKNOWN: 'UNKNOWN'
  };

  /** 中文文案表 —— popup / preview / 通知只按码显示 */
  CS.ERR_TEXT = {
    BUSY: '该标签页正在截图中,请等待当前任务完成',
    PAGE_NOT_ALLOWED: '此页面不允许截图,请在普通网页使用',
    CONTENT_DEAD: '页面脚本未就绪,请刷新该页面后再试',
    DEVTOOLS_CONFLICT: '请先关闭该标签页的开发者工具(F12),再重试',
    ATTACH_FAIL: '无法建立调试会话,截图失败',
    USER_CANCELED_BANNER: '调试已被取消,截图中止(截图期间请勿点击顶部提示条的「取消」)',
    NO_TARGET: '未找到可截图的目标(不支持 iframe 框架内元素)',
    ELEMENT_GONE: '未找到右键的元素,请先在目标元素上右键再选择「截取此元素」',
    CAPTURE_TIMEOUT: '截图超时,页面可能过大或过重,建议改用可视区域截图',
    PAGE_TOO_LARGE: '页面超出可捕获范围,建议分段或降低分辨率',
    MEMORY_LIMIT: '截图数据过大,超出内存限制,请在设置中改用 JPEG 或降低阈值',
    SCROLL_FAILED: '页面在滚动过程中发生变化(如刷新),请重试',
    STALE_JOB: '该截图缓存已过期,请重新截取',
    UNKNOWN: '发生未知错误,请查看控制台'
  };

  /** 阶段中文标签(popup 进度显示) */
  CS.PHASE_TEXT = {
    check: '检查页面',
    inject: '注入确认',
    attach: '建立调试会话',
    metrics: '读取页面尺寸',
    hideFixed: '隐藏固定元素',
    scroll: '滚动加载',
    backToTop: '回到顶部',
    capture: '截图',
    stitch: '分段拼接',
    done: '完成',
    failed: '失败'
  };

  /** base64 分块大小(字符数),preview 逐块拉取 */
  CS.CHUNK_B64 = 512 * 1024;

  CS.errText = function (code) {
    return CS.ERR_TEXT[code] || CS.ERR_TEXT.UNKNOWN;
  };
})(globalThis.ClipShot);
