// routes/pagosRoutes.js — Procesamiento de pagos con Stripe
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { verifyToken } = require('../middleware/auth');

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// ¿La recogida es para OTRO día? (fecha en huso de Huejutla, UTC-6).
// Un pedido para fecha futura puede aceptar productos sin stock HOY:
// queda "por confirmar" y el personal decide si podrá producirse.
function esRecogidaFutura(horarioIso) {
  if (!horarioIso) return false;
  const recogida = new Date(horarioIso);
  if (isNaN(recogida.getTime())) return false;
  const diaMx = (d) => {
    const t = new Date(d.getTime() - 6 * 60 * 60 * 1000);
    return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
  };
  return diaMx(recogida) > diaMx(new Date());
}

// Carrito con promociones activas aplicadas. El mismo cálculo se usa al
// crear el intent y al confirmar, para que el monto cobrado y el pedido
// guardado nunca difieran. Con permitirFuturo, los productos sin stock
// no rechazan la compra: se reportan en "faltantes" (pedido por confirmar).
async function obtenerCarrito(db, userId, permitirFuturo = false) {
  const carrito = await db.query(
    `SELECT ci.*, p.nombre, p.precio_chico, p.precio_grande, p.stock_online, p.activo,
      pr.descuento_porcentaje AS promo_descuento
     FROM core.tblcarrito_items ci
     JOIN core.tblproductos p ON ci.producto_id = p.id
     LEFT JOIN core.tblpromociones pr ON pr.producto_id = p.id AND pr.estado = 'activa' AND (pr.fecha_fin IS NULL OR pr.fecha_fin > NOW())
     WHERE ci.usuario_id = $1`,
    [userId]
  );
  if (carrito.rows.length === 0) return { error: 'El carrito está vacío' };

  let subtotal = 0;
  const items = [];
  const faltantes = [];
  for (const item of carrito.rows) {
    if (!item.activo) return { error: `"${item.nombre}" ya no está disponible` };
    // stock_online = 0 significa agotado (no existe stock ilimitado)
    const sinStock = item.stock_online === 0 || item.stock_online < item.cantidad;
    if (sinStock && !permitirFuturo) {
      if (item.stock_online === 0) return { error: `"${item.nombre}" está agotado` };
      return { error: `"${item.nombre}": solo quedan ${item.stock_online} unidades` };
    }
    if (sinStock) faltantes.push(item.nombre);
    let precio = (item.tamano === 'grande' && item.precio_grande)
      ? parseFloat(item.precio_grande)
      : parseFloat(item.precio_chico);
    // Aplicar descuento de promoción (porcentaje sobre precio del tamaño)
    if (item.promo_descuento) precio = Math.round(precio * (1 - parseFloat(item.promo_descuento) / 100));
    const importe = precio * item.cantidad;
    subtotal += importe;
    items.push({
      producto_id: item.producto_id, nombre: item.nombre,
      cantidad: item.cantidad, tamano: item.tamano,
      precio_unitario: precio, subtotal: importe,
      sin_stock: sinStock,
    });
  }
  return { items, subtotal, faltantes };
}

// Resuelve el costo de envío y el snapshot de dirección según la modalidad.
async function resolverEnvio(db, userId, tipoEntrega, direccionId) {
  if (tipoEntrega !== 'domicilio') return { costo_envio: 0, direccion: null };
  if (!direccionId) return { error: 'Selecciona una dirección de entrega' };
  const result = await db.query(
    `SELECT d.alias, d.calle_numero, d.colonia, d.referencias, d.telefono_contacto, d.lat, d.lng,
            z.tarifa, z.nombre AS zona
     FROM core.tbldirecciones d
     LEFT JOIN core.tblzonas_colonias zc ON LOWER(zc.colonia) = LOWER(d.colonia)
     LEFT JOIN core.tblzonas_envio z ON z.id = zc.zona_id AND z.activa = TRUE
     WHERE d.id = $1 AND d.usuario_id = $2`,
    [direccionId, userId]
  );
  if (result.rows.length === 0) return { error: 'Dirección de entrega no encontrada' };
  const d = result.rows[0];
  if (d.tarifa === null) return { error: `Sin cobertura de envío en "${d.colonia}". Elige recoger en sucursal.` };
  return {
    costo_envio: parseFloat(d.tarifa),
    direccion: {
      alias: d.alias,
      calle_numero: d.calle_numero,
      colonia: d.colonia,
      referencias: d.referencias,
      telefono: d.telefono_contacto,
      zona: d.zona,
      lat: d.lat,
      lng: d.lng,
    },
  };
}

