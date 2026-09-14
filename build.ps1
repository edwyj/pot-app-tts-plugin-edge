# Packages the plugin into a .potext (a zip of info.json + icon + main.js).
#
# Pot requires the filename to START WITH "plugin" -- install_plugin enforces it
# (pot-desktop src-tauri/src/cmd.rs:141) and get_plugin_list silently DELETES
# any plugin directory that does not (src-tauri/src/config.rs:160).
#
# Mirrors .github/workflows/build.yml so local and CI artifacts match.
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$info = Get-Content (Join-Path $root 'info.json') -Raw | ConvertFrom-Json
$id = $info.id
$icon = $info.icon

if (-not $id.StartsWith('plugin')) {
    throw "Plugin id '$id' must start with 'plugin'."
}

foreach ($required in @('info.json', $icon, 'main.js')) {
    $path = Join-Path $root $required
    if (-not (Test-Path $path)) { throw "Missing required file: $required" }
}

$dist = Join-Path $root 'dist'
if (-not (Test-Path $dist)) { New-Item -ItemType Directory -Path $dist | Out-Null }

$out = Join-Path $dist "$id.potext"
$staging = Join-Path $dist "$id.zip"
foreach ($f in @($out, $staging)) { if (Test-Path $f) { Remove-Item $f -Force } }

# Compress-Archive refuses any extension but .zip, so build as .zip and rename.
Compress-Archive -Path (Join-Path $root 'info.json'), (Join-Path $root $icon), (Join-Path $root 'main.js') -DestinationPath $staging
Move-Item -Path $staging -Destination $out

Write-Host "Built $out"
