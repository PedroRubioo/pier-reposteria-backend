// routes/demandaRoutes.js — Fechas especiales, predicción de demanda y
// demanda no atendida.
//
// Todo se calcula con datos reales de la base: las festividades las
// administra Dirección General y la predicción sale del histórico de
// ventas cruzado con esas fechas.
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { verifyToken, verifyRole } = require('../middleware/auth');
const { accesoVigente } = require('../middleware/usuarioVigente');
const { registrarAuditoria } = require('../utils/auditoria');
const { diaHuejutla, sumarDias } = require('../utils/fechasHuejutla');
const {
  fechaISO, variablesCalendario, predecirUnidades,
  basePorProducto, cargarFestivos, estimarDemandaDia, infoModelo, fueraDeRango,
} = require('../utils/prediccionDemanda');

const SOLO_DIRECCION = verifyRole('direccion_general');
const GERENCIA_ARRIBA = verifyRole('gerencia', 'direccion_general');

// 'YYYY-MM-DD' que existe en el calendario (rechaza 2026-02-30), como en reportesRoutes
function esFecha(valor) {
  const m = typeof valor === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(valor) : null;
  return m !== null && new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toISOString().slice(0, 10) === valor;
}

// ══════════════════════════════════════
// FECHAS ESPECIALES (calendario editable)
// ══════════════════════════════════════

// Listado (gerencia+ para poder pintarlas en sus vistas)
router.get('/fechas-especiales', verifyToken, GERENCIA_ARRIBA, async (req, res) => {
  try {
    const { desde, hasta } = req.query;
    const params = [];
    let filtro = '';
    if (desde && hasta) { filtro = 'WHERE fecha BETWEEN $1::date AND $2::date'; params.push(desde, hasta); }
    const { rows } = await pool.query(
      `SELECT id, fecha, nombre, color, dias_anticipacion
       FROM core.tblfechas_especiales ${filtro} ORDER BY fecha`, params);
    res.json({ success: true, fechas: rows.map(r => ({ ...r, fecha: fechaISO(r.fecha) })) });
  } catch (error) {
    console.error('Error GET /fechas-especiales:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener las fechas especiales' });
  }
});

// Marcar uno o varios días como festividad (rangos tipo Xantolo)
router.post('/fechas-especiales', verifyToken, SOLO_DIRECCION, async (req, res) => {
  try {
    const { fechas, nombre, color, dias_anticipacion } = req.body;
    if (!Array.isArray(fechas) || fechas.length === 0) {
      return res.status(400).json({ success: false, message: 'Selecciona al menos un día' });
    }
    if (!nombre || String(nombre).trim().length < 2) {
      return res.status(400).json({ success: false, message: 'Escribe el nombre de la festividad' });
    }
    const limpio = String(nombre).trim().slice(0, 60);
    const anticipacion = Number.isFinite(Number(dias_anticipacion)) ? Math.max(0, Math.min(30, Number(dias_anticipacion))) : 3;

    const { rows } = await pool.query(
      `INSERT INTO core.tblfechas_especiales (fecha, nombre, color, dias_anticipacion)
       SELECT UNNEST($1::date[]), $2, $3, $4
       ON CONFLICT (fecha) DO UPDATE
         SET nombre = EXCLUDED.nombre, color = EXCLUDED.color,
             dias_anticipacion = EXCLUDED.dias_anticipacion, updated_at = NOW()
       RETURNING id, fecha, nombre, color, dias_anticipacion`,
      [fechas, limpio, color || null, anticipacion]
    );

    registrarAuditoria({
      usuario_id: req.user.userId, accion: 'Marcó fechas especiales', entidad: 'fecha_especial',
      detalles: `${limpio} · ${fechas.length} día${fechas.length > 1 ? 's' : ''}`, ip: req.ip,
    });
    res.status(201).json({ success: true, fechas: rows.map(r => ({ ...r, fecha: fechaISO(r.fecha) })), message: `${limpio} guardada` });
  } catch (error) {
    console.error('Error POST /fechas-especiales:', error.message);
    res.status(500).json({ success: false, message: 'Error al guardar la festividad' });
  }
});

