// =====================================================
// KAMISUITE - Tienda Productos (Backend)
// =====================================================
// Archivo: tiendaProductos.web.js
// Versión: 1.5.11.1
// =====================================================
// v1.5.11.1 (9 Jun 2026): FIX import wix-stores-backend.
//       Era `import { products as storesProducts } from 'wix-stores-backend'`
//       → storesProducts.getProductVariants UNDEFINED (esa función NO está
//       en un sub-objeto `products`, es export named del módulo raíz).
//       Corregido a `import { getProductVariants } from 'wix-stores-backend'`
//       y llamada directa elevate(getProductVariants)(productId).
//
// v1.5.11 (9 Jun 2026): + Soporte VARIANTES para venta desde Recepción
//       PRO V2 (KALONICE pidió productos con tamaños 250ml/1000ml).
//       Retrocompatible 100% con V1 — V1 ignora los campos nuevos.
//       (1) listarProductos: por cada producto detecta si tiene
//           productOptions; si sí, consulta wix-stores-backend
//           products.getProductVariants(productId) y devuelve
//           variants:[{variantId, label, choices, price, sku, inStock,
//           visible}]. Productos sin opciones devuelven variants:[].
//       (2) venderProductosDesdeAgenda: acepta variantId opcional en
//           cada item. Si llega, lo incluye en catalogReference.options
//           ({variantId}) cumpliendo el contrato del Wix Catalog V1
//           (manageVariants=true). Si NO llega y el producto tiene
//           variantes, devuelve error MISSING_VARIANT con la lista de
//           variantes disponibles, sustituyendo el opaco
//           EMPTY_CHECKOUT de Wix por un error procesable.
//       Sin cambios en registrarVenta, generarFacturaProducto ni
//       obtenerHistorialVentas.
//
// v1.1: wixData Stores/Products + generalInfo pickup
// v1.2: + contactos + buyerInfo + addPayments (order visible)
// v1.3: + billingInfo contactDetails + status APPROVED + limpieza debug
// v1.4: + metodoPago en registrarVenta
//       + generarFacturaProducto (Wix Invoices, patrón checkout v3.14)
//       + obtenerHistorialVentas (orders.searchOrders de eCommerce)
// v1.5: NEW venderProductosDesdeAgenda — venta multi-línea desde
//       Recepción PRO con contactId garantizado en buyerInfo.
//       Una sola order con N lineItems, una factura multi-línea, una
//       entrada en expediente. NO modifica funciones existentes.
// v1.5.1: FIX (no desplegado) email vacío en buyerInfo causaba
//       INVALID_ARGUMENT. Validación regex + omisión si no es válido.
// v1.5.2: FIX las reservas de la agenda pueden venir SIN email aunque
//       el CRM sí lo tenga. Si el booking no trae email válido, se busca
//       en el CRM por contactId (contacts.getContact). Si tampoco, la
//       venta procede solo con contactId — Wix asocia la orden al
//       contacto por contactId, el email es opcional.
//       Bonus: la factura ahora sale con el email real del CRM cuando
//       existe, en lugar del fallback genérico info@hair-times.com.
// v1.5.6: NEW registro CMS-first en PaymentReservations.
//       Tras crear la orden Wix Stores + factura, se inserta UN registro
//       en PaymentReservations con staff="TIENDA" como FUENTE DE VERDAD
//       para KAMISUITE. El cierre del día y los cards de cita leen de
//       aquí (no de Wix Stores). Wix Stores queda solo para trazabilidad
//       fiscal (factura/ticket POS). Anti-duplicado por orderId.
// v1.5.7: FIX registrarVenta (Tienda standalone) — mismos bugs que
//       v1.5.1/v1.5.2 corrigieron en venderProductosDesdeAgenda:
//       (1) Validación regex de email + fallback CRM por contactId
//       (2) buyerInfo.email condicional (solo si válido, nunca '')
//       (3) Registro en PaymentReservations (CMS-first, anti-duplicado)
//       Sin estos fixes, las ventas standalone no vinculaban contactId
//       y quedaban invisibles en Care Profile y cierre financiero.
// v1.5.8: FIX obtenerHistorialVentas — nombre del cliente se leía de
//       buyerInfo.firstName/lastName que Wix no propaga del checkout.
//       Ahora intenta billingInfo.contactDetails primero, luego
//       shippingInfo.pickupDetails.buyerDetails, luego buyerInfo.
//       FIX generarFacturaProducto — si contactName llega vacío o
//       "Sin cliente" pero hay contactId, busca nombre en CRM.
// v1.5.9: FIX generarFacturaProducto — faltaba campo fullName en
//       customer del invoice. Wix Invoices necesita fullName para
//       renderizar "Facturar a:" — mismo patrón que generarFactura
//       en testCheckout.web.js v3.17.
// v1.5.10: ANTI-DUPLICACIÓN DE FACTURAS — gestión propia vía CMS.
//       Billing/Invoices de Wix no soporta filtros (.eq() ignorado,
//       limitado a 50 items); orderInvoices en Developer Preview.
//       Solución: campo invoiceId en PaymentReservations (CMS propio).
//       (1) generarFacturaProducto: antes de crear, comprueba si el
//           registro CMS ya tiene invoiceId → devuelve previewUrl sin
//           duplicar. Tras crear, actualiza el registro con invoiceId.
//       (2) obtenerHistorialVentas: cruza orderIds con PaymentReservations
//           para devolver invoiceId al widget → botón "Ver" vs "Factura".
//       (3) venderProductosDesdeAgenda: graba invoiceId en el registro
//           CMS al insertar + fullName en customer del invoice.
// =====================================================

