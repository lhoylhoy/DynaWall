//
//  DynaWallApp.swift
//  DynaWall — native macOS live wallpaper host.
//
//  The app is a menu bar utility (no Dock icon) that renders the bundled DynaWall
//  web wallpaper (index.html + style.css + script.js) inside a borderless,
//  click-through window pinned at desktop level, one window per display.
//
//  Settings live in a native menu bar popover and are persisted to UserDefaults.
//  Every change is pushed straight into the page through the same
//  `window.livelyPropertyListener(key, value)` bridge that Lively Wallpaper uses,
//  so the web wallpaper keeps a single, shared configuration code path on every
//  platform.
//
//  Requirements: macOS 12+, Xcode Command Line Tools (`swiftc`).
//  Build with: ./build-macos.sh
//

import AppKit
import Combine
import CoreText
import ImageIO
import ServiceManagement
import SwiftUI
import UniformTypeIdentifiers
import WebKit

// MARK: - Logging

/// Diagnostics always go to stderr. Point `DYNAWALL_LOG` at a path to mirror them
/// into a file, which makes a build smoke testable from a terminal even when the
/// app is launched by LaunchServices:
///
///     DYNAWALL_LOG=/tmp/dynawall.log open -a dist/DynaWall.app
///
private enum Diagnostics {
    static let fileHandle: FileHandle? = {
        guard let path = ProcessInfo.processInfo.environment["DYNAWALL_LOG"], !path.isEmpty else {
            return nil
        }
        if !FileManager.default.fileExists(atPath: path) {
            FileManager.default.createFile(atPath: path, contents: nil)
        }
        guard let handle = try? FileHandle(forWritingTo: URL(fileURLWithPath: path)) else { return nil }
        handle.seekToEndOfFile()
        return handle
    }()
}

private func dynaLog(_ message: String) {
    guard let data = "[DynaWall] \(message)\n".data(using: .utf8) else { return }
    FileHandle.standardError.write(data)
    Diagnostics.fileHandle?.write(data)
}

// MARK: - Haptics

/// The popover's tactile vocabulary.
///
/// Every pulse goes through `NSHapticFeedbackManager`, which drives the Force Touch
/// trackpad's own actuator: a skip feels like a click under the finger rather than a
/// notification. Two patterns are used, deliberately:
///
///   * `.alignment` — a discrete move (next photo, folder accepted, Finder reveal).
///   * `.levelChange` — a state that flipped (pause/resume, restore defaults,
///     launch at login).
///
/// `.generic` is left out on purpose: it is the pattern macOS uses for a rejected
/// drop, and a skip that feels like an error is worse than no feedback at all. The
/// manager is a no-op on a Mac without a Force Touch trackpad (and for a mouse), so
/// every call site stays unconditional.
enum DynaHaptics {
    static func tap(_ pattern: NSHapticFeedbackManager.FeedbackPattern = .alignment) {
        NSHapticFeedbackManager.defaultPerformer.perform(pattern, performanceTime: .now)
    }
}

// MARK: - Preference value types

/// The greeting periods `script.js` cross-fades between.
///
/// Mirrors `getGreetingPeriod()` exactly: 05:00–11:59 morning · 12:00–17:59
/// afternoon · 18:00–04:59 evening. The menu bar previews the greeting the
/// desktop is about to render, so these hours must agree with the page.
enum GreetingPeriod: String {
    case morning
    case afternoon
    case evening

    static func current(now: Date = Date(), calendar: Calendar = .current) -> GreetingPeriod {
        switch calendar.component(.hour, from: now) {
        case 5..<12: return .morning
        case 12..<18: return .afternoon
        default: return .evening
        }
    }
}

/// The four palettes the clock walks through.
///
/// Mirrors `getThemeSlot()` in `script.js` and the `[data-theme]` blocks in
/// `style.css`; a test asserts the background colours agree. The native window
/// and backing layers need a concrete colour even while the page is still
/// loading, which is why these hexes exist on this side of the bridge at all.
enum ThemeSlot: String, CaseIterable {
    case dawn
    case day
    case dusk
    case night

    var label: String {
        switch self {
        case .dawn: return "Dawn"
        case .day: return "Day"
        case .dusk: return "Dusk"
        case .night: return "Night"
        }
    }

    /// Background colour of the matching `[data-theme]` block in `style.css`.
    var hex: String {
        switch self {
        case .dawn: return "#121020"
        case .day: return "#0d1117"
        case .dusk: return "#180f0e"
        case .night: return "#070a11"
        }
    }

    /// Accent colour that glows behind the band on the desktop.
    ///
    /// The RGB of `--bg-radial-accent` in the matching `[data-theme]` block of
    /// `style.css`, so the popover's mini-preview card and palette swatches glow
    /// with the same light the wallpaper actually paints (a test asserts it).
    var accentHex: String {
        switch self {
        case .dawn: return "#ff94aa"
        case .day: return "#388bfd"
        case .dusk: return "#ff9250"
        case .night: return "#486eff"
        }
    }

    /// Primary ink — `--text-primary` in the matching `[data-theme]` block.
    ///
    /// The preview card is a miniature of the wallpaper, so its greeting has to
    /// use the band's own ink rather than a hard-coded white; `custom`, GitHub
    /// Dark and Deep Slate all ride the daylight (`custom`) block.
    var textPrimaryHex: String {
        switch self {
        case .dawn: return "#f8f3fb"
        case .day: return "#f0f6fc"
        case .dusk: return "#fdf1e8"
        case .night: return "#e7eefb"
        }
    }

    /// Secondary ink — `--text-secondary` in the matching `[data-theme]` block.
    var textSecondaryHex: String {
        switch self {
        case .dawn: return "#a89fb9"
        case .day: return "#8b949e"
        case .dusk: return "#b19b8f"
        case .night: return "#7f8a9c"
        }
    }

    /// SF Symbol the popover shows for this band.
    var symbolName: String {
        switch self {
        case .dawn: return "sunrise.fill"
        case .day: return "sun.max.fill"
        case .dusk: return "sunset.fill"
        case .night: return "moon.stars.fill"
        }
    }

    /// The local hour window this band covers, e.g. `09:00–17:00`.
    ///
    /// Derived from `boundaryHours` (the same table the clock timer uses) rather
    /// than spelled out a second time, so the caption can never drift from it.
    var hoursLabel: String {
        guard let index = ThemeSlot.allCases.firstIndex(of: self) else { return "" }
        let hours = ThemeSlot.boundaryHours
        let start = hours[index]
        let end = hours[(index + 1) % hours.count]
        return String(format: "%02d:00–%02d:00", start, end)
    }

    /// 05:00–08:59 dawn · 09:00–16:59 day · 17:00–20:59 dusk · 21:00–04:59 night.
    static func current(now: Date = Date(), calendar: Calendar = .current) -> ThemeSlot {
        switch calendar.component(.hour, from: now) {
        case 5..<9: return .dawn
        case 9..<17: return .day
        case 17..<21: return .dusk
        default: return .night
        }
    }

    /// Local hours at which the band changes. Mirrors the palette edges in
    /// `script.js` (`getThemeSlot`) and the `[data-theme]` blocks in `style.css`.
    static let boundaryHours = [5, 9, 17, 21]

    /// The next moment the band can change.
    ///
    /// Nothing about the palette can move between 05:00, 09:00, 17:00 and 21:00, so
    /// this is the exact sleep a one-shot timer needs: four wakeups a day instead of
    /// the 1,440 a 60 s repeating timer cost. A boundary that is exactly now counts
    /// as gone (the state it produces is already applied) and `date(bySettingHour:)`
    /// resolves DST instead of drifting by an hour of arithmetic.
    static func nextBoundary(after now: Date = Date(), calendar: Calendar = .current) -> Date? {
        let start = calendar.startOfDay(for: now)
        var best: Date?
        for offset in 0...1 {
            guard let day = calendar.date(byAdding: .day, value: offset, to: start) else { continue }
            for hour in boundaryHours {
                guard let candidate = calendar.date(bySettingHour: hour, minute: 0, second: 0, of: day),
                      candidate > now else { continue }
                if let bestDate = best {
                    if candidate < bestDate { best = candidate }
                } else {
                    best = candidate
                }
            }
        }
        return best
    }
}

enum ThemePreset: String, CaseIterable, Identifiable {
    case auto
    case dawn
    case day
    case dusk
    case night
    case githubDark
    case deepSlate
    case custom

    var id: String { rawValue }

    var label: String {
        switch self {
        case .auto: return "Auto (time of day)"
        case .dawn: return "Dawn (05–09)"
        case .day: return "Day (09–17)"
        case .dusk: return "Dusk (17–21)"
        case .night: return "Night (21–05)"
        case .githubDark: return "GitHub Dark"
        case .deepSlate: return "Deep Slate"
        case .custom: return "Custom color"
        }
    }

    /// Sent to the page as `theme`. `auto` follows the clock, the four bands pin
    /// one slot, and the fixed colours ride the `custom` palette.
    var themeMode: String {
        switch self {
        case .auto: return "auto"
        case .dawn, .day, .dusk, .night: return rawValue
        case .githubDark, .deepSlate, .custom: return "custom"
        }
    }

    /// The band this preset pins; `nil` means the clock decides.
    var slot: ThemeSlot? {
        switch self {
        case .dawn: return .dawn
        case .day: return .day
        case .dusk: return .dusk
        case .night: return .night
        case .auto, .githubDark, .deepSlate, .custom: return nil
        }
    }

    /// A fixed colour, or `nil` when the colour comes from the clock or the picker.
    var hex: String? {
        switch self {
        case .githubDark: return "#0d1117"
        case .deepSlate: return "#0b0f19"
        default: return nil
        }
    }

    /// Short caption used under a swatch and in the mini-preview badge.
    var shortLabel: String {
        switch self {
        case .auto: return "Auto"
        case .dawn: return "Dawn"
        case .day: return "Day"
        case .dusk: return "Dusk"
        case .night: return "Night"
        case .githubDark: return "GitHub"
        case .deepSlate: return "Slate"
        case .custom: return "Custom"
        }
    }

    /// Colour the swatch paints.
    ///
    /// `auto` shows the band the clock is on right now and `custom` has no colour of
    /// its own (the popover paints the live picker value), so every other preset
    /// returns the exact background it puts on the desktop.
    var swatchHex: String? {
        switch self {
        case .auto: return ThemeSlot.current().hex
        case .dawn: return ThemeSlot.dawn.hex
        case .day: return ThemeSlot.day.hex
        case .dusk: return ThemeSlot.dusk.hex
        case .night: return ThemeSlot.night.hex
        case .githubDark: return "#0d1117"
        case .deepSlate: return "#0b0f19"
        case .custom: return nil
        }
    }

    /// SF Symbol for the mini-preview badge.
    var symbolName: String {
        switch self {
        case .auto: return "clock.fill"
        case .dawn, .day, .dusk, .night: return slot?.symbolName ?? "sun.max.fill"
        case .githubDark, .deepSlate, .custom: return "paintpalette.fill"
        }
    }
}

// MARK: - Photo collections

/// The photo sets the menu bar can rotate through.
///
/// The bundled sets are curated file lists rather than "everything in `images/`":
/// the Golden Gate scene ships as 4K, 5K, plain and HEIC variants of the same six
/// pictures, so a folder sweep would cycle through duplicates of one image and
/// look like a stutter. Bundled lists are also why the filename reaches the page
/// (`dynawall-photo://photo/<index>/<filename>`): `script.js` classifies a photo
/// into its time-of-day band from the name alone.
enum PhotoCollection: String, CaseIterable, Identifiable {
    case goldenGate
    case abstract
    case custom

    var id: String { rawValue }

    var label: String {
        switch self {
        case .goldenGate: return "Golden Gate"
        case .abstract: return "Abstract"
        case .custom: return "Custom folder…"
        }
    }

    /// Curated bundled JPEGs, in time-of-day order (dawn → night).
    var bundledFiles: [String] {
        switch self {
        case .goldenGate:
            return [
                "iClarified-macOS-27-Golden-Gate-Wallpaper-5K-Light.jpg",
                "iClarified-macOS-27-Golden-Gate-Day-Wallpaper.jpg",
                "iClarified-macOS-27-Golden-Gate-Sunset-Wallpaper.jpg",
                "iClarified-macOS-27-Golden-Gate-Evening-Wallpaper.jpg",
                "iClarified-macOS-27-Golden-Gate-Night-Wallpaper.jpg",
                "iClarified-macOS-27-Golden-Gate-Wallpaper-5K-Dark.jpg"
            ]
        case .abstract:
            return [
                "01-neon-dusk.jpg",
                "02-solar-flare.jpg",
                "03-deep-ocean.jpg",
                "04-mint-fog.jpg",
                "05-candy-sky.jpg",
                "06-graphite.jpg"
            ]
        case .custom:
            return []
        }
    }

    /// One line for the popover: what this collection rotates through.
    var summary: String {
        switch self {
        case .goldenGate: return "Six 5K pictures, one per time of day"
        case .abstract: return "Six abstract wallpapers, one per time of day"
        case .custom: return "Any folder of images you pick"
        }
    }

    /// Compact label for the segmented collection picker.
    var shortLabel: String {
        switch self {
        case .goldenGate: return "Golden Gate"
        case .abstract: return "Abstract"
        case .custom: return "Folder"
        }
    }
}

// MARK: - Colour helpers

enum HexColor {
    static let fallback = "#0d1117"

    static func components(_ hex: String) -> (red: CGFloat, green: CGFloat, blue: CGFloat)? {
        var value = hex.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if value.hasPrefix("#") {
            value.removeFirst()
        }
        guard value.count == 6, let number = UInt32(value, radix: 16) else { return nil }
        return (
            red: CGFloat((number >> 16) & 0xff) / 255.0,
            green: CGFloat((number >> 8) & 0xff) / 255.0,
            blue: CGFloat(number & 0xff) / 255.0
        )
    }

    static func nsColor(_ hex: String) -> NSColor {
        guard let parts = components(hex) else {
            return NSColor(srgbRed: 13.0 / 255.0, green: 17.0 / 255.0, blue: 23.0 / 255.0, alpha: 1)
        }
        return NSColor(srgbRed: parts.red, green: parts.green, blue: parts.blue, alpha: 1)
    }

    static func color(_ hex: String) -> Color {
        Color(nsColor: nsColor(hex))
    }

    /// Canonical `#rrggbb` for any accepted spelling, or `fallback` when unparseable.
    static func normalized(_ hex: String) -> String {
        guard let parts = components(hex) else { return fallback }
        return String(
            format: "#%02x%02x%02x",
            Int((parts.red * 255).rounded()),
            Int((parts.green * 255).rounded()),
            Int((parts.blue * 255).rounded())
        )
    }

    /// Blend `hex` toward `other` by `amount` (0…1).
    ///
    /// The mini-preview card builds its glow from the band's accent and a pinned
    /// palette's own colour, so this is how a fixed colour gets a highlight that
    /// still belongs to it.
    static func blend(_ hex: String, with other: String, amount: CGFloat) -> String {
        guard let from = components(hex), let to = components(other) else { return fallback }
        let t = max(0, min(1, amount))
        return String(
            format: "#%02x%02x%02x",
            Int(((from.red + (to.red - from.red) * t) * 255).rounded()),
            Int(((from.green + (to.green - from.green) * t) * 255).rounded()),
            Int(((from.blue + (to.blue - from.blue) * t) * 255).rounded())
        )
    }

    static func hex(_ color: Color) -> String {
        guard let converted = NSColor(color).usingColorSpace(.sRGB) else { return fallback }
        let red = Int((converted.redComponent * 255).rounded())
        let green = Int((converted.greenComponent * 255).rounded())
        let blue = Int((converted.blueComponent * 255).rounded())
        return String(
            format: "#%02x%02x%02x",
            max(0, min(255, red)),
            max(0, min(255, green)),
            max(0, min(255, blue))
        )
    }
}

// MARK: - Preview font

/// The preview card's copy of the wallpaper's typeface.
///
/// WebKit loads the vendored `*-latin.woff2` files through `@font-face`; AppKit has
/// no equivalent CSS bridge. The static `*-regular.ttf` / `*-semibold.ttf` instances
/// beside them were generated from those exact variable faces — same glyphs, same
/// outlines — and are registered with CoreText for the popover. Without them the
/// preview would be set in SF Rounded while the desktop is set in a bundled face,
/// which is precisely the mismatch the preview exists to avoid.
///
/// The same registry serves the user's own typography: a family installed in Font
/// Book is addressed by name, and an imported font file (`.ttf`/`.otf`/`.ttc`) is
/// registered from `~/Library/Application Support/DynaWall/Fonts`, so the popover
/// previews it exactly like the desktop. CoreText cannot read WOFF/WOFF2; those
/// still set the desktop (the page loads the bytes through `FontFace`) while the
/// card falls back to the system face.
enum WallpaperFont {
    /// The face vendored with the app; every font stack ends here.
    static let defaultFamily = "Outfit"

    /// The families that ship in `assets/fonts`, in preset order. These four render
    /// identically on every host without an install: the page loads their WOFF2
    /// through `@font-face`, and the preview card uses the static TTFs beside them.
    /// Everything else the popover offers is a *system* font (Font Book) or an
    /// imported file. Keep in sync with BUNDLED_FONT_FAMILIES in script.js and
    /// Preferences.BundledFontFamilies in the Windows host.
    static let bundledFamilies = ["Outfit", "Google Sans Flex", "Space Grotesk", "Geist"]

    /// File stem and PostScript names per bundled family: the stem finds
    /// `<stem>-regular.ttf` / `<stem>-semibold.ttf` in the bundle, and the
    /// PostScript names give SwiftUI the exact weight instead of asking CoreText to
    /// pick one from a family.
    static let bundledFaces: [String: (stem: String, regular: String, semibold: String)] = [
        "Outfit": ("outfit", "Outfit-Regular", "Outfit-SemiBold"),
        "Google Sans Flex": ("google-sans-flex", "GoogleSansFlex-Regular", "GoogleSansFlex-SemiBold"),
        "Space Grotesk": ("space-grotesk", "SpaceGrotesk-Regular", "SpaceGrotesk-SemiBold"),
        "Geist": ("geist", "Geist-Regular", "Geist-SemiBold")
    ]

    /// What "Add Font…" accepts. CoreText can only register the first three;
    /// WOFF/WOFF2 exist for the page's `FontFace` loader.
    static let supportedExtensions: Set<String> = ["ttf", "otf", "ttc", "woff", "woff2"]

    /// Largest imported file handed to the page as a data URL (base64 adds ~33%).
    static let maxImportedBytes = 4 * 1024 * 1024

    /// The family the preview card is set in. `WallpaperPreferences` keeps this in
    /// step with the popover, so the `Font.custom` calls stay one-liners.
    static var activeFamily: String = defaultFamily

