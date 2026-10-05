import { useEffect, useState } from 'react'
import { getNotifySettings, saveNotifySettings, testNotify, type AlertNotify, type NotifySettings } from '../api/client'
import { toast } from '../data'
import { Modal } from './Modal'

/** Where alerts can be delivered besides the app: webhook, Telegram, email. */
export default function NotifySettingsDialog({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<NotifySettings>({ webhook_url: '', telegram_bot_token: '', telegram_chat_id: '', email: '' })
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    getNotifySettings().then(setS).catch(() => {})
  }, [])

  const set = (k: keyof NotifySettings) => (e: React.ChangeEvent<HTMLInputElement>) => setS({ ...s, [k]: e.target.value })

  const save = async () => {
    await saveNotifySettings(s)
    toast('Notification settings saved', undefined, 'success')
  }

  const test = async (channel: keyof AlertNotify) => {
    setBusy(channel)
    try {
      await saveNotifySettings(s)
      const r = await testNotify({ [channel]: true })
      const failed = r.status.includes('failed')
      toast(failed ? 'Test failed' : 'Test sent', r.status, failed ? 'error' : 'success')
    } catch (e) {
      toast('Test failed', String((e as Error).message), 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal title="Alert notifications" onClose={onClose}>
      <div className="form">
        <label><span>Default webhook URL</span><input placeholder="https://…" value={s.webhook_url} onChange={set('webhook_url')} /></label>
        <p className="muted small">
          Alerts POST JSON to the URL. If your message is valid JSON it is sent as-is, otherwise as <code>{'{"text": …}'}</code>.
          Addresses on your local network are refused unless the server allows them.
        </p>
        <label><span>Telegram bot token</span><input type="password" placeholder="123456:ABC… (from @BotFather)" value={s.telegram_bot_token} onChange={set('telegram_bot_token')} /></label>
        <label><span>Telegram chat id</span><input placeholder="your chat id (e.g. from @userinfobot)" value={s.telegram_chat_id} onChange={set('telegram_chat_id')} /></label>
        <p className="muted small">Create a bot with @BotFather, send it any message once, then paste its token and your chat id.</p>
        <label><span>Email</span><input type="email" placeholder="you@example.com" value={s.email} onChange={set('email')} /></label>
      </div>
      <div className="modal-foot">
        <button disabled={!!busy || !s.webhook_url} onClick={() => test('webhook')}>{busy === 'webhook' ? 'Sending…' : 'Test webhook'}</button>
        <button disabled={!!busy || !s.telegram_chat_id} onClick={() => test('telegram')}>{busy === 'telegram' ? 'Sending…' : 'Test Telegram'}</button>
        <button disabled={!!busy || !s.email} onClick={() => test('email')}>{busy === 'email' ? 'Sending…' : 'Test email'}</button>
        <span className="spacer" />
        <button onClick={onClose}>Close</button>
        <button className="primary" onClick={() => save().then(onClose)}>Save</button>
      </div>
    </Modal>
  )
}
