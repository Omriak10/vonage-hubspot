# Vonage Messaging for HubSpot

Send and receive **WhatsApp, RCS and SMS**, place **calls**, run **list campaigns**, build **conversational flows** and trigger messages from **HubSpot workflows** - all from inside HubSpot, on each customer's **own Vonage account**.

Two parts, nothing else:

| Part | Where it runs | Folder |
|---|---|---|
| HubSpot app (UI cards, settings page, workflow actions) | HubSpot (UI Extensions, platform 2026.03) | `hubspot-project/` |
| Backend (OAuth, credentials, relay to Vonage, inbox, flows) | AWS Lambda behind API Gateway and CloudFront, state in DynamoDB (or Vonage Cloud Runtime) | `vcr-backend/`, `deploy/aws/` |

There is no separate web app. All UI lives in HubSpot; the backend is a single Node/Express service. It runs as an AWS Lambda function (the reference deployment, inside the AWS free tier at small volumes) or on Vonage Cloud Runtime; the state layer picks DynamoDB, VCR Instance State or memory from one environment variable.

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
2. **Backend on AWS** (recommended): `cd deploy/aws && npm install`, copy `config.example.json` to `config.json` with your domain, Route 53 zone and HubSpot app credentials, run `node setup.js`. It creates the DynamoDB table, the Lambda, an HTTP API, a TLS certificate, a CloudFront distribution and the DNS record, and prints the public URL. Alternative: Vonage Cloud Runtime with `vcr-backend/vcr.yml.example` and `vcr deploy`.
3. **HubSpot app**: replace `https://YOUR-BACKEND-HOST` in `hubspot-project/` with your domain, `hs project upload`. Copy the app's Client ID, Client Secret and App ID into the backend config and redeploy (`node setup.js --code`).
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
  server.js                 the whole backend (Express; Lambda handler or plain listener)
  public/install.html       hosted install + guide page  (/2v/install/:guid, /2v/guide)
  public/flows.html         hosted flow builder         (/2v/flows?portal=<id>&t=<token>)
  vcr.yml.example           VCR deployment manifest template (alternative hosting)
deploy/aws/
  setup.js                  one-shot AWS deployment (Lambda + API Gateway + CloudFront + DynamoDB + Route 53)
  config.example.json       its configuration template
docs/                       setup, user guide, troubleshooting, API, WhatsApp guide
```

## Security notes

- Vonage API secrets and private keys live only in the backend's state store, per portal. The Settings page shows them masked.
- **Every `/2v/api` route is bound to a portal.** A request is accepted only with a valid HubSpot v3 request signature (what `hubspot.fetch` sends from the cards and the settings page; HubSpot signs the full URL including the portal and app IDs it appends), with a short-lived session token that the card mints for the hosted flow builder, or with the `ADMIN_KEY`. Anything else gets 401. Workflow-action executions have their own signature check (v1, v2 and v3).
- Invite links are minted only with the `ADMIN_KEY`; the invite status poll and the hosted pages are public.
- Set `HS_APP_ID` so requests signed for a different HubSpot app are rejected; `PORTAL_AUTH=log` turns enforcement into logging for a staged rollout.

## Known limitations

- Vonage accepts a message (HTTP 202) before Meta or the carrier evaluates it. A WhatsApp template can therefore show "sent" and be rejected a second later. The backend pre-checks the three common causes (unknown template name, wrong language, wrong variable count) and the status webhook logs the final outcome.
- Free-text WhatsApp only works inside the 24-hour customer-service window; outside it you must use an approved template.
- HubSpot caches UI-extension bundles. After `hs project upload`, wait a few minutes and open the record in a **new tab**.
- The HubSpot Help Desk custom-channel integration is implemented but requires the conversations scopes (Enterprise tiers) and has not been exercised end to end.
- Image-header WhatsApp templates must use small images (Meta rejects large uploads).

## Requirements

- Node 22 and an AWS account with a Route 53 hosted zone for your domain (or the Vonage VCR CLI for VCR hosting), plus a Vonage API account.
- HubSpot developer account with the HubSpot CLI (`hs`), platform version 2026.03 projects.
- A WhatsApp Business Account on Vonage for WhatsApp, an RCS agent on Vonage for RCS, and Vonage numbers for SMS and voice.

## License

No license has been chosen yet. All rights reserved until one is added.
