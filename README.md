# DynaWall

A minimalist, zero-dependency live wallpaper for **macOS**, **Windows**, **Lively Wallpaper** and **Wallpaper Engine**.
It greets you with the time of day over a palette that follows it — dawn, day, dusk and night — on a flat
colour or a rotating photo slideshow.

```text
Good evening, Developer.
What are we building today?
```

![DynaWall thumbnail](thumbnail.png)

On macOS it runs as its own native menu bar app (`DynaWall.app`) — no Plash, Lively or Wallpaper Engine
required. On Windows it runs as a native tray app (`DynaWall.exe`) on the Edge WebView2 runtime, parented
behind the desktop icons. See [macOS app](#macos-app-native) and [Windows app](#windows-app-native).

## Download

Installers are attached to [GitHub Releases](../../releases) — there is nothing to build. The left column is
always the newest successful build:

| Platform | Download now | Tagged release |
| --- | --- | --- |
| macOS 12+ (Apple silicon) | [DynaWall.dmg](../../releases/download/nightly/DynaWall.dmg) | [DynaWall.dmg](../../releases/latest/download/DynaWall.dmg) |
| Windows 10 1809+ / 11 (x64) | [DynaWall-Setup.exe](../../releases/download/nightly/DynaWall-Setup.exe) · [portable zip](../../releases/download/nightly/DynaWall-Windows-Portable.zip) | [DynaWall-Setup.exe](../../releases/latest/download/DynaWall-Setup.exe) · [portable zip](../../releases/latest/download/DynaWall-Windows-Portable.zip) |

The **download now** links are refreshed on every push to `main`, so they carry the latest fixes from the
first commit. The **tagged release** links always resolve to the newest `v*` release and start working with
the first tag. Nothing is code-signed: macOS needs **right-click → Open** once, and Windows may show
SmartScreen (**More info → Run anyway**). The DMG is built on the Apple silicon runner; on an Intel Mac run
`./build-macos.sh` (see [macOS app](#macos-app-native)).

### Installing it

1. **macOS** — download `DynaWall.dmg`, double-click it, drag **DynaWall** into **Applications**, then open it
   from Applications. On the first launch only, right-click (or Control-click) the DynaWall icon → **Open** →
   **Open**; macOS remembers it after that. DynaWall appears in the menu bar and sets the wallpaper itself.
2. **Windows** — download `DynaWall-Setup.exe` and run it. It installs for the current user only, so Windows
   never asks for an administrator password; DynaWall then starts with Windows and lives in the system tray.
   `DynaWall-Windows-Portable.zip` is the same app without an installer: unzip it anywhere and run
   `DynaWall.exe`.
3. Nothing else is required — no Lively Wallpaper, no Wallpaper Engine, no frameworks, no accounts.

## Behaviour

| Feature | Detail |
| --- | --- |
| Greeting | `Good {morning\|afternoon\|evening}, {FirstName}.` |
| Time windows | 05:00–11:59 morning · 12:00–17:59 afternoon · 18:00–04:59 evening |
| Palette | Four time-aware bands: **dawn** 05:00–08:59 (violet ink, rose glow) · **day** 09:00–16:59 (neutral) · **dusk** 17:00–20:59 (amber) · **night** 21:00–04:59 (deep blue, dimmer type, dimmed photos). Pin one band or hand it a colour instead |
| Subtitle | Defaults to `What are we building today?`; clear it to hide the line |
| Refresh | Greeting period *and* palette re-checked on the exact boundaries that can change them (05:00 · 09:00 · 12:00 · 17:00 · 18:00 · 21:00 local — six one-shot timers a day, nothing in between), and again on wake, resume or window focus |
| Photo slideshow | Off by default. When on, the wallpaper cross-fades through photos every 1–60 min, in order or shuffled, with an optional slow zoom (Ken Burns) and a scrim that keeps the greeting readable. Twelve wallpapers ship in `images/` — the six Golden Gate 5K time-of-day pictures plus six generated abstracts — and the macOS app seeds them into `~/Pictures/DynaWall` on first launch before rotating that folder (or any folder you pick) |
| Photo sync | **On by default.** The slideshow only rotates through photos whose filename names the active band — `dawn`, `day`, `dusk` or `night` — so the picture on the desktop matches the light outside and the palette in use. Crossing 05:00 / 09:00 / 17:00 / 21:00, or picking a band in the popover, cross-fades to that band's photos. Turn it off to cycle the whole library |
| Next photo | A **Next** button in the macOS popover and a **Next photo** tray item in the Windows app (and `livelyPropertyListener('nextPhoto', true)` / `window.DynaWall.nextPhoto()`) skip to the next photo immediately and restart the timer |
| Typography | **Outfit** by default (variable, 600 for the greeting) — optically tracked at display size, so the greeting is ~90 px on a 1080p screen and ~112 px on a 1440p/5K desktop. Three more families ship with it: **Google Sans Flex**, **Space Grotesk** and **Geist** |
| Motion | One-shot entrance fade plus a 320 ms cross-fade whenever the greeting text changes; photos cross-fade over 1.2 s |
| Widgets | Four white satellites in a loose ring around the greeting — **Music**, **News**, **YouTube**, **Weather** — each opening one frosted card over a dimmed desktop. Nothing is fetched until a card asks for it, and every card that leaves the wallpaper (a YouTube Music search, a Google News desk, a trending feed) opens your browser instead of navigating the wallpaper |
| Dependencies | No frameworks and no CDN links: every byte of chrome — the four vendored faces (Outfit, Google Sans Flex, Space Grotesk, Geist; ~132 KB of latin-subset WOFF2 each, SIL OFL 1.1, plus static TTFs for the native preview cards) and the twelve wallpapers in `images/` — ships with the app. The only network call in the project is the weather card's keyless Open-Meteo forecast, made the moment you open it and never on a timer |

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
| `assets/fonts/` | The four bundled faces — Outfit, Google Sans Flex, Space Grotesk and Geist — each as a latin-subset variable WOFF2 plus static Regular/SemiBold TTFs generated from the same face for the native preview cards, with their SIL OFL licenses (`OFL-*.txt`) |
| `images/` | The bundled wallpapers: the six Golden Gate 5K time-of-day pictures plus six generated abstracts (replaceable — see Notes) |
| `tests/verify.cjs` | Headless checks for `script.js` and the manifests |
| `macos/DynaWallApp.swift` | Native macOS host: desktop-level windows, WebKit, menu bar settings |
| `macos/make-icon.swift` | CoreGraphics generator for the app icon — the Bauhaus Sunrise mark (one flat dome, one razor horizon), drawn from 16×16 to 1024×1024; `DYNAWALL_ICON_DESIGN=monolith\|arc` re-renders the earlier variants |
| `macos/AppIcon.icns` | Generated icon set (`AppIcon.png` is the 1024×1024 master it ships alongside) |
| `macos/Info.plist` | Bundle metadata (`com.dynawall.macos`, `LSUIElement`) |
| `build-macos.sh` | Zero-dependency `swiftc` build that assembles and signs `dist/DynaWall.app` |
| `build-dmg.sh` | Builds the app, then packs it with an `/Applications` symlink into `dist/DynaWall.dmg` |
| `windows/DynaWall.csproj` | .NET 8 / WinForms project — single-file, self-contained, WebView2, curated wallpapers under `web/` |
| `windows/*.cs` | Native Windows host: tray icon, settings window, WorkerW layering, WebView2 bridge, photo library, installed/imported fonts (`FontLibrary.cs`), Run-key startup, and the observe-only desktop click watch that lets the widget cards answer the mouse (`DesktopClicks.cs`, `WidgetBridge.cs`) |
| `windows/installer.iss` | Inno Setup 6 script for the per-user `DynaWall-Setup.exe` (no UAC prompt) |
| `windows/build-release.ps1` | Publishes `DynaWall.exe`, the portable zip and the installer into `dist/` |
| `windows/app.ico`, `windows/make-icon.cjs` | Windows icon set, generated from the macOS icon master with `sips` |
| `.github/workflows/release.yml` | Tag-driven release, plus the rolling nightly build that keeps installer URLs live |
| `dist/DynaWall.app` | The built menu bar app — checked in, and regenerated by `build-macos.sh` |
| `dist/DynaWall.dmg`, `dist/DynaWall-Setup.exe` | Release outputs (generated, not checked in) |

## Desktop widgets

Four satellites float in a loose ring around the greeting — paper-white line glyphs, drawn as inline SVG so they
weigh nothing and need no network. There is no circle, plate or glass puck behind them: the glyph *is* the button,
which is why it can afford to be big, and the pointer lights it up instead of outlining it. They are thrown out at
random angles and random distances on every launch: `script.js` deals each one a spot that is three rem clear of the
type and never more than eleven rem out from it, never on top of another, so the arrangement changes each time the
wallpaper starts even though it always hugs the type. Each opens one card, and a card is a frosted pane over a
dimmed desktop:

| Satellite | Card | Leaves the wallpaper for |
| --- | --- | --- |
| **Music** | Five stations (Deep focus, Lo-fi beats, Coding mode, Jazz, Piano and rain) plus a search field | `music.youtube.com` |
| **News** | Five Google News desks (Top stories, Technology, World, Business, Science) | `news.google.com` |
| **YouTube** | Trending in your region, a search field, your playlists and Watch Later | `youtube.com` |
| **Weather** | Current conditions, today's high and low, rain chance, wind, humidity and the next six hours — plus six starter cities to click and a Celsius/Fahrenheit switch | — it asks Open-Meteo directly |
Everything on the page is derived from what the card needs: the weather request is built from the place you
picked, parsed defensively (a code it does not know reads *Unsettled* rather than guessing), cached in
`localStorage` with its unit, and sent once when the card opens — there is no polling and no timer. City search
and the Fahrenheit toggle live in the card; the rest of the providers are lists of links that the host opens in
your default browser, because Google publishes no News API, its RSS feed cannot be read from a local page, and a
wallpaper that navigates away from itself is a wallpaper nobody sees again.

Keyboard first: `Esc` closes, `←`/`↑`/`→`/`↓`/`Home`/`End` walk the rows, focus returns to the satellite you
came from, and the card is a real `role="dialog"` with `aria-modal`. It all degrades: no satellites, no widgets,
and the greeting is unaffected.

**The widgets are optional — each one of them.** All four are on by default, and they are switched in the place you
already change everything else: **Desktop widgets** in the macOS popover (one master switch, then a switch per
satellite), **Widgets** in the Windows settings window, and the same five checkboxes in Lively and Wallpaper Engine —
`widgets` for all four, `widgetMusic`, `widgetNews`, `widgetYouTube`, `widgetWeather` for one at a time. For a quick
look there is `index.html?widgets=false` (`?satellites=false` works too) or `?music=false` / `?weather=false` for a
single one, and from the console `DynaWall.setWidgetsEnabled(false)` or `DynaWall.setWidgetEnabled('youtube', false)`.

A satellite that is off is *hidden*, not faded: `hidden` removes it from the layout, so it is never placed, never
measured and never reported to the native host as a click rectangle — that is what hands its corner of the desktop
back to Finder drag-select and icons. The ring is re-dealt around the gap from the same seed, so the surviving three
close up instead of leaving a hole, and a card belonging to a satellite you just switched off is dismissed. The master
switch writes `html.is-widgets-off`, which removes the whole orbit and reports no rectangles at all. Either way the
change is live: no reload, no relaunch, and switching one back on deals it a fresh spot.

**Typing works while a card is open.** The desktop keeps every keystroke for the app you are actually in — the
wallpaper window cannot become key — until a card is opened. For as long as a card is on screen that display
becomes a real, focusable window: mouse events, `.floating` above the Finder icons, key, its `WKWebView` the
first responder. So the two search fields can be clicked into and typed in, `Enter` runs the search, `Esc` closes
the card and `⌘V` works. Close the card — or switch to another app — and the window drops straight back to
desktop level, click-through and unfocused, with the keyboard where it was. Typing is never required either: the
weather card lists six cities (London, New York, San Francisco, São Paulo, Tokyo, Sydney) to click, and once a
city is chosen it is remembered, forecast and all.

**Opening a card on the desktop.** Both native hosts keep the wallpaper click-through — that is what preserves
Finder drag-select, the desktop context menu, icons and Mission Control on macOS, and rubber-band selection on
Windows. So the page never sees the mouse. Instead it reports the rectangles it is willing to take a click in
(`dynawallInteractivity` on macOS, `dynawall:interactivity` on Windows), and the host watches the mouse
system-wide, passes every click on untouched, and replays only the ones that land inside those rectangles with
`window.DynaWall.clickAt(x, y)`. A click on an app window, the Dock, the tray or the settings panel is never
seen by the page, and a card takes the whole viewport while it is open so that a click outside it closes it.
That same report is what unlocks the keyboard on macOS: a card reported open stops the window being
click-through and makes it key, and the host closes the card and puts the window back to sleep the moment another
app comes forward, a link leaves for the browser, or the wallpaper is paused. In a browser, Lively or Wallpaper
Engine the page gets real mouse events and none of this is involved.

## Time-aware palettes

The clock drives more than the greeting. Four bands decide the ink, the accent glow, the text tones and the
photo grade, and the wallpaper moves between them four times a day:

| Band | Hours | Background | Accent glow | Photos |
| --- | --- | --- | --- | --- |
| `dawn` | 05:00–08:59 | `#121020` violet ink | rose | barely warmed |
| `day` | 09:00–16:59 | `#0d1117` neutral | blue | untouched |
| `dusk` | 17:00–20:59 | `#180f0e` warm ink | amber | `sepia` + slightly brighter |
| `night` | 21:00–04:59 | `#070a11` deep blue | indigo | dimmed & desaturated |

- The palette and the greeting are read from the same clock and re-evaluated together whenever the clock
  can actually change them: a one-shot `setTimeout` armed for the exact next edge (05:00 · 09:00 · 12:00 ·
  17:00 · 18:00 · 21:00 local, computed from local date components so DST cannot skip or double one), plus
  on wake and on window focus — so a laptop that slept through sunset wakes up in the right band, and an
  idle afternoon costs six wakeups instead of 2,880 thirty-second polls.
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

## Time-synced photos

With **Match time of day** on (the default, `photoSync=true`) the slideshow becomes a real dynamic desktop:
it only rotates through photos that belong to the band the clock — or the palette you pinned — is on.

```
dawn 05:00–08:59 · day 09:00–16:59 · dusk 17:00–20:59 · night 21:00–04:59
```

A photo is classified from its filename, whether it came from a folder you picked or from the bundle, so the
same rules apply everywhere. The macOS host keeps the name in the URL it hands the page —
`dynawall-photo://photo/<index>/<filename>` — which is all the classifier needs.

| Band | Filename tokens (substring, case-insensitive) |
| --- | --- |
| `dawn` | `dawn`, `sunrise`, `morning`, `mint-fog`, `candy-sky` — plus `light` when the set also has an explicit `day` photo |
| `day` | `day`, `daylight`, `noon`, `midday`, `solar-flare`, `deep-ocean`, `wallpaper-4k` — plus `light` when the set has no `day` photo |
| `dusk` | `dusk`, `sunset`, `evening`, `twilight`, `neon-dusk` |
| `night` | `night`, `midnight`, `dark`, `graphite` |

- `golden-gate` deliberately matches nothing, which is what keeps the six variants of that one scene apart:
  `…-Wallpaper-5K-Light.jpg` (dawn), `…-Day-Wallpaper.jpg` (day), `…-Sunset-Wallpaper.jpg` and
  `…-Evening-Wallpaper.jpg` (dusk), `…-Night-Wallpaper.jpg` and `…-Wallpaper-5K-Dark.jpg` (night).
- A macOS **Light**/**Dark** pair names no hour, so `Light` is the dawn picture when the set also has a `day`
  photo and the daytime one when it does not — otherwise a lone `-Light.jpg` would never be seen between
  09:00 and 17:00.
- **Untagged folders still work**: photos with no recognisable token are dealt out across the four bands in
  order, so `a.jpg`…`e.jpg` become dawn, day, dusk, night, dawn.
- **A missing band borrows its neighbour** rather than showing nothing: night → dusk → dawn → day, dusk →
  day → night → dawn, day → dawn → dusk → night, dawn → day → night → dusk.
- The active band is part of the slideshow signature, so the band changing (clock or palette) restarts the
  rotation on that band's photos and **cross-fades** to them on the spare `<img>` layer — no reload, no flash.
- **Next photo** steps within the active band and wraps; if the band holds a single photo it steps through the
  whole library instead, so the button is never a no-op. The timer restarts, so a manual skip gets a full
  interval.

```js
livelyPropertyListener('nextPhoto', true);   // same action the menu bar button fires
window.DynaWall.nextPhoto();                 // …and from a console
window.DynaWall.classifyPhotos(photos);      // { dawn: [...], day: [...], dusk: [...], night: [...] }
window.DynaWall.getPhotosForSlot(photos, window.DynaWall.getThemeSlot(new Date()));
```

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
| `photoSync` | `true` / `false` — only show photos matching the active band (`photosync`, `timeSync`, `dynamicPhotos` also work) | `?photoSync=false` |
| `interval` | minutes between photos (1–1440) | `?interval=5` |
| `shuffle` | `true` / `false` — random order instead of sequential | `?shuffle=false` |
| `kenBurns` | `true` / `false` — slow zoom | `?kenburns=false` |
| `widgets` | `true` / `false` — the four desktop satellites (`satellites` also works) | `?widgets=false` |
| `music` | `true` / `false` — the music satellite alone (`widgetmusic` also works) | `?music=false` |
| `news` | `true` / `false` — the news satellite alone (`widgetnews` also works) | `?news=false` |
| `youtube` | `true` / `false` — the YouTube satellite alone (`widgetyoutube` also works) | `?youtube=false` |
| `weather` | `true` / `false` — the weather satellite alone (`widgetweather` also works) | `?weather=false` |
| `photos` | comma separated list of image URLs | `?photos=images/03-deep-ocean.jpg` |
| `font` | family name (`fontfamily` also works) | `?font=Georgia` |
| `fonturl` | relative path or `data:` URL of a font file (`customfont` also works) | `?fonturl=assets/fonts/outfit-latin.woff2` |

Example: `index.html?name=Alex&bgColor=%230b0f19` · `index.html?theme=night` pins the night palette.

Preview the slideshow without waiting: `index.html?slideshow=true&interval=1&shuffle=false` rotates
every minute through the bundled photos, and `?photos=images/03-deep-ocean.jpg` pins a single one.
Because `photoSync` is on by default, that rotation stays inside the band the clock is in — add
`&photoSync=false` to see the whole library, or `&theme=dusk&interval=1` to preview a band that is not the
current one.

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

The script builds for the architecture of the Mac running it (arm64 or x86_64) and targets macOS 12+, in one
whole-module optimisation pass with `-dead_strip`, and copies only the twelve curated wallpapers — a 23 MB
bundle with a 426 KB binary. The published DMG is built on an Apple silicon runner; an Intel Mac builds its own
copy with the same script.
`DynaWall` lives in the menu bar — click the icon to open the settings popover, or use **Quit DynaWall**
there to stop it. Because the app is ad-hoc signed, Gatekeeper is happy with locally built copies; if you
move the app to another Mac, re-run `build-macos.sh` on that Mac instead of copying the binary.

### Disk image (.dmg)

```bash
./build-dmg.sh                  # builds the app, then dist/DynaWall.dmg
open dist/DynaWall.dmg          # drag DynaWall.app onto the Applications shortcut
```

`build-dmg.sh` runs `build-macos.sh` first, stages `DynaWall.app` next to a symlink to `/Applications`, and
packs the folder with the built-in `hdiutil` as a compressed read-only **UDZO** image — the standard macOS
drag-and-drop install, with no third-party tooling. It ad-hoc signs the image as well as the app inside, so a
copied DMG is not reported as damaged; because the release is not notarized, the first launch after
downloading still needs **right-click → Open** once. The image carries the app built for the Mac that ran the
script — Apple silicon on the release runner.

### How it works

| Concern | Implementation |
| --- | --- |
| Layering | One borderless `NSWindow` per display at `CGWindowLevelForKey(.desktopWindow)` — above the desktop picture, below the Finder icons |
| Click-through | `ignoresMouseEvents = true` and a `DesktopLevelWindow` that can only become key while a card is open, so Finder icons, drag-select and Mission Control keep working |
| Card focus | A card reported open flips `DesktopLevelWindow.isInteractive`, lifts the window to `.floating`, un-ignores the mouse, makes it key and its `WKWebView` first responder (typing, `⌘V`, `Esc`); closing it — or another app coming forward, a link, or Pause — drops it back to desktop level and click-through, and hands activation back with `NSApp.deactivate()` |
| Widgets | The page reports its clickable rectangles over `dynawallInteractivity`; a global `NSEvent` mouse monitor (observe-only, never consuming) replays a click that lands inside one with `window.DynaWall.clickAt(x, y)`, and skips anything in front of the desktop by asking `CGWindowListCopyWindowInfo` for layer-0 windows. Links come back over `dynawallOpenURL` and open in the default browser — only `https` is accepted |
| Spaces & full screens | `collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]` |
| Rendering | A `WKWebView` per display loading the bundled `index.html`, `style.css` and `script.js` |
| Photos | The host resolves the standard `~/Pictures/DynaWall` folder or the folder you pick and hands the page `dynawall-photo://photo/<n>/<filename>` URLs; a `WKURLSchemeHandler` serves those files, so the web view stays sandboxed to exactly the images you picked. The filename rides along so `script.js` can match a photo to the time of day |
| Multi-monitor | `NSApplication.didChangeScreenParametersNotification` rebuilds the windows (only when the layout actually changed) |
| Sleep/wake | `NSWorkspace.didWakeNotification` re-pushes the settings and asks the page to re-evaluate its greeting and pick a fresh photo |
| Live settings | Every change is pushed straight into the page with `window.livelyPropertyListener(...)` — the exact same bridge Lively uses, so both hosts share one configuration code path. Pushes are diffed per window: typing a subtitle sends a few hundred bytes, not the photo array again |
| First paint | The host also injects `window.__dynawallSeed` at `documentStart`, so the very first frame already carries your name, palette and photo; the page deletes the seed once it has read it |
| Suspension | Occlusion, display sleep, system sleep, session lock and **Pause** all park the page: `classList.add('is-suspended')` pauses the Ken Burns drift in CSS, and the clock and slideshow timers are cleared instead of firing into a hidden window |
| Persistence | `UserDefaults` in the `com.dynawall.macos` domain. The greeting name is not stored: it is computed from the logged-in macOS account, and a `firstName` override left by an earlier build is deleted on launch |
| Zero flash | The window stays at `alphaValue = 0` until the page has loaded and the settings have been applied, then fades in |

Every launch — and every settings push — greets you by your macOS account name: `NSFullUserName()` first
(e.g. `Froilan Banaticla` → `Froilan`), `NSUserName()` when the account has no full name, and `Developer`
only when neither names the account. The name is normalised with the same rules `script.js` applies, so
`Good morning, Froilan.` is identical in the popover and on the desktop. The **Auto (time of day)** palette
is the default, so the wallpaper arrives already matching the light outside. The band is checked on a
one-shot timer armed for the exact next boundary — four wakeups a day (05:00 · 09:00 · 17:00 · 21:00 local,
resolved with `date(bySettingHour:)` so DST cannot drift it) instead of 1,440 minute-polls — and again on
wake, on `NSSystemClockDidChange` and on `NSCalendarDayChanged`, so the surface behind the page never lags
the palette.

### Menu bar settings

Clicking the menu bar icon opens a 340 pt popover that mirrors the desktop instead of listing settings, and
that sizes itself to whatever is on screen. **Right-click** (or Control-click) the same icon for a
quick-action menu that does the everyday things without opening the popover — **Next Photo** (`⌘N`),
**Pause Wallpaper** / **Resume Wallpaper** (`⌘P`), **Open Wallpapers in Finder** (`⌘O`),
**Settings…** (`⌘,`), **Launch at Login** (ticked while it is on) and **Quit DynaWall** (`⌘Q`). Both surfaces
answer with a haptic tick (`NSHapticFeedbackManager`, `.alignment` / `.levelChange`) when they change
something, so the menu bar confirms a click the way the trackpad does. The menu is built once and rewritten
from the live model every time it opens (title, enabled state, tick marks), so it can never describe a state
the wallpaper is not in — **Next Photo** stays greyed out while the slideshow is off or the folder is empty,
and **Open Wallpapers in Finder** follows the folder actually in use.

Inside the popover:

- **Live preview card.** The top card paints the exact background the wallpaper is using — the active band's
  ink plus its radial accent — with the greeting the page is rendering (`Good morning, Froilan.`), your
  subtitle, a time-of-day badge (`Dawn`, `Day`, `Dusk`, `Night` or `Paused`) and the photo currently on screen.
  The photo is shown, not named: the host decodes a 720 px thumbnail of the very URL the wallpaper is painting
  (ImageIO, EXIF orientation applied, off the main thread) and cross-fades it in behind the card's type, so the
  preview really is the desktop in miniature. A photo that never decodes simply leaves the card on its palette.
  The greeting and subtitle are set in the wallpaper's own family — **Outfit** until you pick another — at its
  600/400 weights and CSS tracking, tinted with the active band's `--text-primary` / `--text-secondary`, and
  centred in the card the same way `.wallpaper-content` is centred on screen — so the card and the desktop read
  as one design.
  **Pause** / **Resume** sits right on the card, and the badge turns into `Paused` while the wallpaper is
  detached. The greeting name is never something you type: it is read from the logged-in macOS account on
  every push (`NSFullUserName()` → `NSUserName()`), so type in **Subtitle** and the card follows the
  keystrokes while the name stays the person actually using the Mac.
- **Visual palette.** Dawn, Day, Dusk, Night, GitHub Dark and Deep Slate are clickable swatches painted with
  the ink they apply, next to a live colour well. The **Auto (follow the clock)** pill hands the palette back
  to the clock and names the band it is on (`Day · 09:00–17:00`). Picking a colour in the well selects **Custom
  color** immediately — no dropdown to change first.
- **Progressive disclosure.** The slideshow controls (time-of-day matching, interval, shuffle, slow zoom) only
  appear while **Photo slideshow** is on; dropping a folder turns it on for you, and the controls that would
  otherwise be greyed out are simply not shown.
- **Desktop widgets.** One master switch for the four satellites plus a switch each (Music, News, YouTube, Weather),
  all on by default. A satellite that is off is removed rather than faded — the page hides it, stops reporting a
  click rectangle for it and re-deals the ring around the gap — and its card closes; the master switch takes all four
  off the desktop at once. Either way it is live, and Finder drag-select is untouched.
- **Standard folder.** On first launch DynaWall creates `~/Pictures/DynaWall` and copies the twelve bundled
  wallpapers into it. The Photos card reads that folder by default, so adding or removing images in Finder
  changes what rotates without opening Settings; **Change Folder…** points the wallpaper at any other folder,
  **Reveal in Finder** (⇗, tooltipped with the folder name) drops to the active folder itself (so you can add or
  delete a picture and the rotation picks it up), and **Reset** returns to the standard one. If the active folder
  has no supported images, the wallpaper falls back to solid black and the slideshow options stay disabled.
- **Drag and drop.** The folder row accepts a folder of images dragged from Finder: it becomes the active
  folder, the slideshow starts, and the row shows the folder name and how many photos it found. The row lifts,
  glows and casts a shadow while a folder hovers over it, and the drop lands with the same haptic tick as the
  rest of the popover.
- **Typography.** A **Typography** card sets the greeting and subtitle in one of the four faces DynaWall ships
  — **Outfit** (the default), **Google Sans Flex**, **Space Grotesk** or **Geist** — each chip drawn in its own
  face, so the choice previews itself. Every other family belongs to the system: **System font…** lists what
  Font Book has installed. **Add Font…** imports a downloaded `.ttf`, `.otf`, `.ttc`, `.woff` or `.woff2` without
  installing it system-wide: DynaWall copies the file into `~/Library/Application Support/DynaWall/Fonts`,
  registers it with CoreText, and reads the family name out of the file so the popover preview and the desktop
  use the same face. Every stack still tails into the bundled Outfit, so a font that is later uninstalled,
  renamed or deleted degrades to the shipped look instead of a blank greeting. The picker is the card's only
  text: it stays on one line (a long family name truncates in the middle, with the full name on hover),
  because the popover is sized from its measured content — a second line would grow the panel and shift
  every card below it under the pointer.
- **Startup.** A native **Launch at login** switch registers DynaWall with macOS (`SMAppService`) so it starts automatically when you log in, without having to open System Settings manually.
- **Reset** in the footer restores the default subtitle, palette, slideshow, sync and widget settings in one
  click, and returns the photo source to `~/Pictures/DynaWall`.

| Control | Key | Effect |
| --- | --- | --- |
| Live preview card | — | Active ink + accent, the live greeting and subtitle, band/`Paused` badge, photo name, and a Pause/Resume pill in place |
| Greeting name | — | Read dynamically from the logged-in macOS account (`NSFullUserName()` → `NSUserName()`, and `Developer` only when the account names neither) and normalised exactly like the page (first word, trailing punctuation dropped); there is nothing to type, and any name stored by an earlier build is removed on launch |
| Subtitle | `subtitleText` | Subtitle line; the `×` button clears it, which hides the line |
| Auto (follow the clock) | `themePreset` | Hands the palette back to the clock and shows the band it is on (`Day · 09:00–17:00`) |
| Palette swatches | `themePreset` | Dawn/Day/Dusk/Night pin one band; GitHub Dark `#0d1117` and Deep Slate `#0b0f19` ride the neutral palette |
| Custom color | `customBgColor` | The colour well is always live: picking a colour selects **Custom color** and pins it at once |
| Photo slideshow | `slideshowEnabled` | Rotate photos behind the greeting; the controls below only appear while it is on |
| Folder row | `photoFolderPath` | The folder to rotate. Defaults to `~/Pictures/DynaWall`, seeded from the bundled wallpapers the first time it is created; **Change Folder…** picks another folder, dropping a folder switches to it, and **Reveal in Finder** opens it. The row reports the folder name and its photo count |
| Quick-action menu | — | **Right-click / Control-click** the menu bar icon for **Next Photo** (`⌘N`), **Pause**/**Resume Wallpaper** (`⌘P`), **Open Wallpapers in Finder** (`⌘O`), **Settings…** (`⌘,`), **Launch at Login** (ticked while on) and **Quit DynaWall** (`⌘Q`) — the popover's own actions, without opening it |
| Match time of day | `photoSyncTimeOfDay` | **On** by default: only show the photos whose filename matches the active band, and cross-fade when the band changes. Off cycles the whole folder |
| Rotate every | `slideshowIntervalMinutes` | 1, 5, 15, 30 or 60 minutes |
| Shuffle | `slideshowShuffle` | Random order instead of file-name order |
| Slow zoom | `kenBurns` | Drift/zoom each photo for the length of its turn |
| Next | — | Skip to the next photo now and restart the interval (shown while the slideshow is on) |
| Font | `fontFamily` | Typography chips (**Outfit**, **Google Sans Flex**, **Space Grotesk**, **Geist** — the bundled faces), a **System font…** menu listing every family in Font Book, and **Add Font…** for a downloaded file |
| Add Font… | `customFont` | Copies the picked `.ttf`/`.otf`/`.ttc`/`.woff`/`.woff2` (up to 4 MB) into Application Support, applies its family and pushes the bytes to the page as a `data:` URL |
| Pause / Resume | — | Detaches the wallpaper from the desktop (the menu bar icon dims) |
| Desktop widgets | `desktopWidgets` | **On** by default: the four satellites (music, news, YouTube, weather) scattered around the greeting. Off removes them — and their click rectangles — so the desktop is the wallpaper alone. The four switches in the 2×2 grid under it (`desktopWidgetMusic`, `desktopWidgetNews`, `desktopWidgetYouTube`, `desktopWidgetWeather`) take one satellite off on its own |
| Launch at login | `launchAtLogin` | Starts DynaWall automatically on login (registered with macOS via `SMAppService`) |
| Reset | — | Restores the default subtitle, palette (`Auto`), slideshow, interval, shuffle, slow zoom and all five desktop-widget switches, and returns the photo folder to `~/Pictures/DynaWall` |
| Quit | — | Stops the app |

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
# [DynaWall] font: Outfit @ 90.240005px width=949 face=loaded
# [DynaWall] photo library: Folder: 12 photo(s) from …/Pictures/DynaWall
# [DynaWall] slideshow advanced: dynawall-photo://photo/1/iClarified-macOS-27-Golden-Gate-Day-Wallpaper.jpg (4096x2160)
# [DynaWall] slideshow: on=1 photo=dynawall-photo://photo/1/iClarified-macOS-27-Golden-Gate-Day-Wallpaper.jpg size=4096x2160 layers=2
# [DynaWall] photo collection: Custom folder… sync=time-of-day
```

`slideshow advanced:` names the file that was put on screen, so the time-of-day match (`…-Day-Wallpaper.jpg`
at 10:00, `…-Sunset-Wallpaper.jpg` at 18:00) can be verified from a terminal, and `next photo requested`
appears each time the popover button — or the right-click menu item — is pressed. `revealed photo folder in
Finder:` records the folder handed to Finder, `wallpaper paused` / `wallpaper resumed` the pause state, and
`registered login item with SMAppService` the **Launch at Login** switch, so every quick action leaves a trace.
`font:` names the family the page asked for, the width the
greeting actually measured with it and the state of the `@font-face` behind it — `face=loaded` for one of the
four bundled faces, `face=<null>` for a system font or a name nothing can resolve — so a build can prove which
typeface reached the screen without a screenshot.

### Good to know

- The app is not sandboxed (it does not need to be) and never requests screen-recording, camera or
  microphone access. The widget click watch is an observe-only mouse monitor, which needs no accessibility
  grant either: if macOS ever withholds it, the wallpaper simply stays decorative and nothing else changes.
- Settings changes while the app is closed are picked up on the next launch; changes in the popover apply
  immediately.
- `defaults delete com.dynawall.macos` resets every macOS-side setting.
- The standard photo folder is `~/Pictures/DynaWall`. DynaWall creates it and seeds it from the bundled
  wallpapers the first time; deleting the folder makes it recreate and reseed, while emptying it keeps the
  solid-black fallback.
- Imported fonts are copied to `~/Library/Application Support/DynaWall/Fonts`; deleting that folder makes
  DynaWall fall back to the bundled Outfit (the family is still stored, so reselect a preset afterwards).
- Want it at login? Turn on **Launch at login** in the menu bar popover (or manage it in **System Settings → General → Login Items**).

## Windows app (native)

`windows/` is a native Windows host: a .NET 8 WinForms tray application that puts one Microsoft Edge
WebView2 window per display behind the desktop icons. There is no Electron and no bundled Chromium — the
WebView2 runtime is the evergreen component already present on Windows 11 and Windows 10 1809+, and the app
itself ships as a single self-contained `DynaWall.exe` plus its `web/` wallpaper folder.

### Requirements

- Windows 10 1809+ or Windows 11, 64-bit
- Microsoft Edge WebView2 (pre-installed; the installer warns and links to it if missing)
- .NET 8 SDK to build, plus Inno Setup 6.3+ for the installer (`choco install innosetup`)

### Build & run

```powershell
cd windows
dotnet publish -c Release -r win-x64 -o publish
.\publish\DynaWall.exe
```

Or build everything the release ships:

```powershell
.\windows\build-release.ps1 -Version 1.0.0
# dist\DynaWall-Setup.exe          per-user installer, no UAC prompt
# dist\DynaWall-Windows-Portable.zip   DynaWall.exe + web\ in one folder
```

Run `DynaWall.exe` straight from the zip — it needs the `web\` folder next to it — and it writes settings,
the log and the WebView2 profile to `%LOCALAPPDATA%\DynaWall\`, whether it was installed or unzipped. The
installer places it in `%LOCALAPPDATA%\Programs\DynaWall`, creates Start Menu (and optionally Desktop)
shortcuts, and can register it to start when you sign in.

### How it works

| Concern | Implementation |
| --- | --- |
| Layering | `FindWindow("Progman")` + `SendMessageTimeout(0x052C)` asks Explorer to spawn the wallpaper `WorkerW`; each window is parented to the `WorkerW` below `SHELLDLL_DefView` with `SetParent`, so desktop icons stay on top |
| Rendering | One borderless WebView2 window per display, loading `web/index.html` from the `https://dynawall.local/` virtual host |
| Desktop interaction | The windows are `WS_EX_NOACTIVATE` children of the wallpaper layer, below the icon view — clicks, rubber-band selection and the desktop context menu keep working, and nothing appears in Alt+Tab |
| Widgets | The page reports its clickable rectangles with `chrome.webview.postMessage({ type: 'dynawall:interactivity' })`; a `WH_MOUSE_LL` watch (`DesktopClicks.cs`, observe-only — every event goes straight to `CallNextHookEx`) replays a click that lands on the desktop layer and inside one of them with `window.DynaWall.clickAt(x, y)`. Links arrive as `dynawall:open-url` and are shell-executed to the default browser; only `https` is accepted |
| Photos | The twelve curated wallpapers are served from `web/images/`; **Change…** maps `https://dynawall-photos.local/` to that folder, keeping each filename in the URL so `script.js` can match it to the time of day (and **Reveal** opens that folder, or `web/images/` when the bundled set is in use) |
| Multi-monitor | One window per `Screen.AllScreens`, rebuilt when `SystemEvents.DisplaySettingsChanged` fires |
| Sleep/wake | `PowerModes.Suspend/Resume` and session lock/unlock park the page and re-push settings and photos on resume |
| Live settings | Every change is pushed with `window.livelyPropertyListener(...)` — the exact bridge the macOS app and Lively use |
| First paint | `AddScriptToExecuteOnDocumentCreatedAsync` seeds `window.__dynawallSeed` before the page parses, so the first frame already carries your name, palette and photo |
| Suspension | **Pause**, a locked session and sleeping displays send `livelyPropertyListener("suspend", true)`, which parks the clock, slideshow and Ken Burns drift |
| Persistence | `%LOCALAPPDATA%\DynaWall\settings.json`; the WebView2 profile lives in `%LOCALAPPDATA%\DynaWall\WebView2\` |
| Explorer restart | A 15-second watchdog rebuilds the windows when the `WorkerW` layer disappears or Explorer restarts, and keeps retrying if the desktop was not ready at sign-in |

### Tray menu

| Item | Effect |
| --- | --- |
| Settings… | Greeting, typography, palette, photo folder, slideshow and startup controls (double-clicking the tray icon does the same) |
| Next photo | Skips to the next photo now and restarts the interval |
| Pause / Resume | Parks the wallpaper at 0 FPS without quitting |
| Start with Windows | Adds or removes the per-user `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` entry |
| Exit | Stops the app (closing Settings leaves the wallpaper running) |

Settings apply live: the window writes `settings.json`, pushes the changed values into every WebView2 and
re-scans the folder if the photo source changed. The window is the same panel the macOS app shows — a live
miniature of the desktop on top (the band's background and glow, the greeting the page is painting, what the
photos are doing, and a **Pause**/**Resume** pill), then one rounded card per topic. The photo options — the
**Rotate every** pills (1m, 5m, 15m, 30m, 1h), shuffle, slow zoom and time-of-day matching — only appear while
the slideshow runs, so the card stays short when it is off. A **Widgets** card holds the master switch for the
four desktop satellites and, while it is on, one switch each (**Music**, **News**, **YouTube**, **Weather**).
**Reset** restores the shipped subtitle, palette,
slideshow, sync and widget settings but keeps your folder. The **Typography** card lists the quick picks (**Outfit**, **Google Sans
Flex**, **Space Grotesk**, **Geist** — the bundled faces) plus every family installed in Windows, and **Add
font…** copies a downloaded `.ttf`/`.otf`/`.ttc`/`.woff`/`.woff2` (up to 4 MB) into
`%LOCALAPPDATA%\DynaWall\Fonts` and sends its bytes to the page as a `data:` URL — the file stays put even if you
delete the original download.

### Diagnostics

Logs go to `%LOCALAPPDATA%\DynaWall\dynawall.log` (one 512 KB generation is kept):

```text
2026-01-15 10:00:00 [DynaWall] started with 1 display(s); settings at …\DynaWall\settings.json
2026-01-15 10:00:00 [DynaWall] photo library: bundled wallpapers from …\web\images
2026-01-15 10:00:01 [DynaWall] desktop windows: 1 for 1 display(s)
2026-01-15 10:00:01 [DynaWall] web view starting on display 1/1 (2560×1440)
2026-01-15 10:00:02 [DynaWall] wallpaper page ready
```

### Good to know

- `DynaWall.exe` is not code-signed, so SmartScreen may ask once — **More info → Run anyway**.
- Delete `%LOCALAPPDATA%\DynaWall\settings.json` to reset every Windows-side setting.
- A custom folder with no supported images falls back to the bundled wallpapers, exactly like the web page.
- The wallpaper runs without administrator rights; the installer is per-user for the same reason.
- Uninstalling removes the program, shortcuts and Run entry but keeps `%LOCALAPPDATA%\DynaWall\` — delete
  that folder to remove settings, logs, imported fonts and the WebView2 profile as well.

## Lively Wallpaper

1. **Add Wallpaper → Browse…** and select `index.html`, or zip the folder and drag it into Lively.
2. Right-click the wallpaper → **Customize** to edit the controls from `LivelyProperties.json`.

| Lively control | Type | Effect |
| --- | --- | --- |
| `firstName` | textbox | Name used in the greeting (`Developer` by default); clearing the field resets it to `Developer` |
| `subtitleText` | textbox | Subtitle line; leave empty to hide it |
| `theme` | dropdown | `Auto (time of day)`, the four bands, or `Custom color` |
| `bgColor` | color | Background color, used by the `Custom color` theme |
| `slideshow` | checkbox | Rotate photos behind the greeting |
| `photoSync` | checkbox | Only show photos whose filename matches the active time-of-day band (on by default) |
| `slideshowInterval` | slider | Minutes between photos (1–120, default 15) |
| `slideshowShuffle` | checkbox | Random order |
| `kenBurns` | checkbox | Slow zoom on each photo |
| `widgets` | checkbox | All four desktop satellites (music, news, YouTube, weather); on by default, off leaves the wallpaper alone |
| `widgetMusic` | checkbox | The music satellite alone |
| `widgetNews` | checkbox | The news satellite alone |
| `widgetYouTube` | checkbox | The YouTube satellite alone |
| `widgetWeather` | checkbox | The weather satellite alone |
| `fontFamily` | textbox | Family for the greeting and subtitle — `Outfit` (default), `Google Sans Flex`, `Space Grotesk`, `Geist`, an installed family, or a family the native hosts imported; clearing the field puts it back in `Outfit` |

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
| `photosync` | checkbox | Only show photos whose filename matches the active time-of-day band (on by default) |
| `slideshowinterval` | slider | Minutes between photos (1–120, default 15) |
| `slideshowshuffle` | checkbox | Random order |
| `kenburns` | checkbox | Slow zoom on each photo |
| `widgets` | bool | All four desktop satellites (music, news, YouTube, weather); on by default, off leaves the wallpaper alone |
| `widgetmusic` | bool | The music satellite alone |
| `widgetnews` | bool | The news satellite alone |
| `widgetyoutube` | bool | The YouTube satellite alone |
| `widgetweather` | bool | The weather satellite alone |
| `fontfamily` | text input | Family for the greeting and subtitle (default `Outfit`; `Google Sans Flex`, `Space Grotesk` and `Geist` ship with the wallpaper); empty resets to `Outfit` |

Values arrive through `window.wallpaperPropertyListener.applyUserProperties(...)`; colors are converted
from Wallpaper Engine's `"r g b"` floats to hex automatically.

## Releases

`.github/workflows/release.yml` publishes two download channels:

| Trigger | Release | Stable URLs |
| --- | --- | --- |
| Push to `main`, or a manual run | `nightly` pre-release, refreshed in place | `/releases/download/nightly/DynaWall.dmg` · `…/DynaWall-Setup.exe` · `…/DynaWall-Windows-Portable.zip` |
| Push a `v*` tag | stable release; `/releases/latest` points at it | `/releases/latest/download/…` for the same three files |

```bash
git tag v1.0.0
git push origin v1.0.0        # builds and attaches the DMG, setup and portable zip
```

| Job | Runner | Produces |
| --- | --- | --- |
| macOS DMG | `macos-latest` | `DynaWall.dmg` (Apple silicon, macOS 12+) |
| Windows | `windows-latest` | `DynaWall-Setup.exe`, `DynaWall-Windows-Portable.zip` |
| Publish | `ubuntu-latest` | uploads all three to the tag release, or refreshes `nightly` |

Both build jobs run `node tests/verify.cjs` first, so a release can never ship a wallpaper that fails the
suite. The macOS job then runs `build-dmg.sh` and checks the image with `hdiutil verify`, `codesign --verify`
and `lipo -archs`; the Windows job installs Inno Setup and runs `windows/build-release.ps1`. The publish job
uses `gh release create` / `gh release upload --clobber`, so re-running a tag replaces the files instead of
failing, while the `nightly` tag and its asset names never change. Runs are serialised per ref, so two pushes
to `main` cannot clobber each other's nightly build, and the run page's summary repeats the download links.

## Configuration priority

1. **Host IPC** — Lively or Wallpaper Engine values
2. **Host seed** — `window.__dynawallSeed`, which the macOS and Windows hosts inject at document start. It is
   the same values as the IPC push, delivered early so the first paint is already correct; the page deletes it
   once it has been read, and a later `livelyPropertyListener` still wins
3. **URL query parameters**
4. **`localStorage` cache** — `dynawall.firstName`, `dynawall.subtitle`, `dynawall.bgColor`,
   `dynawall.theme`, `dynawall.slideshow`, `dynawall.slideshowInterval`, `dynawall.slideshowShuffle`,
   `dynawall.kenBurns`, `dynawall.photoSync`, `dynawall.widgets`, `dynawall.widgetMusic`,
   `dynawall.widgetNews`, `dynawall.widgetYouTube`, `dynawall.widgetWeather`, `dynawall.fontFamily` (the family
   only — an imported font file is never cached, the host re-reads it and re-sends it as a `data:` URL on every load)
5. **Built-in defaults** — `Developer`, `What are we building today?`, `#0d1117`, palette on `auto`,
   slideshow off, 15 minutes, shuffled, slow zoom on, photos matched to the time of day, all four widgets on

The photo list is the one exception: `photos` is never cached, because the host resolves it fresh on every
load (and the page falls back to `images/` when nobody sends one). `suspend` is not a setting at all — it is a
live host flag, so it is neither exposed in any customization panel nor written to `localStorage`.

Each field resolves independently, so a host that only exposes the background colour still picks up the name from the URL.
The one interaction to know about: a colour with no theme beside it pins `custom` (a colour on its own means
"stop following the clock"), while naming a theme in the same layer wins.

> Inside Lively or Wallpaper Engine the host sends its saved values on load, so host settings take
> precedence over URL parameters — that is the intended hierarchy. The native macOS app is a host too:
> it seeds the page at `documentStart` and then pushes its `UserDefaults` values through
> `livelyPropertyListener` as they change, so they win over the URL and the cached values.

## Notes

- Four faces ship in `assets/fonts`, all SIL OFL 1.1 and all latin subsets, so the typography presets work
  with no install and no network: [Outfit](https://fonts.google.com/specimen/Outfit) (the default — a geometric
  sans by Rodrigo Fuenzalida), [Google Sans Flex](https://fonts.google.com/specimen/Google+Sans+Flex),
  [Space Grotesk](https://fonts.google.com/specimen/Space+Grotesk) and
  [Geist](https://fonts.google.com/specimen/Geist). Each is one variable WOFF2 for the page plus a static
  Regular/SemiBold TTF pair for the native preview cards, with its license beside it (`OFL-*.txt`). Dropping in
  a new WOFF2 and editing its `@font-face` rule in `style.css` re-skins the wallpaper — nothing else has to
  change. Names with characters outside the latin subset (Cyrillic, CJK, …) fall back to the system face for
  those glyphs only, thanks to the `unicode-range` on each rule.
- Those four are the **presets**, not the limit: the native hosts (and the `font`/`fonturl` URL parameters, and
  the host manifests) can name any family installed on the machine, or hand over an imported font file as a
  `data:` URL that the page registers with `document.fonts`. `applyTypography()` rewrites the `--font-sans`
  token on `<html>` rather than any rule, so the stylesheet still declares the shipped stack and Outfit stays
  the tail of every generated stack — a family that is missing, renamed or uninstalled lands back on the
  vendored face instead of leaving the greeting blank. The bundled list lives in three places that the tests
  keep in step: `BUNDLED_FONT_FAMILIES` in `script.js`, `WallpaperFont.bundledFamilies` in the macOS app and
  `Preferences.BundledFontFamilies` in the Windows app. Font family names are cleaned the same way in all
  three (quotes, backslashes, braces, semicolons and angle brackets removed, whitespace collapsed, 80
  characters max).
- **Typography**: the display scale is tuned for a wide geometric face rather than left at browser defaults —
  the greeting is tracked in (`-0.03em`, because Outfit's round forms open up at 90 px), leads at `1.06`
  instead of the default heading `1.15`, balances its line breaks (`text-wrap: balance` + `hyphens: none`, so
  long names wrap between words, never mid-word), and the subtitle gets matching treatment the other way
  round: `+0.012em` tracking, `1.5` leading and a `46ch` measure cap. `font-synthesis: none` keeps every
  weight real (the vendored files cover 100–900, except Space Grotesk, which stops at 700), and
  `font-kerning: normal` plus `common-ligatures contextual` are enabled explicitly.
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
- **Slideshow**: twelve wallpapers ship in `images/` — the six Golden Gate 5K time-of-day pictures
  (Light/Day/Sunset/Evening/Night/Dark, `iClarified-macOS-27-Golden-Gate-*.jpg`) and six generated abstracts
  (soft mesh gradients, 2560×1440, ~780 KB total), all free to replace. The folder also holds 4K, alternate-5K
  and HEIC versions of the same Golden Gate scenes; nothing rotates through them and `build-macos.sh` does not
  copy them, so the app bundle is 23 MB rather than 35 MB. Swapping the twelve means editing
  `GOLDEN_GATE_PHOTOS` / `ABSTRACT_PHOTOS` in `script.js` (and `CURATED_PHOTOS` in `build-macos.sh`, which
  `tests/verify.cjs` keeps in sync) — or, in the macOS app, pointing **Folder → Choose…** (or dropping a folder
  on that row) at any folder (jpg, png, heic, webp, gif, bmp, tiff; the same folder on every display). Two
  stacked `<img>` layers
  cross-fade, so a slide never flashes empty, and a photo that fails to decode is skipped instead of leaving
  a blank frame. When the only picture a band has is unreadable, the slideshow widens to the whole folder
  before it gives up on photos, so one corrupt file cannot black out a desktop that has other images.
- **Time-of-day names**: the classifier reads the filename, so a folder works out of the box if its pictures
  are named after the hour they belong to (`dawn`, `day`, `sunset`, `night`, …); untagged folders are dealt
  across the four bands instead of being ignored. `photoSync=false` (or **Match time of day** off) hands the
  whole library back to the slideshow.
- The scrim behind the greeting is built from three low-alpha layers — an elliptical pool of ink under the type,
  a top/bottom falloff for the menu bar and the Dock, and a floor wash — so the dim is perceptual rather than a
  flat 22% slab: about 0.46 alpha at the deepest point behind the greeting, easing out by 84% so the corners
  stay around 0.26–0.32. The picture keeps its colour and the type keeps its contrast. It only appears while a
  photo is showing, and text shadows are added at the same time, so the minimal background keeps its pure look.
- Type is set with `font-variant-ligatures` and `font-feature-settings` (`cv02`, `cv03`, `cv04`, `cv11`, `ss01`)
  plus `text-rendering: optimizeLegibility` on the greeting and subtitle, so the vendored faces use their own
  kerning, ligatures and alternates instead of the browser's defaults (a face without a tag simply ignores it).
- **Ambient aura.** `.wallpaper-container::before` paints three gradients — the band's accent as a halo behind the
  greeting, a second bloom low in the frame and a soft edge vignette — above the photo stack and the scrim but
  below the type, so the picture is framed by the hour's light rather than covered by it. It breathes on a 34 s
  opacity/scale cycle that runs on the compositor (no `will-change`, no filter, no backdrop blur), is parked with
  `animation-play-state` whenever the page is suspended (`html.is-suspended`, display sleep, occlusion, **Pause**)
  and is switched off entirely under `prefers-reduced-motion: reduce`.
- **Palette**: the four bands are pure CSS custom properties under `[data-theme]`, so `script.js` only swaps
  one attribute on `<html>` — the background, accent glow, text tones and photo grade all change together
  and CSS does the interpolating. `prefers-reduced-motion: reduce` collapses the 2.4 s palette fade to 1 ms
  (the band still changes, it just does not animate), and nothing about the palette touches layout.
- The subtitle over a photo is the band's own primary ink at 74% opacity rather than a hard-coded white, so
  it dims with the palette instead of glowing in the dark.
- `prefers-reduced-motion: reduce` also disables the Ken Burns drift; photos still rotate.
- **Idle cost**: nothing polls. The page and the host each arm one timer for the next boundary that can
  actually change the greeting or the palette; `applyTheme()` looks its band colour up in `THEME_BG_HEX`
  instead of reading `getComputedStyle()`, which used to force a style recalculation on every tick;
  `will-change` is scoped to the entrance fade and the visible photo, so a settled wallpaper owns no
  compositing layer; the wallpaper subtree is `contain: layout style paint`, so a slide cannot invalidate the
  rest of the page; and `offsetWidth` is only read when a drift really has to restart on the same layer. On a
  hidden or occluded window (`visibilitychange`, occlusion, display sleep, session lock, **Pause**) the timers
  are cleared and the drift is paused with `animation-play-state`, so an idle desktop stays idle.

## Verification

```bash
node --check script.js
node tests/verify.cjs
python3 -m json.tool LivelyProperties.json > /dev/null   # likewise LivelyInfo.json / project.json
```

`tests/verify.cjs` covers the greeting boundaries (04:59, 05:00, 11:59, 12:00, 17:59, 18:00, 00:00, 23:59),
the greeting copy, value normalization, the five-tier hierarchy (IPC → host seed → URL → `localStorage` →
defaults), both IPC bridges, the slideshow (interval clamping, photo list sanitising, bundled files present),
the palette (band boundaries at 05:00 / 09:00 / 17:00 / 21:00, theme normalization incl. Lively's indices, the
colour-pins-`custom` rule, a full token set per `[data-theme]` block, and that the macOS hexes and hours match
the CSS), the time-synced photo classification (Golden Gate and abstract filenames, Light/Dark pairs,
percent-encoded host URLs, untagged folders, adjacent-band fallback), `photoSync` resolution across IPC / URL /
`localStorage` / both manifests, the band → photo-pool transition at each edge (the band is part of the
slideshow signature, so a swap cross-fades instead of blinking), the `nextPhoto` action and pool stepping
(wrap, shuffle, no repeat), that the clock controls are gone, the widget settings (the master `widgets` switch and
one flag per satellite — `widgetMusic`, `widgetNews`, `widgetYouTube`, `widgetWeather` — on by default and resolvable
from IPC / URL / cache / seed / both manifests, with a hidden satellite removed from the layout, unreported as a click
region and re-dealt around), and the consistency of the host manifests with `script.js`.

The distribution checks cover the DMG pipeline (`build-dmg.sh`, UDZO, the `/Applications` symlink and the
ad-hoc signature), the Windows project (net8.0-windows, single-file self-contained publish, WebView2), the
WorkerW desktop layering, the shared `livelyPropertyListener` / seed bridge, the per-user Inno Setup installer,
photo-list parity for `windows/DynaWall.csproj`, and the release workflow — including the rolling nightly
release and the README links that point at it.

The efficiency guards are checked the same way, because none of them is visible in a screenshot: the clock is
a one-shot timer armed on each of the six daily boundaries (midnight wrap included, computed from local date
components) with no `setInterval` left anywhere; suspension clears both timers, pauses the drift in CSS and is
never cached as a setting; `applyTheme()` contains no `getComputedStyle()` and its `THEME_BG_HEX` table still
matches every `[data-theme]` block; `normalizePhotos()` de-duplicates with a `Set`; `classifyPhotos()` serves a
memoised result that still notices an in-place edit; `paintPhoto()` reads `offsetWidth` once, and only when a
drift has to restart on the same layer; exactly three `will-change` declarations exist (the entrance fade, its
`auto` reset, and the visible photo) over a `contain`ed subtree; the host seeds the page at `documentStart`,
registers the occlusion / display-sleep / session observers, diffs its pushes, keeps one-shot boundary timers
and builds its popover lazily; and `build-macos.sh` copies exactly `GOLDEN_GATE_PHOTOS + ABSTRACT_PHOTOS`.

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
livelyPropertyListener('firstName', '');      // cleared field resets to Developer (no stuck letter)
livelyPropertyListener('theme', 'night');     // palette cross-fades over 2.4 s, no reload
livelyPropertyListener('bgColor', '#221133'); // a colour alone pins the custom palette
livelyPropertyListener('theme', 'auto');      // back to following the clock
livelyPropertyListener('slideshow', true);    // photos fade in behind the greeting
livelyPropertyListener('theme', 'dusk');      // …and time-of-day photos follow along: the dusk set
livelyPropertyListener('photoSync', false);   // every photo again, clock or not
livelyPropertyListener('widgets', false);     // take all four satellites off the desktop…
livelyPropertyListener('widgets', true);      // …and deal them again, no reload
livelyPropertyListener('widgetNews', false);  // one satellite off: the ring closes the gap…
livelyPropertyListener('widgetNews', true);   // …and it comes back with the others
livelyPropertyListener('nextPhoto', true);    // skip to the next photo right now
livelyPropertyListener('suspend', true);      // park the timers + drift (the host owns this flag)
livelyPropertyListener('suspend', false);     // and pick up exactly where it left off
window.DynaWall;                              // exposed helpers for quick inspection
window.DynaWall.getThemeSlot(new Date());      // which band the clock is on right now
window.DynaWall.msUntilNextClockBoundary();    // how long the one-shot clock timer is armed for
window.DynaWall.classifyPhotos(photos);        // how the library splits across the four bands
window.DynaWall.openWidget('weather');         // open a card from a console or a host script
window.DynaWall.closeWidget();                 // …and dismiss it again
window.DynaWall.setWidgetsEnabled(false);      // the master Desktop widgets switch, from a host or the console
window.DynaWall.setWidgetEnabled('youtube', false); // one satellite off, live — and cached
window.DynaWall.enabledWidgets();              // ['music', 'news', 'weather'] — what is on the desktop
window.DynaWall.clickAt(120, 88);             // replay a desktop click at CSS pixels (what the hosts do)
window.DynaWall.scatterWidgets({ width: 1920, height: 1080, size: 44, count: 4, margin: 40, gap: 24, clearance: 48, reach: 128, avoid: [], seed: 7 }); // where the satellites would sit
```
