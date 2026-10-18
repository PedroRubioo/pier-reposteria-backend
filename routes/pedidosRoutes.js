// routes/pedidosRoutes.js — Pedidos
const express = require('express');
const router = express.Router();
const he = require('he'); // 🔒 SEGURIDAD: sanitización de HTML
const { pool } = require('../config/database');
const { verifyToken, verifyRole } = require('../middleware/auth');
const { calcularRiesgo } = require('../utils/riesgoCancelacion');
const { registrarAuditoria, recortar } = require('../utils/auditoria');

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

// ── Riesgo de cancelación de pedidos entrantes (empleado+) ──
// Variables extraídas en vivo de la BD; el puntaje vive en utils/riesgoCancelacion
router.get('/riesgos', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.id, p.total, p.tipo_entrega, p.metodo_pago, p.horario_recogida, p.horario_entrega,
             p.created_at, u.created_at AS cliente_desde,
             (SELECT COUNT(*)::int FROM core.tblpedidos x WHERE x.usuario_id = p.usuario_id AND x.estado = 'completado' AND x.id <> p.id) AS pedidos_previos,
             (SELECT COUNT(*)::int FROM core.tblpedidos x WHERE x.usuario_id = p.usuario_id AND x.estado = 'cancelado') AS cancelaciones_previas,
             (SELECT COALESCE(SUM(i.cantidad), 0)::int FROM core.tblpedido_items i WHERE i.pedido_id = p.id) AS num_items
      FROM core.tblpedidos p
      JOIN core.tblusuarios u ON u.id = p.usuario_id
      WHERE p.estado IN ('pendiente', 'listo')
    `);
    const riesgos = {};
    for (const fila of result.rows) riesgos[fila.id] = calcularRiesgo(fila);
    res.json({ success: true, riesgos });
  } catch (error) {
    console.error('Error GET /pedidos/riesgos:', error.message);
    res.status(500).json({ success: false, message: 'Error al calcular riesgos' });
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
// Sin `vista` se comporta como siempre (la skill de Alexa usa ?limite= y
// ?estado=): los 100 más recientes. vista=abiertos y vista=historial son
// las bandejas de la página de Pedidos; buscar y completo=1 son opcionales
// (Diseno_Panel_Personal.md §4.3).

// Hora comprometida con el cliente: la recogida, la entrega a domicilio
// (timestamp guardado en UTC) o, si no hay, cuándo se hizo el pedido
const COMPROMISO_PEDIDO = `COALESCE(p.horario_recogida, p.horario_entrega AT TIME ZONE 'UTC', p.created_at)`;
const VISTAS_PEDIDOS = {
  abiertos: { filtro: `p.estado NOT IN ('completado', 'entregado', 'cancelado')`, orden: `${COMPROMISO_PEDIDO} ASC, p.id`, porDefecto: 500, maximo: 500 },
  historial: { filtro: `p.estado IN ('completado', 'entregado', 'cancelado')`, orden: 'p.updated_at DESC, p.id DESC', porDefecto: 50, maximo: 200 },
};
// completo=1: los renglones del pedido y su entrega más reciente (activa o no)
const DETALLE_COMPLETO = `
      LEFT JOIN LATERAL (SELECT COALESCE(json_agg(json_build_object('producto_id', i.producto_id, 'nombre', i.nombre_producto,
               'cantidad', i.cantidad, 'tamano', i.tamano, 'precio_unitario', i.precio_unitario, 'subtotal', i.subtotal)
               ORDER BY i.id), '[]'::json) AS items FROM core.tblpedido_items i WHERE i.pedido_id = p.id) it ON TRUE
      LEFT JOIN LATERAL (SELECT json_build_object('id', x.id, 'estado', x.estado,
               'repartidor_nombre', TRIM(rr.nombre || ' ' || rr.apellido), 'motivo_fallo', x.motivo_fallo,
               'recibio_nombre', x.recibio_nombre, 'evidencia_url', x.evidencia_url,
               'asignado_at', x.asignado_at AT TIME ZONE 'UTC', 'finalizado_at', x.finalizado_at AT TIME ZONE 'UTC') AS ultima_entrega
               FROM core.tblentregas x JOIN core.tblusuarios rr ON rr.id = x.repartidor_id
              WHERE x.pedido_id = p.id ORDER BY x.id DESC LIMIT 1) ue ON TRUE`;

router.get('/', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  try {
    const { estado, limite, offset, vista } = req.query;
    if (vista !== undefined && vista !== 'abiertos' && vista !== 'historial') {
      return res.status(400).json({ success: false, message: 'Vista no válida. Valores: abiertos, historial' });
    }
    const bandeja = vista === 'abiertos' ? VISTAS_PEDIDOS.abiertos : vista === 'historial' ? VISTAS_PEDIDOS.historial : null;
    const completo = req.query.completo === '1';
    const buscar = typeof req.query.buscar === 'string' ? req.query.buscar.trim().slice(0, 100) : '';

    let query = `SELECT p.*, u.nombre AS cliente_nombre, u.apellido AS cliente_apellido, u.email AS cliente_email, pg.estado AS estado_pago, pg.stripe_payment_id, pg.monto_total AS monto_pago,
      r.nombre AS repartidor_nombre, r.apellido AS repartidor_apellido,
      u.telefono AS cliente_telefono, e.id AS entrega_id, r.telefono AS repartidor_telefono, ${COMPROMISO_PEDIDO} AS compromiso${completo ? ', it.items, ue.ultima_entrega' : ''}
      FROM core.tblpedidos p
      JOIN core.tblusuarios u ON p.usuario_id = u.id
      LEFT JOIN core.tblpagos pg ON pg.pedido_id = p.id
      LEFT JOIN core.tblentregas e ON e.pedido_id = p.id AND e.estado IN ('asignada', 'en_camino')
      LEFT JOIN core.tblusuarios r ON r.id = e.repartidor_id${completo ? DETALLE_COMPLETO : ''}
      WHERE 1=1`;
    const params = [];
    let pi = 1;
    if (bandeja) query += ` AND ${bandeja.filtro}`;
    if (estado) { query += ` AND p.estado = $${pi}`; params.push(estado); pi++; }
    if (buscar) {
      // Número de pedido, nombre o correo del cliente; % _ y \ cuentan como texto
      query += ` AND (p.numero ILIKE $${pi} OR (u.nombre || ' ' || u.apellido) ILIKE $${pi} OR u.email ILIKE $${pi})`;
      params.push(`%${buscar.replace(/[\\%_]/g, '\\$&')}%`);
      pi++;
    }
    if (!bandeja) {
      query += ` ORDER BY p.created_at DESC`;
      query += ` LIMIT $${pi} OFFSET $${pi + 1}`;
      params.push(parseInt(String(limite)) || 100, parseInt(String(offset)) || 0);
      const result = await pool.query(query, params);
      return res.json({ success: true, pedidos: result.rows });
    }

    const solicitado = Number.parseInt(String(limite), 10);
    const tope = Number.isFinite(solicitado) && solicitado >= 1 ? Math.min(solicitado, bandeja.maximo) : bandeja.porDefecto;
    const desde = Math.max(Number.parseInt(String(offset), 10) || 0, 0);
    // En el historial se pide una fila de más: dice si hay otra página
    const conHayMas = vista === 'historial';
    query += ` ORDER BY ${bandeja.orden} LIMIT $${pi} OFFSET $${pi + 1}`;
    params.push(conHayMas ? tope + 1 : tope, desde);
    const result = await pool.query(query, params);
    if (!conHayMas) return res.json({ success: true, pedidos: result.rows });
    const hayMas = result.rows.length > tope;
    res.json({ success: true, pedidos: hayMas ? result.rows.slice(0, tope) : result.rows, hay_mas: hayMas });
  } catch (error) {
    console.error('Error GET /pedidos:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener pedidos' });
  }
});

// ── Cambiar estado del pedido (empleado+) ──
// Cancelar un pedido abierto (Diseno_Panel_Personal.md §4.4), en la misma
// transacción: repone el inventario, quita el «por confirmar», cierra la
// entrega activa y, si el pedido está pagado y no tiene ya un reembolso
// vivo, genera la solicitud de reembolso. Un pedido entregado ya no se
// cancela; re-cancelar uno cancelado sigue como antes, sin esas acciones.
router.put('/:id/estado', verifyToken, verifyRole('empleado', 'gerencia', 'direccion_general'), async (req, res) => {
  let client;
  try {
    const { estado, nota_cancelacion } = req.body;
    // Los estados de entrega (asignado/en_camino/entregado/entrega_fallida) los maneja
    // normalmente el flujo de /api/entregas; aquí quedan disponibles como corrección manual.
    const validos = ['pendiente', 'en_preparacion', 'listo', 'completado', 'cancelado', 'asignado', 'en_camino', 'entregado', 'entrega_fallida'];
    if (!validos.includes(estado)) return res.status(400).json({ success: false, message: `Estado inválido. Valores: ${validos.join(', ')}` });

    client = await pool.connect();
    await client.query('BEGIN');
    // Al cancelar, primero la entrega activa y después el pedido: el mismo
    // orden que el repartidor al cambiar su estado y que /liberar
    // (entregasRoutes.js). Si actúan a la vez, se forman en lugar de caer en
    // un bloqueo mutuo
    if (estado === 'cancelado') {
      await client.query(
        `SELECT id FROM core.tblentregas WHERE pedido_id = $1 AND estado IN ('asignada', 'en_camino') FOR UPDATE`,
        [req.params.id]
      );
    }
    const previoResult = await client.query('SELECT estado FROM core.tblpedidos WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (previoResult.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'Pedido no encontrado' }); }
    const estadoPrevio = previoResult.rows[0].estado;
    if (estado === 'cancelado' && (estadoPrevio === 'completado' || estadoPrevio === 'entregado')) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: 'Este pedido ya se entregó y no se puede cancelar' });
    }
    const cancelaAbierto = estado === 'cancelado' && estadoPrevio !== 'cancelado';

    const updates = [estado];
    let query = 'UPDATE core.tblpedidos SET estado = $1, updated_at = NOW()';
    let pi = 2;
    if (cancelaAbierto) query += ', por_confirmar = FALSE';
    if (estado === 'cancelado' && nota_cancelacion) { query += `, nota_cancelacion = $${pi}`; updates.push(nota_cancelacion); pi++; }
    query += ` WHERE id = $${pi} RETURNING *`;
    updates.push(req.params.id);
    const result = await client.query(query, updates);
    const pedido = result.rows[0];

    let entregasCerradas = [];
    let reembolso = null;
    if (cancelaAbierto) {
      // Reponer el inventario que este pedido descontó. stock_descontado
      // queda en 0 tras reponer, así una re-cancelación no duplica la
      // devolución (y reactivar un cancelado no vuelve a descontar).
      await client.query(
        `UPDATE core.tblproductos p
         SET stock_online = p.stock_online + i.stock_descontado, updated_at = NOW()
         FROM core.tblpedido_items i
         WHERE i.pedido_id = $1 AND i.producto_id = p.id AND i.stock_descontado > 0`,
        [req.params.id]
      );
      await client.query('UPDATE core.tblpedido_items SET stock_descontado = 0 WHERE pedido_id = $1', [req.params.id]);

      // La nota de la sucursal acompaña al motivo de la entrega y al reembolso
      const nota = nota_cancelacion ? String(nota_cancelacion).trim() : '';
      const conNota = nota ? `: ${nota}` : '';
      const entregas = await client.query(
        `UPDATE core.tblentregas SET estado = 'fallida', motivo_fallo = $2, finalizado_at = NOW(), updated_at = NOW()
          WHERE pedido_id = $1 AND estado IN ('asignada', 'en_camino')
         RETURNING id, repartidor_id`,
        [pedido.id, recortar(`Pedido cancelado por la sucursal${conNota}`, 300)]
      );
      entregasCerradas = entregas.rows;

      // Reembolso automático: solo si se cobró en línea y no hay ya uno vivo
      // (la descripción la reconoce GET /api/reembolsos como automática)
      const cobro = await client.query(
        `SELECT EXISTS (SELECT 1 FROM core.tblpagos WHERE pedido_id = $1 AND estado = 'pagado') AS pagado,
                EXISTS (SELECT 1 FROM core.tblreembolsos WHERE pedido_id = $1
                         AND estado IN ('pendiente', 'en_revision', 'aprobado', 'procesado')) AS con_reembolso`,
        [pedido.id]
      );
      if (cobro.rows[0].pagado && !cobro.rows[0].con_reembolso) {
        const nuevo = await client.query(
          `INSERT INTO core.tblreembolsos (pedido_id, producto_id, usuario_id, monto, motivo, descripcion, fotos_evidencia, estado, created_at, updated_at)
           VALUES ($1, NULL, $2, $3, 'otro', $4, NULL, 'pendiente', NOW(), NOW())
           RETURNING id, monto`,
          [pedido.id, pedido.usuario_id, pedido.total, recortar(`Pedido #${pedido.numero} cancelado por la sucursal${conNota}`, 300)]
        );
        reembolso = nuevo.rows[0];
      }
    }
    await client.query('COMMIT');

    // Anterior y nuevo salen de la base (FOR UPDATE y RETURNING), no del body
    registrarAuditoria({ usuario_id: req.user.userId, accion: 'Cambió estado de pedido', entidad: 'pedido', entidad_id: pedido.id, detalles: `#${pedido.numero} · ${estadoPrevio} → ${pedido.estado}`, ip: req.ip });
    if (reembolso) {
      registrarAuditoria({ usuario_id: req.user.userId, accion: 'Generó reembolso por cancelación', entidad: 'reembolso', entidad_id: reembolso.id, detalles: `#${pedido.numero} · $${parseFloat(reembolso.monto).toFixed(2)}`, ip: req.ip });
    }
    if (entregasCerradas.length > 0) {
      // Al repartidor que la llevaba: ya no la entregue
      const { crearNotificacion } = require('../services/notificacionHelper');
      await Promise.all(entregasCerradas.map(e => crearNotificacion({
        usuario_id: e.repartidor_id,
        tipo: 'alerta',
        titulo: 'Entrega cancelada',
        mensaje: `El pedido #${pedido.numero} se canceló; ya no lo entregues.`,
      })));
    }

    // Notificación para el cliente
    const esDomicilio = pedido.tipo_entrega === 'domicilio';
    const mensajes = {
      en_preparacion: { titulo: 'Pedido en preparación', mensaje: `Tu pedido #${pedido.numero} ha comenzado a prepararse.`, tipo: 'pedido' },
      listo: esDomicilio
        ? { titulo: '¡Tu pedido está listo!', mensaje: `Tu pedido #${pedido.numero} está listo. Pronto saldrá en camino a tu domicilio.`, tipo: 'pedido' }
        : { titulo: '¡Tu pedido está listo!', mensaje: `Tu pedido #${pedido.numero} está listo para recoger en Sucursal Principal.`, tipo: 'pedido' },
      completado: { titulo: 'Pedido completado', mensaje: `Tu pedido #${pedido.numero} ha sido entregado. ¡Gracias por tu compra!`, tipo: 'pedido' },
      // Con reembolso no se promete la devolución: la decide gerencia
      cancelado: {
        titulo: 'Pedido cancelado',
        mensaje: [
          `Tu pedido #${pedido.numero} ha sido cancelado. ${nota_cancelacion || ''}`.trim(),
          reembolso ? 'Generamos tu solicitud de reembolso; te avisaremos cuando se revise.' : null,
        ].filter(Boolean).join(' '),
        tipo: 'sistema',
      },
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

    res.json({ success: true, pedido, reembolso_generado: reembolso !== null, entrega_cerrada: entregasCerradas.length > 0 });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    // Respaldo: si Postgres corta un bloqueo mutuo (40P01), se explica en
    // lugar de un 500 genérico
    if (error.code === '40P01') {
      return res.status(409).json({ success: false, message: 'Otra persona cambió este pedido al mismo tiempo; recarga e intenta de nuevo' });
    }
    console.error('Error PUT /pedidos/:id/estado:', error.message);
    res.status(500).json({ success: false, message: 'Error al actualizar estado' });
  } finally { if (client) client.release(); }
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

    registrarAuditoria({ usuario_id: req.user.userId, accion: 'Aprobó pedido por confirmar', entidad: 'pedido', entidad_id: p.id, detalles: `#${p.numero}`, ip: req.ip });
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

    registrarAuditoria({ usuario_id: req.user.userId, accion: 'Rechazó pedido por confirmar', entidad: 'pedido', entidad_id: p.id, detalles: `#${p.numero} · ${recortar(String(motivo).trim(), 80)}`, ip: req.ip });
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

