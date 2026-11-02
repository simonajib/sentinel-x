$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'scripts/project.mjs') stop
if ($LASTEXITCODE -ne 0) { throw 'Shutdown failed. See the error above.' }
