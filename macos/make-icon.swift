#!/usr/bin/env swift
//
//  make-icon.swift
//  Generates DynaWall's macOS AppIcon.icns and a 1024x1024 preview PNG using
//  pure CoreGraphics & AppKit (zero external dependencies).
//
//  Usage:
//    swift macos/make-icon.swift [output-dir]
//

import AppKit
import CoreGraphics
import Foundation

let outputDir: URL = {
    if CommandLine.arguments.count > 1 {
        return URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
    }
    return URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
        .appendingPathComponent("macos", isDirectory: true)
}()

func srgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1.0) -> CGColor {
    CGColor(srgbRed: r / 255.0, green: g / 255.0, blue: b / 255.0, alpha: a)
}

/// Draws a continuous-ish macOS squircle path inside `rect` using `NSBezierPath` / `CGPath`.
func squirclePath(in rect: CGRect, cornerRadius: CGFloat) -> CGPath {
    // Smooth rounded rect matching macOS icon silhouette proportions
    return CGPath(roundedRect: rect, cornerWidth: cornerRadius, cornerHeight: cornerRadius, transform: nil)
}

/// Strokes `path` with a linear gradient.
///
/// CoreGraphics can only *fill* with a gradient, so the stroked outline is turned
/// into a clip region first (`replacePathWithStrokedPath`). Every lit edge in the
/// mark — the squircle rim, the horizon, the eclipse arc — is drawn this way, so a
/// single stroke can fade along its own length instead of ending in a hard edge.
func strokeGradient(_ ctx: CGContext,
                    path: CGPath,
                    lineWidth: CGFloat,
                    colorSpace: CGColorSpace,
                    colors: [CGColor],
                    locations: [CGFloat],
                    from start: CGPoint,
                    to end: CGPoint) {
    guard let gradient = CGGradient(colorsSpace: colorSpace, colors: colors as CFArray, locations: locations) else {
        return
    }
    ctx.saveGState()
    ctx.addPath(path)
    ctx.setLineWidth(lineWidth)
    ctx.setLineCap(.butt)
    ctx.replacePathWithStrokedPath()
    ctx.clip()
    ctx.drawLinearGradient(
        gradient,
        start: start,
        end: end,
        options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
    )
    ctx.restoreGState()
}

/// Which mark the generator draws. `DYNAWALL_ICON_DESIGN=monolith|arc` re-renders the
/// earlier variants; the default is the radical Bauhaus silhouette.
enum IconDesign: String {
    case bauhaus            // flat bone dome on a razor horizon, no arc (default)
    case bauhausArc         // same, with a hairline submerged eclipse arc
    case luminousMonolith   // gradient dome, hairline horizon, fading arc

    static let current: IconDesign = {
        switch ProcessInfo.processInfo.environment["DYNAWALL_ICON_DESIGN"]?.lowercased() {
        case "monolith", "luminous", "a": return .luminousMonolith
        case "arc", "bauhaus-arc", "3": return .bauhausArc
        default: return .bauhaus
        }
    }()
}

/// Renders the definitive DynaWall icon at `pixelSize x pixelSize`.
///
/// One idea, two shapes: a solid bone hemisphere rising over a razor horizon, the
/// lower half left as pure obsidian negative space. No gradients, no bloom, no
/// corona, no specular inner rim — 100% vector starkness, the way a Bauhaus poster
/// or a Teenage Engineering faceplate is built. The dome and the line still read at
/// 16x16, which is the whole test: anything that cannot survive that size is noise,
/// not identity.
func renderIcon(pixelSize: Int) -> NSBitmapImageRep {
    switch IconDesign.current {
    case .bauhaus:
        return renderBauhausIcon(pixelSize: pixelSize, drawArc: false)
    case .bauhausArc:
        return renderBauhausIcon(pixelSize: pixelSize, drawArc: true)
    case .luminousMonolith:
        return renderLuminousMonolithIcon(pixelSize: pixelSize)
    }
}

