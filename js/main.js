/**
 * Color Haven — bootstrap + application controller.
 * Owns the state machine: boot → title → mode-select → preparing →
 * tutorial/countdown → active ↔ paused → resolving → results → progression.
 * Every transition happens here, with an explicit reason.
 */

import { TERMINAL, listLegalActions, hashString } from './rules.js';
import {
  THEMES, generateLevel, journeyLevel, dailyLevel, dailyInfo,
  tutorialLessons, tierSpec, TIERS,
} from './content.js';
import { GameSession } from './session.js';
import { PaperRenderer, isWebGLAvailable } from './render.js';
import { AudioEngine } from './audio.js';
import { Platform } from './platform.js';
import {
  $, $$, el, toast, banner, announce, announceAlert, formatMs,
  showScreen, closeScreen, clearScreens, currentScreen,
  loadSettings, saveSettings, applySettingsClasses,
  loadProgress, saveProgress, recordCompletion,
  journeyProgressSummary, nextJourneyStage,
  renderPalette, updateHUD, setObjective, setTopbarStatus,
  renderResults, renderJourney, renderHelp, renderScores,
} from './ui.js';
import { paletteFor } from './content.js';

const SNAPSHOT_KEY = 'colorhaven.snapshot.v2';

class App {
  constructor() {
    this.platform = new Platform();
    this.settings = loadSettings();
    this.progress = loadProgress();
    this.audio = new AudioEngine();
    this.renderer = null;
    this.session = null;
    this.level = null;
    this.mode = null;            // learn | journey | daily | practice | challenge | score
    this.palette = null;
    this.ranked = false;
    this.boardId = null;
    this.tutorial = null;        // { lesson, stepIdx, count }
    this.focusCell = -1;
    this.challengeSpec = null;
    this._clockTimer = null;
    this._gamepadTimer = null;
    this._lastPad = {};
    this._pointer = { down: false, x: 0, y: 0, t: 0, dragged: false };
    this._setupConfig = {};
  }

  async boot() {
    applySettingsClasses(this.settings);
    if (!isWebGLAvailable()) {
      $('#compat').hidden = false;
      return; // clear compatibility message; nothing else starts
    }
    $('#app').hidden = false;
    await this.platform.init();
    this.platform.setConsent(true); // anonymous aggregate only

    this.renderer = new PaperRenderer($('#canvas-host'), {
      quality: this.settings.quality,
      reducedMotion: this.settings.reducedMotion,
    });
    this.renderer.start();
    this._wireChrome();
    this._wireInput();
    this._wireSettings();
    this._applyAudioSettings();
    renderHelp($('#help-cards'));
    this._updateTitle();
    showScreen('title');
    document.addEventListener('visibilitychange', () => this._onVisibility());

    // Dev/validation hook: ?autostart=practice|daily|journey|learn jumps
    // straight into a round (fixed-view captures, smoke tests).
    const auto = new URLSearchParams(location.search).get('autostart');
    if (auto) {
      if (auto === 'daily') { const l = dailyLevel(this.platform.now()); this.startGame(l, 'daily', { ranked: true, boardId: 'daily-' + dailyInfo(this.platform.now()).date }); }
      else if (auto === 'journey') { this.startJourneyStage(nextJourneyStage(this.progress)); }
      else if (auto === 'learn') { this.startLearn(); }
      else if (auto === 'selftest') {
        // Scripted full round: select+fill every cell, land on results.
        const l = generateLevel({ id: 'selftest', seed: 'selftest/1', tier: 1, title: 'Self test' });
        this.startGame(l, 'practice', { ranked: false });
        let i = 0;
        const stepFn = () => {
          if (!this.session || this.session.isOver) return;
          if (i < l.targets.length) {
            this.session.selectColor(l.targets[i]);
            this.session.fillCell(i);
            i++;
            setTimeout(stepFn, 5);
          }
        };
        setTimeout(stepFn, 300);
      } else {
        const l = generateLevel({ id: 'auto', seed: 'auto/1', tier: 3, title: 'Practice piece' });
        this.startGame(l, 'practice', { ranked: false });
      }
    }

    // Dev hook: ?screen=settings|help|journey|pause captures any overlay.
    const scr = new URLSearchParams(location.search).get('screen');
    if (scr === 'journey') {
      renderJourney($('#journey-grid'), this.progress, () => {});
      showScreen('journey');
    } else if (scr && $('#screen-' + scr)) {
      showScreen(scr);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Chrome (topbar + title + static screens)                          */
  /* ---------------------------------------------------------------- */

  _wireChrome() {
    $('#btn-settings').addEventListener('click', () => { this.audio.uiTick(); showScreen('settings'); });
    $('#btn-help').addEventListener('click', () => { this.audio.uiTick(); showScreen('help'); });
    $('#btn-help-close').addEventListener('click', () => closeScreen());
    $('#btn-settings-close').addEventListener('click', () => closeScreen());
    $('#btn-scores-close').addEventListener('click', () => closeScreen());
    $('#btn-journey-back').addEventListener('click', () => closeScreen());
    $('#btn-pause').addEventListener('click', () => this.pauseGame('user'));

    $('#btn-continue').addEventListener('click', () => {
      this.audio.unlock(); this.audio.uiTick();
      this.resumeSnapshot();
    });
    $('#btn-results-scores').addEventListener('click', () => this._showBoard());

    $('#btn-play').addEventListener('click', () => {
      this.audio.unlock(); this.audio.uiTick();
      if (!this.settings.tutorialDone) { this.startLearn(); return; }
      const st = nextJourneyStage(this.progress);
      this.startJourneyStage(st);
    });
    $$('.mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.audio.unlock(); this.audio.uiTick();
        this.openMode(btn.dataset.mode);
      });
    });
    $('#btn-setup-back').addEventListener('click', () => closeScreen());
    $('#btn-setup-start').addEventListener('click', () => this._startFromSetup());

