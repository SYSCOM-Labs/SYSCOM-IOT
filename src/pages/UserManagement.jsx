import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useLocation, matchPath } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { getUsers, createUser, updateUser, deleteUser, getServerOrigin } from '../services/localAuth';
import { validatePasswordStrength, PASSWORD_POLICY_HINT } from '../utils/passwordPolicy';
import { Users, Plus, Trash2, Shield, Eye, X, Loader, AlertCircle, CheckCircle2, Edit2, KeyRound, Save, RefreshCw } from 'lucide-react';
import './UserManagement.css';
import { ROUTES } from '../constants/routes';

/** Contraseña interna aleatoria (OAuth/Google es el acceso real; la API exige campo al crear). */
function generateInitialUserPassword() {
  const a = new Uint8Array(18);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

const EMPTY_FORM = {
  email: '',
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
  const navigate = useNavigate();
  const location = useLocation();
  const { user, isAdmin, isSuperAdmin } = useAuth();
  const { t } = useLanguage();
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

  const applyEditForm = useCallback((u) => {
    setActiveUser(u);
    setForm({
      email: u.email || '',
      role: normalizeRole(u.role),
      profileName: u.profileName || '',
    });
  }, []);

  const usersRef = useRef(users);
  usersRef.current = users;

  useEffect(() => {
    const p = location.pathname;
    if (p === ROUTES.usuarios || p === `${ROUTES.usuarios}/`) {
      setModal(null);
      setActiveUser(null);
      return;
    }
    if (p === ROUTES.usuarioNuevo) {
      setForm(EMPTY_FORM);
      setModal('create');
      setActiveUser(null);
      return;
    }
    const mEdit = matchPath({ path: '/usuarios/:userId/editar', end: true }, p);
    const mPass = matchPath({ path: '/usuarios/:userId/clave', end: true }, p);
    if (loading) return;

    if (mEdit?.params?.userId) {
      const found = usersRef.current.find((x) => x.id === mEdit.params.userId);
      if (found) {
        applyEditForm(found);
        setModal('edit');
      } else {
        navigate(ROUTES.usuarios, { replace: true });
      }
      return;
    }
    if (mPass?.params?.userId) {
      const found = usersRef.current.find((x) => x.id === mPass.params.userId);
      if (found) {
        setActiveUser(found);
        setNewPassword('');
        setConfirmNewPass('');
        setModal('password');
      } else {
        navigate(ROUTES.usuarios, { replace: true });
      }
    }
  }, [location.pathname, loading, navigate, applyEditForm]);

  const openCreate = () => {
    navigate(ROUTES.usuarioNuevo);
  };

  const openEdit = (u) => {
    navigate(ROUTES.usuarioEditar(u.id));
  };

  const closeModal = () => {
    navigate(ROUTES.usuarios);
  };

  const handleCreate = async (e) => {
    e.preventDefault();
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
        password: generateInitialUserPassword(),
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
      <div className="um-page">
        <div className="um-no-access">
          <AlertCircle size={48} />
          <h2>Acceso restringido</h2>
          <p>Solo los administradores pueden gestionar usuarios.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="um-page">
      {toast && (
        <div className={`um-toast ${toast.type}`}>
          {toast.type === 'success' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
          {toast.msg}
        </div>
      )}

      <div className="page-header">
        <div>
          <h1>
            <Users size={22} style={{ marginRight: 8, verticalAlign: 'middle' }} />
            Gestión de Usuarios
          </h1>
          <p className="subtitle">Cada usuario recibe su propia URL de ingesta HTTP para gateways.</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={openCreate}>
          <Plus size={18} /> Nuevo Usuario
        </button>
      </div>

      <div className="um-table-wrap glass card">
        {loading ? (
          <div className="um-loading">
            <Loader size={24} className="spin" /> Cargando usuarios...
          </div>
        ) : users.length === 0 ? (
          <div className="um-empty">
            <Users size={48} />
            <h3>Sin usuarios creados</h3>
            <p>Crea el primer usuario para dar acceso a la plataforma.</p>
            <button type="button" className="btn btn-primary" onClick={openCreate}>
              <Plus size={16} /> Crear primer usuario
            </button>
          </div>
        ) : (
          <table className="um-table">
            <thead>
              <tr>
                <th>Nombre</th>
                <th>Correo</th>
                <th>Rol</th>
                <th>Token ingesta</th>
                <th>{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.profileName || '—'}</td>
                  <td>{u.email}</td>
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
                  <td className="server-cell mono" style={{ fontSize: '0.75rem' }} title={u.ingestToken ? `${origin}/api/ingest/${u.id}/${u.ingestToken}` : ''}>
                    {u.ingestToken ? `${u.ingestToken.slice(0, 10)}…` : '—'}
                  </td>
                  <td>
                    <div className="um-row-actions">
                      <button
                        type="button"
                        className="btn-icon btn-icon--edit"
                        title="Editar usuario"
                        onClick={() => openEdit(u)}
                      >
                        <Edit2 size={15} />
                      </button>
                      <button
                        type="button"
                        className="btn-icon btn-icon--refresh"
                        title="Regenerar token de ingesta"
                        onClick={() => handleRegenerateIngest(u)}
                      >
                        <RefreshCw size={15} />
                      </button>
                      <button
                        type="button"
                        className="btn-icon btn-icon--danger"
                        title="Eliminar usuario"
                        onClick={() => handleDelete(u.id, u.email)}
                        disabled={deletingId === u.id}
                      >
                        {deletingId === u.id ? <Loader size={15} className="spin" /> : <Trash2 size={15} />}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {modal === 'create' && (
        <div className="modal-overlay" onKeyDown={(e) => e.key === 'Escape' && closeModal()} role="presentation">
          <div className="modal-content glass um-modal" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} role="dialog">
            <div className="modal-header">
              <h2>Nuevo Usuario</h2>
              <button type="button" className="btn-icon" onClick={closeModal}>
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
                  <label>Nombre de usuario</label>
                  <input
                    type="text"
                    className="glass"
                    value={form.profileName}
                    onChange={(e) => setForm({ ...form, profileName: e.target.value })}
                    placeholder="Ej: Roberto"
                  />
                </div>
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
              </div>
              <p className="um-password-policy-hint">
                El acceso habitual es con Google. Se genera una contraseña interna aleatoria (no se muestra) solo para
                cumplir el registro en base de datos.
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
        <div className="modal-overlay" role="presentation">
          <div className="modal-content glass um-modal" onClick={(e) => e.stopPropagation()} role="dialog">
            <div className="modal-header">
              <h2>Editar Usuario</h2>
              <button type="button" className="btn-icon" onClick={closeModal}>
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
                <p className="subtitle" style={{ marginBottom: '1rem' }}>
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
                  <label>Nombre de usuario</label>
                  <input
                    type="text"
                    className="glass"
                    value={form.profileName}
                    onChange={(e) => setForm({ ...form, profileName: e.target.value })}
                  />
                </div>
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

      {modal === 'password' && activeUser && (
        <div className="modal-overlay" role="presentation">
          <div className="modal-content glass um-modal-sm" onClick={(e) => e.stopPropagation()} role="dialog">
            <div className="modal-header">
              <h2>Cambiar Contraseña</h2>
              <button type="button" className="btn-icon" onClick={closeModal}>
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
