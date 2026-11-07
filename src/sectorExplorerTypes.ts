type SectorExplorerStatus = 'ready' | 'partial' | 'unavailable' | 'stale';
export type SectorExplorerEntry = {
    id: string;
    code: string;
    name: string;
    kind: 'industry' | 'concept' | 'classification' | 'research';
    level: 1 | 2 | 3 | null;
    path: string[];
    classification: string;
    sourceUrl: string;
};
type SectorExplorerCoverage = {
    loaded: number;
    total?: number | null;
    failed?: number;
    levelCounts?: { 1: number; 2: number; 3: number };
    declared: number | null;
    excluded: number;
    invalid: number;
    pagesLoaded: number;
    pagesTotal: number | null;
    complete: boolean;
    scope: string;
    /** 板块页数超过同花顺匿名开放页数时给出（只能取到前若干页）。 */
    anonymousLimit?: { pages: number; approxTotal: number } | null;
};
/** 目录列表上的板块行情快照（同花顺概念页 / 行业资金流）。 */
export type SectorExplorerQuote = {
    changePct: number | null;
    /** 主力净流入（元）。 */
    netInflow: number | null;
    indexCode: string;
    leaderName: string;
    leaderChangePct: number | null;
    companyCount: number | null;
};
export type SectorExplorerQuotes = {
    status: SectorExplorerStatus;
    fetchedAt: string;
    quotes: Record<string, SectorExplorerQuote>;
    sources: SectorExplorerSource[];
    warnings: string[];
};
export type SectorExplorerTrend = {
    asOf: string;
    change5: number | null;
    change20: number | null;
    closes: { date: string; close: number }[];
};
type SectorExplorerSource = {
    name: string;
    url: string;
    status: SectorExplorerStatus;
    message: string;
};
export type SectorExplorerCatalog = {
    status: SectorExplorerStatus;
    entries: SectorExplorerEntry[];
    fetchedAt: string;
    asOf: null;
    sources: SectorExplorerSource[];
    warnings: string[];
    coverage: SectorExplorerCoverage;
};
export type SectorExplorerMember = {
    code: string;
    name: string;
    secid: string;
    latest: number | null;
    changePercent: number | null;
    amount: number | null;
    turnover: number | null;
};
type SectorExplorerEvidence = {
    title: string;
    date: string;
    url: string;
    summary: string;
};
export type SectorExplorerDetail = {
    status: SectorExplorerStatus;
    entry: SectorExplorerEntry;
    fetchedAt: string;
    asOf: string | null;
    reportDate: string | null;
    members: SectorExplorerMember[];
    coverage: SectorExplorerCoverage;
    metrics: {
        changePercent: number | null;
        amount: number | null;
        rising: number | null;
        falling: number | null;
    } | null;
    quote?: SectorExplorerQuote | null;
    trend?: SectorExplorerTrend | null;
    sources: SectorExplorerSource[];
    warnings: string[];
    evidence: SectorExplorerEvidence[];
    relatedTerms: string[];
};
type SectorExplorerRequest = {
    requestId?: string;
    forceRefresh?: boolean;
};
export type SectorExplorerApi = {
    getSectorCatalog: (options?: SectorExplorerRequest) => Promise<SectorExplorerCatalog>;
    getSectorClassifications: (options: SectorExplorerRequest & {
        code: string;
    }) => Promise<SectorExplorerCatalog>;
    getSectorQuotes?: (options?: SectorExplorerRequest) => Promise<SectorExplorerQuotes>;
    getSectorDetail: (options: SectorExplorerRequest & {
        id: string;
    }) => Promise<SectorExplorerDetail>;
    cancelSectorRequest: (requestId: string) => Promise<{
        cancelled: boolean;
    }>;
};
