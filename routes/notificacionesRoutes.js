// routes/notificacionesRoutes.js — Notificaciones
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { verifyToken, verifyRole } = require('../middleware/auth');

// Mis notificaciones (cliente)
router.get('/', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM core.tblnotificaciones WHERE usuario_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.user.userId]
    );
    const noLeidas = result.rows.filter(n => !n.leida).length;
    res.json({ success: true, notificaciones: result.rows, no_leidas: noLeidas });
  } catch (error) {
    console.error('Error GET /notificaciones:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener notificaciones' });
  }
});

// Marcar como leída
router.put('/:id/leer', verifyToken, async (req, res) => {
  try {
    await pool.query('UPDATE core.tblnotificaciones SET leida = true WHERE id = $1 AND usuario_id = $2', [req.params.id, req.user.userId]);
    res.json({ success: true, message: 'Marcada como leída' });
  } catch (error) {
    console.error('Error PUT /notificaciones/:id/leer:', error.message);
    res.status(500).json({ success: false, message: 'Error al marcar' });
  }
});

// Marcar todas como leídas
router.put('/leer-todas', verifyToken, async (req, res) => {
  try {
    await pool.query('UPDATE core.tblnotificaciones SET leida = true WHERE usuario_id = $1 AND leida = false', [req.user.userId]);
    res.json({ success: true, message: 'Todas marcadas como leídas' });
  } catch (error) {
    console.error('Error PUT /notificaciones/leer-todas:', error.message);
    res.status(500).json({ success: false, message: 'Error al marcar' });
  }
});

// Enviar notificación masiva (empleado+)
router.post('/enviar', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const { tipo, titulo, mensaje, audiencia, usuario_ids } = req.body;
    if (!tipo || !titulo || !mensaje || !audiencia) return res.status(400).json({ success: false, message: 'Tipo, título, mensaje y audiencia son requeridos' });

    let destinatarios = [];
    if (audiencia === 'todos') {
      const users = await pool.query('SELECT id FROM core.tblusuarios WHERE activo = true');
      destinatarios = users.rows.map(u => u.id);
    } else if (audiencia === 'individual' && usuario_ids) {
      destinatarios = Array.isArray(usuario_ids) ? usuario_ids : [usuario_ids];
    }

    // Insertar notificación para cada destinatario
    for (const uid of destinatarios) {
      await pool.query(
        'INSERT INTO core.tblnotificaciones (usuario_id, tipo, titulo, mensaje, leida, created_at) VALUES ($1,$2,$3,$4,false,NOW())',
        [uid, tipo, titulo, mensaje]
      );
    }

    // Registrar envío
    await pool.query(
      `INSERT INTO core.tblnotificaciones_envios (enviado_por, tipo, titulo, mensaje, audiencia, total_enviados, estado, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,'enviada',NOW())`,
      [req.user.userId, tipo, titulo, mensaje, audiencia, destinatarios.length]
    );

    res.json({ success: true, message: `Notificación enviada a ${destinatarios.length} usuarios` });
  } catch (error) {
    console.error('Error POST /notificaciones/enviar:', error.message);
    res.status(500).json({ success: false, message: 'Error al enviar notificación' });
  }
});

// Historial de envíos (empleado+)
router.get('/envios', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT ne.*, u.nombre AS enviado_por_nombre
      FROM core.tblnotificaciones_envios ne
      LEFT JOIN core.tblusuarios u ON ne.enviado_por = u.id
      ORDER BY ne.created_at DESC LIMIT 50
    `);
    res.json({ success: true, envios: result.rows });
  } catch (error) {
    console.error('Error GET /notificaciones/envios:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener envíos' });
  }
});

module.exports = router;