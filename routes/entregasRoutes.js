// routes/entregasRoutes.js — Asignación y flujo de entregas a domicilio
const express = require('express');
const router = express.Router();
const he = require('he'); // 🔒 SEGURIDAD: sanitización de HTML
const { pool } = require('../config/database');
const { verifyToken, verifyRole } = require('../middleware/auth');
const { notificarConEmail, crearNotificacion } = require('../services/notificacionHelper');

// ── Mis entregas del día (repartidor) ──
router.get('/mis-entregas', verifyToken, verifyRole('repartidor'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT e.id, e.pedido_id, e.estado, e.asignado_at, e.salio_at, e.finalizado_at,
             e.evidencia_url, e.recibio_nombre, e.motivo_fallo,
             p.numero, p.total, p.costo_envio, p.metodo_pago, p.notas,
             p.direccion_entrega, p.horario_entrega,
             u.nombre AS cliente_nombre, u.apellido AS cliente_apellido, u.telefono AS cliente_telefono
      FROM core.tblentregas e
      JOIN core.tblpedidos p ON p.id = e.pedido_id
      JOIN core.tblusuarios u ON u.id = p.usuario_id
      WHERE e.repartidor_id = $1
        AND (e.estado IN ('asignada', 'en_camino') OR e.finalizado_at::date = CURRENT_DATE)
      ORDER BY
        CASE e.estado WHEN 'en_camino' THEN 0 WHEN 'asignada' THEN 1 ELSE 2 END,
        p.horario_entrega NULLS LAST, e.asignado_at
    `, [req.user.userId]);
    res.json({ success: true, entregas: result.rows });
  } catch (error) {
    console.error('Error GET /entregas/mis-entregas:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener entregas' });
  }
});

// ── Pool de pedidos a domicilio listos y sin repartidor (repartidor) ──
router.get('/disponibles', verifyToken, verifyRole('repartidor'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.id AS pedido_id, p.numero, p.total, p.costo_envio, p.notas,
             p.direccion_entrega, p.horario_entrega, p.updated_at,
             u.nombre AS cliente_nombre, u.apellido AS cliente_apellido
      FROM core.tblpedidos p
      JOIN core.tblusuarios u ON u.id = p.usuario_id
      WHERE p.tipo_entrega = 'domicilio' AND p.estado = 'listo'
        AND NOT EXISTS (
          SELECT 1 FROM core.tblentregas e
          WHERE e.pedido_id = p.id AND e.estado IN ('asignada', 'en_camino')
        )
      ORDER BY p.updated_at
    `);
    res.json({ success: true, pedidos: result.rows });
  } catch (error) {
    console.error('Error GET /entregas/disponibles:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener pedidos disponibles' });
  }
});

// ── Aceptar un pedido del pool (repartidor; el primero que acepta gana) ──
router.post('/aceptar', verifyToken, verifyRole('repartidor'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { pedido_id } = req.body;
    if (!pedido_id) return res.status(400).json({ success: false, message: 'pedido_id es requerido' });

    const yo = await client.query('SELECT disponible FROM core.tblusuarios WHERE id = $1', [req.user.userId]);
    if (!yo.rows[0].disponible) {
      return res.status(400).json({ success: false, message: 'Activa tu disponibilidad en Perfil para aceptar entregas' });
    }

    await client.query('BEGIN');
    const pedidoResult = await client.query('SELECT * FROM core.tblpedidos WHERE id = $1 FOR UPDATE', [pedido_id]);
    if (pedidoResult.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'Pedido no encontrado' }); }
    const pedido = pedidoResult.rows[0];
    if (pedido.tipo_entrega !== 'domicilio' || pedido.estado !== 'listo') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Este pedido ya no está disponible' });
    }

    const entregaResult = await client.query(
      `INSERT INTO core.tblentregas (pedido_id, repartidor_id, estado, asignado_por, asignado_at, created_at, updated_at)
       VALUES ($1, $2, 'asignada', $2, NOW(), NOW(), NOW()) RETURNING *`,
      [pedido_id, req.user.userId]
    );
    await client.query(`UPDATE core.tblpedidos SET estado = 'asignado', updated_at = NOW() WHERE id = $1`, [pedido_id]);
    await client.query('COMMIT');

    // Avisar al cliente en el momento de la aceptación (antes solo se
    // enteraba si estaba mirando la página)
    const repData = await pool.query('SELECT nombre FROM core.tblusuarios WHERE id = $1', [req.user.userId]);
    await crearNotificacion({
      usuario_id: pedido.usuario_id,
      tipo: 'pedido',
      titulo: '¡Un repartidor tomó tu pedido!',
      mensaje: `${repData.rows[0]?.nombre || 'Un repartidor'} tomó tu pedido #${pedido.numero} y saldrá pronto rumbo a tu domicilio.`,
    });

    res.status(201).json({ success: true, entrega: entregaResult.rows[0], message: `Tomaste el pedido #${pedido.numero}` });
  } catch (error) {
    await client.query('ROLLBACK');
    // El índice único de entrega activa por pedido resuelve la carrera entre repartidores
    if (error.code === '23505') {
      return res.status(409).json({ success: false, message: 'Otro repartidor ya tomó este pedido' });
    }
    console.error('Error POST /entregas/aceptar:', error.message);
    res.status(500).json({ success: false, message: 'Error al aceptar el pedido' });
  } finally { client.release(); }
});

