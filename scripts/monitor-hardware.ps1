param(
  [int]$DurationSec = 90,
  [int]$IntervalMs = 1000,
  [int]$GoalCpuPercent = 85,
  [int]$GoalTargetCpuPercent = 70,
  [int]$GoalConsecutiveSamples = 3,
  [int]$GoalGpuPercent = 5,
  [switch]$RequireGpu,
  [switch]$AllowNoTarget,
  [switch]$StopOnPass,
  [switch]$StopOnTargetIdle,
  [double]$IdleTargetCpuPercent = 2.0,
  [int]$IdleConsecutiveSamples = 8,
  [double]$ActiveTargetCpuPercent = 5.0,
  [int]$MinTargetSamples = 8,
  [int]$LogEvery = 1,
  [int]$GpuSampleEvery = 0,
  [switch]$SampleSystemCpu,
  [string[]]$ProcessName = @('electron', 'IFTreeEditor'),
  [string]$CsvPath = ''
)

$ErrorActionPreference = 'Stop'
$logicalCores = [Environment]::ProcessorCount
$samples = [Math]::Max(1, [Math]::Ceiling(($DurationSec * 1000) / [Math]::Max(100, $IntervalMs)))
if ($RequireGpu -and $GpuSampleEvery -le 0) { $GpuSampleEvery = 10 }
$goalRun = 0
$targetGoalRun = 0
$goalHit = $false
$targetGoalHit = $GoalTargetCpuPercent -le 0
$gpuGoalHit = -not $RequireGpu
$targetSeen = $false
$targetActiveSeen = $false
$targetSampleCount = 0
$targetIdleRun = 0
$stoppedOnIdle = $false
$maxCpu = 0.0
$maxTargetCpu = 0.0
$maxGpu = 0.0
$maxTargetGpu = 0.0
$passAtSample = 0
$lastProcCpu = @{}
$lastTime = Get-Date

if ($CsvPath) {
  "time,cpu_total,cpu_target,gpu_total,gpu_target,target_processes" | Set-Content -LiteralPath $CsvPath -Encoding UTF8
}

function Get-CpuTotal() {
  try {
    $sample = (Get-Counter '\Processor(_Total)\% Processor Time' -MaxSamples 1).CounterSamples | Select-Object -First 1
    return [double]$sample.CookedValue
  } catch {
    return 0.0
  }
}

function Get-TargetProcesses([string[]]$Names) {
  $nameSet = @{}
  foreach ($name in $Names) {
    $trimmed = [string]$name
    if ($trimmed.Trim()) { $nameSet[$trimmed.Trim().ToLowerInvariant()] = $true }
  }
  if ($nameSet.Count -eq 0) { return @() }
  return @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $nameSet.ContainsKey($_.ProcessName.ToLowerInvariant())
  })
}

function Get-GpuUsage([int[]]$TargetPids) {
  $targetSet = @{}
  foreach ($targetPid in $TargetPids) { $targetSet[[string]$targetPid] = $true }
  $total = 0.0
  $target = 0.0
  $samples = @()
  try {
    $samples = (Get-Counter '\GPU Engine(*)\Utilization Percentage' -MaxSamples 1).CounterSamples
  } catch {
    $samples = @()
  }
  foreach ($sample in $samples) {
    if ($sample.Path -notmatch '\\gpu engine\(') { continue }
    $value = [double]$sample.CookedValue
    if ($value -le 0) { continue }
    $total += $value
    if ($sample.Path -match 'pid_(\d+)_') {
      if ($targetSet.ContainsKey($Matches[1])) { $target += $value }
    }
  }
  return @{
    Total = [Math]::Min(100.0, $total)
    Target = [Math]::Min(100.0, $target)
  }
}

Write-Host "IFTree hardware monitor"
Write-Host "Goal: CPU >= $GoalCpuPercent% and target CPU >= $GoalTargetCpuPercent% for $GoalConsecutiveSamples consecutive sample(s). Duration=${DurationSec}s Interval=${IntervalMs}ms Cores=$logicalCores"
if ($RequireGpu) {
  Write-Host "GPU gate: target GPU >= $GoalGpuPercent% at least once. GPU sampling every $GpuSampleEvery sample(s)."
} else {
  if ($GpuSampleEvery -gt 0) {
    Write-Host "GPU: reporting every $GpuSampleEvery sample(s). Add -RequireGpu to fail when GPU is not used."
  } else {
    Write-Host "GPU: skipped for high-frequency CPU sampling. Set -GpuSampleEvery or -RequireGpu to sample GPU."
  }
}
if ($StopOnPass) {
  Write-Host "StopOnPass: monitor exits as soon as the goal is reached."
}
if ($StopOnTargetIdle) {
  Write-Host "StopOnTargetIdle: exits after target was active and then stays <= $IdleTargetCpuPercent% target CPU for $IdleConsecutiveSamples sample(s)."
}
if ($SampleSystemCpu) {
  Write-Host "CPU total: sampling Windows processor counter. This is slower."
} else {
  Write-Host "CPU total: fast mode uses target process CPU as the total goal signal."
}
Write-Host "Target processes: $($ProcessName -join ', ')"

