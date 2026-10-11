// routes/usuariosRoutes.js — Gestión de usuarios (gerencia/dirección)
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { verifyToken, verifyRole } = require('../middleware/auth');
const { registrarAuditoria } = require('../utils/auditoria');

const MSG_ULTIMA_DIRECCION = 'Debe quedar al menos una cuenta de Dirección General activa';

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

// Detalle de usuario
router.get('/:id', verifyToken, verifyRole('gerencia', 'direccion_general'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, nombre, apellido, email, telefono, rol, activo, email_verificado, avatar_url, puesto, permisos, google_id, created_at, updated_at, ultimo_acceso,
              codigo_empleado, intentos_pin_fallidos, pin_bloqueado_hasta, pin_actualizado_at,
              (pin_hash IS NOT NULL) AS tiene_pin
         FROM core.tblusuarios WHERE id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
    res.json({ success: true, usuario: result.rows[0] });
  } catch (error) {
    console.error('Error GET /usuarios/:id:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener usuario' });
  }
});

// Cambiar rol
router.put('/:id/rol', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  let client;
  try {
    const { rol } = req.body;
    const validos = ['cliente', 'empleado', 'repartidor', 'gerencia', 'direccion_general', 'hornos', 'decoracion'];
    if (!validos.includes(rol)) return res.status(400).json({ success: false, message: `Rol inválido. Valores: ${validos.join(', ')}` });
    const id = idDeRuta(req.params.id);
    if (!id) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
    if (id === req.user.userId) return res.status(400).json({ success: false, message: 'No puedes cambiar tu propio rol' });

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
      registrarAuditoria({ usuario_id: req.user.userId, accion: 'Cambió rol de usuario', entidad: 'usuario', entidad_id: id, detalles: `${usuario.nombre} ${usuario.apellido} · ${usuario.rol} → ${rol}` });
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

// Activar/desactivar usuario
router.put('/:id/estado', verifyToken, verifyRole('gerencia', 'direccion_general'), async (req, res) => {
  let client;
  try {
    const { activo } = req.body;
    if (typeof activo !== 'boolean') return res.status(400).json({ success: false, message: 'El campo activo debe ser booleano (true o false)' });
    const id = idDeRuta(req.params.id);
    if (!id) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
    // También se bloquea reactivarse: solo podría hacerlo alguien ya dado de
    // baja usando un token emitido antes de la baja
    if (id === req.user.userId) return res.status(400).json({ success: false, message: 'No puedes cambiar el estado de tu propia cuenta' });

    client = await pool.connect();
    await client.query('BEGIN');
    const { usuario, otrasDirecciones } = await bloquearCuenta(client, id);
    if (!usuario) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'Usuario no encontrado' }); }
    // Gerencia administra al personal, no a sus pares ni a Dirección
    if (req.user.rol === 'gerencia' && ['gerencia', 'direccion_general'].includes(usuario.rol)) {
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
      registrarAuditoria({ usuario_id: req.user.userId, accion: activo ? 'Reactivó usuario' : 'Desactivó usuario', entidad: 'usuario', entidad_id: id, detalles: `${usuario.nombre} ${usuario.apellido} · ${usuario.rol}` });
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