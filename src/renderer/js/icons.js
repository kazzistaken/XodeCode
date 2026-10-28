const wrap = (inner) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

export const icons = {
  /* tools */
  cursor: wrap('<path d="M5.5 3.2 19 9.9l-5.9 1.4-1.5 5.9z" />'),
  hand: wrap(
    '<path d="M9 11V6.4a1.4 1.4 0 0 1 2.8 0V11m0-1.2V5.3a1.4 1.4 0 0 1 2.8 0V11m0-1.3V6.9a1.4 1.4 0 0 1 2.8 0V12m0-1.1a1.4 1.4 0 0 1 2.8 0v4.3A6.2 6.2 0 0 1 13.8 21h-1.6A6.2 6.2 0 0 1 6 14.8v-2.1a1.4 1.4 0 0 1 2.8 0" />'
  ),
  square: wrap('<rect x="4" y="4" width="16" height="16" rx="2.5" />'),
  diamond: wrap('<path d="M12 3.2 20.8 12 12 20.8 3.2 12z" />'),
  circle: wrap('<circle cx="12" cy="12" r="8.4" />'),
  arrow: wrap('<path d="M4.5 19.5 19.5 4.5M19.5 4.5h-6.4M19.5 4.5v6.4" />'),
  line: wrap('<path d="M4.5 19.5 19.5 4.5" />'),
  pen: wrap('<path d="M3.5 20.5l1-4 11.4-11.4 3 3L7.5 19.5z" /><path d="M14.4 6.6l3 3" />'),
  text: wrap('<path d="M5 6.5h14M12 6.5v11M9 17.5h6" />'),
  note: wrap('<path d="M5 4.5h9l5 5v10H5z" /><path d="M14 4.5v5h5" />'),
  image: wrap(
    '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><circle cx="9" cy="10" r="1.6" /><path d="M4.5 17.5l4.6-4.4 3.6 3.4 2.6-2.4 4.2 4" />'
  ),
  globe: wrap(
    '<circle cx="12" cy="12" r="8.4" /><path d="M3.6 12h16.8M12 3.6c2.2 2.4 3.3 5.3 3.3 8.4S14.2 18 12 20.4C9.8 18 8.7 15.1 8.7 12S9.8 6 12 3.6z" />'
  ),

  /* the app's own mark: four agents linked to the Director (scripts/make-icon.mjs) */
  xodecode: `<svg viewBox="0 0 11 11" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true"><path fill-rule="evenodd" d="M0 0h2v2H0zM9 0h2v2H9zM0 9h2v2H0zM9 9h2v2H9zM4 4h3v3H4zM5 5h1v1H5z" /><path opacity=".55" d="M2 2h1v1H2zM3 3h1v1H3zM8 2h1v1H8zM7 3h1v1H7zM3 7h1v1H3zM2 8h1v1H2zM7 7h1v1H7zM8 8h1v1H8z" /></svg>`,

  /* agents */
  // Claude's logo (assets/claude.png), drawn as-is.
  claude: `<svg viewBox="0 0 24 24" aria-hidden="true"><image href="../../assets/claude.png" width="24" height="24" /></svg>`,
  terminal: wrap('<rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="M7.5 9.5l2.8 2.8-2.8 2.8M13 15h4" />'),
  shell: wrap('<path d="M5 7.5 9 12l-4 4.5M12.5 16.5H19" />'),
  sparkle: wrap('<path d="M12 3.6l1.9 5.5 5.5 1.9-5.5 1.9L12 18.4l-1.9-5.5L4.6 11l5.5-1.9z" />'),

  /* ui */
  x: wrap('<path d="M6.2 6.2l11.6 11.6M17.8 6.2 6.2 17.8" />'),
  expand: wrap('<path d="M4.5 9.5V4.5h5M19.5 14.5v5h-5M14.5 4.5h5v5M9.5 19.5h-5v-5" />'),
  grid: wrap('<rect x="4" y="4" width="7" height="7" rx="1.6" /><rect x="13" y="4" width="7" height="7" rx="1.6" /><rect x="4" y="13" width="7" height="7" rx="1.6" /><rect x="13" y="13" width="7" height="7" rx="1.6" />'),
  map: wrap('<path d="M9 4.5 3.5 6.8v12.7L9 17.2l6 2.3 5.5-2.3V4.5L15 6.8z" /><path d="M9 4.5v12.7M15 6.8v12.7" />'),
  gear: wrap(
    '<circle cx="12" cy="12" r="3.1" /><path d="M12 3.4v2.1M12 18.5v2.1M20.6 12h-2.1M5.5 12H3.4M18.1 5.9l-1.5 1.5M7.4 16.6l-1.5 1.5M18.1 18.1l-1.5-1.5M7.4 7.4 5.9 5.9" />'
  ),
  panel: wrap('<rect x="3" y="4.5" width="18" height="15" rx="2.5" /><path d="M15 4.5v15" />'),
  plus: wrap('<path d="M12 5.5v13M5.5 12h13" />'),
  trash: wrap('<path d="M4.5 7h15M9.5 7V4.8h5V7M6.8 7l.9 12.4h8.6L17.2 7" />'),
  check: wrap('<path d="M5 12.5l4.2 4.2L19 6.8" />'),
  folder: wrap('<path d="M3.5 7.2a2 2 0 0 1 2-2h3.6l1.8 2.1h7.6a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />'),
  broom: wrap('<path d="M14.5 3.5 9.8 8.2M6.2 20.5c2.4-1 3.6-3 4.6-5.3l2.9-6.4 4.2 4.2-6.4 2.9c-2.3 1-4.3 2.2-5.3 4.6z" />'),
  voice: wrap('<path d="M12 3.5a2.8 2.8 0 0 0-2.8 2.8v5.4a2.8 2.8 0 0 0 5.6 0V6.3A2.8 2.8 0 0 0 12 3.5z" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" /><path d="M12 18v2.5" />'),
  sound: wrap('<path d="M4.5 9.5h3l4-3.4v11.8l-4-3.4h-3z" /><path d="M15.2 9.2a4 4 0 0 1 0 5.6M17.8 6.8a7.5 7.5 0 0 1 0 10.4" />'),
  style: wrap('<circle cx="12" cy="12" r="8.4" /><circle cx="9.4" cy="9.6" r="1.1" /><circle cx="14.6" cy="9.6" r="1.1" /><circle cx="9.4" cy="14.4" r="1.1" /><circle cx="14.6" cy="14.4" r="1.1" />'),
  shortcuts: wrap('<rect x="3" y="6" width="18" height="12" rx="2.4" /><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" />'),
  summarizer: wrap('<path d="M4.5 6.5h15M4.5 12h10M4.5 17.5h6" />'),
  agents: wrap('<rect x="4" y="7.5" width="16" height="11" rx="2.6" /><path d="M12 4.5v3M9 13h.01M15 13h.01M9.5 16.5h5" />'),
  pocket: wrap('<rect x="6" y="3" width="12" height="18" rx="2.8" /><path d="M10.5 17.5h3" />'),
  help: wrap('<circle cx="12" cy="12" r="8.4" /><path d="M9.7 9.6a2.4 2.4 0 1 1 3.2 2.2c-.7.3-1 .8-1 1.5v.3" /><path d="M12 16.8h.01" />'),
  search: wrap('<circle cx="11" cy="11" r="6.4" /><path d="M15.8 15.8 20 20" />'),
  refresh: wrap('<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" /><path d="M19.5 4.5V10h-5.5" />'),
  chevronLeft: wrap('<path d="M14.5 5.5 8 12l6.5 6.5" />'),
  chevronRight: wrap('<path d="M9.5 5.5 16 12l-6.5 6.5" />'),
  history: wrap('<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3" /><path d="M4.2 4.6v3.2h3.2" /><path d="M12 8.2V12l2.6 1.7" />'),
  compose: wrap('<path d="M11 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V13" /><path d="M17.6 3.9a1.8 1.8 0 0 1 2.5 2.5L12.6 14l-3.2.8.8-3.2z" />'),
  arrowUp: wrap('<path d="M12 19V5.5M6.5 11 12 5.5l5.5 5.5" />'),
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" /></svg>',
  chevronDown: wrap('<path d="M6.5 9.5 12 15l5.5-5.5" />'),
  send: wrap('<path d="M4.5 12 20 4.5 15 20l-3.6-6.4z" /><path d="M20 4.5 11.4 13.6" />'),
  play: wrap('<path d="M7.5 4.8 19 12 7.5 19.2z" />'),
  pause: wrap('<path d="M8.5 5v14M15.5 5v14" />'),
};

export function icon(name) {
  return icons[name] || icons.sparkle;
}
