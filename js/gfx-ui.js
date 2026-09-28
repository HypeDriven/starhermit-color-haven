/**
 * Color Haven — Settings → Graphics panel.
 * Builds the controls inside #gfx-fieldset, localizes them (the rest of the
 * game is en-US only; this panel follows navigator.language), persists to
 * settings.gfx and applies every change live through renderer.setGraphics.
 */

import { PRESETS, CATEGORIES, presetTier, choosePreset } from './gfx.js';

const STRINGS = {
  'en-US': {
    legend: 'Graphics', quality: 'Quality', auto: 'Auto (detected: {t})', renderScale: 'Render scale',
    fromPreset: 'From preset ({t})', adaptive: 'Adaptive resolution', showFps: 'Show frame rate',
    postFailed: 'Post-processing is unavailable on this device, so the board renders without it.',
    unknownGpu: 'unknown GPU',
    presets: { low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra' },
    cats: { shadows: 'Shadows', ao: 'Ambient occlusion', grade: 'Color grade', antialias: 'Anti-aliasing', lighting: 'Lighting', detail: 'Paper detail', particles: 'Pigment particles', ambient: 'Ambient motion' },
    tiers: { off: 'Off', on: 'On', low: 'Low', medium: 'Medium', high: 'High', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', basic: 'Basic', studio: 'Studio', plain: 'Plain', detailed: 'Detailed' },
    sum: { noShadows: 'no shadows', shadows: '{n}² shadows', ao: 'ambient occlusion', aoHigh: 'full ambient occlusion', grade: 'color grade', noAA: 'no anti-aliasing', studio: 'studio lighting', detailed: 'paper detail' },
  },
  'es-ES': {
    legend: 'Gráficos', quality: 'Calidad', auto: 'Automática (detectada: {t})', renderScale: 'Escala de renderizado',
    fromPreset: 'Según el ajuste ({t})', adaptive: 'Resolución adaptativa', showFps: 'Mostrar fotogramas por segundo',
    postFailed: 'El posprocesado no está disponible en este dispositivo; el tablero se muestra sin él.',
    unknownGpu: 'GPU desconocida',
    presets: { low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
    cats: { shadows: 'Sombras', ao: 'Oclusión ambiental', grade: 'Corrección de color', antialias: 'Antialiasing', lighting: 'Iluminación', detail: 'Detalle del papel', particles: 'Partículas de pigmento', ambient: 'Movimiento ambiental' },
    tiers: { off: 'No', on: 'Sí', low: 'Bajas', medium: 'Medias', high: 'Altas', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', basic: 'Básica', studio: 'Estudio', plain: 'Liso', detailed: 'Detallado' },
    sum: { noShadows: 'sin sombras', shadows: 'sombras {n}²', ao: 'oclusión ambiental', aoHigh: 'oclusión ambiental completa', grade: 'corrección de color', noAA: 'sin antialiasing', studio: 'luz de estudio', detailed: 'detalle del papel' },
  },
  'de-DE': {
    legend: 'Grafik', quality: 'Qualität', auto: 'Automatisch (erkannt: {t})', renderScale: 'Renderskalierung',
    fromPreset: 'Aus Voreinstellung ({t})', adaptive: 'Adaptive Auflösung', showFps: 'Bildrate anzeigen',
    postFailed: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; das Brett wird ohne sie dargestellt.',
    unknownGpu: 'unbekannte GPU',
    presets: { low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra' },
    cats: { shadows: 'Schatten', ao: 'Umgebungsverdeckung', grade: 'Farbkorrektur', antialias: 'Kantenglättung', lighting: 'Beleuchtung', detail: 'Papierdetails', particles: 'Farbpartikel', ambient: 'Umgebungsbewegung' },
    tiers: { off: 'Aus', on: 'An', low: 'Niedrig', medium: 'Mittel', high: 'Hoch', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', basic: 'Einfach', studio: 'Studio', plain: 'Schlicht', detailed: 'Detailliert' },
    sum: { noShadows: 'keine Schatten', shadows: '{n}²-Schatten', ao: 'Umgebungsverdeckung', aoHigh: 'volle Umgebungsverdeckung', grade: 'Farbkorrektur', noAA: 'keine Kantenglättung', studio: 'Studiolicht', detailed: 'Papierdetails' },
  },
  'fr-FR': {
    legend: 'Graphismes', quality: 'Qualité', auto: 'Auto (détectée : {t})', renderScale: 'Échelle de rendu',
    fromPreset: 'Selon le préréglage ({t})', adaptive: 'Résolution adaptative', showFps: 'Afficher les images par seconde',
    postFailed: 'Le post-traitement n’est pas disponible sur cet appareil ; le plateau s’affiche sans lui.',
    unknownGpu: 'GPU inconnu',
    presets: { low: 'Basse', balanced: 'Équilibrée', high: 'Haute', ultra: 'Ultra' },
    cats: { shadows: 'Ombres', ao: 'Occlusion ambiante', grade: 'Étalonnage des couleurs', antialias: 'Anticrénelage', lighting: 'Éclairage', detail: 'Détail du papier', particles: 'Particules de pigment', ambient: 'Mouvement ambiant' },
    tiers: { off: 'Non', on: 'Oui', low: 'Basses', medium: 'Moyennes', high: 'Hautes', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', basic: 'Simple', studio: 'Studio', plain: 'Uni', detailed: 'Détaillé' },
    sum: { noShadows: 'sans ombres', shadows: 'ombres {n}²', ao: 'occlusion ambiante', aoHigh: 'occlusion ambiante complète', grade: 'étalonnage', noAA: 'sans anticrénelage', studio: 'éclairage studio', detailed: 'détail du papier' },
  },
  'pt-BR': {
    legend: 'Gráficos', quality: 'Qualidade', auto: 'Automática (detectada: {t})', renderScale: 'Escala de renderização',
    fromPreset: 'Da predefinição ({t})', adaptive: 'Resolução adaptativa', showFps: 'Mostrar taxa de quadros',
    postFailed: 'O pós-processamento não está disponível neste dispositivo; o tabuleiro é exibido sem ele.',
    unknownGpu: 'GPU desconhecida',
    presets: { low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
    cats: { shadows: 'Sombras', ao: 'Oclusão de ambiente', grade: 'Correção de cor', antialias: 'Antisserrilhamento', lighting: 'Iluminação', detail: 'Detalhe do papel', particles: 'Partículas de pigmento', ambient: 'Movimento ambiente' },
    tiers: { off: 'Desligado', on: 'Ligado', low: 'Baixas', medium: 'Médias', high: 'Altas', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', basic: 'Básica', studio: 'Estúdio', plain: 'Liso', detailed: 'Detalhado' },
    sum: { noShadows: 'sem sombras', shadows: 'sombras {n}²', ao: 'oclusão de ambiente', aoHigh: 'oclusão de ambiente completa', grade: 'correção de cor', noAA: 'sem antisserrilhamento', studio: 'luz de estúdio', detailed: 'detalhe do papel' },
  },
  'it-IT': {
    legend: 'Grafica', quality: 'Qualità', auto: 'Automatica (rilevata: {t})', renderScale: 'Scala di rendering',
    fromPreset: 'Dal preset ({t})', adaptive: 'Risoluzione adattiva', showFps: 'Mostra fotogrammi al secondo',
    postFailed: 'La post-elaborazione non è disponibile su questo dispositivo; il tabellone viene mostrato senza.',
    unknownGpu: 'GPU sconosciuta',
    presets: { low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra' },
    cats: { shadows: 'Ombre', ao: 'Occlusione ambientale', grade: 'Correzione colore', antialias: 'Antialiasing', lighting: 'Illuminazione', detail: 'Dettaglio della carta', particles: 'Particelle di pigmento', ambient: 'Movimento ambientale' },
    tiers: { off: 'No', on: 'Sì', low: 'Basse', medium: 'Medie', high: 'Alte', fxaa: 'FXAA', smaa: 'SMAA', msaa: 'MSAA', basic: 'Semplice', studio: 'Studio', plain: 'Liscia', detailed: 'Dettagliata' },
    sum: { noShadows: 'senza ombre', shadows: 'ombre {n}²', ao: 'occlusione ambientale', aoHigh: 'occlusione ambientale completa', grade: 'correzione colore', noAA: 'senza antialiasing', studio: 'luce da studio', detailed: 'dettaglio della carta' },
  },
};
// Regional variants: only the words that differ.
STRINGS['en-GB'] = {
  ...STRINGS['en-US'],
  cats: { ...STRINGS['en-US'].cats, grade: 'Colour grade' },
  sum: { ...STRINGS['en-US'].sum, grade: 'colour grade' },
};
STRINGS['es-419'] = {
  ...STRINGS['es-ES'],
  renderScale: 'Escala de renderizado', showFps: 'Mostrar cuadros por segundo',
  cats: { ...STRINGS['es-ES'].cats, antialias: 'Suavizado de bordes' },
  sum: { ...STRINGS['es-ES'].sum, noAA: 'sin suavizado de bordes' },
};
STRINGS['fr-CA'] = {
  ...STRINGS['fr-FR'],
  auto: 'Auto (détectée : {t})', showFps: 'Afficher la fréquence d’images',
  cats: { ...STRINGS['fr-FR'].cats, antialias: 'Lissage' },
  sum: { ...STRINGS['fr-FR'].sum, noAA: 'sans lissage' },
};

export const GFX_LOCALES = Object.keys(STRINGS);

/** Pick the closest supported locale for a BCP-47 tag. */
export function pickLocale(tag) {
  const t = String(tag || 'en-US');
  if (STRINGS[t]) return t;
  const lang = t.split('-')[0].toLowerCase();
  const region = (t.split('-')[1] || '').toUpperCase();
  if (lang === 'en') return ['GB', 'IE', 'AU', 'NZ', 'ZA', 'IN'].includes(region) ? 'en-GB' : 'en-US';
  if (lang === 'es') return region === 'ES' ? 'es-ES' : 'es-419';
  if (lang === 'fr') return region === 'CA' ? 'fr-CA' : 'fr-FR';
  if (lang === 'pt') return 'pt-BR';
  if (lang === 'de') return 'de-DE';
  if (lang === 'it') return 'it-IT';
  return 'en-US';
}

export function gfxStrings(locale) { return STRINGS[locale] || STRINGS['en-US']; }

/**
 * Build and wire the panel.
 * @param {HTMLElement} root  #gfx-fieldset
 * @param {object} opts { renderer, getSaved(), save(saved) }
 */
export function mountGraphicsPanel(root, { renderer, getSaved, save }) {
  const locale = pickLocale((navigator.languages && navigator.languages[0]) || navigator.language);
  const S = gfxStrings(locale);
  root.lang = locale;
  root.innerHTML = '';
  const legend = document.createElement('legend');
  legend.textContent = S.legend;
  root.append(legend);
  const grid = document.createElement('div');
  grid.className = 'gfx-grid';
  root.append(grid);

  const row = (labelText, control, cls = '') => {
    const label = document.createElement('label');
    if (cls) label.className = cls;
    const span = document.createElement('span');
    span.textContent = labelText;
    if (cls === 'check') label.append(control, span); else label.append(span, control);
    grid.append(label);
    return label;
  };
  const select = (id, attr) => {
    const el = document.createElement('select');
    el.id = id;
    if (attr) el.dataset.gfx = attr;
    return el;
  };
  const opt = (el, value, text) => { const o = document.createElement('option'); o.value = value; o.textContent = text; el.append(o); };

  // Quality preset (keeps the historical #set-quality id).
  const quality = select('set-quality', 'preset');
  row(S.quality, quality);

  // Render scale.
  const scale = document.createElement('input');
  scale.type = 'range'; scale.id = 'gfx-scale'; scale.dataset.gfx = 'render_scale';
  scale.min = '50'; scale.max = '200'; scale.step = '10';
  const scaleOut = document.createElement('output');
  scaleOut.className = 'gfx-scale-out';
  scaleOut.htmlFor = 'gfx-scale';
  const scaleWrap = document.createElement('span');
  scaleWrap.className = 'gfx-scale-wrap';
  scaleWrap.append(scale, scaleOut);
  row(S.renderScale, scaleWrap);

  // One select per category.
  const catSel = {};
  for (const cat of Object.keys(CATEGORIES)) {
    const el = select('gfx-' + cat, cat);
    catSel[cat] = el;
    row(S.cats[cat], el);
  }

  const adaptive = document.createElement('input');
  adaptive.type = 'checkbox'; adaptive.id = 'gfx-adaptive'; adaptive.dataset.gfx = 'adaptive';
  row(S.adaptive, adaptive, 'check');
  const fps = document.createElement('input');
  fps.type = 'checkbox'; fps.id = 'gfx-fps'; fps.dataset.gfx = 'show_fps';
  row(S.showFps, fps, 'check');

  const summary = document.createElement('p');
  summary.id = 'gfx-summary';
  summary.className = 'muted small gfx-summary';
  summary.setAttribute('aria-live', 'polite');
  root.append(summary);
  const note = document.createElement('p');
  note.id = 'gfx-postnote';
  note.className = 'gfx-note';
  note.textContent = S.postFailed;
  note.hidden = true;
  root.append(note);

  const tierName = (t) => S.tiers[t] || t;

  const refresh = () => {
    const saved = getSaved();
    const info = renderer.graphicsInfo(S.sum);
    const r = info.resolved;
    quality.innerHTML = '';
    opt(quality, 'auto', S.auto.replace('{t}', S.presets[info.detected]));
    for (const p of PRESETS) opt(quality, p, S.presets[p]);
    quality.value = PRESETS.includes(saved.preset) ? saved.preset : 'auto';
    for (const [cat, tiers] of Object.entries(CATEGORIES)) {
      const el = catSel[cat];
      el.innerHTML = '';
      opt(el, 'preset', S.fromPreset.replace('{t}', tierName(presetTier(r.preset, cat))));
      for (const t of tiers) opt(el, t, tierName(t));
      el.value = tiers.includes(saved[cat]) ? saved[cat] : 'preset';
    }
    const pct = Math.round((Number(saved.render_scale) || 1) * 100);
    scale.value = String(Math.min(200, Math.max(50, pct)));
    scaleOut.textContent = scale.value + '%';
    scale.setAttribute('aria-valuetext', scale.value + '%');
    adaptive.checked = saved.adaptive !== false;
    fps.checked = !!saved.show_fps;
    summary.textContent = [info.gpu || S.unknownGpu, info.summary].join(' · ');
    note.hidden = !info.postFailed;
    root.dataset.gfxPreset = r.preset;
  };

  const commit = (next) => {
    save(next);
    renderer.setGraphics(next);
    refresh();
  };

  quality.addEventListener('change', () => commit(choosePreset(getSaved(), quality.value)));
  scale.addEventListener('input', () => { scaleOut.textContent = scale.value + '%'; });
  scale.addEventListener('change', () => commit({ ...getSaved(), render_scale: Number(scale.value) / 100 }));
  for (const [cat, el] of Object.entries(catSel)) {
    el.addEventListener('change', () => {
      const next = { ...getSaved() };
      if (el.value === 'preset') delete next[cat]; else next[cat] = el.value;
      commit(next);
    });
  }
  adaptive.addEventListener('change', () => commit({ ...getSaved(), adaptive: adaptive.checked }));
  fps.addEventListener('change', () => commit({ ...getSaved(), show_fps: fps.checked }));

  renderer.onGraphicsChange(() => { if (!root.closest('[hidden]')) refresh(); });
  refresh();
  return { refresh };
}
