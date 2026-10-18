// routes/pagosRoutes.js — Procesamiento de pagos con Stripe
const express = require('express');
const router = express.Router();
const he = require('he');
const { pool } = require('../config/database');
const { verifyToken } = require('../middleware/auth');
const { textoLibre, enteroPositivo, coloniaNormalizadaSql } = require('../utils/validacionCliente');
const { JOIN_PROMO_VIGENTE, precioConPromocion } = require('../utils/promociones');
const { diaHuejutla } = require('../utils/fechasHuejutla');
const { registrarAuditoria, recortar } = require('../utils/auditoria');
const { crearNotificacion, notificarConEmail, notificarRoles } = require('../services/notificacionHelper');

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

// Horario que llega al confirmar: si no es una fecha ISO válida se guarda
// null (el cobro ya ocurrió: rechazarlo dejaría el pago sin pedido). Se
// guarda el texto tal cual llega, como siempre (la app lo manda sin zona)
const FECHA_ISO = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?)?(Z|[+-]\d{2}(:?\d{2})?)?$/;
function horarioValido(valor) {
  if (typeof valor !== 'string' || !FECHA_ISO.test(valor.trim())) return null;
  const anio = Number(valor.trim().slice(0, 4));
  if (anio < 2000 || anio > 2100 || Number.isNaN(Date.parse(valor.trim()))) return null;
  return valor.trim();
}

