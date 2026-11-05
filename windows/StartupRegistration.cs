using System.Windows.Forms;
using Microsoft.Win32;

namespace DynaWall;

/// <summary>
/// "Start with Windows" lives in the per-user Run key, so it needs no elevation and
/// no Task Scheduler entry — the same choice the macOS host makes by registering
/// with <c>SMAppService</c> instead of installing a launch agent.
/// </summary>
internal static class StartupRegistration
{
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "DynaWall";

    internal static string ExecutablePath => Environment.ProcessPath ?? Application.ExecutablePath;

    internal static bool IsEnabled
    {
        get
        {
            try
            {
                using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath);
                return key?.GetValue(ValueName) is string value && value.Length > 0;
            }
            catch (Exception)
            {
                return false;
            }
        }
    }

    internal static bool SetEnabled(bool enabled)
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(RunKeyPath, writable: true);
            if (key is null) return false;

            if (enabled)
            {
                // Quoted: the installer's per-user path contains spaces.
                key.SetValue(ValueName, $"\"{ExecutablePath}\" --autostart", RegistryValueKind.String);
            }
            else
            {
                key.DeleteValue(ValueName, throwOnMissingValue: false);
            }

            Log.Write(enabled ? "registered the Run key for sign-in" : "removed the Run key");
            return true;
        }
        catch (Exception ex)
        {
            Log.Write($"startup registration failed: {ex.Message}");
            return false;
        }
    }
}
