# 网页录音机

纯原生 HTML/CSS/JS 实现的麦克风录音应用，无任何框架与构建步骤。

## 运行

麦克风 API 仅在安全上下文（HTTPS 或 `localhost`）可用，请通过本地服务器访问：

```bash
cd 本目录
python3 -m http.server 8000
# 打开 http://localhost:8000
```

直接双击 `index.html`（file:// 协议）会触发"非安全上下文"降级提示，这是预期行为。

## 功能

- 申请麦克风权限，Permissions API 实时展示权限状态（已授权 / 已拒绝 / 待询问）
- 录制 / 暂停 / 继续 / 停止，实时显示录音时长
- 选择输入设备（热插拔自动刷新）、采样率、编码格式
- 录音预览、导出音频文件、IndexedDB 历史记录（播放 / 下载 / 删除）
- 权限被拒、无设备、非安全上下文、浏览器不支持时降级为文件上传

## 异常处理

| 场景 | 行为 |
| --- | --- |
| 权限被拒（NotAllowedError） | 提示引导用户到站点设置开启，并降级到文件上传 |
| 无设备（NotFoundError） | 提示连接麦克风，设备列表可刷新 |
| 设备被占用（NotReadableError） | 提示关闭占用程序后重试 |
| 非安全上下文 | 顶部横幅说明 + 降级到文件上传 |
| 用户未交互 | 所有 getUserMedia 调用均绑定在按钮点击内，不会自动触发 |
| 设备切换失败 | 自动回退到之前的设备，并同步 UI |
| 编码格式不支持 | MediaRecorder.isTypeSupported 探测，自动降级到可用格式 |
| 导出失败 | 保留数据，按钮变为"重试导出" |

## 文件结构

- `index.html` — 页面结构
- `css/style.css` — 样式
- `js/recorder.js` — 录音核心（权限、设备、MediaRecorder 封装、错误归类）
- `js/db.js` — IndexedDB 历史记录存储
- `js/app.js` — UI  wiring 与降级逻辑
