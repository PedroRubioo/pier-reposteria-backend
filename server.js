// PRIMERO: Cargar variables de entorno
// ==========================================
const dotenv = require('dotenv');
dotenv.config();  // <-- AHORA SÍ, PRIMERO

// ==========================================
// Luego el resto de imports (ya con variables cargadas)
// ==========================================
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const helmet = require('helmet');
const { connectDB, pool } = require('./config/database');  // ← database.js YA tiene DATABASE_URL

// 🔒 SEGURIDAD: Importar middlewares de seguridad
const { sanitizeRequestMiddleware } = require('./middleware/validation');
const { rateLimitMiddleware } = require('./middleware/rateLimiting');
const { securityHeadersMiddleware, getCSRFTokenEndpoint } = require('./middleware/securityHeaders');
const { SecureLogger, requestLoggerMiddleware } = require('./utils/secureLogger');

// Cargar Passport
const passport = require('./config/passport');


// Crear app de Express
const app = express();

// ========================================
// 🔒 MIDDLEWARES DE SEGURIDAD
// ========================================

// Helmet para headers adicionales de seguridad
app.use(helmet({
  contentSecurityPolicy: false, // Lo manejamos custom en securityHeaders
  hsts: false // Lo manejamos custom
}));

// Headers de seguridad personalizados
app.use(securityHeadersMiddleware);

// ========================================
// CORS CONFIGURATION
// ========================================
const allowedOrigins = [
  'https://pier-reposteria.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:5174'
];

app.use(cors({
  origin: function (origin, callback) {
    // Permitir requests sin origin (como Postman, curl)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.indexOf(origin) === -1) {
      SecureLogger.security('CORS policy violation', { origin });
      const msg = 'CORS policy restriction';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token']
}));

// ========================================
// MIDDLEWARES BÁSICOS
// ========================================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 🔒 Sanitización de inputs
app.use(sanitizeRequestMiddleware);

// 🔒 Rate limiting general
app.use(rateLimitMiddleware);

// 🔒 Logging seguro de requests
app.use(requestLoggerMiddleware);

// ========================================
// SESIÓN (para Passport y CSRF)
// ========================================
app.use(session({
  secret: process.env.JWT_SECRET || 'pierreposteria_secret_key_2025',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000 // 24 horas
  }
}));

// Inicializar Passport
app.use(passport.initialize());
app.use(passport.session());

// ========================================
// HEALTH CHECKS (sin autenticación)
// ========================================

// Health check para Render (DEBE ESTAR AL INICIO)
app.get('/api/render-health', (req, res) => {
  res.json({ 
    status: 'OK', 
    service: 'pier-reposteria-backend',
    timestamp: new Date(),
    environment: process.env.NODE_ENV,
    database: 'PostgreSQL Neon'
  });
});

// Health check general
app.get('/api/health', async (req, res) => {
  try {
    // Verificar conexión a Neon
    const dbStatus = await pool.query('SELECT NOW() as time');
    
    res.json({
      success: true,
      status: 'healthy',
      timestamp: new Date(),
      environment: process.env.NODE_ENV,
      database: {
        connected: true,
        type: 'PostgreSQL',
        provider: 'Neon',
        time: dbStatus.rows[0].time
      },
      security: {
        https: process.env.NODE_ENV === 'production',
        rateLimiting: true,
        csrfProtection: true,
        inputSanitization: true,
        securityHeaders: true
      }
    });
  } catch (error) {
    res.json({
      success: true,
      status: 'degraded',
      timestamp: new Date(),
      environment: process.env.NODE_ENV,
      database: {
        connected: false,
        error: error.message
      }
    });
  }
});

// Endpoint para obtener token CSRF
app.get('/api/csrf-token', getCSRFTokenEndpoint);

// ========================================
// RUTAS
// ========================================
const authRoutes = require('./routes/authRoutes');
const googleAuthRoutes = require('./routes/googleAuthRoutes');
const backupRoutes = require('./routes/backupRoutes');

