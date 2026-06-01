import express from "express";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const netease = require("NeteaseCloudMusicApi");

const app = express();
const port = Number(process.env.PORT ?? 3000);
const proxyToken = process.env.PROXY_TOKEN;
const neteaseCookie = process.env.NETEASE_COOKIE ?? "";

app.use(express.json({ limit: "1mb" }));

app.get("/health", (_request, response) => {
  response.json({ ok: true, service: "netease-proxy" });
});

app.use("/netease", requireAuth);

app.get("/netease/me", asyncRoute(async () => callNetease("user_account")));
app.get("/netease/search", asyncRoute(async (request) => callNetease("search", {
  keywords: String(request.query.q ?? request.query.keywords ?? ""),
  limit: Number(request.query.limit ?? 8)
})));
app.get("/netease/playlists", asyncRoute(async () => {
  const account = await callNetease("user_account");
  const uid = account.body?.profile?.userId ?? account.profile?.userId;
  if (!uid) throw httpError(401, "Could not read Netease userId from cookie.");
  return callNetease("user_playlist", { uid, limit: 1000 });
}));
app.get("/netease/playlist", asyncRoute(async (request) => callNetease("playlist_detail", {
  id: String(request.query.id ?? "")
})));
app.get("/netease/url", asyncRoute(async (request) => callNetease("song_url_v1", {
  id: String(request.query.id ?? ""),
  level: String(request.query.level ?? "standard")
})));
app.get("/netease/lyric", asyncRoute(async (request) => callNetease("lyric", {
  id: String(request.query.id ?? "")
})));
app.get("/netease/simi", asyncRoute(async (request) => callNetease("simi_song", {
  id: String(request.query.id ?? "")
})));
app.get("/netease/recommend/songs", asyncRoute(async () => callNetease("recommend_songs", {})));

app.use((error, _request, response, _next) => {
  const status = error.statusCode ?? 500;
  response.status(status).json({
    error: error.message ?? "Internal server error"
  });
});

app.listen(port, () => {
  console.log(`netease-proxy listening on :${port}`);
});

async function callNetease(methodName, params = {}) {
  const method = netease[methodName];
  if (typeof method !== "function") {
    throw httpError(500, `Netease method not found: ${methodName}`);
  }

  const result = await method({
    ...params,
    cookie: neteaseCookie
  });

  return result.body ?? result;
}

function requireAuth(request, response, next) {
  if (!proxyToken) {
    response.status(500).json({ error: "PROXY_TOKEN is not configured." });
    return;
  }

  const header = request.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (token !== proxyToken) {
    response.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}

function asyncRoute(handler) {
  return async (request, response, next) => {
    try {
      response.json(await handler(request, response));
    } catch (error) {
      next(error);
    }
  };
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
