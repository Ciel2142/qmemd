@echo off
bun "%~dp0..\dist\cli\qmemd.js" %*
exit /b %ERRORLEVEL%
