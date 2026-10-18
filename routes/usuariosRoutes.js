// routes/usuariosRoutes.js — Gestión de usuarios (gerencia/dirección)
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../config/database');
const { verifyToken, verifyRole } = require('../middleware/auth');
const { accesoVigente } = require('../middleware/usuarioVigente');
const { isValidEmail, isValidName, isValidPhone } = require('../middleware/validation');
const Usuario = require('../models/Usuario');
const { registrarAuditoria } = require('../utils/auditoria');

const MSG_ULTIMA_DIRECCION = 'Debe quedar al menos una cuenta de Dirección General activa';

// Permisos con el rol leído de la base (no del JWT): una cuenta degradada o
// desactivada no administra personal con su token viejo
const SOLO_DIRECCION = accesoVigente(['direccion_general']);
const GERENCIA_O_DIRECCION = accesoVigente(['gerencia', 'direccion_general']);
const ROLES_PERSONAL = ['empleado', 'gerencia', 'repartidor', 'hornos', 'decoracion', 'direccion_general'];
// Gerencia administra al personal operativo; las cuentas de Gerencia y de
// Dirección General solo las toca Dirección General (Diseno_Panel_Personal.md §4.8)
const ROLES_OPERATIVOS = ['empleado', 'repartidor', 'hornos', 'decoracion'];
const MAX_PUESTO = 100;

// Contraseña temporal de 12 caracteres sin los que se confunden (0/O, 1/l/I)
// y sin símbolos: el sanitizador de las peticiones los alteraría al iniciar sesión
const CARACTERES_CONTRASENA = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function contrasenaTemporal() {
  for (;;) {
    let contrasena = '';
    for (let i = 0; i < 12; i++) contrasena += CARACTERES_CONTRASENA.charAt(crypto.randomInt(CARACTERES_CONTRASENA.length));
    if (/[a-z]/.test(contrasena) && /[A-Z]/.test(contrasena) && /\d/.test(contrasena)) return contrasena;
  }
}

/** Puesto opcional: texto de hasta 100 caracteres; vacío = null. undefined si no es válido */
function puestoDe(valor) {
  if (valor === null || valor === undefined) return null;
  if (typeof valor !== 'string') return undefined;
  const limpio = valor.trim();
  if (limpio === '') return null;
  return limpio.length <= MAX_PUESTO ? limpio : undefined;
}

/** Teléfono opcional: 10 dígitos (se ignoran espacios y guiones); vacío = null. undefined si no es válido */
function telefonoDe(valor) {
  if (valor === null || valor === undefined) return null;
  if (typeof valor !== 'string' && typeof valor !== 'number') return undefined;
  const digitos = String(valor).replace(/[\s-]/g, '');
  if (digitos === '') return null;
  return isValidPhone(digitos) ? digitos : undefined;
}

// El :id llega como texto: se normaliza a número para compararlo con el del
// token (si no, "0924" esquivaría la regla de "no sobre tu propia cuenta").
function idDeRuta(valor) {
  return /^\d{1,9}$/.test(valor) ? Number(valor) : null;
}

// Bloquea la cuenta junto con las de Dirección General activas, en orden de
// id: dos cambios simultáneos se forman en fila (sin interbloqueo) y ninguno
// puede dejar el sistema sin Dirección General.
async function bloquearCuenta(client, id) {
  const { rows } = await client.query(
    `SELECT id, nombre, apellido, rol::text AS rol, activo
       FROM core.tblusuarios
      WHERE id = $1 OR (rol = 'direccion_general' AND activo = TRUE)
      ORDER BY id
      FOR UPDATE`,
    [id]
  );
  const usuario = rows.find(r => r.id === id) || null;
  return { usuario, otrasDirecciones: rows.length - (usuario ? 1 : 0) };
}

