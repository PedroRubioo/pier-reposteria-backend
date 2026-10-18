// routes/turnoRoutes.js — Bandeja del turno y corte del día
// (Diseno_Panel_Personal.md §4.1 y §4.2)
//
// Los usan los paneles de empleado, gerencia y dirección. El rol se lee de
// la base en cada petición (accesoVigente), los días son de Huejutla y los
// montos salen como número con 2 decimales.
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { accesoVigente } = require('../middleware/usuarioVigente');
const { normalizarAjustes } = require('../utils/comandas');
const { dinero } = require('../utils/ventasReportes');
const { diaHuejutla, horaHuejutla } = require('../utils/fechasHuejutla');

const PERSONAL = accesoVigente(['empleado', 'gerencia', 'direccion_general']);

// 'YYYY-MM-DD' que existe en el calendario (rechaza 2026-02-30), como en reportesRoutes
function esFecha(valor) {
  const m = typeof valor === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(valor) : null;
  return m !== null && new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toISOString().slice(0, 10) === valor;
}

// ══════════════════════════════════════
// RESUMEN DEL TURNO (§4.1)
// ══════════════════════════════════════

// $1 = hoy en Huejutla, $2 = días del semáforo rojo de comandas.
// Quejas abiertas y mensajes se cuentan igual que en el Resumen de
// dirección; agotados y por agotarse, solo en categorías activas (los que
// puede mostrar la lista de Existencias).
const SQL_RESUMEN = `
  WITH lim AS (
    SELECT ($1::date)::timestamp AT TIME ZONE 'America/Mexico_City' AS ini,
           ($1::date + 1)::timestamp AT TIME ZONE 'America/Mexico_City' AS fin),
  abiertos AS (
    SELECT p.estado::text AS estado, p.tipo_entrega, p.por_confirmar, p.updated_at,
           COALESCE(p.horario_recogida, p.horario_entrega AT TIME ZONE 'UTC', p.created_at) AS compromiso,
           e.updated_at AS entrega_movida
      FROM core.tblpedidos p
      LEFT JOIN core.tblentregas e ON e.pedido_id = p.id AND e.estado IN ('asignada', 'en_camino')
     WHERE p.estado NOT IN ('completado', 'entregado', 'cancelado')),
  ped AS (
    SELECT COUNT(*) FILTER (WHERE a.por_confirmar)::int AS por_confirmar,
           COUNT(*) FILTER (WHERE a.tipo_entrega = 'pickup' AND NOT a.por_confirmar
                              AND a.estado IN ('pendiente', 'en_preparacion', 'listo')
                              AND a.compromiso >= l.ini AND a.compromiso < l.fin)::int AS recoger_hoy,
           COUNT(*) FILTER (WHERE a.tipo_entrega = 'pickup' AND NOT a.por_confirmar
                              AND a.estado IN ('pendiente', 'en_preparacion', 'listo')
                              AND a.compromiso < l.ini)::int AS recoger_atrasados,
           COUNT(*) FILTER (WHERE a.tipo_entrega = 'domicilio' AND a.estado = 'listo' AND a.entrega_movida IS NULL
                              AND a.updated_at < NOW() - INTERVAL '10 minutes')::int AS sin_repartidor,
           COUNT(*) FILTER (WHERE a.estado IN ('asignado', 'en_camino'))::int AS en_reparto,
           COUNT(*) FILTER (WHERE a.estado IN ('asignado', 'en_camino')
                              AND a.entrega_movida < (NOW() AT TIME ZONE 'UTC') - INTERVAL '2 hours')::int AS reparto_sin_cerrar,
           COUNT(*) FILTER (WHERE a.estado = 'entrega_fallida')::int AS fallidas
      FROM abiertos a CROSS JOIN lim l),
  com AS (
    SELECT COUNT(*) FILTER (WHERE x.dias = 0)::int AS hoy,
           COUNT(*) FILTER (WHERE x.dias = 1)::int AS manana,
           COUNT(*) FILTER (WHERE x.dias < 0)::int AS vencidas,
           COUNT(*) FILTER (WHERE x.dias <= $2::int AND NOT (x.hornos AND x.decoracion))::int AS sin_enterado,
           COALESCE(SUM(x.saldo) FILTER (WHERE x.dias = 0), 0) AS saldo_hoy
      FROM (SELECT c.fecha_entrega - $1::date AS dias, c.total - c.anticipo AS saldo,
                   EXISTS (SELECT 1 FROM core.tblcomanda_confirmaciones f
                            WHERE f.comanda_id = c.id AND f.area = 'hornos' AND f.version = c.version) AS hornos,
                   EXISTS (SELECT 1 FROM core.tblcomanda_confirmaciones f
                            WHERE f.comanda_id = c.id AND f.area = 'decoracion' AND f.version = c.version) AS decoracion
              FROM core.tblcomandas c WHERE c.estado = 'activa') x)
  SELECT ped.*, com.*,
    (SELECT COUNT(*)::int FROM core.tblcontacto_mensajes WHERE leido = FALSE) AS mensajes,
    (SELECT COUNT(*)::int FROM core.tblreembolsos WHERE estado = 'pendiente') AS reembolsos_pendientes,
    (SELECT COUNT(*)::int FROM core.tblreembolsos WHERE estado = 'en_revision') AS reembolsos_en_revision,
    (SELECT COUNT(*)::int FROM core.tblquejas WHERE estado = 'pendiente') AS quejas_pendientes,
    (SELECT COUNT(*)::int FROM core.tblquejas WHERE estado IN ('pendiente', 'en_proceso')) AS quejas_abiertas,
    (SELECT COUNT(*)::int FROM core.tblresenas WHERE estado = 'pendiente') AS resenas_pendientes,
    (SELECT COUNT(*)::int FROM core.tblproductos pr JOIN core.tblcategorias ca ON ca.id = pr.categoria_id
      WHERE pr.activo = TRUE AND ca.activo = TRUE AND pr.stock_online = 0) AS agotados,
    (SELECT COUNT(*)::int FROM core.tblproductos pr JOIN core.tblcategorias ca ON ca.id = pr.categoria_id
      WHERE pr.activo = TRUE AND ca.activo = TRUE AND pr.stock_online BETWEEN 1 AND 5) AS por_agotarse
  FROM ped CROSS JOIN com`;

