// routes/pedidosRoutes.js — Pedidos
const express = require('express');
const router = express.Router();
const he = require('he'); // 🔒 SEGURIDAD: sanitización de HTML
const { pool } = require('../config/database');
const { verifyToken, verifyRole } = require('../middleware/auth');

function generarNumeroPedido() {
  const fecha = new Date();
  const y = fecha.getFullYear().toString().slice(-2);
  const m = String(fecha.getMonth() + 1).padStart(2, '0');
  const d = String(fecha.getDate()).padStart(2, '0');
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `PIER-${y}${m}${d}-${rand}`;
}

// ── Crear pedido (desde carrito) ──
router.post('/', verifyToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = req.user.userId;
    const { notas, horario_recogida, metodo_pago } = req.body;
    await client.query('BEGIN');
    const carrito = await client.query(`SELECT ci.*, p.nombre, p.precio_chico, p.precio_grande, p.stock_online, p.activo FROM core.tblcarrito_items ci JOIN core.tblproductos p ON ci.producto_id = p.id WHERE ci.usuario_id = $1`, [userId]);
    if (carrito.rows.length === 0) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, message: 'El carrito está vacío' }); }
    let total = 0;
    const items = [];
    for (const item of carrito.rows) {
      if (!item.activo) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, message: `"${item.nombre}" ya no está disponible` }); }
      if (item.stock_online === 0) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, message: `"${item.nombre}" está agotado` }); }
      if (item.stock_online < item.cantidad) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, message: `"${item.nombre}": solo quedan ${item.stock_online} unidades` }); }
      const precio = (item.tamano === 'grande' && item.precio_grande) ? parseFloat(item.precio_grande) : parseFloat(item.precio_chico);
      const subtotal = precio * item.cantidad;
      total += subtotal;
      items.push({ producto_id: item.producto_id, nombre: item.nombre, cantidad: item.cantidad, tamano: item.tamano, precio_unitario: precio, subtotal });
    }
    const numero = generarNumeroPedido();
    // El stock se validó y descontó aquí mismo: el producto ya está hecho
    // y apartado, así que el pedido nace "listo" (solo falta pagar al
    // recogerlo). "pendiente" queda exclusivo de los programados por confirmar.
    const pedidoResult = await client.query(`INSERT INTO core.tblpedidos (numero, usuario_id, total, estado, notas, horario_recogida, metodo_pago, created_at, updated_at) VALUES ($1,$2,$3,'listo',$4,$5,$6,NOW(),NOW()) RETURNING *`, [numero, userId, total, notas || null, horario_recogida || null, metodo_pago || null]);
    const pedido = pedidoResult.rows[0];
    for (const item of items) {
      // Registrar el descuento real por línea: es lo que se repone al cancelar
      const stockResult = await client.query(
        `UPDATE core.tblproductos p
         SET stock_online = GREATEST(p.stock_online - $1, 0), updated_at = NOW()
         FROM (SELECT id, stock_online AS stock_anterior FROM core.tblproductos WHERE id = $2 FOR UPDATE) prev
         WHERE p.id = prev.id
         RETURNING p.stock_online, prev.stock_anterior`,
        [item.cantidad, item.producto_id]
      );
      const stockDescontado = stockResult.rows.length > 0
        ? stockResult.rows[0].stock_anterior - stockResult.rows[0].stock_online
        : 0;
      await client.query(`INSERT INTO core.tblpedido_items (pedido_id, producto_id, nombre_producto, cantidad, tamano, precio_unitario, subtotal, stock_descontado) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [pedido.id, item.producto_id, item.nombre, item.cantidad, item.tamano, item.precio_unitario, item.subtotal, stockDescontado]);
    }
    await client.query('DELETE FROM core.tblcarrito_items WHERE usuario_id = $1', [userId]);
    await client.query(`INSERT INTO core.tblpagos (pedido_id, monto_subtotal, monto_total, estado, created_at) VALUES ($1,$2,$3,'pendiente',NOW())`, [pedido.id, total, total]);
    await client.query('COMMIT');

    // Notificación: pedido creado + email
    const { notificarConEmail } = require('../services/notificacionHelper');
    const userData = await pool.query('SELECT nombre, email FROM core.tblusuarios WHERE id = $1', [userId]);
    if (userData.rows.length > 0) {
      const u = userData.rows[0];

      // 🔒 SEGURIDAD: Sanitizar datos dinámicos antes de insertarlos en HTML
      const safeNumero = he.escape(String(numero));
      const safeTotal = he.escape(total.toFixed(2));
      const safeItemsTexto = he.escape(items.map(i => `${i.nombre} x${i.cantidad}`).join(', '));
      const safeHorario = horario_recogida ? he.escape(String(horario_recogida)) : null;

      await notificarConEmail({
        usuario_id: userId,
        tipo: 'pedido',
        titulo: '¡Pedido recibido!',
        mensaje: `Tu pedido #${numero} por $${total.toFixed(2)} está listo. Pasa a recogerlo cuando gustes y paga en tienda.`,
        email: u.email,
        nombre: u.nombre,
        asunto: `🍰 Pedido #${safeNumero} recibido — Pier Repostería`,
        contenidoHtml: `
          <h2>¡Tu pedido ha sido recibido!</h2>
          <div class="highlight-box">
            <p><strong>Pedido:</strong> #${safeNumero}</p>
            <p><strong>Total:</strong> $${safeTotal} MXN</p>
            <p><strong>Productos:</strong> ${safeItemsTexto}</p>
            ${safeHorario ? `<p><strong>Horario de recogida:</strong> ${safeHorario}</p>` : ''}
          </div>
          <p>Tu pedido ya está listo: pasa a recogerlo a Sucursal Principal, Huejutla de Reyes, y paga ahí mismo. 🧁</p>
          <p><strong>Recuerda:</strong> recoge tu pedido en Sucursal Principal, Huejutla de Reyes.</p>
        `
      });
    }

    res.status(201).json({ success: true, pedido, items, message: `Pedido ${numero} creado` });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error POST /pedidos:', error.message);
    res.status(500).json({ success: false, message: 'Error al crear pedido' });
  } finally { client.release(); }
});

