using System.Drawing;
using System.Globalization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace DynaWall;

/// <summary>
/// One borderless WebView2 window per display, parented to Explorer's wallpaper
/// layer. The page is the same <c>index.html</c> the macOS app and Lively load, and
/// the host talks to it through the same <c>livelyPropertyListener</c> bridge.
/// </summary>
internal sealed class WallpaperWindow : Form
{
    private const int WsExNoActivate = 0x08000000;
    private const int WsExToolWindow = 0x00000080;

    private readonly WallpaperController owner;
    private readonly WebView2 webView;
    private bool suspended;

    /// <summary>Where this wallpaper sits on the virtual desktop, in screen pixels.</summary>
    private Rectangle screenBounds = Rectangle.Empty;

    /// <summary>Rectangles (CSS pixels) the page will take a click in, as last reported.</summary>
    private WidgetHitArea hitArea = WidgetHitArea.Closed;

    /// <summary>
    /// The font payload this display already holds (<c>null</c> = nothing sent yet).
    /// An imported font is a multi-megabyte data URL, so it is only pushed when it
    /// actually changed, never on every settings edit.
    /// </summary>
    private string? pushedFontSource;

    internal WallpaperWindow(WallpaperController owner)
    {
        this.owner = owner;

        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        MinimizeBox = false;
        MaximizeBox = false;
        BackColor = ColorTranslator.FromHtml(owner.Preferences.BgColor);

        webView = new WebView2
        {
            Dock = DockStyle.Fill,
            DefaultBackgroundColor = BackColor
        };
        Controls.Add(webView);
    }

    internal bool IsReady { get; private set; }

    /// <summary>Where this wallpaper sits on the virtual desktop, in screen pixels.</summary>
    internal Rectangle ScreenBounds => screenBounds;

    /// <summary>
    /// Physical screen pixels per CSS pixel on this display.
    ///
    /// WebView2 rasterises the page at the host window's DPI (the process is
    /// PerMonitorV2 — see DynaWall.csproj), so the page's CSS viewport is
    /// <c>DeviceDpi / 96</c> times smaller than the wallpaper window. A click the
    /// desktop hook reports in screen pixels has to be divided by exactly this
    /// factor before it can be compared with a rectangle the page reported.
    /// </summary>
    internal float DeviceScale => DeviceDpi > 0 ? DeviceDpi / 96f : 1f;

    /// <summary>What the page last said it would take a click in.</summary>
    internal WidgetHitArea HitArea => hitArea;

