import { generateJson, probeLlm } from "./llm";
import { computeAgentReply, debugDjIntroForTrack, writeDjIntroForTrack } from "./agent";
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
import { researchSong } from "./search";
import { getChatHistory, getNow, getProfile, getUserMemory, recordChatMessage, recordPlaybackEvent, saveNow, saveProfile, saveVoiceSetting } from "./state";
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

  if (request.method === "GET" && url.pathname === "/api/debug") {
    const trackId = url.searchParams.get("trackId") ?? "";
    const netease = trackId ? await safeNeteaseUrl(env, trackId) : null;
    return json({
      llm: await probeLlm(env),
      netease,
      config: {
        neteaseApiBase: Boolean(env.NETEASE_API_BASE),
        neteaseProxyToken: Boolean(env.NETEASE_PROXY_TOKEN),
        neteaseCookie: Boolean(env.NETEASE_COOKIE),
        ttsModel: env.TTS_MODEL,
        llmBaseUrl: env.LLM_BASE_URL,
        llmModel: env.LLM_MODEL,
        exaSearch: Boolean(env.EXA_API_KEY),
        tavilySearch: Boolean(env.TAVILY_API_KEY)
      }
    });
  }

  if (request.method === "GET" && url.pathname === "/api/research") {
    const title = url.searchParams.get("title") ?? "";
    const artist = url.searchParams.get("artist") ?? "";
    const sourceId = url.searchParams.get("sourceId") ?? undefined;
    return json(await researchSong(env, {
      id: sourceId ? `netease-${sourceId}` : `${title}-${artist}`,
      title,
      artist,
      source: sourceId ? "netease" : undefined,
      sourceId
    }));
  }

  if (request.method === "GET" && url.pathname === "/api/memory") {
    return json(await getUserMemory(env));
  }

  if (request.method === "GET" && url.pathname === "/api/chat/history") {
    return json({ messages: await getChatHistory(env, Number(url.searchParams.get("limit") ?? "50")) });
  }

  if (request.method === "POST" && url.pathname === "/api/memory/voice") {
    const body = (await request.json()) as { voiceId?: string; speed?: number; pitch?: number };
    if (body.voiceId) await saveVoiceSetting(env, "voiceId", body.voiceId);
    if (body.speed !== undefined) await saveVoiceSetting(env, "speed", String(body.speed));
    if (body.pitch !== undefined) await saveVoiceSetting(env, "pitch", String(body.pitch));
    return json(await getUserMemory(env));
  }

  if (request.method === "POST" && url.pathname === "/api/chat") {
    const body = (await request.json()) as { message?: string; context?: MoodContext; current?: DjReply | null; currentLyricContext?: string };
    const message = body.message ?? "What should I listen to now?";
    const profile = await getProfile(env);
    const memory = await getUserMemory(env);
    const hasClientCurrent = Object.prototype.hasOwnProperty.call(body, "current");
    await recordChatMessage(env, {
      role: "user",
      content: message,
      kind: "chat",
      track: body.current?.play ?? null,
      metadata: { context: body.context ?? {}, currentLyricContext: body.currentLyricContext ?? "" }
    });
    const reply = await computeAgentReply(env, {
      message,
      context: body.context ?? {},
      profile,
      current: hasClientCurrent ? body.current ?? null : await getNow(env),
      currentLyricContext: body.currentLyricContext,
      memory
    });
    await recordChatMessage(env, {
      role: "assistant",
      content: reply.say,
      kind: reply.intent === "chat" ? "chat" : "dj_reply",
      track: reply.play,
      metadata: { reason: reply.reason, segue: reply.segue, context: reply.context }
    });
    await saveNow(env, reply);
    return json(reply);
  }

  if (request.method === "POST" && url.pathname === "/api/play") {
    const body = (await request.json()) as { track: Track; reason?: string; eventType?: "play" | "ended" | "skip" | "fail" | "complete"; mood?: string; duration?: number; position?: number };
    await recordPlaybackEvent(env, {
      eventType: body.eventType ?? "play",
      track: body.track,
      reason: body.reason,
      mood: body.mood,
      duration: body.duration,
      position: body.position
    });
    return json({ ok: true });
  }

  if (request.method === "POST" && url.pathname === "/api/dj/intro") {
    const body = (await request.json()) as { track?: Track | null; previousTrack?: Track | null; message?: string; context?: MoodContext; mode?: "opening" | "recommend" | "handoff" };
    const profile = await getProfile(env);
    const memory = await getUserMemory(env);
    const say = await writeDjIntroForTrack(env, {
      profile,
      message: body.message ?? "自动接下一首，像深夜私人电台一样自然介绍。",
      context: body.context ?? {},
      track: body.track ?? null,
      mode: body.mode ?? "recommend",
      memory,
      previousTrack: body.previousTrack ?? null
    });
    await recordChatMessage(env, {
      role: "assistant",
      content: say,
      kind: body.mode === "handoff" ? "dj_handoff" : "dj_intro",
      track: body.track ?? null,
      metadata: { previousTrack: body.previousTrack ?? null, context: body.context ?? {} }
    });
    return json({
      say
    });
  }

  if (request.method === "POST" && url.pathname === "/api/dj/intro/debug") {
    const body = (await request.json()) as { track?: Track | null; previousTrack?: Track | null; message?: string; context?: MoodContext; mode?: "opening" | "recommend" | "handoff" };
    const profile = await getProfile(env);
    const memory = await getUserMemory(env);
    return json(await debugDjIntroForTrack(env, {
      profile,
      message: body.message ?? "自动接下一首，像深夜私人电台一样自然介绍。",
      context: body.context ?? {},
      track: body.track ?? null,
      mode: body.mode ?? "recommend",
      memory,
      previousTrack: body.previousTrack ?? null
    }));
  }

  if (request.method === "GET" && url.pathname === "/api/plan/today") {
    const profile = await getProfile(env);
    const context = contextFromUrl(url);
    return json(profile.routines.map((routine, index) => ({ ...routine, track: chooseTrack(profile, routine, index, context) })));
  }

  if (url.pathname === "/api/tts" && (request.method === "GET" || request.method === "POST")) {
    const body = request.method === "POST"
      ? ((await request.json().catch(() => ({}))) as { text?: string; lang?: string; speaker?: string })
      : {};
    return speak(env, {
      text: body.text ?? url.searchParams.get("text") ?? "",
      lang: body.lang ?? url.searchParams.get("lang") ?? undefined,
      speaker: body.speaker ?? url.searchParams.get("speaker") ?? undefined
    });
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

async function safeNeteaseUrl(env: Env, id: string): Promise<unknown> {
  try {
    return await getNeteaseUrl(env, id);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unknown Netease error" };
  }
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

async function speak(env: Env, input: { text: string; lang?: string; speaker?: string }): Promise<Response> {
  const text = sanitizeTtsText(input.text);
  if (!text) return new Response("Missing text", { status: 400 });

  if (env.MINIMAX_API_KEY) {
    return speakWithMinimax(env, text, input.speaker);
  }

  if (!env.AI) {
    return json({ error: "No TTS provider configured." }, 501);
  }

  const model = env.TTS_MODEL || "@cf/myshell-ai/melotts";
  const lang = input.lang || env.TTS_LANG || "zh";
  const speaker = input.speaker || env.TTS_SPEAKER;
  const payload = model.includes("melotts")
    ? { prompt: text, lang }
    : { text, ...(speaker ? { speaker } : {}) };

  const response = (await env.AI.run(model, payload, { returnRawResponse: true })) as unknown as Response;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const data = await response.clone().json().catch(() => null) as { audio?: string; result?: { audio?: string } } | null;
    const audio = data?.audio ?? data?.result?.audio;
    if (audio) {
      const headers = new Headers({
        "content-type": "audio/mpeg",
        "cache-control": "public, max-age=86400"
      });
      return new Response(base64ToArrayBuffer(audio), { status: response.status, headers });
    }
  }

  const headers = new Headers(response.headers);
  if (!headers.get("content-type")) headers.set("content-type", "audio/mpeg");
  headers.set("cache-control", "public, max-age=86400");
  return new Response(response.body, { status: response.status, headers });
}

async function speakWithMinimax(env: Env, text: string, speaker?: string): Promise<Response> {
  const baseUrl = (env.MINIMAX_BASE_URL || "https://api.minimaxi.com/v1").replace(/\/$/, "");
  const endpoint = env.MINIMAX_GROUP_ID
    ? `${baseUrl}/t2a_v2?GroupId=${encodeURIComponent(env.MINIMAX_GROUP_ID)}`
    : `${baseUrl}/t2a_v2`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "authorization": `Bearer ${env.MINIMAX_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: env.MINIMAX_TTS_MODEL || "speech-2.8-hd",
      text,
      stream: false,
      language_boost: "Chinese",
      output_format: "hex",
      voice_setting: {
        voice_id: speaker || env.MINIMAX_TTS_VOICE_ID || "Friendly_Person",
        speed: 0.92,
        vol: 1,
        pitch: 0
      },
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: "mp3",
        channel: 1
      }
    })
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    return json({ error: "MiniMax TTS failed", status: response.status, endpoint, details: details.slice(0, 800) }, 502);
  }

  const data = await response.json().catch(() => null) as {
    data?: { audio?: string; audio_file?: string };
    audio?: string;
    base_resp?: { status_code?: number; status_msg?: string };
  } | null;
  const audio = data?.data?.audio ?? data?.data?.audio_file ?? data?.audio;
  if (!audio) {
    return json({ error: "MiniMax TTS returned no audio", endpoint, details: data?.base_resp ?? data }, 502);
  }

  const bytes = decodeAudioString(audio);
  return new Response(bytes, {
    headers: {
      "content-type": "audio/mpeg",
      "cache-control": "public, max-age=86400"
    }
  });
}

function sanitizeTtsText(text: string): string {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[*_`#>{}[\]]/g, "")
    .trim()
    .slice(0, 800);
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const clean = value.includes(",") ? value.split(",").pop() ?? "" : value;
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function decodeAudioString(value: string): ArrayBuffer {
  const clean = value.includes(",") ? value.split(",").pop() ?? "" : value;
  if (/^[0-9a-f]+$/i.test(clean) && clean.length % 2 === 0) {
    const bytes = new Uint8Array(clean.length / 2);
    for (let index = 0; index < clean.length; index += 2) {
      bytes[index / 2] = Number.parseInt(clean.slice(index, index + 2), 16);
    }
    return bytes.buffer;
  }
  return base64ToArrayBuffer(clean);
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
    background: raw.background,
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
