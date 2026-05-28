import type { MoodContext, Routine, TasteProfile, Track } from "./types";

export const defaultProfile: TasteProfile = {
  name: "你",
  language: "zh",
  favoriteMoods: ["清醒", "松弛", "专注"],
  blockedArtists: [],
  routines: [
    { label: "早晨启动", start: "07:00", end: "09:30", mood: "清醒", energy: 7 },
    { label: "午后专注", start: "13:30", end: "17:30", mood: "专注", energy: 5 },
    { label: "夜间降噪", start: "21:30", end: "23:59", mood: "松弛", energy: 3 }
  ],
  playlists: [
    {
      id: "demo-1",
      title: "Awake",
      artist: "Tycho",
      url: "https://cdn.jsdelivr.net/gh/mdn/webaudio-examples/audio-basics/outfoxing.mp3",
      cover: "https://images.unsplash.com/photo-1493246507139-91e8fad9978e?auto=format&fit=crop&w=800&q=80",
      mood: ["清醒", "专注"],
      energy: 6,
      source: "demo"
    },
    {
      id: "demo-2",
      title: "Night Drive",
      artist: "Private Library",
      url: "https://cdn.jsdelivr.net/gh/mdn/webaudio-examples/audio-basics/techno.wav",
      cover: "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=800&q=80",
      mood: ["松弛", "夜晚"],
      energy: 4,
      source: "demo"
    }
  ]
};

export function pickRoutine(profile: TasteProfile, now = new Date()): Routine {
  const current = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  return profile.routines.find((routine) => current >= routine.start && current <= routine.end) ?? profile.routines[0];
}

export function chooseTrack(profile: TasteProfile, routine: Routine, seed = Date.now(), context: MoodContext = {}): Track | null {
  const weatherMood = weatherToMood(context.weather?.condition);
  const desiredMoods = [context.mood, weatherMood, routine.mood, ...profile.favoriteMoods].filter(Boolean) as string[];
  const candidates = profile.playlists.filter((track) => {
    const allowedArtist = !profile.blockedArtists.some((artist) => track.artist.toLowerCase().includes(artist.toLowerCase()));
    const moodFit = !track.mood?.length || track.mood.some((mood) => desiredMoods.includes(mood));
    return allowedArtist && moodFit;
  });

  const pool = candidates.length ? candidates : profile.playlists;
  if (!pool.length) return null;

  return pool[Math.abs(seed) % pool.length];
}

export function fallbackDjReply(profile: TasteProfile, routine: Routine, track: Track | null, context: MoodContext = {}) {
  const weather = context.weather?.condition ? `${context.weather.city ?? "这里"}${context.weather.condition}` : "今天的气压";
  const mood = context.mood ? `你说现在是「${context.mood}」` : `我按「${routine.mood}」来`;
  const title = track ? `接下来放 ${track.artist} 的《${track.title}》` : "现在还没有可播放的歌";
  return {
    say: `${profile.name}，${routine.label}开始。${weather}，${mood}。${title}，先把呼吸放稳。`,
    play: track,
    reason: `根据时段「${routine.label}」、天气「${context.weather?.condition ?? "未知"}」和心情「${context.mood ?? routine.mood}」选择。`,
    segue: track ? `从${context.mood ?? routine.mood}切入，能量保持在 ${routine.energy}/10。` : "先导入你的私人歌单，我再开始编排。",
    context
  };
}

function weatherToMood(condition = ""): string | undefined {
  if (/雨|雷|雪|雾|霾|drizzle|rain|storm|snow|fog/i.test(condition)) return "松弛";
  if (/晴|clear|sun/i.test(condition)) return "清醒";
  if (/云|阴|cloud|overcast/i.test(condition)) return "专注";
  return undefined;
}
