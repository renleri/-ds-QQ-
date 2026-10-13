# 只读方式读取某个进程所属控制台窗口的历史缓冲区，从中找 DSH 的 launch token。
#
# 原理：token 只出现在 `dsh web` 的启动输出里（没落盘）。而那个进程所属的控制台
# 缓冲区仍在内存中，可以用 AttachConsole + ReadConsoleOutputCharacterW 读出来。
# 只读：不写入、不改变目标窗口任何状态。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File _tools\read-console-token.ps1 -TargetPid 72820
# 注意：参数不能叫 $TargetPid —— 它是 PowerShell 的只读自动变量（当前进程 ID），赋值会直接报错。
param([Parameter(Mandatory=$true)][int]$TargetPid)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class ConReader {
  [StructLayout(LayoutKind.Sequential)] public struct COORD { public short X; public short Y; }
  [StructLayout(LayoutKind.Sequential)] public struct SMALL_RECT { public short Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct CONSOLE_SCREEN_BUFFER_INFO {
    public COORD dwSize; public COORD dwCursorPosition; public ushort wAttributes;
    public SMALL_RECT srWindow; public COORD dwMaximumWindowSize;
  }
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint dwProcessId);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr GetStdHandle(int nStdHandle);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetConsoleScreenBufferInfo(IntPtr h, out CONSOLE_SCREEN_BUFFER_INFO info);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool ReadConsoleOutputCharacterW(IntPtr h, StringBuilder buf, uint len, COORD pos, out uint read);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode,
    IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);
}
"@

# AttachConsole 要求调用进程自己**没有**控制台；本脚本从 harness 里跑时通常已带一个，
# 所以先 FreeConsole 释放（失败也无妨，继续试 attach）。
try { [void][ConReader]::FreeConsole() } catch { }
$attached = [ConReader]::AttachConsole([uint32]$TargetPid)
if (-not $attached) {
  $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  Write-Output "ATTACH_FAILED errno=$err"
  exit 1
}

try {
  # attach 之后标准句柄不会自动指向新控制台，必须用 CONOUT$ 重新打开。
  # GENERIC_READ = 0x80000000，FILE_SHARE_READ|WRITE = 3，OPEN_EXISTING = 3。
  $h = [ConReader]::CreateFileW('CONOUT$', [uint32]2147483648, [uint32]3, [IntPtr]::Zero, [uint32]3, [uint32]0, [IntPtr]::Zero)
  if ($h -eq [IntPtr]::Zero -or $h -eq [IntPtr](-1)) {
    Write-Output ("CONOUT_FAILED errno=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
    exit 1
  }
  $info = New-Object ConReader+CONSOLE_SCREEN_BUFFER_INFO
  if (-not [ConReader]::GetConsoleScreenBufferInfo($h, [ref]$info)) {
    Write-Output ("INFO_FAILED errno=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error())
    exit 1
  }
  $width = [int]$info.dwSize.X
  $height = [int]$info.dwSize.Y
  Write-Output "BUFFER ${width}x${height}"

  $sb = New-Object System.Text.StringBuilder
  $read = [uint32]0
  # 逐行读整个缓冲区（只读）
  for ($y = 0; $y -lt $height; $y++) {
    $buf = New-Object System.Text.StringBuilder ($width + 1)
    $pos = New-Object ConReader+COORD
    $pos.X = 0; $pos.Y = [int16]$y
    if ([ConReader]::ReadConsoleOutputCharacterW($h, $buf, [uint32]$width, $pos, [ref]$read)) {
      [void]$sb.AppendLine($buf.ToString())
    }
  }
  $text = $sb.ToString()
  Write-Output "TEXTLEN $($text.Length)"

  $m = [regex]::Matches($text, '[?&]token=([A-Za-z0-9_\-\.]{16,})')
  if ($m.Count -gt 0) {
    # 只打印 token 本身，不打印整段缓冲（避免把无关内容带出来）
    Write-Output ("TOKEN " + $m[$m.Count - 1].Groups[1].Value)
  } else {
    Write-Output "NO_TOKEN_FOUND"
  }
} finally {
  [void][ConReader]::FreeConsole()
}
