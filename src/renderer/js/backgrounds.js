import { store } from './store.js';

/**
 * Built-in canvas backgrounds. Pixel art is drawn with crisp, unsmoothed
 * scaling and always fills the screen without changing its proportions
 * (`cover` crops the edges; it never stretches).
 */
export const BACKGROUNDS = [
  {
    id: 'aurora',
    label: 'Northern lights',
    src: 'app://xodecode/assets/backgrounds/aurora.svg',
    fit: 'cover',
    pixelated: false,
    // Colour around the picture when you zoom out past its edges.
    base: '#04060f',
  },
  {
    id: 'sunset',
    label: 'Sunset lake',
    src: 'app://xodecode/assets/backgrounds/sunset.png',
    fit: 'cover',
    pixelated: true,
    base: '#1a0f24',
  },
  // Calm, dark scenes with slight motion (stilled by prefers-reduced-motion).
  {
    id: 'nebula',
    label: 'Quiet nebula',
    src: 'app://xodecode/assets/backgrounds/nebula.svg',
    fit: 'cover',
    pixelated: false,
    base: '#05061a',
  },
  {
    id: 'deepsea',
    label: 'Deep sea',
    src: 'app://xodecode/assets/backgrounds/deepsea.svg',
    fit: 'cover',
    pixelated: false,
    base: '#02060d',
  },
  {
    id: 'dusk-forest',
    label: 'Dusk forest',
    src: 'app://xodecode/assets/backgrounds/dusk-forest.svg',
    fit: 'cover',
    pixelated: false,
    base: '#0c0914',
  },
  {
    id: 'midnight-grid',
    label: 'Midnight grid',
    src: 'app://xodecode/assets/backgrounds/midnight-grid.svg',
    fit: 'cover',
    pixelated: false,
    base: '#03040b',
  },
];

export function findBackground(id) {
  return BACKGROUNDS.find((background) => background.id === id) || null;
}

/** Switch to a built-in background, or back to the dot grid with "none". */
export function setBackgroundPreset(id) {
  const preset = findBackground(id);
  if (!preset) {
    store.state.settings.backgroundPreset = '';
    store.state.settings.backgroundPixel = false;
    store.state.settings.backgroundBase = '';
    store.setSetting('background', '');
    return null;
  }
  store.state.settings.backgroundPreset = preset.id;
  store.state.settings.backgroundPixel = preset.pixelated;
  store.state.settings.backgroundFit = preset.fit;
  store.state.settings.backgroundBase = preset.base || '';
  store.setSetting('background', preset.src);
  return preset;
}
