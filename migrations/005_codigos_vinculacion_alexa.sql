-- =====================================================================
-- MIGRACIÓN 005: Códigos de vinculación de un solo uso para Alexa
-- El cliente genera un código de 6 dígitos en su perfil web (sesión
-- autenticada); se lo dice a Alexa y la skill lo canjea por un JWT.
-- Ejecutar en Neon SQL Editor de forma completa.
-- =====================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS core.tblcodigos_vinculacion_alexa (
  id          SERIAL PRIMARY KEY,
  codigo      VARCHAR(6) NOT NULL,
  usuario_id  INTEGER NOT NULL REFERENCES core.tblusuarios(id) ON DELETE CASCADE,
  device_id   VARCHAR(255),          -- se llena al canjear (qué Alexa lo usó)
  expira_en   TIMESTAMP NOT NULL,
  usado       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Búsqueda al canjear: solo códigos vigentes sin usar
CREATE INDEX IF NOT EXISTS idx_codigos_vinculacion_codigo_activo
  ON core.tblcodigos_vinculacion_alexa(codigo)
  WHERE usado = FALSE;

CREATE INDEX IF NOT EXISTS idx_codigos_vinculacion_usuario
  ON core.tblcodigos_vinculacion_alexa(usuario_id);

COMMENT ON TABLE core.tblcodigos_vinculacion_alexa IS
  'Códigos de un solo uso (5 min) para vincular la cuenta del cliente con la skill de Alexa por voz.';
COMMENT ON COLUMN core.tblcodigos_vinculacion_alexa.device_id IS
  'deviceId de la Alexa que canjeó el código (auditoría).';

COMMIT;

-- VERIFICACIÓN:
-- SELECT table_name FROM information_schema.tables
--  WHERE table_schema = 'core' AND table_name = 'tblcodigos_vinculacion_alexa';
