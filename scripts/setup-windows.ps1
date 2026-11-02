# Compatibility entry point shared with the root installer.
[CmdletBinding()]
param(
    [switch]$CoreOnly,
    [switch]$SkipNodeInstall,
    [switch]$SkipPythonInstall,
    [switch]$WithTests,
    [switch]$FaceModels
)
& (Join-Path (Split-Path -Parent $PSScriptRoot) 'install.ps1') @PSBoundParameters
