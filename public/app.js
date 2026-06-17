const MOODS = {
  awake: "\u6e05\u9192",
  focus: "\u4e13\u6ce8",
  calm: "\u677e\u5f1b",
  night: "\u591c\u665a"
};

const state = {
  profile: null,
  reply: null,
  currentTrack: null,
  audioTrack: null,
  mood: MOODS.focus,
  weather: null,
  plan: [],
  lyrics: [],
  lyricsTrackKey: "",
  playingTrackKey: "",
  playSessionId: 0,
  lyricRequestId: 0,
  lyricOffset: 0,
  speakingSessionId: 0,
  lyricActiveIndex: -1,
  djText: "",
  transcriptMode: "dj",
  introducedTrackId: null,
  speakingStartedAt: 0,
  speakingTimer: null,
  lyricClock: null,
  autoSkipping: false,
  autoAdvancing: false,
  transportBusy: false,
  transportStartedAt: 0,
  playbackBusy: false,
  speakingBusy: false,
  openingPromise: null,
  openingReadyTrackKey: "",
  openingStartedAt: 0,
  introRequestId: 0,
  lastNextClickAt: 0,
  lastAutoAdvancedKey: "",
  endAdvanceCheckKey: "",
  pendingPreviousTrack: null,
  recentTrackKeys: [],
  lastTranscriptWheelAt: 0,
  volumeRamp: null,
  ttsAudio: null,
  ttsSource: null,
  lastDjBubbleText: "",
  baseVolume: 0.72
};

const lyricCache = new Map();
const rejectedTrackKeys = new Set();
const ttsAudioCache = new Map();

const els = {
  clock: document.querySelector("#clock"),
  weekday: document.querySelector("#weekday"),
  dateLine: document.querySelector("#dateLine"),
  title: document.querySelector("#trackTitle"),
  meta: document.querySelector("#trackMeta"),
  player: document.querySelector("#player"),
  playBtn: document.querySelector("#playBtn"),
  nextBtn: document.querySelector("#nextBtn"),
  voiceBtn: document.querySelector("#voiceBtn"),
  broadcastCard: document.querySelector("#broadcastCard"),
  broadcastTitle: document.querySelector("#broadcastTitle"),
  broadcastMeta: document.querySelector("#broadcastMeta"),
  broadcastPlay: document.querySelector("#broadcastPlay"),
  broadcastDuration: document.querySelector("#broadcastDuration"),
  speakTimer: document.querySelector("#speakTimer"),
  speakState: document.querySelector("#speakState"),
  transcript: document.querySelector("#transcript"),
  progress: document.querySelector("#progressBar"),
  form: document.querySelector("#chatForm"),
  message: document.querySelector("#message"),
  chat: document.querySelector("#chat"),
  clearChat: document.querySelector("#clearChat"),
  plan: document.querySelector("#plan"),
  queueCount: document.querySelector("#queueCount"),
  weatherLine: document.querySelector("#weatherLine"),
  profileDialog: document.querySelector("#profileDialog"),
  profileName: document.querySelector("#profileName"),
  moods: document.querySelector("#moods"),
  neteaseStatus: document.querySelector("#neteaseStatus"),
  loadNetease: document.querySelector("#loadNetease"),
  neteasePlaylists: document.querySelector("#neteasePlaylists"),
  playlistJson: document.querySelector("#playlistJson"),
  resolveNetease: document.querySelector("#resolveNetease"),
  saveProfile: document.querySelector("#saveProfile")
};

let ttsContext = null;
let ttsUnlocked = false;
const TTS_SETTINGS_VERSION = "minimax-friendly-person-v1";

window.__aiDjState = () => {
  recoverPlaybackBinding();
  updateLyricHighlight();
  return {
    replyTrack: state.reply?.play ? pickTrackDebug(state.reply.play) : null,
    currentTrack: state.currentTrack ? pickTrackDebug(state.currentTrack) : null,
    audioTrack: state.audioTrack ? pickTrackDebug(state.audioTrack) : null,
    playingTrackKey: state.playingTrackKey,
    audioDatasetTrackKey: els.player.dataset.trackKey || "",
    audioSrc: els.player.currentSrc || els.player.src || "",
    audioDuration: Number.isFinite(els.player.duration) ? els.player.duration : null,
    lyricsTrackKey: state.lyricsTrackKey,
    lyricActiveIndex: state.lyricActiveIndex,
    lyricContext: currentLyricContext(),
    activeLyric: state.lyrics[state.lyricActiveIndex] ?? null,
    lastLyric: state.lyrics[state.lyrics.length - 1] ?? null,
    lyricOffset: state.lyricOffset,
    ended: els.player.ended,
    autoAdvancing: state.autoAdvancing,
    lastAutoAdvancedKey: state.lastAutoAdvancedKey,
    recentTrackKeys: [...state.recentTrackKeys],
    paused: els.player.paused,
    currentTime: els.player.currentTime,
    lyricClockTime: els.player.currentTime + state.lyricOffset,
    remoteTts: localStorage.getItem("aiDjRemoteTts") !== "0",
    ttsVoice: localStorage.getItem("aiDjTtsVoice") || "Friendly_Person"
  };
};

window.__setLyricOffset = (seconds) => {
  state.lyricOffset = Number(seconds) || 0;
  const key = state.playingTrackKey || trackKey(state.currentTrack) || trackKey(state.reply?.play);
  if (key) localStorage.setItem(lyricOffsetStorageKey(key), String(state.lyricOffset));
  updateLyricHighlight();
  if (state.transcriptMode === "lyrics") renderLyrics();
  return window.__aiDjState();
};

window.__useRemoteTts = (enabled) => {
  localStorage.setItem("aiDjRemoteTts", enabled ? "1" : "0");
  return { remoteTts: enabled ? "on" : "off" };
};

window.__setTtsVoice = (voiceId) => {
  const value = String(voiceId || "").trim();
  if (value) localStorage.setItem("aiDjTtsVoice", value);
  else localStorage.removeItem("aiDjTtsVoice");
  api("/api/memory/voice", { method: "POST", body: { voiceId: value || "Friendly_Person" } }).catch(() => {});
  return { voice: localStorage.getItem("aiDjTtsVoice") || "server default" };
};

window.__testTtsVoice = async (voiceId, text = "YANG，晚上好。This is Claudio。灯暗一点，我在这里。") => {
  if (voiceId) window.__setTtsVoice(voiceId);
  await unlockTts();
  await playRemoteTts(normalizeTtsText(text), localStorage.getItem("aiDjTtsVoice") || undefined);
  return { voice: localStorage.getItem("aiDjTtsVoice") || "server default" };
};

await boot();

async function boot() {
  if (localStorage.getItem("aiDjTtsSettingsVersion") !== TTS_SETTINGS_VERSION) {
    localStorage.setItem("aiDjRemoteTts", "1");
    localStorage.setItem("aiDjTtsVoice", "Friendly_Person");
    localStorage.setItem("aiDjTtsSettingsVersion", TTS_SETTINGS_VERSION);
  } else if (localStorage.getItem("aiDjRemoteTts") === null) {
    localStorage.setItem("aiDjRemoteTts", "1");
  }
  if (!localStorage.getItem("aiDjTtsVoice")) {
    localStorage.setItem("aiDjTtsVoice", "Friendly_Person");
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  tick();
  setInterval(tick, 1000);

  try {
    state.profile = await api("/api/taste");
  } catch (error) {
    els.title.textContent = "Offline";
    els.meta.textContent = "PROFILE ERROR";
    pushDj(`Taste file load failed: ${error.message}`);
    return;
  }

  hydrateProfile();
  await hydrateMemorySettings();
  setupEvents();
  await hydrateChatHistory();
  renderOpeningShell();
  updatePlaybackButtons();
  state.openingPromise = prewarmOpening();
}

async function hydrateMemorySettings() {
  try {
    const memory = await api("/api/memory");
    if (memory?.voice?.voiceId) localStorage.setItem("aiDjTtsVoice", memory.voice.voiceId);
  } catch {
    // Memory is an enhancement; the player can run without it.
  }
}

function setupEvents() {
  // Unlock audio for TTS playback (required by some browsers) after the first user gesture.
  window.addEventListener(
    "pointerdown",
    () => {
      unlockTts().catch(() => {});
    },
    { once: true, passive: true }
  );

  els.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = els.message.value.trim();
    if (!message) return;
    els.message.value = "";
    pushUser(message);
    if (wantsMusicChange(message)) {
      invalidateOpeningPrewarm();
      setTransportBusy(true, "...");
      try {
        if (!await forceLocalNextTrack({ reason: "chat-immediate" })) {
          await playRecommendedNext({ reason: "chat", userMessage: message });
        }
      } catch (error) {
        console.error("[ai-dj] chat music handoff failed", error);
        if (!await forceLocalNextTrack({ reason: "chat-fallback" })) {
          pushDj("我这边切歌慢了一拍，先别断线。你再点一次，我会直接从歌单里跳过去。");
        }
      } finally {
        setTransportBusy(false);
      }
      return;
    }
    try {
      const reply = await withTimeout(askWithOptions(message, { shouldPush: false }), 65000);
      renderReply(reply, true, { autoPlay: false });
    } catch (error) {
      console.error("[ai-dj] chat failed", error);
      pushDj("大模型刚才没接稳，但我还在。你再问一遍，我继续接着这首歌聊。", true);
    }
  });

  document.querySelectorAll("[data-mood]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.mood = button.dataset.mood;
      document.querySelectorAll("[data-mood]").forEach((item) => item.classList.toggle("active", item === button));
      els.weatherLine.textContent = weatherText();
      await refreshPlan();
      renderReply(await ask(`\u6211\u73b0\u5728\u60f3\u8981${state.mood}\u4e00\u70b9`, false), true, { autoPlay: false });
    });
  });
  document.querySelector(`[data-mood="${MOODS.focus}"]`)?.classList.add("active");

  els.playBtn.addEventListener("click", togglePlayback);
  els.broadcastPlay.addEventListener("click", togglePlayback);
  els.nextBtn.addEventListener("click", (event) => {
    event.preventDefault();
    triggerNextTrack("button-click");
  });
  els.voiceBtn.addEventListener("click", async () => {
    if (state.speakingBusy) return;
    state.speakingBusy = true;
    els.voiceBtn.disabled = true;
    els.voiceBtn.textContent = "...";
    try {
      await playDjIntro({ resumeMusic: !els.player.paused, mode: "manual" });
    } finally {
      state.speakingBusy = false;
      els.voiceBtn.disabled = false;
      els.voiceBtn.textContent = "\u25c9";
    }
  });
  els.clearChat?.addEventListener("click", clearChatHistory);
  document.querySelector(".brand").addEventListener("dblclick", () => els.profileDialog.showModal());
  els.loadNetease.addEventListener("click", loadNeteaseAccount);
  els.resolveNetease.addEventListener("click", resolveNeteasePlaylist);
  els.saveProfile.addEventListener("click", saveProfile);
  els.player.addEventListener("timeupdate", updateProgress);
  els.player.addEventListener("ended", handleTrackEnded);
  els.player.addEventListener("playing", syncCurrentTrackFromAudio);
  els.player.addEventListener("play", updatePlaybackButtons);
  els.player.addEventListener("pause", updatePlaybackButtons);
  els.player.addEventListener("emptied", updatePlaybackButtons);
  els.player.addEventListener("loadedmetadata", () => {
    syncCurrentTrackFromAudio();
    updateBroadcastDuration();
    validateLoadedAudioAgainstLyrics().catch(() => {});
  });
  els.player.addEventListener("emptied", () => {
    window.setTimeout(() => {
      recoverPlaybackBinding();
      if (!els.player.currentSrc && !els.player.src) clearAudioBinding();
    }, 0);
  });
  els.transcript.addEventListener("wheel", releaseTranscriptWheel, { passive: false });
  els.player.addEventListener("error", () => {
    const code = els.player.error?.code;
    pushDj(`\u97f3\u9891\u52a0\u8f7d\u5931\u8d25\uff0c\u53ef\u80fd\u662f\u7f51\u6613\u4e91\u64ad\u653e\u5730\u5740\u8fc7\u671f\u3001\u7248\u6743\u9650\u5236\u6216\u6d4f\u89c8\u5668\u963b\u6b62\u3002error code: ${code ?? "unknown"}`);
    handlePlaybackFailure().catch(() => {});
  });
  document.querySelector(".volume input")?.addEventListener("input", (event) => {
    state.baseVolume = Number(event.target.value);
    if (!els.broadcastCard.classList.contains("speaking")) {
      els.player.volume = state.baseVolume;
    }
  });
  els.player.volume = state.baseVolume;
  state.lyricClock = window.setInterval(() => {
    if (!els.player.paused) updateLyricHighlight();
    maybeAutoAdvanceAtEnd();
  }, 300);
}

