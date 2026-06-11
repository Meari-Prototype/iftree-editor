param(
  [string]$ChmPath = '',
  [int]$ImportTimeoutSeconds = 180,
  [int]$LaunchTimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'
$scriptStartedAt = Get-Date

function Write-Step($Message) {
  Write-Host ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $Message)
}

function Read-NewLines($Path, [ref]$Offset) {
  if (-not (Test-Path -LiteralPath $Path)) { return @() }
  $lines = @(Get-Content -LiteralPath $Path -Encoding UTF8 -ErrorAction SilentlyContinue)
  if ($Offset.Value -ge $lines.Count) { return @() }
  $new = $lines[$Offset.Value..($lines.Count - 1)]
  $Offset.Value = $lines.Count
  return @($new)
}

function Stop-Tree($ProcessId) {
  if (-not $ProcessId) { return }
  & taskkill.exe /PID $ProcessId /T /F | Out-Host
}

function Get-RunElectronProcesses {
  @(Get-Process -Name electron -ErrorAction SilentlyContinue | Where-Object {
    try {
      $_.Path -eq $electronExe -and $_.StartTime -ge $scriptStartedAt
    } catch {
      $false
    }
  })
}

function Get-MainAppProcesses($LauncherPid) {
  if (-not $LauncherPid) { return @() }
  $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $LauncherPid" -ErrorAction SilentlyContinue)
  $ids = @($children | ForEach-Object { [int]$_.ProcessId })
  if ($ids.Count -eq 0) { return @() }
  @(Get-Process -Id $ids -ErrorAction SilentlyContinue | Where-Object {
    try {
      $_.Path -eq $electronExe
    } catch {
      $false
    }
  })
}

function Assert-E2EVisualResult($Status) {
  if (-not $Status.e2e) { throw "E2E result missing" }
  $visual = $Status.e2e.visual
  if (-not $visual) { throw "E2E visual result missing" }
  if ([int]$visual.visibleNodeCount -le 1) { throw "E2E visual check failed: visibleNodeCount=$($visual.visibleNodeCount)" }
  if ([int]$visual.gpuCardCount -le 1) { throw "E2E visual check failed: gpuCardCount=$($visual.gpuCardCount)" }
  if ([int]$visual.gpuEdgeCount -le 0) { throw "E2E visual check failed: gpuEdgeCount=$($visual.gpuEdgeCount)" }
  if ($visual.hasText -ne $true) { throw "E2E visual check failed: no rendered node text" }
  if ($visual.hasEdges -ne $true) { throw "E2E visual check failed: no rendered edges" }
  if ($visual.overlayClear -ne $true) { throw "E2E visual check failed: loading overlay still blocks the UI" }
  $screenshot = $Status.e2e.screenshot
  if (-not $screenshot) { throw "E2E screenshot result missing" }
  if ($screenshot.ok -ne $true) {
    throw "E2E screenshot check failed: overlay=$($screenshot.hasDarkLoadingOverlay) text=$($screenshot.hasReadableTextPixels) canvasDark=$($screenshot.mainCanvasDarkPixels) path=$($screenshot.path)"
  }
  if (-not (Test-Path -LiteralPath ([string]$screenshot.path))) {
    throw "E2E screenshot file missing: $($screenshot.path)"
  }
  if ($screenshot.hasDarkLoadingOverlay -eq $true) { throw "E2E screenshot check failed: loading overlay/black bar remains in screenshot" }
  if ($screenshot.hasReadableTextPixels -ne $true) { throw "E2E screenshot check failed: visible node cards do not contain readable text pixels" }
  if ($screenshot.hasBezierCurvePixels -ne $true) { throw "E2E screenshot check failed: visible parent-child bezier curves are missing" }
  if ([int]$screenshot.textProbeRectCount -lt 2) { throw "E2E screenshot check failed: too few fully visible node text probe rectangles: $($screenshot.textProbeRectCount)" }
  if ([double]$Status.e2e.cameraDeltaX -le 0) { throw "E2E interaction check failed: camera did not move" }
}