import { webMethod, Permissions } from 'wix-web-module';
import { elevate } from 'wix-auth';
import wixData from 'wix-data';
import { checkout, orderTransactions, orders } from 'wix-ecom-backend';
import { generalInfo } from 'wix-site-backend';
import { contacts } from 'wix-crm-backend';
import { invoices } from 'wix-billing-backend';
import { getProductVariants } from 'wix-stores-backend';   // v1.5.11

const TAG = '[TiendaProductos]';
const VERSION = "1.5.11.1";

// AppId de Wix Stores para catalogReference en eCommerce
const STORES_APP_ID = '215238eb-22a5-4c36-9e7b-e7c08025e04e';

// v1.5.6: colección CMS fuente de verdad para ventas y cobros
const COLECCION_PAGOS = 'PaymentReservations';

// v1.5.7: utilidad compartida — validación de email
const isValidEmail = (e) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

// v1.5.11: helper para leer variantes de un producto
async function leerVariantesDeProducto(productId, fallbackPrice) {
  try {
    const elevatedGetVariants = elevate(getProductVariants);
    const vResult = await elevatedGetVariants(productId);
    const arr = Array.isArray(vResult) ? vResult : (vResult?.items || []);
    return arr
      .filter(v => v?.variant?.visible !== false)
      .map(v => {
        const choices = v.choices || {};
        const label = Object.values(choices).join(' / ') || (v.variant?.sku || 'Variante');
        return {
          variantId: v._id || v.id,
          label,
          choices,
          price: (v.variant?.price ?? fallbackPrice) || 0,
          sku: v.variant?.sku || '',
          inStock: v.variant?.inStock !== false
        };
      });
  } catch (e) {
    console.warn(`${TAG} getProductVariants failed for ${productId}:`, e.message);
    return [];
  }
}

// =====================================================
// UTILIDADES CONTACTOS (mismo patrón que recepcionLogic)
// =====================================================

function formatearContacto(contact) {
  const infoName = contact?.info?.name || {};
  const nombre = infoName.first || contact?.name?.first || contact?.firstName || '';
  const apellido = infoName.last || contact?.name?.last || contact?.lastName || '';

  const emailsArray = contact?.info?.emails || contact?.emails || [];
  const emails = Array.isArray(emailsArray) ? emailsArray : [];
  const email = emails[0]?.email || emails[0] || contact?.primaryEmail || '';

  const phonesArray = contact?.info?.phones || contact?.phones || [];
  const phones = Array.isArray(phonesArray) ? phonesArray : [];
  const telefono = phones[0]?.phone || phones[0] || contact?.primaryPhone || '';

  return {
    contactId: contact._id || contact.id,
    nombre: String(nombre).trim(),
    apellido: String(apellido).trim(),
    nombreCompleto: `${nombre} ${apellido}`.trim(),
    email: String(email).trim(),
    telefono: String(telefono).trim()
  };
}

