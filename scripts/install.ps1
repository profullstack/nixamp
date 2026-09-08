<#
.SYNOPSIS
  nixamp installer for Windows.

.DESCRIPTION
  irm https://nixamp.com/install.ps1 | iex

  Installs the app and the CLI under %LOCALAPPDATA%\nixamp. No administrator
  rights, no registry, nothing outside your profile. The CLI runs on the Node
  inside the app bundle, so no system Node is needed.

  Updating is `nixamp update` and removing is `nixamp uninstall`, which runs a
  script this installer leaves behind.

.PARAMETER CliOnly
  Never install the app. The CLI then needs Node 24 or newer on PATH.

.PARAMETER Version
  Install a specific release instead of the latest.

.PARAMETER Prefix
  Install root. Defaults to $env:LOCALAPPDATA\nixamp.

.EXAMPLE
  & ([scriptblock]::Create((irm https://nixamp.com/install.ps1))) -CliOnly
#>
[CmdletBinding()]
param(
  [switch]$CliOnly,
  [string]$Version = $env:NIXAMP_VERSION,
  [string]$Prefix = $(if ($env:NIXAMP_PREFIX) { $env:NIXAMP_PREFIX } else { Join-Path $env:LOCALAPPDATA 'nixamp' })
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Repo = 'profullstack/nixamp'
$Site = if ($env:NIXAMP_SITE) { $env:NIXAMP_SITE } else { 'https://nixamp.com' }

function Fail($message) {
  Write-Error "nixamp: $message"
  exit 1
}

# arm64 Windows exists and Electron ships for it, so do not assume x64.
$Arch = switch ($env:PROCESSOR_ARCHITECTURE) {
  'AMD64' { 'x64' }
  'ARM64' { 'arm64' }
  'x86'   { Fail 'nixamp does not ship a 32-bit build.' }
  default { 'x64' }
}

if (-not $Version) {
  try {
    $latest = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest"
    $Version = $latest.tag_name -replace '^v', ''
  } catch {
    Fail "could not determine the latest version. Pass -Version, or see $Site"
  }
}

$Base = if ($env:NIXAMP_RELEASE_BASE) {
  $env:NIXAMP_RELEASE_BASE
} else {
  "https://github.com/$Repo/releases/download/v$Version"
}

$Bin = Join-Path $Prefix 'bin'
$Share = Join-Path $Prefix 'share'

Write-Host "nixamp $Version"
Write-Host "  platform:  windows-$Arch"
Write-Host "  desktop:   $(if ($CliOnly) { 'no' } else { 'yes' })"
Write-Host "  prefix:    $Prefix"
Write-Host ""

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("nixamp-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $work, $Bin, $Share | Out-Null

$paths = New-Object System.Collections.Generic.List[string]
$paths.Add((Join-Path $Bin 'nixamp.cmd'))
$paths.Add($Share)
$method = 'cli-tarball'
$appDir = Join-Path $Share 'app'
$cliDir = $null
$runtime = $null

# --- the app ------------------------------------------------------------------

if (-not $CliOnly) {
  $asset = "nixamp-$Version-win-$Arch.zip"
  Write-Host 'Downloading the app...'
  try {
    Invoke-WebRequest "$Base/$asset" -OutFile (Join-Path $work 'app.zip')
    if (Test-Path $appDir) { Remove-Item -Recurse -Force $appDir }
    New-Item -ItemType Directory -Force -Path $appDir | Out-Null
    Expand-Archive -Path (Join-Path $work 'app.zip') -DestinationPath $appDir -Force
    $method = 'windows-app'
    $cliDir = Join-Path $appDir 'resources\cli'
    $runtime = Join-Path $appDir 'nixamp.exe'

    # A Start menu shortcut, which is what the NSIS installer would give you,
    # done without touching anything outside the profile.
    $menu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\nixamp.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($menu)
    $link.TargetPath = $runtime
    $link.WorkingDirectory = $appDir
    $link.Description = "It really whips the terminal's ass."
    $link.Save()
    $paths.Add($menu)
  } catch {
    Write-Host "  the app could not be installed ($($_.Exception.Message)); installing the CLI only."
    $CliOnly = $true
    $method = 'cli-tarball'
  }
}

# --- the CLI ------------------------------------------------------------------

if ($method -eq 'cli-tarball') {
  # Pure JavaScript, so one bundle runs everywhere a Node does.
  $asset = "nixamp-cli-$Version.tar.gz"
  Write-Host 'Downloading the CLI...'
  $tarball = Join-Path $work 'cli.tar.gz'
  try {
    Invoke-WebRequest "$Base/$asset" -OutFile $tarball
  } catch {
    Fail "could not download $Base/$asset"
  }

  $cliDir = Join-Path $Share 'cli'
  if (Test-Path $cliDir) { Remove-Item -Recurse -Force $cliDir }
  New-Item -ItemType Directory -Force -Path $cliDir | Out-Null
  # bsdtar has shipped in Windows since 1809 and reads gzip, so there is no
  # third-party unpacker to ask for.
  tar -xzf $tarball -C $cliDir --strip-components=1
  if ($LASTEXITCODE -ne 0) { Fail 'could not unpack the CLI.' }

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host '  note: no app was installed, so the CLI needs Node 24 or newer. It was not found.'
  }
}

# The shim, written here because only the installer knows which of the two
# runtimes this machine ended up with.
$entry = Join-Path $cliDir 'bin\nixamp.mjs'
$shim = Join-Path $Bin 'nixamp.cmd'
if ($runtime) {
  @"
@echo off
rem nixamp. Runs on the Node inside the app, so no system Node is required.
rem Written by the installer; ``nixamp uninstall`` removes it.
set NIXAMP_HOME=$Share
set ELECTRON_RUN_AS_NODE=1
"$runtime" "$entry" %*
"@ | Set-Content -Path $shim -Encoding ASCII
} else {
  @"
@echo off
rem nixamp. Written by the installer; ``nixamp uninstall`` removes it.
set NIXAMP_HOME=$Share
node "$entry" %*
"@ | Set-Content -Path $shim -Encoding ASCII
}

# --- what was installed, and how to remove it ---------------------------------

$manifest = [ordered]@{
  version     = $Version
  method      = $method
  installer   = "$Site/install.ps1"
  installedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  prefix      = $Prefix
  desktop     = ($method -eq 'windows-app')
  paths       = $paths.ToArray()
}
$manifest | ConvertTo-Json | Set-Content -Path (Join-Path $Share 'manifest.json') -Encoding UTF8

$removals = ($paths | ForEach-Object { "Remove-Item -Recurse -Force -ErrorAction SilentlyContinue '$_'" }) -join "`n"
@"
# Removes nixamp. Written by the installer, which knew exactly what it created.
# Your music is NOT touched.
$removals
Write-Host 'nixamp removed.'
"@ | Set-Content -Path (Join-Path $Share 'uninstall.ps1') -Encoding UTF8

Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue

# --- PATH ---------------------------------------------------------------------

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$Bin*") {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$Bin", 'User')
  Write-Host ""
  Write-Host "Added $Bin to your PATH. Open a new terminal for it to take effect."
}

Write-Host ""
Write-Host "Installed nixamp $Version"
Write-Host "  $(if ($method -eq 'windows-app') { 'app and CLI' } else { 'CLI only' })"

# ffmpeg decodes every track. Saying so now beats a confusing failure on first
# use, when the playlist loads and nothing comes out of the speakers.
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  Write-Host ""
  Write-Host '  ffmpeg was not found, and nixamp decodes with ffmpeg.'
  Write-Host '  winget install Gyan.FFmpeg'
}

Write-Host ""
Write-Host 'Try:  nixamp %USERPROFILE%\Music'
Write-Host 'Update with `nixamp update`, remove with `nixamp uninstall`.'
Write-Host "Docs: $Site"
