@echo off
rem Start the overlay server on Windows. Prints the panel login link and the OBS address.
rem Needs Deno (https://deno.com): in PowerShell,  irm https://deno.land/install.ps1 | iex   then open a new window.
cd /d "%~dp0"
where deno >nul 2>nul
if errorlevel 1 (
  echo Deno is not installed, or this window was open before it was. See README.md, "What you need".
  pause
  exit /b 1
)
deno run --allow-net --allow-env --allow-read=. --allow-write=data server/main.ts
pause
