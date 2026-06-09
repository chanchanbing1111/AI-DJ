export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  AI?: Ai;
  DJ_NAME: string;
  AI_MODEL: string;
  TTS_MODEL: string;
  TTS_LANG?: string;
  TTS_SPEAKER?: string;
  NETEASE_API_BASE?: string;
  NETEASE_COOKIE?: string;
  NETEASE_PROXY_TOKEN?: string;
  LLM_API_KEY?: string;
  LLM_BASE_URL?: string;
  LLM_MODEL?: string;
  MINIMAX_API_KEY?: string;
  MINIMAX_GROUP_ID?: string;
  MINIMAX_BASE_URL?: string;
  MINIMAX_TTS_MODEL?: string;
  MINIMAX_TTS_VOICE_ID?: string;
  TAVILY_API_KEY?: string;
  TAVILY_BASE_URL?: string;
  EXA_API_KEY?: string;
  EXA_BASE_URL?: string;
}

export interface Track {
  id: string;
  title: string;
  artist: string;
  url?: string;
  name?: string;
  album?: string;
  background?: string;
  cover?: string;
  mood?: string[];
  energy?: number;
  source?: string;
  sourceId?: string;
  externalUrl?: string;
  playable?: boolean;
  cached?: boolean;
}

export interface TasteProfile {
  name: string;
  language: "zh" | "en" | "mixed";
  favoriteMoods: string[];
  blockedArtists: string[];
  routines: Routine[];
  playlists: Track[];
}

export interface Routine {
  label: string;
  start: string;
  end: string;
  mood: string;
  energy: number;
}

export interface WeatherContext {
  city?: string;
  temperature?: number;
  condition?: string;
  wind?: number;
  code?: number;
}

export interface MoodContext {
  mood?: string;
  note?: string;
  weather?: WeatherContext;
}

export interface DjReply {
  say: string;
  play: Track | null;
  reason: string;
  segue: string;
  context?: MoodContext;
  intent?: "recommend" | "play" | "skip" | "chat" | "mood";
}

export interface UserMemory {
  preferences: Record<string, unknown>;
  blockedPhrases: string[];
  voice: {
    provider: string;
    voiceId: string;
    speed: number;
    pitch: number;
  };
  recentTracks: Array<{
    trackKey: string;
    title: string;
    artist?: string;
    eventType: string;
    playedAt: string;
  }>;
}

export interface ChatHistoryMessage {
  id: number;
  role: "user" | "assistant" | "system";
  kind: string;
  content: string;
  trackKey?: string;
  trackTitle?: string;
  trackArtist?: string;
  trackSource?: string;
  trackSourceId?: string;
  metadata?: unknown;
  createdAt: string;
}
