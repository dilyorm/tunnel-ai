# Install tunnel on Windows, an end-to-end encrypted tunnel between AI agents on different machines.
#
#   irm https://tunnel.dilyor.dev/install.ps1 | iex
#
# Everything goes in ~\.tunnel: bin\tunnel.cmd, lib\tunnel-ai, and node\ when this machine
# has no Node 22.13 or newer. bin\ is added to your user PATH. Run it again to update.
#
#   $env:TUNNEL_INSTALL = 'D:\tools\tunnel'   install somewhere else
#   $env:TUNNEL_NO_MODIFY_PATH = '1'          leave PATH alone

# Runs in a script block so a failure ends the install, not the caller's PowerShell session.
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue' # the progress bar makes Invoke-WebRequest crawl
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $base = if ($env:TUNNEL_DOWNLOAD) { $env:TUNNEL_DOWNLOAD } else { 'https://tunnel.dilyor.dev' }
  $dir = if ($env:TUNNEL_INSTALL) { $env:TUNNEL_INSTALL } else { Join-Path $HOME '.tunnel' }
  $bin = Join-Path $dir 'bin'
  $nodeDist = 'https://nodejs.org/dist/latest-v22.x'
  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('tunnel-' + [Guid]::NewGuid().ToString('N'))

  # tunnel needs node:sqlite without flags, which arrived in Node 22.13.
  function Test-Node($exe) {
    $ErrorActionPreference = 'Continue'
    & $exe --no-warnings -e "require('node:sqlite')" 2>$null | Out-Null
    $LASTEXITCODE -eq 0
  }

  function Expand-Tar($archive, $into) {
    & $tar -xf $archive -C $into
    if ($LASTEXITCODE -ne 0) { throw "Could not unpack $(Split-Path $archive -Leaf)." }
  }

  try {
    if (-not (Test-Path $tar)) { throw 'This needs tar.exe, which ships with Windows 10 (1803) and newer.' }
    New-Item -ItemType Directory -Force $tmp | Out-Null

    $system = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $bundled = Join-Path $dir 'node\node.exe'
    if ($system -and (Test-Node $system.Source)) {
      $nodeCmd = 'node'
      Write-Host "Using Node $(& $system.Source --version) from $($system.Source)."
    } elseif ((Test-Path $bundled) -and (Test-Node $bundled)) {
      $nodeCmd = '"%~dp0..\node\node.exe"'
      Write-Host "Using Node $(& $bundled --version) in $(Join-Path $dir 'node')."
    } else {
      $cpu = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
      $arch = switch ($cpu) {
        'AMD64' { 'x64' }
        'ARM64' { 'arm64' }
        default { throw "No prebuilt Node for $cpu. Install Node 22.13+ yourself, then run this again." }
      }
      Write-Host "No Node 22.13+ here, so downloading Node 22 for win-$arch..."
      $sums = (Invoke-WebRequest "$nodeDist/SHASUMS256.txt" -UseBasicParsing).Content
      $match = [regex]::Match($sums, "(?m)^([0-9a-f]{64})\s+(node-v[0-9.]+-win-$arch\.zip)$")
      if (-not $match.Success) { throw "nodejs.org has no Node 22 build for win-$arch." }
      $file = $match.Groups[2].Value
      $zip = Join-Path $tmp $file
      Invoke-WebRequest "$nodeDist/$file" -OutFile $zip -UseBasicParsing
      if ((Get-FileHash $zip -Algorithm SHA256).Hash -ne $match.Groups[1].Value) {
        throw "Checksum mismatch for $file. Run this again."
      }
      Expand-Tar $zip $tmp
      New-Item -ItemType Directory -Force $dir | Out-Null
      $nodeDir = Join-Path $dir 'node'
      if (Test-Path $nodeDir) { Remove-Item -Recurse -Force $nodeDir }
      Move-Item (Join-Path $tmp ($file -replace '\.zip$', '')) $nodeDir
      # tunnel needs only node.exe; npm and friends are most of the download.
      Get-ChildItem $nodeDir | Where-Object { $_.Name -notin 'node.exe', 'LICENSE' } | Remove-Item -Recurse -Force
      $nodeCmd = '"%~dp0..\node\node.exe"'
    }

    Write-Host 'Downloading tunnel...'
    $tgz = Join-Path $tmp 'tunnel-ai.tgz'
    Invoke-WebRequest "$base/tunnel-ai.tgz" -OutFile $tgz -UseBasicParsing
    $pkg = Join-Path $tmp 'pkg'
    New-Item -ItemType Directory -Force $pkg, $bin, (Join-Path $dir 'lib') | Out-Null
    Expand-Tar $tgz $pkg
    $lib = Join-Path $dir 'lib\tunnel-ai'
    if (Test-Path $lib) { Remove-Item -Recurse -Force $lib }
    Move-Item (Join-Path $pkg 'package') $lib

    # Paths relative to the .cmd itself keep the file ASCII-only whatever the user's folder is called.
    # The goto to a missing label makes cmd stop reading this file after the line runs (npm's cmd-shim
    # does the same), so `tunnel update` can rewrite the file while it is running.
    $shim = "@echo off`r`ngoto #_undefined_# 2>NUL || $nodeCmd `"%~dp0..\lib\tunnel-ai\dist\bin.js`" %*`r`n"
    [IO.File]::WriteAllText((Join-Path $bin 'tunnel.cmd'), $shim, [Text.Encoding]::ASCII)
    $version = & (Join-Path $bin 'tunnel.cmd') --version
    if ($LASTEXITCODE -ne 0) { throw 'The installed tunnel did not start.' }

    $onPath = ($env:Path -split ';') -contains $bin
    $added = $false
    if (-not $env:TUNNEL_NO_MODIFY_PATH) {
      # Edit the registry value directly: [Environment]::SetEnvironmentVariable would rewrite it
      # as a plain string and break entries like %USERPROFILE%\bin.
      $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
      $current = $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
      $entries = @($current -split ';' | Where-Object { $_ })
      if ($entries -notcontains $bin) {
        $key.SetValue('Path', (@($bin) + $entries) -join ';', 'ExpandString')
        # Setting any user variable broadcasts the change, so new terminals pick up PATH.
        [Environment]::SetEnvironmentVariable('TUNNEL_INSTALL_REFRESH', '1', 'User')
        [Environment]::SetEnvironmentVariable('TUNNEL_INSTALL_REFRESH', $null, 'User')
        $added = $true
      }
      $key.Close()
      if (-not $onPath) { $env:Path = "$bin;$env:Path" }
    }

    Write-Host ''
    Write-Host "tunnel $version is installed in $bin."
    if ($added) { Write-Host 'Added it to your PATH. This window is ready; other open terminals need a restart.' }
    elseif (-not $onPath -and $env:TUNNEL_NO_MODIFY_PATH) { Write-Host "Add $bin to PATH to run it as tunnel." }
    Write-Host ''
    Write-Host '  tunnel open              open a tunnel and get an invite code'
    Write-Host '  tunnel join <code>       join it from another machine'
    Write-Host '  tunnel skills install    teach your coding agents to use it'
  } catch {
    Write-Host "tunnel install: $($_.Exception.Message)" -ForegroundColor Red
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}
