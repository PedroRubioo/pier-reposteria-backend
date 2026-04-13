// routes/pagosRoutes.js — Procesamiento de pagos con Stripe
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { verifyToken } = require('../middleware/auth');

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// ── Crear Payment Intent (desde el carrito, SIN crear pedido) ──
router.post('/crear-intent', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Obtener items del carrito con promociones activas
    const carrito = await pool.query(
      `SELECT ci.*, p.nombre, p.precio_chico, p.precio_grande, p.activo,
        pr.descuento_porcentaje AS promo_descuento, pr.precio_oferta AS promo_precio_oferta
       FROM core.tblcarrito_items ci
       JOIN core.tblproductos p ON ci.producto_id = p.id
       LEFT JOIN core.tblpromociones pr ON pr.producto_id = p.id AND pr.estado = 'activa' AND (pr.fecha_fin IS NULL OR pr.fecha_fin > NOW())
       WHERE ci.usuario_id = $1`,
      [userId]
    );

    if (carrito.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'El carrito está vacío' });
    }

    let total = 0;
    for (const item of carrito.rows) {
      if (!item.activo) {
        return res.status(400).json({ success: false, message: `"${item.nombre}" ya no está disponible` });
      }
      let precio = (item.tamano === 'grande' && item.precio_grande)
        ? parseFloat(item.precio_grande)
        : parseFloat(item.precio_chico);
      // Aplicar descuento de promoción
      if (item.promo_precio_oferta) precio = parseFloat(item.promo_precio_oferta);
      else if (item.promo_descuento) precio = Math.round(precio * (1 - parseFloat(item.promo_descuento) / 100));
      total += precio * item.cantidad;
    }

    // Crear Payment Intent en Stripe (monto en centavos)
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(total * 100),
      currency: 'mxn',
      metadata: {
        usuario_id: userId.toString()
      }
    });

    res.json({
      success: true,
      clientSecret: paymentIntent.client_secret,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
      total
    });
  } catch (error) {
    console.error('Error creando payment intent:', error.message);
    res.status(500).json({ success: false, message: 'Error al iniciar pago' });
  }
});

// ── Confirmar pago y crear pedido ──
router.post('/confirmar', verifyToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = req.user.userId;
    const { payment_intent_id, notas, horario_recogida } = req.body;

    // Verificar el Payment Intent con Stripe
    const paymentIntent = await stripe.paymentIntents.retrieve(payment_intent_id);

    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({
        success: false,
        message: 'El pago no fue completado',
        status: paymentIntent.status
      });
    }

    await client.query('BEGIN');

    // Obtener carrito
    const carrito = await client.query(
      `SELECT ci.*, p.nombre, p.precio_chico, p.precio_grande, p.stock_online, p.activo
       FROM core.tblcarrito_items ci
       JOIN core.tblproductos p ON ci.producto_id = p.id
       WHERE ci.usuario_id = $1`,
      [userId]
    );

    if (carrito.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'El carrito está vacío' });
    }

    // Calcular total y validar items
    let total = 0;
    const items = [];
    for (const item of carrito.rows) {
      if (!item.activo) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: `"${item.nombre}" ya no está disponible` });
      }
      const precio = (item.tamano === 'grande' && item.precio_grande)
        ? parseFloat(item.precio_grande)
        : parseFloat(item.precio_chico);
      const subtotal = precio * item.cantidad;
      total += subtotal;
      items.push({
        producto_id: item.producto_id, nombre: item.nombre,
        cantidad: item.cantidad, tamano: item.tamano,
        precio_unitario: precio, subtotal
      });
    }

    // Crear pedido
    const fecha = new Date();
    const y = fecha.getFullYear().toString().slice(-2);
    const m = String(fecha.getMonth() + 1).padStart(2, '0');
    const d = String(fecha.getDate()).padStart(2, '0');
    const rand = Math.floor(1000 + Math.random() * 9000);
    const numero = `PIER-${y}${m}${d}-${rand}`;

    const pedidoResult = await client.query(
      `INSERT INTO core.tblpedidos (numero, usuario_id, total, estado, notas, horario_recogida, metodo_pago, created_at, updated_at)
       VALUES ($1,$2,$3,'en_preparacion',$4,$5,'tarjeta',NOW(),NOW()) RETURNING *`,
      [numero, userId, total, notas || null, horario_recogida || null]
    );
    const pedido = pedidoResult.rows[0];

    // Crear items del pedido
    for (const item of items) {
      await client.query(
        `INSERT INTO core.tblpedido_items (pedido_id, producto_id, nombre_producto, cantidad, tamano, precio_unitario, subtotal)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [pedido.id, item.producto_id, item.nombre, item.cantidad, item.tamano, item.precio_unitario, item.subtotal]
      );
      await client.query(
        'UPDATE core.tblproductos SET stock_online = GREATEST(stock_online - $1, 0), updated_at = NOW() WHERE id = $2 AND stock_online > 0',
        [item.cantidad, item.producto_id]
      );
    }

    // Vaciar carrito
    await client.query('DELETE FROM core.tblcarrito_items WHERE usuario_id = $1', [userId]);

    // Crear registro de pago
    await client.query(
      `INSERT INTO core.tblpagos (pedido_id, monto_subtotal, monto_total, estado, stripe_payment_id, created_at)
       VALUES ($1,$2,$3,'pagado',$4,NOW())`,
      [pedido.id, total, total, payment_intent_id]
    );

    await client.query('COMMIT');

    // Notificación
    try {
      const { notificarConEmail } = require('../services/notificacionHelper');
      const he = require('he');
      const userData = await pool.query('SELECT nombre, email FROM core.tblusuarios WHERE id = $1', [userId]);
      if (userData.rows.length > 0) {
        const u = userData.rows[0];
        const safeNumero = he.escape(String(numero));
        const safeTotal = he.escape(total.toFixed(2));
        const safeItemsTexto = he.escape(items.map(i => `${i.nombre} x${i.cantidad}`).join(', '));
        await notificarConEmail({
          usuario_id: userId,
          tipo: 'pedido',
          titulo: '¡Pedido recibido!',
          mensaje: `Tu pedido #${safeNumero} por $${safeTotal} ha sido confirmado y pagado. Productos: ${safeItemsTexto}`,
          emailData: {
            to: u.email,
            subject: `Pedido #${safeNumero} confirmado - Pier Repostería`,
            html: `<h2>¡Gracias por tu compra, ${he.escape(u.nombre)}!</h2><p>Tu pedido <strong>#${safeNumero}</strong> ha sido confirmado y pagado.</p><p><strong>Total:</strong> $${safeTotal} MXN</p><p><strong>Productos:</strong> ${safeItemsTexto}</p><p>Te notificaremos cuando esté listo para recoger.</p>`
          }
        });
      }
    } catch (emailError) {
      console.error('Error enviando notificación:', emailError.message);
    }

    res.json({ success: true, pedido });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error confirmando pago:', error.message);
    res.status(500).json({ success: false, message: 'Error al confirmar pago' });
  } finally {
    client.release();
  }
});

// ── Obtener publishable key ──
router.get('/config', (req, res) => {
  res.json({
    success: true,
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY
  });
});

module.exports = router;
