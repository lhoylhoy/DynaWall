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
| Refresh | Greeting period *and* palette re-checked on the exact boundaries that can change them (05:00 · 09:00 · 12:00 · 17:00 · 18:00 · 21:00 local — six one-shot timers a day, nothing in between), and again on wake, resume or window focus |
| Photo slideshow | Off by default. When on, the wallpaper cross-fades through photos every 1–60 min, in order or shuffled, with an optional slow zoom (Ken Burns) and a scrim that keeps the greeting readable. Twelve wallpapers ship in `images/` — the six Golden Gate 5K time-of-day pictures plus six generated abstracts — and the macOS app can rotate any folder you point it at |
| Photo sync | **On by default.** The slideshow only rotates through photos whose filename names the active band — `dawn`, `day`, `dusk` or `night` — so the picture on the desktop matches the light outside and the palette in use. Crossing 05:00 / 09:00 / 17:00 / 21:00, or picking a band in the popover, cross-fades to that band's photos. Turn it off to cycle the whole library |
| Next photo | A **Next** button in the macOS popover's slideshow controls (and `livelyPropertyListener('nextPhoto', true)` / `window.DynaWall.nextPhoto()`) skips to the next photo immediately and restarts the timer |
| Typography | **Outfit** (variable, 600 for the greeting) — optically tracked at display size, so the greeting is ~90 px on a 1080p screen and ~112 px on a 1440p/5K desktop |
| Motion | One-shot entrance fade plus a 320 ms cross-fade whenever the greeting text changes; photos cross-fade over 1.2 s |
| Dependencies | No frameworks, CDN links or network requests. The only artwork is the vendored Outfit face (~32 KB, SIL OFL 1.1) plus the wallpapers in `images/`: six generated abstracts (~780 KB) and the six Golden Gate 5K pictures (~15 MB) |

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
| `assets/fonts/` | Vendored Outfit latin-subset variable WOFF2 with its SIL OFL license, plus static Regular/SemiBold TTFs generated from that same face for the native popover preview |
| `images/` | The bundled wallpapers: the six Golden Gate 5K time-of-day pictures plus six generated abstracts (replaceable — see Notes) |
| `tests/verify.cjs` | Headless checks for `script.js` and the manifests |
| `macos/DynaWallApp.swift` | Native macOS host: desktop-level windows, WebKit, menu bar settings |
| `macos/make-icon.swift` | CoreGraphics generator for the app icon — the Luminous Horizon & Eclipse Orb, drawn from 16×16 to 1024×1024 |
| `macos/AppIcon.icns` | Generated icon set (`AppIcon.png` is the 1024×1024 master it ships alongside) |
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
| `photos` | comma separated list of image URLs | `?photos=images/03-deep-ocean.jpg` |

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
bundle with a 426 KB binary.
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
| Photos | The host resolves your collection or folder and hands the page `dynawall-photo://photo/<n>/<filename>` URLs; a `WKURLSchemeHandler` serves those files, so the web view stays sandboxed to exactly the images you picked. The filename rides along so `script.js` can match a photo to the time of day |
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
that sizes itself to whatever is on screen:

- **Live preview card.** The top card paints the exact background the wallpaper is using — the active band's
  ink plus its radial accent — with the greeting the page is rendering (`Good morning, Froilan.`), your
  subtitle, a time-of-day badge (`Dawn`, `Day`, `Dusk`, `Night` or `Paused`) and the photo currently on screen.
  The greeting and subtitle are set in the wallpaper's own **Outfit** face at its 600/400 weights and CSS
  tracking, tinted with the active band's `--text-primary` / `--text-secondary`, and centred in the card the
  same way `.wallpaper-content` is centred on screen — so the card and the desktop read as one design.
  **Pause** / **Resume** sits right on the card, and the badge turns into `Paused` while the wallpaper is
  detached. The greeting name is never something you type: it is read from the logged-in macOS account on
  every push (`NSFullUserName()` → `NSUserName()`), so type in **Subtitle** and the card follows the
  keystrokes while the name stays the person actually using the Mac.
- **Visual palette.** Dawn, Day, Dusk, Night, GitHub Dark and Deep Slate are clickable swatches painted with
  the ink they apply, next to a live colour well. The **Auto (follow the clock)** pill hands the palette back
  to the clock and names the band it is on (`Day · 09:00–17:00`). Picking a colour in the well selects **Custom
  color** immediately — no dropdown to change first.
- **Progressive disclosure.** The six slideshow controls (collection, custom folder, time-of-day matching,
  interval, shuffle, slow zoom) only appear while **Photo slideshow** is on; choosing a collection or dropping
  a folder turns it on for you, and the controls that would otherwise be greyed out are simply not shown.
- **Drag and drop.** With **Custom folder…** selected, the folder row accepts a folder of images dragged from
  Finder: it becomes the collection, the slideshow starts, and the row shows the folder name and how many
  photos it found.
- **Startup.** A native **Launch at login** switch registers DynaWall with macOS (`SMAppService`) so it starts automatically when you log in, without having to open System Settings manually.
- **Reset** in the footer restores the default subtitle, palette, slideshow and sync settings in one
  click (your chosen photo folder is kept).

