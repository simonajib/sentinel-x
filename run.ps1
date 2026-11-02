[CmdletBinding()]
param(
    [switch]$Simulate,
    [switch]$NoEsp,
    [string]$Port
)
$ErrorActionPreference = 'Stop'
$launcherArgs = @('start')
if ($Simulate) { $launcherArgs += '--simulate' }
if ($NoEsp) { $launcherArgs += '--no-esp' }
if ($Port) { $launcherArgs += @('--port', $Port) }
& node (Join-Path $PSScriptRoot 'scripts/project.mjs') @launcherArgs
if ($LASTEXITCODE -ne 0) { throw 'Startup failed. See the error above.' }