// Lo que «Hoy» pone por resolver, en este orden fijo; solo salen los que tienen algo
const PENDIENTES = [
  ['pedidos_por_confirmar', 'Pedidos por confirmar', 'alta', (t) => t.pedidos.por_confirmar],
  ['entregas_fallidas', 'Entregas fallidas', 'alta', (t) => t.pedidos.fallidas],
  ['domicilio_sin_repartidor', 'A domicilio sin repartidor (más de 10 min)', 'alta', (t) => t.pedidos.sin_repartidor],
  ['comandas_sin_enterado', 'Comandas próximas sin «Enterado» de producción', 'alta', (t) => t.comandas.sin_enterado],
  ['comandas_vencidas', 'Comandas vencidas sin entregar', 'alta', (t) => t.comandas.vencidas],
  ['reparto_sin_cerrar', 'Entregas sin cerrar desde hace más de 2 horas', 'media', (t) => t.pedidos.reparto_sin_cerrar],
  ['recoger_atrasados', 'Recogidas de días anteriores sin entregar', 'media', (t) => t.pedidos.recoger_atrasados],
  ['reembolsos_en_revision', 'Reembolsos en revisión (los decide gerencia)', 'media', (t) => t.atencion.reembolsos_en_revision],
  ['reembolsos_pendientes', 'Reembolsos por revisar', 'media', (t) => t.atencion.reembolsos_pendientes],
  ['quejas_abiertas', 'Quejas abiertas', 'media', (t) => t.atencion.quejas_abiertas],
  ['mensajes', 'Mensajes de contacto sin leer', 'media', (t) => t.atencion.mensajes],
  ['resenas_pendientes', 'Reseñas por revisar', 'baja', (t) => t.atencion.resenas_pendientes],
  ['productos_agotados', 'Productos agotados', 'baja', (t) => t.productos.agotados],
  ['productos_por_agotarse', 'Productos por agotarse (5 o menos)', 'baja', (t) => t.productos.por_agotarse],
];

