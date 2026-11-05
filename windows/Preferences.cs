using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace DynaWall;

/// <summary>
/// The Windows host's settings, stored as JSON in
/// <c>%LOCALAPPDATA%\DynaWall\settings.json</c>.
///
/// The field names and accepted values deliberately match <c>script.js</c> and the
/// macOS host: <c>theme</c> is one of auto/dawn/day/dusk/night/custom, the interval
/// is minutes, and photos in a custom folder are classified by filename exactly like
/// the bundled ones. <c>photos</c> is never persisted — the folder is re-scanned on
/// every launch, the same way the macOS app resolves its library each time.
/// </summary>
internal sealed class Preferences
{
    internal const string DefaultSubtitle = "What are we building today?";
    internal const string DefaultColor = "#0d1117";
    internal const int DefaultIntervalMinutes = 15;
    internal const int MinIntervalMinutes = 1;
    internal const int MaxIntervalMinutes = 120;

    /// <summary>Keep in sync with DEFAULT_FONT_FAMILY in script.js.</summary>
    internal const string DefaultFontFamily = "Outfit";

    /// <summary>Keep in sync with MAX_FONT_FAMILY_LENGTH in script.js.</summary>
    internal const int MaxFontFamilyLength = 80;

    /// <summary>
    /// The families that ship in <c>web/assets/fonts</c> (one @font-face each), so
    /// they render on every host with no install and no download. Everything else is
    /// a system font or an imported file.
    /// Keep in sync with BUNDLED_FONT_FAMILIES in script.js and
    /// WallpaperFont.bundledFamilies in the macOS host.
    /// </summary>
    internal static readonly string[] BundledFontFamilies =
        { "Outfit", "Google Sans Flex", "Space Grotesk", "Geist" };

