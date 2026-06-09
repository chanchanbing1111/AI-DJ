import { generateJson } from "./llm";
import { chooseTrack, pickRoutine } from "./persona";
import {
  getNeteaseLyric,
  getNeteaseRecommendedSongs,
  getNeteaseSimilarSongs,
  getNeteaseUrl,
  searchNetease
} from "./netease";
import type { DjReply, Env, MoodContext, Routine, TasteProfile, Track, UserMemory } from "./types";

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
  currentLyricContext?: string;
  memory?: UserMemory;
}): Promise<DjReply> {
  const routine = pickRoutine(input.profile);
  const inferredContext = { mood: inferMood(input.message), note: input.message, ...input.context };
  const fallbackTrack = chooseTrack(input.profile, routine, hash(input.message), inferredContext);
  const fallback = richDjReply(input.profile, routine, fallbackTrack, inferredContext);

  // If the user is chatting (not explicitly asking to change music), keep the current track
  // and focus on the conversation.
  if (isOpeningRequest(input.message)) {
    return fastOpeningReply(env, input.profile, routine, input.message, inferredContext, fallbackTrack, input.memory);
  }

  if (!wantsTrackChange(input.message)) {
    const currentTrack = await resolvePlayableMetadata(env, input.current?.play ?? null);

    if (isTrackQuestion(input.message) && currentTrack) {
      const say = await answerTrackQuestion(env, {
        profile: input.profile,
        message: input.message,
        context: inferredContext,
        track: currentTrack,
        lyricContext: input.currentLyricContext,
        memory: input.memory
      });

      return {
        say,
        play: currentTrack,
        reason: "Answered a question about the current track without changing playback.",
        segue: "保持当前歌曲，不切歌。",
        context: inferredContext,
        intent: "chat"
      };
    }

    if (isTrackQuestion(input.message)) {
      return {
        say: `${input.profile.name}，我这边还没拿到浏览器正在播放的那首歌，所以不能乱讲。你先点一下播放或下一首，我拿到当前歌曲和歌词后再说。`,
        play: null,
        reason: "Missing current track context for a song question.",
        segue: "等待前端同步当前播放歌曲。",
        context: inferredContext,
        intent: "chat"
      };
    }

    const chatPrompt = [
      "You are a private radio DJ chatting with the listener.",
      "Return strict JSON only. No markdown.",
      "Output fields: say, reason, segue.",
      `User profile: ${JSON.stringify({ name: input.profile.name, favoriteMoods: input.profile.favoriteMoods })}`,
      `Weather/mood context: ${JSON.stringify(inferredContext)}`,
      `Current track: ${JSON.stringify(input.current?.play ?? null)}`,
      `Long-term listener memory: ${JSON.stringify(memorySummary(input.memory))}`,
      `User message: ${input.message}`,
      "Requirements: acknowledge the user's message; sound like a relaxed human DJ, not a motivational poster; do not change the music; keep say under 140 Chinese characters when writing Chinese."
    ].join("\n");

    try {
      const text = await generateJson(env, [
        { role: "system", content: "You are a concise private radio DJ. Return JSON only." },
        { role: "user", content: chatPrompt }
      ]);
      if (text) {
        const parsed = parseJsonObject<Partial<DjReply>>(text);
        return {
          say: String(parsed.say ?? fallback.say),
          play: await resolvePlayableMetadata(env, input.current?.play ?? fallback.play),
          reason: String(parsed.reason ?? "Chat only."),
          segue: String(parsed.segue ?? fallback.segue),
          context: inferredContext,
          intent: "chat"
        };
      }
    } catch {
      // fall through
    }

    return {
      say: currentTrack
        ? `${input.profile.name}，我在。现在这首 ${currentTrack.artist} 的《${currentTrack.title}》先稳稳放着，你想聊什么我都听着。`
        : `${input.profile.name}，我在。你可以直接和我说现在的心情，我会陪你聊，也会在你想听歌时再切歌。`,
      play: currentTrack,
      reason: "Chat only.",
      segue: currentTrack ? "保持当前歌曲，不切歌。" : "等待用户进一步表达。",
      context: inferredContext,
      intent: "chat"
    };
  }

  try {
    const plan = await planDjAction(env, input.profile, routine, input.message, inferredContext, input.current);
    const candidates = await runMusicTool(env, plan, input.profile, routine, inferredContext, input.current);

    if (plan.intent === "chat" && !candidates.length) {
      return {
        ...fallback,
        say: plan.say ?? fallback.say,
        reason: plan.reason ?? "Chat only.",
        segue: plan.segue ?? fallback.segue,
        play: await resolvePlayableMetadata(env, input.current?.play ?? fallback.play),
        context: inferredContext
      };
    }

    const candidatesForSelection = candidates.length ? candidates : [fallbackTrack].filter(Boolean) as Track[];
    const selected = await selectFinalTrack(env, {
      plan,
      candidates: candidatesForSelection,
      profile: input.profile,
      routine,
      message: input.message,
      context: inferredContext
    });

    const play =
      await resolvePlayableTrack(env, selected.play ?? candidates[0] ?? fallbackTrack, { requireLyrics: true }) ??
      await firstPlayableTrack(env, candidatesForSelection, { requireLyrics: true }) ??
      await resolvePlayableTrack(env, selected.play ?? candidates[0] ?? fallbackTrack) ??
      await firstPlayableTrack(env, candidatesForSelection);
    const say = await writeTrackIntro(env, {
      profile: input.profile,
      routine,
      message: input.message,
      context: inferredContext,
      track: play,
      mode: "recommend",
      memory: input.memory
    });

    return {
      say,
      play,
      reason: selected.reason ?? plan.reason ?? fallback.reason,
      segue: trackSegue(play, routine),
      context: inferredContext,
      intent: plan.intent
    };
  } catch {
    return { ...fallback, play: await resolvePlayableTrack(env, fallback.play) };
  }
}

async function fastOpeningReply(
  env: Env,
  profile: TasteProfile,
  routine: Routine,
  message: string,
  context: MoodContext,
  fallbackTrack: Track | null,
  memory?: UserMemory
): Promise<DjReply> {
  const track =
    await resolvePlayableTrack(env, chooseTrack(profile, routine, Date.now(), context) ?? fallbackTrack, { requireLyrics: true }) ??
    await resolvePlayableTrack(env, fallbackTrack, { requireLyrics: true }) ??
    await resolvePlayableTrack(env, chooseTrack(profile, routine, Date.now(), context) ?? fallbackTrack) ??
    await resolvePlayableTrack(env, fallbackTrack);
  const fallback = richDjReply(profile, routine, track, context);
  const say = await writeTrackIntro(env, { profile, routine, message, context, track, mode: "opening", memory });

  return {
    say,
    play: track,
    reason: fallback.reason,
    segue: fallback.segue,
    context,
    intent: "play"
  };
}

