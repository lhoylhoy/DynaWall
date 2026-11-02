'use strict';

/**
 * Headless verification for DynaWall.
 *
 *   node tests/verify.cjs
 *
 * Covers the time-of-day boundaries, greeting copy, value normalisation,
 * the four-tier configuration hierarchy, both host IPC bridges, the photo
 * slideshow, the time-aware palette (CSS bands, host dropdowns, macOS parity)
 * and the consistency between the host manifests and script.js.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DynaWall = require('../script.js');

const ROOT = path.join(__dirname, '..');

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  \u2717 ${name}`);
    console.log(`      ${String(error.message).split('\n')[0]}`);
  }
}

function group(name) {
  console.log(`\n${name}`);
}

function readJson(fileName) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, fileName), 'utf8'));
}

/** Deterministic local date used by the time-based assertions. */
function at(hours, minutes) {
  return new Date(2026, 0, 15, hours, minutes, 30);
}

function fakeStorage(seed) {
  const data = new Map(Object.entries(seed || {}));
  return {
    data: data,
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    }
  };
}

/* -------------------------------------------------------------------------- *
 * Time-of-day logic
 * -------------------------------------------------------------------------- */

group('getGreetingPeriod() boundaries');
[
  ['04:59', 4, 59, 'evening'],
  ['05:00', 5, 0, 'morning'],
  ['11:59', 11, 59, 'morning'],
  ['12:00', 12, 0, 'afternoon'],
  ['17:59', 17, 59, 'afternoon'],
  ['18:00', 18, 0, 'evening'],
  ['00:00', 0, 0, 'evening'],
  ['23:59', 23, 59, 'evening']
].forEach(([label, hours, minutes, expected]) => {
  test(`${label} → ${expected}`, () => {
    assert.equal(DynaWall.getGreetingPeriod(at(hours, minutes)), expected);
  });
});

group('Greeting copy');
test('greeting matches "Good {period}, {FirstName}."', () => {
  assert.equal(DynaWall.buildGreeting('Developer', 'morning'), 'Good morning, Developer.');
  assert.equal(DynaWall.buildGreeting('Sam', 'afternoon'), 'Good afternoon, Sam.');
  assert.equal(DynaWall.buildGreeting('Alex', 'evening'), 'Good evening, Alex.');
});

test('refresh cadence matches the plan (30s greeting / 320ms cross-fade)', () => {
  assert.equal(DynaWall.GREETING_REFRESH_MS, 30000);
  assert.equal(DynaWall.TEXT_FADE_MS, 320);
});

/* -------------------------------------------------------------------------- *
 * Value normalisation
 * -------------------------------------------------------------------------- */

group('Value normalisation');

test('names are trimmed and reduced to the first name', () => {
  assert.equal(DynaWall.normalizeName('  Alex   Johnson '), 'Alex');
  assert.equal(DynaWall.normalizeName('Sam.'), 'Sam');
  assert.equal(DynaWall.normalizeName('   '), undefined);
  assert.equal(DynaWall.normalizeName(null), undefined);
});

test('booleans accept host, query and storage representations', () => {
  assert.equal(DynaWall.parseBoolean(true), true);
  assert.equal(DynaWall.parseBoolean('FALSE'), false);
  assert.equal(DynaWall.parseBoolean('0'), false);
  assert.equal(DynaWall.parseBoolean('yes'), true);
  assert.equal(DynaWall.parseBoolean('maybe'), undefined);
});

test('colors accept hex, rgb() and host float triplets', () => {
  assert.equal(DynaWall.normalizeColor('#0D1117'), '#0d1117');
  assert.equal(DynaWall.normalizeColor('0b0f19'), '#0b0f19');
  assert.equal(DynaWall.normalizeColor('rgb(13, 17, 23)'), '#0d1117');
  assert.equal(
    DynaWall.normalizeColor('0.050980392156862744 0.06666666666666667 0.09019607843137255'),
    '#0d1117'
  );
  assert.equal(DynaWall.normalizeColor('255 255 255'), '#ffffff');
  assert.equal(DynaWall.normalizeColor('not-a-color'), undefined);
});

/* -------------------------------------------------------------------------- *
 * Configuration sources & hierarchy
 * -------------------------------------------------------------------------- */

