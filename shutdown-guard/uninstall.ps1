$ErrorActionPreference = 'Stop'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
Remove-ItemProperty -Path $runKey -Name 'SamsungGracefulClose' -ErrorAction SilentlyContinue
Get-Process -Name 'SamsungGracefulClose' -ErrorAction SilentlyContinue | Stop-Process -Force
Write-Output 'Uninstalled SamsungGracefulClose.'
