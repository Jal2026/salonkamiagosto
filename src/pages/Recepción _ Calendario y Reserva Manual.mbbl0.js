// =====================================================
// KAMISUITE — Page Code: Agenda (Fusión Calendar Vista + Check-in)
// =====================================================
// VERSION: 1.3.0
// FECHA: 31 de marzo de 2026
//
// v1.0.0: Base fusionada
// v1.1.0: Handler rescheduleBooking (nombres desalineados — corregido)
// v1.2.0: Fix nombres mensaje: moverBooking ↔ bookingMovido
//         Auto-refresh con preserveScroll tras mover
// v1.3.0: getServiceInfo — lee precio/duración de Wix Bookings en tiempo real
//         Elimina dependencia de data-dur/data-price hardcodeados en widget
//
// Widget HTML: agenda_kamisuite_v1_3_0.html
// HTML Component: #htmlAgenda
// Backends: calendarioVista.web.js, recepcionLogic.web,
//           coloracionLogic.web, tratamientosLogic.web,
//           simplesLogic.web, calendarioLogic.web,
//           testCheckout.web (cambiarFechaBookings),
//           diagnosticoServicios.web (listarServicios)
// =====================================================

// ── Calendar Vista backend ──
import {
  getStaffResources as getCalStaff,
  getTodasReservasDia,
  getCalendarioSettings,
  saveCalendarioSettings,
  crearExtension,
  eliminarExtension
} from 'backend/calendarioVista.web.js';

// ── Recepción / Contactos ──
import { cargarTodosContactos, crearContacto } from 'backend/recepcionLogic.web';

// ── Coloración ──
import {
  getStaffResources as getStaffColor,
  getMapeoMechas,
  consultarDisponibilidadUnificada as consultarColor,
  confirmarEnCalendario as confirmarColor
} from 'backend/coloracionLogic.web';

// ── Tratamientos ──
import {
  getStaffResources as getStaffTrat,
  getMapeoTratamiento,
  consultarDisponibilidadUnificada as consultarTrat,
  confirmarEnCalendario as confirmarTrat
} from 'backend/tratamientosLogic.web';

// ── Ocupados (lectura por staff) ──
import { getBookingsDelDia } from 'backend/calendarioLogic.web';

// ── Simples ──
import {
  getVariantsCMS,
  consultarDisponibilidadSimple,
  reservarSimple as reservarSimpleBackend
} from 'backend/simplesLogic.web';

// ── v1.1.0: Reschedule (drag & drop) ──
import { cambiarFechaBookings } from 'backend/testCheckout.web';

// ── v1.3.0: Lectura precio/duración real de Wix Bookings ──
import { listarServicios } from 'backend/diagnosticoServicios.web';

const TAG = '[AgendaPage][v1.3.0]';

// =====================================================
// STATE
// =====================================================

let cachedStaff = null;
let staffScheduleMap = {};
let externalResourceIds = [];
let cacheContactos = [];
let cacheReady = false;
// v1.3.0: Caché de servicios de Wix Bookings
let cachedServicios = null;

// =====================================================
// HELPERS
// =====================================================

function sendToWidget(type, data = {}) {
  try {
    $w('#htmlAgenda').postMessage({ type, ...data });
  } catch (e) {
    console.error(`${TAG} ❌ sendToWidget(${type}):`, e.message);
  }
}

// =====================================================
// CALENDAR: Staff (para calendario visual)
// =====================================================

async function handleGetStaffCalendar() {
  try {
    console.log(`${TAG} 👥 Calendar staff...`);
    const result = await getCalStaff();

    if (!result.ok) {
      sendToWidget('error', { message: result.error?.message || 'Error staff' });
      return;
    }

    cachedStaff = result.staff;
    staffScheduleMap = {};
    externalResourceIds = [];
    for (const s of cachedStaff) {
      if (s.scheduleId) staffScheduleMap[s.scheduleId] = s.id;
      if (s.isExternal) externalResourceIds.push(s.id);
    }

    console.log(`${TAG} ✅ ${cachedStaff.length} staff | ${Object.keys(staffScheduleMap).length} schedules | ${externalResourceIds.length} externos`);
    sendToWidget('staff-data', { staff: cachedStaff });

  } catch (e) {
    console.error(`${TAG} ❌ getStaff:`, e);
    sendToWidget('error', { message: e.message });
  }
}

