/**
 * DynaWall — a minimalist, time-aware live wallpaper.
 *
 * Zero dependencies. Runs in a browser, Lively Wallpaper and Wallpaper Engine.
 *
 * Configuration priority (highest wins):
 *   1. Lively / Wallpaper Engine IPC  (livelyPropertyListener / wallpaperPropertyListener)
 *   2. URL query parameters           (?name=Alex&slideshow=true&photos=a.jpg,b.jpg)
 *   3. localStorage cache             (dynawall.firstName, dynawall.slideshow, ...)
 *   4. Built-in defaults              (firstName: "Developer", slideshow: false)
 *
 * Photo sources follow the same rule, except `photos` is never cached: a host
 * (the macOS app) hands the page its resolved list on every load and the page
 * falls back to the photos bundled in `images/` when no host speaks up.
 *
 * Time awareness: the greeting period (morning/afternoon/evening) and the palette
 * (dawn/day/dusk/night) are both read from the same clock and re-evaluated
 * together every 30 s, on wake and on focus. `theme` pins a single palette
 * instead of following the clock, and a background colour set by hand pins
 * `custom` — unless the same source names a theme.
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
    kenBurns: 'dynawall.kenBurns'
    // `photos` is deliberately not cached: the host re-sends it on every load.
  });

  /** The photos that ship with the wallpaper, used when no host list arrives. */
  const BUNDLED_PHOTOS = Object.freeze([
    'images/01-neon-dusk.jpg',
    'images/02-solar-flare.jpg',
    'images/03-deep-ocean.jpg',
    'images/04-mint-fog.jpg',
    'images/05-candy-sky.jpg',
    'images/06-graphite.jpg'
  ]);

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
  /** Shorthands people type in a URL; all mean "follow the clock". */
  const THEME_ALIASES = Object.freeze({ time: 'auto', clock: 'auto', dynamic: 'auto' });

  /** How often the clock is re-read: greeting period and palette (30 seconds). */
  const CLOCK_REFRESH_MS = 30 * 1000;
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

    const photos = [];
    raw.forEach((entry) => {
      if (typeof entry !== 'string') return;
      const url = entry.trim();
      if (!url || /\s/.test(url) || /^javascript:/i.test(url)) return;
      if (photos.indexOf(url) === -1) photos.push(url);
    });

    return photos.slice(0, MAX_PHOTOS);
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
    kenburns: 'kenBurns'
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
    kenburns: 'kenBurns'
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

  /** Merge the four layers: IPC → URL → localStorage → defaults. */
  function resolveConfig(layers) {
    const ipc = (layers && layers.ipc) || {};
    const url = (layers && layers.url) || {};
    const storage = (layers && layers.storage) || {};
    const defaults = (layers && layers.defaults) || DEFAULT_CONFIG;

    const config = {};
    Object.keys(DEFAULT_CONFIG).forEach((field) => {
      const resolved = firstDefined([ipc[field], url[field], storage[field], defaults[field]]);
      config[field] = resolved === undefined ? DEFAULT_CONFIG[field] : resolved;
    });

    // Picking a background colour by hand (URL, IPC or cache) is an explicit
    // override, so the palette stops following the clock instead of silently
    // discarding the colour. Naming a theme in the same source wins, which is how
    // a host asks for a palette and still keeps a colour for `custom`.
    const explicitTheme = firstDefined([ipc.theme, url.theme, storage.theme]);
    const explicitColor = firstDefined([ipc.bgColor, url.bgColor, storage.bgColor]);
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
    const value = normalizeFieldValue(field, rawValue);
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
      const value = normalizeFieldValue(field, raw);
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
        url: parseQueryParams(win.location ? win.location.search : ''),
        storage: readStoredConfig(storage),
        defaults: DEFAULT_CONFIG
      }),
      period: '',
      theme: '',
      renderedGreeting: '',
      greetingTimeout: 0,
      pendingGreeting: null,
      photoIndex: -1,
      photoLayer: 0,
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
        // Read the target from the custom property rather than the painted colour:
        // during the cross-fade the painted value is still the previous band, and
        // the browser chrome tint should never lag a whole transition behind.
        const target = win.getComputedStyle(root).getPropertyValue('--bg-primary').trim();
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
        photoSources().join('|')
      ].join('::');
    }

    /** Sequential order steps forward; shuffle never repeats the current photo. */
    function nextPhotoIndex(count) {
      if (count <= 1) return 0;
      if (state.config.slideshowShuffle) {
        let index = state.photoIndex;
        while (index === state.photoIndex) index = Math.floor(Math.random() * count);
        return index;
      }
      return (state.photoIndex + 1) % count;
    }

    /** Paint a photo on the spare layer, then cross-fade the two layers. */
    function paintPhoto(index) {
      const sources = photoSources();
      if (elements.photoLayers.length === 0 || !sources[index]) return;

      const previous = elements.photoLayers[state.photoLayer];
      state.photoLayer = (state.photoLayer + 1) % elements.photoLayers.length;
      const layer = elements.photoLayers[state.photoLayer];
      state.photoIndex = index;

      // A decode that lands after the list changed (host push, slideshow toggle)
      // must not fade, and must not count as a broken photo.
      const token = (state.photoToken += 1);
      const stale = function () {
        return token !== state.photoToken;
      };

      layer.classList.remove('is-visible', 'is-ken-burns');
      layer.style.removeProperty('--photo-duration');
      void layer.offsetWidth; // restart the drift from its first frame
      if (state.config.kenBurns && !prefersReducedMotion()) {
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
      const wait = typeof delay === 'number' ? delay : slideshowIntervalMs();
      state.photoTimer = win.setTimeout(advancePhoto, wait);
    }

    function advancePhoto() {
      if (!state.config.slideshow) return;
      const count = photoSources().length;
      if (count === 0) return;
      paintPhoto(nextPhotoIndex(count));
      scheduleSlide();
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

      const sources = photoSources();
      const enabled = Boolean(state.config.slideshow) && sources.length > 0;
      doc.body.classList.toggle('has-photo', enabled);
      clearPhotos();
      if (!enabled) return;

      const start = state.config.slideshowShuffle ? Math.floor(Math.random() * sources.length) : 0;
      paintPhoto(start);
      scheduleSlide();
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

      win.setInterval(syncClock, CLOCK_REFRESH_MS);

      // Timers throttle while hidden; resync as soon as the wallpaper is back.
      doc.addEventListener('visibilitychange', function () {
        if (doc.visibilityState !== 'visible') return;
        syncClock();
      });

      win.addEventListener('focus', function () {
        syncClock();
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
      checkGreetingPeriod: checkGreetingPeriod,
      checkTheme: checkTheme,
      syncClock: syncClock,
      advancePhoto: advancePhoto
    };
  }

  /* ----------------------------------------------------------------------- *
   * Host bridges (Lively Wallpaper / Wallpaper Engine)
   * ------------------------------------------------------------------------ */

  let appRef = null;
  const pendingUpdates = [];

  /** Feed host updates into the app, or queue them until it is ready. */
  function deliver(updates) {
    if (!updates || updates.length === 0) return;
    if (appRef) {
      appRef.applyUpdates(updates);
      return;
    }
    pendingUpdates.push(...updates);
  }

  function installBridges(win) {
    // Lively Wallpaper: window.livelyPropertyListener(name, value)
    win.livelyPropertyListener = function livelyPropertyListener(name, value) {
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
    THEMES: THEMES,
    THEME_MODES: THEME_MODES,
    CLOCK_REFRESH_MS: CLOCK_REFRESH_MS,
    /** Alias kept for hosts and scripts written before the palette existed. */
    GREETING_REFRESH_MS: CLOCK_REFRESH_MS,
    TEXT_FADE_MS: TEXT_FADE_MS,
    PHOTO_FADE_MS: PHOTO_FADE_MS,
    getGreetingPeriod: getGreetingPeriod,
    getThemeSlot: getThemeSlot,
    buildGreeting: buildGreeting,
    normalizeName: normalizeName,
    parseBoolean: parseBoolean,
    normalizeColor: normalizeColor,
    normalizeTheme: normalizeTheme,
    normalizeSlideshowInterval: normalizeSlideshowInterval,
    normalizePhotos: normalizePhotos,
    parseQueryParams: parseQueryParams,
    readStoredConfig: readStoredConfig,
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

      if (pendingUpdates.length > 0) {
        app.applyUpdates(pendingUpdates.splice(0, pendingUpdates.length));
      }
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
