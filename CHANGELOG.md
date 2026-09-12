# Changelog

## 1.0.1

- **Parámetros de entrada.** Las consultas con bind variables (`:P_ID`) ya se
  ejecutan: la extensión los detecta, pide los valores, los declara en el
  `.xdm` y los pasa a `runReport`.
- Los valores se recuerdan entre ejecuciones y se ofrecen prellenados.
- El comando **Editar parámetros de la consulta** los cambia y relanza.
- Al publicar como Data Model, los binds se declaran como parámetros reales del
  modelo, con el último valor usado como valor por defecto.
- La barra del panel muestra los parámetros con los que se ejecutó la consulta.
- Nuevo ajuste `OracleERPBIPublisherRunner.promptParameters`: `always` u `onlyNew`.
 

## 1.0.1

- Cambio de Iconos


## 1.0.0

- Ejecución de SQL contra Oracle Fusion vía CatalogService v2 + ReportService v2.
- Envoltura automática del SQL (`json` / `xml`) para no depender de las columnas.
- Límite de filas configurable, fijo o como parámetro `P_MAX_ROWS` de BI Publisher.
- Publicación de consultas como Data Model, con `updateObject` cuando ya existe.
- Rejilla de resultados con orden, filtro y exportación a CSV/JSON.
- Historial de consultas y gestión de varias conexiones.
- Auto-reparación de firmas SOAP entre releases de BI Publisher.
- Sin dependencias de ejecución.
