const MOODS = {
  awake: "\u6e05\u9192",
  focus: "\u4e13\u6ce8",
  calm: "\u677e\u5f1b",
  night: "\u591c\u665a"
};

const state = {
  profile: null,
  reply: null,
  mood: MOODS.focus,
  weather: null,
  plan: [],
  introducedTrackId: null,
  speakingStartedAt: 0,
  speakingTimer: null,
  volumeRamp: null,
  baseVolume: 0.72
};

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
  plan: document.querySelector("#plan"),
  queueCount: document.querySelector("#queueCount"),
  weatherLine: document.querySelector("#weatherLine"),
  profileDialog: document.querySelector("#profileDialog"),
  profileName: document.querySelector("#profileName"),
  moods: document.querySelector("#moods"),
  playlistJson: document.querySelector("#playlistJson"),
  resolveNetease: document.querySelector("#resolveNetease"),
  saveProfile: document.querySelector("#saveProfile")
};

await boot();

async function boot() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  tick();
  setInterval(tick, 1000);

  state.profile = await api("/api/taste");
  hydrateProfile();
  setupEvents();
  await detectWeather();
  await refreshPlan();
  renderReply(await ask("\u4eca\u5929\u6839\u636e\u5929\u6c14\u548c\u5fc3\u60c5\u5f00\u53f0", false), false);
}

function setupEvents() {
  els.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = els.message.value.trim();
    if (!message) return;
    els.message.value = "";
    pushUser(message);
    renderReply(await ask(message, false));
  });

  document.querySelectorAll("[data-mood]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.mood = button.dataset.mood;
      document.querySelectorAll("[data-mood]").forEach((item) => item.classList.toggle("active", item === button));
      els.weatherLine.textContent = weatherText();
      await refreshPlan();
      renderReply(await ask(`\u6211\u73b0\u5728\u60f3\u8981${state.mood}\u4e00\u70b9`, false));
    });
  });
  document.querySelector(`[data-mood="${MOODS.focus}"]`)?.classList.add("active");

  els.playBtn.addEventListener("click", togglePlayback);
  els.broadcastPlay.addEventListener("click", togglePlayback);
  els.nextBtn.addEventListener("click", async () => {
    state.introducedTrackId = null;
    renderReply(await ask("\u6362\u4e00\u9996\uff0c\u5ef6\u7eed\u73b0\u5728\u7684\u5929\u6c14\u548c\u5fc3\u60c5", false));
  });
  els.voiceBtn.addEventListener("click", () => playDjIntro({ resumeMusic: !els.player.paused }));
  document.querySelector(".brand").addEventListener("dblclick", () => els.profileDialog.showModal());
  els.resolveNetease.addEventListener("click", resolveNeteasePlaylist);
  els.saveProfile.addEventListener("click", saveProfile);
  els.player.addEventListener("timeupdate", updateProgress);
  document.querySelector(".volume input")?.addEventListener("input", (event) => {
    state.baseVolume = Number(event.target.value);
    if (!els.broadcastCard.classList.contains("speaking")) {
      els.player.volume = state.baseVolume;
    }
  });
  els.player.volume = state.baseVolume;
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

async function ask(message, shouldPush = true) {
  if (shouldPush) pushUser(message);
  return api("/api/chat", {
    method: "POST",
    body: {
      message,
      context: {
        mood: state.mood,
        weather: state.weather
      }
    }
  });
}

function renderReply(reply, shouldScroll = true) {
  state.reply = reply;
  const track = reply.play;
  els.title.textContent = track?.title ?? "No track";
  els.meta.textContent = track ? `${track.artist} - PLAYING` : "WAITING";
  renderBroadcast(reply);

  pushDj(reply.say, shouldScroll);
  if (track) {
    if (track.url) {
      els.player.src = track.url;
    } else {
      els.player.removeAttribute("src");
      els.player.load();
    }
    renderTrackCard(track, shouldScroll);
  }
}

function renderBroadcast(reply) {
  const track = reply.play;
  els.broadcastTitle.textContent = titleForBroadcast(reply);
  els.broadcastMeta.textContent = track ? `${track.title} - ${track.artist}` : "Waiting for track";
  els.broadcastDuration.textContent = `0:00 / ${formatTime(Math.max(12, Math.ceil(reply.say.length / 4)))}`;
  els.speakTimer.textContent = "0:00";
  els.speakState.innerHTML = "<span></span> Ready";
  els.transcript.innerHTML = transcriptLines(reply.say)
    .map((line, index) => {
      const stamp = `0:${String(index * 4 + 1).padStart(2, "0")}`;
      return `<div class="line ${index === 0 ? "active" : ""}" data-line="${index}"><b>Claudio - ${stamp}</b><span>${line}</span></div>`;
    })
    .join("");
}

async function togglePlayback() {
  if (!state.reply?.play) return;

  if (!state.reply.play.url) {
    await playDjIntro({ resumeMusic: false });
    pushDj("\u8fd9\u9996\u6b4c\u76ee\u524d\u53ea\u6709\u7ed3\u6784\u5316\u4fe1\u606f\uff0c\u8fd8\u6ca1\u6709\u53ef\u64ad\u653e\u97f3\u9891\u5730\u5740\u3002\u4e0b\u4e00\u6b65\u6211\u4eec\u53ef\u4ee5\u7528\u7f51\u6613\u4e91 API \u5c1d\u8bd5\u89e3\u6790\u64ad\u653e\u5730\u5740\u3002");
    return;
  }

  if (els.player.paused) {
    await playMusic();
    if (state.reply?.play && state.introducedTrackId !== state.reply.play.id) {
      playDjIntro({ resumeMusic: true, leadInMs: 650 });
    }
    return;
  }

  els.player.pause();
  els.playBtn.textContent = ">";
  els.broadcastPlay.textContent = ">";
}

