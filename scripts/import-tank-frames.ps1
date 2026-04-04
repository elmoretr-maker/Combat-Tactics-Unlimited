# Copy Cursor-exported tank cycle into repo as tank_t/run/0.png .. 11.png
# Usage: .\scripts\import-tank-frames.ps1 -SourceDir "C:\path\to\folder\with\t_Animation_1_*.png"
param(
  [Parameter(Mandatory = $true)][string]$SourceDir
)
$dest = Join-Path $PSScriptRoot "..\attached_assets\sprites\tank_t\run"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$files = Get-ChildItem -Path $SourceDir -Filter "*t_Animation_1_*.png" | Sort-Object Name
$i = 0
foreach ($f in $files) {
  if ($i -gt 11) { break }
  Copy-Item $f.FullName (Join-Path $dest "$i.png") -Force
  $i++
}
Write-Host "Copied $i frames to $dest"
