// routes/pagosRoutes.js — Procesamiento de pagos con Stripe
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { verifyToken } = require('../middleware/auth');

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// ── Crear Payment Intent (desde el checkout) ──
router.post('/crear-intent', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { pedido_id } = req.body;

    // Obtener pedido y verificar que pertenece al usuario
    const pedidoRes = await pool.query(
      `SELECT p.id, p.total, p.estado, p.numero, pg.id as pago_id, pg.estado as pago_estado
       FROM core.tblpedidos p
       LEFT JOIN core.tblpagos pg ON pg.pedido_id = p.id
       WHERE p.id = $1 AND p.usuario_id = $2`,
      [pedido_id, userId]
    );

    if (pedidoRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Pedido no encontrado' });
    }

    const pedido = pedidoRes.rows[0];

    if (pedido.pago_estado === 'pagado') {
      return res.status(400).json({ success: false, message: 'Este pedido ya fue pagado' });
    }

    // Crear Payment Intent en Stripe (monto en centavos)
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(parseFloat(pedido.total) * 100),
      currency: 'mxn',
      metadata: {
        pedido_id: pedido.id.toString(),
        pedido_numero: pedido.numero,
        usuario_id: userId.toString()
      }
    });

    // Guardar el stripe_payment_id en tblpagos
    await pool.query(
      `UPDATE core.tblpagos SET stripe_payment_id = $1, updated_at = NOW() WHERE pedido_id = $2`,
      [paymentIntent.id, pedido_id]
    );

    res.json({
      success: true,
      clientSecret: paymentIntent.client_secret,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY
    });
  } catch (error) {
    console.error('Error creando payment intent:', error.message);
    res.status(500).json({ success: false, message: 'Error al procesar pago' });
  }
});

// ── Confirmar pago (después de que Stripe procesa) ──
router.post('/confirmar', verifyToken, async (req, res) => {
  try {
    const { pedido_id, payment_intent_id } = req.body;
    const userId = req.user.userId;

    // Verificar el Payment Intent con Stripe
    const paymentIntent = await stripe.paymentIntents.retrieve(payment_intent_id);

    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({
        success: false,
        message: 'El pago no fue completado',
        status: paymentIntent.status
      });
    }

    // Verificar que el pedido pertenece al usuario
    const pedidoRes = await pool.query(
      'SELECT id FROM core.tblpedidos WHERE id = $1 AND usuario_id = $2',
      [pedido_id, userId]
    );

    if (pedidoRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Pedido no encontrado' });
    }

    // Actualizar estado del pago y pedido
    await pool.query(
      `UPDATE core.tblpagos SET estado = 'pagado', stripe_payment_id = $1, updated_at = NOW() WHERE pedido_id = $2`,
      [payment_intent_id, pedido_id]
    );

    await pool.query(
      `UPDATE core.tblpedidos SET estado = 'en_preparacion', metodo_pago = 'tarjeta', updated_at = NOW() WHERE id = $1`,
      [pedido_id]
    );

    res.json({ success: true, message: 'Pago confirmado exitosamente' });
  } catch (error) {
    console.error('Error confirmando pago:', error.message);
    res.status(500).json({ success: false, message: 'Error al confirmar pago' });
  }
});

// ── Obtener publishable key (para el frontend) ──
router.get('/config', (req, res) => {
  res.json({
    success: true,
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY
  });
});

module.exports = router;
