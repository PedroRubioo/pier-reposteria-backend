const SibApiV3Sdk = require('sib-api-v3-sdk');

// Configurar API client de Brevo
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;

const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

// Función para enviar email de verificación
async function sendVerificationEmail(email, codigo) {
  const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();

  sendSmtpEmail.sender = {
    name: 'Pier Repostería',
    email: process.env.BREVO_SENDER_EMAIL
  };

  sendSmtpEmail.to = [{ email: email }];
  sendSmtpEmail.subject = '🍰 Verifica tu cuenta - Pier Repostería';
  
  sendSmtpEmail.htmlContent = `
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
  `;

  try {
    console.log(`📧 Intentando enviar email de verificación a: ${email}`);
    console.log(`🔐 Código: ${codigo}`);
    console.log(`📤 Usando Brevo desde: ${process.env.BREVO_SENDER_EMAIL}`);
    
    const data = await apiInstance.sendTransacEmail(sendSmtpEmail);
    
    console.log('✅ Email de verificación enviado exitosamente');
    console.log('📨 Message ID:', data.messageId);
    
    return { 
      success: true, 
      messageId: data.messageId 
    };
    
  } catch (error) {
    console.error('❌ Error enviando email de verificación:', error.message);
    
    if (error.response) {
      console.error('🔍 Detalles del error:', error.response.body || error.response.text);
    }
    
    // Mensajes de error específicos de Brevo
    if (error.message?.includes('account_under_validation')) {
      console.error('⚠️  Tu cuenta de Brevo está en proceso de validación');
      console.error('💡 Espera a que Brevo valide tu cuenta (puede tomar unas horas)');
    } else if (error.message?.includes('unauthorized')) {
      console.error('⚠️  API Key inválida o expirada');
      console.error('💡 Verifica tu BREVO_API_KEY en el dashboard de Brevo');
    } else if (error.message?.includes('invalid_parameter')) {
      console.error('⚠️  Email del remitente no verificado en Brevo');
      console.error('💡 Verifica BREVO_SENDER_EMAIL en el dashboard de Brevo');
    }
    
    throw error;
  }
}

// Función para enviar email de recuperación de contraseña
async function sendPasswordResetEmail(email, codigo) {
  const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();

  sendSmtpEmail.sender = {
    name: 'Pier Repostería',
    email: process.env.BREVO_SENDER_EMAIL
  };

  sendSmtpEmail.to = [{ email: email }];
  sendSmtpEmail.subject = '🔐 Recuperar Contraseña - Pier Repostería';
  
  sendSmtpEmail.htmlContent = `
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
  `;

  try {
    console.log(`📧 Intentando enviar email de recuperación a: ${email}`);
    console.log(`🔐 Código: ${codigo}`);
    
    const data = await apiInstance.sendTransacEmail(sendSmtpEmail);
    
    console.log('✅ Email de recuperación enviado exitosamente');
    console.log('📨 Message ID:', data.messageId);
    
    return { 
      success: true, 
      messageId: data.messageId 
    };
    
  } catch (error) {
    console.error('❌ Error enviando email de recuperación:', error.message);
    
    if (error.response) {
      console.error('🔍 Detalles del error:', error.response.body || error.response.text);
    }
    
    throw error;
  }
}

// Función para verificar configuración del servicio
async function verifyEmailConfig() {
  try {
    console.log('🧪 Verificando configuración de Brevo...');
    console.log('🔑 API Key:', process.env.BREVO_API_KEY ? '✅ Configurada' : '❌ No configurada');
    console.log('📧 Sender Email:', process.env.BREVO_SENDER_EMAIL ? '✅ Configurado' : '❌ No configurado');
    
    if (!process.env.BREVO_API_KEY) {
      console.error('❌ BREVO_API_KEY no está configurada');
      return false;
    }
    
    if (!process.env.BREVO_SENDER_EMAIL) {
      console.error('❌ BREVO_SENDER_EMAIL no está configurado');
      return false;
    }
    
    console.log('✅ Configuración de Brevo lista');
    console.log('🌐 Servicio: Brevo (Sendinblue)');
    return true;
    
  } catch (error) {
    console.error('❌ Error en configuración de Brevo:', error.message);
    return false;
  }
}

module.exports = {
  sendVerificationEmail,
  sendPasswordResetEmail,
  verifyEmailConfig
};