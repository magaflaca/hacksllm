# Instalador de bichi code para Windows.
#   irm https://llm.hacks.win/code/install.ps1 | iex
# Deja bichi en %USERPROFILE%\.bichi\bin (en el PATH del usuario). Si no hay Node 20 o mas nuevo,
# descarga uno portable en %USERPROFILE%\.bichi\node sin tocar el sistema.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$site = 'https://llm.hacks.win'
$root = Join-Path $env:USERPROFILE '.bichi'
$bin = Join-Path $root 'bin'
$portable = Join-Path $root 'node'

function Say($text, $color = 'Cyan') { Write-Host "  $text" -ForegroundColor $color }

Write-Host ''
Write-Host '  bichi code' -ForegroundColor Blue -NoNewline
Write-Host '  instalando tu bicho programador' -ForegroundColor DarkGray
Write-Host ''

New-Item -ItemType Directory -Force $bin | Out-Null

function Get-NodeMajor {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { return 0 }
  try { return [int]((& node -v).TrimStart('v').Split('.')[0]) } catch { return 0 }
}

if ((Get-NodeMajor) -ge 20) {
  Say "uso el Node que ya tienes ($(& node -v))" 'DarkGray'
} elseif (Test-Path (Join-Path $portable 'node.exe')) {
  Say 'uso el Node portable que ya estaba' 'DarkGray'
} else {
  Say 'no encontre Node 20+, descargo uno portable (solo para bichi)...'
  $release = (Invoke-RestMethod 'https://nodejs.org/dist/index.json') | Where-Object { $_.lts } | Select-Object -First 1
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } elseif ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
  $name = "node-$($release.version)-win-$arch"
  $zip = Join-Path $env:TEMP "$name.zip"
  Invoke-WebRequest "https://nodejs.org/dist/$($release.version)/$name.zip" -OutFile $zip
  if (Test-Path $portable) { Remove-Item $portable -Recurse -Force }
  Expand-Archive $zip -DestinationPath $root -Force
  Rename-Item (Join-Path $root $name) 'node'
  Remove-Item $zip -Force
  Say "Node $($release.version) listo" 'DarkGray'
}

Say 'descargando bichi code...'
Invoke-WebRequest "$site/code/bichi.mjs" -OutFile (Join-Path $bin 'bichi.mjs')

# Lanzador: el Node portable si existe, si no el del sistema.
$launcher = @'
@echo off
if exist "%~dp0..\node\node.exe" (
  "%~dp0..\node\node.exe" "%~dp0bichi.mjs" %*
) else (
  node "%~dp0bichi.mjs" %*
)
'@
Set-Content -Path (Join-Path $bin 'bichi.cmd') -Value $launcher -Encoding ASCII

# PATH del usuario, conservando las variables sin expandir.
$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
$current = $key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
if (($current -split ';') -notcontains $bin) {
  $key.SetValue('Path', ($(if ($current) { "$current;$bin" } else { $bin })), 'ExpandString')
  # Avisa a Windows del cambio para que las terminales nuevas lo vean.
  [Environment]::SetEnvironmentVariable('BICHI_CODE', '1', 'User')
}
$key.Close()
if (($env:Path -split ';') -notcontains $bin) { $env:Path = "$env:Path;$bin" }

$version = (& (Join-Path $bin 'bichi.cmd') --version) 2>$null
Write-Host ''
Say "bichi code $version instalado" 'Green'
Write-Host ''
Write-Host '  para empezar, en la carpeta de tu proyecto:' -ForegroundColor DarkGray
Write-Host '    bichi' -ForegroundColor Cyan
Write-Host ''
Write-Host '  (si esta terminal no lo encuentra, abre una nueva)' -ForegroundColor DarkGray
Write-Host ''
