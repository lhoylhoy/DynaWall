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

/// Renders the DynaWall icon at `pixelSize x pixelSize`.
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

    // 1. Outer ambient drop shadow (for sizes >= 32)
    if pixelSize >= 32 {
        ctx.saveGState()
        ctx.setShadow(
            offset: CGSize(width: 0, height: -18),
            blur: 38,
            color: srgb(4, 7, 15, 0.58)
        )
        ctx.setFillColor(srgb(13, 17, 23, 1.0))
        ctx.addPath(bodyPath)
        ctx.fillPath()
        ctx.restoreGState()
    }

    // 2. Clip to the squircle body
    ctx.saveGState()
    ctx.addPath(bodyPath)
    ctx.clip()

    // 3. Sky gradient: Deep Night zenith -> Dawn violet -> Dusk crimson -> Warm amber horizon
    let skyColors: [CGColor] = [
        srgb(7, 10, 19, 1.0),     // Deep night zenith (#070a13)
        srgb(16, 18, 38, 1.0),    // Midnight indigo
        srgb(35, 27, 66, 1.0),    // Dawn violet (#231b42)
        srgb(88, 42, 78, 1.0),    // Twilight plum
        srgb(176, 68, 66, 1.0),   // Dusk rose-coral
        srgb(238, 132, 74, 1.0),  // Golden hour amber
        srgb(252, 198, 118, 1.0)  // Horizon glow
    ]
    let skyLocations: [CGFloat] = [0.0, 0.22, 0.44, 0.62, 0.77, 0.90, 1.0]
    if let skyGradient = CGGradient(
        colorsSpace: colorSpace,
        colors: skyColors as CFArray,
        locations: skyLocations
    ) {
        ctx.drawLinearGradient(
            skyGradient,
            start: CGPoint(x: 512, y: 924),
            end: CGPoint(x: 512, y: 210),
            options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
        )
    }

    // 4. Radial celestial aurora / atmospheric bloom near the horizon center
    let bloomCenter = CGPoint(x: 512, y: 380)
    if let bloomGrad = CGGradient(
        colorsSpace: colorSpace,
        colors: [
            srgb(255, 224, 155, 0.72),
            srgb(255, 148, 92, 0.34),
            srgb(130, 72, 150, 0.10),
            srgb(13, 17, 23, 0.0)
        ] as CFArray,
        locations: [0.0, 0.32, 0.68, 1.0]
    ) {
        ctx.drawRadialGradient(
            bloomGrad,
            startCenter: bloomCenter,
            startRadius: 10,
            endCenter: bloomCenter,
            endRadius: 430,
            options: [.drawsAfterEndLocation]
        )
    }

    // 5. Subtle starfield in upper sky
    let stars: [(x: CGFloat, y: CGFloat, r: CGFloat, a: CGFloat)] = [
        (235, 805, 3.2, 0.75),
        (320, 845, 2.2, 0.45),
        (420, 790, 2.6, 0.55),
        (615, 835, 3.5, 0.80),
        (715, 785, 2.4, 0.50),
        (790, 825, 2.8, 0.65),
        (268, 728, 2.0, 0.38),
        (755, 720, 2.2, 0.42),
        (512, 860, 2.5, 0.50)
    ]
    for star in stars {
        ctx.setFillColor(srgb(240, 246, 252, star.a))
        ctx.fillEllipse(in: CGRect(x: star.x - star.r, y: star.y - star.r, width: star.r * 2, height: star.r * 2))
    }

    // Four-point sparkle star in upper right sky
    func drawSparkle(cx: CGFloat, cy: CGFloat, arm: CGFloat, alpha: CGFloat) {
        ctx.saveGState()
        let path = CGMutablePath()
        let waist = arm * 0.16
        path.move(to: CGPoint(x: cx, y: cy + arm))
        path.addQuadCurve(to: CGPoint(x: cx + arm, y: cy), control: CGPoint(x: cx + waist, y: cy + waist))
        path.addQuadCurve(to: CGPoint(x: cx, y: cy - arm), control: CGPoint(x: cx + waist, y: cy - waist))
        path.addQuadCurve(to: CGPoint(x: cx - arm, y: cy), control: CGPoint(x: cx - waist, y: cy - waist))
        path.addQuadCurve(to: CGPoint(x: cx, y: cy + arm), control: CGPoint(x: cx - waist, y: cy + waist))
        path.closeSubpath()
        ctx.setFillColor(srgb(255, 248, 235, alpha))
        ctx.addPath(path)
        ctx.fillPath()
        ctx.restoreGState()
    }
    drawSparkle(cx: 660, cy: 790, arm: 16, alpha: 0.88)
    drawSparkle(cx: 295, cy: 775, arm: 11, alpha: 0.68)

    // 6. Glowing Sun Orb perched above the mountain horizon
    let sunCenter = CGPoint(x: 512, y: 418)
    let sunRadius: CGFloat = 112.0

    // Outer sun halo
    if let haloGrad = CGGradient(
        colorsSpace: colorSpace,
        colors: [
            srgb(255, 242, 200, 0.65),
            srgb(255, 178, 102, 0.25),
            srgb(255, 140, 82, 0.0)
        ] as CFArray,
        locations: [0.0, 0.45, 1.0]
    ) {
        ctx.drawRadialGradient(
            haloGrad,
            startCenter: sunCenter,
            startRadius: sunRadius * 0.7,
            endCenter: sunCenter,
            endRadius: sunRadius * 1.95,
            options: []
        )
    }

    // Crisp sun disc with vertical warm gradient
    ctx.saveGState()
    let sunRect = CGRect(
        x: sunCenter.x - sunRadius,
        y: sunCenter.y - sunRadius,
        width: sunRadius * 2,
        height: sunRadius * 2
    )
    ctx.addEllipse(in: sunRect)
    ctx.clip()
    if let sunDiscGrad = CGGradient(
        colorsSpace: colorSpace,
        colors: [
            srgb(255, 252, 238, 1.0),
            srgb(255, 219, 148, 1.0),
            srgb(250, 148, 86, 1.0)
        ] as CFArray,
        locations: [0.0, 0.55, 1.0]
    ) {
        ctx.drawLinearGradient(
            sunDiscGrad,
            start: CGPoint(x: 512, y: sunCenter.y + sunRadius),
            end: CGPoint(x: 512, y: sunCenter.y - sunRadius),
            options: []
        )
    }
    ctx.restoreGState()

    // 7. Layered Distant & Foreground Mountain Ridges (evoking macOS dynamic landscapes)
    // Back ridge (misty plum-indigo)
    let backRidge = CGMutablePath()
    backRidge.move(to: CGPoint(x: 100, y: 100))
    backRidge.addLine(to: CGPoint(x: 100, y: 350))
    backRidge.addCurve(
        to: CGPoint(x: 355, y: 415),
        control1: CGPoint(x: 185, y: 355),
        control2: CGPoint(x: 270, y: 430)
    )
    backRidge.addCurve(
        to: CGPoint(x: 615, y: 345),
        control1: CGPoint(x: 435, y: 400),
        control2: CGPoint(x: 520, y: 330)
    )
    backRidge.addCurve(
        to: CGPoint(x: 924, y: 405),
        control1: CGPoint(x: 715, y: 360),
        control2: CGPoint(x: 825, y: 420)
    )
    backRidge.addLine(to: CGPoint(x: 924, y: 100))
    backRidge.closeSubpath()

    ctx.saveGState()
    ctx.addPath(backRidge)
    ctx.clip()
    if let backRidgeGrad = CGGradient(
        colorsSpace: colorSpace,
        colors: [
            srgb(52, 33, 68, 0.96),
            srgb(24, 21, 44, 1.0)
        ] as CFArray,
        locations: [0.0, 1.0]
    ) {
        ctx.drawLinearGradient(
            backRidgeGrad,
            start: CGPoint(x: 512, y: 425),
            end: CGPoint(x: 512, y: 180),
            options: []
        )
    }
    ctx.restoreGState()

    // Mid ridge (deep slate-violet)
    let midRidge = CGMutablePath()
    midRidge.move(to: CGPoint(x: 100, y: 100))
    midRidge.addLine(to: CGPoint(x: 100, y: 300))
    midRidge.addCurve(
        to: CGPoint(x: 410, y: 315),
        control1: CGPoint(x: 210, y: 340),
        control2: CGPoint(x: 310, y: 285)
    )
    midRidge.addCurve(
        to: CGPoint(x: 720, y: 372),
        control1: CGPoint(x: 520, y: 348),
        control2: CGPoint(x: 630, y: 392)
    )
    midRidge.addCurve(
        to: CGPoint(x: 924, y: 295),
        control1: CGPoint(x: 800, y: 355),
        control2: CGPoint(x: 865, y: 315)
    )
    midRidge.addLine(to: CGPoint(x: 924, y: 100))
    midRidge.closeSubpath()

    ctx.saveGState()
    ctx.addPath(midRidge)
    ctx.clip()
    if let midRidgeGrad = CGGradient(
        colorsSpace: colorSpace,
        colors: [
            srgb(26, 28, 48, 0.98),
            srgb(13, 17, 26, 1.0)
        ] as CFArray,
        locations: [0.0, 1.0]
    ) {
        ctx.drawLinearGradient(
            midRidgeGrad,
            start: CGPoint(x: 512, y: 380),
            end: CGPoint(x: 512, y: 120),
            options: []
        )
    }
    ctx.restoreGState()

    // Foreground ridge (DynaWall signature #0d1117 -> #070a11 dark developer slate)
    let frontRidge = CGMutablePath()
    frontRidge.move(to: CGPoint(x: 100, y: 100))
    frontRidge.addLine(to: CGPoint(x: 100, y: 248))
    frontRidge.addCurve(
        to: CGPoint(x: 520, y: 252),
        control1: CGPoint(x: 245, y: 292),
        control2: CGPoint(x: 380, y: 222)
    )
    frontRidge.addCurve(
        to: CGPoint(x: 924, y: 258),
        control1: CGPoint(x: 660, y: 282),
        control2: CGPoint(x: 805, y: 235)
    )
    frontRidge.addLine(to: CGPoint(x: 924, y: 100))
    frontRidge.closeSubpath()

    ctx.saveGState()
    ctx.addPath(frontRidge)
    ctx.clip()
    if let frontGrad = CGGradient(
        colorsSpace: colorSpace,
        colors: [
            srgb(15, 20, 30, 1.0),
            srgb(8, 11, 18, 1.0)
        ] as CFArray,
        locations: [0.0, 1.0]
    ) {
        ctx.drawLinearGradient(
            frontGrad,
            start: CGPoint(x: 512, y: 285),
            end: CGPoint(x: 512, y: 100),
            options: []
        )
    }
    ctx.restoreGState()

    // 8. Signature DynaWall Greeting Card / Glassmorphic Pill at the center
    //    Represents the minimal greeting typography floating on the desktop
    let cardRect = CGRect(x: 232, y: 548, width: 560, height: 168)
    let cardPath = CGPath(roundedRect: cardRect, cornerWidth: 42, cornerHeight: 42, transform: nil)

    // Soft shadow under the glass card
    ctx.saveGState()
    ctx.setShadow(offset: CGSize(width: 0, height: -10), blur: 24, color: srgb(5, 8, 18, 0.42))
    ctx.setFillColor(srgb(13, 17, 25, 0.56))
    ctx.addPath(cardPath)
    ctx.fillPath()
    ctx.restoreGState()

    // Subtle glass gradient fill
    ctx.saveGState()
    ctx.addPath(cardPath)
    ctx.clip()
    if let glassGrad = CGGradient(
        colorsSpace: colorSpace,
        colors: [
            srgb(255, 255, 255, 0.16),
            srgb(255, 255, 255, 0.05)
        ] as CFArray,
        locations: [0.0, 1.0]
    ) {
        ctx.drawLinearGradient(
            glassGrad,
            start: CGPoint(x: 512, y: cardRect.maxY),
            end: CGPoint(x: 512, y: cardRect.minY),
            options: []
        )
    }
    ctx.restoreGState()

    // Crisp glass border highlight
    ctx.saveGState()
    ctx.addPath(cardPath)
    ctx.setStrokeColor(srgb(240, 246, 252, 0.28))
    ctx.setLineWidth(3.0)
    ctx.strokePath()
    ctx.restoreGState()

    // Minimalist typographic greeting bars inside the glass card:
    // Primary headline pill ("Good morning, Developer.") + warm accent dot
    let titlePill = CGPath(
        roundedRect: CGRect(x: 292, y: 644, width: 396, height: 30),
        cornerWidth: 15,
        cornerHeight: 15,
        transform: nil
    )
    ctx.setFillColor(srgb(240, 246, 252, 0.95))
    ctx.addPath(titlePill)
    ctx.fillPath()

    // Warm sunrise period dot at the end of the greeting line
    ctx.setFillColor(srgb(255, 190, 108, 1.0))
    ctx.fillEllipse(in: CGRect(x: 704, y: 644, width: 30, height: 30))

    // Subtitle pill ("What are we building today?")
    let subtitlePill = CGPath(
        roundedRect: CGRect(x: 362, y: 590, width: 300, height: 18),
        cornerWidth: 9,
        cornerHeight: 9,
        transform: nil
    )
    ctx.setFillColor(srgb(201, 209, 217, 0.62))
    ctx.addPath(subtitlePill)
    ctx.fillPath()

    // 9. Inner specular squircle border (macOS native icon rim light)
    ctx.addPath(bodyPath)
    ctx.setStrokeColor(srgb(255, 255, 255, 0.22))
    ctx.setLineWidth(4.0)
    ctx.strokePath()

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

