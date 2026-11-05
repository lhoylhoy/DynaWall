'use strict';

/**
 * DynaWall performance audit.
 *
 *   node tests/perf-audit.cjs                 # audit + write performance_audit_report.md
 *   node tests/perf-audit.cjs --no-report     # console only
 *   node tests/perf-audit.cjs --report out.md # choose the report path
 *
 * Where tests/verify.cjs asserts *behaviour*, this runner measures the cost of
 * that behaviour. A live wallpaper runs for weeks on a machine that is mostly
 * asleep, so the numbers that matter are wakeups per day, milliseconds per hot
 * routine, composited-vs-layout work, and retained bitmaps — not feature
 * coverage.
 *
 * Three kinds of output:
 *
 *   metrics    measurements (µs, ops/s, MB) collected into the report
 *   checks     invariants that must hold, mirroring verify.cjs (a failure here
 *              means the optimisation regressed, and the exit code is 1)
 *   findings   advisory issues with a severity and a concrete action; they do
 *              not fail the run
 *
 * Nothing is written outside the report path and nothing in the app is
 * modified: every benchmark drives the module's exported pure functions.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const DynaWall = require('../script.js');

const ROOT = path.join(__dirname, '..');

const argv = process.argv.slice(2);
const NO_REPORT = argv.includes('--no-report');
const REPORT_FLAG = argv.indexOf('--report');
const REPORT_PATH = path.resolve(
  ROOT,
  REPORT_FLAG !== -1 && argv[REPORT_FLAG + 1] ? argv[REPORT_FLAG + 1] : 'performance_audit_report.md'
);

/* -------------------------------------------------------------------------- *
 * Reporting harness (same shape as tests/verify.cjs, plus metrics & findings)
 * -------------------------------------------------------------------------- */

const report = {
  generatedAt: new Date(),
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  cpus: (os.cpus() || []).length,
  groups: [],
  metrics: [],
  benchmarks: [],
  checks: [],
  findings: []
};

let passed = 0;
const failures = [];
let currentGroup = 'General';

function group(name) {
  currentGroup = name;
  report.groups.push(name);
  console.log(`\n${name}`);
}

function note(text) {
  console.log(`    ${text}`);
}

/** Record one measurement for the report. */
function metric(label, value, detail) {
  report.metrics.push({ group: currentGroup, label, value, detail: detail || '' });
  return value;
}

function check(name, fn) {
  try {
    fn();
    passed += 1;
    report.checks.push({ group: currentGroup, name, ok: true });
    console.log(`  \u2713 ${name}`);
  } catch (error) {
    const message = String(error && error.message ? error.message : error);
    failures.push({ name, message });
    report.checks.push({ group: currentGroup, name, ok: false, message: message.split('\n')[0] });
    console.log(`  \u2717 ${name}`);
    console.log(`      ${message.split('\n')[0]}`);
  }
}

/** Advisory issue: never fails the run, always lands in the report. */
function finding(severity, title, evidence, action) {
  report.findings.push({ severity, title, evidence, action });
}

/* -------------------------------------------------------------------------- *
 * Formatting & filesystem helpers
 * -------------------------------------------------------------------------- */

function bytes(value) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = Number(value) || 0;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : size >= 100 ? 0 : 1;
  return `${size.toFixed(digits)} ${units[unit]}`;
}

function opsPerSecond(value) {
  if (!Number.isFinite(value) || value <= 0) return 'n/a';
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)} M ops/s`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)} k ops/s`;
  return `${Math.round(value)} ops/s`;
}

function micros(value) {
  if (!Number.isFinite(value)) return 'n/a';
  if (value < 1) return `${(value * 1000).toFixed(0)} ns`;
  if (value < 10) return `${value.toFixed(2)} µs`;
  if (value < 1000) return `${value.toFixed(1)} µs`;
  return `${(value / 1000).toFixed(2)} ms`;
}

function readText(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

function readBytes(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath));
}

function fileSize(relativePath) {
  try {
    return fs.statSync(path.join(ROOT, relativePath)).size;
  } catch (error) {
    return 0;
  }
}

/** Every regular file under `relativeDir`, recursively. */
function walk(relativeDir) {
  const out = [];
  const start = path.join(ROOT, relativeDir);
  if (!fs.existsSync(start)) return out;

  const visit = (absolute) => {
    let entries = [];
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch (error) {
      return;
    }
    entries.forEach((entry) => {
      const full = path.join(absolute, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        try {
          out.push({ absolute: full, relative: path.relative(ROOT, full), size: fs.statSync(full).size });
        } catch (error) {
          /* a file that vanished mid-walk is not worth a crash */
        }
      }
    });
  };

  visit(start);
  return out;
}

function totalSize(files) {
  return files.reduce((sum, file) => sum + file.size, 0);
}

/* -------------------------------------------------------------------------- *
 * Benchmark harness
 * -------------------------------------------------------------------------- */

/**
 * Time `spec.run` `spec.iterations` times, warm up first, and keep the
 * per-iteration samples so the report can quote p50/p95/p99 rather than only a
 * mean: one GC pause must not hide behind an average.
 */
function benchmark(name, spec) {
  const iterations = spec.iterations;
  const warmup = Math.min(iterations, Math.max(50, Math.floor(iterations / 20)));

  for (let index = 0; index < warmup; index += 1) spec.run(index);

  const samples = new Float64Array(iterations);
  const started = process.hrtime.bigint();
  for (let index = 0; index < iterations; index += 1) {
    const before = process.hrtime.bigint();
    spec.run(index);
    samples[index] = Number(process.hrtime.bigint() - before) / 1000; // µs
  }
  const elapsed = Number(process.hrtime.bigint() - started) / 1e9;

  const sorted = Float64Array.from(samples).sort();
  const at = (fraction) => {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
    return sorted[index];
  };
  const sum = samples.reduce((total, sample) => total + sample, 0);

  const result = {
    group: currentGroup,
    name,
    iterations,
    elapsedSeconds: elapsed,
    opsPerSecond: iterations / elapsed,
    meanUs: sum / iterations,
    p50Us: at(0.5),
    p95Us: at(0.95),
    p99Us: at(0.99),
    maxUs: sorted[sorted.length - 1]
  };
  report.benchmarks.push(result);
  console.log(
    `    ${name}\n      ${opsPerSecond(result.opsPerSecond)} · p50 ${micros(result.p50Us)} · ` +
      `p95 ${micros(result.p95Us)} · p99 ${micros(result.p99Us)} (${iterations.toLocaleString('en-US')} iterations)`
  );
  return result;
}

/* -------------------------------------------------------------------------- *
 * A very small CSS reader: enough to walk rules, @media and @keyframes
 * -------------------------------------------------------------------------- */

function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Flatten a stylesheet into `{ selector, body, context }` nodes.
 *
 * `context` holds the enclosing at-rules (`@media (max-width: 720px)`), which is
 * what lets the audit say "this rule lives inside reduced-motion" instead of
 * matching text blindly. `@keyframes` / `@font-face` blocks come back as nodes
 * of their own, with their inner text in `body`.
 */
function parseCss(source) {
  const text = stripCssComments(source);
  const nodes = [];
  const stack = [{ selector: '#root', path: [] }];
  let index = 0;
  let lineStart = 0;

  while (index < text.length) {
    const character = text[index];
    if (character === '{') {
      const selector = text.slice(lineStart, index).trim();
      const parent = stack[stack.length - 1];
      stack.push({
        selector,
        path: parent.path.concat([selector]),
        bodyStart: index + 1
      });
      index += 1;
      lineStart = index;
      continue;
    }
    if (character === '}') {
      const node = stack.pop();
      if (!node || node.selector === '#root') {
        index += 1;
        lineStart = index;
        continue;
      }
      const parent = stack[stack.length - 1];
      nodes.push({
        selector: node.selector,
        // `bodyStart` rather than `lineStart`: a @keyframes block closes after
        // its nested `from`/`to` blocks, and the animation is defined in those.
        body: text.slice(node.bodyStart, index).trim(),
        context: parent ? parent.path.slice() : []
      });
      index += 1;
      lineStart = index;
      continue;
    }
    index += 1;
  }

  return nodes;
}

/** Declarations of one rule body: `{ 'animation-play-state': 'paused', … }`. */
function declarations(body) {
  const out = {};
  let depth = 0;
  let start = 0;

  const flush = (end) => {
    const chunk = body.slice(start, end);
    const colon = chunk.indexOf(':');
    if (colon === -1) return;
    const property = chunk.slice(0, colon).trim().toLowerCase();
    const value = chunk.slice(colon + 1).replace(/\s+/g, ' ').trim();
    if (property && out[property] === undefined) out[property] = value;
  };

  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === '(' || character === '{') depth += 1;
    else if (character === ')' || character === '}') depth = Math.max(0, depth - 1);
    else if (character === ';' && depth === 0) {
      flush(index);
      start = index + 1;
    }
  }
  if (start < body.length) flush(body.length);
  return out;
}