    private static let registration: Bool = {
        var registered = false
        // Register every bundled face, not just Outfit: each preset previews in its
        // own file. A family the user also installed registers as "already
        // registered", which is harmless — `Font.custom` resolves the same name.
        for faces in bundledFaces.values {
            for name in ["\(faces.stem)-regular", "\(faces.stem)-semibold"] {
                guard let url = bundledURL(named: name) else {
                    dynaLog("preview font missing from bundle: \(name).ttf")
                    continue
                }
                var error: Unmanaged<CFError>?
                if CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) {
                    registered = true
                } else if let error {
                    let description = String(describing: error.takeRetainedValue())
                    if description.localizedCaseInsensitiveContains("already") {
                        registered = true
                    } else {
                        dynaLog("preview font \(name) failed to register: \(description)")
                    }
                }
            }
        }
        return registered
    }()

    /// Register once, at launch, before the popover is built.
    static func register() {
        _ = registration
    }

    /// Wallpaper greeting face: the chosen family at 600, Outfit when unset.
    ///
    /// A bundled family asks for its vendored SemiBold PostScript name, so the weight
    /// is the real file rather than a synthesised one; a system family gets the
    /// closest face CoreText can find. Avenir Next (a geometric sans that ships with
    /// macOS) backs up the bundled faces if registration fails, so a damaged bundle
    /// still lands closer than the default system face.
    static func semibold(size: CGFloat, family: String = "") -> Font {
        let resolved = resolvedFamily(family)
        if let faces = bundledFace(resolved) {
            return registration
                ? .custom(faces.semibold, size: size)
                : .custom("AvenirNext-DemiBold", size: size)
        }
        return face(resolved, size: size, weight: .semibold)
    }

    /// Wallpaper subtitle face: the chosen family at 400, Outfit when unset.
    static func regular(size: CGFloat, family: String = "") -> Font {
        let resolved = resolvedFamily(family)
        if let faces = bundledFace(resolved) {
            return registration
                ? .custom(faces.regular, size: size)
                : .custom("AvenirNext-Regular", size: size)
        }
        return face(resolved, size: size, weight: .regular)
    }

    /// CSS `letter-spacing` is in `em`; SwiftUI's `.tracking` is in points.
    static func tracking(size: CGFloat, em: CGFloat) -> CGFloat {
        size * em
    }

    // MARK: Family resolution

    /// The family the card should use — never empty, `Outfit` when unset.
    private static func resolvedFamily(_ explicit: String) -> String {
        normalizedFamily(explicit.isEmpty ? activeFamily : explicit)
    }

    /// Whether `family` is one of the four faces shipped in `assets/fonts`.
    static func isBundled(_ family: String) -> Bool {
        bundledFace(normalizedFamily(family)) != nil
    }

    /// The bundled faces behind a family name, or `nil` for a system/imported
    /// family. Matching ignores case so a hand-edited `geist` still finds the file.
    private static func bundledFace(
        _ family: String
    ) -> (stem: String, regular: String, semibold: String)? {
        if let exact = bundledFaces[family] {
            return exact
        }
        let key = family.lowercased()
        for (name, faces) in bundledFaces where name.lowercased() == key {
            return faces
        }
        return nil
    }

    /// Trim and drop the characters that could break a CSS font stack or a
    /// `UserDefaults` value pasted in by hand. Mirrors `normalizeFontFamily()` in
    /// `script.js`, so both hosts and the page agree on the same name.
    static func normalizedFamily(_ raw: String) -> String {
        let stripped = raw
            .replacingOccurrences(of: "\"", with: "")
            .replacingOccurrences(of: "'", with: "")
            .replacingOccurrences(of: "\\", with: "")
            .replacingOccurrences(of: ";", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return stripped.isEmpty ? defaultFamily : stripped
    }

    /// Build a face for a family that brings no `@font-face` of its own: a system
    /// family, or an imported one already registered with CoreText.
    ///
    /// `SF Pro` is the macOS UI face, which is not addressable as an installed
    /// family, so it resolves through `.system`. `Font.custom` falls back to the
    /// system face when a family is missing (an uninstalled SF Mono, the file behind
    /// an imported font removed by hand), which keeps the card readable either way.
    private static func face(_ family: String, size: CGFloat, weight: Font.Weight) -> Font {
        let key = family.lowercased()
        if key == "sf pro" || key == "system sans" || key == "system" || key == "system-ui" {
            return .system(size: size, weight: weight)
        }
        return .custom(family, size: size).weight(weight)
    }

    // MARK: Installed families

    /// Symbol and technical faces: real fonts, but not typography for a greeting.
    private static let ignoredFamilies: Set<String> = [
        "Apple Braille", "Apple Color Emoji", "Apple Symbols", "LastResort",
        "Keyboard", "GB18030 Bitmap", "Zapf Dingbats", "Webdings", "Wingdings"
    ]

    private static var cachedFamilies: [String] = []
    private static var cachedFamiliesAt: Date = .distantPast
    /// Long enough to keep typing cheap, short enough that a freshly installed
    /// font appears without a relaunch.
    private static let familiesCacheLifetime: TimeInterval = 30

    /// Every system family Font Book exposes, alphabetical.
    ///
    /// The system font manager is the only complete source (it also knows faces the
    /// user installed after DynaWall started), so the answer is cached briefly
    /// rather than stored: the popover body is rebuilt on every keystroke.
    ///
    /// The four bundled faces are filtered out even when they are also installed
    /// system-wide: the Typography card hides them and offers `Outfit` only as its
    /// "Default" entry. The files and `@font-face` rules stay in the bundle —
    /// hidden, never uninstalled.
    static func installedFamilies() -> [String] {
        let now = Date()
        if !cachedFamilies.isEmpty, now.timeIntervalSince(cachedFamiliesAt) < familiesCacheLifetime {
            return cachedFamilies
        }
        let families = NSFontManager.shared.availableFontFamilies
            .filter { family in
                !family.hasPrefix(".")
                    && !ignoredFamilies.contains(family)
                    && bundledFace(family) == nil
            }
            .sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
        cachedFamilies = families
        cachedFamiliesAt = now
        return families
    }

    // MARK: Imported files

    /// `~/Library/Application Support/DynaWall/Fonts` — where a downloaded font is
    /// copied so the desktop keeps its typeface if the original is moved.
    static var importDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory())
                .appendingPathComponent("Library/Application Support", isDirectory: true)
        return base
            .appendingPathComponent("DynaWall", isDirectory: true)
            .appendingPathComponent("Fonts", isDirectory: true)
    }

    /// Copy `source` into Application Support and return the new location.
    ///
    /// The copy carries a short unique suffix, so re-importing a file the user has
    /// since replaced on disk is a *new* path: the page and the preview then read
    /// the new bytes instead of a cached face. Older copies of the same stem are
    /// deleted, so the folder holds one file per family rather than one per try.
    static func importFont(from source: URL) -> URL? {
        let ext = source.pathExtension.lowercased()
        guard supportedExtensions.contains(ext) else { return nil }

        let directory = importDirectory
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        } catch {
            dynaLog("font import folder could not be created: \(error.localizedDescription)")
            return nil
        }

        let stem = source.deletingPathExtension().lastPathComponent
        let suffix = String(UUID().uuidString.prefix(8)).lowercased()
        let destination = directory.appendingPathComponent("\(stem)-\(suffix).\(ext)")

        if let existing = try? FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil
        ) {
            for file in existing
            where file.deletingPathExtension().lastPathComponent.hasPrefix(stem + "-")
                && file.pathExtension.lowercased() == ext {
                try? FileManager.default.removeItem(at: file)
            }
        }

        do {
            try FileManager.default.copyItem(at: source, to: destination)
        } catch {
            dynaLog("font \(source.lastPathComponent) could not be imported: \(error.localizedDescription)")
            return nil
        }
        return destination
    }

    /// The family name inside a font file, so the page and the preview address the
    /// same face. CoreText cannot parse WOFF/WOFF2, so those fall back to a cleaned
    /// file name (`Inter-Regular.woff2` → `Inter Regular`), which is also the name
    /// the page's `FontFace` is registered under.
    static func familyName(of url: URL, fallback: String) -> String {
        if let descriptors = CTFontManagerCreateFontDescriptorsFromURL(url as CFURL) as? [CTFontDescriptor],
           let descriptor = descriptors.first,
           let family = CTFontDescriptorCopyAttribute(descriptor, kCTFontFamilyNameAttribute) as? String,
           !family.isEmpty {
            return family
        }
        let base = (fallback as NSString).deletingPathExtension
        return normalizedFamily(base.replacingOccurrences(of: "-", with: " "))
    }

    /// Register a font file with CoreText for the lifetime of the process.
    @discardableResult
    static func registerCustomFont(atPath path: String) -> Bool {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        let url = URL(fileURLWithPath: trimmed)
        guard FileManager.default.fileExists(atPath: url.path) else {
            dynaLog("imported font is missing: \(trimmed)")
            return false
        }
        var error: Unmanaged<CFError>?
        if CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) { return true }
        if let error {
            let description = String(describing: error.takeRetainedValue())
            if description.localizedCaseInsensitiveContains("already") { return true }
            dynaLog("imported font \(url.lastPathComponent) failed to register: \(description)")
        }
        return false
    }

    /// A font file as a `data:` URL the page can hand straight to `FontFace`.
    static func dataURL(atPath path: String) -> String? {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let url = URL(fileURLWithPath: trimmed)
        guard let data = try? Data(contentsOf: url),
              !data.isEmpty,
              data.count <= maxImportedBytes else {
            return nil
        }
        return "data:\(mimeType(forExtension: url.pathExtension));base64,\(data.base64EncodedString())"
    }

    private static func mimeType(forExtension pathExtension: String) -> String {
        switch pathExtension.lowercased() {
        case "otf": return "font/otf"
        case "woff": return "font/woff"
        case "woff2": return "font/woff2"
        case "ttc": return "font/collection"
        default: return "font/ttf"
        }
    }

    private static func bundledURL(named name: String) -> URL? {
        let relative = "assets/fonts/\(name).ttf"
        var candidates: [URL] = []
        if let resources = Bundle.main.resourceURL {
            candidates.append(resources.appendingPathComponent(relative))
        }
        candidates.append(Bundle.main.bundleURL.appendingPathComponent(relative))
        candidates.append(
            URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
                .appendingPathComponent(relative)
        )
        return candidates.first { FileManager.default.fileExists(atPath: $0.path) }
    }
}

// MARK: - Photo library

/// Resolves the images the slideshow rotates through and serves them to the page.
///
/// The page itself is loaded from the bundle with read access to `Resources` only,
/// so photos in an arbitrary folder are out of reach over `file://`. Each photo is
/// instead exposed as `dynawall-photo://photo/<index>/<filename>` and the web view
/// reads it back through the scheme handler below, which keeps the page sandboxed
/// to exactly the files this app decided to share. The filename rides along in the
/// URL so `script.js` can sort the photo into a time-of-day band without asking
/// the host a second question.
final class PhotoLibrary {
    static let scheme = "dynawall-photo"

    static let supportedExtensions: Set<String> = [
        "jpg", "jpeg", "png", "heic", "heif", "webp", "gif", "bmp", "tif", "tiff"
    ]

    private let lock = NSLock()
    private var files: [URL] = []
    private var folder = ""

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return files.count
    }

    /// Human readable description used by the diagnostics log.
    var summary: String {
        lock.lock()
        defer { lock.unlock() }
        return "Folder: \(files.count) photo(s) from \(folder.isEmpty ? "<none>" : folder)"
    }

    /// Re-scan the folder the host resolved.
    ///
    /// The macOS host is folder-only: the standard `~/Pictures/DynaWall` folder is
    /// seeded from the bundle once, then scanned like any other folder. A missing
    /// folder, an empty path or a folder with no supported images resolves to an
    /// empty library, which is what makes the desktop fall back to solid black
    /// instead of showing the shipped pictures.
    func reload(folderPath: String) {
        let trimmed = folderPath.trimmingCharacters(in: .whitespacesAndNewlines)
        let scanned = trimmed.isEmpty ? [] : Self.scan(trimmed)

        lock.lock()
        files = scanned
        folder = trimmed
        lock.unlock()
    }

    func file(at index: Int) -> URL? {
        lock.lock()
        defer { lock.unlock() }
        guard index >= 0 && index < files.count else { return nil }
        return files[index]
    }

    /// Scheme URLs handed to the page, in display order, with the file name kept
    /// as the last path segment so the page can classify it.
    func photoURLs() -> [String] {
        lock.lock()
        let names = files.map { $0.lastPathComponent }
        lock.unlock()
        return names.enumerated().map { index, name in
            "\(Self.scheme)://photo/\(index)/\(Self.encodePathSegment(name))"
        }
    }

    /// Percent-encode one path segment: spaces and `#`/`?` must survive a round
    /// trip through `URL` without starting a query or a fragment.
    private static func encodePathSegment(_ value: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/?#")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }

    private static func scan(_ path: String) -> [URL] {
        guard !path.isEmpty else { return [] }
        guard let entries = try? FileManager.default.contentsOfDirectory(
            at: URL(fileURLWithPath: path),
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        ) else {
            return []
        }

        return entries
            .filter { supportedExtensions.contains($0.pathExtension.lowercased()) }
            .sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
    }
}

/// Handles `dynawall-photo://photo/<index>` and
/// `dynawall-photo://photo/<index>/<filename>` requests from the wallpaper page.
final class PhotoSchemeHandler: NSObject, WKURLSchemeHandler {
    private let library: PhotoLibrary
    private let lock = NSLock()
    /// WebKit throws when a task that was cancelled is used again, so track them.
    private var cancelled: Set<ObjectIdentifier> = []

    init(library: PhotoLibrary) {
        self.library = library
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url,
              let index = Self.photoIndex(from: url),
              let fileURL = library.file(at: index) else {
            urlSchemeTask.didFailWithError(Self.notFound)
            return
        }

        let identifier = ObjectIdentifier(urlSchemeTask)
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let data = try? Data(contentsOf: fileURL, options: .mappedIfSafe)
            DispatchQueue.main.async {
                guard let self, !self.isCancelled(identifier) else { return }
                self.forget(identifier)
                guard let data else {
                    urlSchemeTask.didFailWithError(Self.notFound)
                    return
                }
                let response = URLResponse(
                    url: url,
                    mimeType: Self.mimeType(for: fileURL),
                    expectedContentLength: data.count,
                    textEncodingName: nil
                )
                urlSchemeTask.didReceive(response)
                urlSchemeTask.didReceive(data)
                urlSchemeTask.didFinish()
            }
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        lock.lock()
        cancelled.insert(ObjectIdentifier(urlSchemeTask))
        lock.unlock()
    }

    // MARK: Helpers

    private func isCancelled(_ identifier: ObjectIdentifier) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return cancelled.contains(identifier)
    }

    private func forget(_ identifier: ObjectIdentifier) {
        lock.lock()
        cancelled.remove(identifier)
        lock.unlock()
    }

    private static let notFound = NSError(
        domain: "com.dynawall.macos",
        code: 404,
        userInfo: [NSLocalizedDescriptionKey: "photo not found"]
    )

    /// The index is the first path segment; the file name that follows it is only
    /// there for the page's time-of-day classification.
    /// The photo index at the front of `dynawall-photo://photo/<index>/…`.
    ///
    /// Shared with `DesktopWindowController`, which resolves the URL the page
    /// reported back to a file on disk so the menu bar can show that photo.
    static func photoIndex(from url: URL) -> Int? {
        guard url.scheme == PhotoLibrary.scheme, url.host == "photo" else { return nil }
        let first = url.path
            .split(separator: "/", omittingEmptySubsequences: true)
            .first
        guard let segment = first else { return nil }
        return Int(segment)
    }

    private static func mimeType(for url: URL) -> String {
        switch url.pathExtension.lowercased() {
        case "jpg", "jpeg": return "image/jpeg"
        case "png": return "image/png"
        case "heic": return "image/heic"
        case "heif": return "image/heif"
        case "webp": return "image/webp"
        case "gif": return "image/gif"
        case "bmp": return "image/bmp"
        case "tif", "tiff": return "image/tiff"
        default: return "application/octet-stream"
        }
    }
}

// MARK: - Photo event logging

/// Logs the photo the page actually put on screen. Wallpaper debugging is mostly
/// "is it alive?" and this is the cheapest honest answer.
final class PhotoEventLogger: NSObject, WKScriptMessageHandler {
    /// Called with a friendly name for the photo the page just revealed. The menu
    /// bar preview uses it to name what is on the desktop right now.
    var onAdvance: ((String) -> Void)?

    /// Called with the raw `dynawall-photo://photo/<index>/…` URL the page revealed.
    ///
    /// The friendly name above is for people; the URL is what lets the host resolve
    /// the very same file and draw it inside the menu bar's preview card. Only a
    /// source that still points into the photo library is reported, so a page with
    /// no host list (a browser, Lively) never asks for a decode.
    var onSource: ((String) -> Void)?

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard let payload = message.body as? [String: Any] else { return }
        let source = payload["src"] as? String ?? "<unknown>"
        let width = payload["width"] as? Int ?? 0
        let height = payload["height"] as? Int ?? 0
        dynaLog("slideshow advanced: \(source) (\(width)x\(height))")
        if let url = URL(string: source), PhotoSchemeHandler.photoIndex(from: url) != nil {
            onSource?(source)
        }
        if let name = Self.photoName(fromSource: source) {
            onAdvance?(name)
        }
    }

    /// Curated display names for the bundled pictures.
    ///
    /// The file names are publishing artifacts — blog watermark, resolution and
    /// sort prefix included — and none of that belongs in the popover. Anything a
    /// user drops into a custom folder falls through to the generic cleaner below.
    private static let photoTitles: [String: String] = [
        "iClarified-macOS-27-Golden-Gate-Wallpaper-5K-Light": "Golden Gate · Light",
        "iClarified-macOS-27-Golden-Gate-Day-Wallpaper": "Golden Gate · Day",
        "iClarified-macOS-27-Golden-Gate-Sunset-Wallpaper": "Golden Gate · Sunset",
        "iClarified-macOS-27-Golden-Gate-Evening-Wallpaper": "Golden Gate · Evening",
        "iClarified-macOS-27-Golden-Gate-Night-Wallpaper": "Golden Gate · Night",
        "iClarified-macOS-27-Golden-Gate-Wallpaper-5K-Dark": "Golden Gate · Dark",
        "01-neon-dusk": "Neon Dusk",
        "02-solar-flare": "Solar Flare",
        "03-deep-ocean": "Deep Ocean",
        "04-mint-fog": "Mint Fog",
        "05-candy-sky": "Candy Sky",
        "06-graphite": "Graphite"
    ]

    /// `dynawall-photo://photo/2/iClarified-macOS-27-Golden-Gate-Day-Wallpaper.jpg`
    /// → `Golden Gate · Day`; `01-neon-dusk.jpg` → `Neon Dusk`.
    ///
    /// The scheme URL carries the file name for the page's time-of-day
    /// classification, so the same segment gives the popover a human label without
    /// asking WebKit for the DOM. Blog watermarks, resolution/boilerplate words and
    /// numeric sort prefixes are stripped so the card never reads like a filename.
    static func photoName(fromSource source: String) -> String? {
        guard !source.isEmpty, source != "<unknown>" else { return nil }
        let last = source
            .split(separator: "/", omittingEmptySubsequences: true)
            .last
            .map(String.init) ?? source
        let decoded = last.removingPercentEncoding ?? last
        let fileName = (decoded as NSString).deletingPathExtension
        if let title = photoTitles[fileName] { return title }

        // Source watermarks: `iClarified-macOS-27-…`.
        var base = fileName
        for prefix in ["iClarified-macOS-27-", "iClarified-macOS-", "iClarified-"]
        where base.lowercased().hasPrefix(prefix.lowercased()) {
            base = String(base.dropFirst(prefix.count))
            break
        }

        var words = base
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .split(whereSeparator: { $0.isWhitespace })
            .map(String.init)

        // Leading sort prefixes (`01-`, `02-`, `3 `) are filing metadata.
        if let first = words.first, first.count <= 3, first.allSatisfy({ $0.isNumber }) {
            words.removeFirst()
        }

        // Resolution markers and boilerplate words carry no meaning on screen.
        let boilerplate: Set<String> = ["wallpaper", "4k", "5k", "8k", "hd", "uhd", "retina"]
        words.removeAll { boilerplate.contains($0.lowercased()) }
        guard !words.isEmpty else { return nil }

        /// `neon` → `Neon`; leaves acronyms and inner capitals alone.
        func titleCase(_ word: String) -> String {
            guard let first = word.first else { return word }
            return String(first).uppercased() + String(word.dropFirst())
        }

        // The bundled location reads as a subject plus the light it was shot in:
        // "Golden Gate · Day", not "Golden Gate Day".
        if words.count > 2,
           words[0].lowercased() == "golden",
           words[1].lowercased() == "gate" {
            let qualifier = words.dropFirst(2).map(titleCase).joined(separator: " ")
            return "Golden Gate · \(qualifier)"
        }

        return words.map(titleCase).joined(separator: " ")
    }
}

