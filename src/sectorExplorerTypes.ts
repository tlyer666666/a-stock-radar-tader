export type SectorExplorerStatus = 'ready' | 'partial' | 'unavailable' | 'stale';
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
export type SectorExplorerCoverage = {
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
};
export type SectorExplorerSource = {
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
export type SectorExplorerEvidence = {
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
    sources: SectorExplorerSource[];
    warnings: string[];
    evidence: SectorExplorerEvidence[];
    relatedTerms: string[];
};
export type SectorExplorerRequest = {
    requestId?: string;
    forceRefresh?: boolean;
};
export type SectorExplorerApi = {
    getSectorCatalog: (options?: SectorExplorerRequest) => Promise<SectorExplorerCatalog>;
    getSectorClassifications: (options: SectorExplorerRequest & {
        code: string;
    }) => Promise<SectorExplorerCatalog>;
    getSectorDetail: (options: SectorExplorerRequest & {
        id: string;
    }) => Promise<SectorExplorerDetail>;
    cancelSectorRequest: (requestId: string) => Promise<{
        cancelled: boolean;
    }>;
};
