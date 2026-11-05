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
| Widgets | Four clickable satellites — **Music**, **News**, **YouTube**, **Weather** — opening frosted cards. Each can be switched off individually; nothing is fetched before a card opens (weather uses keyless Open-Meteo) |
| Typography | **Outfit** (default), **Google Sans Flex**, **Space Grotesk** and **Geist** ship with the app; any system or imported font also works |
| Dependencies | None. Fonts and twelve wallpapers are bundled; the only network call is the weather forecast |

## Native apps

`DynaWall.app` and `DynaWall.exe` place one click-through WebView per display *behind* the desktop icons, so
Finder/Mission Control (macOS) and icon selection and the context menu (Windows) keep working. Widget clicks
are replayed from a system-wide mouse watch; only `https` links are opened in the browser. Windows runs
`PerMonitorV2`, so screen coordinates are physical pixels while the page reports CSS pixels: a click is
divided by `window.DeviceScale` (`DeviceDpi / 96`) before it is matched, which keeps the satellites
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
| Desktop widgets | `widgets` | `widgets` | on |
| One satellite | `music`, `news`, `youtube`, `weather` | `widgetMusic`, `widgetNews`, `widgetYouTube`, `widgetWeather` (lowercase in Wallpaper Engine) | on |
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
- Photos: six Golden Gate 5K time-of-day wallpapers plus six generated abstracts, free to replace via
  `GOLDEN_GATE_PHOTOS` / `ABSTRACT_PHOTOS` in `script.js`.
- Weather: keyless [Open-Meteo](https://open-meteo.com/) forecast, requested only when the card opens.

