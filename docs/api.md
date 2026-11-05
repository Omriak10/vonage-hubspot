# Backend routes

All routes are under the backend host. Unless noted, routes take `portalId` (query or body) and act on that portal's stored Vonage credentials. Every `/2v/api` route requires one of: a valid HubSpot v3 request signature (automatic for `hubspot.fetch` from the cards), `Authorization: Bearer <session token>` from `POST /2v/api/session`, or `adminKey` equal to `ADMIN_KEY`. Exempt: the invite status poll, workflow-action executions (own signature check) and admin routes (own key check).

| Route | Purpose |
|---|---|
| `POST /2v/api/session {portalId}` | Mint a 12-hour portal-scoped token for the hosted flow builder. Accepted only on a HubSpot-signed request or with `adminKey`. |
| `GET /2v/api/admin/state?adminKey=&sizes=1`, `POST /2v/api/admin/state {adminKey,data}` | Dump / load the whole state (host migrations). |
| `POST /2v/api/admin/rewire {adminKey, portalId}` | Re-point a portal's Vonage application webhooks at this host. |

## Health and hosted pages

| Route | Purpose |
|---|---|
| `GET /_/health`, `GET /2v/health` | Liveness (VCR requires `/_/health`). |
| `GET /2v/guide` | Hosted install and user guide. |
| `GET /2v/guide/whatsapp.pdf` | WhatsApp guide PDF (when shipped in `public/`). |
| `GET /2v/install/:guid` | Self-serve install page for an invite. |
| `GET /2v/flows?portal=<id>&embed=1` | Flow builder. |
| `GET /2v/media/:id` | Serves media uploaded via `POST /2v/api/media`. |

## OAuth and install

| Route | Purpose |
|---|---|
| `GET /2v/oauth/install?state=<guid>` | Redirects to the HubSpot consent screen. |
| `GET /2v/oauth/callback` | Stores the portal token, marks the invite connected, auto-connects the Help Desk channel when the scopes were granted. |
| `POST /2v/api/install/new {label}` | Mints an invite `{guid,url}`. |
| `GET /2v/api/install/:guid` | Invite status. |
| `GET /2v/api/portals` | Connected portals. |

## Per-portal Vonage settings

| Route | Purpose |
|---|---|
| `GET/POST/DELETE /2v/api/vonage/settings` | Read (masked) / save and verify / remove the portal's Vonage credentials and senders. POST accepts `autoWire:false` to skip webhook wiring. |
| `GET /2v/api/vonage/senders?refresh=1` | Senders discovered on the account (SMS/voice numbers, WhatsApp, RCS, Viber). |
| `POST /2v/api/vonage/defaults {sms,whatsapp,rcs,voice}` | Default sender per channel. |

## Sending

| Route | Purpose |
|---|---|
| `POST /2v/api/send {channel,to,text,contactId}` | Free text on SMS / RCS / WhatsApp. |
| `POST /2v/api/send-rich {template,to,vars}` | Send a tool-built rich template. |
| `POST /2v/api/preview` | Returns the exact Vonage payload without sending. |
| `POST /2v/api/wa/send-template {name,language,bodyParams,to}` | Send an approved WhatsApp template. |
| `POST /2v/api/call {to}` | Place a call from the portal's voice number. |
| `POST /2v/api/campaign/send`, `/campaign/wa-template`, `/campaign/call` | List campaigns. |
| `POST /2v/api/media {dataUrl}` | Host a base64 image for Vonage to fetch. |

## Templates

| Route | Purpose |
|---|---|
| `GET/POST /2v/api/templates`, `DELETE /2v/api/templates/:id` | Tool-built templates with live Meta status overlay. |
| `POST /2v/api/templates/:id/submit` | Submit a WhatsApp template for Meta approval through Vonage. |
| `GET /2v/api/wa/templates?raw=1` | Every template on the WhatsApp Business Account. |
| `DELETE /2v/api/wa/templates?name=` | Delete a template from the account. |
| `GET /2v/api/admin/wa-template?name=&adminKey=` | Meta's raw record for a template (admin). |

## Inbox and opt-out

| Route | Purpose |
|---|---|
| `GET /2v/api/inbox/conversations?channel=` | Conversation list. |
| `GET /2v/api/inbox/thread?phone=` | One thread (marks read). |
| `POST /2v/api/inbox/read`, `POST /2v/api/inbox/delete` | Read state / delete thread. |
| `GET /2v/api/optouts`, `POST /2v/api/optouts/remove {phone}` | Opt-out list. |

## Flows

| Route | Purpose |
|---|---|
| `GET/POST /2v/api/flows`, `DELETE /2v/api/flows/:id` | Flow definitions. |
| `POST /2v/api/flows/:id/start {to,contactId}` | Start for one person. |
| `POST /2v/api/flows/:id/start-list {listId}` | Start for a HubSpot list. |
| `POST /2v/api/flows/:id/simulate {text|reset, flow?}` | Dry run (used by the builder's phone preview). |
| `GET/DELETE /2v/api/flows/sessions` | Live sessions. |

## HubSpot helpers

| Route | Purpose |
|---|---|
| `GET /2v/api/hs/resolve?objectType=&objectId=` | Phone and name for a contact or lead. |
| `GET /2v/api/hs/lists`, `GET /2v/api/hs/lists/:listId/members`, `GET /2v/api/hs/contacts-with-phone` | List browsing for campaigns. |
| `GET /2v/api/hs/token-scopes?adminKey=` | Scopes granted by the portal (admin). |

## Workflow actions (called by HubSpot, signature-verified)

| Route | Purpose |
|---|---|
| `POST /2v/api/workflow/send?channel=sms|rcs|whatsapp` | The three send actions. |
| `POST /2v/api/workflow/flow` | Start Vonage flow action. |

## Webhooks

| Route | Purpose |
|---|---|
| `POST /2v/webhooks/inbound?portal=<id>` | Vonage inbound messages (all channels). |
| `POST /2v/webhooks/status` | Vonage delivery status. |
| `POST /2v/webhooks/hubspot` | HubSpot webhook subscriptions. |
| `GET /2v/voice/answer`, `POST /2v/voice/events`, `GET /2v/voice/token` | Voice NCCO, events, client token. |

## Help Desk custom channel (beta)

| Route | Purpose |
|---|---|
| `POST /2v/api/hschannel/register {channelId|devApiKey, appId, adminKey}` | Register the channel (app owner, once). |
| `GET /2v/api/hschannel/inboxes`, `GET /2v/api/hschannel/status` | Portal inboxes / connection status. |
| `POST /2v/api/hschannel/connect {portalId, inboxId?}` | Connect the portal's WhatsApp sender to an inbox. |
| `POST /2v/hubspot/channel` | Agent replies from HubSpot (signature-verified). |
