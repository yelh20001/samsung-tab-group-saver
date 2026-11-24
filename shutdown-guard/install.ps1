$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$exe = Join-Path $dir 'SamsungGracefulClose.exe'
$src = Join-Path $dir 'SamsungGracefulClose.cs'

if (-not (Test-Path $exe)) {
  $csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  & $csc /nologo /target:winexe /optimize+ /out:$exe /reference:System.Windows.Forms.dll $src
}

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
Set-ItemProperty -Path $runKey -Name 'SamsungGracefulClose' -Value "`"$exe`""

Get-Process -Name 'SamsungGracefulClose' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Process -FilePath $exe
Write-Output "Installed and started: $exe"
