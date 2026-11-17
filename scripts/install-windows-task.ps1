param(
  [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'YourBestMeter'),
  [string]$PublishEndpoint = '',
  [ValidateSet('ed25519','bearer')][string]$CredentialMode = 'ed25519',
  [switch]$Enable,
  [switch]$StartNow
)
$ErrorActionPreference = 'Stop'
$meterSource = Split-Path $PSScriptRoot -Parent
$meterNode = (Get-Command node -ErrorAction Stop).Source
$meterTaskName = 'YourBestMeter-LocalCollection'
$meterConfigPath = Join-Path $InstallDirectory 'config.json'
$meterMarkerPath = Join-Path $InstallDirectory 'managed-task.json'
if ($PublishEndpoint -and (([Uri]$PublishEndpoint).Scheme -ne 'https')) { throw 'An HTTPS publication endpoint is required.' }
$meterExisting = Get-ScheduledTask -TaskName $meterTaskName -ErrorAction SilentlyContinue
if ($meterExisting -and -not (Test-Path -LiteralPath $meterMarkerPath)) { throw 'A task with this name already exists and is not managed by this installer.' }
New-Item -ItemType Directory -Path $InstallDirectory -Force | Out-Null
foreach ($meterPart in @('cli','lib')) {
  $meterFrom = Join-Path $meterSource $meterPart
  $meterTo = Join-Path $InstallDirectory $meterPart
  if ([IO.Path]::GetFullPath($meterFrom) -ne [IO.Path]::GetFullPath($meterTo)) { Copy-Item -LiteralPath $meterFrom -Destination $InstallDirectory -Recurse -Force }
}
$meterConfig = @{version=1;output='snapshot.json';publish_endpoint=$PublishEndpoint}
if ($CredentialMode -eq 'ed25519') { $meterConfig.signing_key_file='publish-key.dpapi' } else { $meterConfig.token_file='publish-token.dpapi' }
[IO.File]::WriteAllText($meterConfigPath,($meterConfig | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
$meterAction = New-ScheduledTaskAction -Execute $meterNode -Argument ('"'+(Join-Path $InstallDirectory 'cli\meter-task.mjs')+'" --config "'+$meterConfigPath+'"') -WorkingDirectory $InstallDirectory
$meterTrigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 5)
$meterSettings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
$meterPrincipal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$meterTask = New-ScheduledTask -Action $meterAction -Trigger $meterTrigger -Settings $meterSettings -Principal $meterPrincipal -Description 'YourBest METER / AUMARA: sanitized local AI usage snapshot every five minutes.'
Register-ScheduledTask -TaskName $meterTaskName -InputObject $meterTask -Force | Out-Null
if (-not $Enable) { Disable-ScheduledTask -TaskName $meterTaskName | Out-Null }
[IO.File]::WriteAllText($meterMarkerPath,(@{version=1;task_name=$meterTaskName;managed_by='yourbest-meter-collector'} | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
if ($StartNow -and $Enable) { Start-ScheduledTask -TaskName $meterTaskName }
[PSCustomObject]@{task_name=$meterTaskName;enabled=[bool]$Enable;interval_minutes=5;publishing_configured=[bool]$PublishEndpoint;credential_mode=$CredentialMode;credential_present=(Test-Path -LiteralPath (Join-Path $InstallDirectory $(if($CredentialMode -eq 'ed25519'){'publish-key.dpapi'}else{'publish-token.dpapi'})));install_directory=$InstallDirectory} | ConvertTo-Json -Compress
