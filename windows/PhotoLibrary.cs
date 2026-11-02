namespace DynaWall;

/// <summary>
/// Resolves the photo sources handed to the page.
///
/// Bundled mode returns an empty list on purpose: <c>script.js</c> already ships the
/// twelve curated wallpapers as relative <c>images/…</c> URLs, which resolve against
/// <c>https://dynawall.local/</c>. Keeping the list in one place (script.js) means
/// the Windows build cannot drift from the web wallpaper. A custom folder is scanned
/// on demand and served from its own virtual host, so the page stays sandboxed to the
/// files the user actually picked and each URL keeps its filename for time-of-day
/// classification.
/// </summary>
internal sealed class PhotoLibrary
{
    internal const string BundledHost = "dynawall.local";
    internal const string FolderHost = "dynawall-photos.local";
    internal const int MaxPhotos = 500;

    private static readonly HashSet<string> SupportedExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".jpg", ".jpeg", ".png", ".heic", ".webp", ".gif", ".bmp", ".tif", ".tiff"
    };

    private string folder = string.Empty;

    internal string WebRoot { get; } = AppPaths.WebRoot;

    internal IReadOnlyList<string> Urls { get; private set; } = Array.Empty<string>();

    internal bool HasFolder => folder.Length > 0;

    internal bool FolderExists => folder.Length > 0 && Directory.Exists(folder);

    internal string FolderPath => folder;

    internal int Count => Urls.Count;

    internal string Summary => HasFolder
        ? $"folder: {Count} photo(s) from {folder}"
        : $"bundled wallpapers from {Path.Combine(WebRoot, "images")}";

    internal void Reload(string folderPath)
    {
        folder = (folderPath ?? string.Empty).Trim();

        if (folder.Length == 0)
        {
            Urls = Array.Empty<string>();
            Log.Write($"photo library: {Summary}");
            return;
        }

        if (!Directory.Exists(folder))
        {
            Urls = Array.Empty<string>();
            Log.Write($"photo library: folder not found: {folder}");
            return;
        }

        var files = new List<string>();
        try
        {
            foreach (var path in Directory.EnumerateFiles(folder))
            {
                if (!SupportedExtensions.Contains(Path.GetExtension(path))) continue;
                files.Add(path);
                if (files.Count >= MaxPhotos) break;
            }
        }
        catch (Exception ex)
        {
            Log.Write($"photo library: could not read {folder}: {ex.Message}");
        }

        files.Sort(StringComparer.OrdinalIgnoreCase);
        Urls = files
            .Select(path => $"https://{FolderHost}/{Uri.EscapeDataString(Path.GetFileName(path))}")
            .ToArray();

        Log.Write($"photo library: {Summary}");
    }
}
