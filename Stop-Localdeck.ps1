param([switch]$DisableAutostart)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Collector-Lifecycle.ps1')
$stateDirectory = Join-Path $env:LOCALAPPDATA 'Localdeck'
# Keep the host ready for the next Play click in Docker Desktop.
& docker stop localdeck
if ($LASTEXITCODE -ne 0) { Write-Warning 'Docker non joignable.' }
if ($DisableAutostart) {
    Stop-LocaldeckHost $stateDirectory (Get-LocaldeckTaskName)
    $taskName = Get-LocaldeckTaskName
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }
    $shortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'Localdeck.lnk'
    if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut }
    Write-Host 'Démarrage automatique désactivé. Relancez Démarrer.cmd pour le réinstaller.'
} else {
    Write-Host 'Interface arrêtée. Cliquez sur Play dans Docker Desktop pour la rouvrir. Le collecteur Windows reste prêt.'
}