function Get-HhcParamValue($ObjectHtml, $Name) {
  $singleQuote = [char]39
  $pattern = '<param\b[^>]*name=["' + $singleQuote + ']?' + [regex]::Escape($Name) + '["' + $singleQuote + ']?[^>]*>'
  $param = [regex]::Match([string]$ObjectHtml, $pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase).Value
  if ([string]::IsNullOrWhiteSpace($param)) { return '' }
  $value = [regex]::Match($param, '\bvalue\s*=\s*"([^"]*)"', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase).Groups[1].Value
  if ([string]::IsNullOrWhiteSpace($value)) {
    $value = [regex]::Match($param, "\bvalue\s*=\s*'([^']*)'", [System.Text.RegularExpressions.RegexOptions]::IgnoreCase).Groups[1].Value
  }
  if ([string]::IsNullOrWhiteSpace($value)) {
    $value = [regex]::Match($param, '\bvalue\s*=\s*([^>\s]+)', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase).Groups[1].Value
  }
  return [System.Net.WebUtility]::HtmlDecode(([string]$value).Trim())
}

function Normalize-TocName($Value) {
  return ([string]$Value).Trim() -replace '\s+', ' '
}

function Get-ChmTopLevelTocNames($ChmPath, $WorkRoot) {
  $hhExe = if ($env:SystemRoot) { Join-Path $env:SystemRoot 'hh.exe' } else { 'hh.exe' }
  $tocDir = Join-Path $WorkRoot 'toc-oracle'
  if (Test-Path -LiteralPath $tocDir) { Remove-Item -LiteralPath $tocDir -Recurse -Force }
  New-Item -ItemType Directory -Path $tocDir | Out-Null
  Write-Step "TOC oracle decompile start: $ChmPath"
  $tocProcess = Start-Process -FilePath $hhExe -ArgumentList @('-decompile', $tocDir, $ChmPath) -PassThru -WindowStyle Hidden
  if (-not $tocProcess.WaitForExit(60000)) {
    Stop-Tree $tocProcess.Id
    throw "CHM TOC oracle decompile timed out after 60 seconds"
  }
  $hhc = @(Get-ChildItem -LiteralPath $tocDir -Recurse -Filter '*.hhc' -File | Select-Object -First 1)
  if ($hhc.Count -eq 0) { throw "CHM TOC .hhc file not found after decompile" }
  $bytes = [System.IO.File]::ReadAllBytes($hhc[0].FullName)
  $texts = @(
    [System.Text.Encoding]::UTF8.GetString($bytes),
    [System.Text.Encoding]::GetEncoding(936).GetString($bytes),
    [System.Text.Encoding]::Default.GetString($bytes)
  )
  $bestNames = @()
  $bestBadness = [int]::MaxValue
  foreach ($html in $texts) {
    $names = New-Object System.Collections.Generic.List[string]
    $level = 0
    $matches = [regex]::Matches(
      [string]$html,
      '</?ul\b[^>]*>|<object\b[\s\S]*?</object>',
      [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    )
    foreach ($match in $matches) {
      $token = [string]$match.Value
      if ($token -match '^<ul\b') {
        $level += 1
      } elseif ($token -match '^</ul') {
        $level = [Math]::Max(0, $level - 1)
      } elseif ($level -eq 1) {
        $name = Normalize-TocName (Get-HhcParamValue $token 'Name')
        if (-not [string]::IsNullOrWhiteSpace($name)) { $names.Add($name) }
      }
    }
    $joinedNames = (@($names) -join '')
    $badness = [regex]::Matches($joinedNames, [regex]::Escape([string][char]0xFFFD)).Count
    if ($names.Count -gt 0 -and ($badness -lt $bestBadness -or ($badness -eq $bestBadness -and $names.Count -gt $bestNames.Count))) {
      $bestNames = @($names)
      $bestBadness = $badness
    }
  }
  if ($bestNames.Count -eq 0) { throw "CHM TOC top-level names not found in .hhc" }
  Write-Step "TOC top-level count=$($bestNames.Count)"
  return @($bestNames)
}

function Invoke-DbSql($IftreeHomePath, $Sql, $Limit = 1000) {
  $oldHomeForQuery = $env:IFTREE_HOME
  $oldDbForQuery = $env:IFTREE_DB
  $queryId = [System.Guid]::NewGuid().ToString('N')
  $queryOut = Join-Path $IftreeHomePath "query-$queryId.out.log"
  $queryErr = Join-Path $IftreeHomePath "query-$queryId.err.log"
  $querySql = Join-Path $IftreeHomePath "query-$queryId.sql"
  try {
    $env:IFTREE_HOME = $IftreeHomePath
    # query-db.mjs 只认 IFTREE_DB（不读 IFTREE_HOME），不设则会静默查到主库。
    $env:IFTREE_DB = Join-Path $IftreeHomePath 'store.sqlite'
    [System.IO.File]::WriteAllText($querySql, $Sql, [System.Text.UTF8Encoding]::new($false))
    # --db 显式传库路径：本机可能存在用户级 IFTREE_DB（指向压测库）把查询劫持走。
    $queryProcess = $null
    try {
      $queryProcess = Start-Process -FilePath $electronExe -ArgumentList @('scripts/query-db.mjs', 'sql', '--sqlFile', $querySql, '--limit', ([string]$Limit), '--db', (Join-Path $IftreeHomePath 'store.sqlite')) -WorkingDirectory (Get-Location) -PassThru -WindowStyle Hidden -RedirectStandardOutput $queryOut -RedirectStandardError $queryErr -ErrorAction Stop
    } catch {
      throw "query-db Start-Process failed: $($_.Exception.Message)"
    }
    if (-not $queryProcess) { throw 'query-db Start-Process returned null process' }
    if (-not $queryProcess.WaitForExit(30000)) {
      Stop-Tree $queryProcess.Id
      throw "query-db sql timed out after 30 seconds: $Sql"
    }
    $queryProcess.Refresh()
    $stdout = if (Test-Path -LiteralPath $queryOut) { Get-Content -LiteralPath $queryOut -Encoding UTF8 } else { @() }
    $stderr = if (Test-Path -LiteralPath $queryErr) { Get-Content -LiteralPath $queryErr -Encoding UTF8 } else { @() }
    if ($null -ne $queryProcess.ExitCode -and $queryProcess.ExitCode -ne 0) { throw "query-db sql failed: $Sql`n$stderr`n$stdout" }
    $output = @($stdout)
    $jsonLine = @($output | Where-Object { ([string]$_).TrimStart().StartsWith('{') } | Select-Object -Last 1)
    if (-not $jsonLine) { throw "query-db sql did not return JSON: $Sql`n$stderr`n$stdout" }
    return ((@($stdout) -join "`n") | ConvertFrom-Json)
  } finally {
    $env:IFTREE_HOME = $oldHomeForQuery
    $env:IFTREE_DB = $oldDbForQuery
  }
}

function Get-DbRows($Result) {
  if ($null -eq $Result) { return @() }
  $rowsProperty = $Result.PSObject.Properties['rows']
  if ($null -eq $rowsProperty) { return @() }
  return @($rowsProperty.Value)
}

function Get-FirstDbRow($Result, $Label) {
  $rows = @(Get-DbRows $Result)
  if ($rows.Count -eq 0) { throw "query-db sql returned no rows for $Label" }
  return $rows[0]
}

function Assert-ChmImportStructure($IftreeHomePath, $DocId, $ChmPath) {
  $tocNames = @(Get-ChmTopLevelTocNames $ChmPath $IftreeHomePath | ForEach-Object { Normalize-TocName $_ })
  $limit = [Math]::Max(1000, $tocNames.Count + 10)
  $rootChildCountSql = @(
    "SELECT COUNT(*) AS rootChildCount",
    "FROM nodes doc_root",
    "JOIN nodes child ON child.parent_id = doc_root.id",
    "WHERE doc_root.doc_id = '$DocId' AND doc_root.parent_id IS NULL"
  ) -join ' '
  $rootChildCountResult = Invoke-DbSql $IftreeHomePath $rootChildCountSql
  $rootChildCountRow = Get-FirstDbRow $rootChildCountResult 'root child count'
  $dbCount = [int]$rootChildCountRow.rootChildCount
  $rootChildrenSql = @(
    "SELECT child.sort_order, COALESCE(NULLIF(child.node_title, ''), child.text) AS name",
    "FROM nodes doc_root",
    "JOIN nodes child ON child.parent_id = doc_root.id",
    "WHERE doc_root.doc_id = '$DocId' AND doc_root.parent_id IS NULL",
    "ORDER BY child.sort_order, child.id"
  ) -join ' '
  $rootChildren = Invoke-DbSql $IftreeHomePath $rootChildrenSql $limit
  $dbRows = @(Get-DbRows $rootChildren)
  $dbNames = @($dbRows | ForEach-Object { Normalize-TocName $_.name })
  if ($dbCount -ne $tocNames.Count) {
    throw "CHM import structure failed: root child count $dbCount != HHC top-level count $($tocNames.Count)"
  }
  for ($index = 0; $index -lt $tocNames.Count; $index += 1) {
    if ($dbNames[$index] -ne $tocNames[$index]) {
      throw "CHM import structure failed: root child #$($index + 1) '$($dbNames[$index])' != HHC '$($tocNames[$index])'"
    }
  }
  $shapeSql = @(
    "SELECT COUNT(*) AS nodeCount, MAX(depth) AS maxDepth,",
    "SUM(CASE WHEN parent_id IS NULL THEN 1 ELSE 0 END) AS rootCount",
    "FROM nodes",
    "WHERE doc_id = '$DocId'"
  ) -join ' '
  $shape = Invoke-DbSql $IftreeHomePath $shapeSql
  $topParentsSql = @(
    "SELECT parent_id, COUNT(*) AS childCount",
    "FROM nodes",
    "WHERE doc_id = '$DocId'",
    "GROUP BY parent_id",
    "ORDER BY childCount DESC",
    "LIMIT 5"
  ) -join ' '
  $topParents = Invoke-DbSql $IftreeHomePath $topParentsSql
  $shapeRow = Get-FirstDbRow $shape 'shape'
  $topParentRow = Get-FirstDbRow $topParents 'top parents'
  Write-Step "STRUCTURE from HHC ok nodes=$($shapeRow.nodeCount) maxDepth=$($shapeRow.maxDepth) rootChildren=$dbCount topParentChildCount=$($topParentRow.childCount)"
}

# render_positions 断言已删除：该表只存在于 million-node-perf-plan.md 的方案里，
# 代码从未建过；当前渲染是 DOM 路径（C2DMapView），断言只可能抛 no such table。

$electronExe = Join-Path (Get-Location) 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electronExe)) { throw "Electron exe not found: $electronExe" }
if ([string]::IsNullOrWhiteSpace($ChmPath)) {
  throw "ChmPath is required. Pass -ChmPath <path-to-source.chm>."
}
if (-not (Test-Path -LiteralPath $ChmPath)) { throw "CHM not found: $ChmPath" }

