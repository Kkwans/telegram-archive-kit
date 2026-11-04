import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { call } from "./rpc";
import "./styles.css";

window.addEventListener("error", (e) => {
  call("clientLog", { text: `window error: ${e.message} @ ${e.filename}:${e.lineno}` }).catch(() => undefined);
});
window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason instanceof Error ? e.reason.message : String(e.reason);
  call("clientLog", { text: `unhandled rejection: ${reason}` }).catch(() => undefined);
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
