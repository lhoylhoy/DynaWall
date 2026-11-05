using System.Threading;
using System.Windows.Forms;

namespace DynaWall;

internal static class Program
{
    private const string SingleInstanceMutexName = @"Local\DynaWall.SingleInstance";
    private const string ShowSettingsEventName = @"Local\DynaWall.ShowSettings";

    [STAThread]
    private static void Main(string[] args)
    {
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
        {
            var ex = e.ExceptionObject as Exception;
            Log.Write($"fatal unhandled exception: {ex}");
            MessageBox.Show(
                $"DynaWall encountered a fatal error:\n\n{ex?.Message}\n\nCheck {AppPaths.LogFile} for full details.",
                "DynaWall",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        };

        Application.ThreadException += (_, e) =>
        {
            Log.Write($"UI thread exception: {e.Exception}");
            MessageBox.Show(
                $"DynaWall encountered an error:\n\n{e.Exception.Message}\n\nCheck {AppPaths.LogFile} for details.",
                "DynaWall",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        };

        try
        {
            Run(args);
        }
        catch (Exception ex)
        {
            Log.Write($"startup exception: {ex}");
            MessageBox.Show(
                $"DynaWall could not start:\n\n{ex.Message}\n\nCheck {AppPaths.LogFile} for details.",
                "DynaWall",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }

    private static void Run(string[] args)
    {
        using var mutex = new Mutex(initiallyOwned: true, SingleInstanceMutexName, out var isFirstInstance);
        if (!isFirstInstance)
        {
            // Double-clicking the shortcut again is a request for Settings, not a
            // second wallpaper stacked on the desktop.
            if (SignalExistingInstance())
            {
                return;
            }

            // If a previous hung instance was terminated, re-attempt acquiring the mutex.
            using var secondTry = new Mutex(initiallyOwned: true, SingleInstanceMutexName, out var acquired);
            if (!acquired) return;
        }

        ApplicationConfiguration.Initialize();

        // Application.Run installs the WinForms synchronization context, but the tray
        // context and the WebView2 hosts are constructed before it. Installing it now
        // guarantees the second-launch signal and the SystemEvents callbacks (which
        // arrive on background threads) marshal onto the UI thread instead of touching
        // forms from a worker thread.
        SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());

        var isAutoStart = args is { Length: > 0 } && Array.Exists(args, a =>
            string.Equals(a, "--autostart", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(a, "--silent", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(a, "-b", StringComparison.OrdinalIgnoreCase));

        // When launched interactively (e.g. double-clicking DynaWall.exe), always open
        // Settings so the user sees the app is alive and running. Only background startup
        // (--autostart) stays purely in the system tray.
        using var context = new TrayApplicationContext(openSettingsOnStart: !isAutoStart);
        using var showSettings = new EventWaitHandle(
            initialState: false, EventResetMode.AutoReset, ShowSettingsEventName);
        var registration = ThreadPool.RegisterWaitForSingleObject(
            showSettings,
            (_, _) => context.OpenSettings(),
            state: null,
            Timeout.Infinite,
            executeOnlyOnce: false);

        try
        {
            Application.Run(context);
        }
        finally
        {
            registration.Unregister(null);
        }
    }

    private static bool SignalExistingInstance()
    {
        for (var attempt = 0; attempt < 10; attempt += 1)
        {
            try
            {
                using var handle = EventWaitHandle.OpenExisting(ShowSettingsEventName);
                handle.Set();
                return true;
            }
            catch (WaitHandleCannotBeOpenedException)
            {
                // The first instance is still creating its handles.
                Thread.Sleep(150);
            }
        }

        // An instance exists but is not responding to IPC signals.
        var answer = MessageBox.Show(
            "DynaWall is already running in the background, but the existing process is not responding.\n\n" +
            "Would you like to close the background process and start DynaWall fresh?",
            "DynaWall",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Question);

        if (answer == DialogResult.Yes)
        {
            KillExistingInstances();
            Thread.Sleep(300);
            return false;
        }

        return true;
    }

    private static void KillExistingInstances()
    {
        try
        {
            var currentId = Environment.ProcessId;
            foreach (var process in System.Diagnostics.Process.GetProcessesByName("DynaWall"))
            {
                if (process.Id != currentId)
                {
                    process.Kill();
                    process.WaitForExit(1000);
                }
            }
        }
        catch (Exception ex)
        {
            Log.Write($"could not terminate existing process: {ex.Message}");
        }
    }
}
