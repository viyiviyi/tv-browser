#requires -Version 5.1
<#
  一次性准备 Android 构建环境（不需要 Android Studio）。

  国内网络下 dl.google.com / services.gradle.org / api.adoptium.net 基本连不上，
  所以这里全部走镜像：
    JDK       → repo.huaweicloud.com/openjdk
    Gradle    → mirrors.cloud.tencent.com/gradle
    SDK 包    → mirrors.cloud.tencent.com/AndroidSDK
  依赖（AGP 等）在构建时由 settings.gradle 指向 maven.aliyun.com。

  如果同一个工作区里的 bili-tv 已经准备过这套环境（500MB+），这里会直接
  用目录联接（junction）指过去共用，不再下一遍。

  跑完得到：
    tools-cache\jdk17\                       JDK 17
    tools-cache\gradle-8.7\                  Gradle
    tools-cache\android-sdk\                 Android SDK（platforms/android-34、build-tools/34.0.0）
    local.properties                         把 SDK 路径告诉 Gradle
#>
$ErrorActionPreference = 'Stop'

$root  = Split-Path -Parent $PSScriptRoot
$cache = Join-Path $root 'tools-cache'

# ---------------------------------------------------------------- 复用判断 --
# 同工作区的 bili-tv 里已经躺着一套完整的工具链就直接共用
$shared = Join-Path (Split-Path -Parent $root) 'bili-tv\tools-cache'
if (-not (Test-Path (Join-Path $cache 'jdk17\bin\java.exe')) `
    -and (Test-Path (Join-Path $shared 'jdk17\bin\java.exe'))) {
  Write-Host "复用 $shared"
  if (Test-Path $cache) { Remove-Item -Recurse -Force $cache }
  # /J 是目录联接，不需要管理员权限，删掉任一边都不影响另一边
  & cmd /c "mklink /J `"$cache`" `"$shared`"" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "建立目录联接失败：$cache → $shared" }
}

$sdk = Join-Path $cache 'android-sdk'
New-Item -ItemType Directory -Force -Path $cache, $sdk | Out-Null

$mirrors = @{
  jdk           = 'https://repo.huaweicloud.com/openjdk/17.0.2/openjdk-17.0.2_windows-x64_bin.zip'
  gradle        = 'https://mirrors.cloud.tencent.com/gradle/gradle-8.7-bin.zip'
  platform      = 'https://mirrors.cloud.tencent.com/AndroidSDK/platform-34-ext7_r03.zip'
  'build-tools' = 'https://mirrors.cloud.tencent.com/AndroidSDK/build-tools_r34-windows.zip'
  'platform-tools' = 'https://mirrors.cloud.tencent.com/AndroidSDK/platform-tools_r35.0.0-windows.zip'
}

function Get-MirrorFile([string]$name) {
  $url = $mirrors[$name]
  $out = Join-Path $cache "$name.zip"
  if ((Test-Path $out) -and (Get-Item $out).Length -gt 100000) {
    Write-Host "  [skip] $name.zip 已存在"
    return $out
  }
  Write-Host "  [get ] $url"
  # --ssl-no-revoke：本机 schannel 吊销检查会失败
  & curl.exe -sSL --ssl-no-revoke --retry 3 --retry-delay 2 -o $out $url
  if (-not (Test-Path $out) -or (Get-Item $out).Length -lt 100000) { throw "下载失败：$url" }
  return $out
}

function Expand-Zip([string]$zip, [string]$dest) {
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  # tar (bsdtar) 解 zip 比 Expand-Archive 快很多，且 Win10+ 自带
  & tar.exe -xf $zip -C $dest
  if ($LASTEXITCODE -ne 0) { throw "解压失败：$zip" }
}

function Move-SingleDir([string]$from, [string]$to) {
  if (Test-Path $to) { Remove-Item -Recurse -Force $to }
  Move-Item -Force $from $to
}

Write-Host '== JDK 17 =='
if (-not (Test-Path (Join-Path $cache 'jdk17\bin\java.exe'))) {
  $zip = Get-MirrorFile 'jdk'
  $tmp = Join-Path $cache '_jdk_tmp'
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
  Expand-Zip $zip $tmp
  $dir = Get-ChildItem $tmp -Directory | Select-Object -First 1
  Move-SingleDir $dir.FullName (Join-Path $cache 'jdk17')
  Remove-Item -Recurse -Force $tmp
}

Write-Host '== Gradle =='
if (-not (Test-Path (Join-Path $cache 'gradle-8.7\bin\gradle.bat'))) {
  $zip = Get-MirrorFile 'gradle'
  $tmp = Join-Path $cache '_gradle_tmp'
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
  Expand-Zip $zip $tmp
  $dir = Get-ChildItem $tmp -Directory | Select-Object -First 1
  Move-SingleDir $dir.FullName (Join-Path $cache 'gradle-8.7')
  Remove-Item -Recurse -Force $tmp
}