    internal IntPtr DesktopParent => IsHandleCreated ? DesktopHost.Parent(Handle) : IntPtr.Zero;

    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get
        {
            var parameters = base.CreateParams;
            // Never take focus from the desktop or appear in Alt+Tab.
            parameters.ExStyle |= WsExNoActivate | WsExToolWindow;
            return parameters;
        }
    }

    /// <summary>Parent the window to the wallpaper layer and start the page.</summary>
    internal void AttachToDesktop(IntPtr host, Rectangle bounds)
    {
        // The click watch works in screen pixels, so remember where this display's
        // wallpaper landed once it is attached.
        var origin = DesktopHost.GetOrigin(host);
        screenBounds = new Rectangle(
            origin.X + bounds.X, origin.Y + bounds.Y, bounds.Width, bounds.Height);

        // Show off-screen first: Show() is what makes WinForms mark the form (and the
        // WebView2 child) visible, and WebView2 only renders inside a visible window.
        // The window is reparented below, so the off-screen spot is never painted.
        Bounds = new Rectangle(-32000, -32000, Math.Max(bounds.Width, 64), Math.Max(bounds.Height, 64));
        Show();

        if (!DesktopHost.AttachChild(Handle, host, bounds))
        {
            Log.Write("wallpaper window could not be attached to the desktop");
        }

        _ = InitializeWebViewAsync();
    }

    internal void SetBackground(Color color)
    {
        BackColor = color;
        if (!webView.IsDisposed) webView.DefaultBackgroundColor = color;
    }

    private async Task InitializeWebViewAsync()
    {
        try
        {
            var environment = owner.WebViewEnvironment;
            if (environment is null)
            {
                Log.Write("web view environment is not ready");
                return;
            }

            if (!Directory.Exists(owner.Photos.WebRoot))
            {
                Log.Write($"web wallpaper folder is missing: {owner.Photos.WebRoot}");
                return;
            }

            await webView.EnsureCoreWebView2Async(environment);
            var core = webView.CoreWebView2;

            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.IsZoomControlEnabled = false;
            core.Settings.IsBuiltInErrorPageEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.Settings.IsGeneralAutofillEnabled = false;

            core.SetVirtualHostNameToFolderMapping(
                PhotoLibrary.BundledHost, owner.Photos.WebRoot, CoreWebView2HostResourceAccessKind.DenyCors);
            owner.ApplyPhotoMapping(core);

            // First paint is the user's wallpaper, not the built-in copy.
            await core.AddScriptToExecuteOnDocumentCreatedAsync(
                owner.Preferences.BuildSeedScript(owner.Photos.Urls));

            core.NavigationCompleted += OnNavigationCompleted;
            core.ProcessFailed += OnProcessFailed;
            // Widgets: the page reports where it accepts a click and asks for the
            // browser when the user picks a link.
            core.WebMessageReceived += OnWebMessage;
            core.Navigate($"https://{PhotoLibrary.BundledHost}/index.html");

            Log.Write($"web view starting on display {owner.DisplayLabel(this)} ({Bounds.Width}×{Bounds.Height})");
        }
        catch (Exception ex)
        {
            Log.Write($"web view failed to start: {ex.Message}");
        }
    }

    private void OnProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs e)
    {
        Log.Write($"web view process failed: {e.ProcessFailedKind}");
    }

    /// <summary>
    /// The page's widget calls arrive here: the rectangles it accepts a click in, and
    /// the links it wants the browser to take.
    /// </summary>
    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string json;
        try
        {
            json = e.WebMessageAsJson;
        }
        catch (Exception)
        {
            // The document went away between the post and this callback.
            return;
        }

        WidgetBridge.Read(json, out var area, out var url);
        if (area is not null) hitArea = area;
        if (url is not null) OpenInBrowser(url);
    }

    /// <summary>
    /// Replay a click the desktop caught, at CSS pixels from the page's top-left corner.
    ///
    /// A card can only be dismissed by clicking outside it, and only the page knows
    /// where "outside" is, so the point travels through exactly as a real click would.
    /// </summary>
    internal void ReplayClick(PointF point)
    {
        var core = ReadyCore();
        if (core is null) return;

        var script = string.Concat(
            "window.DynaWall && window.DynaWall.clickAt(",
            point.X.ToString("0.##", CultureInfo.InvariantCulture),
            ", ",
            point.Y.ToString("0.##", CultureInfo.InvariantCulture),
            ");");

        try
        {
            _ = core.ExecuteScriptAsync(script);
        }
        catch (Exception ex)
        {
            Log.Write($"widget click failed: {ex.Message}");
        }
    }

    /// <summary>Hand an <c>https</c> link to the default browser; the wallpaper never navigates.</summary>
    private static void OpenInBrowser(string url)
    {
        try
        {
            using var process = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(url)
            {
                UseShellExecute = true
            });
            Log.Write("opening a widget link in the default browser");
        }
        catch (Exception ex)
        {
            Log.Write($"could not open the browser: {ex.Message}");
        }
    }

    private async void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        if (!e.IsSuccess)
        {
            Log.Write($"page failed to load: {e.WebErrorStatus}");
            return;
        }

        IsReady = true;
        owner.ApplyPhotoMappingTo(this);
        await PushSettingsAsync();
        await PushFontAsync();
        await PushPhotosAsync();
        await ApplySuspensionAsync();
        Log.Write("wallpaper page ready");
    }

    internal async Task PushSettingsAsync()
    {
        var core = ReadyCore();
        if (core is null) return;

        try
        {
            await core.ExecuteScriptAsync(owner.Preferences.BuildSettingsScript());
        }
        catch (Exception ex)
        {
            Log.Write($"settings push failed: {ex.Message}");
        }
    }

    internal async Task PushPhotosAsync()
    {
        var core = ReadyCore();
        if (core is null) return;

        try
        {
            await core.ExecuteScriptAsync(Preferences.BuildPhotosScript(owner.Photos.Urls));
        }
        catch (Exception ex)
        {
            Log.Write($"photo push failed: {ex.Message}");
        }
    }

    /// <summary>
    /// Hand the imported font file (if any) to the page. Skipped when this display
    /// already holds the same bytes, so typing in the settings window never re-sends
    /// megabytes of base64.
    /// </summary>
    internal async Task PushFontAsync()
    {
        var core = ReadyCore();
        if (core is null) return;

        var source = owner.Preferences.CustomFontSource;
        if (string.Equals(source, pushedFontSource, StringComparison.Ordinal)) return;

        try
        {
            await core.ExecuteScriptAsync(Preferences.BuildFontScript(source));
            pushedFontSource = source;
        }
        catch (Exception ex)
        {
            Log.Write($"font push failed: {ex.Message}");
        }
    }

    internal async Task NextPhotoAsync()
    {
        var core = ReadyCore();
        if (core is null) return;

        try
        {
            await core.ExecuteScriptAsync(Preferences.BuildNextPhotoScript());
        }
        catch (Exception ex)
        {
            Log.Write($"next photo failed: {ex.Message}");
        }
    }

    internal async Task ApplySuspensionAsync(bool? suspendedOverride = null)
    {
        if (suspendedOverride.HasValue) suspended = suspendedOverride.Value;

        var core = ReadyCore();
        if (core is null) return;

        try
        {
            await core.ExecuteScriptAsync(Preferences.BuildSuspendScript(suspended));
        }
        catch (Exception ex)
        {
            Log.Write($"suspend push failed: {ex.Message}");
        }
    }

    /// <summary>Mirror the host's suspension state on the page (Pause, lock, sleep).</summary>
    internal void SetSuspended(bool value)
    {
        if (suspended == value) return;
        suspended = value;
        _ = ApplySuspensionAsync(value);
        Log.Write(value ? "display suspended (0 FPS)" : "display resumed");
    }

    internal void RefreshPhotoMapping()
    {
        var core = ReadyCore();
        if (core is null) return;
        owner.ApplyPhotoMapping(core);
    }

    internal void Resync()
    {
        var core = ReadyCore();
        if (core is null) return;
        _ = core.ExecuteScriptAsync("window.dispatchEvent(new Event('focus'));");
    }

    private CoreWebView2? ReadyCore()
    {
        if (!IsReady || webView.IsDisposed) return null;
        try
        {
            return webView.CoreWebView2;
        }
        catch (Exception)
        {
            return null;
        }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            IsReady = false;
            if (!webView.IsDisposed) webView.Dispose();
        }

        base.Dispose(disposing);
    }
}
