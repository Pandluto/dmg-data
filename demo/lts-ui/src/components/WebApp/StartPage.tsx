import { useEffect, useRef, useState } from 'react';
import { useTimelineSession } from '../../agentKernel/timelineRepository/useTimelineSession';
import { createAkeWorkspace, exportAkeWorkspace, importAkeWorkspace, listAkeWorkspaces, openAkeWorkspace, saveAkeWorkspace } from '../../integrations/ake/akeWorkspace';
import { APP_ROUTE_PATHS, navigateToAppPath } from '../../utils/appRoute';
import './WorkspaceLibrary.css';

export function StartPage() {
  const [workspaces, setWorkspaces] = useState<Awaited<ReturnType<typeof listAkeWorkspaces>>>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const session = useTimelineSession();
  const refresh = () => listAkeWorkspaces().then(setWorkspaces);
  useEffect(() => { void refresh().catch(error => setNotice(String(error))); }, []);
  const run = async (operation: () => Promise<unknown>, switchWorkspace = false) => {
    if (busy) return;
    setBusy(true); setNotice('');
    try {
      await operation();
      if (switchWorkspace) {
        navigateToAppPath(APP_ROUTE_PATHS.timelineWorkspace); window.location.reload();
      } else { await refresh(); setNotice('操作已完成'); }
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const download = async (id: string, label: string) => {
    const bundle = await exportAkeWorkspace(id);
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url;
    link.download = `${label.replace(/[\\/:*?"<>|]/g, '_')}.ake.json`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };
  return <div className="web-dashboard-page ake-workspace-library">
    <header className="ake-library-heading">
      <div><p className="dashboard-kicker">AKE · 本地存档</p><h2>你的队伍与排轴</h2>
        <p>保存队伍、装备与技能时序，每次保存生成可恢复的版本。打开其他存档前会先保存当前改动。</p></div>
      <button type="button" disabled={busy} onClick={() => navigateToAppPath(APP_ROUTE_PATHS.timelineWorkspace)}>返回工作区</button>
    </header>
    <section className="ake-library-create" aria-label="新建存档">
      <form onSubmit={event => { event.preventDefault(); void run(() => createAkeWorkspace(name), true); }}>
        <label htmlFor="ake-workspace-name">新存档名称</label>
        <input id="ake-workspace-name" value={name} onChange={event => setName(event.target.value)} placeholder="例如：洛茜双连击" maxLength={80} disabled={busy}/>
        <button className="dashboard-primary-button" disabled={busy || !name.trim()} type="submit">新建空存档</button>
      </form>
      <button disabled={busy} type="button" onClick={() => void run(() => saveAkeWorkspace())}>保存当前存档</button>
      <button disabled={busy} type="button" onClick={() => fileInput.current?.click()}>导入存档文件</button>
      <input ref={fileInput} hidden type="file" accept=".json,application/json" onChange={event => {
        const file = event.target.files?.[0]; event.target.value = '';
        if (file) void run(async () => importAkeWorkspace(await file.text()), true);
      }}/>
    </section>
    <p role="status" aria-live="polite">{busy ? '正在保存并整理存档…' : notice}</p>
    <section className="ake-library-list" aria-label="已保存的存档">
      {workspaces.map(workspace => <article key={workspace.document.id}>
        <div className="ake-library-copy"><h3>{workspace.document.label}
          {workspace.document.id === session.activeTimelineId && <span className="ake-library-current">当前</span>}</h3>
          <p>{workspace.summary.characterCount} 位干员 · {workspace.summary.buttonCount} 个排轴输入 · {workspace.nodeCount} 次保存</p>
          <small>{new Date(workspace.document.updatedAt).toLocaleString('zh-CN')}{workspace.invalid ? ' · 存档待修复' : ''}</small>
        </div>
        <div className="ake-library-row-actions">
          <button disabled={busy || !!workspace.invalid} type="button" onClick={() => void run(() => openAkeWorkspace(workspace.document.id), true)}>打开存档</button>
          <button disabled={busy || !!workspace.invalid} type="button" onClick={() => void run(() => download(workspace.document.id, workspace.document.label))}>导出文件</button>
        </div>
      </article>)}
      {workspaces.length === 0 && <p>还没有存档。为第一条排轴起个名字，然后选择队伍。</p>}
    </section>
    <p className="ake-library-footnote">存档保存在当前浏览器。导出文件包含完整版本树，可用于备份或导入另一台电脑。</p>
  </div>;
}
