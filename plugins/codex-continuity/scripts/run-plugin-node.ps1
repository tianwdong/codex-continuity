[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("prompt", "stop", "title", "dispatch")]
  [string]$Mode,

  [ValidateSet("status", "undo", "lock", "resume")]
  [string]$Operation,

  [ValidateSet("economy", "quality")]
  [string]$RecommendationMode,

  [ValidateSet("focused", "exploration", "demanding")]
  [string]$TaskClass
)

$ErrorActionPreference = "Stop"
$pluginRoot = if ($env:PLUGIN_ROOT) {
  $env:PLUGIN_ROOT
} else {
  Split-Path -Parent $PSScriptRoot
}

function Add-RuntimeCandidatesFromApp(
  [System.Collections.Generic.List[string]]$NodeCandidates,
  [System.Collections.Generic.List[string]]$CodexCandidates,
  [string]$ExecutablePath
) {
  if (-not $ExecutablePath) { return }
  $appDirectory = Split-Path -Parent $ExecutablePath
  foreach ($relativePath in @(
    "resources\cua_node\bin\node.exe",
    "Resources\cua_node\bin\node.exe",
    "resources\cua_node\node.exe",
    "Resources\cua_node\node.exe",
    "resources\node.exe",
    "Resources\node.exe"
  )) {
    $NodeCandidates.Add((Join-Path $appDirectory $relativePath))
  }
  foreach ($relativePath in @(
    "resources\codex.exe",
    "Resources\codex.exe",
    "codex.exe"
  )) {
    $CodexCandidates.Add((Join-Path $appDirectory $relativePath))
  }
}

function Add-NpmCodexCandidates(
  [System.Collections.Generic.List[string]]$CodexCandidates
) {
  foreach ($command in @(Get-Command codex -All -ErrorAction SilentlyContinue)) {
    $commandPath = $command.Source
    if (-not $commandPath) { continue }
    $nodeModules = Join-Path (Split-Path -Parent $commandPath) "node_modules\@openai\codex\node_modules"
    if (-not (Test-Path -LiteralPath $nodeModules -PathType Container)) { continue }
    foreach ($candidate in @(Get-ChildItem -LiteralPath $nodeModules -Filter codex.exe -File -Recurse -ErrorAction SilentlyContinue)) {
      $CodexCandidates.Add($candidate.FullName)
    }
  }
}

function Find-UsableRuntime(
  [System.Collections.Generic.List[string]]$Candidates
) {
  foreach ($candidate in @($Candidates | Select-Object -Unique)) {
    try {
      if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
      $null = & $candidate --version 2>$null
      if ($LASTEXITCODE -eq 0) { return $candidate }
    } catch {}
  }
  return $null
}

$nodeCandidates = [System.Collections.Generic.List[string]]::new()
$codexCandidates = [System.Collections.Generic.List[string]]::new()
if ($env:CODEX_CONTINUITY_NODE) {
  $nodeCandidates.Add($env:CODEX_CONTINUITY_NODE)
}
if ($env:CODEX_CLI_PATH) {
  $codexCandidates.Add($env:CODEX_CLI_PATH)
}
foreach ($process in @(Get-Process -Name "ChatGPT" -ErrorAction SilentlyContinue)) {
  try {
    Add-RuntimeCandidatesFromApp $nodeCandidates $codexCandidates $process.Path
  } catch {}
}
$pathCodex = Get-Command codex.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if ($pathCodex) {
  $codexCandidates.Add($pathCodex.Source)
}
Add-NpmCodexCandidates $codexCandidates
foreach ($process in @(Get-Process -Name "Codex" -ErrorAction SilentlyContinue)) {
  try {
    Add-RuntimeCandidatesFromApp $nodeCandidates $codexCandidates $process.Path
  } catch {}
}
$pathNode = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if ($pathNode) {
  $nodeCandidates.Add($pathNode.Source)
}

$nodeRuntime = Find-UsableRuntime $nodeCandidates

$entryPoints = @{
  prompt = "src\plugin-prompt-hook.mjs"
  stop = "src\plugin-stop-hook.mjs"
  title = "src\plugin-title-command.mjs"
  dispatch = "skills\continuity-subagent-dispatch\scripts\select-profile.mjs"
}

if (-not $env:CODEX_CONTINUITY_CODEX) {
  $codexRuntime = Find-UsableRuntime $codexCandidates
  if ($codexRuntime) {
    $env:CODEX_CONTINUITY_CODEX = $codexRuntime
  }
}

if (-not $nodeRuntime) {
  $dataRoot = if ($env:CODEX_CONTINUITY_DATA) {
    $env:CODEX_CONTINUITY_DATA
  } elseif ($env:LOCALAPPDATA) {
    Join-Path $env:LOCALAPPDATA "Codex Continuity Plugin"
  } else {
    Join-Path $HOME "AppData\Local\Codex Continuity Plugin"
  }
  New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
  if ($Mode -eq "stop") {
    Add-Content -LiteralPath (Join-Path $dataRoot "continuity.log") -Value "$([DateTime]::UtcNow.ToString('o')) runtime_unavailable"
  }
  if ($Mode -eq "title") {
    Write-Output '{"ok":false,"error":"runtime_unavailable"}'
    exit 1
  }
  Write-Output '{}'
  exit 0
}

$entryPoint = Join-Path $pluginRoot $entryPoints[$Mode]
$entryArguments = @()
if ($Mode -eq "title") {
  if (-not $Operation) {
    Write-Output '{"ok":false,"error":"operation_unavailable"}'
    exit 1
  }
  $entryArguments = @($Operation)
} elseif ($Mode -eq "dispatch") {
  if (-not $RecommendationMode -or -not $TaskClass) {
    Write-Output '{"ok":false,"error":"dispatch_parameters_unavailable"}'
    exit 1
  }
  $entryArguments = @("--mode", $RecommendationMode, "--task-class", $TaskClass)
}
& $nodeRuntime $entryPoint @EntryArguments
exit $LASTEXITCODE