// ── Crear Payment Intent (desde el carrito, SIN crear pedido) ──
router.post('/crear-intent', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const tipoEntrega = req.body.tipo_entrega === 'domicilio' ? 'domicilio' : 'pickup';
    const direccionId = req.body.direccion_id ? parseInt(req.body.direccion_id) : null;

    // Pickup para OTRO día: se permite pagar productos sin stock hoy
    // (el pedido quedará "por confirmar" por el personal)
    const permitirFuturo = tipoEntrega === 'pickup' && esRecogidaFutura(req.body.horario_recogida);

    const carrito = await obtenerCarrito(pool, userId, permitirFuturo);
    if (carrito.error) return res.status(400).json({ success: false, message: carrito.error });

    const envio = await resolverEnvio(pool, userId, tipoEntrega, direccionId);
    if (envio.error) return res.status(400).json({ success: false, message: envio.error });

    const total = carrito.subtotal + envio.costo_envio;

    // La modalidad y la dirección viajan en metadata: al confirmar se leen
    // de Stripe, no del cliente, para que no puedan alterarse.
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(total * 100),
      currency: 'mxn',
      metadata: {
        usuario_id: userId.toString(),
        tipo_entrega: tipoEntrega,
        direccion_id: direccionId ? direccionId.toString() : '',
      },
    });

    res.json({
      success: true,
      clientSecret: paymentIntent.client_secret,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
      subtotal: carrito.subtotal,
      costo_envio: envio.costo_envio,
      total,
      por_confirmar: (carrito.faltantes || []).length > 0,
      productos_por_confirmar: carrito.faltantes || [],
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
    const { payment_intent_id, notas, horario_recogida, horario_entrega } = req.body;

    // Verificar el Payment Intent con Stripe
    const paymentIntent = await stripe.paymentIntents.retrieve(payment_intent_id);

    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({
        success: false,
        message: 'El pago no fue completado',
        status: paymentIntent.status
      });
    }
    if (paymentIntent.metadata.usuario_id !== userId.toString()) {
      return res.status(403).json({ success: false, message: 'El pago no corresponde a este usuario' });
    }

    const tipoEntrega = paymentIntent.metadata.tipo_entrega === 'domicilio' ? 'domicilio' : 'pickup';
    const direccionId = paymentIntent.metadata.direccion_id ? parseInt(paymentIntent.metadata.direccion_id) : null;

    await client.query('BEGIN');

    const permitirFuturo = tipoEntrega === 'pickup' && esRecogidaFutura(horario_recogida);
    const carrito = await obtenerCarrito(client, userId, permitirFuturo);
    if (carrito.error) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: carrito.error });
    }
    const { items, subtotal } = carrito;
    const faltantes = carrito.faltantes || [];
    const porConfirmar = faltantes.length > 0;

    const envio = await resolverEnvio(client, userId, tipoEntrega, direccionId);
    if (envio.error) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: envio.error });
    }
    const total = subtotal + envio.costo_envio;

    // El monto cobrado en Stripe debe coincidir con el carrito actual
    if (paymentIntent.amount !== Math.round(total * 100)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'El carrito cambió después de iniciar el pago. Vuelve a intentarlo.' });
    }

    // Crear pedido
    const fecha = new Date();
    const y = fecha.getFullYear().toString().slice(-2);
    const m = String(fecha.getMonth() + 1).padStart(2, '0');
    const d = String(fecha.getDate()).padStart(2, '0');
    const rand = Math.floor(1000 + Math.random() * 9000);
    const numero = `PIER-${y}${m}${d}-${rand}`;

    // Los productos ya están hechos (repostería lista): el pedido pagado
    // nace "listo" — pickup y domicilio por igual (los de domicilio entran
    // al pool de repartidores). La excepción: un pedido programado con
    // productos sin stock hoy nace "pendiente" y por_confirmar, para que
    // el personal apruebe si podrá tenerse en esa fecha.
    const estadoInicial = porConfirmar ? 'pendiente' : 'listo';
    const pedidoResult = await client.query(
      `INSERT INTO core.tblpedidos
        (numero, usuario_id, total, estado, notas, horario_recogida, metodo_pago,
         tipo_entrega, costo_envio, direccion_entrega, horario_entrega, por_confirmar, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'tarjeta',$7,$8,$9,$10,$11,NOW(),NOW()) RETURNING *`,
      [
        numero, userId, total, estadoInicial, notas || null,
        tipoEntrega === 'pickup' ? (horario_recogida || null) : null,
        tipoEntrega, envio.costo_envio,
        envio.direccion ? JSON.stringify(envio.direccion) : null,
        tipoEntrega === 'domicilio' ? (horario_entrega || null) : null,
        porConfirmar,
      ]
    );
    const pedido = pedidoResult.rows[0];

    // Descontar stock y crear items registrando cuánto se descontó de
    // verdad por línea (stock_descontado): es lo que se repone si el
    // pedido se cancela o se rechaza
    const stockAgotado = [];
    const stockBajo = [];
    for (const item of items) {
      // Los productos sin stock de un pedido por confirmar NO descuentan
      // inventario: se producirán para la fecha si el personal lo aprueba
      let stockDescontado = 0;
      if (!item.sin_stock) {
        // El sub-select con FOR UPDATE bloquea la fila y expone el valor
        // previo: el descuento real puede ser parcial por el tope en cero
        const stockResult = await client.query(
          `UPDATE core.tblproductos p
           SET stock_online = GREATEST(p.stock_online - $1, 0), updated_at = NOW()
           FROM (SELECT id, stock_online AS stock_anterior FROM core.tblproductos WHERE id = $2 FOR UPDATE) prev
           WHERE p.id = prev.id
           RETURNING p.nombre, p.stock_online, prev.stock_anterior`,
          [item.cantidad, item.producto_id]
        );
        if (stockResult.rows.length > 0) {
          const s = stockResult.rows[0];
          stockDescontado = s.stock_anterior - s.stock_online;
          if (s.stock_online === 0) stockAgotado.push(s.nombre);
          else if (s.stock_online <= 5) stockBajo.push(s);
        }
      }
      await client.query(
        `INSERT INTO core.tblpedido_items (pedido_id, producto_id, nombre_producto, cantidad, tamano, precio_unitario, subtotal, stock_descontado)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [pedido.id, item.producto_id, item.nombre, item.cantidad, item.tamano, item.precio_unitario, item.subtotal, stockDescontado]
      );
    }

    // Vaciar carrito
    await client.query('DELETE FROM core.tblcarrito_items WHERE usuario_id = $1', [userId]);

    // Crear registro de pago (subtotal de productos + total con envío)
    await client.query(
      `INSERT INTO core.tblpagos (pedido_id, monto_subtotal, monto_total, estado, stripe_payment_id, created_at)
       VALUES ($1,$2,$3,'pagado',$4,NOW())`,
      [pedido.id, subtotal, total, payment_intent_id]
    );

    await client.query('COMMIT');

    // Pedido programado con faltantes: el personal debe aprobarlo o rechazarlo
    if (porConfirmar) {
      try {
        const { crearNotificacion } = require('../services/notificacionHelper');
        const fechaTxt = horario_recogida
          ? new Date(horario_recogida).toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City', weekday: 'long', day: 'numeric', month: 'long' })
          : 'la fecha programada';
        const staff = await pool.query(`SELECT id FROM core.tblusuarios WHERE rol::text = ANY($1::text[]) AND activo = TRUE`, [['empleado', 'gerencia', 'direccion_general']]);
        for (const s of staff.rows) {
          await crearNotificacion({
            usuario_id: s.id,
            tipo: 'alerta',
            titulo: 'Pedido por confirmar',
            mensaje: `El pedido ${numero} (recogida ${fechaTxt}) incluye productos sin stock hoy: ${faltantes.join(', ')}. Apruébalo o recházalo en Gestión de Pedidos.`,
          });
        }
      } catch (notifError) {
        console.error('Error notificando pedido por confirmar:', notifError.message);
      }
    }

    // Alertar a los empleados si algún producto quedó agotado o con poco stock
    if (stockAgotado.length > 0 || stockBajo.length > 0) {
      try {
        const { crearNotificacion } = require('../services/notificacionHelper');
        const empleados = await pool.query(`SELECT id FROM core.tblusuarios WHERE rol = 'empleado' AND activo = TRUE`);
        for (const emp of empleados.rows) {
          for (const nombre of stockAgotado) {
            await crearNotificacion({
              usuario_id: emp.id,
              tipo: 'alerta',
              titulo: 'Producto agotado',
              mensaje: `"${nombre}" se agotó en la tienda en línea tras el pedido ${numero}. Revisa Gestión de Productos.`,
            });
          }
          for (const s of stockBajo) {
            await crearNotificacion({
              usuario_id: emp.id,
              tipo: 'alerta',
              titulo: 'Stock bajo',
              mensaje: `Quedan ${s.stock_online} unidades de "${s.nombre}" en la tienda en línea.`,
            });
          }
        }
      } catch (stockError) {
        console.error('Error notificando stock bajo:', stockError.message);
      }
    }

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
        const esDomicilio = tipoEntrega === 'domicilio';
        const safeEnvio = he.escape(envio.costo_envio.toFixed(2));
        await notificarConEmail({
          usuario_id: userId,
          tipo: 'pedido',
          titulo: '¡Pedido recibido!',
          mensaje: porConfirmar
            ? `Recibimos tu pedido #${numero} por $${total.toFixed(2)}. Como es para otra fecha, estamos confirmando la disponibilidad de tus productos: te avisamos muy pronto.`
            : esDomicilio
              ? `Tu pedido #${numero} por $${total.toFixed(2)} fue confirmado. Te avisaremos cuando salga en camino a tu domicilio.`
              : `Tu pedido #${numero} por $${total.toFixed(2)} fue confirmado. Te avisaremos cuando esté listo para recoger.`,
          email: u.email,
          nombre: u.nombre,
          asunto: `🍰 Pedido #${safeNumero} confirmado — Pier Repostería`,
          contenidoHtml: `
            <h2>¡Gracias por tu compra, ${he.escape(u.nombre)}!</h2>
            <div class="highlight-box">
              <p><strong>Pedido:</strong> #${safeNumero}</p>
              <p><strong>Productos:</strong> ${safeItemsTexto}</p>
              ${esDomicilio ? `<p><strong>Envío a domicilio:</strong> $${safeEnvio} MXN</p>` : ''}
              <p><strong>Total:</strong> $${safeTotal} MXN</p>
            </div>
            ${porConfirmar
              ? '<p>Tu pedido es para otra fecha: estamos confirmando la disponibilidad de tus productos y te avisaremos muy pronto. Si no pudiéramos prepararlo, tu pago se reembolsa completo.</p>'
              : esDomicilio
                ? '<p>Te notificaremos cuando tu pedido salga en camino a tu domicilio.</p>'
                : '<p>Te notificaremos cuando esté listo para recoger en Sucursal Principal, Huejutla de Reyes.</p>'}
          `
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
