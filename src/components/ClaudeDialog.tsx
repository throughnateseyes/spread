import { useCallback, useEffect, useState } from 'react';
import { native, type ClaudeStatus } from '../platform';
import { useStore } from '../store';
import { Button, IconButton, Modal } from '../ui/controls';
import { ICON_DENSE, IconCheckCircle, IconCopy } from '../ui/icons';
import './io.css';

// Connect Claude: install Spread in the Claude desktop app (an extension) and/or Claude Code (every
// folder), then show a few prompts to start with. Status is polled while the dialog is open, so the
// footer flips to "Claude Code used Spread just now" the moment Claude calls a tool.

const EXAMPLES = [
  'Make me a one-page resume in Spread from ~/Documents/resume.pdf. Three directions, then pick one with me.',
  'Use Spread to design an 18×24 poster for our open house on Saturday.',
  'Give me three carousel directions in Spread from the photos in ~/Desktop/shoot.',
];

const CLIENTS: Record<string, string> = { 'claude-code': 'Claude Code', 'claude-ai': 'The Claude app' };

function ago(at: number) {
  const s = Math.round((Date.now() - at) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

/** Polls the connection status while mounted. Null outside the desktop app. */
export function useClaudeStatus(everyMs: number) {
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const refresh = useCallback(async () => {
    if (native) setStatus(await native.claudeStatus());
  }, []);
  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, everyMs);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', refresh);
    };
  }, [refresh, everyMs]);
  return { status, refresh };
}

export default function ClaudeDialog() {
  const toast = useStore((s) => s.toast);
  const close = () => useStore.getState().set({ modal: null });
  const { status, refresh } = useClaudeStatus(2000);
  const [busy, setBusy] = useState<'desktop' | 'code' | null>(null);
  const [opened, setOpened] = useState(false);

  const connect = async (target: 'desktop' | 'code') => {
    if (!native) return;
    setBusy(target);
    const r = await native.claudeConnect(target);
    setBusy(null);
    if (!r.ok) toast(r.error ?? 'Couldn’t connect', 'error');
    else if (target === 'desktop') setOpened(true);
    else toast('Claude Code can use Spread in every folder now', 'success');
    void refresh();
  };

  const disconnect = async () => {
    if (!native) return;
    const r = await native.claudeDisconnectCode();
    if (!r.ok) toast(r.error ?? 'Couldn’t remove it', 'error');
    void refresh();
  };

  const copy = (t: string) => {
    void navigator.clipboard.writeText(t);
    toast('Copied. Paste it into Claude.', 'success');
  };

  const last = status?.lastClient;
  return (
    <Modal
      title="Connect Claude"
      onClose={close}
      width={500}
      footer={
        <>
          <span className="muted" aria-live="polite">
            {last ? `${CLIENTS[last.name] ?? 'Claude'} used Spread ${ago(last.at)}` : 'Waiting for Claude to use Spread…'}
          </span>
          <Button primary onClick={close}>
            Done
          </Button>
        </>
      }
    >
      <p className="claude-lede">Claude designs on your canvas while you watch. You pick a direction, refine it by hand, and make the final call.</p>

      <div className="claude-card">
        <div className="claude-card-text">
          <b>Claude desktop app</b>
          <span className="hint">
            {opened && !status?.desktop.installed
              ? 'Claude opened an install window. Click Install there, then start a new chat.'
              : 'Chat with Claude as usual and ask it to use Spread. Installs as an extension.'}
          </span>
        </div>
        {status?.desktop.installed ? (
          <Connected />
        ) : status && !status.desktop.app ? (
          <a className="link-btn" href="https://claude.ai/download" target="_blank" rel="noreferrer">
            Get the app
          </a>
        ) : (
          <Button primary={!status?.code.installed} onClick={() => connect('desktop')} disabled={busy !== null}>
            {busy === 'desktop' ? 'Preparing…' : opened ? 'Open again' : 'Install'}
          </Button>
        )}
      </div>

      <div className="claude-card">
        <div className="claude-card-text">
          <b>Claude Code</b>
          <span className="hint">For the terminal and the Code tab. Works in every folder, not just this project.</span>
        </div>
        {status?.code.installed ? (
          <div className="claude-card-end">
            <Connected />
            <button className="link-btn" onClick={disconnect}>
              Remove
            </button>
          </div>
        ) : status && !status.code.cli ? (
          <a className="link-btn" href="https://docs.claude.com/en/docs/claude-code/setup" target="_blank" rel="noreferrer">
            Install Claude Code
          </a>
        ) : (
          <Button onClick={() => connect('code')} disabled={busy !== null}>
            {busy === 'code' ? 'Setting up…' : 'Set up'}
          </Button>
        )}
      </div>

      <div className="io-field">
        <div className="io-label">Then try</div>
        <ul className="claude-examples">
          {EXAMPLES.map((t) => (
            <li key={t}>
              <span>{t}</span>
              <IconButton title="Copy" className="small" onClick={() => copy(t)}>
                <IconCopy size={ICON_DENSE} />
              </IconButton>
            </li>
          ))}
        </ul>
        <div className="hint">Already have a design? Select a layer or a row, then tell Claude what to change: “tighten this”, “push row B further”.</div>
      </div>
    </Modal>
  );
}

function Connected() {
  return (
    <span className="claude-ok">
      <IconCheckCircle size={ICON_DENSE} weight="fill" /> Connected
    </span>
  );
}
