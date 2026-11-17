'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

interface ListInfo {
  id: string; name: string; statuses: number; tasks: number;
  fields: { pillar: boolean; roadmapMonth: boolean; roadmapStart: boolean; roadmapEnd: boolean; sprint: boolean; bigSwing: boolean };
}
interface ConfigStatus {
  success: boolean; message: string; mock: boolean; hasToken: boolean; source: string;
  hasApproverPassword: boolean; timezone: string; requestTag: string;
  lists?: ListInfo[]; defaultListId?: string; requestListId?: string;
}

const FIELD_LABELS: [keyof ListInfo['fields'], string][] = [
  ['roadmapStart', 'Roadmap Start Date'],
  ['roadmapEnd', 'Roadmap End Date'],
  ['roadmapMonth', 'Target Month'],
  ['pillar', 'Pillar'],
  ['sprint', 'Sprint'],
  ['bigSwing', 'Big Swing'],
];

export default function ConfigPage() {
  const [config, setConfig] = useState<ConfigStatus | null>(null);
  const [testing, setTesting] = useState(true);

  const fetchConfig = async () => {
    setTesting(true);
    try {
      setConfig(await (await fetch('/api/config')).json());
    } catch (err: any) {
      setConfig({ success: false, message: err.message, mock: false, hasToken: false, source: '', hasApproverPassword: false, timezone: '', requestTag: '' });
    } finally {
      setTesting(false);
    }
  };
  useEffect(() => { fetchConfig(); }, []);

  const row = (k: string, v: React.ReactNode) => (
    <div className="config-row"><span className="config-key">{k}</span><span className="config-val">{v}</span></div>
  );
  const dot = (ok: boolean) => <span className={`status-dot ${ok ? 'green' : 'red'}`} />;

  return (
    <div className="config-page" style={{ maxWidth: 820 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 4 }}>
        <Link href="/" className="btn btn-ghost btn-sm">← Back</Link>
        <h1>Configuration</h1>
      </div>
      <p className="subtitle">ClickUp connection and environment settings</p>

      <div className="config-section">
        <h2>Connection</h2>
        {testing && !config ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
            <span style={{ fontSize: 13, color: '#6b7280' }}>Testing connection…</span>
          </div>
        ) : config && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              {dot(config.success)}
              <span style={{ fontSize: 14, fontWeight: 600 }}>{config.message}</span>
              <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={fetchConfig} disabled={testing}>{testing ? 'Testing…' : 'Re-test'}</button>
            </div>
            {row('Mode', config.mock ? 'MOCK DATA (CLICKUP_MOCK=1)' : 'Live ClickUp')}
            {row('CLICKUP_API_TOKEN', <>{dot(config.hasToken || config.mock)}{config.hasToken ? 'Set' : 'Missing'}</>)}
            {row('Roadmap source', config.source)}
            {row('APPROVER_PASSWORD', <>{dot(config.hasApproverPassword)}{config.hasApproverPassword ? 'Set' : 'Missing'}</>)}
            {row('Timezone for dates', config.timezone)}
            {row('Request tag', config.requestTag)}
          </>
        )}
      </div>

      {config?.lists && (
        <div className="config-section">
          <h2>Lists on the roadmap</h2>
          <div className="scroll-x">
            <table className="list-table" style={{ border: 'none' }}>
              <thead>
                <tr><th>List</th><th>Tasks</th>{FIELD_LABELS.map(([, l]) => <th key={l}>{l}</th>)}</tr>
              </thead>
              <tbody>
                {config.lists.map(l => (
                  <tr key={l.id}>
                    <td>
                      {l.name}
                      {l.id === config.defaultListId && <span className="src-tag">new tasks</span>}
                      {l.id === config.requestListId && <span className="src-tag">requests</span>}
                    </td>
                    <td>{l.tasks}</td>
                    {FIELD_LABELS.map(([k]) => <td key={k} style={{ textAlign: 'center' }}>{l.fields[k] ? '✓' : <span style={{ color: '#d1d5db' }}>—</span>}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="field-hint" style={{ marginTop: 12 }}>
            Fields are matched by name on each list. On the calendar, a task’s own start/due dates win; Roadmap Start/End Date are used only when the task has no dates; Target Month places undated tasks at the month level.
          </p>
        </div>
      )}

      <div className="config-section">
        <h2>Environment variables</h2>
        <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.7 }}>
          <p><code>CLICKUP_API_TOKEN</code> — personal API token (ClickUp → Settings → Apps). Required.</p>
          <p><code>CLICKUP_FOLDER_ID</code> — every list in this folder is on the roadmap. Or set <code>CLICKUP_LIST_IDS</code> (comma-separated) instead.</p>
          <p><code>CLICKUP_DEFAULT_LIST_ID</code> — where “+ Add” creates tasks (defaults to the first list).</p>
          <p><code>CLICKUP_REQUEST_LIST_ID</code> — where submitted requests are created (defaults to the default list).</p>
          <p><code>CLICKUP_TEAM_ID</code> — workspace ID, for links to lists (optional).</p>
          <p><code>APPROVER_PASSWORD</code> — required to review requests.</p>
          <p><code>ROADMAP_TIMEZONE</code> — defaults to America/New_York.</p>
          <p>Field-name overrides (optional): <code>CLICKUP_FIELD_ROADMAP_START</code>, <code>CLICKUP_FIELD_ROADMAP_END</code>, <code>CLICKUP_FIELD_ROADMAP_MONTH</code>, <code>CLICKUP_FIELD_PILLAR</code>, <code>CLICKUP_FIELD_SPRINT</code>, <code>CLICKUP_FIELD_BIG_SWING</code>.</p>
          <p><code>CLICKUP_MOCK=1</code> — run with built-in sample data, no ClickUp needed (local development only).</p>
        </div>
      </div>
    </div>
  );
}
