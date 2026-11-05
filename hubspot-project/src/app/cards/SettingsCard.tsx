import {
  Alert,
  Button,
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
import type { CrmContext } from '@hubspot/ui-extensions';

const MW = 'https://YOUR-BACKEND-HOST';

hubspot.extend<'crm.record.tab'>(({ context }: { context: CrmContext }) => <SettingsCard context={context} />);

interface Saved {
  apiKey: string; apiSecretMasked: string; appId: string; privateKeyLoaded: boolean;
  waFrom: string; rcsFrom: string; smsFrom: string; voiceFrom: string;
  wabaId: string; wabaTokenMasked: string; webhooksWired: boolean; verifiedAt: number | null;
}

const SettingsCard = ({ context }: { context: CrmContext }) => {
  const portalId = context.portal?.id;
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
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    if (!portalId) return;
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
      })
      .catch(() => {});
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

  return (
    <Flex direction="column" gap="md">
      <Heading>Vonage account</Heading>
      <Text variant="microcopy">
        Messages and calls are sent from your own Vonage account and numbers. Get these from dashboard.vonage.com:
        your API key and secret (shown on the dashboard home page), and an Application with Messages + Voice enabled
        - its Application ID and private key, with your numbers linked to it.
      </Text>
      {configured && saved && (
        <Alert title="Connected" variant="success">
          Vonage app {saved.appId}{saved.verifiedAt ? ' (verified)' : ''}{saved.webhooksWired ? ' - inbound webhooks wired.' : ''} Update any field below and save again to change it.
        </Alert>
      )}
      <Flex direction="row" gap="md">
        <Input label="Vonage API key" name="vApiKey" value={apiKey} onInput={(v) => setApiKey(v)} placeholder="e.g. a1b2c3d4" />
        <Input label="API secret" name="vApiSecret" value={apiSecret} onInput={(v) => setApiSecret(v)}
          placeholder={saved?.apiSecretMasked ? `Saved (${saved.apiSecretMasked}) - enter to change` : 'Your API secret'} />
      </Flex>
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
      <Flex direction="row" gap="md">
        <Input label="WABA ID (for WhatsApp templates)" name="vWabaId" value={wabaId} onInput={(v) => setWabaId(v)} placeholder="For WhatsApp templates" />
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