async function writeTrackIntro(env: Env, input: {
  profile: TasteProfile;
  routine: Routine;
  message: string;
  context: MoodContext;
  track: Track | null;
  mode: "opening" | "recommend" | "handoff";
  memory?: UserMemory;
  previousTrack?: Track | null;
}): Promise<string> {
  return (await buildTrackIntro(env, input)).say;
}

async function buildTrackIntro(env: Env, input: {
  profile: TasteProfile;
  routine: Routine;
  message: string;
  context: MoodContext;
  track: Track | null;
  mode: "opening" | "recommend" | "handoff";
  memory?: UserMemory;
  previousTrack?: Track | null;
}): Promise<{ say: string; source: "llm" | "fallback"; raw?: string; parsed?: string; cleaned?: string; fallback?: string; error?: string }> {
  const { profile, routine, message, context, track, mode, memory, previousTrack } = input;
  if (!track) {
    const say = `${profile.name}，这会儿还没摸到能接上的那一首。歌单留在这儿，我再往里找。`;
    return { say, source: "fallback", fallback: say };
  }

  const lyricContext = await getLyricContext(env, track, 24);
  const fallback = buildIntroFallback(profile.name, track, lyricContext, message, mode, previousTrack);
  const prompt = [
    "Return strict JSON only: {\"say\":\"...\"}.",
    "You are Claudio, a private late-night radio DJ talking to one listener.",
    `Exact selected track: ${JSON.stringify({ title: track.title, artist: track.artist, album: track.album, background: track.background, source: track.source, sourceId: track.sourceId })}`,
    `Previous track for handoff: ${JSON.stringify(previousTrack ? { title: previousTrack.title, artist: previousTrack.artist } : null)}`,
    `Listener/context: ${JSON.stringify({ name: profile.name, routine, context, memory: memorySummary(memory) })}`,
    `User message: ${message}`,
    `Lyric cues: ${lyricContext || "unavailable"}`,
    mode === "opening"
      ? [
          "Opening-song format target:",
          "Start with exactly: This is Claudio.",
          "Then mention the real day/time in one quiet sentence if available from context.",
          "Then introduce the exact artist/title as a song chosen for this moment.",
          "Use lyric cues to create a concrete listening doorway: an object, gesture, or pressure in the song. Transform the cue; do not quote it mechanically.",
          "If verified background is unavailable, do not fake history. Replace history with sonic/lyric observation: vocal distance, tempo, repeated image, emotional movement.",
          "The target rhythm is like: This is Claudio. It's late on Monday. Here's a song that moves with your breath... this one's called If. After a long day, just breathe.",
          "Do not say the opening is preparing, do not apologize, do not discuss syncing lyrics/audio, do not mention that you are an AI."
        ].join("\n")
      : [
          "Non-opening format target:",
          "Do not say 'This is Claudio'.",
          "Carry a small emotional residue from the previous song, then turn naturally into the exact next artist/title.",
          "Never say '先放', '接上', or any stock transition. Make it feel like a host continuing a thought."
        ].join("\n"),
    "Silently extract three notes from lyric cues before writing: one concrete object/action, one emotional conflict, and one reason this song fits the listener now. Do not output the notes.",
    "Do not summarize the song or explain what it is about. Open a small lived scene from the lyric evidence, then name artist/title once, then make one human turn.",
    "Avoid generic radio-poetry defaults unless the lyric directly supports them: wind, room, light, night, silence, company, slowly, stay here, let it accompany you.",
    "The copy should sound like a real late-night host who has listened to the song, not like a reading-comprehension answer or a motivational card.",
    mode === "handoff"
      ? "Write a natural handoff from previous song into this one. Do not use stock transition wording."
      : "Write a cold open before this song starts.",
    "Use only the exact track info and lyric cues. Do not invent background, interviews, dates, or songwriter intent.",
    "Do not explain the meaning like an essay. Write a spoken private-radio intro with a real scene, one lyric-based insight, and a listener-facing reason to hear it now.",
    "Do not paste lyric lines. You may borrow at most ONE short lyric image, under 12 Chinese characters, then paraphrase the feeling in your own words.",
    "Do not start by calling the listener's name. Use the listener name at most once, and only if it sounds intimate.",
    "Chinese, 150-230 Chinese characters. Occasional simple English is okay only for 'This is Claudio'.",
    "Avoid: 这首歌, 这首在讲, 这首大概在讲, 对我来说, 提醒我们, 这几个字, 这句话像, 歌词线索, 标准答案, 先放, 先听着, 慢慢进来, 接上来, 从这里进来, 从旁边进来, 歌进来, 声音进来, 留一点暗, 灯先暗一点, 把声音放轻, 不急着解释, 模式, 稳住状态, 好.",
    "Reference feel: This is Claudio。窗外还有车声，房间里只剩屏幕的光。孙燕姿的《遇见》留给今晚。它不是替谁许愿，而是把那种已经走了很久、仍然愿意等一个转角的心情放在桌上。你不用马上回答自己还在等什么，先让这几分钟陪你把那个问题听清楚。"
  ].join("\n");

  try {
    const text = await generateJson(env, [
      { role: "system", content: "Return JSON only. Write tasteful, human radio DJ copy." },
      { role: "user", content: prompt }
    ]);
    if (!text) throw new Error("No intro text.");
    const parsed = parseJsonObject<{ say?: string; line?: string }>(text);
    const parsedText = parsed.say ?? parsed.line ?? "";
    const refinedText = await refineDjIntro(env, {
      draft: parsedText,
      track,
      lyricContext,
      profileName: profile.name,
      message,
      mode,
      previousTrack
    }).catch(() => parsedText);
    let cleaned = cleanDjIntro(refinedText, profile.name, track, memory?.blockedPhrases);
    if (cleaned && !passesIntroQuality(cleaned, track)) {
      const secondPass = await refineDjIntro(env, {
        draft: cleaned,
        track,
        lyricContext,
        profileName: profile.name,
        message: `${message}\nRewrite again. The last draft still sounded templated.`,
        mode,
        previousTrack
      }).catch(() => "");
      cleaned = cleanDjIntro(secondPass, profile.name, track, memory?.blockedPhrases);
    }
    return cleaned
      ? { say: cleaned, source: "llm", raw: text, parsed: refinedText, cleaned, fallback }
      : { say: fallback, source: "fallback", raw: text, parsed: refinedText, fallback, error: "cleanDjIntro returned undefined" };
  } catch (error) {
    return { say: fallback, source: "fallback", fallback, error: error instanceof Error ? error.message : "Unknown intro error" };
  }
}

