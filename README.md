# Komga Light Translator

一个轻量的 Microsoft Edge / Chrome Manifest V3 漫画实时翻译扩展，优先适配 Komga。

当前版本使用**单个多模态模型接口**：模型直接看漫画图片，同时完成文字识别、翻译、文字区域定位，并返回上下文更新。扩展本身负责翻页检测、上下文记忆、缓存和译文覆盖。

## 功能

- 只在你主动启用的 Komga 站点加载
- 当前可见漫画页自动翻译，兼容单页 / 双页
- 单多模态 API，不再需要独立 OCR 服务
- 支持两种接口模式：
  - 通用 JSON HTTP 接口
  - OpenAI-compatible `/v1/chat/completions`
- 最近 N 页完整对白上下文
- 持久化滚动剧情摘要
- 持久化人物、人名/术语、角色说话风格记忆
- 翻译结果本地缓存
- 译文按模型返回坐标覆盖漫画
- 可选同时显示原文
- API URL / Model / Headers 均由用户配置
- 无 npm、无构建步骤、无第三方 JS 依赖

## 安装

1. Clone 或下载本仓库。
2. Edge 打开 `edge://extensions/`。
3. 开启“开发人员模式”。
4. 点击“加载解压缩的扩展”。
5. 选择本仓库目录。
6. 打开 Komga。
7. 点击扩展图标 -> “启用此站点”。
8. 进入扩展设置，填写模型 URL / Headers / Model。
9. 刷新 Komga 阅读页。

第一次启用某个 Komga 地址、第一次保存某个模型 API 地址时，Edge 会请求对应站点访问权限。

## 上下文策略

扩展不会把前面几十页图片反复发送给模型，而是维护三层上下文：

1. **短期上下文**：最近几页的原文、译文和页面摘要。
2. **滚动摘要**：模型每页返回一个新的精简剧情摘要，替代旧摘要。
3. **长期翻译记忆**：人物、人名/术语、角色说话风格。

请求大致为：

```json
{
  "image": { "dataBase64": "..." },
  "targetLanguage": "zh-CN",
  "context": {
    "rollingSummary": "主角已进入地下设施……",
    "recentPages": [
      {
        "pageNumber": 31,
        "source": "……",
        "translation": "……",
        "summary": "……"
      }
    ],
    "translationMemory": {
      "characters": { "累": "累" },
      "terms": { "奈落": "奈落" },
      "speakerStyles": {}
    }
  }
}
```

上下文保存在 `chrome.storage.local`，关闭浏览器后仍然存在。

## 通用 JSON 接口

### Request

`POST <API URL>`

```json
{
  "model": "optional-model-name",
  "targetLanguage": "zh-CN",
  "image": {
    "mimeType": "image/jpeg",
    "dataBase64": "...",
    "width": 1600,
    "height": 2400
  },
  "page": {
    "url": "https://komga.example/...",
    "sourceUrl": "https://komga.example/api/v1/books/.../pages/31",
    "bookId": "...",
    "pageNumber": 31,
    "width": 1600,
    "height": 2400
  },
  "context": {
    "rollingSummary": "...",
    "recentPages": [],
    "translationMemory": {
      "characters": {},
      "terms": {},
      "speakerStyles": {}
    }
  }
}
```

### Response

```json
{
  "blocks": [
    {
      "id": "b1",
      "source": "あいつは誰だ？",
      "translation": "那家伙是谁？",
      "x": 0.61,
      "y": 0.08,
      "width": 0.22,
      "height": 0.10
    }
  ],
  "pageSummary": "两人在讨论一个身份不明的人。",
  "contextUpdate": {
    "rollingSummary": "主角来到设施后，两人开始讨论身份不明的人。",
    "characters": {},
    "terms": {},
    "speakerStyles": {}
  }
}
```

`x / y / width / height` 必须是相对于整张图片的 `0~1` 归一化坐标。

## OpenAI-compatible 模式

如果设置中选择 `OpenAI-compatible Chat Completions`，扩展会直接构造多模态 `messages` 请求，把当前图片作为 `data:image/...;base64,...` 发送，并要求模型返回上面的 JSON 结构。

常见接口形态：

```text
POST http://127.0.0.1:8000/v1/chat/completions
```

Headers 示例：

```json
{
  "Authorization": "Bearer YOUR_KEY"
}
```

具体模型必须支持图片输入，并能较稳定地返回文字区域坐标。

## Komga 页面识别

如果漫画图片 URL 包含 Komga 标准页接口：

```text
/api/v1/books/{bookId}/pages/{pageNumber}
```

扩展会自动提取 `bookId` 和 `pageNumber`，用来将上下文绑定到当前 Book，并优先选择当前页之前的页面作为短期上下文。

无法识别标准 URL 时，会退化为按当前阅读路径保存上下文。

## 隐私与缓存

- 漫画图片只发送到你配置的模型接口。
- 扩展不会把图片长期写入缓存。
- 本地只缓存译文、原文、坐标和上下文文本。
- 默认最多保留约 120 页翻译结果、每个上下文范围最近 30 页文本记录。

## 当前限制

- 只做矩形文字覆盖，不做气泡原字擦除 / inpainting。
- 多模态模型需要自己返回可用坐标；某些模型在精确定位方面可能不稳定。
- Canvas / WebGL 特殊阅读器可能无法读取；Komga 常规图片阅读模式优先支持。
- 当前长期记忆以 Komga Book 为主要范围；跨 Book / Series 的统一人物词典后续可再扩展。

## 文件

- `manifest.json` — Manifest V3
- `background.js` — 站点注册、跨域模型请求
- `content.js/css` — 漫画检测、上下文、缓存、翻译队列、覆盖层
- `popup.*` — 对当前 Komga 地址启用 / 停用
- `options.*` — 模型与上下文设置
