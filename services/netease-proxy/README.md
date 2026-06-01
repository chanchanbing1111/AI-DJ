# netease-proxy

Private proxy for AI-DJ to call your own Netease Cloud Music account.

## Environment

```env
PROXY_TOKEN=your-long-random-token
NETEASE_COOKIE=MUSIC_U=...; __csrf=...;
PORT=3000
```

Never commit `NETEASE_COOKIE` or `PROXY_TOKEN`.

## Local Run

```bash
npm install
npm start
```

Health check:

```bash
curl http://localhost:3000/health
```

Authorized call:

```bash
curl -H "Authorization: Bearer your-long-random-token" "http://localhost:3000/netease/search?q=晴天"
```

## Railway

Deploy this folder as a Railway service, then add `PROXY_TOKEN` and `NETEASE_COOKIE` in Railway Variables.

When deploying from the main `AI-DJ` repository, set Railway's root directory to:

```text
services/netease-proxy
```

After deployment, copy the public Railway domain, for example:

```text
https://netease-proxy-production.up.railway.app
```

Use that as AI-DJ's `NETEASE_API_BASE`.
