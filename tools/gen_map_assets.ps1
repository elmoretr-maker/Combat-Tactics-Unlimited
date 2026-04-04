Add-Type -AssemblyName System.Drawing

function New-MapBmp {
  param([string]$Path, [int]$W, [int]$H, [int[]]$BaseRgb, [int]$Noise)
  $b = New-Object Drawing.Bitmap($W, $H)
  $rnd = [Random]::new(42)
  for ($yy = 0; $yy -lt $H; $yy++) {
    for ($xx = 0; $xx -lt $W; $xx++) {
      $n = [int](($rnd.NextDouble() - 0.5) * $Noise)
      $c = [Drawing.Color]::FromArgb(
        [Math]::Max(0, [Math]::Min(255, $BaseRgb[0] + $n)),
        [Math]::Max(0, [Math]::Min(255, $BaseRgb[1] + $n)),
        [Math]::Max(0, [Math]::Min(255, $BaseRgb[2] + $n)))
      $b.SetPixel($xx, $yy, $c)
    }
  }
  $b.Save($Path, [Drawing.Imaging.ImageFormat]::Png)
  $b.Dispose()
}

function New-PropBmp {
  param([string]$Path, [string]$ColorHex)
  $b = New-Object Drawing.Bitmap(56, 56)
  $g = [Drawing.Graphics]::FromImage($b)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([Drawing.Color]::FromArgb(0, 0, 0, 0))
  $brush = New-Object Drawing.SolidBrush ([Drawing.ColorTranslator]::FromHtml($ColorHex))
  $pen = New-Object Drawing.Pen ([Drawing.Color]::FromArgb(180, 20, 20, 20), 2)
  $g.FillEllipse($brush, 6, 10, 44, 38)
  $g.DrawEllipse($pen, 6, 10, 44, 38)
  $g.Dispose()
  $b.Save($Path, [Drawing.Imaging.ImageFormat]::Png)
  $b.Dispose()
}

$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path "$root\assets")) { $root = (Get-Location).Path }

New-Item -ItemType Directory -Force -Path @(
  "$root\assets\maps\urban",
  "$root\assets\maps\grass",
  "$root\assets\maps\desert",
  "$root\assets\props"
) | Out-Null

New-MapBmp "$root\assets\maps\urban\base.png" 480 384 @(52, 58, 68) 28
New-MapBmp "$root\assets\maps\grass\base.png" 480 384 @(45, 82, 48) 22
New-MapBmp "$root\assets\maps\desert\base.png" 480 384 @(168, 140, 88) 24
New-PropBmp "$root\assets\props\crate.png" '#6b4a2a'
New-PropBmp "$root\assets\props\barrel.png" '#8b4513'
New-PropBmp "$root\assets\props\ruins.png" '#5a5a62'
Write-Host "Wrote map mats and props under $root\assets"
