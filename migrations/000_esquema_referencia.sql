-- =====================================================================
-- ESQUEMA DE REFERENCIA (generado desde backup_pier_2026-07-02.dump)
-- Solo documentacion: NO ejecutar. La BD viva en Neon es la fuente.
-- Regenerar con:
--   pg_restore --schema-only --no-owner --no-privileges -f este_archivo.sql backup.dump
-- Incluye: enums en public, esquema core (tablas), reports (vistas), staging.
-- NOTA: generado ANTES de la migracion 002 (los enums rol_usuario,
-- estado_pedido y tipo_notificacion ya tienen valores extra en la BD viva).
-- =====================================================================
--
-- PostgreSQL database dump
--

\restrict Aq5bT4eVjSG8HgHBWUOFHB2AHJkzlOa77FH5a0j0BxrQNCziG5uq5VjE5quM9ej

-- Dumped from database version 17.10 (9f6157c)
-- Dumped by pg_dump version 18.1

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: core; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA core;


--
-- Name: reports; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA reports;


--
-- Name: staging; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA staging;


--
-- Name: audiencia_notificacion; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.audiencia_notificacion AS ENUM (
    'todos',
    'grupo',
    'individual'
);


--
-- Name: categoria_queja; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.categoria_queja AS ENUM (
    'producto',
    'servicio',
    'plataforma',
    'otro'
);


--
-- Name: estado_envio; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.estado_envio AS ENUM (
    'enviada',
    'programada',
    'borrador'
);


--
-- Name: estado_pago; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.estado_pago AS ENUM (
    'pendiente',
    'pagado',
    'fallido',
    'reembolsado'
);


--
-- Name: estado_pedido; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.estado_pedido AS ENUM (
    'pendiente',
    'en_preparacion',
    'listo',
    'completado',
    'cancelado',
    'asignado',
    'en_camino',
    'entregado',
    'entrega_fallida'
);


--
-- Name: estado_promocion; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.estado_promocion AS ENUM (
    'activa',
    'programada',
    'vencida',
    'pausada'
);


--
-- Name: estado_queja; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.estado_queja AS ENUM (
    'pendiente',
    'en_proceso',
    'resuelto'
);


--
-- Name: estado_reembolso; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.estado_reembolso AS ENUM (
    'pendiente',
    'en_revision',
    'aprobado',
    'rechazado',
    'procesado'
);


--
-- Name: estado_resena; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.estado_resena AS ENUM (
    'pendiente',
    'aprobada',
    'rechazada'
);


--
-- Name: motivo_reembolso; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.motivo_reembolso AS ENUM (
    'producto_danado',
    'no_satisfecho',
    'pedido_incorrecto',
    'tardanza',
    'cantidad_incorrecta',
    'otro'
);


--
-- Name: prioridad_queja; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.prioridad_queja AS ENUM (
    'alta',
    'media',
    'baja'
);


--
-- Name: rol_usuario; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.rol_usuario AS ENUM (
    'cliente',
    'empleado',
    'gerencia',
    'direccion_general',
    'repartidor'
);


--
-- Name: tipo_banner; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.tipo_banner AS ENUM (
    'hero',
    'lateral',
    'footer'
);


--
-- Name: tipo_codigo; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.tipo_codigo AS ENUM (
    'registro',
    'recuperacion'
);


--
-- Name: tipo_notificacion; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.tipo_notificacion AS ENUM (
    'pedido',
    'pago',
    'promocion',
    'sistema',
    'aviso',
    'recordatorio',
    'personalizada',
    'alerta'
);


--
-- Name: tipo_promocion; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.tipo_promocion AS ENUM (
    'nuevo',
    'relampago',
    'temporada',
    'destacado',
    'banner'
);


--
-- Name: tipo_queja; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.tipo_queja AS ENUM (
    'queja',
    'sugerencia',
    'comentario'
);


