const START_CONFIG = window.appConfig || {};
const parseStartNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const POLL_INTERVAL = parseStartNumber(START_CONFIG.pollIntervalMs, 1000);

const trackKeyOf = (state) => {
  if (!state) return null;
  const artist = (state.artist || "").trim().toLowerCase();
  const title = (state.title || "").trim().toLowerCase();
  if (!artist && !title) return null;
  return `${artist}::${title}`;
};

const msToTime = (ms) => {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = String(totalSec % 60).padStart(2, "0");
  return `${min}:${sec}`;
};

(function initPlayerStore() {
  const listeners = {
    state: new Set(),
    track: new Set(),
    cover: new Set(),
    lyrics: new Set(),
    error: new Set(),
  };

  let currentState = null;
  let lastUpdateTs = 0;
  let polling = false;
  let pollTimer = null;

  const coverCache = new Map();
  const lyricCache = new Map();

  const notify = (event, payload) => {
    const subs = listeners[event];
    if (!subs) return;
    subs.forEach((cb) => {
      try {
        cb(payload);
      } catch (err) {
        console.error(`playerStore listener error for "${event}":`, err);
      }
    });
  };

  const fetchAction = async (action) => {
    const res = await fetch("/action.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
      cache: "no-store",
    });

    if (!res.ok) {
      const error = new Error(`Запрос ${action} завершился со статусом ${res.status}`);
      notify("error", { action, error });
      throw error;
    }

    return res.json();
  };

  const fetchPlayState = async () => {
    try {
      const json = await fetchAction("playStats");
      return json?.data || null;
    } catch (err) {
      console.error("Ошибка playStats:", err);
      return null;
    }
  };

  const fetchCover = async (trackKey) => {
    if (coverCache.has(trackKey)) return coverCache.get(trackKey);

    const promise = fetchAction("GetArt")
      .then((json) => json?.link || null)
      .catch((err) => {
        console.error("Ошибка загрузки обложки:", err);
        return null;
      });

    coverCache.set(trackKey, promise);
    return promise;
  };

  const fetchLyrics = async (trackKey) => {
    if (lyricCache.has(trackKey)) return lyricCache.get(trackKey);

    const promise = fetchAction("GetLyric")
      .then((json) => (json?.status === "ok" ? json.lyrics : null))
      .catch((err) => {
        console.error("Ошибка загрузки текста:", err);
        return null;
      });

    lyricCache.set(trackKey, promise);
    return promise;
  };

  const poll = async (force = false) => {
    if (polling) return;
    polling = true;

    try {
      const nextState = await fetchPlayState();
      if (!nextState) return;

      const nextTrackKey = trackKeyOf(nextState);
      const prevTrackKey = trackKeyOf(currentState);

      currentState = { ...currentState, ...nextState };
      lastUpdateTs = performance.now();
      notify("state", { ...currentState });

      const trackChanged = force || nextTrackKey !== prevTrackKey;

      if (trackChanged && nextTrackKey) {
        notify("track", { ...currentState });

        const [cover, lyrics] = await Promise.all([
          fetchCover(nextTrackKey),
          fetchLyrics(nextTrackKey),
        ]);

        if (trackKeyOf(currentState) !== nextTrackKey) return;

        currentState = { ...currentState, cover, lyrics };
        notify("cover", cover);
        notify("lyrics", lyrics);
        notify("state", { ...currentState });
      }
    } catch (err) {
      console.error("Ошибка обновления состояния:", err);
    } finally {
      polling = false;
    }
  };

  const start = () => {
    poll(true);
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(poll, POLL_INTERVAL);
  };

  const subscribe = (event, handler) => {
    if (!listeners[event]) {
      throw new Error(`Неизвестное событие playerStore "${event}"`);
    }
    listeners[event].add(handler);
    return () => listeners[event].delete(handler);
  };

  const getState = () => (currentState ? { ...currentState } : null);
  const getLastUpdateTs = () => lastUpdateTs;

  window.playerStore = { start, subscribe, getState, getLastUpdateTs };
})();