/** Split a comma-separated CSS value list at the top level only. */
function splitTopLevel(value, separator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '(') depth += 1;
    else if (character === ')') depth = Math.max(0, depth - 1);
    else if (character === separator && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

/** Properties a `@keyframes` body actually animates. */
function animatedProperties(body) {
  const properties = new Set();
  const pattern = /([a-zA-Z-]+)\s*:/g;
  let match;
  while ((match = pattern.exec(body))) {
    const property = match[1].toLowerCase();
    if (property === 'from' || property === 'to') continue;
    properties.add(property);
  }
  return Array.from(properties);
}


/* -------------------------------------------------------------------------- *
 * Asset helpers
 * -------------------------------------------------------------------------- */

/**
 * Read the pixel dimensions out of a JPEG header (SOFn marker), which is what
 * decides how much RAM a decoded wallpaper costs: `width × height × 4` bytes
 * once the browser hands the bitmap to the compositor.
 */
function jpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    if (marker === 0xda) break; // start of scan: every header is behind us
    const length = buffer.readUInt16BE(offset + 2);
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += 2 + length;
  }
  return null;
}

/** Read the pixel dimensions out of a PNG header (IHDR), for the preview card. */
function pngDimensions(buffer) {
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

function gzipSize(relativePath) {
  try {
    return zlib.gzipSync(readBytes(relativePath), { level: 9 }).length;
  } catch (error) {
    return 0;
  }
}


/* -------------------------------------------------------------------------- *
 * 1. Timer & wakeup budget
 * -------------------------------------------------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Walk the one-shot clock timer across one local day and count the wakeups. */
function simulateClockDay(start) {
  let cursor = new Date(start.getTime());
  const end = cursor.getTime() + DAY_MS;
  const gaps = [];
  let guard = 0;
  let tail = 0;

  while (guard < 64) {
    const wait = DynaWall.msUntilNextClockBoundary(cursor);
    if (!(wait > 0)) break;
    const next = cursor.getTime() + wait;
    if (next >= end) {
      // The wakeup after the last boundary belongs to the next day: it is not
      // part of this one, but its sleep is what closes the 24 h window.
      tail = end - cursor.getTime();
      break;
    }
    gaps.push(wait);
    cursor = new Date(next);
    guard += 1;
  }

  const sleeps = tail > 0 ? gaps.concat([tail]) : gaps;
  return {
    wakeups: gaps.length,
    gaps,
    smallest: sleeps.length ? Math.min(...sleeps) : 0,
    largest: sleeps.length ? Math.max(...sleeps) : 0,
    total: gaps.reduce((sum, gap) => sum + gap, 0) + tail
  };
}

function auditTimers() {
  group('1. Timer & wakeup budget (24 h simulation)');

  // A fixed local Monday: the boundary maths is calendar-based, so this is
  // reproducible on any machine (and DST-free in most zones).
  const day = simulateClockDay(new Date(2026, 0, 5, 0, 0, 0, 0));
  const poll30s = Math.round(DAY_MS / DynaWall.CLOCK_REFRESH_MS);
  const poll60s = Math.round(DAY_MS / 60000);

  metric('Clock wakeups per 24 h (one-shot timer)', day.wakeups, 'msUntilNextClockBoundary()');
  metric('Clock wakeups per 24 h (30 s poll, previous design)', poll30s);
  metric('Clock wakeups per 24 h (60 s poll)', poll60s);
  metric('Wakeup reduction vs 30 s polling', `${Math.round(poll30s / Math.max(1, day.wakeups))}×`);
  metric('Shortest sleep inside the day', micros(day.smallest));
  metric('Longest sleep inside the day', micros(day.largest), '21:00 → midnight is the last one; the 8 h overnight sleep is clipped to the day');

  note(
    `one-shot clock timer: ${day.wakeups} wakeups/day ` +
      `(shortest ${micros(day.smallest)}, longest ${micros(day.largest)})`
  );
  note(`30 s polling would cost ${poll30s}/day; 60 s polling ${poll60s}/day`);

  check('the clock costs exactly six wakeups a day', () => {
    if (day.wakeups !== DynaWall.CLOCK_BOUNDARY_HOURS.length) {
      throw new Error(`expected ${DynaWall.CLOCK_BOUNDARY_HOURS.length}, measured ${day.wakeups}`);
    }
  });

  check('the simulated day is covered end to end (no boundary skipped)', () => {
    if (Math.abs(day.total - DAY_MS) > 1000) {
      throw new Error(`gaps sum to ${day.total} ms, expected ${DAY_MS} ms`);
    }
  });

  check('no boundary sleep is zero or negative', () => {
    if (day.gaps.some((gap) => !(gap > 0))) throw new Error('a boundary armed a zero-delay timer');
  });

  check('a suspended page arms no clock timer at all', () => {
    const script = readText('script.js');
    const start = script.indexOf('function scheduleClock(');
    if (start === -1) throw new Error('scheduleClock() is missing');
    const body = script.slice(start, script.indexOf('\n    }', start));
    if (!/if \(state\.suspended\) return;/.test(body)) {
      throw new Error('scheduleClock() must bail out while suspended');
    }
    if (!/msUntilNextClockBoundary\(\)/.test(body)) {
      throw new Error('scheduleClock() must sleep to the next boundary');
    }
  });

  // The slideshow is the only other recurring timer: off by default, and one
  // re-armed setTimeout per slide rather than a repeating interval.
  const slideshow = [1, 5, 15, 60].map((minutes) => ({
    minutes,
    wakeups: Math.round(DAY_MS / (minutes * 60000))
  }));
  metric(
    'Slideshow wakeups per 24 h (off by default)',
    '0 while `slideshow: false`',
    slideshow.map((row) => `${row.minutes} min → ${row.wakeups}/day`).join(' · ')
  );
  note(
    'slideshow, when enabled: ' +
      slideshow.map((row) => `${row.minutes} min → ${row.wakeups}/day`).join(', ')
  );

  check('the slideshow is a one-shot chain, never setInterval', () => {
    const script = readText('script.js');
    const intervalsFound = script.match(/\bsetInterval\s*\(/g) || [];
    if (intervalsFound.length !== 0) {
      throw new Error(`${intervalsFound.length} setInterval call(s) — every loop must re-arm a timeout`);
    }
    const schedule = script.indexOf('function scheduleSlide(');
    if (schedule === -1) throw new Error('scheduleSlide() is missing');
    const body = script.slice(schedule, script.indexOf('\n    }', schedule));
    if (!/state\.photoTimer = win\.setTimeout\(advancePhoto, wait\)/.test(body)) {
      throw new Error('scheduleSlide() must arm a single one-shot timer');
    }
    if (!/state\.suspended/.test(body)) {
      throw new Error('an occluded desktop must not keep rotating photos');
    }
  });

  check('parking the wallpaper clears both timers', () => {
    const script = readText('script.js');
    const start = script.indexOf('function applySuspension(');
    if (start === -1) throw new Error('applySuspension() is missing');
    const body = script.slice(start, script.indexOf('\n    }', start));
    if (!/clearTimeout\(state\.clockTimer\)/.test(body) || !/clearTimeout\(state\.photoTimer\)/.test(body)) {
      throw new Error('suspension must clear the clock and slideshow timers');
    }
    if (!/classList\.add\('is-suspended'\)/.test(body)) {
      throw new Error('suspension must put `is-suspended` on <html> so CSS pauses the drift');
    }
    if (!/scheduleClock\(\)/.test(body)) throw new Error('resume must re-arm the clock');
  });
}


/* -------------------------------------------------------------------------- *
 * 2. Hot-routine micro-benchmarks
 * -------------------------------------------------------------------------- */

/** The pre-optimisation de-duplication: `indexOf()` per entry, O(N²). */
function dedupeQuadratic(list) {
  const photos = [];
  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index];
    if (typeof entry !== 'string') continue;
    const url = entry.trim();
    if (!url || /\s/.test(url) || /^javascript:/i.test(url)) continue;
    if (photos.indexOf(url) !== -1) continue;
    photos.push(url);
    if (photos.length >= 500) break;
  }
  return photos;
}

/** A realistic 500-photo folder: unique, spaced paths, no hostile entries. */
function realisticPhotoList(count) {
  const list = [];
  for (let index = 0; index < count; index += 1) {
    const band = ['dawn', 'day', 'dusk', 'night'][index % 4];
    list.push(`dynawall-photo://photo/${index}/${band}-wallpaper-${index}.jpg`);
  }
  return list;
}

