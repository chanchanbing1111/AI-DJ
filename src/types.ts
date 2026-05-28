export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  AI?: Ai;
  DJ_NAME: string;
  AI_MODEL: string;
  TTS_MODEL: string;
}

export interface Track {
  id: string;
  title: string;
  artist: string;
  url?: string;
  name?: string;
  album?: string;
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
}
