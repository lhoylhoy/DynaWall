using System.Text;

namespace DynaWall;

/// <summary>
/// Every path the Windows host owns. Settings and the WebView2 profile live in
/// <c>%LOCALAPPDATA%\DynaWall</c> (per-user, writable without elevation); the web
/// wallpaper ships next to the executable in <c>web/</c>.
/// </summary>
internal static class AppPaths
{
    private const string AppFolderName = "DynaWall";

    internal static string DataDirectory =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), AppFolderName);

    internal static string WebViewDataDirectory => Path.Combine(DataDirectory, "WebView2");

    internal static string PreferencesFile => Path.Combine(DataDirectory, "settings.json");

    /// <summary>
    /// Imported font files ("Add font…"), copied out of Downloads so the wallpaper
    /// keeps its typeface after the original is moved.
    /// </summary>
    internal static string FontDirectory => Path.Combine(DataDirectory, "Fonts");

    internal static string LogFile => Path.Combine(DataDirectory, "dynawall.log");

    /// <summary>
    /// The web root mapped to <c>https://dynawall.local/</c>.
    /// Uses the local <c>web/</c> directory next to the executable if present;
    /// otherwise unpacks embedded assets to <c>%LOCALAPPDATA%\DynaWall\web</c>
    /// so the single <c>DynaWall.exe</c> runs standalone with no extra files needed.
    /// </summary>
    internal static string WebRoot
    {
        get
        {
            var localWeb = Path.Combine(AppContext.BaseDirectory, "web");
            if (Directory.Exists(localWeb) && File.Exists(Path.Combine(localWeb, "index.html")))
            {
                return localWeb;
            }

            var appDataWeb = Path.Combine(DataDirectory, "web");
            EnsureEmbeddedWebAssets(appDataWeb);
            return appDataWeb;
        }
    }

    private static void EnsureEmbeddedWebAssets(string targetDir)
    {
        var targetIndex = Path.Combine(targetDir, "index.html");
        var versionFile = Path.Combine(targetDir, ".version");
        var currentVersion = typeof(AppPaths).Assembly.GetName().Version?.ToString() ?? "1.0.0";

        if (File.Exists(targetIndex) && File.Exists(versionFile) &&
            string.Equals(File.ReadAllText(versionFile).Trim(), currentVersion, StringComparison.Ordinal))
        {
            return;
        }

        try
        {
            Directory.CreateDirectory(targetDir);
            var assembly = typeof(AppPaths).Assembly;
            var resourceNames = assembly.GetManifestResourceNames();

            foreach (var name in resourceNames)
            {
                if (!name.StartsWith("web/", StringComparison.OrdinalIgnoreCase)) continue;

                var relativePath = name.Substring(4).Replace('/', Path.DirectorySeparatorChar);
                var fullPath = Path.Combine(targetDir, relativePath);
                var parentDir = Path.GetDirectoryName(fullPath);
                if (!string.IsNullOrEmpty(parentDir))
                {
                    Directory.CreateDirectory(parentDir);
                }

                using var stream = assembly.GetManifestResourceStream(name);
                if (stream is null) continue;

                using var file = File.Create(fullPath);
                stream.CopyTo(file);
            }

            File.WriteAllText(versionFile, currentVersion);
            Log.Write($"unpacked embedded web wallpaper into {targetDir}");
        }
        catch (Exception ex)
        {
            Log.Write($"could not unpack embedded web assets: {ex.Message}");
        }
    }

    internal static void EnsureDataDirectory()
    {
        Directory.CreateDirectory(DataDirectory);
    }
}

/// <summary>
/// A tiny append-only log at <c>%LOCALAPPDATA%\DynaWall\dynawall.log</c>, mirroring
/// the macOS host's <c>DYNAWALL_LOG</c> diagnostics. Logging is best-effort: a
/// read-only profile must never take the wallpaper down.
/// </summary>
internal static class Log
{
    private const long MaxBytes = 512 * 1024;
    private static readonly object Gate = new();
    private static bool directoryReady;

    internal static void Write(string message)
    {
        System.Diagnostics.Debug.WriteLine($"[DynaWall] {message}");
        try
        {
            lock (Gate)
            {
                if (!directoryReady)
                {
                    AppPaths.EnsureDataDirectory();
                    directoryReady = true;
                }

                var file = new FileInfo(AppPaths.LogFile);
                if (file.Exists && file.Length > MaxBytes)
                {
                    // Keep one generation; a wallpaper log should never grow forever.
                    File.Move(file.FullName, file.FullName + ".1", overwrite: true);
                }

                var line = new StringBuilder()
                    .Append(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"))
                    .Append(" [DynaWall] ")
                    .AppendLine(message)
                    .ToString();
                File.AppendAllText(AppPaths.LogFile, line);
            }
        }
        catch (Exception)
        {
            // Diagnostics are optional.
        }
    }
}
