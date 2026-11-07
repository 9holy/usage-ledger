[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# The installer writes HKCU registration even when /D points at a temporary
# directory. Run this check only in a disposable GitHub-hosted Windows runner.
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw 'Windows is required to verify the Windows installer.'
}
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
  throw 'Run this installation check on a disposable GitHub-hosted Windows runner.'
}
if (-not [Environment]::Is64BitOperatingSystem) {
  throw 'The x64 installer requires a 64-bit Windows runner.'
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $repositoryRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$config = Get-Content -LiteralPath (Join-Path $repositoryRoot 'src-tauri/tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$expectedVersion = [string]$package.version
$cargoManifest = Get-Content -LiteralPath (Join-Path $repositoryRoot 'src-tauri/Cargo.toml') -Raw -Encoding UTF8
$binaryName = [regex]::Match($cargoManifest, '(?m)^name\s*=\s*"([^"]+)"').Groups[1].Value
if ($config.PSObject.Properties.Name -contains 'mainBinaryName') { $binaryName = [string]$config.mainBinaryName }
if ($binaryName -notmatch '^[A-Za-z0-9_.-]+$') { throw 'Cannot determine the desktop executable name.' }
if ($expectedVersion -notmatch '^\d+\.\d+\.\d+$' -or $config.version -ne $expectedVersion) {
  throw 'The package and desktop configuration must name the same stable release.'
}
if ($config.bundle.windows.nsis.installMode -ne 'currentUser') {
  throw 'This check only supports the current-user NSIS installer.'
}
$installer = Get-Item -LiteralPath $InstallerPath
if ($installer.PSIsContainer -or $installer.Name -notlike "*_${expectedVersion}_x64-setup.exe") {
  throw 'Expected the current-version x64 NSIS installer.'
}

function Get-AppRegistration {
  # Check both registry views so an existing installation can never be upgraded
  # or removed by this fresh-install check.
  foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
      $registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
      $uninstallRoot = $null
      try {
        $uninstallRoot = $registry.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall')
        if ($null -eq $uninstallRoot) { continue }
        foreach ($name in $uninstallRoot.GetSubKeyNames()) {
          $entry = $uninstallRoot.OpenSubKey($name)
          if ($null -eq $entry) { continue }
          try {
            if ($name -eq $config.productName -or $entry.GetValue('DisplayName') -eq $config.productName) {
              [PSCustomObject]@{
                Hive = [string]$hive
                View = [string]$view
                Name = $name
                Version = [string]$entry.GetValue('DisplayVersion')
                Location = ([string]$entry.GetValue('InstallLocation')).Trim('"')
              }
            }
          } finally {
            $entry.Dispose()
          }
        }
      } finally {
        if ($null -ne $uninstallRoot) { $uninstallRoot.Dispose() }
        $registry.Dispose()
      }
    }
  }
}

if (@(Get-AppRegistration).Count -ne 0) {
  throw 'An existing Usage Ledger installation was found; refusing to replace it.'
}
if (@(Get-Process -Name $binaryName -ErrorAction SilentlyContinue).Count -ne 0) {
  throw 'An existing Usage Ledger process was found; refusing to run its installer.'
}

# Reserve and release the port before launching: never accept another process's
# response as evidence that our installed application started.
$probe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 18765)
$probe.ExclusiveAddressUse = $true
try { $probe.Start() } finally { $probe.Stop() }

Add-Type -AssemblyName System.Net.Http
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class UsageLedgerSmokeWindow {
  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool IsIconic(IntPtr window);
}
'@

