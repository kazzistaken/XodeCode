<#
.SYNOPSIS
  Creates a desktop shortcut for XodeCode.

.DESCRIPTION
  Writes a "XodeCode.lnk" shortcut that launches the bundled Electron runtime against
  this project folder, using assets/xodecode.ico (redraw it with 'npm run icon').
  Pass -StartMenu to also add it to the Start Menu.

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

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$assets = Join-Path $root 'assets'
$iconPath = Join-Path $assets 'xodecode.ico'

if (-not (Test-Path $electron)) {
  throw "Electron is not installed at $electron. Run 'npm install' first."
}

if (-not (Test-Path $iconPath)) {
  throw "The icon is missing at $iconPath. Run 'npm run icon' first."
}

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
