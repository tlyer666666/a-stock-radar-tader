import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

type HsgtOverlayContextValue = {
  overlayCount: number;
  acquireOverlay: () => () => void;
};

const DEFAULT_CONTEXT: HsgtOverlayContextValue = {
  overlayCount: 0,
  acquireOverlay: () => () => {}
};

const HsgtOverlayContext = createContext<HsgtOverlayContextValue>(DEFAULT_CONTEXT);

function readHsgtOverlayContext(): HsgtOverlayContextValue {
  try {
    return useContext(HsgtOverlayContext);
  } catch {
    // Fallback for lightweight hook test harnesses that do not stub React.useContext.
    return DEFAULT_CONTEXT;
  }
}

export function HsgtOverlayProvider({ children }: { children: ReactNode }) {
  const [overlayCount, setOverlayCount] = useState(0);
  const acquireOverlay = useCallback(() => {
    setOverlayCount(count => count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      setOverlayCount(count => Math.max(0, count - 1));
    };
  }, []);
  return (
    <HsgtOverlayContext.Provider value={{ overlayCount, acquireOverlay }}>
      {children}
    </HsgtOverlayContext.Provider>
  );
}

export function useHsgtOverlayCount(): number {
  return readHsgtOverlayContext().overlayCount;
}

export function useReportHsgtOverlay(active: boolean): void {
  const { acquireOverlay } = readHsgtOverlayContext();
  useEffect(() => {
    if (!active) return undefined;
    return acquireOverlay();
  }, [active, acquireOverlay]);
}
