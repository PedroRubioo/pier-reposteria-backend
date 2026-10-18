// routes/reembolsosRoutes.js — Reembolsos
const express = require('express');
const router = express.Router();
const he = require('he'); // 🔒 SEGURIDAD: sanitización de HTML
const { pool } = require('../config/database');
const { verifyToken, verifyRole } = require('../middleware/auth');
const { accesoVigente } = require('../middleware/usuarioVigente');
const { registrarAuditoria, recortar } = require('../utils/auditoria');
const { textoLibre, enteroPositivo, esUrlCloudinary, normalizarClave } = require('../utils/validacionCliente');

// Bitácora: la acción depende del estado al que pasa el reembolso
const ACCION_REEMBOLSO = new Map([
  ['en_revision', 'Pasó reembolso a revisión'],
  ['aprobado', 'Aprobó reembolso'],
  ['rechazado', 'Rechazó reembolso'],
  ['procesado', 'Procesó reembolso'],
]);

// Pasos permitidos (Diseno_Panel_Personal.md §4.10): desde qué estados se
// llega a cada uno y quién lo decide. El mostrador solo pasa a revisión;
// aprobar mueve dinero y lo deciden gerencia o dirección. Rechazado y
// procesado son finales: ningún paso regresa una decisión.
const PASOS_REEMBOLSO = new Map([
  ['en_revision', { desde: ['pendiente'], roles: ['empleado', 'gerencia', 'direccion_general'] }],
  ['aprobado', { desde: ['pendiente', 'en_revision'], roles: ['gerencia', 'direccion_general'] }],
  ['rechazado', { desde: ['pendiente', 'en_revision'], roles: ['gerencia', 'direccion_general'] }],
  ['procesado', { desde: ['aprobado'], roles: ['gerencia', 'direccion_general'] }],
]);

// Motivos (Diseno_Panel_Cliente.md §5.7): la web manda el valor del enum y la
// app su etiqueta («Producto dañado», «Error en sabor»…). Claves normalizadas
const MOTIVOS_REEMBOLSO = new Map([
  ['producto_danado', 'producto_danado'], ['producto danado', 'producto_danado'], ['producto en mal estado', 'producto_danado'],
  ['no_satisfecho', 'no_satisfecho'], ['calidad no satisfactoria', 'no_satisfecho'], ['no satisfecho con el producto', 'no_satisfecho'],
  ['pedido_incorrecto', 'pedido_incorrecto'], ['no corresponde al pedido', 'pedido_incorrecto'], ['error en sabor', 'pedido_incorrecto'], ['pedido incorrecto', 'pedido_incorrecto'],
  ['tardanza', 'tardanza'], ['tardanza en preparacion', 'tardanza'],
  ['cantidad_incorrecta', 'cantidad_incorrecta'], ['pedido incompleto', 'cantidad_incorrecta'], ['cantidad incorrecta', 'cantidad_incorrecta'],
  ['otro', 'otro'], ['otro motivo', 'otro'],
]);
// Un reembolso vivo por pedido; así se llama cada estado en la web
const ESTADO_REEMBOLSO_LEGIBLE = new Map([['pendiente', 'pendiente'], ['en_revision', 'en revisión'], ['aprobado', 'aprobado'], ['procesado', 'devuelto']]);
const MAX_FOTOS_REEMBOLSO = 6;
const falta = (v) => v === undefined || v === null || v === '';

