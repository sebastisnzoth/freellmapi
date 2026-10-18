# FreeLLMAPI para UGO Hive — diagnóstico y plan Render Free

**Fecha:** 2026-10-18  
**Estado:** PLAN / NO DESPLEGADO / SIN PRUEBAS RUNTIME.  
**Destino:** `sebastisnzoth/freellmapi`, rama documental; integración futura en UGO PR #515.  
**Restricciones:** ningún servicio pago, ninguna tarjeta, cero modelos facturables, ninguna clave o dato personal en GitHub, ninguna modificación de producción, Supabase ni Render durante esta fase documental.

## 1. Diagnóstico basado en archivos del repositorio

Fuentes inspeccionadas: `docs/en/install/01-install.md`, `docker-compose.yml`, `server/package.json`, `.env.example` y `LICENSE`. Las afirmaciones describen soporte de código/documentación, **no** un ensayo desplegado.

| Punto | Hallazgo | Consecuencia |
|---|---|---|
| Runtime | Node >=20.18 (menor que 25); Docker disponible | Contenedor Render Web Service es candidato; validar build y arquitectura de CPU |
| API | `/v1` OpenAI-compatible; `/api/ping` documentado como healthcheck | Integración backend posible; endpoints sin confirmar en Render |
| Persistencia | SQLite en `/app/server/data`, configurable con `FREEAPI_DB_PATH` | Disco gratis efímero NO sirve como fuente durable de secretos |
| Cifrado | `ENCRYPTION_KEY` requerida en producción; claves de proveedor cifradas | Mantener clave estable en secrets del servicio, nunca en repo |
| Backup | `FREEAPI_DB_BACKUP_URL`, `FREEAPI_DB_BACKUP_TOKEN`, `FREEAPI_DB_BACKUP_KEY`, `FREEAPI_DB_BACKUP_INTERVAL_MS` | **Funcionalidad de respaldo remoto cifrado YA EXISTENTE**: reutilizar, auditar comportamiento HTTP y demostrar recuperación |
| Restauración | Documentación indica restauración al inicio si falta DB | Probar recuperación tras restart y deploy, sin asumir RPO cero |
| Licencia | MIT | Revisar separadamente TOS/licencias de cada proveedor gratuito |
| Alojamiento | Render Free suspende por inactividad; sin disco persistente gratuito | No requiere Mac encendida, pero hay cold start y posibles pérdidas entre backups |

**Inventario Render de solo lectura, observado previamente:** workspace autorizado `Sergio Sebastian's workspace`; cero PostgreSQL y cero Key Value listados; listado de servicios `null` (no equivale a cero servicios). No hay despliegue FreeLLMAPI confirmado.

**Conclusión:** Render Free sirve como candidato de compute; **no** es solución integral mientras no exista un receptor HTTPS de backups cifrados, durable, autenticado, restaurable y gratuito. No desarrollar de cero un migrador SQLite→Postgres sin justificarlo: primero evaluar el mecanismo propio.

## 2. Arquitectura elegida condicionada

```text
Hugo/Super Admin (navegador)
    -> Supabase Edge Function ugo-hive-model-router en UGO TEST (PR #515)
        -> auth server-side Super Admin + cuota global durable + allowlist + zero-cost gate
        -> HTTPS privado con bearer de servicio (nunca credenciales en navegador)
            -> FreeLLMAPI en Render FREE
                 -> proveedores permitidos FREE ONLY, seleccionados explícitamente
                 -> SQLite efímero + backup cifrado periódico
                 -> receptor externo HTTPS durable, auth + cifrado + versionado + retención
        -> OpenRouter FREE ONLY (fallback condicionado a cuota/coste/reglas reales)
    -> auditoría e indicadores de UGO TEST, Judge/Sentinel
```

No confundir FREE con *sin límites*. FreeLLMAPI **no** elimina la cuota contractual de OpenRouter: redistribuye llamadas **entre diferentes proveedores realmente habilitados**. El catálogo de modelos no significa que el usuario tenga API keys o cuota en esos proveedores. Ningún fallback puede pasar a un endpoint cobrable.

### 2.1 Receptor remoto de respaldo: decisión por pruebas, no por suposición

**Opción A recomendada para evaluar:** endpoint HTTPS de mínimo privilegio con almacenamiento de objetos privado y durable dentro de una cuota gratuita **existente**, utilizando Supabase TEST únicamente si su plan, límites, permisos y aislamiento lo permiten y el usuario autoriza la configuración. Implementar un pequeño endpoint autenticado para subir/descargar objetos cifrados; revisar *código exacto* del backup de FreeLLMAPI para confirmar método HTTP, cuerpos y headers admitidos antes de construirlo. No poner `service_role` en Render ni entregar permiso de lectura general a ese endpoint. Dar token con alcance exclusivo `ugo-hive-backup`. Si Supabase TEST compartido es un riesgo o su cuota no alcanza, marcar BLOQUEADO y evaluar otro backend gratis sin tarjeta.

