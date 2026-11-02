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
import SwiftUI
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

    /// 05:00–08:59 dawn · 09:00–16:59 day · 17:00–20:59 dusk · 21:00–04:59 night.
    static func current(now: Date = Date(), calendar: Calendar = .current) -> ThemeSlot {
        switch calendar.component(.hour, from: now) {
        case 5..<9: return .dawn
        case 9..<17: return .day
        case 17..<21: return .dusk
        default: return .night
        }
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
    func reload(collection: PhotoCollection, folderPath: String) {
        let trimmed = folderPath.trimmingCharacters(in: .whitespacesAndNewlines)
        let base = Self.bundledFolder()
        let curated = collection.bundledFiles

        var resolved = trimmed.isEmpty ? base : trimmed
        var scanned = Self.scan(resolved)

        if !curated.isEmpty {
            let picked = curated.compactMap { name -> URL? in
                let url = URL(fileURLWithPath: base).appendingPathComponent(name)
                return FileManager.default.fileExists(atPath: url.path) ? url : nil
            }
            if !picked.isEmpty {
                resolved = base
                scanned = picked
            }
        }

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
    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard let payload = message.body as? [String: Any] else { return }
        let source = payload["src"] as? String ?? "<unknown>"
        let width = payload["width"] as? Int ?? 0
        let height = payload["height"] as? Int ?? 0
        dynaLog("slideshow advanced: \(source) (\(width)x\(height))")
    }
}

// MARK: - Preferences

/// Persisted wallpaper settings. Every mutation is written to `UserDefaults` and
/// reported through `onChange` so the wallpaper follows the menu bar live.
final class WallpaperPreferences: ObservableObject {
    enum Key {
        static let firstName = "firstName"
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
    }

    static let defaultSubtitle = "What are we building today?"

