import { Component, type ErrorInfo, type ReactNode } from "react";

type AppErrorBoundaryProps = {
  children: ReactNode;
};

type AppErrorBoundaryState = {
  error: Error | null;
};

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
          <button type="button" onClick={this.reload}>重新加载软件</button>
          <small>若问题重复出现，运行日志会保留故障线索用于排查。</small>
        </div>
      </main>
    );
  }
}
