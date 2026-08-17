// =====================================================
// KAMISUITE — Backend: Widget Público de Reservas
// =====================================================
// VERSION: 0.8.0
// FECHA: 29 de junio de 2026
// ARCHIVO: backend/widgetPublicoLogic.web.js
//
// v0.8.0:
//   🛡️ REFUERZOS R1 + R4 + R8 al flujo de reserva pública. Cambio
//      QUIRÚRGICO en el wrapper `crearReservaPublica` + 4 helpers
//      privados nuevos + 2 constantes de colección + 1 constante de
//      ventana temporal. NINGÚN cambio en getCategoriasPublicas,
//      getServiciosCategoria, getProfesionalesPublicos, getSalonConfig,
//      getHuecosDisponibles, adaptarServicio, ni en los helpers ya
//      existentes.
//
//      R1 — REVALIDACIÓN PRE-INSERT (anti race-condition).
//      Antes de delegar en crearPackReserva, se llama a la propia
//      getHuecosDisponibles de este archivo con fecha, staff y
//      `principal.duration` del catálogo. Si horaHHmm no aparece en
//      huecos vigentes → error claro "Esa hora ya no está disponible.
//      Refresca y prueba otra." Cierra la ventana entre que el
//      cliente vio el hueco y pulsa Reservar. Mismo patrón que
//      clienteAreaLogic.moverCitaCliente. Si la revalidación falla
//      técnicamente (excepción / motor con ok:false) → NO se bloquea
//      la reserva (mejor permitir que rechazar por error de motor;
//      crearPackReserva es la defensa final al crear las sessions).
//      Cuando staffId='any' se pasa 'any' a getHuecosDisponibles, que
//      ya devuelve huecos donde al menos UN staff candidato está libre.
//
//      R4 — IDEMPOTENCIA por clave de cliente/slot/servicio/staff.
//      Antes de R1, se consulta KamisuiteReservations buscando una
//      reserva del MISMO cliente al MISMO slot+servicio+staff creada
//      en los ÚLTIMOS 5 MINUTOS (ventana de retransmisión de red /
//      doble click / dos pestañas simultáneas). Si existe match se
//      devuelve la misma reservaId con flag yaExiste:true. La
//      centralita NO se vuelve a disparar (ya envió en la primera).
//      KEY = identidad | fecha | horaHHmm | principalSetupUid | staffIdNorm
//      identidad = memberContactId si es GUID; si no, clientPhone
//                  reducido a dígitos. Si <6 dígitos → skip idempotencia.
//      staffIdNorm = '' si llegó 'any', si no el GUID.
//      Query del día completo (±3h UTC, mismo patrón defensivo que
//      getHuecosDisponibles), filtrada en memoria para robustez ante
//      formatos de teléfono dispares. Excluye status='CANCELADA'.
//      NO confunde el flujo "+ OTRA RESERVA" del widget: como las
//      horas serán distintas (la 1ª ya está ocupando 10:00, el motor
//      ofrece 10:45) la KEY difiere y ambas pasan. R4 solo dispara
//      cuando TODO coincide (mismo cliente + mismo slot + mismo
//      servicio + mismo staff) en una ventana de segundos.
//
//      R8 — AUDIT LOG en CMS PublicReservationAttempts.
//      Al final del webMethod (éxito o fracaso) se inserta una fila
//      con timestamp, datos del cliente, payload, resultado, motivo,
//      reservaId, yaExiste, durationMs y version. Llamada NO-BLOCKING:
//      si el CMS no existe o falla la insert, la reserva igual se
//      devuelve al cliente — el audit no afecta al producto.
//      Permite reconstruir el diagnóstico de incidentes (como el de
//      Hair-Times V1 del 28-jun-2026) en lugar de depender de los logs
//      efímeros de Wix.
//      Valores de resultado:
//        'OK'                — reserva creada normal.
//        'OK_YAEXISTE'       — match idempotente, devuelta existente.
//        'FAIL_VALIDACION'   — payload inválido (campos, identidad,
//                              staff no permitido, servicio inexistente).
//        'FAIL_SLOT_OCUPADO' — R1 detectó que el slot ya no existe.
//        'FAIL_BACKEND'      — crearPackReserva o capa inferior devolvió ko.
//
//      Requiere CMS nuevo PublicReservationAttempts con 19 campos
//      (spec dry en KAMISUITE_Bitacora_29Jun2026.md). Si la colección
//      no existe, el log silencia (no rompe la reserva).
//
//      BLOQUE A de crearPackReserva (recepcionProLogic) se mantiene
//      INTOCADO: sigue siendo "reserva manual sin validar
//      disponibilidad — el salón decide". La defensa se introduce
//      SOLO en la capa pública (este wrapper). Recepción Pro V2
//      mantiene su comportamiento histórico.
//
// v0.7.4:
//   🔧 OBLIGATORIEDAD por FASE explícita (separación de conceptos).
//      La regla deducida de v0.7.3 ("complemento es required si su setupUid
//      aparece como fase tipo:'servicio' en mapeoFases del servicio
//      principal") rompía Tinte/Mechas/Coloración: esos servicios tienen
//      Corte/Peinado/Tratamiento en su mapeoFases ÚNICAMENTE para fijar
//      la POSICIÓN en la cascada cuando el cliente los añade, NO para
//      obligarlos. La regla v0.7.3 confundía dos conceptos (posición vs
//      obligatoriedad).
//
//      CORRECCIÓN: cada fase tipo:'servicio' del mapeoFases admite ahora
//      un flag `obligatorio` (Boolean, default false). El flag lo añade
//      el editor de servicios (edicionservicios v1.13.0) con un toggle
//      visual por chip de fase. El backend solo lee el flag.
//
//      adaptarServicio:
//      ANTES (v0.7.3):
//        cMandatory = setupUidsEnFases.has(c.setupUid)
//                                            ^ true para cualquier fase en
//                                              el mapeo (presencia = obliga)
//      AHORA (v0.7.4):
//        cMandatory = busca la fase tipo:'servicio' del mapeoFases del
//                     principal cuyo ref === c.setupUid; lee
//                     !!fase.obligatorio. Si no hay fase coincidente o no
//                     tiene el flag → false.
//
//      Aplicable tanto a complementos con variantes (type:'choice') como
//      sin variantes (type:'bool'). El resto del adapter (variantes,
//      opciones, "No añadir", precio/duración, idStaff, promoPct…) queda
//      intacto.
//
//      Default false significa que TODAS las fases existentes en el CMS
//      (que aún no llevan el flag) pasan a OPCIONALES. Botox + Planchado
//      deja de ser obligatorio hasta que se entre al editor de ese
//      servicio y se marque la fase Planchado como obligatoria. Decisión
//      de Jal — Tinte/Mechas/Coloración son varios; Botox es un caso.
//      Menos clicks de migración con default false.
//
//      Cambio simétrico al de recepcionProLogic v1.0.27. El widget bundle
//      (kamisuite-widget-bundle.js) NO se toca: ya consume `required`
//      resuelto desde aquí.
//
// v0.7.3:
//   🧩 OBLIGATORIEDAD DEDUCIDA del mapeoFases (sin campo `mandatory`).
//      Un complemento con variantes es OBLIGATORIO (required, sin opción
//      "No añadir") SI Y SOLO SI su setupUid aparece como fase tipo:'servicio'
//      en el mapeoFases del servicio principal. Si el salón coloca el
//      servicio (Planchado) como fase de la cascada, esa fase siempre ocurre
//      → elegir su variante es obligatorio. Si no está en el mapeo → opcional.
//      No requiere campo nuevo en CMS ni toggle en el editor.
//
// v0.7.2:
//   🧩 COMPLEMENTOS CON VARIANTES + OBLIGATORIOS (adaptarServicio).
//      Dos capacidades INDEPENDIENTES en cada complemento de un servicio:
//      · hasVariants → el complemento se emite como type:'choice' con una
//        opción por variante ({id:tamano_estilo, label:nombre, price:precio,
//        duration:duracion}). ANTES se mapeaba siempre como 'bool' tomando
//        solo el precio base → las variantes (Planchado M/L/XL) se anulaban.
//        FIX del bug. Si no es obligatorio, se antepone opción 'none'
//        ("No añadir", 0€) para poder no añadirlo.
//      · mandatory (campo Boolean nuevo en ServiceCatalog) → required:true.
//        El widget lo mete en el gating del botón RESERVAR (no se reserva
//        sin elegir). En choice obligatorio NO se incluye la opción 'none'.
//      El widget (kamisuite-widget-bundle v2.0.13) ya pinta y suma choice;
//      _submit ahora envía la variante elegida. crearReservaPublica usa el
//      precio/duración de la variante.
//
// v0.7.1:
//   📜 getSalonConfig() expone privacyPolicyUrl y termsConditionsUrl.
//
// v0.7.0:
//   🌈 NUEVO — Descuento promocional por servicio expuesto al widget público.
//      · adaptarServicio() ahora LEE `descuentoActivo` (Boolean) y
//        `descuentoPromo` (Number 0-100, admite null) de ServiceCatalog y
//        los proyecta como `promoPct` (Number 0-100) en el shape del
//        servicio que consume kamisuite-widget-bundle.
//      · Regla dura idéntica a la de Recepción Pro V2 / recepcionProLogic
//        v1.0.19: el descuento SOLO se aplica si `descuentoActivo === true`
//        (estricto). Si descuentoActivo=false con descuentoPromo=15 → 0.
//        Si descuentoPromo no es número o es ≤0 → 0. Clampado a [0..100].
//      · Antes (v0.6.0) `promoPct: 0` estaba HARDCODEADO → el bundle nunca
//        recibía promo aunque el CMS la tuviera activa.
//      · Cambio puramente aditivo + quirúrgico: ninguna otra función ni
//        otro campo del shape se ven afectados. Servicios sin promo siguen
//        recibiendo promoPct:0 (idéntico al comportamiento anterior).
//      · El widget bundle v2.0.10 consume este campo + lo combina con el
//        nuevo bloque "ENHORABUENA, este servicio tiene un descuento
//        promocional" en el resumen de la reserva. El widget público NO
//        cobra; el cobro real (con el descuento aplicado al neto) ocurre
//        en Recepción Pro V2 al ejecutar la cita en salón.
//
// v0.6.0:
//   🔐 NUEVO — Filtro de staff por servicio (ServiceCatalog.idStaff).
//      · adaptarServicio() añade `idStaff:[]` al shape del servicio,
//        leyendo `it.idStaff.ids` (Object Wix CMS, NO array suelto).
//        Lectura defensiva contra los 3 formatos posibles (Object,
//        Array legacy, String JSON viejo).
//      · getHuecosDisponibles acepta `idStaffPermitidos` opcional.
//        Si llega con IDs, restringe los candidatos de staff antes
//        del cruce con horarios y reservas. Si vacío/ausente → todos.
//      · crearReservaPublica valida en backend que el staffId elegido
//        está permitido por el servicio. Devuelve error si no, antes
//        de delegar en crearPackReserva. Defensa contra manipulación
//        del payload (no se confía solo en el filtro del widget).
//      · idStaff vacío [] = fallback liberal (todos los activos).
//
// v0.5.0:
//   📨 NUEVO — Integración con CENTRALITA DE COMUNICACIONES.
//      Tras crearReservaPublica exitosa, se invoca notificarConfirmacion()
//      de backend/comunicacionesLogic.web.js para disparar email + WhatsApp
//      según SalonConfig. Mismo patrón aplicado en V1 (simplesLogic v1.5.0,
//      coloracionLogic v3.2.7, tratamientosLogic v1.0.9). Llamada envuelta
//      en try/catch no-blocking: si la centralita falla, la reserva ya
//      está creada — el cliente simplemente no recibe la notificación.
//
//      Datos resueltos en el wrapper antes de invocar centralita:
//      · serviciosStr ← ServiceCatalog.label por principalSetupUid
//      · estilistaStr ← StaffConfig.displayName por fases[0].staffId
//        (necesario cuando proId='any' → crearPackReserva asigna staff
//         real pero no devuelve nombre directamente).
//      · fechaBonita ← DD/MM/YYYY (formato esperado por driver WhatsApp).
//      · horaFinal ← horaHHmm + duracionTotal devuelto por crearPackReserva.
//      · importeStr ← `${precioTotal}€`.
//      · origen ← 'Reserva Online' (V1) — distingue email del de Recepción.
//      · estadoPago ← 'Pago en salón' (las web no pagan online aún).
//
// v0.4.0:
//   ⚡ getHuecosDisponibles REAL (fase 2). Reemplaza el mock determinista.
//     · Lee StaffConfig.workingHoursSessionIds (JSON Text con items[]).
//     · Si todos los staff candidatos tienen open:false ese día →
//       huecos:[] + motivo:'cerrado' + abreA:null.
//     · Genera slots cada 15 min entre from/to del staff.
//     · Cruza con KamisuiteReservations del día (excluye CANCELADA,
//       respeta override staffId por fase desde drag&drop V2).
//     · Fases con ocupa:false (PROCESO) liberan al stylist correctamente.
//     · proId 'any' → al menos un staff libre = hueco disponible.
//     · Primer hueco visible = min(from) entre staff candidatos.
//     · Devuelve abreA y cierraA para que el widget sepa el rango real.
//   ✅ Lunes y domingo (open:false en KALONICE) ya NO generan huecos.
//
// v0.3.0:
//   + crearReservaPublica ahora envía `origenRecepcion: false` al
//     crearPackReserva (requiere recepcionProLogic >= v1.0.17).
//     Permite distinguir en agenda las citas creadas desde la web
//     pública vs las creadas por operadores en Recepción Pro.
//
// v0.2.0:
//   + NEW crearReservaPublica — wrapper público que delega en
//     crearPackReserva de recepcionProLogic. Aísla el iframe del
//     backend interno y normaliza el contrato. Acepta tanto
//     memberContactId (cliente logueado) como contactDetails (cliente
//     anónimo). Internamente esResponsabilidad del wrapper validar
//     campos mínimos antes de delegar.
//
// v0.1.0:
//   + getCategoriasPublicas, getServiciosCategoria, getProfesionalesPublicos,
//     getSalonConfig, getHuecosDisponibles (mock).
//
// PROPÓSITO:
//   Servir datos al widget público <kami-reserva> que vivirá en la web
//   pública del salón (página dinámica /reservar/<slug>). El cliente
//   anónimo puede ver categorías, elegir servicio, día, profesional y
//   hora. Crear la reserva real se hará en fase 3 vía crearPackReserva.
//
// MULTI-TENANT:
//   - Las CATEGORÍAS viven en HairSalonServices (cuenta Wix de cada salón).
//   - Los SERVICIOS viven en ServiceCatalog (misma cuenta).
//   - El mapeo categoría → servicios se hace por el campo `groupCatalog`
//     de HairSalonServices que apunta a `group` de ServiceCatalog.
//   - `groupCatalog` admite varios valores separados por coma (N:1).
//     Ejemplo: "Corte Mujer" → "cortesmujer,Niñas".
//
// COLECCIONES:
//   - HairSalonServices         (lectura: categorías públicas de la web)
//   - ServiceCatalog            (lectura: servicios reservables)
//   - StaffConfig               (lectura: profesionales)
//   - SalonConfig               (lectura: nombre del salón + widgetSkin)
//   - KamisuiteReservations     (lectura: motor huecos + R4 idempotencia) — v0.8.0
//   - PublicReservationAttempts (escritura: audit log R8 — NUEVA en v0.8.0)
//
// PERMISOS:
//   Todas las funciones son Anyone (cliente anónimo). Internamente cada
//   query usa suppressAuth: true.
//
// FASES:
//   Fase 1 (este archivo): catálogo + categorías + profesionales +
//     huecos MOCK determinista + lectura widgetSkin desde SalonConfig.
//   Fase 2: huecos reales cruzando KamisuiteReservations.
//   Fase 3: crearReservaPublica → llama a crearPackReserva existente.
//
// FUNCIONES EXPORTADAS:
//   - getCategoriasPublicas()         → categorías activas con foto + descripción
//   - getServiciosCategoria({slug})   → servicios principales de la categoría
//   - getProfesionalesPublicos()      → staff del salón + "Cualquiera"
//   - getSalonConfig()                → widgetSkin + nombre del salón
//   - getHuecosDisponibles({fecha,    → mock determinista (fase 1)
//       proId, durationMin})
// =====================================================