    $('#btn-resume').addEventListener('click', () => this.resumeGame('user'));
    $('#btn-pause-settings').addEventListener('click', () => showScreen('settings'));
    $('#btn-pause-help').addEventListener('click', () => showScreen('help'));
    $('#btn-pause-leave').addEventListener('click', () => this.leaveRound('user'));

    $('#btn-undo').addEventListener('click', () => this.session && this.session.undo());
    $('#btn-hint').addEventListener('click', () => this.session && this.session.hint());
    $('#btn-camera').addEventListener('click', () => this.renderer && this.renderer.resetCamera());
    $('#btn-restart').addEventListener('click', () => this.restartRound());

    $('#btn-results-home').addEventListener('click', () => { this._toTitle(); });
    $('#btn-results-replay').addEventListener('click', () => { this.restartRound(); });
    $('#btn-results-next').addEventListener('click', () => this._resultsNext());

    $('#btn-replay-tutorial').addEventListener('click', () => {
      closeScreen(); this.startLearn();
    });
  }

  _updateTitle() {
    const wrap = this._readSnapshot();
    const btnContinue = $('#btn-continue');
    if (wrap) {
      const s = wrap.snap.state;
      btnContinue.hidden = false;
      btnContinue.querySelector('.btn-sub').textContent =
        `${wrap.snap.level.title} · ${s.filled}/${s.total} regions`;
    } else {
      btnContinue.hidden = true;
    }
    const jp = journeyProgressSummary(this.progress);
    $('#journey-summary').textContent = `${jp.done}/${jp.total} stages · ${jp.stars}★`;
    const info = dailyInfo(this.platform.now());
    $('#daily-summary').textContent = `Today ${info.date} · tier ${info.tier}`;
    const guest = 'Guest ' + (this.progress.playerId || (this.progress.playerId = String(hashString(Math.random() + '').toString(16).slice(0, 6))));
    saveProgress(this.progress);
    $('#profile-line').textContent = this.platform.online
      ? `Connected · playing as ${guest}` : `Local play · ${guest} (sign-in offered by host)`;
    const unlocked = Object.keys(this.progress.achievements).length;
    $('#achievement-line').textContent = `Achievements: ${unlocked}/5 · Illustrations finished: ${this.progress.gamesPlayed}`;
  }

  _toTitle() {
    this._teardownRound();
    this._updateTitle();
    clearScreens();
    showScreen('title');
    setTopbarStatus('');
  }

  /* ---------------------------------------------------------------- */
  /* Mode setup                                                        */
  /* ---------------------------------------------------------------- */

  openMode(mode) {
    switch (mode) {
      case 'learn': this.startLearn(); return;
      case 'journey':
        renderJourney($('#journey-grid'), this.progress, (st) => { closeScreen(); this.startJourneyStage(st); });
        showScreen('journey');
        return;
      case 'daily': this._setupDaily(); break;
      case 'practice': this._setupPractice(); break;
      case 'challenge': this._setupChallenge(); break;
      case 'score': this._setupScore(); break;
    }
    showScreen('setup');
  }

  _setupShell(title, factsHtml, choicesHtml) {
    $('#setup-h').textContent = title;
    $('#setup-body').innerHTML = '';
    const facts = el('dl', { class: 'setup-facts' });
    facts.innerHTML = factsHtml;
    const body = $('#setup-body');
    body.append(facts);
    if (choicesHtml) {
      const ch = el('div', { class: 'setup-choices' });
      ch.innerHTML = choicesHtml;
      body.append(ch);
    }
  }

  _setupDaily() {
    const info = dailyInfo(this.platform.now());
    const t = tierSpec(info.tier);
    this._setupConfig = { mode: 'daily', info };
    this._setupShell('Daily challenge', `
      <div><dt>Date (UTC)</dt><dd>${info.date}</dd></div>
      <div><dt>Board</dt><dd>${t.size}×${t.size}, ${t.colors} colors</dd></div>
      <div><dt>Move limit</dt><dd>${Math.ceil(t.size * t.size * 1.2)}</dd></div>
      <div><dt>Ruleset</dt><dd>Hints + undo allowed</dd></div>
      <div><dt>Ranked</dt><dd>Yes — same seed for everyone today</dd></div>
      <div><dt>Expected</dt><dd>~${Math.round(t.size * t.size * t.timePerCellMs / 60000)} min</dd></div>
    `);
  }

  _setupPractice() {
    this._setupConfig = { mode: 'practice', tier: 2, hints: true, undo: true };
    const opts = TIERS.map(t => `<option value="${t.tier}" ${t.tier === 2 ? 'selected' : ''}>${t.label} — ${t.size}×${t.size}, ${t.colors} colors</option>`).join('');
    this._setupShell('Practice', `
      <div><dt>Ranked</dt><dd>No — relax</dd></div>
      <div><dt>Restart / undo</dt><dd>Always available</dd></div>
    `, `
      <label>Difficulty <select id="setup-tier">${opts}</select></label>
      <label><input type="checkbox" id="setup-hints" checked> Allow hints</label>
      <label><input type="checkbox" id="setup-undo" checked> Allow undo</label>
    `);
    $('#setup-tier').addEventListener('change', e => { this._setupConfig.tier = +e.target.value; });
    $('#setup-hints').addEventListener('change', e => { this._setupConfig.hints = e.target.checked; });
    $('#setup-undo').addEventListener('change', e => { this._setupConfig.undo = e.target.checked; });
  }

  _setupChallenge() {
    this._setupConfig = { mode: 'challenge', variant: 'moves' };
    this._setupShell('Challenge', `
      <div><dt>Ranked</dt><dd>Yes — per-variant boards</dd></div>
      <div><dt>Assists</dt><dd>Depends on variant</dd></div>
    `, `
      <label><input type="radio" name="chvar" value="moves" checked> Strict ledger — tier 3, only 5% spare moves, no hints</label>
      <label><input type="radio" name="chvar" value="speed"> Steady hands — tier 3, beat the par clock, no undo</label>
      <label><input type="radio" name="chvar" value="elder"> Elder trial — tier 5, no hints, no undo</label>
    `);
    $$('#setup-body input[name="chvar"]').forEach(r =>
      r.addEventListener('change', () => { this._setupConfig.variant = r.value; }));
  }

  _setupScore() {
    this._setupConfig = { mode: 'score', tier: 3, seed: 'gallery-' + String(hashString(String(Date.now())) % 100000) };
    const opts = TIERS.map(t => `<option value="${t.tier}" ${t.tier === 3 ? 'selected' : ''}>${t.label} — ${t.size}×${t.size}</option>`).join('');
    this._setupShell('Score chase', `
      <div><dt>Ranked</dt><dd>Yes — one board per seed</dd></div>
      <div><dt>Fair play</dt><dd>Same seed + ruleset for every entry</dd></div>
    `, `
      <label>Seed <input type="text" id="setup-seed" value="${this._setupConfig.seed}" maxlength="40"></label>
      <label>Size <select id="setup-score-tier">${opts}</select></label>
    `);
    $('#setup-seed').addEventListener('input', e => { this._setupConfig.seed = e.target.value.trim() || 'gallery'; });
    $('#setup-score-tier').addEventListener('change', e => { this._setupConfig.tier = +e.target.value; });
  }

  _startFromSetup() {
    const cfg = this._setupConfig;
    closeScreen();
    switch (cfg.mode) {
      case 'daily': {
        const level = dailyLevel(this.platform.now());
        this.startGame(level, 'daily', { ranked: true, boardId: 'daily-' + cfg.info.date });
        break;
      }
      case 'practice': {
        const seed = 'practice/' + Date.now().toString(36);
        const level = generateLevel({
          id: 'practice-' + seed, seed, tier: cfg.tier,
          mechanics: { hints: cfg.hints, undo: cfg.undo },
          title: 'Practice piece',
        });
        this.startGame(level, 'practice', { ranked: false });
        break;
      }
      case 'challenge': {
        const t3 = 3;
        let spec;
        if (cfg.variant === 'moves') {
          const cells = tierSpec(t3).size ** 2;
          spec = { tier: t3, mechanics: { hints: false, undo: true, moveLimit: Math.ceil(cells * 1.05) }, tag: 'moves' };
        } else if (cfg.variant === 'speed') {
          spec = { tier: t3, mechanics: { hints: true, undo: false }, tag: 'speed' };
        } else {
          spec = { tier: 5, mechanics: { hints: false, undo: false }, tag: 'elder' };
        }
        const seed = 'challenge/' + cfg.variant;
        const level = generateLevel({ id: 'challenge-' + cfg.variant, seed, tier: spec.tier, mechanics: spec.mechanics, title: 'Challenge — ' + cfg.variant });
        this.startGame(level, 'challenge', { ranked: true, boardId: 'challenge-' + cfg.variant });
        break;
      }
      case 'score': {
        const level = generateLevel({ id: 'score-' + cfg.seed, seed: 'score/' + cfg.seed, tier: cfg.tier, title: 'Seed “' + cfg.seed + '”' });
        this.startGame(level, 'score', { ranked: true, boardId: 'score-' + cfg.seed });
        break;
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Starting modes                                                    */
  /* ---------------------------------------------------------------- */

  startLearn() {
    const lessons = tutorialLessons();
    this._startLesson(lessons[0], lessons, 0);
  }

  _startLesson(lesson, lessons, lessonIdx) {
    // startGame() tears the previous round down (which clears this.tutorial),
    // so the lesson must be installed *after* the round exists.
    this.startGame(lesson.level, 'learn', { ranked: false });
    this.tutorial = { lesson, lessons, lessonIdx, stepIdx: 0, count: 0 };
    this._tutorialStep();
    this.platform.track('tutorial_step', { lesson: lesson.id, step: 0 });
  }

  startJourneyStage(stage) {
    const level = journeyLevel(stage);
    this.startGame(level, 'journey', { ranked: false });
  }

  /* ---------------------------------------------------------------- */
  /* Round lifecycle                                                   */
  /* ---------------------------------------------------------------- */

  startGame(level, mode, { ranked = false, boardId = null, session = null } = {}) {
    this._teardownRound();
    clearScreens();

    this.level = level;
    this.mode = mode;
    this.ranked = ranked;
    this.boardId = boardId;
    this.session = session || new GameSession(level, { mode });
    this.palette = paletteFor(level, this.settings.cvdPalette);
    this.focusCell = Math.floor(level.targets.length / 2);

    const theme = THEMES.find(t => t.id === level.theme) || THEMES[0];
    this.renderer.buildBoard(level, this.palette, theme);
    this.renderer.syncState(this.session.state, []);
    this.renderer.setFocusCell(this.focusCell);

    this.session.onChange((state, events, result) => this._onSessionChange(state, events, result));

    setObjective(level.title, `${level.tierLabel} · ${level.w}×${level.h} · ${this.palette.length} colors` +
      (level.mechanics.moveLimit ? ` · move limit ${level.mechanics.moveLimit}` : ''));
    setTopbarStatus(`${modeLabel(mode)} — ${level.title}`);
    $('#btn-pause').hidden = false;
    this._renderTray();
    updateHUD(this.session, level);

    banner(mode === 'learn' ? null : `Fill every numbered region. No timer, no losing.`);
    if (mode !== 'learn') setTimeout(() => banner(null), 2600);

    this.audio.startAmbience();
    this.audio.startMusic();
    this.audio.setMusicIntensity(0.2);
    this.platform.activityStart(mode);
    this.platform.track('start', { mode });

    // Live clock + snapshot autosave.
    this._clockTimer = setInterval(() => {
      if (this.session && !this.session.paused) {
        $('#stat-time').textContent = formatMs(this.session.elapsedNow());
      }
    }, 500);
    this._saveSnapshot();
    announce(`Started ${level.title}. ${this.palette.length} colors. Pick a color in the tray.`);
  }

  _teardownRound() {
    if (this._clockTimer) { clearInterval(this._clockTimer); this._clockTimer = null; }
    if (this.session) {
      this.platform.activityEnd(this.mode);
      this.session = null;
    }
    this.tutorial = null;
    banner(null);
    this._setBannerAction(null);
    $('#btn-pause').hidden = true;
    $('#palette-tray').textContent = '';
    this.audio.stopMusic();
    this.audio.stopAmbience();
  }

  restartRound() {
    if (!this.level) return;
    const { level, mode, ranked, boardId } = this;
    this.platform.track('retry', { mode });
    if (mode === 'learn' && this.tutorial) {
      this._startLesson(this.tutorial.lesson, this.tutorial.lessons, this.tutorial.lessonIdx);
      return;
    }
    this.startGame(level, mode, { ranked, boardId });
  }

  leaveRound(reason) {
    this._saveSnapshot();
    this._toTitle();
  }

  pauseGame(reason) {
    if (!this.session || this.session.isOver) return;
    this.session.setPaused(true);
    showScreen('pause');
    announce('Paused');
  }

  resumeGame(reason) {
    if (!this.session) return;
    closeScreen();
    this.session.setPaused(false);
    announce('Resumed');
    $('#canvas-host').focus();
  }

  _saveSnapshot() {
    if (!this.session || this.session.isOver || this.mode === 'learn') return;
    try {
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({
        ranked: this.ranked,
        boardId: this.boardId,
        snap: JSON.parse(this.session.snapshot()),
      }));
    } catch { /* quota */ }
  }

  _clearSnapshot() {
    try { localStorage.removeItem(SNAPSHOT_KEY); } catch { /* noop */ }
  }

  /** The saved round, or null when there is nothing usable to resume. */
  _readSnapshot() {
    let raw = null;
    try { raw = localStorage.getItem(SNAPSHOT_KEY); } catch { return null; }
    if (!raw) return null;
    try {
      const wrap = JSON.parse(raw);
      if (!wrap || !wrap.snap || !wrap.snap.level || !wrap.snap.state) return null;
      const state = wrap.snap.state;
      if (!Number.isInteger(state.filled) || !Number.isInteger(state.total) ||
          state.total < 1 || state.filled < 0 || state.filled > state.total) return null;
      const restored = GameSession.restore(wrap.snap);
      if (!restored || restored.isOver) return null;
      return wrap;
    } catch { return null; }
  }

  /** Resume the autosaved round (spec §3: reconnect from the durable snapshot). */
  resumeSnapshot() {
    const wrap = this._readSnapshot();
    const session = wrap && GameSession.restore(wrap.snap);
    if (!session || session.isOver) { this._clearSnapshot(); this._updateTitle(); return; }
    this.startGame(session.level, session.mode, {
      ranked: !!wrap.ranked, boardId: wrap.boardId || null, session,
    });
    banner(`Resumed — ${session.state.filled} of ${session.state.total} regions already filled.`);
    setTimeout(() => banner(null), 2600);
    announce('Round resumed.');
  }

  /* ---------------------------------------------------------------- */
  /* Session events → render / audio / HUD / tutorial / terminal       */
  /* ---------------------------------------------------------------- */

  _onSessionChange(state, events, result) {
    this.renderer.syncState(state, events);
    this._renderTray();
    updateHUD(this.session, this.level);
    this.audio.setMusicIntensity(0.2 + this.session.progress * 0.8);
    this._saveSnapshot();

    for (const ev of events) {
      switch (ev.type) {
        case 'select':
          this.audio.select();
          announce(`Color ${ev.color + 1}, ${this.palette[ev.color].name} selected`);
          break;
        case 'fill':
          this.audio.fill();
          this._haptic(12);
          break;
        case 'hint':
          this.audio.hint();
          toast('Hint placed a region for you (−25 pts)');
          break;
        case 'undo':
          this.audio.undo();
          break;
        case 'invalid': {
          this.audio.invalid();
          this._haptic([30, 40, 30]);
          const need = this.palette[ev.need];
          const msg = `That region needs color ${ev.need + 1} (${need.name})`;
          toast(msg);
          announceAlert(msg);
          break;
        }
        case 'complete':
          this.audio.complete();
          this._endRound();
          break;
        case 'ended':
          this.audio.movesExhausted();
          this._endRound();
          break;
      }
      if (this.tutorial) this._tutorialEvent(ev);
    }
    if (result && result.paused) { /* input during pause: ignore */ }
  }

  async _endRound() {
    const st = this.session.state;
    const sc = this.session.scoreBreakdown;
    this._clearSnapshot();

    const dateIso = this.mode === 'daily' ? dailyInfo(this.platform.now()).date : null;
    const newAch = recordCompletion(this.progress, {
      mode: this.mode, level: this.level, state: st, scoreTotal: sc.total, dateIso,
    });
    if (newAch.length) this.audio.achievement();

    let rankInfo = '';
    if (this.ranked && st.terminalReason === TERMINAL.COMPLETED) {
      const entry = {
        name: 'Guest ' + (this.progress.playerId || 'anon'),
        score: sc.total,
        elapsedMs: st.elapsedMs,
        invalid: st.invalid,
        sessionId: this.session.sessionId,
        levelId: this.level.id,
        contentV: this.level.v,
        seed: this.level.seed,
        assists: { hints: st.mechanics.hints, undo: st.mechanics.undo },
        envelope: this.session.envelope(),
      };
      const res = await this.platform.submitScore(this.boardId, entry);
      if (res && res.ok) {
        rankInfo = `Leaderboard rank: #${res.rank}${res.local ? ' (local board)' : ''}`;
      } else {
        rankInfo = 'Score saved locally; board submission unavailable.';
      }
    }
    this.platform.track('round_end', { mode: this.mode, reason: st.terminalReason });

    renderResults({
      session: this.session, level: this.level, mode: modeLabel(this.mode),
      newAchievements: newAch, rankInfo,
    });
    $('#btn-results-next').textContent = this.mode === 'journey' ? 'Next stage' : 'Play again';
    $('#btn-results-scores').hidden = !(this.ranked && this.boardId);
    announceAlert(st.terminalReason === TERMINAL.COMPLETED
      ? `Complete! Score ${sc.total}.` : 'Out of moves.');
    setTimeout(() => showScreen('results'), this.settings.reducedMotion ? 200 : 1200);
  }

  /** Open the leaderboard for the round just played (ranked modes only). */
  async _showBoard() {
    if (!this.boardId) return;
    this.audio.uiTick();
    const entries = await this.platform.fetchBoard(this.boardId);
    $('#scores-sub').textContent = `${this.boardId} · ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`;
    renderScores($('#scores-table tbody'), entries);
    showScreen('scores');
  }

  _resultsNext() {
    if (this.mode === 'journey') {
      const st = nextJourneyStage(this.progress);
      this.startJourneyStage(st);
    } else if (this.mode === 'learn' && this.tutorial) {
      const next = this.tutorial.lessonIdx + 1;
      if (next < this.tutorial.lessons.length) {
        this._startLesson(this.tutorial.lessons[next], this.tutorial.lessons, next);
      } else {
        this.settings.tutorialDone = true;
        saveSettings(this.settings);
        this._toTitle();
        toast('Tutorial complete — Journey is ready.');
      }
    } else {
      this._toTitle();
      this.openMode(this.mode === 'learn' ? 'journey' : this.mode);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Tutorial engine (uses the same commands as play)                  */
  /* ---------------------------------------------------------------- */

  _tutorialStep() {
    const t = this.tutorial;
    if (!t) return;
    const step = t.lesson.steps[t.stepIdx];
    if (!step) return;
    banner(step.text + (step.require == null ? '  (tap this message to continue)' : ''));
    this._setBannerAction(step.require == null ? () => this._tutorialAdvance() : null);
    announce(step.text);
  }

  /**
   * Make the HUD banner an activatable control (or plain text when fn is null).
   * Tutorial steps that wait on acknowledgement must be reachable by keyboard,
   * not only by pointer.
   */
  _setBannerAction(fn) {
    const b = $('#hud-banner');
    if (!b) return;
    if (fn) {
      b.style.cursor = 'pointer';
      b.setAttribute('role', 'button');
      b.setAttribute('tabindex', '0');
      b.onclick = fn;
      b.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); }
      };
    } else {
      b.style.cursor = '';
      b.removeAttribute('role');
      b.removeAttribute('tabindex');
      b.onclick = null;
      b.onkeydown = null;
    }
  }

  _tutorialAdvance() {
    const t = this.tutorial;
    if (!t) return;
    const finishedStep = t.lesson.steps[t.stepIdx];
    t.stepIdx++;
    t.count = 0;
    this.platform.track('tutorial_step', { lesson: t.lesson.id, step: t.stepIdx });
    if (t.stepIdx >= t.lesson.steps.length) {
      // Lesson done: its completion arrives via the 'complete' event,
      // or we end directly if the lesson doesn't require completion.
      if (this.session && !this.session.isOver) {
        if (finishedStep && finishedStep.require == null) {
          // The closing note was already acknowledged — don't ask twice.
          this._resultsNext();
        } else {
          banner('Lesson complete! Tap to continue.');
          this._setBannerAction(() => this._resultsNext());
        }
      }
      return;
    }
    this._tutorialStep();
  }

  _tutorialEvent(ev) {
    const t = this.tutorial;
    if (!t) return;
    const step = t.lesson.steps[t.stepIdx];
    if (!step || !step.require) return;
    const r = step.require;
    let okAdvance = false;
    if (r.type === 'select' && ev.type === 'select' && ev.color === r.color) okAdvance = true;
    if (r.type === 'invalid' && ev.type === 'invalid') okAdvance = true;
    if (r.type === 'fill' && ev.type === 'fill' && (r.color == null || ev.color === r.color)) {
      if (r.count === 'all') {
        const remaining = this.session.state.total - this.session.state.filled;
        const remForColor = listLegalActions(this.session.state, this.level).fillableFor[r.color];
        okAdvance = remForColor === 0 || remaining === 0;
      } else if (typeof r.count === 'number') {
        t.count++;
        okAdvance = t.count >= r.count;
      } else okAdvance = true;
    }
    if (r.type === 'complete' && ev.type === 'complete') okAdvance = true;
    // Optional steps also advance on the "intended" follow-up action.
    if (step.optional && r.type === 'invalid' && ev.type === 'fill') okAdvance = true;
    if (okAdvance) this._tutorialAdvance();
  }

  /* ---------------------------------------------------------------- */
  /* Palette tray                                                      */
  /* ---------------------------------------------------------------- */

  _renderTray() {
    const st = this.session.state;
    const legal = listLegalActions(st, this.level);
    renderPalette($('#palette-tray'), this.palette, st, legal.fillableFor, (i) => {
      this.session.selectColor(i);
      $('#canvas-host').focus();
    });
  }

  /* ---------------------------------------------------------------- */
  /* Input: pointer, keyboard, gamepad                                 */
  /* ---------------------------------------------------------------- */

  _wireInput() {
    const host = $('#canvas-host');

    host.addEventListener('pointerdown', (e) => {
      this.audio.unlock();
      host.setPointerCapture(e.pointerId);
      this._pointer = { down: true, x: e.clientX, y: e.clientY, t: performance.now(), dragged: false };
    });
    host.addEventListener('pointermove', (e) => {
      if (!this.session) return;
      if (this._pointer.down) {
        const dx = e.clientX - this._pointer.x, dy = e.clientY - this._pointer.y;
        if (Math.hypot(dx, dy) > 12) this._pointer.dragged = true;
      }
      const cell = this.renderer.pick(e.clientX, e.clientY);
      this.renderer.setHover(cell, this.session.state);
    });
    host.addEventListener('pointerup', (e) => {
      if (!this._pointer.down) return;
      const wasDrag = this._pointer.dragged;
      const dt = performance.now() - this._pointer.t;
      this._pointer.down = false;
      try { host.releasePointerCapture(e.pointerId); } catch { /* lost capture */ }
      if (wasDrag || dt > 500) return;   // tap vs drag by distance/time
      if (!this.session || this.session.paused) return;
      const cell = this.renderer.pick(e.clientX, e.clientY);
      if (cell >= 0) {
        this.focusCell = cell;
        this.renderer.setFocusCell(cell);
        this.session.fillCell(cell);
      }
    });
    host.addEventListener('pointercancel', () => { this._pointer.down = false; });
    host.addEventListener('pointerleave', () => this.renderer.setHover(-1, null));

    host.addEventListener('keydown', (e) => this._onKey(e));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const cur = currentScreen();
        if (cur === 'pause') this.resumeGame('key');
        else if (cur) closeScreen();
        else if (this.session && !this.session.isOver) this.pauseGame('key');
      }
    });

    // Gamepad polling (focus nav + actions).
    this._gamepadTimer = setInterval(() => this._pollGamepad(), 100);
  }

  _onKey(e) {
    if (!this.session || this.session.paused || this.session.isOver) return;
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft': this._moveFocus(-1, 0); break;
      case 'ArrowRight': this._moveFocus(1, 0); break;
      case 'ArrowUp': this._moveFocus(0, -1); break;
      case 'ArrowDown': this._moveFocus(0, 1); break;
      case 'Enter': case ' ': this.session.fillCell(this.focusCell); break;
      case 'u': case 'U': this.session.undo(); break;
      case 'h': case 'H': this.session.hint(); break;
      case 'c': case 'C': this.renderer.resetCamera(); break;
      case 'p': case 'P': this.pauseGame('key'); break;
      default:
        if (/^[1-8]$/.test(e.key)) {
          const c = +e.key - 1;
          if (c < this.palette.length) this.session.selectColor(c);
        } else handled = false;
    }
    if (handled) e.preventDefault();
  }

  _moveFocus(dx, dy) {
    const w = this.level.w, h = this.level.h;
    let x = this.focusCell % w, y = Math.floor(this.focusCell / w);
    x = (x + dx + w) % w;
    y = (y + dy + h) % h;
    this.focusCell = y * w + x;
    this.renderer.setFocusCell(this.focusCell);
    const target = this.level.targets[this.focusCell];
    announce(`Region ${this.focusCell + 1}, needs color ${target + 1} ${this.palette[target].name}` +
      (this.session.state.fills[this.focusCell] ? ', filled' : ''));
  }

  _pollGamepad() {
    if (!this.session || this.session.paused || this.session.isOver) return;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const gp = pads && pads[0];
    if (!gp) return;
    const pressed = (i) => gp.buttons[i] && gp.buttons[i].pressed;
    const edge = (name, val) => { const was = this._lastPad[name]; this._lastPad[name] = val; return val && !was; };
    const axX = gp.axes[0] || 0, axY = gp.axes[1] || 0;
    if (edge('left', pressed(14) || axX < -0.6)) this._moveFocus(-1, 0);
    if (edge('right', pressed(15) || axX > 0.6)) this._moveFocus(1, 0);
    if (edge('up', pressed(12) || axY < -0.6)) this._moveFocus(0, -1);
    if (edge('down', pressed(13) || axY > 0.6)) this._moveFocus(0, 1);
    if (edge('a', pressed(0))) this.session.fillCell(this.focusCell);
    if (edge('x', pressed(2))) this.session.undo();
    if (edge('y', pressed(3))) this.session.hint();
    if (edge('start', pressed(9))) this.pauseGame('gamepad');
  }

  _haptic(pattern) {
    if (this.settings.haptics && navigator.vibrate) navigator.vibrate(pattern);
  }

  /* ---------------------------------------------------------------- */
  /* Settings                                                          */
  /* ---------------------------------------------------------------- */

  _wireSettings() {
    const s = this.settings;
    const bind = (id, key, apply) => {
      const node = $(id);
      if (node.type === 'checkbox') node.checked = !!s[key];
      else node.value = s[key];
      node.addEventListener(node.type === 'checkbox' ? 'change' : 'input', () => {
        s[key] = node.type === 'checkbox' ? node.checked :
          (node.type === 'range' ? +node.value : node.value);
        saveSettings(s);
        applySettingsClasses(s);
        if (apply) apply();
        this.platform.track('settings_change', { key });
      });
    };
    bind('#vol-music', 'volMusic', () => this._applyAudioSettings());
    bind('#vol-effects', 'volEffects', () => this._applyAudioSettings());
    bind('#vol-ambience', 'volAmbience', () => this._applyAudioSettings());
    bind('#vol-voice', 'volVoice', () => this._applyAudioSettings());
    bind('#set-captions', 'captions');
    bind('#set-quality', 'quality', () => {
      this.renderer.setQuality(s.quality);
      if (this.session) this.renderer.syncState(this.session.state, []);
    });
    bind('#set-motion', 'reducedMotion', () => this.renderer.setReducedMotion(s.reducedMotion));
    bind('#set-contrast', 'highContrast');
    bind('#set-cvd', 'cvdPalette', () => {
      if (this.session && this.level) {
        this.palette = paletteFor(this.level, s.cvdPalette);
        const theme = THEMES.find(t => t.id === this.level.theme) || THEMES[0];
        this.renderer.buildBoard(this.level, this.palette, theme);
        this.renderer.syncState(this.session.state, []);
        this._renderTray();
      }
    });
    bind('#set-largetext', 'largeText');
    bind('#set-lefthand', 'leftHanded');
    bind('#set-haptics', 'haptics');

    // Audio captions → aria-live.
    this.audio.onCaption((text) => { if (this.settings.captions) announce(`♪ ${text}`); });
  }

  _applyAudioSettings() {
    this.audio.setVolume('music', this.settings.volMusic / 100);
    this.audio.setVolume('effects', this.settings.volEffects / 100);
    this.audio.setVolume('ambience', this.settings.volAmbience / 100);
    this.audio.setVolume('voice', this.settings.volVoice / 100);
  }

  /* ---------------------------------------------------------------- */
  /* Visibility: pause solo simulation, idle render, duck audio        */
  /* ---------------------------------------------------------------- */

  _onVisibility() {
    if (document.hidden) {
      if (this.session && !this.session.isOver) {
        this.session.setPaused(true);
        if (!currentScreen()) showScreen('pause');
      }
      this.renderer.stop();
      this.audio.suspendAll();
    } else {
      this.renderer.start();
      this.audio.resumeAll();
      this.platform.syncTime();
    }
  }
}

function modeLabel(mode) {
  return { learn: 'Learn', journey: 'Journey', daily: 'Daily', practice: 'Practice', challenge: 'Challenge', score: 'Score chase' }[mode] || mode;
}

/* boot */
const app = new App();
app.boot().catch(err => {
  console.error('boot failed', err);
  const c = $('#compat');
  if (c) {
    c.hidden = false;
    c.querySelector('p').textContent = 'Something went wrong while starting: ' + err.message;
  }
});
window.__colorhaven = app; // debug/testing handle
