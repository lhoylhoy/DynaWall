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

/// Renders the DynaWall icon at `pixelSize x pixelSize`.
///
/// The mark is deliberately ultra-minimalist: pure geometry, light and negative
/// space. Inside an obsidian squircle a single orb is cut by a razor horizon — a
/// warm solar hemisphere rises above it, a submerged eclipse hemisphere rests
/// below it. Day over night, in one clean optical split. No stars, no ridges, no
/// floating glass card: anything that cannot survive 16x16 is noise, not identity.
func renderIcon(pixelSize: Int) -> NSBitmapImageRep {
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

    // Hairlines are floored to whole rendered pixels. At 16x16 the modelled 2.5pt
    // horizon is 4% of a pixel, which would turn the icon into a grey haze; flooring
    // it keeps the split razor sharp all the way down to the smallest iconset entry.
    let onePixel = 1.0 / scale
    let horizonThickness = max(2.5, onePixel)
    let arcThickness = max(2.5, onePixel)
    // The squircle rim light is a large-size nicety: floored to a whole pixel it turns
    // into a grey ring that fights the silhouette, so below 128px it keeps its modelled
    // width and simply disappears instead.
    let rimThickness: CGFloat = pixelSize >= 128 ? max(3.0, onePixel) : 3.0

    // The bloom, corona and 1.5pt specular rim only resolve once there are enough
    // pixels to carry them. The smallest sizes keep the bare optical split, which is
    // what makes the 16x16 icon legible in a Dock or Finder list.
    let hasAtmosphere = pixelSize >= 64
    let hasFineDetail = pixelSize >= 128

    // An 18%-white hairline averages away to nothing once it is one pixel wide, so
    // the submerged half leans on its outline instead: the same rim arc is drawn
    // heavier below 128px and the eclipse silhouette survives the downscale.
    let rimArcAlpha: CGFloat = hasFineDetail ? 0.18 : 0.46

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

    // 3. Obsidian canvas: night ink -> day ink -> night ink. Vast negative space,
    //    the only "background" the mark allows itself.
    if let canvas = CGGradient(
        colorsSpace: colorSpace,
        colors: [
            srgb(7, 10, 17, 1.0),   // #070a11 night ink
            srgb(13, 17, 23, 1.0),  // #0d1117 day ink
            srgb(9, 12, 20, 1.0)    // #090c14 back to night
        ] as CFArray,
        locations: [0.0, 0.52, 1.0]
    ) {
        ctx.drawLinearGradient(
            canvas,
            start: CGPoint(x: center.x, y: bodyRect.maxY),
            end: CGPoint(x: center.x, y: bodyRect.minY),
            options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
        )
    }

    // 4. Atmospheric whisper: one restrained dusk-to-dawn bloom behind the orb.
    //    Warm where the sun is, a cold blue rim where the night is.
    if hasAtmosphere, let whisper = CGGradient(
        colorsSpace: colorSpace,
        colors: [
            srgb(255, 146, 80, 0.22),   // #ff9250 dusk
            srgb(255, 148, 170, 0.09),  // #ff94aa dawn
            srgb(72, 110, 255, 0.0)     // #486eff night, fully transparent
        ] as CFArray,
        locations: [0.0, 0.42, 1.0]
    ) {
        ctx.drawRadialGradient(
            whisper,
            startCenter: center,
            startRadius: 0,
            endCenter: center,
            endRadius: 360,
            options: []
        )
    }

    // 5. Outer corona: the light the solar hemisphere spills past its own edge.
    //    Drawn under the orb, so only the halo outside the disc survives.
    if hasAtmosphere, let corona = CGGradient(
        colorsSpace: colorSpace,
        colors: [
            srgb(255, 158, 92, 0.30),
            srgb(255, 146, 80, 0.10),
            srgb(255, 146, 80, 0.0)
        ] as CFArray,
        locations: [0.0, 0.55, 1.0]
    ) {
        ctx.drawRadialGradient(
            corona,
            startCenter: center,
            startRadius: orbRadius * 0.84,
            endCenter: center,
            endRadius: orbRadius * 1.60,
            options: []
        )
    }

    // 6. Upper solar hemisphere: warm ivory at the apex melting to amber at the
    //    horizon, clipped to the half of the disc that sits above the split.
    ctx.saveGState()
    ctx.clip(to: upperHalf)
    ctx.addPath(orbPath)
    ctx.clip()
    if let solar = CGGradient(
        colorsSpace: colorSpace,
        colors: [
            srgb(255, 252, 245, 1.0),  // #fffcf5 ivory
            srgb(255, 213, 153, 1.0),  // #ffd599 amber light
            srgb(255, 146, 80, 1.0)    // #ff9250 ember at the horizon
        ] as CFArray,
        locations: [0.0, 0.58, 1.0]
    ) {
        ctx.drawLinearGradient(
            solar,
            start: CGPoint(x: center.x, y: center.y + orbRadius),
            end: CGPoint(x: center.x, y: center.y),
            options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
        )
    }
    ctx.restoreGState()

    // 6b. 1.5pt specular rim inside the dome: the sun catching its own edge,
    //     brightest at the apex and dissolving as it reaches the horizon.
    if hasFineDetail {
        let solarRim = CGMutablePath()
        solarRim.addArc(
            center: center,
            radius: orbRadius - 0.75,
            startAngle: 0,
            endAngle: .pi,
            clockwise: false
        )
        strokeGradient(
            ctx,
            path: solarRim,
            lineWidth: 1.5,
            colorSpace: colorSpace,
            colors: [
                srgb(255, 255, 255, 0.08),
                srgb(255, 255, 255, 0.62)
            ],
            locations: [0.0, 1.0],
            from: CGPoint(x: center.x, y: center.y),
            to: CGPoint(x: center.x, y: center.y + orbRadius)
        )
    }

    // 7. Lower eclipse hemisphere: submerged nocturnal glass, darker the deeper it
    //    sinks, with a diffused vertical reflection still bleeding off the horizon.
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
    if hasFineDetail, let reflection = CGGradient(
        colorsSpace: colorSpace,
        colors: [
            srgb(240, 246, 252, 0.10),
            srgb(240, 246, 252, 0.0)
        ] as CFArray,
        locations: [0.0, 1.0]
    ) {
        ctx.drawLinearGradient(
            reflection,
            start: CGPoint(x: center.x, y: center.y),
            end: CGPoint(x: center.x, y: center.y - orbRadius * 0.78),
            options: []
        )
    }
    ctx.restoreGState()

    // 8. Eclipse rim arc: a crisp 2.5pt light on the submerged half, brightest where
    //    it meets the horizon and fading as it falls toward the bottom pole.
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
            srgb(240, 246, 252, rimArcAlpha * 0.12)
        ],
        locations: [0.0, 1.0],
        from: CGPoint(x: center.x, y: center.y),
        to: CGPoint(x: center.x, y: center.y - orbRadius)
    )
    ctx.restoreGState()

    // 9. Razor horizon line: 824pt of light splitting day from night. Bright across
    //    the orb, dissolving into the canvas at both ends so it never looks like a
    //    ruler laid over the icon.
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
        locations: [0.0, 0.24, 0.76, 1.0],
        from: CGPoint(x: bodyRect.minX, y: center.y),
        to: CGPoint(x: bodyRect.maxX, y: center.y)
    )

    // 10. Squircle rim light: a top-lit specular border, 22% white at the top edge
    //     falling to 4% at the bottom — the standard macOS icon lighting cue.
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

