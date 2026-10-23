param([string]$Url='http://localhost:4780', [switch]$RestartDashboard)
$ErrorActionPreference='Stop'
function Assert-True($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
if ($RestartDashboard) {
    . (Join-Path $PSScriptRoot 'Collector-Lifecycle.ps1')
    $stateDirectory = Join-Path $env:LOCALAPPDATA 'Localdeck'
    $settings = Get-Content -LiteralPath (Join-Path $stateDirectory 'settings.json') -Raw | ConvertFrom-Json
    $shortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'Localdeck.lnk'
    Assert-True (Test-Path -LiteralPath $shortcut) 'Le raccourci de demarrage Windows doit etre installe.'
    & docker stop localdeck | Out-Null
    Assert-True ($LASTEXITCODE -eq 0) 'Arret du dashboard echoue.'
    Stop-LocaldeckHost $stateDirectory
    # Exercise the exact logon shortcut, without running the installer or rebuilding the container.
    Start-Process -FilePath $shortcut -WindowStyle Hidden
    & docker start localdeck | Out-Null
    Assert-True ($LASTEXITCODE -eq 0) 'Demarrage du dashboard echoue.'
    $ready = $false
    for ($i=0; $i -lt 60; $i++) {
        try {
            $session = Invoke-RestMethod "$Url/api/session"
            $inventory = Invoke-RestMethod "$Url/api/snapshot" -Headers @{'X-Localdeck-Token'=$session.token} -TimeoutSec 2
            if (-not $inventory.loading) { $ready = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 500
    }
    Assert-True $ready 'Le conteneur existant doit retrouver le collecteur apres une nouvelle session.'
    $recovered = Get-Content -LiteralPath (Join-Path $stateDirectory 'collector.json') -Raw | ConvertFrom-Json
    Assert-True ($recovered.token -eq $settings.token) 'Le secret doit rester identique apres redemarrage.'
    Write-Host 'PASS : raccourci de connexion Windows puis docker start, sans installation ni reconstruction, inventaire disponible et secret conserve.'
}
$session=Invoke-RestMethod "$Url/api/session"
$headers=@{'X-Localdeck-Token'=$session.token}
function Snapshot { Invoke-RestMethod "$Url/api/snapshot" -Headers $headers }
function Wait-For($Predicate) {
    for ($i=0;$i -lt 70;$i++) {
        $inventory=Snapshot
        if (& $Predicate $inventory) { return $inventory }
        Start-Sleep -Milliseconds 500
    }
    throw 'Inventaire attendu non observe dans le delai.'
}
function Post-Stop($Body) { Invoke-RestMethod "$Url/api/stop" -Method Post -Headers $headers -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Compress) }
try { Invoke-WebRequest "$Url/api/snapshot" -UseBasicParsing | Out-Null; throw 'API accessible sans jeton' }
catch { Assert-True ($_.Exception.Response.StatusCode.value__ -eq 403) 'Une API sans jeton doit repondre 403.' }
$listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
$listener.Start(); $port=$listener.LocalEndpoint.Port; $listener.Stop()
$fixture=Join-Path $env:TEMP ('Localdeck smoke '+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
& git init --quiet $fixture
Assert-True ($LASTEXITCODE -eq 0) 'Git init fixture echoue.'
$server=$null; $containerId=$null; $row=$null
try {
    Set-Content -LiteralPath (Join-Path $fixture 'server.cjs') -Value "require('node:http').createServer((req,res)=>res.end('Localdeck smoke')).listen(Number(process.argv[2]),'127.0.0.1');" -Encoding ASCII
    $server=Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList @(('"'+(Join-Path $fixture 'server.cjs')+'"'),"$port") -WorkingDirectory $fixture -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $fixture 'server.log') -RedirectStandardError (Join-Path $fixture 'server-error.log')
    $inventory=Wait-For { param($s) @($s.servers | Where-Object { $_.port -eq $port -and @($_.ancestry | Where-Object { $_.pid -eq $server.Id }).Count -gt 0 }).Count -gt 0 }
    $row=$inventory.servers | Where-Object { $_.port -eq $port -and @($_.ancestry | Where-Object { $_.pid -eq $server.Id }).Count -gt 0 } | Select-Object -First 1
    Assert-True $row.stoppable 'Le serveur de test doit pouvoir etre arrete.'
    Assert-True ($row.repo.Replace('/','\').TrimEnd('\') -eq $fixture) 'Attribution repo incorrecte.'
    try { Post-Stop @{kind='process';pid=$row.pid;started=1} | Out-Null; throw 'PID perime accepte' }
    catch { Assert-True ($_.Exception.Response.StatusCode.value__ -eq 409) 'Un PID perime doit etre refuse.' }
    Post-Stop @{kind='process';pid=$row.pid;started=$row.started} | Out-Null
    $server.WaitForExit(5000) | Out-Null
    Assert-True $server.HasExited 'Le serveur de test tourne encore.'
    Wait-For { param($s) @($s.servers | Where-Object { $_.pid -eq $row.pid }).Count -eq 0 } | Out-Null
    Write-Host 'PASS : authentification, repo avec espaces, PID perime refuse, processus et port fermes.'
    $containerId=(& docker run -d --name ('localdeck-smoke-'+[guid]::NewGuid().ToString('N')) --label localdeck.test=true redis:7-alpine).Trim()
    Assert-True ($LASTEXITCODE -eq 0) 'Creation du conteneur jetable echouee.'
    $inventory=Wait-For { param($s) @($s.containers | Where-Object { $_.id -eq $containerId }).Count -gt 0 }
    $container=$inventory.containers | Where-Object { $_.id -eq $containerId }
    Post-Stop @{kind='container';id=$container.id;started=$container.started} | Out-Null
    $running=& docker inspect --format '{{.State.Running}}' $containerId
    Assert-True ($running -eq 'false') 'Le conteneur jetable tourne encore.'
    $own=$inventory.containers | Where-Object { $_.name -eq 'localdeck' }
    Assert-True (-not $own.stoppable) 'Localdeck doit etre protege.'
    Write-Host 'PASS : conteneur jetable arrete, Localdeck protege.'
} finally {
    if ($server -and -not $server.HasExited) { & taskkill.exe /PID $server.Id /T /F | Out-Null }
    if ($containerId) { & docker rm -f $containerId | Out-Null }
    $resolvedFixture=[IO.Path]::GetFullPath($fixture)
    $resolvedTemp=[IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')+'\'
    if ($resolvedFixture.StartsWith($resolvedTemp,[StringComparison]::OrdinalIgnoreCase) -and (Split-Path $resolvedFixture -Leaf).StartsWith('Localdeck smoke ')) {
        Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
    }
}
