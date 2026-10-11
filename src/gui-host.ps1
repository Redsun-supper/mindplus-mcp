# ============================================================================
# mindplus-mcp GUI host  (Windows)
#
# A long-lived PowerShell process that speaks one JSON object per line over
# stdin/stdout. It exposes screen capture, mouse/keyboard injection, window
# enumeration and clipboard access to the Node side (src/gui.js).
#
# Why a persistent process: Add-Type compiles the C# core once, and input
# injection stays responsive inside tight capture -> locate -> click loops.
#
# NOTE: this file is intentionally pure ASCII. Windows PowerShell 5.1 reads
# .ps1 files as ANSI unless they carry a BOM, so non-ASCII would corrupt.
# ============================================================================

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$csSource = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class MpGui
{
    // ================= interop =================

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct MONITORINFOEX
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
    }

    private delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, ref RECT lprc, IntPtr data);
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] private static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr GetDC(IntPtr h);
    [DllImport("user32.dll")] private static extern int ReleaseDC(IntPtr h, IntPtr dc);
    [DllImport("user32.dll")] private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc cb, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFOEX info);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] private static extern int GetLastError();
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);

    [DllImport("shcore.dll")] private static extern int GetDpiForMonitor(IntPtr monitor, int dpiType, out uint dpiX, out uint dpiY);
    [DllImport("shcore.dll")] private static extern int GetProcessDpiAwareness(IntPtr process, out int value);

    private const int SM_CXSCREEN = 0, SM_CYSCREEN = 1;
    private const int SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77;
    private const int SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;
    private const int SM_CMONITORS = 80;

    private const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
    private const uint MOUSEEVENTF_MOVE = 0x0001, MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
    private const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020, MOUSEEVENTF_MIDDLEUP = 0x0040;
    private const uint MOUSEEVENTF_WHEEL = 0x0800, MOUSEEVENTF_HWHEEL = 0x1000;
    private const uint MOUSEEVENTF_ABSOLUTE = 0x8000, MOUSEEVENTF_VIRTUALDESK = 0x4000;
    private const uint KEYEVENTF_EXTENDEDKEY = 0x0001, KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;
    private const uint GW_OWNER = 4;
    private const int DWMWA_CLOAKED = 14;

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    private struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
    [StructLayout(LayoutKind.Explicit)]
    private struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT { public uint type; public INPUTUNION u; }

    // ================= init =================

    private static bool _ready;
    private static string _awareness = "unknown";

    public static void Init()
    {
        if (_ready) return;
        _ready = true;
        bool ok = false;
        try { ok = SetProcessDpiAwarenessContext(new IntPtr(-4)); }
        catch { }
        if (ok) _awareness = "per-monitor-v2";
        else
        {
            try { ok = SetProcessDPIAware(); } catch { }
            if (ok) _awareness = "system";
            else _awareness = "unaware";
        }
        try
        {
            int value = 0;
            if (GetProcessDpiAwareness(IntPtr.Zero, out value) == 0)
                _awareness = _awareness + " (reported=" + value.ToString() + ")";
        }
        catch { }
    }

    public static string Awareness() { Init(); return _awareness; }

    // ================= helpers =================

    private static Dictionary<string, object> Map() { return new Dictionary<string, object>(); }

    private static void SendMouse(uint flags, int dx, int dy, uint data)
    {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_MOUSE;
        inputs[0].u.mi.dx = dx;
        inputs[0].u.mi.dy = dy;
        inputs[0].u.mi.mouseData = data;
        inputs[0].u.mi.dwFlags = flags;
        inputs[0].u.mi.time = 0;
        inputs[0].u.mi.dwExtraInfo = IntPtr.Zero;
        uint sent = SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
        if (sent == 0) throw new Exception("SendInput(mouse) failed, win32 error " + GetLastError().ToString());
    }

    private static void SendKeyRaw(ushort vk, ushort scan, uint flags)
    {
        INPUT[] inputs = new INPUT[1];
        inputs[0].type = INPUT_KEYBOARD;
        inputs[0].u.ki.wVk = vk;
        inputs[0].u.ki.wScan = scan;
        inputs[0].u.ki.dwFlags = flags;
        inputs[0].u.ki.time = 0;
        inputs[0].u.ki.dwExtraInfo = IntPtr.Zero;
        uint sent = SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
        if (sent == 0) throw new Exception("SendInput(keyboard) failed, win32 error " + GetLastError().ToString());
    }

    private static int VirtualX() { return GetSystemMetrics(SM_XVIRTUALSCREEN); }
    private static int VirtualY() { return GetSystemMetrics(SM_YVIRTUALSCREEN); }
    private static int VirtualW() { return GetSystemMetrics(SM_CXVIRTUALSCREEN); }
    private static int VirtualH() { return GetSystemMetrics(SM_CYVIRTUALSCREEN); }

    private static void MoveAbsolute(int x, int y)
    {
        int vx = VirtualX(), vy = VirtualY();
        int vw = Math.Max(1, VirtualW() - 1), vh = Math.Max(1, VirtualH() - 1);
        int nx = (int)Math.Round((double)(x - vx) * 65535.0 / vw);
        int ny = (int)Math.Round((double)(y - vy) * 65535.0 / vh);
        if (nx < 0) nx = 0; if (nx > 65535) nx = 65535;
        if (ny < 0) ny = 0; if (ny > 65535) ny = 65535;
        SendMouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, nx, ny, 0);
    }

    private static void Glide(int x0, int y0, int x1, int y1, int durationMs)
    {
        if (durationMs <= 0) { MoveAbsolute(x1, y1); return; }
        int steps = Math.Max(2, durationMs / 12);
        for (int i = 1; i <= steps; i++)
        {
            double t = (double)i / steps;
            // ease-in-out so the cursor does not jump on the first frame
            double e = t < 0.5 ? 2 * t * t : 1 - Math.Pow(-2 * t + 2, 2) / 2;
            int x = x0 + (int)Math.Round((x1 - x0) * e);
            int y = y0 + (int)Math.Round((y1 - y0) * e);
            MoveAbsolute(x, y);
            Thread.Sleep(Math.Max(1, durationMs / steps));
        }
    }

    private static uint ButtonFlag(string button, bool down)
    {
        string b = (button == null ? "left" : button.ToLowerInvariant());
        if (b == "right") return down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP;
        if (b == "middle" || b == "wheel") return down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP;
        if (b != "left") throw new Exception("unknown mouse button \"" + button + "\" (use left, right or middle)");
        return down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP;
    }

    private static int VkFor(string token)
    {
        string k = token.Trim().ToLowerInvariant();
        if (k.Length == 0) throw new Exception("empty key name in combo");
        if (k.StartsWith("vk:"))
        {
            string rest = k.Substring(3);
            if (rest.StartsWith("0x")) return Convert.ToInt32(rest, 16);
            return int.Parse(rest);
        }
        if (k.Length == 1)
        {
            char c = k[0];
            if (c >= 'a' && c <= 'z') return (int)(c - 'a' + 0x41);
            if (c >= '0' && c <= '9') return (int)(c - '0' + 0x30);
        }
        if (k.StartsWith("f") && k.Length <= 3)
        {
            int n;
            if (int.TryParse(k.Substring(1), out n) && n >= 1 && n <= 24) return 0x6F + n;
        }
        switch (k)
        {
            case "enter": case "return": case "cr": return 0x0D;
            case "tab": return 0x09;
            case "esc": case "escape": return 0x1B;
            case "space": case "spacebar": return 0x20;
            case "backspace": case "bksp": return 0x08;
            case "delete": case "del": return 0x2E;
            case "insert": case "ins": return 0x2D;
            case "home": return 0x24;
            case "end": return 0x23;
            case "pageup": case "pgup": case "prior": return 0x21;
            case "pagedown": case "pgdn": case "next": return 0x22;
            case "up": case "arrowup": return 0x26;
            case "down": case "arrowdown": return 0x28;
            case "left": case "arrowleft": return 0x25;
            case "right": case "arrowright": return 0x27;
            case "shift": case "lshift": return 0x10;
            case "rshift": return 0xA1;
            case "ctrl": case "control": case "lctrl": return 0x11;
            case "rctrl": return 0xA3;
            case "alt": case "lalt": return 0x12;
            case "ralt": case "altgr": return 0xA5;
            case "win": case "lwin": case "meta": case "cmd": case "super": return 0x5B;
            case "rwin": return 0x5C;
            case "apps": case "contextmenu": case "menu": return 0x5D;
            case "capslock": return 0x14;
            case "numlock": return 0x90;
            case "scrolllock": return 0x91;
            case "printscreen": case "prtsc": case "snapshot": return 0x2C;
            case "pause": case "break": return 0x13;
            case "semicolon": return 0xBA;
            case "equal": case "equals": return 0xBB;
            case "comma": return 0xBC;
            case "minus": return 0xBD;
            case "period": case "dot": return 0xBE;
            case "slash": return 0xBF;
            case "grave": case "backtick": return 0xC0;
            case "bracketleft": case "leftbracket": return 0xDB;
            case "backslash": return 0xDC;
            case "bracketright": case "rightbracket": return 0xDD;
            case "quote": case "apostrophe": return 0xDE;
            case "plus": case "add": return 0x6B;
            case "multiply": return 0x6A;
            case "subtract": return 0x6D;
            case "decimal": return 0x6E;
            case "divide": return 0x6F;
            case "numpad0": return 0x60; case "numpad1": return 0x61; case "numpad2": return 0x62;
            case "numpad3": return 0x63; case "numpad4": return 0x64; case "numpad5": return 0x65;
            case "numpad6": return 0x66; case "numpad7": return 0x67; case "numpad8": return 0x68;
            case "numpad9": return 0x69;
        }
        throw new Exception("unknown key \"" + token + "\" (try vk:0x41 or a name like enter, f5, pageup)");
    }

    private static bool IsExtended(int vk)
    {
        switch (vk)
        {
            case 0x21: case 0x22: case 0x23: case 0x24: case 0x25: case 0x26: case 0x27: case 0x28:
            case 0x2D: case 0x2E: case 0x5B: case 0x5C: case 0x5D: case 0x6F: case 0xA3: case 0xA5:
            case 0x90: case 0x2C:
                return true;
            default:
                return false;
        }
    }

    private static string ComboNormalized(string combo)
    {
        string[] parts = combo.Split('+');
        List<string> kept = new List<string>();
        foreach (string p in parts) if (p.Trim().Length > 0) kept.Add(p.Trim());
        return string.Join("+", kept.ToArray());
    }

    // ================= screen =================

    public static Dictionary<string, object> ScreenInfo()
    {
        Init();
        Dictionary<string, object> m = Map();
        m["awareness"] = _awareness;
        m["primary"] = new Dictionary<string, object> {
            { "width", GetSystemMetrics(SM_CXSCREEN) },
            { "height", GetSystemMetrics(SM_CYSCREEN) },
        };
        m["virtualDesktop"] = new Dictionary<string, object> {
            { "x", VirtualX() }, { "y", VirtualY() },
            { "width", VirtualW() }, { "height", VirtualH() },
        };
        m["monitorCount"] = GetSystemMetrics(SM_CMONITORS);
        m["monitors"] = Monitors();
        POINT p;
        if (GetCursorPos(out p)) m["cursor"] = new Dictionary<string, object> { { "x", p.X }, { "y", p.Y } };
        return m;
    }

    public static List<Dictionary<string, object>> Monitors()
    {
        Init();
        List<Dictionary<string, object>> list = new List<Dictionary<string, object>>();
        MonitorEnumProc cb = delegate(IntPtr monitor, IntPtr hdc, ref RECT r, IntPtr data)
        {
            Dictionary<string, object> m = Map();
            MONITORINFOEX info = new MONITORINFOEX();
            info.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
            bool got = GetMonitorInfo(monitor, ref info);
            string device = info.szDevice == null ? "" : info.szDevice;
            m["device"] = device;
            m["x"] = r.Left; m["y"] = r.Top;
            m["width"] = r.Right - r.Left; m["height"] = r.Bottom - r.Top;
            m["primary"] = got && (info.dwFlags & 1) != 0;
            if (got)
            {
                m["workX"] = info.rcWork.Left; m["workY"] = info.rcWork.Top;
                m["workWidth"] = info.rcWork.Right - info.rcWork.Left;
                m["workHeight"] = info.rcWork.Bottom - info.rcWork.Top;
            }
            try
            {
                uint dx, dy;
                if (GetDpiForMonitor(monitor, 0, out dx, out dy) == 0)
                {
                    m["dpiX"] = (int)dx; m["dpiY"] = (int)dy;
                    m["scale"] = Math.Round((double)dx / 96.0, 4);
                }
            }
            catch { }
            list.Add(m);
            return true;
        };
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, cb, IntPtr.Zero);
        return list;
    }

    public static Dictionary<string, object> CursorPos()
    {
        Init();
        POINT p;
        if (!GetCursorPos(out p)) throw new Exception("GetCursorPos failed");
        return new Dictionary<string, object> { { "x", p.X }, { "y", p.Y } };
    }

    public static Dictionary<string, object> PixelColor(int x, int y)
    {
        Init();
        using (Bitmap bmp = new Bitmap(1, 1))
        {
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.CopyFromScreen(x, y, 0, 0, new Size(1, 1));
            }
            Color c = bmp.GetPixel(0, 0);
            return new Dictionary<string, object> {
                { "x", x }, { "y", y },
                { "r", (int)c.R }, { "g", (int)c.G }, { "b", (int)c.B }, { "a", (int)c.A },
                { "hex", string.Format("#{0:X2}{1:X2}{2:X2}", c.R, c.G, c.B) },
            };
        }
    }

    // ================= capture =================

    private static ImageCodecInfo JpegCodec()
    {
        ImageCodecInfo[] codecs = ImageCodecInfo.GetImageEncoders();
        foreach (ImageCodecInfo c in codecs) if (c.FormatID == ImageFormat.Jpeg.Guid) return c;
        return null;
    }

    public static Dictionary<string, object> Capture(int x, int y, int w, int h, string path, string format, int quality, string handle, bool printWindow)
    {
        Init();
        if (w <= 0 || h <= 0) throw new Exception("capture width/height must be positive");
        Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
        IntPtr hwnd = IntPtr.Zero;
        if (handle != null && handle.Length > 0) hwnd = ParseHandle(handle);
        try
        {
            using (Graphics g = Graphics.FromImage(bmp))
            {
                if (hwnd != IntPtr.Zero)
                {
                    IntPtr hdc = g.GetHdc();
                    bool ok;
                    try { ok = PrintWindow(hwnd, hdc, printWindow ? 2u : 0u); }
                    finally { g.ReleaseHdc(hdc); }
                    if (!ok)
                    {
                        // PrintWindow can fail for some DWM surfaces; fall back to the screen copy
                        g.CopyFromScreen(x, y, 0, 0, new Size(w, h));
                    }
                }
                else
                {
                    g.CopyFromScreen(x, y, 0, 0, new Size(w, h));
                }
            }
            if (path != null && path.Length > 0)
            {
                string dir = Path.GetDirectoryName(path);
                if (dir != null && dir.Length > 0 && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
                string fmt = (format == null ? "png" : format.ToLowerInvariant());
                if (fmt == "jpg" || fmt == "jpeg")
                {
                    ImageCodecInfo codec = JpegCodec();
                    EncoderParameters pars = new EncoderParameters(1);
                    int q = quality <= 0 ? 90 : quality;
                    if (q > 100) q = 100;
                    pars.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)q);
                    bmp.Save(path, codec, pars);
                    pars.Dispose();
                }
                else
                {
                    bmp.Save(path, ImageFormat.Png);
                }
            }
            Dictionary<string, object> m = Map();
            m["x"] = x; m["y"] = y; m["width"] = w; m["height"] = h;
            m["handle"] = hwnd == IntPtr.Zero ? null : "0x" + hwnd.ToInt64().ToString("X");
            if (path != null && path.Length > 0)
            {
                FileInfo fi = new FileInfo(path);
                m["path"] = path;
                m["bytes"] = fi.Exists ? fi.Length : 0;
            }
            m["virtualDesktop"] = new Dictionary<string, object> {
                { "x", VirtualX() }, { "y", VirtualY() },
                { "width", VirtualW() }, { "height", VirtualH() },
            };
            return m;
        }
        finally
        {
            bmp.Dispose();
        }
    }

    // ================= mouse =================

    public static Dictionary<string, object> MouseMove(int x, int y, int durationMs, bool dryRun)
    {
        Init();
        Dictionary<string, object> m = Map();
        POINT before;
        GetCursorPos(out before);
        m["from"] = new Dictionary<string, object> { { "x", before.X }, { "y", before.Y } };
        m["to"] = new Dictionary<string, object> { { "x", x }, { "y", y } };
        m["dryRun"] = dryRun;
        if (!dryRun)
        {
            Glide(before.X, before.Y, x, y, durationMs);
            POINT after;
            GetCursorPos(out after);
            m["cursor"] = new Dictionary<string, object> { { "x", after.X }, { "y", after.Y } };
        }
        return m;
    }

    public static Dictionary<string, object> MouseClick(int x, int y, string button, int count, int intervalMs, int holdMs, bool dryRun)
    {
        Init();
        Dictionary<string, object> m = Map();
        m["x"] = x; m["y"] = y; m["button"] = button; m["count"] = count;
        m["dryRun"] = dryRun;
        if (dryRun) return m;
        MoveAbsolute(x, y);
        POINT after;
        GetCursorPos(out after);
        if (after.X != x || after.Y != y)
        {
            // multi-monitor desktops can clamp; report where we actually landed
            m["cursor"] = new Dictionary<string, object> { { "x", after.X }, { "y", after.Y } };
        }
        for (int i = 0; i < count; i++)
        {
            SendMouse(ButtonFlag(button, true), 0, 0, 0);
            if (holdMs > 0) Thread.Sleep(holdMs);
            SendMouse(ButtonFlag(button, false), 0, 0, 0);
            if (i < count - 1 && intervalMs > 0) Thread.Sleep(intervalMs);
        }
        m["clicked"] = true;
        return m;
    }

    public static Dictionary<string, object> MouseButton(int x, int y, string button, bool down, bool dryRun)
    {
        Init();
        Dictionary<string, object> m = Map();
        m["x"] = x; m["y"] = y; m["button"] = button; m["down"] = down; m["dryRun"] = dryRun;
        if (dryRun) return m;
        if (x >= 0 || y >= 0) MoveAbsolute(x, y);
        SendMouse(ButtonFlag(button, down), 0, 0, 0);
        return m;
    }

    public static Dictionary<string, object> MouseDrag(int x1, int y1, int x2, int y2, int durationMs, string button, bool dryRun)
    {
        Init();
        Dictionary<string, object> m = Map();
        m["from"] = new Dictionary<string, object> { { "x", x1 }, { "y", y1 } };
        m["to"] = new Dictionary<string, object> { { "x", x2 }, { "y", y2 } };
        m["button"] = button; m["durationMs"] = durationMs; m["dryRun"] = dryRun;
        if (dryRun) return m;
        MoveAbsolute(x1, y1);
        Thread.Sleep(30);
        SendMouse(ButtonFlag(button, true), 0, 0, 0);
        Thread.Sleep(30);
        Glide(x1, y1, x2, y2, durationMs);
        Thread.Sleep(30);
        SendMouse(ButtonFlag(button, false), 0, 0, 0);
        m["dragged"] = true;
        return m;
    }

    public static Dictionary<string, object> MouseScroll(int x, int y, int deltaV, int deltaH, bool dryRun)
    {
        Init();
        Dictionary<string, object> m = Map();
        m["x"] = x; m["y"] = y; m["deltaV"] = deltaV; m["deltaH"] = deltaH; m["dryRun"] = dryRun;
        if (dryRun) return m;
        MoveAbsolute(x, y);
        int notches = Math.Abs(deltaV);
        uint step = 120;
        for (int i = 0; i < notches; i++)
        {
            SendMouse(MOUSEEVENTF_WHEEL, 0, 0, deltaV > 0 ? step : unchecked((uint)(-(int)step)));
            Thread.Sleep(12);
        }
        int hnotches = Math.Abs(deltaH);
        for (int i = 0; i < hnotches; i++)
        {
            SendMouse(MOUSEEVENTF_HWHEEL, 0, 0, deltaH > 0 ? step : unchecked((uint)(-(int)step)));
            Thread.Sleep(12);
        }
        m["scrolled"] = true;
        return m;
    }

    // ================= keyboard =================

    public static Dictionary<string, object> KeyPress(string combo, bool dryRun)
    {
        Init();
        Dictionary<string, object> m = Map();
        m["combo"] = ComboNormalized(combo); m["dryRun"] = dryRun;
        List<int> vks = new List<int>();
        foreach (string token in ComboNormalized(combo).Split('+')) vks.Add(VkFor(token));
        m["vk"] = vks.ToArray();
        if (dryRun) return m;
        for (int i = 0; i < vks.Count; i++)
        {
            uint f = IsExtended(vks[i]) ? KEYEVENTF_EXTENDEDKEY : 0;
            SendKeyRaw((ushort)vks[i], 0, f);
        }
        for (int i = vks.Count - 1; i >= 0; i--)
        {
            uint f = (IsExtended(vks[i]) ? KEYEVENTF_EXTENDEDKEY : 0) | KEYEVENTF_KEYUP;
            SendKeyRaw((ushort)vks[i], 0, f);
        }
        m["pressed"] = true;
        return m;
    }

    public static Dictionary<string, object> KeyType(string value, int delayMs, bool dryRun)
    {
        Init();
        Dictionary<string, object> m = Map();
        string s = value == null ? "" : value;
        m["length"] = s.Length; m["dryRun"] = dryRun;
        if (dryRun) return m;
        int sent = 0;
        foreach (char ch in s)
        {
            if (ch == '\r') continue;
            if (ch == '\n' || ch == '\t')
            {
                ushort vk = ch == '\n' ? (ushort)0x0D : (ushort)0x09;
                SendKeyRaw(vk, 0, 0);
                SendKeyRaw(vk, 0, KEYEVENTF_KEYUP);
            }
            else
            {
                SendKeyRaw(0, ch, KEYEVENTF_UNICODE);
                SendKeyRaw(0, ch, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
            }
            sent++;
            if (delayMs > 0) Thread.Sleep(delayMs);
        }
        m["sent"] = sent;
        return m;
    }

    // ================= clipboard =================

    public static string ClipboardGet()
    {
        Init();
        string result = null;
        Exception err = null;
        Thread t = new Thread(delegate()
        {
            try { if (System.Windows.Forms.Clipboard.ContainsText()) result = System.Windows.Forms.Clipboard.GetText(); else result = ""; }
            catch (Exception e) { err = e; }
        });
        t.SetApartmentState(ApartmentState.STA);
        t.Start();
        t.Join();
        if (err != null) throw err;
        return result;
    }

    public static Dictionary<string, object> ClipboardSet(string value)
    {
        Init();
        Exception err = null;
        Thread t = new Thread(delegate()
        {
            try { System.Windows.Forms.Clipboard.SetText(value == null ? "" : value); }
            catch (Exception e) { err = e; }
        });
        t.SetApartmentState(ApartmentState.STA);
        t.Start();
        t.Join();
        if (err != null) throw err;
        return new Dictionary<string, object> { { "length", (value == null ? 0 : value.Length) } };
    }

    // ================= windows =================

    private static string WindowText(IntPtr h)
    {
        // Always pass a real buffer: the "query the length with a null buffer"
        // idiom does not marshal through StringBuilder in .NET Framework.
        StringBuilder sb = new StringBuilder(512);
        int len = GetWindowTextW(h, sb, sb.Capacity);
        if (len <= 0) return "";
        return sb.ToString(0, len);
    }

    private static string ClassName(IntPtr h)
    {
        StringBuilder sb = new StringBuilder(256);
        GetClassNameW(h, sb, sb.Capacity);
        return sb.ToString();
    }

    private static bool IsCloaked(IntPtr h)
    {
        try
        {
            int value;
            if (DwmGetWindowAttribute(h, DWMWA_CLOAKED, out value, 4) == 0) return value != 0;
        }
        catch { }
        return false;
    }

    public static List<Dictionary<string, object>> ListWindows(bool visibleOnly, bool titledOnly, bool includeCloaked, bool includeOwned)
    {
        Init();
        IntPtr foreground = GetForegroundWindow();
        List<Dictionary<string, object>> list = new List<Dictionary<string, object>>();
        EnumWindowsProc cb = delegate(IntPtr h, IntPtr lparam)
        {
            if (visibleOnly && !IsWindowVisible(h)) return true;
            if (!includeOwned && GetWindow(h, GW_OWNER) != IntPtr.Zero) return true;
            if (!includeCloaked && IsCloaked(h)) return true;
            string title = WindowText(h);
            if (titledOnly && title.Trim().Length == 0) return true;
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            int w = r.Right - r.Left, hh = r.Bottom - r.Top;
            Dictionary<string, object> m = Map();
            m["handle"] = "0x" + h.ToInt64().ToString("X");
            m["title"] = title;
            m["className"] = ClassName(h);
            m["x"] = r.Left; m["y"] = r.Top; m["width"] = w; m["height"] = hh;
            m["visible"] = IsWindowVisible(h);
            m["minimized"] = IsIconic(h);
            m["maximized"] = IsZoomed(h);
            m["foreground"] = h == foreground;
            uint windowPid = 0;
            uint tid = GetWindowThreadProcessId(h, out windowPid);
            m["threadId"] = (int)tid;
            try
            {
                int pid = (int)windowPid;
                m["pid"] = pid;
                if (pid > 0) m["process"] = Process.GetProcessById(pid).ProcessName;
            }
            catch { }
            list.Add(m);
            return true;
        };
        EnumWindows(cb, IntPtr.Zero);
        return list;
    }

    private static IntPtr ParseHandle(string handle)
    {
        if (handle == null || handle.Trim().Length == 0) throw new Exception("empty window handle");
        string s = handle.Trim();
        if (s.StartsWith("0x") || s.StartsWith("0X")) return new IntPtr(Convert.ToInt64(s.Substring(2), 16));
        return new IntPtr(long.Parse(s));
    }

    public static Dictionary<string, object> WindowRect(string handle)
    {
        Init();
        IntPtr h = ParseHandle(handle);
        if (!IsWindow(h)) throw new Exception("window handle " + handle + " is not a valid window");
        RECT r;
        if (!GetWindowRect(h, out r)) throw new Exception("GetWindowRect failed for " + handle);
        return new Dictionary<string, object> {
            { "handle", "0x" + h.ToInt64().ToString("X") },
            { "title", WindowText(h) },
            { "className", ClassName(h) },
            { "x", r.Left }, { "y", r.Top },
            { "width", r.Right - r.Left }, { "height", r.Bottom - r.Top },
            { "minimized", IsIconic(h) }, { "maximized", IsZoomed(h) },
            { "foreground", h == GetForegroundWindow() },
        };
    }

    public static Dictionary<string, object> ActivateWindow(string handle, int waitMs)
    {
        Init();
        IntPtr h = ParseHandle(handle);
        if (!IsWindow(h)) throw new Exception("window handle " + handle + " is not a valid window");
        if (IsIconic(h)) ShowWindow(h, 9); // SW_RESTORE
        bool ok = SetForegroundWindow(h);
        if (!ok)
        {
            // SetForegroundWindow is refused unless the caller owns the foreground;
            // the documented workaround is to borrow the foreground thread's input queue.
            IntPtr fg = GetForegroundWindow();
            uint fgPid = 0;
            uint target = GetWindowThreadProcessId(fg, out fgPid);
            uint self = GetCurrentThreadId();
            if (target != self)
            {
                AttachThreadInput(target, self, true);
                try { ok = SetForegroundWindow(h); }
                finally { AttachThreadInput(target, self, false); }
            }
        }
        BringWindowToTop(h);
        if (waitMs > 0) Thread.Sleep(waitMs);
        return new Dictionary<string, object> {
            { "handle", "0x" + h.ToInt64().ToString("X") },
            { "title", WindowText(h) },
            { "foreground", h == GetForegroundWindow() },
            { "requested", true },
        };
    }
}
'@

