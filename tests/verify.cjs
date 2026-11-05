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

/** Reads a text file with LF endings, so CRLF checkouts (Windows CI) still match. */
function readText(fileName) {
  return fs.readFileSync(path.join(ROOT, fileName), 'utf8').replace(/\r\n/g, '\n');
}

/**
 * The Content Security Policy meta tag in `index.html`: the one place the wallpaper
 * is allowed to name a remote host, because naming them is what forbids every other
 * request. Tests strip it before scanning for remote URLs and read it here.
 */
const CONTENT_SECURITY_POLICY =
  /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/?>/;

/** The shipped policy, parsed into a directive → source-list map. */
function contentSecurityPolicy() {
  const tag = CONTENT_SECURITY_POLICY.exec(readText('index.html'));
  assert.ok(tag, 'index.html must deliver a Content Security Policy in a meta tag');

  const directives = new Map();
  tag[1].split(';').forEach((chunk) => {
    const parts = chunk.trim().split(/\s+/).filter(Boolean);
    if (parts.length) directives.set(parts[0], parts.slice(1));
  });
  return directives;
}

/** Sorted source list for one directive, or `null` when it is not declared. */
function cspSources(directives, name) {
  const sources = directives.get(name);
  return sources ? sources.slice().sort() : null;
}

/**
 * The faces that ship in `assets/fonts`, derived from the list script.js exports:
 * `<slug>-latin.woff2` is what the page loads through `@font-face`, and the static
 * `<slug>-regular/semibold.ttf` pair is what the native preview cards register.
 * PostScript names are the family with the spaces removed (`SpaceGrotesk-Regular`),
 * which is how each host asks for a weight.
 */
const BUNDLED_FONTS = DynaWall.BUNDLED_FONT_FAMILIES.map((family) => {
  const slug = family.toLowerCase().replace(/\s+/g, '-');
  const postScript = family.replace(/\s+/g, '');
  return {
    family,
    slug,
    postScript,
    woff2: `assets/fonts/${slug}-latin.woff2`,
    regular: `assets/fonts/${slug}-regular.ttf`,
    semibold: `assets/fonts/${slug}-semibold.ttf`,
    license: `assets/fonts/OFL-${postScript}.txt`
  };
});

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
    photoSync: true,
    widgets: true,
    widgetMusic: true,
    widgetNews: true,
    widgetYouTube: true,
    widgetWeather: true,
    photos: [],
    fontFamily: 'Outfit',
    customFont: ''
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
    photoSync: true,
    widgets: true,
    widgetMusic: true,
    widgetNews: true,
    widgetYouTube: true,
    widgetWeather: true,
    photos: [],
    fontFamily: 'Outfit',
    customFont: ''
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

test('clearing the name field resets it instead of dropping the event', () => {
  // Deleting a name character by character sends one event per keystroke; the last
  // one carries "". Dropping it left the final letter on the desktop and in the
  // cache, so an explicit empty string is a reset to the built-in name.
  [DynaWall.mapLivelyProperty('firstName', ''), DynaWall.mapLivelyProperty('firstName', '   ')].forEach(
    (update) => {
      assert.deepEqual(update, { field: 'firstName', value: DynaWall.DEFAULT_CONFIG.firstName });
      assert.equal(update.value, 'Developer');
    }
  );
  assert.deepEqual(DynaWall.mapWallpaperEngineProperties({ firstname: { value: '' } }), [
    { field: 'firstName', value: DynaWall.DEFAULT_CONFIG.firstName }
  ]);
  assert.deepEqual(DynaWall.mapWallpaperEngineProperties({ firstname: { value: '   ' } }), [
    { field: 'firstName', value: DynaWall.DEFAULT_CONFIG.firstName }
  ]);
  // Only a string can be a cleared field; junk is still ignored.
  assert.equal(DynaWall.mapLivelyProperty('firstName', 42), null);
  assert.equal(DynaWall.mapLivelyProperty('firstName', null), null);
  // A trailing empty value in a URL, cache or seed still means "said nothing".
  assert.equal(DynaWall.normalizeName(''), undefined);
  assert.deepEqual(DynaWall.parseQueryParams('?name='), {});
  assert.deepEqual(DynaWall.readStoredConfig(fakeStorage({ 'dynawall.firstName': '' })), {});
  assert.deepEqual(DynaWall.readSeed({ __dynawallSeed: { firstName: '' } }), {});
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
  assert.equal(DynaWall.DEFAULT_CONFIG.photoSync, true, 'photos follow the clock by default');
  assert.deepEqual(DynaWall.DEFAULT_CONFIG.photos, []);
});

