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

    # The executable is named for the release channel, such as
    # "T3 Code (Alpha).exe" or "T3 Code (Beta).exe", and an update to a new
    # channel removes the old one. Take the most recently installed.
    $programDirectory = Join-Path $env:LOCALAPPDATA "Programs\t3code"
    $candidate = Get-ChildItem -LiteralPath $programDirectory -Filter "T3 Code*.exe" -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
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
# The fix itself, which goes into a folder of its own for each install, so a
# running T3 Code can switch to it.
$coreFiles = @(
    (Join-Path $sourceDirectory "rtl.css"),
    (Join-Path $sourceDirectory "injection.js"),
    (Join-Path $sourceDirectory "launcher-core.js"),
    (Join-Path $sourceDirectory "annotation-direction.js"),
    (Join-Path $sourceDirectory "repo-status.js"),
    (Join-Path $sourceDirectory "cdp-dispatch.js"),
    (Join-Path $sourceDirectory "extras.js"),
    (Join-Path $sourceDirectory "extras-page.js"),
    (Join-Path $sourceDirectory "extras-settings.js"),
    (Join-Path $sourceDirectory "usage-limits.js"),
    (Join-Path $sourceDirectory "app-layout.js"),
    (Join-Path $sourceDirectory "css-mirror.js"),
    (Join-Path $sourceDirectory "chat-width.js"),
    (Join-Path $sourceDirectory "reply-start.js"),
    (Join-Path $sourceDirectory "working-shelf.js")
)
# The launcher host, which keeps T3 Code's debugging pipe and loads the fix.
$hostFile = Join-Path $sourceDirectory "t3-rtl-launcher.js"
$rootFiles = @(
    (Join-Path $PSScriptRoot "launch-t3-rtl.vbs"),
    (Join-Path $PSScriptRoot "uninstall.ps1")
)
foreach ($requiredFile in ($coreFiles + $hostFile + $rootFiles)) {
    if (-not (Test-Path -LiteralPath $requiredFile)) {
        throw "Required file is missing: $requiredFile"
    }
}

# Puts a finished file in place in one step, so a reader sees the old file
# or the new one, never a part of either.
function Move-IntoPlace {
    param([string]$Source, [string]$Destination)

    if (Test-Path -LiteralPath $Destination) {
        [System.IO.File]::Replace($Source, $Destination, [NullString]::Value)
    } else {
        [System.IO.File]::Move($Source, $Destination)
    }
}

function Write-FileAtomically {
    param([string]$Path, [string]$Text)

    $temporary = "$Path.$PID.tmp"
    [System.IO.File]::WriteAllText($temporary, $Text)
    Move-IntoPlace -Source $temporary -Destination $Path
}

function Read-VersionId {
    param([string]$Name)

    $path = Join-Path $InstallDirectory "$Name.txt"
    if (-not (Test-Path -LiteralPath $path)) {
        return $null
    }
    return ([System.IO.File]::ReadAllText($path)).Trim()
}

# Whether the T3 Code that is open now runs this launcher host, which then
# takes the update on its own: the host's record names a live process that
# started when the record says, runs the host being installed, and offers
# what the new fix needs.
function Get-RunningHostState {
    $recordPath = Join-Path $InstallDirectory "running-host.json"
    if (-not (Test-Path -LiteralPath $recordPath)) {
        return "none"
    }
    try {
        $record = Get-Content -Raw -LiteralPath $recordPath | ConvertFrom-Json
        $process = Get-Process -Id ([int]$record.pid) -ErrorAction Stop
        $recordedStart = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$record.startedAt).LocalDateTime
        if ([Math]::Abs(($process.StartTime - $recordedStart).TotalSeconds) -gt 10) {
            return "none"
        }
    }
    catch {
        return "none"
    }
    $hostHash = (Get-FileHash -LiteralPath $hostFile -Algorithm SHA256).Hash
    $coreSource = [System.IO.File]::ReadAllText((Join-Path $sourceDirectory "launcher-core.js"))
    $neededApi = [regex]::Match($coreSource, 'const REQUIRES_HOST_API = (\d+);').Groups[1].Value
    if ($hostHash -eq [string]$record.hash -and $neededApi -eq [string]$record.hostApi) {
        return "live"
    }
    return "restart"
}

New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null

