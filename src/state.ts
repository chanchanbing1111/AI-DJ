import { defaultProfile } from "./persona";
import type { ChatHistoryMessage, Env, TasteProfile, Track, UserMemory } from "./types";

const PROFILE_KEY = "taste_profile";
const NOW_KEY = "now_playing";

const DEFAULT_BLOCKED_PHRASES = [
  "这首歌大概在讲",
  "这首在讲",
  "这几个字很轻",
  "挺轻",
  "对我来说",
  "提醒我们",
  "标准答案",
  "真正扎人",
  "不用马上说清楚",
  "这些词放在一起",
  "它不把",
  "反而",
  "留着一点体面",
  "这句话像",
  "歌词线索",
  "说明",
  "象征"
];

const DEFAULT_PREFERENCES = {
  djStyle: "Claudio private late-night radio: concrete, tender, specific, with breath and silence.",
  avoidTone: "不要 AI 腔、客服腔、鸡汤、文学赏析腔；不要说教。",
  wantedVoice: "温柔、贴耳、像真人的女声或中性温柔声。",
  currentTtsVoice: "Friendly_Person"
};

export async function getProfile(env: Env): Promise<TasteProfile> {
  const row = await env.DB.prepare("SELECT value FROM kv_state WHERE key = ?").bind(PROFILE_KEY).first<{ value: string }>();
  if (!row) return defaultProfile;
  return { ...defaultProfile, ...JSON.parse(row.value) };
}

export async function saveProfile(env: Env, profile: TasteProfile): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO kv_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP"
  )
    .bind(PROFILE_KEY, JSON.stringify(profile))
    .run();
}

export async function getNow(env: Env) {
  const row = await env.DB.prepare("SELECT value FROM kv_state WHERE key = ?").bind(NOW_KEY).first<{ value: string }>();
  return row ? JSON.parse(row.value) : null;
}

export async function saveNow(env: Env, value: unknown): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO kv_state (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP"
  )
    .bind(NOW_KEY, JSON.stringify(value))
    .run();
}

export async function getUserMemory(env: Env): Promise<UserMemory> {
  await seedDefaultMemory(env);
  const prefs = await env.DB.prepare("SELECT key, value FROM user_memory").all<{ key: string; value: string }>();
  const blocked = await env.DB.prepare("SELECT phrase FROM blocked_phrases ORDER BY created_at ASC").all<{ phrase: string }>();
  const voice = await env.DB.prepare("SELECT key, value FROM voice_settings").all<{ key: string; value: string }>();
  const recent = await env.DB.prepare(
    "SELECT track_key AS trackKey, title, artist, event_type AS eventType, played_at AS playedAt FROM play_events ORDER BY played_at DESC LIMIT 12"
  ).all<{ trackKey: string; title: string; artist?: string; eventType: string; playedAt: string }>();

  return {
    preferences: Object.fromEntries((prefs.results ?? []).map((row) => [row.key, parseMaybeJson(row.value)])),
    blockedPhrases: (blocked.results ?? []).map((row) => row.phrase),
    voice: {
      provider: "minimax",
      voiceId: getSetting(voice.results ?? [], "voiceId", "Friendly_Person"),
      speed: Number(getSetting(voice.results ?? [], "speed", "0.92")),
      pitch: Number(getSetting(voice.results ?? [], "pitch", "0"))
    },
    recentTracks: recent.results ?? []
  };
}

export async function recordPlaybackEvent(env: Env, input: {
  eventType: "play" | "ended" | "skip" | "fail" | "complete";
  track: Track;
  reason?: string;
  mood?: string;
  duration?: number;
  position?: number;
}): Promise<void> {
  const key = trackKey(input.track);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO play_events (track_id, track_key, title, artist, mood, source, event_type, reason, duration, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(input.track.id, key, input.track.title, input.track.artist, input.mood ?? input.reason ?? "", input.track.source ?? "manual", input.eventType, input.reason ?? "", input.duration ?? null, input.position ?? null),
    env.DB.prepare(
      `INSERT INTO track_memory (track_key, title, artist, source, source_id, play_count, skip_count, completed_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(track_key) DO UPDATE SET
         title = excluded.title,
         artist = excluded.artist,
         source = excluded.source,
         source_id = excluded.source_id,
         play_count = track_memory.play_count + excluded.play_count,
         skip_count = track_memory.skip_count + excluded.skip_count,
         completed_count = track_memory.completed_count + excluded.completed_count,
         updated_at = CURRENT_TIMESTAMP`
    ).bind(
      key,
      input.track.title,
      input.track.artist,
      input.track.source ?? "manual",
      input.track.sourceId ?? "",
      input.eventType === "play" ? 1 : 0,
      input.eventType === "skip" || input.eventType === "fail" ? 1 : 0,
      input.eventType === "ended" || input.eventType === "complete" ? 1 : 0
    )
  ]);
}