function passesIntroQuality(text: string, track: Track): boolean {
  const forbidden = [
    "慢慢进来",
    "接上来",
    "从这里进来",
    "从旁边进来",
    "歌进来",
    "声音进来",
    "这首歌",
    "这首在讲",
    "大概在讲",
    "这几个字",
    "歌词里",
    "意义",
    "标准答案",
    "放空一会儿",
    "隐秘的啰嗦",
    "回忆如风",
    "静默"
  ];
  if (forbidden.some((phrase) => text.includes(phrase))) return false;
  const titleCount = text.split(track.title).length - 1;
  if (titleCount > 1) return false;
  const artistCount = text.split(track.artist).length - 1;
  if (artistCount > 1) return false;
  const abstractHits = ["情绪", "治愈", "共鸣", "孤独", "温柔", "回忆", "遗憾", "释怀"].filter((word) => text.includes(word)).length;
  if (abstractHits > 4) return false;
  return text.length >= 60 && text.length <= 260;
}

async function refineDjIntro(env: Env, input: {
  draft: string;
  track: Track;
  lyricContext: string;
  profileName: string;
  message: string;
  mode: "opening" | "recommend" | "handoff";
  previousTrack?: Track | null;
}): Promise<string> {
  const prompt = [
    "Return strict JSON only: {\"say\":\"...\"}.",
    "You are Claudio's human editor. Rewrite the draft into a private radio voice.",
    `Track: ${JSON.stringify({ title: input.track.title, artist: input.track.artist })}`,
    `Previous track: ${JSON.stringify(input.previousTrack ? { title: input.previousTrack.title, artist: input.previousTrack.artist } : null)}`,
    `Listener: ${input.profileName}`,
    `User message: ${input.message}`,
    `Lyric cues, use as meaning source but do not copy: ${input.lyricContext || "unavailable"}`,
    `Draft: ${input.draft}`,
    input.mode === "opening"
      ? "For the first song, keep a real Claudio opening arc: This is Claudio; time/day; why this exact song belongs before playback; one lyric-derived image turned into your own observation; a gentle landing line. Never mention preparation or technical state."
      : "For later songs, make this a true handoff or response. Do not restart the station, do not say This is Claudio, and do not use stock transition phrases.",
    "Keep the concrete truth: exact artist/title and one feeling from the lyric cues.",
    "Delete machine phrases, analysis phrases, motivational slogans, and copied lyric strings.",
    "Do not say: 这首歌, 这首在讲, 大概在讲, 先放, 先听着, 不是着急, 我懂了, 这句话像, 这几个字, 歌词里, 意义, 标准答案, 慢慢进来, 接上来, 从这里进来, 从旁边进来, 歌进来, 声音进来, 放空一会儿, 隐秘, 静默, 回忆如风, 好.",
    input.mode === "handoff"
      ? "Make it a handoff: mention what the previous track left emotionally, then explain why this next track belongs after it. No cold-open wording."
      : "Make it a cold open: start from a concrete lived detail, then artist/title, then a lyric-based interpretation.",
    "Style target: intimate, cinematic, specific, slightly poetic, but still like a real person speaking softly. Expand the thought; do not make it a slogan.",
    "Chinese 150-230 characters. Start with This is Claudio only when it is the opening song. Otherwise do not use it."
  ].join("\n");

  const text = await generateJson(env, [
    { role: "system", content: "Return JSON only. Edit radio copy into natural human speech." },
    { role: "user", content: prompt }
  ]);
  const parsed = parseJsonObject<{ say?: string }>(text ?? "");
  return parsed.say ?? input.draft;
}

export async function writeDjIntroForTrack(env: Env, input: {
  profile: TasteProfile;
  message: string;
  context: MoodContext;
  track: Track | null;
  mode?: "opening" | "recommend" | "handoff";
  memory?: UserMemory;
  previousTrack?: Track | null;
}): Promise<string> {
  const routine = pickRoutine(input.profile);
  return writeTrackIntro(env, {
    profile: input.profile,
    routine,
    message: input.message,
    context: input.context,
    track: input.track,
    mode: input.mode ?? "recommend",
    memory: input.memory,
    previousTrack: input.previousTrack
  });
}

export async function debugDjIntroForTrack(env: Env, input: {
  profile: TasteProfile;
  message: string;
  context: MoodContext;
  track: Track | null;
  mode?: "opening" | "recommend" | "handoff";
  memory?: UserMemory;
  previousTrack?: Track | null;
}): Promise<unknown> {
  const routine = pickRoutine(input.profile);
  return buildTrackIntro(env, {
    profile: input.profile,
    routine,
    message: input.message,
    context: input.context,
    track: input.track,
    mode: input.mode ?? "recommend",
    memory: input.memory,
    previousTrack: input.previousTrack ?? null
  });
}