/// The gradient "Luminous Monolith" mark: kept switchable (`DYNAWALL_ICON_DESIGN=monolith`)
/// so the two readings of the same geometry can be compared from one generator.
func renderLuminousMonolithIcon(pixelSize: Int) -> NSBitmapImageRep {
    let size = CGFloat(pixelSize)
    let scale = size / 1024.0

    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: pixelSize,
        pixelsHigh: pixelSize,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else {
        fatalError("Failed to allocate bitmap rep for size \(pixelSize)")
    }

    NSGraphicsContext.saveGraphicsState()
    guard let nsCtx = NSGraphicsContext(bitmapImageRep: rep) else {
        fatalError("Failed to create NSGraphicsContext")
    }
    NSGraphicsContext.current = nsCtx
    let ctx = nsCtx.cgContext

    ctx.setAllowsAntialiasing(true)
    ctx.setShouldAntialias(true)
    ctx.interpolationQuality = .high

    // Work in a normalized 1024x1024 coordinate system (origin bottom-left)
    ctx.scaleBy(x: scale, y: scale)

    let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

    // Apple HIG icon grid: 824x824 body centered inside 1024x1024 (100pt margin)
    let bodyRect = CGRect(x: 100, y: 100, width: 824, height: 824)
    let cornerRadius: CGFloat = 185.0
    let bodyPath = squirclePath(in: bodyRect, cornerRadius: cornerRadius)

    // The only composition anchor in the whole mark: a horizon a hair above the
    // optical centre, so the dome reads as rising light rather than a bisected
    // circle. Everything else is sized from it.
    let center = CGPoint(x: 512, y: 488)
    let orbRadius: CGFloat = 204.0
    let orbRect = CGRect(
        x: center.x - orbRadius,
        y: center.y - orbRadius,
        width: orbRadius * 2,
        height: orbRadius * 2
    )
    let orbPath = CGPath(ellipseIn: orbRect, transform: nil)
    let upperHalf = CGRect(x: bodyRect.minX, y: center.y, width: bodyRect.width, height: bodyRect.maxY - center.y)
    let lowerHalf = CGRect(x: bodyRect.minX, y: bodyRect.minY, width: bodyRect.width, height: center.y - bodyRect.minY)

    // Every hairline is snapped to whole *device* pixels. A modelled 2.5pt stroke is
    // 4% of a pixel at 16x16 and would smear the split into grey haze, so the width is
    // rounded to the nearest physical pixel and expressed back in mark units: the
    // horizon and the eclipse arc stay one razor pixel wide on every iconset entry,
    // 1024 included. Nothing else in the mark is thin enough to need the treatment.
    let onePixel = 1.0 / scale
    func hairline(_ modelled: CGFloat) -> CGFloat {
        let devicePixels = (modelled * scale).rounded(.toNearestOrAwayFromZero)
        return max(1.0, devicePixels) * onePixel
    }

    let horizonThickness = hairline(2.5)
    let arcThickness = hairline(2.5)
    // The squircle rim light is a large-size nicety. Snapped to a whole pixel it turns
    // into a grey ring that fights the silhouette, so below 128px it keeps its modelled
    // width and dissolves into the canvas instead.
    let rimThickness: CGFloat = pixelSize >= 128 ? hairline(3.0) : 3.0

    // Two tones carry the whole mark: the sun above the split, the eclipse below it.
    // No third colour, no bloom, no haze — anything that cannot survive 16x16 is noise.
    let ivory = srgb(255, 253, 249)   // #fffdf9 apex
    let amber = srgb(255, 150, 84)    // #ff9654 horizon baseline
    // A single lit pixel has to do more work the smaller the canvas, so the submerged
    // arc steps up as the icon shrinks: 26% on the 1024 master (where it is three
    // physical pixels), 40% across 128-512 (one pixel), 52% at 64, and 62% on the
    // 16/32 px entries where that one pixel *is* the whole silhouette.
    let rimArcAlpha: CGFloat = pixelSize >= 1024
        ? 0.26
        : (pixelSize >= 128 ? 0.40 : (pixelSize >= 64 ? 0.52 : 0.62))

    // 1. Outer ambient drop shadow (a single soft contact shadow, no inner glow)
    if pixelSize >= 32 {
        ctx.saveGState()
        ctx.setShadow(
            offset: CGSize(width: 0, height: -18),
            blur: 38,
            color: srgb(4, 7, 15, 0.58)
        )
        ctx.setFillColor(srgb(9, 12, 20, 1.0))
        ctx.addPath(bodyPath)
        ctx.fillPath()
        ctx.restoreGState()
    }

    // 2. Clip to the squircle body — everything below lives inside the silhouette
    ctx.saveGState()
    ctx.addPath(bodyPath)
    ctx.clip()

    // 3. Obsidian canvas: one restrained vertical tone, #080b12 deepening at the top
    //    and lifting to #0d121c at the base so the submerged hemisphere reads as a
    //    silhouette rather than dissolving into the field. The negative space *is* the
    //    icon; nothing else is allowed to fill it.
    if let canvas = CGGradient(
        colorsSpace: colorSpace,
        colors: [
            srgb(8, 11, 18, 1.0),   // #080b12 deepest ink
            srgb(13, 18, 28, 1.0)   // #0d121c lifted ink
        ] as CFArray,
        locations: [0.0, 1.0]
    ) {
        ctx.drawLinearGradient(
            canvas,
            start: CGPoint(x: center.x, y: bodyRect.maxY),
            end: CGPoint(x: center.x, y: bodyRect.minY),
            options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
        )
    }

    // 4. Upper solar hemisphere: a clean two-stop dawn. Warm ivory at the apex melting
    //    straight into amber at the horizon — no third colour, no haze, no inner rim.
    ctx.saveGState()
    ctx.clip(to: upperHalf)
    ctx.addPath(orbPath)
    ctx.clip()
    if let solar = CGGradient(
        colorsSpace: colorSpace,
        colors: [ivory, amber] as CFArray,
        locations: [0.0, 1.0]
    ) {
        ctx.drawLinearGradient(
            solar,
            start: CGPoint(x: center.x, y: center.y + orbRadius),
            end: CGPoint(x: center.x, y: center.y),
            options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
        )
    }
    ctx.restoreGState()

    // 5. Lower eclipse hemisphere: submerged nocturnal glass, one step darker the
    //    deeper it sinks. A single tone change — no reflection bleeding off the water.
    ctx.saveGState()
    ctx.clip(to: lowerHalf)
    ctx.addPath(orbPath)
    ctx.clip()
    if let eclipse = CGGradient(
        colorsSpace: colorSpace,
        colors: [
            srgb(16, 21, 34, 1.0),  // #101522 glass at the waterline
            srgb(7, 10, 17, 1.0)    // #070a11 night at the pole
        ] as CFArray,
        locations: [0.0, 1.0]
    ) {
        ctx.drawLinearGradient(
            eclipse,
            start: CGPoint(x: center.x, y: center.y),
            end: CGPoint(x: center.x, y: center.y - orbRadius),
            options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
        )
    }
    ctx.restoreGState()

    // 6. Eclipse rim arc: one crisp pixel-snapped stroke on the submerged half,
    //    brightest where it meets the horizon and fading to nothing at the pole.
    ctx.saveGState()
    ctx.clip(to: lowerHalf)
    ctx.addPath(orbPath)
    ctx.clip()
    let eclipseRim = CGMutablePath()
    eclipseRim.addArc(
        center: center,
        radius: orbRadius - arcThickness / 2,
        startAngle: 0,
        endAngle: .pi,
        clockwise: true
    )
    strokeGradient(
        ctx,
        path: eclipseRim,
        lineWidth: arcThickness,
        colorSpace: colorSpace,
        colors: [
            srgb(240, 246, 252, rimArcAlpha),
            srgb(240, 246, 252, 0.0)
        ],
        locations: [0.0, 1.0],
        from: CGPoint(x: center.x, y: center.y),
        to: CGPoint(x: center.x, y: center.y - orbRadius)
    )
    ctx.restoreGState()

    // 7. Razor horizon line: 824pt of light splitting day from night. Bright across
    //    the orb, dissolving to nothing before the squircle margins so it never looks
    //    like a ruler laid over the icon, and never bleeds into the negative space.
    let horizon = CGMutablePath()
    horizon.move(to: CGPoint(x: bodyRect.minX, y: center.y))
    horizon.addLine(to: CGPoint(x: bodyRect.maxX, y: center.y))
    strokeGradient(
        ctx,
        path: horizon,
        lineWidth: horizonThickness,
        colorSpace: colorSpace,
        colors: [
            srgb(255, 246, 232, 0.0),
            srgb(255, 246, 232, 0.78),
            srgb(255, 246, 232, 0.78),
            srgb(255, 246, 232, 0.0)
        ],
        locations: [0.0, 0.26, 0.74, 1.0],
        from: CGPoint(x: bodyRect.minX, y: center.y),
        to: CGPoint(x: bodyRect.maxX, y: center.y)
    )

    // 8. Squircle rim light: a restrained top-lit specular border, 22% white at the
    //    top edge falling to 4% at the bottom — the standard macOS icon lighting cue.
    strokeGradient(
        ctx,
        path: bodyPath,
        lineWidth: rimThickness,
        colorSpace: colorSpace,
        colors: [
            srgb(255, 255, 255, 0.04),
            srgb(255, 255, 255, 0.22)
        ],
        locations: [0.0, 1.0],
        from: CGPoint(x: center.x, y: bodyRect.minY),
        to: CGPoint(x: center.x, y: bodyRect.maxY)
    )

    ctx.restoreGState() // end squircle clip
    NSGraphicsContext.restoreGraphicsState()

    return rep
}

