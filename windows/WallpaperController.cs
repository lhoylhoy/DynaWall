using System.Drawing;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;

namespace DynaWall;

/// <summary>
/// Owns the desktop wallpaper: one <see cref="WallpaperWindow"/> per display, the
/// shared WebView2 environment, the photo library and the suspension state.
///
/// The controller mirrors the macOS host's lifecycle: rebuild on display changes,
/// park the page when the session locks or the displays sleep, re-push everything
/// on resume, and re-attach if Explorer restarts underneath the wallpaper.
/// </summary>
internal sealed class WallpaperController : IDisposable
{
    private readonly List<WallpaperWindow> windows = new();
    private readonly System.Windows.Forms.Timer watchdog;
    private readonly SynchronizationContext? uiContext;
    private bool sessionLocked;
    private bool displayAsleep;
    private bool disposed;
    private DateTime lastRebuild = DateTime.MinValue;

    internal WallpaperController(Preferences preferences)
    {
        Preferences = preferences;
        uiContext = SynchronizationContext.Current;
        watchdog = new System.Windows.Forms.Timer { Interval = 15_000 };
        watchdog.Tick += (_, _) => CheckAttachment();
    }

    internal Preferences Preferences { get; }

    internal PhotoLibrary Photos { get; } = new();

    internal CoreWebView2Environment? WebViewEnvironment { get; private set; }

    internal bool IsPaused { get; private set; }

    internal bool IsSuspended => IsPaused || sessionLocked || displayAsleep;

    internal int DisplayCount => windows.Count;

