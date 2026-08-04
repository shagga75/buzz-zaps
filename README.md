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

El trigger `reaction_added` (`config/triggers.example.yaml`) zapea al autor de un mensaje cuando alguien
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
  de reusar la suscripción del canal. Opcionalmente se puede acotar a un solo repo con `BUZZ_REPO_COORD`
  (`"30617:<owner-hex>:<repo-d>"`, el valor del tag `a`); sin configurar, escucha cualquier PR mergeado
  en la comunidad.
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

## Fase 2 — cobro automático por tarea completada

`agent_task_completed` (`config/triggers.example.yaml`) cobra `amount_sats` a un usuario cuando un
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
# completar BUZZ_CHANNEL_ID (ver abajo) y LAWALLET_BASE_URL si cambiaste el puerto
pnpm dev
```

### Variables de entorno (`.env`)

Ver `.env.example` para la lista completa y sus defaults. Las que hay que setear a mano:

- `BUZZ_BOT_NSEC` — identidad Nostr del bot (generar con `scripts/generate-key.ts`).
- `BUZZ_CHANNEL_ID` — UUID del canal de prueba en Buzz. Se obtiene creándolo (kind 9007, `nak event -k
  9007 --tag "name=zap-test" --auth --sec <tu-privkey> ws://localhost:3000`) o desde la app de
  escritorio de Buzz (Settings del canal → copiar ID). El relay lo asigna al crear el grupo.
- `LAWALLET_BASE_URL` — por defecto `http://localhost:2288` (puerto de `apps/web` en el compose de
  lawallet-nwc). El usuario destino del `/zap` (`@usuario`) debe existir en esa instancia con una
  Lightning Address activa (crearlo desde la UI de LaWallet o `pnpm seed` en ese repo).

## Test end-to-end manual

1. Con los tres servicios arriba, uní al bot y a un usuario de prueba al canal de Buzz
   (`BUZZ_CHANNEL_ID`).
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
2. Cualquiera reacciona con 🐝 (o el emoji configurado en `config/triggers.example.yaml`) a un mensaje
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
    relay-client.ts          # conectar + auth NIP-42 + suscribir(canal)/suscribir(global)/publicar/fetchEventById
    command-parser.ts        # detectar "/zap @user <monto>", "/link <username>", "/bounty <id> <monto>"
    zap-flow.ts               # runZapFlow compartido — invoice → reply → poll → receipt (devuelve el outcome)
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
  config.ts               # env + config/triggers.example.yaml
config/
  triggers.example.yaml   # triggers activos: manual_zap_command (documental) + reaction_added (en uso)
```

## Próximos pasos (Fase 3, no implementados)

- **Contribuir el evento formal de "task completed" río arriba a `buzz`**: hoy `agent_task_completed`
  detecta un reply de agente como proxy porque `KIND_WORKFLOW_COMPLETED`/`KIND_JOB_RESULT` no se publican
  (ver "Fase 2 — cobro automático"). El fix real es agregar ese publish en `buzz-relay` — cambia el core
  que Fase 1-2 evitó tocar a propósito, así que quedó fuera de alcance por ahora.
- Evaluar si migrar el trigger de reacción a los workflows YAML nativos de Buzz
  (`crates/buzz-workflow`, `on: reaction_added` + acción `call_webhook` hacia `/hooks/{id}`) en vez de
  la extensión del listener propio que se implementó acá — quedó autocontenido a propósito para no
  depender de administrar workflows del lado de Buzz, pero delegarlo reusaría infraestructura que Buzz
  ya tiene battle-tested.
- `/bounty` sin control de acceso: hoy cualquiera en el canal puede prometer sats de la wallet de la
  comunidad. Producción necesita gatear esto a admins/owners del repo — Buzz ya tiene roles (NIP-43,
  `role=admin`), falta conectar esa verificación acá.
- Reintento de bounties fallidos: si el pago timeoutea o falla, el bounty queda `open` pero no hay
  ningún evento que lo vuelva a disparar (el merge solo ocurre una vez). Falta un comando manual de
  reintento o un job periódico.
- Middleware de fee (1-2% por zap) y dashboard de administración por comunidad.
- Wallets por comunidad (spec sección 5.5) en vez de una sola `LAWALLET_BASE_URL` fija.
