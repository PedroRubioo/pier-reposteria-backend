const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { getDB } = require('../config/database');
const Usuario = require('../models/Usuario');
const { ObjectId } = require('mongodb');

console.log('🔐 Inicializando Google OAuth Strategy...');
console.log('   Client ID:', process.env.GOOGLE_CLIENT_ID ? '✅ Configurado' : '❌ No configurado');
console.log('   Callback URL:', process.env.GOOGLE_CALLBACK_URL);

// Configurar estrategia de Google
passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    // 🔧 CORREGIDO: Agregar fallback si GOOGLE_CALLBACK_URL no está definida
    callbackURL: process.env.GOOGLE_CALLBACK_URL || 
                 `${process.env.BACKEND_URL || 'http://localhost:5000'}/api/auth/google/callback`,
    scope: ['profile', 'email']
  },
  async function(accessToken, refreshToken, profile, done) {
    try {
      console.log('🔄 Procesando autenticación Google para:', profile.emails[0].value);
      console.log('   Google ID:', profile.id);
      
      const db = await getDB();
      
      // Buscar si el usuario ya existe por Google ID
      let usuarioDoc = await db.collection('Usuarios').findOne({
        googleId: profile.id
      });

      if (usuarioDoc) {
        console.log('✅ Usuario existente encontrado por Google ID');
        // Usuario existe, actualizar último acceso
        await db.collection('Usuarios').updateOne(
          { _id: usuarioDoc._id },
          { $set: { ultimoAcceso: new Date() } }
        );
        
        const usuario = new Usuario(usuarioDoc);
        return done(null, usuario.toJSON());
      }

      // Buscar si existe un usuario con el mismo email
      usuarioDoc = await db.collection('Usuarios').findOne({
        email: profile.emails[0].value.toLowerCase()
      });

      if (usuarioDoc) {
        console.log('✅ Usuario existente encontrado por email, vinculando Google');
        // Usuario existe con ese email, vincular cuenta de Google
        await db.collection('Usuarios').updateOne(
          { _id: usuarioDoc._id },
          { 
            $set: { 
              googleId: profile.id,
              emailVerificado: true,
              ultimoAcceso: new Date()
            } 
          }
        );
        
        usuarioDoc.googleId = profile.id;
        usuarioDoc.emailVerificado = true;
        const usuario = new Usuario(usuarioDoc);
        return done(null, usuario.toJSON());
      }

      // Usuario nuevo, crear cuenta
      console.log('👤 Creando nuevo usuario con Google OAuth');
      const nuevoUsuario = new Usuario({
        nombre: profile.name.givenName || profile.displayName.split(' ')[0],
        apellido: profile.name.familyName || profile.displayName.split(' ').slice(1).join(' ') || 'Usuario',
        email: profile.emails[0].value,
        password: 'google-oauth-' + profile.id,
        telefono: '0000000000',
        rol: 'cliente',
        googleId: profile.id,
        emailVerificado: true,
        activo: true,
        fechaRegistro: new Date(),
        ultimoAcceso: new Date()
      });

      await nuevoUsuario.hashPassword();

      // Guardar en base de datos
      const resultado = await db.collection('Usuarios').insertOne(nuevoUsuario.toDocument());
      
      console.log('✅ Nuevo usuario registrado con Google:', profile.emails[0].value);
      
      return done(null, nuevoUsuario.toJSON());
      
    } catch (error) {
      console.error('❌ Error en Google OAuth:', error);
      return done(error, null);
    }
  }
));

// Serializar usuario para la sesión
passport.serializeUser((user, done) => {
  done(null, user._id);
});

// Deserializar usuario desde la sesión
passport.deserializeUser(async (id, done) => {
  try {
    const db = await getDB();
    const usuarioDoc = await db.collection('Usuarios').findOne({
      _id: new ObjectId(id)
    });
    
    if (!usuarioDoc) {
      return done(null, false);
    }
    
    const usuario = new Usuario(usuarioDoc);
    done(null, usuario.toJSON());
  } catch (error) {
    done(error, null);
  }
});

console.log('✅ Google OAuth Strategy configurado correctamente');

module.exports = passport;