// MARK: - Widget bridge

/// The rectangles, in viewport CSS pixels, the page is willing to take a click in.
///
/// The wallpaper window never takes mouse events (the desktop keeps its drag-select,
/// right-click and icons), so the page has no cursor to react to and cannot know
/// where a satellite is. It reports the rectangles instead, and the host decides
/// which clicks belong to a card.
struct WidgetHitArea {
    /// Whether a card is on screen. While one is, the whole viewport is a target:
    /// the backdrop closes the card.
    let isOpen: Bool
    let regions: [CGRect]

    static let closed = WidgetHitArea(isOpen: false, regions: [])

    func contains(_ point: CGPoint) -> Bool {
        regions.contains { $0.contains(point) }
    }
}

/// Answers the page's two widget calls: "these rectangles may take a click" and "the
/// user picked a link — open it in their browser".
final class WidgetMessageHandler: NSObject, WKScriptMessageHandler {
    /// Called with the web view that reported, and the area it now accepts clicks in.
    var onRegions: ((WKWebView, WidgetHitArea) -> Void)?
    /// Called with an `https` URL the user asked for.
    var onOpenURL: ((String) -> Void)?

    static let interactivityName = "dynawallInteractivity"
    static let openURLName = "dynawallOpenURL"

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        if message.name == Self.openURLName {
            // The page built the URL itself, so the host refuses anything that is not
            // a plain `https` address: no `file:`, no `javascript:`, no app scheme.
            guard let target = message.body as? String, Self.isBrowserURL(target) else {
                dynaLog("refused to open a non-https link from the page")
                return
            }
            onOpenURL?(target)
            return
        }

        guard message.name == Self.interactivityName,
              let webView = message.webView,
              let payload = message.body as? [String: Any] else { return }

        let raw = payload["regions"] as? [[Any]] ?? []
        let regions: [CGRect] = raw.compactMap { entry in
            guard entry.count >= 4,
                  let x = (entry[0] as? NSNumber)?.doubleValue,
                  let y = (entry[1] as? NSNumber)?.doubleValue,
                  let width = (entry[2] as? NSNumber)?.doubleValue,
                  let height = (entry[3] as? NSNumber)?.doubleValue else { return nil }
            return CGRect(x: x, y: y, width: width, height: height)
        }
        onRegions?(webView, WidgetHitArea(isOpen: payload["open"] as? Bool ?? false, regions: regions))
    }

    /// Only a real `https` address with a host is ever handed to the browser.
    static func isBrowserURL(_ target: String) -> Bool {
        guard let url = URL(string: target),
              url.scheme?.lowercased() == "https",
              let host = url.host,
              !host.isEmpty else { return false }
        return true
    }
}

// MARK: - Launch at login

/// Manages registration of DynaWall as a macOS login item (startup app).
///
/// On macOS 13+, this uses Apple's official `SMAppService.mainApp` API.
/// On macOS 12, it falls back to AppleScript System Events login item management.
enum LaunchAtLogin {
    /// Whether DynaWall is registered to start automatically on user login.
    static var isEnabled: Bool {
        get {
            if #available(macOS 13.0, *) {
                let status = SMAppService.mainApp.status
                if status == .enabled { return true }
                if status == .notFound {
                    return UserDefaults.standard.bool(forKey: WallpaperPreferences.Key.launchAtLogin)
                }
                return false
            } else {
                return legacyIsEnabled()
            }
        }
        set {
            set(enabled: newValue)
        }
    }

    /// On macOS 13+, returns `true` if the user has disabled the login item
    /// in System Settings → General → Login Items & Extensions.
    static var requiresApproval: Bool {
        if #available(macOS 13.0, *) {
            return SMAppService.mainApp.status == .requiresApproval
        }
        return false
    }

    static func set(enabled: Bool) {
        if #available(macOS 13.0, *) {
            let service = SMAppService.mainApp
            do {
                if enabled {
                    if service.status != .enabled {
                        try service.register()
                        dynaLog("registered login item with SMAppService")
                    }
                } else {
                    if service.status == .enabled {
                        try service.unregister()
                        dynaLog("unregistered login item with SMAppService")
                    }
                }
            } catch {
                dynaLog("SMAppService update failed: \(error.localizedDescription)")
            }
        } else {
            legacySet(enabled: enabled)
        }
        UserDefaults.standard.set(enabled, forKey: WallpaperPreferences.Key.launchAtLogin)
    }

    /// Open System Settings to the Login Items pane if user approval is needed.
    static func openSystemSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.LoginItems-Settings.extension") {
            NSWorkspace.shared.open(url)
        }
    }

    private static func legacyIsEnabled() -> Bool {
        let path = Bundle.main.bundlePath
        let script = "tell application \"System Events\" to get count of (every login item whose path is \"\(path)\")"
        if let appleScript = NSAppleScript(source: script) {
            var errorInfo: NSDictionary?
            let result = appleScript.executeAndReturnError(&errorInfo)
            if errorInfo == nil {
                return (result.int32Value > 0)
            }
        }
        return UserDefaults.standard.bool(forKey: WallpaperPreferences.Key.launchAtLogin)
    }

    private static func legacySet(enabled: Bool) {
        let path = Bundle.main.bundlePath
        let script: String
        if enabled {
            script = "tell application \"System Events\" to make login item at end with properties {path:\"\(path)\", hidden:false}"
        } else {
            script = "tell application \"System Events\" to delete (every login item whose path is \"\(path)\")"
        }
        if let appleScript = NSAppleScript(source: script) {
            var errorInfo: NSDictionary?
            appleScript.executeAndReturnError(&errorInfo)
            if let error = errorInfo {
                dynaLog("legacy login item script error: \(error)")
            }
        }
    }
}

// MARK: - Preferences

/// Persisted wallpaper settings. Every mutation is written to `UserDefaults` and
/// reported through `onChange` so the wallpaper follows the menu bar live.
final class WallpaperPreferences: ObservableObject {
    enum Key {
        static let subtitle = "subtitleText"
        static let themePreset = "themePreset"
        static let customColor = "customBgColor"
        static let slideshow = "slideshowEnabled"
        static let slideshowInterval = "slideshowIntervalMinutes"
        static let slideshowShuffle = "slideshowShuffle"
        static let kenBurns = "kenBurns"
        static let photoFolder = "photoFolderPath"
        static let photoCollection = "photoCollection"
        static let photoSync = "photoSyncTimeOfDay"
        /// Whether the four desktop satellites (music, news, YouTube, weather) show.
        static let widgets = "desktopWidgets"
        /// …and one flag per satellite, so each can be taken off the desktop alone.
        static let widgetMusic = "desktopWidgetMusic"
        static let widgetNews = "desktopWidgetNews"
        static let widgetYouTube = "desktopWidgetYouTube"
        static let widgetWeather = "desktopWidgetWeather"
        static let launchAtLogin = "launchAtLogin"
        /// Greeting/subtitle family: an installed name or the imported file's family.
        static let fontFamily = "fontFamily"
        /// The imported font file copied into Application Support ("" = none).
        static let customFontPath = "customFontPath"
    }

    static let defaultSubtitle = "What are we building today?"

    /// The user-visible folder DynaWall falls back to when no other folder has
    /// been picked: `~/Pictures/DynaWall`.
    ///
    /// `DesktopWindowController` creates it on launch and, the first time it is
    /// created, seeds it with the wallpapers shipped in the app bundle. Keeping
    /// the default under `Pictures` makes it easy to find in Finder and lets the
    /// user add or remove wallpapers without editing the app bundle.
    static var standardPhotoFolderPath: String {
        let pictures = FileManager.default.urls(for: .picturesDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Pictures", isDirectory: true)
        return pictures.appendingPathComponent("DynaWall", isDirectory: true).path
    }

    /// The greeting name is always read dynamically from the logged-in macOS account.
    var firstName: String {
        Self.detectedFirstName()
    }

    @Published var subtitleText: String {
        didSet { persist(subtitleText, Key.subtitle) }
    }

    /// The palette is always clock-driven now. The popover no longer shows a
    /// Palette card, and a value stored by an earlier build is collapsed back to
    /// `auto` so the native layer and the page cannot drift apart.
    @Published var themePreset: ThemePreset {
        didSet {
            if themePreset != .auto {
                themePreset = .auto
                return
            }
            persist(themePreset.rawValue, Key.themePreset)
        }
    }

    @Published var customColorHex: String {
        didSet { persist(customColorHex, Key.customColor) }
    }

    @Published var slideshow: Bool {
        didSet { persist(slideshow, Key.slideshow) }
    }

    /// Minutes between photos.
    @Published var slideshowIntervalMinutes: Int {
        didSet { persist(slideshowIntervalMinutes, Key.slideshowInterval) }
    }

    @Published var slideshowShuffle: Bool {
        didSet { persist(slideshowShuffle, Key.slideshowShuffle) }
    }

    @Published var kenBurns: Bool {
        didSet { persist(kenBurns, Key.kenBurns) }
    }

    /// Empty string means no explicit folder: the standard
    /// `~/Pictures/DynaWall` folder is used instead. If neither folder yields an
    /// image, the wallpaper falls back to solid black.
    @Published var photoFolderPath: String {
        didSet { persist(photoFolderPath, Key.photoFolder) }
    }

    /// The folder the photo library actually scans: an explicit pick wins,
    /// otherwise the standard `~/Pictures/DynaWall` folder stands in.
    var effectivePhotoFolderPath: String {
        let chosen = photoFolderPath.trimmingCharacters(in: .whitespacesAndNewlines)
        return chosen.isEmpty ? Self.standardPhotoFolderPath : chosen
    }

    /// `true` while the standard folder is the active source, whether it was
    /// chosen implicitly or persisted by an earlier build.
    var usesStandardPhotoFolder: Bool {
        let chosen = photoFolderPath.trimmingCharacters(in: .whitespacesAndNewlines)
        return chosen.isEmpty || chosen == Self.standardPhotoFolderPath
    }

    /// Show the active wallpaper folder in Finder, with nothing preselected.
    ///
    /// `selectFile(nil, inFileViewerRootedAtPath:)` opens (or re-focuses) a Finder
    /// window rooted at the folder instead of merely activating Finder, which is
    /// what "Reveal in Finder" means on macOS. The folder is created on launch, so
    /// the path is normally present; a folder the user deleted meanwhile simply
    /// brings Finder forward without a window.
    func revealPhotoFolderInFinder() {
        let path = effectivePhotoFolderPath
        guard !path.isEmpty else { return }
        NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: path)
        dynaLog("revealed photo folder in Finder: \(path)")
    }

    /// Photos always come from the active folder: the standard
    /// `~/Pictures/DynaWall` folder unless the user picked another one. The old
    /// bundled collections stay in `PhotoCollection` for the web wallpaper and
    /// the Windows manifest, but the macOS host pins this to `.custom`.
    @Published var photoCollection: PhotoCollection {
        didSet {
            if photoCollection != .custom {
                photoCollection = .custom
                return
            }
            persist(photoCollection.rawValue, Key.photoCollection)
        }
    }

    /// Images the active folder yielded, updated by `DesktopWindowController`
    /// after every rescan. While it is zero the desktop is solid black and the
    /// slideshow controls are disabled.
    @Published private(set) var photoCount = 0

    func updatePhotoCount(_ count: Int) {
        if photoCount != count {
            photoCount = count
        }
    }

    /// Keep the wallpaper's photo in step with the clock's palette band.
    @Published var photoSync: Bool {
        didSet { persist(photoSync, Key.photoSync) }
    }

    /// The four desktop satellites: music, news, YouTube and weather.
    ///
    /// On by default, and off is a real setting rather than a broken wallpaper: the
    /// page hides the satellite, stops placing it and reports no click rectangle for it,
    /// so that corner of the desktop is the Finder's again. `widgets` is the master
    /// switch — it hides all four without forgetting which ones were picked — and the
    /// four flags below take them one at a time. Every change is pushed to the page like
    /// every other setting, which is what makes them live: no reload, no relaunch.
    @Published var widgets: Bool {
        didSet { persist(widgets, Key.widgets) }
    }

    @Published var widgetMusic: Bool {
        didSet { persist(widgetMusic, Key.widgetMusic) }
    }

    @Published var widgetNews: Bool {
        didSet { persist(widgetNews, Key.widgetNews) }
    }

    @Published var widgetYouTube: Bool {
        didSet { persist(widgetYouTube, Key.widgetYouTube) }
    }

    @Published var widgetWeather: Bool {
        didSet { persist(widgetWeather, Key.widgetWeather) }
    }

    /// The family the greeting and subtitle are set in. `Outfit` is the vendored
    /// default; any family installed in Font Book works, and an imported file is
    /// addressed by the family name resolved when it was added.
    @Published var fontFamily: String {
        didSet {
            let normalized = WallpaperFont.normalizedFamily(fontFamily)
            if normalized != fontFamily {
                fontFamily = normalized // didSet runs again with the clean value
                return
            }
            // The preview card reads the face from the static registry, so it has to
            // move before SwiftUI rebuilds the popover.
            WallpaperFont.activeFamily = normalized
            persist(normalized, Key.fontFamily)
        }
    }

    /// Absolute path of a font file imported with "Add Font…" ("" = none).
    ///
    /// The file lives in Application Support, so the wallpaper keeps its typeface
    /// after the download is moved or deleted. Registering it again on launch is
    /// what makes the desktop and the popover preview agree from the first frame.
    @Published var customFontPath: String {
        didSet {
            let trimmed = customFontPath.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed != customFontPath {
                customFontPath = trimmed
                return
            }
            if !trimmed.isEmpty {
                WallpaperFont.registerCustomFont(atPath: trimmed)
            }
            persist(trimmed, Key.customFontPath)
        }
    }

    /// Start DynaWall automatically when logging in to macOS.
    @Published var launchAtLogin: Bool {
        didSet {
            guard launchAtLogin != oldValue else { return }
            LaunchAtLogin.isEnabled = launchAtLogin
            persist(launchAtLogin, Key.launchAtLogin)
        }
    }

    var launchAtLoginRequiresApproval: Bool {
        LaunchAtLogin.requiresApproval
    }

    func syncLaunchAtLogin() {
        let current = LaunchAtLogin.isEnabled
        if launchAtLogin != current {
            launchAtLogin = current
        }
    }

    /// Called after every persisted change (never during initialisation).
    var onChange: ((WallpaperPreferences) -> Void)?

    private let defaults: UserDefaults

    /// Effective background colour for the windows and the backing layer.
    ///
    /// With no folder (or a folder that yielded no readable images) the desktop is
    /// pure black. Once photos are available the palette follows the clock, so the
    /// native layer matches the band the page is about to paint.
    var bgColor: String {
        if photoCount == 0 { return "#000000" }
        switch themePreset {
        case .custom: return customColorHex
        case .auto: return ThemeSlot.current().hex
        default: return themePreset.hex ?? themePreset.slot?.hex ?? ThemeSlot.day.hex
        }
    }

    /// Palette mode handed to the page (`auto` = follow the clock).
    ///
    /// With no photos the page is asked for the `custom` palette in pure black:
    /// there is nothing to grade, and the clock band would otherwise paint a
    /// colour behind the greeting. As soon as a folder yields an image, `auto`
    /// takes over and the clock drives everything again.
    var themeMode: String {
        photoCount == 0 ? "custom" : themePreset.themeMode
    }

    /// A pinned colour (`custom`, GitHub Dark, Deep Slate) is sent as `bgColor`;
    /// `auto` and the four bands leave every token to `style.css`, which is what
    /// keeps the clock in charge. An empty photo folder also sends black so the
    /// page has no coloured backdrop behind the greeting.
    var usesPinnedColor: Bool {
        switch themePreset {
        case .githubDark, .deepSlate, .custom: return true
        case .auto, .dawn, .day, .dusk, .night: return false
        }
    }

    /// Only a pinned colour (or the photo-less black fallback) sends `bgColor`.
    private var bgColorUpdate: String {
        guard usesPinnedColor || photoCount == 0 else { return "" }
        return "window.livelyPropertyListener(\"bgColor\", \(Self.jsLiteral(bgColor)));"
    }

    /// The folder row's title: the standard folder's short path when no
    /// explicit folder is chosen, otherwise the picked folder's name.
    var photoFolderLabel: String {
        if usesStandardPhotoFolder {
            return "Pictures/DynaWall"
        }
        let path = effectivePhotoFolderPath
        let name = (path as NSString).lastPathComponent
        return name.isEmpty ? path : name
    }

    /// One short badge: what the slideshow rotates through right now.
    ///
    /// The band mirrors `resolvePhotoBand()` in `script.js`: with the palette
    /// pinned to `.auto`, photos follow the clock.
    var photoCollectionHint: String {
        guard photoCount > 0 else { return "No photos" }
        guard photoSync else { return "All photos" }
        return ThemeSlot.current().label + " photos"
    }

    // MARK: Typography

