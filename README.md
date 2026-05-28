# AI DJ

私人 AI DJ 电台，部署在 Cloudflare Workers。当前版本包含：

- 黑底点阵风格 PWA 前端
- Cloudflare Workers API
- D1 保存口味资料、播放状态和播放记录
- 天气 + 心情 + 时段选歌
- DJ 播报卡片，音乐铺底时自动压低音量
- Workers AI fallback
- OpenAI-compatible 大模型适配
- NeteaseCloudMusicApi-compatible 网易云适配

线上地址：

```text
https://ai-dj.chanchanbing1111.workers.dev
```

## 本地开发

```bash
npm install
npm run db:migrate:local
npm run dev:local
```

## Cloudflare 部署

```bash
npm run db:migrate
npm run deploy
```

## 歌单格式

第一版可以直接导入最简单的结构：

```json
[
  {
    "name": "The Apl Song",
    "artist": "Black Eyed Peas"
  },
  {
    "name": "BIRDS OF A FEATHER",
    "artist": "Billie Eilish"
  }
]
```

双击页面左上角 `Claudio` 打开 Taste File，把 JSON 粘进去。点 `解析网易云` 会调用：

```text
POST /api/netease/resolve
```

它会用 `name + artist` 搜索网易云，补齐：

- `source`
- `sourceId`
- `cover`
- `externalUrl`

注意：网易云音频能不能站内播放，取决于版权、登录态、地区、会员和 API 返回结果。当前策略是：先解析元数据，能拿到播放 URL 就播放，拿不到就保留为 metadata-only。

## 网易云 API

本项目按 NeteaseCloudMusicApi 兼容服务调用。你需要先部署或准备一个网易云 API 服务，然后设置：

```bash
npx wrangler secret put NETEASE_COOKIE
```

并在 `wrangler.jsonc` 里配置：

```jsonc
"NETEASE_API_BASE": "https://你的-netease-api.example.com"
```

已提供接口：

```text
GET  /api/netease/search?q=关键词
POST /api/netease/resolve
GET  /api/netease/url?id=网易云歌曲ID
GET  /api/netease/lyric?id=网易云歌曲ID
```

`NETEASE_COOKIE` 可选，但很多歌曲 URL 和会员/私人歌单能力需要登录 Cookie。

## 大模型 API

默认会使用 Cloudflare Workers AI。若配置了 `LLM_API_KEY`，会优先走 OpenAI-compatible Chat Completions：

```bash
npx wrangler secret put LLM_API_KEY
```

`wrangler.jsonc` 中可改：

```jsonc
"LLM_BASE_URL": "https://api.openai.com/v1",
"LLM_MODEL": "gpt-4o-mini"
```

也可以换成 DeepSeek、通义、火山等兼容 OpenAI `/chat/completions` 的服务：

```jsonc
"LLM_BASE_URL": "https://api.deepseek.com/v1",
"LLM_MODEL": "deepseek-chat"
```

## 语音合成

当前 `/api/tts` 使用 Cloudflare Workers AI：

```jsonc
"TTS_MODEL": "@cf/deepgram/aura-1"
```

本地 `dev:local` 没有远端 TTS 时，前端会自动退回浏览器内置语音。
