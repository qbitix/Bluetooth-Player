const FALLBACK_BACKGROUND = '#111';
let lastAppliedCover = null;
let backgroundRequestId = 0;

const proxiedBackgroundCoverUrl = (url) => {
  if (!url) return '';

  try {
    const parsed = new URL(url, window.location.href);
    if (parsed.origin === window.location.origin) {
      return parsed.href;
    }

    return new URL(`/cover.php?url=${encodeURIComponent(parsed.href)}`, window.location.href).href;
  } catch (err) {
    console.warn('Invalid cover URL for background:', url, err);
    return '';
  }
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const hexToRgb = (hex) => {
  const normalized = hex.replace('#', '').trim();
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return null;

  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  };
};

const rgbToHex = ({ r, g, b }) =>
  `#${[r, g, b].map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0')).join('')}`;

const rgbToHsl = ({ r, g, b }) => {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const lightness = (max + min) / 2;

  if (max === min) {
    return { hue: 0, saturation: 0, lightness };
  }

  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue = 0;

  if (max === rn) {
    hue = (gn - bn) / delta + (gn < bn ? 6 : 0);
  } else if (max === gn) {
    hue = (bn - rn) / delta + 2;
  } else {
    hue = (rn - gn) / delta + 4;
  }

  return { hue: hue / 6, saturation, lightness };
};

const mixRgb = (a, b, amount) => ({
  r: a.r + (b.r - a.r) * amount,
  g: a.g + (b.g - a.g) * amount,
  b: a.b + (b.b - a.b) * amount,
});

const darkenHex = (hex, amount = 0.58) => {
  const rgb = hexToRgb(hex);
  if (!rgb) return FALLBACK_BACKGROUND;
  return rgbToHex(mixRgb(rgb, { r: 0, g: 0, b: 0 }, amount));
};

const swatchInfo = (swatch) => {
  const hex = swatch?.getHex?.();
  const rgb = hex ? hexToRgb(hex) : null;
  if (!hex || !rgb) return null;

  return {
    hex,
    population: swatch.getPopulation?.() || 0,
    ...rgbToHsl(rgb),
  };
};

const scorePrimarySwatch = (swatch) => {
  if (!swatch) return -Infinity;

  const saturationScore = clamp(swatch.saturation, 0.08, 1);
  const lightnessPenalty = swatch.lightness < 0.16 || swatch.lightness > 0.86 ? 0.25 : 1;
  const balancedLightness = 1 - Math.abs(swatch.lightness - 0.52);

  return (swatch.population + 1) * saturationScore * balancedLightness * lightnessPenalty;
};

const scoreSecondarySwatch = (swatch) => {
  if (!swatch) return -Infinity;

  const targetDarkness = 1 - Math.abs(swatch.lightness - 0.24);
  return (swatch.population + 1) * (0.45 + swatch.saturation) * targetDarkness;
};

const chooseGradientColors = (palette) => {
  const swatches = Object.values(palette || {})
    .map(swatchInfo)
    .filter(Boolean);

  if (!swatches.length) {
    return ['#444', FALLBACK_BACKGROUND];
  }

  const primary = [...swatches].sort((a, b) => scorePrimarySwatch(b) - scorePrimarySwatch(a))[0];
  const secondary =
    [...swatches]
      .filter((swatch) => swatch.hex !== primary.hex && swatch.lightness <= primary.lightness + 0.1)
      .sort((a, b) => scoreSecondarySwatch(b) - scoreSecondarySwatch(a))[0]?.hex ||
    darkenHex(primary.hex);

  return [primary.hex, secondary];
};

const setFallbackBackground = () => {
  backgroundRequestId += 1;
  document.body.style.background = FALLBACK_BACKGROUND;
};

async function applyGradientFromCover(url) {
  const requestId = ++backgroundRequestId;
  const src = proxiedBackgroundCoverUrl(url);

  try {
    if (!src || src.startsWith('about:') || src.startsWith('http://0.0.0.0')) {
      setFallbackBackground();
      return;
    }

    const palette = await Vibrant.from(src).getPalette();
    if (requestId !== backgroundRequestId || lastAppliedCover !== url) {
      return;
    }

    const [dominantColor, secondaryColor] = chooseGradientColors(palette);

    document.body.style.transition = 'background 1.2s ease';
    document.body.style.background = `linear-gradient(145deg, ${dominantColor}, ${secondaryColor})`;
  } catch (e) {
    console.error('Image analysis error:', e);
    if (requestId === backgroundRequestId && lastAppliedCover === url) {
      document.body.style.background = FALLBACK_BACKGROUND;
    }
  }
}

window.addEventListener('load', () => {
  const img = document.getElementById('cover');
  if (!img) {
    console.warn('Cover element was not found, background will not be updated');
    return;
  }

  const store = window.playerStore;
  if (!store) {
    console.warn('playerStore was not found for background.js');
    return;
  }

  store.subscribe('cover', (url) => {
    if (!url) {
      lastAppliedCover = null;
      setFallbackBackground();
      return;
    }

    if (lastAppliedCover === url) return;
    lastAppliedCover = url;
    applyGradientFromCover(url);
  });

  const initialCover = store.getState()?.cover;
  if (initialCover) {
    lastAppliedCover = initialCover;
    applyGradientFromCover(initialCover);
  }
});
