param(
  [switch]$SkipInstall,
  [switch]$SkipChecks,
  [switch]$InstallBuildTools,
  [switch]$NoInstallBuildTools,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'

try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
} catch {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
}

function Write-Step {
  param([string]$Message)
  Write-Host ''
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok {
  param([string]$Message)
  Write-Host "OK: $Message" -ForegroundColor Green
}

function Write-Warn {
  param([string]$Message)
  Write-Host "WARN: $Message" -ForegroundColor Yellow
}

function Fail {
  param([string]$Message)
  Write-Host ''
  Write-Host "ERROR: $Message" -ForegroundColor Red
  exit 1
}

function Test-Command {
  param([string]$Name)
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Import-CmdEnvironment {
  param([string]$Command)

  $environment = cmd.exe /s /c "`"$Command && set`""
  foreach ($line in $environment) {
    if ($line -match '^(.*?)=(.*)$') {
      [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
    }
  }
}

function Get-VsWherePath {
  $paths = @(
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe",
    "${env:ProgramFiles}\Microsoft Visual Studio\Installer\vswhere.exe"
  )

  foreach ($path in $paths) {
    if ($path -and (Test-Path $path)) {
      return $path
    }
  }

  return $null
}

function Get-VsInstallPath {
  $vswhere = Get-VsWherePath
  if (-not $vswhere) {
    return $null
  }

  $installPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if ($installPath) {
    return $installPath
  }

  return $null
}

function Install-VsBuildTools {
  $bootstrapper = Join-Path $env:TEMP 'vs_BuildTools.exe'
  $url = 'https://aka.ms/vs/17/release/vs_BuildTools.exe'

  Write-Step 'Downloading Visual Studio Build Tools bootstrapper'
  $downloaded = $false

  try {
    Invoke-WebRequest -Uri $url -OutFile $bootstrapper -UseBasicParsing
    $downloaded = Test-Path $bootstrapper
  } catch {
    Write-Warn "Invoke-WebRequest failed: $($_.Exception.Message)"
  }

  if (-not $downloaded -and (Test-Command 'curl.exe')) {
    try {
      Write-Warn 'Retrying download with curl.exe'
      curl.exe -L --fail --retry 3 --output $bootstrapper $url
      $downloaded = ($LASTEXITCODE -eq 0 -and (Test-Path $bootstrapper))
    } catch {
      Write-Warn "curl.exe failed: $($_.Exception.Message)"
    }
  }

  if (-not $downloaded) {
    try {
      Write-Warn 'Retrying download with .NET WebClient'
      $client = New-Object System.Net.WebClient
      $client.DownloadFile($url, $bootstrapper)
      $downloaded = Test-Path $bootstrapper
    } catch {
      Write-Warn "WebClient failed: $($_.Exception.Message)"
    }
  }

  if (-not $downloaded) {
    Write-Host ''
    Write-Host 'Automatic download failed. Please download and run this installer manually:' -ForegroundColor Yellow
    Write-Host "  $url"
    Write-Host ''
    Write-Host 'Install these components:'
    Write-Host '  Desktop development with C++'
    Write-Host '  MSVC v143 VS 2022 C++ x64/x86 build tools'
    Write-Host '  Windows 10/11 SDK'
    try { Start-Process $url } catch {}
    Fail 'Visual Studio Build Tools bootstrapper download failed.'
  }

  if ((Get-Item $bootstrapper).Length -lt 1MB) {
    Remove-Item $bootstrapper -Force -ErrorAction SilentlyContinue
    Fail 'Downloaded Build Tools bootstrapper is unexpectedly small. Please retry or download it manually.'
  }

  $defaultInstallPath = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools"
  $installPath = $defaultInstallPath
  if ((Test-Path $defaultInstallPath) -and -not (Get-VsInstallPath)) {
    $alternateInstallPath = 'C:\VSBuildTools2022'
    Write-Warn "Default Build Tools folder exists but is not registered: $defaultInstallPath"
    Write-Warn "Using alternate install path: $alternateInstallPath"
    $installPath = $alternateInstallPath
  }

  Write-Step 'Installing Visual Studio Build Tools C++ workload'
  Write-Host 'This may open a UAC prompt and can take several minutes.'

  $args = @(
    '--quiet',
    '--wait',
    '--norestart',
    '--nocache',
    '--installPath', $installPath,
    '--add', 'Microsoft.VisualStudio.Workload.VCTools',
    '--add', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
    '--includeRecommended'
  )

  $process = Start-Process -FilePath $bootstrapper -ArgumentList $args -Wait -PassThru
  if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) {
    Fail "Visual Studio Build Tools installer failed with exit code $($process.ExitCode)."
  }

  Write-Ok 'Visual Studio Build Tools installation finished'
}

function Ensure-MsvcEnvironment {
  if (Test-Command 'cl.exe') {
    Write-Ok 'MSVC cl.exe is already available'
    return
  }

  $vsInstall = Get-VsInstallPath
  if (-not $vsInstall) {
    if (-not $InstallBuildTools -and -not $NoInstallBuildTools) {
      Write-Warn 'MSVC C++ build tools were not found.'
      Write-Host ''
      Write-Host 'Tauri Windows installer builds require Visual Studio C++ Build Tools.'
      $answer = Read-Host 'Install Visual Studio Build Tools automatically now? [Y/N]'
      if ($answer -match '^[Yy]') {
        $InstallBuildTools = $true
      }
    }

    if (-not $InstallBuildTools) {
      Write-Warn 'MSVC C++ build tools were not found.'
      Write-Host ''
      Write-Host 'Run one of these commands:'
      Write-Host '  package-win.bat -InstallBuildTools'
      Write-Host '  powershell -NoProfile -ExecutionPolicy Bypass -File .\package-win.ps1 -InstallBuildTools'
      Write-Host '  package-win.bat -NoInstallBuildTools'
      Write-Host ''
      Write-Host 'Or install manually in Visual Studio Installer:'
      Write-Host '  Desktop development with C++'
      Write-Host '  MSVC v143 VS 2022 C++ x64/x86 build tools'
      Write-Host '  Windows 10/11 SDK'
      Fail 'Cannot build Tauri installer without cl.exe.'
    }

    Install-VsBuildTools
    $vsInstall = Get-VsInstallPath
    if (-not $vsInstall) {
      Fail 'Build Tools installation completed, but vswhere still cannot find VC tools. Reopen the terminal and retry.'
    }
  }

  $vsDevCmd = Join-Path $vsInstall 'Common7\Tools\VsDevCmd.bat'
  if (-not (Test-Path $vsDevCmd)) {
    Fail "VsDevCmd.bat not found: $vsDevCmd"
  }

  Write-Step 'Loading MSVC environment'
  Import-CmdEnvironment "`"$vsDevCmd`" -arch=x64 -host_arch=x64"

  if (-not (Test-Command 'cl.exe')) {
    Fail 'cl.exe is still unavailable after loading VsDevCmd.bat.'
  }

  Write-Ok 'MSVC environment loaded'
}

function Run-Step {
  param(
    [string]$Name,
    [string]$Command
  )

  Write-Step $Name
  cmd.exe /s /c $Command
  if ($LASTEXITCODE -ne 0) {
    Fail "$Name failed."
  }
}

if ($Help) {
  Write-Host 'Usage:'
  Write-Host '  package-win.bat'
  Write-Host '  package-win.bat -InstallBuildTools'
  Write-Host '  package-win.bat -NoInstallBuildTools'
  Write-Host '  package-win.bat -SkipChecks'
  Write-Host '  package-win.bat -SkipInstall'
  exit 0
}

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

Write-Step 'Checking required commands'
if (-not (Test-Command 'node.exe')) { Fail 'node.exe not found. Install Node.js first.' }
if (-not (Test-Command 'npm.cmd')) { Fail 'npm.cmd not found. Install Node.js/npm first.' }
if (-not (Test-Command 'cargo.exe')) { Fail 'cargo.exe not found. Install Rust first.' }
Write-Ok 'Node, npm and Cargo are available'

Ensure-MsvcEnvironment

if (-not $SkipInstall) {
  if (Test-Path (Join-Path $root 'package-lock.json')) {
    if (Test-Path (Join-Path $root 'node_modules')) {
      Run-Step 'Installing npm dependencies' 'npm install'
    } else {
      Run-Step 'Installing npm dependencies from lockfile' 'npm ci'
    }
  } else {
    Run-Step 'Installing npm dependencies' 'npm install'
  }
}

if (-not $SkipChecks) {
  Run-Step 'Type checking' 'npm run typecheck'
  Run-Step 'Linting' 'npm run lint'
  Run-Step 'Running tests' 'npm run test:run'
}

Run-Step 'Building Windows installer' 'npm run build:win'

$bundlePath = Join-Path $root 'src-tauri\target\x86_64-pc-windows-msvc\release\bundle'
Write-Step 'Build output'
if (Test-Path $bundlePath) {
  Write-Host $bundlePath -ForegroundColor Green
  Get-ChildItem $bundlePath -Recurse -File | Select-Object FullName, Length, LastWriteTime
} else {
  Write-Warn "Bundle folder not found: $bundlePath"
}

exit 0