async function unlockTts() {
  if (ttsUnlocked) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) {
    ttsUnlocked = true;
    return;
  }
  ttsContext = ttsContext ?? new Ctx();
  if (ttsContext.state === "suspended") {
    await ttsContext.resume();
  }
  // Some browsers need an actual node to start once.
  const buffer = ttsContext.createBuffer(1, 1, 22050);
  const source = ttsContext.createBufferSource();
  source.buffer = buffer;
  source.connect(ttsContext.destination);
  source.start(0);
  ttsUnlocked = true;
}

function wantsMusicChangeLegacy(message) {
  const text = String(message || "").trim();
  if (!text) return false;
  return /(开台|开始|安排|播放|放|来一首|换|下一首|推荐|找|搜|歌|音乐|similar|like this|new|discover|recommend|play|song|music)/i.test(text);
}

function isTrackQuestion(message) {
  const text = String(message || "").trim();
  return /(这首|这歌|这首歌|当前|正在放).*(讲什么|讲的什么|讲的是啥|什么意思|啥意思|唱什么|说什么|歌词|背景|介绍|含义|表达)|讲什么的|讲的什么|讲的是啥|啥意思|什么意思|介绍一下这首|解释一下/i.test(text);
}

function wantsMusicChange(message) {
  const text = String(message || "").trim();
  if (!text) return false;
  if (isTrackQuestion(text)) return false;
  return /(\u5f00\u53f0|\u5f00\u59cb|\u5b89\u6392|\u64ad\u653e|\u653e\u6b4c|\u653e\u97f3\u4e50|\u6765\u4e00\u9996|\u6362\u4e00\u9996|\u6362\u9996|\u6362\u6b4c|\u4e0b\u4e00\u9996|\u8df3\u8fc7|\u63a8\u8350|\u627e\u6b4c|\u641c\u6b4c|\u70b9\u6b4c|similar|like this|new|discover|recommend|play|song|music)/i.test(text);
}

async function prewarmOpening() {
  const requestStartedAt = Date.now();
  state.openingStartedAt = requestStartedAt;
  try {
    await detectWeather();
    await refreshPlan();
  } catch (error) {
    console.info("Startup context skipped:", error.message);
  }

  const prepared = await prepareOpeningIntroForCurrentTrack(requestStartedAt);
  if (prepared) return prepared;
  if (state.reply?.play) return state.reply;

  const reply = await refreshOpening({ silent: false, requestStartedAt });
  if (state.openingStartedAt !== requestStartedAt) return null;
  if (reply?.play) {
    state.openingReadyTrackKey = trackKey(reply.play);
    warmOpeningAssets(reply).catch(() => {});
  }
  return reply;
}

async function prepareOpeningIntroForCurrentTrack(requestStartedAt) {
  let track = state.reply?.play ?? pickStartupTrack();
  if (!track) return null;
  let key = trackKey(track);
  if (!key) return null;

  if (trackKey(state.reply?.play) !== key) {
    renderReply({
      say: "",
      play: track,
      introPending: true,
      reason: "Startup opening is being prepared for the selected track.",
      segue: "Prepare Claudio opening before playback.",
      context: { mood: state.mood, weather: state.weather }
    }, false, { forceRender: true, silent: true });
  } else if (state.reply) {
    state.reply.introPending = true;
    renderBroadcast(state.reply);
  }

  await resolvePlayableUrl(track).catch(() => false);
  if (state.openingStartedAt !== requestStartedAt || trackKey(state.reply?.play) !== key) return null;

  const lyrics = await getParsedLyrics(track).catch(() => []);
  if (!lyrics.length) {
    const alternate = await findNextPlayableTrack(track);
    if (alternate && state.openingStartedAt === requestStartedAt) {
      track = alternate;
      key = trackKey(track);
      renderReply({
        say: "",
        play: track,
        introPending: true,
        reason: "Startup skipped a track without usable lyrics.",
        segue: "Prepare opening with lyrics.",
        context: { mood: state.mood, weather: state.weather }
      }, false, { forceRender: true, silent: true });
      await resolvePlayableUrl(track).catch(() => false);
      await getParsedLyrics(track).catch(() => []);
    }
  }

  if (state.openingStartedAt !== requestStartedAt || trackKey(state.reply?.play) !== key) return null;
  const introRequestId = ++state.introRequestId;
  let say = await ensureIntroTextForTrack(track, { mode: "opening", timeoutMs: 7000, allowFallback: true, fast: true });
  if (!say || introRequestId !== state.introRequestId || state.openingStartedAt !== requestStartedAt || trackKey(state.reply?.play) !== key) return null;
  if (isWeakOpeningIntro(say)) {
    const lines = await lyricPreviewLines(track);
    say = buildOpeningFallback(track, lines, pickAutoAnchorLine(lines, track.title));
  }

  state.reply.say = say;
  state.reply.introPending = false;
  state.openingReadyTrackKey = key;
  renderBroadcast(state.reply);
  warmOpeningAssets(state.reply).catch(() => {});
  return state.reply;
}

async function warmOpeningAssets(reply) {
  const track = reply?.play;
  const key = trackKey(track);
  if (!track || !key || trackKey(state.reply?.play) !== key) return;
  if (!track.url) await resolvePlayableUrl(track);
  if (trackKey(state.reply?.play) !== key) return;
  await getParsedLyrics(track).catch(() => []);
  if (reply.say) prefetchTtsAudio(reply.say).catch(() => {});
  if (trackKey(state.reply?.play) === key) syncPlaybackBindingForReplyTrack(track);
}

async function refreshOpening({ silent = false, requestStartedAt = state.openingStartedAt } = {}) {
  try {
    const reply = await withTimeout(askWithOptions(openingPromptMessage(), { shouldPush: false, persist: false }), 90000);
    if (state.openingStartedAt !== requestStartedAt) return null;
    if (reply?.play && isResolvableTrack(reply.play)) {
      const wasPlaying = !els.player.paused;
      state.introducedTrackId = null;
      renderReply(reply, false, { forceRender: true, silent });
      if (wasPlaying) {
        playDjIntro({ resumeMusic: true, leadInMs: 250, mode: "auto" }).catch(() => {});
      }
      return reply;
    } else if (reply?.say) {
      if (!silent) pushDj(reply.say, false);
      return reply;
    }
  } catch (error) {
    console.info("AI opening skipped:", error.message);
  }
  return null;
}

function openingPromptMessage() {
  const now = new Date();
  const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
  const time = now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  const period = now.getHours() >= 22 ? "late night" : now.getHours() >= 18 ? "evening" : now.getHours() >= 12 ? "afternoon" : "morning";
  return [
    "今天根据天气、心情和歌单开台。",
    `现在是 ${weekday} ${time}, ${period}.`,
    "请先选定一首真正可播放、最好有歌词的歌，再写 Claudio 开场稿。",
    "开场稿要像私人电台，不要像助手总结。"
  ].join("\n");
}

function startupReply() {
  const track = pickStartupTrack();
  const mood = state.mood;
  return {
    say: "",
    play: track,
    introPending: true,
    reason: "Startup shell while Claudio prepares the opening.",
    segue: "Preparing generated opening.",
    context: { mood, weather: state.weather }
  };
}

function renderOpeningShell() {
  const reply = startupReply();
  renderReply(reply, false, { forceRender: true, silent: true });
  if (reply.play) {
    els.speakState.innerHTML = "<span></span> Preparing";
  }
}

function invalidateOpeningPrewarm() {
  state.openingStartedAt = Date.now();
  state.openingPromise = null;
  state.openingReadyTrackKey = "";
}

async function hydrateChatHistory() {
  try {
    const history = await api("/api/chat/history?limit=50");
    const messages = Array.isArray(history?.messages) ? history.messages : [];
    if (!messages.length) return;
    els.chat.innerHTML = "";
    for (const message of messages) renderHistoryMessage(message);
    state.lastDjBubbleText = "";
    maybeScrollToLatest();
  } catch {
    // Chat history is nice to have; live radio should still boot without it.
  }
}

async function clearChatHistory() {
  const ok = window.confirm("\u6e05\u7a7a\u4e4b\u524d\u7684\u804a\u5929\u8bb0\u5f55\uff1f\u6b4c\u5355\u3001\u504f\u597d\u548c\u5f53\u524d\u64ad\u653e\u4e0d\u4f1a\u88ab\u5220\u3002");
  if (!ok) return;
  els.clearChat.disabled = true;
  try {
    await api("/api/chat/history", { method: "DELETE" });
    els.chat.innerHTML = "";
    state.lastDjBubbleText = "";
    pushDj("\u804a\u5929\u8bb0\u5f55\u5df2\u6e05\u7a7a\u3002", true);
  } catch (error) {
    pushDj(`\u6e05\u7a7a\u5931\u8d25\uff1a${error.message}`, true);
  } finally {
    els.clearChat.disabled = false;
  }
}

function localOpeningSay(track) {
  return buildOpeningFallback(track, []);
}

function pickStartupTrack() {
  const tracks = state.profile?.playlists ?? [];
  if (!tracks.length) return null;
  return tracks.find((track) => track.sourceId || track.url) ?? tracks[0];
}

function isResolvableTrack(track) {
  return Boolean(track?.url || (track?.source === "netease" && track?.sourceId));
}

function withTimeout(promise, ms) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timeoutId));
}

