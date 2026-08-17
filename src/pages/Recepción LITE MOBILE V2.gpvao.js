// =====================================================
// KAMISUITE — Page Code: Recepción Lite Mobile (V2 CMS-first)
// =====================================================
// VERSION: 0.3.3
// FECHA: 15 de junio de 2026
// Página: /recepcionpromobile
// Custom Element ID en Editor: kamisuiteBookingLite (tag: kamisuite-booking-lite)
//
// Comunicación (sin cambios respecto al cableado):
//   Page → Element: el.setAttribute('response', JSON.stringify({type, ...data, ts}))
//   Element → Page: el.on('booking-message', handler)  (CustomEvent)
//
// =====================================================
// v0.3.3 — Bloqueos persistentes
// =====================================================
//   · 3 handlers nuevos: handleCrearBloqueo, handleEliminarBloqueo,
//     handleActualizarBloqueo. Copia LITERAL del patrón del page code
//     desktop V2 (pagecode_recepcionProCMS v1.0.17) traspasado en el
//     documento técnico de bloqueos del 15-jun-2026.
//   · Backend: recepcionProLogic.web v1.0.20 (desplegado en producción).
//     Las funciones insertan/borran/actualizan filas en KamisuiteReservations
//     con family:'BLOQUEO' que el motor público (widgetPublicoLogic v0.6.2)
//     ya respeta automáticamente como bloqueos efectivos.
//   · Cases nuevos en el switch: 'crearBloqueo', 'eliminarBloqueo',
//     'actualizarBloqueo'.
//   · Respuestas: 'bloqueoCreado', 'bloqueoEliminado', 'bloqueoActualizado'.
//
// =====================================================
// v0.3.2 — Cancelar reserva
// =====================================================
//   · Nuevo handler 'cancelar-reserva' → llama a cancelarReserva
//     (recepcionProLogic v1.0.18). Devuelve 'reserva-cancelada'.
//     Mismo patrón que pagecode_recepcionProCMS v1.0.15 líneas 260-268.
//
// =====================================================
// v0.3.1 — Settings (CalendarViewSettings) añadidos
// =====================================================
//   · Handler 'get-settings' + response 'settings-data', copia literal
//     del patrón pagecode_recepcionProCMS v1.0.15 líneas 436-453.
//   · Handler 'save-settings' (mismo patrón, líneas 455-474).
//   · Lee/escribe settings por usuario (filtrado por _owner) en CMS
//     CalendarViewSettings. Estructura: {_id, _owner, title, settingsJson}.
//     settingsJson contiene staffConfig {[wixResourceId]:{visible, color,
//     position}}, e intervalo, rowHeight, etc.
//   · El widget consume staffConfig.color para pintar dots y bloques,
//     staffConfig.visible/position para columnas. Mismo contrato V1.
//
// =====================================================
// CAMBIO MAYOR v0.3.0 — Migración V1 → V2 (CMS-first)
// =====================================================
//   · Backend único: recepcionProLogic.web (v1.0.18) para catálogo, staff,
//     reservas del día y creación de packs.
//   · Reutilizado literal: recepcionLogic.web (cargarTodosContactos +
//     crearContacto).
//   · ELIMINADOS imports V1: calendarioVista.web, simplesLogic.web,
//     coloracionLogic.web, tratamientosLogic.web,
//     serviceCatalogLogic.getCatalogoMobile.
//   · Reservas con fases: getReservasPorFecha devuelve cada pack con
//     array fases[]. Se reenvía intacto al widget. El widget V2 itera
//     fases ocupantes y salta PROCESO (ocupa:false).
//   · Catálogo CMS-first: getCatalogoReserva entrega cada servicio
//     principal con su array complementos[] y variantes[] inline.
//   · Identidad: setupUid (no serviceIdWix).
//   · Reserva: handleCrearReserva colapsa router por family a una única
//     llamada a crearPackReserva.
//   · Handler get-service-options ELIMINADO (addons inline en el catálogo).
//   · origenRecepcion: true propagado → dispara centralita de comunicaciones.
//   · ensureContactId conservado (patrón producción PRO).
//
// CONTRATO DE MENSAJES (widget → page code):
//   { type: 'ready' }
//   { type: 'get-reservas-dia', fecha }
//   { type: 'preload-reservas', fechaBase, dias }
//   { type: 'buscar-cliente', query }
//   { type: 'crear-contacto', nombre, apellido, telefono, email }
//   { type: 'crear-reserva',
//        principalSetupUid, complementosSetupUid[],
//        fechaISO, horaHHmm, empleadoId, staffName?,
//        contactDetails{}, memberContactId?, notas?, esProvisional? }
//   { type: 'get-settings' }
//   { type: 'save-settings', settings }
//
// RESPUESTAS (page code → widget) vía sendResponse(type, data):
//   'init-data'              { staff[], catalogo[] }
//   'reservas-dia'           { fecha, reservas[] }    // shape V2: con fases[]
//   'reservas-rango'         { porFecha:{[fecha]:reservas[]} }
//   'contactos-cache-ready'  { total }
//   'clientes-encontrados'   { clientes, total, cacheReady }
//   'contacto-creado'        { data }
//   'reserva-creada'         { ok, reservaId, ... }
//   'settings-data'          { settings }            // null si no hay aún
//   'error'                  { message }
//
// NOTA WIX: Custom Element. NUNCA html.on('message') (no funciona en Wix).
// =====================================================

