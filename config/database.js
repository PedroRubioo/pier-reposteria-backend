// config/database.js
const { Pool } = require('pg');

// ==========================================
// CONFIGURACIÓN DE CONEXIÓN A NEON
// ==========================================

// Obtener connection string de variable de entorno
const connectionString = process.env.DATABASE_URL;

// Validación crítica al inicio
if (!connectionString) {
  console.error('\n❌ ERROR CRÍTICO: DATABASE_URL no está definida en el archivo .env');
  console.error('📌 Agrega esta línea a tu archivo .env:');
  console.error('   DATABASE_URL=postgresql://neondb_owner:npg_CSgtR4Wqi7mx@ep-nameless-firefly-aj8v9zii-pooler.c-3.us-east-2.aws.neon.tech/neondb?sslmode=require\n');
  process.exit(1); // Detener la ejecución
}

// Crear pool de conexiones
const pool = new Pool({
  connectionString,
  ssl: {
    require: true,
    // 🔒 SEGURIDAD: En producción se valida el certificado TLS.
    // En desarrollo/CI se permite false para compatibilidad con Neon pooler.
    rejectUnauthorized: process.env.NODE_ENV === 'production' ? true : false
  },
  // Configuraciones adicionales para mejor rendimiento
  max: 10, // máximo 10 conexiones en el pool
  idleTimeoutMillis: 30000, // cerrar conexiones inactivas después de 30 segundos
  connectionTimeoutMillis: 5000, // timeout de conexión de 5 segundos
});

// ==========================================
// FUNCIÓN DE CONEXIÓN CON DIAGNÓSTICO
// ==========================================

