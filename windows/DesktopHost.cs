using System.Drawing;
using System.Runtime.InteropServices;

namespace DynaWall;

/// <summary>
/// Win32 plumbing that puts a window where the desktop picture lives.
///
/// Explorer keeps two layers: <c>Progman</c> owns the icon view
/// (<c>SHELLDLL_DefView</c>) and a sibling <c>WorkerW</c> paints the wallpaper
/// behind it. Sending <c>WM_SPAWN_WORKER</c> (0x052C) asks Explorer to create that
/// WorkerW layer; the window is then parented to it with <c>SetParent</c>, so the
/// wallpaper sits behind the icons and the desktop keeps every click, drag-select
/// and context menu.
/// </summary>
internal static class DesktopHost
{
    /// <summary>The undocumented Progman message that spawns the wallpaper WorkerW.</summary>
    internal const uint WmSpawnWorker = 0x052C;

    private const uint SmtoNormal = 0x0000;
    private const int GwlStyle = -16;
    private const int WsChild = 0x40000000;
    private const int WsPopup = unchecked((int)0x80000000);
    private const int SwShowNoActivate = 4;
    private const uint SwpNoSize = 0x0001;
    private const uint SwpNoMove = 0x0002;
    private const uint SwpNoActivate = 0x0010;
    private static readonly IntPtr HwndBottom = new(1);

    private delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);

    [StructLayout(LayoutKind.Sequential)]
    internal struct Rect
    {
        internal int Left;
        internal int Top;
        internal int Right;
        internal int Bottom;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr FindWindow(string? className, string? windowName);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr FindWindowEx(IntPtr parent, IntPtr childAfter, string? className, string? windowName);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(
        IntPtr window, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetParent(IntPtr child, IntPtr newParent);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetParent(IntPtr window);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool MoveWindow(IntPtr window, int x, int y, int width, int height, bool repaint);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern int GetWindowLong(IntPtr window, int index);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern int SetWindowLong(IntPtr window, int index, int newStyle);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPos(
        IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetWindowRect(IntPtr window, out Rect rect);

    /// <summary>
    /// The window that sits directly behind the desktop icons, or <see cref="IntPtr.Zero"/>
    /// when Explorer is not running yet. <paramref name="spawn"/> is false for the
    /// watchdog: enumerating is cheap, while asking Explorer to spawn a WorkerW sends
    /// a blocking message.
    /// </summary>
    internal static IntPtr FindWallpaperHost(bool spawn = true)
    {
        var progman = FindWindow("Progman", null);
        if (progman == IntPtr.Zero) return IntPtr.Zero;

        if (spawn)
        {
            // Two spellings of the same request seen in the wild; Explorer understands
            // both and ignores an extra one harmlessly.
            SendMessageTimeout(progman, WmSpawnWorker, IntPtr.Zero, IntPtr.Zero, SmtoNormal, 500, out _);
            SendMessageTimeout(progman, WmSpawnWorker, new IntPtr(0x0D), new IntPtr(0x01), SmtoNormal, 500, out _);
        }

        var worker = IntPtr.Zero;
        EnumWindows((top, _) =>
        {
            if (FindWindowEx(top, IntPtr.Zero, "SHELLDLL_DefView", null) == IntPtr.Zero) return true;

            // The wallpaper WorkerW is the next sibling of the icon-view WorkerW.
            var sibling = FindWindowEx(IntPtr.Zero, top, "WorkerW", null);
            if (sibling != IntPtr.Zero) worker = sibling;
            return true;
        }, IntPtr.Zero);

        if (worker != IntPtr.Zero) return worker;
        if (!spawn) return IntPtr.Zero;

        // Windows 11 24H2 keeps SHELLDLL_DefView under Progman itself and may not
        // create a sibling WorkerW. Progman can still host the wallpaper if the
        // window is placed at the bottom of its child z-order (see AttachChild).
        return progman;
    }

    /// <summary>Screen coordinates of the host's client origin, for per-display maths.</summary>
    internal static Point GetOrigin(IntPtr host)
    {
        return GetWindowRect(host, out var rect) ? new Point(rect.Left, rect.Top) : Point.Empty;
    }

    internal static IntPtr Parent(IntPtr window)
    {
        return window == IntPtr.Zero ? IntPtr.Zero : GetParent(window);
    }

    /// <summary>
    /// Turn the form into a child of the desktop layer, size it to the display and
    /// show it without stealing focus.
    /// </summary>
    internal static bool AttachChild(IntPtr window, IntPtr host, Rectangle bounds)
    {
        if (window == IntPtr.Zero || host == IntPtr.Zero) return false;

        // SetParent returns the *previous* parent, which is NULL for a top-level
        // window — so clear the last error and check that instead.
        Marshal.SetLastPInvokeError(0);
        var previous = SetParent(window, host);
        if (previous == IntPtr.Zero && Marshal.GetLastWin32Error() != 0)
        {
            Log.Write($"SetParent failed (error {Marshal.GetLastWin32Error()})");
            return false;
        }

        var style = GetWindowLong(window, GwlStyle);
        SetWindowLong(window, GwlStyle, (style | WsChild) & ~WsPopup);

        // Below every sibling: on Progman that is below SHELLDLL_DefView, so the
        // icons stay on top even on the fallback path.
        SetWindowPos(window, HwndBottom, 0, 0, 0, 0, SwpNoMove | SwpNoSize | SwpNoActivate);
        MoveWindow(window, bounds.X, bounds.Y, bounds.Width, bounds.Height, true);
        ShowWindow(window, SwShowNoActivate);
        return GetParent(window) == host;
    }
}