group('URL query parameters');

test('documented parameters are parsed', () => {
  const config = DynaWall.parseQueryParams(
    '?name=Alex&subtitle=Hello%20there&bgColor=%230b0f19&slideshow=true&interval=7'
  );
  assert.deepEqual(config, {
    firstName: 'Alex',
    subtitle: 'Hello there',
    bgColor: '#0b0f19',
    slideshow: true,
    slideshowInterval: 7
  });
});

test('unknown or invalid parameters are ignored', () => {
  assert.deepEqual(DynaWall.parseQueryParams('?foo=bar&slideshow=nope&name='), {});
});

test('a missing search string is safe', () => {
  assert.deepEqual(DynaWall.parseQueryParams(''), {});
  assert.deepEqual(DynaWall.parseQueryParams(undefined), {});
});

group('Configuration resolution hierarchy');

test('IPC beats URL, storage and defaults', () => {
  const config = DynaWall.resolveConfig({
    ipc: { firstName: 'Sam' },
    url: { firstName: 'Alex' },
    storage: { firstName: 'Cached' },
    defaults: DynaWall.DEFAULT_CONFIG
  });
  assert.equal(config.firstName, 'Sam');
});

test('URL beats storage when IPC has no value', () => {
  const config = DynaWall.resolveConfig({
    ipc: {},
    url: { firstName: 'Alex' },
    storage: { firstName: 'Cached' },
    defaults: DynaWall.DEFAULT_CONFIG
  });
  assert.equal(config.firstName, 'Alex');
});

test('storage beats the built-in defaults', () => {
  const config = DynaWall.resolveConfig({
    storage: { firstName: 'Cached' },
    defaults: DynaWall.DEFAULT_CONFIG
  });
  assert.equal(config.firstName, 'Cached');
});

test('defaults win when every layer is empty', () => {
  const config = DynaWall.resolveConfig({ defaults: DynaWall.DEFAULT_CONFIG });
  assert.deepEqual(config, {
    firstName: 'Developer',
    subtitle: 'What are we building today?',
    bgColor: '#0d1117',
    theme: 'auto',
    slideshow: false,
    slideshowInterval: 15,
    slideshowShuffle: true,
    kenBurns: true,
    photos: []
  });
});

test('layers resolve independently per field', () => {
  const config = DynaWall.resolveConfig({
    ipc: { slideshow: true },
    url: { slideshowInterval: 45 },
    storage: { kenBurns: false },
    defaults: DynaWall.DEFAULT_CONFIG
  });
  assert.deepEqual(config, {
    firstName: 'Developer',
    subtitle: 'What are we building today?',
    bgColor: '#0d1117',
    theme: 'auto',
    slideshow: true,
    slideshowInterval: 45,
    slideshowShuffle: true,
    kenBurns: false,
    photos: []
  });
});

test('an intentionally cleared subtitle survives resolution', () => {
  const config = DynaWall.resolveConfig({
    url: { subtitle: '' },
    defaults: DynaWall.DEFAULT_CONFIG
  });
  assert.equal(config.subtitle, '');
});

group('localStorage cache');

test('stored values are read back with the right types', () => {
  const storage = fakeStorage({
    'dynawall.firstName': 'Sam',
    'dynawall.slideshow': 'yes',
    'dynawall.kenBurns': 'off',
    'dynawall.bgColor': '#0b0f19'
  });
  assert.deepEqual(DynaWall.readStoredConfig(storage), {
    firstName: 'Sam',
    bgColor: '#0b0f19',
    slideshow: true,
    kenBurns: false
  });
});

test('persistConfig writes the documented keys', () => {
  const storage = fakeStorage();
  DynaWall.persistConfig({ firstName: 'Sam', slideshow: true }, storage);
  assert.equal(storage.data.get('dynawall.firstName'), 'Sam');
  assert.equal(storage.data.get('dynawall.slideshow'), 'true');
  assert.equal(storage.data.size, 2);
});

test('blocked storage never throws', () => {
  const hostile = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    }
  };
  assert.deepEqual(DynaWall.readStoredConfig(hostile), {});
  assert.doesNotThrow(() => DynaWall.persistConfig({ firstName: 'Sam' }, hostile));
});

