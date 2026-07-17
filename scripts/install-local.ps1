[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$InstallArguments)
$ErrorActionPreference = 'Stop'
$node = if ($env:QODER_OTEL_NODE) { $env:QODER_OTEL_NODE } else { (Get-Command node -ErrorAction Stop).Source }
& $node (Join-Path $PSScriptRoot 'install-local.mjs') @InstallArguments
exit $LASTEXITCODE
