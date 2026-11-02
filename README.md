# DynaWall

A minimalist, zero-dependency live wallpaper for **macOS**, **Lively Wallpaper** and **Wallpaper Engine**.
It greets you with the time of day over a palette that follows it — dawn, day, dusk and night — on a flat
colour or a rotating photo slideshow.

```text
Good evening, Developer.
What are we building today?
```

![DynaWall thumbnail](thumbnail.png)

On macOS it runs as its own native menu bar app (`DynaWall.app`) — no Plash, Lively or Wallpaper Engine
required. See [macOS app](#macos-app-native).

## Behaviour

| Feature | Detail |
| --- | --- |
| Greeting | `Good {morning\|afternoon\|evening}, {FirstName}.` |
| Time windows | 05:00–11:59 morning · 12:00–17:59 afternoon · 18:00–04:59 evening |
| Palette | Four time-aware bands: **dawn** 05:00–08:59 (violet ink, rose glow) · **day** 09:00–16:59 (neutral) · **dusk** 17:00–20:59 (amber) · **night** 21:00–04:59 (deep blue, dimmer type, dimmed photos). Pin one band or hand it a colour instead |
| Subtitle | Defaults to `What are we building today?`; clear it to hide the line |
| Refresh | Greeting period *and* palette re-checked every 30 s, and again on wake, resume or window focus |
| Photo slideshow | Off by default. When on, the wallpaper cross-fades through photos every 1–60 min, in order or shuffled, with an optional slow zoom (Ken Burns) and a scrim that keeps the greeting readable. Six generated wallpapers ship in `images/`; the macOS app can rotate any folder you point it at |
| Typography | **Outfit** (variable, 600 for the greeting) — optically tracked at display size, so the greeting is ~90 px on a 1080p screen and ~112 px on a 1440p/5K desktop |
| Motion | One-shot entrance fade plus a 320 ms cross-fade whenever the greeting text changes; photos cross-fade over 1.2 s |
| Dependencies | No frameworks, CDN links or network requests. The only artwork is the vendored Outfit face (~32 KB, SIL OFL 1.1) plus the generated JPEG wallpapers in `images/` (~780 KB). The macOS host uses only system frameworks (AppKit, WebKit, SwiftUI) |

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Wallpaper markup and default copy |
| `style.css` | Time-aware palette bands, typography tokens, layout and transitions |
| `script.js` | Clock (greeting + palette), configuration resolution, host IPC and rendering |
| `LivelyProperties.json` | Lively Wallpaper customization panel |
| `LivelyInfo.json` | Lively project descriptor (`Type: 1` = web) |
| `project.json` | Wallpaper Engine project and user properties |
| `thumbnail.png` | Thumbnail/preview used by both hosts |
| `assets/fonts/` | Vendored Outfit latin-subset variable WOFF2 with its SIL OFL license |
| `images/` | The six wallpapers bundled with the slideshow (replaceable — see Notes) |
| `tests/verify.cjs` | Headless checks for `script.js` and the manifests |
| `macos/DynaWallApp.swift` | Native macOS host: desktop-level windows, WebKit, menu bar settings |
| `macos/Info.plist` | Bundle metadata (`com.dynawall.macos`, `LSUIElement`) |
| `build-macos.sh` | Zero-dependency `swiftc` build that assembles and signs `dist/DynaWall.app` |
| `dist/DynaWall.app` | Build output (generated, not checked in) |

## Time-aware palettes

The clock drives more than the greeting. Four bands decide the ink, the accent glow, the text tones and the
photo grade, and the wallpaper moves between them four times a day:

| Band | Hours | Background | Accent glow | Photos |
| --- | --- | --- | --- | --- |
| `dawn` | 05:00–08:59 | `#121020` violet ink | rose | barely warmed |
| `day` | 09:00–16:59 | `#0d1117` neutral | blue | untouched |
| `dusk` | 17:00–20:59 | `#180f0e` warm ink | amber | `sepia` + slightly brighter |
| `night` | 21:00–04:59 | `#070a11` deep blue | indigo | dimmed & desaturated |

- The palette and the greeting are read from the same clock and re-evaluated together every 30 s, plus on
  wake and on window focus — so a laptop that slept through sunset wakes up in the right band.
- A band change cross-fades over 2.4 s (`--theme-fade-duration`): background, text colours and the photo
  grade all interpolate, so it reads as a change of light rather than a UI event. The fade only arms after
  the entrance, which is why a 23:00 launch starts at night instead of fading in from the previous band.
- The bands are deliberately finer than the greeting windows: light changes at 09:00 and 21:00, when
  "morning"/"evening" would still be saying the same thing.
- **Pin it** with `theme=dawn|day|dusk|night` (URL, Lively dropdown, Wallpaper Engine combo, macOS picker),
  or `theme=auto` to hand it back to the clock. `theme=custom` uses your background colour with the neutral
  (daylight) palette.
- **A colour wins on its own**: set `bgColor` (or pick a colour in the macOS popover) without naming a
  theme, and the palette stops following the clock — the band tokens go neutral so the colour you chose is
  the colour you get. Name a theme in the same breath and the theme wins, with the colour kept for `custom`.
- Everything is a token in `style.css` (`--bg-primary`, `--bg-radial-accent`, `--bg-vignette`,
  `--text-primary`, `--text-secondary`, `--greeting-glow`, `--photo-filter`) under `[data-theme="…"]`, so a
  band can be retuned without touching a rule, and `:root` keeps the daylight values for the very first
  paint before `script.js` runs.

```css
[data-theme="dusk"] {
  --bg-primary: #180f0e;
  --bg-radial-accent: rgba(255, 146, 80, 0.06);
  --text-primary: #fdf1e8;
  --photo-filter: sepia(0.08) saturate(1.06) brightness(0.98);
}
```

The hours exist in three places on purpose (CSS cannot read a clock, and the native host needs a colour
while the page is still loading): `getThemeSlot()` in `script.js`, `ThemeSlot` in `macos/DynaWallApp.swift`,
and the `[data-theme]` blocks. A test asserts the macOS hexes match the CSS ones so they cannot drift apart.

## Try it in a browser

Open `index.html` directly, or serve the folder:

```bash
python3 -m http.server 8000   # then visit http://localhost:8000
```

Serve it rather than double-clicking the file: Chromium browsers refuse to load `@font-face` files over
`file://`, so a double-clicked preview falls back to the system font. Safari and the macOS host load the
vendored fonts directly.

URL parameters (all optional, handy for quick experiments):

| Parameter | Values | Example |
| --- | --- | --- |
| `name` | first name | `?name=Alex` |
| `subtitle` | any text — empty hides it | `?subtitle=Shipping%20today` |
| `theme` | `auto`, `dawn`, `day`, `dusk`, `night`, `custom` | `?theme=dusk` |
| `bgColor` | `#rrggbb`, `rgb(...)` or `r g b` floats (pins `custom`) | `?bgColor=%230b0f19` |
| `slideshow` | `true` / `false` | `?slideshow=true` |
| `interval` | minutes between photos (1–1440) | `?interval=5` |
| `shuffle` | `true` / `false` — random order instead of sequential | `?shuffle=false` |
| `kenBurns` | `true` / `false` — slow zoom | `?kenburns=false` |
| `photos` | comma separated list of image URLs | `?photos=images/03-deep-ocean.jpg` |

Example: `index.html?name=Alex&bgColor=%230b0f19` · `index.html?theme=night` pins the night palette.

Preview the slideshow without waiting: `index.html?slideshow=true&interval=1&shuffle=false` rotates
every minute through the bundled photos, and `?photos=images/03-deep-ocean.jpg` pins a single one.

## macOS app (native)

`DynaWall.app` is a self-contained menu bar utility that turns the same wallpaper into your real macOS
desktop background. No extra tools, no browser window, no Dock icon.

### Requirements

- macOS 12 (Monterey) or newer
- Xcode Command Line Tools: `xcode-select --install`

### Build & run

```bash
./build-macos.sh                 # compiles with swiftc, ad-hoc signs, writes dist/DynaWall.app
open dist/DynaWall.app           # starts the menu bar item and the wallpaper
```

The script builds for the architecture of the Mac running it (arm64 or x86_64) and targets macOS 12+.
`DynaWall` lives in the menu bar — click the icon to open the settings popover, or use **Quit DynaWall**
there to stop it. Because the app is ad-hoc signed, Gatekeeper is happy with locally built copies; if you
move the app to another Mac, re-run `build-macos.sh` on that Mac instead of copying the binary.

### How it works

| Concern | Implementation |
| --- | --- |
| Layering | One borderless `NSWindow` per display at `CGWindowLevelForKey(.desktopWindow)` — above the desktop picture, below the Finder icons |
| Click-through | `ignoresMouseEvents = true`, plus a `DesktopLevelWindow` that can never become key or main, so Finder icons, drag-select and Mission Control keep working |
| Spaces & full screens | `collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]` |
| Rendering | A `WKWebView` per display loading the bundled `index.html`, `style.css` and `script.js` |
| Photos | The host resolves your photo folder and hands the page `dynawall-photo://photo/<n>` URLs; a `WKURLSchemeHandler` serves those files, so the web view stays sandboxed to exactly the images you picked |
| Multi-monitor | `NSApplication.didChangeScreenParametersNotification` rebuilds the windows (only when the layout actually changed) |
| Sleep/wake | `NSWorkspace.didWakeNotification` re-pushes the settings and asks the page to re-evaluate its greeting and pick a fresh photo |
| Live settings | Every change is pushed straight into the page with `window.livelyPropertyListener(...)` — the exact same bridge Lively uses, so both hosts share one configuration code path |
| Persistence | `UserDefaults` in the `com.dynawall.macos` domain |
| Zero flash | The window stays at `alphaValue = 0` until the page has loaded and the settings have been applied, then fades in |

The first launch starts from your macOS account name (`NSFullUserName()`, e.g. `Froilan`) and the
**Auto (time of day)** palette, so the wallpaper arrives already matching the light outside. A slow timer
re-checks the hour and repaints the native window and backing layer when the band changes, so the surface
behind the page never lags the palette.

### Menu bar settings

| Control | Key | Effect |
| --- | --- | --- |
| First name | `firstName` | Greeting name; the wallpaper updates as you type |
| Subtitle | `subtitleText` | Subtitle line; clear it to hide the line |
| Palette | `themePreset` | **Auto (time of day)** by default; Dawn/Day/Dusk/Night pin one band; GitHub Dark `#0d1117`, Deep Slate `#0b0f19` or a custom colour ride the neutral palette. The caption under the picker says which band the clock is on |
| Custom color | `customBgColor` | Used when the palette is "Custom color"; picking a colour pins that palette |
| Photo slideshow | `slideshowEnabled` | Rotate photos behind the greeting |
| Rotate every | `slideshowIntervalMinutes` | 1, 5, 15, 30 or 60 minutes |
| Shuffle order | `slideshowShuffle` | Random order instead of file-name order |
| Slow zoom | `kenBurns` | Drift/zoom each photo for the length of its turn |
| Bundled / Choose… | `photoFolderPath` | Use the six bundled wallpapers, or pick any folder of images |
| Pause / Resume wallpaper | — | Detaches the wallpaper from the desktop (the menu bar icon dims) |
| Quit DynaWall | — | Stops the app |

### Diagnostics

Logs go to stderr. Set `DYNAWALL_LOG` to mirror them into a file — handy for smoke testing a build
without any screen-recording permission:

```bash
open -n --env DYNAWALL_LOG=/tmp/dynawall.log dist/DynaWall.app   # -n: force a new instance so the env applies
tail -f /tmp/dynawall.log
# [DynaWall] desktop windows: 1 for 1 display(s)
# [DynaWall] launched with 1 display(s)
# [DynaWall] rendered greeting: Good morning, Froilan.
# [DynaWall] subtitle: What are we building today? hidden=0
# [DynaWall] background: rgb(13, 17, 23)
# [DynaWall] palette: day (mode: auto)
# [DynaWall] font: Outfit @ 90.240005px Outfit=1
# [DynaWall] photo library: 6 photo(s) from …/Resources/images
# [DynaWall] slideshow advanced: dynawall-photo://photo/0 (2560x1440)
# [DynaWall] slideshow: on=1 photo=dynawall-photo://photo/0 size=2560x1440 layers=2
```

### Good to know

- The app is not sandboxed (it does not need to be) and never requests screen-recording, camera or
  microphone access.
- Settings changes while the app is closed are picked up on the next launch; changes in the popover apply
  immediately.
- `defaults delete com.dynawall.macos` resets every macOS-side setting.
- Want it at login? Add `DynaWall.app` to **System Settings → General → Login Items**.

## Lively Wallpaper

1. **Add Wallpaper → Browse…** and select `index.html`, or zip the folder and drag it into Lively.
2. Right-click the wallpaper → **Customize** to edit the controls from `LivelyProperties.json`.

| Lively control | Type | Effect |
| --- | --- | --- |
| `firstName` | textbox | Name used in the greeting (`Developer` by default) |
| `subtitleText` | textbox | Subtitle line; leave empty to hide it |
| `theme` | dropdown | `Auto (time of day)`, the four bands, or `Custom color` |
| `bgColor` | color | Background color, used by the `Custom color` theme |
| `slideshow` | checkbox | Rotate photos behind the greeting |
| `slideshowInterval` | slider | Minutes between photos (1–120, default 15) |
| `slideshowShuffle` | checkbox | Random order |
| `kenBurns` | checkbox | Slow zoom on each photo |

Lively talks to the page through `window.livelyPropertyListener(name, value)`: every change is applied
instantly, cross-faded when needed, and cached in `localStorage`. Lively sends the *index* of a dropdown item,
so `theme` arrives as `0…5` — the page maps it back to the band name.

## Wallpaper Engine

1. In Wallpaper Engine use **Open Project** and select `project.json`.
2. The user properties below then appear in the **Installed** tab sidebar.

| Property key | Type | Effect |
| --- | --- | --- |
| `firstname` | text input | Name used in the greeting |
| `subtitle` | text input | Subtitle line; empty hides it |
| `theme` | combo | `auto`, `dawn`, `day`, `dusk`, `night` or `custom` |
| `bgcolor` | color | Background color, used by the `custom` theme |
| `slideshow` | checkbox | Rotate photos behind the greeting |
| `slideshowinterval` | slider | Minutes between photos (1–120, default 15) |
| `slideshowshuffle` | checkbox | Random order |
| `kenburns` | checkbox | Slow zoom on each photo |

Values arrive through `window.wallpaperPropertyListener.applyUserProperties(...)`; colors are converted
from Wallpaper Engine's `"r g b"` floats to hex automatically.

## Configuration priority

1. **Host IPC** — Lively or Wallpaper Engine values
2. **URL query parameters**
3. **`localStorage` cache** — `dynawall.firstName`, `dynawall.subtitle`, `dynawall.bgColor`,
   `dynawall.theme`, `dynawall.slideshow`, `dynawall.slideshowInterval`, `dynawall.slideshowShuffle`,
   `dynawall.kenBurns`
4. **Built-in defaults** — `Developer`, `What are we building today?`, `#0d1117`, palette on `auto`,
   slideshow off, 15 minutes, shuffled, slow zoom on

The photo list is the one exception: `photos` is never cached, because the host resolves it fresh on every
load (and the page falls back to `images/` when nobody sends one).

Each field resolves independently, so a host that only exposes the background colour still picks up the name from the URL.
The one interaction to know about: a colour with no theme beside it pins `custom` (a colour on its own means
"stop following the clock"), while naming a theme in the same layer wins.

> Inside Lively or Wallpaper Engine the host sends its saved values on load, so host settings take
> precedence over URL parameters — that is the intended hierarchy. The native macOS app is a host too:
> it pushes its `UserDefaults` values through `livelyPropertyListener` right after the page loads, so
> they win over the URL and the cached values.

## Notes

- The type is [Outfit](https://fonts.google.com/specimen/Outfit) — a geometric sans by Rodrigo Fuenzalida —
  SIL OFL 1.1, vendored as one latin-subset variable WOFF2 in `assets/fonts`. Drop in a new WOFF2 file and
  update the single `@font-face` rule in `style.css` to re-skin the wallpaper — nothing else has to change.
  Names with characters outside the latin subset (Cyrillic, CJK, …) fall back to the system face for those
  glyphs only, thanks to the `unicode-range` on the face.
- **Typography**: the display scale is tuned for a wide geometric face rather than left at browser defaults —
  the greeting is tracked in (`-0.03em`, because Outfit's round forms open up at 90 px), leads at `1.06`
  instead of the default heading `1.15`, balances its line breaks (`text-wrap: balance` + `hyphens: none`, so
  long names wrap between words, never mid-word), and the subtitle gets matching treatment the other way
  round: `+0.012em` tracking, `1.5` leading and a `46ch` measure cap. `font-synthesis: none` keeps every
  weight real (the vendored file covers 100–900), and `font-kerning: normal` plus
  `common-ligatures contextual` are enabled explicitly.
- All of that lives in tokens at the top of `style.css` — `--greeting-size`, `--greeting-weight`,
  `--greeting-tracking`, `--greeting-leading`, `--subtitle-size`, `--subtitle-weight`,
  `--subtitle-tracking`, `--subtitle-leading`, `--subtitle-measure` — so the whole scale can be retuned
  without touching a rule. Measured in WebKit: 67.7 px greeting at 1440 px wide, 90.2 px at 1920 px,
  112 px (the cap) at 2560 px and above; a typical `Good morning, Froilan.` stays on one line at every
  size, and the container allows 86rem so 5K screens do not wrap early.
- Only the first whitespace-separated token of the name is used, and trailing punctuation is trimmed
  (`"Sam."` → `Sam`).
- Colors accept `#0d1117`, `0d1117`, `rgb(13, 17, 23)` and the `"0.05 0.07 0.09"` float triplets that both
  hosts hand to JavaScript.
- `prefers-reduced-motion: reduce` disables the fades while keeping the same layout.
- A missing or blocked `localStorage` is tolerated; the wallpaper falls back to the URL and defaults.
- **Slideshow**: the six JPEGs in `images/` are generated (soft mesh gradients, 2560×1440, ~780 KB total),
  free to replace. Swapping them means editing the `BUNDLED_PHOTOS` list at the top of `script.js` — or, in
  the macOS app, pointing **Choose…** at any folder (jpg, png, heic, webp, gif, bmp, tiff; the same folder
  on every display). Two stacked `<img>` layers cross-fade, so a slide never flashes empty, and a photo that
  fails to decode is skipped instead of leaving a blank frame.
- The scrim behind the greeting (a soft radial + 22% dim) only appears while a photo is showing, and text
  shadows are added at the same time, so the minimal background keeps its pure look.
- **Palette**: the four bands are pure CSS custom properties under `[data-theme]`, so `script.js` only swaps
  one attribute on `<html>` — the background, accent glow, text tones and photo grade all change together
  and CSS does the interpolating. `prefers-reduced-motion: reduce` collapses the 2.4 s palette fade to 1 ms
  (the band still changes, it just does not animate), and nothing about the palette touches layout.
- The subtitle over a photo is the band's own primary ink at 74% opacity rather than a hard-coded white, so
  it dims with the palette instead of glowing in the dark.
- `prefers-reduced-motion: reduce` also disables the Ken Burns drift; photos still rotate.

## Verification

```bash
node --check script.js
node tests/verify.cjs
python3 -m json.tool LivelyProperties.json > /dev/null   # likewise LivelyInfo.json / project.json
```

`tests/verify.cjs` covers the greeting boundaries (04:59, 05:00, 11:59, 12:00, 17:59, 18:00, 00:00, 23:59),
the greeting copy, value normalization, the four-tier hierarchy, both IPC bridges, the slideshow (interval
clamping, photo list sanitising, bundled files present), the palette (band boundaries at 05:00 / 09:00 /
17:00 / 21:00, theme normalization incl. Lively's indices, the colour-pins-`custom` rule, a full token set
per `[data-theme]` block, and that the macOS hexes and hours match the CSS), that the clock controls are
gone, and the consistency of the host manifests with `script.js`.

For the native macOS app:

```bash
./build-macos.sh                                      # compiles, assembles and signs the bundle
codesign --verify --verbose=2 dist/DynaWall.app       # ad-hoc signature is valid
open -n --env DYNAWALL_LOG=/tmp/dynawall.log dist/DynaWall.app
sleep 5 && grep 'rendered greeting' /tmp/dynawall.log # the page really rendered inside the app
```

The app also prints the live DOM state it reads back from the `WKWebView` (greeting, subtitle visibility,
the computed background colour, the palette band and its mode, the resolved font family, size and whether
the vendored Outfit face actually loaded, plus the visible photo and its decoded pixel size), so a build can
be validated end to end from a terminal. `DYNAWALL_LOG` also records every slide change and every palette
band change (`palette: dusk → night (auto) #070a11`), which is how the rotation and the clock are verified
without screen-recording permission.

Manual check in a browser console (or in Lively):

```js
livelyPropertyListener('firstName', 'Sam');   // greeting cross-fades and is cached
livelyPropertyListener('theme', 'night');     // palette cross-fades over 2.4 s, no reload
livelyPropertyListener('bgColor', '#221133'); // a colour alone pins the custom palette
livelyPropertyListener('theme', 'auto');      // back to following the clock
livelyPropertyListener('slideshow', true);    // photos fade in behind the greeting
window.DynaWall;                              // exposed helpers for quick inspection
window.DynaWall.getThemeSlot(new Date());      // which band the clock is on right now
```
