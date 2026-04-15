// routes/simuladorRoutes.js — Simulador de producción con datos reales
const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');
const { verifyToken, verifyRole } = require('../middleware/auth');

// Productos ordenados por más vendidos (total histórico)
router.get('/productos-ranking', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.id, p.nombre, p.precio_chico, p.precio_grande, p.imagen_url, c.nombre AS categoria,
        COALESCE(SUM(pi.cantidad), 0)::INTEGER AS total_vendido,
        COALESCE(SUM(pi.subtotal), 0)::NUMERIC(10,2) AS ingresos_totales
      FROM core.tblproductos p
      JOIN core.tblcategorias c ON p.categoria_id = c.id
      LEFT JOIN core.tblpedido_items pi ON pi.producto_id = p.id
      LEFT JOIN core.tblpedidos pd ON pi.pedido_id = pd.id AND pd.estado NOT IN ('cancelado')
      WHERE p.activo = true
      GROUP BY p.id, p.nombre, p.precio_chico, p.precio_grande, p.imagen_url, c.nombre
      ORDER BY total_vendido DESC
    `);
    res.json({ success: true, productos: result.rows });
  } catch (error) {
    console.error('Error GET /simulador/productos-ranking:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener ranking' });
  }
});

// Ventas mensuales de un producto (últimos 6 meses)
router.get('/ventas-mensuales/:productoId', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const { productoId } = req.params;
    const meses = parseInt(req.query.meses) || 6;

    // Ventas separadas por tamaño
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
        AND pd.created_at >= DATE_TRUNC('month', NOW()) - INTERVAL '${meses} months'
      GROUP BY DATE_TRUNC('month', pd.created_at), pi.tamano
      ORDER BY mes ASC
    `, [productoId]);

    // Obtener info del producto
    const productoInfo = await pool.query('SELECT precio_chico, precio_grande FROM core.tblproductos WHERE id = $1', [productoId]);
    const precioChico = productoInfo.rows[0] ? parseFloat(productoInfo.rows[0].precio_chico) : 0;
    const precioGrande = productoInfo.rows[0]?.precio_grande ? parseFloat(productoInfo.rows[0].precio_grande) : null;
    const tieneDosPrecios = precioGrande !== null;

    // Rellenar meses vacíos
    const ahora = new Date();
    const ventasChico = [];
    const ventasGrande = [];
    const ventasTotal = [];

    for (let i = meses - 1; i >= 0; i--) {
      const fecha = new Date(ahora.getFullYear(), ahora.getMonth() - i, 1);
      const mesKey = `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, '0')}`;
      const mesLabel = fecha.toLocaleDateString('es-MX', { month: 'short', year: 'numeric' });

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

    // Predicción exponencial por tamaño
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

      // T(t) = T₀ · e^(Kt) donde t = n (siguiente mes)
      const prediccion = Math.max(0, Math.round(Tf * Math.exp(K)));

      return {
        unidades: prediccion,
        ingresos_estimados: Math.round(prediccion * precio),
        K: Math.round(K * 10000) / 10000,
        promedio: Math.round(promedio * 100) / 100,
        moda: moda,
        T0: T0,
        Tf: Tf,
      };
    };

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

module.exports = router;
