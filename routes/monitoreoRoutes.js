const express = require('express');
const router = express.Router();
const { verifyToken, verifyRole } = require('../middleware/auth');
const { pool } = require('../config/database');

// ============================================
// RESUMEN GENERAL DE RENDIMIENTO
// ============================================
router.get('/resumen', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    // Tamaño total de la BD
    const dbSize = await pool.query(`
      SELECT pg_size_pretty(pg_database_size(current_database())) AS tamano_total
    `);

    // Total de conexiones activas
    const conexiones = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE state = 'active') AS activas,
        COUNT(*) FILTER (WHERE state = 'idle') AS inactivas,
        COUNT(*) AS total
      FROM pg_stat_activity
      WHERE datname = current_database()
    `);

    // Total tablas en core
    const totalTablas = await pool.query(`
      SELECT COUNT(*) AS total 
      FROM information_schema.tables 
      WHERE table_schema = 'core' AND table_type = 'BASE TABLE'
    `);

    // Total índices en core
    const totalIndices = await pool.query(`
      SELECT COUNT(*) AS total
      FROM pg_stat_user_indexes
      WHERE schemaname = 'core'
    `);

    // Tablas con más filas (top 5)
    const topTablas = await pool.query(`
      SELECT 
        relname AS tabla,
        n_live_tup AS filas_estimadas
      FROM pg_stat_user_tables
      WHERE schemaname = 'core'
      ORDER BY n_live_tup DESC
      LIMIT 5
    `);

    // Cache hit ratio
    const cacheHit = await pool.query(`
      SELECT 
        ROUND(
          COALESCE(
            SUM(heap_blks_hit)::numeric / NULLIF(SUM(heap_blks_hit) + SUM(heap_blks_read), 0) * 100,
            0
          ), 2
        ) AS ratio
      FROM pg_statio_user_tables
      WHERE schemaname = 'core'
    `);

    res.json({
      success: true,
      resumen: {
        tamano_bd: dbSize.rows[0].tamano_total,
        conexiones: {
          activas: parseInt(conexiones.rows[0].activas),
          inactivas: parseInt(conexiones.rows[0].inactivas),
          total: parseInt(conexiones.rows[0].total)
        },
        total_tablas: parseInt(totalTablas.rows[0].total),
        total_indices: parseInt(totalIndices.rows[0].total),
        top_tablas: topTablas.rows,
        cache_hit_ratio: parseFloat(cacheHit.rows[0].ratio)
      }
    });
  } catch (error) {
    console.error('Error en /monitoreo/resumen:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener resumen de rendimiento' });
  }
});

// ============================================
// QUERIES ACTIVAS (pg_stat_activity)
// ============================================
router.get('/queries-activas', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        pid,
        usename AS usuario,
        state AS estado,
        COALESCE(LEFT(query, 200), '') AS query,
        backend_start,
        query_start,
        state_change,
        wait_event_type,
        wait_event,
        CASE 
          WHEN query_start IS NOT NULL 
          THEN EXTRACT(EPOCH FROM (NOW() - query_start))::integer
          ELSE 0
        END AS duracion_seg,
        client_addr AS ip_cliente
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid IS NOT NULL
      ORDER BY 
        CASE state 
          WHEN 'active' THEN 1 
          WHEN 'idle in transaction' THEN 2 
          WHEN 'idle' THEN 3 
          ELSE 4 
        END,
        query_start DESC NULLS LAST
      LIMIT 30
    `);

    res.json({ success: true, queries: result.rows });
  } catch (error) {
    console.error('Error en /monitoreo/queries-activas:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener queries activas' });
  }
});