test('the photo list is never cached, the other slideshow keys are', () => {
  assert.equal(DynaWall.STORAGE_KEYS.photos, undefined);
  ['slideshow', 'slideshowInterval', 'slideshowShuffle', 'kenBurns', 'photoSync'].forEach((field) => {
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

test('an empty macOS photo list paints black while other hosts keep bundled photos', () => {
  const script = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
  const from = script.indexOf('function photoSources()');
  assert.notEqual(from, -1, 'photoSources() is missing');
  const body = script.slice(from, script.indexOf('\n    }', from));
  assert.match(body, /Array\.isArray\(custom\) && custom\.length > 0/, 'a host list wins');
  assert.match(
    body,
    /handlers\.dynawallPhoto \? \[\] : BUNDLED_PHOTOS/,
    'only a host that owns the list suppresses the bundled fallback'
  );
  // An empty list is a real answer: the slideshow is disabled and `has-photo`
  // is cleared, so CSS shows the plain background (black from the host seed).
  assert.match(script, /const enabled = Boolean\(state\.config\.slideshow\) && sources\.length > 0/);
  assert.match(script, /doc\.body\.classList\.toggle\('has-photo', enabled\)/);
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
 * Time-synced photos
 * -------------------------------------------------------------------------- */

group('Photo collections & filename classification');

/** The curated Golden Gate set, keyed by the band each file should land in. */
const GOLDEN_GATE_FILES = {
  light: 'images/iClarified-macOS-27-Golden-Gate-Wallpaper-5K-Light.jpg',
  day: 'images/iClarified-macOS-27-Golden-Gate-Day-Wallpaper.jpg',
  sunset: 'images/iClarified-macOS-27-Golden-Gate-Sunset-Wallpaper.jpg',
  evening: 'images/iClarified-macOS-27-Golden-Gate-Evening-Wallpaper.jpg',
  night: 'images/iClarified-macOS-27-Golden-Gate-Night-Wallpaper.jpg',
  dark: 'images/iClarified-macOS-27-Golden-Gate-Wallpaper-5K-Dark.jpg'
};

test('the bundled collections are curated and complete', () => {
  assert.equal(DynaWall.GOLDEN_GATE_PHOTOS.length, 6);
  assert.equal(DynaWall.ABSTRACT_PHOTOS.length, 6);
  assert.deepEqual(
    DynaWall.BUNDLED_PHOTOS,
    DynaWall.GOLDEN_GATE_PHOTOS.concat(DynaWall.ABSTRACT_PHOTOS),
    'bundled photos are the two curated sets, Golden Gate first'
  );
  // The folder also holds 4K/5K/HEIC duplicates; the collection must not repeat them.
  assert.equal(new Set(DynaWall.BUNDLED_PHOTOS).size, DynaWall.BUNDLED_PHOTOS.length);
  assert.deepEqual(Object.values(GOLDEN_GATE_FILES), DynaWall.GOLDEN_GATE_PHOTOS);
});

test('Golden Gate wallpapers land in the four time-of-day bands', () => {
  const buckets = DynaWall.classifyPhotos(DynaWall.GOLDEN_GATE_PHOTOS);
  assert.deepEqual(buckets.dawn, [GOLDEN_GATE_FILES.light], 'Light is the dawn picture');
  assert.deepEqual(buckets.day, [GOLDEN_GATE_FILES.day]);
  assert.deepEqual(buckets.dusk, [GOLDEN_GATE_FILES.sunset, GOLDEN_GATE_FILES.evening]);
  assert.deepEqual(buckets.night, [GOLDEN_GATE_FILES.night, GOLDEN_GATE_FILES.dark]);
});

test('abstract wallpapers land in the four time-of-day bands', () => {
  const buckets = DynaWall.classifyPhotos(DynaWall.ABSTRACT_PHOTOS);
  assert.deepEqual(buckets.dawn, ['images/04-mint-fog.jpg', 'images/05-candy-sky.jpg']);
  assert.deepEqual(buckets.day, ['images/02-solar-flare.jpg', 'images/03-deep-ocean.jpg']);
  assert.deepEqual(buckets.dusk, ['images/01-neon-dusk.jpg']);
  assert.deepEqual(buckets.night, ['images/06-graphite.jpg']);
});

test('a Light/Dark pair without a day photo shows the light one at noon', () => {
  const pair = ['images/Dynawall-5K-Light.jpg', 'images/Dynawall-5K-Dark.jpg'];
  const buckets = DynaWall.classifyPhotos(pair);
  assert.deepEqual(buckets.day, ['images/Dynawall-5K-Light.jpg']);
  assert.deepEqual(buckets.night, ['images/Dynawall-5K-Dark.jpg']);
  assert.deepEqual(buckets.dawn, []);
  // With a real day photo in the set the same file becomes the dawn picture.
  const withDay = DynaWall.classifyPhotos(pair.concat([GOLDEN_GATE_FILES.day]));
  assert.deepEqual(withDay.day, [GOLDEN_GATE_FILES.day]);
  assert.deepEqual(withDay.dawn, ['images/Dynawall-5K-Light.jpg']);
});

test('host scheme URLs are classified by their filename', () => {
  const urls = [
    'dynawall-photo://photo/0/iClarified-macOS-27-Golden-Gate-Night-Wallpaper.jpg',
    'dynawall-photo://photo/1/iClarified-macOS-27-Golden-Gate-Day-Wallpaper.jpg',
    'dynawall-photo://photo/2/Dyna%20Wall%20Sunset%20Study.jpg',
    'dynawall-photo://photo/3'
  ];
  const buckets = DynaWall.classifyPhotos(urls);
  assert.deepEqual(buckets.night, [urls[0]]);
  assert.deepEqual(buckets.day, [urls[1]]);
  assert.deepEqual(buckets.dusk, [urls[2]], 'percent-encoded names are decoded first');
  // An old-style host URL carries no filename, so it is dealt out, not dropped.
  assert.deepEqual(buckets.dawn, [urls[3]]);
  assert.equal(DynaWall.photoBasename(urls[2]), 'dyna wall sunset study.jpg');
  assert.equal(DynaWall.photoBasename(urls[3]), '3');
  assert.equal(DynaWall.photoBasename('images/04-mint-fog.jpg?v=2'), '04-mint-fog.jpg');
  assert.equal(DynaWall.photoBasename(undefined), '');
});

test('untagged folders are dealt across the four bands in order', () => {
  const custom = ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg', 'e.jpg'];
  const buckets = DynaWall.classifyPhotos(custom);
  assert.deepEqual(buckets.dawn, ['a.jpg', 'e.jpg']);
  assert.deepEqual(buckets.day, ['b.jpg']);
  assert.deepEqual(buckets.dusk, ['c.jpg']);
  assert.deepEqual(buckets.night, ['d.jpg']);
  assert.deepEqual(DynaWall.classifyPhotos('nope'), { dawn: [], day: [], dusk: [], night: [] });
});

test('a band with no photos falls back to the nearest adjacent band', () => {
  const golden = DynaWall.GOLDEN_GATE_PHOTOS;
  assert.deepEqual(DynaWall.getPhotosForSlot(golden, 'dusk'), [
    GOLDEN_GATE_FILES.sunset,
    GOLDEN_GATE_FILES.evening
  ]);
  const dayOnly = ['images/02-solar-flare.jpg'];
  assert.deepEqual(DynaWall.getPhotosForSlot(dayOnly, 'night'), dayOnly, 'night leans on day');
  assert.deepEqual(DynaWall.getPhotosForSlot(dayOnly, 'dawn'), dayOnly, 'dawn leans on day first');
  assert.deepEqual(DynaWall.getPhotosForSlot(dayOnly, 'dusk'), dayOnly, 'dusk leans on day first');
  assert.deepEqual(DynaWall.getPhotosForSlot(golden, 'unknown'), golden, 'no band = no filter');
  assert.deepEqual(DynaWall.getPhotosForSlot([], 'day'), []);
});

group('photoSync configuration');

test('time-of-day photo sync is on by default and cached', () => {
  assert.equal(DynaWall.DEFAULT_CONFIG.photoSync, true);
  assert.equal(DynaWall.STORAGE_KEYS.photoSync, 'dynawall.photoSync');
});

test('photoSync resolves from IPC, URL, storage and both manifests', () => {
  assert.deepEqual(DynaWall.mapLivelyProperty('photoSync', 'false'), {
    field: 'photoSync',
    value: false
  });
  assert.deepEqual(DynaWall.mapLivelyProperty('photoSync', 'on'), {
    field: 'photoSync',
    value: true
  });
  assert.equal(DynaWall.mapLivelyProperty('photoSync', 'sometimes'), null);
  assert.deepEqual(DynaWall.mapWallpaperEngineProperties({ photosync: { value: false } }), [
    { field: 'photoSync', value: false }
  ]);
  assert.deepEqual(DynaWall.parseQueryParams('?photoSync=true'), { photoSync: true });
  assert.equal(DynaWall.parseQueryParams('?photosync=off').photoSync, false);
  assert.equal(DynaWall.parseQueryParams('?timeSync=yes').photoSync, true);
  assert.equal(DynaWall.parseQueryParams('?dynamicPhotos=1').photoSync, true);
  assert.deepEqual(DynaWall.readStoredConfig(fakeStorage({ 'dynawall.photoSync': 'false' })), {
    photoSync: false
  });

  const config = DynaWall.resolveConfig({
    ipc: { photoSync: false },
    url: { photoSync: true },
    storage: { photoSync: true },
    defaults: DynaWall.DEFAULT_CONFIG
  });
  assert.equal(config.photoSync, false, 'IPC wins');

  const lively = readJson('LivelyProperties.json');
  assert.equal(lively.photoSync.type, 'checkbox');
  assert.equal(lively.photoSync.value, DynaWall.DEFAULT_CONFIG.photoSync);

  const project = readJson('project.json');
  assert.equal(project.general.properties.photosync.type, 'bool');
  assert.equal(project.general.properties.photosync.value, DynaWall.DEFAULT_CONFIG.photoSync);
  const orders = Object.keys(project.general.properties).map(
    (key) => project.general.properties[key].order
  );
  assert.equal(new Set(orders).size, orders.length, 'project.json orders stay unique');
});

group('Time-synced slideshow');

test('the photo band follows the clock unless a palette pins it', () => {
  assert.equal(DynaWall.resolvePhotoBand('auto', at(6, 0)), 'dawn');
  assert.equal(DynaWall.resolvePhotoBand('auto', at(12, 0)), 'day');
  assert.equal(DynaWall.resolvePhotoBand('custom', at(18, 30)), 'dusk');
  assert.equal(DynaWall.resolvePhotoBand('auto', at(22, 0)), 'night');
  assert.equal(DynaWall.resolvePhotoBand('night', at(12, 0)), 'night', 'a pinned band wins');
  assert.equal(DynaWall.resolvePhotoBand('dawn', at(22, 0)), 'dawn');
});

test('crossing a band edge swaps the photo pool', () => {
  const golden = DynaWall.GOLDEN_GATE_PHOTOS;
  const pool = (hours) =>
    DynaWall.getPhotosForSlot(golden, DynaWall.resolvePhotoBand('auto', at(hours, 30)));
  assert.deepEqual(pool(6), [GOLDEN_GATE_FILES.light]);
  assert.deepEqual(pool(12), [GOLDEN_GATE_FILES.day]);
  assert.deepEqual(pool(18), [GOLDEN_GATE_FILES.sunset, GOLDEN_GATE_FILES.evening]);
  assert.deepEqual(pool(22), [GOLDEN_GATE_FILES.night, GOLDEN_GATE_FILES.dark]);
  // 16:59 and 17:00 are different pictures — the cross-fade is the visible change.
  assert.notDeepEqual(pool(16), pool(17));
});

test('a band change restarts the rotation without clearing the layers', () => {
  const script = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
  // The band has to be part of the signature, otherwise applySlideshow() would
  // short-circuit on 17:00 and leave the daytime photo on screen all evening.
  assert.match(script, /`band:\$\{activePhotoBand\(\) \|\| 'all'\}`/);

  const body = (start) => {
    const from = script.indexOf(start);
    assert.notEqual(from, -1, `${start} is missing`);
    return script.slice(from, script.indexOf('\n    }', from));
  };

  const applySlideshow = body('function applySlideshow()');
  assert.equal(
    (applySlideshow.match(/clearPhotos\(\)/g) || []).length,
    1,
    'only the disabled branch may empty the layers'
  );
  assert.match(applySlideshow, /if \(!enabled\) \{\s*clearPhotos\(\);/);
  assert.match(applySlideshow, /state\.photoToken \+= 1/, 'a stale decode must be dropped');
  assert.match(applySlideshow, /paintPhoto\(start, sources\)/);

  // The clock crossing an edge repaints the palette and the photo in one tick.
  const checkTheme = body('function checkTheme()');
  assert.match(checkTheme, /applyTheme\(\);\s*(\/\/[^\n]*\n\s*)*applySlideshow\(\);/);
});

test('the automatic tick stays in the active band; Next may leave it', () => {
  const script = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
  const body = (start) => {
    const from = script.indexOf(start);
    assert.notEqual(from, -1, `${start} is missing`);
    return script.slice(from, script.indexOf('\n    }', from));
  };
  const advance = body('function advancePhoto()');
  assert.match(advance, /activePhotoSources\(\)/, 'the timer must not widen to the whole library');
  assert.ok(
    !advance.includes('nextPhotoPool()'),
    'a one-photo band must not jump to a Night photo at noon after one interval'
  );
  const next = body('function nextPhoto()');
  assert.match(next, /nextPhotoPool\(\)/, 'the explicit Next button still searches the whole library');
});

test('the macOS host mirrors the curated collections and the photo actions', () => {
  const swift = hostSwift();
  // Every curated picture is spelled out in the host, so bundled mode never sweeps
  // the 4K/5K/HEIC duplicates sitting in the same folder.
  DynaWall.BUNDLED_PHOTOS.forEach((photo) => {
    const name = photo.split('/').pop();
    assert.ok(swift.includes(name), `DynaWallApp.swift is missing the curated photo ${name}`);
  });
  assert.match(swift, /case goldenGate/, 'PhotoCollection.goldenGate is missing');
  assert.match(swift, /case abstract/, 'PhotoCollection.abstract is missing');
  // The scheme URL keeps the filename, and the handler only reads the index segment.
  assert.ok(swift.includes('://photo/\\(index)/'), 'scheme URLs must carry the filename');
  assert.ok(swift.includes('encodePathSegment'), 'filenames must be percent-encoded');
  assert.match(swift, /split\(separator: "\/", omittingEmptySubsequences: true\)/);
  // Settings reach the page through the same bridge Lively uses.
  assert.match(swift, /static let photoSync = "photoSyncTimeOfDay"/);
  assert.match(swift, /livelyPropertyListener\("photoSync",/);
  assert.match(swift, /livelyPropertyListener\("nextPhoto", true\)/);
  assert.match(swift, /func nextPhoto\(\)/);
});

test('nextPhoto is a host action, never a cached setting', () => {
  assert.equal(DynaWall.isLivelyAction('nextPhoto'), true);
  assert.equal(DynaWall.isLivelyAction(' photoSync '), false);
  assert.equal(DynaWall.isLivelyAction(undefined), false);
  assert.equal(DynaWall.mapLivelyProperty('nextPhoto', true), null, 'actions carry no field');
  assert.equal(DynaWall.STORAGE_KEYS.nextPhoto, undefined);
  assert.equal(DynaWall.DEFAULT_CONFIG.nextPhoto, undefined);
  assert.equal(typeof DynaWall.nextPhoto, 'function');
  assert.equal(DynaWall.nextPhoto(), false, 'nothing to advance without a page');
});

test('stepping the pool wraps, shuffles and never repeats a photo', () => {
  assert.equal(DynaWall.stepPhotoIndex(0, -1, false), -1);
  assert.equal(DynaWall.stepPhotoIndex(1, -1, false), 0, 'a lone photo is its own next');
  assert.equal(DynaWall.stepPhotoIndex(4, 0, false), 1);
  assert.equal(DynaWall.stepPhotoIndex(4, 3, false), 0, 'sequential order wraps');
  assert.equal(DynaWall.stepPhotoIndex(4, -1, false), 0, 'a fresh pool starts at its first photo');
  assert.equal(DynaWall.stepPhotoIndex(4, 2, true, () => 0), 0);
  const sequence = [0.34, 0.9]; // 1 is the current photo, 2 is the next
  let calls = 0;
  const random = () => sequence[Math.min(calls++, sequence.length - 1)];
  assert.equal(DynaWall.stepPhotoIndex(3, 1, true, random), 2);
  assert.equal(calls, 2, 'shuffle retries instead of repeating the current photo');
  assert.equal(DynaWall.stepPhotoIndex(3, -1, true, () => 0), 0);
});

/* --------------------------------------------------------------------------
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

/** Any `#rrggbb` token from a `[data-theme]` block, e.g. `--text-primary`. */
function tokenHex(selector, token) {
  const rule = cssRule(selector);
  const match = rule ? rule.match(new RegExp(`${token}:\\s*(#[0-9a-f]{6})`)) : null;
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
  assert.match(css, /html\.is-theme-ready body[^{]*\{[^}]*background-color/, 'the fade arms after boot');
  assert.match(css, /filter:\s*var\(--photo-filter\)/, 'photos follow the band');
  assert.match(css, /text-shadow:\s*0 1px 40px var\(--greeting-glow\)/);
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /html\.is-theme-ready body/, 'the palette fade must be switchable off');
  assert.match(reduced, /\.subtitle/);
});

test('the photo stack fades with the palette instead of snapping it', () => {
  assert.match(
    css,
    /html\.is-theme-ready body,\s*\n\s*html\.is-theme-ready \.photo-stack\s*{[^}]*transition:\s*background-color/,
    '.photo-stack paints --bg-primary in front of body and must fade too'
  );
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(
    reduced,
    /html\.is-theme-ready \.photo-stack/,
    'reduced motion must switch that fade off as well'
  );
});

test('the macOS host mirrors the same bands, colours, inks and hours', () => {
  const swift = hostSwift();
  const primary = memberBody(swift, 'var textPrimaryHex: String');
  const secondary = memberBody(swift, 'var textSecondaryHex: String');
  DynaWall.THEMES.forEach((theme) => {
    assert.match(swift, new RegExp(`case \\.${theme}: return`), `ThemeSlot.${theme} is missing`);
    const hex = ruleBackground(`[data-theme="${theme}"]`);
    assert.ok(swift.includes(hex), `ThemeSlot.${theme} should paint ${hex}`);

    // The preview card sets the greeting and subtitle in the band's own inks.
    const textPrimary = tokenHex(`[data-theme="${theme}"]`, '--text-primary');
    const textSecondary = tokenHex(`[data-theme="${theme}"]`, '--text-secondary');
    assert.ok(textPrimary, `[data-theme="${theme}"] needs a --text-primary`);
    assert.ok(textSecondary, `[data-theme="${theme}"] needs a --text-secondary`);
    assert.ok(
      primary.includes(`case .${theme}: return "${textPrimary}"`),
      `ThemeSlot.${theme}.textPrimaryHex should be ${textPrimary}`
    );
    assert.ok(
      secondary.includes(`case .${theme}: return "${textSecondary}"`),
      `ThemeSlot.${theme}.textSecondaryHex should be ${textSecondary}`
    );
  });
  assert.match(swift, /case 5\.\.<9: return \.dawn/);
  assert.match(swift, /case 9\.\.<17: return \.day/);
  assert.match(swift, /case 17\.\.<21: return \.dusk/);
  assert.match(swift, /default: return \.night/);
});

/* -------------------------------------------------------------------------- *
 * Menu bar popover
 * -------------------------------------------------------------------------- */

group('Menu bar popover');

/** The native host source. */
function hostSwift() {
  return readText('macos/DynaWallApp.swift');
}

/** Source of a member, from its signature to the first 4-space closing brace. */
function memberBody(swift, signature) {
  const start = swift.indexOf(signature);
  assert.notEqual(start, -1, `${signature} is missing from DynaWallApp.swift`);
  const end = swift.indexOf('\n    }', start);
  return end === -1 ? swift.slice(start) : swift.slice(start, end);
}

/** The `--bg-radial-accent` of a band as hex: `rgba(56, 139, 253, 0.04)` → `#388bfd`. */
function accentHex(selector) {
  const rule = cssRule(selector);
  const match = rule
    ? rule.match(/--bg-radial-accent:\s*rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
    : null;
  if (!match) return null;
  return '#' + match.slice(1, 4).map((value) => Number(value).toString(16).padStart(2, '0')).join('');
}

test('the macOS host mirrors every band accent for the popover glow', () => {
  const swift = hostSwift();
  DynaWall.THEMES.forEach((theme) => {
    const accent = accentHex(`[data-theme="${theme}"]`);
    assert.ok(accent, `[data-theme="${theme}"] needs a --bg-radial-accent colour`);
    assert.ok(
      swift.includes(`return "${accent}"`),
      `ThemeSlot.${theme}.accentHex should be ${accent}`
    );
  });
});

test('the preview card repeats the greeting the page renders', () => {
  const swift = hostSwift();
  assert.match(swift, /var previewGreeting: String/);
  assert.ok(
    swift.includes('"Good \\(GreetingPeriod.current().rawValue), \\(firstName)."'),
    'the preview must build the same string as buildGreeting()'
  );
  assert.match(swift, /static func normalizedName\(_ value: String\) -> String\?/);
  assert.match(swift, /case 5\.\.<12: return \.morning/);
  assert.match(swift, /case 12\.\.<18: return \.afternoon/);
  assert.match(swift, /default: return \.evening/);
  // The badge, the glow and the swatches all read the band the clock is on.
  assert.match(swift, /var activeThemeSlot: ThemeSlot\?/);
  assert.match(swift, /var accentHex: String/);
  assert.match(swift, /var swatchHex: String\?/);
});

test('the greeting name always comes from the logged-in macOS user', () => {
  const swift = hostSwift();
  const prefsStart = swift.indexOf('final class WallpaperPreferences');
  assert.notEqual(prefsStart, -1, 'WallpaperPreferences is missing');
  const prefs = swift.slice(prefsStart, swift.indexOf('\n}\n', prefsStart));

  // The name is computed on every read instead of being stored and editable, so
  // the popover and the desktop can never disagree about who is logged in.
  assert.match(
    prefs,
    /var firstName: String \{\s*Self\.detectedFirstName\(\)\s*\}/,
    'firstName must be read from the macOS account on every access'
  );
  assert.ok(!prefs.includes('@Published var firstName'), 'firstName must not be a stored preference');
  assert.ok(!prefs.includes('Key.firstName'), 'there is no firstName UserDefaults key any more');
  assert.ok(!swift.includes('$preferences.firstName'), 'the popover must not bind a name field');

  // A stored override from a previous build is deleted rather than honoured.
  const init = memberBody(swift, 'init(defaults: UserDefaults = .standard)');
  assert.match(init, /defaults\.removeObject\(forKey: "firstName"\)/);
  assert.ok(!init.includes('firstName ='), 'the name is never assigned or restored');

  // NSFullUserName() first, NSUserName() second, both cleaned exactly like the
  // page's normalizeName(), and only a nameless account falls back to Developer.
  const detected = memberBody(swift, 'static func detectedFirstName()');
  assert.match(detected, /NSFullUserName\(\)/);
  assert.match(detected, /NSUserName\(\)/);
  assert.match(detected, /normalizedName\(full\)/, 'the full name must be normalised like the page');
  assert.match(detected, /normalizedName\(short\) \?\? "Developer"/);

  // The same computed name drives the preview, the IPC push and the seed.
  assert.match(
    memberBody(swift, 'var previewGreeting: String'),
    /"Good \\\(GreetingPeriod\.current\(\)\.rawValue\), \\\(firstName\)\."/
  );
  assert.match(
    memberBody(swift, 'var javaScriptUpdate: String'),
    /livelyPropertyListener\("firstName", \\\(Self\.jsLiteral\(firstName\)\)\)/
  );
  const seed = memberBody(swift, 'func javaScriptSeed(photoURLs: [String]) -> String');
  assert.match(seed, /firstName/);
  assert.match(seed, /Self\.jsLiteral\(firstName\)/);
  assert.ok(!swift.includes('effectiveFirstName'), 'the blank-field fallback went with the field');
});

test('a chosen folder is the only photo source and starts the slideshow', () => {
  const swift = hostSwift();

  const dropped = memberBody(swift, 'func applyDroppedFolder(');
  assert.match(dropped, /isDirectory\.boolValue/, 'only a folder may be dropped');
  assert.match(dropped, /photoCollection = \.custom/);
  assert.match(dropped, /let path = url\.path == Self\.standardPhotoFolderPath \? "" : url\.path/);
  assert.match(dropped, /photoFolderPath = path/);
  assert.match(dropped, /slideshow = true/, 'a dropped folder must start the slideshow');

  // The bundled collections and their picker are gone from the host.
  assert.ok(!swift.includes('func selectCollection('), 'the collection picker must be gone');
  assert.ok(!swift.includes('func bundledFolder()'), 'there is no bundled folder fallback');
  assert.match(swift, /func reload\(folderPath: String\)/);
});

test('Reset restores the shipped defaults', () => {
  const swift = hostSwift();
  const reset = memberBody(swift, 'func resetToDefaults()');
  [
    ['subtitleText = Self.defaultSubtitle', 'subtitle'],
    ['themePreset = .auto', 'palette'],
    ['customColorHex = HexColor.fallback', 'colour'],
    ['slideshow = false', 'slideshow'],
    ['slideshowIntervalMinutes = 15', 'interval'],
    ['slideshowShuffle = true', 'shuffle'],
    ['kenBurns = true', 'slow zoom'],
    ['photoCollection = .custom', 'collection'],
    ['photoFolderPath = ""', 'photo folder'],
    ['photoCount = 0', 'photo count'],
    ['fontFamily = WallpaperFont.defaultFamily', 'font'],
    ['photoSync = true', 'time-of-day sync']
  ].forEach(([snippet, label]) => {
    assert.ok(reset.includes(snippet), `resetToDefaults() must restore the ${label}`);
  });
  // The greeting name is not resettable: it always follows the logged-in account.
  assert.ok(!reset.includes('firstName'), 'resetToDefaults() must not store a name');
  assert.match(swift, /\.help\("Restore the default subtitle, palette and slideshow"\)/);
});

test('the popover reveals the photo controls only while the slideshow runs', () => {
  const swift = hostSwift();
  const popover = swift.slice(swift.indexOf('struct SettingsPopoverView'));
  assert.match(popover, /if preferences\.slideshow \{/, 'the photo controls must be disclosed');
  const disclosed = popover.slice(popover.indexOf('if preferences.slideshow {'));
  [
    'Toggle("Match time of day"',
    'Picker("Rotate every"',
    'Toggle("Shuffle"',
    'Toggle("Slow zoom"'
  ].forEach((control) => {
    assert.ok(disclosed.includes(control), `${control} is missing from the disclosed section`);
  });
  // Folder-only photos: the upload row is always visible, while the slideshow
  // options stay disabled until the folder actually yields an image.
  assert.match(popover, /folderRow/);
  assert.match(popover, /\.disabled\(controller\.photoCount == 0\)/);
  assert.ok(!popover.includes('Picker("Collection"'), 'the collection tabs are gone');
  assert.match(popover, /xmark\.circle\.fill/, 'the subtitle needs a one-click clear');
});

test('the popover accepts a folder drop and sizes itself to its content', () => {
  const swift = hostSwift();
  assert.match(swift, /\.onDrop\(of: \[\.fileURL\], isTargeted:/);
  assert.match(swift, /loadItem\(forTypeIdentifier: identifier, options: nil\)/);
  assert.match(swift, /preferences\.applyDroppedFolder\(url\)/);
  assert.match(swift, /static let popoverWidth: CGFloat = 340/);
  assert.match(swift, /onContentHeightChange/);
  assert.match(swift, /popover\.contentSize = target/);
  assert.ok(!swift.includes('NSSize(width: 324'), 'the fixed 324×534 panel is gone');
});

test('the folder picker dismisses the settings popover and brings it back', () => {
  const swift = hostSwift();
  const popover = swift.slice(swift.indexOf('struct SettingsPopoverView'));

  // The view needs the panel it lives in so the picker can close it for the dialog
  // and re-present it afterwards.
  assert.match(popover, /weak var popover: NSPopover\?/);
  assert.match(swift, /popover: popover,/, 'makePopover() must hand the panel to the view');
  assert.match(
    swift,
    /onReopenPopover: \{ \[weak self\] in self\?\.presentPopover\(\) \}/,
    'the picker must be able to put the panel back'
  );

  const choose = memberBody(swift, 'private func choosePhotoFolder()');
  assert.match(choose, /popover\?\.close\(\)/, 'the panel steps aside for the dialog');
  // The dialog opens on a clean screen: the popover is dismissed outright rather
  // than pinned open behind the modal panel.
  assert.ok(!choose.includes('.applicationDefined'), 'the panel is closed, not pinned open');
  assert.ok(!choose.includes('previousBehavior'), 'there is no behavior left to restore');

  // Order is the whole interaction: out of the way before the dialog opens, back
  // once it returns, and once more after AppKit has finished tearing the modal down.
  const dismissed = choose.indexOf('popover?.close()');
  const modal = choose.indexOf('let response = panel.runModal()');
  const reopen = choose.indexOf('onReopenPopover?()');
  const asyncTurn = choose.indexOf('DispatchQueue.main.async {');
  assert.ok(
    dismissed !== -1 && modal !== -1 && reopen !== -1 && asyncTurn !== -1,
    'the picker lifecycle is incomplete'
  );
  assert.ok(dismissed < modal, 'the panel must be dismissed before the dialog opens');
  assert.ok(modal < reopen, 'the panel is brought back once the dialog closes');
  assert.ok(reopen < asyncTurn, 'and once more after AppKit has torn the modal down');

  // The panel is re-anchored under the menu bar icon rather than reopened wherever
  // AppKit last remembered it, and re-showing is skipped while it is already up, so
  // calling it twice in a row is safe.
  const present = memberBody(swift, 'private func presentPopover()');
  assert.match(present, /if !popover\.isShown \{/);
  assert.match(
    present,
    /popover\.show\(relativeTo: button\.bounds, of: button, preferredEdge: \.minY\)/
  );
  assert.match(present, /popover\.contentViewController\?\.view\.window\?\.makeKey\(\)/);

  // The icon keeps using the same path, so both entry points agree.
  const toggle = memberBody(swift, 'private func togglePopover(_ sender: Any?)');
  assert.match(toggle, /presentPopover\(\)/, 'the icon reuses the anchoring path');

  // Outside-click dismissal is still AppKit's, as the panel opens transient.
  assert.match(swift, /popover\.behavior = \.transient/);
});

test('the host publishes the photo the page put on screen', () => {
  const swift = hostSwift();
  assert.match(swift, /@Published private\(set\) var currentPhotoName = ""/);
  assert.match(swift, /@Published private\(set\) var photoCount = 0/);
  assert.match(swift, /var onAdvance: \(\(String\) -> Void\)\?/);
  assert.match(swift, /photoLogger\.onAdvance = \{ \[weak self\] name in/);
  assert.match(swift, /static func photoName\(fromSource source: String\) -> String\?/);
  // Turning the slideshow off must drop the stale photo name.
  assert.match(swift, /if !self\.preferences\.slideshow \{\s*self\.currentPhotoName = ""/);
});


test('the preview centres its glow, dims the bottom edge and names the paused state', () => {
  const swift = hostSwift();
  const preview = memberBody(swift, 'private var previewCard: some View');
  assert.match(preview, /UnitPoint\(x: 0\.5, y: 0\.35\)/, 'the glow must be centred, not a corner spotlight');
  assert.ok(!preview.includes('.topTrailing'), 'the harsh diagonal glow is gone');
  assert.match(swift, /Wallpaper paused — click Resume to reattach/);
});

test('the preview card is set in the wallpaper’s Outfit face and band inks', () => {
  const swift = hostSwift();
  const preview = memberBody(swift, 'private var previewCard: some View');

  // Same face, weight, tracking and ink as .greeting / .subtitle in style.css —
  // and the same family the page was told to use, so the card previews the choice.
  assert.match(preview, /WallpaperFont\.semibold\(size: 19, family: preferences\.fontFamily\)/);
  assert.match(preview, /WallpaperFont\.tracking\(size: 19, em: -0\.03\)/);
  assert.match(preview, /WallpaperFont\.regular\(size: 11, family: preferences\.fontFamily\)/);
  assert.match(preview, /WallpaperFont\.tracking\(size: 11, em: 0\.012\)/);
  assert.match(preview, /previewTextPrimaryHex/);
  assert.match(preview, /previewTextSecondaryHex/);
  assert.equal(
    (preview.match(/\.multilineTextAlignment\(\.center\)/g) || []).length,
    2,
    'the greeting and subtitle must be centred like .wallpaper-content'
  );
  assert.match(
    preview,
    /\.frame\(maxWidth: \.infinity, alignment: \.center\)/,
    'the centred text block must span the card'
  );
  assert.ok(!preview.includes('design: .rounded'), 'the preview must not use SF Rounded');
  assert.ok(!preview.includes('.white.opacity(0.62)'), 'the subtitle must use the palette ink');

  const fontStart = swift.indexOf('enum WallpaperFont');
  assert.notEqual(fontStart, -1, 'WallpaperFont is missing');
  const font = swift.slice(fontStart, swift.indexOf('\n}\n', fontStart));
  assert.match(font, /CTFontManagerRegisterFontsForURL/);
  // Every bundled face is registered and asked for by PostScript name, not just
  // Outfit: a preset has to preview in its own file rather than the system face.
  assert.match(font, /\.custom\(faces\.semibold, size: size\)/);
  assert.match(font, /\.custom\(faces\.regular, size: size\)/);
  BUNDLED_FONTS.forEach(({ family, slug, postScript }) => {
    assert.match(
      font,
      new RegExp(`"${family}": \\("${slug}", "${postScript}-Regular", "${postScript}-SemiBold"\\)`),
      `${family} must map to its bundled files and PostScript names`
    );
  });

  const launch = memberBody(swift, 'func applicationDidFinishLaunching(');
  assert.match(launch, /WallpaperFont\.register\(\)/, 'register before the popover can open');

  BUNDLED_FONTS.forEach(({ regular, semibold }) => {
    [regular, semibold].forEach((file) => {
      assert.ok(fs.existsSync(path.join(ROOT, file)), `missing preview font ${file}`);
    });
  });
});

test('the Greeting card only holds the subtitle field', () => {
  const swift = hostSwift();
  const greeting = memberBody(swift, 'private var greetingCard: some View');
  assert.match(
    greeting,
    /TextField\("What are we building today\? \(empty hides\)", text: \$preferences\.subtitleText\)/
  );
  assert.equal(
    (greeting.match(/TextField\(/g) || []).length,
    1,
    'the subtitle is the only input in the Greeting card'
  );
  assert.ok(!greeting.includes('Your first name'), 'the manual first-name field must be gone');
  assert.ok(!greeting.includes('$preferences.firstName'), 'no field binds a stored name');
  assert.ok(!swift.includes('private var greetingHint'), 'the name hint went with the field');
});

test('the subtitle clear button lives inside a full-width field', () => {
  const swift = hostSwift();
  const greeting = memberBody(swift, 'private var greetingCard: some View');
  assert.match(greeting, /\.overlay\(alignment: \.trailing\)/);
  assert.ok(
    !/HStack\(spacing: 6\) \{\s*TextField\("What are we building today\?/.test(greeting),
    'the clear button must not sit beside the subtitle field'
  );
});

test('the popover aligns its cards, switches and controls on one grid', () => {
  const swift = hostSwift();

  // One glyph slot for every card header: the fixed frame — not the SF Symbol —
  // is what puts GREETING, TYPOGRAPHY, PHOTOS, DESKTOP WIDGETS and STARTUP on the
  // same vertical guide line.
  assert.match(swift, /private static let headerIconSize: CGFloat = 14/);
  const cardChrome = memberBody(swift, 'private func card<Content: View>(');
  assert.match(
    cardChrome,
    /\.frame\(width: Self\.headerIconSize, height: Self\.headerIconSize, alignment: \.center\)/,
    'the section glyphs must share one slot'
  );

  // One radius for the cards and one for the controls inside them, so no section
  // (or control) can quietly drift a point or two off the others.
  assert.match(swift, /private static let cardCornerRadius: CGFloat = 12/);
  assert.match(swift, /private static let controlCornerRadius: CGFloat = 8/);
  assert.equal(
    (cardChrome.match(/cornerRadius: Self\.cardCornerRadius/g) || []).length,
    2,
    'the card fill and its border must use the shared radius'
  );

  // The four satellites are two equal columns on two rows, so the labels and the
  // switches line up instead of drifting with the length of the words.
  const widgets = memberBody(swift, 'private var widgetsCard: some View');
  assert.equal(
    (widgets.match(/\.frame\(maxWidth: \.infinity, alignment: \.leading\)/g) || []).length,
    4,
    'each satellite takes exactly one column'
  );
  assert.equal(
    (widgets.match(/HStack\(alignment: \.center, spacing: Self\.toggleColumnSpacing\)/g) || []).length,
    2,
    'the satellites ride two rows of equal columns'
  );
  ['Music', 'News', 'YouTube', 'Weather'].forEach((name) => {
    assert.match(widgets, new RegExp(`Toggle\\("${name}", isOn: \\$preferences\\.widget`));
  });

  // The slideshow options ride the same two-column grid as the widgets above them.
  const photos = memberBody(swift, 'private var photosCard: some View');
  assert.match(
    photos,
    /Toggle\("Shuffle", isOn: \$preferences\.slideshowShuffle\)\s*\n\s*\.toggleStyle\(\.switch\)\s*\n\s*\.controlSize\(\.small\)\s*\n\s*\.frame\(maxWidth: \.infinity, alignment: \.leading\)/,
    'Shuffle must take the first column'
  );
  assert.match(
    photos,
    /Toggle\("Slow zoom", isOn: \$preferences\.kenBurns\)\s*\n\s*\.toggleStyle\(\.switch\)\s*\n\s*\.controlSize\(\.small\)\s*\n\s*\.frame\(maxWidth: \.infinity, alignment: \.leading\)/,
    'Slow zoom must take the second column'
  );
  // The interval picker and its label share one centre line, and the segmented bar
  // keeps a stable footprint so the row never reflows.
  assert.match(
    photos,
    /HStack\(alignment: \.center, spacing: 8\) \{\s*\n\s*Text\("Rotate every"\)/
  );
  assert.match(
    photos,
    /\.frame\(minWidth: 172, alignment: \.trailing\)/,
    'the segmented bar keeps its footprint'
  );

  // The subtitle field is set like the other controls (11 pt on the shared plate),
  // and its trailing inset keeps typed text out from under the clear button.
  const greeting = memberBody(swift, 'private var greetingCard: some View');
  assert.match(greeting, /\.font\(\.system\(size: 11\)\)/);
  assert.match(greeting, /\.padding\(\.trailing, 14\)/, 'typed text must stop before the button');
  assert.match(
    greeting,
    /cornerRadius: Self\.controlCornerRadius/,
    'the field shares the control radius'
  );

  // The folder glyph gets a fixed slot and the reveal button wears a plate, so the
  // row's two buttons sit on one line instead of a bare glyph beside a bordered one.
  const row = memberBody(swift, 'private var folderRow: some View');
  assert.match(row, /\.frame\(width: 18, height: 18, alignment: \.center\)/);
  assert.match(row, /\.frame\(width: 24, height: 20, alignment: \.center\)/);
  assert.match(row, /cornerRadius: Self\.controlCornerRadius/);

  // The typography menu label carries the same border as every other control, and
  // spans the card like the subtitle field and the folder row do.
  const typography = memberBody(swift, 'private var typographyCard: some View');
  assert.match(
    typography,
    /\.strokeBorder\(Color\.primary\.opacity\(0\.08\), lineWidth: 1\)/,
    'the font menu must wear the control border'
  );
  assert.match(
    typography,
    /\.frame\(maxWidth: \.infinity, alignment: \.leading\)/,
    'the font menu plate must span the card'
  );

  // The footer is set apart from the cards and its two actions share one centre line.
  const footer = memberBody(swift, 'private var footer: some View');
  assert.match(footer, /Divider\(\)/, 'the footer needs a hairline above it');
  assert.match(footer, /HStack\(alignment: \.center, spacing: 8\)/);
  assert.equal(
    (footer.match(/\.frame\(height: 20\)/g) || []).length,
    2,
    'Reset and Quit must sit on the same line'
  );
});

test('the popover drops the Palette card and leaves the clock in charge', () => {
  const swift = hostSwift();
  const popover = swift.slice(swift.indexOf('struct SettingsPopoverView'));
  assert.ok(!popover.includes('paletteCard'), 'the Palette card is gone');
  assert.ok(!popover.includes('private var swatches'), 'the swatch grid is gone');
  assert.ok(!popover.includes('SwatchColorWell'), 'the colour well is gone');

  // `themePreset` can only ever be `.auto`: a stored band, fixed colour or custom
  // pick from an earlier build is migrated back to the clock and written out.
  assert.match(swift, /if themePreset != \.auto \{\s*themePreset = \.auto/);
  assert.match(swift, /defaults\.set\(ThemePreset\.auto\.rawValue, forKey: Key\.themePreset\)/);
  // With no photos, the page is handed a custom black palette rather than a band.
  assert.match(swift, /if photoCount == 0 \{ return "#000000" \}/);
  assert.match(swift, /photoCount == 0 \? "custom" : themePreset\.themeMode/);
});

test('photo captions drop watermarks, resolutions and sort prefixes', () => {
  const swift = hostSwift();
  const titlesStart = swift.indexOf('private static let photoTitles');
  assert.notEqual(titlesStart, -1, 'the curated titles are missing');
  const titles = swift.slice(titlesStart, swift.indexOf('\n    ]', titlesStart));
  [
    '"iClarified-macOS-27-Golden-Gate-Day-Wallpaper": "Golden Gate · Day"',
    '"iClarified-macOS-27-Golden-Gate-Sunset-Wallpaper": "Golden Gate · Sunset"',
    '"01-neon-dusk": "Neon Dusk"',
    '"02-solar-flare": "Solar Flare"'
  ].forEach((mapping) => {
    assert.ok(titles.includes(mapping), `missing clean title ${mapping}`);
  });

  const name = memberBody(swift, 'static func photoName(fromSource source: String) -> String?');
  assert.match(name, /iClarified-macOS-27-/, 'the blog watermark must be stripped');
  assert.match(name, /\["wallpaper", "4k", "5k"/, 'resolution/boilerplate words must be stripped');
  assert.match(name, /isNumber/, 'leading sort prefixes must be stripped');
  assert.ok(name.includes('"Golden Gate · '), 'the location reads as subject · light');
});

test('the Photos card uses a standard folder and waits for images before enabling options', () => {
  const swift = hostSwift();
  const photos = memberBody(swift, 'private var photosCard: some View');
  assert.ok(!photos.includes('Picker("Collection"'), 'the collection tabs are gone');
  assert.ok(!photos.includes('collectionBinding'), 'there is no collection binding');
  assert.match(photos, /folderRow/, 'the upload row is always visible');
  assert.match(photos, /\.disabled\(controller\.photoCount == 0\)/, 'options wait for images');
  assert.ok(
    (photos.match(/\.controlSize\(\.small\)/g) || []).length >= 4,
    'the interval picker and toggles use the small control size'
  );
  assert.match(swift, /static var standardPhotoFolderPath: String/);
  assert.match(swift, /\.picturesDirectory/);
  assert.match(swift, /appendingPathComponent\("DynaWall", isDirectory: true\)/);
  assert.match(swift, /var effectivePhotoFolderPath: String/);
  assert.match(swift, /var usesStandardPhotoFolder: Bool/);
  assert.match(swift, /"Pictures\/DynaWall"/);
  assert.match(swift, /"Change Folder…"/);
  assert.match(swift, /"Empty · standard folder"/);
  assert.match(swift, /"photos"\) · standard folder/);
  assert.match(swift, /return "No supported images"/);
  assert.ok(
    !swift.includes('drop another folder to switch'),
    'the folder caption must not explain what dropping a folder does'
  );

  // The empty and off states are a two-word capsule, not a paragraph: the folder row
  // already reports the count, so only the disabled switch needs a reason.
  assert.match(photos, /statusBadge\("No photos"\)/, 'the disabled switch says why in two words');
  assert.ok(!photos.includes('your greeting sits'), 'the off-state paragraph is gone');
  assert.ok(!photos.includes('No photos yet'), 'the empty-state paragraph is gone');
});

test('the standard Pictures/DynaWall folder is created and seeded from the bundle', () => {
  const swift = hostSwift();
  assert.match(swift, /static var standardPhotoFolderPath: String/);
  assert.match(swift, /\.picturesDirectory/);
  assert.match(swift, /appendingPathComponent\("DynaWall", isDirectory: true\)/);

  const start = memberBody(swift, 'func start()');
  assert.match(start, /prepareStandardPhotoFolder\(\)/, 'the folder must exist before the first scan');

  const prepare = memberBody(swift, 'private func prepareStandardPhotoFolder()');
  assert.match(prepare, /FileManager\.default\.createDirectory/);
  assert.match(prepare, /seedStandardPhotoFolder\(at: folder\)/);
  assert.match(prepare, /fileExists\(atPath: folder\.path, isDirectory: &isDirectory\)/);

  const seed = memberBody(swift, 'private func seedStandardPhotoFolder(at folder: URL)');
  assert.match(seed, /Bundle\.main\.resourceURL\?/);
  assert.match(seed, /appendingPathComponent\("images", isDirectory: true\)/);
  assert.match(seed, /PhotoLibrary\.supportedExtensions/);
  assert.match(seed, /copyItem\(at: source, to: destination\)/);

  const reload = memberBody(swift, 'private func reloadPhotosIfNeeded');
  assert.match(reload, /let path = preferences\.effectivePhotoFolderPath/);
  assert.match(reload, /photoLibrary\.reload\(folderPath: path\)/);

  const choose = memberBody(swift, 'private func choosePhotoFolder()');
  assert.match(choose, /preferences\.effectivePhotoFolderPath/);
  assert.match(choose, /url\.path == WallpaperPreferences\.standardPhotoFolderPath \? "" : url\.path/);

  const drop = memberBody(swift, 'func applyDroppedFolder(');
  assert.match(drop, /let path = url\.path == Self\.standardPhotoFolderPath \? "" : url\.path/);
});

test('Pause/Resume appears once and an empty folder clears the old photos', () => {
  const swift = hostSwift();
  const footer = memberBody(swift, 'private var footer: some View');
  assert.ok(!footer.includes('togglePause'), 'the preview pill already owns Pause/Resume');
  assert.match(footer, /Button\("Quit"\)/);
  assert.match(swift, /if entry\.pushedPhotos != photosURLs \{/);
  assert.ok(
    !swift.includes('if !photosURLs.isEmpty, entry.pushedPhotos'),
    'an empty custom folder must reach the page instead of leaving stale photos'
  );
});

test('the menu bar mark sits flush on its horizon, at the app icon proportions', () => {
  const swift = hostSwift();
  const icon = memberBody(swift, 'static func makeMenuBarIcon() -> NSImage');
  // Optical anchor: the dome is centred just above the geometric middle, and the
  // razor horizon is wider than the dome so it reads as a horizon, not an underline.
  assert.match(icon, /let center = NSPoint\(x: size\.width \/ 2, y: 9\.2\)/);
  assert.match(icon, /let orbRadius: CGFloat = 5\.6/);
  assert.match(icon, /let horizonWidth: CGFloat = 15\.4/);
  // Flush: the dome's base meets the line, exactly as in the app icon — no gap.
  assert.doesNotMatch(icon, /horizonGap/);
  assert.match(icon, /y: center\.y - horizonThickness/);
});

test('the popover includes an option to run on startup / launch at login', () => {
  const swift = hostSwift();
  assert.match(swift, /enum LaunchAtLogin/);
  assert.match(swift, /SMAppService\.mainApp/);
  assert.match(swift, /static let launchAtLogin = "launchAtLogin"/);
  assert.match(swift, /@Published var launchAtLogin: Bool/);
  assert.match(swift, /private var startupCard: some View/);
  assert.match(swift, /Toggle\("Launch at login", isOn: \$preferences\.launchAtLogin\)/);
  assert.match(swift, /startupCard/);
  // The label already says what the switch does; the card is one row plus the warning
  // that only appears when macOS is waiting for approval.
  assert.ok(
    !swift.includes('Start DynaWall automatically when you log in'),
    'the startup explainer is gone'
  );
});


group('App bundle');

test('the macOS bundle ships a custom AppIcon.icns and Info.plist icon entry', () => {
  const plist = fs.readFileSync(path.join(ROOT, 'macos', 'Info.plist'), 'utf8');
  assert.match(plist, /<key>CFBundleIconFile<\/key>\s*<string>AppIcon<\/string>/);
  assert.match(plist, /<key>CFBundleIconName<\/key>\s*<string>AppIcon<\/string>/);
  const icnsPath = path.join(ROOT, 'macos', 'AppIcon.icns');
  const pngPath = path.join(ROOT, 'macos', 'AppIcon.png');
  assert.ok(fs.existsSync(path.join(ROOT, 'macos', 'make-icon.swift')), 'missing macos/make-icon.swift');
  assert.ok(fs.existsSync(icnsPath), 'missing macos/AppIcon.icns');
  assert.ok(fs.existsSync(pngPath), 'missing macos/AppIcon.png');

  // The preview PNG is the 1024x1024 master: 8-byte PNG signature, then the IHDR
  // width/height as big-endian uint32s (12 bytes in, after the chunk length/type).
  const png = fs.readFileSync(pngPath);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'AppIcon.png must start with the PNG signature');
  assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR', 'AppIcon.png must start with an IHDR chunk');
  assert.equal(png.readUInt32BE(16), 1024, 'AppIcon.png must be 1024 px wide');
  assert.equal(png.readUInt32BE(20), 1024, 'AppIcon.png must be 1024 px tall');

  const icnsHeader = fs.readFileSync(icnsPath).subarray(0, 4).toString('ascii');
  assert.equal(icnsHeader, 'icns', 'AppIcon.icns must begin with the icns magic header');
});

test('the icon master is pure geometry: one dome, one razor line, no aura', () => {
  const swift = fs.readFileSync(path.join(ROOT, 'macos', 'make-icon.swift'), 'utf8');

  // Apple's icon grid, intact: an 824 pt squircle with 185 pt corners centred in the
  // 1024 pt canvas, so the mark keeps the standard 100 pt margin on every side.
  assert.match(swift, /CGRect\(x: 100, y: 100, width: 824, height: 824\)/);
  assert.match(swift, /let cornerRadius: CGFloat = 185\.0/);

  // Every hairline snaps to whole device pixels, so the 16x16 entry keeps a one-pixel
  // horizon instead of smearing it into grey haze.
  assert.match(swift, /func hairline\(_ modelled: CGFloat\) -> CGFloat/);
  assert.match(swift, /let horizonThickness = hairline\(/);

  // The shipped mark is the Bauhaus silhouette: one flat bone dome on a flat obsidian
  // field, cut by a single razor horizon. No gradients anywhere in that path.
  assert.match(swift, /func renderBauhausIcon\(pixelSize: Int, drawArc: Bool\)/);
  assert.match(swift, /let bone = srgb\(250, 246, 238\)/);
  assert.match(swift, /default: return \.bauhaus/, 'Bauhaus is the default mark');

  // The earlier gradient reading of the same geometry stays switchable, so both can be
  // rendered from one generator (DYNAWALL_ICON_DESIGN=monolith|arc).
  assert.match(swift, /case \.luminousMonolith:/);
  assert.match(swift, /colors: \[ivory, amber\] as CFArray/);

  // The atmospheric layers stay gone: no dusk whisper, no corona bloom, no specular
  // inner rim and no reflection bleeding off the water.
  assert.doesNotMatch(swift, /drawRadialGradient/, 'the mark must stay free of radial bloom');
  assert.doesNotMatch(swift, /let (whisper|corona|reflection) = CGGradient/, 'the aura layers are gone for good');
});

test('the menu bar icon is a custom vector template, not an SF Symbol', () => {
  const swift = hostSwift();
  assert.match(swift, /static func makeMenuBarIcon\(\) -> NSImage/);
  assert.match(swift, /image\.isTemplate = true/);
  assert.match(swift, /button\.image = Self\.makeMenuBarIcon\(\)/);
  // The mark is the app icon at menu bar scale: one solid dome sitting flush on a
  // square-ended razor horizon, with no rays and no eclipse arc.
  const icon = memberBody(swift, 'static func makeMenuBarIcon() -> NSImage');
  assert.match(icon, /appendArc\(withCenter: center, radius: orbRadius, startAngle: 0, endAngle: 180/);
  assert.match(icon, /NSBezierPath\(rect: NSRect\(/, 'the horizon is a square-ended razor line');
  assert.doesNotMatch(icon, /\[90\.0, 45\.0, 135\.0\]/, 'the three rays are gone');
  assert.doesNotMatch(icon, /setLineDash/, 'the dashed eclipse arc is gone');
  assert.ok(!swift.includes('text.below.photo'), 'the generic SF Symbol menu bar icon is gone');
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
  assert.equal(livelyProperties.photoSync.value, DynaWall.DEFAULT_CONFIG.photoSync);
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
  assert.equal(properties.photosync.value, DynaWall.DEFAULT_CONFIG.photoSync);
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
    'style.css'
  ]
    .concat(BUNDLED_FONTS.flatMap((font) => [font.woff2, font.regular, font.semibold]))
    .concat(DynaWall.BUNDLED_PHOTOS)
    .forEach((asset) => {
      assert.ok(fs.existsSync(path.join(ROOT, asset)), `missing asset: ${asset}`);
    });

  // The README and Lively preview is a 1280×720 render with the greeting baked in,
  // not the old blank 640×360 gradient.
  const thumbnail = fs.readFileSync(path.join(ROOT, 'thumbnail.png'));
  assert.equal(thumbnail.readUInt32BE(16), 1280);
  assert.equal(thumbnail.readUInt32BE(20), 720);
});

/* -------------------------------------------------------------------------- *
 * Efficiency guards
 * -------------------------------------------------------------------------- */

group('Clock scheduling');

test('the clock is a one-shot boundary timer, not a 30 s poll', () => {
  assert.deepEqual(DynaWall.CLOCK_BOUNDARY_HOURS, [5, 9, 12, 17, 18, 21]);
  const script = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
  assert.ok(!/setInterval\(/.test(script), 'script.js must not poll on an interval any more');
  assert.match(script, /win\.setTimeout\(function \(\) \{/, 'the clock is a one-shot timer');
  assert.match(script, /msUntilNextClockBoundary\(\)/, 'armed from the next boundary');
  // The historical cadence constant stays exported for hosts and tests.
  assert.equal(DynaWall.CLOCK_REFRESH_MS, 30000);
});

test('msUntilNextClockBoundary() targets each of the six daily edges', () => {
  const hourMs = 60 * 60 * 1000;
  [
    ['05:00 → 09:00', 5, 9],
    ['09:00 → 12:00', 9, 12],
    ['12:00 → 17:00', 12, 17],
    ['17:00 → 18:00', 17, 18],
    ['18:00 → 21:00', 18, 21],
    ['21:00 → 05:00 (next day)', 21, 5]
  ].forEach(([label, from, to]) => {
    const expected = ((to - from + 24) % 24) * hourMs - 30000; // `at()` is h:mm:30
    assert.equal(DynaWall.msUntilNextClockBoundary(at(from, 0)), expected, label);
  });
});

test('an exact boundary schedules the next one and stays inside setTimeout', () => {
  const hourMs = 60 * 60 * 1000;
  assert.equal(
    DynaWall.msUntilNextClockBoundary(new Date(2026, 0, 15, 5, 0, 0, 0)),
    4 * hourMs,
    'the 05:00 state is already applied, so the timer waits for 09:00'
  );
  assert.equal(
    DynaWall.msUntilNextClockBoundary(new Date(2026, 0, 15, 23, 30, 0, 0)),
    5.5 * hourMs,
    'past the last edge the timer wraps to 05:00'
  );
  [0, 3, 4, 5, 8, 9, 12, 16, 17, 20, 21, 23].forEach((hours) => {
    const wait = DynaWall.msUntilNextClockBoundary(at(hours, 37));
    assert.ok(wait > 0 && wait <= 8 * hourMs, `unexpected wait at ${hours}:37 (${wait} ms)`);
  });
});

group('Suspension');

test('suspend is a live host flag, never a cached setting', () => {
  assert.equal(DynaWall.LIVELY_SUSPEND, 'suspend');
  assert.equal(DynaWall.DEFAULT_CONFIG.suspend, undefined, 'suspend is not configurable');
  assert.equal(DynaWall.STORAGE_KEYS.suspend, undefined, 'suspend is never cached');
  assert.equal(DynaWall.isLivelyAction('suspend'), false, 'suspend carries a value; nextPhoto does not');
  // Before the page boots the request is parked for the app.
  assert.equal(DynaWall.setSuspended(true), true);
  assert.equal(DynaWall.setSuspended(false), false);
});

test('suspension parks the timers and pauses the drift in CSS', () => {
  const script = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
  const app = script.slice(script.indexOf('function createApp('));
  assert.match(app, /function applySuspension\(\)/, 'applySuspension() is missing');
  assert.match(app, /function setSuspended\(paused\)/, 'setSuspended() is missing');
  assert.match(app, /classList\.add\('is-suspended'\)/);
  assert.match(app, /classList\.remove\('is-suspended'\)/);
  assert.match(app, /win\.clearTimeout\(state\.clockTimer\)/, 'the clock timer must be cleared');
  assert.match(app, /win\.clearTimeout\(state\.photoTimer\)/, 'the slideshow timer must be cleared');
  assert.match(app, /addEventListener\('visibilitychange', applySuspension\)/);
  assert.match(
    script,
    /name\.trim\(\)\.toLowerCase\(\) === LIVELY_SUSPEND/,
    'livelyPropertyListener("suspend", …) must reach setSuspended()'
  );
  assert.match(
    css,
    /html\.is-suspended \.photo\.is-ken-burns\s*{[^}]*animation-play-state:\s*paused/,
    'the Ken Burns drift must stop while suspended'
  );
});

group('Rendering cost');

test('applyTheme() never forces a synchronous style recalculation', () => {
  const script = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
  const from = script.indexOf('function applyTheme()');
  assert.notEqual(from, -1, 'applyTheme() is missing');
  const body = script.slice(from, script.indexOf('\n    }', from));
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/getComputedStyle/.test(code), 'applyTheme() must not read computed styles');
  assert.match(code, /THEME_BG_HEX\[theme\]/, 'the band colour comes from the constant table');
  // The table itself has to agree with the CSS the browser actually paints.
  DynaWall.THEMES.forEach((band) => {
    assert.equal(
      DynaWall.THEME_BG_HEX[band],
      ruleBackground(`[data-theme="${band}"]`),
      `THEME_BG_HEX.${band} disagrees with style.css`
    );
  });
});

test('the photo drift only forces a layout when it restarts the same layer', () => {
  const script = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
  const from = script.indexOf('function paintPhoto(');
  const body = script.slice(from, script.indexOf('\n    }', from));
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal((code.match(/offsetWidth/g) || []).length, 1, 'exactly one layout read');
  assert.match(code, /if \(wasDrifting && drift\) void layer\.offsetWidth/);
  assert.match(code, /wasDrifting && drift/, 'only a re-armed layer pays for the reflow');
});

test('no layer is promoted unless it is actually on screen', () => {
  const willChange = Array.from(css.matchAll(/will-change:\s*([^;]+);/g)).map((match) =>
    match[1].trim()
  );
  assert.deepEqual(
    willChange,
    ['opacity, transform', 'auto', 'opacity, transform'],
    'only the entrance fade and the visible photo are promoted'
  );
  assert.match(css, /body\.has-photo \.photo\.is-visible\s*{[^}]*will-change:\s*opacity, transform/);
  assert.match(css, /\.wallpaper-content\.is-loaded\s*{[^}]*will-change:\s*auto/);
  assert.match(css, /\.wallpaper-container\s*{[^}]*contain:\s*layout style paint/);
  assert.match(css, /\.photo-stack\s*{[^}]*contain:\s*layout style paint/);
});

group('Photo classification memoisation');

test('classifyPhotos() serves stable buckets and notices an in-place edit', () => {
  const list = DynaWall.GOLDEN_GATE_PHOTOS.slice();
  const first = DynaWall.classifyPhotos(list);
  const second = DynaWall.classifyPhotos(list);
  assert.deepEqual(second, first, 'the memoised result is identical');
  assert.notEqual(second.dawn, first.dawn, 'callers get copies, never the cached arrays');
  list.push('images/07-night-study.jpg');
  const third = DynaWall.classifyPhotos(list);
  assert.deepEqual(third.night, first.night.concat(['images/07-night-study.jpg']));
});

test('getPhotosForSlot() stays consistent through the memo', () => {
  const list = DynaWall.ABSTRACT_PHOTOS.slice();
  assert.deepEqual(DynaWall.getPhotosForSlot(list, 'dusk'), ['images/01-neon-dusk.jpg']);
  assert.deepEqual(DynaWall.getPhotosForSlot(list, 'dusk'), ['images/01-neon-dusk.jpg']);
  assert.deepEqual(DynaWall.getPhotosForSlot(list, 'day'), [
    'images/02-solar-flare.jpg',
    'images/03-deep-ocean.jpg'
  ]);
});

test('photo lists are de-duplicated in linear time', () => {
  const script = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
  const from = script.indexOf('function normalizePhotos(');
  const body = script.slice(from, script.indexOf('\n  }', from));
  assert.match(body, /new Set\(\)/, 'normalizePhotos() must de-duplicate with a Set');
  assert.ok(!/photos\.indexOf\(/.test(body), 'indexOf() de-duplication is O(N²)');
});

group('Host seed');

test('the document-start seed outranks URL and cache but not live IPC', () => {
  const seed = { firstName: 'Ada', theme: 'night', photos: ['dynawall-photo://photo/0/a.jpg'] };
  const config = DynaWall.resolveConfig({
    ipc: {},
    seed: seed,
    url: { firstName: 'Grace' },
    storage: { subtitle: 'cached' },
    defaults: DynaWall.DEFAULT_CONFIG
  });
  assert.equal(config.firstName, 'Ada', 'the seed is the host, so it beats the URL');
  assert.equal(config.theme, 'night');
  assert.equal(config.subtitle, 'cached', 'unseeded fields still resolve from the cache');
  assert.deepEqual(config.photos, ['dynawall-photo://photo/0/a.jpg']);

  const ipc = DynaWall.resolveConfig({
    ipc: { firstName: 'Lin' },
    seed: seed,
    url: {},
    storage: {},
    defaults: DynaWall.DEFAULT_CONFIG
  });
  assert.equal(ipc.firstName, 'Lin', 'live IPC still wins');
});

test('a seed is normalised exactly like an IPC value', () => {
  assert.deepEqual(
    DynaWall.readSeed({
      __dynawallSeed: {
        firstName: '  Ada   Lovelace ',
        slideshow: 'yes',
        photos: 'a.jpg, a.jpg, b.jpg',
        theme: 'nope'
      }
    }),
    { firstName: 'Ada', slideshow: true, photos: ['a.jpg', 'b.jpg'] }
  );
  assert.deepEqual(DynaWall.readSeed({}), {});
  assert.deepEqual(DynaWall.readSeed(null), {});
});

test('the macOS host seeds the page, suspends it and keeps its own clock', () => {
  const swift = hostSwift();
  // First paint is the user's wallpaper: the seed is injected before parsing.
  assert.match(swift, /injectionTime: \.atDocumentStart/);
  assert.match(swift, /func javaScriptSeed\(photoURLs: \[String\]\) -> String/);
  assert.match(swift, /window\.__dynawallSeed/);
  // Occlusion, display sleep and session lock park the page; it is told once.
  assert.match(swift, /NSWindow\.didChangeOcclusionStateNotification/);
  assert.match(swift, /NSWorkspace\.screensDidSleepNotification/);
  assert.match(swift, /NSWorkspace\.screensDidWakeNotification/);
  assert.match(swift, /NSWorkspace\.willSleepNotification/);
  assert.match(swift, /NSWorkspace\.sessionDidResignActiveNotification/);
  assert.match(swift, /NSWorkspace\.sessionDidBecomeActiveNotification/);
  assert.match(swift, /static func javaScriptSuspend/);
  // Delta pushes: a keystroke never re-encodes the photo array.
  assert.match(swift, /entry\.pushedPhotos != photosURLs/);
  assert.match(swift, /entry\.pushedSettings != settingsScript/);
  // One-shot theme clock instead of a 60 s repeating timer.
  assert.match(swift, /static func nextBoundary\(after now: Date = Date\(\)/);
  assert.match(swift, /Timer\(fire: fireDate, interval: 0, repeats: false\)/);
  assert.ok(!/timeInterval: 60, repeats: true/.test(swift), 'the 60 s poll is gone');
  assert.match(swift, /Notification\.Name\.NSSystemClockDidChange/);
  assert.match(swift, /\.NSCalendarDayChanged/);
  // Folder-only photos: the scan is the only source, and an empty path or empty
  // folder resolves to zero photos rather than a bundled collection.
  const reload = memberBody(swift, 'func reload(folderPath:');
  assert.ok(!reload.includes('curated'), 'the bundled collection fallback must not survive in the folder scan');
  assert.match(swift, /preferences\.updatePhotoCount\(count\)/);
  assert.match(swift, /if count == 0 && preferences\.slideshow \{\s*preferences\.slideshow = false/);
  // The seed always carries `photos` (even empty) and a black `bgColor` while the
  // folder yields nothing, so the very first frame is the black fallback.
  const seed = memberBody(swift, 'func javaScriptSeed(photoURLs: [String]) -> String');
  assert.match(seed, /\\"photos\\": \\\(Self\.jsArrayLiteral\(photoURLs\)\)/, 'photos must always be seeded');
  assert.match(seed, /if usesPinnedColor \|\| photoCount == 0/);
  assert.match(swift, /photoCount == 0 \? "custom" : themePreset\.themeMode/);
  // The SwiftUI popover is built on first click, not at launch.
  assert.match(swift, /private func makePopover\(\) -> NSPopover/);
  assert.ok(!swift.includes('configurePopover'), 'the popover must not be built at launch');
  // Handlers registered on a web view are removed with it.
  assert.match(swift, /removeScriptMessageHandler\(forName: "dynawallPhoto"\)/);
  // WKProcessPool does not isolate processes on macOS 12, so it is not used.
  assert.ok(!/WKProcessPool/.test(swift), 'the shared process pool was cargo cult');
});

test('the bundle ships only the curated wallpapers, optimised', () => {
  const build = fs.readFileSync(path.join(ROOT, 'build-macos.sh'), 'utf8');
  const listed = Array.from(build.matchAll(/^\s{2}"([^"]+\.jpg)",?$/gm)).map((match) => match[1]);
  assert.deepEqual(
    listed,
    DynaWall.BUNDLED_PHOTOS.map((photo) => photo.split('/').pop()),
    'build-macos.sh must copy exactly GOLDEN_GATE_PHOTOS + ABSTRACT_PHOTOS'
  );
  assert.ok(!/cp -R "\$ROOT\/images"/.test(build), 'the whole images/ folder must not be copied');
  assert.match(build, /-whole-module-optimization/);
  assert.match(build, /-Xlinker -dead_strip/);
});

/* -------------------------------------------------------------------------- *
 * Distribution packaging
 * -------------------------------------------------------------------------- */

group('Distribution packaging');

test('the macOS disk image stages a drag-and-drop Applications shortcut', () => {
  const script = fs.readFileSync(path.join(ROOT, 'build-dmg.sh'), 'utf8');
  assert.match(script, /"\$ROOT\/build-macos\.sh"/, 'the DMG must start from a fresh app bundle');
  assert.match(script, /hdiutil create/);
  assert.match(script, /-volname "\$VOLUME_NAME"/);
  assert.match(script, /-format UDZO/, 'the image must be compressed and read-only');
  assert.match(script, /ln -s \/Applications "\$STAGE\/Applications"/);
  assert.match(script, /codesign --force --sign - --timestamp=none "\$DMG"/);
  assert.ok(!/-format UDRW/.test(script), 'a writable image is not a distributable');
});

test('the Windows host is a self-contained WebView2 app', () => {
  const project = fs.readFileSync(path.join(ROOT, 'windows/DynaWall.csproj'), 'utf8');
  assert.match(project, /<TargetFramework>net8\.0-windows<\/TargetFramework>/);
  assert.match(project, /<UseWindowsForms>true<\/UseWindowsForms>/);
  assert.match(project, /<PublishSingleFile>true<\/PublishSingleFile>/);
  assert.match(project, /<SelfContained>true<\/SelfContained>/);
  assert.match(project, /<RuntimeIdentifier>win-x64<\/RuntimeIdentifier>/);
  assert.match(project, /<ApplicationIcon>app\.ico<\/ApplicationIcon>/);
  assert.match(
    project,
    /PackageReference Include="Microsoft\.Web\.WebView2" Version="1\.0\.2903\.40"/
  );
  assert.ok(fs.existsSync(path.join(ROOT, 'windows/app.ico')), 'the tray and installer icon must ship');
});

test('the Windows host parents its WebView2 behind the desktop icons', () => {
  const host = fs.readFileSync(path.join(ROOT, 'windows/DesktopHost.cs'), 'utf8');
  assert.match(host, /0x052C/, 'Progman must be asked to spawn the WorkerW layer');
  assert.match(host, /FindWindow\("Progman"/);
  assert.match(host, /FindWindowEx\([^)]*"WorkerW"/);
  assert.match(host, /"SHELLDLL_DefView"/);
  assert.match(host, /SetParent\(window, host\)/);
});

test('the Windows host speaks the same bridge as every other host', () => {
  const source = ['Preferences.cs', 'WallpaperWindow.cs']
    .map((file) => fs.readFileSync(path.join(ROOT, 'windows', file), 'utf8'))
    .join('\n');

  assert.match(source, /window\.__dynawallSeed/, 'first paint has to be the user wallpaper');
  assert.match(source, /window\.livelyPropertyListener\(/);
  assert.match(source, /\("firstName", FirstName\)/);
  assert.match(source, /livelyPropertyListener\(\\"nextPhoto\\"/);
  assert.match(source, /livelyPropertyListener\(\\"suspend\\"/);
  assert.match(source, /livelyPropertyListener\(\\"photos\\"/);
  assert.match(
    source,
    /if \(Theme == "custom"\) values\.Add\(\("bgColor", BgColor\)\)/,
    'a colour must only travel beside the custom palette'
  );
  assert.match(source, /if \(Theme == "custom"\) seed\["bgColor"\] = BgColor/);
});

test('the Windows host survives Explorer restarts and background callbacks', () => {
  const controller = fs.readFileSync(path.join(ROOT, 'windows/WallpaperController.cs'), 'utf8');
  assert.match(
    controller,
    /FindWallpaperHost\(spawn: windows\.Count == 0\)/,
    'the watchdog must not send a blocking Progman message while windows exist'
  );
  assert.match(controller, /windows\.Count == 0 \|\|/, 'a failed first build must be retried');
  assert.match(controller, /IsHandleCreated/, 'a destroyed window must be rebuilt, not recreated in place');

  const window = fs.readFileSync(path.join(ROOT, 'windows/WallpaperWindow.cs'), 'utf8');
  assert.match(window, /Show\(\);/, 'WebView2 only renders inside a shown, visible window');

  const program = fs.readFileSync(path.join(ROOT, 'windows/Program.cs'), 'utf8');
  assert.match(
    program,
    /SetSynchronizationContext\(new WindowsFormsSynchronizationContext\(\)\)/,
    'tray and SystemEvents callbacks must marshal onto the UI thread'
  );
  assert.match(program, /Local\\DynaWall\.SingleInstance/);
  assert.match(program, /Local\\DynaWall\.ShowSettings/, 'a second launch opens Settings');
});

test('the Windows installer is per-user and ships the curated wallpapers', () => {
  const iss = fs.readFileSync(path.join(ROOT, 'windows/installer.iss'), 'utf8');
  assert.match(iss, /PrivilegesRequired=lowest/, 'the installer must not ask for UAC');
  assert.match(iss, /DefaultDirName=\{localappdata\}\\Programs\\DynaWall/);
  assert.match(iss, /OutputBaseFilename=DynaWall-Setup/);
  assert.match(iss, /Source: "publish\\\*"/);
  assert.match(iss, /Tasks: startup/);
  assert.match(iss, /WebView2Installed/);

  const project = fs.readFileSync(path.join(ROOT, 'windows/DynaWall.csproj'), 'utf8');
  const listed = Array.from(project.matchAll(/Include="\.\.\\images\\([^"]+\.jpg)"/g)).map(
    (match) => match[1]
  );
  assert.deepEqual(
    listed.sort(),
    DynaWall.BUNDLED_PHOTOS.map((photo) => photo.split('/').pop()).sort(),
    'DynaWall.csproj must copy exactly GOLDEN_GATE_PHOTOS + ABSTRACT_PHOTOS'
  );
  assert.ok(
    !/Include="\.\.\\images\\\*/.test(project),
    'the whole images/ folder must not be copied'
  );
});

test('the release workflow keeps installers downloadable', () => {
  const workflow = readText('.github/workflows/release.yml');
  assert.ok(
    workflow.includes('    branches:\n      - main'),
    'main must refresh the nightly build'
  );
  assert.ok(
    workflow.includes("    tags:\n      - 'v*'"),
    'a tag must publish a stable release'
  );
  assert.match(workflow, /runs-on: macos-latest/);
  assert.match(workflow, /runs-on: windows-latest/);
  assert.match(workflow, /\.\/build-dmg\.sh/);
  assert.match(workflow, /build-release\.ps1/);
  assert.match(workflow, /DynaWall-Setup\.exe/);
  assert.match(workflow, /DynaWall-Windows-Portable\.zip/);
  assert.match(workflow, /TAG=nightly/, 'the rolling pre-release needs a fixed tag');
  assert.match(workflow, /gh release create "\$TAG" dist\/\* --target "\$SHA" --prerelease/);
  assert.match(workflow, /gh release edit "\$TAG" --title "Latest build"/);
  assert.match(workflow, /gh release upload "\$TAG" dist\/\* --clobber/);

  // The README points at those releases, so GitHub is the download page.
  const readme = readText('README.md');
  [
    '../../releases/latest/download/DynaWall.dmg',
    '../../releases/latest/download/DynaWall-Setup.exe',
    '../../releases/latest/download/DynaWall-Windows-Portable.zip',
    '../../releases/download/nightly/DynaWall.dmg',
    '../../releases/download/nightly/DynaWall-Setup.exe',
    '../../releases/download/nightly/DynaWall-Windows-Portable.zip'
  ].forEach((link) => {
    assert.ok(readme.includes(link), `README must link ${link}`);
  });
});

/* -------------------------------------------------------------------------- *
 * Production hardening
 * -------------------------------------------------------------------------- */

group('Production hardening');

test('index.html ships a strict Content Security Policy', () => {
  const policy = contentSecurityPolicy();

  // Nothing may load unless a directive below allows it: no remote code, no frames,
  // no plugins, no workers, no media.
  assert.deepEqual(cspSources(policy, 'default-src'), ["'none'"], 'default-src must be none');
  assert.deepEqual(cspSources(policy, 'object-src'), ["'none'"], 'plugins must never load');
  assert.deepEqual(cspSources(policy, 'base-uri'), ["'none'"], 'injected markup cannot retarget relative URLs');
  assert.deepEqual(cspSources(policy, 'form-action'), ["'none'"], 'the wallpaper cannot submit anything');

  // The only script is the bundled one. `file:` is what makes the macOS host work:
  // its WKWebView loads the page over file://, where `'self'` can resolve to an
  // opaque origin and match nothing.
  assert.deepEqual(
    cspSources(policy, 'script-src'),
    ["'self'", 'file:'].sort(),
    'script-src must stay at the bundled script'
  );
  ['style-src', 'font-src'].forEach((directive) => {
    const sources = cspSources(policy, directive);
    assert.ok(sources.includes("'self'"), `${directive} must allow the bundled files`);
    assert.ok(sources.includes('file:'), `${directive} must allow the file:// bundle`);
  });
  assert.ok(
    cspSources(policy, 'style-src').includes("'unsafe-inline'"),
    'the hosts inject a style element while live-editing settings'
  );
  assert.ok(
    cspSources(policy, 'font-src').includes('data:'),
    'an imported font arrives as a data: URL'
  );

  // No escape hatches anywhere in the policy.
  const everySource = [...policy.keys(), ...[...policy.values()].flat()].join(' ');
  assert.ok(!/'unsafe-eval'|wasm-unsafe-eval/.test(everySource), 'no eval');
  assert.ok(!/\*/.test(everySource), 'no wildcard sources');
  assert.ok(!/http:/.test(everySource), 'no plaintext http anywhere');
});

test('the policy names exactly the hosts the page and the native hosts use', () => {
  const policy = contentSecurityPolicy();

  // The weather card is the only thing that fetches, and it is keyless Open-Meteo.
  assert.deepEqual(
    cspSources(policy, 'connect-src'),
    ["'self'"]
      .concat(Array.from(DynaWall.WIDGET_FETCH_HOSTS, (host) => `https://${host}`))
      .sort(),
    'connect-src must be the declared fetch hosts and nothing else'
  );

  // YouTube and Google News are handed to the OS browser; nothing in the page may
  // ever reach them, so they cannot appear as a CSP source.
  const everySource = [...policy.keys(), ...[...policy.values()].flat()].join(' ');
  DynaWall.WIDGET_LINK_HOSTS.forEach((host) => {
    assert.ok(!everySource.includes(host), `${host} is browser-only and must not be a CSP source`);
  });

  // Images: the bundled pictures ('self'), the macOS scheme handler, the user's
  // folder behind the WebView2 virtual host, and data:/blob: for host payloads. The
  // scheme and the host names are read from the hosts, so they cannot drift.
  const imgSrc = cspSources(policy, 'img-src');
  const macScheme = /static let scheme = "([^"]+)"/.exec(readText('macos/DynaWallApp.swift'))[1];
  const bundledHost = /BundledHost = "([^"]+)"/.exec(readText('windows/PhotoLibrary.cs'))[1];
  const folderHost = /FolderHost = "([^"]+)"/.exec(readText('windows/PhotoLibrary.cs'))[1];
  ["'self'", 'file:', 'data:', 'blob:', `${macScheme}:`, `https://${bundledHost}`, `https://${folderHost}`].forEach(
    (source) => {
      assert.ok(imgSrc.includes(source), `img-src must allow ${source}`);
    }
  );

  // A remote image is never a wallpaper source (script.js ships relative `images/…`
  // paths and host URLs only), so https: is not opened up wholesale.
  assert.ok(!imgSrc.includes('https:'), 'img-src must list hosts, not the whole https: scheme');

  const markup = readText('index.html');
  assert.match(markup, /<meta name="referrer" content="no-referrer"/, 'no referrer leaks to Open-Meteo');
});

test('a Windows desktop click converts screen pixels into CSS pixels', () => {
  // Screen coordinates are physical (PerMonitorV2); the page reports CSS pixels.
  const project = readText('windows/DynaWall.csproj');
  assert.match(
    project,
    /<ApplicationHighDpiMode>PerMonitorV2<\/ApplicationHighDpiMode>/,
    'the host must know the real display scale'
  );

  const window = readText('windows/WallpaperWindow.cs');
  assert.match(
    window,
    /internal float DeviceScale => DeviceDpi > 0 \? DeviceDpi \/ 96f : 1f;/,
    'the display scale is DeviceDpi / 96, with a safe fallback'
  );

  const controller = readText('windows/WallpaperController.cs');
  assert.match(controller, /var scale = window\.DeviceScale;/, 'the click path must read the scale');
  assert.match(controller, /\(point\.X - window\.ScreenBounds\.X\) \/ scale/);
  assert.match(controller, /\(point\.Y - window\.ScreenBounds\.Y\) \/ scale/);
  assert.doesNotMatch(
    controller,
    /new PointF\(point\.X - window\.ScreenBounds\.X, point\.Y - window\.ScreenBounds\.Y\)/,
    'raw screen pixels are the 125–200% DPI defect: the hit area is in CSS pixels'
  );
});

test('build-macos.sh merges an arm64 and an x86_64 slice into a Universal 2 binary', () => {
  const build = readText('build-macos.sh');

  assert.match(build, /ARCHS="\$\{DYNAWALL_ARCHS:-arm64 x86_64\}"/, 'both slices are the default');
  assert.match(build, /-target "\$arch-apple-macos\$MIN_MACOS"/, 'each slice is compiled for macOS 12+');
  assert.match(build, /lipo -create "\$\{SLICES\[@\]\}" -output "\$MACOS_BIN\/\$APP_NAME"/);
  assert.match(build, /lipo -archs "\$MACOS_BIN\/\$APP_NAME"/, 'the merged binary is inspected');
  assert.match(build, /slice is missing/, 'a half-built universal binary must fail the build');
  assert.ok(
    !/-target "\$\(uname -m\)/.test(build),
    'the build must not fall back to the runner architecture'
  );
  assert.ok(
    !/echo "==> Compiling for \$\(uname -m\)"/.test(build),
    'the log must report the target architectures, not the runner'
  );
});

test('the release publishes SHA-256 checksums and refuses a single-architecture DMG', () => {
  const workflow = readText('.github/workflows/release.yml');

  // The macOS job gates on both slices, not on whatever the runner happened to build.
  assert.match(workflow, /for arch in arm64 x86_64; do/);
  assert.match(workflow, /the \$arch slice is missing from the app bundle/);

  // Checksums are written before the upload, so the file rides along with the rest.
  const checksumStep = workflow.indexOf('Write SHA-256 checksums');
  const publishStep = workflow.indexOf('Attach the installers to a release');
  assert.ok(checksumStep > 0, 'the publish job must write SHA256SUMS.txt');
  assert.ok(checksumStep < publishStep, 'the checksums must exist before the upload');
  assert.match(workflow, /sha256sum "\$asset" >> SHA256SUMS\.txt/);
  assert.match(workflow, /gh release upload "\$TAG" dist\/\* --clobber/, 'the checksum file is uploaded too');

  // The Windows job verifies what it built: the setup exists, and the portable zip is
  // actually runnable on its own (exe + web wallpaper + a bundled font).
  assert.match(workflow, /Verify the Windows builds/);
  assert.match(workflow, /the portable zip is missing \$entry/);
  assert.match(workflow, /'web\/index\.html'/);
});

test('the Windows host recovers from a missing WebView2 runtime', () => {
  const controller = readText('windows/WallpaperController.cs');
  assert.match(controller, /catch \(WebView2RuntimeNotFoundException\)/);
  assert.match(controller, /MessageBoxButtons\.YesNo/, 'the user must be offered the runtime download');
  assert.match(controller, /private static void OpenWebView2DownloadPage\(\)/);
  assert.match(controller, /https:\/\/go\.microsoft\.com\/fwlink\/p\/\?LinkId=2124703/);
  assert.match(controller, /UseShellExecute = true/, 'the download page opens in the default browser');

  // The installer warns about the same runtime and names the same address, so both
  // entry points tell the user the same story.
  const iss = readText('windows/installer.iss');
  assert.match(iss, /function WebView2Installed: Boolean/);
  assert.match(iss, /LinkId=2124703/);
});

test('the checked-in app bundle ships the same wallpaper the sources build', () => {
  // dist/DynaWall.app is committed, so it can go stale: a bundle built before the CSP
  // landed would still show the old page. One build keeps them in step.
  const bundled = path.join(ROOT, 'dist/DynaWall.app/Contents/Resources/index.html');
  assert.ok(fs.existsSync(bundled), 'dist/DynaWall.app must ship index.html');
  const shipped = fs.readFileSync(bundled, 'utf8').replace(/\r\n/g, '\n');
  assert.equal(shipped, readText('index.html'), 're-run ./build-macos.sh: the bundle is stale');
  assert.match(shipped, /http-equiv="Content-Security-Policy"/, 'the app bundle must enforce the policy');
});

test('the docs describe the universal build, the DPI fix and the checksums', () => {
  const readme = readText('README.md');
  assert.match(readme, /macOS 12\+ \(Universal 2/, 'the download table must say Universal 2');
  assert.match(readme, /SHA256SUMS\.txt/, 'verifying a download must be documented');
  assert.match(readme, /DeviceDpi \/ 96/, 'the Windows DPI mapping must be documented');
  assert.ok(
    !/Apple silicon\)/.test(readme),
    'the README must not advertise an Apple-silicon-only DMG any more'
  );
});

/* -------------------------------------------------------------------------- *
 * Navigation guards
 * -------------------------------------------------------------------------- */

group('Navigation guards');

test('the macOS web view only ever loads the bundled wallpaper page', () => {
  const swift = hostSwift();

  // `didFinish` runs after the navigation happened; the policy decision is the guard.
  assert.match(
    swift,
    /func webView\(\s*_ webView: WKWebView,\s*decidePolicyFor navigationAction: WKNavigationAction,\s*decisionHandler: @escaping \(WKNavigationActionPolicy\) -> Void\s*\) \{/,
    'the navigation delegate must decide every navigation before it happens'
  );

  const decision = memberBody(swift, 'decidePolicyFor navigationAction: WKNavigationAction');
  assert.match(decision, /if isBundledPage\(target\) \{/, 'the bundled page is the one load allowed');
  assert.match(decision, /decisionHandler\(\.allow\)/);
  assert.match(decision, /decisionHandler\(\.cancel\)/, 'every other navigation is cancelled');
  assert.match(decision, /navigationType == \.linkActivated/, 'a clicked link is not a wallpaper');
  assert.match(
    decision,
    /WidgetMessageHandler\.isBrowserURL\(target\.absoluteString\)/,
    'only https may leave the app'
  );
  assert.match(decision, /NSWorkspace\.shared\.open\(target\)/, 'a clicked link opens in the browser');

  // "The bundled page" is a path, not a string prefix: the request URL and `indexURL`
  // are built by different code paths (percent-encoding, symlinks).
  const guard = memberBody(swift, 'private func isBundledPage(_ url: URL?) -> Bool');
  assert.match(guard, /url\.isFileURL/, 'a file URL is the only kind this host loads');
  assert.match(guard, /url\.standardizedFileURL\.path == indexURL\.standardizedFileURL\.path/);

  // WebKit reports a cancelled policy decision as a load failure; it is the guard at work.
  const provisional = memberBody(swift, 'didFailProvisionalNavigation navigation: WKNavigation!');
  assert.match(provisional, /NSURLErrorCancelled/, 'a refused navigation is not a broken wallpaper');
});

test('LaunchAtLogin escapes the bundle path before it becomes AppleScript', () => {
  const swift = hostSwift();

  const escape = memberBody(swift, 'private static func appleScriptString(_ value: String) -> String');
  // Backslashes first: escaping a quote first would then escape the escaping backslash.
  assert.ok(
    escape.includes('.replacingOccurrences(of: "\\\\", with: "\\\\\\\\")'),
    'backslashes must be doubled'
  );
  assert.ok(
    escape.includes('.replacingOccurrences(of: "\\"", with: "\\\\\\"")'),
    'a quote must not be able to close the AppleScript literal'
  );
  assert.ok(escape.includes('.replacingOccurrences(of: "\\n", with: "\\\\n")'), 'no raw line break');

  ['private static func legacyIsEnabled() -> Bool', 'private static func legacySet(enabled: Bool)'].forEach(
    (signature) => {
      const body = memberBody(swift, signature);
      assert.match(body, /let path = appleScriptString\(Bundle\.main\.bundlePath\)/);
      assert.ok(
        !/let path = Bundle\.main\.bundlePath/.test(body),
        `${signature} must never interpolate the raw path`
      );
    }
  );
});

test('the macOS build signs the bundle with the hardened runtime', () => {
  const build = readText('build-macos.sh');
  assert.match(build, /codesign --force --sign - --options runtime/, 'the hardened runtime must be on');
  assert.match(
    build,
    /--entitlements "\$ROOT\/macos\/DynaWall\.entitlements"/,
    'the runtime has to keep the Apple-events capability the login item needs'
  );
  assert.match(build, /codesign --verify --verbose=2 "\$APP_BUNDLE"/, 'the signature is verified');
  assert.match(build, /macos\/DynaWall\.entitlements/, 'a missing entitlements file fails the build');

  const entitlements = fs.readFileSync(path.join(ROOT, 'macos/DynaWall.entitlements'), 'utf8');
  assert.match(
    entitlements,
    /<key>com\.apple\.security\.automation\.apple-events<\/key>\s*<true\/>/,
    'the macOS 12 login-item fallback sends Apple events to System Events'
  );
  assert.match(
    fs.readFileSync(path.join(ROOT, 'macos/Info.plist'), 'utf8'),
    /<key>NSAppleEventsUsageDescription<\/key>/,
    'TCC asks the user for automation with this string'
  );
});

test('the Windows web view is held on the bundled wallpaper page', () => {
  const window = readText('windows/WallpaperWindow.cs');

  assert.match(
    window,
    /private static readonly string BundledPageUri = \$"https:\/\/\{PhotoLibrary\.BundledHost\}\/index\.html";/,
    'the one page this host loads has to be named once'
  );
  assert.match(window, /core\.NavigationStarting \+= OnNavigationStarting/);
  assert.match(window, /core\.NewWindowRequested \+= OnNewWindowRequested/);
  assert.match(window, /core\.Navigate\(BundledPageUri\)/);

  const starting = memberBody(window, 'private void OnNavigationStarting(');
  assert.match(starting, /if \(IsBundledPage\(e\.Uri\)\) return;/);
  assert.match(starting, /e\.Cancel = true/, 'a navigation away from the bundle is refused');

  const popup = memberBody(window, 'private void OnNewWindowRequested(');
  assert.match(popup, /e\.Handled = true/, 'no untracked popup over the desktop');
  assert.match(popup, /OpenInBrowser\(e\.Uri\)/, 'a link still reaches the browser');

  // The bridge answers one origin: the wallpaper page.
  const message = memberBody(window, 'private void OnWebMessage(');
  assert.match(message, /if \(!IsBundledPage\(e\.Source\)\)/, 'a foreign document cannot drive the host');
});

test('the Windows bridge hands the shell a canonical URL, not the page string', () => {
  const bridge = readText('windows/WidgetBridge.cs');
  const normalize = memberBody(bridge, 'internal static bool TryNormalizeBrowserUrl(');
  assert.match(normalize, /Uri\.TryCreate\(target, UriKind\.Absolute, out var uri\)/);
  assert.match(normalize, /uri\.Scheme != Uri\.UriSchemeHttps/, 'only https reaches the browser');
  assert.match(normalize, /string\.IsNullOrEmpty\(uri\.Host\)/, 'an https: without a host is not a link');
  assert.match(normalize, /canonical = uri\.AbsoluteUri;/, 'the shell gets RFC 3986, not the raw string');
  assert.match(bridge, /url = canonical;/, 'the parsed message carries the canonical URL');

  // Every route to Process.Start goes through that one gate.
  const window = readText('windows/WallpaperWindow.cs');
  const open = memberBody(window, 'private static void OpenInBrowser(string url)');
  assert.match(open, /WidgetBridge\.TryNormalizeBrowserUrl\(url, out var canonical\)/);
  assert.match(open, /ProcessStartInfo\(canonical\)/);
});

test('the Windows settings window reveals a folder without a command line', () => {
  const form = readText('windows/SettingsForm.cs');
  const reveal = memberBody(form, 'private void RevealPhotoFolder()');

  assert.ok(!/explorer\.exe/.test(reveal), 'no shell process with a hand-quoted argument list');
  assert.ok(!/Arguments\s*=/.test(reveal), 'a folder is the file name, never an argument');
  assert.match(reveal, /Directory\.Exists\(target\)/, 'a folder that went away is not launched');
  assert.match(reveal, /FileName = target/);
  assert.match(reveal, /UseShellExecute = true/);
});

/* -------------------------------------------------------------------------- *
 * Font selection
 * -------------------------------------------------------------------------- */

group('Font selection');

test('the font stack always ends on the vendored Outfit face', () => {
  const declared = readText('style.css').match(/--font-sans:\s*([^;]+);/)[1].replace(/\s+/g, ' ');
  // Outfit and an unset family are the same stack: the stylesheet's own value, so
  // the shipped look never depends on script.js having run.
  assert.equal(DynaWall.fontStack(''), declared, 'the script must reproduce --font-sans exactly');


  assert.equal(DynaWall.fontStack('Outfit'), declared);
  assert.ok(declared.startsWith('"Outfit"'), 'Outfit leads the fallback tail');
  assert.ok(declared.endsWith('sans-serif'), 'a missing font still lands on a sans face');
});

test('a chosen family is prepended to that same tail', () => {
  const tail = DynaWall.fontStack('');
  assert.equal(DynaWall.fontStack('Charter'), `"Charter", ${tail}`);
  assert.equal(DynaWall.fontStack('  New   York  '), `"New York", ${tail}`, 'whitespace is collapsed');
  // A family the tail already lists still leads it: the runtime choice wins over
  // the shipped fallback order, or picking Avenir Next would keep Outfit on screen.
  assert.equal(DynaWall.fontStack('Avenir Next'), `"Avenir Next", ${tail}`);
  // "SF Pro" is the platform UI face rather than an installed family.
  assert.equal(DynaWall.fontStack('SF Pro'), DynaWall.fontStack('sf pro'));
  assert.match(DynaWall.fontStack('sf pro'), /^-apple-system/);
});

test('normalizeFontFamily drops what could break out of a CSS family name', () => {
  assert.equal(DynaWall.normalizeFontFamily('  Inter   Display '), 'Inter Display');
  const hostile = DynaWall.normalizeFontFamily('Inter"; } body { x:"');
  assert.equal(hostile, 'Inter body x:');
  assert.ok(!/["'\\;{}<>]/.test(hostile), 'no quote, brace or semicolon survives');
  assert.equal(DynaWall.normalizeFontFamily('Noto\tSans\u0000JP'), 'Noto Sans JP');
});

test('an empty or absurd family means "use Outfit"', () => {
  assert.equal(DynaWall.normalizeFontFamily(''), undefined);
  assert.equal(DynaWall.normalizeFontFamily('   '), undefined);
  assert.equal(DynaWall.normalizeFontFamily('""'), undefined);
  assert.equal(DynaWall.normalizeFontFamily('x'.repeat(80)), 'x'.repeat(80));
  assert.equal(DynaWall.normalizeFontFamily('x'.repeat(81)), undefined);
  assert.equal(DynaWall.normalizeFontFamily(42), undefined);
  assert.equal(DynaWall.normalizeFontFamily(null), undefined);
});

test('an imported font file is accepted, a network fetch never is', () => {
  const face = 'data:font/woff2;base64,d09GMgABAAAA';
  assert.equal(DynaWall.normalizeCustomFont(face), face);
  assert.equal(DynaWall.normalizeCustomFont(`  ${face}  `), face, 'outer whitespace is trimmed');
  assert.equal(
    DynaWall.normalizeCustomFont('data:application/octet-stream;base64,AAAA'),
    'data:application/octet-stream;base64,AAAA'
  );
  // A face the host copied next to the page may be addressed relatively.
  assert.equal(DynaWall.normalizeCustomFont('assets/fonts/inter.woff2'), 'assets/fonts/inter.woff2');
  [
    'https://fonts.example/inter.woff2',
    'file:///Users/me/Inter.ttf',
    'javascript:alert(1)',
    '//fonts.example/inter.woff2',
    'data:text/html;base64,PHNjcmlwdD4='
  ].forEach((value) => {
    assert.equal(DynaWall.normalizeCustomFont(value), undefined, `${value} must be rejected`);
  });
  // An empty string is a real value: it removes the face that was loaded before.
  assert.equal(DynaWall.normalizeCustomFont(''), '');
});

test('the hosts and the URL accept a font family', () => {
  assert.deepEqual(DynaWall.mapLivelyProperty('fontFamily', ' Inter  Display '), {
    field: 'fontFamily',
    value: 'Inter Display'
  });
  assert.deepEqual(DynaWall.mapLivelyProperty('customFont', 'data:font/ttf;base64,AA'), {
    field: 'customFont',
    value: 'data:font/ttf;base64,AA'
  });
  assert.deepEqual(
    DynaWall.mapWallpaperEngineProperties({
      fontfamily: { value: 'Charter' },
      customfont: { value: 'data:font/otf;base64,AA' }
    }),
    [
      { field: 'fontFamily', value: 'Charter' },
      { field: 'customFont', value: 'data:font/otf;base64,AA' }
    ]
  );
  // Clearing the host's control is a reset, not a dropped event.
  assert.deepEqual(DynaWall.mapLivelyProperty('fontFamily', ''), {
    field: 'fontFamily',
    value: DynaWall.DEFAULT_CONFIG.fontFamily
  });
  assert.deepEqual(DynaWall.parseQueryParams('?font=Inter&fonturl=assets/fonts/inter.woff2'), {
    fontFamily: 'Inter',
    customFont: 'assets/fonts/inter.woff2'
  });
  assert.equal(DynaWall.DEFAULT_CONFIG.fontFamily, 'Outfit');
  assert.equal(DynaWall.DEFAULT_CONFIG.customFont, '');
});

test('only the family is cached, never the font bytes', () => {
  const storage = fakeStorage();
  DynaWall.persistConfig({ fontFamily: 'Charter', customFont: 'data:font/ttf;base64,AA' }, storage);
  assert.equal(storage.data.get('dynawall.fontFamily'), 'Charter');
  assert.equal(storage.data.size, 1, 'customFont must not be written to localStorage');
  assert.deepEqual(DynaWall.readStoredConfig(fakeStorage({ 'dynawall.fontFamily': 'Charter' })), {
    fontFamily: 'Charter'
  });
  // A poisoned cache entry is dropped rather than injected.
  assert.deepEqual(DynaWall.readStoredConfig(fakeStorage({ 'dynawall.fontFamily': '   ' })), {});
});

test('the host seed carries the family and the bytes, live IPC still wins', () => {
  assert.deepEqual(
    DynaWall.readSeed({
      __dynawallSeed: { fontFamily: ' Charter ', customFont: 'data:font/ttf;base64,AA' }
    }),
    { fontFamily: 'Charter', customFont: 'data:font/ttf;base64,AA' }
  );

  const seeded = DynaWall.resolveConfig({
    ipc: {},
    seed: { fontFamily: 'Charter' },
    url: { fontFamily: 'Georgia' },
    storage: {},
    defaults: DynaWall.DEFAULT_CONFIG
  });
  assert.equal(seeded.fontFamily, 'Charter', 'the seed is the host, so it beats the URL');
  assert.equal(seeded.customFont, '', 'no imported face unless the host sends one');
});

test('the render pass rewrites --font-sans from the chosen family', () => {
  const source = readText('script.js');
  assert.match(source, /function applyTypography\(\)/);
  assert.match(source, /root\.style\.setProperty\('--font-sans', fontStack\(family\)\)/);
  assert.match(source, /root\.style\.removeProperty\('--font-sans'\)/);
  assert.match(source, /registerCustomFont\(family, source\)/);
  assert.match(source, /new FontFaceCtor\(family, 'url\("' \+ source \+ '"\)'/);
  const calls = source.match(/^\s*applyTypography\(\);/gm) || [];
  assert.equal(calls.length, 1, 'render() is the only caller');
});

test('both host manifests expose the family with the Outfit default', () => {
  assert.equal(livelyProperties.fontFamily.type, 'textbox');
  assert.equal(livelyProperties.fontFamily.value, DynaWall.DEFAULT_FONT_FAMILY);
  assert.equal(wallpaperProject.general.properties.fontfamily.type, 'textinput');
  assert.equal(wallpaperProject.general.properties.fontfamily.value, DynaWall.DEFAULT_FONT_FAMILY);
  assert.deepEqual(DynaWall.mapLivelyProperty('fontFamily', livelyProperties.fontFamily.value), {
    field: 'fontFamily',
    value: 'Outfit'
  });
  assert.deepEqual(
    DynaWall.mapWallpaperEngineProperties({ fontfamily: wallpaperProject.general.properties.fontfamily }),
    [{ field: 'fontFamily', value: 'Outfit' }]
  );
});

test('both native hosts ship the same font pipeline', () => {
  const swift = hostSwift();
  assert.match(swift, /static let defaultFamily = "Outfit"/);
  assert.match(swift, /static func normalizedFamily\(_ raw: String\) -> String/);
  assert.match(swift, /static func installedFamilies\(\) -> \[String\]/);
  assert.match(swift, /static let maxImportedBytes = 4 \* 1024 \* 1024/);
  assert.match(swift, /static func dataURL\(atPath path: String\) -> String\?/);
  // The multi-megabyte payload rides its own push, and only when it changed.
  assert.match(swift, /static func javaScriptFontUpdate\(_ source: String\) -> String/);
  assert.match(swift, /entry\.pushedFont != fontSource/);
  // The popover offers one dropdown of installed families; the Add Font picker and
  // its import notice are gone, while previously imported bytes still ride their own
  // push (so an upgraded Mac does not lose the face it already chose).
  assert.match(swift, /private var typographyCard: some View/);
  assert.match(swift, /WallpaperFont\.installedFamilies\(\)/);
  assert.ok(!swift.includes('panel.allowedContentTypes'), 'the Add Font picker is gone');
  assert.ok(!swift.includes('FontImportNotice'), 'the import notice is gone');
  assert.ok(!swift.includes('addFontButton'), 'the Add Font button is gone');

  const preferences = readText('windows/Preferences.cs');
  assert.match(preferences, /internal const string DefaultFontFamily = "Outfit"/);
  assert.match(preferences, /public string FontFamily \{ get; set; \} = DefaultFontFamily/);
  assert.match(preferences, /internal static string BuildFontScript\(string source\)/);
  assert.match(
    preferences,
    /\[JsonIgnore\]\s*internal string CustomFontSource => FontLibrary\.DataUrl\(CustomFontPath\)/,
    'the font bytes must never be persisted'
  );

  const library = readText('windows/FontLibrary.cs');
  assert.match(library, /internal const int MaxImportedBytes = 4 \* 1024 \* 1024/);
  assert.match(library, /"\.ttf", "\.otf", "\.ttc", "\.woff", "\.woff2"/);
  assert.match(library, /internal static string\? Import\(string\? sourcePath\)/);

  const window = readText('windows/WallpaperWindow.cs');
  assert.match(window, /internal async Task PushFontAsync\(\)/);
  assert.match(window, /string\.Equals\(source, pushedFontSource, StringComparison\.Ordinal\)/);

  const form = readText('windows/SettingsForm.cs');
  assert.match(form, /AddCard\(root, "Typography"/);
  assert.match(form, /FontLibrary\.InstalledFamilies\(\)/);
});

/* -------------------------------------------------------------------------- *
 * Typography
 * -------------------------------------------------------------------------- */

group('Typography');

test('the only webfonts are the four bundled faces', () => {
  const css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
  const faces = css.match(/@font-face/g) || [];
  assert.equal(faces.length, BUNDLED_FONTS.length, 'one @font-face rule per bundled family');
  assert.match(css, /--font-sans:\s*"Outfit"/, 'Outfit leads the font stack');

  BUNDLED_FONTS.forEach(({ family, woff2, regular, semibold, license }) => {
    assert.ok(
      css.includes(`font-family: "${family}"`),
      `style.css must declare ${family}`
    );
    assert.ok(
      css.includes(`url("${woff2}") format("woff2")`),
      `${family} must load ${woff2}`
    );
    [regular, semibold, license].forEach((file) => {
      assert.ok(fs.existsSync(path.join(ROOT, file)), `missing bundled font file ${file}`);
    });
  });

  // The variable axes: Outfit, Google Sans Flex and Geist run the full range, while
  // Space Grotesk stops at 700 — asking for more would synthesise a fake weight.
  assert.match(css, /font-weight:\s*100 900/);
  assert.match(css, /font-weight:\s*300 700/);
});

test('the typography card is the picker alone, with nothing under it', () => {
  const swift = hostSwift();
  const card = memberBody(swift, 'private var typographyCard: some View');

  // The card's only text is the family name in the picker label. It stays on one line
  // and trims in the middle: the popover is resized from the measured content height,
  // so a second line would grow the panel and move every card below it.
  assert.match(
    card,
    /Text\(fontPickerLabel\)\s*\n\s*\.font\(WallpaperFont\.regular\(size: 11, family: preferences\.fontFamily\)\)/
  );
  assert.match(card, /\.lineLimit\(1\)\s*\n\s*\.truncationMode\(\.middle\)/);
  assert.ok(!card.includes('fontFamilyHint'), 'the explainer line under the picker is gone');
  assert.ok(!swift.includes('var fontFamilyHint'), 'no hint strings are kept for a hint nobody sees');
  assert.ok(!swift.includes('importedFontName'), 'the hint was its only reader');

  // Windows matches: one dropdown with its Add font… button, nothing underneath.
  const form = readText('windows/SettingsForm.cs');
  assert.match(form, /AddCard\(root, "Typography"/);
  assert.ok(!form.includes('fontHint'), 'the label under the Windows font list is gone');
  assert.ok(!form.includes('UpdateFontHint'), 'and so is the code that wrote it');
});

test('the bundled four stay the shared default but are hidden from the macOS dropdown', () => {
  assert.deepEqual(
    [...DynaWall.BUNDLED_FONT_FAMILIES],
    ['Outfit', 'Google Sans Flex', 'Space Grotesk', 'Geist'],
    'Outfit stays first: it is the default every stack ends on'
  );

  const swift = hostSwift();
  assert.match(
    swift,
    /static let bundledFamilies = \["Outfit", "Google Sans Flex", "Space Grotesk", "Geist"\]/
  );
  // The single dropdown lists installed system families and filters the bundled
  // faces out, so Outfit is only offered once, as the labeled default entry.
  assert.match(swift, /bundledFace\(family\) == nil/);
  assert.ok(!swift.includes('private static let fontPresets'), 'the preset chips are gone');
  assert.match(swift, /static func isBundled\(_ family: String\) -> Bool/);

  const preferences = readText('windows/Preferences.cs');
  assert.match(
    preferences,
    /internal static readonly string\[\] BundledFontFamilies =\s*\{ "Outfit", "Google Sans Flex", "Space Grotesk", "Geist" \}/
  );
  assert.match(preferences, /internal static bool IsBundledFontFamily\(string\? family\)/);

  // The quick picks are the same four, not a hand-written list that can drift.
  const form = readText('windows/SettingsForm.cs');
  assert.match(form, /private static readonly string\[\] FontPresets = Preferences\.BundledFontFamilies/);

  // Both host manifests name them, for anyone editing the property by hand.
  const lively = readText('LivelyProperties.json');
  const project = readText('project.json');
  BUNDLED_FONTS.forEach(({ family }) => {
    assert.ok(lively.includes(family), `LivelyProperties.json must mention ${family}`);
    assert.ok(project.includes(family), `project.json must mention ${family}`);
  });
});

test('the wallpaper itself never reaches the network, and the widgets name only declared hosts', () => {
  // The chrome — markup, styles, fonts, photos — stays proof-positive offline. The
  // Content Security Policy is the one place index.html may name a remote host (it
  // has to: it is what forbids every other request), so it is removed before the scan
  // and then checked host by host in the production-hardening group below.
  ['style.css', 'index.html'].forEach((file) => {
    const source = fs
      .readFileSync(path.join(ROOT, file), 'utf8')
      .replace(CONTENT_SECURITY_POLICY, '');
    assert.ok(!/https?:\/\//.test(source), `${file} must not reference a remote URL`);
  });

  // Every address in script.js has to belong to the widget catalogue, and every host
  // the file names has to be declared: the declared list and the source can never
  // drift apart in either direction.
  const script = readText('script.js');
  const hosts = new Set();
  script.replace(/https?:\/\/([^/'"\s)]+)/g, (match, host) => {
    hosts.add(host);
    return match;
  });
  assert.deepEqual(
    Array.from(hosts).sort(),
    Array.from(DynaWall.WIDGET_REMOTE_HOSTS).sort(),
    'script.js must name exactly the declared widget hosts'
  );
  DynaWall.WIDGET_LINK_HOSTS.forEach((host) => {
    assert.ok(
      !DynaWall.WIDGET_FETCH_HOSTS.includes(host),
      `${host} cannot be both linked and fetched`
    );
  });

  // Only the keyless Open-Meteo calls are made by the page, and only from the
  // weather provider — never on load, never on a timer.
  const fetches = Array.from(script.matchAll(/fetchJson\(win, (build\w+)/g)).map(
    (match) => match[1]
  );
  assert.deepEqual(
    fetches.sort(),
    ['buildGeocodingUrl', 'buildWeatherForecastUrl'],
    'the forecast and its city search are the only calls the page makes'
  );

  // Nothing frames, prefetches or hot-links a remote surface.
  assert.ok(
    !/<iframe|new Image\(|<img[^>]+https?:|<script[^>]+src="https?:/.test(script),
    'no remote frames, images or scripts'
  );
  assert.ok(!/setInterval\(/.test(script), 'no polling: a card fetches when it is opened');
});

group('Widgets');

test('every satellite in index.html has a widget, and every widget a satellite', () => {
  const markup = readText('index.html');
  const declared = Array.from(markup.matchAll(/data-widget="([a-z]+)"/g)).map((match) => match[1]);
  assert.deepEqual(
    declared,
    DynaWall.WIDGETS.map((widget) => widget.id),
    'the markup and the catalogue must list the same widgets, in the same order'
  );
  DynaWall.WIDGETS.forEach((widget) => {
    assert.ok(
      markup.includes(`id="widget-btn-${widget.id}"`),
      `missing the satellite for ${widget.id}`
    );
    assert.ok(widget.title && widget.caption, `${widget.id} needs a card header`);
  });

  assert.match(markup, /role="dialog"/, 'the card is a dialog');
  assert.match(markup, /aria-modal="true"/);
  assert.match(markup, /id="widget-modal-close"/, 'a close button must exist');
  assert.match(markup, /aria-labelledby="widget-modal-title"/);
  assert.match(markup, /aria-controls="widget-modal"/);
});

test('the popup is inert until a satellite opens it', () => {
  const markup = readText('index.html');
  assert.match(markup, /id="widget-backdrop"[^>]*aria-hidden="true"/);
  assert.equal((markup.match(/aria-expanded="false"/g) || []).length, DynaWall.WIDGETS.length);

  const css = readText('style.css');
  assert.match(
    css,
    /\.widget-backdrop\s*\{[^}]*visibility:\s*hidden[^}]*pointer-events:\s*none/,
    'a closed card cannot be clicked or focused'
  );
  assert.match(
    css,
    /\.widget-backdrop\.is-open\s*\{[^}]*visibility:\s*visible[^}]*pointer-events:\s*auto/
  );
});

test('the satellites are bare white glyphs, not glass buttons', () => {
  const css = readText('style.css');
  assert.match(css, /--widget-ink:\s*#ffffff/, 'the glyphs are white, not band-tinted');
  assert.match(css, /\.widget-btn\s*\{[^}]*color:\s*var\(--widget-ink\)/);
  assert.match(css, /\.widget-btn\s*\{[^}]*pointer-events:\s*auto/);
  assert.match(css, /\.widget-orbit\s*\{[^}]*pointer-events:\s*none/, 'only the buttons are targets');

  // No chrome around the glyph: no disc, no plate, no ring, no frosted puck. Every rule
  // that styles a satellite is checked, not just the base one, so a hover or an open
  // card cannot quietly bring the circle back.
  Array.from(css.matchAll(/([^{}]+)\{([^{}]*)\}/g)).forEach(([, selector, body]) => {
    if (!/\.widget-btn\b/.test(selector)) return;
    // `background: none` is the reset that gets rid of the browser's button plate, so it
    // is the one background a satellite is allowed to name.
    const shape = body.replace(/background:\s*none\s*;/g, '');
    assert.ok(
      !/(border-radius|background|backdrop-filter|box-shadow)/.test(shape),
      `the satellite rule "${selector.trim()}" still draws a shape around the glyph`
    );
  });
  assert.match(css, /\.widget-icon\s*\{[^}]*width:\s*100%/, 'the glyph fills its button');
  assert.match(css, /\.widget-icon\s*\{[^}]*stroke:\s*currentColor/);
  assert.match(css, /--widget-size:\s*clamp\(2\.4rem/, 'the bare glyph has to be big enough to be one');

  // The glyphs lost their puck; the card keeps its glass.
  assert.match(css, /backdrop-filter:\s*blur\(var\(--glass-blur\)\)/, 'the card is frosted');
  assert.match(css, /\.widget-modal\s*\{[^}]*border-radius:\s*var\(--glass-radius\)/);
});
test('the satellites ring the greeting, scattered rather than evenly placed', () => {
  const viewport = {
    width: 1920,
    height: 1080,
    size: 44,
    count: 4,
    margin: 40,
    gap: 24,
    clearance: 48,
    reach: 128
  };
  const greeting = { x: 510, y: 470, width: 900, height: 96 };
  const subtitle = { x: 810, y: 600, width: 300, height: 28 };
  const options = Object.assign({ avoid: [greeting, subtitle], seed: 20260115 }, viewport);
  // The block they orbit is the text box; the ring is that box grown by the clearance,
  // then by the distance a satellite may travel outwards, and finally by the satellite
  // itself. Nothing may leave it: a satellite parked in an empty corner stops reading as
  // part of the composition.
  const block = { left: 510, top: 470, right: 1410, bottom: 628 };
  const centreX = (block.left + block.right) / 2;
  const centreY = (block.top + block.bottom) / 2;
  const grow = viewport.clearance + viewport.reach + viewport.size;
  const ring = {
    left: block.left - grow,
    top: block.top - grow,
    right: block.right + grow,
    bottom: block.bottom + grow
  };

  const points = DynaWall.scatterWidgets(options);
  assert.equal(points.length, DynaWall.WIDGETS.length, 'one satellite per widget');
  assert.deepEqual(DynaWall.scatterWidgets(options), points, 'the same seed deals the same hand');

  const quadrants = new Set();
  points.forEach((point) => {
    const at = `${Math.round(point.x)},${Math.round(point.y)}`;
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y), 'a real position');
    assert.ok(point.x >= viewport.margin && point.y >= viewport.margin, `inside the margins: ${at}`);
    assert.ok(
      point.x + viewport.size <= viewport.width - viewport.margin &&
        point.y + viewport.size <= viewport.height - viewport.margin,
      `inside the viewport: ${at}`
    );
    assert.ok(
      point.x >= ring.left &&
        point.y >= ring.top &&
        point.x + viewport.size <= ring.right &&
        point.y + viewport.size <= ring.bottom,
      `the satellite at ${at} has wandered out of the ring`
    );
    [greeting, subtitle].forEach((box) => {
      const clear =
        point.x >= box.x + box.width + viewport.clearance ||
        point.x + viewport.size <= box.x - viewport.clearance ||
        point.y >= box.y + box.height + viewport.clearance ||
        point.y + viewport.size <= box.y - viewport.clearance;
      assert.ok(clear, `the satellite at ${at} sits on the greeting`);
    });
    quadrants.add(
      `${point.x + viewport.size / 2 < centreX ? 'left' : 'right'}-${
        point.y + viewport.size / 2 < centreY ? 'top' : 'bottom'
      }`
    );
  });
  assert.ok(quadrants.size > 1, 'the satellites are not all on one side of the greeting');

  for (let first = 0; first < points.length; first += 1) {
    for (let second = first + 1; second < points.length; second += 1) {
      const apart =
        points[first].x + viewport.size + viewport.gap <= points[second].x ||
        points[second].x + viewport.size + viewport.gap <= points[first].x ||
        points[first].y + viewport.size + viewport.gap <= points[second].y ||
        points[second].y + viewport.size + viewport.gap <= points[first].y;
      assert.ok(apart, 'satellites keep their distance from each other');
    }
  }

  // Scattered, not "the corners with jitter": a fresh page load moves them.
  const other = DynaWall.scatterWidgets(Object.assign({}, options, { seed: 777 }));
  assert.notDeepEqual(other, points, 'a new page load deals a new hand');
  const spots = points.map((point) => `${Math.round(point.x)}:${Math.round(point.y)}`);
  assert.equal(new Set(spots).size, spots.length, 'and no two land on the same spot');

  // The rules have to hold for every hand, not for the one seed the test happens to
  // start from: forty page loads, all of them near the greeting, clear of it and out of
  // each other's way.
  for (let seed = 1; seed <= 40; seed += 1) {
    const hand = DynaWall.scatterWidgets(Object.assign({}, options, { seed }));
    const quarters = [0, 0, 0, 0];
    hand.forEach((point) => {
      quarters[
        (point.x + viewport.size / 2 < centreX ? 0 : 1) +
          (point.y + viewport.size / 2 < centreY ? 0 : 2)
      ] += 1;
      assert.ok(
        point.x >= ring.left &&
          point.y >= ring.top &&
          point.x + viewport.size <= ring.right &&
          point.y + viewport.size <= ring.bottom,
        `seed ${seed} threw a satellite out of the ring`
      );
      [greeting, subtitle].forEach((box) => {
        const clear =
          point.x >= box.x + box.width + viewport.clearance ||
          point.x + viewport.size <= box.x - viewport.clearance ||
          point.y >= box.y + box.height + viewport.clearance ||
          point.y + viewport.size <= box.y - viewport.clearance;
        assert.ok(clear, `seed ${seed} laid a satellite over the greeting`);
      });
    });
    assert.ok(
      Math.max.apply(null, quarters) <= 2,
      `seed ${seed} piled the satellites onto one side of the greeting`
    );
  }
});


test('the bottom edge keeps clear of the Dock and the taskbar', () => {
  const dockHeight = 104;
  const hand = DynaWall.scatterWidgets({
    width: 1920,
    height: 1080,
    size: 44,
    count: 4,
    margin: 40,
    inset: { top: 40, right: 40, bottom: dockHeight, left: 40 },
    gap: 24,
    clearance: 72,
    avoid: [{ x: 410, y: 452, width: 1100, height: 130 }],
    seed: 9
  });
  hand.forEach((point) => {
    assert.ok(point.y + 44 <= 1080 - dockHeight + 1e-9, 'no satellite is parked behind the Dock');
  });

  // An edge the caller does not name falls back to `margin`.
  const plain = DynaWall.scatterWidgets({
    width: 1920,
    height: 1080,
    size: 44,
    count: 4,
    margin: 40,
    inset: { bottom: 200 },
    seed: 9
  });
  plain.forEach((point) => {
    assert.ok(point.x >= 40 && point.y >= 40, 'the unnamed edges still use the margin');
    assert.ok(point.y + 44 <= 880 + 1e-9, 'and the named one is honoured');
  });
});


test('a crowded or degenerate wallpaper still lays every satellite out', () => {

  const crowded = DynaWall.scatterWidgets({
    width: 420,
    height: 300,
    size: 44,
    count: 4,
    margin: 24,
    gap: 10,
    clearance: 16,
    avoid: [{ x: 0, y: 0, width: 420, height: 300 }],
    seed: 5
  });
  assert.equal(crowded.length, 4, 'a greeting that fills the screen still gets four satellites');
  crowded.forEach((point) => {
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y), 'no NaN coordinates');
    assert.ok(point.x >= 24 && point.x + 44 <= 420 - 24 + 1e-9, 'still on the wallpaper');
    assert.ok(point.y >= 24 && point.y + 44 <= 300 - 24 + 1e-9);
  });

  assert.deepEqual(DynaWall.scatterWidgets({ width: 0, height: 0, size: 44, count: 0 }), []);
  assert.equal(DynaWall.scatterWidgets({}).length, 0, 'no options, no satellites');

  const random = DynaWall.createRandom(1);
  const draws = [random(), random(), random()];
  draws.forEach((value) => assert.ok(value >= 0 && value < 1, 'the PRNG stays in [0, 1)'));
  assert.equal(new Set(draws).size, 3, 'and it is not a constant');
  assert.equal(DynaWall.createRandom(1)(), draws[0], 'the same seed replays the same draws');
});

test('the scatter, the stylesheet and the markup agree on where the satellites go', () => {
  const css = readText('style.css');
  const script = readText('script.js');
  const markup = readText('index.html');

  // The breakpoint is written twice — where it is applied and where it is honoured —
  // so it has to be the same number.
  assert.equal(
    DynaWall.WIDGET_NARROW_QUERY,
    '(max-width: 720px)',
    'the scatter knows the width at which the row takes over'
  );
  assert.match(css, /@media \(max-width: 720px\)/, 'and so does the stylesheet');

  // Placement is `left`/`top` from custom properties. `transform` belongs to the
  // drift and `translate` to nothing at all, so a hover can never cancel the motion.
  assert.match(css, /\.widget-btn\s*\{[^}]*left:\s*var\(--widget-x/, 'the scatter writes left');
  assert.match(css, /\.widget-btn\s*\{[^}]*top:\s*var\(--widget-y/, 'and top');
  assert.match(css, /@keyframes widget-drift\s*\{[^}]*translate3d/, 'the drift is a transform');
  assert.match(script, /setProperty\('--widget-x'/, 'script.js writes the position it drew');
  assert.match(script, /classList\.add\('is-placed'\)/, 'the orbit is placed before it is shown');
  assert.ok(
    !/\.widget-btn\[data-widget="[a-z]+"\]\s*\{[^}]*\b(right|bottom):/.test(css),
    'no satellite is anchored to a corner any more'
  );

  // `.wallpaper-content` fades in with a transform, and a transformed ancestor is the
  // containing block of everything positioned inside it: nested there, a scattered
  // satellite would be measured against the greeting instead of the screen.
  const voids = new Set(['img', 'br', 'hr', 'meta', 'link', 'input', 'source', 'path', 'circle']);
  const stack = [];
  let chain = null;
  const tags = markup.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<(\/?)([a-zA-Z][\w:-]*)([^>]*)>/g);
  for (const token of tags) {
    const [, closing, rawName, rest] = token;
    const name = rawName.toLowerCase();
    if (closing) {
      stack.pop();
      continue;
    }
    if (name === 'nav' && /\bid="widget-bar"/.test(rest)) chain = stack.slice();
    if (voids.has(name) || /\/$/.test(rest.trim())) continue;
    const id = /\bid="([^"]+)"/.exec(rest);
    stack.push(id ? `#${id[1]}` : name);
  }
  assert.ok(chain, 'index.html must contain the widget bar');
  assert.ok(!chain.includes('#content'), 'the satellites live outside the text block');
  assert.ok(chain.includes('main'), 'and directly on the wallpaper');
});



test('widget motion stops with the wallpaper and under reduced motion', () => {
  const css = readText('style.css');
  assert.match(css, /html\.is-suspended \.widget-btn\s*\{[^}]*animation-play-state:\s*paused/);

  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.widget-btn/, 'the drift must stop');
  assert.match(reduced, /\.widget-modal/, 'the card must not slide');
  assert.ok(!/will-change/.test(reduced), 'reduced motion must not promote anything');
});

test('a click on the wallpaper is not a click on a widget', () => {
  const script = readText('script.js');
  assert.match(script, /handlers\.dynawallInteractivity/, 'the macOS host needs the rectangles');
  assert.match(script, /dynawall:interactivity/, 'and so does the WebView2 host');
  assert.match(script, /rect\.left - HIT_PADDING/, 'regions are per button, not the whole orbit');
  assert.match(
    script,
    /regions\.push\(\[0, 0, width, height\]\)/,
    'an open card owns the viewport, so a click outside it closes it'
  );
  assert.match(script, /dynawallOpenURL\.postMessage/, 'macOS opens the browser for us');
  assert.match(script, /dynawall:open-url/, 'so does the WebView2 host');
  assert.match(script, /clickAt: function/, 'the host replays a click through the API');
});

test('the satellites are a setting, on by default and resolvable from every layer', () => {
  assert.equal(DynaWall.DEFAULT_CONFIG.widgets, true, 'the widgets ship turned on');
  assert.equal(DynaWall.STORAGE_KEYS.widgets, 'dynawall.widgets');

  // The same boolean every other setting accepts: host IPC, URL, cache and seed.
  assert.deepEqual(DynaWall.mapLivelyProperty('widgets', 'false'), {
    field: 'widgets',
    value: false
  });
  assert.deepEqual(DynaWall.mapLivelyProperty('widgets', true), { field: 'widgets', value: true });
  assert.equal(DynaWall.mapLivelyProperty('widgets', 'sometimes'), null);
  assert.deepEqual(DynaWall.mapWallpaperEngineProperties({ widgets: { value: false } }), [
    { field: 'widgets', value: false }
  ]);
  assert.deepEqual(DynaWall.parseQueryParams('?widgets=false'), { widgets: false });
  assert.equal(DynaWall.parseQueryParams('?satellites=off').widgets, false, 'satellites is an alias');
  assert.deepEqual(DynaWall.readStoredConfig(fakeStorage({ 'dynawall.widgets': 'false' })), {
    widgets: false
  });
  assert.deepEqual(DynaWall.readSeed({ __dynawallSeed: { widgets: false } }), { widgets: false });

  const config = DynaWall.resolveConfig({
    ipc: { widgets: false },
    url: { widgets: true },
    storage: { widgets: true },
    defaults: DynaWall.DEFAULT_CONFIG
  });
  assert.equal(config.widgets, false, 'a live host switch outranks the URL and the cache');
});

test('each satellite has a switch of its own, in every config layer', () => {
  // One setting per satellite, all defaulting on and all named after the catalogue id.
  const ids = DynaWall.WIDGETS.map((widget) => widget.id);
  assert.deepEqual(ids, ['music', 'news', 'youtube', 'weather']);
  assert.deepEqual(Object.keys(DynaWall.WIDGET_FIELDS).sort(), ids.slice().sort());
  assert.deepEqual(DynaWall.WIDGET_SETTING_FIELDS, [
    'widgets',
    'widgetMusic',
    'widgetNews',
    'widgetYouTube',
    'widgetWeather'
  ]);

  ids.forEach((id) => {
    const field = DynaWall.WIDGET_FIELDS[id];
    assert.equal(
      DynaWall.DEFAULT_CONFIG[field],
      true,
      `${id} is on by default, like the master switch`
    );
    assert.equal(DynaWall.STORAGE_KEYS[field], `dynawall.${field}`, `${id} is cached on its own`);
    // Lively and Wallpaper Engine hand the same field over: one checkbox each.
    assert.deepEqual(DynaWall.mapLivelyProperty(field, 'false'), { field: field, value: false });
    assert.deepEqual(
      DynaWall.mapWallpaperEngineProperties({ [field.toLowerCase()]: { value: false } }),
      [{ field: field, value: false }]
    );
  });

  // `?music=false` for one satellite, in both spellings.
  assert.equal(DynaWall.parseQueryParams('?music=false').widgetMusic, false);
  assert.equal(DynaWall.parseQueryParams('?widgetyoutube=false').widgetYouTube, false);
  assert.equal(DynaWall.parseQueryParams('?weather=0').widgetWeather, false);
  assert.equal(DynaWall.parseQueryParams('?news=on').widgetNews, true);

  // …and one cache entry per satellite.
  assert.deepEqual(
    DynaWall.readStoredConfig(
      fakeStorage({ 'dynawall.widgetMusic': 'false', 'dynawall.widgetWeather': 'false' })
    ),
    { widgetMusic: false, widgetWeather: false }
  );

  // Hiding one satellite leaves the other three as they were: the layers resolve field by
  // field, so a host pushing one flag cannot reset its neighbours.
  const config = DynaWall.resolveConfig({
    ipc: { widgetYouTube: false },
    storage: { widgetMusic: false },
    url: { widgetNews: false },
    defaults: DynaWall.DEFAULT_CONFIG
  });
  assert.deepEqual(
    {
      widgets: config.widgets,
      music: config.widgetMusic,
      news: config.widgetNews,
      youtube: config.widgetYouTube,
      weather: config.widgetWeather
    },
    { widgets: true, music: false, news: false, youtube: false, weather: true }
  );
});

test('a hidden satellite is hidden for real: unplaced, unclickable, and its card closes', () => {
  const css = readText('style.css');
  // Removed rather than faded: a hidden orbit cannot drift, be measured or be clicked.
  assert.match(css, /html\.is-widgets-off \.widget-orbit\s*\{[^}]*display:\s*none/);
  // Same for one satellite at a time: `.widget-btn` sets `display: grid`, so the state is
  // spelled out rather than left to the browser's own `[hidden]` rule.
  assert.match(css, /\.widget-btn\[hidden\]\s*\{[^}]*display:\s*none/);

  const script = readText('script.js');
  // The page starts in the state the configuration asked for, before the first deal.
  assert.match(script, /createWidgets\(window, document, \{ config: app\.state\.config \}\)/);
  assert.match(script, /classList\.add\('is-widgets-off'\)/);
  assert.match(script, /function applyConfig\(next\)/, 'the switches are live, not a reload');
  assert.match(script, /button\.hidden = !visible/, 'a hidden satellite leaves the layout');
  assert.match(script, /if \(!visible && state\.activeId === id\) closeWidget\(\)/, 'and its card');
  assert.match(script, /function scatter\(\) \{\n\s+if \(!state\.enabled\) return;/, 'nothing is placed while off');
  assert.match(script, /const active = visibleButtons\(\);/, 'only the visible ones are dealt');
  assert.match(script, /count: active\.length/, 'and the ring is sized for them');
  // No rectangles at all: the desktop belongs to the Finder when the widgets are off, and
  // a hidden satellite reports nothing either way.
  assert.match(script, /const open = state\.enabled && Boolean\(state\.activeId\)/);
  assert.match(script, /\} else if \(state\.enabled\) \{/, 'button rectangles need the switch too');
  // A live change reaches the controller, and the console can drive it as well.
  assert.match(
    script,
    /WIDGET_SETTING_FIELDS\.some\(function \(field\) \{ return touched\[field\]; \}\)/,
    'every widget field reaches the controller'
  );
  assert.match(script, /widgetsRef\.applyConfig\(next\)/);
  assert.match(script, /setWidgetsEnabled: function/);
  assert.match(script, /setWidgetEnabled: function/);
});

test('every host owns the Desktop widgets switch', () => {
  const lively = readJson('LivelyProperties.json');
  assert.equal(lively.widgets.type, 'checkbox');
  assert.equal(lively.widgets.value, DynaWall.DEFAULT_CONFIG.widgets);
  assert.equal(
    lively.__HEADER_WIDGETS__.value,
    'Widgets',
    'the property sits under its own header in Lively'
  );

  const project = readJson('project.json');
  assert.equal(project.general.properties.widgets.type, 'bool');
  assert.equal(project.general.properties.widgets.value, DynaWall.DEFAULT_CONFIG.widgets);

  const swift = hostSwift();
  assert.match(swift, /@Published var widgets: Bool/, 'the popover needs a stored setting');
  assert.match(swift, /static let widgets = "desktopWidgets"/, 'and a UserDefaults key');
  assert.match(
    swift,
    /Toggle\("On the desktop", isOn: \$preferences\.widgets\)/,
    'the master switch is in the popover'
  );
  assert.match(swift, /livelyPropertyListener\("widgets", \\\(widgets/, 'and is pushed live');
  assert.match(swift, /\\"widgets\\": \\\(widgets/, 'the seed carries it, so the first frame is right');

  const prefs = fs.readFileSync(path.join(ROOT, 'windows/Preferences.cs'), 'utf8');
  assert.match(prefs, /public bool Widgets \{ get; set; \} = true;/);
  assert.match(prefs, /values\.Add\(\("widgets", Widgets\)\)/, 'pushed to the page like the rest');
  assert.match(prefs, /\["widgets"\] = Widgets/, 'and seeded at document start');

  const form = fs.readFileSync(path.join(ROOT, 'windows/SettingsForm.cs'), 'utf8');
  assert.match(form, /private readonly ToggleSwitch widgetsBox = new\(\);/);
  assert.match(
    form,
    /AddCard\(root, "Widgets", widgetsBox, widgetOptions\)/,
    'the switch is visible in the window'
  );
  assert.match(form, /Preferences\.Widgets = widgetsBox\.Checked/);
});
test('every host owns a switch for each satellite', () => {
  const lively = readJson('LivelyProperties.json');
  const project = readJson('project.json');
  const swift = hostSwift();
  const prefs = readText('windows/Preferences.cs');
  const form = readText('windows/SettingsForm.cs');

  // One switch per satellite, named off the same catalogue the page uses, in all four
  // hosts: Lively's checkbox, Wallpaper Engine's bool, the popover's Toggle and the
  // Windows window's ToggleSwitch.
  const labels = { music: 'Music', news: 'News', youtube: 'YouTube', weather: 'Weather' };

  DynaWall.WIDGETS.forEach((widget) => {
    const { id } = widget;
    // The field the page reads, the C# property that carries it, the window's box.
    const field = DynaWall.WIDGET_FIELDS[id];
    const prop = field.charAt(0).toUpperCase() + field.slice(1);
    const box = `${field}Box`;
    const weKey = field.toLowerCase();
    const push = `livelyPropertyListener("${field}", \\(${field} ? "true" : "false"));`;
    const seed = `\\"${field}\\": \\(${field} ? "true" : "false")`;

    assert.equal(lively[field].type, 'checkbox', `Lively has a ${field} checkbox`);
    assert.equal(lively[field].value, true);
    assert.equal(project.general.properties[weKey].type, 'bool', `Wallpaper Engine has ${weKey}`);
    assert.equal(project.general.properties[weKey].value, true);

    // macOS: stored, keyed, seeded, pushed live and shown in the popover.
    assert.ok(swift.includes(`@Published var ${field}: Bool`), `macOS stores ${field}`);
    assert.ok(
      swift.includes(`static let ${field} = "desktop${prop}"`),
      `macOS keys ${field} in UserDefaults`
    );
    assert.ok(swift.includes(push), `macOS pushes ${field} live`);
    assert.ok(swift.includes(seed), `the seed carries ${field}, so the first frame is right`);
    assert.ok(
      swift.includes(`Toggle("${labels[id]}", isOn: $preferences.${field})`),
      `the popover shows a ${id} switch`
    );

    // Windows: stored, seeded, pushed live and shown in the window.
    assert.ok(prefs.includes(`public bool ${prop} { get; set; } = true;`), `stores ${prop}`);
    assert.ok(prefs.includes(`values.Add(("${field}", ${prop}))`), 'pushed like the rest');
    assert.ok(prefs.includes(`["${field}"] = ${prop}`), 'and seeded at document start');
    assert.ok(form.includes(`private readonly ToggleSwitch ${box} = new();`));
    assert.ok(form.includes(`StyleToggle(${box}, "${labels[id]}");`), `a ${id} switch is shown`);
    assert.ok(form.includes(`Preferences.${prop} = ${box}.Checked`), 'and saves it');
    assert.ok(form.includes(`${box}.Checked = Preferences.${prop};`), 'and reloads it');
  });

});



test('the widget URLs are built and encoded, not pasted', () => {
  assert.equal(
    DynaWall.buildYouTubeMusicSearchUrl('lo-fi & jazz'),
    'https://music.youtube.com/search?q=lo-fi%20%26%20jazz'
  );
  assert.equal(DynaWall.buildYouTubeMusicSearchUrl('   '), 'https://music.youtube.com/');
  assert.equal(
    DynaWall.buildYouTubeSearchUrl('live'),
    'https://www.youtube.com/results?search_query=live'
  );
  assert.equal(DynaWall.buildYouTubeTrendingUrl('gb'), 'https://www.youtube.com/feed/trending?gl=GB');
  assert.equal(DynaWall.buildYouTubeTrendingUrl(''), 'https://www.youtube.com/feed/trending');
  assert.equal(DynaWall.buildGoogleNewsUrl(''), 'https://news.google.com/');
  assert.equal(
    DynaWall.buildGoogleNewsUrl('world news'),
    'https://news.google.com/search?q=world%20news&hl=en-US&gl=US&ceid=US%3Aen'
  );
  assert.equal(DynaWall.clipText('  a\n b  '), 'a b');
  assert.equal(DynaWall.clipText('abcdef', 3), 'abc');
});

test('the forecast request asks for exactly what the card draws', () => {
  const url = DynaWall.buildWeatherForecastUrl({
    latitude: 51.5072,
    longitude: -0.1276,
    unit: 'celsius'
  });
  assert.ok(url.startsWith('https://api.open-meteo.com/v1/forecast?'));
  [
    'latitude=51.5072',
    'longitude=-0.1276',
    'timezone=auto',
    'forecast_days=2',
    'temperature_unit=celsius',
    'wind_speed_unit=kmh',
    'current=temperature_2m,relative_humidity_2m',
    'hourly=temperature_2m,weather_code,precipitation_probability',
    'daily=temperature_2m_max,temperature_2m_min'
  ].forEach((part) => {
    assert.ok(url.includes(part), `the forecast URL is missing ${part}`);
  });

  const imperial = DynaWall.buildWeatherForecastUrl({
    latitude: 40.7,
    longitude: -74,
    unit: 'fahrenheit'
  });
  assert.ok(imperial.includes('temperature_unit=fahrenheit'));
  assert.ok(imperial.includes('wind_speed_unit=mph'));
  assert.equal(DynaWall.normalizeTemperatureUnit('kelvin'), 'celsius');

  const geo = DynaWall.buildGeocodingUrl('  Zürich ');
  assert.ok(geo.startsWith('https://geocoding-api.open-meteo.com/v1/search?'));
  assert.ok(geo.includes('name=Z%C3%BCrich'));
  assert.ok(geo.includes('count=6'));
});

test('the forecast parser reads the payload the card shows', () => {
  const payload = {
    current: {
      time: '2026-01-15T14:30',
      temperature_2m: 7.6,
      relative_humidity_2m: 81,
      apparent_temperature: 5.2,
      is_day: 1,
      weather_code: 61,
      wind_speed_10m: 14.3
    },
    hourly: {
      time: [
        '2026-01-15T13:00',
        '2026-01-15T14:00',
        '2026-01-15T15:00',
        '2026-01-15T16:00',
        '2026-01-15T17:00',
        '2026-01-15T18:00',
        '2026-01-15T19:00'
      ],
      temperature_2m: [7.1, 7.6, 8, 8.4, 8.1, 7.2, 6.4],
      weather_code: [3, 61, 61, 80, 3, 2, 1],
      precipitation_probability: [10, 55, 70, 40, 15, 5, 0]
    },
    daily: { temperature_2m_max: [9.4], temperature_2m_min: [2.6] }
  };

  const data = DynaWall.parseWeatherPayload(payload, { unit: 'celsius' });
  assert.equal(data.temperature, '8°');
  assert.equal(data.apparent, '5°');
  assert.equal(data.high, '9°');
  assert.equal(data.low, '3°');
  assert.equal(data.humidity, '81%');
  assert.equal(data.wind, '14 km/h');
  assert.equal(data.rain, '70%', 'the highest chance in the six hours on screen');
  assert.equal(data.label, 'Light rain');
  assert.equal(data.glyph, 'rain');
  assert.equal(data.unitSuffix, '°C');
  assert.equal(data.hours.length, 6, 'six hours fit the strip');
  assert.equal(data.hours[0].hour, '14:00', 'the strip starts at the current hour');
  assert.equal(data.hours[0].isNow, true);
  assert.equal(data.hours[1].hour, '15:00');

  assert.equal(DynaWall.parseWeatherPayload(null), null);
  assert.equal(DynaWall.parseWeatherPayload({}), null);
  assert.equal(DynaWall.parseWeatherPayload({ current: {} }), null, 'a payload without a temperature is not a forecast');
  assert.equal(DynaWall.parseWeatherPayload({ current: { temperature_2m: 3 } }).hours.length, 0);
});

test('unknown weather codes are admitted, never guessed', () => {
  assert.deepEqual(DynaWall.describeWmoCode(0), { label: 'Clear sky', glyph: 'clear' });
  assert.deepEqual(DynaWall.describeWmoCode(95), { label: 'Thunderstorm', glyph: 'storm' });
  assert.deepEqual(DynaWall.describeWmoCode(1234), { label: 'Unsettled', glyph: 'cloud' });
  assert.deepEqual(DynaWall.describeWmoCode('nope'), { label: 'Unsettled', glyph: 'cloud' });
  Object.keys(DynaWall.WEATHER_GLYPHS).forEach((name) => {
    assert.match(DynaWall.WEATHER_GLYPHS[name], /^<(circle|path)/, `${name} has no artwork`);
  });
});

test('a city can be picked without a keyboard', () => {
  // The native desktop never gives the page focus, so the starter cities are the only
  // way into the weather card there; they have to be real, usable coordinates.
  assert.equal(DynaWall.WEATHER_CITIES.length, 6);
  const names = new Set();
  DynaWall.WEATHER_CITIES.forEach((city) => {
    assert.ok(city.name && city.country, `${city.name || '?'} needs a name and a country`);
    assert.ok(!names.has(city.name), `${city.name} is listed twice`);
    names.add(city.name);
    assert.ok(
      Number.isFinite(city.latitude) && city.latitude >= -90 && city.latitude <= 90,
      `${city.name} needs a real latitude`
    );
    assert.ok(
      Number.isFinite(city.longitude) && city.longitude >= -180 && city.longitude <= 180,
      `${city.name} needs a real longitude`
    );
    const url = DynaWall.buildWeatherForecastUrl({ ...city, unit: 'celsius' });
    assert.ok(url.includes(`latitude=${city.latitude}`), `${city.name} must reach the API`);
  });
  // Half the world is south of the equator and east of Greenwich.
  assert.ok(DynaWall.WEATHER_CITIES.some((city) => city.latitude < 0), 'the list is not all north');
  assert.ok(DynaWall.WEATHER_CITIES.some((city) => city.longitude > 0), 'nor all west');
});

test('the city search keeps only places a forecast can be asked for', () => {
  const places = DynaWall.parseGeocodingResults({
    results: [
      { id: 1, name: 'Lisbon', admin1: 'Lisbon', country: 'Portugal', latitude: 38.72, longitude: -9.14 },
      { id: 2, name: 'Nowhere' },
      null,
      { id: 3, name: '  Lisbon  ', admin1: 'Ohio', country: 'United States', latitude: '40.77', longitude: '-80.62' }
    ]
  });
  assert.equal(places.length, 2);
  assert.equal(places[0].label, 'Lisbon · Lisbon · Portugal');
  assert.equal(places[1].name, 'Lisbon');
  assert.equal(places[1].latitude, 40.77, 'strings from JSON become numbers');
  assert.deepEqual(DynaWall.parseGeocodingResults({}), []);
  assert.deepEqual(DynaWall.parseGeocodingResults(null), []);
});

test('the weather place and unit survive a reload', () => {
  const storage = fakeStorage();
  DynaWall.writeWeatherPlace(storage, {
    name: 'Lisbon',
    region: 'Lisbon',
    country: 'Portugal',
    latitude: 38.72,
    longitude: -9.14
  });
  const place = DynaWall.readWeatherPlace(storage);
  assert.equal(place.name, 'Lisbon');
  assert.equal(place.latitude, 38.72);

  DynaWall.writeWeatherUnit(storage, 'fahrenheit');
  assert.equal(DynaWall.readWeatherUnit(storage), 'fahrenheit');

  // Anything hand-edited, truncated or from a future version means "no place yet",
  // so the card asks where you are instead of throwing on load.
  assert.equal(
    DynaWall.readWeatherUnit(fakeStorage({ 'dynawall.weatherUnit': 'kelvin' })),
    'celsius'
  );
  assert.equal(DynaWall.readWeatherPlace(fakeStorage({ 'dynawall.weatherPlace': '{oops' })), null);
  assert.equal(DynaWall.readWeatherPlace(fakeStorage({ 'dynawall.weatherPlace': '{"name":"X"}' })), null);
  assert.equal(DynaWall.readWeatherPlace(fakeStorage({ 'dynawall.weatherPlace': 'null' })), null);
});

test('relative timestamps and locale regions are read defensively', () => {
  const now = 1_700_000_000_000;
  assert.equal(DynaWall.relativeTime(now, now), 'just now');
  assert.equal(DynaWall.relativeTime(now - 4 * 60_000, now), '4 min ago');
  assert.equal(DynaWall.relativeTime(now - 2 * 3_600_000, now), '2 h ago');
  assert.equal(DynaWall.relativeTime(now - 50 * 3_600_000, now), '2 d ago');
  assert.equal(DynaWall.relativeTime(0, now), 'never');
  assert.equal(DynaWall.hourLabel('2026-01-15T09:00'), '09:00');

  assert.equal(DynaWall.regionCodeFromLocale('en-GB'), 'GB');
  assert.equal(DynaWall.regionCodeFromLocale('pt_BR'), 'BR');
  assert.equal(DynaWall.regionCodeFromLocale(''), 'US');
  assert.equal(DynaWall.regionCodeFromLocale(undefined), 'US');

  assert.equal(DynaWall.NEWS_DESKS[0].query, '', 'the first desk is the unfiltered front page');
  DynaWall.NEWS_DESKS.forEach((desk) => {
    assert.ok(
      DynaWall.buildGoogleNewsUrl(desk.query).startsWith('https://news.google.com/'),
      `${desk.title} must leave for Google News`
    );
  });
  DynaWall.MUSIC_STATIONS.forEach((station) => {
    assert.ok(
      DynaWall.buildYouTubeMusicSearchUrl(station.query).startsWith('https://music.youtube.com/'),
      `${station.title} must leave for YouTube Music`
    );
  });
});

test('the macOS host forwards desktop clicks into a card without taking any', () => {
  const swift = hostSwift();

  // The desktop keeps its mouse: this flag is why Finder, the icons, drag-select and
  // the context menu behave exactly as they did before widgets existed.
  assert.match(swift, /window\.ignoresMouseEvents = true/);
  assert.match(
    swift,
    /NSEvent\.addGlobalMonitorForEvents\(matching: \[\.leftMouseDown\]\)/,
    'the host observes clicks instead of receiving them'
  );
  assert.match(swift, /window\.DynaWall\.clickAt\(/, 'the click is replayed inside the page');
  assert.match(swift, /guard !isPaused, !NSApp\.isActive else \{ return \}/, 'a paused wallpaper takes nothing');
  assert.match(swift, /isCovered\(byAnotherAppAt:/, 'a click on an app window is never ours');
  assert.match(swift, /entry\.hitArea\.contains\(local\)/, 'only the reported rectangles are ours');

  // Both bridges are registered on every display and removed with it.
  assert.match(swift, /add\(widgetBridge, name: WidgetMessageHandler\.interactivityName\)/);
  assert.match(swift, /add\(widgetBridge, name: WidgetMessageHandler\.openURLName\)/);
  assert.match(swift, /removeScriptMessageHandler\(forName: WidgetMessageHandler\.interactivityName\)/);
  assert.match(swift, /removeScriptMessageHandler\(forName: WidgetMessageHandler\.openURLName\)/);

  // Links leave the wallpaper for the user's browser, and only https does.
  assert.match(swift, /NSWorkspace\.shared\.open\(url\)/);
  assert.match(swift, /url\.scheme\?\.lowercased\(\) == "https"/);
  // The watch goes away with the app instead of outliving it.
  assert.match(swift, /func stop\(\) \{\n        stopClickMonitor\(\)/);
  assert.match(swift, /NSEvent\.removeMonitor\(clickMonitor\)/);
});

test('a card takes the keyboard while it is open and gives it straight back', () => {
  const swift = hostSwift();

  // The window can only become key while a card is up: `canBecomeKey` follows the flag the
  // controller flips from the page's own report, so a passive desktop can never take a
  // keystroke away from the app the user is actually in.
  assert.match(swift, /var isInteractive = false/);
  assert.match(swift, /override var canBecomeKey: Bool \{ isInteractive \}/);
  assert.match(swift, /override var canBecomeMain: Bool \{ isInteractive \}/);
  assert.match(swift, /if area\.isOpen != wasOpen \{/, 'only a real flip moves the window');
  assert.match(swift, /self\.updateInteractivity\(for: entry, isOpen: area\.isOpen\)/);

  // Open: real mouse events, above the Finder icons, key, web view first responder — the
  // four things a search field needs before a caret can be put in it.
  assert.match(swift, /window\.ignoresMouseEvents = !isOpen/);
  assert.match(swift, /window\.level = \.floating/, 'above the icons, below the menu bar');
  assert.match(swift, /window\.makeKeyAndOrderFront\(nil\)/);
  assert.match(swift, /window\.makeFirstResponder\(entry\.webView\)/);

  // Closed: click-through again, back at desktop level, and the app lets go of the keyboard
  // instead of sitting there active with no key window to send it to.
  assert.match(swift, /window\.level = DesktopLevelWindow\.desktopLevel/);
  assert.match(swift, /window\.orderFrontRegardless\(\)/, 'the live photo stays in front of the static one');
  assert.match(swift, /NSApp\.deactivate\(\)/);

  // Nothing of ours may keep a card — or the keyboard — once the app loses focus, and a link
  // leaves for the browser with the wallpaper already back at rest.
  assert.match(swift, /NSApplication\.didResignActiveNotification/);
  assert.match(swift, /window\.DynaWall && window\.DynaWall\.closeWidget\(\)/);
  assert.match(swift, /dismissOpenWidgets\(reason: "another app came forward"\)/);
  assert.match(swift, /dismissOpenWidgets\(reason: "link left for the browser"\)/);
  assert.match(swift, /dismissOpenWidgets\(reason: "wallpaper paused"\)/);
});

test('both search fields answer a replayed click, not only a form submit', () => {
  const script = readText('script.js');

  // A replayed click is synthetic, and a synthetic click on a submit button does not
  // reliably submit its form: each card runs its search from the button itself.
  assert.match(script, /const submit = el\('button', 'widget-submit', 'Search'\);/);
  assert.match(script, /const submit = el\('button', 'widget-submit', 'Find'\);/);
  assert.equal(
    (script.match(/submit\.addEventListener\('click'/g) || []).length,
    2,
    'both cards answer a click on their own button'
  );

  // The host's replay asks the owning button for a real click, which is what runs the
  // activation behaviour (a form submission included) a dispatched MouseEvent never does.
  assert.match(script, /function buttonAt\(node\)/);
  assert.match(script, /const control = buttonAt\(node\);/);
  assert.match(script, /control\.click\(\);/);

  // The door the host uses when it has to leave the desktop on the page's behalf.
  assert.match(script, /closeWidget: function \(\) \{/);
});

test('the Windows host forwards desktop clicks into a card without taking any', () => {
  const clicks = readText('windows/DesktopClicks.cs');
  const host = readText('windows/DesktopHost.cs');
  const window = readText('windows/WallpaperWindow.cs');
  const controller = readText('windows/WallpaperController.cs');

  // A low-level watch that never consumes: every click is passed straight on, so the
  // desktop keeps drag-select, right-click, icons and the context menu.
  assert.match(clicks, /WhMouseLl/);
  assert.match(clicks, /CallNextHookEx\(hook, code, wParam, lParam\)/);
  assert.match(clicks, /UnhookWindowsHookEx/);
  assert.match(clicks, /LlmhfInjected/, 'automation is not the user');

  // Only a click on the desktop layer, inside a rectangle the page reported, is replayed.
  assert.match(host, /WindowFromPoint/);
  assert.match(host, /internal static bool IsDesktopAt\(Point point\)/);
  assert.match(controller, /if \(!DesktopHost\.IsDesktopAt\(point\)\) return;/);
  assert.match(controller, /window\.HitArea\.Contains\(local\.X, local\.Y\)/);
  assert.match(window, /window\.DynaWall && window\.DynaWall\.clickAt\(/);

  // The page's two calls: the rectangles, and the browser.
  assert.match(window, /core\.WebMessageReceived \+= OnWebMessage/);
  assert.match(window, /WidgetBridge\.Read\(json, out var area, out var url\)/);
  assert.match(window, /UseShellExecute = true/);
  const bridge = fs.readFileSync(path.join(ROOT, 'windows/WidgetBridge.cs'), 'utf8');
  assert.match(bridge, /dynawall:interactivity/);
  assert.match(bridge, /dynawall:open-url/);
  assert.match(bridge, /uri\.Scheme (?:==|!=) Uri\.UriSchemeHttps/, 'only https reaches the browser');
});

test('only https leaves the wallpaper for the browser', () => {
  const opened = [];
  const win = {
    open: function (url, target, features) {
      opened.push([url, target, features]);
      return {};
    }
  };
  assert.equal(DynaWall.openExternal(win, 'https://example.com/x'), true);
  assert.equal(DynaWall.openExternal(win, 'javascript:alert(1)'), false);
  assert.equal(DynaWall.openExternal(win, 'http://example.com'), false, 'plain http is refused');
  assert.equal(DynaWall.openExternal(win, ''), false);
  assert.equal(DynaWall.openExternal(null, 'https://example.com'), false);
  assert.deepEqual(opened, [['https://example.com/x', '_blank', 'noopener']]);

  // Inside a host the page hands the URL up instead: the WebView2 embedder fires a
  // navigation event and macOS answers a script message. Both are declared.
  const posted = [];
  const hosted = {
    webkit: {
      messageHandlers: {
        dynawallOpenURL: {
          postMessage: (url) => posted.push(url)
        }
      }
    }
  };
  assert.equal(DynaWall.openExternal(hosted, 'https://news.google.com/'), true);
  assert.deepEqual(posted, ['https://news.google.com/']);
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
 * Premium surface: quick actions, live preview, resilience
 * -------------------------------------------------------------------------- */

group('Menu bar quick actions');

test('the status item answers a secondary click with a quick action menu', () => {
  const swift = hostSwift();
  // AppKit only sends the status item's action for the primary button unless the
  // button opts into the other mouse events, so the right-click would be swallowed.
  assert.match(swift, /button\.sendAction\(on: \[\.leftMouseUp, \.rightMouseUp\]\)/);
  assert.match(swift, /event\?\.type == \.rightMouseUp/, 'a right-click opens the menu');
  assert.match(
    swift,
    /event\?\.modifierFlags\.contains\(\.control\)/,
    'control-click is a secondary click on every Mac'
  );

  assert.match(swift, /private lazy var quickMenu: NSMenu/, 'the menu is built once, not per click');
  assert.match(swift, /menu\.delegate = self/);
  assert.match(swift, /menu\.autoenablesItems = false/, 'Next Photo must be able to stay greyed out');
  assert.match(swift, /extension AppDelegate: NSMenuDelegate/);
  [
    'Next Photo',
    'Pause Wallpaper',
    'Open Wallpapers in Finder',
    'Settings…',
    'Launch at Login',
    'Quit DynaWall'
  ].forEach((title) => {
    assert.ok(swift.includes(`title: "${title}"`), `the quick menu is missing "${title}"`);
  });

  // The menu is attached for exactly one tracking loop: leaving it installed would
  // steal every left-click from the popover.
  const present = memberBody(swift, 'private func presentQuickMenu(from button: NSStatusBarButton)');
  assert.match(present, /statusItem\?\.menu = quickMenu/);
  assert.match(present, /button\.performClick\(nil\)/);
  assert.match(present, /statusItem\?\.menu = nil/);
});

test('the quick menu is refreshed from the live model before it opens', () => {
  const swift = hostSwift();
  const update = memberBody(swift, 'func menuNeedsUpdate(_ menu: NSMenu)');
  assert.match(update, /menu === quickMenu/, 'only the quick menu is refreshed');
  assert.match(
    update,
    /preferences\.slideshow && controller\.photoCount > 0/,
    'a skip needs a rotation and a photo to skip to'
  );
  assert.match(
    update,
    /controller\.isPaused \? "Resume Wallpaper" : "Pause Wallpaper"/,
    'the title has to describe the state the wallpaper is in'
  );
  assert.match(update, /\.state =\s*preferences\.launchAtLogin \? \.on : \.off/);
});

test('the quick menu and the folder row hand the folder to Finder', () => {
  const swift = hostSwift();
  assert.match(swift, /func revealPhotoFolderInFinder\(\)/);
  assert.match(swift, /NSWorkspace\.shared\.selectFile\(nil, inFileViewerRootedAtPath: path\)/);

  const row = memberBody(swift, 'private var folderRow: some View');
  assert.match(row, /revealPhotoFolder\(\)/, 'the row owns a Reveal in Finder button');
  assert.match(row, /arrow\.up\.forward\.app/);
  assert.match(row, /"Change Folder…"/, 'the picker stays next to the reveal button');
  // The drop target answers "can I let go here?" before the button is released.
  assert.match(row, /dropTarget\.isTargeted \? 1\.012 : 1/, 'the row lifts while a folder hovers');
  assert.match(row, /Color\.accentColor\.opacity\(dropTarget\.isTargeted \? 0\.45 : 0\)/);

  const reveal = memberBody(swift, 'private func revealPhotoFolder()');
  assert.match(reveal, /preferences\.revealPhotoFolderInFinder\(\)/);
});

test('tactile feedback rides the trackpad actuator, not a notification', () => {
  const swift = hostSwift();
  assert.match(swift, /enum DynaHaptics/);
  assert.match(swift, /NSHapticFeedbackManager\.defaultPerformer\.perform/);

  assert.match(memberBody(swift, 'func nextPhoto()'), /DynaHaptics\.tap\(\.alignment\)/);
  assert.match(memberBody(swift, 'func setPaused(_ paused: Bool)'), /DynaHaptics\.tap\(\.levelChange\)/);
  assert.match(
    memberBody(swift, 'private var footer: some View'),
    /DynaHaptics\.tap\(\.levelChange\)/,
    'restoring the defaults is a state flip'
  );
  assert.match(
    memberBody(swift, 'private func handleFolderDrop('),
    /DynaHaptics\.tap\(\.alignment\)/,
    'an accepted folder is acknowledged'
  );
  // `.generic` is the "that was rejected" pattern and must not be used for a skip.
  assert.ok(!swift.includes('.perform(.generic'), 'a skip must not feel like an error');
});

group('Live preview & image resilience');

test('the preview card shows the photo the page actually revealed', () => {
  const swift = hostSwift();
  assert.match(swift, /@Published private\(set\) var previewImage: NSImage\?/);

  const preview = memberBody(swift, 'private var previewCard: some View');
  assert.match(preview, /previewPhotoBackdrop/, 'the card draws the live photo');

  const backdrop = memberBody(swift, 'private var previewPhotoBackdrop: some View');
  assert.match(
    backdrop,
    /preferences\.slideshow, let photo = controller\.previewImage/,
    'no slideshow, no photo, no backdrop'
  );
  assert.match(backdrop, /Image\(nsImage: photo\)/);
  assert.match(backdrop, /Color\.black\.opacity\(0\.58\)/, 'the scrim dims the miniature too');
  assert.match(
    backdrop,
    /frame\(width: Self\.popoverWidth - 32, height: 120\)/,
    'the card height is fixed'
  );
  assert.ok(!backdrop.includes('.multilineTextAlignment'), 'the backdrop owns no type');

  // A 5K wallpaper must not be decoded at full size just to fill a 120 pt card.
  assert.match(swift, /CGImageSourceCreateThumbnailAtIndex/);
  assert.match(swift, /kCGImageSourceThumbnailMaxPixelSize/);
  assert.match(
    swift,
    /DispatchQueue\.global\(qos: \.userInitiated\)\.async/,
    'the decode is off the main thread'
  );
  assert.match(swift, /token == self\.previewImageToken/, 'a slow decode cannot replace a newer photo');

  // The page hands back the URL it revealed, and the logger only reports library URLs.
  assert.match(swift, /var onSource: \(\(String\) -> Void\)\?/);
  assert.match(swift, /static func photoIndex\(from url: URL\) -> Int\?/);
});

test('a photo that cannot be decoded is skipped instead of blanking the layer', () => {
  const script = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
  const start = script.indexOf('function paintPhoto(');
  assert.notEqual(start, -1, 'paintPhoto() is missing');
  const paint = script.slice(start, script.indexOf('\n    }', start));
  assert.match(paint, /layer\.onerror = skip;/, 'the error event reaches the skip path');
  assert.match(paint, /layer\.onerror = null;/, 'the handler is dropped once the photo failed');
  assert.match(paint, /let settled = false;/, 'the two failure paths only cost one skip');
  assert.match(paint, /if \(settled \|\| stale\(\)\) return;/, 'a stale decode still cannot reveal');
  // A layer that never decodes must not stay on screen with a broken bitmap.
  assert.match(paint, /layer\.removeAttribute\('src'\)/);
  // A corrupt band must not blank the desktop while the rest of the folder is fine.
  assert.match(
    paint,
    /if \(all\.length > sources\.length\) \{/,
    'an exhausted band widens to the whole library before giving up'
  );
  assert.match(paint, /paintPhoto\(stepPhotoIndex\(all\.length, current, false\), all\)/);
  assert.match(paint, /const all = photoSources\(\);/);

  const clearStart = script.indexOf('function clearPhotos()');
  const clear = script.slice(clearStart, script.indexOf('\n    }', clearStart));
  assert.match(clear, /layer\.onerror = null;/, 'a stopped slideshow keeps no handlers');
});

test('the decoded texture is released once the cross-fade is over', () => {
  const script = fs.readFileSync(path.join(ROOT, 'script.js'), 'utf8');
  const start = script.indexOf('function releasePhotoTexture(');
  assert.notEqual(start, -1, 'releasePhotoTexture() is missing');
  const release = script.slice(start, script.indexOf('\n    }', start));
  assert.match(release, /PHOTO_FADE_MS/, 'the bitmap is held for exactly the fade');
  assert.match(release, /token !== state\.photoToken/, 'a newer slide owns the layer');
  assert.match(release, /layer\.classList\.contains\('is-visible'\)/, 'never clear a photo on screen');
  assert.match(release, /layer\.removeAttribute\('src'\)/);

  const paintStart = script.indexOf('function paintPhoto(');
  const paint = script.slice(paintStart, script.indexOf('\n    }', paintStart));
  assert.match(paint, /releasePhotoTexture\(previous\)/, 'the outgoing layer is recycled');
});

group('Premium typography & scrim');

test('the scrim protects the greeting and leaves the picture vivid', () => {
  const scrim = cssRule('.scrim');
  assert.ok(scrim, '.scrim is missing');
  assert.match(scrim, /62% 58% at 50% 48%/, 'the pool of shade is centred on the greeting');
  const stops = Array.from(scrim.matchAll(/rgba\(1, 4, 9, ([0-9.]+)\)/g)).map((match) =>
    Number(match[1])
  );
  assert.ok(stops.length >= 8, 'a multi-stop ramp, not two flat bands');
  assert.ok(
    Math.max(...stops) >= 0.4,
    'the centre has to hold contrast against a bright photograph'
  );
  // The periphery stays brighter than the centre: that is what keeps a photo vivid.
  const corner = stops.filter((alpha) => alpha <= 0.26).length;
  assert.ok(corner >= 3, 'the edges of the frame must not be muddied');
});

test('type is set with real OpenType features, not just a family name', () => {
  assert.match(css, /font-feature-settings:\s*"cv02", "cv03", "cv04", "cv11", "ss01"/);
  assert.match(css, /text-rendering:\s*optimizeLegibility/);
  assert.match(css, /-webkit-font-smoothing:\s*antialiased/);
  assert.match(css, /-moz-osx-font-smoothing:\s*grayscale/);
});

test('the ambient aura breathes on the compositor and stops when hidden', () => {
  const aura = cssRule('.wallpaper-container::before');
  assert.ok(aura, '.wallpaper-container::before is missing');
  assert.match(aura, /animation:\s*aura-breathe/, 'the aura breathes');
  assert.equal(
    (aura.match(/radial-gradient/g) || []).length,
    3,
    'halo, low bloom and edge vignette share one composited layer'
  );
  assert.match(css, /@keyframes aura-breathe/);
  // No `will-change` here: the animation promotes the layer only while it runs.
  assert.ok(!/will-change/.test(aura), 'the aura must not hold a GPU layer for the day');
  assert.match(
    css,
    /html\.is-suspended \.wallpaper-container::before\s*{[^}]*animation-play-state:\s*paused/,
    'a covered or paused desktop costs no frames'
  );
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(
    reduced,
    /\.wallpaper-container::before\s*{[^}]*animation:\s*none/,
    'reduced motion holds the aura still'
  );
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
