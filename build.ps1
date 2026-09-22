# Packages the plugin into a .potext (a zip of info.json + icon + main.js).
#
# Pot requires the filename to START WITH "plugin" -- install_plugin enforces it
# (pot-desktop src-tauri/src/cmd.rs:141) and get_plugin_list silently DELETES
# any plugin directory that does not (src-tauri/src/config.rs:160).
#
# Mirrors .github/workflows/build.yml: both put the same three files in, so the
# two artifacts hold identical *contents*. They are not byte-identical -- this
# uses Compress-Archive, CI uses vimtor/action-zip, and the two differ in
# compression and stored timestamps. Compare extracted contents, not hashes.
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
# -Encoding UTF8 is load-bearing. Windows PowerShell 5.1 reads a BOM-less file
# using the system ANSI code page, which turns the non-ASCII control labels in
# info.json into mojibake and breaks the JSON parse. It is harmless on
# PowerShell 7+, which already defaults to UTF-8.
$info = Get-Content (Join-Path $root 'info.json') -Raw -Encoding UTF8 | ConvertFrom-Json
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
