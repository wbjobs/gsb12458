/* UI 装配：状态展示、事件绑定、降级处理（无框架） */
(function () {
  'use strict';

  var R = window.MicRecorder;
  var DB = window.RecorderDB;

  var el = {};
  [
    'banner', 'fallback-panel', 'fallback-reason', 'upload-input',
    'permission-status', 'record-state', 'duration',
    'device-select', 'refresh-devices', 'sample-rate-select', 'codec-select', 'codec-note',
    'btn-request', 'btn-start', 'btn-pause', 'btn-resume', 'btn-stop',
    'preview-card', 'preview-audio', 'preview-meta', 'btn-export', 'btn-retry-export', 'btn-discard',
    'history-list', 'history-empty'
  ].forEach(function (id) {
    el[id] = document.getElementById(id);
  });

  var session = null;          // 当前 RecorderSession
  var lastBlob = null;         // 最近一次录音结果
  var lastMimeType = '';
  var lastDuration = 0;        // 秒
  var timerId = null;
  var elapsedBeforePause = 0;  // 暂停前累计毫秒
  var startedAt = 0;           // 当前计时段起点
  var switchingDevice = false;

  /* ---------- 提示与状态展示 ---------- */

  function showBanner(text, type) {
    el['banner'].textContent = text;
    el['banner'].className = 'banner' + (type ? ' ' + type : '');
  }
  function hideBanner() {
    el['banner'].classList.add('hidden');
  }

  function refreshPermissionStatus() {
    R.queryPermission().then(function (state) {
      var badge = el['permission-status'];
      badge.classList.remove('granted', 'denied');
      if (state === 'granted') { badge.textContent = '已授权'; badge.classList.add('granted'); }
      else if (state === 'denied') { badge.textContent = '已拒绝'; badge.classList.add('denied'); }
      else if (state === 'prompt') { badge.textContent = '待申请'; }
      else { badge.textContent = '未知（浏览器不支持查询）'; }
    });
  }

  function setRecordState(state) {
    var badge = el['record-state'];
    var map = { inactive: '空闲', recording: '录音中', paused: '已暂停' };
    badge.textContent = map[state] || state;
    badge.classList.remove('recording', 'paused');
    if (state === 'recording') badge.classList.add('recording');
    if (state === 'paused') badge.classList.add('paused');
    updateButtons();
  }

  function updateButtons() {
    var state = session ? session.state : 'inactive';
    el['btn-start'].disabled = state !== 'inactive' || switchingDevice;
    el['btn-pause'].disabled = state !== 'recording';
    el['btn-resume'].disabled = state !== 'paused';
    el['btn-stop'].disabled = state === 'inactive';
  }

  /* ---------- 计时 ---------- */

  function currentElapsed() {
    if (!session || session.state === 'inactive') return elapsedBeforePause;
    if (session.state === 'paused') return elapsedBeforePause;
    return elapsedBeforePause + (Date.now() - startedAt);
  }

  function tick() {
    var ms = currentElapsed();
    var totalSec = ms / 1000;
    var min = Math.floor(totalSec / 60);
    var sec = Math.floor(totalSec % 60);
    var tenth = Math.floor((ms % 1000) / 100);
    el['duration'].textContent =
      String(min).padStart(2, '0') + ':' + String(sec).padStart(2, '0') + '.' + tenth;
  }

  function startTimer() {
    startedAt = Date.now();
    stopTimer();
    timerId = setInterval(tick, 100);
  }
  function pauseTimer() {
    elapsedBeforePause += Date.now() - startedAt;
    stopTimer();
    tick();
  }
  function stopTimer() {
    if (timerId) { clearInterval(timerId); timerId = null; }
  }
  function resetTimer() {
    stopTimer();
    elapsedBeforePause = 0;
    lastDuration = 0;
    el['duration'].textContent = '00:00.0';
  }

  /* ---------- 设备与编码 ---------- */

  function refreshDevices() {
    return R.listAudioDevices().then(function (devices) {
      var select = el['device-select'];
      var prev = select.value;
      select.innerHTML = '';
      if (!devices.length) {
        var opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '未检测到麦克风';
        select.appendChild(opt);
        return;
      }
      devices.forEach(function (d, i) {
        var opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || ('麦克风 ' + (i + 1));
        select.appendChild(opt);
      });
      if (prev && devices.some(function (d) { return d.deviceId === prev; })) {
        select.value = prev;
      }
      select.dataset.current = select.value;
    });
  }

  function refreshCodecs() {
    var supported = R.getSupportedCodecs();
    var select = el['codec-select'];
    select.innerHTML = '';
    if (!supported.length) {
      var opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '浏览器默认格式';
      select.appendChild(opt);
      el['codec-note'].textContent = '当前浏览器未声明支持任何已知格式，将使用浏览器默认编码。';
      el['codec-note'].classList.remove('hidden');
      return;
    }
    supported.forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c.mimeType;
      opt.textContent = c.label;
      select.appendChild(opt);
    });
    var skipped = R.CODEC_CANDIDATES.length - supported.length;
    if (skipped > 0) {
      el['codec-note'].textContent = '部分编码格式不受当前浏览器支持，已自动隐藏，仅列出可用格式。';
      el['codec-note'].classList.remove('hidden');
    } else {
      el['codec-note'].classList.add('hidden');
    }
  }

  /* ---------- 会话管理 ---------- */

  function selectedOptions(deviceIdOverride) {
    var rate = parseInt(el['sample-rate-select'].value, 10);
    return {
      deviceId: deviceIdOverride !== undefined ? deviceIdOverride : (el['device-select'].value || undefined),
      sampleRate: isNaN(rate) ? undefined : rate,
      mimeType: el['codec-select'].value || undefined
    };
  }

  function openSession(options) {
    return R.createSession(options).then(function (s) {
      releaseSession();
      session = s;
      wireSession(s);
      setRecordState('inactive');
      el['device-select'].dataset.current = el['device-select'].value;
      return s;
    });
  }

  function wireSession(s) {
    s.onstatechange = function (state) {
      if (state === 'recording') startTimer();
      else if (state === 'paused') pauseTimer();
      setRecordState(state);
    };
    s.onstop = function (blob) {
      lastDuration = currentElapsed() / 1000;
      stopTimer();
      tick();
      lastBlob = blob;
      lastMimeType = s.mimeType;
      showPreview(blob, s.mimeType, lastDuration);
      saveToHistory(blob, s.mimeType, lastDuration);
    };
    s.onerror = function (err) {
      showBanner('录音出错：' + err.message, 'error');
      stopTimer();
    };
  }

  function releaseSession() {
    if (session) {
      session.onstatechange = null;
      session.onstop = null;
      session.onerror = null;
      session.release();
      session = null;
    }
  }

  /** 统一的错误处理：按错误码给出对应提示与降级 */
  function handleSessionError(err) {
    switch (err.code) {
      case 'PERMISSION_DENIED':
        showBanner(err.message, 'error');
        el['permission-status'].textContent = '已拒绝';
        el['permission-status'].classList.add('denied');
        break;
      case 'NO_DEVICE':
        showBanner(err.message + '。你可以改用下方文件上传。', 'error');
        showFallback('未检测到麦克风设备');
        break;
      case 'DEVICE_BUSY':
      case 'OVERCONSTRAINED':
      case 'ABORTED':
        showBanner(err.message, 'error');
        break;
      case 'INSECURE_CONTEXT':
      case 'UNSUPPORTED':
        showFallback(err.message);
        break;
      default:
        showBanner(err.message || '发生未知错误', 'error');
    }
    refreshPermissionStatus();
  }

  /* ---------- 降级面板 ---------- */

  function showFallback(reason) {
    el['fallback-reason'].textContent = reason;
    el['fallback-panel'].classList.remove('hidden');
  }

  /* ---------- 预览 / 导出 / 历史 ---------- */

  function extForMime(mime) {
    var found = R.CODEC_CANDIDATES.find(function (c) { return c.mimeType === mime; });
    if (found) return found.ext;
    if (mime.indexOf('mp4') !== -1) return 'm4a';
    if (mime.indexOf('ogg') !== -1) return 'ogg';
    if (mime.indexOf('wav') !== -1) return 'wav';
    return 'webm';
  }

  function showPreview(blob, mimeType, durationSec) {
    el['preview-audio'].src = URL.createObjectURL(blob);
    el['preview-meta'].textContent =
      '格式：' + (mimeType || '未知') +
      '　大小：' + (blob.size / 1024).toFixed(1) + ' KB' +
      '　时长：' + durationSec.toFixed(1) + ' 秒';
    el['preview-card'].classList.remove('hidden');
    el['btn-retry-export'].classList.add('hidden');
    el['btn-export'].classList.remove('hidden');
  }

  function hidePreview() {
    el['preview-card'].classList.add('hidden');
    el['preview-audio'].removeAttribute('src');
    lastBlob = null;
  }

  function doExport() {
    if (!lastBlob) return;
    var filename = 'recording-' + new Date().toISOString().replace(/[:.]/g, '-') +
      '.' + extForMime(lastMimeType);
    R.exportBlob(lastBlob, filename).then(function () {
      el['btn-retry-export'].classList.add('hidden');
      el['btn-export'].classList.remove('hidden');
      showBanner('导出成功', 'ok');
    }, function () {
      el['btn-export'].classList.add('hidden');
      el['btn-retry-export'].classList.remove('hidden');
      showBanner('导出失败，请点击重试', 'error');
    });
  }

  function saveToHistory(blob, mimeType, durationSec) {
    DB.save({
      blob: blob,
      mimeType: mimeType,
      duration: durationSec,
      createdAt: Date.now(),
      name: '录音 ' + new Date().toLocaleString()
    }).then(loadHistory, function (err) {
      showBanner('历史记录保存失败：' + err.message, 'error');
    });
  }

  function loadHistory() {
    DB.list().then(function (items) {
      el['history-list'].innerHTML = '';
      el['history-empty'].classList.toggle('hidden', items.length > 0);
      items.forEach(function (item) {
        var li = document.createElement('li');

        var meta = document.createElement('span');
        meta.className = 'meta';
        meta.textContent = item.name + '（' + (item.duration || 0).toFixed(1) + 's）';
        li.appendChild(meta);

        var audio = document.createElement('audio');
        audio.controls = true;
        audio.src = URL.createObjectURL(item.blob);
        li.appendChild(audio);

        var download = document.createElement('button');
        download.type = 'button';
        download.textContent = '下载';
        download.addEventListener('click', function () {
          R.exportBlob(item.blob, item.name + '.' + extForMime(item.mimeType))
            .catch(function () { showBanner('导出失败，请重试', 'error'); });
        });
        li.appendChild(download);

        var del = document.createElement('button');
        del.type = 'button';
        del.textContent = '删除';
        del.addEventListener('click', function () {
          DB.remove(item.id).then(loadHistory, function () {
            showBanner('删除失败', 'error');
          });
        });
        li.appendChild(del);

        el['history-list'].appendChild(li);
      });
    }).catch(function (err) {
      el['history-empty'].textContent = '历史记录不可用：' + err.message;
    });
  }

  /* ---------- 事件绑定（getUserMedia 仅在用户交互后调用） ---------- */

  el['btn-request'].addEventListener('click', function () {
    hideBanner();
    openSession(selectedOptions()).then(function () {
      showBanner('麦克风权限已获取，可以开始录音', 'ok');
      refreshPermissionStatus();
      refreshDevices(); // 授权后可拿到设备标签
    }).catch(handleSessionError);
  });

  el['btn-start'].addEventListener('click', function () {
    hideBanner();
    resetTimer();
    hidePreview();
    var start = session
      ? Promise.resolve(session)
      : openSession(selectedOptions());
    start.then(function (s) {
      s.start();
    }).catch(handleSessionError);
  });

  el['btn-pause'].addEventListener('click', function () {
    if (session) session.pause();
  });

  el['btn-resume'].addEventListener('click', function () {
    if (session) session.resume();
  });

  el['btn-stop'].addEventListener('click', function () {
    if (session) session.stop();
  });

  /* 设备切换：失败时回退到之前的设备 */
  el['device-select'].addEventListener('change', function () {
    var select = el['device-select'];
    var newId = select.value;
    var prevId = select.dataset.current || '';
    if (newId === prevId) return;
    switchingDevice = true;
    updateButtons();
    openSession(selectedOptions(newId)).then(function () {
      select.dataset.current = newId;
      showBanner('已切换到新设备', 'ok');
    }).catch(function (err) {
      select.value = prevId; // 回退选择
      showBanner('设备切换失败，已回退到原设备：' + err.message, 'error');
    }).then(function () {
      switchingDevice = false;
      updateButtons();
    });
  });

  el['refresh-devices'].addEventListener('click', function () {
    refreshDevices().catch(function () {
      showBanner('设备列表刷新失败', 'error');
    });
  });

  el['btn-export'].addEventListener('click', doExport);
  el['btn-retry-export'].addEventListener('click', doExport);
  el['btn-discard'].addEventListener('click', function () {
    hidePreview();
    resetTimer();
  });

  /* 降级：文件上传 */
  el['upload-input'].addEventListener('change', function () {
    var file = el['upload-input'].files[0];
    if (!file) return;
    lastBlob = file;
    lastMimeType = file.type || 'audio/*';
    el['preview-card'].classList.remove('hidden');
    el['preview-audio'].src = URL.createObjectURL(file);
    el['preview-meta'].textContent =
      '已上传：' + file.name + '　大小：' + (file.size / 1024).toFixed(1) + ' KB';
    saveToHistory(file, lastMimeType, 0);
  });

  /* ---------- 初始化（不触发任何权限请求） ---------- */

  function init() {
    if (!R.isSecure()) {
      showFallback('当前页面不是安全上下文（需要 HTTPS 或 localhost），浏览器禁止访问麦克风');
    } else if (!R.isMediaSupported()) {
      showFallback('当前浏览器不支持 MediaDevices / MediaRecorder，无法录音');
    }
    refreshPermissionStatus();
    R.watchPermission(function () { refreshPermissionStatus(); });
    refreshCodecs();
    refreshDevices();
    loadHistory();
    updateButtons();
    resetTimer();
  }

  init();
})();