$runId = [System.Guid]::NewGuid().ToString('N')
$iftreeHome = Join-Path $env:TEMP "iftree-chm-e2e-$runId"
$statusPath = Join-Path $env:TEMP "iftree-chm-e2e-status-$runId.json"
$screenshotPath = Join-Path $env:TEMP "iftree-chm-e2e-shot-$runId.png"
$importOut = Join-Path $env:TEMP "iftree-chm-e2e-import-$runId.out.log"
$importErr = Join-Path $env:TEMP "iftree-chm-e2e-import-$runId.err.log"

Write-Step "RESET isolated home: $iftreeHome"
if (Test-Path -LiteralPath $iftreeHome) { Remove-Item -LiteralPath $iftreeHome -Recurse -Force }
New-Item -ItemType Directory -Path $iftreeHome | Out-Null
$inputDir = Join-Path $env:TEMP "iftree-chm-e2e-input-$runId"
if (Test-Path -LiteralPath $inputDir) { Remove-Item -LiteralPath $inputDir -Recurse -Force }
New-Item -ItemType Directory -Path $inputDir | Out-Null
$testChmPath = Join-Path $inputDir ([System.IO.Path]::GetFileName($ChmPath))
Copy-Item -LiteralPath $ChmPath -Destination $testChmPath -Force
Write-Step "INPUT isolated CHM=$testChmPath"