/* -------------------------------------------------------------------------- *
 * Host IPC bridges
 * -------------------------------------------------------------------------- */

group('Host IPC mapping');

test('livelyPropertyListener values map to config fields', () => {
  assert.deepEqual(DynaWall.mapLivelyProperty('firstName', 'Sam'), {
    field: 'firstName',
    value: 'Sam'
  });
  assert.deepEqual(DynaWall.mapLivelyProperty('subtitleText', 'Ship it'), {
    field: 'subtitle',
    value: 'Ship it'
  });
  assert.deepEqual(DynaWall.mapLivelyProperty('bgColor', '0.050980 0.066667 0.090196'), {
    field: 'bgColor',
    value: '#0d1117'
  });
  assert.equal(DynaWall.mapLivelyProperty('unknownControl', 'x'), null);
  assert.equal(DynaWall.mapLivelyProperty('subtitleText', 42), null);
  // The clock is not part of the wallpaper anymore, even if a stale host sends it.
  assert.equal(DynaWall.mapLivelyProperty('showClock', true), null);
  assert.equal(DynaWall.mapLivelyProperty('clockPosition', 1), null);
});

test('applyUserProperties payloads map to config fields', () => {
  const updates = DynaWall.mapWallpaperEngineProperties({
    firstname: { value: 'Alex' },
    subtitle: { value: 'Ship it' },
    bgcolor: { value: '0.04 0.06 0.09' },
    slideshow: { value: true }
  });
  assert.deepEqual(updates, [
    { field: 'firstName', value: 'Alex' },
    { field: 'subtitle', value: 'Ship it' },
    { field: 'bgColor', value: '#0a0f17' },
    { field: 'slideshow', value: true }
  ]);
  assert.deepEqual(DynaWall.mapWallpaperEngineProperties(null), []);
});

/* -------------------------------------------------------------------------- *
 * Photo slideshow
 * -------------------------------------------------------------------------- */

group('Photo slideshow');

test('slideshow defaults keep the wallpaper minimal', () => {
  assert.equal(DynaWall.DEFAULT_CONFIG.slideshow, false);
  assert.equal(DynaWall.DEFAULT_CONFIG.slideshowInterval, 15);
  assert.equal(DynaWall.DEFAULT_CONFIG.slideshowShuffle, true);
  assert.equal(DynaWall.DEFAULT_CONFIG.kenBurns, true);
  assert.deepEqual(DynaWall.DEFAULT_CONFIG.photos, []);
});

test('the photo list is never cached, the other slideshow keys are', () => {
  assert.equal(DynaWall.STORAGE_KEYS.photos, undefined);
  ['slideshow', 'slideshowInterval', 'slideshowShuffle', 'kenBurns'].forEach((field) => {
    assert.ok(DynaWall.STORAGE_KEYS[field], `missing storage key for ${field}`);
  });
});

test('slide interval is rounded and clamped to 1…1440 minutes', () => {
  assert.equal(DynaWall.normalizeSlideshowInterval(1), 1);
  assert.equal(DynaWall.normalizeSlideshowInterval(1.6), 2);
  assert.equal(DynaWall.normalizeSlideshowInterval('30'), 30);
  assert.equal(DynaWall.normalizeSlideshowInterval(0), 1);
  assert.equal(DynaWall.normalizeSlideshowInterval(-5), 1);
  assert.equal(DynaWall.normalizeSlideshowInterval(9999), 1440);
  assert.equal(DynaWall.normalizeSlideshowInterval('abc'), undefined);
  assert.equal(DynaWall.normalizeSlideshowInterval(null), undefined);
});

test('photos accept arrays, JSON arrays and comma separated lists', () => {
  assert.deepEqual(DynaWall.normalizePhotos(['a.jpg', 'b.jpg']), ['a.jpg', 'b.jpg']);
  assert.deepEqual(DynaWall.normalizePhotos('["a.jpg","b.jpg"]'), ['a.jpg', 'b.jpg']);
  assert.deepEqual(DynaWall.normalizePhotos(' a.jpg , b.jpg '), ['a.jpg', 'b.jpg']);
  assert.deepEqual(DynaWall.normalizePhotos(''), []);
  assert.deepEqual(DynaWall.normalizePhotos([]), []);
  assert.equal(DynaWall.normalizePhotos('[not json'), undefined);
  assert.equal(DynaWall.normalizePhotos(42), undefined);
});

