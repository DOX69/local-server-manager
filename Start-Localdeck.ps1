param([switch]$NoBrowser, [switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Collector-Lifecycle.ps1')
$projectDirectory = $PSScriptRoot
$stateDirectory = Join-Path $env:LOCALAPPDATA 'Localdeck'
New-Item -ItemType Directory -Force -Path $stateDirectory | Out-Null
$statePath = Join-Path $stateDirectory 'collector.json'
$settingsPath = Join-Path $stateDirectory 'settings.json'
$binaryPath = Join-Path $projectDirectory 'target\release\localdeck.exe'
Push-Location $projectDirectory
try {
    & docker info --format '{{.OSType}}'
    if ($LASTEXITCODE -ne 0) { throw 'Démarrez Docker Desktop, puis relancez Localdeck.' }
    # Preserve the existing container's secret, including during migration from the old launcher.
    $token = $null
    foreach ($path in @($settingsPath, $statePath)) {
        if (Test-Path -LiteralPath $path) {
            $candidate = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
            if ($candidate.token.Length -ge 32) { $token = $candidate.token; break }
        }
    }
    if (-not $token) {
        $tokenBytes = New-Object byte[] 32
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        $rng.GetBytes($tokenBytes)
        $rng.Dispose()
        $token = ([BitConverter]::ToString($tokenBytes)).Replace('-', '').ToLowerInvariant()
    }
    if (Get-ScheduledTask -TaskName (Get-LocaldeckTaskName) -ErrorAction SilentlyContinue) {
        Disable-ScheduledTask -TaskName (Get-LocaldeckTaskName) | Out-Null
    }
    Stop-LocaldeckHost $stateDirectory (Get-LocaldeckTaskName)
    if (-not $SkipBuild -or -not (Test-Path -LiteralPath $binaryPath)) {
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
    # Installed files survive branch switches and do not lock Cargo's build output.
    $installedBinary = Join-Path $stateDirectory 'localdeck.exe'
    Copy-Item -LiteralPath $binaryPath -Destination $installedBinary -Force
    foreach ($name in @('Watch-Localdeck.ps1', 'Collector-Lifecycle.ps1')) {
        Copy-Item -LiteralPath (Join-Path $projectDirectory $name) -Destination (Join-Path $stateDirectory $name) -Force
    }
    $configuration = Get-Content -LiteralPath (Join-Path $projectDirectory 'config.json') -Raw | ConvertFrom-Json
    @{ token=$token; binary=$installedBinary; roots=@($configuration.roots) } | ConvertTo-Json | Set-Content -LiteralPath $settingsPath -Encoding UTF8
    Register-LocaldeckAutostart $stateDirectory
    $shortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'Localdeck.lnk'
    if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut }
    # Windows owns this process, independently of the terminal running the installer.
    Start-ScheduledTask -TaskName (Get-LocaldeckTaskName)
    $env:LOCALDECK_TOKEN = $token
    $ready = $false
    for ($attempt=0; $attempt -lt 30; $attempt++) {
        try {
            Invoke-RestMethod -Uri 'http://127.0.0.1:4781/api/snapshot' -Headers @{ 'X-Localdeck-Token'=$token } -TimeoutSec 2 | Out-Null
            $ready = $true
            break
        } catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $ready) { throw "Collecteur indisponible. Consultez $stateDirectory\collector-error.log et supervisor-error.log. Vérifiez le port 4781." }
    & docker compose up -d --build
    if ($LASTEXITCODE -ne 0) { throw 'Démarrage Docker échoué.' }
    Write-Host 'Localdeck : http://localhost:4780'
    Write-Host 'Installation terminée. Le collecteur démarre automatiquement à la connexion Windows.'
    Write-Host 'Utilisez désormais Start/Stop dans Docker Desktop pour ouvrir ou fermer Localdeck.'
    if (-not $NoBrowser) { Start-Process 'http://localhost:4780' }
} finally {
    Remove-Item Env:LOCALDECK_TOKEN -ErrorAction SilentlyContinue
    Pop-Location
}
