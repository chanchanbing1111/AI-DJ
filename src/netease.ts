import type { Env, Track } from "./types";

interface NeteaseSong {
  id: number | string;
  name: string;
  ar?: Array<{ name: string }>;
  artists?: Array<{ name: string }>;
  al?: { name?: string; picUrl?: string };
  album?: { name?: string; picUrl?: string };
}

export async function searchNetease(env: Env, keyword: string): Promise<Track[]> {
  const data = await neteaseFetch<{ result?: { songs?: NeteaseSong[] } }>(env, "/search", {
    keywords: keyword,
    limit: "8"
  });

  return (data.result?.songs ?? []).map(songToTrack);
}

export async function resolveNeteaseTracks(env: Env, tracks: Array<Partial<Track> & { name?: string }>): Promise<Track[]> {
  const resolved: Track[] = [];

  for (const track of tracks.slice(0, 200)) {
    const title = String(track.title ?? track.name ?? "").trim();
    const artist = String(track.artist ?? "").trim();
    if (!title || !artist) continue;

    const matches = await searchNetease(env, `${title} ${artist}`);
    const best = matches[0];
    resolved.push({
      ...track,
      id: best?.id ?? track.id ?? `manual-${hash(`${title}:${artist}`)}`,
      title,
      name: track.name ?? title,
      artist: best?.artist ?? artist,
      album: best?.album ?? track.album,
      cover: best?.cover ?? track.cover,
      source: "netease",
      sourceId: best?.sourceId,
      externalUrl: best?.externalUrl,
      playable: Boolean(track.url),
      cached: Boolean(track.url),
      url: track.url
    });
  }

  return resolved;
}

export async function getNeteaseUrl(env: Env, id: string): Promise<{ url?: string; playable: boolean; raw: unknown }> {
  const data = await neteaseFetch<{ data?: Array<{ url?: string | null }> }>(env, "/song/url/v1", {
    id,
    level: "standard"
  });
  const url = data.data?.[0]?.url ?? undefined;
  return { url, playable: Boolean(url), raw: data };
}

export async function getNeteaseLyric(env: Env, id: string): Promise<unknown> {
  return neteaseFetch(env, "/lyric", { id });
}

async function neteaseFetch<T>(env: Env, path: string, params: Record<string, string>): Promise<T> {
  if (!env.NETEASE_API_BASE) {
    throw new Error("NETEASE_API_BASE is not configured. Deploy a NeteaseCloudMusicApi-compatible service and set this variable.");
  }

  const url = new URL(path, ensureSlash(env.NETEASE_API_BASE));
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));

  const headers: HeadersInit = {};
  if (env.NETEASE_COOKIE) headers.cookie = env.NETEASE_COOKIE;

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Netease API failed: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

function songToTrack(song: NeteaseSong): Track {
  const artist = (song.ar ?? song.artists ?? []).map((item) => item.name).filter(Boolean).join(" / ");
  const album = song.al ?? song.album;
  const sourceId = String(song.id);
  return {
    id: `netease-${sourceId}`,
    title: song.name,
    name: song.name,
    artist,
    album: album?.name,
    cover: album?.picUrl,
    source: "netease",
    sourceId,
    externalUrl: `https://music.163.com/#/song?id=${sourceId}`,
    playable: false,
    cached: false
  };
}

function ensureSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function hash(value: string): number {
  return [...value].reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) | 0, 7);
}