// =====================================================
// 1. LISTAR PRODUCTOS (vía wixData — Stores/Products)
// =====================================================
// v1.5.11: ahora devuelve variants[] por producto (cuando aplica).
//          V1 ignora ese campo, V2 lo usa para mostrar opciones de
//          tamaño y mandar variantId al venderProductosDesdeAgenda.
// =====================================================
export const listarProductos = webMethod(
  Permissions.Anyone,
  async () => {
    try {
      console.log(`${TAG} 📦 Leyendo productos de la tienda...`);

      let items = [];
      let skip = 0;
      const PAGE = 100;
      let hasMore = true;

      while (hasMore) {
        const result = await wixData.query("Stores/Products")
          .include("collections")
          .limit(PAGE)
          .skip(skip)
          .find();

        const page = result.items || [];
        items = items.concat(page);
        console.log(`${TAG} 📄 Página ${skip / PAGE + 1}: ${page.length} productos (acumulado: ${items.length})`);
        hasMore = page.length === PAGE;
        skip += PAGE;
      }

      console.log(`${TAG} ✅ ${items.length} productos encontrados`);

      // Leer colecciones (categorías) disponibles
      let allCollections = [];
      try {
        const colResult = await wixData.query("Stores/Collections")
          .limit(100)
          .find();
        allCollections = (colResult.items || []).map(c => ({
          id: c._id,
          name: c.name || ''
        }));
        console.log(`${TAG} 📂 ${allCollections.length} colecciones: ${allCollections.map(c => c.name).join(', ')}`);
      } catch (colErr) {
        console.warn(`${TAG} ⚠️ No se pudieron leer Stores/Collections:`, colErr.message);
      }

      // v1.5.11: para productos con opciones, leer variantes en paralelo
      const lista = await Promise.all(items.map(async prod => {
        let prodCollections = [];
        if (Array.isArray(prod.collections)) {
          prodCollections = prod.collections.map(c => ({
            id: c._id || '',
            name: c.name || ''
          }));
        }

        // Detectar si tiene variantes para no malgastar queries
        const productOptions = Array.isArray(prod.productOptions) ? prod.productOptions : [];
        const hasOptions = productOptions.length > 0 || prod.manageVariants === true;

        let variants = [];
        let manageVariants = false;
        if (hasOptions) {
          variants = await leerVariantesDeProducto(prod._id, prod.price);
          // Solo es "manageVariants" real si hay más de 1 variante visible
          manageVariants = variants.length > 1;
        }

        return {
          id: prod._id,
          name: prod.name || '',
          price: prod.price,
          formattedPrice: prod.formattedPrice || '',
          mainMedia: prod.mainMedia || '',
          sku: prod.sku || '',
          inStock: prod.inStock !== false,
          productType: prod.productType || 'physical',
          description: prod.description || '',
          ribbon: prod.ribbon || '',
          collections: prodCollections,
          productPageUrl: prod.productPageUrl || '',
          // v1.5.11 — campos nuevos (retrocompatibles, V1 los ignora)
          manageVariants,
          variants
        };
      }));

      const conVariantes = lista.filter(p => p.manageVariants).length;
      console.log(`${TAG} 📦 ${lista.length} productos · ${conVariantes} con variantes`);

      return {
        ok: true,
        total: lista.length,
        productos: lista,
        collections: allCollections
      };

    } catch (e) {
      console.error(`${TAG} ❌ listarProductos FAIL:`, e);
      return { ok: false, error: e.message };
    }
  }
);

// =====================================================
// 2. CARGAR CONTACTOS (para selector de cliente)
// =====================================================
// ── SIN CAMBIOS v1.4 ──
export const cargarContactosTienda = webMethod(
  Permissions.Anyone,
  async () => {
    try {
      console.log(`${TAG} 📇 Cargando contactos...`);

      const elevatedQuery = elevate(contacts.queryContacts);
      const allContacts = [];
      let hasMore = true;
      let skip = 0;
      const pageSize = 1000;

      while (hasMore) {
        const result = await elevatedQuery()
          .skip(skip)
          .limit(pageSize)
          .find();

        const items = result?.items || [];
        allContacts.push(...items);

        if (items.length < pageSize) {
          hasMore = false;
        } else {
          skip += pageSize;
        }

        if (skip >= 10000) {
          console.warn(`${TAG} ⚠️ Límite seguridad contactos (10,000)`);
          hasMore = false;
        }
      }

      const clientes = allContacts
        .map(formatearContacto)
        .filter(c => c.nombre || c.apellido || c.email)
        .sort((a, b) => a.nombreCompleto.localeCompare(b.nombreCompleto));

      console.log(`${TAG} ✅ ${clientes.length} contactos cargados`);

      return {
        ok: true,
        version: VERSION,
        clientes,
        total: clientes.length
      };

    } catch (e) {
      console.error(`${TAG} ❌ cargarContactosTienda FAIL:`, e);
      return { ok: false, error: e.message };
    }
  }
);

// =====================================================
// 3. CREAR CONTACTO (para clientes nuevos)
// =====================================================
// ── SIN CAMBIOS v1.4 ──
export const crearContactoTienda = webMethod(
  Permissions.Anyone,
  async (payload) => {
    try {
      const { nombre, apellido, email, telefono } = payload || {};

      console.log(`${TAG} ➕ Creando contacto: ${nombre} ${apellido}`);

      if (!nombre) throw new Error('Nombre es requerido');

      const contactInfo = {
        name: {
          first: String(nombre).trim(),
          last: String(apellido || '').trim()
        },
        emails: email ? [{ email: String(email).trim() }] : [],
        phones: telefono ? [{ phone: String(telefono).trim() }] : []
      };

      const elevatedCreate = elevate(contacts.createContact);
      const newContact = await elevatedCreate(contactInfo, { allowDuplicates: true, suppressAuth: true });

      const contactId = newContact?._id || newContact?.id;
      console.log(`${TAG} ✅ Contacto creado: ${contactId}`);

      return {
        ok: true,
        contactId,
        cliente: {
          contactId,
          nombre: String(nombre).trim(),
          apellido: String(apellido || '').trim(),
          nombreCompleto: `${nombre} ${apellido || ''}`.trim(),
          email: email || '',
          telefono: telefono || ''
        }
      };

    } catch (e) {
      console.error(`${TAG} ❌ crearContactoTienda FAIL:`, e.message);
      return { ok: false, error: e.message };
    }
  }
);

