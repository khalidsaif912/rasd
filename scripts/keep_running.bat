@echo off
cd /d "%~dp0.."
:again
netstat -ano | findstr ":8777" | findstr "LISTENING" >nul
if %errorlevel%==0 (
  timeout /t 30 /nobreak >nul
  goto again
)
"C:\Users\PC\AppData\Local\Programs\Python\Python313\python.exe" server.py
timeout /t 15 /nobreak >nul
goto again