    /// <summary>Keep in sync with THEME_MODES in script.js.</summary>
    internal static readonly string[] ThemeModes = { "auto", "dawn", "day", "dusk", "night", "custom" };

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = true
    };

    public string FirstName { get; set; } = DefaultFirstName;
    public string Subtitle { get; set; } = DefaultSubtitle;
    public string Theme { get; set; } = "auto";
    public string BgColor { get; set; } = DefaultColor;
    public bool Slideshow { get; set; }
    public int SlideshowInterval { get; set; } = DefaultIntervalMinutes;
    public bool SlideshowShuffle { get; set; } = true;
    public bool KenBurns { get; set; } = true;
    public bool PhotoSync { get; set; } = true;

    /// <summary>
    /// Whether the apps orbit — the <c>+</c> satellite and every app the user added — is
    /// on the wallpaper. On by default; off removes it in the page, stops it drifting and
    /// leaves no click rectangles behind, so the desktop is the Finder's/Explorer's again.
    /// The apps themselves are not settings: they are added, launched and forgotten on the
    /// wallpaper, through the card the <c>+</c> opens.
    /// </summary>
    public bool Widgets { get; set; } = true;

    /// <summary>Empty means the twelve wallpapers that ship in <c>web/images</c>.</summary>
    public string PhotoFolder { get; set; } = string.Empty;

    /// <summary>
    /// The family the greeting and subtitle are set in. <c>Outfit</c> is the vendored
    /// default; any family installed in Windows works, and an imported file is
    /// addressed by the name resolved when it was added.
    /// </summary>
    public string FontFamily { get; set; } = DefaultFontFamily;

    /// <summary>
    /// Absolute path of a font file imported with "Add font…" (empty = none).
    ///
    /// The file lives under <c>%LOCALAPPDATA%\DynaWall\Fonts</c>, so the wallpaper
    /// keeps its typeface after the download is moved or deleted.
    /// </summary>
    public string CustomFontPath { get; set; } = string.Empty;

    /// <summary>
    /// The imported file as a <c>data:</c> URL, or empty when nothing is imported.
    /// Never serialised: the bytes are re-read from disk on every launch instead of
    /// living in <c>settings.json</c>.
    /// </summary>
    [JsonIgnore]
    internal string CustomFontSource => FontLibrary.DataUrl(CustomFontPath);

    /// <summary>
    /// The logged-in Windows account's first name, normalised the same way
    /// <c>normalizeName()</c> cleans a name (`froilan.banaticla` → `Froilan`).
    /// </summary>
    internal static string DefaultFirstName
    {
        get
        {
            var raw = Environment.UserName;
            if (string.IsNullOrWhiteSpace(raw)) return FallbackName;

            var token = raw.Split(new[] { '.', '_', '-', ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries)
                .FirstOrDefault() ?? string.Empty;
            token = new string(token.Where(char.IsLetter).ToArray());
            if (token.Length == 0) return FallbackName;

            var lowered = token.ToLowerInvariant();
            return CultureInfo.InvariantCulture.TextInfo.ToTitleCase(lowered);
        }
    }

    private const string FallbackName = "Developer";

    internal static Preferences Load()
    {
        try
        {
            if (!File.Exists(AppPaths.PreferencesFile)) return new Preferences();

            var json = File.ReadAllText(AppPaths.PreferencesFile);
            var loaded = JsonSerializer.Deserialize<Preferences>(json, JsonOptions);
            if (loaded is null) return new Preferences();

            loaded.Normalize();
            return loaded;
        }
        catch (Exception ex)
        {
            Log.Write($"settings could not be read, using defaults: {ex.Message}");
            return new Preferences();
        }
    }

    internal void Save()
    {
        try
        {
            AppPaths.EnsureDataDirectory();
            var temp = AppPaths.PreferencesFile + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(this, JsonOptions));
            File.Move(temp, AppPaths.PreferencesFile, overwrite: true);
        }
        catch (Exception ex)
        {
            Log.Write($"settings could not be saved: {ex.Message}");
        }
    }

    /// <summary>Clamp hand-edited JSON into the values the page accepts.</summary>
    internal void Normalize()
    {
        FirstName = NormalizeName(FirstName);
        Subtitle = Subtitle is null ? DefaultSubtitle : Subtitle.Trim();
        var theme = (Theme ?? string.Empty).Trim().ToLowerInvariant();
        Theme = ThemeModes.Contains(theme) ? theme : "auto";
        BgColor = NormalizeColor(BgColor);
        SlideshowInterval = Math.Clamp(SlideshowInterval, MinIntervalMinutes, MaxIntervalMinutes);
        PhotoFolder = (PhotoFolder ?? string.Empty).Trim();
        FontFamily = NormalizeFontFamily(FontFamily);
        CustomFontPath = (CustomFontPath ?? string.Empty).Trim();
    }

    /// <summary>Restore the shipped look, keeping the folder the user picked.</summary>
    internal void ResetToDefaults()
    {
        FirstName = DefaultFirstName;
        Subtitle = DefaultSubtitle;
        Theme = "auto";
        BgColor = DefaultColor;
        Slideshow = false;
        SlideshowInterval = DefaultIntervalMinutes;
        SlideshowShuffle = true;
        KenBurns = true;
        PhotoSync = true;
        Widgets = true;
        FontFamily = DefaultFontFamily;
        CustomFontPath = string.Empty;
    }

    internal static string NormalizeName(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return DefaultFirstName;

        // First word only, the same rule the macOS host applies to a full name.
        var words = raw.Trim().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        var name = words.FirstOrDefault() ?? string.Empty;
        name = new string(name.Where(ch => char.IsLetter(ch) || ch == '\'' || ch == '-').ToArray());
        return name.Length == 0 ? DefaultFirstName : name;
    }

    internal static string NormalizeFontFamily(string? raw)
    {
        if (string.IsNullOrEmpty(raw)) return DefaultFontFamily;

        // Mirrors normalizeFontFamily() in script.js: quotes, backslashes, braces,
        // semicolons and angle brackets are what could break out of the quoted CSS
        // family name, so they never reach the page. Whitespace is collapsed, and a
        // value that cleans away or is absurdly long falls back to the vendored face.
        var builder = new StringBuilder(raw.Length);
        foreach (var ch in raw)
        {
            if (char.IsControl(ch))
            {
                builder.Append(' ');
                continue;
            }

            if (ch is '"' or '\'' or '\\' or ';' or '{' or '}' or '<' or '>') continue;
            builder.Append(ch);
        }

        var cleaned = string.Join(
            ' ',
            builder.ToString().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));

        if (cleaned.Length == 0 || cleaned.Length > MaxFontFamilyLength) return DefaultFontFamily;
        return cleaned;
    }

    /// <summary>Whether <paramref name="family"/> is one of the bundled faces.</summary>
    internal static bool IsBundledFontFamily(string? family) =>
        BundledFontFamilies.Any(
            name => string.Equals(name, family, StringComparison.OrdinalIgnoreCase));

    internal static string NormalizeColor(string? raw)
    {
        var value = (raw ?? string.Empty).Trim();
        if (value.Length == 0) return DefaultColor;
        if (!value.StartsWith('#')) value = "#" + value;
        if (value.Length != 7) return DefaultColor;

        for (var index = 1; index < value.Length; index += 1)
        {
            if (!Uri.IsHexDigit(value[index])) return DefaultColor;
        }

        return value.ToLowerInvariant();
    }

    /// <summary>
    /// Full settings payload expressed as calls into the shared web wallpaper API —
    /// the exact bridge Lively Wallpaper and the macOS host use, so all hosts share
    /// one configuration code path in <c>script.js</c>.
    /// </summary>
    internal string BuildSettingsScript()
    {
        var values = new List<(string Name, object Value)>
        {
            ("firstName", FirstName),
            // script.js accepts Lively's control id for the subtitle.
            ("subtitleText", Subtitle)
        };

        // Only a hand-picked colour is pushed: script.js pins `custom` when a colour
        // arrives on its own, so sending one for auto/dawn/day/dusk/night would fight
        // the palette the host is asking for.
        if (Theme == "custom") values.Add(("bgColor", BgColor));

        values.Add(("theme", Theme));
        values.Add(("slideshow", Slideshow));
        values.Add(("photoSync", PhotoSync));
        values.Add(("slideshowInterval", SlideshowInterval));
        values.Add(("slideshowShuffle", SlideshowShuffle));
        values.Add(("kenBurns", KenBurns));
        // The apps orbit: one switch, a plain boolean that script.js honours live.
        values.Add(("widgets", Widgets));
        // The family only; the imported bytes ride in their own push (BuildFontScript),
        // because a data URL of a few megabytes has no business in a settings payload
        // that is re-sent on every keystroke.
        values.Add(("fontFamily", FontFamily));

        var script = new StringBuilder();
        script.AppendLine("(function () {");
        script.AppendLine("  if (typeof window.livelyPropertyListener !== \"function\") { return false; }");
        foreach (var (name, value) in values)
        {
            script.Append("  window.livelyPropertyListener(")
                .Append(JsonSerializer.Serialize(name))
                .Append(", ")
                .Append(JsonSerializer.Serialize(value))
                .AppendLine(");");
        }
        script.AppendLine("  return true;");
        script.AppendLine("})();");
        return script.ToString();
    }

    /// <summary>
    /// The photo list, pushed through the same bridge Lively uses. An empty list is
    /// still sent: switching from a custom folder back to the bundled wallpapers has
    /// to reach the page, otherwise the old folder stays on the desktop.
    /// </summary>
    internal static string BuildPhotosScript(IReadOnlyList<string> urls)
    {
        return string.Join(
            "\n",
            "(function () {",
            "  if (typeof window.livelyPropertyListener !== \"function\") { return false; }",
            $"  window.livelyPropertyListener(\"photos\", {JsonSerializer.Serialize(urls)});",
            "  return true;",
            "})();");
    }

    /// <summary>
    /// The imported font file, as a <c>data:</c> URL, through the same bridge. Sent
    /// separately from the settings: the payload is the user's font (up to 4 MB of
    /// base64) and only changes when they import something new. An empty string is a
    /// real value — it removes the previously loaded face.
    /// </summary>
    internal static string BuildFontScript(string source)
    {
        return string.Join(
            "\n",
            "(function () {",
            "  if (typeof window.livelyPropertyListener !== \"function\") { return false; }",
            $"  window.livelyPropertyListener(\"customFont\", {JsonSerializer.Serialize(source)});",
            "  return true;",
            "})();");
    }

    internal static string BuildSuspendScript(bool suspended)
    {
        return $"(function () {{ if (typeof window.livelyPropertyListener !== \"function\") {{ return false; }} " +
               $"window.livelyPropertyListener(\"suspend\", {(suspended ? "true" : "false")}); return true; }})();";
    }

    internal static string BuildNextPhotoScript()
    {
        return "(function () { if (typeof window.livelyPropertyListener !== \"function\") { return false; } " +
               "window.livelyPropertyListener(\"nextPhoto\", true); return true; })();";
    }

    /// <summary>
    /// The at-document-start snapshot (<c>window.__dynawallSeed</c>) that lets the
    /// very first frame paint the user's name, palette and photo instead of the
    /// built-in copy. <c>script.js</c> normalises it exactly like a live IPC value.
    /// </summary>
    internal string BuildSeedScript(IReadOnlyList<string> photos)
    {
        var seed = new Dictionary<string, object?>
        {
            ["firstName"] = FirstName,
            ["subtitle"] = Subtitle,
            ["theme"] = Theme,
            ["slideshow"] = Slideshow,
            ["photoSync"] = PhotoSync,
            ["slideshowInterval"] = SlideshowInterval,
            ["slideshowShuffle"] = SlideshowShuffle,
            ["kenBurns"] = KenBurns,
            ["widgets"] = Widgets,
            // The family only: the imported bytes are pushed once the page is ready.
            ["fontFamily"] = FontFamily
        };

        // Same rule as the live push: the colour rides along only when it is the
        // palette in use, never beside a clock or pinned band.
        if (Theme == "custom") seed["bgColor"] = BgColor;

        if (photos.Count > 0) seed["photos"] = photos;

        return $"window.__dynawallSeed = {JsonSerializer.Serialize(seed)};";
    }
}
