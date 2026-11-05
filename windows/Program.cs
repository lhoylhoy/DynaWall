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
        using var mutex = new Mutex(initiallyOwned: true, SingleInstanceMutexName, out var isFirstInstance);
        if (!isFirstInstance)
        {
            // Double-clicking the shortcut again is a request for Settings, not a
            // second wallpaper stacked on the desktop.
            SignalExistingInstance();
            return;
        }

        ApplicationConfiguration.Initialize();

        // Application.Run installs the WinForms synchronization context, but the tray
        // context and the WebView2 hosts are constructed before it. Installing it now
        // guarantees the second-launch signal and the SystemEvents callbacks (which
        // arrive on background threads) marshal onto the UI thread instead of touching
        // forms from a worker thread.
        SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());

        var openSettings = args is { Length: > 0 } && Array.Exists(args, a =>
            string.Equals(a, "--settings", StringComparison.OrdinalIgnoreCase) ||
            string.Equals(a, "-s", StringComparison.OrdinalIgnoreCase));

        using var context = new TrayApplicationContext(openSettings);
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

    private static void SignalExistingInstance()
    {
        for (var attempt = 0; attempt < 10; attempt += 1)
        {
            try
            {
                using var handle = EventWaitHandle.OpenExisting(ShowSettingsEventName);
                handle.Set();
                return;
            }
            catch (WaitHandleCannotBeOpenedException)
            {
                // The first instance is still creating its handles.
                Thread.Sleep(150);
            }
        }
    }
}
