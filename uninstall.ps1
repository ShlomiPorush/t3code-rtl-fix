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