--
-- Name: fn_actualizar_updated_at(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.fn_actualizar_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: tblauditoria; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.tblauditoria (
    id integer NOT NULL,
    usuario_id integer,
    accion character varying(200) NOT NULL,
    entidad character varying(100),
    entidad_id integer,
    detalles jsonb,
    ip character varying(45),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tblauditoria_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

CREATE SEQUENCE core.tblauditoria_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tblauditoria_id_seq; Type: SEQUENCE OWNED BY; Schema: core; Owner: -
--

ALTER SEQUENCE core.tblauditoria_id_seq OWNED BY core.tblauditoria.id;


--
-- Name: tblcarrito_items; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.tblcarrito_items (
    id integer NOT NULL,
    usuario_id integer NOT NULL,
    producto_id integer NOT NULL,
    tamano character varying(20),
    cantidad integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT chk_carrito_items_cantidad CHECK (((cantidad > 0) AND (cantidad <= 100)))
);


--
-- Name: tblcarrito_items_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

CREATE SEQUENCE core.tblcarrito_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tblcarrito_items_id_seq; Type: SEQUENCE OWNED BY; Schema: core; Owner: -
--

ALTER SEQUENCE core.tblcarrito_items_id_seq OWNED BY core.tblcarrito_items.id;


--
-- Name: tblcategoria_opciones; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.tblcategoria_opciones (
    id integer NOT NULL,
    categoria_id integer NOT NULL,
    tipo_opcion character varying(10) NOT NULL,
    nombre character varying(100) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tblcategoria_opciones_tipo_opcion_check CHECK (((tipo_opcion)::text = ANY ((ARRAY['tipo'::character varying, 'sabor'::character varying])::text[])))
);


--
-- Name: tblcategoria_opciones_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

CREATE SEQUENCE core.tblcategoria_opciones_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tblcategoria_opciones_id_seq; Type: SEQUENCE OWNED BY; Schema: core; Owner: -
--

ALTER SEQUENCE core.tblcategoria_opciones_id_seq OWNED BY core.tblcategoria_opciones.id;


--
-- Name: tblcategorias; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.tblcategorias (
    id integer NOT NULL,
    nombre character varying(100) NOT NULL,
    descripcion text,
    imagen_url character varying(500),
    orden integer DEFAULT 0 NOT NULL,
    activo boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    imagen_public_id character varying(255)
);


--
-- Name: tblcategorias_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

CREATE SEQUENCE core.tblcategorias_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tblcategorias_id_seq; Type: SEQUENCE OWNED BY; Schema: core; Owner: -
--

ALTER SEQUENCE core.tblcategorias_id_seq OWNED BY core.tblcategorias.id;


--
-- Name: tblcodigos_verificacion; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.tblcodigos_verificacion (
    id integer NOT NULL,
    usuario_id integer,
    email character varying(255) NOT NULL,
    codigo character varying(10) NOT NULL,
    tipo public.tipo_codigo NOT NULL,
    usado boolean DEFAULT false NOT NULL,
    expira_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tblcodigos_verificacion_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

CREATE SEQUENCE core.tblcodigos_verificacion_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tblcodigos_verificacion_id_seq; Type: SEQUENCE OWNED BY; Schema: core; Owner: -
--

ALTER SEQUENCE core.tblcodigos_verificacion_id_seq OWNED BY core.tblcodigos_verificacion.id;


--
-- Name: tblconfiguracion_sistema; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.tblconfiguracion_sistema (
    id integer NOT NULL,
    seccion character varying(50) NOT NULL,
    clave character varying(100) NOT NULL,
    valor jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by integer
);


--
-- Name: tblconfiguracion_sistema_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

CREATE SEQUENCE core.tblconfiguracion_sistema_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tblconfiguracion_sistema_id_seq; Type: SEQUENCE OWNED BY; Schema: core; Owner: -
--

ALTER SEQUENCE core.tblconfiguracion_sistema_id_seq OWNED BY core.tblconfiguracion_sistema.id;


--
-- Name: tblcontacto_mensajes; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.tblcontacto_mensajes (
    id integer NOT NULL,
    nombre character varying(200) NOT NULL,
    email character varying(255) NOT NULL,
    telefono character varying(15),
    tipo_producto character varying(100),
    mensaje text NOT NULL,
    leido boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tblcontacto_mensajes_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

CREATE SEQUENCE core.tblcontacto_mensajes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tblcontacto_mensajes_id_seq; Type: SEQUENCE OWNED BY; Schema: core; Owner: -
--

ALTER SEQUENCE core.tblcontacto_mensajes_id_seq OWNED BY core.tblcontacto_mensajes.id;


--
-- Name: tbldirecciones; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.tbldirecciones (
    id integer NOT NULL,
    usuario_id integer NOT NULL,
    alias character varying(50) NOT NULL,
    calle_numero character varying(150) NOT NULL,
    colonia character varying(120) NOT NULL,
    referencias text,
    telefono_contacto character varying(20),
    activa boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE tbldirecciones; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON TABLE core.tbldirecciones IS 'Libreta de direcciones de entrega del cliente.';


--
-- Name: tbldirecciones_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

CREATE SEQUENCE core.tbldirecciones_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbldirecciones_id_seq; Type: SEQUENCE OWNED BY; Schema: core; Owner: -
--

ALTER SEQUENCE core.tbldirecciones_id_seq OWNED BY core.tbldirecciones.id;


--
-- Name: tblentregas; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.tblentregas (
    id integer NOT NULL,
    pedido_id integer NOT NULL,
    repartidor_id integer NOT NULL,
    estado character varying(20) DEFAULT 'asignada'::character varying NOT NULL,
    asignado_por integer,
    asignado_at timestamp without time zone DEFAULT now() NOT NULL,
    salio_at timestamp without time zone,
    finalizado_at timestamp without time zone,
    evidencia_url text,
    recibio_nombre character varying(100),
    motivo_fallo text,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT tblentregas_estado_check CHECK (((estado)::text = ANY ((ARRAY['asignada'::character varying, 'en_camino'::character varying, 'entregada'::character varying, 'fallida'::character varying])::text[])))
);


--
-- Name: TABLE tblentregas; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON TABLE core.tblentregas IS 'Asignaciones de pedidos a repartidores con evidencia de entrega.';


--
-- Name: tblentregas_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

CREATE SEQUENCE core.tblentregas_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tblentregas_id_seq; Type: SEQUENCE OWNED BY; Schema: core; Owner: -
--

ALTER SEQUENCE core.tblentregas_id_seq OWNED BY core.tblentregas.id;


--
-- Name: tblfavoritos; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.tblfavoritos (
    id integer NOT NULL,
    usuario_id integer NOT NULL,
    producto_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tblfavoritos_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

CREATE SEQUENCE core.tblfavoritos_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tblfavoritos_id_seq; Type: SEQUENCE OWNED BY; Schema: core; Owner: -
--

ALTER SEQUENCE core.tblfavoritos_id_seq OWNED BY core.tblfavoritos.id;


--
-- Name: tbllogin_intentos_voz; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.tbllogin_intentos_voz (
    id integer NOT NULL,
    device_id character varying(255) NOT NULL,
    codigo_empleado integer,
    exito boolean NOT NULL,
    motivo_fallo character varying(100),
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE tbllogin_intentos_voz; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON TABLE core.tbllogin_intentos_voz IS 'AuditorÃ­a de intentos de login por voz para empleados (forense + rate limiting).';


--
-- Name: tbllogin_intentos_voz_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

CREATE SEQUENCE core.tbllogin_intentos_voz_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbllogin_intentos_voz_id_seq; Type: SEQUENCE OWNED BY; Schema: core; Owner: -
--

ALTER SEQUENCE core.tbllogin_intentos_voz_id_seq OWNED BY core.tbllogin_intentos_voz.id;


--
-- Name: tblnotificaciones; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.tblnotificaciones (
    id integer NOT NULL,
    usuario_id integer NOT NULL,
    tipo public.tipo_notificacion NOT NULL,
    titulo character varying(200) NOT NULL,
    mensaje text NOT NULL,
    leida boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tblnotificaciones_envios; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.tblnotificaciones_envios (
    id integer NOT NULL,
    enviado_por integer,
    tipo public.tipo_notificacion NOT NULL,
    titulo character varying(200) NOT NULL,
    mensaje text NOT NULL,
    audiencia public.audiencia_notificacion NOT NULL,
    total_enviados integer DEFAULT 0 NOT NULL,
    programada boolean DEFAULT false NOT NULL,
    fecha_envio timestamp with time zone,
    estado public.estado_envio DEFAULT 'borrador'::public.estado_envio NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tblnotificaciones_envios_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

CREATE SEQUENCE core.tblnotificaciones_envios_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tblnotificaciones_envios_id_seq; Type: SEQUENCE OWNED BY; Schema: core; Owner: -
--

ALTER SEQUENCE core.tblnotificaciones_envios_id_seq OWNED BY core.tblnotificaciones_envios.id;


--
-- Name: tblnotificaciones_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

CREATE SEQUENCE core.tblnotificaciones_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tblnotificaciones_id_seq; Type: SEQUENCE OWNED BY; Schema: core; Owner: -
--

ALTER SEQUENCE core.tblnotificaciones_id_seq OWNED BY core.tblnotificaciones.id;


--
-- Name: tbloauth_codes; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.tbloauth_codes (
    id integer NOT NULL,
    code character varying(64) NOT NULL,
    usuario_id integer NOT NULL,
    client_id character varying(50) NOT NULL,
    redirect_uri text NOT NULL,
    state text,
    expira_en timestamp without time zone NOT NULL,
    usado boolean DEFAULT false NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE tbloauth_codes; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON TABLE core.tbloauth_codes IS 'CÃ³digos OAuth temporales (5 min) para Account Linking de Alexa (Authorization Code Grant).';


--
-- Name: tbloauth_codes_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

CREATE SEQUENCE core.tbloauth_codes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbloauth_codes_id_seq; Type: SEQUENCE OWNED BY; Schema: core; Owner: -
--

ALTER SEQUENCE core.tbloauth_codes_id_seq OWNED BY core.tbloauth_codes.id;


--
-- Name: tblpagos; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.tblpagos (
    id integer NOT NULL,
    pedido_id integer NOT NULL,
    stripe_payment_id character varying(255),
    metodo_pago character varying(50),
    monto_subtotal numeric(10,2),
    descuento numeric(10,2) DEFAULT 0 NOT NULL,
    monto_total numeric(10,2) NOT NULL,
    estado public.estado_pago DEFAULT 'pendiente'::public.estado_pago NOT NULL,
    codigo_descuento character varying(50),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    reembolsado_at timestamp with time zone,
    fecha_confirmacion_pago timestamp with time zone
);


--
-- Name: COLUMN tblpagos.fecha_confirmacion_pago; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON COLUMN core.tblpagos.fecha_confirmacion_pago IS 'Timestamp de confirmaciÃ³n de Stripe. Ãštil para mÃ©tricas de conversiÃ³n y tiempo pagoâ†’preparaciÃ³n.';


--
-- Name: tblpagos_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

CREATE SEQUENCE core.tblpagos_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tblpagos_id_seq; Type: SEQUENCE OWNED BY; Schema: core; Owner: -
--

ALTER SEQUENCE core.tblpagos_id_seq OWNED BY core.tblpagos.id;


--
-- Name: tblpedido_items; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.tblpedido_items (
    id integer NOT NULL,
    pedido_id integer NOT NULL,
    producto_id integer,
    nombre_producto character varying(200) NOT NULL,
    cantidad integer NOT NULL,
    tamano character varying(20),
    precio_unitario numeric(10,2) NOT NULL,
    subtotal numeric(10,2) NOT NULL,
    CONSTRAINT chk_pedido_items_cantidad CHECK (((cantidad > 0) AND (cantidad <= 100)))
);


--
-- Name: tblpedido_items_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

CREATE SEQUENCE core.tblpedido_items_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tblpedido_items_id_seq; Type: SEQUENCE OWNED BY; Schema: core; Owner: -
--

ALTER SEQUENCE core.tblpedido_items_id_seq OWNED BY core.tblpedido_items.id;


--
-- Name: tblpedidos; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.tblpedidos (
    id integer NOT NULL,
    numero character varying(20) NOT NULL,
    usuario_id integer NOT NULL,
    total numeric(10,2) NOT NULL,
    estado public.estado_pedido DEFAULT 'pendiente'::public.estado_pedido NOT NULL,
    notas text,
    nota_cancelacion text,
    horario_recogida timestamp with time zone,
    metodo_pago character varying(50),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    tipo_entrega character varying(20) DEFAULT 'pickup'::character varying NOT NULL,
    costo_envio numeric(10,2) DEFAULT 0 NOT NULL,
    direccion_entrega jsonb,
    horario_entrega timestamp without time zone,
    CONSTRAINT chk_tblpedidos_tipo_entrega CHECK (((tipo_entrega)::text = ANY ((ARRAY['pickup'::character varying, 'domicilio'::character varying])::text[])))
);


--
-- Name: COLUMN tblpedidos.direccion_entrega; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON COLUMN core.tblpedidos.direccion_entrega IS 'Snapshot JSONB de la direcciÃ³n al momento de la compra; inmutable ante cambios en tbldirecciones.';


--
-- Name: tblpedidos_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

CREATE SEQUENCE core.tblpedidos_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tblpedidos_id_seq; Type: SEQUENCE OWNED BY; Schema: core; Owner: -
--

ALTER SEQUENCE core.tblpedidos_id_seq OWNED BY core.tblpedidos.id;


--
-- Name: tblproductos; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.tblproductos (
    id integer NOT NULL,
    nombre character varying(200) NOT NULL,
    descripcion text,
    categoria_id integer NOT NULL,
    precio_chico numeric(10,2) NOT NULL,
    precio_grande numeric(10,2),
    imagen_url character varying(500),
    ingredientes text[],
    sabor character varying(50),
    tamano character varying(20),
    tipo character varying(50),
    popular boolean DEFAULT false NOT NULL,
    activo boolean DEFAULT true NOT NULL,
    es_nuevo boolean DEFAULT false NOT NULL,
    fecha_nuevo_expira timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    imagen_public_id character varying(255),
    imagenes jsonb,
    stock_online integer DEFAULT 0 NOT NULL
);


--
-- Name: tblproductos_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

CREATE SEQUENCE core.tblproductos_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tblproductos_id_seq; Type: SEQUENCE OWNED BY; Schema: core; Owner: -
--

ALTER SEQUENCE core.tblproductos_id_seq OWNED BY core.tblproductos.id;


--
-- Name: tblpromociones; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.tblpromociones (
    id integer NOT NULL,
    tipo public.tipo_promocion NOT NULL,
    producto_id integer,
    estado public.estado_promocion DEFAULT 'activa'::public.estado_promocion NOT NULL,
    descuento_porcentaje numeric(5,2),
    precio_original numeric(10,2),
    precio_oferta numeric(10,2),
    fecha_inicio timestamp with time zone,
    fecha_fin timestamp with time zone,
    nombre_temporada character varying(100),
    badge_destacado character varying(20),
    titulo_banner character varying(200),
    subtitulo_banner character varying(200),
    descripcion_banner text,
    codigo_descuento character varying(50),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tblpromociones_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

CREATE SEQUENCE core.tblpromociones_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tblpromociones_id_seq; Type: SEQUENCE OWNED BY; Schema: core; Owner: -
--

ALTER SEQUENCE core.tblpromociones_id_seq OWNED BY core.tblpromociones.id;


--
-- Name: tblquejas; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.tblquejas (
    id integer NOT NULL,
    ticket character varying(20) NOT NULL,
    usuario_id integer NOT NULL,
    pedido_id integer,
    tipo public.tipo_queja NOT NULL,
    categoria public.categoria_queja NOT NULL,
    asunto character varying(200) NOT NULL,
    descripcion text NOT NULL,
    prioridad public.prioridad_queja DEFAULT 'media'::public.prioridad_queja NOT NULL,
    estado public.estado_queja DEFAULT 'pendiente'::public.estado_queja NOT NULL,
    respuesta text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tblquejas_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

CREATE SEQUENCE core.tblquejas_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tblquejas_id_seq; Type: SEQUENCE OWNED BY; Schema: core; Owner: -
--

ALTER SEQUENCE core.tblquejas_id_seq OWNED BY core.tblquejas.id;


--
-- Name: tblreembolsos; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.tblreembolsos (
    id integer NOT NULL,
    pedido_id integer NOT NULL,
    producto_id integer,
    usuario_id integer NOT NULL,
    monto numeric(10,2) NOT NULL,
    motivo public.motivo_reembolso NOT NULL,
    descripcion text,
    fotos_evidencia text[],
    estado public.estado_reembolso DEFAULT 'pendiente'::public.estado_reembolso NOT NULL,
    justificacion_rechazo text,
    respuesta_admin text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    fecha_resolucion timestamp with time zone
);


--
-- Name: COLUMN tblreembolsos.fotos_evidencia; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON COLUMN core.tblreembolsos.fotos_evidencia IS 'TEXT[] (no JSONB) intencional: evidencia legal que nunca debe borrarse de Cloudinary. Sin public_id para evitar borrado accidental.';


--
-- Name: tblreembolsos_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

CREATE SEQUENCE core.tblreembolsos_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tblreembolsos_id_seq; Type: SEQUENCE OWNED BY; Schema: core; Owner: -
--

ALTER SEQUENCE core.tblreembolsos_id_seq OWNED BY core.tblreembolsos.id;


--
-- Name: tblresena_likes; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.tblresena_likes (
    id integer NOT NULL,
    resena_id integer NOT NULL,
    usuario_id integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tblresena_likes_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

CREATE SEQUENCE core.tblresena_likes_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tblresena_likes_id_seq; Type: SEQUENCE OWNED BY; Schema: core; Owner: -
--

ALTER SEQUENCE core.tblresena_likes_id_seq OWNED BY core.tblresena_likes.id;


--
-- Name: tblresenas; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.tblresenas (
    id integer NOT NULL,
    producto_id integer NOT NULL,
    usuario_id integer NOT NULL,
    rating smallint NOT NULL,
    titulo character varying(100),
    comentario text NOT NULL,
    respuesta_negocio text,
    estado public.estado_resena DEFAULT 'pendiente'::public.estado_resena NOT NULL,
    motivo_rechazo text,
    auto_aprobada boolean DEFAULT false NOT NULL,
    verificada boolean DEFAULT false NOT NULL,
    util_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    fotos jsonb,
    CONSTRAINT tblresenas_rating_check CHECK (((rating >= 1) AND (rating <= 5)))
);


--
-- Name: tblresenas_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

CREATE SEQUENCE core.tblresenas_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tblresenas_id_seq; Type: SEQUENCE OWNED BY; Schema: core; Owner: -
--

ALTER SEQUENCE core.tblresenas_id_seq OWNED BY core.tblresenas.id;


--
-- Name: tblsorteos; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.tblsorteos (
    id integer NOT NULL,
    nombre character varying(200) NOT NULL,
    premio character varying(200) NOT NULL,
    ganador_id integer,
    total_participantes integer,
    min_pedidos integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tblsorteos_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

CREATE SEQUENCE core.tblsorteos_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tblsorteos_id_seq; Type: SEQUENCE OWNED BY; Schema: core; Owner: -
--

ALTER SEQUENCE core.tblsorteos_id_seq OWNED BY core.tblsorteos.id;


--
-- Name: tbltokens_blacklist; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.tbltokens_blacklist (
    id integer NOT NULL,
    token text NOT NULL,
    usuario_id integer,
    expira_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tbltokens_blacklist_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

CREATE SEQUENCE core.tbltokens_blacklist_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tbltokens_blacklist_id_seq; Type: SEQUENCE OWNED BY; Schema: core; Owner: -
--

ALTER SEQUENCE core.tbltokens_blacklist_id_seq OWNED BY core.tbltokens_blacklist.id;


--
-- Name: tblusuarios; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.tblusuarios (
    id integer NOT NULL,
    nombre character varying(100) NOT NULL,
    apellido character varying(100) NOT NULL,
    email character varying(255) NOT NULL,
    password_hash character varying(255) NOT NULL,
    telefono character varying(15),
    rol public.rol_usuario DEFAULT 'cliente'::public.rol_usuario NOT NULL,
    activo boolean DEFAULT true NOT NULL,
    email_verificado boolean DEFAULT false NOT NULL,
    google_id character varying(255),
    avatar_url character varying(500),
    puesto character varying(100),
    permisos text[],
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    ultimo_acceso timestamp with time zone,
    codigo_empleado integer,
    pin_hash character varying(255),
    intentos_pin_fallidos integer DEFAULT 0 NOT NULL,
    pin_bloqueado_hasta timestamp without time zone,
    pin_actualizado_at timestamp without time zone,
    disponible boolean DEFAULT true NOT NULL
);


--
-- Name: COLUMN tblusuarios.codigo_empleado; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON COLUMN core.tblusuarios.codigo_empleado IS 'CÃ³digo corto (3-6 dÃ­gitos) usado para login por voz de empleados en Alexa. NULL para clientes.';


--
-- Name: COLUMN tblusuarios.pin_hash; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON COLUMN core.tblusuarios.pin_hash IS 'Hash bcrypt del PIN de 6 dÃ­gitos para login por voz. Solo se usa con codigo_empleado.';


--
-- Name: COLUMN tblusuarios.intentos_pin_fallidos; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON COLUMN core.tblusuarios.intentos_pin_fallidos IS 'Contador de intentos fallidos consecutivos. Se resetea a 0 en login exitoso.';


--
-- Name: COLUMN tblusuarios.pin_bloqueado_hasta; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON COLUMN core.tblusuarios.pin_bloqueado_hasta IS 'Si estÃ¡ en el futuro, el PIN estÃ¡ bloqueado por demasiados intentos fallidos.';


--
-- Name: COLUMN tblusuarios.disponible; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON COLUMN core.tblusuarios.disponible IS 'Disponibilidad del repartidor para recibir asignaciones. Sin efecto en otros roles.';


--
-- Name: tblusuarios_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

CREATE SEQUENCE core.tblusuarios_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tblusuarios_id_seq; Type: SEQUENCE OWNED BY; Schema: core; Owner: -
--

ALTER SEQUENCE core.tblusuarios_id_seq OWNED BY core.tblusuarios.id;


--
-- Name: tblzonas_colonias; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.tblzonas_colonias (
    id integer NOT NULL,
    zona_id integer NOT NULL,
    colonia character varying(120) NOT NULL
);


--
-- Name: TABLE tblzonas_colonias; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON TABLE core.tblzonas_colonias IS 'Colonias que pertenecen a cada zona de envÃ­o (matching por nombre).';


--
-- Name: tblzonas_colonias_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

CREATE SEQUENCE core.tblzonas_colonias_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tblzonas_colonias_id_seq; Type: SEQUENCE OWNED BY; Schema: core; Owner: -
--

ALTER SEQUENCE core.tblzonas_colonias_id_seq OWNED BY core.tblzonas_colonias.id;


--
-- Name: tblzonas_envio; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.tblzonas_envio (
    id integer NOT NULL,
    nombre character varying(100) NOT NULL,
    tarifa numeric(10,2) NOT NULL,
    activa boolean DEFAULT true NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT tblzonas_envio_tarifa_check CHECK ((tarifa >= (0)::numeric))
);


--
-- Name: TABLE tblzonas_envio; Type: COMMENT; Schema: core; Owner: -
--

COMMENT ON TABLE core.tblzonas_envio IS 'Zonas de cobertura de envÃ­o a domicilio en Huejutla con su tarifa.';


--
-- Name: tblzonas_envio_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

CREATE SEQUENCE core.tblzonas_envio_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tblzonas_envio_id_seq; Type: SEQUENCE OWNED BY; Schema: core; Owner: -
--

ALTER SEQUENCE core.tblzonas_envio_id_seq OWNED BY core.tblzonas_envio.id;


--
-- Name: actividad_reciente; Type: VIEW; Schema: reports; Owner: -
--

CREATE VIEW reports.actividad_reciente AS
 SELECT a.id,
    (((u.nombre)::text || ' '::text) || (u.apellido)::text) AS usuario,
    u.rol,
    a.accion,
    a.entidad,
    a.entidad_id,
    a.ip,
    a.created_at
   FROM (core.tblauditoria a
     LEFT JOIN core.tblusuarios u ON ((a.usuario_id = u.id)))
  ORDER BY a.created_at DESC
 LIMIT 50;


--
-- Name: ingresos_por_pago; Type: VIEW; Schema: reports; Owner: -
--

CREATE VIEW reports.ingresos_por_pago AS
 SELECT estado,
    count(*) AS total_pagos,
    COALESCE(sum(monto_total), (0)::numeric) AS ingresos_totales,
    COALESCE(sum(descuento), (0)::numeric) AS descuentos_totales,
    COALESCE(round(avg(monto_total), 2), (0)::numeric) AS pago_promedio
   FROM core.tblpagos
  GROUP BY estado
  ORDER BY COALESCE(sum(monto_total), (0)::numeric) DESC;


--
-- Name: productos_por_categoria; Type: VIEW; Schema: reports; Owner: -
--

CREATE VIEW reports.productos_por_categoria AS
SELECT
    NULL::integer AS categoria_id,
    NULL::character varying(100) AS categoria,
    NULL::bigint AS total_productos,
    NULL::bigint AS productos_activos,
    NULL::bigint AS productos_populares,
    NULL::numeric AS precio_promedio_chico;


--
-- Name: promociones_activas; Type: VIEW; Schema: reports; Owner: -
--

CREATE VIEW reports.promociones_activas AS
 SELECT pr.id AS promocion_id,
    pr.tipo,
    pr.estado,
    p.nombre AS producto,
    p.precio_chico,
    pr.descuento_porcentaje,
    pr.precio_oferta,
    pr.nombre_temporada,
    pr.badge_destacado,
    pr.codigo_descuento,
    pr.fecha_inicio,
    pr.fecha_fin
   FROM (core.tblpromociones pr
     LEFT JOIN core.tblproductos p ON ((pr.producto_id = p.id)))
  WHERE (pr.estado = 'activa'::public.estado_promocion)
  ORDER BY pr.created_at DESC;


--
-- Name: quejas_resumen; Type: VIEW; Schema: reports; Owner: -
--

CREATE VIEW reports.quejas_resumen AS
 SELECT estado,
    tipo,
    prioridad,
    count(*) AS total_tickets
   FROM core.tblquejas
  GROUP BY estado, tipo, prioridad
  ORDER BY
        CASE prioridad
            WHEN 'alta'::public.prioridad_queja THEN 1
            WHEN 'media'::public.prioridad_queja THEN 2
            WHEN 'baja'::public.prioridad_queja THEN 3
            ELSE NULL::integer
        END, (count(*)) DESC;


--
-- Name: reembolsos_resumen; Type: VIEW; Schema: reports; Owner: -
--

CREATE VIEW reports.reembolsos_resumen AS
 SELECT estado,
    motivo,
    count(*) AS total_solicitudes,
    COALESCE(sum(monto), (0)::numeric) AS monto_total
   FROM core.tblreembolsos
  GROUP BY estado, motivo
  ORDER BY estado, (count(*)) DESC;


--
-- Name: resenas_por_producto; Type: VIEW; Schema: reports; Owner: -
--

CREATE VIEW reports.resenas_por_producto AS
 SELECT p.id AS producto_id,
    p.nombre AS producto,
    c.nombre AS categoria,
    count(r.id) FILTER (WHERE (r.estado = 'aprobada'::public.estado_resena)) AS total_resenas,
    COALESCE(round(avg(r.rating) FILTER (WHERE (r.estado = 'aprobada'::public.estado_resena)), 1), (0)::numeric) AS rating_promedio,
    count(r.id) FILTER (WHERE (r.estado = 'pendiente'::public.estado_resena)) AS resenas_pendientes
   FROM ((core.tblproductos p
     LEFT JOIN core.tblresenas r ON ((p.id = r.producto_id)))
     LEFT JOIN core.tblcategorias c ON ((p.categoria_id = c.id)))
  GROUP BY p.id, p.nombre, c.nombre
  ORDER BY COALESCE(round(avg(r.rating) FILTER (WHERE (r.estado = 'aprobada'::public.estado_resena)), 1), (0)::numeric) DESC, (count(r.id) FILTER (WHERE (r.estado = 'aprobada'::public.estado_resena))) DESC;


--
-- Name: resumen_general; Type: VIEW; Schema: reports; Owner: -
--

CREATE VIEW reports.resumen_general AS
 SELECT 'Total de Usuarios'::text AS metrica,
    (count(*))::text AS valor
   FROM core.tblusuarios
UNION ALL
 SELECT 'Usuarios Activos'::text AS metrica,
    (count(*))::text AS valor
   FROM core.tblusuarios
  WHERE (tblusuarios.activo = true)
UNION ALL
 SELECT 'Clientes'::text AS metrica,
    (count(*))::text AS valor
   FROM core.tblusuarios
  WHERE (tblusuarios.rol = 'cliente'::public.rol_usuario)
UNION ALL
 SELECT 'Empleados'::text AS metrica,
    (count(*))::text AS valor
   FROM core.tblusuarios
  WHERE (tblusuarios.rol = 'empleado'::public.rol_usuario)
UNION ALL
 SELECT 'Total de Productos'::text AS metrica,
    (count(*))::text AS valor
   FROM core.tblproductos
UNION ALL
 SELECT 'Productos Activos'::text AS metrica,
    (count(*))::text AS valor
   FROM core.tblproductos
  WHERE (tblproductos.activo = true)
UNION ALL
 SELECT 'Total de CategorÃ­as'::text AS metrica,
    (count(*))::text AS valor
   FROM core.tblcategorias
UNION ALL
 SELECT 'Total de Pedidos'::text AS metrica,
    (count(*))::text AS valor
   FROM core.tblpedidos
UNION ALL
 SELECT 'Total de ReseÃ±as'::text AS metrica,
    (count(*))::text AS valor
   FROM core.tblresenas
UNION ALL
 SELECT 'Total de Quejas'::text AS metrica,
    (count(*))::text AS valor
   FROM core.tblquejas;


--
-- Name: top_productos_vendidos; Type: VIEW; Schema: reports; Owner: -
--

CREATE VIEW reports.top_productos_vendidos AS
 SELECT p.id AS producto_id,
    p.nombre AS producto,
    c.nombre AS categoria,
    p.precio_chico,
    sum(pi.cantidad) AS unidades_vendidas,
    round(sum(pi.subtotal), 2) AS ingresos_generados
   FROM ((core.tblproductos p
     JOIN core.tblcategorias c ON ((p.categoria_id = c.id)))
     JOIN core.tblpedido_items pi ON ((p.id = pi.producto_id)))
  GROUP BY p.id, p.nombre, c.nombre, p.precio_chico
  ORDER BY (sum(pi.cantidad)) DESC
 LIMIT 20;


--
-- Name: usuarios_por_rol; Type: VIEW; Schema: reports; Owner: -
--

CREATE VIEW reports.usuarios_por_rol AS
 SELECT rol,
    count(*) AS total,
    count(*) FILTER (WHERE (activo = true)) AS activos,
    count(*) FILTER (WHERE (activo = false)) AS inactivos,
    count(*) FILTER (WHERE (email_verificado = true)) AS verificados,
    count(*) FILTER (WHERE (google_id IS NOT NULL)) AS con_google
   FROM core.tblusuarios
  GROUP BY rol
  ORDER BY (count(*)) DESC;


--
-- Name: ventas_por_estado; Type: VIEW; Schema: reports; Owner: -
--

CREATE VIEW reports.ventas_por_estado AS
 SELECT estado,
    count(*) AS total_pedidos,
    COALESCE(sum(total), (0)::numeric) AS monto_total,
    COALESCE(round(avg(total), 2), (0)::numeric) AS ticket_promedio
   FROM core.tblpedidos
  GROUP BY estado
  ORDER BY
        CASE estado
            WHEN 'pendiente'::public.estado_pedido THEN 1
            WHEN 'en_preparacion'::public.estado_pedido THEN 2
            WHEN 'listo'::public.estado_pedido THEN 3
            WHEN 'completado'::public.estado_pedido THEN 4
            WHEN 'cancelado'::public.estado_pedido THEN 5
            ELSE NULL::integer
        END;


--
-- Name: stg_categorias; Type: TABLE; Schema: staging; Owner: -
--

CREATE TABLE staging.stg_categorias (
    id integer DEFAULT nextval('core.tblcategorias_id_seq'::regclass) NOT NULL,
    nombre character varying(100) NOT NULL,
    descripcion text,
    imagen_url character varying(500),
    orden integer DEFAULT 0 NOT NULL,
    activo boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stg_contacto_mensajes; Type: TABLE; Schema: staging; Owner: -
--

CREATE TABLE staging.stg_contacto_mensajes (
    id integer DEFAULT nextval('core.tblcontacto_mensajes_id_seq'::regclass) NOT NULL,
    nombre character varying(200) NOT NULL,
    email character varying(255) NOT NULL,
    telefono character varying(15),
    tipo_producto character varying(100),
    mensaje text NOT NULL,
    leido boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stg_productos; Type: TABLE; Schema: staging; Owner: -
--

CREATE TABLE staging.stg_productos (
    id integer DEFAULT nextval('core.tblproductos_id_seq'::regclass) NOT NULL,
    nombre character varying(200) NOT NULL,
    descripcion text,
    categoria_id integer NOT NULL,
    precio_chico numeric(10,2) NOT NULL,
    precio_grande numeric(10,2),
    imagen_url character varying(500),
    imagenes text[],
    ingredientes text[],
    sabor character varying(50),
    tamano character varying(20),
    tipo character varying(50),
    popular boolean DEFAULT false NOT NULL,
    activo boolean DEFAULT true NOT NULL,
    es_nuevo boolean DEFAULT false NOT NULL,
    fecha_nuevo_expira timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: stg_usuarios; Type: TABLE; Schema: staging; Owner: -
--

CREATE TABLE staging.stg_usuarios (
    id integer DEFAULT nextval('core.tblusuarios_id_seq'::regclass) NOT NULL,
    nombre character varying(100) NOT NULL,
    apellido character varying(100) NOT NULL,
    email character varying(255) NOT NULL,
    password_hash character varying(255) NOT NULL,
    telefono character varying(15),
    rol public.rol_usuario DEFAULT 'cliente'::public.rol_usuario NOT NULL,
    activo boolean DEFAULT true NOT NULL,
    email_verificado boolean DEFAULT false NOT NULL,
    google_id character varying(255),
    avatar_url character varying(500),
    puesto character varying(100),
    permisos text[],
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    ultimo_acceso timestamp with time zone
);


--
-- Name: tblauditoria id; Type: DEFAULT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblauditoria ALTER COLUMN id SET DEFAULT nextval('core.tblauditoria_id_seq'::regclass);


--
-- Name: tblcarrito_items id; Type: DEFAULT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblcarrito_items ALTER COLUMN id SET DEFAULT nextval('core.tblcarrito_items_id_seq'::regclass);


--
-- Name: tblcategoria_opciones id; Type: DEFAULT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblcategoria_opciones ALTER COLUMN id SET DEFAULT nextval('core.tblcategoria_opciones_id_seq'::regclass);


--
-- Name: tblcategorias id; Type: DEFAULT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblcategorias ALTER COLUMN id SET DEFAULT nextval('core.tblcategorias_id_seq'::regclass);


--
-- Name: tblcodigos_verificacion id; Type: DEFAULT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblcodigos_verificacion ALTER COLUMN id SET DEFAULT nextval('core.tblcodigos_verificacion_id_seq'::regclass);


--
-- Name: tblconfiguracion_sistema id; Type: DEFAULT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblconfiguracion_sistema ALTER COLUMN id SET DEFAULT nextval('core.tblconfiguracion_sistema_id_seq'::regclass);


--
-- Name: tblcontacto_mensajes id; Type: DEFAULT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblcontacto_mensajes ALTER COLUMN id SET DEFAULT nextval('core.tblcontacto_mensajes_id_seq'::regclass);


--
-- Name: tbldirecciones id; Type: DEFAULT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tbldirecciones ALTER COLUMN id SET DEFAULT nextval('core.tbldirecciones_id_seq'::regclass);


--
-- Name: tblentregas id; Type: DEFAULT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblentregas ALTER COLUMN id SET DEFAULT nextval('core.tblentregas_id_seq'::regclass);


--
-- Name: tblfavoritos id; Type: DEFAULT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblfavoritos ALTER COLUMN id SET DEFAULT nextval('core.tblfavoritos_id_seq'::regclass);


--
-- Name: tbllogin_intentos_voz id; Type: DEFAULT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tbllogin_intentos_voz ALTER COLUMN id SET DEFAULT nextval('core.tbllogin_intentos_voz_id_seq'::regclass);


--
-- Name: tblnotificaciones id; Type: DEFAULT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblnotificaciones ALTER COLUMN id SET DEFAULT nextval('core.tblnotificaciones_id_seq'::regclass);


--
-- Name: tblnotificaciones_envios id; Type: DEFAULT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblnotificaciones_envios ALTER COLUMN id SET DEFAULT nextval('core.tblnotificaciones_envios_id_seq'::regclass);


--
-- Name: tbloauth_codes id; Type: DEFAULT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tbloauth_codes ALTER COLUMN id SET DEFAULT nextval('core.tbloauth_codes_id_seq'::regclass);


--
-- Name: tblpagos id; Type: DEFAULT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblpagos ALTER COLUMN id SET DEFAULT nextval('core.tblpagos_id_seq'::regclass);


--
-- Name: tblpedido_items id; Type: DEFAULT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblpedido_items ALTER COLUMN id SET DEFAULT nextval('core.tblpedido_items_id_seq'::regclass);


--
-- Name: tblpedidos id; Type: DEFAULT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblpedidos ALTER COLUMN id SET DEFAULT nextval('core.tblpedidos_id_seq'::regclass);


--
-- Name: tblproductos id; Type: DEFAULT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblproductos ALTER COLUMN id SET DEFAULT nextval('core.tblproductos_id_seq'::regclass);


--
-- Name: tblpromociones id; Type: DEFAULT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblpromociones ALTER COLUMN id SET DEFAULT nextval('core.tblpromociones_id_seq'::regclass);


--
-- Name: tblquejas id; Type: DEFAULT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblquejas ALTER COLUMN id SET DEFAULT nextval('core.tblquejas_id_seq'::regclass);


--
-- Name: tblreembolsos id; Type: DEFAULT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblreembolsos ALTER COLUMN id SET DEFAULT nextval('core.tblreembolsos_id_seq'::regclass);


--
-- Name: tblresena_likes id; Type: DEFAULT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblresena_likes ALTER COLUMN id SET DEFAULT nextval('core.tblresena_likes_id_seq'::regclass);


--
-- Name: tblresenas id; Type: DEFAULT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblresenas ALTER COLUMN id SET DEFAULT nextval('core.tblresenas_id_seq'::regclass);


--
-- Name: tblsorteos id; Type: DEFAULT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblsorteos ALTER COLUMN id SET DEFAULT nextval('core.tblsorteos_id_seq'::regclass);


--
-- Name: tbltokens_blacklist id; Type: DEFAULT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tbltokens_blacklist ALTER COLUMN id SET DEFAULT nextval('core.tbltokens_blacklist_id_seq'::regclass);


--
-- Name: tblusuarios id; Type: DEFAULT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblusuarios ALTER COLUMN id SET DEFAULT nextval('core.tblusuarios_id_seq'::regclass);


--
-- Name: tblzonas_colonias id; Type: DEFAULT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblzonas_colonias ALTER COLUMN id SET DEFAULT nextval('core.tblzonas_colonias_id_seq'::regclass);


--
-- Name: tblzonas_envio id; Type: DEFAULT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblzonas_envio ALTER COLUMN id SET DEFAULT nextval('core.tblzonas_envio_id_seq'::regclass);


--
-- Name: tblauditoria tblauditoria_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblauditoria
    ADD CONSTRAINT tblauditoria_pkey PRIMARY KEY (id);


--
-- Name: tblcarrito_items tblcarrito_items_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblcarrito_items
    ADD CONSTRAINT tblcarrito_items_pkey PRIMARY KEY (id);


--
-- Name: tblcarrito_items tblcarrito_items_usuario_id_producto_id_tamano_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblcarrito_items
    ADD CONSTRAINT tblcarrito_items_usuario_id_producto_id_tamano_key UNIQUE (usuario_id, producto_id, tamano);


--
-- Name: tblcategoria_opciones tblcategoria_opciones_categoria_id_tipo_opcion_nombre_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblcategoria_opciones
    ADD CONSTRAINT tblcategoria_opciones_categoria_id_tipo_opcion_nombre_key UNIQUE (categoria_id, tipo_opcion, nombre);


--
-- Name: tblcategoria_opciones tblcategoria_opciones_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblcategoria_opciones
    ADD CONSTRAINT tblcategoria_opciones_pkey PRIMARY KEY (id);


--
-- Name: tblcategorias tblcategorias_nombre_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblcategorias
    ADD CONSTRAINT tblcategorias_nombre_key UNIQUE (nombre);


--
-- Name: tblcategorias tblcategorias_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblcategorias
    ADD CONSTRAINT tblcategorias_pkey PRIMARY KEY (id);


--
-- Name: tblcodigos_verificacion tblcodigos_verificacion_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblcodigos_verificacion
    ADD CONSTRAINT tblcodigos_verificacion_pkey PRIMARY KEY (id);


--
-- Name: tblconfiguracion_sistema tblconfiguracion_sistema_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblconfiguracion_sistema
    ADD CONSTRAINT tblconfiguracion_sistema_pkey PRIMARY KEY (id);


--
-- Name: tblconfiguracion_sistema tblconfiguracion_sistema_seccion_clave_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblconfiguracion_sistema
    ADD CONSTRAINT tblconfiguracion_sistema_seccion_clave_key UNIQUE (seccion, clave);


--
-- Name: tblcontacto_mensajes tblcontacto_mensajes_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblcontacto_mensajes
    ADD CONSTRAINT tblcontacto_mensajes_pkey PRIMARY KEY (id);


--
-- Name: tbldirecciones tbldirecciones_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tbldirecciones
    ADD CONSTRAINT tbldirecciones_pkey PRIMARY KEY (id);


--
-- Name: tblentregas tblentregas_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblentregas
    ADD CONSTRAINT tblentregas_pkey PRIMARY KEY (id);


--
-- Name: tblfavoritos tblfavoritos_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblfavoritos
    ADD CONSTRAINT tblfavoritos_pkey PRIMARY KEY (id);


--
-- Name: tblfavoritos tblfavoritos_usuario_id_producto_id_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblfavoritos
    ADD CONSTRAINT tblfavoritos_usuario_id_producto_id_key UNIQUE (usuario_id, producto_id);


--
-- Name: tbllogin_intentos_voz tbllogin_intentos_voz_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tbllogin_intentos_voz
    ADD CONSTRAINT tbllogin_intentos_voz_pkey PRIMARY KEY (id);


--
-- Name: tblnotificaciones_envios tblnotificaciones_envios_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblnotificaciones_envios
    ADD CONSTRAINT tblnotificaciones_envios_pkey PRIMARY KEY (id);


--
-- Name: tblnotificaciones tblnotificaciones_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblnotificaciones
    ADD CONSTRAINT tblnotificaciones_pkey PRIMARY KEY (id);


--
-- Name: tbloauth_codes tbloauth_codes_code_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tbloauth_codes
    ADD CONSTRAINT tbloauth_codes_code_key UNIQUE (code);


--
-- Name: tbloauth_codes tbloauth_codes_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tbloauth_codes
    ADD CONSTRAINT tbloauth_codes_pkey PRIMARY KEY (id);


--
-- Name: tblpagos tblpagos_pedido_id_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblpagos
    ADD CONSTRAINT tblpagos_pedido_id_key UNIQUE (pedido_id);


--
-- Name: tblpagos tblpagos_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblpagos
    ADD CONSTRAINT tblpagos_pkey PRIMARY KEY (id);


--
-- Name: tblpagos tblpagos_stripe_payment_id_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblpagos
    ADD CONSTRAINT tblpagos_stripe_payment_id_key UNIQUE (stripe_payment_id);


--
-- Name: tblpedido_items tblpedido_items_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblpedido_items
    ADD CONSTRAINT tblpedido_items_pkey PRIMARY KEY (id);


--
-- Name: tblpedidos tblpedidos_numero_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblpedidos
    ADD CONSTRAINT tblpedidos_numero_key UNIQUE (numero);


--
-- Name: tblpedidos tblpedidos_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblpedidos
    ADD CONSTRAINT tblpedidos_pkey PRIMARY KEY (id);


--
-- Name: tblproductos tblproductos_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblproductos
    ADD CONSTRAINT tblproductos_pkey PRIMARY KEY (id);


--
-- Name: tblpromociones tblpromociones_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblpromociones
    ADD CONSTRAINT tblpromociones_pkey PRIMARY KEY (id);


--
-- Name: tblquejas tblquejas_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblquejas
    ADD CONSTRAINT tblquejas_pkey PRIMARY KEY (id);


--
-- Name: tblquejas tblquejas_ticket_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblquejas
    ADD CONSTRAINT tblquejas_ticket_key UNIQUE (ticket);


--
-- Name: tblreembolsos tblreembolsos_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblreembolsos
    ADD CONSTRAINT tblreembolsos_pkey PRIMARY KEY (id);


--
-- Name: tblresena_likes tblresena_likes_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblresena_likes
    ADD CONSTRAINT tblresena_likes_pkey PRIMARY KEY (id);


--
-- Name: tblresena_likes tblresena_likes_resena_id_usuario_id_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblresena_likes
    ADD CONSTRAINT tblresena_likes_resena_id_usuario_id_key UNIQUE (resena_id, usuario_id);


--
-- Name: tblresenas tblresenas_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblresenas
    ADD CONSTRAINT tblresenas_pkey PRIMARY KEY (id);


--
-- Name: tblresenas tblresenas_producto_id_usuario_id_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblresenas
    ADD CONSTRAINT tblresenas_producto_id_usuario_id_key UNIQUE (producto_id, usuario_id);


--
-- Name: tblsorteos tblsorteos_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblsorteos
    ADD CONSTRAINT tblsorteos_pkey PRIMARY KEY (id);


--
-- Name: tbltokens_blacklist tbltokens_blacklist_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tbltokens_blacklist
    ADD CONSTRAINT tbltokens_blacklist_pkey PRIMARY KEY (id);


--
-- Name: tblusuarios tblusuarios_email_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblusuarios
    ADD CONSTRAINT tblusuarios_email_key UNIQUE (email);


--
-- Name: tblusuarios tblusuarios_google_id_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblusuarios
    ADD CONSTRAINT tblusuarios_google_id_key UNIQUE (google_id);


--
-- Name: tblusuarios tblusuarios_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblusuarios
    ADD CONSTRAINT tblusuarios_pkey PRIMARY KEY (id);


--
-- Name: tblzonas_colonias tblzonas_colonias_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblzonas_colonias
    ADD CONSTRAINT tblzonas_colonias_pkey PRIMARY KEY (id);


--
-- Name: tblzonas_envio tblzonas_envio_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblzonas_envio
    ADD CONSTRAINT tblzonas_envio_pkey PRIMARY KEY (id);


--
-- Name: stg_categorias stg_categorias_nombre_key; Type: CONSTRAINT; Schema: staging; Owner: -
--

ALTER TABLE ONLY staging.stg_categorias
    ADD CONSTRAINT stg_categorias_nombre_key UNIQUE (nombre);


--
-- Name: stg_categorias stg_categorias_pkey; Type: CONSTRAINT; Schema: staging; Owner: -
--

ALTER TABLE ONLY staging.stg_categorias
    ADD CONSTRAINT stg_categorias_pkey PRIMARY KEY (id);


--
-- Name: stg_contacto_mensajes stg_contacto_mensajes_pkey; Type: CONSTRAINT; Schema: staging; Owner: -
--

ALTER TABLE ONLY staging.stg_contacto_mensajes
    ADD CONSTRAINT stg_contacto_mensajes_pkey PRIMARY KEY (id);


--
-- Name: stg_productos stg_productos_pkey; Type: CONSTRAINT; Schema: staging; Owner: -
--

ALTER TABLE ONLY staging.stg_productos
    ADD CONSTRAINT stg_productos_pkey PRIMARY KEY (id);


--
-- Name: stg_usuarios stg_usuarios_email_key; Type: CONSTRAINT; Schema: staging; Owner: -
--

ALTER TABLE ONLY staging.stg_usuarios
    ADD CONSTRAINT stg_usuarios_email_key UNIQUE (email);


--
-- Name: stg_usuarios stg_usuarios_google_id_key; Type: CONSTRAINT; Schema: staging; Owner: -
--

ALTER TABLE ONLY staging.stg_usuarios
    ADD CONSTRAINT stg_usuarios_google_id_key UNIQUE (google_id);


--
-- Name: stg_usuarios stg_usuarios_pkey; Type: CONSTRAINT; Schema: staging; Owner: -
--

ALTER TABLE ONLY staging.stg_usuarios
    ADD CONSTRAINT stg_usuarios_pkey PRIMARY KEY (id);


--
-- Name: idx_tblauditoria_created; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblauditoria_created ON core.tblauditoria USING btree (created_at);


--
-- Name: idx_tblauditoria_entidad; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblauditoria_entidad ON core.tblauditoria USING btree (entidad);


--
-- Name: idx_tblauditoria_usuario; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblauditoria_usuario ON core.tblauditoria USING btree (usuario_id);


--
-- Name: idx_tblcategorias_activo; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblcategorias_activo ON core.tblcategorias USING btree (activo);


--
-- Name: idx_tblcategorias_orden; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblcategorias_orden ON core.tblcategorias USING btree (orden);


--
-- Name: idx_tblcodigos; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblcodigos ON core.tblcodigos_verificacion USING btree (email, codigo, tipo);


--
-- Name: idx_tblcontacto_leido; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblcontacto_leido ON core.tblcontacto_mensajes USING btree (leido);


--
-- Name: idx_tbldirecciones_usuario; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tbldirecciones_usuario ON core.tbldirecciones USING btree (usuario_id) WHERE (activa = true);


--
-- Name: idx_tblentregas_pedido_activa; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX idx_tblentregas_pedido_activa ON core.tblentregas USING btree (pedido_id) WHERE ((estado)::text = ANY ((ARRAY['asignada'::character varying, 'en_camino'::character varying])::text[]));


--
-- Name: idx_tblentregas_repartidor; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblentregas_repartidor ON core.tblentregas USING btree (repartidor_id, estado);


--
-- Name: idx_tblenvios_estado; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblenvios_estado ON core.tblnotificaciones_envios USING btree (estado);


--
-- Name: idx_tbllogin_intentos_device_fecha; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tbllogin_intentos_device_fecha ON core.tbllogin_intentos_voz USING btree (device_id, created_at DESC);


--
-- Name: idx_tblnotif_created; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblnotif_created ON core.tblnotificaciones USING btree (created_at);


--
-- Name: idx_tblnotif_leida; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblnotif_leida ON core.tblnotificaciones USING btree (leida);


--
-- Name: idx_tblnotif_usuario; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblnotif_usuario ON core.tblnotificaciones USING btree (usuario_id);


--
-- Name: idx_tbloauth_codes_code; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tbloauth_codes_code ON core.tbloauth_codes USING btree (code);


--
-- Name: idx_tbloauth_codes_expira; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tbloauth_codes_expira ON core.tbloauth_codes USING btree (expira_en) WHERE (usado = false);


--
-- Name: idx_tblpagos_estado; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblpagos_estado ON core.tblpagos USING btree (estado);


--
-- Name: idx_tblpagos_stripe; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblpagos_stripe ON core.tblpagos USING btree (stripe_payment_id);


--
-- Name: idx_tblpedido_items_pedido; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblpedido_items_pedido ON core.tblpedido_items USING btree (pedido_id);


--
-- Name: idx_tblpedido_items_producto; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblpedido_items_producto ON core.tblpedido_items USING btree (producto_id, pedido_id);


--
-- Name: idx_tblpedidos_created; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblpedidos_created ON core.tblpedidos USING btree (created_at);


--
-- Name: idx_tblpedidos_estado; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblpedidos_estado ON core.tblpedidos USING btree (estado);


--
-- Name: idx_tblpedidos_fecha_estado; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblpedidos_fecha_estado ON core.tblpedidos USING btree (created_at, estado);


--
-- Name: idx_tblpedidos_tipo_entrega; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblpedidos_tipo_entrega ON core.tblpedidos USING btree (tipo_entrega, estado);


--
-- Name: idx_tblpedidos_usuario; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblpedidos_usuario ON core.tblpedidos USING btree (usuario_id);


--
-- Name: idx_tblproductos_activo; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblproductos_activo ON core.tblproductos USING btree (activo);


--
-- Name: idx_tblproductos_categoria; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblproductos_categoria ON core.tblproductos USING btree (categoria_id);


--
-- Name: idx_tblproductos_popular; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblproductos_popular ON core.tblproductos USING btree (popular);


--
-- Name: idx_tblpromociones_estado; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblpromociones_estado ON core.tblpromociones USING btree (estado);


--
-- Name: idx_tblpromociones_producto; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblpromociones_producto ON core.tblpromociones USING btree (producto_id);


--
-- Name: idx_tblpromociones_tipo; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblpromociones_tipo ON core.tblpromociones USING btree (tipo);


--
-- Name: idx_tblquejas_estado; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblquejas_estado ON core.tblquejas USING btree (estado);


--
-- Name: idx_tblquejas_prioridad; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblquejas_prioridad ON core.tblquejas USING btree (prioridad);


--
-- Name: idx_tblreembolsos_estado; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblreembolsos_estado ON core.tblreembolsos USING btree (estado);


--
-- Name: idx_tblreembolsos_pedido; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblreembolsos_pedido ON core.tblreembolsos USING btree (pedido_id);


--
-- Name: idx_tblreembolsos_usuario; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblreembolsos_usuario ON core.tblreembolsos USING btree (usuario_id);


--
-- Name: idx_tblresenas_estado; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblresenas_estado ON core.tblresenas USING btree (estado);


--
-- Name: idx_tblresenas_estado_created; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblresenas_estado_created ON core.tblresenas USING btree (estado, created_at);


--
-- Name: idx_tblresenas_producto; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblresenas_producto ON core.tblresenas USING btree (producto_id);


--
-- Name: idx_tbltokens_expira; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tbltokens_expira ON core.tbltokens_blacklist USING btree (expira_at);


--
-- Name: idx_tbltokens_token; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tbltokens_token ON core.tbltokens_blacklist USING btree (token);


--
-- Name: idx_tblusuarios_activo; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblusuarios_activo ON core.tblusuarios USING btree (activo);


--
-- Name: idx_tblusuarios_codigo_empleado; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX idx_tblusuarios_codigo_empleado ON core.tblusuarios USING btree (codigo_empleado) WHERE (codigo_empleado IS NOT NULL);


--
-- Name: idx_tblusuarios_email; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblusuarios_email ON core.tblusuarios USING btree (email);


--
-- Name: idx_tblusuarios_permisos; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblusuarios_permisos ON core.tblusuarios USING gin (permisos);


--
-- Name: idx_tblusuarios_rol; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblusuarios_rol ON core.tblusuarios USING btree (rol);


--
-- Name: idx_tblzonas_colonias_unica; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX idx_tblzonas_colonias_unica ON core.tblzonas_colonias USING btree (lower((colonia)::text));


--
-- Name: idx_tblzonas_colonias_zona; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_tblzonas_colonias_zona ON core.tblzonas_colonias USING btree (zona_id);


--
-- Name: stg_categorias_activo_idx; Type: INDEX; Schema: staging; Owner: -
--

CREATE INDEX stg_categorias_activo_idx ON staging.stg_categorias USING btree (activo);


--
-- Name: stg_categorias_orden_idx; Type: INDEX; Schema: staging; Owner: -
--

CREATE INDEX stg_categorias_orden_idx ON staging.stg_categorias USING btree (orden);


--
-- Name: stg_contacto_mensajes_leido_idx; Type: INDEX; Schema: staging; Owner: -
--

CREATE INDEX stg_contacto_mensajes_leido_idx ON staging.stg_contacto_mensajes USING btree (leido);


--
-- Name: stg_productos_activo_idx; Type: INDEX; Schema: staging; Owner: -
--

CREATE INDEX stg_productos_activo_idx ON staging.stg_productos USING btree (activo);


--
-- Name: stg_productos_categoria_id_idx; Type: INDEX; Schema: staging; Owner: -
--

CREATE INDEX stg_productos_categoria_id_idx ON staging.stg_productos USING btree (categoria_id);


--
-- Name: stg_productos_popular_idx; Type: INDEX; Schema: staging; Owner: -
--

CREATE INDEX stg_productos_popular_idx ON staging.stg_productos USING btree (popular);


--
-- Name: stg_usuarios_activo_idx; Type: INDEX; Schema: staging; Owner: -
--

CREATE INDEX stg_usuarios_activo_idx ON staging.stg_usuarios USING btree (activo);


--
-- Name: stg_usuarios_email_idx; Type: INDEX; Schema: staging; Owner: -
--

CREATE INDEX stg_usuarios_email_idx ON staging.stg_usuarios USING btree (email);


--
-- Name: stg_usuarios_rol_idx; Type: INDEX; Schema: staging; Owner: -
--

CREATE INDEX stg_usuarios_rol_idx ON staging.stg_usuarios USING btree (rol);


--
-- Name: productos_por_categoria _RETURN; Type: RULE; Schema: reports; Owner: -
--

CREATE OR REPLACE VIEW reports.productos_por_categoria AS
 SELECT c.id AS categoria_id,
    c.nombre AS categoria,
    count(p.id) AS total_productos,
    count(p.id) FILTER (WHERE (p.activo = true)) AS productos_activos,
    count(p.id) FILTER (WHERE (p.popular = true)) AS productos_populares,
    COALESCE(round(avg(p.precio_chico), 2), (0)::numeric) AS precio_promedio_chico
   FROM (core.tblcategorias c
     LEFT JOIN core.tblproductos p ON ((c.id = p.categoria_id)))
  GROUP BY c.id, c.nombre
  ORDER BY c.orden;


--
-- Name: tblcarrito_items trg_updated_at_carrito; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_updated_at_carrito BEFORE UPDATE ON core.tblcarrito_items FOR EACH ROW EXECUTE FUNCTION core.fn_actualizar_updated_at();


--
-- Name: tblcategorias trg_updated_at_categorias; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_updated_at_categorias BEFORE UPDATE ON core.tblcategorias FOR EACH ROW EXECUTE FUNCTION core.fn_actualizar_updated_at();


--
-- Name: tblconfiguracion_sistema trg_updated_at_config; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_updated_at_config BEFORE UPDATE ON core.tblconfiguracion_sistema FOR EACH ROW EXECUTE FUNCTION core.fn_actualizar_updated_at();


--
-- Name: tblpedidos trg_updated_at_pedidos; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_updated_at_pedidos BEFORE UPDATE ON core.tblpedidos FOR EACH ROW EXECUTE FUNCTION core.fn_actualizar_updated_at();


--
-- Name: tblproductos trg_updated_at_productos; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_updated_at_productos BEFORE UPDATE ON core.tblproductos FOR EACH ROW EXECUTE FUNCTION core.fn_actualizar_updated_at();


--
-- Name: tblquejas trg_updated_at_quejas; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_updated_at_quejas BEFORE UPDATE ON core.tblquejas FOR EACH ROW EXECUTE FUNCTION core.fn_actualizar_updated_at();


--
-- Name: tblreembolsos trg_updated_at_reembolsos; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_updated_at_reembolsos BEFORE UPDATE ON core.tblreembolsos FOR EACH ROW EXECUTE FUNCTION core.fn_actualizar_updated_at();


--
-- Name: tblresenas trg_updated_at_resenas; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_updated_at_resenas BEFORE UPDATE ON core.tblresenas FOR EACH ROW EXECUTE FUNCTION core.fn_actualizar_updated_at();


--
-- Name: tblusuarios trg_updated_at_usuarios; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER trg_updated_at_usuarios BEFORE UPDATE ON core.tblusuarios FOR EACH ROW EXECUTE FUNCTION core.fn_actualizar_updated_at();


--
-- Name: tblauditoria tblauditoria_usuario_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblauditoria
    ADD CONSTRAINT tblauditoria_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES core.tblusuarios(id);


--
-- Name: tblcarrito_items tblcarrito_items_producto_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblcarrito_items
    ADD CONSTRAINT tblcarrito_items_producto_id_fkey FOREIGN KEY (producto_id) REFERENCES core.tblproductos(id);


--
-- Name: tblcarrito_items tblcarrito_items_usuario_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblcarrito_items
    ADD CONSTRAINT tblcarrito_items_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES core.tblusuarios(id) ON DELETE CASCADE;


--
-- Name: tblcategoria_opciones tblcategoria_opciones_categoria_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblcategoria_opciones
    ADD CONSTRAINT tblcategoria_opciones_categoria_id_fkey FOREIGN KEY (categoria_id) REFERENCES core.tblcategorias(id) ON DELETE CASCADE;


--
-- Name: tblcodigos_verificacion tblcodigos_verificacion_usuario_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblcodigos_verificacion
    ADD CONSTRAINT tblcodigos_verificacion_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES core.tblusuarios(id);


--
-- Name: tblconfiguracion_sistema tblconfiguracion_sistema_updated_by_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblconfiguracion_sistema
    ADD CONSTRAINT tblconfiguracion_sistema_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES core.tblusuarios(id);


--
-- Name: tbldirecciones tbldirecciones_usuario_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tbldirecciones
    ADD CONSTRAINT tbldirecciones_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES core.tblusuarios(id) ON DELETE CASCADE;


--
-- Name: tblentregas tblentregas_asignado_por_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblentregas
    ADD CONSTRAINT tblentregas_asignado_por_fkey FOREIGN KEY (asignado_por) REFERENCES core.tblusuarios(id);


--
-- Name: tblentregas tblentregas_pedido_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblentregas
    ADD CONSTRAINT tblentregas_pedido_id_fkey FOREIGN KEY (pedido_id) REFERENCES core.tblpedidos(id) ON DELETE CASCADE;


--
-- Name: tblentregas tblentregas_repartidor_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblentregas
    ADD CONSTRAINT tblentregas_repartidor_id_fkey FOREIGN KEY (repartidor_id) REFERENCES core.tblusuarios(id);


--
-- Name: tblfavoritos tblfavoritos_producto_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblfavoritos
    ADD CONSTRAINT tblfavoritos_producto_id_fkey FOREIGN KEY (producto_id) REFERENCES core.tblproductos(id) ON DELETE CASCADE;


--
-- Name: tblfavoritos tblfavoritos_usuario_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblfavoritos
    ADD CONSTRAINT tblfavoritos_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES core.tblusuarios(id) ON DELETE CASCADE;


--
-- Name: tblnotificaciones_envios tblnotificaciones_envios_enviado_por_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblnotificaciones_envios
    ADD CONSTRAINT tblnotificaciones_envios_enviado_por_fkey FOREIGN KEY (enviado_por) REFERENCES core.tblusuarios(id);


--
-- Name: tblnotificaciones tblnotificaciones_usuario_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblnotificaciones
    ADD CONSTRAINT tblnotificaciones_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES core.tblusuarios(id) ON DELETE CASCADE;


--
-- Name: tbloauth_codes tbloauth_codes_usuario_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tbloauth_codes
    ADD CONSTRAINT tbloauth_codes_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES core.tblusuarios(id) ON DELETE CASCADE;


--
-- Name: tblpagos tblpagos_pedido_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblpagos
    ADD CONSTRAINT tblpagos_pedido_id_fkey FOREIGN KEY (pedido_id) REFERENCES core.tblpedidos(id);


--
-- Name: tblpedido_items tblpedido_items_pedido_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblpedido_items
    ADD CONSTRAINT tblpedido_items_pedido_id_fkey FOREIGN KEY (pedido_id) REFERENCES core.tblpedidos(id) ON DELETE CASCADE;


--
-- Name: tblpedido_items tblpedido_items_producto_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblpedido_items
    ADD CONSTRAINT tblpedido_items_producto_id_fkey FOREIGN KEY (producto_id) REFERENCES core.tblproductos(id);


--
-- Name: tblpedidos tblpedidos_usuario_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblpedidos
    ADD CONSTRAINT tblpedidos_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES core.tblusuarios(id);


--
-- Name: tblproductos tblproductos_categoria_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblproductos
    ADD CONSTRAINT tblproductos_categoria_id_fkey FOREIGN KEY (categoria_id) REFERENCES core.tblcategorias(id);


--
-- Name: tblpromociones tblpromociones_producto_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblpromociones
    ADD CONSTRAINT tblpromociones_producto_id_fkey FOREIGN KEY (producto_id) REFERENCES core.tblproductos(id);


--
-- Name: tblquejas tblquejas_pedido_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblquejas
    ADD CONSTRAINT tblquejas_pedido_id_fkey FOREIGN KEY (pedido_id) REFERENCES core.tblpedidos(id);


--
-- Name: tblquejas tblquejas_usuario_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblquejas
    ADD CONSTRAINT tblquejas_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES core.tblusuarios(id);


--
-- Name: tblreembolsos tblreembolsos_pedido_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblreembolsos
    ADD CONSTRAINT tblreembolsos_pedido_id_fkey FOREIGN KEY (pedido_id) REFERENCES core.tblpedidos(id);


--
-- Name: tblreembolsos tblreembolsos_producto_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblreembolsos
    ADD CONSTRAINT tblreembolsos_producto_id_fkey FOREIGN KEY (producto_id) REFERENCES core.tblproductos(id);


--
-- Name: tblreembolsos tblreembolsos_usuario_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblreembolsos
    ADD CONSTRAINT tblreembolsos_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES core.tblusuarios(id);


--
-- Name: tblresena_likes tblresena_likes_resena_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblresena_likes
    ADD CONSTRAINT tblresena_likes_resena_id_fkey FOREIGN KEY (resena_id) REFERENCES core.tblresenas(id) ON DELETE CASCADE;


--
-- Name: tblresena_likes tblresena_likes_usuario_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblresena_likes
    ADD CONSTRAINT tblresena_likes_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES core.tblusuarios(id);


--
-- Name: tblresenas tblresenas_producto_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblresenas
    ADD CONSTRAINT tblresenas_producto_id_fkey FOREIGN KEY (producto_id) REFERENCES core.tblproductos(id);


--
-- Name: tblresenas tblresenas_usuario_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblresenas
    ADD CONSTRAINT tblresenas_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES core.tblusuarios(id);


--
-- Name: tblsorteos tblsorteos_ganador_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblsorteos
    ADD CONSTRAINT tblsorteos_ganador_id_fkey FOREIGN KEY (ganador_id) REFERENCES core.tblusuarios(id);


--
-- Name: tbltokens_blacklist tbltokens_blacklist_usuario_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tbltokens_blacklist
    ADD CONSTRAINT tbltokens_blacklist_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES core.tblusuarios(id);


--
-- Name: tblzonas_colonias tblzonas_colonias_zona_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.tblzonas_colonias
    ADD CONSTRAINT tblzonas_colonias_zona_id_fkey FOREIGN KEY (zona_id) REFERENCES core.tblzonas_envio(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

\unrestrict Aq5bT4eVjSG8HgHBWUOFHB2AHJkzlOa77FH5a0j0BxrQNCziG5uq5VjE5quM9ej


