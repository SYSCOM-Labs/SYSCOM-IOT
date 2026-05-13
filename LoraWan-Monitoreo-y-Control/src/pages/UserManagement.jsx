import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { getUsers, createUser, updateUser, deleteUser, getServerOrigin, getUserDevices } from '../services/localAuth';
import { validatePasswordStrength, PASSWORD_POLICY_HINT } from '../utils/passwordPolicy';
import { Users, Plus, Trash2, Shield, Eye, X, Loader, AlertCircle, CheckCircle2, Edit2, KeyRound, Save, Database, Play, UserPlus } from 'lucide-react';
import './DeviceList.css';
import '../styles/premiumPageShell.css';
import './UserManagement.css';

const EMPTY_FORM = {
  email: '',
  password: '',
  confirmPassword: '',
  role: 'user',
  profileName: '',
};

function normalizeRole(r) {
  if (r === 'viewer') return 'user';
  if (r === 'superadmin' || r === 'admin' || r === 'user') return r;
  return 'user';
}

const CREATE_ROLES = [
  {
    id: 'admin',
    name: 'Administrador',
    desc: 'Edita dashboards (panel y dispositivos), asigna equipos y gestiona su jerarquía; no da de alta dispositivos nuevos',
    icon: 'admin',
  },
  { id: 'user', name: 'Usuario', desc: 'Ve telemetría y dashboards sin editar el tablero', icon: 'user' },
];

const CREATE_ROLES_SUPER = [
  { id: 'superadmin', name: 'Super administrador', desc: 'Control total: alta de dispositivos, borrado definitivo y cuentas de cualquier rol', icon: 'super' },
  ...CREATE_ROLES,
];

const SUPER_EDIT_ROLES = [
  { id: 'superadmin', name: 'Super admin', desc: 'Control total del sistema', icon: 'super' },
  { id: 'admin', name: 'Administrador', desc: 'Gestiona su jerarquía', icon: 'admin' },
  { id: 'user', name: 'Usuario', desc: 'Solo asignados', icon: 'user' },
];

/** Vista previa al crear: qué puede hacer cada rol. */
const PERMISSION_ROWS = {
  user: [
    { ok: true, label: 'Solo dispositivos que un admin o super admin le hayan asignado; ver telemetría y dashboards en lectura' },
    { ok: true, label: 'Historial y reportes especiales' },
    { ok: false, label: 'Editar widgets del panel o del dashboard del dispositivo' },
    { ok: false, label: 'Registrar dispositivos nuevos en el sistema' },
    { ok: false, label: 'Gestionar usuarios' },
  ],
  admin: [
    { ok: true, label: 'Ver solo dispositivos asignados a su cuenta (p. ej. por super admin); editar sus dashboards' },
    { ok: true, label: 'Editar dashboards del panel y de cada dispositivo asignado (widgets, datos, disposición)' },
    { ok: true, label: 'Downlinks, automatizaciones y ajustes (según integración)' },
    { ok: true, label: 'Asignar dispositivos y crear administradores/usuarios de su jerarquía' },
    { ok: false, label: 'Registrar dispositivos nuevos en el sistema (solo super admin)' },
    { ok: false, label: 'Eliminar dispositivos de la base de datos por completo (solo super admin)' },
  ],
  superadmin: [
    { ok: true, label: 'Listado global de dispositivos y asignaciones (no limitado a user_devices propios)' },
    { ok: true, label: 'Registrar dispositivos nuevos y asignarlos a cualquier cuenta' },
    { ok: true, label: 'Editar dashboards (igual que admin)' },
    { ok: true, label: 'Eliminar dispositivos de forma definitiva de la base de datos' },
    { ok: true, label: 'Crear cuentas super admin, admin y usuario' },
  ],
};