// ── Mis pedidos (cliente) ──
router.get('/mis-pedidos', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, 
        (SELECT json_agg(json_build_object('nombre', pi.nombre_producto, 'cantidad', pi.cantidad, 'tamano', pi.tamano, 'precio_unitario', pi.precio_unitario, 'subtotal', pi.subtotal))
         FROM core.tblpedido_items pi WHERE pi.pedido_id = p.id) AS items,
        pg.estado AS estado_pago, pg.stripe_payment_id
      FROM core.tblpedidos p
      LEFT JOIN core.tblpagos pg ON pg.pedido_id = p.id
      WHERE p.usuario_id = $1
      ORDER BY p.created_at DESC
    `, [req.user.userId]);
    res.json({ success: true, pedidos: result.rows });
  } catch (error) {
    console.error('Error GET /pedidos/mis-pedidos:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener pedidos' });
  }
});

// ── Productos comprados anteriormente (para "Pide de nuevo") ──
router.get('/productos-comprados', verifyToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (pi.producto_id)
        pi.producto_id AS id, pi.nombre_producto AS nombre, pi.tamano, pi.precio_unitario,
        p.imagen_url, p.precio_chico, c.nombre AS categoria
      FROM core.tblpedido_items pi
      JOIN core.tblpedidos ped ON pi.pedido_id = ped.id
      LEFT JOIN core.tblproductos p ON pi.producto_id = p.id
      LEFT JOIN core.tblcategorias c ON p.categoria_id = c.id
      WHERE ped.usuario_id = $1 AND ped.estado IN ('completado', 'entregado')
      ORDER BY pi.producto_id, ped.created_at DESC
      LIMIT 5
    `, [req.user.userId]);
    res.json({ success: true, productos: result.rows });
  } catch (error) {
    console.error('Error GET /pedidos/productos-comprados:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener productos comprados' });
  }
});

// ── Conteo de pedidos por estado (empleado+) ──
// La lista GET / está limitada (limite=100), así que contar sobre ella
// da números incompletos; este conteo es sobre TODOS los pedidos.
router.get('/conteo-estados', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT estado, COUNT(*)::int AS total FROM core.tblpedidos GROUP BY estado'
    );
    res.json({ success: true, conteos: result.rows });
  } catch (error) {
    console.error('Error GET /pedidos/conteo-estados:', error.message);
    res.status(500).json({ success: false, message: 'Error al contar pedidos' });
  }
});

