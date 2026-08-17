// =====================================================
// KAMISUITE - Edición Categorías (Tour de Servicios) - Page Code
// =====================================================
// PÁGINA: Edición Categorías (admin)
// WIDGET: #htmlEdicionCategorias (HTML embed con editor_categorias.html)
//
// VERSIÓN: 1.0.0
// FECHA: 21 de junio de 2026
//
// Edita el CMS HairSalonServices (primer nivel de Tour de Servicios).
// Mensajes del widget:
//   ready                → cargar categorías
//   saveCategoria        → actualizar textos + groupCatalog + orden
//   toggleCategoria      → activo/inactivo
//   uploadCategoriaImage → subir imagen
//
// IMPORTANTE: ajusta el ID del elemento HTML (#htmlEdicionCategorias) al
// que tengas en el editor de Wix si fuera distinto.
// =====================================================

import {
  listarCategorias,
  actualizarCategoria,
  toggleCategoriaActiva,
  uploadImagenCategoria
} from 'backend/categoriasEditorLogic.web';

const TAG = '[EdicionCategorias]';

$w.onReady(async function () {
  console.log(`${TAG} ✅ Página cargada`);

  const widget = $w('#htmlEdicionCategorias');

  widget.onMessage(async (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;

    console.log(`${TAG} 📩 Mensaje recibido:`, msg.type);

    if (msg.type === 'ready') {
      await cargarDatos(widget);
    }

    if (msg.type === 'saveCategoria') {
      await guardarCategoria(widget, msg.payload);
    }

    if (msg.type === 'toggleCategoria') {
      await toggleCategoria(widget, msg.payload);
    }

    if (msg.type === 'uploadCategoriaImage') {
      await subirImagen(widget, msg.payload);
    }
  });
});

// ═══════════════════════════════════════════════════
// CARGAR DATOS
// ═══════════════════════════════════════════════════
async function cargarDatos(widget) {
  try {
    console.log(`${TAG} 📋 Cargando categorías...`);
    const result = await listarCategorias();

    if (result.success) {
      console.log(`${TAG} ✅ ${result.categorias.length} categorías cargadas`);
      widget.postMessage({
        type: 'data',
        payload: { categorias: result.categorias }
      });
    } else {
      console.error(`${TAG} ❌ Error:`, result.error);
      widget.postMessage({ type: 'error', message: result.error });
    }
  } catch (error) {
    console.error(`${TAG} ❌ Error cargando:`, error);
    widget.postMessage({ type: 'error', message: error.message });
  }
}

// ═══════════════════════════════════════════════════
// GUARDAR CATEGORÍA
// ═══════════════════════════════════════════════════
async function guardarCategoria(widget, payload) {
  try {
    console.log(`${TAG} 💾 Guardando categoría:`, payload._catId);
    const result = await actualizarCategoria(payload);

    if (result.success) {
      console.log(`${TAG} ✅ Categoría actualizada`);
      widget.postMessage({ type: 'categoriaSaved', payload: result });
    } else {
      console.error(`${TAG} ❌ Error:`, result.error);
      widget.postMessage({ type: 'categoriaSaveError', message: result.error });
    }
  } catch (error) {
    console.error(`${TAG} ❌ Error guardando:`, error);
    widget.postMessage({ type: 'categoriaSaveError', message: error.message });
  }
}

// ═══════════════════════════════════════════════════
// TOGGLE ACTIVO / INACTIVO
// ═══════════════════════════════════════════════════
async function toggleCategoria(widget, payload) {
  try {
    console.log(`${TAG} 🔁 Toggle categoría:`, payload.catId, '→', payload.activo);
    const result = await toggleCategoriaActiva({ catId: payload.catId, activo: payload.activo });

    if (result.success) {
      console.log(`${TAG} ✅ Estado cambiado`);
      widget.postMessage({ type: 'categoriaToggled', payload: result });
    } else {
      console.error(`${TAG} ❌ Error:`, result.error);
      widget.postMessage({ type: 'categoriaToggleError', message: result.error });
    }
  } catch (error) {
    console.error(`${TAG} ❌ Error toggle:`, error);
    widget.postMessage({ type: 'categoriaToggleError', message: error.message });
  }
}

// ═══════════════════════════════════════════════════
// SUBIR IMAGEN
// ═══════════════════════════════════════════════════
async function subirImagen(widget, payload) {
  try {
    console.log(`${TAG} 📸 Subiendo imagen categoría:`, payload.catId);
    const result = await uploadImagenCategoria(payload);

    if (result.ok) {
      console.log(`${TAG} ✅ Imagen subida`);
      widget.postMessage({ type: 'categoriaImageUploaded', payload: result });
    } else {
      console.error(`${TAG} ❌ Error:`, result.error);
      widget.postMessage({ type: 'categoriaImageError', message: result.error });
    }
  } catch (error) {
    console.error(`${TAG} ❌ Error subiendo imagen:`, error);
    widget.postMessage({ type: 'categoriaImageError', message: error.message });
  }
}