import wixData from 'wix-data';
import { currentMember } from 'wix-members';

import {
  getCatalogoReserva,
  getStaffColumnas,
  getReservasPorFecha,
  crearPackReserva,
  cancelarReserva,
  crearBloqueo,
  eliminarBloqueo,
  actualizarBloqueo
} from 'backend/recepcionProLogic.web';

import { cargarTodosContactos, crearContacto } from 'backend/recepcionLogic.web';

const TAG = '[BookingLitePage v0.3.3]';
const PRELOAD_BATCH = 5;

let _el = null;
let _staff = [];
let _cacheContactos = [];
let _cacheReady = false;

function sendResponse(type, data = {}) {
  if (!_el) return;
  try {
    _el.setAttribute('response', JSON.stringify({ type, ...data, ts: Date.now() }));
  } catch (e) {
    console.error(`${TAG} ❌ sendResponse:`, e?.message);
  }
}

function addDaysISO(iso, delta) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// =====================================================
// INIT: staff + catálogo en paralelo (V2)
// =====================================================
async function handleReady() {
  console.log(`${TAG} 📱 CE listo. Cargando datos iniciales en paralelo…`);
  try {
    const [staffRes, catalogoRes] = await Promise.all([
      getStaffColumnas(),
      getCatalogoReserva()
    ]);

    if (!staffRes?.ok) {
      sendResponse('error', { message: staffRes?.error?.message || 'Error staff' });
      return;
    }

    _staff = staffRes.staff || [];
    const catalogo = catalogoRes?.ok ? (catalogoRes.servicios || []) : [];

    console.log(`${TAG} 🎯 Init OK: ${_staff.length} staff · ${catalogo.length} servicios`);
    sendResponse('init-data', { staff: _staff, catalogo });

    // Cargar contactos en background (no bloquea primera renderización)
    cargarCacheContactosBackground();
  } catch (e) {
    console.error(`${TAG} ❌ handleReady:`, e?.message);
    sendResponse('error', { message: 'Error cargando datos iniciales' });
  }
}

// =====================================================
// CACHE DE CONTACTOS (background) — patrón legacy literal
// =====================================================
async function cargarCacheContactosBackground() {
  try {
    const result = await cargarTodosContactos();
    if (result?.ok) {
      _cacheContactos = result.clientes || [];
      _cacheReady = true;
      console.log(`${TAG} 👥 Cache de clientes lista: ${_cacheContactos.length}`);
      sendResponse('contactos-cache-ready', { total: _cacheContactos.length });
    } else {
      console.warn(`${TAG} ⚠️ cargarTodosContactos sin ok`);
    }
  } catch (e) {
    console.error(`${TAG} ❌ cargarCacheContactos:`, e?.message);
  }
}

