# DynaWall

A minimalist, zero-dependency live wallpaper for **macOS**, **Windows**, **Lively Wallpaper** and
**Wallpaper Engine**. It greets you with the time of day over a palette that follows it — dawn, day,
dusk and night — on a flat colour or a rotating photo slideshow.

```text
Good evening, Developer.
What are we building today?
```

![DynaWall thumbnail](thumbnail.png)

The same page runs everywhere: the native `DynaWall.app` (menu bar), the native `DynaWall.exe` (tray,
Edge WebView2), Lively Wallpaper and Wallpaper Engine. No frameworks, no CDN links, no accounts.

## Download

Installers are attached to [GitHub Releases](../../releases). *Download now* links are rebuilt on every
push to `main`; *tagged release* links resolve to the newest `v*` release.

| Platform | Download now | Tagged release |
| --- | --- | --- |
| macOS 12+ (Universal 2: Apple silicon + Intel) | [DynaWall.dmg](../../releases/download/nightly/DynaWall.dmg) | [DynaWall.dmg](../../releases/latest/download/DynaWall.dmg) |
| Windows 10 1809+ / 11 (x64) | [DynaWall.exe](../../releases/download/nightly/DynaWall.exe) · [DynaWall-Setup.exe](../../releases/download/nightly/DynaWall-Setup.exe) · [portable zip](../../releases/download/nightly/DynaWall-Windows-Portable.zip) | [DynaWall.exe](../../releases/latest/download/DynaWall.exe) · [DynaWall-Setup.exe](../../releases/latest/download/DynaWall-Setup.exe) · [portable zip](../../releases/latest/download/DynaWall-Windows-Portable.zip) |

Nothing is code-signed: on macOS right-click the app → **Open** once (macOS 15+: **System Settings →
Privacy & Security → Open Anyway**); on Windows SmartScreen may ask for **More info → Run anyway**.
Every release also attaches `SHA256SUMS.txt`:

```bash
shasum -a 256 --check SHA256SUMS.txt            # macOS, in the download folder
certutil -hashfile DynaWall-Setup.exe SHA256    # Windows equivalent
```

## Install

1. **macOS** — open `DynaWall.dmg`, drag **DynaWall** into **Applications**, launch it (right-click →
   **Open** the first time). It appears in the menu bar and sets the wallpaper itself.
2. **Windows** — run `DynaWall.exe` (self-contained, assets embedded) or `DynaWall-Setup.exe` (per-user
   install with autostart), or extract `DynaWall-Windows-Portable.zip`.
3. Nothing else is required — no Lively, no Wallpaper Engine, no runtime to install.

## Features

| Feature | Detail |
| --- | --- |
| Greeting | `Good morning/afternoon/evening, {FirstName}.` — morning 05:00–11:59, afternoon 12:00–17:59, evening 18:00–04:59 |
| Palettes | Four time-aware bands that cross-fade: **dawn** 05:00–08:59, **day** 09:00–16:59, **dusk** 17:00–20:59, **night** 21:00–04:59. Pin a band or use a custom colour |
| Refresh | One timer per real boundary (05:00 · 09:00 · 12:00 · 17:00 · 18:00 · 21:00) plus wake and focus — nothing polls |
| Slideshow | Off by default. Cross-fades every 1–60 min, in order or shuffled, optional slow zoom, with a scrim that keeps the greeting readable |
| Time-synced photos | On by default: only photos whose filename names the active band (`dawn`, `day`, `dusk`, `night`) are shown; untagged photos are spread across the four bands |
| Desktop apps | One `+` satellite opens a frosted **Apps** card: quick-add chips (GitHub, ChatGPT, Claude, YouTube, Spotify, Reddit, Notion, Figma) or paste any `https` address. Every app becomes a satellite that opens in your default browser; the card lists them so you can remove one |
| Nothing is fetched | The wallpaper loads no app, no feed and no forecast: an app is a link handed to the OS browser. The page's Content Security Policy allows no remote host at all |
| App footprints | The glyphs are ranked by how often you launch them: **S** for the ones you never touch, **M** as the baseline, **L** for the one you live in. The tally lives in `localStorage`, and a glyph grows or shrinks where it stands — the desktop only rearranges when an app is added |
| Typography | **Outfit** (default), **Google Sans Flex**, **Space Grotesk** and **Geist** ship with the app; any system or imported font also works |
| Dependencies | None. Fonts and twelve wallpapers are bundled; nothing is ever fetched |

## Native apps