// =====================================================
// 4. REGISTRAR VENTA (venta presencial en salón)
// =====================================================
// ── SIN CAMBIOS v1.5.10 ── (V1 standalone, no necesita variantes)
// =====================================================
export const registrarVenta = webMethod(
  Permissions.Anyone,
  async ({ productId, productName, price, currency, quantity, contactId, contactName, contactEmail, contactPhone, metodoPago }) => {
    const t0 = Date.now();
    try {
      console.log(`${TAG} 🛒 Venta: ${productName} x${quantity} @ ${price}${currency || 'EUR'} | ${metodoPago || 'offline'} | contacto: ${contactId || 'anónimo'}`);

      if (!productId) throw new Error('productId es requerido');
      if (!price || price <= 0) throw new Error('price debe ser > 0');
      const qty = quantity || 1;
      const cur = currency || 'EUR';

      let businessAddress;
      try {
        businessAddress = await generalInfo.getAddress();
      } catch (addrErr) {
        businessAddress = { street: "Salón", city: "Madrid", country: "ES" };
      }

      const nameParts = (contactName || 'Cliente').split(' ');
      const firstName = nameParts[0] || 'Cliente';
      const lastName = nameParts.slice(1).join(' ') || '';

      let emailValido = isValidEmail(contactEmail) ? contactEmail.trim() : null;

      if (!emailValido && contactId) {
        try {
          const elevatedGetContact = elevate(contacts.getContact);
          const crmContact = await elevatedGetContact(contactId);
          const crmEmails = crmContact?.info?.emails || crmContact?.emails || [];
          const candidato = (Array.isArray(crmEmails) && crmEmails.length)
            ? (crmEmails[0]?.email || crmEmails[0] || '')
            : (crmContact?.primaryEmail || '');
          if (isValidEmail(candidato)) emailValido = String(candidato).trim();
        } catch (crmErr) {}
      }

      const contactDetails = { firstName, lastName };
      if (contactPhone) contactDetails.phone = contactPhone;

      const buyerDetails = { firstName, lastName };
      if (emailValido) buyerDetails.email = emailValido;
      if (contactPhone) buyerDetails.phone = contactPhone;

      const checkoutOptions = {
        lineItems: [{
          quantity: qty,
          catalogReference: {
            appId: STORES_APP_ID,
            catalogItemId: productId
          }
        }],
        channelType: "POS",
        checkoutInfo: {
          billingInfo: { contactDetails: contactDetails, address: businessAddress },
          shippingInfo: { pickupDetails: { pickupAddress: businessAddress, buyerDetails: buyerDetails } }
        }
      };

      if (contactId) {
        const buyerInfo = { contactId: contactId, firstName: firstName, lastName: lastName };
        if (emailValido) buyerInfo.email = emailValido;
        checkoutOptions.checkoutInfo.buyerInfo = buyerInfo;
      }

      const elevatedCreateCheckout = elevate(checkout.createCheckout);
      const checkoutResult = await elevatedCreateCheckout(checkoutOptions);
      if (!checkoutResult?._id) throw new Error('No se pudo crear checkout');

      const elevatedCreateOrder = elevate(checkout.createOrder);
      const orderResult = await elevatedCreateOrder(checkoutResult._id, { payNow: { option: "FULL_PAYMENT_OFFLINE" } });
      const orderId = orderResult?.orderId || orderResult?._id || null;

      const totalImporte = parseFloat(price) * qty;
      if (orderId) {
        try {
          const totalAmount = totalImporte.toFixed(2);
          const elevatedAddPayments = elevate(orderTransactions.addPayments);
          await elevatedAddPayments(orderId, [{
            amount: { amount: totalAmount, currency: cur },
            regularPaymentDetails: { offlinePayment: true, status: "APPROVED" }
          }]);
        } catch (payErr) {}
      }

      // PaymentReservations
      try {
        const claveCms = orderId || `prod-${Date.now()}`;
        let yaExiste = false;
        if (orderId) {
          const existente = await wixData.query(COLECCION_PAGOS).eq('bookingId', orderId).limit(1).find();
          yaExiste = (existente.items || []).length > 0;
        }
        if (!yaExiste) {
          const subtotal = Math.round(totalImporte * 100) / 100;
          const sufijoQty = qty > 1 ? ` x${qty}` : '';
          const descripcionProducto = `🛒 ${(productName || 'Producto').trim()}${sufijoQty} (${subtotal}€)`;
          const ahora = new Date();
          const registroPago = {
            bookingId: claveCms,
            fechaReserva: ahora,
            fechaPago: ahora,
            descripcion: descripcionProducto,
            nombreCliente: (contactName || '').trim(),
            importeTotal: subtotal,
            tipoPago: metodoPago || 'Efectivo',
            staff: 'TIENDA_POS',
            contactId: contactId || ''
          };
          await wixData.insert(COLECCION_PAGOS, registroPago);
        }
      } catch (cmsErr) {}

      const tiempoVenta = ((Date.now() - t0) / 1000).toFixed(1);
      return { ok: true, orderId, checkoutId: checkoutResult._id, tiempoVenta, metodoPago: metodoPago || 'offline' };

    } catch (e) {
      const tiempoVenta = ((Date.now() - t0) / 1000).toFixed(1);
      console.error(`${TAG} ❌ registrarVenta FAIL:`, e.message);
      return { ok: false, error: e.message, tiempoVenta };
    }
  }
);

