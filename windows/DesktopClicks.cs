using System.Drawing;
using System.Runtime.InteropServices;

namespace DynaWall;

/// <summary>
/// Watches the left button system-wide and never consumes it.
///
/// The wallpaper lives in the desktop layer, behind the icon view, so a click on a
/// satellite belongs to Explorer and never reaches the page. This hook only observes:
/// <see cref="WallpaperController"/> decides whether the point is over a rectangle the
/// page reported and replays that click inside the page. Every event is passed straight
/// on, so the desktop keeps drag-select, right-click, icons and the context menu exactly
/// as they were — and a page that reports nonsense can only lose its own clicks.
/// </summary>
internal static class DesktopClicks
{
    private const int WhMouseLl = 14;
    private const int WmLButtonDown = 0x0201;
    private const uint LlmhfInjected = 0x0001;

    private delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct NativePoint
    {
        internal int X;
        internal int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseHookStruct
    {
        internal NativePoint Point;
        internal uint MouseData;
        internal uint Flags;
        internal uint Time;
        internal IntPtr ExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int hook, HookProc callback, IntPtr module, uint threadId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnhookWindowsHookEx(IntPtr hook);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string? name);

    // The delegate has to outlive the call that installs it: a collected hook procedure
    // is a process crash the moment the mouse moves.
    private static HookProc? procedure;
    private static IntPtr hook;

    /// <summary>Raised on the UI thread for every real left click, with its screen point.</summary>
    internal static event Action<Point>? Clicked;

    internal static bool IsRunning => hook != IntPtr.Zero;

    internal static void Start()
    {
        if (hook != IntPtr.Zero) return;

        procedure = OnMouse;
        hook = SetWindowsHookEx(WhMouseLl, procedure, GetModuleHandle(null), 0);
        if (hook == IntPtr.Zero)
        {
            Log.Write($"mouse watch unavailable (error {Marshal.GetLastWin32Error()}); widgets stay decorative");
        }
    }

    internal static void Stop()
    {
        if (hook != IntPtr.Zero) UnhookWindowsHookEx(hook);
        hook = IntPtr.Zero;
        procedure = null;
    }

    private static IntPtr OnMouse(int code, IntPtr wParam, IntPtr lParam)
    {
        // A hook is on the critical path of every click on the machine, so it does the
        // least possible work and passes the event on no matter what.
        if (code >= 0 && wParam == (IntPtr)WmLButtonDown)
        {
            try
            {
                var info = Marshal.PtrToStructure<MouseHookStruct>(lParam);
                // Injected clicks are other people's automation, not the user.
                if ((info.Flags & LlmhfInjected) == 0)
                {
                    Clicked?.Invoke(new Point(info.Point.X, info.Point.Y));
                }
            }
            catch (Exception ex)
            {
                Log.Write($"mouse watch failed: {ex.Message}");
            }
        }

        return CallNextHookEx(hook, code, wParam, lParam);
    }
}
