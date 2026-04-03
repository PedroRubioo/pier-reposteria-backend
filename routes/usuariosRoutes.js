// routes/usuariosRoutes.js — Gestión de usuarios (gerencia/dirección)
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { verifyToken, verifyRole } = require('../middleware/auth');

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
      'SELECT id, nombre, apellido, email, telefono, rol, activo, email_verificado, avatar_url, puesto, permisos, google_id, created_at, updated_at, ultimo_acceso FROM core.tblusuarios WHERE id = $1',
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
  try {
    const { rol } = req.body;
    const validos = ['cliente', 'empleado', 'gerencia', 'direccion_general'];
    if (!validos.includes(rol)) return res.status(400).json({ success: false, message: `Rol inválido. Valores: ${validos.join(', ')}` });
    const result = await pool.query('UPDATE core.tblusuarios SET rol = $1, updated_at = NOW() WHERE id = $2 RETURNING id, nombre, apellido, rol', [rol, req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
    res.json({ success: true, usuario: result.rows[0], message: `Rol cambiado a ${rol}` });
  } catch (error) {
    console.error('Error PUT /usuarios/:id/rol:', error.message);
    res.status(500).json({ success: false, message: 'Error al cambiar rol' });
  }
});

// Activar/desactivar usuario
router.put('/:id/estado', verifyToken, verifyRole('gerencia', 'direccion_general'), async (req, res) => {
  try {
    const { activo } = req.body;
    const result = await pool.query('UPDATE core.tblusuarios SET activo = $1, updated_at = NOW() WHERE id = $2 RETURNING id, nombre, activo', [activo, req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
    res.json({ success: true, usuario: result.rows[0], message: activo ? 'Usuario activado' : 'Usuario desactivado' });
  } catch (error) {
    console.error('Error PUT /usuarios/:id/estado:', error.message);
    res.status(500).json({ success: false, message: 'Error al cambiar estado' });
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