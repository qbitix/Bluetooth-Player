const FALLBACK_BACKGROUND = '#111';
let lastAppliedCover = null;

async function applyGradientFromImage(img) {
  try {
    const src = img?.src;
    if (!src || src.startsWith('about:') || src.startsWith('http://0.0.0.0')) {
      document.body.style.background = FALLBACK_BACKGROUND;
      return;
    }

    const palette = await Vibrant.from(src).getPalette();

    const dominantColor =
      palette?.Vibrant?.getHex() ||
      palette?.Muted?.getHex() ||
      palette?.LightVibrant?.getHex() ||
      '#444';

    const secondaryColor =
      palette?.DarkMuted?.getHex() ||
      palette?.DarkVibrant?.getHex() ||
      FALLBACK_BACKGROUND;

    document.body.style.transition = 'background 1.2s ease';
    document.body.style.background = `linear-gradient(145deg, ${dominantColor}, ${secondaryColor})`;
  } catch (e) {
    console.error('Ошибка анализа изображения:', e);
    document.body.style.background = FALLBACK_BACKGROUND;
  }
}

window.addEventListener('load', () => {
  const img = document.getElementById('cover');
  if (!img) {
    console.warn('cover элемент не найден, фон не будет обновлён');
    return;
  }

  const tryApplyGradient = () => {
    if (!img.complete || img.naturalWidth === 0) return;
    if (lastAppliedCover === img.src) return;
    lastAppliedCover = img.src;
    applyGradientFromImage(img);
  };

  img.addEventListener('load', tryApplyGradient);

  const store = window.playerStore;
  if (!store) {
    console.warn('playerStore не найден для background.js');
    return;
  }

  store.subscribe('cover', (url) => {
    if (!url) {
      document.body.style.background = FALLBACK_BACKGROUND;
      return;
    }

    if (img.src === url) {
      tryApplyGradient();
    }
  });

  const initialCover = store.getState()?.cover;
  if (initialCover && img.src === initialCover && img.complete) {
    tryApplyGradient();
  }
});
