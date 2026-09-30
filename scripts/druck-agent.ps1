# KRNL Druckbruecke - Agent fuer Windows, OHNE Node.js (PowerShell 5.1,
# auf jedem Windows 10/11 vorhanden).
#
# Holt offene Druckauftraege der KRNL-Instanz ab (Pull ueber HTTPS - die
# App erreicht den LAN-Drucker nie), druckt die PDFs still mit SumatraPDF
# und quittiert. Ist SumatraPDF nicht installiert, laedt das Skript beim
# ersten Start einmalig die portable Version in diesen Ordner (Pruefsumme
# fest hinterlegt) - installiert wird nichts.
#
# Alle Werte kommen aus druckbruecke-starten.cmd (Umgebungsvariablen):
#   KRNL_URL, DRUCK_AGENT_TOKEN, DRUCK_DRUCKER_ID, DRUCKER,
#   (Alt-Betrieb ohne Drucker-ID: DRUCK_ZIELE, DRUCK_AGENT_NAME)
#   optional DRUCK_SUMATRA = Pfad zu einer vorhandenen SumatraPDF.exe
#
# EIN Agent bedient EINEN Drucker; Etiketten werden eingepasst (fit),
# A4 nur verkleinert, wenn noetig (shrink). Je Abruf genau ein Auftrag
# (limit=1): Windows PowerShell liest grosse JSON-Antworten sonst nicht.
#
# Doku: docs/module/versand.md -> "Druckbruecke". Gegenstueck fuer
# Linux/macOS: druck-agent.ts (Node).

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$Url = ('' + $env:KRNL_URL).Trim().TrimEnd('/')
$Token = ('' + $env:DRUCK_AGENT_TOKEN).Trim()
$Drucker = ('' + $env:DRUCKER).Trim()
$DruckerId = ('' + $env:DRUCK_DRUCKER_ID).Trim()
$Ziele = ('' + $env:DRUCK_ZIELE).Trim()
$Name = ('' + $env:DRUCK_AGENT_NAME).Trim()
$Intervall = 3

if (-not $Url -or -not $Token) {
  Write-Host 'KRNL_URL und DRUCK_AGENT_TOKEN muessen gesetzt sein (druckbruecke-starten.cmd).'
  exit 1
}

$Ordner = Split-Path -Parent $MyInvocation.MyCommand.Path
$SumatraUrl = 'https://www.sumatrapdfreader.org/dl/rel/3.5.2/SumatraPDF-3.5.2-64.zip'
$SumatraSha256 = '66CCB395C9184DCE6822DFBB9970C877383B3EAD6D9417B5106A844AAC512989'

# --- JSON: Windows PowerShell 5.1 begrenzt ConvertFrom-Json auf ~2 MB -----
$Serializer = $null
try {
  Add-Type -AssemblyName System.Web.Extensions
  $Serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
  $Serializer.MaxJsonLength = [int]::MaxValue
} catch {
  $Serializer = $null
}

function Lies-Json([string]$text) {
  if ($Serializer) { return $Serializer.DeserializeObject($text) }
  return ($text | ConvertFrom-Json -AsHashtable)
}

function Schreib-Json($wert) {
  if ($Serializer) { return $Serializer.Serialize($wert) }
  return ($wert | ConvertTo-Json -Compress)
}

# --- SumatraPDF finden oder portabel holen -------------------------------
function Finde-Sumatra {
  $kandidaten = @()
  if ($env:DRUCK_SUMATRA) { $kandidaten += $env:DRUCK_SUMATRA }
  $kandidaten += (Join-Path $Ordner 'SumatraPDF.exe')
  if ($env:LOCALAPPDATA) { $kandidaten += (Join-Path $env:LOCALAPPDATA 'SumatraPDF\SumatraPDF.exe') }
  if ($env:ProgramFiles) { $kandidaten += (Join-Path $env:ProgramFiles 'SumatraPDF\SumatraPDF.exe') }
  if (${env:ProgramFiles(x86)}) { $kandidaten += (Join-Path ${env:ProgramFiles(x86)} 'SumatraPDF\SumatraPDF.exe') }
  foreach ($k in $kandidaten) {
    if ($k -and (Test-Path -LiteralPath $k)) { return $k }
  }
  return $null
}

function Hole-Sumatra {
  if (-not [Environment]::Is64BitOperatingSystem) {
    throw 'SumatraPDF fehlt: bitte von https://www.sumatrapdfreader.org installieren (32-Bit-Windows).'
  }
  Write-Host 'SumatraPDF (portabel) wird einmalig in diesen Ordner geladen ...'
  $zip = Join-Path $Ordner 'SumatraPDF.zip'
  Invoke-WebRequest -Uri $SumatraUrl -OutFile $zip -UseBasicParsing
  $hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
  if ($hash -ne $SumatraSha256) {
    Remove-Item -LiteralPath $zip -Force
    throw "SumatraPDF-Download hat eine unerwartete Pruefsumme ($hash) - abgebrochen."
  }
  $entpackt = Join-Path $Ordner 'SumatraPDF-entpackt'
  if (Test-Path -LiteralPath $entpackt) { Remove-Item -LiteralPath $entpackt -Recurse -Force }
  Expand-Archive -LiteralPath $zip -DestinationPath $entpackt -Force
  $exe = Get-ChildItem -LiteralPath $entpackt -Filter 'SumatraPDF*.exe' | Select-Object -First 1
  if (-not $exe) { throw 'Im SumatraPDF-Archiv fehlt die Programmdatei.' }
  $ziel = Join-Path $Ordner 'SumatraPDF.exe'
  Move-Item -LiteralPath $exe.FullName -Destination $ziel -Force
  Remove-Item -LiteralPath $entpackt -Recurse -Force
  Remove-Item -LiteralPath $zip -Force
  Write-Host 'SumatraPDF bereit.'
  return $ziel
}

