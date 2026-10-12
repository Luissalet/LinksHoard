import { useEffect } from "react";
import { COPILOT_REFRESH } from "./hoard-copilot.js";

export function useCopilotRefresh(load) {
  useEffect(() => {
    const refresh = () => { Promise.resolve(load()).catch(() => {}); };
    window.addEventListener(COPILOT_REFRESH, refresh);
    return () => window.removeEventListener(COPILOT_REFRESH, refresh);
  }, [load]);
}
