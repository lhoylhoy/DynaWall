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
 * Desktop widgets: the four satellites (music, news, YouTube, weather) are settings like
 * any other — `widgets` for all of them, on by default, plus one flag each
 * (`widgetMusic`, `widgetNews`, `widgetYouTube`, `widgetWeather`) — so the macOS popover,
 * the Windows window, Lively, Wallpaper Engine and `?widgets=false` / `?music=false` can
 * take them, or any one of them, off the desktop. A satellite that is off is `hidden`:
 * never placed, never measured, never reported as a click region and its card cannot be
 * opened, which hands that part of the desktop back to the Finder.
 *
 * Beside them sits the user's own half of the orbit: a `+` that opens the service
 * manager and any number of custom shortcuts (ChatGPT, GitHub, …), each a bare glyph
 * dealt into the same ring. A shortcut is not a card — it is handed to the default
 * browser through `openExternal` — and the list is cached in `localStorage`
 * (`dynawall.customServices`) because it is the user's, not the host's.
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
    // The four desktop satellites (music, news, YouTube, weather). On by default, and
    // off is a real setting rather than a broken page: with a satellite off nothing is
    // placed for it, nothing drifts and no click region is reported to the host, so the
    // desktop underneath belongs to the Finder again. `widgets` is the master switch;
    // the four below take one satellite off on its own, and the master restores exactly
    // the set the user had picked.
    widgets: true,
    widgetMusic: true,
    widgetNews: true,
    widgetYouTube: true,
    widgetWeather: true,
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
    // Whether the four desktop satellites are on the wallpaper at all.
    widgets: 'dynawall.widgets',
    // …and which of them are: one flag per satellite.
    widgetMusic: 'dynawall.widgetMusic',
    widgetNews: 'dynawall.widgetNews',
    widgetYouTube: 'dynawall.widgetYouTube',
    widgetWeather: 'dynawall.widgetWeather',
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
      case 'widgets':
      case 'widgetMusic':
      case 'widgetNews':
      case 'widgetYouTube':
      case 'widgetWeather':
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
    widgets: 'widgets',
    satellites: 'widgets',
    // One satellite at a time: `?music=false`, or the field name itself.
    music: 'widgetMusic',
    widgetmusic: 'widgetMusic',
    news: 'widgetNews',
    widgetnews: 'widgetNews',
    youtube: 'widgetYouTube',
    widgetyoutube: 'widgetYouTube',
    weather: 'widgetWeather',
    widgetweather: 'widgetWeather',
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
    // The four desktop satellites: every host's "Desktop widgets" switch, and one
    // checkbox per satellite beside it.
    widgets: 'widgets',
    widgetMusic: 'widgetMusic',
    widgetNews: 'widgetNews',
    widgetYouTube: 'widgetYouTube',
    widgetWeather: 'widgetWeather',
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
    customfont: 'customFont',
    widgets: 'widgets',
    widgetmusic: 'widgetMusic',
    widgetnews: 'widgetNews',
    widgetyoutube: 'widgetYouTube',
    widgetweather: 'widgetWeather'
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
   * The four satellites on the wallpaper. `id` is the `data-widget` of the button in
   * index.html and the key of a renderer below; `title`/`caption` are the card
   * header. A test asserts the markup and this list agree.
   */
  const WIDGETS = Object.freeze([
    Object.freeze({ id: 'music', title: 'YouTube Music', caption: 'Stations and mixes' }),
    Object.freeze({ id: 'news', title: 'Google News', caption: 'Today’s front page, by desk' }),
    Object.freeze({ id: 'youtube', title: 'YouTube', caption: 'Trending, or a search' }),
    Object.freeze({ id: 'weather', title: 'Weather', caption: 'Now, and the next hours' })
  ]);

  /**
   * Which configuration field shows or hides each satellite.
   *
   * A satellite is the user's to keep: the four switches in the macOS popover, the
   * Windows window, Lively and Wallpaper Engine are four ordinary booleans, so hiding
   * YouTube costs nothing in any host and survives a reload in `localStorage`. A test
   * asserts every id in `WIDGETS` has a field, a storage key and both manifest entries.
   */
  const WIDGET_FIELDS = Object.freeze({
    music: 'widgetMusic',
    news: 'widgetNews',
    youtube: 'widgetYouTube',
    weather: 'widgetWeather'
  });

  /**
   * The five configuration fields that decide what is on the desktop: the master switch
   * and one flag per satellite. `applyUpdates()` watches exactly these.
   */
  const WIDGET_SETTING_FIELDS = Object.freeze(
    ['widgets'].concat(
      WIDGETS.map(function (widget) {
        return WIDGET_FIELDS[widget.id];
      })
    )
  );

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

  /**
   * The width at which style.css stops scattering the satellites and docks them in
   * one row along the bottom of the screen. The media query lives in style.css and
   * this is the same number: script.js has to stop writing positions at exactly the
   * width where the CSS stops honouring them.
   */
  const WIDGET_NARROW_QUERY = '(max-width: 720px)';

  /**
   * How the satellites sit around the greeting: `WIDGET_CLEARANCE_REM` of air between
   * the type and the nearest satellite, and `WIDGET_REACH_REM` of room further out for
   * them to drift into. Together those two bounds are the ring they are thrown around;
   * the angle and the distance inside it are what is random. `WIDGET_REACH_RATIO` widens
   * that room with the greeting itself — the rem alone would leave the satellites glued
   * to the type on a 4K screen, where the greeting is most of the wallpaper wide.
   */
  const WIDGET_CLEARANCE_REM = 3;
  const WIDGET_REACH_REM = 8;
  const WIDGET_REACH_RATIO = 0.16;

  /**
   * A tiny deterministic PRNG (mulberry32).
   *
   * The scatter has to be repeatable — the same seed must deal the same arrangement —
   * both so a window resize does not reshuffle the desktop and so the headless tests
   * can hold the placement rules to account without a DOM.
   */
  function createRandom(seed) {
    let state = Number(seed) >>> 0 || 0x9e3779b9;
    return function random() {
      state = (state + 0x6d2b79f5) >>> 0;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** How far two rects overlap once each is padded by `padding`; `<= 0` means clear. */
  function overlapDepth(first, second, padding) {
    const pad = Number(padding) || 0;
    return Math.min(
      Math.min(first.right + pad - second.left, second.right + pad - first.left),
      Math.min(first.bottom + pad - second.top, second.bottom + pad - first.top)
    );
  }

  /**
   * Scatter `count` satellites of `size` px around the greeting.
   *
   * The satellites belong to the greeting, not to the screen. Each one is thrown out
   * from the text block along a random ray — a random angle, then a random distance
   * between `clearance` px of air and `reach` px further out — so the four land in a
   * loose ring around the type. That is what makes the wallpaper look dealt rather
   * than laid out while keeping the four together: a satellite that wandered off into
   * an empty corner stops reading as part of the composition.
   *
   * The block they orbit is the union of the `avoid` rects (the greeting and the
   * subtitle, in viewport pixels) — the satellites have to keep off those anyway, so
   * they are the same thing. Three rules keep a hand playable: no two satellites may
   * come within `gap` px of each other, none may break the ring, and no quadrant of the
   * ring may take more than half of them, so the greeting never ends up with every
   * satellite piled on one side. Where a candidate cannot satisfy all of that, the one
   * with the most air around it wins; a wallpaper with no room for a ring at all falls
   * back to an even spread of the safe area.
   *
   * `margin` keeps the satellites off the screen edges; `inset`
   * (`{ top, right, bottom, left }`) overrides an edge on its own, which the bottom
   * one needs — the wallpaper runs behind the Dock and the Windows taskbar, and a
   * satellite there would be invisible and unclickable.
   *
   * Returns `[{ x, y }]` — the top-left corner of each satellite, in order.
   */
  function scatterWidgets(options) {
    const settings = options || {};
    const width = Number(settings.width) || 0;
    const height = Number(settings.height) || 0;
    const size = Math.max(1, Number(settings.size) || 0);
    const count = Math.max(0, Math.floor(Number(settings.count) || 0));
    const margin = Math.max(0, Number(settings.margin) || 0);
    const gap = Math.max(0, Number(settings.gap) || 0);
    const clearance = Math.max(0, Number(settings.clearance) || 0);
    const reach = Math.max(0, Number(settings.reach) || 0);
    const random = createRandom(settings.seed);
    const attempts = 60;
    const cap = Math.max(2, Math.ceil(count / 2));

    const inset = settings.inset || {};
    const edge = function (value) {
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 ? number : margin;
    };

    /** How far along a ray an axis reaches `bounds`; `Infinity` when it never does. */
    const rayLimit = function (origin, bounds, ray) {
      if (ray > 0) return (bounds.max - origin) / ray;
      if (ray < 0) return (bounds.min - origin) / ray;
      return Infinity;
    };

    // The halo the satellites must clear, and the block they orbit — the union of the
    // text rects, which is the greeting plus its subtitle.
    const avoid = [];
    let block = null;
    (settings.avoid || []).forEach(function (box) {
      if (!box) return;
      const boxWidth = Number(box.width) || 0;
      const boxHeight = Number(box.height) || 0;
      if (boxWidth <= 0 || boxHeight <= 0) return;
      const x = Number(box.x) || 0;
      const y = Number(box.y) || 0;
      avoid.push({
        left: x - clearance,
        top: y - clearance,
        right: x + boxWidth + clearance,
        bottom: y + boxHeight + clearance
      });
      if (!block) {
        block = { left: x, top: y, right: x + boxWidth, bottom: y + boxHeight };
        return;
      }
      block.left = Math.min(block.left, x);
      block.top = Math.min(block.top, y);
      block.right = Math.max(block.right, x + boxWidth);
      block.bottom = Math.max(block.bottom, y + boxHeight);
    });

    // Where a satellite's centre is allowed: the viewport inside the insets, minus half
    // a satellite. With no greeting to orbit, its middle is the centre of the ring.
    const xBounds = {
      min: edge(inset.left) + size / 2,
      max: Math.max(edge(inset.left) + size / 2, width - edge(inset.right) - size / 2)
    };
    const yBounds = {
      min: edge(inset.top) + size / 2,
      max: Math.max(edge(inset.top) + size / 2, height - edge(inset.bottom) - size / 2)
    };
    const centreX = block ? (block.left + block.right) / 2 : (xBounds.min + xBounds.max) / 2;
    const centreY = block ? (block.top + block.bottom) / 2 : (yBounds.min + yBounds.max) / 2;
    // The ring, measured to the satellite's own edge: half the text block, `clearance`
    // of air and half a satellite — so a ray that stops at the ring leaves a rect that
    // is exactly `clearance` from the type, and one that travels `reach` further is that
    // much further out again.
    const ringX = (block ? (block.right - block.left) / 2 : 0) + clearance + size / 2;
    const ringY = (block ? (block.bottom - block.top) / 2 : 0) + clearance + size / 2;
    // A ring needs its centre on screen: a text block larger than the wallpaper leaves
    // nothing to orbit, and the plain spread takes over.
    const orbits =
      centreX >= xBounds.min &&
      centreX <= xBounds.max &&
      centreY >= yBounds.min &&
      centreY <= yBounds.max;

    const placed = [];
    const counts = [0, 0, 0, 0];
    const points = [];

    for (let index = 0; index < count; index += 1) {
      let best = null;
      let bestDepth = Infinity;
      let bestQuadrant = 0;

      for (let attempt = 0; attempt < attempts; attempt += 1) {
        let satelliteX;
        let satelliteY;

        if (orbits) {
          // Throw the satellite out along a random ray: it leaves the halo where the ray
          // crosses it, then travels up to `reach` further out — or to the edge of the
          // screen, whichever comes first.
          const angle = random() * Math.PI * 2;
          const rayX = Math.cos(angle);
          const rayY = Math.sin(angle);
          const haloDistance = Math.min(
            rayX === 0 ? Infinity : ringX / Math.abs(rayX),
            rayY === 0 ? Infinity : ringY / Math.abs(rayY)
          );
          const screenDistance = Math.min(
            rayLimit(centreX, xBounds, rayX),
            rayLimit(centreY, yBounds, rayY)
          );
          if (screenDistance <= haloDistance && attempt < attempts - 1) continue;

          const travel = Math.max(0, Math.min(reach, screenDistance - haloDistance));
          const distance = haloDistance + random() * travel;
          satelliteX = centreX + rayX * distance;
          satelliteY = centreY + rayY * distance;
        } else {
          satelliteX = xBounds.min + random() * (xBounds.max - xBounds.min);
          satelliteY = yBounds.min + random() * (yBounds.max - yBounds.min);
        }

        // Floating point can leave the safe box by a hair; CSS pixels cannot.
        satelliteX = Math.min(Math.max(satelliteX, xBounds.min), xBounds.max);
        satelliteY = Math.min(Math.max(satelliteY, yBounds.min), yBounds.max);

        const quadrant = (satelliteX < centreX ? 0 : 1) + (satelliteY < centreY ? 0 : 2);
        if (counts[quadrant] >= cap && attempt < attempts - 1) continue;

        const rect = {
          left: satelliteX - size / 2,
          top: satelliteY - size / 2,
          right: satelliteX + size / 2,
          bottom: satelliteY + size / 2
        };
        let depth = 0;
        avoid.forEach(function (box) {
          depth = Math.max(depth, overlapDepth(rect, box, 0));
        });
        placed.forEach(function (box) {
          depth = Math.max(depth, overlapDepth(rect, box, gap));
        });
        if (depth < bestDepth) {
          bestDepth = depth;
          best = rect;
          bestQuadrant = quadrant;
        }
        if (depth <= 0) break;
      }

      counts[bestQuadrant] += 1;
      placed.push(best);
      points.push({ x: best.left, y: best.top });
    }

    return points;
  }

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

  /* ----------------------------------------------------------------------- *
   * Custom services — the user's own satellites
   *
   * A shortcut is a title, a plain `https` address and the mark it wears in the
   * orbit. It is not a host setting — there is no popover switch for "ChatGPT" — so
   * the list lives in `localStorage` under one key and is edited on the wallpaper
   * itself, through the orbit's `+`. Everything below is pure: the page, the card
   * and the headless tests all use the same validation, so the address the manager
   * accepts and the address `openExternal` is handed can never disagree.
   * ------------------------------------------------------------------------ */

  /**
   * Where the shortcuts are cached.
   *
   * Deliberately outside `STORAGE_KEYS`: that map is the one-to-one mirror of the
   * configuration fields (`dynawall.firstName` …) that a host control can push, and a
   * JSON array is not one of those. The value is a JSON array of `{ title, url, icon }`.
   */
  const CUSTOM_SERVICES_KEY = 'dynawall.customServices';

  /** How many shortcuts the ring holds before it stops reading as a constellation. */
  const MAX_CUSTOM_SERVICES = 16;

  /** Longest service name the card prints and the satellite's tooltip carries. */
  const MAX_SERVICE_TITLE = 40;

  /**
   * The reserved card id of the manager, beside `music`, `news`, `youtube` and
   * `weather`. It is never a `data-widget` value in index.html: the manager is not a
   * satellite, it is the way to add one.
   */
  const SERVICE_MANAGER_ID = 'services';

  /**
   * The curated marks, in the same bare line-art language as the four built-in
   * satellites: a 24×24 box, stroked, no fill, no plate.
   *
   * `hints` are the words a title or an address may contain — never a host name, so
   * this catalogue can never become a second, drifting list of the remote hosts the
   * policy allows. A service that matches nothing wears a two-letter monogram instead
   * (`serviceMonogram`), which is why there is no catch-all entry at the end.
   */
  const SERVICE_ICONS = Object.freeze([
    Object.freeze({
      id: 'git',
      label: 'Git',
      hints: Object.freeze(['github', 'gitlab', 'bitbucket', 'git']),
      paths:
        '<circle cx="7" cy="6.5" r="2.5"/><circle cx="7" cy="17.5" r="2.5"/>' +
        '<circle cx="17" cy="9.5" r="2.5"/><path d="M7 9v6M9.5 6.5h3a2 2 0 0 1 2 2v.5"/>'
    }),
    Object.freeze({
      id: 'sparkle',
      label: 'Assistant',
      hints: Object.freeze([
        'chatgpt',
        'openai',
        'claude',
        'anthropic',
        'gemini',
        'copilot',
        'perplexity',
        'midjourney'
      ]),
      paths:
        '<path d="M11 3.5l1.8 5 5 1.8-5 1.8L11 17.1l-1.8-5-5-1.8 5-1.8Z"/>' +
        '<path d="M18 15.2l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7Z"/>'
    }),
    Object.freeze({
      id: 'wave',
      label: 'Music',
      hints: Object.freeze(['spotify', 'soundcloud', 'tidal', 'deezer', 'music', 'audio']),
      paths: '<path d="M4 10.5v3M8 7.5v9M12 9.5v5M16 6.5v11M20 10.5v3"/>'
    }),
    Object.freeze({
      id: 'talk',
      label: 'Chat',
      hints: Object.freeze([
        'reddit',
        'discord',
        'slack',
        'whatsapp',
        'telegram',
        'signal',
        'messenger',
        'chat',
        'threads',
        'mastodon'
      ]),
      paths:
        '<path d="M4 5.5h16v10H9.5L4 20Z"/>' +
        '<path d="M8.7 10.5h.01M12 10.5h.01M15.3 10.5h.01"/>'
    }),
    Object.freeze({
      id: 'play',
      label: 'Video',
      hints: Object.freeze([
        'twitch',
        'youtube',
        'netflix',
        'vimeo',
        'plex',
        'video',
        'stream',
        'hulu',
        'disney'
      ]),
      paths: '<circle cx="12" cy="12" r="8.5"/><path d="M10.2 8.6 16.2 12l-6 3.4Z"/>'
    }),
    Object.freeze({
      id: 'page',
      label: 'Document',
      hints: Object.freeze([
        'notion',
        'docs',
        'drive',
        'dropbox',
        'notes',
        'wiki',
        'confluence',
        'obsidian',
        'evernote'
      ]),
      paths:
        '<path d="M6.5 3.5h7l4 4v13h-11Z"/><path d="M13.5 3.5v4h4"/>' +
        '<path d="M9.5 12h6M9.5 15.5h4"/>'
    }),
    Object.freeze({
      id: 'mail',
      label: 'Mail',
      hints: Object.freeze(['gmail', 'mail', 'inbox', 'outlook', 'proton', 'fastmail']),
      paths:
        '<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/>' +
        '<path d="M4.5 7.5 12 13l7.5-5.5"/>'
    }),
    Object.freeze({
      id: 'calendar',
      label: 'Calendar',
      hints: Object.freeze(['calendar', 'calendly', 'agenda', 'scheduler', 'cron']),
      paths:
        '<rect x="3.5" y="5.5" width="17" height="15" rx="2.5"/>' +
        '<path d="M8 3.5v4M16 3.5v4M3.5 10.5h17"/>'
    }),
    Object.freeze({
      id: 'code',
      label: 'Code',
      hints: Object.freeze([
        'code',
        'stackoverflow',
        'gitpod',
        'vercel',
        'netlify',
        'railway',
        'supabase',
        'postman'
      ]),
      paths: '<path d="M9 8.5 4.5 12 9 15.5M15 8.5 19.5 12 15 15.5M13.5 6l-3 12"/>'
    }),
    Object.freeze({
      id: 'pen',
      label: 'Design',
      hints: Object.freeze([
        'figma',
        'canva',
        'dribbble',
        'behance',
        'design',
        'sketch',
        'framer',
        'miro'
      ]),
      paths: '<path d="M4.5 19.5 6 14l8.5-8.5a2.1 2.1 0 0 1 3 3L9 17Z"/><path d="M13 6.5l4 4"/>'
    }),
    Object.freeze({
      id: 'camera',
      label: 'Photos',
      hints: Object.freeze(['instagram', 'photos', 'flickr', 'pics', 'unsplash', 'pinterest']),
      paths:
        '<rect x="3.5" y="6.5" width="17" height="13" rx="3"/><circle cx="12" cy="13" r="3.6"/>' +
        '<path d="M8.5 6.5 10 4h4l1.5 2.5"/>'
    }),
    Object.freeze({
      id: 'globe',
      label: 'Web',
      hints: Object.freeze([
        'maps',
        'earth',
        'globe',
        'weather',
        'travel',
        'airbnb',
        'booking',
        'wikipedia'
      ]),
      paths:
        '<circle cx="12" cy="12" r="8.5"/>' +
        '<path d="M3.5 12h17M12 3.5c2.6 2.4 2.6 14.6 0 17M12 3.5c-2.6 2.4-2.6 14.6 0 17"/>'
    })
  ]);

  /** The little × on a service row: the one destructive control in the card. */
  const REMOVE_MARKUP =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>';

  /** Text → markup, so a service's name never carries a tag into the card. */
  function escapeMarkup(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * A service address, or `''`.
   *
   * Only a plain `https` address with a host survives: the shortcut is handed straight
   * to the operating system's browser, so `javascript:`, `file:` and an app scheme must
   * not get through a paste — and neither must a `user:password@` pair, because a
   * wallpaper has no business storing credentials. `URL` does the boring half, so what
   * is cached is exactly what the browser will be asked to open.
   */
  function normalizeServiceUrl(rawValue) {
    if (typeof rawValue !== 'string') return '';
    const text = rawValue.trim();
    if (!text || text.length > 2048) return '';
    let parsed;
    try {
      parsed = new URL(text);
    } catch (error) {
      return '';
    }
    if (parsed.protocol !== 'https:') return '';
    if (!parsed.hostname) return '';
    if (parsed.username || parsed.password) return '';
    return parsed.href;
  }

  /** The host an address names, lowercased and without its `www.`. */
  function serviceHostName(url) {
    let parsed;
    try {
      parsed = new URL(String(url || ''));
    } catch (error) {
      return '';
    }
    return String(parsed.hostname || '')
      .replace(/^www\./i, '')
      .toLowerCase();
  }

  /** `github.com` → `Github.com`: the name an address suggests for itself. */
  function serviceHostLabel(url) {
    const host = serviceHostName(url);
    if (!host) return '';
    return host.charAt(0).toUpperCase() + host.slice(1);
  }

  /** The curated entry for an id, or `null` when the catalogue has no such mark. */
  function serviceIconById(id) {
    const key = String(id || '').trim().toLowerCase();
    if (!key) return null;
    for (let index = 0; index < SERVICE_ICONS.length; index += 1) {
      if (SERVICE_ICONS[index].id === key) return SERVICE_ICONS[index];
    }
    return null;
  }

  /** The curated mark a title/address pair suggests, or `''` for a monogram. */
  function serviceIconId(title, url) {
    const haystack = (String(title || '') + ' ' + String(url || '')).toLowerCase();
    if (!haystack.trim()) return '';
    for (let index = 0; index < SERVICE_ICONS.length; index += 1) {
      const icon = SERVICE_ICONS[index];
      for (let hint = 0; hint < icon.hints.length; hint += 1) {
        if (haystack.indexOf(icon.hints[hint]) !== -1) return icon.id;
      }
    }
    return '';
  }

  /** A stored icon id, or `''` when it names nothing in the catalogue. */
  function normalizeServiceIcon(value) {
    const icon = serviceIconById(value);
    return icon ? icon.id : '';
  }

  /** The SVG markup for a curated mark; `''` when there is none. */
  function serviceIconMarkup(iconId) {
    const icon = serviceIconById(iconId);
    if (!icon) return '';
    return (
      '<svg class="widget-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      icon.paths +
      '</svg>'
    );
  }

  /**
   * A two-letter mark for a service with no curated glyph.
   *
   * "GitHub" → "GH" (the capitals it already carries), "My Notes" → "MN" (one letter per
   * word), "Figma" → "FI", and an unnamed service falls back to its first host label.
   */
  function serviceMonogram(title, url) {
    const words = String(title || '')
      .replace(/[^A-Za-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
    if (words.length >= 2) return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
    const word =
      words.length === 1 ? words[0] : serviceHostName(url).split('.')[0].replace(/[^A-Za-z0-9]/g, '');
    if (!word) return '';
    const capitals = word.match(/[A-Z]/g) || [];
    if (capitals.length >= 2) return capitals.slice(0, 2).join('');
    return word.slice(0, 2).toUpperCase();
  }

  /** The mark a service wears: its curated glyph, or its initials in the same ink. */
  function serviceGlyphMarkup(service) {
    const icon = serviceIconMarkup(service && service.icon);
    if (icon) return icon;
    const monogram = serviceMonogram(service && service.title, service && service.url);
    return '<span class="widget-monogram">' + escapeMarkup(monogram) + '</span>';
  }

  /**
   * One shortcut from its parts, or `null` when the address is not one we will open.
   *
   * `id` comes from the list position rather than from storage: it is the handle the
   * card's buttons carry, and the whole list is rebuilt whenever it changes, so a
   * shortcut can never collide with another one's id.
   */
  function createCustomService(title, url, options) {
    const opts = options || {};
    const href = normalizeServiceUrl(url);
    if (!href) return null;
    const name = clipText(title, MAX_SERVICE_TITLE) || serviceHostLabel(href);
    if (!name) return null;
    const index = Math.floor(Number(opts.index));
    return {
      id: 'service-' + (index > 0 ? index : 1),
      title: name,
      url: href,
      icon: normalizeServiceIcon(opts.icon) || serviceIconId(name, href)
    };
  }

  /**
   * A stored list, made safe: a JSON string or an array in, clean records out.
   *
   * An entry that is not an `https` address is dropped rather than repaired,
   * duplicates collapse to the first mention (the same site twice would deal two
   * identical glyphs), and the list is capped at `MAX_CUSTOM_SERVICES` because the ring
   * only has room for so many before it stops being a constellation. Hand-edited or
   * half-written JSON is simply no shortcuts — never a broken wallpaper.
   */
  function normalizeCustomServices(rawValue) {
    let list = rawValue;
    if (typeof list === 'string') {
      if (!list.trim()) return [];
      try {
        list = JSON.parse(list);
      } catch (error) {
        return [];
      }
    }
    if (!Array.isArray(list)) return [];

    const services = [];
    const seen = Object.create(null);
    for (let index = 0; index < list.length; index += 1) {
      if (services.length >= MAX_CUSTOM_SERVICES) break;
      const entry = list[index];
      if (!entry || typeof entry !== 'object') continue;
      const service = createCustomService(entry.title, entry.url, {
        icon: entry.icon,
        index: services.length + 1
      });
      if (!service || seen[service.url]) continue;
      seen[service.url] = true;
      services.push(service);
    }
    return services;
  }

  /** The cached shape: title, address and the chosen mark (`''` means "match it"). */
  function serializeCustomServices(services) {
    const list = Array.isArray(services) ? services.slice(0, MAX_CUSTOM_SERVICES) : [];
    return JSON.stringify(
      list
        .map(function (service) {
          return {
            title: clipText(service && service.title, MAX_SERVICE_TITLE),
            url: normalizeServiceUrl(service && service.url),
            icon: normalizeServiceIcon(service && service.icon)
          };
        })
        .filter(function (entry) {
          return entry.url !== '' && entry.title !== '';
        })
    );
  }

  /** The shortcuts cached on this machine, or `[]` when there are none (or no storage). */
  function readCustomServices(storage) {
    if (!storage || typeof storage.getItem !== 'function') return [];
    let raw = null;
    try {
      raw = storage.getItem(CUSTOM_SERVICES_KEY);
    } catch (error) {
      return []; // storage can be blocked (private mode, disabled cookies)
    }
    if (raw === null) return [];
    return normalizeCustomServices(raw);
  }

  /** Cache the list. Best-effort: a blocked `localStorage` is not a broken wallpaper. */
  function writeCustomServices(storage, services) {
    if (!storage || typeof storage.setItem !== 'function') return false;
    try {
      storage.setItem(CUSTOM_SERVICES_KEY, serializeCustomServices(services));
      return true;
    } catch (error) {
      return false;
    }
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

      // The satellites are not the greeting's to rebuild: hand the switches to the widget
      // controller, which knows how to hide, unplace, dismiss and re-deal them.
      if (widgetsRef && WIDGET_SETTING_FIELDS.some(function (field) { return touched[field]; })) {
        widgetsRef.applyConfig(next);
      }
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
   * `options.config` is the resolved configuration: the master `widgets` switch and the
   * four per-satellite flags decide what is on the desktop from the first frame, and
   * `applyConfig()` keeps it in step with every later push.
   *
   * Returns `null` when the page has no satellites at all (an older index.html, a
   * host page that stripped them): a wallpaper without widgets is still a
   * wallpaper, and the greeting must not fail because of a missing button.
   */
  function createWidgets(win, doc, options) {
    const bar = doc.getElementById('widget-bar');
    const backdrop = doc.getElementById('widget-backdrop');
    const modal = doc.getElementById('widget-modal');
    const body = doc.getElementById('widget-modal-body');
    const titleNode = doc.getElementById('widget-modal-title');
    const captionNode = doc.getElementById('widget-modal-caption');
    const badgeNode = doc.getElementById('widget-modal-badge');
    const closeNode = doc.getElementById('widget-modal-close');
    if (!bar || !backdrop || !modal || !body || !titleNode || !closeNode) return null;

    // The four built-in satellites are the ones the markup declares; the shortcuts are
    // created from `localStorage` below, and the `+` is the one orbit button that has no
    // `data-widget` (it opens the manager instead of a card of its own).
    const buttons = Array.prototype.slice.call(bar.querySelectorAll('.widget-btn[data-widget]'));
    if (buttons.length === 0) return null;
    const addButton = doc.getElementById('widget-btn-add');
    const serviceButtons = [];

    const storage = getStorage(win);
    const config = (options && options.config) || {};
    const state = {
      // The satellites' master switch. Off means "not on this desktop": nothing is
      // placed, nothing is reported as clickable and the page holds no card.
      enabled: config.widgets !== false,
      // Whether the first deal has happened yet: the initial `applyConfig()` call sets
      // the per-satellite flags up before anything is measured, so it must not deal.
      started: false,
      activeId: '',
      lastFocus: null,
      hitFrame: 0,
      revealed: false,
      textObserver: null,
      // The user's own shortcuts: read once from `localStorage`, then owned here. The
      // draft and the message belong to the manager card, so a half-typed address and a
      // validation line survive the card re-rendering under them.
      services: readCustomServices(storage),
      serviceError: '',
      serviceDraft: { title: '', url: '' },
      // One arrangement per page load: the wallpaper is dealt a fresh constellation
      // every time it starts, and keeps it until the desktop changes shape.
      seed: Math.floor(Math.random() * 0xfffffffe) + 1,
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

    function buttonById(id) {
      for (let index = 0; index < buttons.length; index += 1) {
        if (buttons[index].getAttribute('data-widget') === id) return buttons[index];
      }
      return null;
    }

    /**
     * The built-in satellites on the desktop right now; `hidden` is the settings' doing.
     *
     * Shortcuts and the `+` are not in here: they have no `data-widget`, because a widget
     * id is what the per-satellite switches and the host report are keyed on.
     */
    function visibleBuiltins() {
      return buttons.filter(function (button) {
        return !button.hidden;
      });
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

    /* --- custom services --------------------------------------------------- */

    /** Every element in the orbit: the built-ins, the shortcuts and the `+`. */
    function orbitElements() {
      const elements = buttons.concat(serviceButtons);
      if (addButton) elements.push(addButton);
      return elements;
    }

    /** The orbit elements on the desktop right now; `hidden` is the settings' doing. */
    function placedButtons() {
      return orbitElements().filter(function (button) {
        return !button.hidden;
      });
    }

    /** A shortcut's satellite: a bare glyph in the ring, exactly like a built-in one. */
    function createServiceButton(service) {
      const button = el('button', 'widget-btn widget-btn-service');
      button.type = 'button';
      button.id = 'widget-btn-' + service.id;
      button.setAttribute('data-service', service.id);
      button.title = service.title;
      button.setAttribute('aria-label', 'Open ' + service.title + ' in your browser');

      // The drift is per-satellite: every shortcut breathes out of step with its
      // neighbours, from values derived from its place in the list, so the orbit looks
      // the same on every load instead of reshuffling.
      const position = serviceButtons.length;
      const phase = (position * 3.7) % 13;
      const driftX = (position % 2 === 0 ? 1 : -1) * (0.12 + (position % 3) * 0.02);
      const driftY = (position % 3 === 0 ? 1 : -1) * (0.24 + (position % 4) * 0.03);
      button.style.setProperty('--widget-drift-delay', '-' + phase.toFixed(1) + 's');
      button.style.setProperty('--widget-drift-x', driftX.toFixed(2) + 'rem');
      button.style.setProperty('--widget-drift-y', driftY.toFixed(2) + 'rem');

      button.innerHTML = serviceGlyphMarkup(service);
      button.addEventListener('click', function (event) {
        event.preventDefault();
        // A shortcut is not a card: it leaves for the default browser through the same
        // native bridge the cards' link rows use, so the wallpaper never loads the site.
        openExternal(win, service.url);
      });
      return button;
    }

    /** Rebuild the shortcut satellites from `state.services`, in list order. */
    function rebuildServiceButtons() {
      while (serviceButtons.length > 0) {
        const stale = serviceButtons.pop();
        if (stale.parentNode) stale.parentNode.removeChild(stale);
      }
      state.services.forEach(function (service) {
        const button = createServiceButton(service);
        bar.insertBefore(button, addButton || null);
        serviceButtons.push(button);
      });
    }

    /**
     * Adopt a new list: cache it, rebuild the ring and deal the satellites again.
     *
     * The manager card is rebuilt in place when it is the card that asked, so a
     * delete disappears from the list the moment it is pressed and the ring closes the
     * gap behind it.
     */
    function commitServices(next) {
      state.services = next.slice(0, MAX_CUSTOM_SERVICES);
      writeCustomServices(storage, state.services);
      rebuildServiceButtons();
      if (state.activeId === SERVICE_MANAGER_ID) renderWidget(SERVICE_MANAGER_ID);
      scatter();
      if (state.activeId === SERVICE_MANAGER_ID) refocusManagerField();
      return state.services;
    }

    /** Add a shortcut from the card or a host script; `null` when it cannot be added. */
    function addService(title, url) {
      if (state.services.length >= MAX_CUSTOM_SERVICES) return null;
      const service = createCustomService(title, url, { index: state.services.length + 1 });
      if (!service) return null;
      const duplicate = state.services.some(function (existing) {
        return existing.url === service.url;
      });
      if (duplicate) return null;
      commitServices(state.services.concat([service]));
      return service;
    }

    /** Forget one shortcut. Returns whether the list changed. */
    function removeService(id) {
      const next = state.services.filter(function (service) {
        return service.id !== id;
      });
      if (next.length === state.services.length) return false;
      commitServices(next);
      return true;
    }

    /** Put the caret back in the first field after the card rebuilt itself. */
    function refocusManagerField() {
      const field = body.querySelector('.widget-input');
      if (!field || typeof field.focus !== 'function') return;
      try {
        field.focus({ preventScroll: true });
      } catch (error) {
        try {
          field.focus();
        } catch (ignored) {
          /* A host that refuses focus; the card still works with the mouse. */
        }
      }
    }

    /* --- placement --------------------------------------------------------- */

    /** The root font size, so the scatter's air scales with the wallpaper's type. */
    function rem() {
      const styles = win.getComputedStyle ? win.getComputedStyle(doc.documentElement) : null;
      const size = styles ? parseFloat(styles.fontSize) : 0;
      return size > 0 ? size : 16;
    }

    /** The greeting and the subtitle in viewport pixels: the satellites keep off them. */
    function textRects() {
      const rects = [];
      ['greeting', 'subtitle'].forEach(function (id) {
        const node = doc.getElementById(id);
        if (!node) return;
        const rect = node.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) return;
        rects.push({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
      });
      return rects;
    }

    /** The satellites' footprint in CSS pixels; `0` until the browser has laid them out. */
    function satelliteSize() {
      const elements = orbitElements();
      for (let index = 0; index < elements.length; index += 1) {
        const size = elements[index].offsetWidth;
        if (size > 0) return size;
      }
      return 0;
    }

    function isNarrow() {
      return typeof win.matchMedia === 'function' && win.matchMedia(WIDGET_NARROW_QUERY).matches;
    }

    /** Fade the orbit in once, after it has been placed. */
    function reveal() {
      if (state.revealed) return;
      state.revealed = true;
      const defer =
        typeof win.requestAnimationFrame === 'function'
          ? win.requestAnimationFrame
          : function (callback) {
              return win.setTimeout(callback, 16);
            };
      defer(function () {
        bar.classList.add('is-placed');
      });
    }

    /**
     * Deal the satellites a hand.
     *
     * Once per page load, then again only when the wallpaper changes shape: a window
     * resize re-deals from the same seed, so the new viewport gets an arrangement
     * with the same character rather than a reshuffle. Below the breakpoint style.css
     * docks them in a row, and no inline position is written at all — the properties
     * are removed and the media query decides.
     *
     * Switched off there is nothing to place (and no fade-in to arm), so the deal
     * waits until the master switch comes back on and `applyConfig()` calls it again.
     *
     * Only the satellites that are on the desktop are dealt: the ring is sized for the
     * set actually on screen, so hiding YouTube — or adding a shortcut — closes or opens
     * a gap instead of leaving one. The `+` is dealt with them, because it is a satellite
     * in everything but its click.
     */
    function scatter() {
      if (!state.enabled) return;

      reveal();

      const active = placedButtons();
      if (active.length === 0) {
        scheduleHitRegions();
        return;
      }

      if (isNarrow()) {
        orbitElements().forEach(function (button) {
          button.style.removeProperty('--widget-x');
          button.style.removeProperty('--widget-y');
        });
        scheduleHitRegions();
        return;
      }

      const width = win.innerWidth || 0;
      const height = win.innerHeight || 0;
      const size = satelliteSize();
      if (width <= 0 || height <= 0 || size <= 0) return;

      const unit = rem();
      const rects = textRects();
      // The ring widens with the greeting, not just with the rem.
      const widest = rects.reduce(function (widestSoFar, rect) {
        return Math.max(widestSoFar, rect.width);
      }, 0);
      const points = scatterWidgets({
        width: width,
        height: height,
        size: size,
        count: active.length,
        margin: Math.round(unit * 2.5),
        // The bottom edge has further to give: the wallpaper runs behind the Dock on
        // macOS and the taskbar on Windows, and a satellite parked there would be
        // hidden at best and covered by another window at worst.
        inset: {
          top: Math.round(unit * 2.5),
          right: Math.round(unit * 2.5),
          bottom: Math.round(unit * 6.5),
          left: Math.round(unit * 2.5)
        },
        gap: Math.round(unit * 1.5),
        clearance: Math.round(unit * WIDGET_CLEARANCE_REM),
        reach: Math.round(Math.max(unit * WIDGET_REACH_REM, widest * WIDGET_REACH_RATIO)),
        avoid: rects,
        seed: state.seed
      });

      active.forEach(function (button, index) {
        const point = points[index];
        if (!point) return;
        button.style.setProperty('--widget-x', Math.round(point.x) + 'px');
        button.style.setProperty('--widget-y', Math.round(point.y) + 'px');
      });
      scheduleHitRegions();
    }

    /** `true` when a placed satellite has ended up inside the greeting's halo. */
    function coversText() {
      // A pixel of slack: the ring is allowed to touch its own edge, and the written
      // positions are rounded to whole CSS pixels.
      const clearance = Math.max(0, Math.round(rem() * WIDGET_CLEARANCE_REM) - 1);
      const rects = textRects();
      const elements = placedButtons();
      for (let index = 0; index < elements.length; index += 1) {
        const box = elements[index].getBoundingClientRect();
        if (!box || box.width <= 0) continue;
        const satellite = { left: box.left, top: box.top, right: box.right, bottom: box.bottom };
        for (let other = 0; other < rects.length; other += 1) {
          const text = rects[other];
          const padded = {
            left: text.x - clearance,
            top: text.y - clearance,
            right: text.x + text.width + clearance,
            bottom: text.y + text.height + clearance
          };
          if (overlapDepth(satellite, padded, 0) > 0) return true;
        }
      }
      return false;
    }

    /* --- native hit-testing ------------------------------------------------ */

    /**
     * Tell the host where the page is willing to take a click.
     *
     * While no card is up the wallpaper window ignores the mouse entirely
     * (`ignoresMouseEvents` on macOS, a click-through desktop layer on Windows), which is
     * what keeps Finder drag-select, right-click, desktop icons and Mission Control
     * working. That also means the page never sees the cursor, so it cannot notice a
     * hover by itself: the host watches the pointer and only needs the rectangles that
     * should intercept a click. They travel as viewport CSS pixels, inflated by
     * `HIT_PADDING` so the rim of a button — and its 0.3 rem drift — does not flicker in
     * and out.
     *
     * While a card is open the whole viewport is reported, because the backdrop is
     * itself a click target: clicking anywhere outside the card closes it. That report is
     * also what hands the display its mouse and keyboard on macOS — the host stops being
     * click-through for as long as a card is up, so the field under the pointer takes a
     * caret and the typing (and `Esc`, and `⌘V`) reaches the page.
     *
     * With the satellites switched off nothing is reported at all: the host then keeps
     * every click for the desktop, which is exactly what "no widgets" should mean.
     */
    function publishHitRegions() {
      const handlers = win.webkit && win.webkit.messageHandlers;
      const webkit = handlers && handlers.dynawallInteractivity;
      const webview = win.chrome && win.chrome.webview;
      const webview2 = webview && typeof webview.postMessage === 'function';
      if (!webkit && !webview2) return;

      const open = state.enabled && Boolean(state.activeId);
      const width = win.innerWidth || 0;
      const height = win.innerHeight || 0;
      const regions = [];

      if (open) {
        regions.push([0, 0, width, height]);
      } else if (state.enabled) {
        // Every glyph on the orbit is a target — the four built-ins, each shortcut and
        // the `+` — and nothing else is: the rest of the wallpaper stays click-through.
        placedButtons().forEach(function (button) {
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
     * With no card up the desktop layer stays click-through, so the page never receives
     * a real pointer event; the host watches the mouse, keeps every click that belongs to
     * the desktop, and hands back the ones that land on a reported rectangle. The point
     * arrives in CSS pixels from the top-left of the viewport.
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

      // The point lands on the deepest element under it, which is rarely the control
      // itself: a row's title is a `<span>` inside its `<button>`. Ask the owning button
      // for a real click — `click()` runs the activation behaviour (submitting a form
      // included) that a dispatched `MouseEvent` never does, which is what makes
      // "Search" and "Find" work when a click arrives this way.
      const control = buttonAt(node);
      if (control) {
        control.click();
        return true;
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

    /** The button a replayed click belongs to: the node itself, or the one it sits in. */
    function buttonAt(node) {
      if (!node) return null;
      if (node.tagName === 'BUTTON' && typeof node.click === 'function') return node;
      if (typeof node.closest !== 'function') return null;
      const button = node.closest('button');
      return button && typeof button.click === 'function' ? button : null;
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
      // The manager wears the `+` that opened it: the card and the control that summoned
      // it are the same mark, exactly like a provider's card and its satellite.
      if (id === SERVICE_MANAGER_ID) {
        const plus = addButton && addButton.querySelector('svg');
        return plus ? plus.outerHTML : '';
      }
      for (let index = 0; index < buttons.length; index += 1) {
        const button = buttons[index];
        if (button.getAttribute('data-widget') !== id) continue;
        const glyph = button.querySelector('svg');
        return glyph ? glyph.outerHTML : '';
      }
      return '';
    }

    function openWidget(id) {
      const manager = id === SERVICE_MANAGER_ID;
      const widget = manager ? null : widgetById(id);
      if (!manager && !widget) return false;
      // A satellite that was switched off is not on the desktop, so there is nothing to
      // open — a host script asking for it gets `false` instead of a card with no anchor.
      const button = buttonById(id);
      if (button && button.hidden) return false;
      if (state.activeId === id) return true;

      state.activeId = id;
      state.lastFocus = doc.activeElement;
      // A card always opens clean: no message left over from the last time it was up,
      // and an empty form rather than the half-typed address the user abandoned.
      state.serviceError = '';
      state.serviceDraft = { title: '', url: '' };

      titleNode.textContent = widget ? widget.title : 'Services';
      if (captionNode) captionNode.textContent = widget ? widget.caption : 'Shortcuts in your orbit';
      if (badgeNode) badgeNode.innerHTML = badgeMarkupFor(id);
      buttons.forEach(function (button) {
        button.setAttribute(
          'aria-expanded',
          button.getAttribute('data-widget') === id ? 'true' : 'false'
        );
      });
      // The `+` has no `data-widget`, so it is announced by hand: the same glow, without
      // the satellite list having to grow a fifth entry it does not have.
      if (addButton) addButton.setAttribute('aria-expanded', manager ? 'true' : 'false');

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
      if (addButton) addButton.setAttribute('aria-expanded', 'false');
      // A closed card must not keep a fetched forecast, a half-typed city or a
      // focused field in the heap: the body is rebuilt on the next open.
      state.serviceError = '';
      state.serviceDraft = { title: '', url: '' };
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

    /**
     * The add form: a name, an address and nothing else.
     *
     * The address is validated before it is stored (`normalizeServiceUrl`), and the
     * message below says why when it is refused: a wallpaper opens nothing but a plain
     * `https` page, so a paste of `javascript:` or a bare `github.com` is turned away
     * instead of quietly repaired.
     */
    function serviceForm() {
      const form = el('form', 'widget-service-form');

      const nameInput = el('input', 'widget-input');
      nameInput.type = 'text';
      nameInput.placeholder = 'Name (optional)';
      nameInput.setAttribute('aria-label', 'Service name');
      nameInput.setAttribute('autocomplete', 'off');
      nameInput.spellcheck = false;
      nameInput.value = state.serviceDraft.title;

      const field = el('div', 'widget-field');
      const urlInput = el('input', 'widget-input');
      urlInput.type = 'url';
      urlInput.placeholder = 'Paste an https address';
      urlInput.setAttribute('aria-label', 'Service address');
      urlInput.setAttribute('autocomplete', 'off');
      urlInput.spellcheck = false;
      urlInput.value = state.serviceDraft.url;

      const submit = el('button', 'widget-submit', 'Add');
      submit.type = 'submit';

      function submitService() {
        state.serviceDraft = { title: nameInput.value, url: urlInput.value };
        addServiceFromForm();
      }

      field.appendChild(urlInput);
      field.appendChild(submit);
      form.appendChild(nameInput);
      form.appendChild(field);
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        submitService();
      });
      // A replayed click is synthetic, so the button answers it itself instead of
      // relying on an implicit form submission that never comes (the same reason the
      // YouTube and weather cards wire theirs by hand).
      submit.addEventListener('click', function (event) {
        event.preventDefault();
        submitService();
      });
      return form;
    }

    /** Store the draft, or say why it cannot be stored. */
    function addServiceFromForm() {
      if (state.services.length >= MAX_CUSTOM_SERVICES) {
        failService('The orbit holds ' + MAX_CUSTOM_SERVICES + ' services. Remove one to add another.');
        return false;
      }
      const url = normalizeServiceUrl(state.serviceDraft.url);
      if (!url) {
        failService('Paste the whole address, beginning with https. Nothing else is ever opened.');
        return false;
      }
      const name = clipText(state.serviceDraft.title, MAX_SERVICE_TITLE) || serviceHostLabel(url);
      const service = createCustomService(name, url, { index: state.services.length + 1 });
      if (!service) {
        failService('That address cannot be turned into a shortcut.');
        return false;
      }
      const duplicate = state.services.some(function (existing) {
        return existing.url === service.url;
      });
      if (duplicate) {
        failService('That address is already in your orbit.');
        return false;
      }
      state.serviceError = '';
      state.serviceDraft = { title: '', url: '' };
      commitServices(state.services.concat([service]));
      return true;
    }

    /** Show why the draft was refused, keeping what the user typed in the fields. */
    function failService(message) {
      state.serviceError = message;
      renderWidget(SERVICE_MANAGER_ID);
      refocusManagerField();
    }

    /**
     * The manager card: the form, the list, and one honest note about what a shortcut is.
     *
     * The list is the orbit, one row per glyph, so adding a service and watching the ring
     * grow is the same gesture seen twice.
     */
    function renderServices() {
      body.appendChild(section('Add a service', serviceForm()));
      if (state.serviceError) body.appendChild(stateRow(state.serviceError, { error: true }));
      body.appendChild(
        section(
          state.services.length > 0 ? 'In orbit' : 'Shortcuts',
          state.services.length > 0
            ? rowList(state.services.map(serviceRow))
            : stateRow('No shortcuts yet — add one above.')
        )
      );
      body.appendChild(
        note(
          'A shortcut opens in your default browser. The wallpaper never loads the site, so nothing about it is fetched until you click.'
        )
      );
    }

    /** One row: the shortcut's mark, its name and address, and the way to forget it. */
    function serviceRow(service) {
      const row = el('div', 'widget-service');

      const open = el('button', 'widget-service-open');
      open.type = 'button';
      open.title = 'Open ' + service.title;
      const glyph = el('span', 'widget-service-glyph');
      glyph.innerHTML = serviceGlyphMarkup(service);
      open.appendChild(glyph);
      const text = el('span', 'widget-row-text');
      text.appendChild(el('span', 'widget-row-title', service.title));
      text.appendChild(el('span', 'widget-row-meta', serviceHostLabel(service.url)));
      open.appendChild(text);
      open.insertAdjacentHTML('beforeend', ARROW_MARKUP);
      open.addEventListener('click', function () {
        openExternal(win, service.url);
      });

      const remove = el('button', 'widget-service-remove');
      remove.type = 'button';
      remove.title = 'Remove ' + service.title;
      remove.setAttribute('aria-label', 'Remove ' + service.title + ' from the orbit');
      remove.insertAdjacentHTML('beforeend', REMOVE_MARKUP);
      remove.addEventListener('click', function () {
        removeService(service.id);
      });

      row.appendChild(open);
      row.appendChild(remove);
      return row;
    }

    function renderWidget(id) {
      clearBody();
      if (id === SERVICE_MANAGER_ID) renderServices();
      else if (id === 'music') renderMusic();
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

      function submitSearch() {
        const term = clipText(input.value, MAX_WIDGET_TEXT);
        if (!term) {
          input.focus();
          return;
        }
        openExternal(win, buildYouTubeSearchUrl(term));
      }

      form.appendChild(input);
      form.appendChild(submit);
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        submitSearch();
      });
      // A click the host replays into the page is synthetic, and a synthetic click on a
      // submit button does not reliably submit its form. The button runs the search
      // itself, so "Search" behaves the same for a real pointer, for `Enter` in the
      // field and for a click that arrived through `clickAt()`.
      submit.addEventListener('click', function (event) {
        event.preventDefault();
        submitSearch();
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
      // A place can also be picked with one click: the field above is only typeable where
      // the page has the keyboard (a card the host has focused, or a plain browser), and a
      // desktop without one still has to reach a forecast.
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

      function submitPlace() {
        searchPlaces(input.value);
      }

      form.appendChild(input);
      form.appendChild(submit);
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        submitPlace();
      });
      // Same as the YouTube card: a replayed click is synthetic, so the button answers it
      // itself instead of relying on an implicit form submission that never comes.
      submit.addEventListener('click', function (event) {
        event.preventDefault();
        submitPlace();
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

    // The `+` is a toggle like any other satellite: press it again and the card it
    // opened goes away, so the manager is never a panel with no way back.
    if (addButton) {
      addButton.addEventListener('click', function (event) {
        event.preventDefault();
        if (state.activeId === SERVICE_MANAGER_ID) {
          closeWidget();
          return;
        }
        openWidget(SERVICE_MANAGER_ID);
      });
    }

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

    // The shortcuts become satellites before the first deal, so the orbit opens with the
    // set the user keeps instead of appearing to grow a moment later.
    rebuildServiceButtons();

    // Adopt the settings before the first deal, so the page opens with exactly the
    // desktop the user picked — no flash of four satellites on their way out.
    applyConfig(config);

    // Deal the first hand, then hold it: `scatter()` measures the greeting and the
    // viewport, so it has to run again when either changes shape. The resize is
    // debounced — a live drag would otherwise re-deal on every frame — while the hit
    // regions are refreshed immediately, so a click during the drag still lands.
    state.started = true;
    scatter();
    let scatterTimer = 0;
    win.addEventListener('resize', function () {
      scheduleHitRegions();
      if (scatterTimer) win.clearTimeout(scatterTimer);
      scatterTimer = win.setTimeout(function () {
        scatterTimer = 0;
        scatter();
      }, 140);
    });

    const contentNode = doc.getElementById('content');
    if (contentNode) {
      // The entrance slides and scales `.wallpaper-content` for 900 ms, so the
      // satellite rectangles measured before it settled sit a few pixels off.
      // Re-measure when that transition lands — once, not on every frame.
      contentNode.addEventListener('transitionend', function (event) {
        if (event.target === contentNode) scheduleHitRegions();
      });

      // A longer name, a different greeting or the webfont finally arriving all
      // change how wide the text block is, and can grow it over a satellite. Watch
      // for that and deal again rather than letting the greeting collide.
      if (typeof win.ResizeObserver === 'function') {
        state.textObserver = new win.ResizeObserver(function () {
          if (!isNarrow() && coversText()) scatter();
        });
        state.textObserver.observe(contentNode);
      }
    }
    /**
     * The satellites' switches — the master `widgets` setting and one flag per satellite,
     * live.
     *
     * Every host reaches this through the same configuration fields, so the five switches
     * in the macOS popover, in the Windows window, in Lively and in Wallpaper Engine, plus
     * `?widgets=false` / `?music=false` and `DynaWall.setWidgetsEnabled()` /
     * `DynaWall.setWidgetEnabled()`, all land here. A satellite that is off is `hidden`:
     * it is never placed, never measured, never reported as clickable and its card cannot
     * be opened, which is what hands that corner of the desktop back to the Finder.
     *
     * The remaining satellites are dealt again whenever the set changes — the ring is
     * sized for the set on screen, so a hidden one closes a gap instead of leaving one.
     *
     * Returns the master switch in force.
     */
    function applyConfig(next) {
      const source = next || {};
      const master = source.widgets !== false;
      let changed = master !== state.enabled;
      state.enabled = master;

      const root = doc.documentElement;
      if (root && root.classList) {
        if (master) root.classList.remove('is-widgets-off');
        else root.classList.add('is-widgets-off');
      }

      buttons.forEach(function (button) {
        const id = button.getAttribute('data-widget') || '';
        // A satellite this build has no setting for (a page that added one of its own)
        // follows the master switch instead of disappearing for good.
        const field = ownLookup(WIDGET_FIELDS, id);
        const visible = master && (field ? source[field] !== false : true);
        if (button.hidden !== !visible) {
          button.hidden = !visible;
          changed = true;
        }
        // A card whose satellite just left the desktop has nothing to go back to.
        if (!visible && state.activeId === id) closeWidget();
      });

      // The `+` has no switch of its own: it follows the master one, so an orbit that is
      // switched off also loses the way in (and its manager card, if that was up).
      if (addButton && addButton.hidden !== !master) {
        addButton.hidden = !master;
        changed = true;
      }

      // Custom shortcuts are never hidden one by one — they are added and removed
      // deliberately — so the master switch is all they answer to, which the orbit's
      // own `display: none` already covers.
      if (!master && state.activeId === SERVICE_MANAGER_ID) closeWidget();

      // Before the first deal there is nothing to re-deal: creation scatters once at the
      // end, with the visibility above already in place.
      if (!changed || !state.started) return state.enabled;

      if (master) {
        scatter();
      } else {
        if (state.activeId) closeWidget();
        scheduleHitRegions();
      }
      return state.enabled;
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
      /** Whether the satellites are on the desktop right now. */
      enabled: function () {
        return state.enabled;
      },
      /** The built-in satellites on the desktop right now, by widget id. */
      visibleIds: function () {
        return visibleBuiltins().map(function (button) {
          return button.getAttribute('data-widget') || '';
        });
      },
      /** The custom shortcuts in the orbit, as `{ id, title, url, icon }`. */
      services: function () {
        return state.services.map(function (service) {
          return { id: service.id, title: service.title, url: service.url, icon: service.icon };
        });
      },
      /** Add a shortcut and deal it into the ring; `null` when it cannot be added. */
      addService: addService,
      /** Forget a shortcut; whether the list changed. */
      removeService: removeService,
      applyConfig: applyConfig,
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
    /** Satellite id → the configuration field that shows or hides it. */
    WIDGET_FIELDS: WIDGET_FIELDS,
    /** The five widget settings: the master switch plus one flag per satellite. */
    WIDGET_SETTING_FIELDS: WIDGET_SETTING_FIELDS,
    WIDGET_FETCH_HOSTS: WIDGET_FETCH_HOSTS,
    WIDGET_LINK_HOSTS: WIDGET_LINK_HOSTS,
    WIDGET_REMOTE_HOSTS: WIDGET_REMOTE_HOSTS,
    WIDGET_NARROW_QUERY: WIDGET_NARROW_QUERY,
    scatterWidgets: scatterWidgets,
    createRandom: createRandom,

    /* Custom services. The same pure half the manager card uses, so a host script and
       a paste into the card can never disagree about what a legal shortcut is. */
    CUSTOM_SERVICES_KEY: CUSTOM_SERVICES_KEY,
    MAX_CUSTOM_SERVICES: MAX_CUSTOM_SERVICES,
    MAX_SERVICE_TITLE: MAX_SERVICE_TITLE,
    /** The reserved card id of the manager (`DynaWall.openWidget('services')`). */
    SERVICE_MANAGER_ID: SERVICE_MANAGER_ID,
    SERVICE_ICONS: SERVICE_ICONS,
    normalizeServiceUrl: normalizeServiceUrl,
    normalizeServiceIcon: normalizeServiceIcon,
    serviceIconId: serviceIconId,
    serviceIconMarkup: serviceIconMarkup,
    serviceMonogram: serviceMonogram,
    serviceGlyphMarkup: serviceGlyphMarkup,
    serviceHostName: serviceHostName,
    serviceHostLabel: serviceHostLabel,
    createCustomService: createCustomService,
    normalizeCustomServices: normalizeCustomServices,
    serializeCustomServices: serializeCustomServices,
    readCustomServices: readCustomServices,
    writeCustomServices: writeCustomServices,
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
     * Turn all four desktop satellites on or off, exactly like the host's master switch.
     *
     * The value travels through the same update path a Lively/Wallpaper Engine property
     * takes, so it is cached in `localStorage` and both the page and the widget
     * controller agree on it afterwards. Returns the state now in force.
     */
    setWidgetsEnabled: function (enabled) {
      const value = enabled !== false;
      if (appRef) {
        appRef.applyUpdates([{ field: 'widgets', value: value }]);
      } else if (widgetsRef) {
        const config = {};
        config.widgets = value;
        widgetsRef.applyConfig(config);
      }
      return widgetsRef ? widgetsRef.enabled() : false;
    },
    /**
     * Turn one satellite on or off: `DynaWall.setWidgetEnabled('youtube', false)`.
     *
     * `id` is a `WIDGETS` id (`music`, `news`, `youtube`, `weather`); an unknown id is
     * refused rather than silently cached. Returns whether that satellite is now on the
     * desktop.
     */
    setWidgetEnabled: function (id, enabled) {
      const field = ownLookup(WIDGET_FIELDS, id);
      if (!field) return false;
      const value = enabled !== false;
      if (appRef) {
        appRef.applyUpdates([{ field: field, value: value }]);
      }
      if (!widgetsRef) return false;
      const ids = widgetsRef.visibleIds();
      return ids.indexOf(id) !== -1;
    },
    /** `true` while the satellites are on the desktop. */
    widgetsEnabled: function () {
      return widgetsRef ? widgetsRef.enabled() : false;
    },
    /** The satellites on the desktop right now, by id. */
    enabledWidgets: function () {
      return widgetsRef ? widgetsRef.visibleIds() : [];
    },
    /**
     * The custom shortcuts in the orbit, as `{ id, title, url, icon }`.
     *
     * They are the user's own list, cached in `localStorage` rather than pushed by a
     * host: a shortcut is added on the wallpaper (the orbit's `+`) or through the two
     * calls below, never from a popover.
     */
    customServices: function () {
      return widgetsRef ? widgetsRef.services() : [];
    },
    /**
     * Add a shortcut: `DynaWall.addCustomService('GitHub', address)`.
     *
     * The address goes through the same validation the manager card uses, so anything
     * that is not a plain `https` URL is refused (`null`) rather than cached.
     */
    addCustomService: function (title, url) {
      return widgetsRef ? widgetsRef.addService(title, url) : null;
    },
    /** Remove a shortcut by its id; whether the orbit changed. */
    removeCustomService: function (id) {
      return widgetsRef ? widgetsRef.removeService(id) : false;
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
      // good wallpaper with four inert buttons instead of a blank screen. They start
      // in the state the configuration asked for: the master switch and the four
      // per-satellite flags decide what is placed, drifted and reported as clickable.
      try {
        widgetsRef = createWidgets(window, document, { config: app.state.config });
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
