param([string]$Binary = (Join-Path $PSScriptRoot 'target\debug\localdeck.exe'))
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Collector-Lifecycle.ps1')
function Assert-True($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
foreach ($script in (Get-ChildItem -LiteralPath $PSScriptRoot -Filter *.ps1)) {
    $parseTokens = $null; $parseErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($script.FullName, [ref]$parseTokens, [ref]$parseErrors) | Out-Null
    Assert-True (-not $parseErrors) ("Syntaxe PowerShell invalide : "+$script.Name+" "+($parseErrors.Message -join '; '))
}
$fixtureRoot = Join-Path $PSScriptRoot 'artifacts'
New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null
$fixture = Join-Path $fixtureRoot ('Localdeck lifecycle '+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop()
$previousPort = $env:LOCALDECK_PORT
$env:LOCALDECK_PORT = "$port"
$token = 'localdeck-lifecycle-test-token-123456789'
$watcher = Join-Path $PSScriptRoot 'Watch-Localdeck.ps1'
$taskName = 'Localdeck-test-'+[guid]::NewGuid().ToString('N')
function Start-Watcher {
    $runner = Start-Process powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ('"'+$watcher+'"'), '-StateDirectory', ('"'+$fixture+'"')) -WindowStyle Hidden -WorkingDirectory $env:TEMP -PassThru
    # An adopted collector can be ready before its new supervisor has even started.
    for ($i=0; $i -lt 120; $i++) {
        if ($runner.HasExited) { return $runner }
        try {
            $state = Get-Content -LiteralPath (Join-Path $fixture 'supervisor.json') -Raw | ConvertFrom-Json
            if ($state.pid -eq $runner.Id -and (Get-LocaldeckProcess $state)) { return $runner }
        } catch { }
        Start-Sleep -Milliseconds 250
    }
    Stop-Process -Id $runner.Id
    throw 'Le superviseur ne publie pas son identite.'
}
function Wait-Collector([int]$PreviousPid = 0) {
    for ($i=0; $i -lt 60; $i++) {
        try {
            $state = Get-Content -LiteralPath (Join-Path $fixture 'collector.json') -Raw | ConvertFrom-Json
            $process = Get-LocaldeckProcess $state
            if ($process -and $process.Id -ne $PreviousPid) {
                Invoke-RestMethod "http://127.0.0.1:$port/api/snapshot" -Headers @{'X-Localdeck-Token'=$token} -TimeoutSec 2 | Out-Null
                return $state
            }
        } catch { }
        Start-Sleep -Milliseconds 250
    }
    throw 'Collecteur attendu absent.'
}
try {
    Copy-Item -LiteralPath $Binary -Destination (Join-Path $fixture 'localdeck.exe')
    foreach ($name in @('Watch-Localdeck.ps1', 'Collector-Lifecycle.ps1')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $fixture $name)
    }
    @{ token=$token; binary=(Join-Path $fixture 'localdeck.exe'); roots=@(); port=$port } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $fixture 'settings.json') -Encoding UTF8
    $supervisor = Start-Watcher
    $first = Wait-Collector
    Assert-True ($first.token -eq $token) 'Le secret configure doit etre conserve.'
    $stale = @{ pid=$first.pid; ticks=1; binary=$first.binary }
    Assert-True (-not (Get-LocaldeckProcess $stale)) 'Un PID recycle doit etre ignore.'
    $duplicate = Start-Watcher
    Assert-True ($duplicate.WaitForExit(5000)) 'Un deuxieme superviseur doit sortir.'
    Assert-True ((Wait-Collector).pid -eq $first.pid) 'Le double lancement doit conserver le collecteur.'
    Stop-Process -Id $first.pid
    $recovered = Wait-Collector $first.pid
    Assert-True ($recovered.token -eq $first.token) 'La relance doit conserver le secret Docker.'
    Stop-Process -Id $supervisor.Id
    $supervisor.WaitForExit()
    $supervisor = Start-Watcher
    Assert-True ((Wait-Collector).pid -eq $recovered.pid) 'Le superviseur doit reprendre le collecteur existant.'
    Stop-LocaldeckHost $fixture
    Assert-True (-not (Get-LocaldeckProcess $recovered)) 'L arret doit fermer le collecteur.'
    $supervisor = Start-Watcher
    $fresh = Wait-Collector $recovered.pid
    Assert-True ($fresh.token -eq $token) 'Une nouvelle session doit reutiliser le secret.'
    Stop-LocaldeckHost $fixture
    Register-LocaldeckAutostart $fixture $taskName
    Start-ScheduledTask -TaskName $taskName
    $scheduled = Wait-Collector $fresh.pid
    $task = Get-ScheduledTask -TaskName $taskName
    Assert-True ($task.Principal.RunLevel -eq 'Limited') 'La tache doit rester sans elevation.'
    Assert-True ($task.Settings.ExecutionTimeLimit -eq 'PT0S') 'Le superviseur ne doit pas expirer apres trois jours.'
    $scheduledSupervisor = Get-Content -LiteralPath (Join-Path $fixture 'supervisor.json') -Raw | ConvertFrom-Json
    Stop-Process -Id $scheduledSupervisor.pid
    Stop-Process -Id $scheduled.pid
    # The repeating trigger recovers even a supervisor killed without an error code.
    $recoveredTask = $null
    for ($i=0; $i -lt 180; $i++) {
        try {
            $state = Get-Content -LiteralPath (Join-Path $fixture 'collector.json') -Raw | ConvertFrom-Json
            if ($state.pid -ne $scheduled.pid -and (Get-LocaldeckProcess $state)) {
                $recoveredTask = Wait-Collector $scheduled.pid
                break
            }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    Assert-True $recoveredTask 'La tache doit relancer le superviseur et le collecteur apres leur arret brutal.'
    Assert-True ($recoveredTask.token -eq $token) 'La reprise automatique doit conserver le secret.'
    Stop-LocaldeckHost $fixture $taskName
    Assert-True (-not (Get-LocaldeckProcess $recoveredTask)) 'L arret explicite doit fermer le collecteur supervise par Windows.'
    Start-ScheduledTask -TaskName $taskName
    Wait-Collector $recoveredTask.pid | Out-Null
    Write-Host 'PASS : tache Windows sans elevation, reprise automatique du superviseur et collecteur, arret explicite et nouvelle connexion.'
    Write-Host 'PASS : demarrage sans repo ni secret dans le shell, doublon, PID perime, reprise, relance apres panne, nouvelle session et secret stable.'
} finally {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Stop-LocaldeckHost $fixture $taskName
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    } else { Stop-LocaldeckHost $fixture }
    $env:LOCALDECK_PORT = $previousPort
    $resolved = [IO.Path]::GetFullPath($fixture)
    $resolvedRoot = [IO.Path]::GetFullPath($fixtureRoot).TrimEnd('\')+'\'
    if ($resolved.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolved -Leaf).StartsWith('Localdeck lifecycle ')) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