$importArgs = @('scripts/import-chm-doc.mjs', '--file', $testChmPath, '--home', $iftreeHome, '--reset')
Write-Step "IMPORT start: $testChmPath"
$importProcess = Start-Process -FilePath $electronExe -ArgumentList $importArgs -WorkingDirectory (Get-Location) -PassThru -RedirectStandardOutput $importOut -RedirectStandardError $importErr
$outOffset = 0
$errOffset = 0
$deadline = (Get-Date).AddSeconds($ImportTimeoutSeconds)
while (-not $importProcess.HasExited) {
  foreach ($line in Read-NewLines $importOut ([ref]$outOffset)) { Write-Host $line }
  foreach ($line in Read-NewLines $importErr ([ref]$errOffset)) { Write-Host $line }
  if ((Get-Date) -gt $deadline) {
    Write-Step "IMPORT timeout; killing PID $($importProcess.Id)"
    Stop-Tree $importProcess.Id
    throw "CHM import timed out after $ImportTimeoutSeconds seconds"
  }
  Start-Sleep -Seconds 2
  $importProcess.Refresh()
}
foreach ($line in Read-NewLines $importOut ([ref]$outOffset)) { Write-Host $line }
foreach ($line in Read-NewLines $importErr ([ref]$errOffset)) { Write-Host $line }
$importProcess.WaitForExit()
$importProcess.Refresh()
if ($null -ne $importProcess.ExitCode -and $importProcess.ExitCode -ne 0) { throw "CHM import failed with exit code $($importProcess.ExitCode)" }