async function connectDB() {
  let client;
  try {
    console.log('\n🔄 Intentando conectar a Neon PostgreSQL...');
    console.log(`📡 Host: ${new URL(connectionString).hostname}`);
    
    // Intentar conectar
    client = await pool.connect();
    console.log('✅ Conectado a Neon PostgreSQL exitosamente');
    
    // ========================================
    // VERIFICACIÓN 1: Esquema 'core'
    // ========================================
    console.log('\n📋 Verificando esquema core...');
    const schemaCheck = await client.query(
      `SELECT EXISTS (
        SELECT 1 
        FROM information_schema.schemata 
        WHERE schema_name = 'core'
      )`
    );
    
    if (!schemaCheck.rows[0].exists) {
      console.error('❌ ERROR: El esquema "core" NO existe en la base de datos');
      console.error('📌 Para crearlo, ejecuta este comando en el SQL Editor de Neon:');
      console.error('   CREATE SCHEMA core;');
      throw new Error('Esquema core no encontrado');
    }
    console.log('✅ Esquema "core" encontrado');
    
    // ========================================
    // VERIFICACIÓN 2: Tabla 'tblusuarios'
    // ========================================
    console.log('\n📋 Verificando tabla core.tblusuarios...');
    const tableCheck = await client.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'core' 
        AND table_name = 'tblusuarios'
      )`
    );
    
    if (!tableCheck.rows[0].exists) {
      console.error('❌ ERROR: La tabla "core.tblusuarios" NO existe');
      console.error('📌 Ejecuta el script pierdb_neon.sql completo en el SQL Editor de Neon');
      
      // Listar tablas disponibles para ayudar
      const tables = await client.query(
        `SELECT table_name 
         FROM information_schema.tables 
         WHERE table_schema = 'core' 
         ORDER BY table_name`
      );
      
      if (tables.rows.length > 0) {
        console.log('\n📋 Tablas encontradas en esquema core:');
        tables.rows.forEach((t, i) => {
          console.log(`   ${i + 1}. core.${t.table_name}`);
        });
      }
      
      throw new Error('Tabla tblusuarios no encontrada');
    }
    console.log('✅ Tabla core.tblusuarios encontrada');
    
    // ========================================
    // VERIFICACIÓN 3: Contar usuarios
    // ========================================
    console.log('\n👥 Verificando usuarios registrados...');
    const countResult = await client.query('SELECT COUNT(*) FROM core.tblusuarios');
    const userCount = parseInt(countResult.rows[0].count);
    console.log(`   Total de usuarios en BD: ${userCount}`);
    
    if (userCount === 0) {
      console.warn('⚠️  La tabla tblusuarios está vacía');
      console.warn('📌 No hay usuarios registrados. Puedes crear uno de prueba:');
      console.warn('   INSERT INTO core.tblusuarios (nombre, apellido, email, password_hash, telefono, rol)');
      console.warn("   VALUES ('Test', 'User', 'test@test.com', '$2a$10$...', '0000000000', 'cliente');");
    } else {
      // Mostrar algunos usuarios como ejemplo
      const sampleUsers = await client.query(
        'SELECT id, nombre, apellido, email, rol FROM core.tblusuarios LIMIT 3'
      );
      console.log('\n📋 Muestra de usuarios:');
      sampleUsers.rows.forEach(user => {
        console.log(`   - ${user.nombre} ${user.apellido} (${user.email}) - Rol: ${user.rol}`);
      });
    }
    
    // ========================================
    // VERIFICACIÓN 4: Probar una consulta JOIN
    // ========================================
    console.log('\n🔍 Verificando relaciones (si existen)...');
    try {
      const relacionTest = await client.query(`
        SELECT COUNT(*) 
        FROM core.tblpedidos p 
        JOIN core.tblusuarios u ON p.usuario_id = u.id 
        LIMIT 1
      `);
      console.log('✅ Relaciones entre tablas funcionando');
    } catch (e) {
      console.log('ℹ️  No hay pedidos o la tabla tblpedidos no existe aún');
    }
    
    console.log('\n✅✅✅ VERIFICACIÓN COMPLETA - Base de datos lista para usar\n');
    
    client.release();
    return pool;
    
  } catch (error) {
    console.error('\n❌❌❌ ERROR EN CONEXIÓN A NEON');
    console.error('   Mensaje:', error.message);
    
    if (error.code) {
      console.error('   Código de error:', error.code);
      
      // Errores comunes de PostgreSQL
      switch (error.code) {
        case 'ECONNREFUSED':
          console.error('   🔴 No se pudo conectar al servidor');
          console.error('   📌 Verifica que la URL de conexión sea correcta');
          break;
        case '28P01':
          console.error('   🔴 Autenticación fallida (password incorrecto)');
          console.error('   📌 Revisa el usuario y contraseña en DATABASE_URL');
          break;
        case '3D000':
          console.error('   🔴 La base de datos no existe');
          console.error('   📌 Verifica el nombre de la base de datos en la URL');
          break;
        case '42P01':
          console.error('   🔴 Tabla no encontrada');
          console.error('   📌 Ejecuta el script SQL completo');
          break;
        default:
          console.error('   📌 Revisa la documentación de Neon o tu conexión');
      }
    }
    
    if (error.hint) {
      console.error('   💡 Sugerencia:', error.hint);
    }
    
    console.error('\n📌 DATABASE_URL usada:', connectionString.replace(/:[^:]*@/, ':****@'));
    console.error('📌 Verifica que:');
    console.error('   1. El archivo .env existe en la raíz del proyecto');
    console.error('   2. dotenv.config() se llama ANTES de importar database.js');
    console.error('   3. La base de datos en Neon está activa');
    console.error('   4. Ejecutaste el script pierdb_neon.sql completo\n');
    
    throw error; // Relanzar para que server.js lo maneje
  }
}

// ==========================================
// FUNCIONES AUXILIARES
// ==========================================

/**
 * Obtener el pool de conexiones
 */
async function getDB() {
  return pool;
}

/**
 * Cerrar todas las conexiones
 */
async function closeDB() {
  try {
    await pool.end();
    console.log('🔌 Conexión a Neon cerrada correctamente');
  } catch (error) {
    console.error('❌ Error cerrando conexión:', error.message);
  }
}

/**
 * Ejecutar una consulta con logging opcional
 */
async function query(text, params, log = false) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    
    if (log) {
      console.log('📊 Consulta ejecutada:', { text, duration: `${duration}ms`, rows: result.rowCount });
    }
    
    return result;
  } catch (error) {
    console.error('❌ Error en consulta:', { text, error: error.message });
    throw error;
  }
}

// ==========================================
// EXPORTACIONES
// ==========================================

module.exports = {
  pool,
  connectDB,
  getDB,
  closeDB,
  query
};