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
 * (the macOS app) hands the page its resolved list on every load and the page
 * falls back to the photos bundled in `images/` when no host speaks up.
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
    // Sources injected by the macOS host (absolute scheme URLs); empty = bundled set.
    photos: []
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
    photoSync: 'dynawall.photoSync'
    // `photos` is deliberately not cached: the host re-sends it on every load.
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

  /** The photos that ship with the wallpaper, used when no host list arrives. */
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
   */
  function resolveIpcFieldValue(field, rawValue) {
    const value = normalizeFieldValue(field, rawValue);
    if (value !== undefined) return value;
    if (field === 'firstName' && typeof rawValue === 'string') {
      return DEFAULT_CONFIG.firstName;
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
    dynamicphotos: 'photoSync'
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
    photosync: 'photoSync'
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
      photoSignature: ''
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

    /** Host-provided sources win; otherwise the photos bundled with the wallpaper. */
    function photoSources() {
      const custom = state.config.photos;
      return custom && custom.length > 0 ? custom : BUNDLED_PHOTOS;
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

    /** Paint a photo on the spare layer, then cross-fade the two layers. */
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
      layer.src = sources[index];

      const reveal = function () {
        if (stale()) return;
        state.photoFailures = 0;
        layer.classList.add('is-visible');
        if (previous && previous !== layer) previous.classList.remove('is-visible');
        reportPhoto(layer);
      };

      // A file the browser cannot decode must never put a blank layer on screen:
      // skip ahead instead, and give up (back to the plain background) if nothing
      // in the list can be rendered at all.
      const skip = function () {
        if (stale()) return;
        state.photoFailures += 1;
        if (state.photoFailures >= sources.length) {
          state.photoFailures = 0;
          state.photoSignature = '';
          doc.body.classList.remove('has-photo');
          clearPhotos();
          return;
        }
        scheduleSlide(50);
      };

      // decode() settles only once the bitmap is ready, so the fade never shows a gap.
      if (typeof layer.decode === 'function') {
        layer.decode().then(reveal, skip);
      } else {
        reveal();
      }
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
    mapWallpaperEngineProperties: mapWallpaperEngineProperties
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
