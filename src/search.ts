import type { Env, Track } from "./types";

export interface SongResearch {
  available: boolean;
  query: string;
  answer: string;
  error?: string;
  sources: Array<{
    title: string;
    url: string;
    snippet: string;
  }>;
}

export async function researchSong(env: Env, track: Track | null): Promise<SongResearch> {
  const query = buildSongResearchQuery(track);
  if (!track || !query) return emptyResearch(query);
  if (env.EXA_API_KEY) {
    try {
      const result = await searchWithExa(env, query);
      if (result.available) return result;
      const fallbackQuery = buildBroadSongResearchQuery(track);
      if (fallbackQuery && fallbackQuery !== query) return await searchWithExa(env, fallbackQuery);
      return result;
    } catch (error) {
      if (!env.TAVILY_API_KEY) return emptyResearch(query, `exa: ${errorMessage(error)}`);
      // Fall through to Tavily if configured.
    }
  }
  if (!env.TAVILY_API_KEY) return emptyResearch(query);

  try {
    return await searchWithTavily(env, query);
  } catch (error) {
    return emptyResearch(query, `tavily: ${errorMessage(error)}`);
  }
}

function buildSongResearchQuery(track: Track | null): string {
  if (!track?.title || !track.artist) return "";
  return `"${track.title}" "${track.artist}" 歌曲 含义 创作背景 歌词 解读`;
}

function buildBroadSongResearchQuery(track: Track | null): string {
  if (!track?.title || !track.artist) return "";
  return `${track.title} ${track.artist} song meaning lyrics background`;
}

function emptyResearch(query: string, error?: string): SongResearch {
  return { available: false, query, answer: "", ...(error ? { error } : {}), sources: [] };
}

async function searchWithExa(env: Env, query: string): Promise<SongResearch> {
  const baseUrl = (env.EXA_BASE_URL || "https://api.exa.ai").replace(/\/$/, "");
  const apiKey = normalizeApiKey(env.EXA_API_KEY);
  const body = JSON.stringify({
    query,
    type: "auto",
    numResults: 5,
    contents: {
      text: { maxCharacters: 800 },
      highlights: true,
      summary: true
    }
  });
  let response = await fetch(`${baseUrl}/search`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey
    },
    body
  });

  if (response.status === 401) {
    response = await fetch(`${baseUrl}/search`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${apiKey}`
      },
      body
    });
  }

  if (!response.ok) throw new Error(`Exa search failed: ${response.status}`);
  const data = await response.json() as {
    answer?: string;
    results?: Array<{
      title?: string;
      url?: string;
      text?: string;
      summary?: string;
      highlights?: string[];
    }>;
  };

  const sources = (data.results ?? [])
    .filter((item) => item.title && item.url)
    .slice(0, 5)
    .map((item) => ({
      title: String(item.title),
      url: String(item.url),
      snippet: cleanSnippet(item.summary || item.highlights?.join(" / ") || item.text || "")
    }));

  return {
    available: Boolean(data.answer || sources.length),
    query,
    answer: cleanSnippet(data.answer ?? sources.map((source) => source.snippet).filter(Boolean).slice(0, 2).join(" ")),
    sources
  };
}

async function searchWithTavily(env: Env, query: string): Promise<SongResearch> {
  const endpoint = (env.TAVILY_BASE_URL || "https://api.tavily.com/search").trim();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${env.TAVILY_API_KEY}`
    },
    body: JSON.stringify({
      query,
      search_depth: "basic",
      topic: "general",
      max_results: 5,
      include_answer: true,
      include_raw_content: false
    })
  });

  if (!response.ok) throw new Error(`Tavily search failed: ${response.status}`);
  const data = await response.json() as {
    answer?: string;
    results?: Array<{
      title?: string;
      url?: string;
      content?: string;
      score?: number;
    }>;
  };

  const sources = (data.results ?? [])
    .filter((item) => item.title && item.url)
    .slice(0, 5)
    .map((item) => ({
      title: String(item.title),
      url: String(item.url),
      snippet: cleanSnippet(item.content ?? "")
    }));

  return {
    available: Boolean(data.answer || sources.length),
    query,
    answer: cleanSnippet(data.answer ?? ""),
    sources
  };
}

function cleanSnippet(value: string): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u001f]+/g, " ")
    .trim()
    .slice(0, 360);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "unknown");
}

function normalizeApiKey(value: string | undefined): string {
  return String(value || "")
    .trim()
    .replace(/^Bearer\s+/i, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}