// Despintar días
router.delete('/fechas-especiales', verifyToken, SOLO_DIRECCION, async (req, res) => {
  try {
    const { fechas } = req.body;
    if (!Array.isArray(fechas) || fechas.length === 0) {
      return res.status(400).json({ success: false, message: 'Selecciona al menos un día' });
    }
    const { rowCount } = await pool.query(
      `DELETE FROM core.tblfechas_especiales WHERE fecha = ANY($1::date[])`, [fechas]);
    registrarAuditoria({
      usuario_id: req.user.userId, accion: 'Quitó fechas especiales', entidad: 'fecha_especial',
      detalles: `${rowCount} día${rowCount !== 1 ? 's' : ''}`, ip: req.ip,
    });
    res.json({ success: true, eliminadas: rowCount, message: `${rowCount} día${rowCount !== 1 ? 's' : ''} sin marcar` });
  } catch (error) {
    console.error('Error DELETE /fechas-especiales:', error.message);
    res.status(500).json({ success: false, message: 'Error al quitar la festividad' });
  }
});

// ══════════════════════════════════════
// PREDICCIÓN DE DEMANDA POR PRODUCTO
// ══════════════════════════════════════

// Resumen del mes: unidades estimadas por día (para el calendario)
router.get('/demanda/mes', verifyToken, GERENCIA_ARRIBA, async (req, res) => {
  try {
    const anio = parseInt(req.query.anio, 10);
    const mes = parseInt(req.query.mes, 10); // 1-12
    if (!anio || !mes || mes < 1 || mes > 12) {
      return res.status(400).json({ success: false, message: 'Indica año y mes' });
    }

    const [festivos, base, activos] = await Promise.all([
      cargarFestivos(),
      basePorProducto(),
      // Mismo universo que el detalle del día: solo lo que hoy se produce
      pool.query(`SELECT p.id FROM core.tblproductos p
                  JOIN core.tblcategorias c ON c.id = p.categoria_id
                  WHERE p.activo = true AND c.activo = true`),
    ]);
    const idsActivos = new Set(activos.rows.map(r => r.id));
    const diasEnMes = new Date(Date.UTC(anio, mes, 0)).getUTCDate();

    const dias = [];
    for (let d = 1; d <= diasEnMes; d++) {
      const iso = `${anio}-${String(mes).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const vars = variablesCalendario(iso, festivos);
      let total = 0;
      for (const [productoId, info] of base) {
        if (!idsActivos.has(productoId)) continue;
        const promedioDow = info.dow.get(vars.dia_sem) ?? (info.n ? info.suma / info.n : 0);
        const { unidades } = predecirUnidades(
          { promedio_dow: promedioDow, promedio_general: info.n ? info.suma / info.n : 0 },
          vars,
          productoId
        );
        total += unidades;
      }
      dias.push({
        fecha: iso,
        unidades: total,
        festivo: vars.festivo,
        nombre_festivo: vars.nombre_festivo,
        color_festivo: vars.color_festivo,
        prox_festivo: vars.prox_festivo,
        dias_festivo: vars.dias_festivo,
      });
    }

    // Se advierte con el día 15 como representante del mes
    const horizonte = fueraDeRango(`${anio}-${String(mes).padStart(2, '0')}-15`);

    res.json({
      success: true,
      dias,
      productos_evaluados: base.size,
      modelo: infoModelo(),
      horizonte,
    });
  } catch (error) {
    console.error('Error GET /demanda/mes:', error.message);
    res.status(500).json({ success: false, message: 'Error al calcular la demanda del mes' });
  }
});

// Detalle de un día: top de productos con unidades estimadas
router.get('/demanda/dia', verifyToken, GERENCIA_ARRIBA, async (req, res) => {
  try {
    const { fecha } = req.query;
    if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      return res.status(400).json({ success: false, message: 'Indica la fecha (AAAA-MM-DD)' });
    }
    const limite = Math.min(parseInt(req.query.limite, 10) || 12, 50);

    const { vars, productos } = await estimarDemandaDia(fecha);
    const total = productos.reduce((suma, p) => suma + p.unidades, 0);
    productos.sort((a, b) => b.unidades - a.unidades);

    // Mismo cálculo agregado por categoría
    const porCategoria = new Map();
    for (const p of productos) porCategoria.set(p.categoria, (porCategoria.get(p.categoria) || 0) + p.unidades);
    const categorias = [...porCategoria.entries()]
      .map(([nombre, unidades]) => ({ nombre, unidades }))
      .sort((a, b) => b.unidades - a.unidades);

    res.json({
      success: true,
      fecha,
      variables: vars,
      total_unidades: total,
      productos: productos.slice(0, limite),
      categorias,
      modelo: infoModelo(),
      horizonte: fueraDeRango(fecha),
      estimados_con_respaldo: productos.filter(p => p.origen === 'respaldo').length,
      categorias_desconocidas: [...new Set(
        productos.flatMap(p => p.categorias_desconocidas || [])
      )],
    });
  } catch (error) {
    console.error('Error GET /demanda/dia:', error.message);
    res.status(500).json({ success: false, message: 'Error al calcular la demanda del día' });
  }
});

// ══════════════════════════════════════
// PLAN DE PRODUCCIÓN (Diseno_Panel_Personal.md §4.7)
// ══════════════════════════════════════

// El mismo horizonte que la agenda de comandas
const HORIZONTE_PLAN_DIAS = 60;

// $1 = el día. En pedidos abiertos de ese día, solo lo que NO salió de
// existencias (los «por confirmar»): lo demás ya está hecho y apartado
const SQL_APARTADO_PEDIDOS = `
  SELECT i.producto_id, SUM(i.cantidad - i.stock_descontado)::int AS unidades
    FROM core.tblpedido_items i JOIN core.tblpedidos p ON p.id = i.pedido_id
   WHERE p.estado NOT IN ('completado', 'entregado', 'cancelado') AND i.producto_id IS NOT NULL
     AND (COALESCE(p.horario_recogida, p.horario_entrega AT TIME ZONE 'UTC', p.created_at)
          AT TIME ZONE 'America/Mexico_City')::date = $1::date
   GROUP BY i.producto_id HAVING SUM(i.cantidad - i.stock_descontado) > 0`;

// Productos del catálogo en comandas activas de ese día
const SQL_APARTADO_COMANDAS = `
  SELECT ci.producto_id, SUM(ci.cantidad)::int AS unidades
    FROM core.tblcomanda_items ci JOIN core.tblcomandas c ON c.id = ci.comanda_id
   WHERE c.estado = 'activa' AND c.fecha_entrega = $1::date AND ci.tipo = 'producto' AND ci.producto_id IS NOT NULL
   GROUP BY ci.producto_id`;

// Pasteles por encargo con el «Enterado» vigente de cada área
const SQL_PASTELES = `
  SELECT c.id AS comanda_id, c.folio, to_char(c.hora_entrega, 'HH24:MI') AS hora_entrega, c.cliente_nombre,
         ci.cantidad, ci.sabor, ci.tamano, ci.forma, ci.num_pisos, ci.decoracion, ci.leyenda,
         EXISTS (SELECT 1 FROM core.tblcomanda_confirmaciones f
                  WHERE f.comanda_id = c.id AND f.area = 'hornos' AND f.version = c.version) AS enterado_hornos,
         EXISTS (SELECT 1 FROM core.tblcomanda_confirmaciones f
                  WHERE f.comanda_id = c.id AND f.area = 'decoracion' AND f.version = c.version) AS enterado_decoracion
    FROM core.tblcomandas c JOIN core.tblcomanda_items ci ON ci.comanda_id = c.id
   WHERE c.estado = 'activa' AND c.fecha_entrega = $1::date AND ci.tipo = 'pastel'
   ORDER BY c.hora_entrega, c.folio, ci.orden`;

// Qué preparar un día: la venta en línea estimada por el modelo, más lo ya
// apartado para ese día en pedidos y comandas. No se cuenta dos veces: el
// modelo estima por el día en que se HACE el pedido, y lo apartado en
// pedidos son programados que se hicieron antes. La existencia en línea no
// se resta (no dice cuánto queda en vitrina): va solo de referencia.
// ?fecha=YYYY-MM-DD (mañana si no se envía), de hoy a hoy + 60
router.get('/demanda/plan', accesoVigente(['gerencia', 'direccion_general']), async (req, res) => {
  const hoy = diaHuejutla();
  const fecha = req.query.fecha === undefined || req.query.fecha === '' ? sumarDias(hoy, 1) : req.query.fecha;
  if (!esFecha(fecha)) return res.status(400).json({ success: false, message: 'Fecha inválida: usa el formato AAAA-MM-DD' });
  if (fecha < hoy || fecha > sumarDias(hoy, HORIZONTE_PLAN_DIAS)) {
    return res.status(400).json({ success: false, message: 'Elige un día entre hoy y dentro de 60 días' });
  }
  try {
    const [{ vars, productos: estimados }, pedidosR, comandasR, pastelesR] = await Promise.all([
      estimarDemandaDia(fecha),
      pool.query(SQL_APARTADO_PEDIDOS, [fecha]),
      pool.query(SQL_APARTADO_COMANDAS, [fecha]),
      pool.query(SQL_PASTELES, [fecha]),
    ]);

    const estimadoDe = new Map(estimados.map(e => [e.producto_id, e]));
    const enPedidos = new Map(pedidosR.rows.map(r => [r.producto_id, r.unidades]));
    const enComandas = new Map(comandasR.rows.map(r => [r.producto_id, r.unidades]));
    const ids = new Set([
      ...estimados.filter(e => e.unidades > 0).map(e => e.producto_id),
      ...enPedidos.keys(),
      ...enComandas.keys(),
    ]);

    // Lo apartado sin estimado (inactivo o sin historial): nombre y existencia del catálogo
    const sinEstimado = [...ids].filter(id => !estimadoDe.has(id));
    const catalogoR = sinEstimado.length > 0
      ? await pool.query(
        `SELECT p.id, p.nombre, p.stock_online, c.nombre AS categoria
         FROM core.tblproductos p LEFT JOIN core.tblcategorias c ON c.id = p.categoria_id
         WHERE p.id = ANY($1::int[])`, [sinEstimado])
      : { rows: [] };
    const catalogo = new Map(catalogoR.rows.map(r => [r.id, r]));

    const productos = [...ids].map(id => {
      const estimado = estimadoDe.get(id);
      const producto = estimado || catalogo.get(id);
      const unidades = estimado ? estimado.unidades : 0;
      const apartadoPedidos = enPedidos.get(id) || 0;
      const apartadoComandas = enComandas.get(id) || 0;
      return {
        producto_id: id,
        nombre: producto ? producto.nombre : null,
        categoria: producto ? producto.categoria : null,
        estimado: unidades,
        origen: estimado ? estimado.origen : null,
        apartado_pedidos: apartadoPedidos,
        apartado_comandas: apartadoComandas,
        a_preparar: unidades + apartadoPedidos + apartadoComandas,
        existencia: producto ? producto.stock_online : null,
      };
    }).sort((a, b) => b.a_preparar - a.a_preparar || (a.nombre || '').localeCompare(b.nombre || '', 'es'));

    const pasteles = pastelesR.rows.map(r => ({
      comanda_id: r.comanda_id, folio: r.folio, hora_entrega: r.hora_entrega, cliente_nombre: r.cliente_nombre,
      cantidad: r.cantidad, sabor: r.sabor, tamano: r.tamano, forma: r.forma, num_pisos: r.num_pisos,
      decoracion: r.decoracion, leyenda: r.leyenda,
      enterado: { hornos: r.enterado_hornos, decoracion: r.enterado_decoracion },
    }));

    const totales = { estimado: 0, apartado_pedidos: 0, apartado_comandas: 0, a_preparar: 0, pasteles: 0 };
    for (const p of productos) {
      totales.estimado += p.estimado;
      totales.apartado_pedidos += p.apartado_pedidos;
      totales.apartado_comandas += p.apartado_comandas;
      totales.a_preparar += p.a_preparar;
    }
    for (const p of pasteles) totales.pasteles += p.cantidad;

    res.json({
      success: true,
      fecha,
      hoy,
      calendario: {
        festivo: vars.festivo === 1,
        nombre_festivo: vars.nombre_festivo,
        prox_festivo: vars.prox_festivo,
        dias_festivo: vars.dias_festivo,
      },
      modelo: infoModelo(),
      horizonte: fueraDeRango(fecha),
      totales,
      productos,
      pasteles,
    });
  } catch (error) {
    console.error('Error GET /demanda/plan:', error.message);
    res.status(500).json({ success: false, message: 'Error al calcular el plan de producción' });
  }
});

// ══════════════════════════════════════
// DEMANDA NO ATENDIDA
// ══════════════════════════════════════

// Registro de búsquedas del catálogo (público; nunca bloquea la búsqueda)
router.post('/busquedas', async (req, res) => {
  try {
    const { texto, num_resultados, usuario_id } = req.body;
    const limpio = String(texto || '').trim().slice(0, 120);
    if (limpio.length < 2) return res.json({ success: true, registrado: false });
    await pool.query(
      `INSERT INTO core.tblbusquedas (texto, num_resultados, usuario_id) VALUES ($1, $2, $3)`,
      [limpio, Number.isFinite(Number(num_resultados)) ? Number(num_resultados) : 0, usuario_id || null]
    );
    res.json({ success: true, registrado: true });
  } catch (error) {
    console.error('Error POST /busquedas:', error.message);
    res.json({ success: true, registrado: false });
  }
});

// Registro de interés en un producto agotado (público)
router.post('/clics-agotados', async (req, res) => {
  try {
    const { producto_id, usuario_id } = req.body;
    if (!producto_id) return res.json({ success: true, registrado: false });
    await pool.query(
      `INSERT INTO core.tblclicks_agotados (producto_id, usuario_id) VALUES ($1, $2)`,
      [producto_id, usuario_id || null]
    );
    res.json({ success: true, registrado: true });
  } catch (error) {
    console.error('Error POST /clics-agotados:', error.message);
    res.json({ success: true, registrado: false });
  }
});

// Personas distintas que quisieron un producto agotado: cada cuenta cuenta
// una vez; sin sesión no hay cómo distinguirlas, así que los clics anónimos
// cuentan como una persona por día. Va dentro de un GROUP BY por producto.
const PERSONAS_INTERESADAS = `(COUNT(DISTINCT cl.usuario_id)
  + COUNT(DISTINCT (cl.created_at AT TIME ZONE 'America/Mexico_City')::date) FILTER (WHERE cl.usuario_id IS NULL))::int`;

// Reporte: qué buscó la gente y no tuvimos
router.get('/demanda-no-atendida', verifyToken, GERENCIA_ARRIBA, async (req, res) => {
  try {
    const dias = Math.min(parseInt(req.query.dias, 10) || 90, 365);

    const [agotadosR, sinResultadoR, masBuscadoR, resumenR, perdidaR] = await Promise.all([
      pool.query(`
        SELECT p.id, p.nombre, p.precio_chico::float AS precio, p.stock_online,
               c.nombre AS categoria, COUNT(cl.id)::int AS clics,
               ${PERSONAS_INTERESADAS} AS personas,
               MAX(cl.created_at) AS ultimo_clic
        FROM core.tblclicks_agotados cl
        JOIN core.tblproductos p ON p.id = cl.producto_id
        JOIN core.tblcategorias c ON c.id = p.categoria_id
        WHERE cl.created_at > NOW() - ($1 || ' days')::interval
        GROUP BY p.id, p.nombre, p.precio_chico, p.stock_online, c.nombre
        ORDER BY personas DESC, clics DESC LIMIT 15`, [dias]),
      pool.query(`
        SELECT LOWER(texto) AS texto, COUNT(*)::int AS veces, MAX(created_at) AS ultima
        FROM core.tblbusquedas
        WHERE num_resultados = 0 AND created_at > NOW() - ($1 || ' days')::interval
        GROUP BY 1 ORDER BY veces DESC LIMIT 15`, [dias]),
      pool.query(`
        SELECT LOWER(texto) AS texto, COUNT(*)::int AS veces
        FROM core.tblbusquedas
        WHERE num_resultados > 0 AND created_at > NOW() - ($1 || ' days')::interval
        GROUP BY 1 ORDER BY veces DESC LIMIT 10`, [dias]),
      pool.query(`
        SELECT
          (SELECT COUNT(*)::int FROM core.tblbusquedas WHERE created_at > NOW() - ($1 || ' days')::interval) AS busquedas,
          (SELECT COUNT(*)::int FROM core.tblbusquedas WHERE num_resultados = 0 AND created_at > NOW() - ($1 || ' days')::interval) AS busquedas_sin_resultado,
          (SELECT COUNT(*)::int FROM core.tblclicks_agotados WHERE created_at > NOW() - ($1 || ' days')::interval) AS clics_agotados,
          (SELECT COUNT(*)::int FROM core.tblproductos WHERE activo = true AND stock_online = 0) AS agotados_ahora`, [dias]),
      // Venta potencial perdida: personas distintas × precio, sobre TODOS los
      // productos con interés (no solo los 15 de la lista)
      pool.query(`
        SELECT COALESCE(SUM(i.personas * i.precio), 0) AS venta_perdida
        FROM (
          SELECT p.precio_chico AS precio, ${PERSONAS_INTERESADAS} AS personas
          FROM core.tblclicks_agotados cl
          JOIN core.tblproductos p ON p.id = cl.producto_id
          WHERE cl.created_at > NOW() - ($1 || ' days')::interval
          GROUP BY p.id, p.precio_chico
        ) i`, [dias]),
    ]);

    const ventaPerdida = Math.round(Number(perdidaR.rows[0].venta_perdida) * 100) / 100;

    res.json({
      success: true,
      dias,
      resumen: { ...resumenR.rows[0], venta_perdida_estimada: ventaPerdida },
      agotados: agotadosR.rows,
      sin_resultado: sinResultadoR.rows,
      mas_buscado: masBuscadoR.rows,
    });
  } catch (error) {
    console.error('Error GET /demanda-no-atendida:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener la demanda no atendida' });
  }
});

module.exports = router;
