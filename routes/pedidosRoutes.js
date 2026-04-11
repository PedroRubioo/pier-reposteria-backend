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
      if (item.stock_online > 0 && item.stock_online < item.cantidad) { await client.query('ROLLBACK'); return res.status(400).json({ success: false, message: `"${item.nombre}": solo quedan ${item.stock_online} unidades` }); }
      const precio = (item.tamano === 'grande' && item.precio_grande) ? parseFloat(item.precio_grande) : parseFloat(item.precio_chico);
      const subtotal = precio * item.cantidad;
      total += subtotal;
      items.push({ producto_id: item.producto_id, nombre: item.nombre, cantidad: item.cantidad, tamano: item.tamano, precio_unitario: precio, subtotal });
    }
    const numero = generarNumeroPedido();
    const pedidoResult = await client.query(`INSERT INTO core.tblpedidos (numero, usuario_id, total, estado, notas, horario_recogida, metodo_pago, created_at, updated_at) VALUES ($1,$2,$3,'pendiente',$4,$5,$6,NOW(),NOW()) RETURNING *`, [numero, userId, total, notas || null, horario_recogida || null, metodo_pago || null]);
    const pedido = pedidoResult.rows[0];
    for (const item of items) {
      await client.query(`INSERT INTO core.tblpedido_items (pedido_id, producto_id, nombre_producto, cantidad, tamano, precio_unitario, subtotal) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [pedido.id, item.producto_id, item.nombre, item.cantidad, item.tamano, item.precio_unitario, item.subtotal]);
      await client.query('UPDATE core.tblproductos SET stock_online = GREATEST(stock_online - $1, 0), updated_at = NOW() WHERE id = $2 AND stock_online > 0', [item.cantidad, item.producto_id]);
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
        mensaje: `Tu pedido #${numero} por $${total.toFixed(2)} ha sido recibido. Te avisaremos cuando esté en preparación.`,
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
          <p>Te notificaremos cuando tu pedido esté en preparación y cuando esté listo para recoger.</p>
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
      WHERE ped.usuario_id = $1 AND ped.estado = 'completado'
      ORDER BY pi.producto_id, ped.created_at DESC
      LIMIT 5
    `, [req.user.userId]);
    res.json({ success: true, productos: result.rows });
  } catch (error) {
    console.error('Error GET /pedidos/productos-comprados:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener productos comprados' });
  }
});

// ── Detalle de pedido (DEBE ir DESPUÉS de las rutas específicas) ──
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const pedido = await pool.query('SELECT * FROM core.tblpedidos WHERE id = $1', [req.params.id]);
    if (pedido.rows.length === 0) return res.status(404).json({ success: false, message: 'Pedido no encontrado' });
    if (pedido.rows[0].usuario_id !== req.user.userId && !['empleado', 'gerencia', 'direccion_general'].includes(req.user.rol)) {
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
    let query = `SELECT p.*, u.nombre AS cliente_nombre, u.apellido AS cliente_apellido, u.email AS cliente_email, pg.estado AS estado_pago, pg.stripe_payment_id, pg.monto_total AS monto_pago FROM core.tblpedidos p JOIN core.tblusuarios u ON p.usuario_id = u.id LEFT JOIN core.tblpagos pg ON pg.pedido_id = p.id WHERE 1=1`;
    const params = [];
    let pi = 1;
    if (estado) { query += ` AND p.estado = $${pi}`; params.push(estado); pi++; }
    query += ` ORDER BY p.created_at DESC`;
    if (limite) {
      query += ` LIMIT $${pi} OFFSET $${pi + 1}`;
      params.push(parseInt(limite), parseInt(offset) || 0);
    }
    const result = await pool.query(query, params);
    res.json({ success: true, pedidos: result.rows });
  } catch (error) {
    console.error('Error GET /pedidos:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener pedidos' });
  }
});

// ── Cambiar estado del pedido (empleado+) ──
router.put('/:id/estado', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const { estado, nota_cancelacion } = req.body;
    const validos = ['pendiente', 'en_preparacion', 'listo', 'completado', 'cancelado'];
    if (!validos.includes(estado)) return res.status(400).json({ success: false, message: `Estado inválido. Valores: ${validos.join(', ')}` });
    const updates = [estado];
    let query = 'UPDATE core.tblpedidos SET estado = $1, updated_at = NOW()';
    let pi = 2;
    if (estado === 'cancelado' && nota_cancelacion) { query += `, nota_cancelacion = $${pi}`; updates.push(nota_cancelacion); pi++; }
    query += ` WHERE id = $${pi} RETURNING *`;
    updates.push(req.params.id);
    const result = await pool.query(query, updates);
    if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Pedido no encontrado' });

    // Crear notificación para el cliente
    const pedido = result.rows[0];
    const mensajes = {
      en_preparacion: { titulo: 'Pedido en preparación', mensaje: `Tu pedido #${pedido.numero} ha comenzado a prepararse.`, tipo: 'pedido' },
      listo: { titulo: '¡Tu pedido está listo!', mensaje: `Tu pedido #${pedido.numero} está listo para recoger en Sucursal Principal.`, tipo: 'pedido' },
      completado: { titulo: 'Pedido completado', mensaje: `Tu pedido #${pedido.numero} ha sido entregado. ¡Gracias por tu compra!`, tipo: 'pedido' },
      cancelado: { titulo: 'Pedido cancelado', mensaje: `Tu pedido #${pedido.numero} ha sido cancelado. ${nota_cancelacion || ''}`.trim(), tipo: 'sistema' },
    };
    const notif = mensajes[estado]; // eslint-disable-line security/detect-object-injection
    if (notif) {
      const { notificarConEmail } = require('../services/notificacionHelper');
      // Email solo para 'listo' (el cliente necesita saber que ya puede ir por su pedido)
      if (estado === 'listo') {
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
    console.error('Error PUT /pedidos/:id/estado:', error.message);
    res.status(500).json({ success: false, message: 'Error al actualizar estado' });
  }
});

module.exports = router;