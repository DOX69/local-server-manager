param([switch]$NoBrowser, [switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
$projectDirectory = $PSScriptRoot
$stateDirectory = Join-Path $env:LOCALAPPDATA 'Localdeck'
New-Item -ItemType Directory -Force -Path $stateDirectory | Out-Null
$statePath = Join-Path $stateDirectory 'collector.json'
$binaryPath = Join-Path $projectDirectory 'target\release\localdeck.exe'
Push-Location $projectDirectory
try {
    & docker info --format '{{.OSType}}'
    if ($LASTEXITCODE -ne 0) { throw 'Démarrez Docker Desktop, puis relancez Localdeck.' }
    $collectorState = $null
    if (Test-Path -LiteralPath $statePath) {
        $candidateState = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        $candidateProcess = Get-Process -Id $candidateState.pid -ErrorAction SilentlyContinue
        if ($candidateProcess -and $candidateProcess.Path -eq $binaryPath -and $candidateProcess.StartTime.ToUniversalTime().Ticks -eq [long]$candidateState.ticks) {
            $collectorState = $candidateState
        }
    }
    $buildRequired = -not $SkipBuild -or -not (Test-Path -LiteralPath $binaryPath)
    if ($buildRequired -and -not $collectorState) {
        Push-Location (Join-Path $projectDirectory 'web')
        try {
            & npm.cmd ci --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw 'Installation du frontend échouée.' }
            & npm.cmd run build
            if ($LASTEXITCODE -ne 0) { throw 'Compilation du frontend échouée.' }
        } finally { Pop-Location }
        & cargo build --release --locked
        if ($LASTEXITCODE -ne 0) { throw 'Compilation Rust échouée.' }
    }
    if ($collectorState -and $buildRequired) { Write-Host 'Collecteur Localdeck déjà actif, réutilisation du processus.' }
    if (-not $collectorState) {
        $tokenBytes = New-Object byte[] 32
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        $rng.GetBytes($tokenBytes)
        $rng.Dispose()
        $env:LOCALDECK_TOKEN = ([BitConverter]::ToString($tokenBytes)).Replace('-', '').ToLowerInvariant()
        $configuration = Get-Content -LiteralPath (Join-Path $projectDirectory 'config.json') -Raw | ConvertFrom-Json
        $env:LOCALDECK_ROOTS = ConvertTo-Json -InputObject @($configuration.roots) -Compress
        $process = Start-Process -FilePath $binaryPath -ArgumentList '--collector' -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $stateDirectory 'collector.log') -RedirectStandardError (Join-Path $stateDirectory 'collector-error.log')
        $collectorState = @{ pid=$process.Id; ticks=$process.StartTime.ToUniversalTime().Ticks; token=$env:LOCALDECK_TOKEN; binary=$binaryPath }
        $collectorState | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
    }
    $env:LOCALDECK_TOKEN = $collectorState.token
    $ready = $false
    for ($attempt=0; $attempt -lt 30; $attempt++) {
        try {
            Invoke-RestMethod -Uri 'http://127.0.0.1:4781/api/snapshot' -Headers @{ 'X-Localdeck-Token'=$env:LOCALDECK_TOKEN } -TimeoutSec 2 | Out-Null
            $ready = $true
            break
        } catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $ready) { throw "Collecteur indisponible. Consultez $stateDirectory\collector-error.log. Vérifiez le port 4781." }
    & docker compose up -d --build
    if ($LASTEXITCODE -ne 0) { throw 'Démarrage Docker échoué.' }
    Write-Host 'Localdeck : http://localhost:4780'
    Write-Host 'Docker Desktop > localdeck > dashboard : demarrer / arreter interface.'
    if (-not $NoBrowser) { Start-Process 'http://localhost:4780' }
} finally {
    Remove-Item Env:LOCALDECK_TOKEN -ErrorAction SilentlyContinue
    Remove-Item Env:LOCALDECK_ROOTS -ErrorAction SilentlyContinue
    Pop-Location
}