test('photos are trimmed, de-duplicated and sanitised', () => {
  const photos = DynaWall.normalizePhotos([
    'images/a.jpg',
    '  images/a.jpg  ',
    '',
    '   ',
    'two words.jpg',
    'javascript:alert(1)',
    7,
    'dynawall-photo://photo/3'
  ]);
  assert.deepEqual(photos, ['images/a.jpg', 'dynawall-photo://photo/3']);
});

test('bundled photos ship with the wallpaper', () => {
  assert.ok(DynaWall.BUNDLED_PHOTOS.length >= 4, 'expected a few bundled photos');
  DynaWall.BUNDLED_PHOTOS.forEach((photo) => {
    assert.ok(fs.existsSync(path.join(ROOT, photo)), `missing photo: ${photo}`);
  });
});

test('photo controls map from livelyPropertyListener', () => {
  assert.deepEqual(DynaWall.mapLivelyProperty('slideshow', true), { field: 'slideshow', value: true });
  assert.deepEqual(DynaWall.mapLivelyProperty('slideshowInterval', 45), {
    field: 'slideshowInterval',
    value: 45
  });
  assert.deepEqual(DynaWall.mapLivelyProperty('slideshowShuffle', 'false'), {
    field: 'slideshowShuffle',
    value: false
  });
  assert.deepEqual(DynaWall.mapLivelyProperty('kenBurns', 'on'), { field: 'kenBurns', value: true });
  assert.deepEqual(DynaWall.mapLivelyProperty('photos', ['dynawall-photo://photo/0']), {
    field: 'photos',
    value: ['dynawall-photo://photo/0']
  });
});

test('photo controls map from Wallpaper Engine properties', () => {
  const updates = DynaWall.mapWallpaperEngineProperties({
    slideshow: { value: true },
    slideshowinterval: { value: '45' },
    slideshowshuffle: { value: false },
    kenburns: { value: false }
  });
  const mapped = {};
  updates.forEach((update) => {
    mapped[update.field] = update.value;
  });
  assert.deepEqual(mapped, {
    slideshow: true,
    slideshowInterval: 45,
    slideshowShuffle: false,
    kenBurns: false
  });
});

test('photo settings resolve through the four-tier hierarchy', () => {
  const config = DynaWall.resolveConfig({
    ipc: { slideshowInterval: 60, photos: ['host.jpg'] },
    url: { slideshowInterval: 30, slideshow: true, photos: ['url.jpg'] },
    storage: { slideshowInterval: 5, slideshowShuffle: false },
    defaults: DynaWall.DEFAULT_CONFIG
  });
  assert.equal(config.slideshowInterval, 60, 'IPC wins');
  assert.equal(config.slideshow, true, 'URL fills the gap');
  assert.equal(config.slideshowShuffle, false, 'storage fills the gap');
  assert.equal(config.kenBurns, true, 'default fills the gap');
  assert.deepEqual(config.photos, ['host.jpg'], 'host photos win over the URL');
});

test('query aliases cover the slideshow', () => {
  const parsed = DynaWall.parseQueryParams(
    '?slideshow=true&interval=7&shuffle=no&kenburns=false&photos=a.jpg,%20b.jpg'
  );
  assert.equal(parsed.slideshow, true);
  assert.equal(parsed.slideshowInterval, 7);
  assert.equal(parsed.slideshowShuffle, false);
  assert.equal(parsed.kenBurns, false);
  assert.deepEqual(parsed.photos, ['a.jpg', 'b.jpg']);
});

/* -------------------------------------------------------------------------- *
 * Time-aware palette
 * -------------------------------------------------------------------------- */

group('getThemeSlot() boundaries');
[
  ['04:59', 4, 59, 'night'],
  ['05:00', 5, 0, 'dawn'],
  ['08:59', 8, 59, 'dawn'],
  ['09:00', 9, 0, 'day'],
  ['16:59', 16, 59, 'day'],
  ['17:00', 17, 0, 'dusk'],
  ['20:59', 20, 59, 'dusk'],
  ['21:00', 21, 0, 'night'],
  ['00:00', 0, 0, 'night'],
  ['23:59', 23, 59, 'night']
].forEach(([label, hours, minutes, expected]) => {
  test(`${label} → ${expected}`, () => {
    assert.equal(DynaWall.getThemeSlot(at(hours, minutes)), expected);
  });
});

