using System.Drawing.Text;
using System.Text;

namespace DynaWall;

/// <summary>
/// The typefaces this host can offer: everything Windows has installed, plus the
/// files the user imported through "Add font…".
///
/// This mirrors <c>WallpaperFont</c> in the macOS host so both desktops speak the
/// same language to the page: a family name is what <c>--font-sans</c> is set to, an
/// imported file is handed over as a <c>data:</c> URL for the page's <c>FontFace</c>
/// loader, and the bytes stay in <c>%LOCALAPPDATA%\DynaWall\Fonts</c> rather than in
/// <c>settings.json</c>.
/// </summary>
internal static class FontLibrary
{
    /// <summary>Extensions "Add font…" accepts.</summary>
    internal static readonly string[] SupportedExtensions = { ".ttf", ".otf", ".ttc", ".woff", ".woff2" };

    /// <summary>
    /// Largest imported file handed to the page (base64 adds ~33%). The same cap as
    /// the macOS host, so a file that works there works here.
    /// </summary>
    internal const int MaxImportedBytes = 4 * 1024 * 1024;

    private static readonly object Gate = new();

    private static string[] cachedFamilies = Array.Empty<string>();
    private static DateTime cachedFamiliesAt = DateTime.MinValue;

    /// <summary>
    /// Long enough to keep typing cheap, short enough that a font installed while
    /// DynaWall is running shows up without a restart.
    /// </summary>
    private static readonly TimeSpan FamiliesCacheLifetime = TimeSpan.FromSeconds(30);

    private static string cachedSourcePath = string.Empty;
    private static long cachedSourceLength = -1;
    private static DateTime cachedSourceWriteTime = DateTime.MinValue;
    private static string cachedSourceValue = string.Empty;

    /// <summary>Every installed family, alphabetical.</summary>
    internal static string[] InstalledFamilies()
    {
        lock (Gate)
        {
            if (cachedFamilies.Length > 0 && DateTime.UtcNow - cachedFamiliesAt < FamiliesCacheLifetime)
            {
                return cachedFamilies;
            }
        }

        var families = new List<string>();
        try
        {
            // GDI+ lists the same families the Fonts control panel shows, including
            // ones the user installed after DynaWall started.
            using var collection = new InstalledFontCollection();
            foreach (var family in collection.Families)
            {
                var name = family.Name;
                // "@" names are the vertical variants of CJK families; a greeting
                // set in one would stack its glyphs sideways.
                if (string.IsNullOrWhiteSpace(name) || name.StartsWith('@')) continue;
                families.Add(name);
            }
        }
        catch (Exception ex)
        {
            Log.Write($"installed fonts could not be listed: {ex.Message}");
        }

        families.Sort((left, right) => string.Compare(left, right, StringComparison.OrdinalIgnoreCase));

        lock (Gate)
        {
            cachedFamilies = families.ToArray();
            cachedFamiliesAt = DateTime.UtcNow;
            return cachedFamilies;
        }
    }

    internal static bool IsSupported(string? path)
    {
        var extension = Path.GetExtension((path ?? string.Empty).Trim()).ToLowerInvariant();
        return SupportedExtensions.Contains(extension);
    }