// Listar usuarios
router.get('/', verifyToken, verifyRole('gerencia', 'direccion_general'), async (req, res) => {
  try {
    const { rol, busqueda, activo } = req.query;
    let query = `SELECT id, nombre, apellido, email, telefono, rol, activo, email_verificado, avatar_url, puesto, google_id, created_at, ultimo_acceso FROM core.tblusuarios WHERE 1=1`;
    const params = [];
    let pi = 1;
    if (rol) { query += ` AND rol = $${pi}`; params.push(rol); pi++; }
    if (activo !== undefined) { query += ` AND activo = $${pi}`; params.push(activo === 'true'); pi++; }
    if (busqueda) { query += ` AND (nombre ILIKE $${pi} OR apellido ILIKE $${pi} OR email ILIKE $${pi})`; params.push(`%${busqueda}%`); pi++; }
    query += ' ORDER BY created_at DESC';
    const result = await pool.query(query, params);
    res.json({ success: true, usuarios: result.rows });
  } catch (error) {
    console.error('Error GET /usuarios:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener usuarios' });
  }
});

// Dar de alta a una persona del equipo (Diseno_Panel_Direccion.md §4.4).
// La cuenta nace activa y con el correo verificado; la contraseña temporal
// se devuelve una sola vez y en la base solo queda su hash. Gerencia solo da
// de alta a personal operativo.
router.post('/', GERENCIA_O_DIRECCION, async (req, res) => {
  try {
    const { nombre, apellido, email, rol } = req.body;
    const nombreLimpio = typeof nombre === 'string' ? nombre.trim() : '';
    const apellidoLimpio = typeof apellido === 'string' ? apellido.trim() : '';
    const correo = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const puesto = puestoDe(req.body.puesto);
    const telefono = telefonoDe(req.body.telefono);
    if (!isValidName(nombreLimpio)) return res.status(400).json({ success: false, message: 'El nombre debe tener entre 2 y 50 letras' });
    if (!isValidName(apellidoLimpio)) return res.status(400).json({ success: false, message: 'El apellido debe tener entre 2 y 50 letras' });
    if (!correo || correo.length > 255 || !isValidEmail(correo)) return res.status(400).json({ success: false, message: 'El correo no es válido' });
    if (!ROLES_PERSONAL.includes(rol)) return res.status(400).json({ success: false, message: `Rol inválido. Valores: ${ROLES_PERSONAL.join(', ')}` });
    if (req.usuario.rol === 'gerencia' && !ROLES_OPERATIVOS.includes(rol)) {
      return res.status(403).json({ success: false, message: 'Gerencia solo puede dar de alta a empleados, repartidores, hornos y decoración' });
    }
    if (puesto === undefined) return res.status(400).json({ success: false, message: `El puesto debe ser un texto de hasta ${MAX_PUESTO} caracteres` });
    if (telefono === undefined) return res.status(400).json({ success: false, message: 'El teléfono debe tener exactamente 10 dígitos' });

    const existente = await pool.query('SELECT 1 FROM core.tblusuarios WHERE LOWER(email) = $1', [correo]);
    if (existente.rows.length > 0) return res.status(409).json({ success: false, message: 'Ya existe una cuenta con ese correo' });

    const contrasena = contrasenaTemporal();
    const passwordHash = await Usuario.hashPassword(contrasena);
    const result = await pool.query(
      `INSERT INTO core.tblusuarios (nombre, apellido, email, password_hash, telefono, rol, puesto, activo, email_verificado, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, TRUE, NOW(), NOW())
       RETURNING id, nombre, apellido, email, telefono, rol::text AS rol, puesto, activo, email_verificado, created_at`,
      [nombreLimpio, apellidoLimpio, correo, passwordHash, telefono, rol, puesto]
    );
    const usuario = result.rows[0];
    registrarAuditoria({ usuario_id: req.usuario.id, accion: 'Dio de alta a personal', entidad: 'usuario', entidad_id: usuario.id, detalles: `${usuario.nombre} ${usuario.apellido} · ${usuario.rol}`, ip: req.ip });
    res.status(201).json({ success: true, usuario, contrasena_temporal: contrasena, message: 'Cuenta creada. Comparte la contraseña temporal: no se volverá a mostrar.' });
  } catch (error) {
    // Dos altas simultáneas con el mismo correo: la segunda choca con el índice único
    if (error.code === '23505') return res.status(409).json({ success: false, message: 'Ya existe una cuenta con ese correo' });
    console.error('Error POST /usuarios:', error.message);
    res.status(500).json({ success: false, message: 'Error al dar de alta a la persona' });
  }
});

