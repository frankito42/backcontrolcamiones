@echo off
cd /d "%~dp0"
if not exist .env (
    echo Falta backend-node\.env. Copia .env.example y completa MYSQL_*.
    pause
    exit /b 1
)
npm start
pause