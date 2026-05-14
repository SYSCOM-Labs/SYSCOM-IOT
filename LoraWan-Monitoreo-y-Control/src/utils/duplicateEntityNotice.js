/**
 * Textos para conflictos 409 / duplicados al dar de alta o actualizar entidades únicas.
 * @param {'USER_EXISTS'|'GATEWAY_EXISTS'|'DEVICE_EXISTS'|'TEMPLATE_MODEL_EXISTS'} code
 * @param {{ userAction?: 'create'|'edit', conflictModelo?: string, conflictMarca?: string }} [ctx]
 * @returns {{ title: string, body: string } | null}
 */
export function getDuplicateEntityNotice(code, ctx = {}) {
  switch (code) {
    case 'USER_EXISTS': {
      const edit = ctx.userAction === 'edit';
      return {
        title: edit ? 'Correo no disponible' : 'Usuario ya existente',
        body: edit
          ? 'Ese correo electrónico ya está asignado a otra cuenta. Elija un correo distinto para guardar los cambios.'
          : 'Ya existe una cuenta con este correo en la plataforma. No puede duplicar el alta: use otro correo o recupere el acceso si es la misma persona.',
      };
    }
    case 'GATEWAY_EXISTS':
      return {
        title: 'Gateway EUI duplicado',
        body: 'Este Gateway EUI ya está registrado en SYSCOM IoT (en su cuenta o en otra). Cada gateway debe tener un EUI único en todo el sistema.',
      };
    case 'DEVICE_EXISTS':
      return {
        title: 'Dispositivo ya registrado',
        body: 'Ya hay un dispositivo con este identificador o DevEUI en la plataforma. Verifique el valor o use el equipo existente; no se puede registrar dos veces el mismo dispositivo.',
      };
    case 'TEMPLATE_MODEL_EXISTS': {
      const m = ctx.conflictModelo != null ? String(ctx.conflictModelo).trim() : '';
      const br = ctx.conflictMarca != null ? String(ctx.conflictMarca).trim() : '';
      const ref = m ? `«${m}»${br ? ` (${br})` : ''}` : 'el mismo nombre de modelo';
      return {
        title: 'Modelo de plantilla duplicado',
        body: `Ya existe una plantilla con ${ref} en el catálogo (incluidas las predefinidas del sistema). Cada modelo debe ser único. Elija otro modelo o edite la plantilla existente. El alta no se ha guardado.`,
      };
    }
    default:
      return null;
  }
}

/** @param {string} [code] */
export function isDuplicateEntityCode(code) {
  return (
    code === 'USER_EXISTS' ||
    code === 'GATEWAY_EXISTS' ||
    code === 'DEVICE_EXISTS' ||
    code === 'TEMPLATE_MODEL_EXISTS'
  );
}