async function playMusic() {
  if (!state.reply?.play?.url) return;
  await els.player.play();
  els.playBtn.textContent = "II";
  els.broadcastPlay.textContent = "II";
  if (state.reply?.play) {
    api("/api/play", { method: "POST", body: { track: state.reply.play, reason: state.reply.reason } }).catch(() => {});
  }
}

async function playDjIntro({ resumeMusic, leadInMs = 0 }) {
  const text = state.reply?.say;
  if (!text) return;

  const wasPlaying = !els.player.paused;
  const previousVolume = Number.isFinite(els.player.volume) ? els.player.volume : state.baseVolume;
  state.introducedTrackId = state.reply?.play?.id ?? state.introducedTrackId;

  if (resumeMusic && els.player.paused && els.player.src) {
    await playMusic();
  }

  if (leadInMs > 0) {
    await wait(leadInMs);
  }

  setSpeaking(true);
  rampVolume(els.player, Math.min(previousVolume, 0.2), 420);

  try {
    await speakText(text);
  } finally {
    setSpeaking(false);
    rampVolume(els.player, previousVolume || state.baseVolume, 1200);
    if ((resumeMusic || wasPlaying) && els.player.paused) {
      await playMusic();
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

async function speakText(text) {
  try {
    const response = await fetch(`/api/tts?text=${encodeURIComponent(text)}`);
    if (!response.ok || !response.headers.get("content-type")?.includes("audio")) {
      throw new Error("TTS unavailable");
    }
    const blob = await response.blob();
    const audio = new Audio(URL.createObjectURL(blob));
    await audio.play();
    await new Promise((resolve) => {
      audio.addEventListener("ended", resolve, { once: true });
      audio.addEventListener("error", resolve, { once: true });
    });
  } catch {
    await browserSpeak(text);
  }
}

function browserSpeak(text) {
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-CN";
    utterance.rate = 0.96;
    utterance.onend = resolve;
    utterance.onerror = resolve;
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
  });
}

function setSpeaking(active) {
  els.broadcastCard.classList.toggle("speaking", active);
  els.speakState.innerHTML = active ? "<span></span> Speaking..." : "<span></span> Ready";
  if (active) {
    state.speakingStartedAt = Date.now();
    window.clearInterval(state.speakingTimer);
    state.speakingTimer = window.setInterval(() => {
      els.speakTimer.textContent = formatTime((Date.now() - state.speakingStartedAt) / 1000);
      advanceTranscript();
    }, 350);
  } else {
    window.clearInterval(state.speakingTimer);
  }
}

function advanceTranscript() {
  const lines = els.transcript.querySelectorAll(".line");
  const elapsed = (Date.now() - state.speakingStartedAt) / 1000;
  const activeIndex = Math.min(Math.floor(elapsed / 4), lines.length - 1);
  lines.forEach((line, index) => line.classList.toggle("active", index === activeIndex));
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
  const parts = text.split(/(?<=[\u3002\uff01\uff1f.!?])/).map((item) => item.trim()).filter(Boolean);
  return (parts.length ? parts : [text]).map((line, index) => {
    if (index !== 0) return escapeHtml(line);
    const chars = line.split("");
    const start = chars.slice(0, Math.min(7, chars.length)).join("");
    const rest = chars.slice(start.length).join("");
    return `<mark>${escapeHtml(start)}</mark>${escapeHtml(rest)}`;
  });
}

function pushDj(text, shouldScroll = true) {
  els.chat.insertAdjacentHTML(
    "beforeend",
    `<div class="message dj"><div class="avatar"></div><div><div class="speaker">CLAUDIO</div><div class="bubble">${escapeHtml(text)}</div></div></div>`
  );
  if (shouldScroll) scrollToLatest();
}

function pushUser(text) {
  els.chat.insertAdjacentHTML(
    "beforeend",
    `<div class="message user"><div class="bubble">${escapeHtml(text)}</div><div class="avatar"></div></div>`
  );
  scrollToLatest();
}

function renderTrackCard(track, shouldScroll = true) {
  const status = track.url ? "" : " <span>metadata only</span>";
  els.chat.insertAdjacentHTML(
    "beforeend",
    `<div class="track-card"><strong>* ${escapeHtml(track.title ?? track.name)}</strong><span>${escapeHtml(track.artist)}</span>${status}</div>`
  );
  if (shouldScroll) scrollToLatest();
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
    state.profile.playlists.map((track) => ({ name: track.title ?? track.name, artist: track.artist })),
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

function tick() {
  const now = new Date();
  els.clock.textContent = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  els.weekday.textContent = now.toLocaleDateString("en-US", { weekday: "long" });
  els.dateLine.textContent = now.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase().replaceAll(" ", " - ");
}

function updateProgress() {
  const ratio = els.player.duration ? (els.player.currentTime / els.player.duration) * 100 : 0;
  els.progress.style.width = `${ratio}%`;
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

function scrollToLatest() {
  window.requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }));
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