/// Renders the Bauhaus mark: flat obsidian field, flat bone hemisphere, one razor
/// horizon. `drawArc` completes the circle with a single hairline submerged arc for
/// the eclipse reading; without it the silhouette is the starkest form of the mark.
func renderBauhausIcon(pixelSize: Int, drawArc: Bool) -> NSBitmapImageRep {
    let size = CGFloat(pixelSize)
    let scale = size / 1024.0

    guard let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil,
        pixelsWide: pixelSize,
        pixelsHigh: pixelSize,
        bitsPerSample: 8,
        samplesPerPixel: 4,
        hasAlpha: true,
        isPlanar: false,
        colorSpaceName: .deviceRGB,
        bytesPerRow: 0,
        bitsPerPixel: 0
    ) else {
        fatalError("Failed to allocate bitmap rep for size \(pixelSize)")
    }

    NSGraphicsContext.saveGraphicsState()
    guard let nsCtx = NSGraphicsContext(bitmapImageRep: rep) else {
        fatalError("Failed to create NSGraphicsContext")
    }
    NSGraphicsContext.current = nsCtx
    let ctx = nsCtx.cgContext
    ctx.setAllowsAntialiasing(true)
    ctx.setShouldAntialias(true)
    ctx.interpolationQuality = .high
    ctx.scaleBy(x: scale, y: scale)

    // Apple HIG icon grid: 824x824 body centered inside 1024x1024 (100pt margin)
    let bodyRect = CGRect(x: 100, y: 100, width: 824, height: 824)
    let cornerRadius: CGFloat = 185.0
    let bodyPath = squirclePath(in: bodyRect, cornerRadius: cornerRadius)

    // The same optical anchor as every DynaWall mark: a horizon a hair above the
    // geometric centre, so the dome reads as rising light, not a bisected disc.
    let center = CGPoint(x: 512, y: 488)
    let orbRadius: CGFloat = 204.0
    let orbRect = CGRect(
        x: center.x - orbRadius,
        y: center.y - orbRadius,
        width: orbRadius * 2,
        height: orbRadius * 2
    )
    let orbPath = CGPath(ellipseIn: orbRect, transform: nil)
    let upperHalf = CGRect(x: bodyRect.minX, y: center.y, width: bodyRect.width, height: bodyRect.maxY - center.y)
    let lowerHalf = CGRect(x: bodyRect.minX, y: bodyRect.minY, width: bodyRect.width, height: center.y - bodyRect.minY)

    // Hairlines snap to whole device pixels: one razor pixel at every iconset entry.
    let onePixel = 1.0 / scale
    func hairline(_ modelled: CGFloat) -> CGFloat {
        let devicePixels = (modelled * scale).rounded(.toNearestOrAwayFromZero)
        return max(1.0, devicePixels) * onePixel
    }
    let horizonThickness = hairline(2.5)
    // A flat hairline rim, never a gradient: just enough edge to hold the squircle
    // against a dark desktop without breaking the no-gradient rule.
    let rimThickness: CGFloat = pixelSize >= 128 ? hairline(3.0) : 3.0
    // One material only: bone. Every shape in the mark is this single colour.
    let bone = srgb(250, 246, 238)

    // 1. Ambient contact shadow — the only soft thing here, and it sits outside the
    //    squircle so the mark itself stays hard-edged.
    ctx.saveGState()
    ctx.setShadow(
        offset: CGSize(width: 0, height: -18 * max(0.35, scale)),
        blur: 32,
        color: srgb(0, 0, 0, 0.55)
    )
    ctx.setFillColor(srgb(7, 10, 17))
    ctx.addPath(bodyPath)
    ctx.fillPath()
    ctx.restoreGState()

    // 2. Clip to the squircle body
    ctx.saveGState()
    ctx.addPath(bodyPath)
    ctx.clip()

    // 3. Flat obsidian canvas: no gradient at all. The negative space is the icon.
    ctx.setFillColor(srgb(7, 10, 17))
    ctx.fill(bodyRect)

    // 4. Solar hemisphere: solid bone, clipped to the half above the horizon.
    ctx.saveGState()
    ctx.clip(to: upperHalf)
    ctx.addPath(orbPath)
    ctx.clip()
    ctx.setFillColor(bone)
    ctx.fill(upperHalf)
    ctx.restoreGState()

    // 5. Optional submerged eclipse arc: a single flat hairline, brightest where it
    //    meets the horizon. Flat alpha only — a gradient would soften the silhouette.
    if drawArc {
        ctx.saveGState()
        ctx.addPath(orbPath)
        ctx.setLineWidth(hairline(2.5))
        ctx.replacePathWithStrokedPath()
        ctx.clip()
        ctx.clip(to: lowerHalf)
        ctx.setFillColor(srgb(250, 246, 238, pixelSize >= 128 ? 0.42 : 0.62))
        ctx.fill(lowerHalf)
        ctx.restoreGState()
    }

    // 6. Razor horizon: one crisp line wider than the dome, held clear of the
    //    squircle margins so it never reads as a ruler laid across the icon.
    ctx.setFillColor(srgb(250, 246, 238, 0.92))
    ctx.fill(CGRect(
        x: bodyRect.minX + 96,
        y: center.y - horizonThickness,
        width: bodyRect.width - 192,
        height: horizonThickness
    ))

    // 7. Flat rim hairline: a single tone, no gradient — just enough edge to hold the
    //    squircle against a dark desktop.
    ctx.saveGState()
    ctx.addPath(bodyPath)
    ctx.setLineWidth(rimThickness)
    ctx.setStrokeColor(srgb(255, 255, 255, 0.09))
    ctx.strokePath()
    ctx.restoreGState()

    ctx.restoreGState() // end squircle clip
    NSGraphicsContext.restoreGraphicsState()

    return rep
}

