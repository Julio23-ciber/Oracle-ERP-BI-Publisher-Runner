# Oracle Fusion SQL Runner

Ejecuta SQL contra Oracle Fusion y publica Data Models de BI Publisher, desde VS Code.

Usa **exclusivamente los web services estándar de Oracle** — `CatalogService v2` y `ReportService v2`. Sin demonios locales, sin componentes de terceros, sin licencias, y sin una sola dependencia en `node_modules`.

## Requisitos

- VS Code 1.80 o superior
- Un pod de Oracle Fusion accesible por HTTPS
- Un usuario con el rol **BI Author** o **BI Administrator**
- Oracle 19c o superior para el modo `json` (el modo `xml` funciona en cualquier versión)

## Puesta en marcha

### 1. Crear la conexión

`Fusion SQL: Añadir conexión` desde la paleta de comandos, o el botón `+` del panel lateral. Pide pod, usuario y contraseña.

La contraseña va al **llavero del sistema operativo** vía SecretStorage. Nunca a `settings.json` ni al workspace, que acaban en git.

### 2. Preparar el catálogo

Clic derecho sobre la conexión → **Crear objetos de trabajo en el catálogo**. Crea la carpeta `/Custom/OracleERPBIPublisherRunner` y el data model `FSR_WORK.xdm`.

### 3. Crear el reporte, una sola vez

Este paso es manual y no se puede evitar: **un `.xdm` no se ejecuta por sí solo**, `runReport` necesita un `.xdo` que lo referencie.

En la UI de BI Publisher (`https://tu-pod/xmlpserver`):

1. **New → Report**
2. Data model: `/Custom/OracleERPBIPublisherRunner/FSR_WORK.xdm`
3. Salta el asistente de layout — no hace falta plantilla, se pide formato XML
4. Guardar como `FSR_WORK` en `/Custom/OracleERPBIPublisherRunner`

Se hace una vez y no se vuelve a tocar. El reporte solo apunta al data model, y como `updateObject` preserva el GUID, la referencia nunca se rompe.

### 4. Ejecutar

Abre un archivo `.sql` y pulsa **Ctrl+Enter** (**Cmd+Enter** en Mac). Sin selección ejecuta la sentencia bajo el cursor; con selección, lo seleccionado.

Los resultados salen en el **panel inferior**, junto a Terminal y Problemas. Se puede maximizar con el gesto habitual del panel, o arrastrar a otra zona si prefieres tenerlo al lado.

Si tu instalación de VS Code no registra el contenedor del panel, los resultados se abren automáticamente como **pestaña del editor, debajo del SQL**. Dos ajustes lo gobiernan:

- `OracleERPBIPublisherRunner.resultsLocation` — `auto`, `panel` o `editor`.
- `OracleERPBIPublisherRunner.editorFallbackPosition` — `below` (por defecto) o `beside`.

Y el comando **Mover resultados abajo** la reubica a mano en cualquier momento.

## Parámetros de entrada

Las consultas con bind variables funcionan tal cual:

```sql
SELECT *
FROM PER_ALL_PEOPLE_F PAPF
WHERE 1 = 1
  AND PAPF.PERSON_ID = :P_ID
```

Al ejecutar, la extensión detecta `:P_ID` y pide su valor, prellenado con el
último que usaste. Ese valor se declara en el `<parameters>` del data model y se
envía en la llamada a `runReport`, así que Oracle lo recibe como bind de verdad
— no por sustitución de texto, que sería una inyección SQL esperando a ocurrir.

La detección ignora lo que solo lo parece: `'texto :FALSO'`, `-- :FALSO`,
`/* :FALSO */`, `"col :FALSO"`, el cast `x::text` y la asignación `v := 1`.

Para cambiar los valores sin tocar el SQL: **Editar parámetros de la consulta**,
o el icono correspondiente en la barra del panel de resultados. Con
`OracleERPBIPublisherRunner.promptParameters` en `onlyNew` solo se pregunta la primera vez.