$Sumatra = Finde-Sumatra
if (-not $Sumatra) { $Sumatra = Hole-Sumatra }

# --- Abholen, drucken, quittieren ----------------------------------------
$Kopf = @{ Authorization = "Bearer $Token" }
$Abfrage = @()
if ($DruckerId) {
  $Abfrage += 'drucker=' + [uri]::EscapeDataString($DruckerId)
} else {
  if ($Ziele) { $Abfrage += 'ziele=' + [uri]::EscapeDataString($Ziele) }
  if ($Name) { $Abfrage += 'name=' + [uri]::EscapeDataString($Name) }
}
$Abfrage += 'limit=1'
$AbholUrl = "$Url/api/druck/abholen?" + ($Abfrage -join '&')

function Sicherer-Dateiname([string]$roh) {
  $s = ('' + $roh) -replace '[^A-Za-z0-9._-]', '_'
  if (-not $s) { $s = 'druck' }
  if ($s -notmatch '\.pdf$') { $s += '.pdf' }
  return $s
}

function Drucke([string]$datei, [string]$typ) {
  $skalierung = 'shrink'
  if ($typ -eq 'label') { $skalierung = 'fit' }
  if ($Drucker) { $ziel = '-print-to "' + $Drucker + '"' } else { $ziel = '-print-to-default' }
  $argumente = $ziel + ' -print-settings ' + $skalierung + ' -silent "' + $datei + '"'
  $start = @{ FilePath = $Sumatra; ArgumentList = $argumente; PassThru = $true }
  if ([Environment]::OSVersion.Platform -eq 'Win32NT') { $start['WindowStyle'] = 'Hidden' }
  $p = Start-Process @start
  if (-not $p.WaitForExit(60000)) {
    try { $p.Kill() } catch { }
    throw 'SumatraPDF antwortet nicht (60 s) - Drucker pruefen.'
  }
  if ($p.ExitCode -ne 0) { throw ('SumatraPDF meldet Fehler ' + $p.ExitCode + ' - Druckername pruefen: "' + $Drucker + '"') }
}

function Quittiere($id, [bool]$ok, [string]$fehler) {
  $koerper = @{ id = $id; ok = $ok }
  if ($fehler) { $koerper['fehler'] = $fehler }
  $bytes = [Text.Encoding]::UTF8.GetBytes((Schreib-Json $koerper))
  Invoke-WebRequest -Uri "$Url/api/druck/quittieren" -Method Post -Headers $Kopf `
    -ContentType 'application/json; charset=utf-8' -Body $bytes -UseBasicParsing -TimeoutSec 60 | Out-Null
}

function Runde {
  $antwort = Invoke-WebRequest -Uri $AbholUrl -Headers $Kopf -UseBasicParsing -TimeoutSec 60
  $daten = Lies-Json $antwort.Content
  $jobs = $daten['jobs']
  if ($null -eq $jobs) { return 0 }
  $anzahl = 0
  foreach ($job in $jobs) {
    $anzahl++
    $verzeichnis = Join-Path ([IO.Path]::GetTempPath()) ('krnl-druck-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $verzeichnis | Out-Null
    $datei = Join-Path $verzeichnis (Sicherer-Dateiname $job['dateiname'])
    $ok = $true
    $fehler = ''
    try {
      [IO.File]::WriteAllBytes($datei, [Convert]::FromBase64String($job['pdfBase64']))
      Drucke $datei $job['druckerTyp']
      Write-Host ('[' + (Get-Date -Format s) + '] gedruckt: ' + $job['dateiname'])
    } catch {
      $ok = $false
      $fehler = $_.Exception.Message
      Write-Host ('[' + (Get-Date -Format s) + '] FEHLER ' + $job['dateiname'] + ': ' + $fehler)
    } finally {
      Remove-Item -LiteralPath $verzeichnis -Recurse -Force -ErrorAction SilentlyContinue
    }
    Quittiere $job['id'] $ok $fehler
  }
  return $anzahl
}

# Verstaendliche Stoerungen statt HTTP-Rohtext (PowerShell 5.1 und 7).
function Stoerungs-Text($fehler) {
  $code = 0
  try { $code = [int]$fehler.Exception.Response.StatusCode } catch { $code = 0 }
  if ($code -eq 401) { return 'Agent-Token ungueltig - Paket unter Einstellungen -> Arbeitsplaetze -> Drucker neu laden' }
  if ($code -eq 404) { return 'Drucker in KRNL unbekannt - Paket unter Einstellungen -> Arbeitsplaetze -> Drucker neu laden' }
  return $fehler.Exception.Message
}

$wer = if ($DruckerId) { 'Drucker-ID ' + $DruckerId } else { 'Ziele: ' + $(if ($Ziele) { $Ziele } else { 'alle' }) }
$wohin = if ($Drucker) { $Drucker } else { 'Standarddrucker' }
Write-Host ('Druckbruecke aktiv - ' + $Url + ', ' + $wer + ', Drucker: ' + $wohin)
Write-Host ('SumatraPDF: ' + $Sumatra)

$stoerungGemeldet = $false
while ($true) {
  try {
    # Solange Auftraege kommen, sofort weiterfragen; sonst im Takt.
    $anzahl = Runde
    $stoerungGemeldet = $false
    if ($anzahl -gt 0) { continue }
  } catch {
    if (-not $stoerungGemeldet) {
      Write-Host ('Stoerung: ' + (Stoerungs-Text $_) + ' - versuche weiter')
      $stoerungGemeldet = $true
    }
  }
  Start-Sleep -Seconds $Intervall
}
