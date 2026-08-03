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
const { registrarAuditoria } = require('../utils/auditoria');
const {
  fechaISO, variablesCalendario, predecirUnidades,
  basePorProducto, historicoAnioAnterior, cargarFestivos, infoModelo, fueraDeRango,
} = require('../utils/prediccionDemanda');

const SOLO_DIRECCION = verifyRole('direccion_general');
const GERENCIA_ARRIBA = verifyRole('gerencia', 'direccion_general');

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
      detalles: `${limpio} · ${fechas.length} día${fechas.length > 1 ? 's' : ''}`,
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
      detalles: `${rowCount} día${rowCount !== 1 ? 's' : ''}`,
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

    const [festivos, base, historico, catalogo] = await Promise.all([
      cargarFestivos(),
      basePorProducto(),
      historicoAnioAnterior(fecha),
      pool.query(`SELECT p.id, p.nombre, p.stock_online, c.nombre AS categoria
                  FROM core.tblproductos p JOIN core.tblcategorias c ON c.id = p.categoria_id
                  WHERE p.activo = true AND c.activo = true`),
    ]);

    const vars = variablesCalendario(fecha, festivos);
    const info = new Map(catalogo.rows.map(r => [r.id, r]));

    const productos = [];
    let total = 0;
    for (const [productoId, datos] of base) {
      const prod = info.get(productoId);
      if (!prod) continue; // producto inactivo: no se produce
      const promedioDow = datos.dow.get(vars.dia_sem) ?? (datos.n ? datos.suma / datos.n : 0);
      const { unidades, origen, categorias_desconocidas } = predecirUnidades({
        promedio_dow: promedioDow,
        promedio_general: datos.n ? datos.suma / datos.n : 0,
        hist_anio_ant: historico.get(productoId) ?? null,
      }, vars, productoId);
      total += unidades;
      productos.push({
        producto_id: productoId,
        nombre: prod.nombre,
        categoria: prod.categoria,
        stock_online: prod.stock_online,
        unidades,
        origen,
        categorias_desconocidas,
        con_historico_anual: historico.has(productoId),
      });
    }
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

// Reporte: qué buscó la gente y no tuvimos
router.get('/demanda-no-atendida', verifyToken, GERENCIA_ARRIBA, async (req, res) => {
  try {
    const dias = Math.min(parseInt(req.query.dias, 10) || 90, 365);

    const [agotadosR, sinResultadoR, masBuscadoR, resumenR] = await Promise.all([
      pool.query(`
        SELECT p.id, p.nombre, p.precio_chico::float AS precio, p.stock_online,
               c.nombre AS categoria, COUNT(cl.id)::int AS clics,
               MAX(cl.created_at) AS ultimo_clic
        FROM core.tblclicks_agotados cl
        JOIN core.tblproductos p ON p.id = cl.producto_id
        JOIN core.tblcategorias c ON c.id = p.categoria_id
        WHERE cl.created_at > NOW() - ($1 || ' days')::interval
        GROUP BY p.id, p.nombre, p.precio_chico, p.stock_online, c.nombre
        ORDER BY clics DESC LIMIT 15`, [dias]),
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
    ]);

    // Venta potencial perdida: clics en agotados × precio del producto
    const ventaPerdida = agotadosR.rows.reduce((suma, r) => suma + r.clics * r.precio, 0);

    res.json({
      success: true,
      dias,
      resumen: { ...resumenR.rows[0], venta_perdida_estimada: Math.round(ventaPerdida) },
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