Un parámetro vacío se envía como NULL.

**Al publicar como Data Model**, los binds se declaran como parámetros reales del
modelo con el último valor como valor por defecto, así que el reporte queda
parametrizado y usable desde la propia UI de BI Publisher.

## Límite de filas

Hay tres formas de cambiarlo, y las tres escriben el mismo ajuste:

- **El selector del panel de resultados** — presets de 10 a 5000, «Sin límite» y «Otro…». Al cambiarlo, la consulta se relanza sola.
- **La barra de estado** — el indicador `123` junto al nombre de la conexión abre el mismo selector.
- **`Fusion SQL: Cambiar límite de filas`** en la paleta de comandos.

Equivale al `--max-rows` de la línea de comandos: se traduce en un `WHERE ROWNUM <= N` aplicado **dentro** de la agregación, antes de envolver la consulta.

Cuando una consulta devuelve exactamente el número de filas del límite, la barra del panel lo avisa en amarillo: puede haber más resultados esperando.

## Qué ocurre en cada ejecución

```
SQL del editor
   └─> límite de filas        SELECT * FROM (...) WHERE ROWNUM <= 100
       └─> envoltura          JSON_ARRAYAGG(JSON_OBJECT(*)) AS RESULT
           └─> _datamodel.xdm
               └─> updateObject   (CatalogService)
                   └─> runReport  (ReportService, formato xml)
                       └─> <DATA_DS><G_1><RESULT>[…]</RESULT></G_1></DATA_DS>
                           └─> rejilla de resultados
```

### Por qué se envuelve el SQL

El Data Engine de BI Publisher **solo emite los elementos declarados** en el bloque `<output>` del data model. Con un `SELECT *` no sabes las columnas de antemano, así que las filas saldrían vacías — cinco `<G_1></G_1>` sin nada dentro.

Envolviendo la consulta para que devuelva una sola columna `RESULT` con todo el conjunto de resultados serializado, el problema desaparece: da igual la forma del `SELECT` del usuario.

| `wrapMode` | Mecanismo | Requisito |
|---|---|---|
| `json` (defecto) | `JSON_ARRAYAGG(JSON_OBJECT(*))` | Oracle 19c+ |
| `xml` | `DBMS_XMLGEN.GETXML` | cualquier versión |
| `none` | sin envoltura | declarar las columnas a mano |

### Por qué `ROWNUM` y no `FETCH FIRST`

`ROWNUM` en un subselect funciona en cualquier versión de Oracle y compone con cualquier consulta interior, incluso si ya trae su propio `ORDER BY` o su propia cláusula de limitación. El `ORDER BY` del usuario queda en el subselect interior, así que se respeta el orden y luego se cortan las N primeras.

### Por qué `updateObject` y no `uploadObject`

|  | `uploadObject` | `updateObject` |
|---|---|---|
| Ruta | carpeta padre + nombre + tipo | ruta completa con extensión |
| Si no existe | lo crea | falla |
| Permisos y GUID | los recrea | **los preserva** |

Al preservar el GUID, el reporte `FSR_WORK.xdo` nunca pierde la referencia al data model, por muchas veces que se reescriba el SQL.

Ojo: las dos operaciones **no usan los mismos nombres de parámetro**.

```
uploadObject : reportObjectAbsolutePathURL, objectName, objectType, objectZippedData, userID, password
updateObject : objectAbsolutePath,          objectData,                               userID, password
```

## Comandos

| Comando | Atajo |
|---|---|
| Ejecutar SQL | `Ctrl+Enter` |
| Mostrar panel de resultados | |
| Mover resultados abajo | |
| Editar parámetros de la consulta | |
| Publicar como Data Model | |
| Nueva hoja SQL | |
| Añadir / editar / eliminar conexión | |
| Probar conexión | |
| Crear objetos de trabajo en el catálogo | |
| Cambiar límite de filas | |
| Inspeccionar firmas del CatalogService (WSDL) | |

## Ajustes

