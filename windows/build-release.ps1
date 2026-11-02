<#
.SYNOPSIS
    Build the Windows distribution for DynaWall.

.DESCRIPTION
    Runs on Windows (locally or on GitHub Actions' windows-latest runner):

      1. dotnet publish  -> windows\publish\DynaWall.exe + publish\web\...
      2. Compress-Archive -> dist\DynaWall-Windows-Portable.zip
      3. ISCC installer.iss -> dist\DynaWall-Setup.exe (per-user, no UAC)

    WebView2 itself is not bundled: it is an evergreen component of Windows 11
    and Windows 10 1809+, which is what keeps the download small.

.PARAMETER Version
    Informational version for the assembly and the installer (e.g. 1.2.3).

.EXAMPLE
    .\windows\build-release.ps1 -Version 1.0.0
#>
[CmdletBinding()]
param(
    [string]$Version = '1.0.0',
    [string]$Configuration = 'Release',
    [string]$Runtime = 'win-x64'
)

$ErrorActionPreference = 'Stop'

$scriptDir = $PSScriptRoot
$root = Split-Path -Parent $scriptDir
$dist = Join-Path $root 'dist'
$publish = Join-Path $scriptDir 'publish'

$Version = $Version -replace '^[vV]', ''
if ([string]::IsNullOrWhiteSpace($Version)) { $Version = '1.0.0' }

New-Item -ItemType Directory -Force -Path $dist | Out-Null
if (Test-Path $publish) { Remove-Item $publish -Recurse -Force }

Write-Host "==> Publishing DynaWall $Version ($Configuration, $Runtime)"
& dotnet publish (Join-Path $scriptDir 'DynaWall.csproj') `
    --configuration $Configuration `
    --runtime $Runtime `
    --output $publish `
    --nologo `
    "-p:Version=$Version"

if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed with exit code $LASTEXITCODE" }

if (-not (Test-Path (Join-Path $publish 'web\index.html'))) {
    throw 'the published web wallpaper is missing from publish\web'
}

Write-Host '==> Packing the portable build'
$zip = Join-Path $dist 'DynaWall-Windows-Portable.zip'
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $publish '*') -DestinationPath $zip -CompressionLevel Optimal

Write-Host '==> Building the Inno Setup installer'
$isccCommand = Get-Command ISCC.exe -ErrorAction SilentlyContinue
$isccCandidates = @(
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
    $(if ($null -ne $isccCommand) { $isccCommand.Source })
) | Where-Object { $_ -and (Test-Path $_) }

if (-not $isccCandidates) {
    throw 'Inno Setup 6.3+ was not found. Install it with: choco install innosetup --no-progress -y'
}

$iscc = $isccCandidates | Select-Object -First 1
& $iscc "/DAppVersion=$Version" (Join-Path $scriptDir 'installer.iss')

if ($LASTEXITCODE -ne 0) { throw "Inno Setup compiler failed with exit code $LASTEXITCODE" }

$setup = Join-Path $dist 'DynaWall-Setup.exe'
if (-not (Test-Path $setup)) { throw 'DynaWall-Setup.exe was not produced' }

Get-Item $zip, $setup | ForEach-Object {
    Write-Host ('    {0} ({1:N1} MB)' -f $_.Name, ($_.Length / 1MB))
}