// ── Avisar demora al cliente cuando no hay repartidores (empleado+) ──
router.post('/avisar-demora', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const { pedido_id } = req.body;
    if (!pedido_id) return res.status(400).json({ success: false, message: 'pedido_id es requerido' });
    const result = await pool.query(
      `SELECT p.numero, p.usuario_id, p.tipo_entrega, p.estado, p.direccion_entrega, u.nombre, u.email
       FROM core.tblpedidos p JOIN core.tblusuarios u ON u.id = p.usuario_id WHERE p.id = $1`,
      [pedido_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Pedido no encontrado' });
    const p = result.rows[0];
    if (p.tipo_entrega !== 'domicilio' || p.estado !== 'listo') {
      return res.status(400).json({ success: false, message: 'Solo aplica a pedidos a domicilio en espera de repartidor' });
    }

    const safeNumero = he.escape(String(p.numero));
    await notificarConEmail({
      usuario_id: p.usuario_id,
      tipo: 'pedido',
      titulo: 'Tu pedido tardará un poco más',
      mensaje: `Tenemos alta demanda de entregas en este momento. Tu pedido #${p.numero} está listo y saldrá en camino en cuanto se libere un repartidor. ¡Gracias por tu paciencia!`,
      email: p.email,
      nombre: p.nombre,
      asunto: `🍰 Tu pedido #${safeNumero} va un poco demorado — Pier Repostería`,
      contenidoHtml: `
        <h2>¡Tu pedido está listo, pero va un poco demorado!</h2>
        <div class="highlight-box">
          <p><strong>Pedido:</strong> #${safeNumero}</p>
        </div>
        <p>Tenemos alta demanda de entregas en este momento. Tu pedido saldrá en camino en cuanto se libere un repartidor.</p>
        <p>Agradecemos tu paciencia. ¡Vale la pena la espera! 🧁</p>
      `,
    });
    const { registrarAuditoria } = require('../utils/auditoria');
    const destinoDemora = p.direccion_entrega ? `${p.direccion_entrega.colonia || ''}${p.direccion_entrega.zona ? ` (${p.direccion_entrega.zona})` : ''}` : 'sin dirección';
    registrarAuditoria({ usuario_id: req.user.userId, accion: 'Avisó demora al cliente', entidad: 'pedido', entidad_id: pedido_id, detalles: `#${p.numero} · destino: ${destinoDemora}` });
    res.json({ success: true, message: `Aviso de demora enviado al cliente del pedido #${p.numero}` });
  } catch (error) {
    console.error('Error POST /entregas/avisar-demora:', error.message);
    res.status(500).json({ success: false, message: 'Error al enviar el aviso' });
  }
});

