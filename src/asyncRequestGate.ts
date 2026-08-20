export type AsyncRequestGate = {
  begin: () => number | null;
  invalidate: () => void;
  isCurrent: (requestId: number) => boolean;
  finish: (requestId: number) => boolean;
};

export const createAsyncRequestGate = (): AsyncRequestGate => {
  let generation = 0;
  let busy = false;
  return {
    begin() {
      if (busy) return null;
      busy = true;
      generation += 1;
      return generation;
    },
    invalidate() {
      generation += 1;
      busy = false;
    },
    isCurrent(requestId) {
      return busy && requestId === generation;
    },
    finish(requestId) {
      if (requestId !== generation) return false;
      busy = false;
      return true;
    }
  };
};