// ── Cancelación por el propio cliente ──
// Permitida solo mientras ningún repartidor haya aceptado el pedido:
// estados pendiente o listo (al aceptar pasa a 'asignado' y ya no aplica).
// Repone el stock descontado y genera la solicitud de reembolso automática.
router.put('/:id/cancelar', verifyToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT p.*, u.nombre AS cliente_nombre, u.email AS cliente_email
       FROM core.tblpedidos p JOIN core.tblusuarios u ON u.id = p.usuario_id
       WHERE p.id = $1 FOR UPDATE`,
      [req.params.id]
    );
    if (result.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'Pedido no encontrado' }); }
    const p = result.rows[0];
    if (p.usuario_id !== req.user.userId) { await client.query('ROLLBACK'); return res.status(403).json({ success: false, message: 'Sin permiso' }); }

    const yaTomado = ['asignado', 'en_camino'].includes(p.estado);
    if (!['pendiente', 'listo'].includes(p.estado)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        message: yaTomado ? 'Un repartidor ya tomó tu pedido; ya no es posible cancelarlo' : 'Este pedido ya no puede cancelarse',
      });
    }
    // Doble seguro contra la carrera con la aceptación del repartidor
    const entregaActiva = await client.query(
      `SELECT 1 FROM core.tblentregas WHERE pedido_id = $1 AND estado IN ('asignada', 'en_camino')`,
      [p.id]
    );
    if (entregaActiva.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Un repartidor ya tomó tu pedido; ya no es posible cancelarlo' });
    }

    await client.query(
      `UPDATE core.tblpedidos SET estado = 'cancelado', por_confirmar = FALSE, nota_cancelacion = $1, updated_at = NOW() WHERE id = $2`,
      ['Cancelado por el cliente antes de la entrega', p.id]
    );

    // Reponer exactamente el inventario que se descontó al pagar
    await client.query(
      `UPDATE core.tblproductos pr
       SET stock_online = pr.stock_online + i.stock_descontado, updated_at = NOW()
       FROM core.tblpedido_items i
       WHERE i.pedido_id = $1 AND i.producto_id = pr.id AND i.stock_descontado > 0`,
      [p.id]
    );
    await client.query('UPDATE core.tblpedido_items SET stock_descontado = 0 WHERE pedido_id = $1', [p.id]);

    // Reembolso automático: el cliente ya pagó en línea
    await client.query(
      `INSERT INTO core.tblreembolsos (pedido_id, producto_id, usuario_id, monto, motivo, descripcion, fotos_evidencia, estado, created_at, updated_at)
       VALUES ($1, NULL, $2, $3, 'otro', $4, NULL, 'pendiente', NOW(), NOW())`,
      [p.id, p.usuario_id, p.total, `Pedido #${p.numero} cancelado por el cliente antes de la entrega`]
    );
    await client.query('COMMIT');

    registrarAuditoria({ usuario_id: p.usuario_id, accion: 'Cliente canceló su pedido', entidad: 'pedido', entidad_id: p.id, detalles: `#${p.numero} · $${parseFloat(p.total).toFixed(2)}`, ip: req.ip });
    const { notificarConEmail, crearNotificacion } = require('../services/notificacionHelper');
    const safeNumero = he.escape(String(p.numero));
    const totalTxt = parseFloat(p.total).toFixed(2);

    // Confirmación al cliente (notificación + correo)
    await notificarConEmail({
      usuario_id: p.usuario_id,
      tipo: 'pedido',
      titulo: 'Tu pedido fue cancelado',
      mensaje: `Cancelaste tu pedido #${p.numero}. Tu pago de $${totalTxt} será reembolsado; ya generamos la solicitud.`,
      email: p.cliente_email,
      nombre: p.cliente_nombre,
      asunto: `Pedido #${safeNumero} cancelado — Pier Repostería`,
      contenidoHtml: `
        <h2>Pedido cancelado</h2>
        <div class="highlight-box">
          <p><strong>Pedido:</strong> #${safeNumero}</p>
          <p><strong>Monto a reembolsar:</strong> $${he.escape(totalTxt)} MXN</p>
        </div>
        <p>Cancelaste tu pedido a tiempo y ya generamos la solicitud de reembolso; te avisaremos cuando se procese.</p>
        <p>¡Esperamos consentirte pronto! 🧁</p>
      `,
    });

    // Aviso al personal para que no lo prepare ni lo despache
    try {
      const personal = await pool.query(`SELECT id FROM core.tblusuarios WHERE rol IN ('empleado', 'gerencia') AND activo = true`);
      await Promise.all(personal.rows.map(u => crearNotificacion({
        usuario_id: u.id,
        tipo: 'alerta',
        titulo: 'Pedido cancelado por el cliente',
        mensaje: `El cliente canceló el pedido #${p.numero} ($${totalTxt}) antes de ser tomado por un repartidor. Se generó su reembolso.`,
      })));
    } catch (e) { console.error('Aviso al personal falló:', e.message); }

    res.json({ success: true, message: 'Pedido cancelado; tu reembolso ya está en proceso' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error PUT /pedidos/:id/cancelar:', error.message);
    res.status(500).json({ success: false, message: 'Error al cancelar el pedido' });
  } finally { client.release(); }
});

module.exports = router;