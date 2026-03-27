$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$modelsDir = if ($env:MODELS_DIR) { $env:MODELS_DIR } else { Join-Path $root "models" }
$genUrl = $env:GEN_MODEL_URL
$embedUrl = $env:EMBED_MODEL_URL
$genSha = $env:GEN_MODEL_SHA256
$embedSha = $env:EMBED_MODEL_SHA256
$profile = if ($env:AI_PROFILE) { $env:AI_PROFILE } else { "compact" }

New-Item -ItemType Directory -Force -Path $modelsDir | Out-Null

function Download-File([string]$Url, [string]$OutFile) {
  if ([string]::IsNullOrWhiteSpace($Url)) { throw "Missing URL for $OutFile (set env var)." }
  Write-Host "Downloading $(Split-Path $OutFile -Leaf) ..."
  & curl.exe -L --fail -o $OutFile $Url
}

function Verify-Sha([string]$File, [string]$Expected) {
  if ([string]::IsNullOrWhiteSpace($Expected)) { return }
  $actual = (Get-FileHash $File -Algorithm SHA256).Hash
  if ($actual.ToUpper() -ne $Expected.ToUpper()) {
    throw "SHA256 mismatch for $(Split-Path $File -Leaf). Expected=$Expected Actual=$actual"
  }
}

function Warn-Size([string]$File, [string]$Profile) {
  $bytes = (Get-Item $File).Length
  $mb = [math]::Floor($bytes / 1MB)
  Write-Host "$(Split-Path $File -Leaf): $mb MB"
  if ((Split-Path $File -Leaf) -eq "omni-law-gen.gguf") {
    if ($Profile -eq "compact" -and ($mb -lt 250 -or $mb -gt 650)) {
      Write-Warning "Compact generator target is roughly 250-650MB (got $mb MB)."
    }
    if ($Profile -eq "quality" -and $mb -le 650) {
      Write-Warning "Quality profile usually expects >650MB generator file."
    }
  }
}

$genFile = Join-Path $modelsDir "omni-law-gen.gguf"
$embedFile = Join-Path $modelsDir "omni-law-embed.gguf"

Download-File $genUrl $genFile
Download-File $embedUrl $embedFile
Verify-Sha $genFile $genSha
Verify-Sha $embedFile $embedSha
Warn-Size $genFile $profile
Warn-Size $embedFile $profile

$modelInfoPath = Join-Path $root "models\\MODEL_INFO.json"
$modelInfo = @{
  generator = @{
    alias = "omni-law-gen.gguf"
    profile = $profile
    size_mb = [math]::Floor((Get-Item $genFile).Length / 1MB)
    quant = ""
    notes = "Local offline generator model alias"
  }
  embedder = @{
    alias = "omni-law-embed.gguf"
    size_mb = [math]::Floor((Get-Item $embedFile).Length / 1MB)
  }
} | ConvertTo-Json -Depth 5
$modelInfo | Set-Content -Path $modelInfoPath -Encoding UTF8
Write-Host "Models downloaded to $modelsDir"
Write-Host "Metadata written to $modelInfoPath"

