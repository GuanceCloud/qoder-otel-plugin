[CmdletBinding()]
param(
  [string]$Version = 'latest',
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
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$repo = if ($env:QODER_OTEL_REPO) { $env:QODER_OTEL_REPO } else { 'GuanceCloud/qoder-otel-plugin' }
$asset = if ($env:QODER_OTEL_RELEASE_ASSET_NAME) { $env:QODER_OTEL_RELEASE_ASSET_NAME } else { 'qoder-otel-plugin.tar.gz' }
if ($Version -ne 'latest' -and -not $Version.StartsWith('v')) { $Version = "v$Version" }
$url = if ($env:QODER_OTEL_ARCHIVE_URL) { $env:QODER_OTEL_ARCHIVE_URL } elseif ($Version -eq 'latest') { "https://github.com/$repo/releases/latest/download/$asset" } else { "https://github.com/$repo/releases/download/$Version/$asset" }
$temp = Join-Path ([IO.Path]::GetTempPath()) ("qoder-otel-" + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($temp) | Out-Null
try {
  $archive = Join-Path $temp $asset
  Write-Host "[qoder-otel-plugin] downloading $url"
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $archive
  & tar.exe -xzf $archive -C $temp
  if ($LASTEXITCODE -ne 0) { throw 'Failed to extract release archive with tar.exe' }
  $installer = Get-ChildItem -Path $temp -Filter install-local.mjs -Recurse | Select-Object -First 1
  if (-not $installer) { throw 'Invalid release archive: scripts/install-local.mjs not found' }
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
  & $node $installer.FullName @arguments
  if ($LASTEXITCODE -ne 0) { throw "Plugin installer failed with exit code $LASTEXITCODE" }
} finally {
  if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
}