// =====================================================
// RESERVAS — un solo día (V2)
//   Reenvío directo de la reserva con fases[] intacto. El widget V2
//   itera fases ocupantes y salta PROCESO (mismo patrón que desktop).
// =====================================================
async function handleGetReservasDia(fecha) {
  if (!fecha) return;
  try {
    const result = await getReservasPorFecha({ fecha });
    const reservas = (result?.ok ? (result.reservas || []) : []);
    console.log(`${TAG} 📅 ${fecha}: ${reservas.length} packs`);
    sendResponse('reservas-dia', { fecha, reservas });
  } catch (e) {
    console.error(`${TAG} ❌ handleGetReservasDia ${fecha}:`, e?.message);
    sendResponse('reservas-dia', { fecha, reservas: [] });
  }
}

// =====================================================
// PRE-CARGA — N días en batches paralelos (V2)
// =====================================================
async function handlePreloadReservas(fechaBase, dias) {
  if (!fechaBase || !dias || dias < 1) return;
  console.log(`${TAG} 📦 Pre-carga iniciada: ${dias} días desde ${fechaBase}`);
  const t0 = Date.now();
  const fechas = [];
  for (let i = 1; i <= dias; i++) fechas.push(addDaysISO(fechaBase, i));

  let cargados = 0;
  for (let i = 0; i < fechas.length; i += PRELOAD_BATCH) {
    const batch = fechas.slice(i, i + PRELOAD_BATCH);
    const resultados = await Promise.all(batch.map(async f => {
      try {
        const r = await getReservasPorFecha({ fecha: f });
        return [f, (r?.ok ? r.reservas : []) || []];
      } catch (e) {
        return [f, []];
      }
    }));
    const porFecha = {};
    for (const [f, reservas] of resultados) porFecha[f] = reservas;
    cargados += batch.length;
    sendResponse('reservas-rango', { porFecha });
  }
  console.log(`${TAG} ✅ Pre-carga completa: ${cargados} días en ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// =====================================================
// CLIENTES — buscar (in-memory) — sin cambios respecto a v0.2.2
// =====================================================
function handleBuscarCliente(msg) {
  const q = String(msg?.query || '').trim().toLowerCase();
  if (!_cacheReady) {
    sendResponse('clientes-encontrados', { clientes: [], cacheReady: false });
    return;
  }
  if (q.length < 2) {
    sendResponse('clientes-encontrados', { clientes: [], cacheReady: true });
    return;
  }
  const qPhone = q.replace(/[\s\-\(\)]/g, '');
  const filtered = _cacheContactos.filter(c => {
    const n = (c.nombreCompleto || '').toLowerCase();
    const e = (c.email || '').toLowerCase();
    const t = (c.telefono || '').replace(/[\s\-\(\)]/g, '');
    return n.includes(q) || e.includes(q) || t.includes(qPhone);
  });
  sendResponse('clientes-encontrados', {
    clientes: filtered.slice(0, 20),
    total: filtered.length,
    cacheReady: true
  });
}

// =====================================================
// CLIENTES — crear nuevo — sin cambios respecto a v0.2.2
// =====================================================
async function handleCrearContacto(msg) {
  try {
    const result = await crearContacto({
      nombre: msg.nombre || '',
      apellido: msg.apellido || '',
      telefono: msg.telefono || '',
      email: msg.email || ''
    });
    if (result?.ok && result?.cliente) {
      _cacheContactos.push(result.cliente);
    }
    sendResponse('contacto-creado', { data: result || { ok: false } });
  } catch (e) {
    sendResponse('contacto-creado', { data: { ok: false, error: { message: e?.message } } });
  }
}

// =====================================================
// ENSURE CONTACT ID — patrón producción
// =====================================================
async function ensureContactId(msg) {
  if (msg.memberContactId) return msg.memberContactId;
  const cd = msg.contactDetails || {};
  if (!cd.firstName && !cd.phone && !cd.email) return null;
  try {
    const res = await crearContacto({
      nombre: cd.firstName || '',
      apellido: cd.lastName || '',
      telefono: cd.phone || '',
      email: cd.email || ''
    });
    if (res?.ok && res?.contactId) {
      if (res.cliente) _cacheContactos.push(res.cliente);
      return res.contactId;
    }
  } catch (e) { /* silencioso */ }
  return null;
}

// =====================================================
// CREAR RESERVA — llamada única a crearPackReserva (V2 CMS-first)
//   Mismo patrón que pagecode_recepcionProCMS v1.0.15 (desktop V2).
// =====================================================
async function handleCrearReserva(msg) {
  const {
    principalSetupUid,
    complementosSetupUid = [],
    fechaISO,
    horaHHmm,
    empleadoId,
    staffName = '',
    contactDetails = {},
    memberContactId = '',
    notas = '',
    esProvisional = false
  } = msg || {};

  if (!principalSetupUid || !fechaISO || !horaHHmm || !empleadoId) {
    sendResponse('reserva-creada', {
      ok: false,
      error: { message: 'Faltan parámetros obligatorios (principalSetupUid/fechaISO/horaHHmm/empleadoId)' }
    });
    return;
  }

  try {
    const cidReal = await ensureContactId({ memberContactId, contactDetails });
    const memberContactIdFinal = cidReal || memberContactId || null;

    const result = await crearPackReserva({
      fecha: fechaISO,
      horaHHmm,
      principalSetupUid,
      complementosSetupUid: Array.isArray(complementosSetupUid) ? complementosSetupUid : [],
      staffId: empleadoId,
      staffName,
      contactDetails,
      memberContactId: memberContactIdFinal,
      notas,
      esProvisional: !!esProvisional,
      origenRecepcion: true
    });

    sendResponse('reserva-creada', result || {
      ok: false,
      error: { message: 'Sin respuesta del backend' }
    });

    if (result?.ok) {
      setTimeout(() => { handleGetReservasDia(fechaISO); }, 800);
    }
  } catch (e) {
    console.error(`${TAG} ❌ handleCrearReserva:`, e?.message);
    sendResponse('reserva-creada', { ok: false, error: { message: e?.message || 'Error creando reserva' } });
  }
}

// =====================================================
// SETTINGS (CalendarViewSettings) — CMS directo, sin backend
//   Copia literal de pagecode_recepcionProCMS v1.0.15 líneas 436-474.
//   Lee/escribe settings por usuario (filtrado por _owner).
//   Estructura del CMS: { _id, _owner, title, settingsJson }
// =====================================================

async function _getMemberId() {
  try {
    const m = await currentMember.getMember();
    return m?._id || null;
  } catch (e) { return null; }
}

async function handleGetSettings() {
  try {
    const memberId = await _getMemberId();
    let q = wixData.query('CalendarViewSettings');
    if (memberId) q = q.eq('_owner', memberId);
    const r = await q.limit(1).find({ suppressAuth: true });
    if (r.items && r.items.length) {
      let parsed = null;
      try { parsed = JSON.parse(r.items[0].settingsJson || '{}'); } catch (e) { parsed = null; }
      sendResponse('settings-data', { settings: parsed });
    } else {
      sendResponse('settings-data', { settings: null });
    }
  } catch (e) {
    console.error(`${TAG} ❌ get-settings:`, e);
    sendResponse('settings-data', { settings: null });
  }
}

async function handleSaveSettings(settings) {
  try {
    const memberId = await _getMemberId();
    let existingId = null;
    let q = wixData.query('CalendarViewSettings');
    if (memberId) q = q.eq('_owner', memberId);
    const r = await q.limit(1).find({ suppressAuth: true });
    if (r.items && r.items.length) existingId = r.items[0]._id;

    const payload = {
      title: 'recepcionLiteMobile-' + (memberId || 'shared'),
      settingsJson: JSON.stringify(settings || {})
    };
    if (existingId) payload._id = existingId;

    await wixData.save('CalendarViewSettings', payload, { suppressAuth: true });
  } catch (e) {
    console.error(`${TAG} ❌ save-settings:`, e);
  }
}

// =====================================================
// CANCELAR RESERVA (v0.3.2)
//   Mismo patrón que pagecode_recepcionProCMS v1.0.15 líneas 260-268.
// =====================================================
async function handleCancelarReserva(msg) {
  const reservaId = msg?.reservaId;
  if (!reservaId) {
    sendResponse('reserva-cancelada', { ok: false, error: { message: 'Falta reservaId' } });
    return;
  }
  try {
    const result = await cancelarReserva({ reservaId });
    sendResponse('reserva-cancelada', result || { ok: false });
  } catch (e) {
    console.error(`${TAG} ❌ cancelarReserva:`, e?.message);
    sendResponse('reserva-cancelada', { ok: false, error: { message: e?.message || 'Error' } });
  }
}

// =====================================================
// BLOQUEOS (v0.3.3) — copia LITERAL del page code desktop v1.0.17
//   Backend: recepcionProLogic.web v1.0.20.
//   Las 3 funciones insertan/borran/actualizan filas en
//   KamisuiteReservations con family:'BLOQUEO'. El motor público
//   (widgetPublicoLogic v0.6.2) ya las trata como bloqueos efectivos.
// =====================================================
async function handleCrearBloqueo(msg) {
  try {
    const result = await crearBloqueo({
      fechaISO: msg.fechaISO,
      horaHHmm: msg.horaHHmm,
      duracionMin: msg.duracionMin,
      staffId: msg.staffId,
      motivo: msg.motivo
    });
    sendResponse('bloqueoCreado', result);
  } catch (e) {
    console.error(`${TAG} ❌ crearBloqueo:`, e);
    sendResponse('bloqueoCreado', { ok: false, error: { message: e?.message || 'Error' } });
  }
}

async function handleEliminarBloqueo(msg) {
  try {
    const result = await eliminarBloqueo({ id: msg.id });
    sendResponse('bloqueoEliminado', result);
  } catch (e) {
    console.error(`${TAG} ❌ eliminarBloqueo:`, e);
    sendResponse('bloqueoEliminado', { ok: false, error: { message: e?.message || 'Error' } });
  }
}

async function handleActualizarBloqueo(msg) {
  try {
    const result = await actualizarBloqueo({
      id: msg.id,
      fechaISO: msg.fechaISO,
      horaHHmm: msg.horaHHmm,
      duracionMin: msg.duracionMin,
      motivo: msg.motivo
    });
    sendResponse('bloqueoActualizado', result);
  } catch (e) {
    console.error(`${TAG} ❌ actualizarBloqueo:`, e);
    sendResponse('bloqueoActualizado', { ok: false, error: { message: e?.message || 'Error' } });
  }
}

// =====================================================
// MOUNT
// =====================================================
$w.onReady(() => {
  console.log(`${TAG} 👂 Listener activo`);
$w('#f6B6E28D52B24De6Aab3Ff2Ccad8E2291').hide()
  _el = $w('#kamisuiteBookingLite');
  if (!_el) { console.error(`${TAG} ❌ Elemento #kamisuiteBookingLite no encontrado.`); return; }

  _el.on('booking-message', (event) => {
    const msg = event?.detail || {};
    if (!msg.type) return;
    try {
      switch (msg.type) {
        case 'ready':              handleReady(); break;
        case 'get-reservas-dia':   handleGetReservasDia(msg.fecha); break;
        case 'preload-reservas':   handlePreloadReservas(msg.fechaBase, msg.dias); break;
        case 'buscar-cliente':     handleBuscarCliente(msg); break;
        case 'crear-contacto':     handleCrearContacto(msg); break;
        case 'crear-reserva':      handleCrearReserva(msg); break;
        case 'get-settings':       handleGetSettings(); break;
        case 'save-settings':      handleSaveSettings(msg.settings); break;
        case 'cancelar-reserva':   handleCancelarReserva(msg); break;
        case 'crearBloqueo':       handleCrearBloqueo(msg); break;
        case 'eliminarBloqueo':    handleEliminarBloqueo(msg); break;
        case 'actualizarBloqueo':  handleActualizarBloqueo(msg); break;
        default: console.warn(`${TAG} ⚠️ Tipo desconocido: ${msg.type}`);
      }
    } catch (err) {
      console.error(`${TAG} ❌ Error handler ${msg.type}:`, err?.message);
      sendResponse('error', { message: err?.message || 'Error inesperado' });
    }
  });

  // Kickoff proactivo
  handleReady();
});

