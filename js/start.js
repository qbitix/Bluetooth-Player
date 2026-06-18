const START_CONFIG = window.appConfig || {};
const parseStartNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const POLL_INTERVAL = parseStartNumber(START_CONFIG.pollIntervalMs, 1000);
const WS_PORT = parseStartNumber(START_CONFIG.webSocketPort, 8080);
const WS_RECONNECT_MS = 3000;
const CONTROL_HTTP_TIMEOUT_MS = 1200;
const COVER_HTTP_TIMEOUT_MS = 20000;
const COVER_BEFORE_LYRICS_DELAY_MS = 250;
const SHOW_WEB_ERRORS = START_CONFIG.showWebErrors !== false;
const WEB_ERROR_TIMEOUT_MS = 7000;
const WEB_ERROR_LIMIT = 4;
const WS_ERROR_COOLDOWN_MS = 10000;
const RESTART_BACKSTEP_MS = 3000;
const RESTART_START_WINDOW_MS = 10000;
const UNKNOWN_METADATA_VALUES = new Set(["", "unknown", "unknown artist", "unknown title"]);

const buildWebSocketUrl = () => {
  if (typeof START_CONFIG.webSocketUrl === "string" && START_CONFIG.webSocketUrl.trim()) {
    return START_CONFIG.webSocketUrl.trim();
  }

  if (!window.location.hostname) return null;

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.hostname}:${WS_PORT}/ws`;
};

const buildControlUrl = () => {
  if (typeof START_CONFIG.playerControlUrl === "string" && START_CONFIG.playerControlUrl.trim()) {
    return START_CONFIG.playerControlUrl.trim();
  }

  const wsUrl = buildWebSocketUrl();
  if (!wsUrl) return null;

  return wsUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:").replace(/\/ws$/, "/control");
};

const trackKeyOf = (state) => {
  if (!state) return null;
  const artist = (state.artist || "").trim().toLowerCase();
  const title = (state.title || "").trim().toLowerCase();
  if (!artist && !title) return null;
  return `${artist}::${title}`;
};

const hasSearchableMetadata = (state) => {
  if (!state) return false;
  const artist = (state.artist || "").trim().toLowerCase();
  const title = (state.title || "").trim().toLowerCase();
  return !UNKNOWN_METADATA_VALUES.has(artist) && !UNKNOWN_METADATA_VALUES.has(title);
};

const msToTime = (ms) => {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = String(totalSec % 60).padStart(2, "0");
  return `${min}:${sec}`;
};

const proxiedCoverUrl = (url) => {
  if (!url) return "";

  try {
    const parsed = new URL(url, window.location.href);
    if (parsed.origin === window.location.origin) {
      return parsed.href;
    }

    return new URL(`/cover.php?url=${encodeURIComponent(parsed.href)}`, window.location.href).href;
  } catch (err) {
    console.warn("Invalid cover URL:", url, err);
    return "";
  }
};

(function initPlayerStore() {
  const listeners = {
    state: new Set(),
    track: new Set(),
    trackRestart: new Set(),
    timeline: new Set(),
    lyricsLoading: new Set(),
    cover: new Set(),
    lyrics: new Set(),
    error: new Set(),
  };

  let currentState = null;
  let lastUpdateTs = 0;
  let polling = false;
  let pollTimer = null;
  let socket = null;
  let reconnectTimer = null;
  let usingFallbackPoll = false;
  let lastWebSocketErrorTs = 0;
  let activeLyricRequest = null;
  let pendingLyricRequest = null;

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

  const fetchAction = async (action, payload = {}, options = {}) => {
    let res = null;

    try {
      res = await fetch("/action.php", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...payload }),
        cache: "no-store",
        signal: options.signal,
      });
    } catch (err) {
      if (err?.name === "AbortError") {
        throw err;
      }

      const error = err instanceof Error ? err : new Error(String(err));
      error.webReported = true;
      notify("error", { action, error });
      throw error;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const error = new Error(body || `Request ${action} failed with status ${res.status}`);
      error.webReported = true;
      notify("error", { action, error });
      throw error;
    }

    try {
      return await res.json();
    } catch (err) {
      const error = new Error(`Invalid JSON response for ${action}`);
      error.webReported = true;
      notify("error", { action, error });
      throw error;
    }
  };

  const fetchPlayState = async () => {
    try {
      const json = await fetchAction("playStats");
      return json?.data || null;
    } catch (err) {
      console.error("playStats error:", err);
      return null;
    }
  };

  const applyOptimisticControl = (command) => {
    if (!currentState) return null;

    const previousState = { ...currentState };
    let nextState = null;

    if (command === "play") {
      nextState = { ...currentState, status: "playing" };
    } else if (command === "pause") {
      nextState = { ...currentState, status: "paused" };
    } else if (command === "playPause") {
      nextState = {
        ...currentState,
        status: currentState.status === "playing" ? "paused" : "playing",
      };
    } else if (command === "previous" || command === "next") {
      nextState = { ...currentState, position_ms: 0 };
    }

    if (!nextState) return previousState;

    currentState = nextState;
    lastUpdateTs = performance.now();
    if (command === "previous" || command === "next") {
      notify("timeline", { ...currentState });
    }
    notify("state", { ...currentState });
    return previousState;
  };

  const controlViaHttp = async (command) => {
    const url = buildControlUrl();
    if (url) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CONTROL_HTTP_TIMEOUT_MS);

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command }),
          cache: "no-store",
          signal: controller.signal,
        });

        const json = await res.json().catch(() => ({}));
        if (!res.ok || json?.status !== "ok") {
          throw new Error(json?.error || `Command ${command} failed with status ${res.status}`);
        }

        return json;
      } catch (err) {
        console.warn("Direct control endpoint is unavailable, using PHP fallback:", err);
      } finally {
        clearTimeout(timeout);
      }
    }

    return fetchAction("PlayerCommand", { command });
  };

  const control = async (command) => {
    const previousState = applyOptimisticControl(command);

    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "control", command }));
      return { status: "ok", transport: "websocket" };
    }

    try {
      return await controlViaHttp(command);
    } catch (err) {
      if (previousState) {
        currentState = previousState;
        notify("state", { ...currentState });
      }

      throw err;
    }
  };

  const startFallbackPolling = () => {
    if (usingFallbackPoll) return;
    usingFallbackPoll = true;
    poll(true);
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(poll, POLL_INTERVAL);
  };

  const stopFallbackPolling = () => {
    usingFallbackPoll = false;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  const fetchCover = async (trackKey, state) => {
    if (coverCache.has(trackKey)) return coverCache.get(trackKey);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), COVER_HTTP_TIMEOUT_MS);

    const promise = fetchAction(
      "GetArt",
      {
        artist: state?.artist || "",
        title: state?.title || "",
      },
      { signal: controller.signal }
    )
      .then((json) => {
        if (json?.status === "not_found") {
          const message = `Cover not found: ${json.artist || "—"} - ${json.title || "—"}`;
          console.warn(message);
          notify("error", {
            action: "GetArt",
            title: "Cover not found",
            error: new Error(message),
          });
          return null;
        }

        return json?.link || null;
      })
      .catch((err) => {
        coverCache.delete(trackKey);
        if (err?.name === "AbortError") {
          notify("error", {
            action: "GetArt",
            title: "Cover request timed out",
            error: new Error(`Cover request timed out: ${state?.artist || "—"} - ${state?.title || "—"}`),
          });
          return null;
        }

        console.error("Cover loading error:", err);
        notify("error", {
          action: "GetArt",
          title: "Cover loading error",
          error: err instanceof Error ? err : new Error(String(err)),
        });
        return null;
      })
      .finally(() => {
        clearTimeout(timeout);
      });

    coverCache.set(trackKey, promise);
    return promise;
  };

  const fetchLyrics = async (trackKey, state) => {
    if (lyricCache.has(trackKey)) return lyricCache.get(trackKey);

    let shouldCache = true;
    const promise = fetchAction(
      "GetLyric",
      {
        artist: state?.artist || "",
        title: state?.title || "",
      }
    )
      .then((json) => {
        if (json?.status === "not_found") {
          console.warn(`Lyrics not found: ${json.artist || "—"} - ${json.title || "—"}`);
          return null;
        }

        return json?.status === "ok" ? json.lyrics : null;
      })
      .catch((err) => {
        shouldCache = false;
        console.error("Lyrics loading error:", err);
        return null;
      });

    const cachedPromise = promise.then((lyrics) => {
      if (shouldCache) {
        lyricCache.set(trackKey, Promise.resolve(lyrics));
      }
      return lyrics;
    });

    return cachedPromise;
  };

  const applyLyricsResult = (trackKey, lyrics) => {
    if (trackKeyOf(currentState) !== trackKey) return false;

    currentState = { ...currentState, lyrics };
    notify("lyricsLoading", false);
    notify("lyrics", lyrics);
    notify("state", { ...currentState });
    return true;
  };

  const startQueuedLyricRequest = ({ trackKey, state }) => {
    activeLyricRequest = { trackKey };

    fetchLyrics(trackKey, state)
      .then((lyrics) => {
        applyLyricsResult(trackKey, lyrics);
      })
      .finally(() => {
        activeLyricRequest = null;

        const nextRequest = pendingLyricRequest;
        pendingLyricRequest = null;

        if (nextRequest && trackKeyOf(currentState) === nextRequest.trackKey) {
          startQueuedLyricRequest(nextRequest);
        }
      });
  };

  const queueLyricRequest = (trackKey, state) => {
    if (lyricCache.has(trackKey)) {
      fetchLyrics(trackKey, state).then((lyrics) => {
        applyLyricsResult(trackKey, lyrics);
      });
      return;
    }

    const request = { trackKey, state: { ...state } };
    if (activeLyricRequest) {
      pendingLyricRequest = request;
      return;
    }

    startQueuedLyricRequest(request);
  };

  const isSameTrackRestart = (nextTrackKey, nextPositionMs) => {
    if (!currentState || !nextTrackKey || trackKeyOf(currentState) !== nextTrackKey) {
      return false;
    }

    const prevPositionMs = Number(currentState.position_ms);
    if (!Number.isFinite(prevPositionMs) || !Number.isFinite(nextPositionMs)) {
      return false;
    }

    return (
      prevPositionMs - nextPositionMs >= RESTART_BACKSTEP_MS &&
      nextPositionMs <= RESTART_START_WINDOW_MS
    );
  };

  const applyPlayState = (nextState, force = false) => {
    if (!nextState) return;
    const nextTrackKey = trackKeyOf(nextState);
    const prevTrackKey = trackKeyOf(currentState);
    const trackChanged = force || nextTrackKey !== prevTrackKey;
    const trackRestarted = !trackChanged && isSameTrackRestart(nextTrackKey, nextState.position_ms);

    currentState = { ...currentState, ...nextState };
    if (trackChanged) {
      currentState = { ...currentState, cover: null, lyrics: null };
    }

    lastUpdateTs = performance.now();
    notify("state", { ...currentState });

    if (trackChanged && nextTrackKey) {
      notify("track", { ...currentState });

      if (!hasSearchableMetadata(currentState)) {
        console.warn("Skipping cover and lyrics lookup for unknown metadata:", currentState.artist, currentState.title);
        notify("cover", null);
        notify("lyricsLoading", false);
        notify("lyrics", null);
        return;
      }

      notify("lyricsLoading", true);

      const loadLyrics = () => {
        if (trackKeyOf(currentState) !== nextTrackKey) return;
        queueLyricRequest(nextTrackKey, currentState);
      };

      fetchCover(nextTrackKey, currentState).then((cover) => {
        if (trackKeyOf(currentState) !== nextTrackKey) return;

        currentState = { ...currentState, cover };
        notify("cover", cover);
        notify("state", { ...currentState });

        window.setTimeout(loadLyrics, cover ? COVER_BEFORE_LYRICS_DELAY_MS : 0);
      });
    } else if (trackRestarted) {
      notify("trackRestart", { ...currentState });
    }
  };

  const applyTimeline = (timeline) => {
    if (!timeline || !currentState) return;
    const nextTrackKey = timeline.track_key || trackKeyOf(currentState);
    if (nextTrackKey && trackKeyOf(currentState) !== nextTrackKey) return;
    const trackRestarted = isSameTrackRestart(nextTrackKey, timeline.position_ms);

    currentState = {
      ...currentState,
      position_ms: timeline.position_ms,
      duration_ms: timeline.duration_ms ?? currentState.duration_ms,
      status: timeline.status || currentState.status,
      updated: timeline.updated || currentState.updated,
    };

    lastUpdateTs = performance.now();
    if (trackRestarted) {
      notify("trackRestart", { ...currentState });
    }
    notify("timeline", { ...currentState });
    notify("state", { ...currentState });
  };

  const poll = async (force = false) => {
    if (polling) return;
    polling = true;

    try {
      const nextState = await fetchPlayState();
      applyPlayState(nextState, force);
    } catch (err) {
      console.error("State update error:", err);
    } finally {
      polling = false;
    }
  };

  const connectWebSocket = () => {
    const url = buildWebSocketUrl();
    if (!url || !("WebSocket" in window)) {
      startFallbackPolling();
      return;
    }

    if (socket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(socket.readyState)) {
      return;
    }

    socket = new WebSocket(url);

    socket.addEventListener("open", () => {
      stopFallbackPolling();
    });

    socket.addEventListener("message", (event) => {
      try {
        const json = JSON.parse(event.data);
        if (json?.type === "timeline") {
          applyTimeline(json.data);
          return;
        }

        if (json?.type === "controlResult") {
          if (json.data?.status !== "ok") {
            console.error("Player control error:", json.data?.error || json.data);
            notify("error", {
              action: "PlayerCommand",
              error: new Error(json.data?.error || "Player command failed"),
            });
            poll(true);
          }
          return;
        }

        const state = json?.type === "playerState" ? json.data : json;
        applyPlayState(state);
      } catch (err) {
        console.error("WebSocket message handling error:", err);
      }
    });

    socket.addEventListener("error", (event) => {
      const now = Date.now();
      console.warn("Player state WebSocket is unavailable:", event);

      if (now - lastWebSocketErrorTs >= WS_ERROR_COOLDOWN_MS) {
        lastWebSocketErrorTs = now;
        notify("error", {
          action: "WebSocket",
          error: new Error("Could not connect to the player WebSocket"),
        });
      }
    });

    socket.addEventListener("close", () => {
      startFallbackPolling();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectWebSocket, WS_RECONNECT_MS);
    });
  };

  const start = () => {
    connectWebSocket();
  };

  const subscribe = (event, handler) => {
    if (!listeners[event]) {
      throw new Error(`Unknown playerStore event "${event}"`);
    }
    listeners[event].add(handler);
    return () => listeners[event].delete(handler);
  };

  const getState = () => (currentState ? { ...currentState } : null);
  const getLastUpdateTs = () => lastUpdateTs;

  window.playerStore = { start, subscribe, getState, getLastUpdateTs, control };
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
let prevBtn = null;
let playBtn = null;
let nextBtn = null;
let playIconEl = null;
let webErrorsEl = null;
let defaultCoverSrc = "";
let lastCoverImageErrorSrc = "";
let lastStateError = "";
let progressFrameId = null;
let playbackAnchor = {
  positionMs: 0,
  timestamp: 0,
  status: "stopped",
  trackKey: null,
};

const CONTROL_ICON = {
  play: "/style/icons/play-button.png",
  pause: "/style/icons/pause.png",
};

const setControlsDisabled = (disabled) => {
  [prevBtn, playBtn, nextBtn].forEach((button) => {
    if (button) button.disabled = disabled;
  });
};

const showWebError = (title, details = "") => {
  if (!SHOW_WEB_ERRORS) return;
  if (!webErrorsEl) {
    webErrorsEl = document.getElementById("web-errors");
  }
  if (!webErrorsEl) return;

  const item = document.createElement("div");
  item.className = "web-error";
  item.setAttribute("role", "status");

  const textWrap = document.createElement("div");
  const titleElNode = document.createElement("p");
  titleElNode.className = "web-error__title";
  titleElNode.textContent = title || "Error";
  textWrap.appendChild(titleElNode);

  if (details) {
    const detailsEl = document.createElement("p");
    detailsEl.className = "web-error__details";
    detailsEl.textContent = details;
    textWrap.appendChild(detailsEl);
  }

  const closeBtn = document.createElement("button");
  closeBtn.className = "web-error__close";
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Dismiss error");
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => item.remove());

  item.append(textWrap, closeBtn);
  webErrorsEl.appendChild(item);

  while (webErrorsEl.children.length > WEB_ERROR_LIMIT) {
    webErrorsEl.firstElementChild?.remove();
  }

  setTimeout(() => item.remove(), WEB_ERROR_TIMEOUT_MS);
};

const errorMessageOf = (err) => {
  if (!err) return "";
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
};

const notifyStateError = (state) => {
  if (!state || state.status !== "error") {
    lastStateError = "";
    return;
  }

  const message = state.message || state.error || "Backend returned an error state";
  if (message === lastStateError) return;

  lastStateError = message;
  showWebError("Player error", message);
};

const sendPlayerCommand = async (command) => {
  setControlsDisabled(true);

  try {
    await storeInstance?.control(command);
  } catch (err) {
    console.error("Player control error:", err);
    if (!err?.webReported) {
      showWebError("Could not run player command", errorMessageOf(err));
    }
  } finally {
    setControlsDisabled(false);
  }
};

const updatePlayButton = (state) => {
  if (!playIconEl || !playBtn) return;
  const isPlaying = state?.status === "playing";
  playIconEl.src = isPlaying ? CONTROL_ICON.pause : CONTROL_ICON.play;
  playBtn.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
};

const updateCover = (url) => {
  if (!coverEl) return;
  const nextUrl = url ? proxiedCoverUrl(url) : defaultCoverSrc;
  if (!nextUrl) return;

  if (coverEl.src === nextUrl) {
    if (url && coverEl.complete && coverEl.naturalWidth > 0) {
      coverEl.dispatchEvent(new Event("load"));
    }
    return;
  }

  coverEl.dataset.coverSource = url || "";
  coverEl.dataset.coverFallbackTried = "";
  coverEl.src = nextUrl;
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
    console.error("playerStore was not found");
    return;
  }

  titleEl = document.getElementById("title");
  artistEl = document.getElementById("artist");
  coverEl = document.getElementById("cover");
  fillEl = document.getElementById("fill");
  barEl = document.querySelector(".bar");
  curEl = document.getElementById("cur");
  durEl = document.getElementById("dur");
  prevBtn = document.querySelector(".btns .prev");
  playBtn = document.querySelector(".btns .playing");
  nextBtn = document.querySelector(".btns .next");
  playIconEl = playBtn?.querySelector("img") || null;
  webErrorsEl = document.getElementById("web-errors");

  if (!titleEl || !artistEl || !coverEl || !fillEl || !barEl || !curEl || !durEl) {
    console.warn("Could not initialize UI elements");
    return;
  }

  coverEl.removeAttribute("crossorigin");
  defaultCoverSrc = coverEl.currentSrc || coverEl.src || "";
  coverEl.addEventListener("error", () => {
    const failedSrc = coverEl.currentSrc || coverEl.src || "";
    const originalSrc = coverEl.dataset.coverSource || "";

    if (!failedSrc || failedSrc === defaultCoverSrc) return;

    if (originalSrc && coverEl.dataset.coverFallbackTried !== "direct" && failedSrc !== originalSrc) {
      coverEl.dataset.coverFallbackTried = "direct";
      console.warn("Cover proxy failed, trying original URL:", originalSrc);
      coverEl.src = originalSrc;
      return;
    }

    if (failedSrc === lastCoverImageErrorSrc) return;

    lastCoverImageErrorSrc = failedSrc;
    showWebError("Cover image failed to load", failedSrc);
    if (defaultCoverSrc) {
      coverEl.src = defaultCoverSrc;
    }
  });

  prevBtn?.addEventListener("click", () => sendPlayerCommand("previous"));
  playBtn?.addEventListener("click", () => sendPlayerCommand("playPause"));
  nextBtn?.addEventListener("click", () => sendPlayerCommand("next"));

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

    if ("cover" in state) updateCover(state.cover);
    updatePlayButton(state);
    notifyStateError(state);
    refreshAnchor(state, { force: trackChanged });
    updateProgressBar();
  });

  storeInstance.subscribe("cover", (url) => updateCover(url));
  storeInstance.subscribe("error", ({ action, title, error }) => {
    showWebError(title || `Request error ${action || ""}`.trim(), errorMessageOf(error));
  });
  storeInstance.start();
  if (!progressFrameId) {
    progressFrameId = requestAnimationFrame(progressLoop);
  }
});

window.addEventListener("error", (event) => {
  showWebError("JavaScript error", event.message || "Unknown error");
});

window.addEventListener("unhandledrejection", (event) => {
  showWebError("JavaScript error", errorMessageOf(event.reason));
});
