import { PanelLeftClose, PanelLeftOpen, Settings as SettingsIcon, type LucideIcon } from 'lucide-react';

type Item = { id: string; label: string; icon: LucideIcon };
const groups = [
  { label: '选股研究', ids: ['trend-screener', 'signals', 'sectors'] },
  { label: '行情跟踪', ids: ['dashboard', 'watchlist', 'favorites', 'holdings'] },
  { label: '复盘与信息', ids: ['review', 'compare', 'backtest', 'news'] }
];

export default function WorkspaceNavigation({ items, active, counts, collapsed, onCollapse, onNavigate }: {
  items: Item[]; active: string; counts: Record<string, number>; collapsed: boolean;
  onCollapse: () => void; onNavigate: (id: string) => void;
}) {
  const selected = active === 'announcements' ? 'news' : active;
  return <aside className="sidebar workspace-navigation" aria-label="工作台导航">
    <div className="workspace-nav-top"><span>工作台</span><button className="sidebar-collapse" aria-label={collapsed ? '展开导航栏' : '收起导航栏'} aria-expanded={!collapsed} title={collapsed ? '展开导航栏' : '收起导航栏'} onClick={onCollapse}>{collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}</button></div>
    <nav aria-label="功能模块">{groups.map(group => <section className="workspace-nav-group" key={group.label} aria-label={group.label}>
      <p className="nav-caption">{group.label}</p>
      {group.ids.map(id => items.find(item => item.id === id)).filter((item): item is Item => Boolean(item)).map(item => <button key={item.id}
        className={`nav-item ${selected === item.id ? 'active' : ''}`} onClick={() => onNavigate(item.id)} title={item.label} aria-label={item.label}
        aria-current={selected === item.id ? 'page' : undefined}
        data-professional-review-nav={item.id === 'review' ? true : undefined}
        data-information-center-nav={item.id === 'news' ? true : undefined}
        data-backtest-nav={item.id === 'backtest' ? true : undefined}>
        <item.icon size={18} /><span>{item.label}</span>{(counts[item.id] || 0) > 0 && <em>{counts[item.id]}</em>}
      </button>)}
    </section>)}</nav>
    <div className="workspace-nav-bottom"><button className={`nav-item ${active === 'settings' ? 'active' : ''}`} title="数据源设置" aria-label="数据源设置" aria-current={active === 'settings' ? 'page' : undefined} onClick={() => onNavigate('settings')}><SettingsIcon size={18} /><span>数据源设置</span></button></div>
  </aside>;
}
