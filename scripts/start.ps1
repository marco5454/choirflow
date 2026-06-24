#requires -Version 5.1
<#
.SYNOPSIS
    ChoirFlow launcher (Windows).

.DESCRIPTION
    Starts the backend (ts-node, :3000) and the frontend (Vite, :5173) together,
    waits for both to be listening, opens the default browser, and cleans up
    both processes (including their grandchildren) when this script exits, is
    Ctrl+C'd, or the window is closed.

    Assumes Node >= 20 and npm are already installed (and on PATH). For audio
    rendering, fluidsynth + ffmpeg must also be installed and on PATH; this
    launcher only wraps `npm run dev`, it does not install runtime deps.

.PARAMETER NoBrowser
    Don't open the default browser after both servers are up.

.PARAMETER NoInstall
    Skip running `npm install` even if a `node_modules` directory is missing.

.PARAMETER BackendPort
    TCP port for the backend (default 3000; matches vite.config.ts proxy).

.PARAMETER FrontendPort
    TCP port for the frontend Vite dev server (default 5173).

.EXAMPLE
    .\scripts\start.ps1
    .\scripts\start.ps1 -NoBrowser
#>

[CmdletBinding()]
param(
    [switch] $NoBrowser,
    [switch] $NoInstall,
    [int]    $BackendPort  = 3000,
    [int]    $FrontendPort = 5173
)

# Stop on unhandled errors; we'll explicitly tolerate the calls we expect to
# possibly fail (port probes, browser-open) with -ErrorAction SilentlyContinue.
$ErrorActionPreference = 'Stop'

# Resolve repo root from this script's own location so the launcher works
# from any CWD (double-click, scheduled task, etc.).
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot   = Resolve-Path (Join-Path $ScriptDir '..')
$BackendDir = Join-Path $RepoRoot 'backend'
$FrontendDir = Join-Path $RepoRoot 'frontend'