    /// The imported font file as a `data:` URL for the page.
    ///
    /// Never persisted: the path is the setting, and the bytes are re-read on every
    /// launch (and again whenever the file changes), which keeps UserDefaults small
    /// and lets a re-import replace the face instead of caching the old one.
    var customFontSource: String {
        WallpaperFont.dataURL(atPath: customFontPath) ?? ""
    }

    /// Import a downloaded font file, select it and remember it.
    ///
    /// The file is copied into Application Support first (so the wallpaper never
    /// depends on the Downloads folder), then registered with CoreText for the
    /// preview card. Returns `false` for an unreadable or unsupported file so the
    /// popover can explain instead of silently doing nothing.
    @discardableResult
    func importFontFile(_ url: URL) -> Bool {
        guard let destination = WallpaperFont.importFont(from: url) else { return false }
        let family = WallpaperFont.familyName(of: destination, fallback: destination.lastPathComponent)
        WallpaperFont.registerCustomFont(atPath: destination.path)
        // The family goes first: the page needs a name to attach the bytes to.
        if customFontPath != destination.path {
            customFontPath = destination.path
        }
        if fontFamily != family {
            fontFamily = family
        }
        dynaLog("imported font \(url.lastPathComponent) as \(family)")
        return true
    }

    // MARK: Popover preview

    /// The clock band the wallpaper is showing, or `nil` when a fixed colour is pinned.
    ///
    /// The mini-preview card uses it for the time-of-day badge, the glow and the
    /// palette caption, so it mirrors what the page resolved for itself.
    var activeThemeSlot: ThemeSlot? {
        if let slot = themePreset.slot { return slot }
        return themePreset == .auto ? ThemeSlot.current() : nil
    }

    /// Glow the mini-preview card paints over the background.
    ///
    /// A band glows with its own accent; a pinned colour glows with a lightened
    /// version of itself, which is what the desktop's radial accent does.
    var previewAccentHex: String {
        if let slot = activeThemeSlot { return slot.accentHex }
        return HexColor.blend(bgColor, with: "#ffffff", amount: 0.32)
    }

    /// Greeting ink in the mini-preview: the band's `--text-primary`, or the
    /// daylight ink that `[data-theme="custom"]` gives every pinned colour.
    var previewTextPrimaryHex: String {
        (activeThemeSlot ?? .day).textPrimaryHex
    }

    /// Subtitle ink in the mini-preview: the band's `--text-secondary`.
    ///
    /// The card paints the flat palette, not a photo, so this stays the non-photo
    /// tone instead of the brighter `body.has-photo` subtitle.
    var previewTextSecondaryHex: String {
        (activeThemeSlot ?? .day).textSecondaryHex
    }

    /// The greeting exactly as the page renders it.
    ///
    /// Reproduces `getGreetingPeriod()` + `buildGreeting()` + `normalizeName()` from
    /// `script.js`, so the popover previews `Good morning, Froilan.` — the same
    /// string, with the same name normalisation (first token, no trailing
    /// punctuation). The name is the logged-in macOS account's, which is the only
    /// name the desktop renders, so the card and the wallpaper cannot disagree.
    var previewGreeting: String {
        "Good \(GreetingPeriod.current().rawValue), \(firstName)."
    }

    /// Mirrors `normalizeName()` in `script.js`.
    static func normalizedName(_ value: String) -> String? {
        var cleaned = value
            .split(whereSeparator: { $0.isWhitespace })
            .joined(separator: " ")
        while let last = cleaned.last, ".,!;:".contains(last) {
            cleaned.removeLast()
        }
        return cleaned.split(separator: " ").first.map(String.init)
    }

    // MARK: Smart setters

    /// Pick a colour and pin the custom palette in one click.
    ///
    /// The colour well used to be disabled unless the palette already said "Custom
    /// color", so picking a colour appeared to do nothing. Choosing one now pins
    /// that palette immediately, which is the behaviour the README documents.
    func selectCustomColor(_ hex: String) {
        let normalized = HexColor.normalized(hex)
        if customColorHex != normalized {
            customColorHex = normalized
        }
        if themePreset != .custom {
            themePreset = .custom
        }
    }

    /// Accept a folder dropped onto the popover.
    ///
    /// Switches to the custom collection, remembers the folder and starts the
    /// slideshow. A dropped file changes nothing and reports `false`.
    @discardableResult
    func applyDroppedFolder(_ url: URL) -> Bool {
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory),
              isDirectory.boolValue else {
            dynaLog("ignored dropped item that is not a folder: \(url.lastPathComponent)")
            return false
        }
        if photoCollection != .custom {
            photoCollection = .custom
        }
        // Dropping the standard folder is the same as choosing it implicitly;
        // keeping the path empty preserves the "standard folder" label.
        let path = url.path == Self.standardPhotoFolderPath ? "" : url.path
        if photoFolderPath != path {
            photoFolderPath = path
        }
        if !slideshow {
            slideshow = true
        }
        return true
    }

    /// Restore the shipped look in one click.
    ///
    /// Clearing `photoFolderPath` returns the wallpaper to the standard
    /// `~/Pictures/DynaWall` folder. If that folder has no images, the desktop
    /// returns to solid black and the slideshow controls go inactive.
    func resetToDefaults() {
        subtitleText = Self.defaultSubtitle
        themePreset = .auto
        customColorHex = HexColor.fallback
        slideshow = false
        slideshowIntervalMinutes = 15
        slideshowShuffle = true
        kenBurns = true
        photoCollection = .custom
        photoFolderPath = ""
        photoCount = 0
        photoSync = true
        widgets = true
        widgetMusic = true
        widgetNews = true
        widgetYouTube = true
        widgetWeather = true
        fontFamily = WallpaperFont.defaultFamily
        customFontPath = ""
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        // The greeting name is no longer a stored setting: drop the override an
        // earlier build may have left in `com.dynawall.macos`, so the logged-in
        // macOS user is the only source of the name.
        defaults.removeObject(forKey: "firstName")
        defaults.register(defaults: [
            Key.subtitle: Self.defaultSubtitle,
            Key.themePreset: ThemePreset.auto.rawValue,
            Key.customColor: HexColor.fallback,
            Key.slideshow: false,
            Key.slideshowInterval: 15,
            Key.slideshowShuffle: true,
            Key.kenBurns: true,
            Key.photoFolder: "",
            Key.photoCollection: PhotoCollection.custom.rawValue,
            Key.photoSync: true,
            Key.widgets: true,
            Key.widgetMusic: true,
            Key.widgetNews: true,
            Key.widgetYouTube: true,
            Key.widgetWeather: true,
            Key.launchAtLogin: false,
            Key.fontFamily: WallpaperFont.defaultFamily,
            Key.customFontPath: ""
        ])

        subtitleText = defaults.string(forKey: Key.subtitle) ?? Self.defaultSubtitle
        // The palette is always clock-driven now. Writing the migrated value back is
        // what removes a band, a fixed colour or a custom pick stored by an earlier
        // build, so a relaunch cannot bring it back.
        themePreset = .auto
        defaults.set(ThemePreset.auto.rawValue, forKey: Key.themePreset)
        customColorHex = defaults.string(forKey: Key.customColor) ?? HexColor.fallback
        slideshow = defaults.bool(forKey: Key.slideshow)
        let interval = defaults.integer(forKey: Key.slideshowInterval)
        slideshowIntervalMinutes = interval > 0 ? interval : 15
        slideshowShuffle = defaults.bool(forKey: Key.slideshowShuffle)
        kenBurns = defaults.bool(forKey: Key.kenBurns)
        photoFolderPath = defaults.string(forKey: Key.photoFolder) ?? ""
        // Folder-only photos: an old bundled collection is migrated to `.custom`.
        photoCollection = .custom
        defaults.set(PhotoCollection.custom.rawValue, forKey: Key.photoCollection)
        photoSync = defaults.bool(forKey: Key.photoSync)
        widgets = defaults.bool(forKey: Key.widgets)
        widgetMusic = defaults.bool(forKey: Key.widgetMusic)
        widgetNews = defaults.bool(forKey: Key.widgetNews)
        widgetYouTube = defaults.bool(forKey: Key.widgetYouTube)
        widgetWeather = defaults.bool(forKey: Key.widgetWeather)
        launchAtLogin = LaunchAtLogin.isEnabled
        // Bundled families are hidden from the dropdown; an old pick that pointed at
        // one of them lands back on Outfit rather than at an invisible selection.
        let storedFamily = WallpaperFont.normalizedFamily(
            defaults.string(forKey: Key.fontFamily) ?? WallpaperFont.defaultFamily
        )
        let resolvedFamily: String
        if WallpaperFont.isBundled(storedFamily),
           storedFamily.caseInsensitiveCompare(WallpaperFont.defaultFamily) != .orderedSame {
            resolvedFamily = WallpaperFont.defaultFamily
        } else {
            resolvedFamily = storedFamily
        }
        fontFamily = resolvedFamily
        customFontPath = defaults.string(forKey: Key.customFontPath) ?? ""
        defaults.set(resolvedFamily, forKey: Key.fontFamily)
        // `didSet` does not run during init, so the preview card and CoreText have to
        // be told about the saved typography here (and not only when it changes).
        WallpaperFont.activeFamily = resolvedFamily
        if !customFontPath.isEmpty {
            WallpaperFont.registerCustomFont(atPath: customFontPath)
        }
    }

    /// The logged-in macOS account's first name, read on every call.
    ///
    /// `NSFullUserName()` covers an account whose full name is set (`Froilan
    /// Banaticla`); `NSUserName()` is the short login name otherwise (`froilan`).
    /// Both are cleaned with `normalizedName(_:)`, so an account called
    /// `Froilan B.` resolves to `Froilan` — the exact rules `normalizeName()` in
    /// `script.js` applies. An account with neither a full name nor a login name
    /// yields `Developer`.
    static func detectedFirstName() -> String {
        let full = NSFullUserName().trimmingCharacters(in: .whitespacesAndNewlines)
        if let name = normalizedName(full) {
            return name
        }
        let short = NSUserName().trimmingCharacters(in: .whitespacesAndNewlines)
        return normalizedName(short) ?? "Developer"
    }

    // MARK: Bridge

    /// Full settings payload expressed as calls into the shared web wallpaper API.
    ///
    /// The name is the logged-in macOS account's, so the page always greets the
    /// person actually using the Mac.
    var javaScriptUpdate: String {
        """
        (function () {
          if (typeof window.livelyPropertyListener !== "function") { return false; }
          window.livelyPropertyListener("firstName", \(Self.jsLiteral(firstName)));
          window.livelyPropertyListener("subtitleText", \(Self.jsLiteral(subtitleText)));
          \(bgColorUpdate)
          window.livelyPropertyListener("theme", \(Self.jsLiteral(themeMode)));
          window.livelyPropertyListener("slideshow", \(slideshow ? "true" : "false"));
          window.livelyPropertyListener("photoSync", \(photoSync ? "true" : "false"));
          window.livelyPropertyListener("slideshowInterval", \(slideshowIntervalMinutes));
          window.livelyPropertyListener("slideshowShuffle", \(slideshowShuffle ? "true" : "false"));
          window.livelyPropertyListener("kenBurns", \(kenBurns ? "true" : "false"));
          window.livelyPropertyListener("widgets", \(widgets ? "true" : "false"));
          window.livelyPropertyListener("widgetMusic", \(widgetMusic ? "true" : "false"));
          window.livelyPropertyListener("widgetNews", \(widgetNews ? "true" : "false"));
          window.livelyPropertyListener("widgetYouTube", \(widgetYouTube ? "true" : "false"));
          window.livelyPropertyListener("widgetWeather", \(widgetWeather ? "true" : "false"));
          window.livelyPropertyListener("fontFamily", \(Self.jsLiteral(WallpaperFont.normalizedFamily(fontFamily))));
          return true;
        })();
        """
    }

    /// The imported font bytes, pushed separately from the settings.
    ///
    /// A font file is up to a few megabytes of base64; riding along in every
    /// keystroke-sized settings push would re-send all of it while the subtitle is
    /// typed. The page keeps the face it already loaded when the value is unchanged,
    /// so this runs only when the imported file (or its absence) actually changes.
    static func javaScriptFontUpdate(_ source: String) -> String {
        """
        (function () {
          if (typeof window.livelyPropertyListener !== "function") { return false; }
          window.livelyPropertyListener("customFont", \(jsLiteral(source)));
          return true;
        })();
        """
    }

    /// `script.js` re-evaluates the greeting period on window focus, which is
    /// exactly what we need after the Mac wakes from sleep.
    static let javaScriptResync = "window.dispatchEvent(new Event('focus'));"

    /// A snapshot of every setting, ready to be injected with a `WKUserScript` at
    /// `.atDocumentStart`.
    ///
    /// `script.js` reads `window.__dynawallSeed` while it resolves its configuration,
    /// so the very first frame already paints the user's name, palette and photos.
    /// Without it the page boots with the built-in copy, the IPC push then swaps it,
    /// and the window has to stay invisible long enough for that cross-fade — three
    /// wasted renders (and one visible name swap) per launch.
    ///
    /// The photo list rides along for the same reason: the first photo can start
    /// decoding before `didFinish` rather than after an extra round trip.
    ///
    /// Like the IPC push, the seed carries the logged-in macOS user's name, so the
    /// very first frame greets the person actually using the Mac.
    func javaScriptSeed(photoURLs: [String]) -> String {
        var fields: [String] = [
            "\"firstName\": \(Self.jsLiteral(firstName))",
            "\"subtitle\": \(Self.jsLiteral(subtitleText))",
            "\"theme\": \(Self.jsLiteral(themeMode))"
        ]
        if usesPinnedColor || photoCount == 0 {
            fields.append("\"bgColor\": \(Self.jsLiteral(bgColor))")
        }
        fields.append("\"slideshow\": \(slideshow ? "true" : "false")")
        fields.append("\"photoSync\": \(photoSync ? "true" : "false")")
        fields.append("\"slideshowInterval\": \(slideshowIntervalMinutes)")
        fields.append("\"slideshowShuffle\": \(slideshowShuffle ? "true" : "false")")
        fields.append("\"kenBurns\": \(kenBurns ? "true" : "false")")
        fields.append("\"widgets\": \(widgets ? "true" : "false")")
        fields.append("\"widgetMusic\": \(widgetMusic ? "true" : "false")")
        fields.append("\"widgetNews\": \(widgetNews ? "true" : "false")")
        fields.append("\"widgetYouTube\": \(widgetYouTube ? "true" : "false")")
        fields.append("\"widgetWeather\": \(widgetWeather ? "true" : "false")")
        fields.append("\"fontFamily\": \(Self.jsLiteral(WallpaperFont.normalizedFamily(fontFamily)))")
        // The imported face rides along so the first frame is already set in it; it
        // is re-read from disk here rather than stored, so a replaced file wins.
        let fontSource = customFontSource
        if !fontSource.isEmpty {
            fields.append("\"customFont\": \(Self.jsLiteral(fontSource))")
        }
        // Always present, even when empty: an empty array is how the page knows the
        // host chose a folder and it has no images, which keeps the bundled photos
        // off the desktop and the background solid black.
        fields.append("\"photos\": \(Self.jsArrayLiteral(photoURLs))")
        return """
        (function () {
          window.__dynawallSeed = { \(fields.joined(separator: ", ")) };
          return true;
        })();
        """
    }

    /// Park or restore every timer and animation in the page. Sent when the window
    /// is completely covered, the displays sleep, the session locks or the menu bar
    /// pauses the wallpaper, so an invisible desktop costs no frames at all.
    static func javaScriptSuspend(_ suspended: Bool) -> String {
        """
        (function () {
          if (typeof window.livelyPropertyListener !== "function") { return false; }
          window.livelyPropertyListener("suspend", \(suspended ? "true" : "false"));
          return true;
        })();
        """
    }

    /// Momentary action rather than a setting: the page advances its slideshow
    /// right away and restarts the timer. Sent by the popover's "Next photo".
    static let javaScriptNextPhoto = """
    (function () {
      if (typeof window.livelyPropertyListener !== "function") { return false; }
      window.livelyPropertyListener("nextPhoto", true);
      return true;
    })();
    """

    /// JSON string literals are valid JavaScript literals, so quoting stays safe
    /// for apostrophes, quotes, emoji and every other UTF-8 payload.
    static func jsLiteral(_ value: String) -> String {
        guard let data = try? JSONEncoder().encode(value),
              let literal = String(data: data, encoding: .utf8) else {
            return "\"\""
        }
        return literal
    }

    /// Same trick for the photo list: a JSON array is a valid JS array literal.
    static func jsArrayLiteral(_ values: [String]) -> String {
        guard let data = try? JSONEncoder().encode(values),
              let literal = String(data: data, encoding: .utf8) else {
            return "[]"
        }
        return literal
    }

    private func persist(_ value: Any, _ key: String) {
        defaults.set(value, forKey: key)
        onChange?(self)
    }
}

// MARK: - Desktop window

/// Borderless window that can never take focus from the user's apps.
final class DesktopLevelWindow: NSWindow {
    /// One step below every normal window: right above the wallpaper picture and
    /// right below the Finder desktop icons.
    static let desktopLevel = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopWindow)))

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

// MARK: - Desktop window controller

/// Owns one desktop-level `WKWebView` per display and keeps it in sync with
/// `WallpaperPreferences`.
final class DesktopWindowController: NSObject, ObservableObject {
    let preferences: WallpaperPreferences

    /// `true` while the wallpaper is detached from the desktop (menu bar toggle).
    @Published private(set) var isPaused = false

    /// Name of the photo the page last put on screen, `""` when the slideshow is
    /// off or nothing has painted yet. The menu bar preview card names it.
    @Published private(set) var currentPhotoName = ""

    /// The photo itself, downsampled for the menu bar's preview card.
    ///
    /// Decoded once per reveal instead of at draw time: the card is 120 pt tall, so a
    /// 5K wallpaper is reduced to a 720 px thumbnail on a background queue and the
    /// popover only ever composites a texture that fits in a few hundred kilobytes.
    /// `nil` means "no live photo", and the card falls back to the band gradient.
    @Published private(set) var previewImage: NSImage?

    /// How many photos the active folder resolved to, for the folder row.
    var photoCount: Int { preferences.photoCount }

    private final class WallpaperWindow {
        let window: NSWindow
        let webView: WKWebView
        let screen: NSScreen
        var isReady = false
        /// The suspension state the page was last told about.
        var isSuspended = false
        /// Whether this desktop has ever reported itself visible. AppKit only reports
        /// a window as covered once it has been on screen, so this keeps a window that
        /// never becomes visible (a headless launch, a display asleep at boot) from
        /// being suspended for the rest of the session.
        var hasBeenVisible = false
        /// What this page has already received, so a push only sends what changed.
        var pushedSettings: String?
        var pushedPhotos: [String]?
        /// The imported font data URL the page already has (nil = never pushed).
        var pushedFont: String?
        /// Rectangles (viewport CSS pixels) the page will take a click in, as last
        /// reported. Empty means the wallpaper is purely decorative right now.
        var hitArea = WidgetHitArea.closed
        /// Whether this display has already logged that its widgets came up.
        var loggedWidgets = false
        /// Occlusion notifications are registered per window and removed with it.
        var observers: [NSObjectProtocol] = []