function auditBenchmarks() {
  group('2. Hot-routine micro-benchmarks');

  const warmPhotos = DynaWall.BUNDLED_PHOTOS.slice();
  DynaWall.classifyPhotos(warmPhotos); // prime the WeakMap before timing

  const cold = benchmark('classifyPhotos() — cold cache, 12 bundled photos', {
    iterations: 10000,
    run: () => DynaWall.classifyPhotos(DynaWall.BUNDLED_PHOTOS.slice())
  });

  const warm = benchmark('classifyPhotos() — warm cache (WeakMap hit)', {
    iterations: 10000,
    run: () => DynaWall.classifyPhotos(warmPhotos)
  });

  benchmark('getPhotosForSlot() — band lookup + fallbacks', {
    iterations: 10000,
    run: () => DynaWall.getPhotosForSlot(warmPhotos, 'dusk')
  });

  benchmark('stepPhotoIndex() — next slide, shuffled', {
    // A real RNG, not a constant: a fixed pick could land on the current photo
    // forever, which is a property of this call and not of the app.
    iterations: 10000,
    run: (index) => DynaWall.stepPhotoIndex(12, index % 12, true, Math.random)
  });

  const folder = realisticPhotoList(500);
  const linear = benchmark('normalizePhotos() — 500-entry folder, Set de-duplication', {
    iterations: 5000,
    run: () => DynaWall.normalizePhotos(folder)
  });

  const quadratic = benchmark('normalizePhotos() — 500-entry folder, quadratic emulation', {
    iterations: 1000,
    run: () => dedupeQuadratic(folder)
  });

  const layers = {
    ipc: { firstName: 'Ada', slideshow: true, widgets: false },
    seed: { subtitle: 'Shipping the wallpaper', theme: 'dusk', slideshowInterval: 5 },
    url: { name: 'Grace', bgColor: '#0b0f19', kenBurns: false },
    storage: { photoSync: false, fontFamily: 'Geist', slideshowShuffle: false },
    defaults: DynaWall.DEFAULT_CONFIG
  };

  benchmark('resolveConfig() — five layers, 13 fields', {
    iterations: 10000,
    run: () => DynaWall.resolveConfig(layers)
  });

  const sampleDate = new Date(2026, 2, 14, 15, 41, 22);
  benchmark('getThemeSlot() — palette band', {
    iterations: 10000,
    run: () => DynaWall.getThemeSlot(sampleDate)
  });

  benchmark('getGreetingPeriod() — greeting band', {
    iterations: 10000,
    run: () => DynaWall.getGreetingPeriod(sampleDate)
  });

  benchmark('msUntilNextClockBoundary() — one-shot timer maths', {
    iterations: 10000,
    run: () => DynaWall.msUntilNextClockBoundary(sampleDate)
  });

  benchmark('scatterWidgets() — 4 satellites on a 3840×2160 desktop', {
    iterations: 5000,
    run: () =>
      DynaWall.scatterWidgets({
        width: 3840,
        height: 2160,
        size: 28,
        count: 4,
        margin: 90,
        gap: 26,
        clearance: 190,
        reach: 230,
        seed: 20260105
      })
  });

  // What one render() actually costs on the coldest path: resolve the five
  // layers, classify a fresh array and pick the band's photos.
  const renderPath = benchmark('render() hot path — resolveConfig + cold classify + slot', {
    iterations: 2000,
    run: () =>
      DynaWall.getPhotosForSlot(
        DynaWall.classifyPhotos(DynaWall.resolveConfig(layers).photos.concat(DynaWall.BUNDLED_PHOTOS)),
        'day'
      )
  });

  // A shortcut has to find its mark on every render, so the catalogue lookup is on the hot
  // path too — and the pack made it five hundred marks wide. The worst case is a title that
  // matches nothing, because that is the lookup that has to look at everything it can.
  const iconLookup = benchmark('serviceIconId() — one lookup in a 500-mark catalogue', {
    iterations: 2000,
    run: () => DynaWall.serviceIconId('Something Unmatched', 'https://example.com/notes')
  });

  metric('classifyPhotos() speed-up from the WeakMap cache', `${(cold.meanUs / warm.meanUs).toFixed(1)}×`);
  metric(
    'normalizePhotos() speed-up over the quadratic path (500 entries)',
    `${(quadratic.meanUs / linear.meanUs).toFixed(1)}×`
  );
  metric('render() hot path, p95', micros(renderPath.p95Us));
  metric('serviceIconId(), p95', micros(iconLookup.p95Us));

  note(`classification cache pays for itself: ${(cold.meanUs / warm.meanUs).toFixed(1)}× faster warm`);
  note(`linear de-duplication beats the quadratic path: ${(quadratic.meanUs / linear.meanUs).toFixed(1)}×`);

  check('the classification cache pays for itself (warm at least 1.5× faster)', () => {
    const ratio = cold.meanUs / warm.meanUs;
    if (!(ratio >= 1.5)) throw new Error(`cold ${micros(cold.meanUs)} vs warm ${micros(warm.meanUs)}`);
  });

  check('normalizePhotos() de-duplicates in linear time, not quadratically', () => {
    if (!(linear.opsPerSecond > quadratic.opsPerSecond * 1.2)) {
      throw new Error(
        `Set path ${opsPerSecond(linear.opsPerSecond)} vs quadratic ${opsPerSecond(quadratic.opsPerSecond)}`
      );
    }
  });

  check('a full render path costs well under one frame (p95 < 1 ms)', () => {
    if (!(renderPath.p95Us < 1000)) throw new Error(`p95 ${micros(renderPath.p95Us)}`);
  });

  check('a catalogue lookup is far below a frame even at five hundred marks (p95 < 250 µs)', () => {
    if (!(iconLookup.p95Us < 250)) throw new Error(`p95 ${micros(iconLookup.p95Us)}`);
  });

  check('no hot routine is slower than the frame budget it lives in', () => {
    const budget = 1000; // µs: a 60 Hz frame
    const offenders = report.benchmarks.filter((row) => row.p95Us > budget);
    if (offenders.length) {
      throw new Error(offenders.map((row) => `${row.name} p95 ${micros(row.p95Us)}`).join('; '));
    }
  });
}


/* -------------------------------------------------------------------------- *
 * 3. Compositor & style invariants
 * -------------------------------------------------------------------------- */

/** Properties whose animation or transition the compositor can run alone. */
const COMPOSITED_PROPERTIES = new Set(['transform', 'opacity', 'filter', 'scale', 'rotate', 'translate']);

/** Properties that force layout: a transition on any of these reflows per frame. */
const LAYOUT_PROPERTIES = new Set([
  'all',
  'width',
  'min-width',
  'max-width',
  'height',
  'min-height',
  'max-height',
  'inline-size',
  'block-size',
  'top',
  'left',
  'right',
  'bottom',
  'inset',
  'inset-block',
  'inset-inline',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border-width',
  'border-radius',
  'font-size',
  'line-height',
  'letter-spacing',
  'word-spacing',
  'gap',
  'row-gap',
  'column-gap',
  'flex-basis',
  'flex-grow',
  'flex-shrink',
  'grid-template-columns',
  'grid-template-rows'
]);

/**
 * Infinite animations that are deliberately allowed to keep running while the
 * wallpaper is suspended. The apps card has no spinner left — an app is a link,
 * not a request — so the list is empty, and it stays a list so a future exception
 * has to be declared here instead of slipping through.
 */
const SUSPENSION_EXCEPTIONS = new Set();