// =====================================================
// CALENDAR: Reservas del día
// =====================================================

async function handleGetReservas(fecha) {
  try {
    if (!fecha) {
      const d = new Date();
      fecha = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    console.log(`${TAG} 📅 Reservas: ${fecha} | schedules: ${Object.keys(staffScheduleMap).length} | externos: ${externalResourceIds.length}`);
    const result = await getTodasReservasDia({ fecha, staffScheduleMap, externalResourceIds });

    if (!result.ok) {
      sendToWidget('error', { message: result.error?.message || 'Error reservas' });
      return;
    }

    console.log(`${TAG} ✅ ${result.totalBookings} reservas + ${result.totalBloqueos} bloqueos (${result.tiempo}s)`);
    sendToWidget('reservas-data', { reservas: result.reservas });

  } catch (e) {
    console.error(`${TAG} ❌ getReservas:`, e);
    sendToWidget('error', { message: e.message });
  }
}

// =====================================================
// CALENDAR: Settings CMS
// =====================================================

async function handleGetSettings() {
  try {
    console.log(`${TAG} ⚙️ Cargando settings...`);
    const result = await getCalendarioSettings();
    sendToWidget('settings-data', { settings: result.ok ? result.settings : null });
  } catch (e) {
    console.error(`${TAG} ❌ getSettings:`, e);
    sendToWidget('settings-data', { settings: null });
  }
}

async function handleSaveSettings(settings) {
  try {
    console.log(`${TAG} 💾 Guardando settings...`);
    const result = await saveCalendarioSettings({ settings });
    if (!result.ok) {
      console.error(`${TAG} ⚠️ Error guardando settings:`, result.error?.message);
    } else {
      console.log(`${TAG} ✅ Settings guardados en CMS`);
    }
  } catch (e) {
    console.error(`${TAG} ❌ saveSettings:`, e);
  }
}

// =====================================================
// CLIENTS: Cache + Search + Create
// =====================================================

async function cargarCache() {
  console.log(`${TAG} 📥 Cargando caché de contactos...`);
  sendToWidget('loading', { message: 'Cargando base de clientes...' });

  try {
    const result = await cargarTodosContactos();

    if (result.ok) {
      cacheContactos = result.clientes || [];
      cacheReady = true;
      console.log(`${TAG} ✅ Caché cargada: ${cacheContactos.length} contactos`);
      sendToWidget('cacheReady', { total: cacheContactos.length });
    } else {
      console.error(`${TAG} ❌ Error cargando caché:`, result.error);
      sendToWidget('error', { message: 'Error cargando base de clientes' });
    }
  } catch (e) {
    console.error(`${TAG} ❌ Error cargando caché:`, e);
    sendToWidget('error', { message: 'Error cargando base de clientes' });
  }
}

function buscarLocal(query) {
  if (!cacheReady) return { ok: false, message: 'Caché no lista' };
  const searchTerm = String(query).trim().toLowerCase();
  if (searchTerm.length < 2) return { ok: true, clientes: [], message: 'Mínimo 2 caracteres' };
  const searchPhone = searchTerm.replace(/[\s\-\(\)]/g, '');
  const filtered = cacheContactos.filter(c => {
    const nombre = (c.nombreCompleto || '').toLowerCase();
    const email = (c.email || '').toLowerCase();
    const telefono = (c.telefono || '').replace(/[\s\-\(\)]/g, '');
    return nombre.includes(searchTerm) || email.includes(searchTerm) || telefono.includes(searchPhone);
  });
  const limitados = filtered.slice(0, 20);
  return { ok: true, clientes: limitados, totalEncontrados: filtered.length, mostrados: limitados.length };
}

function handleSearch(msg) {
  console.log(`${TAG} 🔍 Buscando local: "${msg.query}"`);
  const result = buscarLocal(msg.query);
  if (result.ok) {
    console.log(`${TAG} ✅ Encontrados: ${result.totalEncontrados} (mostrando ${result.mostrados})`);
    sendToWidget('clientesEncontrados', { clientes: result.clientes, totalEncontrados: result.totalEncontrados, mostrados: result.mostrados });
  } else {
    sendToWidget('clientesEncontrados', { clientes: [] });
  }
}

async function handleCrearContacto(msg) {
  try {
    console.log(`${TAG} ➕ Crear contacto: ${msg.nombre} ${msg.apellido}`);
    const result = await crearContacto({ nombre: msg.nombre, apellido: msg.apellido, telefono: msg.telefono, email: msg.email });
    if (result.ok) { cacheContactos.push(result.cliente); console.log(`${TAG} ✅ Contacto creado y añadido a caché: ${result.contactId}`); }
    sendToWidget('contactoCreado', { data: result });
  } catch (e) {
    console.error(`${TAG} ❌ crearContacto:`, e.message);
    sendToWidget('contactoCreado', { data: { ok: false, error: { message: e.message } } });
  }
}

// =====================================================
// HANDLER — getStaff (para sidebar servicios)
// =====================================================

async function handleGetStaff(msg) {
  try {
    console.log(`${TAG} 👥 Cargando staff para ${msg.familia}/${msg.serviceId}`);
    let staffResult; let assignedStaffIds = [];
    if (msg.familia === 'coloracion') {
      const mapeoResult = await getMapeoMechas({ serviceId: msg.serviceId });
      if (mapeoResult.ok && mapeoResult.assignedStaffIds) assignedStaffIds = mapeoResult.assignedStaffIds;
      staffResult = await getStaffColor();
    } else if (msg.familia === 'tratamiento') {
      const mapeoResult = await getMapeoTratamiento({ serviceId: msg.serviceId });
      if (mapeoResult.ok && mapeoResult.assignedStaffIds) assignedStaffIds = mapeoResult.assignedStaffIds;
      staffResult = await getStaffTrat();
    } else { staffResult = await getStaffColor(); }
    if (!staffResult?.ok) { sendToWidget('staffCargado', { staff: [] }); return; }
    let filteredStaff = staffResult.staff.filter(s => s?.label && s?.resourceId);
    if (assignedStaffIds.length > 0) { const assignedSet = new Set(assignedStaffIds); filteredStaff = filteredStaff.filter(s => assignedSet.has(s.resourceId)); }
    sendToWidget('staffCargado', { staff: filteredStaff });
    console.log(`${TAG} ✅ Staff cargado: ${filteredStaff.length}`);
  } catch (e) {
    console.error(`${TAG} ❌ getStaff:`, e.message);
    sendToWidget('staffCargado', { staff: [] });
  }
}

// =====================================================
// v1.3.0: HANDLER — getServiceInfo (precio/duración de Wix Bookings)
// =====================================================

async function handleGetServiceInfo(msg) {
  try {
    const serviceId = msg.serviceId;
    if (!serviceId) return;

    console.log(`${TAG} 📋 getServiceInfo: ${serviceId}`);

    // Caché: listarServicios solo se llama una vez
    if (!cachedServicios) {
      console.log(`${TAG} 🔄 Cargando catálogo de servicios (primera vez)...`);
      const result = await listarServicios();
      if (result.ok) {
        cachedServicios = result.servicios || [];
        console.log(`${TAG} ✅ Catálogo cacheado: ${cachedServicios.length} servicios`);
      } else {
        console.error(`${TAG} ❌ listarServicios falló:`, result.error);
        sendToWidget('serviceInfoLoaded', { serviceId, duration: null, price: null });
        return;
      }
    }

    const svc = cachedServicios.find(s => s.id === serviceId);
    if (svc) {
      const price = svc.defaultPrice ? parseFloat(svc.defaultPrice) : null;
      const duration = svc.duration || null;
      const hasVariants = svc.rateType === 'VARIED' && svc.variants && svc.variants.length > 0;
      console.log(`${TAG} ✅ ${svc.name}: ${duration}min | ${price}€ | variants=${hasVariants}`);
      sendToWidget('serviceInfoLoaded', { serviceId, duration, price, name: svc.name, hasVariants });
    } else {
      console.warn(`${TAG} ⚠️ Servicio ${serviceId} no encontrado en catálogo`);
      sendToWidget('serviceInfoLoaded', { serviceId, duration: null, price: null });
    }
  } catch (e) {
    console.error(`${TAG} ❌ getServiceInfo:`, e.message);
    sendToWidget('serviceInfoLoaded', { serviceId: msg.serviceId, duration: null, price: null });
  }
}

// =====================================================
// HANDLERS — Consultar disponibilidad
// =====================================================

async function handleConsultarColoracion(msg) {
  try {
    console.log(`${TAG} 📅 Consultar coloración: ${msg.publicServiceId}`);
    const result = await consultarColor({ publicServiceId: msg.publicServiceId, fecha: msg.fecha, staffId: msg.staffId, staff2Id: msg.staff2Id, complementos: { peinadoKey: msg.peinado || null, tratamientoKey: msg.tratamiento || null, corte: msg.corte || false, total: msg.tinteCompleto || false } });
    sendToWidget('slotsDisponibles', { data: result });
  } catch (e) {
    console.error(`${TAG} ❌ consultarColoracion:`, e.message);
    sendToWidget('slotsDisponibles', { data: { ok: false, error: { message: e.message } } });
  }
}

async function handleConsultarTratamiento(msg) {
  try {
    console.log(`${TAG} 📅 Consultar tratamiento: ${msg.publicServiceId}`);
    const result = await consultarTrat({ publicServiceId: msg.publicServiceId, fecha: msg.fecha, staffId: msg.staffId, staff2Id: msg.staff2Id, complementos: { longitudPelo: msg.longitudPelo || 'M', corte: msg.corte || false } });
    sendToWidget('slotsDisponibles', { data: result });
  } catch (e) {
    console.error(`${TAG} ❌ consultarTratamiento:`, e.message);
    sendToWidget('slotsDisponibles', { data: { ok: false, error: { message: e.message } } });
  }
}

async function ensureContactId(msg) {
  if (msg.memberContactId) return msg.memberContactId;
  const cd = msg.contactDetails || {};
  if (!cd.firstName && !cd.phone && !cd.email) return null;
  try {
    console.log(`${TAG} 🔍 ensureContactId: buscando/creando contacto...`);
    const res = await crearContacto({ nombre: cd.firstName || '', apellido: cd.lastName || '', telefono: cd.phone || '', email: cd.email || '' });
    if (res?.ok && res?.contactId) { cacheContactos.push(res.cliente); console.log(`${TAG} ✅ ContactId obtenido: ${res.contactId}`); return res.contactId; }
  } catch (e) { console.error(`${TAG} ⚠️ ensureContactId falló:`, e.message); }
  return null;
}

// =====================================================
// HANDLERS — Reservar
// =====================================================

async function handleReservarColoracion(msg) {
  try {
    console.log(`${TAG} 🎯 Reservar coloración: ${msg.publicServiceId}`);
    msg.memberContactId = await ensureContactId(msg);
    const result = await confirmarColor({ publicServiceId: msg.publicServiceId, fechaISO: msg.fechaISO, horaHHmm: msg.horaHHmm, empleadoId: msg.empleadoId, empleado2Id: msg.empleado2Id, peinadoValue: msg.peinadoValue, tratamientoValue: msg.tratamientoValue, corteChecked: msg.corteChecked, totalChecked: msg.totalChecked, contactDetails: msg.contactDetails, modoPago: msg.modoPago, guardarNota: msg.guardarNota || false, memberContactId: msg.memberContactId, origenRecepcion: true });
    sendToWidget('reservaCompletada', { data: result });
  } catch (e) {
    console.error(`${TAG} ❌ reservarColoracion:`, e.message);
    sendToWidget('reservaCompletada', { data: { ok: false, error: { message: e.message } } });
  }
}

async function handleReservarTratamiento(msg) {
  try {
    console.log(`${TAG} 🎯 Reservar tratamiento`);
    msg.memberContactId = await ensureContactId(msg);
    const result = await confirmarTrat({ publicServiceId: msg.publicServiceId, fechaISO: msg.fechaISO, horaHHmm: msg.horaHHmm, empleadoId: msg.empleadoId, empleado2Id: msg.empleado2Id, longitudPelo: msg.longitudPelo, corteChecked: msg.corteChecked, contactDetails: msg.contactDetails, modoPago: msg.modoPago, guardarNota: msg.guardarNota || false, memberContactId: msg.memberContactId, origenRecepcion: true });
    sendToWidget('reservaCompletada', { data: result });
  } catch (e) {
    console.error(`${TAG} ❌ reservarTratamiento:`, e.message);
    sendToWidget('reservaCompletada', { data: { ok: false, error: { message: e.message } } });
  }
}

async function handleConsultarOcupados(msg) {
  try {
    console.log(`${TAG} 🔍 Consultar ocupados: ${msg.fecha} | Staff: ${msg.staffId}${msg.modoTodos ? ' [TODOS]' : ''}`);
    const result = await getBookingsDelDia({ fecha: msg.fecha, staffId: msg.staffId });
    sendToWidget('ocupadosCargados', { data: result, staffLabel: msg.staffLabel || '', modoTodos: msg.modoTodos || false });
  } catch (e) {
    console.error(`${TAG} ❌ consultarOcupados:`, e.message);
    sendToWidget('ocupadosCargados', { data: { ok: false, error: { message: e.message } }, staffLabel: msg.staffLabel || '', modoTodos: msg.modoTodos || false });
  }
}

async function handleGetVariants(msg) {
  try {
    console.log(`${TAG} 📋 Variantes para ${msg.serviceId}`);
    const result = await getVariantsCMS({ serviceId: msg.serviceId });
    sendToWidget('variantesCargadas', { variants: result.variants || [] });
  } catch (e) {
    console.error(`${TAG} ❌ getVariants:`, e.message);
    sendToWidget('variantesCargadas', { variants: [] });
  }
}

async function handleConsultarSimple(msg) {
  try {
    console.log(`${TAG} 📅 Consultar simple: ${msg.serviceId} | ${msg.fecha} | staff=${msg.staffId} | dur=${msg.durationMinutes}min`);
    const result = await consultarDisponibilidadSimple({ serviceId: msg.serviceId, fecha: msg.fecha, staffId: msg.staffId, durationMinutes: msg.durationMinutes });
    if (result.ok) result.precio = { total: msg.price };
    sendToWidget('slotsDisponibles', { data: result });
  } catch (e) {
    console.error(`${TAG} ❌ consultarSimple:`, e.message);
    sendToWidget('slotsDisponibles', { data: { ok: false, error: { message: e.message } } });
  }
}

async function handleReservarSimple(msg) {
  try {
    console.log(`${TAG} 🎯 Reservar simple: ${msg.serviceId} | ${msg.fechaISO} ${msg.horaHHmm}`);
    msg.memberContactId = await ensureContactId(msg);
    const result = await reservarSimpleBackend({ serviceId: msg.serviceId, fechaISO: msg.fechaISO, horaHHmm: msg.horaHHmm, empleadoId: msg.empleadoId, durationMinutes: msg.durationMinutes, price: msg.price, variantLabel: msg.variantLabel, contactDetails: msg.contactDetails, modoPago: msg.modoPago, memberContactId: msg.memberContactId, origenRecepcion: true });
    sendToWidget('reservaCompletada', { data: result });
  } catch (e) {
    console.error(`${TAG} ❌ reservarSimple:`, e.message);
    sendToWidget('reservaCompletada', { data: { ok: false, error: { message: e.message } } });
  }
}

async function handleCalcPrecio(msg) {
  try {
    const serviceIds = msg.serviceIds || [];
    if (serviceIds.length === 0) return;
    console.log(`${TAG} 💰 Calcular precio: ${serviceIds.length} servicios`);
    console.log(`${TAG} ℹ️ Precio se obtiene del motor de disponibilidad`);
  } catch (e) { console.error(`${TAG} ❌ calcPrecio:`, e.message); }
}

// =====================================================
// EXTENSIONES
// =====================================================

async function handleCrearExtension(msg) {
  try {
    console.log(`${TAG} ➕ Crear extensión: ${msg.fecha} ${msg.horaInicio} +${msg.duracionMin}min`);
    const staff = cachedStaff || [];
    const s = staff.find(x => x.id === msg.resourceId);
    if (!s || !s.scheduleId) { sendToWidget('extensionCreada', { ok: false, error: { message: 'No se encontró scheduleId del empleado' } }); return; }
    const result = await crearExtension({ fecha: msg.fecha, horaInicio: msg.horaInicio, duracionMin: msg.duracionMin, scheduleId: s.scheduleId, bookingId: msg.bookingId || '', notes: msg.notes || '' });
    sendToWidget('extensionCreada', result);
    if (result.ok) console.log(`${TAG} ✅ Extensión creada, refrescando...`);
  } catch (e) {
    console.error(`${TAG} ❌ crearExtension:`, e.message);
    sendToWidget('extensionCreada', { ok: false, error: { message: e.message } });
  }
}

async function handleEliminarExtension(msg) {
  try {
    console.log(`${TAG} ➖ Eliminar extensión: ${msg.sessionId}`);
    const result = await eliminarExtension({ sessionId: msg.sessionId });
    sendToWidget('extensionEliminada', result);
    if (result.ok) console.log(`${TAG} ✅ Extensión eliminada, refrescando...`);
  } catch (e) {
    console.error(`${TAG} ❌ eliminarExtension:`, e.message);
    sendToWidget('extensionEliminada', { ok: false, error: { message: e.message } });
  }
}

// =====================================================
// v1.2.0: MOVER BOOKING (drag & drop)
// Widget envía: moverBooking
// Widget espera: bookingMovido
// =====================================================

async function handleMoverBooking(msg) {
  try {
    console.log(`${TAG} 📅 moverBooking: ${msg.bookingId} → ${msg.nuevaFechaISO} ${msg.nuevaHoraHHmm} | staff=${msg.nuevoStaffId}`);

    const servicios = [{
      bookingId: msg.bookingId,
      staffId: msg.nuevoStaffId
    }];

    const result = await cambiarFechaBookings({
      servicios,
      nuevaFechaISO: msg.nuevaFechaISO,
      nuevaHoraHHmm: msg.nuevaHoraHHmm,
      forzado: true
    });

    if (result?.ok) {
      console.log(`${TAG} ✅ Booking movido OK`);
      sendToWidget('bookingMovido', { ok: true, mensaje: result.mensaje || 'Reserva movida ✓' });
    } else {
      console.error(`${TAG} ⚠️ Error moviendo booking:`, result?.error);
      sendToWidget('bookingMovido', { ok: false, error: result?.error || 'Error al mover' });
    }
  } catch (e) {
    console.error(`${TAG} ❌ moverBooking:`, e.message);
    sendToWidget('bookingMovido', { ok: false, error: e.message });
  }
}

// =====================================================
// ON READY
// =====================================================

$w.onReady(function () {
  console.log(`${TAG} ✅ Page ready`);

  $w('#htmlAgenda').onMessage(async (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;

    console.log(`${TAG} 📨 Mensaje: ${msg.type}`);

    switch (msg.type) {
      case 'get-staff': await handleGetStaffCalendar(); break;
      case 'get-reservas': await handleGetReservas(msg.fecha); break;
      case 'get-settings': await handleGetSettings(); break;
      case 'save-settings': await handleSaveSettings(msg.settings); break;
      case 'ready': if (cacheReady) sendToWidget('cacheReady', { total: cacheContactos.length }); break;
      case 'buscarCliente': handleSearch(msg); break;
      case 'crearContacto': await handleCrearContacto(msg); break;
      case 'getStaff': await handleGetStaff(msg); break;
      // v1.3.0: Lectura precio/duración de Wix Bookings
      case 'getServiceInfo': await handleGetServiceInfo(msg); break;
      case 'consultarColoracion': await handleConsultarColoracion(msg); break;
      case 'consultarTratamiento': await handleConsultarTratamiento(msg); break;
      case 'consultarSimple': await handleConsultarSimple(msg); break;
      case 'reservarColoracion': await handleReservarColoracion(msg); break;
      case 'reservarTratamiento': await handleReservarTratamiento(msg); break;
      case 'reservarSimple': await handleReservarSimple(msg); break;
      case 'consultarOcupados': await handleConsultarOcupados(msg); break;
      case 'getVariants': await handleGetVariants(msg); break;
      case 'calcularPrecio': await handleCalcPrecio(msg); break;
      case 'crearExtension': await handleCrearExtension(msg); break;
      case 'eliminarExtension': await handleEliminarExtension(msg); break;
      // ── v1.2.0: Drag & drop mover booking ──
      case 'moverBooking': await handleMoverBooking(msg); break;
      default: console.warn(`${TAG} ⚠️ Tipo desconocido: ${msg.type}`);
    }
  });

  cargarCache();
  console.log(`${TAG} 👂 Listener activo, caché iniciada`);
});