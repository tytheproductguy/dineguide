/* ===========================================================================
   DineGuide PWA.

   No server: the OpenAI key is entered once by the user and kept in this
   device's localStorage, and requests go straight to api.openai.com. That keeps
   the key off any third-party machine and means there is nothing to deploy,
   pay for, or keep running while travelling. The trade-off is that the key sits
   in this origin's storage, so it is only appropriate for a personal build.
   =========================================================================== */

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = 'gpt-4o';
const MAX_EDGE = 1024;          // longest edge sent to OpenAI
const SCAN_STEP_MS = 2150;

// --------------------------------------------------------------------------
// Storage
// --------------------------------------------------------------------------

const Store = {
  get(k, fallback) {
    try { const v = localStorage.getItem('dg.' + k); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(k, v) { try { localStorage.setItem('dg.' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('dg.' + k); } catch {} },
};

/** Scan history. IndexedDB rather than localStorage: menus with many dishes
 *  would otherwise crowd a 5MB quota shared with everything else. */
const History = {
  db: null,
  async open() {
    if (this.db) return this.db;
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('dineguide', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('scans')) {
          db.createObjectStore('scans', { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  },
  async all() {
    try {
      const db = await this.open();
      const items = await new Promise((resolve, reject) => {
        const req = db.transaction('scans').objectStore('scans').getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
      return items.sort((a, b) => b.savedAt - a.savedAt);
    } catch { return []; }
  },
  async put(menu) {
    try {
      const db = await this.open();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('scans', 'readwrite');
        tx.objectStore('scans').put(menu);
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
    } catch {}
  },
  async remove(id) {
    try {
      const db = await this.open();
      await new Promise((resolve) => {
        const tx = db.transaction('scans', 'readwrite');
        tx.objectStore('scans').delete(id);
        tx.oncomplete = resolve; tx.onerror = resolve;
      });
    } catch {}
  },
};

// --------------------------------------------------------------------------
// App state
// --------------------------------------------------------------------------

const state = {
  screen: Store.get('onboarded', false) ? 'capture' : 'onboard',
  obStep: 0,
  language: Store.get('language', 'English'),
  currency: Store.get('currency', 'USD'),
  dark: Store.get('dark', false),
  tsize: Store.get('tsize', 'M'),
  pages: [],            // { blob, url } captured menu pages
  reviewIndex: 0,
  scanStep: 0,
  scanError: null,
  menu: null,           // the menu on screen
  section: 0,
  detailId: null,
  searching: false,
  query: '',
  flash: false,
  overlay: null,        // 'settings' | 'history' | 'confirm'
  history: [],
  pronSeen: Store.get('pronSeen', false),
};

const LANGUAGES = ['English', 'Español', 'Français', 'Deutsch', 'Italiano'];
const CURRENCIES = [['USD', '$'], ['GBP', '£'], ['EUR', '€']];
const TEXT_SIZES = { S: 0.9, M: 1, L: 1.15 };

const SCAN_STEPS = [
  'Identifying the language',
  'Finding every menu item',
  'Translating each dish',
  () => `Converting prices to ${state.currency}`,
  'Finding photos of each plate',
  'Adding notes on each dish',
  'Setting the table',
];

// --------------------------------------------------------------------------
// Currency
// --------------------------------------------------------------------------

/** Units per 1 USD. Static: fine for reading a menu, not for settling a bill. */
const FX_PER_USD = {
  USD: 1, EUR: 1 / 1.09, GBP: 0.85 / 1.09, JPY: 157, CHF: 0.88, CAD: 1.38,
  AUD: 1.52, MXN: 17.1, THB: 34.6, SEK: 10.9, DKK: 6.9, NOK: 10.8,
  PLN: 3.95, CZK: 23.2, TRY: 34.5,
};
const SYMBOLS = {
  USD: '$', EUR: '€', GBP: '£', JPY: '¥', CHF: 'CHF', CAD: 'CA$', AUD: 'A$',
  MXN: 'MX$', THB: '฿', SEK: 'kr', DKK: 'kr', NOK: 'kr', PLN: 'zł', CZK: 'Kč', TRY: '₺',
};
const symbolFor = (c) => SYMBOLS[(c || '').toUpperCase()] || (c || '').toUpperCase();
const fmtAmount = (n) => (n === Math.round(n) ? String(n) : String(Number(n.toFixed(2))));

function printedPrice(item) {
  if (item.price == null) return '';
  return item.currency ? `${fmtAmount(item.price)} ${symbolFor(item.currency)}` : fmtAmount(item.price);
}
function convertedPrice(item) {
  if (item.price == null || !item.currency) return '';
  const from = FX_PER_USD[item.currency.toUpperCase()];
  const to = FX_PER_USD[state.currency];
  if (!from || !to || item.currency.toUpperCase() === state.currency) return '';
  return `${symbolFor(state.currency)}${Math.round((item.price / from) * to)}`;
}

// --------------------------------------------------------------------------
// Utilities
// --------------------------------------------------------------------------

/** Menu text comes from a photograph, so it is untrusted input: a printed menu
 *  could carry markup. Everything model-derived goes through here. */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Downscale before upload: a phone photo is ~12MP, and roaming data is the
 *  scarce resource here as much as tokens are. */
async function downscale(blob, maxEdge = MAX_EDGE) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return new Promise((res) => canvas.toBlob((b) => res(b || blob), 'image/jpeg', 0.82));
}
const blobToDataURL = (blob) => new Promise((res) => {
  const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob);
});

// --------------------------------------------------------------------------
// OpenAI
// --------------------------------------------------------------------------

const MENU_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['language', 'restaurantName', 'sections'],
  properties: {
    language: { type: 'string', description: "Language the menu is written in, in English, e.g. 'Italian'." },
    restaurantName: { type: ['string', 'null'], description: 'Restaurant name as printed, uppercase. Null if not visible.' },
    sections: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['name', 'translation', 'note', 'items'],
        properties: {
          name: { type: 'string', description: 'Section heading exactly as printed, uppercase.' },
          translation: { type: 'string', description: 'The heading in the target language, 1-3 words.' },
          note: { type: 'string', description: 'One short line of cultural context for this section.' },
          items: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              required: ['original', 'translated', 'description', 'ingredients', 'price', 'currency',
                         'pronunciation', 'vegetarian', 'glutenFree'],
              properties: {
                original: { type: 'string', description: 'Dish name exactly as printed. Name only.' },
                translated: { type: 'string', description: 'Dish name in the target language.' },
                description: { type: 'string', description: 'One or two sentences on what the dish actually is.' },
                ingredients: { type: 'string', description: 'Comma-separated main ingredients, lowercase.' },
                price: { type: ['number', 'null'], description: 'Numeric price as printed, else null.' },
                currency: { type: ['string', 'null'], description: 'ISO code, only if a symbol is visible. Else null.' },
                pronunciation: { type: 'string', description: "Phonetic respelling, e.g. 'boo-RAH-tah'." },
                vegetarian: { type: 'boolean' },
                glutenFree: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
  },
};

function systemPrompt(lang) {
  return [
    'You read photographs of restaurant menus and return structured data.',
    `Translate into ${lang}.`, '', 'Rules:',
    "- Transcribe every dish you can read. Keep 'original' exactly as printed, including accents.",
    "- 'original' is the dish NAME ONLY. Strip any price, trailing dashes, and dietary markers such as (v) or (vg); those belong in the price and dietary fields.",
    "- Do not repeat the price anywhere in 'original', 'translated', or 'description'.",
    `- 'translated' is the dish name in ${lang}. If the menu is already in ${lang}, repeat the original name.`,
    "- 'description' explains what the dish actually is to someone who has never seen it. Be concrete about preparation and what arrives on the plate. Never invent ingredients you cannot see or reasonably infer from the dish name.",
    "- Preserve the menu's own section headings and order. If the menu has no headings, use one section named 'MENU'.",
    '- A section name must be a course or category heading. Never use the restaurant name, address, or a tagline.',
    '- Never create one section per dish, and never use a dish name as a section name.',
    '- Read prices exactly as printed. If a price is unreadable or absent, use null rather than guessing.',
    "- Set 'currency' only when a currency symbol or code is actually printed. If prices are bare numbers, use null. Never infer currency from the cuisine or language: a wrong currency produces a wrong conversion, which is worse than none.",
    '- Set vegetarian/glutenFree only when you are confident from the dish itself or an explicit menu marking.',
    '- If several photos are supplied they are consecutive pages of one menu. Merge them into one set of sections.',
    '- If the image is not a menu, return an empty sections array.',
    '- No em dashes anywhere in your output.',
  ].join('\n');
}

/* The model does not reliably respect structural rules however firmly the prompt
   states them: across repeated runs on one photo it has used the restaurant
   banner as a heading, given every dish its own section, named a section after
   one of its own dishes, and left "(v)" on names. These are enforced here
   instead. Pass order matters: markers are stripped first so names compare
   cleanly, and the per-dish merge runs before relabelling, because relabelling
   destroys the signal the merge detects. */
const norm = (s) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const DIETARY = /\s*\((?:v|vg|ve|veg|vegan|vegetarian|gf|df|n|nf)\)\s*$/i;

function sanitize(menu) {
  for (const s of menu.sections) {
    for (const it of s.items) {
      for (const k of ['original', 'translated']) {
        const after = (it[k] ?? '').replace(DIETARY, '').trim();
        if (after && after !== it[k]) it[k] = after;
      }
    }
  }

  // Fold runs of single-dish sections into one.
  const isPerDish = (s) => s.items.length === 1 && norm(s.name) === norm(s.items[0]?.original);
  if (menu.sections.some(isPerDish)) {
    const out = []; let pending = null;
    for (const s of menu.sections) {
      if (isPerDish(s)) {
        if (pending) pending.items.push(...s.items);
        else pending = { name: 'MENU', translation: '', note: '', items: [...s.items] };
        continue;
      }
      if (pending) { out.push(pending); pending = null; }
      out.push(s);
    }
    if (pending) out.push(pending);
    menu.sections = out;
  }

  // A heading that is really the restaurant's name, or one of its own dishes.
  const restaurant = norm(menu.restaurantName);
  for (const s of menu.sections) {
    const name = norm(s.name);
    if (!name) continue;
    const isRestaurant = !!restaurant &&
      (name === restaurant || name.includes(restaurant) || restaurant.includes(name));
    const isOwnDish = s.items.some((i) => norm(i.original) === name);
    if (!isRestaurant && !isOwnDish) continue;

    const cand = (s.translation ?? '').trim();
    const c = norm(cand);
    const usable = !!c && c !== name &&
      !(restaurant && (c === restaurant || c.includes(restaurant) || restaurant.includes(c)));
    s.name = (usable ? cand : 'MENU').toUpperCase();
    if (!usable) s.translation = '';
  }

  // Folding and relabelling can leave neighbours sharing a heading.
  const merged = [];
  for (const s of menu.sections) {
    const prev = merged[merged.length - 1];
    if (prev && norm(prev.name) === norm(s.name)) { prev.items.push(...s.items); continue; }
    merged.push(s);
  }
  menu.sections = merged;
  return menu;
}

class ScanError extends Error {}

async function scanMenu(blobs, { signal } = {}) {
  const key = Store.get('apiKey', '');
  if (!key) throw new ScanError('No API key set. Add one in Settings.');

  const prepared = await Promise.all(blobs.map((b) => downscale(b)));
  const dataURLs = await Promise.all(prepared.map(blobToDataURL));

  let res;
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        response_format: { type: 'json_schema', json_schema: { name: 'menu', strict: true, schema: MENU_SCHEMA } },
        messages: [
          { role: 'system', content: systemPrompt(state.language) },
          { role: 'user', content: [
            { type: 'text', text: dataURLs.length > 1
                ? `These ${dataURLs.length} photos are consecutive pages of one menu.`
                : 'Read this menu.' },
            // low detail downsamples to 512px and cannot read menu type at all.
            ...dataURLs.map((url) => ({ type: 'image_url', image_url: { url, detail: 'high' } })),
          ] },
        ],
      }),
    });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ScanError('No connection. Check your data or Wi-Fi and try again.');
  }

  if (!res.ok) {
    if (res.status === 401) throw new ScanError('OpenAI rejected the API key. Check it in Settings.');
    if (res.status === 429) throw new ScanError('OpenAI rate limit or quota reached. Check your credit balance.');
    let detail = '';
    try { detail = (await res.json())?.error?.message || ''; } catch {}
    throw new ScanError(detail || `The scan failed (HTTP ${res.status}).`);
  }

  const payload = await res.json();
  let menu;
  try { menu = JSON.parse(payload.choices[0].message.content); }
  catch { throw new ScanError('The reply could not be read. Try again.'); }

  sanitize(menu);
  if (!menu.sections.reduce((n, s) => n + s.items.length, 0)) {
    throw new ScanError('That photo does not look like a menu.');
  }

  menu.id = String(Date.now());
  menu.savedAt = Date.now();
  menu.restaurantName = (menu.restaurantName || 'Scanned menu').toUpperCase();
  return menu;
}

/** Cheap key check for the settings screen: lists models, spends nothing. */
async function verifyKey(key) {
  try {
    const r = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } });
    if (r.ok) return { ok: true };
    if (r.status === 401) return { ok: false, msg: 'That key was rejected.' };
    return { ok: false, msg: `Could not verify (HTTP ${r.status}).` };
  } catch {
    return { ok: false, msg: 'No connection, so the key could not be checked.' };
  }
}

