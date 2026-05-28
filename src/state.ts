import { defaultProfile } from "./persona";
import type { Env, TasteProfile } from "./types";

const PROFILE_KEY = "taste_profile";
const NOW_KEY = "now_playing";

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
