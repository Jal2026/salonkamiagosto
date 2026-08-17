// =====================================================
// KAMISUITE - Page Code: AKIRA Console IA
// Página: /kamisuite-console
// =====================================================
// VERSION: 1.4.0
// FECHA: 23 Abril 2026
//
// CHANGELOG:
//   v1.4.0 - ACCIONES: reserva simple añadida
//     - "reserva" en ACTION_CATEGORIES
//     - buildConfirmMessage para reserva con servicio + empleado + fecha + hora + cliente
//     - handleActionExecute llama ejecutarReservaSimple
//   v1.3.0 - ACCIONES: flujo de confirmación + bloqueo
//   v1.2.0 - SPLIT: akiraClassify + akiraRespond
//   v1.1.0 - Soporte historial conversacional
//   v1.0.0 - Versión inicial
// =====================================================

import wixUsers from 'wix-users';
import wixWindow from 'wix-window';
import { akiraClassify, akiraRespond } from 'backend/consoleIA.web';
import { ejecutarBloqueo, ejecutarReservaSimple, ejecutarReservaColor } from 'backend/akiraAcciones.web';

const TAG = '[PageCode_ConsoleIA][1.5.0]';

// Categorías que son acciones (no consultas)
const ACTION_CATEGORIES = new Set(['bloqueo', 'reserva', 'reserva_color']);

// Acción pendiente de confirmación
let pendingAction = null;

// ─────────────────────────────────────────────
// INICIALIZACIÓN
// ─────────────────────────────────────────────

$w.onReady(async () => {
  console.log(`${TAG} onReady`);

  const loggedIn = wixUsers.currentUser.loggedIn;
  if (!loggedIn) {
    console.warn(`${TAG} Usuario no autenticado — redirigiendo`);
    wixWindow.openLightbox('Login').catch(() => {});
    return;
  }

  console.log(`${TAG} Usuario autenticado: ${wixUsers.currentUser.id}`);

  $w('#htmlConsoleIA').onMessage(handleWidgetMessage);
  $w('#htmlConsoleIA').postMessage({ type: 'SESSION_READY' });

  console.log(`${TAG} Console IA lista`);
});

// ─────────────────────────────────────────────
// HANDLER: Mensajes del widget
// ─────────────────────────────────────────────

async function handleWidgetMessage(event) {
  const data = event.data;
  if (!data || !data.type) return;

  console.log(`${TAG} Mensaje recibido: ${data.type}`);

  if (data.type === 'AKIRA_QUERY') {
    await handleQuery(data.query, data.messageId, data.history);
  }

  if (data.type === 'AKIRA_ACTION_EXECUTE') {
    await handleActionExecute(data.messageId);
  }

  if (data.type === 'AKIRA_ACTION_CANCEL') {
    handleActionCancel(data.messageId);
  }
}

// ─────────────────────────────────────────────
// HANDLER: Consulta o Acción
// ─────────────────────────────────────────────

async function handleQuery(query, messageId, history) {
  if (!query || typeof query !== 'string') {
    sendToWidget({ type: 'AKIRA_ERROR', messageId, error: 'Consulta vacía' });
    return;
  }

  const safeHistory = history || [];
  console.log(`${TAG} handleQuery [${messageId}]: "${query.substring(0, 60)}..." (history: ${safeHistory.length} msgs)`);

  try {
    // ── FASE 1: Clasificar + fetch datos ──
    console.log(`${TAG} → Fase 1: akiraClassify...`);
    const classifyResult = await akiraClassify({ query, history: safeHistory });

    if (!classifyResult.ok) {
      console.error(`${TAG} akiraClassify error:`, classifyResult.error);
      sendToWidget({
        type: 'AKIRA_ERROR', messageId,
        error: 'Error clasificando la consulta. Inténtalo de nuevo.'
      });
      return;
    }

    const { categoria, params } = classifyResult;
    console.log(`${TAG} → Fase 1 OK: cat=${categoria} (${classifyResult.tiempoClassify}ms)`);

    // ── ¿ES UNA ACCIÓN? → Flujo de confirmación ──
    if (ACTION_CATEGORIES.has(categoria)) {
      console.log(`${TAG} → Acción detectada: ${categoria}`);
      handleActionProposal(categoria, params, messageId);
      return;
    }

    // ── CONSULTA NORMAL → Fase 2: akiraRespond ──
    console.log(`${TAG} → Fase 2: akiraRespond...`);
    const respondResult = await akiraRespond({
      query, categoria, datos: classifyResult.datos, history: safeHistory
    });

    if (respondResult.ok) {
      sendToWidget({
        type: 'AKIRA_RESPONSE', messageId,
        respuesta: respondResult.respuesta,
        categoria: respondResult.categoria,
        timestamp: respondResult.timestamp
      });
    } else {
      console.error(`${TAG} akiraRespond error:`, respondResult.error);
      sendToWidget({
        type: 'AKIRA_ERROR', messageId,
        error: respondResult.respuesta || 'Error generando la respuesta'
      });
    }

  } catch (e) {
    console.error(`${TAG} handleQuery exception:`, e.message);
    sendToWidget({
      type: 'AKIRA_ERROR', messageId,
      error: 'Error interno. Por favor, inténtalo de nuevo.'
    });
  }
}

// ─────────────────────────────────────────────
// ACCIONES: Propuesta de confirmación
// ─────────────────────────────────────────────

function handleActionProposal(categoria, params, messageId) {
  const confirmMessage = buildConfirmMessage(categoria, params);

  if (!confirmMessage) {
    sendToWidget({
      type: 'AKIRA_ERROR', messageId,
      error: 'No se pudieron extraer los datos necesarios para esta acción.'
    });
    return;
  }

  pendingAction = { categoria, params, messageId };
  console.log(`${TAG} → Propuesta: ${confirmMessage}`);

  sendToWidget({
    type: 'AKIRA_ACTION_CONFIRM', messageId,
    message: confirmMessage, action: categoria, params
  });
}

