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
/// WebKit loads the vendored `outfit-latin.woff2` through `@font-face`; AppKit has
/// no equivalent CSS bridge. `outfit-regular.ttf` and `outfit-semibold.ttf` are
/// static instances generated from that exact variable face — same glyphs, same
/// outlines — and are registered with CoreText for the popover. Without them the
/// preview would be set in SF Rounded while the desktop is set in Outfit, which
/// is precisely the mismatch the preview exists to avoid.
enum WallpaperFont {
    private static let regularName = "Outfit-Regular"
    private static let semiboldName = "Outfit-SemiBold"

    private static let registration: Bool = {
        var registered = false
        for name in ["outfit-regular", "outfit-semibold"] {
            guard let url = bundledURL(named: name) else {
                dynaLog("preview font missing from bundle: \(name).ttf")
                continue
            }
            var error: Unmanaged<CFError>?
            if CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) {
                registered = true
            } else if let error {
                let description = String(describing: error.takeRetainedValue())
                // A user-installed Outfit or a second registration is harmless:
                // `Font.custom` will resolve the same face by name either way.
                if description.localizedCaseInsensitiveContains("already") {
                    registered = true
                } else {
                    dynaLog("preview font \(name) failed to register: \(description)")
                }
            }
        }
        return registered
    }()

    /// Register once, at launch, before the popover is built.
    static func register() {
        _ = registration
    }

    /// Wallpaper greeting face: Outfit at 600, exactly like `.greeting`.
    ///
    /// Avenir Next (a geometric sans that ships with macOS) is the fallback if the
    /// bundled faces cannot be registered, so a damaged bundle still gets a closer
    /// match than the default system face.
    static func semibold(size: CGFloat) -> Font {
        registration
            ? .custom(semiboldName, size: size)
            : .custom("AvenirNext-DemiBold", size: size)
    }

    /// Wallpaper subtitle face: Outfit at 400, exactly like `.subtitle`.
    static func regular(size: CGFloat) -> Font {
        registration
            ? .custom(regularName, size: size)
            : .custom("AvenirNext-Regular", size: size)
    }

    /// CSS `letter-spacing` is in `em`; SwiftUI's `.tracking` is in points.
    static func tracking(size: CGFloat, em: CGFloat) -> CGFloat {
        size * em
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
    private var collectionName = PhotoCollection.goldenGate.label

    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return files.count
    }

    /// Human readable description used by the diagnostics log.
    var summary: String {
        lock.lock()
        defer { lock.unlock() }
        return "\(collectionName): \(files.count) photo(s) from \(folder.isEmpty ? "<none>" : folder)"
    }

    /// The folder bundled with the app, used when no custom folder is configured.
    static func bundledFolder() -> String {
        Bundle.main.resourceURL?.appendingPathComponent("images").path ?? ""
    }

    /// Re-scan for a collection.
    ///
    /// A bundled collection is a fixed list of six curated files, so the 4K, 5K and
    /// HEIC duplicates sitting in the same folder never reach the slideshow. A
    /// custom collection scans the folder the user picked (and falls back to the
    /// bundled folder while no folder has been chosen yet).
    ///
    /// The curated list is resolved *first*: a bundled collection that is present
    /// returns before `scan()` ever runs, so opening the app never pays for a
    /// `contentsOfDirectory` sweep, an extension filter and a localized sort of a
    /// folder whose result it would throw away.
    func reload(collection: PhotoCollection, folderPath: String) {
        let trimmed = folderPath.trimmingCharacters(in: .whitespacesAndNewlines)
        let base = Self.bundledFolder()
        let curated = collection.bundledFiles

        if !curated.isEmpty {
            let picked = curated.compactMap { name -> URL? in
                let url = URL(fileURLWithPath: base).appendingPathComponent(name)
                return FileManager.default.fileExists(atPath: url.path) ? url : nil
            }
            if !picked.isEmpty {
                lock.lock()
                files = picked
                folder = base
                collectionName = collection.label
                lock.unlock()
                return
            }
        }

        let resolved = trimmed.isEmpty ? base : trimmed
        let scanned = Self.scan(resolved)

        lock.lock()
        files = scanned
        folder = resolved
        collectionName = collection.label
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
    private static func photoIndex(from url: URL) -> Int? {
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

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard let payload = message.body as? [String: Any] else { return }
        let source = payload["src"] as? String ?? "<unknown>"
        let width = payload["width"] as? Int ?? 0
        let height = payload["height"] as? Int ?? 0
        dynaLog("slideshow advanced: \(source) (\(width)x\(height))")
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
        static let launchAtLogin = "launchAtLogin"
    }

    static let defaultSubtitle = "What are we building today?"

    /// The greeting name is always read dynamically from the logged-in macOS account.
    var firstName: String {
        Self.detectedFirstName()
    }

    @Published var subtitleText: String {
        didSet { persist(subtitleText, Key.subtitle) }
    }

    @Published var themePreset: ThemePreset {
        didSet { persist(themePreset.rawValue, Key.themePreset) }
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

    /// Empty string means "use the photos bundled with the app".
    @Published var photoFolderPath: String {
        didSet { persist(photoFolderPath, Key.photoFolder) }
    }

    /// Which bundled set (or the custom folder) the slideshow rotates through.
    @Published var photoCollection: PhotoCollection {
        didSet { persist(photoCollection.rawValue, Key.photoCollection) }
    }

    /// Keep the wallpaper's photo in step with the clock's palette band.
    @Published var photoSync: Bool {
        didSet { persist(photoSync, Key.photoSync) }
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

    /// Effective background colour for the windows and the backing layer: a pinned
    /// preset keeps its own colour, `auto` resolves against the clock so the native
    /// layer matches the band the page is about to paint.
    var bgColor: String {
        switch themePreset {
        case .custom: return customColorHex
        case .auto: return ThemeSlot.current().hex
        default: return themePreset.hex ?? themePreset.slot?.hex ?? ThemeSlot.day.hex
        }
    }

    /// Palette mode handed to the page (`auto` = follow the clock).
    var themeMode: String { themePreset.themeMode }

    /// A pinned colour (`custom`, GitHub Dark, Deep Slate) is sent as `bgColor`;
    /// `auto` and the four bands leave every token to `style.css`, which is what
    /// keeps the clock in charge.
    var usesPinnedColor: Bool {
        switch themePreset {
        case .githubDark, .deepSlate, .custom: return true
        case .auto, .dawn, .day, .dusk, .night: return false
        }
    }

    /// Only a pinned colour sends `bgColor`.
    private var bgColorUpdate: String {
        guard usesPinnedColor else { return "" }
        return "window.livelyPropertyListener(\"bgColor\", \(Self.jsLiteral(bgColor)));"
    }

    /// "Golden Gate", "Abstract", or the folder name the user picked.
    var photoFolderLabel: String {
        if photoCollection != .custom { return photoCollection.label }
        let path = photoFolderPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !path.isEmpty else { return "No folder chosen yet" }
        let name = (path as NSString).lastPathComponent
        return name.isEmpty ? path : name
    }

    /// One line under the collection picker: what will rotate, and whether it
    /// follows the clock.
    ///
    /// The band mirrors `resolvePhotoBand()` in `script.js`: a pinned palette
    /// keeps its own band, everything else (auto, custom colour) follows the clock.
    var photoCollectionHint: String {
        let summary = photoCollection.summary
        guard photoSync else { return summary + " · all photos, any time of day" }
        let band = (themePreset.slot ?? ThemeSlot.current()).label.lowercased()
        return summary + " · " + band + " photos right now"
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

    /// Choose a collection and start the slideshow when it was off.
    ///
    /// Picking a photo set (or clicking "Next photo") is a request to see photos;
    /// leaving the master switch off turned that click into nothing.
    func selectCollection(_ collection: PhotoCollection) {
        if photoCollection != collection {
            photoCollection = collection
        }
        if !slideshow {
            slideshow = true
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
        if photoFolderPath != url.path {
            photoFolderPath = url.path
        }
        if !slideshow {
            slideshow = true
        }
        return true
    }

    /// Restore the shipped look in one click.
    ///
    /// `photoFolderPath` is deliberately left alone: resetting the palette and the
    /// slideshow should not forget the folder a user picked, and `.goldenGate`
    /// never reads it.
    func resetToDefaults() {
        subtitleText = Self.defaultSubtitle
        themePreset = .auto
        customColorHex = HexColor.fallback
        slideshow = false
        slideshowIntervalMinutes = 15
        slideshowShuffle = true
        kenBurns = true
        photoCollection = .goldenGate
        photoSync = true
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
            Key.photoCollection: PhotoCollection.goldenGate.rawValue,
            Key.photoSync: true,
            Key.launchAtLogin: false
        ])

        subtitleText = defaults.string(forKey: Key.subtitle) ?? Self.defaultSubtitle
        themePreset = ThemePreset(rawValue: defaults.string(forKey: Key.themePreset) ?? "") ?? .auto
        customColorHex = defaults.string(forKey: Key.customColor) ?? HexColor.fallback
        slideshow = defaults.bool(forKey: Key.slideshow)
        let interval = defaults.integer(forKey: Key.slideshowInterval)
        slideshowIntervalMinutes = interval > 0 ? interval : 15
        slideshowShuffle = defaults.bool(forKey: Key.slideshowShuffle)
        kenBurns = defaults.bool(forKey: Key.kenBurns)
        photoFolderPath = defaults.string(forKey: Key.photoFolder) ?? ""
        photoCollection =
            PhotoCollection(rawValue: defaults.string(forKey: Key.photoCollection) ?? "")
            ?? .goldenGate
        photoSync = defaults.bool(forKey: Key.photoSync)
        launchAtLogin = LaunchAtLogin.isEnabled
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
        if usesPinnedColor {
            fields.append("\"bgColor\": \(Self.jsLiteral(bgColor))")
        }
        fields.append("\"slideshow\": \(slideshow ? "true" : "false")")
        fields.append("\"photoSync\": \(photoSync ? "true" : "false")")
        fields.append("\"slideshowInterval\": \(slideshowIntervalMinutes)")
        fields.append("\"slideshowShuffle\": \(slideshowShuffle ? "true" : "false")")
        fields.append("\"kenBurns\": \(kenBurns ? "true" : "false")")
        if !photoURLs.isEmpty {
            fields.append("\"photos\": \(Self.jsArrayLiteral(photoURLs))")
        }
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

    /// How many photos the active collection resolved to, for the folder row.
    @Published private(set) var photoCount = 0

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
    /// Photos served to the page: a bundled collection by default, any folder on request.
    private let photoLibrary = PhotoLibrary()
    /// Collection + folder the current photo list was scanned from (`nil` = never loaded).
    private var loadedPhotoSource: String?

    /// Shared by every display: one in-memory data store, one scheme handler and one
    /// message logger. A second monitor reuses them instead of standing up a parallel
    /// WebKit world (and a duplicate IPC handler). The process pool is shared by
    /// WebKit itself on macOS 12 (a per-app pool is the only one that exists there),
    /// so there is nothing left to multiply per screen.
    private let dataStore = WKWebsiteDataStore.nonPersistent()
    private let photoLogger = PhotoEventLogger()
    private lazy var photoSchemeHandler = PhotoSchemeHandler(library: photoLibrary)

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
        preferences.onChange = { [weak self] _ in
            guard let self else { return }
            self.schedulePush()
            // No slideshow, no photo on screen: the preview card must not name one.
            if !self.preferences.slideshow {
                self.currentPhotoName = ""
            }
            // Only a palette switch needs a new clock timer; typing must not re-arm it.
            if self.preferences.themePreset != self.scheduledPreset {
                self.scheduleThemeTimer()
            }
        }
    }

    // MARK: Lifecycle

    func start() {
        observeSystemEvents()
        // The seed is built before the first window exists, so the photo list has to
        // be resolved first; a bundled collection resolves without a folder scan.
        reloadPhotosIfNeeded()
        rebuild()
        startThemeClock()
    }

    /// Stop everything: timer, observers and web views. Called on termination.
    func stop() {
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

        let color = HexColor.nsColor(slot.hex)
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
            controller.removeAllUserScripts()
            entry.webView.stopLoading()
            entry.webView.navigationDelegate = nil
            entry.window.orderOut(nil)
            entry.window.contentView = nil
        }
        windows.removeAll()
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
            applySuspension(to: entry)
        }
    }

    /// Re-scan whenever the user points the slideshow at another collection or folder.
    private func reloadPhotosIfNeeded(force: Bool = false) {
        let collection = preferences.photoCollection
        let path = preferences.photoFolderPath
        let source = "\(collection.rawValue):\(path)"
        guard force || source != loadedPhotoSource else { return }
        loadedPhotoSource = source
        photoLibrary.reload(collection: collection, folderPath: path)
        photoCount = photoLibrary.count
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
        dynaLog(ready == 0 ? "next photo skipped (no page ready)" : "next photo requested")
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
          return {
            greeting: greeting ? greeting.textContent.trim() : "",
            subtitle: subtitle ? subtitle.textContent.trim() : "",
            subtitleHidden: subtitle ? getComputedStyle(subtitle).display === "none" : null,
            background: getComputedStyle(document.body).backgroundColor,
            theme: document.documentElement.getAttribute("data-theme") || "",
            fontFamily: greeting ? getComputedStyle(greeting).fontFamily.split(",")[0].replace(/["']/g, "").trim() : "",
            fontSize: greeting ? getComputedStyle(greeting).fontSize : "",
            fontLoaded: document.fonts ? document.fonts.check("16px Outfit") : null,
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
                dynaLog("font: \(state["fontFamily"] as? String ?? "<unknown>") @ \(state["fontSize"] as? String ?? "?") Outfit=\(Self.describe(state["fontLoaded"]))")
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

/// A bezel-less `NSColorWell` that fills its whole parent.
///
/// `ColorPicker` keeps its own 44×22 control centred inside whatever frame it is
/// given, which drew a second pill bezel inside the rounded swatch and left the
/// swatch's edges dead. This well stretches to the swatch instead; the popover
/// draws it at 1.5 % opacity so only the click target (not the control chrome) is
/// visible, and every point on the swatch opens the system colour panel.
private struct SwatchColorWell: NSViewRepresentable {
    @Binding var color: Color

    func makeNSView(context: Context) -> NSColorWell {
        let well = NSColorWell()
        well.isBordered = false
        well.target = context.coordinator
        well.action = #selector(Coordinator.colorChanged(_:))
        well.color = NSColor(color)
        return well
    }

    func updateNSView(_ well: NSColorWell, context: Context) {
        context.coordinator.color = $color
        let next = NSColor(color)
        // The live panel owns the colour while it is open; mirroring it back would
        // fight the user's drag.
        if !well.isActive, well.color != next {
            well.color = next
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(color: $color)
    }

    final class Coordinator: NSObject {
        var color: Binding<Color>

        init(color: Binding<Color>) {
            self.color = color
        }

        @objc func colorChanged(_ sender: NSColorWell) {
            color.wrappedValue = Color(nsColor: sender.color)
        }
    }
}

struct SettingsPopoverView: View {
    /// Fixed design width; the height is measured from the content.
    static let popoverWidth: CGFloat = 340

    @ObservedObject var preferences: WallpaperPreferences
    @ObservedObject var controller: DesktopWindowController
    /// Called with the ideal content height whenever the layout changes.
    var onContentHeightChange: ((CGFloat) -> Void)?

    /// A folder is hovering over the custom-folder row.
    @StateObject private var dropTarget = FolderDropTarget()

    private var customColorBinding: Binding<Color> {
        Binding(
            get: { HexColor.color(preferences.customColorHex) },
            // Picking a colour pins the custom palette, so the well is never a
            // control that appears to do nothing.
            set: { preferences.selectCustomColor(HexColor.hex($0)) }
        )
    }

    private var collectionBinding: Binding<PhotoCollection> {
        Binding(
            get: { preferences.photoCollection },
            // Choosing a collection starts the slideshow instead of saving an
            // invisible preference behind a switch that is off.
            set: { preferences.selectCollection($0) }
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            previewCard
            greetingCard
            paletteCard
            photosCard
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
        .onChange(of: preferences.photoCollection) { collection in
            // "Custom folder…" is a request for a folder: ask for one straight away
            // instead of leaving the wallpaper pointing at the bundled set.
            if collection == .custom && preferences.photoFolderPath.isEmpty {
                choosePhotoFolder()
            }
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
                        .font(WallpaperFont.semibold(size: 19))
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
                            .font(WallpaperFont.regular(size: 11))
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
            TextField("What are we building today? (empty hides)", text: $preferences.subtitleText)
                .textFieldStyle(.roundedBorder)
                // The clear button lives *inside* the field's trailing edge, so the
                // subtitle keeps its full width and does not jump when the button
                // appears or disappears.
                .overlay(alignment: .trailing) {
                    if !preferences.subtitleText.isEmpty {
                        Button {
                            preferences.subtitleText = ""
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 12))
                                .foregroundColor(.secondary)
                        }
                        .buttonStyle(.plain)
                        .padding(.trailing, 5)
                        .help("Hide the subtitle")
                        .accessibilityLabel("Clear subtitle")
                    }
                }
        }
    }

    // MARK: Section chrome

    /// One labelled section: an icon + title, then the controls, on a soft card.
    private func card<Content: View>(
        systemImage: String,
        title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 5) {
                Image(systemName: systemImage)
                    .font(.system(size: 9.5, weight: .semibold))
                    .foregroundColor(.secondary)
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
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.primary.opacity(0.055))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.08), lineWidth: 1)
        )
    }

    // MARK: Palette

    private var paletteCard: some View {
        card(systemImage: "paintpalette", title: "Palette") {
            VStack(alignment: .leading, spacing: 9) {
                autoPill
                swatches
                Text(paletteHint)
                    .font(.system(size: 9.5))
                    .foregroundColor(.secondary)
                    .lineLimit(1)
            }
        }
    }

    /// Hands the palette back to the clock in one click, with the band it is on.
    private var autoPill: some View {
        Button {
            preferences.themePreset = .auto
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "clock.fill")
                    .font(.system(size: 10, weight: .semibold))
                Text("Auto (follow the clock)")
                    .font(.system(size: 11, weight: .medium))
                Spacer(minLength: 0)
                Text("\(ThemeSlot.current().label) · \(ThemeSlot.current().hoursLabel)")
                    .font(.system(size: 9.5))
                    .foregroundColor(.secondary)
                Image(systemName: preferences.themePreset == .auto ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 11))
                    .foregroundColor(preferences.themePreset == .auto ? .accentColor : .secondary)
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(preferences.themePreset == .auto
                          ? Color.accentColor.opacity(0.16)
                          : Color.primary.opacity(0.05))
            )
        }
        .buttonStyle(.plain)
        .help("Follow the clock: dawn, day, dusk and night")
    }

    /// The four clock bands on top, the three fixed colours below.
    ///
    /// `.custom` is already one of `ThemePreset.allCases`; enumerating every case
    /// and then appending the colour well rendered a second "Custom" swatch. Split
    /// by kind so each preset appears exactly once.
    private static let bandPresets: [ThemePreset] = [.dawn, .day, .dusk, .night]
    private static let fixedPresets: [ThemePreset] = [.githubDark, .deepSlate]

    private var swatches: some View {
        VStack(spacing: 8) {
            LazyVGrid(
                columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: Self.bandPresets.count),
                spacing: 8
            ) {
                ForEach(Self.bandPresets) { preset in
                    swatch(preset)
                }
            }
            LazyVGrid(
                columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: Self.fixedPresets.count + 1),
                spacing: 8
            ) {
                ForEach(Self.fixedPresets) { preset in
                    swatch(preset)
                }
                customSwatch
            }
        }
    }

    private func swatch(_ preset: ThemePreset) -> some View {
        let selected = preferences.themePreset == preset
        return Button {
            preferences.themePreset = preset
        } label: {
            VStack(spacing: 3) {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(HexColor.color(preset.swatchHex ?? preferences.customColorHex))
                    .frame(height: 24)
                    .overlay(swatchGlow(preset))
                    .overlay(swatchSymbol(preset, selected: selected))
                    .overlay(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .strokeBorder(selected ? Color.accentColor : Color.primary.opacity(0.14),
                                          lineWidth: selected ? 2 : 1)
                    )
                Text(preset.shortLabel)
                    .font(.system(size: 9))
                    .foregroundColor(selected ? .primary : .secondary)
                    .lineLimit(1)
            }
        }
        .buttonStyle(.plain)
        .help(preset.label)
    }

    /// The band's own light, so six near-black presets read as six different moods.
    ///
    /// `ThemeSlot.accentHex` is the RGB of the wallpaper's `--bg-radial-accent`; the
    /// swatch has to glow with the same light or the palette grid is a row of black
    /// bricks. The fixed colours have no band accent, so they get a neutral sheen.
    private func swatchGlow(_ preset: ThemePreset) -> some View {
        let accent = preset.slot.map { HexColor.color($0.accentHex) } ?? Color.white
        let isBand = preset.slot != nil
        return RadialGradient(
            colors: [accent.opacity(isBand ? 0.55 : 0.16), .clear],
            center: isBand ? UnitPoint(x: 0.5, y: 0.35) : .topLeading,
            startRadius: 0,
            endRadius: isBand ? 30 : 26
        )
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }

    /// A tiny band mark, swapped for the tick when this preset is active.
    @ViewBuilder
    private func swatchSymbol(_ preset: ThemePreset, selected: Bool) -> some View {
        if selected {
            Image(systemName: "checkmark")
                .font(.system(size: 9, weight: .bold))
                .foregroundColor(.white)
                .shadow(color: Color.black.opacity(0.6), radius: 2)
        } else if let slot = preset.slot {
            Image(systemName: slot.symbolName)
                .font(.system(size: 9, weight: .semibold))
                .foregroundColor(.white.opacity(0.72))
                .shadow(color: Color.black.opacity(0.45), radius: 1)
        }
    }

    /// The live colour well inside the Custom swatch.
    ///
    /// It is never disabled: a click opens the system panel and
    /// `selectCustomColor(_:)` pins that palette, which is the documented behaviour.
    private var customSwatch: some View {
        let selected = preferences.themePreset == .custom
        return VStack(spacing: 3) {
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(HexColor.color(preferences.customColorHex))
                .frame(height: 24)
                .overlay(
                    RadialGradient(
                        colors: [Color.white.opacity(0.16), .clear],
                        center: .topLeading,
                        startRadius: 0,
                        endRadius: 26
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                )
                .overlay(
                    Image(systemName: selected ? "checkmark" : "paintpalette.fill")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundColor(.white.opacity(0.85))
                        .shadow(color: Color.black.opacity(0.6), radius: 2)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .strokeBorder(selected ? Color.accentColor : Color.primary.opacity(0.14),
                                      lineWidth: selected ? 2 : 1)
                )
                // A bezel-less well stretched over the whole swatch: a click anywhere
                // opens the system panel, and the near-zero opacity keeps the well's
                // own control chrome from drawing a mismatched pill inside the square.
                .overlay(
                    SwatchColorWell(color: customColorBinding)
                        .opacity(0.015)
                )
                .contentShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            Text("Custom")
                .font(.system(size: 9))
                .foregroundColor(selected ? .primary : .secondary)
        }
        .help("Pick any background colour — the palette switches to it immediately")
    }

    /// One line of context for the palette picker: what the clock is doing, or why
    /// the wallpaper is ignoring it.
    private var paletteHint: String {
        switch preferences.themePreset {
        case .auto:
            return "Following the clock — \(ThemeSlot.current().label.lowercased()) right now"
        case .dawn, .day, .dusk, .night:
            return "\(preferences.themePreset.shortLabel) pinned; Auto hands it back to the clock"
        case .githubDark, .deepSlate:
            return "\(preferences.themePreset.shortLabel) · fixed colour, neutral palette"
        case .custom:
            return "Custom colour \(preferences.customColorHex) · fixed, neutral palette"
        }
    }

    // MARK: Photos

    private var photosCard: some View {
        card(systemImage: "photo.on.rectangle.angled", title: "Photos") {
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
                    }
                }

                if preferences.slideshow {
                    // Progressive disclosure: these controls only matter while the
                    // slideshow runs, so they stay out of the way when it does not.
                    Divider()
                    Picker("Collection", selection: collectionBinding) {
                        ForEach(PhotoCollection.allCases) { collection in
                            Text(collection.shortLabel).tag(collection)
                        }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .controlSize(.small)

                    if preferences.photoCollection == .custom {
                        folderRow
                    }

                    Toggle("Match time of day", isOn: $preferences.photoSync)
                        .toggleStyle(.switch)
                        .controlSize(.small)
                    Text(preferences.photoCollectionHint)
                        .font(.system(size: 9.5))
                        .foregroundColor(.secondary)
                        .fixedSize(horizontal: false, vertical: true)

                    HStack(spacing: 8) {
                        Text("Rotate every")
                            .font(.system(size: 11))
                        Spacer(minLength: 0)
                        Picker("Rotate every", selection: $preferences.slideshowIntervalMinutes) {
                            ForEach(intervalChoices, id: \.self) { minutes in
                                Text(intervalLabel(minutes)).tag(minutes)
                            }
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        .controlSize(.small)
                    }

                    HStack(spacing: 16) {
                        Toggle("Shuffle", isOn: $preferences.slideshowShuffle)
                            .toggleStyle(.switch)
                            .controlSize(.small)
                        Toggle("Slow zoom", isOn: $preferences.kenBurns)
                            .toggleStyle(.switch)
                            .controlSize(.small)
                        Spacer(minLength: 0)
                    }
                } else {
                    Text("Off — your greeting sits on the palette alone. Turn it on to rotate photos behind it.")
                        .font(.system(size: 9.5))
                        .foregroundColor(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .animation(.easeInOut(duration: 0.18), value: preferences.slideshow)
    }

    /// The custom-folder row: name, photo count, picker and drag-and-drop.
    ///
    /// Only shown when the custom collection is active, so the popover never
    /// carries a "Choose…" button that is disabled most of the time.
    private var folderRow: some View {
        HStack(spacing: 8) {
            Image(systemName: dropTarget.isTargeted ? "folder.fill.badge.plus" : "folder.fill")
                .font(.system(size: 12))
                .foregroundColor(dropTarget.isTargeted ? .accentColor : .secondary)
            VStack(alignment: .leading, spacing: 1) {
                Text(preferences.photoFolderLabel)
                    .font(.system(size: 10.5, weight: .medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(folderCaption)
                    .font(.system(size: 9))
                    .foregroundColor(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            Button("Choose…") { choosePhotoFolder() }
                .controlSize(.small)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(dropTarget.isTargeted ? Color.accentColor.opacity(0.18) : Color.primary.opacity(0.05))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(dropTarget.isTargeted ? Color.accentColor : Color.primary.opacity(0.10),
                              lineWidth: 1)
        )
        .onDrop(of: [.fileURL], isTargeted: $dropTarget.isTargeted) { providers in
            handleFolderDrop(providers)
        }
        .help("Drag a folder of images here, or click Choose…")
    }

    private var folderCaption: String {
        let path = preferences.photoFolderPath.trimmingCharacters(in: .whitespacesAndNewlines)
        if path.isEmpty { return "Drop a folder here, or click Choose…" }
        let count = controller.photoCount
        return "\(count) \(count == 1 ? "photo" : "photos") · drop a folder to switch"
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
                _ = preferences.applyDroppedFolder(url)
            }
        }
        return true
    }

    // MARK: Startup

    private var startupCard: some View {
        card(systemImage: "power", title: "Startup") {
            VStack(alignment: .leading, spacing: 6) {
                Toggle("Launch at login", isOn: $preferences.launchAtLogin)
                    .toggleStyle(.switch)
                    .controlSize(.small)
                Text("Start DynaWall automatically when you log in to your Mac.")
                    .font(.system(size: 9.5))
                    .foregroundColor(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if preferences.launchAtLoginRequiresApproval {
                    HStack(spacing: 6) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 10))
                            .foregroundColor(.orange)
                        Text("Permission needed in System Settings → Login Items.")
                            .font(.system(size: 9.5))
                            .foregroundColor(.secondary)
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
        HStack(spacing: 8) {
            Button {
                preferences.resetToDefaults()
            } label: {
                Label("Reset", systemImage: "arrow.counterclockwise")
                    .font(.system(size: 10.5))
            }
            .buttonStyle(.plain)
            .foregroundColor(.secondary)
            .help("Restore the default subtitle, palette and slideshow")

            Spacer(minLength: 0)

            // Pause/Resume lives in the preview card's pill; a second button here
            // was the same action twice in one panel.
            Button("Quit") {
                NSApp.terminate(nil)
            }
            .controlSize(.small)
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

    private func choosePhotoFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        panel.prompt = "Use Folder"
        panel.message = "Pick a folder of images to rotate as your wallpaper."
        if !preferences.photoFolderPath.isEmpty {
            panel.directoryURL = URL(fileURLWithPath: preferences.photoFolderPath)
        }
        NSApp.activate(ignoringOtherApps: true)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        preferences.photoFolderPath = url.path
    }
}

// MARK: - App delegate

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
            button.toolTip = "DynaWall — click to customize your desktop"
            button.target = self
            button.action = #selector(togglePopover(_:))
        }

        statusItem = item

        controller.$isPaused
            .receive(on: RunLoop.main)
            .sink { [weak self] paused in
                self?.statusItem?.button?.appearsDisabled = paused
            }
            .store(in: &cancellables)
    }

    /// The menu bar mark: a sunrise, not a hard hat.
    ///
    /// A filled solar dome with three short rays rises clear of a rounded horizon
    /// bar; the eclipse hemisphere below is a faint, dashed arc so it reads as the
    /// hidden half of the same circle instead of a chin strap. Drawn as a template
    /// image, so macOS tints it for the light and dark menu bar — and dims it for
    /// free while the wallpaper is paused (`button.appearsDisabled`).
    static func makeMenuBarIcon() -> NSImage {
        let size = NSSize(width: 18, height: 18)
        let image = NSImage(size: size, flipped: false) { _ in
            // Optical centre: the dome reads heavier than the submerged arc, so the
            // horizon sits a touch above the geometric middle of the canvas.
            let center = NSPoint(x: size.width / 2, y: 9.1)
            let orbRadius: CGFloat = 5.4
            let horizonWidth: CGFloat = 15
            let horizonThickness: CGFloat = 1.15
            // A real gap above the horizon is what keeps the mark from reading as a
            // hard hat: the dome rises clear of the bar instead of merging with it.
            let horizonGap: CGFloat = 1.1
            let rayGap: CGFloat = 0.7
            let rayLength: CGFloat = 1.45
            let rayWidth: CGFloat = 1.0

            NSColor.black.setFill()
            NSColor.black.setStroke()

            // Solar hemisphere — a filled dome rising above the horizon.
            let dome = NSBezierPath()
            dome.appendArc(withCenter: center, radius: orbRadius, startAngle: 0, endAngle: 180, clockwise: false)
            dome.close()
            dome.fill()

            // Three short rays at 45°, 90° and 135°: at 18×18 a bare dome over a bar
            // is ambiguous, and the rays settle it as a sun in one glance.
            [90.0, 45.0, 135.0].forEach { degrees in
                let radians = degrees * Double.pi / 180
                let innerRadius = Double(orbRadius) + Double(rayGap)
                let outerRadius = innerRadius + Double(rayLength)
                let inner = NSPoint(
                    x: center.x + CGFloat(innerRadius * cos(radians)),
                    y: center.y + CGFloat(innerRadius * sin(radians))
                )
                let outer = NSPoint(
                    x: center.x + CGFloat(outerRadius * cos(radians)),
                    y: center.y + CGFloat(outerRadius * sin(radians))
                )
                let ray = NSBezierPath()
                ray.move(to: inner)
                ray.line(to: outer)
                ray.lineWidth = rayWidth
                ray.lineCapStyle = .round
                ray.stroke()
            }

            // Rounded-cap horizon line, clear of the dome's base.
            let horizon = NSRect(
                x: center.x - horizonWidth / 2,
                y: center.y - horizonGap - horizonThickness,
                width: horizonWidth,
                height: horizonThickness
            )
            NSBezierPath(
                roundedRect: horizon,
                xRadius: horizonThickness / 2,
                yRadius: horizonThickness / 2
            ).fill()

            // Eclipse hemisphere — stroked just inside the dome's silhouette, with a
            // gap between 180° and 202° (and mirrored at 338°) under the horizon. The
            // dashes and the lowered opacity keep it a reflection of the sun rather
            // than the strap of a construction helmet.
            let eclipse = NSBezierPath()
            eclipse.appendArc(
                withCenter: center,
                radius: orbRadius - horizonThickness / 2,
                startAngle: 202,
                endAngle: 338,
                clockwise: false
            )
            eclipse.lineWidth = horizonThickness
            eclipse.lineCapStyle = .round
            eclipse.setLineDash([0.9, 1.5], count: 2, phase: 0)
            NSColor.black.withAlphaComponent(0.55).setStroke()
            eclipse.stroke()

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

    @objc private func togglePopover(_ sender: Any?) {
        guard let button = statusItem?.button else { return }

        if popover == nil {
            popover = makePopover()
        }
        guard let popover else { return }

        if popover.isShown {
            popover.performClose(sender)
            return
        }

        NSApp.activate(ignoringOtherApps: true)
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        popover.contentViewController?.view.window?.makeKey()
    }

    // MARK: System events

    private func observeSystemEvents() {
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.controller.rebuildIfNeeded()
        }

        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            dynaLog("system woke from sleep — resyncing greeting and photos")
            self?.controller.resync()
        }
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

