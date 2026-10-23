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

    # A T3 Code update points the Start Menu shortcut at the app again. The
    # launcher repairs the shortcuts it installed and leaves any other alone.
    $wscriptPath = Join-Path $env:SystemRoot "System32\wscript.exe"
    $launcherScriptPath = Join-Path $installDirectory "launch-t3-rtl.vbs"
    $updatedShortcutPath = $shortcutPaths[1]
    $otherShortcutPath = Join-Path $startMenuRoot "T3 Code Other.lnk"
    foreach ($shortcutPath in @($updatedShortcutPath, $otherShortcutPath)) {
        $shortcut = $shell.CreateShortcut($shortcutPath)
        $shortcut.TargetPath = $fakeAppPath
        $shortcut.Save()
    }
    & cscript.exe //nologo $launcherScriptPath /repair
    Assert-Equal $LASTEXITCODE 0 "The shortcut repair reported a failure"
    $shortcut = $shell.CreateShortcut($updatedShortcutPath)
    Assert-Equal $shortcut.TargetPath $wscriptPath "The launcher did not repair the updated shortcut"
    Assert-Equal $shortcut.Arguments ('"' + $launcherScriptPath + '"') "The repaired shortcut does not open the launcher"
    Assert-Equal $shell.CreateShortcut($otherShortcutPath).TargetPath $fakeAppPath "The launcher changed a shortcut it did not install"
    Remove-Item -LiteralPath $otherShortcutPath -Force

    # The update reopens T3 Code with --updated. A renamed copy of cmd.exe
    # stands in for it, so the helper finds it in the app's folder.
    Copy-Item -LiteralPath (Join-Path $env:SystemRoot "System32\cmd.exe") -Destination $fakeAppPath -Force
    $shortcut = $shell.CreateShortcut($updatedShortcutPath)
    $shortcut.TargetPath = $fakeAppPath
    $shortcut.Save()
    $reopenedApp = Start-Process -FilePath $fakeAppPath -ArgumentList '/d /c "ping -n 60 127.0.0.1 >nul & rem --updated"' -WindowStyle Hidden -PassThru
    try {
        $noticePath = Join-Path $testRoot "update-notice.txt"
        & cscript.exe //nologo $launcherScriptPath /updated /wait:30 "/notice:$noticePath"
        Assert-Equal (Test-Path -LiteralPath $noticePath) $true "The helper did not tell the user that T3 Code was reopened without the fix"
        Assert-Equal (([System.IO.File]::ReadAllText($noticePath)) -like "*reopened without the RTL fix*") $true "The helper showed the wrong message after an update"
        Assert-Equal $shell.CreateShortcut($updatedShortcutPath).TargetPath $wscriptPath "The helper did not repair the shortcut after an update"
        Assert-Equal (Test-Path -LiteralPath (Join-Path $installDirectory "update-notice.lock")) $false "The helper left its lock behind"

        # Each exit of T3 Code starts a helper, so another one can find the same
        # reopened app. It must not show the message again.
        $secondNoticePath = Join-Path $testRoot "second-notice.txt"
        & cscript.exe //nologo $launcherScriptPath /updated /wait:30 "/notice:$secondNoticePath"
        Assert-Equal (Test-Path -LiteralPath $secondNoticePath) $false "A second helper showed the update message again"
    }
    finally {
        & taskkill.exe /PID $reopenedApp.Id /T /F | Out-Null
    }

    # An update installed on quit does not reopen T3 Code. The helper only
    # repairs the shortcuts.
    $shortcut = $shell.CreateShortcut($updatedShortcutPath)
    $shortcut.TargetPath = $fakeAppPath
    $shortcut.Save()
    $quietNoticePath = Join-Path $testRoot "quiet-notice.txt"
    & cscript.exe //nologo $launcherScriptPath /updated /wait:2 "/notice:$quietNoticePath"
    Assert-Equal (Test-Path -LiteralPath $quietNoticePath) $false "The helper showed a message although T3 Code was not reopened"
    Assert-Equal $shell.CreateShortcut($updatedShortcutPath).TargetPath $wscriptPath "The helper did not repair the shortcut after an update installed on quit"

    # Uninstalling while a helper still waits must stay uninstalled.
    $waitingNoticePath = Join-Path $testRoot "waiting-notice.txt"
    $waitingHelper = Start-Process -FilePath "cscript.exe" -ArgumentList @(
        "//nologo", ('"' + $launcherScriptPath + '"'), "/updated", "/wait:60", ('"/notice:' + $waitingNoticePath + '"')
    ) -WindowStyle Hidden -PassThru
    Start-Sleep -Seconds 1
    & (Join-Path $installDirectory "uninstall.ps1") -InstallDirectory $installDirectory
    Assert-Equal $waitingHelper.WaitForExit(5000) $true "The waiting helper did not stop after the uninstall"
    Assert-Equal (Test-Path -LiteralPath $waitingNoticePath) $false "The waiting helper showed a message after the uninstall"

    foreach ($shortcutPath in $shortcutPaths) {
        $shortcut = $shell.CreateShortcut($shortcutPath)
        Assert-Equal $shortcut.TargetPath $fakeAppPath "The uninstaller did not restore $shortcutPath"
    }

    Write-Output "Windows PowerShell 5.1 installation, shortcut repair after an update, and removal passed."

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

    foreach ($fileName in @("rtl.css", "injection.js", "t3-rtl-launcher.js", "annotation-direction.js", "launch-t3-rtl.vbs", "uninstall.ps1", "repair-shortcuts.txt")) {
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

        # An update that renamed the app reopens it under the new name, which
        # the launcher cannot find, so the helper asks the user to install the
        # fix again.
        Copy-Item -LiteralPath (Join-Path $env:SystemRoot "System32\cmd.exe") -Destination $betaAppPath -Force
        $renamedApp = Start-Process -FilePath $betaAppPath -ArgumentList '/d /c "ping -n 60 127.0.0.1 >nul & rem --updated"' -WindowStyle Hidden -PassThru
        try {
            $renameNoticePath = Join-Path $testRoot "rename-notice.txt"
            & cscript.exe //nologo (Join-Path $renameInstallDirectory "launch-t3-rtl.vbs") /updated /wait:30 "/notice:$renameNoticePath"
        }
        finally {
            & taskkill.exe /PID $renamedApp.Id /T /F | Out-Null
        }
        Assert-Equal (Test-Path -LiteralPath $renameNoticePath) $true "The helper did not report the renamed app"
        Assert-Equal (([System.IO.File]::ReadAllText($renameNoticePath)) -like "*Run the install command again*") $true "The helper showed the wrong message after a rename"

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
