$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "model_log_redaction.ps1")

$envFile = Join-Path $PSScriptRoot "..\.env"
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^\s*#' -or $_ -match '^\s*$') { return }
    $parts = $_ -split '=', 2
    if ($parts.Length -eq 2 -and -not [string]::IsNullOrWhiteSpace($parts[0])) {
      [Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1], "Process")
    }
  }
}

function Resolve-LocalPathOrEmpty([string]$pathValue, [string]$baseDir) {
  if ([string]::IsNullOrWhiteSpace($pathValue)) { return "" }
  $trimmed = $pathValue.Trim()
  if (($trimmed.StartsWith('"') -and $trimmed.EndsWith('"')) -or ($trimmed.StartsWith("'") -and $trimmed.EndsWith("'"))) {
    $trimmed = $trimmed.Substring(1, $trimmed.Length - 2)
  }
  if ([System.IO.Path]::IsPathRooted($trimmed)) { return $trimmed }
  return [System.IO.Path]::GetFullPath((Join-Path $baseDir $trimmed))
}

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))

$serverBin = $env:EMBED_SERVER_BIN
if (-not $serverBin) { $serverBin = $env:LLAMA_SERVER_BIN }
if (-not $serverBin) { throw "Set EMBED_SERVER_BIN or LLAMA_SERVER_BIN in backend/.env to your local server binary path." }
$serverBin = Resolve-LocalPathOrEmpty $serverBin $projectRoot
$serverBin = [Environment]::ExpandEnvironmentVariables($serverBin)
$serverBin = [System.IO.Path]::GetFullPath($serverBin)
if (-not (Test-Path -LiteralPath $serverBin)) {
  throw "Embedding server binary not found: $serverBin`nSet EMBED_SERVER_BIN/LLAMA_SERVER_BIN in backend/.env to a valid local llama-server executable."
}

$modelPath = $env:MODEL_EMBED_PATH
if (-not $modelPath) { $modelPath = ".\models\omni-law-embed.gguf" }
$modelPath = Resolve-LocalPathOrEmpty $modelPath $projectRoot
$modelPath = [Environment]::ExpandEnvironmentVariables($modelPath)
$modelPath = [System.IO.Path]::GetFullPath($modelPath)
if (-not (Test-Path -LiteralPath $modelPath)) {
  throw "Embedding model not found: $modelPath`nSet MODEL_EMBED_PATH in backend/.env to a valid local .gguf model path."
}

$port = 8002
if ($env:EMBED_ENDPOINT -match ':(\d+)$') { $port = [int]$Matches[1] }
$logicalCores = [Environment]::ProcessorCount
$defaultThreads = [Math]::Max(1, $logicalCores - 1)
$threads = if ($env:EMBED_THREADS) { $env:EMBED_THREADS } else { "$defaultThreads" }

Write-Host "Starting local embedding server on port $port with model alias $($env:EMBED_MODEL_ID)"
Write-Host "Binary: $serverBin"
Write-Host "Model path: $modelPath"
Write-Host "threads=$threads"

$existingListener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existingListener) {
  $existingProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($existingListener.OwningProcess)" -ErrorAction SilentlyContinue
  Write-Host "An embedding server is already listening on 127.0.0.1:$port (PID $($existingListener.OwningProcess))."
  if ($existingProcess?.CommandLine) {
    Write-Host "Existing command: $($existingProcess.CommandLine)"
  }
  Write-Host "Stop the existing process first if you want this terminal to own the live logs."
  exit 1
}

$serverArgs = @(
  "--model", $modelPath,
  "--port", "$port",
  "--host", "127.0.0.1",
  "--embeddings",
  "--threads", "$threads",
  "--log-prefix",
  "--log-timestamps",
  "--perf",
  "--metrics"
)

$displayName = if ($env:EMBED_MODEL_ID) { $env:EMBED_MODEL_ID } else { "omni-law-embed" }
$exitCode = Invoke-RedactedNativeCommand -FilePath $serverBin -Arguments $serverArgs -ModelAlias $displayName -DisplayName $displayName
if ($null -ne $exitCode -and $exitCode -ne 0) {
  exit $exitCode
}