async function answerTrackQuestion(env: Env, input: {
  profile: TasteProfile;
  message: string;
  context: MoodContext;
  track: Track;
  lyricContext?: string;
  memory?: UserMemory;
}): Promise<string> {
  const lyricContext = input.lyricContext?.trim() || await getLyricContext(env, input.track, 32);
  const fallback = `${input.profile.name}，${lyricBasedAnswer(input.track, lyricContext)}`;

  const prompt = [
    "You are Claudio, a private radio DJ answering a listener's question about the current song.",
    "Return strict JSON only: {\"say\":\"...\"}.",
    `Listener name: ${input.profile.name}`,
    `Current track: ${JSON.stringify({ title: input.track.title, artist: input.track.artist, album: input.track.album, background: input.track.background })}`,
    `Long-term listener memory: ${JSON.stringify(memorySummary(input.memory))}`,
    `User question: ${input.message}`,
    `Lyric text excerpts: ${lyricContext || "unavailable"}`,
    "First identify one concrete lyric image, one relationship/action, and one emotional contradiction. Use them silently as source material; do not list them.",
    "Do not answer like a summary. Start from the image or action itself, then widen into an interpretation.",
    "Avoid vague safe words unless you make them concrete: 陪伴, 治愈, 共鸣, 温柔, 安全感, 情绪, 日常, 空位, 关系.",
    "Avoid repeating stock Claudio words unless the lyric requires them: 风, 夜, 房间, 光, 慢慢, 静默, 放空, 陪你.",
    "Answer in Chinese, 3-6 short sentences, warm, loose, and conversational, like a DJ talking quietly while the record is still turning.",
    "Base the answer on concrete images from lyric text excerpts when available. Use the user's currently playing lyric window as the most important evidence.",
    "Quote no more than one short phrase. Prefer paraphrase and vivid everyday scenes over abstract summary.",
    "You may make a gentle interpretation, but every sentence must connect back to a lyric image, title, vocal/arrangement feel, or listener context.",
    "Never use textbook frames like 这首歌是在讲, 这首大概在讲, 这首讲的是, 它表达了, 这首在问, 这首里有, 你问到, 对我来说. Start from an image, a feeling, or a small scene.",
    "Also avoid lyric-analysis scaffolding: 这些词放在一起, 它不把..., 反而..., 留着一点体面, 这句话像..., 歌词线索, 说明, 象征.",
    "Shape the answer like a mini radio monologue: start with one room/time image, touch one lyric cue, widen into the listener's life, then land softly.",
    "A good answer may wander a little: connect the lyric to a real-life scene, then come back to the song. It should feel discovered, not prewritten.",
    "If lyrics are unavailable or only credits, say you don't have enough lyrics and explain only from title/artist, without pretending.",
    "Do not invent creation background, interviews, dates, or songwriter intent.",
    "If you are making an inference from lyrics, phrase it as an interpretation rather than a fact about the artist.",
    "Avoid stiff summary words unless you make them specific: 安全感, 陪伴, 治愈, 共鸣, 情绪, 日常, 归属, 空位, 关系.",
    "Do not use stiff phrases: 情绪不是直给, 稳住状态, 把呼吸放稳, 先不用讲太满, 听到哪里算哪里, 模式, 更像在讲.",
    `Avoid listener-blocked phrases: ${JSON.stringify(input.memory?.blockedPhrases ?? [])}`,
    "Mention the song title at most once. Do not sound like literary criticism or a school reading-comprehension answer."
  ].join("\n");

  try {
    const text = await generateJson(env, [
      { role: "system", content: "Return JSON only. Answer song meaning questions carefully from provided lyrics." },
      { role: "user", content: prompt }
    ]);
    if (!text) return fallback;
    const parsed = parseJsonObject<{ say?: string }>(text);
    return cleanSongAnswer(parsed.say, input.profile.name, input.memory?.blockedPhrases) ?? fallback;
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
    "Output fields: intent, tool, query, mood, energy, reason, segue.",
    "Do not write DJ copy here. Do not mention a specific song unless it is part of the query."
  ].join("\n");

  const text = await generateJson(env, [
    { role: "system", content: "You are a JSON-only music planning agent." },
    { role: "user", content: prompt }
  ]);

  if (!text) return heuristicPlan(message, current);
  return { ...heuristicPlan(message, current), ...parseJsonObject<Partial<AgentPlan>>(text) };
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
  const directIndex = bestDirectCandidateIndex(input.candidates, input.message);
  if (directIndex >= 0) {
    return {
      play: input.candidates[directIndex],
      reason: "用户消息和候选歌曲标题/歌手直接匹配。"
    };
  }

  const compactCandidates = input.candidates.slice(0, 12).map((track, index) => ({
    index,
    title: track.title,
    artist: track.artist,
    album: track.album,
    background: track.background,
    source: track.source,
    sourceId: track.sourceId,
    mood: track.mood,
    energy: track.energy
  }));

  const prompt = [
    "You are a private radio DJ selecting one track from candidates.",
    "Return strict JSON only. No markdown.",
    "Output fields: index, reason, segue.",
    `Plan: ${JSON.stringify(input.plan)}`,
    `Routine: ${JSON.stringify(input.routine)}`,
    `Weather/mood context: ${JSON.stringify(input.context)}`,
    `User message: ${input.message}`,
    `Candidates: ${JSON.stringify(compactCandidates)}`,
    "Pick the best candidate.",
    "Only choose the index. Do not write DJ copy. Do not mention any song other than the chosen candidate in reason."
  ].join("\n");

  const text = await generateJson(env, [
    { role: "system", content: "You are a JSON-only track selector." },
    { role: "user", content: prompt }
  ]);

  if (!text) return { play: input.candidates[0] };
  const parsed = parseJsonObject<{ index?: number; say?: string; reason?: string; segue?: string }>(text);
  const index = Number.isInteger(parsed.index) ? Math.min(Math.max(parsed.index ?? 0, 0), input.candidates.length - 1) : 0;

  return {
    play: input.candidates[index],
    reason: parsed.reason,
    segue: parsed.segue
  };
}

function bestDirectCandidateIndex(candidates: Track[], message: string): number {
  const query = normalizeSearchText(message);
  let best = { index: -1, score: 0 };
  candidates.forEach((track, index) => {
    const title = normalizeSearchText(track.title ?? track.name ?? "");
    const artist = normalizeSearchText(track.artist ?? "");
    if (!title) return;
    let score = 0;
    if (query.includes(title)) score += 8;
    if (artist && query.includes(artist)) score += 4;
    if (title.includes(query) && query.length >= 2) score += 3;
    if (score > best.score) best = { index, score };
  });
  return best.score >= 8 ? best.index : -1;
}

function normalizeSearchText(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[《》"'“”‘’\s_-]+/g, "")
    .trim();
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

function parseJsonObject<T>(text: string): T {
  const cleaned = cleanJson(text);
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1)) as T;
    }
    throw new Error("LLM did not return a JSON object.");
  }
}

