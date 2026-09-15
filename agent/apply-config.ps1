# AntiPrint print agent - write the answers of install-agent.bat into config.json.
# Values are passed through environment variables (CFG_SERVER / CFG_TOKEN / CFG_PRINTER) so the
# caller does not have to quote them; an empty value keeps the current field untouched.
# NOTE: keep this file ASCII-only (PowerShell 5.1 reads non-BOM files as ANSI).
param([Parameter(Mandatory = $true)][string]$ConfigPath)

$ErrorActionPreference = 'Stop'

function Set-Field($config, $name, $value) {
  $text = ''
  if ($value) { $text = $value.Trim() }
  if (-not $text) { return $config }
  if ($name -eq 'server') { $text = $text.TrimEnd('/') }
  if ($config.PSObject.Properties.Name -contains $name) {
    $config.$name = $text
  } else {
    $config | Add-Member -NotePropertyName $name -NotePropertyValue $text
  }
  return $config
}

try {
  $cfg = Get-Content -Raw -Encoding UTF8 $ConfigPath | ConvertFrom-Json
} catch {
  Write-Host ('[ERROR] config.json is not valid JSON: ' + $_.Exception.Message)
  exit 1
}

$cfg = Set-Field $cfg 'server' $env:CFG_SERVER
$cfg = Set-Field $cfg 'agent_token' $env:CFG_TOKEN
$cfg = Set-Field $cfg 'printer_name' $env:CFG_PRINTER

$tokenLength = 0
if ($cfg.agent_token) { $tokenLength = $cfg.agent_token.Length }
Write-Host ('[INFO] config.json -> server={0} printer={1} token={2} chars' -f $cfg.server, $cfg.printer_name, $tokenLength)
if ($cfg.agent_token -notmatch '^[A-Za-z0-9_\-]{16,}$') {
  Write-Host '[WARN] agent_token still looks like the template text - copy it from the server admin settings page.'
}

try {
  $cfg | ConvertTo-Json -Depth 8 | Set-Content -Path $ConfigPath -Encoding UTF8
} catch {
  Write-Host ('[ERROR] could not write config.json: ' + $_.Exception.Message)
  exit 1
}
exit 0
