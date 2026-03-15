// config/passport.js
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { pool } = require('./database'); // ✅ Cambiado a PostgreSQL
const Usuario = require('../models/Usuario');

console.log('🔐 Inicializando Google OAuth Strategy...');
console.log('   Client ID:', process.env.GOOGLE_CLIENT_ID ? '✅ Configurado' : '❌ No configurado');
console.log('   Callback URL:', process.env.GOOGLE_CALLBACK_URL);

// Configurar estrategia de Google
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL || 
                 `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/auth/google/callback`,
    scope: ['profile', 'email']
  },
  async function(accessToken, refreshToken, profile, done) {
    try {
      console.log('🔄 Procesando autenticación Google para:', profile.emails[0].value);
      console.log('   Google ID:', profile.id);
      
      // Buscar si el usuario ya existe por Google ID
      let result = await pool.query(
        'SELECT * FROM core.tblusuarios WHERE google_id = $1',
        [profile.id]
      );
      
      let usuarioDoc = result.rows[0];

      if (usuarioDoc) {
        console.log('✅ Usuario existente encontrado por Google ID');
        
        // Usuario existe, actualizar último acceso
        await pool.query(
          'UPDATE core.tblusuarios SET ultimo_acceso = NOW() WHERE id = $1',
          [usuarioDoc.id]
        );
        
        const usuario = new Usuario(usuarioDoc);
        return done(null, usuario.toJSON());
      }

      // Buscar si existe un usuario con el mismo email
      result = await pool.query(
        'SELECT * FROM core.tblusuarios WHERE email = $1',
        [profile.emails[0].value.toLowerCase()]
      );
      
      usuarioDoc = result.rows[0];

      if (usuarioDoc) {
        console.log('✅ Usuario existente encontrado por email, vinculando Google');
        
        // Usuario existe con ese email, vincular cuenta de Google
        await pool.query(
          'UPDATE core.tblusuarios SET google_id = $1, email_verificado = true, ultimo_acceso = NOW() WHERE id = $2',
          [profile.id, usuarioDoc.id]
        );
        
        usuarioDoc.google_id = profile.id;
        const usuario = new Usuario(usuarioDoc);
        return done(null, usuario.toJSON());
      }

      // Usuario nuevo, crear cuenta
      console.log('👤 Creando nuevo usuario con Google OAuth');
      
      // Crear usuario temporal para hashear contraseña
      const tempUsuario = {
        nombre: profile.name.givenName || profile.displayName.split(' ')[0],
        apellido: profile.name.familyName || profile.displayName.split(' ').slice(1).join(' ') || 'Usuario',
        email: profile.emails[0].value,
        password: 'google-oauth-' + profile.id,
        telefono: '0000000000'
      };
      
      const password_hash = await Usuario.hashPassword(tempUsuario.password);
      
      // Insertar en PostgreSQL
      const insertResult = await pool.query(
        `INSERT INTO core.tblusuarios 
         (nombre, apellido, email, password_hash, telefono, rol, activo, email_verificado, google_id, created_at, updated_at, ultimo_acceso)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW(), NOW())
         RETURNING *`,
        [
          tempUsuario.nombre,
          tempUsuario.apellido,
          tempUsuario.email.toLowerCase(),
          password_hash,
          tempUsuario.telefono,
          'cliente',
          true,
          true,
          profile.id
        ]
      );
      
      const nuevoUsuario = insertResult.rows[0];
      
      console.log('✅ Nuevo usuario registrado con Google:', profile.emails[0].value);
      
      const usuario = new Usuario(nuevoUsuario);
      return done(null, usuario.toJSON());
      
    } catch (error) {
      console.error('❌ Error en Google OAuth:', error);
      return done(error, null);
    }
  }
));

// Serializar usuario para la sesión (guardar solo el ID)
passport.serializeUser((user, done) => {
  done(null, user.id);
});

// Deserializar usuario desde la sesión
passport.deserializeUser(async (id, done) => {
  try {
    const result = await pool.query(
      'SELECT * FROM core.tblusuarios WHERE id = $1',
      [id]
    );
    
    const usuarioDoc = result.rows[0];
    
    if (!usuarioDoc) {
      return done(null, false);
    }
    
    const usuario = new Usuario(usuarioDoc);
    done(null, usuario.toJSON());
  } catch (error) {
    done(error, null);
  }
});

console.log('✅ Google OAuth Strategy configurado correctamente (PostgreSQL)');

module.exports = passport;