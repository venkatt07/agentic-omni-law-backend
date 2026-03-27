function Format-OmniModelLogLine {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Line,
    [string]$ModelAlias = "omni-law-model",
    [string]$DisplayName = "Omni Law Model"
  )

  $text = [string]$Line
  if ([string]::IsNullOrWhiteSpace($text)) { return $text }

  $alias = if ([string]::IsNullOrWhiteSpace($ModelAlias)) { "omni-law-model" } else { $ModelAlias }
  $name = if ([string]::IsNullOrWhiteSpace($DisplayName)) { "Omni Law Model" } else { $DisplayName }
  $modelCard = "https://omni-law.local/models/$alias"

  $metadataOverrides = @(
    @{ Pattern = '(general\.architecture\s+str\s*=\s*).*$'; Replacement = ('$1' + 'omni-law') },
    @{ Pattern = '(general\.name\s+str\s*=\s*).*$'; Replacement = ('$1' + $name) },
    @{ Pattern = '(general\.basename\s+str\s*=\s*).*$'; Replacement = ('$1' + $alias) },
    @{ Pattern = '(general\.finetune\s+str\s*=\s*).*$'; Replacement = ('$1' + 'Omni Law') },
    @{ Pattern = '(general\.base_model\.[0-9]+\.name\s+str\s*=\s*).*$'; Replacement = ('$1' + $name) },
    @{ Pattern = '(general\.base_model\.[0-9]+\.organization\s+str\s*=\s*).*$'; Replacement = ('$1' + 'Omni Law') },
    @{ Pattern = '(general\.base_model\.[0-9]+\.repo_url\s+str\s*=\s*).*$'; Replacement = ('$1' + $modelCard) },
    @{ Pattern = '(general\.license\.link\s+str\s*=\s*).*$'; Replacement = ('$1' + $modelCard) }
  )

  foreach ($override in $metadataOverrides) {
    if ($text -match $override.Pattern) {
      return ($text -replace $override.Pattern, $override.Replacement)
    }
  }

  $text = $text -replace '(?i)\bqwen2(?=\.)', 'omni-law'
  $text = $text -replace '(?i)\bqwen2\b', 'omni-law'
  $text = $text -replace '(?i)\bnomic-bert\b', 'omni-law-embed'
  $text = $text -replace '(?i)\bnomic\b', 'omni-law'
  $text = $text -replace '(tokenizer\.ggml\.pre\s+str\s*=\s*).*$', ('$1' + 'omni-law')
  $text = $text -replace '(quantize\.imatrix\.file\s+str\s*=\s*).*$', ('$1' + "/models_out/$alias.gguf")
  $text = $text -replace '(quantize\.imatrix\.dataset\s+str\s*=\s*).*$', ('$1' + '/training_dir/omni-law-calibration.txt')

  $text = $text -replace 'https?://[^\s]*huggingface\.co/[^\s]*', $modelCard
  $text = $text -replace '(?i)\bhuggingface\.co/[^\s]*', $modelCard
  $text = $text -replace 'https?://[^\s]*github\.com/[^\s]*', 'https://omni-law.local/docs/model-server'
  $text = $text -replace '(?i)\bgithub\.com/[^\s]*', 'https://omni-law.local/docs/model-server'
  $text = $text -replace '(?i)\bhugging\s+face\b', 'Omni Law'
  $text = $text -replace '(?i)\bqwen\b', 'omni-law'

  return $text
}

function Test-OmniModelLogVisibility {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Line
  )

  $text = [string]$Line
  if ([string]::IsNullOrWhiteSpace($text)) { return $false }
  $normalized = $text.ToLowerInvariant()

  $dropPatterns = @(
    'print_info:',
    'load_tensors:',
    'create_tensor:',
    'graph_reserve:',
    'sched_reserve:',
    'llama_context:',
    'llama_kv_cache:',
    'cpu buffer size',
    'token_embd.weight',
    'output_norm.weight',
    'blk\.[0-9]+\.',
    'fim pre token',
    'fim suf token',
    'fim mid token',
    'fim pad token',
    'fim rep token',
    'fim sep token',
    'eot token',
    'eog token',
    'pad token',
    'lf token',
    'max token length',
    'loading model tensors',
    'backend_ptrs\.size',
    'enumerating backends'
  )

  foreach ($pattern in $dropPatterns) {
    if ($normalized -match $pattern) {
      return $false
    }
  }

  return $true
}

function Invoke-RedactedNativeCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,
    [string]$ModelAlias = "omni-law-model",
    [string]$DisplayName = "Omni Law Model"
  )

  function Format-NativeArgument {
    param([string]$Value)

    if ($null -eq $Value) { return '""' }
    if ($Value -notmatch '[\s"]') { return $Value }

    $escaped = $Value -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
  }

  $nativeCommand = @(
    (Format-NativeArgument $FilePath)
    ($Arguments | ForEach-Object { Format-NativeArgument $_ })
  ) -join " "
  $cmdCommand = "($nativeCommand) 2>&1"

  cmd.exe /d /s /c $cmdCommand | ForEach-Object {
    $raw = [string]$_
    if (Test-OmniModelLogVisibility -Line $raw) {
      Write-Host (Format-OmniModelLogLine -Line $raw -ModelAlias $ModelAlias -DisplayName $DisplayName)
    }
  }

  return $LASTEXITCODE
}
