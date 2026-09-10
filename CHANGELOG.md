# Changelog

## 1.4.0

- **Parámetros de entrada.** Las consultas con bind variables (`:P_ID`) ya se
  ejecutan: la extensión los detecta, pide los valores, los declara en el
  `.xdm` y los pasa a `runReport`.
- Los valores se recuerdan entre ejecuciones y se ofrecen prellenados.
- El comando **Editar parámetros de la consulta** los cambia y relanza.
- Al publicar como Data Model, los binds se declaran como parámetros reales del
  modelo, con el último valor usado como valor por defecto.
- La barra del panel muestra los parámetros con los que se ejecutó la consulta.
- Nuevo ajuste `OracleERPBIPublisherRunner.promptParameters`: `always` u `onlyNew`.

## 1.3.1

- Añadido `LICENSE.md` (MIT): `vsce package` ya no avisa y no hace falta
  `--skip-license`.
- Scripts `npm run package` y `npm test` en el `package.json`.

## 1.3.0

- La pestaña de resultados de respaldo se abre **debajo** del editor SQL, no a la
  derecha. Ajustable con `OracleERPBIPublisherRunner.editorFallbackPosition`.
- Nuevo comando **Mover resultados abajo** para reubicarla a mano.
- El contenedor del panel usa ahora título e icono propios, distintos de los de
  la barra lateral, por si la colisión impedía que VS Code lo registrase.

## 1.2.0

- **Corregido:** si VS Code no registra el contenedor del panel, los resultados
  ya no se pierden — se abren como pestaña del editor, que no depende de la
  contribución `viewsContainers` del manifiesto.
- La disponibilidad del panel se comprueba una sola vez con `getCommands()`, así
  que no hay intentos fallidos ni retardo en cada consulta.
- Nuevo ajuste `OracleERPBIPublisherRunner.resultsLocation`: `auto`, `panel` o `editor`.
- Si el panel inferior aparece más tarde, la pestaña de respaldo se cierra sola.

## 1.1.1

- **Corregido:** `command 'OracleERPBIPublisherRunner.results.focus' not found` abortaba la consulta.
  Abrir el panel es una comodidad y ya nunca interrumpe la ejecución: `reveal()`
  prueba varias vías, no lanza jamás, y si ninguna funciona la extensión avisa
  con un botón para recargar la ventana.
- Si el panel no llega a abrirse, un aviso indica cuántas filas se obtuvieron y
  ofrece abrirlo.

## 1.1.0

- Los resultados pasan al **panel inferior** (junto a Terminal y Problemas) en vez de abrirse como pestaña del editor.
- **Selector de filas** en la barra del panel: presets, sin límite y valor personalizado, con reejecución automática.
- Indicador del límite en la barra de estado, clicable.
- Botón «Reejecutar» y doble clic sobre una celda para copiarla.
- Columna de número de fila fija al hacer scroll horizontal.

## 1.0.0

- Ejecución de SQL contra Oracle Fusion vía CatalogService v2 + ReportService v2.
- Envoltura automática del SQL (`json` / `xml`) para no depender de las columnas.
- Límite de filas configurable, fijo o como parámetro `P_MAX_ROWS` de BI Publisher.
- Publicación de consultas como Data Model, con `updateObject` cuando ya existe.
- Rejilla de resultados con orden, filtro y exportación a CSV/JSON.
- Historial de consultas y gestión de varias conexiones.
- Auto-reparación de firmas SOAP entre releases de BI Publisher.
- Sin dependencias de ejecución.
