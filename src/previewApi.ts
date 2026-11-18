import { createPreviewMarketMethods } from "./preview/mockMarketData";
import { createPreviewStrategyMethods } from "./preview/strategyPreview";
import { createPreviewAiAndWorkspaceMethods } from "./preview/aiPreview";

export function createPreviewApi(): Window["stockApi"] {
  return {
    ...createPreviewMarketMethods(),
    ...createPreviewStrategyMethods(),
    ...createPreviewAiAndWorkspaceMethods()
  };
}