    /// <summary>
    /// Copy <paramref name="sourcePath"/> into <c>%LOCALAPPDATA%\DynaWall\Fonts</c>
    /// and return the new location, or <c>null</c> when the file cannot be used.
    ///
    /// The copy carries a short unique suffix, so re-importing a file the user has
    /// since replaced on disk is a *new* path: the page then reads the new bytes
    /// instead of a cached face. Older copies of the same stem are deleted, so the
    /// folder holds one file per family rather than one per try.
    /// </summary>
    internal static string? Import(string? sourcePath)
    {
        var source = (sourcePath ?? string.Empty).Trim();
        if (!File.Exists(source) || !IsSupported(source)) return null;

        try
        {
            var info = new FileInfo(source);
            if (info.Length == 0 || info.Length > MaxImportedBytes)
            {
                Log.Write($"{info.Name} is {info.Length} bytes; the import cap is {MaxImportedBytes}");
                return null;
            }

            var directory = AppPaths.FontDirectory;
            Directory.CreateDirectory(directory);

            var extension = info.Extension.ToLowerInvariant();
            var stem = Path.GetFileNameWithoutExtension(info.Name);
            var suffix = Guid.NewGuid().ToString("N")[..8];
            var destination = Path.Combine(directory, $"{stem}-{suffix}{extension}");

            foreach (var file in Directory.EnumerateFiles(directory))
            {
                var name = Path.GetFileNameWithoutExtension(file);
                if (name.StartsWith(stem + "-", StringComparison.OrdinalIgnoreCase) &&
                    string.Equals(Path.GetExtension(file), extension, StringComparison.OrdinalIgnoreCase))
                {
                    try
                    {
                        File.Delete(file);
                    }
                    catch (Exception ex)
                    {
                        // A face the page still holds open: harmless, because the new
                        // copy has its own name.
                        Log.Write($"old font copy {Path.GetFileName(file)} was left behind: {ex.Message}");
                    }
                }
            }

            File.Copy(source, destination, overwrite: true);
            return destination;
        }
        catch (Exception ex)
        {
            Log.Write($"font {Path.GetFileName(source)} could not be imported: {ex.Message}");
            return null;
        }
    }

    /// <summary>
    /// The family name inside a font file, so the settings window and the page agree
    /// on what the imported face is called. GDI+ cannot parse WOFF/WOFF2, so those
    /// fall back to a cleaned file name (<c>Inter-Regular.woff2</c> → <c>Inter
    /// Regular</c>), which is also the name the page registers the face under.
    /// </summary>
    internal static string FamilyName(string? path, string fallback)
    {
        var file = (path ?? string.Empty).Trim();
        if (file.Length > 0 && File.Exists(file))
        {
            try
            {
                using var collection = new PrivateFontCollection();
                collection.AddFontFile(file);
                foreach (var family in collection.Families)
                {
                    if (!string.IsNullOrWhiteSpace(family.Name)) return family.Name;
                }
            }
            catch (Exception ex)
            {
                Log.Write($"{Path.GetFileName(file)} could not be read as a face: {ex.Message}");
            }
        }

        var stem = Path.GetFileNameWithoutExtension((fallback ?? string.Empty).Trim());
        return Preferences.NormalizeFontFamily(stem.Replace('-', ' '));
    }

    /// <summary>
    /// A font file as a <c>data:</c> URL the page can hand straight to
    /// <c>FontFace</c>. Read once per file version: settings are pushed on every
    /// keystroke, and re-reading a 4 MB file each time would stall the UI thread.
    /// </summary>
    internal static string DataUrl(string? path)
    {
        var file = (path ?? string.Empty).Trim();
        if (file.Length == 0) return string.Empty;

        FileInfo info;
        try
        {
            info = new FileInfo(file);
            if (!info.Exists || info.Length == 0 || info.Length > MaxImportedBytes) return string.Empty;
        }
        catch (Exception ex)
        {
            Log.Write($"imported font could not be inspected: {ex.Message}");
            return string.Empty;
        }

        lock (Gate)
        {
            if (string.Equals(cachedSourcePath, file, StringComparison.OrdinalIgnoreCase) &&
                cachedSourceLength == info.Length &&
                cachedSourceWriteTime == info.LastWriteTimeUtc)
            {
                return cachedSourceValue;
            }
        }

        try
        {
            var bytes = File.ReadAllBytes(file);
            var source = new StringBuilder((bytes.Length * 4 / 3) + 32)
                .Append("data:")
                .Append(MimeType(file))
                .Append(";base64,")
                .Append(Convert.ToBase64String(bytes))
                .ToString();

            lock (Gate)
            {
                cachedSourcePath = file;
                cachedSourceLength = bytes.Length;
                cachedSourceWriteTime = info.LastWriteTimeUtc;
                cachedSourceValue = source;
            }

            return source;
        }
        catch (Exception ex)
        {
            Log.Write($"{Path.GetFileName(file)} could not be read: {ex.Message}");
            return string.Empty;
        }
    }

    private static string MimeType(string path)
    {
        return Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".otf" => "font/otf",
            ".woff" => "font/woff",
            ".woff2" => "font/woff2",
            ".ttc" => "font/collection",
            _ => "font/ttf"
        };
    }
}
