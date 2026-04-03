// routes/quejasRoutes.js — Quejas y Sugerencias
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { verifyToken, verifyRole } = require('../middleware/auth');

function generarTicket() {
  return `QJ-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;
}

// Crear queja (cliente)
router.post('/', verifyToken, async (req, res) => {
  try {
    const { pedido_id, tipo, categoria, asunto, descripcion, prioridad } = req.body;
    if (!tipo || !categoria || !asunto || !descripcion) return res.status(400).json({ success: false, message: 'Tipo, categoría, asunto y descripción son requeridos' });

    const ticket = generarTicket();
    const result = await pool.query(
      `INSERT INTO core.tblquejas (ticket, usuario_id, pedido_id, tipo, categoria, asunto, descripcion, prioridad, estado, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pendiente',NOW(),NOW()) RETURNING *`,
      [ticket, req.user.userId, pedido_id || null, tipo, categoria, asunto, descripcion, prioridad || 'media']
    );
    res.status(201).json({ success: true, queja: result.rows[0], message: `Ticket ${ticket} creado` });
  } catch (error) {
    console.error('Error POST /quejas:', error.message);
    res.status(500).json({ success: false, message: 'Error al crear queja' });
  }
});

// Mis quejas (cliente)
router.get('/mis-quejas', verifyToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM core.tblquejas WHERE usuario_id = $1 ORDER BY created_at DESC', [req.user.userId]);
    res.json({ success: true, quejas: result.rows });
  } catch (error) {
    console.error('Error GET /quejas/mis-quejas:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener quejas' });
  }
});

// Listar todas (empleado+)
router.get('/', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const { estado } = req.query;
    let query = `SELECT q.*, u.nombre AS cliente_nombre, u.apellido AS cliente_apellido, u.email AS cliente_email
      FROM core.tblquejas q JOIN core.tblusuarios u ON q.usuario_id = u.id`;
    const params = [];
    if (estado) { query += ' WHERE q.estado = $1'; params.push(estado); }
    query += ' ORDER BY q.created_at DESC';
    const result = await pool.query(query, params);
    res.json({ success: true, quejas: result.rows });
  } catch (error) {
    console.error('Error GET /quejas:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener quejas' });
  }
});

// Responder queja (empleado+)
router.put('/:id', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const { estado, respuesta } = req.body;
    if (!['pendiente', 'en_proceso', 'resuelto'].includes(estado)) return res.status(400).json({ success: false, message: 'Estado inválido' });
    const result = await pool.query(
      'UPDATE core.tblquejas SET estado=$1, respuesta=$2, updated_at=NOW() WHERE id=$3 RETURNING *',
      [estado, respuesta || null, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Queja no encontrada' });

    // Notificar al cliente
    const { crearNotificacion } = require('../services/notificacionHelper');
    const queja = result.rows[0];
    if (queja.usuario_id) {
      const mensajes = {
        en_proceso: { titulo: 'Tu queja está siendo atendida', mensaje: `Tu queja está siendo revisada por nuestro equipo.${respuesta ? ' Respuesta: ' + respuesta.substring(0, 100) : ''}` },
        resuelto: { titulo: 'Tu queja ha sido resuelta', mensaje: `Tu queja ha sido atendida y marcada como resuelta.${respuesta ? ' Respuesta: ' + respuesta.substring(0, 100) : ''}` }
      };
      const notif = mensajes[estado];
      if (notif) {
        await crearNotificacion({ usuario_id: queja.usuario_id, tipo: 'sistema', titulo: notif.titulo, mensaje: notif.mensaje });
      }
    }

    res.json({ success: true, queja });
  } catch (error) {
    console.error('Error PUT /quejas/:id:', error.message);
    res.status(500).json({ success: false, message: 'Error al actualizar queja' });
  }
});

module.exports = router;