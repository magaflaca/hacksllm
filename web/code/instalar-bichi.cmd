@echo off
rem Instalador de bichi code: doble clic y listo. Descarga y ejecuta install.ps1 de llm.hacks.win.
title instalando bichi code
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://llm.hacks.win/code/install.ps1 | iex"
echo.
pause