| Ajuste | Defecto | Para qué |
|---|---|---|
| `OracleERPBIPublisherRunner.rowLimit` | `100` | Máximo de filas. `0` desactiva el límite |
| `OracleERPBIPublisherRunner.workFolder` | `/Custom/OracleERPBIPublisherRunner` | Carpeta de los objetos de trabajo |
| `OracleERPBIPublisherRunner.dataSource` | `ApplicationDB_FSCM` | `FSCM`, `HCM` o `CRM` |
| `OracleERPBIPublisherRunner.wrapMode` | `json` | Cómo se envuelve el SQL |
| `OracleERPBIPublisherRunner.promptParameters` | `always` | `always` u `onlyNew` |
| `OracleERPBIPublisherRunner.resultsLocation` | `auto` | `auto`, `panel` o `editor` |
| `OracleERPBIPublisherRunner.editorFallbackPosition` | `below` | `below` o `beside` |
| `OracleERPBIPublisherRunner.requestTimeout` | `180` | Timeout SOAP en segundos |

El límite por defecto de 100 filas es deliberado: un runner sin tope es un incidente esperando a ocurrir, y el primer `SELECT *` contra una tabla Fusion grande tumba la sesión de BI Publisher.

## Resolución de problemas

**`RESULT no es JSON valido`** — tu base no soporta `JSON_OBJECT(*)`. Cambia `wrapMode` a `xml`.

**`ORA-00942: table or view does not exist`** — el data source no cuadra con el esquema. `PER_ALL_PEOPLE_F` es HCM; las tablas `AP_*` y `GL_*` son FSCM. Cambia el data source de la conexión.

**`Unmarshalling Error`** — la firma SOAP de tu pod difiere de la esperada. El cliente reintenta automáticamente una vez, emparejando los parámetros por rol. Si persiste, ejecuta **Inspeccionar firmas del CatalogService** y ajusta `src/bipClient.js`.

**El reporte no existe** — falta el paso 3. `runReport` no puede ejecutar un `.xdm` directamente.

**`command 'OracleERPBIPublisherRunner.results.focus' not found`** — VS Code no ha registrado el contenedor del panel. Suele arreglarse con **Developer: Reload Window**; si persiste, desde 1.2.0 los resultados se muestran igualmente en una pestaña del editor. La consulta nunca se ve afectada.

**Filas vacías** — el `<output>` del data model no coincide con las columnas del SQL. Ocurre con `wrapMode: none`; usa `json` o `xml`.

## Desarrollo

```bash
node test/integration.js   # ciclo completo contra un pod simulado
node test/binds.js         # detección y declaración de bind variables
node test/wiring.js        # coherencia entre package.json y extension.js
node test/resultview.js    # vista de resultados: cola, mensajes y CSP
npm run package            # genera el .vsix
```

Sin dependencias de ejecución. `vsce` solo hace falta para empaquetar.

### Estructura

```
extension.js          comandos y orquestación
src/bipClient.js      SOAP: CatalogService y ReportService
src/dataModel.js      generación del .xdm, envoltura y límite de filas
src/zip.js            escritor/lector ZIP sobre zlib
src/connections.js    conexiones + SecretStorage
src/providers.js      árboles de conexiones e historial
src/resultView.js     rejilla de resultados (panel inferior)
```

Las plantillas de `dataModel.js` reproducen byte a byte lo que emite Oracle Analytics Publisher, incluidas sus rarezas: el namespace `xsd` con **cuatro "w"** (`http://wwww.w3.org/2001/XMLSchema`) y el orden exacto de los bloques vacíos. Está verificado contra paquetes descargados de un pod real con `downloadObject`. No "arregles" la errata del namespace: es lo que el motor emite y espera.

## Licencia

MIT — ver el archivo `LICENSE.md`. Antes de distribuirla, sustituye
`TITULAR_DE_LOS_DERECHOS` por tu nombre o el de tu organización.

Implementación independiente sobre APIs públicas y documentadas de Oracle.
