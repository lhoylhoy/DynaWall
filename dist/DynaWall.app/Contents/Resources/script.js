/**
 * DynaWall — a minimalist, time-aware live wallpaper.
 *
 * Zero dependencies. Runs in a browser, Lively Wallpaper and Wallpaper Engine.
 *
 * Configuration priority (highest wins):
 *   1. Lively / Wallpaper Engine IPC  (livelyPropertyListener / wallpaperPropertyListener)
 *   2. Host seed at document start    (window.__dynawallSeed, written by the macOS app)
 *   3. URL query parameters           (?name=Alex&slideshow=true&photos=a.jpg,b.jpg)
 *   4. localStorage cache             (dynawall.firstName, dynawall.slideshow, ...)
 *   5. Built-in defaults              (firstName: "Developer", slideshow: false)
 *
 * A host control cleared to `''` is a reset, not silence: an empty `firstName`
 * from live IPC resolves to `DEFAULT_CONFIG.firstName`, so deleting the name
 * character by character clears the desktop instead of leaving the last letter
 * stuck. Empty URL parameters, cache entries and seeds stay "said nothing", since
 * they are re-read on every load and cannot express a live edit.
 *
 * The seed is the host's own snapshot of its settings, injected as a `WKUserScript`
 * at `.atDocumentStart`: the first paint is already the user's wallpaper instead of
 * the built-in copy, so there is nothing to cross-fade (and nothing to flash) while
 * the window fades in. Live IPC still outranks it, exactly like every other host.
 *
 * Photo sources follow the same rule, except `photos` is never cached: a host
 * (the macOS app) hands the page its resolved folder list on every load, and an
 * empty list from that host is a real answer — no folder, no supported images —
 * so the desktop stays solid black instead of showing pictures the user did not
 * choose. Hosts that do not manage the list keep the bundled wallpapers.
 *
 * Typography: the greeting and subtitle are set in the bundled Outfit face
 * (`@font-face` in style.css) unless a host, the URL ('?font=Charter') or the
 * cache names another family. A family installed on the machine is used as-is;
 * an imported font file travels from the native host as a `data:` URL and is
 * registered with `document.fonts`, so no download and no network are involved.
 * Every stack keeps Outfit behind the chosen family, so a font that disappears
 * falls back to the shipped look instead of a blank greeting.
 *
 * Time-synced photos: with `photoSync` on (the default) the slideshow only
 * rotates through photos whose filename names the band active right now —
 * dawn/day/dusk/night, or the palette pinned in the host — so the picture on the
 * desktop matches the light outside. Crossing a band edge (clock or popover)
 * restarts the rotation on the new band's photos and cross-fades to them. The
 * automatic timer stays inside that band even when it holds a single picture;
 * `nextPhoto` (the menu bar button, a host action) may cross into the rest of the
 * library so an on-demand skip is never a dead button.
 *
 * Time awareness: the greeting period (morning/afternoon/evening) and the palette
 * (dawn/day/dusk/night) are both read from the same clock. Nothing can change
 * between the six hours the page cares about (05 / 09 / 12 / 17 / 18 / 21), so
 * instead of polling every 30 s the page arms one one-shot timer for the exact next
 * boundary — six wakeups a day instead of 2,880 — and re-checks on wake and focus.
 * `theme` pins a single palette instead of following the clock, and a background
 * colour set by hand pins `custom` — unless the same source names a theme.
 *
 * Suspension: `setSuspended(true)` — from `livelyPropertyListener('suspend', …)`,
 * `DynaWall.setSuspended(...)` or `document.visibilitychange` — parks the clock and
 * slideshow timers and puts `html.is-suspended` on the document, which pauses the
 * Ken Burns drift in CSS. An occluded desktop, a sleeping display and a locked
 * session therefore all settle at 0 FPS and zero timer wakeups.
 */
