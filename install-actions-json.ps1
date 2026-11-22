param(
  [Parameter(Mandatory=$true)][string]$Version,
  [string]$Channel = "stable",
  [string]$Prefix = "$env:LOCALAPPDATA\ActionsJson",
  [string]$BaseUrl = "",
  [string]$Bind = "127.0.0.1:17345",
  [string]$StorageRoot = "$env:LOCALAPPDATA\ActionsJson\storage",
  [string]$Actions = "",
  [string]$StateDir = "",
  [switch]$Recover
)
$ErrorActionPreference = 'Stop'
if ([Environment]::Is64BitOperatingSystem -ne $true) { throw 'Only Windows x64 is supported' }
if (-not $BaseUrl) { $BaseUrl = "https://github.com/yaniv256/actions.json/releases/download/extension-v$Version" }
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("actions-json-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null
$createdConfig = $false
$installSucceeded = $false
$configFile = $null
$configBackup = $null
$configExisted = $false
$binaryBackup = $null
$aliasBackup = $null
$counterBackup = $null
$destinationExisted = $false
$aliasExisted = $false
$counterExisted = $false
try {
  $manifestPath = Join-Path $tmp 'release-manifest.json'; $sigPath = Join-Path $tmp 'release-manifest.sig'
  Invoke-WebRequest "$BaseUrl/release-manifest.json" -OutFile $manifestPath
  Invoke-WebRequest "$BaseUrl/release-manifest.sig" -OutFile $sigPath
  $manifestBytes = [IO.File]::ReadAllBytes($manifestPath); $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
  if ($manifest.schema_version -ne 1 -or $manifest.channel -ne $Channel -or $manifest.key_id -ne 'actions-json-stable-2026-01' -or $manifest.version -ne $Version) { throw 'untrusted release manifest identity' }
  if ([int64]$manifest.release_counter -lt 1 -or [int64]$manifest.release_counter -gt 999999) { throw 'release counter is outside the trusted key window' }
  # XML RSA import and the string-algorithm VerifyData overload work on both
  # Windows PowerShell 5.1 and PowerShell 7; ImportFromPem does not.
  $rsa = New-Object Security.Cryptography.RSACryptoServiceProvider
  $rsa.FromXmlString('<RSAKeyValue><Modulus>4pZ6jhJbKu6zLvm8d3h4l5OBeA49kfKflq51A53Fp6S2W1ikJCHQyePTD5gO1F+IIe9Qdc7Xq3tFZqrrhfGxt2H8YaVXUO/nvUZKSoneUTZ6T1bBdBG88kXHbC0GjvBE7q98NHn+CjrtiWcKpVmBi6YMIUuoot/oh3dMTgZFY6nwWHo57OYoYWQgs+QQEAjxNl2GePTFy02b3mioaBQmAES6wiip8pZwxDUQtMf6kfm7yTivgrjkswt2dunSITCHcmXo/uWiGai+K8d+dVzRLezpKw2S7G/1IbHie+lt9gvBkZkCgVlHqNCnL3KtCau0mBYgOkfzIk+p6YzB4HG//2MCvj4MHYmbTQrsk6BdRXjAc3sDUM0uV+pbm2aRC9P/TRvujZk9X7mR+f8Ws6Odo6jzZhxuj6zaeuCky6aGtCnPxWe7EgOTk8Sgg2W5Ib9XU7y2n4upm2mpV2W9WSHFsyMjfvks+HhI5G65SqliY3vMx5kP87kGop2HTFtzkY/v</Modulus><Exponent>AQAB</Exponent></RSAKeyValue>')
  if (-not $rsa.VerifyData($manifestBytes, 'SHA256', [IO.File]::ReadAllBytes($sigPath))) { throw 'release manifest signature is invalid' }
  $configRoot = Join-Path $env:USERPROFILE '.actions-json'
  $configFile = Join-Path $configRoot 'config.json'
  New-Item -ItemType Directory -Force $configRoot | Out-Null
  if (-not (Test-Path $configFile)) {
    $legacyCandidates = @(
      (Join-Path $env:LOCALAPPDATA 'ActionsJson\config.json'),
      (Join-Path $env:USERPROFILE '.actions-json.local.json')
    )
    foreach ($legacy in $legacyCandidates) {
      if (Test-Path $legacy) {
        Copy-Item $legacy $configFile
        break
      }
    }
  }
  $existing = $null
  if (Test-Path $configFile) {
    $configExisted = $true
    $configBackup = Join-Path $tmp 'config.previous.json'
    Copy-Item $configFile $configBackup
    $existing = Get-Content $configFile -Raw | ConvertFrom-Json
    if ($existing.schema_version -and $existing.schema_version -ne 1) { throw "existing install config is invalid: $configFile" }
    if ($PSBoundParameters.ContainsKey('StateDir') -and $existing.state_dir -and ([IO.Path]::GetFullPath($StateDir) -ne [IO.Path]::GetFullPath($existing.state_dir))) { throw "-StateDir conflicts with existing config: $configFile" }
    if ($PSBoundParameters.ContainsKey('Bind') -and $existing.bind -and $Bind -ne $existing.bind) { throw "-Bind conflicts with existing config: $configFile" }
    if ($PSBoundParameters.ContainsKey('StorageRoot') -and $existing.storage_root -and ([IO.Path]::GetFullPath($StorageRoot) -ne [IO.Path]::GetFullPath($existing.storage_root))) { throw "-StorageRoot conflicts with existing config: $configFile" }
    $existingActions = if ($existing.actions) { [string]$existing.actions } else { '' }
    if ($PSBoundParameters.ContainsKey('Actions') -and $Actions -ne $existingActions) { throw "-Actions conflicts with existing config: $configFile" }
    if ($existing.state_dir) { $StateDir = [string]$existing.state_dir }
    if ($existing.bind) { $Bind = [string]$existing.bind }
    if ($existing.storage_root) { $StorageRoot = [string]$existing.storage_root }
    $Actions = $existingActions
  }
  # Bridge pairing: the extension and the bridge share one secret, which may be a
  # passphrase the user chooses. Never replace an existing secret here (that would
  # unpair every browser; use `actions-json pair rotate`). Otherwise take
  # ACTIONS_JSON_BRIDGE_SECRET, or ask when the session is interactive. With
  # neither, the bridge generates a secret on first start, as before.
  $minBridgeSecretLength = 8
  $bridgeSecret = ''
  $existingSecret = if ($existing -and $existing.bridge_handshake_secret) { [string]$existing.bridge_handshake_secret } else { '' }
  if (-not $existingSecret) {
    if ($env:ACTIONS_JSON_BRIDGE_SECRET) {
      $bridgeSecret = $env:ACTIONS_JSON_BRIDGE_SECRET.Trim()
      if ($bridgeSecret.Length -lt $minBridgeSecretLength) { throw "ACTIONS_JSON_BRIDGE_SECRET must be at least $minBridgeSecretLength characters" }
    } elseif ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
      Write-Host "Choose a bridge passphrase. You will type the same one into the extension's"
      Write-Host "Bridge pairing field. At least $minBridgeSecretLength characters; press Enter to generate one instead."
      while ($true) {
        $first = [Net.NetworkCredential]::new('', (Read-Host -AsSecureString 'Bridge passphrase')).Password.Trim()
        if (-not $first) { Write-Host 'A secret will be generated. Show it later with: actions-json pair inspect --reveal-secret'; break }
        if ($first.Length -lt $minBridgeSecretLength) { Write-Host "Too short: use at least $minBridgeSecretLength characters."; continue }
        $second = [Net.NetworkCredential]::new('', (Read-Host -AsSecureString 'Repeat it')).Password.Trim()
        if ($first -ne $second) { Write-Host 'They did not match. Try again.'; continue }
        $bridgeSecret = $first; break
      }
      Remove-Variable first,second -ErrorAction SilentlyContinue
    }
  }
  if (-not $StateDir) { $StateDir = $configRoot }
  $state = [IO.Path]::GetFullPath($StateDir)
  $StorageRoot = [IO.Path]::GetFullPath($StorageRoot)
  if ($Actions) { $Actions = [IO.Path]::GetFullPath($Actions) }
  if ($state -eq [IO.Path]::GetPathRoot($state) -or $StorageRoot -eq [IO.Path]::GetPathRoot($StorageRoot)) { throw 'unsafe installation path' }
  New-Item -ItemType Directory -Force $state | Out-Null
  $counterFile = Join-Path $state "release-counter-$Channel"; $oldCounter = if (Test-Path $counterFile) { [int64](Get-Content $counterFile -Raw) } else { 0 }
  if ([int64]$manifest.release_counter -lt $oldCounter -and -not $Recover) { throw 'release downgrade refused' }
  $pinDirectory = (Get-Location).Path
  while ($pinDirectory) {
    $pinFile = Join-Path $pinDirectory '.actions-json-version'
    if (Test-Path $pinFile) {
      if ((Get-Content $pinFile -Raw).Trim() -ne $Version) { throw 'project actions-json version pin does not match requested version' }
      break
    }
    $parent = Split-Path $pinDirectory -Parent
    if ($parent -eq $pinDirectory) { break }
    $pinDirectory = $parent
  }
  $asset = @($manifest.assets | Where-Object { $_.kind -eq 'cli' -and $_.platform -eq 'windows' -and $_.arch -eq 'x64' })
  if ($asset.Count -ne 1) { throw 'signed manifest has no unique Windows x64 CLI asset' }
  $archive = Join-Path $tmp $asset[0].filename; Invoke-WebRequest "$BaseUrl/$($asset[0].filename)" -OutFile $archive
  if ((Get-Item $archive).Length -ne [int64]$asset[0].bytes) { throw 'asset size mismatch' }
  if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $asset[0].sha256) { throw 'asset digest mismatch' }
  tar -xzf $archive -C $tmp actions-json.exe
  $reportedVersion = (& (Join-Path $tmp 'actions-json.exe') version | ConvertFrom-Json).result.version
  if ($reportedVersion -ne $Version) { throw "candidate binary version mismatch: expected $Version, got $reportedVersion" }
  New-Item -ItemType Directory -Force $StorageRoot | Out-Null
  if ($existing) {
    $config = [ordered]@{}
    foreach ($property in $existing.PSObject.Properties) { $config[$property.Name] = $property.Value }
  } else {
    $config = [ordered]@{}
    $createdConfig = $true
  }
  $config.schema_version = 1; $config.state_dir = $state; $config.bind = $Bind; $config.storage_root = $StorageRoot
  if ($Actions) { $config.actions = $Actions }
  if ($bridgeSecret) { $config.bridge_handshake_secret = $bridgeSecret; $config.Remove('bridge_pairing_revoked') }
  $utf8NoBom = New-Object Text.UTF8Encoding($false)
  [IO.File]::WriteAllText("$configFile.new", ($config | ConvertTo-Json), $utf8NoBom)
  Move-Item -Force "$configFile.new" $configFile
  New-Item -ItemType Directory -Force $Prefix | Out-Null
  $destination = Join-Path $Prefix 'actions-json.exe'; $staged = "$destination.new"
  Copy-Item (Join-Path $tmp 'actions-json.exe') $staged -Force
  if (Test-Path $destination) {
    $destinationExisted = $true
    & $destination shutdown | Out-Null
    $binaryBackup = "$destination.previous"
    Copy-Item $destination $binaryBackup -Force
  }
  $alias = Join-Path $Prefix 'aj.exe'
  if (Test-Path $alias) { $aliasExisted = $true; $aliasBackup = "$alias.previous"; Copy-Item $alias $aliasBackup -Force }
  if (Test-Path $counterFile) { $counterExisted = $true; $counterBackup = "$counterFile.previous"; Copy-Item $counterFile $counterBackup -Force }
  try { Move-Item -Force $staged $destination } catch {
    throw "verified update could not replace the stopped actions-json executable: $($_.Exception.Message)"
  }
  Copy-Item $destination $alias -Force
  Set-Content -Path $counterFile -Value ([string]$manifest.release_counter) -NoNewline
  $installSucceeded = $true
  Remove-Item -Force $binaryBackup,$aliasBackup,$counterBackup -ErrorAction SilentlyContinue
  Write-Output "installed actions-json $Version (windows-x64)"
  if ($bridgeSecret) { Write-Output "bridge passphrase saved to $configFile; enter the same passphrase in the extension's Bridge pairing field" }
} finally {
  if (-not $installSucceeded -and $createdConfig -and $configFile) {
    Remove-Item -Force $configFile -ErrorAction SilentlyContinue
  }
  if (-not $installSucceeded) {
    if ($configExisted -and $configBackup -and (Test-Path $configBackup)) { Copy-Item -Force $configBackup $configFile }
    if ($binaryBackup -and (Test-Path $binaryBackup)) { Move-Item -Force $binaryBackup $destination }
    elseif (-not $destinationExisted -and $destination) { Remove-Item -Force $destination -ErrorAction SilentlyContinue }
    if ($aliasBackup -and (Test-Path $aliasBackup)) { Move-Item -Force $aliasBackup $alias }
    elseif (-not $aliasExisted -and $alias) { Remove-Item -Force $alias -ErrorAction SilentlyContinue }
    if ($counterBackup -and (Test-Path $counterBackup)) { Move-Item -Force $counterBackup $counterFile }
    elseif (-not $counterExisted -and $counterFile) { Remove-Item -Force $counterFile -ErrorAction SilentlyContinue }
  }
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
