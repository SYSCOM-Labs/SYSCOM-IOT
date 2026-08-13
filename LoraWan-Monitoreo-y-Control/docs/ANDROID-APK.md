# App Android (APK) — SYSCOM IoT Mobile

La app móvil reutiliza el mismo backend y el tablero BSD (`BudgetSensorsDashboard`) por dispositivo. Los usuarios inician sesión con correo y contraseña y ven el dashboard configurado en la plataforma web.

## Requisitos

- Node.js 20+
- [Android Studio](https://developer.android.com/studio) (SDK, platform-tools)
- Servidor SYSCOM IoT accesible desde la red del teléfono (HTTPS recomendado)
- En producción, `SYSCOM_CORS_ORIGINS` debe incluir orígenes Capacitor (el servidor ya añade `https://localhost` automáticamente si usa lista explícita)

## Probar en navegador (sin APK)

```powershell
cd LoraWan-Monitoreo-y-Control
npm run dev:mobile
```

Abra la URL de Vite; verá la UI móvil. Configure la URL del servidor en el login (ej. `http://192.168.1.50:3001` o `https://iot.empresa.com`).

## Generar APK de debug (instalable)

Si `npm install` falla con **ECONNRESET**, use el instalador alternativo (descarga tarballs uno por uno):

```powershell
cd LoraWan-Monitoreo-y-Control
npm run android:install-capacitor
```

Luego:

```powershell
npm run android:add
npm run android:sync
npm run android:open
```

**Nota:** No use `npx cap` si Capacitor no esta instalado — npm intenta descargar un paquete equivocado llamado `cap`. Los scripts del proyecto usan `@capacitor/cli` local (`npm run cap -- ...`).

Instalacion normal (si la red funciona):

```powershell
cd LoraWan-Monitoreo-y-Control
npm install
npm run android:add
npm run android:sync
npm run android:open
```

En Android Studio: **Build → Build Bundle(s) / APK(s) → Build APK(s)**.

El APK debug suele quedar en:

`android/app/build/outputs/apk/debug/app-debug.apk`

## APK de release (firma)

1. Cree un keystore (una sola vez):

```powershell
keytool -genkey -v -keystore syscom-iot-release.keystore -alias syscom -keyalg RSA -keysize 2048 -validity 10000
```

2. Configure `android/keystore.properties` (no subir al repositorio).

3. En Android Studio: **Build → Generate Signed Bundle / APK**.

## Configuración del servidor

La app llama a `https://SU-SERVIDOR/api/...`. Asegúrese de que:

- El puerto/API sea reachable desde el celular (firewall, TLS, DNS).
- Si usa HTTP en LAN, CORS permita orígenes Capacitor.
- Cada usuario ve solo dispositivos asignados (igual que la web).

## Flujo de usuario

1. Instalar APK.
2. Abrir app → indicar URL del servidor SYSCOM.
3. Iniciar sesión (misma cuenta que la web).
4. Lista de dispositivos → tocar uno → tablero BSD (downlinks si están configurados).

## Scripts npm

| Script | Descripción |
|--------|-------------|
| `npm run dev:mobile` | Vite en modo app móvil |
| `npm run build:mobile` | Build producción móvil |
| `npm run android:sync` | Build + copiar a proyecto Android |
| `npm run android:open` | Abrir Android Studio |