// ── Detalle de pedido (DEBE ir DESPUÉS de las rutas específicas) ──
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const pedido = await pool.query('SELECT * FROM core.tblpedidos WHERE id = $1', [req.params.id]);
    if (pedido.rows.length === 0) return res.status(404).json({ success: false, message: 'Pedido no encontrado' });
    let autorizado = pedido.rows[0].usuario_id === req.user.userId || ['empleado', 'gerencia', 'direccion_general'].includes(req.user.rol);
    if (!autorizado && req.user.rol === 'repartidor') {
      // El repartidor solo puede ver pedidos que tiene (o tuvo) asignados
      const asignacion = await pool.query('SELECT 1 FROM core.tblentregas WHERE pedido_id = $1 AND repartidor_id = $2', [req.params.id, req.user.userId]);
      autorizado = asignacion.rows.length > 0;
    }
    if (!autorizado) {
      return res.status(403).json({ success: false, message: 'Sin permiso' });
    }
    const items = await pool.query('SELECT * FROM core.tblpedido_items WHERE pedido_id = $1', [req.params.id]);
    const pago = await pool.query('SELECT * FROM core.tblpagos WHERE pedido_id = $1', [req.params.id]);
    res.json({ success: true, pedido: pedido.rows[0], items: items.rows, pago: pago.rows[0] || null });
  } catch (error) {
    console.error('Error GET /pedidos/:id:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener pedido' });
  }
});

// ── Listar todos los pedidos (empleado+) ──
router.get('/', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const { estado, limite, offset } = req.query;
    let query = `SELECT p.*, u.nombre AS cliente_nombre, u.apellido AS cliente_apellido, u.email AS cliente_email, pg.estado AS estado_pago, pg.stripe_payment_id, pg.monto_total AS monto_pago,
      r.nombre AS repartidor_nombre, r.apellido AS repartidor_apellido
      FROM core.tblpedidos p
      JOIN core.tblusuarios u ON p.usuario_id = u.id
      LEFT JOIN core.tblpagos pg ON pg.pedido_id = p.id
      LEFT JOIN core.tblentregas e ON e.pedido_id = p.id AND e.estado IN ('asignada', 'en_camino')
      LEFT JOIN core.tblusuarios r ON r.id = e.repartidor_id
      WHERE 1=1`;
    const params = [];
    let pi = 1;
    if (estado) { query += ` AND p.estado = $${pi}`; params.push(estado); pi++; }
    query += ` ORDER BY p.created_at DESC`;
    query += ` LIMIT $${pi} OFFSET $${pi + 1}`;
    params.push(parseInt(String(limite)) || 100, parseInt(String(offset)) || 0);
    const result = await pool.query(query, params);
    res.json({ success: true, pedidos: result.rows });
  } catch (error) {
    console.error('Error GET /pedidos:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener pedidos' });
  }
});

