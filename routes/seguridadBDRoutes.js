const express = require('express');
const router = express.Router();
const { verifyToken, verifyRole } = require('../middleware/auth');
const { pool } = require('../config/database');

// ============================================
// LISTAR ROLES DE BD Y SUS ATRIBUTOS
// ============================================
router.get('/roles', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const rolesResult = await pool.query(`
      SELECT 
        rolname AS nombre,
        rolcanlogin AS puede_login,
        rolcreatedb AS crear_bd,
        rolcreaterole AS crear_roles,
        rolconnlimit AS limite_conexiones,
        COALESCE(obj_description(oid, 'pg_authid'), '') AS descripcion
      FROM pg_roles
      WHERE rolname IN ('rol_consulta', 'rol_operacion', 'rol_admin')
      ORDER BY rolname
    `);

    res.json({ success: true, roles: rolesResult.rows });
  } catch (error) {
    console.error('Error en /roles:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener roles' });
  }
});

// ============================================
// LISTAR PERMISOS POR ROL (GRANT detallado)
// ============================================
router.get('/permisos', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const permisosResult = await pool.query(`
      SELECT 
        grantee AS rol,
        table_schema AS esquema,
        table_name AS tabla,
        string_agg(privilege_type, ', ' ORDER BY privilege_type) AS permisos
      FROM information_schema.role_table_grants
      WHERE grantee IN ('rol_consulta', 'rol_operacion', 'rol_admin')
        AND table_schema IN ('core', 'staging', 'reports')
      GROUP BY grantee, table_schema, table_name
      ORDER BY grantee, table_schema, table_name
    `);

    res.json({ success: true, permisos: permisosResult.rows });
  } catch (error) {
    console.error('Error en /permisos:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener permisos' });
  }
});

// ============================================
// PERMISOS A NIVEL DE ESQUEMA
// ============================================
router.get('/esquemas', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const esquemasResult = await pool.query(`
      SELECT 
        nspname AS esquema,
        r.rolname AS rol,
        has_schema_privilege(r.rolname, nspname, 'USAGE') AS uso,
        has_schema_privilege(r.rolname, nspname, 'CREATE') AS crear
      FROM pg_namespace n
      CROSS JOIN pg_roles r
      WHERE nspname IN ('core', 'staging', 'reports')
        AND r.rolname IN ('rol_consulta', 'rol_operacion', 'rol_admin')
      ORDER BY nspname, r.rolname
    `);

    res.json({ success: true, esquemas: esquemasResult.rows });
  } catch (error) {
    console.error('Error en /esquemas:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener permisos de esquemas' });
  }
});

// ============================================
// PROBAR ACCESO (simula operación con un rol)
// ============================================
router.post('/probar-acceso', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  const { rol, operacion, tabla } = req.body;

  // Validar inputs
  const rolesValidos = ['rol_consulta', 'rol_operacion', 'rol_admin'];
  const operacionesValidas = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];

  if (!rolesValidos.includes(rol)) {
    return res.status(400).json({ success: false, message: 'Rol no válido' });
  }
  if (!operacionesValidas.includes(operacion)) {
    return res.status(400).json({ success: false, message: 'Operación no válida' });
  }

  // Validar que la tabla existe y es segura (prevenir SQL injection)
  try {
    const tablaExiste = await pool.query(
      `SELECT table_name FROM information_schema.tables 
       WHERE table_schema = 'core' AND table_name = $1`,
      [tabla]
    );
    if (tablaExiste.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'Tabla no encontrada en esquema core' });
    }

    // Verificar permiso usando has_table_privilege (NO ejecuta la query real)
    const privilegeMap = {
      'SELECT': 'SELECT',
      'INSERT': 'INSERT',
      'UPDATE': 'UPDATE',
      'DELETE': 'DELETE'
    };

    const testResult = await pool.query(
      `SELECT has_table_privilege($1, $2, $3) AS permitido`,
      [rol, `core.${tabla}`, privilegeMap[operacion]]
    );

    const permitido = testResult.rows[0].permitido;

    // Registrar la prueba en auditoría
    await pool.query(
      `INSERT INTO core.tblauditoria (accion, entidad, detalles, created_at) 
       VALUES ('Prueba de acceso BD', 'seguridad', $1::jsonb, NOW())`,
      [JSON.stringify({
        rol,
        operacion,
        tabla: `core.${tabla}`,
        resultado: permitido ? 'PERMITIDO' : 'DENEGADO',
        ejecutado_por: req.user.email
      })]
    );

    res.json({
      success: true,
      resultado: {
        rol,
        operacion,
        tabla: `core.${tabla}`,
        permitido,
        mensaje: permitido
          ? `✅ ${rol} tiene permiso ${operacion} en core.${tabla}`
          : `❌ ${rol} NO tiene permiso ${operacion} en core.${tabla}`
      }
    });

  } catch (error) {
    console.error('Error en /probar-acceso:', error.message);
    res.status(500).json({ success: false, message: 'Error al probar acceso' });
  }
});