        init(window: NSWindow, webView: WKWebView, screen: NSScreen) {
            self.window = window
            self.webView = webView
            self.screen = screen
        }
    }

    private var windows: [WallpaperWindow] = []
    private var screenSignature: [String] = []
    private var pendingPush: DispatchWorkItem?
    /// Band the native layers were last painted with, and the one-shot timer that
    /// waits for the clock to cross into the next one.
    private var activeThemeSlot = ThemeSlot.current()
    private var themeTimer: Timer?
    /// Palette the current timer was scheduled for (typing must not re-arm it).
    private var scheduledPreset: ThemePreset?
    private var themeObservers: [NSObjectProtocol] = []
    private var workspaceObservers: [NSObjectProtocol] = []
    /// Displays asleep or session locked: every page stands still until they are not.
    private var systemSuspended = false
    /// Photos the wallpaper rotates through. The standard `~/Pictures/DynaWall`
    /// folder is the default; an explicit pick replaces it.
    private let photoLibrary = PhotoLibrary()
    /// Folder the current photo list was scanned from (`nil` = never loaded).
    private var loadedPhotoSource: String?
    /// Bumped on every reveal so a slow decode can never overwrite a newer photo.
    private var previewImageToken = 0

    /// Shared by every display: one in-memory data store, one scheme handler and one
    /// message logger. A second monitor reuses them instead of standing up a parallel
    /// WebKit world (and a duplicate IPC handler). The process pool is shared by
    /// WebKit itself on macOS 12 (a per-app pool is the only one that exists there),
    /// so there is nothing left to multiply per screen.
    private let dataStore = WKWebsiteDataStore.nonPersistent()
    private let photoLogger = PhotoEventLogger()
    private lazy var photoSchemeHandler = PhotoSchemeHandler(library: photoLibrary)
    /// Carries the widget rectangles up from every page and the browser open back down.
    private let widgetBridge = WidgetMessageHandler()
    /// The system-wide mouse watch that forwards desktop clicks into the cards.
    private var clickMonitor: Any?

    /// Typing in the popover updates the wallpaper live; a short coalescing window
    /// keeps the web app's greeting cross-fade smooth while keys are pressed.
    private let pushDebounce: TimeInterval = 0.15

    init(preferences: WallpaperPreferences = WallpaperPreferences()) {
        self.preferences = preferences
        super.init()
        // The page reports every photo it reveals; the popover turns that into the
        // "currently on screen" line of the mini-preview card.
        photoLogger.onAdvance = { [weak self] name in
            guard let self else { return }
            if Thread.isMainThread {
                self.currentPhotoName = name
            } else {
                DispatchQueue.main.async { self.currentPhotoName = name }
            }
        }
        // The same reveal, as the URL of the file on disk: the card draws the photo
        // the desktop is actually showing instead of a colour that merely matches it.
        photoLogger.onSource = { [weak self] source in
            guard let self else { return }
            if Thread.isMainThread {
                self.loadPreviewImage(from: source)
            } else {
                DispatchQueue.main.async { self.loadPreviewImage(from: source) }
            }
        }
        preferences.onChange = { [weak self] _ in
            guard let self else { return }
            self.schedulePush()
            // No slideshow, no photo on screen: the preview card must not name one.
            if !self.preferences.slideshow {
                self.currentPhotoName = ""
                // Dropping the decoded texture too keeps a paused wallpaper from
                // holding a full-size bitmap for a photo nobody can see any more.
                self.previewImage = nil
            }
            // Only a palette switch needs a new clock timer; typing must not re-arm it.
            if self.preferences.themePreset != self.scheduledPreset {
                self.scheduleThemeTimer()
            }
        }
        // The page's widget side: where it accepts a click, and where it sends the
        // browser when the user picks a link. Both arrive from any display, so the
        // web view identifies which one reported.
        widgetBridge.onRegions = { [weak self] webView, area in
            guard let self, let entry = self.entry(for: webView) else { return }
            entry.hitArea = area
            // One line per display the first time the page reports its satellites: it
            // is the only honest proof that the cards came up at all.
            if !entry.loggedWidgets, !area.regions.isEmpty {
                entry.loggedWidgets = true
                dynaLog("widgets: \(area.regions.count) clickable region(s) reported")
            }
        }
        widgetBridge.onOpenURL = { target in
            guard let url = URL(string: target) else { return }
            dynaLog("opening \(url.host ?? "link") in the default browser")
            NSWorkspace.shared.open(url)
        }
    }

    // MARK: Lifecycle

    func start() {
        observeSystemEvents()
        // Cards answer to clicks that the desktop owns, so the mouse is watched from
        // the moment the wallpaper exists.
        startClickMonitor()
        // The standard folder has to exist before the first scan, and a fresh
        // install is seeded from the bundled wallpapers so the app has something
        // to show before the user picks anything.
        prepareStandardPhotoFolder()
        // The seed is built before the first window exists, so the photo list has to
        // be resolved first.
        reloadPhotosIfNeeded()
        rebuild()
        startThemeClock()
    }

    /// Stop everything: timer, observers and web views. Called on termination.
    func stop() {
        stopClickMonitor()
        themeTimer?.invalidate()
        themeTimer = nil
        for observer in themeObservers {
            NotificationCenter.default.removeObserver(observer)
        }
        themeObservers.removeAll()
        for observer in workspaceObservers {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
        }
        workspaceObservers.removeAll()
        tearDown()
    }

    // MARK: System events

    /// The clock itself can move without any timer firing (the user set the time,
    /// a time zone or DST change landed, the day rolled over), and the displays can
    /// sleep or the session can lock without the wallpaper being asked.
    private func observeSystemEvents() {
        if themeObservers.isEmpty {
            let center = NotificationCenter.default
            for name in [Notification.Name.NSSystemClockDidChange, .NSCalendarDayChanged] {
                themeObservers.append(
                    center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                        dynaLog("system clock changed — re-reading the palette")
                        self?.refreshThemeIfNeeded()
                        self?.scheduleThemeTimer()
                    }
                )
            }
        }