# One install at a time, so the fix that current.txt names, the launcher
# host, and the shortcuts always come from the same install.
$lockPath = Join-Path $InstallDirectory "install.lock"
try {
    $installLock = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
}
catch {
    throw "Another install of T3 Code RTL Fix is running. Run this one again when it ends."
}
try {
    $hostState = Get-RunningHostState

    # The fix, in a new folder. A running launcher looks at current.txt only,
    # and only once it names this folder, which is complete by then.
    $versionsDirectory = Join-Path $InstallDirectory "versions"
    $versionId = (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss") + "-" + [guid]::NewGuid().ToString("N").Substring(0, 6)
    $versionDirectory = Join-Path $versionsDirectory $versionId
    New-Item -ItemType Directory -Path $versionDirectory -Force | Out-Null
    foreach ($coreFile in $coreFiles) {
        Copy-Item -LiteralPath $coreFile -Destination $versionDirectory -Force
    }
    Write-FileAtomically -Path (Join-Path $InstallDirectory "current.txt") -Text $versionId

    foreach ($rootFile in $rootFiles) {
        Copy-Item -LiteralPath $rootFile -Destination $InstallDirectory -Force
    }
    # The launcher host goes last: until here, the launcher that was installed
    # before still opens T3 Code with the files it knows.
    $hostTarget = Join-Path $InstallDirectory "t3-rtl-launcher.js"
    $hostTemporary = "$hostTarget.$PID.tmp"
    Copy-Item -LiteralPath $hostFile -Destination $hostTemporary -Force
    Move-IntoPlace -Source $hostTemporary -Destination $hostTarget

    # Earlier versions that neither run nor are the fallback, after a week.
    # Only folders an installer made, by the shape of their name.
    $keep = @($versionId, (Read-VersionId -Name "current"), (Read-VersionId -Name "last-good"))
    Get-ChildItem -LiteralPath $versionsDirectory -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^\d{8}-\d{6}-[0-9a-f]{6}$' -and $keep -notcontains $_.Name -and $_.CreationTime -lt (Get-Date).AddDays(-7) } |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

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
        # A T3 Code update that renames the app deletes its old shortcuts. Forget
        # them, so uninstalling does not bring back shortcuts to a missing app.
        if (-not (Test-Path -LiteralPath ([string]$saved.Path))) {
            continue
        }
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

        # The shortcut opens T3 Code directly again, so any saved original for it
        # is out of date. Save what it points to now.
        foreach ($outdated in @($manifest | Where-Object { $_.Path -eq $shortcutPath })) {
            [void]$manifest.Remove($outdated)
        }
        $manifest.Add([pscustomobject]@{
            Path = $shortcutPath
            Created = $false
            TargetPath = $shortcut.TargetPath
            Arguments = $shortcut.Arguments
            WorkingDirectory = $shortcut.WorkingDirectory
            IconLocation = $shortcut.IconLocation
            WindowStyle = $shortcut.WindowStyle
        })

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

    # A T3 Code update points these shortcuts at the app again, and the launcher
    # repairs them from this list. It holds only the shortcuts the uninstaller
    # restores, so a repair never leaves a shortcut the uninstaller misses.
    $repairPaths = @($manifest | Where-Object { -not $_.Created } | ForEach-Object { [string]$_.Path })
    [System.IO.File]::WriteAllText(
        (Join-Path $InstallDirectory "repair-shortcuts.txt"),
        ($repairPaths -join "`r`n"),
        [System.Text.Encoding]::Unicode
    )
}
finally {
    $installLock.Dispose()
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
}

Write-Output "T3 Code RTL Fix was installed in $InstallDirectory"
Write-Output "Updated shortcuts: $updated"
switch ($hostState) {
    "live" {
        Write-Output "The open T3 Code picks the update up in a few seconds: its windows reload, and running sessions keep running."
        Write-Output "The result is in $(Join-Path $InstallDirectory 'launcher.log')."
    }
    "restart" {
        Write-Output "This update changes the launcher itself. Quit T3 Code fully once, then open it from an updated shortcut."
    }
    default {
        Write-Output "Fully quit T3 Code, then open it from an updated shortcut."
    }
}
Write-Output "Your own CSS goes in $(Join-Path $InstallDirectory 'custom.css'), which updates never change."
if (Test-Path -LiteralPath (Join-Path $InstallDirectory "rtl.css")) {
    Write-Output "Earlier versions used $(Join-Path $InstallDirectory 'rtl.css'). It stays there; copy any rules of your own from it into custom.css."
}