    @Published var firstName: String {
        didSet { persist(firstName, Key.firstName) }
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

    /// Only a pinned colour sends `bgColor`; `auto` and the four bands leave every
    /// token to `style.css`, which is what keeps the clock in charge.
    private var bgColorUpdate: String {
        switch themePreset {
        case .githubDark, .deepSlate, .custom:
            return "window.livelyPropertyListener(\"bgColor\", \(Self.jsLiteral(bgColor)));"
        case .auto, .dawn, .day, .dusk, .night:
            return ""
        }
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

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        defaults.register(defaults: [
            Key.firstName: Self.detectedFirstName(),
            Key.subtitle: Self.defaultSubtitle,
            Key.themePreset: ThemePreset.auto.rawValue,
            Key.customColor: HexColor.fallback,
            Key.slideshow: false,
            Key.slideshowInterval: 15,
            Key.slideshowShuffle: true,
            Key.kenBurns: true,
            Key.photoFolder: "",
            Key.photoCollection: PhotoCollection.goldenGate.rawValue,
            Key.photoSync: true
        ])

        firstName = defaults.string(forKey: Key.firstName) ?? Self.detectedFirstName()
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
    }

    /// The wallpaper greeting starts from the macOS account's first name.
    static func detectedFirstName() -> String {
        let full = NSFullUserName().trimmingCharacters(in: .whitespacesAndNewlines)
        if let first = full.split(whereSeparator: { $0 == " " || $0 == "\t" }).first, !first.isEmpty {
            return String(first)
        }
        let short = NSUserName().trimmingCharacters(in: .whitespacesAndNewlines)
        return short.isEmpty ? "Developer" : short
    }

    // MARK: Bridge

    /// Full settings payload expressed as calls into the shared web wallpaper API.
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

    private final class WallpaperWindow {
        let window: NSWindow
        let webView: WKWebView
        let screen: NSScreen
        var isReady = false

        init(window: NSWindow, webView: WKWebView, screen: NSScreen) {
            self.window = window
            self.webView = webView
            self.screen = screen
        }
    }

    private var windows: [WallpaperWindow] = []
    private var screenSignature: [String] = []
    private var pendingPush: DispatchWorkItem?
    /// Band the native layers were last painted with, and the timer that watches for
    /// the clock crossing into the next one.
    private var activeThemeSlot = ThemeSlot.current()
    private var themeTimer: Timer?
    /// Photos served to the page: a bundled collection by default, any folder on request.
    private let photoLibrary = PhotoLibrary()
    /// Collection + folder the current photo list was scanned from (`nil` = never loaded).
    private var loadedPhotoSource: String?

    /// Typing in the popover updates the wallpaper live; a short coalescing window
    /// keeps the web app's greeting cross-fade smooth while keys are pressed.
    private let pushDebounce: TimeInterval = 0.15

    init(preferences: WallpaperPreferences = WallpaperPreferences()) {
        self.preferences = preferences
        super.init()
        preferences.onChange = { [weak self] _ in self?.schedulePush() }
    }

    // MARK: Lifecycle

    func start() {
        rebuild()
        startThemeClock()
    }

    // MARK: Time-aware palette

    /// The page re-colours itself when the clock crosses a band edge; the native
    /// window and backing layers need the same nudge, so a slow timer watches the
    /// hour and only repaints when the band actually changed.
    private func startThemeClock() {
        activeThemeSlot = ThemeSlot.current()
        themeTimer?.invalidate()
        let timer = Timer(timeInterval: 60, repeats: true) { [weak self] _ in
            self?.refreshThemeIfNeeded()
        }
        timer.tolerance = 5
        // `.common` keeps it alive while a menu or the popover is tracking.
        RunLoop.main.add(timer, forMode: .common)
        themeTimer = timer
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
    /// the settings arrive over IPC right after `didFinish`.
    private var indexURL: URL? {
        resourcesURL?.appendingPathComponent("index.html")
    }

    private func makeWindow(for screen: NSScreen) -> WallpaperWindow {
        let frame = screen.frame
        let color = HexColor.nsColor(preferences.bgColor)

        let configuration = WKWebViewConfiguration()
        // Keep wallpaper state out of the user's Safari/WebKit data: the page is
        // fully driven by this app, so an in-memory store avoids stale values.
        configuration.websiteDataStore = .nonPersistent()
        configuration.suppressesIncrementalRendering = true
        // Photos live outside the bundle, so they are served through a private scheme.
        configuration.setURLSchemeHandler(
            PhotoSchemeHandler(library: photoLibrary),
            forURLScheme: PhotoLibrary.scheme
        )
        configuration.userContentController.add(PhotoEventLogger(), name: "dynawallPhoto")

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

    /// Push every setting to every display (the web app skips unchanged values).
    func pushCurrentPreferences() {
        reloadPhotosIfNeeded()

        let script = preferences.javaScriptUpdate
        let photosScript = photosJavaScriptUpdate
        let color = HexColor.nsColor(preferences.bgColor)

        for entry in windows {
            entry.window.backgroundColor = color
            entry.webView.underPageBackgroundColor = color
            guard entry.isReady else { continue }
            entry.webView.evaluateJavaScript(script) { _, error in
                if let error {
                    dynaLog("settings push failed: \(error.localizedDescription)")
                }
            }
            if let photosScript {
                entry.webView.evaluateJavaScript(photosScript) { _, error in
                    if let error {
                        dynaLog("photo push failed: \(error.localizedDescription)")
                    }
                }
            }
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
        dynaLog("photo library: \(photoLibrary.summary)")
    }

    /// The resolved photo list, pushed through the same bridge Lively uses.
    private var photosJavaScriptUpdate: String? {
        let urls = photoLibrary.photoURLs()
        guard !urls.isEmpty else { return nil }
        return """
        (function () {
          if (typeof window.livelyPropertyListener !== "function") { return false; }
          window.livelyPropertyListener("photos", \(WallpaperPreferences.jsArrayLiteral(urls)));
          return true;
        })();
        """
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
        }

        if !paused {
            resync()
        }
        dynaLog(paused ? "wallpaper paused" : "wallpaper resumed")
    }

    // MARK: Reveal / verification

    private func reveal(_ entry: WallpaperWindow) {
        guard !isPaused else { return }
        // The page paints with its built-in defaults first and the IPC push then
        // cross-fades to the user's greeting; wait for that swap so the wallpaper
        // never flashes somebody else's name on launch.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { [weak self, weak entry] in
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

struct SettingsPopoverView: View {
    @ObservedObject var preferences: WallpaperPreferences
    @ObservedObject var controller: DesktopWindowController

    private var customColorBinding: Binding<Color> {
        Binding(
            get: { HexColor.color(preferences.customColorHex) },
            set: { preferences.customColorHex = HexColor.hex($0) }
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                if let appIcon = NSImage(named: NSImage.applicationIconName) {
                    Image(nsImage: appIcon)
                        .resizable()
                        .interpolation(.high)
                        .frame(width: 36, height: 36)
                        .accessibilityHidden(true)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text("DynaWall")
                        .font(.headline)
                    Text("Live desktop greeting")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }

            Divider()

            field("First name", text: $preferences.firstName)
            field("Subtitle", text: $preferences.subtitleText)

            Divider()

            Picker("Palette", selection: $preferences.themePreset) {
                ForEach(ThemePreset.allCases) { preset in
                    Text(preset.label).tag(preset)
                }
            }
            .pickerStyle(.menu)

            Text(paletteHint)
                .font(.caption2)
                .foregroundColor(.secondary)

            ColorPicker("Custom color", selection: customColorBinding, supportsOpacity: false)
                .disabled(preferences.themePreset != .custom)
                .opacity(preferences.themePreset == .custom ? 1 : 0.45)

            Divider()

            Toggle("Photo slideshow", isOn: $preferences.slideshow)
                .toggleStyle(.switch)
            Picker("Collection", selection: $preferences.photoCollection) {
                ForEach(PhotoCollection.allCases) { collection in
                    Text(collection.label).tag(collection)
                }
            }
            .pickerStyle(.menu)
            Toggle("Match time of day", isOn: $preferences.photoSync)
                .toggleStyle(.switch)
                .disabled(!preferences.slideshow)
            Picker("Rotate every", selection: $preferences.slideshowIntervalMinutes) {
                ForEach(intervalChoices, id: \.self) { minutes in
                    Text(minutes < 60 ? "\(minutes) min" : "\(minutes / 60) h").tag(minutes)
                }
            }
            .pickerStyle(.menu)
            .disabled(!preferences.slideshow)
            Toggle("Shuffle order", isOn: $preferences.slideshowShuffle)
                .toggleStyle(.switch)
                .disabled(!preferences.slideshow)
            Toggle("Slow zoom", isOn: $preferences.kenBurns)
                .toggleStyle(.switch)
                .disabled(!preferences.slideshow)

            Text(preferences.photoCollectionHint)
                .font(.caption2)
                .foregroundColor(.secondary)

            HStack(spacing: 6) {
                Button("Next photo") { controller.nextPhoto() }
                    .disabled(!preferences.slideshow)
                Spacer(minLength: 0)
                Button("Choose…") { choosePhotoFolder() }
                    .disabled(preferences.photoCollection != .custom)
            }

            if preferences.photoCollection == .custom {
                Text(preferences.photoFolderLabel)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            Divider()

            HStack(spacing: 8) {
                Button(controller.isPaused ? "Resume wallpaper" : "Pause wallpaper") {
                    controller.togglePause()
                }
                Spacer(minLength: 0)
                Button("Quit DynaWall") {
                    NSApp.terminate(nil)
                }
            }
        }
        .padding(16)
        .frame(width: 324)
        .onChange(of: preferences.photoCollection) { collection in
            // "Custom folder…" is a request for a folder: ask for one straight away
            // instead of leaving the wallpaper pointing at the bundled set.
            if collection == .custom && preferences.photoFolderPath.isEmpty {
                choosePhotoFolder()
            }
        }
    }

    private func field(_ title: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption)
                .foregroundColor(.secondary)
            TextField(title, text: text)
                .textFieldStyle(.roundedBorder)
        }
    }

    /// One line of context for the palette picker: what the clock is doing, or why
    /// the wallpaper is ignoring it.
    private var paletteHint: String {
        switch preferences.themePreset {
        case .auto:
            return "Following the clock — \(ThemeSlot.current().label.lowercased()) right now"
        case .dawn, .day, .dusk, .night:
            return "Palette pinned; Auto hands it back to the clock"
        case .githubDark, .deepSlate, .custom:
            return "Fixed colour, neutral palette"
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
        configureStatusItem()
        configurePopover()
        controller.start()
        observeSystemEvents()
        dynaLog("launched with \(NSScreen.screens.count) display(s)")
    }

    func applicationWillTerminate(_ notification: Notification) {
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
            let symbol = NSImage(systemSymbolName: "text.below.photo", accessibilityDescription: "DynaWall")
                ?? NSImage(systemSymbolName: "sun.horizon", accessibilityDescription: "DynaWall")
            if let symbol {
                symbol.isTemplate = true
                button.image = symbol
            } else {
                button.title = "DynaWall"
            }
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

    // MARK: Popover

    private func configurePopover() {
        let popover = NSPopover()
        popover.behavior = .transient
        popover.animates = true
        popover.contentSize = NSSize(width: 324, height: 534)
        popover.contentViewController = NSHostingController(
            rootView: SettingsPopoverView(preferences: controller.preferences, controller: controller)
        )
        self.popover = popover
    }

    @objc private func togglePopover(_ sender: Any?) {
        guard let popover, let button = statusItem?.button else { return }

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

