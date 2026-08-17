// =====================================================
// PAGE CODE - Gestor Cancelaciones KAMISUITE
// =====================================================
// Página: GestorCancelaciones (o el nombre que uses)
// Widget HTML: #htmlCancelaciones
// =====================================================

import {
  testPing,
  obtenerReservasFiltradas,
  obtenerListaStaff,
  cancelarReservas
} from 'backend/cancelacionReservas.web';

const TAG = '[CancelacionesBridge]';

$w.onReady(function () {
  console.log(`${TAG} Página cargada`);

  // Escuchar mensajes del widget HTML
  $w('#htmlCancelaciones').onMessage(async (event) => {
    const data = event.data;
    console.log(`${TAG} Mensaje recibido:`, data.tipo);

    switch (data.tipo) {
      case 'test_ping':
        await handleTestPing();
        break;

      case 'obtener_staff':
        await handleObtenerStaff();
        break;

      case 'buscar_reservas':
        await handleBuscarReservas(data);
        break;

      case 'cancelar_reservas':
        await handleCancelarReservas(data);
        break;

      default:
        console.log(`${TAG} Tipo desconocido:`, data.tipo);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// HANDLERS
// ═══════════════════════════════════════════════════════════════════════════

async function handleTestPing() {
  try {
    const res = await testPing();
    enviarAlWidget('test_ping_response', res);
  } catch (error) {
    console.error(`${TAG} Error testPing:`, error);
    enviarAlWidget('test_ping_response', { ok: false, error: error.message });
  }
}

async function handleObtenerStaff() {
  try {
    const res = await obtenerListaStaff();
    enviarAlWidget('obtener_staff_response', res);
  } catch (error) {
    console.error(`${TAG} Error obtenerStaff:`, error);
    enviarAlWidget('obtener_staff_response', { ok: false, error: error.message, staff: [] });
  }
}

async function handleBuscarReservas(data) {
  try {
    const res = await obtenerReservasFiltradas({
      fechaInicio: data.fechaInicio,
      fechaFin: data.fechaFin,
      staffId: data.staffId,
      estado: data.estado,
      busquedaCliente: data.busquedaCliente
    });
    console.log(`${TAG} Reservas encontradas:`, res.total);
    enviarAlWidget('buscar_reservas_response', res);
  } catch (error) {
    console.error(`${TAG} Error buscarReservas:`, error);
    enviarAlWidget('buscar_reservas_response', { ok: false, error: error.message, reservas: [] });
  }
}

async function handleCancelarReservas(data) {
  try {
    const res = await cancelarReservas({
      bookingIds: data.bookingIds,
      notificarCliente: data.notificarCliente
    });
    console.log(`${TAG} Cancelación resultado:`, res);
    enviarAlWidget('cancelar_reservas_response', res);
  } catch (error) {
    console.error(`${TAG} Error cancelarReservas:`, error);
    enviarAlWidget('cancelar_reservas_response', { ok: false, error: error.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILIDADES
// ═══════════════════════════════════════════════════════════════════════════

function enviarAlWidget(tipo, datos) {
  $w('#htmlCancelaciones').postMessage({ tipo, ...datos });
}