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

$serverBin = $env:LLAMA_SERVER_BIN
if (-not $serverBin) { throw "Set LLAMA_SERVER_BIN in backend/.env to your local server binary path." }
$modelPath = if ($env:MODEL_GEN_PREVIEW_PATH) { $env:MODEL_GEN_PREVIEW_PATH } elseif ($env:MODEL_GEN_PATH) { $env:MODEL_GEN_PATH } else { ".\models\omni-law-gen-preview.gguf" }
$port = 8003
if ($env:PREVIEW_LLM_ENDPOINT -match ':(\d+)$') { $port = [int]$Matches[1] }
$logicalCores = [Environment]::ProcessorCount
$defaultThreads = [Math]::Max(1, [Math]::Floor($logicalCores / 2))
$threads = if ($env:LLM_THREADS) { $env:LLM_THREADS } else { "$defaultThreads" }
$profile = if ($env:AI_PROFILE) { $env:AI_PROFILE } else { "compact" }
$ctx = if ($env:PREVIEW_GEN_CTX) { $env:PREVIEW_GEN_CTX } elseif ($env:LLM_CTX) { $env:LLM_CTX } elseif ($env:GEN_CTX_COMPACT) { $env:GEN_CTX_COMPACT } else { "2048" }
$nPredict = if ($env:PREVIEW_GEN_MAX_TOKENS) { $env:PREVIEW_GEN_MAX_TOKENS } elseif ($env:GEN_MAX_TOKENS_COMPACT) { $env:GEN_MAX_TOKENS_COMPACT } else { "300" }
$batch = if ($env:LLM_BATCH_SIZE) { $env:LLM_BATCH_SIZE } else { "128" }
$uBatch = if ($env:LLM_UBATCH_SIZE) { $env:LLM_UBATCH_SIZE } else { "32" }
$parallel = if ($env:LLM_PARALLEL) { $env:LLM_PARALLEL } else { "1" }

Write-Host "Starting preview server on port $port with model alias $(if ($env:PREVIEW_LLM_MODEL_ID) { $env:PREVIEW_LLM_MODEL_ID } else { $env:LLM_MODEL_ID })"
Write-Host "Binary: $serverBin"
Write-Host "Model path: $modelPath"
Write-Host "profile=$profile ctx=$ctx threads=$threads n_predict=$nPredict batch=$batch ubatch=$uBatch parallel=$parallel"
Write-Host "Use a smaller GGUF here for low-latency previews."

$existingListener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existingListener) {
  $existingProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($existingListener.OwningProcess)" -ErrorAction SilentlyContinue
  Write-Host "A preview server is already listening on 127.0.0.1:$port (PID $($existingListener.OwningProcess))."
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
  "--ctx-size", "$ctx",
  "--threads", "$threads",
  "--batch-size", "$batch",
  "--ubatch-size", "$uBatch",
  "--parallel", "$parallel",
  "--n-predict", "$nPredict",
  "--log-prefix",
  "--log-timestamps",
  "--perf",
  "--metrics"
)

$displayName = if ($env:PREVIEW_LLM_MODEL_ID) { $env:PREVIEW_LLM_MODEL_ID } elseif ($env:LLM_MODEL_ID) { $env:LLM_MODEL_ID } else { "omni-law-gen-preview" }
$exitCode = Invoke-RedactedNativeCommand -FilePath $serverBin -Arguments $serverArgs -ModelAlias $displayName -DisplayName $displayName
if ($null -ne $exitCode -and $exitCode -ne 0) {
  exit $exitCode
}
