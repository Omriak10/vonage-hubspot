import {
  Alert,
  Button,
  ButtonRow,
  Divider,
  Flex,
  Heading,
  Input,
  LoadingButton,
  Select,
  Text,
  TextArea,
  hubspot,
} from '@hubspot/ui-extensions';
import { useEffect, useRef, useState } from 'react';
import type { CrmContext, ExtensionPointApiActions } from '@hubspot/ui-extensions';

const MW = 'https://YOUR-BACKEND-HOST';

const NOT_SET = 'Vonage is not connected yet. An admin can connect your Vonage account in HubSpot: Marketplace > Connected apps > My apps > Vonage Messaging > Settings.';
const niceErr = (d: unknown) => /not_configured|not configured/i.test(String(d)) ? NOT_SET : String(d);

interface CrmExtensionProps {
  context: CrmContext;
  actions: ExtensionPointApiActions<'crm.record.tab'>;
}

hubspot.extend<'crm.record.tab'>(({ context, actions }: CrmExtensionProps) => (
  <InboxCard context={context} actions={actions} />
));

type Channel = 'whatsapp' | 'rcs' | 'sms';
type Filter = 'all' | Channel;
interface Convo { phone: string; name: string; contactId: string | number | null; lastText: string; lastTs: number; lastChannel: string; channels: string[]; unread: number; count: number }
interface Msg { id: string; dir: 'in' | 'out'; channel: string; type: string; text: string; media: string; ts: number }
interface Thread { phone: string; name: string; contactId: string | number | null; channels: string[]; messages: Msg[] }
interface WaTpl { name: string; language: string; varCount: number; bodyText: string }

const CH_LABEL: Record<string, string> = { whatsapp: 'WhatsApp', rcs: 'RCS', sms: 'SMS' };