// Carrito con la promoción vigente que se cobra (utils/promociones.js). El
// mismo cálculo se usa al crear el intent y al confirmar, para que el monto
// cobrado y el pedido guardado nunca difieran. La existencia se compara con
// todos los tamaños del producto. Con permitirFuturo, los productos sin
// existencia no rechazan la compra: cada uno entra una vez en "faltantes"
// (pedido por confirmar).
async function obtenerCarrito(db, userId, permitirFuturo = false) {
  const carrito = await db.query(
    `SELECT ci.*, p.nombre, p.precio_chico, p.precio_grande, p.stock_online, p.activo,
            c.activo AS categoria_activa, pr.descuento_porcentaje AS promo_descuento,
            SUM(ci.cantidad) OVER (PARTITION BY ci.producto_id)::int AS cantidad_producto
       FROM core.tblcarrito_items ci
       JOIN core.tblproductos p ON ci.producto_id = p.id
       JOIN core.tblcategorias c ON p.categoria_id = c.id
       ${JOIN_PROMO_VIGENTE}
      WHERE ci.usuario_id = $1
      ORDER BY ci.id`,
    [userId]
  );
  if (carrito.rows.length === 0) return { error: 'El carrito está vacío' };

  let subtotal = 0;
  const items = [];
  const faltantes = [];
  const productosFaltantes = new Set();
  for (const item of carrito.rows) {
    if (!item.activo || !item.categoria_activa) return { error: `"${item.nombre}" ya no está disponible` };
    // stock_online = 0 significa agotado (no existe stock ilimitado)
    const sinStock = item.stock_online === 0 || item.stock_online < item.cantidad_producto;
    if (sinStock && !permitirFuturo) {
      if (item.stock_online === 0) return { error: `"${item.nombre}" está agotado` };
      return { error: `"${item.nombre}": solo quedan ${item.stock_online} unidades` };
    }
    if (sinStock && !productosFaltantes.has(item.producto_id)) {
      productosFaltantes.add(item.producto_id);
      faltantes.push(item.nombre);
    }
    const precioBase = (item.tamano === 'grande' && item.precio_grande)
      ? parseFloat(item.precio_grande)
      : parseFloat(item.precio_chico);
    const precio = precioConPromocion(precioBase, item.promo_descuento);
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
// Solo direcciones activas; la zona se busca sin acentos ni mayúsculas
// (Diseno_Panel_Cliente.md §5.13): "Tahuizan" cobra la tarifa de "Tahuizán".
async function resolverEnvio(db, userId, tipoEntrega, direccionId) {
  if (tipoEntrega !== 'domicilio') return { costo_envio: 0, direccion: null };
  if (!direccionId) return { error: 'Selecciona una dirección de entrega' };
  const result = await db.query(
    `SELECT d.alias, d.calle_numero, d.colonia, d.referencias, d.telefono_contacto, d.lat, d.lng,
            zona.tarifa, zona.zona_nombre AS zona
     FROM core.tbldirecciones d
     LEFT JOIN LATERAL (
       SELECT z.id AS zona_id, z.nombre AS zona_nombre, z.tarifa
         FROM core.tblzonas_colonias zc
         JOIN core.tblzonas_envio z ON z.id = zc.zona_id AND z.activa = TRUE
        WHERE ${coloniaNormalizadaSql('zc.colonia')} = ${coloniaNormalizadaSql('d.colonia')}
        ORDER BY (zc.colonia = d.colonia) DESC, zc.id
        LIMIT 1) zona ON TRUE
     WHERE d.id = $1 AND d.usuario_id = $2 AND d.activa = TRUE`,
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
    const direccionId = enteroPositivo(req.body.direccion_id);

    // Pickup para OTRO día: se permite pagar productos sin stock hoy
    // (el pedido quedará "por confirmar" por el personal)
    const permitirFuturo = tipoEntrega === 'pickup' && esRecogidaFutura(req.body.horario_recogida);

    const carrito = await obtenerCarrito(pool, userId, permitirFuturo);
    if (carrito.error) return res.status(400).json({ success: false, message: carrito.error });

    const envio = await resolverEnvio(pool, userId, tipoEntrega, direccionId);
    if (envio.error) return res.status(400).json({ success: false, message: envio.error });

    const total = carrito.subtotal + envio.costo_envio;

    // Solo tarjeta: un método diferido (OXXO) dejaría el intent sin cobrar y
    // la página lo daría por pagado. La modalidad y la dirección viajan en
    // metadata: al confirmar se leen de Stripe, no del cliente.
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(total * 100),
      currency: 'mxn',
      payment_method_types: ['card'],
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

// Devuelve el cobro completo. La llave de idempotencia evita dos devoluciones
// del mismo intent aunque Stripe reciba la petición dos veces.
function devolverCobro(paymentIntent, motivo, userId) {
  return stripe.refunds.create(
    { payment_intent: paymentIntent.id, metadata: { motivo: motivo.slice(0, 450), usuario_id: String(userId) } },
    { idempotencyKey: `devolucion-${paymentIntent.id}` }
  );
}

// ¿El intent ya tiene una devolución viva? Una devolución no cambia el status
// del intent (sigue "succeeded"): hay que preguntarle a Stripe
async function tieneDevolucion(paymentIntentId) {
  const devoluciones = await stripe.refunds.list({ payment_intent: paymentIntentId, limit: 10 });
  return devoluciones.data.some(r => r.status !== 'failed' && r.status !== 'canceled');
}

// Cobro que no se pudo registrar ni devolver: gerencia y dirección lo
// devuelven a mano. Un solo aviso por intent (la app reintenta 3 veces)
async function avisarCobroSinPedido(paymentIntentId, userId, montoTxt) {
  try {
    const previo = await pool.query(
      `SELECT 1 FROM core.tblnotificaciones
        WHERE titulo = 'Cobro sin pedido' AND strpos(mensaje, $1) > 0 AND created_at > NOW() - INTERVAL '24 hours' LIMIT 1`,
      [paymentIntentId]
    );
    if (previo.rows.length > 0) return;
    const cliente = await pool.query('SELECT nombre, apellido, email FROM core.tblusuarios WHERE id = $1', [userId]);
    const c = cliente.rows[0];
    const quien = c ? `${`${c.nombre} ${c.apellido || ''}`.trim()} (${c.email})` : `el cliente ${userId}`;
    await notificarRoles(['gerencia', 'direccion_general'], {
      tipo: 'alerta',
      titulo: 'Cobro sin pedido',
      mensaje: `Devuelve a mano en Stripe el pago ${paymentIntentId} de ${quien} por $${montoTxt}.`,
    });
  } catch (e) {
    console.error('Aviso de cobro sin pedido falló:', e.message);
  }
}

// Avisos y correos del pedido pagado, después de responder (§5.0)
async function avisarPedidoPagado({ userId, numero, total, items, envio, tipoEntrega, porConfirmar, faltantes, horarioRecogida, stockAgotado, stockBajo }) {
  // Pedido programado con faltantes: el personal debe aprobarlo o rechazarlo
  if (porConfirmar) {
    try {
      const fechaTxt = horarioRecogida
        ? new Date(horarioRecogida).toLocaleDateString('es-MX', { timeZone: 'America/Mexico_City', weekday: 'long', day: 'numeric', month: 'long' })
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

  // Notificación y correo al cliente
  try {
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
            : `Tu pedido #${numero} por $${total.toFixed(2)} está pagado y listo para recoger.`,
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
              : '<p>Tu pedido ya está listo. Recógelo en la sucursal y el horario que elegiste; presenta tu número de pedido.</p>'}
        `
      });
    }
  } catch (emailError) {
    console.error('Error enviando notificación:', emailError.message);
  }
}

// ── Confirmar pago y crear pedido ──
// Diseno_Panel_Cliente.md §5.5. Idempotente por payment_intent_id (candado
// consultivo): un reintento responde el pedido ya creado. Si después de
// cobrar ya no se puede crear el pedido, el cobro se devuelve con el candado
// tomado y un intent con devolución nunca crea pedido.
router.post('/confirmar', verifyToken, async (req, res) => {
  const userId = req.user.userId;
  const { payment_intent_id } = req.body;
  if (typeof payment_intent_id !== 'string' || !/^pi_[A-Za-z0-9]{8,}$/.test(payment_intent_id)) {
    return res.status(400).json({ success: false, message: 'Pago no válido' });
  }
  // Notas y horarios no se rechazan: el cobro ya ocurrió
  const notasLimpias = textoLibre(req.body.notas, { opcional: true });
  const notas = notasLimpias.ok ? notasLimpias.valor : null;
  const horarioRecogida = horarioValido(req.body.horario_recogida);
  const horarioEntrega = horarioValido(req.body.horario_entrega);

  let client;
  let enTransaccion = false;
  let cobroConfirmado = false;
  try {
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
    // Desde aquí el dinero ya se cobró: un error responde CONFIRMACION_PENDIENTE
    cobroConfirmado = true;

    const tipoEntrega = paymentIntent.metadata.tipo_entrega === 'domicilio' ? 'domicilio' : 'pickup';
    const direccionId = enteroPositivo(paymentIntent.metadata.direccion_id);
    const montoTxt = (paymentIntent.amount / 100).toFixed(2);

    client = await pool.connect();
    await client.query('BEGIN');
    enTransaccion = true;
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [payment_intent_id]);

    // Idempotencia: este intent ya registró su pedido
    const previo = await client.query(
      'SELECT p.* FROM core.tblpagos pg JOIN core.tblpedidos p ON p.id = pg.pedido_id WHERE pg.stripe_payment_id = $1',
      [payment_intent_id]
    );
    if (previo.rows.length > 0) {
      await client.query('COMMIT');
      enTransaccion = false;
      const pedidoPrevio = previo.rows[0];
      if (pedidoPrevio.usuario_id !== Number(userId)) {
        return res.status(403).json({ success: false, message: 'El pago no corresponde a este usuario' });
      }
      return res.json({ success: true, pedido: pedidoPrevio, ya_registrado: true });
    }

    // Cobro ya devuelto: nunca se crea un pedido con el dinero devuelto
    if (await tieneDevolucion(payment_intent_id)) {
      await client.query('ROLLBACK');
      enTransaccion = false;
      return res.status(409).json({
        success: false,
        codigo: 'COBRO_DEVUELTO',
        status: 'refunded',
        reembolsado: true,
        message: 'Este pago ya se devolvió a tu tarjeta. Para hacer tu pedido, vuelve a pagar desde tu carrito.',
      });
    }

    // Bloquear los productos del carrito (en orden: sin bloqueos mutuos)
    await client.query(
      `SELECT id FROM core.tblproductos
        WHERE id IN (SELECT producto_id FROM core.tblcarrito_items WHERE usuario_id = $1)
        ORDER BY id FOR UPDATE`,
      [userId]
    );

    const permitirFuturo = tipoEntrega === 'pickup' && esRecogidaFutura(horarioRecogida);
    const carrito = await obtenerCarrito(client, userId, permitirFuturo);
    const envio = carrito.error ? null : await resolverEnvio(client, userId, tipoEntrega, direccionId);
    let motivo = carrito.error || (envio && envio.error) || null;
    if (!motivo && paymentIntent.amount !== Math.round((carrito.subtotal + envio.costo_envio) * 100)) {
      motivo = 'El carrito cambió después de iniciar el pago.';
    }

    if (motivo) {
      // Se devuelve con la transacción y el candado abiertos: un reintento
      // simultáneo espera y, al entrar, ya ve la devolución
      let devuelto = false;
      try {
        await devolverCobro(paymentIntent, motivo, userId);
        devuelto = true;
      } catch (stripeError) {
        console.error('Devolución automática falló:', stripeError.message);
      }
      await client.query('ROLLBACK');
      enTransaccion = false;
      const detalles = `${payment_intent_id} · $${montoTxt} · ${recortar(motivo, 80)}`;
      if (devuelto) {
        const frase = /[.!?]$/.test(motivo) ? motivo : `${motivo}.`;
        res.status(409).json({
          success: false,
          codigo: 'COBRO_DEVUELTO',
          status: 'refunded',
          reembolsado: true,
          message: `${frase} Te devolvimos $${montoTxt} a tu tarjeta; el banco puede tardar de 5 a 10 días hábiles en mostrarlo.`,
        });
        registrarAuditoria({ accion: 'Devolvió cobro sin pedido', entidad: 'pago', entidad_id: null, detalles, ip: req.ip });
        return;
      }
      res.status(500).json({
        success: false,
        codigo: 'COBRO_SIN_PEDIDO',
        message: `Tu pago se cobró pero no pudimos registrar el pedido ni devolverlo automáticamente. Ya avisamos a la sucursal para devolvértelo. Referencia: ${payment_intent_id.slice(-6)}`,
      });
      registrarAuditoria({ accion: 'Cobro sin pedido sin devolver', entidad: 'pago', entidad_id: null, detalles, ip: req.ip });
      avisarCobroSinPedido(payment_intent_id, userId, montoTxt);
      return;
    }

    const { items, subtotal } = carrito;
    const faltantes = carrito.faltantes || [];
    const porConfirmar = faltantes.length > 0;
    const total = subtotal + envio.costo_envio;

    // Los productos ya están hechos (repostería lista): el pedido pagado
    // nace "listo" — pickup y domicilio por igual (los de domicilio entran
    // al pool de repartidores). La excepción: un pedido programado con
    // productos sin stock hoy nace "pendiente" y por_confirmar, para que
    // el personal apruebe si podrá tenerse en esa fecha.
    const estadoInicial = porConfirmar ? 'pendiente' : 'listo';
    // El número lleva la fecha de Huejutla; si choca con otro, se intenta otro
    const dia = diaHuejutla().replace(/-/g, '').slice(2);
    let pedido = null;
    for (let intento = 1; !pedido; intento++) {
      const numero = `PIER-${dia}-${Math.floor(1000 + Math.random() * 9000)}`;
      await client.query('SAVEPOINT pedido');
      try {
        const pedidoResult = await client.query(
          `INSERT INTO core.tblpedidos
            (numero, usuario_id, total, estado, notas, horario_recogida, metodo_pago,
             tipo_entrega, costo_envio, direccion_entrega, horario_entrega, por_confirmar, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,'tarjeta',$7,$8,$9,$10,$11,NOW(),NOW()) RETURNING *`,
          [
            numero, userId, total, estadoInicial, notas,
            tipoEntrega === 'pickup' ? horarioRecogida : null,
            tipoEntrega, envio.costo_envio,
            envio.direccion ? JSON.stringify(envio.direccion) : null,
            tipoEntrega === 'domicilio' ? horarioEntrega : null,
            porConfirmar,
          ]
        );
        pedido = pedidoResult.rows[0];
        await client.query('RELEASE SAVEPOINT pedido');
      } catch (insertError) {
        if (insertError.code !== '23505' || insertError.constraint !== 'tblpedidos_numero_key' || intento >= 5) throw insertError;
        await client.query('ROLLBACK TO SAVEPOINT pedido');
      }
    }

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
    try {
      await client.query(
        `INSERT INTO core.tblpagos (pedido_id, monto_subtotal, monto_total, estado, stripe_payment_id, created_at)
         VALUES ($1,$2,$3,'pagado',$4,NOW())`,
        [pedido.id, subtotal, total, payment_intent_id]
      );
    } catch (pagoError) {
      if (pagoError.code !== '23505' || pagoError.constraint !== 'tblpagos_stripe_payment_id_key') throw pagoError;
      // Otro registro ganó con este mismo intent: se responde su pedido
      await client.query('ROLLBACK');
      enTransaccion = false;
      const existente = await client.query(
        'SELECT p.* FROM core.tblpagos pg JOIN core.tblpedidos p ON p.id = pg.pedido_id WHERE pg.stripe_payment_id = $1',
        [payment_intent_id]
      );
      const pedidoExistente = existente.rows[0];
      if (!pedidoExistente || pedidoExistente.usuario_id !== Number(userId)) {
        return res.status(403).json({ success: false, message: 'El pago no corresponde a este usuario' });
      }
      return res.json({ success: true, pedido: pedidoExistente, ya_registrado: true });
    }

    await client.query('COMMIT');
    enTransaccion = false;

    res.json({ success: true, pedido, ya_registrado: false });

    avisarPedidoPagado({
      userId, numero: pedido.numero, total, items, envio, tipoEntrega, porConfirmar, faltantes,
      horarioRecogida, stockAgotado, stockBajo,
    }).catch(e => console.error('Avisos del pedido fallaron:', e.message));
  } catch (error) {
    if (client && enTransaccion) await client.query('ROLLBACK').catch(() => {});
    console.error('Error confirmando pago:', error.message);
    if (res.headersSent) return;
    if (cobroConfirmado) {
      return res.status(500).json({
        success: false,
        codigo: 'CONFIRMACION_PENDIENTE',
        message: 'Tu pago quedó hecho, pero no pudimos registrar tu pedido. Vuelve a intentarlo en un momento: no se te cobrará otra vez.',
      });
    }
    res.status(500).json({ success: false, message: 'Error al confirmar pago' });
  } finally {
    if (client) client.release();
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