// --------------------------------------------------------------------------
// Icons
// --------------------------------------------------------------------------

const ICON = {
  sliders: (c = 'currentColor') => `<svg width="16" height="14" viewBox="0 0 17 15" aria-hidden="true">
    <line x1="1" y1="3.5" x2="16" y2="3.5" stroke="${c}" stroke-width="1.4"/><circle cx="11" cy="3.5" r="2.4" fill="${c}"/>
    <line x1="1" y1="11.5" x2="16" y2="11.5" stroke="${c}" stroke-width="1.4"/><circle cx="6" cy="11.5" r="2.4" fill="${c}"/></svg>`,
  search: (c = 'currentColor') => `<svg width="15" height="15" viewBox="0 0 20 20" aria-hidden="true">
    <circle cx="8.5" cy="8.5" r="6" fill="none" stroke="${c}" stroke-width="1.7"/>
    <line x1="13.2" y1="13.2" x2="18" y2="18" stroke="${c}" stroke-width="1.7" stroke-linecap="round"/></svg>`,
  close: (c = 'currentColor') => `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <line x1="1" y1="1" x2="11" y2="11" stroke="${c}" stroke-width="1.4"/>
    <line x1="11" y1="1" x2="1" y2="11" stroke="${c}" stroke-width="1.4"/></svg>`,
  bolt: (fill, stroke) => `<svg width="15" height="21" viewBox="0 0 15 21" aria-hidden="true">
    <path d="M8.6 1 L2 12 H6.8 L5.6 20 L13 8.6 H7.6 Z" fill="${fill}" stroke="${stroke}" stroke-width="1.4" stroke-linejoin="round"/></svg>`,
  photo: (c) => `<svg width="27" height="23" viewBox="0 0 27 23" aria-hidden="true">
    <rect x="1" y="1" width="25" height="21" rx="4.5" fill="none" stroke="${c}" stroke-width="1.6"/>
    <circle cx="8.7" cy="7.6" r="2.3" fill="${c}"/>
    <path d="M3.4 18.2 L10.4 11 L14.6 15.2 L18.4 11.3 L23.6 16.6" fill="none" stroke="${c}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`,
  history: (c) => `<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3 12a9 9 0 1 0 3-6.7" fill="none" stroke="${c}" stroke-width="1.7" stroke-linecap="round"/>
    <path d="M3 3.5V8.5H8" fill="none" stroke="${c}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  speaker: (c) => `<svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3 9 V15 H7 L12 19 V5 L7 9 Z" fill="${c}"/>
    <path d="M15.5 8.5 a5 5 0 0 1 0 7" stroke="${c}" fill="none" stroke-width="1.7" stroke-linecap="round"/>
    <path d="M18 6 a8.5 8.5 0 0 1 0 12" stroke="${c}" fill="none" stroke-width="1.7" stroke-linecap="round"/></svg>`,
};

// --------------------------------------------------------------------------
// Camera
// --------------------------------------------------------------------------

const Camera = {
  stream: null, video: null, track: null,

  async start(videoEl) {
    this.video = videoEl;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          // Menu type is small, so ask for as much detail as the device will give.
          width: { ideal: 3840 }, height: { ideal: 2160 },
          // Ignored where unsupported, but keeps the feed sharp where it is not.
          advanced: [{ focusMode: 'continuous' }],
        },
        audio: false,
      });
      videoEl.srcObject = this.stream;
      this.track = this.stream.getVideoTracks()[0];
      await videoEl.play().catch(() => {});
      return true;
    } catch {
      // Denied, unavailable, or an insecure origin: the file input still works.
      return false;
    }
  },

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null; this.track = null;
  },

  get hasTorch() {
    return !!this.track?.getCapabilities?.().torch;
  },

  async setTorch(on) {
    if (!this.hasTorch) return false;
    try { await this.track.applyConstraints({ advanced: [{ torch: on }] }); return true; }
    catch { return false; }
  },

  /** Grab a still at the video's native resolution. */
  async capture() {
    if (!this.video || !this.video.videoWidth) return null;
    const canvas = document.createElement('canvas');
    canvas.width = this.video.videoWidth;
    canvas.height = this.video.videoHeight;
    canvas.getContext('2d').drawImage(this.video, 0, 0);
    return new Promise((res) => canvas.toBlob((b) => res(b), 'image/jpeg', 0.92));
  },
};

/** Native camera / library picker. Always available, and the fallback when
 *  getUserMedia is refused. */
function pickImages({ camera = false, multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    if (camera) input.capture = 'environment';
    if (multiple) input.multiple = true;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      resolve([...(input.files || [])]);
      input.remove();
    }, { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

// --------------------------------------------------------------------------
// Views
// --------------------------------------------------------------------------

const app = document.getElementById('app');

function render() {
  document.documentElement.dataset.theme = state.dark ? 'dark' : 'light';
  document.documentElement.style.setProperty('--tscale', TEXT_SIZES[state.tsize]);

  let html = '';
  switch (state.screen) {
    case 'onboard':  html = viewOnboard(); break;
    case 'capture':  html = viewCamera(); break;
    case 'review':   html = viewReview(); break;
    case 'scanning': html = viewScanning(); break;
    case 'menu':     html = viewMenu(); break;
  }
  if (state.overlay === 'settings') html += viewSettings();
  if (state.overlay === 'history')  html += viewHistory();
  if (state.overlay === 'confirm')  html += viewConfirm();

  app.innerHTML = html;
  wire();
  fitRestaurantName();
}

/** The CSS equivalent of minimumScaleFactor: step the wordmark down until a long
 *  scanned restaurant name fits between the chrome buttons, rather than clipping. */
const measureCanvas = document.createElement('canvas').getContext('2d');

function fitRestaurantName() {
  const el = $('.rest-name');
  if (!el) return;
  const cs = getComputedStyle(el);
  const avail = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  if (avail <= 0) return;

  const text = el.textContent.trim();
  // Measured rather than compared against layout height: the element's padding
  // makes scrollHeight/clientHeight comparisons unreliable under line-clamp.
  const widthAt = (str, size, track) => {
    measureCanvas.font = `500 ${size}px ${cs.fontFamily}`;
    // measureText ignores letter-spacing, so add the tracking back per character.
    return measureCanvas.measureText(str).width + str.length * track * size;
  };

  const longest = text.split(/\s+/).reduce((a, b) => (b.length > a.length ? b : a), '');
  const fits = (size, track) =>
    // 1.85 rather than 2: word wrapping never packs two lines perfectly.
    widthAt(text, size, track) <= avail * 1.85 &&
    // An unbreakable word longer than one line would overflow regardless.
    widthAt(longest, size, track) <= avail;

  // Ordered from the design's own treatment down to a still-legible fallback.
  const STEPS = [[21, .30], [19, .30], [17, .24], [16, .18], [15, .12], [13, .08]];

  const apply = (i) => {
    el.style.setProperty('--rest-size', STEPS[i][0] + 'px');
    el.style.setProperty('--rest-track', STEPS[i][1] + 'em');
  };
  // Measurement gives a good first guess but cannot predict where the browser
  // breaks lines, so the real layout gets the final say.
  const clipped = () => {
    const pad = parseFloat(getComputedStyle(el).paddingTop) || 0;
    const allowed = pad + 2 * STEPS[at][0] * 1.2 + 2;
    return el.scrollHeight > allowed;
  };

  let at = STEPS.findIndex(([s, k]) => fits(s, k));
  if (at < 0) at = STEPS.length - 1;
  apply(at);
  while (at < STEPS.length - 1 && clipped()) { at += 1; apply(at); }
}

// ---------- onboarding ----------

function viewOnboard() {
  const step = state.obStep;
  const body = step === 0 ? `
      <img class="ob-icon" src="assets/logo-icon.png" alt="">
      <h1 class="ob-h1">Make every menu make sense.</h1>
      <img class="ob-hero" src="assets/onboard-hero.jpg" alt="">
      <p class="ob-body-text">Point your camera at any menu, in any language. Every dish is translated, explained, and pictured before you order.</p>
      <div class="ob-micro">120+ LANGUAGES · 90 COUNTRIES · 48,000 DISHES</div>`
    : step === 1 ? `
      <h2 class="ob-h2">Order like a local, everywhere.</h2>
      <div style="margin-top:34px">
        ${[['01', 'Never order blind', 'See what every dish actually is before you choose. No more pointing and hoping.'],
           ['02', "Know what's inside", 'Every ingredient and preparation in plain English, with vegetarian and gluten-free marked.'],
           ['03', 'No surprise bills', 'Prices converted to your own currency as you read, right next to the original.']]
          .map(([n, t, d]) => `<div class="ob-row"><div class="n">${n}</div>
            <div><div class="t">${t}</div><div class="d">${d}</div></div></div>`).join('')}
      </div>`
    : `
      <h2 class="ob-h2">Make it yours.</h2>
      <div class="group-label" style="margin-top:30px">TRANSLATE MENUS INTO</div>
      <div class="chips" style="margin-top:12px">
        ${LANGUAGES.map((l) => `<button class="chip ${state.language === l ? 'on' : ''}" data-lang="${esc(l)}">${esc(l)}</button>`).join('')}
      </div>
      <div class="group-label" style="margin-top:24px">SHOW PRICES IN</div>
      <div class="chips" style="margin-top:12px">
        ${CURRENCIES.map(([c, s]) => `<button class="chip ${state.currency === c ? 'on' : ''}" data-cur="${c}">${c} ${s}</button>`).join('')}
      </div>
      <div class="group-label" style="margin-top:24px">OPENAI API KEY</div>
      <input class="key-field" id="ob-key" type="password" inputmode="text" autocomplete="off"
             autocapitalize="off" autocorrect="off" spellcheck="false"
             placeholder="sk-..." value="${esc(Store.get('apiKey', ''))}">
      <div class="key-note">Stored only on this phone, and sent only to OpenAI. Get one at
        <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener">platform.openai.com/api-keys</a>.
        Scans cost roughly 1.5 cents each.</div>
      <div class="key-status" id="ob-key-status"></div>
      <div class="ob-summary">Menus in ${esc(state.language)} · prices in ${esc(state.currency)}</div>`;

  return `<div class="screen paper ob">
    <div class="ob-top"><div class="wordmark">dineguide</div></div>
    <div class="ob-body ${step === 2 ? 'scroll' : ''}">${body}</div>
    <div class="ob-foot">
      <div class="dots">${[0, 1, 2].map((i) => `<div class="dot ${i === step ? 'on' : ''}"></div>`).join('')}</div>
      <button class="btn-primary" id="ob-next">${step === 2 ? 'START SCANNING' : 'CONTINUE'}</button>
    </div>
  </div>`;
}

// ---------- camera ----------

function viewCamera() {
  const cream = 'rgba(244,241,234,.92)';
  const bracket = (pos) => {
    const style = {
      tl: 'top:calc(120px + var(--safe-top));left:30px;border-top:1.5px solid rgba(244,241,234,.9);border-left:1.5px solid rgba(244,241,234,.9)',
      tr: 'top:calc(120px + var(--safe-top));right:30px;border-top:1.5px solid rgba(244,241,234,.9);border-right:1.5px solid rgba(244,241,234,.9)',
      bl: 'bottom:calc(210px + var(--safe-bottom));left:30px;border-bottom:1.5px solid rgba(244,241,234,.9);border-left:1.5px solid rgba(244,241,234,.9)',
      br: 'bottom:calc(210px + var(--safe-bottom));right:30px;border-bottom:1.5px solid rgba(244,241,234,.9);border-right:1.5px solid rgba(244,241,234,.9)',
    }[pos];
    return `<div class="bracket" style="${style}"></div>`;
  };
  return `<div class="cam" id="cam">
    <video id="cam-video" playsinline muted autoplay></video>
    <div class="cam-scrim"></div>
    <div class="wordmark">dineguide</div>
    <button class="cam-btn ${state.flash ? 'on' : ''}" id="cam-flash" style="left:20px" aria-label="Flash">
      ${ICON.bolt(state.flash ? '#1c1a17' : 'none', state.flash ? '#1c1a17' : cream)}
    </button>
    <button class="cam-btn" id="cam-settings" style="right:20px" aria-label="Settings">${ICON.sliders(cream)}</button>
    ${bracket('tl')}${bracket('tr')}${bracket('bl')}${bracket('br')}
    <div class="hint"><span>POINT AT THE MENU</span></div>
    <div class="cam-controls">
      <button class="side-btn" id="cam-upload" style="left:34px" aria-label="Choose photo">
        ${ICON.photo(cream)}<span class="lbl">UPLOAD</span>
      </button>
      <button class="shutter" id="cam-shoot" aria-label="Scan menu"><i></i></button>
      <button class="side-btn" id="cam-history" style="right:34px" aria-label="Previous scans">
        ${ICON.history(cream)}<span class="lbl">HISTORY</span>
      </button>
    </div>
  </div>`;
}

// ---------- review ----------

function viewReview() {
  const n = state.pages.length;
  const i = Math.min(state.reviewIndex, n - 1);
  return `<div class="review">
    <button class="circle-btn" id="rev-exit" style="position:absolute;top:calc(64px + var(--safe-top));left:20px;z-index:5;border-color:rgba(244,241,234,.4);color:var(--cream)" aria-label="Back">${ICON.close('#f4f1ea')}</button>
    <div class="wordmark">dineguide</div>
    <div class="pages" id="pages">
      ${state.pages.map((p) => `<div class="page"><img src="${p.url}" alt=""></div>`).join('')}
    </div>
    <div class="page-meta">
      <div style="display:flex;gap:6px">${state.pages.map((_, k) => `<div class="d ${k === i ? 'on' : ''}"></div>`).join('')}</div>
      <div class="lbl">PAGE ${i + 1} OF ${n}</div>
    </div>
    <button class="retake" id="rev-retake">RETAKE PAGE ${i + 1}</button>
    <div class="review-foot">
      <div class="note">Menus can be several pages. Add the next page before analyzing, and swipe to review each page.</div>
      <div class="review-actions">
        <button class="add" id="rev-add">+ ADD PAGE</button>
        <button class="go" id="rev-go">${n > 1 ? `ANALYZE ${n} PAGES` : 'ANALYZE MENU'}</button>
      </div>
    </div>
  </div>`;
}

// ---------- scanning ----------

function viewScanning() {
  const first = state.pages[0];
  const label = SCAN_STEPS[Math.min(state.scanStep, 6)];
  const body = state.scanError ? `
      <div class="scan-error">
        <p>${esc(state.scanError)}</p>
        <div class="row">
          <button class="btn-outline" id="scan-back" style="height:46px;font-size:10px;letter-spacing:.22em">BACK</button>
          <button class="btn-primary" id="scan-retry" style="height:46px;font-size:10px;letter-spacing:.22em">TRY AGAIN</button>
        </div>
      </div>`
    : `<div class="scan-label">${esc(typeof label === 'function' ? label() : label)}</div>`;

  return `<div class="screen paper scanning">
    <button class="circle-btn" id="scan-cancel" style="position:absolute;top:calc(64px + var(--safe-top));left:20px" aria-label="Cancel">${ICON.close()}</button>
    <div class="wordmark">dineguide</div>
    <div class="snapshot">
      ${first ? `<img src="${first.url}" alt="">` : ''}
      ${state.scanError ? '' : '<div class="scanline"></div>'}
    </div>
    ${body}
  </div>`;
}

// ---------- menu ----------

function visibleDishes() {
  const m = state.menu;
  if (!m) return [];
  if (!state.searching) return m.sections[Math.min(state.section, m.sections.length - 1)]?.items ?? [];
  const q = state.query.trim().toLowerCase();
  const all = m.sections.flatMap((s) => s.items);
  if (!q) return all;
  return all.filter((d) =>
    `${d.original} ${d.translated} ${d.ingredients} ${d.description}`.toLowerCase().includes(q));
}

function viewMenu() {
  const m = state.menu;
  if (!m) return '';
  const sec = m.sections[Math.min(state.section, m.sections.length - 1)];
  const dishes = visibleDishes();

  const head = state.searching ? `
      <div class="search-row">
        ${ICON.search('rgba(28,26,23,.5)')}
        <input id="q" placeholder="Search dishes, ingredients…" value="${esc(state.query)}"
               autocapitalize="off" autocorrect="off" spellcheck="false">
        <button id="q-cancel" style="font-size:12px;font-weight:500;opacity:.6">Cancel</button>
      </div>`
    : `
      <div class="tabs">
        ${m.sections.map((s, i) => `<button class="tab ${i === state.section ? 'on' : ''}" data-sec="${i}">${esc(s.name)}<i></i></button>`).join('')}
      </div>
      <div class="explainer">
        ${sec?.translation ? `<div class="t">"${esc(sec.translation)}"</div>` : ''}
        ${sec?.note ? `<div class="s">${esc(sec.note)}</div>` : ''}
      </div>`;

  return `<div class="screen paper">
    <div class="menu-head">
      <div class="menu-chrome">
        <button class="circle-btn" id="menu-exit" aria-label="Scan a new menu">${ICON.close()}</button>
        <div class="right">
          <button class="circle-btn ${state.searching ? 'filled' : ''}" id="menu-search" aria-label="Search">
            ${ICON.search(state.searching ? 'var(--paper)' : 'currentColor')}</button>
          <button class="circle-btn" id="menu-settings" aria-label="Settings">${ICON.sliders()}</button>
        </div>
      </div>
      <div class="rest-name">${esc(m.restaurantName)}</div>
    </div>
    ${head}
    <div class="dishes">
      ${dishes.map((d) => dishRow(d)).join('')}
      ${dishes.length === 0 && state.searching
        ? `<div class="empty">Nothing on this menu matches "${esc(state.query)}".</div>` : ''}
      ${!state.searching ? '<div class="footnote">Translations and notes are generated, so double-check anything you are allergic to.</div>' : ''}
    </div>
    ${state.detailId ? viewDetail() : ''}
  </div>`;
}

function dishRow(d) {
  const badge = [d.vegetarian && 'VEG', d.glutenFree && 'GF'].filter(Boolean).join(' · ');
  const p1 = printedPrice(d), p2 = convertedPrice(d);
  const showEn = d.translated && d.translated.toLowerCase() !== d.original.toLowerCase();
  return `<button class="dish" data-dish="${esc(d._id)}">
    <div class="main">
      <div class="name">${esc(d.original)}${badge ? `<span class="badge">${esc(badge)}</span>` : ''}</div>
      ${showEn ? `<div class="en">${esc(d.translated)}</div>` : ''}
      <div class="desc">${esc(d.description)}</div>
    </div>
    ${p1 ? `<div class="price"><div class="p1">${esc(p1)}</div>${p2 ? `<div class="p2">${esc(p2)}</div>` : ''}</div>` : ''}
  </button>`;
}

function viewDetail() {
  const d = state.menu.sections.flatMap((s) => s.items).find((x) => x._id === state.detailId);
  if (!d) return '';
  const sec = state.menu.sections.find((s) => s.items.includes(d));
  const badge = [d.vegetarian && 'VEG', d.glutenFree && 'GF'].filter(Boolean).join(' · ');
  const p1 = printedPrice(d), p2 = convertedPrice(d);
  const showEn = d.translated && d.translated.toLowerCase() !== d.original.toLowerCase();
  const eyebrow = [sec?.name, sec?.translation].filter(Boolean).join(' · ');
  return `<div class="scrim" id="detail-scrim">
    <div class="card">
      <div class="card-body">
        ${eyebrow ? `<div class="eyebrow">${esc(eyebrow)}</div>` : ''}
        <div class="card-title">
          <div class="n">${esc(d.original)}</div>
          ${p1 ? `<div style="text-align:right;flex:none"><div style="font-size:15px;font-weight:500;white-space:nowrap">${esc(p1)}</div>
            ${p2 ? `<div style="font-size:11px;opacity:.45;margin-top:2px">${esc(p2)}</div>` : ''}</div>` : ''}
        </div>
        ${showEn ? `<div class="en">${esc(d.translated)}</div>` : ''}
        ${d.pronunciation ? `<div class="pron">${ICON.speaker('rgba(28,26,23,.5)')}<div class="t">${esc(d.pronunciation)}</div></div>` : ''}
        ${badge ? `<div class="eyebrow" style="margin:10px 0 0;font-size:8.5px;letter-spacing:.22em;opacity:.5">${esc(badge)}</div>` : ''}
        <div class="rule"></div>
        ${d.ingredients ? `<div class="ing">${esc(d.ingredients)}</div>` : ''}
        <div class="desc">${esc(d.description)}</div>
        <div class="foot">Tap anywhere to close</div>
      </div>
    </div>
  </div>`;
}

// ---------- settings ----------

function viewSettings() {
  const keySet = !!Store.get('apiKey', '');
  return `<div class="overlay">
    <button class="circle-btn" id="set-close" style="position:absolute;top:calc(64px + var(--safe-top));left:20px" aria-label="Done">${ICON.close()}</button>
    <div class="overlay-head"><div class="overlay-title">Settings</div></div>
    <div class="overlay-body">
      <div class="group-label">APPEARANCE</div>
      <div class="chips" style="margin-top:12px">
        <button class="chip ${!state.dark ? 'on' : ''}" data-theme-set="light">Light</button>
        <button class="chip ${state.dark ? 'on' : ''}" data-theme-set="dark">Dark</button>
      </div>
      <div class="group-label" style="margin-top:28px">TEXT SIZE</div>
      <div class="chips" style="margin-top:12px">
        ${[['S', 'Small'], ['M', 'Medium'], ['L', 'Large']]
          .map(([k, l]) => `<button class="chip ${state.tsize === k ? 'on' : ''}" data-tsize="${k}">${l}</button>`).join('')}
      </div>
      <div class="group-label" style="margin-top:28px">TRANSLATE MENUS INTO</div>
      <div class="chips" style="margin-top:12px">
        ${LANGUAGES.map((l) => `<button class="chip ${state.language === l ? 'on' : ''}" data-lang="${esc(l)}">${esc(l)}</button>`).join('')}
      </div>
      <div class="group-label" style="margin-top:28px">SHOW PRICES IN</div>
      <div class="chips" style="margin-top:12px">
        ${CURRENCIES.map(([c, s]) => `<button class="chip ${state.currency === c ? 'on' : ''}" data-cur="${c}">${c} ${s}</button>`).join('')}
      </div>
      <div class="group-label" style="margin-top:28px">OPENAI API KEY</div>
      <input class="key-field" id="set-key" type="password" inputmode="text" autocomplete="off"
             autocapitalize="off" autocorrect="off" spellcheck="false"
             placeholder="sk-..." value="${esc(Store.get('apiKey', ''))}">
      <div class="key-status" id="set-key-status">${keySet ? 'A key is saved on this device.' : 'No key saved yet.'}</div>
      <div class="chips" style="margin-top:12px">
        <button class="chip" id="set-key-check">Check key</button>
        <button class="chip" id="set-key-clear">Remove key</button>
      </div>
      <div class="key-note">The key is kept only in this phone's storage and sent only to OpenAI.
        Revoke it any time at platform.openai.com. Roughly 1.5 cents per scan.</div>
      <div style="height:24px"></div>
    </div>
    <div class="overlay-foot"><button class="btn-outline" id="set-done">DONE</button></div>
  </div>`;
}

// ---------- history ----------

function viewHistory() {
  const rows = state.history.length ? state.history.map((m) => {
    const when = new Date(m.savedAt);
    const today = new Date().toDateString() === when.toDateString();
    const meta = `${m.language || 'Menu'} · ${today ? 'Today' : when.toLocaleDateString()}, ` +
      when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const count = m.sections.reduce((n, s) => n + s.items.length, 0);
    return `<div style="display:flex;align-items:center">
      <button class="hist-row" data-open="${esc(m.id)}">
        <div><div class="n">${esc(m.restaurantName)}</div><div class="m">${esc(meta)} · ${count} dishes</div></div>
        <div style="font-size:18px;opacity:.4">›</div>
      </button>
      <button class="hist-del" data-del="${esc(m.id)}" aria-label="Delete">DELETE</button>
    </div>`;
  }).join('') : `<div class="empty" style="padding-top:40px">Nothing scanned yet.</div>`;

  return `<div class="overlay">
    <button class="circle-btn" id="hist-close" style="position:absolute;top:calc(64px + var(--safe-top));left:20px" aria-label="Back">${ICON.close()}</button>
    <div class="overlay-head">
      <div class="overlay-title">Previous scans</div>
      <div class="overlay-sub">Open a menu without scanning it again</div>
    </div>
    <div class="overlay-body">${rows}</div>
    <div class="overlay-foot"><button class="btn-outline" id="hist-done">BACK TO CAMERA</button></div>
  </div>`;
}

function viewConfirm() {
  return `<div class="dialog-scrim">
    <div class="dialog">
      <h3>Discard ${state.pages.length} pages?</h3>
      <p>You'll lose the pages you've captured and return to the camera.</p>
      <div class="row">
        <button class="keep" id="cx-keep">KEEP PAGES</button>
        <button class="go" id="cx-discard">DISCARD</button>
      </div>
    </div>
  </div>`;
}

// --------------------------------------------------------------------------
// Actions
// --------------------------------------------------------------------------

let scanAbort = null;
let scanTimer = null;

function go(screen) { state.screen = screen; render(); }

function addPages(files) {
  for (const f of files) {
    state.pages.push({ blob: f, url: URL.createObjectURL(f) });
  }
  state.reviewIndex = state.pages.length - 1;
  go('review');
}

function discardPages() {
  state.pages.forEach((p) => URL.revokeObjectURL(p.url));
  state.pages = [];
  state.reviewIndex = 0;
  state.overlay = null;
  go('capture');
}

async function startScan() {
  state.scanStep = 0;
  state.scanError = null;
  go('scanning');

  // The step sequence is the waiting room; the request decides the outcome.
  clearInterval(scanTimer);
  scanTimer = setInterval(() => {
    if (state.screen !== 'scanning' || state.scanError) return;
    if (state.scanStep < 6) { state.scanStep++; render(); }
  }, SCAN_STEP_MS);

  scanAbort = new AbortController();
  try {
    const menu = await scanMenu(state.pages.map((p) => p.blob), { signal: scanAbort.signal });
    if (state.screen !== 'scanning') return;
    // Stable ids so a row and its detail card agree after re-render.
    menu.sections.forEach((s, si) => s.items.forEach((it, ii) => { it._id = `${si}-${ii}`; }));
    await History.put(menu);
    state.history = await History.all();
    state.menu = menu;
    state.section = 0;
    state.detailId = null;
    clearInterval(scanTimer);
    discardPagesQuietly();
    go('menu');
  } catch (e) {
    if (e.name === 'AbortError' || state.screen !== 'scanning') return;
    clearInterval(scanTimer);
    state.scanError = e instanceof ScanError ? e.message : 'Something went wrong. Try again.';
    render();
  }
}

function discardPagesQuietly() {
  state.pages.forEach((p) => URL.revokeObjectURL(p.url));
  state.pages = [];
  state.reviewIndex = 0;
}

function cancelScan() {
  clearInterval(scanTimer);
  scanAbort?.abort();
  state.scanStep = 0;
  state.scanError = null;
  go(state.pages.length ? 'review' : 'capture');
}

async function openSettings() { state.overlay = 'settings'; render(); }
async function openHistory() {
  state.history = await History.all();
  state.overlay = 'history';
  render();
}

// --------------------------------------------------------------------------
// Wiring
// --------------------------------------------------------------------------

function on(sel, ev, fn) { const el = $(sel); if (el) el.addEventListener(ev, fn); }

function wire() {
  // chips shared by onboarding and settings
  $$('[data-lang]').forEach((b) => b.onclick = () => {
    state.language = b.dataset.lang; Store.set('language', state.language); render();
  });
  $$('[data-cur]').forEach((b) => b.onclick = () => {
    state.currency = b.dataset.cur; Store.set('currency', state.currency); render();
  });
  $$('[data-theme-set]').forEach((b) => b.onclick = () => {
    state.dark = b.dataset.themeSet === 'dark'; Store.set('dark', state.dark); render();
  });
  $$('[data-tsize]').forEach((b) => b.onclick = () => {
    state.tsize = b.dataset.tsize; Store.set('tsize', state.tsize); render();
  });

  if (state.screen === 'onboard') wireOnboard();
  if (state.screen === 'capture') wireCamera();
  if (state.screen === 'review') wireReview();
  if (state.screen === 'scanning') wireScanning();
  if (state.screen === 'menu') wireMenu();
  if (state.overlay === 'settings') wireSettings();
  if (state.overlay === 'history') wireHistory();
  if (state.overlay === 'confirm') {
    on('#cx-keep', 'click', () => { state.overlay = null; render(); });
    on('#cx-discard', 'click', discardPages);
  }
}

function wireOnboard() {
  const key = $('#ob-key');
  if (key) key.addEventListener('change', () => Store.set('apiKey', key.value.trim()));
  on('#ob-next', 'click', () => {
    if (state.obStep < 2) { state.obStep++; render(); return; }
    const value = key ? key.value.trim() : Store.get('apiKey', '');
    Store.set('apiKey', value);
    if (!value) {
      $('#ob-key-status').textContent = 'Add a key first, or scanning will not work.';
      $('#ob-key-status').className = 'key-status bad';
      return;
    }
    Store.set('onboarded', true);
    go('capture');
  });
}

function wireCamera() {
  const video = $('#cam-video');
  let live = false;
  Camera.start(video).then((ok) => {
    live = ok;
    if (!ok) video.classList.add('hidden');
    // Hide the flash control when the hardware or browser will not do torch.
    if (!ok || !Camera.hasTorch) $('#cam-flash')?.classList.add('hidden');
  });

  on('#cam-flash', 'click', async () => {
    state.flash = !state.flash;
    const applied = await Camera.setTorch(state.flash);
    if (!applied) state.flash = false;
    render();
  });
  on('#cam-settings', 'click', openSettings);
  on('#cam-history', 'click', openHistory);
  on('#cam-upload', 'click', async () => {
    const files = await pickImages({ multiple: true });
    if (files.length) { Camera.stop(); addPages(files); }
  });
  on('#cam-shoot', 'click', async () => {
    const blob = live ? await Camera.capture() : null;
    if (blob) { Camera.stop(); addPages([blob]); return; }
    // No live feed: hand off to the native camera instead.
    const files = await pickImages({ camera: true });
    if (files.length) { Camera.stop(); addPages(files); }
  });
}

function wireReview() {
  const strip = $('#pages');
  if (strip) {
    strip.scrollLeft = strip.clientWidth * state.reviewIndex;
    let t;
    strip.addEventListener('scroll', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const i = Math.round(strip.scrollLeft / strip.clientWidth);
        if (i !== state.reviewIndex) { state.reviewIndex = i; render(); }
      }, 90);
    });
  }
  on('#rev-exit', 'click', () => {
    if (state.pages.length > 1) { state.overlay = 'confirm'; render(); }
    else discardPages();
  });
  on('#rev-retake', 'click', () => {
    const [gone] = state.pages.splice(state.reviewIndex, 1);
    if (gone) URL.revokeObjectURL(gone.url);
    state.reviewIndex = 0;
    go(state.pages.length ? 'review' : 'capture');
  });
  on('#rev-add', 'click', () => go('capture'));
  on('#rev-go', 'click', startScan);
}

function wireScanning() {
  on('#scan-cancel', 'click', cancelScan);
  on('#scan-back', 'click', cancelScan);
  on('#scan-retry', 'click', startScan);
}

function wireMenu() {
  on('#menu-exit', 'click', () => { state.searching = false; state.query = ''; go('capture'); });
  on('#menu-settings', 'click', openSettings);
  on('#menu-search', 'click', () => {
    state.searching = !state.searching; state.query = ''; render();
    $('#q')?.focus();
  });
  on('#q-cancel', 'click', () => { state.searching = false; state.query = ''; render(); });
  const q = $('#q');
  if (q) {
    q.addEventListener('input', () => {
      state.query = q.value;
      // Repaint only the list so the field keeps focus and the caret.
      const list = $('.dishes');
      const dishes = visibleDishes();
      list.innerHTML = dishes.map((d) => dishRow(d)).join('') ||
        `<div class="empty">Nothing on this menu matches "${esc(state.query)}".</div>`;
      bindDishRows();
    });
    q.focus();
  }
  $$('[data-sec]').forEach((b) => b.onclick = () => {
    state.section = Number(b.dataset.sec); state.detailId = null; render();
  });
  bindDishRows();
  on('#detail-scrim', 'click', () => {
    state.detailId = null; Store.set('pronSeen', true); render();
  });
}

function bindDishRows() {
  $$('[data-dish]').forEach((b) => b.onclick = () => { state.detailId = b.dataset.dish; render(); });
}

function wireSettings() {
  const field = $('#set-key');
  const status = $('#set-key-status');
  const save = () => Store.set('apiKey', field.value.trim());
  field?.addEventListener('change', save);

  on('#set-key-check', 'click', async () => {
    save();
    const value = field.value.trim();
    if (!value) { status.textContent = 'No key saved yet.'; status.className = 'key-status'; return; }
    status.innerHTML = '<span class="spinner"></span> Checking…';
    status.className = 'key-status';
    const r = await verifyKey(value);
    status.textContent = r.ok ? 'Key works.' : r.msg;
    status.className = 'key-status ' + (r.ok ? 'ok' : 'bad');
  });
  on('#set-key-clear', 'click', () => {
    Store.del('apiKey');
    field.value = '';
    status.textContent = 'Key removed from this device.';
    status.className = 'key-status';
  });
  const close = () => { save(); state.overlay = null; render(); };
  on('#set-close', 'click', close);
  on('#set-done', 'click', close);
}

function wireHistory() {
  const close = () => { state.overlay = null; render(); };
  on('#hist-close', 'click', close);
  on('#hist-done', 'click', close);
  $$('[data-open]').forEach((b) => b.onclick = () => {
    const m = state.history.find((x) => x.id === b.dataset.open);
    if (!m) return;
    m.sections.forEach((s, si) => s.items.forEach((it, ii) => { it._id = `${si}-${ii}`; }));
    state.menu = m; state.section = 0; state.detailId = null; state.overlay = null;
    go('menu');
  });
  $$('[data-del]').forEach((b) => b.onclick = async () => {
    await History.remove(b.dataset.del);
    state.history = await History.all();
    render();
  });
}

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------

(async function boot() {
  state.history = await History.all();

  // Opt-in debug handle for driving the app in a browser without a camera:
  // append ?debug=1. Exposes app state only, never the stored key.
  if (new URLSearchParams(location.search).has('debug')) {
    window.DG = { state, render, addPages, startScan, cancelScan, openSettings, openHistory,
                  sanitize, History, go };
  }

  render();
})();

// Registered at module scope, not inside boot(): boot awaits IndexedDB first,
// by which time the load event has already fired and a listener added then would
// never run. Errors surface in the console rather than being swallowed.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((e) => {
    console.warn('Service worker registration failed; the app will not work offline.', e);
  });
}
