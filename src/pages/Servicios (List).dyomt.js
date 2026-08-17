import wixLocation from 'wix-location';

$w.onReady(() => {
  $w('#repeaterCategorias').onItemReady(($item, itemData) => {
    $item('#btnReservaYa').onClick(() => {
      // link-servicios-title = "/servicios/tratamientos-faciales"
      // → slug = "tratamientos-faciales"
      const linkPath = itemData['link-servicios-title'] || '';
      const slug = linkPath.split('/').filter(Boolean).pop() || '';

      if (!slug) {
        console.warn('Categoría sin slug:', itemData.title);
        return;
      }

      // Navegar a la página dinámica /reservar/<slug>
      wixLocation.to('/reservar/' + slug);
    });
  });
});