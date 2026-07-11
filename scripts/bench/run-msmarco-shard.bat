@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0..\.."

rem ===== MS MARCO single-shard import bench (vectors-off import + offline vector backfill, resumable) =====
rem Usage: run-msmarco-shard.bat [shard-path] [label]
rem If a state file exists, the import step is skipped and vector backfill resumes.
rem Vector backfill is idempotent (id-cursor, missing-only) and auto-retries on crash.

rem ---- Config (pre-set env vars win; override as needed) ----
if not defined IFTREE_DB set "IFTREE_DB=F:/Fworkspace/IFTreeEditorDB/store.sqlite"
if not defined IFTREE_HOME set "IFTREE_HOME=F:/Fworkspace/IFTreeEditorDB"
if not defined IFTREE_EMBED_BACKEND set "IFTREE_EMBED_BACKEND=ollama"
if not defined IFTREE_EMBED_MODEL set "IFTREE_EMBED_MODEL=bge-m3"
if not defined IFTREE_EMBED_BATCH set "IFTREE_EMBED_BATCH=64"

set "FILE=%~1"
if "%FILE%"=="" set "FILE=benchmark\repos\TREC_RAG_MS_MARCO_V2.1_segmented\extracted\msmarco_v2.1_doc_segmented\msmarco_v2.1_doc_segmented_00.jsonl"
set "LABEL=%~2"
if "%LABEL%"=="" set "LABEL=full-shard"

set "ELECTRON=node_modules\.bin\electron.cmd"
set "STATE=benchmark\reports\%LABEL%.docid"

echo === MS MARCO import bench (resumable) ===
echo   DB     = %IFTREE_DB%
echo   FILE   = %FILE%
echo   EMBED  = %IFTREE_EMBED_BACKEND% / %IFTREE_EMBED_MODEL%  batch=%IFTREE_EMBED_BATCH%
echo   STATE  = %STATE%
echo.

if not exist "%FILE%" (
  echo [error] shard file not found: %FILE%
  exit /b 1
)

rem ---- Step 1: streaming import (vectors off). Skip if state exists, to avoid duplicate docs ----
if exist "%STATE%" (
  set /p DOCID=<"%STATE%"
  echo [skip-import] state found, docId=!DOCID!, resuming vectors
) else (
  echo [import] streaming import of full shard ^(vectors off^)...
  call "%ELECTRON%" dist\scripts\bench\msmarco-import.js --file "%FILE%" --limit all --label "%LABEL%" --state-file "%STATE%"
  if errorlevel 1 (
    echo [import] failed. Re-run this .bat to import again.
    exit /b 1
  )
  set /p DOCID=<"%STATE%"
)

if not defined DOCID (
  echo [error] no docId obtained ^(empty state file?^)
  exit /b 1
)

rem ---- Step 2: offline vector backfill (id-cursor, missing-only, idempotent). Auto-retry/resume ----
set /a ATTEMPT=0
:vecloop
set /a ATTEMPT+=1
echo.
echo [vectors] attempt !ATTEMPT!, docId=!DOCID! ^(missing-only, resumable, long task^)...
call "%ELECTRON%" dist\scripts\ensure-doc-vectors.js !DOCID!
if errorlevel 1 (
  if !ATTEMPT! GEQ 200 (
    echo [vectors] retry limit reached, giving up. Re-run this .bat to continue.
    exit /b 1
  )
  echo [vectors] interrupted/failed, retrying in 15s...
  rem ping-based sleep: works even when stdin is redirected (background/log runs)
  ping -n 16 127.0.0.1 >nul
  goto vecloop
)

echo.
echo [done] import + vectors complete. docId=!DOCID!
echo        (delete %STATE% to force a fresh re-import next time)
endlocal
