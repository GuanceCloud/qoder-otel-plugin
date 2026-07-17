[CmdletBinding()]
param(
  [ValidateSet('gtrace', 'otlp', 'otel')][string]$Type = 'gtrace',
  [ValidateSet('cn', 'global', 'auto')][string]$Variant = 'auto',
  [string]$Endpoint,
  [string]$XToken,
  [string]$TracePath,
  [string]$MetricsPath,
  [string[]]$Header = @(),
  [string[]]$Tag = @(),
  [string]$ConfigFile,
  [switch]$NoConfig,
  [switch]$KeepOld
)
$ErrorActionPreference = 'Stop'
$node = if ($env:QODER_OTEL_NODE) { $env:QODER_OTEL_NODE } else { (Get-Command node -ErrorAction Stop).Source }
$arguments = @('--type', $Type, '--variant', $Variant)
if ($Endpoint) { $arguments += @('--endpoint', $Endpoint) }
if ($XToken) { $arguments += @('--x-token', $XToken) }
if ($TracePath) { $arguments += @('--trace-path', $TracePath) }
if ($MetricsPath) { $arguments += @('--metrics-path', $MetricsPath) }
foreach ($item in $Header) { $arguments += @('--header', $item) }
foreach ($item in $Tag) { $arguments += @('--tag', $item) }
if ($ConfigFile) { $arguments += @('--config-file', $ConfigFile) }
if ($NoConfig) { $arguments += '--no-config' }
if ($KeepOld) { $arguments += '--keep-old' }
& $node (Join-Path $PSScriptRoot 'install-local.mjs') @arguments
exit $LASTEXITCODE