function safeDjSay(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return undefined;

  return text
    .replace(/Claudio 已上线[。,.，\s]*/g, "")
    .replace(/等完整开场稿生成好[^。！？.!?]*[。！？.!?]?/g, "")
    .replace(/我会补上这首歌的介绍、推荐原因和转场[。！？.!?]?/g, "")
    .replace(/它会先把你的「?[^」]{1,8}」?状态稳住[。！？.!?]?/g, "")
    .replace(/歌词我只抓大方向[:：]\s*/g, "")
    .replace(/今天也别先投降/g, "先别急着给自己下结论")
    .replace(/别跟自己妥协/g, "别急着把话说死")
    .replace(/不是鸡血，?/g, "")
    .replace(/把自己拧得太紧/g, "绷得太紧")
    .replace(/不用马上进入状态/g, "不用一下子切进状态")
    .replace(/能量保持/g, "节奏放在")
    .replace(/名字很有画面感/g, "这个歌名很容易让人停一下")
    .replace(/旋律不用太用力/g, "声音没有往前硬推")
    .replace(/手边的事放顺/g, "手上的事先慢慢来")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanIntroLine(value: unknown, track: Track): string | undefined {
  let text = typeof value === "string" ? value.trim() : "";
  if (!text) return undefined;

  const bad = [
    "当前",
    "模式",
    "早晨启动",
    "稳住状态",
    "把呼吸放稳",
    "先不用讲太满",
    "把场子铺开",
    "这首在讲",
    "这首大概在讲",
    "这首歌是在讲",
    "这首讲的是",
    "我先抓住",
    "我会先抓住",
    "我先听见",
    "这一句",
    "这句像",
    "别急着拆",
    "画面",
    "意义",
    "对我来说",
    "提醒我们",
    "标准答案",
    "交代完整",
    "完整剧情",
    "真正扎人",
    "守护心里",
    "不肯妥协",
    "正好让这旋律",
    "它表达了",
    "不是把",
    "我会补上",
    "完整开场",
    "metadata"
  ];

  if (bad.some((phrase) => phrase && text.includes(phrase))) return undefined;

  text = text
    .replaceAll(`《${track.title}》`, "")
    .replaceAll(track.title, "")
    .replaceAll(track.artist, "")
    .replace(/[《》]/g, "")
    .replace(/^[，。；、\s]+/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text || text.length < 12) return undefined;

  return text
    .replace(/^这首歌?/, "这首")
    .trim();
}

function cleanDjIntro(value: unknown, name: string, track: Track, blockedPhrases: string[] = []): string | undefined {
  let text = typeof value === "string" ? value.trim() : "";
  if (!text) return undefined;

  const fatal = [
    "AI 生成",
    "作为一个",
    "我是一个人工智能",
    "无法理解",
    "不能提供"
  ];
  if (fatal.some((phrase) => text.includes(phrase))) return undefined;

  text = text
    .replace(/\s+/g, " ")
    .replace(/这首歌是在讲/g, "")
    .replace(/这首大概在讲/g, "")
    .replace(/这首在讲/g, "")
    .replace(/这首讲的是/g, "")
    .replace(/对我来说，?/g, "")
    .replace(/提醒我们，?/g, "")
    .replace(/我先抓住/g, "")
    .replace(/我会先抓住/g, "")
    .replace(/我先听见/g, "")
    .replace(/标准答案/g, "")
    .replace(/完整剧情/g, "")
    .replace(/真正扎人/g, "")
    .replace(/稳住状态/g, "")
    .replace(/把呼吸放稳/g, "把肩膀放下来")
    .replace(/先不用讲太满/g, "话不用说满")
    .replace(/这几个字/g, "这个细节")
    .replace(/先听着/g, "")
    .replace(/不急着解释/g, "")
    .replace(/先放/g, "")
    .replace(/慢慢进来/g, "")
    .replace(/接上来/g, "")
    .replace(/从这里进来/g, "")
    .replace(/从旁边进来/g, "")
    .replace(/歌进来/g, "")
    .replace(/声音进来/g, "")
    .replace(/放空一会儿/g, "")
    .replace(/留一点暗/g, "")
    .replace(/灯先暗一点/g, "")
    .replace(/把声音放轻/g, "")
    .replace(/隐秘的啰嗦/g, "")
    .replace(/回忆如风/g, "")
    .replace(/静默/g, "")
    .replace(/这些词放在一起/g, "这些声音靠在一起")
    .replace(/它不把/g, "它没有把")
    .replace(/反而/g, "却")
    .replace(/留着一点体面/g, "留下一点余地")
    .replace(/这句话像/g, "这个瞬间像")
    .replace(/歌词线索/g, "歌词里的影子")
    .replace(/说明/g, "带出")
    .replace(/象征/g, "像")
    .replace(/从音箱边缘慢慢亮起来/g, "")
    .replace(/外面的声音低一点/g, "周围的杂音先退后")
    .replace(/这一段从房间边缘慢慢靠近/g, "")
    .replace(/歌词里有一小块/g, "歌里有一处")
    .trim();

  for (const phrase of blockedPhrases) {
    if (phrase) text = text.split(phrase).join("");
  }

  if (text.length < 24) return undefined;
  if (text.length > 260) text = `${text.slice(0, 250).replace(/[，,；;、\s]+$/, "")}。`;

  if (!text.includes(track.title)) text = `${track.artist}的《${track.title}》。${text}`;

  return text;
}

function memorySummary(memory?: UserMemory): unknown {
  if (!memory) return null;
  return {
    preferences: memory.preferences,
    blockedPhrases: memory.blockedPhrases.slice(0, 24),
    voice: memory.voice,
    recentTracks: memory.recentTracks.slice(0, 8).map((track) => ({
      title: track.title,
      artist: track.artist,
      eventType: track.eventType
    }))
  };
}

function cleanSongAnswer(value: unknown, name: string, blockedPhrases: string[] = []): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return undefined;

  const bad = ["这首歌是在讲", "这首大概在讲", "这首是在讲", "这首讲的是", "这首在讲", "这首在问", "这首里有", "它表达了", "对我来说", "提醒我们", "我先抓住", "我会先抓住", "我先听见", "这一句", "这句像", "别急着拆", "画面", "意义", "标准答案", "交代完整", "完整剧情", "真正扎人", "守护心里", "正好让这旋律", "情绪不是直给", "稳住状态", "把呼吸放稳", "先不用讲太满", "听到哪里算哪里", "模式", "更像在讲", "不是把", "这些词放在一起", "它不把", "反而", "留着一点体面", "这句话像", "歌词线索", "说明", "象征"];
  if ([...bad, ...blockedPhrases].some((phrase) => phrase && text.includes(phrase))) return undefined;

  return text.startsWith(name) ? text : `${name}，${text}`;
}