app.use('/api/auth', authRoutes);
app.use('/api/auth', googleAuthRoutes);
app.use('/api/backups', backupRoutes);
// ========================================
// RUTA PRINCIPAL
// ========================================
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: '🍰 API de Pier Repostería funcionando correctamente',
    version: '2.1.0',
    environment: process.env.NODE_ENV,
    database: 'PostgreSQL Neon',
    security: '🔒 Enhanced Security Enabled'
  });
});

// ========================================
// MANEJO DE ERRORES
// ========================================

// 404 - Ruta no encontrada
app.use((req, res) => {
  SecureLogger.warn('Route not found', {
    method: req.method,
    url: req.url,
    ip: req.ip
  });
  
  res.status(404).json({
    success: false,
    message: 'Ruta no encontrada'
  });
});

// Error handler global
app.use((err, req, res, next) => {
  SecureLogger.error('Server error', err);
  
  // En producción, NO enviar detalles del error
  if (process.env.NODE_ENV === 'production') {
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  } else {
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor',
      error: err.message,
      stack: err.stack
    });
  }
});

// ========================================
// INICIAR SERVIDOR
// ========================================
const PORT = process.env.PORT || 10000;

async function startServer() {
  try {
    SecureLogger.info('🚀 Iniciando servidor Pier Repostería...');
    
    // Conectar a Neon PostgreSQL
    SecureLogger.info('📡 Conectando a Neon PostgreSQL...');
    await connectDB();
    
    // Verificar configuración de email
    if (process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL) {
      SecureLogger.info('📧 Verificando configuración de email...');
      const { verifyEmailConfig } = require('./services/emailServiceBrevo');
      await verifyEmailConfig();
    } else {
      SecureLogger.warn('⚠️ Email no configurado (BREVO_API_KEY o BREVO_SENDER_EMAIL faltantes)');
    }
    
    // Iniciar servidor
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log('\n╔══════════════════════════════════════════════╗');
      console.log('║     🍰 PIER REPOSTERÍA - API SERVER v2.1    ║');
      console.log('╠══════════════════════════════════════════════╣');
      console.log(`║  🚀 Servidor: http://0.0.0.0:${PORT}           `);
      console.log(`║  ⚙️  Ambiente: ${process.env.NODE_ENV || 'development'}           `);
      console.log(`║  🗄️  Base de datos: PostgreSQL Neon ✅       `);
      console.log('╠══════════════════════════════════════════════╣');
      console.log('║  🔒 SEGURIDAD ACTIVADA:                       ║');
      console.log('║     ├─ Rate Limiting: ✅                     ║');
      console.log('║     ├─ Input Sanitization: ✅                ║');
      console.log('║     ├─ CSRF Protection: ✅                   ║');
      console.log('║     ├─ Security Headers: ✅                  ║');
      console.log('║     ├─ Secure Logging: ✅                    ║');
      console.log('║     └─ Login Attempt Blocking: ✅            ║');
      console.log('╠══════════════════════════════════════════════╣');
      console.log(`║  📧 Google OAuth: ${process.env.GOOGLE_CLIENT_ID ? '✅' : '❌'}                          ║`);
      console.log('╚══════════════════════════════════════════════╝\n');
    });

    // Manejo de cierre graceful
    process.on('SIGTERM', () => {
      SecureLogger.info('📴 SIGTERM recibido, cerrando servidor...');
      server.close(() => {
        SecureLogger.info('✅ Servidor cerrado correctamente');
        process.exit(0);
      });
    });
    
  } catch (error) {
    SecureLogger.error('💥 Error iniciando servidor', error);
    process.exit(1);
  }
}

// ========================================
// MANEJO DE ERRORES NO CAPTURADOS
// ========================================
process.on('uncaughtException', (error) => {
  SecureLogger.error('🔥 Uncaught Exception', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  SecureLogger.error('🔥 Unhandled Rejection', { reason, promise });
  process.exit(1);
});

// Iniciar servidor
startServer();

module.exports = app;