// =====================================================
// 5. GENERAR FACTURA PRODUCTO (Wix Invoices) — SIN CAMBIOS
// =====================================================
export const generarFacturaProducto = webMethod(
  Permissions.Anyone,
  async ({ contactId, email, contactName, contactPhone, productName, price, quantity, currency, metodoPago, orderId }) => {
    try {
      if (orderId) {
        try {
          const existente = await wixData.query(COLECCION_PAGOS).eq('bookingId', orderId).limit(1).find();
          const registro = (existente.items || [])[0];
          if (registro && registro.invoiceId) {
            let previewUrl = null;
            try {
              const elevatedGetInvoice = elevate(invoices.getInvoice);
              const existingInvoice = await elevatedGetInvoice(registro.invoiceId);
              const elevatedPreview = elevate(invoices.createInvoicePreviewUrl);
              previewUrl = await elevatedPreview(existingInvoice.id);
            } catch (urlErr) {}
            return { ok: true, invoiceId: registro.invoiceId, previewUrl, existing: true };
          }
        } catch (checkErr) {}
      }

      let resolvedName = (contactName || '').trim();
      let resolvedEmail = (email || '').trim();
      const nameIsMissing = !resolvedName || resolvedName.toLowerCase() === 'sin cliente';
      if ((nameIsMissing || !resolvedEmail) && contactId) {
        try {
          const elevatedGetContact = elevate(contacts.getContact);
          const crmContact = await elevatedGetContact(contactId);
          if (nameIsMissing) {
            const crmName = crmContact?.info?.name || {};
            const crmFull = `${crmName.first || ''} ${crmName.last || ''}`.trim();
            if (crmFull) resolvedName = crmFull;
          }
          if (!resolvedEmail || !isValidEmail(resolvedEmail)) {
            const crmEmails = crmContact?.info?.emails || crmContact?.emails || [];
            const candidato = (Array.isArray(crmEmails) && crmEmails.length) ? (crmEmails[0]?.email || crmEmails[0] || '') : (crmContact?.primaryEmail || '');
            if (isValidEmail(candidato)) resolvedEmail = String(candidato).trim();
          }
        } catch (crmErr) {}
      }
      if (!resolvedEmail) resolvedEmail = 'info@hair-times.com';

      const IVA_RATE = 21;
      const IVA_DIVISOR = 1 + (IVA_RATE / 100);
      const precioConIVA = parseFloat(price) || 0;
      const qty = quantity || 1;
      const baseImponible = Math.round((precioConIVA / IVA_DIVISOR) * 100) / 100;

      const lineItems = [{
        name: (productName || 'Producto').trim(),
        description: `POS · ${metodoPago || 'Offline'}${orderId ? ' · Pedido ' + orderId.substring(0, 8) : ''}`,
        price: baseImponible,
        quantity: qty,
        taxes: [{ name: 'IVA', rate: IVA_RATE, code: 'IVA' }]
      }];

      const nameParts = (resolvedName || '').split(' ');
      const firstName = nameParts[0] || '';
      const lastName = nameParts.slice(1).join(' ') || '';

      const invoiceFields = {
        title: `Venta producto ${new Date().toLocaleDateString('es-ES')}`,
        customer: { contactId: contactId || undefined, email: resolvedEmail, phone: contactPhone || '', firstName, lastName, fullName: `${firstName} ${lastName}`.trim() },
        currency: currency || 'EUR',
        lineItems,
        dates: { issueDate: new Date(), dueDate: new Date() },
        metadata: { notes: 'Gracias por confiar en nosotros', source: 'KAMISUITE', sourceRefId: `tienda-${orderId || new Date().toISOString().substring(0, 10)}` }
      };

      const elevatedCreateInvoice = elevate(invoices.createInvoice);
      const result = await elevatedCreateInvoice(invoiceFields);
      const invoiceId = result?.id?.id || result?.id || result?._id || null;

      const totalConIVA = precioConIVA * qty;
      try {
        const elevatedAddPayment = elevate(invoices.addPayment);
        await elevatedAddPayment(result.id, { type: 'Offline', amount: totalConIVA, date: new Date() });
      } catch (payErr) {}

      let previewUrl = null;
      try {
        const elevatedPreview = elevate(invoices.createInvoicePreviewUrl);
        previewUrl = await elevatedPreview(result.id);
      } catch (urlErr) {}

      if (invoiceId && orderId) {
        try {
          const cmsResult = await wixData.query(COLECCION_PAGOS).eq('bookingId', orderId).limit(1).find();
          const registro = (cmsResult.items || [])[0];
          if (registro) {
            registro.invoiceId = invoiceId;
            await wixData.update(COLECCION_PAGOS, registro);
          }
        } catch (cmsErr) {}
      }

      return { ok: true, invoiceId, previewUrl };
    } catch (error) {
      console.error(`${TAG} ❌ Error generarFacturaProducto:`, error);
      return { ok: false, error: error.message };
    }
  }
);

