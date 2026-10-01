/* ==========================================================================
   Date proposal — script.js
   Sections:
     1. Config + state
     2. Small helpers
     3. Card flow (showCard)
     4. NO-button escape system  <-- the important part
     5. Selections (food / activity / date + time)
     6. Final result
     7. Confetti (canvas) + floating hearts
     8. Init
   ========================================================================== */
(() => {
  'use strict';

  /* ------------------------------------------------------------------------
   * 1. CONFIG + STATE
   * ---------------------------------------------------------------------- */
  const CONFIG = {
    // --- NO button -----------------------------------------------------
    ESCAPE_DISTANCE: 100,   // px between pointer and the button's EDGE that triggers an escape
    TOUCH_BONUS: 24,        // fingers are fat + imprecise: react a little earlier on touch
    BOUNDS_INSET: 12,       // keep the button this far from the card edge
    MIN_TRAVEL: 80,         // each jump must move at least this far
    AVOID_PADDING: 10,      // breathing room around YES / headings when picking a spot
    MOVE_COOLDOWN: 120,     // ms; stops the button jittering while it is mid-flight
    TAUNT_CHANCE: 0.3,      // chance of a message on an escape (after the first couple)
    TAUNT_EVERY: 5,         // ...and one is guaranteed every Nth escape
    TAUNTS: ['hehe 😏', 'Nice try 😂', 'Almost! 🙈', 'Nope 😌', 'Catch me first! 😂'],

    // --- Flow ----------------------------------------------------------
    TRANSITION_MS: 600,     // keep in sync with --card-ms in style.css
  };

  /* ---- Where do her answers go? (fill ONE or BOTH, see README notes) ----
   * WEB3FORMS_KEY   : free key from https://web3forms.com (enter your email, they mail you the key).
   *                   When set, her answers are emailed to you automatically at the end.
   * WHATSAPP_NUMBER : your number with country code, digits only (e.g. '919876543210').
   *                   When set, a "Send my answers 💌" button appears on the last card and
   *                   opens WhatsApp with the answers pre-written for you.
   */
  const RESPONSE = {
    WEB3FORMS_KEY: '',
    WHATSAPP_NUMBER: '+919983300015',
  };

  const state = {
    current: 1,
    selectedFood: null,
    selectedActivity: null,
    selectedAfter: null,
    sent: false,
    selectedDate: null,
    selectedTime: null,
  };

  /* ------------------------------------------------------------------------
   * 2. HELPERS
   * ---------------------------------------------------------------------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const rand = (min, max) => min + Math.random() * (max - min);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const cardEls = Object.fromEntries($$('.card').map((el) => [el.dataset.card, el]));

  function vibrate(ms = 12) {
    try { navigator.vibrate && navigator.vibrate(ms); } catch (_) { /* ignore */ }
  }

  /* ------------------------------------------------------------------------
   * 3. CARD FLOW
   * ---------------------------------------------------------------------- */

  /** Code that runs when a card finishes becoming the active one. */
  const enterHooks = {
    1: () => armEscaper(1),
    2: celebrate,
    3: () => armEscaper(3),
    8: () => showFinalResult(),
  };

  /**
   * Show exactly one card. The old card slides/fades out, the new one
   * fades/scales/slides in (all done in CSS via .is-active / .is-leaving).
   */
  function showCard(id) {
    id = Number(id);
    const next = cardEls[id];
    const prev = cardEls[state.current];
    if (!next || id === state.current) return;

    disarmEscaper(state.current);

    prev.classList.remove('is-active');
    prev.classList.add('is-leaving');
    prev.setAttribute('aria-hidden', 'true');
    prev.inert = true;

    next.classList.remove('is-leaving');
    next.removeAttribute('aria-hidden');
    next.inert = false;
    next.classList.add('is-active');

    state.current = id;
    window.scrollTo(0, 0);

    // Clean up the exit state once the animation has finished
    setTimeout(() => prev.classList.remove('is-leaving'), CONFIG.TRANSITION_MS);

    // Move focus to the heading for screen-reader / keyboard users
    const heading = $('.title', next);
    if (heading) setTimeout(() => heading.focus({ preventScroll: true }), 80);

    if (enterHooks[id]) enterHooks[id]();
  }

  /* ------------------------------------------------------------------------
   * 4. NO-BUTTON ESCAPE SYSTEM
   *
   * How it works
   * ------------
   * - Hover does not exist on phones, so we never rely on :hover.
   * - One document-level listener watches `pointermove` + `pointerdown`.
   *   Pointer Events are unified across mouse, pen and touch, so the exact same
   *   code runs on desktop, iPhone Safari, Android Chrome and WhatsApp's browser.
   * - On every event we measure the distance from the pointer to the NO
   *   button (nearest EDGE, not centre, so big buttons aren't unfair).
   *   If it is within ESCAPE_DISTANCE, the button jumps BEFORE it can be tapped.
   * - On touch, `pointerdown` fires the instant a finger lands, so a finger that
   *   touches down near/on NO triggers the jump too. If a stray `click` still
   *   arrives, it is swallowed and also just makes NO run (it never "activates").
   * - NO is never disabled, hidden or removed. After its first escape it is
   *   taken out of the layout (a same-size placeholder keeps the row intact)
   *   and positioned with transform: translate3d(x, y) relative to the card.
   * - New spots are chosen inside the card (and inside the viewport), away from
   *   YES + headings, far from the pointer, and at least MIN_TRAVEL from where
   *   the button currently is.
   * ---------------------------------------------------------------------- */

  const escapers = {}; // cardId -> escaper object

  function createEscaper(card) {
    const noBtn = $('[data-no]', card);
    const taunt = document.createElement('span');
    taunt.className = 'taunt';
    taunt.setAttribute('aria-hidden', 'true');
    card.appendChild(taunt);

    const esc = {
      card,
      noBtn,
      label: $('.btn__label', noBtn),
      avoidEls: $$('[data-avoid]', card),
      taunt,
      tauntTimer: 0,
      free: false,        // has the button been lifted out of the layout yet?
      enabled: false,     // only react once the card has finished animating in
      x: 0, y: 0,         // logical position, relative to the card's top-left
      w: 0, h: 0,         // button size
      attempts: 0,
      lastMove: 0,
      lastTaunt: '',
      placeholder: null,
    };

    // Safety net: a click/tap/Enter on NO must never "activate" it. It just runs.
    noBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // A pointerdown a moment ago already moved it; don't double-jump.
      if (performance.now() - esc.lastMove > 400) handleNoEscape(esc, null, true);
    });

    // Stops touch-drag from starting a scroll/zoom gesture on the button
    noBtn.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });

    escapers[card.dataset.card] = esc;
    return esc;
  }

  function armEscaper(id) {
    const esc = escapers[id];
    if (!esc) return;
    // wait until the enter transition is done so measurements are exact
    setTimeout(() => { if (state.current === Number(id)) esc.enabled = true; }, CONFIG.TRANSITION_MS);
  }

  function disarmEscaper(id) {
    const esc = escapers[id];
    if (esc) esc.enabled = false;
  }

  /** Distance from point (px, py) to the nearest point of rect {left, top, w, h}. */
  function distanceToRect(px, py, r) {
    const dx = Math.max(r.left - px, 0, px - (r.left + r.w));
    const dy = Math.max(r.top - py, 0, py - (r.top + r.h));
    return Math.hypot(dx, dy);
  }

  function rectsOverlap(a, b) {
    return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
  }

  function setTranslate(esc) {
    esc.noBtn.style.transform = `translate3d(${esc.x}px, ${esc.y}px, 0)`;
  }

  /**
   * First escape: lift the button out of the flex row and pin it to the card's
   * top-left corner, then translate it to exactly where it was (no visual jump).
   */
  function liftOutOfLayout(esc) {
    if (esc.free) return;
    const cardRect = esc.card.getBoundingClientRect();
    const r = esc.noBtn.getBoundingClientRect();
    esc.w = r.width;
    esc.h = r.height;

    const slot = document.createElement('span');
    slot.className = 'btn-slot';
    slot.setAttribute('aria-hidden', 'true');
    slot.style.width = `${r.width}px`;
    slot.style.height = `${r.height}px`;
    esc.noBtn.before(slot);
    esc.placeholder = slot;

    esc.x = r.left - cardRect.left;
    esc.y = r.top - cardRect.top;

    esc.noBtn.style.transition = 'none';
    esc.noBtn.classList.add('is-free');
    setTranslate(esc);
    void esc.noBtn.offsetWidth;          // flush so the next change animates
    esc.noBtn.style.transition = '';
    esc.free = true;
  }

  /** Where the button currently is (or is heading to), in viewport coordinates. */
  function currentRect(esc, cardRect) {
    if (esc.free) return { left: cardRect.left + esc.x, top: cardRect.top + esc.y, w: esc.w, h: esc.h };
    const r = esc.noBtn.getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height };
  }

  /**
   * Pointer handler for pointermove + pointerdown (one listener, all devices).
   * Only the card that is currently showing has a live escaper.
   */
  function handlePointerMove(e) {
    const esc = escapers[state.current];
    if (!esc || !esc.enabled) return;
    handleNoEscape(esc, { x: e.clientX, y: e.clientY, type: e.pointerType });
  }

  /**
   * Decide whether NO should run. `force` skips the distance test (used for
   * stray clicks / keyboard activation).
   */
  function handleNoEscape(esc, pointer, force = false) {
    const now = performance.now();
    if (!force) {
      if (now - esc.lastMove < CONFIG.MOVE_COOLDOWN) return false;
      const cardRect = esc.card.getBoundingClientRect();
      const rect = currentRect(esc, cardRect);
      const threshold = CONFIG.ESCAPE_DISTANCE + (pointer.type === 'touch' ? CONFIG.TOUCH_BONUS : 0);
      if (distanceToRect(pointer.x, pointer.y, rect) > threshold) return false;
    }
    moveNoButton(esc, pointer);
    return true;
  }

  /** Pick a new safe spot for the NO button and animate there. */
  function moveNoButton(esc, pointer) {
    liftOutOfLayout(esc);

    const cardRect = esc.card.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    const inset = CONFIG.BOUNDS_INSET;

    // Allowed area for the button's top-left corner: inside the card AND the viewport
    let minX = Math.max(cardRect.left, 0) + inset;
    let maxX = Math.min(cardRect.right, vw) - inset - esc.w;
    let minY = Math.max(cardRect.top, 0) + inset;
    let maxY = Math.min(cardRect.bottom, vh) - inset - esc.h;
    if (maxX < minX) minX = maxX = (minX + maxX) / 2;
    if (maxY < minY) minY = maxY = (minY + maxY) / 2;

    // Things NO must not sit on top of (YES button, headings), slightly inflated
    const pad = CONFIG.AVOID_PADDING;
    const avoid = esc.avoidEls.map((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left - pad, top: r.top - pad, right: r.right + pad, bottom: r.bottom + pad };
    });

    const cur = currentRect(esc, cardRect);
    const safeDist = CONFIG.ESCAPE_DISTANCE + (pointer && pointer.type === 'touch' ? CONFIG.TOUCH_BONUS : 0) + 20;

    const isValid = (cx, cy) => {
      const box = { left: cx, top: cy, right: cx + esc.w, bottom: cy + esc.h };
      return !avoid.some((a) => rectsOverlap(box, a));
    };
    const farFromPointer = (cx, cy) =>
      pointer ? distanceToRect(pointer.x, pointer.y, { left: cx, top: cy, w: esc.w, h: esc.h }) : Infinity;

    // Sample random candidates; prefer ones comfortably far from the pointer
    const good = [];
    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < 48; i++) {
      const cx = rand(minX, maxX);
      const cy = rand(minY, maxY);
      if (!isValid(cx, cy)) continue;
      const travel = Math.hypot(cx - cur.left, cy - cur.top);
      if (travel < CONFIG.MIN_TRAVEL) continue;
      const far = farFromPointer(cx, cy);
      if (far >= safeDist) good.push({ cx, cy });
      const score = Math.min(far, 400) + travel * 0.2;
      if (score > bestScore) { bestScore = score; best = { cx, cy }; }
    }

    let target = good.length ? pick(good) : best;

    // Fallback: try the corners / edge midpoints deterministically
    if (!target) {
      const spots = [
        [minX, minY], [maxX, minY], [minX, maxY], [maxX, maxY],
        [(minX + maxX) / 2, minY], [(minX + maxX) / 2, maxY], [minX, (minY + maxY) / 2], [maxX, (minY + maxY) / 2],
      ].filter(([cx, cy]) => isValid(cx, cy));
      spots.sort((a, b) => farFromPointer(b[0], b[1]) - farFromPointer(a[0], a[1]));
      const s = spots[0] || [maxX, maxY];
      target = { cx: s[0], cy: s[1] };
    }

    esc.x = target.cx - cardRect.left;
    esc.y = target.cy - cardRect.top;
    esc.lastMove = performance.now();
    esc.attempts += 1;
    setTranslate(esc);

    playDashAnimation(esc);
    maybeTaunt(esc);
    vibrate(8);
  }

  function playDashAnimation(esc) {
    const label = esc.label;
    label.classList.remove('is-dashing');
    void label.offsetWidth;
    label.classList.add('is-dashing');
  }

  /** Occasionally pop a cheeky message next to the button's new spot. */
  function maybeTaunt(esc) {
    if (esc.attempts < 2) return;
    const due = esc.attempts % CONFIG.TAUNT_EVERY === 0;
    if (!due && Math.random() > CONFIG.TAUNT_CHANCE) return;

    let text = pick(CONFIG.TAUNTS);
    if (text === esc.lastTaunt) text = pick(CONFIG.TAUNTS);
    esc.lastTaunt = text;

    const el = esc.taunt;
    el.classList.remove('is-visible');
    el.textContent = text;
    el.style.transform = 'translate3d(-999px, 0, 0)';   // park it off-card to measure
    const tw = el.offsetWidth;
    const th = el.offsetHeight;
    const cw = esc.card.clientWidth;

    const tx = clamp(esc.x + esc.w / 2 - tw / 2, 8, cw - tw - 8);
    let ty = esc.y - th - 8;                              // above the button...
    if (ty < 8) ty = esc.y + esc.h + 8;                   // ...or below if there's no room
    el.style.transform = `translate3d(${tx}px, ${ty}px, 0)`;

    void el.offsetWidth;
    el.classList.add('is-visible');
    clearTimeout(esc.tauntTimer);
    esc.tauntTimer = setTimeout(() => el.classList.remove('is-visible'), 1300);
  }

  /** If the screen is resized/rotated, re-pick a safe spot inside the new bounds. */
  function handleResize() {
    const esc = escapers[state.current];
    if (esc && esc.free) moveNoButton(esc, null);
  }

  /* ------------------------------------------------------------------------
   * 5. SELECTIONS
   * ---------------------------------------------------------------------- */

  /** Shared single-select logic for the circular option cards. */
  function selectOption(btn) {
    const group = btn.closest('[data-group]');
    $$('.option', group).forEach((o) => o.setAttribute('aria-checked', String(o === btn)));

    const disc = $('.option__disc', btn);
    disc.classList.remove('is-popping');
    void disc.offsetWidth;
    disc.classList.add('is-popping');

    const card = btn.closest('.card');
    const reveal = $('[data-reveal]', card);
    if (reveal) reveal.classList.add('is-shown');
    vibrate(10);
  }

  function selectFood(btn) {
    state.selectedFood = `${btn.dataset.emoji} ${btn.dataset.value}`;
    selectOption(btn);
  }

  function selectActivity(btn) {
    state.selectedActivity = `${btn.dataset.emoji} ${btn.dataset.value}`;
    selectOption(btn);
  }

  function selectAfter(btn) {
    state.selectedAfter = `${btn.dataset.emoji} ${btn.dataset.value}`;
    selectOption(btn);
  }

  function todayISO() {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
  }

  function formatDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  }

  function formatTime(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return new Date(2000, 0, 1, h, m).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  /** Validate the date + time card, then move on. */
  function submitDateDetails() {
    const dateInput = $('[data-input="date"]');
    const timeInput = $('[data-input="time"]');
    const hint = $('[data-hint]');

    const missing = [dateInput, timeInput].filter((i) => !i.value);
    [dateInput, timeInput].forEach((i) => i.setAttribute('aria-invalid', String(!i.value)));

    if (missing.length) {
      hint.textContent = 'Pick a day and a time first 💕';
      missing[0].focus({ preventScroll: true });
      return;
    }

    hint.textContent = '';
    state.selectedDate = dateInput.value;
    state.selectedTime = timeInput.value;
    showCard(8);
  }

  /* ------------------------------------------------------------------------
   * 6. FINAL RESULT
   * ---------------------------------------------------------------------- */
  function showFinalResult() {
    const out = (key, text) => { const el = $(`[data-out="${key}"]`); if (el) el.textContent = text; };
    out('date', state.selectedDate ? formatDate(state.selectedDate) : '—');
    out('time', state.selectedTime ? formatTime(state.selectedTime) : '—');
    out('food', state.selectedFood || '—');
    out('activity', state.selectedActivity || '—');
    out('after', state.selectedAfter || '—');

    setHeartRate(450);
    createConfetti({ mode: 'burst', count: 90, x: 0.5, y: 0.32 });
    createConfetti({ mode: 'rain', count: 90, duration: 4500 });
    sendResponse();
  }

  /** Plain-text version of everything she picked. */
  function buildAnswerText() {
    const noTries = Object.values(escapers).reduce((n, e) => n + e.attempts, 0);
    return [
      'The answer is YES! ❤️ Here is what was picked:',
      '',
      `Date: ${state.selectedDate ? formatDate(state.selectedDate) : '—'}`,
      `Time: ${state.selectedTime ? formatTime(state.selectedTime) : '—'}`,
      `Food: ${state.selectedFood || '—'}`,
      `Plan: ${state.selectedActivity || '—'}`,
      `After: ${state.selectedAfter || '—'}`,
      '',
      `Times the NO button escaped: ${noTries} 😂`,
    ].join('\n');
  }

  /**
   * Deliver the answers to the person who built the site. The site has no
   * backend, so this uses (a) an email form service and/or (b) a pre-filled
   * WhatsApp message. Runs once, when the final card opens.
   */
  async function sendResponse() {
    if (state.sent) return;
    state.sent = true;

    const text = buildAnswerText();
    const status = $('[data-send-status]');
    const wa = $('[data-whatsapp]');

    if (RESPONSE.WHATSAPP_NUMBER) {
      wa.href = `https://wa.me/${RESPONSE.WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`;
      wa.hidden = false;
    }
    if (!RESPONSE.WEB3FORMS_KEY) return;

    status.textContent = 'Sending your answers… 💌';
    try {
      const res = await fetch('https://api.web3forms.com/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          access_key: RESPONSE.WEB3FORMS_KEY,
          subject: 'Date proposal: YES! 💌 Her answers',
          from_name: 'Date proposal site',
          message: text,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.message || 'send failed');
      status.textContent = 'Your answers were sent 💌';
    } catch (err) {
      console.warn('Could not send answers:', err);
      status.textContent = wa.hidden ? '' : 'Tap the button below to send them 💌';
    }
  }

  /** Card 2 party. */
  function celebrate() {
    createConfetti({ mode: 'burst', count: 40, x: 0.15, y: 0.55 });
    createConfetti({ mode: 'burst', count: 40, x: 0.85, y: 0.55 });
    createConfetti({ mode: 'rain', count: 60, duration: 3200 });
  }

  /* ------------------------------------------------------------------------
   * 7. CONFETTI (canvas) + FLOATING HEARTS
   * ---------------------------------------------------------------------- */
  const confettiState = {
    canvas: $('#confetti'),
    ctx: null,
    dpr: 1,
    w: 0,
    h: 0,
    particles: [],
    raf: 0,
    last: 0,
    rainUntil: 0,
    rainRate: 0,       // particles per ms
    rainCarry: 0,
  };
  const CONFETTI_COLORS = ['#E85D88', '#F7A8C2', '#B58AD9', '#FFFFFF', '#FFD6A5', '#FFC2D6', '#D9B8F0'];

  function sizeConfettiCanvas() {
    const c = confettiState;
    c.dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.w = window.innerWidth;
    c.h = window.innerHeight;
    c.canvas.width = Math.round(c.w * c.dpr);
    c.canvas.height = Math.round(c.h * c.dpr);
    c.ctx = c.canvas.getContext('2d');
    c.ctx.setTransform(c.dpr, 0, 0, c.dpr, 0, 0);
  }

  function makeParticle(x, y, vx, vy) {
    return {
      x, y, vx, vy,
      size: rand(7, 13),
      color: pick(CONFETTI_COLORS),
      shape: pick(['rect', 'rect', 'circle', 'heart']),
      rot: rand(0, Math.PI * 2),
      vrot: rand(-6, 6),
      tilt: rand(0, Math.PI * 2),
      vtilt: rand(4, 9),
      age: 0,
    };
  }

  function drawHeart(ctx, s) {
    const t = s * 0.5;
    ctx.beginPath();
    ctx.moveTo(0, t * 0.7);
    ctx.bezierCurveTo(-t * 1.5, -t * 0.2, -t * 0.7, -t * 1.2, 0, -t * 0.45);
    ctx.bezierCurveTo(t * 0.7, -t * 1.2, t * 1.5, -t * 0.2, 0, t * 0.7);
    ctx.fill();
  }

  /**
   * createConfetti({ mode, count, x, y, duration })
   *   mode 'burst': a fan of pieces shot upward from (x, y) — fractions of the viewport.
   *   mode 'rain' : `count` pieces drizzled from the top over `duration` ms.
   */
  function createConfetti({ mode = 'burst', count = 60, x = 0.5, y = 0.4, duration = 3000 } = {}) {
    if (reducedMotion) return;
    const c = confettiState;

    if (mode === 'burst') {
      for (let i = 0; i < count; i++) {
        const angle = -Math.PI / 2 + rand(-1.15, 1.15);
        const speed = rand(260, 640);
        c.particles.push(makeParticle(c.w * x, c.h * y, Math.cos(angle) * speed, Math.sin(angle) * speed));
      }
    } else {
      c.rainUntil = performance.now() + duration;
      c.rainRate = count / duration;
    }

    if (!c.raf) {
      c.last = performance.now();
      c.raf = requestAnimationFrame(confettiTick);
    }
  }

  function confettiTick(ts) {
    const c = confettiState;
    const dt = Math.min((ts - c.last) / 1000, 0.04);
    c.last = ts;
    const ctx = c.ctx;
    ctx.clearRect(0, 0, c.w, c.h);

    // spawn rain
    if (ts < c.rainUntil) {
      c.rainCarry += c.rainRate * dt * 1000;
      while (c.rainCarry >= 1) {
        c.rainCarry -= 1;
        c.particles.push(makeParticle(rand(0, c.w), -14, rand(-40, 40), rand(40, 160)));
      }
    }

    const GRAVITY = 720;
    c.particles = c.particles.filter((p) => p.y < c.h + 24 && p.age < 6);

    for (const p of c.particles) {
      p.age += dt;
      p.vy += GRAVITY * dt;
      p.vx *= 1 - 1.6 * dt;                       // air drag
      p.vy = Math.min(p.vy, 380);                 // terminal velocity so it flutters
      p.x += p.vx * dt + Math.sin(p.age * 3 + p.tilt) * 18 * dt;
      p.y += p.vy * dt;
      p.rot += p.vrot * dt;
      p.tilt += p.vtilt * dt;

      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = Math.min(1, (6 - p.age) / 1.5);
      ctx.fillStyle = p.color;
      if (p.shape === 'heart') {
        drawHeart(ctx, p.size * 1.2);
      } else if (p.shape === 'circle') {
        ctx.beginPath();
        ctx.arc(0, 0, p.size * 0.35, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.scale(1, Math.max(0.15, Math.abs(Math.cos(p.tilt)))); // flutter
        ctx.fillRect(-p.size / 2, -p.size * 0.3, p.size, p.size * 0.6);
      }
      ctx.restore();
    }

    if (c.particles.length || ts < c.rainUntil) {
      c.raf = requestAnimationFrame(confettiTick);
    } else {
      c.raf = 0;
      ctx.clearRect(0, 0, c.w, c.h);
    }
  }

  /* ----- floating hearts ----- */
  const heartsLayer = $('#hearts');
  const HEARTS = ['💗', '💕', '🌸', '💖', '🤍', '💞'];
  const MAX_HEARTS = 16;
  let heartTimer = 0;

  function spawnHeart() {
    if (reducedMotion || document.hidden) return;
    if (heartsLayer.childElementCount >= MAX_HEARTS) return;
    const el = document.createElement('span');
    el.className = 'float-heart';
    el.textContent = pick(HEARTS);
    el.style.setProperty('--x', `${rand(2, 94)}%`);
    el.style.setProperty('--size', `${rand(14, 30)}px`);
    el.style.setProperty('--dur', `${rand(8, 13)}s`);
    el.style.setProperty('--drift', `${rand(-40, 40)}px`);
    el.style.setProperty('--op', String(rand(0.35, 0.65)));
    el.addEventListener('animationend', () => el.remove(), { once: true });
    heartsLayer.appendChild(el);
  }

  function setHeartRate(ms) {
    clearInterval(heartTimer);
    heartTimer = setInterval(spawnHeart, ms);
  }

  /* ------------------------------------------------------------------------
   * 8. INIT
   * ---------------------------------------------------------------------- */
  function init() {
    // Hide every card except the first from assistive tech + keyboard
    Object.entries(cardEls).forEach(([id, el]) => {
      if (Number(id) !== state.current) { el.setAttribute('aria-hidden', 'true'); el.inert = true; }
    });

    // Delegated clicks: any element with data-goto moves to that card
    document.addEventListener('click', (e) => {
      const goto = e.target.closest('[data-goto]');
      if (goto) { vibrate(10); showCard(goto.dataset.goto); return; }

      const option = e.target.closest('.option');
      if (option) {
        const group = option.closest('[data-group]').dataset.group;
        if (group === 'food') selectFood(option);
        else if (group === 'after') selectAfter(option);
        else selectActivity(option);
        return;
      }

      if (e.target.closest('[data-submit-date]')) submitDateDetails();
    });

    // Clear the "missing" state as soon as a field is filled
    $$('.field__input').forEach((input) =>
      input.addEventListener('input', () => input.setAttribute('aria-invalid', 'false')));

    // Dates in the past make no sense
    $('[data-input="date"]').min = todayISO();

    // NO-button escape system: one listener pair for every device type
    $$('.card--chase').forEach(createEscaper);
    document.addEventListener('pointermove', handlePointerMove, { passive: true });
    document.addEventListener('pointerdown', handlePointerMove, { capture: true, passive: true });

    // Keep everything inside bounds on rotate / resize / mobile toolbar changes
    let resizeTimer = 0;
    const onResize = () => {
      sizeConfettiCanvas();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(handleResize, 150);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);

    // Card 1 eases in on load (same transition as every other card)
    requestAnimationFrame(() => requestAnimationFrame(() => cardEls[1].classList.add('is-active')));

    sizeConfettiCanvas();
    setHeartRate(2800);       // sparse ambient hearts; speeds up on the final card
    armEscaper(1);
  }

  init();
})();
