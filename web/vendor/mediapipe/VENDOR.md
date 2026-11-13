# 第三方檔案：MediaPipe Tasks Vision

跟隨模式用的人體姿勢偵測。全部放在本機，執行時不連網路。

| 檔案 | 來源 | 授權 |
|---|---|---|
| `vision_bundle.mjs`、`wasm/vision_wasm_internal.{js,wasm}` | npm `@mediapipe/tasks-vision@1.1.1`（只保留 SIMD 版 wasm；Chrome／Edge 都支援） | Apache-2.0 |
| `models/pose_landmarker_lite.task` | `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task` | Apache-2.0 |

`vision_bundle.mjs` 只刪掉最後一行 `sourceMappingURL`（沒有附 .map，避免 404），其餘未修改。

更新方式（有網路時）：

```bash
npm pack @mediapipe/tasks-vision@<版本>
```

解開後把 `package/vision_bundle.mjs` 與 `package/wasm/vision_wasm_internal.*` 複製到這裡。