// ============================================
// ESTADÍSTICAS DE TABLAS (pg_stat_user_tables)
// ============================================
router.get('/tablas', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        t.relname AS tabla,
        t.n_live_tup AS filas_vivas,
        t.n_dead_tup AS filas_muertas,
        t.seq_scan AS escaneos_seq,
        t.idx_scan AS escaneos_idx,
        t.n_tup_ins AS inserciones,
        t.n_tup_upd AS actualizaciones,
        t.n_tup_del AS eliminaciones,
        t.last_vacuum,
        t.last_autovacuum,
        t.last_analyze,
        t.last_autoanalyze,
        pg_size_pretty(pg_total_relation_size('core.' || t.relname)) AS tamano_total,
        pg_total_relation_size('core.' || t.relname) AS tamano_bytes,
        CASE 
          WHEN (t.seq_scan + COALESCE(t.idx_scan, 0)) > 0 
          THEN ROUND(
            COALESCE(t.idx_scan, 0)::numeric / (t.seq_scan + COALESCE(t.idx_scan, 0)) * 100, 1
          )
          ELSE 0
        END AS pct_idx_uso
      FROM pg_stat_user_tables t
      WHERE t.schemaname = 'core'
      ORDER BY pg_total_relation_size('core.' || t.relname) DESC
    `);

    res.json({ success: true, tablas: result.rows });
  } catch (error) {
    console.error('Error en /monitoreo/tablas:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener estadísticas de tablas' });
  }
});

// ============================================
// ESTADÍSTICAS DE ÍNDICES (pg_stat_user_indexes)
// ============================================
router.get('/indices', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        i.relname AS tabla,
        i.indexrelname AS indice,
        i.idx_scan AS escaneos,
        i.idx_tup_read AS tuplas_leidas,
        i.idx_tup_fetch AS tuplas_obtenidas,
        pg_size_pretty(pg_relation_size(i.indexrelid)) AS tamano,
        pg_relation_size(i.indexrelid) AS tamano_bytes,
        ix.indisunique AS es_unico,
        ix.indisprimary AS es_primary,
        pg_get_indexdef(i.indexrelid) AS definicion
      FROM pg_stat_user_indexes i
      JOIN pg_index ix ON i.indexrelid = ix.indexrelid
      WHERE i.schemaname = 'core'
      ORDER BY i.idx_scan ASC, pg_relation_size(i.indexrelid) DESC
    `);

    // Identificar índices sin usar (0 escaneos, no son PK ni unique)
    const sinUsar = result.rows.filter(
      idx => parseInt(idx.escaneos) === 0 && !idx.es_primary && !idx.es_unico
    );

    res.json({
      success: true,
      indices: result.rows,
      indices_sin_usar: sinUsar.length,
      total: result.rows.length
    });
  } catch (error) {
    console.error('Error en /monitoreo/indices:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener estadísticas de índices' });
  }
});

