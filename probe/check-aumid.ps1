# 读内核窗口上的 AUMID（任务栏分组键），验证品牌前缀已不是 Chromium。
#
# 不读代码、不靠肉眼：直接问 Windows 窗口属性存储里的 System.AppUserModel.ID。
# 这一项与地址栏那类原生 UI 不同，程序拿得到，所以不该退化成人工确认。
#
# 同时验两件事，缺一不可：
#   1. 前缀已是 Yunbrowser（正例）
#   2. 两个不同 profile 的 AUMID 互不相同（反例）——别为了改前缀把 profile 哈希
#      弄丢了，那会让所有店铺环境在任务栏上合并成一个按钮，比留着 Chromium 严重。

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$KERNEL = 'D:\yunbrowser-run\yunbrowser.exe'
$PROFILES = @(
  'D:\chromium-work-151\probe\prof-aumid-a',
  'D:\chromium-work-151\probe\prof-aumid-b'
)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class Aumid {
  [StructLayout(LayoutKind.Sequential)]
  public struct PropertyKey { public Guid fmtid; public uint pid; }

  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropertyStore {
    void GetCount(out uint c);
    void GetAt(uint i, out PropertyKey k);
    void GetValue(ref PropertyKey k, [Out] out PropVariant v);
    void SetValue(ref PropertyKey k, ref PropVariant v);
    void Commit();
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PropVariant {
    public ushort vt; ushort r1; ushort r2; ushort r3;
    public IntPtr p; int p2;
    public string AsString() { return vt == 31 ? Marshal.PtrToStringUni(p) : null; }
  }

  [DllImport("shell32.dll")]
  static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid iid, out IPropertyStore store);

  public static string Get(IntPtr hwnd) {
    Guid iid = new Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99");
    IPropertyStore store;
    if (SHGetPropertyStoreForWindow(hwnd, ref iid, out store) != 0 || store == null) {
      return null;
    }
    // PKEY_AppUserModel_ID
    PropertyKey key = new PropertyKey();
    key.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
    key.pid = 5;
    PropVariant v;
    store.GetValue(ref key, out v);
    return v.AsString();
  }
}
'@ 2>$null

Get-Process yunbrowser -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
Start-Sleep -Seconds 3

foreach ($p in $PROFILES) {
  Start-Process -FilePath $KERNEL -ArgumentList `
    '--no-first-run', '--no-default-browser-check', "--user-data-dir=$p", '--fp-shell', 'about:blank' | Out-Null
  Start-Sleep -Seconds 8
}

$rows = @()
foreach ($proc in Get-Process yunbrowser -EA SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }) {
  $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.Id)" -EA SilentlyContinue).CommandLine
  $dir = if ($cl -match '--user-data-dir=([^\s"]+)') { Split-Path $matches[1] -Leaf } else { '?' }
  $id = [Aumid]::Get($proc.MainWindowHandle)
  $rows += [pscustomobject]@{ Profile = $dir; AUMID = $id }
}

$rows | Format-Table -Auto

$ids = $rows | Where-Object { $_.AUMID } | Select-Object -ExpandProperty AUMID
$prefixOk = ($ids.Count -gt 0) -and -not ($ids | Where-Object { $_ -like 'Chromium*' })
$distinct = ($ids | Select-Object -Unique).Count -eq $ids.Count -and $ids.Count -ge 2

"前缀已不是 Chromium : {0}" -f $(if ($prefixOk) { '✓' } else { '✗' })
"两 profile 各不相同   : {0}" -f $(if ($distinct) { '✓' } else { '✗' })
if ($prefixOk -and $distinct) { "`n★ 通过" } else { "`n★ 未通过" }

Get-Process yunbrowser -EA SilentlyContinue | Stop-Process -Force -EA SilentlyContinue
exit 0
