[CmdletBinding()]
param(
    [string]$T3CodePath,
    [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA "T3RTLFix"),
    [string[]]$ShortcutSearchRoots
)

$ErrorActionPreference = "Stop"

function Find-T3CodePath {
    param([string]$RequestedPath)

    if ($RequestedPath) {
        return [System.IO.Path]::GetFullPath($RequestedPath)
    }

    $defaultPath = Join-Path $env:LOCALAPPDATA "Programs\t3code\T3 Code (Alpha).exe"
    if (Test-Path -LiteralPath $defaultPath) {
        return $defaultPath
    }

    $programDirectory = Join-Path $env:LOCALAPPDATA "Programs\t3code"
    $candidate = Get-ChildItem -LiteralPath $programDirectory -Filter "T3 Code*.exe" -File -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty FullName
    return $candidate
}

function Read-ShortcutManifest {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }

    $document = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
    foreach ($item in $document) {
        Write-Output $item
    }
}

$appPath = Find-T3CodePath -RequestedPath $T3CodePath
if (-not $appPath -or -not (Test-Path -LiteralPath $appPath)) {
    throw "T3 Code was not found. Pass its executable path with -T3CodePath."
}

$sourceDirectory = Join-Path $PSScriptRoot "src"
$requiredFiles = @("rtl.css", "injection.js", "t3-rtl-launcher.js", "launch-t3-rtl.vbs")
foreach ($fileName in $requiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceDirectory $fileName))) {
        throw "Required file is missing: src\$fileName"
    }
}

New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
foreach ($fileName in $requiredFiles) {
    Copy-Item -LiteralPath (Join-Path $sourceDirectory $fileName) -Destination $InstallDirectory -Force
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "uninstall.ps1") -Destination $InstallDirectory -Force

[System.IO.File]::WriteAllText(
    (Join-Path $InstallDirectory "app-path.txt"),
    $appPath,
    [System.Text.Encoding]::Unicode
)

$legacyNodePathFile = Join-Path $InstallDirectory "node-path.txt"
if (Test-Path -LiteralPath $legacyNodePathFile) {
    Remove-Item -LiteralPath $legacyNodePathFile -Force
}

$manifestPath = Join-Path $InstallDirectory "shortcuts.json"
$manifest = [System.Collections.Generic.List[object]]::new()
foreach ($saved in (Read-ShortcutManifest -Path $manifestPath)) {
    $manifest.Add($saved)
}

if (-not $ShortcutSearchRoots -or $ShortcutSearchRoots.Count -eq 0) {
    $desktop = [Environment]::GetFolderPath("Desktop")
    $programs = Join-Path ([Environment]::GetFolderPath("StartMenu")) "Programs"
    $ShortcutSearchRoots = @($desktop, $programs)
}

$shortcutPaths = @(
    Get-ChildItem -LiteralPath $ShortcutSearchRoots -Filter "T3 Code*.lnk" -File -Recurse -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty FullName -Unique
)

$shell = New-Object -ComObject WScript.Shell
$wscriptPath = Join-Path $env:SystemRoot "System32\wscript.exe"
$launcherPath = Join-Path $InstallDirectory "launch-t3-rtl.vbs"
$updated = 0

foreach ($shortcutPath in $shortcutPaths) {
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $alreadyUsesLauncher =
        $shortcut.TargetPath -eq $wscriptPath -and
        $shortcut.Arguments -like "*$launcherPath*"

    if ($alreadyUsesLauncher) {
        continue
    }
    if ($shortcut.TargetPath -ne $appPath) {
        continue
    }

    if (-not ($manifest | Where-Object { $_.Path -eq $shortcutPath })) {
        $manifest.Add([pscustomobject]@{
            Path = $shortcutPath
            Created = $false
            TargetPath = $shortcut.TargetPath
            Arguments = $shortcut.Arguments
            WorkingDirectory = $shortcut.WorkingDirectory
            IconLocation = $shortcut.IconLocation
            WindowStyle = $shortcut.WindowStyle
        })
    }

    $shortcut.TargetPath = $wscriptPath
    $shortcut.Arguments = '"' + $launcherPath + '"'
    $shortcut.WorkingDirectory = $InstallDirectory
    $shortcut.IconLocation = "$appPath,0"
    $shortcut.WindowStyle = 1
    $shortcut.Save()
    $updated++
}

if ($shortcutPaths.Count -eq 0) {
    $desktop = [Environment]::GetFolderPath("Desktop")
    $shortcutPath = Join-Path $desktop "T3 Code RTL.lnk"
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $wscriptPath
    $shortcut.Arguments = '"' + $launcherPath + '"'
    $shortcut.WorkingDirectory = $InstallDirectory
    $shortcut.IconLocation = "$appPath,0"
    $shortcut.WindowStyle = 1
    $shortcut.Save()
    $manifest.Add([pscustomobject]@{
        Path = $shortcutPath
        Created = $true
        TargetPath = ""
        Arguments = ""
        WorkingDirectory = ""
        IconLocation = ""
        WindowStyle = 1
    })
    $updated++
}

$manifestJson = $manifest | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText(
    $manifestPath,
    $manifestJson,
    [System.Text.Encoding]::Unicode
)

Write-Output "T3 Code RTL Fix was installed in $InstallDirectory"
Write-Output "Updated shortcuts: $updated"
Write-Output "Fully quit T3 Code, then open it from an updated shortcut."
