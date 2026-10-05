[CmdletBinding()]
param(
    [string]$T3CodePath,
    [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA "T3RTLFix"),
    [string[]]$ShortcutSearchRoots,
    [string]$Source
)

# Run through "irm ... | iex", this script has no directory of its own and no
# repository around it. Download the repository and run the installer it
# contains, keeping the error and progress preferences inside a child scope so
# they do not change the caller's session.
$bundledSource = if ($PSScriptRoot) { Join-Path (Split-Path -Parent $PSScriptRoot) "src" } else { $null }
if (-not $bundledSource -or -not (Test-Path -LiteralPath $bundledSource -PathType Container)) {
    $forwarded = @{ InstallDirectory = $InstallDirectory }
    if ($T3CodePath) { $forwarded.T3CodePath = $T3CodePath }
    if ($ShortcutSearchRoots) { $forwarded.ShortcutSearchRoots = $ShortcutSearchRoots }

    & {
        param([hashtable]$Arguments, [string]$Package)

        $ErrorActionPreference = "Stop"
        $ProgressPreference = "SilentlyContinue"
        if (-not $Package) {
            $Package = "https://github.com/ShlomiPorush/t3code-rtl-fix/archive/refs/heads/main.zip"
        }

        $workDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("t3-rtl-install-" + [guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Path $workDirectory | Out-Null
        try {
            $archive = Join-Path $workDirectory "t3code-rtl-fix.zip"
            if ($Package -match '^https://') {
                [Net.ServicePointManager]::SecurityProtocol =
                    [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
                Write-Output "Downloading T3 Code RTL Fix..."
                Invoke-WebRequest -Uri $Package -OutFile $archive -UseBasicParsing
            } elseif (Test-Path -LiteralPath $Package -PathType Leaf) {
                Copy-Item -LiteralPath $Package -Destination $archive
            } else {
                throw "Source must be an https URL or an existing ZIP file: $Package"
            }

            $extracted = Join-Path $workDirectory "package"
            Expand-Archive -LiteralPath $archive -DestinationPath $extracted
            $installer = Get-ChildItem -LiteralPath $extracted -Filter "install.ps1" -File -Recurse |
                Where-Object {
                    $_.Directory.Name -eq "windows" -and
                    (Test-Path -LiteralPath (Join-Path $_.Directory.Parent.FullName "src\injection.js"))
                } |
                Select-Object -First 1
            if (-not $installer) {
                throw "The downloaded package does not contain the installer and its src folder."
            }

            # The command line itself runs under any execution policy, but the
            # extracted installer is a script file, which the default Restricted
            # policy blocks. Allow it for this process only, then restore it.
            $previousPolicy = Get-ExecutionPolicy -Scope Process
            Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
            try {
                & $installer.FullName @Arguments
            }
            finally {
                Set-ExecutionPolicy -Scope Process -ExecutionPolicy $previousPolicy -Force
            }
        }
        finally {
            Remove-Item -LiteralPath $workDirectory -Recurse -Force -ErrorAction SilentlyContinue
        }
    } -Arguments $forwarded -Package $Source
    return
}

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

# The injected fix is shared with macOS in src. The Windows launcher and
# uninstaller live beside this script.
$sourceDirectory = Join-Path (Split-Path -Parent $PSScriptRoot) "src"
$requiredFiles = @(
    (Join-Path $sourceDirectory "rtl.css"),
    (Join-Path $sourceDirectory "injection.js"),
    (Join-Path $sourceDirectory "t3-rtl-launcher.js"),
    (Join-Path $PSScriptRoot "launch-t3-rtl.vbs"),
    (Join-Path $PSScriptRoot "uninstall.ps1")
)
foreach ($requiredFile in $requiredFiles) {
    if (-not (Test-Path -LiteralPath $requiredFile)) {
        throw "Required file is missing: $requiredFile"
    }
}

New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
foreach ($requiredFile in $requiredFiles) {
    Copy-Item -LiteralPath $requiredFile -Destination $InstallDirectory -Force
}

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