import { Permissions, webMethod } from 'wix-web-module';
import wixData from 'wix-data';

const VERSION = '0.8.0';
const TAG = `[WidgetPublico][${VERSION}]`;

const CMS_CATALOGO   = 'ServiceCatalog';
const CMS_CATEGORIAS = 'HairSalonServices';
const CMS_STAFF      = 'StaffConfig';
const CMS_CONFIG     = 'SalonConfig';

// v0.8.0 — colecciones añadidas para R4 (idempotencia) + R8 (audit log).
const CMS_RESERVAS   = 'KamisuiteReservations';
const CMS_AUDIT      = 'PublicReservationAttempts';

// v0.8.0 — Ventana de detección de duplicado por _createdDate (ms).
// 5 min cubren retransmisión de red / doble click / dos pestañas
// simultáneas, sin capturar intentos del usuario que reabre el widget.
const IDEMPOTENCIA_VENTANA_MS = 5 * 60 * 1000;

const USOS_PUBLICOS     = ['publico', 'ambos'];
const TIPOS_PRINCIPALES = ['principal', 'ambos'];
const NOTA_RECURSO_INTERNO = 'RECURSO INTERNO';

// =====================================================
// HELPERS
// =====================================================

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function safeErr(e) {
  return { message: e?.message || String(e) };
}

