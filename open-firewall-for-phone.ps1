# Run this script as Administrator to allow your phone to reach the CTU dev server.
# Right-click this file → "Run with PowerShell" (or open PowerShell as Admin and run it).

$port = 5500
$ruleName = "CTU Dev Server (port $port)"

# Remove old rule if it exists
Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue

# Add inbound allow rule for the dev server port
New-NetFirewallRule `
  -DisplayName  $ruleName `
  -Direction    Inbound `
  -Protocol     TCP `
  -LocalPort    $port `
  -Action       Allow `
  -Profile      Any

Write-Host ""
Write-Host "✓ Firewall rule added. Your phone can now reach the game at:" -ForegroundColor Green
Write-Host ""
Write-Host "  http://192.168.4.51:$port" -ForegroundColor Cyan
Write-Host ""
Write-Host "Make sure your phone is on the SAME Wi-Fi network as this laptop." -ForegroundColor Yellow
Write-Host "Press any key to close..."
$null = $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
