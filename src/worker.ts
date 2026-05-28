import { chooseTrack, fallbackDjReply, pickRoutine } from "./persona";
import { getNow, getProfile, saveNow, saveProfile } from "./state";
import type { DjReply, Env, MoodContext, TasteProfile, Track } from "./types";

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        return await routeApi(request, env, url);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Unknown error" }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(_: ScheduledController, env: Env): Promise<void> {
    const profile = await getProfile(env);
    const routine = pickRoutine(profile);
    const track = chooseTrack(profile, routine);
    await saveNow(env, fallbackDjReply(profile, routine, track));
  }
};

async function routeApi(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/api/taste") {
    return json(await getProfile(env));
  }

  if (request.method === "PUT" && url.pathname === "/api/taste") {
    const profile = normalizeProfile(await request.json());
    await saveProfile(env, profile);
    return json(profile);
  }

  if (request.method === "GET" && url.pathname === "/api/now") {
    const now = await getNow(env);
    if (now) return json(now);
    return json(await computeReply(env, "按现在的时间安排一首歌"));
  }

  if (request.method === "POST" && url.pathname === "/api/chat") {
    const body = (await request.json()) as { message?: string; context?: MoodContext };
    const reply = await computeReply(env, body.message ?? "现在适合听什么", body.context ?? {});
    return json(reply);
  }

  if (request.method === "POST" && url.pathname === "/api/play") {
    const body = (await request.json()) as { track: Track; reason?: string };
    await recordPlay(env, body.track, body.reason);
    return json({ ok: true });
  }

  if (request.method === "GET" && url.pathname === "/api/plan/today") {
    const profile = await getProfile(env);
    const context = contextFromUrl(url);
    return json(profile.routines.map((routine, index) => ({ ...routine, track: chooseTrack(profile, routine, index, context) })));
  }

  if (request.method === "GET" && url.pathname === "/api/tts") {
    return speak(env, url.searchParams.get("text") ?? "");
  }

  return json({ error: "Not found" }, 404);
}

async function computeReply(env: Env, message: string, context: MoodContext = {}): Promise<DjReply> {
  const profile = await getProfile(env);
  const routine = pickRoutine(profile);
  const inferredContext = { mood: inferMood(message), note: message, ...context };
  const track = chooseTrack(profile, routine, hash(message), inferredContext);
  const fallback = fallbackDjReply(profile, routine, track, inferredContext);

  if (!env.AI) {
    await saveNow(env, fallback);
    return fallback;
  }

  const prompt = [
    `你是私人音乐 DJ ${env.DJ_NAME}，输出严格 JSON。`,
    "字段必须是 say, reason, segue。不要输出 markdown。",
    `用户资料: ${JSON.stringify({ name: profile.name, language: profile.language, favoriteMoods: profile.favoriteMoods })}`,
    `当前时段: ${JSON.stringify(routine)}`,
    `天气和心情: ${JSON.stringify(inferredContext)}`,
    `候选歌曲: ${track ? JSON.stringify(track) : "无"}`,
    `用户输入: ${message}`,
    "风格: 亲近、简短、像电台 DJ，不超过 80 个中文字符。"
  ].join("\n");

  try {
    const aiResult = await env.AI.run(env.AI_MODEL, {
      messages: [
        { role: "system", content: "You are a concise private radio DJ. Return JSON only." },
        { role: "user", content: prompt }
      ]
    });
    const text = String((aiResult as { response?: string }).response ?? "");
    const parsed = JSON.parse(text.replace(/^```json|```$/g, "").trim()) as Partial<DjReply>;
    const reply = { ...fallback, ...parsed, play: track, context: inferredContext };
    await saveNow(env, reply);
    return reply;
  } catch {
    await saveNow(env, fallback);
    return fallback;
  }
}

async function speak(env: Env, text: string): Promise<Response> {
  if (!text.trim()) return new Response("Missing text", { status: 400 });

  if (!env.AI) {
    return json({ error: "Workers AI binding is not available in local fallback mode." }, 501);
  }

  const response = (await env.AI.run(env.TTS_MODEL, { text }, { returnRawResponse: true })) as unknown as Response;
  const headers = new Headers(response.headers);
  headers.set("cache-control", "public, max-age=86400");
  return new Response(response.body, { status: response.status, headers });
}

async function recordPlay(env: Env, track: Track, reason = ""): Promise<void> {
  await env.DB.prepare("INSERT INTO play_events (track_id, title, artist, mood, source) VALUES (?, ?, ?, ?, ?)")
    .bind(track.id, track.title, track.artist, reason, track.source ?? "manual")
    .run();
}

function normalizeProfile(input: unknown): TasteProfile {
  const profile = input as TasteProfile;
  if (!profile.name || !Array.isArray(profile.playlists) || !Array.isArray(profile.routines)) {
    throw new Error("Invalid taste profile");
  }
  return {
    ...profile,
    playlists: profile.playlists.map((track, index) => normalizeTrack(track, index))
  };
}

function normalizeTrack(input: unknown, index: number): Track {
  const raw = input as Partial<Track> & { name?: string };
  const title = String(raw.title ?? raw.name ?? "").trim();
  const artist = String(raw.artist ?? "").trim();

  if (!title || !artist) {
    throw new Error(`Invalid track at index ${index}. Expected { "name": "...", "artist": "..." } or full Track.`);
  }

  const id = raw.id ?? `${raw.source ?? "manual"}-${hash(`${title}:${artist}`)}`;
  const url = raw.url?.trim() || undefined;

  return {
    id,
    title,
    name: raw.name ?? title,
    artist,
    album: raw.album,
    url,
    cover: raw.cover,
    mood: raw.mood,
    energy: raw.energy,
    source: raw.source ?? "manual",
    sourceId: raw.sourceId,
    externalUrl: raw.externalUrl,
    playable: Boolean(url),
    cached: Boolean(url)
  };
}

function contextFromUrl(url: URL): MoodContext {
  return {
    mood: url.searchParams.get("mood") ?? undefined,
    weather: {
      city: url.searchParams.get("city") ?? undefined,
      condition: url.searchParams.get("condition") ?? undefined,
      temperature: numberParam(url, "temperature"),
      wind: numberParam(url, "wind"),
      code: numberParam(url, "code")
    }
  };
}

function inferMood(message: string): string | undefined {
  if (/累|困|烦|emo|低落|焦虑|难受/.test(message)) return "松弛";
  if (/工作|专注|写|代码|学习|内容/.test(message)) return "专注";
  if (/醒|通勤|早|精神|运动/.test(message)) return "清醒";
  if (/浪漫|晚上|氛围|微醺/.test(message)) return "夜晚";
  return undefined;
}

function numberParam(url: URL, key: string): number | undefined {
  const value = url.searchParams.get(key);
  return value ? Number(value) : undefined;
}

function hash(value: string): number {
  return [...value].reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) | 0, 7);
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: jsonHeaders });
}