`DynaWall.app` and `DynaWall.exe` place one click-through WebView per display *behind* the desktop icons, so
Finder/Mission Control (macOS) and icon selection and the context menu (Windows) keep working. Clicking a
satellite is replayed from a system-wide mouse watch; only `https` links are opened in the browser. Windows runs
`PerMonitorV2`, so screen coordinates are physical pixels while the page reports CSS pixels: a click is
divided by `window.DeviceScale` (`DeviceDpi / 96`) before it is matched, which keeps the `+` and every app
clickable at 125 / 150 / 175 / 200% scaling.

## Settings

Every host exposes the same controls. In a browser use the URL parameter; the native apps, Lively and
Wallpaper Engine show them as controls (`LivelyProperties.json` / `project.json` hold the keys below).
Booleans accept `true` / `false`.

| Setting | URL parameter | Lively / Wallpaper Engine | Default |
| --- | --- | --- | --- |
| Name | `name` | `firstName` / `firstname` | `Developer` |
| Subtitle | `subtitle` | `subtitleText` / `subtitle` | `What are we building today?` |
| Palette | `theme` | `theme` | `auto` (`dawn`, `day`, `dusk`, `night`, `custom`) |
| Background colour | `bgColor` | `bgColor` / `bgcolor` | `#0d1117` (used by `custom`) |
| Photo slideshow | `slideshow` | `slideshow` | off |
| Rotate every (minutes) | `interval` | `slideshowInterval` / `slideshowinterval` | 15 (host panels 1–120) |
| Shuffle | `shuffle` | `slideshowShuffle` / `slideshowshuffle` | on |
| Slow zoom (Ken Burns) | `kenBurns` | `kenBurns` / `kenburns` | on |
| Match time of day | `photoSync` | `photoSync` / `photosync` | on |
| Desktop apps | `widgets` (alias `apps`, `satellites`) | `widgets` | on |
| Photo list | `photos` | — | twelve bundled wallpapers |
| Font family | `font` | `fontFamily` / `fontfamily` | `Outfit` |
| Imported font file | `fonturl` | — (native apps import files instead) | — |

- Values resolve in this order: **host IPC → host seed → URL parameter → `localStorage` → built-in defaults**.
- A colour set without a `theme` pins `custom`; naming a theme at the same time wins, keeping the colour for `custom`.
- On macOS the greeting name comes from the logged-in account (`NSFullUserName()`); `Developer` is the browser default.
- `suspend` is a live host flag, not a setting.

## Preview in a browser

Open `index.html`, or serve the folder (Chromium refuses `@font-face` over `file://`):

```bash
python3 -m http.server 8000    # http://localhost:8000
```

Examples: `index.html?name=Alex&bgColor=%230b0f19` · `index.html?theme=night` ·
`index.html?slideshow=true&interval=1&photoSync=false` to preview the whole library.

## Lively Wallpaper

1. **Add Wallpaper → Browse…** and select `index.html`, or zip the folder and drag it into Lively.
2. Right-click the wallpaper → **Customize** to edit the controls from `LivelyProperties.json`.

## Wallpaper Engine

1. **Open Project** and select `project.json`.
2. The user properties appear in the **Installed** tab sidebar.

Both hosts push changes through `window.livelyPropertyListener(...)`, so every edit applies live, is
cross-faded where needed and cached in `localStorage`.

## Build from source

**macOS** — macOS 12+ with Xcode Command Line Tools (`xcode-select --install`):

```bash
./build-macos.sh                          # ad-hoc signed, hardened-runtime Universal 2 app bundle
open dist/DynaWall.app
./build-dmg.sh                            # also packages dist/DynaWall.dmg
DYNAWALL_ARCHS="arm64" ./build-macos.sh   # single slice while iterating locally
```

Logs go to stderr; mirror them to a file with `DYNAWALL_LOG=/tmp/dynawall.log open -n dist/DynaWall.app`.

**Windows** — .NET 8 SDK, plus Inno Setup 6.3+ for the installer (`choco install innosetup`):

```powershell
cd windows
dotnet publish -c Release -r win-x64 -o publish
.\publish\DynaWall.exe
```

Or build everything the release ships: `.\windows\build-release.ps1 -Version 1.0.0`, which writes
`dist\DynaWall.exe`, `dist\DynaWall-Setup.exe` and `dist\DynaWall-Windows-Portable.zip`.

**Tests**

```bash
node --check script.js
node tests/verify.cjs
```

`node tests/perf-audit.cjs` is the performance audit: it simulates a day of timer wakeups,
benchmarks the hot routines (10,000 timed iterations each), checks the compositor style
invariants, sizes the shipped assets and inspects both native hosts, then writes
`performance_audit_report.md`. It exits non-zero only if an invariant regressed; the advisory
findings never fail the run. `--no-report` keeps it on the console, `--report path.md` moves
the artifact.

