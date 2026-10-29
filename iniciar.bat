@echo off
cd /d "%~dp0"
if not exist .env (
    echo Falta backend-node\.env. Copia .env.example y completa DATABASE_URL.
    pause
    exit /b 1
)
npm start
pause