$addTypeArgs = @{
  TypeDefinition    = $csSource
  ReferencedAssemblies = @('System.Drawing', 'System.Windows.Forms')
}
Add-Type @addTypeArgs

# ---------------------------------------------------------------------------
# command dispatch
# ---------------------------------------------------------------------------

function Convert-ToInt($value, $fallback) {
  if ($null -eq $value) { return $fallback }
  return [int]$value
}

function Invoke-MpCommand($req) {
  $cmd = [string]$req.cmd
  $a = $req.args
  switch ($cmd) {
    'ping'            { return @{ pong = $true; awareness = [MpGui]::Awareness() } }
    'screen_info'     { return [MpGui]::ScreenInfo() }
    'monitors'        { return @{ monitors = [MpGui]::Monitors() } }
    'cursor_pos'      { return [MpGui]::CursorPos() }
    'pixel_color'     { return [MpGui]::PixelColor((Convert-ToInt $a.x 0), (Convert-ToInt $a.y 0)) }
    'capture'         {
      return [MpGui]::Capture((Convert-ToInt $a.x 0), (Convert-ToInt $a.y 0), (Convert-ToInt $a.width 0), (Convert-ToInt $a.height 0),
        [string]$a.path, [string]$a.format, (Convert-ToInt $a.quality 90), [string]$a.handle, [bool]$a.printWindow)
    }
    'mouse_move'      { return [MpGui]::MouseMove((Convert-ToInt $a.x 0), (Convert-ToInt $a.y 0), (Convert-ToInt $a.durationMs 0), [bool]$a.dryRun) }
    'mouse_click'     { return [MpGui]::MouseClick((Convert-ToInt $a.x 0), (Convert-ToInt $a.y 0), [string]$a.button, (Convert-ToInt $a.count 1), (Convert-ToInt $a.intervalMs 60), (Convert-ToInt $a.holdMs 0), [bool]$a.dryRun) }
    'mouse_button'    { return [MpGui]::MouseButton((Convert-ToInt $a.x -1), (Convert-ToInt $a.y -1), [string]$a.button, [bool]$a.down, [bool]$a.dryRun) }
    'mouse_drag'      {
      return [MpGui]::MouseDrag((Convert-ToInt $a.fromX 0), (Convert-ToInt $a.fromY 0), (Convert-ToInt $a.toX 0), (Convert-ToInt $a.toY 0),
        (Convert-ToInt $a.durationMs 300), [string]$a.button, [bool]$a.dryRun)
    }
    'mouse_scroll'    { return [MpGui]::MouseScroll((Convert-ToInt $a.x 0), (Convert-ToInt $a.y 0), (Convert-ToInt $a.deltaV 0), (Convert-ToInt $a.deltaH 0), [bool]$a.dryRun) }
    'key_press'       { return [MpGui]::KeyPress([string]$a.combo, [bool]$a.dryRun) }
    'key_type'        { return [MpGui]::KeyType([string]$a.text, (Convert-ToInt $a.delayMs 0), [bool]$a.dryRun) }
    'clipboard_get'   { return @{ text = [MpGui]::ClipboardGet() } }
    'clipboard_set'   { return [MpGui]::ClipboardSet([string]$a.text) }
    'window_list'     { return @{ windows = [MpGui]::ListWindows([bool]$a.visibleOnly, [bool]$a.titledOnly, [bool]$a.includeCloaked, [bool]$a.includeOwned) } }
    'window_rect'     { return [MpGui]::WindowRect([string]$a.handle) }
    'window_activate' { return [MpGui]::ActivateWindow([string]$a.handle, (Convert-ToInt $a.waitMs 150)) }
    default           { throw "unknown command `"$cmd`"" }
  }
}

$hostReady = @{ ready = $true; awareness = [MpGui]::Awareness(); pid = $PID } | ConvertTo-Json -Compress
[Console]::Out.WriteLine($hostReady)
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  $id = $null
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id
    $result = Invoke-MpCommand $req
    $resp = @{ id = $id; ok = $true; result = $result } | ConvertTo-Json -Depth 16 -Compress
  } catch {
    # PowerShell wraps .NET calls in a MethodInvocationException whose own
    # message is localised boilerplate; the useful text is on the inner one.
    $ex = $_.Exception
    $msg = $null
    if ($ex.InnerException -and $ex.InnerException.Message) { $msg = $ex.InnerException.Message }
    if ($null -eq $msg -or $msg.Trim().Length -eq 0) { $msg = $ex.Message }
    if ($null -eq $msg -or $msg.Trim().Length -eq 0) { $msg = $ex.GetType().FullName }
    $resp = @{ id = $id; ok = $false; error = $msg } | ConvertTo-Json -Compress
  }
  [Console]::Out.WriteLine($resp)
  [Console]::Out.Flush()
}
