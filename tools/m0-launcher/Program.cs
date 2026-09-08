using System;
using System.Diagnostics;
using System.IO;

internal static class Program
{
    private static int Main()
    {
        var root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", ".."));
        var electron = Path.Combine(root, "node_modules", "electron", "dist", "electron.exe");
        var userData = Path.Combine(root, ".m0-user-data");
        var report = Path.Combine(root, "diagnostics", "m0-interactive.jsonl");
        if (!File.Exists(electron)) return 2;
        Directory.CreateDirectory(userData);

        var start = new ProcessStartInfo
        {
            FileName = electron,
            WorkingDirectory = userData,
            Arguments = Quote(root) + " --probe --disable-gpu --no-sandbox --user-data-dir=" + Quote(userData),
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        };
        start.EnvironmentVariables["WIDGET_M0_AUTO_EXIT_MS"] = "120000";
        start.EnvironmentVariables["WIDGET_M0_REPORT"] = report;
        var process = Process.Start(start);
        return process == null ? 3 : 0;
    }

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }
}
