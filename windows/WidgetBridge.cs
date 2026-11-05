using System.Diagnostics.CodeAnalysis;
using System.Drawing;
using System.Text.Json;

namespace DynaWall;

/// <summary>
/// The rectangles, in viewport CSS pixels, that a page is willing to take a click in.
///
/// The wallpaper lives in the desktop layer, behind the icon view, so it never receives
/// a pointer event and cannot notice a hover by itself. It reports these rectangles
/// instead, and the host decides which clicks belong to a card.
/// </summary>
internal sealed class WidgetHitArea
{
    /// <summary>No card and nothing to click: the desktop is purely decorative.</summary>
    internal static readonly WidgetHitArea Closed = new(false, Array.Empty<RectangleF>());

    private readonly RectangleF[] regions;

    private WidgetHitArea(bool open, RectangleF[] regions)
    {
        IsOpen = open;
        this.regions = regions;
    }

    /// <summary>
    /// Whether a card is on screen. While one is, the whole viewport is a target: the
    /// backdrop closes the card.
    /// </summary>
    internal bool IsOpen { get; }

    internal bool Contains(float x, float y)
    {
        foreach (var region in regions)
        {
            if (region.Contains(x, y)) return true;
        }

        return false;
    }

    /// <summary>Read the payload of a <c>dynawall:interactivity</c> message.</summary>
    internal static WidgetHitArea? FromJson(JsonElement root)
    {
        if (!root.TryGetProperty("regions", out var list) || list.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        var open = root.TryGetProperty("open", out var flag) && flag.ValueKind == JsonValueKind.True;
        var regions = new List<RectangleF>();

        foreach (var entry in list.EnumerateArray())
        {
            // `[left, top, width, height]`, and nothing else is accepted.
            if (entry.ValueKind != JsonValueKind.Array || entry.GetArrayLength() < 4) continue;
            var values = new float[4];
            var index = 0;
            var wellFormed = true;

            foreach (var value in entry.EnumerateArray())
            {
                if (index >= 4) break;
                if (value.ValueKind != JsonValueKind.Number)
                {
                    wellFormed = false;
                    break;
                }

                values[index++] = (float)value.GetDouble();
            }

            if (!wellFormed || index != 4) continue;
            regions.Add(new RectangleF(values[0], values[1], values[2], values[3]));
        }

        return new WidgetHitArea(open, regions.ToArray());
    }
}

/// <summary>
/// The two messages the page sends about its widgets, read without trusting them.
///
/// WebView2 hands the host one JSON string per <c>chrome.webview.postMessage</c> call,
/// so the kind of message rides along in a <c>type</c> field.
/// </summary>
internal static class WidgetBridge
{
    internal const string InteractivityType = "dynawall:interactivity";
    internal const string OpenUrlType = "dynawall:open-url";

    /// <summary>
    /// Read one message. <paramref name="area"/> is set for an interactivity report and
    /// <paramref name="url"/> for a link the user picked; both stay <c>null</c> for
    /// anything else (a page is free to send other messages).
    /// </summary>
    internal static void Read(string json, out WidgetHitArea? area, out string? url)
    {
        area = null;
        url = null;

        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(json);
        }
        catch (JsonException)
        {
            return;
        }

        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return;
            if (!root.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String) return;

            switch (type.GetString())
            {
                case InteractivityType:
                    area = WidgetHitArea.FromJson(root);
                    break;
                case OpenUrlType:
                    if (root.TryGetProperty("url", out var target) &&
                        target.ValueKind == JsonValueKind.String &&
                        target.GetString() is { } value &&
                        TryNormalizeBrowserUrl(value, out var canonical))
                    {
                        url = canonical;
                    }

                    break;
            }
        }
    }

    /// <summary>
    /// Accept a plain <c>https</c> address and hand back the canonical form of it.
    ///
    /// The page built the string, so the host parses it itself and starts the shell from
    /// <see cref="Uri.AbsoluteUri"/>: the browser receives one RFC 3986 URL — with the
    /// dot segments resolved and every non-ASCII or reserved character escaped — rather
    /// than the raw text, which a quoting bug in a future caller could still split.
    /// </summary>
    internal static bool TryNormalizeBrowserUrl(
        string target,
        [NotNullWhen(true)] out string? canonical)
    {
        canonical = null;

        if (!Uri.TryCreate(target, UriKind.Absolute, out var uri)
            || uri.Scheme != Uri.UriSchemeHttps
            || string.IsNullOrEmpty(uri.Host))
        {
            return false;
        }

        canonical = uri.AbsoluteUri;
        return true;
    }

    /// <summary>
    /// Only a plain <c>https</c> address ever reaches the browser: no <c>file:</c>, no
    /// <c>javascript:</c>, no scheme that would hand a URL to an installed app.
    /// </summary>
    internal static bool IsBrowserUrl(string target) => TryNormalizeBrowserUrl(target, out _);
}
