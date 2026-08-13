import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { getUsers, createUser, updateUser, deleteUser, getServerOrigin, getUserDevices } from '../services/localAuth';
import { unassignDeviceFromUser } from '../services/api';
import { validatePasswordStrength, PASSWORD_POLICY_HINT } from '../utils/passwordPolicy';
import {
  Users,
  Plus,
  Trash2,
  Shield,
  Eye,
  X,
  Loader,
  AlertCircle,
  CheckCircle2,
  Edit2,
  KeyRound,
  Save,
  Database,
  Play,
  UserPlus,
  LogIn,
  Mail,
} from 'lucide-react';
import { NAV_MODULE_DEFS } from '../config/navConfig';
import FormToast from '../components/FormToast';
import CenteredAlertModal from '../components/CenteredAlertModal';
import { getDuplicateEntityNotice } from '../utils/duplicateEntityNotice';
import './DeviceList.css';
import '../styles/premiumPageShell.css';
import './UserManagement.css';

const EMPTY_FORM = {
  email: '',
  password: '',
  confirmPassword: '',
  role: 'user',
  profileName: '',
  navPick: {},
};

function normalizeRole(r) {
  if (r === 'viewer') return 'user';
  if (r === 'superadmin' || r === 'admin' || r === 'user') return r;
  return 'user';
}

function defaultNavPickForNew(hasNavPage) {
  const pick = {};
  for (const { id } of NAV_MODULE_DEFS) {
    if (id === 'Templates') {
      pick[id] = false;
      continue;
    }
    if (['Dashboard', 'Devices', 'History', 'SpecialReport'].includes(id)) {
      pick[id] = hasNavPage(id);
    } else {
      pick[id] = false;
    }
  }
  return pick;
}

function mergeNavFromUser(u) {
  const n = u && u.nav && typeof u.nav === 'object' ? u.nav : {};
  const pick = {};
  for (const { id } of NAV_MODULE_DEFS) {
    pick[id] = Boolean(n[id]);
  }
  return pick;
}

/**
 * Orden en profundidad: superadmin ve bosques por raíz global; el resto ve su cuenta y descendientes.
 * @param {object[]} users
 * @param {string} currentUserId
 * @param {boolean} isSuperAdmin
 * @returns {{ u: object, depth: number }[]}
 */
