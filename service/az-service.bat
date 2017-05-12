@echo off
setlocal

SET PYTHONPATH=%~dp0;%PYTHONPATH%
%1 -m azservice %*

endlocal