let storeInstance = null;
let cachedState = null;
let renderedTrackKey = null;
let titleEl = null;
let artistEl = null;
let coverEl = null;
let fillEl = null;
let barEl = null;
let curEl = null;
let durEl = null;
let progressFrameId = null;
let playbackAnchor = {
  positionMs: 0,
  timestamp: 0,
  status: "stopped",
  trackKey: null,
};

const updateCover = (url) => {
  if (!coverEl) return;
  if (!url) return;

  if (coverEl.src === url) {
    if (coverEl.complete && coverEl.naturalWidth > 0) {
      coverEl.dispatchEvent(new Event("load"));
    }
    return;
  }

  coverEl.src = url;
};

const refreshAnchor = (state, { force = false } = {}) => {
  if (!state || typeof state.position_ms !== "number") return;
  const nextKey = trackKeyOf(state);
  const nextStatus = state.status || "stopped";
  const nextPos = state.position_ms;

  if (
    !force &&
    playbackAnchor.trackKey === nextKey &&
    playbackAnchor.status === nextStatus &&
    Math.abs(nextPos - playbackAnchor.positionMs) < 20
  ) {
    return;
  }

  playbackAnchor = {
    positionMs: nextPos,
    timestamp: performance.now(),
    status: nextStatus,
    trackKey: nextKey,
  };
};

const computePositionMs = () => {
  if (!cachedState) return 0;

  const duration = cachedState.duration_ms || 0;
  let position = playbackAnchor.positionMs ?? cachedState.position_ms ?? 0;

  if (cachedState.status === "playing" && playbackAnchor.timestamp) {
    const elapsed = performance.now() - playbackAnchor.timestamp;
    if (elapsed > 0) {
      position += elapsed;
    }
  }

  if (duration && position > duration) position = duration;
  if (position < 0) position = 0;
  return position;
};

const updateProgressBar = () => {
  if (!cachedState || !fillEl || !barEl || !curEl || !durEl) return;

  const duration = cachedState.duration_ms || 0;
  const position = computePositionMs();
  const percent = duration ? (position / duration) * 100 : 0;

  fillEl.style.width = `${percent}%`;
  barEl.style.setProperty("--pos", `${percent}%`);
  curEl.textContent = msToTime(position);
  durEl.textContent = msToTime(duration);
};

const progressLoop = () => {
  updateProgressBar();
  progressFrameId = requestAnimationFrame(progressLoop);
};

window.addEventListener("load", () => {
  storeInstance = window.playerStore;
  if (!storeInstance) {
    console.error("playerStore не найден");
    return;
  }

  titleEl = document.getElementById("title");
  artistEl = document.getElementById("artist");
  coverEl = document.getElementById("cover");
  fillEl = document.getElementById("fill");
  barEl = document.querySelector(".bar");
  curEl = document.getElementById("cur");
  durEl = document.getElementById("dur");

  if (!titleEl || !artistEl || !coverEl || !fillEl || !barEl || !curEl || !durEl) {
    console.warn("Не удалось инициализировать элементы интерфейса");
    return;
  }

  coverEl.crossOrigin = "anonymous";

  storeInstance.subscribe("state", (state) => {
    if (!state) return;
    cachedState = state;

    const key = trackKeyOf(state);
    const trackChanged = key && key !== renderedTrackKey;
    if (trackChanged) {
      renderedTrackKey = key;
      titleEl.textContent = state.title || "—";
      artistEl.textContent = state.artist || "—";
    }

    if (state.cover) updateCover(state.cover);
    refreshAnchor(state, { force: trackChanged });
    updateProgressBar();
  });

  storeInstance.subscribe("cover", (url) => updateCover(url));
  storeInstance.start();
  if (!progressFrameId) {
    progressFrameId = requestAnimationFrame(progressLoop);
  }
});
