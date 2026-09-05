# Откат обвязки к снимку, сделанному install.ps1.
# Запуск:  powershell -ExecutionPolicy Bypass -File .claude/otkat.ps1 [-Snapshot 2026-09-05_1200]
# Для точечного отката файла, который в git, предпочтительнее: git checkout -- .claude/<файл>
param([string]$Snapshot = "")

$ErrorActionPreference = "Stop"
$ClaudeDir = $PSScriptRoot
$Root      = Split-Path $ClaudeDir -Parent
$Snaps     = Join-Path (Split-Path $Root -Parent) ".claude-snapshots"

function Say($msg, $color = "Gray") { Write-Host "  $msg" -ForegroundColor $color }

Write-Host "`n=== Откат обвязки ===`n" -ForegroundColor Cyan
if (-not (Test-Path $Snaps)) { throw "Снимков нет: $Snaps. Сначала запусти install.ps1." }
$all = Get-ChildItem $Snaps -Directory | Sort-Object Name -Descending
if ($all.Count -eq 0) { throw "Снимков нет: папка $Snaps пуста." }

if (-not $Snapshot) {
    Say "Есть снимки:" "White"; $all | ForEach-Object { Say $_.Name }
    $Snapshot = $all[0].Name
    Say "Аргумент не задан - откатываю на последний: $Snapshot" "Yellow"
}
$src = Join-Path $Snaps $Snapshot
if (-not (Test-Path $src)) { throw "Нет такого снимка: $src" }

$answer = Read-Host "Заменить содержимое $ClaudeDir снимком $Snapshot ? (y/n)"
if ($answer -ne "y") { Say "Отменено." "Yellow"; exit }

$stamp = Get-Date -Format "yyyy-MM-dd_HHmm"
$before = Join-Path $Snaps "$stamp-before-otkat"
New-Item -ItemType Directory -Force -Path $before | Out-Null
Copy-Item (Join-Path $ClaudeDir "*") $before -Recurse -Force -ErrorAction SilentlyContinue
Say "текущее состояние сохранено: $stamp-before-otkat" "Green"

foreach ($kind in @("commands", "agents", "hooks", "output-styles")) {
    $s = Join-Path $src $kind
    if (-not (Test-Path $s)) { continue }
    $d = Join-Path $ClaudeDir $kind
    Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item $s $d -Recurse -Force
    Say "$kind восстановлены" "Green"
}
Get-ChildItem $src -File | ForEach-Object { Copy-Item $_.FullName (Join-Path $ClaudeDir $_.Name) -Force; Say $_.Name "Green" }

Write-Host "`n=== Откат сделан. Проверь git status: файлы обвязки, которые в git, теперь могут отличаться от коммита ===" -ForegroundColor Cyan
