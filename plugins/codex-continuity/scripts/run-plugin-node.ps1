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

$nodeCandidates = [System.Collections.Generic.List[string]]::new()
$codexCandidates = [System.Collections.Generic.List[string]]::new()
if ($env:CODEX_CONTINUITY_NODE) {
  $nodeCandidates.Add($env:CODEX_CONTINUITY_NODE)
}
foreach ($processName in @("Codex", "ChatGPT")) {
  foreach ($process in @(Get-Process -Name $processName -ErrorAction SilentlyContinue)) {
    try {
      Add-RuntimeCandidatesFromApp $nodeCandidates $codexCandidates $process.Path
    } catch {}
  }
}
$pathNode = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if ($pathNode) {
  $nodeCandidates.Add($pathNode.Source)
}
$pathCodex = Get-Command codex.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if ($pathCodex) {
  $codexCandidates.Add($pathCodex.Source)
}

$nodeRuntime = $nodeCandidates |
  Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } |
  Select-Object -First 1

$entryPoints = @{
  prompt = "src\plugin-prompt-hook.mjs"
  stop = "src\plugin-stop-hook.mjs"
  title = "src\plugin-title-command.mjs"
  dispatch = "skills\continuity-subagent-dispatch\scripts\select-profile.mjs"
}

if (-not $env:CODEX_CONTINUITY_CODEX) {
  $codexRuntime = $codexCandidates |
    Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } |
    Select-Object -First 1
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
