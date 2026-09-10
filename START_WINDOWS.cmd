@echo off
cd /d "%~dp0"
call pnpm install --frozen-lockfile
if errorlevel 1 goto failed
call pnpm start
exit /b
:failed
 echo Please install Node.js 24 and pnpm. See START_HERE_KO.md.
 pause
