param([Parameter(Mandatory=$true)][string]$Installer, [string]$Publisher = 'BRIDGEMIND LLC')
$ErrorActionPreference = 'Stop'
function Assert-Signature([string]$Path) {
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne 'Valid' -or -not $signature.TimeStamperCertificate) { throw "Missing valid timestamped signature: $Path" }
    $name = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
    if ($name -cne $Publisher) { throw "Unexpected publisher: $name" }
}
Assert-Signature $Installer
$destination = Join-Path $env:RUNNER_TEMP 'BridgeClip installed acceptance'
if (Test-Path $destination) { throw 'Installation directory already exists' }
$process = Start-Process -FilePath (Resolve-Path $Installer) -ArgumentList @('/S', "/D=$destination") -Wait -PassThru
if ($process.ExitCode -ne 0) { throw 'NSIS installation failed' }
$application = Join-Path $destination 'BridgeClip.exe'
Assert-Signature $application
Assert-Signature (Join-Path $destination 'Uninstall BridgeClip.exe')
$expected = (Get-Content package.json -Raw | ConvertFrom-Json).version
$actual = (Get-Item $application).VersionInfo.ProductVersion
# Windows PE version resources use four numeric components; npm semver uses three.
# Accept only the same version with an optional zero revision.
if ($actual -ne $expected -and $actual -ne "$expected.0") {
    throw "Installed version mismatch: expected $expected, found $actual"
}
python scripts/release/verify-runtime.py (Join-Path $destination 'resources')
if ($LASTEXITCODE -ne 0) { throw 'Installed runtime verification failed' }
$probe = Start-Process -FilePath $application -ArgumentList "--user-data-dir=`"$env:RUNNER_TEMP\bridgeclip-acceptance-profile`"" -PassThru
Start-Sleep -Seconds 8
$probe.Refresh()
if ($probe.HasExited) { throw 'Installed app exited during startup' }
Stop-Process -Id $probe.Id -Force
$record = @{ platform='windows'; publisher=$Publisher; version=$expected; signature='Valid'; installed=$true; sha256=(Get-FileHash $Installer -Algorithm SHA256).Hash.ToLower() }
$record | ConvertTo-Json | Set-Content dist/verification-windows-x64.json