// ============================================
// HISTORIAL DE PRUEBAS DE ACCESO
// ============================================
router.get('/historial', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    const historialResult = await pool.query(`
      SELECT 
        id,
        detalles->>'rol' AS rol,
        detalles->>'operacion' AS operacion,
        detalles->>'tabla' AS tabla,
        detalles->>'resultado' AS resultado,
        detalles->>'ejecutado_por' AS ejecutado_por,
        created_at
      FROM core.tblauditoria
      WHERE accion = 'Prueba de acceso BD'
      ORDER BY created_at DESC
      LIMIT 20
    `);

    res.json({ success: true, historial: historialResult.rows });
  } catch (error) {
    console.error('Error en /historial:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener historial' });
  }
});

// ============================================
// RESUMEN GENERAL DE SEGURIDAD
// ============================================
router.get('/resumen', verifyToken, verifyRole('direccion_general'), async (req, res) => {
  try {
    // Total de roles creados
    const rolesCount = await pool.query(
      `SELECT COUNT(*) AS total FROM pg_roles WHERE rolname IN ('rol_consulta', 'rol_operacion', 'rol_admin')`
    );

    // Total de permisos asignados
    const permisosCount = await pool.query(`
      SELECT COUNT(*) AS total FROM information_schema.role_table_grants
      WHERE grantee IN ('rol_consulta', 'rol_operacion', 'rol_admin')
        AND table_schema IN ('core', 'staging', 'reports')
    `);

    // Esquemas existentes
    const esquemas = await pool.query(`
      SELECT schema_name FROM information_schema.schemata
      WHERE schema_name IN ('core', 'staging', 'reports')
      ORDER BY schema_name
    `);

    // Tablas por esquema
    const tablasPorEsquema = await pool.query(`
      SELECT table_schema AS esquema, COUNT(*) AS total
      FROM information_schema.tables
      WHERE table_schema IN ('core', 'staging', 'reports')
      GROUP BY table_schema
      ORDER BY table_schema
    `);

    // Pruebas de acceso realizadas
    const pruebasCount = await pool.query(
      `SELECT COUNT(*) AS total FROM core.tblauditoria WHERE accion = 'Prueba de acceso BD'`
    );

    res.json({
      success: true,
      resumen: {
        roles_creados: parseInt(rolesCount.rows[0].total),
        permisos_asignados: parseInt(permisosCount.rows[0].total),
        esquemas: esquemas.rows.map(e => e.schema_name),
        tablas_por_esquema: tablasPorEsquema.rows,
        pruebas_realizadas: parseInt(pruebasCount.rows[0].total)
      }
    });
  } catch (error) {
    console.error('Error en /resumen:', error.message);
    res.status(500).json({ success: false, message: 'Error al obtener resumen' });
  }
});

module.exports = router;