// ============================================
// EXPLAIN ANALYZE (solo SELECT - seguridad)
// ============================================
router.post('/explain', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  const { query: userQuery } = req.body;

  if (!userQuery || typeof userQuery !== 'string') {
    return res.status(400).json({ success: false, message: 'Query requerida' });
  }

  // Validar que solo sea SELECT (seguridad)
  const queryNormalizada = userQuery.trim().toUpperCase();
  if (!queryNormalizada.startsWith('SELECT')) {
    return res.status(400).json({
      success: false,
      message: 'Solo se permite EXPLAIN ANALYZE sobre consultas SELECT'
    });
  }

  // Bloquear palabras peligrosas
  const prohibidas = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'CREATE', 'TRUNCATE', 'GRANT', 'REVOKE', 'EXECUTE', 'COPY'];
  const contieneProhibida = prohibidas.some(p => queryNormalizada.includes(p));
  if (contieneProhibida) {
    return res.status(400).json({
      success: false,
      message: 'La consulta contiene operaciones no permitidas'
    });
  }

  try {
    const explainResult = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${userQuery}`);
    const planTexto = await pool.query(`EXPLAIN (ANALYZE, BUFFERS) ${userQuery}`);

    const plan = explainResult.rows[0]['QUERY PLAN'][0];

    // Registrar en auditoría
    await pool.query(
      `INSERT INTO core.tblauditoria (accion, entidad, detalles, created_at) 
       VALUES ('EXPLAIN ANALYZE', 'monitoreo', $1::jsonb, NOW())`,
      [JSON.stringify({
        query: userQuery.substring(0, 300),
        tiempo_planificacion: plan['Planning Time'],
        tiempo_ejecucion: plan['Execution Time'],
        ejecutado_por: req.user.email
      })]
    );

    res.json({
      success: true,
      resultado: {
        plan_json: plan,
        plan_texto: planTexto.rows.map(r => r['QUERY PLAN']),
        tiempo_planificacion: plan['Planning Time'],
        tiempo_ejecucion: plan['Execution Time'],
        nodo_raiz: plan.Plan ? {
          tipo: plan.Plan['Node Type'],
          costo_total: plan.Plan['Total Cost'],
          filas_estimadas: plan.Plan['Plan Rows'],
          filas_reales: plan.Plan['Actual Rows'],
          tiempo_real: plan.Plan['Actual Total Time']
        } : null
      }
    });
  } catch (error) {
    console.error('Error en /monitoreo/explain:', error.message);
    res.status(500).json({
      success: false,
      message: `Error al ejecutar EXPLAIN: ${error.message}`
    });
  }
});

// ============================================
// QUERIES DE EJEMPLO PARA EXPLAIN
// ============================================
router.get('/queries-ejemplo', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  const ejemplos = [
    {
      nombre: 'Productos con categoría',
      query: `SELECT p.nombre, p.precio_chico, c.nombre AS categoria FROM core.tblproductos p JOIN core.tblcategorias c ON p.categoria_id = c.id WHERE p.activo = true ORDER BY p.nombre`,
      descripcion: 'JOIN entre productos y categorías con filtro y orden'
    },

    {
      nombre: 'Conteo por categoría',
      query: `SELECT c.nombre AS categoria, COUNT(p.id) AS total_productos FROM core.tblcategorias c LEFT JOIN core.tblproductos p ON c.id = p.categoria_id GROUP BY c.id, c.nombre ORDER BY total_productos DESC`,
      descripcion: 'Conteo agrupado con LEFT JOIN'
    },
    {
      nombre: 'Escaneo secuencial completo',
      query: `SELECT * FROM core.tblusuarios`,
      descripcion: 'Seq Scan — sin filtro, lee toda la tabla'
    }
  ];

  res.json({ success: true, ejemplos });
});

// ============================================
// TAMAÑO DETALLADO POR TABLA
// ============================================
router.get('/tamanos', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        tablename AS tabla,
        pg_size_pretty(pg_total_relation_size('core.' || tablename)) AS tamano_total,
        pg_size_pretty(pg_relation_size('core.' || tablename)) AS tamano_datos,
        pg_size_pretty(
          pg_total_relation_size('core.' || tablename) - pg_relation_size('core.' || tablename)
        ) AS tamano_indices,
        pg_total_relation_size('core.' || tablename) AS bytes_total
      FROM pg_tables
      WHERE schemaname = 'core'
      ORDER BY pg_total_relation_size('core.' || tablename) DESC
    `);

    const totalBytes = result.rows.reduce((sum, r) => sum + parseInt(r.bytes_total), 0);

    res.json({
      success: true,
      tablas: result.rows,
      total: result.rows.length,
      tamano_total_bytes: totalBytes,
      tamano_total: `${(totalBytes / 1024).toFixed(1)} KB`
    });
  } catch (error) {
    console.error('Error en /monitoreo/tamanos:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener tamaños' });
  }
});