const fmtTime = (ts: number) => {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const InboxCard = ({ context }: CrmExtensionProps) => {
  const portalId = context.portal?.id;
  const [filter, setFilter] = useState<Filter>('all');
  const [convos, setConvos] = useState<Convo[]>([]);
  const lastListRef = useRef('');
  const [loadingList, setLoadingList] = useState(true);
  const [open, setOpen] = useState<string | null>(null); // selected phone
  const [thread, setThread] = useState<Thread | null>(null);
  const [replyCh, setReplyCh] = useState<Channel>('whatsapp');
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  // WhatsApp approved templates (for replying outside the 24h window)
  const [waTpls, setWaTpls] = useState<WaTpl[]>([]);
  const [waName, setWaName] = useState('');
  const [waParams, setWaParams] = useState<string[]>([]);

  const openRef = useRef<string | null>(null);
  openRef.current = open;

  const loadList = () => {
    const q = `${MW}/2v/api/inbox/conversations?portalId=${portalId}${filter === 'all' ? '' : `&channel=${filter}`}`;
    hubspot.fetch(q, { method: 'GET' })
      .then((r) => r.json())
      .then((d) => {
        // The 12s poll used to replace the list with a fresh array every time, which
        // re-rendered ~100 rows and made the card re-measure its height - shoving
        // every card below it. Only touch state when the data actually changed.
        const list = d.conversations || [];
        const key = JSON.stringify(list);
        if (key !== lastListRef.current) { lastListRef.current = key; setConvos(list); }
      })
      .catch(() => {})
      .finally(() => setLoadingList(false));
  };

  const loadThread = (phone: string) => {
    hubspot.fetch(`${MW}/2v/api/inbox/thread?portalId=${portalId}&phone=${encodeURIComponent(phone)}`, { method: 'GET' })
      .then((r) => r.json())
      .then((d: Thread) => {
        setThread(d);
        const last = [...(d.messages || [])].reverse().find((m) => m.dir === 'in');
        setReplyCh(((last?.channel as Channel) || (d.channels?.[0] as Channel) || 'whatsapp'));
      })
      .catch(() => {});
  };

  // Poll: refresh the list, and the open thread, every 12s.
  useEffect(() => { setLoadingList(true); loadList(); }, [filter, portalId]);
  useEffect(() => {
    const t = setInterval(() => { loadList(); if (openRef.current) loadThread(openRef.current); }, 12000);
    return () => clearInterval(t);
  }, [filter, portalId]);

  // Load approved WhatsApp templates once (used when replying on WhatsApp).
  useEffect(() => {
    hubspot.fetch(`${MW}/2v/api/wa/templates?portalId=${portalId}`, { method: 'GET' })
      .then((r) => r.json())
      .then((d) => setWaTpls(d.templates || []))
      .catch(() => {});
  }, []);

  const openConvo = (c: Convo) => {
    setResult(null); setReply(''); setWaName(''); setWaParams([]);
    setOpen(c.phone); openRef.current = c.phone;
    setThread({ phone: c.phone, name: c.name, contactId: c.contactId, channels: c.channels, messages: [] });
    loadThread(c.phone);
    loadList();
  };
  const back = () => { setOpen(null); openRef.current = null; setThread(null); setResult(null); loadList(); };

  const applyWa = (n: string) => {
    setWaName(n);
    const t = waTpls.find((x) => x.name === n);
    const first = (thread?.name || '').split(' ')[0] || '';
    setWaParams(t ? new Array(t.varCount).fill('').map((_, i) => (i === 0 ? first : '')) : []);
    if (t) setReply(t.bodyText || '');
  };
  const setParam = (i: number, v: string) => setWaParams((p) => { const n = [...p]; n[i] = v; return n; });

  const send = async () => {
    if (!thread) return;
    setResult(null);
    const waSel = replyCh === 'whatsapp' ? waTpls.find((t) => t.name === waName) : undefined;
    if (!waSel && !reply.trim()) { setResult({ ok: false, msg: 'Type a reply first.' }); return; }
    if (waSel && waSel.varCount > 0 && waParams.some((p) => !p.trim())) { setResult({ ok: false, msg: `Fill all ${waSel.varCount} variable(s).` }); return; }
    setBusy(true);
    try {
      let res;
      if (waSel) {
        res = await hubspot.fetch(`${MW}/2v/api/wa/send-template`, { method: 'POST', body: { portalId, contactId: thread.contactId, to: thread.phone, name: waSel.name, language: waSel.language, bodyParams: waSel.varCount > 0 ? waParams : [] } });
      } else {
        res = await hubspot.fetch(`${MW}/2v/api/send`, { method: 'POST', body: { portalId, contactId: thread.contactId, channel: replyCh, to: thread.phone, text: reply } });
      }
      const body = await res.json();
      if (res.ok && body.ok) {
        setResult({ ok: true, msg: `${CH_LABEL[replyCh]} sent.` });
        setReply(''); setWaName(''); setWaParams([]);
        loadThread(thread.phone); loadList();
      } else {
        const detail = body?.body?.title || body?.body?.detail || body?.error || `status ${res.status}`;
        setResult({ ok: false, msg: `Could not send: ${niceErr(detail)}` });
      }
    } catch (e) { setResult({ ok: false, msg: 'Could not reach the messaging service.' }); } finally { setBusy(false); }
  };

  // ---- Thread (conversation) view ----
  if (open && thread) {
    const waSel = replyCh === 'whatsapp' ? waTpls.find((t) => t.name === waName) : undefined;
    return (
      <Flex direction="column" gap="small">
        <Flex justify="between" align="center">
          <Button variant="transparent" onClick={back}>← All conversations</Button>
          <Button variant="transparent" onClick={() => loadThread(thread.phone)}>Refresh</Button>
        </Flex>
        <Heading>{thread.name || thread.phone}</Heading>
        <Text variant="microcopy">{thread.phone} · {(thread.channels || []).map((c) => CH_LABEL[c] || c).join(', ')}</Text>
        <Divider />

        {(!thread.messages || thread.messages.length === 0) ? (
          <Text variant="microcopy">No messages yet in this conversation.</Text>
        ) : (
          <Flex direction="column" gap="extra-small">
            {thread.messages.map((m) => (
              <Flex key={m.id} justify={m.dir === 'out' ? 'end' : 'start'}>
                <Flex direction="column" align={m.dir === 'out' ? 'end' : 'start'}>
                  <Text format={{ fontWeight: m.dir === 'out' ? 'regular' : 'bold' }}>
                    {m.text || (m.media ? `[${m.type}] ${m.media}` : `[${m.type}]`)}
                  </Text>
                  <Text variant="microcopy">
                    {m.dir === 'out' ? 'You' : 'Them'} · {CH_LABEL[m.channel] || m.channel} · {fmtTime(m.ts)}
                  </Text>
                </Flex>
              </Flex>
            ))}
          </Flex>
        )}

        <Divider />
        <Text format={{ fontWeight: 'bold' }}>Reply</Text>
        <Select
          label="Channel"
          name="replyCh"
          value={replyCh}
          onChange={(v) => { setReplyCh(v as Channel); setWaName(''); setWaParams([]); }}
          options={[
            { label: 'WhatsApp', value: 'whatsapp' },
            { label: 'RCS', value: 'rcs' },
            { label: 'SMS', value: 'sms' },
          ]}
        />
        {replyCh === 'whatsapp' && waTpls.length > 0 && (
          <Select
            label={`Approved WhatsApp template (${waTpls.length})`}
            name="waTpl"
            value={waName}
            placeholder="Free text (within 24h window)"
            onChange={(v) => applyWa(v as string)}
            options={waTpls.map((t) => ({ label: `${t.name} (${t.language})`, value: t.name }))}
          />
        )}
        {waSel && waSel.varCount > 0 && new Array(waSel.varCount).fill(0).map((_, i) => (
          <Input key={i} label={`Variable {{${i + 1}}}`} name={`wp${i}`} value={waParams[i] || ''} onInput={(v: string) => setParam(i, v)} />
        ))}
        {!waSel && (
          <TextArea label="Message" name="reply" value={reply} onInput={(v) => setReply(v)} rows={3} placeholder={`Reply on ${CH_LABEL[replyCh]}…`} />
        )}
        {result && <Alert title={result.ok ? 'Sent' : 'Heads up'} variant={result.ok ? 'success' : 'danger'}>{result.msg}</Alert>}
        <ButtonRow>
          {busy ? <LoadingButton loading>Sending…</LoadingButton> : <Button variant="primary" onClick={send}>Send {CH_LABEL[replyCh]}</Button>}
        </ButtonRow>
      </Flex>
    );
  }

  // ---- Conversation list view ----
  const unreadTotal = convos.reduce((s, c) => s + (c.unread || 0), 0);
  return (
    <Flex direction="column" gap="small">
      <Flex justify="between" align="center">
        <Heading>Inbox{unreadTotal > 0 ? ` · ${unreadTotal} unread` : ''}</Heading>
        <Button variant="transparent" onClick={() => { setLoadingList(true); loadList(); }}>Refresh</Button>
      </Flex>
      <Text variant="microcopy">Everyone who has messaged you, across WhatsApp, RCS and SMS. Open a conversation to read the full history and reply on any channel.</Text>
      <Select
        label="Channel"
        name="filter"
        value={filter}
        onChange={(v) => setFilter(v as Filter)}
        options={[
          { label: 'All channels', value: 'all' },
          { label: 'WhatsApp', value: 'whatsapp' },
          { label: 'RCS', value: 'rcs' },
          { label: 'SMS', value: 'sms' },
        ]}
      />
      <Divider />
      {loadingList ? (
        <Text variant="microcopy">Loading conversations…</Text>
      ) : convos.length === 0 ? (
        <Text variant="microcopy">No conversations yet. Inbound messages appear here as soon as someone replies on any channel.</Text>
      ) : (
        <Flex direction="column" gap="extra-small">
          {convos.map((c) => (
            <Flex key={c.phone} direction="column" gap="extra-small">
              <Flex justify="between" align="center">
                <Flex direction="column">
                  <Button variant="transparent" onClick={() => openConvo(c)}>
                    {(c.name || c.phone)}{c.unread > 0 ? `  (${c.unread} new)` : ''}
                  </Button>
                  <Text variant="microcopy" format={{ fontWeight: c.unread > 0 ? 'bold' : 'regular' }}>
                    {c.lastText ? (c.lastText.length > 46 ? c.lastText.slice(0, 46) + '…' : c.lastText) : '(no text)'}
                  </Text>
                </Flex>
                <Flex direction="column" align="end">
                  <Text variant="microcopy">{CH_LABEL[c.lastChannel] || c.lastChannel}</Text>
                  <Text variant="microcopy">{fmtTime(c.lastTs)}</Text>
                </Flex>
              </Flex>
              <Divider />
            </Flex>
          ))}
        </Flex>
      )}
    </Flex>
  );
};
