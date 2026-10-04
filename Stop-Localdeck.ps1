$ErrorActionPreference = 'Stop'
$statePath = Join-Path $env:LOCALAPPDATA 'Localdeck\collector.json'
$collectorState = $null
if (Test-Path -LiteralPath $statePath) {
    $collectorState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $env:LOCALDECK_TOKEN = $collectorState.token
}
Push-Location $PSScriptRoot
try {
    if ($collectorState) {
        & docker compose stop
        if ($LASTEXITCODE -ne 0) { Write-Warning 'Docker non joignable. Le collecteur va être arrêté.' }
        $process = Get-Process -Id $collectorState.pid -ErrorAction SilentlyContinue
        if ($process -and $process.Path -eq $collectorState.binary -and $process.StartTime.ToUniversalTime().Ticks -eq [long]$collectorState.ticks) {
            Stop-Process -Id $process.Id
        }
        Remove-Item -LiteralPath $statePath
    }
    Write-Host 'Localdeck arrêté. Vos autres serveurs sont conservés.'
} finally { Remove-Item Env:LOCALDECK_TOKEN -ErrorAction SilentlyContinue; Pop-Location }
