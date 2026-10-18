// routes/quejasRoutes.js — Quejas y Sugerencias
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { verifyToken, verifyRole } = require('../middleware/auth');
const { registrarAuditoria, recortar } = require('../utils/auditoria');
const { textoLibre, enteroPositivo } = require('../utils/validacionCliente');

function generarTicket() {
  return `QJ-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;
}

// Valores de los enums (Diseno_Panel_Cliente.md §5.9)
const TIPOS_QUEJA = ['queja', 'sugerencia', 'comentario'];
const CATEGORIAS_QUEJA = ['producto', 'servicio', 'plataforma', 'otro'];
const PRIORIDADES_QUEJA = ['alta', 'media', 'baja'];

// Crear queja (cliente). Asunto y descripción con los topes de la app (150 y
// 1000); el pedido, si viene, debe ser del cliente
router.post('/', verifyToken, async (req, res) => {
  try {
    const { pedido_id, tipo, categoria, asunto, descripcion, prioridad } = req.body;
    if (!TIPOS_QUEJA.includes(tipo) || !CATEGORIAS_QUEJA.includes(categoria)) {
      return res.status(400).json({ success: false, message: 'Tipo o categoría no válidos' });
    }
    const asuntoLimpio = textoLibre(asunto, { min: 1, max: 150 });
    if (!asuntoLimpio.ok) return res.status(400).json({ success: false, message: 'Escribe el asunto (hasta 150 caracteres)' });
    const descripcionLimpia = textoLibre(descripcion, { min: 1, max: 1000 });
    if (!descripcionLimpia.ok) return res.status(400).json({ success: false, message: 'Escribe la descripción (hasta 1000 caracteres)' });

    let pedidoId = null;
    if (pedido_id !== undefined && pedido_id !== null && pedido_id !== '') {
      pedidoId = enteroPositivo(pedido_id);
      const propio = pedidoId
        ? await pool.query('SELECT 1 FROM core.tblpedidos WHERE id = $1 AND usuario_id = $2', [pedidoId, req.user.userId])
        : { rows: [] };
      if (propio.rows.length === 0) return res.status(404).json({ success: false, message: 'Pedido no encontrado' });
    }

    const ticket = generarTicket();
    const result = await pool.query(
      `INSERT INTO core.tblquejas (ticket, usuario_id, pedido_id, tipo, categoria, asunto, descripcion, prioridad, estado, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pendiente',NOW(),NOW()) RETURNING *`,
      [ticket, req.user.userId, pedidoId, tipo, categoria, asuntoLimpio.valor, descripcionLimpia.valor, PRIORIDADES_QUEJA.includes(prioridad) ? prioridad : 'media']
    );
    res.status(201).json({ success: true, queja: result.rows[0], message: `Ticket ${ticket} creado` });
  } catch (error) {
    console.error('Error POST /quejas:', error.message);
    res.status(500).json({ success: false, message: 'Error al crear queja' });
  }
});

// Mis quejas (cliente), con el número del pedido al que se refieren
router.get('/mis-quejas', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT q.*, ped.numero AS pedido_numero
         FROM core.tblquejas q LEFT JOIN core.tblpedidos ped ON ped.id = q.pedido_id
        WHERE q.usuario_id = $1 ORDER BY q.created_at DESC`,
      [req.user.userId]
    );
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
    // Teléfono y número de pedido: la pantalla enlaza al pedido exacto y al cliente
    let query = `SELECT q.*, u.nombre AS cliente_nombre, u.apellido AS cliente_apellido, u.email AS cliente_email,
        u.telefono AS cliente_telefono, ped.numero AS pedido_numero
      FROM core.tblquejas q JOIN core.tblusuarios u ON q.usuario_id = u.id
      LEFT JOIN core.tblpedidos ped ON ped.id = q.pedido_id`;
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
    const queja = result.rows[0];
    registrarAuditoria({
      usuario_id: req.user.userId, accion: 'Atendió queja', entidad: 'queja', entidad_id: queja.id,
      detalles: `${queja.ticket} → ${queja.estado}${queja.respuesta ? ` · ${recortar(queja.respuesta, 80)}` : ''}`, ip: req.ip,
    });

    // Notificar al cliente
    const { crearNotificacion } = require('../services/notificacionHelper');
    if (queja.usuario_id) {
      const mensajes = {
        en_proceso: { titulo: 'Tu queja está siendo atendida', mensaje: `Tu queja está siendo revisada por nuestro equipo.${respuesta ? ' Respuesta: ' + respuesta.substring(0, 100) : ''}` },
        resuelto: { titulo: 'Tu queja ha sido resuelta', mensaje: `Tu queja ha sido atendida y marcada como resuelta.${respuesta ? ' Respuesta: ' + respuesta.substring(0, 100) : ''}` }
      };
      // 🔒 SEGURIDAD: estado ya validado con whitelist ['pendiente','en_proceso','resuelto']
      const notif = mensajes[estado]; // eslint-disable-line security/detect-object-injection
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