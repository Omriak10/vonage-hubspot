# Setup guide

This walks through a fresh deployment: Vonage account, backend on Vonage Cloud Runtime (VCR), HubSpot app, first install, first message.

## 1. Vonage side

1. Sign in to the Vonage API dashboard.
2. **Applications > Create a new application.** Enable **Messages** and **Voice**. Generate a key pair and download the private key (you will paste it into HubSpot later; the backend also uses it to sign JWTs).
3. Link your senders to that application:
   - SMS and voice numbers (Numbers > Your numbers > link).
   - Your WhatsApp Business number (the number must be linked to this application, otherwise sends are refused with 401).
   - Your RCS agent (sender ID), once Vonage has launched it.
4. Note the **API key** and **API secret** of the account (dashboard home). The secret is shown once when created; if you no longer have it, add a second secret under *Settings > API settings* (two per key).
5. Webhooks: leave them for now. The backend sets the application's Messages and Voice webhooks automatically when a portal connects (unless you opt out in the Settings page).

## 2. Backend on VCR

Prerequisites: Node 22, the Vonage VCR CLI (`npm i -g @vonage/vcr-cli`, then `vcr configure` with your API key and secret).

```bash
cd vcr-backend
cp vcr.yml.example vcr.yml      # fill in the values, see below
npm install                     # VCR does not install dependencies - node_modules must be shipped
vcr app create --name "vonage-hubspot-backend"   # creates a VCR-registered Vonage application for the instance
vcr deploy
```

`vcr app create` prints an application id. Put it in `vcr.yml` under `instance.application-id` (VCR injects that application's private key into the instance; an application created only in the dashboard is not registered with VCR and the deploy fails with "credentials not found").

`vcr.yml` environment values:

| Name | Meaning |
|---|---|
| `BASE_URL` | The public host VCR gives the instance, e.g. `https://neru-<key>-<project>-<instance>.euw1.runtime.vonage.cloud`. The first deploy prints it; set it and deploy again. It must match exactly, because HubSpot workflow signatures are computed over the full URL. |
| `ADMIN_KEY` | Any long random string. Required by admin routes (`/2v/api/admin/*`, Help Desk channel registration). |
| `HS_CLIENT_ID` / `HS_CLIENT_SECRET` | From the HubSpot app (step 3). The secret is also what verifies workflow-action and webhook signatures. |
| `HS_SCOPES` | Required OAuth scopes. Keep in sync with `app-hsmeta.json` `requiredScopes`. |
| `HS_OPTIONAL_SCOPES` | Optional scopes offered at install (conversations.* for Help Desk, `crm.objects.custom.read` for custom-object workflows). |

The deploy must answer `GET /_/health` with 200 or VCR rolls it back. After a successful deploy:

```
GET https://<BASE_URL>/_/health        -> ok
GET https://<BASE_URL>/2v/guide        -> hosted install and user guide
```

## 3. HubSpot app

Prerequisites: a HubSpot developer account, the HubSpot CLI (`npm i -g @hubspot/cli`, `hs init`, `hs auth`).

1. Replace the backend host placeholder everywhere in `hubspot-project/`:

   ```bash
   grep -rl "YOUR-BACKEND-HOST" hubspot-project | xargs sed -i 's#https://YOUR-BACKEND-HOST#https://<your BASE_URL>#g'
   ```

   It appears in `app-hsmeta.json` (redirect URL, permitted fetch and iframe URLs, support URLs), every card and the settings page (`const MW = ...`), the webhook subscription and the four workflow actions (`actionUrl`).
2. Review `src/app/app-hsmeta.json`: app name, description, support email. Keep `distribution: marketplace` if you intend to list it; an unlisted public app can still be installed by any portal through the OAuth URL.
3. Upload:

   ```bash
   cd hubspot-project
   hs project upload --account <your developer account id> --force-create --skip-npm-audit
   ```

   The build log lists the components it found. Expect the app, five cards, the settings page, the webhooks component and four workflow actions. A component with a wrong type or folder is silently ignored, so check the count.
4. In the developer account open the app (Apps > Vonage Messaging > Auth) and copy the **Client ID** and **Client secret** into `vcr.yml` (`HS_CLIENT_ID`, `HS_CLIENT_SECRET`). Redeploy the backend.
5. The first time you install from a developer account HubSpot asks the account to accept the App Marketplace Acceptable Use Policy. Do it once.

## 4. Install into a portal

Two ways:

- **Direct**: send the admin of the portal to `https://<BASE_URL>/2v/oauth/install`. HubSpot shows the consent screen (required scopes plus optional checkboxes), then redirects back and the backend stores the portal token.
- **Self-serve invite page**: `POST https://<BASE_URL>/2v/api/install/new {"label":"Customer name"}` returns `{guid, url}`. The URL opens a hosted page with an Install button, live connection status, and the guide. The OAuth state carries the GUID so the page turns green when the portal is connected.

On the consent screen the optional scopes are unticked by default. Tick `crm.objects.custom.read` if the customer will run workflows on custom objects; tick the three `conversations.*` scopes for the Help Desk channel (Enterprise only; disabled on free portals).

## 5. Connect Vonage inside HubSpot

In the portal: **Marketplace > Connected apps > Vonage Messaging > Settings**.

Enter:

- Vonage API key and API secret.
- Application ID and the application's private key (paste the PEM into the text area).
- Senders: WhatsApp number, RCS sender ID, SMS sender, voice number. After the first save the backend discovers every sender on the account (numbers linked to the application, WhatsApp numbers, RCS agents, Viber services) and offers them as dropdowns; the typed values are the defaults used by the cards, campaigns and workflow actions; flows can pick a different sender each.
- Leave **auto-wire webhooks** on. The backend sets the application's inbound and status webhooks to `.../2v/webhooks/inbound?portal=<id>` and `.../2v/webhooks/status`, keeping any other capabilities. Turn it off only if that application's webhooks are used by something else, and then point your own webhook to the same URLs.

Save & verify mints a JWT with the key, reads the application with Basic auth, resolves the WhatsApp Business Account id from the WhatsApp number and warns if the number is not linked to the application you entered.

## 6. Add the cards to the record view

HubSpot does not surface new cards automatically. In a contact record: **Customize record > add tab "Vonage"** and add *Vonage Messaging*, *Vonage Inbox* and *Vonage Templates & Campaigns*. The *Vonage (message & call)* card on Leads appears in the preview sidebar (*Customize preview*).

After each `hs project upload`, HubSpot keeps serving the previous bundle for a few minutes. Open the record in a new tab rather than reloading.

## 7. First message

Open a contact with a mobile number, go to the Vonage tab, choose SMS, type, send. The card shows "sent and logged", a note appears on the timeline, and the status webhook logs `delivered`. For WhatsApp outside the 24-hour window pick an approved template in the dropdown and fill its variables.

## Redeploying

Backend: edit `server.js`, `node --check server.js`, `vcr deploy` from `vcr-backend/`. Logs:

```bash
vcr instance log --id <instance id> --history 6000 --source-type application
```

The inbox poll floods the log; grep for `[wf]`, `[status]`, `[tpl]`, `[oauth]`, `[flow]`.

HubSpot: `hs project upload` from `hubspot-project/`. New scopes require every portal to re-consent (open the install URL again; HubSpot shows "I accept the risk" for scope changes on a non-listed app).

## Updating the backend host later

If the VCR host changes (new project or instance name), update `BASE_URL`, every `YOUR-BACKEND-HOST` replacement in `hubspot-project/`, re-upload the HubSpot project, and reconnect each portal's Vonage settings so the webhooks are re-wired.