function lyricBasedAnswer(track: Track, lyricContext: string): string {
  if (/平淡日子|简单的满足|归宿|温度/.test(lyricContext)) {
    return "“归宿”和“温度”都很小，像深夜回家还有一盏灯没关。人走累了，想要的可能就是这么具体的一点点。";
  }
  if (/葡萄|熟透|静候|失收|醇酒|酿成/.test(lyricContext)) {
    return "葡萄和醇酒一出来，时间就慢下来了。有些事当下说不清，只能让它自己变酸、变甜，最后变成心里知道的分寸。";
  }
  if (/当你孤单你会想起谁|想起谁/.test(lyricContext)) {
    return "This is Claudio。夜色往下落的时候，人会先想起一个名字，不一定要拨出去，只是让它在心里亮一下。这里的孤单不是空房间，是电话握在手里，屏幕还没亮。";
  }
  if (/世界不一样|让我不一样|坚持对我来说|刚克刚|倔强/.test(lyricContext)) {
    return "“和世界不一样”那一下，像一个人把外套拉紧，还是往前走。它不劝你赢谁，只是把那点没被揉平的自己，轻轻扶了一下。";
  }
  if (/成长变成了|我的隔阂|自由放空|突然就变失落|懂我的梦|彻底放松|回忆组成风|欲望组成梦|镜中/.test(lyricContext)) {
    return "This is Claudio。房间忽然空出一块，人站在镜子前，会听见自己和自己之间隔着风。别急着把它说清楚，让那阵风先经过，看看它愿不愿意把你带回身体里。";
  }
  if (/一样的月光|沉默的对话|陌生的脸孔|一样的笑容/.test(lyricContext)) {
    return "月光还在，可人和人之间的距离已经变了。“沉默的对话”很准，有些关系不是突然断掉，是慢慢没法好好说话。";
  }
  if (/凤凰|路口|青春|朋友|告别|远方/.test(lyricContext)) {
    return "This is Claudio。你站在一个很亮的路口，风从校门那边吹过来，大家都还没学会好好告别。远方不是答案，只是有人已经把背包背上了；这首歌留给你的，是挥手之后那几秒安静。";
  }
  if (/疲倦|深夜|失落|痛楚/.test(lyricContext)) {
    return "疲惫、深夜、失落这些词贴得很近，像灯已经暗了，人还没舍得睡。它没有催你立刻好起来，只是在那些时刻里，给自己找个能撑一下的边。";
  }

  return lyricContext
    ? buildGenericLyricAnswer(track, lyricContext)
    : "This is Claudio。歌词还没完全到我手里，我就不替它编秘密。标题、声音、房间里的回响先靠近一点；如果有一句真的浮上来，我们再往里走。";
}

function buildGenericLyricAnswer(track: Track, lyricContext: string): string {
  const lines = lyricContext
    .split("/")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line, index, array) => array.indexOf(line) === index)
    .slice(0, 8);
  const anchor = pickHumanAnchorLine(lines, track.title);
  if (anchor) {
    return `This is Claudio。房间安静一秒。${anchor.slice(0, 18)}，这一点声音落下来，不需要变成答案，只是在心里亮了一下。`;
  }
  return "This is Claudio。歌词还没有完全亮起来，我就不替它编故事了。声音先靠近房间，等真正的句子浮上来，我们再一起往里走。";
}

function pickHumanAnchorLine(lines: string[], title = ""): string {
  const bad = /^(作词|作曲|编曲|制作|OP|SP|ISRC|版权所有|未经许可|©)/i;
  const candidates = lines
    .map((line) => line.trim())
    .filter((line) => line.length >= 4 && line.length <= 24)
    .filter((line) => !bad.test(line))
    .filter((line) => line !== title);
  return candidates.find((line) => /我|你|梦|风|雨|夜|光|海|天亮|世界|孤单|沉默|温度|归宿/.test(line)) ?? candidates[0] ?? "";
}

function isTrackQuestion(message: string): boolean {
  return /(这首|这歌|这首歌|当前|正在放).*(讲什么|讲的什么|讲的是啥|什么意思|啥意思|唱什么|说什么|歌词|背景|介绍|含义|表达)|讲什么的|讲的什么|讲的是啥|啥意思|什么意思|介绍一下这首|解释一下/i.test(message);
}

function buildIntroFallback(
  name: string,
  track: Track,
  lyricContext: string,
  message: string,
  mode: "opening" | "recommend" | "handoff",
  previousTrack?: Track | null
): string {
  if (mode === "handoff") {
    const previous = previousTrack?.title ? `《${previousTrack.title}》留下的情绪还在` : "上一首留下的情绪还在";
    return `${previous}，不用急着换一种心情。接下来是${track.artist}的《${track.title}》。${humanTrackLine(track, lyricContext, message, mode)}`;
  }
  return `This is Claudio。${openingScene(message)}${track.artist}的《${track.title}》。${humanTrackLine(track, lyricContext, message, mode)}`;
}

function openingScene(message: string): string {
  if (/夜|晚|睡|安静|失眠/.test(message)) return "夜往下沉，灯不用开得太亮。";
  if (/累|疲|困|烦|崩|撑不住|压力|难受|低落/.test(message)) return "今天已经够长了，别急着把自己收拾好。";
  if (/专注|工作|学习|代码|内容|写|做事/.test(message)) return "桌面先留一点静，键盘声往后退半步。";
  return "这里先留一点空。";
}

function humanTrackLine(track: Track, lyricContext: string, message: string, mode: "opening" | "recommend" | "handoff"): string {
  const tired = /累|疲|困|烦|崩|撑不住|压力|难受|低落/.test(message);
  const focus = /专注|工作|学习|代码|内容|写|做事/.test(message);

  if (lyricContext) {
    return introFromLyricImage(track, lyricContext, message);
  }

  if (track.artist.includes("五月天") && track.title.includes("温柔")) {
    return "把灯留暗一点。风吹过来的时候，人不一定要马上回答谁；有些温柔，是终于允许自己慢慢软下来。";
  }
  if (track.artist.includes("五月天") && track.title.includes("倔强")) {
    return "借它一点硬气。不是冲出去赢谁，是把心里还亮着的那块地方留住；鼓点起来以后，你跟着往前走就好。";
  }
  if (track.artist.includes("陈粒") && track.title.includes("空空")) {
    return "陈粒的声音一进来，房间会空出一点位置。风、梦、回忆都不用落地，就让它们在你旁边绕一圈。";
  }
  if (track.artist.includes("周传雄") && track.title.includes("青花")) {
    return "像一封没寄出去的信，纸边还有一点凉。风从旧事里穿过去，不催人回头，只把没说完的地方轻轻吹亮。";
  }
  if (track.artist.includes("陈奕迅") && track.title.includes("稳稳的幸福")) {
    return "它要的不是很大的光，是一只手伸出去时，真的能碰到一点温度。今天先不赶路，慢慢走到那盏灯下面。";
  }

  if (track.title.includes("冬天的秘密")) {
    return "它不是热闹的歌，像一句话在嘴边停住；今天累的话，就让那点冷意轻轻放着。";
  }
  if (track.title.includes("凤凰花开的路口")) {
    return "它有告别的颜色，但不沉；像把心里的杂音擦掉一点，再继续往前走。";
  }
  if (track.title.includes("特别的人")) {
    return "它温柔得很直接，适合在累的时候听；不用提劲，只是给心里留一盏小灯。";
  }
  if (/不喜欢|过了今天|算了|再见|别/.test(track.title)) {
    return "这个歌名像一句逞强的话，但歌不用跟着逞强；累的时候让它开一扇小门，情绪有个出口就好。";
  }

  if (track.background) {
    return `${track.background.slice(0, 58)}。让这个细节在耳边留一会儿，再把歌往里放。`;
  }
  if (tired) {
    return "今天累的话，我不放太亮的东西；让耳朵有个落点，让肩膀也有地方落下来。";
  }
  if (focus) {
    return "这首不抢人，适合低一点音量放着；让注意力有个边界，手上的事慢慢往前推。";
  }
  return mode === "recommend"
    ? "这一首放在这里，像把窗开一条小缝；你听一小段，如果风向对，我再往旁边接。"
    : mode === "handoff"
      ? "别急着把情绪切断，让新的一层空气慢慢盖上来。"
      : "声音放低一点，让它在房间里陪你走一小段。";
}