        if workspaceObservers.isEmpty {
            let center = NSWorkspace.shared.notificationCenter
            let events: [(Notification.Name, Bool, String)] = [
                (NSWorkspace.screensDidSleepNotification, true, "displays asleep — wallpaper suspended"),
                (NSWorkspace.willSleepNotification, true, "system will sleep — wallpaper suspended"),
                (NSWorkspace.sessionDidResignActiveNotification, true, "session locked — wallpaper suspended"),
                (NSWorkspace.screensDidWakeNotification, false, "displays awake — wallpaper resumed"),
                (NSWorkspace.sessionDidBecomeActiveNotification, false, "session unlocked — wallpaper resumed")
            ]
            for event in events {
                workspaceObservers.append(
                    center.addObserver(forName: event.0, object: nil, queue: .main) { [weak self] _ in
                        guard let self else { return }
                        dynaLog(event.2)
                        self.setSystemSuspended(event.1)
                        if !event.1 { self.resync() }
                    }
                )
            }
        }
    }

    /// Displays asleep or session locked: park every page until the state flips back.
    private func setSystemSuspended(_ suspended: Bool) {
        guard suspended != systemSuspended else { return }
        systemSuspended = suspended
        for entry in windows {
            applySuspension(to: entry)
        }
    }

    // MARK: Time-aware palette

    private func startThemeClock() {
        activeThemeSlot = ThemeSlot.current()
        refreshThemeIfNeeded()
        scheduleThemeTimer()
    }

    /// Arm one timer for the exact next band boundary.
    ///
    /// The previous implementation woke up every 60 s (1,440 times a day) just to
    /// compare the hour. Nothing about the palette can change between 05:00, 09:00,
    /// 17:00 and 21:00, so the timer sleeps until then. A pinned palette never
    /// consults the clock and a paused wallpaper is not on screen, so neither
    /// schedules a timer at all.
    private func scheduleThemeTimer() {
        themeTimer?.invalidate()
        themeTimer = nil
        scheduledPreset = preferences.themePreset

        guard preferences.themePreset == .auto, !isPaused else { return }
        guard let fireDate = ThemeSlot.nextBoundary() else { return }

        let interval = max(1, fireDate.timeIntervalSinceNow)
        let timer = Timer(fire: fireDate, interval: 0, repeats: false) { [weak self] _ in
            guard let self else { return }
            self.themeTimer = nil
            self.refreshThemeIfNeeded()
            self.scheduleThemeTimer()
        }
        // A palette change is invisible for a few seconds; let the OS coalesce this
        // wakeup with whatever else it is already doing.
        timer.tolerance = min(30, interval * 0.02)
        // `.common` keeps it alive while a menu or the popover is tracking.
        RunLoop.main.add(timer, forMode: .common)
        themeTimer = timer
        dynaLog("palette: next band check at \(fireDate)")
    }

    /// Repaint the native layers after a band change. Pinned palettes ignore the
    /// clock entirely, so they only need to keep the slot marker current.
    private func refreshThemeIfNeeded() {
        let slot = ThemeSlot.current()
        guard slot != activeThemeSlot else { return }
        let previous = activeThemeSlot
        activeThemeSlot = slot
        guard preferences.themePreset == .auto else { return }

        let color = HexColor.nsColor(preferences.bgColor)
        for entry in windows {
            entry.window.backgroundColor = color
            entry.webView.underPageBackgroundColor = color
        }
        dynaLog("palette: \(previous.rawValue) → \(slot.rawValue) (auto) \(slot.hex)")
    }

    /// Create one desktop window per display. Called on launch and whenever the
    /// display layout changes.
    func rebuild() {
        tearDown()
        screenSignature = Self.signature()
        windows = NSScreen.screens.map { makeWindow(for: $0) }
        dynaLog("desktop windows: \(windows.count) for \(NSScreen.screens.count) display(s)")
    }

    /// Reload the wallpaper only when the display layout really changed.
    func rebuildIfNeeded() {
        guard Self.signature() != screenSignature else { return }
        dynaLog("display layout changed — rebuilding desktop windows")
        rebuild()
    }

    private func tearDown() {
        pendingPush?.cancel()
        pendingPush = nil
        for entry in windows {
            // Occlusion observers are registered against the window that is about to
            // go away; a stale one would keep the controller (and the window) alive.
            for observer in entry.observers {
                NotificationCenter.default.removeObserver(observer)
            }
            entry.observers.removeAll()
            // A script message handler left on a dead web view keeps the logger (and
            // through it this controller) reachable from WebKit's content controller.
            let controller = entry.webView.configuration.userContentController
            controller.removeScriptMessageHandler(forName: "dynawallPhoto")
            controller.removeScriptMessageHandler(forName: WidgetMessageHandler.interactivityName)
            controller.removeScriptMessageHandler(forName: WidgetMessageHandler.openURLName)
            controller.removeAllUserScripts()
            entry.webView.stopLoading()
            entry.webView.navigationDelegate = nil
            entry.window.orderOut(nil)
            entry.window.contentView = nil
        }
        windows.removeAll()
    }

    // MARK: Widget clicks

    /// Watch the mouse so a click can reach a card without the desktop giving up its own.
    ///
    /// The desktop-level window keeps `ignoresMouseEvents = true`: that is what leaves
    /// Finder drag-select, right-click, `⌃`-click, the icons, Mission Control and
    /// hot corners exactly as they were. The page, in turn, never sees a pointer, so
    /// the host has to notice the click itself and replay it in the page. Three rules
    /// keep that from stealing anything:
    ///
    /// - the event is only observed, never consumed — the desktop still gets every click;
    /// - a click on another app's window, the Dock, or our own popover is ignored;
    /// - a click outside the rectangles the page reported is ignored, so empty
    ///   wallpaper behaves precisely as it did before widgets existed.
    ///
    /// Mouse monitors need no accessibility grant. If the system ever withholds one,
    /// `clickMonitor` stays `nil` and the wallpaper is simply decorative again.
    private func startClickMonitor() {
        guard clickMonitor == nil else { return }
        clickMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown]) { [weak self] _ in
            self?.forwardDesktopClick(at: NSEvent.mouseLocation)
        }
        if clickMonitor == nil {
            dynaLog("no mouse monitor: wallpaper widgets stay decorative")
        }
    }

    private func stopClickMonitor() {
        if let clickMonitor {
            NSEvent.removeMonitor(clickMonitor)
        }
        clickMonitor = nil
    }

    /// Replay one desktop click into the page that owns that point, if any.
    private func forwardDesktopClick(at point: CGPoint) {
        // Paused wallpaper, or the user is clicking our own menu bar popover: not a
        // click on the desktop at all.
        guard !isPaused, !NSApp.isActive else { return }

        for entry in windows {
            let frame = entry.window.frame
            guard entry.window.isVisible, frame.contains(point) else { continue }

            // CSS pixels are points here: the page is never zoomed and the window
            // covers its display at native scale.
            let local = CGPoint(x: point.x - frame.minX, y: frame.maxY - point.y)
            guard entry.hitArea.contains(local) else { continue }
            guard !isCovered(byAnotherAppAt: point) else { continue }

            let script = "window.DynaWall && window.DynaWall.clickAt(\(local.x), \(local.y));"
            entry.webView.evaluateJavaScript(script) { _, error in
                if let error {
                    dynaLog("widget click failed: \(error.localizedDescription)")
                }
            }
            return
        }
    }

    /// `true` when a normal window of another app sits at `point`, so the click there
    /// belongs to that app and must not be replayed into the wallpaper.
    ///
    /// Layer 0 is the layer of ordinary app windows; the menu bar, the Dock, the
    /// desktop icons and the wallpaper itself are all elsewhere, and the window list
    /// below only asks "is something in front of the desktop here?".
    private func isCovered(byAnotherAppAt point: CGPoint) -> Bool {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
            // No window list: assume the desktop is not ours to click.
            return true
        }

        let ownPID = ProcessInfo.processInfo.processIdentifier
        for info in list {
            guard (info[kCGWindowLayer as String] as? Int) == 0 else { continue }
            guard (info[kCGWindowOwnerPID as String] as? pid_t) != ownPID else { continue }
            guard let bounds = info[kCGWindowBounds as String] as? [String: Any],
                  let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary) else { continue }
            if rect.contains(point) { return true }
        }
        return false
    }

    private static func signature() -> [String] {
        NSScreen.screens.map { NSStringFromRect($0.frame) }
    }

    // MARK: Window creation

    private var resourcesURL: URL? { Bundle.main.resourceURL }

    /// `WKWebView.loadFileURL` rejects URLs carrying a query string (WebKit raises
    /// an exception that aborts the AppKit launch), so the page is loaded bare and
    /// the settings arrive as a `WKUserScript` seed plus any later IPC deltas.
    private var indexURL: URL? {
        resourcesURL?.appendingPathComponent("index.html")
    }

    private func makeWindow(for screen: NSScreen) -> WallpaperWindow {
        let frame = screen.frame
        let color = HexColor.nsColor(preferences.bgColor)

        let configuration = WKWebViewConfiguration()
        // One in-memory store for every display: wallpaper state stays out of the
        // user's Safari/WebKit data, and a second monitor reuses the same session.
        configuration.websiteDataStore = dataStore
        configuration.suppressesIncrementalRendering = true
        // Photos live outside the bundle, so they are served through a private scheme.
        configuration.setURLSchemeHandler(photoSchemeHandler, forURLScheme: PhotoLibrary.scheme)
        configuration.userContentController.add(photoLogger, name: "dynawallPhoto")
        // Widgets: the page says which rectangles may take a click and asks for the
        // browser when the user picks a link.
        configuration.userContentController.add(widgetBridge, name: WidgetMessageHandler.interactivityName)
        configuration.userContentController.add(widgetBridge, name: WidgetMessageHandler.openURLName)
        // First paint = the user's wallpaper. `script.js` reads this seed while it
        // resolves its configuration, so there is no built-in copy to cross-fade
        // (and no reason to hold the window back while that swap happens).
        configuration.userContentController.addUserScript(
            WKUserScript(
                source: preferences.javaScriptSeed(photoURLs: photoLibrary.photoURLs()),
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )

        let webView = WKWebView(frame: NSRect(origin: .zero, size: frame.size), configuration: configuration)
        webView.appearance = NSAppearance(named: .darkAqua)
        webView.underPageBackgroundColor = color
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self

        let window = DesktopLevelWindow(
            contentRect: frame,
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.level = DesktopLevelWindow.desktopLevel
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        window.ignoresMouseEvents = true
        window.acceptsMouseMovedEvents = false
        window.isMovable = false
        window.isMovableByWindowBackground = false
        window.isOpaque = true
        window.hasShadow = false
        window.backgroundColor = color
        window.animationBehavior = .none
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        window.isExcludedFromWindowsMenu = true
        window.contentView = webView
        window.setFrame(frame, display: false)
        // Invisible until the page is painted: no white flash over the wallpaper.
        window.alphaValue = 0
        window.orderFrontRegardless()

        let entry = WallpaperWindow(window: window, webView: webView, screen: screen)
        // The seed injected above already carries the imported font, so this display
        // is up to date before its first frame and the (large) font push is skipped.
        entry.pushedFont = preferences.customFontSource
        // Stand still as soon as this desktop is completely covered, and come back
        // when it is visible again: a wallpaper nobody can see must cost no frames.
        entry.observers.append(
            NotificationCenter.default.addObserver(
                forName: NSWindow.didChangeOcclusionStateNotification,
                object: window,
                queue: .main
            ) { [weak self, weak entry] _ in
                guard let self, let entry else { return }
                self.applySuspension(to: entry)
            }
        )

        if let indexURL, let resourcesURL {
            webView.loadFileURL(indexURL, allowingReadAccessTo: resourcesURL)
        } else {
            dynaLog("bundled web wallpaper missing from \(Bundle.main.bundlePath)")
        }

        return entry
    }

    // MARK: Live updates

    private func entry(for webView: WKWebView) -> WallpaperWindow? {
        windows.first { $0.webView === webView }
    }

    /// Push every setting to every display, skipping whatever that display already
    /// has.
    func pushCurrentPreferences() {
        reloadPhotosIfNeeded()

        let settingsScript = preferences.javaScriptUpdate
        let photosURLs = photoLibrary.photoURLs()
        let fontSource = preferences.customFontSource
        let color = HexColor.nsColor(preferences.bgColor)

        for entry in windows {
            entry.window.backgroundColor = color
            entry.webView.underPageBackgroundColor = color
            guard entry.isReady else { continue }

            // A keystroke in "First name" or "Subtitle" only changes the settings
            // payload, so the photo array is neither re-encoded nor re-sent; an
            // unchanged settings payload is skipped the same way.
            if entry.pushedSettings != settingsScript {
                entry.pushedSettings = settingsScript
                entry.webView.evaluateJavaScript(settingsScript) { _, error in
                    if let error {
                        dynaLog("settings push failed: \(error.localizedDescription)")
                    }
                }
            }
            // An empty list is a real answer — a custom folder with no matching
            // images — and has to reach the page, otherwise the previously pushed
            // collection stays on the desktop after the folder was emptied.
            if entry.pushedPhotos != photosURLs {
                entry.pushedPhotos = photosURLs
                entry.webView.evaluateJavaScript(Self.photosJavaScriptUpdate(photosURLs)) { _, error in
                    if let error {
                        dynaLog("photo push failed: \(error.localizedDescription)")
                    }
                }
            }
            // The imported font is megabytes of base64, so it travels on its own and
            // only when the file (or its absence) changed — never on every keystroke.
            if entry.pushedFont != fontSource {
                entry.pushedFont = fontSource
                entry.webView.evaluateJavaScript(WallpaperPreferences.javaScriptFontUpdate(fontSource)) { _, error in
                    if let error {
                        dynaLog("font push failed: \(error.localizedDescription)")
                    }
                }
            }
            applySuspension(to: entry)
        }
    }

    /// Create `~/Pictures/DynaWall` on launch and seed a brand-new folder with
    /// the wallpapers shipped in `DynaWall.app/Contents/Resources/images`.
    ///
    /// Seeding only happens when the folder does not exist. An existing folder —
    /// including one the user has emptied — is never touched, so deleting every
    /// photo really does produce the solid-black fallback instead of restoring
    /// the bundled set on the next launch.
    private func prepareStandardPhotoFolder() {
        let folder = URL(
            fileURLWithPath: WallpaperPreferences.standardPhotoFolderPath,
            isDirectory: true
        )
        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: folder.path, isDirectory: &isDirectory) {
            if !isDirectory.boolValue {
                dynaLog("standard photo folder is not a directory: \(folder.path)")
            }
            return
        }
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        } catch {
            dynaLog("could not create standard photo folder: \(error.localizedDescription)")
            return
        }
        seedStandardPhotoFolder(at: folder)
    }

    /// Copy the bundled wallpapers into a freshly created standard folder.
    ///
    /// The bundle is read-only (and may be translocated), so the user-visible
    /// `Pictures/DynaWall` folder is the place they can add or remove images.
    /// Copying once keeps the app useful on first launch without re-seeding a
    /// folder they intentionally emptied later.
    private func seedStandardPhotoFolder(at folder: URL) {
        guard let bundled = Bundle.main.resourceURL?
            .appendingPathComponent("images", isDirectory: true) else {
            dynaLog("bundled images folder is missing; standard photo folder stays empty")
            return
        }
        let entries = (try? FileManager.default.contentsOfDirectory(
            at: bundled,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles, .skipsPackageDescendants]
        )) ?? []
        var copied = 0
        for source in entries
        where PhotoLibrary.supportedExtensions.contains(source.pathExtension.lowercased()) {
            let destination = folder.appendingPathComponent(source.lastPathComponent)
            guard !FileManager.default.fileExists(atPath: destination.path) else { continue }
            do {
                try FileManager.default.copyItem(at: source, to: destination)
                copied += 1
            } catch {
                dynaLog("could not seed \(source.lastPathComponent): \(error.localizedDescription)")
            }
        }
        dynaLog("seeded standard photo folder with \(copied) bundled wallpaper(s) at \(folder.path)")
    }

    /// Re-scan whenever the user points the slideshow at another folder.
    private func reloadPhotosIfNeeded(force: Bool = false) {
        let path = preferences.effectivePhotoFolderPath
        guard force || path != loadedPhotoSource else { return }
        loadedPhotoSource = path
        photoLibrary.reload(folderPath: path)
        let count = photoLibrary.count
        preferences.updatePhotoCount(count)
        // An empty folder cannot run a slideshow: park the switch so the popover
        // opens with the controls inactive instead of switched on but dead.
        if count == 0 && preferences.slideshow {
            preferences.slideshow = false
        }
        dynaLog("photo library: \(photoLibrary.summary)")
    }

    /// The resolved photo list, pushed through the same bridge Lively uses.
    private static func photosJavaScriptUpdate(_ urls: [String]) -> String {
        """
        (function () {
          if (typeof window.livelyPropertyListener !== "function") { return false; }
          window.livelyPropertyListener("photos", \(WallpaperPreferences.jsArrayLiteral(urls)));
          return true;
        })();
        """
    }

    // MARK: Suspension

    /// A display stands still when the user paused the wallpaper, the session is
    /// locked, the displays are asleep, or this window is completely covered. The
    /// page is only told when the answer actually changes.
    private func applySuspension(to entry: WallpaperWindow) {
        let visible = entry.window.occlusionState.contains(.visible)
        if visible { entry.hasBeenVisible = true }
        // AppKit only reports a window as covered once it has been on screen; until
        // then a "not visible" reading is "not shown yet", not "covered".
        let covered = entry.hasBeenVisible && !visible
        let suspended = isPaused || systemSuspended || covered
        guard suspended != entry.isSuspended else { return }
        // The page has not loaded yet: `didFinish` runs this again once it has.
        guard entry.isReady else { return }

        entry.isSuspended = suspended
        entry.webView.evaluateJavaScript(WallpaperPreferences.javaScriptSuspend(suspended)) { _, error in
            if let error {
                dynaLog("suspend push failed: \(error.localizedDescription)")
            }
        }
        dynaLog(suspended ? "display suspended (0 FPS)" : "display resumed")
    }

    private func schedulePush() {
        pendingPush?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.pendingPush = nil
            self.pushCurrentPreferences()
        }
        pendingPush = work
        DispatchQueue.main.asyncAfter(deadline: .now() + pushDebounce, execute: work)
    }

    // MARK: Next photo

    /// Skip every display to the next photo immediately.
    ///
    /// The page owns the rotation, so this rides the same momentary action a
    /// Lively button would fire (`livelyPropertyListener("nextPhoto", true)`); the
    /// page picks the next photo of the active time band and restarts its timer.
    /// The haptic pulse is the only acknowledgement a menu bar skip can give: it
    /// lands the moment the click registers, not when the cross-fade finishes.
    func nextPhoto() {
        var ready = 0
        for entry in windows where entry.isReady {
            ready += 1
            entry.webView.evaluateJavaScript(WallpaperPreferences.javaScriptNextPhoto) { _, error in
                if let error {
                    dynaLog("next photo failed: \(error.localizedDescription)")
                }
            }
        }
        if ready > 0 {
            DynaHaptics.tap(.alignment)
        }
        dynaLog(ready == 0 ? "next photo skipped (no page ready)" : "next photo requested")
    }

    /// Decode a thumbnail of the photo the page just revealed.
    ///
    /// ImageIO reads the dimensions from the file header and produces a
    /// `kCGImageSourceThumbnailMaxPixelSize`-bounded bitmap, so a 5K JPEG costs a few
    /// hundred kilobytes here instead of a ~60 MB full decode. The work happens on a
    /// utility queue and `previewImageToken` makes sure a slow decode of the outgoing
    /// photo cannot overwrite the one that replaced it.
    private func loadPreviewImage(from source: String) {
        previewImageToken += 1
        let token = previewImageToken
        guard let url = URL(string: source),
              let index = PhotoSchemeHandler.photoIndex(from: url),
              let fileURL = photoLibrary.file(at: index) else {
            previewImage = nil
            return
        }
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let image = Self.thumbnail(at: fileURL, maxPixelSize: 720)
            DispatchQueue.main.async {
                guard let self, token == self.previewImageToken else { return }
                self.previewImage = image
            }
        }
    }

    /// A downsampled, upright `NSImage` for the preview card.
    ///
    /// Every format the photo library accepts (JPEG, PNG, HEIC, TIFF, WebP, BMP, GIF)
    /// decodes through ImageIO. A file that cannot be read returns `nil`, which leaves
    /// the card on its gradient rather than on a blank rectangle.
    private static func thumbnail(at url: URL, maxPixelSize: Int) -> NSImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            // Honour the EXIF orientation: a portrait wallpaper must not arrive rotated.
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize
        ]
        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(
            source,
            0,
            options as CFDictionary
        ) else {
            return nil
        }
        return NSImage(cgImage: cgImage, size: NSSize(width: cgImage.width, height: cgImage.height))
    }

    /// Refresh the greeting right away (system wake, wallpaper resume).
    func resync() {
        rebuildIfNeeded()
        refreshThemeIfNeeded() // the band may have changed while the Mac slept
        scheduleThemeTimer() // and the next boundary may be closer than the old timer
        reloadPhotosIfNeeded(force: true) // pick up files added while asleep
        pushCurrentPreferences()
        for entry in windows where entry.isReady {
            entry.webView.evaluateJavaScript(WallpaperPreferences.javaScriptResync) { _, error in
                if let error {
                    dynaLog("greeting resync failed: \(error.localizedDescription)")
                }
            }
        }
    }

    // MARK: Pause / resume

    func togglePause() {
        setPaused(!isPaused)
    }

    func setPaused(_ paused: Bool) {
        guard paused != isPaused else { return }
        isPaused = paused
        // A flip, not a move: `.levelChange` is the pattern macOS uses for a switch.
        DynaHaptics.tap(.levelChange)

        for entry in windows {
            if paused {
                entry.window.orderOut(nil)
            } else {
                entry.window.orderFrontRegardless()
                if entry.isReady {
                    entry.window.alphaValue = 1
                }
            }
            // Paused wallpaper: park the page as well, so a detached desktop does not
            // keep a hidden WebKit process animating.
            applySuspension(to: entry)
        }

        // A paused wallpaper needs no clock wakeup; a resumed one needs its next one.
        scheduleThemeTimer()

        if !paused {
            resync()
        }
        dynaLog(paused ? "wallpaper paused" : "wallpaper resumed")
    }

    // MARK: Reveal / verification

    private func reveal(_ entry: WallpaperWindow) {
        guard !isPaused else { return }
        // The page boots from the `WKUserScript` seed, so the first frame it paints is
        // already the user's wallpaper; there is no built-in copy being swapped out,
        // and therefore nothing to hide. Only the entrance fade needs to be under way.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self, weak entry] in
            guard let self, let entry, !self.isPaused else { return }
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.25
                entry.window.animator().alphaValue = 1
            }
        }
    }

    /// Reads the live DOM back out of the page so a build can be smoke tested from
    /// a terminal without any screen-recording permissions.
    private func logRenderedState(from entry: WallpaperWindow) {
        let script = """
        (function () {
          var greeting = document.getElementById("greeting");
          var subtitle = document.getElementById("subtitle");
          // The first family of the computed stack is what the page actually asked
          // for; checking *that* face, rather than a hard-coded Outfit, is what tells
          // a bundled face apart from a stack that quietly fell through to the tail.
          var family = greeting
            ? getComputedStyle(greeting).fontFamily.split(",")[0].replace(/["']/g, "").trim()
            : "";
          return {
            greeting: greeting ? greeting.textContent.trim() : "",
            subtitle: subtitle ? subtitle.textContent.trim() : "",
            subtitleHidden: subtitle ? getComputedStyle(subtitle).display === "none" : null,
            background: getComputedStyle(document.body).backgroundColor,
            theme: document.documentElement.getAttribute("data-theme") || "",
            fontFamily: family,
            fontSize: greeting ? getComputedStyle(greeting).fontSize : "",
            // Same text, same size: a different width means a different face actually
            // shaped the line, so a bundled family can be told apart from a stack that
            // silently fell through to its tail.
            greetingWidth: greeting ? Math.round(greeting.getBoundingClientRect().width) : 0,
            // The status of the @font-face behind the family ("loaded" once the bytes
            // parsed), or null when the family brings no face with it — a system font,
            // or a name nothing in this page or the OS can resolve. `fonts.check()`
            // cannot answer this: it returns true for a family it has never heard of.
            fontFaceStatus: (function () {
              if (!document.fonts || !family) return null;
              var status = null;
              document.fonts.forEach(function (face) {
                if (face.family.replace(/["']/g, "").toLowerCase() === family.toLowerCase()) {
                  status = face.status;
                }
              });
              return status;
            })(),
            slideshowOn: document.body.classList.contains("has-photo"),
            photoLayers: document.querySelectorAll("img.photo").length,
            photoSrc: (function () {
              var layer = document.querySelector("img.photo.is-visible");
              return layer ? (layer.getAttribute("src") || "") : "";
            })(),
            photoSize: (function () {
              var layer = document.querySelector("img.photo.is-visible");
              return layer ? layer.naturalWidth + "x" + layer.naturalHeight : "";
            })()
          };
        })();
        """
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) {
            entry.webView.evaluateJavaScript(script) { value, error in
                if let error {
                    dynaLog("state readback failed: \(error.localizedDescription)")
                    return
                }
                let state = value as? [String: Any] ?? [:]
                let subtitle = state["subtitle"] as? String ?? ""
                dynaLog("rendered greeting: \(state["greeting"] as? String ?? "<unknown>")")
                dynaLog("subtitle: \(subtitle.isEmpty ? "<empty>" : subtitle) hidden=\(Self.describe(state["subtitleHidden"]))")
                dynaLog("background: \(state["background"] as? String ?? "<unknown>")")
                dynaLog("palette: \(state["theme"] as? String ?? "<unknown>") (mode: \(self.preferences.themeMode))")
                dynaLog("font: \(state["fontFamily"] as? String ?? "<unknown>") @ \(state["fontSize"] as? String ?? "?") width=\(Self.describe(state["greetingWidth"])) face=\(Self.describe(state["fontFaceStatus"]))")
                let photoSrc = state["photoSrc"] as? String ?? ""
                dynaLog("slideshow: on=\(Self.describe(state["slideshowOn"])) photo=\(photoSrc.isEmpty ? "<none>" : photoSrc) size=\(state["photoSize"] as? String ?? "?") layers=\(Self.describe(state["photoLayers"]))")
                dynaLog("photo collection: \(self.preferences.photoCollection.label) sync=\(self.preferences.photoSync ? "time-of-day" : "off")")
            }
        }
    }

    private static func describe(_ value: Any?) -> String {
        value.map { String(describing: $0) } ?? "unknown"
    }
}

// MARK: - Web view callbacks

extension DesktopWindowController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let entry = entry(for: webView) else { return }
        entry.isReady = true
        // A fresh document has received nothing yet: clear the deltas so the first
        // push after a load (or a reload) is always a full one.
        entry.pushedSettings = nil
        entry.pushedPhotos = nil
        pushCurrentPreferences()
        reveal(entry)
        if entry === windows.first {
            logRenderedState(from: entry)
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        dynaLog("wallpaper failed: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        dynaLog("wallpaper failed to load: \(error.localizedDescription)")
    }
}

// MARK: - Menu bar settings UI

/// Measured height of the popover content, so `NSPopover` can follow the sections
/// as they expand and collapse (it has no self-sizing content controller on macOS 12).
private struct PopoverHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

/// Hover state for the custom-folder drop target.
///
/// `@State` is a Swift macro and the Command Line Tools toolchain used by
/// `build-macos.sh` ships no SwiftUI macro plugin, so popover-local state that has
/// to survive a body evaluation lives in a small observable box instead.
private final class FolderDropTarget: ObservableObject {
    @Published var isTargeted = false
}

struct SettingsPopoverView: View {
    /// Fixed design width; the height is measured from the content.
    static let popoverWidth: CGFloat = 340

    /// One radius for the section cards and one for the controls inside them, so
    /// the panel reads as a single surface instead of a pile of near-misses.
    private static let cardCornerRadius: CGFloat = 12
    private static let controlCornerRadius: CGFloat = 8

    /// The card headers' glyph slot. SF Symbols differ in width, so the frame —
    /// not the symbol — is what puts every section title on the same guide line.
    private static let headerIconSize: CGFloat = 14

    /// The two-column slot every switch rides in, so the four satellites and the
    /// slideshow options below them line up row after row.
    private static let toggleColumnSpacing: CGFloat = 10

    @ObservedObject var preferences: WallpaperPreferences
    @ObservedObject var controller: DesktopWindowController
    /// The panel hosting this view. Weak, because that panel owns the hosting
    /// controller that owns this view; the folder picker closes it for the dialog
    /// and re-presents it afterwards.
    weak var popover: NSPopover?
    /// Re-anchors and reopens the panel, for the folder picker: the settings panel
    /// steps aside for the modal dialog and has to come back when it closes.
    var onReopenPopover: (() -> Void)?
    /// Called with the ideal content height whenever the layout changes.
    var onContentHeightChange: ((CGFloat) -> Void)?

