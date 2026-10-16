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
    & (Join-Path $repositoryRoot "windows\install.ps1") `
        -T3CodePath $fakeAppPath `
        -InstallDirectory $installDirectory `
        -ShortcutSearchRoots $searchRoots

    $appPathFile = Join-Path $installDirectory "app-path.txt"
    $savedAppPath = [System.IO.File]::ReadAllText($appPathFile, [System.Text.Encoding]::Unicode)
    Assert-Equal $savedAppPath $fakeAppPath "The UTF-16 app path was not written correctly"
    Assert-Equal (Test-Path -LiteralPath (Join-Path $installDirectory "node-path.txt")) $false "The installer still created a Node.js path file"
    Assert-Equal (Test-Path -LiteralPath (Join-Path $installDirectory "injection.js")) $true "The browser injection helper was not installed"

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

    # The one-line install runs the script text with no directory of its own,
    # so it has to fetch the package. Use a local ZIP laid out like GitHub's
    # branch archive instead of the network.
    foreach ($shortcutPath in $shortcutPaths) {
        $shortcut = $shell.CreateShortcut($shortcutPath)
        Assert-Equal $shortcut.TargetPath $fakeAppPath "The shortcut was not restored before the bootstrap test"
    }
    $packageRoot = Join-Path $testRoot "package\t3code-rtl-fix-main"
    foreach ($folder in @("src", "windows", "macos")) {
        New-Item -ItemType Directory -Path (Join-Path $packageRoot $folder) -Force | Out-Null
        Get-ChildItem -LiteralPath (Join-Path $repositoryRoot $folder) -File |
            Copy-Item -Destination (Join-Path $packageRoot $folder)
    }
    $packagePath = Join-Path $testRoot "t3code-rtl-fix-main.zip"
    Compress-Archive -LiteralPath $packageRoot -DestinationPath $packagePath

    $bootstrapInstallDirectory = Join-Path $testRoot "bootstrap-install"
    $installerText = Get-Content -Raw -LiteralPath (Join-Path $repositoryRoot "windows\install.ps1")
    Push-Location $testRoot
    try {
        & ([scriptblock]::Create($installerText)) `
            -Source $packagePath `
            -T3CodePath $fakeAppPath `
            -InstallDirectory $bootstrapInstallDirectory `
            -ShortcutSearchRoots $searchRoots
    }
    finally {
        Pop-Location
    }

    foreach ($fileName in @("rtl.css", "injection.js", "t3-rtl-launcher.js", "annotation-direction.js", "launch-t3-rtl.vbs", "uninstall.ps1")) {
        Assert-Equal (Test-Path -LiteralPath (Join-Path $bootstrapInstallDirectory $fileName)) $true "The one-line install did not install $fileName"
    }
    foreach ($shortcutPath in $shortcutPaths) {
        $shortcut = $shell.CreateShortcut($shortcutPath)
        Assert-Equal $shortcut.TargetPath (Join-Path $env:SystemRoot "System32\wscript.exe") "The one-line install did not update $shortcutPath"
    }
    $leftovers = @(Get-ChildItem -LiteralPath ([System.IO.Path]::GetTempPath()) -Filter "t3-rtl-install-*" -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-5) })
    Assert-Equal $leftovers.Count 0 "The one-line install left its download directory behind"

    & (Join-Path $bootstrapInstallDirectory "uninstall.ps1") -InstallDirectory $bootstrapInstallDirectory
    foreach ($shortcutPath in $shortcutPaths) {
        $shortcut = $shell.CreateShortcut($shortcutPath)
        Assert-Equal $shortcut.TargetPath $fakeAppPath "The uninstaller did not restore $shortcutPath after the one-line install"
    }

    Write-Output "Windows PowerShell 5.1 one-line installation and removal passed."

    # Restricted is the default Windows execution policy. It allows the
    # one-line command itself but blocks the extracted installer file unless
    # the bootstrap allows it for the process, and it must be restored after.
    $quote = { param($Value) "'" + $Value.Replace("'", "''") + "'" }
    $restrictedInstallDirectory = Join-Path $testRoot "restricted-install"
    $rootList = ($searchRoots | ForEach-Object { & $quote $_ }) -join ","
    $restrictedCommand = "& ([scriptblock]::Create((Get-Content -Raw -LiteralPath $(& $quote (Join-Path $repositoryRoot 'windows\install.ps1'))))) " +
        "-Source $(& $quote $packagePath) -T3CodePath $(& $quote $fakeAppPath) " +
        "-InstallDirectory $(& $quote $restrictedInstallDirectory) -ShortcutSearchRoots @($rootList); " +
        "(Get-ExecutionPolicy -Scope Process).ToString()"
    $ErrorActionPreference = "Continue"
    $restrictedOutput = @(& powershell.exe -NoProfile -ExecutionPolicy Restricted -Command $restrictedCommand 2>&1)
    $restrictedExitCode = $LASTEXITCODE
    $ErrorActionPreference = "Stop"
    if ($restrictedExitCode -ne 0) {
        throw "The one-line install failed under the Restricted execution policy: $($restrictedOutput -join ' ')"
    }
    Assert-Equal ([string]$restrictedOutput[-1]) "Restricted" "The one-line install did not restore the process execution policy"
    Assert-Equal (Test-Path -LiteralPath (Join-Path $restrictedInstallDirectory "rtl.css")) $true "The one-line install did not install under the Restricted execution policy"

    & (Join-Path $restrictedInstallDirectory "uninstall.ps1") -InstallDirectory $restrictedInstallDirectory
    foreach ($shortcutPath in $shortcutPaths) {
        $shortcut = $shell.CreateShortcut($shortcutPath)
        Assert-Equal $shortcut.TargetPath $fakeAppPath "The uninstaller did not restore $shortcutPath after the Restricted install"
    }

    Write-Output "Windows PowerShell 5.1 one-line installation under the Restricted policy passed."

    # T3 Code 0.1.0 renamed "T3 Code (Alpha).exe" to "T3 Code (Beta).exe". The
    # update deleted the old executable and its shortcuts and created new
    # shortcuts that open the app directly.
    $previousLocalAppData = $env:LOCALAPPDATA
    $env:LOCALAPPDATA = Join-Path $testRoot "local-app-data"
    try {
        $programDirectory = Join-Path $env:LOCALAPPDATA "Programs\t3code"
        $renameRoot = Join-Path $testRoot "rename-shortcuts"
        $renameInstallDirectory = Join-Path $testRoot "rename-install"
        $alphaAppPath = Join-Path $programDirectory "T3 Code (Alpha).exe"
        $betaAppPath = Join-Path $programDirectory "T3 Code (Beta).exe"
        $alphaShortcutPath = Join-Path $renameRoot "T3 Code (Alpha).lnk"
        $betaShortcutPath = Join-Path $renameRoot "T3 Code (Beta).lnk"
        New-Item -ItemType Directory -Path $programDirectory, $renameRoot -Force | Out-Null
        [System.IO.File]::WriteAllBytes($alphaAppPath, [byte[]]@())
        $shortcut = $shell.CreateShortcut($alphaShortcutPath)
        $shortcut.TargetPath = $alphaAppPath
        $shortcut.Save()

        & (Join-Path $repositoryRoot "windows\install.ps1") `
            -InstallDirectory $renameInstallDirectory `
            -ShortcutSearchRoots @($renameRoot)
        $savedAppPath = [System.IO.File]::ReadAllText((Join-Path $renameInstallDirectory "app-path.txt"), [System.Text.Encoding]::Unicode)
        Assert-Equal $savedAppPath $alphaAppPath "The installer did not find the Alpha executable"

        Remove-Item -LiteralPath $alphaAppPath, $alphaShortcutPath -Force
        [System.IO.File]::WriteAllBytes($betaAppPath, [byte[]]@())
        [System.IO.File]::WriteAllBytes((Join-Path $programDirectory "Uninstall T3 Code (Beta).exe"), [byte[]]@())
        $shortcut = $shell.CreateShortcut($betaShortcutPath)
        $shortcut.TargetPath = $betaAppPath
        $shortcut.Save()

        # Uninstalling after the rename must not bring back the deleted shortcut.
        & (Join-Path $renameInstallDirectory "uninstall.ps1") -InstallDirectory $renameInstallDirectory
        Assert-Equal (Test-Path -LiteralPath $alphaShortcutPath) $false "The uninstaller recreated a shortcut that T3 Code deleted"
        Assert-Equal $shell.CreateShortcut($betaShortcutPath).TargetPath $betaAppPath "The uninstaller changed a shortcut it did not install"

        # Installing again finds the renamed app and forgets the deleted shortcut.
        & (Join-Path $repositoryRoot "windows\install.ps1") `
            -InstallDirectory $renameInstallDirectory `
            -ShortcutSearchRoots @($renameRoot)
        $savedAppPath = [System.IO.File]::ReadAllText((Join-Path $renameInstallDirectory "app-path.txt"), [System.Text.Encoding]::Unicode)
        Assert-Equal $savedAppPath $betaAppPath "The installer did not find the renamed executable"
        Assert-Equal $shell.CreateShortcut($betaShortcutPath).TargetPath (Join-Path $env:SystemRoot "System32\wscript.exe") "The installer did not update the renamed shortcut"
        $manifestItems = @()
        foreach ($item in (Get-Content -Raw -LiteralPath (Join-Path $renameInstallDirectory "shortcuts.json") | ConvertFrom-Json)) {
            $manifestItems += $item
        }
        Assert-Equal $manifestItems.Count 1 "The shortcut manifest kept a shortcut that T3 Code deleted"
        Assert-Equal $manifestItems[0].Path $betaShortcutPath "The shortcut manifest did not save the renamed shortcut"

        & (Join-Path $renameInstallDirectory "uninstall.ps1") -InstallDirectory $renameInstallDirectory
        Assert-Equal $shell.CreateShortcut($betaShortcutPath).TargetPath $betaAppPath "The uninstaller did not restore the renamed shortcut"
        Assert-Equal (Test-Path -LiteralPath $alphaShortcutPath) $false "The uninstaller recreated a shortcut that T3 Code deleted"
    }
    finally {
        $env:LOCALAPPDATA = $previousLocalAppData
    }

    Write-Output "Windows PowerShell 5.1 installation after a T3 Code rename passed."
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
