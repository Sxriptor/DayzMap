// Finds a running game's main window (DayZ_x64, DayZDiag_x64): its handle, and its game area (client rect)
// as fractions of the whole window, which is what a window capture shows. Used by Mapino's locate and by
// npm run capture:run. Windows only (PowerShell + user32/dwmapi).
const { spawnSync } = require('node:child_process');

const SCRIPT = process => `
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class W {
  public struct R { public int L, T, Rt, B; } public struct P { public int X, Y; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref P p);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out R r, int s);
}
'@
[W]::SetProcessDPIAware() | Out-Null
$h = (Get-Process ${process} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).MainWindowHandle
if (-not $h) { exit }
$f = New-Object W+R; [W]::DwmGetWindowAttribute($h, 9, [ref]$f, 16) | Out-Null
$c = New-Object W+R; [W]::GetClientRect($h, [ref]$c) | Out-Null
$p = New-Object W+P; [W]::ClientToScreen($h, [ref]$p) | Out-Null
"$($h.ToInt64()) $($f.L) $($f.T) $($f.Rt) $($f.B) $($p.X) $($p.Y) $($c.Rt) $($c.B) $([int][W]::IsIconic($h))"`;

// { hwnd, crop: [x, y, w, h] fractions of the window frame, minimized } or null when the game isn't running.
function measureWindow(processName) {
  const script = Buffer.from(SCRIPT(processName), 'utf16le').toString('base64');
  const out = spawnSync('powershell', ['-NoProfile', '-EncodedCommand', script], { encoding: 'utf8', windowsHide: true }).stdout || '';
  const v = out.trim().split(/\s+/).map(Number);
  if (v.length !== 10 || !v[0]) return null;
  const [hwnd, fl, ft, fr, fb, cx, cy, cw, ch, iconic] = v, fw = fr - fl, fh = fb - ft;
  return { hwnd, crop: [(cx - fl) / fw, (cy - ft) / fh, cw / fw, ch / fh], minimized: iconic === 1 };
}

module.exports = { measureWindow };