// =====================================================
// 6. HISTORIAL DE VENTAS — SIN CAMBIOS
// =====================================================
export const obtenerHistorialVentas = webMethod(
  Permissions.Anyone,
  async ({ fechaDesde, fechaHasta, limit }) => {
    try {
      const elevatedSearch = elevate(orders.searchOrders);
      const filterConditions = [{ "channelInfo.type": "POS" }];
      if (fechaDesde) filterConditions.push({ "_createdDate": { "$gte": new Date(fechaDesde).toISOString() } });
      if (fechaHasta) {
        const hasta = new Date(fechaHasta);
        hasta.setDate(hasta.getDate() + 1);
        filterConditions.push({ "_createdDate": { "$lt": hasta.toISOString() } });
      }
      const searchOptions = {
        search: {
          filter: filterConditions.length > 1 ? { "$and": filterConditions } : filterConditions[0] || {},
          cursorPaging: { limit: limit || 50 }
        }
      };
      const result = await elevatedSearch(searchOptions);
      const ordersData = result?.orders || [];

      const ventas = ordersData.map(order => {
        const lineItem = order.lineItems?.[0] || {};
        const billing = order.billingInfo?.contactDetails || {};
        const shipping = order.shippingInfo?.shipmentDetails?.address?.contactDetails || order.shippingInfo?.pickupDetails?.buyerDetails || {};
        const buyer = order.buyerInfo || {};
        const resolvedFirst = billing.firstName || shipping.firstName || buyer.firstName || '';
        const resolvedLast = billing.lastName || shipping.lastName || buyer.lastName || '';
        const buyerName = `${resolvedFirst} ${resolvedLast}`.trim();
        const buyerEmail = buyer.email || '';
        return {
          orderId: order._id,
          fecha: order._createdDate,
          productName: lineItem.productName?.translated || lineItem.productName?.original || lineItem.name || 'Producto',
          quantity: lineItem.quantity || 1,
          precio: lineItem.price?.amount || lineItem.totalPrice?.amount || '0',
          currency: lineItem.price?.currency || 'EUR',
          totalOrder: order.priceSummary?.totalPrice?.amount || '0',
          clienteNombre: buyerName || 'Sin cliente',
          clienteEmail: buyerEmail,
          contactId: order.buyerInfo?.contactId || '',
          paymentStatus: order.paymentStatus || '',
          fulfillmentStatus: order.fulfillmentStatus || ''
        };
      });

      try {
        const orderIds = ventas.map(v => v.orderId).filter(Boolean);
        if (orderIds.length > 0) {
          const cmsResult = await wixData.query(COLECCION_PAGOS).hasSome('bookingId', orderIds).limit(orderIds.length).find();
          const mapaInvoice = {};
          for (const item of (cmsResult.items || [])) {
            if (item.bookingId && item.invoiceId) mapaInvoice[item.bookingId] = item.invoiceId;
          }
          for (const venta of ventas) venta.invoiceId = mapaInvoice[venta.orderId] || '';
        }
      } catch (cmsErr) {}

      return { ok: true, ventas, total: ventas.length, version: VERSION };
    } catch (e) {
      console.error(`${TAG} ❌ obtenerHistorialVentas FAIL:`, e);
      return { ok: false, error: e.message };
    }
  }
);

