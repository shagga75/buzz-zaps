# buzz-zaps

Puente de micropagos Lightning (NIP-57) entre el relay Nostr de [Buzz](https://github.com/shagga75/buzz)
y [LaWallet NWC](https://github.com/shagga75/lawallet-nwc). No modifica ninguno de los dos cores — corre
como un tercer servicio independiente que habla los protocolos estándar de ambos (NIP-42/NIP-29 contra
Buzz, LUD-16/LUD-21 contra LaWallet).

Fase 1 (implementada): comando manual `/zap @usuario <monto>` en un canal → invoice → confirmación de
pago → zap receipt (kind 9735) publicado de vuelta en el relay.

Fase 2 (implementada): tres triggers automáticos.
- Reacción: reaccionar con un emoji configurado (🐝 por defecto) a un mensaje zapea a su autor.
- Bounty: `/bounty <pr-id> <monto>` promete un pago que se libera solo cuando ese PR se mergea (NIP-34).
- Cobro por tarea completada: un agente respondiendo (NIP-10) a un mensaje de un humano le cobra
  `amount_sats` a ese humano.

Los tres reusan el mismo flujo de invoice/pago/receipt de Fase 1.

Wallets por comunidad (implementada): un solo proceso de `buzz-zaps` sirve N comunidades de Buzz en
simultáneo, cada una con su propia conexión al relay, su propia instancia de LaWallet y sus propios
triggers — sin estado compartido entre ellas salvo la identidad Nostr del bot (`config/communities.yaml`,
ver "Fase 2 — wallets por comunidad").

Fee middleware (Fase 3, implementada): cada comunidad puede cobrar un fee (`fee_bps`, ej. 200 = 2%) sobre
cada zap que paga a un tercero — un segundo invoice independiente a la wallet propia de `buzz-zaps`, no un
descuento del pago principal (ver "Fase 3 — fee middleware" para el porqué).

Dashboard de administración (Fase 3, implementada): `pnpm admin-report` — reporte de solo lectura por
comunidad (triggers, fee, zaps por estado, bounties, links registrados), corrido local contra las SQLite
y `communities.yaml` — sin puerto HTTP ni modelo de auth nuevo (ver "Fase 3 — dashboard de administración"
para el porqué).

## Por qué está construido así (hallazgos antes de codear)

Antes de escribir código se clonaron y auditaron ambos forks. Resumen:

**buzz** — todo lo que dice el spec está confirmado en código:
- NIP-42: el relay manda `["AUTH", challenge]` no bien conecta el WebSocket; el cliente firma un evento
  kind `22242` y responde `["AUTH", evt]` (replicado en `src/bot/relay-client.ts`, calcado del cliente
  Rust de referencia en `crates/buzz-ws-client`).
- Mensajes de canal = kind `9` (o `40002`); requieren tag `h` con el UUID del canal.
- `POST /events|/query|/count` exigen NIP-98, pero para publicar no hace falta ese bridge HTTP — se
  publica directo por el mismo WebSocket ya autenticado, como cualquier cliente Nostr.

**lawallet-nwc** — el roadmap público ("Payment Listener & Zaps": building) es preciso, con un matiz
importante: **sí hay código real y testeado que publica zap receipts (kind 9735)**, pero solo se activa
en el flujo "proxyAlias" (reenvío hacia otra Lightning Address externa). Para una dirección LaWallet
normal con wallet propia, ese código nunca se ejecuta — el callback ignora el parámetro `nostr` del
zap request por completo. Ver detalle exacto en `src/nostr/zap-receipt.ts`.

**Decisión de diseño resultante**: en vez de depender de (o parchear) el código de zaps de lawallet-nwc,
`buzz-zaps` usa LaWallet solo como riel de pago —

1. Pide el invoice con LUD-16 estándar (`GET /.well-known/lnurlp/{user}` → `.../cb?amount=`) — esto
   **sí funciona hoy** para cualquier dirección LaWallet.
2. Confirma el pago **polleando la URL `verify` (LUD-21)** que el mismo callback devuelve — endpoint
   público, sin autenticación, también confirmado funcional en el código.
3. Construye y firma el zap receipt (kind 9735) **con la propia clave del bot**, actuando como emisor
   del zap en nombre de quien corrió `/zap`.

## Known limitations

- **El zap receipt no es 100% NIP-57-estricto.** Un zap totalmente compliant requiere que el servidor
  LNURL del receptor hashee el zap request (kind 9734) dentro de la descripción del invoice, para que
  cualquier cliente pueda verificar receipt↔invoice↔request. LaWallet solo hace eso en su flujo proxy
  (confirmado leyendo `apps/web/app/api/lud16/[username]/cb/route.ts`), no para una wallet normal. Este
  bot genera un kind:9734 y kind:9735 bien formados y consistentes entre sí, pero un validador estricto
  no va a encontrar coincidencia entre el hash de descripción del bolt11 y el zap request. Documentado
  en el código (`src/nostr/zap-receipt.ts`) para no esconder el gap.
  - **Fix real, si se necesita compliance estricto**: extender `cb/route.ts` (y `route.ts` para el
    metadata) para que el branch `route.kind === 'wallet'` también haga lo que ya hace el branch
    `proxyAlias` — hashear el `nostr=` param recibido en la descripción del invoice. Es contribuir al
    fork de lawallet-nwc, no algo que se pueda resolver solo del lado de `buzz-zaps`.
- **Resolución de usuario**: `/zap @usuario <monto>` asume que `usuario` es tanto el username de Buzz
  (mencionado) como el username de LaWallet (LUD-16). Requiere que el mensaje tenga un tag `p` (mención)
  — si el cliente de Buzz no lo agrega automáticamente al escribir `@usuario`, el comando se ignora
  silenciosamente (se loguea un warning). No hay lookup de identidad cross-sistema en esta fase.
- **`/link` es opt-in y por diseño**: los zaps por reacción (Fase 2) no arrancan hasta que el receptor
  corre `/link` una vez — es fricción real, pero es la misma que confirmamos que LaWallet no resuelve
  por nosotros (no expone lookup público pubkey→username). La alternativa (que `buzz-zaps` tenga una
  credencial admin de LaWallet para resolverlo solo) cambia el modelo de confianza y no se implementó.
- **Custodia del "zap issuer"**: como el bot firma el zap request en nombre del usuario que corrió el
  comando (no hay forma de que el bot posea la nsec de un tercero), el zap queda atribuido a la
  identidad del bot, no a la del que tipeó `/zap`. Aceptable para Fase 1 (comando manual, un canal de
  prueba); para Fase 2 (ej. reacción 🐝 → zap automático) esto es el mismo patrón que usan la mayoría
  de los zap-bots de Nostr hoy.

## Fase 2 — reacción → zap

El trigger `reaction_added` (`config/communities.example.yaml`) zapea al autor de un mensaje cuando alguien
reacciona con el emoji configurado. El problema que resuelve, y cómo:

**Por qué hace falta `/link`**: una reacción (kind 7) solo trae el pubkey Nostr del autor del mensaje
reaccionado, no su username de LaWallet. A diferencia del comando `/zap @usuario`, acá no hay un
`@usuario` explícito para resolver. Se investigó si LaWallet expone un lookup público pubkey→username
antes de diseñar esto — no lo tiene (el único endpoint que lista `pubkey` + `username` juntos,
`GET /api/lightning-addresses`, exige permiso admin `ADDRESSES_READ`). Pedirle a `buzz-zaps` una
credencial de admin de LaWallet para resolver esto automáticamente era una opción, pero implica más
superficie de integración y resuelve identidades sin que el usuario lo pida explícitamente.

En cambio, cada usuario corre una vez:

```
/link tu-username-de-lawallet
```

`buzz-zaps` guarda `pubkey → username` en su propia SQLite (`user_links`, ver `src/db/links.ts`). Es
seguro porque el pubkey es el de quien *firmó* el evento `/link` — nadie puede linkear una identidad
que no es la suya. Sin ese link previo, una reacción a tu mensaje no dispara nada (se loguea y se
ignora en silencio, no se spamea el canal).

Guardas adicionales en `src/bot/reaction-flow.ts`:
- **Auto-zap**: reaccionar a tu propio mensaje no dispara nada.
- **Cache de autores**: cada mensaje de canal que pasa por el listener se cachea en memoria
  (`MessageAuthorCache`, tope 5000 entradas) para resolver el autor sin una consulta extra al relay. Si
  el mensaje es de antes de que `buzz-zaps` arrancara, hace un fallback de una sola consulta por id
  (`fetchEventById`) antes de rendirse.

## Fase 2 — bounty por PR mergeado

```
/bounty <event-id-del-PR-o-issue> <monto-en-sats>
```

Promete un pago que se libera solo, sin intervención manual, cuando ese PR se mergea. "Escrow" acá es
**soft**: no se mueve ni se retiene plata en ningún lado al registrar el bounty — es una promesa guardada
en SQLite (`bounties`, `src/db/bounties.ts`). El pago sale recién al mergear, directo de la wallet ya
conectada de la comunidad, mismo modelo no-custodial que el resto del bot. Una escrow real (fondos
bloqueados por adelantado) habría significado custodiar plata de terceros — justo lo que la Fase 1 evitó
a propósito.

**Cómo se detecta el merge**: NIP-34 representa un PR mergeado como kind:1631 ("Applied/Merged"), con un
tag `["e", "<id-del-PR>", "", "root"]` apuntando al PR (kind:1618, `crates/buzz-core/src/kind.rs` en el
fork de Buzz). Dos cosas no obvias que se confirmaron leyendo el código antes de asumir nada:

- **Este kind no está scopeado por canal.** `requires_h_channel_scope()` en `buzz-relay` no incluye los
  kinds de git (1617–1633) — viven en el namespace del repo/comunidad, no bajo un tag `h`. Por eso hace
  falta una suscripción separada sin filtro `#h` (`subscribeGlobal` en `src/bot/relay-client.ts`), en vez
  de reusar la suscripción del canal. Opcionalmente se puede acotar a un solo repo con `repo_coord` en la
  entrada de esa comunidad en `communities.yaml` (`"30617:<owner-hex>:<repo-d>"`, el valor del tag `a`);
  sin configurar, escucha cualquier PR mergeado que esa comunidad pueda ver.
- **kind:1631 se reusa para "issue resuelto".** El mismo kind sirve para PRs mergeados e issues
  resueltos — la única forma de distinguirlos es mirar el `kind` del evento raíz referenciado. `buzz-zaps`
  lo busca (`fetchEventById`) y descarta silenciosamente cualquier 1631 cuyo root no sea kind:1618.

**Quién cobra**: el autor del PR (el `pubkey` que firmó el kind:1618 original, no quien lo mergeó — esos
pueden ser personas distintas), resuelto vía el mismo `/link` que usa el trigger de reacción. Sin link
previo, el bounty queda pago-pendiente indefinidamente (no hay reintento automático — el evento de merge
solo se emite una vez). Guarda de auto-pago: si quien registró el bounty es la misma persona que
figura como autor del PR, se rechaza el pago.

**Idempotencia**: como el evento de merge no se repite, un `hasSourceEvent()` nuevo en `ZapStore` evita
reprocesar el mismo merge si el relay lo reenvía (ej. tras una reconexión).

**Control de acceso**: solo owners/admins del canal pueden correr `/bounty` — cualquier otro pubkey lo ve
ignorado en silencio (mismo patrón que el resto de los guards del proyecto: se loguea en debug, no se
spamea el canal con un rechazo). Antes de codear se investigó el modelo de roles real de Buzz, porque hay
**dos sistemas distintos**:

- Un rol de **comunidad entera** (`relay_members`, `"owner"`/`"admin"`/`"member"`, consultable vía
  kind:13534 — NIP-43 membership list).
- Un rol de **canal** (`channel_members`, enum `MemberRole`: `Owner`/`Admin`/`Member`/`Guest`/`Bot`,
  consultable vía kind:39001, NIP-29 group admins).

Se eligió el de **canal**, no el de comunidad: es el mismo que Buzz usa para gatear quién puede
administrar el repo git asociado (`crates/buzz-core/src/git_perms.rs`, doc-comment explícito: *"channel
role = repo role"*). Un admin de la comunidad entera podría ni ser miembro de este canal; el rol de canal
es el que realmente controla el repo cuyo PR el bounty está prometiendo pagar.

`fetchChannelAdmins` (`src/bot/relay-client.ts`) pide `{"kinds":[39001],"#d":["<channel_id>"]}` — el
relay ya pre-filtra los tags `p` a solo owner/admin (confirmado leyendo el código de emisión en
`buzz-relay`, no asumido), así que cualquier pubkey en esos tags ya califica, sin re-chequear el rol en
el cliente. **Falla cerrado**: si la consulta al relay hace timeout, se resuelve un set vacío — nadie
pasa el gate, en vez de dejar pasar un pedido que no se pudo verificar.

Live-testeado con un canal real: el pubkey que crea un canal (`kind:9007`) se vuelve owner automático en
Buzz, confirmado en la práctica — `/bounty` desde ese pubkey se registró; desde un pubkey random ajeno al
canal quedó ignorado en silencio (verificado que ni siquiera pisó el registro existente vía el
`ON CONFLICT` de `bounties.register()`).

## Fase 2 — cobro automático por tarea completada

`agent_task_completed` (`config/communities.example.yaml`) cobra `amount_sats` a un usuario cuando un
agente responde a su mensaje en el canal.

**Por qué no escucha un evento "task completed" formal**: el spec original pedía enganchar esto a "un
evento de workflow" de Buzz. Antes de diseñar nada se leyó el código real:

- `crates/buzz-core/src/kind.rs` reserva `kind:43001-43006` (protocolo de "agent job": request, accepted,
  progress, **result**, cancel, error) y `kind:46001-46012` (ciclo de vida de workflows: triggered, step
  completed, **workflow completed**, failed, cancelled, approvals). Son justo los candidatos obvios.
- Pero **nada los publica hoy**. `crates/buzz-relay/src/handlers/command_executor.rs` solo maneja
  `KIND_WORKFLOW_DEF` (definir un workflow) y `KIND_WORKFLOW_TRIGGER` (dispararlo) — ningún handler emite
  `KIND_WORKFLOW_COMPLETED` de vuelta al relay. El protocolo de agent job (43001-43006) ni siquiera tiene
  un handler: solo aparece contado en queries de feed/actividad (`crates/buzz-db/src/feed.rs`).
- Sí existe un evento real de "el agente hizo algo": `kind:44200` (`KIND_AGENT_TURN_METRIC`), publicado en
  cada turno por `TurnCompletionGuard` en `crates/buzz-acp/src/pool.rs`. Pero está cifrado NIP-44 al dueño
  del agente y el relay solo lo devuelve a ese dueño autenticado por NIP-42 (confirmado en la doc del
  kind) — un bridge de terceros como `buzz-zaps` no puede verlo ni leerlo.

Conclusión: hoy no hay ningún evento Nostr público y en vivo que signifique "tarea completada". Lo único
real y observable es que el agente publica su respuesta como un mensaje de canal normal. Por eso el
trigger se redefinió como: **un pubkey con perfil de agente (`kind:10100`, `KIND_AGENT_PROFILE`) responde
en NIP-10 (`e` tag marcado `reply`) al mensaje de un humano** → se cobra al humano. Contribuir el evento
formal río arriba (agregar el publish que falta en `buzz-relay`) queda anotado en "Próximos pasos" — es
un cambio al core de Buzz, fuera del alcance de Fase 1-2.

**"Cobrar" es pedir, no debitar automáticamente**: se investigó si LaWallet expone alguna forma de que un
tercero autorizado retire fondos de la wallet de otro usuario, antes de asumir que "auto-charge" implica
auto-débito. No la tiene — cada ruta de pago bajo `apps/web/app/api/remote-wallets` y
`apps/web/app/api/wallet` está scopeada a la sesión autenticada del propio dueño (`loadOwnedWallet` en
`remote-wallets/[id]/route.ts` devuelve 404, no 403, si la wallet no es del caller). Construir un
auto-débito real habría exigido o (a) que el usuario le entregue a `buzz-zaps` su propia sesión/JWT —
inaceptable, es takeover de cuenta — o (b) un endpoint nuevo en LaWallet para autorizar cobros de
terceros, que es contribuir al fork con un cambio de superficie de confianza grande, no algo para decidir
implícitamente. Se optó por reusar el mismo patrón "pedir invoice y esperar" de cada otro trigger: se
genera un invoice a la dirección de LaWallet **del propio servicio** (`service_username` en el trigger,
no resuelto vía `/link` — el que cobra es `buzz-zaps`, no un usuario), se publica en el canal
mencionando al humano, y el pago sigue siendo un acto manual suyo.

Guardas en `src/bot/task-completion-flow.ts`:
- Solo dispara si el mensaje es una respuesta NIP-10 (`e` tag `reply`) — un agente hablando sin responder
  a nadie no cobra.
- Ignora si el que invocó es el propio agente, el bot, o (nueva consulta `kind:10100`) también tiene
  perfil de agente — evita cobrar cadenas agente-a-agente.
- Cache de agente (`AgentPubkeyCache`, mismo patrón que `MessageAuthorCache`) para no reconsultar
  `kind:10100` en cada mensaje.

## Fase 2 — wallets por comunidad

Hasta acá, todo corría con una sola `LAWALLET_BASE_URL` fija en `.env` — un proceso, una comunidad de
Buzz, una wallet. Este cambio hace que un solo proceso de `buzz-zaps` pueda servir **N comunidades en
simultáneo**, cada una con su propia conexión al relay, su propia instancia de LaWallet, sus propios
triggers y su propia base SQLite.

**Por qué el alcance real de esto no es "elegir la wallet correcta dentro de una comunidad"**: antes de
tocar código se leyó `crates/buzz-core/src/tenant.rs` en el fork de `buzz`. Una "community" en Buzz no es
algo que el cliente elige — se resuelve **del lado del servidor, a partir del host de la conexión**
(`TenantContext::resolved`, con un comentario explícito de que es una barrera de multi-tenencia
deliberada: "a request's community is resolved from the connection host by the server, never supplied or
influenced by the client"). Como antes `buzz-zaps` abría una sola conexión con un solo host, ya estaba
atado a una sola comunidad de por sí — el gap real no era de ruteo de wallet, era que el proceso entero
solo sabía hablar con una comunidad a la vez.

**Cómo quedó armado**: `config/communities.yaml` reemplaza a `config/triggers.example.yaml` — ya no hay
`BUZZ_CHANNEL_ID`/`LAWALLET_BASE_URL`/`TRIGGERS_CONFIG_PATH` en `.env` (ver "Variables de entorno"). Cada
entrada de `communities:` es un `{ name, relay_url, channel_id, lawallet_base_url, triggers, ... }`
independiente. `src/index.ts` arranca todas en paralelo (`Promise.allSettled` — ver "Próximos pasos" /
resiliencia de arranque): cada una abre su propia conexión NIP-42 al
relay, su propio `LaWalletClient`, sus propias `ZapStore`/`LinkStore`/`BountyStore` (SQLite en
`${DB_DIR}/${name}.sqlite3` si no seteás `db_path`), y corre exactamente los mismos handlers que antes —
nada compartido entre comunidades salvo la identidad Nostr del bot (`BUZZ_BOT_NSEC`), que sigue siendo una
sola: nada impide autenticar la misma clave contra relays/hosts distintos.

**Live-test real (no dos wallets de juguete, dos comunidades reales)**:
1. Se insertó una segunda fila en la tabla `communities` de Buzz (`host = '127.0.0.2:3000'`) — mismo
   proceso de relay ya corriendo en `0.0.0.0:3000`, sin reiniciarlo ni levantar un segundo. `127.0.0.2` es
   loopback (no necesita DNS ni `/etc/hosts`: todo `127.0.0.0/8` rutea a `lo` en Linux), así que conectar
   a `ws://127.0.0.2:3000` golpea el mismo puerto con un `Host` distinto.
2. Se creó un canal `open` (kind:9007) autenticando contra `ws://127.0.0.2:3000` — confirmado en la DB que
   quedó scopeado a la nueva comunidad, no a la de siempre.
3. `communities.yaml` de prueba con dos entradas: `buzz-zaps-test` (la de siempre, `lawallet_base_url:
   http://localhost:2288`, real) y una segunda con `relay_url: ws://127.0.0.2:3000` y
   `lawallet_base_url: http://localhost:2299` — un puerto **a propósito** sin nada escuchando.
4. `buzz-zaps` arrancó las dos en paralelo, cada log línea taggeado con `community: "<nombre>"`.
5. Se disparó `/zap @buzzzaptarget 21` en el canal de cada comunidad. Resultado — cada una le pegó a su
   propia URL, sin fugas cruzadas: la comunidad real terminó en el mismo `HTTP 503` conocido de la wallet
   NWC gratuita (ver "Known limitations"); la comunidad de prueba terminó en `ECONNREFUSED
   127.0.0.1:2299` — la prueba de que nunca cayó de vuelta a la wallet real de la otra comunidad.
6. `ls data/` mostró `buzz-zaps-test.sqlite3` y `buzz-zaps-test-b.sqlite3` como archivos separados.

## Fase 3 — fee middleware

`fee_bps`/`fee_service_username` en la entrada de una comunidad (`config/communities.yaml`) le cobra a
esa comunidad un fee sobre cada zap que paga a un tercero — 200 bps = 2%.

**Por qué son dos invoices separados y no un split dentro de uno solo**: antes de codear se investigó si
LaWallet tiene algún primitivo de split-payment que un tercero externo pueda usar vía LUD-16/21 — no lo
tiene. Lo único parecido es su propio modo `PROXY_ALIAS` (`lib/proxy/*` en lawallet-nwc): el operador de
esa instancia LaWallet recibe el pago bruto en su propia wallet NWC y recién ahí paga el neto al destino
con un segundo pago Lightning — un *receive-then-forward* real, pero **custodial**, y solo invocable por
quien administra esa instancia de LaWallet, no por un bridge externo como `buzz-zaps`. Copiar ese patrón
acá habría exigido que `buzz-zaps` tuviera su propia wallet NWC con permiso de **enviar** pagos (hoy solo
pide invoices, nunca paga uno) y retuviera fondos aunque sea brevemente — cambia el modelo de negocio ya
publicado ("no custodiamos fondos"), no es un detalle de implementación.

**Cómo quedó**: `runZapFlow` (el mismo flujo que usan los cuatro triggers) pide, además del invoice
normal, un segundo invoice independiente por `floor(amount_sats * fee_bps / 10000)` sats a
`fee_service_username` (misma dirección propia de `buzz-zaps` que usa `agent_task_completed`), y lo
publica como una segunda respuesta en el canal. Sigue siendo honor-system a propósito, igual que el cobro
por tarea completada: nadie está obligado a pagarlo, y el zap receipt (kind 9735) sigue dependiendo
únicamente de que se pague el invoice principal — el fee nunca bloquea ni retrasa eso.

**Tracking (antes no existía, ahora sí)**: `FeeStore` (`src/db/fees.ts`) registra cada invoice de fee en su
propia tabla (`zap_id`, `service_username`, `amount_sats`, `bolt11`, `verify_url`, `status`), separada de
`zaps` porque su ciclo de vida es independiente. Apenas se pide el invoice, `chargeFeeIfConfigured`
dispara — sin esperarlo (`void`, fire-and-forget) — el mismo `pollUntilSettled` que ya usa el zap
principal, contra el `verify_url` propio del fee. Si settlea, `markPaid`; si vence el timeout,
`markExpired` + un `log.warn` explícito ("fee invoice was not paid before timeout"). Ninguno de los dos
casos toca el resultado del zap principal — ya terminó su propio flujo para cuando esto resuelve. Visible
después vía `pnpm admin-report` (conteo y sats por estado: pagados/pendientes/vencidos) o grepeando los
logs.

Guardas en `chargeFeeIfConfigured` (`src/bot/zap-flow.ts`):
- **No hay fee sobre un fee**: si el trigger ya le está pagando a la wallet de fees (es lo que hace
  `agent_task_completed` con su `service_username`, si coincidiera con `fee_service_username`), no se pide
  un segundo invoice.
- **Montos que redondean a 0** (zaps chicos con un `fee_bps` bajo) no generan un invoice — no vale la pena
  un segundo pago por 0 sats.
- **Si el pedido del invoice de fee falla** (LaWallet caído, username mal configurado), se loguea un
  warning y el flujo principal sigue intacto — un fee roto nunca debe tumbar el zap que el usuario
  realmente pidió.

## Fase 3 — dashboard de administración

```bash
pnpm admin-report                        # todas las comunidades
pnpm admin-report -- --community <name>  # una sola
```

Reporte de solo lectura por comunidad: triggers activos, fee configurada, conteo de zaps por estado, fees
cobrados/pendientes/vencidos (con sats totales, solo si la comunidad tiene fee configurada), bounties
abiertos/pagados (con sats totales), y cantidad de `/link` registrados. Lee directo las SQLite de cada
comunidad y `communities.yaml` — no escribe nada.

**Por qué CLI y no una UI web**: "dashboard" tiene lecturas muy distintas en riesgo — antes de codear se
decidió explícitamente no exponer un puerto HTTP nuevo. `buzz-zaps` hoy no tiene ninguna superficie de
entrada además del bot saliente (WebSocket hacia Buzz, HTTP hacia LaWallet); un servidor HTTP nuevo
implica resolver auth desde cero (¿shared secret? ¿solo localhost?) para un proyecto que hoy corre una
sola comunidad de prueba. Un reporte de solo lectura contra el filesystem local tiene el mismo nivel de
riesgo que ya existe (acceso al server) — cero superficie nueva. Para cambiar algo seguís editando
`communities.yaml` y reiniciando, como antes; esto es visibilidad, no un panel de control.

**Gap conocido**: los conteos de zaps salen de la tabla `zaps`, pero un fallo al *pedir* el invoice
(`invoice_failed`) nunca llega a insertar una fila ahí — `insertPending` solo corre después de que el
pedido tuvo éxito. Ese fallo hoy solo queda en los logs. El reporte lo dice explícitamente en vez de
mostrar un número que parezca completo y no lo sea.

## Reconexión post-arranque

PR #9 (Fase 3) solo cubrió fallar al *conectar*. Si una comunidad ya online pierde la conexión después
(el relay se reinicia, se cae la red), quedaba muda hasta reiniciar todo el proceso — este es el fix.

**Lo que ya venía gratis**: antes de escribir nada se leyó `abstract-relay.js` de `nostr-tools` — ya
implementa reconexión con backoff (capeado a 60s, reintenta para siempre), re-autenticación NIP-42
automática (Buzz reenvía el challenge AUTH en cada conexión nueva, y `relay.onauth` sigue enganchado), y
re-dispara cada subscription que seguía abierta al momento del corte, retomando con `since` en vez de
reprocesar todo el historial. Activarlo es un solo flag: `Relay.connect(url, { enableReconnect: true })`.
Escribir esto de cero hubiera sido reinventar algo que la librería ya da gratis.

**El bug real, encontrado solo en vivo**: `nostr-tools` re-dispara las subscriptions abiertas apenas el
WebSocket abre (`ws.onopen`) — pero eso puede pasar *antes* de que termine el re-auth NIP-42. El relay
cierra esa re-suscripción prematura con `CLOSED "auth-required: not authenticated"`, y una subscription
cerrada así queda **eliminada** del tracking interno de `nostr-tools` — nunca se vuelve a intentar sola,
ni en la próxima reconexión. Sin arreglar esto, una comunidad podía quedar con la conexión "viva"
(`relay.connected === true`) pero sorda para siempre. Esto no se veía leyendo el código ni los tipos —
recién apareció corriendo el escenario real (matar el proceso del relay a mitad de sesión, resucitarlo, y
mirar los logs).

**El fix**: `subscribeToChannel`/`subscribeGlobal` (`relay-client.ts`) ahora aceptan un callback
`onClose` opcional. `src/index.ts` lo usa para re-suscribir manualmente cuando el cierre no es el propio
apagado del proceso (una flag `isShuttingDown`, seteada antes de `relay.close()`, distingue las dos
razones). Delay fijo de 2s antes de reintentar — suficiente para dejar terminar el auth en carrera, sin
backoff exponencial: es una ventana de carrera puntual, no una falla sostenida.

**Visibilidad**: `watchConnectionState` (`relay-client.ts`) poll ea `relay.connected` cada 5s y loguea
`relay connection lost`/`relay connection restored` — `nostr-tools` no expone ningún hook público de
"me reconecté", así que sin esto la reconexión automática sería invisible en los logs.

Live-testeado matando el proceso del relay a mitad de sesión: detectó la caída, quedó vivo sin crashear,
reconectó solo al resucitar el relay, pisó la carrera de auth-required y re-suscribió sola (confirmado con
un `/zap` nuevo después de que todo se asentó — se procesó exactamente una vez, sin duplicados
persistentes).

## Setup local

Asumiendo los tres repos como hermanos (ver spec sección 7):

```bash
# Terminal 1 — Buzz relay
cd buzz
. ./bin/activate-hermit
just setup && just relay        # ws://localhost:3000 (usar `just relay`, no `just dev`, para evitar levantar también la app de escritorio)

# Terminal 2 — LaWallet NWC
cd lawallet-nwc
cp apps/web/.env.example apps/web/.env   # setear JWT_SECRET: openssl rand -base64 32
docker compose up -d                      # apps/web queda en http://localhost:2288

# Terminal 3 — buzz-zaps
cd buzz-zaps
pnpm install
cp .env.example .env
pnpm exec tsx scripts/generate-key.ts     # pegar el BUZZ_BOT_NSEC generado en .env
cp config/communities.example.yaml config/communities.yaml   # o editá el .example directo en dev
# completar channel_id (ver abajo) y lawallet_base_url si cambiaste el puerto
pnpm dev
```

### Variables de entorno (`.env`)

Ver `.env.example` para la lista completa y sus defaults — son todas cosas compartidas por cada
comunidad que este proceso sirve (identidad del bot, polling de LaWallet, dónde vive
`communities.yaml`). Las que hay que setear a mano:

- `BUZZ_BOT_NSEC` — identidad Nostr del bot (generar con `scripts/generate-key.ts`). La misma identidad
  autentica contra el relay de cada comunidad.

### Comunidades (`config/communities.yaml`)

Todo lo que **sí** varía por comunidad vive acá, no en `.env` — ver el porqué en "Fase 2 — wallets por
comunidad". Cada entrada de `communities:` necesita:

- `name` — etiqueta única (se usa para derivar el path de su SQLite si no seteás `db_path`).
- `relay_url` — URL del relay de Buzz de esa comunidad. Distintas comunidades pueden vivir en el mismo
  relay físico bajo hosts distintos, o en relays completamente separados.
- `channel_id` — UUID del canal de prueba en esa comunidad. Se obtiene creándolo (kind 9007, `nak event
  -k 9007 --tag "name=zap-test" --auth --sec <tu-privkey> ws://localhost:3000`) o desde la app de
  escritorio de Buzz (Settings del canal → copiar ID).
- `lawallet_base_url` — instancia de LaWallet de esa comunidad (por defecto local, `http://localhost:2288`,
  puerto de `apps/web` en el compose de lawallet-nwc). El usuario destino del `/zap` (`@usuario`) debe
  existir ahí con una Lightning Address activa (crearlo desde la UI de LaWallet o `pnpm seed` en ese repo).
- `triggers` — igual que antes (`manual_zap_command`, `reaction_added`, `agent_task_completed`).
- `repo_coord`, `db_path` — opcionales, ver comentarios en `config/communities.example.yaml`.

## Test end-to-end manual

`<BUZZ_CHANNEL_ID>` abajo es el `channel_id` que pusiste en `config/communities.yaml` para esa comunidad
(ya no es una variable de entorno).

1. Con los tres servicios arriba, uní al bot y a un usuario de prueba al canal de Buzz
   (`<BUZZ_CHANNEL_ID>`).
2. Desde el cliente de Buzz (desktop o `nak`), escribí un mensaje que mencione a ese usuario con
   `@username` (el cliente debe agregar el tag `p` automáticamente) y contenga `/zap @username 100`.
   Con `nak`:
   ```bash
   nak event -k 9 -c "/zap @username 100" \
     --tag "h=<BUZZ_CHANNEL_ID>" --tag "p=<hex-pubkey-del-usuario>" \
     --auth --sec <tu-privkey> ws://localhost:3000
   ```
3. `buzz-zaps` debería loguear `detected /zap command`, pedirle el invoice a LaWallet, y publicar una
   respuesta en el canal con el `bolt11`.
4. Pagá el invoice contra la instancia local de LaWallet (con cualquier wallet Lightning conectada al
   nodo/proveedor que tengas configurado ahí — fuera del alcance de este repo).
5. `buzz-zaps` detecta el pago vía polling (`LAWALLET_VERIFY_POLL_INTERVAL_MS`), publica el zap receipt
   (kind 9735) y un mensaje de confirmación en el canal.
6. Verificá el receipt consultando el relay: `nak req -k 9735 --tag "e=<id-del-mensaje-original>" ws://localhost:3000`.

Los tests unitarios (`pnpm test`) cubren el parser del comando y la construcción/consistencia de los
eventos kind:9734/9735 — no reemplazan este flujo manual, que requiere las tres piezas vivas.

### Fase 2: reacción → zap

1. El usuario que va a recibir zaps corre `/link su-username` una vez en el canal.
2. Cualquiera reacciona con 🐝 (o el emoji configurado en `config/communities.example.yaml`) a un mensaje
   de ese usuario:
   ```bash
   nak event -k 7 -c "🐝" --tag "h=<BUZZ_CHANNEL_ID>" --tag "e=<id-del-mensaje>" \
     --auth --sec <tu-privkey> ws://localhost:3000
   ```
3. Mismo flujo que el paso 3-6 de arriba, pero disparado por la reacción en vez del comando — el log
   dice `detected reaction trigger` en vez de `detected /zap command`.

### Fase 2: bounty por PR mergeado

1. El autor del PR corre `/link su-username` (si no lo hizo ya).
2. Alguien registra el bounty: `/bounty <event-id-del-PR> 5000` en el canal.
3. Al mergear el PR (evento kind:1631 con `["e", "<event-id-del-PR>", "", "root"]`), `buzz-zaps` lo
   detecta por la suscripción global (no la del canal — ver sección de arriba), resuelve el autor real
   leyendo el PR original, y corre el mismo flujo de invoice/pago/receipt. El log dice
   `detected merged bounty`.
4. Si nadie registró un bounty para ese PR, o el autor no corrió `/link`, no pasa nada — silenciosamente,
   sin publicar nada en el canal.

### Fase 2: cobro por tarea completada

1. Un pubkey con `kind:10100` (perfil de agente) responde a un mensaje de un humano en el canal:
   ```bash
   nak event -k 9 -c "listo, ya lo hice" \
     --tag "h=<BUZZ_CHANNEL_ID>" --tag "e=<id-del-mensaje-del-humano>;;reply" --tag "p=<hex-pubkey-del-humano>" \
     --auth --sec <nsec-del-agente> ws://localhost:3000
   ```
2. Mismo flujo de invoice/pago/receipt que los anteriores, pero el invoice es a `service_username` (la
   wallet del propio `buzz-zaps`, no del humano) — el log dice `detected agent task completion`.
3. Si el pubkey que respondió no tiene `kind:10100`, o el mensaje no es una respuesta NIP-10, o quien
   invocó también es un agente, no pasa nada.

## Estructura

```
src/
  bot/
    relay-client.ts          # conectar (reconexión automática) + auth NIP-42 + suscribir(canal, resuscribe-on-close)/suscribir(global, ídem)/publicar/fetchEventById/fetchChannelAdmins/watchConnectionState
    command-parser.ts        # detectar "/zap @user <monto>", "/link <username>", "/bounty <id> <monto>"
    zap-flow.ts               # runZapFlow compartido — invoice → fee opcional → reply → poll → receipt (devuelve el outcome)
    link-flow.ts               # handler de /link
    reaction-flow.ts            # handler de reacciones (Fase 2), matchea contra triggers.yaml
    bounty-flow.ts               # handler de /bounty + payout al detectar kind:1631 (NIP-34, Fase 2)
    task-completion-flow.ts      # handler de reply-de-agente -> cobro al invocador (Fase 2)
    message-author-cache.ts     # cache eventId -> pubkey para resolver autores sin roundtrip
    agent-cache.ts               # cache pubkey -> es-agente (kind:10100), evita requery por mensaje
  lightning/
    lawallet-client.ts  # LUD-16 (invoice) + LUD-21 (verify/polling) contra LaWallet
  nostr/
    identity.ts          # carga la nsec del bot
    messages.ts           # respuestas de canal (kind 9)
    zap-receipt.ts        # construcción kind:9734 / kind:9735
  db/
    store.ts              # SQLite — auditoría de zaps (pending/paid/expired/failed) + hasSourceEvent (idempotencia)
    links.ts               # SQLite — pubkey -> username de LaWallet (self-registrado con /link)
    bounties.ts             # SQLite — bounties abiertos/pagados por PR (soft escrow, ver /bounty)
  config.ts               # GlobalConfig (.env) + loadCommunities (config/communities.yaml)
  index.ts                 # arranca N comunidades en paralelo — ver "Fase 2 — wallets por comunidad"
config/
  communities.example.yaml   # una entrada por comunidad: relay, canal, wallet LaWallet y triggers
scripts/
  admin-report.ts             # reporte de solo lectura por comunidad, ver "Fase 3 — dashboard de administración"
  generate-key.ts              # genera un BUZZ_BOT_NSEC nuevo
```

## Próximos pasos

- **Contribuir el evento formal de "task completed" río arriba a `buzz`**: hoy `agent_task_completed`
  detecta un reply de agente como proxy porque `KIND_WORKFLOW_COMPLETED`/`KIND_JOB_RESULT` no se publican
  (ver "Fase 2 — cobro automático"). El fix real es agregar ese publish en `buzz-relay` — cambia el core
  que Fase 1-2 evitó tocar a propósito, así que quedó fuera de alcance por ahora.
- Evaluar si migrar el trigger de reacción a los workflows YAML nativos de Buzz
  (`crates/buzz-workflow`, `on: reaction_added` + acción `call_webhook` hacia `/hooks/{id}`) en vez de
  la extensión del listener propio que se implementó acá — quedó autocontenido a propósito para no
  depender de administrar workflows del lado de Buzz, pero delegarlo reusaría infraestructura que Buzz
  ya tiene battle-tested.
- Reintento de bounties fallidos: si el pago timeoutea o falla, el bounty queda `open` pero no hay
  ningún evento que lo vuelva a disparar (el merge solo ocurre una vez). Falta un comando manual de
  reintento o un job periódico.
- `pnpm admin-report` es de solo lectura y local (correr en la misma máquina/acceso al filesystem). Si
  algún día hace falta consultarlo remoto (ej. un dashboard real para un operador que no tiene shell en el
  server), ahí sí hace falta resolver el fork de auth/HTTP que se evitó a propósito acá.
- El fee (Fase 3) sigue siendo honor-system a propósito (nada obliga a pagar el segundo invoice), pero
  desde ahora sí se trackea: se pollea su propio `verify_url` en background y queda registrado
  paid/pending/expired en `FeeStore`, visible vía `pnpm admin-report` y en los logs (`fee invoice was not
  paid before timeout`). Sigue sin bloquear el zap principal — eso fue una decisión explícita, no un gap.
- **Resiliencia de arranque**: `src/index.ts` usa `Promise.allSettled` — si una comunidad falla al
  arrancar (relay caído, host mal configurado), se loguea el error y las demás siguen online (si todas
  fallan, el proceso sale con exit 1). Decisión explícita: sin reintento automático — la comunidad rota
  queda afuera hasta el próximo reinicio manual, mismo modelo que ya usa el resto del proyecto (arreglar
  config + reiniciar). Una comunidad que se cae *después* de arrancar bien sí se reconecta sola —
  ver "Reconexión post-arranque".