// Editar puesto y teléfono de una persona del equipo. Solo cambia lo que
// viene en el cuerpo; null o "" lo dejan vacío. Gerencia, solo del personal
// operativo.
router.put('/:id', GERENCIA_O_DIRECCION, async (req, res) => {
  try {
    const id = idDeRuta(req.params.id);
    if (!id) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
    const traePuesto = Object.prototype.hasOwnProperty.call(req.body, 'puesto');
    const traeTelefono = Object.prototype.hasOwnProperty.call(req.body, 'telefono');
    if (!traePuesto && !traeTelefono) return res.status(400).json({ success: false, message: 'Indica el puesto o el teléfono' });
    const puesto = traePuesto ? puestoDe(req.body.puesto) : null;
    const telefono = traeTelefono ? telefonoDe(req.body.telefono) : null;
    if (puesto === undefined) return res.status(400).json({ success: false, message: `El puesto debe ser un texto de hasta ${MAX_PUESTO} caracteres` });
    if (telefono === undefined) return res.status(400).json({ success: false, message: 'El teléfono debe tener exactamente 10 dígitos' });

    const previo = await pool.query('SELECT nombre, apellido, rol::text AS rol, puesto, telefono FROM core.tblusuarios WHERE id = $1', [id]);
    const antes = previo.rows[0];
    if (!antes) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
    if (antes.rol === 'cliente') return res.status(400).json({ success: false, message: 'Solo se edita el puesto y el teléfono de las personas del equipo' });
    if (req.usuario.rol === 'gerencia' && !ROLES_OPERATIVOS.includes(antes.rol)) {
      return res.status(403).json({ success: false, message: 'Solo Dirección General puede editar cuentas de Gerencia o Dirección General' });
    }

    const cambios = [];
    if (traePuesto && puesto !== antes.puesto) cambios.push(`puesto: ${antes.puesto || 'sin puesto'} → ${puesto || 'sin puesto'}`);
    if (traeTelefono && telefono !== antes.telefono) cambios.push(`teléfono: ${antes.telefono || 'sin teléfono'} → ${telefono || 'sin teléfono'}`);

    const result = await pool.query(
      `UPDATE core.tblusuarios
          SET puesto = CASE WHEN $2::boolean THEN $3::varchar ELSE puesto END,
              telefono = CASE WHEN $4::boolean THEN $5::varchar ELSE telefono END,
              updated_at = CASE WHEN $6::boolean THEN NOW() ELSE updated_at END
        WHERE id = $1
        RETURNING id, nombre, apellido, email, rol::text AS rol, puesto, telefono`,
      [id, traePuesto, puesto, traeTelefono, telefono, cambios.length > 0]
    );
    if (cambios.length > 0) {
      registrarAuditoria({ usuario_id: req.usuario.id, accion: 'Editó datos de personal', entidad: 'usuario', entidad_id: id, detalles: `${antes.nombre} ${antes.apellido} · ${cambios.join(' · ')}`, ip: req.ip });
    }
    res.json({ success: true, usuario: result.rows[0], message: cambios.length > 0 ? 'Datos actualizados' : 'Sin cambios' });
  } catch (error) {
    console.error('Error PUT /usuarios/:id:', error.message);
    res.status(500).json({ success: false, message: 'Error al actualizar los datos' });
  }
});

