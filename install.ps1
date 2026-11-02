[CmdletBinding()]
param(
    [switch]$CoreOnly,
    [switch]$SkipNodeInstall,
    [switch]$SkipPythonInstall,
    [switch]$WithTests,
    [switch]$FaceModels
)
$ErrorActionPreference = 'Stop'
$launcherArgs = @('install')
if ($CoreOnly) { $launcherArgs += '--core-only' }
if ($SkipNodeInstall) { $launcherArgs += '--skip-node-install' }
if ($SkipPythonInstall) { $launcherArgs += '--skip-python-install' }
if ($WithTests) { $launcherArgs += '--with-tests' }
if ($FaceModels) { $launcherArgs += '--face-models' }
& node (Join-Path $PSScriptRoot 'scripts/project.mjs') @launcherArgs
if ($LASTEXITCODE -ne 0) { throw 'Installation failed. See the error above.' }
