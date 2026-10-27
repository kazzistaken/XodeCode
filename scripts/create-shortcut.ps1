<#
.SYNOPSIS
  Creates a desktop shortcut for XodeCode and generates its application icon.

.DESCRIPTION
  Builds assets/xodecode.ico (multi-resolution, generated with System.Drawing) and
  writes a "XodeCode.lnk" shortcut that launches the bundled Electron runtime against
  this project folder. Pass -StartMenu to also add it to the Start Menu.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/create-shortcut.ps1
  powershell -ExecutionPolicy Bypass -File scripts/create-shortcut.ps1 -StartMenu
#>

[CmdletBinding()]
param(
  [switch]$StartMenu,
  [string]$Name = 'XodeCode'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$assets = Join-Path $root 'assets'
$iconPath = Join-Path $assets 'xodecode.ico'

if (-not (Test-Path $electron)) {
  throw "Electron is not installed at $electron. Run 'npm install' first."
}

if (-not (Test-Path $assets)) {
  New-Item -ItemType Directory -Path $assets | Out-Null
}

# --------------------------------------------------------------------------- #
# Icon generation
# --------------------------------------------------------------------------- #

function Get-RoundedPath {
  param([single]$X, [single]$Y, [single]$W, [single]$H, [single]$R)

  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $R * 2
  $path.AddArc($X, $Y, $d, $d, 180, 90)
  $path.AddArc($X + $W - $d, $Y, $d, $d, 270, 90)
  $path.AddArc($X + $W - $d, $Y + $H - $d, $d, $d, 0, 90)
  $path.AddArc($X, $Y + $H - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-IconPng {
  param([int]$Size)

  $scale = $Size / 256.0

  $bitmap = New-Object System.Drawing.Bitmap $Size, $Size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.Clear([System.Drawing.Color]::Transparent)

  # charcoal plate
  $platePath = Get-RoundedPath (8 * $scale) (8 * $scale) (240 * $scale) (240 * $scale) (56 * $scale)
  $plateBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 17, 17, 22))
  $graphics.FillPath($plateBrush, $platePath)

  # warm gradient tile
  $tileRect = New-Object System.Drawing.RectangleF -ArgumentList @(
    ([single](40 * $scale)), ([single](40 * $scale)), ([single](176 * $scale)), ([single](176 * $scale))
  )
  $tilePath = Get-RoundedPath (40 * $scale) (40 * $scale) (176 * $scale) (176 * $scale) (44 * $scale)
  $gradient = New-Object System.Drawing.Drawing2D.LinearGradientBrush -ArgumentList @(
    $tileRect,
    ([System.Drawing.Color]::FromArgb(255, 242, 118, 75)),
    ([System.Drawing.Color]::FromArgb(255, 255, 178, 122)),
    ([single]45)
  )
  $graphics.FillPath($gradient, $tilePath)

  # the mark
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 26, 12, 6)), ([single](30 * $scale))
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $graphics.DrawLine($pen, ([single](94 * $scale)), ([single](94 * $scale)), ([single](162 * $scale)), ([single](162 * $scale)))
  $graphics.DrawLine($pen, ([single](162 * $scale)), ([single](94 * $scale)), ([single](94 * $scale)), ([single](162 * $scale)))

  $stream = New-Object System.IO.MemoryStream
  $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $stream.ToArray()

  $graphics.Dispose()
  $bitmap.Dispose()
  $stream.Dispose()
  $pen.Dispose()
  $gradient.Dispose()
  $tilePath.Dispose()
  $platePath.Dispose()
  $plateBrush.Dispose()

  Write-Output -NoEnumerate $bytes
}

$sizes = @(32, 48, 64, 128, 256)
$images = New-Object 'System.Collections.Generic.List[byte[]]'
foreach ($size in $sizes) {
  $images.Add((New-IconPng -Size $size))
}

$icoStream = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter($icoStream)
$writer.Write([UInt16]0)                 # reserved
$writer.Write([UInt16]1)                 # 1 = icon
$writer.Write([UInt16]$sizes.Count)      # image count

$offset = 6 + (16 * $sizes.Count)
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $size = $sizes[$i]
  $bytes = $images[$i]
  $dimension = if ($size -ge 256) { 0 } else { $size }

  $writer.Write([Byte]$dimension)        # width  (0 means 256)
  $writer.Write([Byte]$dimension)        # height
  $writer.Write([Byte]0)                 # palette entries
  $writer.Write([Byte]0)                 # reserved
  $writer.Write([UInt16]1)               # color planes
  $writer.Write([UInt16]32)              # bits per pixel
  $writer.Write([UInt32]$bytes.Length)   # payload size
  $writer.Write([UInt32]$offset)         # payload offset
  $offset += $bytes.Length
}

foreach ($bytes in $images) {
  $writer.Write($bytes)
}

$writer.Flush()
[System.IO.File]::WriteAllBytes($iconPath, $icoStream.ToArray())
$writer.Dispose()
$icoStream.Dispose()

Write-Host "Icon written: $iconPath ($([math]::Round((Get-Item $iconPath).Length / 1kb, 1)) KB)"

# --------------------------------------------------------------------------- #
# Shortcut
# --------------------------------------------------------------------------- #

$shell = New-Object -ComObject WScript.Shell

function New-Shortcut {
  param([string]$Folder, [string]$Label)

  if (-not (Test-Path $Folder)) {
    New-Item -ItemType Directory -Path $Folder | Out-Null
  }

  $linkPath = Join-Path $Folder "$Label.lnk"
  $shortcut = $shell.CreateShortcut($linkPath)
  $shortcut.TargetPath = $electron
  $shortcut.Arguments = '"{0}"' -f $root
  $shortcut.WorkingDirectory = $root
  $shortcut.IconLocation = "$iconPath,0"
  $shortcut.Description = 'XodeCode — a spatial canvas for AI coding agents'
  $shortcut.WindowStyle = 1
  $shortcut.Save()

  return $linkPath
}

$desktop = [Environment]::GetFolderPath('Desktop')
$created = @(New-Shortcut -Folder $desktop -Label $Name)

if ($StartMenu) {
  $programs = [Environment]::GetFolderPath('Programs')
  $created += New-Shortcut -Folder $programs -Label $Name
}

Write-Host ''
foreach ($path in $created) {
  Write-Host "Shortcut created: $path"
}
Write-Host "  Target : $electron"
Write-Host "  App    : $root"
Write-Host ''
Write-Host "Double-click '$Name' to launch."
