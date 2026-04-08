const nodemailer = require('nodemailer');

// Configuración del transportador de email CORREGIDA para Render
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com', // Especificar host directamente
  port: 587, // Puerto 587 con STARTTLS (funciona mejor en Render)
  secure: false, // false para port 587, true para 465
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  },
  // Configuración adicional para Render
  connectionTimeout: 30000, // 30 segundos
  greetingTimeout: 30000,
  socketTimeout: 30000,
  requireTLS: true, // Forzar TLS
  tls: {
    // 🔒 SEGURIDAD: En producción se valida el certificado TLS.
    // En desarrollo/CI se permite false para compatibilidad con servidores SMTP locales.
    rejectUnauthorized: process.env.NODE_ENV === 'production' ? true : false
  },
  debug: true // Para ver logs detallados
});

// Función para enviar email de verificación
async function sendVerificationEmail(email, codigo) {
  const mailOptions = {
    from: {
      name: 'Pier Repostería',
      address: process.env.EMAIL_USER
    },
    to: email,
    subject: '🍰 Verifica tu cuenta - Pier Repostería',
    text: `Tu código de verificación es: ${codigo}. Este código expirará en 24 horas.`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6; 
            color: #333;
            margin: 0;
            padding: 0;
            background-color: #f4f4f4;
          }
          .container { 
            max-width: 600px; 
            margin: 20px auto;
            background-color: #ffffff;
            border-radius: 8px;
            overflow: hidden;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          .header { 
            background: linear-gradient(135deg, #2c5f2d 0%, #1e4620 100%);
            color: white; 
            padding: 30px 20px; 
            text-align: center;
          }
          .header h1 {
            margin: 0;
            font-size: 28px;
            font-weight: 600;
          }
          .content { 
            padding: 40px 30px;
            background-color: #ffffff;
          }
          .code-box { 
            background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%);
            border: 2px solid #2c5f2d;
            padding: 25px; 
            text-align: center; 
            margin: 30px 0;
            border-radius: 8px;
          }
          .code { 
            font-size: 36px; 
            font-weight: bold; 
            color: #2c5f2d; 
            letter-spacing: 8px;
            font-family: 'Courier New', monospace;
          }
          .info-text {
            color: #666;
            font-size: 14px;
            margin-top: 15px;
          }
          .footer { 
            text-align: center; 
            padding: 20px;
            background-color: #f8f9fa;
            color: #6c757d;
            font-size: 12px;
            border-top: 1px solid #dee2e6;
          }
          .warning {
            background-color: #fff3cd;
            border-left: 4px solid #ffc107;
            padding: 15px;
            margin: 20px 0;
            border-radius: 4px;
            font-size: 14px;
          }
          @media only screen and (max-width: 600px) {
            .container {
              margin: 0;
              border-radius: 0;
            }
            .content {
              padding: 30px 20px;
            }
            .code {
              font-size: 28px;
              letter-spacing: 6px;
            }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🍰 Pier Repostería</h1>
          </div>
          <div class="content">
            <h2 style="color: #2c5f2d; margin-top: 0;">¡Bienvenido a Pier Repostería!</h2>
            <p>Gracias por registrarte. Para completar tu registro y comenzar a disfrutar de nuestros servicios, por favor verifica tu correo electrónico.</p>
            
            <p style="margin-top: 25px;"><strong>Tu código de verificación es:</strong></p>
            <div class="code-box">
              <div class="code">${codigo}</div>
              <div class="info-text">Ingresa este código en la aplicación</div>
            </div>
            
            <div class="warning">
              <strong>⏰ Importante:</strong> Este código expirará en <strong>24 horas</strong>. Si no solicitaste este registro, puedes ignorar este correo de forma segura.
            </div>
            
            <p style="color: #666; font-size: 14px; margin-top: 30px;">
              Si tienes alguna pregunta o necesitas ayuda, no dudes en contactarnos.
            </p>
          </div>
          <div class="footer">
            <p style="margin: 5px 0;">© ${new Date().getFullYear()} Pier Repostería - Todos los derechos reservados</p>
            <p style="margin: 5px 0;">Este es un correo automático, por favor no respondas a este mensaje.</p>
          </div>
        </div>
      </body>
      </html>
    `
  };

  try {
    console.log(`📧 Intentando enviar email a: ${email}`);
    console.log(`🔑 Código: ${codigo}`);
    
    const info = await transporter.sendMail(mailOptions);
    console.log('✅ Email de verificación enviado:', info.messageId);
    console.log('📨 Respuesta:', info.response);
    return { success: true, messageId: info.messageId, response: info.response };
  } catch (error) {
    console.error('❌ Error enviando email de verificación:', error.message);
    console.error('🔧 Detalles técnicos:', {
      code: error.code,
      command: error.command
    });
    throw error;
  }
}

// Función para enviar email de recuperación de contraseña
async function sendPasswordResetEmail(email, codigo) {
  const mailOptions = {
    from: {
      name: 'Pier Repostería',
      address: process.env.EMAIL_USER
    },
    to: email,
    subject: '🔐 Recuperar Contraseña - Pier Repostería',
    text: `Tu código de recuperación es: ${codigo}. Este código expirará en 15 minutos.`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6; 
            color: #333;
            margin: 0;
            padding: 0;
            background-color: #f4f4f4;
          }
          .container { 
            max-width: 600px; 
            margin: 20px auto;
            background-color: #ffffff;
            border-radius: 8px;
            overflow: hidden;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          .header { 
            background: linear-gradient(135deg, #dc3545 0%, #c82333 100%);
            color: white; 
            padding: 30px 20px; 
            text-align: center;
          }
          .header h1 {
            margin: 0;
            font-size: 28px;
            font-weight: 600;
          }
          .content { 
            padding: 40px 30px;
            background-color: #ffffff;
          }
          .code-box { 
            background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%);
            border: 2px solid #dc3545;
            padding: 25px; 
            text-align: center; 
            margin: 30px 0;
            border-radius: 8px;
          }
          .code { 
            font-size: 36px; 
            font-weight: bold; 
            color: #dc3545; 
            letter-spacing: 8px;
            font-family: 'Courier New', monospace;
          }
          .info-text {
            color: #666;
            font-size: 14px;
            margin-top: 15px;
          }
          .footer { 
            text-align: center; 
            padding: 20px;
            background-color: #f8f9fa;
            color: #6c757d;
            font-size: 12px;
            border-top: 1px solid #dee2e6;
          }
          .warning {
            background-color: #fff3cd;
            border-left: 4px solid #ffc107;
            padding: 15px;
            margin: 20px 0;
            border-radius: 4px;
            font-size: 14px;
          }
          .security-notice {
            background-color: #f8d7da;
            border-left: 4px solid #dc3545;
            padding: 15px;
            margin: 20px 0;
            border-radius: 4px;
            font-size: 14px;
          }
          @media only screen and (max-width: 600px) {
            .container {
              margin: 0;
              border-radius: 0;
            }
            .content {
              padding: 30px 20px;
            }
            .code {
              font-size: 28px;
              letter-spacing: 6px;
            }
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🔐 Recuperación de Contraseña</h1>
          </div>
          <div class="content">
            <h2 style="color: #dc3545; margin-top: 0;">Restablecer tu contraseña</h2>
            <p>Recibimos una solicitud para restablecer la contraseña de tu cuenta en Pier Repostería.</p>
            
            <p style="margin-top: 25px;"><strong>Tu código de recuperación es:</strong></p>
            <div class="code-box">
              <div class="code">${codigo}</div>
              <div class="info-text">Ingresa este código en la aplicación</div>
            </div>
            
            <div class="warning">
              <strong>⏰ Urgente:</strong> Este código expirará en <strong>15 minutos</strong> por motivos de seguridad.
            </div>
            
            <div class="security-notice">
              <strong>⚠️ Importante:</strong> Si NO solicitaste este cambio, ignora este correo. Tu contraseña permanecerá segura y sin cambios. Considera cambiar tu contraseña si sospechas que alguien más está intentando acceder a tu cuenta.
            </div>
          </div>
          <div class="footer">
            <p style="margin: 5px 0;">© ${new Date().getFullYear()} Pier Repostería - Todos los derechos reservados</p>
            <p style="margin: 5px 0;">Este es un correo automático, por favor no respondas a este mensaje.</p>
          </div>
        </div>
      </body>
      </html>
    `
  };

  try {
    console.log(`📧 Intentando enviar email de recuperación a: ${email}`);
    const info = await transporter.sendMail(mailOptions);
    console.log('✅ Email de recuperación enviado:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('❌ Error enviando email de recuperación:', error.message);
    throw error;
  }
}

// Función para verificar configuración del servicio MEJORADA
async function verifyEmailConfig() {
  try {
    console.log('🧪 Verificando configuración de email...');
    console.log('📧 Usuario:', process.env.EMAIL_USER ? '✅ Configurado' : '❌ No configurado');
    console.log('🔑 Contraseña:', process.env.EMAIL_PASSWORD ? '✅ Configurada' : '❌ No configurada');
    
    await transporter.verify();
    console.log('✅ Configuración de email verificada correctamente');
    console.log('🖥️ Servidor: smtp.gmail.com:587');
    return true;
  } catch (error) {
    console.error('❌ Error en configuración de email:', error.message);
    console.error('🔧 Código de error:', error.code);
    
    if (error.code === 'EAUTH') {
      console.error('👤 Problema de autenticación: Verifica EMAIL_USER y EMAIL_PASSWORD');
    } else if (error.code === 'ECONNECTION') {
      console.error('🌐 Problema de conexión: Render puede estar bloqueando el puerto');
    }
    
    return false;
  }
}

module.exports = {
  sendVerificationEmail,
  sendPasswordResetEmail,
  verifyEmailConfig
};