function isTimingToken(token) {
  const value = String(token || '').toLowerCase();
  if (!value) return false;
  if (/^-?[\d.]+m?s$/.test(value)) return true;
  if (/^(cubic-bezier|steps|linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end)(\(|$)/.test(value)) {
    return true;
  }
  if (/^var\(--ease|^var\(--.*duration/.test(value)) return true;
  return false;
}

/** `transform`, `opacity`, … from every `transition`/`transition-property` rule. */
function transitionedProperties(nodes) {
  const entries = [];
  nodes.forEach((node) => {
    if (node.selector.startsWith('@')) return;
    const decls = declarations(node.body);
    const value = decls['transition'] || decls['transition-property'];
    if (!value || value === 'none') return;
    splitTopLevel(value, ',').forEach((part) => {
      const tokens = part.split(/\s+/).filter(Boolean);
      if (!tokens.length) return;
      const first = tokens[0];
      const property = isTimingToken(first) ? 'all' : first.toLowerCase();
      entries.push({ selector: node.selector, property, value: part, context: node.context });
    });
  });
  return entries;
}

/** Every `animation`/`animation-name` reference to a `@keyframes` rule. */
function animationUses(nodes, keyframeNames) {
  const uses = [];
  nodes.forEach((node) => {
    if (node.selector.startsWith('@')) return;
    const decls = declarations(node.body);
    const value = decls['animation'] || decls['animation-name'];
    if (!value || value === 'none') return;
    splitTopLevel(value, ',').forEach((part) => {
      const tokens = part.split(/\s+/).filter(Boolean);
      const name = tokens.find((token) => keyframeNames.has(token));
      if (!name) return;
      uses.push({
        name,
        selector: node.selector,
        infinite: tokens.indexOf('infinite') !== -1,
        value: part,
        context: node.context
      });
    });
  });
  return uses;
}

function selectorMatches(node, baseSelector) {
  return node.selector
    .split(',')
    .map((part) => part.trim())
    .some((part) => part === baseSelector || part.endsWith(` ${baseSelector}`));
}

function pausedWhenSuspended(nodes, baseSelector) {
  return nodes.some((node) => {
    if (!node.selector.includes('is-suspended')) return false;
    if (!selectorMatches(node, baseSelector)) return false;
    const decls = declarations(node.body);
    return decls['animation-play-state'] === 'paused' || /paused/.test(decls['animation'] || '');
  });
}

function disabledByReducedMotion(nodes, baseSelector) {
  return nodes.some((node) => {
    if (!node.context.some((context) => context.includes('prefers-reduced-motion'))) return false;
    if (!selectorMatches(node, baseSelector)) return false;
    const decls = declarations(node.body);
    return decls['animation'] === 'none' || decls['animation-name'] === 'none';
  });
}

function findRules(nodes, selector) {
  const candidates = nodes.filter((node) => !node.selector.startsWith('@'));
  // An exact selector first: `.photo-stack` must not resolve to
  // `html.is-theme-ready body, html.is-theme-ready .photo-stack`.
  const exact = candidates.filter(
    (node) => node.selector.replace(/\s+/g, ' ') === selector
  );
  if (exact.length) return exact;
  return candidates.filter((node) => selectorMatches(node, selector));
}


function auditCompositor() {
  group('3. Compositor & style invariants');

  const css = readText('style.css');
  const nodes = parseCss(css);
  const keyframes = nodes.filter((node) => node.selector.startsWith('@keyframes'));
  const keyframeNames = new Set(
    keyframes.map((node) => node.selector.replace(/^@keyframes\s+/, '').trim())
  );

  const keyframeRows = keyframes.map((node) => {
    const name = node.selector.replace(/^@keyframes\s+/, '').trim();
    return { name, properties: animatedProperties(node.body) };
  });

  keyframeRows.forEach((row) => {
    metric(`@keyframes ${row.name}`, row.properties.join(', '));
  });

  check('every @keyframes animation touches only composited properties', () => {
    if (!keyframeRows.length) throw new Error('no @keyframes found in style.css');
    const offenders = keyframeRows.filter((row) =>
      row.properties.some((property) => !COMPOSITED_PROPERTIES.has(property))
    );
    if (offenders.length) {
      throw new Error(
        offenders.map((row) => `${row.name} animates ${row.properties.join(', ')}`).join('; ')
      );
    }
  });

  const transitions = transitionedProperties(nodes);
  const layoutTransitions = transitions.filter((entry) => LAYOUT_PROPERTIES.has(entry.property));
  const distinctTransitions = Array.from(new Set(transitions.map((entry) => entry.property))).sort();

  metric('Transitioned properties', distinctTransitions.join(', '), `${transitions.length} declarations`);
  metric('Transitions on layout properties', String(layoutTransitions.length));
  note(`transitioned properties: ${distinctTransitions.join(', ')}`);

  check('no transition animates a layout property', () => {
    if (layoutTransitions.length) {
      throw new Error(layoutTransitions.map((entry) => `${entry.selector} → ${entry.property}`).join('; '));
    }
  });

  check('no rule transitions `all`', () => {
    const universal = transitions.filter((entry) => entry.property === 'all');
    if (universal.length) throw new Error(universal.map((entry) => entry.selector).join('; '));
  });

  const uses = animationUses(nodes, keyframeNames);
  const infinite = uses.filter((use) => use.infinite);
  metric('Animations declared (CSS)', String(uses.length), uses.map((use) => `${use.name} → ${use.selector}`).join(' · '));
  metric(
    'Infinite animations declared',
    String(infinite.length),
    infinite.map((use) => `${use.name} on ${use.selector}`).join(' · ')
  );
  note(
    `animations: ${uses
      .map((use) => `${use.name} → ${use.selector}${use.infinite ? ' (infinite)' : ''}`)
      .join(', ')}`
  );

  check('every desktop animation pauses while suspended', () => {
    if (!uses.length) throw new Error('no animation found — did the parser stop early?');
    const unpaused = uses.filter(
      (use) => !SUSPENSION_EXCEPTIONS.has(use.selector) && !pausedWhenSuspended(nodes, use.selector)
    );
    if (unpaused.length) {
      throw new Error(
        unpaused.map((use) => `${use.name} on ${use.selector} has no animation-play-state: paused`).join('; ')
      );
    }
  });

  uses
    .filter((use) => SUSPENSION_EXCEPTIONS.has(use.selector) && !pausedWhenSuspended(nodes, use.selector))
    .forEach((use) => {
      finding(
        'Low',
        `${use.name} keeps running while the wallpaper is suspended`,
        `${use.selector} declares \`animation: ${use.value}\` and no \`html.is-suspended\` rule pauses it. ` +
          'A spinner only exists inside an open card, so the cost is bounded — but its timeline still ' +
          'advances while the display is asleep or the session is locked.',
        `Add \`html.is-suspended ${use.selector} { animation-play-state: paused; }\` beside the other ` +
          'suspension rules in style.css.'
      );
    });

  check('reduced motion holds every desktop animation still', () => {
    const moving = uses.filter(
      (use) => !SUSPENSION_EXCEPTIONS.has(use.selector) && !disabledByReducedMotion(nodes, use.selector)
    );
    if (moving.length) throw new Error(moving.map((use) => use.selector).join('; '));
  });

  check('the entrance promotes its layer, then hands it back', () => {
    const base = findRules(nodes, '.wallpaper-content')[0];
    if (!base) throw new Error('.wallpaper-content is missing');
    const hint = declarations(base.body)['will-change'];
    if (hint === undefined || !/opacity/.test(hint) || !/transform/.test(hint)) {
      throw new Error(
        `the entrance fade needs will-change while it runs (rule "${base.selector.replace(/\s+/g, ' ')}" has ${JSON.stringify(hint)})`
      );
    }
    const settled = findRules(nodes, '.wallpaper-content.is-loaded')[0];
    if (!settled) throw new Error('.wallpaper-content.is-loaded is missing');
    if (declarations(settled.body)['will-change'] !== 'auto') {
      throw new Error('a settled wallpaper must drop its GPU layer (will-change: auto)');
    }
  });

  check('a photo is promoted only while it is the visible slide', () => {
    const photo = findRules(nodes, '.photo')[0];
    if (!photo) throw new Error('.photo is missing');
    if (declarations(photo.body)['will-change'] !== undefined) {
      throw new Error('the base .photo rule must not hold a compositing layer');
    }
    const promoted = findRules(nodes, 'body.has-photo .photo.is-visible')[0];
    if (!promoted) throw new Error('body.has-photo .photo.is-visible is missing');
    if (!/opacity/.test(declarations(promoted.body)['will-change'] || '')) {
      throw new Error('the visible slide must be promoted while it fades and drifts');
    }
  });

  const willChangeCount = nodes.filter(
    (node) => !node.selector.startsWith('@') && declarations(node.body)['will-change'] !== undefined
  ).length;
  metric('will-change declarations', String(willChangeCount), 'promotion is scoped, never permanent');

  check('will-change is scoped rather than sprinkled', () => {
    if (willChangeCount > 4) {
      throw new Error(`${willChangeCount} will-change declarations — each one retains a GPU texture`);
    }
  });

  check('the photo stack isolates its own paint and layout', () => {
    const stack = findRules(nodes, '.photo-stack')[0];
    if (!stack) throw new Error('.photo-stack is missing');
    const contain = declarations(stack.body)['contain'] || '';
    if (!/layout/.test(contain) || !/paint/.test(contain)) {
      throw new Error(`.photo-stack must contain layout and paint, found "${contain || 'nothing'}"`);
    }
    const photo = findRules(nodes, '.photo')[0];
    if (declarations(photo.body)['backface-visibility'] !== 'hidden') {
      throw new Error('.photo keeps backface-visibility: hidden so a layer is not re-rasterised');
    }
  });

  check('suspension is expressed in CSS for every desktop layer', () => {
    const pausedRules = nodes.filter((node) => {
      if (!node.selector.includes('is-suspended')) return false;
      return declarations(node.body)['animation-play-state'] === 'paused';
    });
    if (pausedRules.length < 3) {
      throw new Error(`only ${pausedRules.length} suspension rule(s) found`);
    }
    metric('Suspension rules in style.css', String(pausedRules.length));
  });

  const paintTransitions = transitions.filter(
    (entry) => !COMPOSITED_PROPERTIES.has(entry.property) && !LAYOUT_PROPERTIES.has(entry.property)
  );
  if (paintTransitions.length) {
    metric(
      'Paint-only transitions (band changes, not per frame)',
      Array.from(new Set(paintTransitions.map((entry) => entry.property))).join(', ')
    );
  }
}


/* -------------------------------------------------------------------------- *
 * 4. Memory & texture lifecycle
 * -------------------------------------------------------------------------- */

/** Body of a top-level function in script.js (module indentation is two spaces). */
function functionBody(source, signature, closingIndent) {
  const start = source.indexOf(signature);
  if (start === -1) return '';
  const end = source.indexOf(closingIndent, start);
  return end === -1 ? source.slice(start) : source.slice(start, end);
}

function auditMemory() {
  group('4. Memory & texture lifecycle');

  const script = readText('script.js');

  const release = functionBody(script, 'function releasePhotoTexture(', '\n    }');
  const paint = functionBody(script, 'function paintPhoto(', '\n    }');
  const registerFont = functionBody(script, 'function registerCustomFont(', '\n    }');
  const clearPhotos = functionBody(script, 'function clearPhotos(', '\n    }');

  metric(
    'Photo layers held by the DOM',
    '2',
    'both reuse a single <img>; the outgoing bitmap is dropped after the fade'
  );

  check('the outgoing slide is released after the cross-fade', () => {
    if (!release) throw new Error('releasePhotoTexture() is missing');
    if (!/PHOTO_FADE_MS/.test(release)) throw new Error('the bitmap must be held for exactly the fade');
    if (!/removeAttribute\('src'\)/.test(release)) {
      throw new Error('clearing `src` is what hands the decoded bitmap back');
    }
    if (!/is-visible/.test(release)) {
      throw new Error('a layer that faded back in must not be emptied');
    }
    if (!/photoToken/.test(release)) throw new Error('a stale release must be a no-op');
  });

  check('painting recycles the previous layer instead of allocating a new one', () => {
    if (!paint) throw new Error('paintPhoto() is missing');
    if (!/releasePhotoTexture\(previous\)/.test(paint)) throw new Error('the outgoing layer is not released');
    if (!/photoLayers\[/.test(paint)) throw new Error('the slideshow must reuse the two existing layers');
  });

  check('a slideshow that is switched off drops both bitmaps', () => {
    if (!clearPhotos) throw new Error('clearPhotos() is missing');
    if (!/removeAttribute\('src'\)/.test(clearPhotos)) throw new Error('clearPhotos() must clear `src`');
    if (!/onerror = null/.test(clearPhotos)) throw new Error('the per-photo error handler must be detached');
  });

  check('an imported font is removed from `document.fonts` when replaced', () => {
    if (!registerFont) throw new Error('registerCustomFont() is missing');
    if (!/fonts\.delete\(state\.customFontFace\)/.test(registerFont)) {
      throw new Error('the previous FontFace must be deleted, not just forgotten');
    }
    if (!/state\.customFontFace = null/.test(registerFont)) {
      throw new Error('the reference has to be dropped as well, or the face stays reachable');
    }
  });

  check('the at-document-start seed does not sit in the heap for the session', () => {
    if (!/delete window\.__dynawallSeed/.test(script)) {
      throw new Error('bootstrap() must delete the seed after folding it into the configuration');
    }
  });

  check('classification is cached in a WeakMap, not a growing Map', () => {
    if (!/const classifyCache = new WeakMap\(\)/.test(script)) {
      throw new Error('classifyCache must be a WeakMap so a dropped photo list is collectable');
    }
  });

  // What the two layers actually cost once decoded. Decoding is the dominant
  // RAM cost of a 5K wallpaper, so it is measured rather than estimated from
  // the file size (a 1.5 MB JPEG is a ~56 MB RGBA bitmap on screen).
  const textures = DynaWall.BUNDLED_PHOTOS.map((photo) => {
    const disk = fileSize(photo);
    let dimensions = null;
    try {
      dimensions = jpegDimensions(readBytes(photo));
    } catch (error) {
      dimensions = null;
    }
    const decoded = dimensions ? dimensions.width * dimensions.height * 4 : 0;
    return {
      photo: photo.replace(/^images\//, ''),
      disk,
      width: dimensions ? dimensions.width : 0,
      height: dimensions ? dimensions.height : 0,
      decoded
    };
  }).sort((first, second) => second.decoded - first.decoded);

  const largest = textures[0];
  const peakTwo = textures[0].decoded + textures[1].decoded;
  const diskTotal = textures.reduce((sum, row) => sum + row.disk, 0);

  textures.forEach((row) => {
    metric(
      `Curated photo · ${row.photo}`,
      row.width ? `${row.width}×${row.height} → ${bytes(row.decoded)} decoded` : 'dimensions unknown',
      bytes(row.disk)
    );
  });

  metric('Worst-case decoded textures (two layers cross-fading)', bytes(peakTwo));
  metric('Curated wallpapers on disk', bytes(diskTotal), `${textures.length} files`);
  note(`largest curated photo: ${largest.width}×${largest.height} → ${bytes(largest.decoded)} decoded`);
  note(`two layers cross-fading: ${bytes(peakTwo)} of RGBA textures`);

  check('a cross-fade never holds more than two decoded wallpapers', () => {
    if (peakTwo > 256 * 1024 * 1024) {
      throw new Error(`${bytes(peakTwo)} is beyond any reasonable wallpaper budget`);
    }
  });

  if (largest.decoded > 32 * 1024 * 1024) {
    finding(
      'Best practice',
      `Each 5K wallpaper costs ${bytes(largest.decoded)} of decoded RGBA memory`,
      `The largest curated picture is ${largest.width}×${largest.height} (${bytes(largest.disk)} on disk). ` +
        `The two-layer cross-fade therefore peaks at ${bytes(peakTwo)}, and every display repeats that ` +
        'cost on its own WebView. A 4K display cannot show more than 3840 px of it.',
      'If low-memory machines ever matter, ship a 3840-wide variant for the 5K six (≈45% fewer bytes per ' +
        'texture) and keep the full-resolution originals for the native preview card, which already ' +
        'decodes a bounded thumbnail.'
    );
  }
}


/* -------------------------------------------------------------------------- *
 * 5. Asset & distribution footprint
 * -------------------------------------------------------------------------- */

const CSP_META = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"\s*\/?>/;

function contentSecurityPolicy() {
  const match = CSP_META.exec(readText('index.html'));
  if (!match) return null;
  const directives = new Map();
  match[1].split(';').forEach((chunk) => {
    const parts = chunk.trim().split(/\s+/).filter(Boolean);
    if (parts.length) directives.set(parts[0], parts.slice(1));
  });
  return directives;
}

function auditAssets() {
  group('5. Asset & distribution footprint');

  const imageFiles = walk('images');
  const imageTotal = totalSize(imageFiles);
  const curatedNames = new Set(DynaWall.BUNDLED_PHOTOS.map((photo) => photo.replace(/^images\//, '')));
  const curatedFiles = imageFiles.filter((file) => curatedNames.has(path.basename(file.relative)));
  const unusedFiles = imageFiles.filter((file) => !curatedNames.has(path.basename(file.relative)));
  const curatedTotal = totalSize(curatedFiles);
  const unusedTotal = totalSize(unusedFiles);

  metric('Repository `images/` folder', bytes(imageTotal), `${imageFiles.length} files`);
  metric('Curated wallpapers that rotate', bytes(curatedTotal), `${curatedFiles.length} of ${imageFiles.length}`);
  metric(
    'Unused image duplicates in `images/`',
    bytes(unusedTotal),
    `${unusedFiles.length} files — ${Math.round((unusedTotal / Math.max(1, imageTotal)) * 100)}% of the folder`
  );
  note(`curated ${bytes(curatedTotal)} · unused duplicates ${bytes(unusedTotal)} in ${unusedFiles.length} files`);

  check('every curated wallpaper is present on disk', () => {
    if (curatedFiles.length !== DynaWall.BUNDLED_PHOTOS.length) {
      throw new Error(`${curatedFiles.length}/${DynaWall.BUNDLED_PHOTOS.length} curated pictures found`);
    }
  });

  if (unusedTotal > 0) {
    const examples = unusedFiles
      .slice()
      .sort((first, second) => second.size - first.size)
      .slice(0, 4)
      .map((file) => `${path.basename(file.relative)} (${bytes(file.size)})`)
      .join(', ');
    finding(
      'Medium',
      `${bytes(unusedTotal)} of wallpapers that no collection rotates through`,
      `\`images/\` holds ${imageFiles.length} files but only the ${curatedFiles.length} curated ones are ` +
        `ever shown. The other ${unusedFiles.length} are 4K/HEIC/Light-Dark duplicates of the same six ` +
        `Golden Gate scenes (largest: ${examples}). build-macos.sh already keeps them out of the app ` +
        'bundle and the Windows resources, but they still travel in the repository, in the ' +
        'Lively/Wallpaper Engine zips and in every `git clone`.',
      'Move them to a folder that is not shipped (e.g. `media/source/`) or delete them; the curated six ' +
        'are already 5K and nothing the wallpaper draws needs the duplicates.'
    );
  }

  const fontFiles = walk('assets/fonts');
  const woff2 = fontFiles.filter((file) => file.relative.endsWith('.woff2'));
  const ttf = fontFiles.filter((file) => file.relative.endsWith('.ttf'));
  const licences = fontFiles.filter((file) => /OFL|LICEN[CS]E/i.test(file.relative));

  metric('Webfonts the page loads (WOFF2)', bytes(totalSize(woff2)), `${woff2.length} faces, latin subsets`);
  metric(
    'Static TTFs for the host preview cards',
    bytes(totalSize(ttf)),
    `${ttf.length} faces — never parsed by the wallpaper page`
  );
  metric('Font licences', bytes(totalSize(licences)), `${licences.length} files`);
  note(`fonts: ${bytes(totalSize(woff2))} loaded · ${bytes(totalSize(ttf))} TTFs for the native cards`);

  const css = readText('style.css');
  const fontFaceSources = css.match(/src:\s*url\("([^"]+)"\)/g) || [];
  check('the page loads only WOFF2 faces (`@font-face`)', () => {
    if (!fontFaceSources.length) throw new Error('no @font-face source found');
    const nonWoff2 = fontFaceSources.filter((source) => !/\.woff2/.test(source));
    if (nonWoff2.length) throw new Error(nonWoff2.join(', '));
  });

  const pageFiles = ['index.html', 'style.css', 'script.js'].concat(
    woff2.map((file) => file.relative).filter((file) => css.indexOf(path.basename(file)) !== -1)
  );
  const onDisk = pageFiles.reduce((sum, file) => sum + fileSize(file), 0);
  const deflated = pageFiles.reduce((sum, file) => sum + gzipSize(file), 0);
  metric('Page payload on disk', bytes(onDisk), pageFiles.join(' + '));
  metric('Page payload deflated (packaging only)', bytes(deflated));
  metric('script.js', bytes(fileSize('script.js')), `${readText('script.js').split('\n').length.toLocaleString('en-US')} lines`);
  metric('style.css', bytes(fileSize('style.css')), `${readText('style.css').split('\n').length.toLocaleString('en-US')} lines`);
  note(`page payload: ${bytes(onDisk)} on disk (${bytes(deflated)} deflated)`);

  const thumbnailFile = readBytes('thumbnail.png');
  const thumbnail = thumbnailFile.length;
  if (thumbnail > 0) {
    const card = pngDimensions(thumbnailFile);
    const cardLabel = card ? `${card.width}×${card.height} · ` : '';
    metric(
      'Host preview card (`thumbnail.png`)',
      bytes(thumbnail),
      `${cardLabel}read by Lively and Wallpaper Engine, never by the page`
    );
    if (thumbnail > 512 * 1024) {
      const pixels = card ? card.width * card.height : 0;
      const density = pixels ? (thumbnail / pixels).toFixed(2) : null;
      finding(
        'Low',
        `The Lively / Wallpaper Engine preview card is ${bytes(thumbnail)}`,
        `thumbnail.png is a ${card ? `${card.width}×${card.height} ` : ''}PNG photograph referenced by LivelyInfo.json and project.json. ` +
          `PNG is lossless, so it carries ${density ? `${density} bytes per pixel` : 'the whole frame'} where a JPEG of the same ` +
          `frame lands near ${bytes(Math.round(thumbnail / 8))}. Both hosts draw it at thumbnail size and it ships in every Lively/WE zip.`,
        'Re-export it as a ~600×340 JPEG (≈60 KB); nothing in the wallpaper itself reads it.'
      );
    }
  }

  const directives = contentSecurityPolicy();
  check('the page delivers a Content Security Policy', () => {
    if (!directives) throw new Error('no CSP meta tag in index.html');
  });

  if (directives) {
    const defaultSrc = (directives.get('default-src') || []).join(' ');
    const connectSrc = (directives.get('connect-src') || []).filter((source) => source !== "'self'");
    metric('Network endpoints the page may reach', connectSrc.join(', ') || 'none');

    check('the page can reach nothing by default', () => {
      if (defaultSrc !== "'none'") throw new Error(`default-src is "${defaultSrc}"`);
    });

    check('the page cannot reach any network host at all', () => {
      if (connectSrc.length) throw new Error(connectSrc.join(', '));
    });

    check('no page script is allowed to eval', () => {
      const scriptSrc = (directives.get('script-src') || []).join(' ');
      if (/'unsafe-eval'/.test(scriptSrc)) throw new Error(`script-src is "${scriptSrc}"`);
    });
  }

  // No network call at all: an app is handed to the OS browser, never loaded by the
  // page, so there is no request to cache, abort or leak.
  const script = readText('script.js');
  metric('Requests the page makes', '0', 'every app leaves for the default browser');

  check('nothing in the page opens a socket', () => {
    if (/\bfetch\(|XMLHttpRequest|navigator\.sendBeacon/.test(script)) {
      throw new Error('the page must not fetch: an app is a link, not a request');
    }
    if (/api\.open-meteo\.com/.test(script)) {
      throw new Error('the forecast endpoint must be gone with the weather card');
    }
  });

  check('a link is the only thing a click produces', () => {
    if (!/function openExternal\(win, url\)/.test(script)) {
      throw new Error('openExternal() is missing: nothing could leave for the browser');
    }
    if (!script.includes('^https:\\/\\/[^\\s]+$')) {
      throw new Error('only https may leave the wallpaper');
    }
    if (!script.includes('dynawallOpenURL') || !script.includes("win.open(target, '_blank', 'noopener')")) {
      throw new Error('the link must reach the native bridge, or the browser');
    }
  });

  const distFiles = walk('dist/DynaWall.app');
  if (!distFiles.length) {
    note('no local build in dist/ — skipping the bundle breakdown');
    metric('dist/DynaWall.app', 'not built', 'run ./build-macos.sh to measure the bundle');
    return;
  }

  const distTotal = totalSize(distFiles);
  const binary = distFiles.find((file) => file.relative.endsWith(path.join('Contents', 'MacOS', 'DynaWall')));
  const bundledImages = distFiles.filter((file) => file.relative.indexOf(path.join('Resources', 'images')) !== -1);
  const bundledFonts = distFiles.filter((file) => file.relative.indexOf(path.join('Resources', 'assets')) !== -1);
  const bundledCode = distFiles.filter((file) => /Resources[\\/](index\.html|style\.css|script\.js)$/.test(file.relative));

  let archs = 'unknown';
  if (binary) {
    try {
      archs = execFileSync('lipo', ['-archs', binary.absolute], { encoding: 'utf8' }).trim();
    } catch (error) {
      archs = 'lipo unavailable';
    }
  }

  metric('dist/DynaWall.app', bytes(distTotal), `${distFiles.length} files`);
  metric('Executable', binary ? bytes(binary.size) : 'missing', `architectures: ${archs}`);
  metric('Bundled wallpapers', bytes(totalSize(bundledImages)), `${bundledImages.length} files`);
  metric('Bundled fonts', bytes(totalSize(bundledFonts)), `${bundledFonts.length} files`);
  metric('Bundled html/css/js', bytes(totalSize(bundledCode)));
  note(`bundle ${bytes(distTotal)} · binary ${binary ? bytes(binary.size) : 'missing'} (${archs})`);

  check('the bundle ships the curated wallpapers and nothing else', () => {
    if (bundledImages.length !== DynaWall.BUNDLED_PHOTOS.length) {
      throw new Error(`${bundledImages.length} images in the bundle, expected ${DynaWall.BUNDLED_PHOTOS.length}`);
    }
  });

  if (archs !== 'unknown' && archs !== 'lipo unavailable' && !/x86_64/.test(archs)) {
    finding(
      'Best practice',
      `The app bundle in dist/ is ${archs}-only`,
      'build-macos.sh defaults to `arm64 x86_64`; this bundle was linked with DYNAWALL_ARCHS set, so an ' +
        'Intel Mac cannot launch this copy. Release CI always builds both slices — this only affects a ' +
        'local build that is packaged by hand.',
      'Re-run ./build-macos.sh without DYNAWALL_ARCHS before running ./build-dmg.sh.'
    );
  }
}


/* -------------------------------------------------------------------------- *
 * 6. Native hosts
 * -------------------------------------------------------------------------- */

function auditMacHost() {
  group('6a. macOS host (macos/DynaWallApp.swift)');

  const swift = readText('macos/DynaWallApp.swift');

  const monitor = /addGlobalMonitorForEvents\(matching:\s*\[([^\]]+)\]\)/.exec(swift);
  metric(
    'Global event monitors',
    monitor ? monitor[1].trim() : 'none',
    'one monitor, one message type; no pointer-move traffic'
  );

  const boundaryMatch = /static let boundaryHours = \[([^\]]+)\]/.exec(swift);
  const paletteHours = boundaryMatch
    ? boundaryMatch[1]
        .split(',')
        .map((hour) => Number(hour.trim()))
        .filter((hour) => Number.isFinite(hour))
    : [];
  metric(
    'Palette timer wakeups per 24 h (macOS host)',
    String(paletteHours.length),
    `ThemeSlot.boundaryHours = ${paletteHours.join(', ') || 'not found'}`
  );

  check('every palette hour the host wakes for is a clock boundary the page knows', () => {
    if (!paletteHours.length) throw new Error('ThemeSlot.boundaryHours was not found');
    const unknown = paletteHours.filter((hour) => DynaWall.CLOCK_BOUNDARY_HOURS.indexOf(hour) === -1);
    if (unknown.length) {
      throw new Error(`hours ${unknown.join(', ')} are missing from CLOCK_BOUNDARY_HOURS in script.js`);
    }
  });

  check('the global mouse watch listens to left-clicks only', () => {
    const monitor = /addGlobalMonitorForEvents\(matching:\s*\[([^\]]+)\]\)/.exec(swift);
    if (!monitor) throw new Error('no global event monitor found');
    const events = monitor[1].split(',').map((event) => event.trim()).filter(Boolean);
    if (events.length !== 1 || events[0] !== '.leftMouseDown') {
      throw new Error(`monitor matches [${events.join(', ')}]`);
    }
  });

  check('no mouse-move or scroll monitor is installed', () => {
    const moving = /add(Global|Local)MonitorForEvents\(matching:[^)]*(mouseMoved|mouseDragged|leftMouseDragged|scrollWheel)/.exec(
      swift
    );
    if (moving) throw new Error(`${moving[1]} monitor watches ${moving[2]} — a move flood is 100× a click`);
  });

  check('the mouse watch is removed when the wallpaper goes away', () => {
    if (!/NSEvent\.removeMonitor\(clickMonitor\)/.test(swift)) {
      throw new Error('stopClickMonitor() must remove the monitor');
    }
  });

  check('occlusion drives suspension (a covered desktop costs no frames)', () => {
    if (!/didChangeOcclusionStateNotification/.test(swift)) {
      throw new Error('no occlusion observer');
    }
    if (!/occlusionState\.contains\(\.visible\)/.test(swift)) throw new Error('occlusion state is never read');
    if (!/hasBeenVisible/.test(swift)) {
      throw new Error('a window that has never been on screen must not be treated as covered');
    }
    if (!/evaluateJavaScript\(WallpaperPreferences\.javaScriptSuspend\(suspended\)\)/.test(swift)) {
      throw new Error('suspension must be pushed to the page');
    }
  });

  check('display sleep and session lock suspend every page', () => {
    ['screensDidSleepNotification', 'sessionDidResignActiveNotification', 'screensDidWakeNotification', 'sessionDidBecomeActiveNotification'].forEach(
      (name) => {
        if (swift.indexOf(name) === -1) throw new Error(`${name} is not observed`);
      }
    );
    if (!/private func setSystemSuspended\(_ suspended: Bool\)/.test(swift)) {
      throw new Error('setSystemSuspended() is missing');
    }
  });

  check('one in-memory data store and one scheme handler are shared by every display', () => {
    const stores = swift.match(/WKWebsiteDataStore\.nonPersistent\(\)/g) || [];
    if (stores.length !== 1) throw new Error(`${stores.length} data stores — a second display must reuse the first`);
    if (!/lazy var photoSchemeHandler = PhotoSchemeHandler\(library: photoLibrary\)/.test(swift)) {
      throw new Error('the photo scheme handler must be a single shared instance');
    }
    if (!/configuration\.websiteDataStore = dataStore/.test(swift)) {
      throw new Error('every window configuration must adopt the shared store');
    }
  });

  check('the palette timer is one-shot and tolerant (four wakeups a day)', () => {
    if (!/Timer\(fire: fireDate, interval: 0, repeats: false\)/.test(swift)) {
      throw new Error('the palette timer must be a one-shot Timer');
    }
    if (!/timer\.tolerance\s*=/.test(swift)) {
      throw new Error('no tolerance: the wakeup cannot be coalesced with the system');
    }
    if (!/guard preferences\.themePreset == \.auto, !isPaused else \{ return \}/.test(swift)) {
      throw new Error('a pinned palette must never arm a clock timer');
    }
  });

  check('a clock change re-reads the palette instead of polling for it', () => {
    if (swift.indexOf('NSSystemClockDidChange') === -1) throw new Error('NSSystemClockDidChange is not observed');
    if (swift.indexOf('NSCalendarDayChanged') === -1) throw new Error('NSCalendarDayChanged is not observed');
  });

  check('the popover preview decodes a bounded thumbnail, not the full 5K photo', () => {
    if (!/kCGImageSourceThumbnailMaxPixelSize/.test(swift)) {
      throw new Error('the preview card must bound the decode (a full 5K decode is tens of MB)');
    }
    if (!/previewImageToken/.test(swift)) throw new Error('a token must discard a stale decode');
    const decode = functionBody(swift, 'private func loadPreviewImage(from source: String)', '\n    }\n');
    if (!/DispatchQueue\.global\(qos: \.\w+\)\.async/.test(decode)) {
      throw new Error('the decode belongs on a background queue, never the main thread');
    }
  });

  if (/DispatchQueue\.global\(qos: \.userInitiated\)\.async \{ \[weak self\] in\n\s+let image = Self\.thumbnail\(/.test(swift)) {
    finding(
      'Low',
      'The preview thumbnail is decoded at user-initiated QoS, not utility',
      'loadPreviewImage() documents "the work happens on a utility queue" but schedules ' +
        '`DispatchQueue.global(qos: .userInitiated)`. A user-initiated queue asks the scheduler to ' +
        'promote the work and to keep the machine out of a low-power state while it runs — for a ' +
        '200 KB thumbnail that nothing is waiting on. On a laptop that is a measurable wake-up cost ' +
        'for a picture in a popover.',
      'Use `.utility` (or `.background`), matching the comment: the card already tolerates a late ' +
        'decode thanks to `previewImageToken`.'
    );
  }

  check('the window list is only enumerated for a click, never on a timer', () => {
    const enumerations = swift.match(/CGWindowListCopyWindowInfo/g) || [];
    if (enumerations.length !== 1) {
      throw new Error(`${enumerations.length} window-list enumerations — this call is ~ms and belongs on the click path only`);
    }
    const forward = swift.indexOf('private func forwardDesktopClick(');
    const enumerate = swift.indexOf('CGWindowListCopyWindowInfo');
    if (forward !== -1 && enumerate < forward) {
      throw new Error('the enumeration sits outside forwardDesktopClick()');
    }
  });

  // A palette wakeup during display sleep is bounded by the four boundaries a
  // day, so this is a tidy-up rather than a battery item.
  if (!/systemSuspended/.test(functionBody(swift, 'private func scheduleThemeTimer(', '\n    }'))) {
    finding(
      'Low',
      'The macOS palette timer keeps its appointment while the displays sleep',
      'scheduleThemeTimer() guards on `!isPaused` but not on `systemSuspended`, so the one-shot timer ' +
        'still fires during display sleep and a locked session. Four wakeups a day, each of which only ' +
        're-reads the hour, so the cost is negligible — but it is the one wakeup the macOS host does not park.',
      'Thread the suspension state into scheduleThemeTimer() (invalidate on suspend, re-arm in resync()) ' +
        'so "suspended" means zero timer wakeups on both hosts, and the invariant is easy to state.'
    );
  }
}


function auditWindowsHost() {
  group('6b. Windows host (windows/*.cs)');

  const clicks = readText('windows/DesktopClicks.cs');
  const controller = readText('windows/WallpaperController.cs');
  const window = readText('windows/WallpaperWindow.cs');

  check('the low-level hook filters to one message before touching the event', () => {
    const filter = clicks.indexOf('wParam == (IntPtr)WmLButtonDown');
    const read = clicks.indexOf('Marshal.PtrToStructure<MouseHookStruct>');
    if (filter === -1) throw new Error('the hook does not test WM_LBUTTONDOWN');
    if (read === -1 || read < filter) {
      throw new Error('the event is marshalled before it is filtered — every mouse message pays for it');
    }
    if (!/WhMouseLl = 14/.test(clicks)) throw new Error('the hook is not WH_MOUSE_LL');
  });

  check('the hook always chains, whatever it decided', () => {
    const chains = clicks.match(/return CallNextHookEx\(hook, code, wParam, lParam\);/g) || [];
    if (chains.length !== 1) throw new Error(`${chains.length} CallNextHookEx sites — a click must pass through exactly once`);
    const body = functionBody(clicks, 'private static IntPtr OnMouse(', '\n    }');
    if (!/try[\s\S]*catch[\s\S]*CallNextHookEx/.test(body)) {
      throw new Error('CallNextHookEx must sit outside the try/catch so a failure still passes the click on');
    }
    if (!/LlmhfInjected/.test(clicks)) throw new Error('injected clicks must be ignored');
  });

  const watchdogInterval = /watchdog = new System\.Windows\.Forms\.Timer \{ Interval = ([\d_]+) \}/.exec(controller);
  const ticks = watchdogInterval ? Math.round(86400 / (Number(watchdogInterval[1].replace(/_/g, '')) / 1000)) : 0;
  metric('Watchdog wakeups per 24 h (15 s timer)', String(ticks), 'runs whether or not anything is suspended');

  check('the watchdog never blocks on a Progman message once windows exist', () => {
    if (!/FindWallpaperHost\(spawn: windows\.Count == 0\)/.test(controller)) {
      throw new Error('the watchdog must only ask for the WorkerW layer while nothing has been built');
    }
    if (!/TimeSpan\.FromSeconds\(20\)/.test(controller)) {
      throw new Error('no rebuild cool-down — a display change storm would rebuild in a loop');
    }
  });

  check('one WebView2 environment serves every display', () => {
    const creations = (controller.match(/CoreWebView2Environment\.CreateAsync\(/g) || []).length;
    if (creations !== 1) throw new Error(`${creations} environment creations — a second user-data folder per display`);
    if (!/await webView\.EnsureCoreWebView2Async\(environment\)/.test(window)) {
      throw new Error('windows must adopt the shared environment');
    }
  });

  check('the seed is injected before the first navigation', () => {
    const inject = window.indexOf('AddScriptToExecuteOnDocumentCreatedAsync');
    const navigate = window.indexOf('core.Navigate(BundledPageUri)');
    if (inject === -1) throw new Error('the at-document-start seed is never installed');
    if (navigate === -1) throw new Error('the bundled page is never navigated to');
    if (inject > navigate) throw new Error('the seed arrives after the first paint, so the page flashes the default copy');
  });

  check('both virtual hosts are mapped with CORS denied', () => {
    const mappings = window.match(/SetVirtualHostNameToFolderMapping\(/g) || [];
    if (mappings.length !== 1) throw new Error(`${mappings.length} mappings in WallpaperWindow`);
    if (!/CoreWebView2HostResourceAccessKind\.DenyCors/.test(window)) {
      throw new Error('a folder mapping must deny CORS to the page');
    }
    if (!/CoreWebView2HostResourceAccessKind\.DenyCors/.test(controller)) {
      throw new Error('the photo folder mapping must deny CORS too');
    }
  });

  check('the page may never navigate away from the bundle', () => {
    if (!/core\.NavigationStarting \+= OnNavigationStarting/.test(window)) {
      throw new Error('no NavigationStarting guard');
    }
    if (!/e\.Cancel = true/.test(window)) throw new Error('a navigation away is not cancelled');
  });

  const suspensionBody = functionBody(controller, 'internal void ApplySuspension()', '\n    }');
  if (/IsSuspended/.test(controller) && !/watchdog\.(Stop|Pause)/.test(suspensionBody)) {
    finding(
      'Medium',
      `The Windows watchdog keeps ticking ${ticks.toLocaleString('en-US')} times a day, suspended or not`,
      'WallpaperController owns a 15 s WinForms timer that calls CheckAttachment() for the life of the ' +
        'process. Suspension (Pause, session lock, display sleep) parks the pages but never the watchdog: ' +
        'it keeps waking the UI thread and calling EnumWindows while the machine is asleep or locked, ' +
        'which is exactly the window where a live wallpaper should cost nothing.',
      'Stop the timer in ApplySuspension() when `IsSuspended` and start it again on resume — the ' +
        'SystemEvents handlers already fire on unlock and power-resume, and a resume immediately calls ' +
        'Resync(), so nothing is lost while it is parked.'
    );
  }

  if (/ProcessFailed \+= OnProcessFailed/.test(window) && !/Reload/.test(window)) {
    finding(
      'Best practice',
      'A crashed WebView2 renderer leaves a blank desktop until something else rebuilds it',
      'OnProcessFailed() logs the failure kind and returns. The watchdog only checks that the window ' +
        'handle still has the right parent, so a renderer that exited (a GPU reset, an OOM on a 5K ' +
        'slideshow) is never noticed: the wallpaper stays black until a display change or an Explorer ' +
        'restart forces a rebuild.',
      'Mark the window not-ready on a RenderProcessExited failure and let CheckAttachment() rebuild it, ' +
        'or call `webView.CoreWebView2.Reload()` from the handler.'
    );
  }
}


/* -------------------------------------------------------------------------- *
 * Report
 * -------------------------------------------------------------------------- */

const SEVERITY_ORDER = ['High', 'Medium', 'Low', 'Best practice'];

function capitalise(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function metricTable(rows) {
  if (!rows.length) return '';
  const lines = ['| Metric | Value | Detail |', '| --- | --- | --- |'];
  rows.forEach((row) => {
    const detail = String(row.detail || '').replace(/\|/g, '\\|');
    lines.push(`| ${row.label} | ${row.value} | ${detail} |`);
  });
  return lines.join('\n');
}

function benchmarkTable(rows) {
  if (!rows.length) return '';
  const lines = [
    '| Routine | Iterations | ops/s | p50 | p95 | p99 | max |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |'
  ];
  rows.forEach((row) => {
    lines.push(
      `| \`${row.name}\` | ${row.iterations.toLocaleString('en-US')} | ${opsPerSecond(row.opsPerSecond)} | ` +
        `${micros(row.p50Us)} | ${micros(row.p95Us)} | ${micros(row.p99Us)} | ${micros(row.maxUs)} |`
    );
  });
  return lines.join('\n');
}


function buildReport() {
  const groups = report.groups.filter(
    (name) =>
      report.metrics.some((row) => row.group === name) || report.checks.some((row) => row.group === name)
  );

  const findingsBySeverity = SEVERITY_ORDER.map((severity) => ({
    severity,
    items: report.findings.filter((item) => item.severity === severity)
  })).filter((bucket) => bucket.items.length > 0);

  const lines = [];
  lines.push('# DynaWall performance audit');
  lines.push('');
  lines.push(
    `Generated ${report.generatedAt.toISOString().replace('T', ' ').slice(0, 19)} UTC · ` +
      `Node ${report.node} · ${report.platform} · ${report.cpus} logical cores`
  );
  lines.push('');
  lines.push(
    `**${passed}/${passed + failures.length} invariants hold.** ` +
      `${report.findings.length} finding(s): ` +
      (findingsBySeverity.length
        ? findingsBySeverity.map((bucket) => `${bucket.items.length} ${capitalise(bucket.severity)}`).join(', ')
        : 'none') +
      '.'
  );
  lines.push('');
  lines.push('## At a glance');
  lines.push('');
  lines.push(
    metricTable(
      report.metrics.filter((row) =>
        /wakeups per 24 h \(one-shot|Worst-case decoded|will-change declarations|Page payload on disk|dist\/DynaWall\.app$|Unused image|Watchdog wakeups|render\(\) hot path/.test(
          row.label
        )
      )
    )
  );
  lines.push('');
  lines.push('## Micro-benchmarks');
  lines.push('');
  lines.push(benchmarkTable(report.benchmarks));
  lines.push('');
  lines.push(
    '> Measured with `process.hrtime.bigint()` around each call, after a warm-up pass, on the machine above. ' +
      'The absolute numbers move with the CPU; the ratios (cold vs warm cache, linear vs quadratic) are the ' +
      'part that transfers.'
  );
  lines.push('');

  groups.forEach((groupName) => {
    lines.push(`## ${groupName}`);
    lines.push('');
    const table = metricTable(report.metrics.filter((row) => row.group === groupName));
    if (table) {
      lines.push(table);
      lines.push('');
    }
    const groupChecks = report.checks.filter((row) => row.group === groupName);
    if (groupChecks.length) {
      groupChecks.forEach((row) => {
        lines.push(`- ${row.ok ? '✅' : '❌'} ${row.name}${row.ok ? '' : ` — ${row.message}`}`);
      });
      lines.push('');
    }
  });

  if (report.findings.length) {
    lines.push('## Findings');
    lines.push('');
    findingsBySeverity.forEach((bucket) => {
      lines.push(`### ${capitalise(bucket.severity)}`);
      lines.push('');
      bucket.items.forEach((item, index) => {
        lines.push(`${index + 1}. **${item.title}**`);
        lines.push(`   - **Evidence:** ${item.evidence}`);
        lines.push(`   - **Action:** ${item.action}`);
      });
      lines.push('');
    });
  }

  lines.push('## Method');
  lines.push('');
  lines.push('```bash');
  lines.push('node tests/verify.cjs       # behavioural baseline (must stay green)');
  lines.push('node tests/perf-audit.cjs   # this audit');
  lines.push('```');
  lines.push('');
  lines.push(
    '- **Timers** are simulated, not observed: `msUntilNextClockBoundary()` is stepped across a fixed local day ' +
      'and the invocations are counted, which is what a 24 h run would do.'
  );
  lines.push(
    '- **Latencies** come from timed iterations (10,000 by default, 2,000–5,000 for the heavier paths) after a ' +
      'warm-up pass; p50/p95/p99 are reported from the raw samples, so one GC pause cannot hide in a mean.'
  );
  lines.push(
    '- **Style invariants** are read from `style.css` with a small rule walker: every `@keyframes` body is parsed ' +
      'for animated properties, every `transition` for its property, and every suspension rule resolved by selector.'
  );
  lines.push(
    '- **Texture sizes** come from the JPEG SOF headers of the shipped wallpapers (`width × height × 4` bytes of ' +
      'RGBA once decoded), not from file sizes.'
  );
  lines.push(
    '- **Native hosts** are inspected statically (Swift/C# structure): the audit asserts the shape of the event ' +
      'tap, the notification wiring and the watchdog, which a runtime profile on one machine could not show.'
  );
  lines.push('');
  lines.push('Nothing in `script.js`, `style.css`, `index.html`, `macos/` or `windows/` is modified by this audit.');
  lines.push('');
  return lines.join('\n');
}


/* -------------------------------------------------------------------------- *
 * Entry point
 * -------------------------------------------------------------------------- */

function main() {
  console.log(
    `DynaWall performance audit — Node ${report.node} · ${report.platform} · ${report.cpus} logical cores`
  );

  auditTimers();
  auditBenchmarks();
  auditCompositor();
  auditMemory();
  auditAssets();
  auditMacHost();
  auditWindowsHost();

  const total = passed + failures.length;
  console.log(`\n${passed}/${total} invariants hold`);

  if (report.findings.length) {
    console.log(`\nFindings (${report.findings.length})`);
    SEVERITY_ORDER.forEach((severity) => {
      report.findings
        .filter((item) => item.severity === severity)
        .forEach((item) => console.log(`  [${severity}] ${item.title}`));
    });
  }

  if (failures.length > 0) {
    console.log('\nFailed invariants:');
    failures.forEach((failure) => console.log(`  - ${failure.name}: ${failure.message.split('\n')[0]}`));
  }

  if (!NO_REPORT) {
    try {
      fs.writeFileSync(REPORT_PATH, buildReport(), 'utf8');
      console.log(`\nReport written to ${path.relative(process.cwd(), REPORT_PATH) || REPORT_PATH}`);
    } catch (error) {
      console.log(`\nCould not write the report: ${error.message}`);
      process.exitCode = 1;
    }
  }

  if (failures.length > 0) {
    process.exitCode = 1;
  } else {
    console.log('DynaWall performance audit passed.');
  }
}

main();


