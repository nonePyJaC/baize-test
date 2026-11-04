import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initAiSessionRuntime } from "./lib/aiSessionRuntime";
import "./styles/global.css";
import "./styles/ai-session.css";

initAiSessionRuntime();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