**Opción B temporal de alcance restringido:** configuración declarativa de arranque `FREEAPI_CONFIG_JSON` con credenciales exclusivamente en secretos de Render; validar si permite recuperar configuraciones necesarias, tokens unificados, usuarios y cuotas. NO asumir que reemplaza la persistencia ni que una base efímera es segura para el piloto; es un plan de contingencia para pruebas aisladas y desechables sin datos sensibles.

**Reglas del receptor:** TLS; bearer distinto de claves de proveedores; autenticación antes de lecturas/escrituras; objetos cifrados con integridad autenticada; separación TEST; versionado y retención acotados; hash/checksum; anti-replay si se necesita; restauración al arrancar; políticas de acceso mínimas; impedir acceso público; observabilidad sin secretos. Auditar el riesgo de *rollback de cuotas* si el backup restaura counters antiguos; **las cuotas globales de Hive viven en backend transaccional independiente de SQLite**.

**RPO/RTO:** medir pérdida máxima observable de cambios entre intervalos de backup y tiempo de restablecimiento. Si un cambio crítico puede perderse, no permitir claves reales persistidas hasta tener copia inmediata/verificada o reconstrucción controlada. Restaurar versión antigua no debe reactivar claves revocadas ni autorizaciones anuladas.

## 3. Checklist de implementación autónoma por gates

Cada casilla comienza pendiente. Marcar VERIFIED solamente con prueba, fuente, SHA/ejecución, fecha y resultado observado. El agente sigue unidades independientes autorizadas sin pedir permiso repetido. La autorización actual **solo** permite auditoría/documentación; requerir consentimiento para nuevos recursos, cambios de secreto, deploys, llamadas a proveedores, escritura en TEST y fusión.

### R0 — Reconstrucción exacta y requisitos (read-only)
- [ ] R0.1 Registrar SHA de `freellmapi/main`, `ugo-admin-panel/main` y HEAD de PR #515; inventariar PRs y cambios concurrentes.
- [ ] R0.2 Auditar implementación exacta del backup: subida, descarga, manejo de errores, concurrencia, timeouts y protección frente a backups parciales.
- [ ] R0.3 Revisar Dockerfile, entrypoint, puertos, variable `PORT` impuesta por Render, salud y forma de build; medir necesidades mínimas de RAM/CPU.
- [ ] R0.4 Revisar TOS de FreeLLMAPI, privacidad y condiciones de cada proveedor gratuito habilitable para uso personal de TEST.
- [ ] R0.5 Confirmar recursos reales del workspace Render por consulta fiable (listado ambiguo no equivale a ausencia).
- **Gate R0:** informe técnico exact-SHA y decisión respaldada del almacenamiento, sin escritos en cuentas.

### R1 — Persistencia segura en FREE, sin desplegar todavía
- [ ] R1.1 Evaluar disponibilidad de bucket privado gratuito existente (p. ej. Storage de Supabase TEST), tamaño/egress, caducidad, límites y si exige tarjeta. Registrar fuente actual.
- [ ] R1.2 Especificar endpoint receptor con métodos y tokens **según lectura real del código backup**; diseñar almacenamiento versionado y restauración.
- [ ] R1.3 Definir secretos separados `ENCRYPTION_KEY`, `FREEAPI_DB_BACKUP_KEY`, `FREEAPI_DB_BACKUP_TOKEN`; configurar solo tras autorización, nunca subir valores.
- [ ] R1.4 Probar localmente y en ambiente efímero autorizado respaldo/restauración, concurrencia, backup truncado, token erróneo, rotación de clave y revocación.
- [ ] R1.5 Requerir observación de persistencia tras pérdida de disco y validación de checksum, con medición RPO/RTO; no usar credenciales reales para ensayos destructivos.
- **Gate R1:** respaldo íntegro y restauración funcional en almacenamiento durable, costos/cuotas validados. Si no, BLOQUEADO: NO DEPLOY.

