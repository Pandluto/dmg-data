import { useState } from 'react';
import { getInstalledAkeCatalog } from '../../integrations/ake/akeCatalogAdapter';
import { APP_ROUTE_PATHS, navigateToAppPath } from '../../utils/appRoute';
import './WorkspaceLibrary.css';

export function DataWorkspacePage() {
  const catalog = getInstalledAkeCatalog();
  const [query, setQuery] = useState('');
  const characters = catalog?.characters.filter(character => `${character.name} ${character.id}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  return <div className="web-dashboard-page ake-workspace-library">
    <header className="ake-library-heading"><div><p className="dashboard-kicker">AKE · 官方资料</p><h2>干员与装备目录</h2>
      <p>基础资料由当前 AKE 数据版本提供。队伍里的等级、潜能、武器与装备在配置页调整。</p></div>
      <button type="button" onClick={() => navigateToAppPath(APP_ROUTE_PATHS.operatorConfig)}>调整队伍配置</button></header>
    <section className="dashboard-stat-grid">
      <article><span>干员</span><strong>{catalog?.characters.length ?? 0}</strong></article>
      <article><span>武器</span><strong>{catalog?.weapons.length ?? 0}</strong></article>
      <article><span>装备</span><strong>{catalog?.equipment.length ?? 0}</strong></article>
      <article><span>套装</span><strong>{catalog?.suits.length ?? 0}</strong></article>
    </section>
    <p>数据版本 {catalog?.source.version || '尚未载入'} · 基础资料只读</p>
    <input type="search" aria-label="搜索官方干员" placeholder="搜索干员" value={query} onChange={event => setQuery(event.target.value)}/>
    <section className="ake-catalog-grid">{characters.map(character => <article key={character.id}><strong>{character.name}</strong><small>{character.id}</small></article>)}</section>
  </div>;
}