// v0.8.0 — Reconoce un GUID v4 estándar. Necesario para distinguir
// memberContactId real (GUID) de teléfono normalizado (solo dígitos)
// dentro de los helpers de idempotencia R4.
function isGuid(x) {
  return typeof x === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
}

// jsonIn defensivo (idéntico patrón a recepcionProLogic v1.0.16).
// Wix Text/Object puede tener: string JSON legacy, array directo, o
// objeto envuelto con claves canónicas {items|ids|names}.
function jsonIn(v, unwrapKey) {
  if (v == null || v === '') return [];
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch (e) { return []; }
  }
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if (unwrapKey && Array.isArray(v[unwrapKey])) return v[unwrapKey];
    if (Array.isArray(v.items)) return v.items;
    if (Array.isArray(v.ids))   return v.ids;
    if (Array.isArray(v.names)) return v.names;
    return [];
  }
  if (Array.isArray(v)) return v;
  return [];
}

// Slug a partir de link-servicios-title: "/servicios/tratamientos-faciales"
// → "tratamientos-faciales". Tolerante a slash final, vacío y errores.
function extraerSlug(linkPath) {
  if (!linkPath) return '';
  return String(linkPath).split('/').filter(Boolean).pop() || '';
}

// Iniciales a partir de un nombre: "Verónica" → "VE", "María José" → "MJ".
function generarIniciales(nombre) {
  const palabras = String(nombre || '').trim().split(/\s+/).filter(Boolean);
  if (palabras.length === 0) return '··';
  if (palabras.length === 1) return palabras[0].slice(0, 2).toUpperCase();
  return (palabras[0][0] + palabras[1][0]).toUpperCase();
}

// =====================================================
// v0.8.0 — HELPERS PRIVADOS para R4 (idempotencia)
// =====================================================

/**
 * Normaliza un teléfono a solo dígitos. Util porque el cliente puede
 * meter espacios, prefijos +34, guiones, paréntesis, etc., y queremos
 * comparar identidad de forma robusta.
 */
function normalizarTelefono(phone) {
  if (!phone) return '';
  return String(phone).replace(/\D/g, '');
}

/**
 * Devuelve el identificador efectivo del cliente para idempotencia.
 * Prioridad: memberContactId (si es GUID) → teléfono normalizado.
 * Si no hay ninguno fiable (<6 dígitos y sin memberContactId), devuelve
 * '' y el caller debe saltar la comprobación de idempotencia.
 */
function resolverIdentidadCliente(memberContactId, clientPhone) {
  if (memberContactId && isGuid(memberContactId)) return memberContactId;
  const phoneNorm = normalizarTelefono(clientPhone);
  if (phoneNorm.length >= 6) return phoneNorm;
  return '';
}

/**
 * R4 — Busca una reserva del mismo cliente al mismo slot+servicio+staff
 * creada en los últimos IDEMPOTENCIA_VENTANA_MS milisegundos.
 *
 * Devuelve la fila completa de la reserva existente, o null si no hay
 * match. Cualquier error de query devuelve null (la idempotencia es un
 * refuerzo, nunca debe bloquear una reserva legítima).
 *
 * Estrategia: query del día (margen ±3h UTC, mismo patrón defensivo
 * que getHuecosDisponibles) + filtro por _createdDate reciente +
 * filtrado en memoria. Robusto ante teléfonos con formatos dispares
 * y barato porque el día tiene pocas filas.
 *
 * NO confunde el flujo "+ OTRA RESERVA" del widget: si el cliente
 * reabre el form tras confirmar una reserva, el motor de huecos le
 * mostrará otra hora distinta, así que horaHHmm difiere y la KEY no
 * matchea.
 */
async function buscarReservaDuplicada({
  identidad, fecha, horaHHmm, principalSetupUid, staffIdNorm
}) {
  if (!identidad || !fecha || !horaHHmm || !principalSetupUid) return null;

  try {
    const startUTC     = new Date(new Date(`${fecha}T00:00:00`).getTime() - 3 * 3600000);
    const endUTC       = new Date(new Date(`${fecha}T23:59:59`).getTime() + 3 * 3600000);
    const createdAfter = new Date(Date.now() - IDEMPOTENCIA_VENTANA_MS);

    const r = await wixData.query(CMS_RESERVAS)
      .ge('fechaReserva', startUTC)
      .le('fechaReserva', endUTC)
      .ge('_createdDate', createdAfter)
      .ne('status', 'CANCELADA')
      .limit(50)
      .find({ suppressAuth: true });

    const items = r?.items || [];
    if (!items.length) return null;

    for (const it of items) {
      // setupUid del principal: primera fase tipo:'servicio' con setupUid.
      let principalUidReserva = '';
      try {
        const fasesObj = it.fases;
        const fasesArr = (fasesObj && Array.isArray(fasesObj.items)) ? fasesObj.items : [];
        const primera = fasesArr.find(f => f && f.tipo === 'servicio' && f.setupUid);
        if (primera) principalUidReserva = String(primera.setupUid);
      } catch (_) { /* noop */ }
      if (principalUidReserva !== principalSetupUid) continue;

      // staffIdNorm: '' = 'any' (no restringimos por staff).
      if (staffIdNorm) {
        if (String(it.staffId || '') !== staffIdNorm) continue;
      }

      // Identidad: contactId si la tenemos (GUID), si no teléfono normalizado.
      const itContactId = String(it.contactId || '');
      const itPhoneNorm = normalizarTelefono(it.clientPhone);
      const matchIdentidad =
        (isGuid(identidad) && itContactId === identidad) ||
        (!isGuid(identidad) && itPhoneNorm === identidad);
      if (!matchIdentidad) continue;

      // horaHHmm en zona Madrid.
      let horaReservaHHmm = '';
      try {
        const fr = new Date(it.fechaReserva);
        horaReservaHHmm = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Europe/Madrid',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        }).format(fr);
      } catch (_) { /* noop */ }
      if (horaReservaHHmm !== horaHHmm) continue;

      return it;
    }

    return null;
  } catch (e) {
    console.warn(`${TAG} ⚠️ buscarReservaDuplicada: ${e.message} (sigo sin idempotencia)`);
    return null;
  }
}

// =====================================================
// v0.8.0 — HELPER PRIVADO para R8 (audit log)
// =====================================================

/**
 * R8 — Inserta una fila en PublicReservationAttempts. NO-BLOCKING.
 * Cualquier fallo (CMS inexistente, schema distinto, permisos) se
 * silencia con warn. La reserva del cliente NO depende de este log.
 */
async function logIntento(row) {
  try {
    const safeRow = {
      timestamp:            row.timestamp || new Date(),
      fechaReserva:         row.fechaReserva || '',
      horaHHmm:             row.horaHHmm || '',
      staffId:              row.staffId || '',
      staffName:            row.staffName || '',
      principalSetupUid:    row.principalSetupUid || '',
      complementosSetupUid: row.complementosSetupUid || null,
      clientName:           row.clientName || '',
      clientPhone:          row.clientPhone || '',
      clientPhoneNorm:      row.clientPhoneNorm || '',
      clientEmail:          row.clientEmail || '',
      contactId:            row.contactId || '',
      memberContactId:      row.memberContactId || '',
      resultado:            row.resultado || '',
      motivo:               row.motivo || '',
      reservaId:            row.reservaId || '',
      yaExiste:             row.yaExiste === true,
      durationMs:           toNum(row.durationMs),
      version:              VERSION
    };
    await wixData.insert(CMS_AUDIT, safeRow, { suppressAuth: true });
  } catch (e) {
    console.warn(`${TAG} ⚠️ logIntento NO-BLOCKING: ${e.message}`);
  }
}

