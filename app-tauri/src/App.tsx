import { useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { LoginView } from "@/components/LoginView";
import { HomePage } from "@/components/HomePage";
import { LogsPage } from "@/components/LogsPage";
import { useAura } from "@/state/useAura";

function App() {
  const aura = useAura();
  const [showLogs, setShowLogs] = useState(false);

  return (
    <>
      {aura.phase === "loggedOut" ? (
        <LoginView aura={aura} onDebug={() => aura.toggleDebug()} />
      ) : (
        <HomePage
          aura={aura}
          onOpenLogs={() => setShowLogs(true)}
          onDebug={() => aura.toggleDebug()}
        />
      )}
      {showLogs && <LogsPage aura={aura} onClose={() => setShowLogs(false)} />}
      <Toaster position="top-center" />
    </>
  );
}

export default App;