Write-Host '== Android SDK: platforms;android-34 =='
if (-not (Test-Path (Join-Path $sdk 'platforms\android-34\android.jar'))) {
  $zip = Get-MirrorFile 'platform'
  $tmp = Join-Path $cache '_plat_tmp'
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
  Expand-Zip $zip $tmp
  New-Item -ItemType Directory -Force -Path (Join-Path $sdk 'platforms') | Out-Null
  $dir = Get-ChildItem $tmp -Directory | Select-Object -First 1
  Move-SingleDir $dir.FullName (Join-Path $sdk 'platforms\android-34')
  Remove-Item -Recurse -Force $tmp
}

Write-Host '== Android SDK: build-tools;34.0.0 =='
if (-not (Test-Path (Join-Path $sdk 'build-tools\34.0.0\aapt2.exe'))) {
  $zip = Get-MirrorFile 'build-tools'
  $tmp = Join-Path $cache '_bt_tmp'
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
  Expand-Zip $zip $tmp
  New-Item -ItemType Directory -Force -Path (Join-Path $sdk 'build-tools') | Out-Null
  $dir = Get-ChildItem $tmp -Directory | Select-Object -First 1
  Move-SingleDir $dir.FullName (Join-Path $sdk 'build-tools\34.0.0')
  Remove-Item -Recurse -Force $tmp
}

Write-Host '== Android SDK: platform-tools (adb) =='
if (-not (Test-Path (Join-Path $sdk 'platform-tools\adb.exe'))) {
  $zip = Get-MirrorFile 'platform-tools'
  $tmp = Join-Path $cache '_pt_tmp'
  if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
  Expand-Zip $zip $tmp
  $dir = Get-ChildItem $tmp -Directory | Select-Object -First 1
  Move-SingleDir $dir.FullName (Join-Path $sdk 'platform-tools')
  Remove-Item -Recurse -Force $tmp
}

Write-Host '== 补齐 source.properties / licenses =='
# 手动铺 SDK 时这些元数据不会自动生成，AGP 靠它们判断版本号
$platProps = Join-Path $sdk 'platforms\android-34\source.properties'
if (-not (Test-Path $platProps)) {
  @'
Pkg.Desc=Android SDK Platform 34
Pkg.Revision=3
AndroidVersion.ApiLevel=34
AndroidVersion.ExtensionLevel=7
AndroidVersion.CodeName=UpsideDownCake
Platform.Version=14
Layoutlib.Api=34
Layoutlib.Revision=1
'@ | Set-Content -Path $platProps -Encoding ascii
}
$btProps = Join-Path $sdk 'build-tools\34.0.0\source.properties'
if (-not (Test-Path $btProps)) {
  @'
Pkg.Desc=Android SDK Build-Tools 34
Pkg.Revision=34.0.0
'@ | Set-Content -Path $btProps -Encoding ascii
}

# AGP 会检查许可证是否被接受；dl.google.com 连不上时 sdkmanager 用不了，直接写文件
$lic = Join-Path $sdk 'licenses'
New-Item -ItemType Directory -Force -Path $lic | Out-Null
@'
8933bad161af4178b1185d1a37fbf41ea5269c55
d56f5187479451eabf01fb78af6dfcb131a6481e
24333f8a63b6825ea9c5514f83c2829b004d1fee
'@ | Set-Content -Path (Join-Path $lic 'android-sdk-license') -Encoding ascii
'84831b9409646a918e30573bab4c9c91346d8abd' | Set-Content -Path (Join-Path $lic 'android-sdk-preview-license') -Encoding ascii

Write-Host '== local.properties =='
$sdkEscaped = $sdk -replace '\\', '\\'
"sdk.dir=$sdkEscaped" | Set-Content -Path (Join-Path $root 'local.properties') -Encoding ascii

Write-Host ''
Write-Host '== 检查 =='
# java -version 往 stderr 写版本号，PowerShell 会当成错误，这里单独容忍一下
$prev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& cmd /c "`"$(Join-Path $cache 'jdk17\bin\java.exe')`" -version 2>&1" | Select-Object -First 1
$ErrorActionPreference = $prev
Write-Host ("platform  : " + (Test-Path (Join-Path $sdk 'platforms\android-34\android.jar')))
Write-Host ("build-tool: " + (Test-Path (Join-Path $sdk 'build-tools\34.0.0\aapt2.exe')))
Write-Host ("adb       : " + (Test-Path (Join-Path $sdk 'platform-tools\adb.exe')))
Write-Host ("gradle    : " + (Test-Path (Join-Path $cache 'gradle-8.7\bin\gradle.bat')))
Write-Host '环境就绪。下一步： powershell -File tools\build.ps1'