/** Días del semáforo rojo, de los ajustes de comandas (como leerContexto en comandasRoutes) */
async function diasSemaforoRojo() {
  const { rows } = await pool.query(
    `SELECT jsonb_object_agg(clave, valor) AS ajustes FROM core.tblconfiguracion_sistema WHERE seccion = 'comandas'`
  );
  return normalizarAjustes(rows[0].ajustes).semaforo_rojo_dias;
}

router.get('/resumen', PERSONAL, async (req, res) => {
  try {
    const hoy = diaHuejutla();
    const { rows } = await pool.query(SQL_RESUMEN, [hoy, await diasSemaforoRojo()]);
    const r = rows[0];
    const turno = {
      pedidos: {
        por_confirmar: r.por_confirmar, recoger_hoy: r.recoger_hoy, recoger_atrasados: r.recoger_atrasados,
        sin_repartidor: r.sin_repartidor, en_reparto: r.en_reparto, reparto_sin_cerrar: r.reparto_sin_cerrar, fallidas: r.fallidas,
      },
      comandas: { hoy: r.hoy, manana: r.manana, vencidas: r.vencidas, sin_enterado: r.sin_enterado, saldo_hoy: dinero(r.saldo_hoy) },
      atencion: {
        mensajes: r.mensajes, reembolsos_pendientes: r.reembolsos_pendientes, reembolsos_en_revision: r.reembolsos_en_revision,
        quejas_pendientes: r.quejas_pendientes, quejas_abiertas: r.quejas_abiertas, resenas_pendientes: r.resenas_pendientes,
      },
      productos: { agotados: r.agotados, por_agotarse: r.por_agotarse },
    };
    const pendientes = PENDIENTES
      .map(([clave, etiqueta, urgencia, fuente]) => ({ clave, etiqueta, cantidad: fuente(turno), urgencia }))
      .filter((p) => p.cantidad > 0);
    res.json({ success: true, hoy, ...turno, pendientes });
  } catch (error) {
    console.error('Error GET /turno/resumen:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener el resumen del turno' });
  }
});

// ══════════════════════════════════════
// CORTE DEL DÍA (§4.2)
// ══════════════════════════════════════

