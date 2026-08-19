$ErrorActionPreference = "Stop"
$failure = $null

function Assert-Equal {
    param(
        $Actual,
        $Expected,
        [string]$Message
    )

    if ($Actual -ne $Expected) {
        throw "$Message. Expected '$Expected', received '$Actual'."
    }
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("t3-rtl-installer-test-" + [guid]::NewGuid().ToString("N"))
$fakeAppDirectory = Join-Path $testRoot "app"
$fakeAppPath = Join-Path $fakeAppDirectory "T3 Code (Alpha).exe"
$installDirectory = Join-Path $testRoot "install"
$desktopRoot = Join-Path $testRoot "desktop"
$startMenuRoot = Join-Path $testRoot "start-menu"
$shortcutPaths = @(
    (Join-Path $desktopRoot "T3 Code.lnk"),
    (Join-Path $startMenuRoot "T3 Code (Alpha).lnk")
)

try {
    New-Item -ItemType Directory -Path $fakeAppDirectory, $desktopRoot, $startMenuRoot -Force | Out-Null
    [System.IO.File]::WriteAllBytes($fakeAppPath, [byte[]]@())

    $shell = New-Object -ComObject WScript.Shell
    foreach ($shortcutPath in $shortcutPaths) {
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $fakeAppPath
        $shortcut.WorkingDirectory = $fakeAppDirectory
        $shortcut.Save()
    }

    $searchRoots = @($desktopRoot, $startMenuRoot)
    & (Join-Path $repositoryRoot "install.ps1") `
        -T3CodePath $fakeAppPath `
        -InstallDirectory $installDirectory `
        -ShortcutSearchRoots $searchRoots

    $appPathFile = Join-Path $installDirectory "app-path.txt"
    $savedAppPath = [System.IO.File]::ReadAllText($appPathFile, [System.Text.Encoding]::Unicode)
    Assert-Equal $savedAppPath $fakeAppPath "The UTF-16 app path was not written correctly"
    Assert-Equal (Test-Path -LiteralPath (Join-Path $installDirectory "node-path.txt")) $false "The installer still created a Node.js path file"

    & cscript.exe //nologo (Join-Path $installDirectory "launch-t3-rtl.vbs") /check
    if ($LASTEXITCODE -ne 0) {
        throw "The VBScript launcher configuration check failed with exit code $LASTEXITCODE."
    }

    $manifestDocument = Get-Content -Raw -LiteralPath (Join-Path $installDirectory "shortcuts.json") | ConvertFrom-Json
    $manifestItems = @()
    foreach ($item in $manifestDocument) {
        $manifestItems += $item
    }
    Assert-Equal $manifestItems.Count 2 "The shortcut manifest was not flattened correctly"

    foreach ($shortcutPath in $shortcutPaths) {
        $shortcut = $shell.CreateShortcut($shortcutPath)
        Assert-Equal $shortcut.TargetPath (Join-Path $env:SystemRoot "System32\wscript.exe") "The installer did not update $shortcutPath"
    }

    & (Join-Path $installDirectory "uninstall.ps1") -InstallDirectory $installDirectory

    foreach ($shortcutPath in $shortcutPaths) {
        $shortcut = $shell.CreateShortcut($shortcutPath)
        Assert-Equal $shortcut.TargetPath $fakeAppPath "The uninstaller did not restore $shortcutPath"
    }

    Write-Output "Windows PowerShell 5.1 installation and removal passed."
}
catch {
    $failure = $_
}
finally {
    if (Test-Path -LiteralPath $testRoot) {
        Remove-Item -LiteralPath $testRoot -Recurse -Force
    }
}

if ($null -ne $failure) {
    Write-Error $failure
    exit 1
}
