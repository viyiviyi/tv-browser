#requires -Version 5.1
<#
  构建 APK。

  用法：
    powershell -File tools\build.ps1              # release（自签名，可直接装电视）
    powershell -File tools\build.ps1 -Variant debug
    powershell -File tools\build.ps1 -Clean
    powershell -File tools\build.ps1 -Test        # 顺带跑单元测试

  产物：dist\tv-browser-<版本>-<variant>.apk
#>
param(
  [ValidateSet('release', 'debug')]
  [string]$Variant = 'release',
  [switch]$Clean,
  [switch]$Test
)
$ErrorActionPreference = 'Stop'

# Gradle/Javac 是按 UTF-8 输出诊断信息的，控制台默认按 GBK 解会变成乱码
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$root  = Split-Path -Parent $PSScriptRoot
$cache = Join-Path $root 'tools-cache'

if (-not (Test-Path (Join-Path $cache 'jdk17\bin\java.exe'))) {
  throw "还没准备构建环境，先跑： powershell -File tools\setup-toolchain.ps1"
}

# 环境变量：Gradle 用这套 JDK / SDK；缓存也放在项目里，方便复现和清理
$env:JAVA_HOME          = Join-Path $cache 'jdk17'
$env:ANDROID_HOME       = Join-Path $cache 'android-sdk'
$env:ANDROID_SDK_ROOT   = $env:ANDROID_HOME
$env:GRADLE_USER_HOME   = Join-Path $cache 'gradle-home'
$env:PATH               = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:PATH"

Write-Host '== 1/4 打包导航脚本到 assets =='
& node (Join-Path $PSScriptRoot 'build-nav.mjs')
if ($LASTEXITCODE -ne 0) { throw '打包导航脚本失败' }

Write-Host '== 2/4 准备签名证书 =='
$ks = Join-Path $cache 'tvbrowser.keystore'
if (-not (Test-Path $ks)) {
  & (Join-Path $env:JAVA_HOME 'bin\keytool.exe') -genkeypair -v `
    -keystore $ks -alias tvbrowser -keyalg RSA -keysize 2048 -validity 10000 `
    -storepass tvbrowser2024 -keypass tvbrowser2024 `
    -dname 'CN=TvBrowser, OU=TV, O=Local, L=Local, ST=Local, C=CN'
  if ($LASTEXITCODE -ne 0) { throw '生成签名证书失败' }
  Write-Host "  已生成 $ks（口令 tvbrowser2024，要发布请换成自己的证书）"
} else {
  Write-Host "  复用已有证书 $ks"
}

Write-Host '== 3/4 Gradle 构建 =='
$gradle = Join-Path $cache 'gradle-8.7\bin\gradle.bat'
$tasks = @()
if ($Clean) { $tasks += 'clean' }
if ($Test)  { $tasks += 'testDebugUnitTest' }
$tasks += "assemble$($Variant.Substring(0,1).ToUpper() + $Variant.Substring(1))"

& $gradle -p $root --no-daemon --console=plain @tasks
if ($LASTEXITCODE -ne 0) { throw "Gradle 构建失败（$($tasks -join ' ')）" }

Write-Host '== 4/4 收集产物 =='
$apkDir = Join-Path $root "app\build\outputs\apk\$Variant"
$apk = Get-ChildItem $apkDir -Filter '*.apk' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $apk) { throw "没找到 APK：$apkDir" }

$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$version = 'x'
$m = Select-String -Path (Join-Path $root 'app\build.gradle') -Pattern "versionName '([^']+)'"
if ($m) { $version = $m.Matches[0].Groups[1].Value }
$out = Join-Path $dist "tv-browser-$version-$Variant.apk"
Copy-Item $apk.FullName $out -Force

$size = [math]::Round((Get-Item $out).Length / 1KB, 1)
Write-Host ''
Write-Host "APK: $out  ($size KB)"
Write-Host ''
Write-Host '安装到电视（电视上先打开「开发者选项 → USB/网络调试」）：'
Write-Host "  $env:ANDROID_HOME\platform-tools\adb.exe connect <电视IP>:5555"
Write-Host "  $env:ANDROID_HOME\platform-tools\adb.exe install -r `"$out`""
Write-Host '或者把 APK 拷到 U 盘插到电视上，用文件管理器安装。'
exit 0