group('Palette configuration');

test('the palette follows the clock unless a theme pins it', () => {
  assert.equal(DynaWall.DEFAULT_CONFIG.theme, 'auto');
  assert.deepEqual(DynaWall.THEMES, ['dawn', 'day', 'dusk', 'night']);
  assert.deepEqual(DynaWall.THEME_MODES, ['auto'].concat(DynaWall.THEMES, ['custom']));
  // The greeting and the palette share one cadence.
  assert.equal(DynaWall.CLOCK_REFRESH_MS, 30000);
  assert.equal(DynaWall.GREETING_REFRESH_MS, DynaWall.CLOCK_REFRESH_MS);
});

test('themes accept names, synonyms and Lively dropdown indices', () => {
  assert.equal(DynaWall.normalizeTheme('DUSK'), 'dusk');
  assert.equal(DynaWall.normalizeTheme('  auto '), 'auto');
  assert.equal(DynaWall.normalizeTheme('time'), 'auto');
  assert.equal(DynaWall.normalizeTheme('clock'), 'auto');
  assert.equal(DynaWall.normalizeTheme('night'), 'night');
  assert.equal(DynaWall.normalizeTheme(' custom '), 'custom');
  assert.equal(DynaWall.normalizeTheme(0), 'auto');
  assert.equal(DynaWall.normalizeTheme(3), 'dusk');
  assert.equal(DynaWall.normalizeTheme(5), 'custom');
  assert.equal(DynaWall.normalizeTheme(6), undefined);
  assert.equal(DynaWall.normalizeTheme('evening'), undefined, 'only palette bands are valid');
  assert.equal(DynaWall.normalizeTheme('constructor'), undefined, 'no prototype leaks');
  assert.equal(DynaWall.normalizeTheme(true), undefined);
  assert.equal(DynaWall.normalizeTheme(undefined), undefined);
});

test('a hand-picked colour pins the custom palette', () => {
  const defaults = DynaWall.DEFAULT_CONFIG;
  assert.equal(DynaWall.resolveConfig({ defaults }).theme, 'auto');
  assert.equal(DynaWall.resolveConfig({ ipc: { bgColor: '#0b0f19' }, defaults }).theme, 'custom');
  assert.equal(DynaWall.resolveConfig({ url: { bgColor: '#0b0f19' }, defaults }).theme, 'custom');
  assert.equal(DynaWall.resolveConfig({ storage: { bgColor: '#0b0f19' }, defaults }).theme, 'custom');
  // Naming a theme in the same layer wins, so a host can pin a palette and still
  // keep a colour for `custom`.
  assert.equal(
    DynaWall.resolveConfig({ ipc: { bgColor: '#0b0f19', theme: 'auto' }, defaults }).theme,
    'auto'
  );
  assert.equal(DynaWall.resolveConfig({ url: { theme: 'night' }, defaults }).theme, 'night');
  assert.equal(DynaWall.resolveConfig({ storage: { theme: 'dusk' }, defaults }).theme, 'dusk');
});

test('the theme is cached, linkable and host-controllable', () => {
  assert.equal(DynaWall.STORAGE_KEYS.theme, 'dynawall.theme');
  assert.equal(DynaWall.parseQueryParams('?theme=dawn').theme, 'dawn');
  assert.equal(DynaWall.parseQueryParams('?theme=time').theme, 'auto');
  assert.equal(DynaWall.parseQueryParams('?theme=midnight').theme, undefined);
  assert.deepEqual(DynaWall.mapLivelyProperty('theme', 2), { field: 'theme', value: 'day' });
  assert.equal(DynaWall.mapLivelyProperty('theme', 'nope'), null);
  assert.deepEqual(DynaWall.mapWallpaperEngineProperties({ theme: { value: 'Dusk' } }), [
    { field: 'theme', value: 'dusk' }
  ]);
});

group('Time-aware palette styles');

const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');

