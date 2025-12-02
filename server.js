const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const session = require('express-session');
const helmet = require('helmet'); // Instalar: npm install helmet
const { connectDB } = require('./config/database');

// Cargar variables de entorno PRIMERO
dotenv.config();

// 🔒 SEGURIDAD: Importar middlewares de seguridad
const { sanitizeRequestMiddleware } = require('./middleware/validation');
const { rateLimitMiddleware } = require('./middleware/rateLimiting');
const { securityHeadersMiddleware, getCSRFTokenEndpoint } = require('./middleware/securityHeaders');
const { SecureLogger, requestLoggerMiddleware } = require('./utils/secureLogger');

// Cargar Passport (después de dotenv)
const passport = require('./config/passport');

// Crear app de Express
const app = express();

// 🔒 SEGURIDAD: Helmet para headers adicionales de seguridad
app.use(helmet({
  contentSecurityPolicy: false, // Lo manejamos custom en securityHeaders
  hsts: false // Lo manejamos custom
}));

// 🔒 SEGURIDAD: Headers de seguridad personalizados
app.use(securityHeadersMiddleware);

// CORS configuración segura para producción
const allowedOrigins = [
  'https://pierreposteria-web.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173'
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

// Middlewares básicos
app.use(express.json({ limit: '10mb' })); // Limitar tamaño de payload
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 🔒 SEGURIDAD: Sanitización de inputs (ANTES de rate limiting)
app.use(sanitizeRequestMiddleware);

// 🔒 SEGURIDAD: Rate limiting general
app.use(rateLimitMiddleware);

// 🔒 SEGURIDAD: Logging seguro de requests
app.use(requestLoggerMiddleware);

// Configurar sesión (necesario para Passport y CSRF)
app.use(session({
  secret: process.env.JWT_SECRET || 'pierreposteria_secret_key_2025',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // true en producción (HTTPS)
    httpOnly: true, // 🔒 Previene acceso desde JavaScript
    sameSite: 'strict', // 🔒 Protección CSRF
    maxAge: 24 * 60 * 60 * 1000 // 24 horas
  }
}));

// Inicializar Passport
app.use(passport.initialize());
app.use(passport.session());

// Health check para Render (DEBE ESTAR AL INICIO, sin middlewares de seguridad)
app.get('/api/render-health', (req, res) => {
  res.json({ 
    status: 'OK', 
    service: 'pier-reposteria-backend',
    timestamp: new Date(),
    environment: process.env.NODE_ENV 
  });
});

// 🔒 SEGURIDAD: Endpoint para obtener token CSRF
app.get('/api/csrf-token', getCSRFTokenEndpoint);

// Rutas
const authRoutes = require('./routes/authRoutes');
const googleAuthRoutes = require('./routes/googleAuthRoutes');

app.use('/api/auth', authRoutes);
app.use('/api/auth', googleAuthRoutes);

// Ruta de prueba
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: '� API de Pier Repostería funcionando correctamente',
    version: '2.0.0',
    environment: process.env.NODE_ENV,
    security: '🔒 Enhanced Security Enabled'
  });
});

// Ruta de health check
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'healthy',
    timestamp: new Date(),
    environment: process.env.NODE_ENV,
    security: {
      https: process.env.NODE_ENV === 'production',
      rateLimiting: true,
      csrfProtection: true,
      inputSanitization: true,
      securityHeaders: true
    }
  });
});

// 🔒 SEGURIDAD: Manejo de rutas no encontradas
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

// 🔒 SEGURIDAD: Manejo de errores global (sin exponer información sensible)
app.use((err, req, res, next) => {
  SecureLogger.error('Server error', err);
  
  // En producción, NO enviar detalles del error
  if (process.env.NODE_ENV === 'production') {
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor'
    });
  } else {
    // En desarrollo, enviar más detalles
    res.status(500).json({
      success: false,
      message: 'Error interno del servidor',
      error: err.message
    });
  }
});

// Puerto
const PORT = process.env.PORT || 10000;

// Función para iniciar servidor
async function startServer() {
  try {
    SecureLogger.info('Iniciando servidor...');
    
    // Conectar a MongoDB
    SecureLogger.info('Conectando a MongoDB...');
    await connectDB();
    SecureLogger.info('MongoDB conectado exitosamente');
    
    // Verificar configuración de email
    if (process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL) {
      SecureLogger.info('Verificando configuración de email...');
      const { verifyEmailConfig } = require('./services/emailServiceBrevo');
      await verifyEmailConfig();
    } else {
      SecureLogger.warn('Email no configurado (BREVO_API_KEY o BREVO_SENDER_EMAIL faltantes)');
    }
    
    // Iniciar servidor
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log('╔══════════════════════════════════════════╗');
      console.log('�  PIER REPOSTERÍA - API SERVER v2.0');
      console.log('╠══════════════════════════════════════════╣');
      console.log(`🚀  Servidor: http://0.0.0.0:${PORT}`);
      console.log(`⚙️   Ambiente: ${process.env.NODE_ENV || 'development'}`);
      console.log(`🔒  Seguridad: ACTIVADA`);
      console.log(`   ├─ Rate Limiting: ✅`);
      console.log(`   ├─ Input Sanitization: ✅`);
      console.log(`   ├─ CSRF Protection: ✅`);
      console.log(`   ├─ Security Headers: ✅`);
      console.log(`   ├─ Secure Logging: ✅`);
      console.log(`   └─ Login Attempt Blocking: ✅`);
      console.log(`📧  Google OAuth: ${process.env.GOOGLE_CLIENT_ID ? '✅' : '❌'}`);
      console.log('╚══════════════════════════════════════════╝');
    });

    // Para que Render detecte el servidor
    server.on('listening', () => {
      SecureLogger.info('Servidor activo y escuchando');
    });

    // 🔒 SEGURIDAD: Manejo de cierre graceful
    process.on('SIGTERM', () => {
      SecureLogger.info('SIGTERM recibido, cerrando servidor...');
      server.close(() => {
        SecureLogger.info('Servidor cerrado correctamente');
        process.exit(0);
      });
    });
    
  } catch (error) {
    SecureLogger.error('Error iniciando servidor', error);
    process.exit(1);
  }
}

// 🔒 SEGURIDAD: Manejo de errores no capturados
process.on('uncaughtException', (error) => {
  SecureLogger.error('Uncaught Exception', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  SecureLogger.error('Unhandled Rejection', { reason, promise });
  process.exit(1);
});

// Iniciar servidor
startServer();

module.exports = app;