// Detalle de usuario. La propia cuenta la lee cualquiera con sesión (Mi
// cuenta y «Mi acceso por voz»); la de otra persona, gerencia o dirección
const DETALLE_AJENO = verifyRole('gerencia', 'direccion_general');
const propiaOGerencia = (req, res, next) => (idDeRuta(req.params.id) === Number(req.user.userId) ? next() : DETALLE_AJENO(req, res, next));
router.get('/:id', verifyToken, propiaOGerencia, async (req, res) => {
  try {
    const id = idDeRuta(req.params.id);
    if (!id) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
    const result = await pool.query(
      `SELECT id, nombre, apellido, email, telefono, rol, activo, email_verificado, avatar_url, puesto, permisos, google_id, created_at, updated_at, ultimo_acceso,
              codigo_empleado, intentos_pin_fallidos, pin_bloqueado_hasta, pin_actualizado_at,
              (pin_hash IS NOT NULL) AS tiene_pin
         FROM core.tblusuarios WHERE id = $1`,
      [id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
    res.json({ success: true, usuario: result.rows[0] });
  } catch (error) {
    console.error('Error GET /usuarios/:id:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener usuario' });
  }
});

// Cambiar rol (solo Dirección General vigente: una cuenta de dirección
// degradada no sube a otras con su token viejo)
router.put('/:id/rol', SOLO_DIRECCION, async (req, res) => {
  let client;
  try {
    const { rol } = req.body;
    const validos = ['cliente', 'empleado', 'repartidor', 'gerencia', 'direccion_general', 'hornos', 'decoracion'];
    if (!validos.includes(rol)) return res.status(400).json({ success: false, message: `Rol inválido. Valores: ${validos.join(', ')}` });
    const id = idDeRuta(req.params.id);
    if (!id) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
    if (id === req.usuario.id) return res.status(400).json({ success: false, message: 'No puedes cambiar tu propio rol' });

    client = await pool.connect();
    await client.query('BEGIN');
    const { usuario, otrasDirecciones } = await bloquearCuenta(client, id);
    if (!usuario) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'Usuario no encontrado' }); }
    if (usuario.rol === 'direccion_general' && rol !== 'direccion_general' && otrasDirecciones === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: MSG_ULTIMA_DIRECCION });
    }
    // Sin cambio real no se escribe: la auditoría no registra "X → X"
    const cambia = usuario.rol !== rol;
    if (cambia) await client.query('UPDATE core.tblusuarios SET rol = $1, updated_at = NOW() WHERE id = $2', [rol, id]);
    await client.query('COMMIT');

    if (cambia) {
      registrarAuditoria({ usuario_id: req.usuario.id, accion: 'Cambió rol de usuario', entidad: 'usuario', entidad_id: id, detalles: `${usuario.nombre} ${usuario.apellido} · ${usuario.rol} → ${rol}`, ip: req.ip });
    }
    res.json({ success: true, usuario: { id, nombre: usuario.nombre, apellido: usuario.apellido, rol }, message: `Rol cambiado a ${rol}` });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Error PUT /usuarios/:id/rol:', error.message);
    res.status(500).json({ success: false, message: 'Error al cambiar rol' });
  } finally {
    if (client) client.release();
  }
});

// Activar/desactivar usuario (rol leído de la base: un gerente degradado ya
// no administra personal con su token viejo)
router.put('/:id/estado', GERENCIA_O_DIRECCION, async (req, res) => {
  let client;
  try {
    const { activo } = req.body;
    if (typeof activo !== 'boolean') return res.status(400).json({ success: false, message: 'El campo activo debe ser booleano (true o false)' });
    const id = idDeRuta(req.params.id);
    if (!id) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
    // También se bloquea reactivarse: solo podría hacerlo alguien ya dado de
    // baja usando un token emitido antes de la baja
    if (id === req.usuario.id) return res.status(400).json({ success: false, message: 'No puedes cambiar el estado de tu propia cuenta' });

    client = await pool.connect();
    await client.query('BEGIN');
    const { usuario, otrasDirecciones } = await bloquearCuenta(client, id);
    if (!usuario) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'Usuario no encontrado' }); }
    // Gerencia administra al personal, no a sus pares ni a Dirección
    if (req.usuario.rol === 'gerencia' && ['gerencia', 'direccion_general'].includes(usuario.rol)) {
      await client.query('ROLLBACK');
      return res.status(403).json({ success: false, message: 'Solo Dirección General puede activar o desactivar cuentas de Gerencia o Dirección General' });
    }
    const cambia = usuario.activo !== activo;
    if (cambia && !activo && usuario.rol === 'direccion_general' && otrasDirecciones === 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: MSG_ULTIMA_DIRECCION });
    }
    if (cambia) await client.query('UPDATE core.tblusuarios SET activo = $1, updated_at = NOW() WHERE id = $2', [activo, id]);
    await client.query('COMMIT');

    if (cambia) {
      registrarAuditoria({ usuario_id: req.usuario.id, accion: activo ? 'Reactivó usuario' : 'Desactivó usuario', entidad: 'usuario', entidad_id: id, detalles: `${usuario.nombre} ${usuario.apellido} · ${usuario.rol}`, ip: req.ip });
    }
    res.json({ success: true, usuario: { id, nombre: usuario.nombre, activo }, message: activo ? 'Usuario activado' : 'Usuario desactivado' });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Error PUT /usuarios/:id/estado:', error.message);
    res.status(500).json({ success: false, message: 'Error al cambiar estado' });
  } finally {
    if (client) client.release();
  }
});

