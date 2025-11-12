const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { connectDB } = require('./config/database');

// Cargar variables de entorno
dotenv.config();

// Crear app de Express
const app = express();

// CORS para producción - MÁS SEGURO
const allowedOrigins = [
  'https://pier-reposteria.vercel.app', // Tu frontend en Vercel
  'http://localhost:3000',
  'http://localhost:5173' // Vite dev server
];

app.use(cors({
  origin: function (origin, callback) {
    // Permitir requests sin origin (como mobile apps o curl)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Logging de requests
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path} - ${req.ip}`);
  next();
});

// Rutas
const authRoutes = require('./routes/authRoutes');
app.use('/api/auth', authRoutes);

// Ruta de prueba
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: '🍰 API de Pier Repostería funcionando correctamente',
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    timestamp: new Date()
  });
});

// Ruta de health check mejorada (para Render)
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'healthy',
    timestamp: new Date(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    memory: process.memoryUsage()
  });
});

// Endpoint específico para verificación de Render
app.get('/api/health/ready', async (req, res) => {
  try {
    // Verificar conexión a la base de datos
    const db = await require('./config/database').getDB();
    await db.command({ ping: 1 });
    
    res.json({
      success: true,
      status: 'ready',
      database: 'connected',
      timestamp: new Date()
    });
  } catch (error) {
    res.status(503).json({
      success: false,
      status: 'not ready',
      database: 'disconnected',
      error: error.message,
      timestamp: new Date()
    });
  }
});

// Manejo de rutas no encontradas
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Ruta no encontrada',
    path: req.path
  });
});

// Manejo de errores global
app.use((err, req, res, next) => {
  console.error('Error:', err);
  
  // Si es error de CORS
  if (err.message.includes('CORS')) {
    return res.status(403).json({
      success: false,
      message: 'Acceso no permitido por política CORS'
    });
  }
  
  res.status(500).json({
    success: false,
    message: 'Error interno del servidor',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Puerto - IMPORTANTE para Render
const PORT = process.env.PORT || 5000;

// Función mejorada para iniciar servidor
async function startServer() {
  try {
    console.log('🔄 Iniciando servidor...');
    
    // Conectar a MongoDB
    console.log('📦 Conectando a MongoDB...');
    await connectDB();
    console.log('✅ MongoDB conectado exitosamente');
    
    // PROBAR EMAIL (solo si hay credenciales)
    if (process.env.EMAIL_USER && process.env.EMAIL_PASSWORD) {
      console.log('🧪 Probando configuración de email...');
      const { verifyEmailConfig } = require('./services/emailService');
      await verifyEmailConfig();
    } else {
      console.log('⚠️  Credenciales de email no configuradas');
    }
    
    // Iniciar servidor Express - IMPORTANTE: '0.0.0.0' para Render
    app.listen(PORT, '0.0.0.0', () => {
      console.log('═══════════════════════════════════════════');
      console.log('🍰  PIER REPOSTERÍA - API SERVER');
      console.log('═══════════════════════════════════════════');
      console.log(`🚀  Servidor corriendo en puerto ${PORT}`);
      console.log(`🌍  Host: 0.0.0.0`);
      console.log(`⚙️   Ambiente: ${process.env.NODE_ENV || 'development'}`);
      console.log(`📡  URL: http://localhost:${PORT}`);
      console.log(`🔗  API Base: http://localhost:${PORT}/api`);
      console.log('═══════════════════════════════════════════');
      
      // Log de los orígenes permitidos
      console.log('🎯 Orígenes CORS permitidos:');
      allowedOrigins.forEach(origin => console.log(`   - ${origin}`));
    });
    
  } catch (error) {
    console.error('❌ Error crítico iniciando servidor:', error);
    process.exit(1);
  }
}

// Manejo de cierre graceful
process.on('SIGINT', async () => {
  console.log('\n🔌 Recibida señal SIGINT. Cerrando servidor...');
  try {
    const { closeDB } = require('./config/database');
    await closeDB();
    console.log('✅ Conexiones cerradas correctamente');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error cerrando conexiones:', error);
    process.exit(1);
  }
});

process.on('SIGTERM', async () => {
  console.log('\n🔌 Recibida señal SIGTERM. Cerrando servidor...');
  try {
    const { closeDB } = require('./config/database');
    await closeDB();
    console.log('✅ Conexiones cerradas correctamente');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error cerrando conexiones:', error);
    process.exit(1);
  }
});

// Manejo de errores no capturados
process.on('uncaughtException', (error) => {
  console.error('💥 Error no capturado:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Promise rechazada no manejada:', reason);
  process.exit(1);
});

// Iniciar servidor
startServer();

module.exports = app;