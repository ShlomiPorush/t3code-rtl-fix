[CmdletBinding()]
param(
    [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA "T3RTLFix")
)

$ErrorActionPreference = "Stop"
$manifestPath = Join-Path $InstallDirectory "shortcuts.json"

if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "Shortcut backup was not found at $manifestPath"
}

$manifestDocument = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$manifest = @()
foreach ($item in $manifestDocument) {
    $manifest += $item
}

# Without this list, a helper still waiting for a T3 Code update cannot point
# the restored shortcuts at the fix again. Stop any such helper as well, in
# case one is repairing a shortcut at this moment.
$repairListPath = Join-Path $InstallDirectory "repair-shortcuts.txt"
if (Test-Path -LiteralPath $repairListPath) {
    Remove-Item -LiteralPath $repairListPath -Force
}
$launcherScriptPath = Join-Path $InstallDirectory "launch-t3-rtl.vbs"
Get-CimInstance -ClassName Win32_Process -Filter "Name = 'wscript.exe' OR Name = 'cscript.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
        $_.CommandLine -and
        $_.CommandLine.IndexOf($launcherScriptPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $_.CommandLine.IndexOf("/updated", [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$shell = New-Object -ComObject WScript.Shell
$restored = 0
$removed = 0

foreach ($saved in $manifest) {
    $shortcutPath = [string]$saved.Path
    $createdProperty = $saved.PSObject.Properties["Created"]
    $wasCreated = $null -ne $createdProperty -and [bool]$saved.Created
    if ($wasCreated) {
        if (Test-Path -LiteralPath $shortcutPath) {
            Remove-Item -LiteralPath $shortcutPath -Force
            $removed++
        }
        continue
    }

    # A T3 Code update that renames the app deletes its old shortcuts and
    # creates new ones. Restoring a deleted one would point to a missing app.
    if (-not (Test-Path -LiteralPath $shortcutPath)) {
        continue
    }

    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = [string]$saved.TargetPath
    $shortcut.Arguments = [string]$saved.Arguments
    $shortcut.WorkingDirectory = [string]$saved.WorkingDirectory
    $shortcut.IconLocation = [string]$saved.IconLocation
    $shortcut.WindowStyle = [int]$saved.WindowStyle
    $shortcut.Save()
    $restored++
}

Write-Output "Restored shortcuts: $restored"
Write-Output "Removed shortcuts created by the installer: $removed"
Write-Output "You can now delete $InstallDirectory"
