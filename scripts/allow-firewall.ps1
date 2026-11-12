# 允許 Tello 的狀態（UDP 8890）與影像（UDP 11111）進入本機。
# 用法：以系統管理員身分開 PowerShell，在專案資料夾執行：
#   powershell -ExecutionPolicy Bypass -File scripts\allow-firewall.ps1
#
# 做兩件事：
#   1. 刪掉「封鎖」這個程式入站連線的規則（第一次執行時跳出安全性警訊、被取消或只勾私人網路時，
#      Windows 會自動建立這種規則；封鎖規則的優先權高於允許規則，不刪掉的話新增允許也沒用）
#   2. 新增允許規則：只開放 UDP 8890、11111，而且來源只限 Tello 的子網路 192.168.10.0/24
#Requires -RunAsAdministrator

$ErrorActionPreference = 'Stop'

function Remove-BlockRules($program) {
    $rules = Get-NetFirewallApplicationFilter -Program $program -ErrorAction SilentlyContinue |
        Get-NetFirewallRule | Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' }
    foreach ($r in $rules) {
        Write-Host "刪除封鎖規則：$($r.DisplayName)（$($r.Profile)）$program"
        $r | Remove-NetFirewallRule
    }
    if (-not $rules) { Write-Host "沒有封鎖規則：$program" }
}

function Add-TelloRule($name, $program) {
    Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    $rule = @{
        DisplayName   = $name
        Direction     = 'Inbound'
        Action        = 'Allow'
        Protocol      = 'UDP'
        LocalPort     = @(8890, 11111)
        RemoteAddress = '192.168.10.0/24'
        Profile       = 'Any'
    }
    if ($program) { $rule.Program = $program }
    New-NetFirewallRule @rule | Out-Null
    Write-Host "已新增允許規則：$name $program"
}

# 原生模式：實際執行的是「基底」python.exe（venv 的 python.exe 只是啟動器）
$venvPy = Join-Path $PSScriptRoot '..\.venv\Scripts\python.exe'
$pyExe = if (Test-Path $venvPy) { $venvPy } else { 'python' }
$base = & $pyExe -c "import sys; print(getattr(sys, '_base_executable', sys.executable))" 2>$null
if ($base -and (Test-Path $base)) {
    Remove-BlockRules $base
    Add-TelloRule 'Tello GCS (python)' $base
}
else { Write-Host '找不到 python，略過原生模式規則' }

# Docker 模式：由 Docker Desktop 的 com.docker.backend.exe 轉發
$docker = Join-Path $env:ProgramFiles 'Docker\Docker\resources\com.docker.backend.exe'
if (Test-Path $docker) {
    Remove-BlockRules $docker
    Add-TelloRule 'Tello GCS (Docker backend)' $docker
}
else { Write-Host '找不到 Docker Desktop，略過 Docker 規則' }

Write-Host ''
Write-Host '完成。請重新啟動地面站，然後打開 http://localhost:8080/diag 確認狀態封包每秒約 10 個。'
