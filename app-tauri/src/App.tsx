import { useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { LoginView } from "@/components/LoginView";
import { HomePage } from "@/components/HomePage";
import { SettingsPage } from "@/components/SettingsPage";
import { LogsPage } from "@/components/LogsPage";
import { ErrorDialog } from "@/components/ErrorDialog";
import { useAura } from "@/state/useAura";

type View = "home" | "settings" | "logs";

function App() {
  const aura = useAura();
  const [view, setView] = useState<View>("home");

  return (
    <>
      {aura.phase === "loggedOut" ? (
        <LoginView aura={aura} onDebug={() => aura.toggleDebug()} />
      ) : view === "settings" ? (
        <SettingsPage aura={aura} onBack={() => setView("home")} onOpenLogs={() => setView("logs")} />
      ) : view === "logs" ? (
        <LogsPage aura={aura} onClose={() => setView("settings")} />
      ) : (
        <HomePage aura={aura} onOpenSettings={() => setView("settings")} onDebug={() => aura.toggleDebug()} />
      )}
      {aura.installError && <ErrorDialog message={aura.installError} onClose={aura.dismissInstallError} />}
      <Toaster position="bottom-center" />
    </>
  );
}

export default App;
