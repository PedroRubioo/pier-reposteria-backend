// routes/reembolsosRoutes.js — Reembolsos
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { verifyToken, verifyRole } = require('../middleware/auth');

// Solicitar reembolso (cliente)
router.post('/', verifyToken, async (req, res) => {
  try {
    const { pedido_id, producto_id, monto, motivo, descripcion, fotos_evidencia } = req.body;
    if (!pedido_id || !monto || !motivo) return res.status(400).json({ success: false, message: 'Pedido, monto y motivo son requeridos' });

    // Verificar que el pedido pertenece al usuario y está completado
    const pedido = await pool.query('SELECT id, estado FROM core.tblpedidos WHERE id = $1 AND usuario_id = $2', [pedido_id, req.user.userId]);
    if (pedido.rows.length === 0) return res.status(404).json({ success: false, message: 'Pedido no encontrado' });
    if (pedido.rows[0].estado !== 'completado') return res.status(400).json({ success: false, message: 'Solo se pueden reembolsar pedidos completados' });

    const result = await pool.query(
      `INSERT INTO core.tblreembolsos (pedido_id, producto_id, usuario_id, monto, motivo, descripcion, fotos_evidencia, estado, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pendiente',NOW(),NOW()) RETURNING *`,
      [pedido_id, producto_id || null, req.user.userId, monto, motivo, descripcion || null, fotos_evidencia || null]
    );
    res.status(201).json({ success: true, reembolso: result.rows[0] });
  } catch (error) {
    console.error('Error POST /reembolsos:', error.message);
    res.status(500).json({ success: false, message: 'Error al solicitar reembolso' });
  }
});

// Mis reembolsos (cliente)
router.get('/mis-reembolsos', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT r.*, p.numero AS pedido_numero
      FROM core.tblreembolsos r
      JOIN core.tblpedidos p ON r.pedido_id = p.id
      WHERE r.usuario_id = $1 ORDER BY r.created_at DESC
    `, [req.user.userId]);
    res.json({ success: true, reembolsos: result.rows });
  } catch (error) {
    console.error('Error GET /reembolsos/mis-reembolsos:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener reembolsos' });
  }
});

// Listar todos (empleado+)
router.get('/', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const { estado } = req.query;
    let query = `SELECT r.*, u.nombre AS cliente_nombre, u.apellido AS cliente_apellido, p.numero AS pedido_numero
      FROM core.tblreembolsos r JOIN core.tblusuarios u ON r.usuario_id = u.id JOIN core.tblpedidos p ON r.pedido_id = p.id`;
    const params = [];
    if (estado) { query += ' WHERE r.estado = $1'; params.push(estado); }
    query += ' ORDER BY r.created_at DESC';
    const result = await pool.query(query, params);
    res.json({ success: true, reembolsos: result.rows });
  } catch (error) {
    console.error('Error GET /reembolsos:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener reembolsos' });
  }
});

// Gestionar reembolso (empleado+)
router.put('/:id', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const { estado, justificacion_rechazo, respuesta_admin } = req.body;
    if (!['en_revision', 'aprobado', 'rechazado', 'procesado'].includes(estado)) return res.status(400).json({ success: false, message: 'Estado inválido' });

    let query = 'UPDATE core.tblreembolsos SET estado=$1, respuesta_admin=$2, updated_at=NOW()';
    const params = [estado, respuesta_admin || null];
    let pi = 3;
    if (estado === 'rechazado') { query += `, justificacion_rechazo=$${pi}`; params.push(justificacion_rechazo || null); pi++; }
    if (['aprobado', 'rechazado', 'procesado'].includes(estado)) { query += `, fecha_resolucion=NOW()`; }
    query += ` WHERE id=$${pi} RETURNING *`;
    params.push(req.params.id);

    // Si se aprueba, actualizar estado del pago
    if (estado === 'procesado') {
      const reembolso = await pool.query('SELECT pedido_id FROM core.tblreembolsos WHERE id = $1', [req.params.id]);
      if (reembolso.rows.length > 0) {
        await pool.query('UPDATE core.tblpagos SET estado = $1, reembolsado_at = NOW() WHERE pedido_id = $2', ['reembolsado', reembolso.rows[0].pedido_id]);
      }
    }

    const result = await pool.query(query, params);
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Reembolso no encontrado' });

    // Crear notificación para el cliente
    const reembolso = result.rows[0];
    const pedidoInfo = await pool.query('SELECT usuario_id, numero FROM core.tblpedidos WHERE id = $1', [reembolso.pedido_id]);
    if (pedidoInfo.rows.length > 0) {
      const clienteId = pedidoInfo.rows[0].usuario_id;
      const pedidoNumero = pedidoInfo.rows[0].numero;
      let titulo = '', mensaje = '', tipo = 'sistema';
      if (estado === 'aprobado') {
        titulo = 'Reembolso aprobado';
        mensaje = `Tu solicitud de reembolso del pedido #${pedidoNumero} por $${reembolso.monto} ha sido aprobada.`;
        tipo = 'pago';
      } else if (estado === 'rechazado') {
        titulo = 'Reembolso rechazado';
        mensaje = `Tu solicitud de reembolso del pedido #${pedidoNumero} ha sido rechazada. ${justificacion_rechazo || ''}`.trim();
        tipo = 'sistema';
      } else if (estado === 'en_revision') {
        titulo = 'Reembolso en revisión';
        mensaje = `Tu solicitud de reembolso del pedido #${pedidoNumero} está siendo revisada.`;
        tipo = 'sistema';
      }
      if (titulo) {
        const { notificarConEmail } = require('../services/notificacionHelper');
        // Email para aprobado y rechazado (son decisiones finales)
        if (estado === 'aprobado' || estado === 'rechazado') {
          const userData = await pool.query('SELECT nombre, email FROM core.tblusuarios WHERE id = $1', [clienteId]);
          if (userData.rows.length > 0) {
            const u = userData.rows[0];
            await notificarConEmail({
              usuario_id: clienteId, tipo, titulo, mensaje,
              email: u.email, nombre: u.nombre,
              asunto: estado === 'aprobado' ? `✅ Reembolso aprobado — Pedido #${pedidoNumero}` : `Reembolso rechazado — Pedido #${pedidoNumero}`,
              contenidoHtml: estado === 'aprobado'
                ? `<h2>Tu reembolso ha sido aprobado</h2>
                   <div class="highlight-box">
                     <p><strong>Pedido:</strong> #${pedidoNumero}</p>
                     <p><strong>Monto reembolsado:</strong> $${reembolso.monto} MXN</p>
                   </div>
                   <p>El reembolso se procesará en los próximos días hábiles.</p>`
                : `<h2>Tu solicitud de reembolso no fue aprobada</h2>
                   <div class="highlight-box">
                     <p><strong>Pedido:</strong> #${pedidoNumero}</p>
                     ${justificacion_rechazo ? `<p><strong>Motivo:</strong> ${justificacion_rechazo}</p>` : ''}
                   </div>
                   <p>Si tienes dudas, puedes contactarnos a través de la sección de Contacto.</p>`
            });
          }
        } else {
          await notificarConEmail({ usuario_id: clienteId, tipo, titulo, mensaje });
        }
      }
    }

    res.json({ success: true, reembolso });
  } catch (error) {
    console.error('Error PUT /reembolsos/:id:', error.message);
    res.status(500).json({ success: false, message: 'Error al actualizar reembolso' });
  }
});

module.exports = router;