| Control | Key | Effect |
| --- | --- | --- |
| Live preview card | — | Active ink + accent, the live greeting and subtitle, band/`Paused` badge, photo name, and a Pause/Resume pill in place |
| Greeting name | — | Read dynamically from the logged-in macOS account (`NSFullUserName()` → `NSUserName()`, and `Developer` only when the account names neither) and normalised exactly like the page (first word, trailing punctuation dropped); there is nothing to type, and any name stored by an earlier build is removed on launch |
| Subtitle | `subtitleText` | Subtitle line; the `×` button clears it, which hides the line |
| Auto (follow the clock) | `themePreset` | Hands the palette back to the clock and shows the band it is on (`Day · 09:00–17:00`) |
| Palette swatches | `themePreset` | Dawn/Day/Dusk/Night pin one band; GitHub Dark `#0d1117` and Deep Slate `#0b0f19` ride the neutral palette |
| Custom color | `customBgColor` | The colour well is always live: picking a colour selects **Custom color** and pins it at once |
| Photo slideshow | `slideshowEnabled` | Rotate photos behind the greeting; the controls below only appear while it is on |
| Collection | `photoCollection` | **Golden Gate** (six 5K time-of-day pictures), **Abstract** (six abstracts) or **Folder** — a curated list, so bundled mode never cycles 4K/5K/HEIC duplicates of the same image. Choosing one starts the slideshow |
| Folder row | `photoFolderPath` | Shown only for **Folder**: drop a folder here or click **Choose…**; the row reports the folder name and its photo count |
| Match time of day | `photoSyncTimeOfDay` | **On** by default: only show the photos whose filename matches the active band, and cross-fade when the band changes. Off cycles the whole collection |
| Rotate every | `slideshowIntervalMinutes` | 1, 5, 15, 30 or 60 minutes |
| Shuffle | `slideshowShuffle` | Random order instead of file-name order |
| Slow zoom | `kenBurns` | Drift/zoom each photo for the length of its turn |
| Next | — | Skip to the next photo now and restart the interval (shown while the slideshow is on) |
| Pause / Resume | — | Detaches the wallpaper from the desktop (the menu bar icon dims) |
| Launch at login | `launchAtLogin` | Starts DynaWall automatically on login (registered with macOS via `SMAppService`) |
| Reset | — | Restores the default subtitle, palette (`Auto`), slideshow, interval, shuffle, slow zoom and collection |
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
# [DynaWall] font: Outfit @ 90.240005px Outfit=1
# [DynaWall] photo library: Golden Gate: 6 photo(s) from …/Resources/images
# [DynaWall] slideshow advanced: dynawall-photo://photo/1/iClarified-macOS-27-Golden-Gate-Day-Wallpaper.jpg (4096x2160)
# [DynaWall] slideshow: on=1 photo=dynawall-photo://photo/1/iClarified-macOS-27-Golden-Gate-Day-Wallpaper.jpg size=4096x2160 layers=2
# [DynaWall] photo collection: Golden Gate sync=time-of-day
```

`slideshow advanced:` names the file that was put on screen, so the time-of-day match (`…-Day-Wallpaper.jpg`
at 10:00, `…-Sunset-Wallpaper.jpg` at 18:00) can be verified from a terminal, and `next photo requested`
appears each time the popover button is pressed.

### Good to know

- The app is not sandboxed (it does not need to be) and never requests screen-recording, camera or
  microphone access.
- Settings changes while the app is closed are picked up on the next launch; changes in the popover apply
  immediately.
- `defaults delete com.dynawall.macos` resets every macOS-side setting.
- Want it at login? Turn on **Launch at login** in the menu bar popover (or manage it in **System Settings → General → Login Items**).

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

Values arrive through `window.wallpaperPropertyListener.applyUserProperties(...)`; colors are converted
from Wallpaper Engine's `"r g b"` floats to hex automatically.

## Configuration priority

1. **Host IPC** — Lively or Wallpaper Engine values
2. **Host seed** — `window.__dynawallSeed`, which the macOS app injects at `documentStart`. It is the same
   values as the IPC push, delivered early so the first paint is already correct; the page deletes it once
   it has been read, and a later `livelyPropertyListener` still wins
3. **URL query parameters**
4. **`localStorage` cache** — `dynawall.firstName`, `dynawall.subtitle`, `dynawall.bgColor`,
   `dynawall.theme`, `dynawall.slideshow`, `dynawall.slideshowInterval`, `dynawall.slideshowShuffle`,
   `dynawall.kenBurns`, `dynawall.photoSync`
5. **Built-in defaults** — `Developer`, `What are we building today?`, `#0d1117`, palette on `auto`,
   slideshow off, 15 minutes, shuffled, slow zoom on, photos matched to the time of day

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
  a blank frame.
- **Time-of-day names**: the classifier reads the filename, so a folder works out of the box if its pictures
  are named after the hour they belong to (`dawn`, `day`, `sunset`, `night`, …); untagged folders are dealt
  across the four bands instead of being ignored. `photoSync=false` (or **Match time of day** off) hands the
  whole library back to the slideshow.
- The scrim behind the greeting (a soft radial + 22% dim) only appears while a photo is showing, and text
  shadows are added at the same time, so the minimal background keeps its pure look.
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
(wrap, shuffle, no repeat), that the clock controls are gone, and the consistency of the host manifests with
`script.js`.

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
livelyPropertyListener('nextPhoto', true);    // skip to the next photo right now
livelyPropertyListener('suspend', true);      // park the timers + drift (the host owns this flag)
livelyPropertyListener('suspend', false);     // and pick up exactly where it left off
window.DynaWall;                              // exposed helpers for quick inspection
window.DynaWall.getThemeSlot(new Date());      // which band the clock is on right now
window.DynaWall.msUntilNextClockBoundary();    // how long the one-shot clock timer is armed for
window.DynaWall.classifyPhotos(photos);        // how the library splits across the four bands
```
