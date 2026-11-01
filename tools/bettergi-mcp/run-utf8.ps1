param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$PayloadPath
)
# 由 MCP 服务器调用的通用启动器：
#   1) 把子 PowerShell 的输出编码固定为 UTF-8（中文稳定回传）；
#   2) 用**哈希表 splat** 调用目标脚本——PowerShell 里 `& $script @array` 是按位置传参，
#      只有 @hashtable 才会按参数名绑定（2026-10-16 实测踩到）。
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

if (-not (Test-Path -LiteralPath $PayloadPath)) { Write-Error "payload 不存在: $PayloadPath"; exit 2 }

try {
    $payload = Get-Content -LiteralPath $PayloadPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
    Write-Error "payload 解析失败: $($_.Exception.Message)"; exit 2
}

$scriptPath = [string]$payload.script
$rawArgs = @($payload.args)

$ht = @{}
for ($i = 0; $i -lt $rawArgs.Count; $i++) {
    $a = $rawArgs[$i]
    if ($a -is [string] -and $a.StartsWith('-')) {
        $key = $a.Substring(1)
        $hasNext = ($i + 1) -lt $rawArgs.Count
        if (-not $hasNext) { $ht[$key] = $true; continue }
        $next = $rawArgs[$i + 1]
        if ($next -is [string] -and $next.StartsWith('-')) {
            $ht[$key] = $true                     # 开关型参数
        } else {
            $ht[$key] = $next                     # 值型参数（保持 JSON 原始类型，数组原样传）
            $i++
        }
    }
}

try { Remove-Item -LiteralPath $PayloadPath -Force -ErrorAction SilentlyContinue } catch { }

if (-not (Test-Path -LiteralPath $scriptPath)) { Write-Error "目标脚本不存在: $scriptPath"; exit 2 }

& $scriptPath @ht
exit $LASTEXITCODE
