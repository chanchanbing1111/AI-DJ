import { generateJson } from "./llm";
import { chooseTrack, fallbackDjReply, pickRoutine } from "./persona";
import {
  getNeteaseRecommendedSongs,
  getNeteaseSimilarSongs,
  searchNetease
} from "./netease";
import type { DjReply, Env, MoodContext, Routine, TasteProfile, Track } from "./types";

type AgentIntent = "recommend" | "play" | "skip" | "chat" | "mood";
type AgentTool = "playlist_pick" | "netease_search" | "netease_similar" | "netease_daily" | "none";

interface AgentPlan {
  intent: AgentIntent;
  tool: AgentTool;
  query?: string;
  mood?: string;
  energy?: number;
  say?: string;
  reason?: string;
  segue?: string;
}

export async function computeAgentReply(env: Env, input: {
  message: string;
  context: MoodContext;
  profile: TasteProfile;
  current?: DjReply | null;
}): Promise<DjReply> {
  const routine = pickRoutine(input.profile);
  const inferredContext = { mood: inferMood(input.message), note: input.message, ...input.context };
  const fallbackTrack = chooseTrack(input.profile, routine, hash(input.message), inferredContext);
  const fallback = fallbackDjReply(input.profile, routine, fallbackTrack, inferredContext);

  try {
    const plan = await planDjAction(env, input.profile, routine, input.message, inferredContext, input.current);
    const candidates = await runMusicTool(env, plan, input.profile, routine, inferredContext, input.current);

    if (plan.intent === "chat" && !candidates.length) {
      return {
        ...fallback,
        say: plan.say ?? fallback.say,
        reason: plan.reason ?? "Chat only.",
        segue: plan.segue ?? fallback.segue,
        play: input.current?.play ?? fallback.play,
        context: inferredContext
      };
    }

    const selected = await selectFinalTrack(env, {
      plan,
      candidates: candidates.length ? candidates : [fallbackTrack].filter(Boolean) as Track[],
      profile: input.profile,
      routine,
      message: input.message,
      context: inferredContext
    });

    return {
      say: selected.say ?? plan.say ?? fallback.say,
      play: selected.play ?? candidates[0] ?? fallbackTrack,
      reason: selected.reason ?? plan.reason ?? fallback.reason,
      segue: selected.segue ?? plan.segue ?? fallback.segue,
      context: inferredContext
    };
  } catch {
    return fallback;
  }
}

async function planDjAction(
  env: Env,
  profile: TasteProfile,
  routine: Routine,
  message: string,
  context: MoodContext,
  current?: DjReply | null
): Promise<AgentPlan> {
  const prompt = [
    "You are the planning brain for a private AI radio DJ.",
    "Return strict JSON only. No markdown.",
    "Choose how to respond to the user.",
    "Allowed intent: recommend, play, skip, chat, mood.",
    "Allowed tool: playlist_pick, netease_search, netease_similar, netease_daily, none.",
    "Use netease_search when the user explicitly asks to play/recommend/find music outside the imported playlist, or describes a listening vibe.",
    "Use netease_similar when the user asks for more like the current song.",
    "Use netease_daily when the user asks for discovery without a clear query.",
    "Use playlist_pick when the imported playlist is enough.",
    "Use chat when the user is talking to the DJ, asking a question, sharing feelings, or not clearly asking to change music.",
    "For chat, choose tool none and answer warmly without changing the current track.",
    `User profile: ${JSON.stringify({ name: profile.name, favoriteMoods: profile.favoriteMoods, playlistSize: profile.playlists.length })}`,
    `Current routine: ${JSON.stringify(routine)}`,
    `Weather/mood context: ${JSON.stringify(context)}`,
    `Current track: ${JSON.stringify(current?.play ?? null)}`,
    `User message: ${message}`,
    "Output fields: intent, tool, query, mood, energy, say, reason, segue.",
    "The say field should feel like a human radio DJ: acknowledge the user's situation, mention the music if changing tracks, and make the user feel lighter."
  ].join("\n");

  const text = await generateJson(env, [
    { role: "system", content: "You are a JSON-only music planning agent." },
    { role: "user", content: prompt }
  ]);

  if (!text) return heuristicPlan(message, current);
  return { ...heuristicPlan(message, current), ...JSON.parse(cleanJson(text)) };
}

