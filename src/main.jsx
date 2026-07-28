import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import DecisioningEngine from "./DecisioningEngine.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <DecisioningEngine />
  </StrictMode>
);
