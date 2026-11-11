# Export every lender contact from PRODUCTION DocLocker to Excel (read-only).
# Runs the query inside the Railway backend container (the database has no
# public address), then builds the sheet locally with export-lenders.js.
#
#   cd Backend
#   powershell -ExecutionPolicy Bypass -File scripts\export-lenders-prod.ps1 [-Out file.xlsx]
#
# One-time setup on a new machine (Railway CLI, signed in, project linked):
#   ssh-keygen -t ed25519
#   railway ssh keys add
#   railway ssh config --service DocLocker_Backend --alias doclocker-backend -i ~/.ssh/id_ed25519
#   ssh -o StrictHostKeyChecking=accept-new doclocker-backend echo ok
# The sheet is INTERNAL ONLY - do not forward outside the team.
param([string]$Out = (Join-Path ([Environment]::GetFolderPath("Desktop")) "DocLocker_Lenders.xlsx"))
$ErrorActionPreference = "Stop"
Set-Location (Split-Path $PSScriptRoot -Parent)

# Read-only SELECT of lender logins: no password hashes, no student data.
$js = 'const {query,closeDb}=require("/app/src/db");query("SELECT a.name,a.email,a.bank,a.status,a.last_login_at,a.created_at,o.name AS company FROM accounts a JOIN organizations o ON o.id=a.org_id WHERE a.role=$1 ORDER BY a.bank NULLS LAST,a.name",["banker"]).then(r=>console.log("@@JSON@@"+JSON.stringify(r.rows))).catch(e=>console.log("@@ERR@@"+e.message)).finally(()=>closeDb())'
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($js))
$tmp = Join-Path $env:TEMP "doclocker-lenders.json"

Write-Host "Reading lenders from production (read-only)..."
# Railway prints progress on stderr; Windows PowerShell would treat that as
# a fatal error under "Stop", so relax it for this one call.
$ErrorActionPreference = "Continue"
# Uses the "doclocker-backend" host from ~/.ssh/config (railway ssh config).
$raw = ssh -o BatchMode=yes doclocker-backend "cd /app && echo $b64 | base64 -d > /tmp/exl.js && node /tmp/exl.js; rm -f /tmp/exl.js" 2>&1 | Out-String
$ErrorActionPreference = "Stop"
$err = [regex]::Match($raw, "@@ERR@@(.*)")
if ($err.Success) { throw "Query failed: $($err.Groups[1].Value)" }
$m = [regex]::Match($raw, "@@JSON@@(\[.*\])")
if (-not $m.Success) { Write-Host $raw; throw "No data came back from Railway (see output above)." }

try {
  Set-Content -Path $tmp -Value $m.Groups[1].Value -Encoding utf8
  $env:LENDERS_JSON = $tmp
  node scripts/export-lenders.js $Out
} finally {
  Remove-Item $tmp -ErrorAction SilentlyContinue
  Remove-Item Env:\LENDERS_JSON -ErrorAction SilentlyContinue
}
Write-Host "Done. Open $Out - internal only, do not forward outside the team."