    /// A folder is hovering over the upload row.
    @StateObject private var dropTarget = FolderDropTarget()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            previewCard
            greetingCard
            typographyCard
            photosCard
            widgetsCard
            startupCard
            footer
        }
        .padding(16)
        .frame(width: Self.popoverWidth, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .background(
            GeometryReader { proxy in
                Color.clear.preference(key: PopoverHeightKey.self, value: proxy.size.height)
            }
        )
        .onPreferenceChange(PopoverHeightKey.self) { height in
            onContentHeightChange?(height)
        }
        .onAppear {
            preferences.syncLaunchAtLogin()
        }
    }

    // MARK: Mini preview

    /// A live miniature of the desktop: the active ink, the band's glow, the
    /// greeting the page is painting and the photo it is currently showing.
    private var previewCard: some View {
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(HexColor.color(preferences.bgColor))
            // The photo the desktop is showing right now, under the same scrim the
            // page paints over it, so the card is a true miniature rather than a
            // colour swatch that only approximates one.
            previewPhotoBackdrop
            // The wallpaper's own ambient light: one soft, centred radial accent plus
            // the edge vignette from `.wallpaper-container::before` in style.css,
            // instead of a hard diagonal split across the card.
            RadialGradient(
                colors: [HexColor.color(preferences.previewAccentHex).opacity(0.32), .clear],
                center: UnitPoint(x: 0.5, y: 0.35),
                startRadius: 2,
                endRadius: 180
            )
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            LinearGradient(
                colors: [.clear, Color.black.opacity(0.22)],
                startPoint: .center,
                endPoint: .bottom
            )
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))

            // The wallpaper centres `.wallpaper-content` in the viewport, so the
            // card centres the same text block instead of left-aligning it like a
            // settings row. The badge and photo metadata stay pinned to the edges
            // as chrome, the way they sit outside the page's content column.
            ZStack {
                VStack(spacing: 2) {
                    // The desktop sets the greeting at 4.7vw; the card keeps a
                    // legible 19 pt floor while preserving the face, the 600
                    // weight, the -3% tracking and the band's ink — which is what
                    // makes the two read as the same typography.
                    Text(preferences.previewGreeting)
                        .font(WallpaperFont.semibold(size: 19, family: preferences.fontFamily))
                        .tracking(WallpaperFont.tracking(size: 19, em: -0.03))
                        .foregroundColor(HexColor.color(preferences.previewTextPrimaryHex))
                        .shadow(
                            color: HexColor.color(preferences.previewTextPrimaryHex).opacity(0.08),
                            radius: 9,
                            x: 0,
                            y: 1
                        )
                        .lineLimit(1)
                        .minimumScaleFactor(0.65)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                    if !trimmedSubtitle.isEmpty {
                        Text(trimmedSubtitle)
                            .font(WallpaperFont.regular(size: 11, family: preferences.fontFamily))
                            .tracking(WallpaperFont.tracking(size: 11, em: 0.012))
                            .foregroundColor(HexColor.color(preferences.previewTextSecondaryHex))
                            .lineLimit(1)
                            .multilineTextAlignment(.center)
                            .frame(maxWidth: .infinity)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.horizontal, 8)

                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 8) {
                        bandBadge
                        Spacer(minLength: 0)
                        pausePill
                    }
                    Spacer(minLength: 0)
                    previewPhotoLine
                }
            }
            .padding(12)
        }
        .frame(height: 120)
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Desktop preview")
    }

    private var trimmedSubtitle: String {
        preferences.subtitleText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The photo behind the card's chrome.
    ///
    /// Drawn only while the slideshow is on and a reveal has been decoded, so the
    /// card never shows a picture the desktop has already left behind, and so a
    /// wallpaper without photos stays a pure gradient. The thumbnail is bounded by
    /// `DesktopWindowController.thumbnail` (720 px on its long edge) and pinned to
    /// the card's exact size, which keeps the popover's measured height constant
    /// whether or not a photo is present — a card that grew the moment the first
    /// photo landed would resize the whole panel mid-fade.
    @ViewBuilder
    private var previewPhotoBackdrop: some View {
        if preferences.slideshow, let photo = controller.previewImage {
            Image(nsImage: photo)
                .resizable()
                .interpolation(.medium)
                .aspectRatio(contentMode: .fill)
                .frame(width: Self.popoverWidth - 32, height: 120)
                .clipped()
                // `.scrim` in style.css: a radial darkening that is deepest behind
                // the greeting, plus a flat wash, never a full black-out.
                .overlay(
                    RadialGradient(
                        colors: [Color.black.opacity(0.18), Color.black.opacity(0.58)],
                        center: UnitPoint(x: 0.5, y: 0.46),
                        startRadius: 10,
                        endRadius: 230
                    )
                )
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .animation(.easeOut(duration: 0.35), value: photo)
        }
    }

    /// `Dawn`, `Day`, `Dusk`, `Night`, `Paused` — or the pinned preset's name.
    private var bandBadge: some View {
        HStack(spacing: 4) {
            Image(systemName: badgeSymbol)
                .font(.system(size: 9, weight: .bold))
            Text(badgeLabel)
                .font(.system(size: 9.5, weight: .semibold))
                .lineLimit(1)
        }
        .foregroundColor(.white.opacity(0.92))
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(Capsule().fill(Color.white.opacity(0.16)))
        .overlay(Capsule().strokeBorder(Color.white.opacity(0.16), lineWidth: 0.5))
    }

    private var badgeSymbol: String {
        if controller.isPaused { return "pause.fill" }
        if let slot = preferences.activeThemeSlot { return slot.symbolName }
        return preferences.themePreset.symbolName
    }

    private var badgeLabel: String {
        if controller.isPaused { return "Paused" }
        if let slot = preferences.activeThemeSlot { return slot.label }
        return preferences.themePreset.shortLabel
    }

    private var pausePill: some View {
        Button {
            controller.togglePause()
        } label: {
            HStack(spacing: 4) {
                Image(systemName: controller.isPaused ? "play.fill" : "pause.fill")
                    .font(.system(size: 8, weight: .bold))
                Text(controller.isPaused ? "Resume" : "Pause")
                    .font(.system(size: 9.5, weight: .semibold))
            }
            .foregroundColor(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Capsule().fill(Color.white.opacity(0.18)))
        }
        .buttonStyle(.plain)
        .help(controller.isPaused ? "Reattach the wallpaper to the desktop" : "Detach the wallpaper from the desktop")
    }

    @ViewBuilder
    private var previewPhotoLine: some View {
        if controller.isPaused {
            HStack(spacing: 5) {
                Image(systemName: "pause.fill")
                    .font(.system(size: 8.5, weight: .semibold))
                Text("Wallpaper paused — click Resume to reattach")
                    .font(.system(size: 9.5))
                    .lineLimit(1)
            }
            .foregroundColor(.white.opacity(0.55))
        } else if preferences.slideshow {
            HStack(spacing: 5) {
                Image(systemName: "photo.fill")
                    .font(.system(size: 8.5, weight: .semibold))
                Text(controller.currentPhotoName.isEmpty ? "Loading the first photo…" : controller.currentPhotoName)
                    .font(.system(size: 9.5))
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .foregroundColor(.white.opacity(0.55))
        } else {
            Text("Photos off · palette only")
                .font(.system(size: 9.5))
                .foregroundColor(.white.opacity(0.45))
        }
    }

    // MARK: Greeting

    private var greetingCard: some View {
        card(systemImage: "textformat", title: "Greeting") {
            // A plain field drawn on the card's own chrome, so the subtitle control
            // is the same 11 pt, same-radius plate as the font menu below it instead
            // of a second, native one. The trailing inset keeps typed text out from
            // under the clear button that lives inside the field's trailing edge.
            TextField("What are we building today? (empty hides)", text: $preferences.subtitleText)
                .textFieldStyle(.plain)
                .font(.system(size: 11))
                .padding(.horizontal, 8)
                .padding(.vertical, 5)
                .padding(.trailing, 14)
                .background(
                    RoundedRectangle(cornerRadius: Self.controlCornerRadius, style: .continuous)
                        .fill(Color.primary.opacity(0.05))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: Self.controlCornerRadius, style: .continuous)
                        .strokeBorder(Color.primary.opacity(0.08), lineWidth: 1)
                )
                .overlay(alignment: .trailing) {
                    if !preferences.subtitleText.isEmpty {
                        Button {
                            preferences.subtitleText = ""
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 11.5))
                                .foregroundColor(.secondary)
                        }
                        .buttonStyle(.plain)
                        .padding(.trailing, 6)
                        .help("Hide the subtitle")
                        .accessibilityLabel("Clear subtitle")
                    }
                }
        }
    }

    // MARK: Typography

    private var fontFamilyBinding: Binding<String> {
        Binding(
            get: { preferences.fontFamily },
            set: { selectFontFamily($0) }
        )
    }

    /// The families the dropdown lists: the installed system families only.
    /// `installedFamilies()` filters the bundled faces out (their files are never
    /// removed); the vendored Outfit is always offered as the leading
    /// `Default (Outfit)` entry, and a family imported by an older build is kept
    /// visible so the stored selection is not silently blank.
    private var fontChoices: [String] {
        var choices = WallpaperFont.installedFamilies()
        let current = WallpaperFont.normalizedFamily(preferences.fontFamily)
        if current.caseInsensitiveCompare(WallpaperFont.defaultFamily) != .orderedSame,
           !choices.contains(where: { $0.caseInsensitiveCompare(current) == .orderedSame }) {
            choices.insert(current, at: 0)
        }
        return choices
    }

    /// `Default (Outfit)` for the vendored face, the family name otherwise.
    private var fontPickerLabel: String {
        let current = WallpaperFont.normalizedFamily(preferences.fontFamily)
        return current.caseInsensitiveCompare(WallpaperFont.defaultFamily) == .orderedSame
            ? "Default (Outfit)"
            : current
    }

    private var typographyCard: some View {
        card(systemImage: "textformat.alt", title: "Typography") {
            VStack(alignment: .leading, spacing: 8) {
                // One menu, not a chip grid: every installed family is listed, the
                // bundled default is one entry, and the four bundled faces are not
                // offered as separate choices. The label is the card's only text and it
                // stays on one line (trimmed in the middle): the popover is sized from
                // its measured content, so a second line would grow the panel and move
                // every card below it when the selection changed.
                Menu {
                    Picker("Font", selection: fontFamilyBinding) {
                        Text("Default (Outfit)").tag(WallpaperFont.defaultFamily)
                        ForEach(fontChoices, id: \.self) { family in
                            Text(family).tag(family)
                        }
                    }
                    .pickerStyle(.inline)
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "character.cursor.ibeam")
                            .font(.system(size: 10, weight: .semibold))
                        Text(fontPickerLabel)
                            .font(WallpaperFont.regular(size: 11, family: preferences.fontFamily))
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 8, weight: .semibold))
                    }
                    .foregroundColor(.primary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    // Full width, like the subtitle field and the folder row: the
                    // chevrons stay on the control's right edge and the plate ends
                    // on the same line as every other control in the panel.
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: Self.controlCornerRadius, style: .continuous)
                            .fill(Color.primary.opacity(0.05))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: Self.controlCornerRadius, style: .continuous)
                            .strokeBorder(Color.primary.opacity(0.08), lineWidth: 1)
                    )
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .help("Choose a system font, or keep the bundled Outfit default")
            }
        }
    }

    // MARK: Section chrome

    /// One labelled section: an icon + title, then the controls, on a soft card.
    ///
    /// The header glyph gets a fixed slot so `GREETING`, `TYPOGRAPHY`, `PHOTOS`,
    /// `DESKTOP WIDGETS` and `STARTUP` all start on the same vertical guide, and the
    /// card's padding and radius come from one place so every section is the same
    /// weight on the panel.
    private func card<Content: View>(
        systemImage: String,
        title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 6) {
                Image(systemName: systemImage)
                    .font(.system(size: 9.5, weight: .semibold))
                    .foregroundColor(.secondary)
                    .frame(width: Self.headerIconSize, height: Self.headerIconSize, alignment: .center)
                Text(title.uppercased())
                    .font(.system(size: 9.5, weight: .semibold))
                    .kerning(0.6)
                    .foregroundColor(.secondary)
                Spacer(minLength: 0)
            }
            content()
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Self.cardCornerRadius, style: .continuous)
                .fill(Color.primary.opacity(0.055))
        )
        .overlay(
            RoundedRectangle(cornerRadius: Self.cardCornerRadius, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.08), lineWidth: 1)
        )
    }

    // MARK: Photos

    /// A one-line status capsule: the short replacement for the sentences that used to
    /// explain a control. It holds a fixed single line, so the popover — sized from its
    /// measured content — never jumps when a status changes.
    private func statusBadge(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 9, weight: .medium))
            .foregroundColor(.secondary)
            .lineLimit(1)
            .truncationMode(.middle)
            .padding(.horizontal, 7)
            // Same 3 pt vertical padding as the preview card's band badge, so every
            // capsule in the panel is the same height.
            .padding(.vertical, 3)
            .background(Capsule().fill(Color.primary.opacity(0.07)))
            .overlay(Capsule().strokeBorder(Color.primary.opacity(0.06), lineWidth: 0.5))
    }

    private var photosCard: some View {
        card(systemImage: "photo.on.rectangle.angled", title: "Photos") {
            VStack(alignment: .leading, spacing: 9) {
                // The one way to add photos: a prominent drop target with the folder
                // name, its photo count and a picker. There are no collection tabs.
                folderRow

                // One disabled group keeps the master switch, Next and every
                // slideshow option inert until a folder with images is chosen.
                VStack(alignment: .leading, spacing: 9) {
                    HStack(spacing: 8) {
                        Toggle("Photo slideshow", isOn: $preferences.slideshow)
                            .toggleStyle(.switch)
                            .controlSize(.small)
                        Spacer(minLength: 0)
                        if preferences.slideshow {
                            Button {
                                controller.nextPhoto()
                            } label: {
                                Label("Next", systemImage: "forward.end.fill")
                                    .font(.system(size: 10, weight: .medium))
                            }
                            .buttonStyle(.borderless)
                            .help("Show the next photo now")
                        } else if controller.photoCount == 0 {
                            // The switch stays disabled until the folder yields an
                            // image; two words say why where a sentence used to sit.
                            statusBadge("No photos")
                        }
                    }

                    if preferences.slideshow {
                        // Progressive disclosure: these controls only matter while
                        // the slideshow runs, so they stay out of the way when it
                        // does not.
                        Divider()
                        HStack(spacing: 8) {
                            Toggle("Match time of day", isOn: $preferences.photoSync)
                                .toggleStyle(.switch)
                                .controlSize(.small)
                            Spacer(minLength: 0)
                            statusBadge(preferences.photoCollectionHint)
                        }

                        HStack(alignment: .center, spacing: 8) {
                            Text("Rotate every")
                                .font(.system(size: 11))
                                .fixedSize()
                            Spacer(minLength: 8)
                            Picker("Rotate every", selection: $preferences.slideshowIntervalMinutes) {
                                ForEach(intervalChoices, id: \.self) { minutes in
                                    Text(intervalLabel(minutes)).tag(minutes)
                                }
                            }
                            .pickerStyle(.segmented)
                            .labelsHidden()
                            .controlSize(.small)
                            // A minimum width keeps the segmented control on a stable
                            // footprint for the five standard choices, while letting
                            // it grow if a hand-written interval adds a sixth.
                            .frame(minWidth: 172, alignment: .trailing)
                        }

                        // Shuffle and Slow zoom ride the same two equal columns as
                        // the widget switches below them: label on the column's left
                        // edge, switch on its right, so the panel reads as a grid.
                        HStack(alignment: .center, spacing: Self.toggleColumnSpacing) {
                            Toggle("Shuffle", isOn: $preferences.slideshowShuffle)
                                .toggleStyle(.switch)
                                .controlSize(.small)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            Toggle("Slow zoom", isOn: $preferences.kenBurns)
                                .toggleStyle(.switch)
                                .controlSize(.small)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }
                .disabled(controller.photoCount == 0)
            }
        }
        .animation(.easeInOut(duration: 0.18), value: preferences.slideshow)
    }

    /// The upload / drop target: names the folder, reports its photo count, opens the
    /// folder picker and hands the folder to Finder. Dragging a folder anywhere on the
    /// row has the same effect as clicking Change Folder….
    private var folderRow: some View {
        HStack(alignment: .center, spacing: 8) {
            Image(systemName: dropTarget.isTargeted ? "square.and.arrow.down.fill" : "photo.stack.fill")
                .font(.system(size: 13))
                .foregroundColor(dropTarget.isTargeted ? .accentColor : .secondary)
                // The glyph and the reveal button share one 18 pt slot, so the folder
                // name always starts and ends on the same lines however the row
                // redraws around a drop.
                .frame(width: 18, height: 18, alignment: .center)
            VStack(alignment: .leading, spacing: 1) {
                Text(preferences.photoFolderLabel)
                    .font(.system(size: 11, weight: .medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(folderCaption)
                    .font(.system(size: 9))
                    .foregroundColor(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 6)
            // Reveal in Finder: one click from the panel to the folder the wallpaper
            // is rotating through, which is where a wallpaper is actually added. It
            // wears the same plate as the picker beside it rather than floating as a
            // bare glyph next to a bordered button.
            Button {
                revealPhotoFolder()
            } label: {
                Image(systemName: "arrow.up.forward.app")
                    .font(.system(size: 10.5, weight: .semibold))
                    .frame(width: 24, height: 20, alignment: .center)
                    .background(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .fill(Color.primary.opacity(0.06))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .strokeBorder(Color.primary.opacity(0.10), lineWidth: 1)
                    )
                    .contentShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            }
            .buttonStyle(.plain)
            .controlSize(.small)
            .help("Reveal \(preferences.photoFolderLabel) in Finder")
            .accessibilityLabel("Reveal wallpaper folder in Finder")
            Button("Change Folder…") {
                choosePhotoFolder()
            }
            .controlSize(.small)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 7)
        .background(
            RoundedRectangle(cornerRadius: Self.controlCornerRadius, style: .continuous)
                .fill(dropTarget.isTargeted
                      ? Color.accentColor.opacity(0.20)
                      : Color.primary.opacity(0.06))
        )
        .overlay(
            RoundedRectangle(cornerRadius: Self.controlCornerRadius, style: .continuous)
                .strokeBorder(dropTarget.isTargeted
                              ? Color.accentColor
                              : Color.primary.opacity(0.12),
                              lineWidth: dropTarget.isTargeted ? 1.5 : 1)
        )
        // A drop target has to answer "can I let go here?" before the mouse button is
        // released: the ring glows and the row lifts by a hair while a folder hovers.
        .shadow(
            color: Color.accentColor.opacity(dropTarget.isTargeted ? 0.45 : 0),
            radius: dropTarget.isTargeted ? 7 : 0
        )
        .scaleEffect(dropTarget.isTargeted ? 1.012 : 1)
        .animation(.easeOut(duration: 0.16), value: dropTarget.isTargeted)
        .onDrop(of: [.fileURL], isTargeted: $dropTarget.isTargeted) { providers in
            handleFolderDrop(providers)
        }
        .help("Drag a folder of images here, or click Change Folder… to use another folder")
    }

    /// Hand the active wallpaper folder to Finder.
    ///
    /// The row is the only place in the panel that knows where the pictures live, so
    /// "Reveal in Finder" belongs next to the folder name rather than under a menu.
    private func revealPhotoFolder() {
        preferences.revealPhotoFolderInFinder()
        DynaHaptics.tap(.alignment)
    }

    private var folderCaption: String {
        let count = controller.photoCount
        if preferences.usesStandardPhotoFolder {
            if count == 0 { return "Empty · standard folder" }
            return "\(count) \(count == 1 ? "photo" : "photos") · standard folder"
        }
        if count == 0 { return "No supported images" }
        return "\(count) \(count == 1 ? "photo" : "photos")"
    }

    /// Read the dropped folder URL off the pasteboard and hand it to the model.
    private func handleFolderDrop(_ providers: [NSItemProvider]) -> Bool {
        let identifier = UTType.fileURL.identifier
        guard let provider = providers.first(where: { $0.hasItemConformingToTypeIdentifier(identifier) })
            ?? providers.first else { return false }
        provider.loadItem(forTypeIdentifier: identifier, options: nil) { item, error in
            if let error {
                dynaLog("folder drop failed: \(error.localizedDescription)")
                return
            }
            var url: URL?
            if let data = item as? Data {
                url = URL(dataRepresentation: data, relativeTo: nil)
            } else if let itemURL = item as? URL {
                url = itemURL
            } else if let path = item as? String {
                url = URL(fileURLWithPath: path)
            }
            guard let url else { return }
            // `loadItem` calls back on a background queue; the preferences publish
            // to SwiftUI, which is main-thread only.
            DispatchQueue.main.async {
                if preferences.applyDroppedFolder(url) {
                    // The drop landed: the same discrete pulse as a successful drag in
                    // Finder, so the folder is acknowledged before the row redraws.
                    DynaHaptics.tap(.alignment)
                }
            }
        }
        return true
    }

    // MARK: Widgets

    /// The four desktop satellites: one master switch, then one switch each.
    ///
    /// `widgets` is the wallpaper's master setting — off takes all four glyphs off the
    /// desktop and their click rectangles with them — while the four below take them one
    /// at a time without forgetting the others. The popover is sized from its measured
    /// content, so they ride two to a row, and they only appear while the master switch
    /// is on: the same progressive disclosure the slideshow's options use.
    private var widgetsCard: some View {
        card(systemImage: "circle.grid.2x2", title: "Desktop widgets") {
            VStack(alignment: .leading, spacing: 9) {
                HStack(spacing: 8) {
                    Toggle("On the desktop", isOn: $preferences.widgets)
                        .toggleStyle(.switch)
                        .controlSize(.small)
                    Spacer(minLength: 0)
                    statusBadge(widgetSummary)
                }

                if preferences.widgets {
                    Divider()
                    // Two equal columns, two rows: the switch of each satellite sits
                    // on its column's right edge and its label on the left, so the
                    // four read as one grid rather than four switches drifting with
                    // the width of their words.
                    HStack(alignment: .center, spacing: Self.toggleColumnSpacing) {
                        Toggle("Music", isOn: $preferences.widgetMusic)
                            .toggleStyle(.switch)
                            .controlSize(.small)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Toggle("News", isOn: $preferences.widgetNews)
                            .toggleStyle(.switch)
                            .controlSize(.small)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    HStack(alignment: .center, spacing: Self.toggleColumnSpacing) {
                        Toggle("YouTube", isOn: $preferences.widgetYouTube)
                            .toggleStyle(.switch)
                            .controlSize(.small)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Toggle("Weather", isOn: $preferences.widgetWeather)
                            .toggleStyle(.switch)
                            .controlSize(.small)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
        .animation(.easeInOut(duration: 0.18), value: preferences.widgets)
    }

    /// What the four satellite switches add up to, for the card's badge.
    private var widgetSummary: String {
        guard preferences.widgets else { return "Hidden" }
        let shown = [
            preferences.widgetMusic,
            preferences.widgetNews,
            preferences.widgetYouTube,
            preferences.widgetWeather
        ].filter { $0 }.count
        switch shown {
        case 4: return "All four"
        case 0: return "None"
        default: return "\(shown) of 4"
        }
    }

    // MARK: Startup

    private var startupCard: some View {
        card(systemImage: "power", title: "Startup") {
            VStack(alignment: .leading, spacing: 6) {
                Toggle("Launch at login", isOn: $preferences.launchAtLogin)
                    .toggleStyle(.switch)
                    .controlSize(.small)
                if preferences.launchAtLoginRequiresApproval {
                    HStack(alignment: .center, spacing: 6) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 10))
                            .foregroundColor(.orange)
                            .frame(width: Self.headerIconSize, height: Self.headerIconSize, alignment: .center)
                        Text("Permission needed in System Settings → Login Items.")
                            .font(.system(size: 9.5))
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        Button("Open Settings") {
                            LaunchAtLogin.openSystemSettings()
                        }
                        .controlSize(.small)
                    }
                    .padding(.top, 2)
                }
            }
        }
    }

    // MARK: Footer

    private var footer: some View {
        VStack(alignment: .leading, spacing: 9) {
            // A hairline closes the stack of cards: the footer is a different kind of
            // action (restore / leave) and should not read as one more section.
            Divider()
                .opacity(0.6)
            HStack(alignment: .center, spacing: 8) {
                Button {
                    preferences.resetToDefaults()
                    DynaHaptics.tap(.levelChange)
                } label: {
                    Label("Reset", systemImage: "arrow.counterclockwise")
                        .font(.system(size: 10.5))
                }
                .buttonStyle(.plain)
                .foregroundColor(.secondary)
                .frame(height: 20)
                .help("Restore the default subtitle, palette and slideshow")

                Spacer(minLength: 0)

                // Pause/Resume lives in the preview card's pill; a second button here
                // was the same action twice in one panel.
                Button("Quit") {
                    NSApp.terminate(nil)
                }
                .controlSize(.small)
                // Both ends of the row sit on the same 20 pt line, so Reset's text and
                // Quit's plate share one centre even though their styles differ.
                .frame(height: 20)
            }
        }
    }

    /// `1m · 5m · 15m · 30m · 1h` for the compact interval picker.
    private func intervalLabel(_ minutes: Int) -> String {
        switch minutes {
        case 1: return "1m"
        case 5: return "5m"
        case 15: return "15m"
        case 30: return "30m"
        case 60: return "1h"
        default: return minutes < 60 ? "\(minutes)m" : "\(minutes / 60)h"
        }
    }

    /// Whole minutes, plus whatever value is stored (in case `defaults write` set one).
    private var intervalChoices: [Int] {
        var values = [1, 5, 15, 30, 60]
        let current = preferences.slideshowIntervalMinutes
        if !values.contains(current) {
            values.append(current)
            values.sort()
        }
        return values
    }

    /// Choose the folder the wallpaper rotates through.
    ///
    /// The picker is a modal panel, so the settings panel gets out of its way: it is
    /// closed before the dialog opens, then re-presented under the menu bar icon once
    /// the user picks a folder or dismisses the dialog. The panel comes back exactly
    /// where it was, already showing the folder that was just chosen.
    private func choosePhotoFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        panel.prompt = "Use Folder"
        panel.message = "Pick a folder of images to rotate as your wallpaper."
        let path = preferences.effectivePhotoFolderPath
        if !path.isEmpty {
            panel.directoryURL = URL(fileURLWithPath: path, isDirectory: true)
        }

        // Step aside for the dialog instead of hovering behind it. AppKit would dismiss
        // a `.transient` popover anyway once the panel takes the key window, so the
        // dismissal is made explicit here and the reopening is owned by this method.
        popover?.close()

        NSApp.activate(ignoringOtherApps: true)
        let response = panel.runModal()

        // The dialog is gone — cancelled or answered: the panel returns to the icon
        // right away, and once more on the next run loop turn, after AppKit has
        // finished tearing the modal down.
        onReopenPopover?()
        DispatchQueue.main.async {
            onReopenPopover?()
        }

        guard response == .OK, let url = panel.url else { return }
        preferences.photoFolderPath =
            url.path == WallpaperPreferences.standardPhotoFolderPath ? "" : url.path
    }

    /// Select a family, dropping an imported file when the user moves to a font that
    /// does not come from it — otherwise the page would keep loading those bytes over
    /// the newly chosen installed face.
    private func selectFontFamily(_ family: String) {
        let normalized = WallpaperFont.normalizedFamily(family)
        if preferences.fontFamily != normalized {
            preferences.fontFamily = normalized
        }
        if !preferences.customFontPath.isEmpty {
            let imported = WallpaperFont.familyName(
                of: URL(fileURLWithPath: preferences.customFontPath),
                fallback: (preferences.customFontPath as NSString).lastPathComponent
            )
            if imported.caseInsensitiveCompare(normalized) != .orderedSame {
                preferences.customFontPath = ""
            }
        }
    }
}

// MARK: - App delegate

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let controller = DesktopWindowController()
    private var statusItem: NSStatusItem?
    private var popover: NSPopover?
    private var cancellables = Set<AnyCancellable>()
    private var screenObserver: NSObjectProtocol?
    private var wakeObserver: NSObjectProtocol?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory) // menu bar utility, no Dock icon
        // The popover's preview card is set in the same Outfit face as the page.
        WallpaperFont.register()
        configureStatusItem()
        controller.start()
        observeSystemEvents()
        dynaLog("launched with \(NSScreen.screens.count) display(s)")
    }

    func applicationWillTerminate(_ notification: Notification) {
        controller.stop()
        if let screenObserver {
            NotificationCenter.default.removeObserver(screenObserver)
        }
        if let wakeObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(wakeObserver)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false // the desktop windows are always open
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
        true
    }

    // MARK: Menu bar item

    private func configureStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)

        if let button = item.button {
            button.image = Self.makeMenuBarIcon()
            button.imagePosition = .imageOnly
            button.toolTip = "DynaWall — click to customize, right-click for quick actions"
            button.target = self
            button.action = #selector(togglePopover(_:))
            // AppKit only sends the action for the primary button by default, so a
            // right-click would be swallowed by the status item.
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }

        statusItem = item

        controller.$isPaused
            .receive(on: RunLoop.main)
            .sink { [weak self] paused in
                self?.statusItem?.button?.appearsDisabled = paused
            }
            .store(in: &cancellables)
    }

    /// The right-click menu: the actions people reach for between settings visits.
    ///
    /// Built once and reused for the life of the app. `menuNeedsUpdate(_:)` rewrites
    /// the title and the tick marks from the live model every time the menu opens, so
    /// the menu can never describe a state the wallpaper is not actually in — the old
    /// approach of rebuilding the menu per click allocated a dozen items on every
    /// right-click.
    private lazy var quickMenu: NSMenu = {
        let menu = NSMenu()
        menu.delegate = self
        // Nothing is auto-enabled: Next Photo has to stay greyed out unless there is
        // a running slideshow with a photo in it.
        menu.autoenablesItems = false

        menu.addItem(quickMenuItem(
            title: "Next Photo",
            action: #selector(nextPhotoFromMenu(_:)),
            key: "n"
        ))
        menu.addItem(quickMenuItem(
            title: "Pause Wallpaper",
            action: #selector(togglePauseFromMenu(_:)),
            key: "p"
        ))
        menu.addItem(quickMenuItem(
            title: "Open Wallpapers in Finder",
            action: #selector(revealWallpapersInFinder(_:)),
            key: "o"
        ))
        menu.addItem(.separator())
        menu.addItem(quickMenuItem(
            title: "Settings…",
            action: #selector(openSettingsFromMenu(_:)),
            key: ","
        ))
        menu.addItem(quickMenuItem(
            title: "Launch at Login",
            action: #selector(toggleLaunchAtLoginFromMenu(_:)),
            key: ""
        ))
        menu.addItem(.separator())
        menu.addItem(quickMenuItem(
            title: "Quit DynaWall",
            action: #selector(quitFromMenu(_:)),
            key: "q"
        ))
        return menu
    }()

    /// One item wired to `self`, tagged so `menuNeedsUpdate(_:)` can find it again.
    private func quickMenuItem(title: String, action: Selector, key: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        item.tag = Self.MenuTag.tag(for: action)
        return item
    }

    /// Stable tags for the items whose state changes while the app runs.
    private enum MenuTag {
        static let nextPhoto = 1
        static let pause = 2
        static let reveal = 3
        static let launchAtLogin = 4

        static func tag(for action: Selector) -> Int {
            switch action {
            case #selector(AppDelegate.nextPhotoFromMenu(_:)): return nextPhoto
            case #selector(AppDelegate.togglePauseFromMenu(_:)): return pause
            case #selector(AppDelegate.revealWallpapersInFinder(_:)): return reveal
            case #selector(AppDelegate.toggleLaunchAtLoginFromMenu(_:)): return launchAtLogin
            default: return 0
            }
        }
    }

    /// Pop the quick-action menu under the menu bar icon.
    ///
    /// `NSStatusItem` shows a menu only while `menu` is assigned, so it is attached
    /// for the duration of one tracking loop and detached on the way out: leaving it
    /// installed would silently steal every left-click from the popover.
    private func presentQuickMenu(from button: NSStatusBarButton) {
        if popover?.isShown == true {
            popover?.performClose(nil)
        }
        // The tick mark comes from `SMAppService`, not from a cached copy: the user
        // may have revoked login items in System Settings since launch.
        controller.preferences.syncLaunchAtLogin()
        statusItem?.menu = quickMenu
        button.performClick(nil)
        statusItem?.menu = nil
    }

    // MARK: Quick actions

    @objc private func nextPhotoFromMenu(_ sender: Any?) {
        guard controller.preferences.slideshow else { return }
        controller.nextPhoto()
    }

    @objc private func togglePauseFromMenu(_ sender: Any?) {
        controller.togglePause()
    }

    @objc private func revealWallpapersInFinder(_ sender: Any?) {
        controller.preferences.revealPhotoFolderInFinder()
        DynaHaptics.tap(.alignment)
    }

    @objc private func openSettingsFromMenu(_ sender: Any?) {
        // "Settings…" always opens; `togglePopover` would close a panel that is
        // already up, which is the opposite of what the menu promised.
        guard popover?.isShown != true else { return }
        togglePopover(nil)
    }

    @objc private func toggleLaunchAtLoginFromMenu(_ sender: Any?) {
        controller.preferences.launchAtLogin.toggle()
        // `SMAppService` is the source of truth: it can refuse (or defer to the user
        // approving the item), and the tick mark must show what actually happened.
        controller.preferences.syncLaunchAtLogin()
        DynaHaptics.tap(.levelChange)
    }

    @objc private func quitFromMenu(_ sender: Any?) {
        NSApp.terminate(nil)
    }

    /// The menu bar mark: the app icon's Bauhaus silhouette, drawn at 18×18.
    ///
    /// One solid bone dome sitting flush on a razor horizon, with the lower half left
    /// empty — the same two shapes as the app icon, so the status item and the bundle
    /// are unmistakably the same mark. Drawn as a template image, so macOS tints it
    /// for the light and dark menu bar and dims it for free while the wallpaper is
    /// paused (`button.appearsDisabled`).
    static func makeMenuBarIcon() -> NSImage {
        let size = NSSize(width: 18, height: 18)
        let image = NSImage(size: size, flipped: false) { _ in
            // Optical centre: the dome reads heavier than the empty half below, so the
            // horizon sits a touch above the geometric middle of the canvas.
            let center = NSPoint(x: size.width / 2, y: 9.2)
            let orbRadius: CGFloat = 5.6
            // Wider than the dome, exactly as in the app icon: the line has to read as
            // a horizon the sun is rising out of, not as an underline.
            let horizonWidth: CGFloat = 15.4
            let horizonThickness: CGFloat = 1.2

            NSColor.black.setFill()
            NSColor.black.setStroke()

            // Solar hemisphere — a solid dome rising out of the horizon.
            let dome = NSBezierPath()
            dome.appendArc(withCenter: center, radius: orbRadius, startAngle: 0, endAngle: 180, clockwise: false)
            dome.close()
            dome.fill()

            // Razor horizon: square-ended and flush with the dome's base, so the two
            // shapes read as one silhouette — the app icon at menu bar scale.
            NSBezierPath(rect: NSRect(
                x: center.x - horizonWidth / 2,
                y: center.y - horizonThickness,
                width: horizonWidth,
                height: horizonThickness
            )).fill()

            return true
        }
        image.isTemplate = true
        return image
    }

    // MARK: Popover

    /// Built on the first click, not at launch.
    ///
    /// An `NSHostingController` pulls in SwiftUI's AttributeGraph, its environment
    /// machinery and the whole settings view tree — real memory for a panel most
    /// launches never open. The menu bar icon only pays for it once somebody asks.
    private func makePopover() -> NSPopover {
        let popover = NSPopover()
        popover.behavior = .transient
        popover.animates = true
        // The panel's height follows the SwiftUI content, so the slideshow controls
        // can appear and disappear without leaving a tall empty frame behind.
        let root = SettingsPopoverView(
            preferences: controller.preferences,
            controller: controller,
            popover: popover,
            onReopenPopover: { [weak self] in self?.presentPopover() },
            onContentHeightChange: { [weak popover] height in
                guard let popover, height > 0 else { return }
                let target = NSSize(width: SettingsPopoverView.popoverWidth, height: ceil(height))
                guard abs(popover.contentSize.height - target.height) > 0.5 else { return }
                // Resizing a visible panel from inside a SwiftUI layout pass can re-enter
                // that pass, so the new size is applied on the next run loop turn.
                DispatchQueue.main.async {
                    popover.contentSize = target
                }
            }
        )
        let hosting = NSHostingController(rootView: root)
        popover.contentViewController = hosting
        // The first measurement arrives from SwiftUI; this is only the size the
        // panel opens with, so it never flashes at a stale height.
        hosting.view.layoutSubtreeIfNeeded()
        let fitting = hosting.view.fittingSize
        popover.contentSize = NSSize(
            width: SettingsPopoverView.popoverWidth,
            height: fitting.height > 0 ? fitting.height : 460
        )
        return popover
    }

    /// Put the settings panel on screen, anchored under the menu bar icon.
    ///
    /// Used by the icon itself and by the folder picker: the panel closes for the
    /// modal dialog and is shown again from the same anchor once it goes away. When
    /// the panel is already up this only re-keys it, which makes it safe to call
    /// twice in a row.
    private func presentPopover() {
        guard let button = statusItem?.button else { return }
        if popover == nil {
            popover = makePopover()
        }
        guard let popover else { return }

        NSApp.activate(ignoringOtherApps: true)
        if !popover.isShown {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        }
        popover.contentViewController?.view.window?.makeKey()
    }

    @objc private func togglePopover(_ sender: Any?) {
        guard let button = statusItem?.button else { return }

        // Control-click reads as a secondary click on every Mac, trackpad or mouse.
        let event = NSApp.currentEvent
        let secondary = event?.type == .rightMouseUp
            || event?.modifierFlags.contains(.control) == true
        if secondary {
            presentQuickMenu(from: button)
            return
        }

        if popover == nil {
            popover = makePopover()
        }
        guard let popover else { return }

        if popover.isShown {
            popover.performClose(sender)
            return
        }

        presentPopover()
    }

    // MARK: System events

    private func observeSystemEvents() {
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            // The observer block is `@Sendable`, so the hop onto the main actor is
            // spelled out: `controller` is main-actor isolated state.
            Task { @MainActor in self?.controller.rebuildIfNeeded() }
        }

        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            dynaLog("system woke from sleep — resyncing greeting and photos")
            Task { @MainActor in self?.controller.resync() }
        }
    }
}