async function detectWeather() {
  try {
    const position = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 6000 });
    });
    const { latitude, longitude } = position.coords;
    const weather = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto`
    ).then((response) => response.json());
    const current = weather.current;
    state.weather = {
      city: "\u5f53\u524d\u4f4d\u7f6e",
      temperature: Math.round(current.temperature_2m),
      wind: Math.round(current.wind_speed_10m),
      code: current.weather_code,
      condition: weatherName(current.weather_code)
    };
  } catch {
    state.weather = { city: "\u672a\u5b9a\u4f4d", condition: "\u672a\u77e5\u5929\u6c14" };
  }
  els.weatherLine.textContent = weatherText();
}

async function refreshPlan() {
  const params = new URLSearchParams(contextParams());
  state.plan = await api(`/api/plan/today?${params}`);
  renderPlan();
}

async function ask(message, shouldPush = true, options = {}) {
  return askWithOptions(message, { shouldPush, ...options });
}

async function askWithOptions(message, { shouldPush = true, persist = true } = {}) {
  if (shouldPush) pushUser(message);
  return api("/api/chat", {
    method: "POST",
    body: {
      message,
      persist,
      current: currentReplyForChat(),
      currentLyricContext: currentLyricContext(),
      context: {
        mood: state.mood,
        weather: state.weather
      }
    }
  });
}

function renderReply(reply, shouldScroll = true, options = {}) {
  if (reply.intent === "chat" && state.reply?.play && !options.forceRender) {
    pushDj(reply.say, shouldScroll);
    return;
  }

  state.reply = reply;
  const track = reply.play;
  els.title.textContent = track?.title ?? "No track";
  els.meta.textContent = track ? `${track.artist} - PLAYING` : "WAITING";
  renderBroadcast(reply);

  if (reply.say && !options.silent) pushDj(reply.say, shouldScroll);
  if (track) {
    syncPlaybackBindingForReplyTrack(track);
    if (!options.silent) renderTrackCard(track, shouldScroll);
    if (options.autoPlay) {
      startCurrentTrack({ announce: !options.silent, shouldScroll }).catch(() => {});
    }
  }
}

function syncPlaybackBindingForReplyTrack(track) {
  const nextKey = trackKey(track);
  const boundTrack = audioBoundTrack() ?? state.currentTrack;
  const boundKey = trackKey(boundTrack);
  if (nextKey && boundKey && nextKey !== boundKey) {
    els.player.pause();
    els.player.removeAttribute("src");
    els.player.load();
    clearLyrics(boundKey);
    clearAudioBinding(boundKey);
    updatePlaybackButtons();
  }
  if (track.url) bindAudioTrack(track);
}

function renderBroadcast(reply) {
  const track = reply.play;
  const hasDjCopy = Boolean((reply.say ?? "").trim());
  els.broadcastTitle.textContent = titleForBroadcast(reply);
  els.broadcastMeta.textContent = track ? `${track.title} - ${track.artist}` : "Waiting for track";
  updateBroadcastDuration();
  els.speakTimer.textContent = "0:00";
  els.speakState.innerHTML = reply.introPending ? "<span></span> Writing" : "<span></span> Ready";
  if (hasDjCopy || !reply.introPending) {
    state.djText = reply.say ?? "";
    state.transcriptMode = "dj";
    renderDjTranscript(reply.say);
  }
}

async function togglePlayback() {
  if (!state.reply?.play) return;
  if (state.playbackBusy) return;
  if (isPlayerAtTrackEnd()) {
    triggerNextTrack("ended-play-button");
    return;
  }
  if (els.player.paused) {
    setPlaybackBusy(true);
    try {
      if (canResumeCurrentAudio()) {
        await els.player.play();
        syncCurrentTrackFromAudio();
        updatePlaybackButtons();
      } else {
        await waitForOpeningReady();
        await startCurrentTrack();
      }
    } finally {
      setPlaybackBusy(false);
    }
    return;
  }

  els.player.pause();
  updatePlaybackButtons();
}

function isPlayerAtTrackEnd() {
  const duration = els.player.duration;
  if (!Number.isFinite(duration) || duration < 5) return Boolean(els.player.ended);
  return Boolean(els.player.ended || duration - els.player.currentTime <= 0.35);
}

function canResumeCurrentAudio() {
  if (!(els.player.currentSrc || els.player.src)) return false;
  if (isPlayerAtTrackEnd()) return false;
  const replyKey = trackKey(state.reply?.play);
  const bound = audioBoundTrack() ?? state.currentTrack;
  return Boolean(replyKey && bound && trackKey(bound) === replyKey);
}

function updatePlaybackButtons() {
  if (state.playbackBusy) {
    els.playBtn.textContent = "...";
    els.broadcastPlay.textContent = "...";
    els.playBtn.disabled = true;
    els.broadcastPlay.disabled = true;
    return;
  }
  const label = els.player.paused || !els.player.currentSrc ? ">" : "II";
  els.playBtn.textContent = label;
  els.broadcastPlay.textContent = label;
  els.playBtn.disabled = false;
  els.broadcastPlay.disabled = false;
}

function setPlaybackBusy(active) {
  state.playbackBusy = active;
  updatePlaybackButtons();
}

async function waitForOpeningReady() {
  if (!state.openingPromise) return;
  if (state.reply?.say && trackKey(state.reply.play) === state.openingReadyTrackKey) return;
  await Promise.race([
    state.openingPromise.catch(() => null),
    wait(900)
  ]);
}

function setTransportBusy(active, label = null) {
  state.transportBusy = active;
  state.transportStartedAt = active ? Date.now() : 0;
  els.nextBtn.disabled = false;
  els.nextBtn.setAttribute("aria-busy", active ? "true" : "false");
  if (label) els.nextBtn.textContent = label;
  else els.nextBtn.textContent = ">";
}

async function triggerNextTrack(reason = "button") {
  const now = Date.now();
  if (now - state.lastNextClickAt < 250) return;
  state.lastNextClickAt = now;
  setTransportBusy(true, "...");
  invalidateOpeningPrewarm();
  state.introducedTrackId = null;
  const current = currentPlaybackTrack() ?? state.currentTrack ?? state.reply?.play ?? null;

  try {
    if (await forceLocalNextTrack({ reason, current })) return;
    await withTimeout(playRecommendedNext({ reason, current }), 3000);
  } catch (error) {
    console.error("[ai-dj] next trigger failed", error);
    if (!await forceLocalNextTrack({ reason: `${reason}-fallback`, current })) {
      pushDj("我这边暂时没有抓到下一首能接上的歌。你再点一次，我继续从歌单里找。");
    }
  } finally {
    setTransportBusy(false);
  }
}

async function startCurrentTrack({ announce = true, shouldScroll = true } = {}) {
  const sessionId = ++state.playSessionId;
  const requestedTrack = state.reply?.play;
  if (!requestedTrack) return;

  if (!requestedTrack.url) {
    const resolved = await resolvePlayableUrl(requestedTrack);
    if (!isActivePlaybackSession(sessionId, requestedTrack)) return;
    if (!resolved) {
      const alternate = await findNextPlayableTrack(requestedTrack);
      if (!isActivePlaybackSession(sessionId, requestedTrack)) return;
      if (alternate) {
        renderReply({
          say: `这条播放地址断了一下，我换一首能播的。${alternate.artist}的《${alternate.title}》。`,
          play: alternate,
          reason: "跳过不可播放歌曲。",
          segue: "保持电台不断线。",
          context: { mood: state.mood, weather: state.weather }
        }, true, { forceRender: true });
        await startCurrentTrack({ announce, shouldScroll });
        return;
      }

      pushDj("\u8fd9\u9996\u6b4c\u7f51\u6613\u4e91\u6682\u65f6\u6ca1\u6709\u8fd4\u56de\u53ef\u64ad\u653e\u5730\u5740\uff0c\u53ef\u80fd\u662f\u7248\u6743\u3001\u4f1a\u5458\u6216\u767b\u5f55\u6001\u9650\u5236\u3002");
      return;
    }
  }

  const track = state.reply?.play;
  if (!track || !isActivePlaybackSession(sessionId, track)) return;
  const key = trackKey(track);
  const previousTrack = trackKey(state.reply?.previousTrack) !== trackKey(track)
    ? state.reply?.previousTrack
    : (trackKey(state.pendingPreviousTrack) !== key ? state.pendingPreviousTrack : null);
  const isStationOpening = !state.recentTrackKeys.length && !state.introducedTrackId;
  const lyrics = await getParsedLyrics(track);
  if (!lyrics.length) {
    const alternate = await findNextPlayableTrack(track);
    if (alternate && isActivePlaybackSession(sessionId, track)) {
      renderReply({
        say: `刚才那首没有完整歌词，我不硬放。${alternate.artist}的《${alternate.title}》。这首字幕能跟上。`,
        play: alternate,
        reason: "跳过无歌词歌曲。",
        segue: "保持电台有歌也有词。",
        context: { mood: state.mood, weather: state.weather }
      }, true, { forceRender: true, autoPlay: true });
      return;
    }
    pushDj("这首没有完整歌词，我不硬放。等下一首能把声音和字一起接住。");
    return;
  }
  const lyricLines = lyrics.map((line) => line.text).filter(Boolean);
  const shouldRewriteIntro = !state.reply?.say
    || state.reply.introPending
    || isWeakOpeningIntro(state.reply.say)
    || (!isStationOpening && /\bThis is Claudio\b/i.test(state.reply.say));
  if (state.reply && shouldRewriteIntro) {
    const anchor = pickAutoAnchorLine(lyricLines, track.title);
    const immediateSay = isStationOpening
      ? buildOpeningFallback(track, lyricLines, anchor)
      : buildFollowupFallback(track, lyricLines, anchor, previousTrack);
    state.reply.say = immediateSay;
    state.reply.introPending = false;
    state.djText = immediateSay;
    state.openingReadyTrackKey = key;
    state.introRequestId += 1;
    prefetchTtsAudio(immediateSay).catch(() => {});
  }
  state.lyrics = lyrics;
  state.lyricsTrackKey = key;
  state.lyricActiveIndex = -1;
  state.transcriptMode = "lyrics";
  renderLyrics();

  const played = await playMusic(track, sessionId);
  if (!played || !isActivePlaybackSession(sessionId, track)) return;

  if (state.introducedTrackId !== track.id) {
    if (state.reply?.say && !state.reply?.introPending) {
      pushDj(state.reply.say, shouldScroll);
      playDjIntro({ track, text: state.reply.say, sessionId, resumeMusic: false, leadInMs: 450, mode: "auto" }).catch(() => {});
    } else if (els.player.currentTime < 20) {
      hydrateIntroForPlayingTrack(track, { mode: "opening", sessionId, shouldPush: true }).catch(() => {});
    }
  }
}

async function hydrateIntroForPlayingTrack(track, { mode = "opening", sessionId = state.playSessionId, shouldPush = true } = {}) {
  const key = trackKey(track);
  if (!track || !key) return "";
  const introRequestId = ++state.introRequestId;
  if (state.reply) {
    state.reply.introPending = true;
    els.speakState.innerHTML = "<span></span> Writing";
    if (state.transcriptMode === "dj" && state.reply.say) renderBroadcast(state.reply);
  }
  let text = await ensureIntroTextForTrack(track, {
    mode,
    timeoutMs: mode === "opening" ? 7000 : 18000,
    allowFallback: true,
    fast: mode === "opening"
  });
  if (!text || introRequestId !== state.introRequestId || !isActivePlaybackSession(sessionId, track) || trackKey(state.reply?.play) !== key) return "";
  const canAnnounceNow = state.introducedTrackId !== track.id && els.player.currentTime < 20;
  if (state.reply) {
    state.reply.say = text;
    state.reply.introPending = false;
  }
  state.djText = text;
  if (canAnnounceNow) {
    renderBroadcast(state.reply);
    if (shouldPush) pushDj(text, true);
    playDjIntro({ track, text, sessionId, resumeMusic: false, leadInMs: 150, mode: "auto" }).catch(() => {});
  }
  return text;
}

async function ensureIntroTextForTrack(track, { mode = "recommend", timeoutMs = 9000, allowFallback = true, fast = mode === "opening" } = {}) {
  if (!track) return "";
  if (state.reply?.say && trackKey(state.reply.play) === trackKey(track)) return state.reply.say;
  try {
    const intro = await withTimeout(api("/api/dj/intro", {
      method: "POST",
      body: {
        track,
        previousTrack: null,
        fast,
        mode,
        message: mode === "opening"
          ? "为当前已经选定的第一首歌补一段 Claudio 开场。不要提准备、同步、技术状态。"
          : "为当前歌曲补一段简短自然的私人电台介绍。",
        context: { mood: state.mood, weather: state.weather }
      }
    }), timeoutMs);
    const staleOpening = mode === "opening"
      && !els.player.paused
      && els.player.currentTime >= 20
      && state.introducedTrackId === track.id;
    if (intro?.say && trackKey(state.reply?.play) === trackKey(track) && !staleOpening) {
      state.reply.say = intro.say;
      state.djText = intro.say;
      if (state.transcriptMode === "dj") renderBroadcast(state.reply);
      return intro.say;
    }
  } catch {
    // If the model is slow, use a short local line instead of losing the DJ voice entirely.
  }
  if (!allowFallback) return "";
  const lines = await lyricPreviewLines(track);
  const anchor = pickAutoAnchorLine(lines, track.title);
  if (mode === "opening") return buildOpeningFallback(track, lines, anchor);
  const handoff = `${track.artist}的《${track.title}》。`;
  return buildLocalDjFallback({ handoff, lines, anchor, track, mode });
}

async function resolvePlayableUrl(track, { applyToPlayer = true } = {}) {
  if (!track.sourceId || track.source !== "netease") {
    const resolved = await resolveTrackMetadata(track);
    if (!resolved?.sourceId) return false;
    Object.assign(track, resolved);
  }

  try {
    const result = await api(`/api/netease/url?id=${encodeURIComponent(track.sourceId)}`);
    if (!result.url) return false;
    track.url = normalizeAudioUrl(result.url);
    track.playable = true;
    if (applyToPlayer && trackKey(state.reply?.play) === trackKey(track)) {
      bindAudioTrack(track);
    }
    return true;
  } catch {
    return false;
  }
}

async function resolveTrackMetadata(track) {
  try {
    const result = await api("/api/netease/resolve", { method: "POST", body: { tracks: [track] } });
    return result.tracks?.[0] ?? null;
  } catch {
    return null;
  }
}

async function findNextPlayableTrack(current) {
  const tracks = state.profile?.playlists ?? [];
  const currentKey = current?.sourceId ?? `${current?.title}:${current?.artist}`;
  const passes = [true, false];

  for (const avoidRecent of passes) {
    for (const track of tracks) {
      const candidateKey = trackKey(track);
      const key = track.sourceId ?? `${track.title}:${track.artist}`;
      if (key === currentKey) continue;
      if (rejectedTrackKeys.has(candidateKey)) continue;
      if (avoidRecent && isRecentlyPlayed(candidateKey)) continue;

      const candidate = { ...track };
      if (!await resolvePlayableUrl(candidate, { applyToPlayer: false })) continue;
      hasUsableLyrics(candidate).catch(() => false);
      return candidate;
    }
  }

  return null;
}

async function handlePlaybackFailure() {
  if (state.autoSkipping) return;
  state.autoSkipping = true;
  try {
    const failed = state.reply?.play ?? state.currentTrack;
    const failedKey = trackKey(failed);
    if (failedKey) rejectedTrackKeys.add(failedKey);
    reportPlaybackEvent("fail", failed, "播放失败或浏览器无法加载。");
    const alternate = await findNextPlayableTrack(failed);
    if (!alternate) return;
    renderReply({
      say: `刚才那条播放地址断了，我换一首能稳稳播放的。${alternate.artist}的《${alternate.title}》。`,
      play: alternate,
      reason: "跳过播放失败或无歌词歌曲。",
      segue: "保持电台不断线。",
      context: { mood: state.mood, weather: state.weather }
    }, true, { forceRender: true, autoPlay: true });
  } finally {
    state.autoSkipping = false;
  }
}

async function handleTrackEnded() {
  if (state.autoAdvancing || state.autoSkipping) return;
  const finished = currentPlaybackTrack() ?? state.currentTrack ?? state.reply?.play;
  const finishedKey = trackKey(finished);
  if (!finishedKey || state.lastAutoAdvancedKey === finishedKey) return;
  state.lastAutoAdvancedKey = finishedKey;
  state.autoAdvancing = true;
  try {
    reportPlaybackEvent("ended", finished, "自然播放结束。");
    state.introducedTrackId = null;
    if (!await forceLocalNextTrack({ current: finished, reason: "ended-immediate" })) {
      await playRecommendedNext({ current: finished, reason: "ended" });
    }
  } finally {
    state.autoAdvancing = false;
  }
}

async function playMusic(track = state.reply?.play, sessionId = state.playSessionId) {
  if (!track?.url) return false;
  try {
    bindAudioTrack(track);
    await els.player.play();
    if (!isActivePlaybackSession(sessionId, track)) return false;
    const key = trackKey(track);
    if (state.lyricsTrackKey !== key) {
      state.lyrics = [];
      state.lyricsTrackKey = "";
      state.lyricActiveIndex = -1;
      state.lyricRequestId += 1;
    }
    state.playingTrackKey = key;
    state.lastAutoAdvancedKey = "";
    state.endAdvanceCheckKey = "";
    rememberPlayedTrack(track);
    syncCurrentTrackFromAudio();
    updatePlaybackButtons();
    loadLyrics(track, sessionId).catch(() => {});
    reportPlaybackEvent("play", track, state.reply?.reason);
    return true;
  } catch (error) {
    if (error?.name === "AbortError") return false;
    if (error?.name === "NotAllowedError") {
      pushDj("浏览器拦截了自动播放，点一下播放键我再接上。");
      return false;
    }
    if (isActivePlaybackSession(sessionId, track)) {
      pushDj(`\u6d4f\u89c8\u5668\u6ca1\u80fd\u64ad\u653e\u8fd9\u4e2a\u97f3\u9891\u5730\u5740\uff1a${error.message}`);
    }
    return false;
  }
}

function reportPlaybackEvent(eventType, track, reason = "") {
  if (!track) return;
  api("/api/play", {
    method: "POST",
    body: {
      track,
      eventType,
      reason,
      mood: state.mood,
      duration: Number.isFinite(els.player.duration) ? els.player.duration : undefined,
      position: Number.isFinite(els.player.currentTime) ? els.player.currentTime : undefined
    }
  }).catch(() => {});
}

async function playDjIntro({ track = currentPlaybackTrack() ?? state.reply?.play, text, sessionId = state.playSessionId, resumeMusic, leadInMs = 0, mode = "auto" }) {
  if (!track) return;
  if (text === undefined) {
    if (trackKey(track) !== trackKey(state.reply?.play)) return;
    text = state.reply?.say ?? "";
  }
  if (!text) return;
  const speakingSessionId = ++state.speakingSessionId;

  const wasPlaying = !els.player.paused;
  const previousVolume = Number.isFinite(els.player.volume) ? els.player.volume : state.baseVolume;

  if (resumeMusic && els.player.paused && els.player.src) {
    await playMusic(track, sessionId);
  }

  if (leadInMs > 0) {
    await wait(leadInMs);
  }
  if (speakingSessionId !== state.speakingSessionId || !isActivePlaybackSession(sessionId, track)) return;

  state.introducedTrackId = track.id ?? state.introducedTrackId;
  setSpeaking(true, text);
  rampVolume(els.player, Math.min(previousVolume, 0.2), 420);

  try {
    await speakText(text, mode);
  } finally {
    if (speakingSessionId !== state.speakingSessionId) return;
    setSpeaking(false);
    rampVolume(els.player, previousVolume || state.baseVolume, 1200);
    if (resumeMusic && wasPlaying && els.player.paused) {
      await playMusic(track, sessionId);
    }
  }
}

function rampVolume(audio, target, durationMs) {
  window.clearInterval(state.volumeRamp);
  const start = audio.volume;
  const startedAt = performance.now();
  state.volumeRamp = window.setInterval(() => {
    const ratio = Math.min(1, (performance.now() - startedAt) / durationMs);
    audio.volume = start + (target - start) * easeOut(ratio);
    if (ratio >= 1) {
      window.clearInterval(state.volumeRamp);
    }
  }, 40);
}

function easeOut(value) {
  return 1 - Math.pow(1 - value, 3);
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function speakText(text, mode) {
  stopTtsPlayback();
  const voiceText = normalizeTtsText(text);
  const useRemoteTts = localStorage.getItem("aiDjRemoteTts") !== "0";
  if (!useRemoteTts) {
    await browserSpeak(voiceText);
    return;
  }

  try {
    await unlockTts();
    await playRemoteTts(voiceText, localStorage.getItem("aiDjTtsVoice") || undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    pushDj(`MiniMax TTS 没有播出来：${message}。我先不切回浏览器机械音，避免你误判声音质量。`, true);
  }
}

async function playRemoteTts(text, speaker) {
  const voiceText = normalizeTtsText(text);
  const voiceId = speaker || localStorage.getItem("aiDjTtsVoice") || "";
  const cacheKey = ttsCacheKey(voiceText, voiceId);
  let arrayBuffer = ttsAudioCache.get(cacheKey);
  if (!arrayBuffer) {
    arrayBuffer = await fetchTtsAudio(voiceText, voiceId);
    ttsAudioCache.set(cacheKey, arrayBuffer.slice(0));
  }

  if (ttsContext) {
    const audioBuffer = await ttsContext.decodeAudioData(arrayBuffer.slice(0));
    await new Promise((resolve) => {
      const source = ttsContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ttsContext.destination);
      state.ttsSource = source;
      source.onended = resolve;
      source.start(0);
    });
    state.ttsSource = null;
    return;
  }

  const blob = new Blob([arrayBuffer.slice(0)]);
  const audio = new Audio(URL.createObjectURL(blob));
  audio.playsInline = true;
  state.ttsAudio = audio;
  await audio.play();
  await new Promise((resolve) => {
    audio.addEventListener("ended", resolve, { once: true });
    audio.addEventListener("error", resolve, { once: true });
  });
  URL.revokeObjectURL(audio.src);
  state.ttsAudio = null;
}

async function prefetchTtsAudio(text, speaker = localStorage.getItem("aiDjTtsVoice") || undefined) {
  const voiceText = normalizeTtsText(text);
  if (!voiceText || localStorage.getItem("aiDjRemoteTts") === "0") return;
  const voiceId = speaker || "";
  const cacheKey = ttsCacheKey(voiceText, voiceId);
  if (ttsAudioCache.has(cacheKey)) return;
  const arrayBuffer = await fetchTtsAudio(voiceText, voiceId);
  ttsAudioCache.set(cacheKey, arrayBuffer);
}

async function fetchTtsAudio(text, speaker) {
  const response = await fetch("/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, lang: "zh", speaker })
  });
  if (!response.ok || !response.headers.get("content-type")?.includes("audio")) {
    const detail = await response.text().catch(() => "");
    throw new Error(detail.slice(0, 180) || `HTTP ${response.status}`);
  }
  return response.arrayBuffer();
}

function ttsCacheKey(text, speaker) {
  return `${speaker || "default"}:${text}`;
}

function normalizeTtsText(text) {
  return String(text || "")
    .replace(/\bClaude Code\b/gi, "克劳德代码")
    .replace(/\bAI\b/g, "人工智能")
    .replace(/\bDJ\b/gi, "电台")
    .replace(/\s+/g, " ")
    .trim();
}

function browserSpeak(text) {
  return new Promise((resolve) => {
    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) {
      resolve();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-CN";
    utterance.rate = 0.92;
    utterance.pitch = 0.95;
    utterance.onend = resolve;
    utterance.onerror = resolve;
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
  });
}

function stopTtsPlayback() {
  try {
    state.ttsSource?.stop(0);
  } catch {}
  state.ttsSource = null;

  if (state.ttsAudio) {
    state.ttsAudio.pause();
    state.ttsAudio.src = "";
    state.ttsAudio = null;
  }

  if ("speechSynthesis" in window) {
    speechSynthesis.cancel();
  }
}

function setSpeaking(active, text = state.djText) {
  els.broadcastCard.classList.toggle("speaking", active);
  els.speakState.innerHTML = active ? "<span></span> Speaking..." : "<span></span> Ready";
  // While speaking, show DJ transcript; after speaking, show lyrics if available.
  if (active) {
    state.djText = text || state.djText;
    state.transcriptMode = "dj";
    if (text) {
      renderDjTranscript(text);
    }
  } else {
    if (state.lyrics.length) {
      state.transcriptMode = "lyrics";
      renderLyrics();
    } else if (state.reply) {
      state.transcriptMode = "dj";
      renderBroadcast(state.reply);
    }
  }
  if (active) {
    state.speakingStartedAt = Date.now();
    window.clearInterval(state.speakingTimer);
    state.speakingTimer = window.setInterval(() => {
      els.speakTimer.textContent = formatTime((Date.now() - state.speakingStartedAt) / 1000);
      updateDjTranscriptHighlight();
      updateBroadcastDuration();
    }, 220);
  } else {
    window.clearInterval(state.speakingTimer);
  }
}

function renderDjTranscript(text) {
  els.transcript.innerHTML = timedTranscriptLines(text)
    .map((line, index) => `<div class="line dj-line${index === 0 ? " active" : ""}" data-index="${index}" data-time="${line.time}"><b>Claudio</b><span>${escapeHtml(line.text)}</span></div>`)
    .join("");
  els.transcript.scrollTo({ top: 0, behavior: "auto" });
}

function updateDjTranscriptHighlight() {
  if (state.transcriptMode !== "dj" || !els.broadcastCard.classList.contains("speaking")) return;
  const elapsed = Math.max(0, (Date.now() - state.speakingStartedAt) / 1000);
  const lines = [...els.transcript.querySelectorAll(".dj-line")];
  if (!lines.length) return;

  let active = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const time = Number(lines[index].dataset.time || 0);
    if (elapsed >= time) active = index;
  }

  lines.forEach((line, index) => line.classList.toggle("active", index === active));
  scrollActiveDjLineIntoView();
}

function scrollActiveDjLineIntoView() {
  const activeLine = els.transcript.querySelector(".dj-line.active");
  if (!activeLine) return;
  if (Date.now() - state.lastTranscriptWheelAt < 3000) return;
  const container = els.transcript;
  const containerRect = container.getBoundingClientRect();
  const activeRect = activeLine.getBoundingClientRect();
  const drift =
    activeRect.top +
    activeRect.height / 2 -
    (containerRect.top + containerRect.height / 2);
  if (Math.abs(drift) > activeLine.clientHeight * 0.5) {
    container.scrollTo({ top: Math.max(0, container.scrollTop + drift), behavior: "auto" });
  }
}

async function loadLyrics(track, sessionId = state.playSessionId) {
  const key = trackKey(track);
  const requestId = ++state.lyricRequestId;
  if (!key || state.playingTrackKey !== key || !sameAudioUrl(els.player.currentSrc || els.player.src, track.url)) return;
  state.lyricsTrackKey = key;
  state.lyricOffset = Number(localStorage.getItem(lyricOffsetStorageKey(key)) || "0") || 0;

  if (!track.sourceId || track.source !== "netease") {
    clearLyrics(key);
    return;
  }

  const data = await api(`/api/netease/lyric?id=${encodeURIComponent(track.sourceId)}`);
  if (requestId !== state.lyricRequestId || !isActivePlaybackSession(sessionId, track)) return;
  if (state.lyricsTrackKey !== key || state.playingTrackKey !== key || trackKey(state.currentTrack) !== key) return;
  if (!sameAudioUrl(els.player.currentSrc || els.player.src, track.url)) return;

  state.lyrics = await getParsedLyrics(track, data);
    if (state.lyrics.length) {
      state.lyricActiveIndex = -1;
      if (!els.broadcastCard.classList.contains("speaking")) {
        state.transcriptMode = "lyrics";
        renderLyrics();
        updateBroadcastDuration();
    }
  } else {
    clearLyrics(key);
  }
}

async function validateLoadedAudioAgainstLyrics() {
  const track = currentPlaybackTrack() ?? audioBoundTrack();
  if (!track?.url || state.autoSkipping) return;
  const key = trackKey(track);
  const duration = els.player.duration;
  if (!key || !Number.isFinite(duration) || duration <= 0) return;
  if (!sameAudioUrl(els.player.currentSrc || els.player.src, track.url)) return;

  const lyrics = state.lyricsTrackKey === key && state.lyrics.length ? state.lyrics : await getParsedLyrics(track);
  const lastLyricTime = lyrics[lyrics.length - 1]?.time ?? 0;
  if (!isProbablyPreviewAudio(duration, lastLyricTime)) return;

  rejectedTrackKeys.add(key);
  reportPlaybackEvent("fail", track, "音频疑似试听片段，无法匹配完整歌词。");
  state.autoSkipping = true;
  try {
    els.player.pause();
    els.player.removeAttribute("src");
    els.player.load();
    clearLyrics(key);
    clearAudioBinding(key);

    const alternate = await findNextPlayableTrack(track);
    if (!alternate) {
      pushDj("\u8fd9\u4e2a\u97f3\u9891\u53ea\u62ff\u5230\u4e86\u8bd5\u542c\u7247\u6bb5\uff0c\u548c\u5b8c\u6574\u6b4c\u8bcd\u5bf9\u4e0d\u4e0a\u3002\u6211\u5148\u505c\u4e0b\uff0c\u7b49\u4e0b\u4e00\u9996\u771f\u6b63\u80fd\u64ad\u7684\u6b4c\u3002");
      return;
    }

    renderReply({
      say: `\u8fd9\u9996\u53ea\u62ff\u5230\u4e86\u8bd5\u542c\u7247\u6bb5\uff0c\u6b4c\u8bcd\u4f1a\u5bf9\u4e0d\u4e0a\u3002\u6211\u6362\u4e00\u9996\u97f3\u9891\u548c\u6b4c\u8bcd\u66f4\u7a33\u7684\uff1a${alternate.artist} \u7684\u300a${alternate.title}\u300b\u3002`,
      play: alternate,
      reason: "Skipped a preview-length audio URL that cannot match full lyrics.",
      segue: "Keep audio and lyrics on the same real track.",
      context: { mood: state.mood, weather: state.weather }
    }, true, { forceRender: true, autoPlay: true });
  } finally {
    state.autoSkipping = false;
  }
}

function isProbablyPreviewAudio(duration, lastLyricTime) {
  if (!lastLyricTime) return duration > 0 && duration < 35;
  if (duration < 45 && lastLyricTime > 75) return true;
  return lastLyricTime > 90 && duration < lastLyricTime * 0.62;
}

function clearLyrics(key = state.lyricsTrackKey) {
  if (state.lyricsTrackKey !== key) return;
  state.lyrics = [];
  state.lyricActiveIndex = -1;
  if (state.reply && state.transcriptMode === "lyrics") {
    renderBroadcast(state.reply);
  } else {
    updateBroadcastDuration();
  }
}

function renderLyrics() {
  const activeIndex = state.lyricActiveIndex >= 0 ? state.lyricActiveIndex : computeLyricActiveIndex();
  state.lyricActiveIndex = activeIndex;
  const anchorIndex = Math.max(0, activeIndex);
  const start = Math.max(0, Math.min(anchorIndex - 28, state.lyrics.length - 80));
  const lines = state.lyrics.slice(start, start + 80);
  els.transcript.innerHTML = lines
    .map((line, offset) => {
      const index = start + offset;
      return `<div class="line lyric-line ${index === activeIndex ? "active" : ""}" data-index="${index}" data-time="${line.time}"><b>${formatTime(line.time)}</b><span>${escapeHtml(line.text)}</span></div>`;
    })
    .join("");
  scrollActiveLyricIntoView(true);
  updateBroadcastDuration();
}

function updateLyricHighlight() {
  if (!state.lyrics.length) return;
  if (state.lyricsTrackKey !== state.playingTrackKey || state.lyricsTrackKey !== trackKey(state.currentTrack)) return;
  if (!sameAudioUrl(els.player.currentSrc || els.player.src, state.currentTrack?.url)) return;

  const activeIndex = computeLyricActiveIndex();
  const changed = activeIndex !== state.lyricActiveIndex;
  state.lyricActiveIndex = activeIndex;
  if (els.broadcastCard.classList.contains("speaking") || state.transcriptMode !== "lyrics") return;

  const renderedActive = els.transcript.querySelector(`.lyric-line[data-index="${activeIndex}"]`);
  if (!renderedActive) {
    renderLyrics();
    return;
  }

  els.transcript.querySelectorAll(".lyric-line").forEach((line) => {
    line.classList.toggle("active", Number(line.dataset.index) === activeIndex);
  });
  scrollActiveLyricIntoView(changed || shouldForceLyricFollow());
  updateBroadcastDuration();
}

function computeLyricActiveIndex() {
  const current = els.player.currentTime + state.lyricOffset;
  const last = state.lyrics[state.lyrics.length - 1];
  if (last && current > last.time + 6) return -1;
  let activeIndex = 0;
  for (let index = 0; index < state.lyrics.length; index += 1) {
    if (state.lyrics[index].time <= current) activeIndex = index;
    else break;
  }
  return activeIndex;
}

function lyricOffsetStorageKey(key) {
  return `aiDjLyricOffset:${key}`;
}

function scrollActiveLyricIntoView(force = false) {
  const activeLine = els.transcript.querySelector(".lyric-line.active");
  if (!activeLine) return;
  if (!force && Date.now() - state.lastTranscriptWheelAt < 3000) return;
  const container = els.transcript;
  const containerRect = container.getBoundingClientRect();
  const activeRect = activeLine.getBoundingClientRect();
  const drift =
    activeRect.top +
    activeRect.height / 2 -
    (containerRect.top + containerRect.height / 2);

  if (force || Math.abs(drift) > activeLine.clientHeight * 0.5) {
    container.scrollTo({ top: Math.max(0, container.scrollTop + drift), behavior: "auto" });
  }
}

function shouldForceLyricFollow() {
  return !els.player.paused && Date.now() - state.lastTranscriptWheelAt > 3000;
}

async function getParsedLyrics(track, lyricData = null) {
  const key = trackKey(track);
  if (!key) return [];
  if (lyricCache.has(key)) return lyricCache.get(key);
  if (!track.sourceId || track.source !== "netease") return [];

  const data = lyricData ?? await api(`/api/netease/lyric?id=${encodeURIComponent(track.sourceId)}`);
  const parsed = parseLrc(bestLyricText(data));
  lyricCache.set(key, parsed);
  return parsed;
}

function trackKey(track) {
  if (!track) return "";
  return track.sourceId ? `${track.source ?? "netease"}:${track.sourceId}` : `${track.title ?? track.name}:${track.artist}`;
}

function currentReplyForChat() {
  if (!state.reply) return null;
  const play = currentPlaybackTrack() ?? audioBoundTrack() ?? state.reply.play ?? null;
  if (!play) return null;
  return { ...state.reply, play };
}

function currentPlaybackTrack() {
  recoverPlaybackBinding();
  const track = state.currentTrack ?? audioBoundTrack();
  if (!track) return null;
  const key = trackKey(track);
  if (!state.playingTrackKey && !els.player.paused) {
    state.playingTrackKey = key;
    state.currentTrack = { ...track };
  }
  if (state.playingTrackKey !== key) return null;
  if (track.url && !sameAudioUrl(els.player.currentSrc || els.player.src, track.url)) return null;
  return track;
}

function currentLyricContext() {
  const track = currentPlaybackTrack() ?? state.reply?.play;
  const key = trackKey(track);
  if (!key || !state.lyrics.length) return "";
  if (state.lyricsTrackKey && state.lyricsTrackKey !== key) return "";

  const active = state.lyricActiveIndex >= 0 ? state.lyricActiveIndex : 0;
  const start = Math.max(0, active - 8);
  const end = Math.min(state.lyrics.length, active + 24);
  const windowLines = state.lyrics.slice(start, end);
  const lines = lyricSummaryLines(windowLines.length ? windowLines : state.lyrics);
  return lines
    .map((line) => line.text)
    .filter(Boolean)
    .join(" / ")
    .slice(0, 1200);
}

function lyricSummaryLines(lines) {
  const clean = lines.filter((line) => line?.text && !isLyricCredit(line.text));
  if (clean.length >= 10) return clean.slice(0, 32);
  return state.lyrics.filter((line) => line?.text && !isLyricCredit(line.text)).slice(0, 36);
}

function bindAudioTrack(track) {
  const key = trackKey(track);
  state.audioTrack = { ...track };
  state.currentTrack = { ...track };
  state.playingTrackKey = key;
  els.player.dataset.trackKey = key;
  if (track.url && !sameAudioUrl(els.player.currentSrc || els.player.src, track.url)) {
    els.player.src = track.url;
  }
  els.player.dataset.trackKey = key;
}

function audioBoundTrack() {
  const track = state.audioTrack;
  if (!track) return null;
  if (els.player.dataset.trackKey !== trackKey(track)) return null;
  if (track.url && !sameAudioUrl(els.player.currentSrc || els.player.src, track.url)) return null;
  return track;
}

function syncCurrentTrackFromAudio() {
  recoverPlaybackBinding();
  const track = audioBoundTrack();
  if (!track) return;
  const key = trackKey(track);
  state.currentTrack = { ...track };
  state.playingTrackKey = key;
}

function recoverPlaybackBinding() {
  const audioSrc = els.player.currentSrc || els.player.src || "";
  const replyTrack = state.reply?.play;
  const replyKey = trackKey(replyTrack);
  const key = state.playingTrackKey || els.player.dataset.trackKey || replyKey;
  if (!audioSrc || !replyTrack || !replyKey || key !== replyKey) return;
  if (replyTrack.url && !sameAudioUrl(audioSrc, replyTrack.url)) return;

  state.audioTrack = state.audioTrack ?? { ...replyTrack };
  state.currentTrack = state.currentTrack ?? { ...replyTrack };
  state.playingTrackKey = replyKey;
  els.player.dataset.trackKey = replyKey;
}

function clearAudioBinding(key = "") {
  const currentKey = trackKey(state.currentTrack) || trackKey(state.audioTrack) || state.playingTrackKey || els.player.dataset.trackKey || "";
  if (key && currentKey && key !== currentKey) return;
  state.audioTrack = null;
  state.currentTrack = null;
  state.playingTrackKey = "";
  delete els.player.dataset.trackKey;
}

function prepareForManualTrackChange(current = null, options = {}) {
  const key = trackKey(current) || state.playingTrackKey || els.player.dataset.trackKey || "";
  interruptDjForTrackChange();
  try {
    els.player.pause();
    els.player.removeAttribute("src");
    els.player.load();
  } catch {
    // Some browsers throw if load() is interrupted during source changes.
  }
  if (options.clearTranscript) {
    if (key) clearLyrics(key);
    state.lyrics = [];
    state.lyricsTrackKey = "";
    state.lyricActiveIndex = -1;
  }
  clearAudioBinding();
  updatePlaybackButtons();
  updateBroadcastDuration();
}

function isActivePlaybackSession(sessionId, track) {
  return sessionId === state.playSessionId && trackKey(state.reply?.play) === trackKey(track);
}

function sameAudioUrl(left, right) {
  if (!left || !right) return false;
  try {
    return new URL(left, location.href).href === new URL(right, location.href).href;
  } catch {
    return String(left) === String(right);
  }
}

function pickTrackDebug(track) {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    source: track.source,
    sourceId: track.sourceId,
    key: trackKey(track),
    url: track.url
  };
}

function parseLrc(text) {
  return text
    .split("\n")
    .flatMap((line) => {
      const lrcMatches = [...line.matchAll(/\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g)].map((match) => ({
        time: Number(match[1]) * 60 + Number(match[2]) + Number(`0.${match[3] ?? 0}`)
      }));
      const yrcMatches = [...line.matchAll(/\[(\d+),\d+\]/g)].map((match) => ({
        time: Number(match[1]) / 1000
      }));
      const matches = [...lrcMatches, ...yrcMatches];
      const content = line.replace(/\[[^\]]+\]/g, "").replace(/\(\d+,\d+(?:,\d+)?\)/g, "").trim();
      if (!matches.length || !content) return [];
      if (isLyricCredit(content)) return [];
      return matches.map((match) => ({
        time: match.time,
        text: content
      }));
    })
    .sort((a, b) => a.time - b.time);
}

function isLyricCredit(text) {
  return /^(作词|作曲|编曲|制作人|制作|统筹|协力|钢琴|电吉他|民谣吉他|贝斯|鼓|Loop|和声|弦乐|人声|器乐|录音|音频编辑|混音|母带|监制|OP|SP|ISRC|出品|版权所有|未经许可|©|Lyrics|Composed|Produced|Arranged|Drums|Bass|Guitars|Keyboard|Strings|Recorded|Edited|Mixed|Mastered)(\s|[:：/]|by\b|[A-Z]{2}-|，|,|$)/i.test(text);
}

function bestLyricText(data) {
  const body = data.body ?? {};
  const candidates = [
    data.lrc?.lyric,
    body.lrc?.lyric,
    data.yrc?.lyric,
    body.yrc?.lyric,
    data.klyric?.lyric,
    body.klyric?.lyric,
    data.tlyric?.lyric,
    body.tlyric?.lyric
  ].filter(Boolean);

  return candidates
    .map((text) => String(text))
    .sort((left, right) => parseLrc(right).length - parseLrc(left).length)[0] ?? "";
}

function titleForBroadcast(reply) {
  const hour = new Date().getHours();
  const period = hour >= 20 ? "Night" : hour >= 12 ? "Afternoon" : "Morning";
  const mood = reply.context?.mood ?? state.mood;
  const label = {
    [MOODS.calm]: "Exhale",
    [MOODS.focus]: "Focus",
    [MOODS.awake]: "Awake",
    [MOODS.night]: "After Dark"
  }[mood] ?? "Radio";
  return `${new Date().toLocaleDateString("en-US", { weekday: "long" })} ${period} ${label}`;
}

function transcriptLines(text) {
  const parts = String(text || "").split(/(?<=[\u3002\uff01\uff1f.!?])/).map((item) => item.trim()).filter(Boolean);
  return parts.length ? parts : [String(text || "").trim()].filter(Boolean);
}

function timedTranscriptLines(text) {
  const lines = transcriptLines(text);
  const totalUnits = Math.max(1, lines.reduce((sum, line) => sum + speechUnits(line), 0));
  const duration = estimateSpeechDuration(text);
  let elapsed = 0;
  return lines.map((line) => {
    const item = { text: line, time: Number(elapsed.toFixed(2)) };
    elapsed += Math.max(1.4, duration * (speechUnits(line) / totalUnits));
    return item;
  });
}

function speechUnits(text) {
  const chineseChars = (String(text).match(/[\u4e00-\u9fff]/g) || []).length;
  const latinWords = (String(text).match(/[a-zA-Z]+/g) || []).length;
  return chineseChars + latinWords * 2.2 + 4;
}

function pushDj(text, shouldScroll = true) {
  const normalized = normalizeBubbleText(text);
  if (normalized && normalized === state.lastDjBubbleText) return;
  state.lastDjBubbleText = normalized;
  els.chat.insertAdjacentHTML(
    "beforeend",
    `<div class="message dj"><div class="avatar"></div><div><div class="speaker">CLAUDIO</div><div class="bubble">${escapeHtml(text)}</div></div></div>`
  );
  if (shouldScroll) maybeScrollToLatest();
}

function renderHistoryMessage(message) {
  const content = String(message?.content || "").trim();
  if (!content) return;
  if (message.role === "user") {
    els.chat.insertAdjacentHTML(
      "beforeend",
      `<div class="message user history"><div class="bubble">${escapeHtml(content)}</div><div class="avatar"></div></div>`
    );
    return;
  }

  if (!["chat", "dj_reply"].includes(message.kind || "chat")) return;
  els.chat.insertAdjacentHTML(
    "beforeend",
    `<div class="message dj history"><div class="avatar"></div><div><div class="speaker">CLAUDIO</div><div class="bubble">${escapeHtml(content)}</div></div></div>`
  );
  if (message.kind === "dj_reply" && message.trackTitle) {
    els.chat.insertAdjacentHTML(
      "beforeend",
      `<div class="track-card history"><strong>* ${escapeHtml(message.trackTitle)}</strong><span>${escapeHtml(message.trackArtist || "")}</span></div>`
    );
  }
}

function normalizeBubbleText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function pushUser(text) {
  els.chat.insertAdjacentHTML(
    "beforeend",
    `<div class="message user"><div class="bubble">${escapeHtml(text)}</div><div class="avatar"></div></div>`
  );
  maybeScrollToLatest();
}

function renderTrackCard(track, shouldScroll = true) {
  const status = track.url ? "" : " <span>metadata only</span>";
  els.chat.insertAdjacentHTML(
    "beforeend",
    `<div class="track-card"><strong>* ${escapeHtml(track.title ?? track.name)}</strong><span>${escapeHtml(track.artist)}</span>${status}</div>`
  );
  if (shouldScroll) maybeScrollToLatest();
}

async function playRecommendedNext(options = {}) {
  invalidateOpeningPrewarm();
  interruptDjForTrackChange();
  state.introRequestId++;
  state.introducedTrackId = null;
  const current = options.current ?? currentPlaybackTrack() ?? state.currentTrack ?? state.reply?.play;
  state.pendingPreviousTrack = current ? { ...current } : null;
  const immediate = pickQuickNextTrack(current) ?? pickLooseNextTrack(current);
  if (options.reason !== "ended") {
    if (immediate) {
      renderReply({
        say: "",
        play: immediate,
        previousTrack: state.pendingPreviousTrack,
        introPending: true,
        reason: "用户手动切歌，先从本地歌单即时响应。",
        segue: "先播放，再补完整过渡。",
        context: { mood: state.mood, weather: state.weather }
      }, true, { autoPlay: true });
      hydrateAutoSegue(immediate, current, options).catch(() => {});
      return;
    }
  }

  const lookupMs = options.reason === "ended" ? 7000 : 2400;
  const candidate = await withTimeout(getRecommendedTrack(current), lookupMs).catch(() => null);
  if (candidate) {
    renderReply({
      say: "",
      play: candidate,
      previousTrack: state.pendingPreviousTrack,
      introPending: true,
      reason: "根据当前歌曲的网易云相似歌曲或每日推荐扩展。",
      segue: "顺着相近的情绪继续走。",
      context: { mood: state.mood, weather: state.weather }
    }, true, { autoPlay: true });
    hydrateAutoSegue(candidate, current, options).catch(() => {});
    return;
  }

  const alternate = immediate ?? await withTimeout(findNextPlayableTrack(current), lookupMs).catch(() => null);
  if (alternate) {
    renderReply({
      say: "",
      play: alternate,
      previousTrack: state.pendingPreviousTrack,
      introPending: true,
      reason: "从本地歌单避开最近播放后接续。",
      segue: "换一条不重复的线。",
      context: { mood: state.mood, weather: state.weather }
    }, true, { autoPlay: true });
    hydrateAutoSegue(alternate, current, options).catch(() => {});
    return;
  }

  pushDj("这一轮没有找到能立即接上的歌，我先保持当前播放。再点一次下一首，我会放宽条件继续找。");
}

function interruptDjForTrackChange() {
  state.playSessionId += 1;
  state.speakingSessionId += 1;
  state.introRequestId += 1;
  stopTtsPlayback();
  setSpeaking(false);
}

async function buildAutoSegue(candidate, current, options = {}) {
  try {
    const intro = await withTimeout(api("/api/dj/intro", {
      method: "POST",
      body: {
        track: candidate,
        previousTrack: current ?? null,
        mode: "handoff",
        message: options.reason === "ended"
          ? `上一首${current?.title ? `《${current.title}》` : "歌"}刚结束。请像 Claudio 深夜私人电台一样自然接下一首，要有承接和过渡，不要说“先放”、不要说“这首在讲”、不要解释意义。`
          : `用户要换一首。请像 Claudio 深夜私人电台一样自然过渡到下一首，不要说“先放”、不要说“这首在讲”、不要解释意义。`,
        context: { mood: state.mood, weather: state.weather }
      }
    }), 12000);
    if (intro?.say) return intro.say;
  } catch {
    // Fall back to a local segue if the LLM endpoint is unavailable.
  }

  const lines = await lyricPreviewLines(candidate);
  const anchor = pickAutoAnchorLine(lines, candidate.title);
  const previousTitle = current?.title ? `《${current.title}》` : "上一首";
  const opening = options.reason === "ended" ? `${previousTitle}留下的情绪还在` : "我们把方向稍微拨开一点";
  const handoff = `${opening}。${candidate.artist}的《${candidate.title}》。`;

  if (/青花|黄昏/.test(candidate.title) && candidate.artist?.includes("周传雄")) {
    return `${handoff}别把音量一下子推高，旧事会自己露出一点轮廓。`;
  }
  if (/空空/.test(candidate.title) && candidate.artist?.includes("陈粒")) {
    return `${handoff}它不是单纯的空，是人长大以后，忽然发现自己和自己之间也隔了一层。`;
  }
  if (/温柔/.test(candidate.title) && candidate.artist?.includes("五月天")) {
    return `${handoff}风吹过来的时候，人不一定要回答谁；有些温柔，是终于允许自己不再硬撑。`;
  }
  if (/倔强/.test(candidate.title) && candidate.artist?.includes("五月天")) {
    return `${handoff}借它一点硬气，不是冲出去赢谁，是别把心里那块还亮着的地方交出去。`;
  }
  return buildLocalDjFallback({ handoff, lines, anchor, track: candidate, mode: "handoff" });
}

function buildOpeningFallback(track, lines = [], anchor = "") {
  const now = new Date();
  const weekday = now.toLocaleDateString("zh-CN", { weekday: "long" });
  const hour = now.getHours();
  const scene = hour >= 22
    ? `${weekday}夜里，窗外还有一点远声`
    : hour >= 18
      ? `${weekday}晚上，窗外还有一点车声`
      : hour >= 12
        ? `${weekday}下午，时间停在杯子旁边`
        : `${weekday}早上，桌面还亮着`;
  const image = anchor || pickAutoAnchorLine(lines, track.title);
  if (track.artist?.includes("陈粒") && track.title?.includes("空空")) {
    return `This is Claudio. ${scene}。陈粒的《空空》。它不是把人写成一片空白，而是写那种突然和自己隔开一点的时刻：梦还在，风也还在，可手心里少了一块确定的东西。先让它在这里响一会儿。`;
  }
  const detail = image
    ? `歌里那句「${image.slice(0, 14)}」轻轻露出来，后面藏着一点还没安放好的心事。`
    : "它的声音不抢人，像门虚掩着，留一点余地给你。";
  return `This is Claudio. ${scene}。${track.artist}的《${track.title}》。${detail}这几分钟，电台先陪你留在这里。`;
}

function buildFollowupFallback(track, lines = [], anchor = "", previousTrack = null) {
  const image = anchor || pickAutoAnchorLine(lines, track.title);
  const secondary = lines
    .filter((line) => line && line !== image)
    .filter((line) => line.length >= 4 && line.length <= 18)
    .filter((line) => !isLyricCredit(line))
    .find((line) => line !== track.title) || "";
  const hasRealPrevious = previousTrack && trackKey(previousTrack) !== trackKey(track);
  const previous = hasRealPrevious && previousTrack?.title ? `《${previousTrack.title}》` : "上一首";
  const handoff = hasRealPrevious ? `${previous}的尾音还没完全散` : "情绪换了一个方向";

  if (track.artist?.includes("贰月の羊") && track.title?.includes("重生")) {
    return `${handoff}，这里转到贰月の羊的《重生》。那些像梦一样没安放好的画面，不是要立刻翻篇；它们只是换了一种声音，提醒人可以从旧壳里出来一点。`;
  }
  if (track.artist?.includes("陈粒") && track.title?.includes("果实")) {
    return `${handoff}，陈粒的《果实》接过来。歌里反复要一个安全的所在，听起来很轻，其实是在给慌乱找一只手。剩下的不用急着说破。`;
  }
  if (track.artist?.includes("陈粒") && track.title?.includes("空空")) {
    return `${handoff}，陈粒的《空空》留在这里。前一秒还在放空，下一秒忽然失落；风和梦都在路上，只是暂时没有哪一个能把人托稳。`;
  }

  if (image && secondary) {
    return `${handoff}，现在到${track.artist}的《${track.title}》。${image.slice(0, 14)}和${secondary.slice(0, 14)}挨在一起，像两种心事互相照了一下：一个还想往前，一个还没放下。`;
  }
  if (image) {
    return `${handoff}，现在到${track.artist}的《${track.title}》。我只取${image.slice(0, 14)}这一点，不把它解释成大道理；让它在耳边停一下就够。`;
  }
  return `${handoff}，现在到${track.artist}的《${track.title}》。这次不重新开场，只把上一段没有说完的情绪换一副声线继续。`;
}

function isWeakOpeningIntro(text) {
  const normalized = String(text || "").trim();
  if (!normalized) return true;
  const weakPhrases = [
    "现在把频道打开",
    "把频道打开",
    "频道接住",
    "先把频道",
    "开场不赶时间",
    "把第一首歌摆好",
    "先让这首歌",
    "先听这段",
    "我在这里",
    "电台先",
    "不用把它讲满",
    "把外面的事放远",
    "让它把呼吸带回来",
    "把呼吸带回来",
    "先别急着",
    "别急着把",
    "时间停在杯子旁边",
    "这几分钟，电台先",
    "先让它在这里响",
    "放在第一首",
    "留在这里响"
  ];
  return weakPhrases.some((phrase) => normalized.includes(phrase));
}

function buildLocalDjFallback({ handoff, lines = [], anchor = "", track, mode = "handoff" }) {
  const images = lines
    .filter((line) => line && line !== anchor)
    .filter((line) => line.length >= 4 && line.length <= 18)
    .filter((line) => !isLyricCredit(line))
    .slice(0, 3);
  const detail = anchor || images[0] || "";
  const second = images.find((line) => line !== detail) || "";
  if (detail && second) {
    return `${handoff}${detail}和${second}挨得很近，像两件旧物放在同一个抽屉里。先听它怎么把话收住，再看心里哪一处松动。`;
  }
  if (detail) {
    return `${handoff}${detail}停在那里，像纸上没擦干净的一道铅笔印。别替它补全，听完这一段就够。`;
  }
  return `${handoff}前一首的尾音还在，新的鼓点会把空气重新分开。先听一段，再决定要不要往下走。`;
}

function pickQuickNextTrack(current) {
  const tracks = state.profile?.playlists ?? [];
  if (!tracks.length) return null;
  const currentKey = trackKey(current);
  const candidates = tracks.filter((track) => {
    const key = trackKey(track);
    return key && key !== currentKey && isResolvableTrack(track) && !isRecentlyPlayed(key) && !rejectedTrackKeys.has(key);
  });
  const pool = candidates.length ? candidates : tracks.filter((track) => trackKey(track) !== currentKey && isResolvableTrack(track));
  if (!pool.length) return null;
  const seed = Math.abs(hash(`${currentKey}:${Date.now()}:${state.recentTrackKeys.join("|")}`));
  return { ...pool[seed % pool.length] };
}

function pickLooseNextTrack(current) {
  const tracks = state.profile?.playlists ?? [];
  if (!tracks.length) return null;
  const currentKey = trackKey(current);
  const candidates = tracks.filter((track) => {
    const key = trackKey(track);
    return key && key !== currentKey && !isRecentlyPlayed(key) && !rejectedTrackKeys.has(key);
  });
  const pool = candidates.length
    ? candidates
    : tracks.filter((track) => {
      const key = trackKey(track);
      return key && key !== currentKey && !rejectedTrackKeys.has(key);
    });
  if (!pool.length) return null;
  const seed = Math.abs(hash(`loose:${currentKey}:${Date.now()}:${state.recentTrackKeys.join("|")}`));
  return { ...pool[seed % pool.length] };
}

function localNextCandidates(current) {
  const tracks = state.profile?.playlists ?? [];
  if (!tracks.length) return [];
  const currentKey = trackKey(current);
  const indexed = tracks.map((track, index) => ({ ...track, __queueIndex: index }));
  const currentIndex = indexed.findIndex((track) => trackKey(track) === currentKey);
  const ordered = currentIndex >= 0
    ? [...indexed.slice(currentIndex + 1), ...indexed.slice(0, currentIndex)]
    : indexed;
  const usable = ordered.filter((track) => {
    const key = trackKey(track);
    return key && key !== currentKey && !rejectedTrackKeys.has(key);
  });
  const fresh = usable.filter((track) => !isRecentlyPlayed(trackKey(track)));
  return fresh.length ? fresh : usable;
}

async function prepareLocalNextCandidate(candidate) {
  if (!candidate) return null;
  const track = { ...candidate };
  delete track.__queueIndex;
  const key = trackKey(track);
  if (!key) return null;
  if (!await resolvePlayableUrl(track, { applyToPlayer: false })) {
    rejectedTrackKeys.add(key);
    return null;
  }
  const lyrics = await getParsedLyrics(track).catch(() => []);
  if (!lyrics.length) {
    rejectedTrackKeys.add(key);
    return null;
  }
  return { track, lyrics };
}

async function commitPreparedNextTrack(track, lyrics, current, options = {}) {
  const key = trackKey(track);
  if (!key || !track.url || !lyrics?.length) return false;

  prepareForManualTrackChange(current, { clearTranscript: false });
  state.introducedTrackId = null;
  state.pendingPreviousTrack = current ? { ...current } : null;
  state.reply = {
    say: "",
    play: track,
    previousTrack: state.pendingPreviousTrack,
    introPending: true,
    reason: options.reason ?? "local prepared handoff",
    segue: "local prepared handoff",
    context: { mood: state.mood, weather: state.weather }
  };

  els.title.textContent = track.title ?? "No track";
  els.meta.textContent = `${track.artist} - PLAYING`;
  renderBroadcast(state.reply);
  renderTrackCard(track, true);

  state.lyrics = lyrics;
  state.lyricsTrackKey = key;
  state.lyricActiveIndex = -1;
  state.transcriptMode = "lyrics";
  bindAudioTrack(track);
  renderLyrics();

  const sessionId = ++state.playSessionId;
  const played = await playMusic(track, sessionId);
  if (!played || !isActivePlaybackSession(sessionId, track)) return false;

  hydrateAutoSegue(track, current, options).catch((error) => {
    console.warn("[ai-dj] prepared segue failed", error);
  });
  return true;
}

async function forceLocalNextTrack(options = {}) {
  const current = options.current ?? currentPlaybackTrack() ?? state.currentTrack ?? state.reply?.play;
  const candidates = localNextCandidates(current);
  for (const candidate of candidates) {
    try {
      const prepared = await prepareLocalNextCandidate(candidate);
      if (!prepared) continue;
      if (await commitPreparedNextTrack(prepared.track, prepared.lyrics, current, options)) return true;
      rejectedTrackKeys.add(trackKey(prepared.track));
    } catch (error) {
      console.error("[ai-dj] force local next candidate failed", error);
      const key = trackKey(candidate);
      if (key) rejectedTrackKeys.add(key);
    }
  }
  return false;
}

function quickAutoSegue(candidate, current, options = {}) {
  const previousTitle = current?.title ? `《${current.title}》` : "上一首";
  const opening = options.reason === "ended" ? `${previousTitle}收尾了` : "我换一首";
  return `${opening}，现在到${candidate.artist}的《${candidate.title}》。先让声音接上，细的话待会儿再说。`;
}

async function hydrateAutoSegue(candidate, current, options = {}) {
  const introRequestId = ++state.introRequestId;
  let intro = await withTimeout(buildAutoSegue(candidate, current, options), 18000);
  if (!intro || introRequestId !== state.introRequestId || trackKey(state.reply?.play) !== trackKey(candidate)) return;
  if (/\bThis is Claudio\b/i.test(intro) || isWeakOpeningIntro(intro)) {
    const lines = await lyricPreviewLines(candidate);
    const anchor = pickAutoAnchorLine(lines, candidate.title);
    intro = buildFollowupFallback(candidate, lines, anchor, current);
  }
  state.reply.say = intro;
  state.reply.introPending = false;
  state.djText = intro;
  renderBroadcast(state.reply);
  pushDj(intro, true);
  const activeTrack = currentPlaybackTrack() ?? state.currentTrack;
  if (trackKey(activeTrack) === trackKey(candidate) && state.introducedTrackId !== candidate.id) {
    playDjIntro({
      track: candidate,
      text: intro,
      sessionId: state.playSessionId,
      resumeMusic: false,
      leadInMs: 150,
      mode: "auto"
    }).catch(() => {});
  }
}

async function lyricPreviewLines(track) {
  try {
    return (await getParsedLyrics(track))
      .map((line) => line.text)
      .filter(Boolean)
      .filter((line, index, array) => array.indexOf(line) === index)
      .slice(0, 24);
  } catch {
    return [];
  }
}

function pickAutoAnchorLine(lines, title = "") {
  const candidates = lines
    .map((line) => line.trim())
    .filter((line) => line.length >= 4 && line.length <= 22)
    .filter((line) => line !== title)
    .filter((line) => !isLyricCredit(line));
  return candidates.find((line) => /我|你|风|雨|夜|光|海|天亮|世界|孤单|沉默|温度|归宿|回忆|梦/.test(line)) ?? candidates[0] ?? "";
}

async function getRecommendedTrack(current) {
  const currentKey = trackKey(current);
  const seen = new Set([
    ...state.profile.playlists.map((track) => track.sourceId ?? `${track.title}:${track.artist}`),
    ...state.recentTrackKeys
  ]);
  if (currentKey) seen.add(currentKey);
  const endpoints = [];
  if (current?.sourceId && current.source === "netease") {
    endpoints.push(`/api/netease/similar?id=${encodeURIComponent(current.sourceId)}`);
  }
  endpoints.push("/api/netease/recommend/songs");

  for (const endpoint of endpoints) {
    try {
      const result = await api(endpoint);
      const tracks = result.tracks ?? [];
      for (const track of tracks) {
        const candidateKey = trackKey(track);
        if (seen.has(track.sourceId ?? `${track.title}:${track.artist}`) || seen.has(candidateKey)) continue;
        if (rejectedTrackKeys.has(candidateKey)) continue;
        const candidate = { ...track };
        if (await resolvePlayableUrl(candidate, { applyToPlayer: false }) && await hasUsableLyrics(candidate)) return candidate;
      }
    } catch {
      // Try the next recommendation source.
    }
  }

  return null;
}

function rememberPlayedTrack(track) {
  const key = trackKey(track);
  if (!key) return;
  state.recentTrackKeys = [key, ...state.recentTrackKeys.filter((item) => item !== key)].slice(0, 8);
}

function isRecentlyPlayed(key) {
  return Boolean(key && state.recentTrackKeys.includes(key));
}

async function hasUsableLyrics(track) {
  if (!track.sourceId || track.source !== "netease") return Boolean(track.url);
  try {
    const data = await api(`/api/netease/lyric?id=${encodeURIComponent(track.sourceId)}`);
    return parseLrc(bestLyricText(data)).length >= 2;
  } catch {
    return false;
  }
}

function renderPlan() {
  els.queueCount.textContent = `${state.plan.filter((item) => item.track).length} TRACKS`;
  els.plan.innerHTML = state.plan
    .map(
      (item) => `
        <div class="plan-item">
          <div>${item.start}-${item.end}</div>
          <div><strong>${escapeHtml(item.label)}</strong> <span>${escapeHtml(item.track ? `${item.track.title} - ${item.track.artist}` : "\u7b49\u5f85\u5bfc\u5165\u6b4c\u5355")}</span></div>
        </div>`
    )
    .join("");
}

function hydrateProfile() {
  els.profileName.value = state.profile.name;
  els.moods.value = state.profile.favoriteMoods.join(", ");
  els.playlistJson.value = JSON.stringify(
    state.profile.playlists.map((track) => ({
      name: track.title ?? track.name,
      artist: track.artist,
      background: track.background,
      source: track.source,
      sourceId: track.sourceId,
      cover: track.cover,
      externalUrl: track.externalUrl,
      url: track.url
    })),
    null,
    2
  );
}

async function saveProfile() {
  const next = {
    ...state.profile,
    name: els.profileName.value.trim() || "\u4f60",
    favoriteMoods: els.moods.value.split(",").map((item) => item.trim()).filter(Boolean),
    playlists: normalizePlaylistInput(JSON.parse(els.playlistJson.value))
  };
  state.profile = await api("/api/taste", { method: "PUT", body: next });
  await refreshPlan();
  els.profileDialog.close();
}

async function resolveNeteasePlaylist() {
  const tracks = normalizePlaylistInput(JSON.parse(els.playlistJson.value));
  els.resolveNetease.disabled = true;
  els.resolveNetease.textContent = "Resolving...";
  try {
    const result = await api("/api/netease/resolve", { method: "POST", body: { tracks } });
    els.playlistJson.value = JSON.stringify(
      result.tracks.map((track) => ({
        name: track.title ?? track.name,
        artist: track.artist,
        background: track.background,
        source: track.source,
        sourceId: track.sourceId,
        cover: track.cover,
        externalUrl: track.externalUrl
      })),
      null,
      2
    );
  } finally {
    els.resolveNetease.disabled = false;
    els.resolveNetease.textContent = "\u89e3\u6790\u7f51\u6613\u4e91";
  }
}

async function loadNeteaseAccount() {
  els.loadNetease.disabled = true;
  els.loadNetease.textContent = "Loading...";
  els.neteaseStatus.textContent = "连接中";
  els.neteasePlaylists.innerHTML = "";

  try {
    const [me, playlists] = await Promise.all([api("/api/netease/me"), api("/api/netease/playlists")]);
    const profile = me.profile ?? me.body?.profile;
    els.neteaseStatus.textContent = profile?.nickname ? `已连接：${profile.nickname}` : "已连接";
    renderNeteasePlaylists(Array.isArray(playlists) ? playlists : playlists.playlist ?? []);
  } catch (error) {
    els.neteaseStatus.textContent = "连接失败";
    els.neteasePlaylists.innerHTML = `<div class="netease-item"><span>${escapeHtml(error.message)}</span></div>`;
  } finally {
    els.loadNetease.disabled = false;
    els.loadNetease.textContent = "\u8fde\u63a5\u7f51\u6613\u4e91";
  }
}

function renderNeteasePlaylists(playlists) {
  if (!playlists.length) {
    els.neteasePlaylists.innerHTML = `<div class="netease-item"><span>No playlists found.</span></div>`;
    return;
  }

  els.neteasePlaylists.innerHTML = playlists
    .map(
      (playlist) => `
        <div class="netease-item">
          <div>
            <strong>${escapeHtml(playlist.name)}</strong>
            <span>${playlist.trackCount ?? 0} tracks</span>
          </div>
          <button type="button" data-playlist-id="${escapeHtml(playlist.id)}">\u5bfc\u5165</button>
        </div>`
    )
    .join("");

  els.neteasePlaylists.querySelectorAll("[data-playlist-id]").forEach((button) => {
    button.addEventListener("click", () => importNeteasePlaylist(button.dataset.playlistId, button));
  });
}

async function importNeteasePlaylist(id, button) {
  if (!id) return;
  button.disabled = true;
  button.textContent = "Importing...";
  try {
    const result = await api(`/api/netease/playlist?id=${encodeURIComponent(id)}`);
    const tracks = result.tracks ?? [];
    els.playlistJson.value = JSON.stringify(
      tracks.map((track) => ({
        name: track.title ?? track.name,
        artist: track.artist,
        background: track.background,
        source: track.source,
        sourceId: track.sourceId,
        cover: track.cover,
        externalUrl: track.externalUrl
      })),
      null,
      2
    );
  } finally {
    button.disabled = false;
    button.textContent = "\u5bfc\u5165";
  }
}

function normalizePlaylistInput(items) {
  if (!Array.isArray(items)) {
    throw new Error("Playlist JSON must be an array.");
  }

  return items.map((item, index) => {
    const title = String(item.title ?? item.name ?? "").trim();
    const artist = String(item.artist ?? "").trim();
    if (!title || !artist) {
      throw new Error(`Track ${index + 1} needs name/title and artist.`);
    }
    return {
      id: item.id ?? `manual-${slug(title)}-${slug(artist)}`,
      title,
      name: item.name ?? title,
      artist,
      album: item.album,
      background: item.background,
      cover: item.cover,
      url: item.url || undefined,
      mood: item.mood,
      energy: item.energy,
      source: item.source ?? "manual",
      sourceId: item.sourceId,
      externalUrl: item.externalUrl,
      playable: Boolean(item.url),
      cached: Boolean(item.url)
    };
  });
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-|-$/g, "").slice(0, 42);
}

function normalizeAudioUrl(url) {
  return String(url).replace(/^http:\/\//i, "https://");
}

function tick() {
  const now = new Date();
  els.clock.textContent = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  els.weekday.textContent = now.toLocaleDateString("en-US", { weekday: "long" });
  els.dateLine.textContent = now.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase().replaceAll(" ", " - ");
}

function updateProgress() {
  const ratio = els.player.duration ? (els.player.currentTime / els.player.duration) * 100 : 0;
  els.progress.style.width = `${ratio}%`;
  updateBroadcastDuration();
  updateLyricHighlight();
  maybeAutoAdvanceAtEnd();
}

function maybeAutoAdvanceAtEnd() {
  if (state.autoAdvancing || state.autoSkipping) return;
  if (!isPlayerAtTrackEnd()) return;
  const finished = currentPlaybackTrack() ?? state.currentTrack ?? state.reply?.play;
  const finishedKey = trackKey(finished);
  if (!finishedKey || state.endAdvanceCheckKey === finishedKey) return;
  state.endAdvanceCheckKey = finishedKey;
  window.setTimeout(() => {
    if (!isPlayerAtTrackEnd()) {
      state.endAdvanceCheckKey = "";
      return;
    }
    handleTrackEnded().catch(() => {});
  }, 0);
}

function updateBroadcastDuration() {
  if (els.broadcastCard.classList.contains("speaking") && state.transcriptMode === "dj") {
    const current = Math.max(0, (Date.now() - state.speakingStartedAt) / 1000);
    const duration = estimateSpeechDuration(state.djText || state.reply?.say || "");
    els.broadcastDuration.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
    return;
  }
  if (state.transcriptMode === "lyrics" || currentPlaybackTrack()) {
    const current = Number.isFinite(els.player.currentTime) ? els.player.currentTime : 0;
    const duration = Number.isFinite(els.player.duration) ? els.player.duration : 0;
    els.broadcastDuration.textContent = `${formatTime(current)} / ${duration ? formatTime(duration) : "--:--"}`;
    return;
  }

  els.broadcastDuration.textContent = `0:00 / ${formatTime(estimateSpeechDuration(state.djText || state.reply?.say || ""))}`;
}

function estimateSpeechDuration(text) {
  const normalized = normalizeTtsText(text);
  const chineseChars = (normalized.match(/[\u4e00-\u9fff]/g) || []).length;
  const latinWords = (normalized.match(/[a-zA-Z]+/g) || []).length;
  return Math.max(8, Math.ceil(chineseChars / 3.4 + latinWords / 2.2));
}

function contextParams() {
  return {
    mood: state.mood,
    city: state.weather?.city ?? "",
    condition: state.weather?.condition ?? "",
    temperature: state.weather?.temperature ?? "",
    wind: state.weather?.wind ?? "",
    code: state.weather?.code ?? ""
  };
}

function weatherText() {
  const weather = state.weather;
  if (!weather) return "Detecting weather...";
  const temp = Number.isFinite(weather.temperature) ? ` - ${weather.temperature}C` : "";
  const wind = Number.isFinite(weather.wind) ? ` - wind ${weather.wind}km/h` : "";
  return `${weather.city ?? "Today"} - ${weather.condition ?? "weather unknown"}${temp}${wind} - mood ${state.mood}`;
}

function weatherName(code) {
  if ([0, 1].includes(code)) return "\u6674";
  if ([2, 3].includes(code)) return "\u591a\u4e91";
  if ([45, 48].includes(code)) return "\u96fe";
  if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) return "\u96e8";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "\u96ea";
  if ([95, 96, 99].includes(code)) return "\u96f7\u96e8";
  return "\u672a\u77e5\u5929\u6c14";
}

function formatTime(value) {
  const seconds = Math.max(0, Math.floor(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function maybeScrollToLatest() {
  if (isUserReading()) return;
  window.requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }));
}

function releaseTranscriptWheel(event) {
  state.lastTranscriptWheelAt = Date.now();
  const box = event.currentTarget;
  const atTop = box.scrollTop <= 0;
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 2;
  const goingUp = event.deltaY < 0;
  const goingDown = event.deltaY > 0;

  if ((goingUp && atTop) || (goingDown && atBottom)) {
    event.preventDefault();
    window.scrollBy({ top: event.deltaY, behavior: "auto" });
  }
}

function isUserReading() {
  const distanceFromBottom = document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
  return distanceFromBottom > 220;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