$smokeRoot = Join-Path ([IO.Path]::GetFullPath($env:RUNNER_TEMP)) ('usage-ledger-install-smoke-' + [Guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $smokeRoot) { throw 'The isolated installation directory already exists.' }
$installDirectory = Join-Path $smokeRoot 'Application With Spaces'
$smokeProfile = Join-Path $smokeRoot 'profile'
$webViewDirectory = Join-Path $smokeProfile 'webview'
$smokeTemp = Join-Path $smokeRoot 'temp'
foreach ($directory in @($smokeRoot, $smokeProfile, $webViewDirectory, $smokeTemp)) {
  [void][IO.Directory]::CreateDirectory($directory)
}

$ownedProcesses = [Collections.Generic.List[Diagnostics.Process]]::new()
$httpHandler = [Net.Http.HttpClientHandler]::new()
$httpHandler.UseProxy = $false
$http = [Net.Http.HttpClient]::new($httpHandler)
$http.Timeout = [TimeSpan]::FromSeconds(1)
$application = $null
$applicationPath = $null
$receipt = $null
$smokeFailure = $null
$cleanupFailure = $null

function Start-SmokeProcess([string]$Path, [string]$Arguments = '') {
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $Path
  $start.Arguments = $Arguments
  $start.UseShellExecute = $false
  $start.WorkingDirectory = $smokeProfile
  foreach ($name in @($start.EnvironmentVariables.Keys)) {
    if ($name -match '^(MONITOR_|USAGE_MONITOR_|USAGE_LEDGER_|CODEX_MODE_LOG_|WEBVIEW2_)' -or
        $name -in @('OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'GH_TOKEN', 'GITHUB_TOKEN',
          'COCKPIT_TOOLS_DATA_DIR', 'COCKPIT_TOOLS_PROFILE', 'CPA_TOKEN_USAGE_DIR', 'CPA_MODEL_PRICE_FILE')) {
      $start.EnvironmentVariables.Remove($name)
    }
  }
  $isolated = @{
    HOME = $smokeProfile
    USERPROFILE = $smokeProfile
    APPDATA = (Join-Path $smokeProfile 'roaming')
    LOCALAPPDATA = (Join-Path $smokeProfile 'local')
    CODEX_HOME = (Join-Path $smokeProfile '.codex')
    CLAUDE_CONFIG_DIR = (Join-Path $smokeProfile '.claude')
    DSH_HOME = (Join-Path $smokeProfile '.dsh')
    CONSOLE2API_LEDGER_DIR = (Join-Path $smokeProfile 'ledger')
    WEBVIEW2_USER_DATA_FOLDER = $webViewDirectory
    TEMP = $smokeTemp
    TMP = $smokeTemp
  }
  foreach ($entry in $isolated.GetEnumerator()) {
    [void][IO.Directory]::CreateDirectory($entry.Value)
    $start.EnvironmentVariables[$entry.Key] = $entry.Value
  }
  $process = [Diagnostics.Process]::Start($start)
  if ($null -eq $process) { throw "Could not launch $Path" }
  $ownedProcesses.Add($process)
  return $process
}

function Stop-OwnedProcess([Diagnostics.Process]$Process) {
  $Process.Refresh()
  if ($Process.HasExited) { return }
  # The retained Process handle establishes ownership and detects an exited PID;
  # taskkill /T also stops the WebView children of this exact application.
  $termination = [Diagnostics.ProcessStartInfo]::new()
  $termination.FileName = Join-Path $env:WINDIR 'System32/taskkill.exe'
  $termination.Arguments = "/PID $($Process.Id) /T /F"
  $termination.UseShellExecute = $false
  $termination.CreateNoWindow = $true
  $termination.RedirectStandardOutput = $true
  $termination.RedirectStandardError = $true
  $terminator = [Diagnostics.Process]::Start($termination)
  try {
    if (-not $terminator.WaitForExit(10000)) {
      $terminator.Kill()
      [void]$terminator.WaitForExit(5000)
      throw "Timed out stopping owned process $($Process.Id)."
    }
    $terminationOutput = $terminator.StandardOutput.ReadToEnd() + $terminator.StandardError.ReadToEnd()
    # A natural exit between Refresh and taskkill is harmless. Inspect the held
    # process, rather than turning taskkill's 'not found' race into a failure.
    if (-not $Process.WaitForExit(10000)) {
      throw "Cannot stop owned process $($Process.Id): $terminationOutput"
    }
  } finally {
    $terminator.Dispose()
  }
}

function Wait-SmokeProcess([Diagnostics.Process]$Process, [string]$Description, [int]$TimeoutSeconds) {
  if (-not $Process.WaitForExit($TimeoutSeconds * 1000)) {
    Stop-OwnedProcess $Process
    throw "$Description exceeded ${TimeoutSeconds} seconds."
  }
  if ($Process.ExitCode -ne 0) { throw "$Description failed with exit code $($Process.ExitCode)." }
}

function Assert-ApplicationAlive {
  $application.Refresh()
  if ($application.HasExited) { throw "Installed application exited early: $($application.ExitCode)" }
}

function Test-OwnedBridge {
  Assert-ApplicationAlive
  try {
    $response = $http.GetAsync('http://127.0.0.1:18765/').GetAwaiter().GetResult()
  } catch {
    return $false
  }
  try {
    if ([int]$response.StatusCode -ne 403) { throw "The unauthenticated bridge request returned $([int]$response.StatusCode), expected 403." }
    $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
    if ($body.code -ne -1 -or $body.message -notmatch 'Local API bridge access denied') {
      throw 'The local bridge did not return its expected access-denied response.'
    }
    $listeners = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 18765 -State Listen -ErrorAction Stop)
    if ($listeners.Count -ne 1 -or $listeners[0].OwningProcess -ne $application.Id) {
      throw 'The installed application does not own the loopback bridge port.'
    }
    return $true
  } finally {
    $response.Dispose()
  }
}