// ── Repartidores con su carga actual (para el combo de asignación) ──
router.get('/repartidores', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.nombre, u.apellido, u.telefono, u.disponible,
             COUNT(e.id) FILTER (WHERE e.estado IN ('asignada', 'en_camino')) AS entregas_activas
      FROM core.tblusuarios u
      LEFT JOIN core.tblentregas e ON e.repartidor_id = u.id
      WHERE u.rol = 'repartidor' AND u.activo = TRUE
      GROUP BY u.id
      ORDER BY u.disponible DESC, entregas_activas, u.nombre
    `);
    res.json({ success: true, repartidores: result.rows });
  } catch (error) {
    console.error('Error GET /entregas/repartidores:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener repartidores' });
  }
});

// ── Consultar mi disponibilidad (repartidor) ──
router.get('/disponibilidad', verifyToken, verifyRole('repartidor'), async (req, res) => {
  try {
    const result = await pool.query('SELECT disponible FROM core.tblusuarios WHERE id = $1', [req.user.userId]);
    res.json({ success: true, disponible: result.rows[0].disponible });
  } catch (error) {
    console.error('Error GET /entregas/disponibilidad:', error.message);
    res.status(500).json({ success: false, message: 'Error al consultar disponibilidad' });
  }
});

// ── Cambiar mi disponibilidad (repartidor) ──
router.put('/disponibilidad', verifyToken, verifyRole('repartidor'), async (req, res) => {
  try {
    const { disponible } = req.body;
    if (typeof disponible !== 'boolean') return res.status(400).json({ success: false, message: 'disponible debe ser booleano' });
    const result = await pool.query(
      'UPDATE core.tblusuarios SET disponible = $1, updated_at = NOW() WHERE id = $2 RETURNING id, disponible',
      [disponible, req.user.userId]
    );
    res.json({ success: true, disponible: result.rows[0].disponible, message: disponible ? 'Ahora estás disponible' : 'Marcado como no disponible' });
  } catch (error) {
    console.error('Error PUT /entregas/disponibilidad:', error.message);
    res.status(500).json({ success: false, message: 'Error al cambiar disponibilidad' });
  }
});

// ── Tablero de entregas (empleado+) ──
router.get('/', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const { estado } = req.query;
    let query = `
      SELECT e.*, p.numero, p.total, p.costo_envio, p.direccion_entrega, p.horario_entrega,
             r.nombre AS repartidor_nombre, r.apellido AS repartidor_apellido,
             u.nombre AS cliente_nombre, u.apellido AS cliente_apellido
      FROM core.tblentregas e
      JOIN core.tblpedidos p ON p.id = e.pedido_id
      JOIN core.tblusuarios r ON r.id = e.repartidor_id
      JOIN core.tblusuarios u ON u.id = p.usuario_id
      WHERE 1=1`;
    const params = [];
    if (estado) { query += ' AND e.estado = $1'; params.push(estado); }
    query += ' ORDER BY e.created_at DESC LIMIT 200';
    const result = await pool.query(query, params);
    res.json({ success: true, entregas: result.rows });
  } catch (error) {
    console.error('Error GET /entregas:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener entregas' });
  }
});

// ── Asignar pedido a repartidor (empleado+) ──
router.post('/', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { pedido_id, repartidor_id } = req.body;
    if (!pedido_id || !repartidor_id) return res.status(400).json({ success: false, message: 'pedido_id y repartidor_id son requeridos' });

    await client.query('BEGIN');

    const pedidoResult = await client.query('SELECT * FROM core.tblpedidos WHERE id = $1 FOR UPDATE', [pedido_id]);
    if (pedidoResult.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'Pedido no encontrado' }); }
    const pedido = pedidoResult.rows[0];
    if (pedido.tipo_entrega !== 'domicilio') { await client.query('ROLLBACK'); return res.status(400).json({ success: false, message: 'El pedido es para recoger en sucursal, no se asigna repartidor' }); }
    if (pedido.estado !== 'listo') { await client.query('ROLLBACK'); return res.status(400).json({ success: false, message: `El pedido debe estar en estado "listo" (actual: ${pedido.estado})` }); }

    const repartidorResult = await client.query(
      `SELECT id, nombre, apellido FROM core.tblusuarios WHERE id = $1 AND rol = 'repartidor' AND activo = TRUE AND disponible = TRUE`,
      [repartidor_id]
    );
    if (repartidorResult.rows.length === 0) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, message: 'Repartidor no válido o no disponible' }); }
    const repartidor = repartidorResult.rows[0];

    const entregaResult = await client.query(
      `INSERT INTO core.tblentregas (pedido_id, repartidor_id, estado, asignado_por, asignado_at, created_at, updated_at)
       VALUES ($1, $2, 'asignada', $3, NOW(), NOW(), NOW()) RETURNING *`,
      [pedido_id, repartidor_id, req.user.userId]
    );
    await client.query(`UPDATE core.tblpedidos SET estado = 'asignado', updated_at = NOW() WHERE id = $1`, [pedido_id]);
    await client.query('COMMIT');

    await crearNotificacion({
      usuario_id: repartidor_id,
      tipo: 'pedido',
      titulo: 'Nueva entrega asignada',
      mensaje: `Se te asignó el pedido #${pedido.numero}. Revisa tu panel de entregas.`,
    });

    // El cliente también se entera cuando la asignación es manual
    await crearNotificacion({
      usuario_id: pedido.usuario_id,
      tipo: 'pedido',
      titulo: '¡Un repartidor tomó tu pedido!',
      mensaje: `${repartidor.nombre} llevará tu pedido #${pedido.numero} y saldrá pronto rumbo a tu domicilio.`,
    });

    res.status(201).json({
      success: true,
      entrega: entregaResult.rows[0],
      message: `Pedido #${pedido.numero} asignado a ${repartidor.nombre} ${repartidor.apellido}`,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') {
      return res.status(400).json({ success: false, message: 'El pedido ya tiene una entrega activa' });
    }
    console.error('Error POST /entregas:', error.message);
    res.status(500).json({ success: false, message: 'Error al asignar entrega' });
  } finally { client.release(); }
});