## Files

| Path | Purpose |
| --- | --- |
| `index.html` | Wallpaper markup, default copy and Content Security Policy |
| `style.css` | Palette bands, typography tokens, layout and transitions |
| `script.js` | Clock, configuration resolution, host IPC and rendering |
| `LivelyProperties.json`, `LivelyInfo.json` | Lively Wallpaper panel and project descriptor |
| `project.json` | Wallpaper Engine project and user properties |
| `assets/fonts/` | Four bundled faces (SIL OFL 1.1) with their licences |
| `images/` | Twelve bundled wallpapers |
| `macos/` | Swift menu bar host (`DynaWallApp.swift`) |
| `windows/` | .NET 8 WinForms tray host (WebView2) |
| `tests/verify.cjs` | Test suite run by CI and the release scripts |
| `tests/perf-audit.cjs` | Performance audit: wakeups, micro-benchmarks, compositor invariants, asset and host footprint |
| `build-macos.sh`, `build-dmg.sh`, `windows/build-release.ps1` | Build and packaging scripts |

## Where things are stored

- **macOS** — photos in `~/Pictures/DynaWall` (created and seeded from the bundled wallpapers on first
  launch); settings in the `com.dynawall.macos` defaults domain (`defaults delete com.dynawall.macos`
  resets them); imported fonts in `~/Library/Application Support/DynaWall/Fonts`.
- **Windows** — settings, logs and the WebView2 profile in `%LOCALAPPDATA%\DynaWall\`.
- **Everywhere** — the app list and how often each glyph was launched are cached in `localStorage`
  (`dynawall.customServices`, `dynawall.widgetUsage`), never pushed by a host control.
  `DynaWall.clearWidgetUsage(localStorage)` from the console empties the tally, which puts every glyph
  back on the baseline; `DynaWall.computeWidgetSizes(ids, DynaWall.readWidgetUsage(localStorage))`
  shows the ranking it produces.
- **The apps themselves** — the console can drive the same calls the card does:
  `DynaWall.appPresets()` lists the quick-add chips, `DynaWall.customServices()` lists the apps in the
  orbit, `DynaWall.addCustomService('GitHub', 'https://github.com')` adds one (refused unless it is a
  plain `https` address) and `DynaWall.removeCustomService(id)` forgets it. `DynaWall.openWidget('apps')`
  and `DynaWall.closeWidget()` open and dismiss the card; `DynaWall.setWidgetsEnabled(false)` is the
  switch, from a script instead of a popover.
- **The orbit's arrangement** — the seed the desktop was dealt and the spot each glyph wears are cached
  in `localStorage` too (`dynawall.widgetSeed`, `dynawall.widgetPositions`), so a reload, an app launch,
  a footprint change or a removed app never moves a satellite. Only adding an app re-deals the
  constellation. `DynaWall.clearWidgetPositions(localStorage)` forgets the hand and lets the next deal
  lay the orbit out from scratch.

## Releases

`.github/workflows/release.yml` runs `node tests/verify.cjs`, builds the macOS DMG (Universal 2) and the
Windows setup/portable zip, attaches `SHA256SUMS.txt`, and publishes two channels: a rolling `nightly`
pre-release on every push to `main`, and a stable release on any `v*` tag (`/releases/latest` points at it).

```bash
git tag v1.0.0
git push origin v1.0.0
```

## Credits

- Fonts: [Outfit](https://fonts.google.com/specimen/Outfit),
  [Google Sans Flex](https://fonts.google.com/specimen/Google+Sans+Flex),
  [Space Grotesk](https://fonts.google.com/specimen/Space+Grotesk) and
  [Geist](https://fonts.google.com/specimen/Geist) — all SIL OFL 1.1, licences in `assets/fonts/`.
- App icons: a hybrid of curated vector brand marks and live site favicons. Apps matching a
  built-in brand (GitHub, ChatGPT, Claude, Gemini, YouTube, Spotify, Discord, Reddit, Slack, X,
  Notion, Figma, Linear and the rest of the `SERVICE_ICONS` catalogue) draw crisp monochrome SVG
  path data with no request at all; any other app has its high-resolution favicon fetched
  (natively on macOS, through Google's favicon service with a DuckDuckGo mirror and the site's own
  `/favicon.ico` behind it) and keyed out to a pure white glyph on an offscreen canvas. An app whose
  icon cannot be loaded falls back cleanly to its category mark, its initials or a generic
  application window drawn by the wallpaper itself.
- Photos: six Golden Gate 5K time-of-day wallpapers plus six generated abstracts, free to replace via
  `GOLDEN_GATE_PHOTOS` / `ABSTRACT_PHOTOS` in `script.js`.