// ── Cambiar estado del pedido (empleado+) ──
router.put('/:id/estado', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { estado, nota_cancelacion } = req.body;
    // Los estados de entrega (asignado/en_camino/entregado/entrega_fallida) los maneja
    // normalmente el flujo de /api/entregas; aquí quedan disponibles como corrección manual.
    const validos = ['pendiente', 'en_preparacion', 'listo', 'completado', 'cancelado', 'asignado', 'en_camino', 'entregado', 'entrega_fallida'];
    if (!validos.includes(estado)) return res.status(400).json({ success: false, message: `Estado inválido. Valores: ${validos.join(', ')}` });

    await client.query('BEGIN');
    const previoResult = await client.query('SELECT estado FROM core.tblpedidos WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (previoResult.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'Pedido no encontrado' }); }
    const estadoPrevio = previoResult.rows[0].estado;

    const updates = [estado];
    let query = 'UPDATE core.tblpedidos SET estado = $1, updated_at = NOW()';
    let pi = 2;
    if (estado === 'cancelado' && nota_cancelacion) { query += `, nota_cancelacion = $${pi}`; updates.push(nota_cancelacion); pi++; }
    query += ` WHERE id = $${pi} RETURNING *`;
    updates.push(req.params.id);
    const result = await client.query(query, updates);

    // Cancelación: reponer el inventario que este pedido descontó.
    // stock_descontado queda en 0 tras reponer, así una re-cancelación no
    // duplica la devolución (y reactivar un cancelado no vuelve a descontar).
    if (estado === 'cancelado' && estadoPrevio !== 'cancelado') {
      await client.query(
        `UPDATE core.tblproductos p
         SET stock_online = p.stock_online + i.stock_descontado, updated_at = NOW()
         FROM core.tblpedido_items i
         WHERE i.pedido_id = $1 AND i.producto_id = p.id AND i.stock_descontado > 0`,
        [req.params.id]
      );
      await client.query('UPDATE core.tblpedido_items SET stock_descontado = 0 WHERE pedido_id = $1', [req.params.id]);
    }
    await client.query('COMMIT');

    // Crear notificación para el cliente
    const pedido = result.rows[0];
    const esDomicilio = pedido.tipo_entrega === 'domicilio';
    const mensajes = {
      en_preparacion: { titulo: 'Pedido en preparación', mensaje: `Tu pedido #${pedido.numero} ha comenzado a prepararse.`, tipo: 'pedido' },
      listo: esDomicilio
        ? { titulo: '¡Tu pedido está listo!', mensaje: `Tu pedido #${pedido.numero} está listo. Pronto saldrá en camino a tu domicilio.`, tipo: 'pedido' }
        : { titulo: '¡Tu pedido está listo!', mensaje: `Tu pedido #${pedido.numero} está listo para recoger en Sucursal Principal.`, tipo: 'pedido' },
      completado: { titulo: 'Pedido completado', mensaje: `Tu pedido #${pedido.numero} ha sido entregado. ¡Gracias por tu compra!`, tipo: 'pedido' },
      cancelado: { titulo: 'Pedido cancelado', mensaje: `Tu pedido #${pedido.numero} ha sido cancelado. ${nota_cancelacion || ''}`.trim(), tipo: 'sistema' },
    };
    const notif = mensajes[estado]; // eslint-disable-line security/detect-object-injection
    if (notif) {
      const { notificarConEmail } = require('../services/notificacionHelper');
      // Email solo para 'listo' en pickup (el cliente necesita saber que ya puede ir por su pedido);
      // en domicilio el email importante es "en camino" y lo envía /api/entregas
      if (estado === 'listo' && !esDomicilio) {
        const userData = await pool.query('SELECT nombre, email FROM core.tblusuarios WHERE id = $1', [pedido.usuario_id]);
        if (userData.rows.length > 0) {
          const u = userData.rows[0];

          // 🔒 SEGURIDAD: Sanitizar datos dinámicos antes de insertarlos en HTML
          const safeNumero = he.escape(String(pedido.numero));
          const safeTotal = he.escape(parseFloat(pedido.total).toFixed(2));

          await notificarConEmail({
            usuario_id: pedido.usuario_id, tipo: notif.tipo, titulo: notif.titulo, mensaje: notif.mensaje,
            email: u.email, nombre: u.nombre,
            asunto: `🍰 ¡Tu pedido #${safeNumero} está listo! — Pier Repostería`,
            contenidoHtml: `
              <h2>¡Tu pedido está listo para recoger!</h2>
              <div class="highlight-box">
                <p><strong>Pedido:</strong> #${safeNumero}</p>
                <p><strong>Total:</strong> $${safeTotal} MXN</p>
                <p><strong>Recoger en:</strong> Sucursal Principal — Huejutla de Reyes</p>
              </div>
              <p>Pasa a recoger tu pedido en horario de atención. ¡Te esperamos!</p>
            `
          });
        }
      } else {
        await notificarConEmail({ usuario_id: pedido.usuario_id, tipo: notif.tipo, titulo: notif.titulo, mensaje: notif.mensaje });
      }
    }

    res.json({ success: true, pedido });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error PUT /pedidos/:id/estado:', error.message);
    res.status(500).json({ success: false, message: 'Error al actualizar estado' });
  } finally { client.release(); }
});

// ── Aprobar un pedido programado "por confirmar" (empleado+) ──
// Confirma que los productos podrán tenerse para la fecha de recogida.
router.put('/:id/aprobar', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, u.nombre AS cliente_nombre, u.email AS cliente_email
       FROM core.tblpedidos p JOIN core.tblusuarios u ON u.id = p.usuario_id
       WHERE p.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Pedido no encontrado' });
    const p = result.rows[0];
    if (!p.por_confirmar) return res.status(400).json({ success: false, message: 'Este pedido no está por confirmar' });

    await pool.query(
      'UPDATE core.tblpedidos SET por_confirmar = FALSE, updated_at = NOW() WHERE id = $1',
      [req.params.id]
    );

    const fechaTxt = p.horario_recogida
      ? new Date(p.horario_recogida).toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
      : 'la fecha programada';
    const { notificarConEmail } = require('../services/notificacionHelper');
    const safeNumero = he.escape(String(p.numero));
    await notificarConEmail({
      usuario_id: p.usuario_id,
      tipo: 'pedido',
      titulo: '¡Pedido confirmado!',
      mensaje: `¡Buenas noticias! Tu pedido #${p.numero} quedó confirmado para ${fechaTxt}. Te avisamos cuando esté listo para recoger.`,
      email: p.cliente_email,
      nombre: p.cliente_nombre,
      asunto: `🍰 ¡Pedido #${safeNumero} confirmado! — Pier Repostería`,
      contenidoHtml: `
        <h2>¡Tu pedido quedó confirmado!</h2>
        <div class="highlight-box">
          <p><strong>Pedido:</strong> #${safeNumero}</p>
          <p><strong>Recogida:</strong> ${he.escape(fechaTxt)}</p>
        </div>
        <p>Tus productos estarán listos para esa fecha. ¡Gracias por tu preferencia! 🧁</p>
      `,
    });

    res.json({ success: true, message: `Pedido ${p.numero} aprobado; el cliente ya fue notificado` });
  } catch (error) {
    console.error('Error PUT /pedidos/:id/aprobar:', error.message);
    res.status(500).json({ success: false, message: 'Error al aprobar el pedido' });
  }
});

