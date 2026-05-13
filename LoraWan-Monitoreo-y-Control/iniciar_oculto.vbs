Set WshShell = CreateObject("WScript.Shell")
' Obtener la ruta de la carpeta actual
strPath = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
' Ejecutar el servidor de forma invisible (el 0 al final oculta la ventana)
WshShell.Run "cmd /c cd /d """ & strPath & """ && npm run dev", 0, False
' Esperar 5 segundos para que cargue el servidor
WScript.Sleep 5000
' Abrir el navegador en la dirección local
WshShell.Run "http://localhost:5173"