// ── Días/meses para mensajes ──
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function formatFechaConfirm(fecha) {
  if (!fecha) return '?';
  const d = new Date(fecha + 'T12:00:00Z');
  const dow = d.getUTCDay();
  const [, m, dd] = fecha.split('-');
  return `${DIAS[dow]} ${parseInt(dd)} de ${MESES[parseInt(m)]}`;
}

function buildConfirmMessage(categoria, params) {
  // ── BLOQUEO ──
  if (categoria === 'bloqueo') {
    const empleado = params.empleado;
    const fecha = params.fechaISO || params.fecha;
    if (!empleado || !fecha) return null;
    const d = new Date(fecha + 'T12:00:00Z');
    const dow = d.getUTCDay();
    if (dow === 0) return `El domingo ${formatFechaConfirm(fecha)} el salón ya está cerrado.`;
    const horario = dow === 6 ? '10:00-14:00' : '10:00-20:00';
    return `¿Bloquear el ${formatFechaConfirm(fecha)} para ${empleado}? (día completo, ${horario})`;
  }

  // ── RESERVA SIMPLE ──
  if (categoria === 'reserva') {
    const servicio = params.servicio || params.serviceName || '?';
    const empleado = params.empleado;
    const fecha = params.fechaISO || params.fecha;
    const hora = params.hora || params.horaHHmm || '?';
    const cliente = params.cliente || params.nombre || '';

    if (!empleado || !fecha || hora === '?') return null;

    let msg = `¿Reservar ${servicio} con ${empleado} el ${formatFechaConfirm(fecha)} a las ${hora}?`;
    if (cliente) msg += ` Cliente: ${cliente}.`;
    return msg;
  }

  // ── RESERVA COLOR ──
  if (categoria === 'reserva_color') {
    const servicio = params.servicio || params.serviceName || '?';
    const empleado = params.empleado;
    const fecha = params.fechaISO || params.fecha;
    const hora = params.hora || params.horaHHmm || '?';
    const cliente = params.cliente || params.nombre || '';
    const longitud = params.longitudPelo || 'M';
    const corte = params.corte;

    if (!empleado || !fecha || hora === '?') return null;

    let msg = `¿Reservar ${servicio} con ${empleado} el ${formatFechaConfirm(fecha)} a las ${hora}?`;
    if (longitud !== 'M') msg += ` Pelo: ${longitud}.`;
    if (corte === true || corte === 'si' || corte === 'sí') msg += ' Con corte.';
    if (cliente) msg += ` Cliente: ${cliente}.`;
    msg += ' (Modo forzado, sin validar disponibilidad)';
    return msg;
  }

  return null;
}

// ─────────────────────────────────────────────
// ACCIONES: Ejecutar tras confirmación
// ─────────────────────────────────────────────

async function handleActionExecute(messageId) {
  if (!pendingAction) {
    sendToWidget({ type: 'AKIRA_ERROR', messageId, error: 'No hay acción pendiente.' });
    return;
  }

  const { categoria, params } = pendingAction;
  pendingAction = null;

  console.log(`${TAG} → Ejecutando acción: ${categoria}`);

  try {
    let result;

    if (categoria === 'bloqueo') {
      result = await ejecutarBloqueo({
        empleado: params.empleado,
        fecha: params.fechaISO || params.fecha
      });
    } else if (categoria === 'reserva') {
      result = await ejecutarReservaSimple({
        servicio: params.servicio || params.serviceName || '',
        empleado: params.empleado,
        fecha: params.fechaISO || params.fecha,
        hora: params.hora || params.horaHHmm || '',
        cliente: params.cliente || params.nombre || ''
      });
    } else if (categoria === 'reserva_color') {
      result = await ejecutarReservaColor({
        servicio: params.servicio || params.serviceName || '',
        empleado: params.empleado,
        fecha: params.fechaISO || params.fecha,
        hora: params.hora || params.horaHHmm || '',
        longitudPelo: params.longitudPelo || 'M',
        corte: params.corte || false,
        cliente: params.cliente || params.nombre || ''
      });
    } else {
      result = { ok: false, error: `Acción "${categoria}" no implementada` };
    }

    if (result.ok) {
      sendToWidget({
        type: 'AKIRA_RESPONSE', messageId,
        respuesta: result.mensaje, categoria
      });
    } else {
      sendToWidget({
        type: 'AKIRA_ERROR', messageId,
        error: result.error || 'Error ejecutando la acción'
      });
    }
  } catch (e) {
    console.error(`${TAG} handleActionExecute error:`, e.message);
    sendToWidget({
      type: 'AKIRA_ERROR', messageId,
      error: 'Error ejecutando la acción. Inténtalo de nuevo.'
    });
  }
}

// ─────────────────────────────────────────────
// ACCIONES: Cancelar
// ─────────────────────────────────────────────

function handleActionCancel(messageId) {
  pendingAction = null;
  console.log(`${TAG} → Acción cancelada`);
  sendToWidget({
    type: 'AKIRA_RESPONSE', messageId,
    respuesta: 'Acción cancelada.', categoria: 'cancelado'
  });
}

// ─────────────────────────────────────────────
// UTILIDAD: Enviar mensaje al widget
// ─────────────────────────────────────────────

function sendToWidget(payload) {
  try {
    $w('#htmlConsoleIA').postMessage(payload);
  } catch (e) {
    console.error(`${TAG} sendToWidget error:`, e.message);
  }
}