/** Declarations of the first rule whose selector starts with `selector`, if any. */
function cssRule(selector) {
  const start = css.indexOf(selector);
  if (start === -1) return null;
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return open === -1 || close === -1 ? null : css.slice(open + 1, close);
}

function ruleBackground(selector) {
  const rule = cssRule(selector);
  const match = rule ? rule.match(/--bg-primary:\s*(#[0-9a-f]{6})/) : null;
  return match ? match[1] : null;
}

const PALETTE_TOKENS = [
  '--bg-primary',
  '--bg-radial-accent',
  '--bg-vignette',
  '--text-primary',
  '--text-secondary',
  '--greeting-glow',
  '--photo-filter'
];

test('every band defines the full palette, and the four inks differ', () => {
  const backgrounds = [];
  DynaWall.THEMES.forEach((theme) => {
    const rule = cssRule(`[data-theme="${theme}"]`);
    assert.ok(rule, `style.css has no [data-theme="${theme}"] block`);
    PALETTE_TOKENS.forEach((token) => {
      assert.ok(rule.includes(`${token}:`), `[data-theme="${theme}"] is missing ${token}`);
    });
    const hex = ruleBackground(`[data-theme="${theme}"]`);
    assert.ok(hex, `[data-theme="${theme}"] needs a hex background`);
    backgrounds.push(hex);
  });
  assert.equal(new Set(backgrounds).size, DynaWall.THEMES.length, 'each band needs its own ink');
});

test('the daylight band is the pre-JS baseline', () => {
  const baseline = ruleBackground(':root');
  assert.ok(baseline, ':root needs a background for the first paint');
  assert.equal(ruleBackground('[data-theme="day"]'), baseline);
  assert.ok(cssRule('[data-theme="custom"]'), 'the custom palette must exist too');
});

test('palette changes cross-fade, grade the photos and respect reduced motion', () => {
  assert.match(css, /--theme-fade-duration:\s*\d+ms/);
  assert.match(css, /html\.is-theme-ready body\s*{[^}]*background-color/, 'the fade arms after boot');
  assert.match(css, /filter:\s*var\(--photo-filter\)/, 'photos follow the band');
  assert.match(css, /text-shadow:\s*0 1px 40px var\(--greeting-glow\)/);
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /html\.is-theme-ready body/, 'the palette fade must be switchable off');
  assert.match(reduced, /\.subtitle/);
});

test('the macOS host mirrors the same bands, colours and hours', () => {
  const swift = fs.readFileSync(path.join(ROOT, 'macos', 'DynaWallApp.swift'), 'utf8');
  DynaWall.THEMES.forEach((theme) => {
    assert.match(swift, new RegExp(`case \\.${theme}: return`), `ThemeSlot.${theme} is missing`);
    const hex = ruleBackground(`[data-theme="${theme}"]`);
    assert.ok(swift.includes(hex), `ThemeSlot.${theme} should paint ${hex}`);
  });
  assert.match(swift, /case 5\.\.<9: return \.dawn/);
  assert.match(swift, /case 9\.\.<17: return \.day/);
  assert.match(swift, /case 17\.\.<21: return \.dusk/);
  assert.match(swift, /default: return \.night/);
});

test('the macOS bundle ships a custom AppIcon.icns and Info.plist icon entry', () => {
  const plist = fs.readFileSync(path.join(ROOT, 'macos', 'Info.plist'), 'utf8');
  assert.match(plist, /<key>CFBundleIconFile<\/key>\s*<string>AppIcon<\/string>/);
  assert.match(plist, /<key>CFBundleIconName<\/key>\s*<string>AppIcon<\/string>/);
  const icnsPath = path.join(ROOT, 'macos', 'AppIcon.icns');
  const pngPath = path.join(ROOT, 'macos', 'AppIcon.png');
  assert.ok(fs.existsSync(icnsPath), 'missing macos/AppIcon.icns');
  assert.ok(fs.existsSync(pngPath), 'missing macos/AppIcon.png');
  const icnsHeader = fs.readFileSync(icnsPath).subarray(0, 4).toString('ascii');
  assert.equal(icnsHeader, 'icns', 'AppIcon.icns must begin with the icns magic header');
});

/* -------------------------------------------------------------------------- *
 * Host manifests stay in sync with script.js
 * -------------------------------------------------------------------------- */

group('Host manifests');

let livelyProperties;
let wallpaperProject;
let livelyInfo;

try {
  livelyProperties = readJson('LivelyProperties.json');
  wallpaperProject = readJson('project.json');
  livelyInfo = readJson('LivelyInfo.json');
} catch (error) {
  console.error(`\nUnable to read the host manifests: ${error.message}`);
  process.exit(1);
}

/** Turns a manifest definition into the value the host would deliver at runtime. */
function sampleValue(definition) {
  switch (definition.type) {
    case 'textbox':
    case 'textinput':
      return String(definition.value ?? '');
    case 'checkbox':
    case 'bool':
      return Boolean(definition.value);
    case 'dropdown':
      return Number(definition.value ?? 0);
    case 'combo':
    case 'color':
      return String(definition.value ?? '');
    default:
      return definition.value;
  }
}

test('every LivelyProperties.json control is handled by script.js', () => {
  const keys = Object.keys(livelyProperties).filter((key) => !key.startsWith('__'));
  assert.ok(keys.length >= 6, 'expected at least six Lively controls');
  keys.forEach((key) => {
    const update = DynaWall.mapLivelyProperty(key, sampleValue(livelyProperties[key]));
    assert.notEqual(update, null, `Lively control "${key}" is not handled by script.js`);
  });
});

test('Lively defaults match the built-in defaults', () => {
  assert.equal(livelyProperties.firstName.value, DynaWall.DEFAULT_CONFIG.firstName);
  assert.equal(livelyProperties.subtitleText.value, DynaWall.DEFAULT_CONFIG.subtitle);
  assert.equal(
    DynaWall.normalizeColor(livelyProperties.bgColor.value),
    DynaWall.DEFAULT_CONFIG.bgColor
  );
  assert.equal(livelyProperties.slideshow.value, DynaWall.DEFAULT_CONFIG.slideshow);
  assert.equal(
    DynaWall.normalizeSlideshowInterval(livelyProperties.slideshowInterval.value),
    DynaWall.DEFAULT_CONFIG.slideshowInterval
  );
  assert.equal(livelyProperties.slideshowShuffle.value, DynaWall.DEFAULT_CONFIG.slideshowShuffle);
  assert.equal(livelyProperties.kenBurns.value, DynaWall.DEFAULT_CONFIG.kenBurns);
});

test('the theme control ships in both host manifests', () => {
  assert.equal(livelyProperties.theme.type, 'dropdown');
  assert.equal(
    livelyProperties.theme.items.length,
    DynaWall.THEME_MODES.length,
    'Lively lists one item per palette mode'
  );
  assert.equal(
    DynaWall.normalizeTheme(sampleValue(livelyProperties.theme)),
    DynaWall.DEFAULT_CONFIG.theme,
    'Lively must default to the same theme as the page'
  );
  // Lively sends the index, so the item order *is* the contract with THEME_MODES.
  livelyProperties.theme.items.forEach((label, index) => {
    assert.equal(
      label.split(' ')[0].toLowerCase(),
      DynaWall.THEME_MODES[index],
      `Lively item ${index} ("${label}") is out of order`
    );
  });

  const combo = wallpaperProject.general.properties.theme;
  assert.equal(combo.type, 'combo');
  assert.equal(combo.value, DynaWall.DEFAULT_CONFIG.theme);
  assert.deepEqual(
    combo.options.map((option) => option.value),
    DynaWall.THEME_MODES,
    'the Wallpaper Engine combo lists the same modes in the same order'
  );
});

test('the clock is gone from both host manifests', () => {
  ['showClock', 'use24Hour', 'clockPosition'].forEach((key) => {
    assert.equal(livelyProperties[key], undefined, `Lively still exposes ${key}`);
    assert.equal(DynaWall.DEFAULT_CONFIG[key], undefined, `defaults still expose ${key}`);
  });
  ['showclock', 'use24hour', 'clockposition'].forEach((key) => {
    assert.equal(wallpaperProject.general.properties[key], undefined, `project.json still exposes ${key}`);
    assert.equal(DynaWall.STORAGE_KEYS[key], undefined, `storage still caches ${key}`);
  });
});

test('every project.json property is handled by the Wallpaper Engine bridge', () => {
  const properties = wallpaperProject.general.properties;
  const keys = Object.keys(properties);
  assert.ok(keys.length >= 6, 'expected at least six Wallpaper Engine properties');

  const wrapped = {};
  keys.forEach((key) => {
    wrapped[key] = { value: sampleValue(properties[key]) };
  });
  assert.equal(DynaWall.mapWallpaperEngineProperties(wrapped).length, keys.length);
});

test('Wallpaper Engine defaults match the built-in defaults', () => {
  const properties = wallpaperProject.general.properties;
  assert.equal(properties.firstname.value, DynaWall.DEFAULT_CONFIG.firstName);
  assert.equal(properties.subtitle.value, DynaWall.DEFAULT_CONFIG.subtitle);
  assert.equal(
    DynaWall.normalizeColor(properties.bgcolor.value),
    DynaWall.DEFAULT_CONFIG.bgColor
  );
  assert.equal(properties.slideshow.value, DynaWall.DEFAULT_CONFIG.slideshow);
  assert.equal(
    DynaWall.normalizeSlideshowInterval(properties.slideshowinterval.value),
    DynaWall.DEFAULT_CONFIG.slideshowInterval
  );
  assert.equal(properties.slideshowshuffle.value, DynaWall.DEFAULT_CONFIG.slideshowShuffle);
  assert.equal(properties.kenburns.value, DynaWall.DEFAULT_CONFIG.kenBurns);
});

test('host manifests point at index.html and the shipped assets exist', () => {
  assert.equal(wallpaperProject.file, 'index.html');
  assert.equal(wallpaperProject.type, 'web');
  assert.equal(livelyInfo.Type, 1);
  assert.equal(livelyInfo.FileName, 'index.html');
  assert.equal(livelyInfo.IsAbsolutePath, false);

  [
    wallpaperProject.file,
    livelyInfo.FileName,
    livelyInfo.Thumbnail,
    'script.js',
    'style.css',
    'assets/fonts/outfit-latin.woff2'
  ]
    .concat(DynaWall.BUNDLED_PHOTOS)
    .forEach((asset) => {
      assert.ok(fs.existsSync(path.join(ROOT, asset)), `missing asset: ${asset}`);
    });
});

/* -------------------------------------------------------------------------- *
 * Typography
 * -------------------------------------------------------------------------- */

group('Typography');

test('the only webfont is the vendored Outfit face', () => {
  const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  const faces = css.match(/@font-face/g) || [];
  assert.equal(faces.length, 1, 'expected exactly one @font-face rule');
  assert.match(css, /font-family:\s*"Outfit"/);
  assert.match(css, /url\("assets\/fonts\/outfit-latin\.woff2"\)/);
  assert.match(css, /font-weight:\s*100 900/, 'the variable axis covers every weight');
  assert.match(css, /--font-sans:\s*"Outfit"/, 'Outfit leads the font stack');
});

test('nothing in the wallpaper reaches the network', () => {
  ['style.css', 'script.js', 'index.html'].forEach((file) => {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(!/https?:\/\//.test(source), `${file} must not reference a remote URL`);
  });
});

test('display type is tracked, lead and balanced deliberately', () => {
  const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  assert.match(css, /--greeting-tracking:\s*-0\.0[0-9]+em/, 'greeting needs negative tracking');
  assert.match(css, /--greeting-leading:\s*1\.0[0-9]/, 'display leading stays tight');
  assert.match(css, /--subtitle-tracking:\s*0\.0[0-9]+em/, 'small text needs positive tracking');
  assert.match(css, /font-synthesis:\s*none/, 'no faux weights or italics');
  assert.match(css, /font-kerning:\s*normal/);
  assert.match(css, /text-wrap:\s*balance/, 'the greeting balances when it wraps');
});

/* -------------------------------------------------------------------------- *
 * Summary
 * -------------------------------------------------------------------------- */

const total = passed + failures.length;
console.log(`\n${passed}/${total} checks passed`);

if (failures.length > 0) {
  console.log('\nFailures:');
  failures.forEach((failure) => {
    console.log(`  - ${failure.name}: ${failure.error.message}`);
  });
  process.exitCode = 1;
} else {
  console.log('DynaWall verification passed.');
}
