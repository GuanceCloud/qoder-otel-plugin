[CmdletBinding()]
param(
  [string]$Version = 'latest',
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$InstallArguments
)
$ErrorActionPreference = 'Stop'
$repo = if ($env:QODER_OTEL_REPO) { $env:QODER_OTEL_REPO } else { 'GuanceCloud/qoder-otel-plugin' }
$asset = if ($env:QODER_OTEL_RELEASE_ASSET_NAME) { $env:QODER_OTEL_RELEASE_ASSET_NAME } else { 'qoder-otel-plugin.tar.gz' }
$base = "https://github.com/$repo/releases"
$url = if ($Version -eq 'latest') { "$base/latest/download/$asset" } else { "$base/download/$Version/$asset" }
$temp = Join-Path ([IO.Path]::GetTempPath()) ("qoder-otel-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temp | Out-Null
try {
  $archive = Join-Path $temp $asset
  Write-Host "[qoder-otel-plugin] downloading $url"
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $archive
  & tar.exe -xzf $archive -C $temp
  if ($LASTEXITCODE -ne 0) { throw 'Failed to extract release archive with tar.exe' }
  $installer = Get-ChildItem -Path $temp -Filter install-local.mjs -Recurse | Select-Object -First 1
  if (-not $installer) { throw 'Invalid release archive: scripts/install-local.mjs not found' }
  $node = if ($env:QODER_OTEL_NODE) { $env:QODER_OTEL_NODE } else { (Get-Command node -ErrorAction Stop).Source }
  & $node $installer.FullName @InstallArguments
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force }
}
