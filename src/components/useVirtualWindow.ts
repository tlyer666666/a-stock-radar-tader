import { useCallback, useEffect, useRef, useState, type RefObject, type UIEvent } from "react";

export type UseVirtualWindowOptions<T extends HTMLElement = HTMLElement> = {
  itemCount: number;
  rowHeight: number;
  overscan?: number | undefined;
  threshold?: number | undefined;
  containerRef?: RefObject<T | null> | undefined;
  resetKey?: string | number | undefined;
};

export type VirtualWindowResult = {
  enabled: boolean;
  startIndex: number;
  endIndex: number;
  topSpacerHeight: number;
  bottomSpacerHeight: number;
  totalHeight: number;
  onScroll: (event: UIEvent<HTMLElement>) => void;
};

const DEFAULT_VIEWPORT_HEIGHT = 560;

/**
 * Lightweight, dependency-free list virtualization hook.
 * Renders the full list directly when `itemCount <= threshold`, and windows rows
 * with top/bottom spacer heights once `itemCount > threshold`.
 */
export function useVirtualWindow<T extends HTMLElement = HTMLElement>({
  itemCount,
  rowHeight,
  overscan = 8,
  threshold = 80,
  containerRef,
  resetKey
}: UseVirtualWindowOptions<T>): VirtualWindowResult {
  const safeCount = Math.max(0, Math.floor(Number.isFinite(itemCount) ? itemCount : 0));
  const safeRowHeight = Math.max(1, Number.isFinite(rowHeight) && rowHeight > 0 ? rowHeight : 44);
  const safeOverscan = Math.max(0, Math.floor(Number.isFinite(overscan) ? overscan : 8));
  const safeThreshold = Math.max(0, Math.floor(Number.isFinite(threshold) ? threshold : 80));
  const enabled = safeCount > safeThreshold;

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(DEFAULT_VIEWPORT_HEIGHT);
  const [atBottom, setAtBottom] = useState(false);
  const prevCountRef = useRef(safeCount);
  const prevResetKeyRef = useRef(resetKey);

  useEffect(() => {
    if (prevResetKeyRef.current === resetKey) return;
    prevResetKeyRef.current = resetKey;
    const node = containerRef?.current;
    if (node) {
      node.scrollTop = 0;
    }
    setScrollTop(0);
    setAtBottom(false);
  }, [resetKey, containerRef]);

  useEffect(() => {
    if (!enabled) {
      setScrollTop(0);
      setAtBottom(false);
      return undefined;
    }
    const node = containerRef?.current;
    if (!node) return undefined;

    const measure = () => {
      const nextHeight = node.clientHeight > 0 ? node.clientHeight : DEFAULT_VIEWPORT_HEIGHT;
      setViewportHeight(prev => (prev === nextHeight ? prev : nextHeight));
      const nextTop = Math.max(0, node.scrollTop || 0);
      setScrollTop(prev => (prev === nextTop ? prev : nextTop));
      const nextBottom = node.scrollHeight > nextHeight + 2 && nextTop + nextHeight >= node.scrollHeight - 2;
      setAtBottom(prev => (prev === nextBottom ? prev : nextBottom));
    };

    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, containerRef]);

  useEffect(() => {
    const prevCount = prevCountRef.current;
    prevCountRef.current = safeCount;
    if (!enabled || prevCount === safeCount) return undefined;

    // When itemCount changes while virtualized (e.g. clicking "加载更多" at the bottom),
    // immediately clear stale atBottom so newly revealed rows are not skipped, then re-measure
    // asynchronously after the DOM updates.
    setAtBottom(false);
    const node = containerRef?.current;
    if (!node) return undefined;

    const remeasure = () => {
      const nextHeight = node.clientHeight > 0 ? node.clientHeight : DEFAULT_VIEWPORT_HEIGHT;
      setViewportHeight(prev => (prev === nextHeight ? prev : nextHeight));
      const nextTop = Math.max(0, node.scrollTop || 0);
      setScrollTop(prev => (prev === nextTop ? prev : nextTop));
      const nextBottom = node.scrollHeight > nextHeight + 2 && nextTop + nextHeight >= node.scrollHeight - 2;
      setAtBottom(prev => (prev === nextBottom ? prev : nextBottom));
    };

    if (typeof requestAnimationFrame === "function") {
      const rafId = requestAnimationFrame(remeasure);
      return () => {
        if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(rafId);
      };
    }

    const nextHeight = node.clientHeight > 0 ? node.clientHeight : DEFAULT_VIEWPORT_HEIGHT;
    setViewportHeight(prev => (prev === nextHeight ? prev : nextHeight));
    const nextTop = Math.max(0, node.scrollTop || 0);
    setScrollTop(prev => (prev === nextTop ? prev : nextTop));
    return undefined;
  }, [enabled, safeCount, containerRef]);

  const onScroll = useCallback((event: UIEvent<HTMLElement>) => {
    const target = event.currentTarget;
    const nextTop = Math.max(0, target.scrollTop || 0);
    const nextHeight = target.clientHeight > 0 ? target.clientHeight : DEFAULT_VIEWPORT_HEIGHT;
    const nextBottom = target.scrollHeight > nextHeight + 2 && nextTop + nextHeight >= target.scrollHeight - 2;
    setScrollTop(prev => (prev === nextTop ? prev : nextTop));
    setViewportHeight(prev => (prev === nextHeight ? prev : nextHeight));
    setAtBottom(prev => (prev === nextBottom ? prev : nextBottom));
  }, []);

  const totalHeight = safeCount * safeRowHeight;
  if (!enabled) {
    return {
      enabled: false,
      startIndex: 0,
      endIndex: safeCount,
      topSpacerHeight: 0,
      bottomSpacerHeight: 0,
      totalHeight,
      onScroll
    };
  }

  const countChanged = prevCountRef.current !== safeCount;
  const resetChanged = prevResetKeyRef.current !== resetKey;
  const maxScrollTop = Math.max(0, totalHeight - viewportHeight);
  const effectiveScrollTop = resetChanged ? 0 : Math.min(scrollTop, maxScrollTop);
  const effectiveAtBottom = countChanged || resetChanged ? false : atBottom;
  const visibleRows = Math.max(1, Math.ceil(viewportHeight / safeRowHeight));
  const rawStart = effectiveAtBottom
    ? safeCount - visibleRows - safeOverscan
    : Math.floor(effectiveScrollTop / safeRowHeight) - safeOverscan;
  const startIndex = Math.max(0, Math.min(safeCount, rawStart));
  const rawEnd = effectiveAtBottom
    ? safeCount
    : Math.floor(effectiveScrollTop / safeRowHeight) + visibleRows + safeOverscan;
  const endIndex = Math.max(startIndex, Math.min(safeCount, rawEnd));

  return {
    enabled: true,
    startIndex,
    endIndex,
    topSpacerHeight: startIndex * safeRowHeight,
    bottomSpacerHeight: Math.max(0, (safeCount - endIndex) * safeRowHeight),
    totalHeight,
    onScroll
  };
}

export default useVirtualWindow;
