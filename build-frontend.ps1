# build-frontend.ps1 - 本地构建前端并同步到 frontend-dist
#
# 用法:
#   .\build-frontend.ps1                     # 使用默认前端路径 ../HammyBox-Frontend
#   .\build-frontend.ps1 -FrontendPath D:\path\to\frontend
#
# 前置: 前端仓库已 clone, 且已安装 pnpm (corepack enable 或已全局安装)

param(
    [string]$FrontendPath = (Join-Path $PSScriptRoot '..\HammyBox-Frontend')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path (Join-Path $FrontendPath 'package.json'))) {
    Write-Error "未找到前端项目: $FrontendPath (不存在 package.json)"
    exit 1
}

Write-Host "=== 1/3 构建前端: $FrontendPath ===" -ForegroundColor Cyan
Push-Location $FrontendPath
try {
    pnpm run build
    if ($LASTEXITCODE -ne 0) {
        throw "前端构建失败 (exit $LASTEXITCODE)"
    }
}
finally {
    Pop-Location
}

Write-Host "=== 2/3 同步 dist -> frontend-dist ===" -ForegroundColor Cyan
$distPath = Join-Path $FrontendPath 'dist'
$targetPath = Join-Path $PSScriptRoot 'frontend-dist'

if (-not (Test-Path $distPath)) {
    Write-Error "前端构建产物目录不存在: $distPath (请检查前端 vite 的 outDir 配置)"
    exit 1
}

# 清空目标目录再复制, 避免残留旧 hashed 文件
if (Test-Path $targetPath) {
    Remove-Item -Recurse -Force $targetPath
}
Copy-Item -Recurse $distPath $targetPath

Write-Host "=== 3/3 完成 ===" -ForegroundColor Green
Write-Host "frontend-dist 已更新: $targetPath"