// ── Cambiar estado de MI entrega (repartidor) ──
router.put('/:id/estado', verifyToken, verifyRole('repartidor'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { estado, evidencia_url, recibio_nombre, motivo_fallo } = req.body;

    const transiciones = {
      en_camino: { desde: ['asignada'], pedido: 'en_camino' },
      // 'entregada' también desde 'asignada': el repartidor que acepta
      // estando ya en la zona puede entregar directo sin "salir en camino"
      entregada: { desde: ['asignada', 'en_camino'], pedido: 'entregado' },
      fallida: { desde: ['asignada', 'en_camino'], pedido: 'entrega_fallida' },
    };
    const transicion = transiciones[estado]; // eslint-disable-line security/detect-object-injection
    if (!transicion) return res.status(400).json({ success: false, message: 'Estado inválido. Valores: en_camino, entregada, fallida' });
    if (estado === 'entregada' && !recibio_nombre) return res.status(400).json({ success: false, message: 'Indica quién recibió el pedido' });
    if (estado === 'fallida' && !motivo_fallo) return res.status(400).json({ success: false, message: 'Indica el motivo del fallo' });

    await client.query('BEGIN');

    const entregaResult = await client.query(
      'SELECT * FROM core.tblentregas WHERE id = $1 AND repartidor_id = $2 FOR UPDATE',
      [req.params.id, req.user.userId]
    );
    if (entregaResult.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'Entrega no encontrada' }); }
    const entrega = entregaResult.rows[0];
    if (!transicion.desde.includes(entrega.estado)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: `No se puede pasar de "${entrega.estado}" a "${estado}"` });
    }

    // $1::text en todos los usos: sin el cast, Postgres deduce tipos distintos
    // para el mismo parámetro (varchar en el SET, text en los CASE) y truena con 42P08
    const actualizada = await client.query(`
      UPDATE core.tblentregas
      SET estado = $1::text,
          salio_at = CASE WHEN $1::text = 'en_camino' THEN NOW()
                          WHEN $1::text = 'entregada' THEN COALESCE(salio_at, NOW())
                          ELSE salio_at END,
          finalizado_at = CASE WHEN $1::text IN ('entregada', 'fallida') THEN NOW() ELSE finalizado_at END,
          evidencia_url = COALESCE($2, evidencia_url),
          recibio_nombre = COALESCE($3, recibio_nombre),
          motivo_fallo = COALESCE($4, motivo_fallo),
          updated_at = NOW()
      WHERE id = $5 RETURNING *
    `, [estado, evidencia_url || null, recibio_nombre || null, motivo_fallo || null, req.params.id]);

    const pedidoResult = await client.query(
      'UPDATE core.tblpedidos SET estado = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [transicion.pedido, entrega.pedido_id]
    );
    const pedido = pedidoResult.rows[0];
    await client.query('COMMIT');

    // Notificar al cliente (email solo al salir en camino, que es cuando debe estar pendiente)
    if (estado === 'en_camino') {
      const userData = await pool.query('SELECT nombre, email FROM core.tblusuarios WHERE id = $1', [pedido.usuario_id]);
      if (userData.rows.length > 0) {
        const u = userData.rows[0];
        const safeNumero = he.escape(String(pedido.numero));
        await notificarConEmail({
          usuario_id: pedido.usuario_id,
          tipo: 'pedido',
          titulo: '¡Tu pedido va en camino!',
          mensaje: `Tu pedido #${pedido.numero} salió de la sucursal y va en camino a tu domicilio.`,
          email: u.email,
          nombre: u.nombre,
          asunto: `🛵 ¡Tu pedido #${safeNumero} va en camino! — Pier Repostería`,
          contenidoHtml: `
            <h2>¡Tu pedido va en camino!</h2>
            <div class="highlight-box">
              <p><strong>Pedido:</strong> #${safeNumero}</p>
            </div>
            <p>Nuestro repartidor salió de la sucursal. Ten a la mano tu número de pedido para recibirlo.</p>
          `,
        });
      }
    } else if (estado === 'entregada') {
      // Confirmación de entrega con email: le sirve al cliente de comprobante
      const userData = await pool.query('SELECT nombre, email FROM core.tblusuarios WHERE id = $1', [pedido.usuario_id]);
      const u = userData.rows[0];
      const safeNumero = he.escape(String(pedido.numero));
      const safeRecibio = he.escape(String(recibio_nombre || ''));
      await notificarConEmail({
        usuario_id: pedido.usuario_id,
        tipo: 'pedido',
        titulo: 'Pedido entregado',
        mensaje: `Tu pedido #${pedido.numero} fue entregado${recibio_nombre ? ` (lo recibió ${recibio_nombre})` : ''}. ¡Gracias por tu compra!`,
        email: u?.email,
        nombre: u?.nombre,
        asunto: `✅ Pedido #${safeNumero} entregado — Pier Repostería`,
        contenidoHtml: `
          <h2>¡Tu pedido fue entregado!</h2>
          <div class="highlight-box">
            <p><strong>Pedido:</strong> #${safeNumero}</p>
            ${safeRecibio ? `<p><strong>Lo recibió:</strong> ${safeRecibio}</p>` : ''}
          </div>
          <p>Gracias por tu compra. ¡Buen provecho! 🧁</p>
          <p>¿Nos cuentas cómo estuvo? Deja tu reseña en la web.</p>
        `,
      });
    } else {
      await crearNotificacion({
        usuario_id: pedido.usuario_id,
        tipo: 'alerta',
        titulo: 'No pudimos entregar tu pedido',
        mensaje: `Tu pedido #${pedido.numero} no pudo entregarse: ${motivo_fallo}. Nos pondremos en contacto contigo.`,
      });
    }

    res.json({ success: true, entrega: actualizada.rows[0], pedido, message: 'Entrega actualizada' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error PUT /entregas/:id/estado:', error.message);
    res.status(500).json({ success: false, message: 'Error al actualizar entrega' });
  } finally { client.release(); }
});

