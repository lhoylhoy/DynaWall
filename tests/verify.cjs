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
    photoSync: true,
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
    photoSync: true,
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

test('the macOS host mirrors the curated collections and the photo actions', () => {
  const swift = fs.readFileSync(path.join(ROOT, 'macos', 'DynaWallApp.swift'), 'utf8');
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