// =====================================================
// 7. VENDER PRODUCTOS DESDE AGENDA (Recepción PRO)
// =====================================================
// v1.5.11: + soporte variantId opcional por item.
//          Si el item incluye variantId, se añade en
//          catalogReference.options.variantId (Wix Catalog V1).
//          Si el item NO trae variantId pero el producto tiene
//          variantes (>1), se devuelve error MISSING_VARIANT con
//          la lista de variantes posibles para que el caller pueda
//          mostrar al usuario qué elegir.
//          V1 sigue funcionando sin tocar (no manda variantId).
// =====================================================
export const venderProductosDesdeAgenda = webMethod(
  Permissions.Anyone,
  async ({ contactId, contactName, contactEmail, contactPhone, items, metodoPago, currency, bookingId, packId, desglosemetodopago }) => {
    const t0 = Date.now();
    try {
      // ── 0. Validación de entrada ──
      if (!contactId) {
        throw new Error('contactId requerido (venta desde Recepción PRO necesita cliente identificado)');
      }
      if (!Array.isArray(items) || items.length === 0) {
        throw new Error('items[] requerido (al menos un producto)');
      }
      for (const it of items) {
        if (!it.productId) throw new Error('Cada item necesita productId');
        if (!it.price || it.price <= 0) throw new Error(`Item ${it.productName || it.productId}: price debe ser > 0`);
      }

      // ── v1.5.11: Verificar variantes faltantes ──
      // Si algún item es de un producto con variantes y no trae variantId,
      // devolver error claro (en lugar del opaco EMPTY_CHECKOUT de Wix).
      const itemsSinVariante = [];
      for (const it of items) {
        if (it.variantId) continue;  // ya viene resuelto, perfecto
        // Comprobar si el producto tiene >1 variante visible
        const vars = await leerVariantesDeProducto(it.productId, it.price);
        if (vars.length > 1) {
          itemsSinVariante.push({
            productId: it.productId,
            productName: it.productName || '',
            variants: vars
          });
        }
      }
      if (itemsSinVariante.length) {
        const lista = itemsSinVariante.map(p => `${p.productName} (${p.variants.length} variantes)`).join(', ');
        console.warn(`${TAG} ⚠️ MISSING_VARIANT: ${lista}`);
        return {
          ok: false,
          error: 'MISSING_VARIANT',
          missingVariants: itemsSinVariante,
          message: `Selecciona tamaño / variante para: ${lista}`
        };
      }

      const cur = currency || 'EUR';
      const totalItems = items.reduce((acc, it) => acc + (it.quantity || 1), 0);
      const totalImporte = items.reduce((acc, it) => acc + (parseFloat(it.price) * (it.quantity || 1)), 0);

      console.log(`${TAG} 🛒 Venta desde Agenda: ${items.length} producto(s), ${totalItems} unidad(es), total ${totalImporte.toFixed(2)}${cur} | ${metodoPago || 'offline'} | contacto: ${contactId}`);
      console.log(`${TAG} 🛒 Trazabilidad: packId="${packId||''}" bookingId="${bookingId||''}" contactName="${contactName||''}"`);

      let businessAddress;
      try {
        businessAddress = await generalInfo.getAddress();
      } catch (addrErr) {
        businessAddress = { street: 'Salón', city: 'Madrid', country: 'ES' };
      }

      const nameParts = (contactName || 'Cliente').split(' ');
      const firstName = nameParts[0] || 'Cliente';
      const lastName = nameParts.slice(1).join(' ') || '';

      let emailValido = isValidEmail(contactEmail) ? contactEmail.trim() : null;
      let emailFuente = emailValido ? 'booking' : null;

      if (!emailValido && contactId) {
        try {
          const elevatedGetContact = elevate(contacts.getContact);
          const crmContact = await elevatedGetContact(contactId);
          const crmEmails = crmContact?.info?.emails || crmContact?.emails || [];
          const candidato = (Array.isArray(crmEmails) && crmEmails.length) ? (crmEmails[0]?.email || crmEmails[0] || '') : (crmContact?.primaryEmail || '');
          if (isValidEmail(candidato)) {
            emailValido = String(candidato).trim();
            emailFuente = 'crm';
          }
        } catch (crmErr) {}
      }

      const contactDetails = { firstName, lastName };
      if (contactPhone) contactDetails.phone = contactPhone;

      const buyerDetails = { firstName, lastName };
      if (emailValido) buyerDetails.email = emailValido;
      if (contactPhone) buyerDetails.phone = contactPhone;

      const buyerInfo = { contactId: contactId, firstName: firstName, lastName: lastName };
      if (emailValido) buyerInfo.email = emailValido;

      // ── v1.5.11: lineItems con catalogReference.options.variantId ──
      const checkoutOptions = {
        lineItems: items.map(it => {
          const ref = {
            appId: STORES_APP_ID,
            catalogItemId: it.productId
          };
          if (it.variantId) {
            ref.options = { variantId: it.variantId };
          }
          return {
            quantity: it.quantity || 1,
            catalogReference: ref
          };
        }),
        channelType: 'POS',
        buyerNote: `[KAMISUITE]${JSON.stringify({
          packId: packId || '',
          bookingId: bookingId || '',
          contactName: (contactName || '').trim(),
          metodoPago: metodoPago || 'Efectivo'
        })}`,
        checkoutInfo: {
          buyerInfo: buyerInfo,
          billingInfo: { contactDetails: contactDetails, address: businessAddress },
          shippingInfo: { pickupDetails: { pickupAddress: businessAddress, buyerDetails: buyerDetails } }
        }
      };

      const elevatedCreateCheckout = elevate(checkout.createCheckout);
      const checkoutResult = await elevatedCreateCheckout(checkoutOptions);
      if (!checkoutResult?._id) throw new Error('No se pudo crear checkout');
      console.log(`${TAG} ✅ Checkout: ${checkoutResult._id}`);

      const elevatedCreateOrder = elevate(checkout.createOrder);
      const orderResult = await elevatedCreateOrder(checkoutResult._id, { payNow: { option: 'FULL_PAYMENT_OFFLINE' } });
      const orderId = orderResult?.orderId || orderResult?._id || null;
      console.log(`${TAG} ✅ Order: ${orderId}`);

      if (orderId) {
        try {
          const totalAmount = totalImporte.toFixed(2);
          const elevatedAddPayments = elevate(orderTransactions.addPayments);
          await elevatedAddPayments(orderId, [{
            amount: { amount: totalAmount, currency: cur },
            regularPaymentDetails: { offlinePayment: true, status: 'APPROVED' }
          }]);
        } catch (payErr) {}
      }

      // Factura best-effort
      let invoiceId = null;
      let previewUrl = null;
      try {
        const emailFactura = emailValido || 'info@hair-times.com';
        const IVA_RATE = 21;
        const IVA_DIVISOR = 1 + (IVA_RATE / 100);
        const lineItems = items.map(it => {
          const precioConIVA = parseFloat(it.price) || 0;
          const qty = it.quantity || 1;
          const baseImponible = Math.round((precioConIVA / IVA_DIVISOR) * 100) / 100;
          // v1.5.11: nombre completo con variante si la hay
          const nombreCompleto = it.variantLabel ? `${(it.productName || 'Producto').trim()} · ${it.variantLabel}` : (it.productName || 'Producto').trim();
          return {
            name: nombreCompleto,
            description: `POS · ${metodoPago || 'Offline'}${orderId ? ' · Pedido ' + orderId.substring(0, 8) : ''}`,
            price: baseImponible,
            quantity: qty,
            taxes: [{ name: 'IVA', rate: IVA_RATE, code: 'IVA' }]
          };
        });
        const invoiceFields = {
          title: `Venta producto ${new Date().toLocaleDateString('es-ES')}`,
          customer: { contactId: contactId, email: emailFactura, phone: contactPhone || '', firstName, lastName, fullName: `${firstName} ${lastName}`.trim() },
          currency: cur,
          lineItems,
          dates: { issueDate: new Date(), dueDate: new Date() },
          metadata: { notes: 'Gracias por confiar en nosotros', source: 'KAMISUITE', sourceRefId: `agenda-${orderId || new Date().toISOString().substring(0, 10)}` }
        };
        const elevatedCreateInvoice = elevate(invoices.createInvoice);
        const invResult = await elevatedCreateInvoice(invoiceFields);
        invoiceId = invResult?.id?.id || invResult?.id || invResult?._id || null;
        try {
          const elevatedAddPayment = elevate(invoices.addPayment);
          await elevatedAddPayment(invResult.id, { type: 'Offline', amount: totalImporte, date: new Date() });
        } catch (payErr) {}
        try {
          const elevatedPreview = elevate(invoices.createInvoicePreviewUrl);
          previewUrl = await elevatedPreview(invResult.id);
        } catch (urlErr) {}
      } catch (invErr) {
        console.warn(`${TAG} ⚠️ Factura falló (orden persistió):`, invErr.message);
      }

      // PaymentReservations CMS-first
      try {
        const claveCms = orderId || `prod-${Date.now()}`;
        let yaExiste = false;
        if (orderId) {
          const existente = await wixData.query(COLECCION_PAGOS).eq('bookingId', orderId).limit(1).find();
          yaExiste = (existente.items || []).length > 0;
        }
        if (!yaExiste) {
          const descripcionProductos = items.map(it => {
            const nombre = (it.productName || 'Producto').trim();
            // v1.5.11: si hay variantLabel, lo añadimos al texto del CMS
            const nombreCompleto = it.variantLabel ? `${nombre} · ${it.variantLabel}` : nombre;
            const qty = it.quantity || 1;
            const precioUnit = parseFloat(it.price) || 0;
            const subtotal = Math.round(precioUnit * qty * 100) / 100;
            const sufijoQty = qty > 1 ? ` x${qty}` : '';
            return `🛒 ${nombreCompleto}${sufijoQty} (${subtotal}€)`;
          }).join(', ');
          const ahora = new Date();
          const registroPago = {
            bookingId: claveCms,
            fechaReserva: ahora,
            fechaPago: ahora,
            descripcion: descripcionProductos,
            nombreCliente: (contactName || '').trim(),
            importeTotal: Math.round(totalImporte * 100) / 100,
            tipoPago: metodoPago || 'Efectivo',
            staff: 'TIENDA',
            contactId: contactId || '',
            desglosemetodopago: desglosemetodopago || '',
            invoiceId: invoiceId || ''
          };
          await wixData.insert(COLECCION_PAGOS, registroPago);
          console.log(`${TAG} ✅ Venta registrada en ${COLECCION_PAGOS}: "${descripcionProductos}"`);
        }
      } catch (cmsErr) {
        console.error(`${TAG} ❌ Error guardando en ${COLECCION_PAGOS}:`, cmsErr.message);
      }

      const tiempoVenta = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`${TAG} ✅ Venta agenda completada: ${orderId} (${tiempoVenta}s)`);

      return {
        ok: true,
        orderId,
        invoiceId,
        previewUrl,
        checkoutId: checkoutResult._id,
        total: parseFloat(totalImporte.toFixed(2)),
        currency: cur,
        itemCount: items.length,
        unitCount: totalItems,
        metodoPago: metodoPago || 'offline',
        tiempoVenta,
        version: VERSION
      };

    } catch (e) {
      const tiempoVenta = ((Date.now() - t0) / 1000).toFixed(1);
      console.error(`${TAG} ❌ venderProductosDesdeAgenda FAIL:`, e.message);
      return { ok: false, error: e.message, tiempoVenta };
    }
  }
);