// $1 = el día. Lo cobrado en comandas (anticipo inicial, cada ajuste del
// anticipo y el saldo al entregar), las canceladas con anticipo y los
// pedidos para recoger que alguien pasó a «completado» ese día. Los ajustes
// salen del historial de la comanda («$1,234.50» antes y después); el
// anticipo inicial es el actual menos todos sus ajustes. Depende del
// formato '#NUM · anterior → nuevo' de la bitácora de pedidos.
const SQL_MOVIMIENTOS = `
  WITH lim AS (SELECT ($1::date)::timestamp AT TIME ZONE 'America/Mexico_City' AS ini,
                      ($1::date + 1)::timestamp AT TIME ZONE 'America/Mexico_City' AS fin),
  ajustes AS (
    SELECT h.comanda_id, h.usuario_id, h.created_at,
           REPLACE(REPLACE(cb->>'despues', '$', ''), ',', '')::numeric
         - REPLACE(REPLACE(cb->>'antes',   '$', ''), ',', '')::numeric AS delta
      FROM core.tblcomanda_historial h
     CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(h.cambios) = 'array' THEN h.cambios ELSE '[]'::jsonb END) cb
     WHERE h.evento = 'modificada' AND cb->>'campo' = 'Anticipo'),
  movs AS (
    SELECT 'anticipo' AS tipo, c.created_at AS momento, c.id AS comanda_id, NULL::int AS pedido_id,
           '#' || c.folio AS referencia, c.cliente_nombre AS cliente, c.tomado_por AS usuario_id,
           c.anticipo - COALESCE((SELECT SUM(a.delta) FROM ajustes a WHERE a.comanda_id = c.id), 0) AS monto,
           NULL::text AS nota
      FROM core.tblcomandas c, lim WHERE c.created_at >= lim.ini AND c.created_at < lim.fin
    UNION ALL
    SELECT 'ajuste_anticipo', a.created_at, c.id, NULL, '#' || c.folio, c.cliente_nombre, a.usuario_id, a.delta, NULL
      FROM ajustes a JOIN core.tblcomandas c ON c.id = a.comanda_id, lim
     WHERE a.created_at >= lim.ini AND a.created_at < lim.fin AND a.delta <> 0
    UNION ALL
    SELECT 'saldo', c.entregada_at, c.id, NULL, '#' || c.folio, c.cliente_nombre, c.entregada_por, COALESCE(c.saldo_cobrado, 0), NULL
      FROM core.tblcomandas c, lim
     WHERE c.estado = 'entregada' AND c.entregada_at >= lim.ini AND c.entregada_at < lim.fin
    UNION ALL
    SELECT 'cancelada', c.cancelada_at, c.id, NULL, '#' || c.folio, c.cliente_nombre, c.cancelada_por, c.anticipo, c.motivo_cancelacion
      FROM core.tblcomandas c, lim
     WHERE c.estado = 'cancelada' AND c.cancelada_at >= lim.ini AND c.cancelada_at < lim.fin AND c.anticipo > 0
    UNION ALL
    SELECT * FROM (
      SELECT DISTINCT ON (a.entidad_id) 'pedido', a.created_at, NULL::int, p.id, '#' || p.numero,
             TRIM(u.nombre || ' ' || u.apellido), a.usuario_id, p.total, 'Pagado en línea'
        FROM core.tblauditoria a
        JOIN core.tblpedidos p ON p.id = a.entidad_id
        JOIN core.tblusuarios u ON u.id = p.usuario_id, lim
       WHERE a.accion = 'Cambió estado de pedido' AND a.entidad = 'pedido'
         AND (a.detalles #>> '{}') LIKE '%→ completado' AND p.estado = 'completado'
         AND a.created_at >= lim.ini AND a.created_at < lim.fin
       ORDER BY a.entidad_id, a.id DESC) entregados)
  SELECT m.*, TRIM(u.nombre || ' ' || u.apellido) AS usuario_nombre
    FROM movs m LEFT JOIN core.tblusuarios u ON u.id = m.usuario_id
   ORDER BY m.momento, m.referencia`;

// Reembolsos aprobados ese día (solo informativo; marcarlos como devueltos
// después no los cambia de día)
const SQL_REEMBOLSOS = `
  WITH lim AS (SELECT ($1::date)::timestamp AT TIME ZONE 'America/Mexico_City' AS ini,
                      ($1::date + 1)::timestamp AT TIME ZONE 'America/Mexico_City' AS fin)
  SELECT COUNT(*)::int AS n, COALESCE(SUM(r.monto), 0) AS monto
    FROM core.tblreembolsos r, lim
   WHERE r.estado IN ('aprobado', 'procesado') AND r.fecha_resolucion >= lim.ini AND r.fecha_resolucion < lim.fin`;

