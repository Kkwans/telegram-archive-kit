import { Component, type ReactNode } from "react";
import { call } from "./rpc";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    call("clientLog", { text: `render error: ${error.message}\n${info.componentStack ?? ""}` }).catch(() => undefined);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="fatal">
        <div className="fatal-card">
          <h1>界面遇到问题</h1>
          <p>操作没有丢失。可以重新加载界面，或查看诊断页的日志。</p>
          <pre>{this.state.error.message}</pre>
          <button className="btn primary" onClick={() => window.location.reload()}>
            重新加载界面
          </button>
        </div>
      </div>
    );
  }
}
