import React from "react";
import ReactDOM from "react-dom/client";
import { ConfigProvider } from "antd";
import App from "./App";
import "antd/dist/reset.css";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfigProvider
      theme={{
        token: {
          fontFamily: "'Manrope', 'Space Grotesk', sans-serif",
          colorPrimary: "#1f7a61",
          borderRadius: 16
        }
      }}
    >
      <App />
    </ConfigProvider>
  </React.StrictMode>
);
