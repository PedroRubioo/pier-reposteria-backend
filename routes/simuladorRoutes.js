// routes/simuladorRoutes.js — Simulador de producción con datos reales
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { verifyToken, verifyRole } = require('../middleware/auth');

// Productos ordenados por más vendidos (total histórico)
router.get('/productos-ranking', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.id, p.nombre, p.precio_chico, p.precio_grande, p.imagen_url,
        c.id AS categoria_id, c.nombre AS categoria,
        COALESCE(SUM(pi.cantidad), 0)::INTEGER AS total_vendido,
        COALESCE(SUM(pi.subtotal), 0)::NUMERIC(10,2) AS ingresos_totales
      FROM core.tblproductos p
      JOIN core.tblcategorias c ON p.categoria_id = c.id
      LEFT JOIN core.tblpedido_items pi ON pi.producto_id = p.id
      LEFT JOIN core.tblpedidos pd ON pi.pedido_id = pd.id AND pd.estado NOT IN ('cancelado')
      WHERE p.activo = true
      GROUP BY p.id, p.nombre, p.precio_chico, p.precio_grande, p.imagen_url, c.id, c.nombre
      ORDER BY total_vendido DESC
    `);
    res.json({ success: true, productos: result.rows });
  } catch (error) {
    console.error('Error GET /simulador/productos-ranking:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener ranking' });
  }
});

// Ventas mensuales de un producto
// Parametros opcionales: meses=N (default 6) o desde/hasta (YYYY-MM-DD) para rango custom
router.get('/ventas-mensuales/:productoId', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const { productoId } = req.params;
    const { desde, hasta } = req.query;
    const meses = parseInt(req.query.meses) || 6;

    // Determinar rango de meses a consultar
    // Si hay desde/hasta, usar esos; si no, ultimos N meses desde hoy
    const ahora = new Date();
    let mesInicioFecha, mesFinFecha;
    if (desde && hasta) {
      const d = new Date(desde);
      const h = new Date(hasta);
      mesInicioFecha = new Date(d.getFullYear(), d.getMonth(), 1);
      mesFinFecha = new Date(h.getFullYear(), h.getMonth(), 1);
    } else {
      mesInicioFecha = new Date(ahora.getFullYear(), ahora.getMonth() - (meses - 1), 1);
      mesFinFecha = new Date(ahora.getFullYear(), ahora.getMonth(), 1);
    }

    // Generar lista de meses en el rango
    const mesesList = [];
    const cursor = new Date(mesInicioFecha);
    while (cursor <= mesFinFecha) {
      const mesKey = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
      const mesLabel = cursor.toLocaleDateString('es-MX', { month: 'short', year: 'numeric' });
      mesesList.push({ mes: mesKey, mes_label: mesLabel });
      cursor.setMonth(cursor.getMonth() + 1);
    }

    // Query de ventas en ese rango
    const sqlInicio = `${mesInicioFecha.getFullYear()}-${String(mesInicioFecha.getMonth() + 1).padStart(2, '0')}-01`;
    const sqlFinExclusivo = new Date(mesFinFecha.getFullYear(), mesFinFecha.getMonth() + 1, 1);
    const sqlFin = `${sqlFinExclusivo.getFullYear()}-${String(sqlFinExclusivo.getMonth() + 1).padStart(2, '0')}-01`;

    const result = await pool.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', pd.created_at), 'YYYY-MM') AS mes,
        COALESCE(pi.tamano, 'chico') AS tamano,
        COALESCE(SUM(pi.cantidad), 0)::INTEGER AS unidades,
        COALESCE(SUM(pi.subtotal), 0)::NUMERIC(10,2) AS ingresos
      FROM core.tblpedido_items pi
      JOIN core.tblpedidos pd ON pi.pedido_id = pd.id
      WHERE pi.producto_id = $1
        AND pd.estado NOT IN ('cancelado')
        AND pd.created_at >= $2::date
        AND pd.created_at < $3::date
      GROUP BY DATE_TRUNC('month', pd.created_at), pi.tamano
      ORDER BY mes ASC
    `, [productoId, sqlInicio, sqlFin]);

    // Obtener info del producto
    const productoInfo = await pool.query('SELECT precio_chico, precio_grande FROM core.tblproductos WHERE id = $1', [productoId]);
    const precioChico = productoInfo.rows[0] ? parseFloat(productoInfo.rows[0].precio_chico) : 0;
    const precioGrande = productoInfo.rows[0]?.precio_grande ? parseFloat(productoInfo.rows[0].precio_grande) : null;
    const tieneDosPrecios = precioGrande !== null;

    // Rellenar meses con datos (o ceros)
    const ventasChico = [];
    const ventasGrande = [];
    const ventasTotal = [];

    for (const { mes: mesKey, mes_label: mesLabel } of mesesList) {
      const chicoData = result.rows.find(r => r.mes === mesKey && r.tamano === 'chico');
      const grandeData = result.rows.find(r => r.mes === mesKey && r.tamano === 'grande');

      const chico = { mes: mesKey, mes_label: mesLabel, unidades: chicoData ? parseInt(chicoData.unidades) : 0, ingresos: chicoData ? parseFloat(chicoData.ingresos) : 0 };
      const grande = { mes: mesKey, mes_label: mesLabel, unidades: grandeData ? parseInt(grandeData.unidades) : 0, ingresos: grandeData ? parseFloat(grandeData.ingresos) : 0 };

      ventasChico.push(chico);
      ventasGrande.push(grande);
      ventasTotal.push({ mes: mesKey, mes_label: mesLabel, unidades: chico.unidades + grande.unidades, ingresos: chico.ingresos + grande.ingresos });
    }

    // ── Modelo: Ley de Crecimiento/Decrecimiento Exponencial ──
    // dT/dt = KT  →  T(t) = T₀ · e^(Kt)
    // K = ln(T_f / T₀) / n

    // Calcular moda de un array
    const calcModa = (arr) => {
      const freq = {};
      arr.forEach(v => { freq[v] = (freq[v] || 0) + 1; });
      let maxFreq = 0, moda = arr[0] || 0;
      Object.entries(freq).forEach(([val, count]) => { if (count > maxFreq) { maxFreq = count; moda = Number(val); } });
      return moda;
    };

    // Predicción exponencial por tamaño — misma fórmula (K = ln(Tf/T0)/n)
    // Extendida para devolver 3 meses en vez de 1
    const calcPred = (ventas, precio) => {
      const unidades = ventas.map(v => v.unidades);
      const n = unidades.length;

      // Promedio aritmético: x̄ = Σ Tᵢ / n
      const promedio = unidades.reduce((a, b) => a + b, 0) / (n || 1);

      // Moda
      const moda = calcModa(unidades);

      // T₀ = primer mes con ventas > 0, T_f = último mes
      const T0 = unidades.find(u => u > 0) || 1;
      const Tf = unidades[n - 1] || 1;
      const periodos = n - 1 || 1;

      // K = ln(T_f / T₀) / n  (constante de crecimiento/decrecimiento)
      const K = (T0 > 0 && Tf > 0) ? Math.log(Tf / T0) / periodos : 0;

      // T(t) = T_f · e^(K·t) → t=1,2,3 para los 3 meses siguientes
      // Es equivalente a T₀ · e^(K·(n+t)) que es la fórmula del Excel
      const predMeses = [1, 2, 3].map(t => {
        const u = Math.max(0, Math.round(Tf * Math.exp(K * t)));
        return { offset: t, unidades: u, ingresos_estimados: Math.round(u * precio) };
      });

      return {
        predicciones: predMeses, // array de 3 meses
        unidades: predMeses[0].unidades, // compatibilidad: mes 1
        ingresos_estimados: predMeses[0].ingresos_estimados,
        K: Math.round(K * 10000) / 10000,
        promedio: Math.round(promedio * 100) / 100,
        moda: moda,
        T0: T0,
        Tf: Tf,
      };
    };

    // Calcular labels para los 3 meses de predicción (siguientes al último histórico)
    const ultimoMes = ventasTotal[ventasTotal.length - 1];
    const calcLabelsFuturo = () => {
      if (!ultimoMes) return [];
      const [yyyy, mm] = ultimoMes.mes.split('-').map(Number);
      return [1, 2, 3].map(t => {
        const fecha = new Date(yyyy, mm - 1 + t, 1);
        const key = `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, '0')}`;
        const label = fecha.toLocaleDateString('es-MX', { month: 'short', year: 'numeric' });
        return { mes: key, mes_label: label };
      });
    };
    const labelsFuturo = calcLabelsFuturo();

    const predChico = calcPred(ventasChico, precioChico);
    const predGrande = tieneDosPrecios ? calcPred(ventasGrande, precioGrande) : null;
    const predTotal = calcPred(ventasTotal, precioChico);

    // Tendencia basada en K total
    const Ktotal = predTotal.K;

    res.json({
      success: true,
      tiene_dos_precios: tieneDosPrecios,
      ventas_chico: ventasChico,
      ventas_grande: tieneDosPrecios ? ventasGrande : null,
      ventas_total: ventasTotal,
      prediccion: {
        total: { unidades: predTotal.unidades, ingresos_estimados: predChico.ingresos_estimados + (predGrande?.ingresos_estimados || 0) },
        chico: predChico,
        grande: predGrande,
        // Meses combinados (chico+grande) para los 3 meses futuros
        meses_futuro: predTotal.predicciones.map((p, i) => ({
          ...labelsFuturo[i],
          offset: p.offset,
          unidades: p.unidades,
          unidades_chico: predChico.predicciones[i]?.unidades || 0,
          unidades_grande: predGrande?.predicciones[i]?.unidades || 0,
          ingresos_estimados: (predChico.predicciones[i]?.ingresos_estimados || 0) + (predGrande?.predicciones[i]?.ingresos_estimados || 0),
        })),
        tendencia: Ktotal > 0.01 ? 'subiendo' : Ktotal < -0.01 ? 'bajando' : 'estable',
        tendencia_valor: Ktotal,
        K_total: Ktotal,
      },
      resumen: {
        total_unidades: ventasTotal.reduce((a, v) => a + v.unidades, 0),
        total_ingresos: ventasTotal.reduce((a, v) => a + v.ingresos, 0),
        promedio_mensual: predTotal.promedio,
        moda_mensual: predTotal.moda,
        chico: { unidades: ventasChico.reduce((a, v) => a + v.unidades, 0), ingresos: ventasChico.reduce((a, v) => a + v.ingresos, 0) },
        grande: tieneDosPrecios ? { unidades: ventasGrande.reduce((a, v) => a + v.unidades, 0), ingresos: ventasGrande.reduce((a, v) => a + v.ingresos, 0) } : null,
      }
    });
  } catch (error) {
    console.error('Error GET /simulador/ventas-mensuales:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener ventas' });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ANÁLISIS DE VENTAS (independiente del modelo predictivo)
