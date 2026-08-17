import wixData from 'wix-data';

const GRUPOS_MUJER = [
  'TRATAMIENTO_FACIALES',
  'PRESOTERAPIA',
  'NOVIAS_&_RECOGIDOS',
  'COMUNIONES_&_EVENTOS',
  'DEPILACION_FEMENINA',
  'MANICURA_&_PEDICURA',
  'SPA',
  'PEINADOS',
  'COLORACION',
  'CORTESMUJER',
  'NIÑAS'
];

$w.onReady(function () {
  prepararBuscador();

  $w('#dataset1').onReady(() => {
    aplicarFiltro();
  });

  $w('#buscador').onChange(() => {
    aplicarFiltro();
  });
});

function prepararBuscador() {
  $w('#buscador').options = [
    { label: 'Todos', value: 'TODOS' },
    { label: 'TRATAMIENTO_FACIALES', value: 'TRATAMIENTO_FACIALES' },
    { label: 'PRESOTERAPIA', value: 'PRESOTERAPIA' },
    { label: 'NOVIAS_&_RECOGIDOS', value: 'NOVIAS_&_RECOGIDOS' },
    { label: 'COMUNIONES_&_EVENTOS', value: 'COMUNIONES_&_EVENTOS' },
    { label: 'DEPILACION_FEMENINA', value: 'DEPILACION_FEMENINA' },
    { label: 'MANICURA_&_PEDICURA', value: 'MANICURA_&_PEDICURA' },
    { label: 'SPA', value: 'SPA' },
    { label: 'PEINADOS', value: 'PEINADOS' },
    { label: 'COLORACION', value: 'COLORACION' },
    { label: 'CORTESMUJER', value: 'CORTESMUJER' },
    { label: 'NIÑAS', value: 'NIÑAS' }
  ];

  $w('#buscador').value = 'TODOS';
}

function aplicarFiltro() {
  const valorBuscador = $w('#buscador').value;

  const filtroVista = wixData.filter().eq('vistaEnTour', true);

  if (valorBuscador && valorBuscador !== 'TODOS') {
    $w('#dataset2').setFilter(
      filtroVista.and(
        wixData.filter().eq('group', valorBuscador)
      )
    );
    return;
  }

  const filtroGrupos = wixData.filter()
    .eq('group', 'TRATAMIENTO_FACIALES')
    .or(wixData.filter().eq('group', 'PRESOTERAPIA'))
    .or(wixData.filter().eq('group', 'NOVIAS_&_RECOGIDOS'))
    .or(wixData.filter().eq('group', 'COMUNIONES_&_EVENTOS'))
    .or(wixData.filter().eq('group', 'DEPILACION_FEMENINA'))
    .or(wixData.filter().eq('group', 'MANICURA_&_PEDICURA'))
    .or(wixData.filter().eq('group', 'SPA'))
    .or(wixData.filter().eq('group', 'PEINADOS'))
    .or(wixData.filter().eq('group', 'COLORACION'))
    .or(wixData.filter().eq('group', 'CORTESMUJER'))
    .or(wixData.filter().eq('group', 'NIÑAS'));

  $w('#dataset2').setFilter(
    filtroVista.and(filtroGrupos)
  );
}