$resultLine = @(Get-Content -LiteralPath $importOut -Encoding UTF8 | Where-Object { $_ -like '*"type":"import-result"*' } | Select-Object -Last 1)
if (-not $resultLine) { throw "CHM import result line not found" }
$importResult = $resultLine | ConvertFrom-Json
if ($importResult.ok -ne $true) { throw "CHM import result is not ok: $resultLine" }
if ($importResult.structureSource -ne 'hhc') { throw "CHM import did not report structureSource=hhc: $resultLine" }
if ($importResult.intermediateFormat -eq 'markdown') { throw "CHM import must not use Markdown as an intermediate format: $resultLine" }
Write-Step "IMPORT ok docId=$($importResult.docId) nodes=$($importResult.nodeCount) elapsedMs=$($importResult.elapsedMs)"
Assert-ChmImportStructure $iftreeHome $importResult.docId $testChmPath

$oldHome = $env:IFTREE_HOME
$oldAutostart = $env:IFTREE_LAUNCHER_AUTOSTART
$oldStartupDocId = $env:IFTREE_STARTUP_DOC_ID
$oldE2e = $env:IFTREE_E2E_CHM
$oldStatus = $env:IFTREE_STARTUP_STATUS_PATH
$oldScreenshot = $env:IFTREE_E2E_SCREENSHOT_PATH
$oldDb = $env:IFTREE_DB

