import {
  Alert,
  Divider,
  Flex,
  Heading,
  Input,
  LoadingButton,
  Text,
  TextArea,
  hubspot,
} from '@hubspot/ui-extensions';
import { useEffect, useState } from 'react';

const MW = 'https://YOUR-BACKEND-HOST';

// Account-level credentials belong on the app's own Settings tab, not buried in a
// tab on a contact record - customers could not find the card there.
// Marketplace > Connected apps > My apps > Vonage Messaging > Settings.
hubspot.extend<'settings'>(({ context }: { context: any }) => <SettingsPage context={context} />);

interface Saved {
  apiKey: string; apiSecretMasked: string; appId: string; privateKeyLoaded: boolean;
  waFrom: string; rcsFrom: string; smsFrom: string; voiceFrom: string;
  wabaId: string; wabaTokenMasked: string; webhooksWired: boolean; verifiedAt: number | null;
}

const SettingsPage = ({ context }: { context: any }) => {
  const portalId = context?.portal?.id || context?.portalId;
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [appId, setAppId] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [waFrom, setWaFrom] = useState('');
  const [rcsFrom, setRcsFrom] = useState('');
  const [smsFrom, setSmsFrom] = useState('');
  const [voiceFrom, setVoiceFrom] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [wabaToken, setWabaToken] = useState('');
  const [saved, setSaved] = useState<Saved | null>(null);
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    if (!portalId) { setLoaded(true); return; }
    hubspot.fetch(`${MW}/2v/api/vonage/settings?portalId=${portalId}`, { method: 'GET' })
      .then((r) => r.json())
      .then((d) => {
        setConfigured(!!d.configured);
        const s: Saved | null = d.settings || null;
        setSaved(s);
        if (s) {
          setApiKey(s.apiKey || '');
          setAppId(s.appId || '');
          setWaFrom(s.waFrom || '');
          setRcsFrom(s.rcsFrom || '');
          setSmsFrom(s.smsFrom || '');
          setVoiceFrom(s.voiceFrom || '');
          setWabaId(s.wabaId || '');
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [portalId]);

  const save = async () => {
    setBusy(true); setResult(null);
    try {
      const body: Record<string, unknown> = { portalId, apiKey, appId, waFrom, rcsFrom, smsFrom, voiceFrom, wabaId };
      if (apiSecret) body.apiSecret = apiSecret;
      if (wabaToken) body.wabaToken = wabaToken;
      if (privateKey) body.privateKey = privateKey;
      const r = await hubspot.fetch(`${MW}/2v/api/vonage/settings`, { method: 'POST', body });
      const d = await r.json();
      if (d.ok) {
        setConfigured(true); setSaved(d.settings || null); setPrivateKey(''); setApiSecret(''); setWabaToken('');
        setResult({ ok: true, msg: `Saved${d.verified ? ` and verified with Vonage (app: ${d.appName || d.settings?.appId})` : ''}.${d.webhooksWired ? ' Inbound webhooks were wired automatically - replies will land in your Vonage Inbox.' : (d.wireError ? ` Webhook wiring: ${d.wireError}` : '')}${d.wabaResolved ? ' Your WhatsApp Business Account ID was filled in automatically from your number.' : ''}${d.waWarning ? ` WARNING: ${d.waWarning}` : ''}` });
      } else {
        setResult({ ok: false, msg: d.error || d.message || 'Save failed' });
      }
    } catch (e) {
      setResult({ ok: false, msg: `Could not reach the messaging service: ${(e as Error).message}` });
    }
    setBusy(false);
  };

  if (!loaded) return <Text>Loading your Vonage settings...</Text>;

  return (
    <Flex direction="column" gap="md">
      <Heading>Connect your Vonage account</Heading>
      <Text>
        Messages and calls are sent from your own Vonage account and numbers - nothing goes through a shared account.
        Enter your credentials once here and every Vonage card in your CRM starts working.
      </Text>

      {configured && saved ? (
        <Alert title="Connected" variant="success">
          Vonage application {saved.appId}{saved.verifiedAt ? ' (verified)' : ''}
          {saved.webhooksWired ? ' - inbound webhooks wired, replies land in your Vonage Inbox.' : ''} Change any field
          below and save again to update it.
        </Alert>
      ) : (
        <Alert title="Not connected yet" variant="warning">
          Until this is filled in, the Vonage cards on your records will say "not configured" and no messages can be sent.
        </Alert>
      )}

      <Divider />
      <Heading>Account credentials</Heading>
      <Text variant="microcopy">
        From dashboard.vonage.com: your API key and secret are on the dashboard home page. Note that the API secret is
        shown only once when the account is created - if you no longer have it, go to Settings &gt; API settings and add
        a new secret (each key allows two).
      </Text>
      <Flex direction="row" gap="md">
        <Input label="Vonage API key" name="vApiKey" value={apiKey} onInput={(v) => setApiKey(v)} placeholder="e.g. a1b2c3d4" />
        <Input label="API secret" name="vApiSecret" value={apiSecret} onInput={(v) => setApiSecret(v)}
          placeholder={saved?.apiSecretMasked ? `Saved (${saved.apiSecretMasked}) - enter to change` : 'Your API secret'} />
      </Flex>

      <Divider />
      <Heading>Your Vonage application</Heading>
      <Text variant="microcopy">
        In the Vonage dashboard create an Application with Messages and Voice enabled, link your numbers to it, then
        paste its Application ID and private key here.
      </Text>
      <Input label="Application ID" name="vAppId" value={appId} onInput={(v) => setAppId(v)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
      <TextArea label={saved?.privateKeyLoaded ? 'Private key (on file - paste to replace)' : 'Private key'} name="vKey"
        value={privateKey} onInput={(v) => setPrivateKey(v)} rows={4}
        placeholder={'Paste the full contents of the application\'s private.key file (-----BEGIN PRIVATE KEY-----...)'} />

      <Divider />
      <Heading>Your senders</Heading>
      <Text variant="microcopy">Configure at least one. These must be linked to the application above in your Vonage dashboard.</Text>
      <Flex direction="row" gap="md">
        <Input label="WhatsApp number" name="vWa" value={waFrom} onInput={(v) => setWaFrom(v)} placeholder="e.g. 447700900000" />
        <Input label="RCS sender ID" name="vRcs" value={rcsFrom} onInput={(v) => setRcsFrom(v)} placeholder="Your RCS agent" />
      </Flex>
      <Flex direction="row" gap="md">
        <Input label="SMS sender" name="vSms" value={smsFrom} onInput={(v) => setSmsFrom(v)} placeholder="Number or alpha sender" />
        <Input label="Voice number" name="vVoice" value={voiceFrom} onInput={(v) => setVoiceFrom(v)} placeholder="Calls come from this" />
      </Flex>

      <Divider />
      <Heading>WhatsApp templates (optional)</Heading>
      <Text variant="microcopy">Your WhatsApp Business Account ID lets the cards list your approved templates and submit new ones for approval - all through your Vonage account. No Meta token is needed.</Text>
      <Flex direction="row" gap="md">
        <Input label="WhatsApp Business Account ID" name="vWabaId" value={wabaId} onInput={(v) => setWabaId(v)} placeholder="Your WABA ID" />
      </Flex>

      {result && <Alert title={result.ok ? 'Saved' : 'Not saved'} variant={result.ok ? 'success' : 'error'}>{result.msg}</Alert>}
      <LoadingButton loading={busy} variant="primary" onClick={save}>Save &amp; verify</LoadingButton>
      <Text variant="microcopy">
        We verify the credentials against the Vonage API and automatically point your application's webhooks at this
        integration so replies land in your inbox. Your messages are sent exclusively through your own account.
      </Text>
    </Flex>
  );
};