// =====================================================
// ADAPTER · ServiceCatalog row → contrato del widget <kami-reserva>
// =====================================================
// Mapea un registro de ServiceCatalog al shape que espera kr-data.js:
//   { family, name, basePrice, baseDuration, promoPct, requiresExtraPro,
//     complements: [{ id, label, hint, type, price, duration }, ...] }
// Campos extra propios de KAMISUITE que se conservan para que el widget
// los use al pintar la cabecera y para variantes:
//   setupUid, description, image, hasVariants, variantes, claseServicio.
//
// REGLAS:
//   - Precio 0 o no informado → basePrice = null ("a valorar").
//   - Complementos: cada setupUid de ServiceCatalog.complementos se resuelve
//     al registro completo y se mapea como complement tipo "bool".
//     Si quisieras complementos tipo "choice" (ej. "Acabado": Secado/Corto/
//     Medio/Largo), el catálogo aún no los modela. Lo planteamos cuando
//     aparezca el primer caso real.
//   - Variantes: se pasan al widget en bruto. El widget actual no las
//     maneja todavía; se conectarán en la segunda iteración del widget.
//   - requiresExtraPro: false por ahora (no lo modela el catálogo).
//     El widget puede ocultar el bloque sin problema (deuda v1.0).

function adaptarServicio(it, porSetupUid) {
  // v0.7.4 — OBLIGATORIEDAD por FASE explícita. Cada fase tipo:'servicio'
  // del mapeoFases admite el flag `obligatorio` (Boolean, default false).
  // Si esa fase coincide en `ref` con el setupUid de un complemento, su
  // flag dicta si el complemento es required. Si no hay fase coincidente
  // o no tiene el flag → opcional.
  //
  // Esto separa POSICIÓN (mapeoFases dicta dónde encaja el complemento
  // en la cascada si se elige) de OBLIGATORIEDAD (lo dicta el flag de la
  // fase). La regla v0.7.3 mezclaba ambas cosas y rompía Tinte/Mechas/
  // Coloración. El flag lo añade el editor (edicionservicios v1.13.0).
  const mapeo = jsonIn(it.mapeoFases, 'items');
  const fasePorRef = {};
  if (Array.isArray(mapeo)) {
    for (const f of mapeo) {
      if (f && f.tipo === 'servicio' && typeof f.ref === 'string' && f.ref) {
        fasePorRef[f.ref] = f;
      }
    }
  }

  const complementosUids = jsonIn(it.complementos, 'items');
  const complements = (Array.isArray(complementosUids) ? complementosUids : [])
    .map(uid => porSetupUid[uid])
    .filter(Boolean)
    .map(c => {
      // hasVariants → 'choice' (una opción por variante).
      // required    → lee !!fase.obligatorio de la fase del mapeoFases.
      const cTieneVariantes = !!c.hasVariants;
      const faseEnMapeo = fasePorRef[c.setupUid];
      const cMandatory = !!(faseEnMapeo && faseEnMapeo.obligatorio === true);

      if (cTieneVariantes) {
        // Variantes del complemento: {nombre, precio, duracion, tamano_estilo}
        const vars = jsonIn(c.variantes, 'items');
        const opts = (Array.isArray(vars) ? vars : [])
          .map((v, i) => ({
            id: (v && typeof v.tamano_estilo === 'string' && v.tamano_estilo.trim())
                  ? v.tamano_estilo.trim()
                  : ('v' + i),
            label: (v && v.nombre) ? String(v.nombre) : ('Opción ' + (i + 1)),
            price: toNum(v && v.precio),
            duration: toNum(v && v.duracion)
          }));

        // Opcional → se antepone "No añadir". Obligatorio → sin "No añadir".
        const options = cMandatory
          ? opts
          : [{ id: 'none', label: 'No añadir', price: 0, duration: 0 }, ...opts];

        return {
          id: c.setupUid,
          label: c.label || '',
          hint: c.descripcion || '',
          type: 'choice',
          required: cMandatory,
          options
        };
      }

      // Sin variantes → complemento booleano (sí/no), como hasta ahora.
      return {
        id: c.setupUid,
        label: c.label || '',
        hint: c.descripcion || '',
        type: 'bool',
        required: cMandatory,   // bool obligatorio = debe ser "Sí"
        price: toNum(c.price),
        duration: toNum(c.duration)
      };
    });

  const hasVariants = !!it.hasVariants;
  const variantes = hasVariants ? jsonIn(it.variantes, 'items') : [];

  const priceNum = toNum(it.price);
  const basePrice = priceNum > 0 ? priceNum : null;

  // v0.6.0 — idStaff filtra qué profesionales pueden ejecutar este
  // servicio. Es campo Object con shape {ids:[...]}, NO string ni
  // array suelto (ver IDS_QUE_SIEMPRE_PEDIMOS.md). Lectura defensiva
  // contra los 3 formatos por si una fila legacy aún no migró:
  //   · Object con .ids → caso normal.
  //   · Array directo   → legacy.
  //   · String JSON     → legacy más viejo.
  let idStaffArr = [];
  const rawIdStaff = it.idStaff;
  if (rawIdStaff) {
    if (Array.isArray(rawIdStaff.ids)) idStaffArr = rawIdStaff.ids;
    else if (Array.isArray(rawIdStaff)) idStaffArr = rawIdStaff;
    else if (typeof rawIdStaff === 'string') {
      try {
        const p = JSON.parse(rawIdStaff);
        if (Array.isArray(p?.ids)) idStaffArr = p.ids;
        else if (Array.isArray(p)) idStaffArr = p;
      } catch (_) {}
    }
  }
  idStaffArr = idStaffArr.filter(s => typeof s === 'string' && s.length > 0);

  return {
    setupUid: it.setupUid || '',
    family: it.group || '',
    name: it.label || '',
    description: it.descripcion || '',
    image: it.image || null,
    basePrice,
    baseDuration: toNum(it.duration),
    // v0.7.0 — descuento promocional desde ServiceCatalog. Regla dura
    // idéntica a Recepción Pro V2 (recepcionProLogic v1.0.19):
    //   · Solo si descuentoActivo === true (estricto, NO != false).
    //   · descuentoPromo debe ser número finito > 0; null/undefined/string → 0.
    //   · Clampado a [0..100].
    promoPct: (it.descuentoActivo === true
               && typeof it.descuentoPromo === 'number'
               && Number.isFinite(it.descuentoPromo)
               && it.descuentoPromo > 0)
      ? Math.min(100, Math.max(0, it.descuentoPromo))
      : 0,
    hasVariants,
    variantes,
    requiresExtraPro: false,
    complements,
    claseServicio: it.claseServicio || '',
    idStaff: idStaffArr,   // v0.6.0 — wixResourceIds permitidos. [] = todos.
    order: toNum(it.order)
  };
}

// =====================================================
// 1 · GET CATEGORÍAS PÚBLICAS
// =====================================================
// Devuelve las categorías activas de HairSalonServices ordenadas por orden.
// Útil tanto para construir el repeater de la página de inicio de reservas
// (si Jal lo quiere CMS-first más adelante) como para resolver una categoría
// por slug.
//
// Forma devuelta:
//   { ok, categorias: [{ _id, title, subtitle, description, image,
//     orden, slug, groupCatalog, linkServiciosTitle }] }
export const getCategoriasPublicas = webMethod(
  Permissions.Anyone,
  async () => {
    const t0 = Date.now();
    try {
      const r = await wixData.query(CMS_CATEGORIAS)
        .eq('activo', true)
        .ascending('orden')
        .limit(100)
        .find({ suppressAuth: true });

      const cats = (r.items || []).map(it => ({
        _id: it._id,
        title: it.title || '',
        subtitle: it.subtitle || '',
        description: it.description || '',
        image: it.image || null,
        orden: toNum(it.orden),
        slug: extraerSlug(it['link-servicios-title']),
        groupCatalog: it.groupCatalog || '',
        linkServiciosTitle: it['link-servicios-title'] || ''
      }));

      console.log(`${TAG} ✅ getCategoriasPublicas: ${cats.length} categorías. ${((Date.now()-t0)/1000).toFixed(2)}s`);
      return { ok: true, version: VERSION, categorias: cats };

    } catch (e) {
      console.error(`${TAG} ❌ getCategoriasPublicas:`, e.message);
      return { ok: false, version: VERSION, error: safeErr(e), categorias: [] };
    }
  }
);

