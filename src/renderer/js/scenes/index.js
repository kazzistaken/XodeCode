import harbor from './harbor.js';
import canal from './canal.js';
import glen from './glen.js';
import reef from './reef.js';
import sunset from './sunset.js';
import lake from './lake.js';

/** Every animated scene, in the order the picker shows them. */
export const SCENES = [harbor, lake, sunset, canal, glen, reef];

export function findScene(id) {
  return SCENES.find((scene) => scene.id === id) || null;
}
