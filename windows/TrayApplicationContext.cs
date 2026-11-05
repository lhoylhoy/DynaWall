using System.Drawing;
using System.Windows.Forms;

namespace DynaWall;

/// <summary>
/// The tray application: a Notification Area icon whose menu controls the wallpaper
/// (Settings, Next photo, Pause/Resume, Start with Windows, Exit). Closing the
/// settings window leaves the wallpaper running; only Exit stops it.
/// </summary>
internal sealed class TrayApplicationContext : ApplicationContext
{
    private readonly SynchronizationContext? uiContext;
    private readonly WallpaperController wallpaper;
    private readonly NotifyIcon tray;
    private readonly ToolStripMenuItem pauseItem;
    private readonly ToolStripMenuItem startupItem;
    private SettingsForm? settingsForm;
    private bool cleanedUp;

    internal TrayApplicationContext(bool openSettingsOnStart = false)
    {
        uiContext = SynchronizationContext.Current;

        var isFirstRun = !File.Exists(AppPaths.PreferencesFile);
        var preferences = Preferences.Load();
        if (isFirstRun)
        {
            preferences.Save();
        }

        wallpaper = new WallpaperController(preferences);

        var menu = new ContextMenuStrip();
        var settingsItem = new ToolStripMenuItem("Settings…", null, (_, _) => OpenSettings());
        var nextItem = new ToolStripMenuItem("Next photo", null, (_, _) => wallpaper.NextPhoto());
        pauseItem = new ToolStripMenuItem("Pause wallpaper", null, (_, _) => TogglePause());
        startupItem = new ToolStripMenuItem("Start with Windows", null, (_, _) => ToggleStartup());
        var exitItem = new ToolStripMenuItem("Exit", null, (_, _) => ExitThread());

        menu.Items.Add(settingsItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(nextItem);
        menu.Items.Add(pauseItem);
        menu.Items.Add(startupItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(exitItem);
        menu.Opening += (_, _) => RefreshMenu();

        tray = new NotifyIcon
        {
            Icon = LoadIcon(),
            Text = "DynaWall",
            Visible = true,
            ContextMenuStrip = menu
        };
        tray.DoubleClick += (_, _) => OpenSettings();

        wallpaper.Start();
        RefreshMenu();

        if (isFirstRun || openSettingsOnStart)
        {
            OpenSettings();
            try
            {
                tray.ShowBalloonTip(
                    4000,
                    "DynaWall",
                    "DynaWall is running! You can configure settings here anytime.",
                    ToolTipIcon.Info);
            }
            catch
            {
                // Balloon notifications are best-effort.
            }
        }
    }

    /// <summary>Safe from any thread; also used when a second launch asks for settings.</summary>
    internal void OpenSettings()
    {
        if (cleanedUp) return;

        if (uiContext is null)
        {
            ShowSettings();
            return;
        }

        uiContext.Post(_ => ShowSettings(), null);
    }

    private void ShowSettings()
    {
        if (cleanedUp) return;

        if (settingsForm is { IsDisposed: false })
        {
            if (settingsForm.WindowState == FormWindowState.Minimized)
            {
                settingsForm.WindowState = FormWindowState.Normal;
            }

            settingsForm.Show();
            settingsForm.Activate();
            settingsForm.BringToFront();
            return;
        }

        settingsForm = new SettingsForm(wallpaper);
        settingsForm.FormClosed += (_, _) => settingsForm = null;
        settingsForm.Show();
        settingsForm.Activate();
        settingsForm.BringToFront();
    }

    private void TogglePause()
    {
        wallpaper.SetPaused(!wallpaper.IsPaused);
        RefreshMenu();
    }

    private void ToggleStartup()
    {
        var enable = !StartupRegistration.IsEnabled;
        if (!StartupRegistration.SetEnabled(enable))
        {
            MessageBox.Show(
                "DynaWall could not update the per-user startup entry.",
                "DynaWall",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }

        RefreshMenu();
    }

    private void RefreshMenu()
    {
        pauseItem.Text = wallpaper.IsPaused ? "Resume wallpaper" : "Pause wallpaper";
        startupItem.Checked = StartupRegistration.IsEnabled;
    }

    private static Icon LoadIcon()
    {
        try
        {
            var path = Environment.ProcessPath;
            if (!string.IsNullOrEmpty(path))
            {
                var icon = Icon.ExtractAssociatedIcon(path);
                if (icon is not null) return icon;
            }
        }
        catch (Exception)
        {
            // Fall back to the stock icon.
        }

        return SystemIcons.Application;
    }

    protected override void ExitThreadCore()
    {
        CleanUp();
        base.ExitThreadCore();
    }

    private void CleanUp()
    {
        if (cleanedUp) return;
        cleanedUp = true;

        tray.Visible = false;
        tray.Dispose();
        settingsForm?.Dispose();
        settingsForm = null;
        wallpaper.Dispose();
    }
}
