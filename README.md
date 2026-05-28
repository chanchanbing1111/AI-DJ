# AI DJ 私人电台

一个部署在 Cloudflare Workers 上的私人音乐 DJ 电台雏形。它把“用户口味资料 + 天气 + 今日心情 + 时段例程 + 私人歌单 + AI DJ 文案 + TTS 播报”组合成一个黑底点阵风格的 PWA 电台。

## 当前架构

- `public/`: 静态 PWA，包含点阵时钟、播放器控制条、DJ 聊天流、今日节目单和口味资料编辑。
- `src/worker.ts`: Cloudflare Worker API。
- `src/persona.ts`: 默认口味、时段规则和选曲 fallback。
- `src/state.ts`: D1 状态读写。
- `migrations/`: D1 数据库迁移。

Cloudflare 资源：

- Workers Static Assets: 托管前端。
- D1: 保存口味资料、当前播放、播放历史。
- Workers AI: 生成 DJ 串场文案和 TTS 音频。
- Cron Triggers: 在固定时段预生成当前节目。
- Browser Geolocation + Open-Meteo: 前端获取本地天气，并把天气状态传给 DJ API 参与选歌。

## 本地开发

```bash
npm install
npm run db:migrate:local
npm run dev
```

打开 Wrangler 输出的本地地址即可。

本地纯预览，不连接远端 Workers AI：

```bash
npm run dev:local
```

`dev:local` 会使用后端 fallback DJ 文案；部署后或登录 Cloudflare 后，Workers AI 才会生成更自然的串场和 TTS。

## 部署到 Cloudflare

1. 登录 Cloudflare：

```bash
npx wrangler login
```

2. 创建 D1 数据库：

```bash
npx wrangler d1 create ai_dj_db
```

把输出里的 `database_id` 填进 `wrangler.jsonc`。

3. 应用远端迁移：

```bash
npm run db:migrate
```

4. 发布：

```bash
npm run deploy
```

## 歌单格式

双击左上角 `Claudio` 可以打开口味资料。`url` 需要是浏览器可播放的音频直链，后续可以替换成 R2 私有曲库签名 URL、网易云解析服务或你自己的音乐 API。

第一版可以先用最简单的结构化歌单，只写歌名和歌手：

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

这种歌单可以参与天气、心情和时段编排，也能生成 DJ 播报。因为没有 `url`，它暂时不会在站内播放音乐；后续接网易云 API 后，可以用 `name + artist` 去搜索并解析 `sourceId`、封面、歌词和尝试获取播放地址。

如果已经有可播放音频地址，可以用完整结构：

```json
[
  {
    "id": "song-001",
    "title": "Song Name",
    "artist": "Artist",
    "url": "https://example.com/song.mp3",
    "cover": "https://example.com/cover.jpg",
    "mood": ["清醒", "专注", "雨天"],
    "energy": 6,
    "source": "private"
  }
]
```

## DJ 播报

点击播放时，音乐会先起一个短前奏，然后 Claudio 贴着音乐做介绍，并在播报卡片里显示 Speaking 状态、波形和逐句文稿。播报时音乐会自动压低，结束后淡回正常音量；如果音乐已经在播放，再点播报按钮会做一次同样的电台串场。

本地 `dev:local` 模式没有远端 Workers AI TTS，会自动退回浏览器内置语音。部署到 Cloudflare 并启用 Workers AI 后，会优先使用 `/api/tts` 返回的语音音频。

## 下一步建议

1. 把音频上传到 Cloudflare R2，并为 `/api/music/:id` 增加签名播放地址。
2. 加 Durable Object + WebSocket，让多设备同步当前播放状态。
3. 接入真实音乐搜索提供商，只保存元数据和你有权播放的音频地址。
4. 加每天/每周的偏好总结，让 DJ 学会跳过你常切掉的歌。
5. 把天气、心情和跳过记录写回 D1，形成每天自动变化的私人节目单。
