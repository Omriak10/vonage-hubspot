# Vonage Messaging for HubSpot

Send and receive **WhatsApp, RCS and SMS**, place **calls**, run **list campaigns**, build **conversational flows** and trigger messages from **HubSpot workflows** - all from inside HubSpot, on each customer's **own Vonage account**.

Two parts, nothing else:

| Part | Where it runs | Folder |
|---|---|---|
| HubSpot app (UI cards, settings page, workflow actions) | HubSpot (UI Extensions, platform 2026.03) | `hubspot-project/` |
| Backend (OAuth, credentials, relay to Vonage, inbox, flows) | Vonage Cloud Runtime (VCR) | `vcr-backend/` |

There is no separate web app and no third-party cloud. All UI lives in HubSpot; the backend is a single Node/Express service on VCR that keeps state in VCR Instance State.

## What you get in HubSpot

- **Vonage Messaging** card (contact record): send WhatsApp (approved template or free text inside the 24-hour window), RCS or SMS; one-click call.
- **Vonage Inbox** card: unified two-way inbox, one thread per person across every channel, reply from the record.
- **Vonage Templates & Campaigns** card: build rich messages (RCS rich cards and carousels, WhatsApp buttons and media), create and submit WhatsApp templates for Meta approval, see every template on your WhatsApp Business Account with live status, send to the contact, or campaign to any HubSpot list.
- **Flows** builder (opened from the Templates card): keyword, inbound or outbound triggers, if/then branching on replies, templates inside flows, phone simulator, start a flow for a contact or a whole list.
- **Vonage (message & call)** compact card on Lead records.
- **Settings page** (Marketplace > Connected apps > Vonage Messaging > Settings): connect your Vonage API key, application and senders. Webhooks are wired automatically.
- **Workflow actions**: *Send SMS via Vonage*, *Send RCS via Vonage*, *Send WhatsApp template via Vonage*, *Start Vonage flow*. They work on contact-based workflows and on deal, company, ticket, meeting and custom-object workflows (the associated contact is resolved).
- **Opt-out handling**: STOP/UNSUBSCRIBE (typed or button) blocks every future send to that number until START; logged on the contact.
- **Timeline logging**: every send, reply, button click and workflow send becomes a note on the contact.

## Multi-tenant by design

Every HubSpot portal brings its own Vonage account. Credentials are entered once in the Settings page and stored per portal in VCR state. There is **no shared or fallback account**: a portal that has not connected Vonage gets a clear "not connected yet" message everywhere.

## Quick start

1. **Vonage**: create an Application with *Messages* and *Voice* enabled, link your numbers, WhatsApp number and RCS agent to it, download its private key. See [docs/setup.md](docs/setup.md#1-vonage-side).
2. **Backend**: copy `vcr-backend/vcr.yml.example` to `vcr-backend/vcr.yml`, fill in the values, `npm install`, `vcr deploy`. Note the host URL VCR prints.
3. **HubSpot app**: replace `https://YOUR-BACKEND-HOST` in `hubspot-project/` with that host, `hs project upload`. Copy the app's Client ID and Client Secret into `vcr.yml` and redeploy.
4. **Install** the app into a portal from `https://<host>/2v/oauth/install` (or mint a self-serve invite link), add the cards to the contact record view, open the Settings page and connect Vonage.
5. Open a contact, go to the **Vonage** tab, send a message.

Full instructions: [docs/setup.md](docs/setup.md). Day-to-day use: [docs/user-guide.md](docs/user-guide.md). WhatsApp templates explained for non-technical users: [docs/whatsapp-guide.html](docs/whatsapp-guide.html). When something fails: [docs/troubleshooting.md](docs/troubleshooting.md). Backend routes: [docs/api.md](docs/api.md).

## Repository layout

```
hubspot-project/            HubSpot developer project (upload with the HubSpot CLI)
  src/app/app-hsmeta.json   app definition: OAuth scopes, permitted URLs, support info
  src/app/cards/            Messaging, Inbox, Templates & Campaigns, Lead, Settings cards
  src/app/settings/         app-level Settings page
  src/app/workflow-actions/ the four workflow actions
  src/app/webhooks/         HubSpot webhook subscription
vcr-backend/
  server.js                 the whole backend (Express on @vonage/vcr-sdk)
  public/install.html       hosted install + guide page  (/2v/install/:guid, /2v/guide)
  public/flows.html         hosted flow builder         (/2v/flows?portal=<id>)
  vcr.yml.example           VCR deployment manifest template
docs/                       setup, user guide, troubleshooting, API, WhatsApp guide
```

## Security notes

- Vonage API secrets and private keys live only in VCR state, per portal. The Settings page shows them masked.
- Workflow-action executions are verified with HubSpot request signatures (v1, v2 and v3 supported).
- Admin-only routes require the `ADMIN_KEY` from `vcr.yml`.
- **Known gap**: the per-portal settings endpoints (`/2v/api/vonage/settings`, `/senders`, `/defaults`) are called by the HubSpot cards and are not yet bound to a HubSpot-signed request. Anyone who knows a portal ID could read the masked settings or overwrite them. Put the backend behind an allow-list or add the HubSpot `hubspot.fetch` JWT check before offering this to untrusted parties. See [docs/troubleshooting.md](docs/troubleshooting.md#security-hardening-before-wider-rollout).

## Known limitations

- Vonage accepts a message (HTTP 202) before Meta or the carrier evaluates it. A WhatsApp template can therefore show "sent" and be rejected a second later. The backend pre-checks the three common causes (unknown template name, wrong language, wrong variable count) and the status webhook logs the final outcome.
- Free-text WhatsApp only works inside the 24-hour customer-service window; outside it you must use an approved template.
- HubSpot caches UI-extension bundles. After `hs project upload`, wait a few minutes and open the record in a **new tab**.
- The HubSpot Help Desk custom-channel integration is implemented but requires the conversations scopes (Enterprise tiers) and has not been exercised end to end.
- Image-header WhatsApp templates must use small images (Meta rejects large uploads).

## Requirements

- Node 22 (VCR runtime `nodejs22`), the Vonage VCR CLI (`vcr`) and a Vonage API account.
- HubSpot developer account with the HubSpot CLI (`hs`), platform version 2026.03 projects.
- A WhatsApp Business Account on Vonage for WhatsApp, an RCS agent on Vonage for RCS, and Vonage numbers for SMS and voice.

## License

No license has been chosen yet. All rights reserved until one is added.
