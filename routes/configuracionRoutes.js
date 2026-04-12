// routes/configuracionRoutes.js — Configuración del sistema
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { verifyToken, verifyRole } = require('../middleware/auth');

// Obtener TODAS las secciones (dirección)
router.get('/', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, seccion, clave, valor, updated_at FROM core.tblconfiguracion_sistema ORDER BY seccion, clave'
    );
    res.json({ success: true, configuraciones: result.rows });
  } catch (error) {
    console.error('Error GET /configuracion:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener configuraciones' });
  }
});

// Obtener toda la configuración de una sección (público)
router.get('/:seccion', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT clave, valor FROM core.tblconfiguracion_sistema WHERE seccion = $1',
      [req.params.seccion]
    );
    const config = {};
    result.rows.forEach(r => { config[r.clave] = r.valor; });
    res.json({ success: true, config });
  } catch (error) {
    console.error('Error GET /configuracion/:seccion:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener configuración' });
  }
});

// Actualizar un valor (dirección)
router.put('/:seccion/:clave', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const { seccion, clave } = req.params;
    const { valor } = req.body;
    if (valor === undefined) return res.status(400).json({ success: false, message: 'Valor es requerido' });
    const result = await pool.query(
      `UPDATE core.tblconfiguracion_sistema SET valor = $1, updated_at = NOW(), updated_by = $2 WHERE seccion = $3 AND clave = $4 RETURNING *`,
      [JSON.stringify(valor), req.user.userId, seccion, clave]
    );
    if (result.rows.length === 0) {
      // Si no existe, crear
      await pool.query(
        'INSERT INTO core.tblconfiguracion_sistema (seccion, clave, valor, updated_by) VALUES ($1, $2, $3, $4)',
        [seccion, clave, JSON.stringify(valor), req.user.userId]
      );
    }
    res.json({ success: true, message: 'Configuración actualizada' });
  } catch (error) {
    console.error('Error PUT /configuracion:', error.message);
    res.status(500).json({ success: false, message: 'Error al actualizar configuración' });
  }
});

// Crear nueva entrada (dirección)
router.post('/', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const { seccion, clave, valor } = req.body;
    if (!seccion || !clave || valor === undefined) return res.status(400).json({ success: false, message: 'Sección, clave y valor son requeridos' });
    const result = await pool.query(
      'INSERT INTO core.tblconfiguracion_sistema (seccion, clave, valor, updated_by) VALUES ($1, $2, $3, $4) RETURNING *',
      [seccion, clave, JSON.stringify(valor), req.user.userId]
    );
    res.status(201).json({ success: true, configuracion: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ success: false, message: 'Ya existe esta configuración' });
    console.error('Error POST /configuracion:', error.message);
    res.status(500).json({ success: false, message: 'Error al crear configuración' });
  }
});

// Eliminar entrada (dirección)
router.delete('/:seccion/:clave', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM core.tblconfiguracion_sistema WHERE seccion = $1 AND clave = $2 RETURNING id',
      [req.params.seccion, req.params.clave]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'No encontrado' });
    res.json({ success: true, message: 'Configuración eliminada' });
  } catch (error) {
    console.error('Error DELETE /configuracion:', error.message);
    res.status(500).json({ success: false, message: 'Error al eliminar configuración' });
  }
});

module.exports = router;