$appProcess = $null
try {
  $env:IFTREE_HOME = $iftreeHome
  # 应用本体解析 SQLite 路径时 IFTREE_DB 优先于 IFTREE_HOME（electron/main.mjs），
  # 本机可能存在指向压测库的用户级 IFTREE_DB，必须显式覆盖到隔离库。
  $env:IFTREE_DB = Join-Path $iftreeHome 'store.sqlite'
  $env:IFTREE_LAUNCHER_AUTOSTART = '1'
  $env:IFTREE_STARTUP_DOC_ID = [string]$importResult.docId
  $env:IFTREE_E2E_CHM = '1'
  $env:IFTREE_STARTUP_STATUS_PATH = $statusPath
  $env:IFTREE_E2E_SCREENSHOT_PATH = $screenshotPath

  Write-Step "LAUNCH start with docId=$($importResult.docId)"
  $appProcess = Start-Process -FilePath $electronExe -ArgumentList @('.') -WorkingDirectory (Get-Location) -PassThru
  Write-Step "LAUNCH root PID=$($appProcess.Id)"
  $deadline = (Get-Date).AddSeconds($LaunchTimeoutSeconds)
  $passed = $false
  while ((Get-Date) -le $deadline) {
    $stage = 'missing-status'
    $success = $false
    $failed = $false
    $avg = ''
    $min = ''
    $visible = ''
    $cards = ''
    $edges = ''
    $shot = ''
    $progressText = ''
    if (Test-Path -LiteralPath $statusPath) {
      $status = Get-Content -LiteralPath $statusPath -Encoding UTF8 -Raw | ConvertFrom-Json
      $stage = [string]$status.stage
      $success = $status.success -eq $true
      $failed = $status.failed -eq $true
      if ($status.e2e) {
        $avg = $status.e2e.avgFps
        $min = $status.e2e.minFps
        if ($status.e2e.visual) {
          $visible = $status.e2e.visual.visibleNodeCount
          $cards = $status.e2e.visual.gpuCardCount
          $edges = $status.e2e.visual.gpuEdgeCount
        }
        if ($status.e2e.screenshot) {
          $shot = $status.e2e.screenshot.path
        }
      }
      if ($status.progress) {
        $progressText = " progress=$($status.progress.step)/$($status.progress.total) $($status.progress.countLabel)"
      }
      Write-Step "STATUS success=$success failed=$failed stage=$stage doc=$($status.docId) nodes=$($status.nodeCount) backend=$($status.renderBackend) visible=$visible cards=$cards edges=$edges avg=$avg min=$min shot=$shot$progressText"
      if ($failed) { throw "App reported failure at stage=$stage" }
      if ($success -and $stage -eq 'e2e-drag-fps-complete' -and $status.e2e.ok -eq $true) {
        Assert-E2EVisualResult $status
        $passed = $true
        break
      }
    } else {
      Write-Step "STATUS missing"
    }
    Start-Sleep -Seconds 2
    $appProcess.Refresh()
    if ($appProcess.HasExited -and -not $passed) { throw "Electron root exited before e2e success: code=$($appProcess.ExitCode)" }
  }
  if (-not $passed) { throw "E2E validation timed out after $LaunchTimeoutSeconds seconds" }
  Write-Step "E2E ok status=$statusPath"
  Write-Step "SCREENSHOT ok path=$screenshotPath"
  $mainProcesses = @(Get-MainAppProcesses $appProcess.Id | Where-Object { $_.MainWindowHandle -and $_.MainWindowHandle -ne 0 })
  if ($mainProcesses.Count -ne 1) {
    Get-MainAppProcesses $appProcess.Id | Select-Object Id,ProcessName,MainWindowHandle,MainWindowTitle,StartTime | Format-Table | Out-Host
    throw "Expected exactly one visible main app window before close; found $($mainProcesses.Count)"
  }
  $mainProcess = $mainProcesses[0]
  Write-Step "CLOSE main service PID=$($mainProcess.Id)"
  if (-not $mainProcess.CloseMainWindow()) {
    throw "Main service did not accept graceful window close"
  }
  Wait-Process -Id $mainProcess.Id -Timeout 15 -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
  $appProcess.Refresh()
  if ($appProcess.HasExited) {
    throw "Launcher exited after main service closed"
  }
  $remainingMain = @(Get-MainAppProcesses $appProcess.Id | Where-Object { $_.MainWindowHandle -and $_.MainWindowHandle -ne 0 })
  if ($remainingMain.Count -gt 0) {
    $remainingMain | Select-Object Id,ProcessName,MainWindowTitle,StartTime | Format-Table | Out-Host
    throw "Main service process still exists after graceful close"
  }
  $launcherProcess = Get-Process -Id $appProcess.Id -ErrorAction Stop
  if (-not $launcherProcess.MainWindowHandle -or $launcherProcess.MainWindowHandle -eq 0 -or [string]::IsNullOrWhiteSpace([string]$launcherProcess.MainWindowTitle)) {
    throw "Launcher process stayed alive but did not show launcher window: title=$($launcherProcess.MainWindowTitle)"
  }
  Write-Step "LAUNCHER fallback ok title=$($launcherProcess.MainWindowTitle)"
} finally {
  if ($appProcess -and -not $appProcess.HasExited) {
    Write-Step "CLEANUP taskkill root PID=$($appProcess.Id)"
    Stop-Tree $appProcess.Id
    Wait-Process -Id $appProcess.Id -Timeout 5 -ErrorAction SilentlyContinue
  }
  $env:IFTREE_HOME = $oldHome
  $env:IFTREE_LAUNCHER_AUTOSTART = $oldAutostart
  $env:IFTREE_STARTUP_DOC_ID = $oldStartupDocId
  $env:IFTREE_E2E_CHM = $oldE2e
  $env:IFTREE_STARTUP_STATUS_PATH = $oldStatus
  $env:IFTREE_E2E_SCREENSHOT_PATH = $oldScreenshot
  $env:IFTREE_DB = $oldDb
}

$residual = Get-RunElectronProcesses
if ($residual.Count -gt 0) {
  Start-Sleep -Seconds 2
  $residual = Get-RunElectronProcesses
}
Write-Step "RESIDUAL electron count=$($residual.Count)"
if ($residual.Count -gt 0) {
  $residual | Select-Object Id,ProcessName,CPU,StartTime | Format-Table | Out-Host
  throw "Electron residual processes remain"
}
if (Test-Path -LiteralPath $inputDir) { Remove-Item -LiteralPath $inputDir -Recurse -Force }
