$ErrorActionPreference = "Stop"

$release = Invoke-RestMethod "https://api.github.com/repos/yaniv256/actions.json/releases/latest"
$extension = $release.assets | Where-Object name -Like "actions-json-overlay-runtime-*.zip" | Select-Object -First 1
$checksums = $release.assets | Where-Object name -EQ "SHA256SUMS.txt" | Select-Object -First 1
if (-not $extension -or -not $checksums) {
  throw "Latest release does not contain the extension ZIP and SHA256SUMS.txt."
}

$temp = Join-Path ([System.IO.Path]::GetTempPath()) "actions-json-doc-verification-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $temp | Out-Null
try {
  Invoke-WebRequest $extension.browser_download_url -OutFile (Join-Path $temp $extension.name)
  Invoke-WebRequest $checksums.browser_download_url -OutFile (Join-Path $temp $checksums.name)

  $guide = Get-Content (Join-Path $PSScriptRoot "../../docs/getting-started.md") -Raw
  $match = [regex]::Match($guide, '(?s)On Windows PowerShell:\s*```powershell\s*(.*?)\s*```')
  if (-not $match.Success) { throw "Published PowerShell verification block not found." }
  $publishedCommand = $match.Groups[1].Value

  Push-Location $temp
  try {
    Invoke-Expression $publishedCommand
    Remove-Item $extension.name
    try {
      Invoke-Expression $publishedCommand
      throw "Published command unexpectedly accepted a missing extension ZIP."
    } catch {
      if ($_.Exception.Message -notlike "No actions-json-overlay-runtime-*.zip found*") { throw }
    }
  } finally {
    Pop-Location
  }
} finally {
  Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue
}