func writePNG(_ rep: NSBitmapImageRep, to url: URL) throws {
    guard let data = rep.representation(using: .png, properties: [:]) else {
        throw NSError(domain: "DynaWallIcon", code: 1, userInfo: [NSLocalizedDescriptionKey: "PNG encoding failed"])
    }
    try data.write(to: url, options: .atomic)
}

try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)

let iconsetURL = outputDir.appendingPathComponent("AppIcon.iconset", isDirectory: true)
try? FileManager.default.removeItem(at: iconsetURL)
try FileManager.default.createDirectory(at: iconsetURL, withIntermediateDirectories: true)

let specs: [(name: String, pixels: Int)] = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024)
]

var cache: [Int: NSBitmapImageRep] = [:]
for spec in specs {
    let rep = cache[spec.pixels] ?? {
        let rendered = renderIcon(pixelSize: spec.pixels)
        cache[spec.pixels] = rendered
        return rendered
    }()
    try writePNG(rep, to: iconsetURL.appendingPathComponent(spec.name))
}

// Save the 1024x1024 master PNG at macos/AppIcon.png for previews/docs
let masterPNG = outputDir.appendingPathComponent("AppIcon.png")
if let rep1024 = cache[1024] {
    try writePNG(rep1024, to: masterPNG)
}

// Convert AppIcon.iconset -> AppIcon.icns using /usr/bin/iconutil
let icnsURL = outputDir.appendingPathComponent("AppIcon.icns")
let proc = Process()
proc.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
proc.arguments = ["-c", "icns", iconsetURL.path, "-o", icnsURL.path]
try proc.run()
proc.waitUntilExit()

try? FileManager.default.removeItem(at: iconsetURL)

guard proc.terminationStatus == 0 else {
    fputs("error: iconutil failed with status \(proc.terminationStatus)\n", stderr)
    exit(1)
}

print("Generated \(icnsURL.path) and \(masterPNG.path)")