// =====================================================
// 2 · GET SERVICIOS DE UNA CATEGORÍA
// =====================================================
// Resuelve los servicios principales de una categoría dada por su slug
// (preferido) o directamente por groupCatalog. Internamente:
//   1) Si llega slug, lo busca en HairSalonServices y lee su groupCatalog.
//   2) Hace split(',') por si la categoría agrupa varios `group` del
//      ServiceCatalog (ej. Corte Mujer = "cortesmujer,Niñas").
//   3) Carga TODOS los servicios públicos activos (incluye los que solo
//      son complementos) para construir el índice porSetupUid y resolver
//      complementos del adapter.
//   4) Filtra los servicios PRINCIPALES de los groups solicitados y los
//      adapta al contrato del widget.
//
// Forma devuelta:
//   { ok, servicios: [adaptedService, ...], groupsAplicados: ['coloracion', ...],
//     categoria: { title, subtitle, description, image } }
export const getServiciosCategoria = webMethod(
  Permissions.Anyone,
  async ({ slug, groupCatalog } = {}) => {
    const t0 = Date.now();
    try {
      // 1. Resolver groupCatalog desde slug si hace falta
      let gc = groupCatalog;
      let categoria = null;

      if (slug) {
        const r = await wixData.query(CMS_CATEGORIAS)
          .eq('activo', true)
          .limit(100)
          .find({ suppressAuth: true });
        const match = (r.items || []).find(it =>
          extraerSlug(it['link-servicios-title']) === slug
        );
        if (match) {
          gc = match.groupCatalog || '';
          categoria = {
            _id: match._id,
            title: match.title || '',
            subtitle: match.subtitle || '',
            description: match.description || '',
            image: match.image || null,
            slug,
            linkServiciosTitle: match['link-servicios-title'] || ''
          };
        }
      }

      if (!gc) {
        console.warn(`${TAG} ⚠️ getServiciosCategoria: groupCatalog no resuelto (slug=${slug})`);
        return { ok: false, version: VERSION, error: { message: 'Categoría no encontrada' }, servicios: [], categoria: null };
      }

      // 2. Split por coma (N:1 — Depilacion, Corte Mujer, Hombre…)
      const groups = String(gc).split(',').map(s => s.trim()).filter(Boolean);

      // 3. Cargar TODOS los servicios públicos activos
      const r2 = await wixData.query(CMS_CATALOGO)
        .eq('active', true)
        .hasSome('uso', USOS_PUBLICOS)
        .limit(1000)
        .find({ suppressAuth: true });

      const all = r2.items || [];
      const porSetupUid = {};
      for (const it of all) if (it.setupUid) porSetupUid[it.setupUid] = it;

      // 4. Filtrar principales del/los group(s) y adaptar
      const servicios = all
        .filter(it => groups.includes(it.group) && TIPOS_PRINCIPALES.includes(it.tipo))
        .sort((a, b) => toNum(a.order) - toNum(b.order))
        .map(it => adaptarServicio(it, porSetupUid));

      console.log(`${TAG} ✅ getServiciosCategoria slug=${slug || '∅'} groups=[${groups.join(',')}]: ${servicios.length} servicios. ${((Date.now()-t0)/1000).toFixed(2)}s`);
      return { ok: true, version: VERSION, servicios, groupsAplicados: groups, categoria };

    } catch (e) {
      console.error(`${TAG} ❌ getServiciosCategoria:`, e.message);
      return { ok: false, version: VERSION, error: safeErr(e), servicios: [], categoria: null };
    }
  }
);