(function (global) {
  'use strict';

  /* ----------------------------------------------------------------------- *
   * Defaults & constants
   * ------------------------------------------------------------------------ */

  const DEFAULT_CONFIG = Object.freeze({
    firstName: 'Developer',
    subtitle: 'What are we building today?',
    bgColor: '#0d1117',
    // Palette. `auto` walks the clock through dawn → day → dusk → night; any
    // other band pins it, and `custom` uses bgColor as-is.
    theme: 'auto',
    // Photo slideshow — off by default, so the wallpaper stays minimal until asked.
    slideshow: false,
    slideshowInterval: 15, // minutes between photos
    slideshowShuffle: true,
    kenBurns: true,
    // Only show photos whose filename matches the active time-of-day band.
    photoSync: true,
    // Sources injected by the macOS host (absolute scheme URLs). Empty means the
    // host has no photos; hosts that do not own the list keep the bundled fallback.
    photos: [],
    // Typography. `Outfit` is vendored with the wallpaper (see style.css), so the
    // default never depends on what the machine happens to have installed. Any
    // family installed in macOS Font Book / Windows Fonts replaces it, and
    // `customFont` carries an imported font file the host read from disk.
    fontFamily: 'Outfit',
    customFont: ''
  });

  const STORAGE_KEYS = Object.freeze({
    firstName: 'dynawall.firstName',
    subtitle: 'dynawall.subtitle',
    bgColor: 'dynawall.bgColor',
    theme: 'dynawall.theme',
    slideshow: 'dynawall.slideshow',
    slideshowInterval: 'dynawall.slideshowInterval',
    slideshowShuffle: 'dynawall.slideshowShuffle',
    kenBurns: 'dynawall.kenBurns',
    photoSync: 'dynawall.photoSync',
    fontFamily: 'dynawall.fontFamily',
    // Widget state, cached locally because it is the user's choice and not a host
    // setting: the city they looked up and whether they read the card in °C or °F.
    weatherPlace: 'dynawall.weatherPlace',
    weatherUnit: 'dynawall.weatherUnit'
    // `photos` and `customFont` are deliberately not cached: the host re-sends them
    // on every load (the font file as a data URL read from the imported copy).
  });

  /**
   * The curated Golden Gate scene: one 5K JPEG per time of day, in the order the
   * clock walks through them. The `images/` folder also holds 4K, HEIC and plain
   * Light/Dark duplicates of the same six pictures, which is exactly why the
   * collection is a fixed list rather than "every JPEG in the folder".
   */
  const GOLDEN_GATE_PHOTOS = Object.freeze([
    'images/iClarified-macOS-27-Golden-Gate-Wallpaper-5K-Light.jpg',
    'images/iClarified-macOS-27-Golden-Gate-Day-Wallpaper.jpg',
    'images/iClarified-macOS-27-Golden-Gate-Sunset-Wallpaper.jpg',
    'images/iClarified-macOS-27-Golden-Gate-Evening-Wallpaper.jpg',
    'images/iClarified-macOS-27-Golden-Gate-Night-Wallpaper.jpg',
    'images/iClarified-macOS-27-Golden-Gate-Wallpaper-5K-Dark.jpg'
  ]);

  /** The six generated abstract wallpapers; their names carry the band too. */
  const ABSTRACT_PHOTOS = Object.freeze([
    'images/01-neon-dusk.jpg',
    'images/02-solar-flare.jpg',
    'images/03-deep-ocean.jpg',
    'images/04-mint-fog.jpg',
    'images/05-candy-sky.jpg',
    'images/06-graphite.jpg'
  ]);

  /**
   * The photos that ship with the wallpaper.
   *
   * They stay in the bundle for the installer, the README previews and the host
   * manifests. The page falls back to them only when no host claims the photo
   * list (Lively, Wallpaper Engine's bundled mode, a plain browser); the macOS
   * host always seeds `photos`, so an empty list there means solid black.
   */
  const BUNDLED_PHOTOS = Object.freeze(GOLDEN_GATE_PHOTOS.concat(ABSTRACT_PHOTOS));

  /** Slideshow bounds, in minutes. */
  const INTERVAL_MIN_MINUTES = 1;
  const INTERVAL_MAX_MINUTES = 24 * 60;
  /** Keep in sync with --photo-fade-duration in style.css. */
  const PHOTO_FADE_MS = 1200;
  const MAX_PHOTOS = 500;

  /**
   * Every accepted `theme` value, in the order the host dropdowns list them.
   * Lively sends the *index* of a dropdown item, so this order is also the
   * contract with `items` in LivelyProperties.json.
   */
  const THEME_MODES = Object.freeze(['auto', 'dawn', 'day', 'dusk', 'night', 'custom']);
  /** The clock-driven bands, in the order a day passes through them. */
  const THEMES = Object.freeze(['dawn', 'day', 'dusk', 'night']);

  /* ----------------------------------------------------------------------- *
   * Typography
   * ------------------------------------------------------------------------ */

  /** The face vendored in assets/fonts; every font stack falls back to it. */
  const DEFAULT_FONT_FAMILY = 'Outfit';

  /**
   * The families that ship with the wallpaper (one @font-face each in style.css,
   * plus static TTFs for the native preview cards). They are the presets every
   * host offers; anything else is a system font or an imported file, which is why
   * this list — not "whatever is installed" — is what the UI calls bundled.
   * Keep in sync with WallpaperFont.bundledFamilies (macOS) and
   * Preferences.BundledFontFamilies (Windows); tests/verify.cjs asserts the three agree.
   */
  const BUNDLED_FONT_FAMILIES = Object.freeze([
    'Outfit',
    'Google Sans Flex',
    'Space Grotesk',
    'Geist'
  ]);

  /**
   * The tail of every font stack: the vendored Outfit face, then the geometric
   * faces macOS and Windows ship, then the system UI face.
   *
   * A chosen family is prepended (`"Charter", <tail>`), so a font that was
   * uninstalled, renamed or deleted can never leave the greeting blank — it lands
   * back on the bundled Outfit, which needs no install and no network.
   */
  const FONT_STACK_TAIL =
    '"Outfit", "Avenir Next", "Century Gothic", "Futura", -apple-system, ' +
    'BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

  /**
   * The "SF Pro" preset is the macOS system face rather than a family anyone
   * installs, so its stack asks the platform for the UI font by name instead of
   * quoting a family that may not exist.
   */
  const SYSTEM_SANS_STACK =
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, ' +
    '"Helvetica Neue", Arial, sans-serif';

  /** A family longer than this is a paste accident, not a font name. */
  const MAX_FONT_FAMILY_LENGTH = 80;
  /** An imported font travels as base64; one wallpaper must stay well under 10 MB. */
  const MAX_FONT_SOURCE_LENGTH = 6 * 1024 * 1024;
  /**
   * Background colour per band. Mirrors the `--bg-primary` token of each
   * `[data-theme]` block in style.css and `ThemeSlot.hex` in the macOS host.
   * `applyTheme()` reads this instead of `getComputedStyle(<html>)`, which forced a
   * synchronous style recalculation every time the palette moved.
   */
  const THEME_BG_HEX = Object.freeze({
    dawn: '#121020',
    day: '#0d1117',
    dusk: '#180f0e',
    night: '#070a11'
  });
  /** Shorthands people type in a URL; all mean "follow the clock". */
  const THEME_ALIASES = Object.freeze({ time: 'auto', clock: 'auto', dynamic: 'auto' });

  /**
   * Filename tokens per time-of-day band. Matching is a plain substring test on
   * the lowercased basename, so `...-Golden-Gate-Day-Wallpaper.jpg` lands in
   * `day` and `04-mint-fog.jpg` in `dawn`. `golden-gate` deliberately matches
   * nothing, which is what keeps the six variants of one scene apart.
   */
  const PHOTO_BAND_KEYWORDS = Object.freeze({
    dawn: Object.freeze(['dawn', 'sunrise', 'morning', 'mint-fog', 'candy-sky']),
    day: Object.freeze([
      'day',
      'daylight',
      'noon',
      'midday',
      'solar-flare',
      'deep-ocean',
      'wallpaper-4k'
    ]),
    dusk: Object.freeze(['dusk', 'sunset', 'evening', 'twilight', 'neon-dusk']),
    night: Object.freeze(['night', 'midnight', 'dark', 'graphite'])
  });

  /**
   * macOS's Light/Dark pair names no hour: the light wallpaper is the dawn one
   * when the same set also has a real `day` photo, and the daytime one when it
   * does not (a lone `-Light.jpg` would otherwise never be shown between 09:00
   * and 17:00).
   */
  const LIGHT_PHOTO_KEYWORD = 'light';

  /** Where a band looks when the library simply has nothing for it. */
  const BAND_FALLBACKS = Object.freeze({
    dawn: Object.freeze(['day', 'night', 'dusk']),
    day: Object.freeze(['dawn', 'dusk', 'night']),
    dusk: Object.freeze(['day', 'night', 'dawn']),
    night: Object.freeze(['dusk', 'dawn', 'day'])
  });

  /**
   * The historical polling cadence, still exported (and asserted by the tests) as
   * the documented cadence of the clock. Scheduling is exact now — one one-shot
   * timer per boundary — so this value is only the fallback used when a boundary
   * cannot be computed; it is deliberately not a repeating interval any more.
   */
  const CLOCK_REFRESH_MS = 30 * 1000;
  /**
   * Every local hour at which something the clock owns changes: 05:00 and 21:00
   * move the palette, 12:00 and 18:00 move the greeting, and 09:00/17:00 move both.
   * Keep in sync with `getThemeSlot()` / `getGreetingPeriod()` below.
   */
  const CLOCK_BOUNDARY_HOURS = Object.freeze([5, 9, 12, 17, 18, 21]);
  /** Ignore the focus event that arrives with the initial page load. */
  const FOCUS_GRACE_MS = 5000;
  /** Keep in sync with --text-fade-duration in style.css. */
  const TEXT_FADE_MS = 320;

  /* ----------------------------------------------------------------------- *
   * Time helpers
   * ------------------------------------------------------------------------ */

  /**
   * Resolve the greeting period for a date.
   * 05:00–11:59 morning · 12:00–17:59 afternoon · 18:00–04:59 evening
   */
  function getGreetingPeriod(date) {
    const hours = date.getHours();
    if (hours >= 5 && hours < 12) return 'morning';
    if (hours >= 12 && hours < 18) return 'afternoon';
    return 'evening';
  }

  function buildGreeting(firstName, period) {
    return `Good ${period}, ${firstName}.`;
  }

  /**
   * Resolve the palette band for a date.
   * 05:00–08:59 dawn · 09:00–16:59 day · 17:00–20:59 dusk · 21:00–04:59 night
   *
   * Deliberately finer than the greeting periods: light changes at 09:00 and
   * 21:00, when "morning"/"evening" would still be saying the same thing. Keep
   * these hours in sync with the [data-theme] blocks in style.css and with
   * ThemeSlot in macos/DynaWallApp.swift.
   */
  function getThemeSlot(date) {
    const hours = date.getHours();
    if (hours >= 5 && hours < 9) return 'dawn';
    if (hours >= 9 && hours < 17) return 'day';
    if (hours >= 17 && hours < 21) return 'dusk';
    return 'night';
  }

  /**
   * Milliseconds from `date` (default: now) to the next clock boundary.
   *
   * The greeting and the palette can only change at the six hours in
   * CLOCK_BOUNDARY_HOURS, so this is the exact sleep a one-shot timer needs —
   * between 05:00 and 09:00 there is nothing to poll for. `date` is an argument
   * (rather than an implicit `new Date()`) so the boundary maths is testable
   * without freezing the clock.
   *
   * Boundaries are built from local date components, never by adding milliseconds,
   * so a DST switch resolves through `Date` instead of drifting the timer by an
   * hour. A boundary that is exactly now counts as gone: the state it produces is
   * already applied, so the timer targets the following one.
   */
  function msUntilNextClockBoundary(date) {
    const now = date instanceof Date ? date : new Date();
    const current = now.getTime();
    const year = now.getFullYear();
    const month = now.getMonth();
    const day = now.getDate();
    let wait = Infinity;

    for (let index = 0; index < CLOCK_BOUNDARY_HOURS.length; index += 1) {
      const hours = CLOCK_BOUNDARY_HOURS[index];
      let target = new Date(year, month, day, hours, 0, 0, 0).getTime();
      if (target <= current) {
        target = new Date(year, month, day + 1, hours, 0, 0, 0).getTime();
      }
      if (target - current < wait) wait = target - current;
    }

    // Defensive: a host with a broken Date must still refresh eventually.
    return Number.isFinite(wait) && wait > 0 ? wait : CLOCK_REFRESH_MS;
  }

  /* ----------------------------------------------------------------------- *
   * Value normalisation
   * ------------------------------------------------------------------------ */

  /** Trim, collapse whitespace, drop trailing punctuation, keep the first name. */
  function normalizeName(value) {
    if (typeof value !== 'string') return undefined;
    const cleaned = value
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[.,!;:]+$/, '');
    if (!cleaned) return undefined;
    return cleaned.split(' ')[0];
  }

  /** true/false/1/0/yes/no/on/off → boolean; anything else → undefined. */
  function parseBoolean(value) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value !== 0;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
      if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    }
    return undefined;
  }

  function clampChannel(channel) {
    return Math.min(255, Math.max(0, Math.round(channel)));
  }

  function toHex(red, green, blue) {
    return `#${[red, green, blue]
      .map((channel) => clampChannel(channel).toString(16).padStart(2, '0'))
      .join('')}`;
  }

  /**
   * Accepts "#0d1117", "0d1117", "rgb(13, 17, 23)" and the "0.05 0.07 0.09"
   * float triplet that Lively Wallpaper and Wallpaper Engine hand to JS.
   */
  function normalizeColor(value) {
    if (typeof value !== 'string') return undefined;
    const raw = value.trim();
    if (!raw) return undefined;

    const hex = raw.replace(/^#/, '');
    if (/^[0-9a-f]{6}$/i.test(hex)) return `#${hex.toLowerCase()}`;
    if (/^[0-9a-f]{3}$/i.test(hex)) {
      return `#${hex
        .toLowerCase()
        .split('')
        .map((digit) => digit + digit)
        .join('')}`;
    }

    const rgbMatch = raw.match(/^rgba?\(([^)]+)\)$/i);
    const body = rgbMatch ? rgbMatch[1] : raw;
    const channels = body
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (channels.length < 3 || channels.slice(0, 3).some((n) => !Number.isFinite(n))) {
      return undefined;
    }

    const rgb = channels.slice(0, 3);
    const isUnitScale = rgb.every((channel) => channel >= 0 && channel <= 1);
    return toHex(...rgb.map((channel) => (isUnitScale ? channel * 255 : channel)));
  }

  /**
   * Palettes accept a band name, a "follow the clock" synonym, or the index of a
   * dropdown item — Lively hands the page the index, not the label.
   */
  function normalizeTheme(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      const index = Math.round(value);
      return index >= 0 && index < THEME_MODES.length ? THEME_MODES[index] : undefined;
    }
    if (typeof value !== 'string') return undefined;
    const key = value.trim().toLowerCase();
    if (!key) return undefined;
    if (ownLookup(THEME_ALIASES, key)) return THEME_ALIASES[key];
    return THEME_MODES.indexOf(key) === -1 ? undefined : key;
  }

  /** Slide interval in whole minutes, clamped to [1, 1440]. */
  function normalizeSlideshowInterval(value) {
    let minutes;
    if (typeof value === 'number') {
      minutes = value;
    } else if (typeof value === 'string' && value.trim() !== '') {
      minutes = Number(value.trim()); // Wallpaper Engine hands over strings
    } else {
      return undefined;
    }
    if (!Number.isFinite(minutes)) return undefined;
    return Math.min(INTERVAL_MAX_MINUTES, Math.max(INTERVAL_MIN_MINUTES, Math.round(minutes)));
  }

  /**
   * A font family name, safe to interpolate into a `font-family` declaration.
   *
   * The family is always quoted when the stack is built, so spaces and CJK names
   * are fine; quotes, backslashes, braces and semicolons are dropped because they
   * are the only characters that could break out of that quote and rewrite the
   * rest of the stylesheet. An empty value means "this source said nothing", which
   * lets a live empty control reset the family to Outfit (see
   * `resolveIpcFieldValue`).
   */
  function normalizeFontFamily(value) {
    if (typeof value !== 'string') return undefined;
    const cleaned = value
      .replace(/[\u0000-\u001f\u007f]/g, ' ') // control characters
      .replace(/["'\\;{}<>]/g, '') // style injection / declaration breakers
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) return undefined;
    if (cleaned.length > MAX_FONT_FAMILY_LENGTH) return undefined;
    return cleaned;
  }

  /**
   * An imported font file the host read from disk.
   *
   * Only `data:` URLs carrying a font (or a generic binary) payload and plain
   * relative paths are accepted: the wallpaper must never fetch anything from the
   * network, and `javascript:`/`file:` URLs are not fonts. An empty string is a
   * real value — it removes the previously loaded face.
   */
  function normalizeCustomFont(value) {
    if (typeof value !== 'string') return undefined;
    const source = value.trim();
    if (!source) return '';
    if (source.length > MAX_FONT_SOURCE_LENGTH) return undefined;
    if (/[\s"'\\]/.test(source)) return undefined; // data URLs and paths are one token
    if (/^javascript:/i.test(source)) return undefined;

    if (/^data:/i.test(source)) {
      const header = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+)((?:;[a-z0-9=.+-]+)*);base64,/i.exec(source);
      if (!header) return undefined;
      const mime = header[1].toLowerCase();
      const isFont =
        mime.indexOf('font/') === 0 ||
        mime.indexOf('application/font-') === 0 ||
        mime.indexOf('application/x-font') === 0 ||
        mime === 'application/octet-stream';
      return isFont ? source : undefined;
    }

    // Anything with a scheme (http:, file:, blob:, //host) would leave the
    // wallpaper's own folder; a relative path is the only other sane source.
    if (/^[a-z][a-z0-9+.-]*:/i.test(source) || source.indexOf('//') === 0) return undefined;
    return source;
  }

  /**
   * The full `font-family` value for a configured family.
   *
   * Outfit (and an empty setting) resolves to the exact stack style.css declares,
   * so the shipped look is byte-identical whether or not the runtime rewrites the
   * token. A named family is quoted ahead of that same tail — including one the
   * tail already lists (Avenir Next, Segoe UI), because the family the user picked
   * has to win over the shipped fallback order.
   */
  function fontStack(family) {
    const name = typeof family === 'string' ? family.trim() : '';
    const key = name.toLowerCase();
    if (!name || key === DEFAULT_FONT_FAMILY.toLowerCase()) {
      return FONT_STACK_TAIL;
    }
    if (key === 'sf pro' || key === 'system sans' || key === 'system-ui') {
      return SYSTEM_SANS_STACK;
    }
    const safe = name.replace(/["'\\;{}<>]/g, '').replace(/\s+/g, ' ').trim();
    return safe ? `"${safe}", ${FONT_STACK_TAIL}` : FONT_STACK_TAIL;
  }

  /**
   * Photo sources: an array (macOS host), a JSON array string, or a comma
   * separated list (handy in the URL). Blank entries, anything containing
   * whitespace and `javascript:` URLs are dropped; duplicates are collapsed.
   */
  function normalizePhotos(value) {
    let raw = value;

    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (!trimmed) return [];
      if (trimmed.charAt(0) === '[') {
        try {
          raw = JSON.parse(trimmed);
        } catch (error) {
          return undefined;
        }
      } else {
        raw = trimmed.split(',');
      }
    }

    if (!Array.isArray(raw)) return undefined;

    // A Set keeps the de-duplication at O(N); scanning the output with
    // `indexOf()` for every entry made a long folder O(N²) on every host push.
    const photos = [];
    const seen = new Set();
    for (let index = 0; index < raw.length; index += 1) {
      const entry = raw[index];
      if (typeof entry !== 'string') continue;
      const url = entry.trim();
      if (!url || /\s/.test(url) || /^javascript:/i.test(url)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      photos.push(url);
      if (photos.length >= MAX_PHOTOS) break;
    }

    return photos;
  }

  /* ----------------------------------------------------------------------- *
   * Photo classification (time-of-day bands)
   * ------------------------------------------------------------------------ */

  /**
   * Last path segment of a photo source, lowercased. Handles a relative path
   * (`images/04-mint-fog.jpg`) and a host scheme URL
   * (`dynawall-photo://photo/2/iClarified-…-Night-Wallpaper.jpg`), which is what
   * lets bundled and user-selected folders be classified the same way.
   */
  function photoBasename(source) {
    if (typeof source !== 'string' || source === '') return '';
    const withoutQuery = source.split(/[?#]/)[0];
    const segments = withoutQuery.split('/');
    let name = segments[segments.length - 1] || '';
    try {
      name = decodeURIComponent(name);
    } catch (error) {
      /* A malformed escape is not worth a crash; classify the raw segment. */
    }
    return name.trim().toLowerCase();
  }

  /** Bands named by a filename, in THEMES order (that order breaks ties). */
  function photoBandsInName(name) {
    if (!name) return [];
    return THEMES.filter((band) =>
      PHOTO_BAND_KEYWORDS[band].some((token) => name.indexOf(token) !== -1)
    );
  }

  /** An empty four-band bucket set. */
  function emptyBuckets() {
    const buckets = {};
    THEMES.forEach((band) => {
      buckets[band] = [];
    });
    return buckets;
  }

  /** Bucket sets are handed out as copies, so a caller can never poison the cache. */
  function cloneBuckets(buckets) {
    const copy = {};
    THEMES.forEach((band) => {
      copy[band] = buckets[band].slice();
    });
    return copy;
  }

  /**
   * Last photo list seen, keyed by array reference, plus a cheap guard for a list
   * that was edited in place. `activePhotoSources()` classifies on every render
   * *and* on every slideshow signature check, so re-parsing (substring matching
   * and `decodeURIComponent` for each URL) several times per render is pure waste.
   */
  const classifyCache = new WeakMap();

  function photoListGuard(photos) {
    const first = typeof photos[0] === 'string' ? photos[0] : '';
    const last = typeof photos[photos.length - 1] === 'string' ? photos[photos.length - 1] : '';
    return `${photos.length}\u0000${first}\u0000${last}`;
  }

  /**
   * Bucket a photo list into the four bands, keeping library order.
   *
   * Filenames that name several bands (`neon-dusk`) take the first one in THEMES
   * order; `light` is resolved against the rest of the set (see
   * LIGHT_PHOTO_KEYWORD). Photos with no recognisable token at all are dealt out
   * across the four bands round-robin, so an untagged folder still gives every
   * hour a wallpaper instead of an empty screen.
   */
  function classifyPhotos(photos) {
    if (!Array.isArray(photos)) return emptyBuckets();

    const guard = photoListGuard(photos);
    const cached = classifyCache.get(photos);
    if (cached && cached.guard === guard) return cloneBuckets(cached.buckets);

    const buckets = emptyBuckets();
    const list = photos.filter((photo) => typeof photo === 'string' && photo !== '');
    const hasDayPhoto = list.some(
      (photo) => photoBandsInName(photoBasename(photo)).indexOf('day') !== -1
    );
    let untagged = 0;

    list.forEach((photo) => {
      const name = photoBasename(photo);
      const bands = photoBandsInName(name);
      if (bands.length > 0) {
        buckets[bands[0]].push(photo);
        return;
      }
      if (name.indexOf(LIGHT_PHOTO_KEYWORD) !== -1) {
        buckets[hasDayPhoto ? 'dawn' : 'day'].push(photo);
        return;
      }
      buckets[THEMES[untagged % THEMES.length]].push(photo);
      untagged += 1;
    });

    classifyCache.set(photos, { guard: guard, buckets: buckets });
    return cloneBuckets(buckets);
  }

  /**
   * Which band's photos belong on screen: a pinned palette (`dawn`…`night`) or,
   * for `auto`/`custom`, whatever band the clock is in.
   */
  function resolvePhotoBand(theme, date) {
    return THEMES.indexOf(theme) === -1 ? getThemeSlot(date) : theme;
  }

  /**
   * The photos for one band. A band the library has nothing for falls back to
   * the nearest adjacent band (night → dusk → dawn → day, and so on) rather than
   * leaving the desktop bare; an unknown slot means "no filtering at all".
   */
  function getPhotosForSlot(photos, slot) {
    if (THEMES.indexOf(slot) === -1) return Array.isArray(photos) ? photos.slice() : [];

    const buckets = classifyPhotos(photos);
    if (buckets[slot].length > 0) return buckets[slot];

    const fallbacks = BAND_FALLBACKS[slot];
    for (let index = 0; index < fallbacks.length; index += 1) {
      if (buckets[fallbacks[index]].length > 0) return buckets[fallbacks[index]];
    }
    return [];
  }

  /**
   * Index of the next photo in a pool of `count`. Sequential order steps forward
   * and wraps; shuffle never repeats `current`. `current` of -1 means "nothing on
   * screen yet" and starts the pool from its first photo.
   */
  function stepPhotoIndex(count, current, shuffle, random) {
    if (!(count > 0)) return -1;
    if (count === 1) return 0;
    const pick = typeof random === 'function' ? random : Math.random;
    if (shuffle) {
      let index = current;
      while (index === current) index = Math.floor(pick() * count);
      return Math.min(count - 1, Math.max(0, index));
    }
    return current < 0 || current >= count ? 0 : (current + 1) % count;
  }

  function normalizeFieldValue(field, rawValue) {
    switch (field) {
      case 'firstName':
        return normalizeName(rawValue);
      case 'subtitle':
        if (typeof rawValue !== 'string') return undefined;
        return rawValue.trim(); // an empty string intentionally hides the subtitle
      case 'slideshow':
      case 'slideshowShuffle':
      case 'kenBurns':
      case 'photoSync':
        return parseBoolean(rawValue);
      case 'bgColor':
        return normalizeColor(rawValue);
      case 'theme':
        return normalizeTheme(rawValue);
      case 'slideshowInterval':
        return normalizeSlideshowInterval(rawValue);
      case 'photos':
        return normalizePhotos(rawValue);
      case 'fontFamily':
        return normalizeFontFamily(rawValue);
      case 'customFont':
        return normalizeCustomFont(rawValue);
      default:
        return undefined;
    }
  }

  /**
   * The value a *live* host control should apply.
   *
   * An empty URL parameter, an empty cache entry or a hand-edited seed means "this
   * source said nothing", so `normalizeFieldValue` returning `undefined` is right
   * to leave that layer out. A live control is different: clearing the name field
   * sends one event per deleted character, and dropping the final `''` left the
   * last letter stuck on the desktop — and in `localStorage`, so it survived a
   * reload. An explicit empty string therefore resets the name to
   * `DEFAULT_CONFIG.firstName`; anything that is not a string is still ignored.
   * The typography field follows the same rule: clearing the Lively textbox puts
   * the greeting back in Outfit instead of keeping the last family.
   */
  function resolveIpcFieldValue(field, rawValue) {
    const value = normalizeFieldValue(field, rawValue);
    if (value !== undefined) return value;
    if ((field === 'firstName' || field === 'fontFamily') && typeof rawValue === 'string') {
      return DEFAULT_CONFIG[field];
    }
    return undefined;
  }

  function firstDefined(candidates) {
    return candidates.find((value) => value !== undefined && value !== null);
  }

  /* ----------------------------------------------------------------------- *
   * Configuration sources
   * ------------------------------------------------------------------------ */

  const QUERY_ALIASES = Object.freeze({
    name: 'firstName',
    firstname: 'firstName',
    first: 'firstName',
    subtitle: 'subtitle',
    bg: 'bgColor',
    bgcolor: 'bgColor',
    theme: 'theme',
    slideshow: 'slideshow',
    photos: 'photos',
    interval: 'slideshowInterval',
    slideshowinterval: 'slideshowInterval',
    shuffle: 'slideshowShuffle',
    slideshowshuffle: 'slideshowShuffle',
    kenburns: 'kenBurns',
    photosync: 'photoSync',
    timesync: 'photoSync',
    dynamicphotos: 'photoSync',
    font: 'fontFamily',
    fontfamily: 'fontFamily',
    fonturl: 'customFont',
    customfont: 'customFont'
  });

  const LIVELY_FIELDS = Object.freeze({
    firstName: 'firstName',
    subtitleText: 'subtitle',
    bgColor: 'bgColor',
    theme: 'theme',
    slideshow: 'slideshow',
    slideshowInterval: 'slideshowInterval',
    slideshowShuffle: 'slideshowShuffle',
    kenBurns: 'kenBurns',
    // Time-of-day photo bands; the macOS host's "Match time of day" toggle.
    photoSync: 'photoSync',
    // Typography: an installed family name and, when the user imported a font
    // file, the `data:` URL of those bytes (sent by the native hosts).
    fontFamily: 'fontFamily',
    customFont: 'customFont',
    // The macOS host reuses this key to hand the page its resolved photo list.
    photos: 'photos'
  });

  const WALLPAPER_ENGINE_FIELDS = Object.freeze({
    firstname: 'firstName',
    subtitle: 'subtitle',
    bgcolor: 'bgColor',
    theme: 'theme',
    slideshow: 'slideshow',
    slideshowinterval: 'slideshowInterval',
    slideshowshuffle: 'slideshowShuffle',
    kenburns: 'kenBurns',
    photosync: 'photoSync',
    fontfamily: 'fontFamily',
    customfont: 'customFont'
  });

  function ownLookup(map, key) {
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
  }

  function parseQueryParams(search) {
    const config = {};
    if (typeof search !== 'string' || search === '') return config;

    let params;
    try {
      params = new URLSearchParams(search);
    } catch (error) {
      return config;
    }

    params.forEach((value, key) => {
      const field = ownLookup(QUERY_ALIASES, key.trim().toLowerCase());
      if (!field) return;
      const normalized = normalizeFieldValue(field, value);
      if (normalized !== undefined) config[field] = normalized;
    });

    return config;
  }

  function readStoredConfig(storage) {
    const config = {};
    if (!storage || typeof storage.getItem !== 'function') return config;

    Object.keys(STORAGE_KEYS).forEach((field) => {
      let raw = null;
      try {
        raw = storage.getItem(STORAGE_KEYS[field]);
      } catch (error) {
        return; // storage can be blocked (private mode, disabled cookies)
      }
      if (raw === null) return;
      const normalized = normalizeFieldValue(field, raw);
      if (normalized !== undefined) config[field] = normalized;
    });

    return config;
  }

  function persistConfig(config, storage) {
    if (!config || !storage || typeof storage.setItem !== 'function') return;
    Object.keys(STORAGE_KEYS).forEach((field) => {
      const value = config[field];
      if (value === undefined) return;
      try {
        storage.setItem(STORAGE_KEYS[field], String(value));
      } catch (error) {
        /* Caching is best-effort only. */
      }
    });
  }

  /**
   * The host's at-document-start snapshot (`window.__dynawallSeed`), normalised
   * exactly like an IPC value so a hand-edited seed cannot paint an invalid name,
   * colour or photo list. The macOS app writes it with a `WKUserScript` before the
   * page parses, which is what lets the very first frame be the user's wallpaper.
   */
  function readSeed(win) {
    const seed = win && win.__dynawallSeed;
    if (!seed || typeof seed !== 'object') return {};
    const config = {};
    Object.keys(DEFAULT_CONFIG).forEach((field) => {
      if (!Object.prototype.hasOwnProperty.call(seed, field)) return;
      const value = normalizeFieldValue(field, seed[field]);
      if (value !== undefined) config[field] = value;
    });
    return config;
  }

  /** Merge the five layers: IPC → host seed → URL → localStorage → defaults. */
  function resolveConfig(layers) {
    const ipc = (layers && layers.ipc) || {};
    const seed = (layers && layers.seed) || {};
    const url = (layers && layers.url) || {};
    const storage = (layers && layers.storage) || {};
    const defaults = (layers && layers.defaults) || DEFAULT_CONFIG;

    const config = {};
    Object.keys(DEFAULT_CONFIG).forEach((field) => {
      const resolved = firstDefined([
        ipc[field],
        seed[field],
        url[field],
        storage[field],
        defaults[field]
      ]);
      config[field] = resolved === undefined ? DEFAULT_CONFIG[field] : resolved;
    });

    // Picking a background colour by hand (URL, IPC or cache) is an explicit
    // override, so the palette stops following the clock instead of silently
    // discarding the colour. Naming a theme in the same source wins, which is how
    // a host asks for a palette and still keeps a colour for `custom`.
    const explicitTheme = firstDefined([ipc.theme, seed.theme, url.theme, storage.theme]);
    const explicitColor = firstDefined([
      ipc.bgColor,
      seed.bgColor,
      url.bgColor,
      storage.bgColor
    ]);
    if (explicitTheme === undefined && explicitColor !== undefined) {
      config.theme = 'custom';
    }

    return config;
  }

  /** livelyPropertyListener(name, value) → { field, value } or null. */
  function mapLivelyProperty(name, rawValue) {
    if (typeof name !== 'string') return null;
    const field = ownLookup(LIVELY_FIELDS, name.trim());
    if (!field) return null;
    const value = resolveIpcFieldValue(field, rawValue);
    return value === undefined ? null : { field: field, value: value };
  }

  /** wallpaperPropertyListener.applyUserProperties(...) → [{ field, value }]. */
  function mapWallpaperEngineProperties(properties) {
    const updates = [];
    if (!properties || typeof properties !== 'object') return updates;

    Object.keys(properties).forEach((key) => {
      const field = ownLookup(WALLPAPER_ENGINE_FIELDS, key.toLowerCase());
      if (!field) return;
      const entry = properties[key];
      const raw = entry && typeof entry === 'object' ? entry.value : entry;
      const value = resolveIpcFieldValue(field, raw);
      if (value !== undefined) updates.push({ field: field, value: value });
    });

    return updates;
  }

  /* ----------------------------------------------------------------------- *
   * Widgets — constellations, cards, and the one network call
   * ------------------------------------------------------------------------ */

  /**
   * The four satellites around the greeting. `id` is the `data-widget` of the
   * button in index.html and the key of a renderer below; `title`/`caption` are the
   * card header. A test asserts the markup and this list agree.
   */
  const WIDGETS = Object.freeze([
    Object.freeze({ id: 'music', title: 'YouTube Music', caption: 'Stations and mixes' }),
    Object.freeze({ id: 'news', title: 'Google News', caption: 'Today’s front page, by desk' }),
    Object.freeze({ id: 'youtube', title: 'YouTube', caption: 'Trending, or a search' }),
    Object.freeze({ id: 'weather', title: 'Weather', caption: 'Now, and the next hours' })
  ]);

  /**
   * Every remote host this page can name, and nothing else — split by what the
   * page does with it, because that distinction is the whole network policy here.
   *
   *   `WIDGET_FETCH_HOSTS` — the page itself calls these, and only after the weather
   *   card is opened. Open-Meteo is keyless, CORS-enabled and free for
   *   non-commercial use, and Google has no keyless weather endpoint at all, which
   *   is why the forecast is the one live card.
   *
   *   `WIDGET_LINK_HOSTS` — handed to the operating system's default browser through
   *   the native bridge. The page never fetches them, never frames them and never
   *   loads their images, so no YouTube or Google News code runs inside the
   *   wallpaper and nothing is requested while a card is closed.
   *
   * tests/verify.cjs asserts this list is exactly the set of hosts script.js
   * mentions, so a new address cannot appear without being declared here — and the
   * wallpaper's own chrome (greeting, palette, fonts, photos) stays proof-positive
   * network-free.
   */
  const WIDGET_FETCH_HOSTS = Object.freeze(['api.open-meteo.com', 'geocoding-api.open-meteo.com']);
  const WIDGET_LINK_HOSTS = Object.freeze([
    'music.youtube.com',
    'www.youtube.com',
    'news.google.com'
  ]);
  const WIDGET_REMOTE_HOSTS = Object.freeze(WIDGET_FETCH_HOSTS.concat(WIDGET_LINK_HOSTS));

  const YOUTUBE_MUSIC_HOME = 'https://music.youtube.com/';
  const YOUTUBE_HOME = 'https://www.youtube.com/';
  const GOOGLE_NEWS_HOME = 'https://news.google.com/';
  const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
  const OPEN_METEO_GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';

  /** Longest string any widget will echo back into the page. */
  const MAX_WIDGET_TEXT = 120;
  /** A forecast older than this is refreshed the next time the card is opened. */
  const WEATHER_FRESH_MS = 10 * 60 * 1000;
  /** How long a forecast request may take before the card offers a retry. */
  const WEATHER_TIMEOUT_MS = 9000;
  /** Extra pixels around a satellite that still count as hovering it. */
  const HIT_PADDING = 6;

  /** Trim a value to something a card can print, or `''`. */
  function clipText(value, maxLength) {
    if (value === undefined || value === null) return '';
    const text = String(value).replace(/\s+/g, ' ').trim();
    const limit =
      Number.isFinite(Number(maxLength)) && Number(maxLength) > 0 ? Number(maxLength) : MAX_WIDGET_TEXT;
    return text.length > limit ? text.slice(0, limit) : text;
  }

  /** Append `params` to `base` as an encoded query string, skipping empty values. */
  function withQuery(base, params) {
    const parts = [];
    Object.keys(params || {}).forEach(function (key) {
      const value = params[key];
      if (value === undefined || value === null || value === '') return;
      // Commas separate the multi-value fields Open-Meteo takes (`current=a,b,c`);
      // they read better unescaped in a log or a proxy trace and every parser
      // treats `%2C` and `,` identically. Everything else is percent-encoded.
      const encoded = encodeURIComponent(value).replace(/%2C/g, ',');
      parts.push(encodeURIComponent(key) + '=' + encoded);
    });
    if (parts.length === 0) return base;
    return base + (base.indexOf('?') === -1 ? '?' : '&') + parts.join('&');
  }

  /** A YouTube Music search, or the home page when the term is empty. */
  function buildYouTubeMusicSearchUrl(query) {
    const term = clipText(query, MAX_WIDGET_TEXT);
    return term ? withQuery(YOUTUBE_MUSIC_HOME + 'search', { q: term }) : YOUTUBE_MUSIC_HOME;
  }

  /** A YouTube search, or the home page when the term is empty. */
  function buildYouTubeSearchUrl(query) {
    const term = clipText(query, MAX_WIDGET_TEXT);
    return term ? withQuery(YOUTUBE_HOME + 'results', { search_query: term }) : YOUTUBE_HOME;
  }

  /** The trending feed, narrowed to a region when one is known. */
  function buildYouTubeTrendingUrl(regionCode) {
    const region = clipText(regionCode, 2).toUpperCase();
    return region
      ? withQuery(YOUTUBE_HOME + 'feed/trending', { gl: region })
      : YOUTUBE_HOME + 'feed/trending';
  }

  /** A Google News desk (`''` = the front page) — there is no API to call. */
  function buildGoogleNewsUrl(topic) {
    const term = clipText(topic, MAX_WIDGET_TEXT);
    if (!term) return GOOGLE_NEWS_HOME;
    return withQuery(GOOGLE_NEWS_HOME + 'search', {
      q: term,
      hl: 'en-US',
      gl: 'US',
      ceid: 'US:en'
    });
  }

  /** `celsius` unless the card has been switched to Fahrenheit. */
  function normalizeTemperatureUnit(unit) {
    return unit === 'fahrenheit' ? 'fahrenheit' : 'celsius';
  }

  /** "en-GB" → "GB": the region YouTube's trending feed is asked for. */
  function regionCodeFromLocale(locale) {
    const match = /[-_]([A-Za-z]{2})\b/.exec(String(locale || ''));
    return match ? match[1].toUpperCase() : 'US';
  }

  /**
   * The Open-Meteo forecast request for one place.
   *
   * Everything the card draws is asked for in one call — current conditions, six
   * hourly steps and today's high/low — because the API costs nothing but the user
   * still pays for it in latency. `timezone=auto` is what makes the hourly labels
   * the *place's* hours instead of the machine's.
   */
  function buildWeatherForecastUrl(options) {
    const opts = options || {};
    const unit = normalizeTemperatureUnit(opts.unit);
    return withQuery(OPEN_METEO_FORECAST_URL, {
      latitude: Number(opts.latitude),
      longitude: Number(opts.longitude),
      current:
        'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m',
      hourly: 'temperature_2m,weather_code,precipitation_probability',
      daily: 'temperature_2m_max,temperature_2m_min',
      timezone: 'auto',
      forecast_days: 2,
      temperature_unit: unit,
      wind_speed_unit: unit === 'fahrenheit' ? 'mph' : 'kmh'
    });
  }

  /** The Open-Meteo place search behind the card's city field. */
  function buildGeocodingUrl(name) {
    return withQuery(OPEN_METEO_GEOCODING_URL, {
      name: clipText(name, 80),
      count: 6,
      language: 'en',
      format: 'json'
    });
  }

  /**
   * WMO 4677 present-weather codes → the label and the glyph the card draws.
   *
   * Grouped the way the code table is: 0–3 clear through overcast, 45/48 fog,
   * 51–57 drizzle, 61–67 rain, 71–77 snow, 80–82 showers, 85/86 snow showers,
   * 95–99 thunderstorm. An unknown code from a newer API version falls through to
   * `WMO_FALLBACK`, because inventing "sunny" out of a number we do not know is
   * exactly the kind of guess a weather card must not make.
   */
  const WMO_CONDITIONS = Object.freeze({
    0: Object.freeze({ label: 'Clear sky', glyph: 'clear' }),
    1: Object.freeze({ label: 'Mainly clear', glyph: 'clear' }),
    2: Object.freeze({ label: 'Partly cloudy', glyph: 'partly' }),
    3: Object.freeze({ label: 'Overcast', glyph: 'cloud' }),
    45: Object.freeze({ label: 'Fog', glyph: 'fog' }),
    48: Object.freeze({ label: 'Freezing fog', glyph: 'fog' }),
    51: Object.freeze({ label: 'Light drizzle', glyph: 'rain' }),
    53: Object.freeze({ label: 'Drizzle', glyph: 'rain' }),
    55: Object.freeze({ label: 'Heavy drizzle', glyph: 'rain' }),
    56: Object.freeze({ label: 'Freezing drizzle', glyph: 'rain' }),
    57: Object.freeze({ label: 'Freezing drizzle', glyph: 'rain' }),
    61: Object.freeze({ label: 'Light rain', glyph: 'rain' }),
    63: Object.freeze({ label: 'Rain', glyph: 'rain' }),
    65: Object.freeze({ label: 'Heavy rain', glyph: 'rain' }),
    66: Object.freeze({ label: 'Freezing rain', glyph: 'rain' }),
    67: Object.freeze({ label: 'Freezing rain', glyph: 'rain' }),
    71: Object.freeze({ label: 'Light snow', glyph: 'snow' }),
    73: Object.freeze({ label: 'Snow', glyph: 'snow' }),
    75: Object.freeze({ label: 'Heavy snow', glyph: 'snow' }),
    77: Object.freeze({ label: 'Snow grains', glyph: 'snow' }),
    80: Object.freeze({ label: 'Light showers', glyph: 'rain' }),
    81: Object.freeze({ label: 'Showers', glyph: 'rain' }),
    82: Object.freeze({ label: 'Violent showers', glyph: 'rain' }),
    85: Object.freeze({ label: 'Snow showers', glyph: 'snow' }),
    86: Object.freeze({ label: 'Heavy snow showers', glyph: 'snow' }),
    95: Object.freeze({ label: 'Thunderstorm', glyph: 'storm' }),
    96: Object.freeze({ label: 'Thunderstorm with hail', glyph: 'storm' }),
    99: Object.freeze({ label: 'Thunderstorm with hail', glyph: 'storm' })
  });

  const WMO_FALLBACK = Object.freeze({ label: 'Unsettled', glyph: 'cloud' });

  /** `2` → `{ label: 'Partly cloudy', glyph: 'partly' }`. */
  function describeWmoCode(code) {
    const value = Number(code);
    const entry = Number.isFinite(value) ? WMO_CONDITIONS[Math.round(value)] : null;
    return entry
      ? { label: entry.label, glyph: entry.glyph }
      : { label: WMO_FALLBACK.label, glyph: WMO_FALLBACK.glyph };
  }

  /** 21.4 → `"21°"`; the unit lives in the metric row so the big number stays big. */
  function formatTemperature(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.round(number) + '°' : '—';
  }

  /** `"2026-01-15T14:00"` → `"14:00"`, read from the string so no timezone drifts in. */
  function hourLabel(value) {
    const match = /T(\d{2}):(\d{2})/.exec(String(value || ''));
    if (!match) return '';
    return match[1] + ':00';
  }

  /** `"just now"`, `"4 min ago"`, `"2 h ago"` — a card is opened far more often than refreshed. */
  function relativeTime(timestamp, now) {
    const then = Number(timestamp);
    if (!Number.isFinite(then) || then <= 0) return 'never';
    const reference = Number.isFinite(Number(now)) ? Number(now) : Date.now();
    const elapsed = Math.max(0, reference - then);
    const minutes = Math.floor(elapsed / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return minutes + ' min ago';
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + ' h ago';
    return Math.floor(hours / 24) + ' d ago';
  }

  /** Index of the first hourly entry at or after the current hour (ISO sorts lexically). */
  function indexOfHour(times, currentTime) {
    const needle = String(currentTime || '').slice(0, 13); // YYYY-MM-DDTHH
    for (let index = 0; index < times.length; index += 1) {
      if (String(times[index]).slice(0, 13) >= needle) return index;
    }
    return 0;
  }

  /**
   * Normalise an Open-Meteo forecast into the shape the card draws, or `null` when
   * the payload is not a forecast at all — the caller then shows the error state
   * instead of a card full of dashes.
   *
   * Six hourly steps, not twenty-four: the strip has to stay on one line without a
   * scrollbar on a 360 px window. Today's high/low comes from `daily`, which is
   * why `forecast_days=2` is requested — the second day covers the six hours after
   * midnight.
   */
  function parseWeatherPayload(payload, options) {
    if (!payload || typeof payload !== 'object') return null;
    const current = payload.current || payload.current_weather;
    if (!current || !Number.isFinite(Number(current.temperature_2m))) return null;

    const unit = normalizeTemperatureUnit(options && options.unit);
    const condition = describeWmoCode(current.weather_code);
    const hourly = payload.hourly || {};
    const times = Array.isArray(hourly.time) ? hourly.time : [];
    const temperatures = Array.isArray(hourly.temperature_2m) ? hourly.temperature_2m : [];
    const codes = Array.isArray(hourly.weather_code) ? hourly.weather_code : [];
    const precipitation = Array.isArray(hourly.precipitation_probability)
      ? hourly.precipitation_probability
      : [];

    const start = indexOfHour(times, current.time);
    const hours = [];
    for (let index = start; index < times.length && hours.length < 6; index += 1) {
      const chance = Number(precipitation[index]);
      hours.push({
        time: String(times[index]),
        hour: hourLabel(times[index]),
        temperature: formatTemperature(temperatures[index]),
        label: describeWmoCode(codes[index]).label,
        precipitation: Number.isFinite(chance) ? Math.round(chance) : null,
        isNow: hours.length === 0
      });
    }

    const daily = payload.daily || {};
    const highs = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max : [];
    const lows = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min : [];
    const humidity = Number(current.relative_humidity_2m);
    const wind = Number(current.wind_speed_10m);

    // The highest chance in the six hours on screen: "will I need a coat" is one
    // number, and a per-hour percentage is already in the strip.
    let rainChance = null;
    hours.forEach(function (hour) {
      if (hour.precipitation === null) return;
      rainChance = rainChance === null ? hour.precipitation : Math.max(rainChance, hour.precipitation);
    });

    return {
      temperature: formatTemperature(current.temperature_2m),
      apparent: formatTemperature(current.apparent_temperature),
      high: formatTemperature(highs[0]),
      low: formatTemperature(lows[0]),
      humidity: Number.isFinite(humidity) ? Math.round(humidity) + '%' : '—',
      wind: Number.isFinite(wind)
        ? Math.round(wind) + (unit === 'fahrenheit' ? ' mph' : ' km/h')
        : '—',
      rain: rainChance === null ? '—' : rainChance + '%',
      isDay: Number(current.is_day) !== 0,
      code: Number(current.weather_code),
      label: condition.label,
      glyph: condition.glyph,
      unit: unit,
      unitSuffix: unit === 'fahrenheit' ? '°F' : '°C',
      hours: hours
    };
  }

  /** `{ results: [...] }` → the plain place list the picker rows render. */
  function parseGeocodingResults(payload) {
    const results = payload && Array.isArray(payload.results) ? payload.results : [];
    const places = [];
    results.slice(0, 6).forEach(function (entry) {
      if (!entry || typeof entry !== 'object') return;
      const latitude = Number(entry.latitude);
      const longitude = Number(entry.longitude);
      const name = clipText(entry.name, 80);
      if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
      const region = clipText(entry.admin1, 60);
      const country = clipText(entry.country, 60);
      places.push({
        id: String(entry.id || name + '@' + latitude + ',' + longitude),
        name: name,
        region: region,
        country: country,
        latitude: latitude,
        longitude: longitude,
        label: [name, region, country].filter(Boolean).join(' · ')
      });
    });
    return places;
  }

  /* ----------------------------------------------------------------------- *
   * Widget plumbing
   * ------------------------------------------------------------------------ */

  /** The place the weather card last showed, or `null` if it never had one. */
  function readWeatherPlace(storage) {
    if (!storage) return null;
    try {
      const raw = storage.getItem(STORAGE_KEYS.weatherPlace);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const latitude = Number(parsed && parsed.latitude);
      const longitude = Number(parsed && parsed.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
      return {
        name: clipText(parsed.name, 80) || 'Selected place',
        region: clipText(parsed.region, 60),
        country: clipText(parsed.country, 60),
        latitude: latitude,
        longitude: longitude
      };
    } catch (error) {
      return null; // A cleared or hand-edited cache is "no place", not a crash.
    }
  }

  function writeWeatherPlace(storage, place) {
    if (!storage || !place) return;
    try {
      storage.setItem(
        STORAGE_KEYS.weatherPlace,
        JSON.stringify({
          name: place.name,
          region: place.region || '',
          country: place.country || '',
          latitude: place.latitude,
          longitude: place.longitude
        })
      );
    } catch (error) {
      /* Private mode; the card still works for this session. */
    }
  }

  function readWeatherUnit(storage) {
    try {
      return normalizeTemperatureUnit(storage && storage.getItem(STORAGE_KEYS.weatherUnit));
    } catch (error) {
      return 'celsius';
    }
  }

  function writeWeatherUnit(storage, unit) {
    try {
      if (storage) storage.setItem(STORAGE_KEYS.weatherUnit, normalizeTemperatureUnit(unit));
    } catch (error) {
      /* Private mode. */
    }
  }

  /**
   * `fetch` with a hard timeout, used by the weather card and nothing else.
   *
   * Only ever called after the card is opened, so a wallpaper nobody touches makes
   * no request at all. `credentials: 'omit'` keeps the request anonymous — it
   * carries no cookie from this app, because there is nothing to authenticate.
   */
  function fetchJson(win, url, timeoutMs) {
    if (typeof win.fetch !== 'function') {
      return Promise.reject(new Error('This host cannot reach the network.'));
    }
    const Controller = typeof win.AbortController === 'function' ? win.AbortController : null;
    const controller = Controller ? new Controller() : null;
    const timer = win.setTimeout(function () {
      if (controller) controller.abort();
    }, timeoutMs || WEATHER_TIMEOUT_MS);
    const options = controller
      ? { signal: controller.signal, credentials: 'omit' }
      : { credentials: 'omit' };

    return win.fetch(url, options).then(
      function (response) {
        win.clearTimeout(timer);
        if (!response.ok) throw new Error('The service answered ' + response.status + '.');
        return response.json();
      },
      function (error) {
        win.clearTimeout(timer);
        throw error;
      }
    );
  }

  /** Turn whatever the network threw into a sentence the card can show. */
  function describeFetchError(error) {
    if (error && error.name === 'AbortError') return 'The service took too long to answer.';
    if (error && typeof error.message === 'string' && error.message) return error.message;
    return 'The request failed.';
  }

  /**
   * Hand a URL to the operating system.
   *
   * The macOS host exposes `dynawallOpenURL`, the Windows/WebView2 host reads a
   * `dynawall:open-url` web message, and a plain browser or Lively gets a new tab.
   * Only `https:` is ever forwarded, so a malformed catalogue entry cannot hand the
   * shell something it would rather not open. The page itself never navigates: the
   * page *is* the desktop.
   */
  function openExternal(win, url) {
    const target = String(url || '');
    if (!win || !/^https:\/\/[^\s]+$/.test(target)) return false;

    const webkitHandlers = win.webkit && win.webkit.messageHandlers;
    if (webkitHandlers && webkitHandlers.dynawallOpenURL) {
      try {
        webkitHandlers.dynawallOpenURL.postMessage(target);
        return true;
      } catch (error) {
        /* Fall through to the next host. */
      }
    }

    const webview = win.chrome && win.chrome.webview;
    if (webview && typeof webview.postMessage === 'function') {
      try {
        webview.postMessage({ type: 'dynawall:open-url', url: target });
        return true;
      } catch (error) {
        /* Fall through to the browser. */
      }
    }

    if (typeof win.open !== 'function') return false;
    try {
      win.open(target, '_blank', 'noopener');
      return true;
    } catch (error) {
      return false;
    }
  }

  /* ----------------------------------------------------------------------- *
   * Runtime
   * ------------------------------------------------------------------------ */

  function getStorage(win) {
    try {
      return win.localStorage || null;
    } catch (error) {
      return null; // Access throws when storage is disabled.
    }
  }

  function createApp(win, doc) {
    const elements = {
      content: doc.getElementById('content'),
      greeting: doc.getElementById('greeting'),
      subtitle: doc.getElementById('subtitle'),
      themeColor: doc.querySelector('meta[name="theme-color"]'),
      photoLayers: Array.prototype.slice.call(doc.querySelectorAll('.photo'))
    };

    const storage = getStorage(win);
    const reducedMotion =
      typeof win.matchMedia === 'function'
        ? win.matchMedia('(prefers-reduced-motion: reduce)')
        : null;

    const state = {
      config: resolveConfig({
        ipc: {},
        // Injected by a host (the macOS app) before the document was parsed.
        seed: readSeed(win),
        url: parseQueryParams(win.location ? win.location.search : ''),
        storage: readStoredConfig(storage),
        defaults: DEFAULT_CONFIG
      }),
      period: '',
      theme: '',
      renderedGreeting: '',
      greetingTimeout: 0,
      pendingGreeting: null,
      // One-shot timer for the next clock boundary (not a 30 s poll).
      clockTimer: 0,
      // `true` while the wallpaper asked to stand still, or the page is hidden.
      suspended: false,
      hostSuspended: false,
      photoIndex: -1,
      photoLayer: 0,
      // The pool the photo on screen came from: a band's list, or the whole library.
      photoPool: [],
      photoTimer: 0,
      photoFailures: 0,
      photoToken: 0,
      photoSignature: '',
      // The imported face currently registered with the document, and the exact
      // source it was built from (so an unchanged push is not decoded again).
      customFontFace: null,
      customFontSource: ''
    };

    function prefersReducedMotion() {
      return Boolean(reducedMotion && reducedMotion.matches);
    }

    /** The palette in force: `auto` follows the clock, everything else is pinned. */
    function resolveTheme(date) {
      const mode = state.config.theme;
      return mode === 'auto' ? getThemeSlot(date) : mode;
    }

    /**
     * Swap the palette. Every token lives on <html>, so one attribute repaints the
     * background, the accent glow, the text tones and the photo grade together and
     * CSS cross-fades them (see `html.is-theme-ready body` in style.css).
     *
     * `custom` is the only mode that rewrites --bg-primary inline: a hand-picked
     * colour replaces the band's background and keeps everything else from the
     * daylight palette.
     */
    function applyTheme() {
      const theme = resolveTheme(new Date());
      const root = doc.documentElement;

      if (theme === 'custom') {
        root.style.setProperty('--bg-primary', state.config.bgColor);
      } else {
        root.style.removeProperty('--bg-primary');
      }

      if (root.getAttribute('data-theme') !== theme) {
        root.setAttribute('data-theme', theme);
      }
      state.theme = theme;

      if (elements.themeColor) {
        // The target colour is looked up in a constant instead of read back with
        // `getComputedStyle(root).getPropertyValue('--bg-primary')`: that read
        // forced a synchronous style recalculation on <html> every single time the
        // palette moved. `custom` is the one mode that rewrites the token inline,
        // so its colour comes straight from the configuration.
        const target = theme === 'custom' ? state.config.bgColor : THEME_BG_HEX[theme];
        if (target) elements.themeColor.setAttribute('content', target);
      }
    }

    function applySubtitle() {
      if (elements.subtitle.textContent !== state.config.subtitle) {
        elements.subtitle.textContent = state.config.subtitle;
      }
    }

    /**
     * Point the greeting and subtitle at the chosen typeface.
     *
     * The token lives on <html>, so one property covers both rules and the
     * mini-preview-free hosts (Lively, Wallpaper Engine, a browser) need no
     * extra markup. Outfit is left to style.css: the stylesheet already declares
     * the exact same stack, so the shipped look never depends on script.js.
     *
     * An imported font file arrives from the host as a `data:` URL (the native
     * apps copy the user's file into Application Support / LocalAppData and read
     * it back); registering it with `document.fonts` puts it in the CSS font
     * matching set under the family name the host resolved, which is why the
     * family — not the URL — is what `--font-sans` names.
     */
    function applyTypography() {
      const root = doc.documentElement;
      const family =
        typeof state.config.fontFamily === 'string' && state.config.fontFamily
          ? state.config.fontFamily
          : DEFAULT_FONT_FAMILY;
      const source = state.config.customFont || '';

      if (family.toLowerCase() === DEFAULT_FONT_FAMILY.toLowerCase() && !source) {
        root.style.removeProperty('--font-sans');
      } else {
        root.style.setProperty('--font-sans', fontStack(family));
      }

      registerCustomFont(family, source);
    }

    /** Load (or replace) the imported face behind `family`. */
    function registerCustomFont(family, source) {
      if (source === state.customFontSource) return;
      state.customFontSource = source;

      const fonts = doc.fonts;
      if (state.customFontFace && fonts && typeof fonts.delete === 'function') {
        try {
          fonts.delete(state.customFontFace);
        } catch (error) {
          /* A face that never finished loading cannot be removed; harmless. */
        }
      }
      state.customFontFace = null;
      if (!source) return;

      const FontFaceCtor = win.FontFace || (typeof FontFace !== 'undefined' ? FontFace : null);
      if (!FontFaceCtor || !fonts || typeof fonts.add !== 'function') return;

      try {
        const face = new FontFaceCtor(family, 'url("' + source + '")', {
          weight: '100 900',
          style: 'normal',
          display: 'swap'
        });
        fonts.add(face);
        state.customFontFace = face;
        if (typeof face.load === 'function') {
          // A file that will not decode leaves the stack on Outfit rather than
          // blanking the greeting; the status is only useful to diagnostics.
          face.load().catch(function () {
            state.customFontFace = null;
          });
        }
      } catch (error) {
        state.customFontFace = null;
      }
    }

    /**
     * Cross-fade the greeting: fade out, swap the text, fade back in.
     * A change arriving mid-fade is queued instead of overlapping the animation.
     */
    function setGreeting(text, animate) {
      if (text === state.renderedGreeting && elements.greeting.textContent === text) return;

      if (state.greetingTimeout) {
        state.pendingGreeting = text;
        return;
      }

      const duration = prefersReducedMotion() ? 0 : TEXT_FADE_MS;
      if (!animate || duration === 0 || elements.greeting.textContent === '') {
        elements.greeting.textContent = text;
        state.renderedGreeting = text;
        return;
      }

      elements.greeting.classList.add('is-transitioning');
      state.greetingTimeout = win.setTimeout(function () {
        elements.greeting.textContent = text;
        state.renderedGreeting = text;
        elements.greeting.classList.remove('is-transitioning');
        state.greetingTimeout = 0;

        const pending = state.pendingGreeting;
        state.pendingGreeting = null;
        if (pending !== null && pending !== text) setGreeting(pending, true);
      }, duration);
    }

    /* --------------------------------------------------------------------- *
     * Photo slideshow
     * ---------------------------------------------------------------------- */

    /**
     * The sources to rotate through.
     *
     * A host list wins. When it is empty, the answer depends on who is rendering:
     * the macOS host owns the photo list (it always seeds `photos`, even empty) and
     * registers the `dynawallPhoto` bridge, so an empty list means "no folder or no
     * supported images" and the desktop stays solid black. Lively, Wallpaper
     * Engine's bundled mode and a plain browser have no such bridge and keep the
     * twelve curated wallpapers shipped in `images/`.
     */
    function photoSources() {
      const custom = state.config.photos;
      if (Array.isArray(custom) && custom.length > 0) return custom;
      const handlers = win.webkit && win.webkit.messageHandlers;
      return handlers && handlers.dynawallPhoto ? [] : BUNDLED_PHOTOS;
    }

    /**
     * The band whose photos should be on screen. `''` turns time sync off, a
     * pinned palette (`dawn`…`night`) keeps its own band, and `auto`/`custom`
     * follow the clock — the same band the palette is painted with.
     */
    function activePhotoBand() {
      if (!state.config.photoSync) return '';
      return resolvePhotoBand(state.config.theme, new Date());
    }

    /** The active band's photos, or the whole library when sync is off. */
    function activePhotoSources() {
      const sources = photoSources();
      const band = activePhotoBand();
      if (!band) return sources;
      const banded = getPhotosForSlot(sources, band);
      return banded.length > 0 ? banded : sources;
    }

    function slideshowIntervalMs() {
      return normalizeSlideshowInterval(state.config.slideshowInterval) * 60 * 1000;
    }

    /** Everything that would justify restarting the slideshow, as one string. */
    function slideshowSignature() {
      return [
        state.config.slideshow ? 'on' : 'off',
        slideshowIntervalMs(),
        state.config.slideshowShuffle ? 'shuffle' : 'sequential',
        state.config.kenBurns ? 'zoom' : 'still',
        // Crossing 05:00 / 09:00 / 17:00 / 21:00 — or picking a band in the host —
        // changes the pool, so the signature has to carry the band itself.
        `band:${activePhotoBand() || 'all'}`,
        photoSources().join('|')
      ].join('::');
    }

    /**
     * The pool to rotate through: the active band, or the whole library when the
     * band only holds the photo already on screen — "Next photo" must never look
     * like a dead button.
     */
    function nextPhotoPool() {
      const banded = activePhotoSources();
      const all = photoSources();
      return banded.length > 1 || banded.length >= all.length ? banded : all;
    }

    /**
     * Step to the next photo in `pool`. The photo on screen may come from another
     * pool (band change, shorter folder), so the move is anchored on the visible
     * URL rather than on an index that may no longer mean anything.
     */
    function nextPhotoIndexFor(pool) {
      const current = pool.indexOf(state.photoPool[state.photoIndex]);
      return stepPhotoIndex(pool.length, current, state.config.slideshowShuffle);
    }

    /**
     * Paint a photo on the spare layer, then cross-fade the two layers.
     *
     * Two failure paths land here and must both end the same way — a step to the next
     * photo, never a blank frame:
     *
     *   1. `decode()` rejecting, which is the reliable signal for a file the browser
     *      opened but cannot decode (truncated JPEG, renamed text file, HEIC on a host
     *      without the codec);
     *   2. the `<img>` `error` event, which is the *earlier* signal for a file that is
     *      gone, unreadable or rejected by the scheme handler.
     *
     * @param {number} index Index into `list` (or into the active pool when omitted).
     * @param {string[]} [list] Pool to paint from.
     */
    function paintPhoto(index, list) {
      const sources = list && list.length > 0 ? list : activePhotoSources();
      if (elements.photoLayers.length === 0 || !sources[index]) return;

      const previous = elements.photoLayers[state.photoLayer];
      state.photoLayer = (state.photoLayer + 1) % elements.photoLayers.length;
      const layer = elements.photoLayers[state.photoLayer];
      state.photoIndex = index;
      state.photoPool = sources;

      // A decode that lands after the list changed (host push, slideshow toggle)
      // must not fade, and must not count as a broken photo.
      const token = (state.photoToken += 1);
      const stale = function () {
        return token !== state.photoToken;
      };
      // The two failure paths above can both fire for one photo; whichever arrives
      // first wins, so a single broken file only ever costs one skip.
      let settled = false;

      // Removing `.is-ken-burns` and adding it again in the same task does not
      // restart a CSS animation; the reflow does. It is only needed when the drift
      // was actually running on this layer, though — a fresh layer starts at frame
      // 0 anyway, and `offsetWidth` forces a synchronous layout, so asking for it
      // unconditionally is a wasted layout on every single slide.
      const wasDrifting = layer.classList.contains('is-ken-burns');
      layer.classList.remove('is-visible', 'is-ken-burns');
      layer.style.removeProperty('--photo-duration');
      const drift = Boolean(state.config.kenBurns) && !prefersReducedMotion();
      if (wasDrifting && drift) void layer.offsetWidth; // restart from the first frame
      if (drift) {
        layer.style.setProperty('--photo-duration', `${slideshowIntervalMs() + PHOTO_FADE_MS}ms`);
        layer.classList.add('is-ken-burns');
      }

      const reveal = function () {
        if (settled || stale()) return;
        settled = true;
        state.photoFailures = 0;
        layer.classList.add('is-visible');
        if (previous && previous !== layer) {
          previous.classList.remove('is-visible');
          // The outgoing layer keeps its bitmap while the 1.2 s cross-fade runs; it
          // is released as soon as nothing can see it any more.
          releasePhotoTexture(previous);
        }
        reportPhoto(layer);
      };

      // A file the browser cannot decode must never put a blank layer on screen:
      // skip ahead instead, and give up (back to the plain background) if nothing
      // in the list can be rendered at all.
      const skip = function () {
        if (settled || stale()) return;
        settled = true;
        layer.onerror = null;
        layer.removeAttribute('src');
        state.photoFailures += 1;
        if (state.photoFailures >= sources.length) {
          // Every photo in this pool is unreadable. When the pool was narrowed to
          // the band the clock is on, widen to the whole library once before giving
          // up: a folder whose only Day picture is corrupt should still show its
          // Evening one rather than a black desktop. `sources.length` grows with the
          // wider pool, so a folder that is broken end to end still stops here.
          const all = photoSources();
          if (all.length > sources.length) {
            state.photoFailures = 0;
            const current = all.indexOf(sources[index]);
            paintPhoto(stepPhotoIndex(all.length, current, false), all);
            return;
          }
          state.photoFailures = 0;
          state.photoSignature = '';
          doc.body.classList.remove('has-photo');
          clearPhotos();
          return;
        }
        scheduleSlide(50);
      };

      // Wired before `src` so an error that fires synchronously (cached 404, a file
      // deleted between the scan and the paint) still reaches `skip`.
      layer.onerror = skip;
      layer.src = sources[index];

      // decode() settles only once the bitmap is ready, so the fade never shows a gap.
      if (typeof layer.decode === 'function') {
        layer.decode().then(reveal, skip);
      } else {
        reveal();
      }
    }

    /**
     * Free the decoded texture of a layer that just lost `.is-visible`.
     *
     * `src` cannot be cleared at the moment the cross-fade starts: the outgoing photo
     * is still fading out for `--photo-fade-duration`. Once that has elapsed the layer
     * is `visibility: hidden`, so dropping `src` hands the bitmap back to the browser
     * instead of holding tens of megabytes for a photo that will not be shown again.
     * The layer keeps its element and classes and simply receives the next `src`.
     *
     * The token check makes this a no-op when a newer slide already reused the layer,
     * and the class check catches a fast rotation that revealed it again in the
     * meantime — clearing either of those would blank a photo that is on screen.
     *
     * @param {HTMLImageElement} layer The layer that just stopped being visible.
     */
    function releasePhotoTexture(layer) {
      const token = state.photoToken;
      win.setTimeout(function () {
        if (token !== state.photoToken) return;
        if (layer.classList.contains('is-visible')) return;
        layer.removeAttribute('src');
      }, PHOTO_FADE_MS);
    }

    /**
     * Tell the macOS host which photo is on screen. Browsers, Lively and Wallpaper
     * Engine have no such handler, so this is a no-op there.
     */
    function reportPhoto(layer) {
      const handlers = win.webkit && win.webkit.messageHandlers;
      if (!handlers || !handlers.dynawallPhoto) return;
      try {
        handlers.dynawallPhoto.postMessage({
          src: layer.currentSrc || layer.getAttribute('src') || '',
          width: layer.naturalWidth,
          height: layer.naturalHeight
        });
      } catch (error) {
        /* Diagnostics only. */
      }
    }

    function scheduleSlide(delay) {
      win.clearTimeout(state.photoTimer);
      state.photoTimer = 0;
      // An occluded or sleeping desktop must not rotate photos: only a short retry
      // for a photo that failed to decode is allowed through, because it is bounded
      // by the list length and would otherwise park a blank layer until resume.
      if (state.suspended && typeof delay !== 'number') return;
      const wait = typeof delay === 'number' ? delay : slideshowIntervalMs();
      state.photoTimer = win.setTimeout(advancePhoto, wait);
    }

    /**
     * The automatic tick: stay inside the active band.
     *
     * `photoSync` means "show the light that is outside right now", so the timer
     * (and the wake/focus handler) must never fall back to the whole library just
     * because the band holds one photo — that would put a Night picture on screen
     * at noon after a single interval. When the band already has its only photo on
     * screen there is nothing to advance to, so the spare layer is left alone too.
     */
    function advancePhoto() {
      if (!state.config.slideshow) return false;
      const pool = activePhotoSources();
      if (pool.length === 0) return false;
      if (pool.length === 1 && state.photoPool[state.photoIndex] === pool[0]) return false;
      paintPhoto(nextPhotoIndexFor(pool), pool);
      scheduleSlide(); // a manual skip earns a full interval as well
      return true;
    }

    /**
     * Skip to the next photo right away — the menu bar "Next photo" button,
     * `livelyPropertyListener('nextPhoto', true)` and `DynaWall.nextPhoto()`.
     *
     * Unlike the timer this may leave the active band when the band holds only the
     * photo already on screen: a button that visibly does nothing would be worse
     * than one that crosses into another time of day on request. The timer restarts
     * from here, and the next band change returns to the synced pool.
     */
    function nextPhoto() {
      if (!state.config.slideshow) return false;
      const pool = nextPhotoPool();
      if (pool.length === 0) return false;
      paintPhoto(nextPhotoIndexFor(pool), pool);
      scheduleSlide();
      return true;
    }

    function clearPhotos() {
      win.clearTimeout(state.photoTimer);
      state.photoTimer = 0;
      state.photoToken += 1; // invalidate any decode still in flight
      elements.photoLayers.forEach(function (layer) {
        layer.classList.remove('is-visible', 'is-ken-burns');
        layer.style.removeProperty('--photo-duration');
        // The handler belongs to the photo that is being cleared, not to the layer:
        // leaving it attached would fire a skip for a slideshow that is off.
        layer.onerror = null;
        layer.removeAttribute('src');
      });
      state.photoIndex = -1;
      state.photoLayer = 0;
      state.photoFailures = 0;
    }

    /**
     * Start, restart or stop the slideshow. The signature check means typing a
     * name never interrupts the photo that is currently fading in.
     */
    function applySlideshow() {
      if (elements.photoLayers.length === 0) return;

      const signature = slideshowSignature();
      if (signature === state.photoSignature) return;
      state.photoSignature = signature;

      const sources = activePhotoSources();
      const enabled = Boolean(state.config.slideshow) && sources.length > 0;
      doc.body.classList.toggle('has-photo', enabled);
      if (!enabled) {
        clearPhotos();
        return;
      }

      // A band change or a host push restarts the rotation without emptying the
      // layers first: the next photo decodes on the spare layer and the two
      // cross-fade, so the desktop never blinks through the bare background.
      win.clearTimeout(state.photoTimer);
      state.photoTimer = 0;
      state.photoToken += 1; // a decode from the previous list must not land
      state.photoIndex = -1;
      state.photoPool = sources;
      state.photoFailures = 0;

      const start = state.config.slideshowShuffle ? Math.floor(Math.random() * sources.length) : 0;
      paintPhoto(start, sources);
      scheduleSlide();
    }

    /* --------------------------------------------------------------------- *
     * Clock scheduling & suspension
     * ---------------------------------------------------------------------- */

    /**
     * Arm the one-shot timer for the next clock boundary.
     *
     * `syncClock()` is cheap, but waking the JS thread 2,880 times a day to
     * discover that 05:00 is still hours away is not: the timer sleeps for exactly
     * `msUntilNextClockBoundary()`. On a suspend/resume or a wake the caller
     * resyncs and re-arms, so a throttled background timer can never leave the
     * wallpaper on a stale band.
     */
    function scheduleClock(delay) {
      win.clearTimeout(state.clockTimer);
      state.clockTimer = 0;
      if (state.suspended) return;

      const wait = typeof delay === 'number' && delay >= 0 ? delay : msUntilNextClockBoundary();
      state.clockTimer = win.setTimeout(function () {
        state.clockTimer = 0;
        if (state.suspended) return;
        syncClock();
        scheduleClock();
      }, wait);
    }

    /** Parked while the host asked for it, or while the page is not being shown. */
    function shouldSuspend() {
      return state.hostSuspended || doc.visibilityState === 'hidden';
    }

    /**
     * Apply the suspension state: park the clock and slideshow timers and let CSS
     * pause the Ken Burns drift (`html.is-suspended`), or resume and resync
     * everything the clock owns. Idempotent, so a host may repeat itself freely.
     */
    function applySuspension() {
      const suspended = shouldSuspend();
      if (suspended === state.suspended) return state.suspended;
      state.suspended = suspended;

      const root = doc.documentElement;
      if (suspended) {
        win.clearTimeout(state.clockTimer);
        win.clearTimeout(state.photoTimer);
        state.clockTimer = 0;
        state.photoTimer = 0;
        root.classList.add('is-suspended');
        return true;
      }

      root.classList.remove('is-suspended');
      // Whatever happened while we were parked (a band edge, a new day, a folder
      // dropped on the desktop) lands in one visible tick.
      syncClock();
      scheduleClock();
      if (state.config.slideshow) scheduleSlide();
      return false;
    }

    /**
     * Host / page control: `livelyPropertyListener('suspend', true)`,
     * `DynaWall.setSuspended(true)` and `document.visibilitychange` all land here.
     * Returns the state that applies right now.
     */
    function setSuspended(paused) {
      state.hostSuspended = Boolean(paused);
      return applySuspension();
    }

    function render(options) {
      const animate = !options || options.animate !== false;
      applyTheme();
      applyTypography();
      applySubtitle();
      applySlideshow();
      state.period = getGreetingPeriod(new Date());
      setGreeting(buildGreeting(state.config.firstName, state.period), animate);
    }

    /** Re-evaluate the period; cross-fades only when the greeting changes. */
    function checkGreetingPeriod() {
      const period = getGreetingPeriod(new Date());
      if (period === state.period) return false;
      state.period = period;
      setGreeting(buildGreeting(state.config.firstName, period), true);
      return true;
    }

    /** Re-evaluate the palette; CSS cross-fades it when the band changes. */
    function checkTheme() {
      if (resolveTheme(new Date()) === state.theme) return false;
      applyTheme();
      // `photoSync` hangs the photo pool off the same band, so the clock crossing
      // an edge hands the slideshow the matching photos in the same tick.
      applySlideshow();
      return true;
    }

    /** Everything the clock owns, re-read at once (interval, wake, focus). */
    function syncClock() {
      const themeChanged = checkTheme();
      const greetingChanged = checkGreetingPeriod();
      return themeChanged || greetingChanged;
    }

    /** Arrays (the photo list) compare by value, everything else by identity. */
    function sameValue(current, next) {
      if (Array.isArray(current) && Array.isArray(next)) {
        return current.length === next.length && current.every((item, index) => item === next[index]);
      }
      return current === next;
    }

    /** Apply host updates: re-render, cross-fade, and cache for cold starts. */
    function applyUpdates(updates) {
      if (!updates || updates.length === 0) return;

      const next = Object.assign({}, state.config);
      const cache = {};
      const touched = {};
      let changed = false;

      updates.forEach((update) => {
        if (!update) return;
        const field = update.field;
        if (!Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, field)) return;
        touched[field] = true;
        if (sameValue(next[field], update.value)) return;
        next[field] = update.value;
        cache[field] = update.value;
        changed = true;
      });

      // A colour arriving on its own (Lively's colour picker, a hand-edited cache)
      // pins `custom`, exactly like a colour that was there at load time.
      if (touched.bgColor && !touched.theme && next.theme !== 'custom') {
        next.theme = 'custom';
        cache.theme = 'custom';
        changed = true;
      }

      if (!changed) return;
      state.config = next;
      persistConfig(cache, storage);
      render({ animate: true });
    }

    function playEntrance() {
      const reveal = function () {
        elements.content.classList.add('is-loaded');
        // Palette cross-fades arm only once the wallpaper has settled: the first
        // band of a cold start must land instantly instead of fading in from the
        // band the previous launch left behind.
        doc.documentElement.classList.add('is-theme-ready');
      };

      if (typeof win.requestAnimationFrame === 'function') {
        win.requestAnimationFrame(function () {
          win.requestAnimationFrame(reveal);
        });
      }
      win.setTimeout(reveal, 200); // safety net for throttled frames
    }

    function start() {
      const startedAt = new Date().getTime();
      render({ animate: false });
      playEntrance();

      // A suspended start (an occluded desktop, a sleeping display) must not arm
      // anything; the host's request may even have arrived before the app existed.
      applySuspension();
      scheduleClock();

      // Timers throttle while hidden, and an occluded desktop should not animate at
      // all: park everything on the way out and resync on the way back in.
      doc.addEventListener('visibilitychange', applySuspension);

      win.addEventListener('focus', function () {
        if (state.suspended) return;
        syncClock();
        scheduleClock();
        // Like a phone coming back to life: a fresh photo after sleep or resume.
        // The focus that lands with the initial page load is not a "resume".
        if (new Date().getTime() - startedAt > FOCUS_GRACE_MS) advancePhoto();
      });
    }

    return {
      state: state,
      render: render,
      start: start,
      applyUpdates: applyUpdates,
      setSuspended: setSuspended,
      checkGreetingPeriod: checkGreetingPeriod,
      checkTheme: checkTheme,
      syncClock: syncClock,
      advancePhoto: advancePhoto,
      // Host action (menu bar "Next photo", `livelyPropertyListener`).
      nextPhoto: nextPhoto
    };
  }

  /* ----------------------------------------------------------------------- *
   * Host bridges (Lively Wallpaper / Wallpaper Engine)
   * ------------------------------------------------------------------------ */

  /**
   * Momentary host commands: they carry no value, they ask the page to do
   * something. Kept apart from LIVELY_FIELDS so `nextPhoto` never lands in the
   * configuration (and never gets cached in localStorage).
   */
  const LIVELY_ACTIONS = Object.freeze({ nextPhoto: 'nextPhoto' });
  /**
   * The live "stand still / carry on" flag hosts send around occlusion, display
   * sleep, a locked session or the menu bar's Pause button. Also not a setting.
   */
  const LIVELY_SUSPEND = 'suspend';

  let appRef = null;
  /** The widget controller, or `null` when the page has no satellites to wire. */
  let widgetsRef = null;
  const pendingUpdates = [];
  const pendingActions = [];
  /** A host may suspend the wallpaper before the app exists (document-start). */
  let pendingSuspended = null;

  /**
   * Host / page control for suspension. Before the app exists the request is
   * parked, so an occluded, sleeping or locked start still boots at 0 FPS.
   */
  function setSuspended(paused) {
    const next = Boolean(paused);
    if (appRef) return appRef.setSuspended(next);
    pendingSuspended = next;
    return next;
  }

  /** Feed host updates into the app, or queue them until it is ready. */
  function deliver(updates) {
    if (!updates || updates.length === 0) return;
    if (appRef) {
      appRef.applyUpdates(updates);
      return;
    }
    pendingUpdates.push(...updates);
  }

  function isLivelyAction(name) {
    if (typeof name !== 'string') return false;
    return ownLookup(LIVELY_ACTIONS, name.trim()) !== undefined;
  }

  /** Run a host action now, or park it until the app exists. */
  function runAction(name) {
    if (!appRef) {
      pendingActions.push(name);
      return false;
    }
    return name === LIVELY_ACTIONS.nextPhoto ? appRef.nextPhoto() : false;
  }

  function installBridges(win) {
    // Lively Wallpaper: window.livelyPropertyListener(name, value)
    win.livelyPropertyListener = function livelyPropertyListener(name, value) {
      // A command, not a setting: hosts fire this on a button or a shortcut.
      if (isLivelyAction(name)) {
        runAction(name.trim());
        return;
      }
      // The suspension flag is also momentary: it must never be cached, and an
      // occluded desktop must be able to drop to 0 FPS before the app exists.
      if (typeof name === 'string' && name.trim().toLowerCase() === LIVELY_SUSPEND) {
        const paused = parseBoolean(value);
        if (paused !== undefined) setSuspended(paused);
        return;
      }
      const update = mapLivelyProperty(name, value);
      if (update) deliver([update]);
    };

    // Wallpaper Engine: window.wallpaperPropertyListener.applyUserProperties(properties)
    win.wallpaperPropertyListener = {
      applyUserProperties: function (properties) {
        deliver(mapWallpaperEngineProperties(properties));
      }
    };
  }

  /** YouTube Music stations — searches, because YouTube Music has no public API. */
  const MUSIC_STATIONS = Object.freeze([
    Object.freeze({ title: 'Deep focus', meta: 'Instrumental mixes for long work', query: 'deep focus' }),
    Object.freeze({ title: 'Lo-fi beats', meta: 'Slow, warm, no vocals', query: 'lofi beats' }),
    Object.freeze({ title: 'Coding mode', meta: 'Synth, house and driving beats', query: 'coding playlist' }),
    Object.freeze({ title: 'Jazz in the background', meta: 'Standards and café trios', query: 'jazz background' }),
    Object.freeze({ title: 'Piano and rain', meta: 'Quiet keys for reading', query: 'piano rain' })
  ]);

  /** The Google News desks the card offers; `''` is the front page itself. */
  const NEWS_DESKS = Object.freeze([
    Object.freeze({ title: 'Top stories', meta: 'The front page as Google ranks it', query: '' }),
    Object.freeze({ title: 'Technology', meta: 'Hardware, software and the industry', query: 'technology' }),
    Object.freeze({ title: 'World', meta: 'Global reporting as it lands', query: 'world news' }),
    Object.freeze({ title: 'Business', meta: 'Markets, deals and the economy', query: 'business' }),
    Object.freeze({ title: 'Science', meta: 'Space, climate and research', query: 'science' })
  ]);

  /**
   * Weather glyphs, as SVG path data in a 24×24 box.
   *
   * Inline paths rather than four image files: the card must render the same in a
   * host with no network, no extra request and no second asset to keep in sync.
   */
  const WEATHER_GLYPHS = Object.freeze({
    clear:
      '<circle cx="12" cy="12" r="4.1"/>' +
      '<path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6"/>',
    partly:
      '<circle cx="8.1" cy="8.2" r="2.9"/>' +
      '<path d="M8.1 2.6v1.5M2.6 8.2h1.5M4.2 4.3l1 1M12.1 4.3l-1 1"/>' +
      '<path d="M17.9 19.6H9.6a4.3 4.3 0 0 1 .4-8.6 5.4 5.4 0 0 1 10.2 1.5 3.6 3.6 0 0 1-2.3 7.1Z"/>',
    cloud:
      '<path d="M17.4 18.6H9.1a6.6 6.6 0 1 1 6.3-8.5h2a4.3 4.3 0 0 1 0 8.5Z"/>',
    rain:
      '<path d="M17.4 15.6H9.1a6.6 6.6 0 1 1 6.3-8.5h2a4.3 4.3 0 0 1 0 8.5Z"/>' +
      '<path d="M9 19l-1 2M13 19l-1 2M17 19l-1 2"/>',
    snow:
      '<path d="M17.4 15.6H9.1a6.6 6.6 0 1 1 6.3-8.5h2a4.3 4.3 0 0 1 0 8.5Z"/>' +
      '<path d="M9 19v2M8.1 19.5l1.8 1M9.9 19.5l-1.8 1M15 19v2M14.1 19.5l1.8 1M15.9 19.5l-1.8 1"/>',
    fog:
      '<path d="M17.4 14.6H9.1a6.6 6.6 0 1 1 6.3-8.5h2a4.3 4.3 0 0 1 0 8.5Z"/>' +
      '<path d="M5 20h14M8 22.5h8"/>',
    storm:
      '<path d="M17.4 15H9.1a6.6 6.6 0 1 1 6.3-8.5h2a4.3 4.3 0 0 1 0 8.5Z"/>' +
      '<path d="M13.4 17.5l-3 3.5h3l-1.4 3"/>'
  });

  /**
   * Six cities the weather card can be pointed at with one click.
   *
   * The native desktop never gives the page the keyboard — the wallpaper window is not
   * allowed to become key, which is what keeps every keystroke going to the app you are
   * actually using — so a card that could only be pointed at a place by typing would be
   * a dead end there. Coordinates come from the same geocoder the search uses, so a
   * picked city and a searched one are the same shape.
   */
  const WEATHER_CITIES = Object.freeze([
    Object.freeze({
      name: 'London',
      region: 'England',
      country: 'United Kingdom',
      latitude: 51.5074,
      longitude: -0.1278
    }),
    Object.freeze({
      name: 'New York',
      region: 'New York',
      country: 'United States',
      latitude: 40.7128,
      longitude: -74.006
    }),
    Object.freeze({
      name: 'San Francisco',
      region: 'California',
      country: 'United States',
      latitude: 37.7749,
      longitude: -122.4194
    }),
    Object.freeze({
      name: 'São Paulo',
      region: 'São Paulo',
      country: 'Brazil',
      latitude: -23.5505,
      longitude: -46.6333
    }),
    Object.freeze({
      name: 'Tokyo',
      region: 'Tokyo',
      country: 'Japan',
      latitude: 35.6895,
      longitude: 139.6917
    }),
    Object.freeze({
      name: 'Sydney',
      region: 'New South Wales',
      country: 'Australia',
      latitude: -33.8688,
      longitude: 151.2093
    })
  ]);

  /** The arrow that marks a row as leaving the wallpaper for the browser. */
  const ARROW_MARKUP =
    '<svg class="widget-row-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>';

  function weatherGlyphMarkup(name) {
    const paths = WEATHER_GLYPHS[name] || WEATHER_GLYPHS.cloud;
    return '<svg class="widget-weather-glyph" viewBox="0 0 24 24" aria-hidden="true">' + paths + '</svg>';
  }

  /* ----------------------------------------------------------------------- *
   * Widget controller
   * ------------------------------------------------------------------------ */

  /**
   * Wire the four satellites to the frosted card.
   *
   * One controller for every provider, because the parts that matter — which card
   * is open, who had focus, where the native host may take a click, Escape and
   * click-outside — are shared. The providers below only paint into the card body.
   *
   * Returns `null` when the page has no satellites at all (an older index.html, a
   * host page that stripped them): a wallpaper without widgets is still a
   * wallpaper, and the greeting must not fail because of a missing button.
   */
  function createWidgets(win, doc) {
    const bar = doc.getElementById('widget-bar');
    const backdrop = doc.getElementById('widget-backdrop');
    const modal = doc.getElementById('widget-modal');
    const body = doc.getElementById('widget-modal-body');
    const titleNode = doc.getElementById('widget-modal-title');
    const captionNode = doc.getElementById('widget-modal-caption');
    const badgeNode = doc.getElementById('widget-modal-badge');
    const closeNode = doc.getElementById('widget-modal-close');
    if (!bar || !backdrop || !modal || !body || !titleNode || !closeNode) return null;

    const buttons = Array.prototype.slice.call(bar.querySelectorAll('.widget-btn'));
    if (buttons.length === 0) return null;

    const storage = getStorage(win);
    const state = {
      activeId: '',
      lastFocus: null,
      hitFrame: 0,
      weather: {
        place: readWeatherPlace(storage),
        unit: readWeatherUnit(storage),
        data: null,
        // idle · empty · searching · choosing · loading · ready · error
        status: 'idle',
        error: '',
        query: '',
        matches: [],
        fetchedAt: 0,
        token: 0
      }
    };

    function widgetById(id) {
      for (let index = 0; index < WIDGETS.length; index += 1) {
        if (WIDGETS[index].id === id) return WIDGETS[index];
      }
      return null;
    }

    function el(tag, className, text) {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined && text !== null) node.textContent = String(text);
      return node;
    }

    /** A row of text under a micro label; `label` is optional. */
    function section(label, child) {
      const wrapper = el('section', 'widget-section');
      if (label) wrapper.appendChild(el('p', 'widget-label', label));
      if (child) wrapper.appendChild(child);
      return wrapper;
    }

    function note(text) {
      return el('p', 'widget-note', text);
    }

    /** The loading/empty/error line: same box, so a failed fetch does not resize the card. */
    function stateRow(text, options) {
      const settings = options || {};
      const row = el('p', 'widget-state' + (settings.error ? ' widget-state--error' : ''));
      if (settings.busy) row.appendChild(el('span', 'widget-spinner'));
      row.appendChild(el('span', null, text));
      return row;
    }

    /**
     * A row that opens `url` in the default browser. The page never navigates
     * itself, and the arrow is the promise that the destination is elsewhere.
     */
    function actionRow(title, meta, url) {
      const button = el('button', 'widget-row');
      button.type = 'button';
      const text = el('span', 'widget-row-text');
      text.appendChild(el('span', 'widget-row-title', title));
      if (meta) text.appendChild(el('span', 'widget-row-meta', meta));
      button.appendChild(text);
      button.insertAdjacentHTML('beforeend', ARROW_MARKUP);
      button.addEventListener('click', function () {
        openExternal(win, url);
      });
      return button;
    }

    function rowList(rows) {
      const list = el('div', 'widget-rows');
      rows.forEach(function (row) {
        list.appendChild(row);
      });
      return list;
    }

    /* --- native hit-testing ------------------------------------------------ */

    /**
     * Tell the host where the page is willing to take a click.
     *
     * The wallpaper window ignores the mouse entirely (`ignoresMouseEvents` on
     * macOS, a click-through desktop layer on Windows), which is what keeps Finder
     * drag-select, right-click, desktop icons and Mission Control working. That also
     * means the page never sees the cursor, so it cannot notice a hover by itself:
     * the host watches the pointer and only needs the rectangles that should
     * intercept a click. They travel as viewport CSS pixels, inflated by
     * `HIT_PADDING` so the rim of a button — and its 0.3 rem drift — does not
     * flicker in and out.
     *
     * While a card is open the whole viewport is reported, because the backdrop is
     * itself a click target: clicking anywhere outside the card closes it.
     */
    function publishHitRegions() {
      const handlers = win.webkit && win.webkit.messageHandlers;
      const webkit = handlers && handlers.dynawallInteractivity;
      const webview = win.chrome && win.chrome.webview;
      const webview2 = webview && typeof webview.postMessage === 'function';
      if (!webkit && !webview2) return;

      const open = Boolean(state.activeId);
      const width = win.innerWidth || 0;
      const height = win.innerHeight || 0;
      const regions = [];

      if (open) {
        regions.push([0, 0, width, height]);
      } else {
        buttons.forEach(function (button) {
          const rect = button.getBoundingClientRect();
          if (!rect || rect.width <= 0 || rect.height <= 0) return;
          regions.push([
            rect.left - HIT_PADDING,
            rect.top - HIT_PADDING,
            rect.width + HIT_PADDING * 2,
            rect.height + HIT_PADDING * 2
          ]);
        });
      }

      const payload = { open: open, width: width, height: height, regions: regions };
      if (webkit) {
        try {
          webkit.postMessage(payload);
        } catch (error) {
          /* A page that lost its host mid-flight has nothing to tell. */
        }
      }
      if (webview2) {
        try {
          // WebView2 takes one message shape per channel, so the type rides along.
          webview.postMessage({
            type: 'dynawall:interactivity',
            open: open,
            width: width,
            height: height,
            regions: regions
          });
        } catch (error) {
          /* Same here. */
        }
      }
    }

    /**
     * Replay a click the host caught on our behalf.
     *
     * The desktop layer stays click-through, so the page never receives a real
     * pointer event; the host watches the mouse, keeps every click that belongs to
     * the desktop, and hands back the ones that land on a reported rectangle. The
     * point arrives in CSS pixels from the top-left of the viewport.
     */
    function clickAt(x, y) {
      const px = Number(x);
      const py = Number(y);
      if (!isFinite(px) || !isFinite(py)) return false;
      if (!doc || typeof doc.elementFromPoint !== 'function') return false;

      const node = doc.elementFromPoint(px, py);
      if (!node || typeof node.dispatchEvent !== 'function') return false;

      // A synthetic click has no default action: focus the control by hand, so a
      // field in the weather card takes the keystrokes the host forwards and the
      // arrow keys still walk the link rows.
      if (typeof node.focus === 'function') {
        try {
          node.focus({ preventScroll: true });
        } catch (error) {
          /* Older WebKit rejects the options bag; focusing is not load-bearing. */
        }
      }

      const init = { bubbles: true, cancelable: true, clientX: px, clientY: py, view: win };
      let event;
      if (typeof win.MouseEvent === 'function') {
        event = new win.MouseEvent('click', init);
      } else {
        event = doc.createEvent('MouseEvents');
        event.initMouseEvent(
          'click', true, true, win, 1, px, py, px, py, false, false, false, false, 0, null
        );
      }
      node.dispatchEvent(event);
      return true;
    }

    function scheduleHitRegions() {
      if (state.hitFrame) return;
      const defer =
        typeof win.requestAnimationFrame === 'function'
          ? win.requestAnimationFrame
          : function (callback) {
              return win.setTimeout(callback, 16);
            };
      state.hitFrame = defer(function () {
        state.hitFrame = 0;
        publishHitRegions();
      });
    }

    /* --- open & close ------------------------------------------------------ */

    /** The satellite's own glyph, cloned into the card header. */
    function badgeMarkupFor(id) {
      for (let index = 0; index < buttons.length; index += 1) {
        const button = buttons[index];
        if (button.getAttribute('data-widget') !== id) continue;
        const glyph = button.querySelector('svg');
        return glyph ? glyph.outerHTML : '';
      }
      return '';
    }

    function openWidget(id) {
      const widget = widgetById(id);
      if (!widget) return false;
      if (state.activeId === id) return true;

      state.activeId = id;
      state.lastFocus = doc.activeElement;

      titleNode.textContent = widget.title;
      if (captionNode) captionNode.textContent = widget.caption;
      if (badgeNode) badgeNode.innerHTML = badgeMarkupFor(id);
      buttons.forEach(function (button) {
        button.setAttribute(
          'aria-expanded',
          button.getAttribute('data-widget') === id ? 'true' : 'false'
        );
      });

      backdrop.classList.add('is-open');
      backdrop.setAttribute('aria-hidden', 'false');
      renderWidget(id);
      scheduleHitRegions();

      // The dialog itself takes focus: Tab then starts at the close button and a
      // screen reader announces the card before its contents.
      try {
        modal.focus({ preventScroll: true });
      } catch (error) {
        try {
          modal.focus();
        } catch (ignored) {
          /* A host that refuses focus; the card still works with the mouse. */
        }
      }
      return true;
    }

    function closeWidget() {
      if (!state.activeId) return false;
      state.activeId = '';
      backdrop.classList.remove('is-open');
      backdrop.setAttribute('aria-hidden', 'true');
      buttons.forEach(function (button) {
        button.setAttribute('aria-expanded', 'false');
      });
      // A closed card must not keep a fetched forecast, a half-typed city or a
      // focused field in the heap: the body is rebuilt on the next open.
      clearBody();
      scheduleHitRegions();

      const previous = state.lastFocus;
      state.lastFocus = null;
      if (previous && typeof previous.focus === 'function') {
        try {
          previous.focus({ preventScroll: true });
        } catch (error) {
          try {
            previous.focus();
          } catch (ignored) {
            /* Nothing left to restore. */
          }
        }
      }
      return true;
    }

    function clearBody() {
      while (body.firstChild) body.removeChild(body.firstChild);
    }

    /* --- keyboard & focus -------------------------------------------------- */

    /** Keep Tab inside the open card: nothing behind it is reachable while it is up. */
    function trapFocus(event) {
      const focusables = Array.prototype.slice
        .call(
          modal.querySelectorAll(
            'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
          )
        )
        .filter(function (node) {
          return node.offsetParent !== null || node === doc.activeElement;
        });
      if (focusables.length === 0) return;

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = doc.activeElement;
      const inside = modal.contains(active);

      if (event.shiftKey && (active === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !inside)) {
        event.preventDefault();
        first.focus();
      }
    }

    function onKeyDown(event) {
      if (!state.activeId) return;
      const key = event.key;
      if (key === 'Escape' || key === 'Esc') {
        event.preventDefault();
        closeWidget();
        return;
      }
      if (key === 'Tab') trapFocus(event);
    }

    /* --- providers --------------------------------------------------------- */

    function renderWidget(id) {
      clearBody();
      if (id === 'music') renderMusic();
      else if (id === 'news') renderNews();
      else if (id === 'youtube') renderYouTube();
      else if (id === 'weather') renderWeather();
    }

    function renderMusic() {
      body.appendChild(
        section(
          'Stations',
          rowList(
            MUSIC_STATIONS.map(function (station) {
              return actionRow(station.title, station.meta, buildYouTubeMusicSearchUrl(station.query));
            })
          )
        )
      );
      body.appendChild(
        section(
          'Library',
          rowList([
            actionRow('Open YouTube Music', 'music.youtube.com', YOUTUBE_MUSIC_HOME),
            actionRow(
              'Liked music',
              'Everything you have thumbed up',
              withQuery(YOUTUBE_MUSIC_HOME + 'playlist', { list: 'LM' })
            )
          ])
        )
      );
      body.appendChild(
        note(
          'YouTube Music publishes no API and ships no embeddable player, so a station opens in your browser. The wallpaper never frames YouTube or loads its artwork.'
        )
      );
    }

    function renderNews() {
      body.appendChild(
        section(
          'Desks',
          rowList(
            NEWS_DESKS.map(function (desk) {
              return actionRow(desk.title, desk.meta, buildGoogleNewsUrl(desk.query));
            })
          )
        )
      );
      body.appendChild(
        note(
          'Google publishes no News API, and its RSS feed cannot be read from a local page, so each desk opens today’s Google News page in your browser rather than imitating a reader.'
        )
      );
    }

    function youtubeSearchForm() {
      const form = el('form', 'widget-field');
      const input = el('input', 'widget-input');
      input.type = 'search';
      input.placeholder = 'Search YouTube';
      input.setAttribute('aria-label', 'Search YouTube');
      input.setAttribute('autocomplete', 'off');
      input.spellcheck = false;

      const submit = el('button', 'widget-submit', 'Search');
      submit.type = 'submit';

      form.appendChild(input);
      form.appendChild(submit);
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        const term = clipText(input.value, MAX_WIDGET_TEXT);
        if (!term) {
          input.focus();
          return;
        }
        openExternal(win, buildYouTubeSearchUrl(term));
      });
      return form;
    }

    function renderYouTube() {
      const region = regionCodeFromLocale(win.navigator ? win.navigator.language : '');
      body.appendChild(
        section(
          'Jump to',
          rowList([
            actionRow(
              'Trending now',
              'What YouTube is pushing in your region',
              buildYouTubeTrendingUrl(region)
            ),
            actionRow('Music', 'Charts, videos and live sessions', buildYouTubeSearchUrl('music')),
            actionRow('Live', 'Streams happening right now', buildYouTubeSearchUrl('live')),
            actionRow('Watch later', 'Your saved queue', YOUTUBE_HOME + 'playlist?list=WL')
          ])
        )
      );
      body.appendChild(section('Search', youtubeSearchForm()));
      body.appendChild(
        note(
          'Playback happens in your browser: a YouTube player embedded in a local page is refused by the player itself, so a card that claimed to play here would only ever fail.'
        )
      );
    }

    /* --- weather ----------------------------------------------------------- */

    function placeLabel(place) {
      if (!place) return '';
      return [place.name, place.region, place.country].filter(Boolean).join(' · ');
    }

    /**
     * The weather card — the only provider with a request of its own, and it runs
     * when the card is opened: never on load, never on a timer. The place and the
     * unit belong to the user and live in localStorage; the forecast itself is kept
     * for ten minutes in memory, so flipping between cards does not re-ask.
     */
    function renderWeather() {
      const weather = state.weather;
      const wrapper = el('div', 'widget-weather');

      if (weather.status === 'searching') {
        wrapper.appendChild(stateRow('Looking for “' + weather.query + '”…', { busy: true }));
      } else if (weather.status === 'loading') {
        wrapper.appendChild(stateRow('Reading the sky…', { busy: true }));
      } else if (weather.status === 'error') {
        wrapper.appendChild(stateRow(weather.error, { error: true }));
        if (weather.place) {
          const retry = el('button', 'widget-submit', 'Try again');
          retry.type = 'button';
          retry.addEventListener('click', function () {
            loadWeather(true);
          });
          wrapper.appendChild(retry);
        }
      } else if (weather.data && weather.place) {
        wrapper.appendChild(weatherNow(weather.data));
        wrapper.appendChild(el('p', 'widget-weather-place', placeLabel(weather.place)));
        wrapper.appendChild(metricGrid(weather.data));
        wrapper.appendChild(hourStrip(weather.data));
      } else if (weather.place) {
        wrapper.appendChild(stateRow('No forecast for ' + placeLabel(weather.place) + ' yet.'));
      } else {
        wrapper.appendChild(stateRow('Search for a city to see its weather.'));
      }

      wrapper.appendChild(weather.status === 'choosing' ? placeChoices() : weatherSearchForm());
      // A place has to be pickable without a keyboard: the native desktop never lets
      // the page take focus, so nothing can be typed into the field above.
      if (!weather.place && weather.status !== 'choosing') {
        wrapper.appendChild(section('Popular cities', placeRowList(WEATHER_CITIES)));
      }
      wrapper.appendChild(unitChips());
      wrapper.appendChild(weatherFootnote());
      body.appendChild(wrapper);

      // First open with a saved place: ask now, and never again while it is fresh.
      if (weather.status === 'idle') loadWeather(false);
    }

    function loadWeather(force) {
      const weather = state.weather;
      if (!weather.place) {
        weather.status = 'empty';
        return false;
      }

      const fresh = weather.data && Date.now() - weather.fetchedAt < WEATHER_FRESH_MS;
      if (fresh && !force) {
        weather.status = 'ready';
        if (state.activeId === 'weather') renderWidget('weather');
        return false;
      }

      const token = (weather.token += 1);
      weather.status = 'loading';
      weather.error = '';
      weather.matches = [];
      if (state.activeId === 'weather') renderWidget('weather');

      fetchJson(win, buildWeatherForecastUrl(weather.place), WEATHER_TIMEOUT_MS)
        .then(function (payload) {
          if (token !== weather.token) return;
          const data = parseWeatherPayload(payload, { unit: weather.unit });
          if (data) {
            weather.data = data;
            weather.fetchedAt = Date.now();
            weather.status = 'ready';
          } else {
            // A closed card still keeps whatever arrived, so reopening is instant.
            weather.status = 'error';
            weather.error = 'The forecast service returned something unexpected.';
          }
          if (state.activeId === 'weather') renderWidget('weather');
        })
        .catch(function (error) {
          if (token !== weather.token) return;
          weather.status = 'error';
          weather.error = describeFetchError(error);
          if (state.activeId === 'weather') renderWidget('weather');
        });
      return true;
    }

    function searchPlaces(rawName) {
      const name = clipText(rawName, 80);
      if (!name) return false;

      const weather = state.weather;
      const token = (weather.token += 1);
      weather.status = 'searching';
      weather.query = name;
      weather.error = '';
      weather.matches = [];
      if (state.activeId === 'weather') renderWidget('weather');

      fetchJson(win, buildGeocodingUrl(name), WEATHER_TIMEOUT_MS)
        .then(function (payload) {
          if (token !== weather.token) return;
          const places = parseGeocodingResults(payload);
          if (places.length === 0) {
            weather.status = 'error';
            weather.error = 'No place called “' + name + '”. Try the country as well.';
          } else if (places.length === 1) {
            selectPlace(places[0]);
            return;
          } else {
            weather.matches = places;
            weather.status = 'choosing';
          }
          if (state.activeId === 'weather') renderWidget('weather');
        })
        .catch(function (error) {
          if (token !== weather.token) return;
          weather.status = 'error';
          weather.error = describeFetchError(error);
          if (state.activeId === 'weather') renderWidget('weather');
        });
      return true;
    }

    function selectPlace(place) {
      const weather = state.weather;
      weather.place = place;
      weather.matches = [];
      weather.query = '';
      weather.data = null;
      weather.fetchedAt = 0;
      writeWeatherPlace(storage, place);
      loadWeather(true);
    }

    function weatherNow(data) {
      const now = el('div', 'widget-weather-now');
      now.insertAdjacentHTML('beforeend', weatherGlyphMarkup(data.glyph));

      const reading = el('div', 'widget-weather-reading');
      reading.appendChild(el('span', 'widget-weather-temp', data.temperature));
      reading.appendChild(el('span', 'widget-weather-summary', data.label));
      reading.appendChild(
        el(
          'span',
          'widget-weather-summary',
          'Feels like ' + data.apparent + ' · H ' + data.high + ' / L ' + data.low
        )
      );
      now.appendChild(reading);
      return now;
    }

    function metricGrid(data) {
      const grid = el('div', 'widget-weather-metrics');
      [
        ['Humidity', data.humidity],
        ['Wind', data.wind],
        ['Rain', data.rain]
      ].forEach(function (pair) {
        const cell = el('div', 'widget-metric');
        cell.appendChild(el('span', 'widget-metric-value', pair[1]));
        cell.appendChild(el('span', 'widget-metric-label', pair[0]));
        grid.appendChild(cell);
      });
      return grid;
    }

    function hourStrip(data) {
      const strip = el('div', 'widget-hours');
      data.hours.forEach(function (hour) {
        const cell = el('div', 'widget-hour' + (hour.isNow ? ' is-now' : ''));
        cell.title = hour.hour + ' · ' + hour.label;
        cell.appendChild(el('span', null, hour.hour));
        cell.appendChild(el('span', 'widget-hour-temp', hour.temperature));
        cell.appendChild(el('span', null, hour.precipitation === null ? '' : hour.precipitation + '%'));
        strip.appendChild(cell);
      });
      return strip;
    }

    function weatherSearchForm() {
      const form = el('form', 'widget-field');
      const input = el('input', 'widget-input');
      input.type = 'search';
      input.placeholder = state.weather.place ? 'Another city' : 'City or town';
      input.setAttribute('aria-label', 'City or town');
      input.setAttribute('autocomplete', 'off');
      input.spellcheck = false;

      const submit = el('button', 'widget-submit', 'Find');
      submit.type = 'submit';

      form.appendChild(input);
      form.appendChild(submit);
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        searchPlaces(input.value);
      });
      return form;
    }

    function placeChoices() {
      return section('Places', placeRowList(state.weather.matches));
    }

    /** One clickable row per place: a searched one, or one from the starter list. */
    function placeRowList(places) {
      const list = el('div', 'widget-rows');
      places.forEach(function (place) {
        const button = el('button', 'widget-row');
        button.type = 'button';
        const text = el('span', 'widget-row-text');
        text.appendChild(el('span', 'widget-row-title', place.name));
        const meta = [place.region, place.country].filter(Boolean).join(' · ');
        if (meta) text.appendChild(el('span', 'widget-row-meta', meta));
        button.appendChild(text);
        button.addEventListener('click', function () {
          selectPlace(place);
        });
        list.appendChild(button);
      });
      return list;
    }

    function unitChips() {
      const chips = el('div', 'widget-chips');
      [
        ['celsius', 'Celsius'],
        ['fahrenheit', 'Fahrenheit']
      ].forEach(function (pair) {
        const chip = el('button', 'widget-chip', pair[1]);
        chip.type = 'button';
        chip.setAttribute('aria-pressed', state.weather.unit === pair[0] ? 'true' : 'false');
        chip.addEventListener('click', function () {
          if (state.weather.unit === pair[0]) return;
          state.weather.unit = pair[0];
          writeWeatherUnit(storage, pair[0]);
          // The cached readings are in the old unit; ask again rather than relabel.
          state.weather.fetchedAt = 0;
          loadWeather(true);
        });
        chips.appendChild(chip);
      });
      return section('Units', chips);
    }

    function weatherFootnote() {
      if (state.weather.data) {
        return note(
          'Open-Meteo · updated ' +
            relativeTime(state.weather.fetchedAt) +
            ' · the only request this wallpaper ever makes'
        );
      }
      return note('Forecast by Open-Meteo: keyless, free, and the only thing the wallpaper ever fetches.');
    }

    /* --- wiring ------------------------------------------------------------ */

    buttons.forEach(function (button) {
      button.addEventListener('click', function (event) {
        event.preventDefault();
        const id = button.getAttribute('data-widget') || '';
        if (state.activeId === id) {
          closeWidget();
          return;
        }
        openWidget(id);
      });
    });

    if (closeNode) {
      closeNode.addEventListener('click', function () {
        closeWidget();
      });
    }

    // Clicking the dimmed wallpaper outside the card closes it, like a native
    // panel; a click inside the card must not bubble out and dismiss it.
    backdrop.addEventListener('click', function (event) {
      if (event.target === backdrop) closeWidget();
    });
    modal.addEventListener('click', function (event) {
      event.stopPropagation();
    });

    doc.addEventListener('keydown', onKeyDown);
    win.addEventListener('resize', scheduleHitRegions);

    // The entrance slides and scales `.wallpaper-content` for 900 ms, so the
    // satellite rectangles measured before it settled sit a few pixels off.
    // Re-measure when that transition lands — once, not on every frame.
    const contentNode = doc.getElementById('content');
    if (contentNode) {
      contentNode.addEventListener('transitionend', function (event) {
        if (event.target === contentNode) scheduleHitRegions();
      });
    }
    scheduleHitRegions();

    return {
      /** `true` while a card is on screen. */
      isOpen: function () {
        return Boolean(state.activeId);
      },
      /** The id of the open card, or `''`. */
      activeId: function () {
        return state.activeId;
      },
      open: openWidget,
      close: closeWidget,
      clickAt: clickAt
    };
  }

  /* ----------------------------------------------------------------------- *
   * Exposed API (console debugging + headless verification)
   * ------------------------------------------------------------------------ */

  const DynaWall = Object.freeze({
    DEFAULT_CONFIG: DEFAULT_CONFIG,
    STORAGE_KEYS: STORAGE_KEYS,
    BUNDLED_PHOTOS: BUNDLED_PHOTOS,
    GOLDEN_GATE_PHOTOS: GOLDEN_GATE_PHOTOS,
    ABSTRACT_PHOTOS: ABSTRACT_PHOTOS,
    THEMES: THEMES,
    THEME_MODES: THEME_MODES,
    THEME_BG_HEX: THEME_BG_HEX,
    CLOCK_REFRESH_MS: CLOCK_REFRESH_MS,
    CLOCK_BOUNDARY_HOURS: CLOCK_BOUNDARY_HOURS,
    /** Alias kept for hosts and scripts written before the palette existed. */
    GREETING_REFRESH_MS: CLOCK_REFRESH_MS,
    TEXT_FADE_MS: TEXT_FADE_MS,
    PHOTO_FADE_MS: PHOTO_FADE_MS,
    LIVELY_ACTIONS: LIVELY_ACTIONS,
    LIVELY_SUSPEND: LIVELY_SUSPEND,
    getGreetingPeriod: getGreetingPeriod,
    getThemeSlot: getThemeSlot,
    msUntilNextClockBoundary: msUntilNextClockBoundary,
    buildGreeting: buildGreeting,
    normalizeName: normalizeName,
    parseBoolean: parseBoolean,
    normalizeColor: normalizeColor,
    normalizeTheme: normalizeTheme,
    normalizeSlideshowInterval: normalizeSlideshowInterval,
    DEFAULT_FONT_FAMILY: DEFAULT_FONT_FAMILY,
    BUNDLED_FONT_FAMILIES: BUNDLED_FONT_FAMILIES,
    normalizeFontFamily: normalizeFontFamily,
    normalizeCustomFont: normalizeCustomFont,
    fontStack: fontStack,
    photoBasename: photoBasename,
    classifyPhotos: classifyPhotos,
    getPhotosForSlot: getPhotosForSlot,
    resolvePhotoBand: resolvePhotoBand,
    stepPhotoIndex: stepPhotoIndex,
    isLivelyAction: isLivelyAction,
    /** Skip to the next photo from a console or a host script. */
    nextPhoto: function () {
      return runAction(LIVELY_ACTIONS.nextPhoto);
    },
    /** Park or restore every timer/animation (occlusion, sleep, lock, Pause). */
    setSuspended: function (paused) {
      return setSuspended(paused);
    },
    normalizePhotos: normalizePhotos,
    parseQueryParams: parseQueryParams,
    readStoredConfig: readStoredConfig,
    readSeed: readSeed,
    persistConfig: persistConfig,
    resolveConfig: resolveConfig,
    mapLivelyProperty: mapLivelyProperty,
    mapWallpaperEngineProperties: mapWallpaperEngineProperties,

    /* Widgets. The catalogue, the hosts the popups are allowed to name, and the
       pure half of every provider — URL building and payload parsing — so the
       headless tests can check them without a DOM or a network. */
    WIDGETS: WIDGETS,
    WIDGET_FETCH_HOSTS: WIDGET_FETCH_HOSTS,
    WIDGET_LINK_HOSTS: WIDGET_LINK_HOSTS,
    WIDGET_REMOTE_HOSTS: WIDGET_REMOTE_HOSTS,
    WEATHER_FRESH_MS: WEATHER_FRESH_MS,
    WMO_CONDITIONS: WMO_CONDITIONS,
    MUSIC_STATIONS: MUSIC_STATIONS,
    NEWS_DESKS: NEWS_DESKS,
    WEATHER_CITIES: WEATHER_CITIES,
    WEATHER_GLYPHS: WEATHER_GLYPHS,
    clipText: clipText,
    withQuery: withQuery,
    buildYouTubeMusicSearchUrl: buildYouTubeMusicSearchUrl,
    buildYouTubeSearchUrl: buildYouTubeSearchUrl,
    buildYouTubeTrendingUrl: buildYouTubeTrendingUrl,
    buildGoogleNewsUrl: buildGoogleNewsUrl,
    buildWeatherForecastUrl: buildWeatherForecastUrl,
    buildGeocodingUrl: buildGeocodingUrl,
    normalizeTemperatureUnit: normalizeTemperatureUnit,
    regionCodeFromLocale: regionCodeFromLocale,
    describeWmoCode: describeWmoCode,
    formatTemperature: formatTemperature,
    hourLabel: hourLabel,
    relativeTime: relativeTime,
    indexOfHour: indexOfHour,
    parseWeatherPayload: parseWeatherPayload,
    parseGeocodingResults: parseGeocodingResults,
    readWeatherPlace: readWeatherPlace,
    writeWeatherPlace: writeWeatherPlace,
    readWeatherUnit: readWeatherUnit,
    writeWeatherUnit: writeWeatherUnit,
    openExternal: openExternal,

    /** Open a card from the console or from a host script. */
    openWidget: function (id) {
      return widgetsRef ? widgetsRef.open(id) : false;
    },
    /** Close whatever card is open. */
    closeWidget: function () {
      return widgetsRef ? widgetsRef.close() : false;
    },
    /**
     * The host's way in: replay a click at viewport CSS pixels (`x`, `y`).
     *
     * Both desktop hosts keep the wallpaper click-through — the desktop owns the
     * mouse — so a click on a satellite is caught outside the page and handed back
     * here.
     */
    clickAt: function (x, y) {
      return widgetsRef ? widgetsRef.clickAt(x, y) : false;
    }
  });

  global.DynaWall = DynaWall;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = DynaWall;
  }

  /* ----------------------------------------------------------------------- *
   * Bootstrap
   * ------------------------------------------------------------------------ */

  function bootstrap() {
    const start = function () {
      const app = createApp(window, document);
      app.start();
      appRef = app;
      installBridges(window);

      // The satellites are wired after the wallpaper itself is running: a card must
      // never be able to stop the greeting, so a failure here leaves a perfectly
      // good wallpaper with four inert buttons instead of a blank screen.
      try {
        widgetsRef = createWidgets(window, document);
      } catch (error) {
        widgetsRef = null;
      }

      // The seed is folded into the configuration above; drop the global so the
      // snapshot does not sit in the heap for the lifetime of the wallpaper.
      try {
        delete window.__dynawallSeed;
      } catch (error) {
        window.__dynawallSeed = undefined;
      }

      if (pendingSuspended !== null) {
        app.setSuspended(pendingSuspended);
        pendingSuspended = null;
      }
      if (pendingUpdates.length > 0) {
        app.applyUpdates(pendingUpdates.splice(0, pendingUpdates.length));
      }
      // Commands that arrived before the page was ready (a host that fires
      // `nextPhoto` on load) run once the app exists.
      pendingActions.splice(0, pendingActions.length).forEach(runAction);
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  }

  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    bootstrap();
  }
})(typeof window !== 'undefined' ? window : globalThis);
