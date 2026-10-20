# Serves Aerophone Companion on http://localhost:8642 and opens it in Edge/Chrome.
$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot 'app'
$port = 8642
$prefix = "http://localhost:$port/"
$types = @{ '.html'='text/html; charset=utf-8'; '.js'='text/javascript; charset=utf-8'; '.css'='text/css';
  '.json'='application/json'; '.png'='image/png'; '.gif'='image/gif'; '.svg'='image/svg+xml';
  '.ttf'='font/ttf'; '.woff2'='font/woff2'; '.otf'='font/otf'; '.csv'='text/csv; charset=utf-8';
  '.div'='text/html; charset=utf-8'; '.txt'='text/plain; charset=utf-8'; '.md'='text/plain; charset=utf-8' }

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)
try { $listener.Start() } catch {
  Write-Host "Port $port is busy - the editor may already be running. Opening it." ; Start-Process $prefix ; exit
}
Write-Host "Aerophone Companion running at $prefix"
Write-Host "Keep this window open while you use the editor. Close it to stop."

$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
$chrome = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
$open = $prefix
if (Test-Path $chrome) { Start-Process $chrome "--app=$open" }
elseif (Test-Path $edge) { Start-Process $edge "--app=$open" }
else { Start-Process $open }

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $res = $ctx.Response
  try {
    $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
    if ($rel -eq '') { $rel = 'index.html' }
    $path = [IO.Path]::GetFullPath((Join-Path $root $rel))
    if (Test-Path $path -PathType Container) { $path = Join-Path $path 'index.html' }
    if (-not $path.StartsWith([IO.Path]::GetFullPath($root)) -or -not (Test-Path $path -PathType Leaf)) {
      $res.StatusCode = 404
    } else {
      $ext = [IO.Path]::GetExtension($path).ToLower()
      $res.ContentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' }
      $res.Headers.Add('Cache-Control', 'no-cache')
      $bytes = [IO.File]::ReadAllBytes($path)
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    }
  } catch { $res.StatusCode = 500 }
  finally { $res.Close() }
}