const UserManagement = () => {
  const { user, isAdmin, isSuperAdmin } = useAuth();
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

  const showToast = (type, msg) => {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 4000);
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

  const openCreate = () => {
    setForm(EMPTY_FORM);
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

  const closeDevicesModal = () => setDevicesModal(null);

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
      const rolePayload =
        isSuperAdmin && form.role === 'superadmin'
          ? 'superadmin'
          : form.role === 'admin'
            ? 'admin'
            : 'user';
      await createUser({
        email: form.email,
        password: form.password,
        role: rolePayload,
        profileName: form.profileName,
      });
      showToast('success', `Usuario "${form.email}" creado correctamente.`);
      closeModal();
      await loadUsers();
    } catch (e) {
      if (e.code === 'USER_EXISTS' || e.message?.includes('ya está registrado')) {
        showToast('error', 'Ese correo ya está registrado. No se puede completar el alta.');
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
      if (isSuperAdmin) updates.role = form.role;
      await updateUser(activeUser.id, updates);
      showToast('success', 'Usuario actualizado correctamente.');
      closeModal();
      loadUsers();
    } catch (e) {
      showToast('error', 'Error al actualizar: ' + e.message);
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

  if (!isAdmin) {
    return (
      <div className="device-list-page device-list-page--premium premium-shell">
        <div className="table-container glass card premium-access-denied-card">
          <div className="um-no-access">
            <AlertCircle size={48} />
            <h2>Acceso restringido</h2>
            <p>Solo los administradores pueden gestionar usuarios.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="device-list-page device-list-page--premium premium-shell">
      {toast && (
        <div className={`um-toast ${toast.type}`}>
          {toast.type === 'success' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
          {toast.msg}
        </div>
      )}

      <div className="page-header device-page-header device-list-hero">
        <div className="device-page-header-titles">
          <h1>
            <Users size={26} className="premium-hero-title-icon" aria-hidden />
            <span className="premium-hero-title-text">Gestión de Usuarios ({users.length})</span>
          </h1>
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
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <div className="um-user-email-cell">
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
                            <Shield size={12} /> Admin
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
                ))}
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
              <div className="form-group">
                <label>Tipo de acceso</label>
                <div className="role-selector">
                  {(isSuperAdmin ? CREATE_ROLES_SUPER : CREATE_ROLES).map((opt) => (
                    <div
                      key={opt.id}
                      className={`role-option ${form.role === opt.id ? 'active' : ''}`}
                      onClick={() => setForm({ ...form, role: opt.id })}
                      onKeyDown={(e) => e.key === 'Enter' && setForm({ ...form, role: opt.id })}
                      role="button"
                      tabIndex={0}
                    >
                      {opt.icon === 'super' ? <Shield size={20} /> : opt.icon === 'admin' ? <Shield size={20} /> : <Eye size={20} />}
                      <div>
                        <div className="role-name">{opt.name}</div>
                        <div className="role-desc">{opt.desc}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

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

              <div className="um-permissions-preview">
                <div className="perm-title">
                  Permisos del rol{' '}
                  <strong>
                    {form.role === 'superadmin' ? 'Super administrador' : form.role === 'admin' ? 'Administrador' : 'Usuario'}
                  </strong>
                  :
                </div>
                <div className="perm-grid">
                  {(PERMISSION_ROWS[form.role === 'superadmin' ? 'superadmin' : form.role === 'admin' ? 'admin' : 'user'] || PERMISSION_ROWS.user).map(
                    (p, i) => (
                      <div key={i} className={`perm-item ${p.ok ? 'yes' : 'no'}`}>
                        <span className="perm-dot" />
                        {p.label}
                      </div>
                    )
                  )}
                </div>
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
          <div className="modal-content glass um-modal um-modal-shell" onClick={(e) => e.stopPropagation()} role="dialog">
            <div className="modal-header">
              <h2>Editar Usuario</h2>
              <button type="button" className="btn-icon um-modal-close" onClick={closeModal} aria-label="Cerrar">
                <X size={20} />
              </button>
            </div>
            <form onSubmit={handleEdit} className="um-form">
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
                        {opt.icon === 'super' || opt.icon === 'admin' ? <Shield size={20} /> : <Eye size={20} />}
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
                        ? 'Administrador'
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
              Equipos en <strong>user_devices</strong> para{' '}
              <strong>{devicesModal.user.email}</strong>
              {devicesModal.user.profileName ? ` · ${devicesModal.user.profileName}` : ''}
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
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="modal-footer">
              <button type="button" className="btn btn-secondary" onClick={closeDevicesModal}>
                Cerrar
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
    </div>
  );
};

export default UserManagement;