function Write-Info ($msg) { Write-Host "[choirflow] $msg" -ForegroundColor Cyan }
function Write-Ok   ($msg) { Write-Host "[choirflow] $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "[choirflow] $msg" -ForegroundColor Yellow }
function Write-Err2 ($msg) { Write-Host "[choirflow] $msg" -ForegroundColor Red }

# ---------- preflight ----------
function Test-Command ($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

if (-not (Test-Command 'node')) {
    Write-Err2 "node is not installed or not on PATH. Install Node >= 20: https://nodejs.org/"
    exit 1
}
if (-not (Test-Command 'npm')) {
    Write-Err2 "npm is not installed or not on PATH (ships with Node)."
    exit 1
}
$nodeVersion = (& node --version).TrimStart('v')
$nodeMajor   = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 20) {
    Write-Warn2 "Detected Node v$nodeVersion; ChoirFlow targets Node >= 20. Things may break."
}
foreach ($d in @($BackendDir, $FrontendDir)) {
    if (-not (Test-Path $d -PathType Container)) {
        Write-Err2 "Expected directory not found: $d"
        Write-Err2 "Run this script from a ChoirFlow checkout (it auto-resolves repo root)."
        exit 1
    }
}

# ---------- install deps if missing ----------
function Invoke-MaybeInstall ($dir, $label) {
    if ($NoInstall) { return }
    if (-not (Test-Path (Join-Path $dir 'node_modules') -PathType Container)) {
        Write-Info "Installing $label dependencies (first run)..."
        Push-Location $dir
        try {
            # `npm` on Windows is a .cmd shim; invoke through cmd to get a real
            # exit code propagated.
            & cmd /c 'npm install'
            if ($LASTEXITCODE -ne 0) { throw "npm install failed in $label (exit $LASTEXITCODE)" }
        } finally {
            Pop-Location
        }
    }
}
Invoke-MaybeInstall $BackendDir  'backend'
Invoke-MaybeInstall $FrontendDir 'frontend'

# ---------- child process tracking ----------
# We launch each side via cmd.exe so we have one parent process whose entire
# child tree we can take down. `taskkill /T /F /PID` walks the tree, which is
# the only reliable way to also kill the ts-node and vite grandchildren on
# Windows (npm.cmd spawns node, etc.).
$script:BackendProc  = $null
$script:FrontendProc = $null
$script:CleanupDone  = $false

function Stop-Tree ($proc, $label) {
    if ($null -eq $proc) { return }
    if ($proc.HasExited)  { return }
    Write-Info "Stopping $label (pid $($proc.Id))..."
    # /T = tree, /F = force. Quiet stderr because the process may already be
    # exiting on its own when we get here.
    & cmd /c "taskkill /PID $($proc.Id) /T /F" 2>$null | Out-Null
}

function Invoke-Cleanup {
    if ($script:CleanupDone) { return }
    $script:CleanupDone = $true
    Write-Host ""  # break out of any half-printed line
    Write-Info "Shutting down..."
    Stop-Tree $script:BackendProc  'backend'
    Stop-Tree $script:FrontendProc 'frontend'
    # Give Windows a moment to actually release ports.
    Start-Sleep -Milliseconds 500
    Write-Ok "Stopped."
}

# Catch Ctrl+C / window close / normal exit. PowerShell raises a
# PipelineStoppedException on Ctrl+C inside the script; we catch that below
# around the wait loop. The EngineEvent gives us a hook for `exit` and
# unhandled errors.
Register-EngineEvent -SourceIdentifier PowerShell.Exiting `
    -Action { Invoke-Cleanup } | Out-Null

# ---------- start backend + frontend ----------
function Start-DevServer {
    param(
        [string] $WorkingDirectory,
        [string] $NpmArgs,           # extra args after `npm run dev`
        [hashtable] $EnvVars = @{}
    )
    # Build a single cmd.exe command line. `npm.cmd` is what's actually on
    # PATH on Windows; calling it via cmd /c gives us a clean parent process
    # whose tree we can later kill with taskkill /T.
    $cmdline = "npm run --silent dev"
    if ($NpmArgs) { $cmdline += " -- $NpmArgs" }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName  = 'cmd.exe'
    $psi.Arguments = "/c $cmdline"
    $psi.WorkingDirectory = $WorkingDirectory
    $psi.UseShellExecute   = $false   # required to set env vars + redirect
    $psi.RedirectStandardOutput = $false
    $psi.RedirectStandardError  = $false
    foreach ($k in $EnvVars.Keys) { $psi.EnvironmentVariables[$k] = [string]$EnvVars[$k] }

    return [System.Diagnostics.Process]::Start($psi)
}

Write-Info "Starting backend  (port $BackendPort) ..."
$script:BackendProc = Start-DevServer `
    -WorkingDirectory $BackendDir `
    -EnvVars @{ PORT = "$BackendPort" }

Write-Info "Starting frontend (port $FrontendPort) ..."
$script:FrontendProc = Start-DevServer `
    -WorkingDirectory $FrontendDir `
    -NpmArgs "--port $FrontendPort --strictPort"

# ---------- wait for both ports ----------
function Wait-Port ($port, $label, $proc, $maxSeconds = 60) {
    $client = $null
    $deadline = (Get-Date).AddSeconds($maxSeconds)
    while ((Get-Date) -lt $deadline) {
        # If the corresponding child died early, bail out fast.
        if ($proc.HasExited) { return 'died' }

        try {
            $client = New-Object System.Net.Sockets.TcpClient
            # Connect with a short timeout so we poll responsively.
            $iar = $client.BeginConnect('127.0.0.1', $port, $null, $null)
            $ok  = $iar.AsyncWaitHandle.WaitOne(250)
            if ($ok -and $client.Connected) {
                $client.EndConnect($iar) | Out-Null
                return 'ready'
            }
        } catch {
            # Connection refused / reset = not listening yet. Swallow.
        } finally {
            if ($client) { $client.Close(); $client = $null }
        }
        Start-Sleep -Milliseconds 200
    }
    return 'timeout'
}

Write-Info "Waiting for servers to be ready..."
try {
    $status = Wait-Port $BackendPort 'backend' $script:BackendProc 60
    if ($status -ne 'ready') {
        Write-Err2 "Backend did not start listening on :$BackendPort within 60s (status: $status). See logs above."
        Invoke-Cleanup
        exit 1
    }
    Write-Ok "Backend listening on http://localhost:$BackendPort"

    $status = Wait-Port $FrontendPort 'frontend' $script:FrontendProc 60
    if ($status -ne 'ready') {
        Write-Err2 "Frontend did not start listening on :$FrontendPort within 60s (status: $status). See logs above."
        Invoke-Cleanup
        exit 1
    }
    Write-Ok "Frontend listening on http://localhost:$FrontendPort"

    # ---------- open browser ----------
    if (-not $NoBrowser) {
        Write-Info "Opening browser..."
        try { Start-Process "http://localhost:$FrontendPort" -ErrorAction Stop }
        catch { Write-Warn2 "Could not open browser automatically: $($_.Exception.Message)" }
    }

    Write-Host ""
    Write-Ok   "ChoirFlow is up."
    Write-Info "Frontend: http://localhost:$FrontendPort"
    Write-Info "Backend:  http://localhost:$BackendPort"
    Write-Host "[choirflow] Press Ctrl+C to stop." -ForegroundColor DarkGray
    Write-Host ""

    # ---------- block until either side exits ----------
    # Poll WaitForExit with a short timeout so Ctrl+C is responsive (a single
    # blocking WaitForExit would swallow Ctrl+C until the child exits).
    while ($true) {
        if ($script:BackendProc.HasExited) {
            Write-Warn2 "Backend exited (code $($script:BackendProc.ExitCode))."
            break
        }
        if ($script:FrontendProc.HasExited) {
            Write-Warn2 "Frontend exited (code $($script:FrontendProc.ExitCode))."
            break
        }
        Start-Sleep -Milliseconds 300
    }
} finally {
    # Runs on normal exit, Ctrl+C (PipelineStoppedException), or thrown error.
    Invoke-Cleanup
}
