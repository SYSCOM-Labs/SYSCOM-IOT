'use strict';

/**
 * Respaldos diarios en disco del servidor NO bastan ante ransomware o borrado de la VM: el atacante
 * podría eliminar `server/data/` y los backups locales. Para copias fuera de la instancia / fuera de AWS:
 *
 * 1) Sin `SYSCOM_DB_BACKUP_SYNC_CMD`: si en Ajustes guardó una ruta **local o de montaje** (p. ej. `/mnt/nas/…`),
 *    tras cada respaldo se ejecuta una copia integrada (equivalente a `cp` del .db a esa carpeta).
 * 2) Con `SYSCOM_DB_BACKUP_SYNC_CMD`: comando shell con `$FILE` y `$NAS` (valor de Ajustes); prioridad sobre la copia integrada.
 * 2) Bucket S3 con versionado + política IAM distinta a la app, o cuenta AWS separada.
 * 3) Descarga manual periódica: Ajustes → Exportar (superadmin) y guardar el .db en PC/NAS no expuesto a la misma cuenta.
 * 4) AWS Backup / DataSync / tarea programada en otra máquina que baje por SCP el directorio de backups.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** Milisegundos hasta la próxima medianoche (hora local del proceso). */
function msUntilNextLocalMidnight() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  const ms = d.getTime() - Date.now();
  return Math.max(30_000, ms);
}

/**
 * Respaldos diarios del archivo SQLite (medianoche hora local del servidor).
 * `SYSCOM_DB_BACKUP_SCHEDULE=0` desactiva.
 * `SYSCOM_DB_BACKUP_DIR` carpeta destino (defecto: server/data/backups).
 * `SYSCOM_DB_BACKUP_KEEP_DAYS` retención (defecto: 14).
 * `SYSCOM_DB_BACKUP_SYNC_CMD` opcional: comando post-respaldo; `$FILE` y `$NAS` se sustituyen de forma segura para shell.
 */
