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
$modelPath = if ($env:MODEL_GEN_FINAL_PATH) { $env:MODEL_GEN_FINAL_PATH } else { $env:MODEL_GEN_PATH }
if (-not $modelPath) { $modelPath = ".\models\omni-law-gen.gguf" }
$port = 8001
if ($env:FINAL_LLM_ENDPOINT -match ':(\d+)$') { $port = [int]$Matches[1] }
elseif ($env:LLM_ENDPOINT -match ':(\d+)$') { $port = [int]$Matches[1] }
$logicalCores = [Environment]::ProcessorCount
$defaultThreads = [Math]::Max(1, $logicalCores - 1)
$threads = if ($env:LLM_THREADS) { $env:LLM_THREADS } else { "$defaultThreads" }
$profile = if ($env:AI_PROFILE) { $env:AI_PROFILE } else { "quality" }
$ctx = if ($env:FINAL_GEN_CTX) { $env:FINAL_GEN_CTX } elseif ($env:LLM_CTX) { $env:LLM_CTX } elseif ($profile -eq "quality") { if ($env:GEN_CTX_QUALITY) { $env:GEN_CTX_QUALITY } else { "4096" } } else { if ($env:GEN_CTX_COMPACT) { $env:GEN_CTX_COMPACT } else { "2048" } }
$nPredict = if ($env:FINAL_GEN_MAX_TOKENS) { $env:FINAL_GEN_MAX_TOKENS } elseif ($profile -eq "quality") { if ($env:GEN_MAX_TOKENS_QUALITY) { $env:GEN_MAX_TOKENS_QUALITY } else { "700" } } else { if ($env:GEN_MAX_TOKENS_COMPACT) { $env:GEN_MAX_TOKENS_COMPACT } else { "300" } }
$batch = if ($env:LLM_BATCH_SIZE) { $env:LLM_BATCH_SIZE } elseif ($profile -eq "quality") { "256" } else { "128" }
$uBatch = if ($env:LLM_UBATCH_SIZE) { $env:LLM_UBATCH_SIZE } elseif ($profile -eq "quality") { "64" } else { "32" }
$parallel = if ($env:LLM_PARALLEL) { $env:LLM_PARALLEL } else { "1" }

Write-Host "Starting final reasoning server on port $port with model alias $(if ($env:FINAL_LLM_MODEL_ID) { $env:FINAL_LLM_MODEL_ID } else { $env:LLM_MODEL_ID })"
Write-Host "Binary: $serverBin"
Write-Host "Model path: $modelPath"
Write-Host "Adjust command flags for your installed local server runtime if needed."
Write-Host "profile=$profile ctx=$ctx threads=$threads n_predict=$nPredict batch=$batch ubatch=$uBatch parallel=$parallel"
Write-Host "If supported by your local server binary, set keepalive/batch flags for lower latency."

$existingListener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existingListener) {
  $existingProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($existingListener.OwningProcess)" -ErrorAction SilentlyContinue
  Write-Host "A model server is already listening on 127.0.0.1:$port (PID $($existingListener.OwningProcess))."
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

$displayName = if ($env:FINAL_LLM_MODEL_ID) { $env:FINAL_LLM_MODEL_ID } elseif ($env:LLM_MODEL_ID) { $env:LLM_MODEL_ID } else { "omni-law-gen" }
$exitCode = Invoke-RedactedNativeCommand -FilePath $serverBin -Arguments $serverArgs -ModelAlias $displayName -DisplayName $displayName
if ($null -ne $exitCode -and $exitCode -ne 0) {
  exit $exitCode
}
