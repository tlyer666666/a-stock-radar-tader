export type AnalysisPayload = {
  security: Security;
  quote: Record<string, any>;
  history: Array<Record<string, number | string>>;
  analysis: Record<string, any>;
  sector: Record<string, any> | null;
  dataFederation?: Record<string, any>;
  announcements: Array<Record<string, any>>;
  actualProvider: string;
  warning?: string;
  updatedAt: string;
};