function flattenUserTree(users, currentUserId, isSuperAdmin) {
  const list = Array.isArray(users) ? users : [];
  const byId = new Map(list.map((x) => [String(x.id), x]));
  const kids = new Map();
  for (const u of list) {
    const rawP = u.createdBy != null ? String(u.createdBy) : '';
    const pid = rawP && byId.has(rawP) ? rawP : '';
    if (!kids.has(pid)) kids.set(pid, []);
    kids.get(pid).push(u);
  }
  for (const arr of kids.values()) {
    arr.sort((a, b) => String(a.email).localeCompare(String(b.email), 'es'));
  }
  const roots = [];
  if (isSuperAdmin) {
    for (const u of list) {
      const rawP = u.createdBy != null ? String(u.createdBy) : '';
      if (!rawP || !byId.has(rawP)) roots.push(u);
    }
    roots.sort((a, b) => String(a.email).localeCompare(String(b.email), 'es'));
  } else {
    const me = byId.get(String(currentUserId || ''));
    if (me) roots.push(me);
    else {
      for (const u of list) {
        const rawP = u.createdBy != null ? String(u.createdBy) : '';
        if (!rawP || !byId.has(rawP)) roots.push(u);
      }
      roots.sort((a, b) => String(a.email).localeCompare(String(b.email), 'es'));
    }
  }
  const rows = [];
  const walk = (node, depth) => {
    rows.push({ u: node, depth });
    for (const c of kids.get(String(node.id)) || []) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return rows;
}

function canOfferNavModule(isSuperAdmin, hasNavPage, moduleId) {
  if (moduleId === 'Templates') return isSuperAdmin;
  return hasNavPage(moduleId);
}

function NavModulePicker({ value, onChange, hasNavPage, isSuperAdmin, disabled }) {
  return (
    <div className="um-nav-grid um-nav-grid--list" role="group" aria-label="Módulos del menú">
      {NAV_MODULE_DEFS.map(({ id, label }) => {
        if (!canOfferNavModule(isSuperAdmin, hasNavPage, id)) return null;
        return (
          <label key={id} className={`um-nav-tile glass ${value[id] ? 'um-nav-tile--on' : ''}`}>
            <input
              type="checkbox"
              checked={Boolean(value[id])}
              disabled={disabled}
              onChange={(e) => onChange({ ...value, [id]: e.target.checked })}
            />
            <span className="um-nav-tile-label">{label}</span>
          </label>
        );
      })}
    </div>
  );
}

const CREATE_ROLE_OPTIONS_SUPER = [
  {
    id: 'user',
    name: 'Usuario',
    desc: 'Permisos según los módulos marcados; puede delegar solo lo que tenga asignado.',
    icon: 'user',
  },
  {
    id: 'superadmin',
    name: 'Super administrador',
    desc: 'Control total: dispositivos, plantillas y todas las cuentas.',
    icon: 'super',
  },
];

const SUPER_EDIT_ROLES = [
  { id: 'superadmin', name: 'Super admin', desc: 'Control total del sistema', icon: 'super' },
  { id: 'user', name: 'Usuario', desc: 'Permisos por módulos', icon: 'user' },
];

const UserManagement = ({ onAfterEnterSupport }) => {
  const { user, hasNavPage, isSuperAdmin, enterImpersonation } = useAuth();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [activeUser, setActiveUser] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPass, setConfirmNewPass] = useState('');
  /** @type {null | { user: object, devices: object[], loading: boolean, error: string|null }} */
  const [devicesModal, setDevicesModal] = useState(null);
  const [unassignBusy, setUnassignBusy] = useState(false);
  const [unassignConfirm, setUnassignConfirm] = useState(null);
  /** Confirmación visual antes de entrar en modo soporte (sustituye `window.confirm`). */
  const [supportTarget, setSupportTarget] = useState(null);
  const [supportBusy, setSupportBusy] = useState(false);

  const showToast = (type, msg, opts = {}) => {
    const durationMs = opts.durationMs ?? (type === 'warning' ? 8000 : 4000);
    setToast({ type, msg: msg || '', title: opts.title ?? null, durationMs });
    setTimeout(() => setToast(null), durationMs);
  };

  const loadUsers = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const list = await getUsers();
      setUsers(list);
    } catch (e) {
      showToast('error', 'Error al cargar usuarios: ' + e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadUsers();
  }, [user]);

  useEffect(() => {
    if (!supportTarget) return;
    const onKey = (e) => {
      if (e.key === 'Escape' && !supportBusy) setSupportTarget(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [supportTarget, supportBusy]);

  const requestEnterSupport = (u) => {
    if (!isSuperAdmin || !u || u.id === user?.id || u.role === 'superadmin') return;
    setSupportTarget(u);
  };

  const closeSupportConfirm = () => {
    if (supportBusy) return;
    setSupportTarget(null);
  };

  const confirmEnterSupport = async () => {
    const u = supportTarget;
    if (!u || supportBusy) return;
    setSupportBusy(true);
    try {
      await enterImpersonation(u.id);
      setSupportTarget(null);
      if (typeof onAfterEnterSupport === 'function') onAfterEnterSupport();
    } catch (e) {
      showToast('error', e.message || 'No se pudo iniciar el modo soporte');
    } finally {
      setSupportBusy(false);
    }
  };

  const treeRows = useMemo(
    () => flattenUserTree(users, user?.id, isSuperAdmin),
    [users, user?.id, isSuperAdmin]
  );

  const openCreate = () => {
    setForm({ ...EMPTY_FORM, navPick: defaultNavPickForNew(hasNavPage) });
    setModal('create');
  };

  const openEdit = (u) => {
    setActiveUser(u);
    setForm({
      email: u.email || '',
      password: '',
      confirmPassword: '',
      role: normalizeRole(u.role),
      profileName: u.profileName || '',
      navPick: mergeNavFromUser(u),
    });
    setModal('edit');
  };

  const openPassword = (u) => {
    setActiveUser(u);
    setNewPassword('');
    setConfirmNewPass('');
    setModal('password');
  };

  const closeModal = () => {
    setModal(null);
    setActiveUser(null);
  };

  const closeDevicesModal = () => {
    if (unassignBusy) return;
    setDevicesModal(null);
    setUnassignConfirm(null);
  };

  const openDevicesList = async (u) => {
    setDevicesModal({ user: u, devices: [], loading: true, error: null });
    try {
      const data = await getUserDevices(u.id);
      setDevicesModal({
        user: u,
        devices: Array.isArray(data.devices) ? data.devices : [],
        loading: false,
        error: null,
      });
    } catch (e) {
      setDevicesModal({
        user: u,
        devices: [],
        loading: false,
        error: e.message || 'No se pudo cargar el listado',
      });
    }
  };

  const executeUnassignFromUser = async () => {
    const target = devicesModal?.user;
    if (!target?.id || !unassignConfirm) return;
    const ids =
      unassignConfirm === 'all'
        ? (devicesModal.devices || []).map((d) => d.deviceId).filter(Boolean)
        : [unassignConfirm].filter(Boolean);
    if (ids.length === 0) {
      setUnassignConfirm(null);
      return;
    }
    setUnassignBusy(true);
    try {
      const errors = [];
      for (const deviceId of ids) {
        try {
          await unassignDeviceFromUser(target.id, deviceId);
        } catch (e) {
          errors.push(`${deviceId}: ${e.response?.data?.error || e.message || 'error'}`);
        }
      }
      const data = await getUserDevices(target.id);
      setDevicesModal({
        user: target,
        devices: Array.isArray(data.devices) ? data.devices : [],
        loading: false,
        error: null,
      });
      setUnassignConfirm(null);
      if (errors.length) {
        showToast('error', `Algunos equipos no se pudieron quitar: ${errors.join('; ')}`);
      } else {
        showToast('success', ids.length > 1 ? 'Se quitaron todos los dispositivos de esta cuenta.' : 'Dispositivo quitado de esta cuenta.');
      }
    } catch (e) {
      showToast('error', e.message || 'No se pudo quitar la asignación');
    } finally {
      setUnassignBusy(false);
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (form.password !== form.confirmPassword) {
      showToast('error', 'Las contraseñas no coinciden.');
      return;
    }
    if (form.password.length < 6) {
      showToast('error', 'La contraseña inicial debe tener al menos 6 caracteres.');
      return;
    }
    setSaving(true);
    try {
      const rolePayload = isSuperAdmin && form.role === 'superadmin' ? 'superadmin' : 'user';
      const navPermissions = {};
      for (const { id } of NAV_MODULE_DEFS) {
        if (form.navPick[id]) navPermissions[id] = true;
      }
      await createUser({
        email: form.email,
        password: form.password,
        role: rolePayload,
        profileName: form.profileName,
        navPermissions,
      });
      showToast('success', `Usuario "${form.email}" creado correctamente.`);
      closeModal();
      await loadUsers();
    } catch (e) {
      if (e.code === 'USER_EXISTS' || e.message?.includes('ya está registrado')) {
        const dup = getDuplicateEntityNotice('USER_EXISTS', { userAction: 'create' });
        showToast('warning', dup.body, { title: dup.title });
      } else showToast('error', `Error: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const updates = { profileName: form.profileName, email: form.email };
      if (isSuperAdmin) {
        updates.role = form.role === 'superadmin' ? 'superadmin' : 'user';
      }
      if (activeUser.role !== 'superadmin') {
        const navPermissions = {};
        for (const { id } of NAV_MODULE_DEFS) {
          if (form.navPick[id]) navPermissions[id] = true;
        }
        updates.navPermissions = navPermissions;
      }
      await updateUser(activeUser.id, updates);
      showToast('success', 'Usuario actualizado correctamente.');
      closeModal();
      loadUsers();
    } catch (e) {
      if (e.code === 'USER_EXISTS' || e.message?.includes('ya está registrado')) {
        const dup = getDuplicateEntityNotice('USER_EXISTS', { userAction: 'edit' });
        showToast('warning', dup.body, { title: dup.title });
      } else {
        showToast('error', 'Error al actualizar: ' + e.message);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleRegenerateIngest = async (u) => {
    if (!window.confirm(`¿Regenerar token de ingesta para ${u.email}? Las gateways deberán usar la nueva URL.`)) return;
    setSaving(true);
    try {
      await updateUser(u.id, { regenerateIngestToken: true });
      showToast('success', 'Token de ingesta regenerado.');
      await loadUsers();
    } catch (e) {
      showToast('error', e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    if (newPassword !== confirmNewPass) {
      showToast('error', 'Las contraseñas no coinciden.');
      return;
    }
    const pv = validatePasswordStrength(newPassword);
    if (!pv.ok) {
      showToast('error', pv.error);
      return;
    }
    setSaving(true);
    try {
      await updateUser(activeUser.id, { password: newPassword });
      showToast('success', 'Contraseña actualizada correctamente.');
      closeModal();
    } catch (e) {
      showToast('error', 'Error: ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (uid, email) => {
    if (!window.confirm(`¿Eliminar al usuario "${email}"? Esta acción no se puede deshacer.`)) return;
    setDeletingId(uid);
    try {
      await deleteUser(uid);
      showToast('success', `Usuario "${email}" eliminado.`);
      setUsers(users.filter((u) => u.id !== uid));
    } catch (e) {
      showToast('error', 'Error al eliminar: ' + e.message);
    } finally {
      setDeletingId(null);
    }
  };

  const origin = getServerOrigin();

  if (!hasNavPage('Users')) {
    return (
      <div className="device-list-page device-list-page--premium premium-shell">
        <div className="table-container glass card premium-access-denied-card">
          <div className="um-no-access">
            <AlertCircle size={48} />
            <h2>Acceso restringido</h2>
            <p>No tiene permiso para gestionar usuarios.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="device-list-page device-list-page--premium premium-shell">
      {toast && (
        <div className="um-toast-host">
          <FormToast
            type={toast.type}
            title={toast.title}
            message={toast.msg}
            onDismiss={() => setToast(null)}
            durationMs={toast.durationMs}
          />
        </div>
      )}

      <div className="page-header device-page-header device-list-hero">
        <div className="device-page-header-titles">
          <h1>
            <Users size={26} className="premium-hero-title-icon" aria-hidden />
            <span className="premium-hero-title-text">Gestión de Usuarios ({users.length})</span>
          </h1>
          {isSuperAdmin && (
            <p className="um-support-hint device-page-header-sub">
              Como super administrador puede usar el icono de acceso o hacer clic en una fila (fuera de los botones) para
              abrir la confirmación y ver la plataforma como ese usuario (modo soporte).
            </p>
          )}
        </div>
        <button type="button" className="btn btn-primary device-create-top-btn" onClick={openCreate}>
          <Plus size={18} /> Nuevo Usuario
        </button>
      </div>

      <div className="table-container glass card">
        <div className="device-table-scroll">
          {loading ? (
            <div className="um-loading premium-loading-in-card">
              <Loader size={28} className="spin" /> Cargando usuarios…
            </div>
          ) : users.length === 0 ? (
            <div className="um-empty premium-empty-in-card">
              <Users size={48} />
              <h3>Sin usuarios creados</h3>
              <p>Crea el primer usuario para dar acceso a la plataforma.</p>
              <button type="button" className="btn btn-primary device-create-top-btn" onClick={openCreate}>
                <Plus size={18} /> Crear primer usuario
              </button>
            </div>
          ) : (
            <table className="premium-data-table">
              <thead>
                <tr>
                  <th scope="col">Correo</th>
                  <th scope="col">Nombre</th>
                  <th scope="col">Rol</th>
                  <th scope="col">Token ingesta</th>
                  <th className="device-actions-col" scope="col">
                    <div className="device-actions-head">
                      <span className="device-actions-head-label">Acciones</span>
                    </div>
                  </th>
                </tr>
              </thead>
              <tbody>
                {treeRows.map(({ u, depth }) => {
                  const supportEligible =
                    isSuperAdmin && u.id !== user?.id && u.role !== 'superadmin';
                  return (
                  <tr
                    key={u.id}
                    className={supportEligible ? 'um-row--support-eligible' : undefined}
                    title={
                      supportEligible
                        ? 'Clic fuera de los botones para abrir la confirmación de modo soporte'
                        : undefined
                    }
                    onClick={(e) => {
                      if (!supportEligible) return;
                      if (e.target.closest('button, a, input')) return;
                      void requestEnterSupport(u);
                    }}
                  >
                    <td>
                      <div
                        className="um-user-email-cell"
                        style={{ paddingLeft: depth ? `${depth * 1.1}rem` : undefined, borderLeft: depth ? '2px solid var(--border-subtle, rgba(255,255,255,0.12))' : undefined }}
                      >
                        <span className="um-user-email-primary">{u.email}</span>
                      </div>
                    </td>
                    <td>
                      <span className="um-user-profile-name">{u.profileName || '—'}</span>
                    </td>
                    <td>
                      <span className={`role-badge ${normalizeRole(u.role)}`}>
                        {u.role === 'superadmin' ? (
                          <>
                            <Shield size={12} /> Super admin
                          </>
                        ) : u.role === 'admin' ? (
                          <>
                            <Eye size={12} /> Usuario
                          </>
                        ) : (
                          <>
                            <Eye size={12} /> Usuario
                          </>
                        )}
                      </span>
                    </td>
                    <td
                      className="um-token-cell mono"
                      title={u.ingestToken ? `${origin}/api/ingest/${u.id}/${u.ingestToken}` : ''}
                    >
                      {u.ingestToken ? `${u.ingestToken.slice(0, 10)}…` : '—'}
                    </td>
                    <td className="device-actions-col">
                      <div className="actions">
                        <div className="device-row-actions-icons" role="group" aria-label={`Acciones de ${u.email}`}>
                          {supportEligible && (
                            <button
                              type="button"
                              className="device-action-pill device-action-pill--support"
                              title="Modo soporte: ver la plataforma como este usuario"
                              onClick={() => void requestEnterSupport(u)}
                            >
                              <LogIn size={18} strokeWidth={2} />
                            </button>
                          )}
                          <button type="button" className="device-action-pill" title="Editar usuario" onClick={() => openEdit(u)}>
                            <Edit2 size={18} strokeWidth={2} />
                          </button>
                          <button type="button" className="device-action-pill" title="Ver dispositivos asignados" onClick={() => openDevicesList(u)}>
                            <Database size={18} strokeWidth={2} />
                          </button>
                          <button type="button" className="device-action-pill" title="Regenerar token de ingesta" onClick={() => handleRegenerateIngest(u)}>
                            <Play size={18} strokeWidth={2} />
                          </button>
                          <button type="button" className="device-action-pill" title="Cambiar contraseña" onClick={() => openPassword(u)}>
                            <UserPlus size={18} strokeWidth={2} />
                          </button>
                          <button
                            type="button"
                            className="device-action-pill device-action-pill--danger"
                            title="Eliminar usuario"
                            onClick={() => handleDelete(u.id, u.email)}
                            disabled={deletingId === u.id}
                          >
                            {deletingId === u.id ? <Loader size={18} className="spin" /> : <Trash2 size={18} strokeWidth={2} />}
                          </button>
                        </div>
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {modal === 'create' && (
        <div className="modal-overlay um-modal-overlay" onClick={closeModal} onKeyDown={(e) => e.key === 'Escape' && closeModal()} role="presentation">
          <div
            className="modal-content glass um-modal um-modal-shell um-modal--create"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            role="dialog"
          >
            <div className="modal-header">
              <h2>Nuevo Usuario</h2>
              <button type="button" className="btn-icon um-modal-close" onClick={closeModal} aria-label="Cerrar">
                <X size={20} />
              </button>
            </div>
            <form onSubmit={handleCreate} className="um-form">
              <div className="um-modal-body-scroll">
              {isSuperAdmin ? (
                <div className="form-group">
                  <label>Tipo de cuenta</label>
                  <div className="role-selector">
                    {CREATE_ROLE_OPTIONS_SUPER.map((opt) => (
                      <div
                        key={opt.id}
                        className={`role-option ${form.role === opt.id ? 'active' : ''}`}
                        onClick={() => setForm({ ...form, role: opt.id })}
                        onKeyDown={(e) => e.key === 'Enter' && setForm({ ...form, role: opt.id })}
                        role="button"
                        tabIndex={0}
                      >
                        {opt.icon === 'super' ? <Shield size={20} /> : <Eye size={20} />}
                        <div>
                          <div className="role-name">{opt.name}</div>
                          <div className="role-desc">{opt.desc}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="um-modal-hint" style={{ marginBottom: '1rem' }}>
                  Se creará una cuenta de <strong>usuario</strong>. Solo podrá activar los módulos que usted tenga en su
                  cuenta.
                </p>
              )}

              {!(isSuperAdmin && form.role === 'superadmin') && (
                <div className="form-group">
                  <label>Módulos visibles en el menú</label>
                  <p className="um-modal-hint" style={{ marginTop: 0 }}>
                    Marque solo lo que este usuario necesite. Podrá delegar a sus subcuentas únicamente lo que usted
                    tenga asignado.
                  </p>
                  <NavModulePicker
                    value={form.navPick}
                    onChange={(next) => setForm({ ...form, navPick: next })}
                    hasNavPage={hasNavPage}
                    isSuperAdmin={isSuperAdmin}
                    disabled={false}
                  />
                </div>
              )}

              <div className="um-form-divider">Datos de acceso</div>
              <div className="form-row-2">
                <div className="form-group">
                  <label>Correo electrónico</label>
                  <input
                    type="email"
                    className="glass"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    required
                    placeholder="usuario@ejemplo.com"
                  />
                </div>
                <div className="form-group">
                  <label>Nombre del perfil</label>
                  <input
                    type="text"
                    className="glass"
                    value={form.profileName}
                    onChange={(e) => setForm({ ...form, profileName: e.target.value })}
                    placeholder="Ej: Roberto"
                  />
                </div>
              </div>
              <div className="form-row-2">
                <div className="form-group">
                  <label>Contraseña inicial (temporal)</label>
                  <input
                    type="password"
                    className="glass"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    required
                    placeholder="Mín. 6 caracteres"
                  />
                </div>
                <div className="form-group">
                  <label>Confirmar contraseña</label>
                  <input
                    type="password"
                    className="glass"
                    value={form.confirmPassword}
                    onChange={(e) => setForm({ ...form, confirmPassword: e.target.value })}
                    required
                    placeholder="Repite la contraseña"
                  />
                </div>
              </div>
              <p className="um-password-policy-hint">
                Tras el primer acceso, la cuenta deberá definir su propia contraseña: {PASSWORD_POLICY_HINT}
              </p>
              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={closeModal}>
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? (
                    <>
                      <Loader size={15} className="spin" /> Creando...
                    </>
                  ) : (
                    <>
                      <Plus size={15} /> Crear Usuario
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {modal === 'edit' && activeUser && (
        <div className="modal-overlay um-modal-overlay" onClick={closeModal} role="presentation">
          <div
            className="modal-content glass um-modal um-modal-shell um-modal--edit"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
          >
            <div className="modal-header">
              <h2>Editar Usuario</h2>
              <button type="button" className="btn-icon um-modal-close" onClick={closeModal} aria-label="Cerrar">
                <X size={20} />
              </button>
            </div>
            <form onSubmit={handleEdit} className="um-form">
              <div className="um-modal-body-scroll">
              {isSuperAdmin ? (
                <div className="form-group">
                  <label>Rol</label>
                  <div className="role-selector">
                    {SUPER_EDIT_ROLES.map((opt) => (
                      <div
                        key={opt.id}
                        className={`role-option ${form.role === opt.id ? 'active' : ''}`}
                        onClick={() => setForm({ ...form, role: opt.id })}
                        role="button"
                        tabIndex={0}
                      >
                        {opt.icon === 'super' ? <Shield size={20} /> : <Eye size={20} />}
                        <div>
                          <div className="role-name">{opt.name}</div>
                          <div className="role-desc">{opt.desc}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="um-modal-hint" style={{ marginBottom: '1rem' }}>
                  Rol de la cuenta:{' '}
                  <strong>
                    {activeUser.role === 'superadmin'
                      ? 'Super admin'
                      : activeUser.role === 'admin'
                        ? 'Usuario'
                        : 'Usuario'}
                  </strong>
                  . Solo el super administrador puede cambiar el rol.
                </p>
              )}

              <div className="um-form-divider">Datos de acceso</div>
              <div className="form-row-2">
                <div className="form-group">
                  <label>Correo electrónico</label>
                  <input
                    type="email"
                    className="glass"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label>Nombre del perfil</label>
                  <input
                    type="text"
                    className="glass"
                    value={form.profileName}
                    onChange={(e) => setForm({ ...form, profileName: e.target.value })}
                  />
                </div>
              </div>

              {activeUser.role !== 'superadmin' && (
                <div className="form-group" style={{ marginTop: '1rem' }}>
                  <label>Módulos del menú</label>
                  <p className="um-modal-hint" style={{ marginTop: 0 }}>
                    Solo puede asignar módulos que su propia cuenta tenga habilitados.
                  </p>
                  <NavModulePicker
                    value={form.navPick}
                    onChange={(next) => setForm({ ...form, navPick: next })}
                    hasNavPage={hasNavPage}
                    isSuperAdmin={isSuperAdmin}
                    disabled={false}
                  />
                </div>
              )}

              </div>

              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={closeModal}>
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? (
                    <>
                      <Loader size={15} className="spin" /> Guardando...
                    </>
                  ) : (
                    <>
                      <Save size={15} /> Guardar Cambios
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {devicesModal && (
        <div className="modal-overlay um-modal-overlay" onClick={closeDevicesModal} role="presentation">
          <div
            className="modal-content glass um-modal um-modal-shell um-devices-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-labelledby="um-devices-title"
          >
            <div className="modal-header">
              <h2 id="um-devices-title">Dispositivos asignados</h2>
              <button type="button" className="btn-icon um-modal-close" onClick={closeDevicesModal} aria-label="Cerrar">
                <X size={20} />
              </button>
            </div>
            <p className="um-devices-sub">
              Equipos en la cuenta de{' '}
              <strong>{devicesModal.user.email}</strong>
              {devicesModal.user.profileName ? ` · ${devicesModal.user.profileName}` : ''}.
              {String(devicesModal.user.id) !== String(user?.id)
                ? ' Quitar los deja en el administrador; no borra el inventario.'
                : ''}
            </p>
            {devicesModal.loading ? (
              <div className="um-devices-loading">
                <Loader size={22} className="spin" /> Cargando…
              </div>
            ) : devicesModal.error ? (
              <p className="um-devices-error">{devicesModal.error}</p>
            ) : devicesModal.devices.length === 0 ? (
              <p className="um-devices-empty">Este usuario no tiene dispositivos asignados.</p>
            ) : (
              <div className="um-devices-table-wrap">
                <table className="um-devices-table">
                  <thead>
                    <tr>
                      <th>Nombre</th>
                      <th>ID dispositivo</th>
                      <th>DevEUI</th>
                      <th>Clase</th>
                      <th>Etiqueta</th>
                      {String(devicesModal.user.id) !== String(user?.id) ? <th>Acción</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {devicesModal.devices.map((d) => (
                      <tr key={String(d.deviceId)}>
                        <td>{d.displayName || '—'}</td>
                        <td className="mono">{d.deviceId}</td>
                        <td className="mono">{d.devEUI || '—'}</td>
                        <td>{d.lorawanClass || '—'}</td>
                        <td>{d.tag || '—'}</td>
                        {String(devicesModal.user.id) !== String(user?.id) ? (
                          <td>
                            <button
                              type="button"
                              className="device-action-pill device-action-pill--danger"
                              title="Quitar de esta cuenta"
                              disabled={unassignBusy}
                              onClick={() => setUnassignConfirm(d.deviceId)}
                            >
                              <Trash2 size={16} strokeWidth={2} />
                            </button>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={closeDevicesModal} disabled={unassignBusy}>
                Cerrar
              </button>
              {String(devicesModal.user.id) !== String(user?.id) && devicesModal.devices.length > 0 ? (
                <button
                  type="button"
                  className="btn device-assign-unassign-btn"
                  disabled={unassignBusy}
                  onClick={() => setUnassignConfirm('all')}
                >
                  {unassignBusy ? 'Quitando…' : 'Quitar todos de esta cuenta'}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      )}

      {supportTarget && (
        <div
          className="modal-overlay um-modal-overlay um-support-confirm-overlay"
          onClick={() => !supportBusy && closeSupportConfirm()}
          role="presentation"
        >
          <div
            className="modal-content glass um-modal um-modal-shell um-support-confirm-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="um-support-confirm-title"
          >
            <div className="modal-header um-support-confirm-header">
              <div className="um-support-confirm-title-row">
                <span className="um-support-confirm-icon" aria-hidden>
                  <LogIn size={22} strokeWidth={2.25} />
                </span>
                <h2 id="um-support-confirm-title">Modo soporte técnico</h2>
              </div>
              <button
                type="button"
                className="btn-icon um-modal-close"
                onClick={closeSupportConfirm}
                disabled={supportBusy}
                aria-label="Cerrar"
              >
                <X size={20} />
              </button>
            </div>
            <div className="modal-body um-support-confirm-body">
              <p className="um-support-confirm-lead">
                Verá la plataforma exactamente como la ve esta cuenta. Para volver a la suya use{' '}
                <strong>«Volver a mi cuenta»</strong> en la barra superior.
              </p>
              <div className="um-support-confirm-user-card glass">
                <Mail size={18} className="um-support-confirm-user-card-icon" aria-hidden />
                <div className="um-support-confirm-user-card-text">
                  <span className="um-support-confirm-user-label">Usuario</span>
                  <span className="um-support-confirm-user-email">{supportTarget.email}</span>
                  {supportTarget.profileName ? (
                    <span className="um-support-confirm-user-name">{supportTarget.profileName}</span>
                  ) : null}
                </div>
              </div>
            </div>
            <div className="modal-footer um-support-confirm-footer">
              <button type="button" className="btn btn-secondary" onClick={closeSupportConfirm} disabled={supportBusy}>
                Cancelar
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void confirmEnterSupport()} disabled={supportBusy}>
                {supportBusy ? (
                  <>
                    <Loader size={16} className="spin" /> Entrando…
                  </>
                ) : (
                  <>
                    <LogIn size={16} /> Entrar como este usuario
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {modal === 'password' && activeUser && (
        <div className="modal-overlay um-modal-overlay" onClick={closeModal} role="presentation">
          <div className="modal-content glass um-modal um-modal-sm um-modal-shell" onClick={(e) => e.stopPropagation()} role="dialog">
            <div className="modal-header">
              <h2>Cambiar Contraseña</h2>
              <button type="button" className="btn-icon um-modal-close" onClick={closeModal} aria-label="Cerrar">
                <X size={20} />
              </button>
            </div>
            <div className="um-user-target">
              <KeyRound size={16} />
              <span>{activeUser.email}</span>
            </div>
            <form onSubmit={handleChangePassword} className="um-form">
              <p className="um-password-policy-hint">{PASSWORD_POLICY_HINT} Si cambia la contraseña de otro usuario, deberá redefinirla al entrar.</p>
              <div className="form-group">
                <label>Nueva contraseña</label>
                <input
                  type="password"
                  className="glass"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  placeholder="Mín. 8 caracteres, mayús., minús. y símbolo"
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label>Confirmar nueva contraseña</label>
                <input
                  type="password"
                  className="glass"
                  value={confirmNewPass}
                  onChange={(e) => setConfirmNewPass(e.target.value)}
                  required
                  placeholder="Repite la contraseña"
                />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={closeModal}>
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? (
                    <>
                      <Loader size={15} className="spin" /> Guardando...
                    </>
                  ) : (
                    <>
                      <KeyRound size={15} /> Cambiar Contraseña
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      <CenteredAlertModal
        open={Boolean(unassignConfirm)}
        title="Quitar asignación"
        variant="error"
        message={
          unassignConfirm === 'all' && devicesModal?.user
            ? `¿Quitar **todos** los dispositivos de **${devicesModal.user.email}**?\n\nSeguirán en su cuenta de administrador. Esta persona dejará de verlos hasta que los vuelva a asignar.`
            : unassignConfirm && devicesModal?.user
              ? `¿Quitar este dispositivo de **${devicesModal.user.email}**?\n\nSeguirá en su cuenta de administrador.`
              : ''
        }
        cancelLabel="Cancelar"
        confirmLabel={unassignConfirm === 'all' ? 'Sí, quitar todos' : 'Sí, quitar'}
        confirmDanger
        onClose={() => !unassignBusy && setUnassignConfirm(null)}
        onConfirm={() => executeUnassignFromUser()}
      />
    </div>
  );
};

export default UserManagement;