function introTail(message: string): string {
  if (/累|疲|困|烦|崩|撑不住|压力|难受|低落/.test(message)) {
    return "今天累的话，先别跟自己较劲，让它陪你缓一口气。";
  }
  if (/专注|工作|学习|代码|内容|写|做事/.test(message)) {
    return "它不太抢人，适合放在旁边，给注意力留一点边界。";
  }
  return "我把它接上。你听一小段，我们再看往哪里走。";
}

function lyricBasedIntro(track: Track, lyricContext: string, message: string): string {
  const base = lyricBasedAnswer(track, lyricContext);
  if (/累|疲|困|烦|崩|撑不住|压力|难受|低落/.test(message)) {
    return `${base} 今天累的话，不用把自己拉起来，那点情绪有地方放就好。`;
  }
  if (/专注|工作|学习|代码|内容|写|做事/.test(message)) {
    return `${base} 它不抢人，适合低一点音量放着，让注意力慢慢回到手边。`;
  }
  return base;
}

function introFromLyricImage(track: Track, lyricContext: string, message: string): string {
  const lines = lyricContext
    .split("/")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line, index, array) => array.indexOf(line) === index);
  const anchor = pickHumanAnchorLine(lines, track.title);
  const tired = /累|疲|困|烦|崩|撑不住|压力|难受|低落/.test(message);
  const focus = /专注|工作|学习|代码|内容|写|做事/.test(message);

  if (/世界不一样|让我不一样|倔强|刚克刚/.test(lyricContext)) {
    return "借它一点硬气吧。不是要你冲出去赢谁，只是别把自己心里那块还亮着的地方交出去。";
  }
  if (/天亮|积雪|肩膀|看海|照片/.test(lyricContext)) {
    return "冷了一夜的东西，会在天亮前慢慢松开。歌里那一点肩膀和远处的海，像有人把外套往你这边挪了一寸。";
  }
  if (/没有星星|星星|夜空|不懂/.test(lyricContext)) {
    return "夜空没有替谁作证，那些没被接住的话就收回来一点。别再递得太远了，让声音替你把门轻轻合上。";
  }
  if (/明天过后|明天|以后|星星|夜空/.test(lyricContext)) {
    return "明天还没到，夜色也没有完全退。歌往前走的时候，会把窗边那点光留出来，不催你马上看清。";
  }
  if (/青春|颜色|岁月|年少|时光|飞逝|年少轻狂|疲惫/.test(lyricContext)) {
    return "多年以后再回头，青春不一定还发亮，倒像一张晒旧的照片。追过的人、冷过的夜、那点疲惫，都被时间磨成另一种颜色。";
  }
  if (/离散|错过|失落|眼泪|苦涩|沉默/.test(lyricContext)) {
    return "散场后的空会慢半拍才到。那些说不出口的东西先别推走，让它们跟着鼓点和尾音，一点点落下来。";
  }
  if (/路口|远方|朋友|再见|告别|挥手/.test(lyricContext)) {
    return "像站在路口，大家还在笑，风已经往远处吹。告别没有压下来，只是从背后轻轻推人一步。";
  }
  if (anchor && tired) {
    return "今天已经够长了。没说完的东西留在门口，等声音走过去，它会替你站一会儿。";
  }
  if (anchor && focus) {
    return "它不抢你手上的事，只在旁边留一条窄窄的光。让旋律低一点，注意力继续往前走。";
  }
  if (anchor) {
    return "话留短一点。让旋律往前走，意思会自己从缝里透出来。";
  }
  return "先留一点空。歌进来的时候，我们少说两句。";
}

function trackSegue(track: Track | null, routine: Routine): string {
  if (!track) return "等一首能播放的歌。";
  return `《${track.title}》进来，能量放在 ${routine.energy}/10 左右。`;
}

function isOpeningRequest(message: string): boolean {
  return /(\u5f00\u53f0|\u5f00\u59cb|\u5b89\u6392|start|opening|radio)/i.test(String(message || ""));
}

function richDjReply(profile: TasteProfile, routine: Routine, track: Track | null, context: MoodContext, lyricContext = ""): DjReply {
  const mood = context.mood ?? routine.mood;
  const timeHint = routine.label.includes("早") ? "早上" : routine.label.includes("午") ? "午后" : routine.label.includes("夜") ? "晚上" : "现在";

  if (!track) {
    return {
      say: `${profile.name}，歌单还没准备好。我先不硬切音乐，等能播的歌出来，再给你挑一首适合${timeHint}听的。`,
      play: null,
      reason: "No playable track is available yet.",
      segue: "等待歌单导入。",
      context,
      intent: "play"
    };
  }

  return {
    say: `This is Claudio。${timeHint}的声音低一点。${track.artist}的《${track.title}》。${fallbackTexture(track, lyricContext, timeHint)}`,
    play: track,
    reason: `根据时段「${routine.label}」、心情「${mood}」和当前歌单选择。`,
    segue: `从《${track.title}》进入，保持 ${routine.energy}/10 左右的能量。`,
    context,
    intent: "play"
};
}