    /// <summary>Async start, fire-and-forget: the tray icon appears immediately.</summary>
    internal async void Start()
    {
        try
        {
            Photos.Reload(Preferences.PhotoFolder);
            AppPaths.EnsureDataDirectory();
            WebViewEnvironment = await CoreWebView2Environment.CreateAsync(null, AppPaths.WebViewDataDirectory);
            Rebuild();

            SystemEvents.DisplaySettingsChanged += OnDisplaySettingsChanged;
            SystemEvents.SessionSwitch += OnSessionSwitch;
            SystemEvents.PowerModeChanged += OnPowerModeChanged;
            watchdog.Start();

            // Desktop clicks never reach the wallpaper layer, so the widgets answer to
            // a system-wide watch that passes every click on untouched.
            DesktopClicks.Clicked += OnDesktopClick;
            DesktopClicks.Start();

            Log.Write($"started with {Screen.AllScreens.Length} display(s); settings at {AppPaths.PreferencesFile}");
        }
        catch (WebView2RuntimeNotFoundException)
        {
            // The runtime is an evergreen Windows component that cannot be bundled, so
            // this is the one failure the app cannot fix by itself. Offer Microsoft's
            // bootstrapper page instead of leaving the user with a dead tray icon.
            Log.Write("the WebView2 runtime is not installed");
            var answer = MessageBox.Show(
                "DynaWall draws the wallpaper with Microsoft Edge WebView2, which is not installed on this PC.\n\n" +
                "Open Microsoft's download page for the Evergreen WebView2 Runtime now? " +
                "Install it, then start DynaWall again.",
                "DynaWall",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Warning);

            if (answer == DialogResult.Yes) OpenWebView2DownloadPage();
        }
        catch (Exception ex)
        {
            Log.Write($"wallpaper failed to start: {ex.Message}");
            MessageBox.Show(
                $"DynaWall could not start the wallpaper.\n\n{ex.Message}\n\nSee {AppPaths.LogFile} for details.",
                "DynaWall",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }

    internal string DisplayLabel(WallpaperWindow window)
    {
        var index = windows.IndexOf(window);
        return index < 0 ? "?" : $"{index + 1}/{windows.Count}";
    }

    /// <summary>Point the photo host at the chosen folder, or clear it for bundled mode.</summary>
    internal void ApplyPhotoMapping(CoreWebView2 core)
    {
        try
        {
            if (Photos.FolderExists)
            {
                core.SetVirtualHostNameToFolderMapping(
                    PhotoLibrary.FolderHost, Photos.FolderPath, CoreWebView2HostResourceAccessKind.DenyCors);
            }
            else
            {
                core.ClearVirtualHostNameToFolderMapping(PhotoLibrary.FolderHost);
            }
        }
        catch (Exception ex)
        {
            Log.Write($"photo mapping failed: {ex.Message}");
        }
    }

    internal void ApplyPhotoMappingTo(WallpaperWindow window)
    {
        window.RefreshPhotoMapping();
    }

    /// <summary>Push every setting to every display (the page diffs them).</summary>
    internal void ApplyPreferences()
    {
        var background = ColorTranslator.FromHtml(Preferences.BgColor);
        foreach (var window in windows)
        {
            window.SetBackground(background);
            _ = window.PushSettingsAsync();
            _ = window.PushFontAsync();
        }
    }

    /// <summary>Re-scan the folder and hand the new list to every display.</summary>
    internal void ReloadPhotos()
    {
        Photos.Reload(Preferences.PhotoFolder);
        foreach (var window in windows)
        {
            window.RefreshPhotoMapping();
            _ = window.PushPhotosAsync();
        }
    }

    internal void NextPhoto()
    {
        var ready = windows.Count(window => window.IsReady);
        foreach (var window in windows) _ = window.NextPhotoAsync();
        Log.Write(ready == 0 ? "next photo skipped (no page ready)" : "next photo requested");
    }

    internal void SetPaused(bool paused)
    {
        if (IsPaused == paused) return;
        IsPaused = paused;
        ApplySuspension();
        Log.Write(paused ? "wallpaper paused" : "wallpaper resumed");
    }

    internal void ApplySuspension()
    {
        var suspended = IsSuspended;
        foreach (var window in windows) window.SetSuspended(suspended);
    }

    /// <summary>Re-read the greeting, palette and photos after sleep or unlock.</summary>
    internal void Resync()
    {
        ReloadPhotos();
        foreach (var window in windows)
        {
            _ = window.PushSettingsAsync();
            window.Resync();
        }
    }

    private void Rebuild()
    {
        if (disposed) return;

        foreach (var window in windows) window.Dispose();
        windows.Clear();
        lastRebuild = DateTime.UtcNow;

        var host = DesktopHost.FindWallpaperHost();
        if (host == IntPtr.Zero)
        {
            Log.Write("desktop host not found; will retry");
            return;
        }

        var origin = DesktopHost.GetOrigin(host);
        foreach (var screen in Screen.AllScreens)
        {
            var bounds = screen.Bounds;
            bounds.Offset(-origin.X, -origin.Y);

            var window = new WallpaperWindow(this);
            windows.Add(window);
            try
            {
                window.AttachToDesktop(host, bounds);
            }
            catch (Exception ex)
            {
                Log.Write($"wallpaper window failed for {screen.DeviceName}: {ex.Message}");
            }
        }

        ApplySuspension();
        Log.Write($"desktop windows: {windows.Count} for {Screen.AllScreens.Length} display(s)");
    }

    private void CheckAttachment()
    {
        if (disposed) return;
        if (DateTime.UtcNow - lastRebuild < TimeSpan.FromSeconds(20)) return;

        // Nothing built yet (Explorer was not ready at sign-in): keep trying, and ask
        // for the WorkerW layer now. Once windows exist, only enumerate — a blocking
        // Progman message every 15 seconds would stutter the wallpaper.
        var host = DesktopHost.FindWallpaperHost(spawn: windows.Count == 0);
        if (host == IntPtr.Zero) return;

        if (windows.Count == 0 ||
            windows.Any(window => window.IsDisposed || !window.IsHandleCreated || window.DesktopParent != host))
        {
            Log.Write(windows.Count == 0
                ? "desktop layer is ready; building the wallpaper"
                : "desktop layer changed (Explorer restarted?); rebuilding the wallpaper");
            Rebuild();
        }
    }

    private void OnDisplaySettingsChanged(object? sender, EventArgs e)
    {
        RunOnUiThread(Rebuild);
    }

    private void OnSessionSwitch(object? sender, SessionSwitchEventArgs e)
    {
        RunOnUiThread(() =>
        {
            switch (e.Reason)
            {
                case SessionSwitchReason.SessionLock:
                case SessionSwitchReason.SessionLogoff:
                case SessionSwitchReason.ConsoleDisconnect:
                case SessionSwitchReason.RemoteDisconnect:
                    sessionLocked = true;
                    break;
                case SessionSwitchReason.SessionUnlock:
                case SessionSwitchReason.SessionLogon:
                case SessionSwitchReason.ConsoleConnect:
                case SessionSwitchReason.RemoteConnect:
                    sessionLocked = false;
                    break;
                default:
                    return;
            }

            ApplySuspension();
            if (!sessionLocked) Resync();
        });
    }

    private void OnPowerModeChanged(object? sender, PowerModeChangedEventArgs e)
    {
        RunOnUiThread(() =>
        {
            switch (e.Mode)
            {
                case PowerModes.Suspend:
                    displayAsleep = true;
                    break;
                case PowerModes.Resume:
                    displayAsleep = false;
                    break;
                default:
                    return;
            }

            ApplySuspension();
            if (!displayAsleep) Resync();
        });
    }

    /// <summary>
    /// Replay one desktop click into the page that owns that point, if any.
    ///
    /// Three filters keep the desktop exactly as it was: a suspended wallpaper takes
    /// nothing; a click on an app window, the tray or our own settings window is never
    /// touched; and a click outside the rectangles the page reported is ignored, so
    /// empty wallpaper behaves precisely as it did before widgets existed.
    /// </summary>
    private void OnDesktopClick(Point point)
    {
        if (disposed || IsSuspended) return;
        if (!DesktopHost.IsDesktopAt(point)) return;

        foreach (var window in windows)
        {
            if (window.IsDisposed || !window.ScreenBounds.Contains(point)) continue;

            // The hook reports physical screen pixels; the page reports its hit areas
            // in CSS pixels. WebView2 rasterises at the display's DPI (the process is
            // PerMonitorV2), so a 150% display is 1.5 physical pixels per CSS pixel —
            // subtracting the origin alone would miss every widget there.
            var scale = window.DeviceScale;
            var local = new PointF(
                (point.X - window.ScreenBounds.X) / scale,
                (point.Y - window.ScreenBounds.Y) / scale);
            if (!window.HitArea.Contains(local.X, local.Y)) continue;

            window.ReplayClick(local);
            return;
        }
    }

    /// <summary>
    /// Hand the user to Microsoft's Evergreen WebView2 download page. The runtime
    /// cannot ship inside the installer (it is an evergreen Windows component), so a
    /// missing runtime is the one failure this app has to delegate to the OS vendor.
    /// </summary>
    private static void OpenWebView2DownloadPage()
    {
        const string url = "https://go.microsoft.com/fwlink/p/?LinkId=2124703";
        try
        {
            using var process = System.Diagnostics.Process.Start(
                new System.Diagnostics.ProcessStartInfo(url) { UseShellExecute = true });
            Log.Write("opened the WebView2 runtime download page");
        }
        catch (Exception ex)
        {
            Log.Write($"could not open the WebView2 download page: {ex.Message}");
        }
    }

    private void RunOnUiThread(Action action)
    {
        if (disposed) return;

        if (uiContext is null)
        {
            action();
            return;
        }

        uiContext.Post(_ =>
        {
            if (!disposed) action();
        }, null);
    }

    public void Dispose()
    {
        if (disposed) return;
        disposed = true;

        watchdog.Stop();
        watchdog.Dispose();

        DesktopClicks.Clicked -= OnDesktopClick;
        DesktopClicks.Stop();

        try
        {
            SystemEvents.DisplaySettingsChanged -= OnDisplaySettingsChanged;
            SystemEvents.SessionSwitch -= OnSessionSwitch;
            SystemEvents.PowerModeChanged -= OnPowerModeChanged;
        }
        catch (Exception)
        {
            // SystemEvents may already be shutting down.
        }

        foreach (var window in windows) window.Dispose();
        windows.Clear();
    }
}
