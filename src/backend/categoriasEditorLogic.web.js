// =====================================================
// KAMISUITE - Edición Categorías (Tour de Servicios) - Backend
// =====================================================
// VERSION: 1.0.0
// FECHA: 21 de junio de 2026
// ARCHIVO: backend/categoriasEditorLogic.web.js
//
// PROPÓSITO:
//   Editor del CMS HairSalonServices — el PRIMER NIVEL de Tour de
//   Servicios (la página pública de CATEGORÍAS). Cada fila es una
//   categoría de marketing (Coloración, Cortes Mujer, Tratamientos…)
//   con su foto, título, subtítulo y descripción, más el campo
//   `groupCatalog` que la conecta con los `group` de ServiceCatalog.
//
//   Este editor NO crea ni duplica categorías (el alta vive en el CMS /
//   futuro SetupSalon, donde Wix genera bien el slug de la página
//   dinámica). Solo REFINA las existentes: editar textos, imagen,
//   groupCatalog y activar/desactivar.
//
// ⚠️ SLUGS DE PÁGINA DINÁMICA — NUNCA SE ESCRIBEN:
//   Los campos `link-servicios-title` y `link-servicios-all` los genera
//   Wix automáticamente y apuntan a las páginas dinámicas LISTAR/ITEM.
//   Este backend los LEE (para mostrarlos / depurar) pero JAMÁS los
//   incluye en un update. Tocarlos rompería el enrutado de Tour.
//
// CAMPOS CMS (field IDs confirmados por widgetPublicoLogic en producción):
//   title (Text), subtitle (Text), description (Text), image (Image),
//   orden (Number), activo (Boolean), groupCatalog (Text),
//   link-servicios-title (Text/URL — solo lectura),
//   link-servicios-all   (Text/URL — solo lectura)
//
// PATRÓN REUTILIZADO (literal, de serviciosEdicionLogic v1.8.0):
//   - mediaManager.upload (subida de imagen)
//   - wixImageToPublicUrl (URL pública para el preview)
//   - READ-MERGE-UPDATE en cada actualización
//   - Permissions.SiteMember + suppressAuth en queries
//
// FUNCIONES EXPORTADAS:
//   - listarCategorias()                  → categorías para las cards
//   - actualizarCategoria(payload)        → edita textos + groupCatalog
//   - toggleCategoriaActiva({catId, on})  → activo true/false
//   - uploadImagenCategoria(payload)      → sube imagen y la enlaza
// =====================================================

import { Permissions, webMethod } from 'wix-web-module';
import { mediaManager } from 'wix-media-backend';
import wixData from 'wix-data';

const VERSION = '1.0.0';
const TAG = `[CategoriasEditor][${VERSION}]`;

const CMS_CATEGORIAS = 'HairSalonServices';

// =====================================================
// HELPERS
// =====================================================

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Idéntico a serviciosEdicionLogic v1.8.0
function wixImageToPublicUrl(wixUrl) {
  if (!wixUrl || typeof wixUrl !== 'string') return null;
  if (wixUrl.startsWith('wix:image://')) {
    try {
      const match = wixUrl.match(/wix:image:\/\/v1\/([^/]+)/);
      if (match && match[1]) return `https://static.wixstatic.com/media/${match[1]}`;
    } catch (_) {}
    return null;
  }
  return wixUrl; // ya es URL pública
}

// =====================================================
// 1. LISTAR CATEGORÍAS (HairSalonServices)
// =====================================================
export const listarCategorias = webMethod(
  Permissions.SiteMember,
  async () => {
    const t0 = Date.now();
    try {
      const result = await wixData.query(CMS_CATEGORIAS)
        .ascending('orden')
        .limit(200)
        .find({ suppressAuth: true });

      const categorias = (result.items || []).map(it => ({
        _id: it._id,
        title: it.title || '',
        subtitle: it.subtitle || '',
        description: it.description || '',
        image: it.image || '',
        imageUrl: wixImageToPublicUrl(it.image) || '',
        orden: toNum(it.orden),
        activo: it.activo === true,
        groupCatalog: it.groupCatalog || '',
        // Solo lectura — slugs de las páginas dinámicas (Wix los genera).
        linkServiciosTitle: it['link-servicios-title'] || '',
        linkServiciosAll: it['link-servicios-all'] || ''
      }));

      console.log(`${TAG} ✅ listarCategorias: ${categorias.length} categorías. ${((Date.now() - t0) / 1000).toFixed(2)}s`);
      return { success: true, version: VERSION, categorias };

    } catch (error) {
      console.error(`${TAG} ❌ listarCategorias:`, error.message);
      return { success: false, version: VERSION, error: error.message, categorias: [] };
    }
  }
);

