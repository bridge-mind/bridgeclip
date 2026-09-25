$ErrorActionPreference = 'Stop'
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $installation) { throw 'Visual C++ build tools are required' }
$developer = Join-Path $installation 'Common7\Tools\VsDevCmd.bat'
$command = "`"$developer`" -arch=x64 && cl /nologo /O2 /MT /W4 /WX scripts\release\yt-dlp-launcher.c /Fe:engine-bin\yt-dlp.exe /Fo:engine-bin\yt-dlp.obj /link /SUBSYSTEM:CONSOLE"
& cmd.exe /d /s /c $command
if ($LASTEXITCODE -ne 0) { throw 'Could not build relocatable yt-dlp launcher' }
Remove-Item engine-bin/yt-dlp.obj