function fallbackTexture(track: Track, lyricContext: string, timeHint: string): string {
  if (track.background) {
    return `${track.background.slice(0, 70)}。这个细节留在耳边，歌就有了入口。`;
  }

  if (track.title.includes("他不懂")) {
    return "不用硬解，光这个名字就够了：有些话说给不懂的人，会越说越累。让它在旁边放着，别让情绪抢走整个早上。";
  }
  if (track.title.includes("冬天的秘密")) {
    return "它不热闹，像一句话到了嘴边又收回去。放在现在听，会有一点冷，但不刺。";
  }
  if (track.title.includes("凤凰花开的路口")) {
    return "毕业和告别的颜色在里面，但林志炫唱得很干净，不会把情绪压得太重。早上听它，像把心里的杂音擦掉一点。";
  }
  if (track.title.includes("当你孤单你会想起谁")) {
    return "它很直接，但不吵；问的是孤单时第一个浮上来的人。这个问题轻轻放着，不用马上回答。";
  }
  if (lyricContext) {
    return `${timeHint}让声音低一点进来。鼓点、句尾和留白会把房间慢慢打开。`;
  }

  return `${timeHint}不讲大道理，就听声音和节奏。合适的话，我们再顺着这首往下接。`;
}

async function getLyricContext(env: Env, track: Track | null, maxLines = 12): Promise<string> {
  if (!track?.sourceId || track.source !== "netease") return "";

  try {
    const data = await getNeteaseLyric(env, track.sourceId);
    const lyric = extractLyricText(data);
    return lyricLines(lyric).slice(0, maxLines).join(" / ").slice(0, maxLines > 12 ? 1400 : 520);
  } catch {
    return "";
  }
}

function extractLyricText(data: unknown): string {
  const value = data as {
    lrc?: { lyric?: string };
    yrc?: { lyric?: string };
    klyric?: { lyric?: string };
    tlyric?: { lyric?: string };
    body?: {
      lrc?: { lyric?: string };
      yrc?: { lyric?: string };
      klyric?: { lyric?: string };
      tlyric?: { lyric?: string };
    };
  };
  const candidates = [
    value.lrc?.lyric,
    value.body?.lrc?.lyric,
    value.yrc?.lyric,
    value.body?.yrc?.lyric,
    value.klyric?.lyric,
    value.body?.klyric?.lyric,
    value.tlyric?.lyric,
    value.body?.tlyric?.lyric
  ].filter(Boolean) as string[];

  return candidates.sort((left, right) => lyricLines(right).length - lyricLines(left).length)[0] ?? "";
}

function lyricLines(lyric: string): string[] {
  const seen = new Set<string>();
  return lyric
    .split("\n")
    .map((line) => line.replace(/\[[^\]]+\]/g, "").replace(/\(\d+,\d+(?:,\d+)?\)/g, "").trim())
    .filter((line) => line && !isLyricCreditLine(line))
    .filter((line) => !/^啦+$/.test(line.replace(/\s/g, "")))
    .filter((line) => line.length > 1)
    .filter((line) => {
      const key = line.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function isLyricCreditLine(line: string): boolean {
  return /^(作词|作曲|编曲|制作人|制作|统筹|鼓|贝斯|吉他|键盘|弦乐|人声|器乐|录音|音频编辑|混音|母带|监制|OP|SP|ISRC|出品|版权所有|未经许可|©|Lyrics|Composed|Produced|Arranged|Drums|Bass|Guitars|Keyboard|Strings|Recorded|Edited|Mixed|Mastered)(\s|[:：/]|by\b|[A-Z]{2}-|，|,|$)/i.test(line);
}

async function resolvePlayableMetadata(env: Env, track: Track | null | undefined): Promise<Track | null> {
  if (!track) return null;
  if (track.url || (track.source === "netease" && track.sourceId)) return track;

  const matches = await searchNetease(env, `${track.title} ${track.artist}`);
  const best = matches[0];
  if (!best?.sourceId) return track;

  return {
    ...track,
    ...best,
    title: best.title || track.title,
    name: best.name || track.name || best.title || track.title,
    artist: best.artist || track.artist,
    background: track.background,
    cover: best.cover || track.cover,
    source: "netease",
    sourceId: best.sourceId,
    externalUrl: best.externalUrl,
    playable: false,
    cached: false
  };
}

async function resolvePlayableTrack(env: Env, track: Track | null | undefined, options: { requireLyrics?: boolean } = {}): Promise<Track | null> {
  const resolved = await resolvePlayableMetadata(env, track);
  if (!resolved) return null;
  if (resolved.url) {
    if (options.requireLyrics && !(await hasUsableLyricContext(env, resolved))) return null;
    return { ...resolved, playable: true };
  }
  if (resolved.source !== "netease" || !resolved.sourceId) return null;

  try {
    const result = await getNeteaseUrl(env, resolved.sourceId);
    if (!result.url) return null;
    if (options.requireLyrics && !(await hasUsableLyricContext(env, resolved))) return null;
    return {
      ...resolved,
      url: result.url,
      playable: true,
      cached: false
    };
  } catch {
    return null;
  }
}

async function firstPlayableTrack(env: Env, tracks: Track[], options: { requireLyrics?: boolean } = {}): Promise<Track | null> {
  for (const track of tracks) {
    const playable = await resolvePlayableTrack(env, track, options);
    if (playable) return playable;
  }
  return null;
}

async function hasUsableLyricContext(env: Env, track: Track): Promise<boolean> {
  const lyricContext = await getLyricContext(env, track, 8);
  return lyricContext.split("/").map((line) => line.trim()).filter(Boolean).length >= 2;
}

function wantsTrackChangeStable(message: string): boolean {
  const text = String(message || "").trim();
  if (!text) return false;
  return /(开台|开始|安排|播放|放(歌|音乐)?|来一首|换(一首)?|下一首|跳过|推荐|找歌|搜歌|点歌|similar|like this|new|discover|recommend|play|song|music)/i.test(text);
}

function wantsTrackChange(message: string): boolean {
  const text = String(message || "").trim();
  if (!text) return false;
  return /(\u5f00\u53f0|\u5f00\u59cb|\u5b89\u6392|\u64ad\u653e|\u653e\u6b4c|\u653e\u97f3\u4e50|\u6765\u4e00\u9996|\u6362\u4e00\u9996|\u4e0b\u4e00\u9996|\u8df3\u8fc7|\u63a8\u8350|\u627e\u6b4c|\u641c\u6b4c|\u70b9\u6b4c|similar|like this|new|discover|recommend|play|song|music)/i.test(text);
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
