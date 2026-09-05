# Установка обвязки агентов AI Shorts Factory.
# Запуск из корня репозитория:  powershell -ExecutionPolicy Bypass -File .claude/install.ps1
# Идемпотентно: снимок, сверка моделей, settings.local.json, самопроверка.

$ErrorActionPreference = "Stop"

$ClaudeDir = $PSScriptRoot                       # <repo>\.claude
$Root      = Split-Path $ClaudeDir -Parent       # <repo>
$Snaps     = Join-Path (Split-Path $Root -Parent) ".claude-snapshots"

function Say($msg, $color = "Gray") { Write-Host "  $msg" -ForegroundColor $color }
$Problems = @()

Write-Host "`n=== Обвязка агентов: установка ===`n" -ForegroundColor Cyan
Say "обвязка : $ClaudeDir"
Say "репозиторий: $Root"
Write-Host ""

# --- 0. Node и git ---
try { $nodeVersion = (& node --version) } catch { throw "Не найден node. Хуки написаны на Node - поставь Node.js 20+." }
Say "node $nodeVersion"
if (-not (Test-Path (Join-Path $Root ".git"))) { $Problems += "в $Root нет .git - замки работают по диффу и без git бесполезны" ; Say "нет .git" "Red" }

# --- 1. Снимок (10 последних) ---
$stamp = Get-Date -Format "yyyy-MM-dd_HHmm"
$snap  = Join-Path $Snaps $stamp
try {
    New-Item -ItemType Directory -Force -Path $snap | Out-Null
    Copy-Item (Join-Path $ClaudeDir "*") $snap -Recurse -Force -ErrorAction SilentlyContinue
    Say "снимок: $snap" "Green"
    Get-ChildItem $Snaps -Directory | Sort-Object Name -Descending | Select-Object -Skip 10 |
        ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
} catch { Say "снимок сделать не удалось - установка продолжается" "Yellow" }

# --- 2. Папки состояния ---
New-Item -ItemType Directory -Force -Path (Join-Path $Root "tasks") | Out-Null
foreach ($f in @("unlock.txt", "scope.txt")) {
    $p = Join-Path $ClaudeDir $f
    if (-not (Test-Path $p)) { [System.IO.File]::WriteAllText($p, "", (New-Object System.Text.UTF8Encoding($false))) }
}

# --- 3. Модели: у каждой команды и каждого агента своя ---
$ExpectedCmd = @{
    "auto"="sonnet"; "task"="opus"; "go"="sonnet"; "qa"="sonnet"; "fix"="sonnet";
    "gates"="sonnet"; "done"="sonnet"; "scope"="sonnet"; "ask"="sonnet"; "status"="sonnet"
}
$ExpectedAgent = @{
    "pm"="fable"; "techlead"="fable"; "review-architecture"="fable"; "review-product"="fable";
    "planner"="opus"; "review-correctness"="opus"; "review-data"="opus"; "review-security"="opus";
    "worker"="sonnet"; "review-conventions"="sonnet"; "review-tests"="sonnet"
}
function Check-Models($dir, $expected, $kind) {
    foreach ($name in $expected.Keys) {
        $path = Join-Path $dir "$name.md"
        if (-not (Test-Path $path)) { Say "нет файла: $kind\$name.md" "Red"; $script:Problems += "нет $kind\$name.md"; continue }
        $head = (Get-Content $path -TotalCount 10 -Encoding UTF8) -join "`n"
        $want = $expected[$name]
        if ($head -match "(?m)^model:\s*(\S+)") {
            if ($Matches[1] -ne $want) { Say "$kind\$name.md: модель $($Matches[1]), ожидалась $want" "Yellow"; $script:Problems += "$kind\$name.md - чужая модель" }
        } else { Say "$kind\$name.md: нет поля model" "Red"; $script:Problems += "$kind\$name.md - нет model" }
    }
}
Check-Models (Join-Path $ClaudeDir "commands") $ExpectedCmd "commands"
Check-Models (Join-Path $ClaudeDir "agents")   $ExpectedAgent "agents"
Say "модели команд и агентов сверены" "Green"

# --- 4. settings.local.json: персональные разрешения (хуки живут в settings.json) ---
$localPath = Join-Path $ClaudeDir "settings.local.json"
$local = if (Test-Path $localPath) { Get-Content $localPath -Raw -Encoding UTF8 | ConvertFrom-Json } else { [PSCustomObject]@{} }
$permissions = [PSCustomObject]@{
    defaultMode = "dontAsk"
    allow = @("Read", "Grep", "Glob", "Write", "Edit", "MultiEdit", "Bash", "Task", "Skill(code-review)", "Skill(qa)")
    ask = @()
}
if ($null -ne $local.PSObject.Properties["permissions"]) { $local.permissions = $permissions }
else { $local | Add-Member -NotePropertyName "permissions" -NotePropertyValue $permissions }
$json = $local | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($localPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Say "settings.local.json записан (dontAsk + allow)" "Green"

# --- 5. Самопроверка ---
$selftest = Join-Path $ClaudeDir "hooks\harness-selftest.js"
if (-not (Test-Path $selftest)) { Say "нет hooks\harness-selftest.js" "Red"; $Problems += "самопроверки нет" }
else {
    Push-Location $Root
    $out = & node $selftest 2>&1
    $code = $LASTEXITCODE
    Pop-Location
    $out | ForEach-Object { Write-Host "  $_" }
    if ($code -eq 0) { Say "самопроверка обвязки прошла" "Green" } else { Say "самопроверка красная - смотри строки выше" "Red"; $Problems += "самопроверка красная" }
}

# --- 6. Итог ---
Write-Host ""
if ($Problems.Count -eq 0) { Write-Host "=== Готово, замечаний нет ===" -ForegroundColor Cyan }
else { Write-Host "=== Готово, но есть замечания ===" -ForegroundColor Yellow; $Problems | ForEach-Object { Say $_ "Yellow" } }
Write-Host ""
Write-Host "Дальше:" -ForegroundColor White
Write-Host "  1. Открой Claude Code в $Root"
Write-Host "  2. /clear - подхватить шапки команд и агентов; /model sonnet"
Write-Host "  3. /auto - следующая задача из трекера; шпаргалка: docs/61_HOW_TO_WORK.md"
Write-Host "  4. Откат: powershell -ExecutionPolicy Bypass -File $ClaudeDir\otkat.ps1`n" -ForegroundColor Yellow