// Restablecer la contraseña de una persona del equipo
// (Diseno_Panel_Personal.md §4.8): se genera una temporal, la anterior deja
// de servir y la nueva se muestra una sola vez (en la base solo queda su
// hash). Las sesiones abiertas siguen hasta que expiren.
router.post('/:id/contrasena-temporal', GERENCIA_O_DIRECCION, async (req, res) => {
  try {
    const id = idDeRuta(req.params.id);
    if (!id) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
    if (id === req.usuario.id) return res.status(400).json({ success: false, message: 'Para cambiar tu propia contraseña usa “¿Olvidaste tu contraseña?”' });

    const previo = await pool.query('SELECT id, nombre, apellido, email, rol::text AS rol, activo FROM core.tblusuarios WHERE id = $1', [id]);
    const usuario = previo.rows[0];
    if (!usuario) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
    if (usuario.rol === 'cliente') return res.status(400).json({ success: false, message: 'Solo se restablece la contraseña del personal' });
    if (req.usuario.rol === 'gerencia' && !ROLES_OPERATIVOS.includes(usuario.rol)) {
      return res.status(403).json({ success: false, message: 'Solo Dirección General puede restablecer la contraseña de Gerencia o Dirección General' });
    }
    if (!usuario.activo) return res.status(400).json({ success: false, message: 'Activa la cuenta antes de restablecer su contraseña' });

    const contrasena = contrasenaTemporal();
    const passwordHash = await Usuario.hashPassword(contrasena);
    await pool.query('UPDATE core.tblusuarios SET password_hash = $1, updated_at = NOW() WHERE id = $2', [passwordHash, id]);
    registrarAuditoria({ usuario_id: req.usuario.id, accion: 'Restableció contraseña de personal', entidad: 'usuario', entidad_id: id, detalles: `${usuario.nombre} ${usuario.apellido} · ${usuario.rol}`, ip: req.ip });
    res.json({
      success: true,
      usuario: { id: usuario.id, nombre: usuario.nombre, apellido: usuario.apellido, email: usuario.email, rol: usuario.rol },
      contrasena_temporal: contrasena,
      message: 'Contraseña restablecida. Compártela: no se volverá a mostrar.',
    });
  } catch (error) {
    console.error('Error POST /usuarios/:id/contrasena-temporal:', error.message);
    res.status(500).json({ success: false, message: 'Error al restablecer la contraseña' });
  }
});

// Actualizar perfil propio
router.put('/perfil/actualizar', verifyToken, async (req, res) => {
  try {
    const { nombre, apellido, telefono, avatar_url } = req.body;
    const result = await pool.query(
      `UPDATE core.tblusuarios SET nombre=COALESCE($1,nombre), apellido=COALESCE($2,apellido), telefono=COALESCE($3,telefono), avatar_url=COALESCE($4,avatar_url), updated_at=NOW()
       WHERE id=$5 RETURNING id, nombre, apellido, email, telefono, avatar_url, rol`,
      [nombre, apellido, telefono, avatar_url, req.user.userId]
    );
    res.json({ success: true, user: result.rows[0] });
  } catch (error) {
    console.error('Error PUT /usuarios/perfil/actualizar:', error.message);
    res.status(500).json({ success: false, message: 'Error al actualizar perfil' });
  }
});

module.exports = router;