### R2 — Despliegue TEST en Render (requiere autorización independiente)
- [ ] R2.1 Preparar servicio `Web Service` Docker desde branch/commit fijo, **plan Free**, región disponible, sin disco pago, sin autoscaling ni addons pagos.
- [ ] R2.2 Deshabilitar auto-deploy no verificado y confirmar explícitamente condiciones de facturación del workspace antes de crear.
- [ ] R2.3 Establecer secrets en Render, URL de backup y token de cliente; proteger dashboard, setup inicial y `/v1` con control adicional de acceso.
- [ ] R2.4 Configurar healthcheck autenticado o mínimo de `/api/ping`, timeout de cold start y recuperación; no basar disponibilidad en pings artificiales cada 10 minutos.
- [ ] R2.5 Realizar reinicio/redeploy y verificar restauración con evidencia real; medir latencia y logs sin secretos.
- **Gate R2:** servicio FREE observado con reinicio comprobado, integridad y autenticación; 0 cargos.

### R3 — Zero-cost Router de Hive (UGO PR #515, solo rama TEST autorizada)
- [ ] R3.1 Preservar verificaciones server-side de Super Admin y `UGO_TEST`; no habilitar `Empresa Autónoma ON`.
- [ ] R3.2 Sustituir contador `Map` por cuota atómica/durable por usuario, misión, proveedor y ventana; reserva y fencing ante concurrencia.
- [ ] R3.3 Lista cerrada de proveedores/modelos y endpoints, precios verificables por dimensión, cero costo o REJECT; deshabilitar fallback automático desconocido, modelos premium y top-up.
- [ ] R3.4 Conectar a FreeLLMAPI con token sólo backend y fallback OpenRouter FREE independiente; límites tokens/RPM/RPD, backoff, circuit breaker.
- [ ] R3.5 Pruebas de autorización, precios desconocidos, 429, concurrencia, inyección, fuga, facturación, fallo de backup y revocación de token.
- [ ] R3.6 Mantener `HIVE_INFERENCE_NOT_ENABLED` hasta pasar gates R0–R3 y autorización de llamada real.
- **Gate R3:** política deny-by-default y cuota verificada; sin pagos posibles y sin acceso de navegador a secretos.

### R4 — Primera misión real sin datos ficticios
- [ ] R4.1 Llamada mínima con texto público real del repo, sin secretos/PII, proveedor FREE permitido, cuenta/uso cotejados y aprobación.
- [ ] R4.2 Registrar proveedor/modelo retornado, request correlation, respuesta, tokens, tarifa validada y consumo facturado comprobado (no estimado).
- [ ] R4.3 Ejecución de tarea real en rama aislada: patch acotado, pruebas CI same-SHA, PR y evidencias persistidas.
- [ ] R4.4 Judge/Sentinel independientes verifican resultado. No autofusionar, no tocar producción, no declarar VERIFIED por mera conectividad.
- **Gate R4:** flujo end-to-end verificable en TEST, costo externo cero comprobado.

### R5 — Operación y escalado gradual
- [ ] R5.1 Recuperación tras suspensión de Render, caída de backup, uso concurrente y reinicios sin duplicar efectos.
- [ ] R5.2 Una worker al principio; máximo tres solo si scheduler/capacidades/locks/quotas permiten realmente.
- [ ] R5.3 Monitoreo de consumo de Render, cuota del almacén externo, llamadas gratuitas y errores, con suspensión preventiva antes de límites.
- [ ] R5.4 Checklist para futura evaluación comercial separada; términos gratuitos para experimentación no implican autorización comercial.
- **Gate R5:** pruebas repetidas y evidencia de estabilidad; activar producción solo tras nuevo permiso y gate propio READY.

## 4. Protocolo de operación sin interrumpir innecesariamente

En cada sesión autorizada: leer estado real y checkpoint → elegir primer ítem independiente desbloqueado → ejecutar → obtener evidencia → probar y repetir corrección dentro de límite seguro → documentar estado → continuar. Si un ítem exige recurso, secreto, modificación remota o gasto no autorizado, marcar `BLOCKED_HUMAN` y avanzar con otros ítems de solo lectura, sin insistir ni hacer sustituciones pagas.

Solo pedir al fundador intervención por: autorización para crear servicio/bucket/backend, insertar claves, habilitar prueba remota, modificar Supabase, fusionar/desplegar o excepciones de seguridad/privacidad. Agrupar una solicitud acotada por lote con recurso, riesgo, gasto máximo US$ 0 y rollback. Una conversación ChatGPT no ejecuta sola trabajos futuros sin runner/schedule.

### Checkpoint a conservar cuando se autorice implementar

```yaml
plan: ugo-render-free-v1
phase: R0
task: R0.1
status: PENDING
freellmapi_source_sha: null
ugo_pr_515_head_sha: null
render_service_id: null
backup_store: UNDECIDED
backup_restore_evidence: []
cost_billed_usd: UNVERIFIED
test_run: null
judge: NOT_RUN
sentinel: NOT_RUN
next: R0.2
```

