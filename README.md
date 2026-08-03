# buzz-zaps

Puente de micropagos Lightning (NIP-57) entre el relay Nostr de [Buzz](https://github.com/shagga75/buzz)
y [LaWallet NWC](https://github.com/shagga75/lawallet-nwc). No modifica ninguno de los dos cores — corre
como un tercer servicio independiente que habla los protocolos estándar de ambos (NIP-42/NIP-29 contra
Buzz, LUD-16/LUD-21 contra LaWallet).

Fase 1 (implementada): comando manual `/zap @usuario <monto>` en un canal → invoice → confirmación de
pago → zap receipt (kind 9735) publicado de vuelta en el relay.

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
- **Custodia del "zap issuer"**: como el bot firma el zap request en nombre del usuario que corrió el
  comando (no hay forma de que el bot posea la nsec de un tercero), el zap queda atribuido a la
  identidad del bot, no a la del que tipeó `/zap`. Aceptable para Fase 1 (comando manual, un canal de
  prueba); para Fase 2 (ej. reacción 🐝 → zap automático) esto es el mismo patrón que usan la mayoría
  de los zap-bots de Nostr hoy.

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

## Estructura

```
src/
  bot/
    relay-client.ts     # conectar + auth NIP-42 + suscribir/publicar contra Buzz
    command-parser.ts   # detectar "/zap @user <monto>"
    zap-flow.ts          # orquesta el flujo completo Fase 1
  lightning/
    lawallet-client.ts  # LUD-16 (invoice) + LUD-21 (verify/polling) contra LaWallet
  nostr/
    identity.ts          # carga la nsec del bot
    messages.ts           # respuestas de canal (kind 9)
    zap-receipt.ts        # construcción kind:9734 / kind:9735
  db/
    store.ts              # SQLite — auditoría de zaps (pending/paid/expired/failed)
  config.ts               # env + config/triggers.example.yaml (Fase 2)
config/
  triggers.example.yaml   # documenta triggers automáticos (Fase 2, no activo aún)
```

## Próximos pasos (Fase 2, no implementados)

- Trigger engine leyendo `config/*.yaml` en vez de tener el comando `/zap` hardcodeado.
- Reacción 🐝 → zap automático.
- Evaluar si conviene delegarle triggers a los workflows YAML nativos de Buzz
  (`crates/buzz-workflow`, acción `call_webhook`) en vez de reimplementar el trigger engine acá —
  Buzz ya soporta `on: reaction_added` + `call_webhook` hacia `/hooks/{id}` de este servicio.
- Wallets por comunidad (spec sección 5.5) en vez de una sola `LAWALLET_BASE_URL` fija.
