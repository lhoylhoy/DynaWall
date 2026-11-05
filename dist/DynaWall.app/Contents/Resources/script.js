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
 * Desktop apps: the orbit holds the user's own launchers — one bare glyph per app,
 * each handed to the default browser through `openExternal` — plus the single `+` that
 * opens the Apps card. `widgets` is the master switch (on by default), so the macOS
 * popover, the Windows window, Lively, Wallpaper Engine and `?widgets=false` can take
 * the whole orbit off the desktop; a satellite that is off is never placed, never
 * measured, never reported as a click region, which hands that part of the desktop
 * back to the Finder.
 *
 * The apps themselves are the user's, not the host's: the list is added, launched and
 * forgotten on the wallpaper (`+` → Apps) and cached in `localStorage`
 * (`dynawall.customServices`), so no host control has to know what an app is. A page
 * that fetches nothing can launch anything: the wallpaper never loads the site it
 * opens, which is why the Content Security Policy allows no remote host at all.
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
    // The apps orbit: the `+` and every app the user added. On by default, and off is a
    // real setting rather than a broken page: with the orbit off nothing is placed,
    // nothing drifts and no click region is reported to the host, so the desktop
    // underneath belongs to the Finder again.
    widgets: true,
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
    // Whether the apps orbit (the `+` and every app the user added) is on the wallpaper.
    widgets: 'dynawall.widgets',
    fontFamily: 'dynawall.fontFamily'
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
    apps: 'widgets',
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
    // The apps orbit: every host's "Desktop apps" switch.
    widgets: 'widgets',
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
    widgets: 'widgets'
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
   * Apps — the orbit, the card, and the launchers it deals
   * ------------------------------------------------------------------------ */

  /**
   * The card's reserved id, used by `DynaWall.openWidget('apps')`.
   *
   * There is exactly one card: the apps manager. It is never a `data-widget` value in
   * index.html — it is not one of the apps, it is the way to add one.
   */
  const APPS_CARD_ID = 'apps';

  /**
   * The one-tap presets the Apps card offers above the form.
   *
   * A preset is nothing but a name and an `https` address: pressing its chip runs the
   * very same `addService()` a typed address does, so a preset can never create a record
   * the form could not, and the list is plain data a host script can read. The marks are
   * resolved from the address by the same catalogue every other app uses, so a preset
   * chip and the satellite it adds wear the same glyph.
   */
  const APP_PRESETS = Object.freeze([
    Object.freeze({ title: 'GitHub', url: 'https://github.com/' }),
    Object.freeze({ title: 'ChatGPT', url: 'https://chatgpt.com/' }),
    Object.freeze({ title: 'Claude', url: 'https://claude.ai/' }),
    Object.freeze({ title: 'YouTube', url: 'https://www.youtube.com/' }),
    Object.freeze({ title: 'Spotify', url: 'https://open.spotify.com/' }),
    Object.freeze({ title: 'Reddit', url: 'https://www.reddit.com/' }),
    Object.freeze({ title: 'Notion', url: 'https://www.notion.so/' }),
    Object.freeze({ title: 'Figma', url: 'https://www.figma.com/' })
  ]);

  /** Longest string any card will echo back into the page. */
  const MAX_WIDGET_TEXT = 120;
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
   * Where the satellites' click tally is cached.
   *
   * Deliberately outside `STORAGE_KEYS`, for the same reason the shortcut list is: that
   * map is the one-to-one mirror of the configuration fields (`dynawall.firstName` …)
   * a host control can push, and a tally is not one of those — it is earned on the
   * wallpaper by opening the glyphs. The value is a JSON object of `{ [id]: count }`.
   */
  const WIDGET_USAGE_KEY = 'dynawall.widgetUsage';

  /** A tally stops climbing here: the ranking only ever compares counts with each other. */
  const MAX_WIDGET_USAGE = 1000000;

  /**
   * Where the hand the satellites were dealt is cached: the seed that dealt it, and the
   * whole-pixel spot each glyph wears.
   *
   * Deliberately outside `STORAGE_KEYS`, like the tally beside it: this is not a
   * configuration field a host control pushes, it is the arrangement the desktop keeps.
   * The seed is a positive integer, the hand a JSON object of `{ [id]: { x, y } }`.
   */
  const WIDGET_SEED_KEY = 'dynawall.widgetSeed';
  const WIDGET_POSITIONS_KEY = 'dynawall.widgetPositions';

  /**
   * The three footprints a satellite can wear, smallest first.
   *
   * S is the app that is barely opened, M is the baseline every glyph starts at, L is
   * the one the user lives in. style.css owns what each of them measures; script.js only
   * ever names them.
   */
  const WIDGET_SIZE_TIERS = Object.freeze(['s', 'm', 'l']);

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

  /* ----------------------------------------------------------------------- *
   * Satellite usage — how often each glyph is opened
   *
   * The apps a wallpaper offers are not equally interesting: two of them get opened
   * every day and the rest are never touched. Counting the opens is what lets the ring
   * say so — the glyph that gets used grows, the one that does not shrinks — without a
   * settings panel and without a single request. Everything below is pure and
   * storage-shaped, so the page, a host script and the headless tests all rank the same
   * way.
   * ------------------------------------------------------------------------ */

  /** A satellite id as it is cached: a short, trimmed string (`''` when it names nothing). */
  function normalizeWidgetUsageId(value) {
    if (value === undefined || value === null) return '';
    return clipText(value, 64);
  }

  /**
   * A stored tally, made safe: `{ [id]: count }` with whole, positive counts only.
   *
   * Hand-edited, truncated or foreign JSON is simply no tally — the orbit then stays at
   * its baseline instead of throwing on load — and a count that is not a number, is
   * negative or is fractional is dropped or rounded down rather than trusted.
   */
  function normalizeWidgetUsage(rawValue) {
    let list = rawValue;
    if (typeof list === 'string') {
      if (!list.trim()) return {};
      try {
        list = JSON.parse(list);
      } catch (error) {
        return {};
      }
    }
    if (!list || typeof list !== 'object' || Array.isArray(list)) return {};

    const usage = {};
    Object.keys(list).forEach(function (key) {
      const id = normalizeWidgetUsageId(key);
      const count = Math.floor(Number(list[key]));
      if (!id || !Number.isFinite(count) || count <= 0) return;
      usage[id] = Math.min(count, MAX_WIDGET_USAGE);
    });
    return usage;
  }

  /** The tally cached on this machine, or `{}` when there is none (or no storage). */
  function readWidgetUsage(storage) {
    if (!storage || typeof storage.getItem !== 'function') return {};
    let raw = null;
    try {
      raw = storage.getItem(WIDGET_USAGE_KEY);
    } catch (error) {
      return {}; // storage can be blocked (private mode, disabled cookies)
    }
    if (raw === null) return {};
    return normalizeWidgetUsage(raw);
  }

  /** Cache the tally. Best-effort: a blocked `localStorage` is not a broken wallpaper. */
  function writeWidgetUsage(storage, usage) {
    if (!storage || typeof storage.setItem !== 'function') return false;
    try {
      storage.setItem(WIDGET_USAGE_KEY, JSON.stringify(normalizeWidgetUsage(usage)));
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Count one open of `id` and cache the new tally.
   *
   * Returns the tally the cache now holds, so the caller can keep its own copy in step
   * — which is also what lets a blocked `localStorage` still rank the apps this session
   * instead of freezing every glyph at its baseline.
   */
  function recordWidgetUsage(storage, id) {
    const usage = readWidgetUsage(storage);
    const key = normalizeWidgetUsageId(id);
    if (!key) return usage;
    usage[key] = Math.min((Number(usage[key]) || 0) + 1, MAX_WIDGET_USAGE);
    writeWidgetUsage(storage, usage);
    return usage;
  }

  /** Forget every count: the orbit goes back to all-baseline. */
  function clearWidgetUsage(storage) {
    return writeWidgetUsage(storage, {});
  }

  /* ----------------------------------------------------------------------- *
   * The hand — where the satellites stand, and the seed that dealt it
   *
   * An arrangement belongs to the desktop, not to the page load. The hand is dealt once
   * and then worn again, pixel for pixel, by every reload, every app launch, every tier
   * change and every removal. Only a new app changes the composition, and only then is a
   * new seed rolled. Everything below is pure and storage-shaped, so the page, a host
   * script and the headless tests all read the same hand.
   * ------------------------------------------------------------------------ */

  /** A stored seed, made safe: a positive whole number, or `null` when it is not one. */
  function normalizeWidgetSeed(rawValue) {
    if (rawValue === undefined || rawValue === null || typeof rawValue === 'boolean') return null;
    if (typeof rawValue === 'string' && !rawValue.trim()) return null;
    const seed = Math.floor(Number(rawValue));
    if (!Number.isFinite(seed) || seed <= 0) return null;
    return Math.min(seed, 0xfffffffe);
  }

  /** The seed this desktop was dealt on, or `null` (a fresh install, or no storage). */
  function readWidgetSeed(storage) {
    if (!storage || typeof storage.getItem !== 'function') return null;
    let raw = null;
    try {
      raw = storage.getItem(WIDGET_SEED_KEY);
    } catch (error) {
      return null; // storage can be blocked (private mode, disabled cookies)
    }
    if (raw === null) return null;
    return normalizeWidgetSeed(raw);
  }

  /** Cache the seed. Best-effort: a blocked `localStorage` is not a broken wallpaper. */
  function writeWidgetSeed(storage, seed) {
    const value = normalizeWidgetSeed(seed);
    if (!value || !storage || typeof storage.setItem !== 'function') return false;
    try {
      storage.setItem(WIDGET_SEED_KEY, String(value));
      return true;
    } catch (error) {
      return false;
    }
  }

  /** One cached viewport pixel: a whole number, or `null` when it is not one. */
  function widgetPixel(value) {
    if (value === undefined || value === null || value === '' || typeof value === 'boolean') {
      return null;
    }
    const pixel = Math.round(Number(value));
    return Number.isFinite(pixel) ? pixel : null;
  }

  /**
   * A stored hand, made safe: `{ [id]: { x, y } }` with whole pixels only.
   *
   * Hand-edited, truncated or foreign JSON is simply no hand — the wallpaper deals one
   * instead of throwing on load — and a spot that is not two numbers is dropped rather
   * than trusted, so a broken cache can never park a glyph at `NaN`.
   */
  function normalizeWidgetPositions(rawValue) {
    let list = rawValue;
    if (typeof list === 'string') {
      if (!list.trim()) return {};
      try {
        list = JSON.parse(list);
      } catch (error) {
        return {};
      }
    }
    if (!list || typeof list !== 'object' || Array.isArray(list)) return {};

    const positions = {};
    Object.keys(list).forEach(function (key) {
      const id = normalizeWidgetUsageId(key);
      const entry = list[key];
      if (!id || !entry || typeof entry !== 'object' || Array.isArray(entry)) return;
      const x = widgetPixel(entry.x);
      const y = widgetPixel(entry.y);
      if (x === null || y === null) return;
      positions[id] = { x: x, y: y };
    });
    return positions;
  }

  /** The hand cached on this machine, or `{}` when there is none (or no storage). */
  function readWidgetPositions(storage) {
    if (!storage || typeof storage.getItem !== 'function') return {};
    let raw = null;
    try {
      raw = storage.getItem(WIDGET_POSITIONS_KEY);
    } catch (error) {
      return {};
    }
    if (raw === null) return {};
    return normalizeWidgetPositions(raw);
  }

  /** Cache the hand. Best-effort, like every other write on this page. */
  function writeWidgetPositions(storage, positions) {
    if (!storage || typeof storage.setItem !== 'function') return false;
    try {
      storage.setItem(WIDGET_POSITIONS_KEY, JSON.stringify(normalizeWidgetPositions(positions)));
      return true;
    } catch (error) {
      return false;
    }
  }

  /** Forget the hand: the next deal lays the satellites out from scratch. */
  function clearWidgetPositions(storage) {
    return writeWidgetPositions(storage, {});
  }

  /** The spot `id` wears in `positions`, or `null` when it has none. */
  function widgetPositionOf(positions, id) {
    const key = normalizeWidgetUsageId(id);
    if (!key) return null;
    const hand = positions && typeof positions === 'object' ? positions : {};
    const entry = hand[key];
    if (!entry || typeof entry !== 'object') return null;
    const x = widgetPixel(entry.x);
    const y = widgetPixel(entry.y);
    if (x === null || y === null) return null;
    return { x: x, y: y };
  }

  /**
   * A copy of `positions` without `id`.
   *
   * A shortcut that was removed takes its spot with it; every glyph around it keeps
   * exactly the pixels it was wearing.
   */
  function withoutWidgetPosition(positions, id) {
    const hand = Object.assign({}, positions || {});
    const key = normalizeWidgetUsageId(id);
    if (key) delete hand[key];
    return hand;
  }

  /**
   * `true` when the stored hand can be worn as it is: every satellite on the desktop has
   * a whole-pixel spot in it, and every one of those spots is still inside the viewport
   * the wallpaper is on now.
   *
   * `viewport` is `{ width, height }` in CSS pixels; leave it out to check the spots
   * alone. A hand dealt for a larger screen does not fit a smaller one — the pixels
   * belong to the screen they were dealt on — so that screen is dealt a hand of its own,
   * from the same seed, instead of an arbitrary reshuffle.
   */
  function coversWidgetPositions(positions, ids, viewport) {
    const list = Array.isArray(ids) ? ids : [];
    if (list.length === 0) return false;
    const box = viewport || {};
    const width = Number(box.width) || 0;
    const height = Number(box.height) || 0;
    for (let index = 0; index < list.length; index += 1) {
      const spot = widgetPositionOf(positions, list[index]);
      if (!spot) return false;
      if (width > 0 && (spot.x < 0 || spot.x >= width)) return false;
      if (height > 0 && (spot.y < 0 || spot.y >= height)) return false;
    }
    return true;
  }

  /**
   * The S, M or L tier of each satellite on the desktop, in the order given.
   *
   * Only the active ids are ranked, and only against each other: the glyphs the user
   * has switched off have no place in the comparison. With no tally at all — a fresh
   * install, a reset — every glyph is M, because equal counts must never be split into
   * an arbitrary hierarchy. Once the counts differ, the span between the least and the
   * most opened app is divided in thirds: the top third wears L, the bottom third wears
   * S and whatever falls between stays M. Identical counts always land in the same
   * third, so two apps opened the same number of times are always the same size.
   *
   * Returns an array of `'s' | 'm' | 'l'`, aligned with `activeIds`.
   */
  function computeWidgetSizes(activeIds, usage) {
    const ids = Array.isArray(activeIds) ? activeIds : [];
    if (ids.length === 0) return [];
    const tally = usage && typeof usage === 'object' ? usage : {};

    const counts = ids.map(function (id) {
      const count = Math.floor(Number(tally[normalizeWidgetUsageId(id)]));
      return Number.isFinite(count) && count > 0 ? Math.min(count, MAX_WIDGET_USAGE) : 0;
    });

    let lowest = Infinity;
    let highest = -Infinity;
    counts.forEach(function (count) {
      lowest = Math.min(lowest, count);
      highest = Math.max(highest, count);
    });

    // Nothing to rank: an unused orbit, or one where every glyph has been opened as
    // often as its neighbours. Both wear the baseline rather than inventing an order.
    if (highest === lowest) {
      return ids.map(function () {
        return 'm';
      });
    }

    const span = highest - lowest;
    return counts.map(function (count) {
      const relative = (count - lowest) / span;
      if (relative >= 2 / 3) return 'l';
      if (relative <= 1 / 3) return 's';
      return 'm';
    });
  }

  /**
   * Scatter `count` satellites around the greeting.
   *
   * The satellites belong to the greeting, not to the screen. Each one is thrown out
   * from the text block along a random ray — a random angle, then a random distance
   * between `clearance` px of air and `reach` px further out — so they land in a loose
   * ring around the type. That is what makes the wallpaper look dealt rather than laid
   * out while keeping them together: a satellite that wandered off into an empty corner
   * stops reading as part of the composition.
   *
   * The block they orbit is the union of the `avoid` rects (the greeting and the
   * subtitle, in viewport pixels) — the satellites have to keep off those anyway, so
   * they are the same thing.
   *
   * `size` is one footprint for every satellite; `sizes` gives each of them its own
   * (`[33, 44, 55, 44]` for a hand of mixed glyphs), which is what the usage tiers are
   * made of. Bounds, ring clearance and collision padding are measured against the
   * individual footprint, so a large glyph is never laid out as if it were small.
   * `size` stays the fallback for a `sizes` entry that is missing or nonsense, which is
   * also what an older host that measures one glyph for all of them passes.
   *
   * Four rules keep a hand playable. No two satellites may come within `gap` px of each
   * other, none may break the ring, and neither flank of the greeting may take more
   * than half of them (`Math.ceil(count / 2)`), so the type never ends up with every
   * satellite piled on one side. Among the candidates that satisfy those three, the one
   * that leaves the two flanks closest to equal *weight* — the S, M and L glyphs summed
   * as the area they occupy — and to equal count, on a ray of its own, wins; that is
   * what disperses the large glyphs instead of letting them collect on one side. Where
   * a candidate cannot satisfy the hard rules, the one with the most air around it
   * wins; a wallpaper with no room for a ring at all falls back to an even spread of
   * the safe area, so a crowded screen is a smaller composition rather than a missing
   * glyph.
   *
   * `margin` keeps the satellites off the screen edges; `inset`
   * (`{ top, right, bottom, left }`) overrides an edge on its own, which the bottom
   * one needs — the wallpaper runs behind the Dock and the Windows taskbar, and a
   * satellite there would be invisible and unclickable.
   *
   * Returns `[{ x, y }]` — the top-left corner of each satellite, in the order given.
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
    // Half the hand per flank, rounded up: the greeting is the axis of the composition,
    // so neither side may take more than its share of the glyphs.
    const cap = Math.ceil(count / 2);

    // The footprint of each satellite: `sizes` when the caller has measured them, the one
    // `size` for all of them when it has not.
    const footprints = [];
    const given = Array.isArray(settings.sizes) ? settings.sizes : [];
    for (let index = 0; index < count; index += 1) {
      const measured = Number(given[index]);
      footprints.push(Math.max(1, Number.isFinite(measured) && measured > 0 ? measured : size));
    }

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

    // Where a satellite's *centre* is allowed: the viewport inside the insets, minus half
    // of that satellite. A large glyph has less room than a small one, and each one is
    // kept whole on the wallpaper.
    const rangeFor = function (min, max) {
      // A viewport narrower than the glyph leaves no range at all: collapse to the middle
      // of what is there rather than letting the clamp run backwards.
      return max >= min ? { min: min, max: max } : { min: (min + max) / 2, max: (min + max) / 2 };
    };
    const boxFor = function (footprint) {
      const half = footprint / 2;
      return {
        x: rangeFor(edge(inset.left) + half, width - edge(inset.right) - half),
        y: rangeFor(edge(inset.top) + half, height - edge(inset.bottom) - half)
      };
    };
    // The ring, measured to the satellite's own edge: half the text block, `clearance`
    // of air and half a satellite — so a ray that stops at the ring leaves a rect that
    // is exactly `clearance` from the type, and one that travels `reach` further is that
    // much further out again.
    const ringFor = function (footprint) {
      return {
        x: (block ? (block.right - block.left) / 2 : 0) + clearance + footprint / 2,
        y: (block ? (block.bottom - block.top) / 2 : 0) + clearance + footprint / 2
      };
    };
    // The ring turns around the middle of the text block, or around the middle of the
    // safe area when there is no greeting to orbit.
    const centreX = block
      ? (block.left + block.right) / 2
      : (edge(inset.left) + width - edge(inset.right)) / 2;
    const centreY = block
      ? (block.top + block.bottom) / 2
      : (edge(inset.top) + height - edge(inset.bottom)) / 2;

    const placed = [];
    // The ray each placed satellite took, for the dispersion half of the score.
    const angles = [];
    const points = [];
    let leftCount = 0;
    let rightCount = 0;
    let leftWeight = 0;
    let rightWeight = 0;

    // Largest first: a big glyph has the fewest places to go, so it picks its ray while
    // the ring is still empty and the small ones close the gaps around it. Ties keep the
    // caller's order, so the same seed still deals exactly the same hand.
    const order = footprints.map(function (footprint, index) {
      return index;
    });
    order.sort(function (first, second) {
      if (footprints[second] !== footprints[first]) return footprints[second] - footprints[first];
      return first - second;
    });

    for (let step = 0; step < order.length; step += 1) {
      const item = order[step];
      const footprint = footprints[item];
      const bounds = boxFor(footprint);
      const ring = ringFor(footprint);
      // A ring needs its centre on screen: a text block larger than the wallpaper leaves
      // nothing to orbit, and the plain spread takes over.
      const orbits =
        centreX >= bounds.x.min &&
        centreX <= bounds.x.max &&
        centreY >= bounds.y.min &&
        centreY <= bounds.y.max;

      let best = null;
      let bestOverlap = Infinity;
      let bestScore = Infinity;
      let bestSide = 'left';
      let bestAngle = 0;

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
            rayX === 0 ? Infinity : ring.x / Math.abs(rayX),
            rayY === 0 ? Infinity : ring.y / Math.abs(rayY)
          );
          const screenDistance = Math.min(
            rayLimit(centreX, bounds.x, rayX),
            rayLimit(centreY, bounds.y, rayY)
          );
          if (screenDistance <= haloDistance && attempt < attempts - 1) continue;

          const travel = Math.max(0, Math.min(reach, screenDistance - haloDistance));
          const distance = haloDistance + random() * travel;
          satelliteX = centreX + rayX * distance;
          satelliteY = centreY + rayY * distance;
        } else {
          satelliteX = bounds.x.min + random() * (bounds.x.max - bounds.x.min);
          satelliteY = bounds.y.min + random() * (bounds.y.max - bounds.y.min);
        }

        // Floating point can leave the safe box by a hair; CSS pixels cannot.
        satelliteX = Math.min(Math.max(satelliteX, bounds.x.min), bounds.x.max);
        satelliteY = Math.min(Math.max(satelliteY, bounds.y.min), bounds.y.max);

        const side = satelliteX < centreX ? 'left' : 'right';
        // Half the hand per flank: a candidate that would crowd this side is passed over
        // unless it is the last one, so a tight screen still lays every glyph out.
        if ((side === 'left' ? leftCount : rightCount) >= cap && attempt < attempts - 1) continue;

        const rect = {
          left: satelliteX - footprint / 2,
          top: satelliteY - footprint / 2,
          right: satelliteX + footprint / 2,
          bottom: satelliteY + footprint / 2
        };
        let depth = 0;
        avoid.forEach(function (box) {
          depth = Math.max(depth, overlapDepth(rect, box, 0));
        });
        placed.forEach(function (box) {
          depth = Math.max(depth, overlapDepth(rect, box, gap));
        });

        // How the hand reads from in front of the wallpaper: sit on the flank that is
        // carrying less glyph weight, keep the counts level, and take a ray of its own
        // (`crowded` is 0 for a ray opposite a neighbour, 1 for straight down a taken one).
        const angle = Math.atan2(satelliteY - centreY, satelliteX - centreX);
        let nearest = Math.PI;
        angles.forEach(function (taken) {
          let apart = Math.abs(taken - angle);
          if (apart > Math.PI) apart = Math.PI * 2 - apart;
          nearest = Math.min(nearest, apart);
        });
        const crowded = angles.length > 0 ? 1 - nearest / Math.PI : 0;
        const leftward = side === 'left' ? 1 : 0;
        const weightGap = Math.abs(
          leftWeight + leftward * footprint - (rightWeight + (1 - leftward) * footprint)
        );
        const countGap = Math.abs(leftCount + leftward - (rightCount + (1 - leftward)));
        const score = weightGap + countGap * footprint + crowded * footprint;

        // A candidate that touches nothing always beats one that does; between two that
        // do, the shallower overlap wins. The balance score breaks the ties.
        const overlap = depth > 0 ? depth : 0;
        if (
          best === null ||
          overlap < bestOverlap ||
          (overlap === bestOverlap && score < bestScore)
        ) {
          best = rect;
          bestOverlap = overlap;
          bestScore = score;
          bestSide = side;
          bestAngle = angle;
        }
        // Level on both flanks, clear of everything, on a ray of its own: nothing that
        // can be thrown next could beat it.
        if (overlap === 0 && score === 0) break;
      }

      placed.push(best);
      angles.push(bestAngle);
      points[item] = { x: best.left, y: best.top };
      if (bestSide === 'left') {
        leftCount += 1;
        leftWeight += footprint;
      } else {
        rightCount += 1;
        rightWeight += footprint;
      }
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

  /* ----------------------------------------------------------------------- *
   * Apps — the user's own launchers
   *
   * An app is a title, a plain `https` address and the mark it wears in the orbit.
   * It is not a host setting — there is no popover switch for "ChatGPT" — so the list
   * lives in `localStorage` under one key and is edited on the wallpaper itself,
   * through the `+` satellite's Apps card. Everything below is pure: the page, the
   * card and the headless tests all use the same validation, so the address the card
   * accepts and the address `openExternal` is handed can never disagree.
   * ------------------------------------------------------------------------ */

  /**
   * Where the apps are cached.
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
   * The curated marks, in the same bare monochrome ink as the `+` beside them: a 24×24
   * box, no plate, no colour.
   *
   * Two inks, chosen per mark. A brand whose logo *is* a filled silhouette is drawn filled
   * (`solid: true`): that is the geometry it was designed as, and it is what stays legible
   * at a satellite's 30-odd pixels — stroking that contour would trace every interior
   * detail as well and the mark would read as noise, or as an empty box. The kind marks and
   * the generic window are drawn as strokes at one weight instead, so a shortcut can sit in
   * the ring beside them without reading as a heavier, painted tile. `solid` is therefore
   * also what tells a brand from a kind.
   *
   * Each one is scaled to 90% and moved in by 1.2 units (the same inset index.html's
   * YouTube badge already uses): a stroked mark sits astride its path, and a filled one
   * wants a breath of air, so a mark drawn to the very edge of the box would be sliced at
   * the largest footprint, where two screen pixels are two user units. The pack's
   * coordinates are rounded to a tenth of a unit for the same reason — a tenth is a fifth
   * of a pixel at the largest footprint — which is what keeps four hundred marks to a few
   * hundred kilobytes instead of half a megabyte.
   *
   * Nothing here is fetched, bundled as a picture or cached. A mark is a few hundred
   * characters of path data in this file, which is what keeps the wallpaper's "no
   * network, no sprite sheet, no favicon" promise intact.
   *
   * `hints` are the words a title or an address may contain; `domains` are the hosts the
   * brand answers on, and a host belongs to exactly one mark (a host two of them share —
   * `jetbrains.com`, `atlassian.com` — belongs to neither, and those apps are recognised
   * by name instead). Neither is a policy — the Content Security Policy still owns what
   * may load, and a shortcut is only ever handed to the operating system's browser — so a
   * match here costs nothing and grants nothing.
   *
   * The pack is every app the open-source Simple Icons set still carries, gathered at
   * authoring time and inked into this same box. It is deliberately not the whole set: the
   * suites whose owners asked the icon sets to drop them are absent (Microsoft's and Adobe's
   * product marks, Amazon, Xbox, Kindle, Hulu and their like), so those apps fall through to
   * the kind marks — a document, a sheet, a slide, a terminal, a store — which is what the
   * kind marks are for. Adding a mark means pasting its geometry here, never pointing the
   * page at a host: the wallpaper still asks the network for nothing.
   *
   * Order is precedence, and only for a tie: a host is matched first, then the longest whole
   * word in the title ("Google Sheets" is Sheets, not Google), then the longest whole word in
   * the address, which is what lets an unnamed shortcut pasted as a bare URL find its mark.
   * The brands come first as a group, then the kind marks, so a plain "Chat" or "Notes" still
   * finds one. The catch-all closes the list last: a shortcut nothing above claimed wears a
   * bare application window instead of dropping out of the constellation into a monogram.
   */
  const GENERIC_ICON = Object.freeze({
    id: 'generic',
    label: 'App',
    hints: Object.freeze(['app', 'shortcut']),
    paths:
      '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/>' +
      '<path d="M3.5 9.5h17"/>' +
      '<path d="M6.6 7h.01M9.1 7h.01"/>'
  });

  const SERVICE_ICONS = Object.freeze([GENERIC_ICON]);

  /**
   * The id of the catch-all at the end of the catalogue: the bare window every shortcut
   * wears when nothing else claimed it. It names no host, so it is never guessed from an
   * address — it is applied by `serviceGlyphMarkup` when the matcher answers nothing.
   */
  const GENERIC_ICON_ID = 'generic';

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

  /**
   * High-resolution transparent vector favicons for services whose public
   * raster scrapers render an opaque white box or inverted colors.
   */
  const CHATGPT_FAVICON =
    'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180" fill="none"><path fill="%23ffffff" d="M101.228 164.247C96.2776 164.247 91.5751 163.307 87.1201 161.426C82.6651 159.545 78.7051 156.921 75.2401 153.555C71.4781 154.842 67.5676 155.486 63.5086 155.486C56.8756 155.486 50.7376 153.852 45.0946 150.585C39.4516 147.318 34.8976 142.863 31.4326 137.22C28.0666 131.577 26.3836 125.291 26.3836 118.361C26.3836 115.49 26.7796 112.371 27.5716 109.005C23.6116 105.342 20.5426 101.135 18.3646 96.3828C16.1866 91.5318 15.0976 86.4828 15.0976 81.2358C15.0976 75.8898 16.2361 70.7418 18.5131 65.7918C20.7901 60.8418 23.9581 56.5848 28.0171 53.0208C32.1751 49.3578 36.9766 46.8333 42.4216 45.4473C43.5106 39.8043 45.7876 34.7553 49.2526 30.3003C52.8166 25.7463 57.1726 22.1823 62.3206 19.6083C67.4686 17.0343 72.9631 15.7473 78.8041 15.7473C83.7541 15.7473 88.4566 16.6878 92.9116 18.5688C97.3666 20.4498 101.327 23.0733 104.792 26.4393C108.554 25.1523 112.464 24.5088 116.523 24.5088C123.156 24.5088 129.294 26.1423 134.937 29.4093C140.58 32.6763 145.085 37.1313 148.451 42.7743C151.916 48.4173 153.648 54.7038 153.648 61.6338C153.648 64.5048 153.252 67.6233 152.46 70.9893C156.42 74.6523 159.489 78.9093 161.667 83.7603C163.845 88.5123 164.934 93.5118 164.934 98.7588C164.934 104.105 163.796 109.253 161.519 114.203C159.242 119.153 156.024 123.459 151.866 127.122C147.807 130.686 143.055 133.161 137.61 134.547C136.521 140.19 134.195 145.239 130.631 149.694C127.166 154.248 122.859 157.812 117.711 160.386C112.563 162.96 107.069 164.247 101.228 164.247ZM64.5481 145.685C69.4981 145.685 73.8046 144.645 77.4676 142.566L105.386 126.528C106.376 125.835 106.871 124.895 106.871 123.707V110.936L70.9336 131.577C68.7556 132.864 66.5776 132.864 64.3996 131.577L36.3331 115.391C36.3331 115.688 36.2836 116.034 36.1846 116.43C36.1846 116.826 36.1846 117.42 36.1846 118.212C36.1846 123.261 37.3726 127.914 39.7486 132.171C42.2236 136.329 45.6391 139.596 49.9951 141.972C54.3511 144.447 59.2021 145.685 64.5481 145.685ZM66.0331 121.479C66.6271 121.776 67.1716 121.925 67.6666 121.925C68.1616 121.925 68.6566 121.776 69.1516 121.479L80.2891 115.094L44.5006 94.3038C42.3226 93.0168 41.2336 91.0863 41.2336 88.5123V56.2878C36.2836 58.4658 32.3236 61.8318 29.3536 66.3858C26.3836 70.8408 24.8986 75.7908 24.8986 81.2358C24.8986 86.0868 26.1361 90.7398 28.6111 95.1948C31.0861 99.6498 34.3036 103.016 38.2636 105.293L66.0331 121.479ZM101.228 154.446C106.475 154.446 111.227 153.258 115.484 150.882C119.741 148.506 123.107 145.239 125.582 141.081C128.057 136.923 129.294 132.27 129.294 127.122V95.0463C129.294 93.8583 128.799 92.9673 127.809 92.3733L116.523 85.8393V127.271C116.523 129.845 115.434 131.775 113.256 133.062L85.1896 149.249C90.0406 152.714 95.3866 154.446 101.228 154.446ZM106.871 100.095V79.8993L90.09 70.3953L73.1611 79.8993V100.095L90.09 109.599L106.871 100.095ZM63.5086 52.7238C63.5086 50.1498 64.5976 48.2193 66.7756 46.9323L94.8421 30.7458C89.9911 27.2808 84.6451 25.5483 78.8041 25.5483C73.5571 25.5483 68.8051 26.7363 64.5481 29.1123C60.2911 31.4883 56.9251 34.7553 54.4501 38.9133C52.0741 43.0713 50.8861 47.7243 50.8861 52.8723V84.7998C50.8861 85.9878 51.3811 86.9283 52.3711 87.6213L63.5086 94.1553V52.7238ZM138.947 123.707C143.897 121.529 147.807 118.163 150.678 113.609C153.648 109.055 155.133 104.105 155.133 98.7588C155.133 93.9078 153.896 89.2548 151.421 84.7998C148.946 80.3448 145.728 76.9788 141.768 74.7018L113.999 58.6638C113.405 58.2678 112.86 58.1193 112.365 58.2183C111.87 58.2183 111.375 58.3668 110.88 58.6638L99.7426 64.9008L135.68 85.8393C136.769 86.4333 137.561 87.2253 138.056 88.2153C138.65 89.1063 138.947 90.1953 138.947 91.4823V123.707ZM109.098 48.2688C111.276 46.8828 113.454 46.8828 115.632 48.2688L143.847 64.7523C143.847 64.0593 143.847 63.1683 143.847 62.0793C143.847 57.3273 142.659 52.8228 140.283 48.5658C138.006 44.2098 134.69 40.7448 130.334 38.1708C126.077 35.5968 121.127 34.3098 115.484 34.3098C110.534 34.3098 106.227 35.3493 102.564 37.4283L74.6461 53.4663C73.6561 54.1593 73.1611 55.0998 73.1611 56.2878V69.0588L109.098 48.2688Z"/>' +
    '</svg>';

  const FAVICON_OVERRIDES = Object.freeze({
    'chatgpt.com': CHATGPT_FAVICON,
    'chat.openai.com': CHATGPT_FAVICON,
    'openai.com': CHATGPT_FAVICON
  });

  /**
   * The high-resolution favicon endpoint for an address, or ''.
   *
   * 100% favicon: every shortcut gets the site's own high-resolution favicon.
   */
  function serviceFaviconUrl(url, size) {
    const host = serviceHostName(url);
    if (!host) return '';
    if (FAVICON_OVERRIDES[host]) {
      return FAVICON_OVERRIDES[host];
    }
    const sz = Number(size) || 128;
    return 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(host) + '&sz=' + sz;
  }

  /**
   * The curated entry for an id, or null when the catalogue has no such mark.
   */
  function serviceIconById(id) {
    const key = String(id || '').trim().toLowerCase();
    if (!key) return null;
    return key === GENERIC_ICON_ID ? GENERIC_ICON : null;
  }

  /**
   * A service's fallback mark id.
   */
  function serviceIconId(title, url) {
    return GENERIC_ICON_ID;
  }

  /** A stored icon id, or '' when it names nothing in the catalogue. */
  function normalizeServiceIcon(value) {
    const icon = serviceIconById(value);
    return icon ? icon.id : '';
  }

  /**
   * The SVG markup for a curated mark; '' when there is none.
   */
  function serviceIconMarkup(iconId) {
    const icon = serviceIconById(iconId);
    if (!icon) return '';
    return (
      '<svg class="widget-icon' +
      (icon.solid ? ' is-solid' : '') +
      '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      icon.paths +
      '</svg>'
    );
  }

  /**
   * A two-letter mark for a service's initials.
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

  /**
   * The mark a service wears: 100% favicon from the site itself,
   * falling back to the generic app window icon when the image fails to load.
   */
  function serviceGlyphMarkup(service) {
    const url = service && service.url;
    const title = service && service.title;
    const faviconUrl = serviceFaviconUrl(url, 128);
    if (!faviconUrl) {
      return serviceIconMarkup(GENERIC_ICON_ID);
    }
    const escapedTitle = escapeMarkup(title || serviceHostLabel(url) || 'App');
    return (
      '<img class="widget-favicon" src="' +
      faviconUrl +
      '" alt="' +
      escapedTitle +
      '" loading="lazy" decoding="async" onerror="this.style.display=\'none\';if(this.nextElementSibling)this.nextElementSibling.style.display=\'\';" />' +
      '<span class="widget-fallback" style="display:none;">' +
      serviceIconMarkup(GENERIC_ICON_ID) +
      '</span>'
    );
  }

  /**
   * The mark a record wears: the generic fallback mark.
   */
  function resolveServiceIcon(storedId, title, url) {
    return normalizeServiceIcon(storedId);
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
      icon: resolveServiceIcon(opts.icon, name, href)
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

      // The orbit is not the greeting's to rebuild: hand the master switch to the apps
      // controller, which knows how to unplace, dismiss and re-deal it.
      if (widgetsRef && touched.widgets) {
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

  /** The arrow that marks a row as leaving the wallpaper for the browser. */
  const ARROW_MARKUP =
    '<svg class="widget-row-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>';

  /* ----------------------------------------------------------------------- *
   * Apps controller
   * ------------------------------------------------------------------------ */

  /**
   * Wire the `+` satellite and every app the user keeps to the frosted Apps card.
   *
   * One controller, because the parts that matter — whether the card is up, who had
   * focus, where the native host may take a click, Escape and click-outside — belong to
   * the wallpaper rather than to an app. An app is not a card: it is a bare glyph that
   * leaves for the default browser (`openExternal`), and the card is the one place apps
   * are added, launched and forgotten.
   *
   * `options.config` is the resolved configuration: the master `widgets` switch decides
   * whether the orbit is on the desktop from the first frame, and `applyConfig()` keeps
   * it in step with every later push.
   *
   * Returns `null` when the page has no orbit at all (an older index.html, a host page
   * that stripped it): a wallpaper without apps is still a wallpaper, and the greeting
   * must not fail because of a missing button.
   */
  function createWidgets(win, doc, options) {
    const bar = doc.getElementById('widget-bar');
    const backdrop = doc.getElementById('widget-backdrop');
    const modal = doc.getElementById('widget-modal');
    const body = doc.getElementById('widget-modal-body');
    const closeNode = doc.getElementById('widget-modal-close');
    if (!bar || !backdrop || !modal || !body) return null;

    // The one control the markup declares. Every other satellite in the ring is created
    // from `state.services` below, so the orbit and the card's list can never disagree.
    const addButton = bar.querySelector('.widget-btn-add');
    if (!addButton) return null;
    const serviceButtons = [];

    const storage = getStorage(win);
    const config = (options && options.config) || {};
    // The hand belongs to the desktop, not to the page load: the seed that dealt it is
    // read back before the first deal, so a reload, a relaunch or another app opening
    // never rolls a new constellation. A fresh install rolls one seed and keeps it.
    const storedSeed = readWidgetSeed(storage);
    const seed = storedSeed || Math.floor(Math.random() * 0xfffffffe) + 1;
    if (!storedSeed) writeWidgetSeed(storage, seed);
    const state = {
      // The orbit's master switch. Off means "not on this desktop": nothing is placed,
      // nothing is reported as clickable and the card cannot be opened.
      enabled: config.widgets !== false,
      // Whether the first deal has happened yet: the initial `applyConfig()` call sets
      // the master flag up before anything is measured, so it must not deal.
      started: false,
      // Whether the Apps card is up. There is exactly one card, so a boolean is the whole
      // of it; `isOpen()` and `activeId()` are its read-only spellings.
      open: false,
      lastFocus: null,
      hitFrame: 0,
      revealed: false,
      textObserver: null,
      // The user's own apps: read once from `localStorage`, then owned here. The draft and
      // the message belong to the card, so a half-typed address and a validation line
      // survive the card re-rendering under them.
      services: readCustomServices(storage),
      // How often each app has been launched: read once, then kept in step with every
      // click. It is the ranking the S/M/L footprints are drawn from.
      usage: readWidgetUsage(storage),
      serviceError: '',
      serviceDraft: { title: '', url: '' },
      // One arrangement per desktop: the seed is rolled by the first run — or by a new
      // app — and kept, so the page never deals itself a different wallpaper.
      seed: seed,
      // The spot each satellite wears, in viewport pixels, keyed by the id it is counted
      // under. Read back with the seed, so a reload wears the same hand.
      positions: readWidgetPositions(storage),
      // The viewport the hand was dealt on: a screen that changes shape is dealt a hand
      // that fits inside it, rather than one that hangs off the edge.
      viewportWidth: win.innerWidth || 0,
      viewportHeight: win.innerHeight || 0
    };

    /* --- tiny DOM helpers -------------------------------------------------- */

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

    /** The card's one message line: a refusal is the same box in a warmer ink. */
    function stateRow(text, options) {
      const settings = options || {};
      const row = el('p', 'widget-state' + (settings.error ? ' widget-state--error' : ''));
      row.appendChild(el('span', null, text));
      return row;
    }

    function rowList(rows) {
      const list = el('div', 'widget-rows');
      rows.forEach(function (row) {
        list.appendChild(row);
      });
      return list;
    }

    /* --- the orbit --------------------------------------------------------- */

    /** Every element in the orbit: the `+`, then the user's apps in list order. */
    function orbitElements() {
      return [addButton].concat(serviceButtons);
    }

    /** The orbit elements on the desktop right now; `hidden` is the settings' doing. */
    function placedButtons() {
      return orbitElements().filter(function (button) {
        return !button.hidden;
      });
    }

    /* --- footprint tiers --------------------------------------------------- */

    /**
     * The id a satellite's opens are counted under.
     *
     * An app is its `data-service` handle. The `+` has none and is deliberately left out
     * of the ranking: adding an app is not using one, and letting it in would drag the
     * least-opened app's count to zero and make a single open look like a hierarchy.
     */
    function usageIdOf(button) {
      return button.getAttribute('data-service') || '';
    }

    /**
     * The S/M/L tier of each element in `elements`, in the same order.
     *
     * An element without an id is left out of the ranking altogether and wears the
     * baseline, so it never competes with the apps it sits beside.
     */
    function sizeTiers(elements) {
      const ids = elements.map(usageIdOf);
      const ranked = ids.filter(function (id) {
        return Boolean(id);
      });
      const tiers = computeWidgetSizes(ranked, state.usage);
      let cursor = 0;
      return ids.map(function (id) {
        if (!id) return 'm';
        const tier = tiers[cursor];
        cursor += 1;
        return tier || 'm';
      });
    }

    /** Wear one tier: a class for style.css and an attribute for anyone watching. */
    function wearSizeTier(button, tier) {
      const name = WIDGET_SIZE_TIERS.indexOf(tier) === -1 ? 'm' : tier;
      WIDGET_SIZE_TIERS.forEach(function (other) {
        button.classList.remove('is-size-' + other);
      });
      button.classList.add('is-size-' + name);
      button.setAttribute('data-size', name);
    }

    /**
     * Count one launch and wear the tiers it changed.
     *
     * The footprints are what the user earns by using the wallpaper: launch the same app
     * a few times and it grows, leave one alone and it shrinks. A tier change re-applies
     * the hand — the glyph changes size where it stands, and nothing else on the desktop
     * moves, which is what keeps the card the user is reading from being pulled out from
     * under it.
     */
    function noteUsage(id) {
      if (!id) return;
      const before = sizeTiers(placedButtons()).join('');
      const tally = recordWidgetUsage(storage, id);
      // The store is the record whenever it works — so a host script that clears the
      // tally is honoured on the next launch — and the page's own copy is the fallback for
      // a blocked `localStorage`, which still ranks what this session opened.
      const stored = readWidgetUsage(storage);
      state.usage = stored[normalizeWidgetUsageId(id)]
        ? stored
        : Object.assign({}, state.usage, tally);
      if (sizeTiers(placedButtons()).join('') !== before) scatter();
    }

    /** An app's satellite: a bare glyph in the ring, exactly like the `+` beside it. */
    function createServiceButton(service) {
      const button = el('button', 'widget-btn widget-btn-service');
      button.type = 'button';
      button.id = 'widget-btn-' + service.id;
      button.setAttribute('data-service', service.id);
      button.title = service.title;
      button.setAttribute('aria-label', 'Open ' + service.title + ' in your browser');

      // The drift is per-satellite: every app breathes out of step with its neighbours,
      // from values derived from its place in the list, so the orbit looks the same on
      // every load instead of reshuffling.
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
        // An app is not a card: it leaves for the default browser through the same native
        // bridge the card's own rows use, so the wallpaper never loads the site.
        const opened = openExternal(win, service.url);
        // …and it counts as a launch, so the footprint follows how often it is actually
        // reached for. Its handle is positional, like every app's, so the tally follows
        // the slot in the list.
        if (opened) noteUsage(service.id);
      });
      return button;
    }

    /** Rebuild the app satellites from `state.services`, in list order. */
    function rebuildServiceButtons() {
      while (serviceButtons.length > 0) {
        const stale = serviceButtons.pop();
        if (stale.parentNode) stale.parentNode.removeChild(stale);
      }
      state.services.forEach(function (service) {
        const button = createServiceButton(service);
        bar.appendChild(button);
        serviceButtons.push(button);
      });
    }

    /**
     * Adopt a new list: cache it, rebuild the ring and — when the list grew — deal the
     * satellites again.
     *
     * A new app is the only thing that rearranges the desktop: it rolls a new seed and
     * deals the whole orbit around the newcomer. An app that was removed leaves every
     * other glyph on exactly the pixels it was wearing, and the card is rebuilt in place
     * when it is the card that asked, so a delete disappears from the list the moment it
     * is pressed without the ring closing the gap behind it.
     */
    function commitServices(next, options) {
      const settings = options || {};
      state.services = next.slice(0, MAX_CUSTOM_SERVICES);
      writeCustomServices(storage, state.services);
      rebuildServiceButtons();
      if (state.open) renderCard();
      scatter({ isNewApp: Boolean(settings.isNewApp) });
      // The caret goes back to the first field when the form is what committed, so a
      // second app can be typed without reaching for the mouse again.
      if (state.open && settings.focus) refocusAddField();
      return state.services;
    }

    /** Add an app from a host script or the console; `null` when it cannot be added. */
    function addService(title, url) {
      if (state.services.length >= MAX_CUSTOM_SERVICES) return null;
      const service = createCustomService(title, url, { index: state.services.length + 1 });
      if (!service) return null;
      const duplicate = state.services.some(function (existing) {
        return existing.url === service.url;
      });
      if (duplicate) return null;
      commitServices(state.services.concat([service]), { isNewApp: true });
      return service;
    }

    /** Forget one app. Returns whether the list changed. */
    function removeService(id) {
      const next = state.services.filter(function (service) {
        return service.id !== id;
      });
      if (next.length === state.services.length) return false;
      // The app takes its spot with it; its neighbours keep exactly theirs.
      state.positions = withoutWidgetPosition(state.positions, id);
      writeWidgetPositions(storage, state.positions);
      commitServices(next);
      return true;
    }

    /** `true` while an address is already on the desktop. */
    function hasServiceUrl(url) {
      const address = normalizeServiceUrl(url);
      if (!address) return false;
      return state.services.some(function (service) {
        return service.url === address;
      });
    }

    /** Put the caret back in the first field after the card rebuilt itself. */
    function refocusAddField() {
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
     * Wear the hand the desktop was dealt.
     *
     * The arrangement belongs to the desktop, not to the page load. The seed that dealt
     * it and the spot each glyph wears are cached (`dynawall.widgetSeed`,
     * `dynawall.widgetPositions`), and every deal that is not a new app re-applies them
     * exactly: a reload, an app launch, a card closing, a tier change or an app being
     * removed never moves a glyph the user did not ask to move.
     *
     * `options.isNewApp` is the one thing that changes the composition: it rolls a new
     * seed and deals every satellite again, so the newcomer has a place among them and
     * the ring closes around the larger hand. A screen that changed shape is dealt again
     * from the same seed — inside its new bounds and clear of the greeting — rather than
     * reshuffled, and a greeting that grew over a satellite asks for the same re-deal
     * (`options.reflow`).
     *
     * Below the breakpoint style.css docks them in a row, and no inline position is
     * written at all — the properties are removed and the media query decides.
     *
     * Switched off there is nothing to place (and no fade-in to arm), so the deal waits
     * until the master switch comes back on and `applyConfig()` calls it again.
     *
     * Each one is dealt at its own footprint: the S, M and L tiers the launch tally
     * earned are applied before anything is measured, so the engine knows how much room
     * every glyph really needs and can balance the two flanks by the weight on them.
     */
    function scatter(options) {
      if (!state.enabled) return;

      reveal();

      const active = placedButtons();
      if (active.length === 0) {
        scheduleHitRegions();
        return;
      }

      // The footprints first: a satellite's size is what the ring, the collision padding
      // and the greeting's clearance are all measured against, so the classes have to be
      // on before anything is read back out of the layout.
      const tiers = sizeTiers(active);
      active.forEach(function (button, index) {
        wearSizeTier(button, tiers[index]);
      });

      if (isNarrow()) {
        orbitElements().forEach(function (button) {
          button.style.removeProperty('--widget-x');
          button.style.removeProperty('--widget-y');
        });
        scheduleHitRegions();
        return;
      }

      const settings = options || {};
      const width = win.innerWidth || 0;
      const height = win.innerHeight || 0;
      const size = satelliteSize();
      if (width <= 0 || height <= 0 || size <= 0) return;

      // A hand still the shape of this desktop is worn as it is: same pixels, same
      // glyphs, same wallpaper. This is the path every open, every tier change, every
      // removal and every reload takes — a new footprint or a new card must never
      // rearrange the desktop out from under the user.
      const resized = width !== state.viewportWidth || height !== state.viewportHeight;
      const fits =
        !settings.isNewApp &&
        !settings.reflow &&
        !resized &&
        coversWidgetPositions(state.positions, active.map(usageIdOf), {
          width: width,
          height: height
        });
      if (fits) {
        active.forEach(function (button) {
          const spot = widgetPositionOf(state.positions, usageIdOf(button));
          if (!spot) return;
          button.style.setProperty('--widget-x', spot.x + 'px');
          button.style.setProperty('--widget-y', spot.y + 'px');
        });
        scheduleHitRegions();
        return;
      }

      // A new app is a new composition: a fresh seed, so the whole orbit is dealt again
      // around the newcomer instead of keeping a gap it was never part of.
      if (settings.isNewApp) {
        state.seed = Math.floor(Math.random() * 0xfffffffe) + 1;
        writeWidgetSeed(storage, state.seed);
      }

      // One footprint per glyph, in the order they are dealt. A satellite the browser has
      // not laid out yet falls back to the first measured one, so a single missing box
      // cannot take the whole ring with it.
      const sizes = active.map(function (button) {
        const measured = button.offsetWidth;
        return measured > 0 ? measured : size;
      });

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
        sizes: sizes,
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

      // Where each glyph ended up, keyed by the id it is counted under: this is the hand
      // the next reload wears, the one a tier change re-applies and the one a removal
      // edits instead of re-dealing.
      const positions = {};
      active.forEach(function (button, index) {
        const point = points[index];
        if (!point) return;
        const spot = { x: Math.round(point.x), y: Math.round(point.y) };
        button.style.setProperty('--widget-x', spot.x + 'px');
        button.style.setProperty('--widget-y', spot.y + 'px');
        const id = usageIdOf(button);
        if (id) positions[id] = spot;
      });
      state.positions = positions;
      state.viewportWidth = width;
      state.viewportHeight = height;
      writeWidgetPositions(storage, state.positions);
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
     * While the card is down the wallpaper window ignores the mouse entirely
     * (`ignoresMouseEvents` on macOS, a click-through desktop layer on Windows), which is
     * what keeps Finder drag-select, right-click, desktop icons and Mission Control
     * working. That also means the page never sees the cursor, so it cannot notice a
     * hover by itself: the host watches the pointer and only needs the rectangles that
     * should intercept a click. They travel as viewport CSS pixels, inflated by
     * `HIT_PADDING` so the rim of a button — and its 0.3 rem drift — does not flicker in
     * and out.
     *
     * While the card is up the whole viewport is reported, because the backdrop is itself
     * a click target: clicking anywhere outside the card closes it. That report is also
     * what hands the display its mouse and keyboard on macOS — the host stops being
     * click-through for as long as the card is up, so the field under the pointer takes a
     * caret and the typing (and `Esc`, and `⌘V`) reaches the page.
     *
     * With the orbit switched off nothing is reported at all: the host then keeps every
     * click for the desktop, which is exactly what "no apps" should mean.
     */
    function publishHitRegions() {
      const handlers = win.webkit && win.webkit.messageHandlers;
      const webkit = handlers && handlers.dynawallInteractivity;
      const webview = win.chrome && win.chrome.webview;
      const webview2 = webview && typeof webview.postMessage === 'function';
      if (!webkit && !webview2) return;

      const open = state.enabled && state.open;
      const width = win.innerWidth || 0;
      const height = win.innerHeight || 0;
      const regions = [];

      if (open) {
        regions.push([0, 0, width, height]);
      } else if (state.enabled) {
        // Every glyph on the orbit is a target — the `+` and each app — and nothing else
        // is: the rest of the wallpaper stays click-through.
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

      // A synthetic click has no default action: focus the control by hand, so a field in
      // the Apps card takes the keystrokes the host forwards.
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
      // included) that a dispatched `MouseEvent` never does, which is what makes "Add"
      // work when a click arrives this way.
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

    /** Hand the focus to the dialog: Tab then starts at the close button, or `Esc` leaves. */
    function focusModal() {
      try {
        modal.focus({ preventScroll: true });
      } catch (error) {
        try {
          modal.focus();
        } catch (ignored) {
          /* A host that refuses focus; the card still works with the mouse. */
        }
      }
    }

    /** Give the focus back to whatever had it before the card came up — usually the `+`. */
    function restoreFocus() {
      const previous = state.lastFocus;
      state.lastFocus = null;
      if (!previous || typeof previous.focus !== 'function') return;
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

    /**
     * Put the Apps card up.
     *
     * There is one card and one way in — the `+` — so an open needs no id: it is the
     * card, or it is nothing. `openWidget()` still takes one, because a host script asks
     * for a card by name and `APPS_CARD_ID` is the only name that answers.
     */
    function openCard() {
      if (state.open) return true;
      state.open = true;
      state.lastFocus = doc.activeElement;
      // A card always opens clean: no message left over from the last time it was up, and
      // an empty form rather than the half-typed address the user abandoned.
      state.serviceError = '';
      state.serviceDraft = { title: '', url: '' };
      addButton.setAttribute('aria-expanded', 'true');
      backdrop.classList.add('is-open');
      backdrop.setAttribute('aria-hidden', 'false');
      renderCard();
      scheduleHitRegions();
      focusModal();
      return true;
    }

    function closeCard() {
      if (!state.open) return false;
      state.open = false;
      addButton.setAttribute('aria-expanded', 'false');
      backdrop.classList.remove('is-open');
      backdrop.setAttribute('aria-hidden', 'true');
      // A closed card keeps neither a half-typed address nor a message in the heap: the
      // body is rebuilt on the next open.
      state.serviceError = '';
      state.serviceDraft = { title: '', url: '' };
      clearBody();
      scheduleHitRegions();
      restoreFocus();
      return true;
    }

    function clearBody() {
      while (body.firstChild) body.removeChild(body.firstChild);
    }

    /**
     * Open the Apps card by its reserved id.
     *
     * A host script written for the old built-in providers asks for `music` or `weather`;
     * there is no such card any more, so an unknown id is refused (`false`) instead of
     * opening a card with no anchor. A switched-off orbit answers `false` too: the card
     * is not on the desktop, so there is nothing to open.
     */
    function openWidget(id) {
      if (id !== APPS_CARD_ID) return false;
      if (!state.enabled) return false;
      return openCard();
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
      if (!state.open) return;
      const key = event.key;
      if (key === 'Escape' || key === 'Esc') {
        event.preventDefault();
        closeCard();
        return;
      }
      if (key === 'Tab') trapFocus(event);
    }

    /* --- the card ---------------------------------------------------------- */

    /**
     * Paint the card: the presets, the form, and the apps the user keeps.
     *
     * The order is the gesture: press a chip if the app is one of the ones everybody
     * keeps, type an address if it is not, then read the list back — one row per glyph,
     * so adding an app and watching the orbit grow is the same act seen twice.
     */
    function renderCard() {
      clearBody();
      body.appendChild(section('Quick add', presetChips()));
      body.appendChild(section('Or paste an address', serviceForm()));
      if (state.serviceError) body.appendChild(stateRow(state.serviceError, { error: true }));
      body.appendChild(
        section(
          'Your apps',
          state.services.length > 0
            ? rowList(state.services.map(serviceRow))
            : stateRow('Nothing here yet. Press a chip above, or paste an address.')
        )
      );
      body.appendChild(
        note(
          'An app opens in your default browser. The wallpaper never loads the site, so nothing about it is fetched until you press it.'
        )
      );
    }

    /**
     * The one-tap presets.
     *
     * A preset is nothing but a name and an `https` address: pressing a chip runs the very
     * same `addServiceFromValues()` a typed address does, so a preset can never create a
     * record the form could not. A preset that is already on the desktop wears its state
     * (pressed, and not pressable) instead of disappearing, so the row of chips never
     * reflows under the pointer.
     */
    function presetChips() {
      const chips = el('div', 'widget-chips');
      APP_PRESETS.forEach(function (preset) {
        const added = hasServiceUrl(preset.url);
        const chip = el('button', 'widget-chip', preset.title);
        chip.type = 'button';
        chip.setAttribute('aria-pressed', added ? 'true' : 'false');
        chip.setAttribute(
          'aria-label',
          added ? preset.title + ' is already on your desktop' : 'Add ' + preset.title
        );
        if (added) chip.disabled = true;
        chip.addEventListener('click', function () {
          addServiceFromValues(preset.title, preset.url);
        });
        chips.appendChild(chip);
      });
      return chips;
    }

    /**
     * The add form: a name, an address and one button.
     *
     * The address is validated before it is stored (`normalizeServiceUrl`), and the
     * message under the fields says why when it is refused: a wallpaper opens nothing but
     * a plain `https` page, so a paste of `javascript:` or a bare `github.com` is turned
     * away instead of quietly repaired. The name is optional — an address already knows
     * what to call itself (`serviceHostLabel`).
     */
    function serviceForm() {
      const form = el('form', 'widget-service-form');

      const nameInput = el('input', 'widget-input');
      nameInput.type = 'text';
      nameInput.placeholder = 'Name (optional)';
      nameInput.setAttribute('aria-label', 'App name');
      nameInput.setAttribute('autocomplete', 'off');
      nameInput.spellcheck = false;
      nameInput.value = state.serviceDraft.title;

      const field = el('div', 'widget-field');
      const urlInput = el('input', 'widget-input');
      urlInput.type = 'url';
      urlInput.placeholder = 'https://example.com';
      urlInput.setAttribute('aria-label', 'App address');
      urlInput.setAttribute('autocomplete', 'off');
      urlInput.spellcheck = false;
      urlInput.value = state.serviceDraft.url;

      const submitButton = el('button', 'widget-submit', 'Add');
      submitButton.type = 'submit';

      function submitDraft() {
        state.serviceDraft = { title: nameInput.value, url: urlInput.value };
        addServiceFromValues(state.serviceDraft.title, state.serviceDraft.url);
      }

      field.appendChild(urlInput);
      field.appendChild(submitButton);
      form.appendChild(nameInput);
      form.appendChild(field);
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        submitDraft();
      });
      // A replayed click is synthetic, so the button answers it itself instead of relying
      // on an implicit form submission that never comes.
      submitButton.addEventListener('click', function (event) {
        event.preventDefault();
        submitDraft();
      });
      return form;
    }

    /**
     * Store an app from its parts, or say why it cannot be stored.
     *
     * One path for the form and the preset chips, so the two can never disagree about
     * what an app is: the address is validated, a duplicate is refused by address rather
     * than by name, and the message below the fields says which of the two happened.
     */
    function addServiceFromValues(title, url) {
      if (state.services.length >= MAX_CUSTOM_SERVICES) {
        failService('The desktop holds ' + MAX_CUSTOM_SERVICES + ' apps. Remove one to add another.');
        return false;
      }
      const address = normalizeServiceUrl(url);
      if (!address) {
        failService('Paste the whole address, beginning with https. Nothing else is ever opened.');
        return false;
      }
      const name = clipText(title, MAX_SERVICE_TITLE) || serviceHostLabel(address);
      const service = createCustomService(name, address, { index: state.services.length + 1 });
      if (!service) {
        failService('That address cannot be turned into an app.');
        return false;
      }
      if (hasServiceUrl(service.url)) {
        failService('That address is already on your desktop.');
        return false;
      }
      state.serviceError = '';
      state.serviceDraft = { title: '', url: '' };
      commitServices(state.services.concat([service]), { isNewApp: true, focus: true });
      return true;
    }

    /** Show why the draft was refused, keeping what the user typed in the fields. */
    function failService(message) {
      state.serviceError = message;
      if (state.open) renderCard();
      refocusAddField();
    }

    /** One row: the app's mark, its name and address, and the way to forget it. */
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
        if (openExternal(win, service.url)) noteUsage(service.id);
      });

      const remove = el('button', 'widget-service-remove');
      remove.type = 'button';
      remove.title = 'Remove ' + service.title;
      remove.setAttribute('aria-label', 'Remove ' + service.title + ' from the desktop');
      remove.insertAdjacentHTML('beforeend', REMOVE_MARKUP);
      remove.addEventListener('click', function () {
        removeService(service.id);
      });

      row.appendChild(open);
      row.appendChild(remove);
      return row;
    }

    /* --- wiring ------------------------------------------------------------ */

    // The `+` is the whole way in: pressing it opens the card, pressing it again dismisses
    // it, exactly like a toggle on the desktop. The close button and the backdrop say the
    // same thing in the two other places a user reaches for.
    addButton.addEventListener('click', function (event) {
      event.preventDefault();
      if (state.open) closeCard();
      else openCard();
    });

    if (closeNode) {
      closeNode.addEventListener('click', function () {
        closeCard();
      });
    }

    // Clicking the dimmed wallpaper outside the card closes it, like a native panel; a
    // click inside the card must not bubble out and dismiss it.
    backdrop.addEventListener('click', function (event) {
      if (event.target === backdrop) closeCard();
    });
    modal.addEventListener('click', function (event) {
      event.stopPropagation();
    });

    doc.addEventListener('keydown', onKeyDown);

    // The apps become satellites before the first deal, so the orbit opens with the set
    // the user keeps instead of appearing to grow a moment later.
    rebuildServiceButtons();

    // Adopt the settings before the first deal, so the page opens with exactly the desktop
    // the user picked — no flash of an orbit on its way out.
    applyConfig(config);

    // Wear the first hand, then hold it: `scatter()` measures the greeting and the
    // viewport, so it has to run again when either changes shape — and only then, so a
    // deal never moves a satellite the user did not ask to move. The resize is debounced —
    // a live drag would otherwise re-deal on every frame — while the hit regions are
    // refreshed immediately, so a click during the drag still lands.
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
      // The entrance slides and scales `.wallpaper-content` for 900 ms, so the satellite
      // rectangles measured before it settled sit a few pixels off. Re-measure when that
      // transition lands — once, not on every frame.
      contentNode.addEventListener('transitionend', function (event) {
        if (event.target === contentNode) scheduleHitRegions();
      });

      // A longer name, a different greeting or the webfont finally arriving all change how
      // wide the text block is, and can grow it over a satellite. Watch for that and deal
      // again rather than letting the greeting collide.
      if (typeof win.ResizeObserver === 'function') {
        state.textObserver = new win.ResizeObserver(function () {
          if (!isNarrow() && coversText()) scatter({ reflow: true });
        });
        state.textObserver.observe(contentNode);
      }
    }

    /**
     * The orbit's master switch — the `widgets` setting, live.
     *
     * Every host reaches this through the same configuration field, so the "Desktop apps"
     * switch in the macOS popover, in the Windows window, in Lively and in Wallpaper
     * Engine, plus `?widgets=false` and `DynaWall.setWidgetsEnabled()`, all land here. Off
     * is `is-widgets-off` on the root: the orbit is not faded out but removed, so nothing
     * drifts, nothing is left to click, and `publishHitRegions()` reports an empty list —
     * the desktop underneath is the Finder's again.
     *
     * Switched back on, the apps are worn as the hand has them: they appear on exactly the
     * pixels they were dealt, rather than being re-dealt behind the user's back.
     *
     * Returns the switch in force.
     */
    function applyConfig(next) {
      const source = next || {};
      const master = source.widgets !== false;
      const changed = master !== state.enabled;
      state.enabled = master;

      const root = doc.documentElement;
      if (root && root.classList) {
        if (master) root.classList.remove('is-widgets-off');
        else root.classList.add('is-widgets-off');
      }

      // The `+` leaves with the orbit. `hidden` rather than `opacity: 0`, because a
      // switched-off orbit must not be measured or clicked either.
      const hide = !master;
      if (addButton.hidden !== hide) addButton.hidden = hide;

      if (!master && state.open) closeCard();

      // Before the first deal there is nothing to re-deal: creation scatters once at the
      // end, with the switch above already in place.
      if (!changed || !state.started) return state.enabled;

      if (master) scatter();
      else scheduleHitRegions();
      return state.enabled;
    }

    scheduleHitRegions();

    return {
      /** `true` while the Apps card is on screen. */
      isOpen: function () {
        return state.open;
      },
      /** The open card's id — `apps`, or `''` when the card is down. */
      activeId: function () {
        return state.open ? APPS_CARD_ID : '';
      },
      /** Whether the orbit is on the desktop right now. */
      enabled: function () {
        return state.enabled;
      },
      /** The apps in the orbit, as `{ id, title, url, icon }`. */
      services: function () {
        return state.services.map(function (service) {
          return { id: service.id, title: service.title, url: service.url, icon: service.icon };
        });
      },
      /** The quick-add presets, as `{ title, url }` — the list the chips are cut from. */
      presets: function () {
        return APP_PRESETS.map(function (preset) {
          return { title: preset.title, url: preset.url };
        });
      },
      /** Add an app and deal it into the ring; `null` when it cannot be added. */
      addService: addService,
      /** Forget an app; whether the list changed. */
      removeService: removeService,
      applyConfig: applyConfig,
      open: openWidget,
      close: closeCard,
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

    /* The orbit. The card's reserved id and the presets it offers, then the pure half of
       the placement — the scatter, the seed and the tally — so the headless tests can
       hold them to account without a DOM or a layout engine. */
    APPS_CARD_ID: APPS_CARD_ID,
    APP_PRESETS: APP_PRESETS,
    WIDGET_NARROW_QUERY: WIDGET_NARROW_QUERY,
    /** The three footprints a satellite can wear, smallest first (`s`, `m`, `l`). */
    WIDGET_SIZE_TIERS: WIDGET_SIZE_TIERS,
    /**
     * Where the satellites' click tally is cached — outside `STORAGE_KEYS`, because it
     * is earned on the wallpaper rather than pushed by a host control.
     */
    WIDGET_USAGE_KEY: WIDGET_USAGE_KEY,
    MAX_WIDGET_USAGE: MAX_WIDGET_USAGE,
    normalizeWidgetUsage: normalizeWidgetUsage,
    readWidgetUsage: readWidgetUsage,
    writeWidgetUsage: writeWidgetUsage,
    recordWidgetUsage: recordWidgetUsage,
    clearWidgetUsage: clearWidgetUsage,
    computeWidgetSizes: computeWidgetSizes,
    /**
     * Where the hand the satellites were dealt is cached — the seed that dealt it and the
     * spot each glyph wears — plus the pure half that reads it: a host script can see, or
     * forget, exactly the arrangement the page is wearing.
     */
    WIDGET_SEED_KEY: WIDGET_SEED_KEY,
    WIDGET_POSITIONS_KEY: WIDGET_POSITIONS_KEY,
    normalizeWidgetSeed: normalizeWidgetSeed,
    readWidgetSeed: readWidgetSeed,
    writeWidgetSeed: writeWidgetSeed,
    normalizeWidgetPositions: normalizeWidgetPositions,
    readWidgetPositions: readWidgetPositions,
    writeWidgetPositions: writeWidgetPositions,
    clearWidgetPositions: clearWidgetPositions,
    widgetPositionOf: widgetPositionOf,
    withoutWidgetPosition: withoutWidgetPosition,
    coversWidgetPositions: coversWidgetPositions,
    scatterWidgets: scatterWidgets,
    createRandom: createRandom,

    /* Apps. The same pure half the Apps card uses, so a host script and a paste into the
       card can never disagree about what a legal app is. */
    CUSTOM_SERVICES_KEY: CUSTOM_SERVICES_KEY,
    MAX_CUSTOM_SERVICES: MAX_CUSTOM_SERVICES,
    MAX_SERVICE_TITLE: MAX_SERVICE_TITLE,
    SERVICE_ICONS: SERVICE_ICONS,
    GENERIC_ICON_ID: GENERIC_ICON_ID,
    normalizeServiceUrl: normalizeServiceUrl,
    normalizeServiceIcon: normalizeServiceIcon,
    resolveServiceIcon: resolveServiceIcon,
    serviceIconId: serviceIconId,
    serviceIconMarkup: serviceIconMarkup,
    serviceMonogram: serviceMonogram,
    serviceGlyphMarkup: serviceGlyphMarkup,
    serviceFaviconUrl: serviceFaviconUrl,
    serviceHostName: serviceHostName,
    serviceHostLabel: serviceHostLabel,
    createCustomService: createCustomService,
    normalizeCustomServices: normalizeCustomServices,
    serializeCustomServices: serializeCustomServices,
    readCustomServices: readCustomServices,
    writeCustomServices: writeCustomServices,
    clipText: clipText,
    openExternal: openExternal,

    /** Open the Apps card from the console or from a host script. */
    openWidget: function (id) {
      return widgetsRef ? widgetsRef.open(id) : false;
    },
    /** Close the Apps card. */
    closeWidget: function () {
      return widgetsRef ? widgetsRef.close() : false;
    },
    /**
     * Turn the whole orbit on or off, exactly like the host's master switch.
     *
     * The value travels through the same update path a Lively/Wallpaper Engine property
     * takes, so it is cached in `localStorage` and both the page and the controller agree
     * on it afterwards. Returns the state now in force.
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
    /** `true` while the orbit is on the desktop. */
    widgetsEnabled: function () {
      return widgetsRef ? widgetsRef.enabled() : false;
    },
    /** The quick-add presets, as `{ title, url }`. */
    appPresets: function () {
      return widgetsRef ? widgetsRef.presets() : [];
    },
    /**
     * The apps in the orbit, as `{ id, title, url, icon }`.
     *
     * They are the user's own list, cached in `localStorage` rather than pushed by a
     * host: an app is added on the wallpaper (the `+` satellite's card) or through the
     * two calls below, never from a popover.
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

      // The orbit is wired after the wallpaper itself is running: a card must never be
      // able to stop the greeting, so a failure here leaves a perfectly good wallpaper
      // with one inert `+` instead of a blank screen. It starts in the state the
      // configuration asked for: the master switch decides what is placed, drifted and
      // reported as clickable.
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
