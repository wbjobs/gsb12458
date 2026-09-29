/* 录音核心：权限、设备、MediaRecorder 封装（无框架） */
(function (global) {
  'use strict';

  /** 候选编码格式，按优先级排序；不支持的会被过滤降级 */
  var CODEC_CANDIDATES = [
    { mimeType: 'audio/webm;codecs=opus', label: 'WebM / Opus', ext: 'webm' },
    { mimeType: 'audio/mp4', label: 'MP4 / AAC', ext: 'm4a' },
    { mimeType: 'audio/ogg;codecs=opus', label: 'OGG / Opus', ext: 'ogg' },
    { mimeType: 'audio/wav', label: 'WAV', ext: 'wav' }
  ];

  function isSecure() {
    return global.isSecureContext === true;
  }

  function isMediaSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && global.MediaRecorder);
  }

  /** 查询权限状态：granted / denied / prompt / unknown */
  function queryPermission() {
    if (!navigator.permissions || !navigator.permissions.query) {
      return Promise.resolve('unknown');
    }
    return navigator.permissions.query({ name: 'microphone' })
      .then(function (status) { return status.state; })
      .catch(function () { return 'unknown'; });
  }

  /** 监听权限变化（浏览器支持时） */
  function watchPermission(callback) {
    if (!navigator.permissions || !navigator.permissions.query) return;
    navigator.permissions.query({ name: 'microphone' }).then(function (status) {
      status.onchange = function () { callback(status.state); };
    }).catch(function () { /* 忽略 */ });
  }

  /** 获取当前环境支持的编码格式列表 */
  function getSupportedCodecs() {
    return CODEC_CANDIDATES.filter(function (c) {
      try {
        return global.MediaRecorder && MediaRecorder.isTypeSupported(c.mimeType);
      } catch (e) {
        return false;
      }
    });
  }

  /** 枚举音频输入设备 */
  function listAudioDevices() {
    if (!isMediaSupported()) return Promise.resolve([]);
    return navigator.mediaDevices.enumerateDevices().then(function (devices) {
      return devices.filter(function (d) { return d.kind === 'audioinput'; });
    });
  }

  /**
   * 申请麦克风并创建录音器。
   * options: { deviceId, sampleRate, mimeType }
   * 返回 Promise<RecorderSession>
   */
  function createSession(options) {
    options = options || {};
    if (!isSecure()) {
      return Promise.reject(makeError('INSECURE_CONTEXT', '当前页面不是安全上下文（需要 HTTPS 或 localhost），无法访问麦克风'));
    }
    if (!isMediaSupported()) {
      return Promise.reject(makeError('UNSUPPORTED', '当前浏览器不支持 MediaDevices / MediaRecorder'));
    }

    var constraints = {
      audio: {
        deviceId: options.deviceId ? { exact: options.deviceId } : undefined,
        sampleRate: options.sampleRate ? { ideal: options.sampleRate } : undefined
      }
    };

    return navigator.mediaDevices.getUserMedia(constraints).then(function (stream) {
      var mimeType = pickMimeType(options.mimeType);
      var recorder;
      try {
        recorder = mimeType
          ? new MediaRecorder(stream, { mimeType: mimeType })
          : new MediaRecorder(stream);
      } catch (e) {
        stopStream(stream);
        throw makeError('CODEC_UNSUPPORTED', '编码格式不受支持，且无法创建录音器');
      }
      return new RecorderSession(recorder, stream, mimeType || recorder.mimeType);
    }, function (err) {
      throw normalizeGetUserMediaError(err);
    });
  }

  function pickMimeType(requested) {
    if (requested && MediaRecorder.isTypeSupported(requested)) return requested;
    var supported = getSupportedCodecs();
    return supported.length ? supported[0].mimeType : '';
  }

  function makeError(code, message) {
    var err = new Error(message);
    err.code = code;
    return err;
  }

  /** 把 getUserMedia 异常归类为可读的权限/设备错误 */
  function normalizeGetUserMediaError(err) {
    switch (err && err.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return makeError('PERMISSION_DENIED', '麦克风权限被拒绝。请在浏览器地址栏的站点设置中允许麦克风后重试');
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return makeError('NO_DEVICE', '未检测到可用的麦克风设备');
      case 'NotReadableError':
      case 'TrackStartError':
        return makeError('DEVICE_BUSY', '麦克风被其他应用占用或硬件异常，请关闭占用程序后重试');
      case 'OverconstrainedError':
        return makeError('OVERCONSTRAINED', '所选设备或采样率不被支持');
      case 'AbortError':
        return makeError('ABORTED', '设备请求被中止，请重试');
      default:
        return makeError('UNKNOWN', '麦克风初始化失败：' + (err && err.message ? err.message : '未知错误'));
    }
  }

  function stopStream(stream) {
    stream.getTracks().forEach(function (t) { t.stop(); });
  }

  /**
   * 一次录音会话：封装 MediaRecorder 状态机。
   * 事件：onstatechange(state), onstop(blob)
   */
  function RecorderSession(recorder, stream, mimeType) {
    this.recorder = recorder;
    this.stream = stream;
    this.mimeType = mimeType;
    this.state = 'inactive';
    this._chunks = [];
    this.onstatechange = null;
    this.onstop = null;

    var self = this;
    recorder.ondataavailable = function (e) {
      if (e.data && e.data.size > 0) self._chunks.push(e.data);
    };
    recorder.onstop = function () {
      var blob = new Blob(self._chunks, { type: self.mimeType || 'audio/webm' });
      self._chunks = [];
      self._setState('inactive');
      if (self.onstop) self.onstop(blob);
    };
    recorder.onerror = function (e) {
      self._setState('inactive');
      if (self.onerror) self.onerror(e.error || new Error('录音过程中发生错误'));
    };
  }

  RecorderSession.prototype._setState = function (state) {
    this.state = state;
    if (this.onstatechange) this.onstatechange(state);
  };

  RecorderSession.prototype.start = function () {
    if (this.state !== 'inactive') return;
    this.recorder.start(250);
    this._setState('recording');
  };

  RecorderSession.prototype.pause = function () {
    if (this.state !== 'recording') return;
    this.recorder.pause();
    this._setState('paused');
  };

  RecorderSession.prototype.resume = function () {
    if (this.state !== 'paused') return;
    this.recorder.resume();
    this._setState('recording');
  };

  RecorderSession.prototype.stop = function () {
    if (this.state === 'inactive') return;
    this.recorder.stop();
  };

  /** 释放麦克风（会话结束后必须调用） */
  RecorderSession.prototype.release = function () {
    try {
      if (this.recorder.state !== 'inactive') this.recorder.stop();
    } catch (e) { /* 忽略 */ }
    stopStream(this.stream);
  };

  /** 导出 Blob 为文件下载；失败时抛错以便调用方重试 */
  function exportBlob(blob, filename) {
    return new Promise(function (resolve, reject) {
      try {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); resolve(); }, 1000);
      } catch (e) {
        reject(makeError('EXPORT_FAILED', '导出失败：' + (e.message || '未知错误')));
      }
    });
  }

  global.MicRecorder = {
    CODEC_CANDIDATES: CODEC_CANDIDATES,
    isSecure: isSecure,
    isMediaSupported: isMediaSupported,
    queryPermission: queryPermission,
    watchPermission: watchPermission,
    getSupportedCodecs: getSupportedCodecs,
    listAudioDevices: listAudioDevices,
    createSession: createSession,
    exportBlob: exportBlob
  };
})(window);
