/* 录音核心：权限、设备、MediaRecorder 封装（无框架） */
(function (global) {
  'use strict';

  // 常见编码格式候选，按优先级排列
  const MIME_CANDIDATES = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
    'audio/ogg',
    'audio/wav',
    'audio/mpeg',
  ];

  const EXT_MAP = {
    'audio/webm': 'webm',
    'audio/mp4': 'm4a',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'audio/mpeg': 'mp3',
  };

  /** 错误归类：把 DOMException 映射为可读原因 */
  function classifyError(err) {
    const name = (err && err.name) || '';
    switch (name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return { code: 'denied', message: '麦克风权限被拒绝。请在浏览器地址栏的站点设置中允许麦克风后重试。' };
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return { code: 'no-device', message: '未检测到可用的麦克风设备。请连接麦克风后重试。' };
      case 'NotReadableError':
      case 'TrackStartError':
        return { code: 'busy', message: '麦克风被其他应用占用或无法读取。请关闭占用麦克风的程序后重试。' };
      case 'OverconstrainedError':
        return { code: 'overconstrained', message: '当前设备不满足所选的采样率等约束，请调整设置后重试。' };
      case 'AbortError':
        return { code: 'abort', message: '设备请求被中止，请重试。' };
      default:
        return { code: 'unknown', message: '录音初始化失败：' + ((err && err.message) || '未知错误') };
    }
  }

  class AudioRecorderManager {
    constructor() {
      this.stream = null;
      this.recorder = null;
      this.chunks = [];
      this.state = 'idle'; // idle | recording | paused
      this.mimeType = '';
      this.deviceId = '';
      this.sampleRate = null;
      this.startedAt = 0;
      this.accumulatedMs = 0;
      this._timerId = null;
      this.onTick = null;       // (elapsedMs) => {}
      this.onStateChange = null; // (state) => {}
    }

    static isSecure() {
      return global.isSecureContext !== false;
    }

    static isSupported() {
      return !!(
        global.isSecureContext !== false &&
        navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === 'function' &&
        typeof global.MediaRecorder === 'function'
      );
    }

    /** 查询权限状态：granted | denied | prompt | unknown */
    async queryPermission() {
      if (!navigator.permissions || typeof navigator.permissions.query !== 'function') {
        return 'unknown';
      }
      try {
        const status = await navigator.permissions.query({ name: 'microphone' });
        // 订阅变化，调用方可在 onPermissionChange 中处理
        if (this.onPermissionChange) {
          status.onchange = () => this.onPermissionChange(status.state);
        }
        return status.state;
      } catch (e) {
        return 'unknown'; // 某些浏览器不支持 microphone 权限查询
      }
    }

    /** 枚举音频输入设备 */
    async listDevices() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        return [];
      }
      const all = await navigator.mediaDevices.enumerateDevices();
      return all.filter((d) => d.kind === 'audioinput');
    }

    /** 返回受支持的编码格式列表（含"默认"选项） */
    static supportedMimeTypes() {
      if (typeof global.MediaRecorder !== 'function' ||
          typeof global.MediaRecorder.isTypeSupported !== 'function') {
        return [];
      }
      return MIME_CANDIDATES.filter((t) => {
        try { return global.MediaRecorder.isTypeSupported(t); } catch (e) { return false; }
      });
    }

    /** 从候选中挑选实际可用的格式；都不支持时返回空串（交给浏览器默认） */
    static resolveMimeType(preferred) {
      if (preferred && global.MediaRecorder.isTypeSupported(preferred)) {
        return { mimeType: preferred, fallback: false };
      }
      const list = AudioRecorderManager.supportedMimeTypes();
      if (list.length > 0) {
        return { mimeType: list[0], fallback: !!preferred };
      }
      return { mimeType: '', fallback: !!preferred }; // 空串 = 浏览器默认
    }

    /**
     * 申请权限并打开音频流。
     * 必须由用户手势触发调用；任何失败都抛出已归类的错误，不会导致未捕获异常。
     */
    async acquireStream({ deviceId, sampleRate } = {}) {
      if (!AudioRecorderManager.isSecure()) {
        throw Object.assign(new Error('insecure'), { name: 'InsecureContextError' });
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw Object.assign(new Error('unsupported'), { name: 'UnsupportedError' });
      }
      const constraints = {
        audio: {
          deviceId: deviceId ? { exact: deviceId } : undefined,
          sampleRate: sampleRate ? { ideal: sampleRate } : undefined,
        },
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      // 替换旧流
      this._stopStream();
      this.stream = stream;
      this.deviceId = deviceId || '';
      this.sampleRate = sampleRate || null;
      return stream;
    }

    /**
     * 切换输入设备；失败时回退到旧设备。
     * 返回 { ok, error? }，绝不抛出。
     */
    async switchDevice(deviceId, sampleRate) {
      const prev = { deviceId: this.deviceId, sampleRate: this.sampleRate };
      try {
        await this.acquireStream({ deviceId, sampleRate: sampleRate || this.sampleRate });
        return { ok: true };
      } catch (err) {
        // 回退到之前的设备
        try {
          await this.acquireStream(prev);
          return { ok: false, error: classifyError(err), rolledBack: true };
        } catch (err2) {
          return { ok: false, error: classifyError(err), rolledBack: false, rollbackError: classifyError(err2) };
        }
      }
    }

    /** 开始录音。需要先 acquireStream。 */
    start(mimeType) {
      if (!this.stream) throw new Error('尚未获取音频流');
      if (this.state !== 'idle') return;

      const resolved = AudioRecorderManager.resolveMimeType(mimeType);
      this.mimeType = resolved.mimeType;
      this.chunks = [];

      let recorder;
      try {
        recorder = resolved.mimeType
          ? new MediaRecorder(this.stream, { mimeType: resolved.mimeType })
          : new MediaRecorder(this.stream);
      } catch (err) {
        // 构造失败（极端情况：格式在构造时才被拒绝）→ 用浏览器默认配置重试
        recorder = new MediaRecorder(this.stream);
        this.mimeType = '';
        resolved.fallback = true;
      }
      this.recorder = recorder;
      if (!this.mimeType && recorder.mimeType) this.mimeType = recorder.mimeType;

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) this.chunks.push(e.data);
      };
      recorder.onerror = (e) => {
        if (this.onRecorderError) this.onRecorderError(e.error || new Error('录音过程出错'));
      };

      recorder.start(250); // 每 250ms 产生一个数据块，暂停时数据不丢失
      this._setState('recording');
      return { mimeType: this.mimeType, fallback: resolved.fallback };
    }

    pause() {
      if (this.recorder && this.state === 'recording') {
        this.recorder.pause();
        this._setState('paused');
      }
    }

    resume() {
      if (this.recorder && this.state === 'paused') {
        this.recorder.resume();
        this._setState('recording');
      }
    }

    /** 停止并返回录音结果 Promise<{ blob, mimeType, durationMs }> */
    stop() {
      return new Promise((resolve, reject) => {
        if (!this.recorder || this.state === 'idle') {
          reject(new Error('当前没有进行中的录音'));
          return;
        }
        const recorder = this.recorder;
        const durationMs = this._elapsedMs();
        recorder.onstop = () => {
          const type = this.mimeType || 'audio/webm';
          const blob = new Blob(this.chunks, { type });
          this._cleanup();
          resolve({ blob, mimeType: type, durationMs });
        };
        recorder.onerror = (e) => {
          this._cleanup();
          reject(e.error || new Error('停止录音失败'));
        };
        try {
          recorder.stop();
        } catch (err) {
          this._cleanup();
          reject(err);
        }
      });
    }

    /** 放弃当前录音（不产出结果） */
    cancel() {
      if (this.recorder && this.state !== 'idle') {
        this.recorder.onstop = null;
        try { this.recorder.stop(); } catch (e) { /* 忽略 */ }
      }
      this._cleanup();
    }

    release() {
      this.cancel();
      this._stopStream();
    }

    _stopStream() {
      if (this.stream) {
        this.stream.getTracks().forEach((t) => t.stop());
        this.stream = null;
      }
    }

    _setState(state) {
      this.state = state;
      if (state === 'recording') {
        this.startedAt = Date.now();
        this._timerId = setInterval(() => {
          if (this.onTick) this.onTick(this._elapsedMs());
        }, 100);
      } else {
        if (this._timerId) { clearInterval(this._timerId); this._timerId = null; }
        if (state === 'paused') {
          this.accumulatedMs += Date.now() - this.startedAt;
        } else if (state === 'idle') {
          this.accumulatedMs = 0;
        }
      }
      if (this.onStateChange) this.onStateChange(state);
    }

    _elapsedMs() {
      if (this.state === 'recording') {
        return this.accumulatedMs + (Date.now() - this.startedAt);
      }
      return this.accumulatedMs;
    }

    _cleanup() {
      if (this._timerId) { clearInterval(this._timerId); this._timerId = null; }
      this.recorder = null;
      this.chunks = [];
      this.accumulatedMs = 0;
      this.state = 'idle';
      if (this.onStateChange) this.onStateChange('idle');
    }

    static extensionFor(mimeType) {
      const base = (mimeType || '').split(';')[0].trim().toLowerCase();
      return EXT_MAP[base] || 'webm';
    }
  }

  AudioRecorderManager.MIME_CANDIDATES = MIME_CANDIDATES;
  AudioRecorderManager.classifyError = classifyError;
  global.AudioRecorderManager = AudioRecorderManager;
})(window);
