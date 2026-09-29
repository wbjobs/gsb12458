/* UI  wiring：权限、设备、录音控制、预览导出、历史记录、降级上传 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    banner: $('banner'),
    permBadge: $('permBadge'),
    permHint: $('permHint'),
    btnRequestPerm: $('btnRequestPerm'),
    selDevice: $('selDevice'),
    btnRefreshDevices: $('btnRefreshDevices'),
    selSampleRate: $('selSampleRate'),
    selMime: $('selMime'),
    mimeNote: $('mimeNote'),
    recState: $('recState'),
    recTimer: $('recTimer'),
    btnStart: $('btnStart'),
    btnPause: $('btnPause'),
    btnResume: $('btnResume'),
    btnStop: $('btnStop'),
    recHint: $('recHint'),
    previewPanel: $('previewPanel'),
    previewAudio: $('previewAudio'),
    previewInfo: $('previewInfo'),
    btnExport: $('btnExport'),
    btnDiscard: $('btnDiscard'),
    exportHint: $('exportHint'),
    fallbackPanel: $('fallbackPanel'),
    fallbackReason: $('fallbackReason'),
    fileUpload: $('fileUpload'),
    uploadAudio: $('uploadAudio'),
    historyList: $('historyList'),
    historyEmpty: $('historyEmpty'),
  };

  const mgr = new AudioRecorderManager();
  let currentResult = null;   // { blob, mimeType, durationMs }
  let currentUrl = null;
  let lastExportPayload = null; // 导出失败时用于重试

  /* ---------- 工具 ---------- */

  function showBanner(kind, text) {
    els.banner.className = 'banner ' + kind;
    els.banner.textContent = text;
    els.banner.classList.remove('hidden');
  }
  function hideBanner() { els.banner.classList.add('hidden'); }

  function fmtTime(ms) {
    const total = Math.floor(ms / 100);
    const tenths = total % 10;
    const secs = Math.floor(total / 10) % 60;
    const mins = Math.floor(total / 600);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(mins)}:${pad(secs)}.${tenths}`;
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  }

  function setPermBadge(state) {
    const map = {
      granted: ['badge-granted', '已授权'],
      denied: ['badge-denied', '已拒绝'],
      prompt: ['badge-prompt', '待询问'],
      unknown: ['badge-unknown', '未知'],
    };
    const [cls, text] = map[state] || map.unknown;
    els.permBadge.className = 'badge ' + cls;
    els.permBadge.textContent = text;
  }

  function setRecState(state) {
    const map = {
      idle: ['badge-idle', '空闲'],
      recording: ['badge-recording', '录音中'],
      paused: ['badge-paused', '已暂停'],
    };
    const [cls, text] = map[state];
    els.recState.className = 'badge ' + cls;
    els.recState.textContent = text;
    els.btnStart.disabled = state !== 'idle';
    els.btnPause.disabled = state !== 'recording';
    els.btnResume.disabled = state !== 'paused';
    els.btnStop.disabled = state === 'idle';
    els.selDevice.disabled = state !== 'idle';
    els.selSampleRate.disabled = state !== 'idle';
    els.selMime.disabled = state !== 'idle';
  }

  /* ---------- 降级 ---------- */

  function degrade(reason) {
    els.fallbackReason.textContent = reason;
    els.fallbackPanel.classList.remove('hidden');
    els.btnStart.disabled = true;
    els.btnRequestPerm.disabled = true;
    els.selDevice.disabled = true;
    els.selSampleRate.disabled = true;
    els.selMime.disabled = true;
    els.btnRefreshDevices.disabled = true;
  }

  /* ---------- 权限 ---------- */

  async function refreshPermission() {
    const state = await mgr.queryPermission();
    setPermBadge(state);
    if (state === 'denied') {
      els.permHint.textContent = '权限已被拒绝。请点击浏览器地址栏左侧的锁形图标，将麦克风设为"允许"后刷新页面；也可以直接使用下方的文件上传。';
      degrade('麦克风权限被拒绝，无法直接录音。');
    } else if (state === 'granted') {
      els.permHint.textContent = '已获授权，可以直接开始录音。';
    } else {
      els.permHint.textContent = '点击"申请麦克风权限"或"开始录音"，浏览器会弹出授权请求。';
    }
    return state;
  }

  mgr.onPermissionChange = (state) => { setPermBadge(state); };

  /* ---------- 设备 ---------- */

  async function refreshDevices(selectId) {
    try {
      const devices = await mgr.listDevices();
      els.selDevice.innerHTML = '';
      if (devices.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '未检测到麦克风';
        els.selDevice.appendChild(opt);
        showBanner('warn', '未检测到音频输入设备。请连接麦克风后点击"刷新"。');
        return;
      }
      devices.forEach((d, i) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        // 未授权时浏览器可能不返回 label
        opt.textContent = d.label || `麦克风 ${i + 1}（授权后显示名称）`;
        els.selDevice.appendChild(opt);
      });
      if (selectId) els.selDevice.value = selectId;
    } catch (err) {
      showBanner('error', '获取设备列表失败：' + err.message);
    }
  }

  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => refreshDevices());
  }

  /* ---------- 编码格式 ---------- */

  function fillMimeTypes() {
    els.selMime.innerHTML = '';
    const supported = AudioRecorderManager.supportedMimeTypes();
    const def = document.createElement('option');
    def.value = '';
    def.textContent = '浏览器默认';
    els.selMime.appendChild(def);
    supported.forEach((t) => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      els.selMime.appendChild(opt);
    });
    if (supported.length === 0) {
      els.mimeNote.textContent = '未检测到可枚举的编码格式，将使用浏览器默认。';
    }
  }

  /* ---------- 录音控制 ---------- */

  mgr.onTick = (ms) => { els.recTimer.textContent = fmtTime(ms); };
  mgr.onStateChange = (state) => { setRecState(state); };
  mgr.onRecorderError = (err) => {
    showBanner('error', '录音过程出错：' + (err && err.message || err));
    setRecState('idle');
  };

  async function ensureStream() {
    const deviceId = els.selDevice.value || undefined;
    const sampleRate = els.selSampleRate.value ? Number(els.selSampleRate.value) : undefined;
    if (mgr.stream && mgr.deviceId === (deviceId || '') &&
        String(mgr.sampleRate || '') === String(sampleRate || '')) {
      return; // 已有匹配的流
    }
    await mgr.acquireStream({ deviceId, sampleRate });
  }

  els.btnRequestPerm.addEventListener('click', async () => {
    // 用户手势内调用，安全
    try {
      await mgr.acquireStream({});
      setPermBadge('granted');
      els.permHint.textContent = '已获授权，可以直接开始录音。';
      await refreshDevices(mgr.deviceId || undefined);
      hideBanner();
    } catch (err) {
      handleAcquireError(err);
    }
  });

  els.btnStart.addEventListener('click', async () => {
    els.recHint.textContent = '';
    try {
      await ensureStream();
    } catch (err) {
      handleAcquireError(err);
      return;
    }
    const preferred = els.selMime.value;
    const { mimeType, fallback } = mgr.start(preferred);
    if (fallback) {
      els.recHint.textContent = `所选格式不受支持，已降级为 ${mimeType || '浏览器默认格式'}。`;
    }
    els.recTimer.textContent = '00:00.0';
    hideBanner();
  });

  els.btnPause.addEventListener('click', () => mgr.pause());
  els.btnResume.addEventListener('click', () => mgr.resume());

  els.btnStop.addEventListener('click', async () => {
    try {
      currentResult = await mgr.stop();
      showPreview(currentResult);
    } catch (err) {
      showBanner('error', '停止录音失败：' + err.message);
    }
  });

  function handleAcquireError(err) {
    const info = AudioRecorderManager.classifyError(err);
    if (err.name === 'InsecureContextError') {
      showBanner('error', '当前页面不是安全上下文（需要 HTTPS 或 localhost），无法使用麦克风。');
      degrade('非安全上下文，浏览器禁止访问麦克风。');
    } else if (err.name === 'UnsupportedError') {
      showBanner('error', '当前浏览器不支持麦克风录制。');
      degrade('浏览器不支持 MediaDevices API。');
    } else {
      showBanner(info.code === 'denied' ? 'error' : 'warn', info.message);
      if (info.code === 'denied') {
        setPermBadge('denied');
        degrade(info.message);
      } else if (info.code === 'no-device') {
        els.recHint.textContent = info.message;
      } else {
        els.recHint.textContent = info.message;
      }
    }
  }

  /* ---------- 设备切换（带回退） ---------- */

  els.selDevice.addEventListener('change', async () => {
    if (mgr.state !== 'idle') return;
    const deviceId = els.selDevice.value;
    const sampleRate = els.selSampleRate.value ? Number(els.selSampleRate.value) : undefined;
    const res = await mgr.switchDevice(deviceId, sampleRate);
    if (!res.ok) {
      showBanner('warn', '切换设备失败：' + res.error.message +
        (res.rolledBack ? ' 已回退到之前的设备。' : ' 回退也失败，请重新申请权限。'));
      // 同步 UI 到实际设备
      if (res.rolledBack && mgr.deviceId) els.selDevice.value = mgr.deviceId;
    } else {
      hideBanner();
    }
  });

  els.btnRefreshDevices.addEventListener('click', () => refreshDevices());

  /* ---------- 预览与导出 ---------- */

  function showPreview(result) {
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = URL.createObjectURL(result.blob);
    els.previewAudio.src = currentUrl;
    els.previewInfo.textContent =
      `时长 ${fmtTime(result.durationMs)} · 大小 ${fmtSize(result.blob.size)} · 格式 ${result.mimeType || '未知'}`;
    els.previewPanel.classList.remove('hidden');
    els.exportHint.textContent = '';
  }

  async function saveToHistory(result) {
    const record = {
      name: `录音 ${new Date().toLocaleString()}`,
      mimeType: result.mimeType,
      size: result.blob.size,
      durationMs: result.durationMs,
      createdAt: Date.now(),
      blob: result.blob,
    };
    await HistoryDB.add(record);
  }

  async function doExport() {
    if (!currentResult) return;
    const ext = AudioRecorderManager.extensionFor(currentResult.mimeType);
    const filename = `recording-${Date.now()}.${ext}`;
    lastExportPayload = { blob: currentResult.blob, filename };
    try {
      // 1) 存入历史
      await saveToHistory(currentResult);
    } catch (err) {
      els.exportHint.textContent = '保存到历史记录失败（仍可下载）：' + err.message;
    }
    try {
      // 2) 触发下载
      const url = URL.createObjectURL(lastExportPayload.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = lastExportPayload.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      els.exportHint.textContent = '已导出 ' + filename;
      renderHistory();
    } catch (err) {
      els.exportHint.textContent = '导出失败：' + err.message;
      els.btnExport.textContent = '重试导出';
    }
  }

  els.btnExport.addEventListener('click', async () => {
    els.btnExport.textContent = '导出音频文件';
    if (lastExportPayload && els.exportHint.textContent.startsWith('导出失败')) {
      // 重试路径
      try {
        const url = URL.createObjectURL(lastExportPayload.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = lastExportPayload.filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        els.exportHint.textContent = '已导出 ' + lastExportPayload.filename;
        lastExportPayload = null;
      } catch (err) {
        els.exportHint.textContent = '导出失败：' + err.message;
        els.btnExport.textContent = '重试导出';
      }
      return;
    }
    await doExport();
  });

  els.btnDiscard.addEventListener('click', () => {
    currentResult = null;
    lastExportPayload = null;
    if (currentUrl) { URL.revokeObjectURL(currentUrl); currentUrl = null; }
    els.previewAudio.removeAttribute('src');
    els.previewPanel.classList.add('hidden');
  });

  /* ---------- 降级：文件上传 ---------- */

  els.fileUpload.addEventListener('change', () => {
    const file = els.fileUpload.files && els.fileUpload.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    els.uploadAudio.src = url;
    els.uploadAudio.classList.remove('hidden');
  });

  /* ---------- 历史记录 ---------- */

  async function renderHistory() {
    let items = [];
    try {
      items = await HistoryDB.list();
    } catch (err) {
      els.historyEmpty.textContent = '历史记录不可用：' + err.message;
      return;
    }
    els.historyList.innerHTML = '';
    els.historyEmpty.classList.toggle('hidden', items.length > 0);
    items.forEach((item) => {
      const li = document.createElement('li');

      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.innerHTML = '';
      const title = document.createElement('span');
      title.textContent = item.name;
      const sub = document.createElement('small');
      sub.textContent = `${fmtTime(item.durationMs)} · ${fmtSize(item.size)} · ${item.mimeType || ''}`;
      meta.appendChild(title);
      meta.appendChild(sub);

      const audio = document.createElement('audio');
      audio.controls = true;
      audio.src = URL.createObjectURL(item.blob);

      const btnDl = document.createElement('button');
      btnDl.type = 'button';
      btnDl.className = 'secondary';
      btnDl.textContent = '下载';
      btnDl.addEventListener('click', () => {
        const ext = AudioRecorderManager.extensionFor(item.mimeType);
        const url = URL.createObjectURL(item.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `recording-${item.id}.${ext}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      });

      const btnDel = document.createElement('button');
      btnDel.type = 'button';
      btnDel.className = 'secondary';
      btnDel.textContent = '删除';
      btnDel.addEventListener('click', async () => {
        try {
          await HistoryDB.remove(item.id);
          renderHistory();
        } catch (err) {
          showBanner('error', '删除失败：' + err.message);
        }
      });

      li.appendChild(meta);
      li.appendChild(audio);
      li.appendChild(btnDl);
      li.appendChild(btnDel);
      els.historyList.appendChild(li);
    });
  }

  /* ---------- 初始化 ---------- */

  function init() {
    setRecState('idle');
    fillMimeTypes();

    if (!AudioRecorderManager.isSecure()) {
      showBanner('error', '当前页面不是安全上下文（需要 HTTPS 或 localhost），无法使用麦克风录音。');
      degrade('非安全上下文，浏览器禁止访问麦克风。');
      renderHistory();
      return;
    }
    if (!AudioRecorderManager.isSupported()) {
      showBanner('error', '当前浏览器不支持 MediaDevices / MediaRecorder，无法直接录音。');
      degrade('浏览器不支持录音所需的 API。');
      renderHistory();
      return;
    }

    refreshPermission().then((state) => {
      if (state !== 'denied') refreshDevices();
    });
    renderHistory();
  }

  window.addEventListener('pagehide', () => mgr.release());
  init();
})();
