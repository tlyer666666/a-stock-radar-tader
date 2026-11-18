export type PaletteEntry =
  | {
      id: string;
      kind: "view";
      title: string;
      subtitle: string;
      keywords: string;
      badge?: string;
      viewId: string;
    }
  | {
      id: string;
      kind: "command";
      title: string;
      subtitle: string;
      keywords: string;
      badge?: string;
      commandId: string;
    }
  | {
      id: string;
      kind: "stock";
      title: string;
      subtitle: string;
      keywords: string;
      badge?: string;
      security: Security;
    };

export type PaletteActionItem = {
  id: string;
  label: string;
  group: string;
  keywords?: string;
};

export function buildPaletteEntries(input: {
  query: string;
  views: PaletteActionItem[];
  commands: PaletteActionItem[];
  holdings: HoldingItem[];
  favorites: WatchItem[];
  watchlist: WatchItem[];
  remoteStocks?: Security[];
}): PaletteEntry[] {
  const q = String(input.query || "").trim().toLowerCase();
  const entries: PaletteEntry[] = [];
  const seenCodes = new Set<string>();

  const pushStock = (sec: Security, role: string, badge?: string) => {
    if (!sec?.code || seenCodes.has(sec.code)) return;
    seenCodes.add(sec.code);
    const title = `${sec.name || sec.code} (${sec.code})`;
    entries.push({
      id: `stock-${sec.code}`,
      kind: "stock",
      title,
      subtitle: role,
      keywords: `${sec.code} ${sec.name || ""} ${role}`.toLowerCase(),
      ...(badge ? { badge } : {}),
      security: sec
    });
  };

  // Prioritize holdings -> favorites -> watchlist -> remote search hits -> views -> commands.
  for (const h of input.holdings) {
    pushStock(h, `持仓 · 成本 ${h.costPrice.toFixed(2)}`, "持仓");
  }
  for (const f of input.favorites) {
    pushStock(f, "自选股", "自选");
  }
  for (const w of input.watchlist) {
    pushStock(w, `观察池${w.observationNode ? ` · ${w.observationNode}` : ""}`, "观察");
  }
  for (const r of input.remoteStocks || []) {
    pushStock(r, r.marketName || "全市场搜索", "个股");
  }

  for (const view of input.views) {
    entries.push({
      id: `view-${view.id}`,
      kind: "view",
      title: view.label,
      subtitle: `${view.group} · 切换工作区`,
      keywords: `${view.id} ${view.label} ${view.group} ${view.keywords || ""}`.toLowerCase(),
      viewId: view.id
    });
  }

  for (const cmd of input.commands) {
    entries.push({
      id: `cmd-${cmd.id}`,
      kind: "command",
      title: cmd.label,
      subtitle: cmd.group,
      keywords: `${cmd.id} ${cmd.label} ${cmd.group} ${cmd.keywords || ""}`.toLowerCase(),
      badge: "快捷",
      commandId: cmd.id
    });
  }

  if (!q) {
    // Empty query highlights stocks first (up to 6) + top workspaces & commands.
    const stocks = entries.filter(e => e.kind === "stock").slice(0, 6);
    const others = entries.filter(e => e.kind !== "stock");
    return [...stocks, ...others].slice(0, 24);
  }

  const scored = entries
    .map(entry => {
      const titleLower = entry.title.toLowerCase();
      let score = 0;
      if (entry.kind === "stock" && entry.security.code === q) score = 100;
      else if (titleLower.startsWith(q)) score = 80;
      else if (titleLower.includes(q)) score = 60;
      else if (entry.keywords.includes(q)) score = 40;
      return score > 0 ? { entry, score } : null;
    })
    .filter((item): item is { entry: PaletteEntry; score: number } => Boolean(item))
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, 20).map(item => item.entry);
}
