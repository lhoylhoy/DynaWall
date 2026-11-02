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

    internal static string LogFile => Path.Combine(DataDirectory, "dynawall.log");

    /// <summary>The web root mapped to <c>https://dynawall.local/</c>.</summary>
    internal static string WebRoot => Path.Combine(AppContext.BaseDirectory, "web");

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
