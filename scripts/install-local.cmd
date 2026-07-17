@echo off
setlocal
if defined QODER_OTEL_NODE (
  set "NODE_EXE=%QODER_OTEL_NODE%"
) else (
  set "NODE_EXE=node"
)
"%NODE_EXE%" "%~dp0install-local.mjs" %*
exit /b %ERRORLEVEL%
