const LYRICS_CONFIG = window.appConfig || {};
const lyricNumber = (key, fallback) => {
  const parsed = Number(LYRICS_CONFIG[key]);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const LYRIC_OFFSET_MS = lyricNumber('lyricOffsetMs', 0);
const LYRIC_HYSTERESIS_MS = lyricNumber('lyricHysteresisMs', 700);

let lyricLines = [];
let lyricElements = [];
let currentLine = -1;
let lastLyricHash = null;

let lastSyncPos = 0;
let lastSyncTime = 0;

const lyricContainer = () => document.getElementById('lyric');

const setActiveLine = (index) => {
  if (index === currentLine) return;
  if (index < 0 || index >= lyricElements.length) return;

  if (currentLine >= 0 && lyricElements[currentLine]) {
    lyricElements[currentLine].classList.remove('active');
  }

  currentLine = index;
  const el = lyricElements[currentLine];
  if (!el) return;

  el.classList.add('active');

  const container = lyricContainer();
  if (container) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
};

function renderLyric(text) {
  const lyricEl = lyricContainer();
  if (!lyricEl) return;

  const normalizedText = typeof text === 'string' ? text : '';
  const newHash = normalizedText ? normalizedText : '::empty::';
  if (newHash === lastLyricHash) return;
  lastLyricHash = newHash;

  lyricEl.innerHTML = '';

  if (!normalizedText) {
    lyricEl.innerHTML = '<p style="filter: blur(0px);" class="lyric-empty">Lyric not found 😔</p>';
    lyricLines = [];
    lyricElements = lyricEl.querySelectorAll('p');
    currentLine = -1;
    return;
  }

  if (/\[\d{2}:\d{2}(?:\.\d{2})?\]/.test(normalizedText)) {
    lyricLines = normalizedText
      .split('\n')
      .map((line) => {
        const match = line.match(/\[(\d{2}):(\d{2}(?:\.\d{2})?)\](.*)/);
        if (!match) return null;
        const min = parseInt(match[1], 10);
        const sec = parseFloat(match[2]);
        const timeMs = (min * 60 + sec) * 1000;
        const lyricText = match[3].trim();
        return { time: timeMs, text: lyricText };
      })
      .filter(Boolean);

    lyricLines.forEach(({ text: lineText }, idx) => {
      const p = document.createElement('p');
      p.textContent = lineText || ' ';
      lyricEl.appendChild(p);
    });

    lyricElements = lyricEl.querySelectorAll('p');
  } else {
    lyricEl.innerHTML = normalizedText
      .split('\n')
      .map((line) => `<p>${line}</p>`)
      .join('');
    lyricLines = [];
    lyricElements = lyricEl.querySelectorAll('p');
  }

  currentLine = -1;
}

function updatePlayerState(state) {
  if (!state) return;
  lastSyncPos = state.position_ms || 0;
  lastSyncTime = performance.now();
}

function getAccuratePosition() {
  if (!lastSyncTime) return 0;
  const delta = performance.now() - lastSyncTime;
  return lastSyncPos + delta + LYRIC_OFFSET_MS;
}

function updateLyricProgress(positionMs) {
  if (!lyricLines.length) return;

  const hysteresis = LYRIC_HYSTERESIS_MS;

  if (currentLine === -1) {
    const idx = lyricLines.findIndex((line) => positionMs + hysteresis >= line.time);
    if (idx !== -1) {
      setActiveLine(idx);
    }
    return;
  }

  let targetIndex = currentLine;

  while (
    targetIndex < lyricLines.length - 1 &&
    positionMs + hysteresis >= lyricLines[targetIndex + 1].time
  ) {
    targetIndex += 1;
  }

  while (
    targetIndex > 0 &&
    positionMs < lyricLines[targetIndex].time - hysteresis
  ) {
    targetIndex -= 1;
  }

  if (targetIndex !== currentLine) {
    setActiveLine(targetIndex);
  }
}

function lyricLoop() {
  const pos = getAccuratePosition();
  updateLyricProgress(pos);
  requestAnimationFrame(lyricLoop);
}

window.addEventListener('load', () => {
  const store = window.playerStore;
  if (!store) {
    console.warn('playerStore not found');
    return;
  }

  store.subscribe('state', updatePlayerState);
  store.subscribe('track', () => {
    lastLyricHash = null;
    currentLine = -1;
    renderLyric(store.getState()?.lyrics || '');
  });
  store.subscribe('lyrics', (lyrics) => {
    renderLyric(lyrics);
  });

  const initialLyrics = store.getState()?.lyrics || '';
  renderLyric(initialLyrics);

  requestAnimationFrame(lyricLoop);
});