## 5. Checklist de NO-GO explícito

- [ ] Si Render o almacenamiento obligan tarjeta/pago, NO-GO.
- [ ] Si no se puede demostrar restauración cifrada durable, NO-GO.
- [ ] Si el endpoint remoto permite acceso anónimo o los secretos aparecen en logs/frontend, NO-GO.
- [ ] Si no hay garantía verificable de costo cero en modelo y cuenta, NO-GO.
- [ ] Si PR #515 sigue con `HIVE_INFERENCE_NOT_ENABLED`, no presentar inferencia como operativa.
- [ ] Si la misión no tiene Judge/Sentinel y SHA real, NO marcar VERIFIED.
- [ ] Si la licencia/TOS no admite el uso específico, bloquear ese proveedor.

## 6. Referencias primarias

- FreeLLMAPI instalación: `docs/en/install/01-install.md`.
- Variables de entorno: `.env.example`.
- Docker: `Dockerfile`, `docker-compose.yml`, `docker-entrypoint.sh`.
- Paquetes: `server/package.json`; licencia: `LICENSE`.
- UGO PR #515: https://github.com/sebastisnzoth/ugo-admin-panel/pull/515
- Documento de Hive: https://github.com/sebastisnzoth/ugo-admin-panel/blob/main/docs/UGO_HIVE_MASTER_DISENO_2026-10-18.md
- Render Free: https://render.com/docs/free

**Resultado de esta entrega:** diagnóstico y plan de implementación guardados como propuesta de GitHub. Ningún servidor, bucket, credencial ni modelo se ha configurado; pruebas runtime pendientes.


## 7. Checkpoint HU0/HU1 — auditoría de solo lectura, 18/10/2026

**Fuentes conectadas comprobadas:**
- UGO PR #515: `OPEN / DRAFT`, HEAD `b2ed42a99891d87806cd912e3ea72047b88a81ee`, base SHA `79311730801fad2b717c36ee552421ed5302272b`.
- FreeLLMAPI PR #1: `OPEN / DRAFT`, HEAD `6e915b085e7045423f56930eb6e7c3b2c9f47907`, base SHA `47c3a451e88242a97d274777a29a4dbf289e3e17`.
- Supabase UGO Arena TEST `tmossnqfwfwjrtzwcbmm`: `ACTIVE_HEALTHY`; esto no confirma cuota Storage disponible ni autoriza cambios.
- Render: listado de servicios devolvió `null` (inconcluso); consultas previas no encontraron PostgreSQL ni Key Value. No se comprobó todavía la visibilidad del repositorio dentro de la UI Render.
- FreeLLMAPI `docker/README.md`, SHA de blob `b74116664625dc6648c276caafcdf8820c520aae`: `FREEAPI_DB_BACKUP_URL` utiliza `GET` al iniciar para restaurar y `PUT` periódico para copiar snapshots cifrados, con token bearer opcional. El contrato HTTP de detalle y errores requiere inspección del código fuente.

**Checklist de verificación:**
- [x] Lectura de PR #515 y PR #1 con metadatos y SHA registrados (**AUDITED, no VERIFIED runtime**).
- [x] Lectura del estado del proyecto Supabase TEST.
- [x] Identificación documental de métodos `GET`/`PUT` del respaldo cifrado.
- [ ] Inspeccionar código específico de backup/restore, Dockerfile/entrypoint y sus errores.
- [ ] Verificar en Render el acceso efectivo al fork y restricciones actuales del plan Free.
- [ ] Confirmar disponibilidad, aislamiento, cuotas y autenticación del almacén externo gratis.
- [ ] Demostrar backup/restauración ante reinicio, corrupción, token inválido, concurrentes y pérdida de disco con evidencia.
- [ ] HU2–HU5: no ejecutados; sin despliegue, sin llamadas reales de IA, sin cambios a producción.

**Próxima unidad desbloqueada:** inspeccionar el código fuente del respaldo y especificar receptor privado `GET`/`PUT` de objetos cifrados (TLS, autenticación, atomicidad, integridad, versionado y retención). Las cuotas globales de Hive deben permanecer transaccionales fuera del SQLite efímero. Una copia periódica no implica RPO cero y una restauración obsoleta no debe reactivar credenciales revocadas.

**Estado:** HU0/HU1 = IN_PROGRESS (auditoría documental parcial); persistencia = UNVERIFIED / BLOCKED_EXTERNAL hasta comprobar receptor y restauración real.
