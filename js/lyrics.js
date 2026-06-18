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
let lastTrackKey = null;

const lyricContainer = () => document.getElementById('lyric');

const lyricTrackKeyOf = (state) => {
  if (!state) return null;
  const artist = (state.artist || '').trim().toLowerCase();
  const title = (state.title || '').trim().toLowerCase();
  if (!artist && !title) return null;
  return `${artist}::${title}`;
};

const resetLyricProgress = () => {
  if (currentLine >= 0 && lyricElements[currentLine]) {
    lyricElements[currentLine].classList.remove('active');
  }

  currentLine = -1;

  const container = lyricContainer();
  if (container) {
    container.scrollTo({ top: 0, behavior: 'smooth' });
  }
};

const setLyricElements = (items) => {
  lyricElements = Array.from(items);
};

const appendLyricLine = (container, text, className = '') => {
  const p = document.createElement('p');
  p.textContent = text || ' ';
  if (className) {
    p.className = className;
  }
  container.appendChild(p);
  return p;
};

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

function renderLyricLoading() {
  const lyricEl = lyricContainer();
  if (!lyricEl) return;

  lastLyricHash = '::loading::';
  lyricLines = [];
  lyricElements = [];
  resetLyricProgress();

  const loader = document.createElement('div');
  loader.className = 'lyric-loading';
  loader.setAttribute('role', 'status');
  loader.setAttribute('aria-label', 'Loading lyrics');

  for (let i = 0; i < 3; i += 1) {
    loader.appendChild(document.createElement('span'));
  }

  lyricEl.replaceChildren(loader);
}

function renderLyric(text) {
  const lyricEl = lyricContainer();
  if (!lyricEl) return;

  const normalizedText = typeof text === 'string' ? text : '';
  const newHash = normalizedText ? normalizedText : '::empty::';
  if (newHash === lastLyricHash) return;
  lastLyricHash = newHash;

  lyricEl.replaceChildren();

  if (!normalizedText) {
    const emptyLine = appendLyricLine(lyricEl, 'Lyric not found :(', 'lyric-empty');
    lyricLines = [];
    setLyricElements([emptyLine]);
    resetLyricProgress();
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

    const fragment = document.createDocumentFragment();
    const elements = lyricLines.map(({ text: lineText }) => appendLyricLine(fragment, lineText));

    lyricEl.appendChild(fragment);
    setLyricElements(elements);
  } else {
    const fragment = document.createDocumentFragment();
    const elements = normalizedText
      .split('\n')
      .map((line) => appendLyricLine(fragment, line));

    lyricEl.appendChild(fragment);
    lyricLines = [];
    setLyricElements(elements);
  }

  resetLyricProgress();
}

function updatePlayerState(state) {
  if (!state) return;
  const nextTrackKey = lyricTrackKeyOf(state);
  const nextPos = Math.max(0, state.position_ms || 0);

  if (nextTrackKey && nextTrackKey !== lastTrackKey) {
    lastTrackKey = nextTrackKey;
    lastSyncPos = nextPos;
    lastSyncTime = performance.now();
    currentLine = -1;
    return;
  }

  if (state.status === 'playing') {
    const currentEstimatedPos = getAccuratePosition() - LYRIC_OFFSET_MS;
    const smallBackstep = nextPos < currentEstimatedPos && currentEstimatedPos - nextPos < 1500;
    const largeBackstep = nextPos < currentEstimatedPos && currentEstimatedPos - nextPos >= 3000;

    if (smallBackstep) {
      return;
    }

    if (largeBackstep) {
      resetLyricProgress();
    }
  }

  lastSyncPos = nextPos;
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
  let targetIndex = -1;

  for (let i = 0; i < lyricLines.length; i += 1) {
    if (positionMs + hysteresis >= lyricLines[i].time) {
      targetIndex = i;
    } else {
      break;
    }
  }

  if (targetIndex === -1) {
    return;
  }

  if (currentLine !== -1 && targetIndex < currentLine) {
    return;
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
    resetLyricProgress();
    renderLyricLoading();
  });
  store.subscribe('trackRestart', resetLyricProgress);
  store.subscribe('lyricsLoading', (loading) => {
    if (loading) {
      renderLyricLoading();
    }
  });
  store.subscribe('lyrics', (lyrics) => {
    renderLyric(lyrics);
  });

  const initialLyrics = store.getState()?.lyrics || '';
  renderLyric(initialLyrics);

  requestAnimationFrame(lyricLoop);
});