for ($i = 1; $i -le $samples; $i++) {
  $sampleStart = Get-Date
  $now = $sampleStart
  $elapsed = [Math]::Max(0.001, ($now - $lastTime).TotalSeconds)
  $targets = Get-TargetProcesses $ProcessName
  if ($targets.Count -gt 0) {
    $targetSeen = $true
    $targetSampleCount++
  }
  $targetPids = @($targets | ForEach-Object { [int]$_.Id })
  $targetNames = @($targets | ForEach-Object { "$($_.ProcessName):$($_.Id)" })

  $targetCpuSeconds = 0.0
  foreach ($proc in $targets) {
    $key = [string]$proc.Id
    $cpu = 0.0
    if ($null -ne $proc.CPU) { $cpu = [double]$proc.CPU }
    if ($lastProcCpu.ContainsKey($key)) {
      $delta = $cpu - [double]$lastProcCpu[$key]
      if ($delta -gt 0) { $targetCpuSeconds += $delta }
    }
    $lastProcCpu[$key] = $cpu
  }

  $cpuTarget = [Math]::Min(100.0, ($targetCpuSeconds / $elapsed / $logicalCores) * 100.0)
  $cpuTotal = if ($SampleSystemCpu) { Get-CpuTotal } else { $cpuTarget }
  $sampleGpu = $GpuSampleEvery -gt 0 -and (($i -eq 1) -or (($i % $GpuSampleEvery) -eq 0))
  if ($sampleGpu) {
    $gpu = Get-GpuUsage $targetPids
    $gpuTotal = [double]$gpu.Total
    $gpuTarget = [double]$gpu.Target
  } else {
    $gpuTotal = 0.0
    $gpuTarget = 0.0
  }

  $maxCpu = [Math]::Max($maxCpu, $cpuTotal)
  $maxTargetCpu = [Math]::Max($maxTargetCpu, $cpuTarget)
  $maxGpu = [Math]::Max($maxGpu, $gpuTotal)
  $maxTargetGpu = [Math]::Max($maxTargetGpu, $gpuTarget)

  if ($cpuTotal -ge $GoalCpuPercent) { $goalRun++ } else { $goalRun = 0 }
  if ($GoalTargetCpuPercent -le 0 -or $cpuTarget -ge $GoalTargetCpuPercent) { $targetGoalRun++ } else { $targetGoalRun = 0 }
  if ($goalRun -ge $GoalConsecutiveSamples) { $goalHit = $true }
  if ($targetGoalRun -ge $GoalConsecutiveSamples) { $targetGoalHit = $true }
  if ($RequireGpu -and $gpuTarget -ge $GoalGpuPercent) { $gpuGoalHit = $true }
  if ($cpuTarget -ge $ActiveTargetCpuPercent) {
    $targetActiveSeen = $true
    $targetIdleRun = 0
  } elseif ($targetActiveSeen -and $targetSampleCount -ge $MinTargetSamples -and $cpuTarget -le $IdleTargetCpuPercent) {
    $targetIdleRun++
  } elseif ($cpuTarget -gt $IdleTargetCpuPercent) {
    $targetIdleRun = 0
  }

  $line = "[{0,3}/{1}] CPU total={2,6:N1}% target={3,6:N1}% | GPU total={4,6:N1}% target={5,6:N1}% | targetCount={6}" -f `
    $i, $samples, $cpuTotal, $cpuTarget, $gpuTotal, $gpuTarget, $targets.Count
  if ($LogEvery -le 1 -or $i -eq 1 -or $i -eq $samples -or ($i % $LogEvery) -eq 0) {
    Write-Host $line
  }

  if ($CsvPath) {
    $csvLine = "{0},{1:N2},{2:N2},{3:N2},{4:N2},""{5}""" -f `
      $now.ToString('o'), $cpuTotal, $cpuTarget, $gpuTotal, $gpuTarget, ($targetNames -join ';')
    Add-Content -LiteralPath $CsvPath -Value $csvLine -Encoding UTF8
  }

  if ($goalHit -and $targetGoalHit -and $gpuGoalHit -and ($targetSeen -or $AllowNoTarget)) {
    $passAtSample = $i
    if ($StopOnPass) {
      Write-Host "PASS: hardware goal reached at sample $passAtSample."
      Write-Host "Summary: max CPU total=$([Math]::Round($maxCpu, 1))% target=$([Math]::Round($maxTargetCpu, 1))%; max GPU total=$([Math]::Round($maxGpu, 1))% target=$([Math]::Round($maxTargetGpu, 1))%"
      exit 0
    }
  }

  if ($StopOnTargetIdle -and $targetActiveSeen -and $targetIdleRun -ge $IdleConsecutiveSamples) {
    $stoppedOnIdle = $true
    Write-Host "STOP: target became idle after active workload at sample $i."
    break
  }

  $lastTime = $now
  $spentMs = ((Get-Date) - $sampleStart).TotalMilliseconds
  $sleepMs = $IntervalMs - $spentMs
  if ($i -lt $samples -and $sleepMs -gt 0) { Start-Sleep -Milliseconds ([int]$sleepMs) }
}

Write-Host "Summary: max CPU total=$([Math]::Round($maxCpu, 1))% target=$([Math]::Round($maxTargetCpu, 1))%; max GPU total=$([Math]::Round($maxGpu, 1))% target=$([Math]::Round($maxTargetGpu, 1))%"

if ($goalHit -and $targetGoalHit -and $gpuGoalHit -and ($targetSeen -or $AllowNoTarget)) {
  if ($passAtSample -gt 0) {
    Write-Host "PASS: hardware goal reached at sample $passAtSample."
  } else {
    Write-Host "PASS: hardware goal reached."
  }
  exit 0
}

if (-not $targetSeen -and -not $AllowNoTarget) {
  Write-Host "FAIL: no target process was observed."
}
if (-not $goalHit) {
  Write-Host "FAIL: CPU goal was not reached."
}
if (-not $targetGoalHit) {
  Write-Host "FAIL: target CPU goal was not reached."
}
if (-not $gpuGoalHit) {
  Write-Host "FAIL: GPU gate was not reached."
}
exit 2