export async function saveVoiceSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO voice_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP"
  ).bind(key, value).run();
}

export async function recordChatMessage(env: Env, input: {
  role: "user" | "assistant" | "system";
  content: string;
  kind?: string;
  track?: Track | null;
  metadata?: unknown;
}): Promise<void> {
  const content = input.content.trim();
  if (!content) return;
  const track = input.track ?? null;
  await env.DB.prepare(
    `INSERT INTO chat_messages
      (role, kind, content, track_key, track_title, track_artist, track_source, track_source_id, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    input.role,
    input.kind ?? "chat",
    content.slice(0, 4000),
    track ? trackKey(track) : null,
    track?.title ?? null,
    track?.artist ?? null,
    track?.source ?? null,
    track?.sourceId ?? null,
    input.metadata === undefined ? null : JSON.stringify(input.metadata)
  ).run();
}

export async function getChatHistory(env: Env, limit = 50): Promise<ChatHistoryMessage[]> {
  const safeLimit = Math.min(Math.max(Math.floor(limit) || 50, 1), 200);
  const rows = await env.DB.prepare(
    `SELECT id, role, kind, content,
      track_key AS trackKey,
      track_title AS trackTitle,
      track_artist AS trackArtist,
      track_source AS trackSource,
      track_source_id AS trackSourceId,
      metadata,
      created_at AS createdAt
       FROM chat_messages
       WHERE kind IN ('chat', 'dj_reply')
         AND NOT (
           role = 'user'
           AND content LIKE '今天根据天气、心情和歌单开台。%'
         )
       ORDER BY datetime(created_at) DESC, id DESC
       LIMIT ?`
  ).bind(safeLimit).all<{
    id: number;
    role: "user" | "assistant" | "system";
    kind: string;
    content: string;
    trackKey?: string;
    trackTitle?: string;
    trackArtist?: string;
    trackSource?: string;
    trackSourceId?: string;
    metadata?: string | null;
    createdAt: string;
  }>();

  return (rows.results ?? []).reverse().map((row) => ({
    ...row,
    metadata: row.metadata ? parseMaybeJson(row.metadata) : undefined
  }));
}

export async function clearChatHistory(env: Env): Promise<number> {
  const result = await env.DB.prepare("DELETE FROM chat_messages").run();
  return result.meta.changes ?? 0;
}

async function seedDefaultMemory(env: Env): Promise<void> {
  const existing = await env.DB.prepare("SELECT key FROM user_memory LIMIT 1").first();
  if (!existing) {
    await env.DB.batch(Object.entries(DEFAULT_PREFERENCES).map(([key, value]) =>
      env.DB.prepare("INSERT OR IGNORE INTO user_memory (key, value) VALUES (?, ?)").bind(key, JSON.stringify(value))
    ));
  }
  await env.DB.batch(DEFAULT_BLOCKED_PHRASES.map((phrase) =>
    env.DB.prepare("INSERT OR IGNORE INTO blocked_phrases (phrase, reason) VALUES (?, ?)").bind(phrase, "User disliked robotic DJ phrasing.")
  ));
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO voice_settings (key, value) VALUES (?, ?)").bind("voiceId", "Friendly_Person"),
    env.DB.prepare("INSERT OR IGNORE INTO voice_settings (key, value) VALUES (?, ?)").bind("speed", "0.92"),
    env.DB.prepare("INSERT OR IGNORE INTO voice_settings (key, value) VALUES (?, ?)").bind("pitch", "0")
  ]);
}

function getSetting(rows: Array<{ key: string; value: string }>, key: string, fallback: string): string {
  return rows.find((row) => row.key === key)?.value ?? fallback;
}

function parseMaybeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function trackKey(track: Track): string {
  return track.sourceId ? `${track.source ?? "netease"}:${track.sourceId}` : `${track.title}:${track.artist}`;
}
