const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const session = require('express-session');
const { connectDB } = require('./config/database');

// Cargar variables de entorno PRIMERO
dotenv.config();

// AHORA SÍ cargar Passport (después de dotenv)
const passport = require('./config/passport');

// Crear app de Express
const app = express();


// CORS para producción
const allowedOrigins = [
  'https://pier-reposteria.vercel.app',
  'http://localhost:3000',
  'http://localhost:5173'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'CORS policy restriction';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
}));

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================
// NUEVOS MIDDLEWARES PARA GOOGLE OAUTH
// ============================================
// Configurar sesión (necesario para Passport)
app.use(session({
  secret: process.env.JWT_SECRET || 'pierreposteria_secret_key_2025',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production', // true en producción
    maxAge: 24 * 60 * 60 * 1000 // 24 horas
  }
}));

// Inicializar Passport
app.use(passport.initialize());
app.use(passport.session());
// ============================================

// Logging de requests
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Health check para Render (DEBE ESTAR AL INICIO)
app.get('/api/render-health', (req, res) => {
  res.json({ 
    status: 'OK', 
    service: 'pier-reposteria-backend',
    timestamp: new Date(),
    environment: process.env.NODE_ENV 
  });
});

// Rutas
const authRoutes = require('./routes/authRoutes');
const googleAuthRoutes = require('./routes/googleAuthRoutes'); // ← NUEVO

app.use('/api/auth', authRoutes);
app.use('/api/auth', googleAuthRoutes); // ← NUEVO - Rutas de Google OAuth

// Ruta de prueba
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: '🍰 API de Pier Repostería funcionando correctamente',
    version: '1.0.0',
    environment: process.env.NODE_ENV
  });
});

// Ruta de health check
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'healthy',
    timestamp: new Date(),
    environment: process.env.NODE_ENV
  });
});

// Manejo de rutas no encontradas
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Ruta no encontrada'
  });
});

// Manejo de errores global
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    success: false,
    message: 'Error interno del servidor'
  });
});

// Puerto
const PORT = process.env.PORT || 10000;

// Función para iniciar servidor
async function startServer() {
  try {
    console.log('🔄 Iniciando servidor...');
    
    // Conectar a MongoDB
    console.log('📦 Conectando a MongoDB...');
    await connectDB();
    console.log('✅ MongoDB conectado exitosamente');
    
    // PROBAR EMAIL
    if (process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL) {
      console.log('🧪 Probando configuración de email...');
      const { verifyEmailConfig } = require('./services/emailServiceBrevo');
      await verifyEmailConfig();
    }
    
    // Iniciar servidor
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log('═══════════════════════════════════════════');
      console.log('🍰  PIER REPOSTERÍA - API SERVER');
      console.log('═══════════════════════════════════════════');
      console.log(`🚀  Servidor corriendo en puerto ${PORT}`);
      console.log(`🌍  Host: 0.0.0.0`);
      console.log(`⚙️   Ambiente: ${process.env.NODE_ENV}`);
      console.log(`🔐  Google OAuth: ${process.env.GOOGLE_CLIENT_ID ? 'Configurado' : 'No configurado'}`); // ← NUEVO
      console.log('═══════════════════════════════════════════');
    });

    // Para que Render detecte el servidor
    server.on('listening', () => {
      console.log('✅ Servidor activo y escuchando');
    });
    
  } catch (error) {
    console.error('❌ Error iniciando servidor:', error);
    process.exit(1);
  }
}

// Iniciar servidor
startServer();

module.exports = app;