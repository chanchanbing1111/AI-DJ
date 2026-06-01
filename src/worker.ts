import { generateJson } from "./llm";
import { computeAgentReply } from "./agent";
import {
  getNeteaseLyric,
  getNeteaseMe,
  getNeteasePlaylistTracks,
  getNeteaseRecommendedSongs,
  getNeteaseSimilarSongs,
  getNeteaseUrl,
  getNeteaseUserPlaylists,
  resolveNeteaseTracks,
  searchNetease
} from "./netease";
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
    return json(await computeReply(env, "Plan a song for the current time."));
  }

  if (request.method === "POST" && url.pathname === "/api/chat") {
    const body = (await request.json()) as { message?: string; context?: MoodContext };
    const profile = await getProfile(env);
    const reply = await computeAgentReply(env, {
      message: body.message ?? "What should I listen to now?",
      context: body.context ?? {},
      profile,
      current: await getNow(env)
    });
    await saveNow(env, reply);
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

  if (request.method === "GET" && url.pathname === "/api/netease/search") {
    return json(await searchNetease(env, url.searchParams.get("q") ?? ""));
  }

  if (request.method === "GET" && url.pathname === "/api/netease/me") {
    return json(await getNeteaseMe(env));
  }

  if (request.method === "GET" && url.pathname === "/api/netease/playlists") {
    return json(await getNeteaseUserPlaylists(env));
  }

  if (request.method === "GET" && url.pathname === "/api/netease/playlist") {
    return json({ tracks: await getNeteasePlaylistTracks(env, url.searchParams.get("id") ?? "") });
  }

  if (request.method === "POST" && url.pathname === "/api/netease/resolve") {
    const body = (await request.json()) as { tracks?: Array<Partial<Track> & { name?: string }> };
    return json({ tracks: await resolveNeteaseTracks(env, body.tracks ?? []) });
  }

  if (request.method === "GET" && url.pathname === "/api/netease/url") {
    return json(await getNeteaseUrl(env, url.searchParams.get("id") ?? ""));
  }

  if (request.method === "GET" && url.pathname === "/api/netease/lyric") {
    return json(await getNeteaseLyric(env, url.searchParams.get("id") ?? ""));
  }

  if (request.method === "GET" && url.pathname === "/api/netease/similar") {
    return json({ tracks: await getNeteaseSimilarSongs(env, url.searchParams.get("id") ?? "") });
  }

  if (request.method === "GET" && url.pathname === "/api/netease/recommend/songs") {
    return json({ tracks: await getNeteaseRecommendedSongs(env) });
  }

  return json({ error: "Not found" }, 404);
}

async function computeReply(env: Env, message: string, context: MoodContext = {}): Promise<DjReply> {
  const profile = await getProfile(env);
  const routine = pickRoutine(profile);
  const inferredContext = { mood: inferMood(message), note: message, ...context };
  const track = chooseTrack(profile, routine, hash(message), inferredContext);
  const fallback = fallbackDjReply(profile, routine, track, inferredContext);

  const prompt = [
    `You are private music DJ ${env.DJ_NAME}. Return strict JSON only.`,
    "Required fields: say, reason, segue. No markdown.",
    `User profile: ${JSON.stringify({ name: profile.name, language: profile.language, favoriteMoods: profile.favoriteMoods })}`,
    `Routine: ${JSON.stringify(routine)}`,
    `Weather and mood: ${JSON.stringify(inferredContext)}`,
    `Candidate track: ${track ? JSON.stringify(track) : "none"}`,
    `User message: ${message}`,
    "Style: warm radio DJ, concise, Chinese preferred when user writes Chinese, under 100 Chinese characters."
  ].join("\n");

  try {
    const text = await generateJson(env, [
      { role: "system", content: "You are a concise private radio DJ. Return JSON only." },
      { role: "user", content: prompt }
    ]);
    if (!text) throw new Error("No LLM provider configured.");
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
  if (/tired|anxious|sad|rain|calm|relax|\u7d2f|\u56f0|\u70e6|\u4f4e\u843d|\u7126\u8651|\u96e8|\u677e\u5f1b/.test(message)) return "\u677e\u5f1b";
  if (/work|focus|code|study|\u5de5\u4f5c|\u4e13\u6ce8|\u4ee3\u7801|\u5b66\u4e60|\u5185\u5bb9/.test(message)) return "\u4e13\u6ce8";
  if (/morning|awake|commute|sport|\u9192|\u901a\u52e4|\u65e9|\u7cbe\u795e|\u8fd0\u52a8/.test(message)) return "\u6e05\u9192";
  if (/night|romantic|vibe|\u591c|\u6d6a\u6f2b|\u665a\u4e0a|\u6c1b\u56f4/.test(message)) return "\u591c\u665a";
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