async function runMusicTool(
  env: Env,
  plan: AgentPlan,
  profile: TasteProfile,
  routine: Routine,
  context: MoodContext,
  current?: DjReply | null
): Promise<Track[]> {
  if (plan.tool === "netease_search" && plan.query) {
    return searchNetease(env, plan.query);
  }

  if (plan.tool === "netease_similar" && current?.play?.sourceId) {
    return getNeteaseSimilarSongs(env, current.play.sourceId);
  }

  if (plan.tool === "netease_daily") {
    return getNeteaseRecommendedSongs(env);
  }

  if (plan.tool === "none") {
    return [];
  }

  return [chooseTrack(profile, routine, Date.now(), context)].filter(Boolean) as Track[];
}

async function selectFinalTrack(env: Env, input: {
  plan: AgentPlan;
  candidates: Track[];
  profile: TasteProfile;
  routine: Routine;
  message: string;
  context: MoodContext;
}): Promise<Partial<DjReply>> {
  const compactCandidates = input.candidates.slice(0, 12).map((track, index) => ({
    index,
    title: track.title,
    artist: track.artist,
    album: track.album,
    source: track.source,
    sourceId: track.sourceId,
    mood: track.mood,
    energy: track.energy
  }));

  const prompt = [
    "You are a private radio DJ selecting one track from candidates.",
    "Return strict JSON only. No markdown.",
    "Output fields: index, say, reason, segue.",
    `Plan: ${JSON.stringify(input.plan)}`,
    `Routine: ${JSON.stringify(input.routine)}`,
    `Weather/mood context: ${JSON.stringify(input.context)}`,
    `User message: ${input.message}`,
    `Candidates: ${JSON.stringify(compactCandidates)}`,
    "Pick the best candidate.",
    "The say field must introduce the chosen song, connect it to the user's mood/weather/time, explain why it fits, and sound warm and mood-lifting.",
    "Keep say between 60 and 140 Chinese characters when writing Chinese."
  ].join("\n");

  const text = await generateJson(env, [
    { role: "system", content: "You are a JSON-only track selector." },
    { role: "user", content: prompt }
  ]);

  if (!text) return { play: input.candidates[0] };
  const parsed = JSON.parse(cleanJson(text)) as { index?: number; say?: string; reason?: string; segue?: string };
  const index = Number.isInteger(parsed.index) ? Math.min(Math.max(parsed.index ?? 0, 0), input.candidates.length - 1) : 0;

  return {
    play: input.candidates[index],
    say: parsed.say,
    reason: parsed.reason,
    segue: parsed.segue
  };
}

function heuristicPlan(message: string, current?: DjReply | null): AgentPlan {
  if (/^(hi|hello|hey|你好|在吗|聊聊|谢谢|为什么|怎么|可以吗)/i.test(message.trim())) {
    return { intent: "chat", tool: "none", reason: "User is chatting, not asking for a track change." };
  }
  if (/similar|like this|类似|像这首|差不多/.test(message) && current?.play?.sourceId) {
    return { intent: "recommend", tool: "netease_similar", reason: "User asked for similar music." };
  }
  if (/new|discover|recommend|play|song|music|推荐|找|来点|放|播|歌|音乐|换一首|下一首/.test(message)) {
    return { intent: "recommend", tool: "netease_search", query: message, reason: "User asked for a recommendation." };
  }
  return { intent: "chat", tool: "none", reason: "Default to conversation unless the user asks for music." };
}

function cleanJson(text: string): string {
  return text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "");
}

function inferMood(message: string): string | undefined {
  if (/tired|anxious|sad|rain|calm|relax|\u7d2f|\u56f0|\u70e6|\u4f4e\u843d|\u7126\u8651|\u96e8|\u677e\u5f1b/.test(message)) return "\u677e\u5f1b";
  if (/work|focus|code|study|\u5de5\u4f5c|\u4e13\u6ce8|\u4ee3\u7801|\u5b66\u4e60|\u5185\u5bb9/.test(message)) return "\u4e13\u6ce8";
  if (/morning|awake|commute|sport|\u9192|\u901a\u52e4|\u65e9|\u7cbe\u795e|\u8fd0\u52a8/.test(message)) return "\u6e05\u9192";
  if (/night|romantic|vibe|\u591c|\u6d6a\u6f2b|\u665a\u4e0a|\u6c1b\u56f4/.test(message)) return "\u591c\u665a";
  return undefined;
}

function hash(value: string): number {
  return [...value].reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) | 0, 7);
}
