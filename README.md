# AI DJ

私人 AI DJ 电台，部署在 Cloudflare Workers。

线上主站：

```text
https://ai-dj.chanchanbing1111.workers.dev
```

GitHub：

```text
https://github.com/chanchanbing1111/AI-DJ
```

## 当前架构

```text
Browser
  -> Cloudflare Worker / PWA
  -> D1
  -> Workers AI or OpenAI-compatible LLM
  -> netease-proxy on Railway
  -> NeteaseCloudMusicApi
  -> Your Netease account cookie
```

## 本地开发

```bash
npm install
npm run db:migrate:local
npm run dev:local
```

## 部署主站

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

双击页面左上角 `Claudio` 打开 Taste File，把 JSON 粘进去。点 `解析网易云` 会调用后端去补网易云元数据。

## 网易云线上接入

仓库里已经包含一个私有网易云 proxy：

```text
services/netease-proxy
```

它负责：

- 保存你的 `NETEASE_COOKIE`
- 调用 NeteaseCloudMusicApi npm 包
- 给 AI-DJ 提供搜索、歌单、歌词、播放 URL 接口
- 用 `PROXY_TOKEN` 防止别人调用你的网易云账号接口

### Railway 部署步骤

1. 打开 Railway。
2. New Project。
3. Deploy from GitHub repo。
4. 选择 `chanchanbing1111/AI-DJ`。
5. Root Directory 填：

```text
services/netease-proxy
```

6. 在 Railway Variables 添加：

```env
PROXY_TOKEN=一串很长的随机密码
NETEASE_COOKIE=你的网易云 Cookie
```

7. 部署成功后复制 Railway 生成的公网地址，例如：

```text
https://netease-proxy-production.up.railway.app
```

### 配置 Cloudflare 主站调用 proxy

在 Cloudflare AI-DJ 项目中设置：

```bash
npx wrangler secret put NETEASE_PROXY_TOKEN
```

这里输入的值必须和 Railway 里的 `PROXY_TOKEN` 完全一样。

然后把 `wrangler.jsonc` 里的 `NETEASE_API_BASE` 改成 Railway 地址：

```jsonc
"NETEASE_API_BASE": "https://netease-proxy-production.up.railway.app"
```

再部署：

```bash
npm run deploy
```

## 网易云 Cookie

不要把 Cookie 发到聊天里，也不要提交到 GitHub。

获取方式：

1. 浏览器打开 `https://music.163.com`。
2. 登录网易云账号。
3. 按 `F12`。
4. 打开 `Application` / `应用`。
5. 找到 `Cookies` -> `https://music.163.com`。
6. 复制包含 `MUSIC_U=...` 的 Cookie。
7. 粘贴到 Railway 的 `NETEASE_COOKIE` 变量中。

## 已提供的网易云接口

AI-DJ 主站接口：

```text
GET  /api/netease/me
GET  /api/netease/playlists
GET  /api/netease/playlist?id=歌单ID
GET  /api/netease/search?q=关键词
POST /api/netease/resolve
GET  /api/netease/url?id=歌曲ID
GET  /api/netease/lyric?id=歌曲ID
```

netease-proxy 内部接口：

```text
GET /health
GET /netease/me
GET /netease/search?q=关键词
GET /netease/playlists
GET /netease/playlist?id=歌单ID
GET /netease/url?id=歌曲ID
GET /netease/lyric?id=歌曲ID
```

除了 `/health`，其他 proxy 接口都需要：

```http
Authorization: Bearer PROXY_TOKEN
```

## 大模型 API

默认使用 Cloudflare Workers AI。如果配置了 `LLM_API_KEY`，会优先走 OpenAI-compatible Chat Completions：

```bash
npx wrangler secret put LLM_API_KEY
```

`wrangler.jsonc` 中可配置：

```jsonc
"LLM_BASE_URL": "https://api.openai.com/v1",
"LLM_MODEL": "gpt-4o-mini"
```

也可以换成 DeepSeek 等兼容 OpenAI `/chat/completions` 的服务。

## 语音合成

当前 `/api/tts` 使用 Cloudflare Workers AI：

```jsonc
"TTS_MODEL": "@cf/deepgram/aura-1"
```

本地 `dev:local` 没有远端 TTS 时，前端会自动退回浏览器内置语音。