// GET /api/simulador/analisis-ventas?desde=YYYY-MM-DD&hasta=YYYY-MM-DD&categoria_id=X
// ═══════════════════════════════════════════════════════════════════
router.get('/analisis-ventas', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const { desde, hasta, categoria_id, producto_id } = req.query;

    if (!desde || !hasta) {
      return res.status(400).json({ success: false, message: 'Parametros desde y hasta son requeridos' });
    }

    // Rango anterior (misma duración) para comparativo
    const dias = Math.ceil((new Date(hasta) - new Date(desde)) / (1000 * 60 * 60 * 24)) + 1;
    const desdeAnterior = new Date(new Date(desde).getTime() - dias * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const hastaAnterior = new Date(new Date(desde).getTime() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Helper: construir filtros segun los params recibidos
    // Devuelve { whereItem, whereExists, params } segun contexto de la query
    const construirFiltros = (desdeParam, hastaParam) => {
      const params = [desdeParam, hastaParam];
      let whereExtraItem = ''; // para queries que YA hacen JOIN a pi y p
      let whereExists = '';    // para queries que solo usan pd (filtrar via EXISTS)

      if (producto_id) {
        params.push(producto_id);
        const idx = params.length;
        whereExtraItem = `AND pi.producto_id = $${idx}`;
        whereExists = `AND EXISTS (SELECT 1 FROM core.tblpedido_items pif WHERE pif.pedido_id = pd.id AND pif.producto_id = $${idx})`;
      } else if (categoria_id) {
        params.push(categoria_id);
        const idx = params.length;
        whereExtraItem = `AND p.categoria_id = $${idx}`;
        whereExists = `AND EXISTS (SELECT 1 FROM core.tblpedido_items pif JOIN core.tblproductos pf ON pif.producto_id = pf.id WHERE pif.pedido_id = pd.id AND pf.categoria_id = $${idx})`;
      }
      return { whereExtraItem, whereExists, params };
    };

    const fActual = construirFiltros(desde, hasta);
    const fAnterior = construirFiltros(desdeAnterior, hastaAnterior);

    // 1. KPIs del período actual (siempre basados en items para precision con filtros)
    const kpis = await pool.query(`
      SELECT
        COUNT(DISTINCT pd.id)::INTEGER AS total_pedidos,
        COALESCE(SUM(pi.subtotal), 0)::NUMERIC(10,2) AS ingresos_totales,
        COALESCE(SUM(pi.cantidad), 0)::INTEGER AS unidades_vendidas
      FROM core.tblpedidos pd
      JOIN core.tblpedido_items pi ON pi.pedido_id = pd.id
      JOIN core.tblproductos p ON pi.producto_id = p.id
      WHERE pd.created_at::date BETWEEN $1 AND $2
        AND pd.estado != 'cancelado'
        ${fActual.whereExtraItem}
    `, fActual.params);

    // 2. KPIs del período anterior (para comparativo)
    const kpisAnterior = await pool.query(`
      SELECT
        COUNT(DISTINCT pd.id)::INTEGER AS total_pedidos,
        COALESCE(SUM(pi.subtotal), 0)::NUMERIC(10,2) AS ingresos_totales,
        COALESCE(SUM(pi.cantidad), 0)::INTEGER AS unidades_vendidas
      FROM core.tblpedidos pd
      JOIN core.tblpedido_items pi ON pi.pedido_id = pd.id
      JOIN core.tblproductos p ON pi.producto_id = p.id
      WHERE pd.created_at::date BETWEEN $1 AND $2
        AND pd.estado != 'cancelado'
        ${fAnterior.whereExtraItem}
    `, fAnterior.params);

    // Ticket promedio = ingresos_totales / total_pedidos
    const ticketPromedio = kpis.rows[0].total_pedidos > 0
      ? parseFloat(kpis.rows[0].ingresos_totales) / kpis.rows[0].total_pedidos
      : 0;

    // 3. Ventas por día
    const ventasPorDia = await pool.query(`
      SELECT
        pd.created_at::date AS dia,
        COUNT(DISTINCT pd.id)::INTEGER AS pedidos,
        COALESCE(SUM(pi.cantidad), 0)::INTEGER AS unidades,
        COALESCE(SUM(pi.subtotal), 0)::NUMERIC(10,2) AS ingresos
      FROM core.tblpedidos pd
      JOIN core.tblpedido_items pi ON pi.pedido_id = pd.id
      JOIN core.tblproductos p ON pi.producto_id = p.id
      WHERE pd.created_at::date BETWEEN $1 AND $2
        AND pd.estado != 'cancelado'
        ${fActual.whereExtraItem}
      GROUP BY pd.created_at::date
      ORDER BY dia ASC
    `, fActual.params);

    // 4. Ventas por día de la semana (0=Domingo, 6=Sábado)
    const ventasPorDiaSemana = await pool.query(`
      SELECT
        EXTRACT(DOW FROM pd.created_at)::INTEGER AS dia_num,
        COUNT(DISTINCT pd.id)::INTEGER AS pedidos,
        COALESCE(SUM(pi.cantidad), 0)::INTEGER AS unidades,
        COALESCE(SUM(pi.subtotal), 0)::NUMERIC(10,2) AS ingresos
      FROM core.tblpedidos pd
      JOIN core.tblpedido_items pi ON pi.pedido_id = pd.id
      JOIN core.tblproductos p ON pi.producto_id = p.id
      WHERE pd.created_at::date BETWEEN $1 AND $2
        AND pd.estado != 'cancelado'
        ${fActual.whereExtraItem}
      GROUP BY EXTRACT(DOW FROM pd.created_at)
      ORDER BY dia_num
    `, fActual.params);

    // 5. Ventas por hora (solo cuenta pedidos que cumplen el filtro via EXISTS)
    const ventasPorHora = await pool.query(`
      SELECT
        EXTRACT(HOUR FROM pd.created_at)::INTEGER AS hora,
        COUNT(DISTINCT pd.id)::INTEGER AS pedidos
      FROM core.tblpedidos pd
      WHERE pd.created_at::date BETWEEN $1 AND $2
        AND pd.estado != 'cancelado'
        ${fActual.whereExists}
      GROUP BY EXTRACT(HOUR FROM pd.created_at)
      ORDER BY hora
    `, fActual.params);

    // 6. Ventas por categoría (muestra TODAS las categorias del rango si no hay filtro,
    //    o solo la categoria/producto filtrado si hay filtro)
    const ventasPorCategoria = await pool.query(`
      SELECT
        c.nombre AS categoria,
        COALESCE(SUM(pi.cantidad), 0)::INTEGER AS unidades,
        COALESCE(SUM(pi.subtotal), 0)::NUMERIC(10,2) AS ingresos
      FROM core.tblpedido_items pi
      JOIN core.tblpedidos pd ON pi.pedido_id = pd.id
      JOIN core.tblproductos p ON pi.producto_id = p.id
      JOIN core.tblcategorias c ON p.categoria_id = c.id
      WHERE pd.created_at::date BETWEEN $1 AND $2
        AND pd.estado != 'cancelado'
        ${fActual.whereExtraItem}
      GROUP BY c.nombre
      ORDER BY unidades DESC
    `, fActual.params);

    // 7. Top 10 productos del período
    const topProductos = await pool.query(`
      SELECT
        p.id, p.nombre, p.imagen_url, c.nombre AS categoria,
        SUM(pi.cantidad)::INTEGER AS unidades,
        SUM(pi.subtotal)::NUMERIC(10,2) AS ingresos
      FROM core.tblpedido_items pi
      JOIN core.tblpedidos pd ON pi.pedido_id = pd.id
      JOIN core.tblproductos p ON pi.producto_id = p.id
      JOIN core.tblcategorias c ON p.categoria_id = c.id
      WHERE pd.created_at::date BETWEEN $1 AND $2
        AND pd.estado != 'cancelado'
        ${fActual.whereExtraItem}
      GROUP BY p.id, p.nombre, p.imagen_url, c.nombre
      ORDER BY unidades DESC
      LIMIT 10
    `, fActual.params);

    // 8. Distribución por estado de pedido (respeta filtro via EXISTS)
    const porEstado = await pool.query(`
      SELECT pd.estado, COUNT(*)::INTEGER AS total
      FROM core.tblpedidos pd
      WHERE pd.created_at::date BETWEEN $1 AND $2
        ${fActual.whereExists}
      GROUP BY pd.estado
    `, fActual.params);

    // 9. Día con mayor venta
    const diaTop = ventasPorDia.rows.reduce((max, d) =>
      parseFloat(d.ingresos) > parseFloat(max?.ingresos || 0) ? d : max, null);

    // 10. Productos sin ventas en el período (activos pero con 0 ventas)
    const sinVentasParams = [desde, hasta];
    let sinVentasExtraWhere = '';
    if (producto_id) {
      sinVentasParams.push(producto_id);
      sinVentasExtraWhere = `AND p.id = $${sinVentasParams.length}`;
    } else if (categoria_id) {
      sinVentasParams.push(categoria_id);
      sinVentasExtraWhere = `AND p.categoria_id = $${sinVentasParams.length}`;
    }
    const productosSinVentas = await pool.query(`
      SELECT p.id, p.nombre, c.nombre AS categoria
      FROM core.tblproductos p
      JOIN core.tblcategorias c ON p.categoria_id = c.id
      WHERE p.activo = true
        ${sinVentasExtraWhere}
        AND p.id NOT IN (
          SELECT DISTINCT pi.producto_id
          FROM core.tblpedido_items pi
          JOIN core.tblpedidos pd ON pi.pedido_id = pd.id
          WHERE pd.created_at::date BETWEEN $1 AND $2
            AND pd.estado != 'cancelado'
            AND pi.producto_id IS NOT NULL
        )
      ORDER BY p.nombre
      LIMIT 20
    `, sinVentasParams);

    // Variaciones vs período anterior
    const varPct = (actual, anterior) => {
      const a = parseFloat(actual) || 0;
      const b = parseFloat(anterior) || 0;
      if (b === 0) return a > 0 ? 100 : 0;
      return Math.round(((a - b) / b) * 100 * 10) / 10;
    };

    res.json({
      success: true,
      periodo: { desde, hasta, desde_anterior: desdeAnterior, hasta_anterior: hastaAnterior },
      kpis: {
        total_pedidos: kpis.rows[0].total_pedidos,
        ingresos_totales: parseFloat(kpis.rows[0].ingresos_totales),
        unidades_vendidas: kpis.rows[0].unidades_vendidas,
        ticket_promedio: Math.round(ticketPromedio * 100) / 100,
        var_pedidos: varPct(kpis.rows[0].total_pedidos, kpisAnterior.rows[0].total_pedidos),
        var_ingresos: varPct(kpis.rows[0].ingresos_totales, kpisAnterior.rows[0].ingresos_totales),
        var_unidades: varPct(kpis.rows[0].unidades_vendidas, kpisAnterior.rows[0].unidades_vendidas),
      },
      ventas_por_dia: ventasPorDia.rows,
      ventas_por_dia_semana: ventasPorDiaSemana.rows,
      ventas_por_hora: ventasPorHora.rows,
      ventas_por_categoria: ventasPorCategoria.rows,
      top_productos: topProductos.rows,
      por_estado: porEstado.rows,
      dia_top: diaTop,
      productos_sin_ventas: productosSinVentas.rows,
    });
  } catch (error) {
    console.error('Error GET /simulador/analisis-ventas:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener analisis de ventas' });
  }
});

module.exports = router;