// ── Rechazar un pedido programado "por confirmar" (empleado+) ──
// Cancela el pedido y genera automáticamente la solicitud de reembolso.
router.put('/:id/rechazar', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  const client = await pool.connect();
  try {
    const { motivo } = req.body;
    if (!motivo || String(motivo).trim().length < 5) {
      return res.status(400).json({ success: false, message: 'Escribe un motivo de rechazo (mín. 5 caracteres)' });
    }

    await client.query('BEGIN');
    const result = await client.query(
      `SELECT p.*, u.nombre AS cliente_nombre, u.email AS cliente_email
       FROM core.tblpedidos p JOIN core.tblusuarios u ON u.id = p.usuario_id
       WHERE p.id = $1 FOR UPDATE`,
      [req.params.id]
    );
    if (result.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'Pedido no encontrado' }); }
    const p = result.rows[0];
    if (!p.por_confirmar) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, message: 'Este pedido no está por confirmar' }); }

    await client.query(
      `UPDATE core.tblpedidos SET estado = 'cancelado', por_confirmar = FALSE, nota_cancelacion = $1, updated_at = NOW() WHERE id = $2`,
      [String(motivo).trim(), req.params.id]
    );

    // Reponer el inventario que sí se descontó (los items "sin stock" del
    // pedido por confirmar quedaron con stock_descontado = 0)
    await client.query(
      `UPDATE core.tblproductos p
       SET stock_online = p.stock_online + i.stock_descontado, updated_at = NOW()
       FROM core.tblpedido_items i
       WHERE i.pedido_id = $1 AND i.producto_id = p.id AND i.stock_descontado > 0`,
      [req.params.id]
    );
    await client.query('UPDATE core.tblpedido_items SET stock_descontado = 0 WHERE pedido_id = $1', [req.params.id]);

    // Solicitud de reembolso automática: aparece en Gestión de Reembolsos
    // para procesarse con el flujo normal (el cliente ya pagó en línea)
    await client.query(
      `INSERT INTO core.tblreembolsos (pedido_id, producto_id, usuario_id, monto, motivo, descripcion, fotos_evidencia, estado, created_at, updated_at)
       VALUES ($1, NULL, $2, $3, 'otro', $4, NULL, 'pendiente', NOW(), NOW())`,
      [p.id, p.usuario_id, p.total, `Pedido programado rechazado por disponibilidad: ${String(motivo).trim()}`]
    );
    await client.query('COMMIT');

    const { notificarConEmail } = require('../services/notificacionHelper');
    const safeNumero = he.escape(String(p.numero));
    const totalTxt = parseFloat(p.total).toFixed(2);
    await notificarConEmail({
      usuario_id: p.usuario_id,
      tipo: 'alerta',
      titulo: 'No podremos preparar tu pedido',
      mensaje: `Lo sentimos: tu pedido #${p.numero} no podrá prepararse para esa fecha (${String(motivo).trim()}). Tu pago de $${totalTxt} será reembolsado; ya generamos la solicitud.`,
      email: p.cliente_email,
      nombre: p.cliente_nombre,
      asunto: `Pedido #${safeNumero}: no disponible para tu fecha — Pier Repostería`,
      contenidoHtml: `
        <h2>Lo sentimos mucho</h2>
        <div class="highlight-box">
          <p><strong>Pedido:</strong> #${safeNumero}</p>
          <p><strong>Motivo:</strong> ${he.escape(String(motivo).trim())}</p>
        </div>
        <p>No podremos preparar tu pedido para la fecha solicitada. Tu pago de <strong>$${he.escape(totalTxt)} MXN</strong> será reembolsado completo: ya generamos la solicitud y te avisaremos cuando se procese.</p>
        <p>Gracias por tu comprensión. ¡Esperamos consentirte pronto! 🧁</p>
      `,
    });

    res.json({ success: true, message: `Pedido ${p.numero} rechazado; se generó la solicitud de reembolso y el cliente fue notificado` });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error PUT /pedidos/:id/rechazar:', error.message);
    res.status(500).json({ success: false, message: 'Error al rechazar el pedido' });
  } finally { client.release(); }
});

module.exports = router;