// ============================================
// ESTADO DE VACUUM Y ANALYZE POR TABLA
// ============================================
router.get('/vacuum-status', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        relname AS tabla,
        n_live_tup AS filas_vivas,
        n_dead_tup AS filas_muertas,
        CASE 
          WHEN n_live_tup > 0 
          THEN ROUND(n_dead_tup::numeric / n_live_tup * 100, 1)
          ELSE 0
        END AS pct_muertas,
        last_vacuum,
        last_autovacuum,
        last_analyze,
        last_autoanalyze,
        vacuum_count,
        autovacuum_count,
        analyze_count,
        autoanalyze_count,
        seq_scan AS escaneos_seq,
        idx_scan AS escaneos_idx,
        CASE
          WHEN n_dead_tup > 1000 THEN 'critico'
          WHEN n_dead_tup > 100 THEN 'atencion'
          ELSE 'ok'
        END AS estado
      FROM pg_stat_user_tables
      WHERE schemaname = 'core'
      ORDER BY n_dead_tup DESC
    `);

    res.json({ success: true, tablas: result.rows });
  } catch (error) {
    console.error('Error en /monitoreo/vacuum-status:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener estado de VACUUM' });
  }
});

// ============================================
// EJECUTAR VACUUM EN UNA TABLA O TODAS
// ============================================
router.post('/vacuum', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  const { tabla } = req.body; // si es null/undefined, ejecuta en todas

  try {
    if (tabla) {
      // Validar que la tabla existe
      const existe = await pool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'core' AND table_name = $1`,
        [tabla]
      );
      if (existe.rows.length === 0) {
        return res.status(400).json({ success: false, message: 'Tabla no encontrada' });
      }
      await pool.query(`VACUUM ANALYZE core.${tabla}`);
    } else {
      // Vacuum en todas las tablas de core
      const tablas = await pool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'core' AND table_type = 'BASE TABLE'`
      );
      for (const t of tablas.rows) {
        await pool.query(`VACUUM ANALYZE core.${t.table_name}`);
      }
    }

    // Registrar en auditoría
    await pool.query(
      `INSERT INTO core.tblauditoria (accion, entidad, detalles, created_at) 
       VALUES ('VACUUM ANALYZE', 'monitoreo', $1::jsonb, NOW())`,
      [JSON.stringify({
        tabla: tabla || 'TODAS',
        ejecutado_por: req.user.email
      })]
    );

    res.json({
      success: true,
      message: tabla
        ? `VACUUM ANALYZE ejecutado en core.${tabla}`
        : 'VACUUM ANALYZE ejecutado en todas las tablas de core'
    });
  } catch (error) {
    console.error('Error en /monitoreo/vacuum:', error.message);
    res.status(500).json({ success: false, message: `Error al ejecutar VACUUM: ${error.message}` });
  }
});

// ============================================
// EJECUTAR ANALYZE EN UNA TABLA O TODAS
// ============================================
router.post('/analyze', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  const { tabla } = req.body;

  try {
    if (tabla) {
      const existe = await pool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'core' AND table_name = $1`,
        [tabla]
      );
      if (existe.rows.length === 0) {
        return res.status(400).json({ success: false, message: 'Tabla no encontrada' });
      }
      await pool.query(`ANALYZE core.${tabla}`);
    } else {
      const tablas = await pool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'core' AND table_type = 'BASE TABLE'`
      );
      for (const t of tablas.rows) {
        await pool.query(`ANALYZE core.${t.table_name}`);
      }
    }

    await pool.query(
      `INSERT INTO core.tblauditoria (accion, entidad, detalles, created_at) 
       VALUES ('ANALYZE', 'monitoreo', $1::jsonb, NOW())`,
      [JSON.stringify({
        tabla: tabla || 'TODAS',
        ejecutado_por: req.user.email
      })]
    );

    res.json({
      success: true,
      message: tabla
        ? `ANALYZE ejecutado en core.${tabla}`
        : 'ANALYZE ejecutado en todas las tablas de core'
    });
  } catch (error) {
    console.error('Error en /monitoreo/analyze:', error.message);
    res.status(500).json({ success: false, message: `Error al ejecutar ANALYZE: ${error.message}` });
  }
});

module.exports = router;