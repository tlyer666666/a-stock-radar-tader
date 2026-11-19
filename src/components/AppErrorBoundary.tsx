import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";

type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  error: Error | null;
};

type WorkspaceErrorBoundaryProps = {
  children: ReactNode;
  label?: string;
  onReturnHome?: () => void;
  compact?: boolean;
};

type WorkspaceErrorBoundaryState = {
  error: Error | null;
  attempt: number;
};

export class WorkspaceErrorBoundary extends Component<
  WorkspaceErrorBoundaryProps,
  WorkspaceErrorBoundaryState
> {
  state: WorkspaceErrorBoundaryState = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<WorkspaceErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`工作区模块异常 (${this.props.label || "未知模块"})`, error, info.componentStack);
  }

  private retry = () => {
    this.setState(prev => ({ error: null, attempt: prev.attempt + 1 }));
  };

  private returnHome = () => {
    this.setState(prev => ({ error: null, attempt: prev.attempt + 1 }));
    this.props.onReturnHome?.();
  };

  render() {
    if (!this.state.error) {
      return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
    }
    if (this.props.compact) {
      const compactLabel = this.props.label || "子面板";
      return (
        <div className="workspace-compact-error" role="alert">
          <span>{compactLabel}加载遇到异常，已自动隔离。</span>
          <button type="button" className="secondary-btn" onClick={this.retry}>重试</button>
        </div>
      );
    }

    const moduleName = this.props.label || "当前模块";
    return (
      <section className="app-crash-fallback workspace-error-fallback" role="alert" aria-live="assertive">
        <div className="app-crash-card">
          <span className="app-crash-badge">模块异常保护</span>
          <h2>{moduleName}渲染失败</h2>
          <p>
            当前模块发生未捕获异常，已隔离以保护自选、持仓和其余工作区正常运行。
          </p>
          <div className="workspace-error-actions">
            <button type="button" onClick={this.retry}>重试当前模块</button>
            {this.props.onReturnHome && (
              <button type="button" className="secondary" onClick={this.returnHome}>返回工作台</button>
            )}
          </div>
          <small>已记录模块诊断信息，重试或切回工作台即可继续使用。</small>
        </div>
      </section>
    );
  }
}

export default class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("A股雷达界面发生未捕获异常", error, info.componentStack);
  }

  private reload = () => {
    window.location.reload();
  };

  private resetUiLayoutAndReload = () => {
    try {
      for (const key of [
        "a-stock-radar:default-view",
        "a-stock-radar:sidebar-core-only:v1",
        "astock:display-density:v1",
        "a-stock-radar:display-density:v1",
        "a-stock-radar:ui-scale:v1",
        "a-stock-radar:color-vision:v1"
      ]) {
        window.localStorage?.removeItem(key);
      }
      if (typeof document !== "undefined") {
        document.documentElement.style.zoom = "";
        delete document.documentElement.dataset.colorVision;
      }
    } catch {
      // ignore storage errors during crash recovery
    }
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <main className="app-crash-fallback" role="alert" aria-live="assertive">
        <div className="app-crash-card">
          <span className="app-crash-badge">界面保护已启动</span>
          <h1>A股雷达需要重新加载</h1>
          <p>
            某个页面组件出现异常，保护机制已阻止它影响自选、持仓和设置数据。
            重新加载后可以继续使用。
          </p>
          <div className="workspace-error-actions">
            <button type="button" onClick={this.reload}>重新加载软件</button>
            <button type="button" className="secondary" onClick={this.resetUiLayoutAndReload}>重置视图布局并重载（保留全部业务数据）</button>
          </div>
          <small>若问题重复出现，运行日志会保留故障线索用于排查。</small>
        </div>
      </main>
    );
  }
}
