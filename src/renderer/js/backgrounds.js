import { store } from './store.js';
import { SCENES } from './scenes/index.js';

/**
 * Built-in backgrounds: animated pixel-art scenes (scenes/), drawn behind the
 * canvas and filling the screen whatever the zoom.
 */
export const BACKGROUNDS = SCENES.map((scene) => ({ id: scene.id, label: scene.label, scene: scene.id, base: scene.base }));

/** Words people use for each scene, plus the names of the old backgrounds. */
const ALIASES = {
  harbor: ['harbour', 'harbor', 'lighthouse', 'lantern', 'port', 'dusk'],
  lake: ['lake', 'moon', 'moonlit', 'mountain', 'mountains', 'night', 'aurora', 'northern lights', 'nebula', 'space', 'stars'],
  sunset: ['sunset', 'sunset lake', 'sun', 'evening'],
  canal: ['canal', 'rain', 'rainy', 'city', 'midnight', 'midnight grid', 'midnight-grid'],
  glen: ['glen', 'waterfall', 'forest', 'dusk forest', 'dusk-forest', 'woods'],
  reef: ['reef', 'coral', 'underwater', 'ocean', 'sea', 'deep sea', 'deepsea', 'fish'],
};

export function findBackground(id) {
  const key = String(id || '').toLowerCase().trim();
  const direct = BACKGROUNDS.find((background) => background.id === key);
  if (direct) return direct;
  for (const [sceneId, words] of Object.entries(ALIASES)) {
    if (words.includes(key)) return BACKGROUNDS.find((background) => background.id === sceneId) || null;
  }
  return null;
}

/** Switch to a built-in scene, or back to the dot grid with "none". */
export function setBackgroundPreset(id) {
  const settings = store.state.settings;
  const preset = findBackground(id);
  if (!preset) {
    settings.backgroundPreset = '';
    settings.backgroundScene = '';
    settings.backgroundPixel = false;
    settings.backgroundBase = '';
    store.setSetting('background', '');
    return null;
  }
  settings.backgroundPreset = preset.id;
  settings.backgroundScene = preset.scene;
  settings.backgroundPixel = true;
  settings.backgroundBase = preset.base;
  store.setSetting('background', `scene:${preset.scene}`);
  return preset;
}

/** Profiles from before the scenes used picture files; move them over. */
export function migrateBackground() {
  const settings = store.state.settings;
  if (settings.backgroundPreset && !String(settings.background || '').startsWith('scene:')) {
    setBackgroundPreset(settings.backgroundPreset);
  }
}
