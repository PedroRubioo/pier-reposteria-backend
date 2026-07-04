-- =====================================================================
-- MIGRACIÓN 004: Coordenadas GPS en direcciones de entrega
-- El cliente marca su ubicación (Geolocation API del navegador) al crear
-- la dirección; el repartidor abre Google Maps directo a las coordenadas
-- en lugar de buscar por texto. Sin APIs de pago.
-- =====================================================================

BEGIN;

ALTER TABLE core.tbldirecciones
  ADD COLUMN IF NOT EXISTS lat NUMERIC(9,6),
  ADD COLUMN IF NOT EXISTS lng NUMERIC(9,6);

COMMENT ON COLUMN core.tbldirecciones.lat IS
  'Latitud capturada con el GPS del navegador al crear/editar la dirección.';
COMMENT ON COLUMN core.tbldirecciones.lng IS
  'Longitud capturada con el GPS del navegador al crear/editar la dirección.';

COMMIT;

-- =====================================================================
-- VERIFICACIÓN POST-MIGRACIÓN
-- =====================================================================
-- SELECT column_name FROM information_schema.columns
--  WHERE table_schema = 'core' AND table_name = 'tbldirecciones'
--    AND column_name IN ('lat', 'lng');