/** Suma los movimientos del día: totales, por persona y la lista para la tabla */
function armarCorte(filas) {
  const t = {
    anticipos: 0, num_anticipos: 0, ajustes_anticipo: 0, num_ajustes: 0, saldos: 0, num_saldos: 0, comandas_entregadas: 0,
    anticipos_cancelados: 0, num_cancelados: 0, pedidos_entregados: 0, pedidos_entregados_monto: 0,
  };
  const personas = new Map();
  const movimientos = [];
  for (const m of filas) {
    const monto = Number(m.monto);
    if (m.tipo === 'saldo') t.comandas_entregadas += 1;
    // Un anticipo o un saldo en cero no es un cobro
    if ((m.tipo === 'anticipo' || m.tipo === 'saldo') && monto === 0) continue;

    let persona = personas.get(m.usuario_id);
    if (!persona) {
      persona = { usuario_id: m.usuario_id, nombre: m.usuario_nombre, anticipos: 0, ajustes_anticipo: 0, saldos: 0, pedidos_entregados: 0 };
      personas.set(m.usuario_id, persona);
    }
    if (m.tipo === 'anticipo') {
      t.anticipos += monto; t.num_anticipos += 1; persona.anticipos += monto;
    } else if (m.tipo === 'ajuste_anticipo') {
      t.ajustes_anticipo += monto; t.num_ajustes += 1; persona.ajustes_anticipo += monto;
    } else if (m.tipo === 'saldo') {
      t.saldos += monto; t.num_saldos += 1; persona.saldos += monto;
    } else if (m.tipo === 'cancelada') {
      t.anticipos_cancelados += monto; t.num_cancelados += 1;
    } else {
      t.pedidos_entregados += 1; t.pedidos_entregados_monto += monto; persona.pedidos_entregados += 1;
    }
    movimientos.push({
      tipo: m.tipo, momento: m.momento, hora: horaHuejutla(m.momento), referencia: m.referencia,
      comanda_id: m.comanda_id, pedido_id: m.pedido_id, cliente: m.cliente, monto: dinero(monto),
      usuario_id: m.usuario_id, usuario_nombre: m.usuario_nombre, nota: m.nota,
    });
  }

  const porPersona = [...personas.values()]
    .map((p) => ({
      usuario_id: p.usuario_id, nombre: p.nombre, anticipos: dinero(p.anticipos), ajustes_anticipo: dinero(p.ajustes_anticipo),
      saldos: dinero(p.saldos), cobrado: dinero(p.anticipos + p.ajustes_anticipo + p.saldos), pedidos_entregados: p.pedidos_entregados,
    }))
    .sort((a, b) => b.cobrado - a.cobrado || (a.nombre || '').localeCompare(b.nombre || '', 'es'));

  return {
    totales: {
      cobrado: dinero(t.anticipos + t.ajustes_anticipo + t.saldos),
      anticipos: dinero(t.anticipos), num_anticipos: t.num_anticipos,
      ajustes_anticipo: dinero(t.ajustes_anticipo), num_ajustes: t.num_ajustes,
      saldos: dinero(t.saldos), num_saldos: t.num_saldos, comandas_entregadas: t.comandas_entregadas,
      anticipos_cancelados: dinero(t.anticipos_cancelados), num_cancelados: t.num_cancelados,
      pedidos_entregados: t.pedidos_entregados, pedidos_entregados_monto: dinero(t.pedidos_entregados_monto),
    },
    por_persona: porPersona,
    movimientos,
  };
}

// ?fecha=YYYY-MM-DD (hoy si no se envía; nunca un día futuro)
router.get('/corte', PERSONAL, async (req, res) => {
  const hoy = diaHuejutla();
  const fecha = req.query.fecha === undefined || req.query.fecha === '' ? hoy : req.query.fecha;
  if (!esFecha(fecha)) return res.status(400).json({ success: false, message: 'Fecha inválida: usa el formato AAAA-MM-DD' });
  if (fecha > hoy) return res.status(400).json({ success: false, message: 'Ese día todavía no llega' });
  try {
    const [movimientosR, reembolsosR] = await Promise.all([
      pool.query(SQL_MOVIMIENTOS, [fecha]),
      pool.query(SQL_REEMBOLSOS, [fecha]),
    ]);
    const corte = armarCorte(movimientosR.rows);
    const reembolsos = reembolsosR.rows[0];
    res.json({
      success: true,
      fecha,
      es_hoy: fecha === hoy,
      totales: { ...corte.totales, reembolsos_resueltos: reembolsos.n, reembolsos_monto: dinero(reembolsos.monto) },
      por_persona: corte.por_persona,
      movimientos: corte.movimientos,
    });
  } catch (error) {
    console.error('Error GET /turno/corte:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener el corte del día' });
  }
});

module.exports = router;