function shellSingleQuoted(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function nasFromStore(store) {
  if (!store || typeof store.getServerSetting !== 'function') return '';
  return String(store.getServerSetting('backup_nas_destination') || '').trim();
}

/** Ruta de carpeta en este mismo servidor (p. ej. NAS montado con SMB/NFS). No usar para user@host: remoto sin montaje. */
function isLocalMountBackupPath(nasRaw) {
  const nas = String(nasRaw || '').trim();
  if (!nas || nas.includes('..') || nas.includes('\0')) return false;
  if (nas.includes('@')) return false;
  if (process.platform === 'win32') {
    return /^[A-Za-z]:[/\\]/.test(nas) || nas.startsWith('\\\\');
  }
  return nas.startsWith('/');
}

/** Copia integrada cuando no hay SYSCOM_DB_BACKUP_SYNC_CMD (equivalente a cp al directorio guardado). */
function tryBuiltinNasCopy(store, destPath) {
  const nas = nasFromStore(store);
  if (!nas) return;
  if (!isLocalMountBackupPath(nas)) {
    console.log(
      '[Syscom] Destino NAS guardado no es una ruta local/montaje (debe empezar por / en Linux o ser unidad \\\\ o C:\\ en Windows). Monte el NAS en el servidor o use SYSCOM_DB_BACKUP_SYNC_CMD con rsync/scp y $FILE / $NAS.'
    );
    return;
  }
  try {
    const dir = path.resolve(nas);
    ensureDir(dir);
    const target = path.join(dir, path.basename(destPath));
    fs.copyFileSync(destPath, target);
    console.log('[Syscom] Copia de respaldo a carpeta configurada (integrada, tipo cp):', target);
  } catch (e) {
    console.warn('[Syscom] Copia integrada a carpeta NAS falló:', e && e.message);
  }
}

function runPostBackupSync(store, destPath) {
  const nasFromDb = nasFromStore(store);
  const rawEnv = process.env.SYSCOM_DB_BACKUP_SYNC_CMD;

  if (rawEnv != null && String(rawEnv).trim()) {
    let cmd = String(rawEnv).trim();
    cmd = cmd.replace(/\$\{FILE\}/g, shellSingleQuoted(destPath)).replace(/\$FILE\b/g, shellSingleQuoted(destPath));
    if (nasFromDb) {
      cmd = cmd.replace(/\$\{NAS\}/g, shellSingleQuoted(nasFromDb)).replace(/\$NAS\b/g, shellSingleQuoted(nasFromDb));
    } else {
      if (/\$NAS\b|\$\{NAS\}/.test(cmd)) {
        console.warn(
          '[Syscom] SYSCOM_DB_BACKUP_SYNC_CMD usa $NAS pero no hay dirección en Ajustes; guarde la carpeta o quite $NAS del comando.'
        );
      }
      cmd = cmd.replace(/\$\{NAS\}/g, '').replace(/\$NAS\b/g, '');
    }
    const timeoutMs = Math.max(
      60_000,
      parseInt(String(process.env.SYSCOM_DB_BACKUP_SYNC_TIMEOUT_MS || '').trim(), 10) || 3_600_000
    );
    try {
      console.log('[Syscom] Ejecutando SYSCOM_DB_BACKUP_SYNC_CMD…');
      execSync(cmd, {
        stdio: 'inherit',
        timeout: timeoutMs,
        shell: true,
        env: { ...process.env, SYSCOM_BACKUP_FILE: destPath, SYSCOM_BACKUP_NAS_DEST: nasFromDb },
      });
      console.log('[Syscom] SYSCOM_DB_BACKUP_SYNC_CMD finalizado correctamente.');
    } catch (e) {
      console.warn('[Syscom] SYSCOM_DB_BACKUP_SYNC_CMD falló (el .db local sigue existiendo):', e && e.message);
    }
    return;
  }

  tryBuiltinNasCopy(store, destPath);
}

function scheduleDailyDatabaseBackup(store) {
  if (String(process.env.SYSCOM_DB_BACKUP_SCHEDULE || '1').trim() === '0') {
    console.log('[Syscom] Respaldo programado de BD desactivado (SYSCOM_DB_BACKUP_SCHEDULE=0).');
    return;
  }

  const DATA_DIR = path.join(__dirname, 'data');
  const backupDir =
    process.env.SYSCOM_DB_BACKUP_DIR != null && String(process.env.SYSCOM_DB_BACKUP_DIR).trim()
      ? String(process.env.SYSCOM_DB_BACKUP_DIR).trim()
      : path.join(DATA_DIR, 'backups');

  const keepDays = Math.max(1, parseInt(process.env.SYSCOM_DB_BACKUP_KEEP_DAYS || '14', 10) || 14);

  const run = () => {
    try {
      ensureDir(backupDir);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const dest = path.join(backupDir, `syscom-${stamp}.db`);
      store.exportDatabaseSnapshotToPath(dest);
      console.log('[Syscom] Respaldo diario de base de datos:', dest);
      runPostBackupSync(store, dest);

      let names = [];
      try {
        names = fs.readdirSync(backupDir);
      } catch (e) {
        return;
      }
      const cutoff = Date.now() - keepDays * 86400000;
      for (const n of names) {
        if (!/^syscom-.*\.db$/i.test(n)) continue;
        const p = path.join(backupDir, n);
        try {
          const st = fs.statSync(p);
          if (st.mtimeMs < cutoff) {
            fs.unlinkSync(p);
            console.log('[Syscom] Respaldo antiguo eliminado:', n);
          }
        } catch (e) {
          /* ignore */
        }
      }
    } catch (e) {
      console.warn('[Syscom] Respaldo diario de BD falló:', e && e.message);
    }
  };

  const delay = msUntilNextLocalMidnight();
  console.log(
    `[Syscom] Próximo respaldo automático de BD en ~${Math.round(delay / 60000)} min (medianoche, hora local del servidor).`
  );
  setTimeout(() => {
    run();
    setInterval(run, 24 * 60 * 60 * 1000);
  }, delay);
}

module.exports = { scheduleDailyDatabaseBackup };
