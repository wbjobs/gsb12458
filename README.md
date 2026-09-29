# 麦克风录音网页

纯原生实现（MediaDevices API + MediaRecorder + Permissions API + Blob + IndexedDB + DOM），无任何框架与构建步骤。

## 运行

```bash
# 需要通过 localhost 或 HTTPS 访问（安全上下文要求）
python3 -m http.server 8000
# 打开 http://localhost:8000
```

直接双击打开 `index.html`（file:// 协议）会触发非安全上下文降级，仅可使用文件上传。

## 功能

- 申请麦克风权限，展示权限状态（已授权 / 已拒绝 / 待申请），并监听权限变化
- 录音、暂停、继续、停止，实时显示录音时长
- 选择输入设备（可刷新）、采样率、编码格式（不支持的格式自动隐藏降级）
- 录音预览、导出音频文件（失败可重试）
- 历史录音存于 IndexedDB，可回放、下载、删除
- 权限被拒 / 无设备 / 非安全上下文 / 浏览器不支持时，降级为文件上传

## 异常处理

| 场景 | 处理 |
| --- | --- |
| 权限被拒（NotAllowedError） | 提示去站点设置开启，权限徽章变红 |
| 无设备（NotFoundError） | 提示并展示文件上传降级面板 |
| 设备被占用（NotReadableError） | 提示关闭占用程序后重试 |
| 非安全上下文 | 展示降级面板，仅允许上传 |
| 用户未交互 | 所有 getUserMedia 调用均绑定在点击事件内，页面加载不请求权限 |
| 设备切换失败 | 自动回退到原设备并提示 |
| 编码格式不支持 | 仅列出 isTypeSupported 通过的格式，并显示降级说明 |
| 导出失败 | 显示“重试”按钮 |

## 文件结构

- `index.html` — 页面结构
- `styles.css` — 样式
- `js/recorder.js` — 权限 / 设备 / MediaRecorder 封装
- `js/db.js` — IndexedDB 历史记录存储
- `js/app.js` — UI 装配与事件绑定