// =====================================================
// 3 · GET PROFESIONALES PÚBLICOS
// =====================================================
// Mismo patrón que getStaffColumnas de recepcionProLogic, pero con shape
// para el widget público (id + name + initials + profileImage).
// Excluye recursos internos (CUALQUIERA, PROCESO) marcados con la nota
// "RECURSO INTERNO" o cuyo canonicalName sea CUALQUIERA/PROCESO.
// Antepone un pseudo-pro "Cualquiera" con id 'any' que el widget usa
// como wildcard de UI (igual que V1).
export const getProfesionalesPublicos = webMethod(
  Permissions.Anyone,
  async () => {
    const t0 = Date.now();
    try {
      const r = await wixData.query(CMS_STAFF)
        .eq('active', true)
        .limit(100)
        .find({ suppressAuth: true });

      const items = r.items || [];
      const reales = items
        .filter(it => {
          if (String(it.notes || '').includes(NOTA_RECURSO_INTERNO)) return false;
          const canon = String(it.canonicalName || '').toUpperCase();
          if (canon === 'CUALQUIERA' || canon === 'PROCESO') return false;
          return true;
        })
        .map(it => {
          const name = (it.displayName || it.canonicalName || '').replace(/^[A-Z]_/, '');
          return {
            id: it.wixResourceId || it._id,
            wixResourceId: it.wixResourceId || it._id,
            wixScheduleId: it.wixScheduleId || '',
            name,
            initials: generarIniciales(name),
            profileImage: it.profileImage || '',
            any: false
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      const cualquiera = {
        id: 'any', wixResourceId: 'any',
        name: 'Cualquiera', initials: '··',
        profileImage: '', any: true
      };

      console.log(`${TAG} ✅ getProfesionalesPublicos: ${reales.length} reales + 1 wildcard. ${((Date.now()-t0)/1000).toFixed(2)}s`);
      return { ok: true, version: VERSION, profesionales: [cualquiera, ...reales] };

    } catch (e) {
      console.error(`${TAG} ❌ getProfesionalesPublicos:`, e.message);
      return { ok: false, version: VERSION, error: safeErr(e), profesionales: [] };
    }
  }
);

// =====================================================
// 4 · GET SALON CONFIG (solo lo que el widget necesita)
// =====================================================
// Lee la primera fila de SalonConfig (1 fila por salón en su cuenta Wix).
// Devuelve únicamente lo que el widget público necesita:
//   - widgetSkin: id del skin a aplicar (niebla, arena, lumiere, …,
//                 oceano). Default 'niebla' si no está informado.
//   - salonName: para texto de confirmación / agradecimiento.
//
// NOTA: el campo widgetSkin debe crearse en SalonConfig (Text). Mientras
// no exista o esté vacío, devuelve 'niebla'.
export const getSalonConfig = webMethod(
  Permissions.Anyone,
  async () => {
    try {
      const r = await wixData.query(CMS_CONFIG)
        .limit(1)
        .find({ suppressAuth: true });

      const c = (r.items || [])[0] || {};
      return {
        ok: true,
        version: VERSION,
        config: {
          salonName: c.salonName || c.name || '',
          widgetSkin: c.widgetSkin || 'niebla',
          privacyPolicyUrl: c.privacyPolicyUrl || '',
          termsConditionsUrl: c.termsConditionsUrl || ''
        }
      };

    } catch (e) {
      console.error(`${TAG} ❌ getSalonConfig:`, e.message);
      return { ok: false, version: VERSION, error: safeErr(e), config: { salonName: '', widgetSkin: 'niebla', privacyPolicyUrl: '', termsConditionsUrl: '' } };
    }
  }
);

// =====================================================
// 5 · GET HUECOS DISPONIBLES (real, fase 2)
// =====================================================
// v0.4.0 — Implementación real. Sustituye al mock determinista.
//
// LECTURA DE HORARIOS:
//   StaffConfig.workingHoursSessionIds — JSON Text con forma:
//     {"items":[{"dow":0,"open":false},
//               {"dow":2,"open":true,"from":"10:00","to":"19:00"}, ...]}
//   dow = Date.getDay() (0=Domingo, 1=Lunes, ..., 6=Sábado)
//
// REGLAS:
//   · Si TODOS los staff candidatos tienen `open:false` ese día →
//     huecos: [], motivo: 'cerrado'.
//   · Si proId === 'any' → unión de huecos de TODOS los staff activos
//     (al menos un staff libre = hueco disponible).
//   · Si proId concreto → solo ese staff.
//   · El primer hueco visible = min(from) entre staff candidatos.
//   · El último slot generado debe terminar antes de max(to).
//   · Paso entre slots = 15 min (granularidad común salón).
//   · Cruce con KamisuiteReservations del día (mismas reglas que
//     Recepción Pro): un slot está ocupado si su rango [slot, slot+dur)
//     se solapa con alguna reserva existente del staff.
//   · status 'CANCELADA' se excluye del cruce.
//
// ENTRADA:
//   { fecha: 'YYYY-MM-DD', proId: '<id>' | 'any', durationMin: number }
// SALIDA:
//   { ok, huecos: ['10:00', '10:15', ...], fecha, proId, durationMin,
//     motivo: 'cerrado' | undefined, abreA: 'HH:mm' | null }
//
// `abreA` informa al widget de la hora de apertura para que sepa
// dónde empezar a pintar el primer chip aunque haya huecos vacíos.

const SLOT_STEP = 15;   // minutos entre slots

function parseHHMM(s) {
  const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
  return h * 60 + mi;
}

function fmtHHMM(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

// Lee horario {from,to} del staff para un dow concreto.
// Devuelve null si está cerrado, no tiene horario configurado, o no parsea.
function leerHorarioStaffEnDia(staffRow, dow) {
  const raw = staffRow?.workingHoursSessionIds;
  if (!raw) return null;
  let items = [];
  try {
    if (typeof raw === 'string') {
      const obj = JSON.parse(raw);
      items = Array.isArray(obj?.items) ? obj.items : (Array.isArray(obj) ? obj : []);
    } else if (raw && typeof raw === 'object') {
      items = Array.isArray(raw.items) ? raw.items : (Array.isArray(raw) ? raw : []);
    }
  } catch (e) {
    console.warn(`${TAG} ⚠️ workingHours JSON inválido (${staffRow?.canonicalName || staffRow?._id}):`, e.message);
    return null;
  }
  const day = items.find(it => Number(it?.dow) === dow);
  if (!day || !day.open) return null;
  const from = parseHHMM(day.from);
  const to = parseHHMM(day.to);
  if (from == null || to == null || from >= to) return null;
  return { from, to };
}

export const getHuecosDisponibles = webMethod(
  Permissions.Anyone,
  async ({ fecha, proId, durationMin, idStaffPermitidos } = {}) => {
    const t0 = Date.now();
    try {
      const dur = toNum(durationMin) || 60;
      if (!fecha || !/^\d{4}-\d{2}-\d{2}$/.test(String(fecha))) {
        return { ok: false, version: VERSION, error: { message: 'fecha inválida' }, huecos: [] };
      }
      // dow del día solicitado (interpretado como local Madrid)
      const [y, mo, d] = fecha.split('-').map(Number);
      const dow = new Date(y, mo - 1, d).getDay(); // 0..6

      // v0.6.0 — filtro de staff permitidos para este servicio.
      // idStaffPermitidos viene de ServiceCatalog.idStaff.ids del servicio
      // que el cliente eligió. Si está vacío o no llega → fallback liberal
      // (todos los activos pueden hacerlo). Si tiene IDs → restringe.
      const permitidosSet = (Array.isArray(idStaffPermitidos) && idStaffPermitidos.length)
        ? new Set(idStaffPermitidos.map(String))
        : null;

      // 1) Cargar staff candidatos
      const rStaff = await wixData.query(CMS_STAFF)
        .eq('active', true)
        .limit(100)
        .find({ suppressAuth: true });
      let candidatos = (rStaff.items || []).filter(it => {
        if (String(it.notes || '').includes(NOTA_RECURSO_INTERNO)) return false;
        const canon = String(it.canonicalName || '').toUpperCase();
        if (canon === 'CUALQUIERA' || canon === 'PROCESO') return false;
        // v0.6.0 — solo staff permitidos para el servicio elegido.
        if (permitidosSet) {
          const sid = it.wixResourceId || it._id;
          if (!permitidosSet.has(String(sid))) return false;
        }
        return true;
      });

      if (proId && proId !== 'any') {
        candidatos = candidatos.filter(s =>
          s.wixResourceId === proId || s._id === proId
        );
        if (!candidatos.length) {
          // v0.6.0 — staff concreto no encontrado o no permitido para este servicio.
          return { ok: false, version: VERSION, error: { message: 'Staff no disponible para este servicio' }, huecos: [] };
        }
      }

      // 2) Determinar horario del día por staff
      const horariosStaff = candidatos.map(s => ({
        staff: s,
        horario: leerHorarioStaffEnDia(s, dow)
      }));
      const disponibles = horariosStaff.filter(h => h.horario);

      if (!disponibles.length) {
        console.log(`${TAG} 🚫 ${fecha} dow=${dow}: salón cerrado (0 staff abierto)`);
        return {
          ok: true, version: VERSION, fecha, proId, durationMin: dur,
          huecos: [], motivo: 'cerrado', abreA: null
        };
      }

      // 3) Rango global [minFrom, maxTo] entre staff abiertos
      const minFrom = Math.min(...disponibles.map(h => h.horario.from));
      const maxTo = Math.max(...disponibles.map(h => h.horario.to));

      // 4) Cargar reservas del día (todas) para cruce
      const startUTC = new Date(new Date(`${fecha}T00:00:00`).getTime() - 3 * 3600000);
      const endUTC = new Date(new Date(`${fecha}T23:59:59`).getTime() + 3 * 3600000);
      const rRes = await wixData.query('KamisuiteReservations')
        .ge('fechaReserva', startUTC)
        .le('fechaReserva', endUTC)
        .ne('status', 'CANCELADA')
        .limit(500)
        .find({ suppressAuth: true });

      // Reservas por staffId (incluye fase movida con override)
      // Para cada reserva, expandimos en intervalos {staffId, startMin, endMin}.
      const ocupados = [];
      for (const r of (rRes.items || [])) {
        const fasesArr = jsonIn(r.fases, 'items');
        if (!Array.isArray(fasesArr) || !fasesArr.length) {
          // Reserva sin fases (a medida): bloquea su rango simple
          if (r.fechaReserva && r.duracionTotal) {
            const start = new Date(r.fechaReserva);
            const ymd = start.toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
            if (ymd === fecha) {
              const startMin = parseHHMM(start.toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hour12: false }));
              if (startMin != null) {
                ocupados.push({ staffId: r.staffId, startMin, endMin: startMin + (Number(r.duracionTotal) || 0) });
              }
            }
          }
          continue;
        }
        for (const f of fasesArr) {
          if (f?.ocupa === false) continue;     // PROCESO libera al stylist
          if (!f.start || !f.end) continue;
          const ds = new Date(f.start);
          const de = new Date(f.end);
          const ymd = ds.toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' });
          if (ymd !== fecha) continue;
          const sm = parseHHMM(ds.toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hour12: false }));
          const em = parseHHMM(de.toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hour12: false }));
          if (sm == null || em == null) continue;
          const sid = f.staffId || r.staffId || '';
          ocupados.push({ staffId: sid, startMin: sm, endMin: em });
        }
      }

      // 5) Generar slots y filtrar
      // Un slot [m, m+dur) está libre para proId 'any' si AL MENOS UN staff
      // candidato lo tiene dentro de su horario y NO tiene ocupación cruzada.
      // Para proId concreto, exige que ese staff esté libre.
      const huecos = [];
      for (let m = minFrom; m + dur <= maxTo; m += SLOT_STEP) {
        let alguienLibre = false;
        for (const { staff, horario } of disponibles) {
          if (m < horario.from || m + dur > horario.to) continue;
          const sid = staff.wixResourceId || staff._id;
          // ¿solape con ocupados de ese staff?
          const haySolape = ocupados.some(o =>
            o.staffId && o.staffId === sid &&
            m < o.endMin && (m + dur) > o.startMin
          );
          if (!haySolape) { alguienLibre = true; break; }
        }
        if (alguienLibre) huecos.push(fmtHHMM(m));
      }

      const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
      console.log(`${TAG} ✅ huecos ${fecha} dow=${dow} proId=${proId || 'any'} dur=${dur}min: ${huecos.length} slots (abre ${fmtHHMM(minFrom)}, cierra ${fmtHHMM(maxTo)}). ${elapsed}s`);

      return {
        ok: true, version: VERSION,
        fecha, proId, durationMin: dur,
        huecos,
        abreA: fmtHHMM(minFrom),
        cierraA: fmtHHMM(maxTo)
      };

    } catch (e) {
      console.error(`${TAG} ❌ getHuecosDisponibles:`, e.message);
      return { ok: false, version: VERSION, error: safeErr(e), huecos: [] };
    }
  }
);

