// routes/configuracionRoutes.js — Configuración del sistema
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { verifyToken, verifyRole } = require('../middleware/auth');

// Leer todas las configuraciones
router.get('/', verifyToken, verifyRole('gerencia', 'direccion_general'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM core.tblconfiguracion_sistema ORDER BY seccion, clave');
    // Agrupar por sección
    const config = {};
    for (const row of result.rows) {
      if (!config[row.seccion]) config[row.seccion] = {};
      config[row.seccion][row.clave] = row.valor;
    }
    res.json({ success: true, configuracion: config, raw: result.rows });
  } catch (error) {
    console.error('Error GET /configuracion:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener configuración' });
  }
});

// Leer configuración por sección
router.get('/:seccion', verifyToken, verifyRole('gerencia', 'direccion_general'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM core.tblconfiguracion_sistema WHERE seccion = $1 ORDER BY clave', [req.params.seccion]);
    const config = {};
    for (const row of result.rows) { config[row.clave] = row.valor; }
    res.json({ success: true, seccion: req.params.seccion, configuracion: config });
  } catch (error) {
    console.error('Error GET /configuracion/:seccion:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener configuración' });
  }
});

// Leer configuración pública (tema activo — sin auth)
router.get('/publica/tema', async (req, res) => {
  try {
    const result = await pool.query("SELECT valor FROM core.tblconfiguracion_sistema WHERE seccion = 'personalizacion' AND clave = 'tema_activo'");
    res.json({ success: true, tema: result.rows.length > 0 ? result.rows[0].valor : null });
  } catch (error) {
    console.error('Error GET /configuracion/publica/tema:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener tema' });
  }
});

// Actualizar configuración
router.put('/', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const { seccion, clave, valor } = req.body;
    if (!seccion || !clave || valor === undefined) return res.status(400).json({ success: false, message: 'Sección, clave y valor son requeridos' });

    const result = await pool.query(
      `INSERT INTO core.tblconfiguracion_sistema (seccion, clave, valor, updated_at, updated_by)
       VALUES ($1, $2, $3, NOW(), $4)
       ON CONFLICT (seccion, clave) DO UPDATE SET valor = $3, updated_at = NOW(), updated_by = $4
       RETURNING *`,
      [seccion, clave, JSON.stringify(valor), req.user.userId]
    );
    res.json({ success: true, configuracion: result.rows[0] });
  } catch (error) {
    console.error('Error PUT /configuracion:', error.message);
    res.status(500).json({ success: false, message: 'Error al actualizar configuración' });
  }
});

module.exports = router;