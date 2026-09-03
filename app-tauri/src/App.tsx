import { useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { LoginView } from "@/components/LoginView";
import { HomePage } from "@/components/HomePage";
import { LogsPage } from "@/components/LogsPage";
import { DebugOverlay } from "@/components/DebugOverlay";
import { useAura } from "@/state/useAura";

function App() {
  const aura = useAura();
  const [showLogs, setShowLogs] = useState(false);
  const [showDebug, setShowDebug] = useState(false);

  return (
    <>
      {aura.phase === "loggedOut" ? (
        <LoginView aura={aura} onDebug={() => setShowDebug(true)} />
      ) : (
        <HomePage
          aura={aura}
          onOpenLogs={() => setShowLogs(true)}
          onDebug={() => setShowDebug(true)}
        />
      )}
      {showLogs && <LogsPage aura={aura} onClose={() => setShowLogs(false)} />}
      {showDebug && <DebugOverlay aura={aura} onClose={() => setShowDebug(false)} />}
      <Toaster position="top-center" />
    </>
  );
}

export default App;
