@echo off
title Syscom IoT Platform
echo.
echo  ================================================
echo   SYSCOM IoT Platform - Iniciando...
echo  ================================================
echo.

:: Instalar dependencias del servidor si no existen
if not exist "server\node_modules" (
  echo  Instalando dependencias del servidor...
  cd server
  npm install
  cd ..
)

:: Iniciar servidor backend en segundo plano
echo  Iniciando servidor backend (puerto 3001)...
start "Syscom IoT Server" cmd /k "cd server && node server.js"

:: Esperar 2 segundos
timeout /t 2 /nobreak >nul

:: Iniciar app React
echo  Iniciando aplicacion web (puerto 5173)...
start "Syscom IoT App" cmd /k "npm run dev"

:: Iniciar Tunnelmole
echo  Iniciando Tunel Publico (Webhook)...
start "Syscom IoT Webhook Web" cmd /k "npx tunnelmole 3001"

:: Esperar 3 segundos y abrir navegador
timeout /t 3 /nobreak >nul
start http://localhost:5173

echo.
echo  ================================================
echo   Plataforma iniciada correctamente
echo   Abre: http://localhost:5173
echo  ================================================