// Solicitar reembolso (cliente). El pedido se bloquea mientras se revisa que
// no tenga ya una solicitud viva: dos envíos seguidos no crean dos
router.post('/', verifyToken, async (req, res) => {
  const { pedido_id, producto_id, monto, motivo, descripcion, fotos_evidencia } = req.body;
  if (falta(pedido_id) || falta(monto) || falta(motivo)) return res.status(400).json({ success: false, message: 'Pedido, monto y motivo son requeridos' });
  const pedidoId = enteroPositivo(pedido_id);
  if (!pedidoId) return res.status(404).json({ success: false, message: 'Pedido no encontrado' });

  const etiqueta = typeof motivo === 'string' ? motivo.trim() : '';
  const motivoEnum = MOTIVOS_REEMBOLSO.get(normalizarClave(etiqueta));
  if (!motivoEnum) return res.status(400).json({ success: false, message: 'Elige un motivo válido' });
  const texto = textoLibre(typeof descripcion === 'number' ? String(descripcion) : descripcion, { opcional: true });
  if (!texto.ok) return res.status(400).json({ success: false, message: 'La descripción no es válida' });
  // Con la etiqueta de la app, la descripción la conserva tal cual llegó
  const descripcionFinal = normalizarClave(etiqueta) === motivoEnum ? texto.valor : `«${etiqueta}». ${texto.valor || ''}`.trim();

  let fotos = null;
  if (!falta(fotos_evidencia)) {
    if (!Array.isArray(fotos_evidencia) || fotos_evidencia.length > MAX_FOTOS_REEMBOLSO || !fotos_evidencia.every(esUrlCloudinary)) {
      return res.status(400).json({ success: false, message: `Las fotos deben subirse desde la página (máximo ${MAX_FOTOS_REEMBOLSO})` });
    }
    fotos = fotos_evidencia;
  }
  let productoId = null;
  if (!falta(producto_id)) {
    productoId = enteroPositivo(producto_id);
    if (!productoId) return res.status(400).json({ success: false, message: 'El producto no está en ese pedido' });
  }
  const montoNum = typeof monto === 'number' ? monto : (typeof monto === 'string' && monto.trim() !== '' ? Number(monto) : NaN);

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // Verificar que el pedido pertenece al usuario y ya se entregó o recogió
    const pedido = await client.query('SELECT id, estado, total FROM core.tblpedidos WHERE id = $1 AND usuario_id = $2 FOR UPDATE', [pedidoId, req.user.userId]);
    if (pedido.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Pedido no encontrado' });
    }
    const { estado, total } = pedido.rows[0];
    if (estado !== 'completado' && estado !== 'entregado') {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Solo puedes pedir reembolso de pedidos entregados o recogidos' });
    }

    // Tope: el total del pedido o, si se indica un producto, su subtotal en
    // el pedido. En centavos: total llega como texto NUMERIC
    let tope = parseFloat(total);
    let mensajeTope = `El monto debe ser mayor que 0 y no puede pasar del total del pedido ($${tope.toFixed(2)})`;
    if (productoId) {
      const renglon = await client.query(
        'SELECT COUNT(*)::int AS renglones, COALESCE(SUM(subtotal), 0) AS subtotal FROM core.tblpedido_items WHERE pedido_id = $1 AND producto_id = $2',
        [pedidoId, productoId]
      );
      if (renglon.rows[0].renglones === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ success: false, message: 'El producto no está en ese pedido' });
      }
      tope = parseFloat(renglon.rows[0].subtotal);
      mensajeTope = `El monto debe ser mayor que 0 y no puede pasar del subtotal de ese producto ($${tope.toFixed(2)})`;
    }
    if (!Number.isFinite(montoNum) || montoNum <= 0 || Math.round(montoNum * 100) > Math.round(tope * 100)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: mensajeTope });
    }

    const vivo = await client.query(
      `SELECT estado FROM core.tblreembolsos WHERE pedido_id = $1 AND estado IN ('pendiente', 'en_revision', 'aprobado', 'procesado')
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [pedidoId]
    );
    if (vivo.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ success: false, message: `Este pedido ya tiene una solicitud de reembolso (${ESTADO_REEMBOLSO_LEGIBLE.get(vivo.rows[0].estado)})` });
    }

    const result = await client.query(
      `INSERT INTO core.tblreembolsos (pedido_id, producto_id, usuario_id, monto, motivo, descripcion, fotos_evidencia, estado, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pendiente',NOW(),NOW()) RETURNING *`,
      [pedidoId, productoId, req.user.userId, montoNum, motivoEnum, descripcionFinal, fotos]
    );
    await client.query('COMMIT');
    res.status(201).json({ success: true, reembolso: result.rows[0] });
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Error POST /reembolsos:', error.message);
    res.status(500).json({ success: false, message: 'Error al solicitar reembolso' });
  } finally {
    if (client) client.release();
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
    // automatico: los reembolsos que genera el sistema al rechazar o cancelar
    // un pedido pagado (pedidosRoutes.js y Diseno_Panel_Personal.md §4.4).
    // COALESCE: sin descripción el LIKE da NULL, y debe salir false
    let query = `SELECT r.*, u.nombre AS cliente_nombre, u.apellido AS cliente_apellido, p.numero AS pedido_numero,
      EXTRACT(DAY FROM NOW() - r.created_at)::INTEGER AS dias_desde_compra,
      CASE WHEN EXTRACT(EPOCH FROM NOW() - r.created_at) <= 18000 THEN true ELSE false END AS cumple_politica,
      u.telefono AS cliente_telefono, p.created_at AS pedido_creado,
      (r.created_at AT TIME ZONE 'America/Mexico_City')::date = (p.created_at AT TIME ZONE 'America/Mexico_City')::date AS mismo_dia_compra,
      ROUND(EXTRACT(EPOCH FROM r.created_at - p.created_at) / 3600.0, 1)::float AS horas_desde_compra,
      COALESCE(r.motivo = 'otro' AND r.producto_id IS NULL AND (
         r.descripcion LIKE 'Pedido programado rechazado por disponibilidad:%'
         OR r.descripcion LIKE 'Pedido #% cancelado por el cliente antes de la entrega'
         OR r.descripcion LIKE 'Pedido #% cancelado por la sucursal%'), false) AS automatico
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

// Gestionar reembolso (empleado+, rol leído de la base). Solo se admiten
// los pasos de PASOS_REEMBOLSO desde el estado actual de la solicitud.
router.put('/:id', accesoVigente(['empleado', 'gerencia', 'direccion_general']), async (req, res) => {
  let client;
  try {
    const { estado, justificacion_rechazo, respuesta_admin } = req.body;
    const paso = PASOS_REEMBOLSO.get(estado);
    if (!paso) return res.status(400).json({ success: false, message: 'Estado inválido' });
    if (!paso.roles.includes(req.usuario.rol)) {
      return res.status(403).json({ success: false, message: 'El mostrador pasa la solicitud a revisión; aprobar, rechazar o marcar como devuelto lo decide gerencia o dirección' });
    }
    if (!/^\d{1,9}$/.test(req.params.id)) return res.status(404).json({ success: false, message: 'Reembolso no encontrado' });
    const id = Number(req.params.id);

    client = await pool.connect();
    await client.query('BEGIN');
    const actual = await client.query('SELECT estado, pedido_id FROM core.tblreembolsos WHERE id = $1 FOR UPDATE', [id]);
    if (actual.rows.length === 0) { await client.query('ROLLBACK'); return res.status(404).json({ success: false, message: 'Reembolso no encontrado' }); }
    const { estado: estadoActual, pedido_id: pedidoId } = actual.rows[0];
    if (!paso.desde.includes(estadoActual)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        success: false,
        message: req.usuario.rol === 'empleado' ? 'Esta solicitud ya no está pendiente' : `No se puede pasar de "${estadoActual}" a "${estado}"`,
      });
    }

    // Marcar como devuelto (procesado) conserva el mensaje y el día de la
    // decisión: sin nota no borra el mensaje de la aprobación, y el reembolso
    // no cambia de día en Reportes ni en el Corte del día
    const procesado = estado === 'procesado';
    let query = `UPDATE core.tblreembolsos SET estado=$1, respuesta_admin=${procesado ? 'COALESCE($2, respuesta_admin)' : '$2'}, updated_at=NOW()`;
    const params = [estado, respuesta_admin || null];
    let pi = 3;
    if (estado === 'rechazado') { query += `, justificacion_rechazo=$${pi}`; params.push(justificacion_rechazo || null); pi++; }
    if (procesado) query += ', fecha_resolucion=COALESCE(fecha_resolucion, NOW())';
    else if (estado === 'aprobado' || estado === 'rechazado') query += ', fecha_resolucion=NOW()';
    query += ` WHERE id=$${pi} RETURNING *`;
    params.push(id);
    const result = await client.query(query, params);

    // El pago pasa a reembolsado solo con un paso válido, en la misma transacción
    if (estado === 'aprobado' || procesado) {
      await client.query('UPDATE core.tblpagos SET estado = $1, reembolsado_at = NOW() WHERE pedido_id = $2', ['reembolsado', pedidoId]);
    }
    await client.query('COMMIT');
    client.release();
    client = null;

    const reembolso = result.rows[0];
    const pedidoInfo = await pool.query('SELECT usuario_id, numero FROM core.tblpedidos WHERE id = $1', [reembolso.pedido_id]);
    registrarAuditoria({
      usuario_id: req.usuario.id, accion: ACCION_REEMBOLSO.get(reembolso.estado), entidad: 'reembolso', entidad_id: reembolso.id,
      detalles: `#${pedidoInfo.rows[0]?.numero} · $${parseFloat(reembolso.monto).toFixed(2)}${reembolso.estado === 'rechazado' && reembolso.justificacion_rechazo ? ` · ${recortar(reembolso.justificacion_rechazo, 80)}` : ''}`,
      ip: req.ip,
    });

    // Crear notificación para el cliente
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

            // 🔒 SEGURIDAD: Sanitizar datos dinámicos antes de insertarlos en HTML
            const safeNumero = he.escape(String(pedidoNumero));
            const safeMonto = he.escape(String(reembolso.monto));
            const safeJustificacion = justificacion_rechazo ? he.escape(String(justificacion_rechazo)) : '';

            await notificarConEmail({
              usuario_id: clienteId, tipo, titulo, mensaje,
              email: u.email, nombre: u.nombre,
              asunto: estado === 'aprobado' ? `✅ Reembolso aprobado — Pedido #${safeNumero}` : `Reembolso rechazado — Pedido #${safeNumero}`,
              contenidoHtml: estado === 'aprobado'
                ? `<h2>Tu reembolso ha sido aprobado</h2>
                   <div class="highlight-box">
                     <p><strong>Pedido:</strong> #${safeNumero}</p>
                     <p><strong>Monto reembolsado:</strong> $${safeMonto} MXN</p>
                   </div>
                   <p>El reembolso se procesará en los próximos días hábiles.</p>`
                : `<h2>Tu solicitud de reembolso no fue aprobada</h2>
                   <div class="highlight-box">
                     <p><strong>Pedido:</strong> #${safeNumero}</p>
                     ${safeJustificacion ? `<p><strong>Motivo:</strong> ${safeJustificacion}</p>` : ''}
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

    // Marcado como devuelto: el cliente sabe que el dinero ya salió (Diseno_Panel_Cliente.md §5.7)
    if (procesado && pedidoInfo.rows.length > 0) {
      const { crearNotificacion } = require('../services/notificacionHelper');
      crearNotificacion({
        usuario_id: pedidoInfo.rows[0].usuario_id,
        tipo: 'pago',
        titulo: 'Reembolso devuelto',
        mensaje: `Devolvimos $${parseFloat(reembolso.monto).toFixed(2)} de tu pedido #${pedidoInfo.rows[0].numero} a tu método de pago.`,
      });
    }
  } catch (error) {
    if (client) await client.query('ROLLBACK').catch(() => {});
    console.error('Error PUT /reembolsos/:id:', error.message);
    res.status(500).json({ success: false, message: 'Error al actualizar reembolso' });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;