// =====================================================
// 2. ACTUALIZAR CATEGORÍA
// READ-MERGE-UPDATE. Solo toca los campos editables.
// NUNCA escribe link-servicios-title ni link-servicios-all.
// =====================================================
export const actualizarCategoria = webMethod(
  Permissions.SiteMember,
  async (payload) => {
    try {
      const {
        _catId,
        title,
        subtitle,
        description,
        groupCatalog,
        orden
      } = payload || {};

      if (!_catId) {
        return { success: false, error: 'Falta _catId' };
      }

      console.log(`${TAG} 💾 Actualizando categoría: ${_catId}`);

      // READ
      const registro = await wixData.get(CMS_CATEGORIAS, _catId, { suppressAuth: true });
      if (!registro) {
        return { success: false, error: 'Categoría no encontrada' };
      }

      // MERGE — solo campos editables. Los slugs NO se tocan.
      if (title !== undefined) registro.title = String(title || '').trim();
      if (subtitle !== undefined) registro.subtitle = String(subtitle || '').trim();
      if (description !== undefined) registro.description = String(description || '');
      if (groupCatalog !== undefined) registro.groupCatalog = String(groupCatalog || '').trim();
      if (orden !== undefined) {
        const n = Number(orden);
        registro.orden = isNaN(n) ? toNum(registro.orden) : n;
      }

      // UPDATE (documento completo ya leído → no se pierde nada)
      const updated = await wixData.update(CMS_CATEGORIAS, registro, { suppressAuth: true });
      console.log(`${TAG} ✅ Categoría actualizada: ${updated.title}`);

      return {
        success: true,
        version: VERSION,
        categoria: {
          _id: updated._id,
          _catId: updated._id,
          title: updated.title || '',
          subtitle: updated.subtitle || '',
          description: updated.description || '',
          groupCatalog: updated.groupCatalog || '',
          orden: toNum(updated.orden),
          activo: updated.activo === true,
          image: updated.image || '',
          imageUrl: wixImageToPublicUrl(updated.image) || ''
        }
      };

    } catch (error) {
      console.error(`${TAG} ❌ actualizarCategoria:`, error.message);
      return { success: false, error: error.message };
    }
  }
);

// =====================================================
// 3. TOGGLE ACTIVO / NO ACTIVO
// Escribe solo `activo`. READ-MERGE-UPDATE preserva el resto.
// =====================================================
export const toggleCategoriaActiva = webMethod(
  Permissions.SiteMember,
  async ({ catId, activo }) => {
    try {
      if (!catId) {
        return { success: false, error: 'Falta catId' };
      }

      const registro = await wixData.get(CMS_CATEGORIAS, catId, { suppressAuth: true });
      if (!registro) {
        return { success: false, error: 'Categoría no encontrada' };
      }

      registro.activo = !!activo;
      await wixData.update(CMS_CATEGORIAS, registro, { suppressAuth: true });

      console.log(`${TAG} ✅ Categoría ${catId} → activo=${!!activo}`);
      return { success: true, version: VERSION, catId, activo: !!activo };

    } catch (error) {
      console.error(`${TAG} ❌ toggleCategoriaActiva:`, error.message);
      return { success: false, error: error.message };
    }
  }
);

// =====================================================
// 4. SUBIR IMAGEN DE CATEGORÍA
// Patrón literal de uploadImagenServicio (serviciosEdicionLogic v1.8.0):
// mediaManager.upload → fileUrl → READ-MERGE-UPDATE de `image`.
// =====================================================
export const uploadImagenCategoria = webMethod(
  Permissions.Anyone,
  async ({ catId, base64Data, fileName, mimeType }) => {
    try {
      console.log(`${TAG} 📸 Subir imagen categoría: ${catId} | ${fileName}`);

      if (!catId || !base64Data || !fileName) {
        return { ok: false, error: 'Faltan parámetros (catId, base64Data, fileName)' };
      }

      const registro = await wixData.get(CMS_CATEGORIAS, catId, { suppressAuth: true });
      if (!registro) {
        return { ok: false, error: 'Categoría no encontrada en HairSalonServices' };
      }

      const buffer = Buffer.from(base64Data, 'base64');
      const uploadResult = await mediaManager.upload(
        '/HairSalonServices',
        buffer,
        fileName,
        {
          mediaOptions: {
            mimeType: mimeType || 'image/jpeg',
            mediaType: 'image'
          },
          metadataOptions: {
            isPrivate: false,
            isVisitorUpload: false
          }
        }
      );

      const fileUrl = uploadResult?.fileUrl || '';
      if (!fileUrl) {
        return { ok: false, error: 'Media Manager no devolvió fileUrl' };
      }

      console.log(`${TAG} ✅ Imagen subida: ${fileUrl}`);

      // READ-MERGE-UPDATE (registro completo ya leído)
      await wixData.update(CMS_CATEGORIAS, {
        ...registro,
        image: fileUrl
      }, { suppressAuth: true });

      console.log(`${TAG} ✅ HairSalonServices.image actualizado`);

      const publicUrl = wixImageToPublicUrl(fileUrl) || '';
      return { ok: true, fileUrl, publicUrl };

    } catch (e) {
      console.error(`${TAG} ❌ uploadImagenCategoria:`, e.message);
      return { ok: false, error: e.message };
    }
  }
);