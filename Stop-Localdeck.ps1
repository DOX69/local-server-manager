param([switch]$DisableAutostart)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Collector-Lifecycle.ps1')
$stateDirectory = Join-Path $env:LOCALAPPDATA 'Localdeck'
# Docker Desktop start/stop is the normal workflow. This script also stops the Windows host.
& docker stop localdeck
if ($LASTEXITCODE -ne 0) { Write-Warning 'Docker non joignable. Le collecteur va être arrêté.' }
Stop-LocaldeckHost $stateDirectory
if ($DisableAutostart) {
    $shortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'Localdeck.lnk'
    if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut }
    Write-Host 'Démarrage automatique désactivé. Relancez Démarrer.cmd pour le réinstaller.'
}
Write-Host "Localdeck arrêté jusqu'à la prochaine connexion Windows ou au lancement de Démarrer.cmd. Vos autres serveurs sont conservés."
