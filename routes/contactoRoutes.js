// routes/contactoRoutes.js — Mensajes de contacto
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { verifyToken, verifyRole } = require('../middleware/auth');

// Enviar mensaje de contacto (público)
router.post('/', async (req, res) => {
  try {
    const { nombre, email, telefono, tipo_producto, mensaje } = req.body;
    if (!nombre || !email || !mensaje) return res.status(400).json({ success: false, message: 'Nombre, email y mensaje son requeridos' });
    const result = await pool.query(
      'INSERT INTO core.tblcontacto_mensajes (nombre, email, telefono, tipo_producto, mensaje, leido, created_at) VALUES ($1,$2,$3,$4,$5,false,NOW()) RETURNING *',
      [nombre, email, telefono || null, tipo_producto || null, mensaje]
    );
    res.status(201).json({ success: true, message: 'Mensaje enviado', contacto: result.rows[0] });
  } catch (error) {
    console.error('Error POST /contacto:', error.message);
    res.status(500).json({ success: false, message: 'Error al enviar mensaje' });
  }
});

// Listar mensajes (empleado+)
router.get('/', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM core.tblcontacto_mensajes ORDER BY created_at DESC');
    res.json({ success: true, mensajes: result.rows });
  } catch (error) {
    console.error('Error GET /contacto:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener mensajes' });
  }
});

// Marcar como leído
router.put('/:id/leer', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    await pool.query('UPDATE core.tblcontacto_mensajes SET leido = true WHERE id = $1', [req.params.id]);
    res.json({ success: true, message: 'Marcado como leído' });
  } catch (error) {
    console.error('Error PUT /contacto/:id/leer:', error.message);
    res.status(500).json({ success: false, message: 'Error al marcar' });
  }
});

module.exports = router;