// MARK: - Quick menu state

extension AppDelegate: NSMenuDelegate {
    /// Refresh the menu from the live model right before it is displayed.
    ///
    /// This is the only place the items' titles, tick marks and enabled state are
    /// written, which is what keeps a menu that is never rebuilt from going stale.
    func menuNeedsUpdate(_ menu: NSMenu) {
        guard menu === quickMenu else { return }
        let preferences = controller.preferences

        // A skip needs a photo to skip to *and* a rotation to restart: with the
        // slideshow off the page would ignore the action.
        menu.item(withTag: MenuTag.nextPhoto)?.isEnabled =
            preferences.slideshow && controller.photoCount > 0
        menu.item(withTag: MenuTag.pause)?.title =
            controller.isPaused ? "Resume Wallpaper" : "Pause Wallpaper"
        menu.item(withTag: MenuTag.reveal)?.isEnabled =
            !preferences.effectivePhotoFolderPath.isEmpty
        menu.item(withTag: MenuTag.launchAtLogin)?.state =
            preferences.launchAtLogin ? .on : .off
    }
}

// MARK: - Entry point

@main
enum DynaWallLauncher {
    /// `NSApplication.delegate` does not retain its delegate.
    private static var delegate: AppDelegate?

    static func main() {
        let app = NSApplication.shared
        let appDelegate = AppDelegate()
        delegate = appDelegate
        app.delegate = appDelegate
        app.setActivationPolicy(.accessory)
        app.run()
    }
}