// ── "Llegué al domicilio" (repartidor): avisa al cliente SIN cambiar
// el estado — notificación + email de "sal a recibir tu pedido" ──
router.post('/:id/llegue', verifyToken, verifyRole('repartidor'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT e.estado, p.numero, p.usuario_id, u.nombre, u.email
      FROM core.tblentregas e
      JOIN core.tblpedidos p ON p.id = e.pedido_id
      JOIN core.tblusuarios u ON u.id = p.usuario_id
      WHERE e.id = $1 AND e.repartidor_id = $2
    `, [req.params.id, req.user.userId]);
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Entrega no encontrada' });
    const e = result.rows[0];
    if (e.estado !== 'en_camino') {
      return res.status(400).json({ success: false, message: 'Solo puedes avisar llegada cuando vas en camino' });
    }

    const safeNumero = he.escape(String(e.numero));
    await notificarConEmail({
      usuario_id: e.usuario_id,
      tipo: 'pedido',
      titulo: '¡Tu repartidor llegó!',
      mensaje: `Tu repartidor está afuera de tu domicilio con el pedido #${e.numero}. ¡Sal a recibirlo!`,
      email: e.email,
      nombre: e.nombre,
      asunto: `🛵 ¡Tu repartidor llegó! Pedido #${safeNumero} — Pier Repostería`,
      contenidoHtml: `
        <h2>¡Tu repartidor está en tu domicilio!</h2>
        <div class="highlight-box">
          <p><strong>Pedido:</strong> #${safeNumero}</p>
        </div>
        <p>Sal a recibir tu pedido. Ten a la mano tu número de pedido. 🧁</p>
      `,
    });
    res.json({ success: true, message: 'Cliente avisado de tu llegada' });
  } catch (error) {
    console.error('Error POST /entregas/:id/llegue:', error.message);
    res.status(500).json({ success: false, message: 'Error al avisar llegada' });
  }
});

module.exports = router;