// =====================================================
// 6 · CREAR RESERVA PÚBLICA (wrapper de crearPackReserva)
// =====================================================
// Delega en backend/recepcionProLogic.crearPackReserva. Aísla el iframe
// público de la API interna y valida el contrato mínimo antes de tocar
// Recepción Pro.
//
// Entrada esperada (mismos campos que el form del widget genera):
//   {
//     fecha: 'YYYY-MM-DD',
//     horaHHmm: 'HH:mm',
//     principalSetupUid: '<setupUid>',
//     complementosSetupUid: ['<setupUid>', ...],   // opcional
//     staffId: '<wixResourceId>' | 'any',
//     staffName: '<nombre>',                        // opcional, informativo
//     contactDetails: { firstName, lastName, email, phone },
//     memberContactId: '<guid>' | null,             // si miembro logueado
//     notas: ''                                     // opcional
//   }
//
// Validación mínima (rápido fallar antes de tocar Wix Bookings):
//   - fecha + horaHHmm + principalSetupUid obligatorios
//   - staffId obligatorio (puede ser 'any')
//   - O memberContactId, O contactDetails con (firstName+phone) o
//     (firstName+email); si no hay nada, error.
//
// v0.8.0 — Antes de delegar, ejecuta R4 (idempotencia) y R1
// (revalidación). Al final escribe R8 (audit log). Mantiene la
// validación de staffId permitido (v0.6.0) y dispara centralita en
// éxito (v0.5.0).
//
// Devuelve el resultado tal cual de crearPackReserva (o el shape
// idempotente cuando R4 detecta duplicado).
// =====================================================
export const crearReservaPublica = webMethod(
  Permissions.Anyone,
  async (payload) => {
    const t0 = Date.now();

    // v0.8.0 — Datos del audit log (se pueblan a medida que avanza el flujo).
    const auditBase = {
      timestamp:            new Date(),
      fechaReserva:         '',
      horaHHmm:             '',
      staffId:              '',
      staffName:            '',
      principalSetupUid:    '',
      complementosSetupUid: null,
      clientName:           '',
      clientPhone:          '',
      clientPhoneNorm:      '',
      clientEmail:          '',
      contactId:            '',
      memberContactId:      '',
      resultado:            '',
      motivo:               '',
      reservaId:            '',
      yaExiste:             false,
      durationMs:           0,
      version:              VERSION
    };

    try {
      const {
        fecha,
        horaHHmm,
        principalSetupUid,
        complementosSetupUid = [],
        staffId,
        staffName = '',
        contactDetails = {},
        memberContactId = '',
        notas = ''
      } = payload || {};

      // v0.8.0 — Volcar al audit base lo que sepamos del payload.
      auditBase.fechaReserva         = fecha || '';
      auditBase.horaHHmm             = horaHHmm || '';
      auditBase.staffId              = staffId || '';
      auditBase.staffName            = staffName || '';
      auditBase.principalSetupUid    = principalSetupUid || '';
      auditBase.complementosSetupUid = Array.isArray(complementosSetupUid)
        ? { items: complementosSetupUid }
        : null;
      auditBase.memberContactId      = memberContactId || '';
      auditBase.clientName           = `${contactDetails?.firstName || ''} ${contactDetails?.lastName || ''}`.trim();
      auditBase.clientPhone          = contactDetails?.phone || '';
      auditBase.clientPhoneNorm      = normalizarTelefono(contactDetails?.phone);
      auditBase.clientEmail          = contactDetails?.email || '';

      // Validación mínima de campos
      if (!fecha || !horaHHmm || !principalSetupUid) {
        auditBase.resultado  = 'FAIL_VALIDACION';
        auditBase.motivo     = 'Faltan campos obligatorios (fecha, hora, servicio).';
        auditBase.durationMs = Date.now() - t0;
        logIntento(auditBase).catch(() => {});
        return { ok: false, version: VERSION, error: { message: auditBase.motivo } };
      }
      if (!staffId) {
        auditBase.resultado  = 'FAIL_VALIDACION';
        auditBase.motivo     = 'Falta profesional (puede ser "any").';
        auditBase.durationMs = Date.now() - t0;
        logIntento(auditBase).catch(() => {});
        return { ok: false, version: VERSION, error: { message: auditBase.motivo } };
      }

      // Validación de identidad mínima:
      // o memberContactId, o contactDetails con nombre + (telefono o email).
      const cd = contactDetails || {};
      const tieneIdentidadMinima = !!memberContactId ||
        (cd.firstName && (cd.phone || cd.email));

      if (!tieneIdentidadMinima) {
        auditBase.resultado  = 'FAIL_VALIDACION';
        auditBase.motivo     = 'Faltan datos del cliente (nombre + teléfono o email).';
        auditBase.durationMs = Date.now() - t0;
        logIntento(auditBase).catch(() => {});
        return { ok: false, version: VERSION, error: { message: auditBase.motivo } };
      }

      // v0.6.0 — Validar que el staffId está PERMITIDO para este servicio.
      // El campo idStaff (Object {ids:[...]}) en ServiceCatalog dicta quién
      // puede ejecutar el servicio. Defensa en backend porque el cliente
      // pudo manipular el payload aunque el widget filtre los chips.
      //
      // v0.8.0 — El lookup también se reutiliza para R1 (necesitamos
      // svcRow.duration). Si el lookup falla técnicamente (excepción),
      // seguimos sin idStaff (igual que v0.7.4) y sin R1 (skip con warn).
      // Si la query es exitosa pero el servicio no existe → FAIL_VALIDACION
      // (mismo comportamiento bloqueante que v0.7.4).
      let svcRow = null;
      let lookupOk = true;
      try {
        const rSvc = await wixData.query(CMS_CATALOGO)
          .eq('setupUid', principalSetupUid)
          .limit(1)
          .find({ suppressAuth: true });
        svcRow = rSvc.items?.[0] || null;
      } catch (vErr) {
        lookupOk = false;
        // Si la validación falla por error técnico, no bloqueamos —
        // mejor permitir la reserva que tirarla por un fallo de query.
        console.warn(`${TAG} ⚠️ Validación idStaff no concluyente: ${vErr.message}`);
      }

      if (lookupOk && !svcRow) {
        // Comportamiento idéntico a v0.7.4: servicio inexistente → bloquear.
        auditBase.resultado  = 'FAIL_VALIDACION';
        auditBase.motivo     = 'Servicio no encontrado en el catálogo.';
        auditBase.durationMs = Date.now() - t0;
        logIntento(auditBase).catch(() => {});
        return { ok: false, version: VERSION, error: { message: auditBase.motivo } };
      }

      let idsPermitidos = [];
      if (svcRow) {
        idsPermitidos = Array.isArray(svcRow.idStaff?.ids) ? svcRow.idStaff.ids : [];
        // Lista vacía = todos los staff activos pueden hacerlo (fallback liberal).
        if (idsPermitidos.length && staffId !== 'any') {
          if (!idsPermitidos.includes(String(staffId))) {
            console.warn(`${TAG} ⚠️ Intento de reserva con staff NO permitido: staffId=${staffId} servicio=${svcRow.label}`);
            auditBase.resultado  = 'FAIL_VALIDACION';
            auditBase.motivo     = 'El profesional seleccionado no realiza este servicio.';
            auditBase.durationMs = Date.now() - t0;
            logIntento(auditBase).catch(() => {});
            return { ok: false, version: VERSION, error: { message: auditBase.motivo } };
          }
        }
      }

      // ─────────────────────────────────────────────────────────────
      // v0.8.0 — R4: IDEMPOTENCIA por clave de cliente/slot/servicio/staff.
      // Antes de R1 y de delegar, busca duplicados de los últimos 5 min.
      // Si match → devuelve la misma reserva sin volver a disparar la
      // centralita.
      // ─────────────────────────────────────────────────────────────
      const identidad   = resolverIdentidadCliente(memberContactId, contactDetails?.phone);
      const staffIdNorm = (staffId === 'any') ? '' : String(staffId);

      if (identidad) {
        const dup = await buscarReservaDuplicada({
          identidad,
          fecha,
          horaHHmm,
          principalSetupUid,
          staffIdNorm
        });

        if (dup) {
          console.log(`${TAG} ♻️ R4 idempotente: ya existe reservaId=${dup._id} (${fecha} ${horaHHmm} · ${staffIdNorm || 'any'})`);
          auditBase.resultado  = 'OK_YAEXISTE';
          auditBase.motivo     = 'Match idempotencia 5 min — devuelta reserva existente.';
          auditBase.reservaId  = dup._id;
          auditBase.contactId  = dup.contactId || '';
          auditBase.yaExiste   = true;
          auditBase.durationMs = Date.now() - t0;
          logIntento(auditBase).catch(() => {});

          // Shape compatible con un resultado OK de crearPackReserva.
          // Sin disparar centralita: la primera ya envió email/WhatsApp.
          return {
            ok: true,
            version: VERSION,
            yaExiste: true,
            reservaId: dup._id,
            precioTotal: toNum(dup.precioTotal),
            duracionTotal: toNum(dup.duracionTotal),
            fases: (dup.fases && Array.isArray(dup.fases.items)) ? dup.fases.items : []
          };
        }
      } else {
        console.warn(`${TAG} ⚠️ R4 skip: identidad insuficiente (teléfono <6 dígitos y sin memberContactId)`);
      }

      // ─────────────────────────────────────────────────────────────
      // v0.8.0 — R1: REVALIDACIÓN de hueco antes de delegar.
      // Si la hora ya no está en huecos vigentes para el staff y la
      // duración del principal → rechazar con mensaje claro al cliente.
      // Si la revalidación falla técnicamente → NO bloqueamos (mejor
      // permitir que rechazar por error de motor; crearPackReserva es
      // la defensa final al crear sessions).
      // ─────────────────────────────────────────────────────────────
      const durPrincipal = svcRow ? toNum(svcRow.duration) : 0;
      if (durPrincipal > 0) {
        try {
          const resHuecos = await getHuecosDisponibles({
            fecha,
            proId: (staffId === 'any') ? 'any' : staffId,
            durationMin: durPrincipal,
            idStaffPermitidos: idsPermitidos
          });

          if (resHuecos?.ok) {
            const huecos = Array.isArray(resHuecos.huecos) ? resHuecos.huecos : [];
            if (!huecos.includes(horaHHmm)) {
              console.warn(`${TAG} 🚫 R1 slot ocupado: ${fecha} ${horaHHmm} (${huecos.length} huecos vigentes, ${horaHHmm} NO está)`);
              auditBase.resultado  = 'FAIL_SLOT_OCUPADO';
              auditBase.motivo     = `R1: hora ya no disponible (${huecos.length} huecos vigentes).`;
              auditBase.durationMs = Date.now() - t0;
              logIntento(auditBase).catch(() => {});
              return {
                ok: false,
                version: VERSION,
                error: { message: 'Esa hora ya no está disponible. Refresca y prueba otra.' }
              };
            }
          } else {
            console.warn(`${TAG} ⚠️ R1 revalidación no concluyente: ${resHuecos?.error?.message || 'sin detalle'}`);
          }
        } catch (rErr) {
          console.warn(`${TAG} ⚠️ R1 excepción no-bloqueante: ${rErr.message}`);
        }
      } else {
        console.warn(`${TAG} ⚠️ R1 skip: principal.duration=0 (sin defensa de revalidación)`);
      }

      // Delegar en crearPackReserva del backend de Recepción Pro.
      // Import dinámico para no acoplar el módulo en tiempo de carga.
      const { crearPackReserva } = await import('backend/recepcionProLogic.web');

      const resultado = await crearPackReserva({
        fecha,
        horaHHmm,
        principalSetupUid,
        complementosSetupUid: Array.isArray(complementosSetupUid) ? complementosSetupUid : [],
        staffId: staffId === 'any' ? '' : staffId,
        staffName,
        contactDetails: {
          firstName: cd.firstName || '',
          lastName: cd.lastName || '',
          email: cd.email || '',
          phone: cd.phone || ''
        },
        memberContactId: memberContactId || '',
        notas: notas || '',
        esProvisional: false,    // reservas públicas SÍ persisten en CRM
        origenRecepcion: false   // v0.3.0 — origen WEB (no Recepción Pro)
      });

      const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
      if (resultado?.ok) {
        console.log(`${TAG} ✅ crearReservaPublica: reservaId=${resultado.reservaId} | ${resultado.precioTotal}€ | ${elapsed}s`);

        // ─────────────────────────────────────────────────────────────
        // v0.5.0 — CENTRALITA DE COMUNICACIONES
        // Patrón copiado literalmente de simplesLogic v1.5.0 / coloracionLogic
        // v3.2.7 / tratamientosLogic v1.0.9. Envuelto en try/catch no-blocking:
        // si la centralita falla, la reserva ya está creada — el cliente
        // simplemente no recibe la notificación, sin afectar al booking.
        // ─────────────────────────────────────────────────────────────
        try {
          // 1) Resolver nombre del servicio principal (label en ServiceCatalog).
          let serviciosStr = 'Tu cita';
          try {
            const rSvc = await wixData.query(CMS_CATALOGO)
              .eq('setupUid', principalSetupUid)
              .limit(1)
              .find({ suppressAuth: true });
            if (rSvc.items?.[0]?.label) serviciosStr = rSvc.items[0].label;
          } catch (_) { /* fallback al default */ }

          // 2) Resolver nombre del estilista asignado.
          //    Si staffName vino vacío (proId='any'), crearPackReserva ya
          //    asignó staff real; lo leemos de fases[0].staffId.
          let estilistaStr = staffName || '';
          if (!estilistaStr) {
            const staffIdReal = resultado?.fases?.[0]?.staffId;
            if (staffIdReal) {
              try {
                const rStaff = await wixData.query(CMS_STAFF)
                  .eq('wixResourceId', staffIdReal)
                  .limit(1)
                  .find({ suppressAuth: true });
                estilistaStr = rStaff.items?.[0]?.displayName
                            || rStaff.items?.[0]?.canonicalName
                            || '';
              } catch (_) { /* sin nombre, va sin */ }
            }
          }

          // 3) Fecha bonita DD/MM/YYYY (formato V1 esperado por driver WhatsApp).
          const [yy, mm2, dd] = String(fecha).split('-');
          const fechaBonita = `${dd}/${mm2}/${yy}`;

          // 4) Hora final = horaInicio + duracionTotal.
          const [hh, mi] = String(horaHHmm).split(':').map(Number);
          const totalMin = Number(resultado?.duracionTotal) || 0;
          const endMin = hh * 60 + mi + totalMin;
          const eh = Math.floor(endMin / 60);
          const em = endMin % 60;
          const horaFinal = String(eh).padStart(2, '0') + ':' + String(em).padStart(2, '0');

          const importeStr = `${resultado?.precioTotal || 0}€`;
          // Origen 'Reserva Online' como en V1 — distingue del de Recepción Pro.
          const origenStr = 'Reserva Online';
          // Las reservas web no pagan online aún (futuro: integración pasarela).
          const estadoPagoStr = 'Pago en salón';
          const nombreCliente = `${cd.firstName || ''}${cd.lastName ? ' ' + cd.lastName : ''}`.trim();

          // 5) Invocación a la centralita. Import dinámico para no acoplar
          //    el módulo en tiempo de carga del backend.
          const { notificarConfirmacion } = await import('backend/comunicacionesLogic.web');
          await notificarConfirmacion({
            contactId:     resultado?.contactId || memberContactId || '',
            email:         cd.email || '',
            telefono:      cd.phone || '',
            nombreCliente,
            fecha:         fechaBonita,
            hora:          horaHHmm,
            servicios:     serviciosStr,
            estilista:     estilistaStr,
            // emailVariables idénticas en estructura a las que usa V1
            // (simplesLogic v1.5.0 / coloracionLogic v3.2.7) para que el
            // template Wix existente reciba los mismos campos sin cambios.
            emailVariables: {
              Fecha:         fechaBonita,
              Nombre:        cd.firstName || '',
              Apellido:      cd.lastName || '',
              servicios:     serviciosStr,
              profesional:   estilistaStr,
              horaInicio:    horaHHmm,
              horaFinal:     horaFinal,
              importeTotal:  importeStr,
              origen:        origenStr,
              estadoPago:    estadoPagoStr
            }
          });
          console.log(`${TAG} ✅ Notificación via centralita disparada`);
        } catch (notifErr) {
          console.error(`${TAG} ⚠️ notificarConfirmacion (no-blocking): ${notifErr.message}`);
        }
        // ─── fin centralita ──────────────────────────────────────────

        // v0.8.0 — Audit log de éxito.
        auditBase.resultado  = 'OK';
        auditBase.motivo     = '';
        auditBase.reservaId  = resultado.reservaId || '';
        auditBase.contactId  = resultado?.contactId || auditBase.memberContactId || '';
        auditBase.durationMs = Date.now() - t0;
        logIntento(auditBase).catch(() => {});

      } else {
        console.warn(`${TAG} ⚠️ crearReservaPublica falló: ${JSON.stringify(resultado?.error || {})}`);

        // v0.8.0 — Audit log de fallo del backend.
        auditBase.resultado  = 'FAIL_BACKEND';
        auditBase.motivo     = resultado?.error?.message || JSON.stringify(resultado?.error || {});
        auditBase.durationMs = Date.now() - t0;
        logIntento(auditBase).catch(() => {});
      }
      return resultado;

    } catch (e) {
      console.error(`${TAG} ❌ crearReservaPublica:`, e.message);
      auditBase.resultado  = 'FAIL_BACKEND';
      auditBase.motivo     = `Excepción: ${e.message}`;
      auditBase.durationMs = Date.now() - t0;
      logIntento(auditBase).catch(() => {});
      return { ok: false, version: VERSION, error: safeErr(e) };
    }
  }
);

// =====================================================
// 7 · GET CONSTANTS (diagnóstico)
// =====================================================
export const getConstants = webMethod(
  Permissions.Anyone,
  async () => ({
    ok: true,
    version: VERSION,
    collections: { CMS_CATALOGO, CMS_CATEGORIAS, CMS_STAFF, CMS_CONFIG, CMS_RESERVAS, CMS_AUDIT },
    filtros: { USOS_PUBLICOS, TIPOS_PRINCIPALES },
    idempotenciaVentanaMs: IDEMPOTENCIA_VENTANA_MS
  })
);