function Wait-VisibleWindow([int]$TimeoutSeconds) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    Assert-ApplicationAlive
    $handle = $application.MainWindowHandle
    if ($handle -ne [IntPtr]::Zero -and [UsageLedgerSmokeWindow]::IsWindowVisible($handle) -and
        -not [UsageLedgerSmokeWindow]::IsIconic($handle) -and $application.Responding) {
      return $handle
    }
    Start-Sleep -Milliseconds 250
  }
  throw 'The installed application did not show a responsive main window.'
}

try {
  # NSIS requires /D to be LAST and unquoted, including when its path has spaces.
  # /NS avoids creating runner desktop/start-menu shortcuts; /R is not requested.
  # https://nsis.sourceforge.io/Docs/Chapter3.html#installerusage
  $installProcess = Start-SmokeProcess $installer.FullName "/S /NS /D=$installDirectory"
  Wait-SmokeProcess $installProcess 'Silent installation' 180
  $registrations = @(Get-AppRegistration)
  if ($registrations.Count -eq 0) { throw 'The installer did not create its uninstall registration.' }
  foreach ($registration in $registrations) {
    if ($registration.Hive -ne 'CurrentUser' -or $registration.Version -ne $expectedVersion -or
        $registration.Location -ne $installDirectory) {
      throw 'The installer registered an unexpected version, scope or location.'
    }
  }
  $executables = @(Get-ChildItem -LiteralPath $installDirectory -File -Filter '*.exe' |
    Where-Object { $_.Name -ne 'uninstall.exe' })
  if ($executables.Count -ne 1) { throw 'Expected exactly one installed application executable.' }
  if ($executables[0].Name -ne "$binaryName.exe") { throw 'The installed executable name does not match the package.' }
  $applicationPath = $executables[0].FullName
  $versionInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($applicationPath)
  if ($versionInfo.ProductVersion -notin @($expectedVersion, "$expectedVersion.0") -or
      $versionInfo.FileVersion -notin @($expectedVersion, "$expectedVersion.0") -or
      $versionInfo.ProductName -ne $config.productName) {
    throw 'The installed executable metadata does not match this release.'
  }
  $reader = [IO.BinaryReader]::new([IO.File]::OpenRead($applicationPath))
  try {
    if ($reader.ReadUInt16() -ne 0x5A4D) { throw 'The installed file is not a Windows executable.' }
    $reader.BaseStream.Position = 0x3C
    $peOffset = $reader.ReadUInt32()
    if ($peOffset -gt $reader.BaseStream.Length - 26) { throw 'The PE header is outside the executable.' }
    $reader.BaseStream.Position = $peOffset
    if ($reader.ReadUInt32() -ne 0x00004550 -or $reader.ReadUInt16() -ne 0x8664) {
      throw 'The installed application must be an x64 PE executable.'
    }
    $reader.BaseStream.Position = $peOffset + 24
    if ($reader.ReadUInt16() -ne 0x20B) { throw 'The installed application must use the PE32+ format.' }
  } finally {
    $reader.Dispose()
  }

  $application = Start-SmokeProcess $applicationPath
  $deadline = [DateTime]::UtcNow.AddSeconds(45)
  $bridgeReady = $false
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-OwnedBridge) { $bridgeReady = $true; break }
    Start-Sleep -Milliseconds 250
  }
  if (-not $bridgeReady) { throw 'The local bridge did not become ready within 45 seconds.' }
  $mainWindow = Wait-VisibleWindow 30

  # Exercise the real close-to-tray and single-instance restore path without
  # claiming that every tray interaction or frontend screen has been inspected.
  if (-not $application.CloseMainWindow()) { throw 'Could not send the main-window close request.' }
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while ([UsageLedgerSmokeWindow]::IsWindowVisible($mainWindow) -and [DateTime]::UtcNow -lt $deadline) {
    Assert-ApplicationAlive
    Start-Sleep -Milliseconds 100
  }
  Assert-ApplicationAlive
  if ([UsageLedgerSmokeWindow]::IsWindowVisible($mainWindow)) { throw 'Closing the main window did not hide it to the tray.' }
  if (-not (Test-OwnedBridge)) { throw 'The background application stopped serving its bridge.' }
  $secondInstance = Start-SmokeProcess $applicationPath
  Wait-SmokeProcess $secondInstance 'Single-instance window restore' 15
  [void](Wait-VisibleWindow 15)
  Start-Sleep -Seconds 3
  Assert-ApplicationAlive
  if (-not (Test-OwnedBridge)) { throw 'The application stopped serving its bridge after window recovery.' }
  $isolatedWebViews = @(Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" |
    Where-Object { $null -ne $_.CommandLine -and $_.CommandLine.IndexOf($webViewDirectory, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
  if ($isolatedWebViews.Count -eq 0) { throw 'No running WebView2 process uses the isolated smoke-check profile.' }

  $receipt = [ordered]@{
    version = $expectedVersion
    architecture = 'x64'
    installerSha256 = (Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    executableSha256 = (Get-FileHash -LiteralPath $applicationPath -Algorithm SHA256).Hash.ToLowerInvariant()
    installation = 'passed-current-user-silent-install'
    executable = 'passed-version-and-x64-pe32plus'
    startup = 'passed-isolated-profile-with-webview2'
    proxy = 'owned-pid-unauthenticated-request-rejected'
    mainWindow = 'passed-visible-responsive-close-to-tray-and-single-instance-restore'
    fullGraphicalAndRealAccountChecks = 'not-performed'
  }
} catch {
  $smokeFailure = $_
} finally {
  try {
    # Stop only processes this script started. A WebView broker can outlive its
    # parent, so a final narrowly scoped check uses our unique user-data path.
    for ($index = $ownedProcesses.Count - 1; $index -ge 0; $index--) {
      Stop-OwnedProcess $ownedProcesses[$index]
    }
    $browsers = @(Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" |
      Where-Object { $null -ne $_.CommandLine -and $_.CommandLine.IndexOf($webViewDirectory, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
    foreach ($browser in $browsers) {
      $ownedBrowser = Get-Process -Id $browser.ProcessId -ErrorAction SilentlyContinue
      if ($null -ne $ownedBrowser) {
        try { Stop-OwnedProcess $ownedBrowser } finally { $ownedBrowser.Dispose() }
      }
    }
    $uninstallerPath = Join-Path $installDirectory 'uninstall.exe'
    if (Test-Path -LiteralPath $uninstallerPath -PathType Leaf) {
      # _?= prevents the uninstaller from copying/relaunching itself so its
      # process completion actually represents uninstall completion. It is last
      # and unquoted as NSIS requires. We remove its remaining file afterward.
      $uninstallerProcess = Start-SmokeProcess $uninstallerPath "/S _?=$installDirectory"
      Wait-SmokeProcess $uninstallerProcess 'Silent uninstallation' 120
      if ($null -ne $applicationPath -and (Test-Path -LiteralPath $applicationPath)) {
        throw 'The uninstaller left the installed application executable behind.'
      }
    } elseif ($null -ne $receipt) {
      throw 'The installed package has no uninstaller.'
    }
    if (@(Get-AppRegistration).Count -ne 0) { throw 'The installer check left application registration behind.' }
    foreach ($process in $ownedProcesses) { $process.Dispose() }
    $http.Dispose()
    $removed = $false
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
      try {
        Remove-Item -LiteralPath $smokeRoot -Recurse -Force
        $removed = $true
        break
      } catch {
        if ($attempt -eq 9) { throw }
        Start-Sleep -Milliseconds 500
      }
    }
    if (-not $removed) { throw 'Could not remove the isolated smoke-check directory.' }
    if ($null -ne $receipt) { $receipt.uninstallation = 'passed'; $receipt.cleanup = 'passed' }
  } catch {
    $cleanupFailure = $_
  }
}

if ($null -ne $cleanupFailure) {
  Write-Warning "Smoke-check cleanup failed; isolated files retained at ${smokeRoot}: $cleanupFailure"
}
if ($null -ne $smokeFailure) { throw $smokeFailure }
if ($null -ne $cleanupFailure) { throw $cleanupFailure }
$receipt | ConvertTo-Json -Depth 4
